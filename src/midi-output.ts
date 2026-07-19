/*
 * midi-output.ts — Web MIDI API output for hardware synthesizers and the
 * single 60Hz RAF drain loop that owns WASM ring-buffer access.
 *
 * Drains the Octopus engine's MIDI ring buffer in batches (up to 128 events
 * per frame) and fans each batch out to whatever consumers are attached
 * via the `onBatchDrained` callback. Today the only consumer is the OB-XD
 * synth bridge (`obxd-bridge.ts`); earlier revisions also routed to an
 * openDAW NoteSignal bridge — openDAW has since been removed.
 */

import type { OctopusWasmModule } from "./octopus-types";
import { openMidiAccess, pollForPorts } from "./midi-access";

/*
 * Handler invoked once per frame with the batch of events drained from the
 * WASM ring buffer. `events` and `timestamps` are direct typed-array views
 * into WASM linear memory (or static batch buffers in the case of events);
 * consumers MUST copy any data they need to retain past the handler return.
 */
export type BatchDrainHandler = (
    events: Uint32Array,
    timestamps: Float64Array,
    count: number,
) => void;

/*
 * Frame a MIDI message into the correct number of bytes for a raw output port.
 * Real-time messages are 1 byte; program change / channel pressure are 2 bytes;
 * everything else (note, CC, bender, etc.) is 3 bytes. Sending the wrong length
 * corrupts the stream for hardware synths.
 */
function frameMidi(status: number, d1: number, d2: number): number[] {
    if (status >= 0xf8) return [status];                 // system real-time
    const cmd = status & 0xf0;
    if (cmd === 0xc0 || cmd === 0xd0) return [status, d1]; // PGM / ch-pressure
    return [status, d1, d2];                               // channel voice
}

/*
 * Forward offset added to each event's push-time timestamp before passing
 * it to MIDIOutput.send(data, ts). This shifts all events into the future
 * so the browser's high-priority MIDI scheduler can deliver them with
 * correct relative spacing even though they were drained in a batch.
 *
 * At 60Hz RAF, the drain interval is ~16.67ms. A 20ms offset ensures
 * even the oldest event in a batch is still slightly ahead of "now",
 * preserving the sequencer's intended inter-event timing.
 *
 * Trade-off: events arrive ~20ms after generation, but with near-zero
 * jitter instead of up to ±16.67ms of batch jitter.
 */
const MIDI_FORWARD_OFFSET_MS = 20;

export class HardwareMidiOutput {
    private midiAccess: MIDIAccess | null = null;
    private outputPort: MIDIOutput | null = null;
    private enabled = false;

    async init(): Promise<boolean> {
        if (!navigator.requestMIDIAccess) {
            console.log("[octobx] Web MIDI API not available (use Chrome/Edge for hardware MIDI)");
            return false;
        }

        try {
            this.midiAccess = await openMidiAccess();
            this.populateDeviceList();
            this.midiAccess.onstatechange = () => this.populateDeviceList();
            // Ports can populate late on reload (no statechange fires) — poll.
            pollForPorts(
                () => this.populateDeviceList(),
                () => { let n = 0; this.midiAccess!.outputs.forEach(() => n++); return n > 0; },
            );
            return true;
        } catch (e) {
            console.warn("[octobx] Web MIDI access denied:", e);
            return false;
        }
    }

    /** Re-enumerate ports (manual rescan, e.g. after plugging a device in). */
    async rescan(): Promise<void> {
        if (!this.midiAccess && typeof navigator.requestMIDIAccess === "function") {
            try { this.midiAccess = await openMidiAccess(); } catch { return; }
        }
        if (this.midiAccess) {
            this.midiAccess.onstatechange = () => this.populateDeviceList();
            this.populateDeviceList();
        }
    }

    private populateDeviceList() {
        const select = document.getElementById("oct-midi-output") as HTMLSelectElement | null;
        if (!select || !this.midiAccess) return;

        const previous = select.value;
        select.innerHTML = '<option value="">None (internal synth only)</option>';

        this.midiAccess.outputs.forEach((port) => {
            const option = document.createElement("option");
            option.value = port.id;
            option.textContent = port.name;
            select.appendChild(option);
        });

        if (previous) select.value = previous;
    }

    selectOutput(portId: string) {
        if (!this.midiAccess) return;
        this.outputPort = portId ? this.midiAccess.outputs.get(portId) ?? null : null;
        this.enabled = !!this.outputPort;
        console.log(`[octobx] Hardware MIDI output: ${this.outputPort?.name ?? "none"}`);
    }

    send(status: number, data1: number, data2: number, timestamp?: number) {
        if (!this.outputPort) return;
        if (this.outputPort.state !== "connected") return;
        const bytes = frameMidi(status, data1, data2);
        if (timestamp !== undefined) {
            this.outputPort.send(bytes, timestamp);
        } else {
            this.outputPort.send(bytes);
        }
    }

    sendClock() {
        if (!this.outputPort || this.outputPort.state !== "connected") return;
        this.outputPort.send([0xf8]);
    }

    sendStart() {
        if (!this.outputPort || this.outputPort.state !== "connected") return;
        this.outputPort.send([0xfa]);
    }

    sendStop() {
        if (!this.outputPort || this.outputPort.state !== "connected") return;
        this.outputPort.send([0xfc]);
    }
}

export function drainMidiToHardware(
    module: OctopusWasmModule,
    output: HardwareMidiOutput,
    onBatchDrained?: (events: Uint32Array, timestamps: Float64Array, count: number) => void,
): () => void {
    let running = true;
    let eventsPtr = 0;
    let tsPtr = 0;
    let prevDropped = 0;
    let frameSinceCheck = 0;

    /*
     * Epoch offset: emscripten_get_now() in the sequencer worker returns
     * Date.now()-based epoch ms (~1.78T), while MIDIOutput.send() expects
     * DOMHighResTimeStamp (performance.now() epoch, ~thousands of ms).
     * Compute the offset once and subtract it from each event timestamp
     * before adding the forward offset.
     */
    const EPOCH_OFFSET = Date.now() - performance.now();

    function drain() {
        if (!running) return;

        if (!eventsPtr) eventsPtr = module._get_midi_batch_events_ptr();
        if (!tsPtr) tsPtr = module._get_midi_batch_ts_ptr();

        if (eventsPtr && tsPtr) {
            const count = module._wasm_drain_midi_batch(128);
            if (count > 0) {
                const events = new Uint32Array(module.HEAPU32.buffer, eventsPtr, count);
                const timestamps = new Float64Array(module.HEAPF64.buffer, tsPtr, count);

                for (let i = 0; i < count; i++) {
                    const packed = events[i];
                    const status = packed & 0xff;
                    const data1 = (packed >> 8) & 0xff;
                    const data2 = (packed >> 16) & 0xff;
                    const deliveryTime = timestamps[i] - EPOCH_OFFSET + MIDI_FORWARD_OFFSET_MS;
                    output.send(status, data1, data2, deliveryTime);
                }

                if (onBatchDrained) {
                    onBatchDrained(events, timestamps, count);
                }
            }
        }

        /* Overflow telemetry — check every ~60 frames (1s at 60Hz) */
        if (++frameSinceCheck >= 60) {
            frameSinceCheck = 0;
            const dropped = module._wasm_get_midi_dropped_count();
            if (dropped !== prevDropped) {
                console.warn(`[octobx] MIDI ring buffer dropped ${dropped - prevDropped} events (total: ${dropped})`);
                prevDropped = dropped;
            }
        }

        requestAnimationFrame(drain);
    }

    requestAnimationFrame(drain);
    return () => { running = false; };
}

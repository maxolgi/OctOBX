/*
 * midi-output.ts — Web MIDI API output for hardware synthesizers.
 *
 * Hardware MIDI events now only arrive as `hw_midi` messages posted by
 * the combined AudioWorklet (the engine's MIDI ring is drained inside
 * process() at audio-quantum rate). attachHwMidiForwarding() wires the
 * worklet's forwarded batches into a HardwareMidiOutput.
 */

import { openMidiAccess, pollForPorts } from "./midi-access";
import { setHwMidiHandler } from "./obxd-audio";
import { frameMidi } from "./midi-framing";

/*
 * Forward offset added to the worklet's post time before passing each
 * event to MIDIOutput.send(data, ts). The worklet forwards at
 * audio-quantum rate (~2.9ms), so a small 5ms head start keeps events
 * ahead of "now" for the browser's MIDI scheduler while preserving the
 * sequencer's inter-event timing with near-zero jitter.
 */
const HW_FORWARD_OFFSET_AWP_MS = 5;

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

/*
 * Route the AudioWorklet's hw_midi batches (packed 32-bit events) into a
 * hardware MIDI output. This is now the ONLY path hardware output is fed
 * from — the old 60Hz RAF drain loop is gone. Returns a detach function.
 */
export function attachHwMidiForwarding(output: HardwareMidiOutput): () => void {
    setHwMidiHandler((packed: number[]) => {
        const t = performance.now() + HW_FORWARD_OFFSET_AWP_MS;
        for (const ev of packed) {
            output.send(ev & 0xff, (ev >> 8) & 0xff, (ev >> 16) & 0xff, t);
        }
    });
    return () => setHwMidiHandler(null);
}

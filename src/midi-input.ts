/*
 * midi-input.ts — Web MIDI API input from hardware controllers.
 *
 * Captures incoming MIDI from a selected input port and forwards it to the
 * Octopus engine via wasm_midi_input(), which feeds the firmware's
 * byte-at-a-time interpreters (G_midi_interpret_*).
 *
 * The browser decodes running-status for us, so every MIDIMessageEvent arrives
 * with an explicit status byte. We pass (status, data1, data2) to the engine,
 * which then sets the running-status byte and feeds the data bytes — matching
 * how the original UART driver delivered bytes.
 *
 * Chrome/Edge only.
 */

import type { OctopusWasmModule } from "./octopus-types";
import { openMidiAccess, pollForPorts } from "./midi-access";

export class HardwareMidiInput {
    private midiAccess: MIDIAccess | null = null;
    private inputPort: MIDIInput | null = null;
    private enabled = false;

    constructor(private readonly module: OctopusWasmModule) {}

    async init(): Promise<boolean> {
        if (!navigator.requestMIDIAccess) {
            console.log("[octodaw] Web MIDI API not available (use Chrome/Edge for hardware MIDI input)");
            return false;
        }

        try {
            this.midiAccess = await openMidiAccess();
            this.populateDeviceList();
            this.midiAccess.onstatechange = () => this.populateDeviceList();
            // Ports can populate late on reload (no statechange fires) — poll.
            pollForPorts(
                () => this.populateDeviceList(),
                () => { let n = 0; this.midiAccess!.inputs.forEach(() => n++); return n > 0; },
            );
            return true;
        } catch (e) {
            console.warn("[octodaw] Web MIDI access denied:", e);
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
        const select = document.getElementById("oct-midi-input") as HTMLSelectElement | null;
        if (!select || !this.midiAccess) return;

        const previous = this.inputPort?.id ?? select.value;
        select.innerHTML = '<option value="">None</option>';

        this.midiAccess.inputs.forEach((port) => {
            const option = document.createElement("option");
            option.value = port.id;
            option.textContent = port.name;
            select.appendChild(option);
        });

        // Re-select if the still-attached port is still present
        if (previous && this.midiAccess.inputs.has(previous)) {
            select.value = previous;
        } else if (this.inputPort) {
            // Port went away
            this.inputPort = null;
            this.enabled = false;
        }
    }

    selectInput(portId: string) {
        // Detach previous port
        if (this.inputPort) {
            this.inputPort.onmidimessage = null;
            this.inputPort.close().catch(() => {});
            this.inputPort = null;
        }

        if (!this.midiAccess || !portId) {
            this.enabled = false;
            console.log("[octodaw] Hardware MIDI input: none");
            return;
        }

        const port = this.midiAccess.inputs.get(portId);
        if (!port) {
            this.enabled = false;
            return;
        }

        this.inputPort = port;
        this.inputPort.onmidimessage = (ev: MIDIMessageEvent) => this.handleMessage(ev);
        this.enabled = true;
        console.log(`[octodaw] Hardware MIDI input: ${port.name}`);
    }

    private handleMessage(ev: MIDIMessageEvent) {
        const data = ev.data;
        if (!data || data.length === 0) return;

        const status = data[0];

        // System real-time (0xF8..0xFF): single-byte messages.
        if (status >= 0xf8) {
            this.module._wasm_midi_input(status, 0, 0);
            return;
        }

        // System Exclusive: the firmware input path is byte-stream voice
        // message handling, not sysex. Drop it (start 0xF0 / end 0xF7).
        if (status === 0xf0 || status === 0xf7) return;

        // Active sensing / system reset noise — ignore.
        if (status === 0xfe) return;

        // Channel voice / system common: forward available data bytes.
        const d1 = data.length > 1 ? data[1] : 0;
        const d2 = data.length > 2 ? data[2] : 0;
        this.module._wasm_midi_input(status, d1, d2);
    }

    get isEnabled(): boolean {
        return this.enabled;
    }
}

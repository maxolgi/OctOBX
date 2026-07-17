/*
 * midi-output.ts — Web MIDI API output for hardware synthesizers.
 *
 * openDAW's SDK does not yet expose MIDI output to external hardware.
 * This module drains the same Octopus ring buffer and dispatches raw
 * MIDI bytes to a selected Web MIDI output port (Chrome/Edge only).
 */

import type { OctopusWasmModule } from "./octopus-types";

export class HardwareMidiOutput {
    private midiAccess: MIDIAccess | null = null;
    private outputPort: MIDIOutput | null = null;
    private enabled = false;

    async init(): Promise<boolean> {
        if (!navigator.requestMIDIAccess) {
            console.log("[octodaw] Web MIDI API not available (use Chrome/Edge for hardware MIDI)");
            return false;
        }

        try {
            this.midiAccess = await navigator.requestMIDIAccess();
            this.populateDeviceList();
            this.midiAccess.onstatechange = () => this.populateDeviceList();
            return true;
        } catch (e) {
            console.warn("[octodaw] Web MIDI access denied:", e);
            return false;
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
        console.log(`[octodaw] Hardware MIDI output: ${this.outputPort?.name ?? "none"}`);
    }

    send(status: number, data1: number, data2: number) {
        if (!this.outputPort) return;
        if (this.outputPort.state !== "connected") return;
        this.outputPort.send([status, data1, data2]);
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

export function drainMidiToHardware(module: OctopusWasmModule, output: HardwareMidiOutput): () => void {
    let running = true;

    function drain() {
        if (!running) return;
        while (module._wasm_has_midi_event()) {
            const packed = module._wasm_get_midi_event();
            const status = packed & 0xff;
            const data1 = (packed >> 8) & 0xff;
            const data2 = (packed >> 16) & 0xff;
            output.send(status, data1, data2);
        }
        requestAnimationFrame(drain);
    }

    requestAnimationFrame(drain);
    return () => { running = false; };
}

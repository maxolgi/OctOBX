/*
 * midi-bridge.ts — Drains the Octopus WASM MIDI ring buffer and forwards
 * events to openDAW instruments via NoteSignal.
 *
 * The ring buffer is polled at requestAnimationFrame frequency (~60Hz).
 * Each event is unpacked from a 32-bit packed integer.
 */

import type { OctopusWasmModule } from "./octopus-types";
import type { TrackAssignment } from "./engine-setup";
import { getProject } from "./engine-setup";

export function startMidiBridge(
    module: OctopusWasmModule,
    assignments: TrackAssignment[],
    onMidiEvent?: (status: number, d1: number, d2: number, channel: number) => void,
): () => void {
    const channelToUuid = new Map<number, Uint8Array>();

    for (const a of assignments) {
        channelToUuid.set(a.octopusTrack + 1, a.audioUnitUuid);
    }

    let running = true;
    let noteSignalModule: typeof import("@opendaw/studio-adapters") | null = null;

    async function loadNoteSignal() {
        if (!noteSignalModule) {
            noteSignalModule = await import("@opendaw/studio-adapters");
        }
        return noteSignalModule.NoteSignal;
    }

    async function drainLoop() {
        if (!running) return;

        const NoteSignal = await loadNoteSignal();
        const project = getProject();

        while (module._wasm_has_midi_event()) {
            const packed = module._wasm_get_midi_event();
            const status = packed & 0xff;
            const data1 = (packed >> 8) & 0xff;
            const data2 = (packed >> 16) & 0xff;
            const channel = (packed >> 24) & 0xff;

            if (onMidiEvent) {
                onMidiEvent(status, data1, data2, channel);
            }

            if (!project) continue;

            const cmd = status & 0xf0;

            if (cmd === 0x90 && data2 > 0) {
                const uuid = channelToUuid.get(channel);
                if (uuid) {
                    project.engine.noteSignal(NoteSignal.on(uuid, data1, data2 / 127));
                }
            } else if (cmd === 0x80 || (cmd === 0x90 && data2 === 0)) {
                const uuid = channelToUuid.get(channel);
                if (uuid) {
                    project.engine.noteSignal(NoteSignal.off(uuid, data1));
                }
            }
        }

        requestAnimationFrame(drainLoop);
    }

    drainLoop();

    return () => {
        running = false;
    };
}

/*
 * midi-bridge.ts — Forwards batched MIDI events from the Octopus ring buffer
 * to openDAW instruments via NoteSignal.
 *
 * This is no longer a self-draining loop. The single drain loop in
 * midi-output.ts (drainMidiToHardware) owns ring-buffer access and calls
 * the handler returned here on each batch, avoiding the dual-consumer race
 * where events were randomly split between hardware output and openDAW.
 */

import type { TrackAssignment } from "./engine-setup";
import { getProject } from "./engine-setup";

export type BatchDrainHandler = (
    events: Uint32Array,
    timestamps: Float64Array,
    count: number,
) => void;

export function createMidiBridgeHandler(
    assignments: TrackAssignment[],
    onMidiEvent?: (status: number, d1: number, d2: number, channel: number) => void,
): BatchDrainHandler {
    const channelToUuid = new Map<number, Uint8Array>();

    for (const a of assignments) {
        channelToUuid.set(a.octopusTrack + 1, a.audioUnitUuid);
    }

    /* Pre-load NoteSignal so the handler is ready when events arrive */
    let noteSignalMod: typeof import("@opendaw/studio-adapters") | null = null;
    import("@opendaw/studio-adapters").then((mod) => {
        noteSignalMod = mod;
    }).catch(() => { /* openDAW optional */ });

    return (events: Uint32Array, _timestamps: Float64Array, count: number) => {
        if (!noteSignalMod) return;

        const project = getProject();
        const NoteSignal = noteSignalMod.NoteSignal;

        for (let i = 0; i < count; i++) {
            const packed = events[i];
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
    };
}

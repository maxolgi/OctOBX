/*
 * obxd-bridge.ts — Forwards batched MIDI events from the Octopus ring buffer
 * to the in-browser Obxd synth via the AudioWorklet's port.
 *
 * Same plumbing pattern as midi-bridge.ts: the single drain loop in
 * midi-output.ts (drainMidiToHardware) owns ring-buffer access and calls
 * the handler returned here on each batch. We are a parallel consumer —
 * Web MIDI hardware output and the openDAW NoteSignal bridge continue to
 * receive the same events independently.
 *
 * The handler no-ops while the synth is unpowered (isObxdReady() === false),
 * so it is safe to install before the user clicks Synth: On.
 */

import type { BatchDrainHandler } from "./midi-bridge";
import { isObxdReady, sendObxdMidi } from "./obxd-audio";

/*
 * Pitch offset in semitones applied to NoteOn / NoteOff note numbers
 * before forwarding to the Obxd engine.
 *
 * The plan called for +12 based on the ObxdVoice.h `midiIndx - 81` index,
 * but empirical testing of the actual WASM build showed the synth is
 * already calibrated to standard MIDI semantics:
 *   - MIDI 60 → fundamental at ~258 Hz (≈ C4)
 *   - MIDI 69 → fundamental at ~445 Hz (≈ A4 = 440 Hz)
 *   - MIDI 81 → fundamental at ~890 Hz (≈ A5 = 880 Hz)
 * So adding +12 would shift everything UP one octave. Value is left
 * configurable here in case a future Octopus firmware MIDI-base setting
 * or a per-track transpose needs compensating.
 */
export const OCTODAW_OBXD_TRANSPOSE_SEMITONES = 0;

export function createObxdBridgeHandler(
    onMidiEvent?: (status: number, d1: number, d2: number, channel: number) => void,
): BatchDrainHandler {
    return (events, _timestamps, count) => {
        if (!isObxdReady()) return;

        for (let i = 0; i < count; i++) {
            const packed = events[i];
            const status = packed & 0xff;
            const data1 = (packed >> 8) & 0xff;
            const data2 = (packed >> 16) & 0xff;
            const channel = (packed >> 24) & 0xff;

            // Drop system-common / system-real-time / sysex. The C side
            // (_obxd_midi_in) already returns early for status >= 0xF0,
            // but filtering here avoids the postMessage round-trip.
            if (status >= 0xf0) continue;

            const cmd = status & 0xf0;
            // Keep channel-voice only: NoteOff, NoteOn, CC, PC, ChPressure, PitchBend.
            if (cmd !== 0x80 && cmd !== 0x90 && cmd !== 0xb0 &&
                cmd !== 0xc0 && cmd !== 0xd0 && cmd !== 0xe0) continue;

            // Obxd is single-timbral: accept ALL channels. The status byte
            // is forwarded as-is; the engine ignores the channel nibble.

            // Transpose NoteOn / NoteOff note numbers so the synth matches
            // standard MIDI semantics (see OCTODAW_OBXD_TRANSPOSE_SEMITONES).
            let d1 = data1;
            if ((cmd === 0x80 || cmd === 0x90) && d1 >= 0 && d1 <= 127) {
                d1 = Math.max(0, Math.min(127, d1 + OCTODAW_OBXD_TRANSPOSE_SEMITONES));
            }

            if (onMidiEvent) onMidiEvent(status, d1, data2, channel);

            sendObxdMidi(status, d1, data2);
        }
    };
}

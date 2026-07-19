/*
 * obxd-bridge.ts — Channel-routed MIDI fan-out for the multi-instance
 * OB-XD synth (Phase B of obx.md).
 *
 * Same plumbing pattern as a hypothetical external-synth bridge: the
 * single drain loop in midi-output.ts (drainMidiToHardware) owns
 * ring-buffer access and calls the handler returned here on each batch.
 * We are a parallel consumer — Web MIDI hardware output continues to
 * receive the same events independently.
 *
 * Routing: each Octopus MIDI channel (1..16) maps to at most one OB-XD
 * instance (0..9). Default mapping is channels 1..10 → instances 0..9.
 * The user can reassign per-instance via setObxdInstanceChannel() from
 * the rack UI's channel selector. Events on unmapped channels are
 * dropped (no instance to send them to). Events on system common /
 * real-time bytes (status >= 0xF0) are dropped here as well — the C side
 * would also reject them, but skipping the postMessage round-trip is
 * cheaper.
 *
 * The handler no-ops while the synth is uninitialized
 * (isObxdReady() === false), so it is safe to install before the user
 * clicks PLAY to bring up the audio engine.
 */

import { isObxdReady, sendObxdInstanceMidi } from "./obxd-audio";

// Re-exported so main.ts can import both the handler factory and the
// BatchDrainHandler type from one place.
export type { BatchDrainHandler } from "./midi-output";
import type { BatchDrainHandler } from "./midi-output";

/*
 * Pitch offset in semitones applied to NoteOn / NoteOff note numbers
 * before forwarding to the Obxd engine.
 *
 * The plan called for +12 based on the ObxdVoice.h `midiIndx - 81` index,
 * but empirical testing of the actual WASM build showed the synth is
 * already calibrated to standard MIDI semantics:
 *   - MIDI 60 -> fundamental at ~258 Hz (= C4)
 *   - MIDI 69 -> fundamental at ~445 Hz (= A4 = 440 Hz)
 *   - MIDI 81 -> fundamental at ~890 Hz (= A5 = 880 Hz)
 * So adding +12 would shift everything UP one octave. Value is left
 * configurable here in case a future Octopus firmware MIDI-base setting
 * or a per-track transpose needs compensating.
 */
export const OBXD_TRANSPOSE_SEMITONES = 0;

const INSTANCE_COUNT = 10;

// instance_id -> midi_channel (1..16). Defaults: instances 0..9 -> channels 1..10.
// Reassignment via setObxdInstanceChannel() persists for the page lifetime.
const instanceChannels = new Map<number, number>();
for (let i = 0; i < INSTANCE_COUNT; i++) instanceChannels.set(i, i + 1);

export function setObxdInstanceChannel(id: number, channel: number): void {
    instanceChannels.set(id, Math.max(1, Math.min(16, channel | 0)));
}

export function getObxdInstanceChannel(id: number): number {
    return instanceChannels.get(id) ?? (id + 1);
}

export function createObxdBridgeHandler(): BatchDrainHandler {
    return (events, _timestamps, count) => {
        if (!isObxdReady()) return;

        // channel -> instance_id. Rebuilt each batch so a runtime
        // setObxdInstanceChannel() takes effect on the next drain without
        // needing an invalidation signal. (10 entries — cheap.)
        const channelToInstance = new Map<number, number>();
        for (const [id, ch] of instanceChannels) channelToInstance.set(ch, id);

        for (let i = 0; i < count; i++) {
            const packed = events[i];
            const status = packed & 0xff;
            const data1 = (packed >> 8) & 0xff;
            const data2 = (packed >> 16) & 0xff;
            const channel = (packed >> 24) & 0xff;

            // Drop system-common / system-real-time / sysex. The C side
            // (_obxd_midi_in) also returns early for status >= 0xF0, but
            // filtering here avoids the postMessage round-trip.
            if (status >= 0xf0) continue;

            const cmd = status & 0xf0;
            // Keep channel-voice only: NoteOff, NoteOn, CC, PC, ChPressure, PitchBend.
            if (cmd !== 0x80 && cmd !== 0x90 && cmd !== 0xb0 &&
                cmd !== 0xc0 && cmd !== 0xd0 && cmd !== 0xe0) continue;

            const instanceId = channelToInstance.get(channel);
            if (instanceId === undefined) continue;

            // Transpose NoteOn / NoteOff note numbers so the synth matches
            // standard MIDI semantics (see OBXD_TRANSPOSE_SEMITONES).
            let d1 = data1;
            if ((cmd === 0x80 || cmd === 0x90) && d1 >= 0 && d1 <= 127) {
                d1 = Math.max(0, Math.min(127, d1 + OBXD_TRANSPOSE_SEMITONES));
            }

            sendObxdInstanceMidi(instanceId, status, d1, data2);
        }
    };
}

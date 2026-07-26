/*
 * obxd-bridge.ts — Channel-routed MIDI fan-out for the multi-instance
 * OB-XD synth.
 *
 * Same plumbing pattern as a hypothetical external-synth bridge: the
 * single drain loop in midi-output.ts (drainMidiToHardware) owns
 * ring-buffer access and calls the handler returned here on each batch.
 * We are a parallel consumer — Web MIDI hardware output continues to
 * receive the same events independently.
 *
 * Routing:
 *   - Non-MPE (default): each Octopus MIDI channel (1..16) maps to at most
 *     one OB-XD instance (0..9). Default mapping is channels 1..10 →
 *     instances 0..9. The user can reassign per-instance via
 *     setObxdInstanceChannel() from the rack UI's channel selector.
 *   - MPE: when an instance has MPE enabled (setObxdInstanceMpe), it owns
 *     a LOWER ZONE — its configured channel becomes the master, and the
 *     next `voiceCount` channels (master+1 .. master+voiceCount, clamped
 *     to 1..16) become its per-voice channels. The instance therefore
 *     receives NoteOn/NoteOff from multiple channels, and the per-note
 *     channel is preserved in the status byte's low nibble all the way to
 *     obxd_midi_in() (see "Channel preservation" below). MPE zones are
 *     claimed first; non-MPE instances only fill channels an MPE instance
 *     hasn't already claimed.
 *
 * Events on unmapped channels are dropped (no instance to send them to).
 * Events on system common / real-time bytes (status >= 0xF0) are dropped
 * here as well — the C side would also reject them, but skipping the
 * postMessage round-trip is cheaper.
 *
 * The handler no-ops while the synth is uninitialized
 * (isObxdReady() === false), so it is safe to install before the user
 * clicks PLAY to bring up the audio engine.
 *
 * NOTE: the bridge handler returned by createObxdBridgeHandler() is the
 * SECONDARY path. The PRIMARY (and currently only active) OB-XD path is
 * the SharedArrayBuffer ring read directly inside the AudioWorklet's
 * process() — see obxd-processor.tail.js. That path uses the SAME
 * channel→instance routing table we push via sendObxdMidiRouting(), so
 * the buildChannelToInstance() logic below governs both paths. Keeping
 * them in sync is why routing is computed once here and pushed to the
 * worklet on every change.
 *
 * Channel preservation (MPE): the Octopus engine packs the full MIDI
 * status byte (0x90 | (channel & 0x0F)) into the ring, so the per-note
 * channel travels in the status byte's low nibble. obxd_midi_in() on the
 * C side currently hardcodes `channel = 0` regardless of that nibble;
 * consuming `status & 0x0F` when g_mpe_enabled[id] is set is the engine
 * follow-up that makes processNoteOn(note, vel, channel) receive the real
 * per-voice channel. No JS change is needed for that — the channel is
 * already in the status byte we forward.
 */

import { isObxdReady, sendObxdMidiRouting, sendObxdInstanceMidi, setObxdInstanceMpe as setObxdInstanceMpeEngine } from "./obxd-audio";

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

// Max voice channels an MPE instance can claim beyond its master.
// MPE zones cap at 15 voice channels (16 channels total − the master).
const MAX_MPE_VOICE_CHANNELS = 15;
// Default voice-channel count when MPE is enabled on an instance.
const DEFAULT_MPE_VOICE_CHANNELS = 8;

// instance_id -> midi_channel (1..16). Defaults: instances 0..9 -> channels 1..10.
// Reassignment via setObxdInstanceChannel() persists for the page lifetime.
const instanceChannels = new Map<number, number>();
for (let i = 0; i < INSTANCE_COUNT; i++) instanceChannels.set(i, i + 1);

// Per-instance MPE configuration. When mpe[id] is true the instance owns a
// lower zone: master = instanceChannels[id], voices = master+1..master+voiceCount.
// Both arrays persist for the page lifetime and are mirrored to the C side
// (g_mpe_enabled[id]) via setObxdInstanceMpe() in obxd-audio.ts.
const instanceMpe = new Array<boolean>(INSTANCE_COUNT).fill(false);
const instanceMpeVoiceCount = new Array<number>(INSTANCE_COUNT).fill(DEFAULT_MPE_VOICE_CHANNELS);

export function setObxdInstanceChannel(id: number, channel: number): void {
    instanceChannels.set(id, Math.max(1, Math.min(16, channel | 0)));
    syncRoutingToAudioWorklet();
}

/*
 * Enable/disable MPE for an instance. Mirrors the flag to the engine
 * (g_mpe_enabled[id] via setObxdInstanceMpe in obxd-audio.ts) AND rebuilds
 * the channel→instance routing so the instance claims its zone. Both the
 * worklet SAB path (via syncRoutingToAudioWorklet) and the bridge drain
 * path (via buildChannelToInstance in the handler) pick up the new zone on
 * the next batch.
 *
 * The engine flag is what the (deferred) obxd_midi_in channel-consumption
 * follow-up keys off of; setting it now means the moment that one-liner
 * lands, per-voice channel dispatch works end-to-end with no further JS.
 */
export function setObxdInstanceMpe(id: number, enabled: boolean): void {
    if (id < 0 || id >= INSTANCE_COUNT) return;
    instanceMpe[id] = !!enabled;
    // Mirror the flag to the engine (g_mpe_enabled[id] via the worklet's
    // set_mpe handler). No-ops before the worklet is up; the handler guards
    // on wasmModule. Setting it now means the moment the engine-side
    // obxd_midi_in channel-consumption follow-up lands, per-voice channel
    // dispatch works end-to-end with no further JS change.
    setObxdInstanceMpeEngine(id, instanceMpe[id]);
    syncRoutingToAudioWorklet();
}

export function getObxdInstanceMpe(id: number): boolean {
    if (id < 0 || id >= INSTANCE_COUNT) return false;
    return instanceMpe[id];
}

/*
 * Number of voice channels an MPE-enabled instance claims beyond its
 * master. Clamped to [0, 15]. A voiceCount of 0 means the instance still
 * marks its master channel as "MPE master" but claims no extra voice
 * channels (useful if you want only the master to drive it). Adjustable
 * for future UI; the rack currently displays the resulting zone.
 */
export function setObxdInstanceMpeVoiceCount(id: number, count: number): void {
    if (id < 0 || id >= INSTANCE_COUNT) return;
    instanceMpeVoiceCount[id] = Math.max(0, Math.min(MAX_MPE_VOICE_CHANNELS, count | 0));
    syncRoutingToAudioWorklet();
}

export function getObxdInstanceMpeVoiceCount(id: number): number {
    if (id < 0 || id >= INSTANCE_COUNT) return 0;
    return instanceMpeVoiceCount[id];
}

/*
 * The list of MIDI channels (1..16) the given instance listens on.
 *  - Non-MPE: a single-element array [master].
 *  - MPE: [master, master+1, ..., min(16, master+voiceCount)].
 * Used by the rack UI's channel-assignment label. Channels are clamped to
 * the valid 1..16 range, so an MPE instance whose master is near 16 simply
 * claims fewer voice channels.
 */
export function getObxdMpeChannels(id: number): number[] {
    if (id < 0 || id >= INSTANCE_COUNT) return [];
    const master = instanceChannels.get(id) ?? (id + 1);
    if (!instanceMpe[id]) return [master];
    const vc = instanceMpeVoiceCount[id];
    const out: number[] = [master];
    for (let v = 1; v <= vc; v++) {
        const ch = master + v;
        if (ch > 16) break;
        out.push(ch);
    }
    return out;
}

/*
 * Build the channel→instance routing map used by BOTH the drain-loop
 * handler (this file) and the worklet SAB path (via syncRoutingToAudioWorklet).
 *
 * Precedence: MPE instances claim their full zone first (master + voice
 * channels), so enabling MPE on an instance can shadow another instance's
 * single channel — that is intentional and matches how a hardware MPE zone
 * would monopolise channels. Non-MPE instances then fill any channel not
 * already claimed. If two non-MPE instances share a channel, the last one
 * registered wins (Map.set overwrites), matching the prior 1:1 behaviour.
 */
function buildChannelToInstance(): Map<number, number> {
    const map = new Map<number, number>();

    // Pass 1: MPE zones.
    for (let id = 0; id < INSTANCE_COUNT; id++) {
        if (!instanceMpe[id]) continue;
        for (const ch of getObxdMpeChannels(id)) {
            map.set(ch, id);
        }
    }

    // Pass 2: non-MPE single channels (only fill unclaimed channels).
    for (let id = 0; id < INSTANCE_COUNT; id++) {
        if (instanceMpe[id]) continue;
        const ch = instanceChannels.get(id) ?? (id + 1);
        if (!map.has(ch)) map.set(ch, id);
    }

    return map;
}

function syncRoutingToAudioWorklet(): void {
    if (!isObxdReady()) return;
    // 17-entry array (index 0 unused; channels are 1..16). -1 = unmapped.
    const routing = new Array(17).fill(-1);
    for (const [ch, id] of buildChannelToInstance()) {
        routing[ch] = id;
    }
    sendObxdMidiRouting(routing);
}

export function getObxdInstanceChannel(id: number): number {
    return instanceChannels.get(id) ?? (id + 1);
}

export function createObxdBridgeHandler(): BatchDrainHandler {
    return (events, _timestamps, count) => {
        if (!isObxdReady()) return;

        // channel -> instance_id. Rebuilt each batch so a runtime
        // setObxdInstanceChannel() / setObxdInstanceMpe() takes effect on
        // the next drain without needing an invalidation signal. (≤16
        // entries — cheap.) MPE-aware: an MPE instance appears under
        // multiple channel keys.
        const channelToInstance = buildChannelToInstance();

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

            // Forward the FULL status byte (channel nibble intact). In MPE
            // mode the per-voice channel lives in status & 0x0F; the engine
            // follow-up consumes it for processNoteOn(note, vel, channel).
            sendObxdInstanceMidi(instanceId, status, d1, data2);
        }
    };
}

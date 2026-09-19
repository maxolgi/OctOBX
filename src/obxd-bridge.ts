/*
 * obxd-bridge.ts — Channel-routed MIDI routing state for the
 * multi-instance OB-Xf synth.
 *
 * The OB-Xf synth reads MIDI directly from shared memory inside the
 * AudioWorklet's process() (see obxd-processor.tail.js) using the
 * channel→instance routing table we push via sendObxdMidiRouting(). The
 * buildChannelToInstance() logic below governs that path; routing is
 * computed once here and pushed to the worklet on every change.
 *
 * Routing:
 *   - Non-MPE (default): each Octopus MIDI channel (1..16) maps to at most
 *     one OB-Xf instance (0..9). Default mapping is channels 1..10 →
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
 * The syncRoutingToAudioWorklet() push no-ops while the worklet is
 * uninitialized (isObxdReady() === false) and the next change after boot
 * delivers the full table.
 *
 * Channel preservation (MPE): the Octopus engine packs the full MIDI
 * status byte (0x90 | (channel & 0x0F)) into its MIDI stream, so the
 * per-note channel travels in the status byte's low nibble. obxd_midi_in()
 * on the C side currently hardcodes `channel = 0` regardless of that nibble;
 * consuming `status & 0x0F` when g_mpe_enabled[id] is set is the engine
 * follow-up that makes processNoteOn(note, vel, channel) receive the real
 * per-voice channel. No JS change is needed for that — the channel is
 * already in the status byte the worklet reads.
 */

import { isObxdReady, sendObxdMidiRouting, setObxdInstanceMpe as setObxdInstanceMpeEngine } from "./obxd-audio";
import { buildChannelToInstance as buildRouting, MAX_MPE_VOICE_CHANNELS } from "./channel-routing";
import type { InstanceRoute } from "./channel-routing";

const INSTANCE_COUNT = 10;

// Max voice channels an MPE instance can claim beyond its master.
// MPE zones cap at 15 voice channels (16 channels total − the master).
// (Re-exported from channel-routing.ts for the MAX_MPE_VOICE_CHANNELS constant.)
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
 * Build the channel→instance routing map from the current module-level state.
 * Returns Map<channel, number[]> — multiple non-MPE instances can share a
 * channel. Delegates to the pure buildRouting() from channel-routing.ts.
 */
function buildChannelToInstance(): Map<number, number[]> {
    const routes: InstanceRoute[] = [];
    for (let id = 0; id < INSTANCE_COUNT; id++) {
        routes.push({
            channel: instanceChannels.get(id) ?? (id + 1),
            mpe: instanceMpe[id],
            mpeVoiceCount: instanceMpeVoiceCount[id],
        });
    }
    return buildRouting(routes);
}

function syncRoutingToAudioWorklet(): void {
    if (!isObxdReady()) return;
    // 17-entry array (index 0 unused; channels are 1..16). Each entry is a
    // BITMASK of instance IDs (bit 0 = instance 0, bit 1 = instance 1, …).
    // 0 = unmapped. Multiple instances on the same channel OR their bits.
    const routing = new Array(17).fill(0);
    for (const [ch, ids] of buildChannelToInstance()) {
        let mask = 0;
        for (const id of ids) mask |= (1 << id);
        routing[ch] = mask;
    }
    sendObxdMidiRouting(routing);
}

export function getObxdInstanceChannel(id: number): number {
    return instanceChannels.get(id) ?? (id + 1);
}

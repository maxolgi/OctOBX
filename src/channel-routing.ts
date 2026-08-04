/*
 * channel-routing.ts — pure MIDI channel → instance routing logic.
 *
 * Extracted from obxd-bridge.ts so it can be unit-tested without pulling
 * in AudioWorklet/browser dependencies.
 *
 * Two routing modes:
 *   - Non-MPE (default): each instance maps to one MIDI channel (1..16).
 *     Multiple non-MPE instances CAN share a channel — all instances on
 *     the same channel receive the same MIDI events, just like real MIDI
 *     gear on the same channel. Default: instances 0..9 → channels 1..10.
 *   - MPE: an instance with MPE enabled claims a LOWER ZONE — its configured
 *     channel becomes the master, and the next `voiceCount` channels become
 *     its per-voice channels. MPE zones are EXCLUSIVE: non-MPE instances
 *     cannot share channels claimed by an MPE instance.
 *
 * Precedence: MPE zones are claimed first (pass 1), then non-MPE instances
 * fill non-MPE channels (pass 2). Non-MPE instances on MPE-claimed channels
 * are silently dropped.
 */

export interface InstanceRoute {
    channel: number;        // master channel (1..16)
    mpe: boolean;           // is MPE enabled for this instance?
    mpeVoiceCount: number;  // voice channels to claim (only when mpe=true)
}

/** Maximum voice channels an MPE instance can claim beyond its master. */
export const MAX_MPE_VOICE_CHANNELS = 15;

/**
 * Given an array of per-instance routing configs (indexed by instance_id),
 * build a Map<MIDI channel (1..16), number[]> where the value is the list
 * of instance IDs that should receive events on that channel.
 *
 * MPE channels map to a single-element array (exclusive). Non-MPE channels
 * can have multiple instances (shared).
 */
export function buildChannelToInstance(routes: InstanceRoute[]): Map<number, number[]> {
    const map = new Map<number, number[]>();
    const mpeClaimed = new Set<number>();

    // Pass 1: MPE zones claim master + voice channels (exclusive).
    for (let id = 0; id < routes.length; id++) {
        const r = routes[id];
        if (!r || !r.mpe) continue;
        const master = r.channel;
        const voiceCount = Math.min(r.mpeVoiceCount, MAX_MPE_VOICE_CHANNELS);
        map.set(master, [id]);
        mpeClaimed.add(master);
        for (let v = 1; v <= voiceCount; v++) {
            const vc = master + v;
            if (vc > 16) break;
            map.set(vc, [id]);
            mpeClaimed.add(vc);
        }
    }

    // Pass 2: non-MPE instances fill non-MPE channels (shared, not exclusive).
    for (let id = 0; id < routes.length; id++) {
        const r = routes[id];
        if (!r || r.mpe) continue;
        if (mpeClaimed.has(r.channel)) continue; // MPE-claimed, skip
        const list = map.get(r.channel);
        if (list) list.push(id);
        else map.set(r.channel, [id]);
    }

    return map;
}

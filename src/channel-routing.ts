/*
 * channel-routing.ts — pure MIDI channel → instance routing logic.
 *
 * Extracted from obxd-bridge.ts so it can be unit-tested without pulling
 * in AudioWorklet/browser dependencies.
 *
 * Two routing modes:
 *   - Non-MPE (default): each instance maps to exactly one MIDI channel
 *     (1..16). Default: instances 0..9 → channels 1..10.
 *   - MPE: an instance with MPE enabled claims a LOWER ZONE — its configured
 *     channel becomes the master, and the next `voiceCount` channels become
 *     its per-voice channels.
 *
 * Precedence: MPE zones are claimed first (pass 1), then non-MPE instances
 * fill unclaimed channels (pass 2). If two non-MPE instances share a
 * channel, the last one registered wins.
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
 * build a Map<MIDI channel (1..16), instance_id>.
 */
export function buildChannelToInstance(routes: InstanceRoute[]): Map<number, number> {
    const map = new Map<number, number>();

    // Pass 1: MPE zones claim master + voice channels.
    for (let id = 0; id < routes.length; id++) {
        const r = routes[id];
        if (!r || !r.mpe) continue;
        const master = r.channel;
        const voiceCount = Math.min(r.mpeVoiceCount, MAX_MPE_VOICE_CHANNELS);
        map.set(master, id);
        for (let v = 1; v <= voiceCount; v++) {
            const vc = master + v;
            if (vc > 16) break;
            map.set(vc, id);
        }
    }

    // Pass 2: non-MPE instances fill unclaimed channels (last wins).
    for (let id = 0; id < routes.length; id++) {
        const r = routes[id];
        if (!r || r.mpe) continue;
        if (!map.has(r.channel)) map.set(r.channel, id);
    }

    return map;
}

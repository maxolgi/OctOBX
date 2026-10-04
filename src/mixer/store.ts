/*
 * mixer/store.ts — state + worklet messaging for the 16-stereo-track
 * CakeMix mixer console (vanilla-TS port of CakeMix's SolidJS
 * stores/mixer.ts).
 *
 * Track model: the UI speaks in STEREO TRACKS (0..15); the engine speaks
 * in MONO channels. Track t maps to engine channels 2t (L) and 2t+1 (R)
 * — every control write fans out to both channels (pan applied to both
 * acts as a stereo balance). OB-Xf instances 0..9 feed tracks 0..9 (see
 * the worklet tail's process()); tracks 10..15 are spare/silent.
 *
 * Metering: the worklet posts {type:'mixer_meter'} every ~10 audio blocks
 * (channel_meters_json + master meters). store.ts owns the ONE permanent
 * worklet-message listener (registered at module load) that folds those
 * into plain arrays the widgets poll from a single rAF loop in console.ts
 * — no per-widget timers.
 */

import { postWorkletMessage } from "../obxd-audio";

export const TRACK_COUNT = 16;

/** Engine channel index for track t, side s (0 = L, 1 = R). */
export function trackChannel(track: number, side: 0 | 1): number {
    return track * 2 + side;
}

/**
 * Stereo-pair pan wiring. Each track is TWO mono engine channels; feeding
 * both at pan=0 (center) makes master_L = master_R = 0.5·L + 0.5·R — a
 * collapsed MONO sum, 3–6 dB low on wide material. Instead the L channel
 * pans HARD LEFT and the R channel HARD RIGHT (unity passthrough, true
 * stereo preserved), and the track's pan control offsets both channels
 * as a balance: at balance −1 both pans sit hard left, at +1 hard right.
 */
export function channelPans(balance: number): { lPan: number; rPan: number } {
    const b = Math.max(-1, Math.min(1, balance));
    return {
        lPan: -1 + 2 * Math.max(0, b),
        rPan: 1 + 2 * Math.min(0, b),
    };
}

// ── Fader/gain math (verbatim from CakeMix stores/mixer.ts) ─────────────────

export function faderToGain(pos: number): number {
    const db = -60 + pos * 66;
    if (db <= -59) return 0;
    return Math.pow(10, db / 20);
}

export function gainToFader(gain: number): number {
    if (gain <= 0.001) return 0;
    const db = 20 * Math.log10(gain);
    return Math.max(0, Math.min(1, (db + 60) / 66));
}

export function formatGainDb(gain: number): string {
    if (gain <= 0.001) return "−∞";
    const db = 20 * Math.log10(gain);
    return db >= 0 ? `+${db.toFixed(1)}` : db.toFixed(1);
}

// ── Track state (fields mirror CakeMix ChannelState) ────────────────────────

export interface EqBand {
    gainDb: number;
    freqHz: number;
    q: number;
}

export interface TrackState {
    name: string;
    gain: number;            // linear fader gain
    inputGainDb: number;
    phaseInverted: boolean;
    pan: number;             // -1..1 (balance across the L/R pair)
    panLaw: number;          // 0 Linear, 1 -3dB, 2 -4.5dB, 3 -6dB (default:
                             // -6dB constant-sum — a center-panned correlated
                             // pair sums to unity on the master, so track and
                             // master meters correspond; the worklet applies
                             // the same default to every engine channel)
    muted: boolean;
    soloed: boolean;
    eqBypassed: boolean;
    eqBands: EqBand[];
    gateEnabled: boolean;
    gateThresholdDb: number;
    gateHysteresisDb: number;
    gateAttackMs: number;
    gateReleaseMs: number;
    gateHoldMs: number;
    compEnabled: boolean;
    compThresholdDb: number;
    compRatio: number;
    compKneeDb: number;
    compAttackMs: number;
    compReleaseMs: number;
    compMakeupDb: number;
    expanderEnabled: boolean;
    expanderThresholdDb: number;
    expanderRatio: number;
    expanderAttackMs: number;
    expanderReleaseMs: number;
    mainAssigned: boolean;
}

const EQ_BAND_DEFAULTS: EqBand[] = [
    { gainDb: 0, freqHz: 80, q: 0.707 },
    { gainDb: 0, freqHz: 120, q: 0.707 },
    { gainDb: 0, freqHz: 400, q: 1.0 },
    { gainDb: 0, freqHz: 1500, q: 1.0 },
    { gainDb: 0, freqHz: 5000, q: 1.0 },
    { gainDb: 0, freqHz: 10000, q: 0.707 },
];

export const EQ_BAND_LAYOUT = [
    { name: "HPF", hasGain: false },
    { name: "LOW", hasGain: true },
    { name: "L-MID", hasGain: true },
    { name: "MID", hasGain: true },
    { name: "H-MID", hasGain: true },
    { name: "HIGH", hasGain: false },
] as const;

export const PAN_LAWS = ["Linear", "-3dB", "-4.5dB", "-6dB"] as const;

function defaultTrack(index: number): TrackState {
    const name =
        index < 9 ? `OB-Xf ${index + 1}` :
        index === 9 ? "Drums" :
        `Trk ${index + 1}`;
    return {
        name,
        gain: 1.0,
        inputGainDb: 0,
        phaseInverted: false,
        pan: 0,
        panLaw: 3,
        muted: false,
        soloed: false,
        eqBypassed: false,
        eqBands: EQ_BAND_DEFAULTS.map((b) => ({ ...b })),
        gateEnabled: false,
        gateThresholdDb: -50, gateHysteresisDb: 6, gateAttackMs: 2, gateReleaseMs: 100, gateHoldMs: 10,
        compEnabled: false,
        compThresholdDb: -12, compRatio: 3, compKneeDb: 3, compAttackMs: 5, compReleaseMs: 100, compMakeupDb: 3,
        expanderEnabled: false,
        expanderThresholdDb: -40, expanderRatio: 2, expanderAttackMs: 5, expanderReleaseMs: 100,
        mainAssigned: true,
    };
}

export const tracks: TrackState[] = Array.from({ length: TRACK_COUNT }, (_, i) => defaultTrack(i));

// ── Master state ────────────────────────────────────────────────────────────

export const master = {
    gain: 1.0,
    limiterEnabled: true,
    limiterCeiling: -0.3,
    limiterRelease: 50,
};

// ── Messaging helpers ───────────────────────────────────────────────────────

function sendBoth(track: number, msg: (ch: number) => Record<string, unknown>): void {
    postWorkletMessage(msg(trackChannel(track, 0)));
    postWorkletMessage(msg(trackChannel(track, 1)));
}

/**
 * Push the ENTIRE store state to the engine once (on mixer_ready).
 *
 * Why: the engine creates strips with ITS OWN defaults, and a knob only
 * sends its value when first touched — until then the engine could be
 * running a different default than the knob DISPLAYS (one real case
 * found in the wild: the expander release knob shows 100 ms while the
 * engine's own default is 50 ms). Seeding makes displayed == actual for
 * every control from boot, for every future default change, at the cost
 * of ~1000 cheap setter messages once.
 */
export function seedEngineFromStore(): void {
    for (let t = 0; t < TRACK_COUNT; t++) {
        const tr = tracks[t];
        sendBoth(t, (ch) => ({ type: "mix_name", ch, name: tr.name }));
        sendBoth(t, (ch) => ({ type: "mix_input_gain", ch, gainDb: tr.inputGainDb }));
        sendBoth(t, (ch) => ({ type: "mix_phase", ch, inverted: tr.phaseInverted }));
        sendBoth(t, (ch) => ({ type: "mix_pan_law", ch, law: tr.panLaw }));
        {
            const { lPan, rPan } = channelPans(tr.pan);
            postWorkletMessage({ type: "mix_pan", ch: trackChannel(t, 0), pan: lPan });
            postWorkletMessage({ type: "mix_pan", ch: trackChannel(t, 1), pan: rPan });
        }
        sendBoth(t, (ch) => ({ type: "mix_gain", ch, gain: tr.gain }));
        sendBoth(t, (ch) => ({ type: "mix_main_assign", ch, on: tr.mainAssigned }));
        sendBoth(t, (ch) => ({ type: "mix_eq_bypass", ch, bypassed: tr.eqBypassed }));
        for (let b = 0; b < tr.eqBands.length; b++) {
            // NOTE: `band: b` must be the numeric index — an earlier
            // version shadowed `band` with the EqBand object here, the
            // worklet coerced it (obj|0 → 0), and every seeded EQ write
            // landed on band 0 (the last one, the shelf's 10000 Hz, left
            // the HPF at 10 kHz — a ~25 dB broadband cut).
            const bd = tr.eqBands[b];
            sendBoth(t, (ch) => ({ type: "mix_eq_gain", ch, band: b, gainDb: bd.gainDb }));
            sendBoth(t, (ch) => ({ type: "mix_eq_freq", ch, band: b, freqHz: bd.freqHz }));
            sendBoth(t, (ch) => ({ type: "mix_eq_q", ch, band: b, q: bd.q }));
        }
        sendBoth(t, (ch) => ({ type: "mix_gate_enable", ch, enabled: tr.gateEnabled }));
        sendBoth(t, (ch) => ({ type: "mix_gate_param", ch, param: 0, value: tr.gateThresholdDb }));
        sendBoth(t, (ch) => ({ type: "mix_gate_param", ch, param: 1, value: tr.gateHysteresisDb }));
        sendBoth(t, (ch) => ({ type: "mix_gate_param", ch, param: 2, value: tr.gateAttackMs }));
        sendBoth(t, (ch) => ({ type: "mix_gate_param", ch, param: 3, value: tr.gateReleaseMs }));
        sendBoth(t, (ch) => ({ type: "mix_gate_param", ch, param: 4, value: tr.gateHoldMs }));
        sendBoth(t, (ch) => ({ type: "mix_comp_enable", ch, enabled: tr.compEnabled }));
        sendBoth(t, (ch) => ({ type: "mix_comp_param", ch, param: 0, value: tr.compThresholdDb }));
        sendBoth(t, (ch) => ({ type: "mix_comp_param", ch, param: 1, value: tr.compRatio }));
        sendBoth(t, (ch) => ({ type: "mix_comp_param", ch, param: 2, value: tr.compAttackMs }));
        sendBoth(t, (ch) => ({ type: "mix_comp_param", ch, param: 3, value: tr.compReleaseMs }));
        sendBoth(t, (ch) => ({ type: "mix_comp_param", ch, param: 4, value: tr.compMakeupDb }));
        sendBoth(t, (ch) => ({ type: "mix_comp_param", ch, param: 5, value: tr.compKneeDb }));
        sendBoth(t, (ch) => ({ type: "mix_exp_enable", ch, enabled: tr.expanderEnabled }));
        sendBoth(t, (ch) => ({ type: "mix_exp_param", ch, param: 0, value: tr.expanderThresholdDb }));
        sendBoth(t, (ch) => ({ type: "mix_exp_param", ch, param: 1, value: tr.expanderRatio }));
        sendBoth(t, (ch) => ({ type: "mix_exp_param", ch, param: 2, value: tr.expanderAttackMs }));
        sendBoth(t, (ch) => ({ type: "mix_exp_param", ch, param: 3, value: tr.expanderReleaseMs }));
        // mute/solo default false in both — nothing to send.
    }
    setMasterGain(master.gain);
    setLimiterEnabled(master.limiterEnabled);
    setLimiterCeiling(master.limiterCeiling);
    setLimiterRelease(master.limiterRelease);
}

// ── Track control setters (mutate store + post both engine channels) ───────

export function setTrackName(t: number, name: string): void {
    tracks[t].name = name;
    sendBoth(t, (ch) => ({ type: "mix_name", ch, name }));
}
export function setTrackFaderGain(t: number, gain: number): void {
    tracks[t].gain = gain;
    sendBoth(t, (ch) => ({ type: "mix_gain", ch, gain }));
}
export function setTrackPan(t: number, pan: number): void {
    tracks[t].pan = pan;
    // Balance → per-channel pans (L hard-left / R hard-right at center;
    // see channelPans). The engine channel for each side gets its own pan.
    const { lPan, rPan } = channelPans(pan);
    postWorkletMessage({ type: "mix_pan", ch: trackChannel(t, 0), pan: lPan });
    postWorkletMessage({ type: "mix_pan", ch: trackChannel(t, 1), pan: rPan });
}
export function setTrackMute(t: number, muted: boolean): void {
    tracks[t].muted = muted;
    sendBoth(t, (ch) => ({ type: "mix_mute", ch, muted }));
}
export function setTrackSolo(t: number, soloed: boolean): void {
    tracks[t].soloed = soloed;
    sendBoth(t, (ch) => ({ type: "mix_solo", ch, soloed }));
}
export function setTrackInputGain(t: number, gainDb: number): void {
    tracks[t].inputGainDb = gainDb;
    sendBoth(t, (ch) => ({ type: "mix_input_gain", ch, gainDb }));
}
export function setTrackPhase(t: number, inverted: boolean): void {
    tracks[t].phaseInverted = inverted;
    sendBoth(t, (ch) => ({ type: "mix_phase", ch, inverted }));
}
export function setTrackPanLaw(t: number, law: number): void {
    tracks[t].panLaw = law;
    sendBoth(t, (ch) => ({ type: "mix_pan_law", ch, law }));
}
export function setTrackMainAssign(t: number, on: boolean): void {
    tracks[t].mainAssigned = on;
    sendBoth(t, (ch) => ({ type: "mix_main_assign", ch, on }));
}
export function setEqGain(t: number, band: number, gainDb: number): void {
    tracks[t].eqBands[band].gainDb = gainDb;
    sendBoth(t, (ch) => ({ type: "mix_eq_gain", ch, band, gainDb }));
}
export function setEqFreq(t: number, band: number, freqHz: number): void {
    tracks[t].eqBands[band].freqHz = freqHz;
    sendBoth(t, (ch) => ({ type: "mix_eq_freq", ch, band, freqHz }));
}
export function setEqQ(t: number, band: number, q: number): void {
    tracks[t].eqBands[band].q = q;
    sendBoth(t, (ch) => ({ type: "mix_eq_q", ch, band, q }));
}
export function setEqBypass(t: number, bypassed: boolean): void {
    tracks[t].eqBypassed = bypassed;
    sendBoth(t, (ch) => ({ type: "mix_eq_bypass", ch, bypassed }));
}
export function setCompEnabled(t: number, enabled: boolean): void {
    tracks[t].compEnabled = enabled;
    sendBoth(t, (ch) => ({ type: "mix_comp_enable", ch, enabled }));
}
/** Re-send all comp params (both channels). The engine's param setters
 *  no-op while the effect is disabled, and disable DESTROYS the effect —
 *  so every enable must be followed by a push of the displayed values,
 *  or the engine runs its own defaults under the knobs. */
export function pushCompParams(t: number): void {
    const tr = tracks[t];
    sendBoth(t, (ch) => ({ type: "mix_comp_param", ch, param: 0, value: tr.compThresholdDb }));
    sendBoth(t, (ch) => ({ type: "mix_comp_param", ch, param: 1, value: tr.compRatio }));
    sendBoth(t, (ch) => ({ type: "mix_comp_param", ch, param: 2, value: tr.compAttackMs }));
    sendBoth(t, (ch) => ({ type: "mix_comp_param", ch, param: 3, value: tr.compReleaseMs }));
    sendBoth(t, (ch) => ({ type: "mix_comp_param", ch, param: 4, value: tr.compMakeupDb }));
    sendBoth(t, (ch) => ({ type: "mix_comp_param", ch, param: 5, value: tr.compKneeDb }));
}
export function setCompParam(t: number, param: number, value: number): void {
    if (param === 0) tracks[t].compThresholdDb = value;
    else if (param === 1) tracks[t].compRatio = value;
    else if (param === 2) tracks[t].compAttackMs = value;
    else if (param === 3) tracks[t].compReleaseMs = value;
    else if (param === 4) tracks[t].compMakeupDb = value;
    else if (param === 5) tracks[t].compKneeDb = value;
    sendBoth(t, (ch) => ({ type: "mix_comp_param", ch, param, value }));
}
export function setGateEnabled(t: number, enabled: boolean): void {
    tracks[t].gateEnabled = enabled;
    sendBoth(t, (ch) => ({ type: "mix_gate_enable", ch, enabled }));
}
/** See pushCompParams — enable always recreates engine defaults; push the
 *  displayed values right after every enable. */
export function pushGateParams(t: number): void {
    const tr = tracks[t];
    sendBoth(t, (ch) => ({ type: "mix_gate_param", ch, param: 0, value: tr.gateThresholdDb }));
    sendBoth(t, (ch) => ({ type: "mix_gate_param", ch, param: 1, value: tr.gateHysteresisDb }));
    sendBoth(t, (ch) => ({ type: "mix_gate_param", ch, param: 2, value: tr.gateAttackMs }));
    sendBoth(t, (ch) => ({ type: "mix_gate_param", ch, param: 3, value: tr.gateReleaseMs }));
    sendBoth(t, (ch) => ({ type: "mix_gate_param", ch, param: 4, value: tr.gateHoldMs }));
}
export function setGateParam(t: number, param: number, value: number): void {
    if (param === 0) tracks[t].gateThresholdDb = value;
    else if (param === 1) tracks[t].gateHysteresisDb = value;
    else if (param === 2) tracks[t].gateAttackMs = value;
    else if (param === 3) tracks[t].gateReleaseMs = value;
    else if (param === 4) tracks[t].gateHoldMs = value;
    sendBoth(t, (ch) => ({ type: "mix_gate_param", ch, param, value }));
}
export function setExpEnabled(t: number, enabled: boolean): void {
    tracks[t].expanderEnabled = enabled;
    sendBoth(t, (ch) => ({ type: "mix_exp_enable", ch, enabled }));
}
/** See pushCompParams — same enable-recreates-defaults trap. */
export function pushExpParams(t: number): void {
    const tr = tracks[t];
    sendBoth(t, (ch) => ({ type: "mix_exp_param", ch, param: 0, value: tr.expanderThresholdDb }));
    sendBoth(t, (ch) => ({ type: "mix_exp_param", ch, param: 1, value: tr.expanderRatio }));
    sendBoth(t, (ch) => ({ type: "mix_exp_param", ch, param: 2, value: tr.expanderAttackMs }));
    sendBoth(t, (ch) => ({ type: "mix_exp_param", ch, param: 3, value: tr.expanderReleaseMs }));
}
export function setExpParam(t: number, param: number, value: number): void {
    if (param === 0) tracks[t].expanderThresholdDb = value;
    else if (param === 1) tracks[t].expanderRatio = value;
    else if (param === 2) tracks[t].expanderAttackMs = value;
    else if (param === 3) tracks[t].expanderReleaseMs = value;
    sendBoth(t, (ch) => ({ type: "mix_exp_param", ch, param, value }));
}

// ── Master setters ──────────────────────────────────────────────────────────

export function setMasterGain(gain: number): void {
    master.gain = gain;
    postWorkletMessage({ type: "mix_master_gain", gain });
}
export function setLimiterEnabled(enabled: boolean): void {
    master.limiterEnabled = enabled;
    postWorkletMessage({ type: "mix_limiter_enabled", enabled });
}
export function setLimiterCeiling(ceilingDb: number): void {
    master.limiterCeiling = ceilingDb;
    postWorkletMessage({ type: "mix_limiter_ceiling", ceilingDb });
}
export function setLimiterRelease(releaseMs: number): void {
    master.limiterRelease = releaseMs;
    postWorkletMessage({ type: "mix_limiter_release", releaseMs });
}
export function clearMasterClip(): void {
    postWorkletMessage({ type: "mix_clear_clip" });
}

// ── Metering ────────────────────────────────────────────────────────────────
//
// Plain mutable snapshots polled by the single rAF loop in console.ts.
// -Infinity = silent (MeterCanvas normalizes it to 0).

export interface TrackMeters {
    peakL: number;
    rmsL: number;
    peakR: number;
    rmsR: number;
    grL: number;    // compressor gain reduction, dB (0 = none, negative = reducing)
    grR: number;
}

export const trackMeters: TrackMeters[] = Array.from({ length: TRACK_COUNT }, () => ({
    peakL: -Infinity, rmsL: -Infinity,
    peakR: -Infinity, rmsR: -Infinity,
    grL: 0, grR: 0,
}));

export const masterMeters = {
    peakL: -Infinity, rmsL: -Infinity,
    peakR: -Infinity, rmsR: -Infinity,
    clip: false,
    limiterGr: 0,
};

interface ChannelMeterEntry {
    ch: number;
    peak: number;
    rms: number;
    gr?: number;
}

/** Fold one {type:'mixer_meter'} worklet message into the snapshots. */
export function applyMixerMeter(msg: {
    peakL?: number; peakR?: number; rmsL?: number; rmsR?: number;
    clip?: boolean; limiterGr?: number; channels?: ChannelMeterEntry[];
}): void {
    masterMeters.peakL = msg.peakL ?? -Infinity;
    masterMeters.peakR = msg.peakR ?? -Infinity;
    masterMeters.rmsL = msg.rmsL ?? -Infinity;
    masterMeters.rmsR = msg.rmsR ?? -Infinity;
    masterMeters.clip = !!msg.clip;
    masterMeters.limiterGr = msg.limiterGr ?? 0;

    if (Array.isArray(msg.channels) && msg.channels.length) {
        for (const cm of msg.channels) {
            const t = cm.ch >> 1;
            if (t < 0 || t >= TRACK_COUNT) continue;
            const m = trackMeters[t];
            if (cm.ch & 1) {
                m.peakR = cm.peak; m.rmsR = cm.rms; m.grR = cm.gr ?? 0;
            } else {
                m.peakL = cm.peak; m.rmsL = cm.rms; m.grL = cm.gr ?? 0;
            }
        }
    } else {
        // Empty list = the worklet's stopped/absent report — reset all.
        for (const m of trackMeters) {
            m.peakL = m.rmsL = m.peakR = m.rmsR = -Infinity;
            m.grL = m.grR = 0;
        }
    }
}

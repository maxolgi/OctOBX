import { describe, it, expect, vi } from "vitest";

// The store posts EVERY control write to the combined AudioWorklet via
// postWorkletMessage (src/obxd-audio.ts). That module touches
// AudioContext/window at call time — mock it wholesale for a hermetic
// suite. vi.mock keys on the RESOLVED module path: "../src/obxd-audio"
// from this file and "../obxd-audio" from src/mixer/store.ts resolve to
// the same module, so the store's import is intercepted too.
vi.mock("../src/obxd-audio", () => ({ postWorkletMessage: vi.fn() }));

// The store exports module singletons (tracks, trackMeters, masterMeters)
// and its messaging goes through the mocked fn. Every group pulls a FRESH
// module via vi.resetModules() + dynamic import so there is no cross-test
// state leakage and the postWorkletMessage capture starts clean.

interface MixMsg {
    type?: unknown;
    ch?: unknown;
    band?: unknown;
    param?: unknown;
    [key: string]: unknown;
}

async function freshStore() {
    vi.resetModules();
    const store = await import("../src/mixer/store");
    const audio = await import("../src/obxd-audio");
    const post = vi.mocked(audio.postWorkletMessage);
    post.mockClear();
    return {
        store,
        post,
        msgs: () => post.mock.calls.map((c) => c[0] as MixMsg),
    };
}

/** Fresh module, two tracks given non-center pans (so the pan-pairing
 *  checks below exercise LIVE store state, not just the defaults), then
 *  a full seed with all captured messages available. */
async function freshSeededStore() {
    const ctx = await freshStore();
    ctx.store.tracks[3].pan = 0.5;
    ctx.store.tracks[7].pan = -0.75;
    ctx.post.mockClear();
    ctx.store.seedEngineFromStore();
    return ctx;
}

// ── channelPans ──────────────────────────────────────────────────────────────

describe("mixer/store — channelPans(balance)", () => {
    it("center 0 → hard-wired stereo pair {lPan:-1, rPan:+1}", async () => {
        const { store } = await freshStore();
        expect(store.channelPans(0)).toEqual({ lPan: -1, rPan: 1 });
    });

    it("+1 → both +1 (hard right); −1 → both −1 (hard left)", async () => {
        const { store } = await freshStore();
        expect(store.channelPans(1)).toEqual({ lPan: 1, rPan: 1 });
        expect(store.channelPans(-1)).toEqual({ lPan: -1, rPan: -1 });
    });

    it("+0.5 → {0, +1}; −0.5 → {−1, 0}", async () => {
        const { store } = await freshStore();
        expect(store.channelPans(0.5)).toEqual({ lPan: 0, rPan: 1 });
        expect(store.channelPans(-0.5)).toEqual({ lPan: -1, rPan: 0 });
    });

    it("clamps inputs outside ±1 to the extremes", async () => {
        const { store } = await freshStore();
        expect(store.channelPans(2)).toEqual(store.channelPans(1));
        expect(store.channelPans(37)).toEqual({ lPan: 1, rPan: 1 });
        expect(store.channelPans(-2)).toEqual(store.channelPans(-1));
        expect(store.channelPans(-37)).toEqual({ lPan: -1, rPan: -1 });
    });

    it("is monotonic non-decreasing in balance for both channels", async () => {
        const { store } = await freshStore();
        let prev = store.channelPans(-1.5);
        for (let b = -1.49; b <= 1.5; b += 0.01) {
            const cur = store.channelPans(b);
            expect(cur.lPan).toBeGreaterThanOrEqual(prev.lPan);
            expect(cur.rPan).toBeGreaterThanOrEqual(prev.rPan);
            prev = cur;
        }
    });
});

// ── trackChannel ─────────────────────────────────────────────────────────────

describe("mixer/store — trackChannel(t, side)", () => {
    it("maps track 5 → engine channels 10 (L) / 11 (R); extremes 0 and 31", async () => {
        const { store } = await freshStore();
        expect(store.trackChannel(5, 0)).toBe(10);
        expect(store.trackChannel(5, 1)).toBe(11);
        expect(store.trackChannel(0, 0)).toBe(0);
        expect(store.trackChannel(15, 1)).toBe(31);
    });
});

// ── Fader/gain math ──────────────────────────────────────────────────────────

describe("mixer/store — fader/gain math", () => {
    it("faderToGain(0) → 0 (−∞ knee)", async () => {
        const { store } = await freshStore();
        expect(store.faderToGain(0)).toBe(0);
    });

    it("faderToGain(1) ≈ +6 dB (10^(6/20))", async () => {
        const { store } = await freshStore();
        expect(store.faderToGain(1)).toBeCloseTo(Math.pow(10, 6 / 20), 12);
    });

    it("gainToFader(faderToGain(x)) round-trips within 1e-6 for x ≥ 0.02", async () => {
        const { store } = await freshStore();
        for (const x of [0.02, 0.05, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0]) {
            expect(store.gainToFader(store.faderToGain(x))).toBeCloseTo(x, 6);
        }
    });

    it("gainToFader(0) → 0 and gainToFader(0.001) → 0 (silent floor)", async () => {
        const { store } = await freshStore();
        expect(store.gainToFader(0)).toBe(0);
        expect(store.gainToFader(0.001)).toBe(0);
    });

    it('formatGainDb: 0 → "−∞" (U+2212), unity → "+0.0", 10^(1/20) → "+1.0", negative dB → "-2.5"', async () => {
        const { store } = await freshStore();
        // NOTE: the −∞ literal is Unicode MINUS SIGN U+2212 + U+221E, matching store.ts.
        expect(store.formatGainDb(0)).toBe("−∞");
        expect(store.formatGainDb(0.001)).toBe("−∞");
        expect(store.formatGainDb(1)).toBe("+0.0");
        expect(store.formatGainDb(Math.pow(10, 1 / 20))).toBe("+1.0");
        expect(store.formatGainDb(Math.pow(10, -2.5 / 20))).toBe("-2.5");
    });
});

// ── applyMixerMeter fold ─────────────────────────────────────────────────────

describe("mixer/store — applyMixerMeter fold", () => {
    it("folds channel entries into stereo track meters and mirrors master fields", async () => {
        const { store } = await freshStore();
        store.applyMixerMeter({
            peakL: -3, peakR: -4, rmsL: -20, rmsR: -21,
            clip: true, limiterGr: -2,
            channels: [
                { ch: 0, peak: -10, rms: -20, gr: -3 },
                { ch: 1, peak: -12, rms: -22, gr: -1 },
                { ch: 31, peak: -5, rms: -15 },
            ],
        });
        // ch0 = track 0 L side, ch1 = track 0 R side
        expect(store.trackMeters[0]).toEqual({
            peakL: -10, rmsL: -20, peakR: -12, rmsR: -22, grL: -3, grR: -1,
        });
        // ch31 = track 15 R side; missing gr → 0; L side stays silent
        expect(store.trackMeters[15]).toEqual({
            peakL: -Infinity, rmsL: -Infinity, peakR: -5, rmsR: -15, grL: 0, grR: 0,
        });
        // untouched tracks stay silent
        expect(store.trackMeters[1].peakL).toBe(-Infinity);
        // master mirrors the master fields
        expect(store.masterMeters).toEqual({
            peakL: -3, rmsL: -20, peakR: -4, rmsR: -21, clip: true, limiterGr: -2,
        });
    });

    it("empty channels list resets every track meter to −Infinity / gr 0", async () => {
        const { store } = await freshStore();
        store.applyMixerMeter({ channels: [{ ch: 0, peak: -1, rms: -9, gr: -2 }] });
        expect(store.trackMeters[0].peakL).toBe(-1);
        store.applyMixerMeter({ channels: [] });
        for (const m of store.trackMeters) {
            expect(m.peakL).toBe(-Infinity);
            expect(m.rmsL).toBe(-Infinity);
            expect(m.peakR).toBe(-Infinity);
            expect(m.rmsR).toBe(-Infinity);
            expect(m.grL).toBe(0);
            expect(m.grR).toBe(0);
        }
    });
});

// ── seedEngineFromStore — THE REGRESSION TEST ────────────────────────────────
//
// A real bug shipped: the seed sent an EqBand OBJECT as `band`, the worklet
// coerced it to 0, and all six bands' values piled onto band 0 — leaving the
// HPF parked at 10 kHz (a ~25 dB broadband cut). These tests pin the wire
// format: `band`/`param` must be numeric integer indices, `ch` an integer
// 0..31, and every track must cover all six EQ bands on both channels.

const EQ_TYPES = ["mix_eq_gain", "mix_eq_freq", "mix_eq_q"] as const;
const PARAM_TYPES = ["mix_gate_param", "mix_comp_param", "mix_exp_param"] as const;
const MASTER_TYPES = new Set([
    "mix_master_gain", "mix_limiter_enabled", "mix_limiter_ceiling", "mix_limiter_release",
]);

describe("mixer/store — seedEngineFromStore regression", () => {
    it("every eq message carries a numeric, integer band in 0..5 (no EqBand objects)", async () => {
        const { msgs } = await freshSeededStore();
        const captured = msgs();
        expect(captured.length).toBeGreaterThan(0);
        let eqCount = 0;
        for (const m of captured) {
            if ((EQ_TYPES as readonly string[]).includes(m.type as string)) {
                eqCount++;
                expect(typeof m.band).toBe("number");
                expect(Number.isInteger(m.band)).toBe(true);
                expect(m.band as number).toBeGreaterThanOrEqual(0);
                expect(m.band as number).toBeLessThanOrEqual(5);
            }
        }
        // 16 tracks × 6 bands × 3 types × 2 channels
        expect(eqCount).toBe(16 * 6 * 3 * 2);
        // Symptom check: with the bug, everything piled onto band 0 and the
        // HPF ended at the last-written 10000 Hz. Correct wiring leaves band 0
        // (HPF) at 80 Hz and band 5 (HIGH shelf) at 10000 Hz on every channel.
        const freq = (ch: number, band: number) =>
            captured.filter((m) => m.type === "mix_eq_freq" && m.ch === ch && m.band === band);
        for (let ch = 0; ch < 32; ch++) {
            const hpf = freq(ch, 0);
            expect(hpf.length).toBe(1);
            expect(hpf[0].freqHz).toBe(80);
            const high = freq(ch, 5);
            expect(high.length).toBe(1);
            expect(high[0].freqHz).toBe(10000);
        }
    });

    it("gate/comp/exp params are numeric; every ch is an integer 0..31; message accounting", async () => {
        const { msgs } = await freshSeededStore();
        const captured = msgs();
        let paramCount = 0;
        for (const m of captured) {
            if ((PARAM_TYPES as readonly string[]).includes(m.type as string)) {
                paramCount++;
                expect(typeof m.param).toBe("number");
                expect(Number.isInteger(m.param)).toBe(true);
            }
            if ("ch" in m) {
                expect(Number.isInteger(m.ch)).toBe(true);
                const ch = m.ch as number;
                expect(ch).toBeGreaterThanOrEqual(0);
                expect(ch).toBeLessThanOrEqual(31);
            } else {
                // Only master messages may omit ch.
                expect(MASTER_TYPES.has(m.type as string)).toBe(true);
            }
        }
        // 16 tracks × (5 gate + 6 comp + 4 exp) params × 2 channels
        expect(paramCount).toBe(16 * 15 * 2);
        // Full seed accounting: per track 88 messages (16 strip + 2 pan +
        // 36 eq + 2+10 gate + 2+12 comp + 2+8 exp) × 16 tracks + 4 master.
        expect(captured.length).toBe(16 * 88 + 4);
    });

    it("per track, each eq type covers exactly bands {0,1,2,3,4,5} on BOTH channels", async () => {
        const { store, msgs } = await freshSeededStore();
        const captured = msgs();
        for (const type of EQ_TYPES) {
            for (let t = 0; t < store.TRACK_COUNT; t++) {
                for (const side of [0, 1] as const) {
                    const ch = store.trackChannel(t, side);
                    const bands = captured
                        .filter((m) => m.type === type && m.ch === ch)
                        .map((m) => m.band as number)
                        .sort((a, b) => a - b);
                    expect(bands).toEqual([0, 1, 2, 3, 4, 5]);
                }
            }
        }
    });

    it("mix_pan pairing: ch=2t gets channelPans(track.pan).lPan, ch=2t+1 gets .rPan", async () => {
        const { store, msgs } = await freshSeededStore();
        const captured = msgs();
        for (let t = 0; t < store.TRACK_COUNT; t++) {
            const want = store.channelPans(store.tracks[t].pan);
            const pans = captured.filter(
                (m) => m.type === "mix_pan" && (m.ch === 2 * t || m.ch === 2 * t + 1),
            );
            expect(pans.length).toBe(2);
            const l = pans.find((m) => m.ch === 2 * t);
            const r = pans.find((m) => m.ch === 2 * t + 1);
            expect(l!.pan).toBe(want.lPan);
            expect(r!.pan).toBe(want.rPan);
        }
        // The pre-seeded non-center pans really exercise the balance math:
        // track 3 (pan +0.5) → {0, +1}; track 7 (pan −0.75) → {−1, −0.5}.
        const t3l = captured.find((m) => m.type === "mix_pan" && m.ch === 6)!;
        const t3r = captured.find((m) => m.type === "mix_pan" && m.ch === 7)!;
        expect(t3l.pan).toBe(0);
        expect(t3r.pan).toBe(1);
        const t7l = captured.find((m) => m.type === "mix_pan" && m.ch === 14)!;
        const t7r = captured.find((m) => m.type === "mix_pan" && m.ch === 15)!;
        expect(t7l.pan).toBe(-1);
        expect(t7r.pan).toBe(-0.5);
    });

    it("setEqFreq/setEqQ/setEqGain also emit a numeric integer band on both channels", async () => {
        const { store, post, msgs } = await freshSeededStore();
        post.mockClear();
        store.setEqFreq(0, 4, 1200);
        store.setEqQ(0, 2, 2.5);
        store.setEqGain(0, 5, -3);
        const captured = msgs();
        expect(captured.length).toBe(6);
        for (const m of captured) {
            expect(typeof m.band).toBe("number");
            expect(Number.isInteger(m.band)).toBe(true);
        }
        const freqMsgs = captured.filter((m) => m.type === "mix_eq_freq");
        expect(freqMsgs.map((m) => m.ch)).toEqual([0, 1]);
        expect(freqMsgs.every((m) => m.band === 4 && m.freqHz === 1200)).toBe(true);
        const qMsgs = captured.filter((m) => m.type === "mix_eq_q");
        expect(qMsgs.map((m) => m.ch)).toEqual([0, 1]);
        expect(qMsgs.every((m) => m.band === 2 && m.q === 2.5)).toBe(true);
        const gainMsgs = captured.filter((m) => m.type === "mix_eq_gain");
        expect(gainMsgs.map((m) => m.ch)).toEqual([0, 1]);
        expect(gainMsgs.every((m) => m.band === 5 && m.gainDb === -3)).toBe(true);
    });
});

// ── pushCompParams / pushGateParams / pushExpParams ──────────────────────────

describe("mixer/store — push{Comp,Gate,Exp}Params", () => {
    it("pushCompParams: 6 params × both channels, numeric indices, no other types", async () => {
        const { store, msgs } = await freshStore();
        const tr = store.tracks[3];
        store.pushCompParams(3);
        const captured = msgs();
        expect(captured.length).toBe(12);
        for (const m of captured) {
            expect(m.type).toBe("mix_comp_param");
            expect(typeof m.param).toBe("number");
            expect(Number.isInteger(m.param)).toBe(true);
        }
        for (const side of [0, 1] as const) {
            const ch = store.trackChannel(3, side);
            const byParam = new Map<number, unknown>();
            for (const m of captured) {
                if (m.ch === ch) byParam.set(m.param as number, m.value);
            }
            expect([...byParam.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
            expect(byParam.get(0)).toBe(tr.compThresholdDb);
            expect(byParam.get(1)).toBe(tr.compRatio);
            expect(byParam.get(2)).toBe(tr.compAttackMs);
            expect(byParam.get(3)).toBe(tr.compReleaseMs);
            expect(byParam.get(4)).toBe(tr.compMakeupDb);
            expect(byParam.get(5)).toBe(tr.compKneeDb);
        }
    });

    it("pushGateParams: 5 params × both channels, numeric indices, no other types", async () => {
        const { store, msgs } = await freshStore();
        const tr = store.tracks[5];
        store.pushGateParams(5);
        const captured = msgs();
        expect(captured.length).toBe(10);
        for (const m of captured) {
            expect(m.type).toBe("mix_gate_param");
            expect(typeof m.param).toBe("number");
            expect(Number.isInteger(m.param)).toBe(true);
        }
        for (const side of [0, 1] as const) {
            const ch = store.trackChannel(5, side);
            const byParam = new Map<number, unknown>();
            for (const m of captured) {
                if (m.ch === ch) byParam.set(m.param as number, m.value);
            }
            expect([...byParam.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
            expect(byParam.get(0)).toBe(tr.gateThresholdDb);
            expect(byParam.get(1)).toBe(tr.gateHysteresisDb);
            expect(byParam.get(2)).toBe(tr.gateAttackMs);
            expect(byParam.get(3)).toBe(tr.gateReleaseMs);
            expect(byParam.get(4)).toBe(tr.gateHoldMs);
        }
    });

    it("pushExpParams: 4 params × both channels, numeric indices, no other types", async () => {
        const { store, msgs } = await freshStore();
        const tr = store.tracks[9];
        store.pushExpParams(9);
        const captured = msgs();
        expect(captured.length).toBe(8);
        for (const m of captured) {
            expect(m.type).toBe("mix_exp_param");
            expect(typeof m.param).toBe("number");
            expect(Number.isInteger(m.param)).toBe(true);
        }
        for (const side of [0, 1] as const) {
            const ch = store.trackChannel(9, side);
            const byParam = new Map<number, unknown>();
            for (const m of captured) {
                if (m.ch === ch) byParam.set(m.param as number, m.value);
            }
            expect([...byParam.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
            expect(byParam.get(0)).toBe(tr.expanderThresholdDb);
            expect(byParam.get(1)).toBe(tr.expanderRatio);
            expect(byParam.get(2)).toBe(tr.expanderAttackMs);
            expect(byParam.get(3)).toBe(tr.expanderReleaseMs);
        }
    });
});

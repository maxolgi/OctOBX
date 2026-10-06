/*
 * gxfx-params.test.ts — cross-checks src/gxfx-params.ts (the GENERATED TS
 * mirror of the Guitarix FX param tables, tools/gen-gxfx-params.mjs)
 * against the source of truth tools/gxfx-param-spec.json (extracted from
 * the guitarix ttl files), and unit-tests the 0..1 ↔ engine-space
 * transforms + flat-mirror indexing.
 *
 * Pure logic — no browser, no WASM, no audio.
 */

import { describe, it, expect } from "vitest";
import spec from "../tools/gxfx-param-spec.json";
import {
    FX_COUNT,
    FX_SLOTS,
    FX_INSTANCE_COUNT,
    FX_EFFECTS,
    FX_TOTAL_PARAMS,
    fxParamFrom01,
    fxParamTo01,
    fxParamDefault01,
    fxFlatIndex,
    isFxId,
} from "../src/gxfx-params";

const PROBES = [0, 0.25, 0.5, 0.75, 1];

describe("gxfx-params — spec transcription", () => {
    it("FX_EFFECTS matches tools/gxfx-param-spec.json exactly", () => {
        expect(FX_EFFECTS.length).toBe(spec.effects.length);
        for (let i = 0; i < spec.effects.length; i++) {
            const se = spec.effects[i];
            const fe = FX_EFFECTS[i];
            expect(fe.id).toBe(se.id);
            expect(fe.key).toBe(se.key);
            expect(fe.label).toBe(se.label);
            expect(fe.stereo).toBe(se.stereo);
            expect(fe.category).toBe(se.category);
            expect(fe.params.length).toBe(se.params.length);
            for (let p = 0; p < se.params.length; p++) {
                const sp = se.params[p];
                const fp = fe.params[p];
                expect(fp.port).toBe(sp.port);
                expect(fp.symbol).toBe(sp.symbol);
                expect(fp.name).toBe(sp.name);
                expect(fp.default).toBe(sp.default);
                expect(fp.min).toBe(sp.min);
                expect(fp.max).toBe(sp.max);
                expect(fp.step).toBe(sp.step);
                expect(fp.integer ?? false).toBe(sp.integer);
            }
        }
    });

    it("spec defaults sit inside [min, max]", () => {
        for (const se of spec.effects) {
            for (const sp of se.params) {
                expect(sp.default).toBeGreaterThanOrEqual(sp.min);
                expect(sp.default).toBeLessThanOrEqual(sp.max);
            }
        }
    });
});

describe("gxfx-params — layout invariants", () => {
    it("exports the fixed slot/instance constants", () => {
        expect(FX_COUNT).toBe(76);
        expect(FX_SLOTS).toBe(11);
        expect(FX_INSTANCE_COUNT).toBe(10);
    });

    it("ids are 0..FX_COUNT-1 in manifest order; every effect has ≥1 param except the paramless autowah", () => {
        for (let i = 0; i < FX_EFFECTS.length; i++) {
            expect(FX_EFFECTS[i].id).toBe(i);
            if (FX_EFFECTS[i].key === "autowah") {
                expect(FX_EFFECTS[i].params).toHaveLength(0); // envelope-driven, no controls
            } else {
                expect(FX_EFFECTS[i].params.length).toBeGreaterThanOrEqual(1);
            }
        }
    });

    it("every effect carries its expected category", () => {
        const expected = [
            "wah",                          // 0 wah
            "drive", "drive",               // 1 overdrive, 2 distortion
            "dynamics",                     // 3 compressor
            "modulation", "modulation",     // 4 chorus, 5 flanger
            "modulation", "modulation",     // 6 phaser, 7 tremolo
            "delay", "delay",               // 8 delay, 9 echo
            "reverb",                       // 10 reverb
            // Phase 1-a drive family (11..25)
            "drive", "drive", "drive",      // fuzzface, fuzzfacefm, fumaster
            "drive", "drive", "drive",      // hornet, muff, cstb
            "drive", "drive", "drive",      // aclipper, mxrdist, rangem
            "drive", "drive", "drive",      // mole, hfb, hogsfoot
            "drive", "drive", "drive",      // softclip, bassbooster, highbooster
            // Phase 1-a dynamics family (26..27)
            "dynamics", "dynamics",         // expander, susta
            // Phase 1-b eq family (28..33)
            "eq", "eq", "eq", "eq", "eq", "eq", // graphiceq, selecteq, tonecontroll, moog, low_high_pass, noise_shaper
            // Phase 1-c wah family (34..37)
            "wah", "wah", "wah", "wah",      // wahmodel, crybaby, autowah, dunwah
            // Phase 1-d modulation family (38..44)
            "modulation", "modulation", "modulation", "modulation", // vibe, tubetremelo, tubevibrato, switched_tremolo
            "modulation", "modulation", "modulation", // phaser_st, flanger_st, chorus_mono
            // Phase 1-e time/delay family (45..56)
            "delay", "delay", "delay", "delay",       // duck_delay, duck_delay_st, digital_delay, digital_delay_st
            "delay", "delay", "delay", "delay",       // gxtape, gxtape_st, gxechocat, gxtubedelay
            "drive",                                   // ts9 (Tubescreamer — drive, not delay)
            "special",                                 // oc_2 (octave divider — special)
            "delay", "delay",                          // classic_delay, classic_echo
            // Phase 1-f reverb family (57..60)
            "reverb", "reverb", "reverb", "reverb",    // zita_rev1, freeverb, room_simulator, shimmizita
            // Phase 1-g amp + tonestack family (61..65)
            "amp",                                       // ampmodel (aggregate)
            "tonestack",                                 // tonestack (aggregate)
            "amp", "amp", "amp",                         // studiopre, alembic, w20
            // Phase 1-h multiband family (66..70)
            "multiband", "multiband", "multiband", "multiband", "multiband", // mbcompressor..barkgraphiceq
            // Phase 1-h enumeration-audit find + utility family (71..75)
            "drive",                                       // bigmuffpi (gx_bmp)
            "utility", "utility", "utility", "utility", // balance, outputlevel, ampout, ampmodul
        ];
        expect(expected.length).toBe(FX_EFFECTS.length);
        for (let i = 0; i < FX_EFFECTS.length; i++) {
            expect(FX_EFFECTS[i].category).toBe(expected[i]);
        }
    });

    it("offsets are cumulative param counts; FX_TOTAL_PARAMS === sum === 448", () => {
        let running = 0;
        for (const fx of FX_EFFECTS) {
            expect(fx.offset).toBe(running);
            running += fx.params.length;
        }
        expect(running).toBe(448);
        expect(FX_TOTAL_PARAMS).toBe(448);
    });

    it("flat mirror covers 0..FX_TOTAL_PARAMS-1 exactly once", () => {
        const seen = new Set<number>();
        for (const fx of FX_EFFECTS) {
            for (let p = 0; p < fx.params.length; p++) {
                const idx = fxFlatIndex(fx.id, p);
                expect(idx).toBe(fx.offset + p);
                expect(seen.has(idx)).toBe(false);
                seen.add(idx);
            }
        }
        expect(seen.size).toBe(FX_TOTAL_PARAMS);
        for (let i = 0; i < FX_TOTAL_PARAMS; i++) expect(seen.has(i)).toBe(true);
    });
});

describe("gxfx-params — 0..1 ↔ engine transforms", () => {
    it("endpoints map to min/max exactly; round-trips within 1e-6", () => {
        for (const fx of FX_EFFECTS) {
            for (let p = 0; p < fx.params.length; p++) {
                const def = fx.params[p];
                expect(fxParamFrom01(fx.id, p, 0)).toBe(def.min);
                expect(fxParamFrom01(fx.id, p, 1)).toBe(def.max);
                for (const probe of PROBES) {
                    const x = fxParamFrom01(fx.id, p, probe);
                    const back = fxParamFrom01(fx.id, p, fxParamTo01(fx.id, p, x));
                    expect(Math.abs(back - x)).toBeLessThan(1e-6);
                }
            }
        }
    });

    it("clamps out-of-range inputs on both directions", () => {
        for (const fx of FX_EFFECTS) {
            for (let p = 0; p < fx.params.length; p++) {
                const def = fx.params[p];
                expect(fxParamFrom01(fx.id, p, -5)).toBe(def.min);
                expect(fxParamFrom01(fx.id, p, 2)).toBe(def.max);
                expect(fxParamTo01(fx.id, p, def.min - 1000)).toBe(0);
                expect(fxParamTo01(fx.id, p, def.max + 1000)).toBe(1);
            }
        }
    });

    it("integer params snap; continuous params stay continuous", () => {
        const mode = FX_EFFECTS[7].params[1]; // tremolo Mode — integer
        expect(mode.integer).toBe(true);
        expect(fxParamFrom01(7, 1, 0.49)).toBe(0);
        expect(fxParamFrom01(7, 1, 0.51)).toBe(1);
        const wah = FX_EFFECTS[0].params[1]; // wah HOTPOTZ — continuous
        expect(wah.integer ?? false).toBe(false);
        expect(fxParamFrom01(0, 1, 0.25)).toBeCloseTo(0.25, 10);
    });

    it("fxParamDefault01 is in [0,1] and inverts back to the engine default", () => {
        for (const fx of FX_EFFECTS) {
            for (let p = 0; p < fx.params.length; p++) {
                const def = fx.params[p];
                const d01 = fxParamDefault01(fx.id, p);
                expect(d01).toBeGreaterThanOrEqual(0);
                expect(d01).toBeLessThanOrEqual(1);
                expect(fxParamFrom01(fx.id, p, d01)).toBeCloseTo(def.default, 6);
            }
        }
    });
});

describe("gxfx-params — guards", () => {
    it("isFxId accepts exactly 0..75", () => {
        for (let i = 0; i < 76; i++) expect(isFxId(i)).toBe(true);
        expect(isFxId(-1)).toBe(false);
        expect(isFxId(76)).toBe(false);
        expect(isFxId(0.5)).toBe(false);
        expect(isFxId(NaN)).toBe(false);
    });

    it("out-of-range lookups return NaN / -1 instead of throwing", () => {
        expect(fxParamFrom01(76, 0, 0.5)).toBeNaN();
        expect(fxParamTo01(-1, 0, 0.5)).toBeNaN();
        expect(fxParamDefault01(0, 99)).toBeNaN();
        expect(fxFlatIndex(0, 99)).toBe(-1);
        expect(fxFlatIndex(99, 0)).toBe(-1);
    });
});

describe("gxfx-params — Phase 1-a drive + dynamics additions", () => {
    it("fuzzface (ttl-parsed): ports/labels/ranges from gx_fuzzface.ttl, BYPASS-free", () => {
        const fx = FX_EFFECTS[11];
        expect(fx.key).toBe("fuzzface");
        expect(fx.label).toBe("Fuzz Face");
        expect(fx.stereo).toBe(false);
        expect(fx.params.map((p) => p.symbol)).toEqual(["FUZZ", "LEVEL"]);
        expect(fx.params.map((p) => p.port)).toEqual([2, 3]);
        expect(fx.params.map((p) => p.name)).toEqual(["Fuzz", "Level"]);
        expect(fx.params[0].default).toBe(0.5);
        expect(fx.params[0].min).toBe(0);
        expect(fx.params[0].max).toBe(1);
    });

    it("aclipper skips the wrapper BYPASS port and keeps the ttl default", () => {
        const fx = FX_EFFECTS[17];
        expect(fx.key).toBe("aclipper");
        expect(fx.params.map((p) => p.symbol)).toEqual(["DRIVE", "LEVEL", "TONE"]);
        expect(fx.params[1].default).toBe(-7);
        expect(fx.params[1].min).toBe(-20);
        expect(fx.params[1].max).toBe(12);
    });

    it("orphans carry connect-comment metadata (softclip, bassbooster, highbooster)", () => {
        const soft = FX_EFFECTS[23];
        expect(soft.key).toBe("softclip");
        expect(soft.params).toHaveLength(1);
        expect(soft.params[0]).toMatchObject({ port: 0, symbol: "FUZZ", default: 0, min: 0, max: 1.99, step: 0.01 });
        const bass = FX_EFFECTS[24];
        expect(bass.params[0]).toMatchObject({ port: 0, symbol: "LEVEL", default: 10, min: 0.5, max: 20, step: 0.5 });
        const high = FX_EFFECTS[25];
        expect(high.params[0]).toMatchObject({ port: 0, symbol: "LEVEL", default: 0.5, min: 0, max: 20, step: 0.5 });
    });

    it("expander (dynamics): ttl ports at indices 0..4", () => {
        const fx = FX_EFFECTS[26];
        expect(fx.key).toBe("expander");
        expect(fx.category).toBe("dynamics");
        expect(fx.params.map((p) => p.symbol)).toEqual(["RATIO", "KNEE", "THRESHOLD", "RELEASE", "ATTACK"]);
        expect(fx.params.map((p) => p.port)).toEqual([0, 1, 2, 3, 4]);
        expect(fx.params[0].default).toBe(2);
        expect(fx.params[2].default).toBe(-40);
    });
});

describe("gxfx-params — Phase 1-b eq family additions", () => {
    it("graphiceq (ttl-parsed): 11 band gains at ttl ports 0..10, mono", () => {
        const fx = FX_EFFECTS[28];
        expect(fx.key).toBe("graphiceq");
        expect(fx.label).toBe("Graphic EQ");
        expect(fx.category).toBe("eq");
        expect(fx.stereo).toBe(false);
        expect(fx.params).toHaveLength(11);
        expect(fx.params.map((p) => p.symbol)).toEqual(["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10", "G11"]);
        expect(fx.params.map((p) => p.port)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        for (const p of fx.params) {
            expect(p.default).toBe(0);
            expect(p.min).toBe(-30);
            expect(p.max).toBe(20);
        }
    });

    it("graphiceq meter outputs V1..V11 are declared out_ports, never params", () => {
        const se = spec.effects[28];
        expect(se.out_ports).toHaveLength(11);
        expect(se.out_ports.map((p) => p.symbol)).toEqual(
            ["V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8", "V9", "V10", "V11"],
        );
        expect(se.out_ports.map((p) => p.port)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
        for (const p of se.out_ports) expect(p.min).toBe(-70);
        // V ports must NOT leak into the param mirror (Phase 0 policy).
        expect(se.params.some((p) => p.symbol.startsWith("V"))).toBe(false);
    });

    it("selecteq (orphan): 30 params — Q/freq/gain per band, enum-comment ports", () => {
        const fx = FX_EFFECTS[29];
        expect(fx.key).toBe("selecteq");
        expect(fx.params).toHaveLength(30);
        // Enum order (faust comment): QS125..QS8K (10), FREQ125..FREQ8K (10), FS125..FS8K (10).
        expect(fx.params.slice(0, 10).map((p) => p.symbol)).toEqual(
            ["QS125", "QS16K", "QS1K", "QS250", "QS2K", "QS31_25", "QS4K", "QS500", "QS62_5", "QS8K"],
        );
        expect(fx.params.slice(10, 20).every((p) => p.symbol.startsWith("FREQ"))).toBe(true);
        expect(fx.params.slice(20).every((p) => p.symbol.startsWith("FS"))).toBe(true);
        expect(fx.params.map((p) => p.port)).toEqual(Array.from({ length: 30 }, (_, i) => i));
        const qs125 = fx.params[0];
        expect(qs125).toMatchObject({ default: 50, min: 1, max: 100, step: 1 });
        const freq16k = fx.params[11];
        expect(freq16k).toMatchObject({ default: 16000, min: 20, max: 20000 });
        const fs125 = fx.params[20];
        expect(fs125).toMatchObject({ default: 0, min: -50, max: 10, step: 0.1 });
        // Label overrides decode the mangled band suffixes.
        expect(qs125.name).toBe("Q 125");
        expect(freq16k.name).toBe("Freq 16k");
        expect(fs125.name).toBe("Gain 125");
    });

    it("tonecontroll + moog are stereo-path orphans; moog FR keeps ttl-scale ranges", () => {
        const tc = FX_EFFECTS[30];
        expect(tc.key).toBe("tonecontroll");
        expect(tc.stereo).toBe(true); // faust class exposes stereo_audio only
        expect(tc.params.map((p) => p.symbol)).toEqual(["BASS", "MIDDLE", "ON", "TREBLE", "SHARPER"]);
        expect(tc.params.map((p) => p.port)).toEqual([0, 1, 2, 3, 4]);
        expect(tc.params[0]).toMatchObject({ default: 0, min: -5, max: 5, step: 0.01 });

        const moog = FX_EFFECTS[31];
        expect(moog.key).toBe("moog");
        expect(moog.stereo).toBe(true);
        expect(moog.params.map((p) => p.symbol)).toEqual(["Q", "FR"]);
        expect(moog.params[0]).toMatchObject({ default: 1, min: 0, max: 4, step: 0.1 });
        expect(moog.params[1]).toMatchObject({ symbol: "FR", name: "Frequency", default: 3000, min: 440, max: 6000 });
    });

    it("low_high_pass carries both filter stages; noise_shaper is one knob", () => {
        const lhp = FX_EFFECTS[32];
        expect(lhp.key).toBe("low_high_pass");
        expect(lhp.stereo).toBe(false);
        expect(lhp.params.map((p) => p.symbol)).toEqual(
            ["HIGHFREQ", "LOWFREQ", "ONOFF", "HIGH_FREQ", "LOW_FREQ", "ON_OFF"],
        );
        expect(lhp.params.map((p) => p.port)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(lhp.params[0]).toMatchObject({ default: 5000, min: 1000, max: 12000 });
        expect(lhp.params[1]).toMatchObject({ default: 130, min: 20, max: 1000 });
        expect(lhp.params[5]).toMatchObject({ default: 0, min: 0, max: 1, step: 1 });

        const ns = FX_EFFECTS[33];
        expect(ns.key).toBe("noise_shaper");
        expect(ns.params).toHaveLength(1);
        expect(ns.params[0]).toMatchObject({ port: 0, symbol: "SHARPER", default: 1, min: 1, max: 10, step: 1 });
    });
});

describe("gxfx-params — Phase 1-c wah family additions", () => {
    it("wahmodel (ttl-parsed aggregate): WAH/FREQ/MODE/MODEL/WET_DRY at ttl ports, MODEL integer 0..6", () => {
        const fx = FX_EFFECTS[34];
        expect(fx.key).toBe("wahmodel");
        expect(fx.label).toBe("Wah Model");
        expect(fx.category).toBe("wah");
        expect(fx.stereo).toBe(false); // mono aggregate -> host runs dual-mono
        expect(fx.params.map((p) => p.symbol)).toEqual(["WAH", "FREQ", "MODE", "MODEL", "WET_DRY"]);
        expect(fx.params.map((p) => p.port)).toEqual([2, 3, 4, 5, 6]);
        expect(fx.params.map((p) => p.name)).toEqual(["Wah", "Freq", "Mode", "Model", "Dry/Wet"]);
        expect(fx.params[0]).toMatchObject({ default: 0, min: 0, max: 1 });
        expect(fx.params[1]).toMatchObject({ default: 24, min: 24, max: 360 });
        expect(fx.params[2]).toMatchObject({ default: 0, min: 0, max: 2, step: 1, integer: true });
        const model = fx.params[3];
        expect(model).toMatchObject({ default: 0, min: 0, max: 6, step: 1, integer: true });
        expect(fxParamFrom01(34, 3, 1)).toBe(6); // MODEL knob endpoint
        expect(fx.params[4]).toMatchObject({ default: 50, min: 0, max: 100 });
    });

    it("crybaby orphan: connect-comment metadata incl. the f-suffixed literals", () => {
        const fx = FX_EFFECTS[35];
        expect(fx.key).toBe("crybaby");
        expect(fx.stereo).toBe(false);
        expect(fx.params.map((p) => p.symbol)).toEqual(["LEVEL", "WAH", "WET_DRY"]);
        expect(fx.params.map((p) => p.port)).toEqual([0, 1, 2]);
        expect(fx.params[0]).toMatchObject({ default: 0.1, min: 0, max: 1, step: 0.01 });
        expect(fx.params[1]).toMatchObject({ default: 0, min: 0, max: 1, step: 0.01 });
        expect(fx.params[2]).toMatchObject({ default: 100, min: 0, max: 100, step: 1 });
    });

    it("autowah is the paramless envelope variant; dunwah carries only WAH", () => {
        const auto = FX_EFFECTS[36];
        expect(auto.key).toBe("autowah");
        expect(auto.label).toBe("Auto Wah");
        expect(auto.params).toHaveLength(0); // inline empty params — no controls
        expect(fxParamFrom01(36, 0, 0.5)).toBeNaN(); // nothing to look up
        const manual = FX_EFFECTS[37];
        expect(manual.key).toBe("dunwah");
        expect(manual.label).toBe("Classic Wah");
        expect(manual.params).toHaveLength(1);
        expect(manual.params[0]).toMatchObject({ port: 3, symbol: "WAH", name: "Wah", default: 0, min: 0, max: 1, step: 0.01 });
    });
});

describe("gxfx-params — Phase 1-d modulation family additions", () => {
    it("vibe (bundle ttl, STEREO): 8 params at wrapper/ttl ports, default FB -0.6, TEMPO 4.4", () => {
        const fx = FX_EFFECTS[38];
        expect(fx.key).toBe("vibe");
        expect(fx.label).toBe("Vibe");
        expect(fx.category).toBe("modulation");
        expect(fx.stereo).toBe(true); // plugin_stereo() — in/in1 in the ttl
        expect(fx.params.map((p) => p.symbol)).toEqual(["WIDTH", "DEPTH", "WETDRY", "FB", "TEMPO", "DF", "PAN", "CROSS"]);
        expect(fx.params.map((p) => p.port)).toEqual([0, 1, 2, 3, 4, 7, 8, 9]);
        expect(fx.params.map((p) => p.name)).toEqual(["Width", "Depth", "Dry/Wet", "Feedback", "Tempo", "L/R Phase", "Pan", "Cross"]);
        expect(fx.params[0]).toMatchObject({ default: 0.5, min: 0, max: 1 });
        expect(fx.params[3]).toMatchObject({ default: -0.6, min: -1, max: 1 });
        expect(fx.params[4]).toMatchObject({ default: 4.4, min: 0.1, max: 10 });
        expect(fx.params[5]).toMatchObject({ default: 0.11, min: -0.5, max: 0.5 });
        expect(fxParamFrom01(38, 3, 0.5)).toBe(0); // FB midpoint = 0
    });

    it("tube tremolo/vibrato (ttl): 5 params, SineWave integer 0..1; vibrato output range is ttl's 0..1", () => {
        const tt = FX_EFFECTS[39];
        expect(tt.key).toBe("tubetremelo");
        expect(tt.label).toBe("Tube Tremolo");
        expect(tt.stereo).toBe(false); // mono -> dual-mono
        expect(tt.params.map((p) => p.symbol)).toEqual(["sinewave", "depth", "speed", "drive", "output"]);
        expect(tt.params.map((p) => p.port)).toEqual([0, 1, 2, 3, 4]);
        expect(tt.params[0]).toMatchObject({ name: "Sine Wave", default: 0, min: 0, max: 1, step: 1, integer: true });
        expect(tt.params[2]).toMatchObject({ default: 3, min: 0.1, max: 14 });
        expect(tt.params[4]).toMatchObject({ default: 0, min: -20, max: 20 });
        const tv = FX_EFFECTS[40];
        expect(tv.key).toBe("tubevibrato");
        expect(tv.label).toBe("Tube Vibrato");
        expect(tv.stereo).toBe(false);
        expect(tv.params.map((p) => p.symbol)).toEqual(["sinewave", "depth", "speed", "drive", "output"]);
        // ttl ships 0..1 for the vibrato OUTPUT (upstream range change vs the
        // .cc comment's -20..20) — faithful to the ttl, per generator policy
        expect(tv.params[4]).toMatchObject({ default: 0.5, min: 0, max: 1 });
    });

    it("switched tremolo (ttl): 8 params at ttl ports 2..9", () => {
        const fx = FX_EFFECTS[41];
        expect(fx.key).toBe("switched_tremolo");
        expect(fx.label).toBe("Switched Tremolo");
        expect(fx.stereo).toBe(false);
        expect(fx.params.map((p) => p.symbol)).toEqual(["DEPTH", "FREQ0", "FREQ1", "FREQ2", "FREQ3", "STEPS", "SWITCHFREQ", "WET_DRY"]);
        expect(fx.params.map((p) => p.port)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
        expect(fx.params.map((p) => p.name)).toEqual(["Depth", "Freq 0", "Freq 1", "Freq 2", "Freq 3", "Steps", "Switch Freq", "Dry/Wet"]);
        expect(fx.params[5]).toMatchObject({ default: 4, min: 1, max: 4 });
        expect(fx.params[7]).toMatchObject({ default: 50, min: 0, max: 100 });
    });

    it("classic phaser/flanger orphans are STEREO; chorus_mono is mono — distinct from v1 ids 4/5/6", () => {
        const ph = FX_EFFECTS[42];
        expect(ph.key).toBe("phaser_st");
        expect(ph.label).toBe("Classic Phaser");
        expect(ph.stereo).toBe(true);
        expect(ph.params.map((p) => p.symbol)).toEqual([
            "MAXNOTCH1FREQ", "MINNOTCH1FREQ", "NOTCHWIDTH", "NOTCHFREQ", "SPEED",
            "VIBRATOMODE", "DEPTH", "FEEDBACKGAIN", "INVERT", "LEVEL",
        ]);
        expect(ph.params.map((p) => p.port)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(ph.params[0]).toMatchObject({ default: 800, min: 20, max: 10000, step: 1 });
        expect(ph.params[3]).toMatchObject({ default: 1.5, min: 1.1, max: 4, step: 0.01 });
        expect(ph.params[9]).toMatchObject({ default: 0, min: -60, max: 10, step: 0.1 });
        const fl = FX_EFFECTS[43];
        expect(fl.key).toBe("flanger_st");
        expect(fl.label).toBe("Classic Flanger");
        expect(fl.stereo).toBe(true);
        expect(fl.params.map((p) => p.symbol)).toEqual(["LFOFREQ", "DEPTH", "FEEDBACKGAIN", "DELAY", "DELAYOFFSET", "INVERT", "LEVEL"]);
        expect(fl.params.map((p) => p.name)).toEqual(["LFO Freq", "Depth", "Feedback Gain", "Delay", "Delay Offset", "Invert", "Level"]);
        expect(fl.params[0]).toMatchObject({ default: 0.2, min: 0, max: 5, step: 0.01 });
        expect(fl.params[3]).toMatchObject({ default: 10, min: 0, max: 20, step: 0.01 });
        const cm = FX_EFFECTS[44];
        expect(cm.key).toBe("chorus_mono");
        expect(cm.label).toBe("Chorus Mono");
        expect(cm.stereo).toBe(false);
        expect(cm.params.map((p) => p.symbol)).toEqual(["FREQ", "LEVEL", "WET_DRY"]);
        expect(cm.params.map((p) => p.port)).toEqual([0, 1, 2]);
        expect(cm.params[0]).toMatchObject({ default: 2, min: 0, max: 10, step: 0.01 });
        expect(cm.params[2]).toMatchObject({ default: 100, min: 0, max: 100, step: 1 });
        // distinctness from the v1 entries (chorus id 4 stereo, flanger id 5
        // gx_flanger class, phaser id 6 phaser_mono class)
        expect(FX_EFFECTS[5].params.map((p) => p.symbol)).not.toContain("LFOFREQ");
        expect(FX_EFFECTS[6].params).toHaveLength(3);
    });
});

describe("gxfx-params — Phase 1-e time/delay family additions", () => {
    it("duck_delay (mono) + duck_delay_st (STEREO): ttl ports, misspelled RELESE labeled Release", () => {
        const dd = FX_EFFECTS[45];
        expect(dd.key).toBe("duck_delay");
        expect(dd.label).toBe("Duck Delay");
        expect(dd.category).toBe("delay");
        expect(dd.stereo).toBe(false);
        expect(dd.params.map((p) => p.symbol)).toEqual(["AMOUNT", "ATTACK", "FEEDBACK", "RELESE", "TIME"]);
        expect(dd.params.map((p) => p.port)).toEqual([2, 3, 4, 5, 6]);
        expect(dd.params.map((p) => p.name)).toEqual(["Amount", "Attack", "Feedback", "Release", "Time"]);
        expect(dd.params[0]).toMatchObject({ default: 0.5, min: 0, max: 56 });
        expect(dd.params[4]).toMatchObject({ default: 500, min: 1, max: 2000, step: 10 });
        const ds = FX_EFFECTS[46];
        expect(ds.key).toBe("duck_delay_st");
        expect(ds.label).toBe("Duck Delay Stereo");
        expect(ds.stereo).toBe(true); // in/in1 audio pair in the ttl
        expect(ds.params.map((p) => p.symbol)).toEqual([
            "AMOUNT", "ATTACK", "COLORATION", "EFFECT", "FEEDBACK", "PINGPONG", "RELEASE", "TIME",
        ]);
        expect(ds.params.map((p) => p.port)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
        expect(ds.params[2]).toMatchObject({ name: "Coloration", default: 0, min: -1, max: 1 });
        expect(ds.params[5]).toMatchObject({ name: "Ping-Pong", default: 0, min: 0, max: 1 });
        expect(ds.params[6]).toMatchObject({ name: "Release", default: 0.1, min: 0.05, max: 2 });
    });

    it("digital_delay(.st): SYNC + HOSTBPM wrapper ports skipped; BPM labeled; HOWPASS -> Lowpass", () => {
        const dm = FX_EFFECTS[47];
        expect(dm.key).toBe("digital_delay");
        expect(dm.label).toBe("Digital Delay");
        expect(dm.stereo).toBe(false);
        expect(dm.params.map((p) => p.symbol)).toEqual([
            "BPM", "FEEDBACK", "GAIN", "HIGHPASS", "HOWPASS", "LEVEL", "MODE", "NOTES",
        ]);
        expect(dm.params.map((p) => p.port)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
        expect(dm.params.map((p) => p.name)).toEqual(["BPM", "Feedback", "Gain", "Highpass", "Lowpass", "Level", "Mode", "Notes"]);
        // no SYNC/HOSTBPM/BYPASS — wrapper-level host-tempo ports, not params
        expect(dm.params.map((p) => p.symbol)).not.toContain("SYNC");
        expect(dm.params.map((p) => p.symbol)).not.toContain("HOSTBPM");
        expect(dm.params[0]).toMatchObject({ default: 120, min: 24, max: 360 });
        expect(dm.params[4]).toMatchObject({ default: 12000, min: 20, max: 20000 });
        expect(dm.params[6]).toMatchObject({ default: 0, min: 0, max: 3, step: 1, integer: true });
        expect(dm.params[7]).toMatchObject({ default: 4, min: 0, max: 17, step: 1, integer: true });
        // DD_NOTIFY is a control OUTPUT -> out_ports (declared, unwired), never a param
        expect(dm.out_ports?.map((p) => p.symbol) ?? []).toEqual([]);
        expect((spec.effects[47].out_ports as { symbol: string }[]).map((p) => p.symbol)).toEqual(["DD_NOTIFY"]);
        const ds = FX_EFFECTS[48];
        expect(ds.key).toBe("digital_delay_st");
        expect(ds.stereo).toBe(true);
        expect(ds.params.map((p) => p.port)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
        expect(ds.params.map((p) => p.symbol)).not.toContain("SYNC");
    });

    it("gxtape(.st): 10 params at ttl ports 0..9, camel-case symbols humanized; meterlevel stays an out_port", () => {
        const t = FX_EFFECTS[49];
        expect(t.key).toBe("gxtape");
        expect(t.label).toBe("Tape");
        expect(t.stereo).toBe(false);
        expect(t.params.map((p) => p.symbol)).toEqual([
            "on", "drive", "wowdepth", "wowfreq", "flutdepth", "flutfreq", "hiss", "type", "speed", "gain",
        ]);
        expect(t.params.map((p) => p.name)).toEqual([
            "On", "Drive", "Wow Depth", "Wow Freq", "Flutter Depth", "Flutter Freq", "Tape Hiss", "Tape Type", "Speed", "Gain",
        ]);
        expect(t.params.map((p) => p.port)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(t.params[0]).toMatchObject({ default: 1, min: 0, max: 1 });
        expect(t.params[2]).toMatchObject({ default: 0.02, min: 0, max: 0.03, step: 0.01 });
        expect(t.params[6]).toMatchObject({ default: 0.4, min: 0, max: 1 });
        const ts = FX_EFFECTS[50];
        expect(ts.key).toBe("gxtape_st");
        expect(ts.label).toBe("Tape Stereo");
        expect(ts.stereo).toBe(true); // outl/outr + inl/inr audio pairs
        expect(ts.params).toHaveLength(10);
        expect((spec.effects[49].out_ports as { symbol: string }[]).map((p) => p.symbol)).toEqual(["meterlevel"]);
    });

    it("gxechocat + gxtubedelay: circuit-table classes with ttl-faithful ports", () => {
        const ec = FX_EFFECTS[51];
        expect(ec.key).toBe("gxechocat");
        expect(ec.label).toBe("Echo Cat");
        expect(ec.stereo).toBe(false);
        expect(ec.params.map((p) => p.symbol)).toEqual([
            "input", "swell", "sustain", "output", "bpm", "head1", "head2", "head3",
        ]);
        expect(ec.params.map((p) => p.name)).toEqual([
            "Input", "Swell", "Sustain", "Output", "BPM", "Head 1", "Head 2", "Head 3",
        ]);
        expect(ec.params.map((p) => p.port)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(ec.params[0]).toMatchObject({ default: 0.25, min: 0, max: 1 });
        expect(ec.params[3]).toMatchObject({ default: 1, min: 0, max: 4 }); // ttl max (the .cc comment says 2 — ttl wins)
        expect(ec.params[4]).toMatchObject({ default: 120, min: 24, max: 360 });
        const td = FX_EFFECTS[52];
        expect(td.key).toBe("gxtubedelay");
        expect(td.label).toBe("Tube Delay");
        expect(td.stereo).toBe(false);
        expect(td.params.map((p) => p.symbol)).toEqual(["drive", "delay", "feedback", "level", "output"]);
        expect(td.params.map((p) => p.port)).toEqual([0, 1, 2, 3, 4]);
        expect(td.params[1]).toMatchObject({ default: 160, min: 1, max: 2500 });
        expect(td.params[2]).toMatchObject({ default: 0.35, min: 0.01, max: 0.7 });
    });

    it("ts9 (category DRIVE) + oc_2 (category SPECIAL): bundle-local circuit classes", () => {
        const ts = FX_EFFECTS[53];
        expect(ts.key).toBe("ts9");
        expect(ts.label).toBe("TS-9");
        expect(ts.category).toBe("drive"); // Tubescreamer = drive, not delay
        expect(ts.stereo).toBe(false);
        expect(ts.params.map((p) => p.symbol)).toEqual(["fslider0_", "fslider1_", "fslider2_"]);
        expect(ts.params.map((p) => p.name)).toEqual(["Level", "Tone", "Drive"]);
        expect(ts.params.map((p) => p.port)).toEqual([0, 1, 2]);
        expect(ts.params[0]).toMatchObject({ default: -16, min: -20, max: 4, step: 0.1 });
        expect(ts.params[1]).toMatchObject({ default: 400, min: 100, max: 1000, step: 10 });
        expect(ts.params[2]).toMatchObject({ default: 0.5, min: 0, max: 1, step: 0.01 });
        const oc = FX_EFFECTS[54];
        expect(oc.key).toBe("oc_2");
        expect(oc.label).toBe("OC-2 Octave");
        expect(oc.category).toBe("special"); // octaver — no pitch category in the vocabulary
        expect(oc.stereo).toBe(false);
        expect(oc.params.map((p) => p.symbol)).toEqual(["DIRECT", "OCTAVE1", "OCTAVE2"]);
        expect(oc.params.map((p) => p.name)).toEqual(["Direct", "Octave 1", "Octave 2"]);
        expect(oc.params.map((p) => p.port)).toEqual([2, 3, 4]);
        expect(oc.params[0]).toMatchObject({ default: 0.5, min: 0, max: 1 });
    });

    it("classic delay/echo orphans: mono 2-param classes, distinct from v1 stereo ids 8/9", () => {
        const cd = FX_EFFECTS[55];
        expect(cd.key).toBe("classic_delay");
        expect(cd.label).toBe("Classic Delay");
        expect(cd.category).toBe("delay");
        expect(cd.stereo).toBe(false);
        expect(cd.params.map((p) => p.symbol)).toEqual(["DELAY", "GAIN"]);
        expect(cd.params.map((p) => p.port)).toEqual([0, 1]);
        expect(cd.params[0]).toMatchObject({ name: "Delay", default: 0, min: 0, max: 5000, step: 10 });
        expect(cd.params[1]).toMatchObject({ name: "Gain", default: 0, min: -20, max: 20, step: 0.1 });
        const ce = FX_EFFECTS[56];
        expect(ce.key).toBe("classic_echo");
        expect(ce.label).toBe("Classic Echo");
        expect(ce.stereo).toBe(false);
        expect(ce.params.map((p) => p.symbol)).toEqual(["PERCENT", "TIME"]);
        expect(ce.params.map((p) => p.name)).toEqual(["Wet %", "Time"]);
        expect(ce.params[0]).toMatchObject({ default: 0, min: 0, max: 100, step: 0.1 });
        expect(ce.params[1]).toMatchObject({ default: 1, min: 1, max: 2000, step: 1 });
        // v1 id 8/9 keep their stereo stereodelay/stereoecho identity
        expect(FX_EFFECTS[8].key).toBe("delay");
        expect(FX_EFFECTS[8].stereo).toBe(true);
        expect(FX_EFFECTS[9].key).toBe("echo");
        expect(FX_EFFECTS[9].stereo).toBe(true);
    });
});

describe("gxfx-params — Phase 1-f reverb family additions", () => {
    it("zita_rev1 (ttl, STEREO): 11 params at ttl ports 0..10 — distinct from v1 id 10 stereoverb", () => {
        const fx = FX_EFFECTS[57];
        expect(fx.key).toBe("zita_rev1");
        expect(fx.label).toBe("Zita Reverb");
        expect(fx.category).toBe("reverb");
        expect(fx.stereo).toBe(true);
        expect(fx.params.map((p) => p.symbol)).toEqual([
            "level", "EQ2_FREQ", "EQ1_LEVEL", "EQ1_FREQ", "IN_DELAY",
            "LOW_RT60", "LF_X", "HF_DAMPING", "MID_RT60", "DRY_WET_MIX", "EQ2_LEVEL",
        ]);
        expect(fx.params.map((p) => p.port)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        expect(fx.params.map((p) => p.name)).toEqual([
            "Level", "EQ2 Freq", "EQ1 Level", "EQ1 Freq", "Predelay",
            "Low RT60", "LF X", "HF Damping", "Mid RT60", "Dry/Wet Mix", "EQ2 Level",
        ]);
        expect(fx.params[0]).toMatchObject({ default: 0, min: -60, max: 4, step: 1 });
        expect(fx.params[4]).toMatchObject({ default: 60, min: 20, max: 100, step: 1 }); // IN_DELAY ms
        expect(fx.params[9]).toMatchObject({ default: 0, min: -1, max: 1, step: 0.01 }); // DRY_WET_MIX
        // v1 id 10 keeps its stereoverb identity ("Reverb", 5 ttl-pinned params)
        expect(FX_EFFECTS[10].key).toBe("reverb");
        expect(FX_EFFECTS[10].label).toBe("Reverb");
        expect(FX_EFFECTS[10].params.length).toBe(5);
    });

    it("freeverb orphan: connect-comment metadata, WET_DRY shares the global Dry/Wet label", () => {
        const fx = FX_EFFECTS[58];
        expect(fx.key).toBe("freeverb");
        expect(fx.label).toBe("Freeverb");
        expect(fx.category).toBe("reverb");
        expect(fx.stereo).toBe(false);
        expect(fx.params.map((p) => p.symbol)).toEqual(["ROOMSIZE", "DAMP", "WET_DRY"]);
        expect(fx.params.map((p) => p.name)).toEqual(["Room Size", "Damping", "Dry/Wet"]);
        expect(fx.params.map((p) => p.port)).toEqual([0, 1, 2]);
        expect(fx.params[0]).toMatchObject({ default: 0.5, min: 0, max: 1, step: 0.025 });
        expect(fx.params[1]).toMatchObject({ default: 0.5, min: 0, max: 1, step: 0.025 });
        expect(fx.params[2]).toMatchObject({ default: 50, min: 0, max: 100, step: 1 });
    });

    it("room_simulator (bundle-local, mono): ttl ports 2..6; shimmizita (bundle-local, STEREO): ports 4..15", () => {
        const room = FX_EFFECTS[59];
        expect(room.key).toBe("room_simulator");
        expect(room.label).toBe("Room Simulator");
        expect(room.category).toBe("reverb");
        expect(room.stereo).toBe(false);
        expect(room.params.map((p) => p.symbol)).toEqual(["EFFECT", "PREDELAYMS", "RT", "ROOMSIZE", "DRYWET"]);
        expect(room.params.map((p) => p.port)).toEqual([2, 3, 4, 5, 6]);
        expect(room.params.map((p) => p.name)).toEqual(["Effect", "Predelay Ms", "Decay", "Room Size", "Dry/Wet"]);
        expect(room.params[0]).toMatchObject({ default: 1, min: 0, max: 1, step: 0.01 }); // on/off checkbox
        expect(room.params[1]).toMatchObject({ default: 20, min: 1, max: 200, step: 1 });
        expect(room.params[3]).toMatchObject({ default: 1, min: 0, max: 3, step: 0.01 });
        const shim = FX_EFFECTS[60];
        expect(shim.key).toBe("shimmizita");
        expect(shim.label).toBe("Shimmizita");
        expect(shim.category).toBe("reverb");
        expect(shim.stereo).toBe(true);
        expect(shim.params.map((p) => p.symbol)).toEqual([
            "CONTROL", "DEPTH", "DRYWET", "ENVELOPE", "F1", "F2",
            "MODE", "PSDRYWET", "SHIFT", "SPEED", "T60DS", "T60M",
        ]);
        expect(shim.params.map((p) => p.port)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
        expect(shim.params.map((p) => p.name)).toEqual([
            "Env Control", "Depth", "Dry/Wet", "Envelope", "F1", "F2",
            "Mode", "Pitch Dry/Wet", "Pitch Shift", "Speed", "T60 Low", "T60 Mid",
        ]);
        expect(shim.params[8]).toMatchObject({ default: 0, min: -6, max: 6, step: 0.1 }); // SHIFT semitones
        expect(shim.params[10]).toMatchObject({ default: 3, min: 1, max: 8, step: 0.1 }); // T60DS sec
        expect(shim.params[9]).toMatchObject({ default: 0.1, min: 0.1, max: 10, step: 0.1 }); // SPEED
    });
});

describe("gxfx-params — Phase 1-g amp + tonestack family additions", () => {
    it("ampmodel (ttl with skipPorts, mono aggregate): amp-model params only + MODEL — tonestack/cab/trim ports dropped", () => {
        const fx = FX_EFFECTS[61];
        expect(fx.key).toBe("ampmodel");
        expect(fx.label).toBe("Amp Model");
        expect(fx.category).toBe("amp");
        expect(fx.stereo).toBe(false);
        expect(fx.params.map((p) => p.symbol)).toEqual([
            "MasterGain", "PreGain", "Distortion", "Drive", "model", "HIGHGAIN",
        ]);
        expect(fx.params.map((p) => p.port)).toEqual([0, 1, 2, 3, 9, 18]);
        expect(fx.params.map((p) => p.name)).toEqual([
            "Master Gain", "Pre Gain", "Distortion", "Drive", "Model", "High Gain",
        ]);
        expect(fx.params[0]).toMatchObject({ default: 0, min: -20, max: 20, step: 1 });
        expect(fx.params[2]).toMatchObject({ default: 20, min: 1, max: 100, step: 1 });
        expect(fx.params[3]).toMatchObject({ default: 0.25, min: 0.01, max: 1, step: 0.01 });
        expect(fx.params[4]).toMatchObject({ default: 0, min: 0, max: 18, step: 1, integer: true });
        expect(fx.params[5]).toMatchObject({ default: 0, min: 0, max: 1, step: 1 }); // toggled
    });

    it("tonestack (inline params, STEREO aggregate): Bass/Middle/Treble at gx_amp wrapper ports + MODEL 0..26", () => {
        const fx = FX_EFFECTS[62];
        expect(fx.key).toBe("tonestack");
        expect(fx.label).toBe("Tone Stack");
        expect(fx.category).toBe("tonestack");
        expect(fx.stereo).toBe(true);
        expect(fx.params.map((p) => p.symbol)).toEqual(["Middle", "Bass", "Treble", "Model"]);
        expect(fx.params.map((p) => p.port)).toEqual([4, 5, 6, 10]);
        expect(fx.params.map((p) => p.name)).toEqual(["Middle", "Bass", "Treble", "Model"]);
        expect(fx.params[0]).toMatchObject({ default: 0.5, min: 0, max: 1, step: 0.01 });
        expect(fx.params[3]).toMatchObject({ default: 0, min: 0, max: 26, step: 1, integer: true });
    });

    it("preamps: studiopre (STEREO variant, 12 L/R params), alembic (5), w20 (2)", () => {
        const pre = FX_EFFECTS[63];
        expect(pre.key).toBe("studiopre");
        expect(pre.label).toBe("Studio Pre");
        expect(pre.category).toBe("amp");
        expect(pre.stereo).toBe(true);
        expect(pre.params.map((p) => p.symbol)).toEqual([
            "bright_l", "volume_l", "bass_l", "middle_l", "treble_l", "master_l",
            "bright_r", "volume_r", "bass_r", "middle_r", "treble_r", "master_r",
        ]);
        expect(pre.params.map((p) => p.port)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
        expect(pre.params.map((p) => p.name)).toEqual([
            "Bright L", "Volume L", "Bass L", "Middle L", "Treble L", "Master L",
            "Bright R", "Volume R", "Bass R", "Middle R", "Treble R", "Master R",
        ]);
        expect(pre.params[0]).toMatchObject({ default: 0, min: 0, max: 1, step: 1 }); // toggled bright
        expect(pre.params[5]).toMatchObject({ default: 0.5, min: 0, max: 1, step: 0.01 });

        const ale = FX_EFFECTS[64];
        expect(ale.key).toBe("alembic");
        expect(ale.label).toBe("Alembic Pre");
        expect(ale.category).toBe("amp");
        expect(ale.stereo).toBe(false);
        expect(ale.params.map((p) => p.symbol)).toEqual(["input", "bass", "middle", "treble", "volume"]);
        expect(ale.params.map((p) => p.port)).toEqual([0, 1, 2, 3, 4]);
        expect(ale.params[0]).toMatchObject({ default: 0.5, min: 0, max: 1, step: 0.01 });

        const w20 = FX_EFFECTS[65];
        expect(w20.key).toBe("w20");
        expect(w20.label).toBe("W20 Pre");
        expect(w20.category).toBe("amp");
        expect(w20.stereo).toBe(false);
        expect(w20.params.map((p) => p.symbol)).toEqual(["gain", "level"]);
        expect(w20.params.map((p) => p.port)).toEqual([0, 1]);
        expect(w20.params[0]).toMatchObject({ default: 0.5, min: 0, max: 1, step: 0.01 });
        expect(w20.params[1]).toMatchObject({ default: 0.5, min: 0, max: 1, step: 0.01 });
    });
});

describe("gxfx-params — Phase 1-h multiband + utility family additions", () => {
    it("mbcompressor (ttl, mono): 34 params in ttl port order, 10 meter OUT ports kept out of the mirror", () => {
        const fx = FX_EFFECTS[66];
        expect(fx.key).toBe("mbcompressor");
        expect(fx.label).toBe("MB Compressor");
        expect(fx.category).toBe("multiband");
        expect(fx.stereo).toBe(false);
        expect(fx.params).toHaveLength(34); // tree's 2nd-largest effect (livelooper is 39)
        expect(fx.params.slice(0, 5).map((p) => p.symbol)).toEqual(["MODE1", "MODE2", "MODE3", "MODE4", "MODE5"]);
        expect(fx.params.slice(0, 5).map((p) => p.name)).toEqual(["Mode 1", "Mode 2", "Mode 3", "Mode 4", "Mode 5"]);
        expect(fx.params[15]).toMatchObject({ port: 15, symbol: "RATIO1", default: 13, min: 1, max: 100 });
        expect(fx.params[20]).toMatchObject({ symbol: "ATTACK1", default: 0.012, min: 0.001, max: 1, step: 0.01 });
        expect(fx.params[30]).toMatchObject({ port: 30, symbol: "CROSSOVER_B1_B2", name: "Crossover B1/B2", default: 80, min: 20, max: 20000 });
        expect(fx.params[0]).toMatchObject({ integer: true, step: 1 }); // lv2:integer MODE
        // Meters are declared as spec out_ports (graphiceq precedent), never params.
        const specFx = spec.effects[66];
        expect(specFx.out_ports.map((p) => p.symbol)).toEqual(["V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8", "V9", "V10"]);
        expect(fx.params.some((p) => p.symbol.startsWith("V"))).toBe(false);
    });

    it("mbdelay/mbdistortion/mbecho: ttl ports; shared crossover labels; per-band params", () => {
        const del = FX_EFFECTS[67];
        expect(del.key).toBe("mbdelay");
        expect(del.params).toHaveLength(19);
        expect(del.params.map((p) => p.symbol)).toEqual([
            "DELAY1", "DELAY2", "DELAY3", "DELAY4", "DELAY5",
            "FEEDBACK1", "FEEDBACK2", "FEEDBACK3", "FEEDBACK4", "FEEDBACK5",
            "GAIN1", "GAIN2", "GAIN3", "GAIN4", "GAIN5",
            "CROSSOVER_B1_B2", "CROSSOVER_B2_B3", "CROSSOVER_B3_B4", "CROSSOVER_B4_B5",
        ]);
        expect(del.params[0]).toMatchObject({ default: 30, min: 24, max: 360 });
        expect(spec.effects[67].out_ports).toHaveLength(5);

        const dist = FX_EFFECTS[68];
        expect(dist.key).toBe("mbdistortion");
        expect(dist.params).toHaveLength(15);
        expect(dist.params[5]).toMatchObject({ symbol: "GAIN", default: -15, min: -40, max: 4 });
        expect(dist.params[6]).toMatchObject({ symbol: "OFFSET1", default: 0.17, min: 0, max: 0.5, step: 0.01 });
        expect(spec.effects[68].out_ports).toHaveLength(5);

        const echo = FX_EFFECTS[69];
        expect(echo.key).toBe("mbecho");
        expect(echo.params).toHaveLength(14);
        expect(echo.params.slice(0, 5).map((p) => p.name)).toEqual(["Wet 1", "Wet 2", "Wet 3", "Wet 4", "Wet 5"]);
        expect(echo.params[5]).toMatchObject({ symbol: "TIME1", default: 30, min: 24, max: 360 });
        expect(spec.effects[69].out_ports).toHaveLength(5);
    });

    it("barkgraphiceq (bundle-local dsp, mono): 24 band gains G1..G24, 24 meter OUT ports, labels consistent with graphiceq", () => {
        const fx = FX_EFFECTS[70];
        expect(fx.key).toBe("barkgraphiceq");
        expect(fx.label).toBe("Bark Graphic EQ");
        expect(fx.category).toBe("multiband");
        expect(fx.stereo).toBe(false);
        expect(fx.params).toHaveLength(24);
        expect(fx.params.map((p) => p.symbol)).toEqual(Array.from({ length: 24 }, (_, i) => `G${i + 1}`));
        // NO G overrides: graphiceq id 28 pins "G1".."G11" — bark stays consistent.
        expect(fx.params.map((p) => p.name)).toEqual(Array.from({ length: 24 }, (_, i) => `G${i + 1}`));
        expect(fx.params[0]).toMatchObject({ default: 0, min: -30, max: 20 });
        expect(spec.effects[70].out_ports).toHaveLength(24);
        expect(spec.effects[70].out_ports.map((p) => p.symbol)).toEqual(Array.from({ length: 24 }, (_, i) => `V${i + 1}`));
    });

    it("utility orphans: balance/outputlevel (native stereo), ampout (mono), ampmodul (7 params)", () => {
        const bmp = FX_EFFECTS[71];
        expect(bmp.key).toBe("bigmuffpi");
        expect(bmp.label).toBe("Big Muff Pi");
        expect(bmp.category).toBe("drive");
        expect(bmp.stereo).toBe(false);
        expect(bmp.params.map((p) => p.symbol)).toEqual(["SUSTAIN", "TONE", "VOLUME"]);
        expect(bmp.params.map((p) => p.name)).toEqual(["Sustain", "Tone", "Volume"]);
        expect(bmp.params.map((p) => p.port)).toEqual([2, 3, 4]); // audio ports first in the wrapper enum
        expect(bmp.params.every((p) => p.default === 0.5 && p.min === 0 && p.max === 1)).toBe(true);
        expect(spec.effects[71].out_ports).toEqual([]);

        const bal = FX_EFFECTS[72];
        expect(bal.key).toBe("balance");
        expect(bal.category).toBe("utility");
        expect(bal.stereo).toBe(true); // stereo_audio only — override, not dual-mono
        expect(bal.params).toEqual([{ port: 0, symbol: "BALANCE", name: "Balance", default: 0, min: -1, max: 1, step: 0.1 }]);

        const lvl = FX_EFFECTS[73];
        expect(lvl.key).toBe("outputlevel");
        expect(lvl.label).toBe("Output Level");
        expect(lvl.stereo).toBe(true);
        expect(lvl.params[0]).toMatchObject({ port: 0, symbol: "OUT_MASTER", name: "Level", default: 0, min: -50, max: 4, step: 0.1 });

        const amp = FX_EFFECTS[74];
        expect(amp.key).toBe("ampout");
        expect(amp.stereo).toBe(false); // mono_audio — dual-mono host
        expect(amp.params[0]).toMatchObject({ port: 0, symbol: "OUT_AMP", name: "Level", default: 0, min: -20, max: 4, step: 0.1 });

        const mod = FX_EFFECTS[75];
        expect(mod.key).toBe("ampmodul");
        expect(mod.label).toBe("Postamp");
        expect(mod.category).toBe("utility");
        expect(mod.stereo).toBe(true);
        expect(mod.params.map((p) => p.symbol)).toEqual(["FEEDBAC", "FEEDBACK", "LEVEL", "HIGHGAIN", "TUBE1", "TUBE2", "WET_DRY"]);
        expect(mod.params.map((p) => p.name)).toEqual(["Dry Feedback", "Feedback", "Level", "High Gain", "Tube 1", "Tube 2", "Dry/Wet"]);
        expect(mod.params[0]).toMatchObject({ default: 0, min: -1, max: 1, step: 0.01 });
        expect(mod.params[2]).toMatchObject({ default: -20, min: -40, max: 4, step: 0.1 });
        expect(mod.params[4]).toMatchObject({ default: 6, min: -20, max: 20, step: 0.1 });
    });
});

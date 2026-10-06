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
        expect(FX_COUNT).toBe(38);
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
        ];
        expect(expected.length).toBe(FX_EFFECTS.length);
        for (let i = 0; i < FX_EFFECTS.length; i++) {
            expect(FX_EFFECTS[i].category).toBe(expected[i]);
        }
    });

    it("offsets are cumulative param counts; FX_TOTAL_PARAMS === sum === 151", () => {
        let running = 0;
        for (const fx of FX_EFFECTS) {
            expect(fx.offset).toBe(running);
            running += fx.params.length;
        }
        expect(running).toBe(151);
        expect(FX_TOTAL_PARAMS).toBe(151);
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
    it("isFxId accepts exactly 0..37", () => {
        for (let i = 0; i < 38; i++) expect(isFxId(i)).toBe(true);
        expect(isFxId(-1)).toBe(false);
        expect(isFxId(38)).toBe(false);
        expect(isFxId(0.5)).toBe(false);
        expect(isFxId(NaN)).toBe(false);
    });

    it("out-of-range lookups return NaN / -1 instead of throwing", () => {
        expect(fxParamFrom01(38, 0, 0.5)).toBeNaN();
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

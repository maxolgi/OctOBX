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
        expect(FX_COUNT).toBe(28);
        expect(FX_SLOTS).toBe(11);
        expect(FX_INSTANCE_COUNT).toBe(10);
    });

    it("ids are 0..FX_COUNT-1 in manifest order and every effect has ≥1 param", () => {
        for (let i = 0; i < FX_EFFECTS.length; i++) {
            expect(FX_EFFECTS[i].id).toBe(i);
            expect(FX_EFFECTS[i].params.length).toBeGreaterThanOrEqual(1);
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
        ];
        expect(expected.length).toBe(FX_EFFECTS.length);
        for (let i = 0; i < FX_EFFECTS.length; i++) {
            expect(FX_EFFECTS[i].category).toBe(expected[i]);
        }
    });

    it("offsets are cumulative param counts; FX_TOTAL_PARAMS === sum === 87", () => {
        let running = 0;
        for (const fx of FX_EFFECTS) {
            expect(fx.offset).toBe(running);
            running += fx.params.length;
        }
        expect(running).toBe(87);
        expect(FX_TOTAL_PARAMS).toBe(87);
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
    it("isFxId accepts exactly 0..27", () => {
        for (let i = 0; i < 28; i++) expect(isFxId(i)).toBe(true);
        expect(isFxId(-1)).toBe(false);
        expect(isFxId(28)).toBe(false);
        expect(isFxId(0.5)).toBe(false);
        expect(isFxId(NaN)).toBe(false);
    });

    it("out-of-range lookups return NaN / -1 instead of throwing", () => {
        expect(fxParamFrom01(28, 0, 0.5)).toBeNaN();
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

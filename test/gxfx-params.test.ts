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
        expect(FX_COUNT).toBe(11);
        expect(FX_SLOTS).toBe(11);
        expect(FX_INSTANCE_COUNT).toBe(10);
    });

    it("ids are 0..10 in canonical order and every effect has ≥1 param", () => {
        for (let i = 0; i < FX_EFFECTS.length; i++) {
            expect(FX_EFFECTS[i].id).toBe(i);
            expect(FX_EFFECTS[i].params.length).toBeGreaterThanOrEqual(1);
        }
    });

    it("every effect carries its expected v2 category", () => {
        const expected = [
            "wah",                          // 0 wah
            "drive", "drive",               // 1 overdrive, 2 distortion
            "dynamics",                     // 3 compressor
            "modulation", "modulation",     // 4 chorus, 5 flanger
            "modulation", "modulation",     // 6 phaser, 7 tremolo
            "delay", "delay",               // 8 delay, 9 echo
            "reverb",                       // 10 reverb
        ];
        expect(expected.length).toBe(FX_EFFECTS.length);
        for (let i = 0; i < FX_EFFECTS.length; i++) {
            expect(FX_EFFECTS[i].category).toBe(expected[i]);
        }
    });

    it("offsets are cumulative param counts; FX_TOTAL_PARAMS === sum === 47", () => {
        let running = 0;
        for (const fx of FX_EFFECTS) {
            expect(fx.offset).toBe(running);
            running += fx.params.length;
        }
        expect(running).toBe(47);
        expect(FX_TOTAL_PARAMS).toBe(47);
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
    it("isFxId accepts exactly 0..10", () => {
        for (let i = 0; i < 11; i++) expect(isFxId(i)).toBe(true);
        expect(isFxId(-1)).toBe(false);
        expect(isFxId(11)).toBe(false);
        expect(isFxId(0.5)).toBe(false);
        expect(isFxId(NaN)).toBe(false);
    });

    it("out-of-range lookups return NaN / -1 instead of throwing", () => {
        expect(fxParamFrom01(11, 0, 0.5)).toBeNaN();
        expect(fxParamTo01(-1, 0, 0.5)).toBeNaN();
        expect(fxParamDefault01(0, 99)).toBeNaN();
        expect(fxFlatIndex(0, 99)).toBe(-1);
        expect(fxFlatIndex(99, 0)).toBe(-1);
    });
});

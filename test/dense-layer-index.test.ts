/*
 * dense-layer-index.test.ts — dense layer indexing for the PCM drum engine.
 *
 * The C engine addresses pcmBank[pad][dense] where dense packs played
 * (enabled + sampled) layers at 0, 1, 2, …; setNoteOn iterates
 * 0..pcmLayerCount-1 and never sees sparse indices. The TS side must
 * translate sparse layer positions (0..3 in DrumPad.layers[]) to dense
 * before sending any layer-targeted message. denseIndexOf() in
 * src/drum-state.ts is the single source of truth, shared by the UI
 * (drum-rack.ts) and the kit-load packing loop (drum-audio.ts).
 *
 * A wrong translation is silent: the write lands in a valid pcmBank slot
 * belonging to a different layer. These tests pin the mapping for every
 * possible pad configuration and across enable/disable transitions.
 *
 * Pure logic — no browser, no WASM.
 */

import { describe, it, expect } from "vitest";
import {
    createDefaultLayer,
    createDefaultPad,
    denseIndexOf,
    isLayerPlayed,
    type DrumLayer,
    type DrumPad,
} from "../src/drum-state";

function makeLayer(enabled: boolean, sampleName: string | null): DrumLayer {
    const l = createDefaultLayer();
    l.enabled = enabled;
    l.sampleName = sampleName;
    return l;
}

// played[i] = layer i is in the played set; sampleless[i] = layer i has no
// sample name (overrides played, matching isLayerPlayed semantics).
function makePad(played: boolean[], sampleless: number[] = []): DrumPad {
    const pad = createDefaultPad("Test", 36);
    pad.layers = [0, 1, 2, 3].map((i) =>
        makeLayer(played[i], sampleless.includes(i) ? null : `s${i}`)
    ) as DrumPad["layers"];
    return pad;
}

describe("isLayerPlayed", () => {
    it("true when enabled with a sample", () => {
        expect(isLayerPlayed(makeLayer(true, "kick.wav"))).toBe(true);
    });

    it("false when disabled, even with a sample", () => {
        expect(isLayerPlayed(makeLayer(false, "kick.wav"))).toBe(false);
    });

    it("false when enabled but sampleless (null or empty)", () => {
        expect(isLayerPlayed(makeLayer(true, null))).toBe(false);
        expect(isLayerPlayed(makeLayer(true, ""))).toBe(false);
    });
});

describe("denseIndexOf — exhaustive over all 16 pad configurations", () => {
    for (let mask = 0; mask < 16; mask++) {
        const played = [0, 1, 2, 3].map((i) => ((mask >> i) & 1) === 1);
        it(`mask ${mask.toString(2).padStart(4, "0")}`, () => {
            const pad = makePad(played);
            const denseValues: number[] = [];
            for (let sparse = 0; sparse < 4; sparse++) {
                if (played[sparse]) {
                    const expected = played.slice(0, sparse).filter(Boolean).length;
                    expect(denseIndexOf(pad, sparse)).toBe(expected);
                    denseValues.push(denseIndexOf(pad, sparse));
                } else {
                    expect(denseIndexOf(pad, sparse)).toBe(-1);
                }
            }
            // Played layers must occupy exactly the dense slots 0..count-1,
            // each once — the same packing loadDrumKitImpl performs.
            const count = played.filter(Boolean).length;
            expect([...denseValues].sort((a, b) => a - b))
                .toEqual(Array.from({ length: count }, (_, i) => i));
        });
    }
});

describe("denseIndexOf — sampleless layers are out of the played set", () => {
    it("enabled but sampleless layers are skipped and shift the mapping", () => {
        // L0, L2, L3 played; L1 enabled but sampleless
        const pad = makePad([true, true, true, true], [1]);
        expect(denseIndexOf(pad, 0)).toBe(0);
        expect(denseIndexOf(pad, 1)).toBe(-1);
        expect(denseIndexOf(pad, 2)).toBe(1);
        expect(denseIndexOf(pad, 3)).toBe(2);
    });

    it("all layers sampleless → all -1", () => {
        const pad = makePad([true, true, true, true], [0, 1, 2, 3]);
        for (let i = 0; i < 4; i++) expect(denseIndexOf(pad, i)).toBe(-1);
    });
});

describe("denseIndexOf — enable/disable transitions renumber", () => {
    it("disabling a lower layer shifts the dense indices above it", () => {
        const pad = makePad([true, true, true, true]);
        expect(denseIndexOf(pad, 2)).toBe(2);
        pad.layers[0].enabled = false;
        expect(denseIndexOf(pad, 0)).toBe(-1);
        expect(denseIndexOf(pad, 1)).toBe(0);
        expect(denseIndexOf(pad, 2)).toBe(1);
        expect(denseIndexOf(pad, 3)).toBe(2);
    });

    it("removing a sample shifts the mapping; re-adding restores it", () => {
        const pad = makePad([true, true, true, true]);
        pad.layers[1].sampleName = null;
        expect(denseIndexOf(pad, 2)).toBe(1);
        pad.layers[0].enabled = false;
        expect(denseIndexOf(pad, 2)).toBe(0);
        pad.layers[1].sampleName = "s1";
        pad.layers[0].enabled = true;
        expect(denseIndexOf(pad, 2)).toBe(2);
    });
});

describe("denseIndexOf — out-of-range sparse indices", () => {
    it("returns -1 for indices past the 4-layer array", () => {
        const pad = makePad([true, true, true, true]);
        expect(denseIndexOf(pad, 4)).toBe(-1);
        expect(denseIndexOf(pad, -1)).toBe(-1);
        expect(denseIndexOf(pad, 99)).toBe(-1);
    });
});

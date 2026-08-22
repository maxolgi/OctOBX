/*
 * sentinel-migration.test.ts — end-to-end guarantees for the name-keyed
 * NEW-param sentinel scheme and the v1 → v2 saved-state migration.
 *
 * Background: the C engine dispatches NEW-param sentinels (idx ≥ 200) by
 * CANONICAL ordinal (position in canonicalNewParamOrder / the generated
 * param-table.json `newParams` array). The UI (obxd-synth-ui.ts
 * resolveLegacyIndex) and the drum knob strips (drum-rack.ts) must derive
 * sentinels the same way — by NAME, never by layout encounter order. Saved
 * v1 user state stored the 28 NEW values in the frozen V1 encounter order
 * (tools/new-param-order-v1.json); app-state.ts migrates them on load.
 *
 * Pure logic — no browser, no WASM. The engine-side cross-check uses
 * src/generated/param-table.json, the sidecar the engine dispatch table is
 * statically generated from.
 */

import { describe, it, expect } from "vitest";
import {
    canonicalNewParamOrder,
    paramMappings,
    NEW_PARAM_BASE,
    NEW_PARAM_COUNT,
} from "../src/obxf-param-mappings";
import { obxfControls } from "../src/obxf-layout";
import { migrateParamsV1ToV2, V1_NEW_PARAM_ORDER } from "../src/app-state";
import paramTable from "../src/generated/param-table.json";
import v1Spec from "../tools/new-param-order-v1.json";

// ---------------------------------------------------------------------------
// Layout walk — replicates resolveLegacyIndex in src/obxd-synth-ui.ts.
// ID_ALIASES mirrors the table there (the module itself is DOM-heavy and not
// imported into this pure test; the alias set is frozen by the layout spec).
// ---------------------------------------------------------------------------

const ID_ALIASES: Record<string, string> = {
    Osc1Vol: "Osc1Mix",
    Osc2Vol: "Osc2Mix",
    NoiseVol: "NoiseMix",
    FilterKeyTrack: "FilterKeyFollow",
    BendUpRange: "PitchBendUp",
    BendDownRange: "PitchBendDown",
    RingModVol: "RingModMix",
};

const legacyStreamIds = new Set<string>();
for (const m of paramMappings) {
    if (m.newId) legacyStreamIds.add(m.newId);
    if (m.secondaryNewId) legacyStreamIds.add(m.secondaryNewId);
}

const canonicalOrdinal = new Map(canonicalNewParamOrder.map((name, i) => [name, i]));

interface ResolvedControl {
    controlId: string;
    streamId: string;
    sentinel: number;
}

function walkParamBoundControls(): { news: ResolvedControl[]; unresolved: string[] } {
    const news: ResolvedControl[] = [];
    const unresolved: string[] = [];
    for (const c of obxfControls) {
        if (c.paramBound === false) continue;
        const streamId = ID_ALIASES[c.id] ?? c.id;
        if (legacyStreamIds.has(streamId)) continue;
        const ordinal = canonicalOrdinal.get(streamId);
        if (ordinal === undefined) {
            unresolved.push(c.id);
            continue;
        }
        news.push({ controlId: c.id, streamId, sentinel: NEW_PARAM_BASE + ordinal });
    }
    return { news, unresolved };
}

// ---------------------------------------------------------------------------
// 1. Migration round-trip
// ---------------------------------------------------------------------------

describe("migrateParamsV1ToV2 (v1 → v2 saved-state migration)", () => {
    it("remaps slots 80..107 from V1 order to canonical order and leaves 0..79 untouched", () => {
        // Encode the V1 position into the value: position 80+n holds 1000+n.
        const v1 = Array.from({ length: 108 }, (_, i) => i);
        for (let n = 0; n < V1_NEW_PARAM_ORDER.length; n++) v1[80 + n] = 1000 + n;

        const out = migrateParamsV1ToV2(v1);
        expect(out).not.toBeNull();
        expect(out!.length).toBe(108);

        // Slots 0..79 (legacy params) unchanged.
        for (let i = 0; i < 80; i++) {
            expect(out![i], `legacy slot ${i}`).toBe(i);
        }

        // Canonical slot m must hold the V1 value of that param:
        // out[80+m] === 1000 + v1IndexOf(canonicalOrder[m]).
        const v1IndexOf = (name: string): number => V1_NEW_PARAM_ORDER.indexOf(name);
        canonicalNewParamOrder.forEach((name, m) => {
            expect(out![80 + m], `${name} at canonical slot ${m}`).toBe(1000 + v1IndexOf(name));
        });
    });

    it("specifically: LFO2Rate lands at canonical 17 (from V1 13), LFO2Wave1 at canonical 13 (from V1 16)", () => {
        const v1 = new Array<number>(108).fill(0);
        for (let n = 0; n < V1_NEW_PARAM_ORDER.length; n++) v1[80 + n] = 1000 + n;
        const out = migrateParamsV1ToV2(v1)!;

        // The whole moved LFO2 block, explicit:
        expect(V1_NEW_PARAM_ORDER[13]).toBe("LFO2Rate");         // sanity: V1 slot 13
        expect(V1_NEW_PARAM_ORDER[16]).toBe("LFO2Wave1");        // sanity: V1 slot 16
        expect(canonicalNewParamOrder[17]).toBe("LFO2Rate");     // sanity: canonical slot 17
        expect(canonicalNewParamOrder[13]).toBe("LFO2Wave1");    // sanity: canonical slot 13

        expect(out[80 + 17]).toBe(1000 + 13); // LFO2Rate: v1 value 1013 → canonical slot 17
        expect(out[80 + 13]).toBe(1000 + 16); // LFO2Wave1: v1 value 1016 → canonical slot 13
        expect(out[80 + 14]).toBe(1000 + 17); // LFO2Wave2
        expect(out[80 + 15]).toBe(1000 + 18); // LFO2Wave3
        expect(out[80 + 16]).toBe(1000 + 19); // LFO2PW
        expect(out[80 + 18]).toBe(1000 + 14); // LFO2ModAmount1
        expect(out[80 + 19]).toBe(1000 + 15); // LFO2ModAmount2
    });

    it("is a pure permutation of the NEW slots and does not mutate the input", () => {
        const v1 = Array.from({ length: 108 }, (_, i) => i);
        for (let n = 0; n < 28; n++) v1[80 + n] = Math.random();
        const snapshot = v1.slice();
        const out = migrateParamsV1ToV2(v1)!;
        expect(v1).toEqual(snapshot); // input untouched
        expect([...out.slice(80, 108)].sort()).toEqual([...snapshot.slice(80, 108)].sort());
    });

    it("migrates every 108-block of the flat synth (10×108) and drum (32×108) arrays independently", () => {
        for (const blockCount of [10, 32]) {
            const len = blockCount * 108;
            const v1 = new Array<number>(len).fill(0);
            for (let b = 0; b < blockCount; b++) {
                for (let n = 0; n < 28; n++) v1[b * 108 + 80 + n] = 100000 + b * 100 + n;
            }
            const out = migrateParamsV1ToV2(v1)!;
            expect(out.length).toBe(len);
            canonicalNewParamOrder.forEach((name, m) => {
                const v1n = V1_NEW_PARAM_ORDER.indexOf(name);
                for (let b = 0; b < blockCount; b++) {
                    expect(out[b * 108 + 80 + m], `block ${b}, canonical slot ${m} (${name})`)
                        .toBe(100000 + b * 100 + v1n);
                }
            });
        }
    });

    it("handles null/empty/short inputs gracefully (saved state is user data)", () => {
        expect(migrateParamsV1ToV2(null)).toBeNull();
        expect(migrateParamsV1ToV2(undefined)).toBeNull();
        expect(migrateParamsV1ToV2([])).toEqual([]);
        // 90 slots: only 10 NEW slots exist; V1 and canonical agree on the
        // first 12 positions, so the array carries through unchanged.
        const short = Array.from({ length: 90 }, (_, i) => i);
        expect(migrateParamsV1ToV2(short)).toEqual(short);
        // 80 slots: no NEW slots at all.
        const legacyOnly = Array.from({ length: 80 }, (_, i) => i);
        expect(migrateParamsV1ToV2(legacyOnly)).toEqual(legacyOnly);
    });
});

// ---------------------------------------------------------------------------
// 2. Canonical-order consistency (generated module ↔ frozen V1 spec)
// ---------------------------------------------------------------------------

describe("canonical-order consistency", () => {
    it("canonicalNewParamOrder has 28 unique names", () => {
        expect(canonicalNewParamOrder.length).toBe(NEW_PARAM_COUNT);
        expect(new Set(canonicalNewParamOrder).size).toBe(NEW_PARAM_COUNT);
    });

    it("V1 orderedStreamingNames (frozen JSON) is the same 28-name SET in a different order", () => {
        const v1Names: string[] = v1Spec.orderedStreamingNames;
        expect(v1Names.length).toBe(28);
        expect(new Set(v1Names).size).toBe(28);
        expect(new Set(v1Names)).toEqual(new Set(canonicalNewParamOrder));
        // ...and it genuinely is a different ORDER (the LFO2 block moved):
        expect(v1Names).not.toEqual(canonicalNewParamOrder);
    });

    it("V1_NEW_PARAM_ORDER in app-state.ts is an exact transcription of the frozen JSON", () => {
        expect([...V1_NEW_PARAM_ORDER]).toEqual(v1Spec.orderedStreamingNames);
    });

    it("generated sidecar (param-table.json) agrees with the generated module and the engine ordinals", () => {
        expect(paramTable.canonicalNewParamOrder).toEqual(canonicalNewParamOrder);
        expect(paramTable.newParams.length).toBe(NEW_PARAM_COUNT);
        paramTable.newParams.forEach((p: { newId: string; newOrdinal: number }, i: number) => {
            expect(p.newOrdinal).toBe(i);
            expect(p.newId, `newParams[${i}]`).toBe(canonicalNewParamOrder[i]);
        });
    });

    it("NEW-param drumClass matches the verified synth-global set (4 globals, 24 voice)", () => {
        // Verified against the processX() bodies in obxf_imported/engine/
        // SynthEngine.h (see tools/PARAM_SPEC.md §drumClass taxonomy and
        // DRUM_NEW_GLOBAL_ORDINALS in tools/param-spec.mjs): only these four
        // setters write Motherboard-level state with no ForEachVoice, so they
        // are drum globals routed live to instance 9; every other NEW param
        // is ForEachVoice-scoped (per-voice) and must stay "voice".
        const verifiedGlobals = new Set(["UnisonVoices", "VoiceReassign", "VibratoWave", "LFO1PW"]);
        for (const p of paramTable.newParams) {
            const want = verifiedGlobals.has(p.newId) ? "global" : "voice";
            expect(p.drumClass, `newParams[${p.newId}].drumClass`).toBe(want);
        }
    });
});

// ---------------------------------------------------------------------------
// 3. Sentinel-map consistency (UI walk ↔ engine dispatch) — the end-to-end
//    guarantee that UI and engine agree post-change.
// ---------------------------------------------------------------------------

describe("sentinel-map consistency (UI ↔ engine)", () => {
    it("every paramBound layout control resolves to a legacy index or a canonical sentinel (none unresolved)", () => {
        const { unresolved } = walkParamBoundControls();
        expect(unresolved, `unresolved control ids: ${unresolved.join(", ")}`).toEqual([]);
    });

    it("exactly 28 controls are NEW params, one per canonical ordinal, sentinel = 200 + ordinal", () => {
        const { news } = walkParamBoundControls();
        expect(news.length).toBe(NEW_PARAM_COUNT);
        const byOrdinal = new Map<number, ResolvedControl>();
        for (const c of news) {
            const ordinal = c.sentinel - NEW_PARAM_BASE;
            expect(byOrdinal.has(ordinal), `duplicate canonical ordinal ${ordinal}`).toBe(false);
            byOrdinal.set(ordinal, c);
        }
        expect(byOrdinal.size).toBe(NEW_PARAM_COUNT);
        for (let ordinal = 0; ordinal < NEW_PARAM_COUNT; ordinal++) {
            const c = byOrdinal.get(ordinal)!;
            // The engine dispatches ordinal → param via the generated
            // sidecar; the UI's derived streaming name must match it.
            expect(c.sentinel).toBe(NEW_PARAM_BASE + ordinal);
            expect(paramTable.newParams[ordinal].newId, `ordinal ${ordinal}`).toBe(c.streamId);
        }
    });

    it("the RingModVol alias resolves to the canonical RingModMix (RINGMOD_NAME_DUALITY)", () => {
        const ring = walkParamBoundControls().news.find(c => c.controlId === "RingModVol");
        expect(ring).toBeDefined();
        expect(ring!.streamId).toBe("RingModMix");
        expect(ring!.sentinel).toBe(NEW_PARAM_BASE + canonicalOrdinal.get("RingModMix")!);
    });

    it("every NEW-param name used by drum-rack.ts exists in canonicalNewParamOrder", () => {
        const drumNames = [
            "Filter4PoleXpander", "FilterXpanderMode",
            "LFO1PW", "LFO1ToVolume",
            "LFO2TempoSync", "LFO2Wave1", "LFO2Wave2", "LFO2Wave3", "LFO2PW",
            "LFO2Rate", "LFO2ModAmount1", "LFO2ModAmount2",
            "LFO2ToFilterCutoff", "LFO2ToVolume",
            "FilterEnvAttackCurve", "AmpEnvAttackCurve",
        ];
        for (const name of drumNames) {
            expect(canonicalOrdinal.has(name), `drum-rack name "${name}" missing from canonicalNewParamOrder`)
                .toBe(true);
        }
    });
});

/*
 * app-state.ts — Save/load/restore synth + drum state to localStorage.
 *
 * Complements state-persistence.ts (which handles the Octopus sequencer
 * binary). Synth params are dumped from the AudioWorklet in a single
 * bulk round-trip; per-instance settings and drum state are collected
 * from JS-side module state.
 *
 * Save is triggered by the SAVE button. Restore happens when the
 * AudioWorklet initializes (on first PLAY).
 */

import { dumpAllSynthParams, restoreAllSynthAndDrumState, dumpAllDrumParams, isObxdReady, syncInstanceVolumes } from "./obxd-audio";
import {
    getSynthInstanceState,
    restoreSynthAfterAWP,
    onAWPReady,
    type SynthInstanceState,
} from "./obxd-rack";
import {
    getObxdInstanceChannel,
    setObxdInstanceChannel,
    getObxdInstanceMpe,
    setObxdInstanceMpe,
    getObxdInstanceMpeVoiceCount,
    setObxdInstanceMpeVoiceCount,
} from "./obxd-bridge";
import { getDrumState, restoreDrumState } from "./drum-rack";
import type { DrumKit } from "./drum-state";
import { canonicalNewParamOrder } from "./obxf-param-mappings";

const LS_KEY = "octobx:app_state:v1";

interface RoutingState {
    channel: number;
    mpe: boolean;
    mpeVoiceCount: number;
}

interface SaveStateData {
    synth: {
        instances: SynthInstanceState[];
        routing: RoutingState[];
        params: number[] | null;
    };
    drums: {
        kitIndex: number;
        kit: DrumKit;
        selectedPad: number;
        selectedLayer: number;
        params: number[] | null;
    } | null;
}

/** v1 on-disk shape — NEW-param slots stored in the frozen V1 encounter order. */
interface SaveStateV1 extends SaveStateData {
    version: 1;
}

/** Current shape (v2) — NEW-param slots stored in canonical order. */
interface SaveState extends SaveStateData {
    version: 2;
}

// ===========================================================================
// v1 → v2 NEW-param order migration (pure, unit-tested)
// ===========================================================================

// Params are persisted as flat positional blocks of 108: slots 0..79 hold
// legacy values, slots 80..107 hold the 28 NEW-param (sentinel ≥200) values.
const PARAM_BLOCK_LEN = 108;
const NEW_SLOT_BASE = 80;

/**
 * FROZEN V1 NEW-param order — an immutable copy of `orderedStreamingNames`
 * from tools/new-param-order-v1.json (the ordinal↔name assignment the
 * shipped encounter-order UI used; see that file's provenance). Exists so
 * migrateParamsV1ToV2 can remap old saves. NEVER edit — old saves on disk
 * depend on it.
 */
export const V1_NEW_PARAM_ORDER: readonly string[] = [
    "UnisonVoices",
    "VoiceReassign",
    "Osc2Keytrack",
    "EnvToPitchInvert",
    "EnvToPWInvert",
    "RingModMix",
    "NoiseColor",
    "VibratoWave",
    "Filter4PoleXpander",
    "FilterXpanderMode",
    "LFO1PW",
    "LFO1ToVolume",
    "LFO2TempoSync",
    "LFO2Rate",
    "LFO2ModAmount1",
    "LFO2ModAmount2",
    "LFO2Wave1",
    "LFO2Wave2",
    "LFO2Wave3",
    "LFO2PW",
    "LFO2ToOsc1Pitch",
    "LFO2ToOsc2Pitch",
    "LFO2ToFilterCutoff",
    "LFO2ToOsc1PW",
    "LFO2ToOsc2PW",
    "LFO2ToVolume",
    "FilterEnvAttackCurve",
    "AmpEnvAttackCurve",
];

/**
 * Migrate a flat positional params array (as dumped by dump_all_params /
 * dump_drum_params: N consecutive 108-length blocks) from the V1 NEW-param
 * encounter order to the canonical order the engine now dispatches.
 *
 * For every 108-block, slots 80..107 are remapped through a name→value
 * map: position 80+n in a v1 block holds the value of v1Order[n]; after
 * migration position 80+m holds the value of canonicalOrder[m]. Slots
 * 0..79 (legacy params) are untouched. The input array is never mutated —
 * a migrated copy is returned (the input itself when null/empty).
 *
 * Robustness for user data: blocks shorter than 108 (or with missing NEW
 * slots) carry through whatever exists — present v1 values are placed at
 * their canonical positions and positions without a source value keep
 * their original content. Never throws.
 */
export function migrateParamsV1ToV2(
    params: number[] | null | undefined,
    v1Order: readonly string[] = V1_NEW_PARAM_ORDER,
    canonicalOrder: readonly string[] = canonicalNewParamOrder,
): number[] | null {
    if (!params || params.length === 0) return params ?? null;
    const out = params.slice();
    const blockCount = Math.ceil(params.length / PARAM_BLOCK_LEN);
    for (let b = 0; b < blockCount; b++) {
        const base = b * PARAM_BLOCK_LEN;
        const blockEnd = Math.min(base + PARAM_BLOCK_LEN, params.length);
        const v1Count = blockEnd - (base + NEW_SLOT_BASE);
        if (v1Count <= 0) continue; // block has no NEW slots — nothing to remap
        const valueByName = new Map<string, number>();
        for (let n = 0; n < v1Order.length && n < v1Count; n++) {
            valueByName.set(v1Order[n], params[base + NEW_SLOT_BASE + n]);
        }
        for (let m = 0; m < canonicalOrder.length; m++) {
            const dest = base + NEW_SLOT_BASE + m;
            if (dest >= blockEnd) break; // short block — carry the rest through
            const v = valueByName.get(canonicalOrder[m]);
            if (v !== undefined) out[dest] = v;
        }
    }
    return out;
}

let cachedState: SaveState | null = null;

export async function saveAppState(): Promise<boolean> {
    const routing: RoutingState[] = Array.from({ length: 10 }, (_, i) => ({
        channel: getObxdInstanceChannel(i),
        mpe: getObxdInstanceMpe(i),
        mpeVoiceCount: getObxdInstanceMpeVoiceCount(i),
    }));

    let params: number[] | null = null;
    try {
        params = await dumpAllSynthParams();
    } catch (e) {
        console.warn("[app-state] Failed to dump synth params:", e);
    }

    let drumParams: number[] | null = null;
    try {
        drumParams = await dumpAllDrumParams();
    } catch (e) {
        console.warn("[app-state] Failed to dump drum params:", e);
    }

    const drumState = getDrumStateSafely();
    if (drumState) drumState.params = drumParams;

    const state: SaveState = {
        version: 2,
        synth: {
            instances: getSynthInstanceState(),
            routing,
            params,
        },
        drums: drumState,
    };

    try {
        localStorage.setItem(LS_KEY, JSON.stringify(state));
        console.log(`[app-state] Saved${params ? ` (${params.length} params)` : " (no AWP)"}`);
        return true;
    } catch (e) {
        console.warn("[app-state] Failed to save:", e);
        return false;
    }
}

function getDrumStateSafely(): SaveState["drums"] {
    try {
        const d = getDrumState();
        return { ...d, params: null };
    } catch {
        return null;
    }
}

export function loadAppState(): boolean {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return false;
        let state: SaveState | SaveStateV1 = JSON.parse(raw) as SaveState | SaveStateV1;
        if (state?.version === 1) {
            // v1 saves store NEW-param values (slots 80..107 of each 108
            // block) in the frozen V1 encounter order. Remap them in memory
            // to the canonical order the engine dispatches. The copy on
            // disk stays v1 until the next save writes v2.
            state = {
                ...state,
                version: 2,
                synth: state.synth
                    ? { ...state.synth, params: migrateParamsV1ToV2(state.synth.params) }
                    : state.synth,
                drums: state.drums
                    ? { ...state.drums, params: migrateParamsV1ToV2(state.drums.params) }
                    : state.drums,
            };
            console.info("[app-state] Migrated v1 save state to v2 (canonical NEW-param order, in memory)");
        }
        if (state?.version !== 2) {
            cachedState = null;
            return false;
        }
        cachedState = state;
        // Fill the volume variable at page load so the mixer faders show the
        // correct values whenever the Mixer is opened — no PLAY required.
        if (cachedState.synth?.params) syncInstanceVolumes(cachedState.synth.params);
        console.log("[app-state] Loaded from localStorage");
        return true;
    } catch (e) {
        console.warn("[app-state] Failed to load:", e);
        return false;
    }
}

export function clearAppState(): void {
    localStorage.removeItem(LS_KEY);
    cachedState = null;
    console.log("[app-state] Cleared");
}

export function downloadAppStateJson(): void {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return;
        const blob = new Blob([raw], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        a.download = `octobx_app_state_${ts}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (e) {
        console.warn("[app-state] Failed to download JSON:", e);
    }
}

export function registerAWPReadyCallback(): void {
    onAWPReady(restoreAppStateAfterAWP);
}

/*
 * Reload cached state from localStorage and, if the AudioWorklet is
 * running, apply it immediately. Called after a project switch.
 */
export async function reloadAndRestoreAppState(): Promise<void> {
    loadAppState();
    if (isObxdReady()) {
        await restoreAppStateAfterAWP();
    }
}

async function restoreAppStateAfterAWP(): Promise<boolean> {
    if (!cachedState) return false;
    const s = cachedState;

    try {
        // Restore ORDERING is ENGINE-OWNED: after the kit load below, ONE
        // restoreAllSynthAndDrumState call drives the C-side staged restore
        // (obxd_restore_stage in wasm/obxd/main_obxd.cpp), which owns the
        // full sequence — synth replay (skipping instance 9's drum-
        // structural rows), drum layer store write, and the drum structural
        // finalize (osc mutes + polyphony=32) that ends it. Nothing in JS
        // needs to run "last" anymore.
        //
        // 1. Drum kit load (loads PCM samples + seeds default layer params
        //    from the kit preset).
        // 2. Synth + drum params restore in one engine-owned sequence.
        // 3. Per-instance settings + routing (power, bend range, channel,
        //    MPE — no polyphony; that is owned by the editor / legacy
        //    idx 3 and, for instance 9, the engine's stage 4).

        if (s.drums) {
            await restoreDrumState(s.drums);
            console.log("[app-state] Drum kit restored");
        }

        if (s.synth.params) {
            await restoreAllSynthAndDrumState(s.synth.params, s.drums?.params ?? null);
            console.log("[app-state] Synth + drum state restored (engine-owned ordering)");
        }

        if (s.synth.instances) {
            restoreSynthAfterAWP(s.synth.instances);
        }

        if (s.synth.routing) {
            for (let i = 0; i < 10 && i < s.synth.routing.length; i++) {
                const r = s.synth.routing[i];
                setObxdInstanceChannel(i, r.channel);
                setObxdInstanceMpe(i, r.mpe);
                setObxdInstanceMpeVoiceCount(i, r.mpeVoiceCount);
            }
        }

        console.log("[app-state] Full restore complete");
        return true;
    } catch (e) {
        console.warn("[app-state] Restore failed:", e);
        return false;
    }
}

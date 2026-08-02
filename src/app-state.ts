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

import { dumpAllSynthParams, restoreAllSynthParams, dumpAllDrumParams, restoreAllDrumParams } from "./obxd-audio";
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

const LS_KEY = "octobx:app_state:v1";

interface RoutingState {
    channel: number;
    mpe: boolean;
    mpeVoiceCount: number;
}

interface SaveState {
    version: 1;
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
        version: 1,
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
        cachedState = JSON.parse(raw) as SaveState;
        if (cachedState?.version !== 1) {
            cachedState = null;
            return false;
        }
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

async function restoreAppStateAfterAWP(): Promise<boolean> {
    if (!cachedState) return false;
    const s = cachedState;

    try {
        // Order matters:
        // 1. Drum kit load (calls initDrumMode + loads PCM samples +
        //    seeds default layer params from the kit preset).
        // 2. Synth params restore (overwrites instance 9 globals that
        //    initDrumMode just set, with the saved values).
        // 3. Drum layer params restore (overwrites kit-default layer
        //    params with the user's tweaks).
        // 4. Per-instance settings + routing.

        if (s.drums) {
            await restoreDrumState(s.drums);
            console.log("[app-state] Drum kit restored");
        }

        if (s.synth.params) {
            await restoreAllSynthParams(s.synth.params);
            console.log("[app-state] Synth params restored");
        }

        if (s.drums?.params) {
            await restoreAllDrumParams(s.drums.params);
            console.log("[app-state] Drum layer params restored");
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

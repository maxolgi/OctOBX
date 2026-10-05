/*
 * mixer/fx-rack.ts — per-instance guitarix FX chain state cache for the
 * console track strips. The C mirror in the worklet is the source of
 * truth; this cache is loaded once per console mount (getFxState) and
 * kept in sync by the UI mutations below (the UI is the only writer
 * after load). Pure logic — no DOM.
 */

import {
    FX_EFFECTS, FX_INSTANCE_COUNT, FX_SLOTS, FX_TOTAL_PARAMS,
    fxParamFrom01, isFxId,
} from "../gxfx-params";
import { getFxState, setFxEnabled, setFxOrder, setFxParam } from "../obxd-audio";

export interface FxInstanceState {
    order: number[];      // slot → fx_id (chain position left→right)
    enabled: boolean[];   // fx_id → in/byp
    params: number[];     // flat FX_TOTAL_PARAMS mirror, ENGINE units
}

function defaultState(): FxInstanceState {
    return {
        order: FX_EFFECTS.map((e) => e.id),
        enabled: FX_EFFECTS.map(() => false),
        params: FX_EFFECTS.flatMap((e) => e.params.map((p) => p.default)),
    };
}

const instances: FxInstanceState[] = [];
for (let i = 0; i < FX_INSTANCE_COUNT; i++) instances.push(defaultState());
const fallback: FxInstanceState = defaultState();

let loaded = false;
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
    for (const cb of listeners) cb();
}

function instanceAt(inst: number): FxInstanceState | null {
    if (!Number.isInteger(inst) || inst < 0 || inst >= FX_INSTANCE_COUNT) return null;
    return instances[inst];
}

function validPermutation(order: number[]): boolean {
    if (order.length !== FX_SLOTS) return false;
    const seen = new Set<number>();
    for (const v of order) {
        if (!Number.isInteger(v) || v < 0 || v >= FX_EFFECTS.length || seen.has(v)) return false;
        seen.add(v);
    }
    return true;
}

async function doLoad(): Promise<void> {
    const bulk = await getFxState().catch(() => null);
    if (bulk) {
        for (let i = 0; i < FX_INSTANCE_COUNT; i++) {
            const order = bulk.order.slice(i * FX_SLOTS, (i + 1) * FX_SLOTS);
            if (!validPermutation(order)) continue;
            const st = instances[i];
            st.order = order;
            st.enabled = bulk.enabled
                .slice(i * FX_SLOTS, (i + 1) * FX_SLOTS)
                .map((v) => v !== 0);
            st.params = bulk.params
                .slice(i * FX_TOTAL_PARAMS, (i + 1) * FX_TOTAL_PARAMS)
                .map((v, j) => (Number.isFinite(v) ? v : st.params[j]));
        }
    }
    loaded = true;
    notify();
}

export function ensureFxStateLoaded(): Promise<void> {
    if (loaded) return Promise.resolve();
    if (!loadPromise) loadPromise = doLoad();
    return loadPromise;
}

export function fxLoaded(): boolean {
    return loaded;
}

export function getFxInstance(inst: number): FxInstanceState {
    return instanceAt(inst) ?? fallback;
}

export function setFxParamUI(inst: number, fxId: number, param: number, v01: number): void {
    const st = instanceAt(inst);
    if (!st || !isFxId(fxId) || !Number.isFinite(v01)) return;
    const fx = FX_EFFECTS[fxId];
    if (!Number.isInteger(param) || param < 0 || param >= fx.params.length) return;
    const engine = fxParamFrom01(fxId, param, v01);
    if (!Number.isFinite(engine)) return;
    st.params[fx.offset + param] = engine;
    setFxParam(inst, fxId, param, engine);
}

export function setFxEnabledUI(inst: number, fxId: number, on: boolean): void {
    const st = instanceAt(inst);
    if (!st || !isFxId(fxId)) return;
    st.enabled[fxId] = !!on;
    setFxEnabled(inst, fxId, !!on);
    notify();
}

export function moveFxSlot(inst: number, from: number, to: number): void {
    const st = instanceAt(inst);
    if (!st || !Number.isFinite(from) || !Number.isFinite(to)) return;
    const f = Math.max(0, Math.min(FX_SLOTS - 1, Math.round(from)));
    const t = Math.max(0, Math.min(FX_SLOTS - 1, Math.round(to)));
    if (f === t) return;
    const [moved] = st.order.splice(f, 1);
    st.order.splice(t, 0, moved);
    setFxOrder(inst, st.order.slice());
    notify();
}

export function onFxStateChange(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

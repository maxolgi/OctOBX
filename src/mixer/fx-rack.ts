/*
 * mixer/fx-rack.ts — per-instance guitarix FX chain state cache for the
 * console track strips (slot model: slot index = chain position, each slot
 * holds any fx id or -1 = empty, duplicates allowed). The C mirror in the
 * worklet is the source of truth; this cache is loaded once per console
 * mount (getFxState) and kept in sync by the UI mutations below (the UI is
 * the only writer after load) — the setSlot/move mutations mirror the
 * engine semantics exactly so the cache never disagrees. Pure logic — no
 * DOM.
 */

import {
    FX_COUNT, FX_EFFECTS, FX_INSTANCE_COUNT, FX_SLOTS, FX_SLOT_PARAMS,
    fxParamFrom01, isFxId,
} from "../gxfx-params";
import { getFxState, setFxEnabled, setFxParam, setFxSlot, moveFxSlot } from "../obxd-audio";

export interface FxInstanceState {
    slots: number[];      // slot → fx_id, -1 = empty (chain position = slot index)
    enabled: boolean[];   // slot → in/byp
    params: number[];     // flat per-slot mirror FX_SLOTS*FX_SLOT_PARAMS, ENGINE units
}

function defaultSlotParams(fxId: number): number[] {
    const row = new Array<number>(FX_SLOT_PARAMS).fill(0);
    if (fxId >= 0) {
        const fx = FX_EFFECTS[fxId];
        fx.params.forEach((p, i) => { row[i] = p.default; });
    }
    return row;
}

function defaultState(): FxInstanceState {
    return {
        // canonical chain: slot i → fx i for the first FX_SLOTS (11)
        // effects — the engine's gxfx_init default, NOT one slot per
        // catalog entry. Per-instance dims: FX_SLOTS slots ×
        // FX_SLOTS*FX_SLOT_PARAMS params.
        slots: FX_EFFECTS.slice(0, FX_SLOTS).map((e) => e.id),
        enabled: new Array<boolean>(FX_SLOTS).fill(false),
        params: FX_EFFECTS.slice(0, FX_SLOTS).flatMap((e) => defaultSlotParams(e.id)),
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

function validSlot(v: number): boolean {
    return Number.isInteger(v) && v >= -1 && v < FX_COUNT;
}

async function doLoad(): Promise<void> {
    const bulk = await getFxState().catch(() => null);
    if (bulk) {
        for (let i = 0; i < FX_INSTANCE_COUNT; i++) {
            const slots = bulk.slots.slice(i * FX_SLOTS, (i + 1) * FX_SLOTS);
            if (!slots.every(validSlot)) continue;
            const st = instances[i];
            st.slots = slots;
            st.enabled = bulk.enabled
                .slice(i * FX_SLOTS, (i + 1) * FX_SLOTS)
                .map((v) => v !== 0);
            st.params = bulk.params
                .slice(i * FX_SLOTS * FX_SLOT_PARAMS, (i + 1) * FX_SLOTS * FX_SLOT_PARAMS)
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

export function setFxParamUI(inst: number, slot: number, param: number, v01: number): void {
    const st = instanceAt(inst);
    if (!st || !Number.isInteger(slot) || slot < 0 || slot >= FX_SLOTS) return;
    const fxId = st.slots[slot];
    if (!isFxId(fxId)) return;
    const fx = FX_EFFECTS[fxId];
    if (!Number.isInteger(param) || param < 0 || param >= fx.params.length) return;
    const engine = fxParamFrom01(fxId, param, v01);
    if (!Number.isFinite(engine)) return;
    st.params[slot * FX_SLOT_PARAMS + param] = engine;
    setFxParam(inst, slot, param, engine);
}

export function setFxEnabledUI(inst: number, slot: number, on: boolean): void {
    const st = instanceAt(inst);
    if (!st || !Number.isInteger(slot) || slot < 0 || slot >= FX_SLOTS) return;
    if (!isFxId(st.slots[slot])) return;   // empty slot — nothing to enable
    st.enabled[slot] = !!on;
    setFxEnabled(inst, slot, !!on);
    notify();
}

/** Load an effect into a slot (-1 = empty). Mirrors the ENGINE semantics
 * exactly: fx_set_slot resets the slot's params to the new effect's
 * defaults and clears its enabled flag — the cache applies the same reset
 * locally so the two never disagree. */
export function setSlotUI(inst: number, slot: number, fxId: number): void {
    const st = instanceAt(inst);
    if (!st || !Number.isInteger(slot) || slot < 0 || slot >= FX_SLOTS) return;
    if (!validSlot(fxId)) return;
    st.slots[slot] = fxId;
    st.enabled[slot] = false;
    const row = defaultSlotParams(fxId);
    for (let p = 0; p < FX_SLOT_PARAMS; p++) st.params[slot * FX_SLOT_PARAMS + p] = row[p];
    setFxSlot(inst, slot, fxId);
    notify();
}

/** Move a slot's whole content (fx id, params, enabled) to another chain
 * position — array-move, mirroring fx_move_slot. */
export function moveSlotUI(inst: number, from: number, to: number): void {
    const st = instanceAt(inst);
    if (!st || !Number.isInteger(from) || from < 0 || from >= FX_SLOTS) return;
    if (!Number.isInteger(to) || to < 0 || to >= FX_SLOTS) return;
    if (from === to) return;
    const [slotId] = st.slots.splice(from, 1);
    st.slots.splice(to, 0, slotId);
    const [en] = st.enabled.splice(from, 1);
    st.enabled.splice(to, 0, en);
    const row = st.params.splice(from * FX_SLOT_PARAMS, FX_SLOT_PARAMS);
    st.params.splice(to * FX_SLOT_PARAMS, 0, ...row);
    moveFxSlot(inst, from, to);
    notify();
}

export function onFxStateChange(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

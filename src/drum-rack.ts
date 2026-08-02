/* drum-rack.ts — OB-Xf drum module UI (kit selector, 8 pads, 4 layers, with
 * the full OB-Xf editor embedded per selected layer + drum-specific sample
 * selector / mute). */

import { createObxdToggle } from "./obxd-knob";
import type { DrumKit, DrumLayer } from "./drum-state";
import { DRUM_KITS } from "./drum-kits";
import {
    initDrumMode,
    loadDrumKit,
    setLayerParam,
    previewPad,
    setDrumLayerParam,
    getDrumLayerParam,
    DRUM_INSTANCE,
} from "./drum-audio";
import { setObxdInstanceParam } from "./obxd-audio";
import type { ObxdParamTarget } from "./obxd-synth-ui";

// --- Module state ---------------------------------------------------------

let selectedPad = 0;
let selectedLayer = 0;
let currentKitIndex = 0;
let currentKit: DrumKit = cloneKit(DRUM_KITS[0]);
let ready = false;
let mountedContainer: HTMLElement | null = null;

// DOM refs populated by buildUI().
let statusEl: HTMLSpanElement;
let kitSelectEl: HTMLSelectElement;
let layerBtnsEl: HTMLDivElement;
let editorEl: HTMLDivElement;
let drumControlsEl: HTMLDivElement;
let drumKnobHost: HTMLDivElement;
let layerStripLabel: HTMLDivElement;
const padBtns: HTMLButtonElement[] = [];
const padDots: HTMLSpanElement[][] = [];

// OB-Xf editor target: closes over selectedPad/selectedLayer (module-level
// lets) so every get/set addresses the currently-selected drum layer at call
// time. Built once; the editor is re-seeded via editorHandle.sync() whenever
// the pad/layer selection changes.
const drumTarget: ObxdParamTarget = {
    get: (idx) => getDrumLayerParam(selectedPad, selectedLayer, idx),
    set: (idx, v) => setDrumLayerParam(selectedPad, selectedLayer, idx, v),
};

// --- Drum knob strips -----------------------------------------------------

// Legacy param indices for the knob strips.
const IDX_VOLUME = 2;
const IDX_BRIGHTNESS = 38;
const IDX_FLT_KF = 43;
const IDX_CUTOFF = 44;
const IDX_RESONANCE = 45;
const IDX_MULTIMODE = 46;
const IDX_HQMODE = 47;
const IDX_FENV_AMT = 50;
const IDX_LATK = 51;
const IDX_LDEC = 52;
const IDX_LSUS = 53;
const IDX_LREL = 54;
const IDX_FATK = 55;
const IDX_FDEC = 56;
const IDX_FSUS = 57;
const IDX_FREL = 58;
const IDX_ENV_SLOP = 59;
const IDX_FILT_SLOP = 60;
const IDX_LFO1_RATE = 17;
const IDX_LFO1_SYNC = 72;
const IDX_LFO1_W1 = 18;
const IDX_LFO1_W2 = 19;
const IDX_LFO1_W3 = 20;
const IDX_FOURPOLE = 49;
const IDX_BANDPASS = 48;
const IDX_SELF_OSC_PUSH = 79;
const IDX_FENV_INVERT = 76;
const IDX_VFLTENV = 10;
const IDX_VAMPENV = 11;
const IDX_LFO1AMT = 21;
const IDX_LFO2AMT = 22;
const IDX_LFOFILTER = 25;

// SVG arc helpers (from the pre-OB-Xf knob factory, commit 1c1f09d^).
const SVG_NS = "http://www.w3.org/2000/svg";
function polar(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
    const rad = (deg - 90) * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
    const a = polar(cx, cy, r, startDeg);
    const b = polar(cx, cy, r, endDeg);
    const large = (endDeg - startDeg) <= 180 ? 0 : 1;
    return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

// NEW param sentinel indices (NEW_PARAM_BASE + N, assigned at runtime by obxd-synth-ui
// in the order controls appear in obxfControls). Verified by tracing obxf-layout.ts:
const IDX_LFO1_PW = 210;
const IDX_LFO1_TO_VOL = 211;
const IDX_LFO2_SYNC = 212;
const IDX_LFO2_RATE = 213;
const IDX_LFO2_MOD1 = 214;
const IDX_LFO2_MOD2 = 215;
const IDX_LFO2_W1 = 216;
const IDX_LFO2_W2 = 217;
const IDX_LFO2_W3 = 218;
const IDX_LFO2_PW = 219;
const IDX_LFO2_TO_FILT = 222;
const IDX_LFO2_TO_VOL = 225;
const IDX_FILT_XPANDER = 208;
const IDX_FILT_XPANDER_MODE = 209;
const IDX_FENV_ATK_CURVE = 226;
const IDX_AENV_ATK_CURVE = 227;

interface DrumKnobDef {
    label: string;
    idx: number;       // legacy param index (-1 for custom dispatch)
    default?: number;  // reset value for double-click
    toggle?: boolean;  // if true, render as toggle button instead of knob
    triState?: boolean; // if true, render as Off/On/Inv tri-state button (LFO routings)
    customSet?: (v: number) => void;
    customGet?: () => number;
}

const GLOBAL_KNOBS: DrumKnobDef[] = [
    { label: "Volume", idx: IDX_VOLUME, default: 0.5 },
    { label: "HQ", idx: IDX_HQMODE, default: 0, toggle: true },
    { label: "LFO1 Rate", idx: IDX_LFO1_RATE, default: 0.5 },
    { label: "LFO1 Sync", idx: IDX_LFO1_SYNC, default: 0, toggle: true },
    { label: "LFO1 W1", idx: IDX_LFO1_W1, default: 0.5 },
    { label: "LFO1 W2", idx: IDX_LFO1_W2, default: 0.5 },
    { label: "LFO1 W3", idx: IDX_LFO1_W3, default: 0.5 },
    { label: "LFO1 PW", idx: IDX_LFO1_PW, default: 0.5 },
];

interface DrumKnobGroup {
    label: string;
    knobs: DrumKnobDef[];
}

const LAYER_GROUPS: DrumKnobGroup[] = [
    {
        label: "Filter",
        knobs: [
            { label: "Cutoff", idx: IDX_CUTOFF, default: 1.0 },
            { label: "Reson", idx: IDX_RESONANCE, default: 0.0 },
            { label: "Mode", idx: IDX_MULTIMODE, default: 0.0 },
            { label: "Env Amt", idx: IDX_FENV_AMT, default: 0.0 },
            { label: "Key Trk", idx: IDX_FLT_KF, default: 0.0 },
            { label: "4-Pole", idx: IDX_FOURPOLE, default: 0, toggle: true },
            { label: "BP Blend", idx: IDX_BANDPASS, default: 0, toggle: true },
            { label: "Push", idx: IDX_SELF_OSC_PUSH, default: 0, toggle: true },
            { label: "Xpander", idx: IDX_FILT_XPANDER, default: 0, toggle: true },
            { label: "Xp Mode", idx: IDX_FILT_XPANDER_MODE, default: 0 },
        ],
    },
    {
        label: "Filter Env",
        knobs: [
            { label: "Attack", idx: IDX_FATK, default: 0.0 },
            { label: "Decay", idx: IDX_FDEC, default: 0.3 },
            { label: "Sustain", idx: IDX_FSUS, default: 1.0 },
            { label: "Release", idx: IDX_FREL, default: 0.3 },
            { label: "Invert", idx: IDX_FENV_INVERT, default: 0, toggle: true },
            { label: "Vel\u2192Flt", idx: IDX_VFLTENV, default: 0 },
            { label: "Atk Crv", idx: IDX_FENV_ATK_CURVE, default: 0.5 },
        ],
    },
    {
        label: "Amp Env",
        knobs: [
            { label: "Attack", idx: IDX_LATK, default: 0.0 },
            { label: "Decay", idx: IDX_LDEC, default: 0.3 },
            { label: "Sustain", idx: IDX_LSUS, default: 1.0 },
            { label: "Release", idx: IDX_LREL, default: 0.3 },
            { label: "Vel\u2192Amp", idx: IDX_VAMPENV, default: 0 },
            { label: "Atk Crv", idx: IDX_AENV_ATK_CURVE, default: 0.5 },
        ],
    },
    {
        label: "LFO1",
        knobs: [
            { label: "Mod Amt1", idx: IDX_LFO1AMT, default: 0.0 },
            { label: "Mod Amt2", idx: IDX_LFO2AMT, default: 0.0 },
            { label: "Filter", idx: IDX_LFOFILTER, default: 0, triState: true },
            { label: "Volume", idx: IDX_LFO1_TO_VOL, default: 0, triState: true },
        ],
    },
    {
        label: "LFO2",
        knobs: [
            { label: "Rate", idx: IDX_LFO2_RATE, default: 0.5 },
            { label: "Sync", idx: IDX_LFO2_SYNC, default: 0, toggle: true },
            { label: "Mod Amt1", idx: IDX_LFO2_MOD1, default: 0.0 },
            { label: "Mod Amt2", idx: IDX_LFO2_MOD2, default: 0.0 },
            { label: "Wave 1", idx: IDX_LFO2_W1, default: 0.5 },
            { label: "Wave 2", idx: IDX_LFO2_W2, default: 0.5 },
            { label: "Wave 3", idx: IDX_LFO2_W3, default: 0.5 },
            { label: "PW", idx: IDX_LFO2_PW, default: 0.5 },
            { label: "Filter", idx: IDX_LFO2_TO_FILT, default: 0, triState: true },
            { label: "Volume", idx: IDX_LFO2_TO_VOL, default: 0, triState: true },
        ],
    },
    {
        label: "Misc",
        knobs: [
            { label: "Bright", idx: IDX_BRIGHTNESS, default: 1.0 },
            { label: "Filt Slop", idx: IDX_FILT_SLOP, default: 0.0 },
            { label: "Env Slop", idx: IDX_ENV_SLOP, default: 0.0 },
        ],
    },
];

// Per-layer Gain and Pan — these bypass g_drum_layer_params and instead
// update the DrumLayer TS object + pushLayer (set_pcm_layer message).
const LAYER_DIRECT_KNOBS: DrumKnobDef[] = [
    {
        label: "Gain", idx: -1, default: 0.85,
        customSet: (v) => { const l = currentKit.pads[selectedPad].layers[selectedLayer]; l.gain = v; pushLayer(l); },
        customGet: () => currentKit.pads[selectedPad].layers[selectedLayer].gain,
    },
    {
        label: "Pan", idx: -1, default: 0.5,
        customSet: (v) => { const l = currentKit.pads[selectedPad].layers[selectedLayer]; l.pan = v; pushLayer(l); },
        customGet: () => currentKit.pads[selectedPad].layers[selectedLayer].pan,
    },
    {
        label: "Pitch", idx: -1, default: 0.5,
        customSet: (v) => { const l = currentKit.pads[selectedPad].layers[selectedLayer]; l.pitch = v; pushLayer(l); },
        customGet: () => currentKit.pads[selectedPad].layers[selectedLayer].pitch,
    },
];

interface DrumKnobHandle {
    el: HTMLElement;
    setValue: (v: number) => void;
    idx: number;
    isGlobal: boolean;
    customGet?: () => number;
}

let globalStripKnobs: DrumKnobHandle[] = [];
let layerStripKnobs: DrumKnobHandle[] = [];

function dispatchValue(idx: number, v: number, isGlobal: boolean): void {
    if (isGlobal) {
        setObxdInstanceParam(DRUM_INSTANCE, idx, v);
    } else {
        drumTarget.set(idx, v);
    }
}

function buildDrumKnob(def: DrumKnobDef, isGlobal: boolean): DrumKnobHandle {
    // Helper to build the standard wrapper (control + label below)
    const makeWrap = (): { wrap: HTMLDivElement; label: HTMLDivElement } => {
        const wrap = document.createElement("div");
        wrap.className = "drum-strip-knob";
        const label = document.createElement("div");
        label.className = "drum-strip-label";
        label.textContent = def.label;
        return { wrap, label };
    };

    // Toggle — horizontal pill with sliding knob
    if (def.toggle) {
        const { wrap, label } = makeWrap();
        const pill = document.createElement("div");
        pill.className = "drum-strip-pill";
        const dot = document.createElement("div");
        dot.className = "drum-strip-pill-knob";
        pill.appendChild(dot);
        wrap.appendChild(pill);
        wrap.appendChild(label);
        let state = 0;
        const setValue = (v: number): void => {
            state = v >= 0.5 ? 1 : 0;
            pill.classList.toggle("on", state === 1);
        };
        pill.addEventListener("click", () => {
            state = state ? 0 : 1;
            pill.classList.toggle("on", state === 1);
            dispatchValue(def.idx, state, isGlobal);
        });
        setValue(def.default ?? 0);
        return { el: wrap, setValue, idx: def.idx, isGlobal };
    }

    // Tri-state — 3-position pill (Off=left/grey, On=center/green, Inv=right/red)
    if (def.triState) {
        const { wrap, label } = makeWrap();
        const pill = document.createElement("div");
        pill.className = "drum-strip-pill tri";
        const dot = document.createElement("div");
        dot.className = "drum-strip-pill-knob";
        pill.appendChild(dot);
        wrap.appendChild(pill);
        wrap.appendChild(label);
        let state = 0;
        const values = [0, 0.5, 1.0];
        const setValue = (v: number): void => {
            if (v < 0.25) state = 0;
            else if (v < 0.75) state = 1;
            else state = 2;
            pill.classList.toggle("on", state === 1);
            pill.classList.toggle("inv", state === 2);
        };
        pill.addEventListener("click", () => {
            state = (state + 1) % 3;
            setValue(values[state]);
            dispatchValue(def.idx, values[state], isGlobal);
        });
        setValue(def.default ?? 0);
        return { el: wrap, setValue, idx: def.idx, isGlobal };
    }

    // SVG arc knob
    const wrap = document.createElement("div");
    wrap.className = "drum-strip-knob";

    const cx = 20, cy = 20, rOut = 16, rIn = 10;
    const ARC_START = -135, ARC_SWEEP = 270;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 40 40");
    svg.setAttribute("width", "40");
    svg.setAttribute("height", "40");
    svg.style.cursor = "ns-resize";
    svg.style.touchAction = "none";

    // Background track arc
    const trackPath = document.createElementNS(SVG_NS, "path");
    trackPath.setAttribute("d", arcPath(cx, cy, rOut, ARC_START, ARC_START + ARC_SWEEP));
    trackPath.setAttribute("fill", "none");
    trackPath.setAttribute("stroke", "#3a3a3a");
    trackPath.setAttribute("stroke-width", "3");
    trackPath.setAttribute("stroke-linecap", "round");
    svg.appendChild(trackPath);

    // Value arc
    const valuePath = document.createElementNS(SVG_NS, "path");
    valuePath.setAttribute("fill", "none");
    valuePath.setAttribute("stroke", "#0c0");
    valuePath.setAttribute("stroke-width", "3");
    valuePath.setAttribute("stroke-linecap", "round");
    svg.appendChild(valuePath);

    // Inner body circle
    const body = document.createElementNS(SVG_NS, "circle");
    body.setAttribute("cx", String(cx));
    body.setAttribute("cy", String(cy));
    body.setAttribute("r", String(rIn));
    body.setAttribute("fill", "#2a2a2a");
    body.setAttribute("stroke", "#444");
    body.setAttribute("stroke-width", "1");
    svg.appendChild(body);

    // Indicator line
    const indicator = document.createElementNS(SVG_NS, "line");
    indicator.setAttribute("stroke", "#0c0");
    indicator.setAttribute("stroke-width", "2");
    indicator.setAttribute("stroke-linecap", "round");
    svg.appendChild(indicator);

    const labelEl = document.createElement("div");
    labelEl.className = "drum-strip-label";
    labelEl.textContent = def.label;

    wrap.appendChild(svg);
    wrap.appendChild(labelEl);

    let value = def.customGet ? def.customGet() : (def.default ?? 0.5);

    const paint = (): void => {
        const endDeg = ARC_START + value * ARC_SWEEP;
        valuePath.setAttribute("d", arcPath(cx, cy, rOut, ARC_START, endDeg));
        const tip = polar(cx, cy, rIn - 1, endDeg);
        const base = polar(cx, cy, 3, endDeg);
        indicator.setAttribute("x1", String(base.x));
        indicator.setAttribute("y1", String(base.y));
        indicator.setAttribute("x2", String(tip.x));
        indicator.setAttribute("y2", String(tip.y));
    };

    const setValue = (v: number): void => {
        value = Math.max(0, Math.min(1, v));
        paint();
    };

    const setValueAndDispatch = (v: number): void => {
        value = Math.max(0, Math.min(1, v));
        paint();
        if (def.customSet) {
            def.customSet(value);
        } else {
            dispatchValue(def.idx, value, isGlobal);
        }
    };

    paint();

    svg.addEventListener("wheel", (ev) => {
        ev.preventDefault();
        setValueAndDispatch(value + (ev.deltaY > 0 ? -0.03 : 0.03));
    }, { passive: false });

    let dragging = false;
    let startY = 0;
    let startVal = 0;
    svg.addEventListener("pointerdown", (ev) => {
        dragging = true;
        startY = ev.clientY;
        startVal = value;
        svg.setPointerCapture(ev.pointerId);
        ev.preventDefault();
    });
    svg.addEventListener("pointermove", (ev) => {
        if (!dragging) return;
        setValueAndDispatch(startVal + (startY - ev.clientY) * 0.005);
    });
    svg.addEventListener("pointerup", (ev) => {
        dragging = false;
        svg.releasePointerCapture(ev.pointerId);
    });

    svg.addEventListener("dblclick", () => {
        setValueAndDispatch(def.default ?? 0.5);
    });

    return { el: wrap, setValue, idx: def.idx, isGlobal, customGet: def.customGet };
}

// --- Public API (fixed contract consumed by main.ts) ----------------------

// Race-safe singleton promise: concurrent callers (startup preload +
// first mountDrumModule) share one load. Idempotent once ready.
let preloadPromise: Promise<void> | null = null;

export function preloadDrumKit(): Promise<void> {
    if (ready) return Promise.resolve();
    if (preloadPromise) return preloadPromise;
    preloadPromise = (async () => {
        try {
            await initDrumMode();
        } catch (e) {
            console.warn("[drum] initDrumMode failed (OB-Xf worklet not booted?):", e);
            return;
        }
        try {
            await loadKitByIndex(0);
        } catch (e) {
            console.warn("[drum] initial kit load failed:", e);
        }
    })();
    return preloadPromise;
}

export async function mountDrumModule(container: HTMLElement): Promise<void> {
    if (mountedContainer === container) return;
    while (container.firstChild) container.removeChild(container.firstChild);
    ensureStyle();
    buildUI(container);
    mountedContainer = container;

    refreshPadBank();
    renderLayerButtons();
    renderLayerEditor();

    await preloadDrumKit();
    syncEditor();
}

export function isDrumReady(): boolean {
    return ready;
}

// --- State persistence (exported for app-state.ts) ------------------------

export function getDrumState(): {
    kitIndex: number;
    kit: DrumKit;
    selectedPad: number;
    selectedLayer: number;
} {
    return {
        kitIndex: currentKitIndex,
        kit: cloneKit(currentKit),
        selectedPad,
        selectedLayer,
    };
}

export async function restoreDrumState(state: {
    kitIndex: number;
    kit: DrumKit;
    selectedPad: number;
    selectedLayer: number;
}): Promise<void> {
    for (const pad of state.kit.pads) {
        for (const layer of pad.layers) layer._seeded = false;
    }
    currentKitIndex = state.kitIndex;
    currentKit = cloneKit(state.kit);
    selectedPad = state.selectedPad ?? 0;
    selectedLayer = state.selectedLayer ?? 0;
    if (kitSelectEl) kitSelectEl.value = String(currentKitIndex);
    if (mountedContainer) {
        refreshPadBank();
        renderLayerButtons();
        renderLayerEditor();
    }
    try {
        await initDrumMode();
        await loadDrumKit(currentKit);
        ready = true;
        if (statusEl) statusEl.textContent = "Ready - " + currentKit.name;
        syncEditor();
    } catch (e) {
        console.warn("[drum] restoreDrumState failed:", e);
    }
}

// --- Kit / pad helpers ----------------------------------------------------

function cloneKit(kit: DrumKit): DrumKit {
    return {
        name: kit.name,
        source: kit.source,
        pads: kit.pads.map((p) => {
            const layers = p.layers.map((l): DrumLayer => ({ ...l }));
            return {
                name: p.name,
                midiNote: p.midiNote,
                chokeGroup: p.chokeGroup,
                layers: [layers[0], layers[1], layers[2], layers[3]] as [DrumLayer, DrumLayer, DrumLayer, DrumLayer],
            };
        }),
    };
}

function collectSampleNames(): string[] {
    const set = new Set<string>();
    for (const pad of currentKit.pads) {
        for (const l of pad.layers) {
            if (l.sampleName) set.add(l.sampleName);
        }
    }
    return Array.from(set).sort();
}

// Push the currently-selected layer's params to the engine. When the layer
// is muted, force gain to 0 so the real gain is preserved on the layer obj
// for when the user unmutes.
function pushLayer(lyr: DrumLayer): void {
    const eff: DrumLayer = lyr.muted ? { ...lyr, gain: 0 } : lyr;
    setLayerParam(selectedPad, selectedLayer, eff);
}

// --- Kit loading ----------------------------------------------------------

async function loadKitByIndex(idx: number): Promise<void> {
    currentKitIndex = idx;
    currentKit = cloneKit(DRUM_KITS[idx]);
    selectedPad = 0;
    selectedLayer = 0;
    // DOM elements only exist after mountDrumModule → buildUI; guard for
    // the startup preload path which runs before the UI is mounted.
    if (kitSelectEl) kitSelectEl.value = String(idx);
    if (statusEl) statusEl.textContent = "Loading " + currentKit.name + "...";
    if (mountedContainer) {
        refreshPadBank();
        renderLayerButtons();
        renderLayerEditor();
    }
    try {
        await loadDrumKit(currentKit);
        ready = true;
        if (statusEl) statusEl.textContent = "Ready - " + currentKit.name;
        // Kit load resets selection to pad 0 / layer 0 and pushes the new
        // layers' params to the engine — re-seed the editor to match.
        syncEditor();
    } catch (e) {
        console.warn("[drum] loadDrumKit failed:", e);
        if (statusEl) statusEl.textContent = "Kit load failed (audio not ready) - " + currentKit.name;
    }
}

// --- DOM construction -----------------------------------------------------

function buildUI(container: HTMLElement): void {
    const root = document.createElement("div");
    root.className = "drum-root";

    // 1. Header: kit selector + Load Kit button + status.
    const header = document.createElement("div");
    header.className = "drum-header";

    kitSelectEl = document.createElement("select");
    kitSelectEl.title = "Drum kit";
    DRUM_KITS.forEach((k, i) => {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = k.name;
        kitSelectEl.appendChild(o);
    });
    kitSelectEl.value = "0";
    kitSelectEl.addEventListener("change", () => {
        const idx = parseInt(kitSelectEl.value, 10) || 0;
        void loadKitByIndex(idx);
    });

    const loadBtn = document.createElement("button");
    loadBtn.type = "button";
    loadBtn.className = "drum-btn";
    loadBtn.textContent = "Load Kit";
    loadBtn.addEventListener("click", () => {
        const idx = parseInt(kitSelectEl.value, 10) || 0;
        void loadKitByIndex(idx);
    });

    statusEl = document.createElement("span");
    statusEl.className = "drum-status";
    statusEl.textContent = "Initializing...";

    header.appendChild(kitSelectEl);
    header.appendChild(loadBtn);
    header.appendChild(statusEl);

    // 2. Pad bank: 8 large buttons in a row.
    const padsLabel = sectionLabel("Pads");
    const padBank = document.createElement("div");
    padBank.className = "drum-pad-bank";
    for (let i = 0; i < 8; i++) {
        const pad = currentKit.pads[i];
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "drum-pad";

        const nameEl = document.createElement("div");
        nameEl.className = "drum-pad-name";
        nameEl.textContent = pad.name;

        const noteEl = document.createElement("div");
        noteEl.className = "drum-pad-note";
        noteEl.textContent = "Note " + pad.midiNote;

        const dotsWrap = document.createElement("div");
        dotsWrap.className = "drum-pad-dots";
        const dots: HTMLSpanElement[] = [];
        for (let li = 0; li < 4; li++) {
            const d = document.createElement("span");
            d.className = "drum-pad-dot";
            dotsWrap.appendChild(d);
            dots.push(d);
        }

        btn.appendChild(nameEl);
        btn.appendChild(noteEl);
        btn.appendChild(dotsWrap);

        const padIndex = i;
        btn.addEventListener("click", () => {
            selectedPad = padIndex;
            selectedLayer = 0;
            refreshPadBank();
            renderLayerButtons();
            renderLayerEditor();
            syncEditor();
            try {
                previewPad(currentKit.pads[padIndex].midiNote);
            } catch (e) {
                console.warn("[drum] previewPad failed:", e);
            }
        });

        padBtns.push(btn);
        padDots.push(dots);
        padBank.appendChild(btn);
    }

    // 3. Layer selector (4 buttons) — rebuilt contents live in layerBtnsEl.
    const layersLabel = sectionLabel("Layers (click = select+enable, right-click = toggle)");
    layerBtnsEl = document.createElement("div");
    layerBtnsEl.className = "drum-layer-row";

    // 4. Layer editor — drum-specific controls (sample selector + mute) are
    //    rebuilt on selection change into drumControlsEl; the full OB-Xf
    //    editor below it (obxfEditorHost) is built ONCE in buildUI and is
    //    re-seeded via editorHandle.sync() when the selection changes.
    const editorLabel = sectionLabel("Layer editor");
    editorEl = document.createElement("div");
    editorEl.className = "drum-editor";

    drumControlsEl = document.createElement("div");
    drumControlsEl.className = "drum-sample-row";

    // Drum knob strips — the sole editor for per-layer params.
    drumKnobHost = document.createElement("div");
    drumKnobHost.className = "drum-knob-host";

    editorEl.appendChild(drumControlsEl);
    editorEl.appendChild(drumKnobHost);

    root.appendChild(header);
    root.appendChild(padsLabel);
    root.appendChild(padBank);
    root.appendChild(layersLabel);
    root.appendChild(layerBtnsEl);
    root.appendChild(editorLabel);
    root.appendChild(editorEl);

    container.appendChild(root);

    // Build the drum knob strips.
    globalStripKnobs = [];
    layerStripKnobs = [];

    const buildGroupSection = (label: string, knobs: DrumKnobDef[], isGlobal: boolean): HTMLDivElement => {
        const section = document.createElement("div");
        section.className = "drum-knob-section";
        const labelEl = document.createElement("div");
        labelEl.className = "drum-knob-section-label";
        labelEl.textContent = label;
        const row = document.createElement("div");
        row.className = "drum-knob-row";
        for (const def of knobs) {
            const kh = buildDrumKnob(def, isGlobal);
            if (isGlobal) globalStripKnobs.push(kh);
            else layerStripKnobs.push(kh);
            row.appendChild(kh.el);
        }
        section.appendChild(labelEl);
        section.appendChild(row);
        return section;
    };

    const buildPair = (a: HTMLElement, b: HTMLElement): HTMLDivElement => {
        const pair = document.createElement("div");
        pair.className = "drum-knob-pair";
        pair.appendChild(a);
        pair.appendChild(b);
        return pair;
    };

    const findGroup = (label: string): DrumKnobGroup => LAYER_GROUPS.find(g => g.label === label)!;

    // Global + Layer (Gain/Pan) side by side.
    drumKnobHost.appendChild(buildPair(
        buildGroupSection("Global", GLOBAL_KNOBS, true),
        buildGroupSection("Layer", LAYER_DIRECT_KNOBS, false),
    ));

    // Layer label.
    layerStripLabel = sectionLabel("Layer " + (selectedLayer + 1) + " params");
    drumKnobHost.appendChild(layerStripLabel);

    // Filter + Misc side by side.
    drumKnobHost.appendChild(buildPair(
        buildGroupSection("Filter", findGroup("Filter").knobs, false),
        buildGroupSection("Misc", findGroup("Misc").knobs, false),
    ));

    // Filter Env + Amp Env side by side.
    drumKnobHost.appendChild(buildPair(
        buildGroupSection("Filter Env", findGroup("Filter Env").knobs, false),
        buildGroupSection("Amp Env", findGroup("Amp Env").knobs, false),
    ));

    // LFO1 + LFO2 side by side.
    drumKnobHost.appendChild(buildPair(
        buildGroupSection("LFO1", findGroup("LFO1").knobs, false),
        buildGroupSection("LFO2", findGroup("LFO2").knobs, false),
    ));
}

function sectionLabel(text: string): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "drum-section-label";
    el.textContent = text;
    return el;
}

// --- Refresh / render routines -------------------------------------------

function refreshPadBank(): void {
    for (let i = 0; i < 8; i++) {
        padBtns[i].classList.toggle("selected", i === selectedPad);
        const pad = currentKit.pads[i];
        for (let li = 0; li < 4; li++) {
            padDots[i][li].classList.toggle("on", pad.layers[li].enabled);
        }
    }
}

function renderLayerButtons(): void {
    layerBtnsEl.replaceChildren();
    const pad = currentKit.pads[selectedPad];
    for (let li = 0; li < 4; li++) {
        const layer = pad.layers[li];
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "drum-layer-btn";
        if (li === selectedLayer) btn.classList.add("selected");

        const led = document.createElement("span");
        led.className = "drum-layer-led" + (layer.enabled ? " on" : "");

        const lab = document.createElement("span");
        lab.className = "drum-layer-label";
        lab.textContent = "L" + (li + 1);

        const sample = document.createElement("span");
        sample.className = "drum-layer-sample";
        sample.textContent = layer.enabled && layer.sampleName ? layer.sampleName : "empty";

        btn.appendChild(led);
        btn.appendChild(lab);
        btn.appendChild(sample);

        const layerIndex = li;
        btn.addEventListener("click", () => {
            selectedLayer = layerIndex;
            const l = pad.layers[layerIndex];
            if (!l.enabled) {
                l.enabled = true;
                // Reload the full kit so the layer list is re-compacted to
                // dense indices and the newly-enabled layer gets its PCM data
                // pushed into pcmBank. setPadLayerCount alone left gaps + a
                // null pcmBank slot so the layer played silence (Bug D — the
                // left-click path missed the reload the contextmenu handler
                // already does). UI is refreshed below synchronously so the
                // toggle reflects immediately; the reload only re-pushes PCM.
                void (async () => {
                    try {
                        await loadDrumKit(currentKit);
                    } catch (e) {
                        console.warn("[drum] reload on layer enable failed:", e);
                    }
                })();
            }
            renderLayerButtons();
            renderLayerEditor();
            syncEditor();
        });
        btn.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            const l = pad.layers[layerIndex];
            l.enabled = !l.enabled;
            refreshPadBank();
            renderLayerButtons();
            // Reload the full kit so the layer list is re-compacted to dense
            // indices and any newly-enabled layer gets its PCM data pushed.
            // Sending set_pcm_layer_count alone left gaps + null pcmBank
            // slots (Bug C). UI is refreshed above synchronously so the
            // toggle reflects immediately; the reload only re-pushes PCM.
            void (async () => {
                try {
                    await loadDrumKit(currentKit);
                } catch (e) {
                    console.warn("[drum] reload on layer toggle failed:", e);
                }
            })();
        });

        layerBtnsEl.appendChild(btn);
    }
}

function renderLayerEditor(): void {
    // Drum-specific controls only (sample selector + mute). The full OB-Xf
    // editor lives in obxfEditorHost (built once in buildUI) and is re-seeded
    // via editorHandle.sync() on selection change — NOT rebuilt here.
    drumControlsEl.replaceChildren();
    const lyr = currentKit.pads[selectedPad].layers[selectedLayer];

    // Sample selector (reassign among samples already present in the kit).
    const sampleLabel = document.createElement("span");
    sampleLabel.textContent = "Sample:";

    const sampleSelect = document.createElement("select");
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "--";
    sampleSelect.appendChild(noneOpt);
    for (const s of collectSampleNames()) {
        const o = document.createElement("option");
        o.value = s;
        o.textContent = s;
        sampleSelect.appendChild(o);
    }
    sampleSelect.value = lyr.sampleName ?? "";
    sampleSelect.addEventListener("change", () => {
        const v = sampleSelect.value;
        lyr.sampleName = v === "" ? null : v;
        void (async () => {
            try {
                await loadDrumKit(currentKit);
                ready = true;
            } catch (e) {
                console.warn("[drum] reload on sample change failed:", e);
            }
            refreshPadBank();
            renderLayerButtons();
        })();
    });

    // Mute toggle (drum-specific; routes through the sample-layer gain path,
    // not the OB-Xf param target).
    const muteTog = createObxdToggle({
        idx: 0,
        label: "Mute",
        initial: lyr.muted ? 1 : 0,
        w: 44,
        h: 22,
        onChange: (_i, v) => {
            lyr.muted = v >= 0.5;
            pushLayer(lyr);
        },
    });
    // Toggle factory only sizes itself when x/y are given; keep it in flow
    // and set the box manually so the SVG frame-strip is visible.
    muteTog.style.width = "44px";
    muteTog.style.height = "22px";
    muteTog.style.position = "static";

    const muteLabel = document.createElement("span");
    muteLabel.className = "drum-mute-label";
    muteLabel.textContent = "Mute";

    drumControlsEl.appendChild(sampleLabel);
    drumControlsEl.appendChild(sampleSelect);
    drumControlsEl.appendChild(muteTog);
    drumControlsEl.appendChild(muteLabel);
}

// Re-seed the per-layer knob strip values from the currently-selected drum
// layer's param store. Also refreshes the layer-strip header label.
function syncEditor(): void {
    if (layerStripLabel) {
        layerStripLabel.textContent = "Layer " + (selectedLayer + 1) + " params";
    }
    if (layerStripKnobs.length === 0) return;
    syncKnobStrips().catch((e) => console.warn("[drum] knob sync failed", e));
}

// Sync the per-layer knob strip values from the per-layer param store. Global
// knobs are fire-and-forget (no read-back), so they are intentionally skipped.
async function syncKnobStrips(): Promise<void> {
    for (const kh of layerStripKnobs) {
        const v = kh.customGet ? kh.customGet() : await drumTarget.get(kh.idx);
        if (v >= 0) kh.setValue(v);
    }
}

// --- Stylesheet (injected once) -------------------------------------------

let styleInjected = false;
function ensureStyle(): void {
    if (styleInjected) return;
    styleInjected = true;
    const css = `
.drum-root {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
    color: var(--text);
    font-family: monospace;
    font-size: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}
.drum-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.drum-header select, .drum-sample-row select {
    background: var(--bg); color: var(--text);
    border: 1px solid var(--border); padding: 4px 6px;
    border-radius: 3px; font-family: monospace;
}
.drum-btn {
    background: #333; color: var(--text);
    border: 1px solid var(--border); padding: 5px 12px;
    border-radius: 3px; cursor: pointer; font-family: monospace;
}
.drum-btn:hover { background: #444; }
.drum-btn:active { background: #222; }
.drum-status { color: var(--text-dim); margin-left: auto; }
.drum-section-label {
    font-size: 10px; color: var(--text-dim);
    text-transform: uppercase; letter-spacing: 1px;
}
.drum-pad-bank { display: flex; gap: 6px; }
.drum-pad {
    flex: 1; min-width: 64px; cursor: pointer;
    background: #222; color: var(--text);
    border: 1px solid var(--border); border-radius: 4px;
    padding: 8px 4px; display: flex; flex-direction: column;
    align-items: center; gap: 4px; font-family: monospace;
}
.drum-pad:hover { background: #2c2c2c; }
.drum-pad.selected { border-color: var(--accent); box-shadow: 0 0 6px rgba(0,204,0,0.4); }
.drum-pad-name { font-weight: bold; font-size: 11px; }
.drum-pad-note { color: var(--text-dim); font-size: 10px; }
.drum-pad-dots { display: flex; gap: 3px; }
.drum-pad-dot { width: 7px; height: 7px; border-radius: 50%; background: #444; }
.drum-pad-dot.on { background: var(--accent); }
.drum-layer-row { display: flex; gap: 6px; }
.drum-layer-btn {
    flex: 1; cursor: pointer; background: #222; color: var(--text);
    border: 1px solid var(--border); border-radius: 4px; padding: 6px;
    display: flex; flex-direction: column; align-items: center; gap: 3px;
    font-family: monospace;
}
.drum-layer-btn:hover { background: #2c2c2c; }
.drum-layer-btn.selected { border-color: var(--accent); }
.drum-layer-led { width: 9px; height: 9px; border-radius: 50%; background: #444; }
.drum-layer-led.on { background: var(--accent); }
.drum-layer-label { font-size: 11px; font-weight: bold; }
.drum-layer-sample {
    color: var(--text-dim); font-size: 10px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 100%;
}
.drum-editor { display: flex; flex-direction: column; gap: 10px; }
.drum-sample-row { display: flex; align-items: center; gap: 8px; }
.drum-sample-row select { min-width: 200px; }
.drum-mute-label { font-size: 11px; color: var(--text-dim); }
/* Host for the embedded OB-Xf editor (1150x576). buildObxdSynthUi sets
   overflowX:auto on this element so the wide panel scrolls horizontally;
   the border just frames it inside the drum rack. */
.drum-obxf-host {
    border: 1px solid var(--border);
    border-radius: 4px;
    background: #000;
    flex: 0 0 auto;
    max-width: 100%;
}
/* Drum knob strips — SVG arc knobs grouped into sections (global + per-layer)
   between the drum controls and the full OB-Xf editor. */
.drum-knob-host {
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-start;
}
.drum-knob-pair {
    display: flex;
    gap: 8px;
    align-items: flex-start;
}
.drum-knob-pair > .drum-knob-section {
    flex: 0 0 auto;
}
.drum-knob-section {
    background: rgba(0, 0, 0, 0.25);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px 8px 8px;
    flex: 0 0 auto;
}
.drum-knob-section-label {
    color: var(--text-dim);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 1px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 3px;
    margin-bottom: 4px;
}
.drum-knob-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 6px;
}
.drum-strip-knob {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    width: 44px;
    user-select: none;
}
.drum-strip-label {
    font-size: 8px;
    text-transform: uppercase;
    color: var(--text-dim);
    letter-spacing: 0.5px;
    text-align: center;
    font-family: monospace;
    white-space: nowrap;
}
.drum-strip-toggle {
    width: 44px;
    min-height: 22px;
    padding: 4px 2px;
    font-family: monospace;
    font-size: 9px;
    text-transform: uppercase;
    color: var(--text-dim);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 3px;
    cursor: pointer;
    line-height: 1.1;
}
.drum-strip-toggle:hover { background: #333; }
.drum-strip-toggle.on {
    background: #1a3a1a;
    color: var(--accent);
    border-color: var(--accent);
}
/* Horizontal pill toggle (iOS-style) — used for drum strip toggles + tri-states */
.drum-strip-pill {
    width: 40px;
    height: 20px;
    border-radius: 10px;
    background: #1a1a1a;
    border: 1px solid var(--border);
    position: relative;
    cursor: pointer;
    transition: border-color 0.15s ease;
    flex-shrink: 0;
    margin-top: 10px;
    margin-bottom: 10px;
}
.drum-strip-pill:hover { border-color: #555; }
.drum-strip-pill-knob {
    position: absolute;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #555;
    top: 2px;
    left: 2px;
    transition: left 0.15s ease;
}
.drum-strip-pill.on .drum-strip-pill-knob {
    left: 22px;
}
.drum-strip-pill.tri.on .drum-strip-pill-knob {
    left: 12px;
}
.drum-strip-pill.tri.inv .drum-strip-pill-knob {
    left: 22px;
}
`;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
}

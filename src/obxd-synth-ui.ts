/*
 * obxd-synth-ui.ts — OB-Xf editor panel (104 parameter-bound controls).
 *
 * Renders the full OB-Xf VectorTheme editor: background.svg + label overlays
 * + 104 parameter-bound knobs/toggles/selectors/sliders + special widgets
 * (programmer buttons, MPE controls, etc.).
 *
 * Layout model: every widget is absolutely positioned inside a 1150×576
 * panel (the OB-Xf VectorTheme editor canvas). All controls are visible
 * simultaneously — the OB-Xf editor is NOT a tabbed/sectioned UI.
 *
 * Engine dispatch: the OB-Xf WASM engine speaks legacy ParamsEnum.h indices
 * (0..79) plus NEW-param sentinels. A sentinel is NEW_PARAM_BASE (200) +
 * the param's CANONICAL ordinal in canonicalNewParamOrder (exported from
 * src/obxf-param-mappings.ts, generated from the spec; mirrored in
 * src/generated/param-table.json) — the same ordinal the C engine's
 * apply_new_param_instance() dispatches on. Sentinels are therefore
 * NAME-KEYED: resolveLegacyIndex() maps each control's streaming id (after
 * ID_ALIASES) to 0..79 via paramMappings, or to 200+canonical ordinal via
 * canonicalNewParamOrder. Never encounter-order — the old V1 scheme is
 * frozen in tools/new-param-order-v1.json, and src/app-state.ts migrates
 * saved V1 state to the canonical order.
 *
 * Visibility rules:
 *   - FILTER: Filter4PoleMode toggles 2-pole↔4-pole control set.
 *   - LFO 1 / LFO 2: share the same screen footprint; radio toggle switches.
 *   - GLOBAL / MPE: mpeSettingsButton toggles global knobs ↔ MPE panel.
 *   - Multi-frame labels update from param state (osc/filter/LFO) or UI state (BG/dimension).
 *   - MTS-ESP widgets hidden (browser can't reach MTS-ESP master).
 */

import {
    createObxdKnob,
    createObxdToggle,
    createTriStateButton,
    createSelector,
    createSlider,
    createButton,
    setPanOpHandler,
} from "./obxd-knob";
import type { ObxdWidget } from "./obxd-knob";
import {
    setObxdInstanceParam,
    getObxdInstanceParam,
    getObxdSelectedInstance,
    isObxdReady,
    setObxdInstanceMpe,
    applyObxdFactoryPatch,
    obxdInstanceResetPatch,
    setObxdInstanceMpeGlideRange,
    setObxdInstanceMatrixRow,
    clearObxdInstanceMatrixRow,
    getObxdInstanceVoiceActivity,
    getInstanceVolumes,
    setInstanceVolume,
} from "./obxd-audio";
import {
    obxfControls,
    obxfTheme,
    Section,
} from "./obxf-layout";
import type { ControlSpec } from "./obxf-layout";
import { paramMappings, canonicalNewParamOrder, NEW_PARAM_BASE } from "./obxf-param-mappings";
import {
    registerLearnableControl,
    deriveHintsForControl,
} from "./obxf-midi-learn-integration";
import {
    attachMidiLearnToWidget,
    setupMidiLearnOverlay,
    resetMidiLearnOverlay,
} from "./obxf-midi-learn-ui";
import { openObxfPopup } from "./obxf-popup";
import type { PopupItem } from "./obxf-popup";
import { FACTORY_PATCHES } from "./patch-catalog";
import { getInstancePatchId, getInstancePatchName, setInstancePatchIdFromEditor } from "./obxd-rack";

// ===========================================================================
// 0. Editor target abstraction (instance vs. drum layer)
// ===========================================================================

/**
 * Abstracts where the OB-Xf editor reads/writes a normalized (0..1) parameter
 * value keyed by the legacy ParamsEnum.h index. The default (no-target) path
 * routes through the OB-Xf instance API (getObxdInstanceParam /
 * setObxdInstanceParam). A drum layer supplies its own store here so the same
 * editor panel can target it instead of a synth instance.
 */
export interface ObxdParamTarget {
    get(idx: number): Promise<number>;
    set(idx: number, v: number): void;
}

/**
 * Handle returned by buildObxdSynthUi. sync() re-seeds widget positions from
 * either a fresh ObxdParamTarget, a numeric instance id, or (when neither is
 * supplied) whatever target the editor was built against / the live instance.
 */
export interface ObxdEditorHandle {
    sync(target?: ObxdParamTarget | number): Promise<void>;
}

// ===========================================================================
// 1. OB-Xf SynthParam::ID  →  legacy ParamsEnum.h index
// ===========================================================================

const idToLegacyIndex = new Map<string, number>();
for (const m of paramMappings) {
    if (m.newId && !idToLegacyIndex.has(m.newId)) {
        idToLegacyIndex.set(m.newId, m.legacyIndex);
    }
    // BENDRANGE split half: the generated table carries PitchBendDown in
    // secondaryNewId — without this entry the BendDownRange control would
    // fall through to a NEW-param sentinel (≥200) and silently stop working.
    if (m.secondaryNewId && !idToLegacyIndex.has(m.secondaryNewId)) {
        idToLegacyIndex.set(m.secondaryNewId, m.legacyIndex);
    }
}

const ID_ALIASES: Record<string, string> = {
    Osc1Vol: "Osc1Mix",
    Osc2Vol: "Osc2Mix",
    NoiseVol: "NoiseMix",
    FilterKeyTrack: "FilterKeyFollow",
    BendUpRange: "PitchBendUp",
    BendDownRange: "PitchBendDown",
    // Layout control id "RingModVol" (Mixer section) is the SAME param as the
    // canonical/streaming name "RingModMix" (C-side new_param_names[] table,
    // .fxp schema, canonicalNewParamOrder) — see the RINGMOD_NAME_DUALITY
    // anomaly in tools/new-param-order-v1.json. Without this alias the
    // name-keyed canonical lookup below would miss and the control would
    // stop dispatching to the engine.
    RingModVol: "RingModMix",
};

/**
 * Canonical NEW-param ordinal map: streaming name → position in
 * canonicalNewParamOrder. The C engine dispatches sentinel indices by
 * CANONICAL ordinal (idx = NEW_PARAM_BASE + ordinal in
 * apply_new_param_instance), so the UI MUST key sentinels by name against
 * this map — never by the order controls happen to appear in the layout.
 */
export const CANONICAL_NEW_PARAM_ORDINAL: ReadonlyMap<string, number> = new Map(
    canonicalNewParamOrder.map((name, ordinal) => [name, ordinal]),
);

/**
 * Sentinel index (≥ NEW_PARAM_BASE) for an OB-Xf-only streaming name, or
 * undefined when the name is not a canonical NEW param. Consumed by this
 * module's resolveLegacyIndex and by drum-rack.ts's NEW-param constants.
 */
export function newParamSentinel(streamingName: string): number | undefined {
    const ordinal = CANONICAL_NEW_PARAM_ORDINAL.get(streamingName);
    return ordinal === undefined ? undefined : NEW_PARAM_BASE + ordinal;
}

// Legacy ParamsEnum.h indices that have NO effect on PCM drum voices.
// Oscillators are replaced by PCM at injection (pcmGain=1), so all osc
// params, osc-targeted LFO routings, pan (overridden by pcmPan), unison
// (bypassed by PCM allocation), and portamento are inert.
const DRUM_INACTIVE_INDICES = new Set<number>([
    0, 1,       // UNDEFINED, MIDILEARN — sentinels/no-ops
    3, 4, 5,    // VOICE_COUNT, TUNE, OCTAVE — structural/osc-only
    7, 8, 9,   // BENDOSC2, LEGATOMODE, BENDLFORATE — osc/vibrato only
    12, 13, 14, 15, // ASPLAYEDALLOCATION, PORTAMENTO, UNISON, UDET — structural/osc
    16,         // OSC2_DET — osc detune
    23, 24, 26, 27, // LFO1 osc-targeted routings (LFOOSC1, LFOOSC2, LFOPW1, LFOPW2)
    28, 29,     // OSC2HS, XMOD — osc sync/crossmod
    30, 31,     // OSC1P, OSC2P — osc pitch
    32,         // OSCQuantize — removed no-op
    33, 34, 35, 36, // OSC1Saw, OSC1Pul, OSC2Saw, OSC2Pul — osc waveforms
    37,         // PW — osc pulse width
    39,         // ENVPITCH — env-to-osc-pitch
    40, 41, 42, // OSC1MIX, OSC2MIX, NOISEMIX — mixer (replaced by PCM)
    61,         // PORTADER — portamento slop (osc only)
    62, 63, 64, 65, 66, 67, 68, 69, // PAN1-PAN8 — overridden by pcmPan
    70, 71,     // UNLEARN, ECONOMY_MODE — removed no-ops
    73, 74, 75, // PW_ENV, PW_ENV_BOTH, ENV_PITCH_BOTH — osc PW/pitch
    77, 78,     // PW_OSC2_OFS, LEVEL_DIF — osc PW offset / osc level slop
]);

// Control IDs for NEW OB-Xf params (sentinel idx ≥ 200) and special widgets
// that don't affect PCM drums.
const DRUM_INACTIVE_IDS = new Set<string>([
    // NEW params — osc-only:
    "Osc2Keytrack", "EnvToPitchInvert", "EnvToPWInvert",
    "RingModVol", "NoiseColor",
    "UnisonVoices", "VoiceReassign",
    "VibratoWave",
    "LFO2ToOsc1Pitch", "LFO2ToOsc2Pitch", "LFO2ToOsc1PW", "LFO2ToOsc2PW",
    // Special widgets — osc/mixer decorative labels:
    "Osc1TriangleLabel", "Osc1PulseLabel", "Osc2TriangleLabel", "Osc2PulseLabel",
]);

const warnedUnresolvedIds = new Set<string>();

function resolveLegacyIndex(c: ControlSpec): number {
    const streamId = ID_ALIASES[c.id] ?? c.id;
    const legacy = idToLegacyIndex.get(streamId);
    if (legacy !== undefined) return legacy;
    const sentinel = newParamSentinel(streamId);
    if (sentinel !== undefined) return sentinel;
    // Neither a legacy mapping nor a canonical NEW param. Should be
    // impossible — test/sentinel-migration.test.ts walks obxfControls and
    // asserts every paramBound control resolves. Warn once per id and
    // return -1 so the control stays UI-only (no engine dispatch).
    if (!warnedUnresolvedIds.has(c.id)) {
        warnedUnresolvedIds.add(c.id);
        console.warn(
            `[obxf] control "${c.id}" resolves to neither a legacy index nor a ` +
            `canonical NEW param; it will not dispatch to the engine`,
        );
    }
    return -1;
}

// ===========================================================================
// 2. Cached widget handles
// ===========================================================================

interface ControlHandle {
    id: string;
    legacyIdx: number;
    isNew: boolean;
    valueEl: ObxdWidget;
    lastValue: number;
}

let cachedControls: ControlHandle[] = [];

let filter4PoleModeValueEl: ObxdWidget | null = null;
let filter4PoleXpanderValueEl: ObxdWidget | null = null;
let filter2PoleBPBlendDom: HTMLElement | null = null;
let filter2PolePushDom: HTMLElement | null = null;
let filter4PoleXpanderDom: HTMLElement | null = null;
let filterModeDom: HTMLElement | null = null;
let filterXpanderModeDom: HTMLElement | null = null;

let lfo1Doms: HTMLElement[] = [];
let lfo2Doms: HTMLElement[] = [];
let lfo1SelectBtn: ObxdWidget | null = null;
let lfo2SelectBtn: ObxdWidget | null = null;
let lfo1Visible = true;

let labelEls = new Map<string, HTMLElement>();
let globalPanelDoms: HTMLElement[] = [];
let mpeDoms: HTMLElement[] = [];
let mpePanelVisible = false;
let mpeDimBtns: ObxdWidget[] = [];
let selectedMpeDimension = 0;

let undoStack: number[][] = [];
let lockedParams = new Map<string, number>();
let groupSelectMode = false;
let unisonVoicesDom: HTMLElement | null = null;
let voiceLeds: HTMLElement[] = [];
let ledRafId: number | null = null;

const VOICE_LED_DEFS: { x: number; y: number; asset: string }[] = [
    { x: 895, y: 354, asset: "label-led1" }, { x: 964, y: 354, asset: "label-led1" },
    { x: 1033, y: 354, asset: "label-led1" }, { x: 1102, y: 354, asset: "label-led1" },
    { x: 895, y: 414, asset: "label-led1" }, { x: 964, y: 414, asset: "label-led1" },
    { x: 1033, y: 414, asset: "label-led1" }, { x: 1102, y: 414, asset: "label-led1" },
    { x: 895, y: 364, asset: "label-led2" }, { x: 964, y: 364, asset: "label-led2" },
    { x: 1033, y: 364, asset: "label-led2" }, { x: 1102, y: 364, asset: "label-led2" },
    { x: 895, y: 424, asset: "label-led2" }, { x: 964, y: 424, asset: "label-led2" },
    { x: 1033, y: 424, asset: "label-led2" }, { x: 1102, y: 424, asset: "label-led2" },
    { x: 895, y: 374, asset: "label-led3" }, { x: 964, y: 374, asset: "label-led3" },
    { x: 1033, y: 374, asset: "label-led3" }, { x: 1102, y: 374, asset: "label-led3" },
    { x: 895, y: 434, asset: "label-led3" }, { x: 964, y: 434, asset: "label-led3" },
    { x: 1033, y: 434, asset: "label-led3" }, { x: 1102, y: 434, asset: "label-led3" },
    { x: 895, y: 384, asset: "label-led4" }, { x: 964, y: 384, asset: "label-led4" },
    { x: 1033, y: 384, asset: "label-led4" }, { x: 1102, y: 384, asset: "label-led4" },
    { x: 895, y: 444, asset: "label-led4" }, { x: 964, y: 444, asset: "label-led4" },
    { x: 1033, y: 444, asset: "label-led4" }, { x: 1102, y: 444, asset: "label-led4" },
];

const SVG_HEIGHTS: Record<string, number> = {
    "label-bg-master": 168, "label-bg-global": 536, "label-mpe-lines": 456,
    "label-filter-mode": 224, "label-filter-options": 108,
    "label-osc-triangle": 22, "label-osc-pulse": 400, "label-lfo-wave2": 192,
};

const LABEL_DRIVER_IDS = new Set([
    "Osc1SawWave", "Osc1PulseWave", "Osc2SawWave", "Osc2PulseWave",
    "OscPW", "Osc2PWOffset",
    "Filter4PoleMode", "Filter4PoleXpander", "Filter2PoleBPBlend",
    "LFO1PW", "LFO2PW",
]);

const GLOBAL_PANEL_IDS = new Set([
    "Polyphony", "HQMode", "UnisonVoices", "Portamento",
    "Unison", "UnisonDetune", "EnvLegatoMode", "NotePriority", "VoiceReassign",
]);

function resetDynamicRefs(): void {
    filter4PoleModeValueEl = null;
    filter4PoleXpanderValueEl = null;
    filter2PoleBPBlendDom = null;
    filter2PolePushDom = null;
    filter4PoleXpanderDom = null;
    filterModeDom = null;
    filterXpanderModeDom = null;
    lfo1Doms = [];
    lfo2Doms = [];
    lfo1SelectBtn = null;
    lfo2SelectBtn = null;
    lfo1Visible = true;
    labelEls = new Map();
    globalPanelDoms = [];
    mpeDoms = [];
    mpePanelVisible = false;
    mpeDimBtns = [];
    selectedMpeDimension = 0;
    undoStack = [];
    lockedParams = new Map();
    groupSelectMode = false;
    unisonVoicesDom = null;
    voiceLeds = [];
    if (ledRafId !== null) { cancelAnimationFrame(ledRafId); ledRafId = null; }
}

function isToggleOn(el: HTMLElement | null): boolean {
    return !!el && el.classList.contains("obxd-toggle-on");
}

// ===========================================================================
// 3. Visibility rules
// ===========================================================================

function updateFilterVisibility(): void {
    const fourPole = isToggleOn(filter4PoleModeValueEl as HTMLElement);
    const xpander = isToggleOn(filter4PoleXpanderValueEl as HTMLElement);
    setDisplay(filter2PoleBPBlendDom, fourPole ? "none" : "");
    setDisplay(filter2PolePushDom, fourPole ? "none" : "");
    setDisplay(filter4PoleXpanderDom, fourPole ? "" : "none");
    setDisplay(filterModeDom, (fourPole && xpander) ? "none" : "");
    setDisplay(filterXpanderModeDom, (fourPole && xpander) ? "" : "none");
}

function updateLfoPanel(): void {
    for (const el of lfo1Doms) el.style.display = lfo1Visible ? "" : "none";
    for (const el of lfo2Doms) el.style.display = lfo1Visible ? "none" : "";
}

function selectLfo(which: 1 | 2): void {
    lfo1Visible = (which === 1);
    lfo1SelectBtn?.setValue?.(which === 1 ? 1 : 0);
    lfo2SelectBtn?.setValue?.(which === 2 ? 1 : 0);
    updateLfoPanel();
}

function setDisplay(el: HTMLElement | null, value: string): void {
    if (el) el.style.display = value;
}

function getCachedValue(id: string): number | undefined {
    const h = cachedControls.find(c => c.id === id);
    return h ? h.lastValue : undefined;
}

function setLabelFrame(id: string, frame: number): void {
    const el = labelEls.get(id);
    const spec = obxfControls.find(c => c.id === id);
    if (!el || !spec || !spec.asset) return;
    const svgH = SVG_HEIGHTS[spec.asset] ?? spec.h;
    const totalFrames = Math.floor(svgH / spec.h);
    const clamped = Math.max(0, Math.min(frame, totalFrames - 1));
    el.style.backgroundPosition = `0 -${clamped * spec.h}px`;
}

function updateParamDerivedLabels(): void {
    const osc1Saw = getCachedValue("Osc1SawWave") ?? 1;
    const osc1Pulse = getCachedValue("Osc1PulseWave") ?? 0;
    setLabelFrame("Osc1TriangleLabel", (osc1Saw < 0.5 && osc1Pulse < 0.5) ? 1 : 0);

    const oscPW = getCachedValue("OscPW") ?? 0;
    setLabelFrame("Osc1PulseLabel", Math.round(oscPW * 46));

    const osc2Saw = getCachedValue("Osc2SawWave") ?? 1;
    const osc2Pulse = getCachedValue("Osc2PulseWave") ?? 0;
    setLabelFrame("Osc2TriangleLabel", (osc2Saw < 0.5 && osc2Pulse < 0.5) ? 1 : 0);

    const osc2PWOffset = getCachedValue("Osc2PWOffset") ?? 0;
    setLabelFrame("Osc2PulseLabel", Math.min(Math.round(oscPW * 46) + Math.round(osc2PWOffset * 46), 49));

    const fourPole = (getCachedValue("Filter4PoleMode") ?? 0) >= 0.5;
    const xpander = (getCachedValue("Filter4PoleXpander") ?? 0) >= 0.5;
    const bpBlend = (getCachedValue("Filter2PoleBPBlend") ?? 0) >= 0.5;
    setLabelFrame("filterModeLabel", fourPole ? (xpander ? 3 : 2) : (bpBlend ? 1 : 0));
    setLabelFrame("filterOptionsLabel", fourPole ? 1 : 0);

    const lfo1PW = getCachedValue("LFO1PW") ?? 0;
    setLabelFrame("lfo1Wave2Label", Math.min(Math.round(lfo1PW * 24), 23));

    const lfo2PW = getCachedValue("LFO2PW") ?? 0;
    setLabelFrame("lfo2Wave2Label", Math.min(Math.round(lfo2PW * 24), 23));
}

function updateGlobalMpePanel(): void {
    for (const el of globalPanelDoms) el.style.display = mpePanelVisible ? "none" : "";
    for (const el of mpeDoms) el.style.display = mpePanelVisible ? "" : "none";
    setLabelFrame("globalBGLabel", mpePanelVisible ? 1 : 0);
}

function selectMpeDimension(dim: number): void {
    selectedMpeDimension = dim;
    for (let i = 0; i < mpeDimBtns.length; i++) {
        mpeDimBtns[i]?.setValue?.(i === dim ? 1 : 0);
    }
    setLabelFrame("mpeLinesLabel", dim);
}

const UNDO_MAX = 20;

function captureUndoSnapshot(): void {
    const snapshot = cachedControls.map(c => c.lastValue);
    undoStack.push(snapshot);
    if (undoStack.length > UNDO_MAX) undoStack.shift();
}

function restoreUndoSnapshot(): void {
    const snapshot = undoStack.pop();
    if (!snapshot) return;
    const inst = getObxdSelectedInstance();
    cachedControls.forEach((c, i) => {
        const v = snapshot[i];
        if (v !== undefined) {
            c.lastValue = v;
            if (c.valueEl.setValue) c.valueEl.setValue(v);
            setObxdInstanceParam(inst, c.legacyIdx, v);
        }
    });
    updateFilterVisibility();
    updateLfoPanel();
    updateParamDerivedLabels();
    updateUnisonDimming();
}

function randomizePatch(): void {
    captureUndoSnapshot();
    const inst = getObxdSelectedInstance();
    const specs = obxfControls.filter(c => c.paramBound !== false);
    cachedControls.forEach((c, i) => {
        const spec = specs[i];
        if (!spec) return;
        const jitter = 0.3;
        let v: number;
        if (spec.type === "toggle" || spec.type === "triState") {
            v = Math.random() < 0.5 ? spec.default : (spec.type === "triState" ? (Math.random() < 0.5 ? 0.5 : 1) : 1);
        } else {
            v = spec.default + (Math.random() - 0.5) * 2 * jitter;
            v = Math.max(0, Math.min(1, v));
        }
        c.lastValue = v;
        if (c.valueEl.setValue) c.valueEl.setValue(v);
        setObxdInstanceParam(inst, c.legacyIdx, v);
    });
    updateFilterVisibility();
    updateLfoPanel();
    updateParamDerivedLabels();
    updateUnisonDimming();
}

function applyLocks(): void {
    if (lockedParams.size === 0) return;
    const inst = getObxdSelectedInstance();
    for (const [id, v] of lockedParams) {
        const c = cachedControls.find(c => c.id === id);
        if (c) {
            c.lastValue = v;
            if (c.valueEl.setValue) c.valueEl.setValue(v);
            setObxdInstanceParam(inst, c.legacyIdx, v);
        }
    }
}

function updateUnisonDimming(): void {
    if (!unisonVoicesDom) return;
    const unison = getCachedValue("Unison") ?? 0;
    unisonVoicesDom.style.opacity = unison >= 0.5 ? "1" : "0.25";
}

const PAN_IDS = ["PanVoice1","PanVoice2","PanVoice3","PanVoice4","PanVoice5","PanVoice6","PanVoice7","PanVoice8"];

interface MpeTarget { name: string; id: string; }
const MPE_COMMON_TARGETS: MpeTarget[] = [
    { name: "Osc Pitch", id: "OscPitch" },
    { name: "Osc 1 Pitch", id: "Osc1Pitch" },
    { name: "Osc 2 Pitch", id: "Osc2Pitch" },
    { name: "Osc 2 Detune", id: "Osc2Detune" },
    { name: "Unison Detune", id: "UnisonDetune" },
    { name: "Osc Pulsewidth", id: "OscPW" },
    { name: "Osc 2 Pulsewidth Offset", id: "Osc2PWOffset" },
    { name: "Cross Modulation", id: "OscCrossmod" },
    { name: "Osc 1 Volume", id: "Osc1Mix" },
    { name: "Osc 2 Volume", id: "Osc2Mix" },
    { name: "Ring Mod Volume", id: "RingModMix" },
    { name: "Noise Volume", id: "NoiseMix" },
    { name: "Filter Cutoff", id: "FilterCutoff" },
    { name: "Filter Resonance", id: "FilterResonance" },
    { name: "LFO 1 Mod 1 Amount", id: "LFO1ModAmount1" },
    { name: "LFO 1 Mod 2 Amount", id: "LFO1ModAmount2" },
    { name: "LFO 2 Rate", id: "LFO2Rate" },
    { name: "LFO 2 Mod 1 Amount", id: "LFO2ModAmount1" },
    { name: "LFO 2 Mod 2 Amount", id: "LFO2ModAmount2" },
];
const MPE_EXTRA_TARGETS: Record<string, MpeTarget[]> = {
    Strike: [
        { name: "Filter Env Attack", id: "FilterEnvAttack" },
        { name: "Amp Env Attack", id: "AmpEnvAttack" },
    ],
    Lift: [
        { name: "Filter Env Release", id: "FilterEnvRelease" },
        { name: "Amp Env Release", id: "AmpEnvRelease" },
    ],
    Press: [],
    Slide: [],
};
function mpeMatrixTargets(dim: string): MpeTarget[] {
    return [...MPE_COMMON_TARGETS, ...(MPE_EXTRA_TARGETS[dim] ?? [])];
}
function mpeMatrixChoices(dim: string): string[] {
    return ["None", ...mpeMatrixTargets(dim).map(t => t.name)];
}

function applyPanOp(alg: string): void {
    const inst = getObxdSelectedInstance();
    const handles = PAN_IDS.map(id => cachedControls.find(c => c.id === id)).filter(Boolean) as ControlHandle[];
    handles.forEach((c, i) => {
        let v01 = 0.5;
        const spread = alg.endsWith("_25") ? 0.25 : alg.endsWith("_50") ? 0.5 : 1.0;
        if (alg === "RESET_ALL") v01 = 0.5;
        else if (alg === "RANDOMIZE") v01 = (Math.pow(Math.random() * 2 - 1, 3) + 1) / 2;
        else if (alg.startsWith("SPREAD")) v01 = 0.5 - spread / 2 + (spread / 7) * i;
        else if (alg.startsWith("ALTERNATE")) v01 = 0.5 - spread / 2 + spread * (i % 2);
        c.lastValue = v01;
        if (c.valueEl.setValue) c.valueEl.setValue(v01);
        setObxdInstanceParam(inst, c.legacyIdx, v01);
    });
}

// ===========================================================================
// 4. Widget construction
// ===========================================================================

interface BuiltWidget {
    dom: HTMLElement;
    valueEl: ObxdWidget;
}

function buildWidget(
    c: ControlSpec,
    legacyIdx: number,
    target: ObxdParamTarget | undefined,
    controls: ControlHandle[],
): BuiltWidget {
    const dispatch = (v: number): void => {
        // legacyIdx < 0 = unknown id (warned in resolveLegacyIndex; should
        // be impossible) — keep the widget interactive but skip the engine.
        if (legacyIdx >= 0) {
            if (target) {
                target.set(legacyIdx, v);
            } else {
                setObxdInstanceParam(getObxdSelectedInstance(), legacyIdx, v);
            }
        }
        const handle = controls.find(ch => ch.legacyIdx === legacyIdx && ch.id === c.id);
        if (handle) handle.lastValue = v;
        if (LABEL_DRIVER_IDS.has(c.id)) updateParamDerivedLabels();
        if (c.id === "Unison") updateUnisonDimming();
    };
    const maybeRefreshFilter = (): void => {
        if (c.id === "Filter4PoleMode" || c.id === "Filter4PoleXpander") {
            updateFilterVisibility();
            updateParamDerivedLabels();
        }
    };

    switch (c.type) {
        case "knob": {
            const knob = createObxdKnob({
                idx: legacyIdx, label: c.label, initial: c.default,
                defaultValue: c.default, paramId: c.id,
                onChange: (_i, v) => { dispatch(v); maybeRefreshFilter(); },
                asset: c.asset, size: c.w || 40,
            });
            knob.style.left = c.x + "px";
            knob.style.top = c.y + "px";
            return { dom: knob, valueEl: knob };
        }
        case "toggle": {
            const tog = createObxdToggle({
                idx: legacyIdx, label: c.label, initial: c.default,
                onChange: (_i, v) => { dispatch(v); maybeRefreshFilter(); },
                asset: c.asset, x: c.x, y: c.y, w: c.w, h: c.h,
            });
            return { dom: tog, valueEl: tog };
        }
        case "triState": {
            const el = createTriStateButton({
                x: c.x, y: c.y, w: c.w, h: c.h,
                labels: c.triStateMeaning ?? { zero: "Off", half: "On", one: "Inv" },
                initialValue: c.default,
                onChange: (v) => { dispatch(v); maybeRefreshFilter(); },
                asset: c.asset,
            });
            return { dom: el, valueEl: el };
        }
        case "selector": {
            const choices = c.choices ?? [];
            const safeChoices = choices.length > 0 ? choices : ["—"];
            const initIdx = choices.length > 1
                ? clampInt(Math.round(c.default * (choices.length - 1)), 0, choices.length - 1) : 0;
            const el = createSelector({
                x: c.x, y: c.y, w: c.w, h: c.h, choices: safeChoices, initialIndex: initIdx,
                label: c.label,
                onChange: (selIdx) => {
                    const norm = safeChoices.length > 1 ? selIdx / (safeChoices.length - 1) : 0;
                    dispatch(norm); maybeRefreshFilter();
                },
                asset: c.asset,
            });
            return { dom: el, valueEl: el };
        }
        case "slider": {
            const el = createSlider({
                x: c.x, y: c.y, w: c.w, h: c.h,
                orientation: c.w >= c.h ? "horizontal" : "vertical",
                initialValue: c.default,
                onChange: (v) => { dispatch(v); maybeRefreshFilter(); },
                asset: c.asset,
            });
            return { dom: el, valueEl: el };
        }
        default:
            throw new Error(`unsupported param-bound type "${c.type}" for "${c.id}"`);
    }
}

// --- Special widgets (paramBound:false, non-label) ---

function buildSpecialWidget(c: ControlSpec): HTMLElement | null {
    switch (c.type) {
        case "knob": {
            const knob = createObxdKnob({
                idx: -1, label: c.label, initial: c.default,
                defaultValue: c.default,
                onChange: (_i, _v) => { onSpecialKnob(c.id, _v); },
                asset: c.asset, size: c.w || 40,
            });
            knob.style.left = c.x + "px";
            knob.style.top = c.y + "px";
            return knob;
        }
        case "slider":
            return createSlider({
                x: c.x, y: c.y, w: c.w, h: c.h,
                orientation: c.w >= c.h ? "horizontal" : "vertical",
                initialValue: c.default,
                onChange: (_v) => { onSpecialKnob(c.id, _v); },
                asset: c.asset,
            });
        case "toggle":
            return createObxdToggle({
                idx: -1, label: c.label, initial: c.default,
                onChange: (_idx, v) => { onSpecialToggle(c.id, v >= 0.5); },
                asset: c.asset, x: c.x, y: c.y, w: c.w, h: c.h,
            });
        case "button":
            return createButton({
                x: c.x, y: c.y, w: c.w, h: c.h, asset: c.asset, label: c.label,
                onClick: () => { onSpecialButton(c.id); },
            });
        case "selector": {
            let choices = c.choices && c.choices.length > 0 ? c.choices : ["—"];
            const mpeDestMatch = c.id.match(/^mpe(Strike|Lift|Press|Slide)Destination\d$/);
            if (mpeDestMatch) choices = mpeMatrixChoices(mpeDestMatch[1]);
            return createSelector({
                x: c.x, y: c.y, w: c.w, h: c.h, choices, initialIndex: 0,
                asset: c.asset, label: c.label, onChange: (idx) => { onSpecialSelect(c.id, idx); },
            });
        }
        default:
            return null;
    }
}

function onSpecialKnob(_id: string, _v: number): void {
    const mpeMatch = _id.match(/^mpe(Strike|Lift|Press|Slide)Amount(\d)$/);
    if (mpeMatch) {
        const dim = mpeMatch[1];
        const slot = parseInt(mpeMatch[2], 10);
        const dimIdx = ["Strike", "Lift", "Press", "Slide"].indexOf(dim);
        const row = dimIdx * 2 + (slot - 1);
        const inst = getObxdSelectedInstance();
        const depth = _v * 2 - 1;
        const tgt = mpeMatrixTargetState.get(row);
        if (tgt) setObxdInstanceMatrixRow(inst, row, dim, tgt, depth);
    }
}

const mpeMatrixTargetState = new Map<number, string>();

// DOM overlays for the patch name + number display in the Programmer footer.
let patchNameDisplay: HTMLDivElement | null = null;
let patchNumberDisplay: HTMLDivElement | null = null;

function onSpecialToggle(id: string, on: boolean): void {
    switch (id) {
        case "mpeButton": setObxdInstanceMpe(getObxdSelectedInstance(), on); break;
        case "mpeSettingsButton":
            mpePanelVisible = on;
            updateGlobalMpePanel();
            break;
        case "mpeStrikeSelectButton": if (on) selectMpeDimension(0); break;
        case "mpeLiftSelectButton":   if (on) selectMpeDimension(1); break;
        case "mpePressSelectButton":  if (on) selectMpeDimension(2); break;
        case "mpeSlideSelectButton":  if (on) selectMpeDimension(3); break;
        case "groupSelectButton":
            groupSelectMode = on;
            break;
        case "lockHQButton":
            if (on) lockedParams.set("HQMode", getCachedValue("HQMode") ?? 0);
            else lockedParams.delete("HQMode");
            break;
        case "lockBendRangeButton":
            if (on) {
                lockedParams.set("BendUpRange", getCachedValue("BendUpRange") ?? 0);
                lockedParams.set("BendDownRange", getCachedValue("BendDownRange") ?? 0);
            } else {
                lockedParams.delete("BendUpRange");
                lockedParams.delete("BendDownRange");
            }
            break;
    }
}

function onSpecialButton(id: string): void {
    const inst = getObxdSelectedInstance();
    switch (id) {
        case "prevPatchButton": {
            captureUndoSnapshot();
            const cur = getInstancePatchId(inst);
            const next = Math.max(0, cur - 1);
            if (next === cur) break;
            setInstancePatchIdFromEditor(inst, next);
            applyObxdFactoryPatch(inst, next);
            syncObxdControlsFromEngine(inst);
            updatePatchDisplay(inst);
            break;
        }
        case "nextPatchButton": {
            captureUndoSnapshot();
            const cur = getInstancePatchId(inst);
            const max = FACTORY_PATCHES.length - 1;
            const next = Math.min(max, cur < 0 ? 0 : cur + 1);
            if (next === cur) break;
            setInstancePatchIdFromEditor(inst, next);
            applyObxdFactoryPatch(inst, next);
            syncObxdControlsFromEngine(inst);
            updatePatchDisplay(inst);
            break;
        }
        case "initPatchButton":
            captureUndoSnapshot();
            obxdInstanceResetPatch(inst);
            syncObxdControlsFromEngine(inst);
            updatePatchDisplay(inst);
            break;
        case "undoPatchButton":
            restoreUndoSnapshot();
            break;
        case "randomizePatchButton":
            randomizePatch();
            break;
        case "savePatchButton":
            console.info("[obxf] Save patch — requires _obxd_save_fxp (Wave 4 engine export)");
            break;
        case "mainMenu": {
            const menuEl = document.querySelector('[title="Main Menu"]') as HTMLElement;
            const anchor = menuEl ? menuEl.getBoundingClientRect() : new DOMRect(60, 415, 23, 35);
            const items: (PopupItem | "separator")[] = [
                { text: "Initialize Patch", onClick: () => onSpecialButton("initPatchButton") },
                { text: "Undo", onClick: () => onSpecialButton("undoPatchButton") },
                { text: "Randomize Patch", onClick: () => onSpecialButton("randomizePatchButton") },
                "separator",
                {
                    text: "About OB-Xf",
                    onClick: () => console.info("[obxf] OB-Xf — Surge Synth Team, GPL-3.0-or-later"),
                },
            ];
            openObxfPopup({ anchor, header: "Main Menu", items });
            break;
        }
        default:
            if (/^select\d+Button$/.test(id)) {
                const n = parseInt(id.replace("select", "").replace("Button", ""), 10);
                if (groupSelectMode) {
                    console.info(`[obxf] Group select ${n} — single group in browser build`);
                } else {
                    const patchId = n - 1;
                    if (patchId >= 0 && patchId < FACTORY_PATCHES.length) {
                        captureUndoSnapshot();
                        setInstancePatchIdFromEditor(inst, patchId);
                        applyObxdFactoryPatch(inst, patchId);
                        syncObxdControlsFromEngine(inst);
                        updatePatchDisplay(inst);
                    }
                }
            }
            break;
    }
}

function onSpecialSelect(id: string, idx: number): void {
    const inst = getObxdSelectedInstance();
    if (id === "mpeGlideRangeMenu") {
        setObxdInstanceMpeGlideRange(inst, idx);
        return;
    }
    const mpeMatch = id.match(/^mpe(Strike|Lift|Press|Slide)Destination(\d)$/);
    if (mpeMatch) {
        const dim = mpeMatch[1];
        const slot = parseInt(mpeMatch[2], 10);
        const dimIdx = ["Strike", "Lift", "Press", "Slide"].indexOf(dim);
        const row = dimIdx * 2 + (slot - 1);
        if (idx === 0) {
            mpeMatrixTargetState.delete(row);
            clearObxdInstanceMatrixRow(inst, row);
        } else {
            const targets = mpeMatrixTargets(dim);
            const tgt = targets[idx - 1];
            if (tgt) {
                mpeMatrixTargetState.set(row, tgt.id);
                const amountId = `mpe${dim}Amount${slot}Knob`;
                const amountHandle = cachedControls.find(c => c.id === amountId);
                const depth = amountHandle ? (amountHandle.lastValue * 2 - 1) : 0;
                setObxdInstanceMatrixRow(inst, row, dim, tgt.id, depth);
            }
        }
    }
}

// --- LFO selector ---

function buildLfoSelector(panel: HTMLElement): void {
    const lfo1Spec = obxfControls.find(c => c.id === "lfo1SelectButton")!;
    const lfo2Spec = obxfControls.find(c => c.id === "lfo2SelectButton")!;

    lfo1SelectBtn = createObxdToggle({
        idx: -1, label: "LFO 1", initial: 1, onChange: () => selectLfo(1),
        asset: lfo1Spec.asset, x: lfo1Spec.x, y: lfo1Spec.y, w: lfo1Spec.w, h: lfo1Spec.h,
    });
    lfo1SelectBtn.title = "Select LFO 1";
    panel.appendChild(lfo1SelectBtn);

    lfo2SelectBtn = createObxdToggle({
        idx: -1, label: "LFO 2", initial: 0, onChange: () => selectLfo(2),
        asset: lfo2Spec.asset, x: lfo2Spec.x, y: lfo2Spec.y, w: lfo2Spec.w, h: lfo2Spec.h,
    });
    lfo2SelectBtn.title = "Select LFO 2";
    panel.appendChild(lfo2SelectBtn);
}

// ===========================================================================
// 5. Public API
// ===========================================================================

export function buildObxdSynthUi(
    container: HTMLElement,
    target?: ObxdParamTarget,
): ObxdEditorHandle {
    container.textContent = "";
    // LOCAL control cache for this editor instance. The no-target (Synth view)
    // build also aliases the module-level cachedControls to this same array so
    // the existing syncObxdControlsFromEngine(instanceId) and the label/lock
    // helpers keep working unchanged. A targeted (drum) build keeps its cache
    // strictly local so it never pollutes the Synth view's module-level state.
    const controls: ControlHandle[] = [];
    const drumMode = !!target;
    if (!target) {
        cachedControls = controls;
    }
    resetDynamicRefs();
    resetMidiLearnOverlay();

    // Root OB-Xf editor canvas (1150×576).
    const panel = document.createElement("div");
    panel.className = "obxf-editor-panel";
    panel.style.position = "relative";
    panel.style.width = obxfTheme.width + "px";
    panel.style.height = obxfTheme.height + "px";
    panel.style.backgroundImage = "url(/obxf-assets/background.svg)";
    panel.style.backgroundSize = "100% 100%";
    panel.style.backgroundRepeat = "no-repeat";
    panel.style.overflow = "hidden";
    panel.style.flex = "0 0 auto";
    panel.style.color = "#fff";
    panel.style.fontFamily = '"Jersey20", system-ui, sans-serif';
    panel.style.transformOrigin = "top left";

    if (!drumMode) {
        container.style.position = "relative";
        container.style.display = "flex";
        container.style.justifyContent = "center";
        container.style.alignItems = "center";
        container.style.overflow = "hidden";
        container.style.flex = "1 1 auto";
        container.style.width = "100%";
    }

    // Static label/background SVGs (underneath controls, above background.svg).
    const staticLabels = obxfControls.filter(c =>
        c.paramBound === false && c.asset && c.asset.startsWith("label-") &&
        !(drumMode && (c.section === Section.Oscillators || c.section === Section.Mixer || c.section === Section.Voice || c.section === Section.MPE)));
    for (const c of staticLabels) {
        const el = document.createElement("div");
        el.style.position = "absolute";
        el.style.left = c.x + "px";
        el.style.top = c.y + "px";
        el.style.width = c.w + "px";
        el.style.height = c.h + "px";
        el.style.overflow = "hidden";
        el.style.pointerEvents = "none";
        el.style.backgroundImage = `url(/obxf-assets/${c.asset}.svg)`;
        el.style.backgroundRepeat = "no-repeat";
        el.style.backgroundPosition = "0 0";
        el.style.backgroundSize = "100% auto";
        panel.appendChild(el);
        labelEls.set(c.id, el);
        if (c.section === Section.MPE) {
            mpeDoms.push(el);
            el.style.display = "none";
        }
    }

    // Patch name + number display overlays (Programmer footer).
    if (!drumMode) {
        patchNumberDisplay = document.createElement("div");
        patchNumberDisplay.style.cssText =
            "position:absolute;left:56px;top:506px;width:43px;height:31px;" +
            "display:flex;align-items:center;justify-content:center;" +
            'font-family:"Jersey20",monospace;font-size:16px;color:#ff0000;' +
            "pointer-events:none;overflow:hidden;";
        panel.appendChild(patchNumberDisplay);

        patchNameDisplay = document.createElement("div");
        patchNameDisplay.style.cssText =
            "position:absolute;left:103px;top:506px;width:166px;height:31px;" +
            "display:flex;align-items:center;padding:0 6px;" +
            'font-family:"Jersey20",monospace;font-size:16px;color:#ff0000;' +
            "pointer-events:none;overflow:hidden;white-space:nowrap;";
        panel.appendChild(patchNameDisplay);
    }

    // Voice LEDs (32 per instance, bottom-right of panel). Skipped in drum mode.
    if (!drumMode) {
    for (const def of VOICE_LED_DEFS) {
        const led = document.createElement("div");
        led.style.cssText = `position: absolute; left: ${def.x}px; top: ${def.y}px; width: 9px; height: 9px; overflow: hidden; pointer-events: none; background-image: url(/obxf-assets/${def.asset}.svg); background-repeat: no-repeat; background-size: 100% auto; opacity: 0.2;`;
        panel.appendChild(led);
        voiceLeds.push(led);
    }

    function updateVoiceLeds(): void {
        const inst = getObxdSelectedInstance();
        const mask = getObxdInstanceVoiceActivity()[inst] >>> 0;
        const poly = Math.round((getCachedValue("Polyphony") ?? 0.25) * 31) + 1;
        for (let i = 0; i < 32; i++) {
            if (!voiceLeds[i]) continue;
            const active = (mask & (1 << i)) !== 0;
            voiceLeds[i].style.opacity = i < poly ? (active ? "1" : "0.2") : "0";
        }
        ledRafId = requestAnimationFrame(updateVoiceLeds);
    }
    if (voiceLeds.length > 0) updateVoiceLeds();
    }

    // Parameter-bound controls (the 104) — ALL directly on the panel.
    const paramBound = obxfControls.filter(c =>
        c.paramBound !== false &&
        !(drumMode && (DRUM_INACTIVE_INDICES.has(resolveLegacyIndex(c)) || DRUM_INACTIVE_IDS.has(c.id))));
    for (const c of paramBound) {
        const legacyIdx = resolveLegacyIndex(c);
        const isNew = legacyIdx >= NEW_PARAM_BASE;

        const { dom, valueEl } = buildWidget(c, legacyIdx, target, controls);
        panel.appendChild(dom);

        registerLearnableControl(c.id, legacyIdx, deriveHintsForControl(c));
        attachMidiLearnToWidget(dom, c, panel);

        controls.push({ id: c.id, legacyIdx, isNew, valueEl, lastValue: c.default });

        if (c.section === Section.LFO1) lfo1Doms.push(dom);
        if (c.section === Section.LFO2) lfo2Doms.push(dom);
        if (c.section === Section.Global && GLOBAL_PANEL_IDS.has(c.id)) globalPanelDoms.push(dom);
        switch (c.id) {
            case "Filter4PoleMode":   filter4PoleModeValueEl = valueEl; break;
            case "Filter4PoleXpander":
                filter4PoleXpanderValueEl = valueEl;
                filter4PoleXpanderDom = dom;
                break;
            case "Filter2PoleBPBlend": filter2PoleBPBlendDom = dom; break;
            case "Filter2PolePush":    filter2PolePushDom = dom; break;
            case "FilterMode":         filterModeDom = dom; break;
            case "FilterXpanderMode":  filterXpanderModeDom = dom; break;
            case "UnisonVoices":       unisonVoicesDom = dom; break;
        }
    }

    // Interactive special widgets (programmer buttons, MPE, etc.).
    const skipIds = new Set(["midiLearnButton", "patchNameLabel", "patchNumberMenu",
        "aboutButton", "mtsSettingsButton", "settingsButton", "mtsDynamicButton", "mtsStatusLabel",
        "lfo1SelectButton", "lfo2SelectButton"]);
    const specials = obxfControls.filter(c =>
        c.paramBound === false && c.asset && !c.asset.startsWith("label-") && !skipIds.has(c.id) &&
        !(drumMode && (DRUM_INACTIVE_IDS.has(c.id) || c.section === Section.Oscillators || c.section === Section.Mixer || c.section === Section.Programmer || c.section === Section.MPE || c.section === Section.Global || c.section === Section.Control || c.section === Section.Voice)));
    for (const c of specials) {
        const dom = buildSpecialWidget(c);
        if (dom) {
            panel.appendChild(dom);
            if (c.id === "lockHQButton") globalPanelDoms.push(dom);
            if (c.section === Section.MPE && c.id !== "mpeSettingsButton") {
                mpeDoms.push(dom);
                if (c.id === "mpeStrikeSelectButton") mpeDimBtns[0] = dom as ObxdWidget;
                else if (c.id === "mpeLiftSelectButton") mpeDimBtns[1] = dom as ObxdWidget;
                else if (c.id === "mpePressSelectButton") mpeDimBtns[2] = dom as ObxdWidget;
                else if (c.id === "mpeSlideSelectButton") mpeDimBtns[3] = dom as ObxdWidget;
            }
        }
    }

    buildLfoSelector(panel);
    setPanOpHandler(applyPanOp);
    updateFilterVisibility();
    updateLfoPanel();
    updateGlobalMpePanel();
    selectMpeDimension(0);
    updateParamDerivedLabels();
    updateUnisonDimming();
    setupMidiLearnOverlay(panel);

    container.appendChild(panel);

    if (!drumMode) {
        const fitPanel = () => {
            const w = container.clientWidth;
            const h = container.clientHeight;
            if (w > 0 && h > 0) {
                const s = Math.min(w / obxfTheme.width, h / obxfTheme.height);
                panel.style.transform = `scale(${s})`;
                panel.style.left = ((w - obxfTheme.width * s) / 2) + "px";
                panel.style.top = ((h - obxfTheme.height * s) / 2) + "px";
            }
        };
        panel.style.position = "absolute";
        fitPanel();
        new ResizeObserver(fitPanel).observe(container);
    }

    const newParamIds = controls.filter(c => c.isNew).map(c => c.id);
    if (newParamIds.length > 0) {
        console.info(
            `[obxf] ${paramBound.length} controls built; ${newParamIds.length} are ` +
            `NEW OB-Xf params (name-keyed canonical sentinels): ` + newParamIds.join(", "),
        );
    } else {
        console.info(`[obxf] ${paramBound.length} controls built`);
    }

    const sync = async (targetArg?: ObxdParamTarget | number): Promise<void> => {
        // Resolve the effective read source. A per-call target wins, then the
        // build-time target, then the default instance path via the live
        // selected instance. A numeric arg is treated as an explicit instance id.
        let getter: (idx: number) => Promise<number>;
        if (typeof targetArg === "number") {
            const inst = targetArg;
            getter = (idx: number) => getObxdInstanceParam(inst, idx);
        } else if (targetArg) {
            getter = (idx: number) => targetArg.get(idx);
        } else if (target) {
            getter = (idx: number) => target.get(idx);
        } else {
            const inst = getObxdSelectedInstance();
            getter = (idx: number) => getObxdInstanceParam(inst, idx);
        }

        await Promise.all(controls.map(async (c) => {
            const v = await getter(c.legacyIdx);
            if (v >= 0) {
                c.lastValue = v;
                if (c.valueEl.setValue) c.valueEl.setValue(v);
            }
        }));

        refreshEditorChrome();
        updatePatchDisplay(typeof targetArg === "number" ? targetArg : getObxdSelectedInstance());
    };

    return { sync };
}

/**
 * Post-sync refresh of editor chrome (filter visibility, LFO panel,
 * param-derived labels, param locks, unison dimming). Shared by both the
 * instance-based syncObxdControlsFromEngine and the handle.sync path so the
 * two never drift out of step.
 */
function refreshEditorChrome(): void {
    updateFilterVisibility();
    updateLfoPanel();
    updateParamDerivedLabels();
    applyLocks();
    updateUnisonDimming();
}

/*
 * Update the patch name + number display overlays in the Programmer footer.
 * Called on patch navigation (prev/next/select), instance switch, and init.
 */
function updatePatchDisplay(inst: number): void {
    if (!patchNameDisplay || !patchNumberDisplay) return;
    const patchId = getInstancePatchId(inst);
    if (patchId >= 0 && patchId < FACTORY_PATCHES.length) {
        const p = FACTORY_PATCHES[patchId];
        patchNameDisplay.textContent = p.name;
        patchNumberDisplay.textContent = String(patchId + 1).padStart(3, "0");
    } else {
        // A loaded .fxp file has no factory ID — show its name if we have it,
        // otherwise the init label.
        const customName = getInstancePatchName(inst);
        patchNameDisplay.textContent = customName || "— init —";
        patchNumberDisplay.textContent = "---";
    }
}

export async function syncObxdControlsFromEngine(instanceId: number): Promise<void> {
    if (cachedControls.length === 0) return;
    if (!isObxdReady()) return;

    // Instant: set the Volume knob from the shared variable (same source as
    // the mixer fader) so there's no flash of a stale default while the
    // async engine reads below complete.
    const volCtl = cachedControls.find((c) => c.legacyIdx === 2);
    if (volCtl && volCtl.valueEl.setValue) {
        volCtl.valueEl.setValue(getInstanceVolumes()[instanceId]);
    }

    await Promise.all(cachedControls.map(async (c) => {
        const v = await getObxdInstanceParam(instanceId, c.legacyIdx);
        if (v >= 0) {
            c.lastValue = v;
            if (c.valueEl.setValue) c.valueEl.setValue(v);
            // Reconcile the shared variable for Volume so a .fxp patch load
            // (which changes the engine without going through
            // setObxdInstanceParam) keeps the mixer fader in sync too.
            if (c.legacyIdx === 2) setInstanceVolume(instanceId, v);
        }
    }));

    refreshEditorChrome();
    updatePatchDisplay(instanceId);
}

// ===========================================================================

function clampInt(v: number, lo: number, hi: number): number {
    if (Number.isNaN(v)) return lo;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return Math.round(v);
}

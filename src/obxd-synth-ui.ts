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
 * (0..79) plus NEW-param sentinels (≥200). src/obxf-param-mappings.ts maps
 * OB-Xf SynthParam::ID strings to those indices.
 *
 * Visibility rules:
 *   - FILTER: Filter4PoleMode toggles 2-pole↔4-pole control set.
 *   - LFO 1 / LFO 2: share the same screen footprint; radio toggle switches.
 */

import {
    createObxdKnob,
    createObxdToggle,
    createTriStateButton,
    createSelector,
    createSlider,
    createButton,
} from "./obxd-knob";
import type { ObxdWidget } from "./obxd-knob";
import {
    setObxdInstanceParam,
    getObxdInstanceParam,
    getObxdSelectedInstance,
    isObxdReady,
    setObxdInstanceMpe,
    applyObxdFactoryPatch,
} from "./obxd-audio";
import {
    obxfControls,
    obxfTheme,
    Section,
} from "./obxf-layout";
import type { ControlSpec } from "./obxf-layout";
import { paramMappings } from "./obxf-param-mappings";
import {
    registerLearnableControl,
    deriveHintsForControl,
} from "./obxf-midi-learn-integration";
import {
    attachMidiLearnToWidget,
    setupMidiLearnOverlay,
    resetMidiLearnOverlay,
} from "./obxf-midi-learn-ui";

// ===========================================================================
// 1. OB-Xf SynthParam::ID  →  legacy ParamsEnum.h index
// ===========================================================================

const idToLegacyIndex = new Map<string, number>();
for (const m of paramMappings) {
    if (m.newId && !idToLegacyIndex.has(m.newId)) {
        idToLegacyIndex.set(m.newId, m.legacyIndex);
    }
}

const ID_ALIASES: Record<string, string> = {
    Osc1Vol: "Osc1Mix",
    Osc2Vol: "Osc2Mix",
    NoiseVol: "NoiseMix",
    FilterKeyTrack: "FilterKeyFollow",
    BendUpRange: "PitchBendUp",
    BendDownRange: "PitchBendDown",
};

const NEW_PARAM_BASE = 200;
const NEW_PARAM_IDS: string[] = [];

function resolveLegacyIndex(c: ControlSpec): number {
    const streamId = ID_ALIASES[c.id] ?? c.id;
    const legacy = idToLegacyIndex.get(streamId);
    if (legacy !== undefined) return legacy;
    return NEW_PARAM_BASE + NEW_PARAM_IDS.length;
}

// ===========================================================================
// 2. Cached widget handles
// ===========================================================================

interface ControlHandle {
    legacyIdx: number;
    isNew: boolean;
    valueEl: ObxdWidget;
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

// ===========================================================================
// 4. Widget construction
// ===========================================================================

interface BuiltWidget {
    dom: HTMLElement;
    valueEl: ObxdWidget;
}

function buildWidget(c: ControlSpec, legacyIdx: number): BuiltWidget {
    const dispatch = (v: number): void => {
        setObxdInstanceParam(getObxdSelectedInstance(), legacyIdx, v);
    };
    const maybeRefreshFilter = (): void => {
        if (c.id === "Filter4PoleMode" || c.id === "Filter4PoleXpander") {
            updateFilterVisibility();
        }
    };

    switch (c.type) {
        case "knob": {
            const knob = createObxdKnob({
                idx: legacyIdx, label: c.label, initial: c.default,
                defaultValue: c.default,
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
        case "toggle":
            return createObxdToggle({
                idx: -1, label: c.label, initial: c.default,
                onChange: (_idx, v) => { onSpecialToggle(c.id, v >= 0.5); },
                asset: c.asset, x: c.x, y: c.y, w: c.w, h: c.h,
            });
        case "button":
            return createButton({
                x: c.x, y: c.y, w: c.w, h: c.h, asset: c.asset,
                onClick: () => { onSpecialButton(c.id); },
            });
        case "selector": {
            const choices = c.choices && c.choices.length > 0 ? c.choices : ["—"];
            return createSelector({
                x: c.x, y: c.y, w: c.w, h: c.h, choices, initialIndex: 0,
                asset: c.asset, onChange: (idx) => { onSpecialSelect(c.id, idx); },
            });
        }
        default:
            return null;
    }
}

let g_specialPatchId = 0;

function onSpecialToggle(id: string, on: boolean): void {
    switch (id) {
        case "mpeButton": setObxdInstanceMpe(getObxdSelectedInstance(), on); break;
    }
}

function onSpecialButton(id: string): void {
    const inst = getObxdSelectedInstance();
    switch (id) {
        case "prevPatchButton":
            g_specialPatchId = Math.max(0, g_specialPatchId - 1);
            applyObxdFactoryPatch(inst, g_specialPatchId);
            syncObxdControlsFromEngine(inst);
            break;
        case "nextPatchButton":
            g_specialPatchId = Math.min(9, g_specialPatchId + 1);
            applyObxdFactoryPatch(inst, g_specialPatchId);
            syncObxdControlsFromEngine(inst);
            break;
    }
}

function onSpecialSelect(_id: string, _idx: number): void {}

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

export function buildObxdSynthUi(container: HTMLElement): void {
    container.textContent = "";
    cachedControls = [];
    NEW_PARAM_IDS.length = 0;
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

    container.style.overflowX = "auto";
    container.style.overflowY = "hidden";
    container.style.alignItems = "flex-start";

    // Static label/background SVGs (underneath controls, above background.svg).
    const staticLabels = obxfControls.filter(c =>
        c.paramBound === false && c.asset && c.asset.startsWith("label-"));
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
    }

    // Parameter-bound controls (the 104) — ALL directly on the panel.
    const paramBound = obxfControls.filter(c => c.paramBound !== false);
    for (const c of paramBound) {
        const legacyIdx = resolveLegacyIndex(c);
        const isNew = legacyIdx >= NEW_PARAM_BASE;
        if (isNew) NEW_PARAM_IDS.push(c.id);

        const { dom, valueEl } = buildWidget(c, legacyIdx);
        panel.appendChild(dom);

        registerLearnableControl(c.id, legacyIdx, deriveHintsForControl(c));
        attachMidiLearnToWidget(dom, c, panel);

        cachedControls.push({ legacyIdx, isNew, valueEl });

        if (c.section === Section.LFO1) lfo1Doms.push(dom);
        if (c.section === Section.LFO2) lfo2Doms.push(dom);
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
        }
    }

    // Interactive special widgets (programmer buttons, MPE, etc.).
    const skipIds = new Set(["midiLearnButton", "patchNameLabel", "patchNumberMenu",
        "aboutButton", "mtsSettingsButton", "settingsButton"]);
    const specials = obxfControls.filter(c =>
        c.paramBound === false && c.asset && !c.asset.startsWith("label-") && !skipIds.has(c.id));
    for (const c of specials) {
        const dom = buildSpecialWidget(c);
        if (dom) panel.appendChild(dom);
    }

    buildLfoSelector(panel);
    updateFilterVisibility();
    updateLfoPanel();
    setupMidiLearnOverlay(panel);

    container.appendChild(panel);

    if (NEW_PARAM_IDS.length > 0) {
        console.info(
            `[obxf] ${paramBound.length} controls built; ${NEW_PARAM_IDS.length} are ` +
            `NEW OB-Xf params: ` + NEW_PARAM_IDS.join(", "),
        );
    } else {
        console.info(`[obxf] ${paramBound.length} controls built`);
    }
}

export async function syncObxdControlsFromEngine(instanceId: number): Promise<void> {
    if (cachedControls.length === 0) return;
    if (!isObxdReady()) return;

    await Promise.all(cachedControls.map(async (c) => {
        const v = await getObxdInstanceParam(instanceId, c.legacyIdx);
        if (v >= 0 && c.valueEl.setValue) c.valueEl.setValue(v);
    }));

    updateFilterVisibility();
    updateLfoPanel();
}

// ===========================================================================

function clampInt(v: number, lo: number, hi: number): number {
    if (Number.isNaN(v)) return lo;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return Math.round(v);
}

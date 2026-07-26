/*
 * obxd-synth-ui.ts — OB-Xf editor panel (104 parameter-bound controls).
 *
 * This is the OB-Xf editor port. It replaces the old ~30-knob OB-XD grid
 * with the full OB-Xf panel layout from src/obxf-layout.ts:
 *
 *   MASTER (3)        — Volume / Transpose / Tune
 *   GLOBAL (9)        — Polyphony / HQMode / UnisonVoices / Portamento /
 *                       Unison / UnisonDetune / EnvLegatoMode / NotePriority /
 *                       VoiceReassign
 *   OSCILLATORS (19)  — pitch / wave / pulsewidth / env-to-X / crossmod / sync …
 *   MIXER (5)         — Osc1/2 vol, RingMod, Noise, NoiseColor
 *   CONTROL (5)       — bend up/down, BendOsc2Only, VibratoWave/Rate
 *   FILTER (10)       — cutoff/reso/env/keytrack/mode + 4-pole/xpander variants
 *   LFO 1 (14) + LFO 2 (14) — rate/amounts/waves/PW + 6 tri-state routings each
 *   FILTER ENV (7)    — ADSR + attack curve + vel
 *   AMP ENV (6)       — ADSR + attack curve + vel
 *   VOICE (12)        — 4 slop knobs + Pan1..8
 *
 * Total: 104 parameter-bound controls. The 69 special widgets from
 * obxf-layout.ts (programmer row, MPE matrix, voice LEDs, panel-selector
 * radios, modal dialogs, decorative labels) are intentionally skipped here
 * — they belong to separate tasks (T19 MPE, T23 programmer, …).
 *
 * Layout model: every widget is absolutely positioned inside a 1150×576
 * panel (the OB-Xf VectorTheme editor canvas, see obxfTheme in
 * obxf-layout.ts). Coordinates come straight from each ControlSpec's
 * x/y/w/h. The widget primitives in obxd-knob.ts are reused unchanged:
 *   - createObxdKnob / createObxdToggle: do NOT take x/y/w/h, so they are
 *     wrapped/placed here.
 *   - createTriStateButton / createSelector / createSlider: self-positioning
 *     (they call applyBounds internally) and are appended directly.
 *
 * Engine dispatch: the OB-XD WASM engine still speaks the legacy
 * ParamsEnum.h integer indices (0..79). src/obxf-param-mappings.ts maps
 * OB-Xf SynthParam::ID strings to those legacy indices. For each control
 * we resolve id → legacyIndex once at build time; the knob/toggle/…
 * onChange handlers forward (selectedInstance, legacyIndex, value01) to
 * setObxdInstanceParam().
 *
 * NEW OB-Xf params (no OB-Xd ancestor — e.g. all LFO2, RingModVol,
 * Filter4PoleXpander, the attack-curve sliders, VoiceReassign, …) get a
 * sentinel legacy index >= NEW_PARAM_BASE. They are still rendered and
 * edited in the UI, but setObxdInstanceParam with that index is a silent
 * no-op in the C apply_param_instance switch (which only has cases for
 * 0..79). They are wired properly in a follow-up engine task. The list of
 * no-op'd controls is enumerated in NEW_PARAM_IDS below and reported in
 * the build log.
 *
 * Visibility rules (layout §6):
 *   - FILTER: Filter4PoleMode toggles a 2-pole↔4-pole control set; when
 *     Filter4PoleMode AND Filter4PoleXpander are both on, FilterMode hides
 *     and FilterXpanderMode shows. Re-evaluated on every change to either
 *     toggle and after a sync from the engine.
 *   - LFO 1 / LFO 2: the two LFO panels share the same screen footprint.
 *     Two radio toggle buttons (lfo1SelectButton / lfo2SelectButton from
 *     the layout, recreated here as createObxdToggle) switch between them.
 *
 * Exported interface is UNCHANGED from the old OB-XD grid so obxd-rack.ts
 * needs no edits:
 *   - buildObxdSynthUi(container)
 *   - syncObxdControlsFromEngine(instanceId)
 */

import {
    createObxdKnob,
    createObxdToggle,
    createTriStateButton,
    createSelector,
    createSlider,
} from "./obxd-knob";
import {
    setObxdInstanceParam,
    getObxdInstanceParam,
    getObxdSelectedInstance,
    isObxdReady,
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
//
// Built once from obxf-param-mappings.ts. First-seen wins for IDs that
// appear twice (BENDRANGE splits to PitchBendUp + PitchBendDown, both at
// legacyIndex 6 — we want both UI controls to drive index 6, so duplicate
// entries in the table are fine and the map ends up with both → 6).
// ===========================================================================

const idToLegacyIndex = new Map<string, number>();
for (const m of paramMappings) {
    if (m.newId && !idToLegacyIndex.has(m.newId)) {
        idToLegacyIndex.set(m.newId, m.legacyIndex);
    }
}

// ControlSpec.id uses human-friendly labels; a handful differ from the
// actual streaming IDs (layout §6 "ID/Name asymmetries"). Translate before
// the legacy-index lookup.
const ID_ALIASES: Record<string, string> = {
    Osc1Vol: "Osc1Mix",
    Osc2Vol: "Osc2Mix",
    NoiseVol: "NoiseMix",
    FilterKeyTrack: "FilterKeyFollow",
    BendUpRange: "PitchBendUp",
    BendDownRange: "PitchBendDown",
};

// Sentinel range for OB-Xf params with no OB-Xd ancestor. The engine's
// apply_param_instance switch only handles 0..79, so any index >= 80 is a
// no-op; we use 200+ to keep it well clear of future legacy extensions.
const NEW_PARAM_BASE = 200;

// OB-Xf params that are rendered + editable here but currently no-op'd in
// the engine dispatch (no legacy case). Documented for the follow-up
// engine task. Populated at build time as controls are resolved.
const NEW_PARAM_IDS: string[] = [];

function resolveLegacyIndex(c: ControlSpec): number {
    const streamId = ID_ALIASES[c.id] ?? c.id;
    const legacy = idToLegacyIndex.get(streamId);
    if (legacy !== undefined) return legacy;
    // New param — unique sentinel so each control is independently
    // addressable. The engine ignores it; we just need a stable per-control
    // number for the onChange closure and to keep them out of sync queries.
    return NEW_PARAM_BASE + NEW_PARAM_IDS.length;
}

// ===========================================================================
// 2. Section metadata (background labels for orientation)
// ===========================================================================

const SECTION_LABELS: { section: Section; title: string }[] = [
    { section: Section.Master,     title: "MASTER" },
    { section: Section.Global,     title: "GLOBAL" },
    { section: Section.Oscillators,title: "OSCILLATORS" },
    { section: Section.Mixer,      title: "MIXER" },
    { section: Section.Control,    title: "CONTROL" },
    { section: Section.Filter,     title: "FILTER" },
    // LFO1 + LFO2 share the same footprint — render one background labelled
    // "LFO 1 / 2" rather than two overlapping boxes.
    { section: Section.LFO1,       title: "LFO 1 / 2" },
    { section: Section.FilterEnv,  title: "FILTER ENV" },
    { section: Section.AmpEnv,     title: "AMP ENV" },
    { section: Section.Voice,      title: "VOICE" },
];

// ===========================================================================
// 3. Cached widget handles (for syncObxdControlsFromEngine)
// ===========================================================================

interface ControlHandle {
    legacyIdx: number;
    isNew: boolean;        // true → engine has no dispatch case; skip on sync
    valueEl: HTMLElement & { setValue?: (v: number) => void };
}

let cachedControls: ControlHandle[] = [];

// --- Filter-visibility dynamic refs (reset per build) ---
let filter4PoleModeValueEl: HTMLElement | null = null;   // read on-state
let filter4PoleXpanderValueEl: HTMLElement | null = null;// read on-state
let filter2PoleBPBlendDom: HTMLElement | null = null;    // toggle display
let filter2PolePushDom: HTMLElement | null = null;       // toggle display
let filter4PoleXpanderDom: HTMLElement | null = null;    // toggle display
let filterModeDom: HTMLElement | null = null;            // toggle display
let filterXpanderModeDom: HTMLElement | null = null;     // toggle display

// --- LFO panel dynamic refs (reset per build) ---
let lfo1Doms: HTMLElement[] = [];
let lfo2Doms: HTMLElement[] = [];
let lfo1SelectBtn: HTMLElement & { setValue?: (v: number) => void } | null = null;
let lfo2SelectBtn: HTMLElement & { setValue?: (v: number) => void } | null = null;
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
    // createObxdToggle flips the `obxd-toggle-on` class on every paint().
    return !!el && el.classList.contains("obxd-toggle-on");
}

// ===========================================================================
// 4. Visibility rules
// ===========================================================================

/*
 * Filter 2-pole / 4-pole control-set toggle (layout §6). Replicated from
 * ObxfEditorTheme.cpp lines 322-343:
 *   fourPole = Filter4PoleMode
 *   xpander  = Filter4PoleXpander
 *   Filter2PoleBPBlend  visible = !fourPole
 *   Filter2PolePush     visible = !fourPole
 *   Filter4PoleXpander  visible =  fourPole
 *   FilterMode          visible = !(fourPole && xpander)
 *   FilterXpanderMode   visible =  fourPole && xpander
 *
 * Called after every change to Filter4PoleMode / Filter4PoleXpander and
 * once after syncObxdControlsFromEngine (since setValue does not fire
 * onChange, we re-derive state from the toggle DOM classes).
 */
function updateFilterVisibility(): void {
    const fourPole = isToggleOn(filter4PoleModeValueEl);
    const xpander = isToggleOn(filter4PoleXpanderValueEl);

    setDisplay(filter2PoleBPBlendDom, fourPole ? "none" : "");
    setDisplay(filter2PolePushDom,    fourPole ? "none" : "");
    setDisplay(filter4PoleXpanderDom, fourPole ? "" : "none");
    setDisplay(filterModeDom,         (fourPole && xpander) ? "none" : "");
    setDisplay(filterXpanderModeDom,  (fourPole && xpander) ? "" : "none");
}

/*
 * LFO 1 / LFO 2 panel radio. The two LFO sections occupy identical screen
 * coordinates in the OB-Xf layout; only one is visible at a time. LFO1 is
 * the default (matches lfo1SelectButton.default = 1).
 */
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
// 5. Widget construction + placement
// ===========================================================================

interface BuiltWidget {
    dom: HTMLElement;        // element to appendChild into the panel
    valueEl: HTMLElement & { setValue?: (v: number) => void }; // element exposing setValue
}

/*
 * Build the right primitive for a ControlSpec and place it at (x, y).
 * Knobs and toggles are wrapped/inline-styled because createObxdKnob /
 * createObxdToggle don't take geometry; the other three primitives
 * self-position via applyBounds().
 */
function buildWidget(c: ControlSpec, legacyIdx: number, isNew: boolean): BuiltWidget {
    // Common dispatch: forward (selectedInstance, legacyIdx, value01) to the
    // engine. New params are posted too but silently no-op'd in the C switch.
    const dispatch = (v: number): void => {
        setObxdInstanceParam(getObxdSelectedInstance(), legacyIdx, v);
    };

    // Re-evaluate the filter visibility rules whenever one of the two
    // driver toggles changes (the toggle's internal paint() has already
    // run before onChange fires, so the DOM class read is current).
    const maybeRefreshFilter = (): void => {
        if (c.id === "Filter4PoleMode" || c.id === "Filter4PoleXpander") {
            updateFilterVisibility();
        }
    };

    switch (c.type) {
        case "knob": {
            const knob = createObxdKnob({
                idx: legacyIdx,
                label: c.label,
                initial: c.default,
                defaultValue: c.default,
                onChange: (_i, v) => { dispatch(v); maybeRefreshFilter(); },
            });
            return { dom: placeKnob(knob, c), valueEl: knob };
        }

        case "toggle": {
            const tog = createObxdToggle({
                idx: legacyIdx,
                label: c.label,
                initial: c.default,
                onChange: (_i, v) => { dispatch(v); maybeRefreshFilter(); },
            });
            return { dom: placeToggle(tog, c), valueEl: tog };
        }

        case "triState": {
            const el = createTriStateButton({
                x: c.x, y: c.y, w: c.w, h: c.h,
                labels: c.triStateMeaning ?? { zero: "Off", half: "On", one: "Inv" },
                initialValue: c.default,
                onChange: (v) => { dispatch(v); maybeRefreshFilter(); },
            });
            return { dom: el, valueEl: el };
        }

        case "selector": {
            const choices = c.choices ?? [];
            const safeChoices = choices.length > 0 ? choices : ["—"];
            const initIdx = choices.length > 1
                ? clampInt(Math.round(c.default * (choices.length - 1)), 0, choices.length - 1)
                : 0;
            const el = createSelector({
                x: c.x, y: c.y, w: c.w, h: c.h,
                choices: safeChoices,
                initialIndex: initIdx,
                onChange: (selIdx) => {
                    const norm = safeChoices.length > 1 ? selIdx / (safeChoices.length - 1) : 0;
                    dispatch(norm);
                    maybeRefreshFilter();
                },
            });
            return { dom: el, valueEl: el };
        }

        case "slider": {
            const el = createSlider({
                x: c.x, y: c.y, w: c.w, h: c.h,
                orientation: c.w >= c.h ? "horizontal" : "vertical",
                initialValue: c.default,
                onChange: (v) => { dispatch(v); maybeRefreshFilter(); },
            });
            return { dom: el, valueEl: el };
        }

        case "button":
        default:
            // No parameter-bound control uses type "button" in the 104
            // (all `button` entries in obxfControls are special widgets
            // with paramBound:false, filtered out before we get here).
            throw new Error(`obxd-synth-ui: unsupported param-bound type "${c.type}" for "${c.id}"`);
    }
}

/*
 * Place a knob widget. createObxdKnob renders a 40×40 SVG inside a 44px
 * flex column (SVG horizontally centred), so a wrapper at (x-2, y) lands
 * the 40px knob exactly on the layout's (x, y)-(x+40, y+40) box. The
 * label/value text overflows below the wrapper (overflow visible).
 */
function placeKnob(knob: HTMLElement, c: ControlSpec): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "obxf-knob-wrap";
    wrap.style.position = "absolute";
    wrap.style.left = (c.x - 2) + "px";
    wrap.style.top = c.y + "px";
    wrap.style.width = "44px";
    wrap.style.pointerEvents = "none";
    // Re-enable pointer events on the knob itself so the wrapper doesn't
    // swallow drags on overlapping neighbours.
    knob.style.pointerEvents = "auto";
    wrap.appendChild(knob);
    return wrap;
}

/*
 * Place a toggle widget. createObxdToggle renders a 44×22 button with the
 * full label; for OB-Xf's tiny (18×13) slim slots we override the size
 * inline and clip the text (the title tooltip carries the full name, and
 * the ON/OFF colour is the primary cue — matching OB-Xf's button art).
 */
function placeToggle(tog: HTMLElement, c: ControlSpec): HTMLElement {
    tog.style.position = "absolute";
    tog.style.left = c.x + "px";
    tog.style.top = c.y + "px";
    tog.style.width = c.w + "px";
    tog.style.minHeight = c.h + "px";
    tog.style.height = c.h + "px";
    tog.style.fontSize = "7px";
    tog.style.lineHeight = "1";
    tog.style.padding = "0";
    tog.style.overflow = "hidden";
    tog.style.textOverflow = "ellipsis";
    tog.style.whiteSpace = "nowrap";
    tog.style.alignSelf = "auto";
    return tog;
}

// ===========================================================================
// 6. Section backgrounds (orientation aid)
// ===========================================================================

function bboxOf(cs: ControlSpec[]): { x: number; y: number; w: number; h: number } {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of cs) {
        if (c.x < minX) minX = c.x;
        if (c.y < minY) minY = c.y;
        if (c.x + c.w > maxX) maxX = c.x + c.w;
        if (c.y + c.h > maxY) maxY = c.y + c.h;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function renderSectionBackgrounds(panel: HTMLElement): void {
    const bySection = new Map<Section, ControlSpec[]>();
    for (const c of obxfControls) {
        if (c.paramBound === false) continue;
        // LFO2 shares LFO1's footprint — fold both into one box.
        const key = c.section === Section.LFO2 ? Section.LFO1 : c.section;
        let arr = bySection.get(key);
        if (!arr) { arr = []; bySection.set(key, arr); }
        arr.push(c);
    }

    for (const { section, title } of SECTION_LABELS) {
        const cs = bySection.get(section);
        if (!cs || cs.length === 0) continue;
        const bb = bboxOf(cs);

        const box = document.createElement("div");
        box.className = "obxf-section-bg";
        box.style.position = "absolute";
        box.style.left = (bb.x - 8) + "px";
        box.style.top = (bb.y - 16) + "px";
        box.style.width = (bb.w + 16) + "px";
        box.style.height = (bb.h + 28) + "px";   // extra bottom room for knob labels
        box.style.border = "1px solid rgba(255,255,255,0.06)";
        box.style.borderRadius = "5px";
        box.style.background = "rgba(255,255,255,0.018)";
        box.style.pointerEvents = "none";

        const label = document.createElement("div");
        label.textContent = title;
        label.style.position = "absolute";
        label.style.top = "-7px";
        label.style.left = "8px";
        label.style.fontSize = "8px";
        label.style.letterSpacing = "1px";
        label.style.color = "rgba(255,255,255,0.4)";
        label.style.background = obxfTheme.background;
        label.style.padding = "0 5px";
        label.style.fontFamily = "monospace";
        label.style.pointerEvents = "none";
        box.appendChild(label);

        panel.appendChild(box);
    }
}

// ===========================================================================
// 7. LFO 1 / LFO 2 selector buttons
// ===========================================================================

/*
 * The lfo1SelectButton / lfo2SelectButton entries in obxfControls are
 * paramBound:false (special widgets), so they're skipped by the main
 * parameter-bound loop. Recreate them here as createObxdToggle instances
 * wired as a radio group so the user can switch LFO panels. Positioned at
 * the layout coordinates from the spec.
 */
function buildLfoSelector(panel: HTMLElement): void {
    // lfo1SelectButton: x=757, y=213, w=18, h=13
    // lfo2SelectButton: x=789, y=213, w=18, h=13
    const lfo1Spec: ControlSpec = obxfControls.find(c => c.id === "lfo1SelectButton")!;
    const lfo2Spec: ControlSpec = obxfControls.find(c => c.id === "lfo2SelectButton")!;

    lfo1SelectBtn = createObxdToggle({
        idx: -1,
        label: "1",
        initial: 1,
        onChange: () => selectLfo(1),
    });
    lfo1SelectBtn.title = "Select LFO 1";
    panel.appendChild(placeToggle(lfo1SelectBtn, lfo1Spec));

    lfo2SelectBtn = createObxdToggle({
        idx: -1,
        label: "2",
        initial: 0,
        onChange: () => selectLfo(2),
    });
    lfo2SelectBtn.title = "Select LFO 2";
    panel.appendChild(placeToggle(lfo2SelectBtn, lfo2Spec));
}

// ===========================================================================
// 8. Public API (unchanged signatures)
// ===========================================================================

export function buildObxdSynthUi(container: HTMLElement): void {
    container.textContent = "";
    cachedControls = [];
    NEW_PARAM_IDS.length = 0;
    resetDynamicRefs();
    // Clear stale MIDI-learn badge DOM refs BEFORE the build loop
    // repopulates them. (setupMidiLearnOverlay runs AFTER the loop and
    // mustn't reset again, or it'd wipe the entries just added.)
    resetMidiLearnOverlay();

    // Root OB-Xf editor canvas (1150×576).
    const panel = document.createElement("div");
    panel.className = "obxf-editor-panel";
    panel.style.position = "relative";
    panel.style.width = obxfTheme.width + "px";
    panel.style.height = obxfTheme.height + "px";
    panel.style.background = obxfTheme.background;
    panel.style.overflow = "hidden";
    panel.style.flex = "0 0 auto";
    panel.style.color = "#fff";
    panel.style.fontFamily = obxfTheme.font.default;

    // Let the host scroll horizontally if the 1150px panel is wider than
    // the viewport; don't stretch (it has a fixed aspect ratio).
    container.style.overflowX = "auto";
    container.style.overflowY = "hidden";
    container.style.alignItems = "flex-start";

    // Section background rectangles (orientation only — no pointer events).
    renderSectionBackgrounds(panel);

    // Instantiate every parameter-bound control (the 104).
    const paramBound = obxfControls.filter(c => c.paramBound !== false);
    for (const c of paramBound) {
        const legacyIdx = resolveLegacyIndex(c);
        const isNew = legacyIdx >= NEW_PARAM_BASE;
        if (isNew) NEW_PARAM_IDS.push(c.id);

        const { dom, valueEl } = buildWidget(c, legacyIdx, isNew);
        panel.appendChild(dom);

        // Register the widget for MIDI learn (T23/T24). Hints are
        // derived from the ControlSpec — toggles/selectors → STEPPED,
        // osc pitch knobs → PITCH, bipolar knobs → BIPOLAR_UNIFORM,
        // everything else → DEFAULT. The overlay attaches the
        // pointerdown/contextmenu listeners and creates the CC badge.
        registerLearnableControl(c.id, legacyIdx, deriveHintsForControl(c));
        attachMidiLearnToWidget(dom, c, panel);

        cachedControls.push({ legacyIdx, isNew, valueEl });

        // Capture filter-visibility + LFO-panel dynamic references.
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

    // LFO 1 / LFO 2 selector buttons (radio group).
    buildLfoSelector(panel);

    // Initial visibility evaluation.
    updateFilterVisibility();
    updateLfoPanel();

    // MIDI-learn overlay: learn button (at 196,415), per-widget CC
    // badges, learn-mode highlight. Called AFTER all param widgets are
    // in place so the initial badge refresh (covering bindings loaded
    // from localStorage) finds every widget's badge. The overlay owns
    // midiLearnManager.onLearnedCallback, so it must be set before any
    // CC could trigger a learn — the rack is built before MIDI input
    // starts in main.ts, so this ordering is guaranteed.
    setupMidiLearnOverlay(panel);

    container.appendChild(panel);

    if (NEW_PARAM_IDS.length > 0) {
        console.info(
            `[obxf] ${paramBound.length} controls built; ${NEW_PARAM_IDS.length} are ` +
            `NEW OB-Xf params (no engine dispatch yet, no-op'd): ` +
            NEW_PARAM_IDS.join(", "),
        );
    } else {
        console.info(`[obxf] ${paramBound.length} controls built`);
    }
}

/*
 * Re-query the engine for every MAPPED control's current value on a given
 * instance and update the widget position WITHOUT firing onChange (so a
 * freshly loaded patch isn't written straight back to the engine). Call
 * after a .fxp load, a Reset, or an instance-selector switch.
 *
 * NEW params (no legacy index) are skipped — the engine has nothing to
 * report for them, so the widget keeps its layout-spec default.
 *
 * After the values land, the filter visibility rules are re-evaluated
 * (setValue on Filter4PoleMode / Filter4PoleXpander doesn't fire onChange,
 * so the dependent controls wouldn't update otherwise).
 *
 * No-ops before the worklet is up (widgets keep baked defaults).
 */
export async function syncObxdControlsFromEngine(instanceId: number): Promise<void> {
    if (cachedControls.length === 0) return;
    if (!isObxdReady()) return;

    await Promise.all(cachedControls.map(async (c) => {
        if (c.isNew) return;   // no engine state to read
        const v = await getObxdInstanceParam(instanceId, c.legacyIdx);
        if (v >= 0 && c.valueEl.setValue) c.valueEl.setValue(v);
    }));

    // Re-derive filter + LFO panel visibility from the freshly-synced DOM.
    updateFilterVisibility();
    updateLfoPanel();
}

// ===========================================================================
// Helpers
// ===========================================================================

function clampInt(v: number, lo: number, hi: number): number {
    if (Number.isNaN(v)) return lo;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return Math.round(v);
}

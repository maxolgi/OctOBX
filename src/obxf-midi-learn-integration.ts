/*
 * obxf-midi-learn-integration.ts — glue between the OB-Xf MIDI-learn logic
 * layer (obxf-midi-learn.ts), the OB-Xf panel UI (obxd-synth-ui.ts /
 * obxf-midi-learn-ui.ts), the hardware MIDI input path (midi-input.ts),
 * and the OB-XD AudioWorklet engine (obxd-audio.ts).
 *
 * Responsibilities (task T24):
 *
 *   1. Hold the singleton ObxfMidiLearnManager instance + a per-param
 *      registry that maps SynthParam::ID → legacy ParamsEnum.h index and
 *      transform hints. The registry is populated at panel-build time by
 *      registerLearnableWidget() (one call per parameter-bound control).
 *
 *   2. Expose processHardwareCC() — the single entry point
 *      midi-input.ts calls BEFORE forwarding a CC to the Octopus engine.
 *      Returns true when the CC was consumed by MIDI-learn (so the engine
 *      should NOT also see it). On a learn-hit it dispatches the scaled
 *      0..1 value to the currently-selected OB-XD instance via
 *      setObxdInstanceParam().
 *
 *   3. Persistence: load/save the manager's serialized bindings to
 *      localStorage. Auto-save fires on every learn/unlearn via the
 *      manager's onLearnedCallback; loadBindings() is called from
 *      setupStatePersistence() at startup so bindings survive reloads.
 *
 *   4. Hint derivation: map a ControlSpec to ParamTransformHints so that
 *      when a CC is learned for a knob, the binding inherits the right
 *      CC→0..1 scaling (STEPPED for selectors/booleans, PITCH for osc
 *      pitch knobs, BIPOLAR_UNIFORM for known center-zero params, DEFAULT
 *      otherwise). Mirrors OB-Xf MidiMap::resyncParamIDCacheFor.
 *
 * Reserved CC routing (CC 1 mod wheel, CC 64 sustain, CC 120/123): the
 * MIDI-learn manager's processCC returns null for these (they are in
 * LEARN_BLOCKLIST). processHardwareCC() now routes them DIRECTLY to the
 * currently-selected OB-Xf instance via the dedicated per-instance exports
 * (setObxdInstanceModWheel / setObxdInstanceSustain / obxdInstancePanic /
 * sendObxdInstanceMidi) and returns true so midi-input.ts does NOT also
 * forward them to the Octopus engine. This guarantees the synth receives
 * them even when the Octopus engine doesn't echo channel-mode CCs to the
 * SAB ring. CC 123 (all-notes-off) reuses obxd_midi_in's existing allNotesOff
 * path via sendObxdInstanceMidi (no separate export needed).
 */

import {
    ObxfMidiLearnManager,
    type ParamTransformHints,
} from "./obxf-midi-learn";
import {
    setObxdInstanceParam,
    getObxdSelectedInstance,
    setObxdInstanceModWheel,
    setObxdInstanceSustain,
    obxdInstancePanic,
    sendObxdInstanceMidi,
} from "./obxd-audio";
import type { ControlSpec } from "./obxf-layout";

// ===========================================================================
// Singleton instance
// ===========================================================================

/*
 * One manager for the whole panel. OB-Xf itself uses one MidiMap per
 * editor instance; OctOBX has a single editor (one panel, one selected
 * OB-XD instance at a time) so a single manager is the right shape.
 */
export const midiLearnManager = new ObxfMidiLearnManager();

// ===========================================================================
// Per-param control registry (populated by registerLearnableWidget)
// ===========================================================================

interface LearnableControl {
    legacyIdx: number;
    hints?: ParamTransformHints;
}

/*
 * paramId (the string passed to setLearnTarget / bind) → control metadata.
 * The paramId is ControlSpec.id verbatim (e.g. "Volume", "FilterCutoff",
 * "Osc1Pitch") — the same identifier the manager stores inside bindings,
 * so a processCC hit can be dispatched without any extra aliasing.
 */
const controls = new Map<string, LearnableControl>();

/*
 * Register one parameter-bound widget for MIDI learn. Called from
 * buildObxdSynthUi for each of the 104 controls. The hints are derived
 * here (from the ControlSpec) so the panel doesn't need to know about
 * the transform-method taxonomy.
 */
export function registerLearnableControl(
    paramId: string,
    legacyIdx: number,
    hints?: ParamTransformHints,
): void {
    controls.set(paramId, { legacyIdx, hints });
}

export function getHintsForParam(paramId: string): ParamTransformHints | undefined {
    return controls.get(paramId)?.hints;
}

// ===========================================================================
// CC processing — called from midi-input.ts BEFORE wasm_midi_input
// ===========================================================================

/*
 * Process one incoming hardware MIDI CC.
 *
 * Returns true if the CC was consumed by MIDI-learn (bound + dispatched
 * to the OB-XD engine); false to let midi-input.ts fall through to its
 * normal wasm_midi_input path (reserved CCs, unbound CCs, etc.).
 *
 * Side effects on a hit:
 *   - If learn mode is ON and a target is set, the manager binds this
 *     CC to the target (omni, channelId = -1, like OB-Xf). The
 *     onLearnedCallback fires (set up by the UI layer to refresh badges
 *     and persist).
 *   - The binding's scaled 0..1 value is dispatched to the currently-
 *     selected OB-XD instance via setObxdInstanceParam. Multi-instance
 *     per-channel dispatch is a future extension; today the user is
 *     editing one instance at a time and that's the instance that gets
 *     the learned value.
 */
export function processHardwareCC(channel: number, cc: number, value: number): boolean {
    // Fix 2: reserved CCs are routed DIRECTLY to the currently-selected
    // OB-Xf instance (the MIDI-learn manager returns null for them, so
    // without this block they'd fall through to the Octopus engine and
    // only reach the synth if the firmware echoed them — unreliable).
    // We return true so midi-input.ts does NOT also forward them.
    const sel = getObxdSelectedInstance();
    switch (cc) {
        case 1:   // Mod Wheel → processModWheel (0..1)
            setObxdInstanceModWheel(sel, value / 127);
            return true;
        case 64:  // Sustain Pedal → sustainOn/Off (threshold >= 64)
            setObxdInstanceSustain(sel, value >= 64);
            return true;
        case 120: // All Sound Off → allSoundOff (panic)
            obxdInstancePanic(sel);
            return true;
        case 123: // All Notes Off → obxd_midi_in's allNotesOff path
            sendObxdInstanceMidi(sel, 0xb0, 123, 0);
            return true;
        default:
            break;
    }

    const hit = midiLearnManager.processCC(channel, cc, value);
    if (!hit) return false;

    const ctl = controls.get(hit.paramId);
    if (!ctl) {
        // No registered widget for this paramId — shouldn't happen since
        // bindings come from registered widgets, but be defensive.
        console.warn(`[midi-learn] no registered control for param "${hit.paramId}"`);
        return false;
    }
    setObxdInstanceParam(getObxdSelectedInstance(), ctl.legacyIdx, hit.value);
    return true;
}

// ===========================================================================
// Hint derivation — ControlSpec → ParamTransformHints
// ===========================================================================

/*
 * OB-Xf knobs whose default value is centered (0.5) AND whose semantics
 * are bipolar (centre-zero). Used to auto-pick the BIPOLAR_UNIFORM
 * transform. Picked from the OB-Xf ParameterList.h defaults + the
 * obxf-param-mappings.ts rescale notes ("v*2-1" form indicates bipolar).
 *
 * Osc1Pitch / Osc2Pitch are intentionally NOT in this set — they get
 * the dedicated PITCH transform via the isOscPitch hint.
 */
const BIPOLAR_PARAM_IDS: ReadonlySet<string> = new Set([
    "Transpose",      // roundToInt((v*2-1)*24)
    "Tune",           // v*2-1
    "Osc2Detune",     // logsc, centered
    "UnisonDetune",   // logsc, centered
    "EnvToPitchAmount",
    "EnvToPWAmount",
    "Pan1", "Pan2", "Pan3", "Pan4",
    "Pan5", "Pan6", "Pan7", "Pan8",
]);

/*
 * Derive the ParamTransformHints for a control. The rules mirror OB-Xf's
 * MidiMap::resyncParamIDCacheFor priority order:
 *
 *   1. isOscPitch            → PITCH               (Osc1Pitch / Osc2Pitch)
 *   2. isBool || isInt       → STEPPED             (toggles, tri-states, selectors)
 *   3. isBipolar             → BIPOLAR_UNIFORM     (Tune, Transpose, pans, …)
 *   4. otherwise             → DEFAULT             (cc/127)
 *
 * The mapping is heuristic; future engine work (per-param metadata from
 * the OB-Xf ParameterList) could replace it. Today this gets the common
 * cases right with zero per-param hand-tuning.
 */
export function deriveHintsForControl(c: ControlSpec): ParamTransformHints | undefined {
    // Toggles are booleans.
    if (c.type === "toggle") {
        return { isBool: true };
    }
    // Tri-state buttons cycle 0 / 0.5 / 1 — treat as a 3-step integer.
    if (c.type === "triState") {
        return { isInt: true, intRange: 2 };
    }
    // Selectors are N-way integer choices; OB-Xf stores idx/(N-1).
    if (c.type === "selector") {
        const n = c.choices?.length ?? 2;
        return { isInt: true, intRange: Math.max(1, n - 1) };
    }
    // Knobs / sliders: detect special cases by ID.
    if (/^Osc[12]Pitch$/.test(c.id)) {
        return { isOscPitch: true };
    }
    if (BIPOLAR_PARAM_IDS.has(c.id)) {
        return { isBipolar: true };
    }
    return undefined;
}

// ===========================================================================
// Persistence (localStorage; the sequencer binary state has its own path)
// ===========================================================================

export const MIDI_LEARN_STORAGE_KEY = "octobx:obxf-midi-learn";

/*
 * Save current bindings to localStorage. Called automatically on every
 * learn/unlearn (via the manager's onLearnedCallback) AND on explicit
 * user save (state-persistence.ts SAVE button).
 */
export function saveMidiLearnBindings(): void {
    try {
        localStorage.setItem(MIDI_LEARN_STORAGE_KEY, midiLearnManager.serialize());
    } catch (e) {
        // Quota exceeded / disabled storage — non-fatal; bindings just
        // don't persist across reloads.
        console.warn("[midi-learn] failed to persist bindings:", e);
    }
}

/*
 * Load bindings from localStorage. Called once at startup (from
 * setupStatePersistence). Tolerates missing/malformed JSON; the manager's
 * deserialize() throws on parse errors, which we catch here.
 */
export function loadMidiLearnBindings(): void {
    try {
        const raw = localStorage.getItem(MIDI_LEARN_STORAGE_KEY);
        if (!raw) return;
        midiLearnManager.deserialize(raw);
        console.log(
            `[midi-learn] loaded ${midiLearnManager.getBindings().length} binding(s) from localStorage`,
        );
    } catch (e) {
        console.warn("[midi-learn] failed to load bindings:", e);
    }
}

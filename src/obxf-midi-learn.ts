/*
 * obxf-midi-learn.ts — OB-Xf MIDI-learn LOGIC layer (no UI).
 *
 * Faithful TypeScript port of the MIDI-learn state machine that lives in the
 * OB-Xf C++ source. The actual binding/routing logic is NOT in
 * ObxfEditorMidiLearn.cpp (that file only draws the per-knob overlay popups);
 * it is split across:
 *
 *   - src/midi/MidiHandler.cpp   ::processMidiPerSample  (the learn state
 *     machine: pre-screening of reserved CCs, the learn-then-apply same-message
 *     path, value dispatch via a lag smoother)
 *   - src/engine/MidiMap.h       class MidiMap            (binding storage:
 *     controllers[128] / controllerParamID[128] /
 *     transformMethods[128] / stepValues[128]; updateCC;
 *     clearBindingByParamID; ccTo01; resyncParamIDCacheFor)
 *
 * This module reproduces that behaviour as a standalone, framework-free class.
 * The AudioWorklet/param dispatch and the overlay UI are intentionally out of
 * scope — they are wired up in T24 (integration) and T23 (overlay) respectively.
 *
 * --------------------------------------------------------------
 * OB-Xf MIDI-learn behaviour (extracted from the C++, for reference)
 * --------------------------------------------------------------
 *
 *  State (MidiHandler members):
 *    - midiLearnAttachment.get()  → bool "is learn mode on?" (the midiLearnButton toggle)
 *    - lastUsedParameter          → int param meta.id last clicked by the user
 *                                   (0 = none). Set via setLastUsedParameter(paramId);
 *                                   cleared by clearLastUsedParameter() / exitMidiLearnMode().
 *    - bindings (MidiMap)         → 4 parallel arrays indexed by CC number 0..127
 *                                   (controllers, controllerParamID, transformMethods, stepValues)
 *
 *  Per-incoming-CC path (MidiHandler.cpp lines ~156-247):
 *    1. A `dontLearn` flag is set for reserved CCs that are NEVER learned and
 *       are routed to dedicated engine methods instead:
 *         CC   0  Bank Select MSB   → bankSelectMSB
 *         CC   1  Mod Wheel         → synth.processModWheel(cc/127)
 *         CC   6  Data Entry MSB    → RPN handling
 *         CC  38  Data Entry LSB    → captured
 *         CC  64  Sustain Pedal     → synth.sustainOn/Off
 *         CC  74  MPE Timbre        → synth.processMPETimbre
 *         CC 100  RPN LSB           → rpnLSB
 *         CC 101  RPN MSB           → rpnMSB (+ resets data entry)
 *         CC 120  All Sound Off     → synth.allSoundOff
 *         CC 123  All Notes Off     → synth.allNotesOff
 *    2. If the CC is learnable AND learn-mode is on AND lastUsedParameter > 0:
 *         bindings.updateCC(lastUsedParameter, cc)   // bind (omni — channel ignored)
 *         fire onMidiLearnBinding callback           // UI refresh hook
 *    3. If bindings.isBound(cc):
 *         val = bindings.ccTo01(cc, controllerValue) // per-binding transform
 *         lagHandler->setTarget(cc, val)             // smooth + dispatch
 *         (learn-mode-off branch also clears lastUsedParameter here)
 *
 *  So the SAME MIDI message that triggers a learn is applied immediately, and
 *  learn mode is NOT auto-exited by a binding (the user toggles the button off,
 *  at which point exitMidiLearnMode() clears the overlays + lastUsedPID and
 *  calls clearLastUsedParameter()).
 *
 *  ccTo01 transforms (MidiMap.h ccTo01 + resyncParamIDCacheFor):
 *    DEFAULT         : cc / 127
 *    BIPOLAR_UNIFORM : (cc - 1) / 126            (bipolar params)
 *    PITCH           : clamp((cc-64)/48,-1,1)*0.5+0.5   (Osc1Pitch / Osc2Pitch)
 *    STEPPED         : floor(clamp(cc/128,0,0.99999)*(steps+1)) / steps
 *                      (BOOL/INT params; steps = max - min)
 *
 *  updateCC(paramId, cc): first clears EVERY CC currently bound to paramId,
 *  then sets controllers[cc] = paramId (overwriting any prior occupant of that
 *  CC slot). A param therefore has at most ONE CC bound to it at a time.
 *
 *  Persistence (MidiMap setXml/getXml): an XML element with attributes
 *  `CC0`..`CC127` whose value is the bound param's integer meta.id (only bound
 *  CCs are written). This module serializes to JSON instead (see serialize()),
 *  but preserves the same (cc → paramId) semantics so it can be round-tripped.
 *
 *  Channel handling: OB-Xf CC bindings are OMNI — MidiHandler reads
 *  getControllerNumber()/getControllerValue() and never consults the channel
 *  for CC routing (channel is only used for notes, MPE pitch/timbre, and
 *  program-change bank select). This module's processCC() therefore matches a
 *  binding keyed on channelId = -1 (omni) regardless of the incoming channel.
 *  Per-channel bindings (channelId 0..15) are supported by the data model for
 *  OctOBX's multi-instance routing (T24), and take priority over omni when both
 *  exist.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * CC→0..1 value transforms, mirroring MidiMap::TransformMethods (MidiMap.h).
 * The transform is chosen at bind time based on the bound param's metadata
 * (see deriveTransform() / ParamTransformHints).
 */
export type TransformMethod = "DEFAULT" | "BIPOLAR_UNIFORM" | "PITCH" | "STEPPED";

/**
 * Optional hints about the bound parameter, used to auto-pick the CC→0..1
 * transform exactly the way OB-Xf's MidiMap::resyncParamIDCacheFor does. Pass
 * these to bind() / setLearnTarget() if you want the engine's native scaling;
 * omit them to get the plain DEFAULT (cc/127) transform.
 *
 * The OB-Xf selection rules (in priority order):
 *   1. isOscPitch          → PITCH
 *   2. isBool || isInt     → STEPPED (steps = intRange, or 1 for bool)
 *   3. isBipolar           → BIPOLAR_UNIFORM
 *   4. otherwise           → DEFAULT
 */
export interface ParamTransformHints {
    isBool?: boolean;
    isInt?: boolean;
    isBipolar?: boolean;
    isOscPitch?: boolean;
    /** For INT params: max - min of the param's integer range (e.g. 3 for a 4-way). */
    intRange?: number;
}

/**
 * One CC→param binding. channelId -1 means "omni" (matches any incoming MIDI
 * channel), which is OB-Xf's only mode. Specific channels (0..15) are an
 * OctOBX extension for per-instance routing.
 */
export interface MidiLearnBinding {
    channelId: number;   // -1 = omni (OB-Xf default), 0..15 = specific channel
    ccNumber: number;    // 0..127
    paramId: string;     // OB-Xf SynthParam::ID string (e.g. "FilterCutoff")
    transform?: TransformMethod;   // defaults to "DEFAULT" when omitted
    steps?: number;               // only meaningful for STEPPED
}

/** Result of processCC(): the param to dispatch to + the already-scaled 0..1 value. */
export interface ProcessedCC {
    paramId: string;
    value: number;   // 0..1, after the binding's transform
}

// ============================================================================
// Constants
// ============================================================================

/**
 * CCs that OB-Xf NEVER learns and NEVER routes through the binding map (the
 * `dontLearn` set in MidiHandler::processMidiPerSample). processCC() returns
 * null for these. Exposed so the overlay UI (T23) can grey them out.
 */
export const LEARN_BLOCKLIST: ReadonlySet<number> = new Set([
    0,    // Bank Select MSB
    1,    // Mod Wheel          (→ processModWheel)
    6,    // Data Entry MSB     (RPN)
    38,   // Data Entry LSB
    64,   // Sustain Pedal      (→ sustainOn/Off)
    74,   // MPE Timbre         (→ processMPETimbre)
    100,  // RPN LSB
    101,  // RPN MSB
    120,  // All Sound Off
    123,  // All Notes Off
]);

/** True if `cc` may be learned/routed (i.e. not in OB-Xf's reserved-CC blocklist). */
export function isLearnableCC(cc: number): boolean {
    return !LEARN_BLOCKLIST.has(cc);
}

// ============================================================================
// Value scaling (port of MidiMap::ccTo01)
// ============================================================================

function clamp(x: number, lo: number, hi: number): number {
    return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Scale a raw 7-bit CC value (0..127) to the 0..1 range, applying the bound
 * param's transform. Direct port of MidiMap::ccTo01. The incoming value is
 * clamped to 0..127 defensively (the C++ version assert()s).
 */
export function ccTo01(
    cc: number,
    transform: TransformMethod = "DEFAULT",
    steps = 1,
): number {
    const c = clamp(cc, 0, 127);
    const s = Math.max(1, steps); // guard against div-by-zero; OB-Xf defaults stepValues to 1
    switch (transform) {
        case "BIPOLAR_UNIFORM":
            return (c - 1) / 126;
        case "PITCH":
            return clamp((c - 64) / 48, -1, 1) * 0.5 + 0.5;
        case "STEPPED": {
            const wStep = Math.floor(clamp(c / 128, 0, 0.99999) * (s + 1));
            return wStep / s;
        }
        case "DEFAULT":
        default:
            return c / 127;
    }
}

/**
 * Pick a transform from parameter metadata, replicating
 * MidiMap::resyncParamIDCacheFor. Returns the transform plus the step count
 * (only used by STEPPED).
 */
export function deriveTransform(
    hints?: ParamTransformHints,
): { transform: TransformMethod; steps: number } {
    if (hints?.isOscPitch) {
        return { transform: "PITCH", steps: 1 };
    }
    if (hints?.isBool || hints?.isInt) {
        const range = hints.intRange ?? 1;
        return { transform: "STEPPED", steps: Math.max(1, range) };
    }
    if (hints?.isBipolar) {
        return { transform: "BIPOLAR_UNIFORM", steps: 1 };
    }
    return { transform: "DEFAULT", steps: 1 };
}

// ============================================================================
// Manager
// ============================================================================

/** Omni-channel sentinel (OB-Xf bindings are always omni). */
const OMNI = -1;

function bindingKey(channel: number, cc: number): string {
    return `${channel}|${cc}`;
}

/**
 * ObxfMidiLearnManager — the MIDI-learn logic layer.
 *
 * Instantiate once per OB-Xf synth instance (or once globally for an omni-only
 * setup). Wire processCC() into the incoming-MIDI path; wire bind() /
 * unbindParam() into the overlay UI.
 */
export class ObxfMidiLearnManager {
    /** Learn-mode toggle (the midiLearnButton state). */
    private learnMode = false;
    /** The param (SynthParam::ID) that the next CC will bind to. null = no target. */
    private learnTarget: string | null = null;
    /** Transform hints to apply when a learn binds. Set via setLearnTarget(). */
    private learnTargetHints: ParamTransformHints | undefined;
    /** cc → binding. Keyed `${channel}|${cc}` so omni (-1) and per-channel coexist. */
    private bindings: Map<string, MidiLearnBinding> = new Map();

    /**
     * Optional callback fired after a learn binds a CC, mirroring OB-Xf's
     * MidiHandler::onMidiLearnBinding (used there to trigger an async editor
     * repaint). Set this from the UI layer to refresh overlay CC labels.
     */
    onLearnedCallback?: () => void;

    // ---- learn mode -------------------------------------------------------

    /**
     * Toggle learn mode. Turning learn mode OFF also clears the learn target,
     * matching OB-Xf exitMidiLearnMode() (which clears midiLearnLastUsedPID and
     * calls clearLastUsedParameter()).
     */
    setLearnMode(enabled: boolean): void {
        this.learnMode = enabled;
        if (!enabled) {
            this.learnTarget = null;
            this.learnTargetHints = undefined;
        }
    }

    isLearnMode(): boolean {
        return this.learnMode;
    }

    /**
     * Mark a param as the learn target (typically on knob focus/click). Pass
     * optional transform hints so that, when a CC is learned, the binding
     * inherits the param's native CC scaling (OB-Xf picks the transform at
     * bind time via resyncParamIDCacheFor).
     *
     * Passing null clears the target (equivalent to clearLastUsedParameter()).
     */
    setLearnTarget(paramId: string | null, hints?: ParamTransformHints): void {
        this.learnTarget = paramId;
        this.learnTargetHints = paramId ? hints : undefined;
    }

    getLearnTarget(): string | null {
        return this.learnTarget;
    }

    // ---- CC processing (port of MidiHandler isController branch) ----------

    /**
     * Process an incoming MIDI CC.
     *
     * Behaviour (faithful to MidiHandler::processMidiPerSample, isController):
     *   1. Reserved CCs (LEARN_BLOCKLIST) are ignored — returns null. These are
     *      routed by the integration layer to their dedicated engine methods.
     *   2. If learn mode is ON and a learn target is set, this CC is bound to
     *      that target (omni, channelId = -1) — and the binding is applied
     *      within this same call. The onLearnedCallback fires.
     *   3. The binding map is consulted: a per-channel binding wins, otherwise
     *      an omni (-1) binding matches. If found, the CC value is scaled via
     *      the binding's transform and {paramId, value} is returned.
     *   4. No binding → null.
     *
     * Returns null for reserved/unbound CCs. The dispatch to the actual synth
     * parameter (setObxdInstanceParam / AudioWorklet RPC) is the caller's job.
     *
     * Deviation from the original API sketch (which returned `string | null`):
     * this returns `{paramId, value} | null` because the per-binding transform
     * is inseparable from the lookup — returning only the paramId would force
     * every caller to re-derive the scaling, duplicating ccTo01 / STEPPED logic
     * and risking drift from the engine.
     */
    processCC(channel: number, cc: number, value: number): ProcessedCC | null {
        // (1) Reserved CCs are never learned/routed through the binding map.
        if (!isLearnableCC(cc)) {
            return null;
        }

        // (2) Learn: bind this CC to the current target (omni, like OB-Xf).
        if (this.learnMode && this.learnTarget !== null) {
            this.bind(OMNI, cc, this.learnTarget, this.learnTargetHints);
            if (this.onLearnedCallback) {
                this.onLearnedCallback();
            }
        }

        // (3) Look up: specific channel first, omni fallback.
        const binding =
            this.bindings.get(bindingKey(channel, cc)) ??
            this.bindings.get(bindingKey(OMNI, cc));
        if (!binding) {
            return null;
        }

        // (4) Scale + return.
        const scaled = ccTo01(value, binding.transform ?? "DEFAULT", binding.steps ?? 1);
        return { paramId: binding.paramId, value: scaled };
    }

    // ---- manual binding (port of MidiMap::updateCC) -----------------------

    /**
     * Manually bind a CC to a param (without using learn mode).
     *
     * Replicates MidiMap::updateCC(paramId, cc):
     *   - first removes every existing binding whose paramId matches (a param
     *     has at most one CC at a time),
     *   - then sets the (channel, cc) slot to the new param (overwriting any
     *     prior occupant of that slot).
     *
     * channelId defaults to -1 (omni) to match OB-Xf. Pass 0..15 for an
     * OctOBX per-channel/per-instance binding.
     */
    bind(
        channel: number,
        cc: number,
        paramId: string,
        hints?: ParamTransformHints,
    ): void {
        // (a) a param is bound to at most one CC at a time
        this.removeBindingsByParam(paramId);
        // (b) occupy the slot (overwrites any previous param at this channel/cc)
        const { transform, steps } = this.deriveTransform(hints);
        this.bindings.set(bindingKey(channel, cc), {
            channelId: channel,
            ccNumber: cc,
            paramId,
            transform,
            steps,
        });
    }

    /** Remove every binding for a param (port of clearBindingByParamID). */
    unbindParam(paramId: string): void {
        this.removeBindingsByParam(paramId);
    }

    /**
     * Remove a specific binding. To clear an omni binding, pass channel = -1.
     * No-op if the slot is empty.
     */
    unbindBinding(channel: number, cc: number): void {
        this.bindings.delete(bindingKey(channel, cc));
    }

    /** Remove all bindings (port of MidiMap::reset, bindings only). */
    clearAll(): void {
        this.bindings.clear();
    }

    // ---- queries ----------------------------------------------------------

    /**
     * Look up the binding that processCC() would use for a given channel/cc,
     * or null. Per-channel wins, omni (-1) is the fallback.
     */
    getBindingFor(channel: number, cc: number): MidiLearnBinding | null {
        return (
            this.bindings.get(bindingKey(channel, cc)) ??
            this.bindings.get(bindingKey(OMNI, cc)) ??
            null
        );
    }

    /** All bindings as an array (for UI rendering / persistence). */
    getBindings(): MidiLearnBinding[] {
        return Array.from(this.bindings.values());
    }

    // ---- persistence ------------------------------------------------------

    /**
     * Serialize to a JSON string.
     *
     * Format:
     *   {
     *     "version": 1,
     *     "bindings": [
     *       { "channelId": -1, "ccNumber": 7, "paramId": "Volume",
     *         "transform": "DEFAULT", "steps": 1 },
     *       ...
     *     ]
     *   }
     *
     * This is a JSON analogue of OB-Xf's MidiMap XML (an element with
     * `CC0`..`CC127` attributes whose values are integer param meta.ids).
     * OctOBX uses paramId strings rather than integer ids (more robust against
     * ParameterList reordering), and carries the transform/steps so the
     * scaling survives a round-trip without re-derivation.
     */
    serialize(): string {
        return JSON.stringify({
            version: 1,
            bindings: this.getBindings(),
        });
    }

    /**
     * Restore from a JSON string produced by serialize(). Replaces all current
     * bindings. Learn mode/target are NOT touched. Throws on malformed JSON;
     * tolerates missing transform/steps (defaults applied at read time).
     */
    deserialize(json: string): void {
        const parsed = JSON.parse(json) as {
            version?: number;
            bindings?: Array<Record<string, unknown>>;
        };
        this.bindings.clear();
        const list = Array.isArray(parsed.bindings) ? parsed.bindings : [];
        for (const raw of list) {
            const channelId = typeof raw.channelId === "number" ? raw.channelId : OMNI;
            const ccNumber = typeof raw.ccNumber === "number" ? raw.ccNumber : -1;
            const paramId = typeof raw.paramId === "string" ? raw.paramId : "";
            if (ccNumber < 0 || ccNumber > 127 || !paramId) {
                // Skip malformed entries rather than corrupting the map.
                continue;
            }
            this.bindings.set(bindingKey(channelId, ccNumber), {
                channelId,
                ccNumber,
                paramId,
                transform: raw.transform as TransformMethod | undefined,
                steps: typeof raw.steps === "number" ? raw.steps : undefined,
            });
        }
    }

    // ---- internals --------------------------------------------------------

    private removeBindingsByParam(paramId: string): void {
        for (const [k, b] of this.bindings) {
            if (b.paramId === paramId) {
                this.bindings.delete(k);
            }
        }
    }

    private deriveTransform(
        hints?: ParamTransformHints,
    ): { transform: TransformMethod; steps: number } {
        // Thin wrapper so the public static can be swapped without touching call sites.
        return deriveTransform(hints);
    }
}

// ============================================================================
// Usage example
// ============================================================================
/*
 * // --- wiring (integration layer / T24) ----------------------------------
 *
 * import { ObxfMidiLearnManager } from "./obxf-midi-learn";
 *
 * const learn = new ObxfMidiLearnManager();
 *
 * // The overlay UI (T23) refreshes its per-knob CC labels when a learn fires:
 * learn.onLearnedCallback = () => refreshOverlayLabels();
 *
 * // midiLearnButton toggle
 * midiLearnButtonEl.addEventListener("change", () => {
 *     learn.setLearnMode(midiLearnButtonEl.checked);
 * });
 *
 * // When a knob is focused/clicked, tell the manager what the next CC binds to.
 * // Pass transform hints so a bool param gets STEPPED scaling, etc.
 * cutoffKnobEl.addEventListener("focus", () => {
 *     learn.setLearnTarget("FilterCutoff");
 * });
 * osc1PitchKnobEl.addEventListener("focus", () => {
 *     learn.setLearnTarget("Osc1Pitch", { isOscPitch: true });
 * });
 * unisonKnobEl.addEventListener("focus", () => {
 *     learn.setLearnTarget("Unison", { isBool: true });
 * });
 *
 * // In your incoming-MIDI handler (e.g. inside midi-input.ts's handleMessage,
 * // BEFORE forwarding to wasm_midi_input so the synth gets the remapped value):
 *
 * function onHardwareCC(channel: number, cc: number, value: number) {
 *     const hit = learn.processCC(channel, cc, value);
 *     if (hit) {
 *         // Route the scaled 0..1 value to the OB-Xf instance param.
 *         setObxdInstanceParam(getObxdSelectedInstance(), hit.paramId, hit.value);
 *         return; // consumed by MIDI learn — do not also send raw to the engine
 *     }
 *     // Otherwise let the normal path handle it (mod wheel, sustain, etc.).
 * }
 *
 * // --- manual bind / unlearn (right-click on a knob) ---------------------
 *
 * learn.bind(-1, 74, "FilterCutoff");                 // omni CC74 → cutoff
 * learn.bind(0,  7, "Volume", { isBool: false });     // ch1 CC7 → volume
 * learn.unbindParam("FilterCutoff");                  // unlearn cutoff (any CC)
 *
 * // --- persistence (save/load with the patch) ----------------------------
 *
 * const blob = learn.serialize();
 * localStorage.setItem("obxf-midi-learn", blob);
 * learn.deserialize(localStorage.getItem("obxf-midi-learn") ?? '{"bindings":[]}');
 *
 * // --- reserved CCs are auto-skipped -------------------------------------
 *
 * // CC 1 (Mod Wheel), CC 64 (Sustain), CC 120/123 (All Sound/Notes Off) etc.
 * // always return null from processCC() — the integration layer must route
 * // them to their dedicated engine methods exactly as OB-Xf does.
 * learn.processCC(0, 1, 100);   // → null  (mod wheel; handle separately)
 * learn.processCC(0, 74, 64);   // → null until CC74 is bound/learned
 */

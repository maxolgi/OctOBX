/*
 * obxf-midi-learn-ui.ts — the MIDI-learn OVERLAY (task T23).
 *
 * Renders the OB-Xf midiLearnButton at its layout position (196, 415)
 * inside the panel, manages per-knob CC badges, and toggles the panel-
 * level learn-mode indicator (red border + per-widget learn-target
 * outline).
 *
 * The OB-Xf desktop editor draws per-knob CC labels as popup overlays
 * (ObxfEditorMidiLearn.cpp). For the browser we use simple absolutely-
 * positioned DOM elements — simpler and consistent with how every other
 * OctOBX UI element is built (svgknob, toggles, etc.).
 *
 * Three pieces:
 *
 *   1a. Learn toggle button — render at (196, 415). Toggling it flips
 *       midiLearnManager.setLearnMode(). While ON, the panel border
 *       glows red and clicking any knob marks it as the learn target
 *       (highlighted with a green outline).
 *
 *   1b. Per-knob CC indicator — a small "CC{n}" badge above each bound
 *       knob. Visual only (no drag interaction on the badge itself);
 *       click the badge to unlearn.
 *
 *   1c. Unlearn interaction — click the CC badge to remove the binding
 *       (with a confirm() dialog). Right-click on non-triState widgets
 *       also unbinds. (Tri-state widgets reserve right-click for
 *       reverse-step, so they only get the badge-click path.)
 *
 * Wiring: setupMidiLearnOverlay(panel) is called once at the end of
 * buildObxdSynthUi(). attachMidiLearnToWidget(dom, spec, panel) is
 * called for each parameter-bound widget inside the same build loop.
 */

import { createObxdToggle } from "./obxd-knob";
import {
    midiLearnManager,
    getHintsForParam,
    saveMidiLearnBindings,
} from "./obxf-midi-learn-integration";
import type { ControlSpec } from "./obxf-layout";

// ===========================================================================
// State (reset on every panel build)
// ===========================================================================

let panelEl: HTMLElement | null = null;

/*
 * paramId → badge element. The badge is appended to the panel (NOT to
 * the widget) so it isn't clipped by widget overflow rules and stays
 * on top of overlapping widgets via z-index. The widget highlight is
 * applied via a CSS class on the widget DOM.
 */
const ccBadges = new Map<string, HTMLElement>();

// Widgets that already reserve contextmenu for their own behaviour
// (tri-state reverse-step). Right-click unlearn is skipped on these.
const CONTEXTMENU_RESERVED_TYPES: ReadonlySet<string> = new Set(["triState"]);

function resetOverlayState(): void {
    panelEl = null;
    ccBadges.clear();
}

// Public so buildObxdSynthUi can call it at the START of a rebuild,
// BEFORE any attachMidiLearnToWidget() calls repopulate the map.
// (Calling reset inside setupMidiLearnOverlay would wipe the entries
// attachMidiLearnToWidget just added, because the overlay is set up
// AFTER the widget build loop completes.)
export function resetMidiLearnOverlay(): void {
    resetOverlayState();
}

// ===========================================================================
// Public API
// ===========================================================================

/*
 * Wire per-widget MIDI-learn interactions. Called once per parameter-
 * bound control from buildObxdSynthUi. Installs:
 *
 *   - pointerdown handler → set this widget as the learn target (only
 *     while learn mode is ON; no-op otherwise),
 *   - contextmenu handler → unlearn this param (skipped for triState
 *     widgets whose right-click is already used for reverse-step),
 *   - a CC badge element appended to the panel, hidden until the param
 *     is bound.
 *
 * The badge is positioned at the top-right corner of the widget so it
 * doesn't overlap the widget's label/value text (which sits below knobs).
 */
export function attachMidiLearnToWidget(
    dom: HTMLElement,
    spec: ControlSpec,
    panel: HTMLElement,
): void {
    // (a) pointerdown → setLearnTarget. Capture phase so we fire BEFORE
    //     the widget's own pointerdown (which starts a drag) — otherwise
    //     the drag handler swallows the event on some widget types.
    dom.addEventListener("pointerdown", () => {
        if (!midiLearnManager.isLearnMode()) return;
        midiLearnManager.setLearnTarget(spec.id, getHintsForParam(spec.id));
        updateLearnTargetHighlight();
    }, { capture: true });

    // (b) right-click → unlearn (non-triState only). For triState the
    //     widget's own contextmenu handler does reverse-step; users unbind
    //     those by clicking the CC badge instead.
    if (!CONTEXTMENU_RESERVED_TYPES.has(spec.type)) {
        dom.addEventListener("contextmenu", (ev) => {
            const mine = midiLearnManager.getBindings().find(b => b.paramId === spec.id);
            if (!mine) return;             // nothing to unlearn; let default menu show
            ev.preventDefault();
            confirmUnlearn(spec, mine.ccNumber);
        });
    }

    // (c) CC badge — appended to the panel, positioned at the widget's
    //     top-right corner. Hidden until a binding exists.
    const badge = document.createElement("div");
    badge.className = "obxf-cc-badge";
    badge.style.display = "none";
    badge.style.left = (spec.x + spec.w - 12) + "px";
    badge.style.top = (spec.y - 8) + "px";
    // Click the badge to unlearn (works for ALL widget types, including
    // triState where right-click is reserved).
    badge.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const mine = midiLearnManager.getBindings().find(b => b.paramId === spec.id);
        if (!mine) return;
        confirmUnlearn(spec, mine.ccNumber);
    });
    // Stop pointerdown propagation so clicking the badge doesn't ALSO
    // set the widget as learn target via the capture handler above.
    badge.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    panel.appendChild(badge);
    ccBadges.set(spec.id, badge);
}

/*
 * Build the panel-level overlay: the midiLearnButton toggle (at its
 * layout position 196,415) + the manager's onLearnedCallback wiring.
 *
 * Called once at the end of buildObxdSynthUi, AFTER all parameter widgets
 * (and their badges) have been appended. That way the badge refresh on
 * initial state (loaded from localStorage) finds every widget's badge.
 */
export function setupMidiLearnOverlay(panel: HTMLElement): void {
    // NOTE: do NOT call resetOverlayState() here — that would wipe the
    // ccBadges entries attachMidiLearnToWidget() added during the
    // widget-build loop (which runs BEFORE this function). The reset
    // happens in buildObxdSynthUi via resetMidiLearnOverlay() instead.
    panelEl = panel;

    // Refresh badges + persist on every successful learn. The manager
    // fires this exactly once per learn (inside processCC when the
    // binding is created) — NOT on every subsequent CC dispatch.
    midiLearnManager.onLearnedCallback = () => {
        refreshAllBadges();
        saveMidiLearnBindings();
    };

    // --- Learn toggle button (rendered as a slim OB-Xf toggle, placed
    //     at the layout's midiLearnButton coordinates). ---
    const btn = createObxdToggle({
        idx: -1,
        label: "L",                // tight on the 23×35 slot; tooltip carries full name
        initial: 0,
        onChange: (_idx, v) => {
            midiLearnManager.setLearnMode(v >= 0.5);
            updateLearnTargetHighlight();
        },
    });
    btn.title = "MIDI Learn — toggle ON, click a knob, then send a CC";
    btn.classList.add("obxf-midi-learn-btn");
    btn.style.position = "absolute";
    btn.style.left = "196px";
    btn.style.top = "415px";
    btn.style.width = "23px";
    btn.style.minHeight = "35px";
    btn.style.height = "35px";
    btn.style.fontSize = "8px";
    btn.style.padding = "0";
    btn.style.overflow = "hidden";
    btn.style.zIndex = "6";
    panel.appendChild(btn);

    // Initial badge render — covers bindings loaded from localStorage.
    refreshAllBadges();
    updateLearnTargetHighlight();
}

/*
 * Re-render every CC badge from the manager's current bindings.
 *
 * Each param has at most one binding (enforced by bind() removing prior
 * bindings for the same param), so we collapse the bindings list into a
 * paramId→ccNumber map for O(1) lookup.
 */
function refreshAllBadges(): void {
    const byParam = new Map<string, number>();
    for (const b of midiLearnManager.getBindings()) {
        byParam.set(b.paramId, b.ccNumber);
    }
    for (const [pid, badge] of ccBadges) {
        const cc = byParam.get(pid);
        if (cc !== undefined) {
            badge.textContent = `CC${cc}`;
            badge.style.display = "";
            badge.title = `Bound to CC${cc} — click to unlearn`;
        } else {
            badge.textContent = "";
            badge.style.display = "none";
            badge.removeAttribute("title");
        }
    }
}

/*
 * Repaint the panel-level learn indicator + the per-widget learn-target
 * highlight. Called on learn-mode toggle, on pointerdown over a widget
 * (target change), and after a badge refresh.
 *
 * The "learn target" visual is applied as a CSS class on the badge
 * element (a glowing ring around the badge means "this param is the
 * next-CC target"). Walking back from the badge to the actual widget
 * DOM to outline the knob itself would be fragile (knobs are wrapped
 * in pointer-events:none containers, widgets overlap in the filter
 * section, etc.); the badge ring is unambiguous and stays on top.
 *
 * The target badge is forced visible even when its param has no binding
 * yet (otherwise the user gets no feedback that their click registered).
 * Non-target badges without a binding stay hidden.
 */
function updateLearnTargetHighlight(): void {
    // First reset every badge to its binding-driven state, so toggling
    // learn mode OFF clears the "—" placeholder a previously-target
    // badge may have shown.
    refreshAllBadges();

    const inLearnMode = midiLearnManager.isLearnMode();
    panelEl?.classList.toggle("obxf-learn-mode", inLearnMode);

    const target = midiLearnManager.getLearnTarget();
    if (!inLearnMode || !target) return;
    const badge = ccBadges.get(target);
    if (!badge) return;
    badge.classList.add("obxf-learn-target");
    if (badge.style.display === "none") {
        // Target with no binding yet — show "—" so the user sees
        // SOMETHING. refreshAllBadges() will overwrite with "CC<n>"
        // once a CC binds.
        badge.textContent = "—";
        badge.style.display = "";
        badge.title = "Waiting for a CC…";
    }
}

/*
 * Confirm-then-unlearn helper. The confirmation is a native confirm()
 * dialog (matches the project's "no UI framework, native browser only"
 * style — see state-persistence.ts which uses the same pattern for SAVE).
 */
function confirmUnlearn(spec: ControlSpec, ccNumber: number): void {
    const name = spec.label || spec.id;
    const ok = window.confirm(`Remove CC${ccNumber} binding from "${name}"?`);
    if (!ok) return;
    midiLearnManager.unbindParam(spec.id);
    refreshAllBadges();
    saveMidiLearnBindings();
    console.log(`[midi-learn] unbound "${spec.id}" (was CC${ccNumber})`);
}

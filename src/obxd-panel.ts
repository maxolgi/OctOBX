/*
 * obxd-panel.ts — Transport-bar UI wiring for the in-browser Obxd synth.
 *
 * Phase 1: power on/off + gain slider.
 * Phase 4/5: also drives the OB-XD control panel (knob grid + .fxp upload
 *            + Panic/Reset) shown below the page when the user requests it.
 *
 * Audio power and panel visibility are independent concerns and have
 * independent transport-bar buttons:
 *   - #oct-synth-power       — boots/tears down the AudioWorklet + synth node.
 *   - #oct-synth-visibility  — toggles whether the knob grid is shown in the
 *                              document flow below the Octopus panel. Showing
 *                              the panel while the synth is off is allowed;
 *                              the knobs simply render their last (or default)
 *                              positions until the engine is powered on.
 */

import {
    setupObxdAudio,
    teardownObxdAudio,
    setObxdGain,
    applyObxdDefaultPatch,
    loadObxdFxp,
    obxdPanic,
    obxdResetPatch,
} from "./obxd-audio";
import { buildObxdSynthUi, syncObxdControlsFromEngine } from "./obxd-synth-ui";

let uiBuilt = false;

function ensureUiBuilt(): void {
    if (uiBuilt) return;
    const grid = document.getElementById("obxd-knob-grid");
    if (!grid) return;
    buildObxdSynthUi(grid);
    uiBuilt = true;
}

function setPatchName(name: string): void {
    const el = document.getElementById("obxd-patch-name");
    if (!el) return;
    el.textContent = name && name.length > 0 ? name : "\u2014 init \u2014";
}

function wirePanelButtons(): void {
    const fxpInput = document.getElementById("obxd-fxp-input") as HTMLInputElement | null;
    const resetBtn = document.getElementById("obxd-reset-btn");
    const panicBtn = document.getElementById("obxd-panic-btn");

    if (fxpInput && !fxpInput.dataset.wired) {
        fxpInput.dataset.wired = "1";
        fxpInput.addEventListener("change", async () => {
            const file = fxpInput.files && fxpInput.files[0];
            if (!file) return;
            setPatchName("Loading\u2026");
            try {
                const buf = await file.arrayBuffer();
                const bytes = new Uint8Array(buf);
                const result = await loadObxdFxp(bytes);
                if (result.success) {
                    setPatchName(result.name || "(unnamed)");
                    // Sync knob positions to the freshly loaded patch
                    // (without re-firing onChange / writing back to engine).
                    await syncObxdControlsFromEngine();
                } else {
                    setPatchName(`\u2014 load failed (rc=${result.rc}) \u2014`);
                    console.warn("[obxd] fxp load failed rc=" + result.rc);
                }
            } catch (e) {
                setPatchName("\u2014 load error \u2014");
                console.error("[obxd] fxp load threw:", e);
            } finally {
                // Allow re-uploading the same file.
                fxpInput.value = "";
            }
        });
    }

    if (resetBtn && !resetBtn.dataset.wired) {
        resetBtn.dataset.wired = "1";
        resetBtn.addEventListener("click", async () => {
            obxdResetPatch();
            applyObxdDefaultPatch();   // restore the sequencer-friendly overrides
            setPatchName("\u2014 init \u2014");
            await syncObxdControlsFromEngine();
            console.log("[obxd] reset to default patch");
        });
    }

    if (panicBtn && !panicBtn.dataset.wired) {
        panicBtn.dataset.wired = "1";
        panicBtn.addEventListener("click", () => {
            obxdPanic();
            console.log("[obxd] panic — all sound off");
        });
    }
}

export function setupObxdPanel(): void {
    const powerBtn = document.getElementById("oct-synth-power") as HTMLButtonElement | null;
    const visibilityBtn = document.getElementById("oct-synth-visibility") as HTMLButtonElement | null;
    const gainSlider = document.getElementById("oct-synth-gain") as HTMLInputElement | null;
    const panel = document.getElementById("obxd-panel");
    if (!powerBtn) return;

    let on = false;

    // Wire the panel's internal buttons once, idempotently — they no-op
    // until the synth is powered on.
    wirePanelButtons();

    // --- Audio power (no longer touches panel visibility) ---
    powerBtn.addEventListener("click", async () => {
        if (!on) {
            powerBtn.textContent = "Synth: Starting...";
            powerBtn.disabled = true;
            try {
                await setupObxdAudio();
                applyObxdDefaultPatch();
                on = true;
                powerBtn.textContent = "Synth: On";
                powerBtn.classList.add("synth-on");
                powerBtn.setAttribute("aria-pressed", "true");
                if (gainSlider) {
                    setObxdGain(parseFloat(gainSlider.value));
                }
                setPatchName("\u2014 init \u2014");
                // Sync the knobs to the engine's actual post-default state
                // (slightly defensive: the baked-in initial values already
                // match applyObxdDefaultPatch, but a sync guarantees no drift
                // if apply_defaults() ever changes upstream).
                void syncObxdControlsFromEngine();
            } catch (e) {
                console.error("[obxd] failed to start:", e);
                powerBtn.textContent = "Synth: Error";
            } finally {
                powerBtn.disabled = false;
            }
        } else {
            teardownObxdAudio();
            on = false;
            powerBtn.textContent = "Synth: Off";
            powerBtn.classList.remove("synth-on");
            powerBtn.setAttribute("aria-pressed", "false");
        }
    });

    // --- Panel visibility (independent of audio power) ---
    // Showing the panel only builds the UI (with defaults baked in) and
    // toggles display. No engine calls happen here — the knobs render their
    // last positions (or defaults on first show) until the engine is ready.
    if (visibilityBtn && panel) {
        let visible = false; // matches the inline style="display:none;" on #obxd-panel
        visibilityBtn.addEventListener("click", () => {
            visible = !visible;
            if (visible) {
                ensureUiBuilt();
            }
            panel.style.display = visible ? "" : "none";
            visibilityBtn.textContent = visible ? "Hide Synth" : "Show Synth";
            visibilityBtn.classList.toggle("synth-visible", visible);
            visibilityBtn.setAttribute("aria-pressed", String(visible));
        });
    }

    gainSlider?.addEventListener("input", () => {
        setObxdGain(parseFloat(gainSlider.value));
    });
}

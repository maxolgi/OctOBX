/*
 * main.ts — OctoDAW entry point.
 *
 * Loads the Octopus WASM engine and starts the grid panel.
 * Supports switching between classic (full Octopus layout) and modern views.
 * openDAW integration is attempted but non-fatal if it fails.
 */

import { loadOctopusModule } from "./octopus-module";
import { setupEngine, type TrackAssignment } from "./engine-setup";
import { startMidiBridge } from "./midi-bridge";
import { setupTransportSync } from "./transport-sync";
import { startOctopusPanel } from "./octopus-panel";
import { buildClassicPanel } from "./classic-panel";
import { HardwareMidiOutput, drainMidiToHardware } from "./midi-output";
import { setupStatePersistence } from "./state-persistence";
import type { OctopusWasmModule } from "./octopus-types";

let activePanelCleanup: (() => void) | null = null;
let wasmModule: OctopusWasmModule | null = null;

async function main() {
    const statusEl = document.getElementById("status");
    setStatus(statusEl, "Loading Octopus engine...");

    if (typeof SharedArrayBuffer === "undefined") {
        setStatus(statusEl, "ERROR: SharedArrayBuffer not available. Server needs COOP/COEP headers.");
        return;
    }

    wasmModule = await loadOctopusModule("./octopus_wasm.js");
    (window as unknown as { __module: OctopusWasmModule }).__module = wasmModule;

    setStatus(statusEl, "Initializing engine...");
    wasmModule._engine_init();

    setStatus(statusEl, "Starting panel...");
    switchPanel("classic");
    setupTransportSync(wasmModule);
    setupStatePersistence(wasmModule);

    setupViewToggle();

    setStatus(statusEl, "Attempting openDAW...");
    let assignments: TrackAssignment[] = [];
    try {
        const audioContext = new AudioContext();
        await audioContext.resume();
        const result = await setupEngine(audioContext, wasmModule);
        if (result) assignments = result.assignments;
        setStatus(statusEl, "Ready (with openDAW instruments)");
    } catch (e) {
        console.warn("[octodaw] openDAW not available, running standalone:", e);
        setStatus(statusEl, "Ready (standalone — no instruments)");
    }

    startMidiBridge(wasmModule, assignments);
    const hardwareOutput = new HardwareMidiOutput();
    await hardwareOutput.init();
    const midiSelect = document.getElementById("oct-midi-output") as HTMLSelectElement | null;
    midiSelect?.addEventListener("change", () => hardwareOutput.selectOutput(midiSelect.value));
    drainMidiToHardware(wasmModule, hardwareOutput);

    console.log("[octodaw] All systems go");
}

function switchPanel(view: "classic" | "modern") {
    if (!wasmModule) return;
    if (activePanelCleanup) { activePanelCleanup(); activePanelCleanup = null; }

    const classicEl = document.getElementById("view-classic")!;
    const modernEl = document.getElementById("view-modern")!;

    if (view === "classic") {
        classicEl.style.display = "";
        modernEl.style.display = "none";
        activePanelCleanup = buildClassicPanel(wasmModule);
    } else {
        classicEl.style.display = "none";
        modernEl.style.display = "";
        activePanelCleanup = startOctopusPanel(wasmModule);
    }
}

function setupViewToggle() {
    const toggle = document.getElementById("view-toggle") as HTMLSelectElement | null;
    if (!toggle) return;
    toggle.addEventListener("change", () => {
        switchPanel(toggle.value as "classic" | "modern");
    });
}

function setStatus(el: HTMLElement | null, text: string) {
    if (el) el.textContent = text;
    console.log(`[octodaw] ${text}`);
}

main().catch((e) => {
    console.error("[octodaw] Fatal error:", e);
    const statusEl = document.getElementById("status");
    if (statusEl) statusEl.textContent = `FATAL: ${e.message}`;
});

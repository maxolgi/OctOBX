/*
 * main.ts — OctoDAW entry point.
 *
 * Loads the Octopus WASM engine and starts the grid panel.
 * Supports switching between classic (full Octopus layout) and modern views.
 * openDAW integration is attempted but non-fatal if it fails.
 */

import { loadOctopusModule } from "./octopus-module";
import { setupEngine, type EngineResult } from "./engine-setup";
import { createMidiBridgeHandler, type BatchDrainHandler } from "./midi-bridge";
import { createObxdBridgeHandler } from "./obxd-bridge";
import { setupTransportSync } from "./transport-sync";
import { startOctopusPanel } from "./octopus-panel";
import { buildClassicPanel } from "./classic-panel";
import { HardwareMidiOutput, drainMidiToHardware } from "./midi-output";
import { HardwareMidiInput } from "./midi-input";
import { setupStatePersistence } from "./state-persistence";
import { setupObxdPanel } from "./obxd-panel";
import type { OctopusWasmModule } from "./octopus-types";

let activePanelCleanup: (() => void) | null = null;
let wasmModule: OctopusWasmModule | null = null;

async function main() {
    logStatus("Loading Octopus engine...");

    if (typeof SharedArrayBuffer === "undefined") {
        logStatus("ERROR: SharedArrayBuffer not available. Server needs COOP/COEP headers.");
        return;
    }

    wasmModule = await loadOctopusModule("./octopus_wasm.js");
    (window as unknown as { __module: OctopusWasmModule }).__module = wasmModule;

    logStatus("Initializing engine...");
    wasmModule._engine_init();

    // --- Start MIDI drain FIRST (before panel build) ---
    // RAF callbacks execute in registration order within each frame.
    // Registering drain before render guarantees MIDI events are
    // dispatched before the 300+ DOM-element LED update consumes the frame.
    const hardwareOutput = new HardwareMidiOutput();
    let bridgeHandler: BatchDrainHandler | null = null;            // openDAW (timeout-guarded, installed last)
    let obxdBridgeHandler: BatchDrainHandler | null = null;        // in-browser Obxd synth (Phase 3)
    drainMidiToHardware(
        wasmModule,
        hardwareOutput,
        (events, timestamps, count) => {
            // Parallel consumers: Web MIDI (output.send inside drain) already ran
            // above. Now fan out to the optional bridges — each no-ops when its
            // target isn't ready (openDAW hung / synth unpowered).
            bridgeHandler?.(events, timestamps, count);
            obxdBridgeHandler?.(events, timestamps, count);
        },
    );

    logStatus("Starting panel...");
    switchPanel("classic");
    setupTransportSync(wasmModule);
    setupStatePersistence(wasmModule);

    setupViewToggle();
    setupMobileToggle();

    // --- Hardware MIDI port enumeration (async, non-blocking to drain) ---
    logStatus("Starting MIDI...");
    await hardwareOutput.init();
    const midiSelect = document.getElementById("oct-midi-output") as HTMLSelectElement | null;
    midiSelect?.addEventListener("change", () => hardwareOutput.selectOutput(midiSelect.value));

    // Real MIDI input: hardware controller → Octopus engine
    const hardwareInput = new HardwareMidiInput(wasmModule);
    await hardwareInput.init();
    const midiInSelect = document.getElementById("oct-midi-input") as HTMLSelectElement | null;
    midiInSelect?.addEventListener("change", () => hardwareInput.selectInput(midiInSelect.value));

    // Manual rescan (covers hotplug and the Chrome-on-Linux late-enumeration case)
    document.getElementById("oct-midi-rescan")?.addEventListener("click", async () => {
        await Promise.all([hardwareOutput.rescan(), hardwareInput.rescan()]);
        console.log("[octodaw] MIDI rescan complete");
    });

    // --- In-browser Obxd synth panel (Phase 1: power + gain) ---
    // The synth stays dormant until the user clicks "Synth: Off" — that click
    // is the user gesture the AudioContext needs for autoplay policy.
    // Phase 3 plugs the drain loop's onBatchDrained callback into
    // sendObxdMidi() so the sequencer drives the synth. Install the handler
    // BEFORE setupObxdPanel so it's already active when the user powers on;
    // createObxdBridgeHandler() no-ops while isObxdReady() === false.
    obxdBridgeHandler = createObxdBridgeHandler();
    setupObxdPanel();

    // --- openDAW LAST, timeout-guarded so it can never block MIDI/hardware ---
    // openDAW is non-functional (ProjectEnv needs fully-initialized services).
    // We still attempt it, but cap the wait so a hang can't stall the app.
    // On success, plug the bridge handler into the already-running drain loop.
    logStatus("Attempting openDAW...");
    try {
        const result = await raceTimeout(setupEngineAsync(wasmModule), 4000);
        if (result) {
            bridgeHandler = createMidiBridgeHandler(result.assignments);
            logStatus("Ready (openDAW + MIDI)");
        }
    } catch (e) {
        console.warn("[octodaw] openDAW not available, running standalone:", e);
    }

    console.log("[octodaw] All systems go");
}

/** Build the AudioContext lazily and run openDAW setup. */
async function setupEngineAsync(module: OctopusWasmModule): Promise<EngineResult | null> {
    const audioContext = new AudioContext();
    try { await audioContext.resume(); } catch { /* autoplay policy — non-fatal */ }
    return setupEngine(audioContext, module);
}

/** Resolve with null after `ms` if `p` hasn't settled (guards against hangs). */
function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
    return new Promise((resolve) => {
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
        p.then(
            (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
            () => { if (!done) { done = true; clearTimeout(t); resolve(null); } },
        );
    });
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

function setupMobileToggle() {
    const bar = document.querySelector(".transport-bar") as HTMLElement | null;
    if (!bar) return;

    const tapZone = document.createElement("div");
    tapZone.style.cssText = "position:fixed;bottom:0;right:0;width:80px;height:80px;z-index:9999";
    document.body.appendChild(tapZone);

    const isMobile = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
    if (isMobile) bar.style.display = "none";

    let visible = !isMobile;
    tapZone.addEventListener("touchstart", (e) => {
        e.preventDefault();
        visible = !visible;
        bar.style.display = visible ? "flex" : "none";
        window.dispatchEvent(new Event("resize"));
    }, { passive: false });
    tapZone.addEventListener("click", () => {
        visible = !visible;
        bar.style.display = visible ? "flex" : "none";
        window.dispatchEvent(new Event("resize"));
    });
}

function logStatus(text: string) {
    console.log(`[octodaw] ${text}`);
}

main().catch((e) => {
    console.error("[octodaw] Fatal error:", e);
});

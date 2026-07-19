/*
 * main.ts — OctOBX entry point.
 *
 * Loads the Octopus WASM engine, starts the grid panel, brings up the
 * OB-XD synth rack, and wires transport + hardware MIDI. The drain loop
 * is started early so the OB-XD bridge (installed by setupObxdRack) can
 * plug into it on the first PLAY.
 */

import { loadOctopusModule } from "./octopus-module";
import { createObxdBridgeHandler, type BatchDrainHandler } from "./obxd-bridge";
import { setupTransportSync } from "./transport-sync";
import { startOctopusPanel } from "./octopus-panel";
import { buildClassicPanel } from "./classic-panel";
import { HardwareMidiOutput, drainMidiToHardware } from "./midi-output";
import { HardwareMidiInput } from "./midi-input";
import { setupStatePersistence } from "./state-persistence";
import { setupObxdRack } from "./obxd-rack";
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
    let obxdBridgeHandler: BatchDrainHandler | null = null;        // in-browser Obxd synth
    drainMidiToHardware(
        wasmModule,
        hardwareOutput,
        (events, timestamps, count) => {
            // Web MIDI (output.send inside drain) already ran above.
            // Fan out to the OB-XD bridge — no-ops while the synth is
            // unpowered or the AudioWorklet isn't up yet.
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
        console.log("[octobx] MIDI rescan complete");
    });

    // --- In-browser Obxd synth rack (Phase C: 10 instances, one visible) ---
    // The rack builds the knob grid eagerly (defaults baked in), wires all
    // header controls, and lazy-inits the AudioContext on the first PLAY
    // click — Octopus already needs PLAY to make sound, and that click is
    // the user gesture the suspended AudioContext needs for autoplay
    // compliance. createObxdBridgeHandler() no-ops while isObxdReady()
    // returns false, so installing it now is safe.
    obxdBridgeHandler = createObxdBridgeHandler();
    setupObxdRack();

    console.log("[octobx] All systems go");
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
    console.log(`[octobx] ${text}`);
}

main().catch((e) => {
    console.error("[octobx] Fatal error:", e);
});

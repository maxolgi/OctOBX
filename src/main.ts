/*
 * main.ts — OctOBX entry point.
 *
 * Loads the Octopus WASM engine, starts the grid panel, brings up the
 * OB-Xf synth rack, and wires transport + hardware MIDI. The drain loop
 * is started early so MIDI events reach the hardware output before the
 * panel's DOM updates consume the frame. The OB-Xf AudioWorklet reads
 * MIDI directly from the SharedArrayBuffer, so it is not wired into the
 * drain loop.
 */

import { loadOctopusModule } from "./octopus-module";
import { setupTransportSync } from "./transport-sync";
import { startOctopusPanel } from "./octopus-panel";
import { buildClassicPanel } from "./classic-panel";
import { HardwareMidiOutput, drainMidiToHardware } from "./midi-output";
import { HardwareMidiInput } from "./midi-input";
import { setupStatePersistence } from "./state-persistence";
import { setupObxdRack } from "./obxd-rack";
import { mountDrumModule } from "./drum-rack";
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
    window.__module = wasmModule;

    logStatus("Initializing engine...");
    wasmModule._engine_init();

    // --- Start MIDI drain FIRST (before panel build) ---
    // RAF callbacks execute in registration order within each frame.
    // Registering drain before render guarantees MIDI events are
    // dispatched before the 300+ DOM-element LED update consumes the frame.
    const hardwareOutput = new HardwareMidiOutput();
    drainMidiToHardware(wasmModule, hardwareOutput);

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

    // --- In-browser OB-Xf synth rack (Phase C: 10 instances, one visible) ---
    // The rack builds the knob grid eagerly (defaults baked in), wires all
    // header controls, and lazy-inits the AudioContext on the first PLAY
    // click — Octopus already needs PLAY to make sound, and that click is
    // the user gesture the suspended AudioContext needs for autoplay
    // compliance. The AudioWorklet reads MIDI directly from the
    // SharedArrayBuffer, so no drain-loop wiring is needed here.
    setupObxdRack();

    console.log("[octobx] All systems go");
}

function switchPanel(view: "classic" | "modern" | "synth" | "drums") {
    if (!wasmModule) return;
    if (activePanelCleanup) { activePanelCleanup(); activePanelCleanup = null; }

    const classicEl = document.getElementById("view-classic")!;
    const modernEl = document.getElementById("view-modern")!;
    const obxdEl = document.getElementById("obxd-panel")!;
    const drumEl = document.getElementById("drum-panel")!;

    if (view === "synth") {
        classicEl.style.display = "none";
        modernEl.style.display = "none";
        obxdEl.style.display = "";
        drumEl.style.display = "none";
        window.scrollTo(0, 0);
    } else if (view === "classic") {
        classicEl.style.display = "";
        modernEl.style.display = "none";
        obxdEl.style.display = "";
        drumEl.style.display = "none";
        activePanelCleanup = buildClassicPanel(wasmModule);
    } else if (view === "modern") {
        classicEl.style.display = "none";
        modernEl.style.display = "";
        obxdEl.style.display = "";
        drumEl.style.display = "none";
        activePanelCleanup = startOctopusPanel(wasmModule);
    } else {
        classicEl.style.display = "none";
        modernEl.style.display = "none";
        obxdEl.style.display = "none";
        drumEl.style.display = "";
        mountDrumModule(drumEl).catch((e: unknown) => console.warn("[drum] mount failed", e));
        window.scrollTo(0, 0);
    }
}

const VIEW_ORDER = ["classic", "modern", "synth", "drums"] as const;
let currentViewIdx = 0;

function setupViewToggle() {
    const toggle = document.getElementById("view-toggle") as HTMLSelectElement | null;
    if (!toggle) return;
    toggle.addEventListener("change", () => {
        currentViewIdx = VIEW_ORDER.indexOf(toggle.value as typeof VIEW_ORDER[number]);
        switchPanel(VIEW_ORDER[currentViewIdx]);
    });
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Tab") return;
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
        e.preventDefault();
        currentViewIdx = (currentViewIdx + (e.shiftKey ? -1 : 1) + VIEW_ORDER.length) % VIEW_ORDER.length;
        const view = VIEW_ORDER[currentViewIdx];
        toggle.value = view;
        switchPanel(view);
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

/*
 * main.ts — OctOBX entry point.
 *
 * Boots the Octopus engine inside the combined OB-Xf AudioWorklet via
 * bootOctopusEngine() (which also creates the worklet node), starts the
 * grid panel, brings up the OB-Xf synth rack, and wires transport +
 * hardware MIDI. Hardware MIDI output is fed exclusively by hw_midi
 * messages forwarded from the worklet (attachHwMidiForwarding).
 */

import { bootOctopusEngine } from "./octopus-awp";
import type { OctopusController } from "./octopus-awp";
import { setupTransportSync } from "./transport-sync";
import { startOctopusPanel } from "./octopus-panel";
import { buildClassicPanel } from "./classic-panel";
import { HardwareMidiOutput, attachHwMidiForwarding } from "./midi-output";
import { HardwareMidiInput } from "./midi-input";
import { setupStatePersistence } from "./state-persistence";
import { setupObxdRack } from "./obxd-rack";
import { mountDrumModule } from "./drum-rack";
import { mountMixer } from "./mixer";
import { getObxdSelectedInstance, isObxdReady } from "./obxd-audio";
import { syncObxdControlsFromEngine } from "./obxd-synth-ui";
import { loadAppState, registerAWPReadyCallback } from "./app-state";

let activePanelCleanup: (() => void) | null = null;
let ctl: OctopusController | null = null;

async function main() {
    logStatus("Booting Octopus engine...");

    if (typeof SharedArrayBuffer === "undefined") {
        logStatus("ERROR: SharedArrayBuffer not available. Server needs COOP/COEP headers.");
        return;
    }

    // Boots the engine inside the combined OB-Xf AudioWorklet (creating
    // the worklet node) and resolves once the engine reports ready.
    ctl = await bootOctopusEngine();
    window.__octopus = ctl;

    // --- Hardware MIDI output ---
    // Events now arrive only as hw_midi messages from the worklet (the
    // engine's MIDI ring is drained inside process() at audio-quantum
    // rate); attach the forwarder before the panel so nothing is missed.
    const hardwareOutput = new HardwareMidiOutput();
    attachHwMidiForwarding(hardwareOutput);

    logStatus("Starting panel...");
    switchPanel("classic");
    setupTransportSync(ctl);
    setupStatePersistence(ctl);

    setupViewToggle();
    setupMobileToggle();

    // --- Hardware MIDI port enumeration (async, non-blocking) ---
    // NOT awaited: requestMIDIAccess() can block indefinitely while the
    // origin's MIDI permission prompt sits unanswered — that would stall
    // the rest of boot (synth rack, drum rack, state restore) on any
    // fresh origin. The selectors are wired once the promise settles;
    // the ↻ Rescan button covers late enumeration either way.
    logStatus("Starting MIDI...");
    void hardwareOutput.init().then(() => {
        const midiSelect = document.getElementById("oct-midi-output") as HTMLSelectElement | null;
        midiSelect?.addEventListener("change", () => hardwareOutput.selectOutput(midiSelect.value));
    });

    // Real MIDI input: hardware controller → Octopus engine
    const hardwareInput = new HardwareMidiInput(ctl);
    void hardwareInput.init().then(() => {
        const midiInSelect = document.getElementById("oct-midi-input") as HTMLSelectElement | null;
        midiInSelect?.addEventListener("change", () => hardwareInput.selectInput(midiInSelect.value));
    });

    // Manual rescan (covers hotplug and the Chrome-on-Linux late-enumeration case)
    document.getElementById("oct-midi-rescan")?.addEventListener("click", async () => {
        await Promise.all([hardwareOutput.rescan(), hardwareInput.rescan()]);
        console.log("[octobx] MIDI rescan complete");
    });

    // --- In-browser OB-Xf synth rack (Phase C: 10 instances, one visible) ---
    // The rack builds the knob grid eagerly (defaults baked in), wires all
    // header controls, and lazy-resumes the AudioContext on the first PLAY
    // click — Octopus already needs PLAY to make sound, and that click is
    // the user gesture the suspended AudioContext needs for autoplay
    // compliance. The worklet node itself is already up (created at boot).
    setupObxdRack();

    // Load saved synth + drum state from localStorage (cached for restore
    // after AWP initializes). Register the restore callback so it fires
    // on the first PLAY (when the AudioWorklet comes up).
    loadAppState();
    registerAWPReadyCallback();

    console.log("[octobx] All systems go");
}

function switchPanel(view: "classic" | "modern" | "synth" | "drums" | "mixer") {
    if (!ctl) return;
    if (activePanelCleanup) { activePanelCleanup(); activePanelCleanup = null; }

    const classicEl = document.getElementById("view-classic")!;
    const modernEl = document.getElementById("view-modern")!;
    const obxdEl = document.getElementById("obxd-panel")!;
    const drumEl = document.getElementById("drum-panel")!;
    const mixerEl = document.getElementById("mixer-panel")!;

    if (view === "synth") {
        classicEl.style.display = "none";
        modernEl.style.display = "none";
        obxdEl.style.display = "";
        drumEl.style.display = "none";
        mixerEl.style.display = "none";
        // Re-seed the editor knobs from the engine so changes made in the
        // Mixer view (volume faders) are reflected here. No-op before the
        // audio worklet is up.
        if (isObxdReady()) void syncObxdControlsFromEngine(getObxdSelectedInstance());
        window.scrollTo(0, 0);
    } else if (view === "classic") {
        classicEl.style.display = "";
        modernEl.style.display = "none";
        obxdEl.style.display = "none";
        drumEl.style.display = "none";
        mixerEl.style.display = "none";
        activePanelCleanup = buildClassicPanel(ctl);
    } else if (view === "modern") {
        classicEl.style.display = "none";
        modernEl.style.display = "";
        obxdEl.style.display = "none";
        drumEl.style.display = "none";
        mixerEl.style.display = "none";
        activePanelCleanup = startOctopusPanel(ctl);
    } else if (view === "mixer") {
        classicEl.style.display = "none";
        modernEl.style.display = "none";
        obxdEl.style.display = "none";
        drumEl.style.display = "none";
        mixerEl.style.display = "";
        activePanelCleanup = mountMixer(mixerEl);
        window.scrollTo(0, 0);
    } else {
        classicEl.style.display = "none";
        modernEl.style.display = "none";
        obxdEl.style.display = "none";
        drumEl.style.display = "";
        mixerEl.style.display = "none";
        mountDrumModule(drumEl).catch((e: unknown) => console.warn("[drum] mount failed", e));
        window.scrollTo(0, 0);
    }
}

const VIEW_ORDER = ["classic", "modern", "synth", "drums", "mixer"] as const;
let currentViewIdx = 0;

function setupViewToggle() {
    const group = document.getElementById("view-toggle");
    if (!group) return;
    const buttons = group.querySelectorAll<HTMLButtonElement>(".view-btn");

    const setActive = (view: string) => {
        buttons.forEach(btn => btn.classList.toggle("active", btn.dataset.view === view));
    };

    buttons.forEach(btn => {
        btn.addEventListener("click", () => {
            const view = btn.dataset.view as typeof VIEW_ORDER[number];
            currentViewIdx = VIEW_ORDER.indexOf(view);
            setActive(view);
            switchPanel(view);
        });
    });

    document.addEventListener("keydown", (e) => {
        if (e.key !== "Tab") return;
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
        e.preventDefault();
        currentViewIdx = (currentViewIdx + (e.shiftKey ? -1 : 1) + VIEW_ORDER.length) % VIEW_ORDER.length;
        const view = VIEW_ORDER[currentViewIdx];
        setActive(view);
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

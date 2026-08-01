/* drum-rack.ts — OB-Xf drum module UI (kit selector, 8 pads, 4 layers, with
 * the full OB-Xf editor embedded per selected layer + drum-specific sample
 * selector / mute). */

import { createObxdToggle } from "./obxd-knob";
import type { DrumKit, DrumLayer } from "./drum-state";
import { DRUM_KITS } from "./drum-kits";
import {
    initDrumMode,
    loadDrumKit,
    setLayerParam,
    previewPad,
    setDrumLayerParam,
    getDrumLayerParam,
} from "./drum-audio";
import { buildObxdSynthUi } from "./obxd-synth-ui";
import type { ObxdParamTarget, ObxdEditorHandle } from "./obxd-synth-ui";

// --- Module state ---------------------------------------------------------

let selectedPad = 0;
let selectedLayer = 0;
let currentKitIndex = 0;
let currentKit: DrumKit = cloneKit(DRUM_KITS[0]);
let ready = false;
let mountedContainer: HTMLElement | null = null;

// DOM refs populated by buildUI().
let statusEl: HTMLSpanElement;
let kitSelectEl: HTMLSelectElement;
let layerBtnsEl: HTMLDivElement;
let editorEl: HTMLDivElement;
let drumControlsEl: HTMLDivElement;
let obxfEditorHost: HTMLDivElement;
let editorHandle: ObxdEditorHandle | null = null;
const padBtns: HTMLButtonElement[] = [];
const padDots: HTMLSpanElement[][] = [];

// OB-Xf editor target: closes over selectedPad/selectedLayer (module-level
// lets) so every get/set addresses the currently-selected drum layer at call
// time. Built once; the editor is re-seeded via editorHandle.sync() whenever
// the pad/layer selection changes.
const drumTarget: ObxdParamTarget = {
    get: (idx) => getDrumLayerParam(selectedPad, selectedLayer, idx),
    set: (idx, v) => setDrumLayerParam(selectedPad, selectedLayer, idx, v),
};

// --- Public API (fixed contract consumed by main.ts) ----------------------

// Race-safe singleton promise: concurrent callers (startup preload +
// first mountDrumModule) share one load. Idempotent once ready.
let preloadPromise: Promise<void> | null = null;

export function preloadDrumKit(): Promise<void> {
    if (ready) return Promise.resolve();
    if (preloadPromise) return preloadPromise;
    preloadPromise = (async () => {
        try {
            await initDrumMode();
        } catch (e) {
            console.warn("[drum] initDrumMode failed (OB-Xf worklet not booted?):", e);
            return;
        }
        try {
            await loadKitByIndex(0);
        } catch (e) {
            console.warn("[drum] initial kit load failed:", e);
        }
    })();
    return preloadPromise;
}

export async function mountDrumModule(container: HTMLElement): Promise<void> {
    if (mountedContainer === container) return;
    while (container.firstChild) container.removeChild(container.firstChild);
    ensureStyle();
    buildUI(container);
    mountedContainer = container;

    refreshPadBank();
    renderLayerButtons();
    renderLayerEditor();

    await preloadDrumKit();
    syncEditor();
}

export function isDrumReady(): boolean {
    return ready;
}

// --- Kit / pad helpers ----------------------------------------------------

function cloneKit(kit: DrumKit): DrumKit {
    return {
        name: kit.name,
        source: kit.source,
        pads: kit.pads.map((p) => {
            const layers = p.layers.map((l): DrumLayer => ({ ...l }));
            return {
                name: p.name,
                midiNote: p.midiNote,
                chokeGroup: p.chokeGroup,
                layers: [layers[0], layers[1], layers[2], layers[3]] as [DrumLayer, DrumLayer, DrumLayer, DrumLayer],
            };
        }),
    };
}

function collectSampleNames(): string[] {
    const set = new Set<string>();
    for (const pad of currentKit.pads) {
        for (const l of pad.layers) {
            if (l.sampleName) set.add(l.sampleName);
        }
    }
    return Array.from(set).sort();
}

// Push the currently-selected layer's params to the engine. When the layer
// is muted, force gain to 0 so the real gain is preserved on the layer obj
// for when the user unmutes.
function pushLayer(lyr: DrumLayer): void {
    const eff: DrumLayer = lyr.muted ? { ...lyr, gain: 0 } : lyr;
    setLayerParam(selectedPad, selectedLayer, eff);
}

// --- Kit loading ----------------------------------------------------------

async function loadKitByIndex(idx: number): Promise<void> {
    currentKitIndex = idx;
    currentKit = cloneKit(DRUM_KITS[idx]);
    selectedPad = 0;
    selectedLayer = 0;
    // DOM elements only exist after mountDrumModule → buildUI; guard for
    // the startup preload path which runs before the UI is mounted.
    if (kitSelectEl) kitSelectEl.value = String(idx);
    if (statusEl) statusEl.textContent = "Loading " + currentKit.name + "...";
    if (mountedContainer) {
        refreshPadBank();
        renderLayerButtons();
        renderLayerEditor();
    }
    try {
        await loadDrumKit(currentKit);
        ready = true;
        if (statusEl) statusEl.textContent = "Ready - " + currentKit.name;
        // Kit load resets selection to pad 0 / layer 0 and pushes the new
        // layers' params to the engine — re-seed the editor to match.
        syncEditor();
    } catch (e) {
        console.warn("[drum] loadDrumKit failed:", e);
        if (statusEl) statusEl.textContent = "Kit load failed (audio not ready) - " + currentKit.name;
    }
}

// --- DOM construction -----------------------------------------------------

function buildUI(container: HTMLElement): void {
    const root = document.createElement("div");
    root.className = "drum-root";

    // 1. Header: kit selector + Load Kit button + status.
    const header = document.createElement("div");
    header.className = "drum-header";

    kitSelectEl = document.createElement("select");
    kitSelectEl.title = "Drum kit";
    DRUM_KITS.forEach((k, i) => {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = k.name;
        kitSelectEl.appendChild(o);
    });
    kitSelectEl.value = "0";
    kitSelectEl.addEventListener("change", () => {
        const idx = parseInt(kitSelectEl.value, 10) || 0;
        void loadKitByIndex(idx);
    });

    const loadBtn = document.createElement("button");
    loadBtn.type = "button";
    loadBtn.className = "drum-btn";
    loadBtn.textContent = "Load Kit";
    loadBtn.addEventListener("click", () => {
        const idx = parseInt(kitSelectEl.value, 10) || 0;
        void loadKitByIndex(idx);
    });

    statusEl = document.createElement("span");
    statusEl.className = "drum-status";
    statusEl.textContent = "Initializing...";

    header.appendChild(kitSelectEl);
    header.appendChild(loadBtn);
    header.appendChild(statusEl);

    // 2. Pad bank: 8 large buttons in a row.
    const padsLabel = sectionLabel("Pads");
    const padBank = document.createElement("div");
    padBank.className = "drum-pad-bank";
    for (let i = 0; i < 8; i++) {
        const pad = currentKit.pads[i];
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "drum-pad";

        const nameEl = document.createElement("div");
        nameEl.className = "drum-pad-name";
        nameEl.textContent = pad.name;

        const noteEl = document.createElement("div");
        noteEl.className = "drum-pad-note";
        noteEl.textContent = "Note " + pad.midiNote;

        const dotsWrap = document.createElement("div");
        dotsWrap.className = "drum-pad-dots";
        const dots: HTMLSpanElement[] = [];
        for (let li = 0; li < 4; li++) {
            const d = document.createElement("span");
            d.className = "drum-pad-dot";
            dotsWrap.appendChild(d);
            dots.push(d);
        }

        btn.appendChild(nameEl);
        btn.appendChild(noteEl);
        btn.appendChild(dotsWrap);

        const padIndex = i;
        btn.addEventListener("click", () => {
            selectedPad = padIndex;
            selectedLayer = 0;
            refreshPadBank();
            renderLayerButtons();
            renderLayerEditor();
            syncEditor();
            try {
                previewPad(currentKit.pads[padIndex].midiNote);
            } catch (e) {
                console.warn("[drum] previewPad failed:", e);
            }
        });

        padBtns.push(btn);
        padDots.push(dots);
        padBank.appendChild(btn);
    }

    // 3. Layer selector (4 buttons) — rebuilt contents live in layerBtnsEl.
    const layersLabel = sectionLabel("Layers (click = select+enable, right-click = toggle)");
    layerBtnsEl = document.createElement("div");
    layerBtnsEl.className = "drum-layer-row";

    // 4. Layer editor — drum-specific controls (sample selector + mute) are
    //    rebuilt on selection change into drumControlsEl; the full OB-Xf
    //    editor below it (obxfEditorHost) is built ONCE in buildUI and is
    //    re-seeded via editorHandle.sync() when the selection changes.
    const editorLabel = sectionLabel("Layer editor");
    editorEl = document.createElement("div");
    editorEl.className = "drum-editor";

    drumControlsEl = document.createElement("div");
    drumControlsEl.className = "drum-sample-row";

    obxfEditorHost = document.createElement("div");
    obxfEditorHost.className = "drum-obxf-host";

    editorEl.appendChild(drumControlsEl);
    editorEl.appendChild(obxfEditorHost);

    root.appendChild(header);
    root.appendChild(padsLabel);
    root.appendChild(padBank);
    root.appendChild(layersLabel);
    root.appendChild(layerBtnsEl);
    root.appendChild(editorLabel);
    root.appendChild(editorEl);

    container.appendChild(root);

    // Build the full OB-Xf editor exactly once, bound to the drum target.
    // drumTarget reads selectedPad/selectedLayer at call time, so a single
    // editor instance serves every pad/layer combination — we never rebuild
    // it, only re-seed via editorHandle.sync() on selection change.
    editorHandle = buildObxdSynthUi(obxfEditorHost, drumTarget);
}

function sectionLabel(text: string): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "drum-section-label";
    el.textContent = text;
    return el;
}

// --- Refresh / render routines -------------------------------------------

function refreshPadBank(): void {
    for (let i = 0; i < 8; i++) {
        padBtns[i].classList.toggle("selected", i === selectedPad);
        const pad = currentKit.pads[i];
        for (let li = 0; li < 4; li++) {
            padDots[i][li].classList.toggle("on", pad.layers[li].enabled);
        }
    }
}

function renderLayerButtons(): void {
    layerBtnsEl.replaceChildren();
    const pad = currentKit.pads[selectedPad];
    for (let li = 0; li < 4; li++) {
        const layer = pad.layers[li];
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "drum-layer-btn";
        if (li === selectedLayer) btn.classList.add("selected");

        const led = document.createElement("span");
        led.className = "drum-layer-led" + (layer.enabled ? " on" : "");

        const lab = document.createElement("span");
        lab.className = "drum-layer-label";
        lab.textContent = "L" + (li + 1);

        const sample = document.createElement("span");
        sample.className = "drum-layer-sample";
        sample.textContent = layer.enabled && layer.sampleName ? layer.sampleName : "empty";

        btn.appendChild(led);
        btn.appendChild(lab);
        btn.appendChild(sample);

        const layerIndex = li;
        btn.addEventListener("click", () => {
            selectedLayer = layerIndex;
            const l = pad.layers[layerIndex];
            if (!l.enabled) {
                l.enabled = true;
                // Reload the full kit so the layer list is re-compacted to
                // dense indices and the newly-enabled layer gets its PCM data
                // pushed into pcmBank. setPadLayerCount alone left gaps + a
                // null pcmBank slot so the layer played silence (Bug D — the
                // left-click path missed the reload the contextmenu handler
                // already does). UI is refreshed below synchronously so the
                // toggle reflects immediately; the reload only re-pushes PCM.
                void (async () => {
                    try {
                        await loadDrumKit(currentKit);
                    } catch (e) {
                        console.warn("[drum] reload on layer enable failed:", e);
                    }
                })();
            }
            renderLayerButtons();
            renderLayerEditor();
            syncEditor();
        });
        btn.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            const l = pad.layers[layerIndex];
            l.enabled = !l.enabled;
            refreshPadBank();
            renderLayerButtons();
            // Reload the full kit so the layer list is re-compacted to dense
            // indices and any newly-enabled layer gets its PCM data pushed.
            // Sending set_pcm_layer_count alone left gaps + null pcmBank
            // slots (Bug C). UI is refreshed above synchronously so the
            // toggle reflects immediately; the reload only re-pushes PCM.
            void (async () => {
                try {
                    await loadDrumKit(currentKit);
                } catch (e) {
                    console.warn("[drum] reload on layer toggle failed:", e);
                }
            })();
        });

        layerBtnsEl.appendChild(btn);
    }
}

function renderLayerEditor(): void {
    // Drum-specific controls only (sample selector + mute). The full OB-Xf
    // editor lives in obxfEditorHost (built once in buildUI) and is re-seeded
    // via editorHandle.sync() on selection change — NOT rebuilt here.
    drumControlsEl.replaceChildren();
    const lyr = currentKit.pads[selectedPad].layers[selectedLayer];

    // Sample selector (reassign among samples already present in the kit).
    const sampleLabel = document.createElement("span");
    sampleLabel.textContent = "Sample:";

    const sampleSelect = document.createElement("select");
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "--";
    sampleSelect.appendChild(noneOpt);
    for (const s of collectSampleNames()) {
        const o = document.createElement("option");
        o.value = s;
        o.textContent = s;
        sampleSelect.appendChild(o);
    }
    sampleSelect.value = lyr.sampleName ?? "";
    sampleSelect.addEventListener("change", () => {
        const v = sampleSelect.value;
        lyr.sampleName = v === "" ? null : v;
        void (async () => {
            try {
                await loadDrumKit(currentKit);
                ready = true;
            } catch (e) {
                console.warn("[drum] reload on sample change failed:", e);
            }
            refreshPadBank();
            renderLayerButtons();
        })();
    });

    // Mute toggle (drum-specific; routes through the sample-layer gain path,
    // not the OB-Xf param target).
    const muteTog = createObxdToggle({
        idx: 0,
        label: "Mute",
        initial: lyr.muted ? 1 : 0,
        w: 44,
        h: 22,
        onChange: (_i, v) => {
            lyr.muted = v >= 0.5;
            pushLayer(lyr);
        },
    });
    // Toggle factory only sizes itself when x/y are given; keep it in flow
    // and set the box manually so the SVG frame-strip is visible.
    muteTog.style.width = "44px";
    muteTog.style.height = "22px";
    muteTog.style.position = "static";

    const muteLabel = document.createElement("span");
    muteLabel.className = "drum-mute-label";
    muteLabel.textContent = "Mute";

    drumControlsEl.appendChild(sampleLabel);
    drumControlsEl.appendChild(sampleSelect);
    drumControlsEl.appendChild(muteTog);
    drumControlsEl.appendChild(muteLabel);
}

// Re-seed the OB-Xf editor from the currently-selected drum layer's param
// store. No-op until buildUI has instantiated the editor.
function syncEditor(): void {
    if (!editorHandle) return;
    editorHandle.sync().catch((e) => console.warn("[drum] editor sync failed", e));
}

// --- Stylesheet (injected once) -------------------------------------------

let styleInjected = false;
function ensureStyle(): void {
    if (styleInjected) return;
    styleInjected = true;
    const css = `
.drum-root {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
    color: var(--text);
    font-family: monospace;
    font-size: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}
.drum-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.drum-header select, .drum-sample-row select {
    background: var(--bg); color: var(--text);
    border: 1px solid var(--border); padding: 4px 6px;
    border-radius: 3px; font-family: monospace;
}
.drum-btn {
    background: #333; color: var(--text);
    border: 1px solid var(--border); padding: 5px 12px;
    border-radius: 3px; cursor: pointer; font-family: monospace;
}
.drum-btn:hover { background: #444; }
.drum-btn:active { background: #222; }
.drum-status { color: var(--text-dim); margin-left: auto; }
.drum-section-label {
    font-size: 10px; color: var(--text-dim);
    text-transform: uppercase; letter-spacing: 1px;
}
.drum-pad-bank { display: flex; gap: 6px; }
.drum-pad {
    flex: 1; min-width: 64px; cursor: pointer;
    background: #222; color: var(--text);
    border: 1px solid var(--border); border-radius: 4px;
    padding: 8px 4px; display: flex; flex-direction: column;
    align-items: center; gap: 4px; font-family: monospace;
}
.drum-pad:hover { background: #2c2c2c; }
.drum-pad.selected { border-color: var(--accent); box-shadow: 0 0 6px rgba(0,204,0,0.4); }
.drum-pad-name { font-weight: bold; font-size: 11px; }
.drum-pad-note { color: var(--text-dim); font-size: 10px; }
.drum-pad-dots { display: flex; gap: 3px; }
.drum-pad-dot { width: 7px; height: 7px; border-radius: 50%; background: #444; }
.drum-pad-dot.on { background: var(--accent); }
.drum-layer-row { display: flex; gap: 6px; }
.drum-layer-btn {
    flex: 1; cursor: pointer; background: #222; color: var(--text);
    border: 1px solid var(--border); border-radius: 4px; padding: 6px;
    display: flex; flex-direction: column; align-items: center; gap: 3px;
    font-family: monospace;
}
.drum-layer-btn:hover { background: #2c2c2c; }
.drum-layer-btn.selected { border-color: var(--accent); }
.drum-layer-led { width: 9px; height: 9px; border-radius: 50%; background: #444; }
.drum-layer-led.on { background: var(--accent); }
.drum-layer-label { font-size: 11px; font-weight: bold; }
.drum-layer-sample {
    color: var(--text-dim); font-size: 10px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 100%;
}
.drum-editor { display: flex; flex-direction: column; gap: 10px; }
.drum-sample-row { display: flex; align-items: center; gap: 8px; }
.drum-sample-row select { min-width: 200px; }
.drum-mute-label { font-size: 11px; color: var(--text-dim); }
/* Host for the embedded OB-Xf editor (1150x576). buildObxdSynthUi sets
   overflowX:auto on this element so the wide panel scrolls horizontally;
   the border just frames it inside the drum rack. */
.drum-obxf-host {
    border: 1px solid var(--border);
    border-radius: 4px;
    background: #000;
    flex: 0 0 auto;
    max-width: 100%;
}
`;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
}

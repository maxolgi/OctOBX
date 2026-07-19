/*
 * obxd-rack.ts — Phase C UI for the multi-instance OB-XD synth.
 *
 * Replaces obxd-panel.ts. The panel is always visible in document flow
 * (knob grid shows baked defaults until the engine comes up). The audio
 * engine is lazy-initialized on the first PLAY click — Octopus requires
 * PLAY to make sound anyway, and that click is the user-gesture the
 * suspended AudioContext needs for autoplay-policy compliance.
 *
 * Layout (defined in index.html):
 *   .obxd-panel-header
 *     |- "OB-XD" label
 *     |- #obxd-instance-selector     (dropdown, one instance at a time)
 *     |- #obxd-instance-power        (On / Off toggle)
 *     |- #obxd-instance-polyphony    (1 / 2 / 4 / 8 voices)
 *     |- #obxd-instance-channel      (MIDI channel 1..16)
 *     |- #obxd-instance-meter        (per-instance RMS bar, 30Hz refresh)
 *     |- #obxd-patch-name            (last loaded patch / init label)
 *     |- #obxd-fxp-input             (Load .fxp file picker)
 *     |- #obxd-reset-btn             (Reset patch on selected instance)
 *     |- #obxd-panic-btn             (Panic selected instance)
 *     |- #obxd-panic-all-btn         (Panic every instance)
 *   #obxd-knob-grid                  (built once by buildObxdSynthUi)
 *
 * All header controls target the currently-selected instance. Switching
 * the selector updates every header control to reflect that instance's
 * state and re-syncs the knob grid.
 */

import {
    setupObxdAudio,
    isObxdReady,
    getObxdSelectedInstance,
    setObxdSelectedInstance,
    setObxdInstanceActive,
    setObxdInstancePolyphony,
    loadObxdInstanceFxp,
    obxdInstancePanic,
    obxdInstanceResetPatch,
    obxdPanicAll,
    pingObxd,
    getObxdInstanceMeters,
} from "./obxd-audio";
import {
    setObxdInstanceChannel,
    getObxdInstanceChannel,
} from "./obxd-bridge";
import { buildObxdSynthUi, syncObxdControlsFromEngine } from "./obxd-synth-ui";

const INSTANCE_COUNT = 10;

// Patch name fallbacks used by the UI label before/without a real .fxp
// load. The instance selector's <option> text uses these too. Mirrors
// the names embedded on the C side as factory patches (patches.h, see
// obx.md "Factory patches").
const FACTORY_PATCH_NAMES = [
    "Analog Pad",
    "Bass Pulse",
    "Lead Saw",
    "Pluck",
    "Strings",
    "Keys",
    "Drone",
    "Stab",
    "Noise Hat",
    "Kick",
];

// Default polyphony (per the plan / C-side init). The polyphony selector
// only offers {1, 2, 4, 8} so any voice count outside that set just
// falls back to the closest available option in updateHeaderForInstance.
const DEFAULT_POLYPHONY = [8, 1, 1, 1, 1, 1, 1, 1, 1, 1];

// Per-instance UI-side state. Power defaults to true (matches the C-side
// init: all 10 active). Polyphony mirrors the C-side default; updated
// when the user changes the selector. Patch name starts as the factory
// label since C-side init applies each factory patch to its instance.
const instancePower = new Array<boolean>(INSTANCE_COUNT).fill(true);
const instancePolyphony = DEFAULT_POLYPHONY.slice();
const instancePatchName = FACTORY_PATCH_NAMES.slice();

// EMS clips RMS to a 0..0.5 ish range for typical patches; *200 maps
// 0.5 -> 100% bar fill. Tunable — see obx.md "Per-instance metering".
const METER_SCALE = 200;
const METER_INTERVAL_MS = 33;   // ~30Hz

let uiBuilt = false;
let audioInitializing = false;
let meterInterval: ReturnType<typeof setInterval> | null = null;

function formatPatchName(name: string): string {
    return name && name.length > 0 ? `\u2014 ${name} \u2014` : "\u2014 init \u2014";
}

function setPatchName(name: string): void {
    const el = document.getElementById("obxd-patch-name");
    if (el) el.textContent = name;
}

/*
 * Refresh every header control to reflect the currently-selected
 * instance's UI-side state. Called on selector change and after any
 * control mutation that affects the displayed values.
 *
 * The C side is the source of truth for power/polyphony/patch, but the
 * worklet doesn't expose a "get instance state" RPC — we mirror state in
 * the UI arrays above and trust the user not to race two tabs.
 */
function updateHeaderForInstance(id: number): void {
    const powerBtn = document.getElementById("obxd-instance-power") as HTMLButtonElement | null;
    if (powerBtn) {
        const on = instancePower[id];
        powerBtn.textContent = on ? "On" : "Off";
        powerBtn.setAttribute("aria-pressed", on ? "true" : "false");
        powerBtn.classList.toggle("synth-on", on);
    }

    const polySel = document.getElementById("obxd-instance-polyphony") as HTMLSelectElement | null;
    if (polySel) {
        // Snap to the closest available option (1/2/4/8).
        const desired = instancePolyphony[id];
        const options = [1, 2, 4, 8];
        let best = options[0];
        let bestDiff = Math.abs(desired - best);
        for (const o of options) {
            const d = Math.abs(desired - o);
            if (d < bestDiff) { best = o; bestDiff = d; }
        }
        polySel.value = String(best);
    }

    const chanSel = document.getElementById("obxd-instance-channel") as HTMLSelectElement | null;
    if (chanSel) {
        chanSel.value = String(getObxdInstanceChannel(id));
    }

    setPatchName(formatPatchName(instancePatchName[id]));
}

function ensureUiBuilt(): void {
    if (uiBuilt) return;
    const grid = document.getElementById("obxd-knob-grid");
    if (!grid) return;
    buildObxdSynthUi(grid);
    uiBuilt = true;
}

function wireFxLoader(): void {
    const fxpInput = document.getElementById("obxd-fxp-input") as HTMLInputElement | null;
    if (!fxpInput || fxpInput.dataset.wired) return;
    fxpInput.dataset.wired = "1";

    fxpInput.addEventListener("change", async () => {
        const file = fxpInput.files && fxpInput.files[0];
        if (!file) return;
        const id = getObxdSelectedInstance();
        setPatchName("Loading\u2026");
        try {
            const buf = await file.arrayBuffer();
            const bytes = new Uint8Array(buf);
            const result = await loadObxdInstanceFxp(id, bytes);
            if (result.success) {
                instancePatchName[id] = result.name || "(unnamed)";
                setPatchName(formatPatchName(instancePatchName[id]));
                // Sync knob positions to the freshly loaded patch
                // (without re-firing onChange / writing back to engine).
                await syncObxdControlsFromEngine(id);
            } else {
                setPatchName(`\u2014 load failed \u2014`);
                console.warn(`[obxd] fxp load failed on instance ${id}`);
            }
        } catch (e) {
            setPatchName("\u2014 load error \u2014");
            console.error(`[obxd] fxp load threw on instance ${id}:`, e);
        } finally {
            // Allow re-uploading the same file.
            fxpInput.value = "";
        }
    });
}

function wireResetButton(): void {
    const btn = document.getElementById("obxd-reset-btn");
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", async () => {
        const id = getObxdSelectedInstance();
        obxdInstanceResetPatch(id);
        instancePatchName[id] = "init";
        setPatchName(formatPatchName("init"));
        await syncObxdControlsFromEngine(id);
        console.log(`[obxd] reset instance ${id} to defaults`);
    });
}

function wirePanicButtons(): void {
    const panicBtn = document.getElementById("obxd-panic-btn");
    if (panicBtn && !panicBtn.dataset.wired) {
        panicBtn.dataset.wired = "1";
        panicBtn.addEventListener("click", () => {
            const id = getObxdSelectedInstance();
            obxdInstancePanic(id);
            console.log(`[obxd] panic instance ${id}`);
        });
    }

    const panicAllBtn = document.getElementById("obxd-panic-all-btn");
    if (panicAllBtn && !panicAllBtn.dataset.wired) {
        panicAllBtn.dataset.wired = "1";
        panicAllBtn.addEventListener("click", () => {
            obxdPanicAll();
            console.log("[obxd] panic all instances");
        });
    }
}

function wirePowerButton(): void {
    const powerBtn = document.getElementById("obxd-instance-power") as HTMLButtonElement | null;
    if (!powerBtn || powerBtn.dataset.wired) return;
    powerBtn.dataset.wired = "1";

    powerBtn.addEventListener("click", () => {
        const id = getObxdSelectedInstance();
        const next = !instancePower[id];
        instancePower[id] = next;
        setObxdInstanceActive(id, next);
        powerBtn.textContent = next ? "On" : "Off";
        powerBtn.setAttribute("aria-pressed", next ? "true" : "false");
        powerBtn.classList.toggle("synth-on", next);
    });
}

function wirePolyphonySelector(): void {
    const sel = document.getElementById("obxd-instance-polyphony") as HTMLSelectElement | null;
    if (!sel || sel.dataset.wired) return;
    sel.dataset.wired = "1";

    sel.addEventListener("change", () => {
        const id = getObxdSelectedInstance();
        const v = parseInt(sel.value, 10) || 1;
        instancePolyphony[id] = v;
        setObxdInstancePolyphony(id, v);
    });
}

function wireChannelSelector(): void {
    const sel = document.getElementById("obxd-instance-channel") as HTMLSelectElement | null;
    if (!sel || sel.dataset.wired) return;
    sel.dataset.wired = "1";

    sel.addEventListener("change", () => {
        const id = getObxdSelectedInstance();
        const v = parseInt(sel.value, 10) || 1;
        setObxdInstanceChannel(id, v);
    });
}

function wireInstanceSelector(): void {
    const sel = document.getElementById("obxd-instance-selector") as HTMLSelectElement | null;
    if (!sel || sel.dataset.wired) return;
    sel.dataset.wired = "1";

    sel.addEventListener("change", async () => {
        const id = parseInt(sel.value, 10) || 0;
        setObxdSelectedInstance(id);
        updateHeaderForInstance(id);
        // Sync knobs to this instance's current param values. No-ops
        // before the audio engine is up (knobs keep their baked defaults).
        await syncObxdControlsFromEngine(id);
    });
}

/*
 * Drive the meter bar at ~30Hz. Posts a ping every tick; the pong reply
 * (asynchronous) lands in getObxdInstanceMeters() via the permanent
 * listener in obxd-audio.ts. The display therefore lags by at most one
 * interval (~33ms), which is imperceptible.
 *
 * interval leaks on teardown — this is a single-page app and the rack
 * is created exactly once.
 */
 function startMeterLoop(): void {
    if (meterInterval !== null) return;
    const bar = document.querySelector<HTMLDivElement>("#obxd-instance-meter .obxd-meter-bar");
    meterInterval = setInterval(() => {
        if (!isObxdReady()) {
            if (bar) bar.style.width = "0%";
            return;
        }
        pingObxd();
        const id = getObxdSelectedInstance();
        const rms = getObxdInstanceMeters()[id] || 0;
        const pct = Math.min(100, rms * METER_SCALE);
        if (bar) bar.style.width = pct.toFixed(1) + "%";
    }, METER_INTERVAL_MS);
}

/*
 * Lazy-init AudioContext when the sequencer starts. Octopus already
 * requires PLAY to make sound, so we ride on whichever gesture starts
 * the sequencer. The transport-bar PLAY (#oct-play) is hooked directly
 * for instant response; a run-bit poller catches every OTHER path
 * (Octopus panel's on-surface PLAY key #ck-229, modern-grid PLAY,
 * incoming MIDI START, keyboard shortcuts, etc.) — anything that flips
 * _get_run_bit() from 0 to 1.
 *
 * Until the engine comes up, all 10 instances show as "on" in the UI
 * but produce no audio; knob edits are buffered locally (no-op) and
 * applied post-init via syncObxdControlsFromEngine().
 */
function startAudioInit(): void {
    if (isObxdReady() || audioInitializing) return;
    audioInitializing = true;
    setupObxdAudio().then(async () => {
        // All 10 instances are created with their factory patches +
        // default polyphony by _obxd_init(). Sync the knob grid to
        // whatever the user is currently looking at.
        await syncObxdControlsFromEngine(getObxdSelectedInstance());
        console.log("[obxd] audio engine up — all 10 instances initialized");
    }).catch((e) => {
        console.error("[obxd] audio init failed:", e);
    }).finally(() => {
        audioInitializing = false;
    });
}

function wireLazyAudioInit(): void {
    // Primary path — instant response on the transport-bar PLAY click.
    const playBtn = document.getElementById("oct-play");
    if (playBtn && !playBtn.dataset.obxdWired) {
        playBtn.dataset.obxdWired = "1";
        playBtn.addEventListener("click", startAudioInit);
    }

    // Fallback — poll the sequencer run-bit for the 0->1 transition.
    // Catches Octopus-panel PLAY (#ck-229), modern-grid PLAY, MIDI START,
    // and any other path that doesn't go through #oct-play. Cheap: one
    // WASM call every 200ms, stops itself once audio is up.
    const octopus = (window as unknown as { __module?: { _get_run_bit?: () => number } }).__module;
    if (!octopus?._get_run_bit) return;
    let prevRun = octopus._get_run_bit() || 0;
    const poll = setInterval(() => {
        if (isObxdReady()) { clearInterval(poll); return; }
        const now = octopus._get_run_bit?.() || 0;
        if (now && !prevRun) startAudioInit();
        prevRun = now;
    }, 200);
}

export function setupObxdRack(): void {
    // Build the knob grid eagerly so the panel renders with sensible
    // defaults before the audio engine is up. (buildObxdSynthUi populates
    // each widget with the `initial` field baked into obxd-synth-ui.ts.)
    ensureUiBuilt();

    // Wire all header controls idempotently (dataset.wired guards).
    wireInstanceSelector();
    wirePowerButton();
    wirePolyphonySelector();
    wireChannelSelector();
    wireFxLoader();
    wireResetButton();
    wirePanicButtons();

    // Initialise header for Instance 1 (selector defaults to value=0).
    setObxdSelectedInstance(0);
    updateHeaderForInstance(0);

    // Start meter polling + lazy audio bootstrap.
    startMeterLoop();
    wireLazyAudioInit();
}

/*
 * obxd-rack.ts — Phase C UI for the multi-instance OB-Xf synth.
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
 *     |- #obxd-instance-mpe          (MPE On / Off toggle → setObxdInstanceMpe)
 *     |- #obxd-instance-bendrange    (pitch-bend range 0..96 semitones)
 *     |- #obxd-mpe-channels          (read-only: channels this instance owns)
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
    setObxdInstanceParam,
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
    setObxdInstanceMpe,
    getObxdInstanceMpe,
    getObxdMpeChannels,
} from "./obxd-bridge";
import { buildObxdSynthUi, syncObxdControlsFromEngine } from "./obxd-synth-ui";
import { preloadDrumKit } from "./drum-rack";

const INSTANCE_COUNT = 10;

// Legacy OB-Xd parameter index for the pitch-bend range (ParamsEnum.h
// BENDRANGE). The engine's apply_param_instance() maps this to
// processBendUpRange + processBendDownRange, but only supports TWO values
// today: v <= 0.5 → 2 semitones, v > 0.5 → 12 semitones. The full 0..96
// range the UI exposes requires a new obxd_set_bend_range() engine export
// (documented as a follow-up — do NOT modify the engine here). Until that
// lands, applyLegacyBendRange() snaps the UI's 0..96 value to the nearest
// supported {2, 12} bucket so the control still has an audible effect.
const LEGACY_PARAM_BENDRANGE = 6;

// Patch name fallbacks used by the UI label before/without a real .fxp
// load. The instance selector's <option> text uses these too. Mirrors
// the names embedded on the C side as factory patches (patches.h).
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

// Per-instance pitch-bend-range UI state. Bend range defaults to 2
// semitones (the conservative OB-Xd default); the engine's current binary
// {2, 12} mapping is applied via the legacy BENDRANGE param — the stored
// value is the user's intended 0..96 figure so it tracks the future
// obxd_set_bend_range() engine export. The MPE flag itself is owned by
// obxd-bridge.ts (single source of truth, read back via getObxdInstanceMpe).
const DEFAULT_BENDRANGE = 2;
const instanceBendRange = new Array<number>(INSTANCE_COUNT).fill(DEFAULT_BENDRANGE);

// EMS clips RMS to a 0..0.5 ish range for typical patches; *200 maps
// 0.5 -> 100% bar fill. Tunable.
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

    // MPE toggle — reads back the bridge's per-instance flag (single source
    // of truth). Matches the power button's On/Off + .synth-on styling.
    const mpeBtn = document.getElementById("obxd-instance-mpe") as HTMLButtonElement | null;
    if (mpeBtn) {
        const on = getObxdInstanceMpe(id);
        mpeBtn.textContent = on ? "On" : "Off";
        mpeBtn.setAttribute("aria-pressed", on ? "true" : "false");
        mpeBtn.classList.toggle("synth-on", on);
    }

    // Pitch-bend range — the UI stores the user's intended 0..96 value; the
    // engine currently only honours {2, 12} via the legacy BENDRANGE param
    // (see applyLegacyBendRange). The input reflects the stored intent.
    const bendInput = document.getElementById("obxd-instance-bendrange") as HTMLInputElement | null;
    if (bendInput) {
        bendInput.value = String(instanceBendRange[id]);
    }

    updateMpeChannelsLabel(id);

    setPatchName(formatPatchName(instancePatchName[id]));
}

/*
 * Render the read-only "#obxd-mpe-channels" label for the selected
 * instance. In non-MPE mode it shows the single MIDI channel; in MPE mode
 * it shows the master + voice-channel range (e.g. "MPE 3→10"). Reads the
 * zone straight from the bridge (getObxdMpeChannels) so it always matches
 * the live routing table.
 */
function updateMpeChannelsLabel(id: number): void {
    const el = document.getElementById("obxd-mpe-channels");
    if (!el) return;
    const chans = getObxdMpeChannels(id);
    if (chans.length === 0) {
        el.textContent = "CH —";
        return;
    }
    if (!getObxdInstanceMpe(id)) {
        el.textContent = `CH ${chans[0]}`;
        return;
    }
    const first = chans[0];
    const last = chans[chans.length - 1];
    el.textContent = first === last ? `MPE ${first}` : `MPE ${first}→${last}`;
}

/*
 * Apply the user's 0..96 pitch-bend-range intent to the engine. The OB-Xf
 * engine exposes processBendUpRange/processBendDownRange directly, but
 * neither is exported (no obxd_set_bend_range wrapper). The only reachable
 * path today is the legacy BENDRANGE param (idx 6), which the engine
 * collapses to two buckets: v <= 0.5 → 2 semitones, v > 0.5 → 12. We snap
 * the UI value to the nearest bucket so the control is still audible. A
 * finer-grained 0..96 follow-up needs a new engine export — documented,
 * not implemented here (do NOT modify the WASM engine).
 */
function applyLegacyBendRange(id: number, semitones: number): void {
    const v = semitones > 6 ? 1 : 0;   // >6 → 12-st bucket; else 2-st bucket
    setObxdInstanceParam(id, LEGACY_PARAM_BENDRANGE, v);
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
        // The MPE zone (master + voices) derives from this channel, so the
        // channel-assignment label needs a refresh after a reassignment.
        updateMpeChannelsLabel(id);
    });
}

/*
 * MPE toggle — flips per-instance MPE on the bridge (which mirrors the
 * flag to g_mpe_enabled[id] AND rebuilds the channel→instance routing so
 * the instance claims its lower zone). The bridge is the source of truth;
 * we read it straight back to set the button styling. Toggling also
 * refreshes the channel-assignment label (single channel ↔ master+voices).
 */
function wireMpeToggle(): void {
    const btn = document.getElementById("obxd-instance-mpe") as HTMLButtonElement | null;
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = "1";

    btn.addEventListener("click", () => {
        const id = getObxdSelectedInstance();
        const next = !getObxdInstanceMpe(id);
        setObxdInstanceMpe(id, next);
        btn.textContent = next ? "On" : "Off";
        btn.setAttribute("aria-pressed", next ? "true" : "false");
        btn.classList.toggle("synth-on", next);
        updateMpeChannelsLabel(id);
        console.log(`[obxd] instance ${id} MPE ${next ? "on" : "off"} — ` +
            getObxdMpeChannels(id).join(","));
    });
}

/*
 * Pitch-bend range — stores the user's 0..96 intent per instance and
 * applies the closest engine-supported value via the legacy BENDRANGE
 * param (see applyLegacyBendRange). Clamped to [0, 96] (the input's own
 * min/max also enforces this, but the explicit clamp guards against
 * spinners/paste). Changing the bend range does not affect MPE routing —
 * it is a per-instance synth parameter.
 */
function wireBendRangeControl(): void {
    const input = document.getElementById("obxd-instance-bendrange") as HTMLInputElement | null;
    if (!input || input.dataset.wired) return;
    input.dataset.wired = "1";

    input.addEventListener("change", () => {
        const id = getObxdSelectedInstance();
        let v = parseInt(input.value, 10);
        if (isNaN(v)) v = DEFAULT_BENDRANGE;
        v = Math.max(0, Math.min(96, v));
        input.value = String(v);
        instanceBendRange[id] = v;
        applyLegacyBendRange(id, v);
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
        // Preload the default drum kit on instance 9 so it's configured
        // as a drum sampler from the start — not lazily on first
        // Drums-view open (which would change the sound mid-playback).
        void preloadDrumKit();
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

    // Any user gesture satisfies the AudioContext autoplay policy.
    // A single pointerdown anywhere on the page (step pad, knob, circle
    // button, etc.) boots the synth so notes are audible from the first
    // interaction — not just after pressing PLAY.
    document.addEventListener("pointerdown", () => startAudioInit(), { once: true });

    // Fallback — poll the sequencer run-bit for the 0->1 transition.
    // Catches Octopus-panel PLAY (#ck-229), modern-grid PLAY, MIDI START,
    // and any other path that doesn't go through #oct-play. Cheap: one
    // WASM call every 200ms, stops itself once audio is up.
    const octopus = window.__module;
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
    wireMpeToggle();
    wireBendRangeControl();
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

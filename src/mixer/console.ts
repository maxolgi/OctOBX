/*
 * mixer/console.ts — mounts the 16-stereo-track console into #mixer-panel.
 * Vanilla-TS port of CakeMix's App.tsx mixer row (ChannelDetailPanel × 16 +
 * MasterStrip), driven by store.ts + the strip builders.
 *
 * Runs ONE rAF loop while mounted: it ticks every meter canvas (tracks'
 * L/R, master L/R), the GR bars, and the clip/peak readouts from the
 * latest mixer_meter snapshot. Controls are DOM-native (inputs hold their
 * own value); no per-widget timers.
 */

import { getObxdAudioContext, isMixerReady, addWorkletMessageListener } from "../obxd-audio";
import { applyMixerMeter, seedEngineFromStore, TRACK_COUNT } from "./store";
import { buildTrackStrip, type TrackStripHandle } from "./track-strip";
import { buildMasterStrip, type MasterStripHandle } from "./master-strip";
import { injectMixerStyles } from "./styles";

export type Cleanup = () => void;

// The ONE meter-message listener — installed at MODULE LOAD (not on first
// mount): the seeding below must happen whether or not the mixer view is
// ever opened, and meter snapshots should be live for the rack/debug too.
// The FIRST meter message also proves the engine is processing, which is
// when the store seeds the engine with every displayed default (see
// seedEngineFromStore).
let meterListenerInstalled = false;
function ensureMeterListener(): void {
    if (meterListenerInstalled) return;
    meterListenerInstalled = true;
    let seeded = false;
    addWorkletMessageListener((msg: unknown) => {
        const m = msg as { type?: string };
        if (m && m.type === "mixer_meter") {
            applyMixerMeter(msg as Parameters<typeof applyMixerMeter>[0]);
            if (!seeded) {
                seeded = true;
                seedEngineFromStore();
            }
        }
    });
}
ensureMeterListener();

export function mountMixerConsole(container: HTMLElement): Cleanup {
    injectMixerStyles();
    container.innerHTML = "";

    const ctx = getObxdAudioContext();
    const sampleRate = ctx ? ctx.sampleRate : 48000;

    const root = document.createElement("div");
    root.className = "cmx-console-root";

    // Full-height console like CakeMix: the container gets the viewport
    // space below the transport bar; the row flexes to fill it and the
    // strips stretch (align-items: stretch) so their fader sections pin
    // to the bottom via .detail-output { margin-top: auto }.
    const fit = () => {
        const top = container.getBoundingClientRect().top;
        container.style.height = `${Math.max(320, window.innerHeight - top)}px`;
    };
    fit();
    window.addEventListener("resize", fit);

    // Status line — engine online / offline (offline = the audio path runs
    // the legacy C-side master sum and mix_* messages are no-ops).
    const status = document.createElement("div");
    status.className = "cmx-status";
    root.appendChild(status);
    function refreshStatus(): void {
        if (isMixerReady()) {
            status.textContent = `MIXER ENGINE ONLINE · ${TRACK_COUNT} STEREO TRACKS · TRACKS 1–10 = OB-XF 1–9 + DRUMS · 48 kHz CONSOLE @ ${sampleRate} Hz`;
            status.classList.remove("offline");
        } else {
            status.textContent = "MIXER ENGINE OFFLINE — audio runs the legacy master sum; controls are inert";
            status.classList.add("offline");
        }
    }
    refreshStatus();
    const statusTimer = setInterval(refreshStatus, 1000);   // cheap latch poll

    const consoleRow = document.createElement("div");
    consoleRow.className = "mixer-console";

    const strips: TrackStripHandle[] = [];
    for (let t = 0; t < TRACK_COUNT; t++) {
        const strip = buildTrackStrip(t, sampleRate);
        strips.push(strip);
        consoleRow.appendChild(strip.element);
    }

    const masterStrip: MasterStripHandle = buildMasterStrip();
    consoleRow.appendChild(masterStrip.element);

    root.appendChild(consoleRow);
    container.appendChild(root);

    // Single rAF loop for ALL meters while the console is mounted.
    let rafId = 0;
    function frame(): void {
        for (const s of strips) s.tickMeters();
        masterStrip.tickMeters();
        rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);

    return () => {
        cancelAnimationFrame(rafId);
        clearInterval(statusTimer);
        window.removeEventListener("resize", fit);
    };
}

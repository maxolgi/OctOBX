/*
 * mixer.ts — module boundary for the mixer view.
 *
 * The 10-strip rudimentary mixer that lived here was replaced by the
 * CakeMix console port (16 stereo tracks, full EQ/dynamics per track,
 * master limiter) under src/mixer/. mountMixer mounts that console.
 *
 * createVuMeter (the simple DOM VU bar the old view used) is retained —
 * drum-rack.ts imports it for the drum module's master meter.
 */

export { mountMixerConsole as mountMixer } from "./mixer/console";
export type { Cleanup as MixerCleanup } from "./mixer/console";

const METER_SCALE = 200;       // RMS 0.5 -> 100% fill (matches obxd-rack.ts)

export interface VuMeter {
    element: HTMLElement;
    setLevel: (rms: number) => void;
}

// ===========================================================================
// createVuMeter — reusable vertical VU meter (also imported by drum-rack.ts)
// ===========================================================================

export function createVuMeter(): VuMeter {
    const element = document.createElement("div");
    element.className = "mixer-vu";
    element.style.cssText = [
        "position: relative",
        "width: 20px",
        "height: 160px",
        "background: #1a1a1a",
        "border: 1px solid #333",
        "border-radius: 3px",
        "overflow: hidden",
    ].join("; ");

    const fill = document.createElement("div");
    fill.style.cssText = [
        "position: absolute",
        "left: 0",
        "bottom: 0",
        "width: 100%",
        "height: 0%",
        "background: #3ad04a",
        "transition: height 0.05s linear, background-color 0.05s linear",
    ].join("; ");
    element.appendChild(fill);

    function setLevel(rms: number): void {
        const pct = Math.min(100, Math.max(0, rms * METER_SCALE));
        fill.style.height = pct.toFixed(1) + "%";
        // green < 60%, yellow < 85%, red >= 85%
        if (pct >= 85) fill.style.background = "#e0382a";
        else if (pct >= 60) fill.style.background = "#e0c22a";
        else fill.style.background = "#3ad04a";
    }

    return { element, setLevel };
}

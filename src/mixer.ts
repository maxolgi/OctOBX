/*
 * mixer.ts — 10-channel-strip mixer view for the multi-instance OB-Xf synth.
 *
 * Each strip maps 1:1 to an OB-Xf instance (0..9; instance 9 is the dedicated
 * drum sampler). The vertical fader drives the legacy VOLUME param (idx 2);
 * the VU meter reads the per-instance RMS array that the global rack meter
 * loop already refreshes at ~30Hz via pingObxd() in obxd-rack.ts, so this
 * view only READS getObxdInstanceMeters() — it never pings the worklet.
 *
 * No external deps. The fader is a self-contained widget (does not reuse
 * createSlider/createObxdKnob) so the mixer has no SVG-asset dependency.
 */

import {
    setObxdInstanceParam,
    getObxdInstanceMeters,
    getInstanceVolumes,
    isObxdReady,
    setObxdMasterGain,
    getObxdMasterLevel,
} from "./obxd-audio";

const STRIP_COUNT = 10;
const VOLUME_IDX = 2;          // legacy OB-Xd ParamsEnum.h VOLUME
const METER_SCALE = 200;       // RMS 0.5 -> 100% fill (matches obxd-rack.ts)
const METER_INTERVAL_MS = 33;  // ~30Hz (matches obxd-rack.ts)
const DEFAULT_MASTER_GAIN = 0.85;  // mirrors obxd-audio.ts (must match)

type Cleanup = () => void;

export interface VuMeter {
    element: HTMLElement;
    setLevel: (rms: number) => void;
}

interface VerticalFader extends HTMLElement {
    setValue: (v: number) => void;
}

interface FaderOptions {
    idx: number;
    initial: number;
    onChange: (idx: number, value: number) => void;
}

function clamp01(v: number): number {
    if (v < 0) return 0;
    if (v > 1) return 1;
    if (Number.isNaN(v)) return 0;
    return v;
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

// ===========================================================================
// createVerticalFader — internal self-contained vertical fader (0..1, up=up)
// ===========================================================================

function createVerticalFader(opts: FaderOptions): VerticalFader {
    const { idx, initial, onChange } = opts;
    let value = clamp01(initial);

    const wrap = document.createElement("div");
    wrap.className = "mixer-fader";
    wrap.setAttribute("role", "slider");
    wrap.setAttribute("tabindex", "0");
    wrap.setAttribute("aria-label", "volume");
    wrap.setAttribute("aria-valuemin", "0");
    wrap.setAttribute("aria-valuemax", "100");
    wrap.setAttribute("aria-valuenow", String(Math.round(value * 100)));
    wrap.title = "Volume";
    wrap.style.cssText = [
        "position: relative",
        "width: 24px",
        "height: 180px",
        "background: #1a1a1a",
        "border: 1px solid #333",
        "border-radius: 4px",
        "touch-action: none",
        "cursor: ns-resize",
        "user-select: none",
    ].join("; ");

    const fill = document.createElement("div");
    fill.style.cssText = [
        "position: absolute",
        "left: 0",
        "bottom: 0",
        "width: 100%",
        "height: 0%",
        "background: linear-gradient(to top, #2a5a8a, #4a8acc)",
        "border-radius: 3px",
    ].join("; ");
    wrap.appendChild(fill);

    // Thumb extends 2px beyond the track on each side (a classic fader cap).
    const thumb = document.createElement("div");
    thumb.style.cssText = [
        "position: absolute",
        "left: -2px",
        "width: 28px",
        "height: 6px",
        "background: #d8d8d8",
        "border: 1px solid #888",
        "border-radius: 2px",
        "pointer-events: none",
    ].join("; ");
    wrap.appendChild(thumb);

    function paint(): void {
        const pct = value * 100;
        fill.style.height = pct.toFixed(1) + "%";
        // Center the 6px thumb on the value level.
        const topPct = (1 - value) * 100;
        thumb.style.top = `calc(${topPct.toFixed(1)}% - 3px)`;
        wrap.setAttribute("aria-valuenow", String(Math.round(value * 100)));
    }
    paint();

    function setValue(v: number, fire: boolean): void {
        value = clamp01(v);
        paint();
        if (fire) onChange(idx, value);
    }

    let dragging = false;

    function valueFromPointer(clientY: number): number {
        const rect = wrap.getBoundingClientRect();
        if (rect.height <= 0) return value;
        return clamp01(1 - (clientY - rect.top) / rect.height);
    }

    wrap.addEventListener("pointerdown", (ev: PointerEvent) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        dragging = true;
        (ev.target as Element).setPointerCapture?.(ev.pointerId);
        setValue(valueFromPointer(ev.clientY), true);
    });
    wrap.addEventListener("pointermove", (ev: PointerEvent) => {
        if (!dragging) return;
        setValue(valueFromPointer(ev.clientY), true);
    });
    wrap.addEventListener("pointerup", (ev: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        (ev.target as Element).releasePointerCapture?.(ev.pointerId);
    });
    wrap.addEventListener("pointercancel", () => { dragging = false; });

    wrap.addEventListener("wheel", (ev: WheelEvent) => {
        ev.preventDefault();
        const dir = ev.deltaY < 0 ? 1 : -1;
        const fine = ev.shiftKey || ev.ctrlKey ? 0.01 : 0.03;
        setValue(value + dir * fine, true);
    }, { passive: false });

    // Double-click resets to the seeded default (the engine's value at mount).
    wrap.addEventListener("dblclick", () => setValue(initial, true));

    wrap.addEventListener("keydown", (ev: KeyboardEvent) => {
        let handled = true;
        const fine = ev.shiftKey ? 0.01 : 0.03;
        switch (ev.key) {
            case "ArrowUp":   setValue(value + fine, true); break;
            case "ArrowDown": setValue(value - fine, true); break;
            case "PageUp":    setValue(value + 0.1, true); break;
            case "PageDown":  setValue(value - 0.1, true); break;
            case "Home":      setValue(1, true); break;
            case "End":       setValue(0, true); break;
            default: handled = false;
        }
        if (handled) ev.preventDefault();
    });

    const widget = wrap as unknown as VerticalFader;
    // setValue (no fire) is used by seeding/syncing from the engine.
    widget.setValue = (v: number) => setValue(v, false);
    return widget;
}

// ===========================================================================
// mountMixer — build the 10-strip mixer into a container
// ===========================================================================

export function mountMixer(container: HTMLElement): Cleanup {
    container.innerHTML = "";

    const root = document.createElement("div");
    root.className = "mixer-root";
    root.style.cssText = [
        "display: flex",
        "flex-direction: column",
        "gap: 8px",
        "padding: 8px",
        "font: 12px system-ui, -apple-system, 'Segoe UI', sans-serif",
        "color: #ddd",
    ].join("; ");

    const row = document.createElement("div");
    row.className = "mixer-row";
    row.style.cssText = [
        "display: flex",
        "flex-direction: row",
        "gap: 8px",
        "overflow-x: auto",
        "padding-bottom: 4px",
    ].join("; ");
    root.appendChild(row);

    const meters: VuMeter[] = [];
    const faders: VerticalFader[] = [];

    for (let i = 0; i < STRIP_COUNT; i++) {
        const isDrums = i === 9;
        const label = isDrums ? "Drums" : "OB-Xf " + (i + 1);

        const strip = document.createElement("div");
        strip.className = "mixer-strip";
        strip.style.cssText = [
            "display: flex",
            "flex-direction: column",
            "align-items: center",
            "gap: 6px",
            "width: 64px",
            "flex: 0 0 auto",
        ].join("; ");

        // Meter sits left of the fader on the same row.
        const faderRow = document.createElement("div");
        faderRow.style.cssText = [
            "display: flex",
            "flex-direction: row",
            "gap: 4px",
            "align-items: center",
        ].join("; ");

        const meter = createVuMeter();
        meter.element.style.width = "10px";
        meters.push(meter);
        faderRow.appendChild(meter.element);

        const fader = createVerticalFader({
            idx: i,
            initial: getInstanceVolumes()[i],
            onChange: (instanceId, value01) =>
                setObxdInstanceParam(instanceId, VOLUME_IDX, value01),
        });
        faders.push(fader);
        faderRow.appendChild(fader);

        strip.appendChild(faderRow);

        const bottomLabel = document.createElement("div");
        bottomLabel.textContent = label;
        bottomLabel.style.cssText = [
            "font-size: 11px",
            "text-align: center",
            "white-space: nowrap",
        ].join("; ");
        strip.appendChild(bottomLabel);

        row.appendChild(strip);
    }

    // Master strip — a separator then a master fader/VU riding the whole mix.
    // The fader drives the master GainNode in obxd-audio.ts; the VU reads the
    // post-fader AnalyserNode.
    const separator = document.createElement("div");
    separator.style.cssText = [
        "width: 2px",
        "align-self: stretch",
        "background: #444",
        "margin: 0 6px",
        "flex: 0 0 auto",
    ].join("; ");
    row.appendChild(separator);

    const masterStrip = document.createElement("div");
    masterStrip.className = "mixer-strip mixer-master";
    masterStrip.style.cssText = [
        "display: flex",
        "flex-direction: column",
        "align-items: center",
        "gap: 6px",
        "width: 64px",
        "flex: 0 0 auto",
    ].join("; ");

    const masterFaderRow = document.createElement("div");
    masterFaderRow.style.cssText = [
        "display: flex",
        "flex-direction: row",
        "gap: 4px",
        "align-items: center",
    ].join("; ");

    const masterMeter = createVuMeter();
    masterMeter.element.style.width = "10px";
    masterFaderRow.appendChild(masterMeter.element);

    const masterFader = createVerticalFader({
        idx: 0,
        initial: DEFAULT_MASTER_GAIN,
        onChange: (_idx, value01) => setObxdMasterGain(value01),
    });
    masterFaderRow.appendChild(masterFader);

    masterStrip.appendChild(masterFaderRow);

    const masterLabel = document.createElement("div");
    masterLabel.textContent = "Master";
    masterLabel.style.cssText = [
        "font-size: 11px",
        "font-weight: 600",
        "text-align: center",
        "white-space: nowrap",
    ].join("; ");
    masterStrip.appendChild(masterLabel);

    row.appendChild(masterStrip);

    container.appendChild(root);

    // Meter loop — VU meters only. Faders are NOT pushed by the timer:
    // each fader reads the shared volume variable once when drawn (initial)
    // and moves only when dragged. No timer shoving values = no snap.
    const handle = setInterval(() => {
        if (!isObxdReady()) {
            for (let i = 0; i < STRIP_COUNT; i++) meters[i].setLevel(0);
            masterMeter.setLevel(0);
            return;
        }
        const m = getObxdInstanceMeters();
        for (let i = 0; i < STRIP_COUNT; i++) meters[i].setLevel(m[i] || 0);
        masterMeter.setLevel(getObxdMasterLevel());
    }, METER_INTERVAL_MS);

    return () => { clearInterval(handle); };
}

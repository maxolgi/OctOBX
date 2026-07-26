/*
 * obxd-knob.ts — vanilla SVG/DOM widget primitives for the OB-XD and OB-Xf
 * synth panels.
 *
 * Originally a rotary knob + toggle for the OB-XD panel; extended for the
 * OB-Xf UI port with four additional widget types: tri-state buttons,
 * selectors (dropdowns), linear sliders (horizontal + vertical), and
 * momentary buttons.
 *
 * No external deps. Every widget is a factory function that takes an
 * options object and returns an HTMLElement ready to insert into the panel
 * container. The OB-Xf widgets (triState/selector/slider/button) take
 * x/y/w/h and apply them as absolute-position inline styles, matching the
 * OB-Xf canvas-layout model.
 *
 * Conventions shared by all widgets:
 *  - Pointer events (pointerdown/move/up/cancel) via setPointerCapture,
 *    so drags keep tracking when the pointer leaves the widget. This
 *    covers mouse + touch + pen with one code path.
 *  - Continuous widgets expose a `setValue(v)` hook on the returned
 *    element so the panel can sync after a .fxp load or patch reset
 *    without round-tripping through onChange (which would echo back to
 *    the engine and form a write loop).
 *  - Colours use CSS variables (--accent, --panel, --border) with inline
 *    fallbacks so themes can override globally.
 *
 * createObxdKnob(): 40x40 SVG arc knob, sweeps -135° to +135° (270° total)
 * and fills proportionally to the value. Drag vertically (up = increase),
 * Shift+drag / wheel for fine control, double-click resets to default.
 * Reports value changes through `onChange(idx, value01)` — the caller is
 * responsible for forwarding to setObxdParam().
 *
 * createObxdToggle(): small labelled toggle button, emits 0/1.
 */

export interface KnobOptions {
    idx: number;              // ParamsEnum.h index — forwarded to setObxdParam
    label: string;            // Short label shown under the knob
    initial: number;          // Initial 0..1 value
    defaultValue?: number;    // Value used on double-click (defaults to `initial`)
    onChange: (idx: number, value: number) => void;
    format?: (value01: number) => string;   // Override the default "% %"
}

const SVG_NS = "http://www.w3.org/2000/svg";

// Arc geometry — the indicator travels 270° around the knob, starting
// at -135° (bottom-left) and ending at +135° (bottom-right).
const ARC_START_DEG = -135;
const ARC_SWEEP_DEG = 270;

function polar(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
    const rad = (deg - 90) * Math.PI / 180;   // 0° at top
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

// Compute the SVG path "d" attribute for an arc segment from startDeg
// to endDeg along radius r centred at (cx,cy). largeArc=1 when the
// swept angle exceeds 180°.
function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
    const a = polar(cx, cy, r, startDeg);
    const b = polar(cx, cy, r, endDeg);
    const large = (endDeg - startDeg) <= 180 ? 0 : 1;
    return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

export function createObxdKnob(opts: KnobOptions): HTMLElement {
    const {
        idx,
        label,
        initial,
        defaultValue = opts.initial,
        onChange,
        format,
    } = opts;

    let value = clamp01(initial);

    const wrap = document.createElement("div");
    wrap.className = "obxd-knob";
    wrap.setAttribute("role", "slider");
    wrap.setAttribute("tabindex", "0");
    wrap.setAttribute("aria-label", label);
    wrap.setAttribute("aria-valuemin", "0");
    wrap.setAttribute("aria-valuemax", "100");
    wrap.setAttribute("aria-valuenow", String(Math.round(value * 100)));
    wrap.title = label;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 40 40");
    svg.setAttribute("width", "40");
    svg.setAttribute("height", "40");
    svg.style.display = "block";

    const cx = 20, cy = 20, rOut = 16, rIn = 10;

    // Background track — full 270° arc in dim grey.
    const trackPath = document.createElementNS(SVG_NS, "path");
    trackPath.setAttribute("d", arcPath(cx, cy, rOut, ARC_START_DEG, ARC_START_DEG + ARC_SWEEP_DEG));
    trackPath.setAttribute("fill", "none");
    trackPath.setAttribute("stroke", "var(--border, #3a3a3a)");
    trackPath.setAttribute("stroke-width", "3");
    trackPath.setAttribute("stroke-linecap", "round");
    svg.appendChild(trackPath);

    // Active arc — proportional to value, in accent green.
    const valuePath = document.createElementNS(SVG_NS, "path");
    valuePath.setAttribute("fill", "none");
    valuePath.setAttribute("stroke", "var(--accent, #0c0)");
    valuePath.setAttribute("stroke-width", "3");
    valuePath.setAttribute("stroke-linecap", "round");
    svg.appendChild(valuePath);

    // Knob body — concentric circle, dim panel colour.
    const body = document.createElementNS(SVG_NS, "circle");
    body.setAttribute("cx", String(cx));
    body.setAttribute("cy", String(cy));
    body.setAttribute("r", String(rIn));
    body.setAttribute("fill", "var(--panel, #2a2a2a)");
    body.setAttribute("stroke", "#444");
    body.setAttribute("stroke-width", "1");
    svg.appendChild(body);

    // Indicator — a short line from centre pointing at current value.
    const indicator = document.createElementNS(SVG_NS, "line");
    indicator.setAttribute("stroke", "var(--accent, #0c0)");
    indicator.setAttribute("stroke-width", "2");
    indicator.setAttribute("stroke-linecap", "round");
    svg.appendChild(indicator);

    function paint(): void {
        const endDeg = ARC_START_DEG + value * ARC_SWEEP_DEG;
        valuePath.setAttribute("d", arcPath(cx, cy, rOut, ARC_START_DEG, endDeg));
        const tip = polar(cx, cy, rIn - 1, endDeg);
        const base = polar(cx, cy, 3, endDeg);
        indicator.setAttribute("x1", String(base.x));
        indicator.setAttribute("y1", String(base.y));
        indicator.setAttribute("x2", String(tip.x));
        indicator.setAttribute("y2", String(tip.y));
    }
    paint();

    const labelEl = document.createElement("div");
    labelEl.className = "obxd-knob-label";
    labelEl.textContent = label;

    const valueEl = document.createElement("div");
    valueEl.className = "obxd-knob-value";
    valueEl.textContent = formatValue(value);

    function formatValue(v: number): string {
        if (format) return format(v);
        return Math.round(v * 100) + "%";
    }

    function setValue(v: number, fire: boolean): void {
        value = clamp01(v);
        paint();
        valueEl.textContent = formatValue(value);
        wrap.setAttribute("aria-valuenow", String(Math.round(value * 100)));
        if (fire) onChange(idx, value);
    }

    // Drag handling — global listeners so the drag continues even when the
    // pointer leaves the knob. Vertical drag: dy positive (downward)
    // decreases, dy negative (upward) increases. The pixel-to-value scale
    // is 0.005 per pixel (200px = full sweep); Shift divides by 10.
    let dragging = false;
    let lastY = 0;

    function onPointerDown(ev: PointerEvent): void {
        if (ev.button !== 0) return;
        ev.preventDefault();
        dragging = true;
        lastY = ev.clientY;
        (ev.target as Element).setPointerCapture?.(ev.pointerId);
        wrap.classList.add("dragging");
    }
    function onPointerMove(ev: PointerEvent): void {
        if (!dragging) return;
        const dy = ev.clientY - lastY;
        lastY = ev.clientY;
        const scale = ev.shiftKey ? 0.0005 : 0.005;
        setValue(value - dy * scale, true);
    }
    function onPointerUp(ev: PointerEvent): void {
        if (!dragging) return;
        dragging = false;
        wrap.classList.remove("dragging");
        (ev.target as Element).releasePointerCapture?.(ev.pointerId);
    }

    wrap.addEventListener("pointerdown", onPointerDown);
    wrap.addEventListener("pointermove", onPointerMove);
    wrap.addEventListener("pointerup", onPointerUp);
    wrap.addEventListener("pointercancel", onPointerUp);

    // Wheel — fine control; Ctrl makes it even finer.
    function onWheel(ev: WheelEvent): void {
        ev.preventDefault();
        const dir = ev.deltaY < 0 ? 1 : -1;
        const fine = ev.shiftKey || ev.ctrlKey ? 0.01 : 0.03;
        setValue(value + dir * fine, true);
    }
    wrap.addEventListener("wheel", onWheel, { passive: false });

    // Double-click — reset to default.
    wrap.addEventListener("dblclick", () => {
        setValue(defaultValue, true);
    });

    // Keyboard — arrow keys nudge by 1% (or 0.5% with Shift). Home/End
    // jump to min/max. PageUp/Down jump by 10%.
    function onKeyDown(ev: KeyboardEvent): void {
        let handled = true;
        const fine = ev.shiftKey ? 0.005 : 0.02;
        switch (ev.key) {
            case "ArrowUp":
            case "ArrowRight": setValue(value + fine, true); break;
            case "ArrowDown":
            case "ArrowLeft":  setValue(value - fine, true); break;
            case "PageUp":     setValue(value + 0.1, true); break;
            case "PageDown":   setValue(value - 0.1, true); break;
            case "Home":       setValue(0, true); break;
            case "End":        setValue(1, true); break;
            default: handled = false;
        }
        if (handled) ev.preventDefault();
    }
    wrap.addEventListener("keydown", onKeyDown);

    wrap.appendChild(svg);
    wrap.appendChild(labelEl);
    wrap.appendChild(valueEl);

    // Public update hook — lets the panel sync the knob after a .fxp
    // load or reset without round-tripping through onChange (which
    // would forward back to the engine and form a write loop).
    (wrap as HTMLElement & { setValue?: (v: number) => void }).setValue = (v: number) => {
        setValue(v, false);
    };

    return wrap;
}

export interface ToggleOptions {
    idx: number;
    label: string;
    initial: number;       // 0 or 1
    onChange: (idx: number, value: number) => void;
}

export function createObxdToggle(opts: ToggleOptions): HTMLElement {
    const { idx, label, initial, onChange } = opts;
    let on = initial >= 0.5;

    const wrap = document.createElement("button");
    wrap.type = "button";
    wrap.className = "obxd-toggle" + (on ? " obxd-toggle-on" : "");
    wrap.setAttribute("aria-pressed", on ? "true" : "false");
    wrap.setAttribute("aria-label", label);
    wrap.title = label;
    wrap.textContent = label;

    function paint(): void {
        wrap.classList.toggle("obxd-toggle-on", on);
        wrap.setAttribute("aria-pressed", on ? "true" : "false");
    }
    paint();

    wrap.addEventListener("click", () => {
        on = !on;
        paint();
        onChange(idx, on ? 1 : 0);
    });

    (wrap as HTMLElement & { setValue?: (v: number) => void }).setValue = (v: number) => {
        on = v >= 0.5;
        paint();
    };

    return wrap;
}

// ===========================================================================
// Tri-state button — cycles 0 → 0.5 → 1 → 0 on click (Cmd-click reverses).
// Used for LFO routing (Off / On / Inverted) and noise color (White/Pink/Red).
// ===========================================================================

export interface TriStateOptions {
    x: number; y: number; w: number; h: number;
    labels: { zero: string; half: string; one: string };
    initialValue?: number;    // 0 | 0.5 | 1  (defaults to 0)
    onChange: (v: number) => void;
}

const TRI_STEPS = [0, 0.5, 1] as const;

// Background colours per state — dim → green → amber. Override via CSS by
// targeting .obxd-tri-state[data-state="0|0.5|1"].
const TRI_BG: Record<string, string> = {
    "0":   "var(--panel, #2a2a2a)",
    "0.5": "var(--accent, #0c0)",
    "1":   "#c80",                  // amber — distinct from accent green
};

export function createTriStateButton(opts: TriStateOptions): HTMLElement {
    const { x, y, w, h, labels, onChange } = opts;
    let value = clamp01(opts.initialValue ?? 0);
    // Snap to the nearest valid step (0 / 0.5 / 1) so externally-fed values
    // from a .fxp load land on a real state even if slightly off.
    if (value !== 0 && value !== 0.5 && value !== 1) {
        value = TRI_STEPS.reduce((best, s) =>
            Math.abs(s - value) < Math.abs(best - value) ? s : best, 0);
    }

    const wrap = document.createElement("button");
    wrap.type = "button";
    wrap.className = "obxd-tri-state";
    wrap.setAttribute("role", "button");
    wrap.setAttribute("aria-label", `${labels.zero} / ${labels.half} / ${labels.one}`);
    wrap.title = `${labels.zero} / ${labels.half} / ${labels.one}`;
    applyBounds(wrap, { x, y, w, h });
    //Centre the current-state label; ellipsis if it overflows the small frame.
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";
    wrap.style.justifyContent = "center";
    wrap.style.padding = "0 2px";
    wrap.style.border = "1px solid var(--border, #3a3a3a)";
    wrap.style.borderRadius = "3px";
    wrap.style.color = "#fff";
    wrap.style.font = "9px/1 system-ui, sans-serif";
    wrap.style.cursor = "pointer";
    wrap.style.userSelect = "none";
    wrap.style.whiteSpace = "nowrap";
    wrap.style.overflow = "hidden";

    function labelFor(v: number): string {
        if (v === 0) return labels.zero;
        if (v === 0.5) return labels.half;
        return labels.one;
    }

    function paint(): void {
        const key = String(value);
        wrap.style.background = TRI_BG[key] ?? TRI_BG["0"];
        wrap.dataset.state = key;
        wrap.textContent = labelFor(value);
        wrap.setAttribute("aria-pressed", value === 0 ? "false" : "true");
    }
    paint();

    function advance(dir: 1 | -1): void {
        const i = TRI_STEPS.indexOf(value as 0 | 0.5 | 1);
        const next = (i + dir + TRI_STEPS.length) % TRI_STEPS.length;
        value = TRI_STEPS[next];
        paint();
        onChange(value);
    }

    // Left-click advances forward; Cmd-click (or right-click) reverses,
    // matching OB-Xf's MultiStateButton behaviour.
    wrap.addEventListener("click", (ev) => {
        ev.preventDefault();
        advance(ev.metaKey || ev.ctrlKey ? -1 : 1);
    });
    wrap.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        advance(-1);
    });

    // Keyboard — Space/Enter advances, Backspace reverses, 0/1/2 jump to step.
    wrap.tabIndex = 0;
    wrap.addEventListener("keydown", (ev) => {
        let handled = true;
        switch (ev.key) {
            case " ": case "Enter":      advance(1); break;
            case "Backspace":            advance(-1); break;
            case "0": value = 0;   paint(); onChange(0); break;
            case "1": value = 0.5; paint(); onChange(0.5); break;
            case "2": value = 1;   paint(); onChange(1); break;
            default: handled = false;
        }
        if (handled) ev.preventDefault();
    });

    (wrap as HTMLElement & { setValue?: (v: number) => void }).setValue = (v: number) => {
        const clamped = clamp01(v);
        value = (clamped === 0 || clamped === 0.5 || clamped === 1)
            ? clamped
            : TRI_STEPS.reduce((best, s) =>
                Math.abs(s - clamped) < Math.abs(best - clamped) ? s : best, 0);
        paint();
    };

    return wrap;
}

// ===========================================================================
// Selector — native <select> styled to match the panel. Mouse-wheel and
// arrow keys advance the choice (OB-Xf's ButtonList does the same). Emits
// (idx, label); the caller normalises idx/(N-1) to 0..1 for the engine.
// ===========================================================================

export interface SelectorOptions {
    x: number; y: number; w: number; h: number;
    choices: string[];
    initialIndex?: number;     // 0-based (defaults to 0)
    onChange: (idx: number, value: string) => void;
}

export function createSelector(opts: SelectorOptions): HTMLElement {
    const { x, y, w, h, choices, onChange } = opts;
    if (choices.length === 0) {
        throw new Error("createSelector: choices must not be empty");
    }
    let idx = clampInt(opts.initialIndex ?? 0, 0, choices.length - 1);

    const wrap = document.createElement("select");
    wrap.className = "obxd-selector";
    wrap.setAttribute("aria-label", "selector");
    wrap.title = choices[idx];
    applyBounds(wrap, { x, y, w, h });
    wrap.style.background = "var(--panel, #2a2a2a)";
    wrap.style.color = "#fff";
    wrap.style.border = "1px solid var(--border, #3a3a3a)";
    wrap.style.borderRadius = "3px";
    wrap.style.font = "10px/1 system-ui, sans-serif";
    wrap.style.padding = "0 2px";
    wrap.style.cursor = "pointer";

    for (let i = 0; i < choices.length; i++) {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = choices[i];
        wrap.appendChild(opt);
    }
    wrap.value = String(idx);

    function paint(): void {
        if (Number(wrap.value) !== idx) wrap.value = String(idx);
        wrap.title = choices[idx] ?? "";
    }
    paint();

    wrap.addEventListener("change", () => {
        idx = clampInt(Number(wrap.value) | 0, 0, choices.length - 1);
        paint();
        onChange(idx, choices[idx]);
    });

    // Wheel — advance one step per notch (like OB-Xf's ButtonList).
    wrap.addEventListener("wheel", (ev) => {
        ev.preventDefault();
        const dir = ev.deltaY < 0 ? -1 : 1;
        idx = clampInt(idx + dir, 0, choices.length - 1);
        paint();
        onChange(idx, choices[idx]);
    }, { passive: false });

    // Public update hook — receives the NORMALISED 0..1 value the engine
    // stores and converts back to an index. Matches how OB-Xf persists
    // selector values (idx / (N-1)).
    (wrap as HTMLElement & { setValue?: (v: number) => void }).setValue = (v: number) => {
        const norm = clamp01(v);
        idx = choices.length === 1 ? 0 : Math.round(norm * (choices.length - 1));
        paint();
    };

    return wrap;
}

// ===========================================================================
// Linear slider — SVG track + draggable thumb. Supports both orientations;
// orientation is explicit per the API (the OB-Xf layout derives it from
// w>h, but the caller resolves that and passes it in).
// ===========================================================================

export interface SliderOptions {
    x: number; y: number; w: number; h: number;
    orientation: "horizontal" | "vertical";
    initialValue?: number;     // 0..1 (defaults to 0)
    onChange: (v: number) => void;
}

export function createSlider(opts: SliderOptions): HTMLElement {
    const { x, y, w, h, orientation, onChange } = opts;
    const horiz = orientation === "horizontal";
    let value = clamp01(opts.initialValue ?? 0);

    const wrap = document.createElement("div");
    wrap.className = "obxd-slider obxd-slider-" + orientation;
    wrap.setAttribute("role", "slider");
    wrap.setAttribute("tabindex", "0");
    wrap.setAttribute("aria-label", "slider");
    wrap.setAttribute("aria-valuemin", "0");
    wrap.setAttribute("aria-valuemax", "100");
    wrap.setAttribute("aria-valuenow", String(Math.round(value * 100)));
    applyBounds(wrap, { x, y, w, h });
    wrap.style.touchAction = "none";   // let pointer events drive, not scroll

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    svg.style.display = "block";
    svg.style.overflow = "visible";

    // Track — full-length dim rounded rect.
    const track = document.createElementNS(SVG_NS, "rect");
    track.setAttribute("fill", "var(--panel, #2a2a2a)");
    track.setAttribute("stroke", "var(--border, #3a3a3a)");
    track.setAttribute("stroke-width", "1");
    svg.appendChild(track);

    // Active fill — proportional to value, in accent green.
    const fill = document.createElementNS(SVG_NS, "rect");
    fill.setAttribute("fill", "var(--accent, #0c0)");
    svg.appendChild(fill);

    // Thumb — small rounded rect centred on the value position.
    const thumb = document.createElementNS(SVG_NS, "rect");
    const thumbThick = Math.min(horiz ? h : w, 12);   // cross-axis thumb extent
    const thumbLen = Math.max(4, Math.min(thumbThick, (horiz ? w : h) / 4));
    thumb.setAttribute("width", String(horiz ? thumbLen : thumbThick));
    thumb.setAttribute("height", String(horiz ? thumbThick : thumbLen));
    thumb.setAttribute("rx", "2");
    thumb.setAttribute("ry", "2");
    thumb.setAttribute("fill", "#d4d4d4");
    thumb.setAttribute("stroke", "#444");
    thumb.setAttribute("stroke-width", "1");
    svg.appendChild(thumb);

    function paint(): void {
        // Track geometry — a thin rounded rect centred along the long axis.
        const trackThick = Math.max(3, (horiz ? h : w) / 3);
        if (horiz) {
            track.setAttribute("x", "0");
            track.setAttribute("y", String((h - trackThick) / 2));
            track.setAttribute("width", String(w));
            track.setAttribute("height", String(trackThick));
            track.setAttribute("rx", String(trackThick / 2));
            track.setAttribute("ry", String(trackThick / 2));
            const travel = w - thumbLen;
            const tx = value * travel;
            fill.setAttribute("x", "0");
            fill.setAttribute("y", String((h - trackThick) / 2));
            fill.setAttribute("width", String(tx + thumbLen / 2));
            fill.setAttribute("height", String(trackThick));
            thumb.setAttribute("x", String(tx));
            thumb.setAttribute("y", String((h - thumbThick) / 2));
        } else {
            track.setAttribute("x", String((w - trackThick) / 2));
            track.setAttribute("y", "0");
            track.setAttribute("width", String(trackThick));
            track.setAttribute("height", String(h));
            track.setAttribute("rx", String(trackThick / 2));
            track.setAttribute("ry", String(trackThick / 2));
            const travel = h - thumbLen;
            const ty = (1 - value) * travel;     // top = max, bottom = min
            fill.setAttribute("x", String((w - trackThick) / 2));
            fill.setAttribute("y", String(ty + thumbLen / 2));
            fill.setAttribute("width", String(trackThick));
            fill.setAttribute("height", String(h - (ty + thumbLen / 2)));
            thumb.setAttribute("x", String((w - thumbThick) / 2));
            thumb.setAttribute("y", String(ty));
        }
    }
    paint();

    function setValue(v: number, fire: boolean): void {
        value = clamp01(v);
        paint();
        wrap.setAttribute("aria-valuenow", String(Math.round(value * 100)));
        if (fire) onChange(value);
    }

    // Drag — pointer events track globally so the drag persists outside the
    // widget. For horizontal, dx increases value; for vertical, dy decreases
    // (drag up = louder, like a mixer fader).
    let dragging = false;

    function valueFromPointer(clientX: number, clientY: number): number {
        const rect = wrap.getBoundingClientRect();
        if (horiz) {
            const travel = rect.width - thumbLen;
            if (travel <= 0) return value;
            const ratio = (clientX - rect.left - thumbLen / 2) / travel;
            return clamp01(ratio);
        } else {
            const travel = rect.height - thumbLen;
            if (travel <= 0) return value;
            const ratio = 1 - (clientY - rect.top - thumbLen / 2) / travel;
            return clamp01(ratio);
        }
    }

    function onPointerDown(ev: PointerEvent): void {
        if (ev.button !== 0) return;
        ev.preventDefault();
        dragging = true;
        (ev.target as Element).setPointerCapture?.(ev.pointerId);
        wrap.classList.add("dragging");
        // Jump-to-click on the track (matches native slider UX).
        setValue(valueFromPointer(ev.clientX, ev.clientY), true);
    }
    function onPointerMove(ev: PointerEvent): void {
        if (!dragging) return;
        setValue(valueFromPointer(ev.clientX, ev.clientY), true);
    }
    function onPointerUp(ev: PointerEvent): void {
        if (!dragging) return;
        dragging = false;
        wrap.classList.remove("dragging");
        (ev.target as Element).releasePointerCapture?.(ev.pointerId);
    }

    wrap.addEventListener("pointerdown", onPointerDown);
    wrap.addEventListener("pointermove", onPointerMove);
    wrap.addEventListener("pointerup", onPointerUp);
    wrap.addEventListener("pointercancel", onPointerUp);

    // Wheel — fine control.
    wrap.addEventListener("wheel", (ev) => {
        ev.preventDefault();
        const dir = ev.deltaY < 0 ? 1 : -1;
        const fine = ev.shiftKey || ev.ctrlKey ? 0.01 : 0.03;
        setValue(value + dir * fine, true);
    }, { passive: false });

    // Keyboard — arrows nudge, Home/End jump to ends.
    wrap.addEventListener("keydown", (ev) => {
        let handled = true;
        const fine = ev.shiftKey ? 0.005 : 0.02;
        const posKey = horiz ? "ArrowRight" : "ArrowUp";
        const negKey = horiz ? "ArrowLeft"  : "ArrowDown";
        switch (ev.key) {
            case posKey:     setValue(value + fine, true); break;
            case negKey:     setValue(value - fine, true); break;
            case "PageUp":   setValue(value + 0.1, true); break;
            case "PageDown": setValue(value - 0.1, true); break;
            case "Home":     setValue(0, true); break;
            case "End":      setValue(1, true); break;
            default: handled = false;
        }
        if (handled) ev.preventDefault();
    });

    wrap.appendChild(svg);

    (wrap as HTMLElement & { setValue?: (v: number) => void }).setValue = (v: number) => {
        setValue(v, false);
    };

    return wrap;
}

// ===========================================================================
// Button — momentary trigger button (no toggle state). Used by the
// programmer row (prev/next/save/init/randomize) and any other click-to-fire
// control. Mirrors createObxdToggle's styling so the panel reads consistently.
// ===========================================================================

export interface ButtonOptions {
    x: number; y: number; w: number; h: number;
    label?: string;
    onClick: () => void;
}

export function createButton(opts: ButtonOptions): HTMLElement {
    const { x, y, w, h, label, onClick } = opts;

    const wrap = document.createElement("button");
    wrap.type = "button";
    wrap.className = "obxd-button";
    wrap.setAttribute("role", "button");
    if (label !== undefined) {
        wrap.setAttribute("aria-label", label);
        wrap.title = label;
        wrap.textContent = label;
    }
    applyBounds(wrap, { x, y, w, h });
    wrap.style.background = "var(--panel, #2a2a2a)";
    wrap.style.color = "#fff";
    wrap.style.border = "1px solid var(--border, #3a3a3a)";
    wrap.style.borderRadius = "3px";
    wrap.style.font = "10px/1 system-ui, sans-serif";
    wrap.style.cursor = "pointer";
    wrap.style.whiteSpace = "nowrap";
    wrap.style.overflow = "hidden";

    wrap.addEventListener("click", (ev) => {
        ev.preventDefault();
        onClick();
    });

    return wrap;
}

// ===========================================================================
// Shared helpers
// ===========================================================================

function clamp01(v: number): number {
    if (v < 0) return 0;
    if (v > 1) return 1;
    if (Number.isNaN(v)) return 0;
    return v;
}

function clampInt(v: number, lo: number, hi: number): number {
    if (Number.isNaN(v)) return lo;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return Math.round(v);
}

// Apply x/y/w/h as absolute-position inline styles. The panel container is
// expected to be position:relative (or absolute) so these coordinates land
// in the right place — matching OB-Xf's canvas-layout model.
function applyBounds(el: HTMLElement, b: { x: number; y: number; w: number; h: number }): void {
    el.style.position = "absolute";
    el.style.left = `${b.x}px`;
    el.style.top = `${b.y}px`;
    el.style.width = `${b.w}px`;
    el.style.height = `${b.h}px`;
    el.style.boxSizing = "border-box";
}

/* ===========================================================================
 * Usage examples
 * ---------------------------------------------------------------------------
 * The panel container must be position:relative so the x/y/w/h on the OB-Xf
 * widgets resolve against it. All four OB-Xf widget factories return an
 * HTMLElement that is ready to appendChild() directly.
 *
 *   import {
 *     createObxdKnob, createObxdToggle,
 *     createTriStateButton, createSelector, createSlider, createButton,
 *   } from "./obxd-knob.ts";
 *
 *   const panel = document.getElementById("obxf-panel")!;
 *   panel.style.position = "relative";
 *
 *   // --- Tri-state: LFO1 → Osc1 Pitch (Off / On / Inverted) ---
 *   const lfo1ToOsc1 = createTriStateButton({
 *     x: 692, y: 293, w: 23, h: 35,
 *     labels: { zero: "Off", half: "On", one: "Inverted" },
 *     initialValue: 0,
 *     onChange: (v) => setObxdParam("LFO1ToOsc1Pitch", v),
 *   });
 *   panel.appendChild(lfo1ToOsc1);
 *   // ...later, after a .fxp load:
 *   (lfo1ToOsc1 as any).setValue?.(0.5);   // sync without re-firing onChange
 *
 *   // --- Selector: Polyphony (1..32). Engine stores idx/(N-1) in 0..1. ---
 *   const poly = createSelector({
 *     x: 56, y: 235, w: 31, h: 31,
 *     choices: ["1","2","3","4", "...", "32"],
 *     initialIndex: 7,                     // default 8 voices
 *     onChange: (idx, label) => {
 *       const normalized = idx / 31;       // = idx / (choices.length - 1)
 *       setObxdParam("Polyphony", normalized);
 *     },
 *   });
 *   panel.appendChild(poly);
 *   // .fxp sync — pass the NORMALISED engine value, the widget converts:
 *   (poly as any).setValue?.(8 / 32);      // 8 voices
 *
 *   // --- Slider: FilterEnvAttackCurve (horizontal, 47x12) ---
 *   const envCurve = createSlider({
 *     x: 844, y: 111, w: 47, h: 12,
 *     orientation: "horizontal",
 *     initialValue: 0,
 *     onChange: (v) => setObxdParam("FilterEnvAttackCurve", v),
 *   });
 *   panel.appendChild(envCurve);
 *
 *   // --- Slider: LFO1PW (vertical, 12x47) ---
 *   const lfo1pw = createSlider({
 *     x: 598, y: 348, w: 12, h: 47,
 *     orientation: "vertical",
 *     initialValue: 0,
 *     onChange: (v) => setObxdParam("LFO1PW", v),
 *   });
 *   panel.appendChild(lfo1pw);
 *
 *   // --- Button: prev/next/save (programmer row, momentary) ---
 *   panel.appendChild(createButton({
 *     x: 294, y: 504, w: 23, h: 35,
 *     onClick: () => loadPrevPatch(),
 *   }));
 *   panel.appendChild(createButton({
 *     x: 450, y: 504, w: 23, h: 35,
 *     label: "INIT",
 *     onClick: () => initPatch(),
 *   }));
 *
 * =========================================================================== */


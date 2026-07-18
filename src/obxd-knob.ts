/*
 * obxd-knob.ts — vanilla SVG knob + toggle-button widgets for the
 * OB-XD synth panel.
 *
 * No external deps. Each knob renders as a 40x40 SVG arc that sweeps
 * -135° to +135° (270° total) and fills proportionally to the value.
 * Drag vertically (drag up = increase), Shift+drag / wheel for fine
 * control, double-click resets to default. The knob reports value
 * changes through `onChange(value01)` — the caller is responsible for
 * forwarding to setObxdParam().
 *
 * For boolean-ish params use createObxdToggle(), which renders a small
 * labelled toggle button and emits 0/1.
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

function clamp01(v: number): number {
    if (v < 0) return 0;
    if (v > 1) return 1;
    if (Number.isNaN(v)) return 0;
    return v;
}

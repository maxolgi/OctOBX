/*
 * mixer/knob.ts — canvas arc knob, vanilla-TS port of CakeMix's
 * components/Knob.tsx (same 270° arc geometry, log/power normalization,
 * drag sensitivity, shift-fine, double-click reset). No framework, no
 * deps. The widget OWNS its drag interaction; the caller stays in charge
 * of the value via onChange + set().
 */

export interface KnobOptions {
    label: string;
    value: number;
    min: number;
    max: number;
    defaultValue: number;                 // double-click reset target
    onChange: (value: number) => void;
    format?: (value: number) => string;   // display formatting
    unit?: string;
    size?: number;                        // diameter px (default 36)
    color?: string;                       // arc color (default #4a8fdd)
    log?: boolean;                        // logarithmic scale
}

export interface KnobHandle {
    element: HTMLElement;
    /** Push a new value into the widget without firing onChange. */
    set(value: number): void;
    get(): number;
}

// Arc geometry (canvas coords: 0 rad = 3 o'clock, angles clockwise):
//   start = 0.75π (7:30), sweep = 1.5π (270°), bottom gap.
const ARC_START = 0.75 * Math.PI;
const ARC_SWEEP = 1.5 * Math.PI;

function normalizeValue(value: number, min: number, max: number, log: boolean): number {
    if (max <= min) return 0;
    const t = (value - min) / (max - min);
    if (!log) return t;
    // True log for positive-only ranges; power curve otherwise (more
    // resolution near the bottom of e.g. -80..0 dB thresholds).
    if (min > 0 && max > 0) {
        const v = value <= 0 ? min : value;
        return Math.log(v / min) / Math.log(max / min);
    }
    return Math.pow(Math.max(0, t), 0.4);
}

function denormalizeValue(t: number, min: number, max: number, log: boolean): number {
    if (max <= min) return min;
    t = Math.max(0, Math.min(1, t));
    if (!log) return min + t * (max - min);
    if (min > 0 && max > 0) {
        return min * Math.pow(max / min, t);
    }
    return min + Math.pow(t, 2.5) * (max - min);
}

export function createKnob(opts: KnobOptions): KnobHandle {
    const size = opts.size ?? 36;
    const color = opts.color ?? "#4a8fdd";
    const isLog = !!opts.log;
    const unit = opts.unit ?? "";
    const fmt = (v: number) => (opts.format ? opts.format(v) : String(Math.round(v)));

    let value = opts.value;

    const container = document.createElement("div");
    container.className = "knob-container";

    const labelEl = document.createElement("span");
    labelEl.className = "knob-label";
    labelEl.textContent = opts.label;
    container.appendChild(labelEl);

    const canvas = document.createElement("canvas");
    canvas.className = "knob-canvas";
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    container.appendChild(canvas);

    const valueEl = document.createElement("span");
    valueEl.className = "knob-value";
    container.appendChild(valueEl);

    function draw(): void {
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== size * dpr) {
            canvas.width = size * dpr;
            canvas.height = size * dpr;
            ctx.scale(dpr, dpr);
        }

        ctx.clearRect(0, 0, size, size);
        ctx.lineCap = "round";

        const cx = size / 2;
        const cy = size / 2;
        const rOuter = size / 2;
        const rBg = Math.max(1, rOuter - 1);
        const rArc = Math.max(1, rOuter - 2.5);
        const rInner = Math.max(1, rOuter - 4.5);
        const arcLw = Math.max(1.5, size * 0.08);
        const norm = Math.max(0, Math.min(1, normalizeValue(value, opts.min, opts.max, isLog)));

        // 1. Background circle.
        ctx.beginPath();
        ctx.arc(cx, cy, rBg, 0, Math.PI * 2);
        ctx.fillStyle = "#1a1a25";
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "#2a2a35";
        ctx.stroke();

        // 2. Dim track + filled arc.
        ctx.beginPath();
        ctx.arc(cx, cy, rArc, ARC_START, ARC_START + ARC_SWEEP, false);
        ctx.lineWidth = arcLw;
        ctx.strokeStyle = "#2a2a35";
        ctx.stroke();
        if (norm > 0.001) {
            ctx.beginPath();
            ctx.arc(cx, cy, rArc, ARC_START, ARC_START + norm * ARC_SWEEP, false);
            ctx.lineWidth = arcLw;
            ctx.strokeStyle = color;
            ctx.stroke();
        }

        // 3. Center fill.
        ctx.beginPath();
        ctx.arc(cx, cy, rInner, 0, Math.PI * 2);
        ctx.fillStyle = "#16161e";
        ctx.fill();

        // 4. Indicator line.
        const valAngle = ARC_START + norm * ARC_SWEEP;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + rArc * Math.cos(valAngle), cy + rArc * Math.sin(valAngle));
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#ccc";
        ctx.stroke();
    }

    function paintText(): void {
        valueEl.textContent = `${fmt(value)}${unit}`;
        container.title = `${opts.label}: ${fmt(value)}${unit}`;
    }

    function commit(newValue: number): void {
        value = newValue;
        draw();
        paintText();
    }

    // ── Drag interaction (vertical delta, DAW-style; Shift = 5× finer) ────
    let dragging = false;
    let startY = 0;
    let startValue = 0;

    container.addEventListener("pointerdown", (ev: PointerEvent) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        dragging = true;
        startY = ev.clientY;
        startValue = value;
        (ev.target as Element).setPointerCapture?.(ev.pointerId);
    });
    container.addEventListener("pointermove", (ev: PointerEvent) => {
        if (!dragging) return;
        const delta = startY - ev.clientY;            // positive when dragging up
        const sensitivity = ev.shiftKey ? 500 : 100;  // px for full range
        const nd = delta / sensitivity;
        const startNorm = normalizeValue(startValue, opts.min, opts.max, isLog);
        const nv = denormalizeValue(startNorm + nd, opts.min, opts.max, isLog);
        commit(Math.max(opts.min, Math.min(opts.max, nv)));
        opts.onChange(value);
    });
    const endDrag = (ev: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        (ev.target as Element).releasePointerCapture?.(ev.pointerId);
    };
    container.addEventListener("pointerup", endDrag);
    container.addEventListener("pointercancel", endDrag);

    container.addEventListener("dblclick", (ev: MouseEvent) => {
        ev.preventDefault();
        commit(opts.defaultValue);
        opts.onChange(value);
    });

    commit(value);

    return {
        element: container,
        set(v: number) {
            if (v === value) return;
            commit(v);
        },
        get() { return value; },
    };
}

/*
 * obxd-knob.ts — OB-Xf VectorTheme SVG widget factories.
 *
 * Renders the REAL OB-Xf artwork from /obxf-assets/ (50 SVG files copied from
 * the OB-Xf VectorTheme). Every widget loads its SVG(s) from the asset basename
 * specified in ControlSpec.asset (matching the theme.xml `pic` attribute).
 *
 * Rendering models (matching OB-Xf's JUCE paint code):
 *  - Knob:     two-layer (knob-layer1 = body, knob-layer2 = pointer).
 *              Pointer rotated by (2·value − 1) · 135° via CSS transform.
 *  - Toggle:   single SVG frame-strip (button.svg = 4 frames, button-clear = 2).
 *              Frame selected via background-position-y.
 *  - TriState: same frame-strip approach, 3 frames cycling Off/On/Inv.
 *  - Selector: OB-Xf menu SVG as background, native <select> overlay for popup.
 *  - Slider:   two-layer (track + thumb), thumb translated along axis.
 *  - Button:   same as Toggle but momentary (no toggle state).
 *
 * Interaction logic (drag, wheel, keyboard, setValue) is unchanged from the
 * previous hand-drawn version — only the visual rendering layer changed.
 *
 * No external deps. Every widget is a factory function that returns an
 * ObxdWidget (HTMLElement & { setValue? }) ready to appendChild.
 */

export type ObxdWidget = HTMLElement & { setValue?: (v: number) => void };

const ASSET_BASE = "/obxf-assets";

// ===========================================================================
// Knob — two-layer SVG: static body + rotating pointer
// ===========================================================================

export interface KnobOptions {
    idx: number;
    label: string;
    initial: number;
    defaultValue?: number;
    onChange: (idx: number, value: number) => void;
    asset?: string;         // default "knob" → knob-layer1.svg + knob-layer2.svg
    size?: number;          // default 40 (matches SVG)
}

export function createObxdKnob(opts: KnobOptions): ObxdWidget {
    const {
        idx,
        label,
        initial,
        defaultValue = opts.initial,
        onChange,
        asset = "knob",
        size = 40,
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
    wrap.style.width = size + "px";
    wrap.style.height = size + "px";
    wrap.style.position = "absolute";
    wrap.style.cursor = "ns-resize";
    wrap.style.touchAction = "none";

    const body = document.createElement("img");
    body.src = `${ASSET_BASE}/${asset}-layer1.svg`;
    body.style.position = "absolute";
    body.style.top = "0";
    body.style.left = "0";
    body.style.width = size + "px";
    body.style.height = size + "px";
    body.style.pointerEvents = "none";
    body.draggable = false;
    wrap.appendChild(body);

    const pointer = document.createElement("img");
    pointer.src = `${ASSET_BASE}/${asset}-layer2.svg`;
    pointer.style.position = "absolute";
    pointer.style.top = "0";
    pointer.style.left = "0";
    pointer.style.width = size + "px";
    pointer.style.height = size + "px";
    pointer.style.transformOrigin = "center center";
    pointer.style.pointerEvents = "none";
    pointer.draggable = false;
    wrap.appendChild(pointer);

    function paint(): void {
        const angle = (2 * value - 1) * 135;
        pointer.style.transform = `rotate(${angle}deg)`;
    }
    paint();

    function setValue(v: number, fire: boolean): void {
        value = clamp01(v);
        paint();
        wrap.setAttribute("aria-valuenow", String(Math.round(value * 100)));
        if (fire) onChange(idx, value);
    }

    setupKnobInteraction(wrap, () => value, setValue, defaultValue);

    (wrap as ObxdWidget).setValue = (v: number) => setValue(v, false);
    return wrap;
}

// ===========================================================================
// Toggle — SVG frame-strip background, 2-state (on/off)
// ===========================================================================

export interface ToggleOptions {
    idx: number;
    label: string;
    initial: number;
    onChange: (idx: number, value: number) => void;
    asset?: string;         // default "button" (4-frame: off/up, off/down, on/up, on/down)
    x?: number; y?: number; w?: number; h?: number;
}

export function createObxdToggle(opts: ToggleOptions): ObxdWidget {
    const { idx, label, initial, onChange, asset = "button" } = opts;
    let on = initial >= 0.5;

    const wrap = document.createElement("div");
    wrap.className = "obxd-toggle";
    wrap.setAttribute("role", "switch");
    wrap.setAttribute("tabindex", "0");
    wrap.setAttribute("aria-checked", on ? "true" : "false");
    wrap.setAttribute("aria-label", label);
    wrap.title = label;
    wrap.style.cursor = "pointer";
    wrap.style.userSelect = "none";

    if (opts.x !== undefined) applyBounds(wrap, { x: opts.x, y: opts.y!, w: opts.w!, h: opts.h! });

    setFrameStrip(wrap, asset, opts.w ?? 23, opts.h ?? 35);

    let pressed = false;
    function paint(): void {
        const frame = (on ? 2 : 0) + (pressed ? 1 : 0);
        showFrame(wrap, frame);
        wrap.setAttribute("aria-checked", on ? "true" : "false");
    }
    paint();

    wrap.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        pressed = true;
        paint();
        (ev.target as Element).setPointerCapture?.(ev.pointerId);
    });
    wrap.addEventListener("pointerup", () => {
        if (!pressed) return;
        pressed = false;
        on = !on;
        paint();
        onChange(idx, on ? 1 : 0);
    });
    wrap.addEventListener("pointercancel", () => { pressed = false; paint(); });
    wrap.addEventListener("keydown", (ev) => {
        if (ev.key === " " || ev.key === "Enter") {
            ev.preventDefault();
            on = !on;
            paint();
            onChange(idx, on ? 1 : 0);
        }
    });

    (wrap as ObxdWidget).setValue = (v: number) => { on = v >= 0.5; paint(); };
    return wrap;
}

// ===========================================================================
// Tri-state button — SVG frame-strip, cycles 0 → 0.5 → 1 → 0
// ===========================================================================

export interface TriStateOptions {
    x: number; y: number; w: number; h: number;
    labels: { zero: string; half: string; one: string };
    initialValue?: number;
    onChange: (v: number) => void;
    asset?: string;
}

const TRI_STEPS = [0, 0.5, 1] as const;

export function createTriStateButton(opts: TriStateOptions): ObxdWidget {
    const { x, y, w, h, labels, onChange, asset = "button-slim" } = opts;
    let value = clamp01(opts.initialValue ?? 0);
    if (value !== 0 && value !== 0.5 && value !== 1) {
        value = TRI_STEPS.reduce((best, s) =>
            Math.abs(s - value) < Math.abs(best - value) ? s : best, 0);
    }

    const wrap = document.createElement("div");
    wrap.className = "obxd-tri-state";
    wrap.setAttribute("role", "button");
    wrap.setAttribute("tabindex", "0");
    wrap.setAttribute("aria-label", `${labels.zero} / ${labels.half} / ${labels.one}`);
    wrap.title = `${labels.zero} / ${labels.half} / ${labels.one}`;
    applyBounds(wrap, { x, y, w, h });
    wrap.style.cursor = "pointer";
    wrap.style.touchAction = "none";

    setFrameStrip(wrap, asset, w, h);

    let pressed = false;
    function paint(): void {
        const stepIdx = TRI_STEPS.indexOf(value as 0 | 0.5 | 1);
        const frame = stepIdx + (pressed ? 1 : 0);
        showFrame(wrap, frame);
    }
    paint();

    function advance(dir: 1 | -1): void {
        const i = TRI_STEPS.indexOf(value as 0 | 0.5 | 1);
        const next = (i + dir + TRI_STEPS.length) % TRI_STEPS.length;
        value = TRI_STEPS[next];
        paint();
        onChange(value);
    }

    wrap.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        pressed = true;
        paint();
        (ev.target as Element).setPointerCapture?.(ev.pointerId);
    });
    wrap.addEventListener("pointerup", (ev) => {
        if (!pressed) return;
        pressed = false;
        advance(ev.metaKey || ev.ctrlKey ? -1 : 1);
    });
    wrap.addEventListener("pointercancel", () => { pressed = false; paint(); });
    wrap.addEventListener("contextmenu", (ev) => { ev.preventDefault(); advance(-1); });
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

    (wrap as ObxdWidget).setValue = (v: number) => {
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
// Selector — OB-Xf menu SVG background + native <select> overlay
// ===========================================================================

export interface SelectorOptions {
    x: number; y: number; w: number; h: number;
    choices: string[];
    initialIndex?: number;
    onChange: (idx: number, value: string) => void;
    asset?: string;
}

export function createSelector(opts: SelectorOptions): ObxdWidget {
    const { x, y, w, h, choices, onChange, asset } = opts;
    if (choices.length === 0) throw new Error("createSelector: choices must not be empty");
    let idx = clampInt(opts.initialIndex ?? 0, 0, choices.length - 1);

    const wrap = document.createElement("div");
    wrap.className = "obxd-selector";
    wrap.style.position = "absolute";
    wrap.style.left = x + "px";
    wrap.style.top = y + "px";
    wrap.style.width = w + "px";
    wrap.style.height = h + "px";
    wrap.style.overflow = "hidden";
    wrap.title = choices[idx];

    if (asset) {
        const bg = document.createElement("img");
        bg.src = `${ASSET_BASE}/${asset}.svg`;
        bg.style.position = "absolute";
        bg.style.width = "100%";
        bg.style.height = "100%";
        bg.style.pointerEvents = "none";
        bg.draggable = false;
        wrap.appendChild(bg);
    }

    const sel = document.createElement("select");
    sel.style.position = "absolute";
    sel.style.left = "0";
    sel.style.top = "0";
    sel.style.width = "100%";
    sel.style.height = "100%";
    sel.style.background = "transparent";
    sel.style.border = "none";
    sel.style.outline = "none";
    sel.style.color = "#ff0000";
    sel.style.cursor = "pointer";
    sel.style.fontSize = "10px";
    sel.style.textAlign = "center";
    sel.style.appearance = "none";
    sel.style.fontFamily = '"Jersey20", monospace';
    sel.setAttribute("aria-label", "selector");

    for (let i = 0; i < choices.length; i++) {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = choices[i];
        sel.appendChild(opt);
    }
    sel.value = String(idx);

    sel.addEventListener("change", () => {
        idx = clampInt(Number(sel.value) | 0, 0, choices.length - 1);
        wrap.title = choices[idx];
        onChange(idx, choices[idx]);
    });
    sel.addEventListener("wheel", (ev) => {
        ev.preventDefault();
        const dir = ev.deltaY < 0 ? -1 : 1;
        idx = clampInt(idx + dir, 0, choices.length - 1);
        sel.value = String(idx);
        wrap.title = choices[idx];
        onChange(idx, choices[idx]);
    }, { passive: false });

    wrap.appendChild(sel);

    (wrap as ObxdWidget).setValue = (v: number) => {
        const norm = clamp01(v);
        idx = choices.length === 1 ? 0 : Math.round(norm * (choices.length - 1));
        sel.value = String(idx);
        wrap.title = choices[idx];
    };
    return wrap;
}

// ===========================================================================
// Linear slider — two-layer SVG (track + thumb)
// ===========================================================================

export interface SliderOptions {
    x: number; y: number; w: number; h: number;
    orientation: "horizontal" | "vertical";
    initialValue?: number;
    onChange: (v: number) => void;
    asset?: string;         // default derives from orientation
}

export function createSlider(opts: SliderOptions): ObxdWidget {
    const { x, y, w, h, orientation, onChange } = opts;
    const horiz = orientation === "horizontal";
    const assetPrefix = opts.asset ?? (horiz ? "slider-h" : "slider-v");
    let value = clamp01(opts.initialValue ?? 0);

    const wrap = document.createElement("div");
    wrap.className = "obxd-slider";
    wrap.setAttribute("role", "slider");
    wrap.setAttribute("tabindex", "0");
    wrap.setAttribute("aria-label", "slider");
    wrap.setAttribute("aria-valuemin", "0");
    wrap.setAttribute("aria-valuemax", "100");
    wrap.setAttribute("aria-valuenow", String(Math.round(value * 100)));
    applyBounds(wrap, { x, y, w, h });
    wrap.style.touchAction = "none";

    const track = document.createElement("img");
    track.src = `${ASSET_BASE}/${assetPrefix}-layer1.svg`;
    track.style.position = "absolute";
    track.style.width = "100%";
    track.style.height = "100%";
    track.style.pointerEvents = "none";
    track.draggable = false;
    wrap.appendChild(track);

    const thumb = document.createElement("img");
    thumb.src = `${ASSET_BASE}/${assetPrefix}-layer2.svg`;
    thumb.style.position = "absolute";
    thumb.style.pointerEvents = "none";
    thumb.draggable = false;
    wrap.appendChild(thumb);

    function paint(): void {
        if (horiz) {
            const travel = w - (thumb.naturalWidth || 12);
            thumb.style.left = (value * travel) + "px";
            thumb.style.top = "0";
            thumb.style.width = (thumb.naturalWidth || 12) + "px";
            thumb.style.height = "100%";
        } else {
            const travel = h - (thumb.naturalHeight || 12);
            thumb.style.top = ((1 - value) * travel) + "px";
            thumb.style.left = "0";
            thumb.style.width = "100%";
            thumb.style.height = (thumb.naturalHeight || 12) + "px";
        }
    }
    thumb.onload = paint;
    paint();

    function setValue(v: number, fire: boolean): void {
        value = clamp01(v);
        paint();
        wrap.setAttribute("aria-valuenow", String(Math.round(value * 100)));
        if (fire) onChange(value);
    }

    let dragging = false;

    function valueFromPointer(clientX: number, clientY: number): number {
        const rect = wrap.getBoundingClientRect();
        if (horiz) {
            if (rect.width <= 0) return value;
            return clamp01((clientX - rect.left) / rect.width);
        } else {
            if (rect.height <= 0) return value;
            return clamp01(1 - (clientY - rect.top) / rect.height);
        }
    }

    wrap.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        dragging = true;
        (ev.target as Element).setPointerCapture?.(ev.pointerId);
        wrap.classList.add("dragging");
        setValue(valueFromPointer(ev.clientX, ev.clientY), true);
    });
    wrap.addEventListener("pointermove", (ev) => {
        if (!dragging) return;
        setValue(valueFromPointer(ev.clientX, ev.clientY), true);
    });
    wrap.addEventListener("pointerup", (ev) => {
        if (!dragging) return;
        dragging = false;
        wrap.classList.remove("dragging");
        (ev.target as Element).releasePointerCapture?.(ev.pointerId);
    });
    wrap.addEventListener("pointercancel", () => { dragging = false; wrap.classList.remove("dragging"); });
    wrap.addEventListener("wheel", (ev) => {
        ev.preventDefault();
        const dir = ev.deltaY < 0 ? 1 : -1;
        const fine = ev.shiftKey || ev.ctrlKey ? 0.01 : 0.03;
        setValue(value + dir * fine, true);
    }, { passive: false });
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

    (wrap as ObxdWidget).setValue = (v: number) => setValue(v, false);
    return wrap;
}

// ===========================================================================
// Button — momentary trigger (programmer row etc.)
// ===========================================================================

export interface ButtonOptions {
    x: number; y: number; w: number; h: number;
    label?: string;
    onClick: () => void;
    asset?: string;
}

export function createButton(opts: ButtonOptions): ObxdWidget {
    const { x, y, w, h, label, onClick, asset = "button-clear" } = opts;

    const wrap = document.createElement("div");
    wrap.className = "obxd-button";
    wrap.setAttribute("role", "button");
    wrap.setAttribute("tabindex", "0");
    if (label !== undefined) {
        wrap.setAttribute("aria-label", label);
        wrap.title = label;
    }
    applyBounds(wrap, { x, y, w, h });
    wrap.style.cursor = "pointer";
    wrap.style.touchAction = "none";

    setFrameStrip(wrap, asset, w, h);

    let pressed = false;
    function paint(): void { showFrame(wrap, pressed ? 1 : 0); }
    paint();

    wrap.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        pressed = true;
        paint();
        (ev.target as Element).setPointerCapture?.(ev.pointerId);
    });
    wrap.addEventListener("pointerup", () => {
        if (!pressed) return;
        pressed = false;
        paint();
        onClick();
    });
    wrap.addEventListener("pointercancel", () => { pressed = false; paint(); });
    wrap.addEventListener("keydown", (ev) => {
        if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); onClick(); }
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

function applyBounds(el: HTMLElement, b: { x: number; y: number; w: number; h: number }): void {
    el.style.position = "absolute";
    el.style.left = `${b.x}px`;
    el.style.top = `${b.y}px`;
    el.style.width = `${b.w}px`;
    el.style.height = `${b.h}px`;
}

// --- Knob interaction (shared by createObxdKnob) ---
function setupKnobInteraction(
    wrap: HTMLElement,
    getValue: () => number,
    setValue: (v: number, fire: boolean) => void,
    defaultValue: number,
): void {
    let dragging = false;
    let lastY = 0;

    wrap.addEventListener("pointerdown", (ev: PointerEvent) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        dragging = true;
        lastY = ev.clientY;
        (ev.target as Element).setPointerCapture?.(ev.pointerId);
        wrap.classList.add("dragging");
    });
    wrap.addEventListener("pointermove", (ev: PointerEvent) => {
        if (!dragging) return;
        const dy = ev.clientY - lastY;
        lastY = ev.clientY;
        const scale = ev.shiftKey ? 0.0005 : 0.005;
        setValue(getValue() - dy * scale, true);
    });
    wrap.addEventListener("pointerup", (ev: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        wrap.classList.remove("dragging");
        (ev.target as Element).releasePointerCapture?.(ev.pointerId);
    });
    wrap.addEventListener("pointercancel", () => { dragging = false; wrap.classList.remove("dragging"); });

    wrap.addEventListener("wheel", (ev: WheelEvent) => {
        ev.preventDefault();
        const dir = ev.deltaY < 0 ? 1 : -1;
        const fine = ev.shiftKey || ev.ctrlKey ? 0.01 : 0.03;
        setValue(getValue() + dir * fine, true);
    }, { passive: false });

    wrap.addEventListener("dblclick", () => setValue(defaultValue, true));

    wrap.addEventListener("keydown", (ev: KeyboardEvent) => {
        let handled = true;
        const fine = ev.shiftKey ? 0.005 : 0.02;
        switch (ev.key) {
            case "ArrowUp":
            case "ArrowRight": setValue(getValue() + fine, true); break;
            case "ArrowDown":
            case "ArrowLeft":  setValue(getValue() - fine, true); break;
            case "PageUp":     setValue(getValue() + 0.1, true); break;
            case "PageDown":   setValue(getValue() - 0.1, true); break;
            case "Home":       setValue(0, true); break;
            case "End":        setValue(1, true); break;
            default: handled = false;
        }
        if (handled) ev.preventDefault();
    });
}

// --- SVG frame-strip helpers (for toggles, tri-state, buttons) ---

// Cache: asset basename → { naturalWidth, naturalHeight, frameCount }
const frameStripCache = new Map<string, { w: number; h: number; frames: number }>();

function setFrameStrip(el: HTMLElement, asset: string, displayW: number, displayH: number): void {
    el.style.backgroundImage = `url(${ASSET_BASE}/${asset}.svg)`;
    el.style.backgroundRepeat = "no-repeat";
    el.style.backgroundSize = `${displayW}px ${displayH * 4}px`; // assume 4 frames max; corrected on load
    el.dataset.asset = asset;
    el.dataset.displayH = String(displayH);

    if (!frameStripCache.has(asset)) {
        const probe = new Image();
        probe.onload = () => {
            const frames = Math.max(1, Math.round(probe.naturalHeight / displayH));
            frameStripCache.set(asset, { w: probe.naturalWidth, h: probe.naturalHeight, frames });
            el.style.backgroundSize = `${displayW}px ${displayH * frames}px`;
        };
        probe.src = `${ASSET_BASE}/${asset}.svg`;
    }
}

function showFrame(el: HTMLElement, frameIdx: number): void {
    const displayH = parseFloat(el.dataset.displayH ?? "35");
    el.style.backgroundPositionY = `${-frameIdx * displayH}px`;
}

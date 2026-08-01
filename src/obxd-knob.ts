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

import { paramFormat, paramParse } from "./obxf-param-format";
import { openObxfPopup, closeObxfPopup } from "./obxf-popup";
import type { PopupItem, PopupCustomRow } from "./obxf-popup";

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
    paramId?: string;       // SynthParam::ID for value formatting (bubble/typein)
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

    setupKnobInteraction(wrap, () => value, setValue, defaultValue, opts.paramId, opts.label);

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
        const frame = stepIdx * 2 + (pressed ? 1 : 0);
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
// Selector — OB-Xf menu SVG background + themed popup
// ===========================================================================

export interface SelectorOptions {
    x: number; y: number; w: number; h: number;
    choices: string[];
    label?: string;
    initialIndex?: number;
    onChange: (idx: number, value: string) => void;
    asset?: string;
}

export function createSelector(opts: SelectorOptions): ObxdWidget {
    const { x, y, w, h, choices, onChange, asset, label } = opts;
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
    wrap.style.cursor = "pointer";
    wrap.title = choices[idx];
    if (label) wrap.setAttribute("aria-label", label);
    wrap.setAttribute("role", "listbox");
    wrap.setAttribute("tabindex", "0");

    if (asset) {
        wrap.style.backgroundImage = `url(${ASSET_BASE}/${asset}.svg)`;
        wrap.style.backgroundRepeat = "no-repeat";
        wrap.style.backgroundSize = `100% ${h * choices.length}px`;
        updateSelectorFrame();
    }

    function updateSelectorFrame(): void {
        wrap.style.backgroundPositionY = `${-idx * h}px`;
    }

    function selectIndex(newIdx: number): void {
        idx = clampInt(newIdx, 0, choices.length - 1);
        wrap.title = choices[idx];
        updateSelectorFrame();
        onChange(idx, choices[idx]);
    }

    wrap.addEventListener("pointerdown", (ev: PointerEvent) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        const items: (PopupItem | "separator")[] = [];
        if (label) {
            items.push({ text: label, enabled: false });
            items.push("separator");
        }
        for (let i = 0; i < choices.length; i++) {
            items.push({
                text: choices[i],
                checked: i === idx,
                onClick: () => selectIndex(i),
            });
        }
        openObxfPopup({ anchor: wrap.getBoundingClientRect(), items });
    });

    wrap.addEventListener("wheel", (ev: WheelEvent) => {
        ev.preventDefault();
        const dir = ev.deltaY < 0 ? -1 : 1;
        selectIndex(idx + dir);
    }, { passive: false });

    wrap.addEventListener("keydown", (ev: KeyboardEvent) => {
        let handled = true;
        switch (ev.key) {
            case "ArrowUp":
            case "ArrowLeft": selectIndex(idx - 1); break;
            case "ArrowDown":
            case "ArrowRight": selectIndex(idx + 1); break;
            default: handled = false;
        }
        if (handled) ev.preventDefault();
    });

    (wrap as ObxdWidget).setValue = (v: number) => {
        const norm = clamp01(v);
        idx = choices.length === 1 ? 0 : Math.round(norm * (choices.length - 1));
        wrap.title = choices[idx];
        updateSelectorFrame();
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

const PITCH_SNAP_IDS = new Set(["Transpose", "Osc1Pitch", "Osc2Pitch", "EnvToPitchAmount"]);

// --- Knob interaction (shared by createObxdKnob) ---
function setupKnobInteraction(
    wrap: HTMLElement,
    getValue: () => number,
    setValue: (v: number, fire: boolean) => void,
    defaultValue: number,
    paramId?: string,
    label?: string,
): void {
    let dragging = false;
    let lastY = 0;
    let lastX = 0;
    let wheelTimer: ReturnType<typeof setTimeout> | null = null;

    const showBubble = (): void => {
        if (paramId) showValueBubble(wrap, paramId, getValue());
    };

    wrap.addEventListener("pointerdown", (ev: PointerEvent) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        dragging = true;
        lastY = ev.clientY;
        lastX = ev.clientX;
        (ev.target as Element).setPointerCapture?.(ev.pointerId);
        wrap.classList.add("dragging");
        showBubble();
    });
    wrap.addEventListener("pointermove", (ev: PointerEvent) => {
        if (!dragging) return;
        const dy = ev.clientY - lastY;
        const dx = ev.clientX - lastX;
        lastY = ev.clientY;
        lastX = ev.clientX;
        const scale = ev.shiftKey ? 0.0005 : 0.005;
        let newVal = getValue() - (dy + dx) * scale;
        if (ev.altKey && paramId && PITCH_SNAP_IDS.has(paramId)) {
            const st = Math.round(newVal * 48 - 24);
            newVal = (st + 24) / 48;
        }
        setValue(newVal, true);
        showBubble();
    });
    wrap.addEventListener("pointerup", (ev: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        wrap.classList.remove("dragging");
        (ev.target as Element).releasePointerCapture?.(ev.pointerId);
        hideValueBubble();
    });
    wrap.addEventListener("pointercancel", () => { dragging = false; wrap.classList.remove("dragging"); hideValueBubble(); });

    wrap.addEventListener("wheel", (ev: WheelEvent) => {
        ev.preventDefault();
        const dir = ev.deltaY < 0 ? 1 : -1;
        const fine = ev.shiftKey || ev.ctrlKey ? 0.01 : 0.03;
        setValue(getValue() + dir * fine, true);
        if (paramId) {
            showValueBubble(wrap, paramId, getValue());
            if (wheelTimer) clearTimeout(wheelTimer);
            wheelTimer = setTimeout(() => hideValueBubble(), 800);
        }
    }, { passive: false });

    wrap.addEventListener("dblclick", () => setValue(defaultValue, true));

    wrap.addEventListener("contextmenu", (ev: MouseEvent) => {
        if (!paramId) return;
        ev.preventDefault();
        showKnobContextMenu(wrap, getValue, setValue, defaultValue, paramId, label);
    });

    wrap.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.shiftKey && ev.key === "F10" && paramId) {
            ev.preventDefault();
            showKnobContextMenu(wrap, getValue, setValue, defaultValue, paramId, label);
            return;
        }
        let handled = true;
        const fine = ev.shiftKey ? 0.005 : 0.02;
        let changed = false;
        switch (ev.key) {
            case "ArrowUp":
            case "ArrowRight": setValue(getValue() + fine, true); changed = true; break;
            case "ArrowDown":
            case "ArrowLeft":  setValue(getValue() - fine, true); changed = true; break;
            case "PageUp":     setValue(getValue() + 0.1, true); changed = true; break;
            case "PageDown":   setValue(getValue() - 0.1, true); changed = true; break;
            case "Home":       setValue(1, true); changed = true; break;
            case "End":        setValue(0, true); changed = true; break;
            case "Delete":
            case "Backspace":  setValue(defaultValue, true); changed = true; break;
            default: handled = false;
        }
        if (handled) {
            ev.preventDefault();
            if (changed && paramId) {
                showValueBubble(wrap, paramId, getValue());
                if (wheelTimer) clearTimeout(wheelTimer);
                wheelTimer = setTimeout(() => hideValueBubble(), 800);
            }
        }
    });
}

// --- Knob context menu ---

function showKnobContextMenu(
    wrap: HTMLElement,
    getValue: () => number,
    setValue: (v: number, fire: boolean) => void,
    defaultValue: number,
    paramId: string,
    label?: string,
): void {
    const items: (PopupItem | PopupCustomRow | "separator")[] = [];

    items.push({ text: label ?? paramId, enabled: false });
    items.push("separator");

    const input = document.createElement("input");
    input.type = "text";
    input.value = paramFormat(paramId, getValue());
    input.style.cssText = "width: 80px; font-size: 14px; text-align: center; color: #ff0000; background: transparent; border: 1px solid rgba(255,255,255,0.3); outline: none; padding: 2px 4px;";
    input.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key === "Enter") {
            const parsed = paramParse(paramId, input.value);
            if (parsed !== null) setValue(parsed, true);
            closeObxfPopup();
        } else if (ev.key === "Escape") {
            closeObxfPopup();
        }
        ev.stopPropagation();
    });
    items.push({ type: "custom", label: "Set Value:", element: input });
    items.push("separator");

    items.push({
        text: "Reset to Default",
        onClick: () => setValue(defaultValue, true),
    });

    const isPan = paramId.startsWith("PanVoice");
    if (isPan) {
        items.push("separator");
        items.push({ text: "Reset All Pans", onClick: () => panOp("RESET_ALL") });
        items.push("separator");
        items.push({ text: "Stereo Spread Narrow", onClick: () => panOp("SPREAD_25") });
        items.push({ text: "Stereo Spread Medium", onClick: () => panOp("SPREAD_50") });
        items.push({ text: "Stereo Spread Wide", onClick: () => panOp("SPREAD_100") });
        items.push("separator");
        items.push({ text: "Alternate Pans Narrow", onClick: () => panOp("ALTERNATE_25") });
        items.push({ text: "Alternate Pans Medium", onClick: () => panOp("ALTERNATE_50") });
        items.push({ text: "Alternate Pans Wide", onClick: () => panOp("ALTERNATE_100") });
        items.push("separator");
        items.push({ text: "Randomize Pans", onClick: () => panOp("RANDOMIZE") });
    }

    openObxfPopup({ anchor: wrap.getBoundingClientRect(), items });

    setTimeout(() => { input.focus(); input.select(); }, 50);
}

type PanAlg = "RESET_ALL" | "RANDOMIZE" | "SPREAD_25" | "SPREAD_50" | "SPREAD_100"
    | "ALTERNATE_25" | "ALTERNATE_50" | "ALTERNATE_100";

let panOpHandler: ((alg: PanAlg) => void) | null = null;

export function setPanOpHandler(handler: ((alg: PanAlg) => void) | null): void {
    panOpHandler = handler;
}

function panOp(alg: PanAlg): void {
    panOpHandler?.(alg);
}

// --- Value hover bubble (singleton) ---

let bubbleEl: HTMLDivElement | null = null;

function ensureBubble(): HTMLDivElement {
    if (bubbleEl) return bubbleEl;
    bubbleEl = document.createElement("div");
    bubbleEl.style.cssText = [
        "position: fixed",
        "z-index: 100001",
        "background: rgba(48,48,48,0.8)",
        "border: 1px solid rgba(64,64,64,0.6)",
        "border-radius: 6px",
        "padding: 3px 8px",
        "color: #ffffff",
        "font: 12px system-ui, -apple-system, 'Segoe UI', sans-serif",
        "pointer-events: none",
        "white-space: nowrap",
        "transform: translateX(-50%)",
        "display: none",
    ].join("; ");
    document.body.appendChild(bubbleEl);
    return bubbleEl;
}

function showValueBubble(wrap: HTMLElement, paramId: string, value01: number): void {
    const bubble = ensureBubble();
    bubble.textContent = paramFormat(paramId, value01);
    bubble.style.display = "block";
    const r = wrap.getBoundingClientRect();
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    const gap = 6;
    let x = r.left + r.width / 2;
    let y = r.top - bh - gap;
    if (y < 0) y = r.bottom + gap;
    if (x - bw / 2 < 0) x = bw / 2;
    if (x + bw / 2 > window.innerWidth) x = window.innerWidth - bw / 2;
    bubble.style.left = x + "px";
    bubble.style.top = y + "px";
}

function hideValueBubble(): void {
    if (bubbleEl) bubbleEl.style.display = "none";
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

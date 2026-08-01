/**
 * obxf-popup.ts — OB-Xf themed popup menu singleton.
 *
 * A single reusable DOM element in document.body that renders OB-Xf-style
 * popup menus (parameter selectors, knob context menus, main menu).
 *
 * Visual tokens from OB-Xf LookAndFeel.h:
 *   background: #202020  (PopupMenu::backgroundColourId)
 *   highlight:  #404040  (highlighted colour)
 *   border:     rgba(255,255,255,0.6)
 *   text:       #ffffff
 *   font:       system-ui (browser equivalent of JUCE default)
 */

export interface PopupItem {
    text: string;
    checked?: boolean;
    enabled?: boolean;
    onClick?: () => void;
}

export interface PopupCustomRow {
    type: "custom";
    label: string;
    element: HTMLElement;
}

export interface PopupOptions {
    anchor: DOMRect;
    header?: string;
    items: (PopupItem | PopupCustomRow | "separator")[];
    onClose?: () => void;
}

let popupEl: HTMLDivElement | null = null;
let overlayEl: HTMLDivElement | null = null;

function ensureElements(): void {
    if (popupEl) return;
    popupEl = document.createElement("div");
    popupEl.style.cssText = [
        "position: fixed",
        "z-index: 100000",
        "background: #202020",
        "border: 1px solid rgba(255,255,255,0.6)",
        "color: #ffffff",
        "font-family: system-ui, -apple-system, 'Segoe UI', sans-serif",
        "font-size: 14px",
        "padding: 4px 0",
        "min-width: 120px",
        "box-shadow: 0 4px 16px rgba(0,0,0,0.6)",
        "display: none",
    ].join("; ");
    document.body.appendChild(popupEl);

    overlayEl = document.createElement("div");
    overlayEl.style.cssText = [
        "position: fixed",
        "top: 0", "left: 0", "width: 100%", "height: 100%",
        "z-index: 99999",
        "background: transparent",
    ].join("; ");
    document.body.appendChild(overlayEl);
}

export function openObxfPopup(opts: PopupOptions): void {
    closeObxfPopup();
    ensureElements();
    if (!popupEl || !overlayEl) return;

    popupEl.innerHTML = "";

    if (opts.header) {
        const h = document.createElement("div");
        h.textContent = opts.header;
        h.style.cssText = "font-weight: bold; padding: 4px 12px; color: #ffffff;";
        popupEl.appendChild(h);
        popupEl.appendChild(makeSeparator());
    }

    for (const item of opts.items) {
        if (item === "separator") {
            popupEl.appendChild(makeSeparator());
            continue;
        }
        if (item && typeof item === "object" && "type" in item && item.type === "custom") {
            const row = document.createElement("div");
            row.style.cssText = "display: flex; gap: 12px; align-items: center; padding: 4px 12px;";
            const label = document.createElement("span");
            label.textContent = item.label;
            row.appendChild(label);
            row.appendChild(item.element);
            popupEl.appendChild(row);
            continue;
        }
        const pi = item as PopupItem;
        const btn = document.createElement("div");
        btn.textContent = (pi.checked ? "\u2713 " : "  ") + pi.text;
        btn.style.cssText = [
            "padding: 4px 12px",
            "cursor: pointer",
            "white-space: nowrap",
            pi.enabled === false ? "opacity: 0.4; cursor: default" : "",
        ].filter(Boolean).join("; ");
        if (pi.enabled !== false) {
            btn.addEventListener("mouseenter", () => { btn.style.background = "#404040"; });
            btn.addEventListener("mouseleave", () => { btn.style.background = "transparent"; });
            btn.addEventListener("click", () => {
                closeObxfPopup();
                pi.onClick?.();
            });
        }
        popupEl.appendChild(btn);
    }

    popupEl.style.display = "block";
    const popupRect = popupEl.getBoundingClientRect();
    popupEl.style.display = "none";
    popupEl.style.display = "block";

    let x = opts.anchor.left;
    let y = opts.anchor.bottom;
    if (x + popupRect.width > window.innerWidth) {
        x = opts.anchor.right - popupRect.width;
    }
    if (y + popupRect.height > window.innerHeight) {
        y = opts.anchor.top - popupRect.height;
    }
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    popupEl.style.left = x + "px";
    popupEl.style.top = y + "px";

    overlayEl.style.display = "block";
    overlayEl.addEventListener("pointerdown", onOverlayClick);
    document.addEventListener("keydown", onEscape);
}

function onOverlayClick(): void {
    closeObxfPopup();
}

function onEscape(ev: KeyboardEvent): void {
    if (ev.key === "Escape") closeObxfPopup();
}

export function closeObxfPopup(): void {
    if (popupEl) {
        popupEl.style.display = "none";
        popupEl.innerHTML = "";
    }
    if (overlayEl) {
        overlayEl.style.display = "none";
        overlayEl.removeEventListener("pointerdown", onOverlayClick);
    }
    document.removeEventListener("keydown", onEscape);
}

export function isObxfPopupOpen(): boolean {
    return popupEl?.style.display === "block";
}

function makeSeparator(): HTMLElement {
    const sep = document.createElement("hr");
    sep.style.cssText = "border: 0; border-top: 1px solid rgba(255,255,255,0.15); margin: 4px 0;";
    return sep;
}

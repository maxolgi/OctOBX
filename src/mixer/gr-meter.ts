/*
 * mixer/gr-meter.ts — gain-reduction bar, vanilla-TS port of CakeMix's
 * components/GrMeter.tsx. DOM-based (no rAF); the console's shared loop
 * calls set() at display rate.
 */

export interface GrMeterOptions {
    reduction: number;       // dB (0 = none, -20 = heavy)
    maxReduction?: number;   // scale: -maxReduction dB = full bar (default -20)
    label?: string;
    width?: number;
    height?: number;
}

export interface GrMeterHandle {
    element: HTMLElement;
    set(reduction: number): void;
}

export function createGrMeter(opts: GrMeterOptions): GrMeterHandle {
    const maxRed = Math.abs(opts.maxReduction ?? -20);
    const label = opts.label ?? "GR";
    const width = opts.width ?? 80;
    const height = opts.height ?? 8;

    const container = document.createElement("div");
    container.className = "gr-meter-container";

    const labelEl = document.createElement("span");
    labelEl.className = "gr-meter-label";
    labelEl.textContent = label;
    container.appendChild(labelEl);

    const bg = document.createElement("div");
    bg.className = "gr-meter-bar-bg";
    bg.style.width = `${width}px`;
    bg.style.height = `${height}px`;
    const fill = document.createElement("div");
    fill.className = "gr-meter-bar-fill";
    bg.appendChild(fill);
    container.appendChild(bg);

    const valueEl = document.createElement("span");
    valueEl.className = "gr-meter-value";
    container.appendChild(valueEl);

    function set(reduction: number): void {
        const r = Math.max(0, Math.abs(reduction));
        const pct = maxRed <= 0 ? 0 : Math.min(100, (r / maxRed) * 100);
        fill.style.width = `${pct}%`;
        fill.style.backgroundColor =
            reduction > -3 ? "#22c55e" :
            reduction > -10 ? "#eab308" : "#ef4444";
        valueEl.textContent = reduction.toFixed(1);
        container.title = `${label}: ${reduction.toFixed(1)} dB`;
    }

    set(opts.reduction);

    return { element: container, set };
}

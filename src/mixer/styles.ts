/*
 * mixer/styles.ts — CSS for the CakeMix console port, scoped under
 * #mixer-panel so it cannot collide with the app-level styles in
 * index.html (CakeMix keeps these in frontend/src/global.css — OctOBX
 * injects per-module instead of growing the global sheet).
 *
 * Visual tokens (colors, radii, gradients, fader/knob/eq styling) are
 * ported from CakeMix's global.css detail-panel/master sections.
 */

const CSS = `
#mixer-panel .cmx-console-root {
    display: flex;
    flex-direction: column;
    background: #08080c;
    height: 100%;
    min-height: 0;
}
#mixer-panel .cmx-status {
    font: 10px/1.6 'SF Mono', ui-monospace, monospace;
    letter-spacing: 1px;
    color: #4ade80;
    background: #0e0e14;
    border-bottom: 1px solid #1e1e28;
    padding: 4px 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
#mixer-panel .cmx-status.offline { color: #e05050; }

#mixer-panel .mixer-console {
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 4px 2px;
    overflow-x: auto;
    overflow-y: hidden;
    flex: 1;
    min-height: 0;
}

/* ── Detail panel (channel strip + master) ─────────────────────────── */
#mixer-panel .detail-panel {
    background: #0e0e14;
    border-left: 1px solid #1e1e28;
    padding: 8px 10px 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    flex-shrink: 0;
    overflow-y: auto;
    overflow-x: hidden;
    transition: width 0.15s ease;
    width: 100px;
    min-width: 100px;
}
#mixer-panel .detail-panel .knob-label { font-size: 10px; }
#mixer-panel .detail-panel .knob-value { font-size: 10px; min-height: 12px; }
#mixer-panel .detail-header {
    display: flex; align-items: center; gap: 8px;
    padding-bottom: 6px; margin-bottom: 2px;
    border-bottom: 1px solid #1e1e28;
}
#mixer-panel .detail-name-input {
    flex: 1; min-width: 0;
    background: #11111a; border: 1px solid #222230; border-radius: 3px;
    color: #ccc; font-size: 0.95em; padding: 4px 6px; outline: none;
    font-family: 'SF Mono', monospace;
}
#mixer-panel .detail-name-input:focus { border-color: #2a4a6a; }
#mixer-panel .detail-section { padding: 4px 0; border-top: 1px solid #1a1a25; }
#mixer-panel .detail-section:first-of-type { border-top: none; padding-top: 4px; }
#mixer-panel .detail-section-divider {
    display: flex; align-items: center; gap: 4px; padding: 2px 0;
}
#mixer-panel .detail-section-divider::after {
    content: ''; flex: 1; height: 1px; background: #1a1a25;
}
#mixer-panel .detail-section-header {
    display: flex; justify-content: space-between; align-items: center; padding: 2px 0;
}
#mixer-panel .detail-section-label {
    font-size: 11px; color: #888; font-weight: 700; letter-spacing: 1px;
}
#mixer-panel .detail-toggle {
    font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 2px;
    border: 1px solid #333; background: #1a1a22; color: #555; cursor: pointer;
}
#mixer-panel .detail-toggle.active {
    background: #1a3a1a; color: #4ade80; border-color: #2a5a2a;
}
#mixer-panel .detail-toggle.bypassed {
    background: #2a1414; color: #f87171; border-color: #5a2a2a;
}
#mixer-panel .detail-input-row {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 4px 0;
}
#mixer-panel .phase-btn {
    width: 32px; height: 32px; border-radius: 4px; border: 1px solid #2a2a30;
    background: #16161e; color: #666; font-size: 1.1em; cursor: pointer;
    transition: all 0.1s;
}
#mixer-panel .phase-btn:hover { border-color: #444; color: #aaa; }
#mixer-panel .phase-btn.active {
    background: #2a2a4a; color: #8ab4f8; border-color: #3a4a7a;
    box-shadow: 0 0 6px rgba(74,143,221,0.25);
}
#mixer-panel .detail-select {
    background: #11111a; border: 1px solid #222230; border-radius: 3px;
    color: #ccc; font-size: 0.85em; padding: 2px 4px; outline: none;
}
#mixer-panel .detail-select-label {
    display: flex; align-items: center; gap: 4px; font-size: 11px; color: #888;
}

/* ── Knob ──────────────────────────────────────────────────────────── */
#mixer-panel .knob-container {
    display: flex; flex-direction: column; align-items: center; gap: 1px;
    user-select: none; cursor: ns-resize; touch-action: none;
}
#mixer-panel .knob-canvas { display: block; }
#mixer-panel .knob-label {
    font-size: 11px; color: #888; font-weight: 600; letter-spacing: 0.5px;
}
#mixer-panel .knob-value {
    font-size: 11px; color: #aaa; font-family: 'SF Mono', monospace;
    min-height: 14px; width: 48px; text-align: center;
}
#mixer-panel .knob-row { display: flex; gap: 8px; justify-content: center; padding: 4px 0; }

/* ── Gain reduction meter ─────────────────────────────────────────── */
#mixer-panel .gr-meter-container { display: flex; align-items: center; gap: 4px; }
#mixer-panel .gr-meter-label {
    font-size: 11px; color: #555; font-weight: 700; min-width: 18px;
}
#mixer-panel .gr-meter-bar-bg {
    position: relative; background: rgba(0,0,0,0.6); border-radius: 2px;
    border: 1px solid #111; overflow: hidden;
}
#mixer-panel .gr-meter-bar-fill {
    height: 100%; border-radius: 2px;
    transition: width 0.05s linear, background-color 0.1s;
}
#mixer-panel .gr-meter-value {
    font-size: 11px; color: #666; font-family: 'SF Mono', monospace;
    min-width: 32px; text-align: right;
}

/* ── EQ ────────────────────────────────────────────────────────────── */
#mixer-panel .eq-bands { display: flex; flex-direction: column; gap: 4px; padding: 4px 0; }
#mixer-panel .eq-band-row { display: flex; align-items: center; gap: 8px; }
#mixer-panel .eq-band-name { font-size: 11px; color: #888; min-width: 36px; }
#mixer-panel .eq-band-knobs { display: flex; gap: 4px; align-items: center; }
#mixer-panel .detail-eq-curve {
    width: 100%; padding: 2px; background: rgba(0,0,0,0.3);
    border-radius: 3px; margin: 2px 0;
}
#mixer-panel .eq-curve { display: block; width: 100%; height: 50px; }

/* ── Buttons ───────────────────────────────────────────────────────── */
#mixer-panel .btn-sm {
    width: 30px; height: 18px; font-size: 0.55em; font-weight: 700;
    border: 1px solid #2a2a30; border-radius: 2px; background: #16161e;
    color: #555; cursor: pointer; transition: all 0.1s;
}
#mixer-panel .btn-sm:hover { border-color: #444; color: #999; }
#mixer-panel .btn-solo.active {
    background: #a07810; color: #000; border-color: #c9a830;
    box-shadow: 0 0 5px rgba(201,168,48,0.3);
}
#mixer-panel .btn-mute.active {
    background: #a02020; color: #fff; border-color: #c83030;
    box-shadow: 0 0 5px rgba(200,48,48,0.3);
}
#mixer-panel .btn-main.active {
    background: #1a3a5a; color: #8ab4f8; border-color: #2a5a8a;
    box-shadow: 0 0 5px rgba(138,180,248,0.3);
}

/* ── Pan ───────────────────────────────────────────────────────────── */
#mixer-panel .detail-pan-row {
    display: flex; align-items: center; gap: 8px; min-width: 0; padding: 4px 0;
}
#mixer-panel .pan-slider {
    -webkit-appearance: none; appearance: none; flex: 1; min-width: 0;
    height: 3px; background: #222230; border-radius: 2px; outline: none; cursor: pointer;
}
#mixer-panel .pan-slider::-webkit-slider-thumb {
    -webkit-appearance: none; width: 8px; height: 18px;
    background: linear-gradient(90deg, #444, #2a2a2a);
    border: 1px solid #1a1a1a; border-radius: 2px; cursor: ew-resize;
    box-shadow: 0 1px 3px rgba(0,0,0,0.6);
}
#mixer-panel .pan-slider::-moz-range-thumb {
    width: 8px; height: 18px;
    background: linear-gradient(90deg, #444, #2a2a2a);
    border: 1px solid #1a1a1a; border-radius: 2px; cursor: ew-resize;
}
#mixer-panel .pan-val {
    font-size: 0.45em; color: #777; font-family: monospace;
    min-width: 24px; text-align: center;
}

/* ── Fader ─────────────────────────────────────────────────────────── */
#mixer-panel .fader {
    -webkit-appearance: none; appearance: none;
    width: 36px; height: 160px; padding: 0; margin: 0; border: none;
    background: transparent; writing-mode: vertical-lr; direction: rtl;
    cursor: ns-resize;
}
#mixer-panel .fader::-webkit-slider-runnable-track {
    width: 36px; height: 160px; background: #222230; border-radius: 2px;
}
#mixer-panel .fader::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 36px; height: 6px;
    background: linear-gradient(180deg, #444, #2a2a2a);
    border: 1px solid #1a1a1a; border-radius: 2px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.6);
}
#mixer-panel .fader::-webkit-slider-thumb:hover {
    background: linear-gradient(180deg, #555, #3a3a3a);
}
#mixer-panel .fader::-moz-range-track {
    width: 36px; height: 160px; background: #222230; border: none; border-radius: 2px;
}
#mixer-panel .fader::-moz-range-thumb {
    width: 36px; height: 6px;
    background: linear-gradient(180deg, #444, #2a2a2a);
    border: 1px solid #1a1a1a; border-radius: 2px;
}
#mixer-panel .fader-val {
    font-size: 0.45em; color: #888; font-family: monospace;
}
#mixer-panel .fader-col {
    display: flex; flex-direction: column; align-items: center; gap: 4px;
}
#mixer-panel .fader-col .fader-val {
    font-size: 0.95em; color: #aaa; width: 50px; text-align: center;
}

/* ── Output (meters + fader) ──────────────────────────────────────── */
#mixer-panel .detail-output { margin-top: auto; padding-top: 8px; }
#mixer-panel .detail-meter-fader {
    display: flex; align-items: flex-end; justify-content: center; position: relative;
    gap: 2px;
}
#mixer-panel .detail-controls {
    display: flex; gap: 6px; justify-content: center; padding-top: 4px;
}
#mixer-panel .detail-controls .btn-sm { width: 36px; height: 26px; font-size: 0.8em; }

/* ── Collapsible section headers ──────────────────────────────────── */
#mixer-panel .detail-section-divider.collapsible,
#mixer-panel .detail-section-header.collapsible {
    cursor: pointer; user-select: none;
}
#mixer-panel .detail-section-divider.collapsible:hover,
#mixer-panel .detail-section-header.collapsible:hover {
    background: rgba(255,255,255,0.03);
}

/* ── Master ───────────────────────────────────────────────────────── */
#mixer-panel .master-detail {
    position: sticky; top: 0; right: 0; z-index: 10;
    overflow-y: hidden !important; background: #161620;
}
#mixer-panel .master-clip-indicator {
    display: flex; justify-content: center; gap: 6px; padding: 4px 0;
    font-size: 13px; font-family: 'SF Mono', monospace; color: #888;
}
#mixer-panel .master-clip-indicator .clip {
    font-size: 11px; font-weight: 700; padding: 1px 4px;
    border: 1px solid #333; border-radius: 2px; color: #444;
    transition: all 0.1s; cursor: pointer; user-select: none;
}
#mixer-panel .master-clip-indicator .clip.active {
    color: #f00; border-color: #f00; background: rgba(255,0,0,0.1);
}
/* ── Guitarix FX rack ─────────────────────────────────────────────── */
#mixer-panel .detail-fx-leds {
    display: flex; align-items: center; gap: 2px; padding: 3px 0 1px;
}
#mixer-panel .fx-led {
    width: 5px; height: 5px; border-radius: 50%;
    background: #1e1e28;
}
#mixer-panel .fx-led.on {
    background: #4a8fdd;
    box-shadow: 0 0 4px rgba(74,143,221,0.5);
}
#mixer-panel .fx-chain-list {
    display: flex; flex-direction: column; gap: 2px; padding: 4px 0;
}
#mixer-panel .fx-row {
    display: flex; align-items: center; gap: 4px;
    padding: 1px 2px; border: 1px solid transparent; border-radius: 3px;
    cursor: pointer;
}
#mixer-panel .fx-row:hover { background: rgba(255,255,255,0.03); }
#mixer-panel .fx-row.selected {
    background: #142031; border-color: #2a4a6a;
}
#mixer-panel .fx-row.selected .fx-row-label { color: #8ab4f8; }
#mixer-panel .fx-row-btn {
    width: 16px; height: 16px; font-size: 9px; line-height: 1;
    border: 1px solid #2a2a30; border-radius: 2px; background: #16161e;
    color: #666; cursor: pointer; padding: 0; transition: all 0.1s;
}
#mixer-panel .fx-row-btn:hover { border-color: #444; color: #aaa; }
#mixer-panel .fx-row-btn:disabled { opacity: 0.3; cursor: default; }
#mixer-panel .fx-row .detail-toggle { padding: 1px 4px; }
#mixer-panel .fx-row-label {
    flex: 1; min-width: 0; font-size: 11px; color: #aaa;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#mixer-panel .fx-edit-area {
    border-top: 1px solid #1a1a25; margin-top: 2px; padding-top: 4px;
}
#mixer-panel .fx-edit-area .knob-row { flex-wrap: wrap; }
#mixer-panel .fx-edit-title {
    font-size: 11px; color: #888; font-weight: 700; letter-spacing: 1px;
    padding: 2px 0;
}
`;

let injected = false;

export function injectMixerStyles(): void {
    if (injected) return;
    injected = true;
    const style = document.createElement("style");
    style.id = "cmx-mixer-style";
    style.textContent = CSS;
    document.head.appendChild(style);
}

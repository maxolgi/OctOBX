/*
 * mixer/master-strip.ts — master section, vanilla-TS port of CakeMix's
 * components/MasterStrip.tsx: limiter (IN/BYP + CEIL/REL knobs + GR bar),
 * clip indicator (click to clear), L/R meters flanking the master fader,
 * master mute. The engine-side master (gain + oversampled limiter) IS the
 * app's output path when the mixer engine is live.
 */

import {
    master, masterMeters,
    setMasterGain, setLimiterEnabled, setLimiterCeiling, setLimiterRelease,
    clearMasterClip,
    faderToGain, gainToFader, formatGainDb,
} from "./store";
import { createKnob } from "./knob";
import { createGrMeter } from "./gr-meter";
import { createMeterCanvas, type MeterHandle } from "./meter-canvas";

const fmtDb = (v: number) => v.toFixed(1);
const fmtDbInf = (db: number) => (db <= -60 ? "−∞" : db.toFixed(1));
const fmtMs = (v: number) => (v < 10 ? v.toFixed(1) : v.toFixed(0));

export interface MasterStripHandle {
    element: HTMLElement;
    tickMeters(): void;
}

export function buildMasterStrip(): MasterStripHandle {
    const root = document.createElement("div");
    root.className = "detail-panel master-detail";
    root.style.width = "100px";
    root.style.marginLeft = "auto";

    // Header
    const header = document.createElement("div");
    header.className = "detail-header";
    const nameInput = document.createElement("input");
    nameInput.className = "detail-name-input";
    nameInput.type = "text";
    nameInput.value = "MASTER";
    nameInput.readOnly = true;
    nameInput.title = "Master bus";
    header.appendChild(nameInput);
    root.appendChild(header);

    // LIMITER section (collapsed by default, like CakeMix)
    const limSection = document.createElement("div");
    limSection.className = "detail-section";

    const limHeader = document.createElement("div");
    limHeader.className = "detail-section-header collapsible";
    const limLabel = document.createElement("span");
    limLabel.className = "detail-section-label";
    limLabel.textContent = "LIMITER";
    limHeader.appendChild(limLabel);

    const limBody = document.createElement("div");
    limBody.style.display = "none";
    let limOpen = false;

    const limToggle = document.createElement("button");
    limToggle.className = "detail-toggle " + (master.limiterEnabled ? "active" : "bypassed");
    limToggle.textContent = master.limiterEnabled ? "IN" : "BYP";
    limToggle.title = "Limiter in / bypass";
    limToggle.addEventListener("click", (ev) => {
        ev.stopPropagation();
        setLimiterEnabled(!master.limiterEnabled);
        limToggle.className = "detail-toggle " + (master.limiterEnabled ? "active" : "bypassed");
        limToggle.textContent = master.limiterEnabled ? "IN" : "BYP";
    });

    limHeader.addEventListener("click", () => {
        limOpen = !limOpen;
        limBody.style.display = limOpen ? "" : "none";
        if (limOpen) {
            if (!limHeader.contains(limToggle)) limHeader.appendChild(limToggle);
            root.style.width = "150px";
        } else {
            if (limHeader.contains(limToggle)) limHeader.removeChild(limToggle);
            root.style.width = "100px";
        }
    });
    limSection.appendChild(limHeader);

    const knobRow = document.createElement("div");
    knobRow.className = "knob-row";
    knobRow.appendChild(createKnob({
        label: "CEIL", value: master.limiterCeiling, min: -12, max: 0,
        defaultValue: -0.3, unit: "dB", format: fmtDb, size: 36,
        onChange: (v) => setLimiterCeiling(v),
    }).element);
    knobRow.appendChild(createKnob({
        label: "REL", value: master.limiterRelease, min: 5, max: 500,
        defaultValue: 50, unit: "ms", format: fmtMs, size: 36, log: true,
        onChange: (v) => setLimiterRelease(v),
    }).element);
    limBody.appendChild(knobRow);

    const limGr = createGrMeter({ reduction: 0, maxReduction: -20, label: "GR", width: 240, height: 14 });
    limBody.appendChild(limGr.element);
    limSection.appendChild(limBody);
    root.appendChild(limSection);

    // Clip indicator (peakL CLIP peakR, click to clear)
    const clipRow = document.createElement("div");
    clipRow.className = "master-clip-indicator";
    const peakLVal = document.createElement("span");
    peakLVal.textContent = "−∞";
    const clipBtn = document.createElement("span");
    clipBtn.className = "clip clickable";
    clipBtn.textContent = "CLIP";
    clipBtn.title = "Click to clear clip indicator";
    clipBtn.addEventListener("click", () => clearMasterClip());
    const peakRVal = document.createElement("span");
    peakRVal.textContent = "−∞";
    clipRow.appendChild(peakLVal);
    clipRow.appendChild(clipBtn);
    clipRow.appendChild(peakRVal);
    root.appendChild(clipRow);

    // Output: L meter / fader / R meter
    const outputSection = document.createElement("div");
    outputSection.className = "detail-section detail-output";

    const meterFader = document.createElement("div");
    meterFader.className = "detail-meter-fader stereo";
    // hold=false: the master meter's ENGINE values already carry the
    // 1 s hold + decay — a canvas hold on top would double it.
    const meterL: MeterHandle = createMeterCanvas(10, 160, false);
    const meterR: MeterHandle = createMeterCanvas(10, 160, false);
    meterL.element.classList.add("meter-l");
    meterR.element.classList.add("meter-r");
    meterFader.appendChild(meterL.element);

    const faderCol = document.createElement("div");
    faderCol.className = "fader-col";
    const faderVal = document.createElement("span");
    faderVal.className = "fader-val";
    faderVal.textContent = formatGainDb(master.gain);
    const faderWrap = document.createElement("div");
    faderWrap.className = "fader-wrap";
    const fader = document.createElement("input");
    fader.type = "range";
    fader.className = "fader";
    fader.min = "0";
    fader.max = "1";
    fader.step = "0.001";
    fader.value = String(gainToFader(master.gain));
    fader.title = "Master fader";
    fader.addEventListener("input", () => {
        setMasterGain(faderToGain(parseFloat(fader.value)));
        faderVal.textContent = formatGainDb(master.gain);
        muteBtn.classList.toggle("active", master.gain === 0);
    });
    fader.addEventListener("wheel", (ev: WheelEvent) => {
        ev.preventDefault();
        const step = ev.shiftKey ? 0.002 : 0.01;
        const delta = ev.deltaY > 0 ? -step : step;
        const pos = Math.max(0, Math.min(1, gainToFader(master.gain) + delta));
        fader.value = String(pos);
        setMasterGain(faderToGain(pos));
        faderVal.textContent = formatGainDb(master.gain);
        muteBtn.classList.toggle("active", master.gain === 0);
    }, { passive: false });
    faderWrap.appendChild(fader);
    faderCol.appendChild(faderVal);
    faderCol.appendChild(faderWrap);
    meterFader.appendChild(faderCol);
    meterFader.appendChild(meterR.element);
    outputSection.appendChild(meterFader);

    const controls = document.createElement("div");
    controls.className = "detail-controls";
    const muteBtn = document.createElement("button");
    muteBtn.className = "btn-sm btn-mute" + (master.gain === 0 ? " active" : "");
    muteBtn.textContent = "M";
    muteBtn.title = "Master mute";
    muteBtn.addEventListener("click", () => {
        setMasterGain(master.gain === 0 ? 1.0 : 0);
        fader.value = String(gainToFader(master.gain));
        faderVal.textContent = formatGainDb(master.gain);
        muteBtn.classList.toggle("active", master.gain === 0);
    });
    controls.appendChild(muteBtn);
    outputSection.appendChild(controls);

    root.appendChild(outputSection);

    return {
        element: root,
        tickMeters(): void {
            meterL.setTargets(masterMeters.peakL, masterMeters.rmsL);
            meterR.setTargets(masterMeters.peakR, masterMeters.rmsR);
            meterL.tick();
            meterR.tick();
            limGr.set(masterMeters.limiterGr);
            peakLVal.textContent = fmtDbInf(masterMeters.peakL);
            peakRVal.textContent = fmtDbInf(masterMeters.peakR);
            clipBtn.classList.toggle("active", masterMeters.clip);
        },
    };
}

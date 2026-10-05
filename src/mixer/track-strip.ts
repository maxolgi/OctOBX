/*
 * mixer/track-strip.ts — one stereo channel strip, vanilla-TS port of
 * CakeMix's components/ChannelDetailPanel.tsx adapted for STEREO tracks:
 * every control write fans out to engine channels 2t/2t+1 via the store
 * setters, and the output section meters L and R independently.
 *
 * Section layout + collapse defaults mirror CakeMix: INPUT/DYN (trim,
 * phase, main-assign, pan law, gate, comp + GR, expander) and EQ are
 * collapsed by default; the strip widens when a section opens (100 →
 * 360 / 230 px) inside the horizontally scrolling console row.
 */

import {
    type TrackState,
    tracks, EQ_BAND_LAYOUT, PAN_LAWS,
    faderToGain, gainToFader, formatGainDb,
    setTrackName, setTrackFaderGain, setTrackPan, setTrackMute, setTrackSolo,
    setTrackInputGain, setTrackPhase, setTrackPanLaw, setTrackMainAssign,
    setEqGain, setEqFreq, setEqQ, setEqBypass,
    setCompEnabled, setCompParam, pushCompParams,
    setGateEnabled, setGateParam, pushGateParams,
    setExpEnabled, setExpParam, pushExpParams,
    trackMeters,
} from "./store";
import { createKnob } from "./knob";
import { createGrMeter } from "./gr-meter";
import { createMeterCanvas, type MeterHandle } from "./meter-canvas";
import { createEqCurve } from "./eq-curve";
import { FX_EFFECTS, FX_SLOTS, FX_INSTANCE_COUNT, fxParamTo01 } from "../gxfx-params";
import { getFxInstance, setFxParamUI, setFxEnabledUI, moveFxSlot, onFxStateChange, type FxInstanceState } from "./fx-rack";

const fmtDb = (v: number) => v.toFixed(1);
const fmtRatio = (v: number) => (v >= 20 ? "20:1" : v.toFixed(1) + ":1");
const fmtHz = (v: number) => (v >= 1000 ? (v / 1000).toFixed(1) + "k" : v.toFixed(0));
const fmtMs = (v: number) => (v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : v.toFixed(0));
const fmtFx = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

function fmtPan(p: number): string {
    if (Math.abs(p) < 0.02) return "C";
    return p < 0 ? `L${Math.round(-p * 100)}` : `R${Math.round(p * 100)}`;
}

export interface TrackStripHandle {
    element: HTMLElement;
    /** Push fresh meter data (called by console.ts's shared rAF loop). */
    tickMeters(): void;
    /** Tear down the FX state subscription (tracks 0–9 only). */
    disposeFx?(): void;
}

export function buildTrackStrip(t: number, sampleRate: number): TrackStripHandle {
    const track: TrackState = tracks[t];

    const root = document.createElement("div");
    root.className = "detail-panel";

    let inputOpen = false;
    let eqOpen = false;
    let fxOpen = false;

    function applyWidth(): void {
        let w = 100;
        if (inputOpen) w = Math.max(w, 360);
        if (eqOpen) w = Math.max(w, 230);
        if (fxOpen) w = Math.max(w, 300);
        root.style.width = `${w}px`;
    }

    // ── Header ────────────────────────────────────────────────────────────
    const header = document.createElement("div");
    header.className = "detail-header";
    const nameInput = document.createElement("input");
    nameInput.className = "detail-name-input";
    nameInput.type = "text";
    nameInput.value = track.name;
    nameInput.title = "Track name";
    nameInput.addEventListener("input", () => setTrackName(t, nameInput.value));
    header.appendChild(nameInput);
    root.appendChild(header);

    // ── INPUT / DYN (collapsible: trim row + gate + comp + expander) ─────
    const inputSection = document.createElement("div");
    inputSection.className = "detail-section";

    const inputDivider = document.createElement("div");
    inputDivider.className = "detail-section-divider collapsible";
    const inputLabel = document.createElement("span");
    inputLabel.className = "detail-section-label";
    inputLabel.textContent = "INPUT / DYN";
    inputDivider.appendChild(inputLabel);
    inputSection.appendChild(inputDivider);

    const inputBody = document.createElement("div");
    inputBody.style.display = inputOpen ? "" : "none";
    inputDivider.addEventListener("click", () => {
        inputOpen = !inputOpen;
        inputBody.style.display = inputOpen ? "" : "none";
        applyWidth();
    });
    inputSection.appendChild(inputBody);

    // Trim row: TRIM / Ø / MAIN / LAW
    const inputRow = document.createElement("div");
    inputRow.className = "detail-input-row";

    inputRow.appendChild(createKnob({
        label: "TRIM", value: track.inputGainDb, min: -24, max: 24,
        defaultValue: 0, unit: "dB", format: fmtDb, size: 36,
        onChange: (v) => setTrackInputGain(t, v),
    }).element);

    const phaseBtn = document.createElement("button");
    phaseBtn.className = "phase-btn" + (track.phaseInverted ? " active" : "");
    phaseBtn.textContent = "Ø";
    phaseBtn.title = "Phase / polarity invert";
    phaseBtn.addEventListener("click", () => {
        setTrackPhase(t, !track.phaseInverted);
        phaseBtn.classList.toggle("active", track.phaseInverted);
    });
    inputRow.appendChild(phaseBtn);

    const mainBtn = document.createElement("button");
    mainBtn.className = "btn-sm btn-main" + (track.mainAssigned ? " active" : "");
    mainBtn.textContent = "MAIN";
    mainBtn.title = "Main bus assign — off = this strip reaches master only through its bus slots";
    mainBtn.addEventListener("click", () => {
        setTrackMainAssign(t, !track.mainAssigned);
        mainBtn.classList.toggle("active", track.mainAssigned);
    });
    inputRow.appendChild(mainBtn);

    const lawLabel = document.createElement("label");
    lawLabel.className = "detail-select-label";
    lawLabel.textContent = "LAW";
    const lawSelect = document.createElement("select");
    lawSelect.className = "detail-select";
    lawSelect.title = "Pan law";
    PAN_LAWS.forEach((name, i) => {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = name;
        lawSelect.appendChild(opt);
    });
    lawSelect.value = String(track.panLaw);
    lawSelect.addEventListener("input", () => setTrackPanLaw(t, parseInt(lawSelect.value, 10)));
    lawLabel.appendChild(lawSelect);
    inputRow.appendChild(lawLabel);
    inputBody.appendChild(inputRow);

    function dynSection(
        name: string,
        isEnabled: () => boolean,
        onToggle: (enabled: boolean) => void,
        buildKnobs: (row: HTMLElement) => void,
        grMeter?: HTMLElement,
        onEnabled?: () => void,
    ): HTMLElement {
        const section = document.createElement("div");
        section.className = "detail-section";
        const head = document.createElement("div");
        head.className = "detail-section-header";
        const lbl = document.createElement("span");
        lbl.className = "detail-section-label";
        lbl.textContent = name;
        const toggle = document.createElement("button");
        toggle.className = "detail-toggle " + (isEnabled() ? "active" : "bypassed");
        toggle.textContent = isEnabled() ? "IN" : "BYP";
        toggle.title = `${name} in / bypass`;
        toggle.addEventListener("click", () => {
            const next = !isEnabled();
            onToggle(next);
            // The store setters are synchronous — read back the new state.
            const enabled = isEnabled();
            toggle.classList.toggle("active", enabled);
            toggle.classList.toggle("bypassed", !enabled);
            toggle.textContent = enabled ? "IN" : "BYP";
            // The engine recreates a dynamics effect with ITS OWN defaults
            // on every enable (disable destroys the object) — re-push the
            // section's displayed values so the knobs are the truth.
            if (enabled && onEnabled) onEnabled();
        });
        head.appendChild(lbl);
        head.appendChild(toggle);
        section.appendChild(head);
        const row = document.createElement("div");
        row.className = "knob-row";
        buildKnobs(row);
        section.appendChild(row);
        if (grMeter) section.appendChild(grMeter);
        return section;
    }

    // GATE
    inputBody.appendChild(dynSection("GATE",
        () => track.gateEnabled,
        (enabled) => setGateEnabled(t, enabled),
        (row) => {
            row.appendChild(createKnob({ label: "THR", value: track.gateThresholdDb, min: -80, max: 0, defaultValue: -50, unit: "dB", format: fmtDb, size: 36, log: true, onChange: (v) => setGateParam(t, 0, v) }).element);
            row.appendChild(createKnob({ label: "HYS", value: track.gateHysteresisDb, min: 0, max: 24, defaultValue: 6, unit: "dB", format: fmtDb, size: 36, onChange: (v) => setGateParam(t, 1, v) }).element);
            row.appendChild(createKnob({ label: "ATTK", value: track.gateAttackMs, min: 0.1, max: 100, defaultValue: 2, unit: "ms", format: fmtMs, size: 36, log: true, onChange: (v) => setGateParam(t, 2, v) }).element);
            row.appendChild(createKnob({ label: "REL", value: track.gateReleaseMs, min: 5, max: 1000, defaultValue: 100, unit: "ms", format: fmtMs, size: 36, log: true, onChange: (v) => setGateParam(t, 3, v) }).element);
            row.appendChild(createKnob({ label: "HOLD", value: track.gateHoldMs, min: 0, max: 500, defaultValue: 10, unit: "ms", format: fmtMs, size: 36, onChange: (v) => setGateParam(t, 4, v) }).element);
        },
        undefined,
        () => pushGateParams(t)));

    // COMP (+ GR meter)
    const compGr = createGrMeter({ reduction: 0, maxReduction: -20, label: "GR", width: 240, height: 14 });
    inputBody.appendChild(dynSection("COMP",
        () => track.compEnabled,
        (enabled) => setCompEnabled(t, enabled),
        (row) => {
            row.appendChild(createKnob({ label: "THR", value: track.compThresholdDb, min: -60, max: 0, defaultValue: -12, unit: "dB", format: fmtDb, size: 36, log: true, onChange: (v) => setCompParam(t, 0, v) }).element);
            row.appendChild(createKnob({ label: "RATIO", value: track.compRatio, min: 1, max: 20, defaultValue: 3, format: fmtRatio, size: 36, onChange: (v) => setCompParam(t, 1, v) }).element);
            row.appendChild(createKnob({ label: "ATTK", value: track.compAttackMs, min: 0.1, max: 100, defaultValue: 5, unit: "ms", format: fmtMs, size: 36, log: true, onChange: (v) => setCompParam(t, 2, v) }).element);
            row.appendChild(createKnob({ label: "REL", value: track.compReleaseMs, min: 5, max: 1000, defaultValue: 100, unit: "ms", format: fmtMs, size: 36, log: true, onChange: (v) => setCompParam(t, 3, v) }).element);
            row.appendChild(createKnob({ label: "KNEE", value: track.compKneeDb, min: 0, max: 12, defaultValue: 3, unit: "dB", format: fmtDb, size: 36, onChange: (v) => setCompParam(t, 5, v) }).element);
            row.appendChild(createKnob({ label: "MKUP", value: track.compMakeupDb, min: 0, max: 24, defaultValue: 3, unit: "dB", format: fmtDb, size: 36, onChange: (v) => setCompParam(t, 4, v) }).element);
        },
        compGr.element,
        () => pushCompParams(t)));

    // EXPAND
    inputBody.appendChild(dynSection("EXPAND",
        () => track.expanderEnabled,
        (enabled) => setExpEnabled(t, enabled),
        (row) => {
            row.appendChild(createKnob({ label: "THR", value: track.expanderThresholdDb, min: -80, max: 0, defaultValue: -40, unit: "dB", format: fmtDb, size: 36, log: true, onChange: (v) => setExpParam(t, 0, v) }).element);
            row.appendChild(createKnob({ label: "RATIO", value: track.expanderRatio, min: 1, max: 10, defaultValue: 2, format: fmtRatio, size: 36, onChange: (v) => setExpParam(t, 1, v) }).element);
            row.appendChild(createKnob({ label: "ATTK", value: track.expanderAttackMs, min: 0.1, max: 100, defaultValue: 5, unit: "ms", format: fmtMs, size: 36, log: true, onChange: (v) => setExpParam(t, 2, v) }).element);
            row.appendChild(createKnob({ label: "REL", value: track.expanderReleaseMs, min: 5, max: 1000, defaultValue: 100, unit: "ms", format: fmtMs, size: 36, log: true, onChange: (v) => setExpParam(t, 3, v) }).element);
        },
        undefined,
        () => pushExpParams(t)));

    root.appendChild(inputSection);

    // ── EQ (collapsible; header hosts the IN/BYP toggle when open) ───────
    const eqSection = document.createElement("div");
    eqSection.className = "detail-section";

    const eqHeader = document.createElement("div");
    eqHeader.className = "detail-section-header collapsible";
    const eqLabel = document.createElement("span");
    eqLabel.className = "detail-section-label";
    eqLabel.textContent = "EQ";
    eqHeader.appendChild(eqLabel);

    const eqBody = document.createElement("div");
    eqBody.style.display = eqOpen ? "" : "none";

    const eqToggle = document.createElement("button");
    eqToggle.className = "detail-toggle " + (track.eqBypassed ? "bypassed" : "active");
    eqToggle.textContent = track.eqBypassed ? "BYP" : "IN";
    eqToggle.title = "EQ in / bypass";
    eqToggle.addEventListener("click", (ev) => {
        ev.stopPropagation();
        setEqBypass(t, !track.eqBypassed);
        eqToggle.className = "detail-toggle " + (track.eqBypassed ? "bypassed" : "active");
        eqToggle.textContent = track.eqBypassed ? "BYP" : "IN";
        eqCurve.redraw(track);
    });

    eqHeader.addEventListener("click", () => {
        eqOpen = !eqOpen;
        eqBody.style.display = eqOpen ? "" : "none";
        // The IN/BYP button only exists while the section is open (CakeMix
        // behavior — the collapsed header stays a plain toggle).
        if (eqOpen) {
            if (!eqHeader.contains(eqToggle)) eqHeader.appendChild(eqToggle);
            eqCurve.redraw(track);
        } else if (eqHeader.contains(eqToggle)) {
            eqHeader.removeChild(eqToggle);
        }
        applyWidth();
    });

    eqSection.appendChild(eqHeader);
    eqSection.appendChild(eqBody);

    const curveWrap = document.createElement("div");
    curveWrap.className = "detail-eq-curve";
    const eqCurve = createEqCurve(sampleRate);
    curveWrap.appendChild(eqCurve.element);
    eqBody.appendChild(curveWrap);

    const eqBands = document.createElement("div");
    eqBands.className = "eq-bands";
    EQ_BAND_LAYOUT.forEach((band, i) => {
        const row = document.createElement("div");
        row.className = "eq-band-row";
        const name = document.createElement("span");
        name.className = "eq-band-name";
        name.textContent = band.name;
        row.appendChild(name);
        const knobs = document.createElement("div");
        knobs.className = "eq-band-knobs";
        if (band.hasGain) {
            knobs.appendChild(createKnob({
                label: "G", value: track.eqBands[i].gainDb, min: -12, max: 12,
                defaultValue: 0, unit: "dB", format: fmtDb, size: 28,
                onChange: (v) => { setEqGain(t, i, v); eqCurve.redraw(track); },
            }).element);
        }
        knobs.appendChild(createKnob({
            label: "F", value: track.eqBands[i].freqHz, min: 20, max: 20000,
            defaultValue: track.eqBands[i].freqHz, unit: "Hz", format: fmtHz, size: 28, log: true,
            onChange: (v) => { setEqFreq(t, i, v); eqCurve.redraw(track); },
        }).element);
        knobs.appendChild(createKnob({
            label: "Q", value: track.eqBands[i].q, min: 0.1, max: 10,
            defaultValue: track.eqBands[i].q, format: (v) => v.toFixed(2), size: 28,
            onChange: (v) => { setEqQ(t, i, v); eqCurve.redraw(track); },
        }).element);
        row.appendChild(knobs);
        eqBands.appendChild(row);
    });
    eqBody.appendChild(eqBands);
    root.appendChild(eqSection);

    // ── PAN ───────────────────────────────────────────────────────────────
    const panSection = document.createElement("div");
    panSection.className = "detail-section";
    const panDivider = document.createElement("div");
    panDivider.className = "detail-section-divider";
    const panLabel = document.createElement("span");
    panLabel.className = "detail-section-label";
    panLabel.textContent = "PAN";
    panDivider.appendChild(panLabel);
    panSection.appendChild(panDivider);

    const panRow = document.createElement("div");
    panRow.className = "detail-pan-row";
    const panSlider = document.createElement("input");
    panSlider.type = "range";
    panSlider.className = "pan-slider";
    panSlider.min = "-1";
    panSlider.max = "1";
    panSlider.step = "0.01";
    panSlider.value = String(track.pan);
    panSlider.title = "Pan (stereo balance)";
    const panVal = document.createElement("span");
    panVal.className = "pan-val";
    panVal.textContent = fmtPan(track.pan);
    panSlider.addEventListener("input", () => {
        setTrackPan(t, parseFloat(panSlider.value));
        panVal.textContent = fmtPan(track.pan);
    });
    panRow.appendChild(panSlider);
    panRow.appendChild(panVal);
    panSection.appendChild(panRow);
    root.appendChild(panSection);

    // ── FX (guitarix insert chain; tracks 0–9 only) ─────────────────────
    let disposeFx: (() => void) | undefined;
    if (t < FX_INSTANCE_COUNT) {
        let fxSlot = 0;
        let fxSlotLocked = false;

        const fxSection = document.createElement("div");
        fxSection.className = "detail-section";
        const fxDivider = document.createElement("div");
        fxDivider.className = "detail-section-divider collapsible";
        const fxLabel = document.createElement("span");
        fxLabel.className = "detail-section-label";
        fxLabel.textContent = "FX";
        fxDivider.appendChild(fxLabel);
        fxSection.appendChild(fxDivider);

        const fxLeds = document.createElement("div");
        fxLeds.className = "detail-fx-leds";
        fxSection.appendChild(fxLeds);

        const fxBody = document.createElement("div");
        fxBody.style.display = fxOpen ? "" : "none";
        fxDivider.addEventListener("click", () => {
            fxOpen = !fxOpen;
            fxBody.style.display = fxOpen ? "" : "none";
            applyWidth();
        });
        fxSection.appendChild(fxBody);

        const fxChain = document.createElement("div");
        fxChain.className = "fx-chain-list";
        fxBody.appendChild(fxChain);

        const fxEdit = document.createElement("div");
        fxEdit.className = "fx-edit-area";
        fxBody.appendChild(fxEdit);

        function defaultFxSlot(st: FxInstanceState): number {
            for (let s = 0; s < FX_SLOTS; s++) {
                if (st.enabled[st.order[s]]) return s;
            }
            return 0;
        }

        function renderFxLeds(): void {
            const st = getFxInstance(t);
            fxLeds.textContent = "";
            for (let s = 0; s < FX_SLOTS; s++) {
                const fxId = st.order[s];
                const on = st.enabled[fxId];
                const dot = document.createElement("span");
                dot.className = "fx-led" + (on ? " on" : "");
                dot.title = `${s + 1}. ${FX_EFFECTS[fxId]?.label ?? "?"}${on ? "" : " (off)"}`;
                fxLeds.appendChild(dot);
            }
        }

        function renderFxChain(): void {
            const st = getFxInstance(t);
            fxChain.textContent = "";
            for (let s = 0; s < FX_SLOTS; s++) {
                const fxId = st.order[s];
                const fx = FX_EFFECTS[fxId];
                if (!fx) continue;
                const row = document.createElement("div");
                row.className = "fx-row" + (s === fxSlot ? " selected" : "");
                const up = document.createElement("button");
                up.className = "fx-row-btn";
                up.textContent = "▲";
                up.title = "Move earlier in chain";
                up.disabled = s === 0;
                up.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    moveFxSlot(t, s, s - 1);
                });
                const dn = document.createElement("button");
                dn.className = "fx-row-btn";
                dn.textContent = "▼";
                dn.title = "Move later in chain";
                dn.disabled = s === FX_SLOTS - 1;
                dn.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    moveFxSlot(t, s, s + 1);
                });
                const tg = document.createElement("button");
                tg.className = "detail-toggle " + (st.enabled[fxId] ? "active" : "bypassed");
                tg.textContent = st.enabled[fxId] ? "IN" : "BYP";
                tg.title = `${fx.label} in / bypass`;
                tg.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    setFxEnabledUI(t, fxId, !st.enabled[fxId]);
                });
                const lbl = document.createElement("span");
                lbl.className = "fx-row-label";
                lbl.textContent = fx.label;
                row.appendChild(up);
                row.appendChild(dn);
                row.appendChild(tg);
                row.appendChild(lbl);
                row.addEventListener("click", () => {
                    fxSlot = s;
                    fxSlotLocked = true;
                    renderFxChain();
                    renderFxEdit();
                });
                fxChain.appendChild(row);
            }
        }

        function renderFxEdit(): void {
            const st = getFxInstance(t);
            const fxId = st.order[fxSlot] ?? 0;
            const fx = FX_EFFECTS[fxId];
            if (!fx) return;
            fxEdit.textContent = "";
            const title = document.createElement("div");
            title.className = "fx-edit-title";
            title.textContent = `${fx.label} · ${fx.stereo ? "stereo" : "mono"}`;
            fxEdit.appendChild(title);
            const row = document.createElement("div");
            row.className = "knob-row";
            fx.params.forEach((p, pi) => {
                row.appendChild(createKnob({
                    label: p.name, value: st.params[fx.offset + pi], min: p.min, max: p.max,
                    defaultValue: p.default, format: fmtFx, size: 28,
                    onChange: (v) => setFxParamUI(t, fxId, pi, fxParamTo01(fxId, pi, v)),
                }).element);
            });
            fxEdit.appendChild(row);
        }

        renderFxLeds();
        renderFxChain();
        renderFxEdit();

        disposeFx = onFxStateChange(() => {
            if (!fxSlotLocked) fxSlot = defaultFxSlot(getFxInstance(t));
            renderFxLeds();
            renderFxChain();
            renderFxEdit();
        });

        root.appendChild(fxSection);
    }

    // ── Output: L meter / fader / R meter + S/M ──────────────────────────
    const outputSection = document.createElement("div");
    outputSection.className = "detail-section detail-output";

    const meterFader = document.createElement("div");
    meterFader.className = "detail-meter-fader stereo";
    const meterL: MeterHandle = createMeterCanvas(14, 160);
    const meterR: MeterHandle = createMeterCanvas(14, 160);
    meterL.element.classList.add("meter-l");
    meterR.element.classList.add("meter-r");
    meterL.element.title = "Pre-fader / pre-mute metering (post EQ + dynamics) — muting or fader changes don't affect this display.";
    meterR.element.title = "Pre-fader / pre-mute metering (post EQ + dynamics) — muting or fader changes don't affect this display.";
    meterFader.appendChild(meterL.element);

    const faderCol = document.createElement("div");
    faderCol.className = "fader-col";
    const faderVal = document.createElement("span");
    faderVal.className = "fader-val";
    faderVal.textContent = formatGainDb(track.gain);
    const faderWrap = document.createElement("div");
    faderWrap.className = "fader-wrap";
    const fader = document.createElement("input");
    fader.type = "range";
    fader.className = "fader";
    fader.min = "0";
    fader.max = "1";
    fader.step = "0.001";
    fader.value = String(gainToFader(track.gain));
    fader.title = "Track fader";
    fader.addEventListener("input", () => {
        setTrackFaderGain(t, faderToGain(parseFloat(fader.value)));
        faderVal.textContent = formatGainDb(track.gain);
    });
    fader.addEventListener("wheel", (ev: WheelEvent) => {
        ev.preventDefault();
        const step = ev.shiftKey ? 0.002 : 0.01;
        const delta = ev.deltaY > 0 ? -step : step;
        const pos = Math.max(0, Math.min(1, gainToFader(track.gain) + delta));
        fader.value = String(pos);
        setTrackFaderGain(t, faderToGain(pos));
        faderVal.textContent = formatGainDb(track.gain);
    }, { passive: false });
    faderWrap.appendChild(fader);
    faderCol.appendChild(faderVal);
    faderCol.appendChild(faderWrap);
    meterFader.appendChild(faderCol);
    meterFader.appendChild(meterR.element);
    outputSection.appendChild(meterFader);

    const controls = document.createElement("div");
    controls.className = "detail-controls";
    const soloBtn = document.createElement("button");
    soloBtn.className = "btn-sm btn-solo" + (track.soloed ? " active" : "");
    soloBtn.textContent = "S";
    soloBtn.title = "Solo";
    soloBtn.addEventListener("click", () => {
        setTrackSolo(t, !track.soloed);
        soloBtn.classList.toggle("active", track.soloed);
    });
    const muteBtn = document.createElement("button");
    muteBtn.className = "btn-sm btn-mute" + (track.muted ? " active" : "");
    muteBtn.textContent = "M";
    muteBtn.title = "Mute";
    muteBtn.addEventListener("click", () => {
        setTrackMute(t, !track.muted);
        muteBtn.classList.toggle("active", track.muted);
    });
    controls.appendChild(soloBtn);
    controls.appendChild(muteBtn);
    outputSection.appendChild(controls);

    root.appendChild(outputSection);

    applyWidth();

    return {
        element: root,
        tickMeters(): void {
            const m = trackMeters[t];
            meterL.setTargets(m.peakL, m.rmsL);
            meterR.setTargets(m.peakR, m.rmsR);
            meterL.tick();
            meterR.tick();
            // Show the deeper of the two channels' compressor reductions.
            compGr.set(Math.min(m.grL, m.grR));
        },
        ...(disposeFx ? { disposeFx } : {}),
    };
}

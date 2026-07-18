/*
 * obxd-synth-ui.ts — knob/toggle grid for the OB-XD synth panel.
 *
 * Builds the grouped control layout (~30 controls total):
 *
 *   OSCILLATOR      — OSC1Saw/OSC1Pul/OSC2Saw/OSC2Pul/OSC1MIX/OSC2MIX/OSC2_DET/PW
 *   FILTER          — CUTOFF/RESONANCE/ENVELOPE_AMT/MULTIMODE/BRIGHTNESS/NOISEMIX
 *                      + FOURPOLE/BANDPASS/FILTER_WARM (toggles)
 *   LOUDNESS ENV    — LATK/LDEC/LSUS/LREL
 *   FILTER ENV      — FATK/FDEC/FSUS/FREL
 *   LFO             — LFOFREQ/LFO1AMT/LFOFILTER/LFOOSC1/LFOPW1 + LFOSINWAVE (toggle)
 *   MASTER          — VOLUME/VOICE_COUNT/OCTAVE/TUNE/PORTAMENTO/UNISON
 *
 * Indices match ParamsEnum.h. Each control's `initial` is the post-
 * applyObxdDefaultPatch() state, so the UI renders correctly on first
 * power-on. After a .fxp load or Reset, syncObxdControlsFromEngine()
 * queries the engine for each control's current value and updates the
 * widget without re-firing the change handler (no write loop).
 */

import { createObxdKnob, createObxdToggle } from "./obxd-knob";
import { setObxdParam, getObxdParam, isObxdReady } from "./obxd-audio";

interface KnobSpec {
    kind: "knob";
    idx: number;
    label: string;
    initial: number;
    default: number;
    format?: (v: number) => string;
}

interface ToggleSpec {
    kind: "toggle";
    idx: number;
    label: string;
    initial: number;
}

type Control = KnobSpec | ToggleSpec;
type Section = { title: string; controls: Control[] };

// Param indices — kept in numeric form rather than imported from C, so
// the file stays self-contained and a future ParamsEnum.h rename can't
// silently break the build.
const VOLUME = 2;
const VOICE_COUNT = 3;
const TUNE = 4;
const OCTAVE = 5;
const PORTAMENTO = 13;
const UNISON = 14;
const UDET = 15;
const OSC2_DET = 16;
const LFOFREQ = 17;
const LFOSINWAVE = 18;
const LFO1AMT = 21;
const LFOOSC1 = 23;
const LFOFILTER = 25;
const LFOPW1 = 26;
const PW = 37;
const BRIGHTNESS = 38;
const OSC1MIX = 40;
const OSC2MIX = 41;
const NOISEMIX = 42;
const CUTOFF = 44;
const RESONANCE = 45;
const MULTIMODE = 46;
const FILTER_WARM = 47;
const BANDPASS = 48;
const FOURPOLE = 49;
const ENVELOPE_AMT = 50;
const LATK = 51;
const LDEC = 52;
const LSUS = 53;
const LREL = 54;
const FATK = 55;
const FDEC = 56;
const FSUS = 57;
const FREL = 58;
const OSC1Saw = 33;
const OSC1Pul = 34;
const OSC2Saw = 35;
const OSC2Pul = 36;

// Knob sections — `initial`/`default` are baked from apply_defaults()
// (wasm/obxd/main_obxd.cpp) + applyObxdDefaultPatch() (src/obxd-audio.ts).
const SECTIONS: Section[] = [
    {
        title: "Oscillator",
        controls: [
            { kind: "knob", idx: OSC1Saw,  label: "Osc1 Saw", initial: 1.0, default: 1.0 },
            { kind: "knob", idx: OSC1Pul,  label: "Osc1 Pul", initial: 0.0, default: 0.0 },
            { kind: "knob", idx: OSC2Saw,  label: "Osc2 Saw", initial: 1.0, default: 1.0 },
            { kind: "knob", idx: OSC2Pul,  label: "Osc2 Pul", initial: 0.0, default: 0.0 },
            { kind: "knob", idx: OSC1MIX,  label: "Osc1 Mix", initial: 1.0, default: 1.0 },
            { kind: "knob", idx: OSC2MIX,  label: "Osc2 Mix", initial: 1.0, default: 1.0 },
            { kind: "knob", idx: OSC2_DET, label: "Osc2 Det", initial: 0.4, default: 0.4 },
            { kind: "knob", idx: PW,       label: "PW",       initial: 0.0, default: 0.0 },
        ],
    },
    {
        title: "Filter",
        controls: [
            { kind: "knob", idx: CUTOFF,       label: "Cutoff",   initial: 0.5, default: 0.5 },
            { kind: "knob", idx: RESONANCE,    label: "Reso",     initial: 0.3, default: 0.3 },
            { kind: "knob", idx: ENVELOPE_AMT, label: "Env Amt",  initial: 0.3, default: 0.3 },
            { kind: "knob", idx: MULTIMODE,    label: "Multi",    initial: 0.0, default: 0.0 },
            { kind: "knob", idx: BRIGHTNESS,   label: "Bright",   initial: 1.0, default: 1.0 },
            { kind: "knob", idx: NOISEMIX,     label: "Noise",    initial: 0.0, default: 0.0 },
            { kind: "toggle", idx: FOURPOLE,   label: "4-Pole",   initial: 0 },
            { kind: "toggle", idx: BANDPASS,   label: "Band",     initial: 0 },
            { kind: "toggle", idx: FILTER_WARM,label: "Warm",     initial: 0 },
        ],
    },
    {
        title: "Loudness Env",
        controls: [
            { kind: "knob", idx: LATK, label: "Attack",  initial: 0.2,  default: 0.2 },
            { kind: "knob", idx: LDEC, label: "Decay",   initial: 0.4,  default: 0.4 },
            { kind: "knob", idx: LSUS, label: "Sustain", initial: 0.7,  default: 0.7 },
            { kind: "knob", idx: LREL, label: "Release", initial: 0.55, default: 0.55 },
        ],
    },
    {
        title: "Filter Env",
        controls: [
            { kind: "knob", idx: FATK, label: "Attack",  initial: 0.0, default: 0.0 },
            { kind: "knob", idx: FDEC, label: "Decay",   initial: 0.0, default: 0.0 },
            { kind: "knob", idx: FSUS, label: "Sustain", initial: 0.0, default: 0.0 },
            { kind: "knob", idx: FREL, label: "Release", initial: 0.0, default: 0.0 },
        ],
    },
    {
        title: "LFO",
        controls: [
            { kind: "knob", idx: LFOFREQ,   label: "Freq",   initial: 0.0, default: 0.0 },
            { kind: "knob", idx: LFO1AMT,   label: "Amt1",   initial: 0.0, default: 0.0 },
            { kind: "knob", idx: LFOFILTER, label: "Filter", initial: 0.0, default: 0.0 },
            { kind: "knob", idx: LFOOSC1,   label: "Osc1",   initial: 0.0, default: 0.0 },
            { kind: "knob", idx: LFOPW1,    label: "PW1",    initial: 0.0, default: 0.0 },
            { kind: "toggle", idx: LFOSINWAVE, label: "Sine", initial: 0 },
        ],
    },
    {
        title: "Master",
        controls: [
            { kind: "knob", idx: VOLUME,     label: "Volume", initial: 0.5, default: 0.5 },
            { kind: "knob", idx: VOICE_COUNT,label: "Voices", initial: 0.25, default: 0.25 },
            { kind: "knob", idx: OCTAVE,     label: "Octave", initial: 0.5, default: 0.5 },
            { kind: "knob", idx: TUNE,       label: "Tune",   initial: 0.5, default: 0.5 },
            { kind: "knob", idx: PORTAMENTO, label: "Porta",  initial: 0.0, default: 0.0 },
            { kind: "knob", idx: UNISON,     label: "Unison", initial: 0.0, default: 0.0 },
        ],
    },
];

interface ControlHandle {
    idx: number;
    el: HTMLElement & { setValue?: (v: number) => void };
}

let cachedControls: ControlHandle[] = [];

export function buildObxdSynthUi(container: HTMLElement): void {
    container.textContent = "";
    cachedControls = [];

    for (const section of SECTIONS) {
        const sectionEl = document.createElement("div");
        sectionEl.className = "obxd-section";
        const labelEl = document.createElement("div");
        labelEl.className = "obxd-section-label";
        labelEl.textContent = section.title;
        sectionEl.appendChild(labelEl);

        const gridEl = document.createElement("div");
        gridEl.className = "obxd-section-grid";

        for (const c of section.controls) {
            const el = c.kind === "toggle"
                ? createObxdToggle({
                      idx: c.idx,
                      label: c.label,
                      initial: c.initial,
                      onChange: (idx, value) => setObxdParam(idx, value),
                  })
                : createObxdKnob({
                      idx: c.idx,
                      label: c.label,
                      initial: c.initial,
                      defaultValue: c.default,
                      onChange: (idx, value) => setObxdParam(idx, value),
                  });
            gridEl.appendChild(el);
            cachedControls.push({ idx: c.idx, el: el as HTMLElement & { setValue?: (v: number) => void } });
        }

        sectionEl.appendChild(gridEl);
        container.appendChild(sectionEl);
    }
}

/*
 * Re-query the engine for every control's current value and update
 * the widget position WITHOUT firing onChange (so a freshly loaded
 * patch doesn't get re-written back to the engine). Call after
 * applyObxdDefaultPatch(), a .fxp load, or obxdResetPatch().
 *
 * No-ops while the worklet is unpowered — knobs simply retain whatever
 * values were last set on them (or the baked-in defaults on first show).
 */
export async function syncObxdControlsFromEngine(): Promise<void> {
    if (cachedControls.length === 0) return;
    if (!isObxdReady()) return;
    await Promise.all(cachedControls.map(async (c) => {
        const v = await getObxdParam(c.idx);
        if (v >= 0 && c.el.setValue) c.el.setValue(v);
    }));
}

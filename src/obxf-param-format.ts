/**
 * obxf-param-format.ts — OB-Xf parameter value formatting/parsing.
 *
 * Mirrors OB-Xf's ParamMetaData::valueToString / valueFromString for the
 * parameter classes exposed in the OctOBX editor. Used by the value-hover
 * bubble (Wave 2b) and the knob right-click typein (Wave 3e).
 *
 * Keyed on SynthParam::ID::* strings (case-sensitive streaming identifiers).
 * For IDs not in the lookup table, the default is simple percent (0..1 → "NN %").
 *
 * Reference: third_party/OB-Xf/src/parameter/ParameterList.h +
 * SynthParam.h Name namespace (display strings).
 */

export type FormatFn = (v01: number) => string;
export type ParseFn = (text: string) => number | null;

export interface ParamFormat {
    format: FormatFn;
    parse: ParseFn;
}

// ===========================================================================
// Primitive formatters
// ===========================================================================

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

function pct(v: number): string {
    return `${Math.round(v * 100)} %`;
}
function pctParse(text: string): number | null {
    const m = text.match(/(-?[\d.]+)/);
    return m ? clamp01(parseFloat(m[1]) / 100) : null;
}

function bipolarPct(v: number): string {
    const p = Math.round((v * 2 - 1) * 100);
    return `${p} %`;
}
function bipolarPctParse(text: string): number | null {
    const m = text.match(/(-?[\d.]+)/);
    return m ? clamp01((parseFloat(m[1]) / 100 + 1) / 2) : null;
}

function semitone(v: number): string {
    const st = Math.round(v * 48 - 24);
    return `${st} st`;
}
function semitoneParse(text: string): number | null {
    const m = text.match(/(-?[\d.]+)/);
    return m ? clamp01((parseFloat(m[1]) + 24) / 48) : null;
}

function centsFmt(v: number): string {
    return `${Math.round(v * 200 - 100)} cents`;
}
function centsParse(text: string): number | null {
    const m = text.match(/(-?[\d.]+)/);
    return m ? clamp01((parseFloat(m[1]) + 100) / 200) : null;
}

function panFmt(v: number): string {
    const p = v * 2 - 1;
    if (Math.abs(p) < 0.01) return "Center";
    return `${Math.round(Math.abs(p) * 100)} ${p < 0 ? "L" : "R"}`;
}
function panParse(text: string): number | null {
    const t = text.trim().toLowerCase();
    if (t === "center" || t === "c" || t === "0") return 0.5;
    const m = text.match(/(\d+(?:\.\d+)?)\s*(L|R)/i);
    if (!m) return null;
    const val = parseFloat(m[1]) / 100;
    return m[2].toUpperCase() === "L" ? clamp01(0.5 - val / 2) : clamp01(0.5 + val / 2);
}

function boolFmt(v: number): string {
    return v >= 0.5 ? "On" : "Off";
}
function boolParse(text: string): number | null {
    const t = text.trim().toLowerCase();
    if (["on", "1", "true", "yes"].includes(t)) return 1;
    if (["off", "0", "false", "no"].includes(t)) return 0;
    return null;
}

function envTimeFmt(v: number): string {
    const minMs = 1, maxMs = 60000;
    const ms = minMs * Math.pow(maxMs / minMs, clamp01(v));
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(1)} s`;
}
function envTimeParse(text: string): number | null {
    const m = text.match(/([\d.]+)\s*(ms|s)/i);
    if (!m) return null;
    const val = parseFloat(m[1]);
    const ms = m[2].toLowerCase() === "s" ? val * 1000 : val;
    const minMs = 1, maxMs = 60000;
    if (ms <= 0) return 0;
    return clamp01(Math.log(ms / minMs) / Math.log(maxMs / minMs));
}

function choiceFmt(choices: string[]): FormatFn {
    return (v: number) => {
        const idx = Math.round(v * (choices.length - 1));
        return choices[Math.max(0, Math.min(choices.length - 1, idx))] ?? String(idx);
    };
}
function choiceParse(choices: string[]): ParseFn {
    return (text: string) => {
        const t = text.trim();
        const idx = choices.indexOf(t);
        if (idx >= 0) return choices.length > 1 ? idx / (choices.length - 1) : 0;
        const m = t.match(/(-?\d+)/);
        if (m) {
            const fi = choices.indexOf(String(parseInt(m[1], 10)));
            if (fi >= 0) return choices.length > 1 ? fi / (choices.length - 1) : 0;
        }
        return null;
    };
}

// ===========================================================================
// ID → format mapping
// ===========================================================================

const SEMITONE_IDS = new Set(["Transpose", "Osc1Pitch", "Osc2Pitch", "EnvToPitchAmount"]);
const CENTS_IDS = new Set(["Tune"]);
const PAN_IDS = new Set([
    "PanVoice1", "PanVoice2", "PanVoice3", "PanVoice4",
    "PanVoice5", "PanVoice6", "PanVoice7", "PanVoice8",
]);
const BIPOLAR_IDS = new Set([
    "FilterKeyTrack", "FilterMode",
    "LFO1Wave1", "LFO1Wave2", "LFO1Wave3",
    "LFO2Wave1", "LFO2Wave2", "LFO2Wave3",
    "Osc2Detune",
]);
const ENV_TIME_IDS = new Set([
    "FilterEnvAttack", "FilterEnvDecay", "FilterEnvRelease",
    "AmpEnvAttack", "AmpEnvDecay", "AmpEnvRelease",
    "Portamento",
]);
const BOOL_IDS = new Set([
    "HQMode", "Unison", "Osc1SawWave", "Osc1PulseWave", "Osc2SawWave", "Osc2PulseWave",
    "Osc2Keytrack", "OscSync", "BendOsc2Only", "VibratoWave",
    "Filter4PoleMode", "Filter4PoleXpander", "Filter2PoleBPBlend", "Filter2PolePush",
    "FilterEnvInvert", "LFO1TempoSync", "LFO2TempoSync", "VoiceReassign",
    "EnvToPitchBothOscs", "EnvToPitchInvert", "EnvToPWBothOscs", "EnvToPWInvert",
]);

const CHOICE_FORMATS: Record<string, ParamFormat> = {};
function registerChoice(id: string, choices: string[]): void {
    if (choices.length > 0) {
        CHOICE_FORMATS[id] = { format: choiceFmt(choices), parse: choiceParse(choices) };
    }
}

registerChoice("Polyphony", ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32"]);
registerChoice("UnisonVoices", ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32"]);
registerChoice("BendUpRange", Array.from({length: 49}, (_, i) => String(i)));
registerChoice("BendDownRange", Array.from({length: 49}, (_, i) => String(i)));
registerChoice("EnvLegatoMode", ["Both Envelopes", "Filter Envelope Only", "Amplifier Envelope Only", "Always Retrigger"]);
registerChoice("NotePriority", ["Last", "Low", "High"]);
registerChoice("FilterXpanderMode", ["LP4","LP3","LP2","LP1","HP3","HP2","HP1","BP4","BP2","N2","PH3","HP2+LP1","HP3+LP1","N2+LP1","PH3+LP1"]);
registerChoice("NoiseColor", ["White", "Pink", "Red"]);

// ===========================================================================
// Public API
// ===========================================================================

const DEFAULT_FORMAT: ParamFormat = { format: pct, parse: pctParse };

export function getParamFormat(id: string): ParamFormat {
    if (CHOICE_FORMATS[id]) return CHOICE_FORMATS[id];
    if (SEMITONE_IDS.has(id)) return { format: semitone, parse: semitoneParse };
    if (CENTS_IDS.has(id)) return { format: centsFmt, parse: centsParse };
    if (PAN_IDS.has(id)) return { format: panFmt, parse: panParse };
    if (BIPOLAR_IDS.has(id)) return { format: bipolarPct, parse: bipolarPctParse };
    if (ENV_TIME_IDS.has(id)) return { format: envTimeFmt, parse: envTimeParse };
    if (BOOL_IDS.has(id)) return { format: boolFmt, parse: boolParse };
    return DEFAULT_FORMAT;
}

export function paramFormat(id: string, value01: number): string {
    return getParamFormat(id).format(value01);
}

export function paramParse(id: string, text: string): number | null {
    return getParamFormat(id).parse(text);
}

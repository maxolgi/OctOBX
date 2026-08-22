import { describe, it, expect } from "vitest";
import { paramMappings } from "../src/obxf-param-mappings";

// Complete list of SynthParam::ID streaming names from OB-Xf's SynthParam.h.
// This is the authoritative set — every name here MUST be handled by either
// the legacy mapping table (paramMappings.newId) or the NEW-param dispatch
// (apply_new_param_instance in main_obxd.cpp). If a name is missing from both,
// loading a native OB-Xf .fxp that serializes it will silently drop the value.
const ALL_SYNTH_PARAM_IDS: string[] = [
    // MASTER
    "Volume", "Transpose", "Tune",
    // GLOBAL
    "Polyphony", "HQMode", "UnisonVoices", "Portamento", "Unison",
    "UnisonDetune", "EnvLegatoMode", "NotePriority", "VoiceReassign",
    // OSCILLATORS
    "Osc1Pitch", "Osc2Detune", "Osc2Pitch", "Osc2Keytrack",
    "Osc1SawWave", "Osc2SawWave", "Osc1PulseWave", "Osc2PulseWave",
    "OscPW", "Osc2PWOffset",
    "EnvToPitchAmount", "EnvToPitchBothOscs", "EnvToPitchInvert",
    "EnvToPWAmount", "EnvToPWBothOscs", "EnvToPWInvert",
    "OscCrossmod", "OscSync", "OscBrightness",
    // MIXER
    "Osc1Mix", "Osc2Mix", "RingModMix", "NoiseMix", "NoiseColor",
    // CONTROL
    "PitchBendUp", "PitchBendDown", "BendOsc2Only",
    "VibratoWave", "VibratoRate",
    // FILTER
    "Filter4PoleMode", "FilterCutoff", "FilterResonance", "FilterEnvAmount",
    "FilterKeyFollow", "FilterMode", "Filter2PoleBPBlend", "Filter2PolePush",
    "Filter4PoleXpander", "FilterXpanderMode",
    // LFO 1
    "LFO1TempoSync", "LFO1Rate", "LFO1ModAmount1", "LFO1ModAmount2",
    "LFO1Wave1", "LFO1Wave2", "LFO1Wave3", "LFO1PW",
    "LFO1ToOsc1Pitch", "LFO1ToOsc2Pitch", "LFO1ToFilterCutoff",
    "LFO1ToOsc1PW", "LFO1ToOsc2PW", "LFO1ToVolume",
    // LFO 2
    "LFO2TempoSync", "LFO2Wave1", "LFO2Wave2", "LFO2Wave3", "LFO2PW",
    "LFO2Rate", "LFO2ModAmount1", "LFO2ModAmount2",
    "LFO2ToOsc1Pitch", "LFO2ToOsc2Pitch", "LFO2ToFilterCutoff",
    "LFO2ToOsc1PW", "LFO2ToOsc2PW", "LFO2ToVolume",
    // FILTER ENVELOPE
    "FilterEnvInvert", "FilterEnvAttack", "FilterEnvDecay",
    "FilterEnvSustain", "FilterEnvRelease", "FilterEnvAttackCurve",
    "VelToFilterEnv",
    // AMPLIFIER ENVELOPE
    "AmpEnvAttack", "AmpEnvDecay", "AmpEnvSustain", "AmpEnvRelease",
    "AmpEnvAttackCurve", "VelToAmpEnv",
    // VOICE VARIATION
    "PortamentoSlop", "FilterSlop", "EnvelopeSlop", "LevelSlop",
    "PanVoice1", "PanVoice2", "PanVoice3", "PanVoice4",
    "PanVoice5", "PanVoice6", "PanVoice7", "PanVoice8",
];

// The 28 NEW params (no legacy ancestor) handled by apply_new_param_instance().
// These are NOT in paramMappings but ARE in the named-attribute dispatch.
const NEW_PARAM_IDS: string[] = [
    "UnisonVoices", "VoiceReassign", "Osc2Keytrack",
    "EnvToPitchInvert", "EnvToPWInvert", "RingModMix", "NoiseColor",
    "VibratoWave", "Filter4PoleXpander", "FilterXpanderMode",
    "LFO1PW", "LFO1ToVolume",
    "LFO2TempoSync", "LFO2Rate", "LFO2ModAmount1", "LFO2ModAmount2",
    "LFO2Wave1", "LFO2Wave2", "LFO2Wave3", "LFO2PW",
    "LFO2ToOsc1Pitch", "LFO2ToOsc2Pitch", "LFO2ToFilterCutoff",
    "LFO2ToOsc1PW", "LFO2ToOsc2PW", "LFO2ToVolume",
    "FilterEnvAttackCurve", "AmpEnvAttackCurve",
];

// Note: "OscPitch" is intentionally excluded — it's a matrix-routing
// convenience ID with no processX() method and no .fxp serialization.

describe("obxf-dispatch-coverage", () => {
    it("ALL_SYNTH_PARAM_IDS has no duplicates", () => {
        const seen = new Set<string>();
        for (const id of ALL_SYNTH_PARAM_IDS) {
            expect(seen.has(id), `duplicate ID: ${id}`).toBe(false);
            seen.add(id);
        }
    });

    it("NEW_PARAM_IDS has no duplicates", () => {
        const seen = new Set<string>();
        for (const id of NEW_PARAM_IDS) {
            expect(seen.has(id), `duplicate NEW ID: ${id}`).toBe(false);
            seen.add(id);
        }
    });

    it("every SynthParam::ID is covered by legacy mapping OR NEW-param dispatch", () => {
        // Collect all streaming names covered by the legacy mapping table.
        // secondaryNewId covers the BENDRANGE split half (PitchBendDown) now
        // that BENDRANGE is ONE row with a secondary target.
        const legacyCovered = new Set<string>();
        for (const m of paramMappings) {
            if (m.newId && m.newId.length > 0) {
                legacyCovered.add(m.newId);
            }
            if (m.secondaryNewId && m.secondaryNewId.length > 0) {
                legacyCovered.add(m.secondaryNewId);
            }
        }

        // Collect all streaming names covered by the NEW-param dispatch
        const newCovered = new Set(NEW_PARAM_IDS);

        // Check every SynthParam::ID
        const uncovered: string[] = [];
        for (const id of ALL_SYNTH_PARAM_IDS) {
            if (!legacyCovered.has(id) && !newCovered.has(id)) {
                uncovered.push(id);
            }
        }

        expect(uncovered, `These SynthParam::IDs have no dispatch coverage: ${uncovered.join(", ")}`).toEqual([]);
    });

    it("NEW_PARAM_IDS are not also in the legacy mapping (would be redundant)", () => {
        const legacyIds = new Set(
            paramMappings
                .filter(m => m.newId && m.newId.length > 0)
                .map(m => m.newId)
        );

        const duplicates = NEW_PARAM_IDS.filter(id => legacyIds.has(id));
        expect(duplicates, `These NEW_PARAM_IDS also appear in legacy mappings: ${duplicates.join(", ")}`).toEqual([]);
    });

    it("paramMappings count is exactly 80 (BENDRANGE split encoded via secondaryNewId)", () => {
        expect(paramMappings.length).toBe(80);
        // ...and the split half is present exactly once:
        const bendRows = paramMappings.filter(m => m.secondaryNewId === "PitchBendDown");
        expect(bendRows.length).toBe(1);
        expect(bendRows[0].legacyIndex).toBe(6);
    });
});

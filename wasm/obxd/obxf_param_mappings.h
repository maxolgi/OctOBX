/*
 * obxf_param_mappings.h — OB-Xd (ParamsEnum.h) → OB-Xf (SynthParam::ID) dispatch table.
 *
 * Authoritative source: third_party clone of surge-synthesizer/OB-Xf at
 * src/state/ObxdImporter.cpp::translateProgramFromXml (the frozen ObxdParam enum
 * and the ID:: assignments there). Method names verified against both
 *   third_party/Obxd/Source/Engine/SynthEngine.h   (legacy)
 *   /tmp/opencode/ob-xf/src/engine/SynthEngine.h   (new)
 *
 * legacy_index values match ParamsEnum.h exactly (0..79 valid, 80 = PARAM_COUNT).
 *
 * NOTES for the rewriter:
 *  - legacy_method "" means UI-only / no-op in the old engine.
 *  - new_method "" means REMOVED — drop the case (do not call anything).
 *  - new_method names are the ACTUAL SynthEngine method names. Five of them
 *    differ from the SynthParam::ID string (processPitchBothOscs,
 *    processVibratoLFORate, processVibratoLFOWave, processLFO1Sync,
 *    processLFO2Sync). Use the method name in your s.X(v) call, not new_id.
 *  - entries marked "RESCALE" need a value transform BEFORE the call; see notes.
 *  - BENDRANGE (index 6) appears TWICE — it splits to both PitchBendUp and
 *    PitchBendDown. Dispatch must call BOTH methods with the same transformed value.
 */
#ifndef OBXF_PARAM_MAPPINGS_H
#define OBXF_PARAM_MAPPINGS_H

typedef struct {
    int legacy_index;
    const char* legacy_name;
    const char* legacy_method;
    const char* new_id;        /* SynthParam::ID streaming string (case-sensitive) */
    const char* new_method;    /* actual SynthEngine method name; "" = removed */
    const char* notes;
} obxf_param_mapping_t;

static const obxf_param_mapping_t obxf_param_mappings[] = {
    /*  0 */ {  0, "UNDEFINED",          "",                              "",                     "",                           "sentinel / no-op" },
    /*  1 */ {  1, "MIDILEARN",          "(UI-only)",                     "",                     "",                           "REMOVED: UI-only, no engine action, no OB-Xf equivalent" },
    /*  2 */ {  2, "VOLUME",             "processVolume",                 "Volume",               "processVolume",              "1:1 copy; both linsc(v,0,0.30)" },
    /*  3 */ {  3, "VOICE_COUNT",        "setVoiceCount",                 "Polyphony",            "processPolyphony",           "RESCALE: old 1..8 voices (v*7+1), new 1..33 (v*32). Importer: xdVoices=clamp(round(v*31)-eps)+1; Polyphony=(xdVoices-1+0.5)/32" },
    /*  4 */ {  4, "TUNE",               "processTune",                   "Tune",                 "processTune",                "1:1 copy; both v*2-1" },
    /*  5 */ {  5, "OCTAVE",             "processOctave",                 "Transpose",            "processTranspose",           "SEMANTIC SHIFT+RESCALE: old (round(v*4)-2)*12 st; new round((v*2-1)*24) st. Importer: transpose=round(v*4)+1 clamped 0..4, *0.25" },
    /*  6a*/ {  6, "BENDRANGE",          "procPitchWheelAmount",          "PitchBendUp",          "processBendUpRange",         "SPLIT (1/2): old single toggle >0.5?12:2; new separate up/down. Also write PitchBendDown. Importer: n=(range==12?12:2)/MAX_BEND_RANGE to BOTH" },
    /*  6b*/ {  6, "BENDRANGE",          "procPitchWheelAmount",          "PitchBendDown",        "processBendDownRange",       "SPLIT (2/2): second target of BENDRANGE. Same value as up-range" },
    /*  7 */ {  7, "BENDOSC2",           "procPitchWheelOsc2Only",        "BendOsc2Only",         "processBendOsc2Only",        "1:1 copy; >=0.5 threshold both sides" },
    /*  8 */ {  8, "LEGATOMODE",         "processLegatoMode",             "EnvLegatoMode",        "processEnvLegatoMode",       "QUANT SHIFT: old round(v*3+1)-1 {0..3}; new int(v*3) {0..3}. Same 4 modes (Both/Filter/Amp/Retrigger), different bucket boundaries at v=0.5" },
    /*  9 */ {  9, "BENDLFORATE",        "procModWheelFrequency",         "VibratoRate",          "processVibratoLFORate",      "RESCALE+RENAME: old logsc(v,3,10)Hz; new linsc(v,2,12)Hz. Importer: hzXd=logsc(v,3,10); VibratoRate=invLinsc(hzXd,2,12). Method=processVibratoLFORate" },
    /* 10 */ { 10, "VFLTENV",            "procFltVelocityAmount",         "VelToFilterEnv",       "processVelToFilterEnv",      "1:1 copy" },
    /* 11 */ { 11, "VAMPENV",            "procAmpVelocityAmount",         "VelToAmpEnv",          "processVelToAmpEnv",         "1:1 copy" },
    /* 12 */ { 12, "ASPLAYEDALLOCATION", "procAsPlayedAlloc",             "NotePriority",         "processNotePriority",        "SEMANTIC: old bool; new tri-state int(v*2) Last/Low/High. Importer: v>0.5?0(Last):0.5(Low). High state has no ancestor" },
    /* 13 */ { 13, "PORTAMENTO",         "processPortamento",             "Portamento",           "processPortamento",          "1:1 copy; both logsc(1-v,0.14,250,150)" },
    /* 14 */ { 14, "UNISON",             "processUnison",                 "Unison",               "processUnison",              "1:1 copy; >=0.5 threshold" },
    /* 15 */ { 15, "UDET",               "processDetune",                 "UnisonDetune",         "processUnisonDetune",        "RESCALE: old logsc(v,0.001,0.90); new logsc(v,0.001,1.0). Importer: dXd=logsc(v,0.001,0.9); UnisonDetune=invLogsc(dXd,0.001,1.0)" },
    /* 16 */ { 16, "OSC2_DET",           "processOsc2Det",                "Osc2Detune",           "processOsc2Detune",          "1:1 copy; both logsc(v,0.001,0.6)" },
    /* 17 */ { 17, "LFOFREQ",            "processLfoFrequency",           "LFO1Rate",             "processLFO1Rate",            "RESCALE+RENAME: old logsc(v,0,50,120)Hz; new logsc(v,0,250,3775)Hz ~75x diff. Importer: hzXd=logsc(v,0,50,120); LFO1Rate=invLogsc(hzXd,0,250,3775). Synced path uses 9->21 bucket table" },
    /* 18 */ { 18, "LFOSINWAVE",         "processLfoSine",                "LFO1Wave1",            "processLFO1Wave1",           "TYPE CHANGE: bool->blend[-1..1]. Importer: lfoBoolToBlend=v>=0.5?0:0.5. Display Sine/Triangle" },
    /* 19 */ { 19, "LFOSQUAREWAVE",      "processLfoSquare",              "LFO1Wave2",            "processLFO1Wave2",           "TYPE CHANGE: bool->blend. Same transform. Display Pulse/Saw" },
    /* 20 */ { 20, "LFOSHWAVE",          "processLfoSH",                  "LFO1Wave3",            "processLFO1Wave3",           "TYPE CHANGE: bool->blend. Same transform. Display S&H/S&G" },
    /* 21 */ { 21, "LFO1AMT",            "processLfoAmt1",                "LFO1ModAmount1",       "processLFO1ModAmount1",      "1:1 copy; both logsc(logsc(v,0,1,60),0,60,10)" },
    /* 22 */ { 22, "LFO2AMT",            "processLfoAmt2",                "LFO1ModAmount2",       "processLFO1ModAmount2",      "AMBIGUOUS NAME: old 'LFO2AMT' is LFO1's 2nd mod amount, NOT LFO2. 1:1 copy; both linsc(v,0,0.7)" },
    /* 23 */ { 23, "LFOOSC1",            "processLfoOsc1",                "LFO1ToOsc1Pitch",      "processLFO1ToOsc1Pitch",     "TYPE CHANGE: bool->tri-state{Off,On,Inv} norm 0/0.5/1. Importer: lfoBoolToTriState=v>=0.5?0.5:0. Inv state has no ancestor" },
    /* 24 */ { 24, "LFOOSC2",            "processLfoOsc2",                "LFO1ToOsc2Pitch",      "processLFO1ToOsc2Pitch",     "TYPE CHANGE: bool->tri-state. Same transform" },
    /* 25 */ { 25, "LFOFILTER",          "processLfoFilter",              "LFO1ToFilterCutoff",   "processLFO1ToFilterCutoff",  "TYPE CHANGE: bool->tri-state. Same transform" },
    /* 26 */ { 26, "LFOPW1",             "processLfoPw1",                 "LFO1ToOsc1PW",         "processLFO1ToOsc1PW",        "TYPE CHANGE: bool->tri-state. Same transform" },
    /* 27 */ { 27, "LFOPW2",             "processLfoPw2",                 "LFO1ToOsc2PW",         "processLFO1ToOsc2PW",        "TYPE CHANGE: bool->tri-state. NOT LFO2 — LFO1->Osc2PW" },
    /* 28 */ { 28, "OSC2HS",             "processOsc2HardSync",           "OscSync",              "processOscSync",             "1:1 copy; >=0.5 threshold" },
    /* 29 */ { 29, "XMOD",               "processOsc2Xmod",               "OscCrossmod",          "processCrossmod",            "RESCALE: old v*24 st; new v*48 st. Importer: OscCrossmod=v*0.5" },
    /* 30 */ { 30, "OSC1P",              "processOsc1Pitch",              "Osc1Pitch",            "processOsc1Pitch",           "1:1 copy; both v*48 st. Importer has OCTAVE-compensation branch" },
    /* 31 */ { 31, "OSC2P",              "processOsc2Pitch",              "Osc2Pitch",            "processOsc2Pitch",           "1:1 copy; both v*48 st. Same OCTAVE-compensation branch" },
    /* 32 */ { 32, "OSCQuantize",        "processPitchQuantization",      "",                     "",                           "REMOVED: no runtime param in OB-Xf. Importer only READS it to round osc pitches at import" },
    /* 33 */ { 33, "OSC1Saw",            "processOsc1Saw",                "Osc1SawWave",          "processOsc1Saw",             "1:1 copy; >=0.5 threshold" },
    /* 34 */ { 34, "OSC1Pul",            "processOsc1Pulse",              "Osc1PulseWave",        "processOsc1Pulse",           "1:1 copy; >=0.5 threshold" },
    /* 35 */ { 35, "OSC2Saw",            "processOsc2Saw",                "Osc2SawWave",          "processOsc2Saw",             "1:1 copy; >=0.5 threshold" },
    /* 36 */ { 36, "OSC2Pul",            "processOsc2Pulse",              "Osc2PulseWave",        "processOsc2Pulse",           "1:1 copy; >=0.5 threshold" },
    /* 37 */ { 37, "PW",                 "processPulseWidth",             "OscPW",                "processOscPW",               "1:1 copy; both linsc(v,0,0.95)" },
    /* 38 */ { 38, "BRIGHTNESS",         "processBrightness",             "OscBrightness",        "processOscBrightness",       "1:1 copy; both linsc(v,7000,26000)" },
    /* 39 */ { 39, "ENVPITCH",           "processEnvelopeToPitch",        "EnvToPitchAmount",     "processEnvToPitchAmount",    "RESCALE: old v*36 st; new v*40 st. Importer: EnvToPitchAmount=v*(36/40)=v*0.9" },
    /* 40 */ { 40, "OSC1MIX",            "processOsc1Mix",                "Osc1Mix",              "processOsc1Volume",          "1:1 copy. ID='Osc1Mix'(var Osc1Vol) method=processOsc1Volume — 3 names differ" },
    /* 41 */ { 41, "OSC2MIX",            "processOsc2Mix",                "Osc2Mix",              "processOsc2Volume",          "1:1 copy. ID='Osc2Mix'(var Osc2Vol) method=processOsc2Volume" },
    /* 42 */ { 42, "NOISEMIX",           "processNoiseMix",               "NoiseMix",             "processNoiseVolume",         "RESCALE: old logsc(v,0,1,35) INSIDE engine; new takes pre-scaled. Importer: NoiseVol=logsc(v,0,1,35). ID='NoiseMix'(var NoiseVol)" },
    /* 43 */ { 43, "FLT_KF",             "processFilterKeyFollow",        "FilterKeyFollow",      "processFilterKeyTrack",      "1:1 copy. ID='FilterKeyFollow'(var FilterKeyTrack) method=processFilterKeyTrack" },
    /* 44 */ { 44, "CUTOFF",             "processCutoff",                 "FilterCutoff",         "processFilterCutoff",        "1:1 copy; both linsc(v,0,120) into cutoff smoother" },
    /* 45 */ { 45, "RESONANCE",          "processResonance",              "FilterResonance",      "processFilterResonance",     "1:1 copy; both 0.991-logsc(1-v,0,0.991,40)" },
    /* 46 */ { 46, "MULTIMODE",          "processMultimode",              "FilterMode",           "processFilterMode",          "1:1 copy; old per-voice, new smoother — same range" },
    /* 47 */ { 47, "FILTER_WARM",        "processOversampling",           "HQMode",               "processHQMode",              "RENAME+BEHAVIOR: old SetOversample; new SetHQMode AND calls allSoundOff() on toggle. Importer copies v directly" },
    /* 48 */ { 48, "BANDPASS",           "processBandpassSw",             "Filter2PoleBPBlend",   "processFilter2PoleBPBlend",  "1:1 copy; >=0.5 threshold" },
    /* 49 */ { 49, "FOURPOLE",           "processFourPole",               "Filter4PoleMode",      "processFilter4PoleMode",     "1:1 copy; >=0.5 threshold" },
    /* 50 */ { 50, "ENVELOPE_AMT",       "processFilterEnvelopeAmt",      "FilterEnvAmount",      "processFilterEnvAmount",     "1:1 copy; both linsc(v,0,140)" },
    /* 51 */ { 51, "LATK",               "processLoudnessEnvelopeAttack", "AmpEnvAttack",         "processAmpEnvAttack",        "RESCALE: old logsc(v,4,60000,900)ms; new same range but env sustains at 90% so ~3x faster. Importer: msXd=logsc(v,4,60000,900); msXf=msXd/3; AmpEnvAttack=invLogsc(msXf,4,60000,900)" },
    /* 52 */ { 52, "LDEC",               "processLoudnessEnvelopeDecay",  "AmpEnvDecay",          "processAmpEnvDecay",         "1:1 copy; both logsc(v,4,60000,900). Importer does NOT /3 decay" },
    /* 53 */ { 53, "LSUS",               "processLoudnessEnvelopeSustain","AmpEnvSustain",        "processAmpEnvSustain",       "1:1 copy" },
    /* 54 */ { 54, "LREL",               "processLoudnessEnvelopeRelease","AmpEnvRelease",        "processAmpEnvRelease",       "1:1 copy; both logsc(v,8,60000,900)" },
    /* 55 */ { 55, "FATK",               "processFilterEnvelopeAttack",   "FilterEnvAttack",      "processFilterEnvAttack",     "RESCALE: old logsc(v,1,60000,900)ms; new same range. Importer applies /3: msXf=msXd/3; FilterEnvAttack=invLogsc(msXf,1,60000,900)" },
    /* 56 */ { 56, "FDEC",               "processFilterEnvelopeDecay",    "FilterEnvDecay",       "processFilterEnvDecay",      "1:1 copy; both logsc(v,1,60000,900)" },
    /* 57 */ { 57, "FSUS",               "processFilterEnvelopeSustain",  "FilterEnvSustain",     "processFilterEnvSustain",    "1:1 copy" },
    /* 58 */ { 58, "FREL",               "processFilterEnvelopeRelease",  "FilterEnvRelease",     "processFilterEnvRelease",    "1:1 copy; both logsc(v,1,60000,900)" },
    /* 59 */ { 59, "ENVDER",             "processEnvelopeDetune",         "EnvelopeSlop",         "processEnvelopeSlop",        "1:1 copy; old setEnvDer(linsc(v,0,1)) new setEnvTimingOffset(v)" },
    /* 60 */ { 60, "FILTERDER",          "processFilterDetune",           "FilterSlop",           "processFilterSlop",          "1:1 copy; both linsc(v,0,18)" },
    /* 61 */ { 61, "PORTADER",           "processPortamentoDetune",       "PortamentoSlop",       "processPortamentoSlop",      "1:1 copy; both linsc(v,0,0.75)" },
    /* 62 */ { 62, "PAN1",               "processPan",                    "PanVoice1",            "processPan",                 "1:1 copy. Call processPan(v,1)" },
    /* 63 */ { 63, "PAN2",               "processPan",                    "PanVoice2",            "processPan",                 "1:1 copy. Call processPan(v,2)" },
    /* 64 */ { 64, "PAN3",               "processPan",                    "PanVoice3",            "processPan",                 "1:1 copy. Call processPan(v,3)" },
    /* 65 */ { 65, "PAN4",               "processPan",                    "PanVoice4",            "processPan",                 "1:1 copy. Call processPan(v,4)" },
    /* 66 */ { 66, "PAN5",               "processPan",                    "PanVoice5",            "processPan",                 "1:1 copy. Call processPan(v,5). Old MAX_VOICES=8 so PAN5..8 rarely used" },
    /* 67 */ { 67, "PAN6",               "processPan",                    "PanVoice6",            "processPan",                 "1:1 copy. Call processPan(v,6)" },
    /* 68 */ { 68, "PAN7",               "processPan",                    "PanVoice7",            "processPan",                 "1:1 copy. Call processPan(v,7)" },
    /* 69 */ { 69, "PAN8",               "processPan",                    "PanVoice8",            "processPan",                 "1:1 copy. Call processPan(v,8)" },
    /* 70 */ { 70, "UNLEARN",            "(UI-only)",                     "",                     "",                           "REMOVED: UI-only, no engine action, no OB-Xf equivalent" },
    /* 71 */ { 71, "ECONOMY_MODE",       "procEconomyMode",               "",                     "",                           "REMOVED: OB-Xf has no economy mode (HQMode is successor but maps from FILTER_WARM)" },
    /* 72 */ { 72, "LFO_SYNC",           "procLfoSync",                   "LFO1TempoSync",        "processLFO1Sync",            "1:1 copy; >=0.5 threshold. Method=processLFO1Sync (no 'Tempo'). Importer warns old sync unreliable" },
    /* 73 */ { 73, "PW_ENV",             "processPwEnv",                  "EnvToPWAmount",        "processEnvToPWAmount",       "RESCALE: old linsc(v,0,0.85); new linsc(v,0,1.055555555). Importer: EnvToPWAmount=v*(0.85/1.055555555)" },
    /* 74 */ { 74, "PW_ENV_BOTH",        "processPwEnvBoth",              "EnvToPWBothOscs",      "processEnvToPWBothOscs",     "1:1 copy; >=0.5 threshold" },
    /* 75 */ { 75, "ENV_PITCH_BOTH",     "processPitchModBoth",           "EnvToPitchBothOscs",   "processPitchBothOscs",       "1:1 copy; >=0.5. METHOD MISMATCH: method=processPitchBothOscs (no 'EnvTo'), NOT processEnvToPitchBothOscs" },
    /* 76 */ { 76, "FENV_INVERT",        "processInvertFenv",             "FilterEnvInvert",      "processFilterEnvInvert",     "1:1 copy; >=0.5 threshold" },
    /* 77 */ { 77, "PW_OSC2_OFS",        "processPwOfs",                  "Osc2PWOffset",         "processOsc2PWOffset",        "RESCALE: old linsc(v,0,0.75); new linsc(v,0,0.95). Importer: Osc2PWOffset=v*(0.75/0.95)" },
    /* 78 */ { 78, "LEVEL_DIF",          "processLoudnessDetune",         "LevelSlop",            "processLevelSlop",           "1:1 copy; both linsc(v,0,0.67)" },
    /* 79 */ { 79, "SELF_OSC_PUSH",      "processSelfOscPush",            "Filter2PolePush",      "processFilter2PolePush",     "1:1 copy; >=0.5 threshold. RENAMED: old selfOscPush, new setFilter2PolePush" },
};

/* Note: array contains TWO rows for legacy_index==6 (BENDRANGE split).
 * Count is therefore 81, not 80. Code that looks up by legacy_index must
 * handle the possibility of multiple matches (or special-case index 6). */
static const int obxf_param_mappings_count =
    sizeof(obxf_param_mappings) / sizeof(obxf_param_mappings[0]);

#endif /* OBXF_PARAM_MAPPINGS_H */

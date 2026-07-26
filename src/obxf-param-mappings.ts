// obxf-param-mappings.ts
// Auto-generated from ObxdImporter.cpp (authoritative) + both SynthEngine.h headers.
// legacyIndex values come from the frozen ObxdParam enum (matches OctOBX ParamsEnum.h
// at tag 2.19 exactly: 0..79 valid, 80 = PARAM_COUNT sentinel).

export type ParamMapping = {
    legacyIndex: number;       // old ParamsEnum.h integer
    legacyName: string;        // old ParamsEnum.h identifier, e.g. "CUTOFF"
    legacyMethod: string;      // old SynthEngine method, e.g. "processCutoff"
    newId: string;             // OB-Xf SynthParam::ID streaming string
    newMethod: string | null;  // new SynthEngine method, e.g. "processFilterCutoff"
                               // null if the param was removed or merged
    newNotes?: string;         // caveats (range change, semantic shift, etc.)
};

export const paramMappings: ParamMapping[] = [
    // ---- index 0..11: master / global / velocity ----
    { legacyIndex: 0,  legacyName: "UNDEFINED",          legacyMethod: "",                              newId: "",                  newMethod: null,                              newNotes: "sentinel / no-op" },

    { legacyIndex: 1,  legacyName: "MIDILEARN",          legacyMethod: "(UI-only)",                     newId: "",                  newMethod: null,                              newNotes: "REMOVED — UI-only in OB-Xd, no engine action and no OB-Xf equivalent" },

    { legacyIndex: 2,  legacyName: "VOLUME",             legacyMethod: "processVolume",                 newId: "Volume",            newMethod: "processVolume",                   newNotes: "1:1 value copy. Both engines linsc(v,0,0.30)." },

    { legacyIndex: 3,  legacyName: "VOICE_COUNT",        legacyMethod: "setVoiceCount",                 newId: "Polyphony",         newMethod: "processPolyphony",                newNotes: "RESCALE REQUIRED. OB-Xd: roundToInt(v*7)+1 = 1..8 voices. OB-Xf: 1+(int)(v*32) = 1..33 (MAX_VOICES=32). Importer remaps: xdVoices=clamp(round(v*31)-eps)+1, then Polyphony=(xdVoices-1+0.5)/32. Pass v through unchanged and you get ~4x the voices. NOTE: new method also has separate UnisonVoices param (index -1 below)." },

    { legacyIndex: 4,  legacyName: "TUNE",               legacyMethod: "processTune",                   newId: "Tune",              newMethod: "processTune",                     newNotes: "1:1 value copy. Both engines: v*2-1." },

    { legacyIndex: 5,  legacyName: "OCTAVE",             legacyMethod: "processOctave",                 newId: "Transpose",         newMethod: "processTranspose",                newNotes: "SEMANTIC SHIFT + RESCALE. OB-Xd processOctave: (round(v*4)-2)*12 semitones. OB-Xf processTranspose: roundToInt((v*2-1)*24) semitones. Importer: transpose=round(v*4)+1 clamped 0..4, stored as transpose*0.25. Old OCTAVE was 'middle-C octave reference an octave too high' (per importer warning). NOT a direct value copy." },

    { legacyIndex: 6,  legacyName: "BENDRANGE",          legacyMethod: "procPitchWheelAmount",          newId: "PitchBendUp",       newMethod: "processBendUpRange",              newNotes: "AMBIGUOUS: SPLIT into two params. OB-Xd had a single toggle: >0.5 → 12 semis, else 2 semis. OB-Xf has separate BendUpRange + BendDownRange (variable names; streaming IDs are 'PitchBendUp'/'PitchBendDown'). Importer writes the SAME value to both: n = (range==12?12:2)/MAX_BEND_RANGE. Dispatch must write both targets. See next entry for the down-range half." },

    { legacyIndex: 6,  legacyName: "BENDRANGE",          legacyMethod: "procPitchWheelAmount",          newId: "PitchBendDown",     newMethod: "processBendDownRange",            newNotes: "AMBIGUOUS: second half of the BENDRANGE split. Same source value drives processBendDownRange as well." },

    { legacyIndex: 7,  legacyName: "BENDOSC2",           legacyMethod: "procPitchWheelOsc2Only",        newId: "BendOsc2Only",      newMethod: "processBendOsc2Only",             newNotes: "1:1 value copy (>=0.5 threshold on both sides)." },

    { legacyIndex: 8,  legacyName: "LEGATOMODE",         legacyMethod: "processLegatoMode",             newId: "EnvLegatoMode",     newMethod: "processEnvLegatoMode",            newNotes: "QUANTIZATION SHIFT. OB-Xd: roundToInt(v*3+1)-1 → {0,1,2,3}. OB-Xf: int(v*3) → {0,1,2,3} with labels Both/Filter/Amp/Retrigger. Importer copies v directly; the two engines disagree at v=0.5 (old→2, new→1). Same 4-mode range, different bucket boundaries." },

    { legacyIndex: 9,  legacyName: "BENDLFORATE",        legacyMethod: "procModWheelFrequency",         newId: "VibratoRate",       newMethod: "processVibratoLFORate",           newNotes: "RESCALE + RENAME. OB-Xd: logsc(v,3,10) Hz. OB-Xf: linsc(v,2,12) Hz. Importer: hzXd=logsc(v,3,10); VibratoRate=invLinsc(hzXd,2,12). Note method name is processVibratoLFORate (capital R), ID is 'VibratoRate'." },

    { legacyIndex: 10, legacyName: "VFLTENV",            legacyMethod: "procFltVelocityAmount",         newId: "VelToFilterEnv",    newMethod: "processVelToFilterEnv",           newNotes: "1:1 value copy." },

    { legacyIndex: 11, legacyName: "VAMPENV",            legacyMethod: "procAmpVelocityAmount",         newId: "VelToAmpEnv",       newMethod: "processVelToAmpEnv",              newNotes: "1:1 value copy." },

    // ---- index 12..22: allocation / unison / LFO freq+wave ----
    { legacyIndex: 12, legacyName: "ASPLAYEDALLOCATION", legacyMethod: "procAsPlayedAlloc",             newId: "NotePriority",      newMethod: "processNotePriority",             newNotes: "SEMANTIC SHIFT. OB-Xd: bool asPlayedMode (>=0.5). OB-Xf: tri-state int(v*2) → {0=Last,1=Low,2=High}. Importer: v>0.5 ? 0 (Last) : 0.5 (Low). Lossy — the 'High' state has no OB-Xd ancestor." },

    { legacyIndex: 13, legacyName: "PORTAMENTO",         legacyMethod: "processPortamento",             newId: "Portamento",        newMethod: "processPortamento",               newNotes: "1:1 value copy. Both: logsc(1-v,0.14,250,150)." },

    { legacyIndex: 14, legacyName: "UNISON",             legacyMethod: "processUnison",                 newId: "Unison",            newMethod: "processUnison",                   newNotes: "1:1 value copy (>=0.5 threshold on both sides)." },

    { legacyIndex: 15, legacyName: "UDET",               legacyMethod: "processDetune",                 newId: "UnisonDetune",      newMethod: "processUnisonDetune",             newNotes: "RESCALE. OB-Xd: logsc(v,0.001,0.90). OB-Xf: logsc(v,0.001,1.0). Importer: dXd=logsc(v,0.001,0.9); UnisonDetune=invLogsc(dXd,0.001,1.0)." },

    { legacyIndex: 16, legacyName: "OSC2_DET",           legacyMethod: "processOsc2Det",                newId: "Osc2Detune",        newMethod: "processOsc2Detune",               newNotes: "1:1 value copy. Both: logsc(v,0.001,0.6)." },

    { legacyIndex: 17, legacyName: "LFOFREQ",            legacyMethod: "processLfoFrequency",           newId: "LFO1Rate",          newMethod: "processLFO1Rate",                 newNotes: "RESCALE + RENAME. OB-Xd: logsc(v,0,50,120) Hz. OB-Xf: logsc(v,0,250,3775) Hz. Importer: if synced use 9-bucket→21-bucket table mapLfoSyncedRate; else hzXd=logsc(v,0,50,120); LFO1Rate=invLogsc(hzXd,0,250,3775). Without rescale, the LFO runs ~75x faster." },

    { legacyIndex: 18, legacyName: "LFOSINWAVE",         legacyMethod: "processLfoSine",                newId: "LFO1Wave1",         newMethod: "processLFO1Wave1",                newNotes: "TYPE CHANGE: bool → float blend[-1..1]. Importer: lfoBoolToBlend(v) = v>=0.5 ? 0 : 0.5. Old toggled waveform bit 1; new sets wave1blend = linsc(v,-1,1). The display name pair is 'Sine/Triangle'." },

    { legacyIndex: 19, legacyName: "LFOSQUAREWAVE",      legacyMethod: "processLfoSquare",              newId: "LFO1Wave2",         newMethod: "processLFO1Wave2",                newNotes: "TYPE CHANGE: bool → float blend. Same lfoBoolToBlend transform. Display pair 'Pulse/Saw'." },

    { legacyIndex: 20, legacyName: "LFOSHWAVE",          legacyMethod: "processLfoSH",                  newId: "LFO1Wave3",         newMethod: "processLFO1Wave3",                newNotes: "TYPE CHANGE: bool → float blend. Same lfoBoolToBlend transform. Display pair 'Sample&Hold/Sample&Glide'." },

    { legacyIndex: 21, legacyName: "LFO1AMT",            legacyMethod: "processLfoAmt1",                newId: "LFO1ModAmount1",    newMethod: "processLFO1ModAmount1",           newNotes: "1:1 value copy. Both: logsc(logsc(v,0,1,60),0,60,10)." },

    { legacyIndex: 22, legacyName: "LFO2AMT",            legacyMethod: "processLfoAmt2",                newId: "LFO1ModAmount2",    newMethod: "processLFO1ModAmount2",           newNotes: "AMBIGUOUS NAMING: old 'LFO2AMT' is NOT LFO2 — it is the second mod-amount on LFO1. Importer confirms LFO2AMT → LFO1ModAmount2. 1:1 value copy. Both: linsc(v,0,0.7). Do NOT route this to the new LFO2." },

    // ---- index 23..27: LFO1 routing (bool → tri-state) ----
    { legacyIndex: 23, legacyName: "LFOOSC1",            legacyMethod: "processLfoOsc1",                newId: "LFO1ToOsc1Pitch",   newMethod: "processLFO1ToOsc1Pitch",          newNotes: "TYPE CHANGE: bool → tri-state {0=Off,1=On,2=Inverted} (normalized 0/0.5/1.0). Importer: lfoBoolToTriState(v) = v>=0.5 ? 0.5 (On) : 0 (Off). The 'Inverted' state has no OB-Xd ancestor. Engine remaps 0/0.5/1 → 0/1/-1." },

    { legacyIndex: 24, legacyName: "LFOOSC2",            legacyMethod: "processLfoOsc2",                newId: "LFO1ToOsc2Pitch",   newMethod: "processLFO1ToOsc2Pitch",          newNotes: "TYPE CHANGE: bool → tri-state. Same lfoBoolToTriState transform." },

    { legacyIndex: 25, legacyName: "LFOFILTER",          legacyMethod: "processLfoFilter",              newId: "LFO1ToFilterCutoff",newMethod: "processLFO1ToFilterCutoff",       newNotes: "TYPE CHANGE: bool → tri-state. Same lfoBoolToTriState transform." },

    { legacyIndex: 26, legacyName: "LFOPW1",             legacyMethod: "processLfoPw1",                 newId: "LFO1ToOsc1PW",      newMethod: "processLFO1ToOsc1PW",             newNotes: "TYPE CHANGE: bool → tri-state. Same lfoBoolToTriState transform." },

    { legacyIndex: 27, legacyName: "LFOPW2",             legacyMethod: "processLfoPw2",                 newId: "LFO1ToOsc2PW",      newMethod: "processLFO1ToOsc2PW",             newNotes: "TYPE CHANGE: bool → tri-state. Same lfoBoolToTriState transform. (NOT routed to LFO2 despite the '2' — it is LFO1→Osc2PW.)" },

    // ---- index 28..39: oscillators ----
    { legacyIndex: 28, legacyName: "OSC2HS",             legacyMethod: "processOsc2HardSync",           newId: "OscSync",           newMethod: "processOscSync",                  newNotes: "1:1 value copy (>=0.5 threshold on both sides)." },

    { legacyIndex: 29, legacyName: "XMOD",               legacyMethod: "processOsc2Xmod",               newId: "OscCrossmod",       newMethod: "processCrossmod",                 newNotes: "RESCALE. OB-Xd: v*24 semis. OB-Xf: v*48 semis. Importer: OscCrossmod = v*0.5. Pass v unchanged and crossmod is 2x as deep." },

    { legacyIndex: 30, legacyName: "OSC1P",              legacyMethod: "processOsc1Pitch",              newId: "Osc1Pitch",         newMethod: "processOsc1Pitch",                newNotes: "1:1 value copy (both engines multiply by 48 semitones). Importer has a special OCTAVE-compensation branch: if both osc pitches <=36 st and transpose>4, adds 12 st to each." },

    { legacyIndex: 31, legacyName: "OSC2P",              legacyMethod: "processOsc2Pitch",              newId: "Osc2Pitch",         newMethod: "processOsc2Pitch",                newNotes: "1:1 value copy (both *48 semitones). Same OCTAVE-compensation branch as OSC1P applies." },

    { legacyIndex: 32, legacyName: "OSCQuantize",        legacyMethod: "processPitchQuantization",      newId: "",                  newMethod: null,                              newNotes: "REMOVED — no runtime equivalent. OB-Xf does not expose osc-pitch quantization as a parameter. The importer READS it (as `oscStep`) only to decide whether to round osc1/osc2 pitch to integers during import. Drop the case." },

    { legacyIndex: 33, legacyName: "OSC1Saw",            legacyMethod: "processOsc1Saw",                newId: "Osc1SawWave",       newMethod: "processOsc1Saw",                  newNotes: "1:1 value copy (>=0.5 threshold on both sides)." },

    { legacyIndex: 34, legacyName: "OSC1Pul",            legacyMethod: "processOsc1Pulse",              newId: "Osc1PulseWave",     newMethod: "processOsc1Pulse",                newNotes: "1:1 value copy (>=0.5 threshold)." },

    { legacyIndex: 35, legacyName: "OSC2Saw",            legacyMethod: "processOsc2Saw",                newId: "Osc2SawWave",       newMethod: "processOsc2Saw",                  newNotes: "1:1 value copy (>=0.5 threshold)." },

    { legacyIndex: 36, legacyName: "OSC2Pul",            legacyMethod: "processOsc2Pulse",              newId: "Osc2PulseWave",     newMethod: "processOsc2Pulse",                newNotes: "1:1 value copy (>=0.5 threshold)." },

    { legacyIndex: 37, legacyName: "PW",                 legacyMethod: "processPulseWidth",             newId: "OscPW",             newMethod: "processOscPW",                    newNotes: "1:1 value copy. Both: linsc(v,0,0.95)." },

    { legacyIndex: 38, legacyName: "BRIGHTNESS",         legacyMethod: "processBrightness",             newId: "OscBrightness",     newMethod: "processOscBrightness",            newNotes: "1:1 value copy. Both: linsc(v,7000,26000)." },

    { legacyIndex: 39, legacyName: "ENVPITCH",           legacyMethod: "processEnvelopeToPitch",        newId: "EnvToPitchAmount",  newMethod: "processEnvToPitchAmount",         newNotes: "RESCALE. OB-Xd: v*36 semitones. OB-Xf: v*40 semitones (the 40 compensates for envelope sustaining at 90%). Importer: EnvToPitchAmount = v*(36/40) = v*0.9." },

    // ---- index 40..50: mixer + filter ----
    { legacyIndex: 40, legacyName: "OSC1MIX",            legacyMethod: "processOsc1Mix",                newId: "Osc1Mix",           newMethod: "processOsc1Volume",               newNotes: "1:1 value copy. NOTE: streaming ID string is 'Osc1Mix' (variable name is Osc1Vol, method is processOsc1Volume). All three names differ — use the method name in C++." },

    { legacyIndex: 41, legacyName: "OSC2MIX",            legacyMethod: "processOsc2Mix",                newId: "Osc2Mix",           newMethod: "processOsc2Volume",               newNotes: "1:1 value copy. Same ID/var/method name split as OSC1MIX: ID 'Osc2Mix', var Osc2Vol, method processOsc2Volume." },

    { legacyIndex: 42, legacyName: "NOISEMIX",           legacyMethod: "processNoiseMix",               newId: "NoiseMix",          newMethod: "processNoiseVolume",              newNotes: "RESCALE. OB-Xd: logsc(v,0,1,35) applied INSIDE engine. OB-Xf expects the pre-scaled value directly. Importer: NoiseVol = logsc(v,0,1,35) (i.e. bake the logsc into the value before dispatch). Streaming ID 'NoiseMix', var NoiseVol, method processNoiseVolume." },

    { legacyIndex: 43, legacyName: "FLT_KF",             legacyMethod: "processFilterKeyFollow",        newId: "FilterKeyFollow",   newMethod: "processFilterKeyTrack",           newNotes: "1:1 value copy. NOTE: streaming ID is 'FilterKeyFollow' (variable name is FilterKeyTrack). Method is processFilterKeyTrack." },

    { legacyIndex: 44, legacyName: "CUTOFF",             legacyMethod: "processCutoff",                 newId: "FilterCutoff",      newMethod: "processFilterCutoff",             newNotes: "1:1 value copy. Both: linsc(v,0,120) into cutoff smoother." },

    { legacyIndex: 45, legacyName: "RESONANCE",          legacyMethod: "processResonance",              newId: "FilterResonance",   newMethod: "processFilterResonance",          newNotes: "1:1 value copy. Both: 0.991-logsc(1-v,0,0.991,40)." },

    { legacyIndex: 46, legacyName: "MULTIMODE",          legacyMethod: "processMultimode",              newId: "FilterMode",        newMethod: "processFilterMode",               newNotes: "1:1 value copy. Old set per-voice multimode; new sets a smoother. Same effective range." },

    { legacyIndex: 47, legacyName: "FILTER_WARM",        legacyMethod: "processOversampling",           newId: "HQMode",            newMethod: "processHQMode",                   newNotes: "RENAME + BEHAVIOR CHANGE. OB-Xd processOversampling: synth.SetOversample(v>0.5). OB-Xf processHQMode: synth.SetHQMode(v>0.5) AND calls allSoundOff() when toggled. Importer copies v directly." },

    { legacyIndex: 48, legacyName: "BANDPASS",           legacyMethod: "processBandpassSw",             newId: "Filter2PoleBPBlend",newMethod: "processFilter2PoleBPBlend",       newNotes: "1:1 value copy (>=0.5 threshold on both sides)." },

    { legacyIndex: 49, legacyName: "FOURPOLE",           legacyMethod: "processFourPole",               newId: "Filter4PoleMode",   newMethod: "processFilter4PoleMode",          newNotes: "1:1 value copy (>=0.5 threshold on both sides)." },

    { legacyIndex: 50, legacyName: "ENVELOPE_AMT",       legacyMethod: "processFilterEnvelopeAmt",      newId: "FilterEnvAmount",   newMethod: "processFilterEnvAmount",          newNotes: "1:1 value copy. Both: linsc(v,0,140)." },

    // ---- index 51..58: envelopes (loudness=Amp, filter=Filter) ----
    { legacyIndex: 51, legacyName: "LATK",               legacyMethod: "processLoudnessEnvelopeAttack", newId: "AmpEnvAttack",      newMethod: "processAmpEnvAttack",             newNotes: "RESCALE. OB-Xd: logsc(v,4,60000,900) ms. OB-Xf: logsc(v,4,60000,900) ms BUT envelope sustains at 90% in OB-Xf so attack feels ~3x faster. Importer: translateAttackTime divides by 3: msXd=logsc(v,4,60000,900); msXf=msXd/3; AmpEnvAttack=invLogsc(msXf,4,60000,900)." },

    { legacyIndex: 52, legacyName: "LDEC",               legacyMethod: "processLoudnessEnvelopeDecay",  newId: "AmpEnvDecay",       newMethod: "processAmpEnvDecay",              newNotes: "1:1 value copy. Both: logsc(v,4,60000,900). (Importer does NOT divide decay/release by 3 — only attack.)" },

    { legacyIndex: 53, legacyName: "LSUS",               legacyMethod: "processLoudnessEnvelopeSustain",newId: "AmpEnvSustain",     newMethod: "processAmpEnvSustain",            newNotes: "1:1 value copy." },

    { legacyIndex: 54, legacyName: "LREL",               legacyMethod: "processLoudnessEnvelopeRelease",newId: "AmpEnvRelease",     newMethod: "processAmpEnvRelease",            newNotes: "1:1 value copy. Both: logsc(v,8,60000,900)." },

    { legacyIndex: 55, legacyName: "FATK",               legacyMethod: "processFilterEnvelopeAttack",   newId: "FilterEnvAttack",   newMethod: "processFilterEnvAttack",          newNotes: "RESCALE. OB-Xd: logsc(v,1,60000,900) ms. OB-Xf: logsc(v,1,60000,900) ms (same range) but importer still applies /3 attack compensation: msXf=msXd/3; FilterEnvAttack=invLogsc(msXf,1,60000,900)." },

    { legacyIndex: 56, legacyName: "FDEC",               legacyMethod: "processFilterEnvelopeDecay",    newId: "FilterEnvDecay",    newMethod: "processFilterEnvDecay",           newNotes: "1:1 value copy. Both: logsc(v,1,60000,900)." },

    { legacyIndex: 57, legacyName: "FSUS",               legacyMethod: "processFilterEnvelopeSustain",  newId: "FilterEnvSustain",  newMethod: "processFilterEnvSustain",         newNotes: "1:1 value copy." },

    { legacyIndex: 58, legacyName: "FREL",               legacyMethod: "processFilterEnvelopeRelease",  newId: "FilterEnvRelease",  newMethod: "processFilterEnvRelease",         newNotes: "1:1 value copy. Both: logsc(v,1,60000,900)." },

    // ---- index 59..69: slop + pan ----
    { legacyIndex: 59, legacyName: "ENVDER",             legacyMethod: "processEnvelopeDetune",         newId: "EnvelopeSlop",      newMethod: "processEnvelopeSlop",             newNotes: "1:1 value copy. Old: setEnvDer(linsc(v,0,1)). New: setEnvTimingOffset(v) (already 0..1)." },

    { legacyIndex: 60, legacyName: "FILTERDER",          legacyMethod: "processFilterDetune",           newId: "FilterSlop",        newMethod: "processFilterSlop",               newNotes: "1:1 value copy. Both: linsc(v,0,18)." },

    { legacyIndex: 61, legacyName: "PORTADER",           legacyMethod: "processPortamentoDetune",       newId: "PortamentoSlop",    newMethod: "processPortamentoSlop",           newNotes: "1:1 value copy. Both: linsc(v,0,0.75)." },

    { legacyIndex: 62, legacyName: "PAN1",               legacyMethod: "processPan",                    newId: "PanVoice1",         newMethod: "processPan",                      newNotes: "1:1 value copy. Call as processPan(v, 1). Method signature unchanged." },
    { legacyIndex: 63, legacyName: "PAN2",               legacyMethod: "processPan",                    newId: "PanVoice2",         newMethod: "processPan",                      newNotes: "processPan(v, 2)." },
    { legacyIndex: 64, legacyName: "PAN3",               legacyMethod: "processPan",                    newId: "PanVoice3",         newMethod: "processPan",                      newNotes: "processPan(v, 3)." },
    { legacyIndex: 65, legacyName: "PAN4",               legacyMethod: "processPan",                    newId: "PanVoice4",         newMethod: "processPan",                      newNotes: "processPan(v, 4)." },
    { legacyIndex: 66, legacyName: "PAN5",               legacyMethod: "processPan",                    newId: "PanVoice5",         newMethod: "processPan",                      newNotes: "processPan(v, 5). NOTE: OB-Xd MAX_VOICES=8 so PAN5..PAN8 were rarely heard; OB-Xf MAX_PANNINGS may differ — verify the engine accepts idx 5..8." },
    { legacyIndex: 67, legacyName: "PAN6",               legacyMethod: "processPan",                    newId: "PanVoice6",         newMethod: "processPan",                      newNotes: "processPan(v, 6)." },
    { legacyIndex: 68, legacyName: "PAN7",               legacyMethod: "processPan",                    newId: "PanVoice7",         newMethod: "processPan",                      newNotes: "processPan(v, 7)." },
    { legacyIndex: 69, legacyName: "PAN8",               legacyMethod: "processPan",                    newId: "PanVoice8",         newMethod: "processPan",                      newNotes: "processPan(v, 8)." },

    // ---- index 70..79: UI toggles + extended params ----
    { legacyIndex: 70, legacyName: "UNLEARN",            legacyMethod: "(UI-only)",                     newId: "",                  newMethod: null,                              newNotes: "REMOVED — UI-only in OB-Xd, no engine action, no OB-Xf equivalent." },

    { legacyIndex: 71, legacyName: "ECONOMY_MODE",       legacyMethod: "procEconomyMode",               newId: "",                  newMethod: null,                              newNotes: "REMOVED — OB-Xf has no economy/CPU-saving mode toggle. (HQMode is the closest spiritual successor but maps from FILTER_WARM, not this.) Drop the case." },

    { legacyIndex: 72, legacyName: "LFO_SYNC",           legacyMethod: "procLfoSync",                   newId: "LFO1TempoSync",     newMethod: "processLFO1Sync",                 newNotes: "1:1 value copy (>=0.5 threshold on both sides). NOTE: method is processLFO1Sync (no 'Tempo'), ID is 'LFO1TempoSync'. Importer warns OB-Xd sync was unreliable; OB-Xf syncs correctly so the patch may sound different." },

    { legacyIndex: 73, legacyName: "PW_ENV",             legacyMethod: "processPwEnv",                  newId: "EnvToPWAmount",     newMethod: "processEnvToPWAmount",            newNotes: "RESCALE. OB-Xd: linsc(v,0,0.85). OB-Xf: linsc(v,0,1.055555555). Importer: EnvToPWAmount = v*(0.85/1.055555555)." },

    { legacyIndex: 74, legacyName: "PW_ENV_BOTH",        legacyMethod: "processPwEnvBoth",              newId: "EnvToPWBothOscs",   newMethod: "processEnvToPWBothOscs",          newNotes: "1:1 value copy (>=0.5 threshold on both sides)." },

    { legacyIndex: 75, legacyName: "ENV_PITCH_BOTH",     legacyMethod: "processPitchModBoth",           newId: "EnvToPitchBothOscs",newMethod: "processPitchBothOscs",            newNotes: "1:1 value copy (>=0.5 threshold). METHOD NAME MISMATCH: ID is 'EnvToPitchBothOscs' but the SynthEngine method is processPitchBothOscs (no 'EnvTo'). Do not look for processEnvToPitchBothOscs — it does not exist." },

    { legacyIndex: 76, legacyName: "FENV_INVERT",        legacyMethod: "processInvertFenv",             newId: "FilterEnvInvert",   newMethod: "processFilterEnvInvert",          newNotes: "1:1 value copy (>=0.5 threshold on both sides)." },

    { legacyIndex: 77, legacyName: "PW_OSC2_OFS",        legacyMethod: "processPwOfs",                  newId: "Osc2PWOffset",      newMethod: "processOsc2PWOffset",             newNotes: "RESCALE. OB-Xd: linsc(v,0,0.75). OB-Xf: linsc(v,0,0.95). Importer: Osc2PWOffset = v*(0.75/0.95)." },

    { legacyIndex: 78, legacyName: "LEVEL_DIF",          legacyMethod: "processLoudnessDetune",         newId: "LevelSlop",         newMethod: "processLevelSlop",                newNotes: "1:1 value copy. Both: linsc(v,0,0.67)." },

    { legacyIndex: 79, legacyName: "SELF_OSC_PUSH",      legacyMethod: "processSelfOscPush",            newId: "Filter2PolePush",   newMethod: "processFilter2PolePush",          newNotes: "1:1 value copy (>=0.5 threshold on both sides). RENAMED: old pushed per-voice selfOscPush; new calls setFilter2PolePush." },
];

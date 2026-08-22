// ===========================================================================
// param-spec.mjs — the AUTHORITATIVE OB-Xd(legacy) → OB-Xf parameter spec.
//
// This module replaces four duplicated sources of truth:
//   (1) the big switch `dispatch_legacy_param` in wasm/obxd/main_obxd.cpp
//   (2) the named-attribute chain `apply_named_param_instance` in the same file
//   (3) the hand table wasm/obxd/obxf_param_mappings.h
//   (4) the auto-documented mirror src/obxf-param-mappings.ts
// A later generator task consumes THIS module to emit those outputs.
//
// Authority chain:
//   - obxf_imported/state/ObxdImporter.cpp (translateProgramFromXml) is
//     canonical for the LEGACY→NATIVE math (rescales, splits, /3 attack
//     compensation, logsc bakes).
//   - wasm/obxd/main_obxd.cpp is the current runtime implementation the math
//     was transcribed from (xdLogsc/xdInvLinsc/xdInvLogsc/mapLfoSyncedRate/
//     lfoBoolToBlend/lfoBoolToTriState + dispatch_legacy_param).
//   - THIS spec becomes the source of truth going forward.
//
// Pure data + constants + self-check. No side effects at import time, no
// dependencies. Verify with:
//   node -e "import('./tools/param-spec.mjs').then(m => console.log(m.validateSpec()))"
// (must print []).
// ===========================================================================

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PARAM_COUNT = 80;          // legacy OB-Xd indices 0..79 (ParamsEnum.h, frozen)
export const NEW_PARAM_BASE = 200;      // sentinel base for OB-Xf-only params (idx = 200 + ordinal)
export const NEW_PARAM_COUNT = 28;      // OB-Xf streaming params with no legacy ancestor
export const BENDRANGE_LEGACY_INDEX = 6; // BENDRANGE splits to PitchBendUp + PitchBendDown

// ---------------------------------------------------------------------------
// Transform vocabulary — CLOSED SET. Nothing outside TRANSFORM_KINDS may
// appear as a transform or invert `kind`. See tools/PARAM_SPEC.md for the
// math of each kind in words, and for invert (representative-inverse) rules.
//
// Common descriptor fields (per kind):
//   IDENTITY           {} — value passes through unchanged.
//   MUL                { factor } — native = v * factor.
//   SPLIT_BENDRANGE    { threshold, semitonesHigh, semitonesLow, maxBendRange,
//                        secondaryNewId, secondaryMethod }
//                        native = (v > threshold ? semitonesHigh : semitonesLow)
//                                 / maxBendRange, written to BOTH methods.
//   VOICE_COUNT        {} — old round(v*7)+1 clamped 1..8 voices →
//                        native = (voices - 1 + 0.5) / 32.
//   OCTAVE_TRANSPOSE   {} — transpose = clamp(round(v*4)+1, 0..4) →
//                        native = transpose * 0.25.
//   LOGSC_INVLOGSC     { xd: {lo,hi,rolloff}, xf: {lo,hi,rolloff,curve},
//                        preDivisor? }
//                        native = unmap( xdLogsc(v, xd), xf ) where unmap is
//                        xdInvLogsc (curve 'log', default), xdInvLinsc
//                        (curve 'lin'), or pass-through (curve 'identity' —
//                        the logsc result is BAKED into the native value,
//                        used by NOISEMIX). preDivisor divides the xd-domain
//                        value BEFORE the xf unmap (attack-time /3
//                        compensation: LATK, FATK).
//   BOOL_BLEND         {} — native = v >= 0.5 ? 0 : 0.5   (LFO wave bool → blend).
//   BOOL_TRISTATE      {} — native = v >= 0.5 ? 0.5 : 0   (LFO dest bool → tri-state).
//   NOTEPRIORITY       {} — native = v > 0.5 ? 0 : 0.5    (STRICT >, unlike BOOL_*).
//   PAN                { voiceIndex } — value identity; processPan(v, voiceIndex).
//   LFO1_RATE          { free: {xd,xf}, synced: {table, sourceBuckets, denom},
//                        syncMirrorLegacyIndex } — specialInline: sync-aware;
//                        see PARAM_SPEC.md. C keeps handling it inline.
//   LFO1_SYNC          { redispatchLegacyIndex } — specialInline: sets sync
//                        then re-dispatches LFOFREQ from the mirror.
// ---------------------------------------------------------------------------

export const TRANSFORM_KINDS = Object.freeze([
    'IDENTITY',
    'MUL',
    'SPLIT_BENDRANGE',
    'VOICE_COUNT',
    'OCTAVE_TRANSPOSE',
    'LOGSC_INVLOGSC',
    'BOOL_BLEND',
    'BOOL_TRISTATE',
    'NOTEPRIORITY',
    'PAN',
    'LFO1_RATE',
    'LFO1_SYNC',
]);

// curve values allowed inside LOGSC_INVLOGSC.xf.curve
const XF_CURVES = Object.freeze(['log', 'lin', 'identity']);

// Frozen snapshot of every processX-style method declared in
// wasm/obxd/obxf_imported/engine/SynthEngine.h (regenerate with:
//   rg -o '\bprocess[A-Za-z0-9_]+' wasm/obxd/obxf_imported/engine/SynthEngine.h | sort -u
// ). Used by validateSpec() to assert method names are real.
// Note: processPan takes an extra voice argument — processPan(v, idx).
const SYNTH_ENGINE_METHODS = Object.freeze(new Set([
    'processAmpEnvAttack', 'processAmpEnvAttackCurve', 'processAmpEnvDecay',
    'processAmpEnvRelease', 'processAmpEnvSustain', 'processBendDownRange',
    'processBendOsc2Only', 'processBendUpRange', 'processCrossmod',
    'processEnvelopeSlop', 'processEnvLegatoMode', 'processEnvToPitchAmount',
    'processEnvToPitchInvert', 'processEnvToPWAmount', 'processEnvToPWBothOscs',
    'processEnvToPWInvert', 'processFilter2PoleBPBlend', 'processFilter2PolePush',
    'processFilter4PoleMode', 'processFilter4PoleXpander', 'processFilterCutoff',
    'processFilterEnvAmount', 'processFilterEnvAttack', 'processFilterEnvAttackCurve',
    'processFilterEnvDecay', 'processFilterEnvInvert', 'processFilterEnvRelease',
    'processFilterEnvSustain', 'processFilterKeyTrack', 'processFilterMode',
    'processFilterResonance', 'processFilterSlop', 'processFilterXpanderMode',
    'processHQMode', 'processLevelSlop', 'processLFO1ModAmount1',
    'processLFO1ModAmount2', 'processLFO1PW', 'processLFO1Rate', 'processLFO1Sync',
    'processLFO1ToFilterCutoff', 'processLFO1ToOsc1Pitch', 'processLFO1ToOsc1PW',
    'processLFO1ToOsc2Pitch', 'processLFO1ToOsc2PW', 'processLFO1ToVolume',
    'processLFO1Wave1', 'processLFO1Wave2', 'processLFO1Wave3',
    'processLFO2ModAmount1', 'processLFO2ModAmount2', 'processLFO2PW',
    'processLFO2Rate', 'processLFO2Sync', 'processLFO2ToFilterCutoff',
    'processLFO2ToOsc1Pitch', 'processLFO2ToOsc1PW', 'processLFO2ToOsc2Pitch',
    'processLFO2ToOsc2PW', 'processLFO2ToVolume', 'processLFO2Wave1',
    'processLFO2Wave2', 'processLFO2Wave3', 'processModWheel',
    'processModWheelSmoothed', 'processMPEChannelPressure', 'processMPEPitch',
    'processMPETimbre', 'processNoiseColor', 'processNoiseVolume',
    'processNoteOff', 'processNoteOn', 'processNotePriority', 'processOsc1Pitch',
    'processOsc1Pulse', 'processOsc1Saw', 'processOsc1Volume', 'processOsc2Detune',
    'processOsc2Keytrack', 'processOsc2Pitch', 'processOsc2Pulse',
    'processOsc2PWOffset', 'processOsc2Saw', 'processOsc2Volume',
    'processOscBrightness', 'processOscPW', 'processOscSync', 'processPan',
    'processPitchBothOscs', 'processPitchWheel', 'processPolyphony',
    'processPortamento', 'processPortamentoSlop', 'processRingModVolume',
    'processSample', 'processTranspose', 'processTune', 'processUnison',
    'processUnisonDetune', 'processUnisonVoices', 'processVelToAmpEnv',
    'processVelToFilterEnv', 'processVibratoLFORate', 'processVibratoLFOWave',
    'processVoiceReassign', 'processVolume',
]));

// ---------------------------------------------------------------------------
// Shared transform descriptors (constants transcribed VERBATIM from
// main_obxd.cpp dispatch_legacy_param / ObxdImporter.cpp).
// ---------------------------------------------------------------------------

const T_IDENTITY = Object.freeze({ kind: 'IDENTITY' });

// BENDRANGE split (legacy 6): v > 0.5 ? 12 : 2 semitones; n = range/48 written
// to BOTH processBendUpRange and processBendDownRange.
const T_SPLIT_BENDRANGE = Object.freeze({
    kind: 'SPLIT_BENDRANGE',
    threshold: 0.5,
    semitonesHigh: 12,
    semitonesLow: 2,
    maxBendRange: 48,               // configuration.h constexpr MAX_BEND_RANGE
    secondaryNewId: 'PitchBendDown',
    secondaryMethod: 'processBendDownRange',
});

// LFOFREQ (legacy 17) — specialInline. Free path: hzXd = logsc(v,0,50,120);
// native = invLogsc(hzXd, 0, 250, 3775). Synced path (when the LFO_SYNC mirror
// > 0.5): bucket table xdToXf[9] → native = xdToXf[clamp(int(v*8),0,8)] / 20.
const T_LFO1_RATE = Object.freeze({
    kind: 'LFO1_RATE',
    free: Object.freeze({
        xd: Object.freeze({ lo: 0, hi: 50, rolloff: 120 }),
        xf: Object.freeze({ lo: 0, hi: 250, rolloff: 3775, curve: 'log' }),
    }),
    synced: Object.freeze({
        table: Object.freeze([1, 4, 5, 7, 10, 11, 13, 15, 16]),
        sourceBuckets: 9,           // int(v * 8) clamped to 0..8
        denom: 20,                  // syncedRatesCount - 1
    }),
    syncMirrorLegacyIndex: 72,      // LFO_SYNC
});

// LFO_SYNC (legacy 72) — specialInline: processLFO1Sync(v), then re-dispatch
// LFOFREQ from the mirror (legacy .fxp loads params sequentially 0..79).
const T_LFO1_SYNC = Object.freeze({
    kind: 'LFO1_SYNC',
    redispatchLegacyIndex: 17,      // LFOFREQ
});

// ---------------------------------------------------------------------------
// The spec — one entry per legacy param 0..79 (80 rows; BENDRANGE is ONE row
// whose transform writes both bend-range halves — hence 80, not 81).
//
// Fields:
//   legacyIndex     0..79 (ParamsEnum.h order, frozen)
//   legacyName      ParamsEnum.h identifier (documentation)
//   legacyMethod    OLD OB-Xd engine method (documentation only, from the .h table)
//   newId           OB-Xf SynthParam::ID streaming name; '' = removed / no-op
//   method          actual SynthEngine processX method; '' for removed.
//                   (processPan takes an extra voiceIndex argument.)
//   transform       descriptor from TRANSFORM_KINDS (legacy 0..1 → native 0..1)
//   invert          descriptor mapping NATIVE 0..1 → LEGACY 0..1 (exact inverse
//                   for MUL/LOGSC_INVLOGSC/IDENTITY/PAN; canonical
//                   representative for many-to-one kinds), or null for
//                   removed rows and the two specialInline rows.
//   specialInline   true for LFOFREQ(17)/LFO_SYNC(72): the C code keeps
//                   handling them inline (mirror reads / re-dispatch).
//   drumClass       'none' | 'global' | 'smoother' | 'voice' — see PARAM_SPEC.md
//   drumRestoreSkip true exactly for the worklet DRUM_STRUCTURAL_SKIP set
//   notes           short documentation string
// ---------------------------------------------------------------------------

export const paramSpec = [
    // -- 0..9 ---------------------------------------------------------------
    {
        legacyIndex: 0, legacyName: 'UNDEFINED', legacyMethod: '',
        newId: '', method: '',
        transform: T_IDENTITY, invert: null, specialInline: false,
        drumClass: 'none', drumRestoreSkip: false,
        notes: 'Sentinel / no-op. C is_global_drum_param() also lists it (harmless either way).',
    },
    {
        legacyIndex: 1, legacyName: 'MIDILEARN', legacyMethod: '(UI-only)',
        newId: '', method: '',
        transform: T_IDENTITY, invert: null, specialInline: false,
        drumClass: 'none', drumRestoreSkip: false,
        notes: 'REMOVED: UI-only, no engine action, no OB-Xf equivalent. C is_global_drum_param() also lists it (no-op either way).',
    },
    {
        legacyIndex: 2, legacyName: 'VOLUME', legacyMethod: 'processVolume',
        newId: 'Volume', method: 'processVolume',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: '1:1; both engines linsc(v,0,0.30) internally. Sets synth-global volume.',
    },
    {
        legacyIndex: 3, legacyName: 'VOICE_COUNT', legacyMethod: 'setVoiceCount',
        newId: 'Polyphony', method: 'processPolyphony',
        transform: { kind: 'VOICE_COUNT' },
        invert: { kind: 'VOICE_COUNT' },
        specialInline: false,
        drumClass: 'global', drumRestoreSkip: true,
        notes: 'RESCALE: old 1..8 voices → new polyphony midpoint (voices-1+0.5)/32. Invert (representative): voices=clamp(round(n*32),1,8) → legacy=(voices-1)/7. drumRestoreSkip: initDrumMode owns drum polyphony.',
    },
    {
        legacyIndex: 4, legacyName: 'TUNE', legacyMethod: 'processTune',
        newId: 'Tune', method: 'processTune',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: '1:1; both engines v*2-1 internally.',
    },
    {
        legacyIndex: 5, legacyName: 'OCTAVE', legacyMethod: 'processOctave',
        newId: 'Transpose', method: 'processTranspose',
        transform: { kind: 'OCTAVE_TRANSPOSE' },
        invert: { kind: 'OCTAVE_TRANSPOSE' },
        specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: 'SEMANTIC SHIFT: old (round(v*4)-2)*12 st; new round((v*2-1)*24) st. Importer: transpose=clamp(round(v*4)+1,0..4)*0.25. Invert (representative): transpose=round(n*4) → legacy=clamp((transpose-1)/4,0,1).',
    },
    {
        legacyIndex: 6, legacyName: 'BENDRANGE', legacyMethod: 'procPitchWheelAmount',
        newId: 'PitchBendUp', method: 'processBendUpRange',
        transform: T_SPLIT_BENDRANGE,
        invert: T_SPLIT_BENDRANGE,
        specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: 'SPLIT — ONE spec row covering BOTH halves: n=(v>0.5?12:2)/48 written to processBendUpRange AND processBendDownRange (transform.secondaryNewId=PitchBendDown, secondaryMethod=processBendDownRange) with the SAME value. Legacy rows total 80, not 81. Invert (representative): range=round(n*48) → legacy = range>7 ? 1 : 0.',
    },
    {
        legacyIndex: 7, legacyName: 'BENDOSC2', legacyMethod: 'procPitchWheelOsc2Only',
        newId: 'BendOsc2Only', method: 'processBendOsc2Only',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: '1:1; >=0.5 threshold inside both engines.',
    },
    {
        legacyIndex: 8, legacyName: 'LEGATOMODE', legacyMethod: 'processLegatoMode',
        newId: 'EnvLegatoMode', method: 'processEnvLegatoMode',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: 'Importer copies 1:1 (quantization happens in the engine). Same 4 modes (Both/Filter/Amp/Retrigger); bucket boundaries differ at v=0.5.',
    },
    {
        legacyIndex: 9, legacyName: 'BENDLFORATE', legacyMethod: 'procModWheelFrequency',
        newId: 'VibratoRate', method: 'processVibratoLFORate',
        transform: {
            kind: 'LOGSC_INVLOGSC',
            xd: { lo: 3, hi: 10, rolloff: 19 },      // default rolloff (helper default)
            xf: { lo: 2, hi: 12, rolloff: 0, curve: 'lin' }, // invLinsc
        },
        invert: {
            kind: 'LOGSC_INVLOGSC',
            xd: { lo: 3, hi: 10, rolloff: 19 },
            xf: { lo: 2, hi: 12, rolloff: 0, curve: 'lin' },
        },
        specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: 'RESCALE+RENAME: hzXd=logsc(v,3,10); native=invLinsc(hzXd,2,12). xf curve is LIN, not log. Invert (exact): hz=linsc(n,2,12) → legacy=invLogsc(hz,3,10,19).',
    },

    // -- 10..19 -------------------------------------------------------------
    {
        legacyIndex: 10, legacyName: 'VFLTENV', legacyMethod: 'procFltVelocityAmount',
        newId: 'VelToFilterEnv', method: 'processVelToFilterEnv',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1.',
    },
    {
        legacyIndex: 11, legacyName: 'VAMPENV', legacyMethod: 'procAmpVelocityAmount',
        newId: 'VelToAmpEnv', method: 'processVelToAmpEnv',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1.',
    },
    {
        legacyIndex: 12, legacyName: 'ASPLAYEDALLOCATION', legacyMethod: 'procAsPlayedAlloc',
        newId: 'NotePriority', method: 'processNotePriority',
        transform: { kind: 'NOTEPRIORITY' },
        invert: { kind: 'NOTEPRIORITY' },
        specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: 'BOOL→TRI: native = v>0.5 ? 0 : 0.5 (STRICT >). High state (1.0) has no ancestor. Invert (representative): legacy = n>0.25 ? 0 : 1.',
    },
    {
        legacyIndex: 13, legacyName: 'PORTAMENTO', legacyMethod: 'processPortamento',
        newId: 'Portamento', method: 'processPortamento',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: '1:1; both engines logsc(1-v,0.14,250,150) internally.',
    },
    {
        legacyIndex: 14, legacyName: 'UNISON', legacyMethod: 'processUnison',
        newId: 'Unison', method: 'processUnison',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: '1:1; >=0.5 threshold.',
    },
    {
        legacyIndex: 15, legacyName: 'UDET', legacyMethod: 'processDetune',
        newId: 'UnisonDetune', method: 'processUnisonDetune',
        transform: {
            kind: 'LOGSC_INVLOGSC',
            xd: { lo: 0.001, hi: 0.90, rolloff: 19 },
            xf: { lo: 0.001, hi: 1.0, rolloff: 19, curve: 'log' },
        },
        invert: {
            kind: 'LOGSC_INVLOGSC',
            xd: { lo: 0.001, hi: 0.90, rolloff: 19 },
            xf: { lo: 0.001, hi: 1.0, rolloff: 19, curve: 'log' },
        },
        specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: 'RESCALE: dXd=logsc(v,0.001,0.90); native=invLogsc(dXd,0.001,1.0). Invert (exact): d=logsc(n,0.001,1.0) → legacy=invLogsc(d,0.001,0.90).',
    },
    {
        legacyIndex: 16, legacyName: 'OSC2_DET', legacyMethod: 'processOsc2Det',
        newId: 'Osc2Detune', method: 'processOsc2Detune',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; both engines logsc(v,0.001,0.6) internally.',
    },
    {
        legacyIndex: 17, legacyName: 'LFOFREQ', legacyMethod: 'processLfoFrequency',
        newId: 'LFO1Rate', method: 'processLFO1Rate',
        transform: T_LFO1_RATE,
        invert: null,                   // specialInline — sync-aware, mirror-dependent
        specialInline: true,
        drumClass: 'global', drumRestoreSkip: false,
        notes: 'SPECIAL INLINE: free path logsc(v,0,50,120)→invLogsc(·,0,250,3775) (~75x range shift); synced path (LFO_SYNC mirror>0.5) 9→21 bucket table. Reads instance mirror → stays inline in C before AND after the refactor. Sets synth.globalLFO (shared LFO1) → drumClass global.',
    },
    {
        legacyIndex: 18, legacyName: 'LFOSINWAVE', legacyMethod: 'processLfoSine',
        newId: 'LFO1Wave1', method: 'processLFO1Wave1',
        transform: { kind: 'BOOL_BLEND' },
        invert: { kind: 'BOOL_BLEND' },
        specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: 'BOOL→BLEND: native = v>=0.5 ? 0 : 0.5 (Sine/Triangle). Shared globalLFO → drumClass global. Invert (representative): legacy = n<0.25 ? 1 : 0.',
    },
    {
        legacyIndex: 19, legacyName: 'LFOSQUAREWAVE', legacyMethod: 'processLfoSquare',
        newId: 'LFO1Wave2', method: 'processLFO1Wave2',
        transform: { kind: 'BOOL_BLEND' },
        invert: { kind: 'BOOL_BLEND' },
        specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: 'BOOL→BLEND, same transform (Pulse/Saw). Invert (representative): legacy = n<0.25 ? 1 : 0.',
    },

    // -- 20..29 -------------------------------------------------------------
    {
        legacyIndex: 20, legacyName: 'LFOSHWAVE', legacyMethod: 'processLfoSH',
        newId: 'LFO1Wave3', method: 'processLFO1Wave3',
        transform: { kind: 'BOOL_BLEND' },
        invert: { kind: 'BOOL_BLEND' },
        specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: 'BOOL→BLEND, same transform (S&H/S&G). Invert (representative): legacy = n<0.25 ? 1 : 0.',
    },
    {
        legacyIndex: 21, legacyName: 'LFO1AMT', legacyMethod: 'processLfoAmt1',
        newId: 'LFO1ModAmount1', method: 'processLFO1ModAmount1',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; both engines logsc(logsc(v,0,1,60),0,60,10) internally.',
    },
    {
        legacyIndex: 22, legacyName: 'LFO2AMT', legacyMethod: 'processLfoAmt2',
        newId: 'LFO1ModAmount2', method: 'processLFO1ModAmount2',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: 'AMBIGUOUS NAME: old LFO2AMT is LFO1 second mod amount, NOT LFO2. 1:1; both engines linsc(v,0,0.7).',
    },
    {
        legacyIndex: 23, legacyName: 'LFOOSC1', legacyMethod: 'processLfoOsc1',
        newId: 'LFO1ToOsc1Pitch', method: 'processLFO1ToOsc1Pitch',
        transform: { kind: 'BOOL_TRISTATE' },
        invert: { kind: 'BOOL_TRISTATE' },
        specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: 'BOOL→TRI {Off,On,Inv}=0/0.5/1: native = v>=0.5 ? 0.5 : 0. Inv state has no ancestor. Invert (representative): legacy = n>=0.25 ? 1 : 0.',
    },
    {
        legacyIndex: 24, legacyName: 'LFOOSC2', legacyMethod: 'processLfoOsc2',
        newId: 'LFO1ToOsc2Pitch', method: 'processLFO1ToOsc2Pitch',
        transform: { kind: 'BOOL_TRISTATE' },
        invert: { kind: 'BOOL_TRISTATE' },
        specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: 'BOOL→TRI, same transform. Invert (representative): legacy = n>=0.25 ? 1 : 0.',
    },
    {
        legacyIndex: 25, legacyName: 'LFOFILTER', legacyMethod: 'processLfoFilter',
        newId: 'LFO1ToFilterCutoff', method: 'processLFO1ToFilterCutoff',
        transform: { kind: 'BOOL_TRISTATE' },
        invert: { kind: 'BOOL_TRISTATE' },
        specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: 'BOOL→TRI, same transform. Invert (representative): legacy = n>=0.25 ? 1 : 0.',
    },
    {
        legacyIndex: 26, legacyName: 'LFOPW1', legacyMethod: 'processLfoPw1',
        newId: 'LFO1ToOsc1PW', method: 'processLFO1ToOsc1PW',
        transform: { kind: 'BOOL_TRISTATE' },
        invert: { kind: 'BOOL_TRISTATE' },
        specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: 'BOOL→TRI, same transform. Invert (representative): legacy = n>=0.25 ? 1 : 0.',
    },
    {
        legacyIndex: 27, legacyName: 'LFOPW2', legacyMethod: 'processLfoPw2',
        newId: 'LFO1ToOsc2PW', method: 'processLFO1ToOsc2PW',
        transform: { kind: 'BOOL_TRISTATE' },
        invert: { kind: 'BOOL_TRISTATE' },
        specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: 'BOOL→TRI, same transform. NOT LFO2 — LFO1→Osc2PW. Invert (representative): legacy = n>=0.25 ? 1 : 0.',
    },
    {
        legacyIndex: 28, legacyName: 'OSC2HS', legacyMethod: 'processOsc2HardSync',
        newId: 'OscSync', method: 'processOscSync',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; >=0.5 threshold.',
    },
    {
        legacyIndex: 29, legacyName: 'XMOD', legacyMethod: 'processOsc2Xmod',
        newId: 'OscCrossmod', method: 'processCrossmod',
        transform: { kind: 'MUL', factor: 0.5 },
        invert: { kind: 'MUL', factor: 2 },
        specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: 'RESCALE: old v*24 st, new v*48 st → native = v*0.5. Invert (exact): legacy = n*2.',
    },

    // -- 30..39 -------------------------------------------------------------
    {
        legacyIndex: 30, legacyName: 'OSC1P', legacyMethod: 'processOsc1Pitch',
        newId: 'Osc1Pitch', method: 'processOsc1Pitch',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; both engines v*48 st. Importer additionally has an OCTAVE-compensation branch at .fxp import time (runtime dispatch is 1:1).',
    },
    {
        legacyIndex: 31, legacyName: 'OSC2P', legacyMethod: 'processOsc2Pitch',
        newId: 'Osc2Pitch', method: 'processOsc2Pitch',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; both engines v*48 st. Same importer-side OCTAVE-compensation note as OSC1P.',
    },
    {
        legacyIndex: 32, legacyName: 'OSCQuantize', legacyMethod: 'processPitchQuantization',
        newId: '', method: '',
        transform: T_IDENTITY, invert: null, specialInline: false,
        drumClass: 'none', drumRestoreSkip: false,
        notes: 'REMOVED: no runtime param in OB-Xf. Importer only READS it to round osc pitches at import time.',
    },
    {
        legacyIndex: 33, legacyName: 'OSC1Saw', legacyMethod: 'processOsc1Saw',
        newId: 'Osc1SawWave', method: 'processOsc1Saw',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; >=0.5 threshold.',
    },
    {
        legacyIndex: 34, legacyName: 'OSC1Pul', legacyMethod: 'processOsc1Pulse',
        newId: 'Osc1PulseWave', method: 'processOsc1Pulse',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; >=0.5 threshold.',
    },
    {
        legacyIndex: 35, legacyName: 'OSC2Saw', legacyMethod: 'processOsc2Saw',
        newId: 'Osc2SawWave', method: 'processOsc2Saw',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; >=0.5 threshold.',
    },
    {
        legacyIndex: 36, legacyName: 'OSC2Pul', legacyMethod: 'processOsc2Pulse',
        newId: 'Osc2PulseWave', method: 'processOsc2Pulse',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; >=0.5 threshold.',
    },
    {
        legacyIndex: 37, legacyName: 'PW', legacyMethod: 'processPulseWidth',
        newId: 'OscPW', method: 'processOscPW',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; both engines linsc(v,0,0.95) internally.',
    },
    {
        legacyIndex: 38, legacyName: 'BRIGHTNESS', legacyMethod: 'processBrightness',
        newId: 'OscBrightness', method: 'processOscBrightness',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; both engines linsc(v,7000,26000) internally.',
    },
    {
        legacyIndex: 39, legacyName: 'ENVPITCH', legacyMethod: 'processEnvelopeToPitch',
        newId: 'EnvToPitchAmount', method: 'processEnvToPitchAmount',
        transform: { kind: 'MUL', factor: 36 / 40 },
        invert: { kind: 'MUL', factor: 40 / 36 },
        specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: 'RESCALE: old v*36 st, new v*40 st → native = v*(36/40) = v*0.9. Invert (exact): legacy = n*(40/36).',
    },

    // -- 40..49 -------------------------------------------------------------
    {
        legacyIndex: 40, legacyName: 'OSC1MIX', legacyMethod: 'processOsc1Mix',
        newId: 'Osc1Mix', method: 'processOsc1Volume',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: true,
        notes: '1:1. THREE names differ: ID string Osc1Mix, C++ ID constant Osc1Vol, method processOsc1Volume. drumRestoreSkip: initDrumMode silences oscillators for PCM voices.',
    },
    {
        legacyIndex: 41, legacyName: 'OSC2MIX', legacyMethod: 'processOsc2Mix',
        newId: 'Osc2Mix', method: 'processOsc2Volume',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: true,
        notes: '1:1. Same three-name split as OSC1MIX (Osc2Mix / Osc2Vol / processOsc2Volume). drumRestoreSkip: initDrumMode silences oscillators.',
    },
    {
        legacyIndex: 42, legacyName: 'NOISEMIX', legacyMethod: 'processNoiseMix',
        newId: 'NoiseMix', method: 'processNoiseVolume',
        transform: {
            kind: 'LOGSC_INVLOGSC',
            xd: { lo: 0, hi: 1, rolloff: 35 },
            xf: { lo: 0, hi: 1, rolloff: 35, curve: 'identity' }, // logsc BAKED into the value
        },
        invert: {
            kind: 'LOGSC_INVLOGSC',
            xd: { lo: 0, hi: 1, rolloff: 35 },
            xf: { lo: 0, hi: 1, rolloff: 35, curve: 'identity' },
        },
        specialInline: false,
        drumClass: 'voice', drumRestoreSkip: true,
        notes: 'LOGSC BAKE: old engine applied logsc(v,0,1,35) INTERNALLY; OB-Xf takes the pre-scaled value → native = logsc(v,0,1,35), xf curve identity (no unmap). Invert (exact): legacy = invLogsc(n,0,1,35). ID NoiseMix (C++ constant NoiseVol), method processNoiseVolume. drumRestoreSkip: noise floor owned by drum init.',
    },
    {
        legacyIndex: 43, legacyName: 'FLT_KF', legacyMethod: 'processFilterKeyFollow',
        newId: 'FilterKeyFollow', method: 'processFilterKeyTrack',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1. Names differ: ID FilterKeyFollow (C++ constant FilterKeyTrack), method processFilterKeyTrack.',
    },
    {
        legacyIndex: 44, legacyName: 'CUTOFF', legacyMethod: 'processCutoff',
        newId: 'FilterCutoff', method: 'processFilterCutoff',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'smoother', drumRestoreSkip: false,
        notes: '1:1; both engines linsc(v,0,120) into the cutoff smoother. drumClass smoother: processX writes the synth-GLOBAL cutoffSmoother — drum layers apply it directly per triggered voice (v->par.filter.cutoff).',
    },
    {
        legacyIndex: 45, legacyName: 'RESONANCE', legacyMethod: 'processResonance',
        newId: 'FilterResonance', method: 'processFilterResonance',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'smoother', drumRestoreSkip: false,
        notes: '1:1; both engines 0.991-logsc(1-v,0,0.991,40). drumClass smoother: resSmoother is synth-global; drum layers set v->filter.setResonance directly.',
    },
    {
        legacyIndex: 46, legacyName: 'MULTIMODE', legacyMethod: 'processMultimode',
        newId: 'FilterMode', method: 'processFilterMode',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'smoother', drumRestoreSkip: false,
        notes: '1:1 (old per-voice, new smoother — same range). drumClass smoother: filterModeSmoother is synth-global; drum layers set v->filter.setMultimode directly.',
    },
    {
        legacyIndex: 47, legacyName: 'FILTER_WARM', legacyMethod: 'processOversampling',
        newId: 'HQMode', method: 'processHQMode',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: 'RENAME+BEHAVIOR: old SetOversample, new SetHQMode AND the engine calls allSoundOff() on toggle — drumClass global so per-voice application cannot cut drum voices mid-trigger.',
    },
    {
        legacyIndex: 48, legacyName: 'BANDPASS', legacyMethod: 'processBandpassSw',
        newId: 'Filter2PoleBPBlend', method: 'processFilter2PoleBPBlend',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; >=0.5 threshold.',
    },
    {
        legacyIndex: 49, legacyName: 'FOURPOLE', legacyMethod: 'processFourPole',
        newId: 'Filter4PoleMode', method: 'processFilter4PoleMode',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; >=0.5 threshold.',
    },

    // -- 50..59 -------------------------------------------------------------
    {
        legacyIndex: 50, legacyName: 'ENVELOPE_AMT', legacyMethod: 'processFilterEnvelopeAmt',
        newId: 'FilterEnvAmount', method: 'processFilterEnvAmount',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; both engines linsc(v,0,140) internally.',
    },
    {
        legacyIndex: 51, legacyName: 'LATK', legacyMethod: 'processLoudnessEnvelopeAttack',
        newId: 'AmpEnvAttack', method: 'processAmpEnvAttack',
        transform: {
            kind: 'LOGSC_INVLOGSC',
            xd: { lo: 4, hi: 60000, rolloff: 900 },
            xf: { lo: 4, hi: 60000, rolloff: 900, curve: 'log' },
            preDivisor: 3,            // OB-Xf env sustains at 90% → ~3x faster
        },
        invert: {
            kind: 'LOGSC_INVLOGSC',
            xd: { lo: 4, hi: 60000, rolloff: 900 },
            xf: { lo: 4, hi: 60000, rolloff: 900, curve: 'log' },
            preDivisor: 3,
        },
        specialInline: false,
        drumClass: 'smoother', drumRestoreSkip: true,
        notes: 'RESCALE: msXd=logsc(v,4,60000,900); native=invLogsc(msXd/3,4,60000,900) — attack /3 only (decay/release are NOT divided). Invert (exact): msXd=logsc(n,4,60000,900)*3 → legacy=invLogsc(msXd,4,60000,900). drumClass smoother AND drumRestoreSkip — the two flags are orthogonal (direct per-voice setAttack on drum layers; amp attack owned by drum init).',
    },
    {
        legacyIndex: 52, legacyName: 'LDEC', legacyMethod: 'processLoudnessEnvelopeDecay',
        newId: 'AmpEnvDecay', method: 'processAmpEnvDecay',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'smoother', drumRestoreSkip: false,
        notes: '1:1; both engines logsc(v,4,60000,900). Importer does NOT /3 decay. drumClass smoother: direct per-voice setDecay on drum layers.',
    },
    {
        legacyIndex: 53, legacyName: 'LSUS', legacyMethod: 'processLoudnessEnvelopeSustain',
        newId: 'AmpEnvSustain', method: 'processAmpEnvSustain',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'smoother', drumRestoreSkip: false,
        notes: '1:1. drumClass smoother: direct per-voice setSustain on drum layers.',
    },
    {
        legacyIndex: 54, legacyName: 'LREL', legacyMethod: 'processLoudnessEnvelopeRelease',
        newId: 'AmpEnvRelease', method: 'processAmpEnvRelease',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'smoother', drumRestoreSkip: true,
        notes: '1:1; both engines logsc(v,8,60000,900) (NOTE lo=8, unlike LATK/LDEC lo=4). drumClass smoother AND drumRestoreSkip (orthogonal): direct per-voice setRelease on drum layers; release owned by drum init.',
    },
    {
        legacyIndex: 55, legacyName: 'FATK', legacyMethod: 'processFilterEnvelopeAttack',
        newId: 'FilterEnvAttack', method: 'processFilterEnvAttack',
        transform: {
            kind: 'LOGSC_INVLOGSC',
            xd: { lo: 1, hi: 60000, rolloff: 900 },
            xf: { lo: 1, hi: 60000, rolloff: 900, curve: 'log' },
            preDivisor: 3,
        },
        invert: {
            kind: 'LOGSC_INVLOGSC',
            xd: { lo: 1, hi: 60000, rolloff: 900 },
            xf: { lo: 1, hi: 60000, rolloff: 900, curve: 'log' },
            preDivisor: 3,
        },
        specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: 'RESCALE: msXd=logsc(v,1,60000,900); native=invLogsc(msXd/3,1,60000,900) — filter attack /3 (lo=1, not 4). Invert (exact): msXd=logsc(n,1,60000,900)*3 → legacy=invLogsc(msXd,1,60000,900).',
    },
    {
        legacyIndex: 56, legacyName: 'FDEC', legacyMethod: 'processFilterEnvelopeDecay',
        newId: 'FilterEnvDecay', method: 'processFilterEnvDecay',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; both engines logsc(v,1,60000,900).',
    },
    {
        legacyIndex: 57, legacyName: 'FSUS', legacyMethod: 'processFilterEnvelopeSustain',
        newId: 'FilterEnvSustain', method: 'processFilterEnvSustain',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1.',
    },
    {
        legacyIndex: 58, legacyName: 'FREL', legacyMethod: 'processFilterEnvelopeRelease',
        newId: 'FilterEnvRelease', method: 'processFilterEnvRelease',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; both engines logsc(v,1,60000,900).',
    },
    {
        legacyIndex: 59, legacyName: 'ENVDER', legacyMethod: 'processEnvelopeDetune',
        newId: 'EnvelopeSlop', method: 'processEnvelopeSlop',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; old setEnvDer(linsc(v,0,1)) internally, new setEnvTimingOffset(v).',
    },

    // -- 60..69 -------------------------------------------------------------
    {
        legacyIndex: 60, legacyName: 'FILTERDER', legacyMethod: 'processFilterDetune',
        newId: 'FilterSlop', method: 'processFilterSlop',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; both engines linsc(v,0,18) internally.',
    },
    {
        legacyIndex: 61, legacyName: 'PORTADER', legacyMethod: 'processPortamentoDetune',
        newId: 'PortamentoSlop', method: 'processPortamentoSlop',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; both engines linsc(v,0,0.75) internally.',
    },
    {
        legacyIndex: 62, legacyName: 'PAN1', legacyMethod: 'processPan',
        newId: 'PanVoice1', method: 'processPan',
        transform: { kind: 'PAN', voiceIndex: 1 },
        invert: T_IDENTITY, specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: 'Value identity; call processPan(v, 1) — method takes an EXTRA voiceIndex argument. processPan writes synth.pannings (no ForEachVoice) → drumClass global; PCM voice panning comes from Voice::pcmPan.',
    },
    {
        legacyIndex: 63, legacyName: 'PAN2', legacyMethod: 'processPan',
        newId: 'PanVoice2', method: 'processPan',
        transform: { kind: 'PAN', voiceIndex: 2 },
        invert: T_IDENTITY, specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: 'processPan(v, 2). See PAN1.',
    },
    {
        legacyIndex: 64, legacyName: 'PAN3', legacyMethod: 'processPan',
        newId: 'PanVoice3', method: 'processPan',
        transform: { kind: 'PAN', voiceIndex: 3 },
        invert: T_IDENTITY, specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: 'processPan(v, 3). See PAN1.',
    },
    {
        legacyIndex: 65, legacyName: 'PAN4', legacyMethod: 'processPan',
        newId: 'PanVoice4', method: 'processPan',
        transform: { kind: 'PAN', voiceIndex: 4 },
        invert: T_IDENTITY, specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: 'processPan(v, 4). See PAN1.',
    },
    {
        legacyIndex: 66, legacyName: 'PAN5', legacyMethod: 'processPan',
        newId: 'PanVoice5', method: 'processPan',
        transform: { kind: 'PAN', voiceIndex: 5 },
        invert: T_IDENTITY, specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: 'processPan(v, 5). Old OB-Xd MAX_VOICES=8 so PAN5..8 were rarely used.',
    },
    {
        legacyIndex: 67, legacyName: 'PAN6', legacyMethod: 'processPan',
        newId: 'PanVoice6', method: 'processPan',
        transform: { kind: 'PAN', voiceIndex: 6 },
        invert: T_IDENTITY, specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: 'processPan(v, 6). See PAN5.',
    },
    {
        legacyIndex: 68, legacyName: 'PAN7', legacyMethod: 'processPan',
        newId: 'PanVoice7', method: 'processPan',
        transform: { kind: 'PAN', voiceIndex: 7 },
        invert: T_IDENTITY, specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: 'processPan(v, 7). See PAN5.',
    },
    {
        legacyIndex: 69, legacyName: 'PAN8', legacyMethod: 'processPan',
        newId: 'PanVoice8', method: 'processPan',
        transform: { kind: 'PAN', voiceIndex: 8 },
        invert: T_IDENTITY, specialInline: false,
        drumClass: 'global', drumRestoreSkip: false,
        notes: 'processPan(v, 8). See PAN5.',
    },

    // -- 70..79 -------------------------------------------------------------
    {
        legacyIndex: 70, legacyName: 'UNLEARN', legacyMethod: '(UI-only)',
        newId: '', method: '',
        transform: T_IDENTITY, invert: null, specialInline: false,
        drumClass: 'none', drumRestoreSkip: false,
        notes: 'REMOVED: UI-only, no engine action, no OB-Xf equivalent.',
    },
    {
        legacyIndex: 71, legacyName: 'ECONOMY_MODE', legacyMethod: 'procEconomyMode',
        newId: '', method: '',
        transform: T_IDENTITY, invert: null, specialInline: false,
        drumClass: 'none', drumRestoreSkip: false,
        notes: 'REMOVED: OB-Xf has no economy mode (HQMode is the successor but maps from FILTER_WARM).',
    },
    {
        legacyIndex: 72, legacyName: 'LFO_SYNC', legacyMethod: 'procLfoSync',
        newId: 'LFO1TempoSync', method: 'processLFO1Sync',
        transform: T_LFO1_SYNC,
        invert: null,                   // specialInline — re-dispatch side effect
        specialInline: true,
        drumClass: 'global', drumRestoreSkip: false,
        notes: 'SPECIAL INLINE: processLFO1Sync(v) (method name has no "Tempo"), then re-dispatch LFOFREQ from the mirror so a sequentially-loaded .fxp gets the right rate path. Shared globalLFO → drumClass global. Importer warns old sync behavior was unreliable.',
    },
    {
        legacyIndex: 73, legacyName: 'PW_ENV', legacyMethod: 'processPwEnv',
        newId: 'EnvToPWAmount', method: 'processEnvToPWAmount',
        transform: { kind: 'MUL', factor: 0.85 / 1.0555555555 },
        invert: { kind: 'MUL', factor: 1.0555555555 / 0.85 },
        specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: 'RESCALE: old linsc(v,0,0.85), new linsc(v,0,1.055555555) → native = v*(0.85/1.0555555555). Invert (exact): legacy = n*(1.0555555555/0.85).',
    },
    {
        legacyIndex: 74, legacyName: 'PW_ENV_BOTH', legacyMethod: 'processPwEnvBoth',
        newId: 'EnvToPWBothOscs', method: 'processEnvToPWBothOscs',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; >=0.5 threshold.',
    },
    {
        legacyIndex: 75, legacyName: 'ENV_PITCH_BOTH', legacyMethod: 'processPitchModBoth',
        newId: 'EnvToPitchBothOscs', method: 'processPitchBothOscs',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; >=0.5. METHOD MISMATCH: method is processPitchBothOscs (no "EnvTo" prefix) — NOT processEnvToPitchBothOscs.',
    },
    {
        legacyIndex: 76, legacyName: 'FENV_INVERT', legacyMethod: 'processInvertFenv',
        newId: 'FilterEnvInvert', method: 'processFilterEnvInvert',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; >=0.5 threshold.',
    },
    {
        legacyIndex: 77, legacyName: 'PW_OSC2_OFS', legacyMethod: 'processPwOfs',
        newId: 'Osc2PWOffset', method: 'processOsc2PWOffset',
        transform: { kind: 'MUL', factor: 0.75 / 0.95 },
        invert: { kind: 'MUL', factor: 0.95 / 0.75 },
        specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: 'RESCALE: old linsc(v,0,0.75), new linsc(v,0,0.95) → native = v*(0.75/0.95). Invert (exact): legacy = n*(0.95/0.75).',
    },
    {
        legacyIndex: 78, legacyName: 'LEVEL_DIF', legacyMethod: 'processLoudnessDetune',
        newId: 'LevelSlop', method: 'processLevelSlop',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; both engines linsc(v,0,0.67) internally.',
    },
    {
        legacyIndex: 79, legacyName: 'SELF_OSC_PUSH', legacyMethod: 'processSelfOscPush',
        newId: 'Filter2PolePush', method: 'processFilter2PolePush',
        transform: T_IDENTITY, invert: T_IDENTITY, specialInline: false,
        drumClass: 'voice', drumRestoreSkip: false,
        notes: '1:1; >=0.5 threshold. RENAMED: old selfOscPush, new setFilter2PolePush.',
    },

    // -----------------------------------------------------------------------
    // The 28 NEW params — OB-Xf streaming IDs with NO legacy ancestor.
    // newOrdinal = canonical index: the DECLARATION ORDER of streaming IDs in
    // obxf_imported/parameter/SynthParam.h (MASTER → GLOBAL → OSCILLATORS →
    // MIXER → CONTROL → FILTER → LFO1 → LFO2 → envelopes → slop/pan), filtered
    // to these 28. Cross-checked against ALL_SYNTH_PARAM_IDS in
    // test/obxf-dispatch-coverage.test.ts. This intentionally DIFFERS from the
    // legacy runtime sentinel order (apply_new_param_instance / new_param_names
    // in main_obxd.cpp, frozen in tools/new-param-order-v1.json for saved-state
    // migration) — the LFO2 block is ordered Wave1-3, PW, Rate, ModAmount1-2
    // here vs Rate, ModAmount1-2, Wave1-3, PW at runtime.
    //
    // drumClass: verified against the processX() bodies in
    // obxf_imported/engine/SynthEngine.h (→ Motherboard.h / Voice.h).
    // 'global' = the setter writes synth-global Motherboard state with NO
    // ForEachVoice (shared by every voice): UnisonVoices →
    // synth.setUnisonVoices → Motherboard::unisonVoiceCount, VoiceReassign →
    // synth.reallocate, VibratoWave → synth.vibratoLFO.par.*, LFO1PW →
    // synth.globalLFO.par.pw. Everything else is ForEachVoice-scoped (per-
    // voice, applied per triggered drum layer via pcmVoiceOverride) →
    // 'voice'. The verified global set is frozen in
    // DRUM_NEW_GLOBAL_ORDINALS below and enforced by validateSpec().
    // -----------------------------------------------------------------------
    { newId: 'UnisonVoices',        method: 'processUnisonVoices',    newOrdinal: 0,  drumClass: 'global', drumRestoreSkip: false, notes: 'GLOBAL. processUnisonVoices → synth.setUnisonVoices → Motherboard::unisonVoiceCount (synth-global voice-allocation field, no ForEachVoice) → drumClass global.' },
    { newId: 'VoiceReassign',       method: 'processVoiceReassign',   newOrdinal: 1,  drumClass: 'global', drumRestoreSkip: false, notes: 'GLOBAL. processVoiceReassign → synth.reallocate (Motherboard bool read by setNoteOn, no ForEachVoice) → drumClass global.' },
    { newId: 'Osc2Keytrack',        method: 'processOsc2Keytrack',    newOrdinal: 2,  drumClass: 'voice', drumRestoreSkip: false, notes: 'OSCILLATORS.' },
    { newId: 'EnvToPitchInvert',    method: 'processEnvToPitchInvert', newOrdinal: 3, drumClass: 'voice', drumRestoreSkip: false, notes: 'OSCILLATORS.' },
    { newId: 'EnvToPWInvert',       method: 'processEnvToPWInvert',   newOrdinal: 4,  drumClass: 'voice', drumRestoreSkip: false, notes: 'OSCILLATORS.' },
    { newId: 'RingModMix',          method: 'processRingModVolume',   newOrdinal: 5,  drumClass: 'voice', drumRestoreSkip: false, notes: 'MIXER. ID constant RingModVol; method processRingModVolume.' },
    { newId: 'NoiseColor',          method: 'processNoiseColor',      newOrdinal: 6,  drumClass: 'voice', drumRestoreSkip: false, notes: 'MIXER.' },
    { newId: 'VibratoWave',         method: 'processVibratoLFOWave',  newOrdinal: 7,  drumClass: 'global', drumRestoreSkip: false, notes: 'CONTROL. processVibratoLFOWave → synth.vibratoLFO.par.{wave1blend,wave2blend} (shared Motherboard LFO, no ForEachVoice) → drumClass global.' },
    { newId: 'Filter4PoleXpander',  method: 'processFilter4PoleXpander', newOrdinal: 8, drumClass: 'voice', drumRestoreSkip: false, notes: 'FILTER.' },
    { newId: 'FilterXpanderMode',   method: 'processFilterXpanderMode', newOrdinal: 9, drumClass: 'voice', drumRestoreSkip: false, notes: 'FILTER.' },
    { newId: 'LFO1PW',              method: 'processLFO1PW',          newOrdinal: 10, drumClass: 'global', drumRestoreSkip: false, notes: 'LFO1. processLFO1PW → synth.globalLFO.par.pw (shared Motherboard LFO1, no ForEachVoice) → drumClass global.' },
    { newId: 'LFO1ToVolume',        method: 'processLFO1ToVolume',    newOrdinal: 11, drumClass: 'voice', drumRestoreSkip: false, notes: 'LFO1.' },
    { newId: 'LFO2TempoSync',       method: 'processLFO2Sync',        newOrdinal: 12, drumClass: 'voice', drumRestoreSkip: false, notes: 'LFO2. Method processLFO2Sync (no "Tempo").' },
    { newId: 'LFO2Wave1',           method: 'processLFO2Wave1',       newOrdinal: 13, drumClass: 'voice', drumRestoreSkip: false, notes: 'LFO2. Declaration order puts waves before rate — differs from runtime sentinel order.' },
    { newId: 'LFO2Wave2',           method: 'processLFO2Wave2',       newOrdinal: 14, drumClass: 'voice', drumRestoreSkip: false, notes: 'LFO2.' },
    { newId: 'LFO2Wave3',           method: 'processLFO2Wave3',       newOrdinal: 15, drumClass: 'voice', drumRestoreSkip: false, notes: 'LFO2.' },
    { newId: 'LFO2PW',              method: 'processLFO2PW',          newOrdinal: 16, drumClass: 'voice', drumRestoreSkip: false, notes: 'LFO2.' },
    { newId: 'LFO2Rate',            method: 'processLFO2Rate',        newOrdinal: 17, drumClass: 'voice', drumRestoreSkip: false, notes: 'LFO2. Runtime sentinel offset was 13 — canonical ordinal 17.' },
    { newId: 'LFO2ModAmount1',      method: 'processLFO2ModAmount1',  newOrdinal: 18, drumClass: 'voice', drumRestoreSkip: false, notes: 'LFO2. Runtime sentinel offset was 14.' },
    { newId: 'LFO2ModAmount2',      method: 'processLFO2ModAmount2',  newOrdinal: 19, drumClass: 'voice', drumRestoreSkip: false, notes: 'LFO2. Runtime sentinel offset was 15.' },
    { newId: 'LFO2ToOsc1Pitch',     method: 'processLFO2ToOsc1Pitch', newOrdinal: 20, drumClass: 'voice', drumRestoreSkip: false, notes: 'LFO2.' },
    { newId: 'LFO2ToOsc2Pitch',     method: 'processLFO2ToOsc2Pitch', newOrdinal: 21, drumClass: 'voice', drumRestoreSkip: false, notes: 'LFO2.' },
    { newId: 'LFO2ToFilterCutoff',  method: 'processLFO2ToFilterCutoff', newOrdinal: 22, drumClass: 'voice', drumRestoreSkip: false, notes: 'LFO2.' },
    { newId: 'LFO2ToOsc1PW',        method: 'processLFO2ToOsc1PW',    newOrdinal: 23, drumClass: 'voice', drumRestoreSkip: false, notes: 'LFO2.' },
    { newId: 'LFO2ToOsc2PW',        method: 'processLFO2ToOsc2PW',    newOrdinal: 24, drumClass: 'voice', drumRestoreSkip: false, notes: 'LFO2.' },
    { newId: 'LFO2ToVolume',        method: 'processLFO2ToVolume',    newOrdinal: 25, drumClass: 'voice', drumRestoreSkip: false, notes: 'LFO2.' },
    { newId: 'FilterEnvAttackCurve', method: 'processFilterEnvAttackCurve', newOrdinal: 26, drumClass: 'voice', drumRestoreSkip: false, notes: 'FILTER ENVELOPE.' },
    { newId: 'AmpEnvAttackCurve',   method: 'processAmpEnvAttackCurve', newOrdinal: 27, drumClass: 'voice', drumRestoreSkip: false, notes: 'AMPLIFIER ENVELOPE.' },
];

// ---------------------------------------------------------------------------
// Drum classification sets (encoded as data for the validator; also the
// human-readable authority for PARAM_SPEC.md).
//
// NOTE on orthogonality: drumClass and drumRestoreSkip are INDEPENDENT axes.
// Index 51 (LATK) is BOTH 'smoother' AND restore-skip; index 3 (VOICE_COUNT)
// is 'global' AND restore-skip; 40/41/42 are 'voice' AND restore-skip; 52/53
// are 'smoother' but NOT restore-skip. Neither is derivable from the other.
//
// NOTE on the global set: C is_global_drum_param() additionally returns true
// for UNDEFINED(0) and MIDILEARN(1) — no-op rows. Since they dispatch
// nothing, the spec classifies them 'none' (precedence none > smoother >
// global > voice); the expected-global set below is the C set minus those
// two no-op rows. Functional behavior is identical.
// ---------------------------------------------------------------------------

// Exact is_global_drum_param() membership from main_obxd.cpp (incl. no-ops 0,1):
export const DRUM_GLOBAL_C_SET = Object.freeze([
    0, 1,                                   // sentinels / REMOVED no-ops (→ 'none' in spec)
    2, 3, 4, 5, 6, 7, 8, 9,                 // structural: volume..vibrato rate
    12, 13, 14, 15,                         // alloc, portamento, unison, udet
    17, 18, 19, 20,                         // shared global LFO1: rate + waves
    47,                                     // HQMode (allSoundOff on toggle)
    62, 63, 64, 65, 66, 67, 68, 69,         // processPan → synth.pannings
    72,                                     // LFO sync (re-dispatch)
]);

// Exact is_smoother_driven_drum_param() membership:
export const DRUM_SMOOTHER_SET = Object.freeze([44, 45, 46, 51, 52, 53, 54]);

// Exact DRUM_STRUCTURAL_SKIP from src/obxd-processor.tail.js restore_all_params
// (instance 9 only; owned by initDrumMode/reassertDrumInstanceStructural):
export const DRUM_RESTORE_SKIP_SET = Object.freeze([3, 40, 41, 42, 51, 54]);

// Verified NEW-param drum globals (CANONICAL ordinals, idx = 200 + ordinal).
// Ground truth: the processX() bodies in obxf_imported/engine/SynthEngine.h —
// these four are the ONLY NEW setters that write synth-global Motherboard
// state with NO ForEachVoice (everything else is per-voice, applied per
// triggered drum layer via pcmVoiceOverride):
//   0  UnisonVoices → synth.setUnisonVoices → Motherboard::unisonVoiceCount
//   1  VoiceReassign → synth.reallocate (Motherboard bool)
//   7  VibratoWave   → synth.vibratoLFO.par.{wave1blend,wave2blend}
//   10 LFO1PW        → synth.globalLFO.par.pw
export const DRUM_NEW_GLOBAL_ORDINALS = Object.freeze([0, 1, 7, 10]);

// Removed / no-op rows ('none'): empty newId, plus UNDEFINED:
export const DRUM_NONE_SET = Object.freeze([0, 1, 32, 70, 71]);

// ---------------------------------------------------------------------------
// validateSpec — self-check. Returns an array of problem strings; empty = OK.
// ---------------------------------------------------------------------------

export function validateSpec() {
    const problems = [];
    const legacy = paramSpec.filter(e => typeof e.legacyIndex === 'number');
    const fresh = paramSpec.filter(e => typeof e.newOrdinal === 'number');

    // --- legacy rows: 0..79 exactly once -----------------------------------
    if (legacy.length !== PARAM_COUNT)
        problems.push(`expected ${PARAM_COUNT} legacy rows, found ${legacy.length}`);
    const idxSeen = new Map();
    for (const e of legacy) {
        if (!Number.isInteger(e.legacyIndex) || e.legacyIndex < 0 || e.legacyIndex >= PARAM_COUNT) {
            problems.push(`legacy row has out-of-range legacyIndex: ${JSON.stringify(e.legacyIndex)}`);
            continue;
        }
        if (idxSeen.has(e.legacyIndex))
            problems.push(`duplicate legacyIndex ${e.legacyIndex} (${e.legacyName})`);
        idxSeen.set(e.legacyIndex, e);
    }
    for (let i = 0; i < PARAM_COUNT; i++)
        if (!idxSeen.has(i)) problems.push(`missing legacyIndex ${i}`);

    // --- BENDRANGE split row -----------------------------------------------
    const bend = idxSeen.get(BENDRANGE_LEGACY_INDEX);
    if (!bend) {
        problems.push(`missing BENDRANGE row (index ${BENDRANGE_LEGACY_INDEX})`);
    } else {
        if (bend.transform?.kind !== 'SPLIT_BENDRANGE')
            problems.push('BENDRANGE row must carry a SPLIT_BENDRANGE transform');
        if (bend.transform?.secondaryNewId !== 'PitchBendDown' ||
            bend.transform?.secondaryMethod !== 'processBendDownRange')
            problems.push('BENDRANGE split must target PitchBendDown via processBendDownRange');
        if (bend.newId !== 'PitchBendUp' || bend.method !== 'processBendUpRange')
            problems.push('BENDRANGE primary target must be PitchBendUp via processBendUpRange');
        if (legacy.filter(e => e.legacyName === 'BENDRANGE').length !== 1)
            problems.push('BENDRANGE must be exactly ONE row (80 legacy rows, not 81)');
    }

    // --- NEW entries: exactly 28, unique names, ordinals 0..27 -------------
    if (fresh.length !== NEW_PARAM_COUNT)
        problems.push(`expected ${NEW_PARAM_COUNT} NEW entries, found ${fresh.length}`);
    const ordSeen = new Set();
    const newNames = new Set();
    for (const e of fresh) {
        if (!Number.isInteger(e.newOrdinal) || e.newOrdinal < 0 || e.newOrdinal >= NEW_PARAM_COUNT) {
            problems.push(`NEW entry has out-of-range newOrdinal: ${JSON.stringify(e.newOrdinal)} (${e.newId})`);
            continue;
        }
        if (ordSeen.has(e.newOrdinal))
            problems.push(`duplicate newOrdinal ${e.newOrdinal} (${e.newId})`);
        ordSeen.add(e.newOrdinal);
        if (newNames.has(e.newId)) problems.push(`duplicate NEW newId: ${e.newId}`);
        newNames.add(e.newId);
    }
    for (let i = 0; i < NEW_PARAM_COUNT; i++)
        if (!ordSeen.has(i)) problems.push(`missing newOrdinal ${i}`);

    // --- streaming-name uniqueness across the whole spec --------------------
    // Every non-empty newId must be unique. The BENDRANGE split's second half
    // (PitchBendDown) lives in the transform descriptor (secondaryNewId) and
    // must not collide with any other target either.
    const targets = new Map(); // name → owner description
    for (const e of legacy) {
        if (e.newId) {
            if (targets.has(e.newId))
                problems.push(`newId used more than once: ${e.newId} (${targets.get(e.newId)} and legacy ${e.legacyIndex})`);
            targets.set(e.newId, `legacy ${e.legacyIndex}`);
        }
        const sec = e.transform?.secondaryNewId;
        if (sec) {
            if (targets.has(sec))
                problems.push(`secondaryNewId collides: ${sec} (${targets.get(sec)} and legacy ${e.legacyIndex})`);
            targets.set(sec, `legacy ${e.legacyIndex} (split half)`);
        }
    }
    for (const e of fresh) {
        if (targets.has(e.newId))
            problems.push(`NEW newId already targeted by a legacy row: ${e.newId}`);
        targets.set(e.newId, `NEW ${e.newOrdinal}`);
    }

    // --- drum sets ----------------------------------------------------------
    const setOf = (arr) => [...arr].sort((a, b) => a - b).join(',');
    const expectedGlobal = DRUM_GLOBAL_C_SET.filter(i => {
        const e = idxSeen.get(i);
        return e && e.newId !== ''; // no-op rows classify 'none'
    });
    const specGlobal = legacy.filter(e => e.drumClass === 'global').map(e => e.legacyIndex);
    const specSmoother = legacy.filter(e => e.drumClass === 'smoother').map(e => e.legacyIndex);
    const specNone = legacy.filter(e => e.drumClass === 'none').map(e => e.legacyIndex);
    const specSkip = legacy.filter(e => e.drumRestoreSkip === true).map(e => e.legacyIndex);

    if (setOf(specGlobal) !== setOf(expectedGlobal))
        problems.push(`drumClass 'global' set mismatch: spec=[${specGlobal}] expected=[${expectedGlobal}] (is_global_drum_param minus no-op rows)`);
    if (setOf(specSmoother) !== setOf(DRUM_SMOOTHER_SET))
        problems.push(`drumClass 'smoother' set mismatch: spec=[${specSmoother}] expected=[${DRUM_SMOOTHER_SET}]`);
    if (setOf(specSkip) !== setOf(DRUM_RESTORE_SKIP_SET))
        problems.push(`drumRestoreSkip set mismatch: spec=[${specSkip}] expected=[${DRUM_RESTORE_SKIP_SET}]`);
    if (setOf(specNone) !== setOf(DRUM_NONE_SET))
        problems.push(`drumClass 'none' set mismatch: spec=[${specNone}] expected=[${DRUM_NONE_SET}]`);

    // --- NEW-param drum classification -------------------------------------
    // Vocabulary: only 'global' | 'voice' (no smoother — NEW params carry no
    // legacy-rescale path, and no 'none' — they all dispatch). The global set
    // is the VERIFIED one (DRUM_NEW_GLOBAL_ORDINALS): processX setters that
    // write synth-global Motherboard state with no ForEachVoice.
    const specNewGlobal = fresh.filter(e => e.drumClass === 'global').map(e => e.newOrdinal);
    for (const e of fresh) {
        if (e.drumClass !== 'global' && e.drumClass !== 'voice')
            problems.push(`${e.newId}: NEW drumClass '${e.drumClass}' must be 'global' or 'voice'`);
    }
    if (setOf(specNewGlobal) !== setOf(DRUM_NEW_GLOBAL_ORDINALS))
        problems.push(`NEW drumClass 'global' set mismatch: spec=[${specNewGlobal}] verified=[${DRUM_NEW_GLOBAL_ORDINALS}]`);

    // --- transform vocabulary (closed set) + structural fields --------------
    const kinds = new Set(TRANSFORM_KINDS);
    const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
    const checkMapSet = (d, label, curveRequired) => {
        if (!d || typeof d !== 'object') { problems.push(`${label}: missing set`); return; }
        if (!isNum(d.lo) || !isNum(d.hi) || !isNum(d.rolloff))
            problems.push(`${label}: set needs numeric lo/hi/rolloff`);
        if (curveRequired && !XF_CURVES.includes(d.curve))
            problems.push(`${label}: xf.curve must be one of ${XF_CURVES.join('|')}`);
    };
    for (const e of [...legacy, ...fresh]) {
        const label = e.legacyName ?? e.newId;
        // NEW entries are native OB-Xf params dispatched 1:1 (no legacy 0..1
        // space, hence no transform/invert) — only legacy rows carry one.
        if (typeof e.newOrdinal === 'number') continue;
        const t = e.transform;
        if (!t || !kinds.has(t.kind)) {
            problems.push(`${label}: transform kind '${t?.kind}' not in closed vocabulary`);
            continue;
        }
        if (t.kind === 'MUL' && !isNum(t.factor))
            problems.push(`${label}: MUL needs numeric factor`);
        if (t.kind === 'PAN' && !(isNum(t.voiceIndex) && t.voiceIndex >= 1 && t.voiceIndex <= 8))
            problems.push(`${label}: PAN needs voiceIndex 1..8`);
        if (t.kind === 'SPLIT_BENDRANGE' &&
            !(isNum(t.threshold) && isNum(t.semitonesHigh) && isNum(t.semitonesLow) &&
              isNum(t.maxBendRange) && typeof t.secondaryNewId === 'string' && typeof t.secondaryMethod === 'string'))
            problems.push(`${label}: SPLIT_BENDRANGE descriptor incomplete`);
        if (t.kind === 'LOGSC_INVLOGSC') {
            checkMapSet(t.xd, `${label}.xd`, false);
            checkMapSet(t.xf, `${label}.xf`, true);
            if (t.preDivisor !== undefined && !isNum(t.preDivisor))
                problems.push(`${label}: preDivisor must be numeric when present`);
        }
        if (t.kind === 'LFO1_RATE') {
            if (!t.free || !t.free.xd || !t.free.xf || !Array.isArray(t.synced?.table) ||
                !isNum(t.synced?.sourceBuckets) || !isNum(t.synced?.denom) ||
                !isNum(t.syncMirrorLegacyIndex))
                problems.push(`${label}: LFO1_RATE descriptor incomplete`);
        }
        if (t.kind === 'LFO1_SYNC' && !isNum(t.redispatchLegacyIndex))
            problems.push(`${label}: LFO1_SYNC needs redispatchLegacyIndex`);
        // invert: descriptor or null; kind from the same closed vocabulary.
        // specialInline rows (LFOFREQ/LFO_SYNC) are exempt — the C code keeps
        // them inline and no clean inverse exists.
        if (e.invert !== null && e.invert !== undefined) {
            if (!kinds.has(e.invert.kind))
                problems.push(`${label}: invert kind '${e.invert?.kind}' not in closed vocabulary`);
        } else if (typeof e.legacyIndex === 'number' && e.newId && !e.specialInline) {
            problems.push(`${label}: non-removed legacy row must carry an invert descriptor`);
        }
        if (typeof e.legacyIndex === 'number') {
            if (!e.newId && e.method)
                problems.push(`${label}: removed row must have empty method`);
            if (e.newId && !e.method)
                problems.push(`${label}: non-removed row must have a method`);
            if (!e.newId && e.invert !== null)
                problems.push(`${label}: removed row must have invert null`);
            if (e.specialInline && e.legacyIndex !== 17 && e.legacyIndex !== 72)
                problems.push(`${label}: specialInline is reserved for LFOFREQ(17)/LFO_SYNC(72)`);
            if ((e.legacyIndex === 17 || e.legacyIndex === 72) &&
                !(e.specialInline === true && e.invert === null))
                problems.push(`${label}: specialInline rows must be flagged and have invert null`);
            if (!['none', 'global', 'smoother', 'voice'].includes(e.drumClass))
                problems.push(`${label}: drumClass '${e.drumClass}' not in taxonomy`);
            if (e.drumClass === 'none' && e.newId !== '')
                problems.push(`${label}: drumClass 'none' is only for removed/no-op rows`);
        }
    }

    // --- method names exist in obxf_imported/engine/SynthEngine.h ----------
    for (const e of [...legacy, ...fresh]) {
        const label = e.legacyName ?? e.newId;
        if (!e.method) continue;
        if (!SYNTH_ENGINE_METHODS.has(e.method))
            problems.push(`${label}: method '${e.method}' not found in obxf_imported/engine/SynthEngine.h snapshot`);
        if (typeof e.transform?.secondaryMethod === 'string' &&
            !SYNTH_ENGINE_METHODS.has(e.transform.secondaryMethod))
            problems.push(`${label}: secondaryMethod '${e.transform.secondaryMethod}' not in SynthEngine.h snapshot`);
    }

    return problems;
}

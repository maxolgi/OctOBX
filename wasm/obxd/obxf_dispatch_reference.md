# OB-Xf Dispatch Reference

This file is documentation only — preserved verbatim from the OB-Xd → OB-Xf
parameter-mapping explorer's Output 3 (method-by-method dispatch) and Output 4
(drift report). It is intended for downstream agents rewriting
`wasm/obxd/main_obxd.cpp` against the OB-Xf `SynthEngine`, and for UI agents
adding fresh controls for OB-Xf params that have no OB-Xd ancestor.

## Method-by-method dispatch (Output 3)

Every `processXxx(float val)` (or `processXxx(float val, ...)` for pan) in `obxf_imported/engine/SynthEngine.h` (curated copy of `third_party/OB-Xf/src/engine/SynthEngine.h`). Format: `method → ID [was: legacy]`. `NEW FEATURE` = no OB-Xd ancestor. `MIDI` = driven by MIDI, not a parameter knob.

```text
processVolume                  → Volume                [was: processVolume (VOLUME=2)]
processTranspose               → Transpose             [was: processOctave (OCTAVE=5)] — SEMANTIC SHIFT
processTune                    → Tune                  [was: processTune (TUNE=4)]
processPolyphony               → Polyphony            [was: setVoiceCount (VOICE_COUNT=3)] — RESCALE
processHQMode                  → HQMode               [was: processOversampling (FILTER_WARM=47)]
processUnisonVoices            → UnisonVoices         NEW FEATURE (separate from polyphony)
processPortamento              → Portamento           [was: processPortamento (PORTAMENTO=13)]
processUnison                  → Unison               [was: processUnison (UNISON=14)]
processUnisonDetune            → UnisonDetune         [was: processDetune (UDET=15)] — RESCALE
processEnvLegatoMode           → EnvLegatoMode        [was: processLegatoMode (LEGATOMODE=8)] — QUANT SHIFT
processNotePriority            → NotePriority         [was: procAsPlayedAlloc (ASPLAYEDALLOCATION=12)] — SEMANTIC (bool→tri)
processVoiceReassign           → VoiceReassign        NEW FEATURE (v1.1)
processOsc1Pitch               → Osc1Pitch            [was: processOsc1Pitch (OSC1P=30)]
processOsc2Detune              → Osc2Detune           [was: processOsc2Det (OSC2_DET=16)]
processOsc2Pitch               → Osc2Pitch            [was: processOsc2Pitch (OSC2P=31)]
processOsc2Keytrack            → Osc2Keytrack         NEW FEATURE (v1.1)
processOsc1Saw                 → Osc1SawWave          [was: processOsc1Saw (OSC1Saw=33)]
processOsc1Pulse               → Osc1PulseWave        [was: processOsc1Pulse (OSC1Pul=34)]
processOsc2Saw                 → Osc2SawWave          [was: processOsc2Saw (OSC2Saw=35)]
processOsc2Pulse               → Osc2PulseWave        [was: processOsc2Pulse (OSC2Pul=36)]
processOscPW                   → OscPW                [was: processPulseWidth (PW=37)]
processOsc2PWOffset            → Osc2PWOffset         [was: processPwOfs (PW_OSC2_OFS=77)] — RESCALE
processEnvToPitchAmount        → EnvToPitchAmount     [was: processEnvelopeToPitch (ENVPITCH=39)] — RESCALE
processPitchBothOscs           → EnvToPitchBothOscs   [was: processPitchModBoth (ENV_PITCH_BOTH=75)] — METHOD NAME MISMATCH (no 'EnvTo' prefix)
processEnvToPitchInvert        → EnvToPitchInvert     NEW FEATURE
processEnvToPWAmount           → EnvToPWAmount        [was: processPwEnv (PW_ENV=73)] — RESCALE
processEnvToPWBothOscs         → EnvToPWBothOscs      [was: processPwEnvBoth (PW_ENV_BOTH=74)]
processEnvToPWInvert           → EnvToPWInvert        NEW FEATURE
processCrossmod                → OscCrossmod          [was: processOsc2Xmod (XMOD=29)] — RESCALE (v*0.5)
processOscSync                 → OscSync              [was: processOsc2HardSync (OSC2HS=28)]
processOscBrightness           → OscBrightness        [was: processBrightness (BRIGHTNESS=38)]
processOsc1Volume              → Osc1Mix              [was: processOsc1Mix (OSC1MIX=40)] — ID='Osc1Mix', method=processOsc1Volume
processOsc2Volume              → Osc2Mix              [was: processOsc2Mix (OSC2MIX=41)] — ID='Osc2Mix', method=processOsc2Volume
processRingModVolume           → RingModMix           NEW FEATURE
processNoiseVolume             → NoiseMix             [was: processNoiseMix (NOISEMIX=42)] — RESCALE (bake logsc into value); ID='NoiseMix'
processNoiseColor              → NoiseColor           NEW FEATURE
processBendUpRange             → PitchBendUp          [was: procPitchWheelAmount (BENDRANGE=6)] — SPLIT 1/2; ID='PitchBendUp'
processBendDownRange           → PitchBendDown        [was: procPitchWheelAmount (BENDRANGE=6)] — SPLIT 2/2; ID='PitchBendDown'
processBendOsc2Only            → BendOsc2Only         [was: procPitchWheelOsc2Only (BENDOSC2=7)]
processVibratoLFOWave          → VibratoWave          NEW FEATURE (old BENDLFORATE was rate-only); method=processVibratoLFOWave
processVibratoLFORate          → VibratoRate          [was: procModWheelFrequency (BENDLFORATE=9)] — RESCALE; method=processVibratoLFORate (capital R)
processFilter4PoleMode         → Filter4PoleMode      [was: processFourPole (FOURPOLE=49)]
processFilterCutoff            → FilterCutoff         [was: processCutoff (CUTOFF=44)]
processFilterResonance         → FilterResonance      [was: processResonance (RESONANCE=45)]
processFilterEnvAmount         → FilterEnvAmount      [was: processFilterEnvelopeAmt (ENVELOPE_AMT=50)]
processFilterKeyTrack          → FilterKeyFollow      [was: processFilterKeyFollow (FLT_KF=43)] — ID='FilterKeyFollow', var=FilterKeyTrack
processFilterMode              → FilterMode           [was: processMultimode (MULTIMODE=46)]
processFilter2PoleBPBlend      → Filter2PoleBPBlend   [was: processBandpassSw (BANDPASS=48)]
processFilter2PolePush         → Filter2PolePush      [was: processSelfOscPush (SELF_OSC_PUSH=79)]
processFilter4PoleXpander      → Filter4PoleXpander   NEW FEATURE
processFilterXpanderMode       → FilterXpanderMode    NEW FEATURE (15 modes: LP4/LP3/LP2/LP1/HP3/HP2/HP1/BP4/BP2/N2/PH3/HP2+LP1/HP3+LP1/N2+LP1/PH3+LP1)
processLFO1Sync                → LFO1TempoSync        [was: procLfoSync (LFO_SYNC=72)] — METHOD NAME MISMATCH (no 'Tempo')
processLFO1Rate                → LFO1Rate             [was: processLfoFrequency (LFOFREQ=17)] — RESCALE (~75x)
processLFO1ModAmount1          → LFO1ModAmount1       [was: processLfoAmt1 (LFO1AMT=21)]
processLFO1ModAmount2          → LFO1ModAmount2       [was: processLfoAmt2 (LFO2AMT=22)] — NOT LFO2
processLFO1Wave1               → LFO1Wave1            [was: processLfoSine (LFOSINWAVE=18)] — TYPE CHANGE
processLFO1Wave2               → LFO1Wave2            [was: processLfoSquare (LFOSQUAREWAVE=19)] — TYPE CHANGE
processLFO1Wave3               → LFO1Wave3            [was: processLfoSH (LFOSHWAVE=20)] — TYPE CHANGE
processLFO1PW                  → LFO1PW               NEW FEATURE
processLFO1ToOsc1Pitch         → LFO1ToOsc1Pitch      [was: processLfoOsc1 (LFOOSC1=23)] — TYPE CHANGE (bool→tri)
processLFO1ToOsc2Pitch         → LFO1ToOsc2Pitch      [was: processLfoOsc2 (LFOOSC2=24)] — TYPE CHANGE
processLFO1ToFilterCutoff      → LFO1ToFilterCutoff   [was: processLfoFilter (LFOFILTER=25)] — TYPE CHANGE
processLFO1ToOsc1PW            → LFO1ToOsc1PW         [was: processLfoPw1 (LFOPW1=26)] — TYPE CHANGE
processLFO1ToOsc2PW            → LFO1ToOsc2PW         [was: processLfoPw2 (LFOPW2=27)] — TYPE CHANGE (NOT LFO2)
processLFO1ToVolume            → LFO1ToVolume         NEW FEATURE
processLFO2Sync                → LFO2TempoSync        NEW FEATURE — METHOD NAME MISMATCH (no 'Tempo')
processLFO2Rate                → LFO2Rate             NEW FEATURE
processLFO2ModAmount1          → LFO2ModAmount1       NEW FEATURE
processLFO2ModAmount2          → LFO2ModAmount2       NEW FEATURE
processLFO2Wave1               → LFO2Wave1            NEW FEATURE
processLFO2Wave2               → LFO2Wave2            NEW FEATURE
processLFO2Wave3               → LFO2Wave3            NEW FEATURE
processLFO2PW                  → LFO2PW               NEW FEATURE
processLFO2ToOsc1Pitch         → LFO2ToOsc1Pitch      NEW FEATURE
processLFO2ToOsc2Pitch         → LFO2ToOsc2Pitch      NEW FEATURE
processLFO2ToFilterCutoff      → LFO2ToFilterCutoff   NEW FEATURE
processLFO2ToOsc1PW            → LFO2ToOsc1PW         NEW FEATURE
processLFO2ToOsc2PW            → LFO2ToOsc2PW         NEW FEATURE
processLFO2ToVolume            → LFO2ToVolume         NEW FEATURE
processFilterEnvInvert         → FilterEnvInvert      [was: processInvertFenv (FENV_INVERT=76)]
processFilterEnvAttack         → FilterEnvAttack      [was: processFilterEnvelopeAttack (FATK=55)] — RESCALE (/3)
processFilterEnvDecay          → FilterEnvDecay       [was: processFilterEnvelopeDecay (FDEC=56)]
processFilterEnvSustain        → FilterEnvSustain     [was: processFilterEnvelopeSustain (FSUS=57)]
processFilterEnvRelease        → FilterEnvRelease     [was: processFilterEnvelopeRelease (FREL=58)]
processFilterEnvAttackCurve    → FilterEnvAttackCurve NEW FEATURE
processVelToFilterEnv          → VelToFilterEnv       [was: procFltVelocityAmount (VFLTENV=10)]
processAmpEnvAttack            → AmpEnvAttack         [was: processLoudnessEnvelopeAttack (LATK=51)] — RESCALE (/3)
processAmpEnvDecay             → AmpEnvDecay          [was: processLoudnessEnvelopeDecay (LDEC=52)]
processAmpEnvSustain           → AmpEnvSustain        [was: processLoudnessEnvelopeSustain (LSUS=53)]
processAmpEnvRelease           → AmpEnvRelease        [was: processLoudnessEnvelopeRelease (LREL=54)]
processAmpEnvAttackCurve       → AmpEnvAttackCurve    NEW FEATURE
processVelToAmpEnv             → VelToAmpEnv          [was: procAmpVelocityAmount (VAMPENV=11)]
processPortamentoSlop          → PortamentoSlop       [was: processPortamentoDetune (PORTADER=61)]
processFilterSlop              → FilterSlop           [was: processFilterDetune (FILTERDER=60)]
processEnvelopeSlop            → EnvelopeSlop         [was: processEnvelopeDetune (ENVDER=59)]
processLevelSlop               → LevelSlop            [was: processLoudnessDetune (LEVEL_DIF=78)]
processPan                     → PanVoice1..8         [was: processPan (PAN1..PAN8=62..69)] — call as processPan(v, idx)

--- MIDI handlers (take float, not parameter-driven; listed for completeness) ---
processPitchWheel              MIDI  [pitch-bend smoother; old procPitchWheel used setSteep, new uses setStep]
processModWheel                MIDI  [mod-wheel smoother; old procModWheel used setSteep, new uses setStep]
processModWheelSmoothed        MIDI  [internal smoother output; not a knob]
processMPEPitch                MIDI  NEW FEATURE (channel-aware: int8_t channel, float val)
processMPETimbre               MIDI  NEW FEATURE (channel-aware)
processMPEChannelPressure      MIDI  NEW FEATURE (channel-aware)

--- Note: OB-Xf processNoteOn/processNoteOff take (int note, float velocity, int8_t channel) ---
--- vs OB-Xd procNoteOn/procNoteOff which take (int note, float velocity). The rewrite MUST  ---
--- pass a channel arg (0 for non-MPE).                                                          ---
```

## Drift report (Output 4)

### 4a. OB-Xd params with NO clean 1:1 equivalent in OB-Xf

| Idx | Name | Status | Detail |
|----|------|--------|--------|
| 0 | `UNDEFINED` | sentinel | No-op in both. Drop. |
| 1 | `MIDILEARN` | **REMOVED** | UI-only in OB-Xd, never reached the engine. No OB-Xf equivalent. |
| 32 | `OSCQuantize` | **REMOVED** | OB-Xf does not expose osc-pitch quantization as a runtime parameter. The importer reads it only to decide integer rounding of osc pitches at import time. No dispatch target. |
| 70 | `UNLEARN` | **REMOVED** | UI-only in OB-Xd, never reached the engine. No OB-Xf equivalent. |
| 71 | `ECONOMY_MODE` | **REMOVED** | OB-Xf has no economy/CPU-saving toggle. `HQMode` (mapped from `FILTER_WARM`) is the spiritual successor but is a different parameter. |

**SPLIT / SEMANTIC-SHIFT mappings (have a target but are not clean copies):**

| Idx | Name | Issue |
|----|------|-------|
| 6 | `BENDRANGE` | **SPLIT** into `PitchBendUp` + `PitchBendDown`. Old was a single 2-state toggle (2 or 12 semis); new exposes up and down independently. One source value → two target calls. |
| 5 | `OCTAVE` | **SEMANTIC SHIFT**. Old `processOctave` = `(round(v*4)-2)*12` semitones centered at 0; new `processTranspose` = `round((v*2-1)*24)` semitones. Importer remaps and emits a warning that OB-Xd's middle-C reference was an octave too high. Not a value copy. |
| 3 | `VOICE_COUNT` | **RESCALE**. Old gives 1–8 voices; new gives 1–33. Without the importer's remap the synth gets ~4× the voices. |
| 17 | `LFOFREQ` | **RESCALE**. Old range 0–50 Hz (rolloff 120); new 0–250 Hz (rolloff 3775). ~75× faster if copied raw. Synced-path uses a 9→21 bucket lookup table. |
| 22 | `LFO2AMT` | **AMBIGUOUS NAMING** (not actually removed — but a trap). Despite the name, this is LFO1's 2nd mod amount, maps to `LFO1ModAmount2`. Do NOT route to LFO2. |
| 12 | `ASPLAYEDALLOCATION` | **LOSSY**. Old bool → new tri-state `NotePriority`. Only the "Last" (=old true) and "Low" (=old false) states are reachable; the "High" priority is new. |
| 8 | `LEGATOMODE` | **QUANTIZATION SHIFT**. Both have 4 modes but the bucket boundaries differ at v=0.5 (old→mode 2, new→mode 1). |
| 18,19,20 | `LFOSINWAVE`/`LFOSQUAREWAVE`/`LFOSHWAVE` | **TYPE CHANGE**. Old bool waveform-bit toggles → new continuous blend `[-1..1]`. Importer uses `lfoBoolToBlend` (only emits 0 or 0.5, never negative). |
| 23–27 | `LFOOSC1/2`, `LFOFILTER`, `LFOPW1/2` | **TYPE CHANGE**. Old bool → new tri-state `{Off, On, Inverted}`. Importer uses `lfoBoolToTriState` (only emits 0 or 0.5, never 1.0=Inverted). |
| 9 | `BENDLFORATE` | **RESCALE + RENAME**. Old logsc(3,10) Hz → new linsc(2,12) Hz. Method renamed `procModWheelFrequency` → `processVibratoLFORate`. |
| 15 | `UDET` | **RESCALE**. Old logsc(0.001,0.90) → new logsc(0.001,1.0). |
| 29 | `XMOD` | **RESCALE**. Old `v*24` semis → new `v*48` semis. |
| 39 | `ENVPITCH` | **RESCALE**. Old `v*36` → new `v*40` semis. |
| 42 | `NOISEMIX` | **RESCALE + STRUCTURAL**. Old engine applies `logsc(v,0,1,35)` internally; OB-Xf expects the logsc'd value directly. The transform must move from inside the engine to the dispatch boundary. |
| 51 | `LATK` | **RESCALE**. Importer divides attack ms by 3 (OB-Xf envelopes sustain at 90%, making attacks feel faster). |
| 55 | `FATK` | **RESCALE**. Same /3 attack compensation as LATK. |
| 73 | `PW_ENV` | **RESCALE**. Old linsc(0,0.85) → new linsc(0,1.0556). |
| 77 | `PW_OSC2_OFS` | **RESCALE**. Old linsc(0,0.75) → new linsc(0,0.95). |
| 47 | `FILTER_WARM` | **BEHAVIOR CHANGE**. Renamed `processOversampling` → `processHQMode`. New version additionally calls `allSoundOff()` when toggled (old did not), so live-toggling will cut sound. |

### 4b. New OB-Xf params with NO OB-Xd ancestor (need fresh UI)

These `SynthParam::ID` strings have no source in the legacy `ParamsEnum.h`. The UI agent must add fresh knobs/toggles for each. Grouped by feature area; `v1.1` = added after OB-Xf 1.0 (version hint 2).

**Global / voice:**
- `UnisonVoices` — separate unison voice count (OB-Xd only had total `VOICE_COUNT`)
- `VoiceReassign` (v1.1) — voice reassignment toggle
- `NotePriority` "High" state — the third tri-state value (old bool could only reach Last/Low)

**Oscillators:**
- `Osc2Keytrack` (v1.1) — osc2 keytrack toggle (importer force-defaults to 1.0)
- `EnvToPitchInvert` — invert filter-env-to-pitch
- `EnvToPWInvert` — invert filter-env-to-pulsewidth

**Mixer:**
- `RingModMix` (var `RingModVol`, method `processRingModVolume`) — ring mod level
- `NoiseColor` — white/pink/red noise selector (int 0/1/2)

**Filter:**
- `Filter4PoleXpander` — enable Xpander-mode 4-pole filter
- `FilterXpanderMode` — 15-mode Xpander filter type selector

**Control:**
- `VibratoWave` (method `processVibratoLFOWave`) — vibrato wave (sine/square); old `BENDLFORATE` was rate-only

**LFO1 (new targets on existing LFO):**
- `LFO1PW` — LFO1 pulsewidth (method `processLFO1PW`)
- `LFO1ToVolume` — LFO1 → volume modulation (tri-state)

**LFO2 (entire second LFO — all NEW):**
- `LFO2TempoSync` (method `processLFO2Sync`)
- `LFO2Rate`, `LFO2ModAmount1`, `LFO2ModAmount2`
- `LFO2Wave1`, `LFO2Wave2`, `LFO2Wave3`, `LFO2PW`
- `LFO2ToOsc1Pitch`, `LFO2ToOsc2Pitch`, `LFO2ToFilterCutoff`
- `LFO2ToOsc1PW`, `LFO2ToOsc2PW`, `LFO2ToVolume`

**Envelopes:**
- `AmpEnvAttackCurve` — amp-env attack curve
- `FilterEnvAttackCurve` — filter-env attack curve

**MIDI (not params, but new engine capabilities the UI may want to expose):**
- MPE support: `processMPEPitch`, `processMPETimbre`, `processMPEChannelPressure` (all channel-aware)
- `processNoteOn`/`processNoteOff` now take an `int8_t channel` arg

---

## Summary counts

- **OB-Xd params total:** 80 entries (indices 0–79)
- **Clean 1:1 copies:** 41 (value passes through unchanged, method just renamed)
- **Rescale required:** 14 (VOICE_COUNT, OCTAVE, BENDRANGE-via-split, BENDLFORATE, UDET, LFOFREQ, XMOD, ENVPITCH, NOISEMIX, LATK, FATK, PW_ENV, PW_OSC2_OFS, plus LFOFREQ's synced branch)
- **Type change (bool→blend/tri-state):** 8 (LFOSINWAVE, LFOSQUAREWAVE, LFOSHWAVE, LFOOSC1, LFOOSC2, LFOFILTER, LFOPW1, LFOPW2; plus ASPLAYEDALLOCATION bool→tri)
- **Removed (no target):** 5 (MIDILEARN, OSCQuantize, UNLEARN, ECONOMY_MODE, UNDEFINED-sentinel)
- **Split (1→2):** 1 (BENDRANGE → PitchBendUp + PitchBendDown)
- **NEW OB-Xf params needing fresh UI:** ~30 (entire LFO2 = 15, plus 15 scattered: UnisonVoices, VoiceReassign, Osc2Keytrack, EnvToPitchInvert, EnvToPWInvert, RingModMix, NoiseColor, Filter4PoleXpander, FilterXpanderMode, VibratoWave, LFO1PW, LFO1ToVolume, AmpEnvAttackCurve, FilterEnvAttackCurve, NotePriority-"High")
- **Method-name ≠ ID-string mismatches to remember:** 5 (`processPitchBothOscs`, `processVibratoLFORate`, `processVibratoLFOWave`, `processLFO1Sync`, `processLFO2Sync`)
- **ID-string ≠ variable-name mismatches to remember:** 7 (`Osc1Vol`→`"Osc1Mix"`, `Osc2Vol`→`"Osc2Mix"`, `RingModVol`→`"RingModMix"`, `NoiseVol`→`"NoiseMix"`, `FilterKeyTrack`→`"FilterKeyFollow"`, `BendUpRange`→`"PitchBendUp"`, `BendDownRange`→`"PitchBendDown"`)

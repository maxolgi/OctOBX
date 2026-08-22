# PARAM_SPEC — the authoritative OB-Xd → OB-Xf parameter spec

`tools/param-spec.mjs` is the **single source of truth** for the OB-Xd
(legacy `ParamsEnum.h`, indices 0..79) → OB-Xf (`SynthParam::ID`) parameter
mapping. A later generator task consumes it to emit everything that today
duplicates the mapping:

1. the big switch `dispatch_legacy_param` (~502–613) in `wasm/obxd/main_obxd.cpp`
2. the named-attribute chain `apply_named_param_instance` (~841–987) in the same file
3. the hand table `wasm/obxd/obxf_param_mappings.h` (81 rows)
4. the auto-documented mirror `src/obxf-param-mappings.ts`

**Authority chain:** `obxf_imported/state/ObxdImporter.cpp`
(`translateProgramFromXml`) is canonical for the legacy→native math;
`main_obxd.cpp` is the current runtime implementation the math was transcribed
from; **this spec becomes the source of truth going forward**.

**Verify (must print `[]`):**

```bash
node -e "import('./tools/param-spec.mjs').then(m => console.log(m.validateSpec()))"
```

The module is pure data + constants + self-check: no side effects at import
time, no dependencies.

## Exports

| Export | Meaning |
|---|---|
| `paramSpec` | Array of 80 legacy entries + 28 NEW entries (108 total) |
| `PARAM_COUNT` | `80` — legacy indices 0..79 (frozen `ParamsEnum.h` order) |
| `NEW_PARAM_BASE` | `200` — sentinel base for OB-Xf-only params (`idx = 200 + ordinal`) |
| `NEW_PARAM_COUNT` | `28` — OB-Xf streaming IDs with no legacy ancestor |
| `BENDRANGE_LEGACY_INDEX` | `6` |
| `TRANSFORM_KINDS` | The closed transform vocabulary (see below) |
| `DRUM_GLOBAL_C_SET`, `DRUM_SMOOTHER_SET`, `DRUM_RESTORE_SKIP_SET`, `DRUM_NONE_SET` | Drum classification sets (see below) |
| `validateSpec()` | Self-check; returns a list of problems (empty = valid) |

## Legacy entry fields (one per legacy param 0..79 — 80 rows, NOT 81)

| Field | Meaning |
|---|---|
| `legacyIndex` | 0..79, each exactly once |
| `legacyName` | `ParamsEnum.h` identifier (documentation) |
| `legacyMethod` | OLD OB-Xd engine method name (documentation only; `"(UI-only)"` where the old knob never reached the engine) |
| `newId` | OB-Xf `SynthParam::ID` **streaming name** (case-sensitive). Empty string = removed / no-op |
| `method` | Actual `SynthEngine` processX method called at runtime; empty for removed. Note `processPan` takes an **extra voiceIndex argument**: `processPan(v, idx)` |
| `transform` | Descriptor from the closed vocabulary; maps legacy 0..1 → native 0..1 |
| `invert` | Descriptor mapping **native 0..1 → legacy 0..1**, or `null`. Used to write `g_param_mirror` correctly when loading native OB-Xf `.fxp` named attributes (fixes the known knob-jump bug). `null` for removed rows and the two `specialInline` rows |
| `specialInline` | `true` only for LFOFREQ(17) and LFO_SYNC(72): their C handling reads/writes instance mirror state and stays inline before AND after the refactor |
| `drumClass` | `'none' \| 'global' \| 'smoother' \| 'voice'` — PCM drum routing (below) |
| `drumRestoreSkip` | Separate boolean — worklet `DRUM_STRUCTURAL_SKIP` (below) |
| `notes` | Short documentation string (rescale math, name mismatches, representative-inverse choice) |

**BENDRANGE (6) is ONE row.** Its `SPLIT_BENDRANGE` transform writes the SAME
transformed value to BOTH `processBendUpRange` (`newId: "PitchBendUp"`) and
`processBendDownRange` (`transform.secondaryNewId: "PitchBendDown"`). This is
why the spec has 80 legacy rows while the old `.h` table had 81.

## NEW entry fields (the 28 OB-Xf-only params)

| Field | Meaning |
|---|---|
| `newId` | Streaming name (unique; never a legacy target) |
| `method` | `SynthEngine` processX method |
| `newOrdinal` | Canonical ordinal 0..27 (see *Canonical-ordinal rule*) |
| `drumClass` | `'global'` for the four **verified** synth-global params — `UnisonVoices` (0), `VoiceReassign` (1), `VibratoWave` (7), `LFO1PW` (10): their processX setters write Motherboard-level state with **no ForEachVoice**, so they route live to instance 9 exactly like legacy drum globals. `'voice'` for the other 24 (ForEachVoice-scoped → applied per triggered layer via `pcmVoiceOverride`). Frozen in `DRUM_NEW_GLOBAL_ORDINALS` and enforced by `validateSpec()` |
| `drumRestoreSkip` | All `false` |
| `notes` | Documentation |

NEW entries carry **no transform/invert**: they are native OB-Xf params
dispatched 1:1 with no legacy 0..1 space.

## Transform vocabulary (CLOSED set — `TRANSFORM_KINDS`)

| Kind | Parameters | Math (in words) | Used by |
|---|---|---|---|
| `IDENTITY` | — | value passes through unchanged (any internal logsc/linsc happens inside the engine) | most rows: VOLUME, TUNE, BENDOSC2, LEGATOMODE, PORTAMENTO, UNISON, OSC2_DET, LFO1AMT, LFO2AMT, OSC2HS, OSC1P, OSC2P, osc wave/pulse toggles, PW, BRIGHTNESS, OSC1MIX, OSC2MIX, FLT_KF, CUTOFF, RESONANCE, MULTIMODE, FILTER_WARM, BANDPASS, FOURPOLE, ENVELOPE_AMT, LDEC, LSUS, LREL, FDEC, FSUS, FREL, ENVDER, FILTERDER, PORTADER, PW_ENV_BOTH, ENV_PITCH_BOTH, FENV_INVERT, LEVEL_DIF, SELF_OSC_PUSH, VFLTENV, VAMPENV |
| `MUL` | `factor` | native = legacy × factor | XMOD (0.5), ENVPITCH (36/40), PW_ENV (0.85/1.0555555555), PW_OSC2_OFS (0.75/0.95) |
| `SPLIT_BENDRANGE` | `threshold`, `semitonesHigh`, `semitonesLow`, `maxBendRange`, `secondaryNewId`, `secondaryMethod` | semitones = v > 0.5 ? 12 : 2; native = semitones / 48, written to BOTH methods | BENDRANGE (6) |
| `VOICE_COUNT` | — | old voices = clamp(round(v·7)+1, 1..8); native = (voices−1+0.5)/32 | VOICE_COUNT (3) |
| `OCTAVE_TRANSPOSE` | — | transpose = clamp(round(v·4)+1, 0..4); native = transpose × 0.25 | OCTAVE (5) |
| `LOGSC_INVLOGSC` | `xd{lo,hi,rolloff}`, `xf{lo,hi,rolloff,curve}`, optional `preDivisor` | xdHz/ms = xdLogsc(v, xd); if `preDivisor` divide by it; native = unmap(result, xf) where `curve` picks the unmap: `'log'` → xdInvLogsc, `'lin'` → xdInvLinsc, `'identity'` → pass-through (the logsc is *baked* into the native value — NOISEMIX) | BENDLFORATE (xd 3..10 r19 / xf **lin** 2..12), UDET (xd 0.001..0.90 r19 / xf log 0.001..1.0 r19), LFOFREQ free path (0..50 r120 / 0..250 r3775), LATK (4..60000 r900, /3), FATK (1..60000 r900, /3), NOISEMIX (0..1 r35, identity bake) |
| `BOOL_BLEND` | — | LFO wave bool → continuous blend: native = v ≥ 0.5 ? 0 : 0.5 | LFOSINWAVE, LFOSQUAREWAVE, LFOSHWAVE (18–20) |
| `BOOL_TRISTATE` | — | LFO destination bool → tri-state {Off,On,Inv} = 0/0.5/1: native = v ≥ 0.5 ? 0.5 : 0 | LFOOSC1, LFOOSC2, LFOFILTER, LFOPW1, LFOPW2 (23–27) |
| `NOTEPRIORITY` | — | bool → tri-state: native = v **> 0.5** ? 0 : 0.5 (strict `>`, unlike BOOL_*) | ASPLAYEDALLOCATION (12) |
| `PAN` | `voiceIndex` (1..8) | value identity; call `processPan(v, voiceIndex)` — the method takes an extra arg | PAN1..PAN8 (62–69) |
| `LFO1_RATE` | `free{xd,xf}`, `synced{table,sourceBuckets,denom}`, `syncMirrorLegacyIndex` | **specialInline, sync-aware**: if the LFO_SYNC mirror > 0.5 → synced path `native = table[clamp(int(v·8),0..8)]/20` (table = [1,4,5,7,10,11,13,15,16], 9 OB-Xd buckets → 21 OB-Xf buckets); else free path LOGSC_INVLOGSC(0..50 r120 → 0..250 r3775). `invert: null` — stays inline in C before AND after the refactor | LFOFREQ (17) |
| `LFO1_SYNC` | `redispatchLegacyIndex` (17) | **specialInline**: `processLFO1Sync(v)` then re-dispatch LFOFREQ from the mirror (legacy `.fxp` loads dispatch params sequentially 0..79, so LFOFREQ at 17 saw a stale sync). `invert: null` | LFO_SYNC (72) |

Helper definitions (verbatim from `main_obxd.cpp`, which mirrors
`ObxdImporter.cpp`):

```
xdLogsc(p, lo, hi, rolloff=19)   = ((exp(p·ln(rolloff+1)) − 1)/rolloff)·(hi−lo) + lo
xdInvLinsc(y, lo, hi)            = jlimit(0,1,(y−lo)/(hi−lo))
xdInvLogsc(y, lo, hi, rolloff=19)= jlimit(0,1, ln(rolloff·(y−lo)/(hi−lo)+1)/ln(rolloff+1))
```

## Invert semantics

`invert` maps a **native OB-Xf 0..1 value back to the LEGACY 0..1 space**, for
writing `g_param_mirror` when loading native `.fxp` named attributes — the
exact inverse of `transform`. Invert descriptors reuse the same closed
vocabulary; per kind:

- **Exact mathematical inverse** (same constants):
  - `IDENTITY` → `IDENTITY`; `PAN` → `IDENTITY` (value is unchanged).
  - `MUL` → `MUL` with the reciprocal factor (XMOD ×2; ENVPITCH ×40/36;
    PW_ENV ×1.0555555555/0.85; PW_OSC2_OFS ×0.95/0.75).
  - `LOGSC_INVLOGSC` → same sets, direction swapped: forward-map native
    through `xf` (logsc/linsc/identity per `curve`), **multiply** by
    `preDivisor` if present, then `xdInvLogsc(result, xd)`.
- **Canonical representative inverse** for many-to-one transforms (a choice —
  documented here and in each row's notes):
  - `SPLIT_BENDRANGE`: range = round(n·48); legacy = range > 7 ? 1 : 0
    (any native range ≥ 8 st maps to the wide-bend knob position, else narrow).
  - `BOOL_BLEND`: legacy = n < 0.25 ? 1 : 0 (native 0 → legacy 1, native 0.5
    → legacy 0; 0.25 is the midpoint of the two emitted values).
  - `BOOL_TRISTATE`: legacy = n ≥ 0.25 ? 1 : 0 (native 0.5 → 1, native 0 → 0;
    the Inv state n=1 shows as "on" in the legacy UI — it has no ancestor).
  - `NOTEPRIORITY`: legacy = n > 0.25 ? 0 : 1 (native 0 = Last → 1, native
    0.5 = Low → 0; High n=1 shows as Low).
  - `VOICE_COUNT`: voices = clamp(round(n·32), 1..8); legacy = (voices−1)/7
    (bucket midpoint).
  - `OCTAVE_TRANSPOSE`: transpose = round(n·4); legacy = clamp((transpose−1)/4, 0, 1).
- `null` for removed rows (no native target) and the two `specialInline` rows
  (LFOFREQ's inverse is sync-state-dependent; LFO_SYNC re-dispatch is a side
  effect, not a value map).

## drumClass taxonomy (PCM drum routing on instance 9)

| Class | Meaning |
|---|---|
| `global` | `is_global_drum_param()` — routes live to instance 9 via `apply_param_instance(9, …)`; never applied per triggered voice. Synth-wide setters (volume, global LFO1 rate/waves/sync, `synth.pannings`) or structural choices (tuning, octave, bend, polyphony, unison, portamento, …), plus HQMode (its `allSoundOff()` on toggle must not cut drum voices) |
| `smoother` | `is_smoother_driven_drum_param()` — processX writes synth-GLOBAL smoothers (cutoff/res/mode) or needs rescale-free application; applied **directly onto the triggered voice** in `apply_drum_layer_params_for_instance`, never via `dispatch_legacy_param` |
| `voice` | everything else — applied per triggered voice via `dispatch_legacy_param` under `pcmVoiceOverride` |
| `none` | removed / no-op rows (empty `newId`) — nothing to route |

**Precedence: `none` > `smoother` > `global` > `voice`.** The C
`is_global_drum_param()` additionally lists UNDEFINED(0) and MIDILEARN(1)
(no-ops); the spec classifies them `'none'` — functionally identical, and the
expected sets encoded in the module reflect this (`DRUM_GLOBAL_C_SET` keeps
the verbatim C membership including 0 and 1 for reference).

The exact legacy-index sets:

- **global** (C set minus the two no-ops): `2,3,4,5,6,7,8,9,12,13,14,15,17,18,19,20,47,62..69,72`
- **smoother**: `44 (CUTOFF), 45 (RESONANCE), 46 (MULTIMODE), 51 (LATK), 52 (LDEC), 53 (LSUS), 54 (LREL)`
- **none**: `0, 1, 32, 70, 71` (UNDEFINED, MIDILEARN, OSCQuantize, UNLEARN, ECONOMY_MODE)
- **voice**: the remaining 42 rows

**NEW params (sentinels ≥ 200) also carry `drumClass`** — verified against each
processX() body in `obxf_imported/engine/SynthEngine.h`:

- **global** (canonical ordinals, frozen in `DRUM_NEW_GLOBAL_ORDINALS`):
  `0 (UnisonVoices → synth.setUnisonVoices → Motherboard::unisonVoiceCount)`,
  `1 (VoiceReassign → synth.reallocate)`,
  `7 (VibratoWave → synth.vibratoLFO.par.*)`,
  `10 (LFO1PW → synth.globalLFO.par.pw)` — the only NEW setters that write
  synth-global Motherboard state with no `ForEachVoice`. They behave exactly
  like legacy drum globals in every C path (`obxd_set_drum_layer_param` /
  `obxd_get_drum_layer_param` / `apply_drum_layer_params_for_instance` /
  `obxd_restore_stage` stage 3 / the `obxd_is_global_drum_param` export, which
  accepts `idx ≥ 200`), and the worklet dump zeroes their per-layer slots.
- **voice**: the other 24 — all `ForEachVoice`-scoped (per-voice fields /
  `Voice::lfo2`), stamped per triggered drum layer via `pcmVoiceOverride`.

## drumRestoreSkip (orthogonal boolean)

Exactly the worklet's `DRUM_STRUCTURAL_SKIP` set in
`src/obxd-processor.tail.js` (`restore_all_params`, instance 9 only):

```
{ 3 (VOICE_COUNT), 40 (OSC1MIX), 41 (OSC2MIX), 42 (NOISEMIX), 51 (LATK), 54 (LREL) }
```

These are owned by `initDrumMode`/`reassertDrumInstanceStructural`; restoring
stale mirror values pinned polyphony to 1 and unmuted the oscillators.
**`drumRestoreSkip` is NOT derivable from `drumClass`** — index 51 is BOTH
`smoother` AND restore-skip; 3 is `global` AND skip; 40–42 are `voice` AND
skip; 52/53 are `smoother` but NOT skip. The two flags are independent axes.

## Canonical-ordinal rule (NEW params)

`newOrdinal` 0..27 = the **declaration order of streaming IDs** in
`wasm/obxd/obxf_imported/parameter/SynthParam.h` (grouped MASTER → GLOBAL →
OSCILLATORS → MIXER → CONTROL → FILTER → LFO1 → LFO2 → envelopes →
slop/pan), filtered to the 28 NEW params. Cross-checked against
`ALL_SYNTH_PARAM_IDS` in `test/obxf-dispatch-coverage.test.ts`. `"OscPitch"`
is excluded everywhere — it is a matrix-routing convenience ID with no
processX method and no `.fxp` serialization.

This order **intentionally differs** from the runtime sentinel order
(`apply_new_param_instance` / `new_param_names[]` in `main_obxd.cpp`, e.g.
LFO2Rate is runtime offset 13 but canonical ordinal 17 — the LFO2 block is
Wave1-3, PW, Rate, ModAmount1-2 in the header vs Rate, ModAmount1-2,
Wave1-3, PW at runtime). The frozen runtime order for saved-state migration
lives in `tools/new-param-order-v1.json` (owned by another task).

## Known method-name mismatches (streaming name ≠ method name)

`processVibratoLFORate` (VibratoRate), `processVibratoLFOWave` (VibratoWave),
`processLFO1Sync` (LFO1TempoSync), `processLFO2Sync` (LFO2TempoSync),
`processPitchBothOscs` (EnvToPitchBothOscs), `processOsc1Volume` (Osc1Mix),
`processOsc2Volume` (Osc2Mix), `processNoiseVolume` (NoiseMix),
`processRingModVolume` (RingModMix), `processFilterKeyTrack`
(FilterKeyFollow), `processPan` (PanVoiceN — takes an extra voiceIndex arg).
The generator must emit the **method** name in `s.X(v)` calls, not the ID
string.

## validateSpec() asserts

1. Legacy indices 0..79 each exactly once (80 rows; BENDRANGE exactly once).
2. BENDRANGE row carries `SPLIT_BENDRANGE` targeting both bend halves.
3. Exactly 28 NEW entries; unique names; ordinals 0..27 exactly once.
4. Every non-empty `newId` (and the split's `secondaryNewId`) is unique
   across the whole spec.
5. The drum `global`/`smoother`/restoreSkip/`none` sets match the exact sets
   above.
6. Every transform/invert kind is from the closed vocabulary, and each
   descriptor's structural fields are present (factors, ranges, curves,
   bucket table, voiceIndex, …).
7. Every non-removed row's `method` (and `secondaryMethod`) exists in a
   frozen snapshot of `obxf_imported/engine/SynthEngine.h` (regenerate the
   snapshot with
   `rg -o '\bprocess[A-Za-z0-9_]+' wasm/obxd/obxf_imported/engine/SynthEngine.h | sort -u`).

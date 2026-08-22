# NEW_PARAM_ORDER_NOTES — freezing the V1 ordinal↔name assignment

Companion to **`tools/new-param-order-v1.json`** (the frozen data). Read that file
first; this note records *how* the order was derived, the cross-verification
against the C engine, and the anomalies found. Generated 2026-08-21.

## Why this freeze exists

`src/obxd-synth-ui.ts` assigns the 28 OB-Xf params that have no legacy OB-Xd
ancestor a **sentinel index** `NEW_PARAM_BASE + N` (`NEW_PARAM_BASE = 200`), where
`N` is simply the order in which those controls are *encountered* while walking
`obxfControls` from `src/obxf-layout.ts`. That ordinal scheme is baked into saved
user state: `app-state.ts` dumps 108 params per synth instance (10×) and per drum
layer (8×4), and `obxd-processor.tail.js`'s `dump_all_params` / `dump_drum_params`
write `params[base + 80 + n] = _obxd_get_param(i, 200 + n)` — i.e. **saved-state
position = 80 + offset, in exactly the order frozen here**. The ordinal scheme is
about to be replaced with name-keyed lookup; this file is the one-way migration
key. It will never be regenerated.

## Derivation method

Replicated the assignment logic verbatim from `src/obxd-synth-ui.ts`:

1. Build `idToLegacyIndex` from `paramMappings` (streaming id → legacy 0..79)
   — lines 99–104.
2. For each control in `obxfControls` **array order** with
   `paramBound !== false` (synth mode — no target), compute
   `streamId = ID_ALIASES[c.id] ?? c.id`; if `idToLegacyIndex.has(streamId)` it
   gets the legacy index, otherwise it falls through to
   `200 + NEW_PARAM_IDS.length` and `NEW_PARAM_IDS.push(c.id)` (lines 156–161,
   924–930).
3. The aliases (`Osc1Vol→Osc1Mix`, `Osc2Vol→Osc2Mix`, `NoiseVol→NoiseMix`,
   `FilterKeyTrack→FilterKeyFollow`, `BendUpRange→PitchBendUp`,
   `BendDownRange→PitchBendDown`) resolve six control ids onto legacy indices,
   so those controls never produce sentinels.

Two independent derivations were performed: a **manual walk** of the layout
array and a **mechanical derivation** that imported the real
`src/obxf-layout.ts` + `src/obxf-param-mappings.ts` modules and re-implemented
`resolveLegacyIndex` exactly. Both produced the identical 28-entry list
(104 param-bound controls total, 28 without a legacy mapping, no duplicate ids).
The only live build call is `buildObxdSynthUi(grid)` at `src/obxd-rack.ts:214`
(no target ⇒ synth mode), so synth-mode encounter order is *the* shipped order.

## Result (array index = offset = sentinel − 200 = saved-state index − 80)

| N | sentinel | name (streaming) | control id | engine method |
|---|----------|------------------|------------|---------------|
| 0 | 200 | UnisonVoices | UnisonVoices | processUnisonVoices |
| 1 | 201 | VoiceReassign | VoiceReassign | processVoiceReassign |
| 2 | 202 | Osc2Keytrack | Osc2Keytrack | processOsc2Keytrack |
| 3 | 203 | EnvToPitchInvert | EnvToPitchInvert | processEnvToPitchInvert |
| 4 | 204 | EnvToPWInvert | EnvToPWInvert | processEnvToPWInvert |
| 5 | 205 | **RingModMix** | **RingModVol** | processRingModVolume |
| 6 | 206 | NoiseColor | NoiseColor | processNoiseColor |
| 7 | 207 | VibratoWave | VibratoWave | processVibratoLFOWave |
| 8 | 208 | Filter4PoleXpander | Filter4PoleXpander | processFilter4PoleXpander |
| 9 | 209 | FilterXpanderMode | FilterXpanderMode | processFilterXpanderMode |
| 10 | 210 | LFO1PW | LFO1PW | processLFO1PW |
| 11 | 211 | LFO1ToVolume | LFO1ToVolume | processLFO1ToVolume |
| 12 | 212 | LFO2TempoSync | LFO2TempoSync | processLFO2Sync |
| 13 | 213 | LFO2Rate | LFO2Rate | processLFO2Rate |
| 14 | 214 | LFO2ModAmount1 | LFO2ModAmount1 | processLFO2ModAmount1 |
| 15 | 215 | LFO2ModAmount2 | LFO2ModAmount2 | processLFO2ModAmount2 |
| 16 | 216 | LFO2Wave1 | LFO2Wave1 | processLFO2Wave1 |
| 17 | 217 | LFO2Wave2 | LFO2Wave2 | processLFO2Wave2 |
| 18 | 218 | LFO2Wave3 | LFO2Wave3 | processLFO2Wave3 |
| 19 | 219 | LFO2PW | LFO2PW | processLFO2PW |
| 20 | 220 | LFO2ToOsc1Pitch | LFO2ToOsc1Pitch | processLFO2ToOsc1Pitch |
| 21 | 221 | LFO2ToOsc2Pitch | LFO2ToOsc2Pitch | processLFO2ToOsc2Pitch |
| 22 | 222 | LFO2ToFilterCutoff | LFO2ToFilterCutoff | processLFO2ToFilterCutoff |
| 23 | 223 | LFO2ToOsc1PW | LFO2ToOsc1PW | processLFO2ToOsc1PW |
| 24 | 224 | LFO2ToOsc2PW | LFO2ToOsc2PW | processLFO2ToOsc2PW |
| 25 | 225 | LFO2ToVolume | LFO2ToVolume | processLFO2ToVolume |
| 26 | 226 | FilterEnvAttackCurve | FilterEnvAttackCurve | processFilterEnvAttackCurve |
| 27 | 227 | AmpEnvAttackCurve | AmpEnvAttackCurve | processAmpEnvAttackCurve |

## Cross-verification vs C-side ground truth

`wasm/obxd/main_obxd.cpp` carries two authoritative structures:

- `new_param_names[]` (lines 800–829): streaming name → offset, used by
  `new_offset_for_streaming_name()` for `.fxp` named-attribute dispatch and the
  `g_new_param_mirror` sync;
- `apply_new_param_instance()` switch (lines 331–363): offset → engine method,
  reached from `apply_param_instance()` for any idx ≥ 200 (lines 634–640) and
  from the per-layer drum path `apply_drum_layer_params_for_instance()` /
  `obxd_set_drum_layer_param()` (`g_drum_layer_new[pad][layer][idx-200]`).

**Verdict: 28/28 offsets MATCH semantically** — the param the TS build places at
offset N is the param the C engine dispatches at offset N, for every N in 0..27.
There is **no offset desync** in the shipped build.

The *only* divergence is a **name-string** difference at **offset 5**: the layout
control id is `RingModVol` while the C table (and tests, and the `.fxp` schema)
say `RingModMix`. Same param, same offset 5, same engine method
`processRingModVolume`. Details below.

## The RingModVol / RingModMix question (investigated, not fixed)

- `src/obxf-layout.ts` (Mixer section, ~line 284) defines the control with
  **`id: "RingModVol"`** (widgetName `ringModVolKnob`). This mirrors OB-Xf's
  editor widget name; the *SynthParam::ID streaming string* is `RingModMix`
  (see `SynthParam.h` and the mappings' naming notes pattern — same
  ID/var/method triple-split as Osc1Mix/Osc1Vol).
- `paramMappings` contains **no** row for either `RingModMix` or `RingModVol`
  (it only covers params WITH a legacy ancestor), so the control falls through
  to sentinel 205 and `NEW_PARAM_IDS` receives the **raw control id
  `RingModVol`** (the push uses `c.id`, not the streaming id). The
  `[obxf] … NEW OB-Xf params:` console line therefore prints `RingModVol`.
- `DRUM_INACTIVE_IDS` in `obxd-synth-ui.ts` contains the string `"RingModVol"`.
  **This entry is live and correct, not dead/wrong**: that set is checked
  against `c.id` (the layout control id), and the control's id *is*
  `RingModVol`. Had the set contained `RingModMix`, *that* entry would have
  been dead.
- Consequence for the upcoming name-keyed refactor: at offset 5 there are
  **two valid spellings in two different consumers** (`RingModVol` in
  layout/control-id space, `RingModMix` in streaming/C/`.fxp`/test space). A
  name-keyed lookup must normalize via the alias (`RingModVol → RingModMix`),
  recorded as `nameAliases` in the JSON freeze. No source was changed.

## Other anomaly recorded: drum-mode sentinel shift (latent)

If `buildObxdSynthUi` were ever called **with** a `target` (drumMode = true),
the `DRUM_INACTIVE_INDICES`/`DRUM_INACTIVE_IDS` filters drop 12 of the 28
NEW-param controls *before* the build loop, so the surviving 16 would receive
sentinels 200..215 in a **shifted** order (first survivor `Filter4PoleXpander`
would get 200, which the engine interprets as `UnisonVoices`). This path is
currently **dead code** — the only live call passes no target
(`obxd-rack.ts:214`), and the drum UI instead uses `drum-rack.ts` knob strips
whose **hard-coded sentinels (lines 118–135: 208, 210–219, 222, 225, 226, 227)
independently corroborate the frozen synth-mode order**. Flagged so the
name-keyed replacement does not silently resurrect the shifted assignment.

## Verification checklist

- [x] Array length is exactly **28**; all names **unique** (both the streaming
      list and the control-id list).
- [x] Every streaming name appears in `NEW_PARAM_IDS` in
      `test/obxf-dispatch-coverage.test.ts` — **no diffs** on the canonical
      streaming-name list. (The runtime `NEW_PARAM_IDS` array in
      `obxd-synth-ui.ts` differs from the test list at exactly one position:
      index 5 `RingModVol` vs `RingModMix` — the duality documented above; the
      test list and the C table agree with each other.)
- [x] Cross-check vs C `new_param_names[]` / `apply_new_param_instance`:
      28/28 offset match (one name-string alias at offset 5).
- [x] Corroborated by `drum-rack.ts` hard-coded sentinels and by
      `obxd-processor.tail.js` bulk-dump layout (position = 80 + offset).
- [x] No existing source files were modified.

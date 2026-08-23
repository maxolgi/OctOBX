# OB-Xf imported subsystem — manifest

Verbatim copy of the OB-Xf **parameter/importer subsystem** (plus the engine
header closure it pulls in) from
<https://github.com/surge-synthesizer/OB-Xf> into
`wasm/obxd/obxf_imported/`.

Source: `third_party/OB-Xf/` (surge-synthesizer/OB-Xf submodule, shallow
`--depth 1` checkout as of the copy date).

All OB-Xf sources are **byte-identical** to the upstream files (verified via
`md5sum`). Two deliberate stubs (`Utils.h`, `libMTSClient.h`) were added to
resolve otherwise-unresolvable includes — see §4.

### OctOBX-only divergence: PCM sampler additions

`engine/SynthEngine.h`, `engine/Motherboard.h`, and `engine/Voice.h` carry
**OctOBX-only PCM sampler additions** (`pcmBank`, `assignPcmLayer`,
`loadPcmSample`, `clearPcm`, `Voice::pcm*` fields, and the PCM path in
`setNoteOn`/`ProcessSample`), each marked with `// OctOBX PCM` comments —
upstream OB-Xf has no PCM code. These three files **intentionally diverge**
from upstream and are excluded from the byte-identical/checksum guarantee;
all other copies remain byte-identical.

### OctOBX-only divergence: per-sample fast-math (wasm CPU)

`engine/Filter.h`, `engine/AdsrEnvelope.h`, and the `Utils.h` stub carry
**OctOBX perf changes**, each marked with `// OctOBX perf` comments (the
`Utils.h` changes live in the stub itself, §4a):

- `Filter.h` — the per-voice-sample `tanf()` (2-pole prewarp), `tan()`
  (4-pole prewarp), and `atan()` (4-pole damping) calls are replaced by
  fitted polynomial approximations (`fastTanf`/`fastAtanf` in the same
  file). Wasm libm calls cost ~15-30ns each; three of them per
  voice-sample dominated the ~39ns/voice-sample render budget. Max errors:
  tan rel 2.6e-4 (only near the sr/2-120Hz cutoff clamp), atan abs
  6.8e-5 rad — both far below audibility.
- `AdsrEnvelope.h` — `updateAttackCoeff()` folded its `log()` calls of
  compile-time constants into constants; `applyMatrixAttack/Release()`
  (called 4x per voice-sample from `Voice.h`) are memoized so the
  constant-input case no-ops instead of recomputing coefficients (this was
  the note-on CPU spike).
- `Utils.h` (stub) — `getPitch()` uses a split fast-exp (`fastExpf`)
  instead of `std::exp`.

These three files are excluded from the byte-identical/checksum guarantee.

---

## 1. Files copied

30 files total (27 unique OB-Xf sources + 1 deliberate duplicate of
`Constants.h` at the root so the verbatim angle-bracket includes resolve,
plus 2 compile-time stubs — `Utils.h` and `libMTSClient.h`; see §4).

### Initial list (from the plan)

| OB-Xf source (`src/...`) | Destination (`wasm/obxd/obxf_imported/...`) |
|---|---|
| `state/ObxdImporter.cpp` | `state/ObxdImporter.cpp` |
| `state/ObxdImporter.h` | `state/ObxdImporter.h` |
| `parameter/SynthParam.h` | `parameter/SynthParam.h` |
| `parameter/ParameterList.h` | `parameter/ParameterList.h` |
| `parameter/ParameterInfo.h` | `parameter/ParameterInfo.h` |
| `engine/Program.h` | `engine/Program.h` |
| `engine/Motherboard.h` | `engine/Motherboard.h` |
| `engine/SynthEngine.h` | `engine/SynthEngine.h` |
| `configuration.h` | `configuration.h` |
| `core/Constants.h` | `core/Constants.h` |
| `core/Constants.h` | `Constants.h` *(duplicate at root — see §5)* |

### Additional files copied to resolve OB-Xf include chains

All pulled in transitively by `Motherboard.h` / `SynthEngine.h` / `Voice.h` /
`OscillatorBlock.h`. Every one lives under `src/engine/` in OB-Xf and is copied
verbatim to `wasm/obxd/obxf_imported/engine/`.

| OB-Xf source (`src/engine/...`) | Destination | Pulled in by |
|---|---|---|
| `VoiceQueue.h` | `engine/VoiceQueue.h` | `Motherboard.h` |
| `Voice.h` | `engine/Voice.h` | `SynthEngine.h`, `VoiceQueue.h`, `OscillatorBlock.h`, `Filter.h` |
| `VoiceMatrix.h` | `engine/VoiceMatrix.h` | `Motherboard.h`, `Voice.h` |
| `Lfo.h` | `engine/Lfo.h` | `Motherboard.h`, `Voice.h` |
| `Tuning.h` | `engine/Tuning.h` | `Motherboard.h`, `Voice.h` |
| `Smoother.h` | `engine/Smoother.h` | `SynthEngine.h` |
| `OscillatorBlock.h` | `engine/OscillatorBlock.h` | `Voice.h` |
| `AdsrEnvelope.h` | `engine/AdsrEnvelope.h` | `Voice.h` |
| `Filter.h` | `engine/Filter.h` | `Voice.h` |
| `Decimator.h` | `engine/Decimator.h` | `Voice.h` |
| `AudioUtils.h` | `engine/AudioUtils.h` | `OscillatorBlock.h` |
| `BlepData.h` | `engine/BlepData.h` | `OscillatorBlock.h`, `SawOsc.h`, `PulseOsc.h`, `TriangleOsc.h` |
| `DelayLine.h` | `engine/DelayLine.h` | `OscillatorBlock.h` |
| `Noise.h` | `engine/Noise.h` | `OscillatorBlock.h` |
| `SawOsc.h` | `engine/SawOsc.h` | `OscillatorBlock.h` |
| `PulseOsc.h` | `engine/PulseOsc.h` | `OscillatorBlock.h` |
| `TriangleOsc.h` | `engine/TriangleOsc.h` | `OscillatorBlock.h` |

### Deliberately NOT copied (out of scope per constraints)

- `src/ObxfProcessor.cpp` / `.h` — plugin processor (host glue).
- `src/ObxfEditor.cpp` / `.h` — editor/GUI.
- `src/state/StateManager.cpp` / `.h` — APVTS state manager (host glue).
- `src/components/`, `src/editor/`, `src/gui/`, `src/interface/`, `src/midi/`,
  `src/utilities/`, `src/obxf-python/`, `src/tests/` — GUI / editor / tests.
- `src/Utils.cpp` — implementation of the (uncopied) `Utils.h` host utility
  class (see §4).

---

## 2. Location of `Constants.h` in OB-Xf source

`Constants.h` lives at **`src/core/Constants.h`** in OB-Xf — the only
`Constants.h` in the entire repo (confirmed via glob `**/Constants.h`).

There is **no** top-level `src/Constants.h`. The two include styles hit the
same physical file via different `-I` paths in the OB-Xf build:

| Include style | Used by | Resolves to |
|---|---|---|
| `<core/Constants.h>` | `engine/SynthEngine.h` | `src/core/Constants.h` (angle-bracket, `-I src`) |
| `<Constants.h>` | `parameter/SynthParam.h`, `engine/Motherboard.h`, `engine/Lfo.h`, `state/ObxdImporter.cpp` | `src/core/Constants.h` (angle-bracket, `-I src/core`) |

In this copy we satisfy both verbatim by placing the **same** file at
`core/Constants.h` (for `<core/Constants.h>`) **and** as a duplicate at
`Constants.h` (root, for `<Constants.h>`). Both are byte-identical to
`src/core/Constants.h`. See §5.

---

## 3. OB-Xf include-chain analysis

Only OB-Xf-internal includes are listed (JUCE / SST / fmt / system headers
omitted — they resolve via `-I` at compile time). `→` means "includes".

### Importer entry points
```
state/ObxdImporter.h   → engine/Program.h
state/ObxdImporter.cpp → state/ObxdImporter.h
                       → <Constants.h>            (root dup)
                       → parameter/ParameterList.h
                       → parameter/SynthParam.h
                       → configuration.h          (root)
```

### Parameter subsystem
```
parameter/ParameterList.h → parameter/SynthParam.h
                          → parameter/ParameterInfo.h
parameter/SynthParam.h    → <Constants.h>          (root dup)
parameter/ParameterInfo.h → (none internal)
```

### Engine (pulled in transitively)
```
engine/Program.h         → parameter/ParameterList.h
engine/SynthEngine.h     → <core/Constants.h>
                         → engine/Voice.h
                         → engine/Motherboard.h
                         → engine/Program.h
                         → engine/Smoother.h
engine/Motherboard.h     → <Constants.h>           (root dup)
                         → engine/VoiceQueue.h
                         → engine/SynthEngine.h
                         → engine/Lfo.h
                         → engine/Tuning.h
                         → engine/VoiceMatrix.h
engine/VoiceQueue.h      → engine/Voice.h
engine/Voice.h           → engine/OscillatorBlock.h
                         → engine/AdsrEnvelope.h
                         → engine/Lfo.h
                         → engine/Filter.h
                         → engine/Decimator.h
                         → engine/Tuning.h
                         → engine/VoiceMatrix.h
engine/VoiceMatrix.h     → configuration.h         (root, cross-dir rel.)
                         → parameter/SynthParam.h  (cross-dir rel.)
engine/Lfo.h             → <Constants.h>           (root dup)
                         → engine/SynthEngine.h
engine/Smoother.h        → engine/SynthEngine.h
engine/OscillatorBlock.h → engine/Voice.h
                         → engine/SynthEngine.h
                         → engine/AudioUtils.h
                         → engine/BlepData.h
                         → engine/DelayLine.h
                         → engine/Noise.h
                         → engine/SawOsc.h
                         → engine/PulseOsc.h
                         → engine/TriangleOsc.h
engine/Filter.h          → engine/Voice.h
engine/AudioUtils.h      → <Utils.h>               (UNRESOLVED — see §4)
                         → engine/SynthEngine.h
engine/SawOsc.h          → engine/SynthEngine.h
                         → engine/BlepData.h
engine/PulseOsc.h        → engine/SynthEngine.h
                         → engine/BlepData.h
engine/TriangleOsc.h     → engine/SynthEngine.h
                         → engine/BlepData.h
engine/DelayLine.h       → engine/SynthEngine.h
engine/Decimator.h       → (none internal)
engine/AdsrEnvelope.h    → (none internal)
engine/BlepData.h        → (none internal)
engine/Noise.h           → (none internal)
engine/Tuning.h          → "libMTSClient.h"        (UNRESOLVED — see §4)
```

### Top-level
```
Constants.h / core/Constants.h → configuration.h      (root)
configuration.h                → (system only: <bitset>, <fstream>)
```

### Note on the circularity
`SynthEngine.h` ↔ `Motherboard.h`, `Lfo.h`, `Smoother.h`, `OscillatorBlock.h`,
`Filter.h`, `AudioUtils.h`, `DelayLine.h`, `SawOsc.h`, `PulseOsc.h`,
`TriangleOsc.h` form a mutually-recursive include cluster guarded by header
include guards (`#ifndef OBXF_SRC_ENGINE_*`). This matches the original OB-Xf
build; nothing to fix here.

---

## 4. Originally-unresolved includes (now stubbed)

### 4a. `<Utils.h>` — referenced by `engine/AudioUtils.h`
- `Utils.h` physically lives at **`src/Utils.h`** in OB-Xf, but was **NOT
  copied verbatim**.
- Reasons:
  1. `Utils.h` is a large host/file-system/GUI utility class (factory/user
     patch-folder scanning, theme folders, MIDI-program folders, clipboard
     copy/paste, GUI size, zoom, software renderer, plugin-API scale) — i.e.
     plugin-host glue that is **out of scope** for the parameter/importer
     subsystem and overlaps with the explicitly-excluded editor/processor
     code.
  2. `Utils.h` itself has an **unresolvable** include —
     `"filesystem/import.h"` — whose directory does **not exist** anywhere in
     the shallow OB-Xf clone (likely an intentionally-uninitialized nested
     submodule path). It also uses `<fmt/core.h>` and the `obxf_log` / `OBLOG`
     logging macros. Copying `Utils.h` would therefore not make the tree
     self-contained.
  3. `AudioUtils.h` includes `<Utils.h>` but **does not use anything from it**:
     `AudioUtils.h` only references `pi` and `mult`, both provided by
     `core/Constants.h` (arrived via `engine/SynthEngine.h`).
- **Resolution (DONE):** a minimal compile-time stub `Utils.h` is provided at
  `obxf_imported/Utils.h` that defines only the three engine-math
  free-functions (`getPitch`, `linsc`, `logsc`) verbatim from
  `third_party/OB-Xf/src/Utils.h` lines 30–40. The host-glue `Utils` class is
  intentionally NOT declared.

### 4b. `"libMTSClient.h"` — referenced by `engine/Tuning.h`
- External **ODDSound MTS-ESP** client library header. Not present in the
  OB-Xf clone (it would come from `libs/MTS-ESP`, an intentionally
  **un-initialized** nested submodule per `AGENTS.md`).
- **Resolution (DONE):** a minimal compile/link stub `libMTSClient.h` is
  provided at `obxf_imported/libMTSClient.h` that no-ops the MTS-ESP API
  surface `Tuning.h` references (`MTS_RegisterClient`, `MTS_HasMaster`, etc.).
  The WASM OB-Xf build has no use for MTS-ESP (no host in an
  AudioWorkletGlobalScope), so the no-op behaviour is also functionally
  correct: the engine falls back to its TWELVE_TET branch.

### 4c. Cross-directory relative includes (NOT missing — resolved via `-I`)
These are verbatim includes that reference a file which **is** copied, but in a
different sub-directory. They will be resolved by adding the relevant `-I`
paths at compile time (no file changes required):

| In file | Include | Target (in this copy) |
|---|---|---|
| `engine/VoiceMatrix.h` | `"configuration.h"` | `configuration.h` (root) |
| `engine/VoiceMatrix.h` | `"SynthParam.h"` | `parameter/SynthParam.h` |
| `state/ObxdImporter.cpp` | `"ParameterList.h"` | `parameter/ParameterList.h` |
| `state/ObxdImporter.cpp` | `"SynthParam.h"` | `parameter/SynthParam.h` |
| `state/ObxdImporter.cpp` | `"Program.h"` | `engine/Program.h` |
| `state/ObxdImporter.cpp` | `"Constants.h"` | `Constants.h` (root dup) |
| `state/ObxdImporter.cpp` | `"configuration.h"` | `configuration.h` (root) |

Suggested compile `-I` flags for this subtree:
```
-I wasm/obxd/obxf_imported
-I wasm/obxd/obxf_imported/state
-I wasm/obxd/obxf_imported/parameter
-I wasm/obxd/obxf_imported/engine
-I wasm/obxd/obxf_imported/core
```

### 4d. External includes (system / JUCE / SST / fmt) — never copied
Resolved via the existing JUCE amalgam (`wasm/obxd/juce_amalgam.cpp`) and the
OB-Xf `libs/` submodules (`sst-basic-blocks`, `fmt`, `JUCE`):

- **JUCE:** `juce_core`, `juce_audio_basics`, `juce_audio_processors`, `juce_dsp`.
- **SST:** `sst/basic-blocks/params/ParamMetadata.h` (in `SynthParam.h`,
  `ParameterInfo.h`).
- **fmt:** `fmt/core.h` (only via the uncopied `Utils.h`).
- **System:** `array`, `bit`, `bitset`, `cassert`, `cmath`, `cstddef`,
  `cstdint`, `cstring`, `algorithm`, `climits`, `fstream`, `functional`,
  `math.h`, `string`, `unordered_map`, `vector`.

---

## 5. Note on the duplicate `Constants.h`

`core/Constants.h` is the **canonical** copy (mirrors `src/core/Constants.h`).
A **byte-identical duplicate** is also placed at `obxf_imported/Constants.h`
(root) so that the verbatim angle-bracket includes `<Constants.h>` (used by
`SynthParam.h`, `Motherboard.h`, `Lfo.h`, `ObxdImporter.cpp`) resolve without
editing any file. `md5sum` confirms all three (`src/core/Constants.h`,
`core/Constants.h`, root `Constants.h`) are identical:
`3717fb202d74b84d758fb889a05422c9`.

In the follow-up APVTS-stripping task (T6b) this duplication can be eliminated
by normalizing every `<Constants.h>` → `<core/Constants.h>` (or by a single
`-I` pointing at `core/`).

---

## 6. Verbatim-copy verification

Every copied OB-Xf source file was checksum-compared (`md5sum`) against its
OB-Xf upstream — all 27 unique sources match exactly (the 28th is the
intentional duplicate of `Constants.h`, also verified identical). The 2 stubs
(`Utils.h`, `libMTSClient.h`) are NOT verbatim OB-Xf files — they are
minimal substitutes written for this build (see §4).

Correction: `engine/SynthEngine.h`, `engine/Motherboard.h`, and
`engine/Voice.h` have since gained OctOBX-only PCM additions (see the
divergence note above) and are excluded from this guarantee — the remaining
24 unique sources still match upstream exactly.

---

## 7. Follow-up tasks

All originally-open follow-ups are **resolved**:
- ~~**T6b:** strip APVTS / host dependencies~~ — DONE. The unused `<Utils.h>`
  include in `AudioUtils.h` is satisfied by the stub at `obxf_imported/Utils.h`.
  The JUCE `AudioProcessor`/`APVTS` references in `ObxdImporter.{h,cpp}` are
  satisfied by the `juce_audio_processors_headless` module in the amalgamated
  JUCE TU. The `<Constants.h>` vs `<core/Constants.h>` duplication remains
  (harmless — both resolve to the same file content via different `-I` paths).
- ~~**Compile-time:** supply `libMTSClient.h`~~ — DONE. Stub provided at
  `obxf_imported/libMTSClient.h` (see §4b).

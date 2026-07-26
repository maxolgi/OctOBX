# OB-Xf imported subsystem — manifest

Verbatim copy of the OB-Xf **parameter/importer subsystem** (plus the engine
header closure it pulls in) from
<https://github.com/surge-synthesizer/OB-Xf> into
`wasm/obxd/obxf_imported/`.

Source clone: `/tmp/opencode/ob-xf` (shallow `--depth 1` clone, commit as of the
copy date).

All files are **byte-identical** to the OB-Xf source (verified via `md5sum` —
no edits, no APVTS stripping). APVTS dependency stripping is a **separate
follow-up task (T6b)**.

---

## 1. Files copied

28 files total (27 unique OB-Xf sources + 1 deliberate duplicate of
`Constants.h` at the root so the verbatim angle-bracket includes resolve).

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

## 4. Unresolved includes (deliberately not copied)

### 4a. `<Utils.h>` — referenced by `engine/AudioUtils.h`
- `Utils.h` physically lives at **`src/Utils.h`** in OB-Xf, but was **NOT
  copied**.
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
- **Resolution (follow-up T6b):** either drop the unused `#include <Utils.h>`
  from `AudioUtils.h`, or provide a minimal compile-time stub for `Utils.h`.

### 4b. `"libMTSClient.h"` — referenced by `engine/Tuning.h`
- External **ODDSound MTS-ESP** client library header. Not present in the
  OB-Xf clone (it would come from `libs/MTS-ESP`, an intentionally
  **un-initialized** nested submodule per `AGENTS.md`).
- **Resolution (compile time):** point `-I` at an MTS-ESP checkout, or provide
  a stub `libMTSClient.h` that no-ops the MTS-ESP API surface `Tuning.h`
  references.

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

Every copied file was checksum-compared (`md5sum`) against its OB-Xf source —
all 27 unique sources match exactly (the 28th is the intentional duplicate of
`Constants.h`, also verified identical). **No file was modified.**

---

## 7. Follow-up tasks

- **T6b (separate task):** strip APVTS / host dependencies from this subtree —
  in particular the unused `<Utils.h>` include in `AudioUtils.h`, the JUCE
  `AudioProcessor`/`APVTS` references in `ObxdImporter.{h,cpp}`, and the
  `<Constants.h>` vs `<core/Constants.h>` duplication. Not done here.
- **Compile-time (separate task):** supply `libMTSClient.h` (stub or real) and
  the JUCE/SST `-I` paths.

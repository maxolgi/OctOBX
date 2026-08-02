# AGENTS.md

OctOBX — the Genoqs Octopus/Nemo MIDI sequencer firmware (~50k lines of C89)
compiled to **WebAssembly via Emscripten**, with a TypeScript/Vite web UI and
an in-browser multi-instance **OB-Xf synthesizer** running in an AudioWorklet.
The synth was migrated from the legacy 2DaT/Obxd OB-XD engine to the
Surge-maintained OB-Xf engine (32-voice polyphony, second LFO, MPE, ~30 more
parameters). The old `third_party/Obxd/` submodule is still vendored as a
fallback until the migration is verified in production (see Known issues).

This is the **WASM/browser port**. It is a sibling project to the native
Linux/Windows C-engine port at <https://github.com/maxolgi/Octopus>. The two
share the same firmware source and the same eCos-HAL shim concept, but this repo
targets the browser (Emscripten + Web Workers + SharedArrayBuffer), not ALSA/winmm.

## Submodules

This repo uses **four** git submodules:

- `firmware/` → <https://github.com/maxolgi/OCT_CE_OS> — Octopus + Nemo firmware
  (a fork of `genoqs-community/source`). Contains `OCT_OS/` (Octopus firmware)
  and `NEMO_OS/` (Nemo firmware) at its root — exactly the layout the Octopus
  WASM `Makefile` expects (`firmware/OCT_OS/...`, `firmware/NEMO_OS/...`).
- `third_party/Obxd/` → <https://github.com/2DaT/Obxd> — the `SynthEngine`
  source used by the in-browser multi-instance OB-XD synth (`wasm/obxd/`).
  **(Phasing out)** This is the legacy OB-XD source. It stays in place until
  the migration to OB-Xf (below) is verified, then will be removed in a
  follow-up. Do not build new synth integration against `third_party/Obxd/`;
  target `third_party/OB-Xf/` instead.
- `third_party/OB-Xf/` → <https://github.com/surge-synthesizer/OB-Xf> — the
  Surge-maintained successor to OB-XD, the target of the in-browser synth
  migration (replaces `third_party/Obxd/`). GPL-3.0-or-later. Carries
  **nested sub-submodules** under `libs/` — only the five required for a
  WASM/AudioWorklet build (see command below) need to be initialized; the
  rest (`libs/MTS-ESP`, `libs/clap-juce-extensions`, `libs/melatonin_inspector`,
  `libs/pybind11`, `libs/sst/sst-cmake`, `libs/sst/sst-plugininfra`) are for
  the desktop CLAP/VST build and are intentionally **not** initialized to save
  disk and clone time.
- `third_party/JUCE/` → <https://github.com/juce-framework/JUCE> — `juce_core`
  + `juce_audio_basics`, amalgamated into a single TU in
  `wasm/obxd/juce_amalgam.cpp`.

**First-time clone:**
```bash
git clone --recurse-submodules <repo-url>
# Or after a regular clone:
git submodule update --init --recursive
```

> **Note:** `--recurse-submodules` / `--recursive` will pull OB-Xf's full nested
> submodule tree (all 11 sub-submodules, including the desktop-only ones). To
> get a lean checkout, clone normally and then initialize submodules explicitly
> per the command below.

**Initializing OB-Xf's required sub-submodules (do this once after cloning):**
```bash
cd third_party/OB-Xf
git submodule update --init --depth 1 \
    libs/JUCE \
    libs/sst/sst-basic-blocks \
    libs/sst/sst-cpputils \
    libs/fmt \
    libs/simde
```
These five satisfy the headers referenced by OB-Xf's compile path:
`ParamMetadata.h` → `<fmt/core.h>` (`libs/fmt`), `simd/setup.h` →
`simde/x86/sse4.2.h` (`libs/simde`), `SynthParam.h` →
`<juce_audio_basics/juce_audio_basics.h>` (`libs/JUCE`), plus
`libs/sst/sst-basic-blocks` and `libs/sst/sst-cpputils` for the SST support
headers. If `--depth 1` ever fails for a particular nested submodule, retry it
without `--depth 1` for just that path.

The firmware submodule is required for the Octopus WASM build. The OB-Xf and
JUCE submodules (plus OB-Xf's five initialized sub-submodules above) are
required for the synth WASM build (`make -C wasm/obxd`). The legacy
`third_party/Obxd/` submodule is retained only as a fallback — it is no longer
on the OB-Xf build's include path and is not compiled into `obxd_wasm.wasm`.

## Build

### Prerequisites
```bash
# Emscripten SDK
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
cd ~/emsdk && ./emsdk install latest && ./emsdk activate latest
source ~/emsdk/emsdk_env.sh

# Node.js >= 23
node --version
```

### Compile the WASM engine (Emscripten)
```bash
git submodule update --init --recursive   # first time — all three submodules must exist
make -C wasm            # → wasm/build/octopus_wasm.{js,wasm}
make -C wasm NEMO=1     # Nemo variant → wasm/build/nemo_wasm.{js,wasm}
make -C wasm clean
```

### Compile the OB-Xf synth WASM (requires `third_party/{OB-Xf,JUCE}`)
```bash
make -C wasm/obxd       # → wasm/build/obxd_wasm.{js,wasm}
make -C wasm/obxd obxf-check   # syntax-only header parse (no codegen/link)
make -C wasm/obxd clean
```

The OB-Xf build requires the OB-Xf submodule **plus its five sub-submodules**
(`libs/sst/sst-basic-blocks`, `libs/sst/sst-cpputils`, `libs/simde`, `libs/fmt`,
`libs/JUCE`) initialized (see Submodules). Key compiler flags:
`-std=c++20` (mandatory — `sst-basic-blocks` static_asserts require
`__cplusplus >= 202002L`), `-msimd128` (OB-Xf DSP headers use SSE intrinsics,
shimmed to wasm SIMD via SIMDE), `-sSTACK_SIZE=1048576` (1 MB — the default
64 KB overflows during OB-Xf's static-init pass of ~230 `SynthParam::ID::*`
strings + the `ParameterList` vector), and `-sINITIAL_MEMORY=268435456`
(256 MB — each OB-Xf `SynthEngine` owns a fixed `Voice[32]` array; ten
instances allocated back-to-back exceed the old 64 MB ceiling). See the
`wasm/obxd/Makefile` comment block for the full rationale of each flag.

### Install TypeScript deps + run dev server
```bash
npm install
npx vite --host 0.0.0.0 --port 8080   # HTTPS dev server with COOP/COEP headers
# or the plain-HTTP COOP/COEP server (localhost is a secure context):
python3 serve.py                       # http://localhost:8080
```

### Build everything (Octopus WASM + OB-Xf WASM + app)
```bash
./build.sh          # all three
./build.sh wasm     # Octopus engine WASM only
./build.sh synth    # OB-Xf synth WASM only (+ patches.h generation)
./build.sh app      # TypeScript app only
```

`build.sh synth` also runs `xxd -i` over the 10 `.fxp` files in
`wasm/obxd/patches/` to generate `wasm/obxd/patches.h` (gitignored), which
`main_obxd.cpp`'s `__has_include("patches.h")` guard picks up so
`obxd_set_factory_patch()` loads real presets instead of the programmatic
fallback.

Open the URL you started. With Vite, accept the self-signed cert warning
(needed because SharedArrayBuffer requires a secure context). With `serve.py`
on `localhost`, the browser treats it as a secure context already.

## Architecture: single translation unit

**Critical:** `wasm/main_wasm.c` `#include`s all firmware `.h` files into one
translation unit, matching the original firmware's architecture. The original
`.c` files in `firmware/OCT_OS/_OCT_objects/` and
`firmware/OCT_OS/_OCT_global/flash-block.c` are `#include`d directly via the
firmware headers — they are NOT compiled separately and NOT listed in `SRCS`.

Only these files in `wasm/` are compiled as `SRCS` (still into one TU by `emcc`):
- `main_wasm.c` — async entry point, sequencer pthread, exported functions
- `hal_wasm.c` — eCos HAL shim (pthreads, ring-buffer mbox, nanosleep)
- `midi_wasm.c` — MIDI event ring buffer (replaces ALSA/winmm MIDI backend)
- `flash_file.c` — file-based persistence (copied from the native port; works
  with Emscripten's MEMFS/IDBFS virtual filesystem)
- `hal_linux.h` — modified copy of the native `hal_linux.h` with
  `#elif defined(__EMSCRIPTEN__)` guards (no socket/timerfd/ioctl/mman headers,
  ring-buffer mailbox type, `emscripten_get_now()` clock, OSC excluded)

The OB-Xf synth is a **separate emcc build** under `wasm/obxd/` (its own TUs;
does not share the Octopus single-TU build):

- `main_obxd.cpp` — 10 `SynthEngine` instances, summed + soft-clipped
  (`x/(1+|x|)`), instance-aware exports (`obxd_*`).
- `juce_amalgam.cpp` — single-TU amalgamation of `juce_core` +
  `juce_events` + `juce_audio_basics` + `juce_audio_processors_headless`. The
  OB-Xf engine's `SynthEngine.h` → `Program.h` → `ParameterList.h` →
  `SynthParam.h` chain reaches `juce::AudioParameterFloat` /
  `juce::AudioProcessorParameter`, which live in JUCE 8's GUI-free
  `juce_audio_processors_headless` split. MUST be its own TU (JUCE refuses to
  compile when its `.h` was already included in the same TU). `#undef __linux__`
  before including JUCE so `TargetPlatform.h`'s `#elif defined(__wasm__)` branch
  fires.
- `obxf_imported/state/ObxdImporter.cpp` — the OB-Xf parameter/importer
  subsystem (compiled as a third TU). Lives under the curated OB-Xf header
  subtree (see below).
- **Curated OB-Xf header subtree** at `wasm/obxd/obxf_imported/` (28 files,
  byte-identical copies from `third_party/OB-Xf/src/...` — see
  `obxf_imported/MANIFEST.md`). Holds `engine/SynthEngine.h`, `engine/Program.h`,
  `parameter/SynthParam.h`, `parameter/ParameterList.h`, `state/ObxdImporter.{h,cpp}`,
  plus the supporting `Motherboard.h`, `Voice.h`, `VoiceMatrix.h`, `Lfo.h`, etc.
  Two deliberate stubs substitute for deps not pulled into the browser build:
  `Utils.h` (empty) and `libMTSClient.h` (MTS-ESP stub). This curated subtree is
  the ONLY OB-Xf source root on the include path — `third_party/OB-Xf/src`
  itself is intentionally NOT added (it would pull in GUI/host deps).
- `Makefile` — `-sENVIRONMENT=worker` (AWP), no `-pthread` (pthreads are illegal
  inside AudioWorkletGlobalScope), `-sFORCE_FILESYSTEM=0` (bytes go via
  `_malloc` + `HEAPU8.set`).

See README "OB-Xf synth — WASM source" for the full file/function reference.

## How the firmware is reused unchanged

The WASM build defines **`-D__linux__`** and **`-D__EMSCRIPTEN__`**:

- `-D__linux__` makes the existing firmware preprocessor guards route
  `MIDI_send()` to our `midi_send_event()` and suppress hardware-specific code.
  **No firmware source changes are needed beyond the guards already present** in
  `firmware/` (see the `patches/` history in the upstream fork).
- `-D__EMSCRIPTEN__` routes platform-specific code to the WASM implementations
  in `hal_wasm.c`, `midi_wasm.c`, and `main_wasm.c` (via `hal_linux.h` guards).

When you must touch a firmware file, use `#ifdef __linux__` /
`#ifdef __EMSCRIPTEN__` / `#ifndef __linux__` guards — never unconditional edits.

## How the OB-Xf synth engine is integrated

The OB-Xf synth (from the Surge-maintained `third_party/OB-Xf/` submodule)
replaces the legacy 2DaT/Obxd OB-XD engine. Unlike the Octopus firmware, the
engine is NOT compiled unchanged — it is **curated** into the browser build:

- **Curated header subtree** — `wasm/obxd/obxf_imported/` holds 28
  byte-identical copies of the OB-Xf `SynthEngine`/`Program`/`ObxdImporter`/
  `ParameterList`/`SynthParam` subsystem (see `obxf_imported/MANIFEST.md`).
  This is the ONLY OB-Xf source root on the include path; the submodule's own
  `src/` is intentionally excluded (it pulls in GUI/host deps). Two stubs
  substitute for deps not in the browser build: `Utils.h` (empty) and
  `libMTSClient.h` (MTS-ESP stub).
- **SST basic-blocks + SIMDe** — `libs/sst/sst-basic-blocks` provides the
  `ParamMetaData` consumed by `SynthParam.h`/`ParameterList.h`, and
  `simd/setup.h` shims SSE intrinsics to wasm SIMD via `libs/simde`.
- **Multi-instance** — `main_obxd.cpp` instantiates 10 `SynthEngine`s sharing
  one WASM heap, summed + soft-clipped per quantum. All exports are
  instance-aware (`obxd_*(instance_id, …)`).
- **Parameter dispatch** — the UI/`.fxp` layer still speaks the OLD OB-Xd
  integer param indices 0..79 (frozen `ParamsEnum.h` order). `apply_param_instance()`
  in `main_obxd.cpp` dispatches those legacy indices onto the NEW OB-Xf
  `processX()` methods, applying the rescales documented in
  `wasm/obxd/obxf_param_mappings.h` (and mirrored 1:1 in
  `src/obxf-param-mappings.ts`, which is auto-generated from
  `obxf_imported/state/ObxdImporter.cpp` — the canonical OB-Xd→OB-Xf translator).
  OB-Xf-only params with no legacy ancestor (the second LFO, MPE matrix, slop,
  per-voice pan, xpander mode, ~28 in total) are rendered by the data-driven
  OB-Xf editor UI (`src/obxf-layout.ts`) and assigned a sentinel index
  `NEW_PARAM_BASE ≥ 200` in `src/obxd-synth-ui.ts`. The C engine dispatches
  these via `apply_new_param_instance()` (a separate switch for idx ≥ 200)
  and mirrors their values in `g_new_param_mirror` so the knob UI syncs
  correctly after `.fxp` load / instance switch.

## PCM drum engine

Instance 9 of the OB-Xf synth is the dedicated drum sampler: 32-voice
polyphony, 8 pads × 4 layers. PCM samples are loaded as float mono arrays into
`pcmBank[8][4]` in `Motherboard.h`. When a MIDI note mapped to a pad arrives,
`setNoteOn()` assigns voices to all enabled layers (layered, NOT
round-robin). Each voice plays its PCM sample through the OB-Xf filter + amp
chain (independent from the oscillator path).

**C-side data flow:**

- `Motherboard::assignPcmLayer(v, pad, layer)` stamps the voice: sets
  `pcmActive=true`, `pcmData`/`pcmLen` from `pcmBank`, `pcmGain`/`pcmPan`/
  `pcmRate` from the layer def, and applies the layer's independent filter
  (cutoff/res/mode) + amp envelope (ADSR).
- `Voice::ProcessSample()` linearly interpolates the PCM buffer at
  `pcmPos += pcmRate`, crossfades with the oscillator output
  (`osc = osc*(1-gain) + pcm*gain`), then runs the result through the filter
  and amp as usual.
- Choke groups (`pcmChokeGroup[8]`) allow classic hi-hat cut behavior — a
  new hit on a pad in the same choke group stops all prior voices in that
  group before playing.

**Param routing (two paths):**

1. **Global/structural params** (Volume, HQ, LFO1 rate/wave) → route live to
   instance 9 via `apply_param_instance(9, idx, v)` when
   `obxd_set_drum_layer_param` detects `is_global_drum_param(idx)`.
2. **Voice-level params** (filter, envs, LFO routings) → stored in
   `g_drum_layer_params[pad][layer][idx]`, applied to each triggered voice
   on the next note-on (via `apply_drum_layer_params_for_instance`).

**Per-layer Gain, Pan, Pitch** bypass `g_drum_layer_params` entirely — they
are PCM-specific fields in `pcmBank[pad][layer]` (C side) and `DrumLayer`
objects (TS side). Pushed via `sendLayerParams` → `set_pcm_layer` →
`setPcmLayerParams`. Pitch knob (0..1) maps to playback rate
`2^((v-0.5)*2)` (±1 octave, 0.5 = original).

**Kit presets** (`drum-kits.ts`) source samples from the Public Domain
smpldsnds CDN. Secondary layers default to `gain: 0.55, filterCutoff: 0.8`
(quieter + darker). Closed HH + Open HH share choke group 0.

## eCos compatibility shim

`wasm/hal_linux.h` + `wasm/hal_wasm.c` provide all the eCos types, macros, and
`cyg_*` functions the firmware expects. This is the linchpin that lets ~50k
lines of original firmware compile unchanged for the browser.

Key mappings: `cyg_thread_*` → pthread (Emscripten pthreads → Web Workers),
`cyg_mbox_*` → ring buffer (mutex + condition variable), `cyg_mutex_*` →
`pthread_mutex_t` (recursive for the scheduler lock), `cyg_semaphore_*` →
`sem_init/post/wait`, `cyg_alarm_*` → watcher threads with `nanosleep`,
`diag_printf` → `vfprintf(stderr)`. In-memory flash buffer mirrors the native port.

**HANDLE conflict:** the firmware defines `HANDLE` as 5 (a display mode constant
in `defs_general.h`). Don't rely on a Win32-style `HANDLE` here.

## Runtime architecture (browser)

```
Browser (COOP/COEP/CORP cross-origin isolated)
├── Main Thread
│   ├── Octopus UI (classic panel or modern grid)
│   ├── Drum UI (kit selector, 8 pads × 4 layers, knob strips)
│   ├── MIR rendering (60Hz RAF → reads WASM heap via HEAPU8)
│   ├── OB-Xf rack + editor UI (instance selector, knobs, meters, .fxp loader, MIDI-learn)
│   ├── Single 60Hz MIDI drain loop (RAF) → fans each batch out to:
│   │   • HardwareMidiOutput  → Web MIDI output port
│   │   • OB-Xf bridge (obxd-bridge.ts) → AudioWorklet (per-instance)
│   └── Transport controls + state persistence (Tab cycles 4 views)
├── WASM Module — Octopus engine  (octopus_wasm.wasm)
│   ├── Firmware core (~50k lines, unchanged)
│   ├── hal_wasm.c / midi_wasm.c / main_wasm.c
└── Web Worker (pthread)
    └── Sequencer thread (48 PPQN, nanosleep timing)

AudioWorklet — OB-Xf synth  (obxd_wasm.wasm, separate emcc build)
├── main_obxd.cpp — 10 SynthEngine instances summed + soft-clipped
│   └── Instance 9 = dedicated drum sampler (32 voices, 8 pads × 4 layers,
│       PCM sample playback mixed into the OB-Xf filter/amp chain)
└── PCM sample bank (pcmBank[8][4] in Motherboard.h, float mono samples)
```

- **pthreads** — the sequencer runs in a Web Worker via Emscripten pthreads.
  Requires SharedArrayBuffer, which requires COOP/COEP/CORP headers on a secure
  context (HTTPS or localhost). Both `vite.config.ts` and `serve.py` send these
  headers; the self-signed certs live in `certs/` (gitignored, regenerate per
  machine — see README).
- **Single drain loop, multiple consumers** — one 60Hz RAF in `midi-output.ts`
  pulls batches from the WASM ring buffer (`wasm_drain_midi_batch`) and fans
  them out. Today's consumers are hardware MIDI output and the OB-XD bridge;
  additional consumers plug in via the `BatchDrainHandler` type in `main.ts`.
- **Direct MIR access** — JS reads the 170-byte MIR array
  (`unsigned char MIR[2][17][5]`) directly from WASM linear memory via `HEAPU8`.
  No serialization. `VIEWER_show_MIR()` is a no-op in the WASM build.
- **OB-Xf in a separate WASM module inside an AudioWorklet** — the synth has
  its own emcc build (`-sENVIRONMENT=worker`, no pthreads). WASM bytes are
  pre-fetched on the main thread and passed via `processorOptions.wasmBinary`
  to sidestep emcc's broken-in-AWP fetch paths.

## Exported C functions (`EMSCRIPTEN_KEEPALIVE`)

**Octopus engine** (`main_wasm.c`):

Input/state: `engine_init`, `wasm_key_press`, `wasm_rotary`, `wasm_transport`,
`wasm_set_tempo`, `wasm_pause`, `wasm_shutdown`, `wasm_save_state`,
`wasm_load_state`.

MIR/state out: `get_mir_ptr`, `get_processed_mir_ptr`, `get_run_bit`,
`get_tempo`, `get_zoom_level`, `page_refresh`, `wasm_get_tick_ns`,
`wasm_get_sequencer_running`, `wasm_get_tick_count`.

**Octopus engine** (`midi_wasm.c`): `wasm_has_midi_event`, `wasm_get_midi_event`,
`wasm_midi_input`, `wasm_drain_midi_batch`, `get_midi_batch_events_ptr`,
`get_midi_batch_ts_ptr`, `wasm_get_midi_dropped_count`.

**OB-XD synth** (`wasm/obxd/main_obxd.cpp`): `obxd_init`, `obxd_render`,
`get_buf_l_ptr` / `get_buf_r_ptr`, `obxd_set_active` / `obxd_get_active`,
`obxd_set_polyphony` / `obxd_get_polyphony`, `obxd_midi_in`, `obxd_set_gain`,
`obxd_set_param` / `obxd_get_param`, `obxd_load_fxp`, `obxd_all_notes_off`,
`obxd_panic`, `obxd_panic_all`, `obxd_reset_patch`, `obxd_get_patch_name`,
`obxd_set_factory_patch`, `obxd_get_instance_rms`, `obxd_set_freq` (no-op),
`obxd_set_mpe` (per-instance MPE flag — stores `g_mpe_enabled[id]`; actual
per-channel MPE routing through the bridge is wired in `obxd-bridge.ts`). All
instance-aware except `obxd_panic_all`. See README "OB-Xf synth — WASM source"
for the full table.

**OB-Xf PCM drum engine** (`wasm/obxd/main_obxd.cpp`):
`obxd_load_pcm`, `obxd_set_pcm_layer` (gain/cutoff/res/mode/amp-env/pan/pitch),
`obxd_set_pcm_note_map`, `obxd_set_pcm_layer_count`, `obxd_set_pcm_choke`,
`obxd_clear_pcm`, `obxd_set_drum_layer_param` / `obxd_get_drum_layer_param`
(per-layer voice-level param mirror for instance 9; global params route live
via `apply_param_instance(9, …)`). Instance 9 is the dedicated drum instance
(32 voices, 8 pads × 4 layers). See "PCM drum engine" section below.

> **Note on reserved CCs:** mod wheel (CC 1), sustain pedal (CC 64), all-sound-off
> (CC 120), and all-notes-off (CC 123) are available BOTH inside `obxd_midi_in()`'s
> CC switch (CC 1 → `processModWheel`, CC 64 → `sustainOn()`/`sustainOff()`, CC 120 →
> `allSoundOff()`, CC 123 → `allNotesOff()`) AND as dedicated per-instance
> exports `obxd_set_mod_wheel(id, v)` / `obxd_set_sustain(id, on)` for direct
> routing from the MIDI-learn integration layer. `obxd_set_factory_patch`
> now loads real `.fxp` files from `wasm/obxd/patches/` (10 CC0 patches); when
> `patches.h` is absent it falls back to the programmatic init patch.
> `obxd_load_fxp` parses both the legacy OB-Xd integer schema AND the native
> OB-Xf named-attribute XML schema (`Volume="0.5"` …), plus the `VC2!` wrapper.

The `EMSCRIPTEN_KEEPALIVE` functions are mirrored by the TypeScript interface in
`src/octopus-types.ts` and must be listed in `-sEXPORTED_FUNCTIONS` in the
Makefile. **When you add or rename an Octopus export, update all three places**
(the C definition, `octopus-types.ts`, and the Makefile `EXPORTED_FUNCTIONS`
list), then rebuild the WASM module. (OB-XD exports are looked up dynamically by
name in `obxd-audio.ts`, so they don't need to be in the Octopus Makefile's
`EXPORTED_FUNCTIONS`.)

Note: the firmware MIDI input interpreters (`G_midi_interpret_NOTE_ON`,
`G_midi_interpret_BENDER`, `G_midi_interpret_CONTROL`) are byte-at-a-time state
machines, not message-level handlers. `wasm_midi_input()` feeds bytes
sequentially after setting the running status byte.

## TypeScript source (`src/`)

| File | Role |
|---|---|
| `main.ts` | Entry point: SharedArrayBuffer check → load WASM → `engine_init()` → build UI → transport/persistence → hardware MIDI → OB-XD rack → drum module mount. The single 60Hz MIDI drain loop is started before the panel so events flow before any DOM update consumes the frame. Tab key cycles the 4 views (classic → modern → synth → drums); Shift+Tab reverses. Skips when focus is on a form control (`<input>`/`<select>`/`<textarea>`). |
| `octopus-types.ts` | TS interface matching the C `EMSCRIPTEN_KEEPALIVE` exports |
| `octopus-module.ts` | Loads the WASM module (dynamic `<script>`, `locateFile`, IDBFS mount attempt) |
| `classic-panel.ts` | Faithful port of the Octopus control surface (same DOM/IDs as `web_gui.html`); direct WASM calls instead of WebSocket |
| `octopus-panel.ts` | Simplified modern grid view (alternative panel) |
| `midi-access.ts` | Shared `openMidiAccess()` + `pollForPorts()` — works around the Chrome-on-Linux late port-enumeration quirk (see MIDI section). |
| `midi-output.ts` | Web MIDI API **output** (Chrome/Edge); `frameMidi()` emits correct 1/2/3-byte messages; owns the single 60Hz RAF drain loop (`drainMidiToHardware`) that fans batches out to parallel consumers via `BatchDrainHandler`; `rescan()`. |
| `midi-input.ts` | Web MIDI API **input** (Chrome/Edge); forwards hardware messages to `wasm_midi_input()`; `rescan()`. |
| `obxd-audio.ts` | Main-thread bootstrap + per-instance API for the OB-XD AudioWorklet (10 SynthEngine instances). Pre-fetches WASM bytes, passes via `processorOptions.wasmBinary`; one-shot reply router for async worklet RPCs. Adds `setObxdInstanceMpe` for per-instance MPE flag mirroring to `g_mpe_enabled[id]`. |
| `obxd-bridge.ts` | Drain-loop consumer → OB-XD AudioWorklet. Channel→instance routing (default 1–10 → 0–9, reassignable), now MPE-aware via `buildChannelToInstance()` — an instance with MPE enabled claims a lower zone (master + N voice channels) before non-MPE instances fill the remaining channels. Re-exports `BatchDrainHandler`. |
| `obxd-rack.ts` | OB-XD panel UI: instance selector, power/polyphony/channel, meter (30Hz ping/pong), `.fxp` loader, Reset/Panic/Panic-All. Adds per-instance MPE toggle + bend-range UI. Lazy AudioContext init on first PLAY. |
| `obxd-synth-ui.ts` | Data-driven OB-Xf editor panel (104 parameter-bound controls) rendered from `obxf-layout.ts`; absolute-positioned inside a 1150×576 canvas. Legacy-indexed controls dispatch via `setObxdInstanceParam(idx, v)`; OB-Xf-only controls get a sentinel `NEW_PARAM_BASE ≥ 200` index dispatched via `apply_new_param_instance()`. `syncObxdControlsFromEngine(instanceId)` re-seeds widget positions from `g_param_mirror` (legacy) and `g_new_param_mirror` (NEW params) on instance switch / patch load. |
| `obxd-knob.ts` | Vanilla SVG widget factories (no deps): `createObxdKnob`, `createObxdToggle`, `createTriStateButton`, `createSelector`, `createSlider`, `createButton`. Drag/wheel/double-click (reset) on knobs; bipolar knobs supported. |
| `obxf-layout.ts` | OB-Xf editor UI layout spec — read-only data module auto-extracted from the OB-Xf source tree (theme.xml + `ObxfEditorLayout.cpp` + `SynthParam.h` + `ParameterList.h`). 173 `ControlSpec` entries (104 parameter-bound + 69 special widgets) across 13 sections, plus `obxfTheme` color tokens and the 1150×576 canvas geometry. See the file header for the explorer provenance + "do not edit by hand" warning. |
| `obxf-param-mappings.ts` | OB-Xd legacy `ParamsEnum.h` index → OB-Xf `SynthParam::ID` translation table (82 rows; `BENDRANGE` split into `PitchBendUp` + `PitchBendDown` counts twice). Auto-generated from `obxf_imported/state/ObxdImporter.cpp` (the canonical translator) + both `SynthEngine.h` headers. Each row carries the rescale rule and notes any semantic shift / type change / removal. |
| `obxf-midi-learn.ts` | OB-Xf MIDI-learn **logic** layer (no UI): standalone port of the OB-Xf `MidiHandler`/`MidiMap` state machine. CC→0..1 transforms (`ccTo01`), learn-then-apply same-message path, lag smoother, reserved-CC pre-screening. Framework-free; persistence + UI wiring live in the integration module. |
| `obxf-midi-learn-integration.ts` | Singleton `ObxfMidiLearnManager` + per-param registry (`SynthParam::ID` → legacy index + transform hints). `processHardwareCC()` is the single entry point `midi-input.ts` calls before forwarding a CC — returns true when consumed by learn. Bindings persist to localStorage; auto-save on every learn/unlearn. |
| `obxf-midi-learn-ui.ts` | MIDI-learn **overlay** UI: renders the OB-Xf `midiLearnButton` at its layout position (196, 415), paints per-knob `CC{n}` badges above bound controls, toggles the red panel-border learn-mode indicator, click-badge-to-unlearn. |
| `obxd-processor.tail.js` | Plain JS appended to emcc output to form `obxd-processor.js` for `audioWorklet.addModule()`. Subclasses `AudioWorkletProcessor`. |
| `obxd-awp-shim.js` | Plain JS prepended to emcc output; polyfills `self`/`location`/`fetch`/`performance` for AudioWorkletGlobalScope. |
| `transport-sync.ts` | Wires PLAY/STOP/BPM to the Octopus engine + transport indicator. |
| `state-persistence.ts` | Octopus sequencer state save/load via IDBFS (Emscripten's IndexedDB FS). SAVE triggers `_wasm_save_state` → MEMFS + `FS.syncfs(false)` → IDBFS. Shift+SAVE also downloads .bin + JSON. LOAD imports .bin files. Shift+LOAD clears IDBFS + app state. |
| `app-state.ts` | Synth + drum state persistence. Dumps all synth (10×108) and drum (8×4×108) params from the AWP in bulk, plus per-instance settings and drum kit, to localStorage JSON. Restores after AWP ready via `onAWPReady` callback. |
| `drum-rack.ts` | Drum module UI: kit selector, 8 pads × 4 layers with sample-name selectors + mute/enable toggles, and per-layer knob strips (48 controls: 8 global + 40 per-layer). SVG arc knobs with iOS-style toggle pills and tri-state LFO-routing pills. Layer section has Gain/Pan/Pitch knobs with custom dispatch (bypass `g_drum_layer_params`, update `DrumLayer` TS object + `pushLayer` → `set_pcm_layer`). `syncEditor`/`syncKnobStrips` re-seed knob positions from the worklet mirror on pad/layer switch. |
| `drum-audio.ts` | Main-thread audio bootstrap for the drum module on OB-Xf instance 9 (32 voices). `loadDrumKit` fetches samples from smpldsnds CDN, decodes via `AudioContext.decodeAudioData`, posts float arrays to the worklet via `obxd_load_pcm`. Serialized via `kitLoadChain` promise chain (prevents concurrent loads). `sendLayerParams` pushes per-layer params (gain, filter, amp env, pan, pitch). `seedLayerMirror` seeds `g_drum_layer_params` on load. `pushLayer` re-sends one layer's full param set. |
| `drum-state.ts` | Pure data layer: `DrumLayer` / `DrumPad` / `DrumKit` interfaces + factory functions. No project dependencies. `DrumLayer` fields: enabled, sampleName, gain, filterCutoff/Resonance/Mode, amp ADSR, pan, pitch (0..1, 0.5=original), muted, `_seeded` flag. |
| `drum-kits.ts` | 10 drum-kit presets sourced from the Public Domain smpldsnds CDN. Each kit maps its samples onto 8 GM pads (Kick, Snare, Closed HH, Open HH, Tom Lo, Clap, Cowbell, Ride). Secondary layers get `gain: 0.55, filterCutoff: 0.8` (quieter + darker than primary `0.85 / 1.0`). Closed HH + Open HH share choke group 0. |

Input conventions: `skey(key, press)` → `module._wasm_key_press(key, press)`;
rotary knobs → `module._wasm_rotary(idx, dir)`; drag-paint step pads
(mouse + touch); Ctrl-click hold mode.

## MIDI (hardware I/O)

Real MIDI is a first-class feature, wired through the Web MIDI API (Chrome/Edge
only). Two independent directions, plus the OB-XD bridge fan-out and the MIDI-learn
overlay:

- **Output** (`midi-output.ts`) — `drainMidiToHardware()` is a 60Hz RAF loop that
  pulls 32-bit packed events from the WASM ring buffer and sends them to the
  selected Web MIDI output port. **Framing matters**: `frameMidi()` emits 1-byte
  system real-time (clock `0xF8`, start `0xFA`, stop `0xFC`), 2-byte (program
  change `0xC0` / channel pressure `0xD0`), and 3-byte channel voice. Sending the
  wrong length corrupts the stream to hardware synths.
- **Input** (`midi-input.ts`) — `HardwareMidiInput` attaches `onmidimessage` to the
  selected input port and forwards `(status, d1, d2)` to `wasm_midi_input()`,
  which drives the firmware's `G_midi_interpret_*` byte-at-a-time interpreters.
  Sysex / active-sensing / tune-request are dropped. The browser decodes
  running-status, so every message arrives with an explicit status byte. CCs are
  also fed to `processHardwareCC()` (MIDI-learn) *before* forwarding — see below.
- **OB-XD bridge** (`obxd-bridge.ts`) — same drain loop, fans out to the
  AudioWorklet synth by channel → instance routing. Non-MPE: default 1–10 → 0–9;
  MPE-aware: an instance with MPE enabled claims a lower zone (master + N voice
  channels) via `buildChannelToInstance()` before non-MPE instances fill the rest.
  No-ops while the synth is unpowered / not yet booted.

**MIDI learn** (OB-Xf port) — `obxf-midi-learn.ts` is a standalone port of the
OB-Xf `MidiHandler`/`MidiMap` state machine; `obxf-midi-learn-integration.ts` is
the singleton manager that wires it into the browser. Click the `midiLearnButton`
in the OB-Xf panel to enter learn mode (red panel border), then move a hardware
control to bind it to the last-clicked knob. `processHardwareCC()` (called by
`midi-input.ts` before forwarding) returns `true` when a CC is consumed by learn
so the Octopus engine doesn't also see it. Bindings persist to localStorage and
auto-save on every learn/unlearn; click a knob's `CC{n}` badge to unlearn.

**Reserved CCs** — mod wheel (CC 1), sustain pedal (CC 64), all-sound-off
(CC 120), and all-notes-off (CC 123) are not learnable; they route to dedicated
OB-Xf engine methods inside `obxd_midi_in()` (CC 1 → `processModWheel`, CC 64 →
`sustainOn()`/`sustainOff()`, CC 120 → `allSoundOff()`, CC 123 → `allNotesOff()`).
They are NOT separate per-instance C exports. The OB-Xf learn layer also
pre-screens CC 0/6/38/74/100/101 (bank select, RPN/NRPN data entry, MPE timbre).

**MPE** — per-instance MPE is enabled via the rack UI toggle
(`setObxdInstanceMpe(id, enabled)`), which mirrors `g_mpe_enabled[id]` to the
engine and rebuilds the channel→instance routing so the instance claims a lower
zone. The OB-Xf engine's note handlers are channel-aware (`obxd_midi_in` reads
the channel from the MIDI status byte when `g_mpe_enabled[id]` is set), and
per-channel pitch bend *expression* (`processMPEPitch`) is routed in
`obxd_midi_in()` when MPE is enabled. The remaining follow-up is MPE timbre
(CC 74) and channel-pressure — see Known issues.

**Chrome-on-Linux late enumeration** — after the MIDI permission is granted, the
*first* `requestMIDIAccess()` delivers ports via `statechange` events. On
*reload* (permission already granted) no `statechange` fires and the call can
resolve with **empty** input/output maps — so the selectors stay "None".
`midi-access.ts` `pollForPorts()` repopulates every 250ms (up to 4s) until ports
appear. There is also a `↻ Rescan` button (`#oct-midi-rescan`) that calls
`rescan()` on both classes for hotplug/recovery.

UI selectors: `#oct-midi-output`, `#oct-midi-input`, `#oct-midi-rescan`
(in `index.html` transport bar).

## MIR (Matrix Intermediate Representation)

`unsigned char MIR[2][17][5]` in WASM linear memory — 170 bytes total. Each row
(17 per set, 2 sets) is 5 bytes: byte 0 = blink/selector flags, byte 1 = red LED
bits (8 columns), byte 2 = green LED bits, bytes 3–4 = additional flags.

JS access: `const mb = (s, r, c) => mir[s * 85 + r * 5 + c];` LED color values:
0 = off, 2 = red, 4 = green, 6 = amber.

## Sequencer timing

48 PPQN. At 120 BPM one tick ≈ 10.4 ms (`g_tick_ns = 10416667`). The sequencer
pthread uses relative `nanosleep` (Emscripten implements via `Atomics.wait`,
~1 ms resolution). No busy-wait.

## C language and compiler flags

Standard: **gnu89** (not C99+). Many warnings suppressed in the Makefile:
`-Wno-unused-function -Wno-unused-variable -Wno-unused-but-set-variable
-Wno-implicit-int -Wno-int-conversion`. Cross-variant via `-DNEMO`. Cross-platform
via the `__linux__` / `__EMSCRIPTEN__` defines.

## Testing

**Automated:** `npm test` runs vitest over the pure-logic modules
(`midi-framing.ts`, `channel-routing.ts`, `obxf-midi-learn.ts`,
`obxf-param-mappings.ts`) — 67 tests, no browser required.

**Manual:** build the WASM modules, run the dev server, and verify in the
browser console:
- Transport play/stop produces ticks (`wasm_get_tick_count()` increments).
- Step toggles light MIR LEDs at 60 Hz.
- MIDI events appear in the ring buffer
  (`wasm_get_midi_dropped_count()` stays at 0 under normal load).
- Hardware MIDI output via Web MIDI (Chrome/Edge) reaches a synth.
- Hardware MIDI input drives the sequencer (controller → `wasm_midi_input`
  → `G_midi_interpret_*`).
- OB-Xf: clicking PLAY brings up the AudioWorklet, Octopus channels 1–10
  drive the 10 instances, switching the instance selector re-syncs knob
  positions, loading a `.fxp` changes one instance's sound only.

## Known issues

1. **IDBFS** — fixed. Was accessing `module.IDBFS` (undefined — not in
   `EXPORTED_RUNTIME_METHODS`) instead of `FS.filesystems.IDBFS`. Now
   mounts IDBFS at `/persistent/` and persists automatically.
2. **OB-Xf factory patches now ship** — 10 CC0/Public Domain OB-Xf presets
   live in `wasm/obxd/patches/` (`01_pad.fxp` … `10_kick.fxp`), sourced from
   the Surge Synth Team OB-Xf factory library. `build.sh synth` runs `xxd -i`
   over them to generate `wasm/obxd/patches.h` (gitignored), and
   `main_obxd.cpp`'s `__has_include("patches.h")` guard routes
   `obxd_set_factory_patch()` through `load_fxp_data()`. The loader parses the
   native OB-Xf named-attribute XML schema (`Volume="0.5"` …) 1:1 onto the
   matching `processX()` methods with NO rescale, plus handles the `VC2!`
   wrapper and legacy OB-Xd integer schema as a fallback. To swap patches,
   replace the `.fxp` files in `patches/` (keep the `NN_name.fxp` naming so
   the `g_factory_patches` symbol table matches) and rebuild.
3. **MPE timbre & channel pressure not wired** — `obxd_midi_in()` already
   routes per-channel pitch bend through `processMPEPitch(channel, val)` and
   note on/off through the channel-aware `processNoteOn/Off` when
   `g_mpe_enabled[id]` is set. The remaining gap is that
   `SynthEngine::processMPETimbre(channel, val)` and
   `processMPEChannelPressure(channel, val)` exist but aren't dispatched from
   `obxd_midi_in()` — MIDI CC 74 (timbre) and channel-pressure (0xD0) messages
   have no handler there yet.
4. **`third_party/Obxd/` still present** — the legacy 2DaT/Obxd submodule is
   kept as a fallback until the OB-Xf migration is verified in production. It
   is no longer on the OB-Xf build's include path and is not compiled into
   `obxd_wasm.wasm`; it will be removed in a follow-up commit.
5. **AudioWorklet reply correlation** is correct but untyped — `obxd-audio.ts`
   uses an `unknown`-typed predicate router to avoid racing `port.onmessage`
   reassignments.
5. **Limited automated tests** — vitest covers the pure-logic modules
   (`midi-framing.ts`, `channel-routing.ts`, `obxf-midi-learn.ts`,
   `obxf-param-mappings.ts`); run with `npm test`. The WASM engine and
   browser-integration paths still require manual verification (see Testing).

## License

OctOBX is GPL-3.0-or-later (see [`LICENSE`](./LICENSE)). The OB-Xf `SynthEngine`
is GPL-3.0-or-later, so GPL-3.0-or-later keeps the combined work license-compatible.
The firmware, OB-Xf, and JUCE submodules each carry their own license — see
the License section in README for the table.

## Reference docs in repo

- `README.md` — full project documentation (architecture, source-file specs,
  OB-Xf integration, HTTPS/COOP-COEP, MIR format, known issues).
- `firmware/OCT_OS/COPYING.txt`, `firmware/OCT_OS/FACTORY_RESTORE.txt` —
  firmware license and factory-restore notes from the OCT_CE_OS submodule.

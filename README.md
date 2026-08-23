# OctOBX — Octopus/Nemo sequencer + OB-Xf synth, in the browser

The Genoqs Octopus/Nemo MIDI sequencer firmware (~50k lines of C89) compiled
to **WebAssembly via Emscripten**, with a TypeScript/Vite web UI, a built-in
multi-instance **OB-Xf synthesizer** running in an `AudioWorklet`, and
hardware MIDI I/O via the Web MIDI API. The synth runs the Surge-maintained
OB-Xf engine (32-voice polyphony, second LFO, MPE) instead of the legacy
2DaT/Obxd OB-XD engine.

This is the WASM/browser port. It is a sibling project to the native
Linux/Windows C-engine port at <https://github.com/maxolgi/Octopus>. The two
share the same firmware source and the same eCos-HAL shim concept, but this
repo targets the browser (Emscripten + Web Workers + SharedArrayBuffer +
AudioWorklets), not ALSA/winmm.

## What's in the box

- **Octopus/Nemo sequencer** — original firmware, unmodified, running in a
  pthread (Web Worker) at 48 PPQN.
- **OB-Xf synth rack** — 10 concurrent `SynthEngine` instances from the
  Surge-maintained OB-Xf project, summed and soft-clipped in a single
  AudioWorklet. Driven by Octopus MIDI channels 1–10 (reassignable per
  instance). 32-voice polyphony per instance, second LFO, MPE matrix, and the
  full OB-Xf editor UI (104 parameter-bound controls).
- **Hardware MIDI I/O** — Web MIDI API output to real synths + input from
  real controllers (Chrome/Edge only), with MIDI-learn binding for the OB-Xf
  panel.
- **OB-Xf MIDI-learn** — click a knob, move a hardware control, done.
  Bindings persist to localStorage.

## Repository layout

```
.
├── firmware/              git submodule → OCT_CE_OS (Octopus + Nemo firmware)
├── third_party/
│   ├── OB-Xf/             git submodule → surge-synthesizer/OB-Xf (current synth engine)
│   │                      + 5 sub-submodules under libs/ (sst-basic-blocks, sst-cpputils,
│   │                        simde, fmt, JUCE) — see "First-time clone"
│   └── JUCE/              git submodule → juce-framework/JUCE (juce_amalgam.cpp)
├── wasm/
│   ├── main_wasm.c        Octopus engine entry point + exported API
│   ├── hal_wasm.c         eCos HAL shim (pthreads, ring-buffer mbox, nanosleep)
│   ├── hal_linux.h        modified copy with #elif __EMSCRIPTEN__ guards
│   ├── midi_wasm.c        MIDI ring buffer (replaces ALSA/winmm)
│   ├── flash_file.c       file-based persistence (works with MEMFS/IDBFS)
│   ├── Makefile           builds octopus_wasm.{js,wasm} (or nemo_wasm.* with NEMO=1)
│   └── obxd/
│       ├── main_obxd.cpp       multi-instance OB-Xf SynthEngine wrapper (10 instances)
│       ├── juce_amalgam.cpp    single-TU JUCE core + events + audio_basics + processors_headless
│       ├── obxf_imported/      curated OB-Xf header subtree (28 verbatim copies + 2 stubs)
│       ├── param_table.h   GENERATED OB-Xd→OB-Xf dispatch tables (from tools/param-spec.mjs)
│       ├── patches/        10 CC0 .fxp factory patches (embedded via xxd → patches.h)
│       └── Makefile        builds obxd_wasm.{js,wasm} (c++20, simd128, 256MB, 1MB stack)
├── src/                   TypeScript UI + MIDI + OB-Xf rack + MIDI-learn
├── index.html             transport bar + OB-Xf panel shell
├── vite.config.ts         HTTPS dev server with COOP/COEP/CORP headers
├── serve.py               plain-HTTP dev server with the same headers
├── build.sh               build orchestrator (wasm | synth | app | all)
└── AGENTS.md              engineering guide for AI assistants (read this too)
```

## First-time clone

This repo uses four submodules:

```bash
git clone --recurse-submodules <repo-url>
# Or after a regular clone:
git submodule update --init --recursive
```

> **Note:** `--recurse-submodules` / `--recursive` will pull OB-Xf's full
> nested submodule tree (all 11 sub-submodules, including desktop-only ones).
> To get a lean checkout, clone normally and then initialize the OB-Xf
> submodules explicitly (see below).

The firmware submodule (`firmware/`) is required for the Octopus WASM build.
The OB-Xf and JUCE submodules (`third_party/OB-Xf`, `third_party/JUCE`) are
required for the synth WASM build (`make -C wasm/obxd`). The JUCE submodule
is pinned at upstream 8.0.14; the Emscripten fix it needs lives in-repo as
`patches/0001-juce-emscripten-threadpriorities.patch` and is applied
automatically by `build.sh` before every synth build. **OB-Xf carries nested
sub-submodules under `libs/`** — only the five required for a
WASM/AudioWorklet build need to be initialized:

```bash
cd third_party/OB-Xf
git submodule update --init --depth 1 \
    libs/JUCE \
    libs/sst/sst-basic-blocks \
    libs/sst/sst-cpputils \
    libs/fmt \
    libs/simde
```

These five satisfy the headers referenced by the OB-Xf compile path
(`ParamMetadata.h` → `<fmt/core.h>`, `simd/setup.h` → `simde/...`,
`SynthParam.h` → `<juce_audio_basics/...>`, plus the SST support headers).
The legacy `third_party/Obxd/` submodule has been removed.

## Build

### Prerequisites

```bash
# Emscripten SDK (activates emcc/em++)
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
cd ~/emsdk && ./emsdk install latest && ./emsdk activate latest
source ~/emsdk/emsdk_env.sh

# Node.js >= 23 (used by Vite and the build orchestrator)
node --version
```

### Build everything

```bash
./build.sh          # Octopus WASM + OB-Xf WASM + TypeScript app
./build.sh wasm     # Octopus engine WASM only
./build.sh synth    # OB-Xf synth WASM only (+ patches.h generation)
./build.sh app      # TypeScript app only (npm install + vite build)
```

`build.sh synth` does three extra things:

1. **Generates `wasm/obxd/patches.h`** from the 10 `.fxp` files in
   `wasm/obxd/patches/` via `xxd -i`. `main_obxd.cpp`'s
   `__has_include("patches.h")` guard then routes `obxd_set_factory_patch()`
   through the native `.fxp` loader instead of the programmatic init patch.
   The shipped `.fxp` files are 10 CC0/Public Domain OB-Xf presets (pad/bass/
   lead/pluck/strings/keys/drone/stab/hat/kick). `patches.h` is gitignored;
   to swap patches, replace the files in `patches/` (keep the
   `NN_name.fxp` naming so the `g_factory_patches` symbol table matches) and
   rebuild.
2. **Concatenates the AudioWorklet processor** — `src/obxd-awp-shim.js` +
   `wasm/build/obxd_wasm.js` + `src/obxd-processor.tail.js` →
   `wasm/build/obxd-processor.js`. AudioWorkletGlobalScope disallows
   `importScripts()` and dynamic `import()`, so the only way to give the
   worklet both the emcc JS and our `AudioWorkletProcessor` subclass is to
   feed them as one file to `audioWorklet.addModule()`.
3. Passes nothing extra to `make` — the OB-Xf flags (`-std=c++20`,
   `-msimd128`, `-sSTACK_SIZE=1048576`, `-sINITIAL_MEMORY=268435456`) live in
   `wasm/obxd/Makefile`.

### Manual builds

```bash
# Octopus engine
make -C wasm           # → wasm/build/octopus_wasm.{js,wasm}
make -C wasm NEMO=1    # Nemo variant → wasm/build/nemo_wasm.{js,wasm}
make -C wasm clean

# OB-Xf synth (requires third_party/{OB-Xf,JUCE} + OB-Xf's 5 sub-submodules)
make -C wasm/obxd          # → wasm/build/obxd_wasm.{js,wasm}
make -C wasm/obxd obxf-check   # syntax-only header parse (no codegen/link)
make -C wasm/obxd clean
```

The OB-Xf build uses `-std=c++20` (mandatory — `sst-basic-blocks` static_asserts
require `__cplusplus >= 202002L`) and `-msimd128` (OB-Xf DSP headers use SSE
intrinsics, shimmed to wasm SIMD via SIMDE). The stack is raised to 1 MB and
initial memory to 256 MB because each OB-Xf `SynthEngine` owns a `Voice[32]`
array and pulls in ~230 `SynthParam::ID::*` static strings during init; the
default 64 KB / 64 MB overflows. See the `wasm/obxd/Makefile` header comment
for the full rationale.

### Dev server

```bash
npm install

# Option A — Vite (HTTPS + COOP/COEP/CORP). Needs certs/ (see below).
npx vite --host 0.0.0.0 --port 8080

# Option B — plain HTTP + COOP/COEP/CORP (no certs required; SAB works on localhost)
python3 serve.py

# Option C — nginx. Serves the built dist/ (run ./build.sh app first).
#            No Node required at runtime. Config snippet below.
# Option D — Desktop launcher (./build.sh desktop). egui binary with the
#            dist/ embedded — serves localhost + opens the browser.
```

Open the URL you started. With Vite, accept the self-signed cert warning
(needed because SharedArrayBuffer requires a secure context). With
`serve.py` on `localhost`, the browser treats it as a secure context already.

#### Desktop launcher (Option D)

`gui/` holds a small egui desktop launcher that embeds the built `dist/`
into a single self-contained binary (rust-embed), serves it on localhost
with the COOP/COEP/CORP headers, and opens the browser. Same launcher
pattern as `octopus_gui` in the native [Octopus](https://github.com/maxolgi/Octopus)
port. Requires rustup.

```bash
./build.sh desktop                      # dist/ build + cargo build
gui/target/release/octobx_gui           # serving auto-starts; click "Open Browser"
# or with a custom port: octobx_gui --port 8090
```

`localhost` is a secure context, so Web MIDI and the AudioWorklet work over
plain HTTP. Windows cross-build: `cargo build --release --target
x86_64-pc-windows-gnu` (see `gui/README.md`). Rebuild the launcher after
every app change — `dist/` is embedded at compile time.

#### nginx (Option C)

Once you've built the app (`./build.sh app` → `dist/`), you can serve it
with any static server that sends the three cross-origin-isolation headers.
The `dist/` directory is fully self-contained (HTML + bundled JS + `.wasm`
files, ~2 MB) — no Node, npm, or Python required at runtime.

Minimal `server` block (drop in `/etc/nginx/conf.d/octobx.conf` or symlink
into `sites-enabled/`):

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name octobx.local;        # or your domain / LAN IP
    root /var/www/octobx/dist;       # point at the built dist/
    index index.html;

    # Required for SharedArrayBuffer (Emscripten pthreads)
    add_header Cross-Origin-Opener-Policy   "same-origin"   always;
    add_header Cross-Origin-Embedder-Policy "require-corp"  always;
    add_header Cross-Origin-Resource-Policy "same-origin"   always;

    # Correct WASM MIME (most nginx installs already ship this in mime.types)
    types { application/wasm wasm; }

    # SPA-style fallback (harmless; OctOBX is single-page)
    location / { try_files $uri $uri/ /index.html; }

    # add_header in a nested location overrides the parent — re-declare
    # the three headers anywhere you set other headers, or they vanish.
    location ~* \.(js|wasm)$ {
        add_header Cross-Origin-Opener-Policy   "same-origin"   always;
        add_header Cross-Origin-Embedder-Policy "require-corp"  always;
        add_header Cross-Origin-Resource-Policy "same-origin"   always;
        etag on;
    }
}
```

Two gotchas to check:

1. **`add_header` inheritance** — nginx's `add_header` inside a `location`
   block *replaces* all parent `add_header` directives, it doesn't merge.
   Any `location` that sets its own headers must repeat the three COOP/COEP/
   CORP headers, or `SharedArrayBuffer` will silently disappear for those
   files. (The snippet above does this for the `.js/.wasm` location.)
2. **Secure context** — `SharedArrayBuffer` requires HTTPS *except* on
   `localhost` / `127.0.0.1`. A LAN IP like `192.168.1.10` over plain HTTP
   will **not** be a secure context; add TLS (e.g. via `certbot --nginx`)
   before testing from another machine.

Verify it worked in DevTools → Console:

```js
typeof SharedArrayBuffer  // "function"  (not "undefined")
crossOriginIsolated       // true
```

## Runtime architecture

```
Browser (COOP/COEP/CORP cross-origin isolated)
├── Main Thread
│   ├── Octopus UI (classic panel or modern grid)
│   ├── Drum UI (kit selector, 8 pads × 4 layers, knob strips)
│   ├── MIR rendering (60Hz RAF → reads WASM heap via HEAPU8)
│   ├── OB-Xf rack + editor UI (instance selector, knobs, meters, .fxp loader, MIDI-learn)
│   ├── Transport controls + state persistence (Tab cycles 4 views)
│   └── Single 60Hz MIDI drain loop (RAF)
│        └── fans each batch out to two parallel consumers:
│            • HardwareMidiOutput  → Web MIDI output port
│            • createObxdBridgeHandler  → OB-Xf AudioWorklet (per-instance)
│
├── WASM Module — Octopus engine  (octopus_wasm.wasm, ~1.6MB)
│   ├── Firmware core (~50k lines, unchanged from native)
│   ├── hal_wasm.c / midi_wasm.c / main_wasm.c
│   └── Sequencer pthread (48 PPQN, nanosleep timing)
│
└── AudioWorklet — OB-Xf synth  (obxd_wasm.wasm, ~20MB)
    ├── main_obxd.cpp  — 10 SynthEngine instances summed + soft-clipped
    │   └── Instance 9 = drum sampler (32 voices, 8 pads × 4 layers, PCM)
    ├── obxf_imported/ — curated OB-Xf engine headers (28 verbatim copies + 2 stubs)
    └── juce_amalgam.cpp — juce_core + juce_events + juce_audio_basics + juce_audio_processors_headless
```

### Key design decisions

1. **Single translation unit (Octopus)** — `wasm/main_wasm.c` `#include`s
   all firmware `.h` files into one TU, matching the original firmware's
   architecture. The `.c` files in `firmware/OCT_OS/_OCT_objects/` and
   `firmware/OCT_OS/_OCT_global/flash-block.c` are `#include`d directly
   via the firmware headers — they are NOT compiled separately and NOT
   listed in `SRCS`.
2. **`-D__linux__` + `-D__EMSCRIPTEN__`** — the WASM build defines both.
   `-D__linux__` makes the existing firmware preprocessor guards route
   `MIDI_send()` to our `midi_send_event()` and suppress hardware-specific
   code. `-D__EMSCRIPTEN__` routes platform-specific code to the WASM
   implementations. **No firmware source changes are needed beyond the
   guards already present in `firmware/`**.
3. **pthreads** — the sequencer runs in a Web Worker via Emscripten
   pthreads. Requires SharedArrayBuffer (hence the COOP/COEP/CORP headers
   on a secure context).
4. **Single drain loop, multiple consumers** — one 60Hz RAF in
   `midi-output.ts` pulls batches from the WASM ring buffer and fans them
   out. Today the consumers are hardware MIDI output and the OB-Xf bridge;
   the `BatchDrainHandler` indirection means a future consumer (another
   DAW, a MIDI file recorder, etc.) plugs in with one line in `main.ts`.
5. **Direct MIR access** — JS reads the 170-byte MIR array directly from
   WASM linear memory via `HEAPU8`. No serialization. `VIEWER_show_MIR()`
   is a no-op in the WASM build.
6. **OB-Xf in a separate WASM module inside an AudioWorklet** — the synth
   has its own emcc build (`-sENVIRONMENT=worker`, no pthreads because
   pthreads are illegal inside AudioWorkletGlobalScope). WASM bytes are
   pre-fetched on the main thread and passed via
   `processorOptions.wasmBinary` to sidestep emcc's broken-in-AWP fetch
   paths.

## Octopus engine — WASM source (`wasm/`)

### `hal_linux.h`

Modified copy of the firmware's `include/hal_linux.h` with
`#elif defined(__EMSCRIPTEN__)` guards. Differences from the Linux native
copy:

- No socket / timerfd / ioctl / mman headers
- Ring-buffer mailbox type (mutex + condvar, same shape as the Windows path)
- `emscripten_get_now()` for `HAL_CLOCK_READ`
- OSC declarations excluded (`#ifndef __EMSCRIPTEN__`)

### `hal_wasm.c`

eCos HAL shim. Backs the `cyg_*` functions the firmware expects with
browser-friendly primitives:

- `cyg_thread_*` → pthread (Emscripten pthreads → Web Workers)
- `cyg_mbox_*` → ring buffer (mutex + condition variable)
- `cyg_mutex_*` → `pthread_mutex_t` (recursive for the scheduler lock)
- `cyg_semaphore_*` → `sem_init` / `sem_post` / `sem_wait`
- `cyg_alarm_*` → watcher threads with `nanosleep`
- `diag_printf` → `vfprintf(stderr)`
- In-memory flash buffer mirrors the native port

**HANDLE conflict:** the firmware defines `HANDLE` as 5 (a display mode
constant in `defs_general.h`). Don't rely on a Win32-style `HANDLE` here.

### `midi_wasm.c`

Replaces `midi_alsa.c`. Key functions:

- `midi_send_event()` — converts firmware MIDI types to raw bytes, pushes
  a 32-bit packed event (`status | data1<<8 | data2<<16 | channel<<24`)
  plus a `double` timestamp (`emscripten_get_now()` ms) into a 512-entry
  ring buffer.
- `wasm_drain_midi_batch(max_count)` — copies up to 128 events + their
  timestamps into static buffers and advances head under one mutex
  acquisition. JS reads the results via `get_midi_batch_events_ptr()` /
  `get_midi_batch_ts_ptr()`.
- `wasm_has_midi_event()` / `wasm_get_midi_event()` — single-event API
  retained for compatibility; the drain loop uses the batch API instead.
- `wasm_midi_input(status, d1, d2)` — feeds MIDI input to the firmware's
  byte-at-a-time interpreters (`G_midi_interpret_*`).

Firmware MIDI input interpreters are byte-at-a-time state machines, not
message-level handlers. `wasm_midi_input()` sets the running-status byte
and then feeds `d1` and `d2` sequentially. The browser decodes running
status for us, so every Web MIDI message arrives with an explicit status
byte.

### `main_wasm.c`

Replaces `main_linux.c`. Key differences from native:

- No blocking `main()` loop — JS calls `engine_init()`.
- Sequencer thread uses relative `nanosleep` (Emscripten implements via
  `Atomics.wait`, ~1ms resolution) instead of absolute
  `clock_nanosleep(TIMER_ABSTIME)` + busy-wait.
- `VIEWER_show_MIR()` is a no-op (JS reads MIR from heap).
- `sequencer_START()` called in init (matches native behavior).
- State save/load via `PersistentV2` format into Emscripten's virtual
  filesystem (`/persistent/octopus_state.bin`).
- Double-click window widened for mouse input
  (`DOUBLE_CLICK_ALARM_RESOLUTION=24`, `SENSITIVITY=3`).

**Exported functions** (`EMSCRIPTEN_KEEPALIVE`). Must be kept in sync
across three places: the C definition, `src/octopus-types.ts`, and the
Makefile's `-sEXPORTED_FUNCTIONS` list.

| Function | Purpose |
|---|---|
| `engine_init()` | Initialize firmware, start sequencer thread |
| `wasm_key_press(key, press)` | Key input from UI |
| `wasm_rotary(rotNdx, dir)` | Rotary encoder input |
| `wasm_transport(running)` | Start/stop sequencer |
| `wasm_set_tempo(bpm)` | Change tempo |
| `wasm_pause()` | Toggle pause |
| `wasm_midi_input(status, d1, d2)` | MIDI input from Web MIDI |
| `wasm_save_state()` | Save to MEMFS (`/persistent/octopus_state.bin`) |
| `wasm_load_state()` | Load from MEMFS (under scheduler lock + post-load validation) |
| `wasm_shutdown()` | Stop sequencer |
| `get_mir_ptr()` | Pointer to raw MIR array (170 bytes) |
| `get_processed_mir_ptr()` | MIR with blink processing applied |
| `get_run_bit()` | Transport state |
| `get_tempo()` | Current BPM |
| `get_zoom_level()` | Current zoom mode |
| `page_refresh()` | Call `Page_full_refresh()` (fills MIR) |
| `wasm_has_midi_event()` | Check ring buffer (single-event API) |
| `wasm_get_midi_event()` | Drain next event (single-event API) |
| `wasm_drain_midi_batch(max)` | Drain up to 128 events + timestamps in one mutex acquisition |
| `get_midi_batch_events_ptr()` | Pointer to the batch events array |
| `get_midi_batch_ts_ptr()` | Pointer to the batch timestamps array |
| `wasm_get_midi_dropped_count()` | Number of events dropped due to ring overflow |
| `wasm_get_tick_ns()` | Nanoseconds per tick (debug) |
| `wasm_get_sequencer_running()` | Sequencer thread liveness |
| `wasm_get_tick_count()` | Sequencer tick counter (debug) |

### `flash_file.c`

Copied unchanged from the native port's `src/flash_file.c`. Works with
Emscripten's virtual filesystem (MEMFS by default, IDBFS for persistence).

### `Makefile`

Octopus engine build flags:

```makefile
-std=gnu89 -D__linux__ -D__EMSCRIPTEN__
-pthread -sUSE_PTHREADS=1 -sPTHREAD_POOL_SIZE=2
-sMODULARIZE=1 -sEXPORT_NAME=OctopusModuleFactory
-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864
-sFORCE_FILESYSTEM=1
-sENVIRONMENT=web
```

`MODULARIZE=1` exports a factory function (`OctopusModuleFactory`) that
returns a `Promise<Module>`. Loaded via a dynamic `<script>` tag in
`octopus-module.ts`.

## OB-Xf synth — WASM source (`wasm/obxd/`)

The synth was migrated from the legacy 2DaT/Obxd OB-XD engine to the
Surge-maintained OB-Xf engine. The OB-Xf source is **curated** into the
browser build (see `wasm/obxd/obxf_imported/MANIFEST.md`) — it is not compiled
straight from the submodule.

### `main_obxd.cpp`

Multi-instance OB-Xf wrapper. Up to 10 `SynthEngine` instances share one
WASM heap and are summed per quantum into a master stereo buffer with an
always-on `x/(1+|x|)` soft-clip. State per instance:

- `g_engines[10]` / `g_engine_active[10]` / `g_engine_polyphony[10]`
- `g_mpe_enabled[10]` — per-instance MPE flag, mirrored from the rack UI.
- `g_param_mirror[10][PARAM_COUNT]` — `SynthEngine` has no getter API, so
  we maintain our own copy alongside the engine state. `_obxd_get_param`
  reads from here; the knob UI uses it to render values after a patch load.
- `g_patch_name[10][64]` — last-loaded program name per instance.
- `g_engine_rms[10]` — per-instance RMS metering, updated during render.

**Engine API** (per `obxf_imported/engine/SynthEngine.h`):
`setSampleRate(float)`, `processSample(float* L, float* R)` (one stereo
sample), `processNoteOn(note, vel, channel)` / `processNoteOff(note, vel, channel)`
(MPE-aware — channel is `int8_t`), `allNotesOff()`, `allSoundOff()`,
`sustainOn()` / `sustainOff()`, `processPitchWheel(v)` (global, `[-1, 1]`),
`processMPEPitch(channel, v)` (per-channel), `processModWheel(v)` (in
`[0, 1]`), `processPolyphony(v)` (`1 + (int)(v * MAX_VOICES)`, `MAX_VOICES =
32`), and ~80 per-param `processX(float)` setters.

**Parameter dispatch (generated, single-source)** — the UI/`.fxp` layer
still speaks the OLD OB-Xd integer param indices 0..79 (frozen
`ParamsEnum.h` order), but the mapping to the NEW OB-Xf `processX()`
methods lives in ONE spec: `tools/param-spec.mjs`. `tools/gen-param-table.mjs`
(run by `build.sh synth` before `make`) generates `wasm/obxd/param_table.h`
(80 legacy rows with per-row `apply_legacy` forward transforms, 28 NEW rows,
and a 104-entry sorted streaming-name index), `src/obxf-param-mappings.ts`
(TS mirror + pure transform/invert functions), and
`src/generated/param-table.json` (test sidecar).
`node tools/gen-param-table.mjs --check` gates staleness. Native OB-Xf
named-attribute `.fxp` values dispatch 1:1 via the name index, and the
generated `invert` functions map native→legacy space for the `g_param_mirror`
write (legacy knobs show correct positions after a native patch load).
OB-Xf-only params with no legacy ancestor (second LFO, xpander mode, attack
curves, ~28 in total) get sentinel `200 + canonical ordinal`, assigned
NAME-KEYED from the generated `canonicalNewParamOrder` in
`src/obxd-synth-ui.ts` — UI and engine share the same order by construction.
Values are mirrored in `g_new_param_mirror` so the knob UI syncs after
`.fxp` load / instance switch.

**Factory patches** — when `wasm/obxd/patches.h` is present at compile time
(produced by `build.sh synth` from the 10 CC0 `.fxp` files in
`wasm/obxd/patches/`), it takes precedence over the programmatic fallback.
The shipped presets are 10 Surge Synth Team OB-Xf presets
(`01_pad.fxp` … `10_kick.fxp`); keep the `NN_name.fxp` naming so the
`g_factory_patches` symbol table matches.

**`.fxp` (VST2 preset) loading** — `obxd_load_fxp` parses three schemas:
the native OB-Xf named-attribute XML (`Volume="0.5" …`, applied 1:1 to the
matching `processX()` with NO rescale), the legacy OB-Xd integer schema
(float array, applied through `apply_param_instance` with rescale), and the
`VC2!` wrapper around either. Big-endian integers/floats per the Steinberg
spec. See the long comment block in `load_fxp_data()` for the full format
breakdown and return codes.

**Exports** (`EMSCRIPTEN_KEEPALIVE`, all instance-aware except
`obxd_panic_all`):

| Function | Purpose |
|---|---|
| `obxd_init(sample_rate)` | Create all 10 SynthEngine instances + apply factory patches |
| `obxd_render(n)` | Render `n` samples, sum all active engines, soft-clip |
| `get_buf_l_ptr()` / `get_buf_r_ptr()` | Master stereo buffer pointers |
| `obxd_set_active(id, active)` | Per-instance mute |
| `obxd_get_active(id)` | Per-instance mute state |
| `obxd_set_polyphony(id, voices)` | Per-instance voice count (1–32) |
| `obxd_get_polyphony(id)` | Per-instance voice count |
| `obxd_midi_in(id, status, d1, d2)` | Per-instance MIDI message (handles CC 1/64/120/123 internally) |
| `obxd_set_gain(id, gain)` | Per-instance output gain |
| `obxd_set_param(id, idx, value01)` | Per-instance parameter set (legacy index 0..79) |
| `obxd_get_param(id, idx)` | Per-instance parameter read |
| `obxd_load_fxp(id, ptr, len)` | Load `.fxp` preset bytes into instance |
| `obxd_all_notes_off(id)` | Per-instance note-off |
| `obxd_panic(id)` | Per-instance all-sound-off |
| `obxd_panic_all()` | Global all-sound-off |
| `obxd_reset_patch(id)` | Reset instance to engine defaults |
| `obxd_get_patch_name(id)` | Last-loaded patch name |
| `obxd_set_factory_patch(id, patch_id)` | Apply factory patch 0–9 to instance |
| `obxd_get_instance_rms(id)` | Per-instance RMS meter |
| `obxd_set_mpe(id, enabled)` | Per-instance MPE flag (mirrors `g_mpe_enabled[id]`) |
| `obxd_set_freq(freq)` | Backwards-compat no-op |
| `obxd_load_pcm(id, pad, layer, ptr, len)` | Load float mono PCM sample into pad/layer (instance 9 drum sampler) |
| `obxd_set_pcm_layer(id, pad, layer, gain, cutoff, res, mode, aA, aD, aS, aR, pan, pitch)` | Per-layer PCM params (filter, amp env, gain, pan, playback rate) |
| `obxd_set_pcm_note_map(id, note, pad)` | Map MIDI note → pad index |
| `obxd_set_pcm_layer_count(id, pad, count)` | Active layers per pad (0 = pad off) |
| `obxd_set_pcm_choke(id, pad, group)` | Assign pad to choke group (new hit cuts prior) |
| `obxd_clear_pcm(id)` | Free all PCM samples + reset state |
| `obxd_set_drum_layer_param(pad, layer, idx, v)` | Per-layer voice-level param mirror (global params route live via `apply_param_instance(9, …)`) |
| `obxd_get_drum_layer_param(pad, layer, idx)` | Read per-layer param from mirror |

> **Reserved CCs:** mod wheel (CC 1), sustain pedal (CC 64), all-sound-off
> (CC 120), and all-notes-off (CC 123) are handled inside `obxd_midi_in()`'s
> CC switch AND also available as dedicated per-instance exports
> `obxd_set_mod_wheel(id, v)` / `obxd_set_sustain(id, on)` for direct routing
> from the MIDI-learn integration layer. CC 1 → `processModWheel`, CC 64 →
> `sustainOn()`/`sustainOff()`, CC 120 → `allSoundOff()`, CC 123 → `allNotesOff()`.

### `obxf_imported/` (curated OB-Xf header subtree)

28 byte-identical copies of the OB-Xf `SynthEngine` / `Program` /
`ObxdImporter` / `ParameterList` / `SynthParam` subsystem (plus supporting
headers — `Motherboard.h`, `Voice.h`, `VoiceMatrix.h`, `Lfo.h`, etc.) from
`third_party/OB-Xf/src/...`. This is the ONLY OB-Xf source root on the
include path; `third_party/OB-Xf/src` itself is intentionally excluded (it
would pull in GUI/host deps). Two deliberate stubs substitute for deps not in
the browser build: `Utils.h` (empty) and `libMTSClient.h` (MTS-ESP stub).
See `obxf_imported/MANIFEST.md` for the provenance and the per-file copy list.

`obxf_imported/state/ObxdImporter.cpp` is compiled as a separate third TU
(alongside `main_obxd.cpp` and `juce_amalgam.cpp`).

### `juce_amalgam.cpp`

Single TU amalgamating `juce_core` + `juce_events` + `juce_audio_basics` +
`juce_audio_processors_headless`. The OB-Xf `SynthEngine.h` → `Program.h` →
`ParameterList.h` → `SynthParam.h` chain reaches
`juce::AudioParameterFloat` / `juce::AudioProcessorParameter`, which live in
JUCE 8's GUI-free `juce_audio_processors_headless` split. MUST be a separate
TU from `main_obxd.cpp` because JUCE's `.cpp` files refuse to compile in any
TU where the matching `.h` has already been included. Critically `#undef
__linux__` before including JUCE so `TargetPlatform.h`'s `#elif defined(__wasm__)`
branch fires (otherwise JUCE picks up its Linux code paths, which don't
compile under Emscripten).

### `Makefile`

OB-Xf build flags:

```makefile
-std=c++20 -O3 -msimd128        # c++20 mandatory (sst-basic-blocks static_asserts);
                                # simd128 shims OB-Xf SSE intrinsics to wasm SIMD via SIMDE
-sENVIRONMENT=worker            # AWP is worker-like
-sMODULARIZE=1 -sEXPORT_NAME=ObxdModuleFactory
-sINITIAL_MEMORY=268435456      # 256MB; OB-Xf Voice[32] × 10 instances exceed 64MB
-sSTACK_SIZE=1048576            # 1MB; OB-Xf pulls in ~230 static SynthParam::ID strings
-sALLOW_MEMORY_GROWTH=1
-sFORCE_FILESYSTEM=0            # worklet can't read FS; bytes go via _malloc + HEAPU8.set
-sDISABLE_EXCEPTION_CATCHING=0  # JUCE/Obxd use std::exception paths
```

No `-pthread`: pthreads are illegal inside AudioWorkletGlobalScope. See the
Makefile header comment for the full rationale of each flag. The
`obxf-check` target runs an `-fsyntax-only` pass over the key OB-Xf headers
for fast include-chain error surfacing without a full codegen/link.

## TypeScript source (`src/`)

| File | Role |
|---|---|
| `main.ts` | Entry point: SharedArrayBuffer check → load WASM → `engine_init()` → build UI → transport/persistence → hardware MIDI → OB-Xf rack → drum module mount. Tab key cycles the 4 views (classic → modern → synth → drums); Shift+Tab reverses. Skips when focus is on a form control. |
| `octopus-types.ts` | TS interface matching the Octopus C `EMSCRIPTEN_KEEPALIVE` exports. |
| `octopus-module.ts` | Loads the Octopus WASM module (dynamic `<script>`, `locateFile`, IDBFS mount attempt at `/persistent`). |
| `classic-panel.ts` | Faithful port of the Octopus control surface (same DOM/IDs as the original `web_gui.html`); direct WASM calls instead of WebSocket. |
| `octopus-panel.ts` | Simplified modern grid view (alternative panel). |
| `midi-access.ts` | Shared `openMidiAccess()` + `pollForPorts()` — works around the Chrome-on-Linux late port-enumeration quirk. |
| `midi-output.ts` | Web MIDI API **output** (Chrome/Edge). `drainMidiToHardware()` owns the single 60Hz RAF drain loop and fans batches out to the parallel consumers. Exports the `BatchDrainHandler` type. `frameMidi()` emits correct 1/2/3-byte messages. Adds a `MIDI_FORWARD_OFFSET_MS=20` timestamp offset for jitter-free scheduled delivery via `MIDIOutput.send(data, ts)`. |
| `midi-input.ts` | Web MIDI API **input** (Chrome/Edge). `HardwareMidiInput` attaches `onmidimessage` to the selected input port and forwards `(status, d1, d2)` to `wasm_midi_input()`. Sysex / active-sensing / tune-request dropped. |
| `obxd-audio.ts` | Main-thread bootstrap + per-instance API for the OB-Xf AudioWorklet. Pre-fetches the WASM bytes and passes them via `processorOptions.wasmBinary`. Implements a one-shot reply router for async worklet RPCs (`fxp_loaded`, `param_value`) so concurrent callers don't race on `port.onmessage`. Adds `setObxdInstanceMpe` for per-instance MPE flag mirroring. |
| `obxd-bridge.ts` | Consumer of the drain loop → OB-Xf AudioWorklet. Channel→instance routing (default channels 1–10 → instances 0–9, reassignable per instance via the rack UI). MPE-aware: an instance with MPE enabled claims a lower zone (master + N voice channels) before non-MPE instances fill the rest. No-ops while the synth isn't ready. Re-exports `BatchDrainHandler`. |
| `obxd-processor.tail.js` | Plain JS appended to the emcc output at build time to form `obxd-processor.js` (the file fed to `audioWorklet.addModule()`). Subclasses `AudioWorkletProcessor`, drains queued MIDI at the top of `process()`, calls `_obxd_render(128)`, copies cached `HEAPF32` views to the output. Caches the views and refreshes them only when WASM memory grows (avoids per-quantum GC pressure that caused audio clicks). |
| `obxd-awp-shim.js` | Plain JS prepended to the emcc output. Polyfills `self`/`location`/`fetch`/`importScripts`/`document`/`performance` for emcc's worker-env output, which assumes all of those exist but AudioWorkletGlobalScope doesn't define them. |
| `obxd-rack.ts` | OB-Xf rack UI: instance selector, power/polyphony/channel selectors, level meter (30Hz ping/pong), `.fxp` loader, Reset/Panic/Panic All buttons, per-instance MPE toggle + bend-range UI. Lazy-inits the AudioContext on first PLAY click (autoplay-policy compliance). |
| `obxd-synth-ui.ts` | Data-driven OB-Xf editor panel rendered from `obxf-layout.ts` (104 parameter-bound controls), absolute-positioned inside the 1150×576 OB-Xf VectorTheme canvas. Legacy-indexed controls dispatch via `setObxdInstanceParam(idx, v)`; OB-Xf-only controls get a sentinel `200 + canonical ordinal`, assigned NAME-KEYED from the generated `canonicalNewParamOrder` (the `RingModVol`→`RingModMix` layout-id alias is handled). `syncObxdControlsFromEngine(instanceId)` re-seeds widget positions from `g_param_mirror` (legacy) and `g_new_param_mirror` (NEW params) on instance switch / patch load. |
| `obxd-knob.ts` | Vanilla SVG widget factories (no deps): `createObxdKnob`, `createObxdToggle`, `createTriStateButton`, `createSelector`, `createSlider`, `createButton`. Drag/wheel/double-click (reset); bipolar knobs supported. |
| `obxf-layout.ts` | OB-Xf editor UI layout spec — read-only data module auto-extracted from the OB-Xf source tree (theme.xml + `ObxfEditorLayout.cpp` + `SynthParam.h` + `ParameterList.h`). 173 `ControlSpec` entries (104 parameter-bound + 69 special widgets) across 13 sections, plus `obxfTheme` color tokens and the 1150×576 canvas geometry. Do not edit by hand — see the file header. |
| `obxf-param-mappings.ts` | AUTO-GENERATED by `tools/gen-param-table.mjs` from `tools/param-spec.mjs` — do not edit. 80 legacy rows (BENDRANGE split encoded via `secondaryNewId`/`secondaryMethod`), plus `canonicalNewParamOrder`, drum classification, and pure `forward`/`invert` transform functions. |
| `obxf-midi-learn.ts` | OB-Xf MIDI-learn **logic** layer (no UI): standalone port of the OB-Xf `MidiHandler`/`MidiMap` state machine. CC→0..1 transforms, learn-then-apply path, lag smoother, reserved-CC pre-screening. |
| `obxf-midi-learn-integration.ts` | Singleton `ObxfMidiLearnManager` + per-param registry. `processHardwareCC()` is the single entry point `midi-input.ts` calls before forwarding a CC — returns true when consumed by learn. Bindings persist to localStorage; auto-save on every learn/unlearn. |
| `obxf-midi-learn-ui.ts` | MIDI-learn **overlay** UI: renders the OB-Xf `midiLearnButton`, paints per-knob `CC{n}` badges above bound controls, toggles the red panel-border learn-mode indicator, click-badge-to-unlearn. |
| `transport-sync.ts` | Wires PLAY/STOP/BPM to the Octopus engine and updates the on-screen transport indicator. |
| `state-persistence.ts` | Octopus sequencer state save/load via localStorage (base64). SAVE writes to localStorage; Shift+SAVE also downloads `.bin` + JSON. LOAD imports `.bin` files. Autoloads on startup. |
| `app-state.ts` | Synth + drum state persistence. Dumps all synth (10×108) and drum (8×4×108) params from the AWP in bulk, plus per-instance settings (power, polyphony, channel, MPE, bend range) and drum kit, to localStorage JSON. Restores after AWP ready via `onAWPReady` callback. |
| `drum-rack.ts` | Drum module UI: kit selector, 8 pads × 4 layers with dual sample-kit + sample dropdowns (cross-kit sample mixing via `DrumLayer.sourceUrl` + `SAMPLE_CATALOG`), mute/enable toggles, and per-layer knob strips (48 controls: 8 global + 40 per-layer). SVG arc knobs with iOS-style toggle pills and tri-state LFO-routing pills. Layer section has Gain/Pan/Pitch knobs with custom dispatch (bypass `g_drum_layer_params`, update `DrumLayer` object + `pushLayer` → `set_pcm_layer`). `syncEditor`/`syncKnobStrips` re-seed knob positions on pad/layer switch. |
| `drum-audio.ts` | Main-thread audio bootstrap for the drum module on OB-Xf instance 9 (32 voices). `loadDrumKit` fetches samples from smpldsnds CDN, decodes via `AudioContext.decodeAudioData`, posts float arrays to the worklet via `obxd_load_pcm`. Per-layer URL resolution via `layerSampleUrl(lyr, kitSource)` (`lyr.sourceUrl ?? kitSource`) supports cross-kit sample mixing. Serialized via `kitLoadChain` promise chain (prevents concurrent loads). `sendLayerParams` pushes per-layer params (gain, filter, amp env, pan, pitch). `seedLayerMirror` seeds `g_drum_layer_params` on load. `pushLayer` re-sends one layer's full param set. |
| `drum-state.ts` | Pure data layer: `DrumLayer` / `DrumPad` / `DrumKit` interfaces + factory functions. No project dependencies. `DrumLayer` fields: enabled, sampleName, sourceUrl (optional — when set, sample loads from this URL prefix instead of the loaded kit's source; enables cross-kit sample mixing), gain, filterCutoff/Resonance/Mode, amp ADSR, pan, pitch (0..1, 0.5=original), muted, `_seeded` flag. |
| `drum-kits.ts` | 10 drum-kit presets sourced from the Public Domain smpldsnds CDN. Each kit maps its samples onto 8 GM pads (Kick, Snare, Closed HH, Open HH, Tom Lo, Clap, Cowbell, Ride). Secondary layers get `gain: 0.55, filterCutoff: 0.8` (quieter + darker). Closed HH + Open HH share choke group 0. Also exports `SAMPLE_CATALOG` (one entry per kit with deduped sample list + source URL) that drives the layer-editor dual dropdown UI for cross-kit sample mixing. |

Input conventions: `skey(key, press)` → `module._wasm_key_press(key, press)`;
rotary knobs → `module._wasm_rotary(idx, dir)`; drag-paint step pads
(mouse + touch); Ctrl-click hold mode.

## MIDI routing

Real MIDI is a first-class feature, wired through the Web MIDI API
(Chrome/Edge only). The Octopus engine emits events to a 512-entry ring
buffer in WASM linear memory. Each event is a 32-bit packed word
(`status | data1<<8 | data2<<16 | channel<<24`) plus a `double` timestamp.

A single 60Hz RAF drain loop in `midi-output.ts` pulls batches (up to 128)
via `wasm_drain_midi_batch` and fans each batch out to two parallel
consumers:

1. **Hardware output** — frames each event to the correct byte length
   (1-byte system real-time, 2-byte program-change/channel-pressure,
   3-byte channel-voice) and sends it to the selected Web MIDI output
   port. Wrong-length framing corrupts the stream to hardware synths.
2. **OB-Xf bridge** — maps Octopus channel → OB-Xf instance (default
   channels 1–10 → instances 0–9, reassignable per instance) and
   `postMessage`s to the AudioWorklet. MPE-aware: an instance with MPE
   enabled claims a lower zone (master + N voice channels) before
   non-MPE instances fill the rest.

The drain loop exposes a `BatchDrainHandler` type so additional consumers
can be plugged in by adding a single line in `main.ts`.

**MIDI learn** (OB-Xf port) — click the `midiLearnButton` in the OB-Xf
panel to enter learn mode (red panel border), then move a hardware control
to bind it to the last-clicked knob. Incoming CCs are screened by
`processHardwareCC()` (called by `midi-input.ts` *before* forwarding); when
a CC is consumed by learn it is not also fed to the Octopus engine.
Bindings persist to localStorage and auto-save on every learn/unlearn;
click a knob's `CC{n}` badge to unlearn. Reserved CCs (mod wheel CC 1,
sustain pedal CC 64, all-sound-off CC 120, all-notes-off CC 123) are not
learnable — they route to dedicated OB-Xf engine methods inside
`obxd_midi_in()` instead.

**Chrome-on-Linux late enumeration** — after the MIDI permission is
granted, the *first* `requestMIDIAccess()` delivers ports via
`statechange` events. On *reload* (permission already granted) no
`statechange` fires and the call can resolve with **empty** input/output
maps — so the selectors stay "None". `midi-access.ts` `pollForPorts()`
repopulates every 250ms (up to 4s) until ports appear. There is also a
↻ Rescan button (`#oct-midi-rescan`) that calls `rescan()` on both
classes for hotplug/recovery.

UI selectors: `#oct-midi-output`, `#oct-midi-input`, `#oct-midi-rescan`
(in `index.html` transport bar).

## OB-Xf runtime architecture

```
Octopus sequencer (pthread) → MIDI ring buffer → 60Hz drain
   ↓
obxd-bridge.ts (channel → instance routing, MPE-aware zone claiming)
   ↓ postMessage({instance_id, status, d1, d2})
AudioWorkletNode (single)
   ↓
obxd_wasm.wasm
    g_engines[10]                 (OB-Xf SynthEngine instances, all created at init)
    g_engine_active[10]           (all true by default)
    g_engine_polyphony[10]        ({8,1,1,1,1,1,1,1,1,1} by default; 1–32 per instance)
    g_mpe_enabled[10]             (per-instance MPE flag, mirrored from rack UI)
    g_engine_rms[10]              (per-instance RMS, updated during render)
    ↓
obxd_render(n): for each active engine, processSample, sum, x/(1+|x|) soft-clip
    ↓
AudioContext.destination
```

Init flow:

1. Page loads, OB-Xf rack + editor panel build eagerly (defaults baked in),
   wires all header controls, starts a 30Hz meter ping/pong.
2. User clicks PLAY (anywhere — transport bar, Octopus panel, modern grid,
   or incoming MIDI START). The lazy-init hooks the transport-bar PLAY
   directly for instant response; a 200ms run-bit poller catches every
   other path.
3. `setupObxdAudio()` creates an `AudioContext`, resumes it under the user
   gesture, fetches `obxd_wasm.wasm` bytes on the main thread, and hands
   them to the AudioWorklet via `processorOptions.wasmBinary`.
4. The worklet's `ensureModule()` monkey-patches
   `WebAssembly.instantiateStreaming`/`instantiate` to consume the
   pre-fetched bytes (emcc's fetch/XHR paths are broken in AWP), invokes
   `ObxdModuleFactory`, calls `_obxd_init(sampleRate)`, and posts
   `{type:'ready'}`.
5. Octopus PLAY now drives all 10 instances via MIDI channels 1–10
   (reassignable per instance; MPE instances claim their own zones).

Default state: all 10 instances on; instance 1 = 8 voices, others = 1
voice; channels 1–10 → instances 0–9; each instance seeded with its own
factory patch from the 10 CC0 `.fxp` files.

## MIR (Matrix Intermediate Representation)

`unsigned char MIR[2][17][5]` in WASM linear memory — 170 bytes total.
Each row (17 per set, 2 sets) is 5 bytes:

- Byte 0: blink/selector flags
- Byte 1: red LED bits (1 bit per column, 8 columns)
- Byte 2: green LED bits
- Bytes 3–4: additional flags

JS access:

```javascript
const mb = (s, r, c) => mir[s * 85 + r * 5 + c];
const ml = (s, r, b) => ((mb(s,r,1) >> b & 1) ? 2 : 0)  // red
                       | ((mb(s,r,2) >> b & 1) ? 4 : 0); // green
```

LED color values: 0 = off, 2 = red, 4 = green, 6 = amber (red+green).

## Sequencer timing

The sequencer pthread runs at 48 PPQN. At 120 BPM:

- 1 quarter note = 500ms
- 1 PPQN tick = 500ms / 48 ≈ 10.4ms (`g_tick_ns = 10416667`)

The thread uses relative `nanosleep` (Emscripten implements via
`Atomics.wait`, ~1ms resolution). No busy-wait — would burn CPU without
improving precision in WASM.

MIDI clock is sent by the sequencer thread before acquiring the scheduler
lock: `MIDI_send(MIDI_CLOCK, MIDICLOCK_CLOCK, 0, 0)` every other TTC.

## C language and compiler flags

Standard: **gnu89** (not C99+) for the Octopus engine. Many warnings
suppressed in the Makefile:

```
-Wno-unused-function -Wno-unused-variable -Wno-unused-but-set-variable
-Wno-implicit-int -Wno-int-conversion
```

Cross-variant via `-DNEMO`. Cross-platform via the `__linux__` /
`__EMSCRIPTEN__` defines. The OB-Xf synth uses `-std=c++20 -msimd128` (see
its Makefile for the rationale).

When you must touch a firmware file, use `#ifdef __linux__` /
`#ifdef __EMSCRIPTEN__` / `#ifndef __linux__` guards — never unconditional
edits.

## HTTPS and COOP/COEP/CORP

SharedArrayBuffer requires cross-origin isolation. The browser only honors
COOP/COEP headers on "secure contexts" (HTTPS or localhost). Both dev
servers send all three headers:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

Self-signed certificates live in `certs/` (gitignored — regenerate per
machine). Vite reads `certs/key.pem` and `certs/cert.pem` directly.

```bash
# Regenerate certs for a different IP/machine
openssl req -x509 -newkey rsa:2048 \
  -keyout certs/key.pem \
  -out certs/cert.pem \
  -days 365 -nodes \
  -subj "/CN=<IP-or-hostname>" \
  -addext "subjectAltName=IP:<IP>,IP:127.0.0.1,DNS:localhost"
```

## Production / process manager (optional)

For a long-running deployment behind a process manager, the recommended
setup on this machine runs the **desktop launcher binary** (serves the
embedded `dist/` over HTTPS with a persisted self-signed cert — see
`gui/README.md`) under **root supervisord**:

```ini
[program:octobx]
command=<path-to-repo-checkout>/gui/target/release/octobx_gui --no-gui --host 0.0.0.0 --port 8080
directory=<path-to-repo-checkout>
environment=OCTOBX_CERT_DIR="/home/<user>/.config/octobx"
autostart=true
autorestart=true
startretries=3
stopasgroup=true
killasgroup=true
stopwaitsecs=10
stdout_logfile=<path-to-repo-checkout>/logs/launcher.out.log
stderr_logfile=<path-to-repo-checkout>/logs/launcher.err.log
stdout_logfile_maxbytes=5MB
stdout_logfile_backups=3
stderr_logfile_maxbytes=5MB
stderr_logfile_backups=3
```

Then `sudo supervisorctl update && sudo supervisorctl restart octobx`.
Logs land in `logs/launcher.{out,err}.log` (gitignored). Note: rust-embed
bakes `dist/` into the binary at compile time, so rebuild the launcher
(`cargo build --release --manifest-path gui/Cargo.toml`) after any app
build, then restart the program to pick up the new image.

Alternatively, for a dev box, `npx vite --host 0.0.0.0 --port 8080` can be
supervised the same way (swap `command=`/log paths accordingly).

## Firmware — used as-is

OctOBX makes **zero local modifications** to the firmware. The `firmware/`
submodule points at the [`maxolgi/OCT_CE_OS`](https://github.com/maxolgi/OCT_CE_OS)
fork, which already carries all platform-adaptation guards. OctOBX consumes
that fork unchanged — never edit files under `firmware/`.

The WASM build defines `-D__linux__` (plus `-D__EMSCRIPTEN__`), which activates
the guards already committed in the fork. The relevant fork patches:

1. `includes-declarations.h` — eCos includes replaced by `#include "hal_linux.h"`
2. `play_MIDI.h` — `MIDI_send()` routes to `midi_send_event()` instead of UART mailbox
3. `show_hwdriver.h` — hardware `VIEWER_show_MIR()` body suppressed (JS reads MIR from heap)
4. `Intr_TMR.h` — MIDI clock sent from sequencer thread instead of timer ISR; `g_tick_ns` precompute
5. `cpu-load.c` — `cpu_load_at_max()` returns 0 (no hardware CPU-load timer)
6. `OS_infrastructure.h` — page-refresh alarm creation skipped (CONSTANT_BLINK mode)
7. `Init_memory.h` — `MIR_init()` loop bound fixed (original `ndx < 18` overflows `MIR[2][17][5]`)

All platform adaptation that is specific to OctOBX (not shared with the native
port) lives in `wasm/hal_wasm.c`, `wasm/main_wasm.c`, `wasm/midi_wasm.c`, and
`wasm/hal_linux.h` — never in the firmware itself.

## State persistence

OctOBX persists state across page reloads via two mechanisms:

| Layer | Storage | Trigger | Format |
|---|---|---|---|
| Octopus sequencer | IDBFS (IndexedDB) | SAVE button, GRID+PGM | binary (`/persistent/octopus_state.bin`) |
| Synth + drum state | localStorage | SAVE button | JSON (`octobx:app_state:v1`) |
| MIDI-learn bindings | localStorage | learn/unlearn (auto) | JSON (`octobx:midi_learn_v1`) |

**IDBFS** — Emscripten's IndexedDB File System is mounted at `/persistent/`
in `octopus-module.ts`. The firmware writes state to
`/persistent/octopus_state.bin` in MEMFS; `FS.syncfs(false)` flushes it to
IndexedDB. On page load, `FS.syncfs(true)` reads it back before
`engine_init()` calls `load_state()`.

**SAVE button** — `_wasm_save_state()` writes to MEMFS + syncs to IDBFS.
Also saves synth/drum state to localStorage. No file download.
**Shift+SAVE** — also downloads `octopus_state_*.bin` (hardware-compatible)
and `octobx_app_state_*.json`. **GRID+PGM** (Octopus panel) — saves to
MEMFS + syncs to IDBFS + downloads `.bin`. **LOAD button** — imports a
`.bin` file into MEMFS + syncs to IDBFS. **Shift+LOAD** — clears IDBFS +
localStorage (recovery for corrupt state).

**Synth/drum restore** — cached on page load, pushed to the AudioWorklet
after it initializes (first PLAY click) via an `onAWPReady` callback. The
restore sequence is: drum kit load → synth params → drum layer params →
per-instance settings + routing.

**Recovery** — append `?nosync` to the URL to skip IDBFS autoload.

## Testing

No automated test suite. Testing is manual: build the WASM modules, run
the dev server, and verify in the browser console:

- Transport play/stop produces ticks (`wasm_get_tick_count()` increments).
- Step toggles light MIR LEDs at 60Hz.
- MIDI events appear in the ring buffer
  (`wasm_get_midi_dropped_count()` stays at 0 under normal load).
- Hardware MIDI output via Web MIDI (Chrome/Edge) reaches a synth.
- Hardware MIDI input drives the sequencer (controller → `wasm_midi_input`
  → `G_midi_interpret_*`).
- OB-Xf: clicking PLAY brings up the AudioWorklet, Octopus channels 1–10
  drive the 10 instances, switching the instance selector re-syncs knob
  positions, loading a `.fxp` changes one instance's sound only, MIDI-learn
  binds a hardware CC to a knob.
- Save/load: tweak synth + drum params, click SAVE, reload, click PLAY —
  all tweaks should be restored. Shift+SAVE downloads `.bin` + `.json`.

## Reference docs in repo

- `AGENTS.md` — engineering guide for AI assistants (firmware submodule,
  single-TU build, eCos shim mappings, runtime architecture, exported
  functions, MIDI routing, MIR format, known issues).
- `firmware/OCT_OS/COPYING.txt`, `firmware/OCT_OS/FACTORY_RESTORE.txt` —
  firmware license and factory-restore notes from the OCT_CE_OS submodule.

## Known issues

1. **IDBFS** — fixed. Was accessing `module.IDBFS` (undefined — not in
   `EXPORTED_RUNTIME_METHODS`) instead of `FS.filesystems.IDBFS`. Now
   mounts IDBFS at `/persistent/` and the Octopus state file persists
   across reloads automatically.
2. **MPE timbre & channel pressure** — fixed. All three per-channel
   expression handlers are now dispatched from `obxd_midi_in()` when
   `g_mpe_enabled[id]` is set: pitch bend (`processMPEPitch`), timbre
   (CC 74 → `processMPETimbre`), and channel pressure (`0xD0` →
   `processMPEChannelPressure`). In non-MPE mode CC 74 and `0xD0` remain
   dropped (the legacy OB-Xd engine had no handling for either).
3. **AudioWorklet reply correlation** is correct but untyped —
   `obxd-audio.ts` uses an `unknown`-typed predicate router to avoid
   racing `port.onmessage` reassignments.
4. **Limited automated tests** — vitest covers the pure-logic modules
   (`midi-framing.ts`, `channel-routing.ts`, `obxf-midi-learn.ts`,
   `obxf-param-mappings.ts`, `obxf-param-format.ts`,
   `obxf-dispatch-coverage`, `sentinel-migration`, `awp-task-queue`) —
   141 tests; run with `npm test`. `npm run test:wasm` additionally runs
   19 behavioral checks against the built synth WASM under Node
   (`tools/verify-obxd-wasm.mjs`). The Octopus engine and
   browser-integration paths still require manual verification.

## License

OctOBX is licensed under the **GNU General Public License v3.0 or later**
([`LICENSE`](./LICENSE)). The GPL-3.0-or-later choice is deliberate: the OB-Xf
`SynthEngine` (compiled into `obxd_wasm.wasm`) is GPL-3.0-or-later, and that
choice keeps the combined work license-compatible.

### Third-party components (each under its own license, in its submodule)

| Component | Location | License |
|---|---|---|
| Octopus/Nemo firmware | `firmware/` (submodule → `maxolgi/OCT_CE_OS`) | see `firmware/OCT_OS/COPYING.txt` |
| OB-Xf `SynthEngine` | `third_party/OB-Xf/` (submodule → `surge-synthesizer/OB-Xf`) | GPL-3.0-or-later |
| JUCE core + events + audio_basics + processors_headless | `third_party/JUCE/` (submodule → `juce-framework/JUCE`) | ISC (core modules) — see `third_party/JUCE/LICENSE.md` |
| SST basic-blocks / cpputils, simde, fmt | `third_party/OB-Xf/libs/...` (sub-submodules) | see each submodule's LICENSE |

(The legacy OB-XD engine submodule `third_party/Obxd/` was removed after the
OB-Xf migration was verified.)

The combined browser build (Octopus WASM + OB-Xf WASM + TypeScript UI) is
distributed under GPL-3.0-or-later as a single derived work.

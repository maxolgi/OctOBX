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
repo targets the browser (Emscripten + one combined AudioWorklet hosting both
the OB-Xf synth and the Octopus engine + a shared WebAssembly.Memory — no
Emscripten pthreads), not ALSA/winmm.

## What's in the box

- **Octopus/Nemo sequencer** — original firmware, unmodified, running inside
  the OB-Xf AudioWorklet: `process()` pumps the engine once per 128-sample
  audio quantum (48 PPQN, sample-driven — no sequencer thread).
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
│   ├── main_wasm.c        Octopus engine entry point + exported API + sample-driven pump
│   ├── hal_wasm.c         eCos HAL shim (OCT_AWP cooperative: virtual clock, polled alarms)
│   ├── hal_linux.h        modified copy with #elif __EMSCRIPTEN__ / #ifdef OCT_AWP guards
│   ├── midi_wasm.c        MIDI ring buffers (replaces ALSA/winmm)
│   ├── flash_file.c       file-based persistence (MEMFS; bytes ferried via the worklet)
│   ├── Makefile           builds octopus_wasm.{js,wasm} (AWP build, no pthreads; or nemo_wasm.* with NEMO=1)
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
2. **Concatenates the combined AudioWorklet processor** — `src/obxd-awp-shim.js`
    + `wasm/build/octopus_wasm.js` + `wasm/build/obxd_wasm.js` +
    `src/generated/restore-layout.js` + `src/awp-task-queue.js` +
    `src/obxd-processor.tail.js` → `wasm/build/obxd-processor.js`.
    AudioWorkletGlobalScope disallows `importScripts()` and dynamic
    `import()`, so the only way to give the worklet the two emcc JS factories
    AND our `AudioWorkletProcessor` subclass is to feed them as one file to
    `audioWorklet.addModule()` — one combined module, two WASM instances.
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

The Octopus engine build targets the AudioWorklet: no `-pthread` (illegal
inside AudioWorkletGlobalScope), `-sENVIRONMENT=worker`, and
`-sIMPORTED_MEMORY -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=134217728` —
linear memory is a fixed 128 MiB shared `WebAssembly.Memory` created on the
JS main thread (`src/octopus-awp.ts`), so the main thread can hold zero-copy
views of the MIR and status block. The glue output is not loaded via a
`<script>` tag; `build.sh` concatenates it into the combined
`wasm/build/obxd-processor.js` (see step 2 above).

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

    # Required for SharedArrayBuffer (the engine's shared WebAssembly.Memory)
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
│   ├── bootOctopusEngine() (octopus-awp.ts) — creates the shared 128 MiB
│   │   WebAssembly.Memory, fetches octopus_wasm.wasm, brings up the combined
│   │   worklet node AT STARTUP; holds zero-copy views (processed MIR, status
│   │   block) + window.__octopus (OctopusController)
│   ├── Octopus UI (classic panel or modern grid) — posts oct_* messages;
│   │   renders the MIR view at 60Hz RAF
│   ├── Drum UI (kit selector, 8 pads × 4 layers, knob strips)
│   ├── OB-Xf rack + editor UI (instance selector, knobs, meters, .fxp loader, MIDI-learn)
│   ├── Hardware MIDI out — hw_midi worklet messages → attachHwMidiForwarding
│   │   → Web MIDI output port
│   ├── RAF fallback pump — while the AudioContext is suspended (autoplay
│   │   policy), posts oct_pump (wall-delta ms) per frame
│   └── Transport controls + state persistence (Tab cycles 5 views)
│
└── AudioWorklet — ONE combined node (obxd-processor.js), TWO WASM modules
    ├── octopus_wasm.wasm — Octopus sequencer engine (imports the shared memory)
    │   ├── Firmware core (~50k lines, unchanged) + hal_wasm.c / midi_wasm.c / main_wasm.c
    │   ├── octopus_pump(128) at the top of every process() quantum — 48 PPQN
    │   │   ticks on a ms accumulator, cooperative eCos clock/alarm advance,
    │   │   ~60 Hz processed-MIR + status refresh into shared memory
    │   └── emits firmware MIDI into midi_synth_ring (SPSC, shared memory)
    └── obxd_wasm.wasm — OB-Xf synth
        ├── main_obxd.cpp — 10 SynthEngine instances summed + soft-clipped
        │   └── Instance 9 = drum sampler (32 voices, 8 pads × 4 layers, PCM)
        └── juce_amalgam.cpp — juce_core + juce_events + juce_audio_basics + juce_audio_processors_headless
```

### Key design decisions

1. **Single translation unit (Octopus)** — `wasm/main_wasm.c` `#include`s
   all firmware `.h` files into one TU, matching the original firmware's
   architecture. The `.c` files in `firmware/OCT_OS/_OCT_objects/` and
   `firmware/OCT_OS/_OCT_global/flash-block.c` are `#include`d directly
   via the firmware headers — they are NOT compiled separately and NOT
   listed in `SRCS`.
2. **`-D__linux__` + `-D__EMSCRIPTEN__` + `-DOCT_AWP`** — the WASM build
   defines all three. `-D__linux__` makes the existing firmware preprocessor
   guards route `MIDI_send()` to our `midi_send_event()` and suppress
   hardware-specific code. `-D__EMSCRIPTEN__` routes platform-specific code
   to the WASM implementations. `-DOCT_AWP` selects the single-threaded
   cooperative eCos shim (see `hal_wasm.c` below). **No firmware source
   changes are needed beyond the guards already present in `firmware/`**.
3. **Sample-driven sequencer pump** — no pthread, no sequencer Web Worker:
   the worklet's `process()` calls `octopus_pump(128)` at the top of every
   render quantum, so a tick's MIDI lands in the synth in the same quantum.
   While the AudioContext is suspended (autoplay policy before the first
   gesture), process() does not run; a RAF loop on the main thread posts
   `oct_pump` messages (wall-delta ms, clamped 1–100) so the engine stays
   alive pre-gesture. The shared `WebAssembly.Memory` requires
   SharedArrayBuffer, hence the COOP/COEP/CORP headers on a secure context.
4. **Hardware MIDI via `hw_midi` messages only** — the worklet drains the
   engine's synth MIDI ring inside process() at audio-quantum rate and posts
   packed batches; `attachHwMidiForwarding()` (midi-output.ts) is the one
   path to hardware output.
5. **Direct MIR access via shared memory** — JS reads the 170-byte processed
   MIR array as a `Uint8Array` view over the shared `WebAssembly.Memory`
   (zero-copy, no serialization); the pump refreshes it at ~60 Hz.
   `VIEWER_show_MIR()` is a no-op in the WASM build.
6. **Two WASM modules in one AudioWorklet** — the synth keeps its own emcc
   build (`-sENVIRONMENT=worker`, no pthreads because pthreads are illegal
   inside AudioWorkletGlobalScope); the Octopus engine is a second module
   over the shared memory. WASM bytes are pre-fetched on the main thread and
   passed via `processorOptions` (`wasmBinary` / `octopusWasmBinary` +
   `octopusMemory`) to sidestep emcc's broken-in-AWP fetch paths.

## Octopus engine — WASM source (`wasm/`)

### `hal_linux.h`

Modified copy of the firmware's `include/hal_linux.h` with
`#elif defined(__EMSCRIPTEN__)` guards. Differences from the Linux native
copy:

- No socket / timerfd / ioctl / mman headers
- Ring-buffer mailbox type (same shape as the Windows path)
- `emscripten_get_now()` for `HAL_CLOCK_READ`
- OSC declarations excluded (`#ifndef __EMSCRIPTEN__`)
- `#ifdef OCT_AWP` types: `cyg_mutex_t` = recursion counter, `cyg_sem_t` =
  plain int count, `cyg_alarm` = virtual-clock `deadline_ms`/`interval_ms`
  fields (polled by `hal_advance_clock()`, one call per audio quantum)

### `hal_wasm.c`

eCos HAL shim. The AudioWorklet (OCT_AWP) build is single-threaded and
cooperative — blocking and thread creation are illegal on the audio thread:

- `cyg_thread_*` → descriptors recorded, nothing ever spawned (the firmware's
  10 threads were already not started; `engine_init` never called
  `init_threads`)
- `cyg_mbox_*` → ring buffer, no mutex/condvar; `cyg_mbox_get` returns NULL
  immediately when empty
- `cyg_mutex_*` / scheduler lock → recursion counters (a single thread never
  contends; depth keeps nested lock/unlock balanced)
- `cyg_semaphore_*` → plain int counters; `wait` never blocks
- `cyg_alarm_*` → armed as deadline/interval on a virtual clock;
  `hal_advance_clock(ms)` (called by `octopus_pump()` once per quantum) fires
  due handlers inline — max 16 catch-up fires per alarm per poll, and a
  periodic alarm more than 500 ms in arrears re-anchors to now
- `diag_printf` → `vfprintf(stderr)`
- In-memory flash buffer mirrors the native port

The pthread-backed implementations (real threads, condvar mailboxes,
nanosleep alarm watchers) remain in the source behind `#ifndef OCT_AWP` as a
compile-time-legacy path; the Makefile always defines OCT_AWP.

**HANDLE conflict:** the firmware defines `HANDLE` as 5 (a display mode
constant in `defs_general.h`). Don't rely on a Win32-style `HANDLE` here.

### `midi_wasm.c`

Replaces `midi_alsa.c`. Key functions:

- `midi_send_event()` — converts firmware MIDI types to raw bytes, pushes
  a 32-bit packed event (`status | data1<<8 | data2<<16 | channel<<24`)
  plus a `double` timestamp (`emscripten_get_now()` ms) into a 512-entry
  ring buffer, and also into the **synth SPSC ring** (`midi_synth_ring`,
  lock-free single-producer/single-consumer over `__atomic_*`, drained by
  the AudioWorklet's `process()` every quantum). Under OCT_AWP the pump is
  the only producer AND consumer of the primary ring, so it needs no mutex.
- `wasm_drain_midi_batch(max_count)` — copies up to 128 events + their
  timestamps into static buffers and advances head. Retained for
  compatibility; the worklet consumes the synth ring instead.
- `wasm_has_midi_event()` / `wasm_get_midi_event()` — single-event API
  retained from the pthread build.
- `wasm_midi_input(status, d1, d2)` — feeds MIDI input to the firmware's
  byte-at-a-time interpreters (`G_midi_interpret_*`).

Firmware MIDI input interpreters are byte-at-a-time state machines, not
message-level handlers. `wasm_midi_input()` sets the running-status byte
and then feeds `d1` and `d2` sequentially. The browser decodes running
status for us, so every Web MIDI message arrives with an explicit status
byte.

### `main_wasm.c`

Replaces `main_linux.c`. Key differences from native:

- No blocking `main()` loop — the worklet tail calls `engine_init()`.
- No sequencer thread (OCT_AWP): the worklet's `process()` calls
  `octopus_pump(sample_delta)` once per 128-sample quantum, which advances
  the cooperative eCos clock (`hal_advance_clock`), fires due sequencer
  ticks on a millisecond accumulator against `g_tick_ns` (backlog guard:
  max 8 ticks per pump, remainder skipped with a rate-limited log), and
  refreshes the processed MIR + shared status block at ~60 Hz
  (15 ms accumulator). `octopus_set_sample_rate()` sets the pump timebase.
- `VIEWER_show_MIR()` is a no-op (JS reads the processed MIR snapshot from
  shared memory).
- State save/load via `PersistentV2` format into Emscripten's virtual
  filesystem (`/persistent/octopus_state.bin`, MEMFS — state bytes cross
  the worklet boundary as port messages; there is no IDBFS).
- Double-click window widened for mouse input
  (`DOUBLE_CLICK_ALARM_RESOLUTION=24`, `SENSITIVITY=3`).

**Exported functions** (`EMSCRIPTEN_KEEPALIVE`). Called from the combined
worklet's processor tail (`obxd-processor.tail.js`), never directly from the
JS main thread — the UI talks to the engine through `oct_*` port messages
(`oct_key`, `oct_rotary`, `oct_transport`, `oct_pause`, `oct_tempo`,
`oct_zoom`, `oct_midi_in`, `oct_pump`, `oct_save_state`, `oct_load_state`,
`oct_shutdown`, `oct_snapshot` in; `oct_ready` (with
`mirPtr`/`processedMirPtr`/`statusPtr`), `oct_state_saved` (internal
GRID+PGM saves, carrying the state bytes), `oct_state_bytes`,
`oct_state_loaded`, `oct_snapshot` out). Keep the C definition, the
Makefile's `-sEXPORTED_FUNCTIONS` list, and the `oct_*` handler in the
worklet tail in sync.

| Function | Purpose |
|---|---|
| `engine_init()` | Initialize firmware; in OCT_AWP mark the pump ready |
| `wasm_key_press(key, press)` | Key input from UI (also refreshes the status block) |
| `wasm_rotary(rotNdx, dir)` | Rotary encoder input |
| `wasm_transport(running)` | Start/stop sequencer (also refreshes the status block) |
| `wasm_set_tempo(bpm)` | Change tempo (also refreshes the status block) |
| `wasm_set_zoom(level)` | Test/driver zoom setter (mirrors the native `/zoom` OSC) |
| `wasm_pause()` | Toggle pause (also refreshes the status block) |
| `wasm_midi_input(status, d1, d2)` | MIDI input from Web MIDI |
| `wasm_save_state()` | Save to MEMFS (`/persistent/octopus_state.bin`) |
| `wasm_load_state()` | Load from MEMFS (under scheduler lock + post-load validation) |
| `wasm_shutdown()` | Stop sequencer |
| `get_mir_ptr()` | Pointer to raw MIR array (170 bytes) |
| `get_processed_mir_ptr()` | MIR with blink processing applied (pump keeps it fresh) |
| `get_run_bit()` | Transport state |
| `get_tempo()` | Current BPM |
| `get_zoom_level()` | Current zoom mode |
| `page_refresh()` | Call `Page_full_refresh()` (fills MIR) |
| `wasm_check_refresh()` | Dirty-checked refresh — also the pump's refresh entry |
| `wasm_consume_state_saved()` | One-shot flag for internal GRID+PGM saves |
| `wasm_has_midi_event()` | Check ring buffer (single-event API) |
| `wasm_get_midi_event()` | Drain next event (single-event API) |
| `wasm_drain_midi_batch(max)` | Drain up to 128 events + timestamps in one call |
| `get_midi_batch_events_ptr()` | Pointer to the batch events array |
| `get_midi_batch_ts_ptr()` | Pointer to the batch timestamps array |
| `get_midi_synth_ring_ptr()` / `get_midi_synth_ring_head_ptr()` / `get_midi_synth_ring_tail_ptr()` | Synth SPSC ring surface the worklet drains every quantum |
| `wasm_get_midi_dropped_count()` | Number of events dropped due to ring overflow |
| `wasm_get_midi_synth_dropped_count()` | Dropped-event counter for the synth ring |
| `wasm_get_tick_ns()` | Nanoseconds per tick (debug) |
| `wasm_get_sequencer_running()` | Engine liveness (`sequencer_running` doubles as "engine initialized" in AWP) |
| `wasm_get_tick_count()` | Sequencer tick counter (debug) |
| `octopus_pump(sample_delta)` | Per-quantum pump: clock + alarms, sequencer ticks, MIR/status refresh |
| `octopus_set_sample_rate(rate)` | Pump timebase (converts sample deltas to ms) |
| `get_status_ptr()` | `int32[7]` status block: engine_ready, run_bit, tempo, zoom_level, tick_count, midi_dropped, midi_synth_dropped; `f64 tick_ns` at byte offset +32 |

### `flash_file.c`

Copied unchanged from the native port's `src/flash_file.c`. Works with
Emscripten's MEMFS virtual filesystem — state bytes cross the worklet
boundary as port messages (`oct_save_state`/`oct_load_state`); there is no
IDBFS (no `indexedDB` exists inside AudioWorkletGlobalScope).

### `Makefile`

Octopus engine build flags (AudioWorklet build):

```makefile
-std=gnu89 -D__linux__ -D__EMSCRIPTEN__ -DOCT_AWP
-sMODULARIZE=1 -sEXPORT_NAME=OctopusModuleFactory
-sENVIRONMENT=worker            # AWP is worker-like; also forbids importScripts/dynamic import
-sIMPORTED_MEMORY               # linear memory is the JS-created shared WebAssembly.Memory
-sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=134217728   # fixed 128 MiB (2048 x 64 KiB pages)
-sFORCE_FILESYSTEM=1            # MEMFS for /persistent state bytes
# no -pthread: pthreads are illegal inside AudioWorkletGlobalScope —
# the sequencer is driven by octopus_pump() instead of a thread
```

`MODULARIZE=1` exports a factory function (`OctopusModuleFactory`) that
returns a `Promise<Module>` and takes the shared memory via the factory
config's `wasmMemory` (`-sIMPORTED_MEMORY`). The glue is never loaded via a
`<script>` tag — `build.sh` concatenates it into the combined
`wasm/build/obxd-processor.js`, and the worklet tail's `ensureOctopus()`
instantiates it with pre-fetched bytes + the main thread's memory.

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
| `main.ts` | Entry point: SharedArrayBuffer check → `bootOctopusEngine()` (creates the shared memory + the combined worklet node) → build UI → transport/persistence → hardware MIDI (`attachHwMidiForwarding` before the panel) → OB-Xf rack → drum module mount. Tab key cycles the 5 views (classic → modern → synth → drums → mixer); Shift+Tab reverses. Skips when focus is on a form control. |
| `octopus-awp.ts` | Main-thread controller for the Octopus engine inside the combined OB-Xf AudioWorklet. `bootOctopusEngine()` creates the shared 128 MiB `WebAssembly.Memory`, fetches `octopus_wasm.wasm`, reads the initial state from the active project (idb-projects), and brings up the worklet node at STARTUP. Exposes `OctopusController` + `window.__octopus`; holds the zero-copy MIR/status views, the saveState/loadState/snapshot request-reply slots, the internal-save fan-out, and the RAF fallback pump used while the AudioContext is suspended. |
| `octopus-types.ts` | Slimmed shared declarations — only the OB-Xf module types remain; the Octopus surface is the `OctopusController` interface in `octopus-awp.ts`. |
| `classic-panel.ts` | Faithful port of the Octopus control surface (same DOM/IDs as the original `web_gui.html`); drives the engine through `OctopusController` `oct_*` messages, renders MIR from the shared-memory view at 60Hz. |
| `octopus-panel.ts` | Simplified modern grid view (alternative panel); same controller + shared MIR view. |
| `midi-access.ts` | Shared `openMidiAccess()` + `pollForPorts()` — works around the Chrome-on-Linux late port-enumeration quirk. |
| `midi-output.ts` | Web MIDI API **output** (Chrome/Edge). Hardware events arrive only as `hw_midi` batches forwarded from the worklet — `attachHwMidiForwarding()` registers the single handler (small +5 ms forward offset); the 60Hz RAF drain loop is gone. `frameMidi()` emits correct 1/2/3-byte messages. |
| `midi-input.ts` | Web MIDI API **input** (Chrome/Edge). `HardwareMidiInput` attaches `onmidimessage` to the selected input port and forwards `(status, d1, d2)` to `ctl.midiInput()` (`oct_midi_in` messages). Sysex / active-sensing / tune-request dropped. |
| `obxd-audio.ts` | Main-thread bootstrap + per-instance API for the combined OB-Xf/Octopus AudioWorklet. The node is created AT STARTUP by `bootOctopusEngine()`; `setupObxdAudio(octopusAssets?)` is idempotent (later rack calls are no-ops that just re-resume the AudioContext). Pre-fetches both WASM binaries and passes them via `processorOptions` (`wasmBinary` + `octopusWasmBinary`/`octopusMemory`/`octopusInitialState`). Permanent listener registry (`addWorkletMessageListener`) + one-shot reply router for async worklet RPCs. Adds `setObxdInstanceMpe` for per-instance MPE flag mirroring. |
| `obxd-bridge.ts` | Channel→instance routing state for the OB-Xf synth (default channels 1–10 → instances 0–9, reassignable per instance). MPE-aware: an instance with MPE enabled claims a lower zone (master + N voice channels) before non-MPE instances fill the rest. Pushes the routing table to the worklet via `sendObxdMidiRouting()`; the synth consumes MIDI itself from the shared ring inside process(). |
| `obxd-processor.tail.js` | Plain JS appended to the emcc output(s) at build time to form `obxd-processor.js` (the file fed to `audioWorklet.addModule()`). Subclasses `AudioWorkletProcessor`. `ensureOctopus()` boots the Octopus engine in this same worklet against the shared memory; `process()` calls `_octopus_pump(128)` FIRST, then drains the Octopus synth MIDI ring (same quantum), the queued `pendingMidi`, the deferred AWP task queue, and finally `_obxd_render(128)`. Hosts the `oct_*` message handlers. Caches `HEAPF32` views and refreshes them only when WASM memory grows (avoids per-quantum GC pressure that caused audio clicks). |
| `obxd-awp-shim.js` | Plain JS prepended to the emcc output. Polyfills `self`/`location`/`fetch`/`performance` for emcc's worker-env output inside AudioWorkletGlobalScope. |
| `obxd-rack.ts` | OB-Xf rack UI: instance selector, power/polyphony/channel selectors, level meter (30Hz ping/pong), `.fxp` loader, Reset/Panic/Panic All buttons, per-instance MPE toggle + bend-range UI. The worklet node is already up at boot; the first PLAY just resumes the suspended AudioContext (autoplay-policy gesture). |
| `obxd-synth-ui.ts` | Data-driven OB-Xf editor panel rendered from `obxf-layout.ts` (104 parameter-bound controls), absolute-positioned inside the 1150×576 OB-Xf VectorTheme canvas. Legacy-indexed controls dispatch via `setObxdInstanceParam(idx, v)`; OB-Xf-only controls get a sentinel `200 + canonical ordinal`, assigned NAME-KEYED from the generated `canonicalNewParamOrder` (the `RingModVol`→`RingModMix` layout-id alias is handled). `syncObxdControlsFromEngine(instanceId)` re-seeds widget positions from `g_param_mirror` (legacy) and `g_new_param_mirror` (NEW params) on instance switch / patch load. |
| `obxd-knob.ts` | Vanilla SVG widget factories (no deps): `createObxdKnob`, `createObxdToggle`, `createTriStateButton`, `createSelector`, `createSlider`, `createButton`. Drag/wheel/double-click (reset); bipolar knobs supported. |
| `obxf-layout.ts` | OB-Xf editor UI layout spec — read-only data module auto-extracted from the OB-Xf source tree (theme.xml + `ObxfEditorLayout.cpp` + `SynthParam.h` + `ParameterList.h`). 173 `ControlSpec` entries (104 parameter-bound + 69 special widgets) across 13 sections, plus `obxfTheme` color tokens and the 1150×576 canvas geometry. Do not edit by hand — see the file header. |
| `obxf-param-mappings.ts` | AUTO-GENERATED by `tools/gen-param-table.mjs` from `tools/param-spec.mjs` — do not edit. 80 legacy rows (BENDRANGE split encoded via `secondaryNewId`/`secondaryMethod`), plus `canonicalNewParamOrder`, drum classification, and pure `forward`/`invert` transform functions. |
| `obxf-midi-learn.ts` | OB-Xf MIDI-learn **logic** layer (no UI): standalone port of the OB-Xf `MidiHandler`/`MidiMap` state machine. CC→0..1 transforms, learn-then-apply path, lag smoother, reserved-CC pre-screening. |
| `obxf-midi-learn-integration.ts` | Singleton `ObxfMidiLearnManager` + per-param registry. `processHardwareCC()` is the single entry point `midi-input.ts` calls before forwarding a CC — returns true when consumed by learn. Bindings persist to localStorage; auto-save on every learn/unlearn. |
| `obxf-midi-learn-ui.ts` | MIDI-learn **overlay** UI: renders the OB-Xf `midiLearnButton`, paints per-knob `CC{n}` badges above bound controls, toggles the red panel-border learn-mode indicator, click-badge-to-unlearn. |
| `transport-sync.ts` | Wires PLAY/STOP/BPM to the Octopus engine (controller `oct_*` messages) and updates the on-screen transport indicator; seeds the tempo display from the shared status block. |
| `state-persistence.ts` | Octopus sequencer state save/load as BYTES through the worklet (`ctl.saveState()`/`ctl.loadState()`), stored in the octobx projects IndexedDB (idb-projects.ts); localStorage holds only the project index + active-project name. Internal GRID+PGM saves arrive as `oct_state_saved` bytes → `onStateSavedBytes` (auto-save + download). LOAD imports `.bin` files via `ctl.loadState()`. Shift+LOAD purges legacy `EM_FS_*` IDBFS leftovers + clears app state (recovery). Boot auto-load comes from the active project inside `bootOctopusEngine()`. |
| `app-state.ts` | Synth + drum state persistence. Dumps all synth (10×108) and drum (8×4×108) params from the AWP in bulk, plus per-instance settings (power, polyphony, channel, MPE, bend range) and drum kit, to localStorage JSON. Restores after AWP ready via `onAWPReady` callback. |
| `drum-rack.ts` | Drum module UI: kit selector, 8 pads × 4 layers with dual sample-kit + sample dropdowns (cross-kit sample mixing via `DrumLayer.sourceUrl` + `SAMPLE_CATALOG`), mute/enable toggles, and per-layer knob strips (48 controls: 8 global + 40 per-layer). SVG arc knobs with iOS-style toggle pills and tri-state LFO-routing pills. Layer section has Gain/Pan/Pitch knobs with custom dispatch (bypass `g_drum_layer_params`, update `DrumLayer` object + `pushLayer` → `set_pcm_layer`). `syncEditor`/`syncKnobStrips` re-seed knob positions on pad/layer switch. |
| `drum-audio.ts` | Main-thread audio bootstrap for the drum module on OB-Xf instance 9 (32 voices). `loadDrumKit` fetches samples from smpldsnds CDN, decodes via `AudioContext.decodeAudioData`, posts float arrays to the worklet via `obxd_load_pcm`. Per-layer URL resolution via `layerSampleUrl(lyr, kitSource)` (`lyr.sourceUrl ?? kitSource`) supports cross-kit sample mixing. Serialized via `kitLoadChain` promise chain (prevents concurrent loads). `sendLayerParams` pushes per-layer params (gain, filter, amp env, pan, pitch). `seedLayerMirror` seeds `g_drum_layer_params` on load. `pushLayer` re-sends one layer's full param set. |
| `drum-state.ts` | Pure data layer: `DrumLayer` / `DrumPad` / `DrumKit` interfaces + factory functions. No project dependencies. `DrumLayer` fields: enabled, sampleName, sourceUrl (optional — when set, sample loads from this URL prefix instead of the loaded kit's source; enables cross-kit sample mixing), gain, filterCutoff/Resonance/Mode, amp ADSR, pan, pitch (0..1, 0.5=original), muted, `_seeded` flag. |
| `drum-kits.ts` | 10 drum-kit presets sourced from the Public Domain smpldsnds CDN. Each kit maps its samples onto 8 GM pads (Kick, Snare, Closed HH, Open HH, Tom Lo, Clap, Cowbell, Ride). Secondary layers get `gain: 0.55, filterCutoff: 0.8` (quieter + darker). Closed HH + Open HH share choke group 0. Also exports `SAMPLE_CATALOG` (one entry per kit with deduped sample list + source URL) that drives the layer-editor dual dropdown UI for cross-kit sample mixing. |

Input conventions: `skey(key, press)` → `ctl.key()` → `oct_key` message →
`_wasm_key_press`; rotary knobs → `ctl.rotary()` → `oct_rotary`; drag-paint
step pads (mouse + touch); Ctrl-click hold mode.

## MIDI routing

Real MIDI is a first-class feature, wired through the Web MIDI API
(Chrome/Edge only). The Octopus engine emits events into a 512-entry SPSC
ring buffer in shared WASM memory. Each event is a 32-bit packed word
(`status | data1<<8 | data2<<16 | channel<<24`). The AudioWorklet's
`process()` drains this ring every 128-sample quantum — the same quantum as
the pump that produced the events — and dispatches:

1. **OB-Xf synth (in-worklet)** — each channel-voice event is routed through
   the channel→instance table (`obxd-bridge.ts`, default channels 1–10 →
   instances 0–9, reassignable per instance; MPE-aware: an instance with MPE
   enabled claims a lower zone before non-MPE instances fill the rest) and
   fed straight into `obxd_midi_in()` — the lowest-latency path in the app,
   with no main-thread round trip.
2. **Hardware output** — the worklet posts each drained batch as an `hw_midi`
   message; `attachHwMidiForwarding()` (midi-output.ts) frames each event to
   the correct byte length (1-byte system real-time, 2-byte
   program-change/channel-pressure, 3-byte channel-voice) and sends it to the
   selected Web MIDI output port. Wrong-length framing corrupts the stream
   to hardware synths. This is the ONLY path to hardware output.

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
octopus_pump(128) — Octopus engine, runs at the top of every process() quantum
   ↓ fires 48-PPQN ticks → firmware MIDI_send
midi_synth_ring (SPSC, shared WebAssembly.Memory)
   ↓ same-quantum drain inside process(), routed per channel
   │   obxd-bridge.ts routing table (channel → instance bitmask, MPE-aware zones)
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

The same drain also posts every batch as an `hw_midi` message for hardware
MIDI output (see "MIDI routing").

Init flow:

1. Page load: `bootOctopusEngine()` (octopus-awp.ts) creates the shared
   128 MiB `WebAssembly.Memory`, fetches both WASM binaries, and calls
   `setupObxdAudio()` — the combined worklet node comes up AT STARTUP, not
   lazily on first PLAY. The OB-Xf rack + editor panel build eagerly
   (defaults baked in) and start a 30Hz meter ping/pong.
2. The worklet's `ensureModule()` monkey-patches
   `WebAssembly.instantiateStreaming`/`instantiate` to consume the
   pre-fetched bytes (emcc's fetch/XHR paths are broken in AWP), invokes
   `ObxdModuleFactory`, calls `_obxd_init(sampleRate)`, and posts
   `{type:'ready'}`. `ensureOctopus()` then boots the Octopus engine against
   the shared memory (`engine_init`, optional initial-state replay from the
   active project) and posts `oct_ready` with the MIR/status byte offsets.
3. The AudioContext is still suspended (autoplay policy) — process() is not
   called yet, so `octopus-awp.ts` runs the RAF fallback pump (`oct_pump`
   messages) to keep the sequencer alive. The first user gesture (PLAY
   click anywhere, or a note-editing action hooked in the rack) resumes the
   context; the RAF loop stops itself and audio takes over the clock.
4. Octopus PLAY drives all 10 instances via MIDI channels 1–10
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

JS access — the worklet's pump refreshes a processed snapshot (blink applied)
into shared memory at ~60 Hz; the main thread reads it as a zero-copy
`Uint8Array` view over the shared `WebAssembly.Memory` (byte offset handed
over in the `oct_ready` message):

```javascript
const mb = (s, r, c) => mir[s * 85 + r * 5 + c];
const ml = (s, r, b) => ((mb(s,r,1) >> b & 1) ? 2 : 0)  // red
                       | ((mb(s,r,2) >> b & 1) ? 4 : 0); // green
```

LED color values: 0 = off, 2 = red, 4 = green, 6 = amber (red+green).

## Sequencer timing

48 PPQN, sample-driven. At 120 BPM:

- 1 quarter note = 500ms
- 1 PPQN tick = 500ms / 48 ≈ 10.4ms (`g_tick_ns = 10416667`)
- At 48 kHz a 128-sample render quantum is ~2.67ms, so a tick fires roughly
  every 4 quanta — `octopus_pump()` converts each quantum to milliseconds
  and accumulates against `g_tick_ns`.

A backlog guard caps catch-up at 8 ticks per pump and skips the remainder
(rate-limited log, once per 10 s). No `Atomics.wait`/nanosleep, no sequencer
thread, and no background-tab stalls while the context runs (audio render is
exempt from tab throttling); while the context is suspended the RAF fallback
pump keeps the engine alive at display rate.

MIDI clock is sent by the pump before acquiring the scheduler lock:
`MIDI_send(MIDI_CLOCK, MIDICLOCK_CLOCK, 0, 0)` every other TTC, gated on
`G_run_bit`.

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

The WASM build defines `-D__linux__` (plus `-D__EMSCRIPTEN__` and, for the
AudioWorklet build mode, `-DOCT_AWP`), which activates the guards already
committed in the fork. The relevant fork patches:

1. `includes-declarations.h` — eCos includes replaced by `#include "hal_linux.h"`
2. `play_MIDI.h` — `MIDI_send()` routes to `midi_send_event()` instead of UART mailbox
3. `show_hwdriver.h` — hardware `VIEWER_show_MIR()` body suppressed (JS reads MIR from heap)
4. `Intr_TMR.h` — MIDI clock sent from the sequencer tick source (the pump in OctOBX) instead of timer ISR; `g_tick_ns` precompute
5. `cpu-load.c` — `cpu_load_at_max()` returns 0 (no hardware CPU-load timer)
6. `OS_infrastructure.h` — page-refresh alarm creation skipped (CONSTANT_BLINK mode)
7. `Init_memory.h` — `MIR_init()` loop bound fixed (original `ndx < 18` overflows `MIR[2][17][5]`)

All platform adaptation that is specific to OctOBX (not shared with the native
port) lives in `wasm/hal_wasm.c`, `wasm/main_wasm.c`, `wasm/midi_wasm.c`, and
`wasm/hal_linux.h` — never in the firmware itself.

## State persistence

OctOBX persists state across page reloads via these mechanisms:

| Layer | Storage | Trigger | Format |
|---|---|---|---|
| Octopus sequencer | IndexedDB projects (`idb-projects.ts`) | SAVE button, GRID+PGM (auto) | binary bytes through the worklet |
| Synth + drum state | localStorage | SAVE button | JSON (`octobx:app_state:v1`) |
| MIDI-learn bindings | localStorage | learn/unlearn (auto) | JSON (`octobx:midi_learn_v1`) |

**Octopus engine state** — saved/loaded as BYTES through the worklet:
`ctl.saveState()` posts `oct_save_state`, the worklet runs the C
`save_state()` into MEMFS (`/persistent/octopus_state.bin`), reads the bytes
back across the heap, and replies `oct_state_bytes`. Loading is the mirror
image (`oct_load_state`). There is no IDBFS any more (no `indexedDB` exists
inside AudioWorkletGlobalScope). Boot auto-load happens inside
`bootOctopusEngine()`: the active project's `octopusState` bytes are staged
into the worklet's MEMFS and replayed through `_wasm_load_state()` right
after `engine_init()`. Internal GRID+PGM saves surface as `oct_state_saved`
messages → `onStateSavedBytes` (auto-save to the active project + download).

**SAVE button** — saves to the active project slot (IndexedDB) + synth/drum
state to localStorage. No file download. **Shift+SAVE** — also downloads
`octopus_state_*.bin` (hardware-compatible) and `octobx_app_state_*.json`.
**LOAD button** — imports a `.bin` file via `ctl.loadState()`. **Shift+LOAD**
— purges legacy `EM_FS_*` IDBFS leftovers from older builds + clears
localStorage app state (recovery for corrupt state).

**Synth/drum restore** — cached on page load, pushed to the worklet after
AWP ready via an `onAWPReady` callback. The restore sequence is: drum kit
load → synth params → drum layer params → per-instance settings + routing.

**Recovery** — append `?nosync` to the URL to skip the boot auto-load.

## Testing

**Automated** — `npm test` runs vitest over the pure-logic modules
(`midi-framing.ts`, `channel-routing.ts`, `obxf-midi-learn.ts`,
`obxf-param-mappings.ts`, `obxf-param-format.ts`,
`obxf-dispatch-coverage`, `sentinel-migration`, `dense-layer-index`,
`awp-task-queue`) — no browser required. `npm run test:wasm` additionally
exercises the built synth WASM under Node (`tools/verify-obxd-wasm.mjs`).
`npm run test:octopus` drives the built Octopus engine WASM behaviorally in
headless Chromium (`tools/verify-octopus-wasm.mjs`, playwright-core +
system Chromium, serving `dist/` with COOP/COEP): 10 manual-grounded
behaviors ported from the native repo's `tests/test_manual.py` (transport,
zoom indicators, page selection, record arm, state save, tempo). Since the
engine moved into the worklet, the harness drives it through the
`window.__octopus` controller and reads the processed MIR / status block
from the shared memory (autoplay-muted context kept ticking by the RAF
fallback pump / an autoplay flag). The native suite's name-based OSC test
is N/A — OctOBX has no OSC surface.

**Manual**: build the WASM modules, run the dev server, and verify in the
browser console:

- Transport play/stop produces ticks (status-block `tick_count` increments).
- Step toggles light MIR LEDs at 60Hz.
- MIDI events appear in the ring buffer
  (`midi_dropped` / `midi_synth_dropped` status slots stay at 0 under normal load).
- Hardware MIDI output via Web MIDI (Chrome/Edge) reaches a synth.
- Hardware MIDI input drives the sequencer (controller → `ctl.midiInput()`
  → `G_midi_interpret_*`).
- OB-Xf: the worklet is up from page load; PLAY resumes the suspended
  AudioContext, Octopus channels 1–10 drive the 10 instances, switching the
  instance selector re-syncs knob positions, loading a `.fxp` changes one
  instance's sound only, MIDI-learn binds a hardware CC to a knob.
- Save/load: tweak synth + drum params, click SAVE, reload — all tweaks
  should be restored. Shift+SAVE downloads `.bin` + `.json`.

## Reference docs in repo

- `AGENTS.md` — engineering guide for AI assistants (firmware submodule,
  single-TU build, eCos shim mappings, runtime architecture, exported
  functions, MIDI routing, MIR format, known issues).
- `firmware/OCT_OS/COPYING.txt`, `firmware/OCT_OS/FACTORY_RESTORE.txt` —
  firmware license and factory-restore notes from the OCT_CE_OS submodule.

## Known issues

1. **IDBFS — removed.** The Octopus engine no longer mounts Emscripten's
   IDBFS (there is no `indexedDB` inside AudioWorkletGlobalScope). Engine
   state is saved/loaded as bytes through the worklet
   (`ctl.saveState()`/`ctl.loadState()`) and stored in the octobx projects
   IndexedDB; boot auto-load comes from the active project. Shift+LOAD
   still purges legacy `EM_FS_*` IDBFS leftovers from older builds.
2. **MPE timbre & channel pressure** — fixed. All three per-channel
   expression handlers are now dispatched from `obxd_midi_in()` when
   `g_mpe_enabled[id]` is set: pitch bend (`processMPEPitch`), timbre
   (CC 74 → `processMPETimbre`), and channel pressure (`0xD0` →
   `processMPEChannelPressure`). In non-MPE mode CC 74 and `0xD0` remain
   dropped (the legacy OB-Xd engine had no handling for either).
3. **AudioWorklet reply correlation** is correct but untyped —
   `obxd-audio.ts` uses an `unknown`-typed predicate router to avoid
   racing `port.onmessage` reassignments.
4. **Limited automated tests** — vitest (`npm test`) covers the pure-logic
   modules (`midi-framing.ts`, `channel-routing.ts`, `obxf-midi-learn.ts`,
   `obxf-param-mappings.ts`, `obxf-param-format.ts`,
   `obxf-dispatch-coverage`, `sentinel-migration`, `dense-layer-index`,
   `awp-task-queue`) — 179 tests; `npm run test:wasm`
   (`tools/verify-obxd-wasm.mjs`) covers the OB-Xf synth WASM under Node;
   `npm run test:octopus` (`tools/verify-octopus-wasm.mjs`) covers the
   Octopus engine WASM behaviorally in headless Chromium (10 tests — see
   Testing). Still manual-only: drum audio, Web MIDI hardware I/O, project
   save/reload round-trip, and the AudioWorklet integration paths.

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

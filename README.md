# OctOBX — Octopus/Nemo sequencer + OB-XD synth, in the browser

The Genoqs Octopus/Nemo MIDI sequencer firmware (~50k lines of C89) compiled
to **WebAssembly via Emscripten**, with a TypeScript/Vite web UI, a built-in
multi-instance **OB-XD synthesizer** running in an `AudioWorklet`, and
hardware MIDI I/O via the Web MIDI API.

This is the WASM/browser port. It is a sibling project to the native
Linux/Windows C-engine port at <https://github.com/maxolgi/Octopus>. The two
share the same firmware source and the same eCos-HAL shim concept, but this
repo targets the browser (Emscripten + Web Workers + SharedArrayBuffer +
AudioWorklets), not ALSA/winmm.

## What's in the box

- **Octopus/Nemo sequencer** — original firmware, unmodified, running in a
  pthread (Web Worker) at 48 PPQN.
- **OB-XD synth rack** — 10 concurrent `SynthEngine` instances from the
  `2DaT/Obxd` project, summed and soft-clipped in a single AudioWorklet.
  Driven by Octopus MIDI channels 1–10 (reassignable per instance).
- **Hardware MIDI I/O** — Web MIDI API output to real synths + input from
  real controllers (Chrome/Edge only).

## Repository layout

```
.
├── firmware/              git submodule → OCT_CE_OS (Octopus + Nemo firmware)
├── third_party/
│   ├── Obxd/              git submodule → 2DaT/Obxd (SynthEngine source)
│   └── JUCE/              git submodule → juce-framework/JUCE (core + audio_basics)
├── wasm/
│   ├── main_wasm.c        Octopus engine entry point + exported API
│   ├── hal_wasm.c         eCos HAL shim (pthreads, ring-buffer mbox, nanosleep)
│   ├── hal_linux.h        modified copy with #elif __EMSCRIPTEN__ guards
│   ├── midi_wasm.c        MIDI ring buffer (replaces ALSA/winmm)
│   ├── flash_file.c       file-based persistence (works with MEMFS/IDBFS)
│   ├── Makefile           builds octopus_wasm.{js,wasm} (or nemo_wasm.* with NEMO=1)
│   └── obxd/
│       ├── main_obxd.cpp  multi-instance SynthEngine wrapper (10 instances)
│       ├── juce_amalgam.cpp   single-TU JUCE core + audio_basics
│       └── Makefile       builds obxd_wasm.{js,wasm}
├── src/                   TypeScript UI + MIDI + OB-XD rack
├── index.html             transport bar + OB-XD panel shell
├── vite.config.ts         HTTPS dev server with COOP/COEP/CORP headers
├── serve.py               plain-HTTP dev server with the same headers
├── build.sh               build orchestrator (wasm | synth | app | all)
└── AGENTS.md              engineering guide for AI assistants (read this too)
```

## First-time clone

This repo uses three submodules:

```bash
git clone --recurse-submodules <repo-url>
# Or after a regular clone:
git submodule update --init --recursive
```

The firmware submodule (`firmware/`) is required for the Octopus WASM build.
The OB-XD and JUCE submodules (`third_party/Obxd`, `third_party/JUCE`) are
required for the synth WASM build.

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
./build.sh          # Octopus WASM + OB-XD WASM + TypeScript app
./build.sh wasm     # Octopus engine WASM only
./build.sh synth    # OB-XD synth WASM only (+ patches.h generation)
./build.sh app      # TypeScript app only (npm install + vite build)
```

`build.sh synth` does two extra things:

1. **Generates `wasm/obxd/patches.h`** from any `wasm/obxd/patches/*.fxp`
   files via `xxd -i`. When no `.fxp` files are present (the default),
   `patches.h` is removed and the C side falls back to its programmatic
   factory table (`g_factory_programs` in `main_obxd.cpp`). Supply real
   `.fxp` files in `wasm/obxd/patches/` (named `01_pad.fxp`, `02_bass.fxp`,
   …, `10_kick.fxp`) to override the programmatic patches.
2. **Concatenates the AudioWorklet processor** — `src/obxd-awp-shim.js` +
   `wasm/build/obxd_wasm.js` + `src/obxd-processor.tail.js` →
   `wasm/build/obxd-processor.js`. AudioWorkletGlobalScope disallows
   `importScripts()` and dynamic `import()`, so the only way to give the
   worklet both the emcc JS and our `AudioWorkletProcessor` subclass is to
   feed them as one file to `audioWorklet.addModule()`.

### Manual builds

```bash
# Octopus engine
make -C wasm           # → wasm/build/octopus_wasm.{js,wasm}
make -C wasm NEMO=1    # Nemo variant → wasm/build/nemo_wasm.{js,wasm}
make -C wasm clean

# OB-XD synth (requires third_party/{Obxd,JUCE} submodules)
make -C wasm/obxd      # → wasm/build/obxd_wasm.{js,wasm}
make -C wasm/obxd clean
```

### Dev server

```bash
npm install

# Option A — Vite (HTTPS + COOP/COEP/CORP). Needs certs/ (see below).
npx vite --host 0.0.0.0 --port 8080

# Option B — plain HTTP + COOP/COEP/CORP (no certs required; SAB works on localhost)
python3 serve.py

# Option C — nginx. Serves the built dist/ (run ./build.sh app first).
#            No Node required at runtime. Config snippet below.
```

Open the URL you started. With Vite, accept the self-signed cert warning
(needed because SharedArrayBuffer requires a secure context). With
`serve.py` on `localhost`, the browser treats it as a secure context already.

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
│   ├── MIR rendering (60Hz RAF → reads WASM heap via HEAPU8)
│   ├── OB-XD rack UI (instance selector, knobs, meters, .fxp loader)
│   ├── Transport controls + state persistence
│   └── Single 60Hz MIDI drain loop (RAF)
│        └── fans each batch out to two parallel consumers:
│            • HardwareMidiOutput  → Web MIDI output port
│            • createObxdBridgeHandler  → OB-XD AudioWorklet (per-instance)
│
├── WASM Module — Octopus engine  (octopus_wasm.wasm, ~1.6MB)
│   ├── Firmware core (~50k lines, unchanged from native)
│   ├── hal_wasm.c / midi_wasm.c / main_wasm.c
│   └── Sequencer pthread (48 PPQN, nanosleep timing)
│
└── AudioWorklet — OB-XD synth  (obxd_wasm.wasm, ~20MB)
    ├── main_obxd.cpp  — 10 SynthEngine instances summed + soft-clipped
    └── juce_amalgam.cpp — juce_core + juce_audio_basics
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
   out. Today the consumers are hardware MIDI output and the OB-XD bridge;
   the `BatchDrainHandler` indirection means a future consumer (another
   DAW, a MIDI file recorder, etc.) plugs in with one line in `main.ts`.
5. **Direct MIR access** — JS reads the 170-byte MIR array directly from
   WASM linear memory via `HEAPU8`. No serialization. `VIEWER_show_MIR()`
   is a no-op in the WASM build.
6. **OB-XD in a separate WASM module inside an AudioWorklet** — the synth
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
| `wasm_save_state()` | Save to IDBFS |
| `wasm_load_state()` | Load from IDBFS |
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

## OB-XD synth — WASM source (`wasm/obxd/`)

### `main_obxd.cpp`

Multi-instance OB-XD wrapper. Up to 10 `SynthEngine` instances share one
WASM heap and are summed per quantum into a master stereo buffer with an
always-on `x/(1+|x|)` soft-clip. State per instance:

- `g_engines[10]` / `g_engine_active[10]` / `g_engine_polyphony[10]`
- `g_param_mirror[10][PARAM_COUNT]` — `SynthEngine` has no getter API, so
  we maintain our own copy alongside the engine state. `_obxd_get_param`
  reads from here; the knob UI uses it to render values after a patch load.
- `g_patch_name[10][64]` — last-loaded program name per instance.
- `g_engine_rms[10]` — per-instance RMS metering, updated during render.

**Engine API** (per `third_party/Obxd/Source/Engine/SynthEngine.h`):
`setSampleRate(float)`, `processSample(float* L, float* R)` (one stereo
sample), `procNoteOn(note, vel01)`, `procNoteOff(note)`, `allNotesOff()`,
`allSoundOff()`, `setVoiceCount(float)` (roundToInt(v*7+1) voices), and
~60 per-param `processX(float)` setters.

`SynthEngine` has no `setParameter(idx, val)` dispatch — that lived on the
JUCE `AudioProcessor` wrapper (`ObxdAudioProcessor::setParameter`). We
replicate the switch locally in `apply_param_instance()` so we can seed
defaults and implement `_obxd_set_param` without depending on
`PluginProcessor.cpp`.

**Factory patches** — when `wasm/obxd/patches.h` is present at compile
time (produced by `build.sh synth` from real `.fxp` files), it takes
precedence over the programmatic fallback table. The fallback table has
10 hand-tuned patches (`Analog Pad`, `Bass Pulse`, `Lead Saw`, `Pluck`,
`Strings`, `Keys`, `Drone`, `Stab`, `Noise Hat`, `Kick`) whose names
MUST match the option labels in `index.html`'s instance selector.

**`.fxp` (VST2 preset) loading** — supports both regular (float array)
and chunk (JUCE XML) formats. Big-endian integers/floats per the
Steinberg spec. See the long comment block in `load_fxp_data()` for the
full format breakdown.

**Exports** (`EMSCRIPTEN_KEEPALIVE`, all instance-aware except
`obxd_panic_all`):

| Function | Purpose |
|---|---|
| `obxd_init(sample_rate)` | Create all 10 SynthEngine instances + apply factory patches |
| `obxd_render(n)` | Render `n` samples, sum all active engines, soft-clip |
| `get_buf_l_ptr()` / `get_buf_r_ptr()` | Master stereo buffer pointers |
| `obxd_set_active(id, active)` | Per-instance mute |
| `obxd_get_active(id)` | Per-instance mute state |
| `obxd_set_polyphony(id, voices)` | Per-instance voice count (1–8) |
| `obxd_get_polyphony(id)` | Per-instance voice count |
| `obxd_midi_in(id, status, d1, d2)` | Per-instance MIDI message |
| `obxd_set_gain(id, gain)` | Per-instance output gain |
| `obxd_set_param(id, idx, value01)` | Per-instance parameter set |
| `obxd_get_param(id, idx)` | Per-instance parameter read |
| `obxd_load_fxp(id, ptr, len)` | Load `.fxp` preset bytes into instance |
| `obxd_all_notes_off(id)` | Per-instance note-off |
| `obxd_panic(id)` | Per-instance all-sound-off |
| `obxd_panic_all()` | Global all-sound-off |
| `obxd_reset_patch(id)` | Reset instance to engine defaults |
| `obxd_get_patch_name(id)` | Last-loaded patch name |
| `obxd_set_factory_patch(id, patch_id)` | Apply factory patch 0–9 to instance |
| `obxd_get_instance_rms(id)` | Per-instance RMS meter |
| `obxd_set_freq(freq)` | Backwards-compat no-op |

### `juce_amalgam.cpp`

Single TU that compiles `juce_core.cpp` + `juce_audio_basics.cpp` via the
JUCE amalgamated-source pattern. MUST be a separate TU from
`main_obxd.cpp` because JUCE's `.cpp` files refuse to compile in any TU
where the matching `.h` has already been included. Critically `#undef
__linux__` before including JUCE so `TargetPlatform.h`'s `#elif defined(__wasm__)`
branch fires (otherwise JUCE picks up its Linux code paths, which don't
compile under Emscripten).

### `Makefile`

OB-XD build flags:

```makefile
-std=c++17 -O3
-sENVIRONMENT=worker         # AWP is worker-like
-sMODULARIZE=1 -sEXPORT_NAME=ObxdModuleFactory
-sINITIAL_MEMORY=67108864    # 64MB; actual usage ~20MB
-sALLOW_MEMORY_GROWTH=1
-sFORCE_FILESYSTEM=0         # worklet can't read FS; bytes go via _malloc + HEAPU8.set
-sDISABLE_EXCEPTION_CATCHING=0   # JUCE/Obxd use std::exception paths
```

No `-pthread`: pthreads are illegal inside AudioWorkletGlobalScope.

## TypeScript source (`src/`)

| File | Role |
|---|---|
| `main.ts` | Entry point: SharedArrayBuffer check → load WASM → `engine_init()` → build UI → transport/persistence → hardware MIDI → OB-XD rack. |
| `octopus-types.ts` | TS interface matching the Octopus C `EMSCRIPTEN_KEEPALIVE` exports. |
| `octopus-module.ts` | Loads the Octopus WASM module (dynamic `<script>`, `locateFile`, IDBFS mount attempt at `/persistent`). |
| `classic-panel.ts` | Faithful port of the Octopus control surface (same DOM/IDs as the original `web_gui.html`); direct WASM calls instead of WebSocket. |
| `octopus-panel.ts` | Simplified modern grid view (alternative panel). |
| `midi-access.ts` | Shared `openMidiAccess()` + `pollForPorts()` — works around the Chrome-on-Linux late port-enumeration quirk. |
| `midi-output.ts` | Web MIDI API **output** (Chrome/Edge). `drainMidiToHardware()` owns the single 60Hz RAF drain loop and fans batches out to the parallel consumers. Exports the `BatchDrainHandler` type. `frameMidi()` emits correct 1/2/3-byte messages. Adds a `MIDI_FORWARD_OFFSET_MS=20` timestamp offset for jitter-free scheduled delivery via `MIDIOutput.send(data, ts)`. |
| `midi-input.ts` | Web MIDI API **input** (Chrome/Edge). `HardwareMidiInput` attaches `onmidimessage` to the selected input port and forwards `(status, d1, d2)` to `wasm_midi_input()`. Sysex / active-sensing / tune-request dropped. |
| `obxd-audio.ts` | Main-thread bootstrap + per-instance API for the OB-XD AudioWorklet. Pre-fetches the WASM bytes and passes them via `processorOptions.wasmBinary`. Implements a one-shot reply router for async worklet RPCs (`fxp_loaded`, `param_value`) so concurrent callers don't race on `port.onmessage`. |
| `obxd-bridge.ts` | Consumer of the drain loop → OB-XD AudioWorklet. Channel→instance routing (default channels 1–10 → instances 0–9, reassignable per instance via the rack UI). No-ops while the synth isn't ready. Re-exports `BatchDrainHandler`. |
| `obxd-processor.tail.js` | Plain JS appended to the emcc output at build time to form `obxd-processor.js` (the file fed to `audioWorklet.addModule()`). Subclasses `AudioWorkletProcessor`, drains queued MIDI at the top of `process()`, calls `_obxd_render(128)`, copies cached `HEAPF32` views to the output. Caches the views and refreshes them only when WASM memory grows (avoids per-quantum GC pressure that caused audio clicks). |
| `obxd-awp-shim.js` | Plain JS prepended to the emcc output. Polyfills `self`/`location`/`fetch`/`importScripts`/`document`/`performance` for emcc's worker-env output, which assumes all of those exist but AudioWorkletGlobalScope doesn't define them. |
| `obxd-rack.ts` | Phase C UI for the multi-instance synth: instance selector, power/polyphony/channel selectors, level meter (30Hz ping/pong), `.fxp` loader, Reset/Panic/Panic All buttons. Lazy-inits the AudioContext on first PLAY click (autoplay-policy compliance). |
| `obxd-synth-ui.ts` | Grouped knob/toggle grid for the OB-XD panel (~30 controls). Indices match `ParamsEnum.h`. `syncObxdControlsFromEngine(instanceId)` queries the engine for each control's value on the chosen instance and updates the widget without re-firing onChange. |
| `obxd-knob.ts` | Vanilla SVG knob + toggle widgets. No external deps. Drag/wheel/double-click (reset). |
| `transport-sync.ts` | Wires PLAY/STOP/BPM to the Octopus engine and updates the on-screen transport indicator. |
| `state-persistence.ts` | Save/Load buttons → IDBFS sync. |

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
2. **OB-XD bridge** — maps Octopus channel → OB-XD instance (default
   channels 1–10 → instances 0–9, reassignable per instance) and
   `postMessage`s to the AudioWorklet.

The drain loop exposes a `BatchDrainHandler` type so additional consumers
can be plugged in by adding a single line in `main.ts`.

**Chrome-on-Linux late enumeration** — after the MIDI permission is
granted, the *first* `requestMIDIAccess()` delivers ports via
`statechange` events. On *reload* (permission already granted) no
`statechange` fires and the call can resolve with **empty** input/output
maps — so the selectors stay "None". `midi-access.ts` `pollForPorts()`
repopulates every 250ms (up to 4s) until ports appear. There is also a
`↻ Rescan` button (`#oct-midi-rescan`) that calls `rescan()` on both
classes for hotplug/recovery.

UI selectors: `#oct-midi-output`, `#oct-midi-input`, `#oct-midi-rescan`
(in `index.html` transport bar).

## OB-XD runtime architecture

```
Octopus sequencer (pthread) → MIDI ring buffer → 60Hz drain
   ↓
obxd-bridge.ts (channel → instance routing, configurable per instance)
   ↓ postMessage({instance_id, status, d1, d2})
AudioWorkletNode (single)
   ↓
obxd_wasm.wasm
   g_engines[10]                 (SynthEngine instances, all created at init)
   g_engine_active[10]           (all true by default)
   g_engine_polyphony[10]        ({8,1,1,1,1,1,1,1,1,1} by default)
   g_engine_rms[10]              (per-instance RMS, updated during render)
   ↓
obxd_render(n): for each active engine, processSample, sum, x/(1+|x|) soft-clip
   ↓
AudioContext.destination
```

Init flow:

1. Page loads, OB-XD rack builds the knob grid eagerly (defaults baked in),
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
   (reassignable per instance).

Default state: all 10 instances on; instance 1 = 8 voices, others = 1
voice; channels 1–10 → instances 1–10; each instance seeded with its own
factory patch.

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
`__EMSCRIPTEN__` defines. OB-XD uses `-std=c++17`.

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

For a long-running deployment behind a process manager such as
`supervisord`, drop a config like this into your supervisor's
`conf.d/` directory (adjust `directory=`, `command=`, and log paths to
match your checkout):

```ini
[program:octobx]
command=/usr/bin/npx vite --host 0.0.0.0 --port 8080
directory=<path-to-repo-checkout>
autostart=true
autorestart=true
startretries=3
stdout_logfile=<path-to-repo-checkout>/logs/vite.out.log
stderr_logfile=<path-to-repo-checkout>/logs/vite.err.log
stdout_logfile_maxbytes=5MB
stdout_logfile_backups=3
stderr_logfile_maxbytes=5MB
stderr_logfile_backups=3
```

Then `sudo supervisorctl update && sudo supervisorctl restart octobx`.
Logs land in `logs/vite.{out,err}.log` (gitignored).

## Firmware modifications

No firmware source changes beyond the existing patches in the
`OCT_CE_OS` fork (see its `patches/` history). The WASM build uses
`-D__linux__` so all Linux-specific firmware guards apply:

1. `includes-declarations.h` — includes `hal_linux.h` (our WASM version)
2. `play_MIDI.h:85` — `MIDI_send()` routes to `midi_send_event()`
3. `show_hwdriver.h:36` — hardware `VIEWER_show_MIR()` suppressed
4. `Intr_TMR.h` — MIDI clock moved to sequencer thread, `g_tick_ns`
   precompute
5. `cpu-load.c` — CPU load check disabled

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
- OB-XD: clicking PLAY brings up the AudioWorklet, Octopus channels 1–10
  drive the 10 instances, switching the instance selector re-syncs knob
  positions, loading a `.fxp` changes one instance's sound only.

## Reference docs in repo

- `AGENTS.md` — engineering guide for AI assistants (firmware submodule,
  single-TU build, eCos shim mappings, runtime architecture, exported
  functions, MIDI routing, MIR format, known issues).
- `obx.md` — design doc and phase plan for the multi-instance OB-XD
  integration (also covers hard-won AWP/JUCE/HEAPF32 quirks).
- `firmware/OCT_OS/COPYING.txt`, `firmware/OCT_OS/FACTORY_RESTORE.txt` —
  firmware license and factory-restore notes from the OCT_CE_OS submodule.

## Known issues

1. **IDBFS not mounting** — `FS.mount()` fails because the module's FS
   object isn't fully initialized at mount time; Octopus state doesn't
   persist across reloads yet.
2. **OB-XD factory patches are programmatic** — no real `.fxp` files ship
   in `wasm/obxd/patches/`. The 10 hand-tuned parameter tables in
   `main_obxd.cpp` are the defaults. Drop GPL-compatible `.fxp` files in
   `wasm/obxd/patches/` (named `01_pad.fxp` … `10_kick.fxp`) and rebuild
   with `./build.sh synth` to embed real patches.
3. **AudioWorklet reply correlation** is correct but untyped —
   `obxd-audio.ts` uses an `unknown`-typed predicate router to avoid
   racing `port.onmessage` reassignments. See "MessagePort quirks" in
   `obx.md`.
4. **No automated tests** — verification is manual (see Testing above).

## License

OctOBX is licensed under the **GNU General Public License v3.0 or later**
([`LICENSE`](./LICENSE)). The GPL-3.0-or-later choice is deliberate: the OB-XD
`SynthEngine` (compiled into `obxd_wasm.wasm`) is GPL-3.0, and GPL-3.0-or-later
keeps the combined work license-compatible.

### Third-party components (each under its own license, in its submodule)

| Component | Location | License |
|---|---|---|
| Octopus/Nemo firmware | `firmware/` (submodule → `maxolgi/OCT_CE_OS`) | see `firmware/OCT_OS/COPYING.txt` |
| OB-XD `SynthEngine` | `third_party/Obxd/` (submodule → `2DaT/Obxd`) | GPL-3.0 |
| JUCE core + audio_basics | `third_party/JUCE/` (submodule → `juce-framework/JUCE`) | ISC (core modules) — see `third_party/JUCE/LICENSE.md` |

The combined browser build (Octopus WASM + OB-XD WASM + TypeScript UI) is
distributed under GPL-3.0-or-later as a single derived work.

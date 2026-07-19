# AGENTS.md

OctOBX — the Genoqs Octopus/Nemo MIDI sequencer firmware (~50k lines of C89)
compiled to **WebAssembly via Emscripten**, with a TypeScript/Vite web UI and
an in-browser multi-instance **OB-XD synthesizer** running in an AudioWorklet.

This is the **WASM/browser port**. It is a sibling project to the native
Linux/Windows C-engine port at <https://github.com/maxolgi/Octopus>. The two
share the same firmware source and the same eCos-HAL shim concept, but this repo
targets the browser (Emscripten + Web Workers + SharedArrayBuffer), not ALSA/winmm.

## Submodules

This repo uses **three** git submodules:

- `firmware/` → <https://github.com/maxolgi/OCT_CE_OS> — Octopus + Nemo firmware
  (a fork of `genoqs-community/source`). Contains `OCT_OS/` (Octopus firmware)
  and `NEMO_OS/` (Nemo firmware) at its root — exactly the layout the Octopus
  WASM `Makefile` expects (`firmware/OCT_OS/...`, `firmware/NEMO_OS/...`).
- `third_party/Obxd/` → <https://github.com/2DaT/Obxd> — the `SynthEngine`
  source used by the in-browser multi-instance OB-XD synth (`wasm/obxd/`).
- `third_party/JUCE/` → <https://github.com/juce-framework/JUCE> — `juce_core`
  + `juce_audio_basics`, amalgamated into a single TU in
  `wasm/obxd/juce_amalgam.cpp`.

**First-time clone:**
```bash
git clone --recurse-submodules <repo-url>
# Or after a regular clone:
git submodule update --init --recursive
```

The firmware submodule is required for the Octopus WASM build. The OB-XD and
JUCE submodules are required for the synth WASM build (`make -C wasm/obxd`).

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

### Compile the OB-XD synth WASM (requires `third_party/{Obxd,JUCE}`)
```bash
make -C wasm/obxd       # → wasm/build/obxd_wasm.{js,wasm}
make -C wasm/obxd clean
```

`emcc`/`em++` must be in PATH (run `source ~/emsdk/emsdk_env.sh` first). The
Octopus `Makefile` uses `FWROOT = ..` (one level up from `wasm/`) to find the
firmware at the repo root (`../firmware/OCT_OS/...`).

### Install TypeScript deps + run dev server
```bash
npm install
npx vite --host 0.0.0.0 --port 8080   # HTTPS dev server with COOP/COEP headers
# or the plain-HTTP COOP/COEP server (localhost is a secure context):
python3 serve.py                       # http://localhost:8080
```

### Build everything (Octopus WASM + OB-XD WASM + app)
```bash
./build.sh          # all three
./build.sh wasm     # Octopus engine WASM only
./build.sh synth    # OB-XD synth WASM only (+ patches.h generation)
./build.sh app      # TypeScript app only
```

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

The OB-XD synth is a **separate emcc build** under `wasm/obxd/` (its own TU;
does not share the Octopus single-TU build):

- `main_obxd.cpp` — 10 `SynthEngine` instances, summed + soft-clipped
  (`x/(1+|x|)`), instance-aware exports (`obxd_*`).
- `juce_amalgam.cpp` — single-TU `juce_core` + `juce_audio_basics`. MUST be its
  own TU (JUCE refuses to compile when its `.h` was already included in the
  same TU). `#undef __linux__` before including JUCE so `TargetPlatform.h`'s
  `#elif defined(__wasm__)` branch fires.
- `Makefile` — `-sENVIRONMENT=worker` (AWP), no `-pthread` (pthreads are illegal
  inside AudioWorkletGlobalScope), `-sFORCE_FILESYSTEM=0` (bytes go via
  `_malloc` + `HEAPU8.set`).

See README "OB-XD synth — WASM source" for the full file/function reference.

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
│   ├── MIR rendering (60Hz RAF → reads WASM heap via HEAPU8)
│   ├── OB-XD rack UI (instance selector, knobs, meters, .fxp loader)
│   ├── Single 60Hz MIDI drain loop (RAF) → fans each batch out to:
│   │   • HardwareMidiOutput  → Web MIDI output port
│   │   • OB-XD bridge        → AudioWorklet (per-instance)
│   └── Transport controls + state persistence
├── WASM Module — Octopus engine  (octopus_wasm.wasm)
│   ├── Firmware core (~50k lines, unchanged)
│   ├── hal_wasm.c / midi_wasm.c / main_wasm.c
└── Web Worker (pthread)
    └── Sequencer thread (48 PPQN, nanosleep timing)

AudioWorklet — OB-XD synth  (obxd_wasm.wasm, separate emcc build)
└── main_obxd.cpp — 10 SynthEngine instances summed + soft-clipped
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
- **OB-XD in a separate WASM module inside an AudioWorklet** — the synth has
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
`obxd_set_factory_patch`, `obxd_get_instance_rms`, `obxd_set_freq` (no-op). All
instance-aware except `obxd_panic_all`. See README "OB-XD synth — WASM source"
for the full table.

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
| `main.ts` | Entry point: SharedArrayBuffer check → load WASM → `engine_init()` → build UI → transport/persistence → hardware MIDI → OB-XD rack. The single 60Hz MIDI drain loop is started before the panel so events flow before any DOM update consumes the frame. |
| `octopus-types.ts` | TS interface matching the C `EMSCRIPTEN_KEEPALIVE` exports |
| `octopus-module.ts` | Loads the WASM module (dynamic `<script>`, `locateFile`, IDBFS mount attempt) |
| `classic-panel.ts` | Faithful port of the Octopus control surface (same DOM/IDs as `web_gui.html`); direct WASM calls instead of WebSocket |
| `octopus-panel.ts` | Simplified modern grid view (alternative panel) |
| `midi-access.ts` | Shared `openMidiAccess()` + `pollForPorts()` — works around the Chrome-on-Linux late port-enumeration quirk (see MIDI section). |
| `midi-output.ts` | Web MIDI API **output** (Chrome/Edge); `frameMidi()` emits correct 1/2/3-byte messages; owns the single 60Hz RAF drain loop (`drainMidiToHardware`) that fans batches out to parallel consumers via `BatchDrainHandler`; `rescan()`. |
| `midi-input.ts` | Web MIDI API **input** (Chrome/Edge); forwards hardware messages to `wasm_midi_input()`; `rescan()`. |
| `obxd-audio.ts` | Main-thread bootstrap + per-instance API for the OB-XD AudioWorklet (10 SynthEngine instances). Pre-fetches WASM bytes, passes via `processorOptions.wasmBinary`; one-shot reply router for async worklet RPCs. |
| `obxd-bridge.ts` | Drain-loop consumer → OB-XD AudioWorklet. Channel→instance routing (default 1–10 → 0–9, reassignable). Re-exports `BatchDrainHandler`. |
| `obxd-rack.ts` | OB-XD panel UI: instance selector, power/polyphony/channel, meter (30Hz ping/pong), `.fxp` loader, Reset/Panic/Panic-All. Lazy AudioContext init on first PLAY. |
| `obxd-synth-ui.ts` | Grouped knob/toggle grid (~30 controls); indices match `ParamsEnum.h`. |
| `obxd-knob.ts` | Vanilla SVG knob + toggle widgets (no deps). |
| `obxd-processor.tail.js` | Plain JS appended to emcc output to form `obxd-processor.js` for `audioWorklet.addModule()`. Subclasses `AudioWorkletProcessor`. |
| `obxd-awp-shim.js` | Plain JS prepended to emcc output; polyfills `self`/`location`/`fetch`/`performance` for AudioWorkletGlobalScope. |
| `transport-sync.ts` | Wires PLAY/STOP/BPM to the Octopus engine + transport indicator. |
| `state-persistence.ts` | Save/Load buttons → IDBFS sync |

Input conventions: `skey(key, press)` → `module._wasm_key_press(key, press)`;
rotary knobs → `module._wasm_rotary(idx, dir)`; drag-paint step pads
(mouse + touch); Ctrl-click hold mode.

## MIDI (hardware I/O)

Real MIDI is a first-class feature, wired through the Web MIDI API (Chrome/Edge
only). Two independent directions, plus the OB-XD bridge fan-out:

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
  running-status, so every message arrives with an explicit status byte.
- **OB-XD bridge** (`obxd-bridge.ts`) — same drain loop, fans out to the
  AudioWorklet synth by channel → instance routing (default 1–10 → 0–9).
  No-ops while the synth is unpowered / not yet booted.

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

No automated test suite. Testing is manual: build the WASM modules, run the
dev server, and verify in the browser console:
- Transport play/stop produces ticks (`wasm_get_tick_count()` increments).
- Step toggles light MIR LEDs at 60 Hz.
- MIDI events appear in the ring buffer
  (`wasm_get_midi_dropped_count()` stays at 0 under normal load).
- Hardware MIDI output via Web MIDI (Chrome/Edge) reaches a synth.
- Hardware MIDI input drives the sequencer (controller → `wasm_midi_input`
  → `G_midi_interpret_*`).
- OB-XD: clicking PLAY brings up the AudioWorklet, Octopus channels 1–10
  drive the 10 instances, switching the instance selector re-syncs knob
  positions, loading a `.fxp` changes one instance's sound only.

## Known issues

1. **IDBFS not mounting** — `FS.mount()` fails because the module's FS object
   isn't fully initialized at mount time; Octopus state doesn't persist across
   reloads yet.
2. **OB-XD factory patches are programmatic** — no real `.fxp` files ship in
   `wasm/obxd/patches/`. The 10 hand-tuned parameter tables in `main_obxd.cpp`
   are the defaults. Drop GPL-compatible `.fxp` files in `wasm/obxd/patches/`
   (named `01_pad.fxp` … `10_kick.fxp`) and rebuild with `./build.sh synth` to
   embed real patches.
3. **AudioWorklet reply correlation** is correct but untyped — `obxd-audio.ts`
   uses an `unknown`-typed predicate router to avoid racing `port.onmessage`
   reassignments.
4. **No automated tests** — verification is manual (see Testing above).

## License

OctOBX is GPL-3.0-or-later (see [`LICENSE`](./LICENSE)). The OB-XD `SynthEngine`
is GPL-3.0, so GPL-3.0-or-later keeps the combined work license-compatible.
The firmware, OB-XD, and JUCE submodules each carry their own license — see
the License section in README for the table.

## Reference docs in repo

- `README.md` — full project documentation (architecture, source-file specs,
  OB-XD integration, HTTPS/COOP-COEP, MIR format, known issues).
- `firmware/OCT_OS/COPYING.txt`, `firmware/OCT_OS/FACTORY_RESTORE.txt` —
  firmware license and factory-restore notes from the OCT_CE_OS submodule.

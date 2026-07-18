# AGENTS.md

OctoDAW — the Genoqs Octopus/Nemo MIDI sequencer firmware (~50k lines of C89)
compiled to **WebAssembly via Emscripten**, with a TypeScript/Vite web UI and
optional [openDAW](https://github.com/opendaw/studio) integration.

This is the **WASM/browser port**. It is a sibling project to the native
Linux/Windows C-engine port at <https://github.com/maxolgi/Octopus>. The two
share the same firmware source and the same eCos-HAL shim concept, but this repo
targets the browser (Emscripten + Web Workers + SharedArrayBuffer), not ALSA/winmm.

## Firmware submodule

The firmware source lives in a git submodule at `firmware/` pointing to
<https://github.com/maxolgi/OCT_CE_OS> (a fork of `genoqs-community/source`).
It contains `OCT_OS/` (Octopus firmware) and `NEMO_OS/` (Nemo firmware) at its
root — exactly the layout the WASM `Makefile` expects (`firmware/OCT_OS/...`,
`firmware/NEMO_OS/...`).

**First-time clone:**
```bash
git clone --recurse-submodules <repo-url>
# Or after a regular clone:
git submodule update --init
```

## Build

### Prerequisites
```bash
# Emscripten SDK
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
cd ~/emsdk && ./emsdk install latest && ./emsdk activate latest
source ~/emsdk/emsdk_env.sh

# Node.js >= 18
node --version
```

### Compile the WASM engine (Emscripten)
```bash
git submodule update --init   # first time only — firmware/ must exist
cd wasm
make            # → build/octopus_wasm.js + build/octopus_wasm.wasm
make NEMO=1     # Nemo variant → build/nemo_wasm.{js,wasm}
make clean
```
`emcc` must be in PATH (run `source ~/emsdk/emsdk_env.sh` first). The Makefile
uses `FWROOT = ..` (one level up from `wasm/`) to find the firmware at the repo
root (`../firmware/OCT_OS/...`).

### Install TypeScript deps + run dev server
```bash
npm install
npx vite --host 0.0.0.0 --port 8080   # HTTPS dev server with COOP/COEP headers
# or the plain-python COOP/COEP server:
python3 serve.py                       # http://localhost:8080
```

### Build everything (WASM + app)
```bash
./build.sh         # wasm + npm install + vite build
./build.sh wasm    # WASM only
./build.sh app     # TS app only
```

Open `https://localhost:8080/`. Accept the self-signed cert warning (needed
because SharedArrayBuffer requires a secure context).

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
Browser (COOP/COEP cross-origin isolated)
├── Main Thread
│   ├── Octopus UI (classic panel or modern grid)
│   ├── MIR rendering (60Hz RAF → reads WASM heap via HEAPU8)
│   ├── MIDI: hw output drain (→ Web MIDI) + hw input (→ wasm_midi_input) + bridge (→ openDAW NoteSignal)
│   └── Transport controls
├── WASM Module (octopus_wasm.wasm)
│   ├── Firmware core (~50k lines, unchanged)
│   ├── hal_wasm.c / midi_wasm.c / main_wasm.c
└── Web Worker (pthread)
    └── Sequencer thread (48 PPQN, nanosleep timing)
```

- **pthreads** — the sequencer runs in a Web Worker via Emscripten pthreads.
  Requires SharedArrayBuffer, which requires COOP/COEP headers on a secure
  context (HTTPS or localhost). Both `vite.config.ts` and `serve.py` send these
  headers; the self-signed certs live in `certs/` (gitignored, regenerate per
  machine — see README).
- **Ring-buffer MIDI** — `midi_send_event()` pushes 32-bit packed events
  (`status | data1<<8 | data2<<16 | ch<<24`) into a 512-entry ring buffer. JS
  drains at 60 Hz via `wasm_has_midi_event()` / `wasm_get_midi_event()`.
- **Direct MIR access** — JS reads the 170-byte MIR array
  (`unsigned char MIR[2][17][5]`) directly from WASM linear memory via `HEAPU8`.
  No serialization. `VIEWER_show_MIR()` is a no-op in the WASM build.

## Exported C functions (`EMSCRIPTEN_KEEPALIVE`)

Input/state in `main_wasm.c`: `engine_init`, `wasm_key_press`, `wasm_rotary`,
`wasm_transport`, `wasm_set_tempo`, `wasm_pause`, `wasm_shutdown`,
`wasm_save_state`, `wasm_load_state`.

MIR/state out in `main_wasm.c`: `get_mir_ptr`, `get_processed_mir_ptr`,
`get_run_bit`, `get_tempo`, `get_zoom_level`, `page_refresh`, `wasm_get_tick_ns`,
`wasm_get_sequencer_running`, `wasm_get_tick_count`.

MIDI in `midi_wasm.c`: `wasm_has_midi_event`, `wasm_get_midi_event`,
`wasm_midi_input`.

The `EMSCRIPTEN_KEEPALIVE` functions are mirrored by the TypeScript interface in
`src/octopus-types.ts` and must be listed in `-sEXPORTED_FUNCTIONS` in the
`Makefile`. **When you add or rename an export, update all three places** (the C
definition, `octopus-types.ts`, and the Makefile `EXPORTED_FUNCTIONS` list), then
rebuild the WASM module.

Note: the firmware MIDI input interpreters (`G_midi_interpret_NOTE_ON`,
`G_midi_interpret_BENDER`, `G_midi_interpret_CONTROL`) are byte-at-a-time state
machines, not message-level handlers. `wasm_midi_input()` feeds bytes
sequentially after setting the running status byte.

## TypeScript source (`src/`)

| File | Role |
|---|---|
| `main.ts` | Entry point: SharedArrayBuffer check → load WASM → `engine_init()` → build UI → transport/persistence → **hardware MIDI (first)** → openDAW (timeout-guarded, **last**). **Do not reorder**: openDAW's `setupEngine` hangs (suspended `AudioContext` → `AudioWorklets.createFor` never resolves) and would block MIDI init if it ran first. |
| `octopus-types.ts` | TS interface matching the C `EMSCRIPTEN_KEEPALIVE` exports |
| `octopus-module.ts` | Loads the WASM module (dynamic `<script>`, `locateFile`, IDBFS mount attempt) |
| `classic-panel.ts` | Faithful port of the Octopus control surface (same DOM/IDs as `web_gui.html`); direct WASM calls instead of WebSocket |
| `octopus-panel.ts` | Simplified modern grid view (alternative panel) |
| `midi-access.ts` | Shared `openMidiAccess()` + `pollForPorts()` — works around the Chrome-on-Linux late port-enumeration quirk (see MIDI section). |
| `midi-output.ts` | Web MIDI API **output** (Chrome/Edge); `frameMidi()` emits correct 1/2/3-byte messages; drains the ring buffer at 60Hz; `rescan()`. |
| `midi-input.ts` | Web MIDI API **input** (Chrome/Edge); forwards hardware messages to `wasm_midi_input()`; `rescan()`. |
| `midi-bridge.ts` | 60Hz RAF loop draining the WASM MIDI ring buffer → openDAW `NoteSignal` (only started if openDAW init succeeds). |
| `transport-sync.ts` | Wires PLAY/STOP/BPM to both the Octopus engine and openDAW |
| `engine-setup.ts` | openDAW project setup (10 tracks + instruments); currently runtime-fails/hangs → standalone fallback. |
| `state-persistence.ts` | Save/Load buttons → IDBFS sync |

Input conventions: `skey(key, press)` → `module._wasm_key_press(key, press)`;
rotary knobs → `module._wasm_rotary(idx, dir)`; drag-paint step pads
(mouse + touch); Ctrl-click hold mode.

## MIDI (hardware I/O)

Real MIDI is a first-class feature, wired through the Web MIDI API (Chrome/Edge
only). Two independent directions, plus the openDAW bridge:

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
- **openDAW bridge** (`midi-bridge.ts`) — same ring buffer, forwarded to openDAW
  `NoteSignal`. Only started when openDAW init succeeds.

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

No automated test suite. Testing is manual: build the WASM module, run the dev
server, and verify in the browser console:
- Transport play/stop produces ticks (`wasm_get_tick_count()` increments).
- Step toggles light MIR LEDs at 60 Hz.
- MIDI events appear in the ring buffer (`wasm_has_midi_event()`).
- Hardware MIDI output via Web MIDI (Chrome/Edge) or `aseqdump`-equivalent monitor.

## Known issues

1. **openDAW integration not functional** — `ProjectEnv` requires fully
   initialized sample/soundfont services; `setupEngine` hangs (suspended
   `AudioContext` → `AudioWorklets.createFor` never resolves). It is run
   **last** in `main.ts` behind a 4s `raceTimeout` guard so it can never block
   the app or MIDI; failure → standalone mode (graceful).
2. **IDBFS not mounting** — `FS.mount()` fails because the module's FS object isn't
   fully initialized at mount time; state doesn't persist across reloads yet.
3. **MIDI input path unverified end-to-end** — correct byte-at-a-time signatures
   and the Web MIDI → `wasm_midi_input()` wiring are in place, but the input
   direction (controller → sequencer) needs real-hardware validation.
4. **No audio output without a sink** — the sequencer generates MIDI events but
   nothing plays them unless Web MIDI hardware (or openDAW, if it worked) is
   connected.

## Reference docs in repo

- `README.md` — full WASM-port documentation (architecture, source-file specs,
  HTTPS/COOP-COEP, MIR format, known issues)
- `firmware/OCT_OS/COPYING.txt`, `firmware/OCT_OS/FACTORY_RESTORE.txt` —
  firmware license and factory-restore notes from the OCT_CE_OS submodule.

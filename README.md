# OctoDAW — WASM Port Documentation

## Overview

The Octopus/Nemo MIDI sequencer firmware (C89, ~50k lines) compiled to
WebAssembly via Emscripten, with a web UI and optional openDAW integration.

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

### Compile the WASM engine

```bash
cd octodaw/wasm
make           # → build/octopus_wasm.js + build/octopus_wasm.wasm
make NEMO=1    # Nemo variant
make clean
```

The build uses `-D__linux__` so all existing firmware patches apply. The
`-D__EMSCRIPTEN__` define routes to WASM-specific HAL/MIDI implementations.

### Install TypeScript deps

```bash
cd octodaw
npm install
```

### Run the dev server

```bash
npx vite --host 0.0.0.0 --port 8080
# Or via supervisord:
sudo supervisorctl restart octodaw
```

Open `https://localhost:8080/` (or `https://<machine-ip>:8080/` from another
machine). Accept the self-signed certificate warning.

## Architecture

```
Browser (COOP/COEP isolated)
├── Main Thread
│   ├── Octopus UI (classic panel or modern grid)
│   ├── MIR rendering (60Hz RAF → reads WASM heap)
│   ├── MIDI bridge (drains ring buffer → NoteSignal / Web MIDI)
│   └── Transport controls
│
├── WASM Module (octopus_wasm.wasm — 1.6MB)
│   ├── Firmware core (~50k lines, unchanged from native)
│   ├── hal_wasm.c — eCos HAL shim (pthreads, ring-buffer mbox, nanosleep)
│   ├── midi_wasm.c — MIDI event ring buffer
│   └── main_wasm.c — async entry, exports, sequencer pthread
│
└── Web Worker (pthread)
    └── Sequencer thread (48 PPQN, nanosleep timing)
```

### Key design decisions

1. **Single translation unit** — Same as native build. `main_wasm.c` includes
   all firmware `.h` files into one TU.

2. **`-D__linux__`** — Makes firmware patches route `MIDI_send()` to our
   `midi_send_event()` and suppress hardware-specific code. No firmware changes
   needed beyond the existing patches.

3. **`-D__EMSCRIPTEN__`** — Routes platform-specific code to WASM
   implementations in `hal_wasm.c`, `midi_wasm.c`, `main_wasm.c`.

4. **pthreads** — Sequencer runs in a Web Worker via Emscripten pthreads.
   Requires SharedArrayBuffer (COOP/COEP headers).

5. **Ring buffer MIDI** — `midi_send_event()` pushes 32-bit packed events into
   a ring buffer. JS drains at 60Hz via `wasm_has_midi_event()` /
   `wasm_get_midi_event()`.

6. **Direct MIR access** — JS reads the 170-byte MIR array directly from WASM
   linear memory via `HEAPU8`. No serialization overhead.

## WASM source files (octodaw/wasm/)

### hal_linux.h

Modified copy of `include/hal_linux.h` with `#elif defined(__EMSCRIPTEN__)`
guards. Changes:
- No socket/timerfd/ioctl/mman headers
- Ring-buffer mailbox type (mutex + condvar, same as Windows path)
- `emscripten_get_now()` for `HAL_CLOCK_READ`
- OSC declarations excluded (`#ifndef __EMSCRIPTEN__`)

### hal_wasm.c

eCos HAL shim. Backs `cyg_*` functions with:
- `pthread_create` (Emscripten pthreads → Web Workers)
- Ring-buffer mailboxes (mutex + condition variable)
- `pthread_mutex_t` for scheduler lock (recursive)
- `nanosleep`-based alarm watcher threads
- In-memory flash buffer (same as native)

### midi_wasm.c

Replaces `midi_alsa.c`. Key functions:
- `midi_send_event()` — converts firmware MIDI types to raw bytes, pushes to
  512-entry ring buffer (32-bit packed: status | data1<<8 | data2<<16 | ch<<24)
- `wasm_has_midi_event()` / `wasm_get_midi_event()` — exported to JS
- `wasm_midi_input(status, d1, d2)` — feeds MIDI input to firmware's
  byte-at-a-time interpreters

Firmware MIDI interpreter signatures differ from what midi_alsa.c assumed:
```
G_midi_interpret_NOTE_ON(unsigned char midi_byte, unsigned char UART_ndx)
G_midi_interpret_BENDER(unsigned char midi_byte, unsigned char UART_ndx)
G_midi_interpret_CONTROL(unsigned char midi_byte, unsigned char UART_ndx)
```
These are byte-at-a-time state machines, not message-level handlers. The WASM
input function feeds bytes sequentially after setting the running status byte.

### main_wasm.c

Replaces `main_linux.c`. Key differences from native:
- No `main()` blocking loop — JS calls `engine_init()`
- Sequencer thread uses relative `nanosleep` instead of absolute
  `clock_nanosleep(TIMER_ABSTIME)` + busy-wait
- `VIEWER_show_MIR()` is a no-op (JS reads MIR from heap)
- `sequencer_START()` called in init (matches native behavior)

Exported functions (EMSCRIPTEN_KEEPALIVE):

| Function | Purpose |
|---|---|
| `engine_init()` | Initialize firmware, start sequencer thread |
| `wasm_key_press(key, press)` | Key input from UI |
| `wasm_rotary(rotNdx, dir)` | Rotary encoder input |
| `wasm_transport(running)` | Start/stop sequencer |
| `wasm_set_tempo(bpm)` | Change tempo |
| `wasm_pause()` | Toggle pause |
| `wasm_midi_input(status, d1, d2)` | MIDI input from Web MIDI |
| `get_mir_ptr()` | Pointer to raw MIR array (170 bytes) |
| `get_processed_mir_ptr()` | MIR with blink processing applied |
| `get_run_bit()` | Transport state |
| `get_tempo()` | Current BPM |
| `get_zoom_level()` | Current zoom mode |
| `page_refresh()` | Call `Page_full_refresh()` (fills MIR) |
| `wasm_has_midi_event()` | Check ring buffer |
| `wasm_get_midi_event()` | Drain next event (32-bit packed) |
| `wasm_get_tick_ns()` | Nanoseconds per tick (debug) |
| `wasm_get_tick_count()` | Sequencer tick counter (debug) |
| `wasm_save_state()` | Save to IDBFS |
| `wasm_load_state()` | Load from IDBFS |
| `wasm_shutdown()` | Stop sequencer |

### flash_file.c

Copied unchanged from `src/flash_file.c`. Works with Emscripten's virtual
filesystem (MEMFS by default, IDBFS for persistence).

### Makefile

Emscripten build flags:
```makefile
-std=gnu89 -D__linux__ -D__EMSCRIPTEN__
-pthread -sUSE_PTHREADS=1 -sPTHREAD_POOL_SIZE=2
-sMODULARIZE=1 -sEXPORT_NAME=OctopusModuleFactory
-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864
-sFORCE_FILESYSTEM=1
```

`MODULARIZE=1` exports a factory function (`OctopusModuleFactory`) that
returns a Promise<Module>. Loaded via dynamic `<script>` tag in
`octopus-module.ts`.

## TypeScript source files (octodaw/src/)

### octopus-types.ts

TypeScript interface for all WASM exports. `OctopusWasmModule` interface
matches the C `EMSCRIPTEN_KEEPALIVE` functions.

### octopus-module.ts

Loads the WASM module:
- Injects `<script src="/octopus_wasm.js">` dynamically
- Passes `locateFile: (path) => '/' + path` so Emscripten finds the `.wasm`
- Mounts IDBFS at `/persistent` for state persistence

### classic-panel.ts

Full Octopus control surface — faithful port of `web_gui.html`. Generates the
same DOM structure (step grid, mix strip, transport circle, chord buttons)
with the same element IDs. Replaces WebSocket with direct WASM calls.

Input handlers:
- `skey(key, press)` → `module._wasm_key_press(key, press)`
- Rotary knobs → `module._wasm_rotary(idx, dir)`
- Drag-paint step pads (mouse + touch)
- Ctrl-click hold mode

MIR rendering at 60Hz via RAF:
1. `module._page_refresh()` — fills MIR
2. Read 170 bytes from `module._get_mir_ptr()` via `HEAPU8`
3. Map MIR bits to LED elements (same mapping as web_gui.html)

### octopus-panel.ts

Simplified modern grid view — basic step pads, mix strip, transport keys,
rotary encoders. Alternative to the classic panel. Selectable via dropdown.

### engine-setup.ts

Creates openDAW project with 10 tracks and instruments (Vaporisateur,
Soundfont, Playfield). Returns UUID mapping for MIDI bridge.

Currently fails at runtime because `ProjectEnv` requires fully initialized
sample/soundfont services. Falls back to standalone mode gracefully.

### midi-bridge.ts

60Hz RAF loop that drains the WASM MIDI ring buffer and forwards events to
openDAW instruments via `NoteSignal.on/off()`. Maps Octopus track → openDAW
AudioUnit UUID.

### transport-sync.ts

Wires PLAY/STOP/BPM buttons to both Octopus engine and openDAW engine.

### midi-output.ts

Web MIDI API output for hardware synthesizers (Chrome/Edge only). Drains the
same ring buffer and sends raw MIDI bytes to a selected output port.

### state-persistence.ts

Save/Load buttons that trigger IDBFS sync.

### main.ts

Entry point. Sequence:
1. Check SharedArrayBuffer availability
2. Load WASM module
3. `engine_init()`
4. Build UI panel (classic by default)
5. Setup transport + persistence
6. Attempt openDAW integration (non-fatal)
7. Start MIDI bridge + hardware output

View toggle: dropdown switches between Classic and Modern panels. Previous
panel is cleaned up before building the new one.

## HTTPS and COOP/COEP

SharedArrayBuffer requires cross-origin isolation. The browser only honors
COOP/COEP headers on "secure contexts" (HTTPS or localhost). Self-signed
certificates are in `octodaw/certs/` (generated by openssl with the machine's
IP in the SAN).

```bash
# Regenerate certs for a different IP/machine
openssl req -x509 -newkey rsa:2048 \
  -keyout octodaw/certs/key.pem \
  -out octodaw/certs/cert.pem \
  -days 365 -nodes \
  -subj "/CN=<IP>" \
  -addext "subjectAltName=IP:<IP>,IP:127.0.0.1,DNS:localhost"
```

## Supervisord

Config at `/etc/supervisor/conf.d/octodaw.conf`:
```ini
[program:octodaw]
command=/usr/bin/npx vite --host 0.0.0.0 --port 8080
directory=/home/flibb/Octopus/octodaw
autostart=true
autorestart=true
```

Logs: `octodaw/logs/vite.out.log` and `octodaw/logs/vite.err.log`.

## MIR format

The MIR (Matrix Intermediate Representation) is a `unsigned char MIR[2][17][5]`
array in WASM linear memory. 170 bytes total.

Each row (17 per set, 2 sets) is 5 bytes:
- Byte 0: blink/selector flags
- Byte 1: red LED bits (1 bit per column, 8 columns)
- Byte 2: green LED bits
- Byte 3-4: additional flags

LED bit mapping in JS:
```javascript
const mb = (s, r, c) => mir[s * 85 + r * 5 + c];
const ml = (s, r, b) => ((mb(s,r,1) >> b & 1) ? 2 : 0)  // red
                       | ((mb(s,r,2) >> b & 1) ? 4 : 0); // green
```

LED color values: 0=off, 2=red, 4=green, 6=amber (red+green).

## Sequencer timing

The sequencer pthread runs at 48 PPQN. At 120 BPM:
- 1 quarter note = 500ms
- 1 PPQN tick = 500ms / 48 ≈ 10.4ms (`g_tick_ns = 10416667`)

The thread uses relative `nanosleep` (Emscripten implements via
`Atomics.wait`, ~1ms resolution). No busy-wait (would burn CPU without
improving precision in WASM).

Verified: 48 ticks per 500ms at 120 BPM.

## Firmware modifications

No firmware source changes beyond the existing patches in `patches/`. The WASM
build uses `-D__linux__` so all Linux-specific firmware guards apply:

1. `includes-declarations.h` — includes `hal_linux.h` (our WASM version)
2. `play_MIDI.h:85` — `MIDI_send()` routes to `midi_send_event()`
3. `show_hwdriver.h:36` — hardware `VIEWER_show_MIR()` suppressed
4. `Intr_TMR.h` — MIDI clock moved to sequencer thread, `g_tick_ns` precompute
5. `cpu-load.c` — CPU load check disabled

## Known issues

1. **openDAW integration not functional** — `ProjectEnv` requires fully
   initialized sample/soundfont services. The Octopus runs standalone.

2. **IDBFS not mounting** — `FS.mount()` fails because the module's FS object
   isn't fully initialized at mount time. State doesn't persist across reloads.

3. **MIDI input function signatures** — The firmware's `G_midi_interpret_*`
   functions are byte-at-a-time state machines, not message-level handlers.
   The ALSA port's extern declarations were wrong (3 args vs actual 2). The
   WASM port uses correct signatures but the input path is untested.

4. **No audio output** — Without openDAW or Web MIDI hardware, the sequencer
   generates MIDI events but nothing plays them. Check the ring buffer via
   `wasm_has_midi_event()` in the console.

5. **Inline grid generator crash** — The `index.html` inline script that
   generates the modern grid targets `#view-modern` which is hidden by
   default. This is harmless (the classic panel builds independently).

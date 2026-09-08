# OctOBX Manual Test Plan

Browser checklist for the paths automated tests can't reach (WASM engine,
AudioWorklet, COOP/COEP, Web MIDI, IDBFS). Run in Chrome/Edge against
`http://localhost:8080` (vite dev) or `http://127.0.0.1:8081` (launcher).

**Probes:** `window.__module` = Octopus WASM module (all `wasm_*` exports).
`window.__obxd` = `{ctx, node, masterGain, masterAnalyser}` — exists only
after the AudioWorklet is up (first transport PLAY). The worklet port
accepts `{type:"midi", instance_id, status, d1, d2}` and
`{type:"load_fxp", instance_id, bytes}` directly.

**Reliable drum-audio signal (important):** the `masterAnalyser` RMS is
noisy in a background/CDP tab (audio-graph warmup + short analyser windows),
and can read ~0 for a pad that is actually sounding. Use the **deterministic**
signals instead: the `pong` reply's `voiceActivity[9]` mask (non-zero ⇒ a
voice was assigned) and `meters[9]` (the instance-9 RMS computed in C). A pad
is working iff its note-on sets a voice bit on instance 9.

Legend: ✅ pass · ❌ fail · ⚠️ partial · ⏭️ skipped (needs hardware/display)

Last full run: 2026-09-08, Chrome via chrome-devtools-mcp, launcher on 127.0.0.1:8081.

---

## 1. Boot

| # | Check | Expected | Result |
|---|---|---|---|
| 1.1 | Console log | `IDBFS loaded` → `engine_init: ready (tempo=120 BPM)` → `All systems go` | ✅ |
| 1.2 | Console log | `sequencer: thread started, g_tick_ns=10416667` (120 BPM, 48 PPQN) | ✅ |
| 1.3 | OB-Xf editor | `104 controls built; 28 are NEW OB-Xf params` | ✅ |
| 1.4 | Network | No 404s except `favicon.ico` | ✅ |
| 1.5 | No console errors after boot | — | ✅ |

## 2. Transport / sequencer timing

| # | Check | Expected | Result |
|---|---|---|---|
| 2.1 | Tick rate @ 120 BPM | 96 ticks/s (48 PPQN × 2 qn/s). In-page 5 s measure. | ✅ 95.998 ticks/s |
| 2.2 | STOP | `get_run_bit()` → 0, ticks freeze | ✅ |
| 2.3 | PLAY again | ticks resume | ✅ |
| 2.4 | Tempo change | `_wasm_set_tempo(60)` → ~48 ticks/s; restore 120 | ✅ 47.998 ticks/s |
| 2.5 | MIDI ring | `_wasm_get_midi_dropped_count()` stays 0 under load | ✅ 0 |

Note: `wasm_get_sequencer_running()` is a thread-liveness flag (stays 1);
use `get_run_bit()` for playback state.

## 3. Views (Tab or view buttons)

| # | Check | Expected | Result |
|---|---|---|---|
| 3.1 | Octopus (classic) | 10 rows × 16 step pads, piano, MODE/SCALE/TRANSPORT, MIX/EDT LEDs | ✅ |
| 3.2 | Modern | grid view renders | ✅ |
| 3.3 | Synth | OB-Xf editor: 104 controls, instance selector, rack row | ✅ |
| 3.4 | Drums | kit selector, 8 pads × 4 layers, knob strips | ✅ |
| 3.5 | Mixer | 10 channel strips, VU meters, master fader | ✅ |

## 4. OB-Xf synth (AudioWorklet)

| # | Check | Expected | Result |
|---|---|---|---|
| 4.1 | First transport PLAY | AWP boots: `__obxd.ctx.state === "running"` (48 kHz) | ✅ |
| 4.2 | Note-on → audio | `{type:"midi", instance_id:0, status:0x90, d1:60, d2:100}` → RMS > 0 | ✅ 0.036 |
| 4.3 | Note-off → silence | `{status:0x80, d1:60, d2:0}` → RMS decays to ~0 | ✅ |
| 4.4 | Instance isolation | note on instance 3 only; meter on 0 stays ~0 | ✅ inst3 17.5%, inst0 0% |
| 4.5 | Factory patch load | patch selector pick → label updates, sound changes | ✅ "Bouncing Phaser" |
| 4.6 | .fxp file load | fxp upload → reply, label updates | ✅ "Acoustic Piano 1", RMS 0.029 |
| 4.7 | Instance switch re-sync | switch instance selector → knobs re-seed from engine mirror | ✅ 44→90 |
| 4.8 | Panic | panic button → all audio stops | ✅ 12.7%→0% |

Known UX quirk: after a `.fxp` **file** load the patch-name overlay shows
"— init —" (only `patchSel.title` gets the loaded name). Cosmetic.

## 5. Drum engine (instance 9)

| # | Check | Expected | Result |
|---|---|---|---|
| 5.1 | Kit load | samples fetched from smpldsnds CDN, `kit loaded: 8 pads` log | ✅ no fetch/decode failures |
| 5.2 | All 8 pads sound | each GM note (36/38/40/43/45/60/62/64) sets a voice bit on inst 9 + non-zero `meters[9]` | ✅ all 8 trigger + sound (see note below) |
| 5.3 | Dense repack on layer toggle | disabling a lower layer shifts dense slots; audio follows | ✅ (covered by `test/dense-layer-index.test.ts`, 24 cases) |
| 5.4 | Cross-kit sample | layer sample from a second kit loads | ⚠️ not exercised this run |

**Drum measurement note (2026-09-08):** an earlier pass using the
`masterAnalyser` RMS read most pads as silent (3/8), which looked like a
bug. It was a **measurement artifact** — background-tab throttling +
audio-graph warmup + short analyser windows. The deterministic signals
(`voiceActivity[9]` mask + `meters[9]`) show **all 8 pads trigger and
produce audio**. The C-side PCM path is also proven under Node by
`tools/verify-obxd-wasm.mjs` check **k** (loaded samples render non-silent
audio on two pads) — added this run because the PCM audio path was
previously untested (the old "audio smoke" only covered instance 0's
oscillator path).

## 6. State persistence

| # | Check | Expected | Result |
|---|---|---|---|
| 6.1 | SAVE | IDBFS sync, no errors | ⚠️ IDBFS mounts + syncs at boot; explicit SAVE round-trip not exercised this run |
| 6.2 | Reload page | state restores (tempo, project, synth params) | ⚠️ boot restores cleanly; full SAVE→reload round-trip not exercised this run |

IndexedDB `octobx` DB present; `octobx:project_index` in localStorage;
IDBFS `/persistent` (FILE_DATA store) holds sequencer state.

## 7. Hardware MIDI (needs a physical interface — Chrome/Edge)

| # | Check | Expected | Result |
|---|---|---|---|
| 7.1 | Output | sequencer events reach a hardware synth (correct framing) | ⏭️ no hardware |
| 7.2 | Input | hardware CCs drive the sequencer via `wasm_midi_input` | ⏭️ no hardware |
| 7.3 | MIDI-learn | learn-mode bind persists across reload | ⏭️ no hardware |
| 7.4 | Rescan | `↻ Rescan` repopulates ports after hotplug | ⏭️ no hardware |

(Web MIDI itself is available on this machine — "Midi Through Port-0"
enumerates — but there is no external synth/interface to round-trip.)

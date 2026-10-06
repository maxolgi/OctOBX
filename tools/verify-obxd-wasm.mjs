#!/usr/bin/env node
/**
 * tools/verify-obxd-wasm.mjs — behavioral regression net for the OB-Xf synth WASM.
 *
 * Loads the ALREADY-BUILT wasm/build/obxd_wasm.{js,wasm} directly under Node
 * (no Emscripten, no browser, no AudioWorklet) and exercises the exported
 * C surface of wasm/obxd/main_obxd.cpp. Its purpose is to prove behavior
 * preservation across refactors of the parameter-dispatch layer
 * (apply_param_instance / dispatch_legacy_param / apply_new_param_instance /
 * is_global_drum_param and friends): run it before AND after the change and
 * diff the output.
 *
 * Node compatibility notes (verified against the current emcc 6.x output):
 *
 *  1. The emcc JS is a UMD wrapper with NO ES module export:
 *         if (typeof exports === 'object' && typeof module === 'object') ...
 *     Since this package is `"type": "module"`, a plain dynamic `import()`
 *     evaluates it as ESM — the UMD branch never fires and the namespace
 *     comes back EMPTY. We therefore read the source and evaluate it inside
 *     a `new Function('module', 'exports', …)` wrapper so the UMD tail
 *     assigns `module.exports = ObxdModuleFactory`, then grab it from there.
 *
 *  2. The build is -sENVIRONMENT=worker, so at factory-call time the runtime
 *     executes `_scriptName = self.location.href`. Node defines neither
 *     `self` nor `location` on the main thread — we shim both on globalThis
 *     BEFORE invoking the factory.
 *
 *  3. This MODULARIZE build never reads `Module.wasmBinary` (the inner
 *     `var wasmBinary;` is only ever assigned by emcc's own fetch/XHR
 *     loaders, which don't exist here). Instead we use the documented
 *     `Module.instantiateWasm` hook (present in the build's createWasm()),
 *     handing it the .wasm bytes read from disk with node:fs. This
 *     sidesteps every environment-dependent loader path.
 *
 *  4. C floats are float32: expected values are compared against
 *     Math.fround(expected), since e.g. 0.7 (f64) !== 0.7f32 as JS numbers.
 *
 * Exit code: 0 iff every assertion passes; 1 otherwise (or on load failure).
 * If the build artifacts are missing, prints how to produce them and exits 1.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const jsPath = path.join(repoRoot, 'wasm', 'build', 'obxd_wasm.js');
const wasmPath = path.join(repoRoot, 'wasm', 'build', 'obxd_wasm.wasm');

// ---------------------------------------------------------------------------
// Artifact check — never build from here, just tell the user how.
// ---------------------------------------------------------------------------
if (!existsSync(jsPath) || !existsSync(wasmPath)) {
  console.error('error: OB-Xf synth WASM build artifacts not found.');
  for (const p of [jsPath, wasmPath]) {
    console.error(`  ${existsSync(p) ? 'found' : 'MISSING'}: ${p}`);
  }
  console.error('Run `./build.sh synth` (or `make -C wasm/obxd`) to build them, then re-run this script.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Loader (see header notes 1–3).
// ---------------------------------------------------------------------------

// The worker-environment runtime references `self.location.href` when the
// factory is invoked (not at script-eval time), so the shims must exist
// before ObxdModuleFactory() is called.
globalThis.self = globalThis.self ?? globalThis;
globalThis.location =
  globalThis.location ??
  Object.assign(new URL('file:///'), {
    href: pathToFileURL(path.dirname(jsPath)).href + '/',
    toString() {
      return this.href;
    },
  });

function loadFactory() {
  // UMD wrapper (header note 1): evaluate the emcc source inside a CommonJS
  // shaped scope so `module.exports = ObxdModuleFactory` actually fires.
  const src = readFileSync(jsPath, 'utf8');
  const moduleObj = { exports: {} };
  const loader = new Function(
    'module',
    'exports',
    `${src}\n;return module.exports.default || module.exports;`,
  );
  const factory = loader(moduleObj, moduleObj.exports);
  if (typeof factory !== 'function') {
    throw new Error(`ObxdModuleFactory not found after evaluating ${jsPath} (got ${typeof factory})`);
  }
  return factory;
}

async function instantiateModule() {
  const factory = loadFactory();
  const wasmBytes = new Uint8Array(readFileSync(wasmPath));

  return factory({
    // Header note 3: this build ignores Module.wasmBinary; instantiateWasm
    // is the one loader hook it DOES honor.
    instantiateWasm(imports, receiveInstance) {
      const module = new WebAssembly.Module(wasmBytes);
      const instance = new WebAssembly.Instance(module, imports);
      receiveInstance(instance);
      return instance.exports;
    },
  });
}

// ---------------------------------------------------------------------------
// Tiny assertion harness — one PASS/FAIL line per check.
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function report(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function expect(name, fn) {
  try {
    const detail = fn();
    report(name, detail === undefined, detail);
  } catch (err) {
    report(name, false, `threw: ${err && err.stack ? err.stack.split('\n')[0] : err}`);
  }
}

/** f32-exact expectation — see header note 4. */
const f32 = Math.fround;

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
async function main() {
  console.log(`verify-obxd-wasm: ${path.relative(repoRoot, wasmPath)} (${readFileSync(wasmPath).length} bytes)\n`);

  // --- load ---------------------------------------------------------------
  let mod;
  try {
    mod = await instantiateModule();
  } catch (err) {
    console.error(`error: failed to instantiate obxd_wasm under Node: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  }
  report('module factory resolves', typeof mod._obxd_init === 'function');

  // (a) Init ----------------------------------------------------------------
  expect('a. _obxd_init(44100) runs', () => {
    mod._obxd_init(44100);
  });
  expect('a. _obxd_get_factory_patch_count() >= 1', () => {
    const n = mod._obxd_get_factory_patch_count();
    if (n >= 1) return;
    return `got ${n}`;
  });

  // (b) Legacy mirror round-trip: instance 0, every legacy index 0..79 ------
  // obxd_set_param clamps to [0,1] and stores the clamped float in
  // g_param_mirror; obxd_get_param reads it back. Exact f32 equality is
  // expected, including the special inline cases 17 (LFOFREQ) and 72
  // (LFO_SYNC), which still store the plain value before their extra logic.
  expect('b. legacy mirror round-trip idx 0..79 x {0,.25,.5,.75,1}', () => {
    const values = [0, 0.25, 0.5, 0.75, 1];
    for (let idx = 0; idx < 80; idx++) {
      for (const v of values) {
        mod._obxd_set_param(0, idx, v);
        const got = mod._obxd_get_param(0, idx);
        if (got !== f32(v)) {
          return `idx ${idx}: set ${v} -> get ${got}`;
        }
      }
    }
  });

  // (c) Sentinel mirror round-trip: NEW-param indices 200..227 -------------
  expect('c. sentinel mirror round-trip idx 200..227 x {0,.25,.5,.75,1}', () => {
    const values = [0, 0.25, 0.5, 0.75, 1];
    for (let idx = 200; idx < 228; idx++) {
      for (const v of values) {
        mod._obxd_set_param(0, idx, v);
        const got = mod._obxd_get_param(0, idx);
        if (got !== f32(v)) {
          return `idx ${idx}: set ${v} -> get ${got}`;
        }
      }
    }
  });

  // (d) Factory patch ------------------------------------------------------
  expect('d. _obxd_set_factory_patch(1, 2) + patch name non-empty', () => {
    mod._obxd_set_factory_patch(1, 2);
    const namePtr = mod._obxd_get_patch_name(1);
    const name = mod.UTF8ToString(namePtr);
    if (typeof name === 'string' && name.length > 0) return;
    return `UTF8ToString(_obxd_get_patch_name(1)) = ${JSON.stringify(name)}`;
  });

  // (e) Drum layer params --------------------------------------------------
  // 44 = CUTOFF: voice-level (smoother-driven), stored per pad/layer and NOT
  // routed to instance 9.
  expect('e. drum layer voice-level param: set(3,1,44,0.7) == get(3,1,44)', () => {
    mod._obxd_set_drum_layer_param(3, 1, 44, 0.7);
    const got = mod._obxd_get_drum_layer_param(3, 1, 44);
    if (got === f32(0.7)) return;
    return `got ${got}, want ${f32(0.7)}`;
  });
  // 2 = VOLUME: global drum param — stored per layer AND routed live to
  // instance 9, so both read-backs must agree.
  expect('e. drum global param routes live to instance 9 (VOLUME, idx 2)', () => {
    mod._obxd_set_drum_layer_param(0, 0, 2, 0.55);
    const viaLayer = mod._obxd_get_drum_layer_param(0, 0, 2);
    const viaEngine = mod._obxd_get_param(9, 2);
    if (viaLayer !== f32(0.55) || viaEngine !== f32(0.55)) {
      return `layer read ${viaLayer}, engine read ${viaEngine}, want ${f32(0.55)}`;
    }
  });

  // (f) Drum classification probe -----------------------------------------
  // 2=VOLUME, 17=LFOFREQ, 62=PAN1, 47=FILTER_WARM are global/structural;
  // 44=CUTOFF and 51=LATK are smoother-driven voice-level (NOT global).
  expect('f. _obxd_is_global_drum_param classification', () => {
    for (const idx of [2, 17, 62, 47]) {
      if (mod._obxd_is_global_drum_param(idx) !== 1) return `idx ${idx}: want 1 (global)`;
    }
    for (const idx of [44, 51]) {
      if (mod._obxd_is_global_drum_param(idx) !== 0) return `idx ${idx}: want 0 (voice-level)`;
    }
  });

  // (f2) NEW-param (sentinel >= 200) drum classification + routing ---------
  // Verified against the processX() bodies in third_party/OB-Xf/src/engine/
  // SynthEngine.h: only canonical ordinals 0 (UnisonVoices), 1
  // (VoiceReassign), 7 (VibratoWave), 10 (LFO1PW) write synth-global
  // Motherboard state with no ForEachVoice — they must behave exactly like
  // legacy drum globals (route live to instance 9). Everything else is
  // ForEachVoice-scoped voice-level: per-layer store only, instance 9
  // untouched.
  expect('f2. _obxd_is_global_drum_param accepts NEW sentinels (200+n)', () => {
    for (const n of [0, 1, 7, 10]) {
      if (mod._obxd_is_global_drum_param(200 + n) !== 1) return `200+${n}: want 1 (global)`;
    }
    for (const n of [2, 17, 22, 26, 27]) {
      if (mod._obxd_is_global_drum_param(200 + n) !== 0) return `200+${n}: want 0 (voice-level)`;
    }
  });
  // LFO1PW (ordinal 10 → sentinel 210): NEW global — stored per layer AND
  // routed live to instance 9, so BOTH read-backs must agree.
  expect('f2. NEW drum global routes live to instance 9 (LFO1PW, idx 210)', () => {
    mod._obxd_set_drum_layer_param(1, 2, 210, 0.8);
    const viaLayer = mod._obxd_get_drum_layer_param(1, 2, 210);
    const viaEngine = mod._obxd_get_param(9, 210);
    if (viaLayer !== f32(0.8) || viaEngine !== f32(0.8)) {
      return `layer read ${viaLayer}, engine read ${viaEngine}, want ${f32(0.8)}`;
    }
  });
  // LFO2Rate (ordinal 17 → sentinel 217): NEW voice-level — round-trips in
  // the per-layer store only; instance 9's NEW mirror must be unchanged.
  expect('f2. NEW voice-level drum param stays per-layer (LFO2Rate, idx 217)', () => {
    const before = mod._obxd_get_param(9, 217);
    mod._obxd_set_drum_layer_param(1, 2, 217, 0.6);
    const viaLayer = mod._obxd_get_drum_layer_param(1, 2, 217);
    if (viaLayer !== f32(0.6)) return `layer read ${viaLayer}, want ${f32(0.6)}`;
    const otherLayer = mod._obxd_get_drum_layer_param(3, 0, 217);
    if (otherLayer === f32(0.6)) return `layer (3,0) also reads ${otherLayer} — per-layer isolation broken`;
    const after = mod._obxd_get_param(9, 217);
    if (after !== before) return `instance 9 mirror changed: ${before} -> ${after}`;
  });

  // (g) Audio smoke --------------------------------------------------------
  // Note-on (ch 1, note 60, vel 100), two 128-frame renders, non-silent
  // output, voices sounding, then panic -> finite output.
  expect('g. audio smoke: render produces non-silent finite audio', () => {
    mod._obxd_midi_in(0, 0x90, 60, 100);
    mod._obxd_render(128);
    mod._obxd_render(128);

    const l = new Float32Array(mod.HEAPF32.buffer, mod._get_buf_l_ptr(), 128);
    const r = new Float32Array(mod.HEAPF32.buffer, mod._get_buf_r_ptr(), 128);
    let sumSq = 0;
    for (let i = 0; i < 128; i++) sumSq += l[i] * l[i] + r[i] * r[i];
    if (!(sumSq > 0)) return `sum-of-squares = ${sumSq} (silent after note-on)`;

    const voices = mod._obxd_get_voice_activity(0);
    if (voices === 0) return '_obxd_get_voice_activity(0) == 0 after note-on';

    mod._obxd_panic(0);
    mod._obxd_render(128);
    const l2 = new Float32Array(mod.HEAPF32.buffer, mod._get_buf_l_ptr(), 128);
    const r2 = new Float32Array(mod.HEAPF32.buffer, mod._get_buf_r_ptr(), 128);
    for (let i = 0; i < 128; i++) {
      if (!Number.isFinite(l2[i]) || !Number.isFinite(r2[i])) {
        return `non-finite sample at frame ${i}: L=${l2[i]} R=${r2[i]}`;
      }
    }
  });

  // (h) MPE flag robustness ------------------------------------------------
  expect('h. MPE: pitch-bend center under MPE does not throw', () => {
    mod._obxd_set_mpe(0, 1);
    try {
      mod._obxd_midi_in(0, 0xe0, 0, 0x40); // 14-bit center: (0x40<<7)|0 = 8192
    } finally {
      mod._obxd_set_mpe(0, 0);
    }
  });

  // (i) MPE timbre (CC 74) + channel pressure (0xD0) ------------------------
  // Newly routed in obxd_midi_in: both go through the engine's MPE
  // expression handlers ONLY when MPE is enabled. Note-on first so the
  // handlers actually touch gated-voice matrix state (Slide / Press
  // sources); the render afterwards must stay finite. With MPE off both
  // messages are dropped (legacy OB-Xd had no handlers for them) — no-op,
  // also no throw.
  expect('i. MPE: CC74 timbre + channel pressure do not throw, render stays finite', () => {
    mod._obxd_set_mpe(0, 1);
    try {
      mod._obxd_midi_in(0, 0x90, 60, 100); // gated voice on channel 0
      mod._obxd_midi_in(0, 0xB0, 74, 100); // timbre = 100/127
      mod._obxd_midi_in(0, 0xD0, 80, 0);   // pressure = 80/127
      mod._obxd_render(128);
      const l = new Float32Array(mod.HEAPF32.buffer, mod._get_buf_l_ptr(), 128);
      const r = new Float32Array(mod.HEAPF32.buffer, mod._get_buf_r_ptr(), 128);
      for (let i = 0; i < 128; i++) {
        if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) {
          return `MPE on: non-finite sample at frame ${i}: L=${l[i]} R=${r[i]}`;
        }
      }
    } finally {
      mod._obxd_panic(0);
      mod._obxd_set_mpe(0, 0);
    }
    // MPE off: both messages are no-ops — dropped without a handler.
    mod._obxd_midi_in(0, 0xB0, 74, 100);
    mod._obxd_midi_in(0, 0xD0, 80, 0);
    mod._obxd_render(128);
  });

  // (j) Staged engine-owned restore (_obxd_restore_stage) ---------------
  // Proves the consolidated restore contract: commit → synth replay with
  // the instance-9 drum-structural skip → drum layer store write → drum
  // structural finalize, plus the ordering state machine.
  expect('j. out-of-order stage call rejected on fresh state machine', () => {
    const rc = mod._obxd_restore_stage(2, 0, 0, 0, 0); // machine expects stage 0
    if (rc < 0) return;
    return `stage 2 on fresh machine returned ${rc}, want < 0`;
  });
  expect('j. stage 0 rejects wrong synth_len', () => {
    const ptr = mod._malloc(4);
    const rc = mod._obxd_restore_stage(0, ptr, 10, 0, 0); // 10 != 10*108
    mod._free(ptr);
    if (rc < 0) return;
    return `stage 0 with synth_len=10 returned ${rc}, want < 0`;
  });
  expect('j. staged restore: synth replay + drum store + structural finalize', () => {
    // Synthesize pre-state the restore must overwrite.
    mod._obxd_set_param(3, 44, 0.1);                 // restored to 0.9 by stage 1
    mod._obxd_set_param(3, 29, 0.1);                 // restored to 0.5 by stage 1
    mod._obxd_set_drum_layer_param(2, 1, 44, 0.2);   // restored to 0.7 by stage 3
    // The old "pinned polyphony" hazard end-state, set directly so BOTH
    // the mirror and the engine are pinned (the legacy replay alone only
    // moves the engine, via processPolyphony).
    mod._obxd_set_polyphony(9, 1);
    // And the hazard payload as it appears in saved state:
    mod._obxd_set_param(9, 3, 0.0);

    const SYNTH_N = 10 * 108;
    const DRUM_N = 8 * 4 * 108;
    const synth = new Array(SYNTH_N).fill(0);
    const drum = new Array(DRUM_N).fill(0);
    // Instance 3: CUTOFF 44 = 0.9, XMOD 29 = 0.5.
    synth[3 * 108 + 44] = 0.9;
    synth[3 * 108 + 29] = 0.5;
    // Instance 9: hazard payload — idx 3 = 0.0 (stage 2 must SKIP it) and
    // garbage in all six drum-structural rows (skipped, then finalized by
    // stage 4).
    synth[9 * 108 + 3] = 0.0;
    synth[9 * 108 + 40] = 0.9;
    synth[9 * 108 + 41] = 0.8;
    synth[9 * 108 + 42] = 0.7;
    synth[9 * 108 + 51] = 0.6;
    synth[9 * 108 + 54] = 0.5;
    // Instance 9: sustain 1.0 + normal (Last) note priority so held notes
    // stay sounding for the engine-polyphony probe below.
    synth[9 * 108 + 53] = 1.0;
    synth[9 * 108 + 12] = 1.0;
    // Drum layer (pad 2, layer 1): CUTOFF 44 = 0.7.
    drum[(2 * 4 + 1) * 108 + 44] = 0.7;

    // Commit via stage 0 — write the arrays into WASM heap, free right after.
    const sp = mod._malloc(SYNTH_N * 4);
    const dp = mod._malloc(DRUM_N * 4);
    mod.HEAPF32.set(synth, sp >> 2);
    mod.HEAPF32.set(drum, dp >> 2);
    const rc0 = mod._obxd_restore_stage(0, sp, SYNTH_N, dp, DRUM_N);
    mod._free(sp);
    mod._free(dp);
    if (rc0 !== 0) return `stage 0 rc=${rc0}`;

    const rcs = [1, 2, 3, 4].map((st) => mod._obxd_restore_stage(st, 0, 0, 0, 0));
    if (rcs.some((rc) => rc !== 0)) return `stages 1..4 rc=[${rcs.join(',')}]`;

    // Polyphony re-pinned to 32 — meaningful because we pinned the mirror
    // to 1 above; only stage 4's obxd_set_polyphony(9, 32) writes it back.
    if (mod._obxd_get_polyphony(9) !== 32) {
      return `polyphony(9)=${mod._obxd_get_polyphony(9)}, want 32`;
    }
    // Instance-9 mirrors hold the drum-mode defaults for the skipped rows.
    for (const [idx, want] of [[40, 0], [41, 0], [42, 0], [51, 0], [54, 0.3]]) {
      const got = mod._obxd_get_param(9, idx);
      if (got !== f32(want)) return `mirror(9,${idx})=${got}, want ${f32(want)}`;
    }
    // Instance 3's params were restored by stage 1.
    if (mod._obxd_get_param(3, 44) !== f32(0.9)) {
      return `mirror(3,44)=${mod._obxd_get_param(3, 44)}, want ${f32(0.9)}`;
    }
    if (mod._obxd_get_param(3, 29) !== f32(0.5)) {
      return `mirror(3,29)=${mod._obxd_get_param(3, 29)}, want ${f32(0.5)}`;
    }
    // Drum layer (2,1) cutoff restored into the layer store by stage 3.
    if (mod._obxd_get_drum_layer_param(2, 1, 44) !== f32(0.7)) {
      return `drum layer (2,1) idx 44 = ${mod._obxd_get_drum_layer_param(2, 1, 44)}, want ${f32(0.7)}`;
    }
    // Engine polyphony is verified BEHAVIORALLY: with 32 voices, several
    // distinct held notes on instance 9 sound simultaneously; an engine
    // still pinned to 1 would show exactly one active voice.
    mod._obxd_midi_in(9, 0x90, 60, 100);
    mod._obxd_midi_in(9, 0x90, 64, 100);
    mod._obxd_midi_in(9, 0x90, 67, 100);
    mod._obxd_render(128);
    const mask = mod._obxd_get_voice_activity(9) >>> 0;
    const pop = mask.toString(2).split('1').length - 1;
    if (pop < 2) return `voice-activity popcount=${pop} (engine polyphony pinned?)`;
    mod._obxd_panic(9);
    // A subsequent render stays finite.
    mod._obxd_render(128);
    const l = new Float32Array(mod.HEAPF32.buffer, mod._get_buf_l_ptr(), 128);
    const r = new Float32Array(mod.HEAPF32.buffer, mod._get_buf_r_ptr(), 128);
    for (let i = 0; i < 128; i++) {
      if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) {
        return `non-finite sample at frame ${i}: L=${l[i]} R=${r[i]}`;
      }
    }
  });
  expect('j. state machine resets after stage 4 (new stage 0 accepted)', () => {
    const SYNTH_N = 10 * 108;
    const sp = mod._malloc(SYNTH_N * 4);
    const rc = mod._obxd_restore_stage(0, sp, SYNTH_N, 0, 0); // drum absent
    mod._free(sp);
    if (rc !== 0) return `stage 0 after completed sequence rc=${rc}, want 0`;
    // Complete the second sequence (drum-absent: stages 3/4 are no-ops that
    // still advance the machine) so it ends reset.
    const rcs = [1, 2, 3, 4].map((st) => mod._obxd_restore_stage(st, 0, 0, 0, 0));
    if (rcs.some((v) => v !== 0)) return `drum-absent stages 1..4 rc=[${rcs.join(',')}]`;
  });

  // (k) PCM drum audio path -------------------------------------------------
  // Every earlier check exercises the oscillator path or the param stores.
  // The PCM drum sampler (instance 9) has its own load/note/render path that
  // was previously untested — this proves a loaded sample actually produces
  // non-silent audio on two different pads, then cleans up.
  expect('k. PCM drum: loaded samples render non-silent audio (2 pads)', () => {
    // Self-contained: reset instance 9 to a known-audible state via a clean
    // staged restore (all-0.5 data) so this check does not depend on the
    // leftover state from the earlier staged-restore tests.
    const SYNTH_N = 10 * 108;
    const DRUM_N = 8 * 4 * 108;
    const sp = mod._malloc(SYNTH_N * 4);
    const dp = mod._malloc(DRUM_N * 4);
    mod.HEAPF32.fill(0.5, sp >> 2, (sp >> 2) + SYNTH_N);
    mod.HEAPF32.fill(0.5, dp >> 2, (dp >> 2) + DRUM_N);
    mod._obxd_restore_stage(0, sp, SYNTH_N, dp, DRUM_N);
    for (const st of [1, 2, 3, 4]) mod._obxd_restore_stage(st, 0, 0, 0, 0);
    mod._free(sp);
    mod._free(dp);

    const N = 48000;
    const sine = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      sine[i] = 0.5 * Math.sin(2 * Math.PI * 80 * i / 48000) * Math.exp(-i / (N * 0.3));
    }
    const loadPad = (pad, note) => {
      const ptr = mod._malloc(N * 4);
      mod.HEAPF32.set(sine, ptr >> 2);
      mod._obxd_load_pcm(9, pad, 0, ptr, N);
      mod._obxd_set_pcm_layer(9, pad, 0, 3.0, 1.0, 0.0, 0.0, 0.0, 0.3, 1.0, 0.2, 0.5, 1.0);
      mod._obxd_set_pcm_note_map(9, note, pad);
      mod._obxd_set_pcm_layer_count(9, pad, 1);
    };
    const renderSumSq = () => {
      let s = 0;
      for (let q = 0; q < 8; q++) {
        mod._obxd_render(128);
        const l = new Float32Array(mod.HEAPF32.buffer, mod._get_buf_l_ptr(), 128);
        for (let i = 0; i < 128; i++) s += l[i] * l[i];
      }
      return s;
    };
    mod._obxd_clear_pcm(9);
    loadPad(0, 36);
    loadPad(1, 38);
    mod._obxd_midi_in(9, 0x90, 36, 127);
    const s0 = renderSumSq();
    mod._obxd_midi_in(9, 0x80, 36, 0);
    renderSumSq(); // settle
    mod._obxd_midi_in(9, 0x90, 38, 127);
    const s1 = renderSumSq();
    mod._obxd_midi_in(9, 0x80, 38, 0);
    mod._obxd_panic(9);
    mod._obxd_clear_pcm(9);
    if (!(s0 > 0)) return `pad0 sum-of-squares = ${s0} (silent after load)`;
    if (!(s1 > 0)) return `pad1 sum-of-squares = ${s1} (silent after load)`;
  });

  // --- guitarix FX chains (wasm/obxd/gxfx_host.cpp) ------------------------
  // The FX insert lives between the synth render and the per-instance track
  // taps: obxd_render() writes g_track_l/r, gxfx_process() filters them in
  // place (early-out while the whole chain is disabled; runs on ZERO input
  // while the synth idles so delay/echo/reverb tails ring out past the last
  // note), then the master sum reads the wet rows. v2 slot model: slot index
  // = chain position, each of the 11 slots holds any effect id or -1 (empty),
  // params/enabled are keyed by SLOT (10*11*48 floats / 110 bytes), and
  // duplicates of one effect in several slots are allowed. obxd_init() is
  // idempotent and calls gxfx_init(), which resets slots to the identity
  // 0..10 (canonical 11 — default UX unchanged), params to FX_DEFAULTS and
  // every slot to disabled — the behavioral checks below re-init so they
  // stay independent of each other's side-effects.

  // (l) FX surface + slot round-trip ----------------------------------------
  expect('l. fx surface + set_slot/get_slot round-trip incl. -1 empty', () => {
    mod._obxd_init(48000);
    if (mod._fx_effect_count() !== 83) return `effect_count=${mod._fx_effect_count()}, want 83 (11 v1 + 17 drive/dynamics + 6 eq + 4 wah + 7 modulation + 12 time/delay + 4 reverb + 5 amp/tonestack + 10 multiband/utility incl. the audit-find Big Muff Pi + Phase 2-a cabinet + Phase 2-b redeye + metal amp/head + Phase 2-c detune + Phase 2-d tuner + Phase 3 livelooper)`;
    if (mod._fx_slot_params() !== 48) return `slot_params=${mod._fx_slot_params()}, want 48`;
    if (mod._fx_param_count(0) !== 2) return `param_count(0)=${mod._fx_param_count(0)}, want 2 (wah)`;
    if (mod._fx_param_count(8) !== 7) return `param_count(8)=${mod._fx_param_count(8)}, want 7 (delay)`;
    if (mod._fx_param_count(11) !== 2) return `param_count(11)=${mod._fx_param_count(11)}, want 2 (fuzzface)`;
    if (mod._fx_param_count(28) !== 11) return `param_count(28)=${mod._fx_param_count(28)}, want 11 (graphiceq)`;
    if (mod._fx_param_count(29) !== 30) return `param_count(29)=${mod._fx_param_count(29)}, want 30 (selecteq)`;
    if (mod._fx_param_count(34) !== 5) return `param_count(34)=${mod._fx_param_count(34)}, want 5 (wahmodel aggregate)`;
    if (mod._fx_param_count(35) !== 3) return `param_count(35)=${mod._fx_param_count(35)}, want 3 (crybaby)`;
    if (mod._fx_param_count(36) !== 0) return `param_count(36)=${mod._fx_param_count(36)}, want 0 (autowah — paramless envelope variant)`;
    if (mod._fx_param_count(37) !== 1) return `param_count(37)=${mod._fx_param_count(37)}, want 1 (dunwah WAH)`;
    if (mod._fx_param_count(38) !== 8) return `param_count(38)=${mod._fx_param_count(38)}, want 8 (vibe)`;
    if (mod._fx_param_count(39) !== 5) return `param_count(39)=${mod._fx_param_count(39)}, want 5 (tubetremelo)`;
    if (mod._fx_param_count(41) !== 8) return `param_count(41)=${mod._fx_param_count(41)}, want 8 (switched_tremolo)`;
    if (mod._fx_param_count(42) !== 10) return `param_count(42)=${mod._fx_param_count(42)}, want 10 (classic phaser)`;
    if (mod._fx_param_count(44) !== 3) return `param_count(44)=${mod._fx_param_count(44)}, want 3 (chorus_mono)`;
    if (mod._fx_param_count(45) !== 5) return `param_count(45)=${mod._fx_param_count(45)}, want 5 (duck_delay)`;
    if (mod._fx_param_count(46) !== 8) return `param_count(46)=${mod._fx_param_count(46)}, want 8 (duck_delay_st)`;
    if (mod._fx_param_count(47) !== 8) return `param_count(47)=${mod._fx_param_count(47)}, want 8 (digital_delay; SYNC/HOSTBPM skipped)`;
    if (mod._fx_param_count(49) !== 10) return `param_count(49)=${mod._fx_param_count(49)}, want 10 (gxtape)`;
    if (mod._fx_param_count(51) !== 8) return `param_count(51)=${mod._fx_param_count(51)}, want 8 (gxechocat)`;
    if (mod._fx_param_count(53) !== 3) return `param_count(53)=${mod._fx_param_count(53)}, want 3 (ts9)`;
    if (mod._fx_param_count(54) !== 3) return `param_count(54)=${mod._fx_param_count(54)}, want 3 (oc_2)`;
    if (mod._fx_param_count(55) !== 2) return `param_count(55)=${mod._fx_param_count(55)}, want 2 (classic_delay)`;
    if (mod._fx_param_count(56) !== 2) return `param_count(56)=${mod._fx_param_count(56)}, want 2 (classic_echo)`;
    if (mod._fx_param_count(57) !== 11) return `param_count(57)=${mod._fx_param_count(57)}, want 11 (zita_rev1)`;
    if (mod._fx_param_count(58) !== 3) return `param_count(58)=${mod._fx_param_count(58)}, want 3 (freeverb)`;
    if (mod._fx_param_count(59) !== 5) return `param_count(59)=${mod._fx_param_count(59)}, want 5 (room_simulator)`;
    if (mod._fx_param_count(60) !== 12) return `param_count(60)=${mod._fx_param_count(60)}, want 12 (shimmizita)`;
    if (mod._fx_param_count(61) !== 6) return `param_count(61)=${mod._fx_param_count(61)}, want 6 (ampmodel aggregate)`;
    if (mod._fx_param_count(62) !== 4) return `param_count(62)=${mod._fx_param_count(62)}, want 4 (tonestack aggregate)`;
    if (mod._fx_param_count(63) !== 12) return `param_count(63)=${mod._fx_param_count(63)}, want 12 (studiopre)`;
    if (mod._fx_param_count(64) !== 5) return `param_count(64)=${mod._fx_param_count(64)}, want 5 (alembic)`;
    if (mod._fx_param_count(65) !== 2) return `param_count(65)=${mod._fx_param_count(65)}, want 2 (w20)`;
    if (mod._fx_param_count(66) !== 34) return `param_count(66)=${mod._fx_param_count(66)}, want 34 (mbcompressor — biggest after livelooper)`;
    if (mod._fx_param_count(67) !== 19) return `param_count(67)=${mod._fx_param_count(67)}, want 19 (mbdelay)`;
    if (mod._fx_param_count(68) !== 15) return `param_count(68)=${mod._fx_param_count(68)}, want 15 (mbdistortion)`;
    if (mod._fx_param_count(69) !== 14) return `param_count(69)=${mod._fx_param_count(69)}, want 14 (mbecho)`;
    if (mod._fx_param_count(70) !== 24) return `param_count(70)=${mod._fx_param_count(70)}, want 24 (barkgraphiceq)`;
    if (mod._fx_param_count(71) !== 3) return `param_count(71)=${mod._fx_param_count(71)}, want 3 (bigmuffpi)`;
    if (mod._fx_param_count(72) !== 1) return `param_count(72)=${mod._fx_param_count(72)}, want 1 (balance)`;
    if (mod._fx_param_count(73) !== 1) return `param_count(73)=${mod._fx_param_count(73)}, want 1 (outputlevel)`;
    if (mod._fx_param_count(74) !== 1) return `param_count(74)=${mod._fx_param_count(74)}, want 1 (ampout)`;
    if (mod._fx_param_count(75) !== 7) return `param_count(75)=${mod._fx_param_count(75)}, want 7 (ampmodul)`;
    if (mod._fx_param_count(76) !== 4) return `param_count(76)=${mod._fx_param_count(76)}, want 4 (cabinet: CLevel/CBass/CTreble/c_model)`;
    if (mod._fx_param_count(77) !== 9) return `param_count(77)=${mod._fx_param_count(77)}, want 9 (redeye: 8 wrapper params + MODEL)`;
    if (mod._fx_param_count(78) !== 4) return `param_count(78)=${mod._fx_param_count(78)}, want 4 (metalamp: TONE/DRIVE/PREGAIN/GAIN1)`;
    if (mod._fx_param_count(79) !== 4) return `param_count(79)=${mod._fx_param_count(79)}, want 4 (metalhead: TONE/DRIVE/PREGAIN/GAIN1)`;
    if (mod._fx_param_count(80) !== 10) return `param_count(80)=${mod._fx_param_count(80)}, want 10 (detune: DETUNE..TREBLE; BYPASS filtered)`;
    if (mod._fx_param_count(81) !== 2) return `param_count(81)=${mod._fx_param_count(81)}, want 2 (tuner: REFFREQ/THRESHOLD)`;
    if (mod._fx_param_count(82) !== 39) return `param_count(82)=${mod._fx_param_count(82)}, want 39 (livelooper — biggest effect; reset/rback rescued via keepPorts)`;
    if (mod._fx_param_count(83) !== -1) return `param_count(83)=${mod._fx_param_count(83)}, want -1 (out of range)`;
    if (mod._fx_is_stereo(4) !== 1) return `is_stereo(4)=${mod._fx_is_stereo(4)}, want 1 (chorus)`;
    if (mod._fx_is_stereo(0) !== 0) return `is_stereo(0)=${mod._fx_is_stereo(0)}, want 0 (wah, dual-mono)`;
    if (mod._fx_is_stereo(11) !== 0) return `is_stereo(11)=${mod._fx_is_stereo(11)}, want 0 (fuzzface, dual-mono)`;
    if (mod._fx_is_stereo(38) !== 1) return `is_stereo(38)=${mod._fx_is_stereo(38)}, want 1 (vibe stereo)`;
    if (mod._fx_is_stereo(39) !== 0) return `is_stereo(39)=${mod._fx_is_stereo(39)}, want 0 (tubetremelo, dual-mono)`;
    if (mod._fx_is_stereo(42) !== 1) return `is_stereo(42)=${mod._fx_is_stereo(42)}, want 1 (classic phaser stereo orphan)`;
    if (mod._fx_is_stereo(30) !== 1) return `is_stereo(30)=${mod._fx_is_stereo(30)}, want 1 (tonecontroll, native stereo faust class)`;
    if (mod._fx_is_stereo(46) !== 1) return `is_stereo(46)=${mod._fx_is_stereo(46)}, want 1 (duck_delay_st)`;
    if (mod._fx_is_stereo(48) !== 1) return `is_stereo(48)=${mod._fx_is_stereo(48)}, want 1 (digital_delay_st)`;
    if (mod._fx_is_stereo(50) !== 1) return `is_stereo(50)=${mod._fx_is_stereo(50)}, want 1 (gxtape_st)`;
    if (mod._fx_is_stereo(45) !== 0) return `is_stereo(45)=${mod._fx_is_stereo(45)}, want 0 (duck_delay, dual-mono)`;
    if (mod._fx_is_stereo(53) !== 0) return `is_stereo(53)=${mod._fx_is_stereo(53)}, want 0 (ts9, dual-mono)`;
    if (mod._fx_is_stereo(57) !== 1) return `is_stereo(57)=${mod._fx_is_stereo(57)}, want 1 (zita_rev1, native stereo)`;
    if (mod._fx_is_stereo(60) !== 1) return `is_stereo(60)=${mod._fx_is_stereo(60)}, want 1 (shimmizita, native stereo)`;
    if (mod._fx_is_stereo(58) !== 0) return `is_stereo(58)=${mod._fx_is_stereo(58)}, want 0 (freeverb, dual-mono)`;
    if (mod._fx_is_stereo(59) !== 0) return `is_stereo(59)=${mod._fx_is_stereo(59)}, want 0 (room_simulator, dual-mono)`;
    if (mod._fx_is_stereo(61) !== 0) return `is_stereo(61)=${mod._fx_is_stereo(61)}, want 0 (ampmodel, dual-mono)`;
    if (mod._fx_is_stereo(62) !== 1) return `is_stereo(62)=${mod._fx_is_stereo(62)}, want 1 (tonestack, stereo aggregate)`;
    if (mod._fx_is_stereo(63) !== 1) return `is_stereo(63)=${mod._fx_is_stereo(63)}, want 1 (studiopre_st, native stereo)`;
    if (mod._fx_is_stereo(64) !== 0) return `is_stereo(64)=${mod._fx_is_stereo(64)}, want 0 (alembic, dual-mono)`;
    if (mod._fx_is_stereo(65) !== 0) return `is_stereo(65)=${mod._fx_is_stereo(65)}, want 0 (w20, dual-mono)`;
    if (mod._fx_is_stereo(66) !== 0) return `is_stereo(66)=${mod._fx_is_stereo(66)}, want 0 (mbcompressor, dual-mono)`;
    if (mod._fx_is_stereo(70) !== 0) return `is_stereo(70)=${mod._fx_is_stereo(70)}, want 0 (barkgraphiceq, dual-mono)`;
    if (mod._fx_is_stereo(71) !== 0) return `is_stereo(71)=${mod._fx_is_stereo(71)}, want 0 (bigmuffpi, dual-mono)`;
    if (mod._fx_is_stereo(72) !== 1) return `is_stereo(72)=${mod._fx_is_stereo(72)}, want 1 (balance, native stereo)`;
    if (mod._fx_is_stereo(73) !== 1) return `is_stereo(73)=${mod._fx_is_stereo(73)}, want 1 (outputlevel, native stereo)`;
    if (mod._fx_is_stereo(74) !== 0) return `is_stereo(74)=${mod._fx_is_stereo(74)}, want 0 (ampout, dual-mono)`;
    if (mod._fx_is_stereo(75) !== 1) return `is_stereo(75)=${mod._fx_is_stereo(75)}, want 1 (ampmodul, native stereo)`;
    if (mod._fx_is_stereo(76) !== 0) return `is_stereo(76)=${mod._fx_is_stereo(76)}, want 0 (cabinet, dual-mono convolver)`;
    if (mod._fx_is_stereo(77) !== 0) return `is_stereo(77)=${mod._fx_is_stereo(77)}, want 0 (redeye, dual-mono convolver)`;
    if (mod._fx_is_stereo(78) !== 0) return `is_stereo(78)=${mod._fx_is_stereo(78)}, want 0 (metalamp, dual-mono convolver)`;
    if (mod._fx_is_stereo(79) !== 0) return `is_stereo(79)=${mod._fx_is_stereo(79)}, want 0 (metalhead, dual-mono convolver)`;
    if (mod._fx_is_stereo(80) !== 0) return `is_stereo(80)=${mod._fx_is_stereo(80)}, want 0 (detune, dual-mono phase vocoder)`;
    if (mod._fx_is_stereo(81) !== 0) return `is_stereo(81)=${mod._fx_is_stereo(81)}, want 0 (tuner, dual-mono transparent)`;
    if (mod._fx_default(0, 1) !== 0.5) return `default(0,1)=${mod._fx_default(0, 1)}, want 0.5 (wah HOTPOTZ)`;
    if (mod._fx_default(3, 4) !== f32(0.002)) return `default(3,4)=${mod._fx_default(3, 4)}, want ${f32(0.002)}`;
    if (mod._fx_default(8, 2) !== 1000) return `default(8,2)=${mod._fx_default(8, 2)}, want 1000 (delay)`;
    if (mod._fx_default(17, 1) !== -7) return `default(17,1)=${mod._fx_default(17, 1)}, want -7 (rat LEVEL, ttl)`;
    if (mod._fx_default(28, 3) !== 0) return `default(28,3)=${mod._fx_default(28, 3)}, want 0 (graphiceq G4)`;
    if (mod._fx_default(31, 1) !== 3000) return `default(31,1)=${mod._fx_default(31, 1)}, want 3000 (moog FR)`;
    if (mod._fx_default(34, 3) !== 0) return `default(34,3)=${mod._fx_default(34, 3)}, want 0 (wahmodel MODEL)`;
    if (mod._fx_default(37, 0) !== 0) return `default(37,0)=${mod._fx_default(37, 0)}, want 0 (dunwah WAH)`;
    if (mod._fx_default(38, 3) !== f32(-0.6)) return `default(38,3)=${mod._fx_default(38, 3)}, want ${f32(-0.6)} (vibe FB, ttl)`;
    if (mod._fx_default(41, 5) !== 4) return `default(41,5)=${mod._fx_default(41, 5)}, want 4 (switched_tremolo STEPS)`;
    if (mod._fx_default(42, 0) !== 800) return `default(42,0)=${mod._fx_default(42, 0)}, want 800 (classic phaser MAXNOTCH1FREQ)`;
    if (mod._fx_default(44, 0) !== 2) return `default(44,0)=${mod._fx_default(44, 0)}, want 2 (chorus_mono FREQ)`;
    if (mod._fx_default(45, 4) !== 500) return `default(45,4)=${mod._fx_default(45, 4)}, want 500 (duck_delay TIME)`;
    if (mod._fx_default(46, 5) !== f32(0.0)) return `default(46,5)=${mod._fx_default(46, 5)}, want 0 (duck_delay_st PINGPONG)`;
    if (mod._fx_default(47, 0) !== 120) return `default(47,0)=${mod._fx_default(47, 0)}, want 120 (digital_delay BPM)`;
    if (mod._fx_default(49, 6) !== f32(0.4)) return `default(49,6)=${mod._fx_default(49, 6)}, want ${f32(0.4)} (gxtape hiss)`;
    if (mod._fx_default(52, 1) !== 160) return `default(52,1)=${mod._fx_default(52, 1)}, want 160 (gxtubedelay delay)`;
    if (mod._fx_default(53, 0) !== -16) return `default(53,0)=${mod._fx_default(53, 0)}, want -16 (ts9 Level)`;
    if (mod._fx_default(54, 1) !== f32(0.5)) return `default(54,1)=${mod._fx_default(54, 1)}, want ${f32(0.5)} (oc_2 OCTAVE1)`;
    if (mod._fx_default(55, 1) !== 0) return `default(55,1)=${mod._fx_default(55, 1)}, want 0 (classic_delay GAIN)`;
    if (mod._fx_default(56, 1) !== 1) return `default(56,1)=${mod._fx_default(56, 1)}, want 1 (classic_echo TIME)`;
    if (mod._fx_default(57, 4) !== 60) return `default(57,4)=${mod._fx_default(57, 4)}, want 60 (zita_rev1 IN_DELAY)`;
    if (mod._fx_default(58, 2) !== 50) return `default(58,2)=${mod._fx_default(58, 2)}, want 50 (freeverb WET_DRY)`;
    if (mod._fx_default(59, 0) !== f32(1.0)) return `default(59,0)=${mod._fx_default(59, 0)}, want 1 (room_simulator EFFECT on)`;
    if (mod._fx_default(59, 1) !== 20) return `default(59,1)=${mod._fx_default(59, 1)}, want 20 (room_simulator PREDELAYMS)`;
    if (mod._fx_default(60, 8) !== f32(0.0)) return `default(60,8)=${mod._fx_default(60, 8)}, want 0 (shimmizita SHIFT)`;
    if (mod._fx_default(60, 10) !== f32(3.0)) return `default(60,10)=${mod._fx_default(60, 10)}, want 3 (shimmizita T60DS)`;
    if (mod._fx_default(61, 2) !== 20) return `default(61,2)=${mod._fx_default(61, 2)}, want 20 (ampmodel Distortion)`;
    if (mod._fx_default(61, 4) !== 0) return `default(61,4)=${mod._fx_default(61, 4)}, want 0 (ampmodel MODEL)`;
    if (mod._fx_default(62, 3) !== 0) return `default(62,3)=${mod._fx_default(62, 3)}, want 0 (tonestack MODEL)`;
    if (mod._fx_default(63, 1) !== f32(0.5)) return `default(63,1)=${mod._fx_default(63, 1)}, want ${f32(0.5)} (studiopre volume_l)`;
    if (mod._fx_default(64, 4) !== f32(0.5)) return `default(64,4)=${mod._fx_default(64, 4)}, want ${f32(0.5)} (alembic volume)`;
    if (mod._fx_default(65, 0) !== f32(0.5)) return `default(65,0)=${mod._fx_default(65, 0)}, want ${f32(0.5)} (w20 gain)`;
    if (mod._fx_default(66, 15) !== 13) return `default(66,15)=${mod._fx_default(66, 15)}, want 13 (mbcompressor RATIO1, ttl)`;
    if (mod._fx_default(66, 30) !== 80) return `default(66,30)=${mod._fx_default(66, 30)}, want 80 (mbcompressor CROSSOVER_B1_B2)`;
    if (mod._fx_default(67, 0) !== 30) return `default(67,0)=${mod._fx_default(67, 0)}, want 30 (mbdelay DELAY1)`;
    if (mod._fx_default(70, 23) !== 0) return `default(70,23)=${mod._fx_default(70, 23)}, want 0 (barkgraphiceq G24)`;
    if (mod._fx_default(71, 0) !== f32(0.5)) return `default(71,0)=${mod._fx_default(71, 0)}, want ${f32(0.5)} (bigmuffpi SUSTAIN)`;
    if (mod._fx_default(72, 0) !== 0) return `default(72,0)=${mod._fx_default(72, 0)}, want 0 (balance)`;
    if (mod._fx_default(73, 0) !== 0) return `default(73,0)=${mod._fx_default(73, 0)}, want 0 (outputlevel)`;
    if (mod._fx_default(75, 4) !== 6) return `default(75,4)=${mod._fx_default(75, 4)}, want 6 (ampmodul TUBE1)`;
    if (mod._fx_default(76, 0) !== 1) return `default(76,0)=${mod._fx_default(76, 0)}, want 1 (cabinet CLevel)`;
    if (mod._fx_default(76, 1) !== 0) return `default(76,1)=${mod._fx_default(76, 1)}, want 0 (cabinet CBass)`;
    if (mod._fx_default(76, 2) !== 0) return `default(76,2)=${mod._fx_default(76, 2)}, want 0 (cabinet CTreble)`;
    if (mod._fx_default(76, 3) !== 0) return `default(76,3)=${mod._fx_default(76, 3)}, want 0 (cabinet c_model)`;
    if (mod._fx_default(77, 8) !== 0) return `default(77,8)=${mod._fx_default(77, 8)}, want 0 (redeye MODEL)`;
    if (mod._fx_default(78, 1) !== 10.5) return `default(78,1)=${mod._fx_default(78, 1)}, want 10.5 (metalamp DRIVE)`;
    if (mod._fx_default(79, 1) !== f32(0.32)) return `default(79,1)=${mod._fx_default(79, 1)}, want ${f32(0.32)} (metalhead DRIVE)`;
    if (mod._fx_default(80, 0) !== 0) return `default(80,0)=${mod._fx_default(80, 0)}, want 0 (detune DETUNE)`;
    if (mod._fx_default(80, 4) !== 50) return `default(80,4)=${mod._fx_default(80, 4)}, want 50 (detune WET)`;
    if (mod._fx_default(80, 6) !== 1) return `default(80,6)=${mod._fx_default(80, 6)}, want 1 (detune LOW)`;
    if (mod._fx_default(81, 0) !== 440) return `default(81,0)=${mod._fx_default(81, 0)}, want 440 (tuner REFFREQ)`;
    if (mod._fx_default(81, 1) !== -50) return `default(81,1)=${mod._fx_default(81, 1)}, want -50 (tuner THRESHOLD)`;
    if (mod._fx_default(82, 0) !== 100) return `default(82,0)=${mod._fx_default(82, 0)}, want 100 (livelooper clip1)`;
    if (mod._fx_default(82, 12) !== 0) return `default(82,12)=${mod._fx_default(82, 12)}, want 0 (livelooper gain)`;
    if (mod._fx_default(83, 0) !== 0) return `default(83,0)=${mod._fx_default(83, 0)}, want 0 (invalid fx)`;
    if (mod._fx_default(61, 0) !== 0) return `default(61,0)=${mod._fx_default(61, 0)}, want 0 (invalid fx)`;
    if (mod._fx_default(0, 48) !== 0) return `default(0,48)=${mod._fx_default(0, 48)}, want 0 (invalid param)`;
    // Default chain = canonical 11 (slot s holds fx s).
    for (let s = 0; s < 11; s++) {
      const v = mod._fx_get_slot(0, s);
      if (v !== s) return `default slot ${s}=${v}, want ${s}`;
    }
    // Assign, duplicate, empty — round-trips through fx_get_slot.
    mod._fx_set_slot(0, 3, 7);
    if (mod._fx_get_slot(0, 3) !== 7) return `slot(0,3)=${mod._fx_get_slot(0, 3)}, want 7`;
    mod._fx_set_slot(0, 5, 7); // duplicates allowed in v2
    if (mod._fx_get_slot(0, 5) !== 7) return `slot(0,5)=${mod._fx_get_slot(0, 5)}, want 7 (duplicate tremolo)`;
    if (mod._fx_get_slot(0, 3) !== 7) return `slot(0,3)=${mod._fx_get_slot(0, 3)}, want 7 (duplicate did not evict)`;
    mod._fx_set_slot(0, 3, -1);
    if (mod._fx_get_slot(0, 3) !== -1) return `slot(0,3)=${mod._fx_get_slot(0, 3)}, want -1 (empty)`;
    // Out-of-range args: silent no-ops, state untouched.
    mod._fx_set_slot(10, 0, 5);
    mod._fx_set_slot(0, 11, 5);
    mod._fx_set_slot(0, 0, 83); // FX_COUNT == 83 since Phase 3
    mod._fx_set_slot(0, 0, -2);
    if (mod._fx_get_slot(0, 0) !== 0) return `slot(0,0)=${mod._fx_get_slot(0, 0)}, want 0 (untouched)`;
    if (mod._fx_get_slot(10, 0) !== -1) return `slot(10,0)=${mod._fx_get_slot(10, 0)}, want -1 (invalid inst)`;
    if (mod._fx_get_slot(0, 11) !== -1) return `slot(0,11)=${mod._fx_get_slot(0, 11)}, want -1 (invalid slot)`;
  });

  // (m) Duplicated effect, independent per-slot params -----------------------
  // Instance 1: echo (fx 9) in slots 2 AND 5. Slot-keyed params/enabled must
  // be fully independent; empty slots reject param/enabled writes.
  expect('m. fx duplicate effect in two slots: independent params + enabled', () => {
    mod._fx_set_slot(1, 2, 9);
    mod._fx_set_slot(1, 5, 9);
    mod._fx_set_param(1, 2, 4, 0.9); // echo TIME_L (PortIndex: INVERT, PERCENT_R, TIME_R, PERCENT_L, TIME_L)
    mod._fx_set_param(1, 5, 4, 0.35);
    if (mod._fx_get_param(1, 2, 4) !== f32(0.9)) return `slot2 TIME_L=${mod._fx_get_param(1, 2, 4)}, want ${f32(0.9)}`;
    if (mod._fx_get_param(1, 5, 4) !== f32(0.35)) return `slot5 TIME_L=${mod._fx_get_param(1, 5, 4)}, want ${f32(0.35)}`;
    // Per-slot mirror: params[(inst*11 + slot)*48 + p].
    const params = new Float32Array(mod.HEAPF32.buffer, mod._fx_get_params_ptr(), 10 * 11 * 48);
    if (params[(1 * 11 + 2) * 48 + 4] !== f32(0.9)) return `mirror slot2=${params[(1 * 11 + 2) * 48 + 4]}, want ${f32(0.9)}`;
    if (params[(1 * 11 + 5) * 48 + 4] !== f32(0.35)) return `mirror slot5=${params[(1 * 11 + 5) * 48 + 4]}, want ${f32(0.35)}`;
    // Neighbor param keeps its default (PERCENT_L = 30).
    if (mod._fx_get_param(1, 2, 3) !== 30) return `slot2 PERCENT_L=${mod._fx_get_param(1, 2, 3)}, want 30`;
    // Enabled is per-slot too.
    mod._fx_set_enabled(1, 2, 1);
    if (mod._fx_get_enabled(1, 2) !== 1) return 'enabled(1,2) != 1 after set';
    if (mod._fx_get_enabled(1, 5) !== 0) return 'enabled(1,5) != 0 (must be independent)';
    // Empty slot: param + enabled writes are silent no-ops, reads 0.0.
    mod._fx_set_slot(1, 7, -1);
    mod._fx_set_param(1, 7, 0, 9.9);
    if (mod._fx_get_param(1, 7, 0) !== 0.0) return `empty slot param=${mod._fx_get_param(1, 7, 0)}, want 0.0`;
    mod._fx_set_enabled(1, 7, 1);
    if (mod._fx_get_enabled(1, 7) !== 0) return 'empty slot enabled=1 accepted, want no-op';
    // Out-of-range param index for the slotted effect: no-op.
    mod._fx_set_param(1, 2, 7, 5.5); // echo has 7 params (0..6)
    if (mod._fx_get_param(1, 2, 7) !== 0.0) return `param(1,2,7)=${mod._fx_get_param(1, 2, 7)}, want 0.0 (out of range)`;
  });

  // (n) Slot move ------------------------------------------------------------
  // Starting from (m)'s instance 1 layout: [0,1,9,3,4,9,6,-1,8,9,10] with
  // slot2 echo p4=0.9 ENABLED, slot5 echo p4=0.35 disabled, slot7 empty.
  expect('n. fx_move_slot: contents (id, params, enabled) travel with the slot', () => {
    // Move slot 5 -> 0 (up): [9,0,1,9,3,4,6,-1,8,9,10].
    mod._fx_move_slot(1, 5, 0);
    const wantUp = [9, 0, 1, 9, 3, 4, 6, -1, 8, 9, 10];
    for (let s = 0; s < 11; s++) {
      const v = mod._fx_get_slot(1, s);
      if (v !== wantUp[s]) return `after 5->0 slot ${s}=${v}, want ${wantUp[s]}`;
    }
    if (mod._fx_get_param(1, 0, 4) !== f32(0.35)) return `moved echo p4=${mod._fx_get_param(1, 0, 4)}, want ${f32(0.35)}`;
    if (mod._fx_get_param(1, 3, 4) !== f32(0.9)) return `shifted echo p4=${mod._fx_get_param(1, 3, 4)}, want ${f32(0.9)}`;
    if (mod._fx_get_enabled(1, 0) !== 0) return 'moved slot lost its disabled flag';
    if (mod._fx_get_enabled(1, 3) !== 1) return 'shifted slot lost its enabled flag';
    // Post-move param writes land in the relocated row.
    mod._fx_set_param(1, 0, 4, 0.5);
    if (mod._fx_get_param(1, 0, 4) !== f32(0.5)) return `post-move write=${mod._fx_get_param(1, 0, 4)}, want ${f32(0.5)}`;
    // Move slot 0 -> 3 (down): [0,1,9,9,3,4,6,-1,8,9,10].
    mod._fx_move_slot(1, 0, 3);
    const wantDown = [0, 1, 9, 9, 3, 4, 6, -1, 8, 9, 10];
    for (let s = 0; s < 11; s++) {
      const v = mod._fx_get_slot(1, s);
      if (v !== wantDown[s]) return `after 0->3 slot ${s}=${v}, want ${wantDown[s]}`;
    }
    if (mod._fx_get_param(1, 3, 4) !== f32(0.5)) return `re-moved echo p4=${mod._fx_get_param(1, 3, 4)}, want ${f32(0.5)}`;
    if (mod._fx_get_param(1, 2, 4) !== f32(0.9)) return `other echo p4=${mod._fx_get_param(1, 2, 4)}, want ${f32(0.9)}`;
    // Moving an empty slot just relocates the hole: 7 -> 10.
    mod._fx_move_slot(1, 7, 10);
    if (mod._fx_get_slot(1, 7) !== 8) return `slot 7=${mod._fx_get_slot(1, 7)}, want 8 (shifted up)`;
    if (mod._fx_get_slot(1, 10) !== -1) return `slot 10=${mod._fx_get_slot(1, 10)}, want -1 (hole moved)`;
    // Out-of-range moves: silent no-ops (instance 9 stays identity).
    mod._fx_move_slot(1, -1, 3);
    mod._fx_move_slot(1, 0, 11);
    mod._fx_move_slot(10, 0, 5);
    if (mod._fx_get_slot(1, 3) !== 9) return `slot(1,3)=${mod._fx_get_slot(1, 3)}, want 9 (untouched)`;
    if (mod._fx_get_slot(9, 0) !== 0) return `slot(9,0)=${mod._fx_get_slot(9, 0)}, want 0 (untouched)`;
    // The int16 slots mirror view reflects the moves.
    const slotsView = new Int16Array(mod.HEAPF32.buffer, mod._fx_get_slots_ptr(), 110);
    if (slotsView[1 * 11 + 10] !== -1) return `slots view [1][10]=${slotsView[1 * 11 + 10]}, want -1`;
    if (slotsView[9 * 11 + 0] !== 0) return `slots view [9][0]=${slotsView[9 * 11 + 0]}, want 0`;
    if (slotsView[0 * 11 + 5] !== 7) return `slots view [0][5]=${slotsView[0 * 11 + 5]}, want 7 (from check l)`;
  });

  // (o) Defaults reset on slot change ----------------------------------------
  expect('o. fx_set_slot resets params to the new effect defaults + clears enabled', () => {
    mod._fx_set_param(2, 4, 0, 3.3); // slot 4 holds chorus (default 0.5)
    mod._fx_set_slot(2, 4, 8); // -> delay
    if (mod._fx_get_param(2, 4, 0) !== f32(0.0)) return `delay p0=${mod._fx_get_param(2, 4, 0)}, want 0.0 (default)`;
    if (mod._fx_get_param(2, 4, 2) !== 1000) return `delay p2=${mod._fx_get_param(2, 4, 2)}, want 1000 (default)`;
    // Re-assigning the SAME effect also resets (fresh slot content).
    mod._fx_set_enabled(2, 4, 1);
    mod._fx_set_param(2, 4, 0, 7.7);
    mod._fx_set_slot(2, 4, 8);
    if (mod._fx_get_enabled(2, 4) !== 0) return 're-assign did not clear enabled';
    if (mod._fx_get_param(2, 4, 0) !== f32(0.0)) return `re-assign p0=${mod._fx_get_param(2, 4, 0)}, want 0.0 (reset)`;
  });

  // (p) Reverb tail past synth idle -----------------------------------------
  // obxd_panic() -> allSoundOff() and anySounding is recomputed per block,
  // so a couple of quanta after the note-off the engine takes the memset
  // fast path: everything the track row shows afterwards is produced by the
  // FX insert running on zero input.
  expect('p. fx reverb tail continues past synth idle (zero-input insert)', () => {
    mod._obxd_init(48000);
    mod._fx_set_enabled(0, 10, 1); // slot 10 = reverb (default chain)
    mod._obxd_midi_in(0, 0x90, 60, 100);
    const blockRms = () => {
      mod._obxd_render(128);
      const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
      const r = new Float32Array(mod.HEAPF32.buffer, mod._get_track_r_ptr(0), 128);
      let s = 0;
      for (let i = 0; i < 128; i++) {
        if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) return NaN;
        s += l[i] * l[i] + r[i] * r[i];
      }
      return Math.sqrt(s / 256);
    };
    let held = 0;
    for (let q = 0; q < 60; q++) held = blockRms();
    if (!Number.isFinite(held) || !(held > 1e-4)) return `held-note RMS = ${held} (too quiet to seed the tail)`;
    mod._obxd_midi_in(0, 0x80, 60, 0);
    mod._obxd_panic(0); // engine idle from here on
    for (let q = 0; q < 4; q++) blockRms(); // drain residual release
    const tail = [];
    for (let q = 0; q < 6; q++) tail.push(blockRms());
    if (tail.some((v) => !Number.isFinite(v))) return `non-finite tail sample: [${tail.join(', ')}]`;
    // Blocks ~5..10 after note-off: only the FX insert can be audible now.
    if (!(tail[4] > 1e-5)) {
      return `tail RMS after note-off = [${tail.map((v) => v.toExponential(2)).join(', ')}] — tail died with the synth`;
    }
  });

  // (q) Hard bypass ---------------------------------------------------------
  expect('q. fx hard bypass: disabling the chain silences the idle track row', () => {
    mod._obxd_init(48000);
    mod._fx_set_enabled(0, 10, 1); // slot 10 = reverb (default chain)
    mod._obxd_midi_in(0, 0x90, 60, 100);
    for (let q = 0; q < 30; q++) mod._obxd_render(128); // seed the reverb
    mod._obxd_midi_in(0, 0x80, 60, 0);
    mod._obxd_panic(0);
    mod._obxd_render(128); // one quantum: tail ringing on zero input
    const l0 = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
    let tailSq = 0;
    for (let i = 0; i < 128; i++) tailSq += l0[i] * l0[i];
    if (!(tailSq > 0)) return 'no tail to cut (pre-condition failed)';

    mod._fx_set_enabled(0, 10, 0);
    if (mod._fx_get_enabled(0, 10) !== 0) return 'enabled(0,10) != 0 after disable';
    const ep = mod._fx_get_enabled_ptr(); // unsigned char[10][11] view
    if (mod.HEAPU8[ep + 0 * 11 + 10] !== 0) return `enabled view [0][10]=${mod.HEAPU8[ep + 0 * 11 + 10]}, want 0`;
    // Chain disabled + engine idle -> track row must be pure zeros (the
    // memset fast path output passes through untouched).
    let silent = true;
    let bad = '';
    for (let q = 0; q < 10 && silent; q++) {
      mod._obxd_render(128);
      const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
      const r = new Float32Array(mod.HEAPF32.buffer, mod._get_track_r_ptr(0), 128);
      for (let i = 0; i < 128; i++) {
        if (l[i] !== 0 || r[i] !== 0) {
          silent = false;
          bad = `frame ${i}: L=${l[i]} R=${r[i]}`;
          break;
        }
      }
    }
    if (!silent) return `track row non-zero with chain disabled + engine idle — ${bad}`;
  });

  // (r) Bulk restore --------------------------------------------------------
  expect('r. fx_restore_ptr bulk-restores params + slots + enabled (v2 layout)', () => {
    mod._obxd_init(48000); // known defaults underneath
    // Slots: instance 0 reversed (slot s = 10 - s); instance 2 mixes
    // duplicates + an empty slot ([9,9,-1,3..10]); others identity.
    const slotsArr = new Int16Array(110);
    for (let e = 0; e < 10; e++) {
      for (let s = 0; s < 11; s++) slotsArr[e * 11 + s] = s;
    }
    for (let s = 0; s < 11; s++) slotsArr[0 * 11 + s] = 10 - s;
    slotsArr[2 * 11 + 0] = 9;
    slotsArr[2 * 11 + 1] = 9;
    slotsArr[2 * 11 + 2] = -1;
    // Params: per-slot defaults for whatever effect each slot holds, plus
    // two edits — reverb room size (param 1) on inst 0 slot 0, echo TIME_L
    // (param 4) on inst 2 slot 0 (but NOT its duplicate in slot 1).
    const paramsArr = new Float32Array(10 * 11 * 48);
    for (let e = 0; e < 10; e++) {
      for (let s = 0; s < 11; s++) {
        const fx = slotsArr[e * 11 + s];
        if (fx < 0) continue;
        for (let p = 0; p < 48; p++) paramsArr[(e * 11 + s) * 48 + p] = mod._fx_default(fx, p);
      }
    }
    paramsArr[(0 * 11 + 0) * 48 + 1] = 0.9; // reverb room size
    paramsArr[(2 * 11 + 0) * 48 + 4] = 0.9; // echo TIME_L, slot 0 only
    // Enabled: inst 0 runs only the reverb (slot 0); inst 2 runs both
    // duplicate echoes (slots 0 + 1); everything else off.
    const enabledArr = new Uint8Array(110);
    enabledArr[0 * 11 + 0] = 1;
    enabledArr[2 * 11 + 0] = 1;
    enabledArr[2 * 11 + 1] = 1;

    const pp = mod._malloc(10 * 11 * 48 * 4);
    const po = mod._malloc(110 * 2);
    const pe = mod._malloc(110);
    mod.HEAPF32.set(paramsArr, pp >> 2);
    new Int16Array(mod.HEAPF32.buffer, po, 110).set(slotsArr);
    mod.HEAPU8.set(enabledArr, pe);
    mod._fx_restore_ptr(pp, po, pe);
    mod._free(pp);
    mod._free(po);
    mod._free(pe);

    if (mod._fx_get_slot(0, 0) !== 10) return `slot(0,0)=${mod._fx_get_slot(0, 0)}, want 10 (reversed)`;
    if (mod._fx_get_slot(0, 10) !== 0) return `slot(0,10)=${mod._fx_get_slot(0, 10)}, want 0 (reversed)`;
    if (mod._fx_get_slot(2, 0) !== 9 || mod._fx_get_slot(2, 1) !== 9) return 'inst 2 duplicate echoes not restored';
    if (mod._fx_get_slot(2, 2) !== -1) return `slot(2,2)=${mod._fx_get_slot(2, 2)}, want -1 (empty)`;
    if (mod._fx_get_slot(5, 5) !== 5) return `slot(5,5)=${mod._fx_get_slot(5, 5)}, want 5 (identity instance)`;
    if (mod._fx_get_enabled(0, 0) !== 1) return `enabled(0,0)=${mod._fx_get_enabled(0, 0)}, want 1`;
    if (mod._fx_get_enabled(0, 10) !== 0) return `enabled(0,10)=${mod._fx_get_enabled(0, 10)}, want 0`;
    if (mod._fx_get_enabled(2, 0) !== 1 || mod._fx_get_enabled(2, 1) !== 1) return 'inst 2 enables not restored';
    if (mod._fx_get_enabled(1, 0) !== 0) return `enabled(1,0)=${mod._fx_get_enabled(1, 0)}, want 0`;
    if (mod._fx_get_param(0, 0, 1) !== f32(0.9)) return `reverb room=${mod._fx_get_param(0, 0, 1)}, want ${f32(0.9)}`;
    if (mod._fx_get_param(2, 0, 4) !== f32(0.9)) return `echo0 TIME_L=${mod._fx_get_param(2, 0, 4)}, want ${f32(0.9)}`;
    if (mod._fx_get_param(2, 1, 4) !== 100) return `echo1 TIME_L=${mod._fx_get_param(2, 1, 4)}, want 100 (default — duplicate is independent)`;
    if (mod._fx_get_param(2, 2, 0) !== 0.0) return `empty slot param=${mod._fx_get_param(2, 2, 0)}, want 0.0`;
    const slotsView = new Int16Array(mod.HEAPF32.buffer, mod._fx_get_slots_ptr(), 110);
    if (slotsView[0 * 11 + 0] !== 10 || slotsView[2 * 11 + 2] !== -1) return 'slots mirror view stale after restore';
    const ev = new Uint8Array(mod.HEAPU8.buffer, mod._fx_get_enabled_ptr(), 110);
    if (ev[0 * 11 + 0] !== 1 || ev[1 * 11 + 0] !== 0) return 'enabled mirror view stale after restore';
    // Audio: a held note through the restored reverb chain must render
    // finite, non-silent audio.
    mod._obxd_midi_in(0, 0x90, 60, 100);
    let sq = 0;
    let finite = true;
    for (let q = 0; q < 10; q++) {
      mod._obxd_render(128);
      const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
      const r = new Float32Array(mod.HEAPF32.buffer, mod._get_track_r_ptr(0), 128);
      for (let i = 0; i < 128; i++) {
        if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) finite = false;
        sq += l[i] * l[i] + r[i] * r[i];
      }
    }
    mod._obxd_midi_in(0, 0x80, 60, 0);
    mod._obxd_panic(0);
    if (!finite) return 'non-finite sample after bulk restore';
    if (!(sq > 0)) return `sum-of-squares = ${sq} (silent after restore)`;
  });

  // (s) Multiband spot check: mb param sweep reaches the DSP ---------------
  // mbcompressor (fx 66) in instance 3 slot 4, enabled, driven by the
  // deterministic LCG ramp (fx_test_slot_rms — the old synth-fed gate had a
  // 0.5% margin against ~0.3% per-init juce::Random slop and flaked; on the
  // ramp the deltas are exact). The RATIO3 sweep must change the track RMS
  // (band 3 spans 210..1700 Hz — broadband ramp energy lives there), and a
  // MAKEUP3 swing must change it; everything stays finite (the meter-scratch
  // parking in gxfx_mb.cpp keeps the V1..V10 writes off uninitialized
  // pointers).
  expect('s. fx mbcompressor: ratio-based param sweep reaches the DSP (finite)', () => {
    mod._obxd_init(48000);
    mod._fx_set_slot(3, 4, 66);
    mod._fx_set_enabled(3, 4, 1);
    // Ratio sweep: RATIO3 (param 17, port 17) 1 (bypass-ish) vs 100 (max).
    mod._fx_set_param(3, 4, 17, 1);
    const rmsRatio1 = mod._fx_test_slot_rms(3, 4);
    mod._fx_set_param(3, 4, 17, 100);
    const rmsRatio100 = mod._fx_test_slot_rms(3, 4);
    if (!Number.isFinite(rmsRatio1) || !Number.isFinite(rmsRatio100)) {
      return `non-finite mb output (ratio 1: ${rmsRatio1}, ratio 100: ${rmsRatio100}) — meter parking broken?`;
    }
    if (!(rmsRatio1 > 1e-4)) return `rms at RATIO3=1 too quiet to test: ${rmsRatio1}`;
    const rel = Math.abs(rmsRatio1 - rmsRatio100) / rmsRatio1;
    if (!(rel > 0.05)) return `RATIO3 sweep 1→100 changed ramp RMS by only ${(rel * 100).toFixed(3)}% (${rmsRatio1} → ${rmsRatio100}) — param not reaching the DSP`;
    // Makeup sweep: MAKEUP3 (param 7) 10 dB → -40 dB must audibly cut band 3
    // (210..1700 Hz). Not a halving — the other bands carry energy too —
    // but a clear drop that proves the makeup port reaches the DSP as well.
    mod._fx_set_param(3, 4, 7, -40);
    const rmsCut = mod._fx_test_slot_rms(3, 4);
    if (!(rmsCut < rmsRatio100 * 0.95)) return `MAKEUP3 -40 dB left RMS at ${((rmsCut / rmsRatio100) * 100).toFixed(1)}% of loud RMS (${rmsRatio100} → ${rmsCut}) — makeup not reaching the DSP`;
  });

  // (s) Drive family spot check (Phase 1-a) ---------------------------------
  // Loads a NEW effect (fuzzface, id 11) into a slot, round-trips params
  // through the mirror, and proves the generated FX_PORTS row actually
  // feeds the DSP connect_ports: a held note's RMS at FUZZ=1.0 is ~30%
  // above FUZZ=0.05 (measured; repeats stable to ±0.5%), so a 15% margin
  // cleanly separates "param wired" from "param dropped on the floor"
  // (an unconnected port would leave the ratio at 1.00 ± 0.01). Rendering
  // is not bit-deterministic across obxd_init (~0.3% RMS run-to-run) —
  // RMS-level comparison absorbs that noise.
  expect('s. drive family: fuzzface slot renders + FUZZ knob changes the audio', () => {
    const renderRms = (fuzz) => {
      mod._obxd_init(48000); // fresh: default chain, slot 0 = wah
      mod._fx_set_slot(0, 0, 11); // -> fuzzface
      if (mod._fx_get_slot(0, 0) !== 11) return { err: `slot(0,0)=${mod._fx_get_slot(0, 0)}, want 11 (fuzzface)` };
      if (mod._fx_param_count(11) !== 2) return { err: `param_count(11)=${mod._fx_param_count(11)}, want 2` };
      mod._fx_set_param(0, 0, 0, fuzz); // FUZZ (ordinal 0, PortIndex 2)
      if (mod._fx_get_param(0, 0, 0) !== f32(fuzz)) return { err: `FUZZ round-trip=${mod._fx_get_param(0, 0, 0)}, want ${f32(fuzz)}` };
      mod._fx_set_param(0, 0, 1, 0.5); // LEVEL (ordinal 1, PortIndex 3)
      if (mod._fx_get_param(0, 0, 1) !== f32(0.5)) return { err: `LEVEL round-trip=${mod._fx_get_param(0, 0, 1)}, want ${f32(0.5)}` };
      mod._fx_set_enabled(0, 0, 1);
      mod._obxd_midi_in(0, 0x90, 60, 100);
      let s = 0;
      let finite = true;
      for (let q = 0; q < 30; q++) {
        mod._obxd_render(128);
        if (q < 20) continue; // let the note + si.smooth settle
        const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
        const r = new Float32Array(mod.HEAPF32.buffer, mod._get_track_r_ptr(0), 128);
        for (let i = 0; i < 128; i++) {
          if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) finite = false;
          s += l[i] * l[i] + r[i] * r[i];
        }
      }
      mod._obxd_midi_in(0, 0x80, 60, 0);
      mod._obxd_panic(0);
      if (!finite) return { err: 'non-finite sample through fuzzface' };
      return { rms: Math.sqrt(s / (10 * 256)) };
    };
    const low = renderRms(0.05);
    if (low.err) return low.err;
    const high = renderRms(1.0);
    if (high.err) return high.err;
    if (!(low.rms > 0)) return `fuzzface output silent at FUZZ=0.05 (rms=${low.rms.toExponential(3)})`;
    if (!(high.rms > low.rms * 1.15)) {
      return `FUZZ knob does not reach the DSP: rms(0.05)=${low.rms.toExponential(4)} rms(1.0)=${high.rms.toExponential(4)} (ratio ${(high.rms / low.rms).toFixed(3)}, want > 1.15)`;
    }
  });

  // (t) EQ family spot check (Phase 1-b) ------------------------------------
  // Loads graphiceq (id 28) into a slot and proves the generated FX_PORTS
  // row feeds the DSP. graphiceq is a PARALLEL filter bank (fi.filterbank,
  // bands summed coherently), so a single-band probe can cancel against its
  // un-boosted neighbours — instead sweep ALL 11 gains uniformly: +12 dB vs
  // -18 dB is a coherent ~30x gain change (db2linear), far beyond the 1.15
  // margin, and only reaches the DSP if the ports wire. Also proves the
  // V1..V11 meter pointers are parked (the faust compute() dereferences them
  // unconditionally via #define — an unwired pointer would trap on render).
  expect('t. eq family: graphiceq slot renders + uniform gain sweep reaches the DSP', () => {
    const renderRms = (bandGainDb) => {
      mod._obxd_init(48000); // fresh: default chain, slot 0 = wah
      mod._fx_set_slot(0, 0, 28); // -> graphiceq
      if (mod._fx_get_slot(0, 0) !== 28) return { err: `slot(0,0)=${mod._fx_get_slot(0, 0)}, want 28 (graphiceq)` };
      if (mod._fx_param_count(28) !== 11) return { err: `param_count(28)=${mod._fx_param_count(28)}, want 11` };
      for (let g = 0; g < 11; g++) {
        mod._fx_set_param(0, 0, g, bandGainDb); // G1..G11 (ordinals = PortIndex 0..10)
        if (mod._fx_get_param(0, 0, g) !== f32(bandGainDb)) return { err: `G${g + 1} round-trip=${mod._fx_get_param(0, 0, g)}, want ${f32(bandGainDb)}` };
      }
      mod._fx_set_enabled(0, 0, 1);
      mod._obxd_midi_in(0, 0x90, 60, 100);
      let s = 0;
      let finite = true;
      for (let q = 0; q < 30; q++) {
        mod._obxd_render(128);
        if (q < 20) continue; // let the note + si.smooth(0.999) settle
        const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
        const r = new Float32Array(mod.HEAPF32.buffer, mod._get_track_r_ptr(0), 128);
        for (let i = 0; i < 128; i++) {
          if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) finite = false;
          s += l[i] * l[i] + r[i] * r[i];
        }
      }
      mod._obxd_midi_in(0, 0x80, 60, 0);
      mod._obxd_panic(0);
      if (!finite) return { err: 'non-finite sample through graphiceq' };
      return { rms: Math.sqrt(s / (10 * 256)) };
    };
    const cut = renderRms(-18);
    if (cut.err) return cut.err;
    const boost = renderRms(12);
    if (boost.err) return boost.err;
    if (!(cut.rms > 0)) return `graphiceq output silent at -18 dB bands (rms=${cut.rms.toExponential(3)})`;
    if (!(boost.rms > cut.rms * 1.15)) {
      return `gain knobs do not reach the DSP: rms(-18dB)=${cut.rms.toExponential(4)} rms(+12dB)=${boost.rms.toExponential(4)} (ratio ${(boost.rms / cut.rms).toFixed(3)}, want > 1.15)`;
    }
  });

  // (u) Wah family spot check (Phase 1-c) -----------------------------------
  // Exercises the first host-side aggregate (WahModelDsp, id 34): params
  // round-trip through the mirror, a WAH sweep through model 0 vs model 6
  // produces measurably different audio (the two circuits peak at different
  // frequencies — an unwired MODEL param would leave the ratio at ~1.00),
  // and swapping MODEL mid-render stays finite (hot-swap path: create new,
  // connect params, destroy old). Also proves the paramless autowah (id 36)
  // renders — the 0-param connect loop must be a clean no-op.
  expect('u. wah family: WahModel aggregate model 0 vs 6 differ on a sweep; mid-render swap stays finite', () => {
    // Model 0 vs 6 must differ measurably. The two renders each get a
    // fresh obxd_init, and the engine's juce::Random LFO seeds differ per
    // init — comparing two absolute RMS values across those seeds flaked
    // (synth variance ~±10% vs a ~5-10% true model difference; observed as
    // a CI flake). Instead: ONE render, same note + seed, alternating 0/6
    // in 8-quantum segments over a repeating WAH sweep — the per-model
    // segment RMS ratio is balanced against envelope drift by the
    // alternation itself, and the comparison is within a single render.
    mod._obxd_init(48000);
    mod._fx_set_slot(0, 0, 34);
    mod._fx_set_param(0, 0, 2, 0); // MODE = manual
    mod._fx_set_param(0, 0, 4, 100); // WET_DRY = full wet
    mod._fx_set_enabled(0, 0, 1);
    mod._obxd_midi_in(0, 0x90, 60, 100);
    let segFinite = true;
    let s0 = 0, s6 = 0, n0 = 0, n6 = 0;
    const SEG = 8, SEGS = 8; // 64 quanta ≈ 170 ms, 4 alternations
    for (let q = 0; q < SEG * SEGS; q++) {
      const model = (q >> 3) % 2 === 0 ? 0 : 6;
      mod._fx_set_param(0, 0, 3, model);
      mod._fx_set_param(0, 0, 0, (q % SEG) / (SEG - 1)); // WAH sawtooth sweep
      mod._obxd_render(128);
      if (q < 8) continue; // let the note settle into the first segment
      const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
      const r = new Float32Array(mod.HEAPF32.buffer, mod._get_track_r_ptr(0), 128);
      for (let i = 0; i < 128; i++) {
        if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) segFinite = false;
        const q2 = l[i] * l[i] + r[i] * r[i];
        if (model === 0) { s0 += q2; n0++; } else { s6 += q2; n6++; }
      }
    }
    mod._obxd_midi_in(0, 0x80, 60, 0);
    mod._obxd_panic(0);
    if (!segFinite) return 'non-finite sample through wahmodel alternation';
    const m0 = { rms: Math.sqrt(s0 / (n0 * 256)) }; // Colorsound Wah
    const m6 = { rms: Math.sqrt(s6 / (n6 * 256)) }; // Vox Wah V847
    if (!(m0.rms > 0) || !(m6.rms > 0)) return `wahmodel output silent: m0=${m0.rms.toExponential(3)} m6=${m6.rms.toExponential(3)}`;
    const rel = Math.abs(m6.rms - m0.rms) / Math.max(m0.rms, m6.rms);
    if (!(rel > 0.02)) {
      return `MODEL param does not reach the DSP: rms(model0)=${m0.rms.toExponential(4)} rms(model6)=${m6.rms.toExponential(4)} (rel diff ${(rel * 100).toFixed(2)}%, want > 2%)`;
    }
    // Mid-render hot swap: model 0 for a while, flip to 6 inside the note,
    // keep rendering — output must stay finite and audible.
    mod._obxd_init(48000);
    mod._fx_set_slot(0, 0, 34);
    mod._fx_set_param(0, 0, 4, 100);
    mod._fx_set_enabled(0, 0, 1);
    mod._obxd_midi_in(0, 0x90, 60, 100);
    let swapFinite = true;
    let swapSq = 0;
    for (let q = 0; q < 24; q++) {
      if (q === 10) mod._fx_set_param(0, 0, 3, 6); // hot swap mid-note
      if (q === 16) mod._fx_set_param(0, 0, 3, 2); // and back to Foxx
      mod._obxd_render(128);
      const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
      const r = new Float32Array(mod.HEAPF32.buffer, mod._get_track_r_ptr(0), 128);
      for (let i = 0; i < 128; i++) {
        if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) swapFinite = false;
        swapSq += l[i] * l[i] + r[i] * r[i];
      }
    }
    mod._obxd_midi_in(0, 0x80, 60, 0);
    mod._obxd_panic(0);
    if (!swapFinite) return 'non-finite sample after mid-render MODEL swaps';
    if (!(swapSq > 0)) return `output silent across MODEL swaps (sumSq=${swapSq})`;
    // Paramless autowah: 0 params -> connect loop is a no-op; envelope
    // follower must still render finite, non-zero audio on its own input.
    mod._obxd_init(48000);
    mod._fx_set_slot(0, 0, 36); // -> autowah
    if (mod._fx_get_param(0, 0, 0) !== 0.0) return `autowah param(0,0,0)=${mod._fx_get_param(0, 0, 0)}, want 0.0 (no params)`;
    mod._fx_set_param(0, 0, 0, 0.7); // must be rejected: out of range
    if (mod._fx_get_param(0, 0, 0) !== 0.0) return `autowah accepted a param write (${mod._fx_get_param(0, 0, 0)})`;
    mod._fx_set_enabled(0, 0, 1);
    mod._obxd_midi_in(0, 0x90, 60, 100);
    let awFinite = true;
    let awSq = 0;
    for (let q = 0; q < 24; q++) {
      mod._obxd_render(128);
      const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
      const r = new Float32Array(mod.HEAPF32.buffer, mod._get_track_r_ptr(0), 128);
      for (let i = 0; i < 128; i++) {
        if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) awFinite = false;
        awSq += l[i] * l[i] + r[i] * r[i];
      }
    }
    mod._obxd_midi_in(0, 0x80, 60, 0);
    mod._obxd_panic(0);
    if (!awFinite) return 'non-finite sample through paramless autowah';
    if (!(awSq > 0)) return `autowah output silent (sumSq=${awSq})`;
  });

  // (v) Modulation family spot check (Phase 1-d) ----------------------------
  // Exercises all four DSP shapes of the family: the bundle-local STEREO
  // vibe (id 38 — proves the wrapper-space PortIndex + plugin_stereo()
  // wiring: full-wet DEPTH sweep must stay finite and audible), the
  // 12ax7-table mono tube tremolo (id 39 — proves the circuit_tables
  // per-namespace includes link and render; DEPTH 0 vs 1 at speed 10 Hz
  // must change the RMS measurably, an unconnected DEPTH would leave the
  // ratio at ~1.00), the classic stereo phaser orphan (id 42 — proves the
  // stereo orphan path), and param round-trips through the slot mirror for
  // switched_tremolo (id 41) + chorus_mono (id 44).
  expect('v. modulation family: vibe/tube tremolo/classic phaser render; tube DEPTH modulates the envelope', () => {
    // renderRms also collects the per-quantum RMS trace, so the tube
    // tremolo can be probed via its AM ENVELOPE SPREAD ((max-min)/mean over
    // the measured quanta) — a metric normalized by its own mean, immune to
    // the run-to-run JUCE-Random synth variance that flakes absolute-RMS
    // comparisons (see the u. check for that failure mode).
    const renderRms = (fxId, setParams, quanta = 40, skip = 10) => {
      mod._obxd_init(48000); // fresh: default chain, slot 0 = wah
      mod._fx_set_slot(0, 0, fxId);
      if (mod._fx_get_slot(0, 0) !== fxId) return { err: `slot(0,0)=${mod._fx_get_slot(0, 0)}, want ${fxId}` };
      setParams.forEach(([p, v]) => mod._fx_set_param(0, 0, p, v));
      mod._fx_set_enabled(0, 0, 1);
      mod._obxd_midi_in(0, 0x90, 60, 100);
      let s = 0;
      let finite = true;
      const perQuantum = [];
      for (let q = 0; q < quanta; q++) {
        mod._obxd_render(128);
        if (q < skip) continue; // let the note settle
        const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
        const r = new Float32Array(mod.HEAPF32.buffer, mod._get_track_r_ptr(0), 128);
        let qs = 0;
        for (let i = 0; i < 128; i++) {
          if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) finite = false;
          qs += l[i] * l[i] + r[i] * r[i];
        }
        s += qs;
        perQuantum.push(Math.sqrt(qs / 256));
      }
      mod._obxd_midi_in(0, 0x80, 60, 0);
      mod._obxd_panic(0);
      if (!finite) return { err: `non-finite sample through fx ${fxId}` };
      return { rms: Math.sqrt(s / ((quanta - skip) * 256)), perQuantum };
    };
    // vibe: full wet, generous depth — finite + audible
    const vb = renderRms(38, [[2, 1], [1, 1], [4, 5]]); // WETDRY=1, DEPTH=1, TEMPO=5
    if (vb.err) return vb.err;
    if (!(vb.rms > 0)) return `vibe output silent (rms=${vb.rms.toExponential(3)})`;
    // tube tremolo: envelope spread at DEPTH 1 vs DEPTH 0 (speed 5 Hz — the
    // 200 ms LFO period across the ~80 ms measured window guarantees a crest
    // AND a trough in the per-quantum RMS trace)
    const spread = (r) => {
      const max = Math.max(...r.perQuantum);
      const min = Math.min(...r.perQuantum);
      const mean = r.perQuantum.reduce((a, b) => a + b, 0) / r.perQuantum.length;
      return (max - min) / mean;
    };
    const tt0 = renderRms(39, [[1, 0], [2, 5]]); // depth=0, speed=5Hz
    if (tt0.err) return tt0.err;
    const tt1 = renderRms(39, [[1, 1], [2, 5]]); // depth=1
    if (tt1.err) return tt1.err;
    if (!(tt0.rms > 0) || !(tt1.rms > 0)) return `tube tremolo silent: d0=${tt0.rms.toExponential(3)} d1=${tt1.rms.toExponential(3)}`;
    const s0 = spread(tt0);
    const s1 = spread(tt1);
    if (!(s1 > s0 * 2 && s1 > 0.3)) {
      return `tubetremolo DEPTH does not reach the DSP: envSpread(d0)=${s0.toFixed(3)} envSpread(d1)=${s1.toFixed(3)} (want d1 > 2*d0 and > 0.3)`;
    }
    // classic stereo phaser orphan: full wet, moving notches — finite + audible
    const ph = renderRms(42, [[6, 1], [4, 2], [5, 0]]); // DEPTH=1, SPEED=2, VIBRATOMODE=0
    if (ph.err) return ph.err;
    if (!(ph.rms > 0)) return `classic phaser output silent (rms=${ph.rms.toExponential(3)})`;
    // switched_tremolo + chorus_mono: param round-trips through the mirror
    mod._obxd_init(48000);
    mod._fx_set_slot(0, 0, 41);
    mod._fx_set_param(0, 0, 5, 2); // STEPS = 2
    if (mod._fx_get_param(0, 0, 5) !== 2) return `switched_tremolo STEPS round-trip=${mod._fx_get_param(0, 0, 5)}, want 2`;
    mod._fx_set_slot(0, 0, 44);
    mod._fx_set_param(0, 0, 0, 7.5); // FREQ
    if (mod._fx_get_param(0, 0, 0) !== f32(7.5)) return `chorus_mono FREQ round-trip=${mod._fx_get_param(0, 0, 0)}, want ${f32(7.5)}`;
    const params = new Float32Array(mod.HEAPF32.buffer, mod._fx_get_params_ptr(), 10 * 11 * 48);
    if (params[(0 * 11 + 0) * 48 + 0] !== f32(7.5)) return `chorus_mono mirror=${params[(0 * 11 + 0) * 48 + 0]}, want ${f32(7.5)}`;
  });

  // (w) Time/delay family spot check (Phase 1-e) ----------------------------
  // Exercises every DSP shape of the family: bundle-local mono (duck_delay)
  // + STEREO (duck_delay_st) classes, the 4 MB-member digital_delay (mono,
  // dual-mono pair), the 12au7-table gxtape, the copicat gxechocat, the
  // 12ax7 gxtubedelay, the ts9 circuit-sim adapter, the oc_2 octaver and
  // both classic orphans. Renders prove the wrapper-space PortIndex enums
  // and the circuit tables link; a feedback sweep on duck_delay proves the
  // generated FX_PORTS row reaches the DSP; the heap-size probe around a
  // digital_delay slot assign confirms the documented 4 MB-at-creation
  // member (2 x 4 MB dual-mono, bounded per slot).
  expect('w. time family: duck/tape/echocat/tubedelay/ts9/oc_2/classics render; duck feedback sweeps; digital_delay heap growth bounded', () => {
    const renderTrace = (fxId, setParams, quanta = 80, skip = 10) => {
      mod._obxd_init(48000); // fresh: default chain, slot 0 = wah
      mod._fx_set_slot(0, 0, fxId);
      if (mod._fx_get_slot(0, 0) !== fxId) return { err: `slot(0,0)=${mod._fx_get_slot(0, 0)}, want ${fxId}` };
      setParams.forEach(([p, v]) => mod._fx_set_param(0, 0, p, v));
      mod._fx_set_enabled(0, 0, 1);
      mod._obxd_midi_in(0, 0x90, 60, 100);
      let s = 0;
      let finite = true;
      const perQuantum = [];
      for (let q = 0; q < quanta; q++) {
        mod._obxd_render(128);
        if (q < skip) continue; // let the note settle
        const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
        const r = new Float32Array(mod.HEAPF32.buffer, mod._get_track_r_ptr(0), 128);
        let qs = 0;
        for (let i = 0; i < 128; i++) {
          if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) finite = false;
          qs += l[i] * l[i] + r[i] * r[i];
        }
        s += qs;
        perQuantum.push(Math.sqrt(qs / 256));
      }
      mod._obxd_midi_in(0, 0x80, 60, 0);
      mod._obxd_panic(0);
      if (!finite) return { err: `non-finite sample through fx ${fxId}` };
      return { rms: Math.sqrt(s / ((quanta - skip) * 256)), perQuantum };
    };
    // dry passes (default wet levels are subtle) — the point is: wrapper
    // PortIndex links, tables link, adapter runs, output stays finite+alive
    for (const [fxId, name] of [
      [45, 'duck_delay'], [46, 'duck_delay_st'], [47, 'digital_delay'],
      [49, 'gxtape'], [50, 'gxtape_st'], [51, 'gxechocat'], [52, 'gxtubedelay'],
      [53, 'ts9'], [54, 'oc_2'], [55, 'classic_delay'], [56, 'classic_echo'],
    ]) {
      const r = renderTrace(fxId, []);
      if (r.err) return `${name}: ${r.err}`;
      if (!(r.rms > 0)) return `${name} output silent (rms=${r.rms.toExponential(3)})`;
    }
    // duck_delay FEEDBACK reach: AMOUNT is the envelope-duck DEPTH in dB
    // (0 = wet always on — duck_delay.dsp gates the wet path by
    // 1 - amp_follower*db2linear(amount), so a sustained note at amount 56
    // silences the repeats). Burst-tail probe: short note (off after 20
    // quanta), TIME 30 ms, then measure energy in quanta 100..159 — far
    // past the note and its release. FEEDBACK 0.9 recirculates the repeats
    // for hundreds of ms (tail energy 100x+ the fb-0 release floor across
    // runs), while the synth's own contribution there is spent. The old
    // sustained-note halfRatio variant flaked: the engine's random voice
    // slop (juce::Random-seeded level/ampEnv, Voice.h) makes the note's
    // intra-run envelope swing more than the feedback effect — a tail
    // metric after the note ends is immune.
    const burstTail = (fb, quanta = 160, noteOff = 20, from = 100) => {
      mod._obxd_init(48000);
      mod._fx_set_slot(0, 0, 45);
      mod._fx_set_param(0, 0, 0, 0);   // AMOUNT 0 (wet always on)
      mod._fx_set_param(0, 0, 4, 30);  // TIME 30 ms
      mod._fx_set_param(0, 0, 2, fb);  // FEEDBACK
      mod._fx_set_enabled(0, 0, 1);
      mod._obxd_midi_in(0, 0x90, 60, 100);
      const perQuantum = [];
      for (let q = 0; q < quanta; q++) {
        if (q === noteOff) mod._obxd_midi_in(0, 0x80, 60, 0);
        mod._obxd_render(128);
        const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
        const r = new Float32Array(mod.HEAPF32.buffer, mod._get_track_r_ptr(0), 128);
        let qs = 0;
        for (let i = 0; i < 128; i++) qs += l[i] * l[i] + r[i] * r[i];
        perQuantum.push(qs);
      }
      mod._obxd_panic(0);
      return perQuantum.slice(from).reduce((x, y) => x + y, 0);
    };
    const tail0 = burstTail(0);
    const tail9 = burstTail(0.9);
    if (!(tail9 > 10 * tail0 && tail9 > 0)) {
      return `duck_delay FEEDBACK does not reach the DSP: tail energy fb0=${tail0.toExponential(3)} fb0.9=${tail9.toExponential(3)} (want fb0.9 > 10x fb0; observed 100x+ across runs)`;
    }
    // digital_delay heap probe: fVec2[524288] doubles = 4 MB per object,
    // news EAGERLY in fx_set_slot (dual-mono => 2 objects / 8 MB per slot).
    // The 256 MB initial heap carries a large free region (observed
    // ~240 MB post-init), so first exhaust it with 4 MB malloc pads until
    // the memory grows once — after that the free list holds < 4 MB plus
    // the growth-increment slack, and ~88 MB of DSP objects must show up as
    // real growth. 11 slots x 2 objects = 88 MB expected; the [32, 220] MB
    // window tolerates emscripten's ~64 MB growth granularity (1-2 extra
    // increments of slack) while catching both failure modes: a
    // non-allocating class (~0 growth) and unbounded per-object growth
    // (looper-scale 64 MB/object => ~1.4 GB).
    mod._obxd_init(48000);
    const pads = [];
    const sizeBeforePads = mod.HEAPU8.buffer.byteLength;
    for (;;) {
      const p = mod._malloc(4 * 1024 * 1024);
      pads.push(p);
      if (mod.HEAPU8.buffer.byteLength > sizeBeforePads) break; // grew => free space exhausted
    }
    const heapBefore = mod.HEAPU8.buffer.byteLength;
    for (let s = 0; s < 11; s++) mod._fx_set_slot(1, s, 47);
    const heapAfter = mod.HEAPU8.buffer.byteLength;
    const growth = heapAfter - heapBefore;
    for (const p of pads) mod._free(p);
    if (!(growth >= 32 * 1024 * 1024 && growth <= 220 * 1024 * 1024)) {
      return `digital_delay heap growth ${(growth / 1048576).toFixed(2)} MB for 11 slots outside the expected 32..220 MB window (fVec2[524288] x22)`;
    }
    // ...and the slots still render after the growth (views rebuild off the
    // NEW buffer — memory growth detaches the old one).
    mod._fx_set_enabled(1, 0, 1);
    mod._obxd_midi_in(1, 0x91, 60, 100);
    let s = 0;
    for (let q = 0; q < 20; q++) {
      mod._obxd_render(128);
      if (q < 5) continue;
      const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(1), 128);
      for (let i = 0; i < 128; i++) s += l[i] * l[i];
    }
    mod._obxd_midi_in(1, 0x81, 60, 0);
    mod._obxd_panic(1);
    if (!(s > 0)) return `digital_delay silent after heap growth (sum=${s.toExponential(3)})`;
    console.log(`    digital_delay heap growth: ${(growth / 1048576).toFixed(1)} MB for 11 slots (~${(growth / 11 / 1048576).toFixed(2)} MB/slot incl. growth-granularity slack; class cost 8 MB/slot dual-mono)`);
  });

  // (x) Reverb family spot check (Phase 1-f) ---------------------------------
  // Exercises every DSP shape of the family: the faust-generated zita_rev1
  // (native stereo), the freeverb orphan (mono, dual-mono pair), and the
  // bundle-LOCAL room_simulator (mono) + shimmizita (stereo) classes —
  // plain faust classes per fx2plan, NOT convolver-based. Renders prove the
  // wrapper-space PortIndex enums link; wet/dry sweeps on zita_rev1
  // (DRY_WET_MIX) and room_simulator (DRYWET) prove the generated FX_PORTS
  // rows reach the DSP. A sustained note through a full-wet room_simulator
  // also proves the tail rings past note-off (reverb decay), the insert's
  // tail-past-idle contract for the family.
  expect('x. reverb family: zita/freeverb/room_simulator/shimmizita render; wet/dry sweeps reach the DSP; tail rings past note-off', () => {
    const renderTrace = (fxId, setParams, quanta = 120, skip = 10) => {
      mod._obxd_init(48000); // fresh: default chain, slot 0 = wah
      mod._fx_set_slot(0, 0, fxId);
      if (mod._fx_get_slot(0, 0) !== fxId) return { err: `slot(0,0)=${mod._fx_get_slot(0, 0)}, want ${fxId}` };
      setParams.forEach(([p, v]) => mod._fx_set_param(0, 0, p, v));
      mod._fx_set_enabled(0, 0, 1);
      mod._obxd_midi_in(0, 0x90, 60, 100);
      let s = 0;
      let finite = true;
      const perQuantum = [];
      for (let q = 0; q < quanta; q++) {
        mod._obxd_render(128);
        if (q === quanta - 60) mod._obxd_midi_in(0, 0x80, 60, 0); // note off 60 quanta in
        if (q < skip) continue; // let the note settle
        const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
        const r = new Float32Array(mod.HEAPF32.buffer, mod._get_track_r_ptr(0), 128);
        let qs = 0;
        for (let i = 0; i < 128; i++) {
          if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) finite = false;
          qs += l[i] * l[i] + r[i] * r[i];
        }
        s += qs;
        perQuantum.push(Math.sqrt(qs / 256));
      }
      mod._obxd_panic(0);
      if (!finite) return { err: `non-finite sample through fx ${fxId}` };
      return { rms: Math.sqrt(s / ((quanta - skip) * 256)), perQuantum };
    };
    // default passes — the point is: wrapper PortIndex links, delay lines
    // link, output stays finite+alive
    for (const [fxId, name] of [
      [57, 'zita_rev1'], [58, 'freeverb'], [59, 'room_simulator'], [60, 'shimmizita'],
    ]) {
      const r = renderTrace(fxId, []);
      if (r.err) return `${name}: ${r.err}`;
      if (!(r.rms > 0)) return `${name} output silent (rms=${r.rms.toExponential(3)})`;
    }
    // zita_rev1 DRY_WET_MIX reach (param ordinal 9 = port 9, -1..1):
    // full-wet vs full-dry energy over a sustained note must differ.
    const zitaWet = renderTrace(57, [[9, 1]]);
    if (zitaWet.err) return zitaWet.err;
    const zitaDry = renderTrace(57, [[9, -1]]);
    if (zitaDry.err) return zitaDry.err;
    const wetR = zitaWet.rms / zitaDry.rms;
    if (!(wetR < 0.8 || wetR > 1.25)) {
      return `zita_rev1 DRY_WET_MIX does not reach the DSP: wet/dry rms ratio ${wetR.toFixed(3)} ~ 1`;
    }
    // room_simulator DRYWET reach (param ordinal 4 = port 6, 0..1):
    // full-wet vs dry-only. The whole-run rms ratio flaked (the engine's
    // random voice slop swings the sustained note's level run-to-run more
    // than the mix difference) — compare the TAIL region instead (last
    // quarter, after the note-off 60 quanta before the end): there the wet
    // render carries the room decay on top of the identical-ish release,
    // a 3x+ energy ratio across runs, while dry has only the release.
    const roomWet = renderTrace(59, [[4, 1], [3, 1]]);
    if (roomWet.err) return roomWet.err;
    const roomDry = renderTrace(59, [[4, 0], [3, 1]]);
    if (roomDry.err) return roomDry.err;
    const tailEnergyOf = (t) => {
      const n = t.perQuantum.length;
      return t.perQuantum.slice(n - (n >> 2)).reduce((x, y) => x + y * y, 0);
    };
    const wetTail = tailEnergyOf(roomWet);
    const dryTail = tailEnergyOf(roomDry);
    if (!(wetTail > 1.5 * dryTail)) {
      return `room_simulator DRYWET does not reach the DSP: wet/dry tail energy ${wetTail.toExponential(3)} vs ${dryTail.toExponential(3)} (want wet > 1.5x dry; observed 3x+ across runs)`;
    }
    // tail past note-off: with the note released 60 quanta before the end,
    // the full-wet room_simulator output must still carry energy in the
    // last quarter of the run (dry would be near-silent there).
    if (!(wetTail > 0)) {
      return `room_simulator wet tail dead after note-off (tailEnergy=${wetTail.toExponential(3)})`;
    }
    console.log(`    reverb wet/dry tail energy ratio: room_simulator ${(wetTail / dryTail).toFixed(2)} (well above 1 — the mix port reaches the DSP); zita_rev1 whole-run wet/dry rms ratio ${wetR.toFixed(3)}`);
  });

  // (y) Amp + tonestack family spot check (Phase 1-g) -------------------------
  // Exercises the two host-side aggregates (gxfx_dsp_amps.cpp): "Amp Model"
  // (id 61, 19 mono gxamp classes hot-swapped on MODEL param ordinal 4 =
  // port 9) and "Tone Stack" (id 62, 27 stereo classes on MODEL ordinal 3 =
  // port 10), plus the studiopre STEREO / alembic / w20 preamps. Amp model
  // differences are driven with the gains open (PreGain +12, Distortion 100,
  // Drive 1) so two tube stages differ audibly on a sustained note; the
  // tonestack comparison maxes the B/M/T knobs so two EQ curves differ.
  // Mid-render MODEL swaps walk both aggregates' full model ranges inside
  // ONE render pass — the hot-swap path (create + connect +
  // activate-if-active + destroy old) must stay finite and alive.
  expect('y. amp family: aggregates + preamps render; MODEL selects change the sound; params round-trip; mid-render swaps finite', () => {
    const renderTrace = (fxId, setParams, quanta = 120, skip = 10, onQuantum) => {
      mod._obxd_init(48000); // fresh: default chain, slot 0 = wah
      mod._fx_set_slot(0, 0, fxId);
      if (mod._fx_get_slot(0, 0) !== fxId) return { err: `slot(0,0)=${mod._fx_get_slot(0, 0)}, want ${fxId}` };
      setParams.forEach(([p, v]) => mod._fx_set_param(0, 0, p, v));
      mod._fx_set_enabled(0, 0, 1);
      mod._obxd_midi_in(0, 0x90, 60, 100);
      let s = 0;
      let finite = true;
      const perQuantum = [];
      for (let q = 0; q < quanta; q++) {
        if (onQuantum) onQuantum(q);
        mod._obxd_render(128);
        if (q === quanta - 60) mod._obxd_midi_in(0, 0x80, 60, 0); // note off 60 quanta in
        if (q < skip) continue; // let the note settle
        const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
        const r = new Float32Array(mod.HEAPF32.buffer, mod._get_track_r_ptr(0), 128);
        let qs = 0;
        for (let i = 0; i < 128; i++) {
          if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) finite = false;
          qs += l[i] * l[i] + r[i] * r[i];
        }
        s += qs;
        perQuantum.push(Math.sqrt(qs / 256));
      }
      mod._obxd_panic(0);
      if (!finite) return { err: `non-finite sample through fx ${fxId}` };
      return { rms: Math.sqrt(s / ((quanta - skip) * 256)), perQuantum };
    };
    // default renders — wrapper PortIndex links, tube tables link, finite
    for (const [fxId, name] of [
      [61, 'ampmodel'], [62, 'tonestack'], [63, 'studiopre'], [64, 'alembic'], [65, 'w20'],
    ]) {
      const r = renderTrace(fxId, []);
      if (r.err) return `${name}: ${r.err}`;
      if (!(r.rms > 0)) return `${name} output silent (rms=${r.rms.toExponential(3)})`;
    }
    // param round-trips for both aggregates (set/get over every param).
    // Fresh set_slot first — the renderTrace calls above end with
    // _obxd_init + w20 in slot 0, whose 2-param surface would no-op p>=2.
    for (const [fxId, name, n] of [[61, 'ampmodel', 6], [62, 'tonestack', 4]]) {
      mod._obxd_init(48000);
      mod._fx_set_slot(0, 0, fxId);
      for (let p = 0; p < n; p++) {
        mod._fx_set_param(0, 0, p, 0);
        if (mod._fx_get_param(0, 0, p) !== 0) return `${name} param ${p} round-trip 0 failed (${mod._fx_get_param(0, 0, p)})`;
        mod._fx_set_param(0, 0, p, 1.5);
        if (mod._fx_get_param(0, 0, p) !== 1.5) return `${name} param ${p} round-trip 1.5 failed (${mod._fx_get_param(0, 0, p)})`;
      }
    }
    // amp MODEL 0 (12ax7) vs 16 (12AU7 push-pull 6V6) must differ with the
    // gains open (params: PreGain +12 dB ordinal 1, Distortion 100 ordinal
    // 2, Drive 1 ordinal 3, MODEL ordinal 4)
    const ampOpen = [[1, 12], [2, 100], [3, 1]];
    const ampA = renderTrace(61, [...ampOpen, [4, 0]]);
    if (ampA.err) return `ampmodel m0: ${ampA.err}`;
    const ampB = renderTrace(61, [...ampOpen, [4, 16]]);
    if (ampB.err) return `ampmodel m16: ${ampB.err}`;
    let ampDiff = 0;
    for (let i = 0; i < ampA.perQuantum.length; i++)
      ampDiff = Math.max(ampDiff, Math.abs(ampA.perQuantum[i] - ampB.perQuantum[i]));
    if (!(ampDiff > 1e-4)) {
      return `ampmodel MODEL 0 vs 16 identical on a transient sweep (max per-quantum rms delta ${ampDiff.toExponential(3)})`;
    }
    // tonestack MODEL 0 (default) vs 26 (engl) must differ with B/M/T maxed
    const tsOpen = [[0, 1], [1, 1], [2, 1]];
    const tsA = renderTrace(62, [...tsOpen, [3, 0]]);
    if (tsA.err) return `tonestack m0: ${tsA.err}`;
    const tsB = renderTrace(62, [...tsOpen, [3, 26]]);
    if (tsB.err) return `tonestack m26: ${tsB.err}`;
    let tsDiff = 0;
    for (let i = 0; i < tsA.perQuantum.length; i++)
      tsDiff = Math.max(tsDiff, Math.abs(tsA.perQuantum[i] - tsB.perQuantum[i]));
    if (!(tsDiff > 1e-4)) {
      return `tonestack MODEL 0 vs 26 identical (max per-quantum rms delta ${tsDiff.toExponential(3)})`;
    }
    // mid-render MODEL swaps: walk every model of both aggregates inside
    // one render pass; output must stay finite and alive throughout
    for (const [fxId, name, modelOrdinal, modelCount] of [
      [61, 'ampmodel', 4, 19], [62, 'tonestack', 3, 27],
    ]) {
      const r = renderTrace(fxId, [], 200, 10, (q) => {
        if (q % 3 === 0) mod._fx_set_param(0, 0, modelOrdinal, (q / 3) % modelCount);
      });
      if (r.err) return `${name} mid-render swaps: ${r.err}`;
      if (!(r.rms > 0)) return `${name} silent across mid-render model swaps (rms=${r.rms.toExponential(3)})`;
    }
    console.log(`    amp/tonestack MODEL selectivity: amp 0↔16 max rms delta ${ampDiff.toFixed(4)}, tonestack 0↔26 ${tsDiff.toFixed(4)}; both aggregates survive ${19 + 27} mid-render swaps`);
  });

  // (z) Convolution family spot check (Phase 2-a) ---------------------------
  // Cabinet (id 76) over the self-written partitioned convolver: params
  // round-trip through the mirror, a held note through CAB=0 (4x12,
  // 1000-tap IR) vs CAB=5 (HighGain, 192-tap) produces measurably different
  // output (~66% RMS delta measured; the two IRs filter very differently —
  // an unwired c_model would leave the ratio at ~1.00), the CLevel knob
  // (baked into the IR by the bundle's Impf impulse former, including its
  // level-dependent makeup) audibly scales the output, model "Off" (18) is
  // dry passthrough, and walking ALL 19 models mid-render (one pending
  // rebuild per quantum — the bounded-alloc path) stays finite and alive.
  // The default factory patch is a pad whose per-init LFO phase swings
  // short-window RMS by tens of percent, which drowns the IR delta — so the
  // comparison loads factory patch 6 ("Acoustic Bass"), measured stable to
  // ~1-2% across inits (same reason check s/t use early settled windows).
  expect('z. conv family: cabinet IR switch CAB=0 vs CAB=5 changes the response; CLevel scales; params round-trip; model walk finite', () => {
    // param round-trip: set/get over all 4 ordinals (CLevel/CBass/CTreble/c_model)
    mod._obxd_init(48000);
    mod._fx_set_slot(0, 0, 76);
    if (mod._fx_get_slot(0, 0) !== 76) return `slot(0,0)=${mod._fx_get_slot(0, 0)}, want 76 (cabinet)`;
    for (const [p, v] of [[0, 2.5], [1, -6], [2, 3], [3, 7]]) {
      mod._fx_set_param(0, 0, p, v);
      if (mod._fx_get_param(0, 0, p) !== f32(v)) return `param ${p} round-trip=${mod._fx_get_param(0, 0, p)}, want ${f32(v)}`;
    }
    // Sustained note through the convolver, stable patch, fresh init per
    // measurement (fuzzface-check shape; ~1-2% cross-init drift).
    const cabRms = (model, level = 1, note = 48, skip = 25, meas = 15) => {
      mod._obxd_init(48000);
      mod._obxd_set_factory_patch(0, 6); // "Acoustic Bass" — init-stable
      mod._fx_set_slot(0, 0, 76);
      mod._fx_set_param(0, 0, 0, level); // CLevel
      mod._fx_set_param(0, 0, 3, model); // c_model
      mod._fx_set_enabled(0, 0, 1);
      mod._obxd_midi_in(0, 0x90, note, 127);
      let s = 0;
      let finite = true;
      for (let q = 0; q < skip + meas; q++) {
        mod._obxd_render(128);
        if (q < skip) continue;
        const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
        const r = new Float32Array(mod.HEAPF32.buffer, mod._get_track_r_ptr(0), 128);
        for (let i = 0; i < 128; i++) {
          if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) finite = false;
          s += l[i] * l[i] + r[i] * r[i];
        }
      }
      mod._obxd_midi_in(0, 0x80, note, 0);
      mod._obxd_panic(0);
      if (!finite) return { err: `non-finite sample through cabinet (model ${model})` };
      return { rms: Math.sqrt(s / (meas * 256)) };
    };
    const r0 = cabRms(0);
    if (r0.err) return r0.err;
    const r5 = cabRms(5);
    if (r5.err) return r5.err;
    if (!(r0.rms > 1e-4)) return `cabinet CAB=0 output too quiet to test (rms=${r0.rms.toExponential(3)})`;
    const rel = Math.abs(r0.rms - r5.rms) / Math.max(r0.rms, r5.rms);
    if (!(rel > 0.25)) {
      return `cabinet IR switch 0↔5 changed RMS by only ${(rel * 100).toFixed(1)}% (${r0.rms.toExponential(4)} vs ${r5.rms.toExponential(4)}) — c_model not reaching the convolver`;
    }
    // CLevel 0.5 vs 5.0 (model 0): Impf bakes level·10^(-0.1·level) into
    // the IR — 0.397 vs 1.581 ≈ 4x amplitude. Assert a clear scaling with
    // margin for the shared shelving.
    const lo = cabRms(0, 0.5);
    if (lo.err) return lo.err;
    const hi = cabRms(0, 5.0);
    if (hi.err) return hi.err;
    const levelRatio = hi.rms / lo.rms;
    if (!(levelRatio > 1.5)) {
      return `cabinet CLevel 0.5→5.0 scaled RMS by only ${levelRatio.toFixed(2)}x (${lo.rms.toExponential(4)} → ${hi.rms.toExponential(4)}) — CLevel not reaching the IR bake`;
    }
    // Model walk 0..18 inside one render: a pending rebuild per quantum
    // (incl. Off at 18 — passthrough) must stay finite and audible.
    mod._obxd_init(48000);
    mod._obxd_set_factory_patch(0, 6);
    mod._fx_set_slot(0, 0, 76);
    mod._fx_set_enabled(0, 0, 1);
    mod._obxd_midi_in(0, 0x90, 48, 127);
    let walkSq = 0;
    let walkFinite = true;
    for (let m = 0; m <= 18; m++) {
      mod._fx_set_param(0, 0, 3, m);
      for (let k = 0; k < 6; k++) {
        mod._obxd_render(128);
        const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
        const r = new Float32Array(mod.HEAPF32.buffer, mod._get_track_r_ptr(0), 128);
        for (let i = 0; i < 128; i++) {
          if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) walkFinite = false;
          walkSq += l[i] * l[i] + r[i] * r[i];
        }
      }
    }
    mod._obxd_midi_in(0, 0x80, 48, 0);
    mod._obxd_panic(0);
    if (!walkFinite) return 'non-finite sample during the cabinet model walk';
    if (!(Math.sqrt(walkSq / (19 * 6 * 256)) > 1e-4)) return 'cabinet model walk silent';
    console.log(`    cabinet IR selectivity: CAB 0↔5 rms ${r0.rms.toExponential(4)} vs ${r5.rms.toExponential(4)} (${(rel * 100).toFixed(1)}% delta); CLevel 0.5→5.0 scales ${levelRatio.toFixed(2)}x; 19-model walk finite`);
  });

  // (z2) Phase 2-b convolver family: redeye aggregate + metal amp/head ------
  // Redeye (id 77) folds gx_redeye.lv2's three descriptors (chump/bigchump/
  // vibrochump preamps, each with its FIXED speaker IR: 1x8 / 2x12 / 2x12,
  // scaled ×0.01 per upstream's Impf(1.0)) into MODEL 0..2. Checked: param
  // round-trip incl. MODEL, MODEL 0 vs 2 produce different RMS on a
  // DETERMINISTIC LCG ramp through the real slot runtime
  // (fx_test_slot_rms — fx_set_param's mirror row → connected MODEL pointer
  // → per-block aggregate swap → cab IR re-push → convolver; a synth-fed
  // A/B flaked in CI because per-init juce::Random voice slop deflated the
  // MODEL delta to 9.6% against the 25% gate), mid-render model swaps stay
  // finite/alive. Metal amp (id 78) wraps the faust preamp + FIXED 4x12 cab
  // (no cab param upstream — the cabinet effect's c_model check covers IR
  // switching): params round-trip, the wet (enabled) vs bypassed (disabled)
  // RMS delta — also on the deterministic ramp — proves the preamp+IR chain
  // is in the audio path, and the DRIVE knob changes the output. Metal head
  // (id 79) gets the surface round-trip.
  expect('z2. conv family: redeye MODEL 0 vs 2 differ; model swaps finite; metal amp wet/DRIVE respond; params round-trip', () => {
    // param round-trips
    mod._obxd_init(48000);
    mod._fx_set_slot(0, 0, 77);
    for (const [p, v] of [[0, 0.7], [3, 1], [5, 7.5], [8, 2]]) {
      mod._fx_set_param(0, 0, p, v);
      if (mod._fx_get_param(0, 0, p) !== f32(v)) return `redeye param ${p} round-trip=${mod._fx_get_param(0, 0, p)}, want ${f32(v)}`;
    }
    mod._fx_set_slot(0, 0, 78);
    for (const [p, v] of [[0, 0.8], [1, 15], [2, -6], [3, 4]]) {
      mod._fx_set_param(0, 0, p, v);
      if (mod._fx_get_param(0, 0, p) !== f32(v)) return `metalamp param ${p} round-trip=${mod._fx_get_param(0, 0, p)}, want ${f32(v)}`;
    }
    mod._fx_set_slot(0, 0, 79);
    for (const [p, v] of [[0, 0.3], [1, 0.9], [2, 12], [3, -3]]) {
      mod._fx_set_param(0, 0, p, v);
      if (mod._fx_get_param(0, 0, p) !== f32(v)) return `metalhead param ${p} round-trip=${mod._fx_get_param(0, 0, p)}, want ${f32(v)}`;
    }
    // redeye MODEL 0 (chump + 1x8) vs 2 (vibrochump + 2x12) on the
    // deterministic ramp (the redeye IR rides upstream's ×0.01 Impf scale,
    // so its floor is 1e-4, not the cabinet's dry-signal scale)
    mod._fx_set_slot(0, 0, 77);
    mod._fx_set_enabled(0, 0, 1);
    mod._fx_set_param(0, 0, 8, 0);
    const rd0 = mod._fx_test_slot_rms(0, 0);
    mod._fx_set_param(0, 0, 8, 2);
    const rd2 = mod._fx_test_slot_rms(0, 0);
    if (!(rd0 > 1e-4)) return `redeye MODEL=0 too quiet to test (rms=${rd0.toExponential(3)})`;
    if (!(rd2 > 1e-4)) return `redeye MODEL=2 too quiet to test (rms=${rd2.toExponential(3)})`;
    const rdRel = Math.abs(rd0 - rd2) / Math.max(rd0, rd2);
    if (!(rdRel > 0.25)) {
      return `redeye MODEL 0↔2 changed ramp RMS by only ${(rdRel * 100).toFixed(1)}% (${rd0.toExponential(4)} vs ${rd2.toExponential(4)}) — MODEL not reaching the aggregate`;
    }
    // redeye mid-render model swaps (preamp swap + cab IR re-push per quantum)
    mod._obxd_init(48000);
    mod._obxd_set_factory_patch(0, 6);
    mod._fx_set_slot(0, 0, 77);
    mod._fx_set_enabled(0, 0, 1);
    mod._obxd_midi_in(0, 0x90, 48, 127);
    let rdSq = 0;
    let rdFinite = true;
    for (const m of [0, 1, 2, 0]) {
      mod._fx_set_param(0, 0, 8, m);
      for (let k = 0; k < 6; k++) {
        mod._obxd_render(128);
        const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
        const r = new Float32Array(mod.HEAPF32.buffer, mod._get_track_r_ptr(0), 128);
        for (let i = 0; i < 128; i++) {
          if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) rdFinite = false;
          rdSq += l[i] * l[i] + r[i] * r[i];
        }
      }
    }
    mod._obxd_midi_in(0, 0x80, 48, 0);
    mod._obxd_panic(0);
    if (!rdFinite) return 'non-finite sample during the redeye model swap walk';
    if (!(Math.sqrt(rdSq / (4 * 6 * 256)) > 1e-6)) return 'redeye model swap walk silent';
    // metal amp on the deterministic ramp: wet (enabled) vs bypassed (a
    // disabled slot returns the dry ramp RMS, mirroring the chain bypass)
    // proves the preamp+4x12 IR chain is in the audio path; DRIVE 1 vs 20
    // proves the params reach the DSP
    mod._fx_set_slot(0, 0, 78);
    mod._fx_set_enabled(0, 0, 1);
    mod._fx_set_param(0, 0, 1, 1);
    const mDriveLo = mod._fx_test_slot_rms(0, 0);
    mod._fx_set_param(0, 0, 1, 20);
    const mDriveHi = mod._fx_test_slot_rms(0, 0);
    mod._fx_set_enabled(0, 0, 0);
    const mdry = mod._fx_test_slot_rms(0, 0);
    if (!(mDriveLo > 1e-4)) return `metal amp wet output too quiet to test (rms=${mDriveLo.toExponential(3)})`;
    const mRel = Math.abs(mDriveLo - mdry) / Math.max(mDriveLo, mdry);
    if (!(mRel > 0.25)) {
      return `metal amp wet vs bypassed changed ramp RMS by only ${(mRel * 100).toFixed(1)}% (${mDriveLo.toExponential(4)} vs ${mdry.toExponential(4)}) — preamp/IR chain not in the path`;
    }
    const dRel = Math.abs(mDriveLo - mDriveHi) / Math.max(mDriveLo, mDriveHi);
    if (!(dRel > 0.25)) {
      return `metal amp DRIVE 1↔20 changed ramp RMS by only ${(dRel * 100).toFixed(1)}% (${mDriveLo.toExponential(4)} vs ${mDriveHi.toExponential(4)}) — DRIVE not reaching the preamp`;
    }
    console.log(`    redeye selectivity (deterministic ramp): MODEL 0↔2 rms ${rd0.toExponential(4)} vs ${rd2.toExponential(4)} (${(rdRel * 100).toFixed(1)}% delta); swap walk finite; metal amp wet/bypassed ${(mRel * 100).toFixed(1)}% delta, DRIVE 1↔20 ${(dRel * 100).toFixed(1)}% delta`);
  });

  // (z3) Phase 2-c: detune (id 80) — smbPitchShift over the fftw shim ------
  // A sustained bass note (Acoustic Bass patch, MIDI 48 → 130.8 Hz; its
  // spectrum is a full harmonic series on ~32.7 Hz), WET 100 / DRY 0,
  // probed with a phase-independent single-bin DFT (correlate against cos
  // AND sin at the probe frequency, magnitude = hypot). DETUNE=+5 st
  // (ratio 2^(5/12) ≈ 1.335 — deliberately NOT an octave/fifth: the patch's
  // harmonic series would map onto itself and fake residuals) must move
  // f0's energy to F* = f0·ratio ≈ 174.6 Hz, which sits BETWEEN the input
  // partials (163.5 / 196.2): base@F* is the noise floor, shifted@F*
  // ~8.5× that, and f0 drops to ~15%. The ~0.4 s probe window dwarfs the
  // vocoder latency (512-frame FIFO at the internal 12 k rate ≈ 37 ms) and
  // its 2.5 Hz resolution separates the probe from the partial grid. Also:
  // a LATENCY quality walk 0→2→1→0 mid-render exercises the INLINED
  // plan-rebuild path (upstream's LV2 worker → change_latency: mem_free +
  // mem_alloc) — every rebuild must stay finite and audible.
  expect('z3. detune: +5 st moves a sustained tone (DFT probe f0 vs f0·2^(5/12)); LATENCY rebuild walk finite; params round-trip', () => {
    // param round-trip: all 10 ordinals (DETUNE..TREBLE, ttl ports 2..11)
    mod._obxd_init(48000);
    mod._fx_set_slot(0, 0, 80);
    if (mod._fx_get_slot(0, 0) !== 80) return `slot(0,0)=${mod._fx_get_slot(0, 0)}, want 80 (detune)`;
    for (const [p, v] of [[0, 5.5], [1, 2], [2, 1], [3, 1], [4, 100], [5, 0], [6, 1.5], [7, 0.25], [8, 1.75], [9, 0]]) {
      mod._fx_set_param(0, 0, p, v);
      if (mod._fx_get_param(0, 0, p) !== f32(v)) return `detune param ${p} round-trip=${mod._fx_get_param(0, 0, p)}, want ${f32(v)}`;
    }
    const F0 = 130.81278265398093; // MIDI 48 at A4=440
    const FS = F0 * Math.pow(2, 5 / 12); // ≈ 174.61 Hz — between input partials
    const probe = (y, f) => {
      let rc = 0, rs = 0;
      const w = 2 * Math.PI * f / 48000;
      for (let i = 0; i < y.length; i++) { rc += y[i] * Math.cos(w * i); rs += y[i] * Math.sin(w * i); }
      return Math.sqrt(rc * rc + rs * rs) * (2 / y.length);
    };
    // One render per detune amount; mono-sum L+R (dual-mono detune chains).
    const render = (detuneSt) => {
      mod._obxd_init(48000);
      mod._obxd_set_factory_patch(0, 6); // "Acoustic Bass" — init-stable
      mod._fx_set_slot(0, 0, 80);
      mod._fx_set_param(0, 0, 4, 100); // WET 100
      mod._fx_set_param(0, 0, 5, 0);   // DRY 0
      mod._fx_set_param(0, 0, 0, detuneSt);
      mod._fx_set_enabled(0, 0, 1);
      mod._obxd_midi_in(0, 0x90, 48, 127);
      const y = [];
      let finite = true;
      let sq = 0;
      for (let q = 0; q < 60 + 150; q++) {
        mod._obxd_render(128);
        if (q < 60) continue; // vocoder FIFO latency + note settle (~160 ms)
        const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
        const r = new Float32Array(mod.HEAPF32.buffer, mod._get_track_r_ptr(0), 128);
        for (let i = 0; i < 128; i++) {
          if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) finite = false;
          const m = 0.5 * (l[i] + r[i]);
          y.push(m);
          sq += m * m;
        }
      }
      mod._obxd_midi_in(0, 0x80, 48, 0);
      mod._obxd_panic(0);
      if (!finite) return { err: `non-finite sample through detune (+${detuneSt} st)` };
      return { f0: probe(y, F0), fs: probe(y, FS), rms: Math.sqrt(sq / y.length) };
    };
    const base = render(0);
    if (base.err) return base.err;
    const shift = render(5);
    if (shift.err) return shift.err;
    if (!(base.rms > 1e-4)) return `detune +0 output too quiet to test (rms=${base.rms.toExponential(3)})`;
    if (!(shift.rms > 1e-4)) return `detune +5 output too quiet to test (rms=${shift.rms.toExponential(3)})`;
    if (!(base.f0 > 1e-2)) return `unshifted f0 probe too weak (${base.f0.toExponential(3)}) — patch/note changed?`;
    // Energy LEFT f0 (falls to ~15% measured; < 50% with margin) and
    // APPEARED at F* (> 30% of f0's original level, measured ~40-55%;
    // ratio=1 or a wrong shift amount leaves F* at the ~6e-3 noise floor).
    // Noisy ratio assertion vs the F* floor deliberately avoided: the
    // floor varies ~1.5x across inits and flaked a fixed >4x gate.
    if (!(shift.f0 < 0.5 * base.f0)) {
      return `+5 st left f0 at ${(shift.f0 / base.f0 * 100).toFixed(1)}% of its level (${base.f0.toExponential(3)} → ${shift.f0.toExponential(3)}) — no shift`;
    }
    if (!(shift.fs > 0.3 * base.f0)) {
      return `+5 st did not move energy to ${FS.toFixed(1)} Hz: floor ${base.fs.toExponential(3)} → ${shift.fs.toExponential(3)}, want > 0.3*f0 (${(0.3 * base.f0).toExponential(3)}) — DETUNE not reaching the vocoder`;
    }
    // LATENCY quality walk mid-render: every inline plan rebuild must stay
    // finite and audible (upstream's worker path, now on the audio thread).
    mod._obxd_init(48000);
    mod._obxd_set_factory_patch(0, 6);
    mod._fx_set_slot(0, 0, 80);
    mod._fx_set_param(0, 0, 4, 100);
    mod._fx_set_param(0, 0, 5, 0);
    mod._fx_set_enabled(0, 0, 1);
    mod._obxd_midi_in(0, 0x90, 48, 127);
    let walkSq = 0;
    let walkFinite = true;
    for (const quality of [0, 2, 1, 0]) {
      mod._fx_set_param(0, 0, 3, quality); // LATENCY (rebuild trigger)
      for (let k = 0; k < 8; k++) {
        mod._obxd_render(128);
        const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
        const r = new Float32Array(mod.HEAPF32.buffer, mod._get_track_r_ptr(0), 128);
        for (let i = 0; i < 128; i++) {
          if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) walkFinite = false;
          walkSq += l[i] * l[i] + r[i] * r[i];
        }
      }
    }
    mod._obxd_midi_in(0, 0x80, 48, 0);
    mod._obxd_panic(0);
    if (!walkFinite) return 'non-finite sample during the detune LATENCY rebuild walk';
    if (!(Math.sqrt(walkSq / (4 * 8 * 256)) > 1e-4)) return 'detune LATENCY rebuild walk silent';
    console.log(`    detune shift: +5 st moves f0 → F* ${FS.toFixed(1)} Hz (${base.fs.toExponential(3)} → ${shift.fs.toExponential(3)}, ${(shift.fs / Math.max(base.fs, 1e-12)).toFixed(1)}x); f0 falls to ${(shift.f0 / base.f0 * 100).toFixed(1)}%; LATENCY rebuild walk finite`);
  });

  // (z4) Phase 2-d: tuner (id 81) — inline NSDF pitch tracker + the FIRST
  // real out_ports consumer ----------------------------------------------
  // The FREQ control output port is connected into g_fx_out[0][0][0]; a
  // sustained A4 must read ≈440 Hz via fx_get_out_param after the ~100 ms
  // analysis cadence. Source: factory patch 8 plays exactly one octave
  // below the MIDI note (empirically verified: note 69 → 220, note 76 →
  // 330), so note 81 (A5) sounds A4 = 440 as its strongest periodicity —
  // verified stable at 440.1±0.1 across runs. Transparency
  // is proven by the engine's own deterministic self-test export
  // (fx_test_bittransparent — a synth-fed A/B cannot work: the engine
  // reseeds per-voice noise from std::rand() at every note-on, so no two
  // renders are ever bit-equal), cross-checked against a control effect
  // the harness must flag as non-transparent. Silence must return the
  // tracker to 0 (level gate), and both params must round-trip.
  expect('z4. tuner: tracks A4 440±1 via fx_get_out_param; bit-transparent (self-test); silence resets to 0; params round-trip', () => {
    // param round-trip (ordinals 0/1 = REFFREQ port 1 / THRESHOLD port 4)
    mod._obxd_init(48000);
    mod._fx_set_slot(0, 0, 81);
    if (mod._fx_get_slot(0, 0) !== 81) return `slot(0,0)=${mod._fx_get_slot(0, 0)}, want 81 (tuner)`;
    for (const [p, v] of [[0, 442.5], [1, -35.5]]) {
      mod._fx_set_param(0, 0, p, v);
      if (mod._fx_get_param(0, 0, p) !== f32(v)) return `tuner param ${p} round-trip=${mod._fx_get_param(0, 0, p)}, want ${f32(v)}`;
    }
    if (mod._fx_get_out_param(0, 0, 0) !== 0) return `out_param before signal = ${mod._fx_get_out_param(0, 0, 0)}, want 0`;
    if (mod._fx_get_out_param(0, 0, 8) !== 0) return 'out_param index 8 accepted (want 0, out of range)';
    // transparency: deterministic in-place ramp through one tuner DSP —
    // the tuner's analysis may only READ the buffer. Control: distortion
    // (id 2) must modify it, proving the harness detects non-transparency.
    const t = mod._fx_test_bittransparent(81);
    if (t !== 0) return `tuner modified sample ${t - 1} of the passthrough ramp (want bit-identical)`;
    if (!(mod._fx_test_bittransparent(2) > 0)) return 'control effect (distortion, id 2) passed the transparency self-test — harness broken';
    // detection: patch 8 note 81 (sounds A4) sustained for 500 quanta ≈
    // 1.33 s (≥ 12 analysis passes); the settled final value must be 440 ±1.
    mod._obxd_init(48000);
    mod._obxd_set_factory_patch(0, 8);
    mod._fx_set_slot(0, 0, 81);
    mod._fx_set_enabled(0, 0, 1);
    mod._obxd_midi_in(0, 0x90, 81, 100);
    const y = [];
    for (let q = 0; q < 500; q++) {
      mod._obxd_render(128);
      if (q >= 60) {
        const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
        for (let i = 0; i < 128; i++) y.push(l[i]);
      }
    }
    const lastFreq = mod._fx_get_out_param(0, 0, 0);
    if (!(lastFreq >= 439 && lastFreq <= 441)) {
      return `tuner FREQ settled at ${lastFreq}, want 440 ±1 (A4 via patch 8 note 81)`;
    }
    // cross-check against the render's actual fundamental (3-bin parabolic
    // DFT peak near 440) — proves the tracker locks the real pitch, not a
    // lucky constant.
    const N = y.length;
    const binMag = (k) => {
      let rc = 0, rs = 0;
      for (let i = 0; i < N; i++) { const w = 2 * Math.PI * k * i / N; rc += y[i] * Math.cos(w); rs += y[i] * Math.sin(w); }
      return Math.sqrt(rc * rc + rs * rs);
    };
    const k0 = Math.round(440 * N / 48000);
    const a = Math.log(binMag(k0 - 1) + 1e-12), b = Math.log(binMag(k0) + 1e-12), c = Math.log(binMag(k0 + 1) + 1e-12);
    const delta = 0.5 * (a - c) / (a - 2 * b + c);
    const dftFreq = (k0 + delta) * 48000 / N;
    if (Math.abs(dftFreq - 440) > 0.5) {
      return `probe fundamental ${dftFreq.toFixed(2)} Hz, want 440±0.5 (patch/note changed?)`;
    }
    if (Math.abs(lastFreq - dftFreq) > 1) {
      return `tuner FREQ ${lastFreq} vs DFT fundamental ${dftFreq.toFixed(2)} — not tracking the tone`;
    }
    // silence gate: after the note-off + panic the chain input is exactly
    // zero (engine idle memset); the next analysis pass must clear FREQ.
    mod._obxd_midi_in(0, 0x80, 81, 0);
    mod._obxd_panic(0);
    for (let q = 0; q < 120; q++) mod._obxd_render(128); // ≥ 2 cadence passes of silence
    const silentFreq = mod._fx_get_out_param(0, 0, 0);
    if (silentFreq !== 0) return `tuner FREQ after 320 ms of silence = ${silentFreq}, want 0 (level gate)`;
    console.log(`    tuner: FREQ ${lastFreq.toFixed(2)} Hz (DFT probe ${dftFreq.toFixed(2)} Hz), bit-transparent self-test 0, silence reset OK`);
  });

  // (z5) Phase 3: live looper (id 82) — record → play round trip over the
  // 64 MiB lazy tapes ------------------------------------------------------
  // Audible input comes from a synth note (fx_test_bittransparent's
  // deterministic ramp cannot work here — the looper must WRITE its
  // input; the tuner precedent used it only because the tuner is
  // read-only). Tape-path gains (faust math): the record side's one-pole
  // smoother fRec0 = s + 0.999·fRec0 has 1000× DC gain with s = 0.001·
  // 10^(gain/20), i.e. effective record gain = 10^(gain_dB/20); playback
  // scales by 1e-4·mix·level → net ≈ 10^(gain/20)·mix·level/10⁴ (defaults
  // gain 0 / level 50 / mix 100 → ≈0.5× — already audible; gain/level are
  // still pinned max for headroom). Meters are read via fx_get_out_param:
  // bar1 (out 0) = REMAINING record time in seconds (TAPESIZE·fConst2 ≈
  // 87.38 at 48 k, decreasing while rec1 is on), playh1 (out 4) =
  // play-head per-mille (held at 0 while rec1 is on, then advancing).
  // NOTE: rec1 must be armed AFTER the activation render — the ctor
  // leaves the rectime* members uninitialized, and the first compute's
  // `record1 = rectime0 ? record1 : 0.0` would zero a pre-armed rec flag
  // through the mirror (observed: bar stuck at 87.381). The activation
  // heap probe pins the documented lazy cost: 2 × 4 tapes × TAPESIZE
  // 4194304 floats (16 MiB each) = 128 MiB on the first render after
  // enable (dual-mono pair), bounded.
  expect('z5. looper: rec meters advance, play meters advance, played-back output non-silent (and silent when play stops); activation heap ≈ 128 MB bounded; params round-trip', () => {
    // param round-trip across the param kinds (clip %, gain dB, level %,
    // mix %, toggles incl. the keepPorts-rescued reset/rback triggers)
    mod._obxd_init(48000);
    mod._fx_set_slot(0, 0, 82);
    if (mod._fx_get_slot(0, 0) !== 82) return `slot(0,0)=${mod._fx_get_slot(0, 0)}, want 82 (livelooper)`;
    if (mod._fx_is_stereo(82) !== 0) return `is_stereo(82)=${mod._fx_is_stereo(82)}, want 0 (mono, dual-mono host)`;
    for (const [p, v] of [[0, 55], [12, 11.5], [13, 77], [17, 133], [18, 1], [26, 1], [30, 1], [34, 1], [38, 1]]) {
      mod._fx_set_param(0, 0, p, v);
      if (mod._fx_get_param(0, 0, p) !== f32(v)) return `looper param ${p} round-trip=${mod._fx_get_param(0, 0, p)}, want ${f32(v)}`;
    }
    // --- record phase: bar1 must burn down from the full ~87.38 s ------
    mod._obxd_init(48000); // fresh (slot 0 = wah default chain, all disabled)
    mod._fx_set_slot(0, 0, 82);
    mod._fx_set_param(0, 0, 12, 12);  // gain 12 dB (max) — record gain ≈ 4×
    mod._fx_set_param(0, 0, 13, 100); // level1 max
    mod._fx_set_param(0, 0, 17, 100); // mix 100 (default, explicit)
    mod._fx_set_enabled(0, 0, 1);
    mod._obxd_render(128); // ACTIVATION render: populates the rectime* members
    // (their ctor leaves them uninitialized — clear_state_f does not touch
    // them — so the first compute's `record1 = rectime0 ? record1 : 0.0`
    // would zero a pre-armed rec flag through the mirror. Arm rec AFTER
    // activation, like pressing RECORD on a running looper.)
    mod._fx_set_param(0, 0, 26, 1);   // rec1 on
    mod._obxd_midi_in(0, 0x90, 60, 100);
    let barEarly = 0;
    for (let q = 0; q < 200; q++) {
      mod._obxd_render(128);
      if (q === 5) barEarly = mod._fx_get_out_param(0, 0, 0);
    }
    const barLate = mod._fx_get_out_param(0, 0, 0);
    const full = 4194304 / 48000; // TAPESIZE·fConst2 = 87.383 s of tape
    if (!(barEarly > full - 0.2 && barEarly <= full + 0.01)) {
      return `looper bar1 early = ${barEarly}, want ≈${full.toFixed(2)} s (tape starts empty each session — sndfile stub)`;
    }
    if (!(barLate < barEarly - 0.4 && barLate > 80)) {
      return `looper bar1 did not burn down while recording: ${barEarly.toFixed(3)} → ${barLate.toFixed(3)} s (200 quanta ≈ 0.53 s of tape)`;
    }
    // --- playback phase: silence the synth, flip rec→play ---------------
    mod._obxd_midi_in(0, 0x80, 60, 0);
    mod._obxd_panic(0);
    mod._fx_set_param(0, 0, 26, 0); // rec1 off — playh meters go live
    mod._fx_set_param(0, 0, 18, 1); // play1 on
    for (let q = 0; q < 30; q++) mod._obxd_render(128);
    const playhA = mod._fx_get_out_param(0, 0, 4);
    for (let q = 0; q < 30; q++) mod._obxd_render(128);
    const playhB = mod._fx_get_out_param(0, 0, 4);
    if (!(playhA > 10 && playhB > playhA + 50)) {
      return `looper playh1 not advancing during playback: ${playhA.toFixed(1)}‰ → ${playhB.toFixed(1)}‰ (want e.g. 150 → 300 over 60 quanta)`;
    }
    // played-back output non-silent with the synth idle (energy = tape)
    let playEnergy = 0;
    let finite = true;
    for (let q = 0; q < 100; q++) {
      mod._obxd_render(128);
      const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
      const r = new Float32Array(mod.HEAPF32.buffer, mod._get_track_r_ptr(0), 128);
      for (let i = 0; i < 128; i++) {
        if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) finite = false;
        playEnergy += l[i] * l[i] + r[i] * r[i];
      }
    }
    if (!finite) return 'non-finite sample through the looper playback';
    if (!(playEnergy > 1e-5)) return `looper playback silent (energy=${playEnergy.toExponential(3)}) — tape did not capture the note`;
    // control: play1 off → the idle chain output must be exactly dry-zero
    // (dry term = input × gain-scaled ramp, input 0), proving the energy
    // above was the tape, not a lingering synth tail.
    mod._fx_set_param(0, 0, 18, 0);
    let floor = 0;
    for (let q = 0; q < 40; q++) {
      mod._obxd_render(128);
      const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
      const r = new Float32Array(mod.HEAPF32.buffer, mod._get_track_r_ptr(0), 128);
      for (let i = 0; i < 128; i++) floor += l[i] * l[i] + r[i] * r[i];
    }
    if (!(floor < playEnergy / 1000)) {
      return `looper output does not stop with play off: floor=${floor.toExponential(3)} vs playback=${playEnergy.toExponential(3)}`;
    }
    // --- activation heap probe (digital_delay precedent): with the free
    // region exhausted, enabling a looper slot on instance 1 must grow
    // the heap by the lazy tape cost — 2 DSP × 4 × 16 MiB = 128 MiB, plus
    // growth-granularity slack — and the slot still renders afterwards.
    mod._fx_set_param(0, 0, 18, 1); // keep instance 0 playing (harmless)
    const sizeBeforePads = mod.HEAPU8.buffer.byteLength;
    const pads = [];
    for (;;) {
      const p = mod._malloc(4 * 1024 * 1024);
      pads.push(p);
      if (mod.HEAPU8.buffer.byteLength > sizeBeforePads) break; // grew => free space exhausted
    }
    const heapBefore = mod.HEAPU8.buffer.byteLength;
    mod._fx_set_slot(1, 0, 82);
    mod._fx_set_enabled(1, 0, 1);
    let s = 0;
    for (let q = 0; q < 20; q++) {
      mod._obxd_render(128); // first render activates: 2 × mem_alloc(4 × 16 MiB) + clear
      if (q < 5) continue;
      const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(1), 128);
      for (let i = 0; i < 128; i++) s += l[i] * l[i];
    }
    const heapAfter = mod.HEAPU8.buffer.byteLength;
    const growth = heapAfter - heapBefore;
    for (const p of pads) mod._free(p);
    if (!(growth >= 64 * 1024 * 1024 && growth <= 224 * 1024 * 1024)) {
      return `looper activation heap growth ${(growth / 1048576).toFixed(2)} MB outside the expected 64..224 MB window (2 DSP × 4 tapes × 16 MB; the digital_delay-style pad probe under-counts when the pad-induced growth leaves free slack — observed ~88 MB for the 128 MB class cost)`;
    }
    if (!Number.isFinite(s)) return 'non-finite sample from instance 1 after looper heap growth';
    console.log(`    looper: bar1 ${barEarly.toFixed(2)} → ${barLate.toFixed(2)} s while recording; playh1 ${playhA.toFixed(0)}‰ → ${playhB.toFixed(0)}‰; playback energy ${playEnergy.toExponential(2)} vs stopped floor ${floor.toExponential(2)}; activation heap growth ${(growth / 1048576).toFixed(1)} MB (2 DSP × 64 MB tapes)`);
  });

  // --- summary -------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`error: unexpected failure: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});

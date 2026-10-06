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
    if (mod._fx_effect_count() !== 38) return `effect_count=${mod._fx_effect_count()}, want 38 (11 v1 + 17 drive/dynamics + 6 eq + 4 wah)`;
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
    if (mod._fx_param_count(38) !== -1) return `param_count(38)=${mod._fx_param_count(38)}, want -1 (out of range)`;
    if (mod._fx_is_stereo(4) !== 1) return `is_stereo(4)=${mod._fx_is_stereo(4)}, want 1 (chorus)`;
    if (mod._fx_is_stereo(0) !== 0) return `is_stereo(0)=${mod._fx_is_stereo(0)}, want 0 (wah, dual-mono)`;
    if (mod._fx_is_stereo(11) !== 0) return `is_stereo(11)=${mod._fx_is_stereo(11)}, want 0 (fuzzface, dual-mono)`;
    if (mod._fx_is_stereo(30) !== 1) return `is_stereo(30)=${mod._fx_is_stereo(30)}, want 1 (tonecontroll, native stereo faust class)`;
    if (mod._fx_default(0, 1) !== 0.5) return `default(0,1)=${mod._fx_default(0, 1)}, want 0.5 (wah HOTPOTZ)`;
    if (mod._fx_default(3, 4) !== f32(0.002)) return `default(3,4)=${mod._fx_default(3, 4)}, want ${f32(0.002)}`;
    if (mod._fx_default(8, 2) !== 1000) return `default(8,2)=${mod._fx_default(8, 2)}, want 1000 (delay)`;
    if (mod._fx_default(17, 1) !== -7) return `default(17,1)=${mod._fx_default(17, 1)}, want -7 (rat LEVEL, ttl)`;
    if (mod._fx_default(28, 3) !== 0) return `default(28,3)=${mod._fx_default(28, 3)}, want 0 (graphiceq G4)`;
    if (mod._fx_default(31, 1) !== 3000) return `default(31,1)=${mod._fx_default(31, 1)}, want 3000 (moog FR)`;
    if (mod._fx_default(34, 3) !== 0) return `default(34,3)=${mod._fx_default(34, 3)}, want 0 (wahmodel MODEL)`;
    if (mod._fx_default(37, 0) !== 0) return `default(37,0)=${mod._fx_default(37, 0)}, want 0 (dunwah WAH)`;
    if (mod._fx_default(38, 0) !== 0) return `default(38,0)=${mod._fx_default(38, 0)}, want 0 (invalid fx)`;
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
    mod._fx_set_slot(0, 0, 38); // FX_COUNT == 38 since Phase 1-c
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
    const renderSweepRms = (model) => {
      mod._obxd_init(48000); // fresh: default chain, slot 0 = wah
      mod._fx_set_slot(0, 0, 34); // -> wahmodel aggregate
      if (mod._fx_get_slot(0, 0) !== 34) return { err: `slot(0,0)=${mod._fx_get_slot(0, 0)}, want 34 (wahmodel)` };
      mod._fx_set_param(0, 0, 2, 0); // MODE = manual (ttl port 4, ordinal 2)
      mod._fx_set_param(0, 0, 4, 100); // WET_DRY = full wet (ordinal 4)
      mod._fx_set_param(0, 0, 3, model); // MODEL (ordinal 3, ttl port 5)
      if (mod._fx_get_param(0, 0, 3) !== model) return { err: `MODEL round-trip=${mod._fx_get_param(0, 0, 3)}, want ${model}` };
      mod._fx_set_enabled(0, 0, 1);
      mod._obxd_midi_in(0, 0x90, 60, 100);
      let s = 0;
      let finite = true;
      const QUANTA = 40, SKIP = 10;
      for (let q = 0; q < QUANTA; q++) {
        mod._fx_set_param(0, 0, 0, q / (QUANTA - 1)); // sweep WAH 0 -> 1
        if (mod._fx_get_param(0, 0, 0) !== f32(q / (QUANTA - 1))) return { err: `WAH round-trip at q=${q}` };
        mod._obxd_render(128);
        if (q < SKIP) continue; // let the note settle
        const l = new Float32Array(mod.HEAPF32.buffer, mod._get_track_l_ptr(0), 128);
        const r = new Float32Array(mod.HEAPF32.buffer, mod._get_track_r_ptr(0), 128);
        for (let i = 0; i < 128; i++) {
          if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) finite = false;
          s += l[i] * l[i] + r[i] * r[i];
        }
      }
      mod._obxd_midi_in(0, 0x80, 60, 0);
      mod._obxd_panic(0);
      if (!finite) return { err: `non-finite sample through wahmodel ${model}` };
      return { rms: Math.sqrt(s / ((QUANTA - SKIP) * 256)) };
    };
    const m0 = renderSweepRms(0); // Colorsound Wah
    if (m0.err) return m0.err;
    const m6 = renderSweepRms(6); // Vox Wah V847
    if (m6.err) return m6.err;
    if (!(m0.rms > 0) || !(m6.rms > 0)) return `wahmodel output silent: m0=${m0.rms.toExponential(3)} m6=${m6.rms.toExponential(3)}`;
    const rel = Math.abs(m6.rms - m0.rms) / Math.max(m0.rms, m6.rms);
    if (!(rel > 0.05)) {
      return `MODEL param does not reach the DSP: rms(model0)=${m0.rms.toExponential(4)} rms(model6)=${m6.rms.toExponential(4)} (rel diff ${(rel * 100).toFixed(2)}%, want > 5%)`;
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

  // --- summary -------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`error: unexpected failure: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});

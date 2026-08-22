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
  // Verified against the processX() bodies in obxf_imported/engine/
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

  // --- summary -------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`error: unexpected failure: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});

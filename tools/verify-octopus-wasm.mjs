#!/usr/bin/env node
/**
 * tools/verify-octopus-wasm.mjs — behavioral regression net for the Octopus
 * engine WASM, ported from the native Octopus repo's tests/test_manual.py
 * (commit 6dfc43c, "Add manual-grounded behavior test suite").
 *
 * The native suite drives a running octopus_gui over OSC (UDP 8000) in and
 * MIR/transport (WS 8089) out. OctOBX has no OSC/WS surface: the engine is
 * the Emscripten WASM module running INSIDE the combined OB-Xf AudioWorklet
 * in the shipped dist/ app. This suite drives the SAME firmware (identical
 * submodule commit) through the main-thread controller (src/octopus-awp.ts,
 * exposed as window.__octopus) in headless Chromium:
 *
 *   input  -> window.__octopus.key / .transport / .pause / .setTempo
 *             / .setZoom — each posts an oct_* port message the worklet's
 *             onmessage turns into the C exports (_wasm_key_press,
 *             _wasm_transport, _wasm_pause, _wasm_set_tempo, _wasm_set_zoom).
 *   output -> window.__octopus.mir(): a live 170-byte Uint8Array view over
 *             the engine's shared WebAssembly.Memory at the processed-MIR
 *             buffer (blinker pre-applied — exactly what the UI paints),
 *             refreshed by the worklet pump at ~60 Hz. Status reads
 *             (.status.runBit()/.tempo()/.zoom()/.tickCount()) are the same
 *             zero-copy int32 views over the shared status block.
 *
 * Ported 1:1 (same LED coordinate table from MIR_write_dot(), same key
 * indices, same blink-safe window-OR captures, same Grid-Clear prelude):
 *   1. page selection toggle (PAGE zoom)
 *   2. transport start/stop
 *   3. transport pause/continue
 *   4-7. zoom GRID/PAGE/STEP/MAP indicators
 *   8. record arm (REC)
 *   9. save machine state
 *  11. tempo set (responsive)
 * NOT ported (documented N/A):
 *  10. name-based OSC dispatch — OSC /key/<NAME> is a native-launcher
 *      feature (Octopus src/osc_server.c); OctOBX has no OSC surface.
 *
 * Transport-layer differences from the native suite:
 *   * /zoom OSC  -> window.__octopus.setZoom (test-only _wasm_set_zoom
 *     export in main_wasm.c that mirrors the native handler:
 *     G_zoom_level = level; Page_requestRefresh()). Physical zoom keys are
 *     play-mode dependent, so a deterministic setter is needed for the
 *     zoom-indicator tests (same reason the native suite used /zoom).
 *   * /save OSC  -> window.__octopus.saveState() (oct_save_state message;
 *     the worklet runs the identical C save_state() into MEMFS and posts
 *     the bytes back). Assert non-null + non-empty length — replaces the
 *     old FS check on /persistent/octopus_state.bin.
 *   * /transport -> window.__octopus.transport(true|false) / .pause() (the
 *     WASM pause is the same HALT/UNHALT toggle as the native "pause"
 *     command; "continue" is the same call when halted).
 *   * WS /mir frames -> shared-memory reads. The blink-safe window-OR is
 *     now TIME-based: the worklet pump refreshes the processed-MIR buffer
 *     every ~15 ms and toggles the blinker every 10 refreshes (~300 ms
 *     full blink period), so OR-ing every frame seen during a >= 1 s poll
 *     window spans >= 3 blink periods. The first suite revision drove
 *     _wasm_check_refresh() itself from the main thread; those exports
 *     live behind the worklet now, so the poll relies on the pump (the
 *     audio path when the AudioContext runs, the RAF oct_pump fallback
 *     while it is suspended — either way the engine must tick or the
 *     tests fail, which is exactly the seam under test).
 *
 * Chromium is launched with --autoplay-policy=no-user-gesture-required so
 * the AudioContext starts running and process() drives the pump (the real
 * AWP path). All waits are written to be robust to either driver: polls
 * with generous timeouts (2-5 s), never single-shot reads for values that
 * settle asynchronously.
 *
 * Prereqs:
 *   - dist/ built and current:  ./build.sh app   (or `npm run build`)
 *   - playwright-core:          npm i -D playwright-core
 *   - system Chromium:          /usr/bin/chromium (override: CHROMIUM_BIN)
 *
 * Run:  node tools/verify-octopus-wasm.mjs
 * Exit: 0 iff every test passes; 1 otherwise (or on boot failure).
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dist = path.join(repoRoot, 'dist');
const PORT = parseInt(process.env.OCTOBX_TEST_PORT || '8099', 10);
const CHROMIUM = process.env.CHROMIUM_BIN || '/usr/bin/chromium';

// ---------------------------------------------------------------------------
// Artifact check — never build from here, just tell the user how.
// ---------------------------------------------------------------------------
for (const p of ['index.html', 'octopus_wasm.wasm', 'obxd-processor.js']) {
  if (!fs.existsSync(path.join(dist, p))) {
    console.error(`error: dist/${p} not found. Run \`./build.sh app\` (or \`npm run build\`) first.`);
    process.exit(1);
  }
}
if (!fs.existsSync(CHROMIUM)) {
  console.error(`error: Chromium not found at ${CHROMIUM}. Set CHROMIUM_BIN or install chromium.`);
  process.exit(1);
}
// Staleness guard: the suite drives the engine through the combined worklet.
// dist/obxd-processor.js must carry BOTH emcc glues (octopus first, obxd
// second — build.sh concat order) and the oct_ready handshake message.
{
  const processorSrc = fs.readFileSync(path.join(dist, 'obxd-processor.js'), 'utf8');
  for (const needle of ['OctopusModuleFactory', 'oct_ready']) {
    if (!processorSrc.includes(needle)) {
      console.error(`error: dist/obxd-processor.js is stale (missing ${needle}). Rebuild: \`./build.sh wasm && ./build.sh synth && ./build.sh app\`.`);
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Static server for dist/ with the COOP/COEP/CORP headers that
// SharedArrayBuffer (the engine's shared WebAssembly.Memory) requires.
// dist/ is self-contained.
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm',
               '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
               '.json': 'application/json', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const p = pathname === '/' ? path.join(dist, 'index.html') : path.join(dist, pathname);
  if (!p.startsWith(dist)) { res.writeHead(403); res.end(); return; }
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(p)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    res.end(data);
  });
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// ---------------------------------------------------------------------------
// In-page harness. All engine access goes through window.__octopus (set by
// main.ts once bootOctopusEngine resolves). The blink-safe window-OR mirrors
// the native harness's capture_or/led_or: OR of every processed-MIR frame in
// a window spanning >= 2 blink periods, so blinking LEDs are caught in their
// on phase. The pump refreshes the shared buffer every ~15 ms and the blinker
// toggles every 10 refreshes, so a 1000 ms poll window spans ~3 periods.
// ---------------------------------------------------------------------------
const HARNESS_SRC = `
window.__H = (function () {
  const o = () => window.__octopus;
  const PLANE = { blink: 0, red: 1, green: 2 };
  // name -> [set, row, bit]; from firmware MIR_write_dot() (identical in both repos)
  const LED = {
    GRID: [0,16,0], PAGE: [0,16,1], STEP: [0,16,2], MAP: [0,16,3], TRK: [0,16,4], PLAY: [0,16,5],
    REC: [0,14,7], STP: [1,14,0], PSE: [1,14,1], P1: [1,14,2], P2: [1,14,3], P4: [1,14,4],
    MIX: [0,10,0], SEL: [0,10,1], ATR: [0,10,2], VOL: [0,10,3], PAN: [0,10,4], MOD: [0,10,5],
    EXP: [0,10,6], U0: [0,10,7], U1: [1,10,0], U2: [1,10,1], U3: [1,10,2], U4: [1,10,3],
    U5: [1,10,4], MUT: [1,10,5], EDT: [1,10,6], ESC: [1,10,7],
    TGGL: [1,11,1], SOLO: [1,11,2], CLR: [1,11,3], RND: [1,11,4], FLT: [1,11,5],
    RMX: [1,12,0], EFF: [1,12,1], ZOOM: [1,12,2], CPY: [1,12,3], PST: [1,12,4],
    CHORD0: [1,16,0], CHORD1: [1,16,1], CHORD2: [1,16,2], CHORD3: [1,16,3],
    CHORD4: [1,16,4], CHORD5: [1,16,5], CHORD6: [1,16,6], ALN: [1,16,7],
    EDIT_IND: [1,12,5], MIX_IND: [0,12,0], TPO: [1,13,5], CLOCK: [1,13,6],
  };
  const KEY = { GRID: 218, PAGE: 219, TRK: 220, STEP: 227, MAP: 228, PLAY: 229,
                REC: 223, STP: 231, P1: 241, CLR: 189 };
  const ZOOM = { GRID: 2, PAGE: 3, TRACK: 4, MAP: 5, STEP: 6, PLAY: 7 };

  function key(ndx, press = true) { o().key(ndx, press); }
  function transport(cmd) {
    if (cmd === 'start') o().transport(true);
    else if (cmd === 'stop') o().transport(false);
    else if (cmd === 'pause' || cmd === 'continue') o().pause();
    else throw new Error('unknown transport cmd ' + cmd);
  }
  function zoom(level) { o().setZoom(level); }
  function tempo(bpm) { o().setTempo(bpm); }
  function runBit() { return o().status.runBit(); }
  function zoomLevel() { return o().status.zoom(); }
  function tempoNow() { return o().status.tempo(); }

  // OR of the shared-memory processed MIR over a ~ms poll window (>= 2 blink
  // periods; the pump refreshes every ~15 ms, the blinker toggles every 10
  // refreshes). Async — callers await.
  async function blinkOr(ms) {
    const oc = o();
    const acc = new Uint8Array(170);
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const mir = oc.mir();
      for (let j = 0; j < 170; j++) acc[j] |= mir[j];
      await new Promise((r) => setTimeout(r, 12));
    }
    return Array.from(acc);
  }
  async function ledOr(name, color, ms = 1000) {
    const mir = await blinkOr(ms);
    const [s, r, b] = LED[name];
    return !!(mir[s * 85 + r * 5 + PLANE[color]] & (1 << b));
  }
  // Green plane of the matrix region (rows 0-9, both sides).
  async function matrixGreenOr(ms = 1000) {
    const mir = await blinkOr(ms);
    const out = [];
    for (let s = 0; s < 2; s++)
      for (let r = 0; r < 10; r++) out.push(mir[s * 85 + r * 5 + PLANE.green]);
    return out;
  }
  // Deterministic single-shot: the worklet copies its OWN processed-MIR
  // snapshot + status into the reply (one round-trip, no RAF dependence).
  async function snapshot() { return o().snapshot(); }
  async function saveState() {
    const bytes = await o().saveState();
    if (!bytes || !bytes.length) return { exists: false, size: 0 };
    return { exists: true, size: bytes.length };
  }
  return { key, transport, zoom, tempo, runBit, zoomLevel, tempoNow,
           blinkOr, ledOr, matrixGreenOr, snapshot, saveState, KEY, ZOOM };
})();
`;

// --autoplay-policy=no-user-gesture-required: let the AudioContext start on
// its own so process() drives the pump (real AWP path). If headless still
// starts suspended, the main thread's RAF oct_pump fallback covers ticking.
const browser = await chromium.launch({
  executablePath: CHROMIUM,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

// ?nosync: skip the IDBFS/IndexedDB initial-state read — the worklet's MEMFS
// is empty at boot (hermetic; the C save path is identical, only where the
// initial bytes would come from differs from the shipped path).
const resp = await page.goto('http://127.0.0.1:' + PORT + '/?nosync',
                             { waitUntil: 'load', timeout: 60000 });
if (!resp || resp.status() !== 200) {
  throw new Error('page load failed: ' + (resp && resp.status()));
}

// Boot wait: the controller appears once bootOctopusEngine has created the
// worklet node; its `ready` promise resolves on the oct_ready handshake.
await page.waitForFunction(() => !!window.__octopus, null, { timeout: 90000 });
await page.evaluate(() => Promise.race([
  window.__octopus.ready,
  new Promise((_, rej) => setTimeout(() => rej(new Error('oct_ready timeout (60 s)')), 60000)),
]));
await page.evaluate(HARNESS_SRC);

// Engine-ready gate: poll worklet snapshots until the MIR is populated
// (engine_init calls Page_requestRefresh at the end; the pump services it).
const mirReady = await page.evaluate(async () => {
  const H = window.__H;
  for (let i = 0; i < 100; i++) {
    const s = await H.snapshot();
    if (s && Array.isArray(s.mir)) {
      const nz = s.mir.filter((b) => b > 0).length;
      if (nz > 0) return { nz, engineReady: window.__octopus.status.engineReady() };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
});
if (!mirReady) throw new Error('engine did not populate the MIR within 15 s');
if (mirReady.engineReady !== 1) throw new Error('status.engineReady != 1 after boot');
console.log('engine up in worklet (MIR nonzero bytes: ' + mirReady.nz + '), run_bit=' +
  (await page.evaluate(() => window.__octopus.status.runBit())));

const settle = (ms) => page.waitForTimeout(ms);
const H = (fn, ...args) =>
  page.evaluate((h) => window.__H[h.f](...h.a), { f: fn, a: args });

// ---------------------------------------------------------------------------
// Prelude — deterministic reset (native test_manual.py reset_state):
// Grid Clear (hold GRID/BIRDSEYE + CLR -> Octopus_memory_CLR), re-assert GRID
// zoom, normalize to edit mode. Wipes the instance's pattern; expected.
// ---------------------------------------------------------------------------
async function resetState() {
  await H('transport', 'stop'); await settle(500);
  await H('zoom', 2); await settle(500);
  await H('key', 218, true); await settle(150);   // hold GRID -> BIRDSEYE
  await H('key', 189, true); await settle(300);   // CLR
  await H('key', 189, false); await settle(200);
  await H('key', 218, false); await settle(500);
  await H('zoom', 2); await settle(500);
  if (await H('ledOr', 'PLAY', 'red')) {          // perform mode -> toggle to edit
    await H('key', 229, true); await settle(200);
    await H('key', 229, false); await settle(600);
  }
}

// ---------------------------------------------------------------------------
// Tests (ported 1:1 from tests/test_manual.py)
// ---------------------------------------------------------------------------
async function testPageSelectionToggle() {
  await H('transport', 'stop'); await settle(500);
  await H('zoom', 3); await settle(800);          // PAGE zoom
  const base = await H('matrixGreenOr');
  for (const k of [11, 22, 33, 12, 44]) {
    await H('key', k, true); await settle(200);
    await H('key', k, false); await settle(400);
    const after = await H('matrixGreenOr');
    if (JSON.stringify(after) !== JSON.stringify(base)) {
      // restore: flip back (beyond the double-click window)
      await H('key', k, true); await settle(200);
      await H('key', k, false); await settle(400);
      return { ok: true, msg: 'page-selection toggle (key ' + k + ') changed the green plane' };
    }
  }
  return { ok: false, msg: 'no page-selection toggle changed the matrix green plane' };
}

async function testTransportStartStop() {
  await H('transport', 'stop'); await settle(800);
  if ((await H('runBit')) !== 0) return { ok: false, msg: 'run_bit != 0 after stop' };
  await H('transport', 'start'); await settle(800);
  if ((await H('runBit')) !== 1) return { ok: false, msg: 'run_bit != 1 after start' };
  if (!(await H('ledOr', 'P1', 'green'))) return { ok: false, msg: 'P1 LED not green while playing' };
  await H('transport', 'stop'); await settle(800);
  if ((await H('runBit')) !== 0) return { ok: false, msg: 'run_bit != 0 after second stop' };
  return { ok: true, msg: '' };
}

async function testTransportPauseContinue() {
  await H('transport', 'start'); await settle(800);
  if ((await H('runBit')) !== 1) return { ok: false, msg: 'run_bit != 1 after start' };
  await H('transport', 'pause'); await settle(800);
  if ((await H('runBit')) !== 0) return { ok: false, msg: 'run_bit != 0 after pause (HALT clears run bit)' };
  await H('transport', 'continue'); await settle(800);
  if ((await H('runBit')) !== 1) return { ok: false, msg: 'run_bit != 1 after continue' };
  await H('transport', 'stop'); await settle(400);
  return { ok: true, msg: '' };
}

async function zoomIndicator(zoomName, zoomLevel, ledName) {
  await H('transport', 'stop'); await settle(500);
  await H('zoom', zoomLevel); await settle(800);
  // selected-zoom indicators blink (red+green+blink); a >= 5-period window-OR
  // reliably catches the red phase.
  if (!(await H('ledOr', ledName, 'red', 1200)))
    return { ok: false, msg: zoomName + ' zoom indicator never lit red' };
  return { ok: true, msg: '' };
}

async function testRecordArm() {
  await H('key', 223, true); await settle(200);   // REC
  await H('key', 223, false); await settle(400);
  const armed = await H('ledOr', 'REC', 'red', 1200);
  // disarm again (press REC) to restore
  await H('key', 223, true); await settle(200);
  await H('key', 223, false); await settle(600);
  if (!armed) return { ok: false, msg: 'REC LED never lit after arming' };
  return { ok: true, msg: '' };
}

async function testSaveState() {
  const r = await H('saveState');
  if (!r.exists) return { ok: false, msg: 'saveState() returned no bytes' };
  if (r.size <= 0) return { ok: false, msg: 'state bytes are empty' };
  return { ok: true, msg: 'state bytes received (' + r.size + ' bytes)' };
}

async function testTempoResponsive() {
  await H('tempo', 140); await settle(600);
  if ((await H('tempoNow')) !== 140)
    return { ok: false, msg: 'status.tempo() != 140 after setTempo(140)' };
  await H('transport', 'start'); await settle(600);
  const ok = (await H('runBit')) === 1;
  await H('transport', 'stop'); await settle(400);
  if (!ok) return { ok: false, msg: 'engine unresponsive after tempo 140' };
  return { ok: true, msg: '' };
}

const TESTS = [
  ['page selection toggle',      testPageSelectionToggle],
  ['transport start/stop',       testTransportStartStop],
  ['transport pause/continue',   testTransportPauseContinue],
  ['zoom GRID indicator',        () => zoomIndicator('GRID', 2, 'GRID')],
  ['zoom PAGE indicator',        () => zoomIndicator('PAGE', 3, 'PAGE')],
  ['zoom STEP indicator',        () => zoomIndicator('STEP', 6, 'STEP')],
  ['zoom MAP indicator',         () => zoomIndicator('MAP', 5, 'MAP')],
  ['record arm (REC)',           testRecordArm],
  ['save machine state',         testSaveState],
  ['tempo set (responsive)',     testTempoResponsive],
];
// N/A (native-launcher feature, no OctOBX equivalent): name-based OSC dispatch.

console.log('running Grid Clear prelude (wipes the instance pattern)...');
await resetState();

let passed = 0, failed = 0;
for (const [name, fn] of TESTS) {
  let r;
  try { r = await fn(); } catch (e) { r = { ok: false, msg: 'exception: ' + e.message }; }
  if (r.ok) { passed++; console.log('  PASS  ' + name + (r.msg ? ' — ' + r.msg : '')); }
  else { failed++; console.log('  FAIL  ' + name + ': ' + r.msg); }
}
// leave the engine in a clean, stopped state
await H('transport', 'stop'); await settle(300);
await H('zoom', 2); await settle(300);

if (pageErrors.length) console.log('page errors: ' + pageErrors.join(' | '));
if (consoleErrors.length) console.log('console errors: ' + consoleErrors.slice(0, 10).join(' | '));
await browser.close();
server.close();
console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + TESTS.length +
            ' total (+1 documented N/A: name-based OSC dispatch — native-launcher feature)');
process.exit(failed === 0 ? 0 : 1);

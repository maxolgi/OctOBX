#!/usr/bin/env node
/**
 * tools/verify-octopus-wasm.mjs — behavioral regression net for the Octopus
 * engine WASM, ported from the native Octopus repo's tests/test_manual.py
 * (commit 6dfc43c, "Add manual-grounded behavior test suite").
 *
 * The native suite drives a running octopus_gui over OSC (UDP 8000) in and
 * MIR/transport (WS 8089) out. OctOBX has no OSC/WS surface: the engine is
 * the Emscripten WASM module inside the shipped dist/ app. This suite drives
 * the SAME firmware (identical submodule commit) through the browser's C
 * exports in headless Chromium:
 *
 *   input  -> window.__module._wasm_key_press / _wasm_transport / _wasm_pause
 *             / _wasm_set_tempo / _wasm_set_zoom / _wasm_save_state
 *   output -> 170-byte MIR read from the WASM heap (_get_processed_mir_ptr,
 *             blinker pre-applied — exactly what the UI paints), plus
 *             _get_run_bit / _get_zoom_level / _get_tempo.
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
 *   * /zoom OSC  -> _wasm_set_zoom (test-only export in main_wasm.c that
 *     mirrors the native handler: G_zoom_level = level; Page_requestRefresh()).
 *     Physical zoom keys are play-mode dependent, so a deterministic setter
 *     is needed for the zoom-indicator tests (same reason the native suite
 *     used /zoom).
 *   * /save OSC  -> _wasm_save_state + FS check on /persistent/octopus_state.bin
 *     (MEMFS under ?nosync; the C save_state() path is identical).
 *   * /transport -> _wasm_transport(1|0) + _wasm_pause (the WASM pause is
 *     the same HALT/UNHALT toggle as the native "pause" command; "continue"
 *     is the same call when halted).
 *   * WS /mir frames -> heap reads; the blink-safe window-OR is implemented
 *     by driving _wasm_check_refresh() ourselves (each call advances the
 *     blink frame; the blinker toggles every 10 calls), so captures are
 *     deterministic and RAF-independent.
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
for (const p of ['index.html', 'octopus_wasm.js', 'octopus_wasm.wasm']) {
  if (!fs.existsSync(path.join(dist, p))) {
    console.error(`error: dist/${p} not found. Run \`./build.sh app\` (or \`npm run build\`) first.`);
    process.exit(1);
  }
}
if (!fs.existsSync(CHROMIUM)) {
  console.error(`error: Chromium not found at ${CHROMIUM}. Set CHROMIUM_BIN or install chromium.`);
  process.exit(1);
}
// Staleness guard: the suite needs the test-only _wasm_set_zoom export.
if (!fs.readFileSync(path.join(dist, 'octopus_wasm.js'), 'utf8').includes('wasm_set_zoom')) {
  console.error('error: dist/octopus_wasm.js is stale (missing wasm_set_zoom). Rebuild: `make -C wasm && npm run build`.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Static server for dist/ with the COOP/COEP/CORP headers that
// SharedArrayBuffer (Emscripten pthreads) requires. dist/ is self-contained.
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
// In-page harness. All engine access goes through window.__module (set by
// main.ts after engine_init). The blink-safe window-OR mirrors the native
// harness's capture_or/led_or: OR of every processed-MIR frame in a window
// spanning >= 2 blink periods, so blinking LEDs are caught in their on phase.
// ---------------------------------------------------------------------------
const HARNESS_SRC = `
window.__H = (function () {
  const m = () => window.__module;
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

  function key(ndx, press = true) { m()._wasm_key_press(ndx, press ? 1 : 0); }
  function transport(cmd) {
    if (cmd === 'start') m()._wasm_transport(1);
    else if (cmd === 'stop') m()._wasm_transport(0);
    else if (cmd === 'pause' || cmd === 'continue') m()._wasm_pause();
    else throw new Error('unknown transport cmd ' + cmd);
  }
  function zoom(level) { m()._wasm_set_zoom(level); }
  function tempo(bpm) { m()._wasm_set_tempo(bpm); }
  function runBit() { return m()._get_run_bit(); }
  function zoomLevel() { return m()._get_zoom_level(); }
  function tempoNow() { return m()._get_tempo(); }

  // OR of the processed MIR over n blink-frames (n >= 20 spans >= 2 blink
  // periods; the blinker toggles every 10 _wasm_check_refresh calls).
  function blinkOr(n) {
    const mm = m();
    const acc = new Uint8Array(170);
    for (let i = 0; i < n; i++) {
      mm._wasm_check_refresh();
      const p = mm._get_processed_mir_ptr();
      for (let j = 0; j < 170; j++) acc[j] |= mm.HEAPU8[p + j];
    }
    return Array.from(acc);
  }
  function ledOr(name, color, n = 30) {
    const mir = blinkOr(n);
    const [s, r, b] = LED[name];
    return !!(mir[s * 85 + r * 5 + PLANE[color]] & (1 << b));
  }
  // Green plane of the matrix region (rows 0-9, both sides).
  function matrixGreenOr(n = 30) {
    const mir = blinkOr(n);
    const out = [];
    for (let s = 0; s < 2; s++)
      for (let r = 0; r < 10; r++) out.push(mir[s * 85 + r * 5 + PLANE.green]);
    return out;
  }
  function saveState() {
    const mm = m();
    if (!mm.FS.analyzePath('/persistent').exists) mm.FS.mkdir('/persistent');
    mm._wasm_save_state();
    const p = '/persistent/octopus_state.bin';
    if (!mm.FS.analyzePath(p).exists) return { exists: false, size: 0 };
    return { exists: true, size: mm.FS.stat(p).size };
  }
  return { key, transport, zoom, tempo, runBit, zoomLevel, tempoNow,
           blinkOr, ledOr, matrixGreenOr, saveState, KEY, ZOOM };
})();
`;

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

// ?nosync: skip IDBFS — state stays in MEMFS (hermetic; the C save path is
// identical, only the FS backend differs from the shipped IDBFS path).
const resp = await page.goto('http://127.0.0.1:' + PORT + '/?nosync',
                             { waitUntil: 'load', timeout: 60000 });
if (!resp || resp.status() !== 200) {
  throw new Error('page load failed: ' + (resp && resp.status()));
}
await page.waitForFunction(() => !!(window.__module && window.__module._get_mir_ptr),
                           null, { timeout: 90000 });
await page.evaluate(HARNESS_SRC);

// Engine-ready gate: wait until the MIR is populated (engine_init calls
// Page_requestRefresh at the end).
const mirReady = await page.evaluate(async () => {
  const m = window.__module;
  for (let i = 0; i < 300; i++) {
    m._wasm_check_refresh();
    const p = m._get_mir_ptr();
    let nz = 0;
    for (let j = 0; j < 170; j++) if (m.HEAPU8[p + j]) nz++;
    if (nz > 0) return nz;
    await new Promise((r) => setTimeout(r, 50));
  }
  return 0;
});
if (mirReady === 0) throw new Error('engine did not populate the MIR within 15 s');
console.log('engine up (MIR nonzero bytes: ' + mirReady + '), run_bit=' +
  (await page.evaluate(() => window.__H.runBit())));

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
  if (await H('ledOr', 'PLAY', 'red', 30)) {      // perform mode -> toggle to edit
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
  const base = await H('matrixGreenOr', 30);
  for (const k of [11, 22, 33, 12, 44]) {
    await H('key', k, true); await settle(200);
    await H('key', k, false); await settle(400);
    const after = await H('matrixGreenOr', 30);
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
  if (!(await H('ledOr', 'P1', 'green', 30))) return { ok: false, msg: 'P1 LED not green while playing' };
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
  if (!(await H('ledOr', ledName, 'red', 50)))
    return { ok: false, msg: zoomName + ' zoom indicator never lit red' };
  return { ok: true, msg: '' };
}

async function testRecordArm() {
  await H('key', 223, true); await settle(200);   // REC
  await H('key', 223, false); await settle(400);
  const armed = await H('ledOr', 'REC', 'red', 50);
  // disarm again (press REC) to restore
  await H('key', 223, true); await settle(200);
  await H('key', 223, false); await settle(600);
  if (!armed) return { ok: false, msg: 'REC LED never lit after arming' };
  return { ok: true, msg: '' };
}

async function testSaveState() {
  const r = await H('saveState');
  if (!r.exists) return { ok: false, msg: '/persistent/octopus_state.bin not created' };
  if (r.size <= 0) return { ok: false, msg: 'state file is empty' };
  return { ok: true, msg: 'state file written (' + r.size + ' bytes)' };
}

async function testTempoResponsive() {
  await H('tempo', 140); await settle(600);
  if ((await H('tempoNow')) !== 140)
    return { ok: false, msg: '_get_tempo() != 140 after _wasm_set_tempo(140)' };
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
await browser.close();
server.close();
console.log('\\n' + passed + ' passed, ' + failed + ' failed, ' + TESTS.length +
            ' total (+1 documented N/A: name-based OSC dispatch — native-launcher feature)');
process.exit(failed === 0 ? 0 : 1);

/*
 * obxd-processor.tail.js — appended to the emcc-generated obxd_wasm.js at
 * build time to produce a single wasm/build/obxd-processor.js fed to
 * audioWorklet.addModule().
 *
 * AudioWorkletGlobalScope disallows `importScripts()` (removed in Chrome 105+)
 * AND dynamic `import()` (rejected with "import() is disallowed on
 * WorkletGlobalScope"). So we cannot load the emcc module from a separate
 * file at runtime — we have to ship it in the same classic script the host
 * calls addModule() with. build.sh concatenates the two halves.
 *
 * When this file runs, the emcc JS above has already executed and defined
 * `ObxdModuleFactory` as a global function declaration (which becomes a
 * property of `self` in worklet scope). We invoke it; it returns a Promise
 * that resolves with the WASM module instance. Until that resolves, process()
 * returns silence.
 *
 * IMPORTANT: This file is plain JS (not an ES module, not TypeScript) so it
 * can be loaded via AudioWorklet.addModule() which expects a classic script.
 */

// Top-level log — proves the combined file was parsed at addModule() time.
console.log('[obxd-processor] module evaluating');

let wasmModule = null;
let initPromise = null;
let bufLPtr = 0;
let bufRPtr = 0;
let pendingMidi = [];   // queued via port.onmessage, drained in process()
let gainLinear = 0.2;   // internal default (~-14 dBFS sine)

// Cached HEAPF32 views into the WASM linear memory. The raw `wasmModule.HEAPF32`
// reference is replaced by emcc whenever WASM memory grows
// (-sALLOW_MEMORY_GROWTH=1), so we cache both the underlying ArrayBuffer
// (to detect the swap) and the typed-array view (to skip per-quantum
// allocation). Allocating two Float32Array views per process() call was a
// significant source of GC pressure and caused periodic audio glitches on
// sustained notes.
let heapF32Ref = null;     // the ArrayBuffer HEAPF32 is currently backed by
let bufLView = null;       // Float32Array view over g_buf_l
let bufRView = null;       // Float32Array view over g_buf_r

const RENDER_QUANTUM = 128;   // AWP quantum is fixed at 128 frames by spec

function ensureModule(wasmBytesArg) {
    if (initPromise) return initPromise;
    initPromise = (async () => {
        try {
            console.log('[obxd-processor] locating ObxdModuleFactory...');
            const factory = (typeof ObxdModuleFactory !== 'undefined') ? ObxdModuleFactory : null;
            if (typeof factory !== 'function') {
                throw new Error('ObxdModuleFactory not found after combined-script load (typeof=' + typeof factory + ')');
            }

            // emcc 6.x's WASM loader inside AudioWorkletGlobalScope is
            // unreachable from outside the factory closure — all of its
            // inner vars (`wasmBinary`, `readBinary`, `readAsync`, `fetch`)
            // are declared inside the factory function body, so we can't
            // monkey-patch them by bare name. We CAN monkey-patch
            // `WebAssembly.instantiateStreaming` itself (a real global),
            // which emcc calls with whatever `fetch()` returned. If we make
            // it succeed using our pre-fetched bytes, emcc's loader never
            // tries to call `fetch` for the binary.
            let prefetchedBytes = null;
            if (wasmBytesArg) {
                prefetchedBytes = wasmBytesArg instanceof Uint8Array
                    ? wasmBytesArg
                    : new Uint8Array(wasmBytesArg);
                const originalInstantiateStreaming = WebAssembly.instantiateStreaming;
                WebAssembly.instantiateStreaming = async function (_response, imports) {
                    console.log('[obxd-processor] instantiateStreaming patched → using pre-fetched bytes');
                    return WebAssembly.instantiate(prefetchedBytes, imports);
                };
                // Also patch plain instantiate() in case emcc falls through
                // to its ArrayBuffer path: when called with imports object
                // (not a Module), swap in our bytes.
                const originalInstantiate = WebAssembly.instantiate;
                WebAssembly.instantiate = async function (binaryOrModule, imports) {
                    if (imports && (!binaryOrModule || !(binaryOrModule instanceof WebAssembly.Module))) {
                        return originalInstantiate(prefetchedBytes, imports);
                    }
                    return originalInstantiate(binaryOrModule, imports);
                };
                console.log('[obxd-processor] pre-fetched WASM bytes injected (' + prefetchedBytes.byteLength + '); WebAssembly.instantiate patched');
            } else {
                console.warn('[obxd-processor] no pre-fetched WASM bytes; falling back to emcc default loader');
            }

            console.log('[obxd-processor] invoking factory...');
            const m = await factory({
                locateFile: (p) => '/' + p,
            });
            console.log('[obxd-processor] factory resolved; _exports:', Object.keys(m).filter(k => k.startsWith('_')).join(','));
            wasmModule = m;
            wasmModule._obxd_init(sampleRate || 44100);
            bufLPtr = wasmModule._get_buf_l_ptr();
            bufRPtr = wasmModule._get_buf_r_ptr();
            wasmModule._obxd_set_gain(gainLinear);
            // Seed the cached views now that WASM is up.
            heapF32Ref = wasmModule.HEAPF32.buffer;
            bufLView = new Float32Array(heapF32Ref, bufLPtr, RENDER_QUANTUM);
            bufRView = new Float32Array(heapF32Ref, bufRPtr, RENDER_QUANTUM);
            console.log('[obxd-processor] WASM ready, bufLPtr=' + bufLPtr + ' bufRPtr=' + bufRPtr);
        } catch (e) {
            console.error('[obxd-processor] WASM load failed:', e && e.message, e && e.stack);
            throw e;
        }
    })();
    return initPromise;
}

class ObxdProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super(options);
        this.alive = true;

        const reportError = (e) => {
            this.port.postMessage({
                type: 'error',
                message: String(e && e.message || e),
                stack: String(e && e.stack || ''),
            });
        };

        // The main thread pre-fetches the WASM and passes the bytes via
        // processorOptions — this is the only reliable way to get binary
        // into AudioWorkletGlobalScope (no XHR, no fetch-needed).
        const wasmBytesArg = options && options.processorOptions && options.processorOptions.wasmBinary;
        console.log('[obxd-processor] constructor; options.processorOptions =', options && options.processorOptions ? Object.keys(options.processorOptions).join(',') : 'none',
            '; wasmBytesArg type:', typeof wasmBytesArg,
            '; byteLength:', wasmBytesArg ? wasmBytesArg.byteLength : 0);

        ensureModule(wasmBytesArg).then(() => {
            this.port.postMessage({ type: 'ready' });
        }).catch((e) => {
            reportError(e);
            this.alive = false;
        });

        this.port.onmessage = (ev) => {
            const msg = ev.data;
            if (!msg) return;
            switch (msg.type) {
                case 'gain':
                    // UI sends 0..1; we scale down so the slider's max isn't deafening.
                    gainLinear = Math.max(0, Math.min(1, msg.value)) * 0.4;
                    if (wasmModule) wasmModule._obxd_set_gain(gainLinear);
                    break;
                case 'note':
                    // Phase 1 test hook: sets the oscillator frequency directly.
                    // Phase 3 replaces this with real MIDI parsing inside the C side.
                    if (wasmModule) wasmModule._obxd_set_freq(msg.freq);
                    break;
                case 'midi':
                    // Phase 3 will pass these to wasmModule._obxd_midi_in(...).
                    pendingMidi.push(msg);
                    break;
                case 'set_param':
                    // idx is a ParamsEnum.h value; value is 0..1. Forwarded
                    // directly to the engine. Useful for runtime patch tweaks
                    // (e.g. setting a longer release to verify the ADSR).
                    if (wasmModule && typeof msg.idx === 'number' && typeof msg.value === 'number') {
                        wasmModule._obxd_set_param(msg.idx | 0, +msg.value);
                    }
                    break;
                case 'load_fxp': {
                    // Phase 4 — load a VST2 preset file. The main thread
                    // sends the raw .fxp bytes as a Uint8Array; we copy
                    // them into WASM linear memory via _malloc + HEAPU8.set
                    // (the worklet can't read the FS — emcc was built with
                    // -sFORCE_FILESYSTEM=0), then hand the pointer to the
                    // C loader. Reply with the parsed patch name (or an
                    // error code) so the UI can update its label.
                    const bytes = msg.bytes;
                    if (!wasmModule || !bytes || !bytes.length) {
                        this.port.postMessage({ type: 'fxp_loaded', success: false, rc: -1, name: '' });
                        break;
                    }
                    let rc = -1, name = '';
                    try {
                        const ptr = wasmModule._malloc(bytes.length);
                        if (!ptr) throw new Error('_malloc returned 0');
                        wasmModule.HEAPU8.set(bytes, ptr);
                        rc = wasmModule._obxd_load_fxp(ptr, bytes.length);
                        wasmModule._free(ptr);
                        name = wasmModule.UTF8ToString(wasmModule._obxd_get_patch_name()) || '';
                    } catch (e) {
                        console.error('[obxd-processor] load_fxp threw:', e && e.message);
                        rc = -128;
                    }
                    this.port.postMessage({
                        type: 'fxp_loaded',
                        success: rc === 0,
                        rc,
                        name,
                    });
                    break;
                }
                case 'all_notes_off':
                    // Note-off only — release tails still audible.
                    if (wasmModule) wasmModule._obxd_all_notes_off();
                    break;
                case 'panic':
                    // Hard silence — kill every voice's envelope immediately.
                    if (wasmModule) wasmModule._obxd_panic();
                    break;
                case 'reset_patch':
                    // Re-apply engine defaults (clears the loaded .fxp).
                    if (wasmModule) wasmModule._obxd_reset_patch();
                    break;
                case 'get_param':
                    // Query the current engine value for a single param
                    // (used by the knob UI to read defaults after a patch
                    // load). The reply goes back as `param_value` so the
                    // requester can correlate by idx.
                    if (wasmModule && typeof msg.idx === 'number') {
                        const v = wasmModule._obxd_get_param(msg.idx | 0);
                        this.port.postMessage({ type: 'param_value', idx: msg.idx | 0, value: v });
                    }
                    break;
                case 'ping':
                    this.port.postMessage({
                        type: 'pong',
                        alive: this.alive,
                        ready: wasmModule !== null,
                        bufLPtr,
                        bufRPtr,
                    });
                    break;
                default:
                    break;
            }
        };

        this.port.postMessage({ type: 'constructed' });
    }

    process(_inputs, outputs) {
        if (!this.alive) return false;   // retire node on fatal init failure
        if (!wasmModule) return true;    // still loading; output silence

        const out = outputs[0];
        if (!out || out.length === 0) return true;

        // Phase 2: drain any MIDI messages queued via port.onmessage into
        // the engine before rendering this quantum. Timing granularity is
        // the 128-sample AWP quantum (~2.9ms @ 44.1kHz) — well below
        // perceptible MIDI jitter.
        if (pendingMidi.length > 0) {
            for (let i = 0; i < pendingMidi.length; i++) {
                const m = pendingMidi[i];
                wasmModule._obxd_midi_in(m.status | 0, m.d1 | 0, m.d2 | 0);
            }
            pendingMidi.length = 0;
        }

        wasmModule._obxd_render(RENDER_QUANTUM);

        // Refresh cached views if WASM memory grew (HEAPF32 buffer swapped).
        // This is rare but can happen under ALLOW_MEMORY_GROWTH=1.
        const currentBuf = wasmModule.HEAPF32.buffer;
        if (currentBuf !== heapF32Ref) {
            heapF32Ref = currentBuf;
            bufLView = new Float32Array(currentBuf, bufLPtr, RENDER_QUANTUM);
            bufRView = new Float32Array(currentBuf, bufRPtr, RENDER_QUANTUM);
        }

        if (out[0]) out[0].set(bufLView);
        if (out[1]) out[1].set(bufRView);

        return true;
    }
}

registerProcessor('obxd-processor', ObxdProcessor);
console.log('[obxd-processor] registerProcessor called');

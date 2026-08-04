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
 * Multi-instance (Phase A): _obxd_init creates 10 SynthEngine instances
 * in one WASM heap. Every MIDI/param/gain/fxp/etc message carries an
 * `instance_id` (0..9). The render path is unchanged — the C side sums
 * all 10 active engines into the master buffer with soft-clip and exposes
 * it via the same _get_buf_l_ptr / _get_buf_r_ptr that the cached HEAPF32
 * views already point at.
 *
 * IMPORTANT: This file is plain JS (not an ES module, not TypeScript) so it
 * can be loaded via AudioWorklet.addModule() which expects a classic script.
 */

// Top-level log — proves the combined file was parsed at addModule() time.
console.log('[obxd-processor] module evaluating');

const INSTANCE_COUNT = 10;       // MUST match main_obxd.cpp INSTANCE_COUNT
const DEFAULT_INSTANCE_GAIN = 0.4 * 0.7;  // matches prior single-instance default (gainLinear * 0.4)

let wasmModule = null;
let initPromise = null;
let bufLPtr = 0;
let bufRPtr = 0;
let pendingMidi = [];   // queued via port.onmessage, drained in process()

// SAB-based MIDI ring buffer (direct from Octopus sequencer, no main thread)
let midiSabRing = null;      // Uint32Array view over SAB
let midiSabHead = null;      // Int32Array view (1 element)
let midiSabTail = null;      // Int32Array view (1 element)
const MIDI_SYNTH_RING_SIZE = 512;
const MIDI_SYNTH_RING_MASK = 511;
let midiRouting = null;      // array[17]: channel → bitmask of instance IDs (0 = unmapped)

// Cached HEAPF32 views into the WASM linear memory. The raw `wasmModule.HEAPF32`
// reference is replaced by emcc whenever WASM memory grows
// (-sALLOW_MEMORY_GROWTH=1), so we cache both the underlying ArrayBuffer
// (to detect the swap) and the typed-array view (to skip per-quantum
// allocation). Allocating two Float32Array views per process() call was a
// significant source of GC pressure and caused periodic audio glitches on
// sustained notes.
let heapF32Ref = null;     // the ArrayBuffer HEAPF32 is currently backed by
let bufLView = null;       // Float32Array view over g_master_l
let bufRView = null;       // Float32Array view over g_master_r

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
                    console.log('[obxd-processor] instantiateStreaming patched -> using pre-fetched bytes');
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
            // _obxd_init now creates all 10 SynthEngine instances and
            // applies the matching factory patch to each. No additional
            // per-instance setup is required from the constructor beyond
            // seeding the default gain.
            wasmModule._obxd_init(sampleRate || 44100);
            bufLPtr = wasmModule._get_buf_l_ptr();
            bufRPtr = wasmModule._get_buf_r_ptr();
            // Default each instance to the prior single-instance default
            // gain (gainLinear * 0.4 where gainLinear was 0.7). The C side
            // has no "global gain" any more — every instance manages its
            // own VOLUME param, so we issue one set_gain per instance.
            for (let i = 0; i < INSTANCE_COUNT; i++) {
                wasmModule._obxd_set_gain(i, DEFAULT_INSTANCE_GAIN);
            }
            // Seed the cached views now that WASM is up.
            heapF32Ref = wasmModule.HEAPF32.buffer;
            bufLView = new Float32Array(heapF32Ref, bufLPtr, RENDER_QUANTUM);
            bufRView = new Float32Array(heapF32Ref, bufRPtr, RENDER_QUANTUM);
            console.log('[obxd-processor] WASM ready, bufLPtr=' + bufLPtr + ' bufRPtr=' + bufRPtr + ' instances=' + INSTANCE_COUNT);
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

        // Wire up the Octopus engine's SAB-backed MIDI ring. The main thread
        // passes the SharedArrayBuffer (octopusModule.HEAPU8.buffer) plus the
        // three byte offsets returned by the C getters. We build typed-array
        // views over them and read events directly in process().
        const midiSabArg = options && options.processorOptions && options.processorOptions.midiSab;
        if (midiSabArg) {
            try {
                midiSabRing = new Uint32Array(midiSabArg, options.processorOptions.midiSynthRingOffset, MIDI_SYNTH_RING_SIZE);
                midiSabHead = new Int32Array(midiSabArg, options.processorOptions.midiSynthHeadOffset, 1);
                midiSabTail = new Int32Array(midiSabArg, options.processorOptions.midiSynthTailOffset, 1);
                console.log('[obxd-processor] SAB MIDI ring connected');
            } catch (e) {
                console.warn('[obxd-processor] SAB MIDI ring init failed:', e && e.message);
            }
        }
        // Default routing: channels 1-10 → instances 0-9 (bitmask: bit i = instance i)
        midiRouting = new Array(17).fill(0);
        for (let i = 0; i < 10; i++) midiRouting[i + 1] = (1 << i);

        ensureModule(wasmBytesArg).then(() => {
            this.port.postMessage({ type: 'ready' });
        }).catch((e) => {
            reportError(e);
            this.alive = false;
        });

        // Per-instance message routing. Every command carries an
        // instance_id (0..9) so the C side can dispatch to the right
        // SynthEngine. MIDI is queued and drained at the top of process()
        // so we don't interrupt the audio thread with allocator/GC work
        // mid-quantum.
        this.port.onmessage = (ev) => {
            const msg = ev.data;
            if (!msg) return;
            const id = (typeof msg.instance_id === 'number') ? (msg.instance_id | 0) : 0;
            switch (msg.type) {
                case 'midi':
                    // Queued; msg must carry {instance_id, status, d1, d2}.
                    // Drained in process() so we don't dispatch from the
                    // message thread while the audio thread is mid-render.
                    pendingMidi.push(msg);
                    break;
                case 'set_routing':
                    if (msg.routing && Array.isArray(msg.routing)) {
                        midiRouting = msg.routing.slice();
                    }
                    break;
                case 'set_active':
                    if (wasmModule) wasmModule._obxd_set_active(id, msg.active ? 1 : 0);
                    break;
                case 'set_polyphony':
                    if (wasmModule) wasmModule._obxd_set_polyphony(id, msg.voice_count | 0);
                    break;
                case 'set_mpe':
                    // Per-instance MPE flag (T9). Stored on the C side in
                    // g_mpe_enabled[id]; the engine is channel-aware but the
                    // actual per-channel dispatch arrives in T20. For now
                    // obxd_midi_in still passes channel=0 regardless.
                    if (wasmModule) wasmModule._obxd_set_mpe(id, msg.enabled ? 1 : 0);
                    break;
                case 'set_mod_wheel':
                    // Fix 2: reserved CC 1 direct routing. value is 0..1.
                    if (wasmModule) wasmModule._obxd_set_mod_wheel(id, +msg.value);
                    break;
                case 'set_sustain':
                    // Fix 2: reserved CC 64 direct routing. enabled is 0/1.
                    if (wasmModule) wasmModule._obxd_set_sustain(id, msg.enabled ? 1 : 0);
                    break;
                case 'set_mpe_glide_range':
                    if (wasmModule) wasmModule._obxd_set_mpe_glide_range(id, msg.semitones | 0);
                    break;
                case 'set_matrix_row':
                    if (wasmModule && typeof msg.row === 'number'
                            && typeof msg.src === 'string' && typeof msg.tgt === 'string'
                            && typeof msg.depth === 'number') {
                        wasmModule._obxd_set_matrix_row(id, msg.row | 0, msg.src, msg.tgt, +msg.depth);
                    }
                    break;
                case 'clear_matrix_row':
                    if (wasmModule && typeof msg.row === 'number') {
                        wasmModule._obxd_clear_matrix_row(id, msg.row | 0);
                    }
                    break;
                case 'set_param':
                    // idx is a ParamsEnum.h value; value is 0..1. Forwarded
                    // directly to the engine. Useful for runtime patch tweaks.
                    if (wasmModule && typeof msg.idx === 'number' && typeof msg.value === 'number') {
                        wasmModule._obxd_set_param(id, msg.idx | 0, +msg.value);
                    }
                    break;
                case 'gain':
                    // UI sends 0..1; we scale down so the slider's max isn't
                    // deafening (engine's processVolume maps 0..1 -> 0..0.30).
                    if (wasmModule) wasmModule._obxd_set_gain(id, Math.max(0, Math.min(1, +msg.value)) * 0.4);
                    break;
                case 'load_fxp': {
                    // Phase 4 — load a VST2 preset file into one instance.
                    // The main thread sends the raw .fxp bytes as a
                    // Uint8Array; we copy them into WASM linear memory
                    // via _malloc + HEAPU8.set (the worklet can't read the
                    // FS — emcc was built with -sFORCE_FILESYSTEM=0), then
                    // hand the pointer to the C loader. Reply with the
                    // parsed patch name (or an error code) so the UI can
                    // update its label.
                    const bytes = msg.bytes;
                    if (!wasmModule || !bytes || !bytes.length) {
                        this.port.postMessage({ type: 'fxp_loaded', instance_id: msg.instance_id, success: false, rc: -1, name: '' });
                        break;
                    }
                    let rc = -1, name = '';
                    try {
                        const ptr = wasmModule._malloc(bytes.length);
                        if (!ptr) throw new Error('_malloc returned 0');
                        wasmModule.HEAPU8.set(bytes, ptr);
                        rc = wasmModule._obxd_load_fxp(id, ptr, bytes.length);
                        wasmModule._free(ptr);
                        name = wasmModule.UTF8ToString(wasmModule._obxd_get_patch_name(id)) || '';
                    } catch (e) {
                        console.error('[obxd-processor] load_fxp threw:', e && e.message);
                        rc = -128;
                    }
                    this.port.postMessage({
                        type: 'fxp_loaded',
                        instance_id: msg.instance_id,
                        success: rc === 0,
                        rc,
                        name,
                    });
                    break;
                }
                case 'set_factory_patch':
                    if (wasmModule) wasmModule._obxd_set_factory_patch(id, msg.patch_id | 0);
                    break;
                case 'panic':
                    if (wasmModule) wasmModule._obxd_panic(id);
                    break;
                case 'panic_all':
                    if (wasmModule) wasmModule._obxd_panic_all();
                    break;
                case 'reset_patch':
                    if (wasmModule) wasmModule._obxd_reset_patch(id);
                    break;
                case 'get_param':
                    if (wasmModule && typeof msg.idx === 'number') {
                        const v = wasmModule._obxd_get_param(id, msg.idx | 0);
                        this.port.postMessage({ type: 'param_value', instance_id: msg.instance_id, idx: msg.idx | 0, value: v });
                    }
                    break;
                // Bulk param dump/restore for state persistence (save/load).
                // Single round-trip for all 10 instances × 108 params.
                case 'dump_all_params': {
                    const total = INSTANCE_COUNT * 108;
                    const params = new Array(total);
                    if (wasmModule) {
                        for (let i = 0; i < INSTANCE_COUNT; i++) {
                            const base = i * 108;
                            for (let p = 0; p < 80; p++)
                                params[base + p] = wasmModule._obxd_get_param(i, p);
                            for (let n = 0; n < 28; n++)
                                params[base + 80 + n] = wasmModule._obxd_get_param(i, 200 + n);
                        }
                    } else {
                        params.fill(0);
                    }
                    this.port.postMessage({ type: 'all_params_dumped', params });
                    break;
                }
                case 'restore_all_params': {
                    if (wasmModule && Array.isArray(msg.params)) {
                        const params = msg.params;
                        for (let i = 0; i < INSTANCE_COUNT; i++) {
                            const base = i * 108;
                            for (let p = 0; p < 80; p++)
                                wasmModule._obxd_set_param(i, p, +params[base + p]);
                            for (let n = 0; n < 28; n++)
                                wasmModule._obxd_set_param(i, 200 + n, +params[base + 80 + n]);
                        }
                    }
                    this.port.postMessage({ type: 'all_params_restored' });
                    break;
                }
                // Bulk drum layer param dump/restore (state persistence).
                // Dumps 8 pads × 4 layers × 108 params (80 legacy + 28 new).
                case 'dump_drum_params': {
                    const dtotal = 8 * 4 * 108;
                    const dparams = new Array(dtotal);
                    if (wasmModule) {
                        for (let dpad = 0; dpad < 8; dpad++) {
                            for (let dlayer = 0; dlayer < 4; dlayer++) {
                                const dbase = dpad * 432 + dlayer * 108;
                                for (let dp = 0; dp < 80; dp++)
                                    dparams[dbase + dp] = wasmModule._obxd_get_drum_layer_param(dpad, dlayer, dp);
                                for (let dn = 0; dn < 28; dn++)
                                    dparams[dbase + 80 + dn] = wasmModule._obxd_get_drum_layer_param(dpad, dlayer, 200 + dn);
                            }
                        }
                    } else {
                        dparams.fill(0);
                    }
                    this.port.postMessage({ type: 'drum_params_dumped', params: dparams });
                    break;
                }
                case 'restore_drum_params': {
                    if (wasmModule && Array.isArray(msg.params)) {
                        const dparams = msg.params;
                        for (let dpad = 0; dpad < 8; dpad++) {
                            for (let dlayer = 0; dlayer < 4; dlayer++) {
                                const dbase = dpad * 432 + dlayer * 108;
                                for (let dp = 0; dp < 80; dp++)
                                    wasmModule._obxd_set_drum_layer_param(dpad, dlayer, dp, +dparams[dbase + dp]);
                                for (let dn = 0; dn < 28; dn++)
                                    wasmModule._obxd_set_drum_layer_param(dpad, dlayer, 200 + dn, +dparams[dbase + 80 + dn]);
                            }
                        }
                    }
                    this.port.postMessage({ type: 'drum_params_restored' });
                    break;
                }
                // OctOBX PCM — per-drum-layer full-param get/set (mirrors get_param / set_param).
                case 'set_drum_layer_param':
                    if (wasmModule && typeof msg.idx === 'number' && typeof msg.value === 'number') {
                        wasmModule._obxd_set_drum_layer_param(msg.pad | 0, msg.layer | 0, msg.idx | 0, +msg.value);
                    }
                    break;
                case 'get_drum_layer_param':
                    if (wasmModule && typeof msg.idx === 'number') {
                        const val = wasmModule._obxd_get_drum_layer_param(msg.pad | 0, msg.layer | 0, msg.idx | 0);
                        this.port.postMessage({ type: 'drum_layer_param_value', instance_id: msg.instance_id, pad: msg.pad | 0, layer: msg.layer | 0, idx: msg.idx | 0, value: val });
                    }
                    break;
                case 'get_patch_name': {
                    let name = '';
                    if (wasmModule) {
                        try { name = wasmModule.UTF8ToString(wasmModule._obxd_get_patch_name(id)) || ''; }
                        catch (e) { name = ''; }
                    }
                    this.port.postMessage({ type: 'patch_name', instance_id: msg.instance_id, name });
                    break;
                }
                case 'ping': {
                    const meters = new Array(INSTANCE_COUNT);
                    const voices = new Array(INSTANCE_COUNT);
                    if (wasmModule) {
                        for (let i = 0; i < INSTANCE_COUNT; i++) {
                            meters[i] = wasmModule._obxd_get_instance_rms(i);
                            voices[i] = wasmModule._obxd_get_voice_activity(i) >>> 0;
                        }
                    } else {
                        for (let i = 0; i < INSTANCE_COUNT; i++) { meters[i] = 0.0; voices[i] = 0; }
                    }
                    this.port.postMessage({
                        type: 'pong',
                        alive: this.alive,
                        ready: wasmModule !== null,
                        meters,
                        voiceActivity: voices,
                        bufLPtr,
                        bufRPtr,
                    });
                    break;
                }
                // OctOBX PCM
                case 'load_pcm': {
                    // msg = {instance_id, pad, layer, pcmL: Float32Array, frames}
                    const pcmL = msg.pcmL;
                    if (!wasmModule || !pcmL || !pcmL.length) break;
                    const size = msg.frames * 4;
                    const ptr = wasmModule._malloc(size);
                    wasmModule.HEAPF32.set(pcmL, ptr >> 2);
                    wasmModule._obxd_load_pcm(id, msg.pad | 0, msg.layer | 0, ptr, msg.frames | 0);
                    // WASM takes ownership of the pointer — do NOT free
                    break;
                }
                case 'set_pcm_layer':
                    if (wasmModule) wasmModule._obxd_set_pcm_layer(id, msg.pad | 0, msg.layer | 0,
                        +msg.gain, +msg.cutoff, +msg.res, +msg.mode,
                        +msg.aA, +msg.aD, +msg.aS, +msg.aR, +msg.pan, +msg.pitch);
                    break;
                case 'set_pcm_note_map':
                    if (wasmModule) wasmModule._obxd_set_pcm_note_map(id, msg.note | 0, msg.pad | 0);
                    break;
                case 'set_pcm_layer_count':
                    if (wasmModule) wasmModule._obxd_set_pcm_layer_count(id, msg.pad | 0, msg.count | 0);
                    break;
                case 'set_pcm_choke':
                    if (wasmModule) wasmModule._obxd_set_pcm_choke(id, msg.pad | 0, msg.group | 0);
                    break;
                case 'clear_pcm':
                    if (wasmModule) wasmModule._obxd_clear_pcm(id);
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

        // Read MIDI events directly from the Octopus SAB ring buffer.
        // This runs BEFORE the pendingMidi drain so the lowest-latency path
        // (lock-free, no main-thread round trip) always wins. System
        // real-time (status >= 0xF0) is skipped — those have no channel.
        if (midiSabRing && midiSabHead && midiSabTail && wasmModule) {
            const tail = Atomics.load(midiSabTail, 0);
            let head = Atomics.load(midiSabHead, 0);
            const hwBatch = [];
            while (head !== tail) {
                const packed = Atomics.load(midiSabRing, head);
                const status = packed & 0xff;
                if (status < 0xf0) {
                    const channel = (packed >> 24) & 0xff;
                    const mask = midiRouting[channel];
                    if (mask) {
                        const d1 = (packed >> 8) & 0xff;
                        const d2 = (packed >> 16) & 0xff;
                        let m = mask, bit = 0;
                        while (m) {
                            if (m & 1) wasmModule._obxd_midi_in(bit, status, d1, d2);
                            m >>>= 1;
                            bit++;
                        }
                    }
                }
                hwBatch.push(packed);
                head = (head + 1) & MIDI_SYNTH_RING_MASK;
            }
            Atomics.store(midiSabHead, 0, head);
            if (hwBatch.length > 0) {
                this.port.postMessage({ type: 'hw_midi', packed: hwBatch });
            }
        }

        // Drain queued MIDI into the engine before rendering this quantum.
        // Timing granularity is the 128-sample AWP quantum (~2.9ms @
        // 44.1kHz) — well below perceptible MIDI jitter. Each message
        // carries its own instance_id so the right SynthEngine receives it.
        if (pendingMidi.length > 0) {
            for (let i = 0; i < pendingMidi.length; i++) {
                const m = pendingMidi[i];
                const id = (typeof m.instance_id === 'number') ? (m.instance_id | 0) : 0;
                wasmModule._obxd_midi_in(id, m.status | 0, m.d1 | 0, m.d2 | 0);
            }
            pendingMidi.length = 0;
        }

        // Renders every active engine, sums into g_master_l/r, applies
        // soft-clip — all inside the C side. The worklet doesn't need to
        // know there are 10 instances; it just sees the master buffer.
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

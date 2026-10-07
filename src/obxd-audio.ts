/*
 * obxd-audio.ts — Main-thread bootstrap + per-instance API for the
 * multi-instance OB-Xf synth.
 *
 * The combined AudioWorklet node is created AT STARTUP by
 * bootOctopusEngine() (octopus-awp.ts), which calls setupObxdAudio()
 * with the Octopus engine's WASM binary + memory. The Octopus sequencer
 * engine lives in the SAME worklet and is pumped from process(); the
 * later setupObxdAudio() calls from the rack (PLAY path) are fast
 * no-ops that just re-resume the AudioContext.
 *
 * The AudioWorklet + WASM loading strategy is unchanged from Phase 1:
 * AudioWorkletGlobalScope forbids importScripts() AND dynamic import(),
 * and Chrome's AWP also lacks XMLHttpRequest. We pre-fetch the WASM bytes
 * on the main thread and hand them to the AudioWorkletProcessor via its
 * constructor options (`processorOptions.wasmBinary`); the worklet then
 * forwards them to the emcc factory as `wasmBinary`, which skips all of
 * emcc's network-loading code paths.
 *
 * `_obxd_init()` on the C side now creates ALL 10 SynthEngine instances,
 * applies their factory patches, and sets the default polyphony
 * ({8,1,1,1,1,1,1,1,1,1}). All per-instance control is therefore via an
 * `instance_id` (0..9) — selection is purely a UI concern tracked in
 * `selectedInstance`; the bridge / rack / knob-grid pass the id
 * explicitly so a future "multi-select" UI doesn't need an API change.
 */

import { FX_INSTANCE_COUNT, FX_SLOTS, FX_SLOT_PARAMS, isFxId } from "./gxfx-params";

let audioContext: AudioContext | null = null;
let workletNode: AudioWorkletNode | null = null;
let moduleAdded = false;

// Master bus nodes — inserted between the worklet output and the destination
// so a master VU meter (AnalyserNode) can ride the whole mix. workletNode →
// masterGain → masterAnalyser → destination. NOTE: since the CakeMix mixer
// engine took over the output path (its own master fader + oversampled
// limiter live in the worklet), this GainNode stays at unity — it is kept
// only as a tap point for the analyser.
let masterGain: GainNode | null = null;
let masterAnalyser: AnalyserNode | null = null;
const DEFAULT_MASTER_GAIN = 1.0;

// CakeMix mixer engine readiness — flipped by the worklet's {type:
// 'mixer_ready'} message (posted after initSync + MixerWasm construction
// succeeded). False also covers "binary missing / engine failed", in which
// case the worklet keeps summing via the legacy C master path.
let mixerReady = false;

// UI-edited instance (0..9). Defaults to 0. Per-instance param APIs do
// NOT consult this — callers pass the id explicitly. Only the rack /
// knob-grid read it back via getObxdSelectedInstance() so a knob drag
// hits the instance the user is currently looking at.
let selectedInstance = 0;

// Last per-instance RMS values (length 10). Updated by the pong handler
// installed in ensureRouter(). Stays zero until the first pong arrives.
let lastMeters = new Float32Array(10);
let lastVoiceActivity = new Uint32Array(10);

// Shared source of truth for per-instance VOLUME (legacy param idx 2).
// Both the mixer faders and the synth-editor volume knob read AND write
// this, so the two views mirror each other without engine round-trips.
// Every write path updates it: the init default, the bulk restore
// (restoreAllSynthAndDrumState), individual knob/fader changes
// (setObxdInstanceParam), and patch-load read-back (getObxdInstanceParam).
const VOLUME_PARAM_IDX = 2;
const DEFAULT_VOLUME = 0.4 * 0.7;  // matches the worklet's init gain (tail.js)
const instanceVolumes = new Float32Array(10).fill(DEFAULT_VOLUME);

/*
 * One-shot reply router for worklet messages that need an async response
 * (fxp_loaded, param_value). Multiple concurrent callers (e.g. 30+
 * getObxdInstanceParam calls from syncObxdControlsFromEngine) all install
 * their predicate into this array instead of swapping port.onmessage,
 * which would race and lose replies.
 */
interface PendingReply {
    predicate: (msg: unknown) => boolean;
    resolve: (msg: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
}
const pendingReplies: PendingReply[] = [];
let routerInstalled = false;

// Hardware MIDI forward handler — called when AudioWorklet forwards
// events from the SAB ring buffer for hardware output. Set by midi-output.ts.
let hwMidiHandler: ((packed: number[]) => void) | null = null;

export function setHwMidiHandler(cb: ((packed: number[]) => void) | null): void {
    hwMidiHandler = cb;
}

/*
 * Mixer-engine message log — every mixer_* worklet message from the moment
 * this module loads (the ready-handshake forwards boot-window messages to
 * permanent listeners, so mixer_debug/mixer_ready/mixer_error posts are
 * captured even before the router installs). Diagnostic surface for the
 * console integration; read via window.__mixerLog.
 */
const mixerLog: unknown[] = [];

/*
 * Permanent message-listener registry. Every callback registered here is
 * invoked for EVERY message the worklet posts (before the pendingReplies
 * scan in ensureRouter). Used by octopus-awp.ts for the Octopus engine's
 * async replies (oct_ready / oct_state_saved / oct_state_bytes /
 * oct_state_loaded / oct_snapshot). No detach — registrations live for
 * the lifetime of the page.
 */
const workletMessageListeners: ((msg: unknown) => void)[] = [];

export function addWorkletMessageListener(cb: (msg: unknown) => void): void {
    if (!workletMessageListeners.includes(cb)) {
        workletMessageListeners.push(cb);
    }
}

function ensureRouter(): void {
    if (routerInstalled || !workletNode) return;
    routerInstalled = true;
    // Use addEventListener (not the onmessage setter) so this never
    // conflicts with code that owns onmessage for the ready handshake.
    workletNode.port.addEventListener("message", (ev: MessageEvent) => {
        const msg = ev.data;
        if (!msg || typeof msg !== "object") return;

        // Permanent listeners first (octopus-awp controller, etc.) so
        // they observe every message, including ones the reply router
        // would otherwise claim.
        for (const listener of workletMessageListeners) {
            listener(msg);
        }

        // Permanent meter listener: every pong refreshes lastMeters.
        // Independent of pendingReplies so a ping without an awaitReply
        // caller still updates the rack UI's meter bar.
        if ((msg as { type?: string }).type === "pong") {
            const meters = (msg as { meters?: number[] }).meters;
            if (Array.isArray(meters)) {
                for (let i = 0; i < 10 && i < meters.length; i++) {
                    lastMeters[i] = Number(meters[i]) || 0;
                }
            }
            const voices = (msg as { voiceActivity?: number[] }).voiceActivity;
            if (Array.isArray(voices)) {
                for (let i = 0; i < 10 && i < voices.length; i++) {
                    lastVoiceActivity[i] = (Number(voices[i]) || 0) >>> 0;
                }
            }
        }

        // Mixer engine readiness (one-shot latch; the worklet posts
        // mixer_ready exactly once after a successful init). mixer_error
        // latches it back OFF: the worklet posts it on init failure AND on
        // a mid-session process() throw (phase:'init' / phase:'process')
        // — the latter only after it already flipped itself to the legacy
        // master sum, so without this the console UI would keep claiming
        // "ONLINE" while the meters freeze.
        if ((msg as { type?: string }).type === "mixer_ready") {
            mixerReady = true;
        }
        if ((msg as { type?: string }).type === "mixer_error") {
            mixerReady = false;
        }

        // Hardware MIDI forward: AudioWorklet sends packed events from
        // the SAB ring buffer for hardware synth output.
        if ((msg as { type?: string }).type === "hw_midi") {
            const packed = (msg as { packed?: number[] }).packed;
            if (Array.isArray(packed) && hwMidiHandler) {
                hwMidiHandler(packed);
            }
        }

        // Find the first predicate that claims this reply. Splice it
        // out BEFORE resolving so the callback can post another message
        // (which would race with the loop otherwise).
        for (let i = 0; i < pendingReplies.length; i++) {
            const p = pendingReplies[i];
            if (p.predicate(msg)) {
                pendingReplies.splice(i, 1);
                clearTimeout(p.timer);
                p.resolve(msg);
                return;
            }
        }
    });
    // addEventListener doesn't auto-start the port like the onmessage
    // setter does. Start it explicitly so messages flow.
    try { workletNode.port.start(); } catch { /* some impls throw if already started */ }
}

/*
 * The single reply-correlation mechanism for worklet RPC replies: install a
 * predicate into the pendingReplies array scanned by the router in
 * ensureRouter(), then resolve (with the message) or time out (with null).
 * drum-audio.ts's getDrumLayerParam uses this too — never install a private
 * one-shot port listener for a worklet reply.
 */
export function awaitReply(predicate: (msg: unknown) => boolean, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            const i = pendingReplies.findIndex((p) => p.predicate === predicate);
            if (i >= 0) pendingReplies.splice(i, 1);
            resolve(null);
        }, timeoutMs);
        pendingReplies.push({ predicate, resolve, timer });
    });
}

/*
 * Octopus engine assets handed to the worklet at node creation. The
 * combined processor instantiates the Octopus engine with the supplied
 * WASM binary + shared memory inside the AudioWorkletGlobalScope (see
 * octopus-awp.ts). `octopusInitialState` is the boot-time state blob
 * from the active project, or null for a fresh engine.
 */
export interface OctopusWorkletAssets {
    octopusWasmBinary: ArrayBuffer;
    octopusMemory: WebAssembly.Memory;
    octopusInitialState: Uint8Array | null;
}

export async function setupObxdAudio(octopusAssets?: OctopusWorkletAssets): Promise<void> {
    if (workletNode) return;   // already up

    if (!audioContext) {
        const Ctor: typeof AudioContext =
            window.AudioContext || window.webkitAudioContext!;
        audioContext = new Ctor();
    }
    // Try to resume, but NEVER await resume() unbounded: on an autoplay-
    // blocked context Chrome keeps the promise PENDING until the first user
    // gesture (it does not reject — the catch below never fires), which
    // used to stall the whole boot before the worklet node was created.
    // Racing a short timeout lets the suspended-context boot proceed; the
    // Octopus RAF fallback pump keeps the engine ticking until the context
    // runs, and the rack's first PLAY click completes the resume.
    try {
        await Promise.race([
            audioContext.resume(),
            new Promise<void>((resolve) => setTimeout(resolve, 250)),
        ]);
    } catch { /* autoplay policy — non-fatal */ }

    if (!moduleAdded) {
        // Cache-busting query param: AudioWorklet module URLs are cached
        // aggressively by the browser and ignore normal HTTP cache headers
        // during dev. Bump to force reload of obxd-processor.js changes.
        await audioContext.audioWorklet.addModule("/obxd-processor.js?v=" + Date.now());
        moduleAdded = true;
    }

    // Pre-fetch the WASM binary on the main thread. We pass it into the
    // processor via processorOptions; the worklet forwards it to the emcc
    // factory as `wasmBinary`, which skips emcc's XHR/fetch loading paths
    // (neither of which is reliable in AudioWorkletGlobalScope).
    const wasmResponse = await fetch("/obxd_wasm.wasm?v=" + Date.now());
    if (!wasmResponse.ok) {
        throw new Error(`Failed to fetch obxd_wasm.wasm: HTTP ${wasmResponse.status}`);
    }
    const wasmBinary = await wasmResponse.arrayBuffer();

    // CakeMix mixer engine binary — best-effort: a 404/missing file just
    // means the worklet boots without the mixer (legacy C-side master sum
    // stays the output path; the mixer UI shows its disconnected state).
    let mixerWasmBinary: ArrayBuffer | undefined;
    try {
        const mixResponse = await fetch("/mixer_wasm_bg.wasm?v=" + Date.now());
        if (mixResponse.ok) mixerWasmBinary = await mixResponse.arrayBuffer();
    } catch { /* absent — legacy path */ }

    const processorOptions: {
        wasmBinary: ArrayBuffer;
        mixerWasmBinary?: ArrayBuffer;
        octopusWasmBinary?: ArrayBuffer;
        octopusMemory?: WebAssembly.Memory;
        octopusInitialState?: Uint8Array | null;
    } = { wasmBinary };
    if (mixerWasmBinary) processorOptions.mixerWasmBinary = mixerWasmBinary;
    if (octopusAssets) {
        processorOptions.octopusWasmBinary = octopusAssets.octopusWasmBinary;
        processorOptions.octopusMemory = octopusAssets.octopusMemory;
        processorOptions.octopusInitialState = octopusAssets.octopusInitialState;
    }

    workletNode = new AudioWorkletNode(audioContext, "obxd-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions,
    });
    // Master bus: worklet → masterGain → masterAnalyser → destination.
    // The GainNode is the master fader; the AnalyserNode feeds the master VU.
    masterGain = audioContext.createGain();
    masterGain.gain.value = DEFAULT_MASTER_GAIN;
    masterAnalyser = audioContext.createAnalyser();
    masterAnalyser.fftSize = 256;
    workletNode.connect(masterGain);
    masterGain.connect(masterAnalyser);
    masterAnalyser.connect(audioContext.destination);

    // Expose for debugging (analyser taps, state inspection). Remove before shipping.
    window.__obxd = {
        ctx: audioContext,
        node: workletNode,
        masterGain,
        masterAnalyser,
    };

    // Await the worklet's `{type:'ready'}` message before resolving. The
    // processor emits ready once emcc's WASM factory has resolved and
    // _obxd_init() has run (creating all 10 instances). Until then, set_param
    // / midi messages are dropped by the worklet's onmessage guard.
    //
    // Using `onmessage` (not addEventListener): MessagePort auto-calls
    // start() only for the onmessage setter; with addEventListener the
    // ready event would queue and the promise would hang. Nothing else
    // in the app uses port.onmessage, so we own it for the lifecycle of
    // the node.
    await new Promise<void>((resolve, reject) => {
        const port = workletNode!.port;
        const prevHandler = port.onmessage;
        const cleanup = () => { port.onmessage = prevHandler; };
        port.onmessage = (ev: MessageEvent) => {
            const msg = ev.data;
            if (!msg) return;
            // Forward any non-ready/non-error messages to the previous handler
            // (defensive — there is none in practice today) before intercepting.
            // Permanent listeners (octopus-awp controller) also see handshake-
            // window messages so an oct_ready racing the obxd ready is never
            // missed before ensureRouter takes over.
            if (msg.type !== "ready" && msg.type !== "error") {
                if (msg && typeof msg === "object") {
                    for (const listener of workletMessageListeners) {
                        listener(msg);
                    }
                }
                if (typeof prevHandler === "function") {
                    prevHandler.call(port, ev);
                }
                return;
            }
            if (msg.type === "ready") {
                cleanup();
                // Now that the worklet is up, install the async-reply router
                // for the rest of the session. (Adding the listener earlier
                // is safe too, but we wait for ready so the router doesn't
                // intercept the ready message by accident.)
                ensureRouter();
                // Send default MIDI routing: channels 1-10 → instances 0-9.
                // Each entry is a BITMASK (bit i = instance i), matching the
                // format the processor's process() loop expects and the one
                // used by syncRoutingToAudioWorklet() in obxd-bridge.ts. Using
                // single instance IDs here (0,1,2…) was a latent bug that only
                // surfaced on machines without saved localStorage state — the
                // restore path calls syncRoutingToAudioWorklet which overwrote
                // it with correct bitmasks, masking the bug.
                const defaultRouting = new Array(17).fill(0);
                for (let i = 0; i < 10; i++) defaultRouting[i + 1] = (1 << i);
                sendObxdMidiRouting(defaultRouting);
                resolve();
            } else if (msg.type === "error") {
                cleanup();
                reject(new Error(String(msg.message || "obxd worklet init failed")));
            }
        };
    });

    console.log("[obxd] AudioWorklet connected, sampleRate =", audioContext.sampleRate);
}

export function teardownObxdAudio(): void {
    if (workletNode) {
        workletNode.disconnect();
        workletNode = null;
    }
    if (masterGain) { masterGain.disconnect(); masterGain = null; }
    if (masterAnalyser) { masterAnalyser.disconnect(); masterAnalyser = null; }
}

// ---------------------------------------------------------------------------
// Per-instance controls — every message carries instance_id (0..9).
// ---------------------------------------------------------------------------

export function setObxdInstanceActive(id: number, active: boolean): void {
    workletNode?.port.postMessage({ type: "set_active", instance_id: id, active });
}

export function setObxdInstancePolyphony(id: number, voiceCount: number): void {
    workletNode?.port.postMessage({ type: "set_polyphony", instance_id: id, voice_count: voiceCount });
}

/*
 * Toggle per-instance MPE mode on the OB-Xf engine. Forwards to the
 * AudioWorklet, which calls _obxd_set_mpe(instance_id, enabled ? 1 : 0).
 * The flag is stored on the C side (g_mpe_enabled[id]) but does NOT yet
 * change MIDI routing — actual per-channel MPE dispatch is task T20.
 * Like the other instance-aware setters, this no-ops if the worklet
 * hasn't been brought up yet.
 */
export function setObxdInstanceMpe(id: number, enabled: boolean): void {
    workletNode?.port.postMessage({ type: "set_mpe", instance_id: id, enabled: enabled ? 1 : 0 });
}

/*
 * Fix 2: per-instance mod-wheel direct routing (reserved CC 1). The MIDI-
 * learn layer lets CC 1 fall through; obxf-midi-learn-integration.ts calls
 * this to send it straight to the OB-Xf engine's processModWheel, bypassing
 * the unreliable Octopus-engine SAB-echo path. `v` is 0..1.
 */
export function setObxdInstanceModWheel(id: number, v: number): void {
    workletNode?.port.postMessage({ type: "set_mod_wheel", instance_id: id, value: v });
}

/*
 * Fix 2: per-instance sustain-pedal direct routing (reserved CC 64). Same
 * rationale as setObxdInstanceModWheel — sends straight to sustainOn/Off.
 */
export function setObxdInstanceSustain(id: number, on: boolean): void {
    workletNode?.port.postMessage({ type: "set_sustain", instance_id: id, enabled: on ? 1 : 0 });
}

/*
 * Load a VST2 .fxp preset into a specific instance. The bytes are handed
 * to the worklet via its MessagePort (we can't share memory with the
 * worklet directly, and emcc was built with -sFORCE_FILE_SYSTEM=0 so
 * FS.writeFile isn't available inside the worklet). The worklet copies
 * the bytes into WASM heap via _malloc + HEAPU8.set and calls
 * _obxd_load_fxp(instance_id, ptr, len).
 *
 * Resolves with `{success, name}` — name is the program name parsed from
 * the .fxp header (or empty on failure). Rejects only if no worklet is
 * connected. The underlying ArrayBuffer is transferred (zero-copy) to
 * avoid a structured-clone pass; callers must not retain a reference.
 */
export async function loadObxdInstanceFxp(
    id: number,
    bytes: Uint8Array,
): Promise<{ success: boolean; name: string }> {
    if (!workletNode) {
        throw new Error("obxd worklet not initialized");
    }
    const port = workletNode.port;
    // Race the worklet reply against a 5s timeout. Correlate by type AND
    // instance_id so concurrent loads on different instances don't cross.
    const replyPromise = awaitReply(
        (m) => typeof m === "object" && m !== null
            && (m as { type?: string }).type === "fxp_loaded"
            && (m as { instance_id?: number }).instance_id === id,
        5000,
    );
    const copy = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    port.postMessage({ type: "load_fxp", instance_id: id, bytes: copy }, [copy.buffer]);
    const raw = await replyPromise;
    if (!raw) return { success: false, name: "" };
    const msg = raw as { success?: boolean; name?: string };
    return { success: !!msg.success, name: String(msg.name || "") };
}

/*
 * Forward a single ParamsEnum.h index + 0..1 value to a specific
 * instance's `set_param` branch. The C side clamps and dispatches via
 * apply_param(); unknown indices no-op.
 */
export function setObxdInstanceParam(id: number, idx: number, value01: number): void {
    if (idx === VOLUME_PARAM_IDX) instanceVolumes[id] = value01;
    workletNode?.port.postMessage({ type: "set_param", instance_id: id, idx, value: value01 });
}

/*
 * Per-instance output gain. The worklet scales 0..1 by 0.4 internally
 * (matches the original single-instance gain scaling).
 */
export function setObxdInstanceGain(id: number, gain01: number): void {
    workletNode?.port.postMessage({ type: "gain", instance_id: id, value: gain01 });
}

/*
 * Per-instance raw MIDI — used by obxd-bridge.ts to route Octopus ring
 * buffer events to instances by channel. The worklet queues the message
 * and the engine consumes it inside process() at the next 128-sample
 * quantum (~2.9ms jitter at 44.1kHz — well below perceptible).
 */
export function sendObxdInstanceMidi(id: number, status: number, d1: number, d2: number): void {
    workletNode?.port.postMessage({ type: "midi", instance_id: id, status, d1, d2 });
}

/*
 * Push the channel→instance routing table into the AudioWorklet. The
 * routing is an array of 17 ints (index = MIDI channel 0-16, value =
 * bitmask of instance IDs where bit i = instance i; 0 = unmapped).
 * Multiple instances on the same channel OR their bits together. The
 * worklet iterates set bits to dispatch each event to all instances.
 */
export function sendObxdMidiRouting(routing: number[]): void {
    workletNode?.port.postMessage({ type: "set_routing", routing });
}

/*
 * Generic worklet command post — the mixer console (src/mixer/) uses this
 * for every mix_* message. No-ops before the worklet node exists, matching
 * every other setter here.
 */
export function postWorkletMessage(msg: unknown): void {
    workletNode?.port.postMessage(msg);
}

/*
 * True once the worklet confirmed the CakeMix mixer engine initialized
 * ({type:'mixer_ready'}). False covers not-yet-initialized AND failed /
 * absent — the mixer UI treats it as "console not connected" and the audio
 * path runs the legacy C-side master sum.
 */
export function isMixerReady(): boolean {
    return mixerReady;
}

/* Hard silence — allSoundOff on one instance (resets envelopes too). */
export function obxdInstancePanic(id: number): void {
    workletNode?.port.postMessage({ type: "panic", instance_id: id });
}

/* Convenience: panic every instance in one round-trip. */
export function obxdPanicAll(): void {
    workletNode?.port.postMessage({ type: "panic_all" });
}

/* Re-apply the engine's built-in defaults for a specific instance. */
export function obxdInstanceResetPatch(id: number): void {
    workletNode?.port.postMessage({ type: "reset_patch", instance_id: id });
}

/*
 * Swap a specific instance's patch to one of the 10 embedded factory
 * patches (0..9). The C side keeps the byte arrays in patches.h and the
 * worklet forwards to _obxd_set_factory_patch(instance_id, patch_id).
 */
export function applyObxdFactoryPatch(id: number, patchId: number): void {
    workletNode?.port.postMessage({ type: "set_factory_patch", instance_id: id, patch_id: patchId });
}

/*
 * Query the engine's current value for a single ParamsEnum.h index on a
 * specific instance. Resolves to the 0..1 value (or -1 if the index is
 * out of range / the engine isn't initialized / the 2s reply window
 * elapsed). Used by the knob UI to seed positions after a .fxp load or
 * an instance-selector switch.
 *
 * Correlates by (instance_id, idx) so concurrent queries across multiple
 * instances (or even the same instance) don't cross-reply.
 */
export async function getObxdInstanceParam(id: number, idx: number): Promise<number> {
    if (!workletNode) return -1;
    const port = workletNode.port;
    // Install the predicate FIRST so a fast reply can't be missed.
    const replyPromise = awaitReply(
        (m) => typeof m === "object" && m !== null
            && (m as { type?: string }).type === "param_value"
            && (m as { instance_id?: number }).instance_id === id
            && (m as { idx?: number }).idx === idx,
        2000,
    );
    port.postMessage({ type: "get_param", instance_id: id, idx });
    const raw = await replyPromise;
    if (!raw) return -1;
    const v = Number((raw as { value?: number }).value ?? -1);
    return v;
}

/* Shared per-instance VOLUME cache — the single source of truth both the
 * mixer faders and the synth-editor knob read/write. */
export function getInstanceVolumes(): Float32Array {
    return instanceVolumes;
}

/* Write one instance's volume into the cache (used by the synth editor to
 * reconcile after a .fxp patch load changes the engine without going
 * through setObxdInstanceParam). */
export function setInstanceVolume(id: number, v: number): void {
    if (id >= 0 && id < 10) instanceVolumes[id] = v;
}

/* Fill the VOLUME cache from a flat params[1080] array (108 per instance,
 * volume at legacy idx 2). Synchronous, no engine round-trip. Called at
 * the TOP of restore (before the slow drum load) so the mixer faders are
 * correct the instant the engine boots. */
export function syncInstanceVolumes(params: number[]): void {
    for (let i = 0; i < 10; i++) {
        const v = params[i * 108 + VOLUME_PARAM_IDX];
        if (typeof v === "number" && v >= 0) instanceVolumes[i] = v;
    }
}

// ---------------------------------------------------------------------------
// Metering / liveness
// ---------------------------------------------------------------------------

/*
 * Post a ping; the worklet replies with `{type:'pong', meters:number[10]}`,
 * which the permanent listener in ensureRouter() folds into lastMeters.
 * The rack UI calls this on a 30Hz interval to refresh the meter bar.
 */
export function pingObxd(): void {
    workletNode?.port.postMessage({ type: "ping" });
}

/* Last received per-instance RMS values (length 10, zeros before first pong). */
export function getObxdInstanceMeters(): Float32Array {
    return lastMeters;
}

/* Last received per-instance voice-activity bitmasks (length 10, bit i = voice i sounding). */
export function getObxdInstanceVoiceActivity(): Uint32Array {
    return lastVoiceActivity;
}

/*
 * Master bus controls. The master GainNode sits between the worklet and the
 * destination; setObxdMasterGain ramps it smoothly to avoid zipper noise.
 * getObxdMasterLevel returns the post-fader RMS from the AnalyserNode.
 */
export function setObxdMasterGain(v: number): void {
    if (!masterGain || !audioContext) return;
    const clamped = v < 0 ? 0 : v > 1 ? 1 : v;
    masterGain.gain.setTargetAtTime(clamped, audioContext.currentTime, 0.01);
}

let masterLevelBuf = new Float32Array(256);
export function getObxdMasterLevel(): number {
    if (!masterAnalyser) return 0;
    if (masterLevelBuf.length !== masterAnalyser.fftSize) {
        masterLevelBuf = new Float32Array(masterAnalyser.fftSize);
    }
    masterAnalyser.getFloatTimeDomainData(masterLevelBuf);
    let sum = 0;
    for (let i = 0; i < masterLevelBuf.length; i++) sum += masterLevelBuf[i] * masterLevelBuf[i];
    return Math.sqrt(sum / masterLevelBuf.length);
}

/* Query the program name currently loaded on a specific instance. */
export async function getObxdInstancePatchName(id: number): Promise<string> {
    if (!workletNode) return "";
    const replyPromise = awaitReply(
        (m) => typeof m === "object" && m !== null
            && (m as { type?: string }).type === "patch_name"
            && (m as { instance_id?: number }).instance_id === id,
        2000,
    );
    workletNode.port.postMessage({ type: "get_patch_name", instance_id: id });
    const raw = await replyPromise;
    if (!raw) return "";
    return String((raw as { name?: string }).name || "");
}

/* Per-instance MPE pitch-bend (glide) range in semitones [0..48]. */
export function setObxdInstanceMpeGlideRange(id: number, semitones: number): void {
    workletNode?.port.postMessage({ type: "set_mpe_glide_range", instance_id: id, semitones });
}

/* Set one row of an instance's 8-row VoiceMatrix. row in [0,8). src/tgt are OB-Xf string names. depth in [-1,1]. */
export function setObxdInstanceMatrixRow(id: number, row: number, src: string, tgt: string, depth: number): void {
    workletNode?.port.postMessage({ type: "set_matrix_row", instance_id: id, row, src, tgt, depth });
}

/* Clear (zero) one VoiceMatrix row on a specific instance. */
export function clearObxdInstanceMatrixRow(id: number, row: number): void {
    workletNode?.port.postMessage({ type: "clear_matrix_row", instance_id: id, row });
}

// ---------------------------------------------------------------------------
// Bulk param dump/restore (state persistence)
// ---------------------------------------------------------------------------

/*
 * Dump all synth params from all 10 instances in a single AWP round-trip.
 * Returns a flat number[1080] array (10 instances × 108 params each) or
 * null if the worklet isn't ready. Used by app-state.ts at save time.
 */
export async function dumpAllSynthParams(): Promise<number[] | null> {
    if (!workletNode) return null;
    const replyPromise = awaitReply(
        (m) => typeof m === "object" && m !== null
            && (m as { type?: string }).type === "all_params_dumped",
        5000,
    );
    workletNode.port.postMessage({ type: "dump_all_params" });
    const raw = await replyPromise;
    if (!raw) return null;
    return (raw as { params?: number[] }).params ?? null;
}

/*
 * Restore the full synth + drum state in ONE AWP round-trip via the
 * engine-owned staged restore (C export obxd_restore_stage). The worklet
 * commits both arrays into C-side staging buffers (one HEAVY task), then
 * applies stages 1..4 (LIGHT tasks) and replies { type:
 * "all_state_restored" } after stage 4 — ALL ordering semantics (the
 * instance-9 drum-structural skip during synth replay, the drum layer
 * store write, and the drum structural finalize that ends the sequence)
 * live in the C state machine. Takes the flat number[1080] synth array
 * produced by dumpAllSynthParams and the flat number[3456] drum array
 * produced by dumpAllDrumParams; `drum` may be null for synth-only
 * restores (stages 3/4 become C-side no-ops). Replaces the old
 * restoreAllSynthParams + restoreAllDrumParams pair. Used by app-state.ts
 * at restore time (after AWP ready).
 */
export async function restoreAllSynthAndDrumState(synth: number[], drum: number[] | null): Promise<void> {
    if (!workletNode) return;
    const replyPromise = awaitReply(
        (m) => typeof m === "object" && m !== null
            && (m as { type?: string }).type === "all_state_restored",
        5000,
    );
    workletNode.port.postMessage({ type: "restore_all_state", synthParams: synth, drumParams: drum });
    await replyPromise;
}

/*
 * Dump all drum layer params (8 pads × 4 layers × 108 params) from the
 * C-side g_drum_layer_params + g_drum_layer_new mirrors. Used by
 * app-state.ts at save time; the matching restore goes through
 * restoreAllSynthAndDrumState above.
 */
export async function dumpAllDrumParams(): Promise<number[] | null> {
    if (!workletNode) return null;
    const replyPromise = awaitReply(
        (m) => typeof m === "object" && m !== null
            && (m as { type?: string }).type === "drum_params_dumped",
        5000,
    );
    workletNode.port.postMessage({ type: "dump_drum_params" });
    const raw = await replyPromise;
    if (!raw) return null;
    return (raw as { params?: number[] }).params ?? null;
}

// ---------------------------------------------------------------------------
// Guitarix FX insert chains (per-instance, slot model)
// ---------------------------------------------------------------------------

/** Bulk rack state. `params` is the flat per-SLOT mirror in ENGINE units
 * (inst-major: instance × slot × FX_SLOT_PARAMS), `slots` maps each chain
 * slot to an fx id (-1 = empty), `enabled` is per slot. */
export interface FxBulkState {
    params: number[];
    slots: number[];
    enabled: number[];
}

export function setFxParam(instanceId: number, slot: number, param: number, engineValue: number): void {
    if (instanceId < 0 || instanceId >= FX_INSTANCE_COUNT) return;
    if (!Number.isInteger(slot) || slot < 0 || slot >= FX_SLOTS) return;
    if (!Number.isInteger(param) || param < 0 || param >= FX_SLOT_PARAMS) return;
    postWorkletMessage({ type: "fx_set_param", instance_id: instanceId, slot, param, value: engineValue });
}

export function setFxEnabled(instanceId: number, slot: number, enabled: boolean): void {
    if (instanceId < 0 || instanceId >= FX_INSTANCE_COUNT) return;
    if (!Number.isInteger(slot) || slot < 0 || slot >= FX_SLOTS) return;
    postWorkletMessage({ type: "fx_set_enabled", instance_id: instanceId, slot, enabled });
}

/** Load an effect into a chain slot (fxId -1 = empty). Engine-side this
 * resets the slot's params to the new effect's defaults and clears its
 * enabled flag; the worklet runs it in the message handler (not in
 * process()) because the C side creates the DSP objects at set_slot time. */
export function setFxSlot(instanceId: number, slot: number, fxId: number): void {
    if (instanceId < 0 || instanceId >= FX_INSTANCE_COUNT) return;
    if (!Number.isInteger(slot) || slot < 0 || slot >= FX_SLOTS) return;
    if (fxId !== -1 && !isFxId(fxId)) return;
    postWorkletMessage({ type: "fx_set_slot", instance_id: instanceId, slot, fx_id: fxId });
}

/** Move a chain slot's whole content (fx id, params, enabled, DSP) from
 * one chain position to another (array-move, atomic C-side). */
export function moveFxSlot(instanceId: number, from: number, to: number): void {
    if (instanceId < 0 || instanceId >= FX_INSTANCE_COUNT) return;
    if (!Number.isInteger(from) || from < 0 || from >= FX_SLOTS) return;
    if (!Number.isInteger(to) || to < 0 || to >= FX_SLOTS) return;
    postWorkletMessage({ type: "fx_move_slot", instance_id: instanceId, from, to });
}

/** Read one of a slot's output ports (meters, tuner FREQ) — engine value
 * (Hz for the tuner's FREQ port). Resolves 0 on timeout/no worklet; the
 * predicate keys on instance/slot/index so concurrent pollers (one tuner
 * readout per mixer strip) each get their own reply. */
export async function getFxOutParam(instanceId: number, slot: number, index: number): Promise<number> {
    if (!workletNode) return 0;
    if (instanceId < 0 || instanceId >= FX_INSTANCE_COUNT) return 0;
    if (!Number.isInteger(slot) || slot < 0 || slot >= FX_SLOTS) return 0;
    if (!Number.isInteger(index) || index < 0) return 0;
    const replyPromise = awaitReply(
        (m) => typeof m === "object" && m !== null
            && (m as { type?: string }).type === "fx_out_param"
            && (m as { instance_id?: number }).instance_id === instanceId
            && (m as { slot?: number }).slot === slot
            && (m as { index?: number }).index === index,
        1000,
    );
    workletNode.port.postMessage({ type: "fx_get_out_param", instance_id: instanceId, slot, index });
    const raw = await replyPromise;
    if (!raw) return 0;
    const v = (raw as { value?: number }).value;
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export async function getFxState(): Promise<FxBulkState | null> {
    if (!workletNode) return null;
    const replyPromise = awaitReply(
        (m) => typeof m === "object" && m !== null
            && (m as { type?: string }).type === "fx_state",
        5000,
    );
    workletNode.port.postMessage({ type: "fx_get_state" });
    const raw = await replyPromise;
    if (!raw) return null;
    const params = (raw as { params?: number[] }).params;
    const slots = (raw as { slots?: number[] }).slots;
    const enabled = (raw as { enabled?: number[] }).enabled;
    if (!Array.isArray(params) || params.length !== FX_INSTANCE_COUNT * FX_SLOTS * FX_SLOT_PARAMS) return null;
    if (!Array.isArray(slots) || slots.length !== FX_INSTANCE_COUNT * FX_SLOTS) return null;
    if (!Array.isArray(enabled) || enabled.length !== FX_INSTANCE_COUNT * FX_SLOTS) return null;
    return { params, slots, enabled };
}

export async function restoreFxState(state: FxBulkState): Promise<boolean> {
    if (!Array.isArray(state.params) || state.params.length !== FX_INSTANCE_COUNT * FX_SLOTS * FX_SLOT_PARAMS) return false;
    if (!Array.isArray(state.slots) || state.slots.length !== FX_INSTANCE_COUNT * FX_SLOTS) return false;
    if (!Array.isArray(state.enabled) || state.enabled.length !== FX_INSTANCE_COUNT * FX_SLOTS) return false;
    if (!workletNode) return false;
    const replyPromise = awaitReply(
        (m) => typeof m === "object" && m !== null
            && (m as { type?: string }).type === "fx_state_restored",
        10000,
    );
    workletNode.port.postMessage({ type: "fx_restore_state", params: state.params, slots: state.slots, enabled: state.enabled });
    const raw = await replyPromise;
    return !!raw;
}

// ---------------------------------------------------------------------------
// Selection state — UI-only concern.
// ---------------------------------------------------------------------------

export function getObxdSelectedInstance(): number {
    return selectedInstance;
}

export function setObxdSelectedInstance(id: number): void {
    selectedInstance = id;
}

// ---------------------------------------------------------------------------
// Legacy / utility
// ---------------------------------------------------------------------------

export function isObxdReady(): boolean {
    return workletNode !== null;
}

export function getObxdNode(): AudioWorkletNode | null {
    return workletNode;
}

export function getObxdAudioContext(): AudioContext | null {
    return audioContext;
}

// Mixer-engine message log (declared near the top; registered here so the
// listener registry it pushes into is fully initialized — see its comment).
// Guarded for non-browser test environments (vitest runs this module under Node).
if (typeof window !== "undefined") {
    (window as unknown as { __mixerLog: unknown[] }).__mixerLog = mixerLog;
}
addWorkletMessageListener((msg: unknown) => {
    const t = (msg as { type?: string }).type;
    if (typeof t === "string" && t.indexOf("mixer") === 0) {
        mixerLog.push(msg);
        if (mixerLog.length > 50) mixerLog.shift();
    }
});

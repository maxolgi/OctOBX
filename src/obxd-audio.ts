/*
 * obxd-audio.ts — Main-thread bootstrap for the in-browser Obxd synth.
 *
 * Lazily creates an AudioContext under a user gesture (autoplay-policy
 * compliant), loads the AudioWorklet module, instantiates an AudioWorkletNode,
 * and connects it to the destination.
 *
 * Phase 1 (this): sine-wave path. Phase 3 will add real MIDI plumbing via
 * sendObxdMidi(), to be called from the existing drainMidiToHardware loop's
 * onBatchDrained callback (see midi-output.ts).
 *
 * AWP/WASM loading strategy: AudioWorkletGlobalScope forbids importScripts()
 * AND dynamic import(), and Chrome's AWP also lacks XMLHttpRequest. The
 * cleanest path around all of that is to pre-fetch the WASM bytes on the
 * main thread (where fetch is fully functional) and hand them to the
 * AudioWorkletProcessor via its constructor options (`processorOptions`).
 * The processor forwards them to the emcc factory as `wasmBinary`, which
 * skips all of emcc's network-loading code paths.
 */

let audioContext: AudioContext | null = null;
let workletNode: AudioWorkletNode | null = null;
let moduleAdded = false;

// One-shot reply router for worklet messages that need an async response
// (fxp_loaded, param_value). Multiple concurrent callers (e.g. 37
// getObxdParam calls from syncObxdControlsFromEngine) all install their
// predicate into this map instead of swapping port.onmessage, which
// would race and lose replies.
interface PendingReply {
    predicate: (msg: unknown) => boolean;
    resolve: (msg: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
}
const pendingReplies: PendingReply[] = [];
let routerInstalled = false;

function ensureRouter(): void {
    if (routerInstalled || !workletNode) return;
    routerInstalled = true;
    // Use addEventListener (not the onmessage setter) so this never
    // conflicts with code that owns onmessage for the ready handshake.
    workletNode.port.addEventListener("message", (ev: MessageEvent) => {
        const msg = ev.data;
        if (!msg || typeof msg !== "object") return;
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

function awaitReply(predicate: (msg: unknown) => boolean, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            const i = pendingReplies.findIndex((p) => p.predicate === predicate);
            if (i >= 0) pendingReplies.splice(i, 1);
            resolve(null);
        }, timeoutMs);
        pendingReplies.push({ predicate, resolve, timer });
    });
}

export async function setupObxdAudio(): Promise<void> {
    if (workletNode) return;   // already up

    if (!audioContext) {
        const Ctor: typeof AudioContext =
            window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioContext = new Ctor();
    }
    try { await audioContext.resume(); } catch { /* autoplay policy — non-fatal */ }

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

    workletNode = new AudioWorkletNode(audioContext, "obxd-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { wasmBinary },
    });
    workletNode.connect(audioContext.destination);

    // Expose for debugging (analyser taps, state inspection). Remove before shipping.
    (window as unknown as { __obxd?: { ctx: AudioContext; node: AudioWorkletNode } }).__obxd = {
        ctx: audioContext,
        node: workletNode,
    };

    // Await the worklet's `{type:'ready'}` message before resolving. The
    // processor emits ready once emcc's WASM factory has resolved and
    // _obxd_init() has run — until then, set_param / midi messages are
    // dropped by the worklet's onmessage guard (`if (wasmModule && ...)`).
    // Phase 3 relies on this so the panel can apply the default patch
    // immediately after setupObxdAudio() resolves.
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
            if (msg.type !== "ready" && msg.type !== "error" && typeof prevHandler === "function") {
                prevHandler.call(port, ev);
                return;
            }
            if (msg.type === "ready") {
                cleanup();
                // Now that the worklet is up, install the async-reply router
                // for the rest of the session. (Adding the listener earlier
                // is safe too, but we wait for ready so the router doesn't
                // intercept the ready message by accident.)
                ensureRouter();
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
}

/** Phase 1 test hook — sets oscillator frequency directly. */
export function sendObxdNote(freq: number): void {
    workletNode?.port.postMessage({ type: "note", freq });
}

/** Phase 3 will use this from the onBatchDrained handler. */
export function sendObxdMidi(status: number, d1: number, d2: number): void {
    workletNode?.port.postMessage({ type: "midi", status, d1, d2 });
}

export function setObxdGain(value01: number): void {
    workletNode?.port.postMessage({ type: "gain", value: value01 });
}

/*
 * Forward a single ParamsEnum.h index + 0..1 value to the worklet's
 * `set_param` branch, which calls _obxd_set_param(idx, value). The C side
 * clamps and dispatches via apply_param(); unknown indices no-op.
 */
export function setObxdParam(idx: number, value01: number): void {
    workletNode?.port.postMessage({ type: "set_param", idx, value: value01 });
}

/*
 * Phase 4 — load a VST2 .fxp preset file. The bytes are handed to the
 * AudioWorkletProcessor via its MessagePort (we can't share memory with
 * the worklet directly, and emcc was built with -sFORCE_FILESYSTEM=0 so
 * FS.writeFile isn't available inside the worklet). The worklet copies
 * the bytes into WASM heap via _malloc + HEAPU8.set and calls
 * _obxd_load_fxp(ptr, len).
 *
 * Resolves with `{success, name}` — name is the program name parsed
 * from the .fxp header (or empty on failure). Rejects only if no
 * worklet is connected.
 */
export function loadObxdFxp(bytes: Uint8Array): Promise<{ success: boolean; name: string; rc: number }> {
    return new Promise((resolve, reject) => {
        if (!workletNode) {
            reject(new Error("obxd worklet not initialized"));
            return;
        }
        const port = workletNode.port;
        // Race the worklet reply against a 5s timeout. The router
        // correlates via msg.type === "fxp_loaded".
        awaitReply(
            (m) => typeof m === "object" && m !== null && (m as { type?: string }).type === "fxp_loaded",
            5000,
        ).then((raw) => {
            if (!raw) {
                resolve({ success: false, name: "", rc: -200 });
                return;
            }
            const msg = raw as { success?: boolean; name?: string; rc?: number };
            resolve({ success: !!msg.success, name: String(msg.name || ""), rc: Number(msg.rc ?? -1) });
        });
        // Transfer the underlying buffer to avoid a copy across the
        // structured-clone boundary. The Uint8Array is unusable on this
        // thread afterwards — callers should not retain a reference.
        const copy = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        port.postMessage({ type: "load_fxp", bytes: copy }, [copy.buffer]);
    });
}

/* Hard silence — allSoundOff (resets envelopes too, no release tail). */
export function obxdPanic(): void {
    workletNode?.port.postMessage({ type: "panic" });
}

/* Re-apply the engine's built-in defaults (clears the loaded .fxp). */
export function obxdResetPatch(): void {
    workletNode?.port.postMessage({ type: "reset_patch" });
}

/* Note-off only — preserves release tails. */
export function obxdAllNotesOff(): void {
    workletNode?.port.postMessage({ type: "all_notes_off" });
}

/*
 * Query the engine's current value for a single ParamsEnum.h index.
 * Resolves to the 0..1 value (or -1 if the index is out of range / the
 * engine isn't initialized). Used by the knob UI to seed positions after
 * applyObxdDefaultPatch() or a .fxp load.
 */
export async function getObxdParam(idx: number): Promise<number> {
    if (!workletNode) return -1;
    const port = workletNode.port;
    // Install the predicate FIRST so a fast reply can't be missed.
    const replyPromise = awaitReply(
        (m) => typeof m === "object" && m !== null
            && (m as { type?: string }).type === "param_value"
            && (m as { idx?: number }).idx === idx,
        2000,
    );
    port.postMessage({ type: "get_param", idx });
    const raw = await replyPromise;
    if (!raw) return -1;
    return Number((raw as { value?: number }).value ?? -1);
}

/*
 * Default ADSR + filter patch applied on synth power-on. apply_defaults()
 * in main_obxd.cpp already seeds a dual-saw patch with full-level sustain
 * (LSUS = 1.0) and zero attack/decay/release — bright but very percussive.
 *
 * Override here for pleasant step-sequencer behaviour out of the box: a
 * softer attack, moderate decay, slightly relaxed sustain, and a useful
 * release tail so notes ring out cleanly between steps. Cutoff/resonance
 * and filter-envelope amount are nudged off the apply_defaults() values
 * for a more synth-pad character.
 *
 * Indices match ParamsEnum.h (third_party/Obxd/Source/Engine/ParamsEnum.h).
 */
export function applyObxdDefaultPatch(): void {
    if (!workletNode) return;
    const VOICE_COUNT = 3;     // Polyphony cap. SynthEngine maps 0..1 to ~1..32 voices.
                               // Default apply_defaults() sets 1.0 (max) which is too
                               // CPU-heavy for a 48 kHz / 128-sample AWP quantum and
                               // causes clicks on sustained notes. 0.25 → ~8 voices.
    const LATK = 51;          // Loudness envelope attack
    const LDEC = 52;          // Loudness envelope decay
    const LSUS = 53;          // Loudness envelope sustain
    const LREL = 54;          // Loudness envelope release
    const CUTOFF = 44;        // Filter cutoff
    const RESONANCE = 45;     // Filter resonance
    const ENVELOPE_AMT = 50;  // Filter envelope amount

    setObxdParam(VOICE_COUNT, 0.25);
    setObxdParam(LATK, 0.2);
    setObxdParam(LDEC, 0.4);
    setObxdParam(LSUS, 0.7);
    setObxdParam(LREL, 0.55);
    setObxdParam(CUTOFF, 0.5);
    setObxdParam(RESONANCE, 0.3);
    setObxdParam(ENVELOPE_AMT, 0.3);
    console.log("[obxd] default patch applied (~8 voices, ADSR + filter)");
}

export function isObxdReady(): boolean {
    return workletNode !== null;
}

export function getObxdNode(): AudioWorkletNode | null {
    return workletNode;
}

export function getObxdAudioContext(): AudioContext | null {
    return audioContext;
}

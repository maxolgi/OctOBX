/*
 * octopus-awp.ts — Main-thread controller for the Octopus sequencer engine
 * running INSIDE the combined OB-Xf AudioWorkletProcessor.
 *
 * Architecture (sequencer-in-worklet refactor):
 *
 *   - The Octopus WASM engine is instantiated inside the SAME AudioWorklet
 *     as the OB-Xf synth (see obxd-processor.tail.js, oct_* handlers). It
 *     is built with -sIMPORTED_MEMORY over a fixed 128 MiB shared
 *     WebAssembly.Memory created HERE on the main thread and handed to the
 *     worklet via processorOptions. Because the memory is shared and can
 *     never grow (fixed 2048 × 64 KiB pages), the main thread can hold
 *     permanent typed-array views straight into engine memory: the 170-byte
 *     processed MIR grid and the int32/float64 status block are read
 *     ZERO-COPY for every frame of UI rendering. No message passing, no
 *     copies, no stale views.
 *
 *   - Sequencer timing is sample-accurate: the worklet's process() calls
 *     octopus_pump() once per 128-sample quantum while the context is
 *     running, so the 48-PPQN tick clock advances on the audio thread.
 *
 *   - RAF fallback pump: process() does NOT run while the AudioContext is
 *     suspended — and it is guaranteed suspended until the first user
 *     gesture (autoplay policy). Before that gesture (and any time the
 *     context gets suspended again), a requestAnimationFrame loop on the
 *     main thread posts {type:'oct_pump', ms} with the clamped elapsed
 *     wall-clock delta so the engine keeps ticking at display rate. The
 *     loop stops itself as soon as the context reports 'running' and is
 *     restarted by a 'statechange' listener if the context is suspended
 *     again. Without this, the engine would be dead on arrival: no ticks,
 *     no MIR updates, nothing playable until the first click.
 *
 * Message contract (mirrored by the oct_* handlers in
 * obxd-processor.tail.js):
 *
 *   worklet → main: oct_ready {mirPtr, processedMirPtr, statusPtr},
 *     oct_state_saved {bytes} (internal GRID+PGM saves), oct_state_bytes
 *     {bytes|null} (saveState reply), oct_state_loaded {ok},
 *     oct_snapshot {mir, runBit, tempo, zoom, tickCount}.
 *
 *   main → worklet: oct_key, oct_rotary, oct_transport, oct_pause,
 *     oct_tempo, oct_zoom, oct_midi_in, oct_pump, oct_save_state,
 *     oct_load_state, oct_shutdown, oct_snapshot.
 *
 * Status block layout at statusPtr (int32 view): [0]=engine_ready,
 * [1]=run_bit, [2]=tempo, [3]=zoom_level, [4]=tick_count,
 * [5]=midi_dropped, [6]=midi_synth_dropped; Float64 at byte offset +32 =
 * tick_ns.
 */

import { idbLoadProject } from "./idb-projects";
import {
    setupObxdAudio,
    addWorkletMessageListener,
    getObxdNode,
    getObxdAudioContext,
} from "./obxd-audio";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OctopusStatusView {
    engineReady(): number;
    runBit(): number;
    tempo(): number;
    zoom(): number;
    tickCount(): number;
    tickNs(): number;
    midiDropped(): number;
}

export interface OctopusController {
    /** Resolves once the worklet reports oct_ready (views are live then). */
    readonly ready: Promise<void>;
    key(keyNdx: number, press: boolean | number): void;
    rotary(idx: number, dir: number): void;
    transport(running: boolean): void;
    pause(): void;
    setTempo(bpm: number): void;
    setZoom(level: number): void;
    midiInput(status: number, d1: number, d2: number): void;
    saveState(): Promise<Uint8Array | null>;
    loadState(bytes: Uint8Array): Promise<boolean>;
    shutdown(): void;
    onInternalSave(cb: (bytes: Uint8Array) => void): void;
    /** 170-byte processed-MIR view into shared WASM memory (live,
     * refreshed by the worklet's pump — read, don't write). Returns a
     * zero-filled dummy until oct_ready. */
    mir(): Uint8Array;
    readonly status: OctopusStatusView;
}

/** Test-only snapshot payload (worklet copies MIR + status into plain JS). */
export interface OctopusSnapshot {
    mir: number[];
    runBit: number;
    tempo: number;
    zoom: number;
    tickCount: number;
}

declare global {
    interface Window {
        __octopus?: OctopusController;
    }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OCT_MIR_BYTES = 170;            // MIR[2][17][5]
const OCT_STATUS_INTS = 8;            // int32 slots at statusPtr
const OCT_STATUS_TICK_NS_OFFSET = 32; // Float64 tick_ns at byte offset +32
// 2048 × 64 KiB = 128 MiB. The C module is built with -sIMPORTED_MEMORY and
// no growth, so the main thread creates the one and only memory here.
const OCT_WASM_PAGES = 2048;
const REPLY_TIMEOUT_MS = 3000;

// Mirrors ACTIVE_PROJECT_KEY in state-persistence.ts (not exported there;
// keep the literal in sync).
const ACTIVE_PROJECT_KEY = "octobx:active_project";
const DEFAULT_PROJECT_NAME = "Default";

// ---------------------------------------------------------------------------
// Module state (single engine, single boot — see bootOctopusEngine)
// ---------------------------------------------------------------------------

let octopusMemory: WebAssembly.Memory | null = null;
let octReady = false;

// Zero dummies until oct_ready swaps in the real shared-memory views. The
// memory is fixed-size (no growth), so the live views never go stale.
let mirView = new Uint8Array(OCT_MIR_BYTES);
let statusI32 = new Int32Array(OCT_STATUS_INTS);
let statusF64 = new Float64Array(1);

let readyResolve: (() => void) | null = null;
let readyReject: ((err: Error) => void) | null = null;
const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
});

// One-slot pending resolvers, latest wins: a superseded caller simply times
// out to its failure value. There is no instance id — the app has exactly
// one Octopus engine, so concurrent same-type requests don't exist in
// practice.
interface PendingSlot<T> {
    resolve: (value: T) => void;
    timer: ReturnType<typeof setTimeout>;
}
let pendingSave: PendingSlot<Uint8Array | null> | null = null;
let pendingLoad: PendingSlot<boolean> | null = null;
let pendingSnapshot: PendingSlot<OctopusSnapshot | null> | null = null;

// Internal-save subscribers (GRID+PGM saves performed on the machine UI).
const internalSaveCallbacks: Array<(bytes: Uint8Array) => void> = [];

let booted: Promise<OctopusController> | null = null;

// ---------------------------------------------------------------------------
// Fire-and-forget sending
// ---------------------------------------------------------------------------

let lastDropWarnAt = 0;

/*
 * Post a message to the engine inside the worklet. Messages sent before
 * oct_ready (or with no worklet node at all) are DROPPED, not buffered:
 * boot finishes before any panel is built, so real UI input cannot arrive
 * earlier. A rate-limited console.warn keeps dropped sends visible when
 * debugging without spamming the console on every frame.
 */
function postToEngine(msg: Record<string, unknown>): boolean {
    const node = getObxdNode();
    if (!node || !octReady) {
        const now = performance.now();
        if (now - lastDropWarnAt >= 5000) {
            lastDropWarnAt = now;
            console.warn(`[octopus-awp] dropped '${String(msg.type)}' (worklet/engine not ready)`);
        }
        return false;
    }
    node.port.postMessage(msg);
    return true;
}

function settleSlot<T>(slot: PendingSlot<T> | null, value: T): PendingSlot<T> | null {
    if (!slot) return null;
    clearTimeout(slot.timer);
    slot.resolve(value);
    return null;
}

// ---------------------------------------------------------------------------
// Worklet message handling
// ---------------------------------------------------------------------------

function handleWorkletMessage(msg: unknown): void {
    if (!msg || typeof msg !== "object") return;
    const m = msg as {
        type?: string;
        mirPtr?: number;
        processedMirPtr?: number;
        statusPtr?: number;
        bytes?: Uint8Array | null;
        ok?: boolean;
        mir?: number[];
        runBit?: number;
        tempo?: number;
        zoom?: number;
        tickCount?: number;
        message?: string;
    };

    switch (m.type) {
        case "oct_ready": {
            const memory = octopusMemory;
            const processed = Number(m.processedMirPtr) || 0;
            const statusPtr = Number(m.statusPtr) || 0;
            if (!memory || !processed || !statusPtr) {
                readyReject?.(new Error("malformed oct_ready message from worklet"));
                return;
            }
            mirView = new Uint8Array(memory.buffer, processed, OCT_MIR_BYTES);
            statusI32 = new Int32Array(memory.buffer, statusPtr, OCT_STATUS_INTS);
            statusF64 = new Float64Array(memory.buffer, statusPtr + OCT_STATUS_TICK_NS_OFFSET, 1);
            octReady = true;
            console.log(`[octopus-awp] engine ready in worklet (mir=${processed}, status=${statusPtr})`);
            readyResolve?.();
            startPumpLoop();
            break;
        }

        case "oct_state_saved": {
            // Internal save (GRID+PGM on the machine UI). Fan the bytes out
            // to every subscriber; iterate a copy so a callback that
            // (un)registers mid-iteration can't skip entries.
            const bytes = m.bytes;
            if (bytes instanceof Uint8Array && bytes.length > 0) {
                for (const cb of internalSaveCallbacks.slice()) {
                    try {
                        cb(bytes);
                    } catch (e) {
                        console.warn("[octopus-awp] internal-save callback threw", e);
                    }
                }
            }
            break;
        }

        case "oct_state_bytes": {
            pendingSave = settleSlot(pendingSave, m.bytes instanceof Uint8Array ? m.bytes : null);
            break;
        }

        case "oct_state_loaded": {
            pendingLoad = settleSlot(pendingLoad, !!m.ok);
            break;
        }

        case "oct_snapshot": {
            const snap: OctopusSnapshot = {
                mir: Array.isArray(m.mir) ? m.mir.map(Number) : [],
                runBit: Number(m.runBit) || 0,
                tempo: Number(m.tempo) || 0,
                zoom: Number(m.zoom) || 0,
                tickCount: Number(m.tickCount) || 0,
            };
            pendingSnapshot = settleSlot<OctopusSnapshot | null>(pendingSnapshot, snap);
            break;
        }

        case "error": {
            // Defensive: a worklet init failure that lands after the obxd
            // 'ready' handshake would otherwise leave our ready promise
            // dangling forever.
            if (!octReady) {
                readyReject?.(new Error(String(m.message || "octopus worklet init failed")));
            }
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// RAF fallback pump
// ---------------------------------------------------------------------------

let pumpActive = false;
let pumpLast = 0;

/*
 * WHY: process() does not run while the AudioContext is suspended, and the
 * context is guaranteed suspended until the first user gesture (autoplay
 * policy). Without this loop the engine would be dead on arrival — no
 * ticks, no MIR refresh. While the context is not 'running' we post
 * {type:'oct_pump', ms} per animation frame with the elapsed wall-clock
 * delta (clamped to [1,100] ms so a background-tab RAF pause can't make
 * the engine lunge). The loop stops itself once the context runs (process()
 * takes over ticking at quantum accuracy) and is restarted by the
 * 'statechange' listener below if the context is suspended again.
 */
function startPumpLoop(): void {
    if (pumpActive) return;
    pumpActive = true;
    pumpLast = performance.now();
    requestAnimationFrame(pumpFrame);
}

function pumpFrame(): void {
    if (!pumpActive) return;
    const ctx = getObxdAudioContext();
    if (ctx && ctx.state === "running") {
        pumpActive = false;
        return;
    }
    const now = performance.now();
    const ms = Math.min(100, Math.max(1, now - pumpLast));
    pumpLast = now;
    // Keep measuring even before oct_ready (so the first real pump carries
    // an accurate delta), but don't post — pre-ready messages are dropped.
    if (octReady) {
        postToEngine({ type: "oct_pump", ms });
    }
    requestAnimationFrame(pumpFrame);
}

function attachContextStateListener(): void {
    const ctx = getObxdAudioContext();
    if (!ctx) return;
    ctx.addEventListener("statechange", () => {
        if (ctx.state !== "running") startPumpLoop();
    });
}

// ---------------------------------------------------------------------------
// Request/reply operations
// ---------------------------------------------------------------------------

function saveState(): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
        const slot: PendingSlot<Uint8Array | null> = {
            resolve,
            timer: setTimeout(() => resolve(null), REPLY_TIMEOUT_MS),
        };
        pendingSave = slot;
        if (!postToEngine({ type: "oct_save_state" })) {
            pendingSave = settleSlot<Uint8Array | null>(pendingSave, null);
        }
    });
}

/*
 * Bytes are structured-cloned to the worklet (no transfer) — the caller
 * keeps ownership of the Uint8Array. Loading is rare, so the copy is
 * irrelevant next to the safety.
 */
function loadState(bytes: Uint8Array): Promise<boolean> {
    return new Promise((resolve) => {
        const slot: PendingSlot<boolean> = {
            resolve,
            timer: setTimeout(() => resolve(false), REPLY_TIMEOUT_MS),
        };
        pendingLoad = slot;
        if (!postToEngine({ type: "oct_load_state", bytes })) {
            pendingLoad = settleSlot<boolean>(pendingLoad, false);
        }
    });
}

/** Test-only: one-shot MIR + status copy from the worklet (3s timeout → null). */
function snapshot(): Promise<OctopusSnapshot | null> {
    return new Promise((resolve) => {
        const slot: PendingSlot<OctopusSnapshot | null> = {
            resolve,
            timer: setTimeout(() => resolve(null), REPLY_TIMEOUT_MS),
        };
        pendingSnapshot = slot;
        if (!postToEngine({ type: "oct_snapshot" })) {
            pendingSnapshot = settleSlot<OctopusSnapshot | null>(pendingSnapshot, null);
        }
    });
}

// ---------------------------------------------------------------------------
// Controller assembly + boot
// ---------------------------------------------------------------------------

const statusView: OctopusStatusView = {
    engineReady: () => statusI32[0],
    runBit: () => statusI32[1],
    tempo: () => statusI32[2],
    zoom: () => statusI32[3],
    tickCount: () => statusI32[4],
    tickNs: () => statusF64[0],
    midiDropped: () => statusI32[5],
};

/*
 * Read the ACTIVE project's Octopus bytes for the initial engine state.
 * Every failure path resolves null (fresh boot) — persistence problems must
 * never block or kill the boot.
 */
async function readInitialState(): Promise<Uint8Array | null> {
    try {
        let name = DEFAULT_PROJECT_NAME;
        try {
            const stored = localStorage.getItem(ACTIVE_PROJECT_KEY);
            if (stored) name = stored;
        } catch {
            // localStorage unavailable (privacy mode) — fall through with default
        }
        const project = await idbLoadProject(name);
        return project?.octopusState ?? null;
    } catch (e) {
        console.warn("[octopus-awp] initial state load failed; booting fresh", e);
        return null;
    }
}

export async function bootOctopusEngine(): Promise<OctopusController> {
    if (booted) return booted;

    const attempt = (async (): Promise<OctopusController> => {
        if (typeof SharedArrayBuffer === "undefined") {
            throw new Error(
                "SharedArrayBuffer not available — the Octopus engine requires cross-origin isolation " +
                "(COOP/COEP headers on a secure context). Start the app via the COOP/COEP-enabled server.",
            );
        }

        // The one and only engine memory: shared, fixed 128 MiB. Created on
        // the main thread so both sides can map views over it; the WASM
        // module imports it (-sIMPORTED_MEMORY).
        octopusMemory = new WebAssembly.Memory({
            initial: OCT_WASM_PAGES,
            maximum: OCT_WASM_PAGES,
            shared: true,
        });

        // Cache-busted fetch, same strategy as the obxd binary — the bytes
        // go in via processorOptions because fetch/XHR are unreliable inside
        // AudioWorkletGlobalScope.
        const response = await fetch(`/octopus_wasm.wasm?v=${Date.now()}`);
        if (!response.ok) {
            throw new Error(`Failed to fetch octopus_wasm.wasm: HTTP ${response.status}`);
        }
        const octopusWasmBinary = await response.arrayBuffer();

        const nosync = new URLSearchParams(window.location.search).has("nosync");
        const octopusInitialState = nosync ? null : await readInitialState();

        // Register our listener BEFORE setupObxdAudio creates the node: the
        // octopus engine initializes inside the worklet during setup's own
        // 'ready' await window, and oct_ready could fire before setup
        // resolves. addWorkletMessageListener buffers callbacks until the
        // port exists, so this ordering never misses the handshake.
        addWorkletMessageListener(handleWorkletMessage);

        // Creates the combined worklet node (idempotent — a no-op if the
        // OB-Xf rack already brought it up without octopus assets; in that
        // case the octopus half joins via this same call's assets).
        await setupObxdAudio({ octopusWasmBinary, octopusMemory, octopusInitialState });

        attachContextStateListener();
        startPumpLoop();

        const controller: OctopusController & { snapshot(): Promise<OctopusSnapshot | null> } = {
            ready: readyPromise,
            key: (keyNdx, press) => postToEngine({ type: "oct_key", key: keyNdx, press: press ? 1 : 0 }),
            rotary: (idx, dir) => postToEngine({ type: "oct_rotary", idx, dir }),
            transport: (running) => postToEngine({ type: "oct_transport", running: running ? 1 : 0 }),
            pause: () => postToEngine({ type: "oct_pause" }),
            setTempo: (bpm) => postToEngine({ type: "oct_tempo", bpm }),
            setZoom: (level) => postToEngine({ type: "oct_zoom", level }),
            midiInput: (status, d1, d2) => postToEngine({ type: "oct_midi_in", status, d1, d2 }),
            saveState,
            loadState,
            shutdown: () => postToEngine({ type: "oct_shutdown" }),
            onInternalSave: (cb) => { internalSaveCallbacks.push(cb); },
            mir: () => mirView,
            status: statusView,
            snapshot,
        };

        // Debug/test handle — the Chromium verification suite drives the
        // engine through this from the page context.
        window.__octopus = controller;

        console.log("[octopus-awp] boot complete (engine handshaking in worklet)");
        return controller;
    })();

    booted = attempt;
    // Allow a retry after a failed boot (e.g. transient fetch failure)
    // instead of caching the rejection forever.
    attempt.catch(() => { if (booted === attempt) booted = null; });
    return attempt;
}

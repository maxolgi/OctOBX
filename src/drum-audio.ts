/*
 * drum-audio.ts — Main-thread audio bootstrap for the OB-Xf drum mode.
 *
 * The drum kit lives on the dedicated OB-Xf instance 9 (DRUM_INSTANCE),
 * which runs inside the SAME AudioWorklet as the other 9 melodic
 * instances. This module does NOT create its own AudioWorklet — it talks
 * to instance 9 through the shared OB-Xf worklet node exposed by
 * obxd-audio.ts.
 *
 * obxd-audio.ts owns the AudioWorkletNode privately and exposes only
 * typed per-message wrappers; there is no generic instance-send helper
 * and no PCM wrappers. We therefore reach the node via getObxdNode()
 * and post the PCM messages directly on its port (the same internal
 * pattern every wrapper there uses). Every worklet message MUST carry
 * instance_id: DRUM_INSTANCE — the processor reads msg.instance_id to
 * dispatch (see obxd-processor.tail.js).
 */

import type { DrumKit, DrumPad, DrumLayer } from "./drum-state";
import { isLayerPlayed } from "./drum-state";
import {
    getObxdAudioContext,
    getObxdNode,
    sendObxdInstanceMidi,
    setObxdInstanceParam,
} from "./obxd-audio";

export const DRUM_INSTANCE = 9;  // fixed OB-Xf instance reserved for drums

// Legacy ParamsEnum.h indices used to configure the engine for sample
// playback (sources: obxf-param-mappings.ts — frozen ObxdParam enum).
const LEGACY_OSC1_MIX = 40;       // OSC1MIX      -> Osc1Mix
const LEGACY_OSC2_MIX = 41;       // OSC2MIX      -> Osc2Mix
const LEGACY_NOISE_MIX = 42;      // NOISEMIX     -> NoiseMix
const LEGACY_CUTOFF = 44;         // CUTOFF       -> FilterCutoff
const LEGACY_RESONANCE = 45;      // RESONANCE    -> FilterResonance
const LEGACY_MULTIMODE = 46;      // MULTIMODE    -> FilterMode
const LEGACY_AMP_ATTACK = 51;     // LATK         -> AmpEnvAttack
const LEGACY_AMP_DECAY = 52;      // LDEC         -> AmpEnvDecay
const LEGACY_AMP_SUSTAIN = 53;    // LSUS         -> AmpEnvSustain
const LEGACY_AMP_RELEASE = 54;    // LREL         -> AmpEnvRelease

// Module-level cache.
//   sampleCache: full sample URL -> decoded mono PCM, so the same sample
//   shared by several pads/layers is decoded only once.
const sampleCache = new Map<string, Float32Array>();

let audioContext: AudioContext | null = null;

/*
 * Promise chain that serializes concurrent loadDrumKit calls. Without it,
 * two interleaved loads (one fetch-yields between clearPcm and the
 * load_pcm posts) would each _malloc a PCM buffer on the C side, and the
 * second's pointer overwrite would leak the first's buffer —
 * loadPcmSample unconditionally overwrites pcmBank[pad][layer].data
 * without freeing the prior value. Chaining every load after the previous
 * one resolves closes the re-entrancy window.
 */
let kitLoadChain: Promise<void> = Promise.resolve();

/*
 * Lazily obtain an AudioContext. Prefer the shared one owned by the OB-Xf
 * audio bootstrap (so decode uses the same sample rate the worklet will
 * render at); only create our own if that hasn't been brought up yet.
 * decodeAudioData() works on a suspended context, so we do NOT resume it.
 */
function getOrCreateAudioContext(): AudioContext {
    if (audioContext) return audioContext;
    const shared = getObxdAudioContext();
    if (shared) {
        audioContext = shared;
        return shared;
    }
    const Ctor: typeof AudioContext = window.AudioContext || window.webkitAudioContext!;
    audioContext = new Ctor();
    return audioContext;
}

/*
 * Decode an encoded ArrayBuffer (OGG/WAV/...) to mono Float32 PCM by
 * averaging all channels. Averaging is preferred over taking channel 0
 * alone so stereo samples keep their combined energy.
 */
async function decodeToMono(buf: ArrayBuffer, ctx: AudioContext): Promise<Float32Array> {
    const audioBuf = await ctx.decodeAudioData(buf);
    const chs = audioBuf.numberOfChannels;
    const len = audioBuf.length;
    const out = new Float32Array(len);
    for (let c = 0; c < chs; c++) {
        const data = audioBuf.getChannelData(c);
        for (let i = 0; i < len; i++) out[i] += data[i];
    }
    if (chs > 1) {
        for (let i = 0; i < len; i++) out[i] /= chs;
    }
    return out;
}

/*
 * Post a PCM/worklet message to the drum instance. No-ops (like the rest
 * of obxd-audio.ts) when the worklet hasn't been brought up yet.
 */
function postDrum(msg: object): void {
    const node = getObxdNode();
    if (!node) return;
    node.port.postMessage(msg);
}

function clearPcm(): void {
    postDrum({ type: "clear_pcm", instance_id: DRUM_INSTANCE });
}

function sendLayerParams(pad: number, layer: number, lyr: DrumLayer): void {
    postDrum({
        type: "set_pcm_layer",
        instance_id: DRUM_INSTANCE,
        pad,
        layer,
        gain: lyr.gain,
        cutoff: lyr.filterCutoff,
        res: lyr.filterResonance,
        mode: lyr.filterMode,
        aA: lyr.ampAttack,
        aD: lyr.ampDecay,
        aS: lyr.ampSustain,
        aR: lyr.ampRelease,
        pan: lyr.pan,
        pitch: Math.pow(2, (lyr.pitch - 0.5) * 2),
    });
}

/*
 * Seed the per-layer drum param store (the one setDrumLayerParam writes
 * to on instance 9) from a kit layer's filter/amp fields, so the editor
 * UI reflects the loaded kit's values rather than whatever the C-side
 * mirror defaulted to. sendLayerParams already pushes the same fields
 * to the set_pcm_layer message (which configures the live voice), but
 * the param store the editor reads from is a separate mirror — both
 * must be seeded together on load. Called from loadDrumKit right after
 * each set_pcm_layer message.
 */
function seedLayerMirror(pad: number, layer: number, lyr: DrumLayer): void {
    setDrumLayerParam(pad, layer, LEGACY_CUTOFF, lyr.filterCutoff);
    setDrumLayerParam(pad, layer, LEGACY_RESONANCE, lyr.filterResonance);
    setDrumLayerParam(pad, layer, LEGACY_MULTIMODE, lyr.filterMode);
    setDrumLayerParam(pad, layer, LEGACY_AMP_ATTACK, lyr.ampAttack);
    setDrumLayerParam(pad, layer, LEGACY_AMP_DECAY, lyr.ampDecay);
    setDrumLayerParam(pad, layer, LEGACY_AMP_SUSTAIN, lyr.ampSustain);
    setDrumLayerParam(pad, layer, LEGACY_AMP_RELEASE, lyr.ampRelease);
}

/*
 * Configure instance 9 for drum (sample-playback) mode: silence the
 * oscillator/noise paths and open the amp envelope. Unison stays OFF
 * (its default) — drum layers come from the engine's separate
 * voice-per-layer allocation, not from unison.
 * Each param is sent through the legacy setObxdInstanceParam path and
 * wrapped so a single failed dispatch can't abort the whole init.
 *
 * After a state-restore round-trip these same writes (plus polyphony=32)
 * are re-applied ENGINE-SIDE as stage 4 of obxd_restore_stage (see
 * wasm/obxd/main_obxd.cpp) — the old JS reassertDrumInstanceStructural
 * wrapper was removed once the C side owned the ordering.
 */
export async function initDrumMode(): Promise<void> {
    const set = (idx: number, v: number): void => {
        try { setObxdInstanceParam(DRUM_INSTANCE, idx, v); }
        catch (e) { console.warn("[drum] setObxdInstanceParam", idx, "failed:", e); }
    };

    set(LEGACY_OSC1_MIX, 0.0);
    set(LEGACY_OSC2_MIX, 0.0);
    set(LEGACY_NOISE_MIX, 0.0);
    set(LEGACY_AMP_ATTACK, 0.0);
    set(LEGACY_AMP_RELEASE, 0.3);

    console.info("[drum] instance " + DRUM_INSTANCE + " configured for drum mode");
}

/*
 * Resolve the full fetch URL for a layer's sample. Layers whose sourceUrl is
 * set (via the layer-editor sample-kit dropdown) load from that kit's CDN
 * prefix; layers whose sourceUrl is undefined (factory kit templates +
 * pre-feature saved state) fall back to the currently-loaded kit's source,
 * preserving the legacy behavior.
 */
function layerSampleUrl(lyr: DrumLayer, kitSource: string): string {
    const source = lyr.sourceUrl ?? kitSource;
    return source + lyr.sampleName + ".ogg";
}

/*
 * Load a full drum kit into instance 9: clear existing PCM, fetch + decode
 * each unique enabled sample once, push the PCM + per-layer params, then
 * wire up note mapping, layer counts, and choke groups.
 */
async function loadDrumKitImpl(kit: DrumKit): Promise<void> {
    clearPcm();

    const ctx = getOrCreateAudioContext();

    // Collect unique enabled sample URLs (dedup across pads/layers AND across
    // mixed kit sources — two layers can share a sampleName but point at
    // different kit sourceUrl prefixes, so the URL is the correct dedup key).
    const sampleUrls = new Set<string>();
    for (const pad of kit.pads) {
        for (const lyr of pad.layers) {
            if (lyr.enabled === false) continue;
            if (lyr.sampleName) sampleUrls.add(layerSampleUrl(lyr, kit.source));
        }
    }

    // Fetch + decode each unique sample URL once.
    const decoded = new Map<string, Float32Array>();
    for (const url of sampleUrls) {
        let pcm: Float32Array | undefined = sampleCache.get(url);
        if (!pcm) {
            try {
                const resp = await fetch(url);
                if (!resp.ok) {
                    console.warn("[drum] fetch failed", url, resp.status);
                    continue;
                }
                pcm = await decodeToMono(await resp.arrayBuffer(), ctx);
                sampleCache.set(url, pcm);
            } catch (e) {
                console.warn("[drum] decode failed", url, e);
                continue;
            }
        }
        decoded.set(url, pcm);
    }

    // Push PCM + layer params for every pad's enabled layers.
    for (let p = 0; p < kit.pads.length; p++) {
        const pad = kit.pads[p];

        // loadedIdx is the DENSE layer index the C engine expects: enabled
        // layers are packed at 0, 1, 2, ... so skipping a disabled/failed
        // layer doesn't leave a hole. setNoteOn's PCM path assigns layers
        // 0..count-1 sequentially, so a sparse `l` here would point at a
        // null pcmBank slot and play silence. After the loop, loadedIdx
        // equals the number of layers actually loaded (== count).
        let loadedIdx = 0;
        for (let l = 0; l < pad.layers.length; l++) {
            const lyr = pad.layers[l];
            const url = lyr.sampleName ? layerSampleUrl(lyr, kit.source) : null;
            const pcm = url ? decoded.get(url) : undefined;
            // isLayerPlayed is the shared dense-packing predicate (drum-state.ts);
            // the extra !pcm guard drops layers whose sample failed to decode.
            if (!isLayerPlayed(lyr) || !pcm) continue;
            postDrum({
                type: "load_pcm",
                instance_id: DRUM_INSTANCE,
                pad: p,
                layer: loadedIdx,
                pcmL: pcm,
                frames: pcm.length,
            });
            // The C side stores all layer params together, so the full
            // set_pcm_layer is sent alongside the PCM it configures.
            sendLayerParams(p, loadedIdx, lyr);
            // Seed the per-layer param store the editor reads from so the
            // kit's filter/amp values appear on knob load / instance switch.
            // Only seed once per layer — subsequent reloads (triggered by
            // layer toggles or sample swaps) must NOT overwrite user edits
            // stored in g_drum_layer_params.
            if (!lyr._seeded) {
                seedLayerMirror(p, loadedIdx, lyr);
                lyr._seeded = true;
            }
            loadedIdx++;
        }

        postDrum({ type: "set_pcm_note_map", instance_id: DRUM_INSTANCE, note: pad.midiNote, pad: p });

        postDrum({ type: "set_pcm_layer_count", instance_id: DRUM_INSTANCE, pad: p, count: loadedIdx });

        postDrum({ type: "set_pcm_choke", instance_id: DRUM_INSTANCE, pad: p, group: pad.chokeGroup });
    }

    console.info("[drum] kit loaded:", kit.pads.length, "pads");
}

/*
 * Serialize concurrent kit loads onto kitLoadChain. Each call waits for
 * the previous load to finish before running loadDrumKitImpl, closing the
 * re-entrancy window where two interleaved fetches would each _malloc a
 * PCM buffer and the second overwrite would leak the first. The stored
 * chain swallows rejections so one failed load can't permanently stall
 * subsequent ones; the returned promise still reflects the real outcome
 * for the caller.
 */
export function loadDrumKit(kit: DrumKit): Promise<void> {
    const run = kitLoadChain.then(() => loadDrumKitImpl(kit));
    kitLoadChain = run.then(noop, noop);
    return run;
}

function noop(): void { /* keep the chain alive on rejection */ }

/*
 * Re-send the full set_pcm_layer message for one pad/layer (the C side
 * stores all layer params together, so partial updates aren't possible).
 */
export function setLayerParam(pad: number, layer: number, lyr: DrumLayer): void {
    sendLayerParams(pad, layer, lyr);
}

/*
 * Push a single legacy ParamsEnum.h index + 0..1 value into a drum
 * pad/layer's param store on instance 9 (DRUM_INSTANCE). The worklet
 * routes this to the per-layer mirror the drum voice reads from —
 * separate from the synth-wide set_param path used by initDrumMode.
 * Posts through the same getObxdNode().port path every other message
 * in this file uses (postDrum); no-ops when the worklet isn't up yet.
 */
export function setDrumLayerParam(pad: number, layer: number, idx: number, value: number): void {
    postDrum({
        type: "set_drum_layer_param",
        instance_id: DRUM_INSTANCE,
        pad,
        layer,
        idx,
        value,
    });
}

/*
 * Read back a single legacy ParamsEnum.h value from a drum pad/layer's
 * param store on instance 9 (DRUM_INSTANCE). Resolves to the 0..1
 * value, or -1 on timeout / no worklet / out-of-range index. Mirrors
 * getObxdInstanceParam's one-shot-predicate + 2s-timeout pattern
 * (correlating by pad+layer+idx so concurrent queries for different
 * layers don't cross-reply). obxd-audio.ts's awaitReply router is not
 * exported, so we install our own one-shot addEventListener listener
 * on the worklet port and remove it as soon as it claims the matching
 * reply (or on timeout). The permanent ensureRouter() listener in
 * obxd-audio.ts has no predicate for "drum_layer_param_value", so it
 * ignores these replies and the two listeners coexist cleanly.
 */
export async function getDrumLayerParam(pad: number, layer: number, idx: number): Promise<number> {
    const node = getObxdNode();
    if (!node) return -1;
    const port = node.port;
    return new Promise<number>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const onMsg = (ev: MessageEvent): void => {
            const msg = ev.data;
            if (!msg || typeof msg !== "object") return;
            const m = msg as { type?: string; pad?: number; layer?: number; idx?: number; value?: number };
            if (m.type === "drum_layer_param_value"
                && m.pad === pad
                && m.layer === layer
                && m.idx === idx) {
                port.removeEventListener("message", onMsg);
                clearTimeout(timer);
                resolve(Number(m.value ?? -1));
            }
        };
        timer = setTimeout(() => {
            port.removeEventListener("message", onMsg);
            resolve(-1);
        }, 2000);
        // Install the predicate BEFORE posting so a fast reply can't be missed.
        port.addEventListener("message", onMsg);
        // ensureRouter() in obxd-audio.ts already calls port.start() once the
        // worklet is up; the defensive try/catch mirrors its style for safety.
        try { port.start(); } catch { /* some impls throw if already started */ }
        port.postMessage({
            type: "get_drum_layer_param",
            instance_id: DRUM_INSTANCE,
            pad,
            layer,
            idx,
        });
    });
}

export function setPadLayerCount(pad: number, count: number): void {
    postDrum({ type: "set_pcm_layer_count", instance_id: DRUM_INSTANCE, pad, count });
}

/*
 * Trigger a one-shot preview of a pad by its MIDI note on channel 10
 * (status 0x99 = note-on ch.10). A note-off (0x89) is scheduled after
 * ~300ms so the voice releases.
 */
export function previewPad(note: number, velocity = 1.0): void {
    const vel = Math.max(0, Math.min(127, Math.round(velocity * 127)));
    sendObxdInstanceMidi(DRUM_INSTANCE, 0x99, note, vel);
    setTimeout(() => {
        sendObxdInstanceMidi(DRUM_INSTANCE, 0x89, note, 0);
    }, 300);
}

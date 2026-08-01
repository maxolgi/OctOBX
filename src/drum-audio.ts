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
import {
    getObxdAudioContext,
    getObxdNode,
    sendObxdInstanceMidi,
    setObxdInstanceParam,
} from "./obxd-audio";

export const DRUM_INSTANCE = 9;  // fixed OB-Xf instance reserved for drums

// Legacy ParamsEnum.h indices used to configure the engine for sample
// playback (sources: obxf-param-mappings.ts — frozen ObxdParam enum).
const LEGACY_VOICE_COUNT = 3;     // VOICE_COUNT  -> Polyphony
const LEGACY_OSC1_MIX = 40;       // OSC1MIX      -> Osc1Mix
const LEGACY_OSC2_MIX = 41;       // OSC2MIX      -> Osc2Mix
const LEGACY_NOISE_MIX = 42;      // NOISEMIX     -> NoiseMix
const LEGACY_AMP_ATTACK = 51;     // LATK         -> AmpEnvAttack
const LEGACY_AMP_RELEASE = 54;    // LREL         -> AmpEnvRelease

// Module-level caches.
//   padLayerCount: padIndex -> current enabled-layer count, so previewLayer
//     can save/restore the count when soloing a single layer.
//   noteToPad:     midiNote -> padIndex, so previewLayer can find the pad
//     from the trigger note.
//   sampleCache:   full sample URL -> decoded mono PCM, so the same sample
//     shared by several pads/layers is decoded only once.
const padLayerCount = new Map<number, number>();
const noteToPad = new Map<number, number>();
const sampleCache = new Map<string, Float32Array>();

let audioContext: AudioContext | null = null;

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
    });
}

/*
 * Configure instance 9 for drum (sample-playback) mode: silence the
 * oscillator/noise paths and open the amp envelope. Unison stays OFF
 * (its default) — drum layers come from the engine's separate
 * voice-per-layer allocation, not from unison.
 * Each param is sent through the legacy setObxdInstanceParam path and
 * wrapped so a single failed dispatch can't abort the whole init.
 */
export async function initDrumMode(): Promise<void> {
    const set = (idx: number, v: number): void => {
        try { setObxdInstanceParam(DRUM_INSTANCE, idx, v); }
        catch (e) { console.warn("[drum] setObxdInstanceParam", idx, "failed:", e); }
    };

    // Polyphony -> max. VOICE_COUNT uses the OB-Xd 1..8 normalization, but
    // the C-side apply_param_instance() rescales it onto OB-Xf's 1..33
    // range (see obxf-param-mappings.ts idx 3); v=1.0 yields the engine max.
    set(LEGACY_VOICE_COUNT, 1.0);
    set(LEGACY_OSC1_MIX, 0.0);
    set(LEGACY_OSC2_MIX, 0.0);
    set(LEGACY_NOISE_MIX, 0.0);
    set(LEGACY_AMP_ATTACK, 0.0);
    set(LEGACY_AMP_RELEASE, 0.3);

    console.info("[drum] instance " + DRUM_INSTANCE + " configured for drum mode");
}

/*
 * Load a full drum kit into instance 9: clear existing PCM, fetch + decode
 * each unique enabled sample once, push the PCM + per-layer params, then
 * wire up note mapping, layer counts, and choke groups.
 */
export async function loadDrumKit(kit: DrumKit): Promise<void> {
    clearPcm();
    padLayerCount.clear();
    noteToPad.clear();

    const ctx = getOrCreateAudioContext();

    // Collect unique enabled sample names (dedup across pads/layers).
    // Pads themselves are always present; only layers are toggleable.
    const sampleNames = new Set<string>();
    for (const pad of kit.pads) {
        for (const lyr of pad.layers) {
            if (lyr.enabled === false) continue;
            if (lyr.sampleName) sampleNames.add(lyr.sampleName);
        }
    }

    // Fetch + decode each unique sample once, keyed by full URL.
    const decoded = new Map<string, Float32Array>();
    for (const name of sampleNames) {
        const url = kit.source + name + ".ogg";
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
        decoded.set(name, pcm);
    }

    // Push PCM + layer params for every pad's enabled layers.
    for (let p = 0; p < kit.pads.length; p++) {
        const pad = kit.pads[p];

        let enabledLayers = 0;
        for (let l = 0; l < pad.layers.length; l++) {
            const lyr = pad.layers[l];
            const pcm = lyr.sampleName ? decoded.get(lyr.sampleName) : undefined;
            if (lyr.enabled === false || !pcm) continue;
            postDrum({
                type: "load_pcm",
                instance_id: DRUM_INSTANCE,
                pad: p,
                layer: l,
                pcmL: pcm,
                frames: pcm.length,
            });
            // The C side stores all layer params together, so the full
            // set_pcm_layer is sent alongside the PCM it configures.
            sendLayerParams(p, l, lyr);
            enabledLayers++;
        }

        postDrum({ type: "set_pcm_note_map", instance_id: DRUM_INSTANCE, note: pad.midiNote, pad: p });
        noteToPad.set(pad.midiNote, p);

        postDrum({ type: "set_pcm_layer_count", instance_id: DRUM_INSTANCE, pad: p, count: enabledLayers });
        padLayerCount.set(p, enabledLayers);

        postDrum({ type: "set_pcm_choke", instance_id: DRUM_INSTANCE, pad: p, group: pad.chokeGroup });
    }

    console.info("[drum] kit loaded:", kit.pads.length, "pads");
}

/*
 * Re-send the full set_pcm_layer message for one pad/layer (the C side
 * stores all layer params together, so partial updates aren't possible).
 */
export function setLayerParam(pad: number, layer: number, lyr: DrumLayer): void {
    sendLayerParams(pad, layer, lyr);
}

export function setPadLayerCount(pad: number, count: number): void {
    padLayerCount.set(pad, count);
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

/*
 * Preview a single layer of the pad that the given note maps to:
 * temporarily force that pad's layer count to 1 (so only layer 0 plays),
 * trigger the note, then restore the original count on note-off.
 */
export function previewLayer(note: number, _layerIndex: number, velocity = 1.0): void {
    const pad = noteToPad.get(note);
    if (pad === undefined) {
        previewPad(note, velocity);
        return;
    }
    const saved = padLayerCount.get(pad) ?? 1;
    setPadLayerCount(pad, 1);
    const vel = Math.max(0, Math.min(127, Math.round(velocity * 127)));
    sendObxdInstanceMidi(DRUM_INSTANCE, 0x99, note, vel);
    setTimeout(() => {
        sendObxdInstanceMidi(DRUM_INSTANCE, 0x89, note, 0);
        setPadLayerCount(pad, saved);
    }, 300);
}

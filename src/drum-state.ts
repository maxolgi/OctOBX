/* drum-state.ts — OB-Xf drum module data types + factory functions.
 * Pure data layer: no project dependencies. Imported by drum-kits.ts and
 * drum-audio.ts. Export names are a fixed contract — do not rename. */

export interface DrumLayer {
    enabled: boolean;
    sampleName: string | null;
    // Source URL prefix of the kit the sample came from. When undefined,
    // loadDrumKit falls back to the loaded kit's `source` (legacy behavior).
    // Set when the user picks a sample from a *different* kit via the
    // layer-editor sample-kit dropdown, so layers in one kit can mix samples
    // sourced from any of the DRUM_KITS.
    sourceUrl?: string;
    gain: number;           // 0..10 (absolute PCM level multiplier, 3 = match osc level)
    filterCutoff: number;   // 0..1
    filterResonance: number;// 0..1
    filterMode: number;     // 0..1
    ampAttack: number;      // 0..1
    ampDecay: number;       // 0..1
    ampSustain: number;     // 0..1
    ampRelease: number;     // 0..1
    pan: number;            // 0..1 (0.5 = center)
    pitch: number;          // 0..1 (0.5 = original, 0 = -1 oct, 1 = +1 oct)
    muted: boolean;
    _seeded?: boolean;      // internal: tracks whether layer params have been seeded into g_drum_layer_params
}

export interface DrumPad {
    name: string;
    midiNote: number;
    chokeGroup: number;     // -1 = none, 0..7 = choke group (shared cut behavior)
    layers: [DrumLayer, DrumLayer, DrumLayer, DrumLayer];
}

export interface DrumKit {
    name: string;
    source: string;         // smpldsnds URL prefix (must end with "/")
    pads: DrumPad[];        // exactly 8 pads
}

export const DRUM_PAD_NAMES = ["Kick", "Snare", "Closed HH", "Open HH", "Tom Lo", "Clap", "Cowbell", "Ride"] as const;
export const DRUM_DEFAULT_NOTES = [36, 38, 40, 43, 45, 60, 62, 64] as const;

export function createDefaultLayer(): DrumLayer {
    return {
        enabled: false,
        sampleName: null,
        gain: 3.0,
        filterCutoff: 1.0,
        filterResonance: 0.0,
        filterMode: 0.0,
        ampAttack: 0.0,
        ampDecay: 0.3,
        ampSustain: 1.0,
        ampRelease: 0.2,
        pan: 0.5,
        pitch: 0.5,
        muted: false,
    };
}

export function createDefaultPad(name: string, note: number, chokeGroup: number = -1): DrumPad {
    return {
        name,
        midiNote: note,
        chokeGroup,
        layers: [createDefaultLayer(), createDefaultLayer(), createDefaultLayer(), createDefaultLayer()],
    };
}

export function createDefaultKitPads(): DrumPad[] {
    return DRUM_PAD_NAMES.map((padName, i) => {
        // Choke group 0 for Closed HH (index 2) and Open HH (index 3): classic hi-hat cut.
        const choke = (i === 2 || i === 3) ? 0 : -1;
        return createDefaultPad(padName, DRUM_DEFAULT_NOTES[i], choke);
    });
}

/**
 * A layer is in the "played set" (gets a dense pcmBank slot) when it is
 * enabled AND has a sample name. This predicate is the single source of
 * truth for dense packing: loadDrumKitImpl (drum-audio.ts) packs played
 * layers into dense slots 0..count-1, and denseIndexOf() below translates
 * sparse → dense with the same rule — both paths move together by
 * construction. If you change this, the C-side pcmLayerCount packing
 * changes with it.
 */
export function isLayerPlayed(lyr: DrumLayer): boolean {
    return lyr.enabled !== false && !!lyr.sampleName;
}

/**
 * Translate a sparse TS layer index (0..3, position in DrumPad.layers[])
 * into the DENSE layer index the C engine expects (0..count-1). Returns -1
 * when the sparse layer isn't in the played set (disabled or sampleless),
 * so callers can short-circuit — an engine write to a dead slot would be
 * silently never read.
 */
export function denseIndexOf(pad: DrumPad, sparseIdx: number): number {
    const target = pad.layers[sparseIdx];
    if (!target || !isLayerPlayed(target)) return -1;
    let dense = 0;
    for (let i = 0; i < sparseIdx; i++) {
        if (isLayerPlayed(pad.layers[i])) dense++;
    }
    return dense;
}

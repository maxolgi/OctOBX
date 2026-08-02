/* drum-state.ts — OB-Xf drum module data types + factory functions.
 * Pure data layer: no project dependencies. Imported by drum-kits.ts and
 * drum-audio.ts. Export names are a fixed contract — do not rename. */

export interface DrumLayer {
    enabled: boolean;
    sampleName: string | null;
    gain: number;           // 0..1
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
        gain: 1.0,
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

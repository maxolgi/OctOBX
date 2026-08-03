/*
 * drum-kits.ts — 10 drum-kit presets sourced from the Public Domain
 * smpldsnds GitHub Pages CDN (https://smpldsnds.github.io/drum-machines/).
 *
 * Each kit maps its available samples onto the 8 GM pads
 * (Kick / Snare / Closed HH / Open HH / Tom Lo / Clap / Cowbell / Ride).
 * Sample names are the bare CDN file stems (the loader appends ".ogg").
 * Case is preserved to match the case-sensitive CDN paths.
 */

import {
    createDefaultLayer,
    createDefaultPad,
    DRUM_PAD_NAMES,
    DRUM_DEFAULT_NOTES,
} from "./drum-state";
import type { DrumKit, DrumLayer, DrumPad } from "./drum-state";

// Per-pad amp envelope decay (s) and stereo pan, indexed by pad slot 0..7.
const DECAY_BY_PAD: readonly number[] = [0.3, 0.2, 0.15, 0.15, 0.3, 0.25, 0.25, 0.25];
const PAN_BY_PAD: readonly number[] = [0.5, 0.5, 0.55, 0.45, 0.6, 0.5, 0.4, 0.6];

// A single sample-backed layer. Stacked (secondary) layers are quieter/darker.
function layerFor(padIndex: number, sampleName: string, secondary: boolean): DrumLayer {
    return {
        enabled: true,
        sampleName,
        gain: secondary ? 1.65 : 2.55,
        filterCutoff: secondary ? 0.8 : 1.0,
        filterResonance: 0.0,
        filterMode: 0.0,
        ampAttack: 0.0,
        ampDecay: DECAY_BY_PAD[padIndex],
        ampSustain: 0.0,
        ampRelease: 0.2,
        pan: PAN_BY_PAD[padIndex],
        pitch: 0.5,
        muted: false,
    };
}

function layersFor(padIndex: number, samples: string[]): DrumLayer[] {
    return samples.map((s, i) => layerFor(padIndex, s, i > 0));
}

// Build the 8 GM pads from a per-pad list of sample names (empty list = silent pad).
// Closed HH / Open HH (slots 2 & 3) share choke group 0; all others are -1.
function buildPads(spec: string[][]): DrumPad[] {
    return spec.map((samples, i) => {
        const choke = i === 2 || i === 3 ? 0 : -1;
        const active = layersFor(i, samples);
        const filled: DrumLayer[] = [];
        for (let k = 0; k < 4; k++) {
            filled.push(k < active.length ? active[k] : createDefaultLayer());
        }
        const p = createDefaultPad(DRUM_PAD_NAMES[i], DRUM_DEFAULT_NOTES[i], choke);
        p.layers = [filled[0], filled[1], filled[2], filled[3]];
        return p;
    });
}

export const DRUM_KITS: DrumKit[] = [
    {
        name: "LM-2 (LinnDrum)",
        source: "https://smpldsnds.github.io/drum-machines/LM-2/",
        pads: buildPads([
            ["kick", "kick-alt"],
            ["snare-m", "snare-h"],
            ["hhclosed", "hhclosed-short"],
            ["hhopen"],
            ["tom-l", "tom-ll"],
            ["clap"],
            ["cowbell"],
            ["ride"],
        ]),
    },
    {
        name: "Roland TR-808",
        source: "https://smpldsnds.github.io/drum-machines/TR-808/",
        pads: buildPads([
            ["kick/bd0000", "kick/bd0075"],
            ["snare/sd0000", "snare/sd0075"],
            ["hihat-close/ch"],
            ["hihat-open/oh00"],
            ["tom-low/lt00"],
            ["clap/cp"],
            ["cowbell/cb"],
            ["cymbal/cy0000"],
        ]),
    },
    {
        name: "SCI Drumtraks",
        source: "https://smpldsnds.github.io/drum-machines/Sequential-Circuits-Drumtraks/",
        pads: buildPads([
            ["DT_Kick"],
            ["DT_Snare"],
            ["DT_Closedhat"],
            ["DT_Openhat"],
            ["DT_Tom01"],
            ["DT_Clap"],
            ["DT_Cowbell"],
            ["DT_Ride"],
        ]),
    },
    {
        name: "Casio RZ-1",
        source: "https://smpldsnds.github.io/drum-machines/Casio-RZ1/",
        pads: buildPads([
            ["kick"],
            ["snare"],
            ["hihat-closed"],
            ["hihat-open"],
            ["tom-1"],
            ["clap"],
            ["cowbell"],
            ["ride"],
        ]),
    },
    {
        name: "Casio SK-1",
        source: "https://smpldsnds.github.io/drum-machines/Casio-SK1/",
        pads: buildPads([
            ["kick"],
            ["snare"],
            ["hithat"],
            ["hihat-open"],
            ["tom-low"],
            [],
            [],
            [],
        ]),
    },
    {
        name: "MFB-512",
        source: "https://smpldsnds.github.io/drum-machines/MFB-512/",
        pads: buildPads([
            ["kick"],
            ["snare"],
            ["hihat-closed"],
            ["hihat-open"],
            ["tom-low"],
            ["clap"],
            [],
            ["cymbal"],
        ]),
    },
    {
        name: "Micro Rhythmer 12",
        source: "https://smpldsnds.github.io/drum-machines/Micro-Rhythmer-12/",
        pads: buildPads([
            [],
            ["univox-sd"],
            ["univox-ch"],
            ["univox-oh"],
            [],
            [],
            [],
            [],
        ]),
    },
    {
        name: "808 Mini",
        source: "https://smpldsnds.github.io/drum-machines/808-mini/",
        pads: buildPads([
            ["kick"],
            ["snare-1", "snare-2"],
            ["hhclosed-1", "hhclosed-2"],
            ["hhopen-1"],
            ["tom-low"],
            [],
            [],
            ["ride"],
        ]),
    },
    {
        name: "Roland CR-8000",
        source: "https://smpldsnds.github.io/drum-machines/Roland-CR-8000/",
        pads: buildPads([
            ["kick"],
            ["snare"],
            ["hihat-closed"],
            ["hihat-open"],
            ["tom-low"],
            ["clap"],
            ["cowbell"],
            ["cymball"],
        ]),
    },
    {
        name: "Yamaha Mr-10",
        source: "https://smpldsnds.github.io/drum-machines/Yamaha-MR10/",
        pads: buildPads([
            ["kick", "kick1"],
            ["snare", "shortsn"],
            ["chihat"],
            ["ohihat"],
            ["lowtom"],
            [],
            [],
            ["cymbal"],
        ]),
    },
];

/*
 * SAMPLE_CATALOG — flat per-kit sample list derived from DRUM_KITS, used by
 * the layer-editor "Sample kit" + "Sample" dropdowns to mix samples across
 * kits. Each entry mirrors a DRUM_KITS row but exposes only the unique
 * sample names that kit offers (deduped across pads/layers, sorted). The
 * `source` field is the URL prefix layers store in DrumLayer.sourceUrl when
 * the user picks one of these samples.
 */
export interface KitSampleCatalogEntry {
    name: string;
    source: string;
    samples: string[];
}

export const SAMPLE_CATALOG: KitSampleCatalogEntry[] = DRUM_KITS.map((k) => ({
    name: k.name,
    source: k.source,
    samples: Array.from(new Set(
        k.pads.flatMap((p) => p.layers.map((l) => l.sampleName).filter((n): n is string => !!n)),
    )).sort(),
}));

/*
 * engine-setup.ts — Creates the openDAW project with tracks and instruments.
 */

import type { OctopusWasmModule } from "./octopus-types";

export interface TrackAssignment {
    octopusTrack: number;
    audioUnitUuid: Uint8Array;
    label: string;
}

const OCTOPUS_TRACK_COUNT = 10;

export interface EngineResult {
    assignments: TrackAssignment[];
    project: unknown;
}

export async function setupEngine(
    audioContext: AudioContext,
    _module: OctopusWasmModule,
): Promise<EngineResult | null> {
    try {
        const studioCore = await import("@opendaw/studio-core");
        const studioAdapters = await import("@opendaw/studio-adapters");

        const Project = studioCore.Project;
        const AudioWorklets = studioCore.AudioWorklets;
        const InstrumentFactories = studioAdapters.InstrumentFactories;

        const audioWorklets = await AudioWorklets.createFor(audioContext);

        const env = {
            audioContext,
            audioWorklets,
            sampleManager: null,
            soundfontManager: null,
            sampleService: null,
            soundfontService: null,
        };

        const project = Project.new(env as unknown as Parameters<typeof Project.new>[0]);

        (window as unknown as { __opendawProject: unknown }).__opendawProject = project;

        const assignments: TrackAssignment[] = [];
        const factoryKeys = Object.keys(InstrumentFactories);
        const preferredFactories = ["Vaporisateur", "Soundfont", "Playfield", "Apparat"];

        project.editing.modify(() => {
            for (let i = 0; i < OCTOPUS_TRACK_COUNT; i++) {
                const factoryName = preferredFactories[i % preferredFactories.length];
                const factory = (InstrumentFactories as Record<string, unknown>)[factoryName]
                    ?? (InstrumentFactories as Record<string, unknown>)[factoryKeys[0]];
                if (!factory) continue;

                const result = project.api.createInstrument(factory as Parameters<typeof project.api.createInstrument>[0]);
                const uuid = result.audioUnitBox.address.uuid as Uint8Array;

                assignments.push({
                    octopusTrack: i,
                    audioUnitUuid: uuid,
                    label: `Octopus T${i}`,
                });
            }
        });

        console.log(`[octodaw] Created ${assignments.length} tracks`);
        return { assignments, project };
    } catch (e) {
        console.warn("[octodaw] openDAW setup failed, running Octopus standalone:", e);
        return null;
    }
}

export function getProject(): { engine: { noteSignal: (s: unknown) => void; play?: () => void; stop?: () => void; bpm?: { setValue?: (v: number) => void } } } | null {
    return (window as unknown as { __opendawProject: unknown }).__opendawProject as { engine: { noteSignal: (s: unknown) => void; play?: () => void; stop?: () => void; bpm?: { setValue?: (v: number) => void } } } | null;
}

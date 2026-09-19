/*
 * Shared type declarations for the WASM engines.
 *
 * The Octopus sequencer engine is no longer a main-thread Emscripten
 * module — it lives inside the combined OB-Xf AudioWorklet and is driven
 * through the OctopusController interface from octopus-awp.ts (which also
 * owns the __octopus window global). Only the OB-Xf module types remain
 * here.
 */

declare global {
    interface Window {
        ObxdModuleFactory?: (moduleOverrides?: object) => Promise<ObxdWasmModule>;
        __obxd?: { ctx: AudioContext; node: AudioWorkletNode; masterGain: GainNode; masterAnalyser: AnalyserNode };
        webkitAudioContext?: typeof AudioContext;
    }
}

/*
 * Emscripten module type declaration for the OB-Xf synth engine.
 * Matches the EMSCRIPTEN_KEEPALIVE exports in wasm/obxd/main_obxd.cpp.
 *
 * NOTE: OB-Xf runs as a SEPARATE WASM module (obxd_wasm.wasm) inside the
 * AudioWorklet — not the Octopus engine. The worklet code
 * (obxd-processor.tail.js) is plain JS and looks these up dynamically by
 * name, so this interface primarily serves as typed documentation for any
 * main-thread code that references the factory or its exports. Add exports
 * here as the migration introduces them.
 */
export interface ObxdWasmModule {
    _obxd_set_mpe(instance_id: number, enabled: number): void;
}

export {};

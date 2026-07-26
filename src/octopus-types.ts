/*
 * Emscripten module type declaration for the Octopus WASM engine.
 * Matches the EMSCRIPTEN_KEEPALIVE exports in main_wasm.c.
 */

export interface OctopusWasmModule {
    _engine_init(): number;
    _wasm_key_press(keyNdx: number, press: number): void;
    _wasm_rotary(rotNdx: number, dir: number): void;
    _wasm_transport(running: number): void;
    _wasm_pause(): void;
    _wasm_set_tempo(bpm: number): void;
    _wasm_midi_input(status: number, d1: number, d2: number): void;
    _wasm_save_state(): void;
    _wasm_load_state(): void;
    _wasm_consume_state_saved(): number;
    _wasm_shutdown(): void;
    _get_mir_ptr(): number;
    _get_processed_mir_ptr(): number;
    _get_run_bit(): number;
    _get_tempo(): number;
    _get_zoom_level(): number;
    _page_refresh(): void;
    _wasm_check_refresh(): number;
    _wasm_has_midi_event(): number;
    _wasm_get_midi_event(): number;
    _wasm_drain_midi_batch(max_count: number): number;
    _get_midi_batch_events_ptr(): number;
    _get_midi_batch_ts_ptr(): number;
    _wasm_get_midi_dropped_count(): number;
    HEAPU8: Uint8Array;
    HEAPU32: Uint32Array;
    HEAPF64: Float64Array;
    FS: {
        mkdir(path: string): void;
        mount(type: unknown, options: unknown, mountpoint: string): void;
        syncfs(populate: boolean, callback: (err: Error | null) => void): void;
        writeFile(path: string, data: string | Uint8Array): void;
        readFile(path: string): Uint8Array;
        analyzePath(path: string): { exists: boolean };
    };
    onRuntimeInitialized?: () => void;
}

declare global {
    interface Window {
        OctopusModuleFactory?: (moduleOverrides?: object) => Promise<OctopusWasmModule>;
    }
}

export {};

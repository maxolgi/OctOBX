/*
 * state-persistence.ts — Save/load Octopus sequencer state via Emscripten
 * IDBFS (IndexedDB-backed filesystem).
 *
 * The Octopus engine writes state to /persistent/octopus_state.bin.
 * FS.syncfs() flushes to IndexedDB (async). On load, FS.syncfs(true)
 * populates the filesystem from IndexedDB before the engine reads.
 */

import type { OctopusWasmModule } from "./octopus-types";

export function setupStatePersistence(module: OctopusWasmModule) {
    const saveBtn = document.getElementById("oct-save");
    const loadBtn = document.getElementById("oct-load");

    saveBtn?.addEventListener("click", () => {
        module._wasm_save_state();
        console.log("[octodaw] State saved to IDBFS");
    });

    loadBtn?.addEventListener("click", () => {
        module.FS.syncfs(true, (err) => {
            if (err) {
                console.error("[octodaw] IDBFS load failed:", err);
                return;
            }
            module._wasm_load_state();
            console.log("[octodaw] State loaded from IDBFS");
        });
    });
}

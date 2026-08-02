/*
 * state-persistence.ts — Save/load Octopus sequencer state.
 *
 * The Octopus engine writes state to /persistent/octopus_state.bin in
 * Emscripten's MEMFS. IDBFS is mounted at /persistent so the file
 * persists across page reloads via IndexedDB (see octopus-module.ts).
 *
 * SAVE: _wasm_save_state() writes to MEMFS + syncs to IDBFS (the C
 *   side calls FS.syncfs(false) via EM_ASM). Shift+SAVE also downloads
 *   .bin + app-state JSON.
 * LOAD: file picker imports a .bin into MEMFS + syncs to IDBFS.
 * Shift+LOAD: clears IDBFS + app-state localStorage (recovery).
 */

import type { OctopusWasmModule } from "./octopus-types";
import {
    loadMidiLearnBindings,
    saveMidiLearnBindings,
} from "./obxf-midi-learn-integration";
import { saveAppState, clearAppState, downloadAppStateJson } from "./app-state";

const STATE_PATH = "/persistent/octopus_state.bin";

function ensurePersistentDir(module: OctopusWasmModule): void {
    try { module.FS.mkdir("/persistent"); } catch { /* already exists */ }
}

/*
 * Read the state file from MEMFS and trigger a browser download.
 * Called by Shift+SAVE and by the classic panel (after GRID+PGM).
 */
export function downloadStateFile(module: OctopusWasmModule): void {
    let data: Uint8Array;
    try {
        data = module.FS.readFile(STATE_PATH);
    } catch (e) {
        console.error("[octobx] No state file to download:", e);
        return;
    }

    /* Copy into a plain ArrayBuffer — FS.readFile may return a view
     * into SharedArrayBuffer, which Blob doesn't accept. */
    const buf = new ArrayBuffer(data.length);
    new Uint8Array(buf).set(data);
    const blob = new Blob([buf], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.download = `octopus_state_${ts}.bin`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    console.log(`[octobx] State downloaded (${data.length} bytes)`);
}

/*
 * Sync MEMFS to IDBFS so the state persists across reloads. Called by
 * onStateSaved (GRID+PGM path) and the file-import handler, since those
 * paths write to MEMFS without going through _wasm_save_state's EM_ASM
 * syncfs call.
 */
function syncIdbfs(module: OctopusWasmModule): void {
    try {
        module.FS.syncfs(false, (err: Error | null) => {
            if (err) console.error("[octobx] IDBFS sync failed:", err);
        });
    } catch { /* IDBFS not mounted */ }
}

/*
 * Post-save callback for the GRID+PGM path. The firmware's save_state()
 * wrote to MEMFS; we sync to IDBFS and download the .bin.
 */
export function onStateSaved(module: OctopusWasmModule): void {
    syncIdbfs(module);
    downloadStateFile(module);
}

export function setupStatePersistence(module: OctopusWasmModule) {
    loadMidiLearnBindings();

    const saveBtn = document.getElementById("oct-save");
    const loadBtn = document.getElementById("oct-load");

    saveBtn?.addEventListener("click", async (e) => {
        ensurePersistentDir(module);
        module._wasm_save_state();
        saveMidiLearnBindings();
        await saveAppState();
        if (e.shiftKey) {
            downloadStateFile(module);
            downloadAppStateJson();
        }
    });

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".bin,application/octet-stream";
    fileInput.style.display = "none";
    document.body.appendChild(fileInput);

    loadBtn?.addEventListener("click", (e) => {
        if (e.shiftKey) {
            try {
                if (module.FS.analyzePath(STATE_PATH).exists) {
                    module.FS.unlink(STATE_PATH);
                    syncIdbfs(module);
                }
            } catch { /* nothing to clear */ }
            clearAppState();
            console.log("[octobx] Cleared IDBFS + app state");
            return;
        }
        fileInput.click();
    });

    fileInput.addEventListener("change", async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        try {
            const data = new Uint8Array(await file.arrayBuffer());
            ensurePersistentDir(module);
            module.FS.writeFile(STATE_PATH, data);
            module._wasm_load_state();
            syncIdbfs(module);
            console.log(`[octobx] State loaded from file (${data.length} bytes)`);
        } catch (e) {
            console.error("[octobx] State load failed:", e);
        } finally {
            fileInput.value = "";
        }
    });
}

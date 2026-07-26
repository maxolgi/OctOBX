/*
 * state-persistence.ts — Save/load Octopus sequencer state via browser
 * file download/upload.
 *
 * The Octopus engine writes state to /persistent/octopus_state.bin in
 * Emscripten's MEMFS (in-memory filesystem). Instead of IDBFS (which is
 * broken in this build), we read the MEMFS file and trigger a download
 * for Save, and write an uploaded file into MEMFS for Load.
 */

import type { OctopusWasmModule } from "./octopus-types";
import {
    loadMidiLearnBindings,
    saveMidiLearnBindings,
} from "./obxf-midi-learn-integration";

const STATE_PATH = "/persistent/octopus_state.bin";

function ensurePersistentDir(module: OctopusWasmModule): void {
    try { module.FS.mkdir("/persistent"); } catch { /* already exists */ }
}

/*
 * Read the state file from MEMFS and trigger a browser download.
 * Called by the SAVE button (after wasm_save_state writes the file)
 * and by the classic panel (after GRID+PGM sets the g_state_saved flag).
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

export function setupStatePersistence(module: OctopusWasmModule) {
    // Restore OB-Xf MIDI-learn bindings from localStorage. They live
    // alongside (not inside) the binary sequencer state because they're
    // a JSON document, not part of the engine's flash image. Auto-save
    // fires on every learn/unlearn via the manager's onLearnedCallback,
    // so the SAVE button below doesn't need to also write them.
    loadMidiLearnBindings();

    const saveBtn = document.getElementById("oct-save");
    const loadBtn = document.getElementById("oct-load");

    saveBtn?.addEventListener("click", () => {
        ensurePersistentDir(module);
        module._wasm_save_state();
        // Persist the latest MIDI-learn bindings too — defensive: the
        // auto-save hook should already have written them, but a SAVE
        // is a natural "snapshot everything" gesture so we re-flush.
        saveMidiLearnBindings();
        downloadStateFile(module);
    });

    /* Hidden file input — activated by the LOAD button click */
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".bin,application/octet-stream";
    fileInput.style.display = "none";
    document.body.appendChild(fileInput);

    loadBtn?.addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        try {
            const data = new Uint8Array(await file.arrayBuffer());
            ensurePersistentDir(module);
            module.FS.writeFile(STATE_PATH, data);
            module._wasm_load_state();
            console.log(`[octobx] State loaded from file (${data.length} bytes)`);
        } catch (e) {
            console.error("[octobx] State load failed:", e);
        } finally {
            fileInput.value = "";
        }
    });
}

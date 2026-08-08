/*
 * state-persistence.ts — Save/load Octopus sequencer state + project management.
 *
 * The Octopus engine writes state to /persistent/octopus_state.bin in
 * Emscripten's MEMFS. IDBFS is mounted at /persistent so the file
 * persists across page reloads via IndexedDB (see octopus-module.ts).
 *
 * SAVE: saves to the active project slot (localStorage + IDBFS).
 * SAVE AS: prompts for a name, creates a new project.
 * Project dropdown: switch between saved projects (confirm dialog).
 * LOAD: file picker imports a .bin into MEMFS + syncs to IDBFS.
 * Shift+LOAD: clears IDBFS + app-state localStorage (recovery).
 * Right-click on Octopus panel: context menu with export/import/project ops.
 */

import type { OctopusWasmModule } from "./octopus-types";
import {
    loadMidiLearnBindings,
    saveMidiLearnBindings,
} from "./obxf-midi-learn-integration";
import { saveAppState, clearAppState, downloadAppStateJson, reloadAndRestoreAppState } from "./app-state";

const STATE_PATH = "/persistent/octopus_state.bin";

// ---- localStorage keys for project management ----
const PROJECT_INDEX_KEY = "octobx:project_index";
const ACTIVE_PROJECT_KEY = "octobx:active_project";

function projectKey(name: string): string {
    return `octobx:project:${name}`;
}

interface ProjectData {
    octopus_state: string;       // base64-encoded binary
    app_state: string;           // raw JSON string (same as octobx:app_state:v1)
    saved_at: string;            // ISO timestamp
}

function ensurePersistentDir(module: OctopusWasmModule): void {
    try { module.FS.mkdir("/persistent"); } catch { /* already exists */ }
}

// ---- Base64 helpers for binary state ----

function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

// ---- Project index management ----

function getProjectList(): string[] {
    try {
        const raw = localStorage.getItem(PROJECT_INDEX_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter(n => typeof n === "string") : [];
    } catch {
        return [];
    }
}

function setProjectList(names: string[]): void {
    localStorage.setItem(PROJECT_INDEX_KEY, JSON.stringify(names));
}

function getActiveProject(): string {
    return localStorage.getItem(ACTIVE_PROJECT_KEY) || "Default";
}

function setActiveProject(name: string): void {
    localStorage.setItem(ACTIVE_PROJECT_KEY, name);
}

// ---- Project save/load ----

/*
 * Serialize the current working state into a project slot.
 * Reads the Octopus binary from MEMFS + app state from localStorage.
 */
async function saveProjectData(module: OctopusWasmModule, name: string): Promise<void> {
    ensurePersistentDir(module);

    // Save engine state to MEMFS first
    module._wasm_save_state();
    await saveAppState();

    // Read Octopus binary from MEMFS
    let octopusB64 = "";
    try {
        const data = module.FS.readFile(STATE_PATH);
        octopusB64 = bytesToBase64(data);
    } catch {
        console.warn("[project] No Octopus binary to save");
    }

    // Read app state JSON
    const appStateJson = localStorage.getItem("octobx:app_state:v1") || "{}";

    const project: ProjectData = {
        octopus_state: octopusB64,
        app_state: appStateJson,
        saved_at: new Date().toISOString(),
    };

    localStorage.setItem(projectKey(name), JSON.stringify(project));

    // Update index
    const list = getProjectList();
    if (!list.includes(name)) {
        list.push(name);
        setProjectList(list);
    }

    setActiveProject(name);
    refreshProjectSelector();

    console.log(`[project] Saved "${name}" (${octopusB64.length > 0 ? Math.round(octopusB64.length * 3 / 4) + " bytes binary" : "no binary"})`);
}

/*
 * Load a project: deserialize, write to working state, reload engine.
 */
async function loadProjectData(module: OctopusWasmModule, name: string): Promise<void> {
    const raw = localStorage.getItem(projectKey(name));
    if (!raw) {
        console.warn(`[project] Project "${name}" not found`);
        return;
    }

    const project = JSON.parse(raw) as ProjectData;

    // Write Octopus binary to MEMFS + reload engine
    if (project.octopus_state) {
        try {
            const bytes = base64ToBytes(project.octopus_state);
            ensurePersistentDir(module);
            module.FS.writeFile(STATE_PATH, bytes);
            module._wasm_load_state();
            syncIdbfs(module);
        } catch (e) {
            console.error("[project] Failed to restore Octopus binary:", e);
        }
    }

    // Write app state to working localStorage key
    if (project.app_state && project.app_state !== "{}") {
        localStorage.setItem("octobx:app_state:v1", project.app_state);
    }

    setActiveProject(name);
    refreshProjectSelector();

    // Reload + restore (applies synth/drum params if AWP is running)
    await reloadAndRestoreAppState();

    console.log(`[project] Loaded "${name}"`);
}

/*
 * Sync MEMFS to IDBFS so the state persists across reloads.
 */
function syncIdbfs(module: OctopusWasmModule): void {
    try {
        module.FS.syncfs(false, (err: Error | null) => {
            if (err) console.error("[octobx] IDBFS sync failed:", err);
        });
    } catch { /* IDBFS not mounted */ }
}

/*
 * Read the state file from MEMFS and trigger a browser download.
 */
export function downloadStateFile(module: OctopusWasmModule): void {
    let data: Uint8Array;
    try {
        data = module.FS.readFile(STATE_PATH);
    } catch (e) {
        console.error("[octobx] No state file to download:", e);
        return;
    }

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

export function onStateSaved(module: OctopusWasmModule): void {
    syncIdbfs(module);
    downloadStateFile(module);
}

// ---- Project selector UI ----

function refreshProjectSelector(): void {
    const sel = document.getElementById("oct-project-selector") as HTMLSelectElement | null;
    if (!sel) return;
    const list = getProjectList();
    const active = getActiveProject();
    sel.innerHTML = "";
    for (const name of list) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
    }
    sel.value = active;
}

// Keep track of the previous selection for the confirm-dialog cancel path.
// Always read from localStorage so SAVE/SAVE AS stays in sync.
function getPreviousSelection(): string {
    return getActiveProject();
}

let selectionOverride: string | null = null;

export function setupStatePersistence(module: OctopusWasmModule) {
    loadMidiLearnBindings();

    // Initialize project index with Default if empty
    if (getProjectList().length === 0) {
        setProjectList(["Default"]);
    }
    refreshProjectSelector();

    const saveBtn = document.getElementById("oct-save");
    const saveAsBtn = document.getElementById("oct-save-as");
    const loadBtn = document.getElementById("oct-load");
    const projectSel = document.getElementById("oct-project-selector") as HTMLSelectElement | null;

    // SAVE — saves to the active project slot
    saveBtn?.addEventListener("click", async (e) => {
        const active = getActiveProject();
        await saveProjectData(module, active);
        saveMidiLearnBindings();
        if (e.shiftKey) {
            downloadStateFile(module);
            downloadAppStateJson();
        }
    });

    // SAVE AS — prompts for name, creates new project
    saveAsBtn?.addEventListener("click", async () => {
        const name = window.prompt("Save project as:", getActiveProject());
        if (!name || !name.trim()) return;
        const trimmed = name.trim();
        await saveProjectData(module, trimmed);
        saveMidiLearnBindings();
    });

    // Project selector — confirm before switching
    projectSel?.addEventListener("change", async () => {
        const newProject = projectSel.value;
        const oldProject = selectionOverride ?? getPreviousSelection();

        if (newProject === oldProject) return;

        const choice = window.confirm(
            `Save changes to "${oldProject}" before switching to "${newProject}"?\n\n` +
            `OK = save & switch, Cancel = switch without saving`
        );

        try {
            if (choice) {
                await saveProjectData(module, oldProject);
                saveMidiLearnBindings();
            }
            await loadProjectData(module, newProject);
            selectionOverride = null;
        } catch (e) {
            console.error("[project] Switch failed:", e);
            // Revert selector on failure
            projectSel.value = oldProject;
            selectionOverride = null;
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

    setupContextMenu(module, fileInput);
}

// ---- Project management helpers ----

function duplicateProject(module: OctopusWasmModule): void {
    const active = getActiveProject();
    const name = window.prompt(`Duplicate "${active}" as:`, active + " copy");
    if (!name || !name.trim()) return;
    const trimmed = name.trim();

    // Copy the raw project data
    const raw = localStorage.getItem(projectKey(active));
    if (!raw) {
        console.warn(`[project] Cannot duplicate — "${active}" has no saved data`);
        return;
    }
    localStorage.setItem(projectKey(trimmed), raw);

    const list = getProjectList();
    if (!list.includes(trimmed)) {
        list.push(trimmed);
        setProjectList(list);
    }
    refreshProjectSelector();
    console.log(`[project] Duplicated "${active}" → "${trimmed}"`);
}

function deleteProject(): void {
    const active = getActiveProject();
    const list = getProjectList();
    if (list.length <= 1) {
        window.alert("Cannot delete the last project");
        return;
    }
    if (!window.confirm(`Delete project "${active}"?\nThis cannot be undone.`)) return;

    localStorage.removeItem(projectKey(active));
    const newList = list.filter(n => n !== active);
    setProjectList(newList);

    // Switch to first remaining project
    const next = newList[0];
    setActiveProject(next);
    refreshProjectSelector();
    console.log(`[project] Deleted "${active}", switched to "${next}"`);
}

// ---- Context menu ----

interface MenuItem {
    label: string;
    action?: () => void;
    danger?: boolean;
    separator?: boolean;
}

function setupContextMenu(module: OctopusWasmModule, fileInput: HTMLInputElement): void {
    let menuEl: HTMLDivElement | null = null;

    function closeMenu(): void {
        if (menuEl) { menuEl.remove(); menuEl = null; }
        document.removeEventListener("click", closeMenu);
        document.removeEventListener("keydown", onKeydown);
    }

    function onKeydown(e: KeyboardEvent): void {
        if (e.key === "Escape") closeMenu();
    }

    function openMenu(x: number, y: number): void {
        closeMenu();

        const items: MenuItem[] = [
            { label: "Save Project", action: async () => { await saveProjectData(module, getActiveProject()); saveMidiLearnBindings(); } },
            { label: "Save As...", action: async () => {
                const name = window.prompt("Save project as:", getActiveProject());
                if (name?.trim()) { await saveProjectData(module, name.trim()); saveMidiLearnBindings(); }
            }},
            { separator: true, label: "" },
            { label: "Export Octopus (.bin)", action: () => { module._wasm_save_state(); downloadStateFile(module); } },
            { label: "Export State (.json)", action: () => downloadAppStateJson() },
            { label: "Import State...", action: () => fileInput.click() },
            { separator: true, label: "" },
            { label: "Duplicate Project", action: () => duplicateProject(module) },
            { label: "Delete Project", action: () => deleteProject(), danger: true },
            { separator: true, label: "" },
            { label: "Clear All (Recovery)", action: () => {
                if (!window.confirm("Clear ALL state? This wipes the Octopus sequencer + synth/drum params.")) return;
                try {
                    if (module.FS.analyzePath(STATE_PATH).exists) {
                        module.FS.unlink(STATE_PATH);
                        syncIdbfs(module);
                    }
                } catch { /* nothing */ }
                clearAppState();
                location.reload();
            }, danger: true },
        ];

        menuEl = document.createElement("div");
        menuEl.style.cssText =
            `position:fixed;left:${x}px;top:${y}px;z-index:10000;` +
            "background:#2a2a2a;border:1px solid #555;border-radius:4px;" +
            "padding:4px 0;min-width:200px;font-family:monospace;font-size:12px;" +
            "box-shadow:4px 4px 12px rgba(0,0,0,0.5);cursor:pointer;";

        for (const item of items) {
            if (item.separator) {
                const sep = document.createElement("div");
                sep.style.cssText = "height:1px;background:#444;margin:4px 0;";
                menuEl.appendChild(sep);
                continue;
            }
            const el = document.createElement("div");
            el.textContent = item.label;
            el.style.cssText =
                "padding:6px 16px;color:" + (item.danger ? "#f66" : "#e0e0e0") + ";" +
                "white-space:nowrap;";
            el.addEventListener("mouseenter", () => { el.style.background = item.danger ? "#4a1a1a" : "#3a3a3a"; });
            el.addEventListener("mouseleave", () => { el.style.background = "transparent"; });
            el.addEventListener("click", () => {
                closeMenu();
                item.action?.();
            });
            menuEl.appendChild(el);
        }

        document.body.appendChild(menuEl);

        // Clamp to viewport
        const rect = menuEl.getBoundingClientRect();
        if (x + rect.width > window.innerWidth) menuEl.style.left = (window.innerWidth - rect.width - 8) + "px";
        if (y + rect.height > window.innerHeight) menuEl.style.top = (window.innerHeight - rect.height - 8) + "px";

        // Close on next click outside, or Escape
        setTimeout(() => {
            document.addEventListener("click", closeMenu);
            document.addEventListener("keydown", onKeydown);
        }, 0);
    }

    // Attach to the Octopus panel root
    const panel = document.getElementById("view-classic");
    if (panel) {
        panel.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            openMenu(e.clientX, e.clientY);
        });
    }
}

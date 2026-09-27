/*
 * state-persistence.ts — Save/load Octopus sequencer state + project management.
 *
 * The Octopus engine's state file is read/written INSIDE the AudioWorklet
 * via the controller (ctl.saveState() / ctl.loadState(bytes)). Boot
 * auto-load now comes from the active project (inside bootOctopusEngine);
 * IDBFS is gone (purgeEmscriptenIdbfs() below is legacy cleanup only).
 *
 * Storage split for projects:
 *   - Payloads (Octopus binary + app-state JSON) live in IndexedDB via
 *     idb-projects.ts — binary stored natively as Uint8Array (no base64,
 *     no ~5 MB localStorage quota ceiling).
 *   - localStorage keeps ONLY the small project index (octobx:project_index)
 *     and the active-project name (octobx:active_project).
 *   - Legacy localStorage payloads (octobx:project:<name>) are migrated to
 *     IndexedDB once at startup by migrateLegacyProjects().
 *
 * SAVE: saves to the active project slot (IndexedDB).
 * SAVE AS: prompts for a name, creates a new project.
 * Project dropdown: switch between saved projects (confirm dialog).
 * LOAD: file picker imports a .bin into the engine via ctl.loadState().
 * Shift+LOAD: clears legacy IDBFS + app-state localStorage (recovery).
 * Right-click on Octopus panel: context menu with export/import/project ops.
 */

import type { OctopusController } from "./octopus-awp";
import {
    loadMidiLearnBindings,
    saveMidiLearnBindings,
} from "./obxf-midi-learn-integration";
import { saveAppState, clearAppState, downloadAppStateJson, reloadAndRestoreAppState } from "./app-state";
import {
    idbSaveProject,
    idbLoadProject,
    idbDeleteProject,
    idbHasProject,
    migrateLegacyProjects,
} from "./idb-projects";

// ---- localStorage keys for project management ----
// Only the (small) index + active name live here; payloads live in
// IndexedDB (see idb-projects.ts).
const PROJECT_INDEX_KEY = "octobx:project_index";
const ACTIVE_PROJECT_KEY = "octobx:active_project";

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
 * Pulls the Octopus binary from the engine (inside the worklet) + app
 * state from localStorage. Resolves with the saved binary (or null when
 * the engine had no state to dump).
 */
async function saveProjectData(ctl: OctopusController, name: string): Promise<Uint8Array | null> {
    const octopusBytes = await ctl.saveState();
    if (!octopusBytes) {
        console.warn("[project] No Octopus binary to save");
    }
    await saveAppState();

    // Read app state JSON
    const appStateJson = localStorage.getItem("octobx:app_state:v1") || "{}";

    await idbSaveProject(name, octopusBytes, appStateJson);

    // Update index
    const list = getProjectList();
    if (!list.includes(name)) {
        list.push(name);
        setProjectList(list);
    }

    setActiveProject(name);
    refreshProjectSelector();

    console.log(`[project] Saved "${name}" (${octopusBytes ? octopusBytes.length + " bytes binary" : "no binary"})`);
    return octopusBytes;
}

/*
 * Load a project: deserialize, write to working state, reload engine.
 */
async function loadProjectData(ctl: OctopusController, name: string): Promise<void> {
    const project = await idbLoadProject(name);
    if (!project) {
        console.warn(`[project] Project "${name}" not found`);
        return;
    }

    // Push the Octopus binary into the engine (inside the worklet)
    if (project.octopusState) {
        try {
            const ok = await ctl.loadState(project.octopusState);
            if (!ok) console.error("[project] Engine rejected the Octopus binary");
        } catch (e) {
            console.error("[project] Failed to restore Octopus binary:", e);
        }
    }

    // Write app state to working localStorage key
    if (project.appStateJson && project.appStateJson !== "{}") {
        localStorage.setItem("octobx:app_state:v1", project.appStateJson);
    }

    setActiveProject(name);
    refreshProjectSelector();

    // Reload + restore (applies synth/drum params if AWP is running)
    await reloadAndRestoreAppState();

    console.log(`[project] Loaded "${name}"`);
}

/*
 * Delete Emscripten's legacy IDBFS database(s) for this origin directly.
 * The engine no longer uses IDBFS (state lives in IndexedDB projects now),
 * so this only cleans up leftovers from older builds. Emscripten names the
 * databases "EM_FS_" + the mount path context; the octobx projects DB and
 * any other IndexedDB databases are never touched. Used by the Shift+LOAD
 * recovery path.
 */
function purgeEmscriptenIdbfs(): void {
    const dbs = (indexedDB as unknown as { databases?: () => Promise<Array<{ name?: string }>> }).databases;
    if (typeof dbs !== "function") {
        console.warn("[octobx] indexedDB.databases() unavailable — close other tabs of this site and retry, or clear site data");
        return;
    }
    dbs.call(indexedDB).then((list) => {
        for (const db of list) {
            if (typeof db.name === "string" && db.name.startsWith("EM_FS_")) {
                indexedDB.deleteDatabase(db.name);
                console.log(`[octobx] Deleted IDBFS database '${db.name}'`);
            }
        }
    }).catch((e: unknown) => console.warn("[octobx] IDBFS purge failed:", e));
}

/*
 * User-visible failure signal for the fire-and-forget project operations.
 * IndexedDB errors (quota, blocked upgrade, private-mode rejection) would
 * otherwise surface only as unhandled promise rejections — the user would
 * believe the project saved. Callers that already try/catch (project switch)
 * report inline; SAVE / SAVE AS / Duplicate / Delete route through this.
 */
function reportProjectError(op: string, err: unknown): void {
    console.error(`[project] ${op} failed (changes NOT saved):`, err);
}

/*
 * Trigger a browser download of an Octopus state blob.
 */
export function downloadStateFile(data: Uint8Array): void {
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
 * Engine-initiated internal save (ctl.onInternalSave, replaces the old
 * _wasm_consume_state_saved polling): persist the bytes into the ACTIVE
 * project (reading the current app-state JSON, like saveProjectData) and
 * trigger the same browser download the manual export uses. Fire-and-
 * forget — failures are reported via reportProjectError.
 */
export function onStateSavedBytes(bytes: Uint8Array): void {
    const appStateJson = localStorage.getItem("octobx:app_state:v1") || "{}";
    idbSaveProject(getActiveProject(), bytes, appStateJson).catch((err: unknown) => {
        reportProjectError("Auto-save (internal save)", err);
    });
    downloadStateFile(bytes);
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

export function setupStatePersistence(ctl: OctopusController) {
    // One-time migration: move legacy localStorage payloads into IndexedDB.
    // Fire-and-forget — failures are logged inside, never block startup.
    void migrateLegacyProjects().then((n) => {
        if (n > 0) console.log(`[project] Migrated ${n} project(s) from localStorage to IndexedDB`);
    });

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
        try {
            const active = getActiveProject();
            const bytes = await saveProjectData(ctl, active);
            saveMidiLearnBindings();
            if (e.shiftKey) {
                if (bytes) downloadStateFile(bytes);
                downloadAppStateJson();
            }
        } catch (err) {
            reportProjectError("Save", err);
        }
    });

    // SAVE AS — prompts for name, creates new project
    saveAsBtn?.addEventListener("click", async () => {
        const name = window.prompt("Save project as:", getActiveProject());
        if (!name || !name.trim()) return;
        const trimmed = name.trim();
        try {
            await saveProjectData(ctl, trimmed);
            saveMidiLearnBindings();
        } catch (err) {
            reportProjectError("Save As", err);
        }
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
                await saveProjectData(ctl, oldProject);
                saveMidiLearnBindings();
            }
            await loadProjectData(ctl, newProject);
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
            // Recovery: purge legacy IDBFS leftovers + clear app state,
            // then reload so the engine boots fresh.
            purgeEmscriptenIdbfs();
            clearAppState();
            console.log("[octobx] Cleared IDBFS + app state");
            location.reload();
            return;
        }
        fileInput.click();
    });

    fileInput.addEventListener("change", async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        try {
            const data = new Uint8Array(await file.arrayBuffer());
            const ok = await ctl.loadState(data);
            if (ok) {
                console.log(`[octobx] State loaded from file (${data.length} bytes)`);
            } else {
                console.error("[octobx] State load failed (engine rejected state)");
            }
        } catch (e) {
            console.error("[octobx] State load failed:", e);
        } finally {
            fileInput.value = "";
        }
    });

    setupContextMenu(ctl, fileInput);
}

// ---- Project management helpers ----

async function duplicateProject(): Promise<void> {
    const active = getActiveProject();
    const name = window.prompt(`Duplicate "${active}" as:`, active + " copy");
    if (!name || !name.trim()) return;
    const trimmed = name.trim();

    // Copy the project payload from IndexedDB
    if (!(await idbHasProject(active))) {
        console.warn(`[project] Cannot duplicate — "${active}" has no saved data`);
        return;
    }
    const src = await idbLoadProject(active);
    if (!src) return; // vanished between the check and the read (unlikely)
    await idbSaveProject(trimmed, src.octopusState, src.appStateJson);

    const list = getProjectList();
    if (!list.includes(trimmed)) {
        list.push(trimmed);
        setProjectList(list);
    }
    refreshProjectSelector();
    console.log(`[project] Duplicated "${active}" → "${trimmed}"`);
}

async function deleteProject(): Promise<void> {
    const active = getActiveProject();
    const list = getProjectList();
    if (list.length <= 1) {
        window.alert("Cannot delete the last project");
        return;
    }
    if (!window.confirm(`Delete project "${active}"?\nThis cannot be undone.`)) return;

    await idbDeleteProject(active);
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

function setupContextMenu(ctl: OctopusController, fileInput: HTMLInputElement): void {
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
            { label: "Save Project", action: async () => {
                try {
                    await saveProjectData(ctl, getActiveProject());
                    saveMidiLearnBindings();
                } catch (err) { reportProjectError("Save", err); }
            } },
            { label: "Save As...", action: async () => {
                const name = window.prompt("Save project as:", getActiveProject());
                if (!name?.trim()) return;
                try {
                    await saveProjectData(ctl, name.trim());
                    saveMidiLearnBindings();
                } catch (err) { reportProjectError("Save As", err); }
            }},
            { separator: true, label: "" },
            { label: "Export Octopus (.bin)", action: async () => {
                const bytes = await ctl.saveState();
                if (bytes) downloadStateFile(bytes);
            } },
            { label: "Export State (.json)", action: () => downloadAppStateJson() },
            { label: "Import State...", action: () => fileInput.click() },
            { separator: true, label: "" },
            { label: "Duplicate Project", action: () => { void duplicateProject().catch((err) => reportProjectError("Duplicate", err)); } },
            { label: "Delete Project", action: () => { void deleteProject().catch((err) => reportProjectError("Delete", err)); }, danger: true },
            { separator: true, label: "" },
            { label: "Clear All (Recovery)", action: () => {
                if (!window.confirm("Clear ALL state? This wipes the Octopus sequencer + synth/drum params.")) return;
                purgeEmscriptenIdbfs();
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

import type { OctopusWasmModule } from "./octopus-types";

let moduleInstance: OctopusWasmModule | null = null;

export async function loadOctopusModule(wasmPath: string): Promise<OctopusWasmModule> {
    if (moduleInstance) return moduleInstance;

    if (!window.OctopusModuleFactory) {
        await new Promise<void>((resolve, reject) => {
            const script = document.createElement("script");
            script.src = wasmPath;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error(`Failed to load ${wasmPath}`));
            document.head.appendChild(script);
        });
    }

    if (!window.OctopusModuleFactory) {
        throw new Error("OctopusModuleFactory not found after script load");
    }

    moduleInstance = await window.OctopusModuleFactory({
        locateFile: (path: string) => `/${path}`,
        print: (text: string) => console.log("[octopus]", text),
        printErr: (text: string) => console.warn("[octopus]", text),
    });

    await setupIdbfs(moduleInstance);

    return moduleInstance;
}

/*
 * Mount IDBFS at /persistent so the Octopus engine's state file
 * (/persistent/octopus_state.bin) persists across page reloads via
 * IndexedDB. Must complete before engine_init() — which calls
 * load_state() expecting the file to already be in MEMFS.
 *
 * Skip with ?nosync in the URL (recovery for corrupt state).
 */
async function setupIdbfs(module: OctopusWasmModule): Promise<void> {
    if (new URLSearchParams(window.location.search).has("nosync")) {
        console.log("[octopus] Skipping IDBFS (?nosync)");
        return;
    }
    try {
        module.FS.mkdir("/persistent");
        const idbfs = module.FS.filesystems?.IDBFS;
        if (!idbfs) {
            console.warn("[octopus] IDBFS backend not available in this build");
            return;
        }
        module.FS.mount(idbfs, {}, "/persistent");
        await new Promise<void>((resolve) => {
            module.FS.syncfs(true, (err: Error | null) => {
                if (err) console.error("[octopus] IDBFS load failed:", err);
                else console.log("[octopus] IDBFS loaded");
                resolve();
            });
        });
    } catch (e) {
        console.warn("[octopus] IDBFS mount skipped:", e);
    }
}

export function getOctopusModule(): OctopusWasmModule {
    if (!moduleInstance) throw new Error("Octopus module not loaded");
    return moduleInstance;
}

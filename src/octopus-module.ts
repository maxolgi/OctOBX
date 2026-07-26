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

    setupIdbfs(moduleInstance);

    return moduleInstance;
}

function setupIdbfs(module: OctopusWasmModule) {
    try {
        module.FS.mkdir("/persistent");
        module.FS.mount(module.IDBFS ?? {}, {}, "/persistent");
        module.FS.syncfs(true, (err: Error | null) => {
            if (err) console.error("IDBFS load failed:", err);
            else console.log("[octopus] IDBFS loaded");
        });
    } catch (e) {
        console.warn("[octopus] IDBFS mount skipped:", e);
    }
}

export function getOctopusModule(): OctopusWasmModule {
    if (!moduleInstance) throw new Error("Octopus module not loaded");
    return moduleInstance;
}

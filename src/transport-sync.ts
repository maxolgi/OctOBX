/*
 * transport-sync.ts — Bidirectional transport sync between the Octopus
 * sequencer and openDAW's engine.
 *
 * The Octopus is the transport master. Pressing PLAY on the Octopus panel
 * starts both the Octopus sequencer and openDAW's engine.
 */

import type { OctopusWasmModule } from "./octopus-types";
import { getProject } from "./engine-setup";

export function setupTransportSync(module: OctopusWasmModule) {
    const playBtn = document.getElementById("oct-play");
    const stopBtn = document.getElementById("oct-stop");
    const tempoInput = document.getElementById("oct-tempo") as HTMLInputElement | null;

    let engineReady = false;

    async function ensureEngine() {
        if (engineReady) return true;
        const project = getProject();
        if (!project) return false;
        engineReady = true;
        return true;
    }

    playBtn?.addEventListener("click", async () => {
        await ensureEngine();
        const project = getProject();
        const bpm = module._get_tempo();
        module._wasm_transport(1);
        if (project) {
            project.engine.bpm?.setValue?.(bpm);
            project.engine.play?.();
        }
        updateTransportUI(true);
    });

    stopBtn?.addEventListener("click", async () => {
        module._wasm_transport(0);
        const project = getProject();
        if (project) {
            project.engine.stop?.();
        }
        updateTransportUI(false);
    });

    tempoInput?.addEventListener("change", () => {
        const bpm = parseInt(tempoInput.value, 10);
        if (bpm >= 10 && bpm <= 199) {
            module._wasm_set_tempo(bpm);
            const project = getProject();
            if (project) {
                project.engine.bpm?.setValue?.(bpm);
            }
        }
    });

    const tempoFromEngine = document.getElementById("oct-tempo-display");
    if (tempoFromEngine) {
        tempoFromEngine.textContent = String(module._get_tempo());
    }
}

function updateTransportUI(playing: boolean) {
    const indicator = document.getElementById("oct-transport-indicator");
    if (indicator) {
        indicator.textContent = playing ? "PLAYING" : "STOPPED";
        indicator.className = playing ? "transport-playing" : "transport-stopped";
    }
}

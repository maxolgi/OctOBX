/*
 * transport-sync.ts — Wires the transport-bar PLAY/STOP/BPM controls to
 * the Octopus engine and updates the on-screen transport indicator.
 */

import type { OctopusWasmModule } from "./octopus-types";

export function setupTransportSync(module: OctopusWasmModule) {
    const playBtn = document.getElementById("oct-play");
    const stopBtn = document.getElementById("oct-stop");
    const tempoInput = document.getElementById("oct-tempo") as HTMLInputElement | null;

    playBtn?.addEventListener("click", () => {
        module._wasm_transport(1);
        updateTransportUI(true);
    });

    stopBtn?.addEventListener("click", () => {
        module._wasm_transport(0);
        updateTransportUI(false);
    });

    tempoInput?.addEventListener("change", () => {
        const bpm = parseInt(tempoInput.value, 10);
        if (bpm >= 10 && bpm <= 199) {
            module._wasm_set_tempo(bpm);
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

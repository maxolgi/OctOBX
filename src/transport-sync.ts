/*
 * transport-sync.ts — Wires the transport-bar PLAY/STOP/BPM controls to
 * the Octopus engine (via the AudioWorklet controller) and updates the
 * on-screen transport indicator.
 */

import type { OctopusController } from "./octopus-awp";

export function setupTransportSync(ctl: OctopusController) {
    const playBtn = document.getElementById("oct-play");
    const stopBtn = document.getElementById("oct-stop");
    const tempoInput = document.getElementById("oct-tempo") as HTMLInputElement | null;

    playBtn?.addEventListener("click", () => {
        ctl.transport(true);
        updateTransportUI(true);
    });

    stopBtn?.addEventListener("click", () => {
        ctl.transport(false);
        updateTransportUI(false);
    });

    tempoInput?.addEventListener("change", () => {
        const bpm = parseInt(tempoInput.value, 10);
        if (bpm >= 10 && bpm <= 199) {
            ctl.setTempo(bpm);
        }
    });

    const tempoFromEngine = document.getElementById("oct-tempo-display");
    if (tempoFromEngine) {
        tempoFromEngine.textContent = String(ctl.status.tempo());
    }
}

function updateTransportUI(playing: boolean) {
    const indicator = document.getElementById("oct-transport-indicator");
    if (indicator) {
        indicator.textContent = playing ? "PLAYING" : "STOPPED";
        indicator.className = playing ? "transport-playing" : "transport-stopped";
    }
}

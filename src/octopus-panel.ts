/*
 * octopus-panel.ts — Mounts the Octopus grid control surface and connects
 * it to the WASM engine. Replaces the WebSocket layer from web_gui.html
 * with direct Module.ccall / HEAPU8 reads.
 *
 * The MIR (Matrix Intermediate Representation) is a 170-byte array in
 * WASM linear memory. JavaScript reads it at 60Hz via requestAnimationFrame
 * and updates the LED DOM elements.
 */

import type { OctopusWasmModule } from "./octopus-types";

const MIR_SIZE = 170;

export function startOctopusPanel(module: OctopusWasmModule): () => void {
    let running = true;
    let mirAddr = 0;
    let renderFrame = 0;
    const prevMir = new Uint8Array(MIR_SIZE);

    function mirChanged(curr: Uint8Array): boolean {
        for (let i = 0; i < MIR_SIZE; i++) {
            if (curr[i] !== prevMir[i]) return true;
        }
        return false;
    }

    function renderLoop() {
        if (!running) return;
        renderFrame++;

        const runBit = module._get_run_bit();
        const indicator = document.getElementById("oct-transport-indicator");
        if (indicator) {
            const playing = runBit !== 0;
            if (indicator.textContent !== (playing ? "PLAYING" : "STOPPED")) {
                indicator.textContent = playing ? "PLAYING" : "STOPPED";
                indicator.className = playing ? "transport-playing" : "transport-stopped";
            }
        }

        module._wasm_check_refresh();

        mirAddr = module._get_processed_mir_ptr();

        if (mirAddr) {
            const mir = new Uint8Array(module.HEAPU8.buffer, mirAddr, MIR_SIZE);
            if (mirChanged(mir)) {
                updateLEDs(mir);
                prevMir.set(mir);
            }
        }

        requestAnimationFrame(renderLoop);
    }

    requestAnimationFrame(renderLoop);

    wireInputHandlers(module);

    return () => {
        running = false;
    };
}

function updateLEDs(mir: Uint8Array) {
    const mb = (s: number, r: number, c: number) => mir[s * 85 + r * 5 + c];
    const ml = (s: number, r: number, b: number) =>
        ((mb(s, r, 1) >> b & 1) ? 2 : 0) | ((mb(s, r, 2) >> b & 1) ? 4 : 0);

    for (let row = 0; row < 10; row++) {
        for (let col = 0; col < 8; col++) {
            setLED(`p${row}_${col}`, ml(0, row, col));
            setLED(`p${row}_${col + 8}`, ml(1, row, col));
        }
    }

    const mk = [21, 32, 43, 54, 65, 76, 87, 98, 109, 120, 131, 142, 153, 164, 175, 186];
    const mm = [
        [0, 10, 0], [0, 10, 1], [0, 10, 2], [0, 10, 3], [0, 10, 4], [0, 10, 5], [0, 10, 6], [0, 10, 7],
        [1, 10, 0], [1, 10, 1], [1, 10, 2], [1, 10, 3], [1, 10, 4], [1, 10, 5], [1, 10, 6], [1, 10, 7],
    ];
    mk.forEach((k, i) => setLED(`mx${k}`, ml(mm[i][0], mm[i][1], mm[i][2])));
}

function setLED(id: string, v: number) {
    const el = document.getElementById(id);
    if (!el) return;

    const led = el.previousElementSibling ||
        (el.parentElement?.querySelector(".led")) ||
        el;

    const ledEl = led as HTMLElement;
    if (parseInt(ledEl.dataset.mv ?? "-1") === v) return;
    ledEl.dataset.mv = String(v);

    const r = v & 2;
    const g = v & 4;

    if (r && g) {
        ledEl.style.background = "#dc0";
        ledEl.style.boxShadow = "0 0 5px #e80";
    } else if (r) {
        ledEl.style.background = "#d00";
        ledEl.style.boxShadow = "0 0 5px #f00";
    } else if (g) {
        ledEl.style.background = "#0c0";
        ledEl.style.boxShadow = "0 0 5px #0f0";
    } else {
        ledEl.style.background = "transparent";
        ledEl.style.boxShadow = "none";
    }
}

function wireInputHandlers(module: OctopusWasmModule) {
    const heldKeys = new Map<number, HTMLElement>();

    document.querySelectorAll("[data-key]").forEach((el) => {
        const htmlEl = el as HTMLElement;
        const key = parseInt(htmlEl.dataset.key!, 10);

        htmlEl.oncontextmenu = (e) => { e.preventDefault(); return false; };

        htmlEl.onmousedown = (e) => {
            if (e.ctrlKey || e.metaKey || e.button === 2) {
                e.preventDefault();
                if (heldKeys.has(key)) {
                    module._wasm_key_press(key, 0);
                    htmlEl.classList.remove("held");
                    heldKeys.delete(key);
                } else {
                    module._wasm_key_press(key, 1);
                    htmlEl.classList.add("held");
                    heldKeys.set(key, htmlEl);
                }
                return;
            }
            module._wasm_key_press(key, 1);
        };

        htmlEl.onmouseup = () => {
            if (heldKeys.has(key)) return;
            module._wasm_key_press(key, 0);
            heldKeys.forEach((heldEl, k) => {
                module._wasm_key_press(k, 0);
                heldEl.classList.remove("held");
            });
            heldKeys.clear();
        };

        htmlEl.addEventListener("touchstart", (e) => {
            e.preventDefault();
            module._wasm_key_press(key, 1);
        }, { passive: false });

        htmlEl.addEventListener("touchend", (e) => {
            e.preventDefault();
            module._wasm_key_press(key, 0);
        }, { passive: false });
    });

    document.querySelectorAll("[data-step]").forEach((el) => {
        const htmlEl = el as HTMLElement;
        const key = parseInt(htmlEl.dataset.step!, 10);

        htmlEl.oncontextmenu = (e) => { e.preventDefault(); return false; };

        let dragVisited = new Set<string>();

        htmlEl.onmousedown = (e) => {
            if (e.ctrlKey || e.metaKey || e.button === 2) {
                e.preventDefault();
                if (heldKeys.has(key)) {
                    module._wasm_key_press(key, 0);
                    htmlEl.classList.remove("held");
                    heldKeys.delete(key);
                } else {
                    module._wasm_key_press(key, 1);
                    htmlEl.classList.add("held");
                    heldKeys.set(key, htmlEl);
                }
                return;
            }
            e.preventDefault();
            dragVisited = new Set();
            module._wasm_key_press(key, 1);
            module._wasm_key_press(key, 0);
            dragVisited.add(htmlEl.id);
        };

        htmlEl.addEventListener("mouseenter", () => {
            if (dragVisited.size === 0 || dragVisited.has(htmlEl.id)) return;
            module._wasm_key_press(key, 1);
            module._wasm_key_press(key, 0);
            dragVisited.add(htmlEl.id);
        });

        htmlEl.onmouseup = () => {
            if (heldKeys.has(key)) return;
            dragVisited = new Set();
            heldKeys.forEach((heldEl, k) => {
                module._wasm_key_press(k, 0);
                heldEl.classList.remove("held");
            });
            heldKeys.clear();
        };
    });

    document.addEventListener("mouseup", () => { dragPaintActive = false; });

    document.querySelectorAll("[data-rotary]").forEach((el) => {
        const htmlEl = el as HTMLElement;
        const rotNdx = parseInt(htmlEl.dataset.rotary!, 10);

        htmlEl.onwheel = (e) => {
            e.preventDefault();
            const dir = e.deltaY > 0 ? 1 : 2;
            module._wasm_rotary(rotNdx, dir);
        };
    });
}

let dragPaintActive = false;

/*
 * octopus-panel.ts — Mounts the Octopus grid control surface and connects
 * it to the engine via the OctopusController (octopus-awp.ts).
 *
 * The MIR (Matrix Intermediate Representation) is a 170-byte shared-memory
 * view owned by the worklet engine; the worklet pump refreshes it at ~60 Hz
 * and this panel reads it via ctl.mir() on each animation frame to update
 * the LED DOM elements.
 */

import type { OctopusController } from "./octopus-awp";

const MIR_SIZE = 170;

export function startOctopusPanel(ctl: OctopusController): () => void {
    let running = true;
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

        const runBit = ctl.status.runBit();
        const indicator = document.getElementById("oct-transport-indicator");
        if (indicator) {
            const playing = runBit !== 0;
            if (indicator.textContent !== (playing ? "PLAYING" : "STOPPED")) {
                indicator.textContent = playing ? "PLAYING" : "STOPPED";
                indicator.className = playing ? "transport-playing" : "transport-stopped";
            }
        }

        const mir = ctl.mir();
        if (mirChanged(mir)) {
            updateLEDs(mir);
            prevMir.set(mir);
        }

        requestAnimationFrame(renderLoop);
    }

    requestAnimationFrame(renderLoop);

    wireInputHandlers(ctl);

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

/*
 * LED state cache — resolves button id -> LED element once (the DOM is
 * static after panel build) and swaps pre-defined CSS classes instead of
 * writing inline style/boxShadow strings. The LED classes carry no
 * transition: animated box-shadow blurs re-rasterized every frame and
 * were a top GPU-process cost during playback.
 */
const ledCache = new Map<string, HTMLElement | null>();

function ledFor(id: string): HTMLElement | null {
    let led = ledCache.get(id);
    if (led === undefined) {
        const el = document.getElementById(id);
        led = (el?.previousElementSibling as HTMLElement)
            ?? (el?.parentElement?.querySelector(".led") as HTMLElement)
            ?? el
            ?? null;
        ledCache.set(id, led);
    }
    return led;
}

function setLED(id: string, v: number) {
    const ledEl = ledFor(id);
    if (!ledEl) return;

    if (parseInt(ledEl.dataset.mv ?? "-1") === v) return;
    ledEl.dataset.mv = String(v);

    const r = (v & 2) !== 0;
    const g = (v & 4) !== 0;

    ledEl.classList.toggle("on-r", r && !g);
    ledEl.classList.toggle("on-g", g && !r);
    ledEl.classList.toggle("on-a", r && g);
}

function wireInputHandlers(ctl: OctopusController) {
    const heldKeys = new Map<number, HTMLElement>();

    document.querySelectorAll("[data-key]").forEach((el) => {
        const htmlEl = el as HTMLElement;
        const key = parseInt(htmlEl.dataset.key!, 10);

        htmlEl.oncontextmenu = (e) => { e.preventDefault(); return false; };

        htmlEl.onmousedown = (e) => {
            if (e.ctrlKey || e.metaKey || e.button === 2) {
                e.preventDefault();
                if (heldKeys.has(key)) {
                    ctl.key(key, false);
                    htmlEl.classList.remove("held");
                    heldKeys.delete(key);
                } else {
                    ctl.key(key, true);
                    htmlEl.classList.add("held");
                    heldKeys.set(key, htmlEl);
                }
                return;
            }
            ctl.key(key, true);
        };

        htmlEl.onmouseup = () => {
            if (heldKeys.has(key)) return;
            ctl.key(key, false);
            heldKeys.forEach((heldEl, k) => {
                ctl.key(k, false);
                heldEl.classList.remove("held");
            });
            heldKeys.clear();
        };

        htmlEl.addEventListener("touchstart", (e) => {
            e.preventDefault();
            ctl.key(key, true);
        }, { passive: false });

        htmlEl.addEventListener("touchend", (e) => {
            e.preventDefault();
            ctl.key(key, false);
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
                    ctl.key(key, false);
                    htmlEl.classList.remove("held");
                    heldKeys.delete(key);
                } else {
                    ctl.key(key, true);
                    htmlEl.classList.add("held");
                    heldKeys.set(key, htmlEl);
                }
                return;
            }
            e.preventDefault();
            dragVisited = new Set();
            ctl.key(key, true);
            ctl.key(key, false);
            dragVisited.add(htmlEl.id);
        };

        htmlEl.addEventListener("mouseenter", () => {
            if (dragVisited.size === 0 || dragVisited.has(htmlEl.id)) return;
            ctl.key(key, true);
            ctl.key(key, false);
            dragVisited.add(htmlEl.id);
        });

        htmlEl.onmouseup = () => {
            if (heldKeys.has(key)) return;
            dragVisited = new Set();
            heldKeys.forEach((heldEl, k) => {
                ctl.key(k, false);
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
            ctl.rotary(rotNdx, dir);
        };
    });
}

let dragPaintActive = false;

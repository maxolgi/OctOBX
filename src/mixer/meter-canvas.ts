/*
 * mixer/meter-canvas.ts — canvas peak/rms meter, vanilla-TS port of
 * CakeMix's components/MeterCanvas.tsx. Same ballistics (fast attack
 * 0.3, slow release 0.06, ~0.75s peak-hold decay). No per-widget rAF:
 * console.ts drives ONE loop and calls tick() on every mounted meter.
 *
 * Scale deviation from CakeMix (deliberate): the range is -60..+6 dBFS,
 * not -60..0. Hot sources (the PCM drum engine routinely peaks
 * +6 dBFS) must READ on the meter — a 0-top scale clamps them to 100%
 * and hides the over, which makes the channel meters contradict the
 * master (post-limiter, sub-0) meters.
 */

// -60 dB → 0.0, 0 dBFS → 0.909, +6 dB → 1.0 (clamped).
function dbToNorm(db: number): number {
    if (db <= -60) return 0;
    if (db >= 6) return 1;
    return (db + 60) / 66;
}

export interface MeterHandle {
    element: HTMLCanvasElement;
    /** Update the target levels (dB; -Infinity = silent). */
    setTargets(peakDb: number, rmsDb: number): void;
    /** One animation frame — called by console.ts's shared rAF loop. */
    tick(): void;
}

// One ballistic spec everywhere: ~1 s hold, then an exponential fall with
// the same time constant the engine's MasterMeter uses (×0.95 per 128-
// sample block ≈ ×0.949 per 60 fps frame ≈ −27 dB/s). `hold=false` is for
// meters whose SOURCE value already holds (the master meter's engine
// values) — adding a canvas hold on top would double the hold time.
const HOLD_FRAMES = 60;
const HOLD_DECAY_PER_FRAME = 0.949;

export function createMeterCanvas(width = 10, height = 130, hold = true): MeterHandle {
    const canvas = document.createElement("canvas");
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    let displayPeak = 0;
    let displayRms = 0;
    let peakHold = 0;
    let peakHoldTimer = 0;
    let targetPeak = 0;
    let targetRms = 0;

    function tick(): void {
        if (targetPeak > displayPeak) displayPeak += (targetPeak - displayPeak) * 0.3;
        else displayPeak += (targetPeak - displayPeak) * 0.06;
        if (targetRms > displayRms) displayRms += (targetRms - displayRms) * 0.3;
        else displayRms += (targetRms - displayRms) * 0.06;
        if (hold) {
            // Source values are instantaneous (engine channel meters) —
            // apply the shared hold+decay here so channel and master
            // meters visibly behave identically.
            if (targetPeak >= peakHold) {
                peakHold = targetPeak;
                peakHoldTimer = HOLD_FRAMES;
            } else if (peakHoldTimer > 0) {
                peakHoldTimer--;
            } else {
                peakHold *= HOLD_DECAY_PER_FRAME;
            }
        } else {
            // Source already holds (engine master meter) — pass through.
            peakHold = targetPeak;
        }

        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(0, 0, width, height);

        const rmsH = displayRms * height;
        ctx.fillStyle = "#22c55e";
        ctx.fillRect(0, height - rmsH, width, rmsH);

        // Peak bar renders the HELD peak (the white indicator line rides
        // at the same level — one number, two views).
        const peakH = peakHold * height;
        const grad = ctx.createLinearGradient(0, height, 0, 0);
        // 0 dBFS sits at 90.9% of the bar; red covers the +6 dB hot zone.
        grad.addColorStop(0, "#22c55e");
        grad.addColorStop(0.6, "#22c55e");
        grad.addColorStop(0.8, "#eab308");
        grad.addColorStop(0.91, "#ef4444");
        ctx.fillStyle = grad;
        ctx.fillRect(0, height - peakH, width, peakH);

        if (peakHold > 0.01) {
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, height - peakHold * height - 1, width, 2);
        }
    }

    return {
        element: canvas,
        setTargets(peakDb: number, rmsDb: number): void {
            targetPeak = dbToNorm(peakDb);
            targetRms = dbToNorm(rmsDb);
        },
        tick,
    };
}

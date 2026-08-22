/*
 * awp-task-queue.js — deferred task queue for the OB-Xf AudioWorklet.
 *
 * build.sh concatenates this file BEFORE obxd-processor.tail.js into the
 * single classic script fed to audioWorklet.addModule() (Worklet scope has
 * no importScripts()/dynamic import(), so everything must ship in one file).
 *
 * The port.onmessage handler in the tail runs on the audio thread's event
 * loop, and several of its operations are far too heavy to execute there
 * synchronously: load_fxp does _malloc + HEAPU8.set + a full XML parse of
 * the preset, engine recreate paths delete+new whole SynthEngine objects,
 * and the staged full-state restore (restore_all_state: stage 0 commits
 * 10×108 synth + 8×4×108 drum params into C-owned staging, stages 1-4
 * replay them as bounded per-stage batches). Any of these can blow past
 * the 128-frame render quantum (~2.9ms @ 44.1kHz), and a late process()
 * callback = an audible glitch.
 *
 * This queue defers that work: the message handler only enqueues, and
 * process() drains a budgeted number of tasks per quantum so the heavy
 * operations are spread across frames instead of landing in one. Strict
 * FIFO is preserved — a set_param enqueued after a load_fxp still applies
 * after it (ordering beats throughput; we never reorder or starve the
 * tail of the queue just because a light task could squeeze through).
 *
 * IMPORTANT: This file is plain JS (not an ES module, not TypeScript) so
 * it can be loaded via AudioWorklet.addModule() which expects a classic
 * script — no `import`/`export` statements anywhere in it. It runs in
 * AudioWorkletGlobalScope (no window/document/require).
 */

/**
 * FIFO task queue with a per-drain budget for "heavy" tasks.
 *
 * Light tasks (param tweaks, gain changes, MIDI routing) drain freely —
 * they never consume budget. Heavy tasks (fxp loads, engine recreates,
 * chunked bulk restores) consume one unit of the drain() budget each;
 * when the budget is exhausted, a pending heavy task BLOCKS everything
 * behind it so ordering is preserved.
 *
 * @class AwpTaskQueue
 */
class AwpTaskQueue {
    constructor() {
        /** @type {Array<{fn: Function, heavy: boolean}>} */
        this.tasks = [];
    }

    /**
     * Enqueue a task. heavy tasks consume the drain() budget; light ones
     * don't. Non-function arguments are silently ignored (a malformed
     * postMessage must not poison the audio thread with a TypeError at
     * drain time).
     *
     * @param {Function} fn Zero-arg callable to execute.
     * @param {boolean} [heavy=false] Whether the task consumes drain budget.
     * @returns {void}
     */
    push(fn, heavy) {
        if (typeof fn !== 'function') return;
        this.tasks.push({ fn: fn, heavy: !!heavy });
    }

    /**
     * Run tasks in strict FIFO order. Light tasks never consume budget and
     * drain freely, but a pending HEAVY task blocks everything behind it
     * (ordering beats throughput — a set_param queued after an engine
     * recreate must apply after it). Stops when the next task is heavy and
     * heavyBudget is exhausted. Each task is wrapped in try/catch — a
     * throwing task is logged and skipped, never kills the audio thread.
     *
     * The task is removed from the queue BEFORE it runs, so a task that
     * pushes more tasks (e.g. a chunked restore scheduling its next chunk)
     * cannot be re-executed, and re-entrancy via drain() inside a task is
     * safe.
     *
     * @param {number} [heavyBudget=1] Max heavy tasks to execute this call.
     * @returns {number} The number of tasks executed.
     */
    drain(heavyBudget) {
        if (heavyBudget === undefined) heavyBudget = 1;
        let executed = 0;
        // Always operate on the head (index 0): we remove each task before
        // running it, so `i` never advances past 0 within a single step.
        // shift() is fine here — the queue holds at most a few dozen tasks.
        let i = 0;
        while (i < this.tasks.length) {
            const t = this.tasks[i];
            if (t.heavy && heavyBudget <= 0) break;
            this.tasks.shift();   // remove BEFORE running (see JSDoc above)
            if (t.heavy) heavyBudget--;
            try {
                t.fn();
            } catch (e) {
                console.error('[awp-task-queue] task threw:', e && e.message, e && e.stack);
            }
            executed++;
            // i stays 0 — we removed the head.
        }
        return executed;
    }

    /**
     * Number of pending tasks.
     *
     * @returns {number}
     */
    get size() {
        return this.tasks.length;
    }

    /**
     * Drop all pending tasks.
     *
     * @returns {void}
     */
    clear() {
        this.tasks.length = 0;
    }
}

// registerProcessor-style scope note: in the concatenated worklet script the
// class binding above is directly visible to obxd-processor.tail.js (same
// classic-script top-level scope). For the vitest (node ESM) import path —
// where top-level class declarations do NOT leak onto the shared global —
// register on globalThis so tests can grab it after the side-effect import:
if (typeof globalThis !== 'undefined') {
    globalThis.AwpTaskQueue = AwpTaskQueue;
}

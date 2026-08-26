/*
 * midi-framing.ts — pure MIDI message framing logic.
 *
 * Extracted from midi-output.ts so it can be unit-tested without pulling
 * in browser/Web MIDI dependencies. Real-time messages are 1 byte; program
 * change / channel pressure are 2 bytes; everything else is 3 bytes.
 * Sending the wrong length corrupts the stream for hardware synths.
 */

/** Frame a MIDI message into the correct number of bytes. */
export function frameMidi(status: number, d1: number, d2: number): number[] {
    if (status >= 0xf8) return [status];                   // system real-time
    const cmd = status & 0xf0;
    if (cmd === 0xc0 || cmd === 0xd0) return [status, d1];   // PGM / ch-pressure
    return [status, d1, d2];                                 // channel voice
}

/*
 * normalizeMidiTimestamp — convert a ring-buffer event timestamp into a
 * MIDIOutput.send() DOMHighResTimeStamp (performance.now() epoch).
 *
 * The producer (emscripten_get_now() in the sequencer worker) may report
 * either Date.now()-epoch ms (~1.78T) or performance.now()-epoch ms
 * (~thousands), depending on platform/build. We detect which epoch by
 * magnitude: values above 1e9 can only be wall-clock epoch ms, anything
 * below is already on the performance.now() epoch.
 *
 * After epoch normalization + forward offset, a sanity clamp guards
 * against clock drift or an unexpected epoch flip: if the candidate lands
 * outside [now - 50, now + 5000] ms it is absurdly stale or far-future,
 * so we fall back to now + forwardOffsetMs (deliver ASAP). This makes
 * delivery self-healing regardless of which epoch the producer used.
 *
 * Pure function — no Date/performance calls inside; the caller supplies
 * nowPerfMs (performance.now()) and epochOffsetMs (Date.now() -
 * performance.now(), computed once per drain-loop start).
 */
export function normalizeMidiTimestamp(
    rawMs: number,
    nowPerfMs: number,
    epochOffsetMs: number,
    forwardOffsetMs: number,
): number {
    const candidate = rawMs > 1e9
        ? rawMs - epochOffsetMs + forwardOffsetMs   // Date.now()-epoch producer
        : rawMs + forwardOffsetMs;                  // perf-epoch producer
    const min = nowPerfMs - 50;
    const max = nowPerfMs + 5000;
    if (candidate < min || candidate > max) {
        return nowPerfMs + forwardOffsetMs;         // self-heal: deliver ASAP
    }
    return candidate;
}

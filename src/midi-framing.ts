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

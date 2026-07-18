/*
 * midi-access.ts — Shared Web MIDI access + robust port enumeration.
 *
 * Chrome-on-Linux quirk: after the permission is granted, the FIRST
 * requestMIDIAccess() delivers ports via statechange events. But on RELOAD
 * (permission already granted) no statechange fires, and the call can resolve
 * with EMPTY input/output maps — so selectors stay "None". We poll briefly to
 * catch ports that arrive a moment later. This mirrors what real Web MIDI
 * libraries (webmidi.js, JZZ) do.
 */

export async function openMidiAccess(): Promise<MIDIAccess> {
    return await navigator.requestMIDIAccess();
}

/*
 * Re-run repopulate() on an interval until hasPorts() is true or the timeout
 * elapses. Use right after requestMIDIAccess() resolves, since the maps may
 * populate late.
 */
export function pollForPorts(
    repopulate: () => void,
    hasPorts: () => boolean,
    opts?: { intervalMs?: number; timeoutMs?: number },
): () => void {
    const intervalMs = opts?.intervalMs ?? 250;
    const timeoutMs = opts?.timeoutMs ?? 4000;
    let elapsed = 0;
    let stopped = false;

    function tick() {
        if (stopped) return;
        repopulate();
        if (hasPorts() || elapsed >= timeoutMs) return;
        elapsed += intervalMs;
        setTimeout(tick, intervalMs);
    }
    tick();

    return () => { stopped = true; };
}

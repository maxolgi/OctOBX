import { describe, it, expect } from "vitest";
import { frameMidi, normalizeMidiTimestamp } from "../src/midi-framing";

describe("frameMidi", () => {
    describe("1-byte system real-time", () => {
        it.each([
            ["Timing Clock", 0xf8],
            ["Start", 0xfa],
            ["Continue", 0xfb],
            ["Stop", 0xfc],
            ["Active Sensing", 0xfe],
        ])("%s (0x%x) → [status]", (_name, status) => {
            expect(frameMidi(status, 0, 0)).toEqual([status]);
        });

        it("ignores d1/d2 for real-time messages", () => {
            expect(frameMidi(0xf8, 100, 100)).toEqual([0xf8]);
        });
    });

    describe("2-byte program change", () => {
        it.each([
            ["ch 1", 0xc0, 5],
            ["ch 16", 0xcf, 127],
            ["ch 8", 0xc7, 0],
        ])("PC %s (0x%x, program %d) → [status, d1]", (_name, status, program) => {
            expect(frameMidi(status, program, 0)).toEqual([status, program]);
        });
    });

    describe("2-byte channel pressure", () => {
        it.each([
            ["ch 1", 0xd0, 64],
            ["ch 16", 0xdf, 127],
        ])("CP %s (0x%x, pressure %d) → [status, d1]", (_name, status, pressure) => {
            expect(frameMidi(status, pressure, 0)).toEqual([status, pressure]);
        });
    });

    describe("3-byte channel voice", () => {
        it("Note On", () => {
            expect(frameMidi(0x90, 60, 100)).toEqual([0x90, 60, 100]);
        });

        it("Note Off", () => {
            expect(frameMidi(0x80, 60, 0)).toEqual([0x80, 60, 0]);
        });

        it("Control Change", () => {
            expect(frameMidi(0xb0, 7, 96)).toEqual([0xb0, 7, 96]);
        });

        it("Pitch Bend", () => {
            expect(frameMidi(0xe0, 0, 64)).toEqual([0xe0, 0, 64]);
        });

        it("Polyphonic Key Pressure", () => {
            expect(frameMidi(0xa0, 60, 80)).toEqual([0xa0, 60, 80]);
        });
    });

    describe("all 16 channels for Note On", () => {
        for (let ch = 0; ch < 16; ch++) {
            it(`channel ${ch + 1} (0x${(0x90 + ch).toString(16)})`, () => {
                const status = 0x90 + ch;
                expect(frameMidi(status, 60, 100)).toEqual([status, 60, 100]);
            });
        }
    });
});

describe("normalizeMidiTimestamp", () => {
    const FORWARD = 20;

    it("treats perf-epoch input as already normalized (no offset applied)", () => {
        // raw ~6040 ms is clearly not Date.now()-epoch and is fresh vs now ~6000
        const result = normalizeMidiTimestamp(6040, 6000, 1.78e12, FORWARD);
        expect(result).toBeCloseTo(6040 + FORWARD, 6);
    });

    it("converts worker Date.now()-epoch input via epochOffset", () => {
        // worker reports wall-clock epoch (~1.78e12); main-thread perf.now() ~6000
        const nowPerf = 6000;
        const epochOffset = 1.78e12 - nowPerf;
        const raw = 1.78e12 + 100; // event pushed 100ms after EPOCH_OFFSET was computed
        const result = normalizeMidiTimestamp(raw, nowPerf, epochOffset, FORWARD);
        expect(result).toBeCloseTo(nowPerf + 100 + FORWARD, -2);
    });

    it("falls back to now + forward when candidate is far in the future", () => {
        // candidate would be 6000 + 20000 > now(6000) + 5000
        const result = normalizeMidiTimestamp(26000, 6000, 0, FORWARD);
        expect(result).toBeCloseTo(6000 + FORWARD, 6);
    });

    it("falls back to now + forward when candidate is absurdly stale", () => {
        // candidate would be 100 < now(6000) - 50
        const result = normalizeMidiTimestamp(100, 6000, 0, FORWARD);
        expect(result).toBeCloseTo(6000 + FORWARD, 6);
    });

    it("keeps values just inside the clamp window boundaries", () => {
        // lower boundary: exactly now - 50
        expect(normalizeMidiTimestamp(5950, 6000, 0, 0)).toBe(5950);
        // upper boundary: exactly now + 5000
        expect(normalizeMidiTimestamp(11000, 6000, 0, 0)).toBe(11000);
    });

    it("is pure: same inputs always yield the same output", () => {
        const a = normalizeMidiTimestamp(1.78e12 + 42, 6000, 1.78e12 - 6000, FORWARD);
        const b = normalizeMidiTimestamp(1.78e12 + 42, 6000, 1.78e12 - 6000, FORWARD);
        expect(a).toBe(b);
    });
});

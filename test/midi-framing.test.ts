import { describe, it, expect } from "vitest";
import { frameMidi } from "../src/midi-framing";

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

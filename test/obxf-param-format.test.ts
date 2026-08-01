import { describe, it, expect } from "vitest";
import { paramFormat, paramParse, getParamFormat } from "../src/obxf-param-format";

describe("obxf-param-format", () => {
    describe("default percent", () => {
        it("formats 0..1 as percent", () => {
            expect(paramFormat("Volume", 0)).toBe("0 %");
            expect(paramFormat("Volume", 0.5)).toBe("50 %");
            expect(paramFormat("Volume", 1)).toBe("100 %");
            expect(paramFormat("FilterResonance", 0.25)).toBe("25 %");
        });
        it("parses percent to 0..1", () => {
            expect(paramParse("Volume", "50 %")).toBeCloseTo(0.5);
            expect(paramParse("Volume", "0 %")).toBe(0);
            expect(paramParse("Volume", "100 %")).toBe(1);
        });
        it("parses bare numbers", () => {
            expect(paramParse("Volume", "42")).toBeCloseTo(0.42);
        });
    });

    describe("semitones", () => {
        it("formats Transpose", () => {
            expect(paramFormat("Transpose", 0.5)).toBe("0 st");
            expect(paramFormat("Transpose", 0)).toBe("-24 st");
            expect(paramFormat("Transpose", 1)).toBe("24 st");
        });
        it("formats Osc1Pitch", () => {
            expect(paramFormat("Osc1Pitch", 0.5)).toBe("0 st");
            expect(paramFormat("Osc1Pitch", 0.75)).toBe("12 st");
        });
        it("parses semitones", () => {
            expect(paramParse("Transpose", "12 st")).toBeCloseTo(0.75);
            expect(paramParse("Transpose", "-24 st")).toBe(0);
            expect(paramParse("Transpose", "0 st")).toBeCloseTo(0.5);
        });
    });

    describe("cents", () => {
        it("formats Tune", () => {
            expect(paramFormat("Tune", 0.5)).toBe("0 cents");
            expect(paramFormat("Tune", 0)).toBe("-100 cents");
            expect(paramFormat("Tune", 1)).toBe("100 cents");
        });
        it("parses cents", () => {
            expect(paramParse("Tune", "50 cents")).toBeCloseTo(0.75);
            expect(paramParse("Tune", "-100 cents")).toBe(0);
        });
    });

    describe("pan", () => {
        it("formats center", () => {
            expect(paramFormat("PanVoice1", 0.5)).toBe("Center");
        });
        it("formats left", () => {
            expect(paramFormat("PanVoice1", 0)).toBe("100 L");
            expect(paramFormat("PanVoice1", 0.25)).toBe("50 L");
        });
        it("formats right", () => {
            expect(paramFormat("PanVoice1", 1)).toBe("100 R");
            expect(paramFormat("PanVoice1", 0.75)).toBe("50 R");
        });
        it("parses center", () => {
            expect(paramParse("PanVoice1", "Center")).toBeCloseTo(0.5);
            expect(paramParse("PanVoice1", "c")).toBeCloseTo(0.5);
        });
        it("parses L/R", () => {
            expect(paramParse("PanVoice1", "100 L")).toBeCloseTo(0);
            expect(paramParse("PanVoice1", "50 R")).toBeCloseTo(0.75);
            expect(paramParse("PanVoice1", "25 L")).toBeCloseTo(0.375);
        });
    });

    describe("bipolar percent", () => {
        it("formats bipolar", () => {
            expect(paramFormat("FilterKeyTrack", 0.5)).toBe("0 %");
            expect(paramFormat("FilterKeyTrack", 0)).toBe("-100 %");
            expect(paramFormat("FilterKeyTrack", 1)).toBe("100 %");
            expect(paramFormat("LFO1Wave1", 0.75)).toBe("50 %");
        });
        it("parses bipolar", () => {
            expect(paramParse("FilterKeyTrack", "50 %")).toBeCloseTo(0.75);
            expect(paramParse("FilterKeyTrack", "-100 %")).toBe(0);
            expect(paramParse("FilterKeyTrack", "0 %")).toBeCloseTo(0.5);
        });
    });

    describe("env time (log scale)", () => {
        it("formats milliseconds at low values", () => {
            const ms = paramFormat("FilterEnvAttack", 0);
            expect(ms).toMatch(/\d+ ms/);
        });
        it("formats seconds at high values", () => {
            const s = paramFormat("AmpEnvRelease", 1);
            expect(s).toMatch(/\d+\.\d s/);
        });
        it("formats center as mid-range", () => {
            const v = paramFormat("FilterEnvDecay", 0.5);
            expect(v).toBeTruthy();
        });
        it("parses ms", () => {
            const v01 = paramParse("FilterEnvAttack", "100 ms");
            expect(v01).not.toBeNull();
            expect(v01!).toBeGreaterThan(0);
            expect(v01!).toBeLessThan(0.5);
        });
        it("parses seconds", () => {
            const v01 = paramParse("AmpEnvRelease", "5.0 s");
            expect(v01).not.toBeNull();
            expect(v01!).toBeGreaterThan(0.5);
            expect(v01!).toBeLessThan(1);
        });
        it("round-trips", () => {
            for (const v of [0.1, 0.3, 0.5, 0.7, 0.9]) {
                const formatted = paramFormat("FilterEnvAttack", v);
                const parsed = paramParse("FilterEnvAttack", formatted);
                expect(parsed).not.toBeNull();
                expect(Math.abs(parsed! - v)).toBeLessThan(0.05);
            }
        });
    });

    describe("boolean", () => {
        it("formats on/off", () => {
            expect(paramFormat("HQMode", 0)).toBe("Off");
            expect(paramFormat("HQMode", 1)).toBe("On");
            expect(paramFormat("Unison", 0.5)).toBe("On");
        });
        it("parses on/off", () => {
            expect(paramParse("HQMode", "On")).toBe(1);
            expect(paramParse("HQMode", "Off")).toBe(0);
            expect(paramParse("HQMode", "1")).toBe(1);
            expect(paramParse("HQMode", "0")).toBe(0);
        });
    });

    describe("choice params", () => {
        it("formats Polyphony", () => {
            expect(paramFormat("Polyphony", 0)).toBe("1");
            expect(paramFormat("Polyphony", 7/31)).toBe("8");
            expect(paramFormat("Polyphony", 1)).toBe("32");
        });
        it("parses Polyphony", () => {
            expect(paramParse("Polyphony", "8")).toBeCloseTo(7/31);
            expect(paramParse("Polyphony", "16")).toBeCloseTo(15/31);
        });
        it("formats EnvLegatoMode", () => {
            expect(paramFormat("EnvLegatoMode", 0)).toBe("Both Envelopes");
            expect(paramFormat("EnvLegatoMode", 1)).toBe("Always Retrigger");
        });
        it("parses EnvLegatoMode", () => {
            expect(paramParse("EnvLegatoMode", "Both Envelopes")).toBe(0);
            expect(paramParse("EnvLegatoMode", "Always Retrigger")).toBe(1);
        });
        it("formats NoiseColor", () => {
            expect(paramFormat("NoiseColor", 0)).toBe("White");
            expect(paramFormat("NoiseColor", 0.5)).toBe("Pink");
            expect(paramFormat("NoiseColor", 1)).toBe("Red");
        });
        it("formats FilterXpanderMode", () => {
            expect(paramFormat("FilterXpanderMode", 0)).toBe("LP4");
            expect(paramFormat("FilterXpanderMode", 1)).toBe("PH3+LP1");
        });
    });

    describe("getParamFormat returns consistent objects", () => {
        it("returns same reference for same id", () => {
            const a = getParamFormat("Volume");
            const b = getParamFormat("Volume");
            expect(a).toBe(b);
        });
    });
});

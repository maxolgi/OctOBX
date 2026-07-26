import { describe, it, expect, beforeEach } from "vitest";
import {
    ObxfMidiLearnManager,
    isLearnableCC,
    ccTo01,
    LEARN_BLOCKLIST,
} from "../src/obxf-midi-learn";

describe("isLearnableCC", () => {
    it("rejects reserved CCs in the blocklist", () => {
        // CC 0 = bank select, CC 6 = data entry, CC 38 = LSB,
        // CC 64 = sustain, CC 74 = MPE timbre, CC 100/101 = RPN,
        // CC 120 = all sound off, CC 123 = all notes off
        for (const cc of [0, 6, 38, 64, 74, 100, 101, 120, 123]) {
            expect(isLearnableCC(cc), `CC ${cc}`).toBe(false);
        }
    });

    it("accepts non-reserved CCs", () => {
        for (const cc of [7, 10, 11, 12, 13, 14, 15, 16, 20, 44, 91, 93]) {
            expect(isLearnableCC(cc), `CC ${cc}`).toBe(true);
        }
    });

    it("CC 1 (mod wheel) IS in the blocklist (reserved for engine)", () => {
        expect(LEARN_BLOCKLIST.has(1)).toBe(true);
        expect(isLearnableCC(1)).toBe(false);
    });
});

describe("ccTo01", () => {
    it("maps CC value 0 → 0", () => {
        expect(ccTo01(0)).toBeCloseTo(0);
    });

    it("maps CC value 127 → 1", () => {
        expect(ccTo01(127)).toBeCloseTo(1);
    });

    it("maps CC value 64 → ~0.504", () => {
        expect(ccTo01(64)).toBeCloseTo(64 / 127, 2);
    });

    it("is monotonic", () => {
        let prev = -1;
        for (let v = 0; v <= 127; v++) {
            const n = ccTo01(v);
            expect(n).toBeGreaterThanOrEqual(prev);
            prev = n;
        }
    });

    it("clamps out-of-range inputs", () => {
        expect(ccTo01(-1)).toBe(0);
        expect(ccTo01(200)).toBe(1);
    });
});

describe("ObxfMidiLearnManager", () => {
    let mgr: ObxfMidiLearnManager;

    beforeEach(() => {
        mgr = new ObxfMidiLearnManager();
    });

    describe("learn mode", () => {
        it("starts not in learn mode", () => {
            expect(mgr.isLearnMode()).toBe(false);
        });

        it("enters learn mode", () => {
            mgr.setLearnMode(true);
            expect(mgr.isLearnMode()).toBe(true);
        });

        it("exits learn mode", () => {
            mgr.setLearnMode(true);
            mgr.setLearnMode(false);
            expect(mgr.isLearnMode()).toBe(false);
        });

        it("toggles learn mode", () => {
            mgr.setLearnMode(!mgr.isLearnMode());
            expect(mgr.isLearnMode()).toBe(true);
            mgr.setLearnMode(!mgr.isLearnMode());
            expect(mgr.isLearnMode()).toBe(false);
        });
    });

    describe("binding", () => {
        it("processCC returns null when not in learn mode and no binding exists", () => {
            const result = mgr.processCC(0, 7, 64);
            expect(result).toBeNull();
        });

        it("learns a CC binding when in learn mode", () => {
            mgr.setLearnMode(true);
            mgr.setLearnTarget("FilterCutoff");
            const result = mgr.processCC(0, 7, 64);
            // After learning, the same CC should be bound.
            expect(result).not.toBeNull();
        });

        it("applies binding after learning (processCC without learn mode)", () => {
            mgr.setLearnMode(true);
            mgr.setLearnTarget("FilterCutoff");
            mgr.processCC(0, 7, 64);
            mgr.setLearnMode(false);

            // Now sending CC 7 again should return a hit (not null).
            const result = mgr.processCC(0, 7, 100);
            expect(result).not.toBeNull();
            expect(result!.paramId).toBe("FilterCutoff");
        });

        it("does not learn reserved CCs even in learn mode", () => {
            mgr.setLearnMode(true);
            mgr.setLearnTarget("FilterCutoff");
            // CC 64 = sustain pedal (reserved)
            const result = mgr.processCC(0, 64, 127);
            expect(result).toBeNull();
        });
    });

    describe("unbinding", () => {
        it("unbindParam removes the binding", () => {
            mgr.setLearnMode(true);
            mgr.setLearnTarget("Volume");
            mgr.processCC(0, 7, 64);
            mgr.setLearnMode(false);

            // Verify it's bound
            expect(mgr.processCC(0, 7, 64)).not.toBeNull();

            // Unbind
            mgr.unbindParam("Volume");

            // Verify it's gone
            expect(mgr.processCC(0, 7, 64)).toBeNull();
        });
    });
});

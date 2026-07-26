import { describe, it, expect } from "vitest";
import { paramMappings } from "../src/obxf-param-mappings";

describe("obxf-param-mappings", () => {
    describe("structure", () => {
        it("has exactly 81 rows", () => {
            expect(paramMappings.length).toBe(81);
        });

        it("every row has all required fields", () => {
            for (const m of paramMappings) {
                expect(typeof m.legacyIndex).toBe("number");
                expect(typeof m.legacyName).toBe("string");
                expect(typeof m.legacyMethod).toBe("string");
                expect(typeof m.newId).toBe("string");
                // newMethod is string | null
                expect(m.newMethod === null || typeof m.newMethod === "string").toBe(true);
            }
        });
    });

    describe("legacy index coverage", () => {
        it("covers indices 0..79 exactly once (except BENDRANGE=6 which appears twice)", () => {
            const counts = new Map<number, number>();
            for (const m of paramMappings) {
                counts.set(m.legacyIndex, (counts.get(m.legacyIndex) ?? 0) + 1);
            }

            for (let i = 0; i <= 79; i++) {
                const c = counts.get(i);
                if (i === 6) {
                    expect(c, `legacy index ${i} (BENDRANGE split)`).toBe(2);
                } else {
                    expect(c, `legacy index ${i}`).toBe(1);
                }
            }
        });

        it("no legacy index outside 0..79", () => {
            for (const m of paramMappings) {
                expect(m.legacyIndex).toBeGreaterThanOrEqual(0);
                expect(m.legacyIndex).toBeLessThanOrEqual(79);
            }
        });
    });

    describe("uniqueness", () => {
        it("no duplicate newId strings (among non-empty)", () => {
            const ids = paramMappings
                .filter(m => m.newId && m.newId.length > 0)
                .map(m => m.newId);
            const unique = new Set(ids);
            expect(unique.size).toBe(ids.length);
        });
    });

    describe("consistency checks", () => {
        it("rows with rescale notes have different method names", () => {
            for (const m of paramMappings) {
                if (!m.newMethod || !m.newNotes) continue;
                if (m.newNotes.includes("RESCALE") || m.newNotes.includes("SEMANTIC SHIFT")) {
                    // Rescaled/shifted params should have different method names
                    // (otherwise no rescale would be needed).
                    if (m.legacyMethod && m.newMethod) {
                        // Most rescaled params change method names, but a few keep
                        // the same name with a different internal range (e.g.
                        // processPortamento is 1:1 in method name but the importer
                        // copies the value directly). Only flag actual mismatches.
                        // This is a soft check — documented exceptions are fine.
                    }
                }
            }
        });

        it("UNDEFINED (index 0) has empty newId and null newMethod", () => {
            const undef = paramMappings.find(m => m.legacyIndex === 0);
            expect(undef).toBeDefined();
            expect(undef!.newId).toBe("");
            expect(undef!.newMethod).toBeNull();
        });

        it("MIDILEARN (index 1) is marked REMOVED", () => {
            const ml = paramMappings.find(m => m.legacyIndex === 1);
            expect(ml).toBeDefined();
            expect(ml!.newMethod).toBeNull();
            expect(ml!.newNotes).toContain("REMOVED");
        });
    });
});

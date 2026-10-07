/*
 * worklet-export-sync.test.ts — statically enforces that every WASM export
 * the combined AudioWorklet calls by name actually exists in the emcc export
 * lists of the two Makefiles.
 *
 * src/obxd-processor.tail.js calls into the WASM modules dynamically
 * (`wasmModule._obxd_render(...)`, `octModule._wasm_key_press(...)`,
 * `wasmModule.FS`, `wasmModule.UTF8ToString`, ...). If an identifier is
 * missing from `-sEXPORTED_FUNCTIONS` / `-sEXPORTED_RUNTIME_METHODS`, the
 * member is silently absent from the built Module object (runtime methods)
 * or the call throws at runtime inside the AudioWorklet. There is no
 * compiler check bridging the JS and the Makefiles — this test is it.
 *
 * Mapping:
 *   octModule.*  → wasm/Makefile (Octopus engine)
 *   wasmModule.* → wasm/obxd/Makefile (OB-Xf synth + guitarix FX + mixer taps)
 *
 * Rule: an identifier starting with "_" must be in the module's
 * exported-FUNCTIONS list; anything else (FS, UTF8ToString, HEAPU8, ...)
 * must be in its EXPORTED_RUNTIME_METHODS list.
 *
 * Pure static parsing — no browser, no WASM, no build artifacts needed.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

function read(rel: string): string {
    return readFileSync(new URL(rel, import.meta.url), "utf8");
}

const tail = read("../src/obxd-processor.tail.js");
const octMakefile = read("../wasm/Makefile");
const obxdMakefile = read("../wasm/obxd/Makefile");

// ---------------------------------------------------------------------------
// 1. Harvest member accesses from the worklet tail.
//    Only direct `wasmModule.X` / `octModule.X` property accesses — locals
//    like `mixer`, `taskQueue`, `midiSabRing` are out of scope.
// ---------------------------------------------------------------------------

const MEMBER_RE = /\b(?:wasmModule|octModule)\.(_?[A-Za-z_$][\w$]*)/g;

function extractMembers(module: "wasmModule" | "octModule"): string[] {
    const found = new Set<string>();
    for (const m of tail.matchAll(MEMBER_RE)) {
        const owner = m[0].slice(0, m[0].indexOf("."));
        if (owner === module) found.add(m[1]);
    }
    return [...found].sort();
}

const octAccesses = extractMembers("octModule");
const obxdAccesses = extractMembers("wasmModule");

// ---------------------------------------------------------------------------
// 2. Parse the Makefile export lists.
// ---------------------------------------------------------------------------

function mustMatch(source: string, re: RegExp, what: string): string {
    const m = source.match(re);
    if (!m) throw new Error(`cannot parse ${what} — Makefile format drifted?`);
    return m[1];
}

// wasm/Makefile flags are backslash-continued; the value itself contains no
// whitespace, so capture the comma-separated run up to the next space.
const octExportedFunctions = mustMatch(
    octMakefile,
    /-sEXPORTED_FUNCTIONS=([^\s\\]+)/,
    "wasm/Makefile -sEXPORTED_FUNCTIONS",
)
    .split(",")
    .filter(Boolean);

const octRuntimeMethods = mustMatch(
    octMakefile,
    /-sEXPORTED_RUNTIME_METHODS=([^\s\\]+)/,
    "wasm/Makefile -sEXPORTED_RUNTIME_METHODS",
)
    .split(",")
    .filter(Boolean);

// wasm/obxd/Makefile's EXPORTS is deliberately ONE physical line (comments
// in that file warn that `\<newline>` continuations insert whitespace that
// emcc rejects) — match the whole single line, no continuation handling.
const obxdExportedFunctions = mustMatch(
    obxdMakefile,
    /^EXPORTS = (.+)$/m,
    "wasm/obxd/Makefile EXPORTS",
)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const obxdRuntimeMethods = mustMatch(
    obxdMakefile,
    /-sEXPORTED_RUNTIME_METHODS=([^\s\\]+)/,
    "wasm/obxd/Makefile -sEXPORTED_RUNTIME_METHODS",
)
    .split(",")
    .filter(Boolean);

// ---------------------------------------------------------------------------
// 3. The sync assertions.
// ---------------------------------------------------------------------------

interface ModuleSpec {
    label: string;
    makefile: string;
    accesses: string[];
    functions: string[];
    runtimeMethods: string[];
}

const specs: ModuleSpec[] = [
    {
        label: "octModule (Octopus engine)",
        makefile: "wasm/Makefile",
        accesses: octAccesses,
        functions: octExportedFunctions,
        runtimeMethods: octRuntimeMethods,
    },
    {
        label: "wasmModule (OB-Xf synth)",
        makefile: "wasm/obxd/Makefile",
        accesses: obxdAccesses,
        functions: obxdExportedFunctions,
        runtimeMethods: obxdRuntimeMethods,
    },
];

function missingFrom(accesses: string[], list: string[]): string[] {
    const have = new Set(list);
    return accesses.filter((id) => !have.has(id));
}

describe("worklet ↔ Makefile export sync", () => {
    it("parses non-empty export lists from both Makefiles", () => {
        expect(octExportedFunctions.length).toBeGreaterThan(0);
        expect(octRuntimeMethods.length).toBeGreaterThan(0);
        expect(obxdExportedFunctions.length).toBeGreaterThan(0);
        expect(obxdRuntimeMethods.length).toBeGreaterThan(0);
    });

    it("finds member accesses on both modules in the tail", () => {
        expect(octAccesses.length).toBeGreaterThan(0);
        expect(obxdAccesses.length).toBeGreaterThan(0);
    });

    for (const spec of specs) {
        it(`${spec.label}: every _-prefixed access is in EXPORTED_FUNCTIONS`, () => {
            const fns = spec.accesses.filter((id) => id.startsWith("_"));
            expect(fns.length).toBeGreaterThan(0);
            const missing = missingFrom(fns, spec.functions);
            expect(
                missing,
                `missing from ${spec.makefile} -sEXPORTED_FUNCTIONS (a rebuild is ` +
                    `required after editing the list):\n  ${missing.join("\n  ")}`,
            ).toEqual([]);
        });

        it(`${spec.label}: every non-_ access is in EXPORTED_RUNTIME_METHODS`, () => {
            const runtime = spec.accesses.filter((id) => !id.startsWith("_"));
            expect(runtime.length).toBeGreaterThan(0);
            const missing = missingFrom(runtime, spec.runtimeMethods);
            expect(
                missing,
                `missing from ${spec.makefile} -sEXPORTED_RUNTIME_METHODS ` +
                    `(silently absent on the Module at runtime):\n  ${missing.join("\n  ")}`,
            ).toEqual([]);
        });
    }

    it("coverage summary", () => {
        // eslint-disable-next-line no-console
        console.log(
            `[worklet-export-sync] octModule: ${octAccesses.length} identifiers ` +
                `(${octAccesses.filter((i) => i.startsWith("_")).length} functions, ` +
                `${octAccesses.filter((i) => !i.startsWith("_")).length} runtime methods); ` +
                `wasmModule: ${obxdAccesses.length} identifiers ` +
                `(${obxdAccesses.filter((i) => i.startsWith("_")).length} functions, ` +
                `${obxdAccesses.filter((i) => !i.startsWith("_")).length} runtime methods)`,
        );
        expect(true).toBe(true);
    });
});

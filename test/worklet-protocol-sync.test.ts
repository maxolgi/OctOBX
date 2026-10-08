/*
 * worklet-protocol-sync.test.ts — statically enforces that the worklet
 * message-protocol spec (tools/worklet-protocol.mjs), the handler tail
 * (src/obxd-processor.tail.js) and the generated artifacts
 * (src/generated/worklet-protocol.ts + worklet-protocol-checks.js) cannot
 * silently drift apart.
 *
 * The bug class this gate kills: EVERY tail handler null-guards its field
 * reads (`if (wasmModule && typeof msg.idx === 'number') ...`), so a mistyped
 * or renamed message field never throws — the handler quietly no-ops and a
 * knob/meter/save just stops working with nothing in the console. The spec
 * is the declared single source of truth for the wire shapes; these tests
 * prove the tail actually speaks it and the generated files are fresh:
 *
 *   1. handler coverage, both directions — every mainToWorklet type has a
 *      `case` in the tail's msg.type switch and vice versa; every
 *      workletToMain type has a `postMessage({type:...})` site and vice
 *      versa.
 *   2. field presence — every required mainToWorklet field is read as
 *      `msg.<field>` inside its case block (two documented exemptions,
 *      see FIELD_EXEMPTIONS).
 *   3. generator freshness — `node tools/gen-worklet-protocol.mjs --check`
 *      exits 0, so a stale generated file fails `npm test`, not just CI.
 *   4. runtime unit tests for the generated shape validator
 *      (worklet-protocol-checks.js), loaded off globalThis.
 *
 * Pure static parsing + one child process — no browser, no WASM, no build
 * artifacts needed.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PROTOCOL, parseFieldDsl } from "../tools/worklet-protocol.mjs";
// Side-effect import: the checks file is a classic script (AudioWorklet-safe:
// no import/export) whose top level registers the validator and the
// main→worklet type set on globalThis — grabbed below from there
// (awp-task-queue.test.ts pattern).
import "../src/generated/worklet-protocol-checks";

function read(rel: string): string {
    return readFileSync(new URL(rel, import.meta.url), "utf8");
}

const tail = read("../src/obxd-processor.tail.js");

interface SpecEntry {
    type: string;
    fields: Record<string, string>;
    notes: string;
}
const mainToWorklet = PROTOCOL.mainToWorklet as SpecEntry[];
const workletToMain = PROTOCOL.workletToMain as SpecEntry[];

// ---------------------------------------------------------------------------
// 1. Harvest the tail's message surface: `case '<name>':` string literals
//    (the only string-case switch in the file is the onmessage msg.type
//    switch) and reply types posted via postMessage object literals whose
//    `type` field is first.
// ---------------------------------------------------------------------------

const CASE_RE = /case '([a-z][a-z0-9_]*)':/g;
const tailCases = [...new Set([...tail.matchAll(CASE_RE)].map((m) => m[1]))].sort();

const POST_RE = /postMessage\(\s*\{\s*type:\s*'([a-z][a-z0-9_]*)'/g;
const postedTypes = [...new Set([...tail.matchAll(POST_RE)].map((m) => m[1]))].sort();

const specMainTypes = new Set(mainToWorklet.map((e) => e.type));
const specReplyTypes = new Set(workletToMain.map((e) => e.type));

// A case block runs from its `case '<type>':` literal to the next `case '`
// or the `default:` arm (the switch is flat — there are no nested switches).
function caseBlock(type: string): string | null {
    const m = tail.match(new RegExp("case '" + type + "':[\\s\\S]*?(?=case '|default:)"));
    return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// 2. Field-presence exemptions — the ONLY (type, field) pairs allowed to
//    skip the in-block `msg.<field>` check. Each row's read lives elsewhere
//    in the file; a standalone test below pins that evidence. Keep tiny.
// ---------------------------------------------------------------------------

const FIELD_EXEMPTIONS: ReadonlyArray<{ type: string; field: string }> = [
    // `instance_id` — pre-extracted ONCE at the top of onmessage
    // (`const id = ... msg.instance_id ...`), so nearly every case body reads
    // the local `id` instead of re-reading msg.instance_id. Evidence: the
    // extraction-line test asserts that single line exists file-wide.
    { type: "*", field: "instance_id" },
    // `midi` — the case body only queues the whole message
    // (`pendingMidi.push(msg)`); its fields are read in the process() drain
    // loop off the QUEUED element (`m.status | 0`, ...), not off `msg` in the
    // block. Evidence: the drain-read test checks each `.<field>` member
    // access file-wide.
    { type: "midi", field: "status" },
    { type: "midi", field: "d1" },
    { type: "midi", field: "d2" },
];

function isExempt(type: string, field: string): boolean {
    return FIELD_EXEMPTIONS.some((x) => x.field === field && (x.type === "*" || x.type === type));
}

function requiredFields(entry: SpecEntry): string[] {
    return Object.entries(entry.fields)
        .filter(([, dsl]) => !parseFieldDsl(dsl).optional)
        .map(([name]) => name);
}

// Messages with at least one required field that must appear in-block.
const fieldChecked = mainToWorklet.filter((e) =>
    requiredFields(e).some((f) => !isExempt(e.type, f)),
);

describe("worklet protocol sync (spec ↔ tail ↔ generated)", () => {
    it("parses non-empty spec arrays and tail harvests", () => {
        expect(mainToWorklet.length).toBeGreaterThan(0);
        expect(workletToMain.length).toBeGreaterThan(0);
        expect(tailCases.length).toBeGreaterThan(0);
        expect(postedTypes.length).toBeGreaterThan(0);
    });

    // -- 1a. handler coverage, main → worklet --------------------------------

    it("every PROTOCOL.mainToWorklet type has a case in the tail", () => {
        const missing = [...specMainTypes].filter((t) => !tailCases.includes(t));
        expect(
            missing,
            `spec types with no case in src/obxd-processor.tail.js (the handler is ` +
                `missing — messages silently hit default:):\n  ${missing.join("\n  ")}`,
        ).toEqual([]);
    });

    it("every tail case is in the spec (mainToWorklet)", () => {
        const extra = tailCases.filter((t) => !specMainTypes.has(t));
        expect(
            extra,
            `case literals not in PROTOCOL.mainToWorklet (undocumented handler — add the ` +
                `wire shape to tools/worklet-protocol.mjs and regenerate):\n  ${extra.join("\n  ")}`,
        ).toEqual([]);
    });

    // -- 1b. reply coverage, worklet → main -----------------------------------

    it("every PROTOCOL.workletToMain type has a postMessage site in the tail", () => {
        const missing = [...specReplyTypes].filter((t) => !postedTypes.includes(t));
        expect(
            missing,
            `spec reply types never posted by src/obxd-processor.tail.js (dead spec row or ` +
                `forgotten post — fix one side):\n  ${missing.join("\n  ")}`,
        ).toEqual([]);
    });

    it("every posted type is in the spec (workletToMain)", () => {
        const extra = postedTypes.filter((t) => !specReplyTypes.has(t));
        expect(
            extra,
            `posted types not in PROTOCOL.workletToMain (undocumented reply — add it to ` +
                `tools/worklet-protocol.mjs and regenerate):\n  ${extra.join("\n  ")}`,
        ).toEqual([]);
    });

    // -- 2. field presence (main→worklet only) ---------------------------------

    it("onmessage pre-extracts msg.instance_id exactly once (the local `id`)", () => {
        const hits = [
            ...tail.matchAll(/const id = \(typeof msg\.instance_id === 'number'\)/g),
        ];
        expect(hits.length).toBe(1);
    });

    it("'midi' fields (status/d1/d2) are read file-wide, in the process() drain loop", () => {
        for (const f of ["status", "d1", "d2"]) {
            const hits = tail.match(new RegExp(`\\.${f}\\b`, "g"));
            expect(
                hits?.length ?? 0,
                `no .${f} member read anywhere in the tail — the queued midi payload is ` +
                    `never decoded`,
            ).toBeGreaterThan(0);
        }
    });

    for (const entry of fieldChecked) {
        it(`'${entry.type}': every required field is read as msg.<field> in its case block`, () => {
            const block = caseBlock(entry.type);
            if (block === null) {
                throw new Error(
                    `cannot locate case '${entry.type}' in src/obxd-processor.tail.js — the ` +
                        `case-block field check cannot run`,
                );
            }
            const missing = requiredFields(entry)
                .filter((f) => !isExempt(entry.type, f))
                .filter((f) => !new RegExp(`\\bmsg\\.${f}\\b`).test(block));
            expect(
                missing,
                `'${entry.type}': required fields never read as msg.<field> inside the case ` +
                    `block (every handler null-guards, so a mistyped field silently no-ops — ` +
                    `fix the sender, the tail, or the spec):\n  ${missing.join("\n  ")}`,
            ).toEqual([]);
        });
    }

    // -- 3. generator freshness -------------------------------------------------

    it("generated protocol artifacts are fresh (gen-worklet-protocol.mjs --check exits 0)", () => {
        let out: string;
        try {
            out = execSync("node tools/gen-worklet-protocol.mjs --check", {
                cwd: fileURLToPath(new URL("..", import.meta.url)),
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (e) {
            const err = e as { status?: number; stdout?: string; stderr?: string };
            throw new Error(
                `node tools/gen-worklet-protocol.mjs --check exited ${err.status} — generated ` +
                    `protocol artifacts are stale. Regenerate with:\n` +
                    `  node tools/gen-worklet-protocol.mjs\n` +
                    `${err.stdout ?? ""}${err.stderr ?? ""}`,
            );
        }
        expect(out).toContain("fresh");
    });

    it("coverage summary", () => {
        // eslint-disable-next-line no-console
        console.log(
            `[worklet-protocol-sync] main→worklet: ${specMainTypes.size} spec types, ` +
                `${tailCases.length} tail cases, ${fieldChecked.length} field-checked messages; ` +
                `worklet→main: ${specReplyTypes.size} spec types, ${postedTypes.length} unique ` +
                `posted types`,
        );
        expect(true).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 4. Runtime unit tests for the generated shape validator. The classic
//    script registered `__workletProtocolCheck` + `WORKLET_PROTOCOL_TYPES`
//    on globalThis at import time (see the side-effect import above).
// ---------------------------------------------------------------------------

const protocolCheck = (globalThis as {
    __workletProtocolCheck: (msg: unknown) => string | null;
}).__workletProtocolCheck;
const protocolTypes = (globalThis as { WORKLET_PROTOCOL_TYPES: Set<string> })
    .WORKLET_PROTOCOL_TYPES;

describe("worklet protocol shape validator (generated checks file)", () => {
    it("registers the validator + type set on globalThis", () => {
        expect(typeof protocolCheck).toBe("function");
        expect(protocolTypes).toBeInstanceOf(Set);
    });

    it("accepts a well-formed set_param", () => {
        expect(protocolCheck({ type: "set_param", instance_id: 0, idx: 2, value: 0.5 })).toBeNull();
    });

    it("flags a missing required field", () => {
        expect(protocolCheck({ type: "set_param", instance_id: 0, idx: 2 })).toContain(
            "missing field",
        );
    });

    it("flags a wrong-typed field", () => {
        expect(
            protocolCheck({ type: "set_param", instance_id: 0, idx: 2, value: "x" }),
        ).toContain("expected number");
    });

    it("flags an unknown message type", () => {
        expect(protocolCheck({ type: "bogus" })).toContain("unknown message type");
    });

    it("requires instance_id on midi (required on the wire even though queued whole)", () => {
        expect(protocolCheck({ type: "midi", status: 144, d1: 60, d2: 100 })).toContain(
            "missing field",
        );
    });

    it("accepts a boolean for bool fields (set_active.active)", () => {
        expect(protocolCheck({ type: "set_active", instance_id: 0, active: true })).toBeNull();
    });

    it("rejects a boolean for numeric 0/1 flags (set_mpe.enabled is 'flag', not 'bool')", () => {
        expect(protocolCheck({ type: "set_mpe", instance_id: 0, enabled: true })).toContain(
            "expected number",
        );
    });

    it("returns null for non-object input (documented behavior)", () => {
        expect(protocolCheck(null)).toBeNull();
    });

    it("WORKLET_PROTOCOL_TYPES covers main→worklet only", () => {
        expect(protocolTypes.size).toBe(75);
        expect(protocolTypes.has("set_param")).toBe(true);
        expect(protocolTypes.has("pong")).toBe(false);
    });
});

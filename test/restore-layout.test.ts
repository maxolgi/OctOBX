/*
 * restore-layout.test.ts — guards the generated bulk save/restore layout
 * constants (src/generated/restore-layout.js) against drift.
 *
 * Background: src/obxd-processor.tail.js dumps/restores synth state as
 * instances × stride floats (stride = legacy 80 + new 28 = 108) and drum
 * state as pads × layers × stride. Those numbers must stay in lockstep with
 * the C side (wasm/obxd/main_obxd.cpp INSTANCE_COUNT / RESTORE_* defines,
 * pcmBank[8][4]) or saved projects silently corrupt on load. The generator
 * (tools/gen-param-table.mjs) emits them from tools/param-spec.mjs so both
 * sides share one source of truth; this test pins the invariants and
 * cross-checks them against the machine-readable sidecar
 * (src/generated/param-table.json).
 *
 * The generated file is a plain classic script (no import/export — build.sh
 * concatenates it into wasm/build/obxd-processor.js ahead of the worklet
 * code), so we load it by evaluating the source text rather than importing.
 *
 * Pure logic — no browser, no WASM.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import paramTable from "../src/generated/param-table.json";

interface RestoreLayout {
    OBXD_INSTANCE_COUNT: number;
    OBXD_LEGACY_PARAM_COUNT: number;
    OBXD_NEW_PARAM_COUNT: number;
    OBXD_NEW_PARAM_BASE: number;
    OBXD_RESTORE_STRIDE: number;
    OBXD_DRUM_PADS: number;
    OBXD_DRUM_LAYERS: number;
    OBXD_DRUM_STRIDE: number;
}

function loadRestoreLayout(): RestoreLayout {
    const src = readFileSync(
        new URL("../src/generated/restore-layout.js", import.meta.url),
        "utf8",
    );
    // Classic-script consts are not module exports; eval the source in a
    // fresh function scope and harvest the bindings.
    const fn = new Function(
        `${src}\nreturn {` +
            [
                "OBXD_INSTANCE_COUNT",
                "OBXD_LEGACY_PARAM_COUNT",
                "OBXD_NEW_PARAM_COUNT",
                "OBXD_NEW_PARAM_BASE",
                "OBXD_RESTORE_STRIDE",
                "OBXD_DRUM_PADS",
                "OBXD_DRUM_LAYERS",
                "OBXD_DRUM_STRIDE",
            ].join(",") +
            `};`,
    ) as () => RestoreLayout;
    return fn();
}

const layout = loadRestoreLayout();

describe("restore-layout (generated)", () => {
    it("defines the expected constants", () => {
        expect(layout).toEqual({
            OBXD_INSTANCE_COUNT: 10,
            OBXD_LEGACY_PARAM_COUNT: 80,
            OBXD_NEW_PARAM_COUNT: 28,
            OBXD_NEW_PARAM_BASE: 200,
            OBXD_RESTORE_STRIDE: 108,
            OBXD_DRUM_PADS: 8,
            OBXD_DRUM_LAYERS: 4,
            OBXD_DRUM_STRIDE: 432,
        });
    });

    it("STRIDE is exactly LEGACY + NEW param counts", () => {
        expect(layout.OBXD_RESTORE_STRIDE).toBe(108);
        expect(layout.OBXD_RESTORE_STRIDE).toBe(
            layout.OBXD_LEGACY_PARAM_COUNT + layout.OBXD_NEW_PARAM_COUNT,
        );
    });

    it("DRUM_STRIDE is LAYERS × STRIDE", () => {
        expect(layout.OBXD_DRUM_STRIDE).toBe(432);
        expect(layout.OBXD_DRUM_STRIDE).toBe(
            layout.OBXD_DRUM_LAYERS * layout.OBXD_RESTORE_STRIDE,
        );
    });

    it("NEW_PARAM_BASE sentinel is 200", () => {
        expect(layout.OBXD_NEW_PARAM_BASE).toBe(200);
        expect(layout.OBXD_NEW_PARAM_BASE).toBeGreaterThanOrEqual(
            layout.OBXD_LEGACY_PARAM_COUNT + layout.OBXD_NEW_PARAM_COUNT,
        ); // must not collide with the dense legacy+new index space
    });

    describe("sidecar cross-check (param-table.json restoreLayout/constants)", () => {
        const sidecar = paramTable as unknown as {
            constants: {
                PARAM_COUNT: number;
                NEW_PARAM_BASE: number;
                NEW_PARAM_COUNT: number;
            };
            canonicalNewParamOrder: string[];
            restoreLayout?: Record<string, number>;
        };

        it("counts agree with the sidecar constants block", () => {
            expect(layout.OBXD_LEGACY_PARAM_COUNT).toBe(sidecar.constants.PARAM_COUNT);
            expect(layout.OBXD_NEW_PARAM_COUNT).toBe(sidecar.constants.NEW_PARAM_COUNT);
            expect(layout.OBXD_NEW_PARAM_BASE).toBe(sidecar.constants.NEW_PARAM_BASE);
        });

        it("NEW count agrees with canonicalNewParamOrder.length", () => {
            expect(layout.OBXD_NEW_PARAM_COUNT).toBe(sidecar.canonicalNewParamOrder.length);
        });

        it("sidecar restoreLayout block mirrors the JS consts", () => {
            expect(sidecar.restoreLayout).toBeDefined();
            expect(sidecar.restoreLayout!.instanceCount).toBe(layout.OBXD_INSTANCE_COUNT);
            expect(sidecar.restoreLayout!.legacyParamCount).toBe(layout.OBXD_LEGACY_PARAM_COUNT);
            expect(sidecar.restoreLayout!.newParamCount).toBe(layout.OBXD_NEW_PARAM_COUNT);
            expect(sidecar.restoreLayout!.newParamBase).toBe(layout.OBXD_NEW_PARAM_BASE);
            expect(sidecar.restoreLayout!.stride).toBe(layout.OBXD_RESTORE_STRIDE);
            expect(sidecar.restoreLayout!.drumPads).toBe(layout.OBXD_DRUM_PADS);
            expect(sidecar.restoreLayout!.drumLayers).toBe(layout.OBXD_DRUM_LAYERS);
            expect(sidecar.restoreLayout!.drumStride).toBe(layout.OBXD_DRUM_STRIDE);
        });
    });

    it("total dump lengths match app-state expectations", () => {
        // app-state.ts bulk-dumps these exact array lengths per save.
        expect(layout.OBXD_INSTANCE_COUNT * layout.OBXD_RESTORE_STRIDE).toBe(1080); // synth
        expect(layout.OBXD_DRUM_PADS * layout.OBXD_DRUM_LAYERS * layout.OBXD_RESTORE_STRIDE).toBe(3456); // drum
    });
});

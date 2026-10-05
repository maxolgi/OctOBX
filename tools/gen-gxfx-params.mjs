#!/usr/bin/env node
// ===========================================================================
// gen-gxfx-params.mjs — generates every consumable artifact of the guitarix
// FX param spec (fx2plan.md Phase 0: the current 11 effects).
//
// SOURCE OF TRUTH for param DATA: tools/gxfx-param-spec.json — the ports,
// symbols, labels, ranges and defaults were transcribed from the guitarix
// ttl files and hand-verified when the 11-effect rack shipped (commit
// eeb5793; note the labels are humanized vs the raw ttl "VOLUME"/"WAH"
// strings, so the ttl cannot be re-parsed to reproduce them). The generator
// owns everything STRUCTURAL: the effect key → menu category map, out_ports
// (empty for all 11 in Phase 0), and the per-slot param array size (48).
//
// Emitted artifacts (all committed; deterministic, no timestamps):
//   1. tools/gxfx-param-spec.json  rewritten to the v2 shape: everything v1
//                                  had, PLUS per effect `category` and
//                                  `out_ports` (name+range, for meters/tuner
//                                  freq — Phase 2/3)
//   2. src/gxfx-params.ts          GENERATED TS param tables — same public
//                                  API the UI imports (FX_EFFECTS, the
//                                  0..1↔engine transforms, flat-mirror
//                                  helpers) + `category` on each effect
//   3. wasm/obxd/gxfx_defaults.h   C default tables (FX_DEFAULTS[11][48] +
//                                  FX_PARAM_COUNTS[11]) for the slot-model
//                                  C-engine rework — not yet in any Makefile
//                                  HDRS list; consumed by a later task
//
// Usage:
//   node tools/gen-gxfx-params.mjs           # write all three outputs
//   node tools/gen-gxfx-params.mjs --check   # byte-compare against the
//                                            # committed files; exit 0 fresh,
//                                            # exit 1 listing stale paths
//
// Deterministic by construction: effects in id order (0..10), params in
// port order, insertion-stable object construction — --check is
// byte-stable across runs. Reading a v2 spec back in is idempotent
// (stored category/out_ports are ignored and re-applied from here).
// Node >= 20, no dependencies.
// ===========================================================================

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const SPEC_JSON = 'tools/gxfx-param-spec.json';
const OUT_JSON = 'tools/gxfx-param-spec.json';
const OUT_TS = 'src/gxfx-params.ts';
const OUT_H = 'wasm/obxd/gxfx_defaults.h';

const FX_COUNT = 11;        // v1 effect catalog — Phase 0 keeps the current 11
const FX_SLOTS = 11;
const FX_INSTANCE_COUNT = 10;
const FX_SLOT_PARAMS = 48;  // per-slot param array size (fx2plan.md: max params tree-wide = 39)

// Effect key → menu category. Phase 0 assignments for the current 11; the
// full v2 vocabulary (drive|wah|eq|filter|dynamics|modulation|delay|reverb|
// amp|tonestack|multiband|special) is mirrored in src/gxfx-params.ts.
const CATEGORY_BY_KEY = {
    wah: 'wah',
    overdrive: 'drive',
    distortion: 'drive',
    compressor: 'dynamics',
    chorus: 'modulation',
    flanger: 'modulation',
    phaser: 'modulation',
    tremolo: 'modulation',
    delay: 'delay',
    echo: 'delay',
    reverb: 'reverb',
};

// ---------------------------------------------------------------------------
// Spec load + validation
// ---------------------------------------------------------------------------

function loadSpec() {
    const problems = [];
    let raw;
    try {
        raw = JSON.parse(readFileSync(join(ROOT, SPEC_JSON), 'utf8'));
    } catch (e) {
        console.error(`ERROR: cannot parse ${SPEC_JSON}: ${e.message}`);
        process.exit(2);
    }
    if (raw.version !== 1 && raw.version !== 2) {
        problems.push(`version must be 1 or 2, got ${JSON.stringify(raw.version)}`);
    }
    if (!Array.isArray(raw.effects)) {
        problems.push('effects must be an array');
        raw.effects = [];
    }
    if (raw.effects.length !== FX_COUNT) {
        problems.push(`expected ${FX_COUNT} effects, got ${raw.effects.length}`);
    }
    const specKeys = new Set();
    raw.effects.forEach((e, i) => {
        const where = `effects[${i}]`;
        if (typeof e.key !== 'string' || !e.key) { problems.push(`${where}.key must be a non-empty string`); return; }
        specKeys.add(e.key);
        if (e.id !== i) problems.push(`${where}.id must be ${i} (effects sorted by id), got ${JSON.stringify(e.id)}`);
        if (!(e.key in CATEGORY_BY_KEY)) problems.push(`${where}.key "${e.key}" has no category mapping`);
        if (typeof e.label !== 'string') problems.push(`${where}.label must be a string`);
        if (typeof e.dsp !== 'string') problems.push(`${where}.dsp must be a string`);
        if (typeof e.stereo !== 'boolean') problems.push(`${where}.stereo must be a boolean`);
        if (!Array.isArray(e.params) || e.params.length === 0) { problems.push(`${where}.params must be a non-empty array`); return; }
        let prevPort = -1;
        e.params.forEach((p, j) => {
            const pw = `${where}.params[${j}]`;
            if (!Number.isInteger(p.port) || p.port < 0 || p.port >= FX_SLOT_PARAMS) problems.push(`${pw}.port must be an integer in 0..${FX_SLOT_PARAMS - 1}`);
            if (p.port <= prevPort) problems.push(`${pw}.port ${p.port} breaks ascending port order`);
            prevPort = p.port;
            if (typeof p.symbol !== 'string' || typeof p.name !== 'string') problems.push(`${pw}.symbol/.name must be strings`);
            for (const f of ['default', 'min', 'max', 'step']) {
                if (typeof p[f] !== 'number' || !Number.isFinite(p[f])) problems.push(`${pw}.${f} must be a finite number`);
            }
            if (p.min >= p.max) problems.push(`${pw}: min ${p.min} must be < max ${p.max}`);
            if (p.default < p.min || p.default > p.max) problems.push(`${pw}: default ${p.default} outside [${p.min}, ${p.max}]`);
            if (p.step <= 0) problems.push(`${pw}.step must be > 0`);
            if (typeof p.toggled !== 'boolean' || typeof p.integer !== 'boolean') problems.push(`${pw}.toggled/.integer must be booleans`);
        });
    });
    for (const key of Object.keys(CATEGORY_BY_KEY)) {
        if (!specKeys.has(key)) problems.push(`category map key "${key}" missing from the spec`);
    }
    return { raw, problems };
}

// Normalize to the v2 shape — category/out_ports always re-applied from here
// (idempotent on v2 input: same bytes in, same bytes out).
function normalize(raw) {
    let offset = 0;
    const effects = raw.effects.map((e) => {
        const fx = {
            id: e.id,
            key: e.key,
            label: e.label,
            dsp: e.dsp,
            stereo: e.stereo,
            category: CATEGORY_BY_KEY[e.key],
            out_ports: [],
            params: e.params.map((p) => ({
                port: p.port,
                symbol: p.symbol,
                name: p.name,
                default: p.default,
                min: p.min,
                max: p.max,
                step: p.step,
                toggled: p.toggled,
                integer: p.integer,
            })),
            offset,
        };
        offset += fx.params.length;
        return fx;
    });
    return { effects, totalParams: offset };
}

// ---------------------------------------------------------------------------
// Deterministic number formatting (JS doubles → minimal round-trip decimals)
// ---------------------------------------------------------------------------

function fmtNum(x) {
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`non-finite constant: ${x}`);
    const s = String(x);
    if (s.includes('e') || s.includes('E')) throw new Error(`constant ${x} formats exponentially; extend the formatter`);
    return s;
}
// C float literal (always carries a decimal point)
const fC = (x) => (Number.isInteger(x) ? `${x}.0f` : `${fmtNum(x)}f`);
// TS literal (JS double, exact)
const tS = (x) => fmtNum(x);
const q = (s) => JSON.stringify(String(s));

// ---------------------------------------------------------------------------
// Output 1: tools/gxfx-param-spec.json (v2 shape)
// ---------------------------------------------------------------------------

function genJson({ effects }) {
    // `offset` is derived (cumulative param count) and stays out of the spec —
    // only the TS emitter computes it.
    const dump = {
        version: 2,
        effects: effects.map((e) => ({
            id: e.id,
            key: e.key,
            label: e.label,
            dsp: e.dsp,
            stereo: e.stereo,
            category: e.category,
            out_ports: e.out_ports,
            params: e.params,
        })),
    };
    return JSON.stringify(dump, null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// Output 2: src/gxfx-params.ts
// ---------------------------------------------------------------------------

function genTs({ effects, totalParams }) {
    const counts = effects.map((e) => e.params.length).join(',');
    const offsets = effects.map((e) => e.offset).join(',');
    const L = [];
    const push = (...lines) => L.push(...lines);

    push(
        '/**',
        ' * Guitarix FX param tables (OctOBX per-instance insert chains).',
        ' *',
        ' * AUTO-GENERATED by tools/gen-gxfx-params.mjs — DO NOT EDIT THIS FILE BY',
        ' * HAND. Param data source: tools/gxfx-param-spec.json (verified against the',
        " * guitarix ttl files); categories + emission live in the generator.",
        ' * Cross-checked against the C engine by test/gxfx-params.test.ts +',
        ' * verify-obxd-wasm.mjs.',
        ' *',
        ' * Regenerate with:    node tools/gen-gxfx-params.mjs',
        ' * Freshness check:    node tools/gen-gxfx-params.mjs --check   (CI gate)',
        ' */',
        '',
        `export const FX_COUNT = ${FX_COUNT};`,
        `export const FX_SLOTS = ${FX_SLOTS};`,
        `export const FX_INSTANCE_COUNT = ${FX_INSTANCE_COUNT};`,
        '',
        'export interface FxParamDef {',
        '    port: number;      // PortIndex value passed to fx_set_param\'s `param`',
        '    symbol: string;',
        '    name: string;',
        '    default: number;   // ENGINE units (ttl range, not 0..1)',
        '    min: number;',
        '    max: number;',
        '    step: number;',
        '    integer?: boolean;',
        '}',
        '',
        '/** Menu category (full fx v2 vocabulary — the current 11 effects use 6). */',
        'export type FxCategory =',
        '    | "wah" | "drive" | "eq" | "filter" | "dynamics" | "modulation"',
        '    | "delay" | "reverb" | "amp" | "tonestack" | "multiband" | "special";',
        '',
        'export interface FxEffectDef {',
        '    id: number;',
        "    key: string;       // 'wah' | 'overdrive' | ... (canonical order = chain default order)",
        '    label: string;',
        '    category: FxCategory;',
        '    stereo: boolean;',
        `    offset: number;    // cumulative param offset into the flat ${totalParams}-slot mirror`,
        '    params: FxParamDef[];',
        '}',
        '',
        '/** Canonical chain order: wah → overdrive → distortion → compressor →',
        ' * chorus → flanger → phaser → tremolo → delay → echo → reverb.',
        ` * Param counts ${counts} → offsets ${offsets}. */`,
        'export const FX_EFFECTS: FxEffectDef[] = [',
    );
    for (const fx of effects) {
        push('    {');
        push(`        id: ${fx.id}, key: ${q(fx.key)}, label: ${q(fx.label)}, category: ${q(fx.category)}, stereo: ${fx.stereo}, offset: ${fx.offset},`);
        push('        params: [');
        for (const p of fx.params) {
            const integerSuffix = p.integer ? ', integer: true' : '';
            push(`            { port: ${p.port}, symbol: ${q(p.symbol)}, name: ${q(p.name)}, default: ${tS(p.default)}, min: ${tS(p.min)}, max: ${tS(p.max)}, step: ${tS(p.step)}${integerSuffix} },`);
        }
        push('        ],');
        push('    },');
    }
    push(
        '];',
        '',
        `export const FX_TOTAL_PARAMS = ${totalParams};`,
        '',
        '// --- 0..1 knob space <-> engine space (linear; log knobs would need per-param curves later) ---',
        '',
        'function fxLookupParam(fxId: number, param: number): FxParamDef | null {',
        '    const fx = FX_EFFECTS[fxId];',
        '    if (!fx || !Number.isInteger(param) || param < 0 || param >= fx.params.length) return null;',
        '    return fx.params[param];',
        '}',
        '',
        'function clamp01(v: number): number {',
        '    return v < 0 ? 0 : v > 1 ? 1 : v;',
        '}',
        '',
        '/** 0..1 knob position → engine value (clamped; integer params round). */',
        'export function fxParamFrom01(fxId: number, param: number, v01: number): number {',
        '    const def = fxLookupParam(fxId, param);',
        '    if (!def) return NaN;',
        '    const v = def.min + clamp01(v01) * (def.max - def.min);',
        '    const r = def.integer ? Math.round(v) : v;',
        '    return r < def.min ? def.min : r > def.max ? def.max : r;',
        '}',
        '',
        '/** Engine value → 0..1 knob position (clamped). */',
        'export function fxParamTo01(fxId: number, param: number, v: number): number {',
        '    const def = fxLookupParam(fxId, param);',
        '    if (!def) return NaN;',
        '    const span = def.max - def.min;',
        '    if (span === 0) return 0;',
        '    return clamp01((v - def.min) / span);',
        '}',
        '',
        '/** Default value expressed in 0..1 knob space. */',
        'export function fxParamDefault01(fxId: number, param: number): number {',
        '    const def = fxLookupParam(fxId, param);',
        '    if (!def) return NaN;',
        '    return fxParamTo01(fxId, param, def.default);',
        '}',
        '',
        '// --- flat-mirror helpers (used by persistence + worklet bulk state) ---',
        '',
        '/** Index into the flat FX_TOTAL_PARAMS mirror: cumulative offset + param. */',
        'export function fxFlatIndex(fxId: number, param: number): number {',
        '    const fx = FX_EFFECTS[fxId];',
        '    if (!fx || !Number.isInteger(param) || param < 0 || param >= fx.params.length) return -1;',
        '    return fx.offset + param;',
        '}',
        '',
        'export function isFxId(v: number): boolean {',
        '    return Number.isInteger(v) && v >= 0 && v < FX_COUNT;',
        '}',
        '',
    );

    return L.join('\n');
}

// ---------------------------------------------------------------------------
// Output 3: wasm/obxd/gxfx_defaults.h
// ---------------------------------------------------------------------------

function genHeader({ effects }) {
    const L = [];
    const push = (...lines) => L.push(...lines);

    push(
        '/*',
        ' * wasm/obxd/gxfx_defaults.h — GENERATED guitarix FX default tables.',
        ' *',
        ' * AUTO-GENERATED by tools/gen-gxfx-params.mjs from tools/gxfx-param-spec.json',
        ' * — DO NOT EDIT BY HAND; regenerate with:',
        ' *     node tools/gen-gxfx-params.mjs          (write)',
        ' *     node tools/gen-gxfx-params.mjs --check  (freshness gate)',
        ' *',
        ' * FX_DEFAULTS[effect][p] — per-effect param defaults in ENGINE units',
        ' * (ttl ranges, NOT 0..1). Rows in effect-id order 0..10 (wah..reverb),',
        ` * param order = port order, padded to ${FX_SLOT_PARAMS} entries per row with 0.0f.`,
        ' * FX_PARAM_COUNTS[effect] — live params per effect; the rest of each row',
        ' * is padding.',
        ' *',
        ' * Phase 0 (fx2plan.md): emitted but not yet consumed — gxfx_host.cpp',
        ' * still carries its own tables; the slot-model rework switches it over.',
        ' */',
        '#ifndef GXFX_DEFAULTS_H',
        '#define GXFX_DEFAULTS_H',
        '',
        `static const float FX_DEFAULTS[${FX_COUNT}][${FX_SLOT_PARAMS}] = {`,
    );
    effects.forEach((fx) => {
        const row = [];
        for (let p = 0; p < FX_SLOT_PARAMS; p++) {
            row.push(p < fx.params.length ? fC(fx.params[p].default) : fC(0));
        }
        push(`    /* ${String(fx.id).padStart(2)}: ${fx.key} — ${fx.params.length} params + ${FX_SLOT_PARAMS - fx.params.length} pad */`);
        push('    {');
        for (let i = 0; i < row.length; i += 8) {
            push('        ' + row.slice(i, i + 8).map((v) => v.padStart(8)).join(',') + ',');
        }
        push('    },');
    });
    push(
        '};',
        '',
        `static const int FX_PARAM_COUNTS[${FX_COUNT}] = { ${effects.map((fx) => fx.params.length).join(', ')} };`,
        '',
        '#endif /* GXFX_DEFAULTS_H */',
        '',
    );

    return L.join('\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
    const { raw, problems } = loadSpec();
    if (problems.length > 0) {
        console.error(`${SPEC_JSON} failed validation — refusing to generate:`);
        for (const p of problems) console.error(`  - ${p}`);
        process.exit(2);
    }
    const spec = normalize(raw);

    const outputs = [
        { rel: OUT_JSON, content: genJson(spec) },
        { rel: OUT_TS, content: genTs(spec) },
        { rel: OUT_H, content: genHeader(spec) },
    ];

    if (process.argv.includes('--check')) {
        const stale = [];
        for (const { rel, content } of outputs) {
            let committed = null;
            try {
                committed = readFileSync(join(ROOT, rel), 'utf8');
            } catch {
                stale.push(rel);
                continue;
            }
            if (committed !== content) stale.push(rel);
        }
        if (stale.length > 0) {
            console.error('STALE generated outputs (regenerate with `node tools/gen-gxfx-params.mjs`):');
            for (const rel of stale) console.error(`  ${rel}`);
            process.exit(1);
        }
        console.log(`OK — all ${outputs.length} generated outputs are fresh`);
        return;
    }

    for (const { rel, content } of outputs) {
        const abs = join(ROOT, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
        console.log(`wrote ${rel}`);
    }
    console.log(
        `gxfx param tables: ${spec.effects.length} effects, ${spec.totalParams} params, ` +
        `slot array ${FX_SLOT_PARAMS}`,
    );
}

main();

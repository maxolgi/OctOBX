#!/usr/bin/env node
// ===========================================================================
// gen-param-table.mjs — generates every consumable artifact of the OB-Xd →
// OB-Xf parameter mapping spec.
//
// SOURCE OF TRUTH: tools/param-spec.mjs (see tools/PARAM_SPEC.md). This
// generator consumes exactly that spec and emits three committed outputs:
//
//   1. wasm/obxd/param_table.h        C dispatch tables for main_obxd.cpp
//                                      (legacy transformed path + native 1:1
//                                      path + name index for binary search)
//   2. src/obxf-param-mappings.ts     TypeScript mirror: paramMappings (80
//                                      rows), canonicalNewParamOrder (28),
//                                      constants, and PURE per-name transform
//                                      functions (paramTransforms) so tests
//                                      can golden the math without touching C
//   3. src/generated/param-table.json machine-readable sidecar dump of the
//                                      spec as emitted (rows, canonical order,
//                                      drum sets, sorted name index)
//
// Usage:
//   node tools/gen-param-table.mjs           # write all three outputs
//   node tools/gen-param-table.mjs --check   # byte-compare against the
//                                            # committed files; exit 0 fresh,
//                                            # exit 1 listing stale paths
//
// Deterministic by construction: stable ordering, no timestamps — --check is
// byte-stable across runs on the same spec. Node >= 23, no dependencies.
// ===========================================================================

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    paramSpec,
    validateSpec,
    PARAM_COUNT,
    NEW_PARAM_BASE,
    NEW_PARAM_COUNT,
    BENDRANGE_LEGACY_INDEX,
    DRUM_GLOBAL_C_SET,
    DRUM_SMOOTHER_SET,
    DRUM_RESTORE_SKIP_SET,
    DRUM_NONE_SET,
} from './param-spec.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const OUT_H = 'wasm/obxd/param_table.h';
const OUT_TS = 'src/obxf-param-mappings.ts';
const OUT_JSON = 'src/generated/param-table.json';

// ---------------------------------------------------------------------------
// Spec views
// ---------------------------------------------------------------------------

const legacy = paramSpec.filter((e) => typeof e.legacyIndex === 'number');   // 80 rows
const legacyByIndex = new Map(legacy.map((e) => [e.legacyIndex, e]));
const fresh = paramSpec.filter((e) => typeof e.newOrdinal === 'number');     // 28 rows
const freshByOrdinal = [...fresh].sort((a, b) => a.newOrdinal - b.newOrdinal);

if (legacy.length !== PARAM_COUNT) throw new Error(`spec has ${legacy.length} legacy rows, expected ${PARAM_COUNT}`);
if (freshByOrdinal.length !== NEW_PARAM_COUNT) throw new Error(`spec has ${freshByOrdinal.length} NEW rows, expected ${NEW_PARAM_COUNT}`);

// Streaming-name index: one entry per name — every non-empty legacy newId
// (BENDRANGE contributes TWO: PitchBendUp + PitchBendDown) plus all 28 NEW
// names. Sorted lexicographically (bytewise == UTF-16 order for these ASCII
// names) so the C consumer can binary-search it.
const nameIndex = [];
for (const e of legacy) {
    if (e.newId !== '') {
        nameIndex.push({
            name: e.newId,
            legacyIndex: e.legacyIndex,
            newOrdinal: -1,
            invert: e.invert,
            method: e.method,
            panVoice: e.transform?.kind === 'PAN' ? e.transform.voiceIndex : null,
        });
    }
    const sec = e.transform?.secondaryNewId;
    if (sec) {
        nameIndex.push({
            name: sec,
            legacyIndex: e.legacyIndex,
            newOrdinal: -1,
            invert: e.invert,
            method: e.transform.secondaryMethod,
            panVoice: null,
        });
    }
}
for (const e of freshByOrdinal) {
    nameIndex.push({ name: e.newId, legacyIndex: -1, newOrdinal: e.newOrdinal, invert: null, method: e.method, panVoice: null });
}
nameIndex.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

// Legacy-mapped streaming names: rows with a primary name + the BENDRANGE split half.
const legacyMappedNameCount = legacy.filter((e) => e.newId !== '').length + 1;

const canonicalNewParamOrder = freshByOrdinal.map((e) => e.newId);

// ---------------------------------------------------------------------------
// Deterministic number formatting (JS doubles → minimal round-trip decimals)
// ---------------------------------------------------------------------------

function fmtNum(x) {
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`non-finite constant: ${x}`);
    const s = String(x);
    if (s.includes('e') || s.includes('E')) throw new Error(`constant ${x} formats exponentially; extend the formatter`);
    return s;
}
// C float literal (always carries a decimal point or exponent)
const fC = (x) => (Number.isInteger(x) ? `${x}.0f` : `${fmtNum(x)}f`);
// C int literal (for counts / semitones / voice indices)
const iC = (x) => String(x);
// TS literal (JS double, exact)
const tS = (x) => fmtNum(x);

function cStr(s) {
    return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
const tsStr = (s) => JSON.stringify(String(s));

const lowerName = (e) => e.legacyName.toLowerCase();

// ---------------------------------------------------------------------------
// C math expression emitters (mirror tools/param-spec.mjs verbatim)
// ---------------------------------------------------------------------------

// xd-set argument list: (lo, hi, rolloff)
const cXdArgs = (set) => `${fC(set.lo)}, ${fC(set.hi)}, ${fC(set.rolloff)}`;

function cUnmapXf(xExpr, xf) {
    if (xf.curve === 'log') return `obxf_pt_xd_inv_logsc(${xExpr}, ${cXdArgs(xf)})`;
    if (xf.curve === 'lin') return `obxf_pt_xd_inv_linsc(${xExpr}, ${fC(xf.lo)}, ${fC(xf.hi)})`;
    return xExpr; // 'identity' — the logsc is baked into the native value
}

function cForwardFn(e) {
    const fn = `obxf_apply_${lowerName(e)}`;
    const t = e.transform;
    let body;
    switch (t.kind) {
        case 'IDENTITY':
            body = `    s.${e.method}(v);`;
            break;
        case 'MUL':
            body = `    s.${e.method}(v * ${fC(t.factor)});`;
            break;
        case 'SPLIT_BENDRANGE':
            body = [
                `    const int range = (v > ${fC(t.threshold)}) ? ${iC(t.semitonesHigh)} : ${iC(t.semitonesLow)};`,
                `    const float n = (float)range / (float)MAX_BEND_RANGE;`,
                `    s.${e.method}(n);${e.newId ? ` /* primary: ${e.newId} */` : ''}`,
                `    s.${t.secondaryMethod}(n); /* secondary: ${t.secondaryNewId} (same value) */`,
            ].join('\n');
            break;
        case 'VOICE_COUNT':
            body = [
                `    const int xdVoices = obxf_pt_clampi((int)std::round(v * ${fC(7)}) + ${iC(1)}, 1, 8);`,
                `    s.${e.method}(((float)(xdVoices - 1) + ${fC(0.5)}) / (float)MAX_VOICES);`,
            ].join('\n');
            break;
        case 'OCTAVE_TRANSPOSE':
            body = [
                `    const int transpose = obxf_pt_clampi((int)std::round(v * ${fC(4)}) + ${iC(1)}, 0, 4);`,
                `    s.${e.method}((float)transpose * ${fC(0.25)});`,
            ].join('\n');
            break;
        case 'LOGSC_INVLOGSC': {
            let x = `obxf_pt_xd_logsc(v, ${cXdArgs(t.xd)})`;
            const lines = [`    float xdv = ${x};`];
            if (t.preDivisor !== undefined) lines.push(`    xdv /= ${fC(t.preDivisor)}; /* attack-time compensation */`);
            lines.push(`    s.${e.method}(${cUnmapXf('xdv', t.xf)});`);
            body = lines.join('\n');
            break;
        }
        case 'BOOL_BLEND':
            body = `    s.${e.method}(obxf_pt_lfo_bool_to_blend(v));`;
            break;
        case 'BOOL_TRISTATE':
            body = `    s.${e.method}(obxf_pt_lfo_bool_to_tristate(v));`;
            break;
        case 'NOTEPRIORITY':
            body = `    s.${e.method}(v > ${fC(0.5)} ? ${fC(0)} : ${fC(0.5)}); /* STRICT >, unlike BOOL_* */`;
            break;
        case 'PAN':
            body = `    s.${e.method}(v, ${iC(t.voiceIndex)});`;
            break;
        default:
            throw new Error(`kind ${t.kind} must not reach cForwardFn (specialInline/removed stay inline in C)`);
    }
    return `static inline void ${fn}(SynthEngine& s, float v) {\n${body}\n}`;
}

// Invert function pointer for a legacy row (shared helpers where the math is
// constant-free, per-row functions where the row carries its own constants).
function cInvertFn(e) {
    const inv = e.invert;
    if (!inv) return 'NULL';
    switch (inv.kind) {
        case 'IDENTITY':
        case 'PAN':
            return 'obxf_pt_invert_identity';
        case 'SPLIT_BENDRANGE': return 'obxf_pt_invert_split_bendrange';
        case 'VOICE_COUNT': return 'obxf_pt_invert_voice_count';
        case 'OCTAVE_TRANSPOSE': return 'obxf_pt_invert_octave_transpose';
        case 'BOOL_BLEND': return 'obxf_pt_invert_bool_blend';
        case 'BOOL_TRISTATE': return 'obxf_pt_invert_bool_tristate';
        case 'NOTEPRIORITY': return 'obxf_pt_invert_notepriority';
        case 'MUL':
        case 'LOGSC_INVLOGSC':
            return `obxf_invert_${lowerName(e)}`;
        default:
            throw new Error(`unknown invert kind ${inv.kind}`);
    }
}

// Per-row invert function body (only MUL / LOGSC_INVLOGSC need row constants).
function cInvertFnDef(e) {
    const inv = e.invert;
    const fn = `obxf_invert_${lowerName(e)}`;
    if (inv.kind === 'MUL') {
        return `static inline float ${fn}(float v) {\n    return v * ${fC(inv.factor)};\n}`;
    }
    if (inv.kind === 'LOGSC_INVLOGSC') {
        const t = inv;
        let map;
        if (t.xf.curve === 'log') map = `obxf_pt_xd_logsc(v, ${cXdArgs(t.xf)})`;
        else if (t.xf.curve === 'lin') map = `obxf_pt_xd_linsc(v, ${fC(t.xf.lo)}, ${fC(t.xf.hi)})`;
        else map = 'v'; // 'identity' — native value already IS the baked xd value
        const lines = [`    float xdv = ${map};`];
        if (t.preDivisor !== undefined) lines.push(`    xdv *= ${fC(t.preDivisor)};`);
        lines.push(`    return obxf_pt_xd_inv_logsc(xdv, ${cXdArgs(t.xd)});`);
        return `static inline float ${fn}(float v) {\n${lines.join('\n')}\n}`;
    }
    throw new Error(`cInvertFnDef called for shared kind ${inv.kind}`);
}

const cNativeFn = (entry) => `obxf_native_${entry.name}`;
function cNativeFnDef(entry) {
    const call = entry.panVoice !== null ? `s.${entry.method}(v, ${iC(entry.panVoice)});` : `s.${entry.method}(v);`;
    return `static inline void ${cNativeFn(entry)}(SynthEngine& s, float v) {\n    ${call}\n}`;
}

// ---------------------------------------------------------------------------
// TS math expression emitters (same math, JS doubles — golden-testable)
// ---------------------------------------------------------------------------

const tsXdArgs = (set) => `${tS(set.lo)}, ${tS(set.hi)}, ${tS(set.rolloff)}`;

function tsUnmapXf(xExpr, xf) {
    if (xf.curve === 'log') return `xdInvLogsc(${xExpr}, ${tsXdArgs(xf)})`;
    if (xf.curve === 'lin') return `xdInvLinsc(${xExpr}, ${tS(xf.lo)}, ${tS(xf.hi)})`;
    return xExpr; // 'identity'
}

function tsForwardExpr(e) {
    const t = e.transform;
    switch (t.kind) {
        case 'IDENTITY':
        case 'PAN':
            return 'v';
        case 'MUL':
            return `v * ${tS(t.factor)}`;
        case 'SPLIT_BENDRANGE':
            return `(v > ${tS(t.threshold)} ? ${tS(t.semitonesHigh)} : ${tS(t.semitonesLow)}) / ${tS(t.maxBendRange)}`;
        case 'VOICE_COUNT':
            return `((clamp(Math.round(v * 7) + 1, 1, 8) - 1) + 0.5) / ${tS(32)}`;
        case 'OCTAVE_TRANSPOSE':
            return `clamp(Math.round(v * 4) + 1, 0, 4) * ${tS(0.25)}`;
        case 'LOGSC_INVLOGSC': {
            let x = `xdLogsc(v, ${tsXdArgs(t.xd)})`;
            if (t.preDivisor !== undefined) x = `(${x} / ${tS(t.preDivisor)})`;
            return tsUnmapXf(x, t.xf);
        }
        case 'BOOL_BLEND':
            return `v >= 0.5 ? 0 : 0.5`;
        case 'BOOL_TRISTATE':
            return `v >= 0.5 ? 0.5 : 0`;
        case 'NOTEPRIORITY':
            return `v > 0.5 ? 0 : 0.5`;
        case 'LFO1_RATE':
            // specialInline: the pure function models the FREE-RUNNING path only
            // (the synced path reads the live LFO_SYNC mirror — C-side only).
            return tsUnmapXf(`xdLogsc(v, ${tsXdArgs(t.free.xd)})`, t.free.xf);
        case 'LFO1_SYNC':
            // specialInline: value itself is 1:1; the re-dispatch of LFOFREQ is
            // a side effect C keeps inline.
            return 'v';
        default:
            throw new Error(`unknown forward kind ${t.kind}`);
    }
}

function tsInvertExpr(e) {
    const inv = e.invert;
    switch (inv.kind) {
        case 'IDENTITY':
        case 'PAN':
            return 'v';
        case 'MUL':
            return `v * ${tS(inv.factor)}`;
        case 'SPLIT_BENDRANGE':
            return `Math.round(v * ${tS(inv.maxBendRange)}) > 7 ? 1 : 0`;
        case 'VOICE_COUNT':
            return `(clamp(Math.round(v * 32), 1, 8) - 1) / 7`;
        case 'OCTAVE_TRANSPOSE':
            return `clamp((Math.round(v * 4) - 1) / 4, 0, 1)`;
        case 'LOGSC_INVLOGSC': {
            let map;
            if (inv.xf.curve === 'log') map = `xdLogsc(v, ${tsXdArgs(inv.xf)})`;
            else if (inv.xf.curve === 'lin') map = `xdLinsc(v, ${tS(inv.xf.lo)}, ${tS(inv.xf.hi)})`;
            else map = 'v';
            if (inv.preDivisor !== undefined) map = `(${map} * ${tS(inv.preDivisor)})`;
            return `xdInvLogsc(${map}, ${tsXdArgs(inv.xd)})`;
        }
        case 'BOOL_BLEND':
            return `v < 0.25 ? 1 : 0`;
        case 'BOOL_TRISTATE':
            return `v >= 0.25 ? 1 : 0`;
        case 'NOTEPRIORITY':
            return `v > 0.25 ? 0 : 1`;
        default:
            throw new Error(`unknown invert kind ${inv.kind}`);
    }
}

// ---------------------------------------------------------------------------
// Output 1: wasm/obxd/param_table.h
// ---------------------------------------------------------------------------

function genHeader() {
    const L = [];
    const push = (...lines) => L.push(...lines);

    push(
        '/*',
        ' * wasm/obxd/param_table.h — GENERATED parameter dispatch tables for the',
        ' * OB-Xd (legacy) → OB-Xf parameter migration.',
        ' *',
        ' * AUTO-GENERATED by tools/gen-param-table.mjs from tools/param-spec.mjs',
        ' * (the single source of truth — see tools/PARAM_SPEC.md). DO NOT EDIT',
        ' * BY HAND; regenerate with:',
        ' *     node tools/gen-param-table.mjs          (write)',
        ' *     node tools/gen-param-table.mjs --check  (freshness gate)',
        ' *',
        ' * =========================================================================',
        ' * INCLUDE CONTRACT',
        ' * =========================================================================',
        ' * This header includes NOTHING itself. It MUST be #include\'d AFTER the',
        ' * OB-Xf engine headers (engine/SynthEngine.h) — it references:',
        ' *   - SynthEngine as a COMPLETE type (function pointers take SynthEngine&),',
        ' *   - the constants MAX_VOICES and MAX_BEND_RANGE (32 / 48, already in',
        ' *     scope from obxf_imported/configuration.h via the engine headers),',
        ' *   - <cmath> for std::round / std::exp / std::log (already in scope in',
        ' *     main_obxd.cpp; JUCE headers pull it in transitively).',
        ' *',
        ' * =========================================================================',
        ' * TWO DISPATCH SPACES — one table pair per space',
        ' * =========================================================================',
        ' * (a) LEGACY path (knob UI, integer .fxp schema): legacy-space 0..1 values',
        ' *     that MUST be transformed before the engine call. Use',
        ' *     obxf_legacy_params[idx].apply_legacy (NULL for removed rows and the',
        ' *     two special_inline rows — see below).',
        ' * (b) NATIVE path (OB-Xf named-attribute .fxp schema, `Volume="0.5"`):',
        ' *     native engine-space 0..1 values applied 1:1 with NO transform. Use',
        ' *     obxf_param_name_find(name, nlen)->native_apply, or',
        ' *     obxf_new_params[ordinal].apply_native for the 28 OB-Xf-only params.',
        ' *',
        ' * INVERT: obxf_legacy_params[idx].invert maps a native 0..1 value back to',
        ' * the legacy 0..1 space — use it to write g_param_mirror when a native',
        ' * .fxp names a legacy-mapped param (fixes the knob-jump bug). NULL for',
        ' * removed rows, the two special_inline rows, and every NEW param.',
        ' *',
        ' * SPECIAL INLINE: LFOFREQ (legacy 17, "LFO1Rate") and LFO_SYNC (legacy 72,',
        ' * "LFO1TempoSync") are special_inline=1 with apply_legacy == NULL. Their',
        ' * legacy handling reads/writes per-instance mirror state and stays inline',
        ' * in main_obxd.cpp — check `special_inline` before falling through to any',
        ' * generic table call. Their NATIVE path (native_apply) is still a plain',
        ' * 1:1 call and is safe to dispatch from the name index.',
        ' *',
        ' * BENDRANGE (legacy 6) is ONE row whose apply_legacy writes BOTH',
        ' * processBendUpRange and processBendDownRange with the same transformed',
        ' * value (secondary_name = "PitchBendDown"). The name index carries both',
        ' * halves as separate entries.',
        ' *',
        ' * Drum classification (PCM instance 9): drum_class routes legacy params',
        ' * (none > smoother > global > voice precedence) and drum_restore_skip is',
        ' * the INDEPENDENT worklet DRUM_STRUCTURAL_SKIP flag — neither derives',
        ' * from the other (see tools/PARAM_SPEC.md).',
        ' * =========================================================================',
        ' */',
        '',
        '#ifndef OBXF_PARAM_TABLE_H',
        '#define OBXF_PARAM_TABLE_H',
        '',
        `#define OBXF_PT_LEGACY_COUNT ${PARAM_COUNT}    /* legacy indices 0..${PARAM_COUNT - 1} (ParamsEnum.h order) */`,
        `#define OBXF_PT_NEW_COUNT ${NEW_PARAM_COUNT}       /* OB-Xf-only params, canonical ordinals 0..${NEW_PARAM_COUNT - 1} */`,
        `#define OBXF_PT_NAME_INDEX_COUNT ${nameIndex.length}  /* one entry per streaming name, sorted for bsearch */`,
        `#define OBXF_PT_NEW_PARAM_BASE ${NEW_PARAM_BASE}    /* UI sentinel: idx = ${NEW_PARAM_BASE} + canonical ordinal */`,
        '',
    );

    // -- types --------------------------------------------------------------
    push(
        '// --- Drum classification (PCM instance 9) --------------------------------',
        'typedef enum {',
        '    DRUM_NONE = 0,      /* removed / no-op row — nothing to route */',
        '    DRUM_GLOBAL = 1,   /* routes live to instance 9; never per voice */',
        '    DRUM_SMOOTHER = 2, /* applied directly onto the triggered voice */',
        '    DRUM_VOICE = 3,    /* applied per triggered voice via apply_legacy */',
        '} obxf_drum_class_t;',
        '',
        'typedef void (*obxf_apply_fn)(SynthEngine&, float); /* engine-space apply */',
        'typedef float (*obxf_invert_fn)(float);             /* native→legacy 0..1 */',
        '',
        '// --- Legacy row (one per ParamsEnum.h index 0..79) ----------------------',
        'typedef struct obxf_legacy_param_t {',
        '    int legacy_index;          /* 0..79 == index into obxf_legacy_params */',
        '    const char* legacy_name;   /* ParamsEnum.h identifier (docs) */',
        '    const char* legacy_method; /* OLD OB-Xd method name (docs) */',
        '    const char* name;          /* primary OB-Xf streaming name; "" = removed/no-op */',
        '    const char* secondary_name;/* split-half streaming name (BENDRANGE only); "" */',
        '    obxf_apply_fn apply_legacy;/* forward (legacy→engine) call; NULL for removed',
        '                                  rows AND the two special_inline rows */',
        '    obxf_invert_fn invert;     /* native→legacy (mirror write); NULL where the',
        '                                  spec says null (removed + special_inline) */',
        '    int special_inline;       /* 1 for LFOFREQ(17)/LFO_SYNC(72): C handles them',
        '                                  inline; do NOT call any fn ptr — detect this */',
        '    obxf_drum_class_t drum_class;',
        '    int drum_restore_skip;    /* worklet DRUM_STRUCTURAL_SKIP (orthogonal) */',
        '    const char* notes;',
        '} obxf_legacy_param_t;',
        '',
        '// --- NEW param row (one per canonical ordinal 0..27) --------------------',
        'typedef struct obxf_new_param_t {',
        '    const char* name;           /* OB-Xf streaming name (unique, no legacy row) */',
        '    obxf_apply_fn apply_native; /* DIRECT 1:1 processX call (native space) */',
        '    obxf_drum_class_t drum_class; /* DRUM_GLOBAL (verified synth-globals) or DRUM_VOICE (spec) */',
        '    const char* notes;',
        '} obxf_new_param_t;',
        '',
        '// --- Name-index entry (streaming-name → both dispatch spaces) ----------',
        'typedef struct obxf_param_name_entry_t {',
        '    const char* name;           /* OB-Xf streaming name (sorted, unique) */',
        '    obxf_apply_fn native_apply; /* DIRECT 1:1 engine call for this name */',
        '    int legacy_index;           /* -1 for NEW params */',
        '    int new_ordinal;            /* canonical ordinal; -1 for legacy-mapped names */',
        '    obxf_invert_fn invert;      /* legacy row\'s invert; NULL for NEW names and',
        '                                   for legacy rows whose spec invert is null */',
        '} obxf_param_name_entry_t;',
        '',
    );

    // -- math + shared kind helpers -----------------------------------------
    push(
        '// =========================================================================',
        '// Math helpers — verbatim from ObxdImporter.cpp / main_obxd.cpp. Local',
        '// clamps keep this header free of any juce:: dependency.',
        '// =========================================================================',
        'static inline float obxf_pt_clampf(float v, float lo, float hi) {',
        '    return v < lo ? lo : (v > hi ? hi : v);',
        '}',
        'static inline int obxf_pt_clampi(int v, int lo, int hi) {',
        '    return v < lo ? lo : (v > hi ? hi : v);',
        '}',
        '',
        '// OB-Xd logsc: ((exp(p*ln(rolloff+1)) - 1) / rolloff) * (hi - lo) + lo',
        'static inline float obxf_pt_xd_logsc(float p, float lo, float hi, float rolloff) {',
        '    return ((std::exp(p * std::log(rolloff + 1.0f)) - 1.0f) / rolloff) * (hi - lo) + lo;',
        '}',
        '// OB-Xd linsc (needed by the invert direction of curve \'lin\' rows)',
        'static inline float obxf_pt_xd_linsc(float p, float lo, float hi) {',
        '    return lo + p * (hi - lo);',
        '}',
        'static inline float obxf_pt_xd_inv_linsc(float y, float lo, float hi) {',
        '    if (hi == lo) return 0.0f;',
        '    return obxf_pt_clampf((y - lo) / (hi - lo), 0.0f, 1.0f);',
        '}',
        'static inline float obxf_pt_xd_inv_logsc(float y, float lo, float hi, float rolloff) {',
        '    if (hi == lo) return 0.0f;',
        '    const float t = rolloff * (y - lo) / (hi - lo) + 1.0f;',
        '    if (t <= 0.0f) return 0.0f;',
        '    return obxf_pt_clampf(std::log(t) / std::log(rolloff + 1.0f), 0.0f, 1.0f);',
        '}',
        '',
        '// OB-Xd LFO wave bool → continuous blend; importer emits only 0 or 0.5.',
        'static inline float obxf_pt_lfo_bool_to_blend(float v) { return v >= 0.5f ? 0.0f : 0.5f; }',
        '// OB-Xd LFO destination bool → tri-state {Off, On, Inv} = 0 / 0.5 / 1.',
        'static inline float obxf_pt_lfo_bool_to_tristate(float v) { return v >= 0.5f ? 0.5f : 0.0f; }',
        '',
        '// =========================================================================',
        '// Shared INVERT helpers (canonical representative inverses — the choice is',
        '// documented in tools/PARAM_SPEC.md §Invert semantics). Kinds whose math',
        '// carries per-row constants (MUL factor, LOGSC_INVLOGSC sets) get one',
        '// generated function per row below instead.',
        '// =========================================================================',
        'static inline float obxf_pt_invert_identity(float v) { return v; }',
        `// SPLIT_BENDRANGE: range = round(n*MAX_BEND_RANGE); any range >= 8 st is the wide knob`,
        'static inline float obxf_pt_invert_split_bendrange(float v) {',
        '    const int range = (int)std::round(v * (float)MAX_BEND_RANGE);',
        '    return range > 7 ? 1.0f : 0.0f;',
        '}',
        '// VOICE_COUNT: representative bucket midpoint',
        'static inline float obxf_pt_invert_voice_count(float v) {',
        '    const int voices = obxf_pt_clampi((int)std::round(v * (float)MAX_VOICES), 1, 8);',
        '    return (float)(voices - 1) / 7.0f;',
        '}',
        'static inline float obxf_pt_invert_octave_transpose(float v) {',
        '    const int transpose = (int)std::round(v * 4.0f);',
        '    return obxf_pt_clampf((float)(transpose - 1) / 4.0f, 0.0f, 1.0f);',
        '}',
        '// BOOL_BLEND: native 0 → legacy 1, native 0.5 → legacy 0 (0.25 midpoint)',
        'static inline float obxf_pt_invert_bool_blend(float v) { return v < 0.25f ? 1.0f : 0.0f; }',
        '// BOOL_TRISTATE: the Inv state (n=1) shows as "on" in the legacy UI',
        'static inline float obxf_pt_invert_bool_tristate(float v) { return v >= 0.25f ? 1.0f : 0.0f; }',
        '// NOTEPRIORITY: native 0 = Last → 1, native 0.5 = Low → 0; High shows as Low',
        'static inline float obxf_pt_invert_notepriority(float v) { return v > 0.25f ? 0.0f : 1.0f; }',
        '',
    );

    // -- per-row forward functions -------------------------------------------
    push(
        '// =========================================================================',
        '// Forward apply functions — LEGACY space (applyLegacy). One per non-removed,',
        '// non-specialInline legacy row, in legacy-index order.',
        '// =========================================================================',
    );
    for (const e of legacy) {
        if (e.newId === '' || e.specialInline) continue;
        push(cForwardFn(e), '');
    }

    // -- per-row invert functions --------------------------------------------
    const perRowInverts = legacy.filter((e) => e.invert && (e.invert.kind === 'MUL' || e.invert.kind === 'LOGSC_INVLOGSC'));
    push(
        '// =========================================================================',
        '// Per-row INVERT functions (native→legacy) for kinds whose constants differ',
        '// per row: MUL (reciprocal factor) and LOGSC_INVLOGSC (map through xf, then',
        '// xdInvLogsc onto the xd set). Exact inverses — round-trips cleanly.',
        '// =========================================================================',
    );
    for (const e of perRowInverts) {
        push(cInvertFnDef(e), '');
    }

    // -- native apply functions ----------------------------------------------
    push(
        '// =========================================================================',
        '// Native apply functions — NATIVE space (1:1, NO transform). One per',
        '// streaming name (the name-index targets), sorted by name.',
        '// BENDRANGE halves call separate range methods; PAN names pass voiceIndex.',
        '// =========================================================================',
    );
    for (const entry of nameIndex) {
        push(cNativeFnDef(entry), '');
    }

    // -- legacy table ---------------------------------------------------------
    push(
        '// =========================================================================',
        `// Legacy table — exactly ${PARAM_COUNT} rows, indexed by legacy index.`,
        '// =========================================================================',
        `static const obxf_legacy_param_t obxf_legacy_params[OBXF_PT_LEGACY_COUNT] = {`,
    );
    legacy.forEach((e) => {
        const idx = String(e.legacyIndex).padStart(2, ' ');
        const fields = [
            `${e.legacyIndex}`,
            cStr(e.legacyName),
            cStr(e.legacyMethod),
            cStr(e.newId),
            cStr(e.transform?.secondaryNewId ?? ''),
            e.newId === '' || e.specialInline ? 'NULL' : `obxf_apply_${lowerName(e)}`,
            cInvertFn(e),
            e.specialInline ? '1' : '0',
            `DRUM_${e.drumClass.toUpperCase()}`,
            e.drumRestoreSkip ? '1' : '0',
            cStr(e.notes),
        ];
        push(`    /* ${idx} */ { ${fields.join(', ')} },`);
    });
    push('};', '');
    push(
        'static_assert(sizeof(obxf_legacy_params) / sizeof(obxf_legacy_params[0]) == OBXF_PT_LEGACY_COUNT,',
        '               "legacy table must have exactly OBXF_PT_LEGACY_COUNT rows");',
        '',
    );

    // -- new param table ------------------------------------------------------
    push(
        '// =========================================================================',
        `// NEW-param table — exactly ${NEW_PARAM_COUNT} rows, indexed by canonical ordinal`,
        '// (declaration order of streaming IDs in obxf_imported/parameter/SynthParam.h,',
        '// filtered to the params with no legacy ancestor). NOTE: this intentionally',
        '// differs from the legacy runtime sentinel order frozen in',
        '// tools/new-param-order-v1.json (see tools/PARAM_SPEC.md).',
        '// =========================================================================',
        'static const obxf_new_param_t obxf_new_params[OBXF_PT_NEW_COUNT] = {',
    );
    for (const e of freshByOrdinal) {
        const ord = String(e.newOrdinal).padStart(2, ' ');
        push(`    /* ${ord} */ { ${cStr(e.newId)}, ${cNativeFn({ name: e.newId })}, DRUM_${e.drumClass.toUpperCase()}, ${cStr(e.notes)} },`);
    }
    push('};', '');
    push(
        'static_assert(sizeof(obxf_new_params) / sizeof(obxf_new_params[0]) == OBXF_PT_NEW_COUNT,',
        '               "new-param table must have exactly OBXF_PT_NEW_COUNT rows");',
        '',
    );

    // -- name index -----------------------------------------------------------
    push(
        '// =========================================================================',
        `// Name index — exactly ${nameIndex.length} entries, one PER STREAMING NAME`,
        '// (all legacy non-empty names INCLUDING both BENDRANGE halves, plus all',
        `// ${NEW_PARAM_COUNT} NEW names), sorted bytewise-lexicographically for binary search.`,
        '// Lookup: obxf_param_name_find(name, nlen).',
        '// =========================================================================',
        'static const obxf_param_name_entry_t obxf_param_name_index[OBXF_PT_NAME_INDEX_COUNT] = {',
    );
    for (const entry of nameIndex) {
        const row = entry.legacyIndex >= 0 ? legacyByIndex.get(entry.legacyIndex) : null;
        const invertC = row ? cInvertFn(row) : 'NULL';
        push(`    { ${cStr(entry.name)}, ${cNativeFn(entry)}, ${entry.legacyIndex}, ${entry.newOrdinal}, ${invertC} },`);
    }
    push('};', '');
    push(
        'static_assert(sizeof(obxf_param_name_index) / sizeof(obxf_param_name_index[0]) == OBXF_PT_NAME_INDEX_COUNT,',
        '               "name index must have exactly OBXF_PT_NAME_INDEX_COUNT entries");',
        '',
    );

    // -- lookup helpers -------------------------------------------------------
    push(
        '// =========================================================================',
        '// Lookup helpers',
        '// =========================================================================',
        '// Compare a (name, nlen) slice — NOT null-terminated — against a C string,',
        '// bytewise. Returns 0 on exact full match (same semantics as main_obxd.cpp',
        '// nameeq()), <0 when the slice sorts first, >0 when the entry sorts first.',
        '// This is the ordering the name index above is sorted by.',
        'static inline int obxf_param_name_cmp(const char* a, int alen, const char* b) {',
        '    for (int i = 0; i < alen; ++i) {',
        '        const unsigned char ca = (unsigned char)a[i];',
        '        const unsigned char cb = (unsigned char)b[i];',
        '        if (cb == 0) return 1; /* a is longer than b */',
        '        if (ca != cb) return (int)ca - (int)cb;',
        '    }',
        '    return b[alen] == 0 ? 0 : -1; /* a is a proper prefix of b */',
        '}',
        '',
        '// Binary search the sorted name index. Returns the matching entry, or NULL',
        '// for unknown names (metadata attributes like programName/author/etc.).',
        'static inline const obxf_param_name_entry_t* obxf_param_name_find(const char* name, int nlen) {',
        '    if (!name || nlen <= 0) return 0;',
        '    int lo = 0, hi = OBXF_PT_NAME_INDEX_COUNT - 1;',
        '    while (lo <= hi) {',
        '        const int mid = lo + ((hi - lo) >> 1);',
        '        const int c = obxf_param_name_cmp(name, nlen, obxf_param_name_index[mid].name);',
        '        if (c == 0) return &obxf_param_name_index[mid];',
        '        if (c < 0) hi = mid - 1;',
        '        else lo = mid + 1;',
        '    }',
        '    return 0;',
        '}',
        '',
        '#endif /* OBXF_PARAM_TABLE_H */',
        '',
    );

    return L.join('\n');
}

// ---------------------------------------------------------------------------
// Output 2: src/obxf-param-mappings.ts
// ---------------------------------------------------------------------------

// Section comment headers between legacy index ranges (same grouping as the
// pre-generation hand-maintained file, for familiarity).
const TS_SECTIONS = [
    [0, '// ---- index 0..11: master / global / velocity ----'],
    [12, '// ---- index 12..22: allocation / unison / LFO freq+wave ----'],
    [23, '// ---- index 23..27: LFO1 routing (bool → tri-state) ----'],
    [28, '// ---- index 28..39: oscillators ----'],
    [40, '// ---- index 40..50: mixer + filter ----'],
    [51, '// ---- index 51..58: envelopes (loudness=Amp, filter=Filter) ----'],
    [59, '// ---- index 59..69: slop + pan ----'],
    [70, '// ---- index 70..79: UI toggles + extended params ----'],
];

function genTs() {
    const L = [];
    const push = (...lines) => L.push(...lines);

    push(
        '/**',
        ' * obxf-param-mappings.ts — OB-Xd → OB-Xf parameter mapping spec (generated).',
        ' *',
        ' * AUTO-GENERATED by tools/gen-param-table.mjs — DO NOT EDIT THIS FILE BY',
        ' * HAND. Source of truth: tools/param-spec.mjs (see tools/PARAM_SPEC.md).',
        ' *',
        ' * Regenerate with:    node tools/gen-param-table.mjs',
        ' * Freshness check:    node tools/gen-param-table.mjs --check   (CI gate)',
        ' *',
        ' * WARNING — HAND EDITS ARE OVERWRITTEN:',
        ' *   Every exported value below is emitted verbatim from the spec. Change',
        ' *   the spec (tools/param-spec.mjs), not this file. The machine-readable',
        ' *   dump of the same data lives in src/generated/param-table.json.',
        ' *',
        ' * SHAPE NOTES vs the pre-generation hand-maintained file:',
        ' *   - paramMappings now has exactly 80 rows (legacy indices 0..79 once',
        ' *     each). BENDRANGE (6) is ONE row; its split second half is carried',
        ' *     by the secondaryNewId/secondaryMethod fields ("PitchBendDown" /',
        ' *     "processBendDownRange"). The old file duplicated the row (81 rows).',
        ' *   - Rows gained generated fields: transformKind (null on removed rows),',
        ' *     specialInline, drumClass, drumRestoreSkip, and the BENDRANGE pair.',
        ' *   - canonicalNewParamOrder = the 28 OB-Xf-only streaming names by',
        ' *     canonical ordinal (SynthParam.h declaration order). This differs',
        ' *     from the legacy runtime sentinel order frozen in',
        ' *     tools/new-param-order-v1.json.',
        ' *   - paramTransforms provides PURE forward (legacy→engine) and invert',
        ' *     (engine→legacy) functions per streaming name so tests can golden',
        ' *     the transform math without touching the C side. LFO1Rate models',
        ' *     only the free-running path; LFO1TempoSync is value-1:1 — both are',
        ' *     specialInline in C (mirror-state dependent) and carry invert null.',
        ' */',
        '',
        'export const PARAM_COUNT = ' + PARAM_COUNT + ';',
        'export const NEW_PARAM_BASE = ' + NEW_PARAM_BASE + ';',
        'export const NEW_PARAM_COUNT = ' + NEW_PARAM_COUNT + ';',
        'export const BENDRANGE_LEGACY_INDEX = ' + BENDRANGE_LEGACY_INDEX + ';',
        '',
        `export type DrumClass = "none" | "global" | "smoother" | "voice";`,
        `export type TransformKind =`,
        `    | "IDENTITY" | "MUL" | "SPLIT_BENDRANGE" | "VOICE_COUNT" | "OCTAVE_TRANSPOSE"`,
        `    | "LOGSC_INVLOGSC" | "BOOL_BLEND" | "BOOL_TRISTATE" | "NOTEPRIORITY"`,
        `    | "PAN" | "LFO1_RATE" | "LFO1_SYNC";`,
        '',
        'export type ParamMapping = {',
        '    legacyIndex: number;                 // old ParamsEnum.h integer, 0..79',
        '    legacyName: string;                  // old ParamsEnum.h identifier, e.g. "CUTOFF"',
        '    legacyMethod: string;                // old SynthEngine method, e.g. "processCutoff"',
        '    newId: string;                       // OB-Xf SynthParam::ID streaming string ("" = removed)',
        '    newMethod: string | null;            // new SynthEngine method; null if removed/no-op',
        '    secondaryNewId?: string;             // set only on BENDRANGE: "PitchBendDown"',
        '    secondaryMethod?: string;            // set only on BENDRANGE: "processBendDownRange"',
        '    transformKind: TransformKind | null; // closed-vocabulary kind; null on removed rows',
        '    specialInline: boolean;              // true for LFOFREQ(17)/LFO_SYNC(72) — C handles inline',
        '    drumClass: DrumClass;                // PCM drum routing (instance 9)',
        '    drumRestoreSkip: boolean;            // worklet DRUM_STRUCTURAL_SKIP (orthogonal axis)',
        '    newNotes?: string;                   // caveats (rescale math, renames, ...)',
        '};',
        '',
    );

    // -- transformKinds doc constant ------------------------------------------
    push(
        '/**',
        ' * The closed transform vocabulary (mirrors TRANSFORM_KINDS in',
        ' * tools/param-spec.mjs). Keys are the kinds; values are one-line docs of',
        ' * the legacy 0..1 → native 0..1 math. Invert semantics per kind are',
        ' * documented in tools/PARAM_SPEC.md §Invert semantics.',
        ' */',
        'export const transformKinds: Readonly<Record<TransformKind, string>> = {',
        '    IDENTITY: "value passes through unchanged (any internal logsc/linsc happens inside the engine)",',
        '    MUL: "native = legacy * factor (invert: * reciprocal)",',
        '    SPLIT_BENDRANGE: "semitones = v > threshold ? semitonesHigh : semitonesLow; native = semitones / maxBendRange, written to BOTH halves",',
        '    VOICE_COUNT: "old voices = clamp(round(v*7)+1, 1..8); native = (voices-1+0.5)/MAX_VOICES",',
        '    OCTAVE_TRANSPOSE: "transpose = clamp(round(v*4)+1, 0..4); native = transpose * 0.25",',
        '    LOGSC_INVLOGSC: "xdLogsc(v, xd) [/ preDivisor], then unmap through xf (invLogsc / invLinsc / baked-identity per curve)",',
        '    BOOL_BLEND: "LFO wave bool → continuous blend: native = v >= 0.5 ? 0 : 0.5",',
        '    BOOL_TRISTATE: "LFO destination bool → tri-state {Off,On,Inv}: native = v >= 0.5 ? 0.5 : 0",',
        '    NOTEPRIORITY: "bool → tri-state, STRICT >: native = v > 0.5 ? 0 : 0.5",',
        '    PAN: "value identity; the engine method takes an extra voice index — processPan(v, idx)",',
        '    LFO1_RATE: "specialInline (C-side, sync-aware bucket map); the pure forward here models the FREE path only",',
        '    LFO1_SYNC: "specialInline (C-side re-dispatch of LFOFREQ); the value itself is 1:1",',
        '};',
        '',
    );

    // -- canonicalNewParamOrder -------------------------------------------------
    push(
        '/**',
        ' * The 28 OB-Xf-only streaming names ordered by canonical ordinal — the',
        ' * declaration order of streaming IDs in SynthParam.h filtered to params',
        ' * with no legacy ancestor. UI sentinel index = NEW_PARAM_BASE + position.',
        ' * NOTE: intentionally differs from the runtime sentinel order frozen in',
        ' * tools/new-param-order-v1.json (see tools/PARAM_SPEC.md).',
        ' */',
        'export const canonicalNewParamOrder: readonly string[] = [',
    );
    for (const name of canonicalNewParamOrder) {
        push(`    ${tsStr(name)},`);
    }
    push('];', '');

    // -- paramMappings rows -----------------------------------------------------
    // Column widths computed over all rows for stable alignment.
    const rowsData = legacy.map((e) => ({
        e,
        legacyIndex: String(e.legacyIndex),
        legacyName: tsStr(e.legacyName),
        legacyMethod: tsStr(e.legacyMethod),
        newId: tsStr(e.newId),
        newMethod: e.method === '' ? 'null' : tsStr(e.method),
        transformKind: e.newId === '' ? 'null' : tsStr(e.transform.kind),
        specialInline: String(e.specialInline),
        drumClass: tsStr(e.drumClass),
        drumRestoreSkip: String(e.drumRestoreSkip),
        newNotes: tsStr(e.notes),
    }));
    const w = (key) => Math.max(...rowsData.map((r) => r[key].length));
    const wIdx = w('legacyIndex'), wName = w('legacyName'), wMethod = w('legacyMethod'),
        wNewId = w('newId'), wNewMethod = w('newMethod'), wKind = w('transformKind'),
        wInline = w('specialInline'), wDrum = w('drumClass'), wSkip = w('drumRestoreSkip');

    push('export const paramMappings: ParamMapping[] = [');
    for (const r of rowsData) {
        for (const [startIdx, comment] of TS_SECTIONS) {
            if (r.e.legacyIndex === startIdx) push('', `    ${comment}`);
        }
        let line = '    '
            + `{ legacyIndex: ${r.legacyIndex.padEnd(wIdx)}, legacyName: ${r.legacyName.padEnd(wName)}, legacyMethod: ${r.legacyMethod.padEnd(wMethod)}, `
            + `newId: ${r.newId.padEnd(wNewId)}, newMethod: ${r.newMethod.padEnd(wNewMethod)}, `;
        if (r.e.transform?.secondaryNewId) {
            line += `secondaryNewId: ${tsStr(r.e.transform.secondaryNewId)}, secondaryMethod: ${tsStr(r.e.transform.secondaryMethod)}, `;
        }
        line += `transformKind: ${r.transformKind.padEnd(wKind)}, specialInline: ${r.specialInline.padEnd(wInline)}, `
            + `drumClass: ${r.drumClass.padEnd(wDrum)}, drumRestoreSkip: ${r.drumRestoreSkip.padEnd(wSkip)}, `
            + `newNotes: ${r.newNotes} },`;
        push(line);
    }
    push('];', '');

    // -- pure transform functions -------------------------------------------------
    push(
        '// =========================================================================',
        '// PURE transform functions (generated). forward maps legacy 0..1 → native',
        '// engine 0..1 (the applyLegacy math); invert maps native 0..1 → legacy 0..1',
        '// (used to write the legacy param mirror when loading native OB-Xf .fxp',
        '// named attributes). Implemented from the spec descriptors so tests can',
        '// golden the math without touching the C side. Callers clamp inputs to',
        '// [0,1] exactly as the C dispatcher does; these functions add no clamps',
        '// beyond those the spec math itself specifies.',
        '// =========================================================================',
        '',
        'const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));',
        '',
        '// OB-Xd logsc/linsc + inverses — verbatim from ObxdImporter.cpp / main_obxd.cpp.',
        'const xdLogsc = (p: number, lo: number, hi: number, rolloff: number): number =>',
        '    ((Math.exp(p * Math.log(rolloff + 1)) - 1) / rolloff) * (hi - lo) + lo;',
        'const xdLinsc = (p: number, lo: number, hi: number): number => lo + p * (hi - lo);',
        'const xdInvLinsc = (y: number, lo: number, hi: number): number =>',
        '    hi === lo ? 0 : clamp((y - lo) / (hi - lo), 0, 1);',
        'const xdInvLogsc = (y: number, lo: number, hi: number, rolloff: number): number => {',
        '    if (hi === lo) return 0;',
        '    const t = (rolloff * (y - lo)) / (hi - lo) + 1;',
        '    if (t <= 0) return 0;',
        '    return clamp(Math.log(t) / Math.log(rolloff + 1), 0, 1);',
        '};',
        '',
        'export type ParamTransformFns = {',
        '    readonly legacyIndex: number;',
        '    /** legacy 0..1 → native engine 0..1 (the applyLegacy math) */',
        '    readonly forward: (legacyValue: number) => number;',
        '    /** native engine 0..1 → legacy 0..1 (mirror write); null where the spec says null */',
        '    readonly invert: ((nativeValue: number) => number) | null;',
        '};',
        '',
        '/**',
        ' * Name-keyed transforms for every legacy-mapped streaming name (including',
        ` * both BENDRANGE halves). ${legacyMappedNameCount} entries in total. NEW-param`,
        ' * names (no legacy space) are intentionally absent.',
        ' */',
        'export const paramTransforms: Readonly<Record<string, ParamTransformFns>> = {',
    );
    // (count = legacy rows with a streaming name + the BENDRANGE split half)
    const emitTsEntry = (name, e, comment) => {
        const fwd = tsForwardExpr(e);
        let line = `    ${tsStr(name)}: { legacyIndex: ${e.legacyIndex}, forward: (v) => ${fwd}, `;
        if (e.invert) {
            line += `invert: (v) => ${tsInvertExpr(e)} },`;
        } else {
            line += 'invert: null },';
        }
        if (comment) line += ` // ${comment}`;
        push(line);
    };
    let lastIdx = -1;
    for (const e of legacy) {
        if (e.newId === '') continue;
        if (lastIdx >= 0 && e.legacyIndex !== lastIdx) push(''); // light grouping by legacy index gaps
        lastIdx = e.legacyIndex;
        const note = e.specialInline
            ? `specialInline: ${e.specialInline ? 'invert null; ' : ''}see transformKinds.${e.transform.kind}`
            : null;
        emitTsEntry(e.newId, e, note);
        if (e.transform?.secondaryNewId) {
            emitTsEntry(e.transform.secondaryNewId, e, 'split half — same forward/invert as the primary');
        }
    }
    push('};', '');

    return L.join('\n');
}

// ---------------------------------------------------------------------------
// Output 3: src/generated/param-table.json
// ---------------------------------------------------------------------------

function genJson() {
    const dump = {
        generator: 'tools/gen-param-table.mjs',
        source: 'tools/param-spec.mjs',
        doc: 'Machine-readable dump of the OB-Xd→OB-Xf parameter spec as emitted. See tools/PARAM_SPEC.md.',
        constants: {
            PARAM_COUNT,
            NEW_PARAM_BASE,
            NEW_PARAM_COUNT,
            BENDRANGE_LEGACY_INDEX,
            nameIndexCount: nameIndex.length,
        },
        legacyRows: legacy.map((e) => ({
            legacyIndex: e.legacyIndex,
            legacyName: e.legacyName,
            legacyMethod: e.legacyMethod,
            newId: e.newId,
            method: e.method,
            secondaryNewId: e.transform?.secondaryNewId ?? null,
            secondaryMethod: e.transform?.secondaryMethod ?? null,
            transform: e.transform,
            invert: e.invert,
            specialInline: e.specialInline,
            drumClass: e.drumClass,
            drumRestoreSkip: e.drumRestoreSkip,
            notes: e.notes,
        })),
        newParams: freshByOrdinal.map((e) => ({
            newId: e.newId,
            method: e.method,
            newOrdinal: e.newOrdinal,
            drumClass: e.drumClass,
            drumRestoreSkip: e.drumRestoreSkip,
            notes: e.notes,
        })),
        canonicalNewParamOrder,
        nameIndex: nameIndex.map((entry) => ({
            name: entry.name,
            legacyIndex: entry.legacyIndex,
            newOrdinal: entry.newOrdinal,
            invert: entry.invert !== null,
        })),
        drumSets: {
            globalC: [...DRUM_GLOBAL_C_SET],
            global: legacy.filter((e) => e.drumClass === 'global').map((e) => e.legacyIndex),
            smoother: [...DRUM_SMOOTHER_SET],
            restoreSkip: [...DRUM_RESTORE_SKIP_SET],
            none: [...DRUM_NONE_SET],
        },
    };
    return JSON.stringify(dump, null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
    const problems = validateSpec();
    if (problems.length > 0) {
        console.error('tools/param-spec.mjs failed its self-check — refusing to generate:');
        for (const p of problems) console.error(`  - ${p}`);
        process.exit(2);
    }

    const outputs = [
        { rel: OUT_H, content: genHeader() },
        { rel: OUT_TS, content: genTs() },
        { rel: OUT_JSON, content: genJson() },
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
            console.error('STALE generated outputs (regenerate with `node tools/gen-param-table.mjs`):');
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
        `param table: ${PARAM_COUNT} legacy rows, ${NEW_PARAM_COUNT} new params, ` +
        `${nameIndex.length} name-index entries (${legacy.filter((e) => e.newId !== '').length} legacy names ` +
        `+ 1 BENDRANGE split half + ${NEW_PARAM_COUNT} NEW)`,
    );
}

main();

// ===========================================================================
// worklet-protocol.mjs — the AUTHORITATIVE worklet message-protocol spec.
//
// Single source of truth for every port message exchanged between the main
// thread and the combined OB-Xf/Octopus AudioWorklet (obxd-processor.js):
//   - PROTOCOL.mainToWorklet — messages the worklet's port.onmessage handler
//     receives (oct_* / synth / fx_* / mix_* families)
//   - PROTOCOL.workletToMain — replies and events the worklet posts back
//     (param mirrors, dumps, meters, hw_midi batches, oct_* status)
// A later generator task consumes THIS module to emit the main-thread
// TypeScript discriminated unions (src/generated/worklet-protocol.ts) and the
// classic-script shape validator (src/generated/worklet-protocol-checks.js).
//
// DSL vocabulary for field values (CLOSED SET — parseFieldDsl throws on
// anything else):
//   "int" | "int:LO-HI"     JS number (integral by contract), optional range
//   "number" | "number:LO-HI"  JS number, optional range
//   "string"                JS string
//   "bool"                  JS boolean
//   "flag"                  NUMERIC 0/1 (pinned as-sent — do NOT "fix" to bool)
//   "bytes"                 Uint8Array
//   "f32"                   Float32Array
//   "number[]" | "number[]:N"  JS number array, optional fixed length
//   suffix "?"              optional field (absent allowed)
//   suffix "|null"          nullable field (combinable with "?")
//
// Encodings below are pinned AS-SENT — inconsistencies (flag vs bool, numeric
// enabled arrays, dense layer indices) are transcribed faithfully, not fixed.
//
// Pure data + parser + self-check. No side effects at import time, no
// dependencies. Verify with:
//   node -e "import('./tools/worklet-protocol.mjs').then(m => console.log(m.validateProtocol()))"
// (must print []).
// ===========================================================================

// ---------------------------------------------------------------------------
// DSL parser — validates + decomposes one field DSL string. Throws on
// anything outside the closed vocabulary above.
// ---------------------------------------------------------------------------

export function parseFieldDsl(dsl) {
    if (typeof dsl !== 'string') throw new Error(`field DSL must be a string, got ${typeof dsl}`);
    let s = dsl;
    let optional = false;
    let nullable = false;
    // Suffixes may stack in either order ("bytes?|null", "string|null?").
    if (s.endsWith('?')) { optional = true; s = s.slice(0, -1); }
    if (s.endsWith('|null')) { nullable = true; s = s.slice(0, -5); }
    if (s.endsWith('?')) { optional = true; s = s.slice(0, -1); }
    let m;
    let base = null;
    let lo = null;
    let hi = null;
    let fixedLen = null;
    if ((m = /^number\[\](?::(\d+))?$/.exec(s)) !== null) {
        base = 'number[]';
        if (m[1] !== undefined) fixedLen = Number(m[1]);
    } else if ((m = /^(int|number):(-?\d+)-(-?\d+)$/.exec(s)) !== null) {
        base = m[1];
        lo = Number(m[2]);
        hi = Number(m[3]);
    } else if (/^(int|number|string|bool|flag|bytes|f32)$/.test(s)) {
        base = s;
    }
    if (base === null) throw new Error(`unknown field DSL '${dsl}'`);
    if (lo !== null && lo > hi) throw new Error(`field DSL '${dsl}': range lo > hi`);
    return { base, lo, hi, fixedLen, optional, nullable };
}

// ---------------------------------------------------------------------------
// The protocol. Entry shape: { type, fields: {name: DSL}, notes }.
// `fields` is an ORDERED object (order mirrors the sender's payload shape).
// `notes` is one concise semantics line — queued vs inline handler, HEAVY,
// diagnostics-only, reply pairings. No sender file:line references (they rot).
// ---------------------------------------------------------------------------

export const PROTOCOL = {
    mainToWorklet: [
        // -- synth: instance lifecycle ------------------------------------------
        { type: 'midi', fields: { instance_id: 'int:0-9', status: 'int', d1: 'int', d2: 'int' }, notes: 'queued to pendingMidi, drained inside process()' },
        { type: 'set_routing', fields: { routing: 'number[]:17' }, notes: 'per-channel instance bitmask: bit i of routing[ch] = instance i' },
        { type: 'set_active', fields: { instance_id: 'int:0-9', active: 'bool' }, notes: 'power an instance on/off' },
        { type: 'set_polyphony', fields: { instance_id: 'int:0-9', voice_count: 'int' }, notes: 'no active callers; polyphony owned by legacy idx 3' },
        { type: 'set_mpe', fields: { instance_id: 'int:0-9', enabled: 'flag' }, notes: 'per-instance MPE flag mirror (g_mpe_enabled)' },
        { type: 'set_mod_wheel', fields: { instance_id: 'int:0-9', value: 'number:0-1' }, notes: 'reserved CC 1 direct route' },
        { type: 'set_sustain', fields: { instance_id: 'int:0-9', enabled: 'flag' }, notes: 'reserved CC 64 direct route' },
        { type: 'set_mpe_glide_range', fields: { instance_id: 'int:0-9', semitones: 'int:0-48' }, notes: 'MPE pitch-bend range in semitones' },
        { type: 'set_matrix_row', fields: { instance_id: 'int:0-9', row: 'int:0-7', src: 'string', tgt: 'string', depth: 'number:-1-1' }, notes: 'MPE modulation matrix row set' },
        { type: 'clear_matrix_row', fields: { instance_id: 'int:0-9', row: 'int:0-7' }, notes: 'MPE modulation matrix row clear' },
        // -- synth: params + patches -------------------------------------------
        { type: 'set_param', fields: { instance_id: 'int:0-9', idx: 'int', value: 'number:0-1' }, notes: 'legacy-space 0..1 param write (queued)' },
        { type: 'gain', fields: { instance_id: 'int:0-9', value: 'number:0-1' }, notes: 'no active callers' },
        { type: 'load_fxp', fields: { instance_id: 'int:0-9', bytes: 'bytes' }, notes: 'HEAVY; the ONLY message posted with a transfer list ([bytes.buffer])' },
        { type: 'set_factory_patch', fields: { instance_id: 'int:0-9', patch_id: 'int' }, notes: 'HEAVY (task-queued factory .fxp parse)' },
        { type: 'panic', fields: { instance_id: 'int:0-9' }, notes: 'all notes off for one instance' },
        { type: 'panic_all', fields: {}, notes: 'all notes off, every instance' },
        { type: 'reset_patch', fields: { instance_id: 'int:0-9' }, notes: 'reset one instance to the init patch' },
        { type: 'get_param', fields: { instance_id: 'int:0-9', idx: 'int' }, notes: 'request/reply — answered by param_value' },
        { type: 'dump_all_params', fields: {}, notes: 'bulk pull — answered by all_params_dumped' },
        { type: 'restore_all_state', fields: { synthParams: 'number[]:1080', drumParams: 'number[]:3456|null' }, notes: 'staged engine-owned restore; drumParams null = synth-only' },
        // -- synth: PCM drum engine (instance 9) --------------------------------
        { type: 'dump_drum_params', fields: {}, notes: 'bulk pull — answered by drum_params_dumped' },
        { type: 'set_drum_layer_param', fields: { instance_id: 'int:0-9', pad: 'int:0-7', layer: 'int:0-3', idx: 'int', value: 'number:0-1' }, notes: 'layer is the DENSE index (enabled+sampled layers packed from 0)' },
        { type: 'get_drum_layer_param', fields: { instance_id: 'int:0-9', pad: 'int:0-7', layer: 'int:0-3', idx: 'int' }, notes: 'DENSE layer index — answered by drum_layer_param_value' },
        { type: 'get_patch_name', fields: { instance_id: 'int:0-9' }, notes: 'no active callers — answered by patch_name' },
        { type: 'ping', fields: {}, notes: 'inline; 30 Hz liveness poll — answered by pong' },
        { type: 'load_pcm', fields: { instance_id: 'int:0-9', pad: 'int:0-7', layer: 'int:0-3', pcmL: 'f32', frames: 'int' }, notes: 'HEAVY, no reply; layer is the DENSE index' },
        { type: 'set_pcm_layer', fields: { instance_id: 'int:0-9', pad: 'int:0-7', layer: 'int:0-3', gain: 'number', cutoff: 'number', res: 'number', mode: 'number', aA: 'number', aD: 'number', aS: 'number', aR: 'number', pan: 'number', pitch: 'number' }, notes: 'full-param layer push; layer is the DENSE index; pitch is the RATE multiplier 2^((knob-0.5)*2) ≈ 0.25..4, NOT 0..1' },
        { type: 'set_pcm_note_map', fields: { instance_id: 'int:0-9', note: 'int', pad: 'int:0-7' }, notes: 'map a MIDI note onto a pad' },
        { type: 'set_pcm_layer_count', fields: { instance_id: 'int:0-9', pad: 'int:0-7', count: 'int:0-4' }, notes: 'dense played-layer count for the pad' },
        { type: 'set_pcm_choke', fields: { instance_id: 'int:0-9', pad: 'int:0-7', group: 'int' }, notes: 'choke group for the pad' },
        { type: 'clear_pcm', fields: { instance_id: 'int:0-9' }, notes: 'HEAVY — frees the instance PCM bank' },
        // -- guitarix FX chains --------------------------------------------------
        { type: 'fx_set_param', fields: { instance_id: 'int:0-9', slot: 'int:0-10', param: 'int:0-47', value: 'number' }, notes: 'light queued setter; value in ENGINE units, NOT 0..1' },
        { type: 'fx_set_enabled', fields: { instance_id: 'int:0-9', slot: 'int:0-10', enabled: 'bool' }, notes: 'INLINE — eager DSP activation at message-handler time' },
        { type: 'fx_set_slot', fields: { instance_id: 'int:0-9', slot: 'int:0-10', fx_id: 'int:-1-82' }, notes: 'INLINE — eager DSP create at message-handler time; -1 = empty' },
        { type: 'fx_move_slot', fields: { instance_id: 'int:0-9', from: 'int:0-10', to: 'int:0-10' }, notes: 'INLINE — array-moves a slot whole content' },
        { type: 'fx_get_out_param', fields: { instance_id: 'int:0-9', slot: 'int:0-10', index: 'int' }, notes: 'inline direct reply — answered by fx_out_param' },
        { type: 'fx_get_state', fields: {}, notes: 'bulk pull — answered by fx_state' },
        { type: 'fx_restore_state', fields: { params: 'number[]:5280', slots: 'number[]:110', enabled: 'number[]:110' }, notes: 'HEAVY; slots are fx ids -1..82, enabled is numeric 0/1' },
        // -- CakeMix mixer console -----------------------------------------------
        { type: 'mix_gain', fields: { ch: 'int:0-31', gain: 'number' }, notes: 'linear gain for a mono engine channel' },
        { type: 'mix_pan', fields: { ch: 'int:0-31', pan: 'number:-1-1' }, notes: '-1..1 balance for a mono engine channel' },
        { type: 'mix_mute', fields: { ch: 'int:0-31', muted: 'bool' }, notes: 'mute a mono engine channel' },
        { type: 'mix_solo', fields: { ch: 'int:0-31', soloed: 'bool' }, notes: 'solo a mono engine channel' },
        { type: 'mix_input_gain', fields: { ch: 'int:0-31', gainDb: 'number' }, notes: 'input trim in dB' },
        { type: 'mix_phase', fields: { ch: 'int:0-31', inverted: 'bool' }, notes: 'invert channel phase' },
        { type: 'mix_pan_law', fields: { ch: 'int:0-31', law: 'int:0-3' }, notes: 'pan law selector 0..3' },
        { type: 'mix_name', fields: { ch: 'int:0-31', name: 'string' }, notes: 'channel strip label' },
        { type: 'mix_main_assign', fields: { ch: 'int:0-31', on: 'bool' }, notes: 'assign channel to the main bus' },
        { type: 'mix_eq_gain', fields: { ch: 'int:0-31', band: 'int:0-5', gainDb: 'number' }, notes: 'channel EQ band gain in dB' },
        { type: 'mix_eq_freq', fields: { ch: 'int:0-31', band: 'int:0-5', freqHz: 'number' }, notes: 'channel EQ band frequency in Hz' },
        { type: 'mix_eq_q', fields: { ch: 'int:0-31', band: 'int:0-5', q: 'number' }, notes: 'channel EQ band Q' },
        { type: 'mix_eq_bypass', fields: { ch: 'int:0-31', bypassed: 'bool' }, notes: 'bypass the channel EQ' },
        { type: 'mix_comp_enable', fields: { ch: 'int:0-31', enabled: 'bool' }, notes: 'enable the channel compressor' },
        { type: 'mix_comp_param', fields: { ch: 'int:0-31', param: 'int:0-5', value: 'number' }, notes: 'compressor param value (ENGINE units)' },
        { type: 'mix_gate_enable', fields: { ch: 'int:0-31', enabled: 'bool' }, notes: 'enable the channel gate' },
        { type: 'mix_gate_param', fields: { ch: 'int:0-31', param: 'int:0-4', value: 'number' }, notes: 'gate param value (ENGINE units)' },
        { type: 'mix_exp_enable', fields: { ch: 'int:0-31', enabled: 'bool' }, notes: 'enable the channel expander' },
        { type: 'mix_exp_param', fields: { ch: 'int:0-31', param: 'int:0-3', value: 'number' }, notes: 'expander param value (ENGINE units)' },
        { type: 'mix_master_gain', fields: { gain: 'number' }, notes: 'master bus gain' },
        { type: 'mix_limiter_enabled', fields: { enabled: 'bool' }, notes: 'enable the master limiter' },
        { type: 'mix_limiter_ceiling', fields: { ceilingDb: 'number' }, notes: 'limiter ceiling in dB' },
        { type: 'mix_limiter_release', fields: { releaseMs: 'number' }, notes: 'limiter release in ms' },
        { type: 'mix_clear_clip', fields: {}, notes: 'clear the master clip indicator' },
        { type: 'mix_get_params', fields: {}, notes: 'devtools-only diagnostics, no in-repo sender — answered by mixer_params' },
        // -- Octopus sequencer engine --------------------------------------------
        { type: 'oct_key', fields: { key: 'int', press: 'flag' }, notes: 'INLINE; the SAVE key latches a HEAVY deferred save — answered by oct_state_saved' },
        { type: 'oct_rotary', fields: { idx: 'int', dir: 'int' }, notes: 'INLINE' },
        { type: 'oct_transport', fields: { running: 'flag' }, notes: 'INLINE — run/stop the sequencer' },
        { type: 'oct_pause', fields: {}, notes: 'INLINE test hook (driven via window.__octopus)' },
        { type: 'oct_tempo', fields: { bpm: 'number' }, notes: 'INLINE — sets the engine BPM' },
        { type: 'oct_zoom', fields: { level: 'int' }, notes: 'INLINE test hook — sets the zoom level' },
        { type: 'oct_midi_in', fields: { status: 'int', d1: 'int', d2: 'int' }, notes: 'INLINE — no instance_id; feeds the firmware byte interpreters' },
        { type: 'oct_shutdown', fields: {}, notes: 'INLINE test hook — shuts the engine down' },
        { type: 'oct_pump', fields: { ms: 'number:1-100' }, notes: 'INLINE — RAF fallback while the context is suspended' },
        { type: 'oct_save_state', fields: {}, notes: 'HEAVY — answered by oct_state_bytes' },
        { type: 'oct_load_state', fields: { bytes: 'bytes' }, notes: 'HEAVY — answered by oct_state_loaded; bytes are structured-cloned, NOT transferred' },
        { type: 'oct_snapshot', fields: {}, notes: 'INLINE test hook — answered by oct_snapshot' },
    ],

    workletToMain: [
        // -- boot / lifecycle ------------------------------------------------------
        { type: 'ready', fields: {}, notes: 'worklet boot finished' },
        { type: 'constructed', fields: {}, notes: 'no consumer — debug liveness' },
        { type: 'error', fields: { message: 'string', stack: 'string' }, notes: 'generic worklet error report' },
        // -- Octopus engine --------------------------------------------------------
        { type: 'oct_ready', fields: { mirPtr: 'int', processedMirPtr: 'int', statusPtr: 'int' }, notes: 'hands over the MIR/status byte offsets; mirPtr posted but currently unread' },
        { type: 'oct_state_saved', fields: { bytes: 'bytes|null' }, notes: 'internal GRID+PGM save bytes — posted by the task-queue save task' },
        { type: 'oct_state_bytes', fields: { bytes: 'bytes|null' }, notes: 'explicit save dump bytes — reply to oct_save_state' },
        { type: 'oct_state_loaded', fields: { ok: 'bool' }, notes: 'load ack — reply to oct_load_state' },
        { type: 'oct_snapshot', fields: { mir: 'number[]:170', runBit: 'number', tempo: 'number', zoom: 'number', tickCount: 'number' }, notes: 'one-shot MIR + transport snapshot — reply to the oct_snapshot request' },
        // -- liveness / hardware MIDI ---------------------------------------------
        { type: 'pong', fields: { alive: 'bool', ready: 'bool', meters: 'number[]:10', voiceActivity: 'number[]:10', bufLPtr: 'int', bufRPtr: 'int' }, notes: 'liveness reply; alive/ready/bufLPtr/bufRPtr currently unread' },
        { type: 'hw_midi', fields: { packed: 'number[]' }, notes: 'packed firmware MIDI batches, posted per drained quantum' },
        // -- synth replies ----------------------------------------------------------
        { type: 'fxp_loaded', fields: { instance_id: 'int:0-9', success: 'bool', rc: 'int', name: 'string' }, notes: 'load ack; rc currently unread' },
        { type: 'param_value', fields: { instance_id: 'int:0-9', idx: 'int', value: 'number:0-1' }, notes: 'reply to get_param' },
        { type: 'patch_name', fields: { instance_id: 'int:0-9', name: 'string' }, notes: 'reply to get_patch_name' },
        { type: 'all_params_dumped', fields: { params: 'number[]:1080' }, notes: 'reply to dump_all_params' },
        { type: 'all_state_restored', fields: {}, notes: 'staged restore complete' },
        { type: 'drum_params_dumped', fields: { params: 'number[]:3456' }, notes: 'reply to dump_drum_params' },
        { type: 'drum_layer_param_value', fields: { instance_id: 'int:0-9', pad: 'int:0-7', layer: 'int:0-3', idx: 'int', value: 'number:0-1' }, notes: 'reply to get_drum_layer_param (layer is the DENSE index)' },
        // -- FX replies --------------------------------------------------------------
        { type: 'fx_out_param', fields: { instance_id: 'int:0-9', slot: 'int:0-10', index: 'int', value: 'number' }, notes: 'inline direct reply to fx_get_out_param' },
        { type: 'fx_state', fields: { params: 'number[]:5280', slots: 'number[]:110', enabled: 'number[]:110' }, notes: 'reply to fx_get_state' },
        { type: 'fx_state_restored', fields: {}, notes: 'ack for fx_restore_state' },
        { type: 'fx_state_error', fields: { message: 'string' }, notes: 'no listener — restoreFxState times out; kept in spec' },
        // -- mixer --------------------------------------------------------------------
        { type: 'mixer_ready', fields: {}, notes: 'CakeMix mixer engine booted' },
        { type: 'mixer_error', fields: { phase: 'string', message: 'string', stack: 'string?' }, notes: "stack present on phase 'init' only — modeled optional" },
        { type: 'mixer_meter', fields: { peakL: 'number', peakR: 'number', rmsL: 'number', rmsR: 'number', clip: 'bool', limiterGr: 'number', channelsJson: 'string' }, notes: 'master + per-channel metering (~every 10 blocks)' },
        { type: 'mixer_params', fields: { json: 'string' }, notes: 'diagnostics only — reply to mix_get_params' },
    ],
};

// ---------------------------------------------------------------------------
// Self-check — returns an array of problem strings ([] = spec is well-formed).
// ---------------------------------------------------------------------------

export function validateProtocol() {
    const problems = [];
    for (const [dir, entries] of [['mainToWorklet', PROTOCOL.mainToWorklet], ['workletToMain', PROTOCOL.workletToMain]]) {
        if (!Array.isArray(entries) || entries.length === 0) {
            problems.push(`${dir}: must be a non-empty array`);
            continue;
        }
        const seen = new Set();
        for (const e of entries) {
            if (!e || typeof e !== 'object' || Array.isArray(e)) {
                problems.push(`${dir}: entry is not an object`);
                continue;
            }
            const where = `${dir}[${typeof e.type === 'string' ? e.type : '<missing type>'}]`;
            if (typeof e.type !== 'string' || !/^[a-z][a-z0-9_]*$/.test(e.type)) {
                problems.push(`${where}: bad type name`);
            } else if (seen.has(e.type)) {
                problems.push(`${where}: duplicate type`);
            } else {
                seen.add(e.type);
            }
            if (e.fields === undefined || e.fields === null || typeof e.fields !== 'object' || Array.isArray(e.fields)) {
                problems.push(`${where}: fields must be an object`);
            } else {
                for (const [name, dsl] of Object.entries(e.fields)) {
                    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
                        problems.push(`${where}: bad field name '${name}'`);
                        continue;
                    }
                    try {
                        parseFieldDsl(dsl);
                    } catch (err) {
                        problems.push(`${where}: field '${name}': ${err.message}`);
                    }
                }
            }
            if (typeof e.notes !== 'string' || e.notes.trim() === '') {
                problems.push(`${where}: notes must be a non-empty string`);
            }
        }
    }
    return problems;
}

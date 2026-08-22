/*
 * wasm/obxd/main_obxd.cpp — multi-instance OB-Xf synth engine wrapper.
 *
 * This is the OB-Xd → OB-Xf migration target. It drives the Surge-maintained
 * OB-Xf SynthEngine (obxf_imported/engine/SynthEngine.h) instead of the
 * legacy 2DaT/Obxd engine. The engine API is richer (MPE channel-aware note
 * handlers, ~30 more processX() params, 32-voice polyphony, second LFO) but
 * the wrapper preserves the existing 10-instance rig contract: up to 10
 * SynthEngine instances share one WASM heap, are summed per quantum into a
 * master stereo buffer, and run through an always-on x/(1+|x|) soft-clip
 * before being handed back to the AudioWorklet.
 *
 * Legacy parameter compatibility:
 *   The UI knob layer (.fxp loaders, obxd-synth-ui.ts) still speaks the OLD
 *   OB-Xd integer param indices 0..79 (ParamsEnum.h order). apply_param_instance()
 *   dispatches those legacy indices onto the NEW OB-Xf processX() methods via
 *   the GENERATED tables in wasm/obxd/param_table.h (obxf_legacy_params[] —
 *   one row per legacy index with the forward transform as a fn ptr), produced
 *   by tools/gen-param-table.mjs from tools/param-spec.mjs (the single source
 *   of truth — see tools/PARAM_SPEC.md) and verified against
 *   obxf_imported/state/ObxdImporter.cpp (the canonical OB-Xd→OB-Xf
 *   translator). Rescale rules implemented:
 *     - VOICE_COUNT:   old 1..8 voices → new polyphony midpoint
 *     - OCTAVE:        → Transpose, semantic shift (round(v*4)+1 clamped 0..4)*0.25
 *     - BENDRANGE:     SPLIT → processBendUpRange + processBendDownRange
 *     - BENDLFORATE:   → processVibratoLFORate (logsc→linsc Hz remap)
 *     - UDET:          → processUnisonDetune (logsc range 0.9 → 1.0)
 *     - LFOFREQ:       → processLFO1Rate (~75x rate rescale; synced bucket map)
 *     - XMOD:          → processCrossmod (v*0.5; old v*24 st, new v*48 st)
 *     - ENVPITCH:      → processEnvToPitchAmount (v*36/40)
 *     - NOISEMIX:      → processNoiseVolume (bake logsc(v,0,1,35) into value)
 *     - LATK/FATK:     attack /3 (OB-Xf env sustains at 90%)
 *     - PW_ENV:        → processEnvToPWAmount (v*0.85/1.0556)
 *     - PW_OSC2_OFS:   → processOsc2PWOffset (v*0.75/0.95)
 *     - LFO wave/dest: bool→blend/tri-state (lfoBoolToBlend/lfoBoolToTriState,
 *       now baked into the generated obxf_apply_* functions)
 *     - ASPLAYEDALLOCATION: bool→tri NotePriority
 *   REMOVED (no-op): MIDILEARN(1), OSCQuantize(32), UNLEARN(70), ECONOMY_MODE(71)
 *
 * Engine API (per obxf_imported/engine/SynthEngine.h):
 *   - SynthEngine()                          // default ctor, no args
 *   - void setSampleRate(float sr)
 *   - void processSample(float* L, float* R)  // ONE stereo sample
 *   - void processNoteOn(int note, float vel, int8_t channel)   // MPE-aware
 *   - void processNoteOff(int note, float vel, int8_t channel)
 *   - void allNotesOff() / allSoundOff()
 *   - void sustainOn() / sustainOff()
 *   - void processPitchWheel(float v)        // [-1, 1] (smoother.setStep)
 *   - void processModWheel(float v)          // [0, 1]
 *   - void processPolyphony(float v)         // 1 + (int)(v*MAX_VOICES), MAX_VOICES=32
 *   - void processX(float v) / processX(v, idx)  // ~80 per-param setters
 *
 * If a generated `patches.h` is present at compile time (produced by
 * build.sh's xxd step from real .fxp files in wasm/obxd/patches/), real
 * factory patches take precedence over the programmatic init patch — see
 * obxd_set_factory_patch.
 *
 * Exports are mirrored by the Makefile's -sEXPORTED_FUNCTIONS list and by
 * the per-instance message routing in src/obxd-processor.tail.js.
 */

#include <emscripten.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>

// =========================================================================
// JUCE setup — must precede any JUCE header include.
// =========================================================================

// See juce_amalgam.cpp for the rationale: emscripten defines __linux__,
// which would otherwise route JUCE into its Linux code paths.
#undef __linux__

#define JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED 1
#define JUCE_MODULE_AVAILABLE_juce_core          1
#define JUCE_MODULE_AVAILABLE_juce_audio_basics  1
#define JUCE_LEAK_DETECTOR(ClassName) \
    public: \
    class LeakDetectorDummyFor_##ClassName { public: LeakDetectorDummyFor_##ClassName() = default; }; \
    LeakDetectorDummyFor_##ClassName leakDetectorDummyMember_##ClassName; \
    private:
#define JUCE_ASSERTIONS 0
#define JUCE_LOG_ASSERTIONS 0

// juce_audio_basics.h pulls in juce_core.h transitively. The NEW OB-Xf
// SynthEngine.h → Program.h → ParameterList.h → SynthParam.h chain reaches
// juce::AudioParameterFloat / juce::AudioProcessorParameter, which live in
// the GUI-free juce_audio_processors_headless split (amalgamated in
// juce_amalgam.cpp). ObxdImporter.cpp includes the same header for the same
// reason — see the note there.
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors_headless/juce_audio_processors_headless.h>

// =========================================================================
// OB-Xf engine headers (resolved via -I obxf_imported).
//
// obxf_imported/engine/SynthEngine.h transitively pulls in Motherboard,
// Voice, VoiceMatrix, Lfo, Program, ParameterList, SynthParam, Constants,
// configuration — the full OB-Xf parameter/engine subsystem. Lfo.h includes
// <juce_dsp/juce_dsp.h> for FastMathApproximations::sin (a header-only
// template); juce_dsp is therefore declared available (Makefile define) but
// NOT amalgamated — its .cpp needs juce_audio_formats/FFT/Convolution which
// we do not build. SIMD auto-disables under JUCE_WASM, dodging juce_dsp.h's
// `#error "SIMD register support not implemented for this platform"`.
// =========================================================================
#include "engine/SynthEngine.h"
#include "engine/Program.h"

// GENERATED dispatch tables (legacy apply/invert fn ptrs, NEW-param native
// applies, drum classification, sorted streaming-name index). MUST come
// after the engine includes — see its header comment for the contract.
#include "param_table.h"

// =========================================================================
// Optional real-.fxp factory patches
//
// If build.sh generated patches.h from wasm/obxd/patches/*.fxp, it declares
// `static const unsigned char patch_<name>[]` arrays. HAS_FACTORY_FXP then
// routes obxd_set_factory_patch() through load_fxp_data() with those bytes
// instead of the programmatic init patch below.
// =========================================================================

#if __has_include("patches.h")
#include "patches.h"
#define HAS_FACTORY_FXP 1
#else
#define HAS_FACTORY_FXP 0
#endif

// =========================================================================
// Legacy OB-Xd parameter indices (ParamsEnum.h order, frozen).
//
// The NEW OB-Xf engine has no integer param index — every parameter is a
// named processX() method. We keep the legacy 0..79 integer space ONLY as
// the wire format for .fxp files, the knob UI (obxd_set_param), and
// param_table.h. PARAM_COUNT is the legacy count (80), NOT the
// OB-Xf parameter count.
//
// These names intentionally match the old ParamsEnum.h identifiers so the
// dispatch switch reads naturally; they live in the global namespace here
// and do not collide with any OB-Xf symbol (the engine uses lower-case
// members / qualified juce:: names).
// =========================================================================

#define PARAM_COUNT 80

namespace LegacyParam {
enum : int {
    UNDEFINED = 0, MIDILEARN = 1, VOLUME = 2, VOICE_COUNT = 3, TUNE = 4,
    OCTAVE = 5, BENDRANGE = 6, BENDOSC2 = 7, LEGATOMODE = 8, BENDLFORATE = 9,
    VFLTENV = 10, VAMPENV = 11, ASPLAYEDALLOCATION = 12, PORTAMENTO = 13,
    UNISON = 14, UDET = 15, OSC2_DET = 16, LFOFREQ = 17, LFOSINWAVE = 18,
    LFOSQUAREWAVE = 19, LFOSHWAVE = 20, LFO1AMT = 21, LFO2AMT = 22,
    LFOOSC1 = 23, LFOOSC2 = 24, LFOFILTER = 25, LFOPW1 = 26, LFOPW2 = 27,
    OSC2HS = 28, XMOD = 29, OSC1P = 30, OSC2P = 31, OSCQuantize = 32,
    OSC1Saw = 33, OSC1Pul = 34, OSC2Saw = 35, OSC2Pul = 36, PW = 37,
    BRIGHTNESS = 38, ENVPITCH = 39, OSC1MIX = 40, OSC2MIX = 41, NOISEMIX = 42,
    FLT_KF = 43, CUTOFF = 44, RESONANCE = 45, MULTIMODE = 46, FILTER_WARM = 47,
    BANDPASS = 48, FOURPOLE = 49, ENVELOPE_AMT = 50, LATK = 51, LDEC = 52,
    LSUS = 53, LREL = 54, FATK = 55, FDEC = 56, FSUS = 57, FREL = 58,
    ENVDER = 59, FILTERDER = 60, PORTADER = 61, PAN1 = 62, PAN2 = 63,
    PAN3 = 64, PAN4 = 65, PAN5 = 66, PAN6 = 67, PAN7 = 68, PAN8 = 69,
    UNLEARN = 70, ECONOMY_MODE = 71, LFO_SYNC = 72, PW_ENV = 73,
    PW_ENV_BOTH = 74, ENV_PITCH_BOTH = 75, FENV_INVERT = 76, PW_OSC2_OFS = 77,
    LEVEL_DIF = 78, SELF_OSC_PUSH = 79,
};
} // namespace LegacyParam

using namespace LegacyParam;

// =========================================================================
// State
// =========================================================================

#define INSTANCE_COUNT 10

// 1024-sample stereo master buffer — comfortably exceeds the 128-sample
// AWP quantum (worklet's RENDER_QUANTUM = 128). The worklet reads the
// first 128 samples of each render via HEAPF32; we always render exactly
// 128. obxd_render() sums every active instance into this pair.
#define BUF_FRAMES 1024

// VST2 preset header layout (fxProgramSet — see obxf_imported/core/Constants.h).
// All multi-byte integer/float fields are big-endian (network byte order),
// per the Steinberg VST2 fxp/fxb spec. Both fxProgram (regular) and
// fxProgramSet (chunk) share the same 56-byte fixed prefix; the chunk
// variant then carries a 4-byte chunkSize + variable chunk bytes.
//
//   0x00  char[4]  chunkMagic — "CcnK" (always; identifies a VST2 preset)
//   0x04  int32    byteSize   — size of the rest (often 0 in saved files)
//   0x08  char[4]  fxMagic    — "FxCk"(reg program) "FPCh"(chunk program)
//                               "FxBk"(reg bank)   "FBCh"(chunk bank)
//   0x0C  int32    version    — 1
//   0x10  char[4]  fxID       — "OBXf"(native) / "Obxd"(legacy import)
//   0x14  int32    fxVersion
//   0x18  int32    numParams  — (numPrograms slot in fxProgramSet)
//   0x1C  char[28] prgName    — null-padded, NOT null-terminated
//   0x38  ...data:
//           FxCk: float[numParams] params (BE floats)
//           FPCh: int32 BE chunkSize + char[chunkSize]
//                   chunk may be a JUCE copyXmlToBinary blob
//                   (4-byte BE size + XML) OR the "VC2!" legacy wrapper
//                   ('VC2!' + LE uint32 xmlLen + raw UTF-8 XML) used by
//                   every native OB-Xf patch on disk today.
#define FXP_HEADER_SIZE   56    // 0x38 — fixed prefix before the variable data
#define FXP_PRGNAME_OFF   28    // 0x1C — 28-byte program name field
#define FXP_PRGNAME_LEN   28
#define FXP_DATA_OFF      56    // 0x38 — first byte of params (FxCk) / chunkSize (FPCh)
#define FXP_NUMPARAMS_OFF 24    // 0x18
#define FXP_VERSION_OFF   12    // 0x0C
#define FXP_FXID_OFF      16    // 0x10
#define FXP_FXMAGIC_OFF   8     // 0x08

static SynthEngine* g_engines[INSTANCE_COUNT] = {};
static bool  g_engine_active[INSTANCE_COUNT] = {};
static int   g_engine_polyphony[INSTANCE_COUNT] = {};
static float g_engine_rms[INSTANCE_COUNT] = {};
static bool  g_mpe_enabled[INSTANCE_COUNT] = {};   // per-instance MPE flag (T9)
static float g_sample_rate = 44100.0f;              // saved for engine recreation

// Per-instance param mirror — SynthEngine has no getter API, so we maintain
// our own copy alongside the engine state. obxd_get_param() reads from here;
// the knob UI uses it to render values after a patch load. Indexed
// [instance_id][legacy_param_idx]; values are in the LEGACY 0..1 space.
static float g_param_mirror[INSTANCE_COUNT][PARAM_COUNT] = {};

// Per-instance mirror for the 28 NEW OB-Xf params (no legacy ancestor).
// Indexed [instance_id][new_idx] where new_idx = sentinel - 200 (0..27).
// obxd_get_param() returns from here for idx >= 200 so the knob UI can
// sync NEW-param widget positions after a .fxp load.
//
// CANONICAL-ORDINAL SWITCH: new_idx is now interpreted as the CANONICAL
// ordinal of obxf_new_params[] (declaration order of streaming IDs in
// obxf_imported/parameter/SynthParam.h) — the apply path dispatches
// obxf_new_params[new_idx].apply_native. The TS UI (obxd-synth-ui.ts) still
// assigns V1 encounter-order sentinels, so UI-driven NEW-param writes land
// in different engine params than before; that inconsistency is EXPECTED
// and temporary (the next task migrates the UI + saved state to canonical
// ordinals — no compat shims here). The worklet's dump/restore
// (src/obxd-processor.tail.js) uses _obxd_get_param(i, 200+n) /
// _obxd_set_param(i, 200+n, v) POSITIONALLY over this same mirror, so it
// stays self-consistent with the C side and save/restore round-trips
// correctly within a session made after this change.
static constexpr int NEW_PARAM_COUNT = 28;
static float g_new_param_mirror[INSTANCE_COUNT][NEW_PARAM_COUNT] = {};

// The generated tables must agree with the frozen mirror sizes.
static_assert(PARAM_COUNT == OBXF_PT_LEGACY_COUNT, "legacy table/mirror size mismatch");
static_assert(NEW_PARAM_COUNT == OBXF_PT_NEW_COUNT, "new-param table/mirror size mismatch");

// OctOBX PCM: per-layer full param store (8 pads x 4 layers). Voice-level params
// are applied to each triggered voice (via dispatch_legacy_param with the engine's
// pcmVoiceOverride scoping ForEachVoice to that voice); global/structural params
// route to the live drum instance 9 via apply_param_instance. Indexed
// [pad][layer][legacy_param_idx]; values are in the LEGACY 0..1 space.
static float g_drum_layer_params[8][4][PARAM_COUNT] = {};

// OctOBX PCM: per-layer mirror for the 28 NEW OB-Xf params (no legacy ancestor).
// Indexed [pad][layer][new_idx] where new_idx = sentinel - 200 (0..27). VOICE-level
// rows are applied to each triggered voice via apply_new_param_instance; GLOBAL rows
// (UnisonVoices, VoiceReassign, VibratoWave, LFO1PW — the verified set whose processX
// setters write synth-global Motherboard state with no ForEachVoice) route live to
// instance 9, exactly like legacy drum globals (see is_global_drum_new_param).
static float g_drum_layer_new[8][4][NEW_PARAM_COUNT] = {};

// Per-instance last-loaded program name (empty until a load succeeds).
static char g_patch_name[INSTANCE_COUNT][64] = {};

// Master mix bus — every active engine's output is summed here each
// quantum, then x/(1+|x|) soft-clipped per sample.
static float g_master_l[BUF_FRAMES];
static float g_master_r[BUF_FRAMES];

// =========================================================================
// OB-Xd → OB-Xf rescale helpers (verbatim from ObxdImporter.cpp)
//
// These reimplement OB-Xd's logsc plus inverses so legacy 0..1 normalized
// values can be remapped onto the OB-Xf engine's different internal ranges.
// Kept byte-for-byte aligned with the importer so a runtime knob turn
// produces the same value an .fxp import would.
//
// NOTE: only the helpers still used by the inline LFOFREQ (17) handling in
// apply_param_instance() live here. The per-param rescales moved into the
// GENERATED obxf_apply_* / obxf_invert_* functions of param_table.h.
// =========================================================================

inline float xdLogsc(float p, float lo, float hi, float rolloff = 19.f)
{
    return ((std::exp(p * std::log(rolloff + 1.f)) - 1.f) / rolloff) * (hi - lo) + lo;
}

inline float xdInvLogsc(float y, float lo, float hi, float rolloff = 19.f)
{
    if (hi == lo)
        return 0.f;
    const float t = rolloff * (y - lo) / (hi - lo) + 1.f;
    if (t <= 0.f)
        return 0.f;
    return juce::jlimit(0.f, 1.f, std::log(t) / std::log(rolloff + 1.f));
}

// OB-Xd LFO1 sync rate (9 buckets) → OB-Xf's 21-bucket synced table.
// Mirrors ObxdImporter.cpp::mapLfoSyncedRate.
inline float mapLfoSyncedRate(float vXd)
{
    static constexpr int xdToXf[9] = {1, 4, 5, 7, 10, 11, 13, 15, 16};
    const int kXd = juce::jlimit(0, 8, static_cast<int>(vXd * 8.f));
    return static_cast<float>(xdToXf[kXd]) / 20.f; // syncedRatesCount - 1 == 20
}

// =========================================================================
// Parameter dispatch (legacy OB-Xd idx → OB-Xf processX() method)
//
// apply_param_instance() is the instance-aware dispatch. It reads
// g_engines[id], writes g_param_mirror[id] (in legacy 0..1 space), and
// calls the matching NEW SynthEngine method — through the GENERATED
// obxf_legacy_params[] / obxf_new_params[] tables (wasm/obxd/param_table.h)
// whose per-row functions carry the rescale rules documented in
// tools/PARAM_SPEC.md. Only LFOFREQ (17) and LFO_SYNC (72) stay hand-written
// inline (they read/write per-instance mirror state, which the tables
// intentionally do not encode).
// =========================================================================

static void apply_param_instance(int instance_id, int idx, float v);

static void recreate_engine(int instance_id) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    if (!g_engines[instance_id]) return;
    delete g_engines[instance_id];
    g_engines[instance_id] = new SynthEngine();
    g_engines[instance_id]->setSampleRate(g_sample_rate);
}

// Dispatch for the 28 NEW OB-Xf params (no OB-Xd legacy ancestor).
//
// The UI (obxd-synth-ui.ts) assigns these a sentinel legacy index
// NEW_PARAM_BASE (200) + ordinal. The ordinal is the CANONICAL one — the
// row index of obxf_new_params[] (declaration order of streaming IDs in
// obxf_imported/parameter/SynthParam.h, filtered to params with no legacy
// ancestor). Values are passed 1:1 to the matching processX() method with
// NO rescale (these are native OB-Xf params), via the generated table's
// apply_native fn ptr. Also used per triggered drum voice by
// apply_drum_layer_params_for_instance — signature is part of that contract.
//
// NOTE: this intentionally REPLACES the old V1 encounter-order switch (the
// UI sentinel migration to canonical ordinals follows as the next task;
// see the comment at g_new_param_mirror).
static void apply_new_param_instance(SynthEngine& s, int new_idx, float v) {
    if (new_idx >= 0 && new_idx < OBXF_PT_NEW_COUNT)
        obxf_new_params[new_idx].apply_native(s, v);
    // unknown sentinel — silently ignore
}

// Seed an instance with a sensible OB-Xf init patch by calling the NEW
// processX() methods directly (no legacy rescale — we set the values the
// NEW engine expects). Also resets the legacy mirror so the knob UI starts
// from a known state. This is the minimum-viable factory patch; real
// hand-tuned OB-Xf patches are task T10.
static void apply_defaults_for_instance(int instance_id) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    SynthEngine* e = g_engines[instance_id];
    if (!e) return;

    for (int i = 0; i < PARAM_COUNT; ++i) g_param_mirror[instance_id][i] = 0.0f;
    for (int i = 0; i < NEW_PARAM_COUNT; ++i) g_new_param_mirror[instance_id][i] = 0.0f;

    SynthEngine& s = *e;
    // Master / global
    s.processVolume(0.5f);
    s.processTune(0.5f);          // center (0 st)
    s.processTranspose(0.5f);     // center (0 st)
    s.processPolyphony(((8.f - 1.f) + 0.5f) / 32.f); // 8 voices
    s.processUnison(0.0f);
    // Oscillators / mixer
    s.processOsc1Volume(1.0f);
    s.processOsc2Volume(1.0f);
    s.processOsc1Saw(1.0f);
    s.processOsc2Saw(1.0f);
    s.processOsc2Detune(0.4f);
    s.processOsc2Keytrack(1.0f);   // ParameterList default = ON
    // Filter (open, no resonance)
    s.processFilterCutoff(1.0f);
    s.processFilterResonance(0.0f);
    // Amp env: instant attack, short decay, full sustain, short release
    s.processAmpEnvAttack(0.0f);
    s.processAmpEnvDecay(0.3f);
    s.processAmpEnvSustain(1.0f);
    s.processAmpEnvRelease(0.3f);
    // Pan — center all 8 voice slots
    for (int i = 1; i <= MAX_PANNINGS; ++i)
        s.processPan(0.5f, i);

    // Reflect those settings back into the legacy mirror so the knob UI
    // renders consistent positions after init / reset.
    g_param_mirror[instance_id][VOLUME]     = 0.5f;
    g_param_mirror[instance_id][VOICE_COUNT]= 1.0f;   // 8 voices (old max)
    for (int i = PAN1; i <= PAN8; ++i)
        g_param_mirror[instance_id][i] = 0.5f;   // center (constructor default)
    g_engine_polyphony[instance_id] = 8;
    g_param_mirror[instance_id][TUNE]       = 0.5f;
    g_param_mirror[instance_id][OCTAVE]     = 0.5f;
    g_param_mirror[instance_id][UNISON]     = 0.0f;
    g_param_mirror[instance_id][OSC1MIX]    = 1.0f;
    g_param_mirror[instance_id][OSC2MIX]    = 1.0f;
    g_param_mirror[instance_id][OSC1Saw]    = 1.0f;
    g_param_mirror[instance_id][OSC2Saw]    = 1.0f;
    g_param_mirror[instance_id][OSC2_DET]   = 0.4f;
    g_param_mirror[instance_id][CUTOFF]     = 1.0f;
    g_param_mirror[instance_id][RESONANCE]  = 0.0f;
    g_param_mirror[instance_id][LATK]       = 0.0f;
    g_param_mirror[instance_id][LDEC]       = 0.3f;
    g_param_mirror[instance_id][LSUS]       = 1.0f;
    g_param_mirror[instance_id][LREL]       = 0.3f;
}

// OctOBX PCM: classify a legacy idx as GLOBAL/STRUCTURAL — i.e. it should NOT be
// applied per triggered voice. Such params either set a synth-wide field directly
// (processVolume→synth.volume, processLFO1Rate→synth.globalLFO, processPan→
// synth.pannings, processHQMode→synth.SetHQMode + allSoundOff) or are structural
// choices routed to the whole drum instance 9 (tuning, octave, bend, polyphony,
// unison, portamento, …). Everything else is voice-level and applied per layer
// via dispatch_legacy_param (with the engine's pcmVoiceOverride scoping
// ForEachVoice to the one triggered voice).
//
// Table-backed: the classification lives in obxf_legacy_params[].drum_class
// (generated from tools/param-spec.mjs). DELIBERATE DEVIATION from the old
// hand-written switch: indices 0 (UNDEFINED) and 1 (MIDILEARN) used to return
// true here; the table classifies them DRUM_NONE. Net behavior is identical —
// rows 0/1 have no engine dispatch (apply_legacy == NULL), so the old
// global-routing call apply_param_instance(9, 0|1, v) was a no-op. The only
// observable difference is the obxd_is_global_drum_param() export, which now
// returns 0 instead of 1 for idx 0/1 (documented; nothing probes those).
static bool is_global_drum_param(int idx) {
    if (idx < 0 || idx >= PARAM_COUNT) return false;
    return obxf_legacy_params[idx].drum_class == DRUM_GLOBAL;
}

// OctOBX PCM: NEW-param (sentinel >= 200) analogue of is_global_drum_param —
// true when the canonical ordinal's processX setter writes SYNTH-GLOBAL
// Motherboard state with no ForEachVoice, so it must NOT be stamped per
// triggered voice (last-layer-applied would win on the shared field). The
// verified set (see tools/param-spec.mjs DRUM_NEW_GLOBAL_ORDINALS and the row
// evidence in obxf_imported/engine/SynthEngine.h):
//    0 UnisonVoices → synth.setUnisonVoices → Motherboard::unisonVoiceCount
//    1 VoiceReassign → synth.reallocate (Motherboard bool)
//    7 VibratoWave   → synth.vibratoLFO.par.{wave1blend,wave2blend}
//   10 LFO1PW        → synth.globalLFO.par.pw
// Every other NEW param is ForEachVoice-scoped (per-voice fields / Voice::lfo2)
// and is applied per triggered drum layer via apply_new_param_instance.
// Table-backed: obxf_new_params[n].drum_class (generated from the spec).
static bool is_global_drum_new_param(int n) {
    if (n < 0 || n >= NEW_PARAM_COUNT) return false;
    return obxf_new_params[n].drum_class == DRUM_GLOBAL;
}

// OctOBX PCM: filter cutoff/resonance/mode + amp-env params whose processX setters
// do NOT cleanly scope to a single voice via pcmVoiceOverride, and which are therefore
// applied DIRECTLY onto the triggered voice in apply_drum_layer_params_for_instance
// (v->par.filter.cutoff, v->filter.setResonance/Multimode, v->ampEnv.setAttack/Decay/
// Sustain/Release). dispatch_legacy_param must NOT be called for them on the per-voice
// path:
//   - CUTOFF/RESONANCE/MULTIMODE route to cutoffSmoother/resSmoother/filterModeSmoother
//     (synth-GLOBAL smoothers), so dispatching them per voice pollutes the shared state.
//   - LATK/LDEC/LSUS/LREL route to processAmpEnv* which, while ForEachVoice-scoped, apply
//     the OB-Xd->OB-Xf rescale baked into the generated obxf_apply_* functions; that
//     differs from the direct per-voice writes below and would overwrite the voice with
//     the wrong value.
//
// These are intentionally NOT folded into is_global_drum_param (DRUM_SMOOTHER is a
// separate class in the generated table): they are per-pad/per-layer values (each drum
// layer has its own cutoff + amp-ADSR), so they must NOT be routed live to instance 9
// (obxd_set_drum_layer_param) nor read back from g_param_mirror[9]
// (obxd_get_drum_layer_param).
static bool is_smoother_driven_drum_param(int idx) {
    if (idx < 0 || idx >= PARAM_COUNT) return false;
    return obxf_legacy_params[idx].drum_class == DRUM_SMOOTHER;
}

// OctOBX PCM: the legacy idx -> SynthEngine processX dispatch, factored out so it
// can be reused for single-voice application (with synth.pcmVoiceOverride set, which
// scopes ForEachVoice to just that one voice) WITHOUT duplicating the per-param
// transform. Does NOT touch g_param_mirror (the caller decides that).
//
// Table-backed: obxf_legacy_params[idx].apply_legacy carries the forward
// (legacy→engine) transform, generated from tools/param-spec.mjs — the bodies
// are byte-equivalent to the old ~80-case switch (pure move into the table).
// Two row kinds short-circuit before any fn-ptr call:
//   - special_inline (LFOFREQ 17 / LFO_SYNC 72): their handling reads
//     g_param_mirror / re-dispatches via apply_param_instance (instance
//     state), which contradicts this function's "no mirror access" contract;
//     the caller handles them inline. Because both are classified global by
//     is_global_drum_param, this function is never called with idx 17 or 72
//     from the per-voice path; in the normal path apply_param_instance
//     short-circuits them before delegating.
//   - apply_legacy == NULL (removed rows 1/32/70/71, sentinel row 0): no-op.
static void dispatch_legacy_param(SynthEngine& s, int idx, float v) {
    if (idx < 0 || idx >= PARAM_COUNT) return;
    if (v < 0.0f) v = 0.0f;
    if (v > 1.0f) v = 1.0f;
    const obxf_legacy_param_t& p = obxf_legacy_params[idx];
    if (p.special_inline) return;   // caller handles inline (never reached from per-voice path)
    if (!p.apply_legacy) return;    // removed / no-op row
    p.apply_legacy(s, v);
}

// Dispatch one legacy (idx, v) pair to the NEW engine. `v` is clamped to
// [0,1] and stored in the legacy mirror BEFORE the (possibly rescaled)
// call. See the file header for the full rescale rule list.
//
// The per-param work lives in dispatch_legacy_param() above, which calls
// the GENERATED obxf_legacy_params[idx].apply_legacy fn ptr. LFOFREQ (17)
// and LFO_SYNC (72) stay inline here because their bodies touch
// g_param_mirror / re-dispatch, which dispatch_legacy_param's "no mirror
// access" contract forbids (the table marks them special_inline).
static void apply_param_instance(int instance_id, int idx, float v) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    SynthEngine* e = g_engines[instance_id];
    if (!e) return;
    if (v < 0.0f) v = 0.0f;
    if (v > 1.0f) v = 1.0f;
    SynthEngine& s = *e;

    // Sentinel indices >= 200 are OB-Xf params with no legacy ancestor.
    // new_idx = idx - 200 is the CANONICAL ordinal (row of obxf_new_params[]);
    // dispatch 1:1 via the table's apply_native (no rescale) and mirror the
    // value so obxd_get_param can report it. See the comment at
    // g_new_param_mirror for the UI-sentinel mismatch note.
    if (idx >= 200) {
        int new_idx = idx - 200;
        if (new_idx >= 0 && new_idx < NEW_PARAM_COUNT)
            g_new_param_mirror[instance_id][new_idx] = v;
        apply_new_param_instance(s, new_idx, v);
        return;
    }

    if (idx < 0 || idx >= PARAM_COUNT) return;
    g_param_mirror[instance_id][idx] = v;

    // OctOBX PCM: LFOFREQ (17) reads the live LFO_SYNC mirror entry to pick the
    // synced vs free-running rate path; kept inline (needs instance_id).
    if (idx == LFOFREQ) {
        // Synced path uses the 9→21 bucket map; consult the live mirror
        // for LFO_SYNC. (During a sequential .fxp load, LFO_SYNC may not yet
        // be set when LFOFREQ is dispatched — resolved after the load by
        // resolve_lfo_sync_dependency(), see load_fxp_data.)
        if (g_param_mirror[instance_id][LFO_SYNC] > 0.5f) {
            s.processLFO1Rate(mapLfoSyncedRate(v));
        } else {
            float hzXd = xdLogsc(v, 0.f, 50.f, 120.f);
            s.processLFO1Rate(xdInvLogsc(hzXd, 0.f, 250.f, 3775.f));
        }
        return;
    }
    // OctOBX PCM: LFO_SYNC (72) re-dispatches LFOFREQ now that sync state is known
    // (legacy .fxp loads dispatch params sequentially 0..79, so LFOFREQ at 17 was
    // processed with a stale sync). Kept inline (re-dispatch needs instance_id).
    // NOTE: this re-dispatch applies the LEGACY-space transform to the mirrored
    // LFOFREQ value; the native named-attribute path never re-dispatches per
    // attribute — its ordering is fixed once, after the whole patch, by
    // resolve_lfo_sync_dependency().
    if (idx == LFO_SYNC) {
        s.processLFO1Sync(v);
        apply_param_instance(instance_id, LFOFREQ, g_param_mirror[instance_id][LFOFREQ]);
        return;
    }

    dispatch_legacy_param(s, idx, v);
}

// OctOBX PCM: seed every pad/layer slot in the per-layer param store with the same
// sensible defaults apply_defaults_for_instance() writes to g_param_mirror, so a
// freshly-initialised drum layer sounds like the OB-Xf init patch. Called once from
// obxd_init(). The new-param store is already zero-initialized (= {} above), which
// matches apply_defaults_for_instance leaving g_new_param_mirror at 0.
static void seed_drum_layer_defaults() {
    for (int pad = 0; pad < 8; ++pad) {
        for (int layer = 0; layer < 4; ++layer) {
            for (int i = 0; i < PARAM_COUNT; ++i)
                g_drum_layer_params[pad][layer][i] = 0.0f;
            // Mirror the key defaults from apply_defaults_for_instance()'s mirror writes:
            g_drum_layer_params[pad][layer][VOLUME]     = 0.5f;
            g_drum_layer_params[pad][layer][VOICE_COUNT]= 1.0f;   // 8 voices (old max)
            g_drum_layer_params[pad][layer][TUNE]       = 0.5f;
            g_drum_layer_params[pad][layer][OCTAVE]     = 0.5f;
            g_drum_layer_params[pad][layer][UNISON]     = 0.0f;
            g_drum_layer_params[pad][layer][OSC1MIX]    = 0.0f;   // OctOBX PCM: silence osc for drum voices
            g_drum_layer_params[pad][layer][OSC2MIX]    = 0.0f;
            g_drum_layer_params[pad][layer][OSC1Saw]    = 1.0f;
            g_drum_layer_params[pad][layer][OSC2Saw]    = 1.0f;
            g_drum_layer_params[pad][layer][OSC2_DET]   = 0.4f;
            g_drum_layer_params[pad][layer][CUTOFF]     = 1.0f;
            g_drum_layer_params[pad][layer][RESONANCE]  = 0.0f;
            g_drum_layer_params[pad][layer][LATK]       = 0.0f;
            g_drum_layer_params[pad][layer][LDEC]       = 0.3f;
            g_drum_layer_params[pad][layer][LSUS]       = 1.0f;
            g_drum_layer_params[pad][layer][LREL]       = 0.3f;
            for (int i = PAN1; i <= PAN8; ++i)
                g_drum_layer_params[pad][layer][i] = 0.5f;   // center (constructor default)
        }
    }
}

// OctOBX PCM: after a drum note-on (assignPcmLayer set pcmNeedsParams=true on each
// triggered PCM voice), stamp every such voice with its layer's full param set.
//
// For each freshly-triggered voice we scope the engine's ForEachVoice to that single
// voice via Motherboard::pcmVoiceOverride, then run every voice-level legacy param
// through dispatch_legacy_param (which therefore stamps only this voice) plus the
// voice-level NEW params via apply_new_param_instance. Global/structural params —
// legacy AND NEW — are skipped here (they are routed to the live instance 9 once,
// via apply_param_instance, by obxd_set_drum_layer_param).
//
// NEW-param classification (idx >= 200) is per the generated drum_class column:
// the four verified synth-globals (UnisonVoices, VoiceReassign, VibratoWave,
// LFO1PW — setters that write Motherboard state with no ForEachVoice) are
// DRUM_GLOBAL and never applied per voice; the other 24 are ForEachVoice-scoped
// and stamp only this voice like any legacy voice-level row.
static void apply_drum_layer_params_for_instance(int instance_id) {
    SynthEngine* e = (instance_id >= 0 && instance_id < INSTANCE_COUNT) ? g_engines[instance_id] : nullptr;
    if (!e) return;
    Motherboard* mb = e->getMotherboard();
    if (!mb) return;
    for (int i = 0; i < MAX_VOICES; i++) {
        Voice* v = &mb->voices[i];
        if (!v->pcmActive || !v->pcmNeedsParams) continue;
        v->pcmNeedsParams = false;
        int pad = v->pcmPadId, layer = v->pcmLayerId;
        if (pad < 0 || pad >= 8 || layer < 0 || layer >= 4) continue;
        mb->pcmVoiceOverride = v;   // scope ForEachVoice to this voice only
        for (int idx = 0; idx < PARAM_COUNT; idx++) {
            if (is_global_drum_param(idx)) continue;   // globals handled via instance routing
            if (is_smoother_driven_drum_param(idx)) continue;  // applied directly per-voice below (avoids global-smoother pollution)
            dispatch_legacy_param(*e, idx, g_drum_layer_params[pad][layer][idx]);
        }
        for (int n = 0; n < NEW_PARAM_COUNT; n++) {
            if (is_global_drum_new_param(n)) continue;  // NEW globals handled via instance routing
            apply_new_param_instance(*e, n, g_drum_layer_new[pad][layer][n]);
        }
        // Smoother-driven filter params + amp env are NOT applied by dispatch_legacy_param
        // (their processX set engine smoothers, not the voice) — set them directly from the
        // mirror so the editor's Cutoff/Reso/Mode + Amp-ADSR knobs reach this voice.
        v->par.filter.cutoff = g_drum_layer_params[pad][layer][CUTOFF] * 120.f;  // linsc(cutoff, 0, 120)
        v->filter.setResonance(0.991f - logsc(1.f - g_drum_layer_params[pad][layer][RESONANCE], 0.f, 0.991f, 40.f));
        v->filter.setMultimode(g_drum_layer_params[pad][layer][MULTIMODE]);
        v->ampEnv.setAttack(logsc(g_drum_layer_params[pad][layer][LATK], 4.f, 60000.f, 900.f));
        v->ampEnv.setDecay(logsc(g_drum_layer_params[pad][layer][LDEC], 4.f, 60000.f, 900.f));
        v->ampEnv.setSustain(g_drum_layer_params[pad][layer][LSUS]);
        v->ampEnv.setRelease(logsc(g_drum_layer_params[pad][layer][LREL], 8.f, 60000.f, 900.f));
        mb->pcmVoiceOverride = nullptr;
    }
}

// =========================================================================
// Named-attribute dispatch (native OB-Xf XML schema → processX())
//
// Native OB-Xf .fxp files serialize parameters by their SynthParam::ID
// STREAMING name (see obxf_imported/parameter/SynthParam.h): e.g.
// `Volume="0.5"`, `FilterCutoff="0.26"`, `PitchBendUp="0.0417"`. These are
// already native engine normalized 0..1 values, so they map 1:1 onto the
// matching processX() method with NO rescale — unlike the legacy integer
// dispatch above, which must undo OB-Xd's different internal ranges.
//
// apply_named_param_instance() is the per-attribute entry point used by
// parse_chunk_xml_named(). It looks the name up ONCE in the GENERATED
// sorted name index (obxf_param_name_find — binary search over the 104
// streaming names) and:
//   - dispatches via entry->native_apply (a DIRECT 1:1 processX() call,
//     no rescale — native values, exactly like the old else-if chain);
//   - writes g_param_mirror for legacy-mapped params so the knob UI syncs
//     after a patch load — mapped through entry->invert (native→legacy).
//     BEHAVIOR FIX vs the old chain, which stored the RAW native value:
//     for the 14 rescaled params (OCTAVE/Transpose, BENDRANGE, LATK/FATK,
//     XMOD, PW_ENV, …) the raw native value put engine-space numbers into
//     legacy-mirrored knobs, so grabbing such a knob after a patch load
//     caused a jump. invert() maps back to legacy space first; for the 1:1
//     params invert is identity so nothing changes there. The ONLY
//     legacy-mapped names without an invert are the two special_inline
//     rows (LFO1Rate→17, LFO1TempoSync→72) — their inverse is
//     sync-state-dependent, so the raw value is stored (as before);
//   - mirrors NEW params (no legacy ancestor) into g_new_param_mirror at
//     their CANONICAL ordinal (entry->new_ordinal), matching the sentinel
//     dispatch space — see the comment at g_new_param_mirror.
// =========================================================================

static void apply_named_param_instance(int instance_id, const char* name, int nlen, float v) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    SynthEngine* e = g_engines[instance_id];
    if (!e) return;
    if (!name || nlen <= 0) return;
    if (v < 0.0f) v = 0.0f;
    if (v > 1.0f) v = 1.0f;
    SynthEngine& s = *e;

    // One binary search replaces the ~150-branch else-if chain, the
    // obxf_param_mappings.h reverse lookup, and the new_param_names[] table.
    // Unknown names (metadata attributes like programName/author/category/
    // license/voiceCount/ob-xf_version) return NULL and are ignored, as
    // before.
    const obxf_param_name_entry_t* entry = obxf_param_name_find(name, nlen);
    if (!entry) return;

    // Mirror NEW params (no legacy ancestor) into g_new_param_mirror at the
    // CANONICAL ordinal so the knob UI can sync their widget positions too
    // (same ordinal space as the sentinel dispatch — see g_new_param_mirror).
    if (entry->new_ordinal >= 0 && entry->new_ordinal < NEW_PARAM_COUNT) {
        g_new_param_mirror[instance_id][entry->new_ordinal] = v;
    }

    // Mirror legacy-indexed params so the knob UI syncs correctly after a
    // native OB-Xf .fxp load (syncObxdControlsFromEngine reads g_param_mirror).
    // INVERT FIX: store the LEGACY-space value (entry->invert maps
    // native→legacy). The old code stored the raw native value, which put
    // engine-space numbers into legacy knobs for the 14 rescaled params.
    // invert is NULL only for the two special_inline names (LFO1Rate /
    // LFO1TempoSync, whose inverse is sync-state-dependent) — those keep
    // the old raw storage.
    if (entry->legacy_index >= 0 && entry->legacy_index < PARAM_COUNT) {
        g_param_mirror[instance_id][entry->legacy_index] =
            entry->invert ? entry->invert(v) : v;
    }

    // Direct 1:1 engine call for this streaming name (native space, no
    // rescale). For "LFO1TempoSync" this is processLFO1Sync(v) — the
    // LEGACY-path LFOFREQ re-dispatch does NOT happen per attribute (the
    // old chain never did that); the load-ordering fix lives in
    // resolve_lfo_sync_dependency() after the whole patch is applied.
    entry->native_apply(s, v);
}

// =========================================================================
// .fxp (VST2 preset) loading — instance-aware
//
// Format (Steinberg VST2 preset spec — fxProgramSet, all ints/floats BE):
//
//   0x00  char[4]  chunkMagic — "CcnK" (every VST2 preset, regular or chunk)
//   0x08  char[4]  fxMagic    — "FxCk"(regular) / "FPCh"(chunk program) /
//                               "FBCh"(chunk bank)
//   0x10  char[4]  fxID       — "OBXf" (native OB-Xf) or "Obxd" (legacy)
//   0x18  int32    numParams
//   0x1C  char[28] prgName    — null-padded, NOT null-terminated
//   0x38  data:
//           FxCk: float[numParams] params (BE floats) — legacy regular form
//           FPCh: int32 BE chunkSize + char[chunkSize]
//                   The chunk is one of:
//                   • "VC2!" + LE uint32 xmlLen + raw UTF-8 XML
//                     (the ONLY form native OB-Xf patches ship in today —
//                      see wasm/obxd/patches/*.fxp, all CC0/Public Domain)
//                   • JUCE copyXmlToBinary blob (4-byte BE size + XML)
//                     (older JUCE-saved OB-Xd chunks)
//
// The XML payload itself comes in two attribute schemas:
//   • Native OB-Xf NAMED attributes: `Volume="0.5" FilterCutoff="0.26" ...`
//     (SynthParam::ID streaming names). These are native engine values and
//     are dispatched 1:1 to processX() methods with NO rescaling, via
//     apply_named_param_instance(). This is what the factory patches use.
//   • Legacy OB-Xd INTEGER attributes: bare `0="0.5"` or `Val_<k>="..."`.
//     These are legacy 0..1 values dispatched through apply_param_instance()
//     (which applies the OB-Xd→OB-Xf rescales). Kept as a fallback so the
//     file picker still loads old OB-Xd .fxp exports.
//
// Bank chunks (FBCh) carry <programs><program/>...; we use the FIRST program
// (or the currentProgram-indexed one) only.
//
// SECURITY (XXE): the XML chunk is parsed by hand-rolled char-by-char scanners
// (parse_chunk_xml_instance / parse_chunk_xml_named), NOT by a real XML parser.
// No DTD processing, no entity expansion, no external entity resolution occurs.
// This makes XXE (XML External Entity) attacks impossible by construction.
// (ObxdImporter.cpp's juce::XmlDocument::parse is compiled into the TU for
// linker-symbol satisfaction but is never called at runtime.)
// =========================================================================

static inline uint32_t rd_be_u32(const uint8_t* p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8)  |  (uint32_t)p[3];
}

// Big-endian IEEE-754 float — reinterpret the BE-ordered bytes as a
// uint32, then bit-cast to float. Valid on any little-endian host
// (incl. wasm32) because we manually assemble the integer.
static inline float rd_be_f32(const uint8_t* p) {
    uint32_t u = rd_be_u32(p);
    float f;
    __builtin_memcpy(&f, &u, sizeof(f));
    return f;
}

// Copy up to n-1 bytes from src (length src_len, NOT null-terminated)
// into a fixed buffer and null-terminate. Used for the prgName field.
static void copy_name(char* dst, const uint8_t* src, int src_len, size_t n) {
    if (n == 0) return;
    size_t i = 0;
    size_t cap = (size_t)src_len < (n - 1) ? (size_t)src_len : (n - 1);
    for (; i < cap; ++i) {
        char c = (char)src[i];
        if (c == 0) break;
        dst[i] = c;
    }
    dst[i] = '\0';
}

// Apply at most PARAM_COUNT floats from a regular (non-chunk) data
// section to the given instance. Returns the number of parameters applied.
static int apply_regular_params_instance(int instance_id, const uint8_t* data, int data_len, int num_params) {
    if (num_params < 0) num_params = 0;
    if (num_params > PARAM_COUNT) num_params = PARAM_COUNT;
    int applied = 0;
    for (int i = 0; i < num_params; ++i) {
        int off = i * 4;
        if (off + 4 > data_len) break;
        float v = rd_be_f32(data + off);
        apply_param_instance(instance_id, i, v);
        ++applied;
    }
    return applied;
}

// Parse JUCE-flavoured XML chunk for Obxd parameter values, applying
// each parsed value to instance `instance_id`. Accepts both the legacy
// bare-integer attribute schema (`0="0.5"`) and the newer `Val_<k>`
// schema. Returns the number of (idx,value) pairs successfully applied.
static int parse_chunk_xml_instance(int instance_id, const char* xml, int xml_len) {
    int applied = 0;
    int i = 0;
    while (i < xml_len) {
        char c = xml[i];
        // Cheap `</program>` detection — bail out so a bank chunk only
        // applies its first program.
        if (c == '<' && i + 9 <= xml_len) {
            if (xml[i+1] == '/' &&
                xml[i+2] == 'p' && xml[i+3] == 'r' && xml[i+4] == 'o' &&
                xml[i+5] == 'g' && xml[i+6] == 'r' && xml[i+7] == 'a' &&
                xml[i+8] == 'm') {
                break;
            }
        }

        // Attribute names we care about are either a bare digit run
        // (legacy `0="..."`) or `Val_<digits>`. Look for either.
        bool isVal = (c == 'V' && i + 4 <= xml_len &&
                      xml[i+1] == 'a' && xml[i+2] == 'l' && xml[i+3] == '_');
        bool isDigit = (c >= '0' && c <= '9');
        if (!isVal && !isDigit) { ++i; continue; }

        int j = i;
        if (isVal) {
            j += 4; // skip "Val_"
        }
        // Parse integer attribute name.
        int idx = 0;
        while (j < xml_len && xml[j] >= '0' && xml[j] <= '9') {
            idx = idx * 10 + (xml[j] - '0');
            if (idx >= 100000) { idx = 100000; break; }
            ++j;
        }
        // Skip whitespace before `=`.
        while (j < xml_len && (xml[j] == ' ' || xml[j] == '\t')) ++j;
        if (j >= xml_len || xml[j] != '=') { i = (isVal ? j : j); continue; }
        ++j;  // consume '='
        while (j < xml_len && (xml[j] == ' ' || xml[j] == '\t')) ++j;
        if (j >= xml_len) break;
        char quote = xml[j];
        if (quote != '"' && quote != '\'') { i = j; continue; }
        ++j;  // consume opening quote

        // Parse float value until matching quote.
        int val_start = j;
        while (j < xml_len && xml[j] != quote) ++j;
        if (j >= xml_len) break;
        int val_len = j - val_start;
        ++j;  // consume closing quote

        if (idx >= 0 && idx < PARAM_COUNT && val_len > 0 && val_len < 31) {
            char buf[32];
            __builtin_memcpy(buf, xml + val_start, (size_t)val_len);
            buf[val_len] = '\0';
            char* endp = nullptr;
            double dv = strtod(buf, &endp);
            if (endp != buf) {
                apply_param_instance(instance_id, idx, (float)dv);
                ++applied;
            }
        }

        i = j;
    }
    return applied;
}

// Parse XML chunk for native OB-Xf NAMED attributes (`Volume="0.5"` etc.),
// dispatching each via apply_named_param_instance() (1:1, no rescale). This
// is the schema every shipped factory patch uses (see SynthParam::ID
// streaming names). Stops at `</program>` so a bank chunk only applies its
// first/current program. Returns the number of (name,value) pairs applied.
static int parse_chunk_xml_named(int instance_id, const char* xml, int xml_len) {
    int applied = 0;
    int i = 0;
    while (i < xml_len) {
        char c = xml[i];
        // Cheap `</program>` detection — bail out so a bank chunk only
        // applies its first program.
        if (c == '<' && i + 9 <= xml_len) {
            if (xml[i+1] == '/' &&
                xml[i+2] == 'p' && xml[i+3] == 'r' && xml[i+4] == 'o' &&
                xml[i+5] == 'g' && xml[i+6] == 'r' && xml[i+7] == 'a' &&
                xml[i+8] == 'm') {
                break;
            }
        }

        // Attribute names start with an ASCII letter ([A-Za-z]); the OB-Xf
        // streaming names continue with [A-Za-z0-9]. Anything else cannot be
        // a named attribute we care about (tags, digits = legacy schema).
        bool isAlpha = ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'));
        if (!isAlpha) { ++i; continue; }

        int j = i;
        while (j < xml_len) {
            char d = xml[j];
            if ((d >= 'A' && d <= 'Z') || (d >= 'a' && d <= 'z') ||
                (d >= '0' && d <= '9')) {
                ++j;
            } else break;
        }
        int name_start = i;
        int name_len = j - i;
        if (name_len >= 48) { i = j; continue; } // absurd; skip

        // Skip whitespace before '='.
        while (j < xml_len && (xml[j] == ' ' || xml[j] == '\t')) ++j;
        if (j >= xml_len || xml[j] != '=') { i = (j > i ? j : i + 1); continue; }
        ++j;  // consume '='
        while (j < xml_len && (xml[j] == ' ' || xml[j] == '\t')) ++j;
        if (j >= xml_len) break;
        char quote = xml[j];
        if (quote != '"' && quote != '\'') { i = j; continue; }
        ++j;  // consume opening quote

        int val_start = j;
        while (j < xml_len && xml[j] != quote) ++j;
        if (j >= xml_len) break;
        int val_len = j - val_start;
        ++j;  // consume closing quote

        if (val_len > 0 && val_len < 31) {
            char buf[32];
            __builtin_memcpy(buf, xml + val_start, (size_t)val_len);
            buf[val_len] = '\0';
            char* endp = nullptr;
            double dv = strtod(buf, &endp);
            if (endp != buf) {
                apply_named_param_instance(instance_id, xml + name_start, name_len, (float)dv);
                ++applied;
            }
        }

        i = j;
    }
    return applied;
}

// LFOFREQ/LFO_SYNC load-ordering dependency resolve (bug fix).
//
// Both .fxp schemas apply parameters SEQUENTIALLY, and LFOFREQ (17) reads
// the LFO_SYNC (72) mirror entry to pick the synced vs free-running rate
// path — so whenever the file's sync flag lands AFTER the rate (the legacy
// integer schema always dispatches 17 before 72; the native named schema
// typically serializes LFO1TempoSync before LFO1Rate), the rate was
// processed with a STALE sync state. Previously a documented known
// limitation; now fixed by re-dispatching LFO_SYNC from the mirror AFTER
// the whole patch is applied: apply_param_instance(LFO_SYNC) re-applies
// processLFO1Sync (idempotent) and then re-dispatches LFOFREQ from
// mirror[17] with the now-final sync state. Mirror values are unchanged
// (each write stores the same mirrored value back); only the engine's
// LFO1 rate is recomputed. NOTE for the native named schema: mirror[17]
// holds the RAW native LFO1Rate (the special_inline rows have no invert),
// so the re-derived rate passes through the legacy-space transform — this
// is the intended post-load normalization semantic for LFO1.
static void resolve_lfo_sync_dependency(int instance_id) {
    apply_param_instance(instance_id, LFO_SYNC,
                         g_param_mirror[instance_id][LFO_SYNC]);
}

// Core loader for a parsed .fxp byte stream. Writes its program name
// into g_patch_name[instance_id]. Returns 0 on success, negative on
// error (see obxd_load_fxp for the rc meaning table).
static int load_fxp_data(int instance_id, const uint8_t* ptr, int len) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return -2;
    if (!g_engines[instance_id]) return -3;
    if (!ptr || len < FXP_HEADER_SIZE) return -4;

    g_patch_name[instance_id][0] = '\0';

    // chunkMagic MUST be "CcnK" (the only valid VST2 preset magic).
    if (!(ptr[0] == 'C' && ptr[1] == 'c' && ptr[2] == 'n' && ptr[3] == 'K'))
        return -5;

    // fxMagic at 0x08 selects regular vs chunk form.
    bool is_regular = (ptr[FXP_FXMAGIC_OFF+0] == 'F' && ptr[FXP_FXMAGIC_OFF+1] == 'x' &&
                       ptr[FXP_FXMAGIC_OFF+2] == 'C' && ptr[FXP_FXMAGIC_OFF+3] == 'k');
    bool is_chunk   = (ptr[FXP_FXMAGIC_OFF+0] == 'F' && ptr[FXP_FXMAGIC_OFF+1] == 'P' &&
                       ptr[FXP_FXMAGIC_OFF+2] == 'C' && ptr[FXP_FXMAGIC_OFF+3] == 'h') ||
                      (ptr[FXP_FXMAGIC_OFF+0] == 'F' && ptr[FXP_FXMAGIC_OFF+1] == 'B' &&
                       ptr[FXP_FXMAGIC_OFF+2] == 'C' && ptr[FXP_FXMAGIC_OFF+3] == 'h');
    if (!is_regular && !is_chunk) return -6;

    int num_params = (int)rd_be_u32(ptr + FXP_NUMPARAMS_OFF);
    (void)num_params;

    copy_name(g_patch_name[instance_id], ptr + FXP_PRGNAME_OFF, FXP_PRGNAME_LEN,
              sizeof(g_patch_name[instance_id]));
    if (g_patch_name[instance_id][0] == '\0') {
        __builtin_memcpy(g_patch_name[instance_id], "(unnamed)", 10);
    }

    const uint8_t* data = ptr + FXP_DATA_OFF;
    int data_len = len - FXP_DATA_OFF;
    if (data_len < 0) return -7;

    if (is_regular) {
        // FxCk: float[numParams] params, no chunk wrapper.
        int applied = apply_regular_params_instance(instance_id, data, data_len, num_params);
        if (applied == 0) {
            g_patch_name[instance_id][0] = '\0';
            return -8;
        }
        resolve_lfo_sync_dependency(instance_id);
        return 0;
    }

    // Chunk (FPCh program / FBCh bank): int32 BE chunkSize at data[0..3],
    // then chunk bytes.
    if (data_len < 12) { g_patch_name[instance_id][0] = '\0'; return -9; }
    int chunk_size = (int)rd_be_u32(data);
    if (chunk_size < 4 || chunk_size > data_len - 4) {
        g_patch_name[instance_id][0] = '\0';
        return -10;
    }

    const uint8_t* chunk = data + 4;
    const char* xml = nullptr;
    int xml_len = 0;

    if (chunk_size >= 8 && chunk[0] == 'V' && chunk[1] == 'C' &&
        chunk[2] == '2' && chunk[3] == '!') {
        // OB-Xf native "VC2!" wrapper: 4-byte magic + LE uint32 xmlLen +
        // raw UTF-8 XML. This is what every shipped OB-Xf patch uses.
        uint32_t xml_len_le;
        __builtin_memcpy(&xml_len_le, chunk + 4, 4);
        xml_len = (int)xml_len_le;
        if (xml_len < 0 || xml_len > chunk_size - 8) {
            g_patch_name[instance_id][0] = '\0';
            return -11;
        }
        xml = (const char*)(chunk + 8);
    } else {
        // JUCE copyXmlToBinary blob: 4-byte BE size prefix + XML text.
        // Used by older JUCE-saved OB-Xd chunks.
        xml = (const char*)(chunk + 4);
        xml_len = chunk_size - 4;
    }
    if (xml_len <= 0) { g_patch_name[instance_id][0] = '\0'; return -12; }

    // Try native OB-Xf named attributes first (factory patches); fall back
    // to the legacy OB-Xd integer schema (old .fxp exports via file picker).
    int applied = parse_chunk_xml_named(instance_id, xml, xml_len);
    if (applied == 0) {
        applied = parse_chunk_xml_instance(instance_id, xml, xml_len);
    }
    if (applied == 0) {
        g_patch_name[instance_id][0] = '\0';
        return -13;
    }
    resolve_lfo_sync_dependency(instance_id);
    return 0;
}

// Copy a program name (NUL-terminated) into g_patch_name[id], clamped.
// Only referenced by the programmatic-init fallback branch of
// obxd_set_factory_patch (HAS_FACTORY_FXP == 0); guarded so the
// real-patch build stays warning-free.
#if !HAS_FACTORY_FXP
static void set_patch_name(int instance_id, const char* name) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    char* dst = g_patch_name[instance_id];
    size_t cap = sizeof(g_patch_name[instance_id]) - 1;
    size_t i = 0;
    for (; i < cap && name && name[i]; ++i) dst[i] = name[i];
    dst[i] = '\0';
}
#endif

#if HAS_FACTORY_FXP
// The lookup tables (g_factory_patches[], g_factory_patch_sizes[],
// g_factory_patch_names[], g_factory_patch_categories[],
// FACTORY_PATCH_COUNT) are now auto-generated in patches.h by build.sh.
// No manual editing needed when patches are added or removed.
#endif

// =========================================================================
// C exports (consumed by the AudioWorkletProcessor tail)
// =========================================================================

extern "C" {

// Forward declarations — obxd_init() calls these before their definitions
// appear below; C++ requires them to be in scope at the call site.
EMSCRIPTEN_KEEPALIVE void obxd_set_factory_patch(int instance_id, int patch_id);
EMSCRIPTEN_KEEPALIVE void obxd_set_polyphony(int instance_id, int voice_count);
EMSCRIPTEN_KEEPALIVE int obxd_get_factory_patch_count(void);
EMSCRIPTEN_KEEPALIVE const char* obxd_get_factory_patch_name(int patch_id);
EMSCRIPTEN_KEEPALIVE const char* obxd_get_factory_patch_category(int patch_id);

// Creates all 10 SynthEngine instances, applies the OB-Xf init patch to
// each, and seeds default polyphony (instance 0 polyphonic 8 voices, rest
// mono). Idempotent — frees any prior instances first.
EMSCRIPTEN_KEEPALIVE
void obxd_init(int sample_rate) {
    float sr = sample_rate ? (float)sample_rate : 44100.0f;
    g_sample_rate = sr;
    for (int i = 0; i < INSTANCE_COUNT; ++i) {
        if (g_engines[i]) { delete g_engines[i]; g_engines[i] = nullptr; }
        g_engines[i] = new SynthEngine();
        g_engines[i]->setSampleRate(sr);
        for (int p = 0; p < PARAM_COUNT; ++p) g_param_mirror[i][p] = 0.0f;
        for (int p = 0; p < NEW_PARAM_COUNT; ++p) g_new_param_mirror[i][p] = 0.0f;
        g_patch_name[i][0] = '\0';
        g_mpe_enabled[i] = false;
        apply_defaults_for_instance(i);
        obxd_set_factory_patch(i, i);   // init patch (or real .fxp if present)
        g_engine_active[i] = true;
    }
    // Default polyphony: instance 0 = 8 voices, others = 1 voice (mono).
    obxd_set_polyphony(0, 8);
    for (int i = 1; i < INSTANCE_COUNT; ++i) obxd_set_polyphony(i, 1);
    // OctOBX PCM: instance 9 is the dedicated drum instance — give it the full
    // 32-voice budget (8 pads × 4 layers = MAX_VOICES) so layers can sound at once.
    obxd_set_polyphony(9, MAX_VOICES);
    // OctOBX PCM: one-time seed of the per-layer param store (8 pads × 4 layers)
    // so fresh drum layers start from the OB-Xf init defaults.
    seed_drum_layer_defaults();
}

// Render `n` samples into the master stereo buffer. The AudioWorklet
// calls this with n=128 each quantum, then copies the first 128 frames
// out via HEAPF32. Every active engine is summed sample-by-sample, and
// the master bus is run through x/(1+|x|) per-sample soft-clip so 10
// summed voices can never exceed ±1.0 at the output. Per-instance RMS
// is updated during this pass for the meter UI.
EMSCRIPTEN_KEEPALIVE
void obxd_render(int n) {
    if (n < 0) n = 0;
    if (n > BUF_FRAMES) n = BUF_FRAMES;

    memset(g_master_l, 0, (size_t)n * sizeof(float));
    memset(g_master_r, 0, (size_t)n * sizeof(float));

    float tmp_l, tmp_r;
    for (int e = 0; e < INSTANCE_COUNT; ++e) {
        if (!g_engines[e] || !g_engine_active[e]) {
            g_engine_rms[e] = 0.0f;
            continue;
        }
        float sum_sq = 0.0f;
        for (int i = 0; i < n; ++i) {
            g_engines[e]->processSample(&tmp_l, &tmp_r);
            g_master_l[i] += tmp_l;
            g_master_r[i] += tmp_r;
            sum_sq += tmp_l * tmp_l + tmp_r * tmp_r;
        }
        g_engine_rms[e] = sqrtf(sum_sq / (2.0f * (float)n));
    }

    // Soft-clip master bus — x/(1+|x|). Asymptotes at ±1.0 so the summed
    // output never hard-clips even when all 10 instances peak together.
    for (int i = 0; i < n; ++i) {
        g_master_l[i] = g_master_l[i] / (1.0f + fabsf(g_master_l[i]));
        g_master_r[i] = g_master_r[i] / (1.0f + fabsf(g_master_r[i]));
    }
}

EMSCRIPTEN_KEEPALIVE
float* get_buf_l_ptr(void) { return g_master_l; }

EMSCRIPTEN_KEEPALIVE
float* get_buf_r_ptr(void) { return g_master_r; }

// 0 = silence this instance (still updated to rms=0). 1 = render it.
EMSCRIPTEN_KEEPALIVE
void obxd_set_active(int instance_id, int active) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    g_engine_active[instance_id] = (active != 0);
}

EMSCRIPTEN_KEEPALIVE
int obxd_get_active(int instance_id) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return 0;
    return g_engine_active[instance_id] ? 1 : 0;
}

// OB-Xf processPolyphony(v) gives 1 + (int)(v * MAX_VOICES) voices,
// MAX_VOICES = 32. For a desired integer voice_count in [1,32] the
// bucket-midpoint normalized value is (voice_count-1+0.5)/32. We mirror
// the int in g_engine_polyphony[id] for obxd_get_polyphony and keep a
// legacy-scale mirror entry so the knob UI stays consistent.
EMSCRIPTEN_KEEPALIVE
void obxd_set_polyphony(int instance_id, int voice_count) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    if (voice_count < 1) voice_count = 1;
    if (voice_count > MAX_VOICES) voice_count = MAX_VOICES;
    g_engine_polyphony[instance_id] = voice_count;
    if (g_engines[instance_id]) {
        float v_new = ((float)(voice_count - 1) + 0.5f) / (float)MAX_VOICES;
        g_engines[instance_id]->processPolyphony(v_new);
    }
    // Legacy mirror (old 1..8 scale, clamped) for UI consistency.
    float v_legacy = (float)(voice_count - 1) / 7.0f;
    if (v_legacy > 1.0f) v_legacy = 1.0f;
    g_param_mirror[instance_id][VOICE_COUNT] = v_legacy;
}

EMSCRIPTEN_KEEPALIVE
int obxd_get_polyphony(int instance_id) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return 0;
    return g_engine_polyphony[instance_id];
}

// Per-instance gain via processVolume. The worklet's gain slider still
// pre-multiplies by 0.4 (so the slider's max isn't deafening) — we keep
// that scaling in the worklet, not here.
EMSCRIPTEN_KEEPALIVE
void obxd_set_gain(int instance_id, double gain) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    if (gain < 0.0) gain = 0.0;
    if (gain > 1.0) gain = 1.0;
    apply_param_instance(instance_id, VOLUME, (float)gain);
}

// Synchronous MIDI message handler for one instance. Called from the
// worklet between renders. Sample-accurate scheduling is intentionally
// not implemented — the worklet drains at 128-sample boundaries.
//
// OB-Xf note handlers are channel-aware (MPE). When g_mpe_enabled[id] is
// set, the status byte's low nibble is forwarded so the engine tracks
// per-channel note signatures. Otherwise channel 0 is used (non-MPE).
//
// Status byte high nibble routing per the GM standard; we drop all
// system-common / system-real-time bytes (>=0xF0).
EMSCRIPTEN_KEEPALIVE
void obxd_midi_in(int instance_id, uint8_t status, uint8_t d1, uint8_t d2) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    SynthEngine* e = g_engines[instance_id];
    if (!e) return;
    if (status >= 0xF0) return;   // active sensing, clock, sysex, reset, etc.

    // Channel arg: when MPE is enabled for this instance, forward the
    // status byte's low nibble so the OB-Xf engine tracks per-channel
    // note signatures (processNoteOn/Off are channel-aware). Otherwise
    // pass 0 (the OB-Xf engine treats channel 0 as the global channel).
    const int8_t channel = g_mpe_enabled[instance_id] ? (status & 0x0F) : 0;
    SynthEngine& s = *e;
    switch (status & 0xF0) {
        case 0x80:  // Note off
            s.processNoteOff(d1 & 0x7F, (d2 & 0x7F) / 127.0f, channel);
            break;
        case 0x90:  // Note on; velocity 0 is interpreted as note-off
            if (d2 == 0) {
                s.processNoteOff(d1 & 0x7F, 0.0f, channel);
            } else {
                s.processNoteOn(d1 & 0x7F, (d2 & 0x7F) / 127.0f, channel);
                // OctOBX PCM: instance 9 is the dedicated drum instance. After a note-on
                // the engine's setNoteOn/assignPcmLayer has marked each triggered PCM voice
                // (pcmNeedsParams=true); stamp each with its full per-layer param store now.
                if (instance_id == 9) apply_drum_layer_params_for_instance(9);
            }
            break;
        case 0xB0:  // CC
            switch (d1 & 0x7F) {
                case 1:    s.processModWheel((d2 & 0x7F) / 127.0f); break;
                case 64:   if (d2 >= 64) s.sustainOn(); else s.sustainOff(); break;
                case 74:   // MPE timbre (CC 74) — engine wants 0..1 normalized,
                           // mapped onto the Slide matrix source. Routed
                           // per-channel ONLY in MPE mode; CC 74 is a normal
                           // channel control otherwise and the legacy OB-Xd
                           // engine had no CC 74 handling, so in non-MPE mode
                           // it stays ignored (preserving old behavior).
                           if (g_mpe_enabled[instance_id])
                               s.processMPETimbre(channel, (d2 & 0x7F) / 127.0f);
                           break;
                case 120:  s.allSoundOff();  break;
                case 123:  s.allNotesOff();  break;
                default:   break;
            }
            break;
        case 0xD0:  // Channel pressure — MPE per-note expression. Engine wants
                    // 0..1 normalized (fed straight to the Press matrix source).
                    // The legacy OB-Xd engine dropped 0xD0 entirely, so keep
                    // dropping it unless MPE is enabled for this instance.
            if (g_mpe_enabled[instance_id])
                s.processMPEChannelPressure(channel, (d1 & 0x7F) / 127.0f);
            break;
        case 0xE0: {  // Pitch wheel — 14-bit little-endian, center 8192
            int v = ((d2 & 0x7F) << 7) | (d1 & 0x7F);
            float pv = (v - 8192) / 8192.0f;
            if (g_mpe_enabled[instance_id])
                s.processMPEPitch(channel, pv);
            else
                s.processPitchWheel(pv);
            break;
        }
        default:
            break;
    }
}

EMSCRIPTEN_KEEPALIVE
void obxd_all_notes_off(int instance_id) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    if (g_engines[instance_id]) g_engines[instance_id]->allNotesOff();
}

// Panic one instance — allSoundOff() releases every voice envelope
// immediately so no release tail is produced.
EMSCRIPTEN_KEEPALIVE
void obxd_panic(int instance_id) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    if (g_engines[instance_id]) g_engines[instance_id]->allSoundOff();
}

// Panic every instance — convenience for a global "everything off NOW"
// button. Used by the worklet's `panic_all` message.
EMSCRIPTEN_KEEPALIVE
void obxd_panic_all(void) {
    for (int i = 0; i < INSTANCE_COUNT; ++i) {
        if (g_engines[i]) g_engines[i]->allSoundOff();
    }
}

// Hook for the per-instance knob UI; clamps and dispatches via
// apply_param_instance() so it accepts the legacy indices 0..79.
EMSCRIPTEN_KEEPALIVE
void obxd_set_param(int instance_id, int idx, double value) {
    if (value < 0.0) value = 0.0;
    if (value > 1.0) value = 1.0;
    apply_param_instance(instance_id, idx, (float)value);
}

// Returns the last-applied value for instance `instance_id`'s parameter
// `idx`, or -1 if out of range / not initialized. The UI calls this to
// render knob positions after a default-patch or .fxp load. Accepts BOTH
// legacy indices (0..79, from g_param_mirror) and NEW-param sentinels
// (>= 200, from g_new_param_mirror).
EMSCRIPTEN_KEEPALIVE
float obxd_get_param(int instance_id, int idx) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return -1.0f;
    if (idx >= 200) {
        int new_idx = idx - 200;
        if (new_idx < 0 || new_idx >= NEW_PARAM_COUNT) return -1.0f;
        return g_new_param_mirror[instance_id][new_idx];
    }
    if (idx < 0 || idx >= PARAM_COUNT) return -1.0f;
    return g_param_mirror[instance_id][idx];
}

EMSCRIPTEN_KEEPALIVE
int obxd_load_fxp(int instance_id, uint8_t* ptr, int len) {
    return load_fxp_data(instance_id, ptr, len);
}
// Return codes from obxd_load_fxp / load_fxp_data:
//    0  success
//   -2  instance_id out of range
//   -3  engine not initialized
//   -4  ptr null or len < header (56)
//   -5  chunkMagic != "CcnK"
//   -6  fxMagic not FxCk/FPCh/FBCh
//   -7  data offset negative (impossible)
//   -8  regular (FxCk) but no float params applied
//   -9  chunk too short for chunkSize field
//  -10  chunkSize out of bounds
//  -11  VC2! wrapper xmlLen out of bounds
//  -12  xml_len non-positive
//  -13  parsed no params (neither named nor legacy schema matched)

// Per-instance reset to the OB-Xf init patch. Clears the loaded patch
// name. The UI then re-applies its overrides on top if it wants.
EMSCRIPTEN_KEEPALIVE
void obxd_reset_patch(int instance_id) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    if (!g_engines[instance_id]) return;
    apply_defaults_for_instance(instance_id);
    g_patch_name[instance_id][0] = '\0';
}

EMSCRIPTEN_KEEPALIVE
const char* obxd_get_patch_name(int instance_id) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return "";
    return g_patch_name[instance_id];
}

// Load factory program `patch_id` into instance `instance_id`. When
// patches.h is present (real .fxp files supplied in wasm/obxd/patches/) we
// route through load_fxp_data(), which parses the native OB-Xf named-attribute
// XML schema and applies values 1:1 to processX() (no rescale). The shipped
// factory patches are 10 CC0/Public Domain OB-Xf presets (pad/bass/lead/
// pluck/strings/keys/drone/stab/hat/kick) sourced from the Surge Synth Team
// OB-Xf factory library. When patches.h is absent, every instance falls back
// to the programmatic OB-Xf init patch via apply_defaults_for_instance().
//
// In both paths we first reset via apply_defaults_for_instance() so a
// previous patch's parameters don't bleed through.
EMSCRIPTEN_KEEPALIVE
void obxd_set_factory_patch(int instance_id, int patch_id) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
#if HAS_FACTORY_FXP
    if (patch_id < 0 || patch_id >= FACTORY_PATCH_COUNT) return;
#else
    if (patch_id < 0 || patch_id >= INSTANCE_COUNT) return;
#endif
    recreate_engine(instance_id);
    apply_defaults_for_instance(instance_id);

#if HAS_FACTORY_FXP
    load_fxp_data(instance_id, g_factory_patches[patch_id], (int)g_factory_patch_sizes[patch_id]);
#else
    // No real .fxp factory patches shipped yet — every instance gets the
    // same OB-Xf init patch. The label keeps the legacy per-instance name
    // so the UI selector stays populated.
    static const char* const kInitNames[INSTANCE_COUNT] = {
        "Init Pad", "Init Bass", "Init Lead", "Init Pluck", "Init Strings",
        "Init Keys", "Init Drone", "Init Stab", "Init Hat", "Init Kick",
    };
    set_patch_name(instance_id, kInitNames[patch_id]);
#endif
}

// Return the total number of factory patches embedded in the WASM binary.
EMSCRIPTEN_KEEPALIVE
int obxd_get_factory_patch_count(void) {
#if HAS_FACTORY_FXP
    return FACTORY_PATCH_COUNT;
#else
    return INSTANCE_COUNT;
#endif
}

// Return the program name of factory patch at index, or nullptr if out of range.
EMSCRIPTEN_KEEPALIVE
const char* obxd_get_factory_patch_name(int patch_id) {
#if HAS_FACTORY_FXP
    if (patch_id < 0 || patch_id >= FACTORY_PATCH_COUNT) return nullptr;
    return g_factory_patch_names[patch_id];
#else
    static const char* const kInitNames[INSTANCE_COUNT] = {
        "Init Pad", "Init Bass", "Init Lead", "Init Pluck", "Init Strings",
        "Init Keys", "Init Drone", "Init Stab", "Init Hat", "Init Kick",
    };
    if (patch_id < 0 || patch_id >= INSTANCE_COUNT) return nullptr;
    return kInitNames[patch_id];
#endif
}

// Return the category name of factory patch at index, or nullptr if out of range.
EMSCRIPTEN_KEEPALIVE
const char* obxd_get_factory_patch_category(int patch_id) {
#if HAS_FACTORY_FXP
    if (patch_id < 0 || patch_id >= FACTORY_PATCH_COUNT) return nullptr;
    return g_factory_patch_categories[patch_id];
#else
    return "Init";
#endif
}

EMSCRIPTEN_KEEPALIVE
float obxd_get_instance_rms(int instance_id) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return 0.0f;
    return g_engine_rms[instance_id];
}

// Per-instance MPE enable flag. When enabled, obxd_midi_in forwards the
// MIDI status byte's channel nibble to the OB-Xf engine's channel-aware
// handlers (processNoteOn/Off, processMPEPitch, processMPETimbre on CC 74,
// processMPEChannelPressure on 0xD0).
EMSCRIPTEN_KEEPALIVE
void obxd_set_mpe(int instance_id, int enabled) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    g_mpe_enabled[instance_id] = (enabled != 0);
}

// Fix 2: per-instance mod-wheel direct routing. CC 1 (mod wheel) is a
// reserved CC — the MIDI-learn layer lets it fall through, and previously
// it only reached the synth IF the Octopus engine echoed it to the SAB
// ring (unreliable). processModWheel sets a smoother target in [0,1].
EMSCRIPTEN_KEEPALIVE
void obxd_set_mod_wheel(int instance_id, float v) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    if (!g_engines[instance_id]) return;
    if (v < 0.0f) v = 0.0f;
    if (v > 1.0f) v = 1.0f;
    g_engines[instance_id]->processModWheel(v);
}

// Fix 2: per-instance sustain-pedal direct routing. CC 64 (sustain) is a
// reserved CC routed the same way as mod wheel above. sustainOn/Off are
// idempotent for repeated calls with the same state.
EMSCRIPTEN_KEEPALIVE
void obxd_set_sustain(int instance_id, int on) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    if (!g_engines[instance_id]) return;
    if (on) g_engines[instance_id]->sustainOn();
    else    g_engines[instance_id]->sustainOff();
}

// Backwards-compat no-op for the Phase 1 worklet's `note` branch
// (which still calls _obxd_set_freq). If a stale message arrives,
// we silently drop it instead of breaking the export list.
EMSCRIPTEN_KEEPALIVE
void obxd_set_freq(double freq) { (void)freq; /* no-op */ }

// Returns a 32-bit bitmask of Voice::isSounding() for instance `instance_id`.
// Bit i is set iff voices[i] is sounding. Voices beyond totalVoiceCount are 0.
EMSCRIPTEN_KEEPALIVE
uint32_t obxd_get_voice_activity(int instance_id) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return 0;
    if (!g_engines[instance_id]) return 0;
    Motherboard* mb = g_engines[instance_id]->getMotherboard();
    if (!mb) return 0;
    uint32_t mask = 0u;
    for (int i = 0; i < MAX_VOICES; ++i) {
        if (mb->voices[i].isSounding()) mask |= (uint32_t)1u << i;
    }
    return mask;
}

// Per-instance MPE pitch-bend (glide) range in semitones [0..48].
EMSCRIPTEN_KEEPALIVE
void obxd_set_mpe_glide_range(int instance_id, int semitones) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    if (!g_engines[instance_id]) return;
    if (semitones < 0) semitones = 0;
    if (semitones > MAX_BEND_RANGE) semitones = MAX_BEND_RANGE;
    Motherboard* mb = g_engines[instance_id]->getMotherboard();
    if (mb) mb->mpePitchBendRange = semitones;
}

// Per-instance VoiceMatrix row set. row in [0, NUM_MATRIX_ROWS).
// src/tgt are OB-Xf source/target STRING names. depth in [-1,1].
EMSCRIPTEN_KEEPALIVE
int obxd_set_matrix_row(int instance_id, int row, const char* src, const char* tgt, float depth) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return 0;
    if (!g_engines[instance_id]) return 0;
    if (row < 0 || row >= NUM_MATRIX_ROWS) return 0;
    if (!src || !tgt) return 0;
    Motherboard* mb = g_engines[instance_id]->getMotherboard();
    if (!mb) return 0;
    if (depth < -1.0f) depth = -1.0f;
    if (depth >  1.0f) depth =  1.0f;
    return mb->voiceMatrix.setModulation(std::string(src), std::string(tgt), depth, row) ? 1 : 0;
}

// Per-instance VoiceMatrix row clear.
EMSCRIPTEN_KEEPALIVE
int obxd_clear_matrix_row(int instance_id, int row) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return 0;
    if (!g_engines[instance_id]) return 0;
    if (row < 0 || row >= NUM_MATRIX_ROWS) return 0;
    Motherboard* mb = g_engines[instance_id]->getMotherboard();
    if (!mb) return 0;
    mb->voiceMatrix.clearRow(row);
    return 1;
}

// =========================================================================
// OctOBX PCM drum-mode exports
//
// These drive the OB-Xf SynthEngine's PCM/sample-playback subsystem (added
// by the parallel SynthEngine.h change). `data` points into WASM linear
// memory (a JS Float32Array view over HEAPU8). No copy is made — the
// engine holds the pointer for the lifetime of the sample.
// =========================================================================

// OctOBX PCM: load a float sample buffer into pad/layer of one instance.
EMSCRIPTEN_KEEPALIVE
void obxd_load_pcm(int instance_id, int pad, int layer, float* data, int len) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    if (!g_engines[instance_id]) return;
    g_engines[instance_id]->loadPcmSample(pad, layer, data, len);
}

// OctOBX PCM: set per-layer params (gain, filter, amp env, pan) for a pad.
EMSCRIPTEN_KEEPALIVE
void obxd_set_pcm_layer(int instance_id, int pad, int layer,
    float gain, float cutoff, float res, float mode,
    float aA, float aD, float aS, float aR, float pan, float pitch) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    if (!g_engines[instance_id]) return;
    g_engines[instance_id]->setPcmLayerParams(pad, layer, gain, cutoff, res, mode,
                                              aA, aD, aS, aR, pan, pitch);
}

// OctOBX PCM: map a MIDI note number to a pad.
EMSCRIPTEN_KEEPALIVE
void obxd_set_pcm_note_map(int instance_id, int note, int pad) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    if (!g_engines[instance_id]) return;
    g_engines[instance_id]->setPcmNoteMap(note, pad);
}

// OctOBX PCM: set how many layers a pad plays (velocity-split stack).
EMSCRIPTEN_KEEPALIVE
void obxd_set_pcm_layer_count(int instance_id, int pad, int count) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    if (!g_engines[instance_id]) return;
    g_engines[instance_id]->setPcmLayerCount(pad, count);
}

// OctOBX PCM: assign a pad to a choke group (new hit cuts prior hits).
EMSCRIPTEN_KEEPALIVE
void obxd_set_pcm_choke(int instance_id, int pad, int group) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    if (!g_engines[instance_id]) return;
    g_engines[instance_id]->setPcmChokeGroup(pad, group);
}

// OctOBX PCM: clear all loaded PCM samples/state for one instance.
EMSCRIPTEN_KEEPALIVE
void obxd_clear_pcm(int instance_id) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    if (!g_engines[instance_id]) return;
    g_engines[instance_id]->clearPcm();
}

// OctOBX PCM: per-layer param get/set. pad 0..7, layer 0..3, idx 0..79 (legacy) or
// >=200 (new). Voice-level idx -> layer mirror (applied to each triggered voice on the
// next note-on). Global/structural idx -> instance 9 live (so Volume/Tune/Polyphony/
// global-LFO/etc. affect the whole drum instance immediately). NEW params follow the
// same rule via their drum_class: the four verified synth-globals route live, the
// other 24 are per-layer voice-level.
EMSCRIPTEN_KEEPALIVE
void obxd_set_drum_layer_param(int pad, int layer, int idx, float v) {
    if (pad < 0 || pad >= 8 || layer < 0 || layer >= 4) return;
    if (v < 0.0f) v = 0.0f; if (v > 1.0f) v = 1.0f;
    if (idx >= 200) {
        int n = idx - 200;
        if (n >= 0 && n < NEW_PARAM_COUNT) g_drum_layer_new[pad][layer][n] = v;
        if (is_global_drum_new_param(n)) {
            // route to the live instance so NEW synth-globals (UnisonVoices/
            // VoiceReassign/VibratoWave/LFO1PW) affect the whole drum instance
            // — engine 9 + g_new_param_mirror[9], same as legacy globals.
            apply_param_instance(9, idx, v);
        }
        return;
    }
    if (idx < 0 || idx >= PARAM_COUNT) return;
    g_drum_layer_params[pad][layer][idx] = v;
    if (is_global_drum_param(idx)) {
        // route to the live instance so Volume/Tune/etc. affect the whole drum instance
        apply_param_instance(9, idx, v);
    }
}

EMSCRIPTEN_KEEPALIVE
float obxd_get_drum_layer_param(int pad, int layer, int idx) {
    if (pad < 0 || pad >= 8 || layer < 0 || layer >= 4) return -1.0f;
    if (idx >= 200) {
        int n = idx - 200;
        if (n < 0 || n >= NEW_PARAM_COUNT) return -1.0f;
        if (is_global_drum_new_param(n)) {
            // read live instance value for NEW globals
            return g_new_param_mirror[9][n];
        }
        return g_drum_layer_new[pad][layer][n];
    }
    if (idx < 0 || idx >= PARAM_COUNT) return -1.0f;
    if (is_global_drum_param(idx)) {
        // read live instance value for globals
        return g_param_mirror[9][idx];
    }
    return g_drum_layer_params[pad][layer][idx];
}

// OctOBX PCM: expose is_global_drum_param() to the worklet so the JS bulk
// dump/restore paths can skip drum-global indices WITHOUT duplicating the
// C-side list (which would drift when params are reclassified). Returns 1
// if idx is global/structural (routed live to instance 9 by
// obxd_set_drum_layer_param), 0 otherwise. idx semantics: legacy 0..79 OR a
// NEW-param sentinel (200 + canonical ordinal) — for sentinels this reflects
// the verified NEW-param classification (1 for UnisonVoices/VoiceReassign/
// VibratoWave/LFO1PW, 0 for the 24 voice-level rows).
EMSCRIPTEN_KEEPALIVE
int obxd_is_global_drum_param(int idx) {
    if (idx >= 200)
        return is_global_drum_new_param(idx - 200) ? 1 : 0;
    if (idx < 0 || idx >= PARAM_COUNT) return 0;
    return is_global_drum_param(idx) ? 1 : 0;
}

// =========================================================================
// OctOBX PCM: staged, engine-owned full-state restore (obxd_restore_stage)
//
// REPLACES the fragile 5-step JS-orchestrated restore ordering that used
// to be smeared across three layers:
//   OLD (app-state.ts restoreAppStateAfterAWP):
//     (1) drum kit load → (2) worklet 'restore_all_params' replaying
//     10 × 108 synth params with a hard-coded DRUM_STRUCTURAL_SKIP set
//     {3,40,41,42,51,54} for instance 9 → (3) worklet 'restore_drum_params'
//     replaying 8 × 4 × 108 drum layer params → (4) per-instance settings
//     → (5) reassertDrumInstanceStructural() in drum-audio.ts, which HAD
//     to run last or instance 9's polyphony stayed pinned to 1 and drum
//     layers went silent (only one voice assigned per pad hit).
//   NEW: ALL ordering semantics live HERE, driven by the generated
//   obxf_legacy_params[].drum_class / drum_restore_skip classification in
//   param_table.h — never re-derive those lists in JS.
//
// The worklet's audio thread must never process an unbounded task, so the
// restore is split into five bounded stages invoked in order: stage 0 is
// posted as a HEAVY deferred task (_malloc + two HEAPF32.set copies + a
// memcpy into the staging buffers); stages 1..4 are LIGHT tasks of ~540
// bounded setter calls each. Reply correlation stays in JS — the worklet
// posts 'all_state_restored' after stage 4 returns.
//
// Stage contract:
//   stage 0 — COMMIT DATA: copy both arrays from the passed pointers into
//             C-owned static staging buffers. synth MUST be non-NULL with
//             synth_len == 10*108 (per instance: 80 legacy slots + 28 NEW
//             slots, same layout the dump handlers emit). drum == NULL /
//             drum_len == 0 marks the drum data ABSENT (synth-only
//             restore); otherwise drum_len MUST be 8*4*108. Values are
//             0..1 (or -1 "unset", which clamps to 0 exactly as the old
//             worklet loop's _obxd_set_param path did).
//   stage 1 — apply synth instances 0..4 from staging (mirror + engine,
//             exactly as _obxd_set_param does today).
//   stage 2 — apply synth instances 5..9, SKIPPING rows flagged
//             drum_restore_skip on instance 9 ONLY ({3,40,41,42,51,54});
//             instances 5..8 replay everything, including idx 3
//             polyphony, which is user state for them.
//   stage 3 — apply the drum layer store: for each pad/layer write the
//             VOICE/SMOOTHER rows into g_drum_layer_params and the
//             voice-level NEW rows into g_drum_layer_new. DRUM_GLOBAL and
//             DRUM_NONE rows — legacy AND NEW — are skipped: their values
//             reach the engine via the instance-9 synth replay in stage 2
//             (restore_apply_synth_block applies all 108 slots per instance,
//             80 legacy + 28 NEW sentinels), preserving the old semantics
//             where the drum dump zeroes global slots and the restore skips
//             them. NO-OP when drum data is absent.
//   stage 4 — drum structural finalize for instance 9: apply the
//             drum-mode defaults for the skipped rows (OSC1MIX/OSC2MIX/
//             NOISEMIX = 0.0, LATK = 0.0, LREL = 0.3 — the exact five
//             writes of initDrumMode in src/drum-audio.ts) and set
//             polyphony = 32 via the same path obxd_set_polyphony(9,
//             MAX_VOICES) uses, so the mirrors reflect these finals. This
//             stage is what made the JS-side reassertDrumInstanceStructural
//             unnecessary. NO-OP when drum data is absent.
//
// State machine: stages must be called in order 0→1→2→3→4. A stage called
// out of order returns negative and does NOT advance the machine. After
// stage 4 the machine resets to accept a new stage 0. When drum data is
// absent the worklet still CALLS stages 3/4 — both return 0 without
// touching drum state so the machine always completes and resets.
//
// Return codes:   0  success
//                 -1  invalid stage number (not 0..4)
//                 -2  stage called out of order
//                 -3  engines not initialized (stages 1/2/4)
//                 -10 stage 0: synth pointer NULL
//                 -11 stage 0: synth_len != 10*108
//                 -12 stage 0: drum_len invalid (0 with drum==NULL,
//                              8*4*108 with drum != NULL)
// =========================================================================

#define RESTORE_STRIDE  (PARAM_COUNT + NEW_PARAM_COUNT)  // 108 = 80 legacy + 28 NEW
#define RESTORE_SYNTH_TOTAL (INSTANCE_COUNT * RESTORE_STRIDE)
#define RESTORE_DRUM_PADS    8
#define RESTORE_DRUM_LAYERS  4
#define RESTORE_DRUM_TOTAL   (RESTORE_DRUM_PADS * RESTORE_DRUM_LAYERS * RESTORE_STRIDE)

// C-owned staging buffers, filled once by stage 0 and consumed by stages
// 1..4 (the JS-side heap copies are freed immediately after stage 0).
static float g_restore_stage_synth[RESTORE_SYNTH_TOTAL] = {};
static float g_restore_stage_drum[RESTORE_DRUM_TOTAL] = {};
static bool  g_restore_stage_drum_present = false;
static int   g_restore_next_stage = 0;   // state machine: next expected stage

// Clamp + apply one 108-slot staging block to an instance, exactly as the
// old worklet restore loop did (_obxd_set_param clamps into [0,1] before
// apply_param_instance, which clamps again — identical result). When
// skip_drum_structural is set, legacy rows flagged drum_restore_skip are
// NOT replayed (instance 9 only — stage 2).
static void restore_apply_synth_block(int instance_id, const float* block,
                                      bool skip_drum_structural) {
    for (int p = 0; p < PARAM_COUNT; ++p) {
        if (skip_drum_structural && obxf_legacy_params[p].drum_restore_skip) continue;
        apply_param_instance(instance_id, p, block[p]);
    }
    for (int n = 0; n < NEW_PARAM_COUNT; ++n)
        apply_param_instance(instance_id, OBXF_PT_NEW_PARAM_BASE + n,
                             block[PARAM_COUNT + n]);
}

EMSCRIPTEN_KEEPALIVE
int obxd_restore_stage(int stage, const float* synth, int synth_len,
                       const float* drum, int drum_len) {
    if (stage < 0 || stage > 4) return -1;
    if (stage != g_restore_next_stage) return -2;

    switch (stage) {
        case 0: {  // COMMIT DATA
            if (!synth) return -10;
            if (synth_len != RESTORE_SYNTH_TOTAL) return -11;
            if (drum && drum_len != RESTORE_DRUM_TOTAL) return -12;
            if (!drum && drum_len != 0) return -12;
            __builtin_memcpy(g_restore_stage_synth, synth, sizeof(g_restore_stage_synth));
            g_restore_stage_drum_present = (drum != nullptr);
            if (g_restore_stage_drum_present)
                __builtin_memcpy(g_restore_stage_drum, drum, sizeof(g_restore_stage_drum));
            break;
        }
        case 1: {  // synth instances 0..4
            for (int i = 0; i <= 4; ++i)
                if (!g_engines[i]) return -3;
            for (int i = 0; i <= 4; ++i)
                restore_apply_synth_block(i, &g_restore_stage_synth[i * RESTORE_STRIDE], false);
            break;
        }
        case 2: {  // synth instances 5..9 (instance 9 skips drum-structural rows)
            for (int i = 5; i < INSTANCE_COUNT; ++i)
                if (!g_engines[i]) return -3;
            for (int i = 5; i < INSTANCE_COUNT; ++i)
                restore_apply_synth_block(i, &g_restore_stage_synth[i * RESTORE_STRIDE],
                                          i == 9);
            break;
        }
        case 3: {  // drum layer store (no-op when drum data absent)
            if (!g_restore_stage_drum_present) break;
            for (int pad = 0; pad < RESTORE_DRUM_PADS; ++pad) {
                for (int layer = 0; layer < RESTORE_DRUM_LAYERS; ++layer) {
                    const float* block =
                        &g_restore_stage_drum[(pad * RESTORE_DRUM_LAYERS + layer) * RESTORE_STRIDE];
                    for (int p = 0; p < PARAM_COUNT; ++p) {
                        const obxf_drum_class_t dc = obxf_legacy_params[p].drum_class;
                        // Globals reach the engine via the stage-2 instance-9
                        // replay; NONE rows are dead (apply_legacy == NULL).
                        if (dc == DRUM_GLOBAL || dc == DRUM_NONE) continue;
                        float v = block[p];
                        if (v < 0.0f) v = 0.0f;
                        if (v > 1.0f) v = 1.0f;
                        g_drum_layer_params[pad][layer][p] = v;
                    }
                    for (int n = 0; n < NEW_PARAM_COUNT; ++n) {
                        // NEW globals reach the engine via the stage-2
                        // instance-9 replay (the synth block replays all 108
                        // slots incl. sentinels >= 200) — writing them into
                        // the per-layer store would be dead/duplicated state.
                        if (is_global_drum_new_param(n)) continue;
                        float v = block[PARAM_COUNT + n];
                        if (v < 0.0f) v = 0.0f;
                        if (v > 1.0f) v = 1.0f;
                        g_drum_layer_new[pad][layer][n] = v;
                    }
                }
            }
            break;
        }
        case 4: {  // drum structural finalize for instance 9 (no-op when drum data absent)
            if (!g_restore_stage_drum_present) break;
            if (!g_engines[9]) return -3;
            // Drum-mode defaults for the rows stage 2 skipped — the exact
            // five writes of initDrumMode (src/drum-audio.ts), applied via
            // apply_param_instance so engine + g_param_mirror[9] agree.
            apply_param_instance(9, OSC1MIX, 0.0f);
            apply_param_instance(9, OSC2MIX, 0.0f);
            apply_param_instance(9, NOISEMIX, 0.0f);
            apply_param_instance(9, LATK,    0.0f);
            apply_param_instance(9, LREL,    0.3f);
            // 32-voice drum polyphony via the same path the old
            // reassertDrumInstanceStructural used (sets engine polyphony,
            // g_engine_polyphony[9], and the legacy mirror entry).
            obxd_set_polyphony(9, MAX_VOICES);
            break;
        }
        default:
            return -1;
    }

    g_restore_next_stage = (stage == 4) ? 0 : stage + 1;
    return 0;
}

}  // extern "C"

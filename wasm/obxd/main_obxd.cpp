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
 *   dispatches those legacy indices onto the NEW OB-Xf processX() methods,
 *   applying the value rescales documented in obxf_param_mappings.h and
 *   verified against obxf_imported/state/ObxdImporter.cpp (the canonical
 *   OB-Xd→OB-Xf translator). Rescale rules implemented:
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
 *     - LFO wave/dest: bool→blend/tri-state (lfoBoolToBlend / lfoBoolToTriState)
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

#include "obxf_param_mappings.h"   // legacy → new dispatch documentation

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
// obxf_param_mappings.h. PARAM_COUNT is the legacy count (80), NOT the
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

// Per-instance param mirror — SynthEngine has no getter API, so we maintain
// our own copy alongside the engine state. obxd_get_param() reads from here;
// the knob UI uses it to render values after a patch load. Indexed
// [instance_id][legacy_param_idx]; values are in the LEGACY 0..1 space.
static float g_param_mirror[INSTANCE_COUNT][PARAM_COUNT] = {};

// Per-instance mirror for the 28 NEW OB-Xf params (no legacy ancestor).
// Indexed [instance_id][new_idx] where new_idx = sentinel - 200 (0..27).
// obxd_get_param() returns from here for idx >= 200 so the knob UI can
// sync NEW-param widget positions after a .fxp load.
static constexpr int NEW_PARAM_COUNT = 28;
static float g_new_param_mirror[INSTANCE_COUNT][NEW_PARAM_COUNT] = {};

// Per-instance last-loaded program name (empty until a load succeeds).
static char g_patch_name[INSTANCE_COUNT][64] = {};

// Master mix bus — every active engine's output is summed here each
// quantum, then x/(1+|x|) soft-clipped per sample.
static float g_master_l[BUF_FRAMES];
static float g_master_r[BUF_FRAMES];

// =========================================================================
// OB-Xd → OB-Xf rescale helpers (verbatim from ObxdImporter.cpp)
//
// These reimplement OB-Xd's logsc/linsc plus inverses so legacy 0..1
// normalized values can be remapped onto the OB-Xf engine's different
// internal ranges. Kept byte-for-byte aligned with the importer so a
// runtime knob turn produces the same value an .fxp import would.
// =========================================================================

inline float xdLogsc(float p, float lo, float hi, float rolloff = 19.f)
{
    return ((std::exp(p * std::log(rolloff + 1.f)) - 1.f) / rolloff) * (hi - lo) + lo;
}

inline float xdInvLinsc(float y, float lo, float hi)
{
    if (hi == lo)
        return 0.f;
    return juce::jlimit(0.f, 1.f, (y - lo) / (hi - lo));
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

// OB-Xd LFO waveform bool toggle → OB-Xf continuous blend [-1..1].
// Importer only emits 0 or 0.5 (never negative).
inline float lfoBoolToBlend(float v) { return v >= 0.5f ? 0.f : 0.5f; }

// OB-Xd LFO destination bool toggle → OB-Xf tri-state {Off, On, Inv} = 0/0.5/1.
// Importer only emits 0 or 0.5 (the Inv state has no OB-Xd ancestor).
inline float lfoBoolToTriState(float v) { return v >= 0.5f ? 0.5f : 0.f; }

// =========================================================================
// Parameter dispatch (legacy OB-Xd idx → OB-Xf processX() method)
//
// apply_param_instance() is the instance-aware dispatch. It reads
// g_engines[id], writes g_param_mirror[id] (in legacy 0..1 space), and
// calls the matching NEW SynthEngine method — applying the rescale rules
// documented in obxf_param_mappings.h.
// =========================================================================

static void apply_param_instance(int instance_id, int idx, float v);

// Fix 3: dispatch for the 28 NEW OB-Xf params (no OB-Xd legacy ancestor).
//
// The UI (obxd-synth-ui.ts) assigns these a sentinel legacy index
// NEW_PARAM_BASE (200) + position, where position is the 0-based ordinal in
// which the paramBound controls with no legacy mapping are encountered during
// buildObxdSynthUi. That ordering matches obxf_dispatch_reference.md's NEW
// FEATURE list AND the SynthEngine.h method declaration order, so the switch
// below is keyed on new_idx = (sentinel - 200). Values are passed 1:1 to the
// matching processX() method with NO rescale (these are native OB-Xf params).
//
// IMPORTANT: if obxf-layout.ts's obxfControls array order changes, the
// sentinel↔param mapping changes and this switch MUST be re-synchronized.
// All 28 method names verified present in obxf_imported/engine/SynthEngine.h.
static void apply_new_param_instance(SynthEngine& s, int new_idx, float v) {
    switch (new_idx) {
        case 0:  s.processUnisonVoices(v); break;        // UnisonVoices
        case 1:  s.processVoiceReassign(v); break;        // VoiceReassign
        case 2:  s.processOsc2Keytrack(v); break;         // Osc2Keytrack
        case 3:  s.processEnvToPitchInvert(v); break;     // EnvToPitchInvert
        case 4:  s.processEnvToPWInvert(v); break;        // EnvToPWInvert
        case 5:  s.processRingModVolume(v); break;        // RingModMix
        case 6:  s.processNoiseColor(v); break;           // NoiseColor
        case 7:  s.processVibratoLFOWave(v); break;       // VibratoWave
        case 8:  s.processFilter4PoleXpander(v); break;   // Filter4PoleXpander
        case 9:  s.processFilterXpanderMode(v); break;    // FilterXpanderMode
        case 10: s.processLFO1PW(v); break;               // LFO1PW
        case 11: s.processLFO1ToVolume(v); break;         // LFO1ToVolume
        case 12: s.processLFO2Sync(v); break;             // LFO2TempoSync
        case 13: s.processLFO2Rate(v); break;             // LFO2Rate
        case 14: s.processLFO2ModAmount1(v); break;       // LFO2ModAmount1
        case 15: s.processLFO2ModAmount2(v); break;       // LFO2ModAmount2
        case 16: s.processLFO2Wave1(v); break;            // LFO2Wave1
        case 17: s.processLFO2Wave2(v); break;            // LFO2Wave2
        case 18: s.processLFO2Wave3(v); break;            // LFO2Wave3
        case 19: s.processLFO2PW(v); break;               // LFO2PW
        case 20: s.processLFO2ToOsc1Pitch(v); break;      // LFO2ToOsc1Pitch
        case 21: s.processLFO2ToOsc2Pitch(v); break;      // LFO2ToOsc2Pitch
        case 22: s.processLFO2ToFilterCutoff(v); break;   // LFO2ToFilterCutoff
        case 23: s.processLFO2ToOsc1PW(v); break;         // LFO2ToOsc1PW
        case 24: s.processLFO2ToOsc2PW(v); break;         // LFO2ToOsc2PW
        case 25: s.processLFO2ToVolume(v); break;         // LFO2ToVolume
        case 26: s.processFilterEnvAttackCurve(v); break; // FilterEnvAttackCurve
        case 27: s.processAmpEnvAttackCurve(v); break;    // AmpEnvAttackCurve
        default: break;   // unknown sentinel — silently ignore
    }
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
    // Filter (open, no resonance)
    s.processFilterCutoff(1.0f);
    s.processFilterResonance(0.0f);
    // Amp env: instant attack, short decay, full sustain, short release
    s.processAmpEnvAttack(0.0f);
    s.processAmpEnvDecay(0.3f);
    s.processAmpEnvSustain(1.0f);
    s.processAmpEnvRelease(0.3f);

    // Reflect those settings back into the legacy mirror so the knob UI
    // renders consistent positions after init / reset.
    g_param_mirror[instance_id][VOLUME]     = 0.5f;
    g_param_mirror[instance_id][VOICE_COUNT]= 1.0f;   // 8 voices (old max)
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

// Dispatch one legacy (idx, v) pair to the NEW engine. `v` is clamped to
// [0,1] and stored in the legacy mirror BEFORE the (possibly rescaled)
// call. See the file header for the full rescale rule list.
static void apply_param_instance(int instance_id, int idx, float v) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    SynthEngine* e = g_engines[instance_id];
    if (!e) return;
    if (v < 0.0f) v = 0.0f;
    if (v > 1.0f) v = 1.0f;
    SynthEngine& s = *e;

    // Fix 3: sentinel indices >= NEW_PARAM_BASE (200) are OB-Xf params with
    // no legacy ancestor. Dispatch 1:1 to the NEW processX() methods (no
    // rescale) and mirror the value so obxd_get_param can report it.
    if (idx >= 200) {
        int new_idx = idx - 200;
        if (new_idx >= 0 && new_idx < NEW_PARAM_COUNT)
            g_new_param_mirror[instance_id][new_idx] = v;
        apply_new_param_instance(s, new_idx, v);
        return;
    }

    if (idx < 0 || idx >= PARAM_COUNT) return;
    g_param_mirror[instance_id][idx] = v;
    switch (idx) {
        case UNDEFINED:        break;                                  // 0  sentinel
        case MIDILEARN:        break;                                  // 1  REMOVED
        case VOLUME:           s.processVolume(v); break;              // 2  1:1
        case VOICE_COUNT: {                                            // 3  RESCALE old 1..8 → new
            int xdVoices = juce::jlimit(1, 8, (int)std::round(v * 7.f) + 1);
            s.processPolyphony(((float)(xdVoices - 1) + 0.5f) / 32.f);
        } break;
        case TUNE:             s.processTune(v); break;                // 4  1:1
        case OCTAVE: {                                                 // 5  → Transpose (semantic shift)
            int transpose = juce::jlimit(0, 4, (int)std::round(v * 4.f) + 1);
            s.processTranspose((float)transpose * 0.25f);
        } break;
        case BENDRANGE: {                                              // 6  SPLIT → Up + Down
            int range = (v > 0.5f) ? 12 : 2;
            float n = (float)range / 48.f;                             // MAX_BEND_RANGE
            s.processBendUpRange(n);
            s.processBendDownRange(n);
        } break;
        case BENDOSC2:        s.processBendOsc2Only(v); break;         // 7  1:1
        case LEGATOMODE:      s.processEnvLegatoMode(v); break;        // 8  importer copies 1:1
        case BENDLFORATE: {                                            // 9  → VibratoRate (rescale+rename)
            float hzXd = xdLogsc(v, 3.f, 10.f);
            s.processVibratoLFORate(xdInvLinsc(hzXd, 2.f, 12.f));
        } break;
        case VFLTENV:         s.processVelToFilterEnv(v); break;       // 10 1:1
        case VAMPENV:         s.processVelToAmpEnv(v); break;          // 11 1:1
        case ASPLAYEDALLOCATION:                                       // 12 bool→tri NotePriority
            s.processNotePriority(v > 0.5f ? 0.0f : 0.5f); break;
        case PORTAMENTO:      s.processPortamento(v); break;           // 13 1:1
        case UNISON:          s.processUnison(v); break;               // 14 1:1
        case UDET: {                                                   // 15 → UnisonDetune (rescale)
            float dXd = xdLogsc(v, 0.001f, 0.90f);
            s.processUnisonDetune(xdInvLogsc(dXd, 0.001f, 1.0f));
        } break;
        case OSC2_DET:        s.processOsc2Detune(v); break;           // 16 1:1
        case LFOFREQ: {                                                // 17 → LFO1Rate (~75x rescale)
            // Synced path uses the 9→21 bucket map; consult the live mirror
            // for LFO_SYNC. (During .fxp load, LFO_SYNC may not yet be set
            // when LFOFREQ is dispatched — known limitation, see header.)
            if (g_param_mirror[instance_id][LFO_SYNC] > 0.5f) {
                s.processLFO1Rate(mapLfoSyncedRate(v));
            } else {
                float hzXd = xdLogsc(v, 0.f, 50.f, 120.f);
                s.processLFO1Rate(xdInvLogsc(hzXd, 0.f, 250.f, 3775.f));
            }
        } break;
        case LFOSINWAVE:      s.processLFO1Wave1(lfoBoolToBlend(v)); break;   // 18 bool→blend
        case LFOSQUAREWAVE:   s.processLFO1Wave2(lfoBoolToBlend(v)); break;   // 19
        case LFOSHWAVE:       s.processLFO1Wave3(lfoBoolToBlend(v)); break;   // 20
        case LFO1AMT:         s.processLFO1ModAmount1(v); break;       // 21 1:1
        case LFO2AMT:         s.processLFO1ModAmount2(v); break;       // 22 1:1 (NOT LFO2)
        case LFOOSC1:         s.processLFO1ToOsc1Pitch(lfoBoolToTriState(v)); break;   // 23 bool→tri
        case LFOOSC2:         s.processLFO1ToOsc2Pitch(lfoBoolToTriState(v)); break;   // 24
        case LFOFILTER:       s.processLFO1ToFilterCutoff(lfoBoolToTriState(v)); break;// 25
        case LFOPW1:          s.processLFO1ToOsc1PW(lfoBoolToTriState(v)); break;      // 26
        case LFOPW2:          s.processLFO1ToOsc2PW(lfoBoolToTriState(v)); break;      // 27 (NOT LFO2)
        case OSC2HS:          s.processOscSync(v); break;              // 28 1:1
        case XMOD:            s.processCrossmod(v * 0.5f); break;      // 29 RESCALE (old v*24, new v*48)
        case OSC1P:           s.processOsc1Pitch(v); break;            // 30 1:1
        case OSC2P:           s.processOsc2Pitch(v); break;            // 31 1:1
        case OSCQuantize:     break;                                   // 32 REMOVED
        case OSC1Saw:         s.processOsc1Saw(v); break;              // 33 1:1
        case OSC1Pul:         s.processOsc1Pulse(v); break;            // 34 1:1
        case OSC2Saw:         s.processOsc2Saw(v); break;              // 35 1:1
        case OSC2Pul:         s.processOsc2Pulse(v); break;            // 36 1:1
        case PW:              s.processOscPW(v); break;                // 37 1:1
        case BRIGHTNESS:      s.processOscBrightness(v); break;        // 38 1:1
        case ENVPITCH:        s.processEnvToPitchAmount(v * (36.f / 40.f)); break; // 39 RESCALE
        case OSC1MIX:         s.processOsc1Volume(v); break;           // 40 1:1 (method=processOsc1Volume)
        case OSC2MIX:         s.processOsc2Volume(v); break;           // 41 1:1 (method=processOsc2Volume)
        case NOISEMIX:        s.processNoiseVolume(xdLogsc(v, 0.f, 1.f, 35.f)); break; // 42 RESCALE (bake logsc)
        case FLT_KF:          s.processFilterKeyTrack(v); break;       // 43 1:1
        case CUTOFF:          s.processFilterCutoff(v); break;         // 44 1:1
        case RESONANCE:       s.processFilterResonance(v); break;      // 45 1:1
        case MULTIMODE:       s.processFilterMode(v); break;           // 46 1:1
        case FILTER_WARM:     s.processHQMode(v); break;               // 47 1:1 (engine toggles allSoundOff internally)
        case BANDPASS:        s.processFilter2PoleBPBlend(v); break;   // 48 1:1
        case FOURPOLE:        s.processFilter4PoleMode(v); break;      // 49 1:1
        case ENVELOPE_AMT:    s.processFilterEnvAmount(v); break;      // 50 1:1
        case LATK: {                                                   // 51 → AmpEnvAttack (rescale /3)
            float msXd = xdLogsc(v, 4.f, 60000.f, 900.f);
            s.processAmpEnvAttack(xdInvLogsc(msXd / 3.f, 4.f, 60000.f, 900.f));
        } break;
        case LDEC:            s.processAmpEnvDecay(v); break;          // 52 1:1
        case LSUS:            s.processAmpEnvSustain(v); break;        // 53 1:1
        case LREL:            s.processAmpEnvRelease(v); break;        // 54 1:1
        case FATK: {                                                    // 55 → FilterEnvAttack (rescale /3)
            float msXd = xdLogsc(v, 1.f, 60000.f, 900.f);
            s.processFilterEnvAttack(xdInvLogsc(msXd / 3.f, 1.f, 60000.f, 900.f));
        } break;
        case FDEC:            s.processFilterEnvDecay(v); break;       // 56 1:1
        case FSUS:            s.processFilterEnvSustain(v); break;     // 57 1:1
        case FREL:            s.processFilterEnvRelease(v); break;     // 58 1:1
        case ENVDER:          s.processEnvelopeSlop(v); break;         // 59 1:1
        case FILTERDER:       s.processFilterSlop(v); break;           // 60 1:1
        case PORTADER:        s.processPortamentoSlop(v); break;       // 61 1:1
        case PAN1:            s.processPan(v, 1); break;               // 62 1:1
        case PAN2:            s.processPan(v, 2); break;               // 63
        case PAN3:            s.processPan(v, 3); break;               // 64
        case PAN4:            s.processPan(v, 4); break;               // 65
        case PAN5:            s.processPan(v, 5); break;               // 66
        case PAN6:            s.processPan(v, 6); break;               // 67
        case PAN7:            s.processPan(v, 7); break;               // 68
        case PAN8:            s.processPan(v, 8); break;               // 69
        case UNLEARN:         break;                                   // 70 REMOVED
        case ECONOMY_MODE:    break;                                   // 71 REMOVED
        case LFO_SYNC:        s.processLFO1Sync(v); break;             // 72 1:1
        case PW_ENV:          s.processEnvToPWAmount(v * (0.85f / 1.0555555555f)); break; // 73 RESCALE
        case PW_ENV_BOTH:     s.processEnvToPWBothOscs(v); break;      // 74 1:1
        case ENV_PITCH_BOTH:  s.processPitchBothOscs(v); break;        // 75 1:1 (method has no "EnvTo")
        case FENV_INVERT:     s.processFilterEnvInvert(v); break;      // 76 1:1
        case PW_OSC2_OFS:     s.processOsc2PWOffset(v * (0.75f / 0.95f)); break; // 77 RESCALE
        case LEVEL_DIF:       s.processLevelSlop(v); break;            // 78 1:1
        case SELF_OSC_PUSH:   s.processFilter2PolePush(v); break;      // 79 1:1
        default: break;
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
// parse_chunk_xml_named(). It writes g_param_mirror for any param that maps
// to a legacy index 0..79 (Fix 4a) so the knob UI syncs after a patch load;
// the 28 NEW params (no legacy ancestor) are not mirrored. The knob grid is
// a legacy OB-Xd control surface and cannot represent the full OB-Xf
// parameter space — NEW-param knob sync after patch load is a follow-up.
// =========================================================================

static int nameeq(const char* a, int alen, const char* b) {
    // Compare a (length alen, NOT null-terminated) against b (C string).
    int i = 0;
    for (; i < alen && b[i]; ++i) {
        if (a[i] != b[i]) return 0;
    }
    return (i == alen && b[i] == '\0') ? 1 : 0;
}

// Fix 4(a): reverse-lookup an OB-Xf streaming param name → legacy
// ParamsEnum.h index (0..79), using obxf_param_mappings.h. Returns -1 when
// the name has no legacy ancestor (one of the 28 NEW params) so the caller
// can skip the g_param_mirror write. Each streaming name is unique in the
// table (BENDRANGE splits to "PitchBendUp" + "PitchBendDown", both → 6).
static int legacy_index_for_streaming_name(const char* name, int nlen) {
    for (int i = 0; i < obxf_param_mappings_count; ++i) {
        const obxf_param_mapping_t* m = &obxf_param_mappings[i];
        if (m->new_id && m->new_id[0] != '\0' && nameeq(name, nlen, m->new_id)) {
            return m->legacy_index;
        }
    }
    return -1;
}

// Reverse-lookup an OB-Xf streaming param name → NEW-param sentinel offset
// (0..27), for the 28 params with no legacy ancestor. Returns -1 for names
// that DO have a legacy ancestor (or are unknown). The mapping is 1:1 with
// apply_new_param_instance()'s switch cases. VoiceReassign and Osc2Keytrack
// (cases 1, 2) have no streaming name in OB-Xf .fxp files and are therefore
// unreachable here — they can only be set via the UI knob path.
static const struct { const char* name; int offset; } new_param_names[] = {
    { "UnisonVoices",        0 },
    // 1 = VoiceReassign (no streaming name)
    // 2 = Osc2Keytrack (no streaming name)
    { "EnvToPitchInvert",    3 },
    { "EnvToPWInvert",       4 },
    { "RingModMix",          5 },
    { "NoiseColor",          6 },
    { "VibratoWave",         7 },
    { "Filter4PoleXpander",  8 },
    { "FilterXpanderMode",   9 },
    { "LFO1PW",             10 },
    { "LFO1ToVolume",       11 },
    { "LFO2TempoSync",      12 },
    { "LFO2Rate",           13 },
    { "LFO2ModAmount1",     14 },
    { "LFO2ModAmount2",     15 },
    { "LFO2Wave1",          16 },
    { "LFO2Wave2",          17 },
    { "LFO2Wave3",          18 },
    { "LFO2PW",             19 },
    { "LFO2ToOsc1Pitch",    20 },
    { "LFO2ToOsc2Pitch",    21 },
    { "LFO2ToFilterCutoff", 22 },
    { "LFO2ToOsc1PW",       23 },
    { "LFO2ToOsc2PW",       24 },
    { "LFO2ToVolume",       25 },
    { "FilterEnvAttackCurve",26 },
    { "AmpEnvAttackCurve",  27 },
};
static constexpr int new_param_names_count =
    sizeof(new_param_names) / sizeof(new_param_names[0]);

static int new_offset_for_streaming_name(const char* name, int nlen) {
    for (int i = 0; i < new_param_names_count; ++i) {
        if (nameeq(name, nlen, new_param_names[i].name))
            return new_param_names[i].offset;
    }
    return -1;
}

static void apply_named_param_instance(int instance_id, const char* name, int nlen, float v) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    SynthEngine* e = g_engines[instance_id];
    if (!e) return;
    if (!name || nlen <= 0) return;
    if (v < 0.0f) v = 0.0f;
    if (v > 1.0f) v = 1.0f;
    SynthEngine& s = *e;

    // Mirror legacy-indexed params so the knob UI syncs correctly after a
    // native OB-Xf .fxp load (syncObxdControlsFromEngine reads g_param_mirror).
    // The value stored is the NATIVE OB-Xf 0..1 value, which matches the
    // legacy value for the 41 clean 1:1 params. For the 14 rescaled params
    // (OCTAVE/Transpose, BENDRANGE, LATK/FATK, …) the stored native value
    // differs from what the legacy knob WOULD produce, so grabbing such a
    // knob after a patch load may cause a small jump — a known trade-off.
    int legacy_idx = legacy_index_for_streaming_name(name, nlen);
    if (legacy_idx >= 0 && legacy_idx < PARAM_COUNT) {
        g_param_mirror[instance_id][legacy_idx] = v;
    }

    // Mirror NEW params (no legacy ancestor) into g_new_param_mirror so the
    // knob UI can sync their widget positions too. The sentinel offset (0..27)
    // matches apply_new_param_instance()'s switch.
    int new_off = new_offset_for_streaming_name(name, nlen);
    if (new_off >= 0 && new_off < NEW_PARAM_COUNT) {
        g_new_param_mirror[instance_id][new_off] = v;
    }

    // MASTER
    if      (nameeq(name,nlen,"Volume"))             s.processVolume(v);
    else if (nameeq(name,nlen,"Transpose"))          s.processTranspose(v);
    else if (nameeq(name,nlen,"Tune"))               s.processTune(v);
    // GLOBAL
    else if (nameeq(name,nlen,"Polyphony"))          s.processPolyphony(v);
    else if (nameeq(name,nlen,"HQMode"))             s.processHQMode(v);
    else if (nameeq(name,nlen,"UnisonVoices"))       s.processUnisonVoices(v);
    else if (nameeq(name,nlen,"Portamento"))         s.processPortamento(v);
    else if (nameeq(name,nlen,"Unison"))             s.processUnison(v);
    else if (nameeq(name,nlen,"UnisonDetune"))       s.processUnisonDetune(v);
    else if (nameeq(name,nlen,"EnvLegatoMode"))      s.processEnvLegatoMode(v);
    else if (nameeq(name,nlen,"NotePriority"))       s.processNotePriority(v);
    // OSCILLATORS
    else if (nameeq(name,nlen,"Osc1Pitch"))          s.processOsc1Pitch(v);
    else if (nameeq(name,nlen,"Osc2Detune"))         s.processOsc2Detune(v);
    else if (nameeq(name,nlen,"Osc2Pitch"))          s.processOsc2Pitch(v);
    else if (nameeq(name,nlen,"Osc1SawWave"))        s.processOsc1Saw(v);
    else if (nameeq(name,nlen,"Osc1PulseWave"))      s.processOsc1Pulse(v);
    else if (nameeq(name,nlen,"Osc2SawWave"))        s.processOsc2Saw(v);
    else if (nameeq(name,nlen,"Osc2PulseWave"))      s.processOsc2Pulse(v);
    else if (nameeq(name,nlen,"OscPW"))              s.processOscPW(v);
    else if (nameeq(name,nlen,"Osc2PWOffset"))       s.processOsc2PWOffset(v);
    else if (nameeq(name,nlen,"EnvToPitchAmount"))   s.processEnvToPitchAmount(v);
    else if (nameeq(name,nlen,"EnvToPitchBothOscs")) s.processPitchBothOscs(v);
    else if (nameeq(name,nlen,"EnvToPitchInvert"))   s.processEnvToPitchInvert(v);
    else if (nameeq(name,nlen,"EnvToPWAmount"))      s.processEnvToPWAmount(v);
    else if (nameeq(name,nlen,"EnvToPWBothOscs"))    s.processEnvToPWBothOscs(v);
    else if (nameeq(name,nlen,"EnvToPWInvert"))      s.processEnvToPWInvert(v);
    else if (nameeq(name,nlen,"OscCrossmod"))        s.processCrossmod(v);
    else if (nameeq(name,nlen,"OscSync"))            s.processOscSync(v);
    else if (nameeq(name,nlen,"OscBrightness"))      s.processOscBrightness(v);
    // MIXER — streaming names are Osc1Mix/Osc2Mix (ID constants are Osc1Vol/Osc2Vol)
    else if (nameeq(name,nlen,"Osc1Mix"))            s.processOsc1Volume(v);
    else if (nameeq(name,nlen,"Osc2Mix"))            s.processOsc2Volume(v);
    else if (nameeq(name,nlen,"RingModMix"))         s.processRingModVolume(v);
    else if (nameeq(name,nlen,"NoiseMix"))           s.processNoiseVolume(v);
    else if (nameeq(name,nlen,"NoiseColor"))         s.processNoiseColor(v);
    // CONTROL — streaming names PitchBendUp/PitchBendDown (ID: BendUpRange/Down)
    else if (nameeq(name,nlen,"PitchBendUp"))        s.processBendUpRange(v);
    else if (nameeq(name,nlen,"PitchBendDown"))      s.processBendDownRange(v);
    else if (nameeq(name,nlen,"BendOsc2Only"))       s.processBendOsc2Only(v);
    else if (nameeq(name,nlen,"VibratoWave"))        s.processVibratoLFOWave(v);
    else if (nameeq(name,nlen,"VibratoRate"))        s.processVibratoLFORate(v);
    // FILTER
    else if (nameeq(name,nlen,"Filter4PoleMode"))    s.processFilter4PoleMode(v);
    else if (nameeq(name,nlen,"FilterCutoff"))       s.processFilterCutoff(v);
    else if (nameeq(name,nlen,"FilterResonance"))    s.processFilterResonance(v);
    else if (nameeq(name,nlen,"FilterEnvAmount"))    s.processFilterEnvAmount(v);
    else if (nameeq(name,nlen,"FilterKeyFollow"))    s.processFilterKeyTrack(v); // ID: FilterKeyTrack
    else if (nameeq(name,nlen,"FilterMode"))         s.processFilterMode(v);
    else if (nameeq(name,nlen,"Filter2PoleBPBlend")) s.processFilter2PoleBPBlend(v);
    else if (nameeq(name,nlen,"Filter2PolePush"))    s.processFilter2PolePush(v);
    else if (nameeq(name,nlen,"Filter4PoleXpander")) s.processFilter4PoleXpander(v);
    else if (nameeq(name,nlen,"FilterXpanderMode"))  s.processFilterXpanderMode(v);
    // LFO 1 — streaming "LFO1TempoSync" → processLFO1Sync
    else if (nameeq(name,nlen,"LFO1TempoSync"))      s.processLFO1Sync(v);
    else if (nameeq(name,nlen,"LFO1Rate"))           s.processLFO1Rate(v);
    else if (nameeq(name,nlen,"LFO1ModAmount1"))     s.processLFO1ModAmount1(v);
    else if (nameeq(name,nlen,"LFO1ModAmount2"))     s.processLFO1ModAmount2(v);
    else if (nameeq(name,nlen,"LFO1Wave1"))          s.processLFO1Wave1(v);
    else if (nameeq(name,nlen,"LFO1Wave2"))          s.processLFO1Wave2(v);
    else if (nameeq(name,nlen,"LFO1Wave3"))          s.processLFO1Wave3(v);
    else if (nameeq(name,nlen,"LFO1PW"))             s.processLFO1PW(v);
    else if (nameeq(name,nlen,"LFO1ToOsc1Pitch"))    s.processLFO1ToOsc1Pitch(v);
    else if (nameeq(name,nlen,"LFO1ToOsc2Pitch"))    s.processLFO1ToOsc2Pitch(v);
    else if (nameeq(name,nlen,"LFO1ToFilterCutoff")) s.processLFO1ToFilterCutoff(v);
    else if (nameeq(name,nlen,"LFO1ToOsc1PW"))       s.processLFO1ToOsc1PW(v);
    else if (nameeq(name,nlen,"LFO1ToOsc2PW"))       s.processLFO1ToOsc2PW(v);
    else if (nameeq(name,nlen,"LFO1ToVolume"))       s.processLFO1ToVolume(v);
    // LFO 2 — has no legacy ancestor; only reachable via native .fxp
    else if (nameeq(name,nlen,"LFO2TempoSync"))      s.processLFO2Sync(v);
    else if (nameeq(name,nlen,"LFO2Rate"))           s.processLFO2Rate(v);
    else if (nameeq(name,nlen,"LFO2ModAmount1"))     s.processLFO2ModAmount1(v);
    else if (nameeq(name,nlen,"LFO2ModAmount2"))     s.processLFO2ModAmount2(v);
    else if (nameeq(name,nlen,"LFO2Wave1"))          s.processLFO2Wave1(v);
    else if (nameeq(name,nlen,"LFO2Wave2"))          s.processLFO2Wave2(v);
    else if (nameeq(name,nlen,"LFO2Wave3"))          s.processLFO2Wave3(v);
    else if (nameeq(name,nlen,"LFO2PW"))             s.processLFO2PW(v);
    else if (nameeq(name,nlen,"LFO2ToOsc1Pitch"))    s.processLFO2ToOsc1Pitch(v);
    else if (nameeq(name,nlen,"LFO2ToOsc2Pitch"))    s.processLFO2ToOsc2Pitch(v);
    else if (nameeq(name,nlen,"LFO2ToFilterCutoff")) s.processLFO2ToFilterCutoff(v);
    else if (nameeq(name,nlen,"LFO2ToOsc1PW"))       s.processLFO2ToOsc1PW(v);
    else if (nameeq(name,nlen,"LFO2ToOsc2PW"))       s.processLFO2ToOsc2PW(v);
    else if (nameeq(name,nlen,"LFO2ToVolume"))       s.processLFO2ToVolume(v);
    // FILTER ENVELOPE
    else if (nameeq(name,nlen,"FilterEnvInvert"))    s.processFilterEnvInvert(v);
    else if (nameeq(name,nlen,"FilterEnvAttack"))    s.processFilterEnvAttack(v);
    else if (nameeq(name,nlen,"FilterEnvDecay"))     s.processFilterEnvDecay(v);
    else if (nameeq(name,nlen,"FilterEnvSustain"))   s.processFilterEnvSustain(v);
    else if (nameeq(name,nlen,"FilterEnvRelease"))   s.processFilterEnvRelease(v);
    else if (nameeq(name,nlen,"FilterEnvAttackCurve")) s.processFilterEnvAttackCurve(v);
    else if (nameeq(name,nlen,"VelToFilterEnv"))     s.processVelToFilterEnv(v);
    // AMP ENVELOPE
    else if (nameeq(name,nlen,"AmpEnvAttack"))       s.processAmpEnvAttack(v);
    else if (nameeq(name,nlen,"AmpEnvDecay"))        s.processAmpEnvDecay(v);
    else if (nameeq(name,nlen,"AmpEnvSustain"))      s.processAmpEnvSustain(v);
    else if (nameeq(name,nlen,"AmpEnvRelease"))      s.processAmpEnvRelease(v);
    else if (nameeq(name,nlen,"AmpEnvAttackCurve"))  s.processAmpEnvAttackCurve(v);
    else if (nameeq(name,nlen,"VelToAmpEnv"))        s.processVelToAmpEnv(v);
    // VOICE VARIATION / PAN
    else if (nameeq(name,nlen,"PortamentoSlop"))     s.processPortamentoSlop(v);
    else if (nameeq(name,nlen,"FilterSlop"))         s.processFilterSlop(v);
    else if (nameeq(name,nlen,"EnvelopeSlop"))       s.processEnvelopeSlop(v);
    else if (nameeq(name,nlen,"LevelSlop"))          s.processLevelSlop(v);
    else if (nameeq(name,nlen,"PanVoice1"))          s.processPan(v, 1);
    else if (nameeq(name,nlen,"PanVoice2"))          s.processPan(v, 2);
    else if (nameeq(name,nlen,"PanVoice3"))          s.processPan(v, 3);
    else if (nameeq(name,nlen,"PanVoice4"))          s.processPan(v, 4);
    else if (nameeq(name,nlen,"PanVoice5"))          s.processPan(v, 5);
    else if (nameeq(name,nlen,"PanVoice6"))          s.processPan(v, 6);
    else if (nameeq(name,nlen,"PanVoice7"))          s.processPan(v, 7);
    else if (nameeq(name,nlen,"PanVoice8"))          s.processPan(v, 8);
    // Metadata / non-param attributes (programName, author, category,
    // license, voiceCount, ob-xf_version) are intentionally ignored here.
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
// Order MUST match obxd_set_factory_patch's patch_id indexing — the
// build.sh xxd step emits arrays named patch_<basename-of-fxp>, and we
// expect them in alphabetical order so patch_id 0..9 lines up with the
// instance selector's option order in index.html.
static const unsigned char* g_factory_patches[INSTANCE_COUNT] = {
    patch_01_pad, patch_02_bass, patch_03_lead, patch_04_pluck, patch_05_strings,
    patch_06_keys, patch_07_drone, patch_08_stab, patch_09_hat, patch_10_kick,
};
static const unsigned g_factory_patch_sizes[INSTANCE_COUNT] = {
    sizeof(patch_01_pad), sizeof(patch_02_bass), sizeof(patch_03_lead),
    sizeof(patch_04_pluck), sizeof(patch_05_strings), sizeof(patch_06_keys),
    sizeof(patch_07_drone), sizeof(patch_08_stab), sizeof(patch_09_hat),
    sizeof(patch_10_kick),
};
#endif

// =========================================================================
// C exports (consumed by the AudioWorkletProcessor tail)
// =========================================================================

extern "C" {

// Forward declarations — obxd_init() calls these before their definitions
// appear below; C++ requires them to be in scope at the call site.
EMSCRIPTEN_KEEPALIVE void obxd_set_factory_patch(int instance_id, int patch_id);
EMSCRIPTEN_KEEPALIVE void obxd_set_polyphony(int instance_id, int voice_count);

// Creates all 10 SynthEngine instances, applies the OB-Xf init patch to
// each, and seeds default polyphony (instance 0 polyphonic 8 voices, rest
// mono). Idempotent — frees any prior instances first.
EMSCRIPTEN_KEEPALIVE
void obxd_init(int sample_rate) {
    float sr = sample_rate ? (float)sample_rate : 44100.0f;
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
    if (voice_count > 32) voice_count = 32;   // OB-Xf MAX_VOICES
    g_engine_polyphony[instance_id] = voice_count;
    if (g_engines[instance_id]) {
        float v_new = ((float)(voice_count - 1) + 0.5f) / 32.0f;
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
            if (d2 == 0) s.processNoteOff(d1 & 0x7F, 0.0f, channel);
            else         s.processNoteOn(d1 & 0x7F, (d2 & 0x7F) / 127.0f, channel);
            break;
        case 0xB0:  // CC
            switch (d1 & 0x7F) {
                case 1:    s.processModWheel((d2 & 0x7F) / 127.0f); break;
                case 64:   if (d2 >= 64) s.sustainOn(); else s.sustainOff(); break;
                case 120:  s.allSoundOff();  break;
                case 123:  s.allNotesOff();  break;
                default:   break;
            }
            break;
        case 0xE0: {  // Pitch wheel — 14-bit little-endian, center 8192
            int v = ((d2 & 0x7F) << 7) | (d1 & 0x7F);
            s.processPitchWheel((v - 8192) / 8192.0f);
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
    if (patch_id < 0 || patch_id >= INSTANCE_COUNT) return;
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

EMSCRIPTEN_KEEPALIVE
float obxd_get_instance_rms(int instance_id) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return 0.0f;
    return g_engine_rms[instance_id];
}

// Per-instance MPE enable flag (T9). The OB-Xf engine is channel-aware;
// when MPE is enabled the bridge (task T20) will route each MIDI channel
// to its own note signature. For now obxd_midi_in always passes
// channel=0 regardless of this flag.
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

}  // extern "C"

/*
 * wasm/obxd/main_obxd.cpp — multi-instance Obxd engine wrapper.
 *
 * Replaces the single-instance Phase 2 wrapper with a 10-instance rig:
 * up to 10 SynthEngine instances share one WASM heap, are summed per
 * quantum into a master stereo buffer, and run through an always-on
 * x/(1+|x|) soft-clip before being handed back to the AudioWorklet.
 *
 * Each instance has its own active flag, polyphony, gain, patch name,
 * param mirror, and RMS meter. obxd_init() creates all 10 and seeds
 * them with programmatic factory patches (see g_factory_programs below).
 *
 * If a generated `patches.h` is present at compile time (produced by
 * build.sh's xxd step from real .fxp files in wasm/obxd/patches/), it
 * takes precedence over the programmatic table — see obxd_set_factory_patch.
 *
 * Engine API (per third_party/Obxd/Source/Engine/SynthEngine.h):
 *   - SynthEngine()                       // default ctor, no args
 *   - void setSampleRate(float sr)
 *   - void processSample(float* L, float* R)   // ONE stereo sample
 *   - void procNoteOn(int note, float vel01)
 *   - void procNoteOff(int note)
 *   - void allNotesOff() / allSoundOff()
 *   - void sustainOn() / sustainOff()
 *   - void procPitchWheel(float v)        // [-1, 1] (centered)
 *   - void procModWheel(float v)          // [0, 1]
 *   - void processX(float v)              // ~60 per-param setters
 *   - void setVoiceCount(float v)         // roundToInt(v*7 + 1) voices
 *
 * SynthEngine has NO setParameter(idx, val) dispatch — that lived on
 * the JUCE AudioProcessor wrapper (ObxdAudioProcessor::setParameter in
 * Source/PluginProcessor.cpp). We replicate the switch locally in
 * apply_param_instance() so we can seed defaults and implement
 * _obxd_set_param without depending on PluginProcessor.cpp.
 *
 * Exports are mirrored by the Makefile's -sEXPORTED_FUNCTIONS list and
 * by the per-instance message routing in src/obxd-processor.tail.js.
 */

#include <emscripten.h>
#include <cstdint>
#include <cmath>
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

// juce_audio_basics.h pulls in juce_core.h transitively.
#include <juce_audio_basics/juce_audio_basics.h>

// The Obxd engine headers were authored against JuceHeader.h, which
// ends with `using namespace juce;`. The unqualified `Random`, `String`,
// `jmin`, `float_Pi` references in ObxdVoice.h / ObxdOscillatorB.h /
// AudioUtils.h require the same directive here. Scope is local to this
// TU (and the synth build is a single combined TU).
using namespace juce;

// SynthEngine.h does `#include "../PluginProcessor.h"` for historical
// reasons (the engine doesn't actually use anything from it). The real
// PluginProcessor.h pulls in juce::AudioProcessor (lives in
// juce_audio_processors, which we deliberately don't compile) and
// JuceHeader.h. Predefining its include guard short-circuits the file
// at the #ifndef check, so the include becomes a no-op.
#define PLUGINPROCESSOR_H_INCLUDED 1

#include "SynthEngine.h"
#include "ParamsEnum.h"

// =========================================================================
// Optional real-.fxp factory patches
//
// If build.sh generated patches.h from wasm/obxd/patches/*.fxp, it
// declares `static const unsigned char patch_<name>[]` arrays and is
// accompanied by sizeof() lookups. HAS_FACTORY_FXP then routes
// obxd_set_factory_patch() through load_fxp_data() with those bytes
// instead of the programmatic table below.
// =========================================================================

#if __has_include("patches.h")
#include "patches.h"
#define HAS_FACTORY_FXP 1
#else
#define HAS_FACTORY_FXP 0
#endif

// =========================================================================
// State
// =========================================================================

#define INSTANCE_COUNT 10

// 1024-sample stereo master buffer — comfortably exceeds the 128-sample
// AWP quantum (worklet's RENDER_QUANTUM = 128). The worklet reads the
// first 128 samples of each render via HEAPF32; we always render exactly
// 128. obxd_render() sums every active instance into this pair.
#define BUF_FRAMES 1024

// VST2 preset header layout used by obxd_load_fxp(). All multi-byte
// integer/float fields are big-endian (network byte order), per the
// Steinberg VST2 fxp/fxb spec.
#define FXP_HEADER_SIZE   52    // 0x34 — fixed header before the data section
#define FXP_PRGNAME_OFF   24    // 0x18 — 28-byte program name field
#define FXP_PRGNAME_LEN   28
#define FXP_DATA_OFF      52    // 0x34 — first byte after the header
#define FXP_NUMPARAMS_OFF 20    // 0x14
#define FXP_VERSION_OFF   8     // 0x08
#define FXP_FXID_OFF      12    // 0x0C

static SynthEngine* g_engines[INSTANCE_COUNT] = {};
static bool  g_engine_active[INSTANCE_COUNT] = {};
static int   g_engine_polyphony[INSTANCE_COUNT] = {};
static float g_engine_rms[INSTANCE_COUNT] = {};

// Per-instance param mirror — SynthEngine has no getter API, so we
// maintain our own copy alongside the engine state. _obxd_get_param()
// reads from here; the knob UI uses it to render values after a patch
// load. Indexed [instance_id][param_idx].
static float g_param_mirror[INSTANCE_COUNT][PARAM_COUNT] = {};

// Per-instance last-loaded program name (empty until a load succeeds).
// Sized to FXP_PRGNAME_LEN + small slack; UTF8ToString reads it as a
// null-terminated C string.
static char g_patch_name[INSTANCE_COUNT][64] = {};

// Master mix bus — every active engine's output is summed here each
// quantum, then x/(1+|x|) soft-clipped per sample. The worklet reads
// this via _get_buf_l_ptr / _get_buf_r_ptr and Float32Array views.
static float g_master_l[BUF_FRAMES];
static float g_master_r[BUF_FRAMES];

// =========================================================================
// Parameter dispatch (replicates ObxdAudioProcessor::setParameter)
//
// apply_param_instance() is the instance-aware form of the Phase 2
// apply_param(). It reads g_engines[id] and writes g_param_mirror[id],
// leaving the giant switch statement otherwise identical.
// =========================================================================

static void apply_param_instance(int instance_id, int idx, float v);

// Per-instance form of Phase 2's apply_defaults(). Replicates
// ObxdParams::setDefaultValues() from Source/Engine/Params.h. We can't
// link ObxdParams directly (it transitively depends on the full
// PluginProcessor header chain) so we re-seed the engine the same way
// the upstream AudioProcessor constructor does. Result: a bright-ish
// dual-saw patch with full-level sustain, modest cutoff, and 8 voices.
static void apply_defaults_for_instance(int instance_id) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    for (int i = 0; i < PARAM_COUNT; ++i) apply_param_instance(instance_id, i, 0.0f);

    apply_param_instance(instance_id, VOICE_COUNT,  1.0f);
    apply_param_instance(instance_id, BRIGHTNESS,   1.0f);
    apply_param_instance(instance_id, OCTAVE,       0.5f);
    apply_param_instance(instance_id, TUNE,         0.5f);
    apply_param_instance(instance_id, OSC2_DET,     0.4f);
    apply_param_instance(instance_id, LSUS,         1.0f);
    apply_param_instance(instance_id, CUTOFF,       0.5f);
    apply_param_instance(instance_id, VOLUME,       0.5f);
    apply_param_instance(instance_id, OSC1MIX,      1.0f);
    apply_param_instance(instance_id, OSC2MIX,      1.0f);
    apply_param_instance(instance_id, OSC1Saw,      1.0f);
    apply_param_instance(instance_id, OSC2Saw,      1.0f);
    apply_param_instance(instance_id, BENDLFORATE,  0.6f);
    apply_param_instance(instance_id, PAN1, 0.5f);
    apply_param_instance(instance_id, PAN2, 0.5f);
    apply_param_instance(instance_id, PAN3, 0.5f);
    apply_param_instance(instance_id, PAN4, 0.5f);
    apply_param_instance(instance_id, PAN5, 0.5f);
    apply_param_instance(instance_id, PAN6, 0.5f);
    apply_param_instance(instance_id, PAN7, 0.5f);
    apply_param_instance(instance_id, PAN8, 0.5f);
    apply_param_instance(instance_id, ECONOMY_MODE, 1.0f);
    apply_param_instance(instance_id, ENVDER,       0.3f);
    apply_param_instance(instance_id, FILTERDER,    0.3f);
    apply_param_instance(instance_id, LEVEL_DIF,    0.3f);
    apply_param_instance(instance_id, PORTADER,     0.3f);
    apply_param_instance(instance_id, UDET,         0.2f);
}

// Replicates the switch in ObxdAudioProcessor::setParameter (Source/PluginProcessor.cpp)
// — only the synth.processX(...) calls, not the ObxdAudioProcessor bookkeeping.
// Also writes into g_param_mirror[id] so _obxd_get_param() can report
// current state to the UI (the engine itself has no getter API).
static void apply_param_instance(int instance_id, int idx, float v) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    SynthEngine* e = g_engines[instance_id];
    if (!e) return;
    if (idx < 0 || idx >= PARAM_COUNT) return;
    if (v < 0.0f) v = 0.0f;
    if (v > 1.0f) v = 1.0f;
    g_param_mirror[instance_id][idx] = v;
    SynthEngine& s = *e;
    switch (idx) {
        case SELF_OSC_PUSH:      s.processSelfOscPush(v);        break;
        case PW_ENV_BOTH:        s.processPwEnvBoth(v);          break;
        case PW_OSC2_OFS:        s.processPwOfs(v);              break;
        case ENV_PITCH_BOTH:     s.processPitchModBoth(v);       break;
        case FENV_INVERT:        s.processInvertFenv(v);         break;
        case LEVEL_DIF:          s.processLoudnessDetune(v);     break;
        case PW_ENV:             s.processPwEnv(v);              break;
        case LFO_SYNC:           s.procLfoSync(v);               break;
        case ECONOMY_MODE:       s.procEconomyMode(v);           break;
        case VAMPENV:            s.procAmpVelocityAmount(v);     break;
        case VFLTENV:            s.procFltVelocityAmount(v);     break;
        case ASPLAYEDALLOCATION: s.procAsPlayedAlloc(v);         break;
        case BENDLFORATE:        s.procModWheelFrequency(v);     break;
        case FOURPOLE:           s.processFourPole(v);           break;
        case LEGATOMODE:         s.processLegatoMode(v);         break;
        case ENVPITCH:           s.processEnvelopeToPitch(v);    break;
        case OSCQuantize:        s.processPitchQuantization(v);  break;
        case VOICE_COUNT:        s.setVoiceCount(v);             break;
        case BANDPASS:           s.processBandpassSw(v);         break;
        case FILTER_WARM:        s.processOversampling(v);       break;
        case BENDOSC2:           s.procPitchWheelOsc2Only(v);    break;
        case BENDRANGE:          s.procPitchWheelAmount(v);      break;
        case NOISEMIX:           s.processNoiseMix(v);           break;
        case OCTAVE:             s.processOctave(v);             break;
        case TUNE:               s.processTune(v);               break;
        case BRIGHTNESS:         s.processBrightness(v);         break;
        case MULTIMODE:          s.processMultimode(v);          break;
        case LFOFREQ:            s.processLfoFrequency(v);       break;
        case LFO1AMT:            s.processLfoAmt1(v);            break;
        case LFO2AMT:            s.processLfoAmt2(v);            break;
        case LFOSINWAVE:         s.processLfoSine(v);            break;
        case LFOSQUAREWAVE:      s.processLfoSquare(v);          break;
        case LFOSHWAVE:          s.processLfoSH(v);              break;
        case LFOFILTER:          s.processLfoFilter(v);          break;
        case LFOOSC1:            s.processLfoOsc1(v);            break;
        case LFOOSC2:            s.processLfoOsc2(v);            break;
        case LFOPW1:             s.processLfoPw1(v);             break;
        case LFOPW2:             s.processLfoPw2(v);             break;
        case PORTADER:           s.processPortamentoDetune(v);   break;
        case FILTERDER:          s.processFilterDetune(v);       break;
        case ENVDER:             s.processEnvelopeDetune(v);     break;
        case XMOD:               s.processOsc2Xmod(v);           break;
        case OSC2HS:             s.processOsc2HardSync(v);       break;
        case OSC2P:              s.processOsc2Pitch(v);          break;
        case OSC1P:              s.processOsc1Pitch(v);          break;
        case PORTAMENTO:         s.processPortamento(v);         break;
        case UNISON:             s.processUnison(v);             break;
        case FLT_KF:             s.processFilterKeyFollow(v);    break;
        case OSC1MIX:            s.processOsc1Mix(v);            break;
        case OSC2MIX:            s.processOsc2Mix(v);            break;
        case PW:                 s.processPulseWidth(v);         break;
        case OSC1Saw:            s.processOsc1Saw(v);            break;
        case OSC2Saw:            s.processOsc2Saw(v);            break;
        case OSC1Pul:            s.processOsc1Pulse(v);          break;
        case OSC2Pul:            s.processOsc2Pulse(v);          break;
        case VOLUME:             s.processVolume(v);             break;
        case UDET:               s.processDetune(v);             break;
        case OSC2_DET:           s.processOsc2Det(v);            break;
        case CUTOFF:             s.processCutoff(v);             break;
        case RESONANCE:          s.processResonance(v);          break;
        case ENVELOPE_AMT:       s.processFilterEnvelopeAmt(v);  break;
        case LATK:               s.processLoudnessEnvelopeAttack(v);  break;
        case LDEC:               s.processLoudnessEnvelopeDecay(v);   break;
        case LSUS:               s.processLoudnessEnvelopeSustain(v); break;
        case LREL:               s.processLoudnessEnvelopeRelease(v); break;
        case FATK:               s.processFilterEnvelopeAttack(v);    break;
        case FDEC:               s.processFilterEnvelopeDecay(v);     break;
        case FSUS:               s.processFilterEnvelopeSustain(v);   break;
        case FREL:               s.processFilterEnvelopeRelease(v);   break;
        case PAN1: s.processPan(v, 1); break;
        case PAN2: s.processPan(v, 2); break;
        case PAN3: s.processPan(v, 3); break;
        case PAN4: s.processPan(v, 4); break;
        case PAN5: s.processPan(v, 5); break;
        case PAN6: s.processPan(v, 6); break;
        case PAN7: s.processPan(v, 7); break;
        case PAN8: s.processPan(v, 8); break;
        // MIDILEARN / UNLEARN are UI-only parameters — no engine action.
        default: break;
    }
}

// =========================================================================
// Programmatic factory patches
//
// Used when patches.h is NOT present (i.e. no real .fxp files supplied
// in wasm/obxd/patches/). Each entry is ~15-25 (ParamsEnum.h index, value)
// pairs hand-tuned to match its name. Values are 0..1 per the engine's
// convention; the same switch in apply_param_instance() maps them to the
// correct processX() call.
//
// Patch names MUST match the option labels in index.html's instance
// selector so the UI shows a consistent label after init.
// =========================================================================

struct FactoryParam { int idx; float v; };

struct FactoryProgram {
    const char* name;
    const FactoryParam* params;
    int count;
};

// 0: "Analog Pad" — slow-attack dual-saw pad with a filter sweep.
static const FactoryParam fp_analog_pad[] = {
    { VOLUME,        0.50f },
    { OCTAVE,        0.50f },
    { TUNE,          0.50f },
    { PORTAMENTO,    1.00f },
    { UNISON,        1.00f },
    { UDET,          0.30f },
    { OSC2_DET,      0.40f },
    { OSC1Saw,       1.00f },
    { OSC2Saw,       1.00f },
    { OSC1MIX,       1.00f },
    { OSC2MIX,       1.00f },
    { CUTOFF,        0.30f },
    { RESONANCE,     0.40f },
    { ENVELOPE_AMT,  0.40f },
    { BRIGHTNESS,    0.60f },
    { FLT_KF,        0.50f },
    { LATK,          0.60f },
    { LDEC,          0.50f },
    { LSUS,          0.90f },
    { LREL,          0.70f },
    { FATK,          0.70f },
    { FDEC,          0.50f },
    { FSUS,          0.60f },
    { FREL,          0.70f },
    { ECONOMY_MODE,  1.00f },
};

// 1: "Bass Pulse" — focused low-end pulse bass with a 4-pole filter env.
static const FactoryParam fp_bass_pulse[] = {
    { VOLUME,        0.55f },
    { OCTAVE,        0.00f },
    { TUNE,          0.50f },
    { UNISON,        0.00f },
    { OSC1Saw,       0.00f },
    { OSC1Pul,       1.00f },
    { OSC2Saw,       0.00f },
    { OSC2Pul,       1.00f },
    { OSC1MIX,       1.00f },
    { OSC2MIX,       0.50f },
    { PW,            0.50f },
    { OSC2_DET,      0.20f },
    { CUTOFF,        0.30f },
    { RESONANCE,     0.50f },
    { ENVELOPE_AMT,  0.60f },
    { BRIGHTNESS,    0.50f },
    { FLT_KF,        0.50f },
    { FOURPOLE,      1.00f },
    { LATK,          0.00f },
    { LDEC,          0.40f },
    { LSUS,          0.50f },
    { LREL,          0.30f },
    { FATK,          0.00f },
    { FDEC,          0.40f },
    { FSUS,          0.30f },
    { FREL,          0.30f },
    { ECONOMY_MODE,  1.00f },
};

// 2: "Lead Saw" — bright unison saw lead with mild portamento.
static const FactoryParam fp_lead_saw[] = {
    { VOLUME,        0.50f },
    { OCTAVE,        0.50f },
    { TUNE,          0.50f },
    { PORTAMENTO,    0.90f },
    { UNISON,        1.00f },
    { UDET,          0.25f },
    { OSC2_DET,      0.30f },
    { OSC1Saw,       1.00f },
    { OSC2Saw,       1.00f },
    { OSC1MIX,       1.00f },
    { OSC2MIX,       1.00f },
    { CUTOFF,        0.60f },
    { RESONANCE,     0.30f },
    { ENVELOPE_AMT,  0.20f },
    { BRIGHTNESS,    0.80f },
    { FLT_KF,        0.30f },
    { BENDRANGE,     0.50f },
    { LATK,          0.00f },
    { LDEC,          0.30f },
    { LSUS,          0.80f },
    { LREL,          0.30f },
    { FATK,          0.00f },
    { FDEC,          0.30f },
    { FSUS,          0.50f },
    { FREL,          0.30f },
    { ECONOMY_MODE,  1.00f },
};

// 3: "Pluck" — sharp attack, fast decay, bright saw pluck.
static const FactoryParam fp_pluck[] = {
    { VOLUME,        0.50f },
    { OCTAVE,        0.50f },
    { TUNE,          0.50f },
    { OSC1Saw,       1.00f },
    { OSC1Pul,       0.00f },
    { OSC2Saw,       0.00f },
    { OSC2Pul,       0.00f },
    { OSC1MIX,       1.00f },
    { OSC2MIX,       0.00f },
    { CUTOFF,        0.50f },
    { RESONANCE,     0.40f },
    { ENVELOPE_AMT,  0.70f },
    { BRIGHTNESS,    0.70f },
    { FLT_KF,        0.40f },
    { LATK,          0.00f },
    { LDEC,          0.20f },
    { LSUS,          0.00f },
    { LREL,          0.20f },
    { FATK,          0.00f },
    { FDEC,          0.15f },
    { FSUS,          0.00f },
    { FREL,          0.15f },
    { ECONOMY_MODE,  1.00f },
};

// 4: "Strings" — slow-attack sustained ensemble.
static const FactoryParam fp_strings[] = {
    { VOLUME,        0.50f },
    { OCTAVE,        0.50f },
    { TUNE,          0.50f },
    { UNISON,        1.00f },
    { UDET,          0.30f },
    { OSC2_DET,      0.30f },
    { OSC1Saw,       1.00f },
    { OSC2Saw,       1.00f },
    { OSC1MIX,       0.80f },
    { OSC2MIX,       0.80f },
    { CUTOFF,        0.50f },
    { RESONANCE,     0.20f },
    { ENVELOPE_AMT,  0.00f },
    { BRIGHTNESS,    0.50f },
    { FLT_KF,        0.30f },
    { LATK,          0.70f },
    { LDEC,          0.50f },
    { LSUS,          1.00f },
    { LREL,          0.60f },
    { FATK,          0.50f },
    { FDEC,          0.50f },
    { FSUS,          1.00f },
    { FREL,          0.50f },
    { ECONOMY_MODE,  1.00f },
};

// 5: "Keys" — medium-attack mixed-wave electric-piano-ish tone.
static const FactoryParam fp_keys[] = {
    { VOLUME,        0.50f },
    { OCTAVE,        0.50f },
    { TUNE,          0.50f },
    { OSC1Pul,       1.00f },
    { OSC2Saw,       1.00f },
    { OSC1MIX,       0.70f },
    { OSC2MIX,       0.70f },
    { PW,            0.40f },
    { CUTOFF,        0.60f },
    { RESONANCE,     0.20f },
    { ENVELOPE_AMT,  0.30f },
    { BRIGHTNESS,    0.70f },
    { FLT_KF,        0.50f },
    { LATK,          0.10f },
    { LDEC,          0.40f },
    { LSUS,          0.60f },
    { LREL,          0.40f },
    { FATK,          0.10f },
    { FDEC,          0.40f },
    { FSUS,          0.40f },
    { FREL,          0.40f },
    { ECONOMY_MODE,  1.00f },
};

// 6: "Drone" — heavy-detune sustained pad with slow LFO movement.
static const FactoryParam fp_drone[] = {
    { VOLUME,        0.50f },
    { OCTAVE,        0.50f },
    { TUNE,          0.50f },
    { PORTAMENTO,    0.00f },   // max glide (1-param=1)
    { UNISON,        1.00f },
    { UDET,          0.50f },
    { OSC2_DET,      0.50f },
    { OSC1Saw,       1.00f },
    { OSC2Saw,       1.00f },
    { OSC1MIX,       1.00f },
    { OSC2MIX,       1.00f },
    { LFOSINWAVE,    1.00f },
    { LFOFREQ,       0.20f },
    { LFO1AMT,       0.30f },
    { CUTOFF,        0.30f },
    { RESONANCE,     0.50f },
    { ENVELOPE_AMT,  0.30f },
    { BRIGHTNESS,    0.50f },
    { FLT_KF,        0.30f },
    { LATK,          0.60f },
    { LDEC,          0.60f },
    { LSUS,          1.00f },
    { LREL,          0.90f },
    { FATK,          0.60f },
    { FDEC,          0.60f },
    { FSUS,          0.80f },
    { FREL,          0.90f },
    { ECONOMY_MODE,  1.00f },
};

// 7: "Stab" — sharp, short, bright saw stab.
static const FactoryParam fp_stab[] = {
    { VOLUME,        0.50f },
    { OCTAVE,        0.50f },
    { TUNE,          0.50f },
    { OSC1Saw,       1.00f },
    { OSC2Saw,       1.00f },
    { OSC1MIX,       1.00f },
    { OSC2MIX,       0.90f },
    { OSC2_DET,      0.30f },
    { CUTOFF,        0.70f },
    { RESONANCE,     0.50f },
    { ENVELOPE_AMT,  0.50f },
    { BRIGHTNESS,    0.80f },
    { FLT_KF,        0.30f },
    { LATK,          0.00f },
    { LDEC,          0.20f },
    { LSUS,          0.00f },
    { LREL,          0.15f },
    { FATK,          0.00f },
    { FDEC,          0.20f },
    { FSUS,          0.20f },
    { FREL,          0.20f },
    { ECONOMY_MODE,  1.00f },
};

// 8: "Noise Hat" — bandpass-filtered noise with very short envelopes.
static const FactoryParam fp_noise_hat[] = {
    { VOLUME,        0.45f },
    { OCTAVE,        0.50f },
    { OSC1Saw,       0.00f },
    { OSC1Pul,       0.00f },
    { OSC2Saw,       0.00f },
    { OSC2Pul,       0.00f },
    { OSC1MIX,       0.00f },
    { OSC2MIX,       0.00f },
    { NOISEMIX,      0.60f },
    { CUTOFF,        0.80f },
    { RESONANCE,     0.40f },
    { ENVELOPE_AMT,  0.80f },
    { BRIGHTNESS,    1.00f },
    { FLT_KF,        0.00f },
    { MULTIMODE,     0.70f },
    { BANDPASS,      1.00f },
    { LATK,          0.00f },
    { LDEC,          0.10f },
    { LSUS,          0.00f },
    { LREL,          0.05f },
    { FATK,          0.00f },
    { FDEC,          0.10f },
    { FSUS,          0.00f },
    { FREL,          0.05f },
    { ECONOMY_MODE,  1.00f },
};

// 9: "Kick" — low-octave pulse with pitch-drop filter env.
static const FactoryParam fp_kick[] = {
    { VOLUME,        0.60f },
    { OCTAVE,        0.00f },   // -24 semitones
    { TUNE,          0.50f },
    { OSC1Saw,       0.00f },
    { OSC1Pul,       1.00f },
    { OSC2Saw,       0.00f },
    { OSC2Pul,       0.00f },
    { OSC1MIX,       1.00f },
    { OSC2MIX,       0.00f },
    { PW,            0.50f },
    { CUTOFF,        0.30f },
    { RESONANCE,     0.80f },
    { ENVELOPE_AMT,  0.90f },
    { ENVPITCH,      1.00f },   // 0..1 -> 0..36 semitone env-to-pitch drop
    { BRIGHTNESS,    0.30f },
    { FLT_KF,        0.00f },
    { FOURPOLE,      1.00f },
    { LATK,          0.00f },
    { LDEC,          0.10f },
    { LSUS,          0.00f },
    { LREL,          0.10f },
    { FATK,          0.00f },
    { FDEC,          0.10f },
    { FSUS,          0.00f },
    { FREL,          0.10f },
    { ECONOMY_MODE,  1.00f },
};

static const FactoryProgram g_factory_programs[INSTANCE_COUNT] = {
    { "Analog Pad",  fp_analog_pad,  sizeof(fp_analog_pad)  / sizeof(FactoryParam) },
    { "Bass Pulse",  fp_bass_pulse,  sizeof(fp_bass_pulse)  / sizeof(FactoryParam) },
    { "Lead Saw",    fp_lead_saw,    sizeof(fp_lead_saw)    / sizeof(FactoryParam) },
    { "Pluck",       fp_pluck,       sizeof(fp_pluck)       / sizeof(FactoryParam) },
    { "Strings",     fp_strings,     sizeof(fp_strings)     / sizeof(FactoryParam) },
    { "Keys",        fp_keys,        sizeof(fp_keys)        / sizeof(FactoryParam) },
    { "Drone",       fp_drone,       sizeof(fp_drone)       / sizeof(FactoryParam) },
    { "Stab",        fp_stab,        sizeof(fp_stab)        / sizeof(FactoryParam) },
    { "Noise Hat",   fp_noise_hat,   sizeof(fp_noise_hat)   / sizeof(FactoryParam) },
    { "Kick",        fp_kick,        sizeof(fp_kick)        / sizeof(FactoryParam) },
};

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
// .fxp (VST2 preset) loading — instance-aware
//
// Format (Steinberg VST2 preset spec — all ints/floats big-endian):
//
//   0x00  char[4]  chunkMagic — "Ccka" (regular) or "Ccmb" (chunk)
//   0x04  char[4]  byteMagic  — "FBCh" (ignored)
//   0x08  int32    version    — 1 = regular, 2 = chunk
//   0x0C  char[4]  fxUniqueID — plugin ID (ignored)
//   0x10  int32    fxVersion  — ignored
//   0x14  int32    numParams
//   0x18  char[28] prgName    — null-padded, NOT null-terminated
//   0x34  data:
//           version 1: float[numParams] params (BE floats)
//           version 2: char[4] "FBCh" + int32 chunkSize + char[chunkSize]
//
// Obxd chunk data is the JUCE `copyXmlToBinary` output of an XmlElement
// tree (see Source/PluginProcessor.cpp::setStateInformation /
// setCurrentProgramStateInformation): a 4-byte BE size prefix followed
// by UTF-8 XML of either:
//   • Single-program preset (most .fxp files): the root element carries
//     numeric attributes 0..PARAM_COUNT-1 directly:
//       <Datsounds programName="..." 0="0.5" 1="0.2" ...>
//   • Bank-style chunk (rare for .fxp but legal): nested <programs> with
//     128 <program> children; we use the FIRST program's values.
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
// into a fixed buffer and null-terminate. Used for the prgName field,
// which VST2 leaves null-padded but not null-terminated.
static void copy_name(char* dst, const uint8_t* src, int src_len, size_t n) {
    if (n == 0) return;
    size_t i = 0;
    size_t cap = (size_t)src_len < (n - 1) ? (size_t)src_len : (n - 1);
    for (; i < cap; ++i) {
        char c = (char)src[i];
        // Stop at the field's first NUL pad byte.
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
// each parsed value to instance `instance_id`. See the format notes
// above. Returns the number of (idx,value) pairs successfully applied.
static int parse_chunk_xml_instance(int instance_id, const char* xml, int xml_len) {
    int applied = 0;
    int i = 0;
    // For bank-format chunks we want only the first <program>...</program>.
    // Single-program chunks have no </program> boundary, so we scan to end.
    while (i < xml_len) {
        // Find the next attribute opening: a digit followed by `="` or
        // `='`. (JUCE always emits double quotes; the single-quote branch
        // is defensive.)
        char c = xml[i];
        if (c < '0' || c > '9') {
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
            ++i;
            continue;
        }

        // Parse integer attribute name.
        int idx = 0;
        int j = i;
        while (j < xml_len && xml[j] >= '0' && xml[j] <= '9') {
            idx = idx * 10 + (xml[j] - '0');
            if (idx >= 100000) { idx = 100000; break; }
            ++j;
        }
        // Skip whitespace before `=`.
        while (j < xml_len && (xml[j] == ' ' || xml[j] == '\t')) ++j;
        if (j >= xml_len || xml[j] != '=') { i = j; continue; }
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
            // Use strtod — accepts leading sign, decimals, exponents.
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

// Core loader for a parsed .fxp byte stream. Writes its program name
// into g_patch_name[instance_id]. Returns 0 on success, negative on
// error (see obxd_load_fxp for the rc meaning table).
static int load_fxp_data(int instance_id, const uint8_t* ptr, int len) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return -2;
    if (!g_engines[instance_id]) return -3;
    if (!ptr || len < FXP_HEADER_SIZE) return -4;

    g_patch_name[instance_id][0] = '\0';

    // Magic at offset 0 — "Ccka" (0x43636B61) regular, "Ccmb" (0x43636D62) chunk.
    bool is_regular = (ptr[0] == 'C' && ptr[1] == 'c' && ptr[2] == 'k' && ptr[3] == 'a');
    bool is_chunk   = (ptr[0] == 'C' && ptr[1] == 'c' && ptr[2] == 'm' && ptr[3] == 'b');
    if (!is_regular && !is_chunk) return -5;

    int version  = (int)rd_be_u32(ptr + FXP_VERSION_OFF);
    int num_params = (int)rd_be_u32(ptr + FXP_NUMPARAMS_OFF);
    (void)version;

    copy_name(g_patch_name[instance_id], ptr + FXP_PRGNAME_OFF, FXP_PRGNAME_LEN,
              sizeof(g_patch_name[instance_id]));
    if (g_patch_name[instance_id][0] == '\0') {
        __builtin_memcpy(g_patch_name[instance_id], "(unnamed)", 10);
    }

    const uint8_t* data = ptr + FXP_DATA_OFF;
    int data_len = len - FXP_DATA_OFF;
    if (data_len < 0) return -6;

    if (is_regular) {
        int applied = apply_regular_params_instance(instance_id, data, data_len, num_params);
        if (applied == 0) {
            g_patch_name[instance_id][0] = '\0';
            return -7;
        }
        return 0;
    }

    // Chunk format: expect "FBCh" magic, then int32 BE size, then bytes.
    if (data_len < 8) { g_patch_name[instance_id][0] = '\0'; return -8; }
    if (!(data[0] == 'F' && data[1] == 'B' && data[2] == 'C' && data[3] == 'h')) {
        g_patch_name[instance_id][0] = '\0';
        return -9;
    }
    int chunk_size = (int)rd_be_u32(data + 4);
    if (chunk_size < 4 || chunk_size > data_len - 8) {
        g_patch_name[instance_id][0] = '\0';
        return -10;
    }

    const uint8_t* chunk = data + 8;
    // JUCE's copyXmlToBinary prepends a 4-byte BE size prefix with the
    // XML byte count. We don't need it (we already know chunk_size), so
    // skip 4 bytes and parse the rest as XML text.
    const char* xml = (const char*)(chunk + 4);
    int xml_len = chunk_size - 4;
    if (xml_len <= 0) { g_patch_name[instance_id][0] = '\0'; return -11; }

    int applied = parse_chunk_xml_instance(instance_id, xml, xml_len);
    if (applied == 0) {
        g_patch_name[instance_id][0] = '\0';
        return -12;
    }
    return 0;
}

// Copy a program name (NUL-terminated) into g_patch_name[id], clamped.
static void set_patch_name(int instance_id, const char* name) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    char* dst = g_patch_name[instance_id];
    size_t cap = sizeof(g_patch_name[instance_id]) - 1;
    size_t i = 0;
    for (; i < cap && name && name[i]; ++i) dst[i] = name[i];
    dst[i] = '\0';
}

// =========================================================================
// C exports (consumed by the AudioWorkletProcessor tail)
// =========================================================================

extern "C" {

// Forward declarations — obxd_init() calls these before their definitions
// appear below; C++ requires them to be in scope at the call site.
EMSCRIPTEN_KEEPALIVE void obxd_set_factory_patch(int instance_id, int patch_id);
EMSCRIPTEN_KEEPALIVE void obxd_set_polyphony(int instance_id, int voice_count);

// Creates all 10 SynthEngine instances, applies the matching factory
// patch to each, and seeds default polyphony (instance 0 polyphonic,
// rest mono). Idempotent — frees any prior instances first.
EMSCRIPTEN_KEEPALIVE
void obxd_init(int sample_rate) {
    float sr = sample_rate ? (float)sample_rate : 44100.0f;
    for (int i = 0; i < INSTANCE_COUNT; ++i) {
        if (g_engines[i]) { delete g_engines[i]; g_engines[i] = nullptr; }
        g_engines[i] = new SynthEngine();
        g_engines[i]->setSampleRate(sr);
        for (int p = 0; p < PARAM_COUNT; ++p) g_param_mirror[i][p] = 0.0f;
        g_patch_name[i][0] = '\0';
        apply_defaults_for_instance(i);
        obxd_set_factory_patch(i, i);   // each instance gets its own factory program
        g_engine_active[i] = true;
    }
    // Default polyphony: instance 0 = 8 voices, others = 1 voice.
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

// SynthEngine::setVoiceCount(param) calls roundToInt(param*7+1), so
// param 0 → 1 voice, param 1 → 8 voices (MAX_VOICES). For an integer
// voice_count in [1,8] the corresponding param is (voice_count-1)/7.
// We mirror the int in g_engine_polyphony[id] for obxd_get_polyphony.
EMSCRIPTEN_KEEPALIVE
void obxd_set_polyphony(int instance_id, int voice_count) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    if (voice_count < 1) voice_count = 1;
    if (voice_count > 8) voice_count = 8;
    float param = (float)(voice_count - 1) / 7.0f;
    g_engine_polyphony[instance_id] = voice_count;
    apply_param_instance(instance_id, VOICE_COUNT, param);
}

// Inverse of the set_polyphony mapping: round(param*7+1).
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
// worklet between renders (each pending message is flushed at the top
// of process()). Sample-accurate scheduling is intentionally not
// implemented — the worklet drains at 128-sample boundaries (~2.9ms
// @ 44.1kHz), which is well below perceptible MIDI jitter.
//
// Status byte high nibble routing per the GM standard; we drop all
// system-common / system-real-time bytes (>=0xF0) because the engine
// has no use for them.
EMSCRIPTEN_KEEPALIVE
void obxd_midi_in(int instance_id, uint8_t status, uint8_t d1, uint8_t d2) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    SynthEngine* e = g_engines[instance_id];
    if (!e) return;
    if (status >= 0xF0) return;   // active sensing, clock, sysex, reset, etc.

    SynthEngine& s = *e;
    switch (status & 0xF0) {
        case 0x80:  // Note off
            s.procNoteOff(d1 & 0x7F);
            break;
        case 0x90:  // Note on; velocity 0 is interpreted as note-off
            if (d2 == 0) s.procNoteOff(d1 & 0x7F);
            else         s.procNoteOn(d1 & 0x7F, (d2 & 0x7F) / 127.0f);
            break;
        case 0xB0:  // CC
            switch (d1 & 0x7F) {
                case 1:    s.procModWheel((d2 & 0x7F) / 127.0f); break;
                case 64:   if (d2 >= 64) s.sustainOn(); else s.sustainOff(); break;
                case 120:  s.allSoundOff();  break;
                case 123:  s.allNotesOff();  break;
                default:   break;
            }
            break;
        case 0xE0: {  // Pitch wheel — 14-bit little-endian, center 8192
            int v = ((d2 & 0x7F) << 7) | (d1 & 0x7F);
            s.procPitchWheel((v - 8192) / 8192.0f);
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
// apply_param_instance() so it accepts the same indices as ParamsEnum.h.
EMSCRIPTEN_KEEPALIVE
void obxd_set_param(int instance_id, int idx, double value) {
    if (value < 0.0) value = 0.0;
    if (value > 1.0) value = 1.0;
    apply_param_instance(instance_id, idx, (float)value);
}

// Returns the last-applied value for instance `instance_id`'s parameter
// `idx`, or -1 if out of range / not initialized. The UI calls this to
// render knob positions after a default-patch or .fxp load.
EMSCRIPTEN_KEEPALIVE
float obxd_get_param(int instance_id, int idx) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return -1.0f;
    if (idx < 0 || idx >= PARAM_COUNT) return -1.0f;
    return g_param_mirror[instance_id][idx];
}

EMSCRIPTEN_KEEPALIVE
int obxd_load_fxp(int instance_id, uint8_t* ptr, int len) {
    return load_fxp_data(instance_id, ptr, len);
}

// Per-instance reset to the engine defaults. Clears the loaded patch
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
// patches.h is present (real .fxp files were supplied at build time)
// we route through load_fxp_data(); otherwise we apply the programmatic
// fallback table for that patch_id.
//
// In both paths we first reset via apply_defaults_for_instance() so a
// previous patch's parameters don't bleed through (the programmatic
// tables and .fxp files only specify the params they care about).
EMSCRIPTEN_KEEPALIVE
void obxd_set_factory_patch(int instance_id, int patch_id) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return;
    if (patch_id < 0 || patch_id >= INSTANCE_COUNT) return;
    apply_defaults_for_instance(instance_id);

#if HAS_FACTORY_FXP
    load_fxp_data(instance_id, g_factory_patches[patch_id], (int)g_factory_patch_sizes[patch_id]);
#else
    const FactoryProgram& prog = g_factory_programs[patch_id];
    for (int i = 0; i < prog.count; ++i) {
        apply_param_instance(instance_id, prog.params[i].idx, prog.params[i].v);
    }
    set_patch_name(instance_id, prog.name);
#endif
}

EMSCRIPTEN_KEEPALIVE
float obxd_get_instance_rms(int instance_id) {
    if (instance_id < 0 || instance_id >= INSTANCE_COUNT) return 0.0f;
    return g_engine_rms[instance_id];
}

// Backwards-compat no-op for the Phase 1 worklet's `note` branch
// (which still calls _obxd_set_freq). If a stale message arrives,
// we silently drop it instead of breaking the export list.
EMSCRIPTEN_KEEPALIVE
void obxd_set_freq(double freq) { (void)freq; /* no-op */ }

}  // extern "C"

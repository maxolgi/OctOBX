/*
 * wasm/obxd/main_obxd.cpp — Phase 2: real Obxd synthesizer engine.
 *
 * Wraps a single SynthEngine instance from 2DaT/Obxd and exposes the
 * same C ABI as Phase 1's sine-wave stub (_obxd_init, _obxd_render,
 * _get_buf_l_ptr, _get_buf_r_ptr) plus new MIDI and parameter exports
 * (_obxd_midi_in, _obxd_all_notes_off, _obxd_set_param). The
 * AudioWorkletProcessor wrapper in src/obxd-processor.tail.js keeps
 * its existing structure; the only change to it is a small additive
 * drain of its pendingMidi queue into _obxd_midi_in before each
 * render call.
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
 *
 * SynthEngine has NO setParameter(idx, val) dispatch — that lived on
 * the JUCE AudioProcessor wrapper (ObxdAudioProcessor::setParameter in
 * Source/PluginProcessor.cpp). We replicate the switch locally in
 * apply_param() so we can seed defaults and implement _obxd_set_param
 * without depending on PluginProcessor.cpp.
 *
 * Exports are mirrored by the Makefile's -sEXPORTED_FUNCTIONS list
 * (the synth build has no octopus-types.ts counterpart — update both
 * the EXPORTS line below and the tail.js drain loop when changing).
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
// State
// =========================================================================

// 1024-sample stereo buffer — comfortably exceeds the 128-sample AWP
// quantum (worklet's RENDER_QUANTUM = 128). The worklet reads the first
// 128 samples of each render via HEAPF32; we always render exactly 128.
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

static SynthEngine* g_engine = nullptr;
static float g_buf_l[BUF_FRAMES];
static float g_buf_r[BUF_FRAMES];

// Mirror of every parameter applied via apply_param(). SynthEngine has
// no getter API (the JUCE wrapper kept the canonical state), so we
// maintain our own copy. _obxd_get_param() reads from here, and the
// knob UI uses it to render default values after apply_defaults() /
// applyObxdDefaultPatch() / .fxp load.
static float g_param_mirror[PARAM_COUNT];

// Last-loaded .fxp program name (empty string until a load succeeds).
// Sized to FXP_PRGNAME_LEN + a small slack; UTF8ToString reads it as
// a null-terminated C string.
static char g_patch_name[64] = {0};

// =========================================================================
// Parameter dispatch (replicates ObxdAudioProcessor::setParameter)
// =========================================================================

static void apply_param(int idx, float v);

// Replicates ObxdParams::setDefaultValues() from Source/Engine/Params.h.
// We can't link ObxdParams directly (it transitively depends on the full
// PluginProcessor header chain) so we re-seed the engine the same way
// the upstream AudioProcessor constructor does. Result: a bright-ish
// dual-saw patch with full-level sustain, modest cutoff, and 2 voices.
static void apply_defaults(void) {
    for (int i = 0; i < PARAM_COUNT; ++i) apply_param(i, 0.0f);

    apply_param(VOICE_COUNT,  1.0f);
    apply_param(BRIGHTNESS,   1.0f);
    apply_param(OCTAVE,       0.5f);
    apply_param(TUNE,         0.5f);
    apply_param(OSC2_DET,     0.4f);
    apply_param(LSUS,         1.0f);
    apply_param(CUTOFF,       0.5f);
    apply_param(VOLUME,       0.5f);
    apply_param(OSC1MIX,      1.0f);
    apply_param(OSC2MIX,      1.0f);
    apply_param(OSC1Saw,      1.0f);
    apply_param(OSC2Saw,      1.0f);
    apply_param(BENDLFORATE,  0.6f);
    apply_param(PAN1, 0.5f); apply_param(PAN2, 0.5f);
    apply_param(PAN3, 0.5f); apply_param(PAN4, 0.5f);
    apply_param(PAN5, 0.5f); apply_param(PAN6, 0.5f);
    apply_param(PAN7, 0.5f); apply_param(PAN8, 0.5f);
    apply_param(ECONOMY_MODE, 1.0f);
    apply_param(ENVDER,       0.3f);
    apply_param(FILTERDER,    0.3f);
    apply_param(LEVEL_DIF,    0.3f);
    apply_param(PORTADER,     0.3f);
    apply_param(UDET,         0.2f);
}

// Replicates the switch in ObxdAudioProcessor::setParameter (Source/PluginProcessor.cpp)
// — only the synth.processX(...) calls, not the ObxdAudioProcessor bookkeeping.
// Also writes into g_param_mirror so _obxd_get_param() can report current state
// to the UI (the engine itself has no getter API).
static void apply_param(int idx, float v) {
    if (!g_engine) return;
    if (idx < 0 || idx >= PARAM_COUNT) return;
    if (v < 0.0f) v = 0.0f;
    if (v > 1.0f) v = 1.0f;
    g_param_mirror[idx] = v;
    SynthEngine& s = *g_engine;
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
// C exports (consumed by the AudioWorkletProcessor tail)
// =========================================================================

extern "C" {

EMSCRIPTEN_KEEPALIVE
void obxd_init(int sample_rate) {
    if (g_engine) { delete g_engine; g_engine = nullptr; }
    g_engine = new SynthEngine();
    g_engine->setSampleRate(sample_rate ? (float)sample_rate : 44100.0f);
    for (int i = 0; i < PARAM_COUNT; ++i) g_param_mirror[i] = 0.0f;
    g_patch_name[0] = '\0';
    apply_defaults();
    // Make sure no voice is mid-release when first audio is requested.
    g_engine->allSoundOff();
}

// The worklet's gain slider sends 0..1 (after pre-multiplying the raw
// slider value by 0.4). processVolume scales 0..1 -> 0..0.30 linear,
// so a slider at max yields ~0.12 linear master gain — safe for a
// 8-voice synth hitting a resonant filter.
EMSCRIPTEN_KEEPALIVE
void obxd_set_gain(double gain) {
    if (!g_engine) return;
    if (gain < 0.0) gain = 0.0;
    if (gain > 1.0) gain = 1.0;
    g_engine->processVolume((float)gain);
}

// Render `n` samples into the static stereo buffer. The AudioWorklet
// calls this with n=128 each quantum, then copies the first 128 frames
// out via HEAPF32. SynthEngine::processSample is sample-at-a-time, so
// we just loop. economyMode (default ON) skips inactive voices.
EMSCRIPTEN_KEEPALIVE
void obxd_render(int n) {
    if (!g_engine) return;
    if (n < 0) n = 0;
    if (n > BUF_FRAMES) n = BUF_FRAMES;
    for (int i = 0; i < n; ++i) {
        g_engine->processSample(&g_buf_l[i], &g_buf_r[i]);
    }
}

// Synchronous MIDI message handler. Called from the worklet between
// renders (each pending message is flushed at the top of process()).
// Sample-accurate scheduling is intentionally not implemented — the
// worklet drains at 128-sample boundaries (~2.9ms @ 44.1kHz), which is
// well below perceptible MIDI jitter.
//
// Status byte high nibble routing per the GM standard; we drop all
// system-common / system-real-time bytes (>=0xF0) because the engine
// has no use for them.
EMSCRIPTEN_KEEPALIVE
void obxd_midi_in(uint8_t status, uint8_t d1, uint8_t d2) {
    if (!g_engine) return;
    if (status >= 0xF0) return;   // active sensing, clock, sysex, reset, etc.

    SynthEngine& s = *g_engine;
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
void obxd_all_notes_off(void) {
    if (g_engine) g_engine->allNotesOff();
}

EMSCRIPTEN_KEEPALIVE
float* get_buf_l_ptr(void) { return g_buf_l; }

EMSCRIPTEN_KEEPALIVE
float* get_buf_r_ptr(void) { return g_buf_r; }

// Phase 3 hook for the future knob UI; clamps and dispatches via
// apply_param() so it accepts the same indices as ParamsEnum.h.
EMSCRIPTEN_KEEPALIVE
void obxd_set_param(int idx, double value) {
    if (value < 0.0) value = 0.0;
    if (value > 1.0) value = 1.0;
    apply_param(idx, (float)value);
}

// =========================================================================
// .fxp (VST2 preset) loading
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
// section. Returns the number of parameters applied.
static int apply_regular_params(const uint8_t* data, int data_len, int num_params) {
    if (num_params < 0) num_params = 0;
    if (num_params > PARAM_COUNT) num_params = PARAM_COUNT;
    int applied = 0;
    for (int i = 0; i < num_params; ++i) {
        int off = i * 4;
        if (off + 4 > data_len) break;
        float v = rd_be_f32(data + off);
        apply_param(i, v);
        ++applied;
    }
    return applied;
}

// Parse JUCE-flavoured XML chunk for Obxd parameter values.
//
// The XML is either:
//   <Datsounds programName="X" 0="0.5" 1="0.2" ...>            (single)
//   <Datsounds currentProgram="N"><programs><program ...>...   (bank)
//
// We scan for attributes whose name is a small non-negative integer
// (matching ParamsEnum.h indices) and whose value parses as a float.
// For bank-style chunks, we stop at the first </program> close tag so
// only the first program is applied (matching setCurrentProgram(int 0)).
//
// Returns the number of (idx,value) pairs successfully applied.
static int parse_chunk_xml(const char* xml, int xml_len) {
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
                apply_param(idx, (float)dv);
                ++applied;
            }
        }

        i = j;
    }
    return applied;
}

EMSCRIPTEN_KEEPALIVE
int obxd_load_fxp(uint8_t* ptr, int len) {
    if (!g_engine) return -3;
    if (!ptr || len < FXP_HEADER_SIZE) return -4;

    g_patch_name[0] = '\0';

    // Magic at offset 0 — "Ccka" (0x43636B61) regular, "Ccmb" (0x43636D62) chunk.
    bool is_regular = (ptr[0] == 'C' && ptr[1] == 'c' && ptr[2] == 'k' && ptr[3] == 'a');
    bool is_chunk   = (ptr[0] == 'C' && ptr[1] == 'c' && ptr[2] == 'm' && ptr[3] == 'b');
    if (!is_regular && !is_chunk) return -5;

    int version = (int)rd_be_u32(ptr + FXP_VERSION_OFF);
    int num_params = (int)rd_be_u32(ptr + FXP_NUMPARAMS_OFF);

    copy_name(g_patch_name, ptr + FXP_PRGNAME_OFF, FXP_PRGNAME_LEN, sizeof(g_patch_name));
    if (g_patch_name[0] == '\0') {
        __builtin_memcpy(g_patch_name, "(unnamed)", 10);
    }

    const uint8_t* data = ptr + FXP_DATA_OFF;
    int data_len = len - FXP_DATA_OFF;
    if (data_len < 0) return -6;

    if (is_regular) {
        int applied = apply_regular_params(data, data_len, num_params);
        if (applied == 0) {
            g_patch_name[0] = '\0';
            return -7;
        }
        return 0;
    }

    // Chunk format: expect "FBCh" magic, then int32 BE size, then bytes.
    if (data_len < 8) { g_patch_name[0] = '\0'; return -8; }
    if (!(data[0] == 'F' && data[1] == 'B' && data[2] == 'C' && data[3] == 'h')) {
        g_patch_name[0] = '\0';
        return -9;
    }
    int chunk_size = (int)rd_be_u32(data + 4);
    if (chunk_size < 4 || chunk_size > data_len - 8) {
        g_patch_name[0] = '\0';
        return -10;
    }

    const uint8_t* chunk = data + 8;
    // JUCE's copyXmlToBinary prepends a 4-byte BE size prefix with the
    // XML byte count. We don't need it (we already know chunk_size), so
    // skip 4 bytes and parse the rest as XML text.
    const char* xml = (const char*)(chunk + 4);
    int xml_len = chunk_size - 4;
    if (xml_len <= 0) { g_patch_name[0] = '\0'; return -11; }

    int applied = parse_chunk_xml(xml, xml_len);
    if (applied == 0) {
        g_patch_name[0] = '\0';
        return -12;
    }
    return 0;
}

// Returns the last-applied value for parameter `idx`, or -1 if out of
// range / not initialized. The UI calls this to render knob positions
// after a default-patch or .fxp load.
EMSCRIPTEN_KEEPALIVE
float obxd_get_param(int idx) {
    if (idx < 0 || idx >= PARAM_COUNT) return -1.0f;
    return g_param_mirror[idx];
}

// C-string pointer to the last successfully loaded patch name. Empty
// string until obxd_load_fxp succeeds (or after a failed load).
EMSCRIPTEN_KEEPALIVE
const char* obxd_get_patch_name(void) {
    return g_patch_name;
}

// Panic: kill all sounding voices immediately. SynthEngine::allSoundOff
// calls allNotesOff AND resets every voice envelope, so no release tail
// is produced — this is the "everything off NOW" button.
EMSCRIPTEN_KEEPALIVE
void obxd_panic(void) {
    if (g_engine) g_engine->allSoundOff();
}

// Re-apply the engine's default patch and clear the loaded-patch name.
// The AudioWorklet/UI then re-applies applyObxdDefaultPatch() on top
// for the sequencer-friendly overrides (LATK/LREL/etc.).
EMSCRIPTEN_KEEPALIVE
void obxd_reset_patch(void) {
    if (!g_engine) return;
    apply_defaults();
    g_patch_name[0] = '\0';
}

// Backwards-compat no-op for the Phase 1 worklet's `note` branch
// (which still calls _obxd_set_freq). If a stale message arrives,
// we silently drop it instead of breaking the export list.
EMSCRIPTEN_KEEPALIVE
void obxd_set_freq(double freq) { (void)freq; /* no-op */ }

}  // extern "C"

// OctOBX: Phase 1-b eq guitarix faust classes, wrapped headless into one TU
// (same pattern as gxfx_dsp.cpp / gxfx_dsp_drive.cpp: each include wrapped
// in its own namespace together with the PortIndex enum — transcribed from
// gx_<fx>.lv2/gx_<fx>.h for bundles, or from the trailing PortIndex comment
// in the .cc itself for orphans — because the enums would collide at global
// scope). Effect ids 28..33 — same order as the generator manifest
// (tools/gen-gxfx-params.mjs) and the factory table in gxfx_host.cpp
// (static_assert-guarded against GXFX_EFFECT_COUNT).
//
// Compile (syntax check):
//   em++ -std=c++20 -O2 -fsyntax-only \
//     -I wasm/obxd \
//     -I third_party/guitarix/trunk/src/LV2/faust-generated \
//     -I third_party/guitarix/trunk/src/LV2/faust \
//     -Wno-vla-cxx-extension \
//     wasm/obxd/gxfx_dsp_eq.cpp
#include "gxfx_prelude.h"
#include "../../third_party/guitarix/trunk/src/LV2/DSP/gx_pluginlv2.h"

// gx_graphiceq.lv2 — 11-band graphic EQ. PortIndex transcribed from
// gx_graphiceq.lv2/gx_graphiceq.h (ttl order: G1..G11 params, V1..V11 band
// meters, then the audio pair). The class's compute() unconditionally
// dereferences its bargraph (meter) pointers via #define, and the engine's
// out-port surface stays unwired (Phase 0 policy — g_fx_out in
// gxfx_host.cpp), so the factory parks V1..V11 on TU-local scratch floats:
// throwaway meter values nobody reads, without which the first render would
// write through uninitialized pointers.
namespace gxfx_graphiceq {
typedef enum {
    G1, G2, G3, G4, G5, G6, G7, G8, G9, G10, G11,
    V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11,
    EFFECTS_OUTPUT, EFFECTS_INPUT,
} PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/graphiceq.cc"

static float g_meter_scratch[11];
PluginLV2* create() {
    PluginLV2* p = graphiceq::plugin();
    if (p && p->connect_ports) {
        for (int i = V1; i <= V11; ++i)
            p->connect_ports((uint32_t)i, &g_meter_scratch[i - V1], p);
    }
    return p;
}
}

// --- orphans (no .lv2 bundle; param enums from the .cc PortIndex comment) ---

// selecteq.cc — 30 params: per band (31.25 Hz .. 16 kHz) quality, frequency
// and gain sliders; enum order is the faust-generated alphabetical-ish order
// (QS125 first, FS8K last), NOT band order — keep verbatim.
namespace gxfx_selecteq {
typedef enum {
    QS125, QS16K, QS1K, QS250, QS2K, QS31_25, QS4K, QS500, QS62_5, QS8K,
    FREQ125, FREQ16K, FREQ1K, FREQ250, FREQ2K, FREQ31_25, FREQ4K, FREQ500, FREQ62_5, FREQ8K,
    FS125, FS16K, FS1K, FS250, FS2K, FS31_25, FS4K, FS500, FS62_5, FS8K,
} PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/selecteq.cc"
}

// tonecontroll.cc — 3-band EQ. Natively 2-in/2-out (stereo_audio only,
// mono_audio == 0), so the host runs it on its native stereo path.
namespace gxfx_tonecontroll {
typedef enum { BASS, MIDDLE, ON, TREBLE, SHARPER } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/tonecontroll.cc"
}

// moog.cc — 4-pole moog ladder filter. Also natively 2-in/2-out.
namespace gxfx_moog {
typedef enum { Q, FR } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/moog.cc"
}

// low_high_pass.cc — speaker band-pass stage (LOWFREQ/HIGHFREQ/ONOFF)
// cascaded with a low/high-pass stage (LOW_FREQ/HIGH_FREQ/ON_OFF).
namespace gxfx_low_high_pass {
typedef enum { HIGHFREQ, LOWFREQ, ONOFF, HIGH_FREQ, LOW_FREQ, ON_OFF } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/low_high_pass.cc"
}

namespace gxfx_noise_shaper {
typedef enum { SHARPER } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/noise_shaper.cc"
}

// namespace paths: gxfx_graphiceq::graphiceq::plugin() etc. Factory order
// MUST match the generator manifest order (ids 28..33).
typedef PluginLV2* (*gxfx_factory)();
PluginLV2* gxfx_create_graphiceq() { return gxfx_graphiceq::create(); }
PluginLV2* gxfx_create_selecteq() { return gxfx_selecteq::selecteq::plugin(); }
PluginLV2* gxfx_create_tonecontroll() { return gxfx_tonecontroll::tonecontroll::plugin(); }
PluginLV2* gxfx_create_moog() { return gxfx_moog::moog::plugin(); }
PluginLV2* gxfx_create_low_high_pass() { return gxfx_low_high_pass::low_high_pass::plugin(); }
PluginLV2* gxfx_create_noise_shaper() { return gxfx_noise_shaper::noise_shaper::plugin(); }

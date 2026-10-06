// OctOBX: 11 guitarix faust-generated DSP classes wrapped headless into one TU.
// Each include is wrapped in its own namespace together with the PortIndex enum
// (transcribed from gx_<fx>.lv2/gx_<fx>.h) because the enums would collide at
// global scope. The DSP namespace lives nested inside (e.g. gxfx_wah::gcb_95).
//
// Compile (syntax check):
//   em++ -std=c++20 -O2 -fsyntax-only \
//     -I wasm/obxd \
//     -I third_party/guitarix/trunk/src/LV2/faust-generated \
//     -I third_party/guitarix/trunk/src/LV2/faust \
//     -I third_party/guitarix/trunk/src/zita-resampler-1.1.0 \
//     -Wno-vla-cxx-extension \
//     wasm/obxd/gxfx_dsp.cpp
//   (-Wno-vla-cxx-extension: bossds1.cc line 231 uses a VLA,
//    FAUSTFLOAT buf[smp.max_out_count(count)] — clang accepts it as an
//    extension; we cannot patch third_party.)
#include "gxfx_prelude.h"
#include "../../third_party/guitarix/trunk/src/LV2/DSP/gx_pluginlv2.h"

// bossds1.cc (gx_distortion) uses gx_resample::FixedRateResampler for
// oversampling. Pull the real implementation into this TU so it is
// link-complete: gx_resampler.cc + zita resampler.cc + resampler-table.cc
// (zita-resampler-1.1.0 is bundled in the guitarix submodule).
#include "../../third_party/guitarix/trunk/src/LV2/DSP/gx_resampler.h"
#include "../../third_party/guitarix/trunk/src/LV2/DSP/gx_resampler.cc"
#include "../../third_party/guitarix/trunk/src/zita-resampler-1.1.0/resampler-table.cc"
#include "../../third_party/guitarix/trunk/src/zita-resampler-1.1.0/resampler.cc"

namespace gxfx_wah {
typedef enum { EFFECTS_OUTPUT, EFFECTS_INPUT, VOLUME, HOTPOTZ } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/gcb_95.cc"
}

namespace gxfx_overdrive {
typedef enum { EFFECTS_OUTPUT, EFFECTS_INPUT, SCREAM } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/scream.cc"
}

namespace gxfx_distortion {
typedef enum { EFFECTS_OUTPUT, EFFECTS_INPUT, LEVEL, TONE, DRIVE, BYPASS } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/bossds1.cc"
}

namespace gxfx_compressor {
typedef enum { RATIO, KNEE, THRESHOLD, RELEASE, ATTACK, EFFECTS_OUTPUT, EFFECTS_INPUT, BYPASS } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/compressor.cc"
}

namespace gxfx_chorus {
typedef enum { LEVEL, DELAY, DEPTH, FREQ, EFFECTS_OUTPUT, EFFECTS_OUTPUT1, EFFECTS_INPUT, EFFECTS_INPUT1, BYPASS } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/chorus.cc"
}

namespace gxfx_flanger {
typedef enum { DEPTH, WIDTH, FREQ, FEEDBACK, WET, MIX, EFFECTS_OUTPUT, EFFECTS_INPUT } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/gx_flanger.cc"
}

namespace gxfx_phaser {
typedef enum { WET_DRY, LEVEL, SPEED, EFFECTS_OUTPUT, EFFECTS_INPUT } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/phaser_mono.cc"
}

namespace gxfx_tremolo {
typedef enum { WET_DRY, SINE, DEPTH, FREQ, EFFECTS_OUTPUT, EFFECTS_INPUT, RESET } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/tremolo.cc"
}

namespace gxfx_delay {
typedef enum { INVERT, R_GAIN, R_DELAY, L_GAIN, L_DELAY, LFOFREQ, LINK, EFFECTS_OUTPUT, EFFECTS_OUTPUT1, EFFECTS_INPUT, EFFECTS_INPUT1, BYPASS } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/stereodelay.cc"
}

namespace gxfx_echo {
typedef enum { INVERT, PERCENT_R, TIME_R, PERCENT_L, TIME_L, LFOFREQ, LINK, EFFECTS_OUTPUT, EFFECTS_OUTPUT1, EFFECTS_INPUT, EFFECTS_INPUT1, BYPASS } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/stereoecho.cc"
}

namespace gxfx_reverb {
typedef enum { WET_DRY, LFOFREQ, ROOMSIZE, DAMP, INVERT, EFFECTS_OUTPUT, EFFECTS_OUTPUT1, EFFECTS_INPUT, EFFECTS_INPUT1 } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/stereoverb.cc"
}

// gx_bmp.lv2 — "GxBigMuffPi" (Phase 1-h enumeration-audit find: a real,
// working insert the plan's lists never enumerate; NOT the gx_fuzz
// composite's bmfp part, and distinct from gx_muff — the full Big Muff PI
// circuit with the SUSTAIN stage). Rides THIS TU because its .cc uses
// gx_resample::FixedRateResampler like bossds1 — gx_resampler.cc + the
// zita resampler sources are link-complete here only (a second TU pulling
// them would duplicate the zita symbols). PortIndex from
// gx_bmp.lv2/gx_bmp.h (audio pair first, params at ttl indexes 2..4).
namespace gxfx_bmp {
typedef enum { EFFECTS_OUTPUT, EFFECTS_INPUT, SUSTAIN, TONE, VOLUME } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/bmp.cc"
}

// namespace paths: gxfx_wah::gcb_95::plugin() etc.
typedef PluginLV2* (*gxfx_factory)();
PluginLV2* gxfx_create_wah() { return gxfx_wah::gcb_95::plugin(); }
PluginLV2* gxfx_create_overdrive() { return gxfx_overdrive::scream::plugin(); }
PluginLV2* gxfx_create_distortion() { return gxfx_distortion::bossds1::plugin(); }
PluginLV2* gxfx_create_compressor() { return gxfx_compressor::compressor::plugin(); }
PluginLV2* gxfx_create_chorus() { return gxfx_chorus::chorus::plugin(); }
PluginLV2* gxfx_create_flanger() { return gxfx_flanger::gx_flanger::plugin(); }
PluginLV2* gxfx_create_phaser() { return gxfx_phaser::phaser_mono::plugin(); }
PluginLV2* gxfx_create_tremolo() { return gxfx_tremolo::tremolo::plugin(); }
PluginLV2* gxfx_create_delay() { return gxfx_delay::stereodelay::plugin(); }
PluginLV2* gxfx_create_echo() { return gxfx_echo::stereoecho::plugin(); }
PluginLV2* gxfx_create_reverb() { return gxfx_reverb::stereoverb::plugin(); }
PluginLV2* gxfx_create_bigmuffpi() { return gxfx_bmp::bmp::plugin(); }

// OctOBX: Phase 1-a drive + dynamics guitarix faust classes, wrapped
// headless into one TU (same pattern as gxfx_dsp.cpp: each include wrapped
// in its own namespace together with the PortIndex enum transcribed from
// gx_<fx>.lv2/gx_<fx>.h, because the enums would collide at global scope;
// orphan classes get the param-only enum from the trailing PortIndex
// comment in the .cc itself). Effect ids 11..27 — same order as the
// generator manifest (tools/gen-gxfx-params.mjs) and the factory table in
// gxfx_host.cpp (static_assert-guarded against GXFX_EFFECT_COUNT).
//
// Compile (syntax check):
//   em++ -std=c++20 -O2 -fsyntax-only \
//     -I wasm/obxd \
//     -I third_party/guitarix/trunk/src/LV2/faust-generated \
//     -I third_party/guitarix/trunk/src/LV2/faust \
//     -I third_party/guitarix/trunk/src/LV2/DSP \
//     -I third_party/guitarix/trunk/src/LV2/DSP/tube_tables \
//     -Wno-vla-cxx-extension \
//     wasm/obxd/gxfx_dsp_drive.cpp
#include "gxfx_prelude.h"
#include "../../third_party/guitarix/trunk/src/LV2/DSP/gx_pluginlv2.h"

// Include-once trick (fx2plan.md, same as the amps valve.h plan): trany.h
// (tube transfer tables + Ftrany/Rtrany interpolation, used by fuzzface,
// fuzzfacefm, fumaster, muff, cstb, susta) carries an include guard, so
// pulling it in at GLOBAL scope here neuters each faust .cc's own include
// — tables defined once, shared by all classes via ::Ftrany unqualified
// lookup from inside their namespaces.
#include "../../third_party/guitarix/trunk/src/LV2/DSP/trany.h"

// muff.cc / aclipper.cc oversample their clipping stage via
// gx_resample::FixedRateResampler. Header only — the implementation
// (gx_resampler.cc + the vendored zita resampler) is compiled into
// gxfx_dsp.cpp's TU and links from there.
#include "../../third_party/guitarix/trunk/src/LV2/DSP/gx_resampler.h"

namespace gxfx_fuzzface {
typedef enum { EFFECTS_OUTPUT, EFFECTS_INPUT, FUZZ, LEVEL } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/fuzzface.cc"
}

namespace gxfx_fuzzfacefm {
typedef enum { EFFECTS_OUTPUT, EFFECTS_INPUT, DRIVE, FUZZ, AUDIO_IN, LEVEL } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/fuzzfacefm.cc"
}

namespace gxfx_fumaster {
typedef enum { EFFECTS_OUTPUT, EFFECTS_INPUT, TONE, VOLUME, WET_DRY } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/fumaster.cc"
}

namespace gxfx_hornet {
typedef enum { EFFECTS_OUTPUT, EFFECTS_INPUT, FUZZ, SUSTAIN, VOLUME } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/hornet.cc"
}

namespace gxfx_muff {
typedef enum { EFFECTS_OUTPUT, EFFECTS_INPUT, TONE, VOLUME } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/muff.cc"
}

namespace gxfx_cstb {
typedef enum { EFFECTS_OUTPUT, EFFECTS_INPUT, ATTACK, LEVEL, WET_DRY, BYPASS } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/cstb.cc"
}

namespace gxfx_aclipper {
typedef enum { EFFECTS_OUTPUT, EFFECTS_INPUT, DRIVE, LEVEL, TONE, BYPASS } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/aclipper.cc"
}

namespace gxfx_mxrdist {
typedef enum { EFFECTS_OUTPUT, EFFECTS_INPUT, VOLUME, DRIVE } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/mxrdist.cc"
}

namespace gxfx_rangem {
typedef enum { EFFECTS_OUTPUT, EFFECTS_INPUT, BOOST, WET_DRY } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/rangem.cc"
}

namespace gxfx_mole {
typedef enum { EFFECTS_OUTPUT, EFFECTS_INPUT, BOOST, WET_DRY } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/mole.cc"
}

namespace gxfx_hfb {
typedef enum { EFFECTS_OUTPUT, EFFECTS_INPUT, INTENSITY, VOLUME } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/hfb.cc"
}

namespace gxfx_hogsfoot {
typedef enum { EFFECTS_OUTPUT, EFFECTS_INPUT, VOLUME, WET_DRY } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/hogsfoot.cc"
}

// --- orphans (no .lv2 bundle; param enums from the .cc PortIndex comment) ---

namespace gxfx_softclip {
typedef enum { FUZZ } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/softclip.cc"
}

namespace gxfx_bassbooster {
typedef enum { LEVEL } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/bassbooster.cc"
}

namespace gxfx_highbooster {
typedef enum { LEVEL } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/highbooster.cc"
}

// --- dynamics ---

namespace gxfx_expander {
typedef enum { RATIO, KNEE, THRESHOLD, RELEASE, ATTACK, EFFECTS_OUTPUT, EFFECTS_INPUT } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/expander.cc"
}

namespace gxfx_susta {
typedef enum { EFFECTS_OUTPUT, EFFECTS_INPUT, SUSTAIN, VOLUME } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/susta.cc"
}

// namespace paths: gxfx_fuzzface::fuzzface::plugin() etc. Factory order
// MUST match the generator manifest order (ids 11..27).
typedef PluginLV2* (*gxfx_factory)();
PluginLV2* gxfx_create_fuzzface() { return gxfx_fuzzface::fuzzface::plugin(); }
PluginLV2* gxfx_create_fuzzfacefm() { return gxfx_fuzzfacefm::fuzzfacefm::plugin(); }
PluginLV2* gxfx_create_fumaster() { return gxfx_fumaster::fumaster::plugin(); }
PluginLV2* gxfx_create_hornet() { return gxfx_hornet::hornet::plugin(); }
PluginLV2* gxfx_create_muff() { return gxfx_muff::muff::plugin(); }
PluginLV2* gxfx_create_cstb() { return gxfx_cstb::cstb::plugin(); }
PluginLV2* gxfx_create_aclipper() { return gxfx_aclipper::aclipper::plugin(); }
PluginLV2* gxfx_create_mxrdist() { return gxfx_mxrdist::mxrdist::plugin(); }
PluginLV2* gxfx_create_rangem() { return gxfx_rangem::rangem::plugin(); }
PluginLV2* gxfx_create_mole() { return gxfx_mole::mole::plugin(); }
PluginLV2* gxfx_create_hfb() { return gxfx_hfb::hfb::plugin(); }
PluginLV2* gxfx_create_hogsfoot() { return gxfx_hogsfoot::hogsfoot::plugin(); }
PluginLV2* gxfx_create_softclip() { return gxfx_softclip::softclip::plugin(); }
PluginLV2* gxfx_create_bassbooster() { return gxfx_bassbooster::bassbooster::plugin(); }
PluginLV2* gxfx_create_highbooster() { return gxfx_highbooster::highbooster::plugin(); }
PluginLV2* gxfx_create_expander() { return gxfx_expander::expander::plugin(); }
PluginLV2* gxfx_create_susta() { return gxfx_susta::susta::plugin(); }

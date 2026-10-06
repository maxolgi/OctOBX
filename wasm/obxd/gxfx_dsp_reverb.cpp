// OctOBX: Phase 1-f reverb guitarix classes, wrapped headless into one TU
// (same pattern as gxfx_dsp.cpp: each include wrapped in its own namespace
// together with the PortIndex enum — transcribed from the bundle's gx_<fx>.h
// wrapper header (= the ttl port space) for the bundle-local DSP and from
// the bundle's gx_<fx>.h for the faust-generated class whose .cc trailing
// enum comment is stale, or from the .cc's own trailing PortIndex comment
// for the orphan — because the enums would collide at global scope).
// Effect ids 57..60 — same order as the generator manifest
// (tools/gen-gxfx-params.mjs) and the factory table in gxfx_host.cpp
// (static_assert-guarded against GXFX_EFFECT_COUNT).
//
// MEMORY NOTE (fx2plan "Research facts"): all four classes carry their
// delay lines as FIXED double arrays in the object — shimmizita ~4.8 MB
// (six fVec[65536] + more), room_simulator ~1.9 MB, zita_rev1 ~1.8 MB,
// freeverb ~0.1 MB — allocated at CREATION (like digital_delay's fVec2,
// NOT lazily). The host news the DSP eagerly in fx_set_slot (a worklet
// task, off the render path): a shimmizita slot costs ~4.8 MB (one stereo
// object), room_simulator ~3.8 MB (dual-mono L+R pair), zita_rev1
// ~1.8 MB, freeverb ~0.2 MB. Bounded per slot.
//
// Naming: v1's id 10 "Reverb" is stereoverb.cc behind the WRAPPER-ONLY
// gx_reverb.lv2 bundle; gx_zita_rev1.lv2 is a different, standalone stereo
// class — menu name "Zita Reverb". room_simulator + shimmizita are
// bundle-LOCAL plain faust classes (NOT convolver-based — fx2plan research
// facts); freeverb is the classic mono faust orphan.
//
// Compile (syntax check):
//   em++ -std=c++20 -O2 -fsyntax-only \
//     -I wasm/obxd \
//     -I third_party/guitarix/trunk/src/LV2/faust-generated \
//     -I third_party/guitarix/trunk/src/LV2/faust \
//     -I third_party/guitarix/trunk/src/LV2/DSP \
//     -Wno-vla-cxx-extension \
//     wasm/obxd/gxfx_dsp_reverb.cpp
#include "gxfx_prelude.h"
#include "../../third_party/guitarix/trunk/src/LV2/DSP/gx_pluginlv2.h"

// --- gx_zita_rev1.lv2 (faust-generated class) -------------------------------
// FDN reverb (A. Zolipzr-style: 8x8 feedback delay network, 2-band tilt EQ,
// predelay, dry/wet). PortIndex from gx_zita_rev1.h (= ttl indexes 0..14;
// control ports FIRST at 0..10, audio at 11..14). The .cc's own trailing
// enum comment is the stale dsp order — the wrapper enum rules.
namespace gxfx_zita_rev1 {
typedef enum {
    LEVEL, EQ2_FREQ, EQ1_LEVEL, EQ1_FREQ, IN_DELAY, LOW_RT60, LF_X,
    HF_DAMPING, MID_RT60, DRY_WET_MIX, EQ2_LEVEL,
    EFFECTS_OUTPUT, EFFECTS_OUTPUT1, EFFECTS_INPUT, EFFECTS_INPUT1,
} PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/gx_zita_rev1.cc"
}

// --- freeverb orphan (faust-generated class) --------------------------------
// Classic Schroeder/Moorer reverb (8 comb filters + 4 allpass per the
// freeverb topology). Mono — the host runs it dual-mono. PortIndex = the
// .cc's own trailing enum comment (the orphan generator's source).
namespace gxfx_freeverb {
typedef enum { ROOMSIZE, DAMP, WET_DRY } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/freeverb.cc"
}

// --- gx_room_simulator.lv2 (bundle-local room_simulator.cc) -----------------
// Small/medium/large room simulation via faust delay networks (room size
// 0..3 crossfades the three room circuits). PortIndex from
// gx_room_simulator.h (= ttl indexes 0..6; audio FIRST, then the 5
// controls). Mono — the host runs it dual-mono.
namespace gxfx_room_simulator {
typedef enum {
    EFFECTS_OUTPUT, EFFECTS_INPUT,
    EFFECT, PREDELAYMS, RT, ROOMSIZE, DRYWET,
} PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/gx_room_simulator.lv2/room_simulator.cc"
}

// --- gx_shimmizita.lv2 (bundle-local shimmizita.cc) -------------------------
// Zita-style FDN reverb with a parametric pitch-shift shimmer path
// (envelope-driven pitch shifter feeding the network; mode/shift/psdrywet
// control it). PortIndex from gx_shimmizita.h (= ttl indexes 0..15; audio
// at 0..3, then the 12 controls). STEREO.
namespace gxfx_shimmizita {
typedef enum {
    EFFECTS_OUTPUT, EFFECTS_INPUT, EFFECTS_OUTPUT1, EFFECTS_INPUT1,
    CONTROL, DEPTH, DRYWET, ENVELOPE, F1, F2, MODE, PSDRYWET, SHIFT, SPEED,
    T60DS, T60M,
} PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/gx_shimmizita.lv2/shimmizita.cc"
}

// namespace paths: gxfx_zita_rev1::gx_zita_rev1::plugin() etc. Factory
// order MUST match the generator manifest order (ids 57..60).
typedef PluginLV2* (*gxfx_factory)();
PluginLV2* gxfx_create_zita_rev1() { return gxfx_zita_rev1::gx_zita_rev1::plugin(); }
PluginLV2* gxfx_create_freeverb() { return gxfx_freeverb::freeverb::plugin(); }
PluginLV2* gxfx_create_room_simulator() { return gxfx_room_simulator::room_simulator::plugin(); }
PluginLV2* gxfx_create_shimmizita() { return gxfx_shimmizita::shimmizita::plugin(); }

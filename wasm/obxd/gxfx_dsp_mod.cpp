// OctOBX: Phase 1-d modulation guitarix classes, wrapped headless into one
// TU (same pattern as gxfx_dsp.cpp: each include wrapped in its own
// namespace together with the PortIndex enum — transcribed from
// gx_<fx>.lv2/gx_<fx>.h for bundles, from each file's trailing PortIndex
// comment for the faust-generated orphans, or from the wrapper header for
// bundle-local DSP — because the enums would collide at global scope).
// Effect ids 38..44 — same order as the generator manifest
// (tools/gen-gxfx-params.mjs) and the factory table in gxfx_host.cpp
// (static_assert-guarded against GXFX_EFFECT_COUNT).
//
// 12ax7 tables: gxtubetremelo.cc / gxtubevibrato.cc each #include the four
// DSP/circuit_tables/ 12ax7 headers (input/output, pos/neg). Unlike the
// fuzz family's trany.h these headers carry NO include guard, so the
// global-scope include-once trick from gxfx_dsp_drive.cpp cannot share them
// — each namespace below embeds its own copy of the tables (~32 KB static
// float data per namespace), mirroring upstream's one-copy-per-bundle
// layout.
//
// Known statics quirk (faithful to upstream): vibe.cc's LFO phase
// accumulators AND its TEMPO/DF slider pointers live in the file-static
// vibe_lfo_sine / vibe_mono_lfo_sine namespaces, shared by every Vibe
// instance in the process — two Vibe slots share one LFO phase and the
// last-connected slot's TEMPO wins (upstream LV2 hosts loading the .so
// twice behave identically).
//
// Compile (syntax check):
//   em++ -std=c++20 -O2 -fsyntax-only \
//     -I wasm/obxd \
//     -I third_party/guitarix/trunk/src/LV2/faust-generated \
//     -I third_party/guitarix/trunk/src/LV2/faust \
//     -I third_party/guitarix/trunk/src/LV2/DSP \
//     -I third_party/guitarix/trunk/src/LV2/DSP/circuit_tables \
//     -Wno-vla-cxx-extension \
//     wasm/obxd/gxfx_dsp_mod.cpp
#include "gxfx_prelude.h"
#include "../../third_party/guitarix/trunk/src/LV2/DSP/gx_pluginlv2.h"
#include <new>

// --- gx_vibe.lv2 (bundle-local vibe.cc) ------------------------------------
// Uni-Vibe-style photocell modulator (Ryan Billing, GPL2+). The file ships
// THREE namespaces (vibe_mono_lfo_sine, vibe_lfo_sine, vibe) — all nested
// under one gxfx_vibe wrapper namespace here. PortIndex is the WRAPPER
// space from gx_vibe.h (= the ttl port indexes); the class's own trailing
// PortIndex comment is stale (pre-dsp2cc ordering) and unused because
// gx_vibe.cpp defines the type before including vibe.cc — our typedef plays
// that role. We instantiate plugin_stereo() (ttl declares in/in1); the
// plugin_mono() variant stays unshipped (dual-mono of the stereo class
// covers the mono use case badly — the stereo LFO phase offset is half the
// vibe sound — so we deliberately ship the real stereo one only).
namespace gxfx_vibe {
typedef enum {
    WIDTH, DEPTH, WETDRY, FB, TEMPO,
    EFFECTS_OUTPUT, EFFECTS_INPUT,
    DF, PAN, CROSS,
    EFFECTS_OUTPUT1, EFFECTS_INPUT1,
} PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/gx_vibe.lv2/vibe.cc"

// vibe.cc's Vibe ctor leaves its filter-state members (vc/vcvo/ecvc/vevo
// .x1/.y1, fbl/fbr, oldstepl/...) UNINITIALIZED — upstream rides on hosts
// instantiating onto effectively fresh memory. Our slot model news/deletes
// DSP instances onto a recycled wasm heap, and a reused chunk can carry
// leftover float garbage into those states (observed as NaN output on the
// very first rendered block, surviving no param change — the state feeds
// back into itself). Construct over zeroed memory: placement-new over a
// memset'd ::operator new chunk keeps the allocator pairing exact (delete
// -> ::operator delete) and the ctor semantics unchanged, with the same
// every-field-zeroed start a fresh .so data segment would give upstream.
inline PluginLV2* plugin_stereo_zeroed() {
    void* raw = ::operator new(sizeof(vibe::Vibe));
    memset(raw, 0, sizeof(vibe::Vibe));
    return new (raw) vibe::Vibe(true);
}
} // namespace gxfx_vibe

// --- gxtubetremelo.lv2 / gxtubevibrato.lv2 (faust-generated classes) -------
// 12ax7 tube-modelled tremolo / vibrato (vactrol model by "transmogrify").
// PortIndex transcribed from the bundles' gxtubetremelo.h / gxtubevibrato.h
// (= the ttl port space; the .cc trailing comments carry a STALE enum order
// from the .dsp — the ttl/h order is what the shipped wrapper uses).

namespace gxfx_tubetremelo {
typedef enum { SINEWAVE, DEPTH, SPEED, DRIVE, OUTPUT, EFFECTS_OUTPUT, EFFECTS_INPUT } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/gxtubetremelo.cc"
}

namespace gxfx_tubevibrato {
typedef enum { SINEWAVE, DEPTH, SPEED, DRIVE, OUTPUT, EFFECTS_OUTPUT, EFFECTS_INPUT } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/gxtubevibrato.cc"
}

// --- gx_switched_tremolo.lv2 (faust-generated class) ------------------------
// Stepped tremolo that hops between up to 4 settable frequencies.
// PortIndex transcribed from gx_switched_tremolo.h (audio out/in first,
// then DEPTH..WET_DRY at ttl indexes 2..9).

namespace gxfx_switched_tremolo {
typedef enum { EFFECTS_OUTPUT, EFFECTS_INPUT, DEPTH, FREQ0, FREQ1, FREQ2, FREQ3, STEPS, SWITCHFREQ, WET_DRY } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/switched_tremolo.cc"
}

// --- classic faust orphans ---------------------------------------------------
// phaser.cc (10 params, natively 2-in/2-out — v1's id 6 "Phaser" is the
// leaner phaser_mono.cc class) and flanger.cc (7 params, natively stereo —
// v1's id 5 "Flanger" is the gx_flanger.cc class). chorus_mono.cc is the
// mono sibling of v1's id 4 "Chorus" (chorus.cc, stereo).

namespace gxfx_phaser_st {
typedef enum { MAXNOTCH1FREQ, MINNOTCH1FREQ, NOTCHWIDTH, NOTCHFREQ, SPEED, VIBRATOMODE, DEPTH, FEEDBACKGAIN, INVERT, LEVEL } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/phaser.cc"
}

namespace gxfx_flanger_st {
typedef enum { LFOFREQ, DEPTH, FEEDBACKGAIN, DELAY, DELAYOFFSET, INVERT, LEVEL } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/flanger.cc"
}

namespace gxfx_chorus_mono {
typedef enum { FREQ, LEVEL, WET_DRY } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/chorus_mono.cc"
}

// namespace paths: gxfx_vibe::vibe::plugin_stereo_zeroed() etc. Factory
// order MUST match the generator manifest order (ids 38..44).
typedef PluginLV2* (*gxfx_factory)();
PluginLV2* gxfx_create_vibe() { return gxfx_vibe::plugin_stereo_zeroed(); }
PluginLV2* gxfx_create_tubetremelo() { return gxfx_tubetremelo::gxtubetremelo::plugin(); }
PluginLV2* gxfx_create_tubevibrato() { return gxfx_tubevibrato::gxtubevibrato::plugin(); }
PluginLV2* gxfx_create_switched_tremolo() { return gxfx_switched_tremolo::switched_tremolo::plugin(); }
PluginLV2* gxfx_create_phaser_st() { return gxfx_phaser_st::phaser::plugin(); }
PluginLV2* gxfx_create_flanger_st() { return gxfx_flanger_st::flanger::plugin(); }
PluginLV2* gxfx_create_chorus_mono() { return gxfx_chorus_mono::chorus_mono::plugin(); }

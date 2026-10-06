// OctOBX: Phase 1-e time/delay guitarix classes, wrapped headless into one
// TU (same pattern as gxfx_dsp.cpp: each include wrapped in its own
// namespace together with the PortIndex enum — transcribed from the
// bundle's gx_<fx>.h wrapper header (= the ttl port space) for
// bundle-local DSP, from the bundle's gx_<fx>.h for the faust-generated
// classes whose .cc trailing enum comments are stale, or from the .cc's own
// trailing PortIndex comment for the orphans — because the enums would
// collide at global scope). Effect ids 45..56 — same order as the
// generator manifest (tools/gen-gxfx-params.mjs) and the factory table in
// gxfx_host.cpp (static_assert-guarded against GXFX_EFFECT_COUNT).
//
// Circuit tables: gxtape/gxtape_st #include the four DSP/circuit_tables/
// 12au7 headers, gxechocat the seven copicat headers, gxtubedelay the four
// 12ax7 headers. Like the modulation family's 12ax7 tables these carry NO
// include guard, so each namespace embeds its own copy (~32 KB static
// float data per namespace) — mirroring upstream's one-copy-per-bundle
// layout.
//
// MEMORY NOTE (fx2plan "Research facts"): digital_delay /
// digital_delay_st carry a `double fVec2[524288]` class member — 4 MB per
// object at CREATION (not lazy). The host news the DSP eagerly in
// fx_set_slot (a worklet task, off the render path): a digital_delay slot
// costs 8 MB (dual-mono L+R instances), digital_delay_st 4 MB (one stereo
// instance). Bounded per slot; documented for the Known-Issues line.
//
// gxts9: the bundle ships a plain circuit-sim class (ts9sim, from
// ts9sim.cc + ts9nonlin.h/.cc — NOT a PluginLV2); upstream's gxts9.cpp
// wrapper owns the LV2 plumbing. Ts9Dsp below is our headless equivalent
// of that wrapper (ts9sim by value; activate -> clear_state like
// upstream). Menu category is DRIVE (Tubescreamer-style overdrive), not
// delay — the TU placement follows fx2plan, the category follows the ear.
//
// Compile (syntax check):
//   em++ -std=c++20 -O2 -fsyntax-only \
//     -I wasm/obxd \
//     -I third_party/guitarix/trunk/src/LV2/faust-generated \
//     -I third_party/guitarix/trunk/src/LV2/faust \
//     -I third_party/guitarix/trunk/src/LV2/DSP \
//     -I third_party/guitarix/trunk/src/LV2/DSP/circuit_tables \
//     -Wno-vla-cxx-extension \
//     wasm/obxd/gxfx_dsp_time.cpp
#include "gxfx_prelude.h"
#include "../../third_party/guitarix/trunk/src/LV2/DSP/gx_pluginlv2.h"

// Include-once trick (same as gxfx_dsp_drive.cpp's trany.h): both
// digital_delay .cc files #include "beat.h" (B2N note-value→ms helper)
// INSIDE what would be their wrapper namespace — pulled in there once, the
// include guard would hide it from the second namespace. Including it at
// GLOBAL scope first neuters both includes; the classes reach ::B2N via
// unqualified lookup.
#include "../../third_party/guitarix/trunk/src/LV2/DSP/beat.h"

// --- gx_duck_delay.lv2 (bundle-local duck_delay.cc) -------------------------
// Ducking delay (dsp2cc class; wrapper PortIndex from gx_duck_delay.h —
// the .cc's own trailing enum comment is the stale dsp order).
namespace gxfx_duck_delay {
typedef enum {
    EFFECTS_OUTPUT, EFFECTS_INPUT,
    AMOUNT, ATTACK, FEEDBACK, RELESE, TIME,
    BYPASS,
} PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/gx_duck_delay.lv2/duck_delay.cc"
}

// --- gx_duck_delay_st.lv2 (bundle-local duck_delay_st.cc) -------------------
// Stereo ducking delay with coloration / ping-pong (PortIndex from
// gx_duck_delay_st.h = ttl indexes 0..12).
namespace gxfx_duck_delay_st {
typedef enum {
    EFFECTS_OUTPUT, EFFECTS_INPUT, EFFECTS_OUTPUT1, EFFECTS_INPUT1,
    AMOUNT, ATTACK, COLORATION, EFFECT, FEEDBACK, PINGPONG, RELEASE, TIME,
    BYPASS,
} PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/gx_duck_delay_st.lv2/duck_delay_st.cc"
}

// --- gx_digital_delay.lv2 (bundle-local digital_delay.cc) -------------------
// BPM-synced delay (plain/presence/tape/tape2 modes). PortIndex from
// gx_digital_delay.h — DD_CONTROL (atom in), DD_NOTIFY (bpm meter out),
// SYNC + HOSTBPM (wrapper-level LV2 host-tempo ports the faust class
// ignores — OctOBX has no tempo host, the generator skips them as params)
// and BYPASS are part of the wrapper space but never connected by us.
// fVec2[524288] doubles = the 4 MB-at-creation member (see header note).
namespace gxfx_digital_delay {
typedef enum {
    EFFECTS_OUTPUT, EFFECTS_INPUT,
    BPM, FEEDBACK, GAIN, HIGHPASS, HOWPASS, LEVEL, MODE, NOTES,
    DD_CONTROL, DD_NOTIFY, SYNC, HOSTBPM, BYPASS,
} PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/gx_digital_delay.lv2/digital_delay.cc"
}

// --- gx_digital_delay_st.lv2 (bundle-local digital_delay_st.cc) -------------
namespace gxfx_digital_delay_st {
typedef enum {
    EFFECTS_OUTPUT, EFFECTS_INPUT, EFFECTS_OUTPUT1, EFFECTS_INPUT1,
    BPM, FEEDBACK, GAIN, HIGHPASS, HOWPASS, LEVEL, MODE, NOTES,
    DD_CONTROL, DD_NOTIFY, SYNC, HOSTBPM, BYPASS,
} PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/gx_digital_delay_st.lv2/digital_delay_st.cc"
}

// --- gxtape.lv2 / gxtape_st.lv2 (faust-generated classes) -------------------
// Tape machine simulator (12au7 tube tables, wow/flutter/hiss). PortIndex
// from gxtape.h / gxtape_st.h — control ports FIRST (ttl indexes 0..9),
// audio at 10/11 (mono) resp. 10..13 (stereo), METERLEVEL last (declared
// out_port in the spec, connection unwired per Phase 0 policy).
namespace gxfx_gxtape {
typedef enum {
    ON, DRIVE, WOWDEPTH, WOWFREQ, FLUTTERDEPTH, FLUTTERFREQ,
    TAPEHISS, TAPETYPE, SPEED, GAIN,
    EFFECTS_OUTPUT, EFFECTS_INPUT, METERLEVEL,
} PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/gxtape.cc"
}

namespace gxfx_gxtape_st {
typedef enum {
    ON, DRIVE, WOWDEPTH, WOWFREQ, FLUTTERDEPTH, FLUTTERFREQ,
    TAPEHISS, TAPETYPE, SPEED, GAIN,
    EFFECTS_OUTPUT_L, EFFECTS_OUTPUT_R, EFFECTS_INPUT_L, EFFECTS_INPUT_R,
    METERLEVEL,
} PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/gxtape_st.cc"
}

// --- gxechocat.lv2 (faust-generated class) ----------------------------------
// Watkins Copicat tape-echo circuit sim (copicat* circuit tables).
// PortIndex from gxechocat.h (= ttl indexes; audio out/in are 8/9, AFTER
// the eight control ports).
namespace gxfx_gxechocat {
typedef enum {
    AUDIO_IN, SWELL, SUSTAIN, OUTPUT, BPM, HEAD1, HEAD2, HEAD3,
    EFFECTS_OUTPUT, EFFECTS_INPUT,
} PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/gxechocat.cc"
}

// --- gxtubedelay.lv2 (faust-generated class) --------------------------------
// 12ax7 tube-modelled delay (no include guards on the 12ax7 table headers
// — per-namespace embed, same as the modulation family's tube trem/vib).
namespace gxfx_gxtubedelay {
typedef enum {
    DRIVE, DELAY, FEEDBACK, LEVEL, OUTPUT,
    EFFECTS_OUTPUT, EFFECTS_INPUT,
} PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/gxtubedelay.cc"
}

// --- gxts9.lv2 (bundle-local ts9sim.cc + ts9nonlin.h/.cc) -------------------
// Ibanez TS-9 Tubescreamer circuit sim. ts9sim.cc #defines bare max/min
// macros (contained upstream by inclusion order) — #undef right after the
// include so the prelude's using-declarations keep serving later classes.
namespace gxfx_ts9 {
typedef enum {
    TS9_LEVEL, TS9_TONE, TS9_DRIVE,
    EFFECTS_OUTPUT, EFFECTS_INPUT,
    BYPASS,
} PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/gxts9.lv2/ts9sim.cc"
#undef max
#undef min

// Headless stand-in for upstream's gxts9.cpp LV2 wrapper: adapts the plain
// ts9sim circuit class to PluginLV2 (mono; the host runs it dual-mono).
// Lifecycle mirrors gxts9.cpp: init at set_samplerate, clear_state on
// activate(true) — the empty ts9sim ctor leaves its rec/vec states
// uninitialized, but the host activates BEFORE the first compute, so no
// recycled-heap garbage can reach the audio path.
class Ts9Dsp : public PluginLV2 {
private:
    ts9sim sim_;
    static Ts9Dsp* self(PluginLV2* p) { return static_cast<Ts9Dsp*>(p); }
    static void init_static(uint32_t rate, PluginLV2* p) {
        ts9sim::init_static(rate, &self(p)->sim_);
    }
    static void compute_static(int count, FAUSTFLOAT* in, FAUSTFLOAT* out, PluginLV2* p) {
        ts9sim::run_static((uint32_t)count, in, out, &self(p)->sim_);
    }
    static int activate_static(bool start, PluginLV2* p) {
        if (start) ts9sim::clear_state_static(&self(p)->sim_);
        return 0;
    }
    static void connect_static(uint32_t port, void* data, PluginLV2* p) {
        ts9sim::connect_static(port, data, &self(p)->sim_);
    }
    static void clear_static(PluginLV2* p) {
        ts9sim::clear_state_static(&self(p)->sim_);
    }
    static void del_instance(PluginLV2* p) { delete self(p); }

public:
    Ts9Dsp() : PluginLV2(), sim_() {
        version = PLUGINLV2_VERSION;
        id = "ts9";
        name = N_("TS-9");
        mono_audio = compute_static;
        stereo_audio = 0;
        set_samplerate = init_static;
        activate_plugin = activate_static;
        connect_ports = connect_static;
        clear_state = clear_static;
        delete_instance = del_instance;
    }
};
} // namespace gxfx_ts9

// --- gx_oc_2.lv2 (bundle-local oc_2.cc + triggers_logic.h) ------------------
// Boss OC-2 style octave divider (two squared-octave voices + direct).
// oc_2.cc #includes "triggers_logic.h" relative to its own dir. Menu
// category SPECIAL — the frozen vocabulary has no pitch group.
namespace gxfx_oc_2 {
typedef enum {
    EFFECTS_OUTPUT, EFFECTS_INPUT,
    DIRECT, OCTAVE1, OCTAVE2,
} PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/gx_oc_2.lv2/oc_2.cc"
}

// --- classic faust orphans ---------------------------------------------------
// Mono delay.cc / echo.cc — named "Classic Delay"/"Classic Echo" in the
// menu; v1's id 8 "Delay" / id 9 "Echo" are the STEREO stereodelay.cc /
// stereoecho.cc classes. PortIndex = each .cc's own trailing enum comment
// (the orphan generator's source).

namespace gxfx_classic_delay {
typedef enum { DELAY, GAIN } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/delay.cc"
}

namespace gxfx_classic_echo {
typedef enum { PERCENT, TIME } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/echo.cc"
}

// namespace paths: gxfx_duck_delay::duck_delay::plugin() etc. Factory
// order MUST match the generator manifest order (ids 45..56).
typedef PluginLV2* (*gxfx_factory)();
PluginLV2* gxfx_create_duck_delay() { return gxfx_duck_delay::duck_delay::plugin(); }
PluginLV2* gxfx_create_duck_delay_st() { return gxfx_duck_delay_st::duck_delay_st::plugin(); }

// digital_delay (mono) reads its SYNC checkbox and HOSTBPM slider EVERY
// compute() (`if (int(fcheckbox0)) fslider6 = fslider8;`) but the ctor
// leaves those pointer members uninitialized — and since SYNC/HOSTBPM are
// wrapper-level host-tempo ports the generator skips as params, they would
// stay unconnected and dereference recycled-heap garbage (the vibe.cc
// failure class from the modulation family). Park them on TU-local scratch
// with the upstream-default values (sync OFF, 120 BPM) — same pattern as
// graphiceq's meters in gxfx_dsp_eq.cpp. (The STEREO class has no sync
// logic — only fslider0..7 — and needs nothing.)
static float g_dd_scratch_sync = 0.0f;     // SYNC off: the BPM param rules
static float g_dd_scratch_hostbpm = 120.0f;
PluginLV2* gxfx_create_digital_delay() {
    PluginLV2* p = gxfx_digital_delay::digital_delay::plugin();
    if (p && p->connect_ports) {
        p->connect_ports((uint32_t)gxfx_digital_delay::SYNC, &g_dd_scratch_sync, p);
        p->connect_ports((uint32_t)gxfx_digital_delay::HOSTBPM, &g_dd_scratch_hostbpm, p);
    }
    return p;
}

PluginLV2* gxfx_create_digital_delay_st() { return gxfx_digital_delay_st::digital_delay_st::plugin(); }
PluginLV2* gxfx_create_gxtape() { return gxfx_gxtape::gxtape::plugin(); }
PluginLV2* gxfx_create_gxtape_st() { return gxfx_gxtape_st::gxtape_st::plugin(); }
PluginLV2* gxfx_create_gxechocat() { return gxfx_gxechocat::gxechocat::plugin(); }
PluginLV2* gxfx_create_gxtubedelay() { return gxfx_gxtubedelay::gxtubedelay::plugin(); }
PluginLV2* gxfx_create_ts9() { return new gxfx_ts9::Ts9Dsp(); }
PluginLV2* gxfx_create_oc_2() { return gxfx_oc_2::oc_2::plugin(); }
PluginLV2* gxfx_create_classic_delay() { return gxfx_classic_delay::delay::plugin(); }
PluginLV2* gxfx_create_classic_echo() { return gxfx_classic_echo::echo::plugin(); }

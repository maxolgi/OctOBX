// OctOBX: Phase 1-h multiband + utility guitarix family, wrapped headless
// into one TU (same pattern as gxfx_dsp.cpp / gxfx_dsp_eq.cpp: each include
// wrapped in its own namespace together with the PortIndex enum —
// transcribed from gx_<fx>.lv2/gx_<fx>.h for bundles, or from the trailing
// PortIndex comment in the .cc itself for orphans — because the enums would
// collide at global scope). Effect ids 66..70 (multiband) + 72..74
// (utility) — same order as the generator manifest
// (tools/gen-gxfx-params.mjs) and the factory table in gxfx_host.cpp
// (static_assert-guarded against GXFX_EFFECT_COUNT). (id 71 bigmuffpi
// rides gxfx_dsp.cpp — gx_resample dependency; id 75 ampmodul rides
// gxfx_dsp_amps.cpp — valve.h table sharing. See those files' headers.)
//
// METER OUTPUTS: every multiband class writes its V* bar meters through
// `#define fVbargraphN (*fVbargraphN_)` pointers unconditionally inside
// compute() (barkgraphiceq likewise through fbargraph[]), and the engine's
// out-port surface stays unwired (Phase 0 policy — g_fx_out in
// gxfx_host.cpp), so each factory parks its meters on TU-local scratch
// floats — the graphiceq precedent (gxfx_dsp_eq.cpp): throwaway values
// nobody reads, without which the first render would write through
// uninitialized pointers. Meters are NEVER params.
//
// barkgraphiceq is bundle-LOCAL dsp (gx_barkgraphiceq.lv2/): its .cc
// #includes bark_freq_grid.h (quoted — resolves in the bundle dir) and
// <iostream> from INSIDE its namespace, which upstream neuters by the
// gx_common.h chain having included <iostream> globally first. This TU
// reproduces that by including <iostream> at global scope BEFORE the
// namespace block. orfanidis_eq.h (the bark-band EQ solver, `using
// namespace std` — scoped by including it inside our namespace) must be
// visible before the .cc, exactly like the LV2 wrapper's include order.
//
// Compile (syntax check):
//   em++ -std=c++20 -O2 -fsyntax-only \
//     -I wasm/obxd \
//     -I third_party/guitarix/trunk/src/LV2/faust-generated \
//     -I third_party/guitarix/trunk/src/LV2/faust \
//     -Wno-vla-cxx-extension \
//     wasm/obxd/gxfx_mb.cpp
#include "gxfx_prelude.h"
#include "../../third_party/guitarix/trunk/src/LV2/DSP/gx_pluginlv2.h"
#include <iostream> // neuter barkgraphiceq.cc's in-namespace include (see header)

// gx_mbcompressor.lv2 — 5-band compressor (the tree's 2nd-largest effect at
// 34 params). PortIndex transcribed from gx_mbcompressor.lv2/gx_mbcompressor.h
// (== the ttl lv2:index space): MODE/MAKEUP/MAKEUPTHRESHOLD/RATIO/ATTACK/
// RELEASE ×5 bands, 4 crossovers, then the V1..V10 meters + audio pair.
namespace gxfx_mbc {
typedef enum {
    MODE1, MODE2, MODE3, MODE4, MODE5,
    MAKEUP1, MAKEUP2, MAKEUP3, MAKEUP4, MAKEUP5,
    MAKEUPTHRESHOLD1, MAKEUPTHRESHOLD2, MAKEUPTHRESHOLD3, MAKEUPTHRESHOLD4, MAKEUPTHRESHOLD5,
    RATIO1, RATIO2, RATIO3, RATIO4, RATIO5,
    ATTACK1, ATTACK2, ATTACK3, ATTACK4, ATTACK5,
    RELEASE1, RELEASE2, RELEASE3, RELEASE4, RELEASE5,
    CROSSOVER_B1_B2, CROSSOVER_B2_B3, CROSSOVER_B3_B4, CROSSOVER_B4_B5,
    V1, V2, V3, V4, V5, V6, V7, V8, V9, V10,
    EFFECTS_OUTPUT, EFFECTS_INPUT,
} PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/mbc.cc"

static float g_meter_scratch[10];
PluginLV2* create() {
    PluginLV2* p = mbc::plugin();
    if (p && p->connect_ports) {
        for (int i = V1; i <= V10; ++i)
            p->connect_ports((uint32_t)i, &g_meter_scratch[i - V1], p);
    }
    return p;
}
}

// gx_mbdelay.lv2 — 5-band delay. PortIndex from gx_mbdelay.lv2/gx_mbdelay.h.
namespace gxfx_mbdel {
typedef enum {
    DELAY1, DELAY2, DELAY3, DELAY4, DELAY5,
    FEEDBACK1, FEEDBACK2, FEEDBACK3, FEEDBACK4, FEEDBACK5,
    GAIN1, GAIN2, GAIN3, GAIN4, GAIN5,
    CROSSOVER_B1_B2, CROSSOVER_B2_B3, CROSSOVER_B3_B4, CROSSOVER_B4_B5,
    V1, V2, V3, V4, V5,
    EFFECTS_OUTPUT, EFFECTS_INPUT,
} PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/mbdel.cc"

static float g_meter_scratch[5];
PluginLV2* create() {
    PluginLV2* p = mbdel::plugin();
    if (p && p->connect_ports) {
        for (int i = V1; i <= V5; ++i)
            p->connect_ports((uint32_t)i, &g_meter_scratch[i - V1], p);
    }
    return p;
}
}

// gx_mbdistortion.lv2 — 5-band distortion. PortIndex from
// gx_mbdistortion.lv2/gx_mbdistortion.h.
namespace gxfx_mbd {
typedef enum {
    DRIVE1, DRIVE2, DRIVE3, DRIVE4, DRIVE5,
    GAIN,
    OFFSET1, OFFSET2, OFFSET3, OFFSET4, OFFSET5,
    CROSSOVER_B1_B2, CROSSOVER_B2_B3, CROSSOVER_B3_B4, CROSSOVER_B4_B5,
    V1, V2, V3, V4, V5,
    EFFECTS_OUTPUT, EFFECTS_INPUT,
} PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/mbd.cc"

static float g_meter_scratch[5];
PluginLV2* create() {
    PluginLV2* p = mbd::plugin();
    if (p && p->connect_ports) {
        for (int i = V1; i <= V5; ++i)
            p->connect_ports((uint32_t)i, &g_meter_scratch[i - V1], p);
    }
    return p;
}
}

// gx_mbecho.lv2 — 5-band echo. PortIndex from gx_mbecho.lv2/gx_mbecho.h.
namespace gxfx_mbe {
typedef enum {
    PERCENT1, PERCENT2, PERCENT3, PERCENT4, PERCENT5,
    TIME1, TIME2, TIME3, TIME4, TIME5,
    CROSSOVER_B1_B2, CROSSOVER_B2_B3, CROSSOVER_B3_B4, CROSSOVER_B4_B5,
    V1, V2, V3, V4, V5,
    EFFECTS_OUTPUT, EFFECTS_INPUT,
} PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/mbe.cc"

static float g_meter_scratch[5];
PluginLV2* create() {
    PluginLV2* p = mbe::plugin();
    if (p && p->connect_ports) {
        for (int i = V1; i <= V5; ++i)
            p->connect_ports((uint32_t)i, &g_meter_scratch[i - V1], p);
    }
    return p;
}
}

// gx_barkgraphiceq.lv2 — 24-band bark-scale graphic EQ over Orfanidis
// butterworth EQs. Bundle-LOCAL dsp: barkgraphiceq.cc + orfanidis_eq.h +
// bark_freq_grid.h all live in the bundle dir (include order mirrors the
// LV2 wrapper: orfanidis_eq.h BEFORE the .cc). PortIndex from
// gx_barkgraphiceq.lv2/gx_barkgraphiceq.h (G1..G24 gains, V1..V24 band
// meters, audio pair) == the ttl index space.
namespace gxfx_barkgraphiceq {
#include "../../third_party/guitarix/trunk/src/LV2/gx_barkgraphiceq.lv2/orfanidis_eq.h"
typedef enum {
    G1, G2, G3, G4, G5, G6, G7, G8, G9, G10, G11, G12,
    G13, G14, G15, G16, G17, G18, G19, G20, G21, G22, G23, G24,
    V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11, V12,
    V13, V14, V15, V16, V17, V18, V19, V20, V21, V22, V23, V24,
    EFFECTS_OUTPUT, EFFECTS_INPUT,
} PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/gx_barkgraphiceq.lv2/barkgraphiceq.cc"

static float g_meter_scratch[24];
PluginLV2* create() {
    PluginLV2* p = barkgraphiceq::plugin();
    if (p && p->connect_ports) {
        for (int i = V1; i <= V24; ++i)
            p->connect_ports((uint32_t)i, &g_meter_scratch[i - V1], p);
    }
    return p;
}
}

// --- utility orphans (no .lv2 bundle; enums from the .cc PortIndex comments;
// no meter outputs — nothing to park) ---

// balance.cc — stereo balance (natively 2-in/2-out: stereo_audio only, so
// the host runs its stereo path).
namespace gxfx_balance {
typedef enum { BALANCE } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/balance.cc"
}

// gx_outputlevel.cc — master output level (dB). The _ladspa variant is only
// referenced by src/ladspa/ladspa_guitarix.cpp — the LV2/v1-era tree uses
// THIS class. Natively stereo.
namespace gxfx_outputlevel {
typedef enum { OUT_MASTER } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/gx_outputlevel.cc"
}

// gx_ampout.cc — post-amp output level (dB), mono (dual-mono host). Same
// ladspa-variant rule as gx_outputlevel.
namespace gxfx_ampout {
typedef enum { OUT_AMP } PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/faust-generated/gx_ampout.cc"
}

// namespace paths: gxfx_mbc::create() etc. Factory order MUST match the
// generator manifest order (ids 66..70 multiband + 72..74 utility; id 71
// bigmuffpi rides gxfx_dsp.cpp — its .cc needs gx_resample, which is
// link-complete in that TU only — and id 75 ampmodul rides
// gxfx_dsp_amps.cpp for valve.h table sharing).
typedef PluginLV2* (*gxfx_factory)();
PluginLV2* gxfx_create_mbcompressor() { return gxfx_mbc::create(); }
PluginLV2* gxfx_create_mbdelay() { return gxfx_mbdel::create(); }
PluginLV2* gxfx_create_mbdistortion() { return gxfx_mbd::create(); }
PluginLV2* gxfx_create_mbecho() { return gxfx_mbe::create(); }
PluginLV2* gxfx_create_barkgraphiceq() { return gxfx_barkgraphiceq::create(); }
PluginLV2* gxfx_create_balance() { return gxfx_balance::balance::plugin(); }
PluginLV2* gxfx_create_outputlevel() { return gxfx_outputlevel::gx_outputlevel::plugin(); }
PluginLV2* gxfx_create_ampout() { return gxfx_ampout::gx_ampout::plugin(); }

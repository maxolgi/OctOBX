// gxfx_host.cpp — OctOBX per-instance guitarix FX chains.
// 10 chains (one per OB-Xf instance), each 11 slots. Slot index = chain
// position; each slot holds ANY effect type (duplicates allowed) or -1
// (empty). Params/enabled/DSP runtime are keyed by SLOT, so fx_set_slot
// resets a slot's 48 params to the new effect's defaults and clears its
// enabled flag, and fx_move_slot relocates values together with the slot.
// Mono effects run dual-mono (two PluginLV2 instances, L and R).
#include "gxfx_prelude.h"
#include "gxfx_defaults.h"
#include "../../third_party/guitarix/trunk/src/LV2/DSP/gx_pluginlv2.h"
#include <emscripten.h>

// Effect catalog size + per-effect data (defaults, param counts, stereo
// flags, port maps) come from the GENERATED gxfx_defaults.h
// (tools/gen-gxfx-params.mjs ← manifest: ttl bundles + orphan .cc classes
// in third_party/guitarix; v1 eleven pinned in tools/gxfx-param-spec.json).
static const int FX_COUNT = GXFX_EFFECT_COUNT;
static const int FX_SLOTS = 11;
static const int FX_INSTANCE_COUNT = 10;
static const int FX_SLOT_PARAMS = 48;
static const int FX_OUT_PORTS = 8;

PluginLV2* gxfx_create_wah();
PluginLV2* gxfx_create_overdrive();
PluginLV2* gxfx_create_distortion();
PluginLV2* gxfx_create_compressor();
PluginLV2* gxfx_create_chorus();
PluginLV2* gxfx_create_flanger();
PluginLV2* gxfx_create_phaser();
PluginLV2* gxfx_create_tremolo();
PluginLV2* gxfx_create_delay();
PluginLV2* gxfx_create_echo();
PluginLV2* gxfx_create_reverb();
// drive + dynamics family (gxfx_dsp_drive.cpp, Phase 1-a)
PluginLV2* gxfx_create_fuzzface();
PluginLV2* gxfx_create_fuzzfacefm();
PluginLV2* gxfx_create_fumaster();
PluginLV2* gxfx_create_hornet();
PluginLV2* gxfx_create_muff();
PluginLV2* gxfx_create_cstb();
PluginLV2* gxfx_create_aclipper();
PluginLV2* gxfx_create_mxrdist();
PluginLV2* gxfx_create_rangem();
PluginLV2* gxfx_create_mole();
PluginLV2* gxfx_create_hfb();
PluginLV2* gxfx_create_hogsfoot();
PluginLV2* gxfx_create_softclip();
PluginLV2* gxfx_create_bassbooster();
PluginLV2* gxfx_create_highbooster();
PluginLV2* gxfx_create_expander();
PluginLV2* gxfx_create_susta();
// eq family (gxfx_dsp_eq.cpp, Phase 1-b)
PluginLV2* gxfx_create_graphiceq();
PluginLV2* gxfx_create_selecteq();
PluginLV2* gxfx_create_tonecontroll();
PluginLV2* gxfx_create_moog();
PluginLV2* gxfx_create_low_high_pass();
PluginLV2* gxfx_create_noise_shaper();
// wah family (gxfx_dsp_wah.cpp, Phase 1-c — incl. the first host-side
// aggregate: WahModelDsp hot-swaps gx_colwah.lv2's 7 wah model classes on
// its MODEL param)
PluginLV2* gxfx_create_wahmodel();
PluginLV2* gxfx_create_crybaby();
PluginLV2* gxfx_create_autowah();
PluginLV2* gxfx_create_dunwah();
// modulation family (gxfx_dsp_mod.cpp, Phase 1-d — bundle-local gx_vibe
// stereo + 12ax7 tube tremolo/vibrato + switched tremolo + the classic
// stereo phaser / stereo flanger / mono chorus orphans)
PluginLV2* gxfx_create_vibe();
PluginLV2* gxfx_create_tubetremelo();
PluginLV2* gxfx_create_tubevibrato();
PluginLV2* gxfx_create_switched_tremolo();
PluginLV2* gxfx_create_phaser_st();
PluginLV2* gxfx_create_flanger_st();
PluginLV2* gxfx_create_chorus_mono();
// time/delay family (gxfx_dsp_time.cpp, Phase 1-e — bundle-local duck/
// digital delays + 12au7 gxtape(.st) + copicat gxechocat + 12ax7
// gxtubedelay + the ts9 circuit sim (menu: drive) + oc_2 octaver (menu:
// special) + the classic mono delay/echo orphans)
PluginLV2* gxfx_create_duck_delay();
PluginLV2* gxfx_create_duck_delay_st();
PluginLV2* gxfx_create_digital_delay();
PluginLV2* gxfx_create_digital_delay_st();
PluginLV2* gxfx_create_gxtape();
PluginLV2* gxfx_create_gxtape_st();
PluginLV2* gxfx_create_gxechocat();
PluginLV2* gxfx_create_gxtubedelay();
PluginLV2* gxfx_create_ts9();
PluginLV2* gxfx_create_oc_2();
PluginLV2* gxfx_create_classic_delay();
PluginLV2* gxfx_create_classic_echo();
// reverb family (gxfx_dsp_reverb.cpp, Phase 1-f — the standalone
// gx_zita_rev1 stereo FDN + the freeverb orphan + the bundle-local
// room_simulator + shimmizita classes; v1's id 10 stays stereoverb)
PluginLV2* gxfx_create_zita_rev1();
PluginLV2* gxfx_create_freeverb();
PluginLV2* gxfx_create_room_simulator();
PluginLV2* gxfx_create_shimmizita();
// amp + tonestack family (gxfx_dsp_amps.cpp, Phase 1-g — valve.h included
// once at global scope so the tube tables are shared: the "Amp Model"
// aggregate hot-swaps the 19 mono gxamp classes on MODEL 0..18, the
// "Tone Stack" aggregate the 27 STEREO tonestack classes on MODEL 0..26,
// plus the studiopre STEREO / alembic / w20 preamps)
PluginLV2* gxfx_create_ampmodel();
PluginLV2* gxfx_create_tonemodel();
PluginLV2* gxfx_create_studiopre();
PluginLV2* gxfx_create_alembic();
PluginLV2* gxfx_create_w20();
// multiband + utility family (Phase 1-h): the four gx_mb* bundles + the
// bundle-local barkgraphiceq live in gxfx_mb.cpp (meters parked on TU-local
// scratch), the enumeration-audit gx_bmp Big Muff Pi rides gxfx_dsp.cpp
// (gx_resample dependency), the balance/outputlevel/ampout orphans ride
// gxfx_mb.cpp, and ampmodul's DSP rides gxfx_dsp_amps.cpp (valve.h table
// sharing).
PluginLV2* gxfx_create_mbcompressor();
PluginLV2* gxfx_create_mbdelay();
PluginLV2* gxfx_create_mbdistortion();
PluginLV2* gxfx_create_mbecho();
PluginLV2* gxfx_create_barkgraphiceq();
PluginLV2* gxfx_create_bigmuffpi();
PluginLV2* gxfx_create_balance();
PluginLV2* gxfx_create_outputlevel();
PluginLV2* gxfx_create_ampout();
PluginLV2* gxfx_create_ampmodul();
// convolution family (gxfx_dsp_conv.cpp, Phase 2-a/2-b): the cabinet IR sim
// over the self-written partitioned convolver (gxfx_convolver.h + vendored
// kissfft; cab_data.cc IR tables baked with the bundle's Impf shelving),
// the redeye 3-chump aggregate (MODEL 0..2, each with its fixed speaker
// IR), and the metal amp/head preamps (valve.h classes from
// gxfx_dsp_amps.cpp) + fixed 4x12 cab convolution
PluginLV2* gxfx_create_cabinet();
PluginLV2* gxfx_create_redeye();
PluginLV2* gxfx_create_metalamp();
PluginLV2* gxfx_create_metalhead();
// detune (gxfx_dsp_detune.cpp, Phase 2-c): gx_detune.lv2's bundle-local
// smbPitchShift phase vocoder over the fftw3.h include-order shim
// (gxfx_shims/, complex-DFT subset on vendored kissfft); the LV2 wrapper's
// plan-rebuild worker is inlined on the LATENCY param-change path
PluginLV2* gxfx_create_detune();
// tuner (gxfx_dsp_tuner.cpp, Phase 2-d): gxtuner.lv2's NSDF pitch tracker
// analyzed inline on a ~100 ms cadence (pthread/semaphore/sigc++ machinery
// neutralized by gxfx_shims; the FREQ control OUTPUT port is the first
// real g_fx_out consumer — audio passes through bit-identical)
PluginLV2* gxfx_create_tuner();
// looper (gxfx_dsp_looper.cpp, Phase 3): gx_livelooper.lv2's bundle-local
// hand-tweaked faust class over the sndfile.hh include-order stub (wave
// save/load no-op — loops start empty each session). 64 MiB of tapes per
// DSP instance (4 x TAPESIZE 4194304 floats), lazily new'd on activate —
// mono → dual-mono → an enabled looper slot costs 128 MiB on the first
// render after enable; bar1..4/playh1..4 meter outs feed g_fx_out.
PluginLV2* gxfx_create_livelooper();

typedef PluginLV2* (*gxfx_factory)();
static const gxfx_factory FX_FACTORIES[GXFX_EFFECT_COUNT] = {
    gxfx_create_wah,
    gxfx_create_overdrive,
    gxfx_create_distortion,
    gxfx_create_compressor,
    gxfx_create_chorus,
    gxfx_create_flanger,
    gxfx_create_phaser,
    gxfx_create_tremolo,
    gxfx_create_delay,
    gxfx_create_echo,
    gxfx_create_reverb,
    gxfx_create_fuzzface,
    gxfx_create_fuzzfacefm,
    gxfx_create_fumaster,
    gxfx_create_hornet,
    gxfx_create_muff,
    gxfx_create_cstb,
    gxfx_create_aclipper,
    gxfx_create_mxrdist,
    gxfx_create_rangem,
    gxfx_create_mole,
    gxfx_create_hfb,
    gxfx_create_hogsfoot,
    gxfx_create_softclip,
    gxfx_create_bassbooster,
    gxfx_create_highbooster,
    gxfx_create_expander,
    gxfx_create_susta,
    gxfx_create_graphiceq,
    gxfx_create_selecteq,
    gxfx_create_tonecontroll,
    gxfx_create_moog,
    gxfx_create_low_high_pass,
    gxfx_create_noise_shaper,
    gxfx_create_wahmodel,
    gxfx_create_crybaby,
    gxfx_create_autowah,
    gxfx_create_dunwah,
    gxfx_create_vibe,
    gxfx_create_tubetremelo,
    gxfx_create_tubevibrato,
    gxfx_create_switched_tremolo,
    gxfx_create_phaser_st,
    gxfx_create_flanger_st,
    gxfx_create_chorus_mono,
    gxfx_create_duck_delay,
    gxfx_create_duck_delay_st,
    gxfx_create_digital_delay,
    gxfx_create_digital_delay_st,
    gxfx_create_gxtape,
    gxfx_create_gxtape_st,
    gxfx_create_gxechocat,
    gxfx_create_gxtubedelay,
    gxfx_create_ts9,
    gxfx_create_oc_2,
    gxfx_create_classic_delay,
    gxfx_create_classic_echo,
    gxfx_create_zita_rev1,
    gxfx_create_freeverb,
    gxfx_create_room_simulator,
    gxfx_create_shimmizita,
    gxfx_create_ampmodel,
    gxfx_create_tonemodel,
    gxfx_create_studiopre,
    gxfx_create_alembic,
    gxfx_create_w20,
    gxfx_create_mbcompressor,
    gxfx_create_mbdelay,
    gxfx_create_mbdistortion,
    gxfx_create_mbecho,
    gxfx_create_barkgraphiceq,
    gxfx_create_bigmuffpi,
    gxfx_create_balance,
    gxfx_create_outputlevel,
    gxfx_create_ampout,
    gxfx_create_ampmodul,
    gxfx_create_cabinet,
    gxfx_create_redeye,
    gxfx_create_metalamp,
    gxfx_create_metalhead,
    gxfx_create_detune,
    gxfx_create_tuner,
    gxfx_create_livelooper
};

// Generator↔host drift guard: the factory registry above must list every
// manifest effect (and only those) — adding a manifest entry without its
// factory (or vice versa) fails the build here.
static_assert(sizeof(FX_FACTORIES) / sizeof(FX_FACTORIES[0]) == (size_t)GXFX_EFFECT_COUNT,
              "gxfx_host.cpp FX_FACTORIES out of sync with generated gxfx_defaults.h — "
              "regenerate (node tools/gen-gxfx-params.mjs) and extend FX_FACTORIES in manifest order");

struct FxRuntime {
    PluginLV2* dsp;
    PluginLV2* dsp_r;
    bool active;
    bool ever_enabled;
};

static int16_t g_fx_slot[FX_INSTANCE_COUNT][FX_SLOTS];          // slot -> fx_id, -1 = empty
static FxRuntime g_fx_rt[FX_INSTANCE_COUNT][FX_SLOTS];
static float g_fx_params[FX_INSTANCE_COUNT][FX_SLOTS][FX_SLOT_PARAMS];
static unsigned char g_fx_enabled[FX_INSTANCE_COUNT][FX_SLOTS];
// Output-port storage (meters, tuner FREQ — Phase 2/3 effects): per slot,
// FX_OUT_PORTS floats. The spec's out_ports[] are connected into it by
// fx_connect_out_ports below (first real consumer: the tuner's FREQ port,
// Phase 2-d — JS reads it via fx_get_out_param). Effects whose meters
// park on TU-local scratch (graphiceq/mb families — their compute
// dereferences fixed scratch pointers, graphiceq precedent) simply
// double-write or ignore the connected pointers — harmless either way.
static float g_fx_out[FX_INSTANCE_COUNT][FX_SLOTS][FX_OUT_PORTS];
static uint32_t g_fx_sample_rate = 48000;
static bool g_fx_initialized = false;

static void fx_destroy_runtime(FxRuntime& r) {
    if (r.dsp_r) {
        if (r.dsp_r->activate_plugin) r.dsp_r->activate_plugin(false, r.dsp_r);
        if (r.dsp_r->delete_instance) r.dsp_r->delete_instance(r.dsp_r);
        r.dsp_r = 0;
    }
    if (r.dsp) {
        if (r.dsp->activate_plugin) r.dsp->activate_plugin(false, r.dsp);
        if (r.dsp->delete_instance) r.dsp->delete_instance(r.dsp);
        r.dsp = 0;
    }
    r.active = false;
    r.ever_enabled = false;
}

static void fx_teardown() {
    for (int e = 0; e < FX_INSTANCE_COUNT; ++e) {
        for (int s = 0; s < FX_SLOTS; ++s) {
            fx_destroy_runtime(g_fx_rt[e][s]);
            g_fx_slot[e][s] = -1;
        }
        memset(g_fx_enabled[e], 0, sizeof(g_fx_enabled[e]));
    }
}

static void fx_connect_params(int e, int s, int fx, PluginLV2* p) {
    if (!p->connect_ports) return;
    for (int i = 0; i < FX_PARAM_COUNTS[fx]; ++i)
        p->connect_ports((uint32_t)FX_PORTS[fx][i],
                         &g_fx_params[e][s][i], p);
}

// Connect the spec-declared control OUTPUT ports into the slot's g_fx_out
// row (meters, tuner FREQ). The per-slot storage caps at FX_OUT_PORTS=8 —
// wider declarations (barkgraphiceq's 24 band meters) connect their first
// 8; their factories park meters on TU-local scratch anyway.
static void fx_connect_out_ports(int e, int s, int fx, PluginLV2* p) {
    if (!p->connect_ports) return;
    int cnt = FX_OUT_COUNTS[fx];
    if (cnt > FX_OUT_PORTS) cnt = FX_OUT_PORTS;
    for (int i = 0; i < cnt; ++i)
        p->connect_ports((uint32_t)FX_OUT_PORT_IDS[fx][i],
                         &g_fx_out[e][s][i], p);
}

static PluginLV2* fx_create_one(int e, int s, int fx) {
    PluginLV2* p = FX_FACTORIES[fx]();
    if (!p) return 0;
    if (p->set_samplerate) p->set_samplerate(g_fx_sample_rate, p);
    fx_connect_params(e, s, fx, p);
    fx_connect_out_ports(e, s, fx, p);
    return p;
}

static void fx_ensure_dsp(int e, int s) {
    int fx = g_fx_slot[e][s];
    if (fx < 0) return;
    FxRuntime& r = g_fx_rt[e][s];
    if (!r.dsp) r.dsp = fx_create_one(e, s, fx);
    if (!FX_STEREO[fx] && !r.dsp_r) r.dsp_r = fx_create_one(e, s, fx);
}

static void fx_ensure_active(int e, int s) {
    fx_ensure_dsp(e, s);
    FxRuntime& r = g_fx_rt[e][s];
    if (!r.active) {
        if (r.dsp && r.dsp->activate_plugin) r.dsp->activate_plugin(true, r.dsp);
        if (r.dsp_r && r.dsp_r->activate_plugin) r.dsp_r->activate_plugin(true, r.dsp_r);
        r.active = true;
    }
}

void gxfx_init(uint32_t sample_rate) {
    fx_teardown();
    g_fx_sample_rate = sample_rate;
    for (int e = 0; e < FX_INSTANCE_COUNT; ++e) {
        for (int s = 0; s < FX_SLOTS; ++s) {
            g_fx_slot[e][s] = (int16_t)s; // canonical 11 — default UX unchanged
            memcpy(g_fx_params[e][s], FX_DEFAULTS[s], FX_SLOT_PARAMS * sizeof(float));
            memset(g_fx_out[e][s], 0, sizeof(g_fx_out[e][s]));
        }
    }
    g_fx_initialized = true;
    for (int e = 0; e < FX_INSTANCE_COUNT; ++e)
        for (int s = 0; s < FX_SLOTS; ++s)
            fx_ensure_dsp(e, s);
}

static inline bool gxfx_chain_active(int e) {
    if (e < 0 || e >= FX_INSTANCE_COUNT) return false;
    for (int s = 0; s < FX_SLOTS; ++s)
        if (g_fx_enabled[e][s]) return true;
    return false;
}

void gxfx_process(int e, float* l, float* r, int n) {
    if (!g_fx_initialized || e < 0 || e >= FX_INSTANCE_COUNT) return;
    if (!l || !r || n <= 0) return;
    if (!gxfx_chain_active(e)) return;
    for (int s = 0; s < FX_SLOTS; ++s) {
        int fx = g_fx_slot[e][s];
        if (fx < 0 || fx >= FX_COUNT || !g_fx_enabled[e][s]) continue;
        FxRuntime& rt = g_fx_rt[e][s];
        fx_ensure_active(e, s);
        if (!rt.dsp) continue;
        if (FX_STEREO[fx]) {
            if (rt.dsp->stereo_audio)
                rt.dsp->stereo_audio(n, l, r, l, r, rt.dsp);
        } else {
            if (rt.dsp->mono_audio)
                rt.dsp->mono_audio(n, l, l, rt.dsp);
            if (rt.dsp_r && rt.dsp_r->mono_audio)
                rt.dsp_r->mono_audio(n, r, r, rt.dsp_r);
        }
    }
}

// Keep in sync: every fx_* export below must be listed in the Makefile's
// EXPORTED_FUNCTIONS and wired to its message handler in
// obxd-processor.tail.js.
extern "C" {

EMSCRIPTEN_KEEPALIVE
int fx_effect_count() { return FX_COUNT; }

EMSCRIPTEN_KEEPALIVE
int fx_param_count(int fx_id) {
    if (fx_id < 0 || fx_id >= FX_COUNT) return -1;
    return FX_PARAM_COUNTS[fx_id];
}

EMSCRIPTEN_KEEPALIVE
int fx_is_stereo(int fx_id) {
    if (fx_id < 0 || fx_id >= FX_COUNT) return 0;
    return FX_STEREO[fx_id];
}

EMSCRIPTEN_KEEPALIVE
int fx_slot_params() { return FX_SLOT_PARAMS; }

EMSCRIPTEN_KEEPALIVE
double fx_default(int fx_id, int param) {
    if (fx_id < 0 || fx_id >= FX_COUNT) return 0.0;
    if (param < 0 || param >= FX_SLOT_PARAMS) return 0.0;
    return (double)FX_DEFAULTS[fx_id][param];
}

EMSCRIPTEN_KEEPALIVE
void fx_set_slot(int inst, int slot, int fx_id) {
    if (inst < 0 || inst >= FX_INSTANCE_COUNT) return;
    if (slot < 0 || slot >= FX_SLOTS) return;
    if (fx_id < -1 || fx_id >= FX_COUNT) return;
    fx_destroy_runtime(g_fx_rt[inst][slot]);
    g_fx_slot[inst][slot] = (int16_t)fx_id;
    g_fx_enabled[inst][slot] = 0;
    memset(g_fx_out[inst][slot], 0, sizeof(g_fx_out[inst][slot]));
    if (fx_id >= 0) {
        memcpy(g_fx_params[inst][slot], FX_DEFAULTS[fx_id], FX_SLOT_PARAMS * sizeof(float));
        // Eager create: fx_set_slot runs from a worklet task message, never
        // the render path; activation stays lazy on first render after enable.
        fx_ensure_dsp(inst, slot);
    } else {
        memset(g_fx_params[inst][slot], 0, FX_SLOT_PARAMS * sizeof(float));
    }
}

EMSCRIPTEN_KEEPALIVE
int fx_get_slot(int inst, int slot) {
    if (inst < 0 || inst >= FX_INSTANCE_COUNT) return -1;
    if (slot < 0 || slot >= FX_SLOTS) return -1;
    return g_fx_slot[inst][slot];
}

EMSCRIPTEN_KEEPALIVE
void fx_move_slot(int inst, int from, int to) {
    if (inst < 0 || inst >= FX_INSTANCE_COUNT) return;
    if (from < 0 || from >= FX_SLOTS) return;
    if (to < 0 || to >= FX_SLOTS) return;
    if (from == to) return;
    // Array-move (remove at `from`, insert at `to`): the whole slot content
    // — fx id, DSP pointers, params, enabled — travels together.
    const int16_t slot_id = g_fx_slot[inst][from];
    const FxRuntime rt = g_fx_rt[inst][from];
    const unsigned char enabled = g_fx_enabled[inst][from];
    float params[FX_SLOT_PARAMS];
    float outs[FX_OUT_PORTS];
    memcpy(params, g_fx_params[inst][from], sizeof(params));
    memcpy(outs, g_fx_out[inst][from], sizeof(outs));
    if (from < to) {
        memmove(&g_fx_slot[inst][from], &g_fx_slot[inst][from + 1], (size_t)(to - from) * sizeof(int16_t));
        memmove(g_fx_rt[inst] + from, g_fx_rt[inst] + from + 1, (size_t)(to - from) * sizeof(FxRuntime));
        memmove(&g_fx_enabled[inst][from], &g_fx_enabled[inst][from + 1], (size_t)(to - from));
        memmove(g_fx_params[inst][from], g_fx_params[inst][from + 1], (size_t)(to - from) * sizeof(g_fx_params[inst][0]));
        memmove(g_fx_out[inst][from], g_fx_out[inst][from + 1], (size_t)(to - from) * sizeof(g_fx_out[inst][0]));
    } else {
        memmove(&g_fx_slot[inst][to + 1], &g_fx_slot[inst][to], (size_t)(from - to) * sizeof(int16_t));
        memmove(g_fx_rt[inst] + to + 1, g_fx_rt[inst] + to, (size_t)(from - to) * sizeof(FxRuntime));
        memmove(&g_fx_enabled[inst][to + 1], &g_fx_enabled[inst][to], (size_t)(from - to));
        memmove(g_fx_params[inst][to + 1], g_fx_params[inst][to], (size_t)(from - to) * sizeof(g_fx_params[inst][0]));
        memmove(g_fx_out[inst][to + 1], g_fx_out[inst][to], (size_t)(from - to) * sizeof(g_fx_out[inst][0]));
    }
    g_fx_slot[inst][to] = slot_id;
    g_fx_rt[inst][to] = rt;
    g_fx_enabled[inst][to] = enabled;
    memcpy(g_fx_params[inst][to], params, sizeof(params));
    memcpy(g_fx_out[inst][to], outs, sizeof(outs));
    // The moved DSP instances keep the connect_ports() pointers they were
    // created with — they still reference their OLD param rows. Re-point
    // every shifted slot's DSP at its new row (pointer stores only; no
    // processing state is touched, so no audio glitch). Out ports
    // (g_fx_out rows) move with the slot the same way.
    const int lo = from < to ? from : to;
    const int hi = from < to ? to : from;
    for (int s = lo; s <= hi; ++s) {
        int fx = g_fx_slot[inst][s];
        if (fx < 0) continue;
        FxRuntime& r = g_fx_rt[inst][s];
        if (r.dsp) fx_connect_params(inst, s, fx, r.dsp);
        if (r.dsp) fx_connect_out_ports(inst, s, fx, r.dsp);
        if (r.dsp_r) fx_connect_params(inst, s, fx, r.dsp_r);
        if (r.dsp_r) fx_connect_out_ports(inst, s, fx, r.dsp_r);
    }
}

EMSCRIPTEN_KEEPALIVE
void fx_set_param(int inst, int slot, int param, double value) {
    if (inst < 0 || inst >= FX_INSTANCE_COUNT) return;
    if (slot < 0 || slot >= FX_SLOTS) return;
    int fx = g_fx_slot[inst][slot];
    if (fx < 0) return;
    if (param < 0 || param >= FX_PARAM_COUNTS[fx]) return;
    g_fx_params[inst][slot][param] = (float)value;
}

EMSCRIPTEN_KEEPALIVE
double fx_get_param(int inst, int slot, int param) {
    if (inst < 0 || inst >= FX_INSTANCE_COUNT) return 0.0;
    if (slot < 0 || slot >= FX_SLOTS) return 0.0;
    int fx = g_fx_slot[inst][slot];
    if (fx < 0) return 0.0;
    if (param < 0 || param >= FX_PARAM_COUNTS[fx]) return 0.0;
    return (double)g_fx_params[inst][slot][param];
}

EMSCRIPTEN_KEEPALIVE
void fx_set_enabled(int inst, int slot, int enabled) {
    if (inst < 0 || inst >= FX_INSTANCE_COUNT) return;
    if (slot < 0 || slot >= FX_SLOTS) return;
    if (g_fx_slot[inst][slot] < 0) return; // nothing to enable
    g_fx_enabled[inst][slot] = enabled ? 1 : 0;
    if (enabled) g_fx_rt[inst][slot].ever_enabled = true;
}

EMSCRIPTEN_KEEPALIVE
int fx_get_enabled(int inst, int slot) {
    if (inst < 0 || inst >= FX_INSTANCE_COUNT) return 0;
    if (slot < 0 || slot >= FX_SLOTS) return 0;
    return g_fx_enabled[inst][slot];
}

EMSCRIPTEN_KEEPALIVE
double fx_get_out_param(int inst, int slot, int i) {
    if (inst < 0 || inst >= FX_INSTANCE_COUNT) return 0.0;
    if (slot < 0 || slot >= FX_SLOTS) return 0.0;
    if (i < 0 || i >= FX_OUT_PORTS) return 0.0;
    return (double)g_fx_out[inst][slot][i];
}

EMSCRIPTEN_KEEPALIVE
void fx_restore_ptr(const float* params, const int16_t* slots, const unsigned char* enabled) {
    if (!params || !slots || !enabled) return;
    memcpy(g_fx_params, params, sizeof(g_fx_params));
    for (int e = 0; e < FX_INSTANCE_COUNT; ++e) {
        for (int s = 0; s < FX_SLOTS; ++s) {
            fx_destroy_runtime(g_fx_rt[e][s]);
            int v = (int)slots[e * FX_SLOTS + s];
            if (v < -1 || v >= FX_COUNT) v = -1;
            g_fx_slot[e][s] = (int16_t)v;
            memset(g_fx_out[e][s], 0, sizeof(g_fx_out[e][s]));
            if (v >= 0) fx_ensure_dsp(e, s);
        }
        for (int s = 0; s < FX_SLOTS; ++s) {
            unsigned char en = enabled[e * FX_SLOTS + s] ? 1 : 0;
            if (g_fx_slot[e][s] < 0) en = 0;
            g_fx_enabled[e][s] = en;
            if (en) {
                g_fx_rt[e][s].ever_enabled = true;
                fx_ensure_active(e, s);
            }
        }
    }
}

EMSCRIPTEN_KEEPALIVE
float* fx_get_params_ptr() { return &g_fx_params[0][0][0]; }

EMSCRIPTEN_KEEPALIVE
int16_t* fx_get_slots_ptr() { return &g_fx_slot[0][0]; }

EMSCRIPTEN_KEEPALIVE
unsigned char* fx_get_enabled_ptr() { return &g_fx_enabled[0][0]; }

// Test surface (verify-obxd-wasm only — the fx_param_count/fx_default
// pattern: Makefile EXPORTS entry, no worklet message case). Renders a
// deterministic 128-sample ramp through ONE instance of effect fx_id's
// DSP exactly the way gxfx_process renders a mono slot's L channel
// (in-place mono_audio) and returns the first differing sample index + 1;
// 0 = bit-identical passthrough. Exists for the tuner (id 81), whose
// analysis must never touch the audio path — a synth-fed A/B cannot prove
// this because the engine reseeds per-voice noise from std::rand() at
// every note-on (non-repeatable renders). The ramp values are exact
// float32 (integers / 128), so the bitwise compare is stable.
EMSCRIPTEN_KEEPALIVE
int fx_test_bittransparent(int fx_id) {
    if (fx_id < 0 || fx_id >= FX_COUNT) return -1;
    float ref[128], buf[128];
    for (int i = 0; i < 128; ++i) {
        ref[i] = (float)((i * 1103515245 + 12345) % 251 - 125) / 128.0f;
        buf[i] = ref[i];
    }
    PluginLV2* p = FX_FACTORIES[fx_id]();
    if (!p) return -2;
    if (p->set_samplerate) p->set_samplerate(g_fx_sample_rate, p);
    if (p->activate_plugin) p->activate_plugin(true, p);
    if (p->mono_audio) p->mono_audio(128, buf, buf, p);
    if (p->activate_plugin) p->activate_plugin(false, p);
    if (p->delete_instance) p->delete_instance(p);
    for (int i = 0; i < 128; ++i)
        if (buf[i] != ref[i]) return i + 1;
    return 0;
}

// Test surface (verify-obxd-wasm only — same pattern as
// fx_test_bittransparent: Makefile EXPORTS entry, no worklet message case).
// Renders a deterministic fixed-seed LCG ramp (state advances across all
// blocks, so the input is not block-periodic) through the REAL slot
// runtime (inst,slot) — the exact gxfx_process path: fx_set_param's mirror
// row feeds the connected param pointers, a mono slot renders its L dsp
// in-place, a stereo slot renders two independent ramp streams through
// stereo_audio — and returns the RMS over the last 48 of 64 x 128-sample
// blocks (first 16 skipped as warmup; convolver IRs are <= 4096 taps).
// A disabled / empty slot returns the DRY ramp RMS, mirroring the chain's
// bypass semantics. Exists because a synth-fed A/B flakes: the engine
// reseeds per-voice slop from juce::Random::getSystemRandom() (time +
// address seeded) at every init, so absolute RMS gates drift across runs
// and CI machines (see the redeye MODEL check's history).
EMSCRIPTEN_KEEPALIVE
double fx_test_slot_rms(int inst, int slot) {
    if (inst < 0 || inst >= FX_INSTANCE_COUNT) return -1.0;
    if (slot < 0 || slot >= FX_SLOTS) return -1.0;
    enum { BLOCKS = 64, WARMUP = 16, N = 128 };
    float l[N], r[N];
    uint32_t lg = 0x12345678u, rg = 0x9e3779b9u;
    FxRuntime& rt = g_fx_rt[inst][slot];
    const bool run = g_fx_enabled[inst][slot] && g_fx_slot[inst][slot] >= 0;
    if (run) fx_ensure_active(inst, slot);
    double sum = 0.0;
    unsigned cnt = 0;
    for (int b = 0; b < BLOCKS; ++b) {
        for (int i = 0; i < N; ++i) {
            lg = lg * 1664525u + 1013904223u;
            rg = rg * 1664525u + 1013904223u;
            l[i] = (float)(int32_t)lg / 2147483648.0f;
            r[i] = (float)(int32_t)rg / 2147483648.0f;
        }
        if (run && rt.dsp) {
            int fx = g_fx_slot[inst][slot];
            if (FX_STEREO[fx]) {
                if (rt.dsp->stereo_audio)
                    rt.dsp->stereo_audio(N, l, r, l, r, rt.dsp);
            } else {
                if (rt.dsp->mono_audio)
                    rt.dsp->mono_audio(N, l, l, rt.dsp);
            }
        }
        if (b < WARMUP) continue;
        for (int i = 0; i < N; ++i) {
            sum += (double)l[i] * l[i];
            ++cnt;
        }
    }
    return sqrt(sum / (double)cnt);
}

// Test surface (verify-obxd-wasm only — frequency-discrimination sibling
// of fx_test_slot_rms above; same pattern: Makefile EXPORTS entry, no
// worklet message case). Feeds a deterministic fixed-phase sine at feed_hz
// (amplitude 0.5, phase continuous across ALL blocks — the sample counter
// never resets, so warmup and measurement see one continuous tone) through
// the REAL slot runtime (inst,slot) and returns the LOCK-IN AMPLITUDE of
// the slot's L output at probe_hz.
//
// Lock-in math: with y[n] the measured output, wp = 2*pi*probe_hz/fs and
//   Sc = sum(y[n]*cos(wp*n)),  Ss = sum(y[n]*sin(wp*n)),
// a component y = a*cos(wp*n + phi) of ANY phase phi contributes
// hypot(Sc, Ss) = (cnt/2)*a — the cos/sin pair absorbs the phase — so the
// return value 2*hypot(Sc,Ss)/cnt is that component's amplitude. Energy at
// other frequencies contributes only rectangular-window (Dirichlet)
// leakage, ~|sin(pi*dbins)/(pi*dbins)| of its amplitude at dbins bins away
// (dbins = |f' - probe_hz| * cnt / fs): the 6144-sample window (7.8125 Hz
// bins at 48 kHz) puts a 440 Hz carrier 18.9 bins from a 587.33 Hz probe,
// i.e. ~0.7% leakage. The first WARMUP=48 of BLOCKS=96 x 128-sample blocks
// are skipped so stateful slots settle (the detune vocoder's FIFO latency
// is ~37 ms; 48 blocks = 128 ms) — by measurement time the slot is in the
// steady state the deterministic input dictates, independent of whatever
// ran before, so consecutive calls are run-exact. A disabled / empty slot
// returns the DRY tone's lock-in amplitude, mirroring the chain bypass.
// Exists for the same reason as fx_test_slot_rms: a synth-fed frequency
// probe (render, DFT, compare across renders) flakes because per-init
// juce::Random slop parks harmonics of the note in the probe bin (see
// z3's history — f0 energy ROSE under a +5 st shift on CI).
EMSCRIPTEN_KEEPALIVE
double fx_test_slot_tone_probe(int inst, int slot, double feed_hz, double probe_hz) {
    if (inst < 0 || inst >= FX_INSTANCE_COUNT) return -1.0;
    if (slot < 0 || slot >= FX_SLOTS) return -1.0;
    const double nyq = 0.5 * (double)g_fx_sample_rate;
    if (!(feed_hz > 0.0) || !(feed_hz < nyq)) return -1.0;
    if (!(probe_hz > 0.0) || !(probe_hz < nyq)) return -1.0;
    enum { BLOCKS = 96, WARMUP = 48, N = 128 };
    float l[N], r[N];
    FxRuntime& rt = g_fx_rt[inst][slot];
    const bool run = g_fx_enabled[inst][slot] && g_fx_slot[inst][slot] >= 0;
    if (run) fx_ensure_active(inst, slot);
    const double wf = 6.28318530717958647692 * feed_hz / (double)g_fx_sample_rate;
    const double wp = 6.28318530717958647692 * probe_hz / (double)g_fx_sample_rate;
    double sc = 0.0, ss = 0.0;
    unsigned cnt = 0;
    for (int b = 0; b < BLOCKS; ++b) {
        for (int i = 0; i < N; ++i) {
            const double n = (double)((b * N) + i);
            const float s = (float)(0.5 * sin(wf * n));
            l[i] = s;
            r[i] = s;
        }
        if (run && rt.dsp) {
            int fx = g_fx_slot[inst][slot];
            if (FX_STEREO[fx]) {
                if (rt.dsp->stereo_audio)
                    rt.dsp->stereo_audio(N, l, r, l, r, rt.dsp);
            } else {
                if (rt.dsp->mono_audio)
                    rt.dsp->mono_audio(N, l, l, rt.dsp);
            }
        }
        if (b < WARMUP) continue;
        for (int i = 0; i < N; ++i) {
            const double n = (double)((b * N) + i);
            sc += (double)l[i] * cos(wp * n);
            ss += (double)l[i] * sin(wp * n);
            ++cnt;
        }
    }
    return 2.0 * sqrt(sc * sc + ss * ss) / (double)cnt;
}

}

// gxfx_host.cpp — OctOBX per-instance guitarix FX chains.
// 10 chains (one per OB-Xf instance), each a user-reorderable sequence of up to
// 11 effect types (each type at most once). Params live in a flat mirror
// g_fx_params[10][FX_TOTAL] keyed by fx_id (NOT slot) so reordering never moves
// values. Mono effects run dual-mono (two PluginLV2 instances, L and R).
#include "gxfx_prelude.h"
#include "../../third_party/guitarix/trunk/src/LV2/DSP/gx_pluginlv2.h"
#include <emscripten.h>

static const int FX_COUNT = 11;
static const int FX_SLOTS = 11;
static const int FX_INSTANCE_COUNT = 10;
static const int FX_TOTAL = 47;

static const int FX_PARAM_COUNTS[FX_COUNT] = {2,1,3,5,4,6,3,4,7,7,5};
static const int FX_PARAM_OFFSET[FX_COUNT] = {0,2,3,6,11,15,21,24,28,35,42};
static const int FX_STEREO[FX_COUNT] = {0,0,0,0,1,0,0,0,1,1,1};

static const int FX_PORTS[FX_COUNT][7] = {
    {2,3},
    {2},
    {2,3,4},
    {0,1,2,3,4},
    {0,1,2,3},
    {0,1,2,3,4,5},
    {0,1,2},
    {0,1,2,3},
    {0,1,2,3,4,5,6},
    {0,1,2,3,4,5,6},
    {0,1,2,3,4}
};

static const float FX_DEFAULTS[FX_TOTAL] = {
    0.0f, 0.5f,
    0.5f,
    -2.0f, 0.5f, 0.5f,
    2.0f, 3.0f, -20.0f, 0.5f, 0.002f,
    0.5f, 0.02f, 0.02f, 3.0f,
    0.5f, 5.0f, 0.2f, -0.707f, 100.0f, 0.0f,
    50.0f, 0.0f, 0.5f,
    50.0f, 0.0f, 0.5f, 5.0f,
    0.0f, -10.0f, 1000.0f, -10.0f, 1000.0f, 0.2f, 0.0f,
    0.0f, 30.0f, 100.0f, 30.0f, 100.0f, 0.2f, 0.0f,
    50.0f, 0.2f, 0.5f, 0.2f, 0.0f
};

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

typedef PluginLV2* (*gxfx_factory)();
static const gxfx_factory FX_FACTORIES[FX_COUNT] = {
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
    gxfx_create_reverb
};

struct FxRuntime {
    PluginLV2* dsp;
    PluginLV2* dsp_r;
    bool active;
    bool ever_enabled;
};

struct FxChain {
    FxRuntime rt[FX_COUNT];
    int order[FX_SLOTS];
    unsigned char enabled[FX_COUNT];
};

static FxChain g_fx[FX_INSTANCE_COUNT];
static float g_fx_params[FX_INSTANCE_COUNT][FX_TOTAL];
static signed char g_fx_order_view[FX_INSTANCE_COUNT][FX_SLOTS];
static unsigned char g_fx_enabled_view[FX_INSTANCE_COUNT][FX_COUNT];
static uint32_t g_fx_sample_rate = 48000;
static bool g_fx_initialized = false;

static void fx_teardown() {
    for (int e = 0; e < FX_INSTANCE_COUNT; ++e) {
        for (int f = 0; f < FX_COUNT; ++f) {
            FxRuntime& r = g_fx[e].rt[f];
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
        for (int s = 0; s < FX_SLOTS; ++s) {
            g_fx[e].order[s] = -1;
            g_fx_order_view[e][s] = -1;
        }
        memset(g_fx[e].enabled, 0, sizeof(g_fx[e].enabled));
        memset(g_fx_enabled_view[e], 0, sizeof(g_fx_enabled_view[e]));
    }
}

static void fx_connect_params(int e, int fx, PluginLV2* p) {
    if (!p->connect_ports) return;
    for (int i = 0; i < FX_PARAM_COUNTS[fx]; ++i)
        p->connect_ports((uint32_t)FX_PORTS[fx][i],
                         &g_fx_params[e][FX_PARAM_OFFSET[fx] + i], p);
}

static PluginLV2* fx_create_one(int e, int fx) {
    PluginLV2* p = FX_FACTORIES[fx]();
    if (!p) return 0;
    if (p->set_samplerate) p->set_samplerate(g_fx_sample_rate, p);
    fx_connect_params(e, fx, p);
    return p;
}

static void fx_ensure_dsp(int e, int fx) {
    FxRuntime& r = g_fx[e].rt[fx];
    if (!r.dsp) r.dsp = fx_create_one(e, fx);
    if (!FX_STEREO[fx] && !r.dsp_r) r.dsp_r = fx_create_one(e, fx);
}

static void fx_ensure_active(int e, int fx) {
    fx_ensure_dsp(e, fx);
    FxRuntime& r = g_fx[e].rt[fx];
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
        for (int p = 0; p < FX_TOTAL; ++p)
            g_fx_params[e][p] = FX_DEFAULTS[p];
        for (int s = 0; s < FX_SLOTS; ++s) {
            g_fx[e].order[s] = s;
            g_fx_order_view[e][s] = (signed char)s;
        }
    }
    g_fx_initialized = true;
    for (int e = 0; e < FX_INSTANCE_COUNT; ++e)
        for (int f = 0; f < FX_COUNT; ++f)
            fx_ensure_dsp(e, f);
}

static inline bool gxfx_chain_active(int e) {
    if (e < 0 || e >= FX_INSTANCE_COUNT) return false;
    for (int f = 0; f < FX_COUNT; ++f)
        if (g_fx[e].enabled[f]) return true;
    return false;
}

void gxfx_process(int e, float* l, float* r, int n) {
    if (!g_fx_initialized || e < 0 || e >= FX_INSTANCE_COUNT) return;
    if (!l || !r || n <= 0) return;
    if (!gxfx_chain_active(e)) return;
    for (int s = 0; s < FX_SLOTS; ++s) {
        int fx = g_fx[e].order[s];
        if (fx < 0 || fx >= FX_COUNT || !g_fx[e].enabled[fx]) continue;
        FxRuntime& rt = g_fx[e].rt[fx];
        fx_ensure_active(e, fx);
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
int fx_param_offset(int fx_id) {
    if (fx_id < 0 || fx_id >= FX_COUNT) return -1;
    return FX_PARAM_OFFSET[fx_id];
}

EMSCRIPTEN_KEEPALIVE
int fx_is_stereo(int fx_id) {
    if (fx_id < 0 || fx_id >= FX_COUNT) return 0;
    return FX_STEREO[fx_id];
}

EMSCRIPTEN_KEEPALIVE
void fx_set_param(int inst, int fx_id, int param, double value) {
    if (inst < 0 || inst >= FX_INSTANCE_COUNT) return;
    if (fx_id < 0 || fx_id >= FX_COUNT) return;
    if (param < 0 || param >= FX_PARAM_COUNTS[fx_id]) return;
    g_fx_params[inst][FX_PARAM_OFFSET[fx_id] + param] = (float)value;
}

EMSCRIPTEN_KEEPALIVE
double fx_get_param(int inst, int fx_id, int param) {
    if (inst < 0 || inst >= FX_INSTANCE_COUNT) return 0.0;
    if (fx_id < 0 || fx_id >= FX_COUNT) return 0.0;
    if (param < 0 || param >= FX_PARAM_COUNTS[fx_id]) return 0.0;
    return (double)g_fx_params[inst][FX_PARAM_OFFSET[fx_id] + param];
}

EMSCRIPTEN_KEEPALIVE
void fx_set_enabled(int inst, int fx_id, int enabled) {
    if (inst < 0 || inst >= FX_INSTANCE_COUNT) return;
    if (fx_id < 0 || fx_id >= FX_COUNT) return;
    g_fx[inst].enabled[fx_id] = enabled ? 1 : 0;
    g_fx_enabled_view[inst][fx_id] = g_fx[inst].enabled[fx_id];
    if (enabled) g_fx[inst].rt[fx_id].ever_enabled = true;
}

EMSCRIPTEN_KEEPALIVE
int fx_get_enabled(int inst, int fx_id) {
    if (inst < 0 || inst >= FX_INSTANCE_COUNT) return 0;
    if (fx_id < 0 || fx_id >= FX_COUNT) return 0;
    return g_fx[inst].enabled[fx_id];
}

EMSCRIPTEN_KEEPALIVE
int fx_set_order_entry(int inst, int slot, int fx_id) {
    if (inst < 0 || inst >= FX_INSTANCE_COUNT) return 0;
    if (slot < 0 || slot >= FX_SLOTS) return 0;
    if (fx_id < -1 || fx_id >= FX_COUNT) return 0;
    if (fx_id != -1) {
        for (int s = 0; s < FX_SLOTS; ++s)
            if (s != slot && g_fx[inst].order[s] == fx_id) return 0;
    }
    g_fx[inst].order[slot] = fx_id;
    g_fx_order_view[inst][slot] = (signed char)fx_id;
    return 1;
}

EMSCRIPTEN_KEEPALIVE
int fx_get_order_entry(int inst, int slot) {
    if (inst < 0 || inst >= FX_INSTANCE_COUNT) return -1;
    if (slot < 0 || slot >= FX_SLOTS) return -1;
    return g_fx[inst].order[slot];
}

EMSCRIPTEN_KEEPALIVE
void fx_restore_ptr(const float* params, const signed char* order, const unsigned char* enabled) {
    if (!params || !order || !enabled) return;
    memcpy(g_fx_params, params, sizeof(g_fx_params));
    for (int e = 0; e < FX_INSTANCE_COUNT; ++e) {
        for (int s = 0; s < FX_SLOTS; ++s) {
            int v = (int)order[e * FX_SLOTS + s];
            if (v < -1 || v >= FX_COUNT) v = -1;
            g_fx[e].order[s] = v;
            g_fx_order_view[e][s] = (signed char)v;
        }
        for (int f = 0; f < FX_COUNT; ++f) {
            g_fx[e].enabled[f] = enabled[e * FX_COUNT + f] ? 1 : 0;
            g_fx_enabled_view[e][f] = g_fx[e].enabled[f];
            if (g_fx[e].enabled[f]) {
                g_fx[e].rt[f].ever_enabled = true;
                fx_ensure_active(e, f);
            }
        }
        for (int f = 0; f < FX_COUNT; ++f)
            fx_ensure_dsp(e, f);
    }
}

EMSCRIPTEN_KEEPALIVE
float* fx_get_params_ptr() { return &g_fx_params[0][0]; }

EMSCRIPTEN_KEEPALIVE
signed char* fx_get_order_ptr() { return &g_fx_order_view[0][0]; }

EMSCRIPTEN_KEEPALIVE
unsigned char* fx_get_enabled_ptr() { return &g_fx_enabled_view[0][0]; }

EMSCRIPTEN_KEEPALIVE
int fx_total_params() { return FX_TOTAL; }

}

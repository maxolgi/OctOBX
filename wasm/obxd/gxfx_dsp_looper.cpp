// gxfx_dsp_looper.cpp — OctOBX Phase 3: "Live Looper" (id 82, category
// special) — gx_livelooper.lv2's bundle-LOCAL, hand-tweaked faust class
// (livelooper.cc — NOT the gx_head/engine LiveLooper), namespace-wrapped
// like every gxfx DSP include. The class is pure audio + control ports:
// no mutexes, no worker thread — only its wave save/load paths touch
// libsndfile, which the gxfx_shims/sndfile.hh include-order stub turns
// into graceful no-ops (sf_open always fails → load_array returns 0,
// save_to_wave skips; loops start EMPTY each session). getenv("HOME")
// still runs inside those paths and stays unshimmed: under an empty
// browser environ it returns NULL and std::string's strlen then reads
// wasm linear-memory byte 0 — the zero-filled null page — so the loop
// dir degrades to "" (see the shim header).
//
// Port space: transcribed from the bundle's gx_livelooper.h wrapper
// header (= the ttl indexes 0..48: out/in audio, then clip1..synct);
// livelooper.cc's own trailing PortIndex comment is the same order minus
// the audio pair. 39 control inputs (params) + 8 control OUTPUTS:
// bar1..4 (remaining record-time meters, seconds — written every compute
// from rectime*) and playh1..4 (play-head position, 0..1000 per-mille —
// held at 0 while the matching rec flag is on). The generator declares
// all 8 in out_ports and gxfx_host connects them into g_fx_out (bar1..4
// → indices 0..3, playh1..4 → 4..7; mono slot → dual-mono pair, both
// halves write the same row — tuner precedent, harmless).
//
// MEMORY (fx2plan decision #5 — kept as-is): TAPESIZE 4194304 floats =
// 16 MiB per tape, 4 tapes per LiveLooper = 64 MiB per DSP instance,
// `new`'d LAZILY in activate(true) (mem_alloc) — not at fx_set_slot's
// eager create. The looper is MONO (one ttl audio input → host runs it
// dual-mono), so an ENABLED looper slot costs 2 x 64 = 128 MiB, landing
// on the audio thread at the first render after enable (plus one
// clear_state_f() pass that zeroes all tapes again). ALLOW_MEMORY_GROWTH
// absorbs it; the deactivation path (slot clear / fx_set_slot / restore)
// runs activate(false) → save_array (stub no-op) → mem_free.
//
// Compile (syntax check):
//   em++ -std=c++20 -O2 -fsyntax-only \
//     -I wasm/obxd/gxfx_shims \
//     -I wasm/obxd \
//     -I third_party/guitarix/trunk/src/LV2/DSP \
//     -Wno-vla-cxx-extension \
//     wasm/obxd/gxfx_dsp_looper.cpp
#include "gxfx_prelude.h"

// libsndfile stub FIRST and at GLOBAL scope (the wrapper's <sndfile.hh>
// slot): livelooper.cc's load_from_wave/save_to_wave reference the C API
// unqualified. <sys/stat.h> (stat/mkdir in save_array) and <cstdio>
// (mem_alloc's OOM fprintf) cover the remaining wrapper-side includes.
#include <sndfile.hh>
#include <sys/stat.h>
#include <cstdio>
#include <string>

#include "../../third_party/guitarix/trunk/src/LV2/DSP/gx_pluginlv2.h"

// --- gx_livelooper.lv2 (bundle-local livelooper.cc) ------------------------
// LiveLooper ships PluginLV2-shaped STATIC methods keyed on LiveLooper*
// (init_static/activate_static/compute_static/connect_static/
// del_instance + plugin()), but is not itself a PluginLV2 — the wrapper's
// Gx_livelooper_ provided that vtable upstream. LooperDsp below is our
// headless equivalent (TunerDsp pattern).
namespace gxfx_livelooper {
typedef enum {
    EFFECTS_OUTPUT, EFFECTS_INPUT,
    clip1, clip2, clip3, clip4,
    clips1, clips2, clips3, clips4,
    speed1, speed2, speed3, speed4,
    bar1, bar2, bar3, bar4,
    gain, level1, level2, level3, level4, mix,
    play1, play2, play3, play4,
    rplay1, rplay2, rplay3, rplay4,
    playh1, playh2, playh3, playh4,
    rec1, rec2, rec3, rec4,
    reset1, reset2, reset3, reset4,
    rback1, rback2, rback3, rback4,
    synct,
} PortIndex;
#include "../../third_party/guitarix/trunk/src/LV2/gx_livelooper.lv2/livelooper.cc"
} // namespace gxfx_livelooper

namespace gxfx_looper {

class LooperDsp : public PluginLV2 {
private:
    gxfx_livelooper::livelooper::LiveLooper* lo_;

public:
    LooperDsp()
        : PluginLV2(),
          lo_(gxfx_livelooper::livelooper::plugin()) {
        version = PLUGINLV2_VERSION;
        id = "livelooper";
        name = N_("Live Looper");
        mono_audio = compute_static;
        stereo_audio = 0;
        set_samplerate = init_static;
        activate_plugin = activate_static;
        connect_ports = connect_static;
        delete_instance = del_instance;
    }

    static void init_static(uint32_t rate, PluginLV2* p) {
        LooperDsp* s = static_cast<LooperDsp*>(p);
        if (s->lo_) gxfx_livelooper::livelooper::LiveLooper::init_static(rate, s->lo_);
    }

    // activate(true) lazily news the 4 x 16 MiB tapes + zeroes them
    // (mem_alloc + clear_state_f); activate(false) saves (stub no-op) and
    // frees. Called by the host's fx_ensure_active / fx_destroy_runtime.
    static int activate_static(bool start, PluginLV2* p) {
        LooperDsp* s = static_cast<LooperDsp*>(p);
        if (!s->lo_) return 0;
        return gxfx_livelooper::livelooper::LiveLooper::activate_static(start, s->lo_);
    }

    static void connect_static(uint32_t port, void* data, PluginLV2* p) {
        LooperDsp* s = static_cast<LooperDsp*>(p);
        if (s->lo_) gxfx_livelooper::livelooper::LiveLooper::connect_static(port, data, s->lo_);
    }

    // In-place safe: compute() reads input0[i] before writing output0[i].
    static void compute_static(int count, float* input, float* output, PluginLV2* p) {
        LooperDsp* s = static_cast<LooperDsp*>(p);
        if (!s->lo_) {
            if (input != output) memcpy(output, input, (size_t)count * sizeof(float));
            return;
        }
        gxfx_livelooper::livelooper::LiveLooper::compute_static(count, input, output, s->lo_);
    }

    static void del_instance(PluginLV2* p) {
        LooperDsp* s = static_cast<LooperDsp*>(p);
        if (s->lo_) gxfx_livelooper::livelooper::LiveLooper::del_instance(s->lo_); // dtor → activate(false) → mem_free
        delete s;
    }
};

PluginLV2* create() { return new LooperDsp(); }

} // namespace gxfx_looper

// namespace path: gxfx_looper::create(). Factory order MUST match the
// generator manifest order (id 82 livelooper, after Phase 2-d tuner).
typedef PluginLV2* (*gxfx_factory)();
PluginLV2* gxfx_create_livelooper() { return gxfx_looper::create(); }

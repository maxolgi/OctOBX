// OctOBX: Phase 2-a convolution family — the "Cabinet" effect (gx_cabinet)
// over the self-written partitioned convolver (gxfx_convolver.h + kissfft).
// Effect id 76 — same order as the generator manifest
// (tools/gen-gxfx-params.mjs) and the factory table in gxfx_host.cpp.
//
// Upstream gxcabinet.cpp is an LV2 worker-thread wrapper around
// gx_convolver (fftw3f + pthreads — NOT portable into the AudioWorklet,
// fx2plan Phase 2). This TU re-implements the WRAPPER semantics on our own
// convolver core:
//   cab IR (cab_data.cc, static float tables @48k)
//     → resample to engine rate (gx_resample::BufferResampler, zita)
//     → bake bass/treble shelving + level into the IR via the UNMODIFIED
//       bundle-local Impf class (cabinet_impulse_former.h — the faust
//       "impulse former" upstream applies to the IR, not the audio)
//     → partitioned overlap-save convolution (gxfx_conv).
// Model 18 "Off" is dry passthrough (upstream quirk keeps the last cab —
// the label says Off, so Off it is; documented deviation). Model 17 (1x8)
// halves the level, matching upstream's adjust_1x8.
//
// Param surface = gx_cabinet.ttl control inputs: CLevel/CBass/CTreble/
// c_model (BYPASS = lv2:enabled designation and SCHEDULE = notOnGUI are
// filtered by the generator). One audio input in the ttl → mono → the host
// runs it dual-mono (dsp + dsp_r), one convolver per channel.
//
// Compile (syntax check):
//   em++ -std=c++20 -O2 -fsyntax-only \
//     -I wasm/obxd \
//     -I wasm/obxd/kissfft \
//     -I third_party/guitarix/trunk/src/LV2/DSP \
//     -I third_party/guitarix/trunk/src/zita-resampler-1.1.0 \
//     -Wno-vla-cxx-extension \
//     wasm/obxd/gxfx_dsp_conv.cpp
#include "gxfx_prelude.h"
#include "gxfx_convolver.h"
#include "../../third_party/guitarix/trunk/src/LV2/DSP/gx_pluginlv2.h"
#include "../../third_party/guitarix/trunk/src/LV2/DSP/gx_resampler.h"

// cab IR tables at GLOBAL scope (before any namespace): cab_data.cc /
// cab_data_table.cc have no include guards, so they ride exactly one TU of
// the module (valve.h include-once precedent in gxfx_dsp_amps.cpp).
// cab_data_table.cc itself #includes cab_data.cc.
#include "../../third_party/guitarix/trunk/src/LV2/DSP/cab_data_table.cc"

namespace gxfx_cabinet {

// bundle-local impulse former (gx_cabinet.lv2/cabinet_impulse_former.h) —
// unmodified faust class, namespaced like every other gxfx DSP include.
#include "../../third_party/guitarix/trunk/src/LV2/gx_cabinet.lv2/cabinet_impulse_former.h"

class CabinetDsp : public PluginLV2 {
private:
    enum {  // gx_cabinet.ttl control-port indexes
        P_CLEVEL = 0, P_CBASS = 1, P_CTREBLE = 2, P_CMODEL = 3,
    };
    enum { CAB_COUNT = 18 };  // cab_table entries; ttl model 18 = "Off"

    uint32_t rate_;
    gxfx_conv::PartitionedConvolver conv_;
    Impf impf_;
    gx_resample::BufferResampler resamp_;

    // connected param pointers (host mirror floats)
    float* clevel_;
    float* cbass_;
    float* ctreble_;
    float* cmodel_;

    // base IR (engine rate, pre-impf) cache
    std::vector<float> base_;
    int base_model_;
    uint32_t base_rate_;
    // last BAKED impf input values (re-bake only on real change)
    float level_, bass_, treble_;
    int model_;
    bool have_ir_;      // a convolver IR was pushed at least once
    bool off_;          // model 18 passthrough
    std::vector<float> work_;  // impf output scratch

    void load_base(int m) {
        const CabDesc& cab = *getCabEntry((uint32_t)m).data;
        if (cab.ir_sr == rate_) {
            base_.assign(cab.ir_data, cab.ir_data + cab.ir_count);
        } else {
            int32_t olen = 0;
            // BufferResampler::process takes a mutable input (zita filters
            // in-place-ish); the cab tables are const globals — go through
            // a copy to keep third_party data unmodified.
            std::vector<float> src(cab.ir_data, cab.ir_data + cab.ir_count);
            float* out = resamp_.process((int32_t)cab.ir_sr, cab.ir_count,
                                         &src[0], (int32_t)rate_, &olen);
            if (out && olen > 0) {
                base_.assign(out, out + olen);
                delete[] out;
            } else {
                base_.clear();
            }
        }
        base_model_ = m;
        base_rate_ = rate_;
    }

    // Detect param changes and (re)bake the IR — runs at the top of every
    // render, cheap when nothing changed (a few float compares). Rebuilds
    // are bounded (resample <= ~1k samples + <= 8 partition FFTs) and ride
    // the convolver's pending-rebuild path: applied on THIS render's first
    // process() call, same bounded-alloc policy as lazy DSP activation.
    void maybe_rebuild() {
        const float level = clevel_ ? *clevel_ : 1.0f;
        const float bass = cbass_ ? *cbass_ : 0.0f;
        const float treble = ctreble_ ? *ctreble_ : 0.0f;
        int m = 0;
        if (cmodel_) {
            m = (int)(*cmodel_ + 0.5f);
            if (m < 0) m = 0;
            if (m > CAB_COUNT) m = CAB_COUNT;
        }
        const bool model_changed = (m != model_) || !have_ir_;
        const bool tone_changed = !have_ir_
            || fabsf(level - level_) > 1e-3f
            || fabsf(bass - bass_) > 1e-3f
            || fabsf(treble - treble_) > 1e-3f;
        if (!model_changed && !tone_changed) return;

        model_ = m;
        off_ = (m >= CAB_COUNT);
        if (off_) {
            // "Off": disable the convolver entirely (dry passthrough).
            conv_.set_ir(0, 0, (double)rate_, (double)rate_);
            have_ir_ = true; // keep the baked-value latch updated
            level_ = level; bass_ = bass; treble_ = treble;
            return;
        }
        if (model_changed || base_rate_ != rate_ || base_model_ != m)
            load_base(m);
        if (base_.empty()) { // resample failure: fail-open passthrough
            conv_.set_ir(0, 0, (double)rate_, (double)rate_);
            have_ir_ = true;
            level_ = level; bass_ = bass; treble_ = treble;
            return;
        }
        // Bake bass/treble/level into the IR (upstream do_work_mono():
        // impf over the IR; 1x8 gets its level halved).
        const float adjust = (m == 17) ? 0.5f : 1.0f;
        work_.resize(base_.size());
        impf_.compute((int)base_.size(), &base_[0], &work_[0],
                      bass, treble, level * adjust);
        conv_.set_ir(work_.empty() ? 0 : &work_[0], work_.size(),
                     (double)rate_, (double)rate_);
        have_ir_ = true;
        level_ = level; bass_ = bass; treble_ = treble;
    }

public:
    CabinetDsp()
        : PluginLV2(), rate_(48000), conv_(), impf_(), resamp_(),
          clevel_(0), cbass_(0), ctreble_(0), cmodel_(0),
          base_(), base_model_(-1), base_rate_(0),
          level_(1.0f), bass_(0.0f), treble_(0.0f),
          model_(-1), have_ir_(false), off_(false), work_() {
        version = PLUGINLV2_VERSION;
        id = "cabinet";
        name = N_("Cabinet");
        mono_audio = compute_static;
        stereo_audio = 0;
        set_samplerate = init_static;
        activate_plugin = activate_static;
        connect_ports = connect_static;
        clear_state = clear_static;
        delete_instance = del_instance;
    }

    static void init_static(uint32_t rate, PluginLV2* p) {
        CabinetDsp* s = static_cast<CabinetDsp*>(p);
        s->rate_ = rate;
        s->impf_.init(rate);           // shelving constants are rate-dependent
        s->base_rate_ = 0;             // force base-IR re-resample
        s->have_ir_ = false;           // force a bake on next render
    }
    static void connect_static(uint32_t port, void* data, PluginLV2* p) {
        CabinetDsp* s = static_cast<CabinetDsp*>(p);
        float* f = static_cast<float*>(data);
        switch (port) {
        case P_CLEVEL: s->clevel_ = f; break;
        case P_CBASS: s->cbass_ = f; break;
        case P_CTREBLE: s->ctreble_ = f; break;
        case P_CMODEL: s->cmodel_ = f; break;
        default: break;
        }
    }
    static int activate_static(bool start, PluginLV2* p) {
        CabinetDsp* s = static_cast<CabinetDsp*>(p);
        if (start) s->conv_.reset();   // fresh streaming state on enable
        return 0;
    }
    static void clear_static(PluginLV2* p) {
        CabinetDsp* s = static_cast<CabinetDsp*>(p);
        s->conv_.reset();
        s->have_ir_ = false;
    }
    static void compute_static(int count, float* input, float* output, PluginLV2* p) {
        CabinetDsp* s = static_cast<CabinetDsp*>(p);
        s->maybe_rebuild();
        // Unconditional: process() applies a pending IR rebuild on this
        // render (parts_ becomes > 0 there) and no-ops when disabled, so
        // gating on active() would deadlock the first rebuild forever.
        s->conv_.process((size_t)count, input);
        if (output != input)
            memcpy(output, input, (size_t)count * sizeof(float));
    }
    static void del_instance(PluginLV2* p) { delete static_cast<CabinetDsp*>(p); }
};

PluginLV2* create() { return new CabinetDsp(); }

} // namespace gxfx_cabinet

// namespace path: gxfx_cabinet::create(). Factory order MUST match the
// generator manifest order (id 76).
typedef PluginLV2* (*gxfx_factory)();
PluginLV2* gxfx_create_cabinet() { return gxfx_cabinet::create(); }

// gxfx_convolver.cpp — the OctOBX partitioned convolution core (see
// gxfx_convolver.h for the design notes). This TU also compiles the
// vendored kissfft real-FFT core exactly once for the whole synth module
// (extern "C" keeps the kiss_* symbols C-linked so the Phase 2 fftw3.h
// shim TUs — detune/tuner — can reuse them later).
//
// Compile (syntax check):
//   em++ -std=c++20 -O2 -fsyntax-only \
//     -I wasm/obxd \
//     -I wasm/obxd/kissfft \
//     -I third_party/guitarix/trunk/src/LV2/DSP \
//     -I third_party/guitarix/trunk/src/zita-resampler-1.1.0 \
//     wasm/obxd/gxfx_convolver.cpp
#include "gxfx_convolver.h"

#include <cmath>
#include <cstring>

#include "../../third_party/guitarix/trunk/src/LV2/DSP/gx_resampler.h"

extern "C" {
// Vendored kissfft (BSD-3, wasm/obxd/kissfft/ — see README.octobx there).
// Compiled here as C++ but with C linkage; the plain-float path is used
// (no USE_SIMD, no FIXED_POINT).
#include "kissfft/kiss_fft.c"
#include "kissfft/kiss_fftr.c"
}

namespace gxfx_conv {

PartitionedConvolver::PartitionedConvolver()
    : ir_rate_(48000.0), engine_rate_(48000.0), rebuild_pending_(false),
      parts_(0), slot_(0),
      acc_(BINS), blk_time_(FFT_N),
      cfg_fwd_(0), cfg_inv_(0) {
    memset(hist_, 0, sizeof(hist_));
}

PartitionedConvolver::~PartitionedConvolver() {
    if (cfg_fwd_) kiss_fftr_free(cfg_fwd_);
    if (cfg_inv_) kiss_fftr_free(cfg_inv_);
}

void PartitionedConvolver::ensure_cfgs() {
    if (!cfg_fwd_) cfg_fwd_ = kiss_fftr_alloc(FFT_N, 0, 0, 0);
    if (!cfg_inv_) cfg_inv_ = kiss_fftr_alloc(FFT_N, 1, 0, 0);
}

void PartitionedConvolver::set_ir(const float* ir, size_t len,
                                  double ir_rate, double engine_rate) {
    if (!ir || len == 0) {
        ir_src_.clear();
        parts_ = 0;
        rebuild_pending_ = false;
        reset();
        return;
    }
    ir_src_.assign(ir, ir + len);
    ir_rate_ = ir_rate;
    engine_rate_ = engine_rate;
    rebuild_pending_ = true; // applied on the next process()
}

void PartitionedConvolver::reset() {
    memset(hist_, 0, sizeof(hist_));
    if (!fd_ring_.empty()) memset(&fd_ring_[0], 0,
                                  fd_ring_.size() * sizeof(kiss_fft_cpx));
    slot_ = 0;
}

void PartitionedConvolver::rebuild() {
    rebuild_pending_ = false;
    ensure_cfgs();
    if (!cfg_fwd_ || !cfg_inv_ || ir_src_.empty()) {
        parts_ = 0;
        return;
    }

    // Effective IR at engine rate: use the source directly when the rates
    // match (the cabinet wrapper pre-resamples + bakes its impulse-former
    // EQ at engine rate), else resample via zita (gx_resample::BufferResampler
    // — implementation link-complete from the gxfx_dsp.cpp TU).
    const float* ir_eff = 0;
    std::vector<float> resampled;
    if (ir_rate_ == engine_rate_ || engine_rate_ <= 0.0) {
        ir_eff = &ir_src_[0];
    } else {
        gx_resample::BufferResampler r;
        int32_t olen = 0;
        float* out = r.process((int32_t)ir_rate_, (int32_t)ir_src_.size(),
                               const_cast<float*>(&ir_src_[0]),
                               (int32_t)engine_rate_, &olen);
        if (!out || olen <= 0) {
            parts_ = 0;
            return;
        }
        resampled.assign(out, out + olen);
        delete[] out;
        ir_eff = &resampled[0];
    }

    const size_t len = resampled.empty() ? ir_src_.size() : resampled.size();
    parts_ = (len + BLOCK - 1) / BLOCK;
    if (parts_ == 0) return;

    // Frequency-domain partitions: H_p = FFT([h[pB..(p+1)B) zero-padded to N]).
    fd_partitions_.assign(parts_ * BINS, kiss_fft_cpx());
    std::vector<float> tmp(FFT_N, 0.0f);
    for (size_t p = 0; p < parts_; ++p) {
        memset(&tmp[0], 0, tmp.size() * sizeof(float));
        const size_t chunk = (len - p * BLOCK < BLOCK) ? (len - p * BLOCK) : BLOCK;
        if (chunk) memcpy(&tmp[0], ir_eff + p * BLOCK, chunk * sizeof(float));
        kiss_fftr(cfg_fwd_, &tmp[0], &fd_partitions_[p * BINS]);
    }

    // Fresh streaming state for the new IR.
    fd_ring_.assign(parts_ * BINS, kiss_fft_cpx());
    reset();
}

void PartitionedConvolver::run_block(float* io) {
    // 1. Slide the history window: hist = [oldest B | newest B].
    memmove(hist_, hist_ + BLOCK, BLOCK * sizeof(float));
    memcpy(hist_ + BLOCK, io, BLOCK * sizeof(float));

    // 2. Forward transform of the window; store as the newest ring slot.
    kiss_fftr(cfg_fwd_, hist_, &fd_ring_[slot_ * BINS]);

    // 3. Accumulate H_p * X_{p blocks ago} over all partitions.
    memset(&acc_[0], 0, acc_.size() * sizeof(kiss_fft_cpx));
    for (size_t p = 0; p < parts_; ++p) {
        const kiss_fft_cpx* h = &fd_partitions_[p * BINS];
        const size_t xpos = (slot_ + parts_ - p) % parts_;
        const kiss_fft_cpx* x = &fd_ring_[xpos * BINS];
        for (size_t b = 0; b < BINS; ++b) {
            acc_[b].r += h[b].r * x[b].r - h[b].i * x[b].i;
            acc_[b].i += h[b].r * x[b].i + h[b].i * x[b].r;
        }
    }

    // 4. Inverse transform; the valid (alias-free) half is the LAST B
    //    samples of the N-point circular result. kissfft's transforms are
    //    unscaled, so divide by N exactly once.
    kiss_fftri(cfg_inv_, &acc_[0], &blk_time_[0]);
    const float scale = 1.0f / (float)FFT_N;
    for (size_t i = 0; i < BLOCK; ++i)
        io[i] = blk_time_[BLOCK + i] * scale;

    slot_ = (slot_ + 1) % parts_;
}

void PartitionedConvolver::process(size_t n, float* x) {
    if (rebuild_pending_) rebuild();
    if (parts_ == 0 || !x) return; // disabled / passthrough
    size_t off = 0;
    for (; off + (size_t)BLOCK <= n; off += (size_t)BLOCK)
        run_block(x + off);
    // Sub-block remainder (no caller): left untouched in place.
}

} // namespace gxfx_conv

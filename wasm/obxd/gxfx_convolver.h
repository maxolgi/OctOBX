// gxfx_convolver.h — OctOBX self-written uniformly partitioned convolution
// core (fx2plan.md Phase 2: NO zita-convolver port — no pthreads/fftw inside
// an AudioWorklet; NO guitarix source edits). Own code over vendored kissfft
// (wasm/obxd/kissfft/, BSD-3).
//
// Algorithm: uniformly partitioned overlap-save (Gardner 1995 style).
//   - Partition size B = 128 (exactly one AudioWorklet render quantum) and
//     FFT size N = 2B = 256. The engine's only render path is 128-sample
//     quanta, so one partition pass runs per quantum with ZERO added
//     latency: the output block for quantum k is computed from quantum k's
//     own samples (pairing H_p with the input spectrum from p blocks ago).
//   - Static cab IRs are 68..1000 taps (cab_data.cc) → 1..8 partitions;
//     even a 4000-tap IR is 32. Per 128-sample block per channel:
//     1 fwd FFT(256) + P*129 complex MACs + 1 inv FFT(256) — trivial CPU,
//     strictly O(P log P), never an O(n^2) direct convolution.
//   - In-place: run_block copies the block inputs into the internal history
//     BEFORE writing outputs, so process(n, x) may alias in/out.
//
// Mono by design: the gxfx host runs mono effects dual-mono (one DSP
// instance per channel), so each PartitionedConvolver processes one
// channel. (This deviates from the sketched process(n, l, r) stereo pair —
// dual-mono host shape wins; see fx2plan "cabinet is mono in guitarix
// chains → dual-mono".)
//
// Allocation policy (bounded, same as lazy DSP activation): set_ir() only
// COPIES the IR and raises rebuild_pending_; the resample + partition FFTs
// happen on the NEXT process() call (render-thread, bounded: ~1k samples
// resampled + <= 32 x 256-pt FFTs). kiss_fftr plans are allocated once on
// first use and kept. IR == NULL / len == 0 disables the convolver
// (process() passes audio through untouched — cabinet "Off" model).
//
// IR resampling: ir_rate != engine_rate runs the already-vendored
// zita-resampler via DSP/gx_resampler.h (BufferResampler — same dependency
// bossds1/muff use; its implementation is link-complete from the
// gxfx_dsp.cpp TU). Callers that pre-process the IR at engine rate
// (cabinet: impulse-former EQ baked in after resampling) pass
// ir_rate == engine_rate and skip it.
#pragma once

#include <cstddef>
#include <vector>

#include "kiss_fft.h"
#include "kiss_fftr.h"

namespace gxfx_conv {

class PartitionedConvolver {
public:
    enum { BLOCK = 128 };             // partition size = one render quantum
    enum { FFT_N = 2 * BLOCK };       // 256
    enum { BINS = FFT_N / 2 + 1 };    // 129

    PartitionedConvolver();
    ~PartitionedConvolver();

    // New IR (copied now, applied on the next process() — see header).
    // ir == NULL or len == 0 → disabled (passthrough). Thread of the copy:
    // whatever calls set_ir (for the cabinet wrapper that is the render
    // thread itself, still bounded: <= ~4k floats).
    void set_ir(const float* ir, size_t len, double ir_rate, double engine_rate);

    // Clear streaming state (input history + spectra ring); partitions are
    // kept. Called on activation.
    void reset();

    // In-place processing. n should be a multiple of BLOCK (the AWP path is
    // always 128): each full block is convolved with zero added latency.
    // A sub-block remainder is left untouched in place (documented
    // limitation of block convolution; no caller does this).
    void process(size_t n, float* x);

    bool active() const { return parts_ > 0; }
    bool rebuild_pending() const { return rebuild_pending_; }

private:
    PartitionedConvolver(const PartitionedConvolver&);            // non-copyable
    PartitionedConvolver& operator=(const PartitionedConvolver&); // non-copyable

    void ensure_cfgs();
    void rebuild();
    void run_block(float* io);          // one BLOCK-sample in-place pass

    // IR source (copied at set_ir; applied lazily by rebuild())
    std::vector<float> ir_src_;
    double ir_rate_;
    double engine_rate_;
    bool rebuild_pending_;

    // Frequency-domain partitions: parts_ rows of BINS complex each.
    std::vector<kiss_fft_cpx> fd_partitions_;
    size_t parts_;

    // Streaming state: ring of the last parts_ input spectra; slot_ is the
    // newest (written this block), p blocks ago lives at
    // (slot_ + parts_ - p) % parts_.
    std::vector<kiss_fft_cpx> fd_ring_;
    size_t slot_;
    float hist_[FFT_N];                 // time-domain input history
    std::vector<kiss_fft_cpx> acc_;     // per-block freq accumulator
    std::vector<float> blk_time_;       // IFFT scratch (FFT_N)

    kiss_fftr_cfg cfg_fwd_;
    kiss_fftr_cfg cfg_inv_;
};

} // namespace gxfx_conv

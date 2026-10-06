// gxfx_shims/fftw3.h — OctOBX stand-in for FFTW3's single-precision API,
// implemented on the vendored kissfft (wasm/obxd/kissfft/, BSD-3).
//
// Include-order shadow (the obxf_stubs pattern): wasm/obxd/Makefile puts
// -I gxfx_shims FIRST in GXFU_INCLUDES, so `#include <fftw3.h>` in ported
// guitarix sources resolves HERE. gx_detune.lv2/detune.cc has no fftw
// include of its own — upstream it is compiled after gx_detune.cpp's
// top-of-file `#include <fftw3.h>`; gxfx_dsp_detune.cpp reproduces that
// ordering. The emcc sysroot ships no fftw, and no guitarix source is
// edited (fx2plan.md Phase 2).
//
// Scope: ONLY the complex 1-D DFT subset detune.cc references (Phase 2-c):
//   fftwf_complex          — float[2] ([k][0]=re, [k][1]=im; same layout as
//                            kiss_fft_cpx)
//   fftwf_plan             — opaque handle; plan struct new/delete'd here
//   fftwf_plan_dft_1d(n, in, out, FFTW_FORWARD|FFTW_BACKWARD, flags)
//   fftwf_execute(plan)    — runs on the buffers bound at plan creation
//   fftwf_destroy_plan(p)
//   constants FFTW_FORWARD(-1) / FFTW_BACKWARD(+1) / FFTW_MEASURE(0)
// fftwf_malloc/fftw_free/fftwf_cleanup are NOT referenced by any ported
// source and are deliberately absent (detune's buffers are caller-owned
// member arrays).
//
// Scaling: like fftw, BOTH directions are unscaled — kiss_fft's inverse is
// unscaled too, so the shim applies no normalization (detune's hanningd
// window already carries the smbPitchShift 2/((N/2)*osamp) term; a 1/N
// here would double-scale the synthesis path).
//
// Plans are NOT thread-safe — irrelevant: the worklet is single-threaded
// by construction (no pthreads inside AudioWorkletGlobalScope).
//
// kissfft linkage: the kiss_fft*.c files are compiled EXACTLY ONCE, inside
// gxfx_convolver.cpp, as C++ with C linkage (extern "C" includes). This
// header pulls only kiss_fft.h DECLARATIONS and links against those
// symbols — never #include the .c files here (duplicate definitions).
//
// Header-only by design: every function is `static inline`, so any number
// of TUs can include the shim without link collisions (each TU gets its
// own copy; plan handles never cross TU boundaries).
//
// EXTENSION POINTS (Phase 2-d, gxtuner — do NOT implement yet): the tuner
// tracker needs the r2r halfcomplex flavors — fftwf_plan_r2r_1d with
// FFTW_R2HC / FFTW_HC2R and fftwf_execute_r2r. Extend struct fftwf_plan_s
// (add a kind field + a kiss_fftr_cfg / halfcomplex packing branch) and
// add the r2r entry points alongside the complex ones below.
#pragma once

#ifndef GXFX_SHIMS_FFTW3_H
#define GXFX_SHIMS_FFTW3_H

#include "kiss_fft.h" // vendored kissfft; symbols C-linked from gxfx_convolver.cpp

#ifdef __cplusplus

#define FFTW_FORWARD (-1)
#define FFTW_BACKWARD (+1)

// Planning flags: fftw has a whole zoo; ported code only passes FFTW_MEASURE
// (kissfft has no planner — the value is accepted and ignored).
#define FFTW_MEASURE (0)

typedef float fftwf_complex[2];

struct fftwf_plan_s {
    kiss_fft_cfg cfg;   // kissfft state (factors + twiddles)
    kiss_fft_cpx* in;   // buffers bound at plan creation — fftwf_execute
    kiss_fft_cpx* out;  // reads/writes these, argument-less like fftw
    int n;
    int sign;           // FFTW_FORWARD / FFTW_BACKWARD (kept for parity)
};
typedef struct fftwf_plan_s* fftwf_plan;

static inline fftwf_plan fftwf_plan_dft_1d(int n, fftwf_complex* in,
                                           fftwf_complex* out, int sign,
                                           unsigned /*flags*/) {
    if (n <= 0 || !in || !out) return 0;
    kiss_fft_cfg cfg = kiss_fft_alloc(n, sign != FFTW_FORWARD, 0, 0);
    if (!cfg) return 0;
    fftwf_plan p = new fftwf_plan_s;
    p->cfg = cfg;
    p->in = reinterpret_cast<kiss_fft_cpx*>(in);
    p->out = reinterpret_cast<kiss_fft_cpx*>(out);
    p->n = n;
    p->sign = sign;
    return p;
}

static inline void fftwf_execute(const fftwf_plan p) {
    if (!p || !p->cfg) return;
    kiss_fft(p->cfg, p->in, p->out);
}

static inline void fftwf_destroy_plan(fftwf_plan p) {
    if (!p) return;
    if (p->cfg) kiss_fft_free(p->cfg); // macro -> free (kiss_fft.h)
    delete p;
}

#else
#error "gxfx_shims/fftw3.h is C++-only (the gxfx TUs are C++; a C include path does not exist)"
#endif // __cplusplus

#endif // GXFX_SHIMS_FFTW3_H

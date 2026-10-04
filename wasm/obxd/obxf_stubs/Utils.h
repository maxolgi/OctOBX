// wasm/obxd/obxf_stubs/Utils.h — minimal compile-time stub.
//
// The OB-Xf engine headers (engine/AudioUtils.h etc., now compiled straight
// from third_party/OB-Xf/src) transitively include <Utils.h>. The fork's real
// src/Utils.h is dominated by a host-glue `Utils` class (patch-folder
// scanning, theme folders, clipboard, GUI scale) that depends on the
// unresolvable "filesystem/import.h" and pulls in juce_gui_basics + the
// full juce_audio_processors — none of which we want in a WASM build.
//
// Since OB-Xf #705, `linsc`/`logsc` live in
// third_party/OB-Xf/src/engine/ParamScales.h, which VoiceMatrix.h pulls in
// via a same-directory include the stub cannot shadow — so the stub must NOT
// define them (they now arrive natively from ParamScales.h). The stub
// provides only `getPitch` (our fast-exp OctOBX perf variant of the
// upstream src/Utils.h one) plus the <Constants.h> include that supplies
// `mult`. The host-glue `Utils` class is intentionally NOT declared, and
// upstream src/Utils.h stays shadowed by -I order — the Makefile puts
// obxf_stubs BEFORE ../../third_party/OB-Xf/src in OBXF_INCLUDES — because
// it does not compile headless.
#ifndef OBXF_STUB_UTILS_H
#define OBXF_STUB_UTILS_H

#include <cmath>
#include <cstdint>
// Constants.h defines `mult` (ln2 / 12), used by getPitch below. Resolves to
// the fork's core/Constants.h via the -I ../../third_party/OB-Xf/src/core
// include path (the stub dir intentionally carries no copy).
#include <Constants.h>

/*
 * Fast exp for the per-sample pitch path. getPitch() is called three times
 * per voice per sample (osc1 pitch, osc2 pitch, filter cutoff); wasm's libm
 * exp costs ~80ns per call, which made a single sounding voice consume ~27%
 * of a core (measured 0.27us/voice/sample in the browser). This split
 * variant (exp(x) = 2^fi * 2^f, fi = round(x*log2e), f in [-0.5,0.5], 2^fi
 * via the float exponent field, 2^f via a degree-6 polynomial) has max
 * relative error ~3e-5 — about 0.05 cents on pitch, far below audibility —
 * and compiles to a handful of wasm ops.
 *
 * Valid while |fi| stays well under 127 (getPitch arguments span roughly
 * -100..+140 semitones, i.e. |fi| <= ~12); callers beyond that must use
 * std::exp.
 */
inline static float fastExpf(float x)
{
    const float log2e = 1.44269504088896340736f;
    const float t = x * log2e;
    const float fi = (t >= 0.f) ? floorf(t + 0.5f) : ceilf(t - 0.5f); // nearest int
    const float f = t - fi;                                           // [-0.5, 0.5]

    // minimax polynomial for 2^f on [-0.5, 0.5]
    float p = 1.525321210e-4f;
    p = p * f + 1.321783501e-3f;
    p = p * f + 9.579998120e-3f;
    p = p * f + 5.548336081e-2f;
    p = p * f + 2.401383112e-1f;
    p = p * f + 6.931471806e-1f;
    p = p * f + 1.000000000e+0f;

    // 2^fi by constructing the float exponent field ((fi + 127) << 23).
    // fi is integral and |fi + 127| <= ~140, so the product is an exact
    // integer and the reinterpretation yields exactly 2^fi.
    union { float f; int32_t i; } scale;
    scale.i = (int32_t)((fi + 127.f) * 8388608.f);
    return p * scale.f;
}

inline static float getPitch(float index) { return 440.f * fastExpf(mult * index); };

#endif // OBXF_STUB_UTILS_H

// wasm/obxd/obxf_imported/Utils.h — minimal compile-time stub.
//
// The OB-Xf engine/headers transitively include <Utils.h> (see
// engine/AudioUtils.h). The real OB-Xf src/Utils.h is dominated by a host-glue
// `Utils` class (patch-folder scanning, theme folders, clipboard, GUI scale)
// that depends on the unresolvable "filesystem/import.h" and pulls in
// juce_gui_basics + the full juce_audio_processors — none of which we want in
// a WASM build.
//
// AudioUtils.h / SynthEngine.h / OscillatorBlock.h / Voice.h only need the
// three engine math free-functions defined at the TOP of the real Utils.h
// (getPitch, linsc, logsc). This stub provides exactly those, verbatim from
// third_party/OB-Xf/src/Utils.h lines 30-40, plus the <Constants.h> include
// that supplies `mult` (used by getPitch). The host-glue `Utils` class is
// intentionally NOT declared.
//
// See MANIFEST.md §4a.
#ifndef OBXF_STUB_UTILS_H
#define OBXF_STUB_UTILS_H

#include <cmath>
#include <cstdint>
// Constants.h defines `mult` (ln2 / 12), used by getPitch below. Both the
// root obxf_imported/Constants.h and obxf_imported/core/Constants.h share the
// same include guard, so the later `<core/Constants.h>` pulled in by
// SynthEngine.h is a no-op.
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

inline static float linsc(float param, const float min, const float max)
{
    return (param) * (max - min) + min;
}

inline static float logsc(float param, const float min, const float max, const float rolloff = 19.f)
{
    return ((std::exp(param * std::log(rolloff + 1.f)) - 1.f) / (rolloff)) * (max - min) + min;
}

#endif // OBXF_STUB_UTILS_H

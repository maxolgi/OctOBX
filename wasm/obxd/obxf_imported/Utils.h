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
// Constants.h defines `mult` (ln2 / 12), used by getPitch below. Both the
// root obxf_imported/Constants.h and obxf_imported/core/Constants.h share the
// same include guard, so the later `<core/Constants.h>` pulled in by
// SynthEngine.h is a no-op.
#include <Constants.h>

inline static float getPitch(float index) { return 440.f * std::exp(mult * index); };

inline static float linsc(float param, const float min, const float max)
{
    return (param) * (max - min) + min;
}

inline static float logsc(float param, const float min, const float max, const float rolloff = 19.f)
{
    return ((std::exp(param * std::log(rolloff + 1.f)) - 1.f) / (rolloff)) * (max - min) + min;
}

#endif // OBXF_STUB_UTILS_H

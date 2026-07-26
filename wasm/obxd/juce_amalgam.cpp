/*
 * wasm/obxd/juce_amalgam.cpp — single TU that compiles the .cpp
 * implementations of juce_core + juce_events + juce_audio_basics +
 * juce_audio_processors_headless via the standard JUCE "amalgamated
 * source" pattern.
 *
 * This MUST live in a translation unit separate from main_obxd.cpp.
 * JUCE's module .cpp files begin with:
 *
 *     #ifdef JUCE_CORE_H_INCLUDED
 *      #error "Incorrect use of JUCE cpp file"
 *     #endif
 *
 * so they refuse to compile if the matching header has already been
 * pulled in. main_obxd.cpp includes juce_audio_basics.h (and therefore
 * juce_core.h); this file intentionally does NOT include either header
 * and just feeds the .cpp files the config they need.
 *
 * Output is linked into the same final WASM module as main_obxd.cpp by
 * em++ (single em++ invocation takes both source files).
 *
 * -------------------------------------------------------------------------
 * WHY juce_audio_processors_headless AND NOT juce_audio_processors?
 * -------------------------------------------------------------------------
 * The OB-Xf migration needs juce::AudioParameterFloat (OB-Xf's SynthParam.h
 * inherits from it). AudioParameterFloat lives in the juce_audio_processors
 * module. The FULL juce_audio_processors module, however, CANNOT be built
 * for WASM:
 *
 *   1. Its .cpp unconditionally `#include <juce_gui_extra/juce_gui_extra.h>`
 *      and `#include "juce_audio_processors.h"` (which in turn pulls
 *      juce_gui_basics.h). There is NO JUCE_* define that suppresses those
 *      includes — they are hardcoded in juce_audio_processors.cpp.
 *   2. Under JUCE_WASM, juce_audio_processors/utilities/juce_PluginHostType.cpp
 *      hits a hard `#error` (its host-detection switch only covers
 *      Linux/BSD/iOS/Android/Mac/Windows; WASM matches none).
 *   3. The leak-detector stub macro below chokes on the templated GUI class
 *      juce_SelectedItemSet<SelectableItemType>.
 *
 * JUCE 8.0.14 (the version in third_party/JUCE/) splits out a
 * juce_audio_processors_headless module that exposes the EXACT SAME
 * juce::AudioParameterFloat / juce::AudioProcessor / juce::RangedAudioParameter
 * classes but depends ONLY on juce_audio_basics + juce_events (no GUI, no
 * PluginHostType host-detection #error). This is the JUCE-sanctioned path
 * for non-GUI / headless processor use and is what we amalgamate here.
 *
 * ==> DEVIATION NOTE (for Manager review): the originating task asked for
 *     "juce_audio_processors". The full module is unbuildable for WASM (see
 *     above; verified empirically). juce_audio_processors_headless is the
 *     GUI-free drop-in that provides the identical AudioParameterFloat and
 *     is the only viable way to satisfy "don't introduce a GUI dependency".
 *     The downstream OB-Xf SynthParam.h consumes juce::AudioParameterFloat;
 *     it does not care which JUCE module header exposed the class. <==
 *
 * Module source: third_party/JUCE/modules (JUCE 8.0.14). This is the same
 * JUCE copy the existing amalgam already uses and the same path the Makefile
 * puts first on the include search, so juce_core/juce_audio_basics stay on
 * one consistent version. (third_party/OB-Xf/libs/JUCE is v8.0.10 and does
 * NOT have the headless split — another reason to source all four modules
 * from third_party/JUCE/.)
 */

// ---- Force JUCE into its WASM code path ---------------------------------
//
// emscripten defines BOTH __linux__ and __wasm__. JUCE's TargetPlatform.h
// checks __linux__ BEFORE __wasm__ in its #elif chain, so without this
// undef JUCE would set JUCE_LINUX and take the Linux code paths
// (langinfo, ifaddrs, pthread-only paths) which won't compile under
// emscripten. With __linux__ gone, TargetPlatform.h's `#elif defined(__wasm__)`
// branch fires and defines JUCE_WASM, which is what every other JUCE
// WASM guard in the codebase keys off of.
#undef __linux__

#define JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED 1
#define JUCE_MODULE_AVAILABLE_juce_core                      1
#define JUCE_MODULE_AVAILABLE_juce_events                    1
#define JUCE_MODULE_AVAILABLE_juce_audio_basics              1
#define JUCE_MODULE_AVAILABLE_juce_audio_processors_headless 1

// juce_SystemStats_wasm.cpp (reached via juce_core.cpp when JUCE_WASM is
// set) calls emscripten_get_now() but never includes <emscripten.h>.
// Including it here before any JUCE cpp file makes the symbol available.
#include <emscripten.h>

// The leak detector adds per-class static lifecycle machinery that we
// don't need in an AudioWorkletGlobalScope and that can cause static
// init order surprises. Stubbing it to a no-op class template avoids
// pulling any of that in. (Must precede any JUCE header include.)
//
// NOTE: this stub macro does not tolerate template class names (the token
// paste produces an illegal `LeakDetectorDummyFor_Foo<bar>`). That is one
// of the reasons the FULL juce_audio_processors (which reaches the GUI
// header juce_SelectedItemSet<SelectableItemType>) cannot be amalgamated;
// juce_audio_processors_headless never touches that header.
#define JUCE_LEAK_DETECTOR(ClassName) \
    public: \
    class LeakDetectorDummyFor_##ClassName { public: LeakDetectorDummyFor_##ClassName() = default; }; \
    LeakDetectorDummyFor_##ClassName leakDetectorDummyMember_##ClassName; \
    private:

// Disable JUCE's own assertions in the amalgamated TU. The Obxd engine
// is hot-loop code; we don't want jassert's overhead even in debug.
#define JUCE_ASSERTIONS 0
#define JUCE_LOG_ASSERTIONS 0

// ---- Module compile order respects JUCE's dependency DAG ----------------
//   juce_core                          (no deps)
//   juce_events                        (depends on juce_core)
//   juce_audio_basics                  (depends on juce_core)
//   juce_audio_processors_headless     (depends on juce_audio_basics + juce_events)
#include <juce_core/juce_core.cpp>
#include <juce_events/juce_events.cpp>
#include <juce_audio_basics/juce_audio_basics.cpp>
#include <juce_audio_processors_headless/juce_audio_processors_headless.cpp>

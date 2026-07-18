/*
 * wasm/obxd/juce_amalgam.cpp — single TU that compiles the .cpp
 * implementations of juce_core + juce_audio_basics via the standard
 * JUCE "amalgamated source" pattern.
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
#define JUCE_MODULE_AVAILABLE_juce_core          1
#define JUCE_MODULE_AVAILABLE_juce_audio_basics  1

// juce_SystemStats_wasm.cpp (reached via juce_core.cpp when JUCE_WASM is
// set) calls emscripten_get_now() but never includes <emscripten.h>.
// Including it here before any JUCE cpp file makes the symbol available.
#include <emscripten.h>

// The leak detector adds per-class static lifecycle machinery that we
// don't need in an AudioWorkletGlobalScope and that can cause static
// init order surprises. Stubbing it to a no-op class template avoids
// pulling any of that in. (Must precede any JUCE header include.)
#define JUCE_LEAK_DETECTOR(ClassName) \
    public: \
    class LeakDetectorDummyFor_##ClassName { public: LeakDetectorDummyFor_##ClassName() = default; }; \
    LeakDetectorDummyFor_##ClassName leakDetectorDummyMember_##ClassName; \
    private:

// Disable JUCE's own assertions in the amalgamated TU. The Obxd engine
// is hot-loop code; we don't want jassert's overhead even in debug.
#define JUCE_ASSERTIONS 0
#define JUCE_LOG_ASSERTIONS 0

#include <juce_core/juce_core.cpp>
#include <juce_audio_basics/juce_audio_basics.cpp>

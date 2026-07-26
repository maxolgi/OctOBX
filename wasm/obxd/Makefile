# wasm/obxd/Makefile — Emscripten WASM build for the in-browser Obxd synth.
#
# Phase 2: real Obxd SynthEngine (from third_party/Obxd) + juce_audio_basics
# (from third_party/JUCE). Phase 1's sine-wave stub has been replaced by
# main_obxd.cpp.
#
# Output goes to ../build/ so vite.config.ts (publicDir=wasm/build) serves it
# at the site root (e.g. /obxd_wasm.js).
#
# Usage:
#   source /path/to/emsdk_env.sh
#   make            # build obxd_wasm.js + obxd_wasm.wasm
#   make clean
#
# Prerequisites: em++ (Emscripten) must be in PATH. The Obxd and JUCE
# submodules must be initialised (git submodule update --init --recursive).

CXX = em++

TARGET = ../build/obxd_wasm

# Source files — main_obxd.cpp is the engine wrapper; juce_amalgam.cpp
# compiles juce_core + juce_audio_basics into the same final WASM module.
# juce_amalgam.cpp MUST be a separate TU because JUCE's .cpp files refuse
# to compile in any TU where the matching .h has already been included.
# obxf_imported/state/ObxdImporter.cpp: OB-Xf parameter/importer subsystem
# (copied verbatim from third_party/OB-Xf — see obxf_imported/MANIFEST.md).
# Only .cpp files belong in SRCS; the OB-Xf .h files are pulled in via the
# include chain, and obxf_param_mappings.h is #include'd where used.
SRCS = main_obxd.cpp juce_amalgam.cpp obxf_imported/state/ObxdImporter.cpp

# OB-Xf include paths — required by the obxf_imported/ subtree:
#   sst-basic-blocks: sst/basic-blocks/params/ParamMetadata.h (SynthParam.h)
#   sst-cpputils:     SST support headers
#   fmt:              <fmt/core.h> (pulled transitively by SST headers)
#   simde:            SSE -> wasm SIMD shim. NOTE: the parent dir, NOT
#                     simde/simde — headers #include <simde/...>
#   JUCE/modules:     <juce_audio_basics/...> for SynthParam.h, and
#                     <juce_dsp/...> for Lfo.h (header-only)
#   obxf_imported/*:  cross-directory relative includes inside the copied
#                     subtree (see obxf_imported/MANIFEST.md §4c). Paths
#                     follow the existing ../../third_party convention.
# IMPORTANT: we intentionally do NOT add `-I ../../third_party/OB-Xf/src`.
# The curated obxf_imported/ subtree (with its Utils.h stub) is the ONLY
# OB-Xf source root on the path. Adding the submodule src/ would shadow
# the curated engine/ headers and pull in GUI/host deps (filesystem/import.h,
# full juce_audio_processors → juce_gui_basics) that the curated copy
# deliberately excludes.
OBXF_INCLUDES = \
    -I ../../third_party/OB-Xf/libs/sst/sst-basic-blocks/include \
    -I ../../third_party/OB-Xf/libs/sst/sst-cpputils/include \
    -I ../../third_party/OB-Xf/libs/fmt/include \
    -I ../../third_party/OB-Xf/libs/simde \
    -I ../../third_party/OB-Xf/libs/JUCE/modules \
    -I obxf_imported \
    -I obxf_imported/state \
    -I obxf_imported/parameter \
    -I obxf_imported/engine \
    -I obxf_imported/core

# -sENVIRONMENT=worker sets up the runtime for a worker-like scope
#   (no `window`, no `document`). Used because AudioWorkletGlobalScope is
#   worker-like. Note: AWP also forbids `importScripts()` and dynamic
#   `import()`, so we cannot load the emcc output via either mechanism
#   from a separate file. Instead, build.sh concatenates the emcc JS
#   output with src/obxd-processor.tail.js into a single classic script
#   (build/obxd-processor.js) which is fed wholesale to
#   audioWorklet.addModule().
# NO -pthread: pthreads are illegal inside AudioWorkletGlobalScope.
#
# C++ standard: -std=c++20 is MANDATORY — sst-basic-blocks static_asserts
#   require __cplusplus >= 202002L and fail under c++17.
# -msimd128: enables SSE intrinsics -> wasm SIMD via SIMDE (the OB-Xf
#   engine/DSP headers use SSE).
# -Wno-deprecated-pragma: silences SIMDE/HEDLEY deprecation pragmas.
#
# Include paths:
#   -I .                                       (this dir)
#   -I ../../third_party/JUCE/modules          (for <juce_audio_basics/...> and
#                                               <juce_dsp/...>; juce_dsp is used
#                                               header-only by obxf_imported's
#                                               Lfo.h for FastMathApproximations)
#   $(OBXF_INCLUDES)                           (OB-Xf libs/ + copied subtree;
#                                               obxf_imported/engine resolves
#                                               the NEW SynthEngine.h)
# NOTE: the OLD `-I ../../third_party/Obxd/Source/Engine` path was REMOVED —
# the OB-Xd→OB-Xf migration is one-way. main_obxd.cpp now includes the NEW
# engine explicitly via `#include "engine/SynthEngine.h"` (resolved through
# -I obxf_imported).
# JUCE module availability — required by ObxdImporter.cpp's TU.
# In OB-Xf's native CMake build, juce_add_binary_data / target_link_libraries
# auto-generates these via target_compile_definitions on every consumer TU.
# Our hand-written Makefile has no such machinery, so define them globally.
# main_obxd.cpp and juce_amalgam.cpp already set these in-file (idempotent
# re-define is harmless), and ObxdImporter.cpp NEEDS them before its first
# JUCE header include (otherwise juce_TargetPlatform.h #errors with
# "No global header file was included!").
# Note: juce_audio_processors_headless depends on juce_audio_basics + juce_events,
# so all four modules must be flagged available even though ObxdImporter.cpp
# only explicitly includes two of them.
JUCE_MODULE_DEFINES = \
    -DJUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1 \
    -DJUCE_MODULE_AVAILABLE_juce_core=1 \
    -DJUCE_MODULE_AVAILABLE_juce_events=1 \
    -DJUCE_MODULE_AVAILABLE_juce_audio_basics=1 \
    -DJUCE_MODULE_AVAILABLE_juce_audio_processors_headless=1 \
    -DJUCE_MODULE_AVAILABLE_juce_dsp=1

CXXFLAGS = -O3 -g2 \
    -std=c++20 \
    -msimd128 \
    -Wall \
    -Wno-unused-parameter \
    -Wno-unused-variable \
    -Wno-unused-but-set-variable \
    -Wno-deprecated-pragma \
    $(JUCE_MODULE_DEFINES) \
    -I . \
    -I ../../third_party/JUCE/modules \
    $(OBXF_INCLUDES)

# Export list MUST be kept in sync with src/obxd-processor.tail.js.
# Multi-instance (Phase A) — every per-instance export takes an instance_id
# first arg. _obxd_set_freq is kept (as a no-op) for backwards compat with
# stale worklet messages. _obxd_panic_all is the global convenience.
# _obxd_set_mpe toggles per-instance MPE note-signature routing (OB-Xf engine
# is channel-aware; channel routing through the bridge is task T20).
# _obxd_set_mod_wheel / _obxd_set_sustain (Fix 2) route reserved CCs 1/64
# directly to the engine, bypassing the unreliable Octopus-echo path.
# (Keep on a single physical line — Make's `\<newline>` continuation
# inserts whitespace, which the emcc settings parser rejects.)
EXPORTS = _obxd_init,_obxd_render,_obxd_set_active,_obxd_set_polyphony,_obxd_get_polyphony,_obxd_midi_in,_obxd_set_gain,_obxd_set_param,_obxd_get_param,_obxd_load_fxp,_obxd_all_notes_off,_obxd_panic,_obxd_panic_all,_obxd_reset_patch,_obxd_get_patch_name,_obxd_set_factory_patch,_obxd_get_active,_obxd_get_instance_rms,_obxd_set_freq,_obxd_set_mpe,_obxd_set_mod_wheel,_obxd_set_sustain,_get_buf_l_ptr,_get_buf_r_ptr,_malloc,_free

# INITIAL_MEMORY: 256 MB. The OB-Xf engine is MUCH heavier than the legacy
#   OB-Xd: each SynthEngine owns a fixed `Voice voices[MAX_VOICES]` array
#   (MAX_VOICES=32 vs OB-Xd's 8), and each Voice carries a full VoiceMatrix,
#   two LFOs, two ADSRs, OscillatorBlock, Filter, etc. Ten instances allocated
#   back-to-back during obxd_init() exceed the old 64 MB ceiling and produced
#   a null-deref trap ("memory access out of bounds") inside the AudioWorklet
#   when the first large `new SynthEngine()` could not grow the heap fast
#   enough. 256 MB gives the allocation burst headroom on Linux (permissive);
#   Windows Chrome/Edge are stricter, but ALLOW_MEMORY_GROWTH lets the heap
#   start here and expand at runtime rather than committing 256 MB upfront.
#   If a Windows AWP instantiation ever rejects this, drop to 128 MB and
#   accept an extra growth fault on the first allocation.
# STACK_SIZE: 1 MB (default is 64 KB). The OB-Xf headers pull in ~230
#   `static const std::string` globals (SynthParam::ID::*) plus a static
#   `std::vector<ParameterInfo> ParameterList` in ParameterList.h. Their
#   combined `_GLOBAL__sub_I` static-init pass needs ~200 KB of stack
#   (verified via a node diagnostic — the default 64 KB stack overflowed
#   with "Attempt to set SP to 0xffff5b30" during module construction,
#   before _obxd_init even ran). JUCE's native build uses an 8 MB stack
#   so this never surfaced upstream; emscripten's default is far smaller.
#   1 MB comfortably covers both the static-init burst and per-quantum
#   render of 32-voice DSP.
# DISABLE_EXCEPTION_CATCHING=0: JUCE/Obxd use std::exception paths in
#   a few places (notably juce::String); keeping EH enabled avoids UB
#   if any of those throws. The default (1) would mask the throw and
#   potentially corrupt state.
# EXPORTED_RUNTIME_METHODS: HEAPF32/HEAPU8 are needed by the worklet's
# process() loop (cached Float32Array views); getValue/setValue back the
# set_param path. Phase 4 adds _malloc/_free (load_fxp copies bytes into
# WASM heap) and UTF8ToString (read obxd_get_patch_name's C string).
LDFLAGS = -sWASM=1 \
    -sENVIRONMENT=worker \
    -sMODULARIZE=1 \
    -sEXPORT_NAME=ObxdModuleFactory \
    -sEXPORTED_FUNCTIONS=$(EXPORTS) \
    -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPF32,HEAPU8,getValue,setValue,UTF8ToString \
    -sALLOW_MEMORY_GROWTH=1 \
    -sINITIAL_MEMORY=268435456 \
    -sSTACK_SIZE=1048576 \
    -sFORCE_FILESYSTEM=0 \
    -sDISABLE_EXCEPTION_CATCHING=0 \
    -o $(TARGET).js

.PHONY: all clean obxf-check

all: $(TARGET).js

$(TARGET).js: $(SRCS)
	@mkdir -p ../build
	$(CXX) $(CXXFLAGS) $(SRCS) $(LDFLAGS)

# obxf-check: parse the OB-Xf headers in isolation (-fsyntax-only, no
# codegen/link) to surface include-chain errors fast without a full build.
# -include forces each key header through the chain; the OB-Xf -I paths
# (plus ../../third_party/JUCE/modules for SynthParam.h) let them resolve.
# Run with: make obxf-check   (em++ must be in PATH)
obxf-check:
	em++ -std=c++20 -msimd128 -O0 -fsyntax-only \
	  -I . \
	  -I ../../third_party/JUCE/modules \
	  $(OBXF_INCLUDES) \
	  -include SynthParam.h \
	  -include ParameterList.h \
	  -include ObxdImporter.h \
	  -include Program.h

clean:
	rm -f ../build/obxd_wasm.js ../build/obxd_wasm.wasm ../build/obxd_wasm.wasm.map ../build/obxd-processor.js

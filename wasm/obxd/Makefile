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
SRCS = main_obxd.cpp juce_amalgam.cpp

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
# Include paths:
#   -I .                                       (this dir)
#   -I ../../third_party/Obxd/Source/Engine    (for #include "SynthEngine.h")
#   -I ../../third_party/JUCE/modules          (for <juce_audio_basics/...>)
CXXFLAGS = -O3 -g2 \
    -std=c++17 \
    -Wall \
    -Wno-unused-parameter \
    -Wno-unused-variable \
    -Wno-unused-but-set-variable \
    -I . \
    -I ../../third_party/Obxd/Source/Engine \
    -I ../../third_party/JUCE/modules

# Export list MUST be kept in sync with src/obxd-processor.tail.js.
# Multi-instance (Phase A) — every per-instance export takes an instance_id
# first arg. _obxd_set_freq is kept (as a no-op) for backwards compat with
# stale worklet messages. _obxd_panic_all is the global convenience.
# (Keep on a single physical line — Make's `\<newline>` continuation
# inserts whitespace, which the emcc settings parser rejects.)
EXPORTS = _obxd_init,_obxd_render,_obxd_set_active,_obxd_set_polyphony,_obxd_get_polyphony,_obxd_midi_in,_obxd_set_gain,_obxd_set_param,_obxd_get_param,_obxd_load_fxp,_obxd_all_notes_off,_obxd_panic,_obxd_panic_all,_obxd_reset_patch,_obxd_get_patch_name,_obxd_set_factory_patch,_obxd_get_active,_obxd_get_instance_rms,_obxd_set_freq,_get_buf_l_ptr,_get_buf_r_ptr,_malloc,_free

# INITIAL_MEMORY: 64 MB. Actual usage is ~20 MB (10 SynthEngine instances
#   at ~1-2 MB each + JUCE core ~5-10 MB + small static state). Kept
#   conservative because Windows Chrome/Edge frequently reject large
#   initial WASM allocations inside AudioWorkletGlobalScope where Linux
#   is permissive. ALLOW_MEMORY_GROWTH lets it expand at runtime if needed.
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
    -sINITIAL_MEMORY=67108864 \
    -sFORCE_FILESYSTEM=0 \
    -sDISABLE_EXCEPTION_CATCHING=0 \
    -o $(TARGET).js

.PHONY: all clean

all: $(TARGET).js

$(TARGET).js: $(SRCS)
	@mkdir -p ../build
	$(CXX) $(CXXFLAGS) $(SRCS) $(LDFLAGS)

clean:
	rm -f ../build/obxd_wasm.js ../build/obxd_wasm.wasm ../build/obxd_wasm.wasm.map ../build/obxd-processor.js

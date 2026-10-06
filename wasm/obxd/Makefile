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
# ObxdImporter.cpp is compiled straight out of the OB-Xf fork tree
# (../../third_party/OB-Xf/src — the maxolgi/OB-Xf fork main carries our
# PCM-sampler + wasm perf commits).
# Only .cpp files belong in SRCS; the OB-Xf .h files are pulled in via the
# include chain; the generated param_table.h is #include'd by main_obxd.cpp.
# gxfx_dsp.cpp + gxfx_host.cpp are the guitarix FX chain (see below) —
# separate TUs that must NEVER include JUCE/OB-Xf headers. gxfx_dsp_drive.cpp
# is the Phase 1-a drive + dynamics family (fuzzes/boosters/expander/susta;
# pulls trany.h + its tube tables at global scope, include-once).
# gxfx_dsp_eq.cpp is the Phase 1-b eq family (graphiceq + the selecteq/
# tonecontroll/moog/low_high_pass/noise_shaper orphans). gxfx_dsp_wah.cpp is
# the Phase 1-c wah family (the 7 gx_colwah.lv2 wah models behind the
# host-side WahModelDsp aggregate + the crybaby orphan + both gxautowah.lv2
# variants from the bundle-local dunwahauto.cc). gxfx_dsp_mod.cpp is the
# Phase 1-d modulation family (bundle-local gx_vibe.lv2/vibe.cc stereo +
# the 12ax7-table gxtubetremelo/gxtubevibrato + gx_switched_tremolo + the
# classic stereo phaser/flanger + mono chorus orphans). gxfx_dsp_time.cpp is
# the Phase 1-e time/delay family (bundle-local duck_delay(.st) +
# digital_delay(.st) + the 12au7-table gxtape(.st) + copicat gxechocat +
# 12ax7 gxtubedelay + the ts9 circuit sim + oc_2 octaver + the classic mono
# delay/echo orphans; beat.h include-once + digital_delay's 4 MB fVec2 —
# see that file's header). gxfx_dsp_reverb.cpp is the Phase 1-f reverb
# family (the standalone gx_zita_rev1 stereo FDN + the freeverb orphan +
# the bundle-local room_simulator + shimmizita classes; multi-MB fixed
# delay-line members — see that file's header). gxfx_dsp_amps.cpp is the
# Phase 1-g amp + tonestack family (valve.h include-once at global scope
# shares the 14 tube_tables/*.cc (~2.2 MB) across the 19 gxamp namespaces
# behind the "Amp Model" aggregate; the "Tone Stack" aggregate over the 27
# stereo tonestack classes; studiopre_st/alembic/w20 preamps + the Phase
# 1-h ampmodul postamp, which needs valve.h too — slow compile, see that
# file's header). gxfx_mb.cpp is the Phase 1-h multiband + utility family
# (the four gx_mb* bundles + the bundle-local barkgraphiceq with its
# orfanidis_eq solver, meters parked on TU-local scratch; balance/
# outputlevel/ampout orphans). gxfx_convolver.cpp is the Phase 2-a
# self-written partitioned convolution core (uniformly partitioned
# overlap-save over vendored kissfft — wasm/obxd/kissfft/, BSD-3; the
# kissfft .c files are compiled exactly once, inside that TU, so NO other
# TU may include them). gxfx_dsp_conv.cpp is the Phase 2-a convolution
# family TU (cab_data IR tables at global scope + the bundle's Impf
# impulse former + the Cabinet PluginLV2 wrapper). gxfx_dsp_detune.cpp is
# the Phase 2-c detune TU (gx_detune.lv2's smbPitchShift over the
# gxfx_shims/fftw3.h kissfft shim; the shim dir must stay FIRST in
# GXFU_INCLUDES so <fftw3.h> resolves there).
# gxfx_dsp_tuner.cpp is the Phase 2-d tuner TU (gxtuner.lv2's NSDF pitch
# tracker over the EXTENDED fftw shim r2r subset; pthread/semaphore/sigc++
# neutralized via gxfx_shims — the analysis runs inline on a ~100 ms
# cadence and the FREQ control output port feeds g_fx_out).
SRCS = main_obxd.cpp juce_amalgam.cpp gxfx_dsp.cpp gxfx_dsp_drive.cpp gxfx_dsp_eq.cpp gxfx_dsp_wah.cpp gxfx_dsp_mod.cpp gxfx_dsp_time.cpp gxfx_dsp_reverb.cpp gxfx_dsp_amps.cpp gxfx_mb.cpp gxfx_convolver.cpp gxfx_dsp_conv.cpp gxfx_dsp_detune.cpp gxfx_dsp_tuner.cpp gxfx_host.cpp ../../third_party/OB-Xf/src/state/ObxdImporter.cpp

# Header dependencies — most of the engine lives in headers (Voice.h,
# Motherboard.h, OscillatorBlock.h, Filter.h, Utils.h, ...) #include'd by the
# three TUs above. Without them as prerequisites, a header-only change (e.g.
# the fast-exp getPitch in the obxf_stubs Utils.h, or anything under the
# fork's src/ tree) makes `make` report "up to date" and serve a stale wasm.
# The wildcards cover the stub dir plus the fork tree (src/*.h and one
# subdir level: core/, engine/, parameter/, state/, ...). (The generated
# param_table.h is NOT listed — it doesn't exist on a fresh clone before
# build.sh synth generates it; its staleness is gated separately by
# gen-param-table.mjs --check in build.sh.)
HDRS = $(wildcard obxf_stubs/*.h ../../third_party/OB-Xf/src/*.h ../../third_party/OB-Xf/src/*/*.h gxfx_prelude.h ../../third_party/guitarix/trunk/src/LV2/DSP/gx_pluginlv2.h ../../third_party/guitarix/trunk/src/LV2/DSP/trany.h ../../third_party/guitarix/trunk/src/LV2/DSP/beat.h ../../third_party/guitarix/trunk/src/LV2/DSP/valve.h ../../third_party/guitarix/trunk/src/LV2/DSP/tube_tables/*.cc ../../third_party/guitarix/trunk/src/LV2/DSP/circuit_tables/*.h ../../third_party/guitarix/trunk/src/LV2/gxautowah.lv2/dunwahauto.cc ../../third_party/guitarix/trunk/src/LV2/gx_vibe.lv2/vibe.cc ../../third_party/guitarix/trunk/src/LV2/gx_duck_delay.lv2/duck_delay.cc ../../third_party/guitarix/trunk/src/LV2/gx_duck_delay_st.lv2/duck_delay_st.cc ../../third_party/guitarix/trunk/src/LV2/gx_digital_delay.lv2/digital_delay.cc ../../third_party/guitarix/trunk/src/LV2/gx_digital_delay_st.lv2/digital_delay_st.cc ../../third_party/guitarix/trunk/src/LV2/gxts9.lv2/ts9sim.cc ../../third_party/guitarix/trunk/src/LV2/gxts9.lv2/ts9nonlin.cc ../../third_party/guitarix/trunk/src/LV2/gxts9.lv2/ts9nonlin.h ../../third_party/guitarix/trunk/src/LV2/gx_oc_2.lv2/oc_2.cc ../../third_party/guitarix/trunk/src/LV2/gx_oc_2.lv2/triggers_logic.h ../../third_party/guitarix/trunk/src/LV2/gx_room_simulator.lv2/room_simulator.cc ../../third_party/guitarix/trunk/src/LV2/gx_shimmizita.lv2/shimmizita.cc ../../third_party/guitarix/trunk/src/LV2/gx_barkgraphiceq.lv2/barkgraphiceq.cc ../../third_party/guitarix/trunk/src/LV2/gx_barkgraphiceq.lv2/orfanidis_eq.h ../../third_party/guitarix/trunk/src/LV2/gx_barkgraphiceq.lv2/bark_freq_grid.h ../../third_party/guitarix/trunk/src/LV2/faust-generated/*.cc ../../third_party/guitarix/trunk/src/LV2/faust/*.h ../../third_party/guitarix/trunk/src/LV2/faust/clipt*.cc ../../third_party/guitarix/trunk/src/LV2/DSP/gx_resampler.* ../../third_party/guitarix/trunk/src/zita-resampler-1.1.0/zita-resampler/*.h kissfft/*.c kissfft/*.h kissfft/_kiss_fft_guts.h gxfx_convolver.h ../../third_party/guitarix/trunk/src/LV2/DSP/cab_data.cc ../../third_party/guitarix/trunk/src/LV2/DSP/cab_data_table.cc ../../third_party/guitarix/trunk/src/LV2/gx_cabinet.lv2/cabinet_impulse_former.h gxfx_shims/*.h ../../third_party/guitarix/trunk/src/LV2/gx_detune.lv2/detune.cc ../../third_party/guitarix/trunk/src/LV2/gx_detune.lv2/gx_detune.h ../../third_party/guitarix/trunk/src/LV2/gxtuner.lv2/tuner.cc ../../third_party/guitarix/trunk/src/LV2/gxtuner.lv2/gx_pitch_tracker.h ../../third_party/guitarix/trunk/src/LV2/gxtuner.lv2/gx_pitch_tracker.cpp)

# OB-Xf include paths. The engine sources are consumed STRAIGHT from the
# fork tree at ../../third_party/OB-Xf/src (the maxolgi/OB-Xf fork main,
# which carries our PCM-sampler + wasm perf commits) — no curated copy is
# kept any more. Required paths:
#   sst-basic-blocks: sst/basic-blocks/params/ParamMetadata.h (SynthParam.h)
#   sst-cpputils:     SST support headers
#   fmt:              <fmt/core.h> (pulled transitively by SST headers)
#   simde:            SSE -> wasm SIMD shim. NOTE: the parent dir, NOT
#                     simde/simde — headers #include <simde/...>
#   JUCE/modules:     <juce_audio_basics/...> for SynthParam.h, and
#                     <juce_dsp/...> for Lfo.h (header-only)
#   OB-Xf src dirs:   src/ plus its core/, engine/, parameter/, state/
#                     subdirs, matching the fork's cross-directory
#                     includes ("Program.h", <engine/ParamScales.h>, ...)
# STUB SHADOWING: `-I obxf_stubs` MUST come BEFORE `-I .../src`. The fork's
# real src/Utils.h does not compile headless (host-glue `Utils` class →
# "filesystem/import.h" + juce_gui_basics + the full
# juce_audio_processors), and libs/MTS-ESP is intentionally NOT
# initialized (no libMTSClient.h there). The obxf_stubs/ headers shadow
# Utils.h and stand in for libMTSClient.h purely by -I order — swapping
# the order breaks the build.
OBXF_INCLUDES = \
    -I ../../third_party/OB-Xf/libs/sst/sst-basic-blocks/include \
    -I ../../third_party/OB-Xf/libs/sst/sst-cpputils/include \
    -I ../../third_party/OB-Xf/libs/fmt/include \
    -I ../../third_party/OB-Xf/libs/simde \
    -I ../../third_party/OB-Xf/libs/JUCE/modules \
    -I obxf_stubs \
    -I ../../third_party/OB-Xf/src \
    -I ../../third_party/OB-Xf/src/core \
    -I ../../third_party/OB-Xf/src/engine \
    -I ../../third_party/OB-Xf/src/parameter \
    -I ../../third_party/OB-Xf/src/state

# Guitarix FX includes (gxfx_dsp*.cpp / gxfx_host.cpp only — main_obxd.cpp
# and juce_amalgam.cpp must not see these). faust-generated/ holds the DSP
# .cc classes, faust/ holds clipping.h (+ its clipt*.cc tables) pulled in by
# bossds1.cc, DSP/ holds trany.h (tube transfer tables for the fuzzes —
# included ONCE at global scope in gxfx_dsp_drive.cpp), DSP/tube_tables/
# holds the KT88/7199P table .cc files trany.h includes, DSP/circuit_tables/
# holds the guard-less tube/circuit table headers (12ax7 for the tube
# tremolo/vibrato/delay, 12au7 for gxtape, copicat for gxechocat) embedded
# per-namespace in the family TUs (no include guards, so no include-once
# sharing — see gxfx_dsp_mod.cpp / gxfx_dsp_time.cpp),
# zita-resampler-1.1.0 backs gx_resampler's FixedRateResampler (bossds1
# oversampler) and BufferResampler (Phase 2 cabinet IR resampling).
# kissfft/ is the Phase 2 vendored FFT (BSD-3; its .c files are compiled
# exactly once inside gxfx_convolver.cpp, C-linked, so the fftw3.h shim
# TUs link against them). gxfx_shims/ is the Phase 2 include-order shadow
# dir (the obxf_stubs pattern): it MUST stay FIRST so <fftw3.h> resolves
# to the kissfft-backed shim — the emcc sysroot has no fftw, and any later
# path must never grow a real one.
GXFU_INCLUDES = \
    -I gxfx_shims \
    -I ../../third_party/guitarix/trunk/src/LV2/faust-generated \
    -I ../../third_party/guitarix/trunk/src/LV2/faust \
    -I ../../third_party/guitarix/trunk/src/LV2/DSP \
    -I ../../third_party/guitarix/trunk/src/LV2/DSP/tube_tables \
    -I ../../third_party/guitarix/trunk/src/LV2/DSP/circuit_tables \
    -I ../../third_party/guitarix/trunk/src/zita-resampler-1.1.0 \
    -I kissfft

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
#                                               header-only by the fork's
#                                               Lfo.h for FastMathApproximations)
#   $(OBXF_INCLUDES)                           (OB-Xf libs/ + the fork's src/ tree
#                                               and the obxf_stubs/ shadow dir;
#                                               -I .../src resolves the NEW
#                                               SynthEngine.h)
# NOTE: the OLD `-I ../../third_party/Obxd/Source/Engine` path was REMOVED —
# the OB-Xd→OB-Xf migration is one-way. main_obxd.cpp now includes the NEW
# engine explicitly via `#include "engine/SynthEngine.h"` (resolved through
# -I ../../third_party/OB-Xf/src).
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
    -Wno-vla-cxx-extension \
    $(JUCE_MODULE_DEFINES) \
    -I . \
    -I ../../third_party/JUCE/modules \
    $(OBXF_INCLUDES) \
    $(GXFU_INCLUDES)

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
EXPORTS = _obxd_init,_obxd_render,_obxd_set_active,_obxd_set_polyphony,_obxd_get_polyphony,_obxd_midi_in,_obxd_set_gain,_obxd_set_param,_obxd_get_param,_obxd_load_fxp,_obxd_all_notes_off,_obxd_panic,_obxd_panic_all,_obxd_reset_patch,_obxd_get_patch_name,_obxd_set_factory_patch,_obxd_get_factory_patch_count,_obxd_get_factory_patch_name,_obxd_get_factory_patch_category,_obxd_get_active,_obxd_get_instance_rms,_obxd_set_freq,_obxd_set_mpe,_obxd_set_mod_wheel,_obxd_set_sustain,_obxd_get_voice_activity,_obxd_set_mpe_glide_range,_obxd_set_matrix_row,_obxd_clear_matrix_row,_get_buf_l_ptr,_get_buf_r_ptr,_get_track_l_ptr,_get_track_r_ptr,_malloc,_free,_obxd_load_pcm,_obxd_set_pcm_layer,_obxd_set_pcm_note_map,_obxd_set_pcm_layer_count,_obxd_set_pcm_choke,_obxd_clear_pcm,_obxd_set_drum_layer_param,_obxd_get_drum_layer_param,_obxd_is_global_drum_param,_obxd_restore_stage,_obxd_set_master_render,_fx_effect_count,_fx_param_count,_fx_is_stereo,_fx_slot_params,_fx_default,_fx_set_param,_fx_get_param,_fx_set_enabled,_fx_get_enabled,_fx_set_slot,_fx_get_slot,_fx_move_slot,_fx_get_out_param,_fx_test_bittransparent,_fx_restore_ptr,_fx_get_params_ptr,_fx_get_slots_ptr,_fx_get_enabled_ptr

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

$(TARGET).js: $(SRCS) $(HDRS)
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

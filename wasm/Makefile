# wasm/Makefile — Emscripten WASM build for the Octopus engine
#
# AudioWorklet build: the Octopus engine runs inside the SAME
# AudioWorkletGlobalScope as the OB-Xf synth — single-threaded, NO
# pthreads (illegal inside an AudioWorklet). The sequencer is no longer
# a sequencer pthread; it is driven by the sample-based pump export
# octopus_pump(), called from the worklet's process() loop at
# audio-quantum rate.
#
# Linear memory is a shared WebAssembly.Memory created on the JS main
# thread and IMPORTED by this module (-sIMPORTED_MEMORY), so the main
# thread reads the MIR LED array and the status block directly from the
# shared heap. Fixed at 128 MiB (2048 x 64 KiB pages, maximum ==
# initial, no growth). The JS side MUST create a matching memory:
#   new WebAssembly.Memory({initial: 2048, maximum: 2048, shared: true})
#
# The emcc glue output (octopus_wasm.js) is NOT loaded via a <script>
# tag on the main thread any more; build.sh concatenates it into the
# combined AudioWorklet module (build/obxd-processor.js).
#
# Usage:
#   source /path/to/emsdk_env.sh
#   make            # build octopus_wasm.js + octopus_wasm.wasm
#   make clean
#   make NEMO=1     # Nemo variant
#
# Prerequisites: emcc (Emscripten) must be in PATH.

NEMO ?= 0

CC = emcc

# Firmware include paths — relative to this Makefile (wasm/).
# firmware/ submodule lives at the project root, one level up from wasm/.
FWROOT = ..

CFLAGS = -Wall -Wno-unused-function -Wno-unused-variable \
         -Wno-unused-but-set-variable \
         -std=gnu89 -Wno-implicit-int -Wno-int-conversion \
         -O2 -g \
         -D__linux__ \
         -D__EMSCRIPTEN__ \
         -DOCT_AWP \
         -I . \
         -I $(FWROOT)/firmware/OCT_OS \
         -I $(FWROOT)/firmware/OCT_OS/_OCT_global \
         -I $(FWROOT)/firmware/OCT_OS/_OCT_objects \
         -I $(FWROOT)/firmware/OCT_OS/_OCT_Player \
         -I $(FWROOT)/firmware/OCT_OS/_OCT_Viewer \
         -I $(FWROOT)/firmware/OCT_OS/_OCT_exe_keys \
         -I $(FWROOT)/firmware/OCT_OS/_OCT_exe_rots \
         -I $(FWROOT)/firmware/OCT_OS/_OCT_init \
         -I $(FWROOT)/firmware/OCT_OS/_OCT_interrupts

ifeq ($(NEMO),1)
    CFLAGS += -DNEMO \
        -I $(FWROOT)/firmware/NEMO_OS/_NEMO_global \
        -I $(FWROOT)/firmware/NEMO_OS/_NEMO_Viewer \
        -I $(FWROOT)/firmware/NEMO_OS/_NEMO_exe_keys \
        -I $(FWROOT)/firmware/NEMO_OS/_NEMO_exe_rots \
        -I $(FWROOT)/firmware/NEMO_OS/_NEMO_interrupts
    TARGET = build/nemo_wasm
else
    TARGET = build/octopus_wasm
endif

# Same single-TU architecture as the native build
SRCS = main_wasm.c \
       hal_wasm.c \
       midi_wasm.c \
       flash_file.c

# Emscripten link flags — AudioWorklet build:
#   -sENVIRONMENT=worker: AudioWorkletGlobalScope is worker-like (no
#     window/document), same choice as the obxd synth build. AWP also
#     forbids importScripts()/dynamic import(), so the glue cannot be
#     loaded from a separate file — build.sh concatenates it into the
#     combined processor script (see header comment above).
#   NO -pthread / -sUSE_PTHREADS: pthreads are illegal inside
#     AudioWorkletGlobalScope. The sequencer is driven by octopus_pump()
#     instead of a sequencer thread.
#   -sIMPORTED_MEMORY: linear memory is the shared WebAssembly.Memory
#     created on the JS main thread (which reads MIR + status directly);
#     the JS side passes it in via the factory's imports.memory.
#   -sSHARED_MEMORY: marks the wasm's env.memory import SHARED so it links
#     against the JS-created shared Memory. Without it instantiation fails
#     with "LinkError: mismatch in shared state of memory, declared = 0,
#     imported = 1" — the glue's fetch fallback then hangs forever inside
#     the AudioWorklet (the AWP shim's fetch never settles). Shared here
#     only enables cross-thread zero-copy views; there are still NO
#     pthreads (see above) and the C side uses no atomics.
#   -sALLOW_MEMORY_GROWTH=0 + -sINITIAL_MEMORY=134217728: fixed 128 MiB
#     heap — 2048 x 64 KiB pages; must match the JS-created Memory
#     (initial == maximum == 2048) exactly.
LDFLAGS = -sWASM=1 \
    -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPU8,HEAPU32,HEAPF64,getValue,setValue,UTF8ToString,FS \
    -sEXPORTED_FUNCTIONS=_engine_init,_wasm_key_press,_wasm_rotary,_wasm_transport,_wasm_pause,_wasm_set_tempo,_wasm_midi_input,_wasm_save_state,_wasm_load_state,_wasm_shutdown,_get_mir_ptr,_get_processed_mir_ptr,_get_run_bit,_get_tempo,_get_zoom_level,_page_refresh,_wasm_check_refresh,_wasm_set_zoom,_wasm_has_midi_event,_wasm_get_midi_event,_wasm_drain_midi_batch,_get_midi_batch_events_ptr,_get_midi_batch_ts_ptr,_wasm_get_midi_dropped_count,_wasm_get_tick_ns,_wasm_get_sequencer_running,_wasm_get_tick_count,_wasm_consume_state_saved,_get_midi_synth_ring_ptr,_get_midi_synth_ring_head_ptr,_get_midi_synth_ring_tail_ptr,_wasm_get_midi_synth_dropped_count,_octopus_pump,_octopus_set_sample_rate,_get_status_ptr \
    -sALLOW_MEMORY_GROWTH=0 \
    -sINITIAL_MEMORY=134217728 \
    -sSHARED_MEMORY \
    -sSTACK_SIZE=524288 \
    -sENVIRONMENT=worker \
    -sIMPORTED_MEMORY \
    -sEXPORT_NAME=OctopusModuleFactory \
    -sMODULARIZE=1 \
    -sFORCE_FILESYSTEM=1 \
    -o $(TARGET).js

.PHONY: all clean

all: $(TARGET).js

$(TARGET).js: $(SRCS) hal_linux.h
	@mkdir -p build
	$(CC) $(CFLAGS) $(SRCS) $(LDFLAGS)

clean:
	rm -rf build

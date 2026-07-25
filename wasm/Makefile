# wasm/Makefile — Emscripten WASM build for the Octopus engine
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

# Emscripten link flags
LDFLAGS = -sWASM=1 \
    -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPU8,HEAPU32,HEAPF64,getValue,setValue,UTF8ToString,FS \
    -sEXPORTED_FUNCTIONS=_engine_init,_wasm_key_press,_wasm_rotary,_wasm_transport,_wasm_pause,_wasm_set_tempo,_wasm_midi_input,_wasm_save_state,_wasm_load_state,_wasm_shutdown,_get_mir_ptr,_get_processed_mir_ptr,_get_run_bit,_get_tempo,_get_zoom_level,_page_refresh,_wasm_check_refresh,_wasm_has_midi_event,_wasm_get_midi_event,_wasm_drain_midi_batch,_get_midi_batch_events_ptr,_get_midi_batch_ts_ptr,_wasm_get_midi_dropped_count,_wasm_get_tick_ns,_wasm_get_sequencer_running,_wasm_get_tick_count \
    -sALLOW_MEMORY_GROWTH=1 \
    -sINITIAL_MEMORY=67108864 \
    -sENVIRONMENT=web \
    -pthread \
    -sUSE_PTHREADS=1 \
    -sPTHREAD_POOL_SIZE=2 \
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

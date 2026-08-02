/*
 * main_wasm.c — WASM entry point for the Octopus/Nemo engine (OctOBX).
 *
 * Replaces main_linux.c for the Emscripten build. No blocking main() loop —
 * JavaScript drives initialization via engine_init() and calls exported
 * functions for key/rotary/transport input. The sequencer runs in a pthread.
 */

/* Pull in the entire firmware — same include chain as main_linux.c */
#include "_OCT_global/includes.h"
#include "_OCT_global/flash-block.h"
#include "_OCT_objects/PersistentV2.h"

/* Include the .c files into this single TU to match the original architecture */
#include "_OCT_objects/PersistentV1.c"
#include "_OCT_objects/PersistentV2.c"
#include "_OCT_objects/Persistent.c"
#include "_OCT_objects/Phrase.c"
#include "_OCT_objects/Phrase-presets.c"
#include "_OCT_global/flash-block.c"
#include "_OCT_interrupts/cpu-load.c"

#include <signal.h>

/* ============================================================ */
/* Sequencer thread                                             */
/* ============================================================ */

static volatile int sequencer_running = 0;
static pthread_t sequencer_pthread;
volatile long g_tick_ns = 0;
volatile int g_seq_tick_count = 0;

/* Set to 1 when the firmware's internal save (GRID+PGM) writes to MEMFS.
 * JS polls this after each key press to trigger a browser download. */
static volatile int g_state_saved = 0;

static void *sequencer_thread_func(void *arg) {
    (void)arg;

    fprintf(stderr, "sequencer: thread started, g_tick_ns=%ld\n", g_tick_ns);

    struct timespec next;
    clock_gettime(CLOCK_MONOTONIC, &next);

    while (sequencer_running) {
        long add_ns = g_tick_ns;
        if (add_ns <= 0) {
            usleep(1000);
            continue;
        }

        /* Advance to the next absolute deadline */
        next.tv_sec  += (time_t)(add_ns / 1000000000L);
        next.tv_nsec += add_ns % 1000000000L;
        if (next.tv_nsec >= 1000000000L) {
            next.tv_sec++;
            next.tv_nsec -= 1000000000L;
        }

        /* Relative sleep — Emscripten implements via Atomics.wait (~1ms res) */
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);

        long delta_ns = (next.tv_sec - now.tv_sec) * 1000000000L
                      + (next.tv_nsec - now.tv_nsec);

        if (delta_ns > 1000000) {
            struct timespec rel;
            rel.tv_sec = delta_ns / 1000000000L;
            rel.tv_nsec = delta_ns % 1000000000L;
            nanosleep(&rel, NULL);
        }
        /* No busy-wait in WASM — burns CPU without improving precision */

        g_seq_tick_count++;

        /* Send MIDI clock BEFORE acquiring the scheduler lock */
        {
            unsigned char next_ttc = (G_TTC_abs_value % 12) + 1;
            if (next_ttc % 2 == 1) {
                if (G_clock_source == INT ||
                    (G_clock_source == EXT && MIDICLOCK_PASSTHROUGH == TRUE)) {
                    MIDI_send(MIDI_CLOCK, MIDICLOCK_CLOCK, 0, 0);
                }
            }
        }

        cyg_scheduler_lock();
        driveSequencer();
        cyg_scheduler_unlock();
    }

    return NULL;
}

static void start_sequencer_thread(void) {
    sequencer_running = 1;
    pthread_create(&sequencer_pthread, NULL, sequencer_thread_func, NULL);
}

/* ============================================================ */
/* VIEWER_show_MIR — replaces firmware's hardware version        */
/* Patch 05 suppresses the original; JS reads MIR from heap.     */
/* ============================================================ */

extern unsigned char MIR[2][17][5];
extern unsigned char G_master_blinker;

void VIEWER_show_MIR(void) {
    /* No-op — JavaScript reads MIR directly from WASM heap via get_mir_ptr() */
}

/* ============================================================ */
/* State save/load (PersistentV2 format)                        */
/* ============================================================ */

void save_state(const char *filepath) {
    FILE *f = fopen(filepath, "wb");
    if (!f) {
        fprintf(stderr, "save_state: cannot write '%s'\n", filepath);
        return;
    }

    extern void PersPageExport(const Pagestruct*, card8*, size_t);
    extern void PersGridExport(card8*, size_t);

    card8 gridBuf[sizeof(GridPersistentV2)];
    memset(gridBuf, 0, sizeof(gridBuf));
    PersGridExport(gridBuf, sizeof(GridPersistentV2));
    fwrite("GRID", 1, 4, f);
    unsigned sz = sizeof(GridPersistentV2);
    fwrite(&sz, 4, 1, f);
    fwrite(gridBuf, sz, 1, f);

    unsigned int p;
    for (p = 0; p < MAX_NROF_PAGES; p++) {
        card8 pageBuf[sizeof(PagePersistentV2)];
        memset(pageBuf, 0, sizeof(pageBuf));
        PersPageExport(&Page_repository[p], pageBuf, sizeof(PagePersistentV2));
        fwrite("PAGE", 1, 4, f);
        sz = sizeof(PagePersistentV2);
        fwrite(&sz, 4, 1, f);
        fwrite(pageBuf, sz, 1, f);
    }

    fclose(f);
    fprintf(stderr, "save_state: saved %u pages + grid to '%s'\n", MAX_NROF_PAGES, filepath);
}

static void load_state(const char *filepath) {
    FILE *f = fopen(filepath, "rb");
    if (!f) return;

    extern void PersPageImport(const card8*, size_t, Pagestruct*);
    extern void PersGridImport(const card8*, size_t);

    char tag[4];
    unsigned sz;
    int pages_loaded = 0, grid_loaded = 0;

    while (fread(tag, 1, 4, f) == 4 && fread(&sz, 4, 1, f) == 1) {
        /* Static, not stack — the 64 KB buffer would consume the entire
         * default 64 KB WASM stack, overflowing on the first PersGridImport
         * / PersPageImport call chain. Safe because load_state() always
         * runs under cyg_scheduler_lock() (no reentrancy). */
        static card8 buf[65536];
        if (sz > sizeof(buf)) break;
        if (fread(buf, 1, sz, f) != sz) break;

        if (memcmp(tag, "GRID", 4) == 0) {
            PersGridImport(buf, sz);
            grid_loaded = 1;
        } else if (memcmp(tag, "PAGE", 4) == 0) {
            PagePersistentV2 *pp = (PagePersistentV2 *)buf;
            if (pp->pageNdx < MAX_NROF_PAGES) {
                PersPageImport(buf, sz, &Page_repository[pp->pageNdx]);
                pages_loaded++;
            }
        }
    }

    extern void Page_repository_assign_Steps(void);
    extern void Page_repository_assign_Tracks(void);
    Page_repository_assign_Steps();
    Page_repository_assign_Tracks();

    fclose(f);
    fprintf(stderr, "load_state: loaded %d pages, grid=%d\n", pages_loaded, grid_loaded);
}

/* ============================================================ */
/* Key press handler — mirrors osc_server.c handle_key_press    */
/* ============================================================ */

extern unsigned int G_pressed_keys[];

#define OSC_KEY_ZOOM_GRID  218
#define OSC_ZOOM_GRID      2
#define OSC_BIRDSEYE       2
#define OSC_INTERACTIVE    1

static void handle_key_press(int keyNdx, int press) {
    if (press) {
        G_pressed_keys[keyNdx] = keyNdx;
        G_key_pressed = 1;

        if (keyNdx == OSC_KEY_ZOOM_GRID && G_zoom_level == OSC_ZOOM_GRID) {
            MODE_OBJECT_SELECTION = OSC_BIRDSEYE;
        }

        executeKey(keyNdx);

        /* GRID+PGM save */
        if (keyNdx == 242 && G_zoom_level == OSC_ZOOM_GRID
            && MODE_OBJECT_SELECTION == OSC_BIRDSEYE && G_run_bit == 0) {
            save_state("/persistent/octopus_state.bin");
            g_state_saved = 1;
        }
    } else {
        G_pressed_keys[keyNdx] = 0;

        if (keyNdx == OSC_KEY_ZOOM_GRID && MODE_OBJECT_SELECTION == OSC_BIRDSEYE) {
            MODE_OBJECT_SELECTION = OSC_INTERACTIVE;
        }

        int any_pressed = 0, i;
        for (i = 0; i < 261; i++) {
            if (G_pressed_keys[i]) { any_pressed = 1; break; }
        }
        if (!any_pressed) {
            G_key_pressed = 0;
            page_preview_step = NULL;
        }
    }
}

/* ============================================================ */
/* Exported API — called from JavaScript                        */
/* ============================================================ */

/* Blink frame counter for 60Hz refresh */
static int blink_frame = 0;
#define BLINK_FRAMES 10

int EMSCRIPTEN_KEEPALIVE engine_init(void) {
    /* Flash init */
    flash_init(diag_printf);

    /* Initialize mailboxes and mutexes */
    init_mailboxes();
    init_muxes();

    /* Initialize sem_readKeys before init_alarms */
    cyg_semaphore_init(&sem_readKeys, 0);

    /* Create all alarms */
    init_alarms();

    /* Seed the randomizer */
    unsigned int pvalue = 0;
    HAL_CLOCK_READ(&pvalue);
    srand(pvalue);

    /* Initialize MIDI (ring buffer) */
    midi_init(24);

    /* Initialize all memory, repositories, defaults */
    fprintf(stderr, "engine_init: calling Octopus_memory_init()...\n");
    Octopus_memory_init();
    fprintf(stderr, "engine_init: Octopus_memory_init() completed\n");

    /* Widen double-click window for mouse input (original hardware used
     * physical buttons; mice need a more forgiving timing window).
     * Defaults: RESOLUTION=12, SENSITIVITY=5 → ~125-245ms window.
     * Override: RESOLUTION=24, SENSITIVITY=3 → ~85-490ms window. */
    DOUBLE_CLICK_ALARM_RESOLUTION = 24;
    DOUBLE_CLICK_ALARM_SENSITIVITY = 3;

    /* Try to auto-load saved state */
    load_state("/persistent/octopus_state.bin");

    /* Set clock to internal */
    G_clock_source = INT;

    /* Update timer refill (tempo) */
    G_TIMER_REFILL_update();

    fprintf(stderr, "engine_init: ready (tempo=%d BPM)\n", G_master_tempo);

    /* Populate the initial display so LEDs are lit on page load.
     * The firmware's main.c calls this after init, but main_wasm.c
     * replaces main.c. Without it the MIR stays empty until the user
     * interacts (e.g. pressing ESC). */
    Page_requestRefresh();

    /* Start the sequencer thread (G_run_bit stays 0 until the user
     * presses PLAY — don't auto-start playback on page load). */
    start_sequencer_thread();

    return 0;
}

void EMSCRIPTEN_KEEPALIVE wasm_key_press(int keyNdx, int press) {
    cyg_scheduler_lock();
    handle_key_press(keyNdx, press);
    cyg_scheduler_unlock();
}

void EMSCRIPTEN_KEEPALIVE wasm_rotary(int rotNdx, int dir) {
    cyg_scheduler_lock();
    executeRot((rotNdx << 2) | dir);
    cyg_scheduler_unlock();
}

void EMSCRIPTEN_KEEPALIVE wasm_transport(int running) {
    cyg_scheduler_lock();
    if (running) {
        sequencer_START();
    } else {
        sequencer_STOP(true);
    }
    cyg_scheduler_unlock();
}

void EMSCRIPTEN_KEEPALIVE wasm_set_tempo(int bpm) {
    if (bpm >= 10 && bpm <= 199) {
        cyg_scheduler_lock();
        G_master_tempo = bpm;
        G_TIMER_REFILL_update();
        cyg_scheduler_unlock();
    }
}

void EMSCRIPTEN_KEEPALIVE wasm_pause(void) {
    cyg_scheduler_lock();
    if (G_run_bit) sequencer_HALT();
    else sequencer_UNHALT();
    cyg_scheduler_unlock();
}

/* MIR access — returns pointer into WASM linear memory */
unsigned char* EMSCRIPTEN_KEEPALIVE get_mir_ptr(void) {
    return &MIR[0][0][0];
}

/* Processed MIR buffer with blink applied (170 bytes) */
static unsigned char processed_mir[170];

unsigned char* EMSCRIPTEN_KEEPALIVE get_processed_mir_ptr(void) {
    memcpy(processed_mir, MIR, sizeof(MIR));

    if (G_master_blinker == 0) {
        int set, row;
        for (set = 0; set < 2; set++) {
            for (row = 0; row < 17; row++) {
                int base = set * 85 + row * 5;
                processed_mir[base + 1] &= ~processed_mir[base + 0];
                processed_mir[base + 2] &= ~processed_mir[base + 0];
            }
        }
    }
    return processed_mir;
}

unsigned char EMSCRIPTEN_KEEPALIVE get_run_bit(void) {
    return G_run_bit;
}

unsigned char EMSCRIPTEN_KEEPALIVE get_tempo(void) {
    return G_master_tempo;
}

unsigned char EMSCRIPTEN_KEEPALIVE get_zoom_level(void) {
    return G_zoom_level;
}

/* Page refresh — called from JS at ~60Hz via requestAnimationFrame.
 *
 * Kept for backward compatibility. New callers should use
 * wasm_check_refresh() instead, which skips the expensive
 * Page_full_refresh() when the firmware hasn't requested one.
 */
void EMSCRIPTEN_KEEPALIVE page_refresh(void) {
    blink_frame++;
    if (blink_frame % BLINK_FRAMES == 0) {
        G_master_blinker ^= 1;
    }
    Page_full_refresh();
}

/*
 * Dirty-checked refresh — toggles the blink at the same rate as
 * page_refresh() but only runs the expensive Page_full_refresh() when
 * the display actually needs updating.
 *
 * Two refresh triggers:
 *
 *  1. Semaphore dirty — the firmware called Page_requestRefresh() (key
 *     press, rotary, MIDI input, etc.). If the showPage_thread hasn't
 *     consumed it yet, we drain and refresh ourselves.
 *
 *  2. Sequencer running — CONSTANT_BLINK mode (see defs_general.h) means
 *     the timer interrupt does NOT post sem_showPage per-tick, so the
 *     semaphore stays empty during playback. The lauflicht (playhead)
 *     moves every step and needs a continuous refresh, so we force one
 *     while G_run_bit is set.
 *
 * When the sequencer is stopped AND the firmware hasn't requested a
 * refresh, this function is nearly free — just a blink tick and a
 * sem_getvalue. That's the main CPU win over the old unconditional
 * page_refresh().
 *
 * Returns 1 if a full refresh was performed, 0 otherwise.
 */
int EMSCRIPTEN_KEEPALIVE wasm_check_refresh(void) {
    blink_frame++;
    if (blink_frame % BLINK_FRAMES == 0) {
        G_master_blinker ^= 1;
    }

    int semValue = 0;
    cyg_semaphore_peek(&sem_showPage, &semValue);
    if (semValue > 0) {
        while (cyg_semaphore_trywait(&sem_showPage) == 0) {
            /* drain all pending requests */
        }
        Page_full_refresh();
        return 1;
    }

    if (G_run_bit) {
        Page_full_refresh();
        return 1;
    }

    return 0;
}

/* Save/load state to Emscripten virtual filesystem */
void EMSCRIPTEN_KEEPALIVE wasm_save_state(void) {
    save_state("/persistent/octopus_state.bin");
    EM_ASM(
        if (typeof FS !== 'undefined' && FS.syncfs) {
            FS.syncfs(false, function(err) {
                if (err) console.error('IDBFS sync failed:', err);
            });
        }
    );
}

void EMSCRIPTEN_KEEPALIVE wasm_load_state(void) {
    /* Hold the scheduler lock for the entire load so the sequencer
     * pthread can't read Page/Track/Step repositories mid-overwrite. */
    cyg_scheduler_lock();
    load_state("/persistent/octopus_state.bin");

    /* Post-load validation. PersistentV2_GridImport is the only
     * importer that doesn't bounds-check GRID_CURSOR (every other
     * index is guarded with `if (pageId < MAX_NROF_PAGES)`). An
     * out-of-range GRID_CURSOR makes Page_repository[GRID_CURSOR] an
     * OOB access in VIEWER_fill_MIR / executeKey → hard WASM trap.
     * A zero tempo causes integer div-by-zero in G_TIMER_REFILL_update. */
    if (GRID_CURSOR >= MAX_NROF_PAGES) {
        GRID_CURSOR = 0;
    }
    if (G_master_tempo < MIN_TEMPO || G_master_tempo > MAX_TEMPO) {
        G_master_tempo = 120;
    }

    G_TIMER_REFILL_update();
    Page_requestRefresh();
    cyg_scheduler_unlock();
}

/* Returns 1 if the firmware's internal save (GRID+PGM) wrote to MEMFS
 * since the last call, then resets the flag. JS uses this to trigger a
 * browser download of the .bin after Octopus-panel saves. */
int EMSCRIPTEN_KEEPALIVE wasm_consume_state_saved(void) {
    int saved = g_state_saved;
    g_state_saved = 0;
    return saved;
}

/* Sequencer running state for JS cleanup */
void EMSCRIPTEN_KEEPALIVE wasm_shutdown(void) {
    sequencer_running = 0;
    sequencer_STOP(true);
}

long EMSCRIPTEN_KEEPALIVE wasm_get_tick_ns(void) {
    return g_tick_ns;
}

int EMSCRIPTEN_KEEPALIVE wasm_get_sequencer_running(void) {
    return sequencer_running;
}

int EMSCRIPTEN_KEEPALIVE wasm_get_tick_count(void) {
    return g_seq_tick_count;
}

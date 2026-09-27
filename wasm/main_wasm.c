/*
 * main_wasm.c — WASM entry point for the Octopus/Nemo engine (OctOBX).
 *
 * Replaces main_linux.c for the Emscripten build. No blocking main() loop —
 * JavaScript drives initialization via engine_init() and calls exported
 * functions for key/rotary/transport input. By default the sequencer runs
 * in a pthread. Under OCT_AWP the engine instead lives on the single audio
 * thread of an AudioWorklet: no pthread exists, and the sequencer is driven
 * sample-block by sample-block via octopus_pump(), called once per 128-sample
 * quantum.
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
volatile long g_tick_ns = 0;
volatile int g_seq_tick_count = 0;

#ifndef OCT_AWP
static pthread_t sequencer_pthread;

/* Late-recovery log aggregation (see sequencer_thread_func) */
static long late_log_pending = 0;
static long late_log_last_ms = 0;
#endif

/* Set to 1 when the firmware's internal save (GRID+PGM) writes to MEMFS.
 * JS polls this after each key press to trigger a browser download. */
static volatile int g_state_saved = 0;

#ifndef OCT_AWP
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

        /*
         * Late recovery: if we are more than a full tick past the deadline
         * (background-tab throttling stalls this worker for whole seconds),
         * do NOT replay the missed ticks back-to-back — that floods the MIDI
         * ring with clock bursts and machine-guns the sequencer. Skip the
         * missed deadlines instead: advance `next` by whole ticks until it
         * is back in the future, then continue the loop, which sleeps until
         * the re-anchored deadline. Musical time jumps forward; phase is
         * preserved relative to the new now.
         */
        if (delta_ns < -add_ns) {
            long skipped = 0;
            while (delta_ns < 0) {
                next.tv_sec  += (time_t)(add_ns / 1000000000L);
                next.tv_nsec += add_ns % 1000000000L;
                if (next.tv_nsec >= 1000000000L) {
                    next.tv_sec++;
                    next.tv_nsec -= 1000000000L;
                }
                delta_ns += add_ns;
                skipped++;
            }
            /*
             * Rate-limited: on Windows, Chrome rounds Atomics.wait (the
             * backing of nanosleep) to the ~15.6ms OS timer grid, so a
             * 10.4ms tick deadline is missed by >= 1 tick ROUTINELY. The
             * original per-occurrence fprintf flooded console.error from
             * this worker and pinned a full core. Log the first stall
             * immediately, then aggregate — at most one line per 10 s.
             */
            late_log_pending += skipped;
            long now_ms = now.tv_sec * 1000L + now.tv_nsec / 1000000L;
            if (late_log_last_ms == 0 || now_ms - late_log_last_ms >= 10000) {
                fprintf(stderr, "sequencer: late tick(s) skipped: %ld\n", late_log_pending);
                late_log_pending = 0;
                late_log_last_ms = now_ms;
            }
            continue;   /* loop re-reads g_tick_ns; sleeps until new deadline */
        }

        if (delta_ns > 1000000) {
            struct timespec rel;
            rel.tv_sec = delta_ns / 1000000000L;
            rel.tv_nsec = delta_ns % 1000000000L;
            nanosleep(&rel, NULL);
        }
        /* No busy-wait in WASM — burns CPU without improving precision */

        g_seq_tick_count++;

        /* Send MIDI clock BEFORE acquiring the scheduler lock.
         *
         * Gated on G_run_bit: without the gate the internal clock generator
         * streams 0xF8 at 48/sec while the transport is STOPPED (the thread
         * ticks at 48 PPQN regardless). That floods the synth SAB ring —
         * which has no consumer until the AudioWorklet boots on first PLAY —
         * producing the "Synth MIDI ring (AWP) dropped" spam, and would send
         * a 48Hz clock stream to a selected hardware MIDI output while idle.
         * Per MIDI spec, clock only streams between Start and Stop. */
        if (G_run_bit) {
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
#endif /* !OCT_AWP */

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

    /* Post-load validation — SAME guards wasm_load_state() applies on the
     * manual LOAD path. engine_init()'s auto-load used to skip them, so a
     * corrupt save (bad GRID_CURSOR / zero tempo) bricked the boot: an OOB
     * GRID_CURSOR traps (or wedges) inside VIEWER_fill_MIR / executeKey and
     * a zero tempo divides by zero in G_TIMER_REFILL_update — either way
     * the page hangs on reload with nothing in the console. Validate here
     * so BOTH load paths are safe. */
    if (GRID_CURSOR >= MAX_NROF_PAGES) {
        GRID_CURSOR = 0;
    }
    if (G_master_tempo < MIN_TEMPO || G_master_tempo > MAX_TEMPO) {
        G_master_tempo = 120;
    }

    fclose(f);
    fprintf(stderr, "load_state: loaded %d pages, grid=%d\n", pages_loaded, grid_loaded);
}

/* ============================================================ */
/* Key press handler — mirrors osc_server.c handle_key_press    */
/* ============================================================ */

extern unsigned int G_pressed_keys[];

/* MUST match the firmware's G_pressed_keys[] array dimension.
 * The firmware submodule is not compiled here (single-TU include pulls only
 * declarations), so the literal cannot be re-derived — keep in sync by hand. */
#define G_KEY_COUNT 261

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
        for (i = 0; i < G_KEY_COUNT; i++) {
            if (G_pressed_keys[i]) { any_pressed = 1; break; }
        }
        if (!any_pressed) {
            G_key_pressed = 0;
            page_preview_step = NULL;
        }
    }
}

#ifdef OCT_AWP
/* ============================================================ */
/* AudioWorklet pump mode (OCT_AWP)                             */
/*                                                              */
/* No sequencer pthread: the engine runs on the single audio    */
/* thread inside the AudioWorklet, and the worklet's process()  */
/* loop calls octopus_pump(sample_delta) once per audio         */
/* quantum. The pump advances the cooperative eCos clock, runs  */
/* due sequencer ticks, and refreshes the shared-memory UI      */
/* snapshot (processed_mir + status block) for the JS main      */
/* thread, which never calls into the engine directly.         */
/* ============================================================ */

static double g_sample_rate = 48000.0;
static double g_tick_acc = 0.0;       /* fractional tick carry, in ms */
static double g_refresh_acc = 0.0;    /* UI refresh accumulator, in ms */
static int engine_ready = 0;

/* Status block (shared-memory readable by the JS main thread).
 * Fixed layout: 7 int32 followed by one double at byte offset 32. */
typedef struct {
    int32_t engine_ready;
    int32_t run_bit;
    int32_t tempo;
    int32_t zoom_level;
    int32_t tick_count;
    int32_t midi_dropped;
    int32_t midi_synth_dropped;
    double  tick_ns;                  /* offset 32 */
} oct_status_t;
static oct_status_t g_oct_status;

/* Plain C dropped-counter accessors owned by midi_wasm.c */
extern unsigned int midi_get_dropped_count(void);
extern unsigned int midi_get_synth_dropped_count(void);

/* Defined further down (next to the processed_mir buffer / the
 * dirty-checked refresh export). */
static void oct_update_processed_mir(void);
int wasm_check_refresh(void);

static void oct_status_update(void) {
    g_oct_status.engine_ready = engine_ready;
    g_oct_status.run_bit = G_run_bit;
    g_oct_status.tempo = G_master_tempo;
    g_oct_status.zoom_level = G_zoom_level;
    g_oct_status.tick_count = g_seq_tick_count;
    g_oct_status.midi_dropped = (int32_t)midi_get_dropped_count();
    g_oct_status.midi_synth_dropped = (int32_t)midi_get_synth_dropped_count();
    g_oct_status.tick_ns = (double)g_tick_ns;
}

int32_t* EMSCRIPTEN_KEEPALIVE get_status_ptr(void) {
    return (int32_t*)&g_oct_status;
}

void EMSCRIPTEN_KEEPALIVE octopus_set_sample_rate(double rate) {
    if (rate < 8000.0) rate = 8000.0;
    if (rate > 384000.0) rate = 384000.0;
    g_sample_rate = rate;
}

void EMSCRIPTEN_KEEPALIVE octopus_pump(int sample_delta) {
    static long late_log_pending = 0;
    static long late_log_last_ms = 0;
    double ms;
    double period_ms;
    int fired;

    if (!engine_ready) return;

    if (sample_delta < 1) sample_delta = 1;
    if (sample_delta > 100000) sample_delta = 100000;
    ms = (double)sample_delta * 1000.0 / g_sample_rate;

    /* Advance the cooperative eCos clock — fires due alarms */
    hal_advance_clock(ms);

    /* Sequencer ticks */
    g_tick_acc += ms;
    period_ms = (double)g_tick_ns / 1e6;

    fired = 0;
    if (period_ms > 0.0) {
        while (g_tick_acc >= period_ms && fired < 8) {
            g_tick_acc -= period_ms;
            fired++;

            g_seq_tick_count++;

            /* Send MIDI clock BEFORE acquiring the scheduler lock.
             *
             * Gated on G_run_bit: without the gate the internal clock generator
             * streams 0xF8 at 48/sec while the transport is STOPPED (the tick
             * source ticks at 48 PPQN regardless). That floods the synth SAB ring —
             * which has no consumer until the AudioWorklet boots on first PLAY —
             * producing the "Synth MIDI ring (AWP) dropped" spam, and would send
             * a 48Hz clock stream to a selected hardware MIDI output while idle.
             * Per MIDI spec, clock only streams between Start and Stop. */
            if (G_run_bit) {
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
    }

    /* Guard tripped with backlog remaining — drop the backlog (no
     * machine-gun catch-up ticks through the MIDI ring), reset the
     * carry, and say so rate-limited (one line per 10 s max). */
    if (fired >= 8 && g_tick_acc >= period_ms) {
        long skipped = 0;
        struct timespec now;
        long now_ms;

        while (g_tick_acc >= period_ms) {
            g_tick_acc -= period_ms;
            skipped++;
        }
        g_tick_acc = 0.0;

        late_log_pending += skipped;
        clock_gettime(CLOCK_MONOTONIC, &now);
        now_ms = now.tv_sec * 1000L + now.tv_nsec / 1000000L;
        if (late_log_last_ms == 0 || now_ms - late_log_last_ms >= 10000) {
            fprintf(stderr, "sequencer: late tick(s) skipped: %ld\n", late_log_pending);
            late_log_pending = 0;
            late_log_last_ms = now_ms;
        }
    }

    /* UI refresh at ~60 Hz */
    g_refresh_acc += ms;
    if (g_refresh_acc >= 15.0) {
        g_refresh_acc = 0.0;
        wasm_check_refresh();
        oct_update_processed_mir();
        oct_status_update();
    }
}
#endif /* OCT_AWP */

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

#ifdef OCT_AWP
    /* AWP mode: no sequencer pthread — the AudioWorklet drives the engine
     * via octopus_pump() once per 128-sample quantum. sequencer_running
     * doubles as "engine initialized" for wasm_get_sequencer_running().
     * (The load_state() above is expected to find nothing: the worklet's
     * MEMFS is empty at boot; the JS layer writes the state bytes and
     * calls wasm_load_state() right after engine_init.) */
    sequencer_running = 1;
    engine_ready = 1;
    g_tick_acc = 0.0;
    g_refresh_acc = 0.0;
    oct_status_update();
#else
    /* Start the sequencer thread (G_run_bit stays 0 until the user
     * presses PLAY — don't auto-start playback on page load). */
    start_sequencer_thread();
#endif

    return 0;
}

void EMSCRIPTEN_KEEPALIVE wasm_key_press(int keyNdx, int press) {
    cyg_scheduler_lock();
    handle_key_press(keyNdx, press);
    cyg_scheduler_unlock();
#ifdef OCT_AWP
    oct_status_update();
#endif
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
#ifdef OCT_AWP
    oct_status_update();
#endif
}

void EMSCRIPTEN_KEEPALIVE wasm_set_tempo(int bpm) {
    if (bpm >= 10 && bpm <= 199) {
        cyg_scheduler_lock();
        G_master_tempo = bpm;
        G_TIMER_REFILL_update();
        cyg_scheduler_unlock();
    }
#ifdef OCT_AWP
    oct_status_update();
#endif
}

void EMSCRIPTEN_KEEPALIVE wasm_pause(void) {
    cyg_scheduler_lock();
    if (G_run_bit) sequencer_HALT();
    else sequencer_UNHALT();
    cyg_scheduler_unlock();
#ifdef OCT_AWP
    oct_status_update();
#endif
}

/* MIR access — returns pointer into WASM linear memory */
unsigned char* EMSCRIPTEN_KEEPALIVE get_mir_ptr(void) {
    return &MIR[0][0][0];
}

/* Processed MIR buffer with blink applied (170 bytes) */
static unsigned char processed_mir[170];

/* Refresh the processed MIR snapshot (memcpy + blink mask). In AWP mode
 * the pump keeps this fresh so the JS main thread can read the static
 * buffer directly from shared memory. */
static void oct_update_processed_mir(void) {
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
}

unsigned char* EMSCRIPTEN_KEEPALIVE get_processed_mir_ptr(void) {
    oct_update_processed_mir();
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

/* Test/driver hook mirroring the native launcher's /zoom OSC command: set the
 * zoom level directly. Physical zoom keys are play-mode dependent (PAGE only
 * switches in GRID_EDIT, MAP toggles MIDI-CC routing in GRID_MIX, in STEP zoom
 * only GRID/PAGE/TRK act), so a deterministic setter is needed for the
 * zoom-indicator behavior tests (tools/verify-octopus-wasm.mjs). */
void EMSCRIPTEN_KEEPALIVE wasm_set_zoom(int level) {
    cyg_scheduler_lock();
    G_zoom_level = level;
    Page_requestRefresh();
    cyg_scheduler_unlock();
#ifdef OCT_AWP
    oct_status_update();
#endif
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
    /* Hold the scheduler lock for the entire load so no concurrent
     * reader (the sequencer pthread in non-AWP builds) can read
     * Page/Track/Step repositories mid-overwrite. */
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
#ifdef OCT_AWP
    oct_status_update();
#endif
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
#ifdef OCT_AWP
    sequencer_STOP(true);
    sequencer_running = 0;
#else
    sequencer_running = 0;
    sequencer_STOP(true);
#endif
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

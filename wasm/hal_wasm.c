/*
 * hal_wasm.c — WASM/Emscripten implementation of the eCos compatibility shim.
 *
 * Two compile modes:
 *
 *  - Default (pthread build): backs the cyg_* APIs with pthreads
 *    (Emscripten pthreads → Web Workers), ring-buffer mailboxes with
 *    mutex+condvar, and nanosleep-based alarm watcher threads.
 *
 *  - OCT_AWP (AudioWorklet build): the engine runs single-threaded on the
 *    audio thread, where blocking and thread creation are illegal. Threads
 *    are recorded but never spawned; mutexes/semaphores become recursion
 *    counters / plain counters; mailboxes keep their ring storage but never
 *    wait; alarms fire cooperatively from a virtual clock that main_wasm.c
 *    advances once per audio quantum via hal_advance_clock().
 */

#include "hal_linux.h"

int hal_debug_enabled = 0;
unsigned long long hal_clock_counter = 0;
unsigned int hal_cpu_load_timer_start = 0;

#define HAL_FLASH_SIZE  (1024 * 1024)
unsigned char *hal_flash_base = NULL;

#define HAL_SCRATCH_SIZE 4096
static unsigned char hal_scratch[HAL_SCRATCH_SIZE];
static unsigned long long hal_last_oob_warn_ms = 0;

#ifdef OCT_AWP
/*
 * OCT_AWP virtual clock: wall-clock time and sleeps do not exist on the
 * audio thread. The engine pump (main_wasm.c) advances this clock by one
 * audio quantum per hal_advance_clock() call; cyg_current_time() and the
 * alarm deadlines all live on this timeline. Declared up here because the
 * alarm API below reads and writes it.
 */
static double hal_virtual_now_ms = 0;
#endif

/* ============================================================ */
/* Flash API — backed by in-memory buffer                       */
/*                                                              */
/* OOB policy: if any part of [offset, offset+len) falls        */
/* outside the flash buffer, the WHOLE operation is diverted    */
/* to a scratch page — reads see deterministic zeros, erases/   */
/* programs are discarded. This keeps behavior total and never  */
/* corrupts valid flash (a partial-tail clamp would silently    */
/* change read semantics). Real firmware accesses are always    */
/* well-formed, so this is purely defensive.                    */
/* ============================================================ */

static void hal_flash_ensure_init(void) {
    if (hal_flash_base == NULL) {
        hal_flash_base = (unsigned char *)calloc(1, HAL_FLASH_SIZE);
        if (hal_flash_base == NULL) {
            fprintf(stderr, "hal_wasm: FATAL: cannot allocate flash buffer\n");
            abort();
        }
    }
}

/* Map a firmware flash pointer to an offset into hal_flash_base. */
static unsigned long long hal_flash_offset(void *firmware_ptr) {
    unsigned long long fw_addr = (unsigned long long)(unsigned char *)firmware_ptr;
    unsigned long long base_addr = 0x01900000ULL;
    unsigned long long offset;

    if (fw_addr >= base_addr) {
        offset = fw_addr - base_addr;
    } else {
        offset = fw_addr;
    }
    return offset;
}

/* Rate-limited OOB warning: at most once per second. */
static void hal_flash_oob_warn(const char *op, unsigned long long offset, unsigned int len) {
    unsigned long long now = (unsigned long long)emscripten_get_now();

    if (hal_last_oob_warn_ms == 0 || now - hal_last_oob_warn_ms >= 1000) {
        fprintf(stderr,
                "hal_wasm: WARNING: flash %s out of bounds diverted to scratch: "
                "offset=%llu len=%u\n",
                op, offset, len);
        hal_last_oob_warn_ms = now;
    }
}

/*
 * Classify a flash access range.
 *
 * Returns 1 (diverted) when ANY part of the range is out of bounds:
 * zeroes the scratch region covering min(len, HAL_SCRATCH_SIZE) so
 * diverted reads are deterministic, and sets *page to the scratch
 * buffer. Returns 0 when fully in bounds: *page = base + offset.
 * *len is never modified — diverted ops use the original length.
 */
static int hal_flash_range(unsigned long long offset, unsigned int len, unsigned char **page) {
    unsigned int zero_len;

    hal_flash_ensure_init();

    if (offset >= (unsigned long long)HAL_FLASH_SIZE ||
        offset + (unsigned long long)len > (unsigned long long)HAL_FLASH_SIZE) {
        zero_len = len;
        if (zero_len > HAL_SCRATCH_SIZE)
            zero_len = HAL_SCRATCH_SIZE;
        memset(hal_scratch, 0, zero_len);
        *page = hal_scratch;
        return 1;
    }

    *page = hal_flash_base + offset;
    return 0;
}

#define HAL_ERR_CLEAR(err_addr) do { if (err_addr) *(unsigned int *)(err_addr) = 0; } while(0)

int flash_read(void *src, void *dest, unsigned int len, void **err_addr) {
    unsigned char *page;
    unsigned long long offset = hal_flash_offset(src);

    if (hal_flash_range(offset, len, &page))
        hal_flash_oob_warn("read", offset, len);

    memcpy(dest, page, len);
    HAL_ERR_CLEAR(err_addr);
    return 0;
}

int flash_erase(void *dest, unsigned int len, void **err_addr) {
    unsigned char *page;
    unsigned long long offset = hal_flash_offset(dest);

    if (hal_flash_range(offset, len, &page)) {
        hal_flash_oob_warn("erase", offset, len);
    } else {
        memset(page, 0xFF, len);
    }

    HAL_ERR_CLEAR(err_addr);
    return 0;
}

int flash_program(void *dest, void *src, unsigned int len, void **err_addr) {
    unsigned char *page;
    unsigned long long offset = hal_flash_offset(dest);

    if (hal_flash_range(offset, len, &page)) {
        hal_flash_oob_warn("program", offset, len);
    } else {
        memcpy(page, src, len);
    }

    HAL_ERR_CLEAR(err_addr);
    return 0;
}

/* ============================================================ */
/* Thread API                                                   */
/*                                                              */
/* OCT_AWP: the audio thread may not create threads or block.   */
/* Descriptors (entry/data/name) are recorded so engine init    */
/* bookkeeping still works, but nothing is ever spawned — the   */
/* work those threads did is driven cooperatively from the      */
/* pump in main_wasm.c / hal_advance_clock() instead.           */
/*                                                              */
/* Default: backed by pthreads (Web Workers).                   */
/* ============================================================ */

#ifdef OCT_AWP

void cyg_thread_create(
    unsigned int        priority,
    void              (*entry)(cyg_addrword_t),
    cyg_addrword_t      data,
    const char         *name,
    void               *stack_base,
    unsigned int        stack_size,
    cyg_handle_t       *handle,
    cyg_thread         *thread_obj
) {
    (void)priority;
    (void)stack_base;
    (void)stack_size;

    /* Record the descriptor exactly as the pthread build does, but
     * never spawn — thread creation is illegal on the audio thread. */
    thread_obj->entry = entry;
    thread_obj->data = data;
    thread_obj->priority = (int)priority;
    thread_obj->started = 1;
    strncpy(thread_obj->name, name ? name : "unnamed", sizeof(thread_obj->name) - 1);
    thread_obj->name[sizeof(thread_obj->name) - 1] = '\0';

    *handle = (cyg_handle_t)(unsigned long long)thread_obj;
}

void cyg_thread_resume(cyg_handle_t handle) {
    cyg_thread *thread_obj = (cyg_thread *)(unsigned long long)handle;

    /* Mark started only — spawning here would violate the
     * AudioWorklet contract. */
    thread_obj->started = 1;
}

void cyg_thread_delay(unsigned int ticks) {
    (void)ticks;  /* sleeping would block the audio thread — no-op */
}

#else /* pthread-backed legacy path */

typedef struct {
    void (*entry)(cyg_addrword_t);
    cyg_addrword_t data;
} hal_thread_arg_t;

static void *hal_thread_trampoline(void *arg) {
    hal_thread_arg_t *targ = (hal_thread_arg_t *)arg;
    void (*entry)(cyg_addrword_t) = targ->entry;
    cyg_addrword_t data = targ->data;
    free(targ);
    entry(data);
    return NULL;
}

void cyg_thread_create(
    unsigned int        priority,
    void              (*entry)(cyg_addrword_t),
    cyg_addrword_t      data,
    const char         *name,
    void               *stack_base,
    unsigned int        stack_size,
    cyg_handle_t       *handle,
    cyg_thread         *thread_obj
) {
    (void)priority;
    (void)stack_base;
    (void)stack_size;

    thread_obj->entry = entry;
    thread_obj->data = data;
    thread_obj->priority = (int)priority;
    thread_obj->started = 1;
    strncpy(thread_obj->name, name ? name : "unnamed", sizeof(thread_obj->name) - 1);
    thread_obj->name[sizeof(thread_obj->name) - 1] = '\0';

    *handle = (cyg_handle_t)(unsigned long long)thread_obj;
}

void cyg_thread_resume(cyg_handle_t handle) {
    cyg_thread *thread_obj = (cyg_thread *)(unsigned long long)handle;
    if (!thread_obj->started) return;

    hal_thread_arg_t *targ = (hal_thread_arg_t *)malloc(sizeof(hal_thread_arg_t));
    targ->entry = thread_obj->entry;
    targ->data = thread_obj->data;

    if (pthread_create(&thread_obj->tid, NULL, hal_thread_trampoline, targ) != 0) {
        fprintf(stderr, "hal_wasm: FATAL: pthread_create failed for '%s'\n", thread_obj->name);
        abort();
    }
}

void cyg_thread_delay(unsigned int ticks) {
    usleep(ticks * 10000);
}

#endif /* OCT_AWP */

cyg_bool cyg_thread_get_next(cyg_handle_t *thread, unsigned short *id) {
    (void)thread;
    (void)id;
    return 0;
}

cyg_bool cyg_thread_get_info(cyg_handle_t thread, unsigned short id, cyg_thread_info *info) {
    (void)thread;
    (void)id;
    (void)info;
    return 0;
}

/* ============================================================ */
/* Mailbox API — ring buffer                                    */
/*                                                              */
/* OCT_AWP: same ring storage, but no mutex/condvar (no other   */
/* thread exists to synchronize with) and cyg_mbox_get() never  */
/* waits — the firmware consumer threads are never started in   */
/* this build, so an empty mailbox simply yields NULL.          */
/*                                                              */
/* Default: ring buffer + mutex + condvar.                      */
/* ============================================================ */

#define HAL_MAX_MBOXS 16
static cyg_mbox *hal_mbox_registry[HAL_MAX_MBOXS];
static int hal_mbox_count = 0;

void cyg_mbox_create(cyg_handle_t *handle, cyg_mbox *mbox) {
#ifndef OCT_AWP
    pthread_mutex_init(&mbox->mutex, NULL);
    pthread_cond_init(&mbox->cond, NULL);
#endif
    mbox->head = 0;
    mbox->tail = 0;
    mbox->count = 0;
    memset(mbox->items, 0, sizeof(mbox->items));

    int idx = hal_mbox_count++;
    if (idx >= HAL_MAX_MBOXS) {
        fprintf(stderr, "hal_wasm: FATAL: too many mailboxes\n");
        abort();
    }
    hal_mbox_registry[idx] = mbox;
    *handle = (cyg_handle_t)idx;
}

static cyg_mbox *hal_mbox_lookup(cyg_handle_t handle) {
    if (handle >= (cyg_handle_t)hal_mbox_count) return NULL;
    return hal_mbox_registry[handle];
}

void *cyg_mbox_get(cyg_handle_t handle) {
    cyg_mbox *mbox = hal_mbox_lookup(handle);
    void *item;

    if (!mbox) return NULL;

#ifdef OCT_AWP
    /* Non-blocking: an empty mailbox returns NULL immediately. The
     * firmware threads that would block here are never started in
     * this build — waiting on the audio thread is not an option. */
    if (mbox->count == 0) return NULL;
    item = mbox->items[mbox->head];
    mbox->head = (mbox->head + 1) % 64;
    mbox->count--;
    return item;
#else
    pthread_mutex_lock(&mbox->mutex);
    while (mbox->count == 0) {
        pthread_cond_wait(&mbox->cond, &mbox->mutex);
    }
    item = mbox->items[mbox->head];
    mbox->head = (mbox->head + 1) % 64;
    mbox->count--;
    pthread_mutex_unlock(&mbox->mutex);
    return item;
#endif
}

cyg_bool cyg_mbox_tryput(cyg_handle_t handle, void *item) {
    cyg_mbox *mbox = hal_mbox_lookup(handle);
    if (!mbox) return 0;

#ifdef OCT_AWP
    /* Unlocked ring push — single thread, nothing to signal. */
    if (mbox->count >= 64) {
        return 0;
    }
    mbox->items[mbox->tail] = item;
    mbox->tail = (mbox->tail + 1) % 64;
    mbox->count++;
    return 1;
#else
    pthread_mutex_lock(&mbox->mutex);
    if (mbox->count >= 64) {
        pthread_mutex_unlock(&mbox->mutex);
        return 0;
    }
    mbox->items[mbox->tail] = item;
    mbox->tail = (mbox->tail + 1) % 64;
    mbox->count++;
    pthread_cond_signal(&mbox->cond);
    pthread_mutex_unlock(&mbox->mutex);
    return 1;
#endif
}

int cyg_mbox_peek_item(cyg_handle_t handle) {
    cyg_mbox *mbox = hal_mbox_lookup(handle);
    if (!mbox) return 0;
    return mbox->count;
}

/* ============================================================ */
/* Mutex API                                                    */
/*                                                              */
/* OCT_AWP: cyg_mutex_t is a recursion counter (see hal_linux.h). */
/* With a single thread a lock can never contend; the depth      */
/* counter keeps nested (recursive) lock/unlock pairs balanced.  */
/*                                                              */
/* Default: pthread mutex.                                      */
/* ============================================================ */

void cyg_mutex_init(cyg_mutex_t *mutex) {
#ifdef OCT_AWP
    mutex->depth = 0;
#else
    pthread_mutex_init(mutex, NULL);
#endif
}

void cyg_mutex_lock(cyg_mutex_t *mutex) {
#ifdef OCT_AWP
    mutex->depth++;
#else
    pthread_mutex_lock(mutex);
#endif
}

void cyg_mutex_unlock(cyg_mutex_t *mutex) {
#ifdef OCT_AWP
    if (mutex->depth > 0) {
        mutex->depth--;
    }
#else
    pthread_mutex_unlock(mutex);
#endif
}

/* ============================================================ */
/* Semaphore API                                                */
/*                                                              */
/* OCT_AWP: plain int counters. post() increments; wait()       */
/* decrements only when positive and ALWAYS returns immediately */
/* — blocking (or spinning) here would stall the audio thread.  */
/* This is safe because the only firmware threads that waited   */
/* on semaphores are never started in this build.               */
/*                                                              */
/* Default: POSIX semaphores.                                   */
/* ============================================================ */

void cyg_semaphore_init(cyg_sem_t *sem, unsigned int val) {
#ifdef OCT_AWP
    sem->count = (int)val;
#else
    sem_init(sem, 0, val);
#endif
}

void cyg_semaphore_post(cyg_sem_t *sem) {
#ifdef OCT_AWP
    sem->count++;
#else
    sem_post(sem);
#endif
}

void cyg_semaphore_wait(cyg_sem_t *sem) {
#ifdef OCT_AWP
    /* NEVER blocks — see section comment above. A zero count simply
     * leaves the counter alone and returns. */
    if (sem->count > 0) {
        sem->count--;
    }
#else
    sem_wait(sem);
#endif
}

int cyg_semaphore_trywait(cyg_sem_t *sem) {
#ifdef OCT_AWP
    /* Same convention as sem_trywait(): 0 = acquired, -1 = would block. */
    if (sem->count > 0) {
        sem->count--;
        return 0;
    }
    return -1;
#else
    return sem_trywait(sem);
#endif
}

void cyg_semaphore_peek(cyg_sem_t *sem, int *count) {
#ifdef OCT_AWP
    if (count) *count = sem->count;
#else
    int val = 0;
    sem_getvalue(sem, &val);
    if (count) *count = val;
#endif
}

/* ============================================================ */
/* Alarm API                                                    */
/*                                                              */
/* OCT_AWP: cooperative alarms on the virtual clock. The        */
/* registry / create / disable keep their shape; initialize     */
/* arms deadline_ms / interval_ms and hal_advance_clock()       */
/* (see the Virtual clock section below) fires due handlers     */
/* inline on the audio thread.                                  */
/*                                                              */
/* Default: nanosleep-based watcher threads.                    */
/* ============================================================ */

#define HAL_MAX_ALARMS 16
static cyg_alarm *hal_alarm_registry[HAL_MAX_ALARMS];
static int hal_alarm_count = 0;

static cyg_handle_t hal_counter_handle = 1;

cyg_handle_t cyg_real_time_clock(void) {
    return hal_counter_handle;
}

void cyg_clock_to_counter(cyg_handle_t clock, cyg_handle_t *counter) {
    (void)clock;
    *counter = hal_counter_handle;
}

#ifndef OCT_AWP /* legacy watcher thread — not built in OCT_AWP */

static void *hal_alarm_watcher(void *arg) {
    cyg_alarm *alarm = (cyg_alarm *)arg;
    unsigned my_gen = alarm->generation;

    while (alarm->active) {
        my_gen = alarm->generation;
        long sleep_ns = alarm->interval_ns;
        if (sleep_ns <= 0) sleep_ns = 10 * 1000000L; /* fallback: 10ms */
        struct timespec ts = {
            .tv_sec  = sleep_ns / 1000000000L,
            .tv_nsec = sleep_ns % 1000000000L
        };
        nanosleep(&ts, NULL);
        if (!alarm->active || alarm->generation != my_gen) break;
        if (alarm->handler) {
            alarm->handler(alarm->handle, alarm->data);
            /* interval == 0: one-shot alarm — fire once then self-disable */
            if (alarm->interval_ns == 0) {
                alarm->active = 0;
                break;
            }
        }
    }

    /*
     * Retirement. If the generation advanced while we slept AND the alarm
     * is still enabled, a re-initialize was folded into our liveness slot
     * (watcher_alive was still set, so initialize did not spawn) — hand off
     * to a fresh watcher under the newer generation before retiring.
     * Otherwise this watcher owns the liveness slot: release it.
     */
    if (alarm->generation != my_gen && alarm->active) {
        pthread_create(&alarm->watcher_tid, NULL, hal_alarm_watcher, alarm);
        return NULL; /* successor inherited watcher_alive */
    }
    alarm->watcher_alive = 0;
    return NULL;
}

#endif /* !OCT_AWP */

void cyg_alarm_create(
    cyg_handle_t    counter,
    cyg_alarm_t    *alarm_fn,
    cyg_addrword_t  data,
    cyg_handle_t   *handle,
    cyg_alarm      *alarm_obj
) {
    (void)counter;

    alarm_obj->handler = alarm_fn;
    alarm_obj->data = data;
    alarm_obj->active = 0;
#ifndef OCT_AWP
    alarm_obj->generation = 0;
    alarm_obj->watcher_alive = 0;
#endif

    int idx = hal_alarm_count++;
    if (idx >= HAL_MAX_ALARMS) {
        fprintf(stderr, "hal_wasm: FATAL: too many alarms\n");
        abort();
    }
    hal_alarm_registry[idx] = alarm_obj;
    alarm_obj->handle = (cyg_handle_t)idx;
    *handle = (cyg_handle_t)idx;
}

void cyg_alarm_initialize(cyg_handle_t handle, cyg_tick_count_t trigger, cyg_tick_count_t interval) {
    if (handle >= (cyg_handle_t)hal_alarm_count) return;
    cyg_alarm *alarm = hal_alarm_registry[handle];
    if (!alarm) return;

    (void)trigger;

#ifdef OCT_AWP
    /* 1 eCos tick = 10 ms (matches cyg_current_time: virtual clock / 10.0).
     * The legacy watcher also ignored `trigger` and first-fired one
     * interval after initialize — preserve that schedule. */
    alarm->interval_ms = (double)interval * 10.0;
    alarm->deadline_ms = hal_virtual_now_ms + (double)(interval > 0 ? interval : 1) * 10.0;
    alarm->active = 1;
#else
    /* 1 eCos tick = 10ms (matches cyg_current_time: emscripten_get_now()/10.0) */
    alarm->interval_ns = (long)(interval * 10 * 1000000ULL);

    /*
     * Bump the generation FIRST: any live watcher from a previous arming
     * observes the mismatch on wake and retires without firing (handing
     * off to a successor if the alarm is still enabled). Spawn only when
     * no watcher holds the liveness slot — this keeps at most one live
     * watcher per alarm.
     */
    alarm->generation++;
    alarm->active = 1;
    if (!alarm->watcher_alive) {
        alarm->watcher_alive = 1;
        pthread_create(&alarm->watcher_tid, NULL, hal_alarm_watcher, alarm);
    }
#endif
}

void cyg_alarm_disable(cyg_handle_t handle) {
    if (handle >= (cyg_handle_t)hal_alarm_count) return;
    cyg_alarm *alarm = hal_alarm_registry[handle];
    if (!alarm) return;
#ifndef OCT_AWP
    /* watcher_alive is left alone: the watcher thread is still winding
     * down and will release the liveness slot (or hand off) on exit. */
#endif
    /* OCT_AWP: no watcher to wind down — deactivating is all it takes. */
    alarm->active = 0;
}

/* ============================================================ */
/* Virtual clock + alarm polling — OCT_AWP only                 */
/*                                                              */
/* main_wasm.c calls hal_advance_clock() once per audio         */
/* quantum; due alarms fire inline, here, on the audio thread.  */
/* Handlers must therefore not block.                           */
/* ============================================================ */

#ifdef OCT_AWP

/* Catch-up policy: at most this many fires per alarm per poll, and
 * if an alarm fell more than HAL_ALARM_REANCHOR_BEHIND_MS behind
 * (audio context suspended, tab backgrounded), re-anchor its
 * schedule to now instead of machine-gunning the missed fires. */
#define HAL_ALARM_MAX_FIRES_PER_POLL 16
#define HAL_ALARM_REANCHOR_BEHIND_MS 500.0

/* Fire all alarms due at the current (already advanced) virtual time. */
static void hal_poll_alarms(void) {
    int i;

    for (i = 0; i < hal_alarm_count && i < HAL_MAX_ALARMS; i++) {
        cyg_alarm *alarm = hal_alarm_registry[i];
        int fires;

        if (!alarm || !alarm->active || !alarm->handler) continue;

        /* More than HAL_ALARM_REANCHOR_BEHIND_MS in arrears (periodic
         * alarms only): skip the backlog, restart from now. */
        if (alarm->interval_ms > 0.0 &&
            hal_virtual_now_ms - alarm->deadline_ms > HAL_ALARM_REANCHOR_BEHIND_MS) {
            alarm->deadline_ms = hal_virtual_now_ms + alarm->interval_ms;
        }

        fires = 0;
        while (alarm->active && alarm->deadline_ms <= hal_virtual_now_ms) {
            alarm->handler(alarm->handle, alarm->data);
            fires++;
            if (alarm->interval_ms <= 0.0) {
                /* One-shot: fire once then self-disable (same as the
                 * legacy watcher thread). */
                alarm->active = 0;
                break;
            }
            alarm->deadline_ms += alarm->interval_ms;
            if (fires >= HAL_ALARM_MAX_FIRES_PER_POLL) {
                /* Hard cap on catch-up fires per alarm per poll; the
                 * remainder catches up over subsequent quanta. */
                break;
            }
        }
    }
}

void hal_advance_clock(double ms) {
    if (ms <= 0.0) return;          /* ignore non-progress */
    if (ms > 1000.0) ms = 1000.0;   /* clamp absurd jumps */

    hal_virtual_now_ms += ms;
    hal_poll_alarms();
}

#endif /* OCT_AWP */

/* ============================================================ */
/* Interrupt API — no-ops                                       */
/* ============================================================ */

void cyg_interrupt_create(
    cyg_vector_t    vector,
    int             priority,
    cyg_addrword_t  data,
    unsigned int  (*isr)(cyg_vector_t, cyg_addrword_t),
    void          (*dsr)(cyg_vector_t, cyg_ucount32, cyg_addrword_t),
    cyg_handle_t  *handle,
    cyg_interrupt *intr_obj
) {
    (void)vector;
    (void)priority;
    (void)data;
    (void)isr;
    (void)dsr;
    intr_obj->vector = vector;
    *handle = (cyg_handle_t)(unsigned long long)intr_obj;
}

void cyg_interrupt_attach(cyg_handle_t handle) { (void)handle; }
void cyg_interrupt_unmask(cyg_vector_t vector) { (void)vector; }
void cyg_interrupt_mask(cyg_vector_t vector) { (void)vector; }

static volatile int hal_intr_disable_count = 0;

void cyg_interrupt_enable(void) {
    if (hal_intr_disable_count > 0)
        hal_intr_disable_count--;
}

void cyg_interrupt_disable(void) {
    hal_intr_disable_count++;
}

void cyg_interrupt_acknowledge(cyg_vector_t vector) { (void)vector; }

/* ============================================================ */
/* Scheduler lock                                               */
/*                                                              */
/* OCT_AWP: plain recursion counter — a single thread never     */
/* contends; the depth keeps nested lock/unlock balanced (the   */
/* firmware relies on this lock being logically recursive).     */
/*                                                              */
/* Default: global recursive pthread mutex.                     */
/* ============================================================ */

#ifdef OCT_AWP

static int hal_scheduler_lock_depth = 0;

void cyg_scheduler_lock(void) {
    hal_scheduler_lock_depth++;
}

void cyg_scheduler_unlock(void) {
    if (hal_scheduler_lock_depth > 0) {
        hal_scheduler_lock_depth--;
    }
}

#else /* pthread-backed legacy path */

static pthread_mutex_t hal_scheduler_mutex;
static int hal_scheduler_initialized = 0;

static void hal_scheduler_init(void) {
    if (!hal_scheduler_initialized) {
        pthread_mutexattr_t attr;
        pthread_mutexattr_init(&attr);
        pthread_mutexattr_settype(&attr, PTHREAD_MUTEX_RECURSIVE);
        pthread_mutex_init(&hal_scheduler_mutex, &attr);
        pthread_mutexattr_destroy(&attr);
        hal_scheduler_initialized = 1;
    }
}

void cyg_scheduler_lock(void) {
    hal_scheduler_init();
    pthread_mutex_lock(&hal_scheduler_mutex);
}

void cyg_scheduler_unlock(void) {
    hal_scheduler_init();
    pthread_mutex_unlock(&hal_scheduler_mutex);
}

#endif /* OCT_AWP */

/* ============================================================ */
/* Time functions                                               */
/* ============================================================ */

cyg_tick_count_t cyg_current_time(void) {
#ifdef OCT_AWP
    /* Virtual clock advanced by hal_advance_clock() — 1 eCos tick = 10 ms,
     * same scale as the legacy emscripten_get_now()/10.0 mapping. */
    return (cyg_tick_count_t)(hal_virtual_now_ms / 10.0);
#else
    return (cyg_tick_count_t)(emscripten_get_now() / 10.0);
#endif
}

/*
 * hal_wasm.c — WASM/Emscripten implementation of the eCos compatibility shim.
 *
 * Backs all cyg_* APIs with pthreads (Emscripten pthreads → Web Workers),
 * ring-buffer mailboxes, and nanosleep-based alarms.
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
/* Thread API — backed by pthreads                              */
/* ============================================================ */

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
/* Mailbox API — ring buffer + mutex + condvar                  */
/* ============================================================ */

#define HAL_MAX_MBOXS 16
static cyg_mbox *hal_mbox_registry[HAL_MAX_MBOXS];
static int hal_mbox_count = 0;

void cyg_mbox_create(cyg_handle_t *handle, cyg_mbox *mbox) {
    pthread_mutex_init(&mbox->mutex, NULL);
    pthread_cond_init(&mbox->cond, NULL);
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
    if (!mbox) return NULL;

    pthread_mutex_lock(&mbox->mutex);
    while (mbox->count == 0) {
        pthread_cond_wait(&mbox->cond, &mbox->mutex);
    }
    void *item = mbox->items[mbox->head];
    mbox->head = (mbox->head + 1) % 64;
    mbox->count--;
    pthread_mutex_unlock(&mbox->mutex);
    return item;
}

cyg_bool cyg_mbox_tryput(cyg_handle_t handle, void *item) {
    cyg_mbox *mbox = hal_mbox_lookup(handle);
    if (!mbox) return 0;

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
}

int cyg_mbox_peek_item(cyg_handle_t handle) {
    cyg_mbox *mbox = hal_mbox_lookup(handle);
    if (!mbox) return 0;
    return mbox->count;
}

/* ============================================================ */
/* Mutex API                                                    */
/* ============================================================ */

void cyg_mutex_init(cyg_mutex_t *mutex) {
    pthread_mutex_init(mutex, NULL);
}

void cyg_mutex_lock(cyg_mutex_t *mutex) {
    pthread_mutex_lock(mutex);
}

void cyg_mutex_unlock(cyg_mutex_t *mutex) {
    pthread_mutex_unlock(mutex);
}

/* ============================================================ */
/* Semaphore API                                                */
/* ============================================================ */

void cyg_semaphore_init(cyg_sem_t *sem, unsigned int val) {
    sem_init(sem, 0, val);
}

void cyg_semaphore_post(cyg_sem_t *sem) {
    sem_post(sem);
}

void cyg_semaphore_wait(cyg_sem_t *sem) {
    sem_wait(sem);
}

int cyg_semaphore_trywait(cyg_sem_t *sem) {
    return sem_trywait(sem);
}

void cyg_semaphore_peek(cyg_sem_t *sem, int *count) {
    int val = 0;
    sem_getvalue(sem, &val);
    if (count) *count = val;
}

/* ============================================================ */
/* Alarm API — nanosleep-based watcher threads                  */
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
    alarm_obj->generation = 0;
    alarm_obj->watcher_alive = 0;

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
}

void cyg_alarm_disable(cyg_handle_t handle) {
    if (handle >= (cyg_handle_t)hal_alarm_count) return;
    cyg_alarm *alarm = hal_alarm_registry[handle];
    if (!alarm) return;
    /* watcher_alive is left alone: the watcher thread is still winding
     * down and will release the liveness slot (or hand off) on exit. */
    alarm->active = 0;
}

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
/* Scheduler lock — global recursive mutex                      */
/* ============================================================ */

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

/* ============================================================ */
/* Time functions                                               */
/* ============================================================ */

cyg_tick_count_t cyg_current_time(void) {
    return (cyg_tick_count_t)(emscripten_get_now() / 10.0);
}

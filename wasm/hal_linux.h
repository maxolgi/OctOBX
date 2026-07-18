#ifndef HAL_LINUX_H_
#define HAL_LINUX_H_

/*
 * hal_linux.h — eCos compatibility shim for the Octopus/Nemo firmware.
 * WASM/Emscripten version for OctoDAW.
 *
 * Provides all eCos types, constants, HAL macros, and function declarations
 * that the original firmware expects. Built with -D__linux__ so the firmware
 * patches route MIDI_send to our backend.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdbool.h>

#ifdef _WIN32
/* ============================================================ */
/* Windows includes (MinGW-w64)                                 */
/* ============================================================ */
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0601
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <mmsystem.h>
#include <avrt.h>
#include <pthread.h>
#include <semaphore.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <errno.h>
#include <process.h>
#include <io.h>
#ifndef _SSIZE_T_DEFINED
  #include <basetsd.h>
  typedef SSIZE_T ssize_t;
  #define _SSIZE_T_DEFINED
#endif
typedef void* hal_fd_t;

#elif defined(__EMSCRIPTEN__)
/* ============================================================ */
/* WASM/Emscripten includes                                     */
/* ============================================================ */
#include <pthread.h>
#include <semaphore.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <errno.h>
#include <emscripten.h>

typedef int hal_fd_t;

#else
/* ============================================================ */
/* POSIX/Linux includes                                         */
/* ============================================================ */
#include <pthread.h>
#include <semaphore.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/timerfd.h>
#include <sys/ioctl.h>
#include <time.h>
#include <errno.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#endif

/* ============================================================ */
/* eCos type definitions                                        */
/* ============================================================ */

typedef unsigned int    cyg_handle_t;
typedef unsigned int    cyg_addrword_t;
typedef int             cyg_vector_t;
typedef unsigned long long cyg_tick_count_t;
typedef unsigned int    cyg_ucount;
typedef unsigned int    cyg_uint;
typedef unsigned int    cyg_ucount32;
typedef unsigned int    cyg_uint32;
typedef unsigned short  cyg_uint16;
typedef unsigned char   cyg_uint8;
typedef int             cyg_count32;
typedef int             cyg_int32;
typedef unsigned char   cyg_bool;

typedef struct {
    pthread_t       tid;
    pthread_attr_t  attr;
    void          (*entry)(cyg_addrword_t);
    cyg_addrword_t  data;
    int             started;
    int             priority;
    char            name[64];
} cyg_thread;

typedef struct {
    unsigned short id;
    char          *name;
    int            set_pri;
    unsigned int   stack_used;
    unsigned int   stack_size;
} cyg_thread_info;

/* Mailbox — ring buffer for Windows and WASM, pipe for Linux */
typedef struct {
#if defined(_WIN32) || defined(__EMSCRIPTEN__)
    pthread_mutex_t mutex;  /* Windows uses CRITICAL_SECTION but we unify here for WASM */
    pthread_cond_t  cond;
    void           *items[64];
    int             head;
    int             tail;
    int             count;
#else
    int fd_read;
    int fd_write;
#endif
} cyg_mbox;

/* On real Windows we override the mutex/cond types after struct definition */
#ifdef _WIN32
#undef cyg_mbox_mutex_type
/* Windows build uses the original CRITICAL_SECTION approach */
/* This header is only used for the WASM build; Windows uses the original */
#endif

typedef pthread_mutex_t cyg_mutex_t;
typedef sem_t cyg_sem_t;

typedef struct {
    cyg_vector_t vector;
    int          priority;
    cyg_addrword_t data;
    unsigned int  (*isr)(cyg_vector_t, cyg_addrword_t);
    void          (*dsr)(cyg_vector_t, cyg_ucount32, cyg_addrword_t);
} cyg_interrupt;

typedef void cyg_alarm_t(cyg_handle_t, cyg_addrword_t);

typedef struct {
#ifdef _WIN32
    void           *htimer;
#elif defined(__EMSCRIPTEN__)
    /* No timerfd or Windows timer — nanosleep-based watcher */
    long            interval_ns;
#else
    int             tfd;
#endif
    pthread_t       watcher_tid;
    int             active;
    cyg_alarm_t    *handler;
    cyg_addrword_t  data;
    cyg_handle_t    handle;
} cyg_alarm;

/* ============================================================ */
/* eCos constants                                               */
/* ============================================================ */

#define CYG_ISR_CALL_DSR    1
#define CYG_ISR_HANDLED     1

#define CYGNUM_HAL_INTERRUPT_TIMER1      1
#define CYGNUM_HAL_INTERRUPT_EXT1        2
#define CYGNUM_HAL_INTERRUPT_UART0_RX    3
#define CYGNUM_HAL_INTERRUPT_UART1_RX    4

/* ============================================================ */
/* E7T hardware register defines — dummy values                 */
/* ============================================================ */

#define E7T_INTMOD          0x01
#define E7T_INTPND          0x02
#define E7T_INTPRI0         0x03
#define E7T_INTPRI1         0x04
#define E7T_INTPRI2         0x05
#define E7T_INTPRI3         0x06
#define E7T_INTPRI4         0x07
#define E7T_INTPRI5         0x08
#define E7T_IOPCON          0x09
#define E7T_IOPDATA         0x0A
#define E7T_IOPMOD          0x0B
#define E7T_TCNT1           0x0C
#define E7T_TDATA1          0x0D
#define E7T_TMOD            0x0E
#define E7T_TMOD_TE1        0x01
#define E7T_TMOD_TMD1       0x02
#define E7T_UART0_BASE      0x10
#define E7T_UART1_BASE      0x20
#define E7T_UART_BRDIV      0x00
#define E7T_UART_CON        0x04
#define E7T_UART_LCON       0x08
#define E7T_UART_RXBUF      0x0C
#define E7T_UART_TXBUF      0x10
#define E7T_UART_STAT       0x14
#define E7T_UART_CON_TXM_INT  0x01
#define E7T_UART_CON_RXM_INT  0x02
#define E7T_UART_LCON_8_DBITS  0x03
#define E7T_UART_LCON_NO_PARITY 0x00
#define E7T_UART_LCON_1_SBITS  0x00

/* ============================================================ */
/* HAL macros                                                   */
/* ============================================================ */

#define HAL_WRITE_UINT32(addr, val)   do { (void)(addr); (void)(val); } while(0)

extern unsigned int hal_cpu_load_timer_start;
#define HAL_READ_UINT32(addr, val)    do { \
    (void)(addr); \
    (val) = ((addr) == 0x0C) ? hal_cpu_load_timer_start : 0; \
} while(0)

extern unsigned long long hal_clock_counter;

#ifdef __EMSCRIPTEN__
#define HAL_CLOCK_READ(pval)  do { \
    *(pval) = (unsigned int)(emscripten_get_now() * 10000.0); \
} while(0)
#else
#define HAL_CLOCK_READ(pval)  do { \
    struct timespec _ts; \
    clock_gettime(CLOCK_MONOTONIC, &_ts); \
    *(pval) = (unsigned int)(_ts.tv_sec * 10000000ULL + _ts.tv_nsec / 100); \
} while(0)
#endif

/* ============================================================ */
/* diag_printf                                                  */
/* ============================================================ */

extern int hal_debug_enabled;

static inline void diag_printf(const char *fmt, ...) {
    if (hal_debug_enabled) {
        va_list ap;
        va_start(ap, fmt);
        vfprintf(stderr, fmt, ap);
        va_end(ap);
        fflush(stderr);
    }
}

#define d_iag_printf(...)  do { if (hal_debug_enabled) { fprintf(stderr, __VA_ARGS__); fflush(stderr); } } while(0)

/* ============================================================ */
/* Flash API                                                    */
/* ============================================================ */

extern unsigned char *hal_flash_base;

typedef void (*flash_printf_fn)(const char *, ...);

static inline void flash_init(void *printfn) {
    (void)printfn;
}

int flash_read(void *src, void *dest, unsigned int len, void **err_addr);
int flash_erase(void *dest, unsigned int len, void **err_addr);
int flash_program(void *dest, void *src, unsigned int len, void **err_addr);

/* ============================================================ */
/* eCos thread API                                              */
/* ============================================================ */

void cyg_thread_create(
    unsigned int        priority,
    void              (*entry)(cyg_addrword_t),
    cyg_addrword_t      data,
    const char         *name,
    void               *stack_base,
    unsigned int        stack_size,
    cyg_handle_t       *handle,
    cyg_thread         *thread_obj
);

void cyg_thread_resume(cyg_handle_t handle);
void cyg_thread_delay(unsigned int ticks);
cyg_bool cyg_thread_get_next(cyg_handle_t *thread, unsigned short *id);
cyg_bool cyg_thread_get_info(cyg_handle_t thread, unsigned short id, cyg_thread_info *info);

/* ============================================================ */
/* eCos mailbox API                                             */
/* ============================================================ */

void cyg_mbox_create(cyg_handle_t *handle, cyg_mbox *mbox);
void *cyg_mbox_get(cyg_handle_t handle);
cyg_bool cyg_mbox_tryput(cyg_handle_t handle, void *item);
int cyg_mbox_peek_item(cyg_handle_t handle);

/* ============================================================ */
/* eCos mutex API                                               */
/* ============================================================ */

void cyg_mutex_init(cyg_mutex_t *mutex);
void cyg_mutex_lock(cyg_mutex_t *mutex);
void cyg_mutex_unlock(cyg_mutex_t *mutex);

/* ============================================================ */
/* eCos semaphore API                                           */
/* ============================================================ */

void cyg_semaphore_init(cyg_sem_t *sem, unsigned int val);
void cyg_semaphore_post(cyg_sem_t *sem);
void cyg_semaphore_wait(cyg_sem_t *sem);
int cyg_semaphore_trywait(cyg_sem_t *sem);
void cyg_semaphore_peek(cyg_sem_t *sem, int *count);

/* ============================================================ */
/* eCos alarm API                                               */
/* ============================================================ */

void cyg_alarm_create(
    cyg_handle_t    counter,
    cyg_alarm_t    *alarm_fn,
    cyg_addrword_t  data,
    cyg_handle_t   *handle,
    cyg_alarm      *alarm_obj
);

void cyg_alarm_initialize(cyg_handle_t handle, cyg_tick_count_t trigger, cyg_tick_count_t interval);
void cyg_alarm_disable(cyg_handle_t handle);

cyg_handle_t cyg_real_time_clock(void);
void cyg_clock_to_counter(cyg_handle_t clock, cyg_handle_t *counter);

/* ============================================================ */
/* eCos interrupt API — stubs                                   */
/* ============================================================ */

void cyg_interrupt_create(
    cyg_vector_t    vector,
    int             priority,
    cyg_addrword_t  data,
    unsigned int  (*isr)(cyg_vector_t, cyg_addrword_t),
    void          (*dsr)(cyg_vector_t, cyg_ucount32, cyg_addrword_t),
    cyg_handle_t  *handle,
    cyg_interrupt *intr_obj
);

void cyg_interrupt_attach(cyg_handle_t handle);
void cyg_interrupt_unmask(cyg_vector_t vector);
void cyg_interrupt_mask(cyg_vector_t vector);
void cyg_interrupt_enable(void);
void cyg_interrupt_disable(void);
void cyg_interrupt_acknowledge(cyg_vector_t vector);

/* ============================================================ */
/* eCos scheduler lock                                          */
/* ============================================================ */

void cyg_scheduler_lock(void);
void cyg_scheduler_unlock(void);

/* ============================================================ */
/* Time functions                                               */
/* ============================================================ */

cyg_tick_count_t cyg_current_time(void);

extern void cyg_user_start(void);

/* ============================================================ */
/* MIDI backend — implemented in midi_wasm.c (WASM build)       */
/* ============================================================ */
extern void midi_init(int queue_ppqn);
extern void midi_set_tempo(int bpm);
extern void midi_start_queue(void);
extern void midi_stop_queue(void);
extern void midi_continue_queue(void);
extern void midi_send_event(int type, int channel, int val1, int val2, unsigned int timestamp);
extern void midi_flush_queue(unsigned int current_timestamp);
extern int  midi_get_client_id(void);
extern void midi_cleanup(void);
extern void *midi_input_thread(void *arg);
extern void midi_set_device(int which, int device_id);
extern int  midi_open_out(int which, int device_id);
extern int  midi_open_in(int device_id);
extern void midi_list_devices(void);

#ifndef __EMSCRIPTEN__
/* ============================================================ */
/* OSC server — only for native builds                          */
/* ============================================================ */
extern void osc_server_init(int port);
extern void osc_server_stop(void);

/* ============================================================ */
/* OSC render — only for native builds                          */
/* ============================================================ */
extern void osc_render_init(const char *host, int port);
extern void osc_render_start(void);
extern void osc_render_stop(void);
extern void osc_render_update_target(const struct sockaddr_in *new_addr);
#endif /* __EMSCRIPTEN__ */

/* ============================================================ */
/* State persistence                                            */
/* ============================================================ */
extern void save_state(const char *filepath);

#endif /* HAL_LINUX_H_ */

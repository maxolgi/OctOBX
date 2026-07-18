/*
 * midi_wasm.c — MIDI ring buffer for the WASM build.
 *
 * Replaces midi_alsa.c. The firmware calls midi_send_event() which pushes
 * events into a ring buffer. JavaScript drains the buffer via exported
 * functions and forwards to openDAW instruments (NoteSignal) or Web MIDI
 * hardware output.
 *
 * MIDI input from JS is fed back to the firmware via wasm_midi_input().
 */

#include "hal_linux.h"

/* MIDI message types — must match firmware defs_general.h */
#define MIDI_NOTE       0
#define MIDI_PGMCH      1
#define MIDI_CC         2
#define MIDI_CLOCK      3
#define MIDI_BENDER     4
#define MIDI_PRESSURE   6

/* MIDI clock message values */
#define MIDICLOCK_CLOCK     0xF8
#define MIDICLOCK_START     0xFA
#define MIDICLOCK_CONTINUE  0xFB
#define MIDICLOCK_STOP      0xFC

/* ============================================================ */
/* MIDI output ring buffer                                      */
/* ============================================================ */

#define MIDI_RING_SIZE 512
#define MIDI_RING_MASK (MIDI_RING_SIZE - 1)

/*
 * Each event packs into 32 bits for efficient JS transfer:
 *   bits 7-0:   status byte (0x90, 0x80, 0xB0, 0xC0, 0xE0, 0xF8, etc.)
 *   bits 15-8:  data1 (note/cc/pgm/lsb)
 *   bits 23-16: data2 (velocity/cc value/msb)
 *   bits 31-24: MIDI channel (1-16, 0 = system/realtime)
 *
 * A parallel array of doubles stores the emscripten_get_now() timestamp
 * (ms, same epoch as performance.now()) recorded at push time. JS reads
 * both arrays via wasm_drain_midi_batch() and passes the timestamp to
 * MIDIOutput.send(data, ts) for jitter-free scheduled delivery.
 */
static uint32_t midi_ring[MIDI_RING_SIZE];
static double   midi_ring_ts[MIDI_RING_SIZE];
static volatile int midi_ring_head = 0;
static volatile int midi_ring_tail = 0;
static volatile uint32_t midi_dropped_count = 0;

static pthread_mutex_t midi_ring_mutex = PTHREAD_MUTEX_INITIALIZER;

static void midi_ring_push(uint8_t status, uint8_t data1, uint8_t data2, uint8_t channel) {
    pthread_mutex_lock(&midi_ring_mutex);
    int next = (midi_ring_tail + 1) & MIDI_RING_MASK;
    if (next == midi_ring_head) {
        midi_ring_head = (midi_ring_head + 1) & MIDI_RING_MASK;
        midi_dropped_count++;
    }
    midi_ring[midi_ring_tail] = (uint32_t)status
                              | ((uint32_t)data1 << 8)
                              | ((uint32_t)data2 << 16)
                              | ((uint32_t)channel << 24);
    midi_ring_ts[midi_ring_tail] = emscripten_get_now();
    midi_ring_tail = next;
    pthread_mutex_unlock(&midi_ring_mutex);
}

/* ============================================================ */
/* Exported ring buffer drain functions (called from JS)        */
/* ============================================================ */

int EMSCRIPTEN_KEEPALIVE wasm_has_midi_event(void) {
    return midi_ring_head != midi_ring_tail;
}

uint32_t EMSCRIPTEN_KEEPALIVE wasm_get_midi_event(void) {
    pthread_mutex_lock(&midi_ring_mutex);
    if (midi_ring_head == midi_ring_tail) {
        pthread_mutex_unlock(&midi_ring_mutex);
        return 0;
    }
    uint32_t event = midi_ring[midi_ring_head];
    midi_ring_head = (midi_ring_head + 1) & MIDI_RING_MASK;
    pthread_mutex_unlock(&midi_ring_mutex);
    return event;
}

/* Batch drain: copies up to max_count events + timestamps into static
 * buffers and advances head in a single mutex acquisition. JS reads the
 * results via get_midi_batch_events_ptr() / get_midi_batch_ts_ptr().
 * Returns the number of events copied. */
#define MIDI_BATCH_MAX 128
static uint32_t midi_batch_events[MIDI_BATCH_MAX];
static double   midi_batch_ts[MIDI_BATCH_MAX];

int EMSCRIPTEN_KEEPALIVE wasm_drain_midi_batch(int max_count) {
    if (max_count > MIDI_BATCH_MAX) max_count = MIDI_BATCH_MAX;
    if (max_count < 0) max_count = 0;

    pthread_mutex_lock(&midi_ring_mutex);
    int count = 0;
    while (count < max_count && midi_ring_head != midi_ring_tail) {
        midi_batch_events[count] = midi_ring[midi_ring_head];
        midi_batch_ts[count]     = midi_ring_ts[midi_ring_head];
        midi_ring_head = (midi_ring_head + 1) & MIDI_RING_MASK;
        count++;
    }
    pthread_mutex_unlock(&midi_ring_mutex);
    return count;
}

uint32_t* EMSCRIPTEN_KEEPALIVE get_midi_batch_events_ptr(void) {
    return midi_batch_events;
}

double* EMSCRIPTEN_KEEPALIVE get_midi_batch_ts_ptr(void) {
    return midi_batch_ts;
}

uint32_t EMSCRIPTEN_KEEPALIVE wasm_get_midi_dropped_count(void) {
    return midi_dropped_count;
}

/* ============================================================ */
/* MIDI input from JS → firmware interpreter                    */
/* ============================================================ */

extern unsigned char G_clock_source;
extern unsigned char G_run_bit;
extern unsigned char G_running_status_byte_IN_UART[][3];

extern void G_midi_interpret_REALTIME(unsigned char midi_byte);
extern void G_midi_interpret_NOTE_ON(unsigned char midi_byte, unsigned char UART_ndx);
extern void G_midi_interpret_CONTROL(unsigned char midi_byte, unsigned char UART_ndx);
extern void G_midi_interpret_BENDER(unsigned char midi_byte, unsigned char UART_ndx);
extern void G_midi_interpret_PRESSURE(unsigned char midi_byte, unsigned char UART_ndx);

void EMSCRIPTEN_KEEPALIVE wasm_midi_input(uint8_t status, uint8_t data1, uint8_t data2) {
    uint8_t cmd = status & 0xF0;
    uint8_t UART_ndx = 0;

    cyg_scheduler_lock();

    switch (cmd) {
        case 0x90:
        case 0x80:
            G_running_status_byte_IN_UART[UART_ndx][0] = status;
            G_midi_interpret_NOTE_ON(data1, UART_ndx);
            G_midi_interpret_NOTE_ON(data2, UART_ndx);
            break;
        case 0xB0:
            G_running_status_byte_IN_UART[UART_ndx][0] = status;
            G_midi_interpret_CONTROL(data1, UART_ndx);
            G_midi_interpret_CONTROL(data2, UART_ndx);
            break;
        case 0xE0:
            G_running_status_byte_IN_UART[UART_ndx][0] = status;
            G_midi_interpret_BENDER(data1, UART_ndx);
            G_midi_interpret_BENDER(data2, UART_ndx);
            break;
        case 0xD0:
            G_running_status_byte_IN_UART[UART_ndx][0] = status;
            G_midi_interpret_PRESSURE(data1, UART_ndx);
            break;
        case 0xF0:
            if (status >= 0xF8)
                G_midi_interpret_REALTIME(status);
            break;
    }

    cyg_scheduler_unlock();
}

/* ============================================================ */
/* MIDI backend interface — called by firmware                  */
/* ============================================================ */

void midi_init(int queue_ppqn) {
    (void)queue_ppqn;
    midi_ring_head = 0;
    midi_ring_tail = 0;
    midi_dropped_count = 0;
    memset(midi_ring_ts, 0, sizeof(midi_ring_ts));
}

void midi_send_event(int type, int val0, int val1, int val2, unsigned int timestamp) {
    (void)timestamp;

    int channel = val0;
    int midi_channel = 0;

    if (type == MIDI_NOTE || type == MIDI_PGMCH || type == MIDI_CC ||
        type == MIDI_BENDER || type == MIDI_PRESSURE) {

        /* Decode port/channel from val0 (same logic as midi_alsa.c) */
        if (val0 > 16 && val0 <= 32) {
            channel = val0 - 16;
        } else if (val0 > 32 && val0 <= 48) {
            channel = val0 - 32;
        } else if (val0 > 48 && val0 <= 64) {
            channel = val0 - 48;
        }

        if (channel > 0) channel--;
        midi_channel = channel;

        switch (type) {
            case MIDI_NOTE:
                if (val2 == 0)
                    midi_ring_push(0x80 | (midi_channel & 0x0F), val1, 0, midi_channel + 1);
                else
                    midi_ring_push(0x90 | (midi_channel & 0x0F), val1, val2, midi_channel + 1);
                break;
            case MIDI_PGMCH:
                midi_ring_push(0xC0 | (midi_channel & 0x0F), val1, 0, midi_channel + 1);
                break;
            case MIDI_CC:
                midi_ring_push(0xB0 | (midi_channel & 0x0F), val1, val2, midi_channel + 1);
                break;
            case MIDI_BENDER:
                midi_ring_push(0xE0 | (midi_channel & 0x0F), val1, val2, midi_channel + 1);
                break;
            case MIDI_PRESSURE:
                midi_ring_push(0xD0 | (midi_channel & 0x0F), val1, 0, midi_channel + 1);
                break;
        }
    } else if (type == MIDI_CLOCK) {
        switch (val0) {
            case MIDICLOCK_CLOCK:
                midi_ring_push(0xF8, 0, 0, 0);
                break;
            case MIDICLOCK_START:
                midi_ring_push(0xFA, 0, 0, 0);
                break;
            case MIDICLOCK_CONTINUE:
                midi_ring_push(0xFB, 0, 0, 0);
                break;
            case MIDICLOCK_STOP:
                midi_ring_push(0xFC, 0, 0, 0);
                break;
        }
    }
}

void midi_flush_queue(unsigned int current_timestamp) {
    (void)current_timestamp;
}

void midi_set_tempo(int bpm) {
    (void)bpm;
}

void midi_start_queue(void) {}
void midi_stop_queue(void) {}
void midi_continue_queue(void) {}

int midi_get_client_id(void) {
    return 0;
}

void midi_cleanup(void) {}

void midi_set_device(int which, int device_id) {
    (void)which;
    (void)device_id;
}

int midi_open_out(int which, int device_id) {
    (void)which;
    (void)device_id;
    return 0;
}

int midi_open_in(int device_id) {
    (void)device_id;
    return 0;
}

void midi_list_devices(void) {}

void *midi_input_thread(void *arg) {
    (void)arg;
    return NULL;
}

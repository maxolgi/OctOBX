// gxfx_shims/gxtuner_pthread_shim.h — OctOBX pthread neutralizer for the
// gxfx tuner TU (Phase 2-d). This is NOT an include-order shadow of
// <pthread.h> (that breaks libc++: gxfx_prelude.h's <algorithm> chain
// pulls <atomic> → __thread/support/pthread.h, which needs the REAL
// pthread types) — it is included EXPLICITLY, once, by
// wasm/obxd/gxfx_dsp_tuner.cpp, and only macro-overrides the three calls
// gx_pitch_tracker.cpp's thread machinery actually makes:
//
//   pthread_create — RECORD, don't spawn: stores the entry (always
//       PitchTracker::static_run) + argument (the tracker `this`) in
//       TU-local statics and reports success. The tuner wrapper captures
//       the pair per instance right after set_samplerate (which is what
//       triggers PitchTracker's one-time start_thread) and re-invokes the
//       entry on its ~100 ms analysis cadence; the sem_wait gate macro in
//       gxfx_shims/semaphore.h makes each run() invocation analyze once.
//   pthread_cancel / pthread_join — no-ops returning 0 (the "handle" is
//       the fake 1 written by the recorder; musl's real join would
//       dereference it).
//
// Everything else (attr setup, pthread_setcancelstate, sched_get_priority_max
// in tuner.cc's init) stays REAL — pure userspace struct manipulation /
// plain returns in this single-threaded build, and the values they compute
// are only ever passed to the no-op'd calls.
#pragma once

#ifndef GXFX_SHIMS_GXTUNER_PTHREAD_SHIM_H
#define GXFX_SHIMS_GXTUNER_PTHREAD_SHIM_H

#ifdef __cplusplus

#include <pthread.h> // REAL sysroot header — types + attr API used as-is

// Recorded "thread" — the tuner wrapper drives it cooperatively. The
// entry keeps pthread_create's exact `void* (*)(void*)` signature: wasm
// indirect calls are signature-checked, so calling through a mistyped
// function pointer traps ("null function or function signature mismatch").
static void* (*gxfx_pthread_entry)(void*) = 0;
static void* gxfx_pthread_arg = 0;

static inline int gxfx_pthread_create(pthread_t* t, const pthread_attr_t*,
                                      void* (*start_routine)(void*), void* arg) {
    gxfx_pthread_entry = start_routine;
    gxfx_pthread_arg = arg;
    if (t) *t = (pthread_t)1; // mark "created" so PitchTracker never re-spawns
    return 0;                 // success — without ever creating a thread
}

static inline int gxfx_pthread_cancel(pthread_t) { return 0; }
static inline int gxfx_pthread_join(pthread_t, void**) { return 0; }

#define pthread_create gxfx_pthread_create
#define pthread_cancel gxfx_pthread_cancel
#define pthread_join   gxfx_pthread_join

#else
#error "gxfx_shims/gxtuner_pthread_shim.h is C++-only (the gxfx TUs are C++)"
#endif // __cplusplus

#endif // GXFX_SHIMS_GXTUNER_PTHREAD_SHIM_H

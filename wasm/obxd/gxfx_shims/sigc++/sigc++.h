// gxfx_shims/sigc++/sigc++.h — OctOBX stand-in for libsigc++'s umbrella
// header inside the gxfx tuner TU (Phase 2-d). gx_pitch_tracker.h declares
// `sigc::signal<void> new_freq;` and fires it whenever the detected
// frequency changes; upstream the tuner LV2 wrapper connects a MIDI
// note-handler to it (gxtuner.cpp freq_changed_handler → play_midi).
//
// The OctOBX port drops the whole sigc/MIDI/uniBar machinery (fx2plan.md):
// the wrapper polls the frequency via fx_get_out_param instead of
// subscribing to a callback, so the signal only needs to be CALLABLE —
// invocation `new_freq()` must compile and do nothing.
//
// Minimal surface: a templated no-op signal<R> with operator(). The tuner
// TU is its only consumer (only gx_pitch_tracker.h includes sigc++);
// include-order shadowing puts this dir first for every gxfx TU.
#pragma once

#ifndef GXFX_SHIMS_SIGCXX_SIGCPP_H
#define GXFX_SHIMS_SIGCXX_SIGCPP_H

namespace sigc {

template <typename R>
struct signal {
    // Fire the signal — no-op (no subscribers in the headless port).
    void operator()() const {}
};

} // namespace sigc

#endif // GXFX_SHIMS_SIGCXX_SIGCPP_H

// gxfx_dsp_tuner.cpp — OctOBX Phase 2-d: "Tuner" (id 81, category
// special) — gxtuner.lv2's pitch tracker (gx_pitch_tracker.{h,cpp} +
// tuner.cc's PluginLV2 adapter, unmodified, namespace-wrapped like every
// gxfx DSP include). The tracker is the NSDF (normalized square difference
// function) pitch detector guitarix credits to K4Guitune/tartini: input is
// resampled to a fixed 20.5 kHz ring (gx_resampler's VResampler, compiled
// into gxfx_dsp.cpp), and every TRACKER_PERIOD (0.1 s) upstream copies the
// ring and sem_post()s a dedicated analysis thread which runs one
// FFT-sized autocorrelation via an r2r FFT pair.
//
// Blockers neutered by gxfx_shims (include-order shadow — NO guitarix
// source edits, fx2plan.md Phase 2):
//   - fftw: the tracker plans one R2HC + one HC2R r2r transform
//     (m_fftSize = 3072 at the fixed FFT_SIZE 2048 window). The extended
//     gxfx_shims/fftw3.h implements both over kiss_fftr with fftw's exact
//     halfcomplex layout and UNNORMALIZED round trip (the tracker divides
//     the HC2R output by n itself, and derives its NSDF normalizer from
//     the same output — a scaled shim would corrupt it).
//   - pthread+semaphore: upstream's analysis thread is spawned from
//     PitchTracker::init and loops forever on sem_wait(). In-tree the
//     thread is NEVER spawned: gxfx_shims/pthread.h's pthread_create
//     RECORDS the entry (always PitchTracker::static_run + the tracker
//     this) and this wrapper captures the pair per instance at init time
//     (duplicate tuner slots each drive their own tracker), then re-invokes
//     it on a ~100 ms block cadence; gxfx_shims/semaphore.h's sem_wait
//     gate macro turns each run() invocation into EXACTLY ONE analysis
//     pass (first sem_wait falls through into the analysis body; when the
//     for(;;) loops back, the gate returns). Tens of µs per pass on the
//     audio thread — the fx2plan Phase 2 budget.
//   - sigc++/MIDI/uniBar: dropped entirely. Upstream's sigc new_freq
//     signal feeds the LV2 wrapper's MIDI-note-out machinery (play_midi,
//     metronome, uniBar) — none of it is an insert effect. The no-op
//     gxfx_shims/sigc++/sigc++.h keeps the member callable; the detected
//     frequency reaches the UI through the engine's out-port surface
//     instead: the FREQ control OUTPUT port (ttl index 0) is the FIRST
//     REAL g_fx_out consumer — gxfx_host.cpp connects it to
//     g_fx_out[inst][slot][0] and JS polls fx_get_out_param.
//
// Param surface (GUI-less sensible subset of gx_tuner.ttl, inline in the
// generator manifest — the ttl's other control inputs are MIDI machinery
// CHANNEL/ONMIDI/FASTNOTE/PITCHBEND/SINGLENOTE/BPM/VELOCITY/VERIFY/GATE/
// SYNTHFREQ/GAIN, GUI-only TUNER_MODE/TEMPERAMENT/MAXL/RESET, and the
// MIDI/note enum notes; note the ttl's tail port order also disagrees with
// gxtuner.h's PortIndex, so the ttl cannot be trusted for indexes anyway):
//   port 1 REFFREQ   427..453 Hz (default 440) — display reference: the
//                    engine never reads it (upstream's wrapper doesn't
//                    either — note naming is client-side); the UI's note
//                    math shifts A4 by it.
//   port 4 THRESHOLD -60..4 dB (default -50) — db2power gate for the
//                    tracker, applied with upstream's 0.1 dB hysteresis.
//
// Audio is BIT-IDENTICAL through the tuner (analysis reads `input` only);
// mono (one audio input) → dual-mono host, so L and R each run a tracker
// and both write the slot's shared FREQ out slot (same signal, last-writer
// per block — harmless).
//
// Compile (syntax check):
//   em++ -std=c++20 -O2 -fsyntax-only \
//     -I wasm/obxd/gxfx_shims \
//     -I wasm/obxd \
//     -I wasm/obxd/kissfft \
//     -I third_party/guitarix/trunk/src/LV2/DSP \
//     -I third_party/guitarix/trunk/src/zita-resampler-1.1.0 \
//     -Wno-vla-cxx-extension \
//     wasm/obxd/gxfx_dsp_tuner.cpp
#include "gxfx_prelude.h"

// Shims FIRST and at GLOBAL scope: tuner.cc pulls gx_pitch_tracker.h from
// inside namespace gxt below, and the shim include guards must already
// have fired there so no shim content leaks into the namespace.
#include <fftw3.h>        // gxfx_shims/fftw3.h — r2r halfcomplex subset
#include "gxtuner_pthread_shim.h" // real <pthread.h> + recording overrides
#include <semaphore.h>    // gxfx_shims/semaphore.h — sem_wait gate macro
#include <sigc++/sigc++.h> // gxfx_shims/sigc++/sigc++.h — no-op signal

#include <assert.h>

#include "../../third_party/guitarix/trunk/src/LV2/DSP/gx_pluginlv2.h"
#include "../../third_party/guitarix/trunk/src/LV2/DSP/gx_resampler.h"

namespace gxt {
// The guitarix tuner adapter (class tuner — owns the PitchTracker, maps
// the PluginLV2 surface onto it) and the tracker itself, unmodified.
#include "../../third_party/guitarix/trunk/src/LV2/gxtuner.lv2/tuner.cc"
#include "../../third_party/guitarix/trunk/src/LV2/gxtuner.lv2/gx_pitch_tracker.cpp"
} // namespace gxt

namespace gxfx_tuner {

// Host render quantum — the only block size the AWP engine renders.
enum { BUFSIZE = 128 };

// Port space (subset of gxtuner.h's PortIndex, ttl-consistent indexes).
enum {
    FREQ = 0,       // control OUTPUT — detected frequency in Hz (0 = silent)
    REFFREQ = 1,    // control input — display reference pitch (unused here)
    THRESHOLD = 4,  // control input — tracker gate in dB
};

class TunerDsp : public PluginLV2 {
private:
    gxt::tuner* t_;         // the adapter (owns the PitchTracker)
    void* (*run_fn_)(void*); // recorded "thread" entry (PitchTracker::static_run —
    void* run_arg_;          //  exact pthread signature; wasm checks indirect-call types)
    float* freq_ptr_;       // connected FREQ out port → g_fx_out[e][s][0]
    float* threshold_ptr_;  // connected THRESHOLD param mirror slot (dB)
    float threshold_;       // last applied threshold (0.1 dB hysteresis band)
    int blocks_;            // blocks since the last analysis pass
    int cadence_;           // blocks per pass — ~(rate/10)/BUFSIZE ≈ 37 @ 48k

public:
    TunerDsp()
        : PluginLV2(),
          t_(static_cast<gxt::tuner*>(gxt::plugin())),
          run_fn_(0), run_arg_(0),
          freq_ptr_(0), threshold_ptr_(0), threshold_(0.0f),
          blocks_(0), cadence_(1) {
        version = PLUGINLV2_VERSION;
        id = "tuner";
        name = N_("Tuner");
        mono_audio = compute_static;
        stereo_audio = 0;
        set_samplerate = init_static;
        activate_plugin = activate_static;
        connect_ports = connect_static;
        delete_instance = del_instance;
    }
    ~TunerDsp() {
        if (t_ && t_->delete_instance) t_->delete_instance(t_);
    }

    // tuner.cc's init (assigned to the adapter's set_samplerate) runs
    // PitchTracker::init → setParameters → start_thread → the pthread shim
    // RECORDS the entry instead of spawning. Capture the pair per instance
    // (duplicate tuner slots must never share a recorded tracker), and set
    // the analysis cadence from the rate.
    static void init_static(uint32_t rate, PluginLV2* p) {
        TunerDsp* s = static_cast<TunerDsp*>(p);
        if (!s->t_) return;
        s->t_->set_samplerate(rate, s->t_);
        s->run_fn_ = gxfx_pthread_entry;
        s->run_arg_ = gxfx_pthread_arg;
        s->cadence_ = (int)(rate / 10u / BUFSIZE); // ~100 ms of blocks
        if (s->cadence_ < 1) s->cadence_ = 1;
        s->blocks_ = 0;
    }

    static void connect_static(uint32_t port, void* data, PluginLV2* p) {
        TunerDsp* s = static_cast<TunerDsp*>(p);
        if (port == FREQ) s->freq_ptr_ = static_cast<float*>(data);
        else if (port == THRESHOLD) s->threshold_ptr_ = static_cast<float*>(data);
        // REFFREQ (port 1) is display-only — the adapter has no params to
        // forward (upstream's wrapper never read it either).
    }

    static int activate_static(bool start, PluginLV2* p) {
        TunerDsp* s = static_cast<TunerDsp*>(p);
        if (s->t_ && s->t_->activate_plugin) s->t_->activate_plugin(start, s->t_);
        return 0; // activate(false) → PitchTracker::reset() upstream
    }

    static void compute_static(int count, float* input, float* output, PluginLV2* p) {
        TunerDsp* s = static_cast<TunerDsp*>(p);
        // Feed the tracker — feed_tuner READS `input` and ignores its
        // output arg; the samples are never modified (tuner = transparent).
        if (s->t_ && s->t_->mono_audio) s->t_->mono_audio(count, input, input, s->t_);
        if (output != input) memcpy(output, input, (size_t)count * sizeof(float));
        // THRESHOLD gate with upstream's 0.1 dB hysteresis (threshold_ = 0
        // init means the ttl default -50 applies on the first block, like
        // upstream's uninitialized-then-differs read).
        if (s->threshold_ptr_) {
            const float v = *s->threshold_ptr_;
            if (fabsf(v - s->threshold_) > 0.1f) {
                s->threshold_ = v;
                gxt::tuner::set_threshold_level(*s->t_, v);
            }
        }
        // ~100 ms cadence: one inline NSDF analysis pass (level check +
        // 3072-pt FFT pair + maxima search — tens of µs). The sem gate
        // makes the recorded run() entry analyze once, then return.
        if (s->run_fn_ && ++s->blocks_ >= s->cadence_) {
            s->blocks_ = 0;
            gxfx_sem_reset();
            s->run_fn_(s->run_arg_);
        }
        // FREQ out port, refreshed every block like upstream's
        // `*(freq) = self.get_freq(self)` (0 until the first detection).
        if (s->freq_ptr_) *s->freq_ptr_ = gxt::tuner::get_freq(*s->t_);
    }

    static void del_instance(PluginLV2* p) { delete static_cast<TunerDsp*>(p); }
};

PluginLV2* create() { return new TunerDsp(); }

} // namespace gxfx_tuner

// namespace path: gxfx_tuner::create(). Factory order MUST match the
// generator manifest order (id 81 tuner, after Phase 2-c detune).
typedef PluginLV2* (*gxfx_factory)();
PluginLV2* gxfx_create_tuner() { return gxfx_tuner::create(); }

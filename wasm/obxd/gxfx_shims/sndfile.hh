// gxfx_shims/sndfile.hh — no-op libsndfile stand-in for the guitarix
// livelooper (OctOBX Phase 3, include-order shadow like fftw3.h).
//
// gx_livelooper.lv2's wrapper includes <sndfile.hh> (libsndfile's C++
// header, which pulls the C API); the bundle-LOCAL livelooper.cc actually
// references only the C surface: SF_INFO, SNDFILE, sf_open, sf_read_float,
// sf_close, sf_write_float, sf_write_sync. This stub implements exactly
// that surface with opens that ALWAYS FAIL (sf_open returns NULL), so:
//
//   - load_from_wave() skips the read (sf NULL) and returns 0 — loops
//     start EMPTY each session (fresh WASM heap, no persistence);
//   - save_to_wave() skips the write (sf NULL); sf_close(NULL) is a no-op;
//   - save_array()'s stat/mkdir dance may still run (getenv("HOME") under
//     an empty browser environ returns NULL — std::string's strlen then
//     reads wasm linear-memory byte 0, which the zero-filled "null page"
//     keeps 0, so the path degrades to "" — harmless; do NOT shim getenv).
//
// Safe to shadow: unlike pthread.h (see gxtuner_pthread_shim.h — emcc's
// own headers include it), NO system header includes sndfile.hh.
#pragma once

#include <cstdint>

typedef int64_t sf_count_t;

typedef struct SNDFILE_tag SNDFILE;

struct SF_INFO {
    sf_count_t frames;
    int samplerate;
    int channels;
    int format;
    int sections;
    int seekable;
};

enum {
    SFM_READ = 0x10,
    SFM_WRITE = 0x20,
};

enum {
    SF_FORMAT_WAV = 0x010000,
    SF_FORMAT_FLOAT = 0x0006,
};

inline SNDFILE* sf_open(const char*, int, SF_INFO*) { return NULL; }
inline int sf_close(SNDFILE*) { return 0; }
inline sf_count_t sf_read_float(SNDFILE*, float*, sf_count_t) { return 0; }
inline sf_count_t sf_write_float(SNDFILE*, const float*, sf_count_t) { return 0; }
inline void sf_write_sync(SNDFILE*) {}

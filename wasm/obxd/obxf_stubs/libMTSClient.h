// wasm/obxd/obxf_stubs/libMTSClient.h — minimal compile/link stub.
//
// The OB-Xf fork's engine/Tuning.h (from third_party/OB-Xf/src)
// #include "libMTSClient.h" from the ODDSound MTS-ESP client library. The
// real header lives in the libs/MTS-ESP submodule, which AGENTS.md
// explicitly says NOT to initialize for the WASM/AWP build — so it is
// absent from this checkout, and the stub dir stands in for it by -I
// order (obxf_stubs precedes ../../third_party/OB-Xf/src).
//
// Tuning.h uses a tiny surface of MTS-ESP:
//   - MTSClient            (opaque handle type)
//   - MTS_RegisterClient() -> MTSClient*
//   - MTS_DeregisterClient(MTSClient*)
//   - MTS_HasMaster(MTSClient*) -> int
//   - MTS_GetScaleName(MTSClient*) -> const char*
//   - MTS_RetuningInSemitones(MTSClient*, int midiIndex, int midiChannel) -> double
//
// This stub provides all of those as no-ops so the engine compiles AND
// links without the real MTS-ESP library. The WASM OB-Xf build has no
// use for MTS-ESP (there is no host to register with from an
// AudioWorkletGlobalScope), so the no-op behaviour is also functionally
// correct: the engine will fall back to its TWELVE_TET branch.
#ifndef OBXF_STUB_LIBMTSCLIENT_H
#define OBXF_STUB_LIBMTSCLIENT_H

#ifdef __cplusplus
extern "C" {
#endif

typedef struct MTSClient_s MTSClient;

// No-op client registration. Returns a sentinel non-null handle so
// Tuning's `mts_client == nullptr` check passes and updateMTSESPStatus
// proceeds to query MTS_HasMaster (which the stub below reports as 0,
// forcing the engine into its equal-temperament branch).
inline MTSClient *MTS_RegisterClient(void) { return (MTSClient *)1; }

inline void MTS_DeregisterClient(MTSClient *c) { (void)c; }

// No MTS master in the WASM build -> always 0 so Tuning::mode stays
// TWELVE_TET and the retuning helpers below are never consulted.
inline int MTS_HasMaster(MTSClient *c) { (void)c; return 0; }

inline const char *MTS_GetScaleName(MTSClient *c) { (void)c; return ""; }

// Identity retuning (12-TET). Only invoked when MTS_HasMaster returns
// non-zero, which the stub above never allows.
inline double MTS_RetuningInSemitones(MTSClient *c, int midiIndex, int midiChannel)
{
    (void)c; (void)midiIndex; (void)midiChannel; return 0.0;
}

#ifdef __cplusplus
} // extern "C"
#endif

#endif // OBXF_STUB_LIBMTSCLIENT_H

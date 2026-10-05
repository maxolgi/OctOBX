#pragma once
// Minimal headless stand-in for guitarix gx_common.h + gx_compiler.h (OctOBX wasm):
// no SSE fxsave denormal control, no custom section attributes, no lv2 headers.
#include <cstdint>
#include <cstdlib>
#include <cmath>
#include <algorithm>
#include <cstring>
#include <unistd.h>
#define FAUSTFLOAT float
#ifndef N_
#define N_(String) (String)
#endif
#define always_inline inline __attribute__((always_inline))
#define __rt_func
#define __rt_data
// faustpower helpers (verbatim semantics from gx_common.h, global scope)
template <int32_t N> inline float faustpower(float x) { return powf(x, N); }
template <int32_t N> inline double faustpower(double x) { return pow(x, N); }
template <int32_t N> inline int32_t faustpower(int32_t x) { return faustpower<N/2>(x) * faustpower<N-N/2>(x); }
template <> inline int32_t faustpower<0>(int32_t x) { return 1; }
template <> inline int32_t faustpower<1>(int32_t x) { return x; }
template<class T> inline T mydsp_faustpower2_f(T x) {return (x * x);}
template<class T> inline T mydsp_faustpower3_f(T x) {return ((x * x) * x);}
template<class T> inline T mydsp_faustpower4_f(T x) {return (((x * x) * x) * x);}
template<class T> inline T mydsp_faustpower5_f(T x) {return ((((x * x) * x) * x) * x);}
template<class T> inline T mydsp_faustpower6_f(T x) {return (((((x * x) * x) * x) * x) * x);}
template<class T> inline T mydsp_faustpower7_f(T x) {return x * x * x * x * x * x * x;}

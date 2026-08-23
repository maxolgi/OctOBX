/*
 * OB-Xd was originally written by Vadim Filatov, and then a version
 * was released under the GPL3 at https://github.com/reales/OB-Xd.
 * Subsequently, the product was continued by DiscoDSP and the copyright
 * holders as an excellent closed source product.
 *
 * This repository is a successor to OB-Xd version 2.11.
 * Copyright 2013-2025 by the authors as indicated in the original release,
 * and subsequent authors as per GitHub transaction log.
 *
 * OB-Xf is released under the GNU General Public Licence v3 or later
 * (GPL-3.0-or-later). The license is found in the file "LICENSE"
 * in the root of this repository or at:
 * https://www.gnu.org/licenses/gpl-3.0.en.html
 *
 * Source code is available at https://github.com/surge-synthesizer/OB-Xf
 */

#ifndef OBXF_SRC_ENGINE_FILTER_H
#define OBXF_SRC_ENGINE_FILTER_H

#include "Voice.h"
#include <math.h>

/*
 * OctOBX perf: fast tan/atan for the per-sample filter path.
 *
 * apply2Pole/apply4Pole call tan (and apply4Pole atan) once per voice per
 * sample. wasm libm tan costs ~15-30ns per call -- at 48kHz that alone is
 * 25-50% of the measured ~39ns/voice-sample render budget. These polynomial
 * replacements (fitted by least squares with iterative error reweighting,
 * scripts in the OctOBX repo) keep error far below audibility:
 *
 *   fastTanf:  max rel err 2.6e-4 on [0, 1.5646] rad (= the sr/2-120Hz
 *              cutoff clamp at 48kHz; 0.0008 semitones at the very top of
 *              the range, ~100x less at musical cutoffs)
 *   fastAtanf: max abs err 6.8e-5 rad on [-50, 50] (0.004 degrees)
 */
inline static float obxfTanPoly(float x)
{
    // tan(x) on [0, pi/4]: x + x^3 * P(x^2), P fitted to tan
    const float x2 = x * x;
    float p = 0.0171416641f;
    p = p * x2 + 0.0170496435f;
    p = p * x2 + 0.0550297761f;
    p = p * x2 + 0.1332545265f;
    p = p * x2 + 0.3333342435f;
    return x + x * x2 * p;
}

inline static float fastTanf(float x)
{
    // x in [0, pi/2). Above pi/4 use tan(x) = 2t/(1-t^2), t = tan(x/2)
    // (x/2 then lies in [0, pi/4) where the polynomial is tight).
    if (x < 0.78539816339744830962f)
        return obxfTanPoly(x);
    float t = obxfTanPoly(x * 0.5f);
    return (2.f * t) / (1.f - t * t);
}

inline static float fastAtanf(float x)
{
    // atan on [-1,1]: z * P(z^2); |x| > 1 via atan(x) = pi/2 - atan(1/x)
    const float sign = (x < 0.f) ? -1.f : 1.f;
    float ax = x * sign;
    if (ax > 1.f)
        ax = 1.f / ax;
    const float u = ax * ax;
    float p = 0.0254550195f;
    p = p * u - 0.0947809840f;
    p = p * u + 0.1867836323f;
    p = p * u - 0.3319686278f;
    p = p * u + 0.9999768499f;
    const float r = ax * p;
    const float PI_2 = 1.57079632679489661923f;
    return ((x < -1.f) || (x > 1.f)) ? sign * (PI_2 - r) : sign * r;
}


class Filter
{
  private:
    // clang-format off
    constexpr static float poleMixFactors[NUM_XPANDER_MODES][5]
    {
        {0,  0,  0,  0,  1}, // LP4
        {0,  0,  0,  1,  0}, // LP3
        {0,  0,  1,  0,  0}, // LP2
        {0,  1,  0,  0,  0}, // LP1
        {1, -3,  3, -1,  0}, // HP3
        {1, -2,  1,  0,  0}, // HP2
        {1, -1,  0,  0,  0}, // HP1
        {0,  0,  2, -4,  2}, // BP4
        {0, -2,  2,  0,  0}, // BP2
        {1, -2,  2,  0,  0}, // N2
        {1, -3,  6, -4,  0}, // PH3
        {0, -1,  2, -1,  0}, // HP2+LP1
        {0, -1,  3, -3,  1}, // HP3+LP1
        {0, -1,  2, -2,  0}, // N2+LP1
        {0, -1,  3, -6,  4}, // PH3+LP1
    };
    // clang-format on

    struct State
    {
        float pole1{0.f};
        float pole2{0.f};
        float pole3{0.f};
        float pole4{0.f};

        float res2Pole{1.f};
        float res4Pole{0.f};

        float resCorrection{1.f};
        float resCorrectionInv{1.f};

        float multimodeXfade{0.f};
        int multimodePole{0};
    } state;

    float sampleRate{1.f};
    float sampleRateInv{1.f};

  public:
    struct Parameters
    {
        bool bpBlend2Pole{false};
        bool push2Pole{false};
        bool xpander4Pole{false};

        float multimode{0.f};
        uint8_t xpanderMode{0};
    } par;

    Filter() {}

    void reset()
    {
        state.pole1 = 0.f;
        state.pole2 = 0.f;
        state.pole3 = 0.f;
        state.pole4 = 0.f;
    }

    void setMultimode(float m)
    {
        par.multimode = m;
        state.multimodePole = (int)(par.multimode * 3);
        state.multimodeXfade = par.multimode * 3 - state.multimodePole;
    }

    inline void setSampleRate(float sr)
    {
        sampleRate = sr;
        sampleRateInv = 1.f / sampleRate;

        float rcRate = sqrt((44000.f / sampleRate));

        state.resCorrection = (970.f / 44000.f) * rcRate;
        state.resCorrectionInv = 1.f / state.resCorrection;
    }

    inline void setResonance(float res)
    {
        state.res2Pole = 1.f - res;
        state.res4Pole = (3.5f * res);
    }

    inline float diodePairResistanceApprox(float x)
    {
        // Taylor approximation of a slightly mismatched diode pair
        return (((((0.0103592f) * x + 0.00920833f) * x + 0.185f) * x + 0.05f) * x + 1.f);
    }

    inline float resolveFeedback2Pole(float sample, float g)
    {
        // calculating feedback non-linear transconducance and compensated for state.res2Pole(-1)
        float tCfb;

        // boosting non-linearity
        float push = -1.f - (par.push2Pole * 0.035f);

        tCfb = diodePairResistanceApprox(state.pole1 * 0.0876f) + push;

        // disable non-linearity (digital filter)
        // tCfb = 0;

        // resolve linear feedback
        float y = ((sample - 2.f * (state.pole1 * (state.res2Pole + tCfb)) - g * state.pole1 -
                    state.pole2) /
                   (1.f + g * (2.f * (state.res2Pole + tCfb) + g)));

        return y;
    }

    inline float apply2Pole(float sample, float g)
    {
        float gpw = fastTanf(g * sampleRateInv * pi); // OctOBX perf: was tanf()

        g = gpw;

        float v = resolveFeedback2Pole(sample, g);

        float y1 = v * g + state.pole1;
        state.pole1 = v * g + y1;

        float y2 = y1 * g + state.pole2;
        state.pole2 = y1 * g + y2;

        float out;

        if (par.bpBlend2Pole)
        {
            out = 2.f * (par.multimode < 0.5f
                             ? ((0.5f - par.multimode) * y2 + (par.multimode * y1))
                             : ((1.f - par.multimode) * y1 + (par.multimode - 0.5f) * v));
        }
        else
        {
            out = (1.f - par.multimode) * y2 + (par.multimode * v);
        }

        return out;
    }

    inline float resolveFeedback4Pole(float sample, float g, float lpc)
    {
        float ml = 1.f / (1.f + g);
        float S =
            (lpc * (lpc * (lpc * state.pole1 + state.pole2) + state.pole3) + state.pole4) * ml;
        float G = lpc * lpc * lpc * lpc;
        float y = (sample - state.res4Pole * S) / (1.f + state.res4Pole * G);

        return y;
    }

    inline float apply4Pole(float sample, float g)
    {
        float g1 = fastTanf(g * sampleRateInv * pi); // OctOBX perf: was (float)tan()
        g = g1;

        float lpc = g / (1.f + g);
        float y0 = resolveFeedback4Pole(sample, g, lpc);

        // first lowpass in the cascade
        double v = (y0 - state.pole1) * lpc;
        double res = v + state.pole1;

        state.pole1 = res + v;

        // damping
        state.pole1 = fastAtanf(state.pole1 * state.resCorrection) * state.resCorrectionInv; // OctOBX perf: was atan()

        float goveroneplusg = g / (1.f + g);
        float y1 = res;
        float y2 = tpt_process_scaled_cutoff(state.pole2, y1, goveroneplusg);
        float y3 = tpt_process_scaled_cutoff(state.pole3, y2, goveroneplusg);
        float y4 = tpt_process_scaled_cutoff(state.pole4, y3, goveroneplusg);
        float out;

        if (par.xpander4Pole)
        {
            out = (y0 * poleMixFactors[par.xpanderMode][0]) +
                  (y1 * poleMixFactors[par.xpanderMode][1]) +
                  (y2 * poleMixFactors[par.xpanderMode][2]) +
                  (y3 * poleMixFactors[par.xpanderMode][3]) +
                  (y4 * poleMixFactors[par.xpanderMode][4]);
        }
        else
        {
            switch (state.multimodePole)
            {
            case 0:
                out = ((1.f - state.multimodeXfade) * y4 + (state.multimodeXfade * y3));
                break;
            case 1:
                out = ((1.f - state.multimodeXfade) * y3 + (state.multimodeXfade * y2));
                break;
            case 2:
                out = ((1.f - state.multimodeXfade) * y2 + (state.multimodeXfade * y1));
                break;
            case 3:
                out = y1;
                break;
            default:
                out = 0.f;
                break;
            }
        }

        // half volume compensation
        return out * (1.f + state.res4Pole * 0.45f);
    }
};

#endif // OBXF_SRC_ENGINE_FILTER_H

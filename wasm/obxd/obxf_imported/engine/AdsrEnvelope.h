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

#ifndef OBXF_SRC_ENGINE_ADSRENVELOPE_H
#define OBXF_SRC_ENGINE_ADSRENVELOPE_H

class ADSREnvelope
{
  public:
    // See https://github.com/surge-synthesizer/OB-Xf/issues/116#issuecomment-2981640815
    // for a discussion of these. Basically atkCoefStart is fixed, atkCoefEnd is an overshoot
    // speed factor, with 1 being no overshoot speed, and atkValueEnd is the distance from
    // 1.0 before an attack ends. The difference between atkCoefStart and atkValueEnd
    // creates a timing mismatch. Also see scripts/attacksim.py for how I noodled with
    // this
    static constexpr float atkCoefStart{0.001f}, atkCoefEnd{1.3f}, atkValueEnd{0.1f};
    static constexpr float atkTimeAdjustment{1.f / 3.f};
    static constexpr float msToSec{0.001f};
    static constexpr float defaultTime{0.0001f}, defaultLevel{1.f};

  private:
    enum State
    {
        Attack = 1,
        Decay = 2,
        Sustain = 3,
        Release = 4,
        Silent = 5
    } state{Silent};

    // clang-format off
    struct Parameters
    {
        float a{defaultTime};
        float d{defaultTime};
        float s{defaultLevel};
        float r{defaultTime};
    } orig,   // parameter values before adding the slop offset
      offset, // well this should be self explanatory
      par;    // final parameter values (orig + offset)
    // clang-format on

    float coef{0.f};
    float coefLin{0.f};
    float output{0.f};
    float outputLin{0.f};
    float sampleRate{1.f};
    float offsetFactor{1.f};

    float attackCurve{0.f}; // 0 == exp, 1 == lin

    // OctOBX perf: memo for the per-sample applyMatrix*() calls. Voice.h
    // invokes applyMatrixAttack/Release four times per voice per sample;
    // without the memo every call re-runs updateAttackCoeff() -- two double
    // log()s -- while the voice is in Attack/Release, which showed up as CPU
    // spikes on every note-on. With constant inputs (the common case: no
    // matrix rows modulating the envelopes) the early-out skips all of it.
    bool mtxAtkValid{false}, mtxRelValid{false};
    float mtxAtkMs{0.f}, mtxAtkOf{0.f}, mtxRelMs{0.f}, mtxRelOf{0.f};

  public:
    ADSREnvelope() {}

    void ResetEnvelopeState()
    {
        output = 0.0f;
        outputLin = 0.0f;
        state = State::Silent;
    }

    void setSampleRate(float sr) { sampleRate = sr; }

    void setEnvOffsets(float v)
    {
        offsetFactor = v;

        setAttack(orig.a);
        setDecay(orig.d);
        setSustain(orig.s);
        setRelease(orig.r);
    }

    void setAttackCurve(float c) { attackCurve = c; }

    void setAttack(float a)
    {
        orig.a = a;
        offset.a = a / atkTimeAdjustment;
        par.a = a * offsetFactor / atkTimeAdjustment;
        mtxAtkValid = false; // OctOBX perf: par.a rewritten from orig

        if (state == State::Attack)
        {
            updateAttackCoeff();
        }
    }

    void setDecay(float d)
    {
        orig.d = d;
        offset.d = d;
        par.d = d * offsetFactor;

        if (state == State::Decay)
        {
            coef = static_cast<float>((log(std::min(par.s + 0.0001, 0.99)) - log(1.0)) /
                                      (sampleRate * par.d * msToSec));
        }
    }

    void setSustain(float s)
    {
        orig.s = s;
        offset.s = s;
        par.s = s;

        if (state == State::Decay)
        {
            coef = static_cast<float>((log(std::min(par.s + 0.0001, 0.99)) - log(1.0)) /
                                      (sampleRate * par.d * msToSec));
        }
    }

    void setRelease(float r)
    {
        orig.r = r;
        offset.r = r;
        par.r = r * offsetFactor;
        mtxRelValid = false; // OctOBX perf: par.r rewritten from orig

        if (state == State::Release)
        {
            coef = static_cast<float>((log(0.00001) - log(output + 0.0001)) /
                                      (sampleRate * par.r * msToSec));
        }
    }

    /* Apply a matrix-driven attack time without touching orig.a.
     * Safe to call every sample — does not interfere with setEnvOffsets().
     * OctOBX perf: memoized — no-ops when (ms, offsetFactor) are unchanged
     * since the last call (the per-sample constant case). */
    void applyMatrixAttack(float ms)
    {
        if (mtxAtkValid && ms == mtxAtkMs && offsetFactor == mtxAtkOf)
            return;
        mtxAtkValid = true;
        mtxAtkMs = ms;
        mtxAtkOf = offsetFactor;

        par.a = ms * offsetFactor / atkTimeAdjustment;
        if (state == State::Attack)
            updateAttackCoeff();
    }

    /* Apply a matrix-driven release time without touching orig.r.
     * OctOBX perf: memoized the same way as applyMatrixAttack. */
    void applyMatrixRelease(float ms)
    {
        if (mtxRelValid && ms == mtxRelMs && offsetFactor == mtxRelOf)
            return;
        mtxRelValid = true;
        mtxRelMs = ms;
        mtxRelOf = offsetFactor;

        par.r = ms * offsetFactor;
        if (state == State::Release)
            coef = static_cast<float>((log(0.00001) - log(output + 0.0001)) /
                                      (sampleRate * par.r * msToSec));
    }

    void triggerAttack()
    {
        state = State::Attack;

        updateAttackCoeff();

        // we need to calculate output lin
        // current = (1 - attackCurve) * output + attackCurve * outputLin;
        // both positive and less than 1
        // but we also know output = 1 - e^-coef t = and outputLin = coefLin t;
        // so
        // current = (1-a) * (1 - e^(-coef t)) + a * coefLin t
        // this can only be solved numerically. So lets approximate it
        // From the atksim python script we know on average the exp value is
        // 1.6 times the linear value. So give 1.6/2.6 of the value to exp and 1/2.6 to lin
        if (output != 0)
        {
            auto co = output;
            auto fudgeE = 1.6 / 2.6;
            auto fudgeL = 1 / 2.6;

            // now co = (1-a) * fudgeE * x + a * fudgeL * x
            // x = co / ((1-x)*fudgeE + a * fudgeL)
            auto a = attackCurve;
            auto x = co / ((1 - a) * fudgeE + a * fudgeL);
            output = fudgeE * x;
            outputLin = fudgeL * x;
        }
        else
        {
            outputLin = 0.f;
        }
    }

    void updateAttackCoeff()
    {
        /* OctOBX perf: the original computed log(atkCoefStart) - log(atkCoefEnd)
         * and log(atkValueEnd) / log(atkCoefStart) here. All three inputs are
         * compile-time constants, so the log results are too:
         *   ln(0.001f / 1.3f)  = -7.17011954e+0
         *   ln(0.1f) / ln(0.001f) = 1/3 (exactly, in float)
         * updateAttackCoeff() runs per-sample during Attack when the matrix
         * modulates attack time; folding the logs removed two double log()
         * calls from that path. */
        static constexpr float atkLogRatio{-7.17011954e+0f};
        static constexpr float atkExpRate{0.333333333f};

        coef = atkLogRatio / (sampleRate * par.a * msToSec);

        auto expRate = atkExpRate;
        auto expTime = par.a * expRate;
        auto linSamp = (1.0 - expRate * atkValueEnd) * expTime * sampleRate * msToSec;

        coefLin = (1 - atkValueEnd) / linSamp;
    }

    void triggerRelease()
    {
        if (state == State::Attack)
        {
            auto to = (1 - attackCurve) * output + attackCurve * outputLin;
            output = std::min(to, 0.99f);
        }

        if (state != State::Release)
        {
            coef = static_cast<float>((log(0.00001) - log(output + 0.0001)) /
                                      (sampleRate * par.r * msToSec));
        }

        state = State::Release;
    }

    inline bool isActive() { return state != State::Silent; }

    inline bool isGated() { return state != State::Silent && state != State::Release; }

    inline float processSample()
    {
        // we can't just return 'output' anymore because of the expoential vs linear attack phase,
        // so have a local result that the stages then set up
        float result = output;

        switch (state)
        {
        case State::Attack:
            if (output - 1.f > -atkValueEnd)
            {
                auto to = (1 - attackCurve) * output + attackCurve * outputLin;
                output = std::min(to, 0.99f);
                state = State::Decay;
                coef = static_cast<float>((log(std::min(par.s + 0.0001, 0.99)) - log(1.0)) /
                                          (sampleRate * par.d * msToSec));
                goto dec;
            }
            else
            {
                output = output - (1.f - output) * coef;
                outputLin += coefLin;
                result = (1 - attackCurve) * output + attackCurve * outputLin;
            }
            break;
        case State::Decay:
        dec:
            if (output - par.s < 10e-6f)
            {
                state = State::Sustain;
            }
            else
            {
                output = output + output * coef;
                result = output;
            }
            break;
        case State::Sustain:
            output = std::min(par.s, 0.9f);
            result = output;
            break;
        case State::Release:
            if (output > 20e-6f)
            {
                output = output + (output * coef) + dc;
                result = output;
            }
            else
                state = State::Silent;
            break;
        case State::Silent:
            output = 0.f;
            result = output;
            break;
        }

        return result;
    }
};

#endif // OBXF_SRC_ENGINE_ADSRENVELOPE_H

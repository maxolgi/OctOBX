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

#ifndef OBXF_SRC_ENGINE_MOTHERBOARD_H
#define OBXF_SRC_ENGINE_MOTHERBOARD_H

#include <climits>
#include <Constants.h>
#include "VoiceQueue.h"
#include "SynthEngine.h"
#include "Lfo.h"
#include "Tuning.h"
#include "VoiceMatrix.h"

static constexpr bool ECO_MODE = true;

class Motherboard
{
  private:
    Decimator17 left, right;

    VoiceQueue voiceQueue;
    int lastAllocatedIdx{-1};

    int totalVoiceCount{MAX_VOICES};
    int unisonVoiceCount{MAX_PANNINGS};
    bool wasUnisonSet{false};
    int stolenVoicesOnMIDIKey[129]{0};
    int8_t stolenVoicesChannelForMIDIKey[129]{0};
    int voiceAgeForPriority[129]{0};

    int asPlayedCounter{0};
    float sampleRate{1.f};
    float sampleRateInv{1.f};

    // JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Motherboard)

  public:
    Tuning tuning;
    Voice voices[MAX_VOICES];
    LFO globalLFO, vibratoLFO;

    inline int getTotalVoiceCount() const { return totalVoiceCount; }

    enum VoicePriority
    {
        LATEST,
        HIGHEST,
        LOWEST
    } voicePriority{LATEST};

    float vibratoAmount{0.f};
    float volume{0.f};
    float pannings[MAX_PANNINGS];
    bool anySounding{false};
    bool unison{false};
    bool oversample{false};
    bool reallocate{false};
    bool mpeEnabled{false};
    int mpePitchBendRange{48};

    VoiceMatrix voiceMatrix;

    std::array<int32_t, 128> debugNoteOn{}, debugNoteOff{};

    // ── OctOBX PCM sample bank ────────────────────────────────────
    struct PcmLayerDef {
        float* data{nullptr};
        int    len{0};
        float  gain{3.f};
        float  cutoff{1.f};       // normalized 0..1 (same space as processFilterCutoff)
        float  resonance{0.f};    // normalized 0..1
        float  filterMode{0.f};   // normalized 0..1
        float  ampAtt{0.f};       // normalized 0..1 (logsc'd at assignment)
        float  ampDec{0.3f};
        float  ampSus{1.f};
        float  ampRel{0.3f};
        float  pan{0.5f};
        float  pitch{1.f};        // playback rate multiplier (1.0 = original)
    };
    PcmLayerDef pcmBank[8][4];           // 8 pads × 4 layers
    int   pcmNoteToPad[128];             // MIDI note → pad index (-1 = none)
    int   pcmLayerCount[8]{};            // active layers per pad (0 = pad is PCM-off)
    int   pcmChokeGroup[8]{};            // -1 = none, 0..7 = choke group
    // ── OctOBX PCM: single-voice override — when set, ForEachVoice stamps only this voice ──
    Voice* pcmVoiceOverride{nullptr};
    // ───────────────────────────────────────────────────────────────────────────────────────
    // ──────────────────────────────────────────────────────────────────────

    Motherboard() : left(), right()
    {
        for (int i = 0; i < 129; i++)
        {
            stolenVoicesOnMIDIKey[i] = 0;
            stolenVoicesChannelForMIDIKey[i] = 0;
            voiceAgeForPriority[i] = 0;
        }

        // OctOBX PCM: default note map = unmapped, choke groups = none
        for (int i = 0; i < 128; i++)
            pcmNoteToPad[i] = -1;
        for (int i = 0; i < 8; i++)
            pcmChokeGroup[i] = -1;

        globalLFO = LFO();
        vibratoLFO = LFO();

        vibratoLFO.par.wave1blend = -1.f; // pure sine wave
        vibratoLFO.par.unipolarPulse = true;

        voiceQueue = VoiceQueue(MAX_VOICES, voices);

        for (int i = 0; i < MAX_PANNINGS; ++i)
        {
            pannings[i] = 0.5f;
        }

        for (int i = 0; i < MAX_VOICES; i++)
        {
            voices[i].initTuning(&tuning);
            voices[i].voiceIndex = i;
        }
    }

    ~Motherboard() {}

    void setPolyphony(int count)
    {
        auto newCount = std::min(count, MAX_VOICES);

        if (newCount != totalVoiceCount)
        {
            totalVoiceCount = newCount;

            resetVoiceQueueCount();

            lastAllocatedIdx = -1;
        }
    }

    void setUnisonVoices(int count)
    {
        auto newCount = std::min(count, MAX_VOICES);

        if (newCount != unisonVoiceCount)
        {
            unisonVoiceCount = newCount;

            resetVoiceQueueCount();

            lastAllocatedIdx = -1;
        }
    }

    void resetVoiceQueueCount()
    {
        auto count = std::min(totalVoiceCount, MAX_VOICES);

        for (int i = count; i < MAX_VOICES; i++)
        {
            voices[i].NoteOff(0.f);
            voices[i].ResetEnvelope();
        }

        voiceQueue.reInit(count);
        totalVoiceCount = count;
    }

    void unisonChanged() { resetVoiceQueueCount(); }

    void setSampleRate(float sr)
    {
        sampleRate = sr;
        sampleRateInv = 1.f / sampleRate;

        globalLFO.setSampleRate(sr);
        vibratoLFO.setSampleRate(sr);

        for (int i = 0; i < MAX_VOICES; ++i)
        {
            voices[i].setSampleRate(sr);
        }

        // always execute this when setting SR for the motherboard
        // see GitHub issue #269
        SetHQMode(oversample, true);
    }

    bool isSustainOn{false};
    void sustainOn()
    {
        isSustainOn = true;
        for (int i = 0; i < MAX_VOICES; i++)
        {
            Voice *p = voiceQueue.getNext();

            p->sustOn();
        }
    }

    void sustainOff()
    {
        isSustainOn = false;
        for (int i = 0; i < MAX_VOICES; i++)
        {
            Voice *p = voiceQueue.getNext();

            p->sustOff();
        }
    }

    void dumpVoiceStatus(const std::string &reason)
    {
        OBLOG(voiceManager, "Dumping voice status: " << reason);
        if constexpr (obxf_log::voiceManager)
        {
            std::ostringstream vposs;

            vposs << "Voice State: mode=";
            switch (voicePriority)
            {
            case LATEST:
                vposs << "latest";
                break;
            case HIGHEST:
                vposs << "highest";
                break;
            case LOWEST:
                vposs << "lowest";
                break;
            }

            OBLOG(voiceManager, vposs.str());

            for (int i = 0; i < totalVoiceCount; i++)
            {
                Voice *p = voiceQueue.getNext();

                if (p->isSounding())
                {
                    OBLOG(voiceManager,
                          "  idx=" << p->voiceIndex << " active " << p->midiNote
                                   << " prio=" << voiceAgeForPriority[p->midiNote]
                                   << " snd=" << p->isSounding() << " gt=" << p->isGated()
                                   << " sus=" << p->isGatedWithSustain() << " on/off "
                                   << debugNoteOn[p->midiNote] << "/" << debugNoteOff[p->midiNote]);
                }
            }

            std::ostringstream oss;

            oss << "  Held Unsounding Keys: ";

            for (int i = 0; i < 129; i++)
            {
                if (stolenVoicesOnMIDIKey[i])
                {
                    oss << i << "->" << stolenVoicesOnMIDIKey[i] << " ";
                }
            }

            OBLOG(voiceManager, oss.str());
        }
    }

    /*
     * THe voice allocator schedule is pretty easy
     * voicePerKey = (unison pressed ? voicesPerKey : 1)
     * each key press triggers min(poly, voicesPerKey) voices stealing from playing
     * But on lowest / highest mode we only play if voices are avaiable and we are
     * lower/higher than them
     */

    int voicesPerKey() const { return std::min(unison ? unisonVoiceCount : 1, totalVoiceCount); }

    int voicesUsed()
    {
        int va{0};

        for (int i = 0; i < totalVoiceCount; i++)
        {
            Voice *p = voiceQueue.getNext();

            if (p->isGated())
            {
                va++;
            }
        }

        OBLOG(voiceManager, "Voices used: " << va);
        return va;
    }

    int voicesAvailable() { return totalVoiceCount - voicesUsed(); }

    Voice *nextVoiceToBeStolen()
    {
        Voice *res{nullptr};

        switch (voicePriority)
        {
        case LATEST:
        {
            int minPriority = INT_MAX;

            for (int i = 0; i < totalVoiceCount; i++)
            {
                Voice *p = voiceQueue.getNext();

                if (p->isGated() && voiceAgeForPriority[p->midiNote] < minPriority)
                {
                    minPriority = voiceAgeForPriority[p->midiNote];
                    res = p;
                }
            }
        }
        break;
        case LOWEST:
        {
            // Steal the highest playing voice
            int mkey{-1};

            for (int i = 0; i < totalVoiceCount; i++)
            {
                Voice *p = voiceQueue.getNext();

                if (p->isGated() && p->midiNote > mkey)
                {
                    res = p;
                    mkey = p->midiNote;
                }
            }
        }
        break;
        case HIGHEST:
        {
            // Steal the lowest playing voice
            int mkey{128};

            for (int i = 0; i < totalVoiceCount; i++)
            {
                Voice *p = voiceQueue.getNext();

                if (p->isGated() && p->midiNote < mkey)
                {
                    res = p;
                    mkey = p->midiNote;
                }
            }
        }
        break;
        }
        return res;
    }

    int nextMidiKeyToRealloc()
    {
        int res{-1};

        switch (voicePriority)
        {
        case LATEST:
        {
            int maxPriority = INT_MIN;

            for (int i = 0; i < 129; i++)
            {
                if (stolenVoicesOnMIDIKey[i] > 0 && voiceAgeForPriority[i] > maxPriority)
                {
                    maxPriority = voiceAgeForPriority[i];
                    res = i;
                }
            }
        }
        break;
        case LOWEST:
        {
            // Find the lowest note with a stolen voice
            for (int i = 0; i < 129; i++)
            {
                if (stolenVoicesOnMIDIKey[i] > 0)
                {
                    return i;
                }
            }
        }
        break;
        case HIGHEST:
        {
            // Find the highest note with a stolen voice
            for (int i = 128; i >= 0; i--)
            {
                if (stolenVoicesOnMIDIKey[i] > 0)
                {
                    return i;
                }
            }
        }
        break;
        }
        return res;
    }

    bool shouldGivenKeySteal(int note)
    {
        switch (voicePriority)
        {
        case LATEST:
            return true;
        case LOWEST:
            // Am I lower than the lowest active note
            {
                auto shouldSteal{true};

                for (int i = 0; i < totalVoiceCount; i++)
                {
                    Voice *p = voiceQueue.getNext();

                    if (p->isGated())
                    {
                        shouldSteal = shouldSteal && note < p->midiNote;
                    }
                }

                return shouldSteal;
            }
            break;
        case HIGHEST:
            // Am I higher than the highest active note
            {
                auto shouldSteal{true};

                for (int i = 0; i < totalVoiceCount; i++)
                {
                    Voice *p = voiceQueue.getNext();

                    if (p->isGated())
                    {
                        shouldSteal = shouldSteal && note > p->midiNote;
                    }
                }

                return shouldSteal;
            }
            break;
        }
        return false;
    }

    // ── OctOBX PCM: assign a specific pad/layer to a voice (independent synth chain) ──
    void assignPcmLayer(Voice* v, int pad, int layer)
    {
        if (pad < 0 || pad >= 8 || layer < 0 || layer >= 4) { v->pcmActive = false; return; }
        auto& L = pcmBank[pad][layer];

        v->pcmActive = true;
        v->pcmData = L.data;
        v->pcmLen = L.len;
        v->pcmPos = 0.f;
        v->pcmGain = L.gain;
        v->pcmPan = L.pan;
        v->pcmRate = L.pitch;
        v->pcmChokeGroup = pcmChokeGroup[pad];
        v->pcmPadId = pad;
        v->pcmLayerId = layer;       // OctOBX PCM: remember layer for full-param application
        v->pcmNeedsParams = true;    // OctOBX PCM: main_obxd applies the layer's params next

        // OctOBX PCM: independent filter params (NOT overwritten by SynthEngine — see pcmActive guard)
        v->par.filter.cutoff = L.cutoff * 120.f;  // linsc(cutoff, 0, 120)
        v->filter.setResonance(0.991f - logsc(1.f - L.resonance, 0.f, 0.991f, 40.f));
        v->filter.setMultimode(L.filterMode);

        // OctOBX PCM: independent amp envelope
        v->ampEnv.setAttack(logsc(L.ampAtt, 4.f, 60000.f, 900.f));
        v->ampEnv.setDecay(logsc(L.ampDec, 4.f, 60000.f, 900.f));
        v->ampEnv.setSustain(L.ampSus);
        v->ampEnv.setRelease(logsc(L.ampRel, 8.f, 60000.f, 900.f));
    }
    // ─────────────────────────────────────────────────────────────────────────────────

    void setNoteOn(int note, float velocity, int8_t channel)
    {
        anySounding = true;
        debugNoteOn[note]++;

        // This played note has the highest as-played priority
        voiceAgeForPriority[note] = asPlayedCounter++;

        // ── OctOBX PCM: layered sampler — all enabled layers trigger at once ──
        int pcmPad = (note >= 0 && note < 128) ? pcmNoteToPad[note] : -1;
        if (pcmPad >= 0 && pcmLayerCount[pcmPad] > 0)
        {
            // OctOBX PCM: Choke — cut voices in the same group belonging to OTHER pads
            if (pcmChokeGroup[pcmPad] >= 0)
            {
                for (int j = 0; j < totalVoiceCount; j++)
                {
                    if (voices[j].isSounding() && voices[j].pcmChokeGroup == pcmChokeGroup[pcmPad]
                        && voices[j].pcmPadId != pcmPad)
                    {
                        voices[j].NoteOff(0.f);
                    }
                }
            }

            int pcmNeeded = std::min(pcmLayerCount[pcmPad], totalVoiceCount);
            int pcmLayerIdx = 0;

            // OctOBX PCM: Pass 1 — use free (non-gated) voices
            for (int i = 0; i < totalVoiceCount && pcmNeeded > 0; i++)
            {
                Voice* v = voiceQueue.getNext();
                if (!v->isGated())
                {
                    v->NoteOn(note, velocity, channel);
                    recalculateMatrix(voiceMatrix, v->matrixSourceValues, v->matrixAdjustments);
                    assignPcmLayer(v, pcmPad, pcmLayerIdx++);
                    lastAllocatedIdx = v->voiceIndex;
                    pcmNeeded--;
                }
            }

            // OctOBX PCM: Pass 2 — steal oldest sounding voices (chosen voice-starve policy)
            while (pcmNeeded > 0)
            {
                Voice* v = nextVoiceToBeStolen();
                if (!v) break;
                v->NoteOn(note, velocity, channel);
                recalculateMatrix(voiceMatrix, v->matrixSourceValues, v->matrixAdjustments);
                assignPcmLayer(v, pcmPad, pcmLayerIdx++);
                pcmNeeded--;
            }

            dumpVoiceStatus("NoteOn");
            return;
        }
        // ─────────────────────────────────────────────────────────────────────────────

        // And toggle on unison if it was off
        if (wasUnisonSet != unison)
        {
            unisonChanged();
        }

        auto voicesNeeded = voicesPerKey();
        auto vAvail = voicesAvailable();
        bool should = shouldGivenKeySteal(note);

        OBLOG(voiceManager, "NoteOn: " << note << " vAvail=" << vAvail << " voicesNeeded="
                                       << voicesNeeded << " shouldSteal=" << should);

        // First thing - am I actively playing on this key?
        for (int i = 0; i < totalVoiceCount; i++)
        {
            Voice *v = voiceQueue.getNext();

            if (v->midiNote == note && (!mpeEnabled || v->channel == channel) && v->isGated() &&
                voicesNeeded > 0)
            {
                v->NoteOn(note, velocity, channel);
                recalculateMatrix(voiceMatrix, v->matrixSourceValues, v->matrixAdjustments);
                voicesNeeded--;
            }
        }

        // reallocate voices played by same keys, as opposed to always round-robin
        if (reallocate && voicesNeeded > 0)
        {
            for (int i = 0; i < totalVoiceCount; i++)
            {
                if (voices[i].midiNote == note && voicesNeeded > 0)
                {
                    voices[i].NoteOn(note, velocity, channel);
                    recalculateMatrix(voiceMatrix, voices[i].matrixSourceValues,
                                      voices[i].matrixAdjustments);
                    lastAllocatedIdx = i;
                    voicesNeeded--;
                }
            }
        }

        // Go do some voice stealing!
        while (should && voicesNeeded > vAvail)
        {
            auto voicesToSteal = voicesNeeded;

            // Doing this as multiple passes is a bit time-inefficient,
            // but it helps a lot in the partial steal by oldest case etc
            for (int i = 0; i < voicesToSteal; i++)
            {
                auto v = nextVoiceToBeStolen();

                stolenVoicesOnMIDIKey[v->midiNote]++;
                stolenVoicesChannelForMIDIKey[v->midiNote] = v->channel;

                v->NoteOn(note, velocity, channel);
                recalculateMatrix(voiceMatrix, v->matrixSourceValues, v->matrixAdjustments);
                voicesNeeded--;

                break;
            }
        }

        if (!should && voicesNeeded > vAvail)
        {
            stolenVoicesOnMIDIKey[note] += voicesNeeded - vAvail;
            voicesNeeded = vAvail;
        }

        if (voicesNeeded && voicesNeeded <= vAvail)
        {
            voiceQueue.setIdx(lastAllocatedIdx);

            // Super simple - just start the voices if they are there.
            // If there aren't enough, we just won't start them
            for (int i = 0; i < totalVoiceCount; i++)
            {
                Voice *v = voiceQueue.getNext();

                if (!v->isGated())
                {
                    v->NoteOn(note, velocity, channel);
                    recalculateMatrix(voiceMatrix, v->matrixSourceValues, v->matrixAdjustments);
                    lastAllocatedIdx = v->voiceIndex;
                    voicesNeeded--;

                    if (voicesNeeded == 0)
                    {
                        break;
                    }
                }
            }
        }

        dumpVoiceStatus("NoteOn");
    }

    void setNoteOff(int note, float velocity, int8_t channel)
    {
        debugNoteOff[note]++;

        auto newVoices = voicesPerKey();

        // Start by reallocating voices
        auto mk = nextMidiKeyToRealloc();

        OBLOG(voiceManager, "NoteOff: " << note << " newv=" << newVoices << " nextMK=" << mk);

        // mk == note: this note is itself the top stolen key, release it directly
        // mk ==   -1: no stolen keys exist, nothing to realloc — release directly
        if (mk == note || mk == -1)
        {
            for (int i = 0; i < totalVoiceCount; i++)
            {
                Voice *v = voiceQueue.getNext();

                if (v->midiNote == note && (!mpeEnabled || v->channel == channel))
                {
                    v->NoteOff(velocity);
                    recalculateMatrix(voiceMatrix, v->matrixSourceValues, v->matrixAdjustments);
                }
            }

            stolenVoicesOnMIDIKey[note] = 0;
        }

        // and then find the next next key to release
        mk = nextMidiKeyToRealloc();

        while (newVoices > 0 && mk != -1) // don't realloc myself! just stop.
        {
            for (int i = 0; i < totalVoiceCount; i++)
            {
                Voice *p = voiceQueue.getNext();

                if (p->midiNote == note && p->isGated() && !p->pcmActive)
                {
                    p->NoteOn(mk, Voice::reuseVelocitySentinel,
                              mpeEnabled ? stolenVoicesChannelForMIDIKey[mk] : p->channel);
                    recalculateMatrix(voiceMatrix, p->matrixSourceValues, p->matrixAdjustments);
                    stolenVoicesOnMIDIKey[mk]--;

                    break;
                }
            }

            mk = nextMidiKeyToRealloc();
            newVoices--;

            dumpVoiceStatus("Note Off");
        }

        // We've released this key so if we do have stolen voices we don't want to bring them back
        stolenVoicesOnMIDIKey[note] = 0;

        // And if anything is still sounding on this key after the steal, kill it
        for (int i = 0; i < totalVoiceCount; i++)
        {
            Voice *v = voiceQueue.getNext();

            if (v->midiNote == note && (!mpeEnabled || v->channel == channel))
            {
                v->NoteOff(velocity);
                recalculateMatrix(voiceMatrix, v->matrixSourceValues, v->matrixAdjustments);
            }
        }

        dumpVoiceStatus("Note Off (2)");
    }

    void processMPEPitch(int8_t channel, float pitchBendValue)
    {
        // pitchBendValue is -1..1 representing mpePitchBendRange. Scale to semitones with the range
        const float scaled = pitchBendValue * mpePitchBendRange;
        for (int i = 0; i < totalVoiceCount; i++)
        {
            // isGated not isSounding since long release can reuse channels
            if ((voices[i].channel == channel || channel == -1) && voices[i].isGated())
            {
                voices[i].mpeBend = scaled;
                setMatrixSource(voices[i].matrixSourceValues, MatrixSource::Glide, pitchBendValue);
                recalculateMatrix(voiceMatrix, voices[i].matrixSourceValues,
                                  voices[i].matrixAdjustments);
            }
        }
    }

    void processMPETimbre(int8_t channel, float timbreValue)
    {
        // timbreValue is 0..1 (CC74 / 127), normalized to -1..1 for the matrix
        const float normalised = timbreValue * 2.f - 1.f;
        for (int i = 0; i < totalVoiceCount; i++)
        {
            if ((voices[i].channel == channel || channel == -1) && voices[i].isGated())
            {
                setMatrixSource(voices[i].matrixSourceValues, MatrixSource::Slide, normalised);
                recalculateMatrix(voiceMatrix, voices[i].matrixSourceValues,
                                  voices[i].matrixAdjustments);
            }
        }
    }

    void processMPEChannelPressure(int8_t channel, float pressureValue)
    {
        for (int i = 0; i < totalVoiceCount; i++)
        {
            if ((voices[i].channel == channel || channel == -1) && voices[i].isGated())
            {
                setMatrixSource(voices[i].matrixSourceValues, MatrixSource::Press, pressureValue);
                recalculateMatrix(voiceMatrix, voices[i].matrixSourceValues,
                                  voices[i].matrixAdjustments);
            }
        }
    }

    void SetHQMode(bool over, bool force = false)
    {
        if (!force && over == oversample)
        {
            return;
        }

        const auto factor = 1 + over;

        globalLFO.setSampleRate(sampleRate * factor);
        vibratoLFO.setSampleRate(sampleRate * factor);

        for (int i = 0; i < MAX_VOICES; i++)
        {
            voices[i].setSampleRate(sampleRate * factor);
            voices[i].setHQMode(over);
        }

        oversample = over;

        left.resetDecimator();
        right.resetDecimator();
    }

    inline float processSynthVoice(Voice &b, float lfo1In, float vibIn)
    {
        if (ECO_MODE)
        {
            b.updateSoundingState();
        }

        if (b.isSounding() || (!ECO_MODE))
        {
            b.lfo1In = lfo1In;
            b.vibratoLFOIn = vibIn;

            return b.ProcessSample(voiceMatrix);
        }

        return 0.f;
    }

    void processSample(float *sm1, float *sm2)
    {
        if (!anySounding)
        {
            // with nothing sounding, just update the LFO phases
            globalLFO.update(true);
            vibratoLFO.update(true);

            if (oversample)
            {
                globalLFO.update(true);
                vibratoLFO.update(true);
            }

            *sm1 = 0.f;
            *sm2 = 0.f;

            return;
        }

        globalLFO.update();
        vibratoLFO.update();

        float vl = 0, vr = 0;
        float vlo = 0, vro = 0;
        float lfovalue = globalLFO.getVal();
        float viblfo = vibratoLFO.getVal() * vibratoAmount * vibratoAmount * 4.f;
        float lfovalue2 = 0, viblfo2 = 0;

        if (oversample)
        {
            globalLFO.update();
            vibratoLFO.update();
            lfovalue2 = globalLFO.getVal();
            viblfo2 = vibratoLFO.getVal() * vibratoAmount * vibratoAmount * 4.f;
        }

        for (int i = 0; i < totalVoiceCount; i++)
        {
            float x1 = processSynthVoice(voices[i], lfovalue, viblfo);

            if (oversample)
            {
                float x2 = processSynthVoice(voices[i], lfovalue2, viblfo2);

                // OctOBX PCM: per-voice pan override
                float pcmPan_i = voices[i].pcmActive ? voices[i].pcmPan : pannings[i % MAX_PANNINGS];
                vlo += x2 * (1 - pcmPan_i);
                vro += x2 * (pcmPan_i);
            }

            // OctOBX PCM: per-voice pan override
            float pcmPan_i = voices[i].pcmActive ? voices[i].pcmPan : pannings[i % MAX_PANNINGS];
            vl += x1 * (1 - pcmPan_i);
            vr += x1 * (pcmPan_i);
        }

        if (oversample)
        {
            vl = left.decimate(vl, vlo);
            vr = right.decimate(vr, vro);
        }

        *sm1 = vl * volume;
        *sm2 = vr * volume;

        // check if we're still sounding
        bool stillSounding = false;

        for (int i = 0; i < totalVoiceCount && !stillSounding; ++i)
        {
            stillSounding = voices[i].isSounding();
        }

        anySounding = stillSounding;
    }
};

#endif // OBXF_SRC_ENGINE_MOTHERBOARD_H

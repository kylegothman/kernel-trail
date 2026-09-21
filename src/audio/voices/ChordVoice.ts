/**
 * The pumped saw chord, WP-25 section 3, and the bass. Two detuned sawtooth
 * oscillators through a resonant low-pass whose cutoff the note sets and may
 * sweep, then through a duck gain the side-chain pulls down on every kick.
 * One voice is one chord tone; the sequencer plays a chord as two voices at
 * low tier (the guide tones) and four at medium and high. The bass is the
 * same voice an octave down with no detune and a low cutoff.
 */
import type { BiquadLike, GainLike, OscillatorLike } from '../context';
import { applyAttack, applyOneShot, type Adsr } from '../synth/envelope';
import { clampHz, sweepHz } from '../synth/filters';
import type { Sidechain } from '../synth/sidechain';
import { Voice, type VoiceHost, type VoiceParams } from './Voice';

export const CHORD_ADSR: Adsr = { attack: 0.012, decay: 0.15, sustain: 0.8, release: 0.22 };

export class ChordVoice extends Voice {
  readonly kind = 'chord' as const;
  private readonly oscA: OscillatorLike;
  private readonly oscB: OscillatorLike;
  private readonly filter: BiquadLike;
  private readonly duck: GainLike;

  constructor(host: VoiceHost, sidechain: Sidechain) {
    super(host);
    const ctx = host.ctx;
    this.oscA = this.trackSource(ctx.createOscillator());
    this.oscB = this.trackSource(ctx.createOscillator());
    this.oscA.type = 'sawtooth';
    this.oscB.type = 'sawtooth';
    this.filter = this.track(ctx.createBiquadFilter());
    this.filter.type = 'lowpass';
    this.filter.Q.value = 2;
    this.duck = this.track(ctx.createGain());
    this.duck.gain.value = 1;
    this.oscA.connect(this.filter);
    this.oscB.connect(this.filter);
    this.filter.connect(this.duck);
    this.duck.connect(this.out);
    sidechain.register(this.duck.gain);
  }

  /** The side-chain's handle, exposed so a test can read the pump it was given. */
  get duckParam(): GainLike['gain'] {
    return this.duck.gain;
  }

  get filterParam(): BiquadLike['frequency'] {
    return this.filter.frequency;
  }

  start(when: number, params: VoiceParams): void {
    this.begin(when, params);
    const hz = clampHz(params.hz ?? 220);
    this.oscA.frequency.cancelScheduledValues(when);
    this.oscA.frequency.setValueAtTime(hz, when);
    this.oscB.frequency.cancelScheduledValues(when);
    this.oscB.frequency.setValueAtTime(hz, when);
    this.oscB.detune.setValueAtTime(params.detuneCents ?? 7, when);
    const adsr = params.adsr ?? CHORD_ADSR;
    const scale = this.host.envelopeScale;
    const gain = params.gain ?? 0.25;
    const cutoff = clampHz(params.filterHz ?? hz * 6);
    this.filter.Q.setValueAtTime(params.q ?? 2, when);
    if (params.filterEndHz !== undefined && params.hold !== undefined) {
      // The cutoff opens or closes across the note's sounding length.
      const seconds = (adsr.attack + adsr.decay) * scale + params.hold;
      sweepHz(this.filter.frequency, cutoff, clampHz(params.filterEndHz), when, seconds);
    } else {
      this.filter.frequency.cancelScheduledValues(when);
      this.filter.frequency.setValueAtTime(cutoff, when);
    }
    this.releaseSeconds = adsr.release;
    if (params.hold === undefined) {
      this.sustainLevel = applyAttack(this.out.gain, when, adsr, gain, scale);
    } else {
      this.sustainLevel = Math.max(1e-4, gain * adsr.sustain);
      this.finishAt = applyOneShot(this.out.gain, when, adsr, gain, params.hold, scale);
    }
  }
}

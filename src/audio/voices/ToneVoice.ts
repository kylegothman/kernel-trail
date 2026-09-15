/**
 * Pitched cues: dispatch, acquire, grant, clicks. Two oscillators through a
 * lowpass and an envelope. Package section 4.
 */
import type { BiquadLike, OscillatorLike } from '../context';
import { applyAttack, applyOneShot, type Adsr } from '../synth/envelope';
import { clampHz } from '../synth/filters';
import { Voice, type VoiceHost, type VoiceParams } from './Voice';

export const TONE_ADSR: Adsr = { attack: 0.006, decay: 0.09, sustain: 0.45, release: 0.14 };

export class ToneVoice extends Voice {
  readonly kind = 'tone' as const;
  private readonly oscA: OscillatorLike;
  private readonly oscB: OscillatorLike;
  private readonly filter: BiquadLike;

  constructor(host: VoiceHost) {
    super(host);
    const ctx = host.ctx;
    this.oscA = this.trackSource(ctx.createOscillator());
    this.oscB = this.trackSource(ctx.createOscillator());
    this.filter = this.track(ctx.createBiquadFilter());
    this.oscA.type = 'sine';
    this.oscB.type = 'triangle';
    this.filter.type = 'lowpass';
    this.oscA.connect(this.filter);
    this.oscB.connect(this.filter);
    this.filter.connect(this.out);
  }

  start(when: number, params: VoiceParams): void {
    this.begin(when, params);
    const hz = clampHz(params.hz ?? 220);
    const hz2 = clampHz(params.hz2 ?? hz);
    this.oscA.type = params.waveform ?? 'sine';
    this.schedulePitch(this.oscA.frequency, hz, when, params);
    this.schedulePitch(this.oscB.frequency, hz2, when, params);
    this.oscB.detune.setValueAtTime(params.detuneCents ?? 0, when);
    this.filter.frequency.setValueAtTime(clampHz(params.filterHz ?? hz * 4), when);
    this.filter.Q.setValueAtTime(params.q ?? 0.7, when);
    const adsr = params.adsr ?? TONE_ADSR;
    const gain = params.gain ?? 0.5;
    this.releaseSeconds = adsr.release;
    if (params.hold === undefined) {
      this.sustainLevel = applyAttack(this.out.gain, when, adsr, gain, this.host.envelopeScale);
    } else {
      this.sustainLevel = Math.max(1e-4, gain * adsr.sustain);
      this.finishAt = applyOneShot(this.out.gain, when, adsr, gain, params.hold, this.host.envelopeScale);
    }
  }

  private schedulePitch(param: OscillatorLike['frequency'], hz: number, when: number, params: VoiceParams): void {
    param.cancelScheduledValues(when);
    param.setValueAtTime(hz, when);
    if (params.glideToHz !== undefined) {
      const seconds = Math.max(0.001, (params.glideSeconds ?? 0.2) * this.host.envelopeScale);
      // A glide is an exponential pitch change, which reads as constant speed.
      param.linearRampToValueAtTime(clampHz(params.glideToHz), when + seconds);
      if (params.stepToHz !== undefined) {
        param.setValueAtTime(clampHz(params.stepToHz), when + seconds);
      }
    }
  }
}

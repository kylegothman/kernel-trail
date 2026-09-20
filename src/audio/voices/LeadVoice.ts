/**
 * The formant lead, WP-25 section 3: two detuned saws split into two
 * band-pass filters at vowel frequencies, summed with a little of the dry
 * saw for body. The vowel is a position along a fixed path from "oo" to
 * "ee", set per note and swept across it by the phrase, which is what makes
 * the motif read as a voice without being one. It is not a vocoder and does
 * not claim to be. A note may glide from the pitch this voice last played,
 * so a legato phrase on one voice slides; the allocator hands the same idle
 * voice back each time, which is what makes that memory reliable.
 */
import type { BiquadLike, GainLike, OscillatorLike } from '../context';
import { applyAttack, applyOneShot, type Adsr } from '../synth/envelope';
import { clampHz, sweepHz } from '../synth/filters';
import { Voice, type VoiceHost, type VoiceParams } from './Voice';

/** First and second formants, hertz. The path runs through them in this order. */
export const VOWEL_PATH: readonly (readonly [number, number])[] = [
  [300, 870],   // oo
  [570, 840],   // oh
  [730, 1090],  // ah
  [530, 1840],  // eh
  [270, 2290],  // ee
];

export const LEAD_ADSR: Adsr = { attack: 0.03, decay: 0.1, sustain: 0.7, release: 0.12 };

/** Formant pair at `position`, 0 to 1 along the path, interpolated between neighbours. */
export function formantsAt(position: number): readonly [number, number] {
  const x = Math.min(1, Math.max(0, Number.isFinite(position) ? position : 0)) * (VOWEL_PATH.length - 1);
  const i = Math.min(VOWEL_PATH.length - 2, Math.floor(x));
  const a = VOWEL_PATH[i];
  const b = VOWEL_PATH[i + 1];
  if (a === undefined || b === undefined) throw new Error('lead: vowel path too short');
  const t = x - i;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export class LeadVoice extends Voice {
  readonly kind = 'lead' as const;
  private readonly oscA: OscillatorLike;
  private readonly oscB: OscillatorLike;
  private readonly f1: BiquadLike;
  private readonly f2: BiquadLike;
  private readonly body: BiquadLike;
  private readonly f1Gain: GainLike;
  private readonly f2Gain: GainLike;
  private readonly bodyGain: GainLike;
  private lastHz = 0;

  constructor(host: VoiceHost) {
    super(host);
    const ctx = host.ctx;
    this.oscA = this.trackSource(ctx.createOscillator());
    this.oscB = this.trackSource(ctx.createOscillator());
    this.oscA.type = 'sawtooth';
    this.oscB.type = 'sawtooth';
    this.f1 = this.track(ctx.createBiquadFilter());
    this.f2 = this.track(ctx.createBiquadFilter());
    this.body = this.track(ctx.createBiquadFilter());
    this.f1.type = 'bandpass';
    this.f2.type = 'bandpass';
    this.body.type = 'lowpass';
    this.f1.Q.value = 6;
    this.f2.Q.value = 8;
    this.body.Q.value = 0.7;
    this.body.frequency.value = 1200;
    this.f1Gain = this.track(ctx.createGain());
    this.f2Gain = this.track(ctx.createGain());
    this.bodyGain = this.track(ctx.createGain());
    this.f1Gain.gain.value = 1;
    this.f2Gain.gain.value = 0.6;
    this.bodyGain.gain.value = 0.35;
    for (const osc of [this.oscA, this.oscB]) {
      osc.connect(this.f1);
      osc.connect(this.f2);
      osc.connect(this.body);
    }
    this.f1.connect(this.f1Gain);
    this.f2.connect(this.f2Gain);
    this.body.connect(this.bodyGain);
    this.f1Gain.connect(this.out);
    this.f2Gain.connect(this.out);
    this.bodyGain.connect(this.out);
  }

  get formantParams(): readonly [BiquadLike['frequency'], BiquadLike['frequency']] {
    return [this.f1.frequency, this.f2.frequency];
  }

  get lastPitchHz(): number {
    return this.lastHz;
  }

  start(when: number, params: VoiceParams): void {
    this.begin(when, params);
    const hz = clampHz(params.hz ?? 440);
    const scale = this.host.envelopeScale;
    const adsr = params.adsr ?? LEAD_ADSR;
    const glide = params.glideSeconds !== undefined && this.lastHz > 0 ? Math.max(0.001, params.glideSeconds * scale) : 0;
    for (const osc of [this.oscA, this.oscB]) {
      osc.frequency.cancelScheduledValues(when);
      if (glide > 0) {
        // An exponential glide from the last pitch reads as constant speed.
        sweepHz(osc.frequency, this.lastHz, hz, when, glide);
      } else {
        osc.frequency.setValueAtTime(hz, when);
      }
    }
    this.oscB.detune.setValueAtTime(params.detuneCents ?? 5, when);
    this.lastHz = hz;
    const gain = params.gain ?? 0.3;
    const hold = params.hold;
    const sounding = (adsr.attack + adsr.decay) * scale + (hold ?? 0.5);
    const from = formantsAt(params.vowel ?? 0.25);
    const to = formantsAt(params.vowelEnd ?? params.vowel ?? 0.25);
    sweepHz(this.f1.frequency, from[0], to[0], when, sounding);
    sweepHz(this.f2.frequency, from[1], to[1], when, sounding);
    this.releaseSeconds = adsr.release;
    if (hold === undefined) {
      this.sustainLevel = applyAttack(this.out.gain, when, adsr, gain, scale);
    } else {
      this.sustainLevel = Math.max(1e-4, gain * adsr.sustain);
      this.finishAt = applyOneShot(this.out.gain, when, adsr, gain, hold, scale);
    }
  }
}

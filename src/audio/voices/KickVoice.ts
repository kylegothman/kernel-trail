/**
 * The kick and the side-chain trigger, WP-25 section 3: a synthesised sine
 * drop with a click. The body is a sine whose pitch falls from 150 to 46 Hz
 * in 55 ms under a 280 ms decay; the click is twelve milliseconds of
 * band-passed noise on the transient. Both go through the soft clip for
 * weight. Every start triggers the side-chain, which is how the pad, chords
 * and bass pump against it. The percussive event cues of section 5 share
 * this transient design.
 */
import type { BiquadLike, BufferSourceLike, GainLike, OscillatorLike, WaveShaperLike } from '../context';
import { rampExp } from '../synth/envelope';
import { clampHz } from '../synth/filters';
import { MIN_EXP_TARGET } from '../synth/constants';
import type { Sidechain } from '../synth/sidechain';
import { Voice, type VoiceHost, type VoiceParams } from './Voice';

/** The kick's shape. Section 5 borrows `clickHz` and `clickSeconds` for every percussive cue. */
export const KICK = {
  startHz: 150,
  endHz: 46,
  pitchSeconds: 0.055,
  decaySeconds: 0.28,
  clickHz: 3200,
  clickQ: 1.2,
  clickSeconds: 0.012,
  clickLevel: 0.5,
} as const;

/** Seconds a kick sounds, for the allocator. */
export function kickDuration(scale = 1): number {
  return KICK.decaySeconds * scale + 0.01;
}

export class KickVoice extends Voice {
  readonly kind = 'kick' as const;
  private readonly body: OscillatorLike;
  private readonly bodyEnv: GainLike;
  private readonly click: BufferSourceLike;
  private readonly clickFilter: BiquadLike;
  private readonly clickEnv: GainLike;
  private readonly shaper: WaveShaperLike;

  constructor(host: VoiceHost, private readonly sidechain: Sidechain) {
    super(host);
    const ctx = host.ctx;
    this.body = this.trackSource(ctx.createOscillator());
    this.body.type = 'sine';
    this.bodyEnv = this.track(ctx.createGain());
    this.bodyEnv.gain.value = 0;
    this.click = this.trackSource(ctx.createBufferSource());
    this.click.buffer = host.buffers.white;
    this.click.loop = true;
    this.clickFilter = this.track(ctx.createBiquadFilter());
    this.clickFilter.type = 'bandpass';
    this.clickFilter.frequency.value = KICK.clickHz;
    this.clickFilter.Q.value = KICK.clickQ;
    this.clickEnv = this.track(ctx.createGain());
    this.clickEnv.gain.value = 0;
    this.shaper = this.track(ctx.createWaveShaper());
    this.shaper.curve = host.buffers.softClip;
    this.shaper.oversample = '2x';
    this.body.connect(this.bodyEnv);
    this.bodyEnv.connect(this.shaper);
    this.click.connect(this.clickFilter);
    this.clickFilter.connect(this.clickEnv);
    this.clickEnv.connect(this.shaper);
    this.shaper.connect(this.out);
  }

  get bodyFrequency(): OscillatorLike['frequency'] {
    return this.body.frequency;
  }

  start(when: number, params: VoiceParams): void {
    this.begin(when, params);
    const scale = this.host.envelopeScale;
    const gain = params.gain ?? 0.9;
    const pitchEnd = when + Math.max(0.005, KICK.pitchSeconds * scale);
    const decayEnd = when + Math.max(0.02, KICK.decaySeconds * scale);
    this.body.frequency.cancelScheduledValues(when);
    this.body.frequency.setValueAtTime(clampHz(KICK.startHz), when);
    rampExp(this.body.frequency, clampHz(KICK.endHz), pitchEnd);
    this.bodyEnv.gain.cancelScheduledValues(when);
    this.bodyEnv.gain.setValueAtTime(MIN_EXP_TARGET, when);
    this.bodyEnv.gain.linearRampToValueAtTime(1, when + 0.002);
    rampExp(this.bodyEnv.gain, MIN_EXP_TARGET, decayEnd);
    this.clickEnv.gain.cancelScheduledValues(when);
    this.clickEnv.gain.setValueAtTime(MIN_EXP_TARGET, when);
    this.clickEnv.gain.linearRampToValueAtTime(KICK.clickLevel, when + 0.001);
    rampExp(this.clickEnv.gain, MIN_EXP_TARGET, when + Math.max(0.003, KICK.clickSeconds * scale));
    // The output level is a static gain; the shape lives inside, as in the impact voice.
    this.out.gain.cancelScheduledValues(when);
    this.out.gain.setValueAtTime(gain, when);
    this.sustainLevel = gain;
    this.releaseSeconds = 0.03;
    this.finishAt = when + kickDuration(scale);
    this.out.gain.setValueAtTime(gain, this.finishAt);
    this.out.gain.setValueAtTime(MIN_EXP_TARGET, this.finishAt + 0.001);
    this.sidechain.trigger(when);
  }
}

/**
 * Derezz, panic, denial: a short noise burst plus a pitched-down sine thump
 * through a soft clip. The character table maps every `TerminationReason` to
 * a distinct parameter set, mirroring visual bible 9.5 beat for beat.
 */
import type { TerminationReason } from '@kernel/types';
import type { BiquadLike, BufferSourceLike, GainLike, OscillatorLike, WaveShaperLike } from '../context';
import { applyOneShot, rampExp, type Adsr } from '../synth/envelope';
import { clampHz } from '../synth/filters';
import { MIN_EXP_TARGET } from '../synth/constants';
import { Voice, type VoiceHost, type VoiceParams } from './Voice';

export interface ImpactCharacter {
  /** Lowpass on the noise burst. Higher is brighter. */
  readonly noiseHz: number;
  readonly noiseDecay: number;
  readonly thumpStartHz: number;
  readonly thumpEndHz: number;
  readonly thumpDecay: number;
  /** Seconds before the burst, for reasons whose visual has a lead beat. */
  readonly lead: number;
  readonly gain: number;
  readonly noiseMix: number;
}

/**
 * Visual bible 9.5, one row per reason. Same voice, different uniforms.
 * `normal_exit` is the reference: gentle, symmetric, complete.
 */
export const IMPACT_CHARACTER: Readonly<Record<TerminationReason, ImpactCharacter>> = {
  normal_exit: { noiseHz: 2400, noiseDecay: 0.18, thumpStartHz: 160, thumpEndHz: 48, thumpDecay: 0.32, lead: 0, gain: 0.7, noiseMix: 0.5 },
  /** A white plane sweeps first: brighter burst, short lead. */
  killed_by_user: { noiseHz: 6000, noiseDecay: 0.12, thumpStartHz: 220, thumpEndHz: 55, thumpDecay: 0.26, lead: 0.12, gain: 0.85, noiseMix: 0.7 },
  /** The parent's beam strikes first. */
  killed_by_parent: { noiseHz: 5200, noiseDecay: 0.14, thumpStartHz: 200, thumpEndHz: 50, thumpDecay: 0.28, lead: 0.09, gain: 0.8, noiseMix: 0.6 },
  /** No spike, emission already gone: dull, low, almost no burst. */
  starvation: { noiseHz: 500, noiseDecay: 0.3, thumpStartHz: 90, thumpEndHz: 30, thumpDecay: 0.6, lead: 0, gain: 0.55, noiseMix: 0.2 },
  /** The freeze mid-flight: a long thump that holds before it drops. */
  deadlock_victim: { noiseHz: 3200, noiseDecay: 0.2, thumpStartHz: 150, thumpEndHz: 40, thumpDecay: 0.45, lead: 0, gain: 0.8, noiseMix: 0.45 },
  /** Collapse inward: the thump rises instead of falling. */
  out_of_memory: { noiseHz: 1800, noiseDecay: 0.3, thumpStartHz: 60, thumpEndHz: 240, thumpDecay: 0.3, lead: 0, gain: 0.75, noiseMix: 0.35 },
  /** The ground fails first: a low rumble leads the fall. */
  thrashing_collapse: { noiseHz: 900, noiseDecay: 0.4, thumpStartHz: 120, thumpEndHz: 32, thumpDecay: 0.5, lead: 0.2, gain: 0.85, noiseMix: 0.55 },
  /** Surgical, along one plane: the brightest and shortest burst. */
  protection_fault: { noiseHz: 9000, noiseDecay: 0.06, thumpStartHz: 300, thumpEndHz: 70, thumpDecay: 0.14, lead: 0, gain: 0.9, noiseMix: 0.8 },
  /** Slow, undramatic, twice as long. */
  io_timeout: { noiseHz: 1400, noiseDecay: 0.5, thumpStartHz: 110, thumpEndHz: 45, thumpDecay: 0.7, lead: 0, gain: 0.5, noiseMix: 0.4 },
  /** Corruption first: a gritty, mid-band burst that then breaks. */
  storage_corruption: { noiseHz: 3600, noiseDecay: 0.35, thumpStartHz: 130, thumpEndHz: 36, thumpDecay: 0.4, lead: 0.4, gain: 0.8, noiseMix: 0.65 },
};

/** Non-derezz impacts. `panic` is the one cue that plays at full. */
export const IMPACT_PRESETS = {
  denial: { noiseHz: 4000, noiseDecay: 0.05, thumpStartHz: 180, thumpEndHz: 90, thumpDecay: 0.08, lead: 0, gain: 0.45, noiseMix: 0.85 },
  reject: { noiseHz: 2600, noiseDecay: 0.07, thumpStartHz: 140, thumpEndHz: 70, thumpDecay: 0.1, lead: 0, gain: 0.35, noiseMix: 0.7 },
  minor: { noiseHz: 3000, noiseDecay: 0.08, thumpStartHz: 200, thumpEndHz: 80, thumpDecay: 0.12, lead: 0, gain: 0.3, noiseMix: 0.5 },
  panic: { noiseHz: 12000, noiseDecay: 0.5, thumpStartHz: 200, thumpEndHz: 28, thumpDecay: 0.9, lead: 0, gain: 1.0, noiseMix: 0.6 },
} as const satisfies Record<string, ImpactCharacter>;

const BURST_ADSR: Adsr = { attack: 0.002, decay: 0.05, sustain: 0.6, release: 0.05 };

/** Total seconds an impact sounds, for the allocator and the panic silence. */
export function impactDuration(c: ImpactCharacter): number {
  return c.lead + Math.max(c.noiseDecay, c.thumpDecay) + BURST_ADSR.release;
}

export class ImpactVoice extends Voice {
  readonly kind = 'impact' as const;
  private readonly noise: BufferSourceLike;
  private readonly noiseFilter: BiquadLike;
  private readonly noiseEnv: GainLike;
  private readonly thump: OscillatorLike;
  private readonly thumpEnv: GainLike;
  private readonly shaper: WaveShaperLike;

  constructor(host: VoiceHost) {
    super(host);
    const ctx = host.ctx;
    this.noise = this.trackSource(ctx.createBufferSource());
    this.noise.buffer = host.buffers.white;
    this.noise.loop = true;
    this.noiseFilter = this.track(ctx.createBiquadFilter());
    this.noiseFilter.type = 'lowpass';
    this.noiseEnv = this.track(ctx.createGain());
    this.noiseEnv.gain.value = 0;
    this.thump = this.trackSource(ctx.createOscillator());
    this.thump.type = 'sine';
    this.thumpEnv = this.track(ctx.createGain());
    this.thumpEnv.gain.value = 0;
    this.shaper = this.track(ctx.createWaveShaper());
    this.shaper.curve = host.buffers.softClip;
    this.shaper.oversample = '2x';
    this.noise.connect(this.noiseFilter);
    this.noiseFilter.connect(this.noiseEnv);
    this.noiseEnv.connect(this.shaper);
    this.thump.connect(this.thumpEnv);
    this.thumpEnv.connect(this.shaper);
    this.shaper.connect(this.out);
  }

  start(when: number, params: VoiceParams): void {
    this.begin(when, params);
    const c = params.impact ?? IMPACT_CHARACTER.normal_exit;
    const scale = this.host.envelopeScale;
    const at = when + c.lead * scale;
    const gain = (params.gain ?? 1) * c.gain;
    this.noiseFilter.frequency.setValueAtTime(clampHz(c.noiseHz), when);
    const noiseEnd = applyOneShot(this.noiseEnv.gain, at, BURST_ADSR, c.noiseMix, c.noiseDecay, scale);
    this.thump.frequency.cancelScheduledValues(when);
    this.thump.frequency.setValueAtTime(clampHz(c.thumpStartHz), at);
    rampExp(this.thump.frequency, clampHz(c.thumpEndHz), at + c.thumpDecay * scale);
    const thumpEnd = applyOneShot(this.thumpEnv.gain, at, BURST_ADSR, 1 - c.noiseMix * 0.5, c.thumpDecay, scale);
    this.out.gain.cancelScheduledValues(when);
    this.out.gain.setValueAtTime(gain, when);
    this.sustainLevel = gain;
    this.releaseSeconds = BURST_ADSR.release;
    this.finishAt = Math.max(noiseEnd, thumpEnd);
    this.out.gain.setValueAtTime(gain, this.finishAt);
    this.out.gain.setValueAtTime(MIN_EXP_TARGET, this.finishAt + 0.001);
  }
}

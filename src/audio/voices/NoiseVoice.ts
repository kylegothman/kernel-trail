/**
 * Seeks, transfers, flow, and the contention layer: a looping noise source
 * through a bandpass whose centre sweeps. Package section 4.
 */
import type { BiquadLike, BufferSourceLike } from '../context';
import { applyOneShot, type Adsr } from '../synth/envelope';
import { bandwidthToQ, clampHz, sweepHz } from '../synth/filters';
import { Voice, type VoiceHost, type VoiceParams } from './Voice';

export const NOISE_ADSR: Adsr = { attack: 0.008, decay: 0.03, sustain: 0.8, release: 0.06 };

export class NoiseVoice extends Voice {
  readonly kind = 'noise' as const;
  private readonly source: BufferSourceLike;
  private readonly filter: BiquadLike;

  constructor(host: VoiceHost) {
    super(host);
    const ctx = host.ctx;
    this.source = this.trackSource(ctx.createBufferSource());
    this.source.buffer = host.buffers.white;
    this.source.loop = true;
    this.filter = this.track(ctx.createBiquadFilter());
    this.filter.type = 'bandpass';
    this.source.connect(this.filter);
    this.filter.connect(this.out);
  }

  /** The bandpass centre, exposed so tests can read the sweep it was given. */
  get filterParam(): BiquadLike['frequency'] {
    return this.filter.frequency;
  }

  /** The bandpass centre and width, for the contention layer's live band. */
  setBand(centreHz: number, octaves: number, when: number, seconds: number): void {
    sweepHz(this.filter.frequency, this.filter.frequency.value, centreHz, when, seconds);
    this.filter.Q.setValueAtTime(bandwidthToQ(octaves), when);
  }

  start(when: number, params: VoiceParams): void {
    this.begin(when, params);
    const from = clampHz(params.filterHz ?? 1200);
    const to = clampHz(params.filterEndHz ?? from);
    const hold = params.hold ?? 0.12;
    this.filter.Q.setValueAtTime(params.q ?? bandwidthToQ(1.5), when);
    if (params.layer === true) {
      // The Score owns this voice's level and band. Nothing else is scheduled.
      this.filter.frequency.setValueAtTime(from, when);
      this.sustainLevel = params.gain ?? 0.3;
      return;
    }
    sweepHz(this.filter.frequency, from, to, when, hold * this.host.envelopeScale + NOISE_ADSR.attack);
    const adsr = params.adsr ?? NOISE_ADSR;
    const gain = params.gain ?? 0.35;
    this.releaseSeconds = adsr.release;
    this.sustainLevel = Math.max(1e-4, gain * adsr.sustain);
    this.finishAt = applyOneShot(this.out.gain, when, adsr, gain, hold, this.host.envelopeScale);
  }
}

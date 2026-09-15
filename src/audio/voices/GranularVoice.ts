/**
 * Thrashing texture and corruption: grains scheduled from one noise buffer.
 * Pre-flight D1: the grains are a fixed set of looping slots gated by their
 * own envelopes, so a grain never constructs a node; the grain count scales
 * with intensity and stops at the slot cap.
 */
import type { BiquadLike, BufferSourceLike, GainLike } from '../context';
import { rampExp } from '../synth/envelope';
import { clampHz } from '../synth/filters';
import { FAULT_DENSITY, GRAIN, MIN_EXP_TARGET } from '../synth/constants';
import { Voice, type VoiceHost, type VoiceParams } from './Voice';

interface GrainSlot {
  readonly source: BufferSourceLike;
  readonly env: GainLike;
}

export class GranularVoice extends Voice {
  readonly kind = 'granular' as const;
  private readonly slots: GrainSlot[] = [];
  private readonly filter: BiquadLike;
  private intensity = 0;
  private grainsPerSecond = 0;
  private nextGrain = 0;
  private slotCursor = 0;
  private pitchJitter = 0.15;
  private grainLevel = 0.3;
  private grainsScheduled = 0;

  constructor(host: VoiceHost) {
    super(host);
    const ctx = host.ctx;
    this.filter = this.track(ctx.createBiquadFilter());
    this.filter.type = 'bandpass';
    this.filter.Q.value = 0.8;
    for (let i = 0; i < GRAIN.slotsPerVoice; i++) {
      const source = this.trackSource(ctx.createBufferSource());
      source.buffer = host.buffers.grain;
      source.loop = true;
      // Each slot loops from a different offset so simultaneous grains differ.
      source.playbackRate.value = 1;
      const env = this.track(ctx.createGain());
      env.gain.value = 0;
      source.connect(env);
      env.connect(this.filter);
      this.slots.push({ source, env });
    }
    this.filter.connect(this.out);
  }

  protected override startSources(when: number): void {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot === undefined) continue;
      // Spread the loop phases across the buffer.
      const offset = (i / this.slots.length) * (this.host.buffers.grain.length / this.host.buffers.grain.sampleRate);
      slot.source.start(when, offset);
    }
  }

  /** Concurrent grain slots in use at the current intensity. */
  get activeGrains(): number {
    if (this.intensity <= 0) return 0;
    return Math.min(this.slots.length, Math.max(1, Math.round(this.intensity * this.slots.length)));
  }

  get scheduledGrainCount(): number {
    return this.grainsScheduled;
  }

  get density(): number {
    return this.intensity;
  }

  start(when: number, params: VoiceParams): void {
    this.begin(when, params);
    this.grainLevel = params.gain ?? 0.3;
    this.pitchJitter = params.pitchJitter ?? 0.15;
    const centre = clampHz(params.filterHz ?? 1800);
    // Package line 263: an unrecoverable corruption has no fundamental left.
    this.filter.type = params.removeFundamental === true ? 'highpass' : 'bandpass';
    this.filter.frequency.setValueAtTime(params.removeFundamental === true ? centre * 2 : centre, when);
    this.out.gain.cancelScheduledValues(when);
    this.out.gain.setValueAtTime(1, when);
    this.sustainLevel = 1;
    this.nextGrain = when;
    this.setDensity(params.intensity ?? 1, when);
    if (params.hold !== undefined) {
      this.finishAt = when + params.hold * this.host.envelopeScale;
    }
  }

  /** One density change per frame, never one grain per fault. */
  setDensity(intensity: number, when: number): void {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 0));
    this.intensity = clamped;
    this.grainsPerSecond = clamped * FAULT_DENSITY.maxGrainsPerSecond;
    if (this.nextGrain < when) this.nextGrain = when;
  }

  /** Called each frame with a lookahead; schedules grains up to `until`. */
  scheduleUntil(until: number): void {
    if (!this.busy || this.grainsPerSecond <= 0) return;
    const active = this.activeGrains;
    const rng = this.host.rng;
    while (this.nextGrain < until) {
      const t = this.nextGrain;
      const slot = this.slots[this.slotCursor % active];
      this.slotCursor = (this.slotCursor + 1) % active;
      if (slot !== undefined) this.trigger(slot, t, rng.next(), rng.next());
      const spacing = 1 / this.grainsPerSecond;
      this.nextGrain = t + spacing * (0.7 + 0.6 * rng.next());
    }
  }

  override stop(when: number): void {
    this.intensity = 0;
    this.grainsPerSecond = 0;
    super.stop(when);
  }

  private trigger(slot: GrainSlot, t: number, r1: number, r2: number): void {
    const scale = this.host.envelopeScale;
    const lengthMs = GRAIN.minMs + (GRAIN.maxMs - GRAIN.minMs) * r1;
    const length = (lengthMs / 1000) * scale;
    const rate = 1 + (r2 * 2 - 1) * this.pitchJitter;
    slot.source.playbackRate.setValueAtTime(Math.max(0.25, rate), t);
    slot.env.gain.cancelScheduledValues(t);
    slot.env.gain.setValueAtTime(MIN_EXP_TARGET, t);
    slot.env.gain.linearRampToValueAtTime(this.grainLevel, t + 0.003);
    rampExp(slot.env.gain, MIN_EXP_TARGET, t + Math.max(0.005, length));
    this.grainsScheduled += 1;
  }
}

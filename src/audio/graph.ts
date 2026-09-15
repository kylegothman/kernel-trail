/**
 * The fixed master chain, package section 3, built once:
 *
 *   voices -> per-bus gain -> bus compressor -> master gain
 *          -> master limiter (ratio 20, knee 0, attack 0.003) -> destination
 *
 * plus one send into the space: a convolver with a seeded impulse at medium
 * and high, a delay feedback pair at low. That tier branch is the only one.
 */
import type { QualityTier } from '@platform/quality';
import type { AudioContextLike, BufferLike, CompressorLike, ConvolverLike, DelayLike, GainLike, NodeLike } from './context';
import type { AudioBufferSet } from './buffers';
import type { BusId, UploadedBuffers } from './voices/Voice';
import { BUS_IDS } from './voices/Voice';
import { BUS_COMPRESSOR, LIMITER, LOW_TIER_DELAY, SEND_LEVEL } from './synth/constants';

export interface Bus {
  readonly input: GainLike;
  readonly compressor: CompressorLike;
  readonly send: GainLike;
}

export type Space =
  | { readonly kind: 'convolver'; readonly node: ConvolverLike }
  | { readonly kind: 'delay'; readonly a: DelayLike; readonly b: DelayLike; readonly feedback: GainLike };

/** Copy the transferable set into context buffers. Runs once per session. */
export function uploadBuffers(ctx: AudioContextLike, set: AudioBufferSet, tier: QualityTier): UploadedBuffers {
  const upload = (data: Float32Array): BufferLike => {
    const buffer = ctx.createBuffer(1, data.length, set.sampleRate);
    buffer.copyToChannel(data, 0);
    return buffer;
  };
  const impulse = tier === 'high' ? upload(set.impulseHigh) : tier === 'medium' ? upload(set.impulseMedium) : null;
  return { white: upload(set.white), pink: upload(set.pink), grain: upload(set.grain), impulse, softClip: set.softClip };
}

export class MasterGraph {
  readonly buses: Readonly<Record<BusId, Bus>>;
  readonly master: GainLike;
  readonly limiter: CompressorLike;
  readonly space: Space;
  private readonly nodes: NodeLike[] = [];

  constructor(readonly ctx: AudioContextLike, readonly tier: QualityTier, buffers: UploadedBuffers) {
    this.master = this.track(ctx.createGain());
    this.master.gain.value = 1;
    this.limiter = this.track(ctx.createDynamicsCompressor());
    // Set once through `.value`, never through automation. Acceptance criterion 17.
    this.limiter.threshold.value = LIMITER.threshold;
    this.limiter.knee.value = LIMITER.knee;
    this.limiter.ratio.value = LIMITER.ratio;
    this.limiter.attack.value = LIMITER.attack;
    this.limiter.release.value = LIMITER.release;
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    this.space = this.buildSpace(buffers);

    const buses = {} as Record<BusId, Bus>;
    for (const id of BUS_IDS) {
      const input = this.track(ctx.createGain());
      const compressor = this.track(ctx.createDynamicsCompressor());
      compressor.threshold.value = BUS_COMPRESSOR.threshold;
      compressor.knee.value = BUS_COMPRESSOR.knee;
      compressor.ratio.value = BUS_COMPRESSOR.ratio;
      compressor.attack.value = BUS_COMPRESSOR.attack;
      compressor.release.value = BUS_COMPRESSOR.release;
      const send = this.track(ctx.createGain());
      send.gain.value = SEND_LEVEL;
      input.connect(compressor);
      compressor.connect(this.master);
      input.connect(send);
      send.connect(this.spaceInput());
      buses[id] = { input, compressor, send };
    }
    this.buses = buses;
  }

  busInput(bus: BusId): NodeLike {
    return this.buses[bus].input;
  }

  setBusGain(bus: BusId, value: number, when: number, rampSeconds: number): void {
    const gain = this.buses[bus].input.gain;
    gain.cancelScheduledValues(when);
    gain.setValueAtTime(gain.value, when);
    gain.linearRampToValueAtTime(clamp01(value), when + Math.max(0.001, rampSeconds));
  }

  /** Mute and unmute are instant steps by design: nothing is disconnected. */
  setMasterGain(value: number, when: number): void {
    this.master.gain.cancelScheduledValues(when);
    this.master.gain.setValueAtTime(clamp01(value), when);
  }

  dispose(): void {
    for (const node of this.nodes) node.disconnect();
    this.nodes.length = 0;
  }

  private buildSpace(buffers: UploadedBuffers): Space {
    const ctx = this.ctx;
    if (buffers.impulse !== null) {
      const node = this.track(ctx.createConvolver());
      node.normalize = true;
      node.buffer = buffers.impulse;
      node.connect(this.master);
      return { kind: 'convolver', node };
    }
    const a = this.track(ctx.createDelay(1));
    const b = this.track(ctx.createDelay(1));
    const feedback = this.track(ctx.createGain());
    a.delayTime.value = LOW_TIER_DELAY.seconds;
    b.delayTime.value = LOW_TIER_DELAY.secondsB;
    feedback.gain.value = LOW_TIER_DELAY.feedback;
    a.connect(b);
    b.connect(feedback);
    feedback.connect(a);
    a.connect(this.master);
    b.connect(this.master);
    return { kind: 'delay', a, b, feedback };
  }

  private spaceInput(): NodeLike {
    return this.space.kind === 'convolver' ? this.space.node : this.space.a;
  }

  private track<T extends NodeLike>(node: T): T {
    this.nodes.push(node);
    return node;
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
}

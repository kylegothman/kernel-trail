/**
 * The abstract voice. Package section 4 and pre-flight rulings C7 and D1:
 * every source starts once at warm-up and runs for the session, gated by a
 * gain envelope, because `OscillatorNode` and `AudioBufferSourceNode` cannot be
 * restarted and constructing one per event is how Web Audio stutters.
 * `stop(when)` closes the envelope and parks the voice with its nodes
 * connected; `dispose()` disconnects and releases every node it created.
 */
import type { Rng } from '@kernel/types';
import type { AudioContextLike, BufferLike, BufferSourceLike, GainLike, NodeLike, OscillatorLike, OscillatorTypeLike, PannerLike } from '../context';
import { applyRelease, type Adsr } from '../synth/envelope';
import { MIN_EXP_TARGET, PAN_CLAMP } from '../synth/constants';
import type { ImpactCharacter } from './ImpactVoice';

export type BusId = 'score' | 'world' | 'ui' | 'voice_alerts';
export const BUS_IDS: readonly BusId[] = ['score', 'world', 'ui', 'voice_alerts'];

/** WP-16's five, and WP-25 section 3's three: the pumped saw chord, the kick that triggers the side-chain, the formant lead. */
export type VoiceKind = 'tone' | 'noise' | 'impact' | 'drone' | 'granular' | 'chord' | 'kick' | 'lead';
export const VOICE_KINDS: readonly VoiceKind[] = ['tone', 'noise', 'impact', 'drone', 'granular', 'chord', 'kick', 'lead'];

/** The session buffers after upload into the context. */
export interface UploadedBuffers {
  readonly white: BufferLike;
  readonly pink: BufferLike;
  readonly grain: BufferLike;
  /** Null at low tier, where the delay pair stands in. */
  readonly impulse: BufferLike | null;
  readonly softClip: Float32Array;
}

/** What a voice needs from the engine. Kept narrow so voices are testable alone. */
export interface VoiceHost {
  readonly ctx: AudioContextLike;
  readonly buffers: UploadedBuffers;
  busInput(bus: BusId): NodeLike;
  /** 1 normally, halved under reduced motion. */
  readonly envelopeScale: number;
  readonly mono: boolean;
  /** Runtime jitter, forked from the audio stream. Never a kernel stream. */
  readonly rng: Rng;
}

/**
 * One parameter bag for every kind, all optional, so callers reuse a scratch
 * object per cue instead of allocating one per event.
 */
export interface VoiceParams {
  readonly hz?: number;
  readonly hz2?: number;
  readonly detuneCents?: number;
  readonly waveform?: OscillatorTypeLike;
  readonly gain?: number;
  readonly adsr?: Adsr;
  /** Seconds held at sustain before release. Absent means sustained until `stop`. */
  readonly hold?: number;
  /**
   * True for a score voice. WP-16's layers had the Score drive `level`; WP-25's
   * sequenced notes keep their envelopes but share the flag, because it is what
   * keeps the world's deadlock hold and panic stop away from the music.
   */
  readonly layer?: boolean;
  readonly filterHz?: number;
  readonly filterEndHz?: number;
  readonly q?: number;
  readonly pan?: number;
  readonly glideToHz?: number;
  readonly glideSeconds?: number;
  /** A final pitch step at the end of the glide. The starving voice's descending third. */
  readonly stepToHz?: number;
  readonly impact?: ImpactCharacter;
  readonly intensity?: number;
  readonly pitchJitter?: number;
  readonly removeFundamental?: boolean;
  /** The lead's vowel at onset and at the end of the note, 0 to 1 along the formant path. WP-25 section 3. */
  readonly vowel?: number;
  readonly vowelEnd?: number;
}

export abstract class Voice {
  abstract readonly kind: VoiceKind;
  busy = false;
  bus: BusId = 'world';
  exempt = false;
  /** True for a score voice: the world's holds and stops leave it alone. */
  layer = false;
  startedAt = 0;
  /** When the current cue is silent. `Infinity` while sustained. */
  finishAt = Number.POSITIVE_INFINITY;
  protected readonly nodes: NodeLike[] = [];
  protected readonly sources: (OscillatorLike | BufferSourceLike)[] = [];
  protected readonly out: GainLike;
  protected readonly panner: PannerLike;
  protected sustainLevel = MIN_EXP_TARGET;
  protected releaseSeconds = 0.08;
  private connectedBus: BusId | null = null;
  private disposed = false;
  private warmed = false;

  constructor(protected readonly host: VoiceHost) {
    this.out = this.track(host.ctx.createGain());
    this.out.gain.value = 0;
    this.panner = this.track(host.ctx.createStereoPanner());
    this.out.connect(this.panner);
  }

  /** The gain the Score ramps for layer voices. */
  get level(): GainLike['gain'] {
    return this.out.gain;
  }

  get nodeCount(): number {
    return this.nodes.length;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Start every source exactly once. Idempotent. */
  warmUp(when: number): void {
    if (this.warmed || this.disposed) return;
    this.warmed = true;
    this.startSources(when);
  }

  /** Overridden by voices whose sources need per-slot offsets. */
  protected startSources(when: number): void {
    for (const source of this.sources) source.start(when);
  }

  abstract start(when: number, params: VoiceParams): void;

  /** Close the envelope and park. Nodes stay connected; no construction later. */
  stop(when: number): void {
    if (!this.busy) return;
    this.busy = false;
    this.exempt = false;
    this.finishAt = applyRelease(this.out.gain, when, this.sustainLevel, this.releaseSeconds, this.host.envelopeScale);
  }

  /**
   * Deadlock hold, package line 259: re-anchor at the sustain level so the cue
   * neither decays nor moves until `until`, then release normally.
   */
  sustainUntil(when: number, until: number): void {
    if (!this.busy || this.layer) return;
    this.out.gain.cancelScheduledValues(when);
    this.out.gain.setValueAtTime(Math.max(MIN_EXP_TARGET, this.sustainLevel), when);
    this.finishAt = applyRelease(this.out.gain, until, this.sustainLevel, this.releaseSeconds, this.host.envelopeScale);
  }

  setPan(pan: number, when: number): void {
    const clamped = this.host.mono ? 0 : Math.min(PAN_CLAMP, Math.max(-PAN_CLAMP, Number.isFinite(pan) ? pan : 0));
    this.panner.pan.setValueAtTime(clamped, when);
  }

  /** Disconnect and release every node. The voice is unusable afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.busy = false;
    for (const source of this.sources) {
      if (this.warmed) source.stop();
    }
    for (const node of this.nodes) node.disconnect();
    this.nodes.length = 0;
    this.sources.length = 0;
    this.connectedBus = null;
  }

  protected track<T extends NodeLike>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  protected trackSource<T extends OscillatorLike | BufferSourceLike>(source: T): T {
    this.sources.push(source);
    return this.track(source);
  }

  /** Common bookkeeping at the top of every `start`. */
  protected begin(when: number, params: VoiceParams): void {
    if (this.disposed) throw new Error('voice: start after dispose');
    if (this.connectedBus !== this.bus) {
      this.panner.disconnect();
      this.panner.connect(this.host.busInput(this.bus));
      this.connectedBus = this.bus;
    }
    this.busy = true;
    this.layer = params.layer === true;
    this.startedAt = when;
    this.finishAt = Number.POSITIVE_INFINITY;
    this.setPan(params.pan ?? 0, when);
  }
}

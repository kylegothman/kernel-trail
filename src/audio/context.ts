/**
 * KERNEL TRAIL audio: the one adapter over the platform's Web Audio API.
 *
 * Everything else under src/audio talks to the structural interfaces below,
 * never to `AudioContext` directly. That is what lets the whole graph run in
 * Node against a fake (tests/audio/fakeContext.ts) with a zero skip budget, and
 * it is where the autoplay rule and the quiet-failure rule of package section 2
 * live. Each interface is the subset of the DOM typing the graph actually uses;
 * `adaptPlatformContext` below is the compile-time proof that a real
 * `AudioContext` satisfies them, checked against lib.dom.d.ts by `tsc`.
 */

/** The automation surface of an `AudioParam`. Every method mirrors lib.dom.d.ts. */
export interface ParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  exponentialRampToValueAtTime(value: number, endTime: number): unknown;
  setTargetAtTime(target: number, startTime: number, timeConstant: number): unknown;
  setValueCurveAtTime(values: Float32Array, startTime: number, duration: number): unknown;
  cancelScheduledValues(cancelTime: number): unknown;
}

export interface NodeLike {
  connect(destination: NodeLike | ParamLike): unknown;
  /** Bare disconnect: every outgoing connection is dropped. */
  disconnect(): void;
}

export interface GainLike extends NodeLike {
  readonly gain: ParamLike;
}

export type OscillatorTypeLike = 'custom' | 'sawtooth' | 'sine' | 'square' | 'triangle';

export interface OscillatorLike extends NodeLike {
  type: OscillatorTypeLike;
  readonly frequency: ParamLike;
  readonly detune: ParamLike;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface BufferLike {
  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
  copyToChannel(source: Float32Array, channelNumber: number): void;
}

export interface BufferSourceLike extends NodeLike {
  buffer: BufferLike | null;
  loop: boolean;
  readonly playbackRate: ParamLike;
  readonly detune: ParamLike;
  start(when?: number, offset?: number): void;
  stop(when?: number): void;
}

export type BiquadTypeLike =
  | 'allpass' | 'bandpass' | 'highpass' | 'highshelf'
  | 'lowpass' | 'lowshelf' | 'notch' | 'peaking';

export interface BiquadLike extends NodeLike {
  type: BiquadTypeLike;
  readonly frequency: ParamLike;
  readonly Q: ParamLike;
  readonly gain: ParamLike;
  readonly detune: ParamLike;
}

export interface WaveShaperLike extends NodeLike {
  curve: Float32Array | null;
  oversample: '2x' | '4x' | 'none';
}

export interface ConvolverLike extends NodeLike {
  buffer: BufferLike | null;
  normalize: boolean;
}

export interface DelayLike extends NodeLike {
  readonly delayTime: ParamLike;
}

export interface CompressorLike extends NodeLike {
  readonly threshold: ParamLike;
  readonly knee: ParamLike;
  readonly ratio: ParamLike;
  readonly attack: ParamLike;
  readonly release: ParamLike;
}

export interface PannerLike extends NodeLike {
  readonly pan: ParamLike;
}

/** Mirrors `AudioContextState` in lib.dom.d.ts, including the newer `interrupted`. */
export type PlatformState = 'closed' | 'interrupted' | 'running' | 'suspended';

export interface AudioContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly state: PlatformState;
  readonly destination: NodeLike;
  /**
   * Typed with a `never[]` rest so the DOM's `(this, ev: Event) => any` and a
   * plain `() => void` handler are both assignable without a wrapper object.
   */
  onstatechange: ((...args: never[]) => unknown) | null;
  createGain(): GainLike;
  createOscillator(): OscillatorLike;
  createBufferSource(): BufferSourceLike;
  createBiquadFilter(): BiquadLike;
  createWaveShaper(): WaveShaperLike;
  createConvolver(): ConvolverLike;
  createDelay(maxDelayTime?: number): DelayLike;
  createDynamicsCompressor(): CompressorLike;
  createStereoPanner(): PannerLike;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): BufferLike;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
}

export type AudioContextFactory = () => AudioContextLike;

/**
 * Compile-time proof that the platform context satisfies the adapter surface.
 * If a future lib.dom.d.ts renames a method, this line is where `tsc` says so.
 */
export function adaptPlatformContext(real: AudioContext): AudioContextLike {
  return real;
}

/**
 * The default factory. Looked up by `typeof` so importing this module in Node,
 * where no `AudioContext` global exists, neither throws nor touches the DOM.
 * `interactive` is the lowest-latency hint and the right one for cues that must
 * land on a visual beat.
 */
export function platformContextFactory(): AudioContextLike {
  if (typeof AudioContext === 'undefined') {
    throw new Error('AudioContext is not available in this environment');
  }
  return adaptPlatformContext(new AudioContext({ latencyHint: 'interactive' }));
}

/** Package section 2: the engine's view of the context lifecycle. */
export type AudioState = 'unstarted' | 'running' | 'suspended' | 'failed';

export type StateListener = (state: AudioState) => void;

/**
 * Owns the lazily constructed context. Construction happens only inside
 * `unlock()`, which the HUD or app calls from its own gesture handler (pre-flight
 * ruling I1: audio never subscribes to DOM events itself). A factory that throws
 * moves the adapter to `failed` permanently and every later call is a no-op.
 */
export class AudioAdapter {
  private ctx: AudioContextLike | null = null;
  private current: AudioState = 'unstarted';
  private reason: string | null = null;
  private readonly listeners: StateListener[] = [];
  private constructions = 0;

  constructor(private readonly factory: AudioContextFactory = platformContextFactory) {}

  get state(): AudioState {
    return this.current;
  }

  /** Why the adapter failed, or null. Surfaced by the diagnostics panel. */
  get failureReason(): string | null {
    return this.reason;
  }

  /** The context, or null before the first gesture and after failure. */
  get context(): AudioContextLike | null {
    return this.ctx;
  }

  /** How many times the factory ran. Acceptance criterion 9 asserts zero at import. */
  get contextConstructions(): number {
    return this.constructions;
  }

  /** Scheduling time in seconds, or 0 with no context. */
  get now(): number {
    return this.ctx === null ? 0 : this.ctx.currentTime;
  }

  get running(): boolean {
    return this.current === 'running';
  }

  /**
   * First call constructs the context; later calls resume a suspended one.
   * Never throws: a failing factory or a rejected resume is recorded and the
   * game keeps running without sound.
   */
  unlock(): void {
    if (this.current === 'failed') return;
    if (this.ctx === null) {
      try {
        this.constructions += 1;
        this.ctx = this.factory();
      } catch (err) {
        this.fail(err instanceof Error ? err.message : String(err));
        return;
      }
      this.ctx.onstatechange = () => this.syncState();
    }
    const ctx = this.ctx;
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      // The promise settles after the platform actually resumes, and the
      // statechange event carries the news. A rejection means the gesture was
      // not accepted; we stay suspended and wait for the next one.
      let resumed: Promise<void>;
      try {
        resumed = ctx.resume();
      } catch (err) {
        this.fail(err instanceof Error ? err.message : String(err));
        return;
      }
      resumed.then(() => this.syncState(), () => this.syncState());
    }
    this.syncState();
  }

  onStateChange(listener: StateListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Closes the context. Used by tests and by a full engine teardown only. */
  dispose(): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    ctx.onstatechange = null;
    this.ctx = null;
    try {
      ctx.close().catch(() => undefined);
    } catch {
      // Closing an already closed context throws in some engines; nothing to do.
    }
    this.set('unstarted');
  }

  private fail(reason: string): void {
    this.reason = reason;
    this.ctx = null;
    this.set('failed');
  }

  private syncState(): void {
    const ctx = this.ctx;
    if (ctx === null || this.current === 'failed') return;
    switch (ctx.state) {
      case 'running':
        this.set('running');
        return;
      case 'suspended':
      case 'interrupted':
        // Pre-flight AC20 note: `interrupted` is the platform pausing us for a
        // call or another app, and the engine treats it exactly like suspended.
        this.set('suspended');
        return;
      case 'closed':
        this.fail('context closed');
        return;
      default:
        return;
    }
  }

  private set(next: AudioState): void {
    if (next === this.current) return;
    this.current = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        // A listener that throws must not take the adapter down.
      }
    }
  }
}

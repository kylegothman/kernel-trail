/**
 * A fake of the adapter surface in src/audio/context.ts. Records every node
 * construction, connection, disconnection and parameter automation, and can
 * evaluate a parameter's automation at any time so tests sample the curves
 * the platform would have produced. Node has no AudioContext; this is the
 * whole Web Audio boundary for the Node suite.
 */
import type {
  AudioContextLike, BiquadLike, BiquadTypeLike, BufferLike, BufferSourceLike, CompressorLike, ConvolverLike,
  DelayLike, GainLike, NodeLike, OscillatorLike, OscillatorTypeLike, PannerLike, ParamLike, PlatformState, WaveShaperLike,
} from '../../src/audio/context';

export type AutomationKind = 'set' | 'linear' | 'exp' | 'target' | 'curve';

export interface AutomationEvent {
  readonly kind: AutomationKind;
  readonly value: number;
  readonly time: number;
  readonly duration: number;
  /** The duration as scheduled, kept when a cancel truncates `duration`. */
  readonly scheduledDuration: number;
  readonly values: Float32Array | null;
  readonly timeConstant: number;
}

export class FakeParam implements ParamLike {
  readonly events: AutomationEvent[] = [];
  automationCalls = 0;
  private base: number;

  constructor(readonly owner: FakeNode, readonly name: string, initial: number) {
    this.base = initial;
  }

  get value(): number {
    return this.base;
  }

  set value(v: number) {
    this.base = v;
  }

  setValueAtTime(value: number, startTime: number): this {
    this.push('set', value, startTime, 0, null, 0);
    return this;
  }

  linearRampToValueAtTime(value: number, endTime: number): this {
    this.push('linear', value, endTime, 0, null, 0);
    return this;
  }

  exponentialRampToValueAtTime(value: number, endTime: number): this {
    // Chrome and Firefox both throw here; the fake keeps the platform's rule.
    if (!(value > 0)) throw new RangeError(`exponentialRampToValueAtTime: ${value} is not positive`);
    this.push('exp', value, endTime, 0, null, 0);
    return this;
  }

  setTargetAtTime(target: number, startTime: number, timeConstant: number): this {
    this.push('target', target, startTime, 0, null, timeConstant);
    return this;
  }

  setValueCurveAtTime(values: Float32Array, startTime: number, duration: number): this {
    this.push('curve', values[values.length - 1] ?? 0, startTime, duration, Float32Array.from(values), 0);
    return this;
  }

  /**
   * Cancel the way the platform does: the audio thread has already rendered
   * everything before `cancelTime`, so an in-progress ramp or curve is
   * truncated there rather than erased, and only the future is dropped.
   */
  cancelScheduledValues(cancelTime: number): this {
    this.automationCalls += 1;
    const sorted = [...this.events].sort((a, b) => a.time - b.time);
    const kept: AutomationEvent[] = [];
    let prevTime = 0;
    let prevValue = this.base;
    for (const e of sorted) {
      if (e.kind === 'curve' && e.time < cancelTime && e.time + e.duration > cancelTime) {
        const values = e.values ?? new Float32Array(0);
        const cut = Math.max(1e-9, cancelTime - e.time);
        const x = (cut / e.duration) * (values.length - 1);
        const i = Math.floor(x);
        const a = values[i] ?? 0;
        const b = values[Math.min(values.length - 1, i + 1)] ?? a;
        const n = Math.max(2, Math.round(values.length * (cut / e.duration)));
        const truncated = new Float32Array(n);
        for (let k = 0; k < n; k++) {
          const xx = (k / (n - 1)) * (cut / e.duration) * (values.length - 1);
          const ii = Math.floor(xx);
          const aa = values[ii] ?? 0;
          const bb = values[Math.min(values.length - 1, ii + 1)] ?? aa;
          truncated[k] = aa + (bb - aa) * (xx - ii);
        }
        truncated[n - 1] = a + (b - a) * (x - i);
        kept.push({ ...e, duration: cut, values: truncated, value: truncated[n - 1] ?? e.value });
        break;
      }
      if (e.time >= cancelTime) {
        if ((e.kind === 'linear' || e.kind === 'exp') && prevTime < cancelTime) {
          const span = e.time - prevTime;
          const x = span > 0 ? (cancelTime - prevTime) / span : 1;
          const v = e.kind === 'linear' ? prevValue + (e.value - prevValue) * x : prevValue > 0 ? prevValue * Math.pow(e.value / prevValue, x) : e.value;
          kept.push({ ...e, value: v, time: cancelTime });
        }
        break;
      }
      kept.push(e);
      if (e.kind === 'curve') {
        prevTime = e.time + e.duration;
        prevValue = e.value;
      } else if (e.kind !== 'target') {
        prevTime = e.time;
        prevValue = e.value;
      }
    }
    this.events.length = 0;
    this.events.push(...kept);
    return this;
  }

  /** The automation timeline's value at `t`, following the Web Audio rules. */
  valueAt(t: number): number {
    const events = [...this.events].sort((a, b) => a.time - b.time);
    let v = this.base;
    let prevTime = 0;
    for (const e of events) {
      if (e.time > t) {
        const span = e.time - prevTime;
        const x = span > 0 ? (t - prevTime) / span : 1;
        if (e.kind === 'linear') return v + (e.value - v) * Math.max(0, x);
        if (e.kind === 'exp') return v > 0 ? v * Math.pow(e.value / v, Math.max(0, x)) : e.value;
        return v;
      }
      switch (e.kind) {
        case 'set':
        case 'linear':
        case 'exp':
          v = e.value;
          prevTime = e.time;
          break;
        case 'target': {
          if (t < e.time) break;
          const next = v;
          v = e.value + (next - e.value) * Math.exp(-(t - e.time) / Math.max(1e-6, e.timeConstant));
          prevTime = e.time;
          break;
        }
        case 'curve': {
          const values = e.values ?? new Float32Array(0);
          if (values.length === 0) break;
          if (t < e.time + e.duration) {
            const x = ((t - e.time) / e.duration) * (values.length - 1);
            const i = Math.floor(x);
            const a = values[i] ?? 0;
            const b = values[Math.min(values.length - 1, i + 1)] ?? a;
            return a + (b - a) * (x - i);
          }
          v = values[values.length - 1] ?? v;
          prevTime = e.time + e.duration;
          break;
        }
        default:
          break;
      }
    }
    return v;
  }

  private push(kind: AutomationKind, value: number, time: number, duration: number, values: Float32Array | null, timeConstant: number): void {
    if (!Number.isFinite(value) || !Number.isFinite(time)) throw new TypeError(`${this.name}: non-finite automation`);
    this.automationCalls += 1;
    this.events.push({ kind, value, time, duration, scheduledDuration: duration, values, timeConstant });
  }
}

export type FakeNodeKind =
  | 'destination' | 'gain' | 'oscillator' | 'bufferSource' | 'biquad' | 'waveShaper'
  | 'convolver' | 'delay' | 'compressor' | 'panner';

export class FakeNode implements NodeLike {
  readonly connections = new Set<FakeNode | FakeParam>();
  readonly params: FakeParam[] = [];
  released = true;
  disconnectCalls = 0;
  started = 0;
  stopped = 0;

  constructor(readonly ctx: FakeContext, readonly kind: FakeNodeKind, readonly id: number) {}

  connect(destination: NodeLike | ParamLike): this {
    this.connections.add(destination as FakeNode | FakeParam);
    this.released = false;
    this.ctx.connectCalls += 1;
    return this;
  }

  disconnect(): void {
    this.connections.clear();
    this.released = true;
    this.disconnectCalls += 1;
    this.ctx.disconnectCalls += 1;
  }

  protected param(name: string, initial: number): FakeParam {
    const p = new FakeParam(this, name, initial);
    this.params.push(p);
    this.ctx.params.push(p);
    return p;
  }
}

export class FakeGain extends FakeNode implements GainLike {
  readonly gain = this.param('gain', 1);
}

export class FakeOscillator extends FakeNode implements OscillatorLike {
  type: OscillatorTypeLike = 'sine';
  readonly frequency = this.param('frequency', 440);
  readonly detune = this.param('detune', 0);
  start(): void { this.started += 1; if (this.started > 1) throw new Error('InvalidStateError: oscillator already started'); }
  stop(): void { this.stopped += 1; }
}

export class FakeBuffer implements BufferLike {
  readonly channels: Float32Array[] = [];
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    for (let i = 0; i < numberOfChannels; i++) this.channels.push(new Float32Array(length));
  }
  getChannelData(channel: number): Float32Array {
    const c = this.channels[channel];
    if (c === undefined) throw new RangeError('channel');
    return c;
  }
  copyToChannel(source: Float32Array, channelNumber: number): void {
    this.getChannelData(channelNumber).set(source.subarray(0, this.length));
  }
}

export class FakeBufferSource extends FakeNode implements BufferSourceLike {
  buffer: BufferLike | null = null;
  loop = false;
  readonly playbackRate = this.param('playbackRate', 1);
  readonly detune = this.param('detune', 0);
  start(): void { this.started += 1; if (this.started > 1) throw new Error('InvalidStateError: source already started'); }
  stop(): void { this.stopped += 1; }
}

export class FakeBiquad extends FakeNode implements BiquadLike {
  type: BiquadTypeLike = 'lowpass';
  readonly frequency = this.param('frequency', 350);
  readonly Q = this.param('Q', 1);
  readonly gain = this.param('gain', 0);
  readonly detune = this.param('detune', 0);
}

export class FakeWaveShaper extends FakeNode implements WaveShaperLike {
  curve: Float32Array | null = null;
  oversample: '2x' | '4x' | 'none' = 'none';
}

export class FakeConvolver extends FakeNode implements ConvolverLike {
  private impulse: BufferLike | null = null;
  normalize = true;
  get buffer(): BufferLike | null { return this.impulse; }
  /** Chrome's rule, which WP-23 found the hard way: a convolver refuses an impulse at another rate. */
  set buffer(value: BufferLike | null) {
    if (value !== null && value.sampleRate !== this.ctx.sampleRate) {
      throw new Error(`NotSupportedError: The buffer sample rate of ${value.sampleRate} does not match the context rate of ${this.ctx.sampleRate} Hz.`);
    }
    this.impulse = value;
  }
}

export class FakeDelay extends FakeNode implements DelayLike {
  readonly delayTime = this.param('delayTime', 0);
}

export class FakeCompressor extends FakeNode implements CompressorLike {
  readonly threshold = this.param('threshold', -24);
  readonly knee = this.param('knee', 30);
  readonly ratio = this.param('ratio', 12);
  readonly attack = this.param('attack', 0.003);
  readonly release = this.param('release', 0.25);
}

export class FakePanner extends FakeNode implements PannerLike {
  readonly pan = this.param('pan', 0);
}

export class FakeContext implements AudioContextLike {
  currentTime = 0;
  readonly sampleRate: number;
  state: PlatformState;
  onstatechange: ((...args: never[]) => unknown) | null = null;
  readonly destination: FakeNode;
  readonly nodes: FakeNode[] = [];
  readonly params: FakeParam[] = [];
  readonly constructions: Record<FakeNodeKind, number> = {
    destination: 0, gain: 0, oscillator: 0, bufferSource: 0, biquad: 0, waveShaper: 0, convolver: 0, delay: 0, compressor: 0, panner: 0,
  };
  connectCalls = 0;
  disconnectCalls = 0;
  buffersCreated = 0;
  private nextId = 1;

  constructor(options: { sampleRate?: number; initialState?: PlatformState } = {}) {
    this.sampleRate = options.sampleRate ?? 48000;
    this.state = options.initialState ?? 'running';
    this.destination = new FakeNode(this, 'destination', 0);
    this.destination.released = false;
  }

  /** Every construction of an AudioNode, all kinds. */
  get nodeConstructions(): number {
    let n = 0;
    for (const k of Object.keys(this.constructions) as FakeNodeKind[]) n += this.constructions[k];
    return n;
  }

  /** Nodes that hold at least one connection, or were never disconnected since connecting. */
  get liveNodeCount(): number {
    let n = 0;
    for (const node of this.nodes) if (!node.released) n += 1;
    return n;
  }

  advance(seconds: number): void {
    this.currentTime += seconds;
  }

  /** The platform pausing us, as on a phone call. */
  suspendExternally(state: PlatformState = 'suspended'): void {
    this.state = state;
    this.fireStateChange();
  }

  createGain(): FakeGain { return this.make(new FakeGain(this, 'gain', this.nextId++)); }
  createOscillator(): FakeOscillator { return this.make(new FakeOscillator(this, 'oscillator', this.nextId++)); }
  createBufferSource(): FakeBufferSource { return this.make(new FakeBufferSource(this, 'bufferSource', this.nextId++)); }
  createBiquadFilter(): FakeBiquad { return this.make(new FakeBiquad(this, 'biquad', this.nextId++)); }
  createWaveShaper(): FakeWaveShaper { return this.make(new FakeWaveShaper(this, 'waveShaper', this.nextId++)); }
  createConvolver(): FakeConvolver { return this.make(new FakeConvolver(this, 'convolver', this.nextId++)); }
  createDelay(): FakeDelay { return this.make(new FakeDelay(this, 'delay', this.nextId++)); }
  createDynamicsCompressor(): FakeCompressor { return this.make(new FakeCompressor(this, 'compressor', this.nextId++)); }
  createStereoPanner(): FakePanner { return this.make(new FakePanner(this, 'panner', this.nextId++)); }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): FakeBuffer {
    this.buffersCreated += 1;
    return new FakeBuffer(numberOfChannels, length, sampleRate);
  }

  resume(): Promise<void> {
    if (this.state === 'suspended' || this.state === 'interrupted') {
      this.state = 'running';
      this.fireStateChange();
    }
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    this.state = 'suspended';
    this.fireStateChange();
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = 'closed';
    this.fireStateChange();
    return Promise.resolve();
  }

  /** Every automation event on every param, flattened, for the sampling tests. */
  automation(filter?: (p: FakeParam) => boolean): { param: FakeParam; event: AutomationEvent }[] {
    const out: { param: FakeParam; event: AutomationEvent }[] = [];
    for (const p of this.params) {
      if (filter !== undefined && !filter(p)) continue;
      for (const event of p.events) out.push({ param: p, event });
    }
    return out;
  }

  private make<T extends FakeNode>(node: T): T {
    this.constructions[node.kind] += 1;
    this.nodes.push(node);
    return node;
  }

  private fireStateChange(): void {
    const handler = this.onstatechange;
    if (handler !== null) (handler as () => void)();
  }
}

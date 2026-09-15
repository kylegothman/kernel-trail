/**
 * The score's sustained layers: three detuned oscillators through a lowpass
 * whose cutoff a slow LFO moves, plus a gate the pulse layer switches.
 * The Score owns `level`; this voice never applies an envelope of its own.
 */
import type { BiquadLike, GainLike, OscillatorLike } from '../context';
import { clampHz } from '../synth/filters';
import { rampExp } from '../synth/envelope';
import { Voice, type VoiceHost, type VoiceParams } from './Voice';

export class DroneVoice extends Voice {
  readonly kind = 'drone' as const;
  private readonly oscA: OscillatorLike;
  private readonly oscB: OscillatorLike;
  private readonly oscC: OscillatorLike;
  private readonly filter: BiquadLike;
  private readonly lfo: OscillatorLike;
  private readonly lfoDepth: GainLike;
  private readonly gateNode: GainLike;

  constructor(host: VoiceHost) {
    super(host);
    const ctx = host.ctx;
    this.oscA = this.trackSource(ctx.createOscillator());
    this.oscB = this.trackSource(ctx.createOscillator());
    this.oscC = this.trackSource(ctx.createOscillator());
    this.oscA.type = 'sawtooth';
    this.oscB.type = 'sawtooth';
    this.oscC.type = 'sine';
    this.filter = this.track(ctx.createBiquadFilter());
    this.filter.type = 'lowpass';
    this.filter.Q.value = 0.9;
    this.lfo = this.trackSource(ctx.createOscillator());
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 0.07;
    this.lfoDepth = this.track(ctx.createGain());
    this.lfoDepth.gain.value = 0;
    this.gateNode = this.track(ctx.createGain());
    this.gateNode.gain.value = 1;
    this.oscA.connect(this.filter);
    this.oscB.connect(this.filter);
    this.oscC.connect(this.filter);
    this.lfo.connect(this.lfoDepth);
    this.lfoDepth.connect(this.filter.frequency);
    this.filter.connect(this.gateNode);
    this.gateNode.connect(this.out);
  }

  /** The pulse layer's gate. Steps are correct here; it is a gate, not a level. */
  get gate(): GainLike['gain'] {
    return this.gateNode.gain;
  }

  start(when: number, params: VoiceParams): void {
    this.begin(when, params);
    const hz = clampHz(params.hz ?? 110);
    this.oscA.frequency.setValueAtTime(hz, when);
    this.oscB.frequency.setValueAtTime(hz, when);
    this.oscC.frequency.setValueAtTime(hz / 2, when);
    this.oscB.detune.setValueAtTime(params.detuneCents ?? 6, when);
    const cutoff = clampHz(params.filterHz ?? hz * 6);
    this.filter.frequency.setValueAtTime(cutoff, when);
    this.lfoDepth.gain.setValueAtTime(cutoff * 0.25, when);
    this.gateNode.gain.setValueAtTime(1, when);
    this.sustainLevel = params.gain ?? 0.3;
    // A layer: the Score ramps `level`, and the voice stays busy until disposed.
  }

  setPitch(hz: number, when: number, seconds: number): void {
    const target = clampHz(hz);
    for (const osc of [this.oscA, this.oscB]) {
      osc.frequency.cancelScheduledValues(when);
      osc.frequency.setValueAtTime(clampHz(osc.frequency.value), when);
      rampExp(osc.frequency, target, when + Math.max(0.001, seconds));
    }
    this.oscC.frequency.cancelScheduledValues(when);
    this.oscC.frequency.setValueAtTime(clampHz(this.oscC.frequency.value), when);
    rampExp(this.oscC.frequency, target / 2, when + Math.max(0.001, seconds));
  }

  /** Detune the second oscillator so the layer beats against the bed. */
  setDetune(cents: number, when: number, seconds: number): void {
    this.oscB.detune.cancelScheduledValues(when);
    this.oscB.detune.setValueAtTime(this.oscB.detune.value, when);
    this.oscB.detune.linearRampToValueAtTime(cents, when + Math.max(0.001, seconds));
  }
}

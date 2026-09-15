/**
 * The adaptive score, package section 5. Five layers whose gains follow the
 * load model; the only event-driven moments are the derezz duck, the alarm
 * swell, the deadlock hold and the panic stop. Layer gains change only
 * through a ramp of at least `DUR.travel` along `EASE.settle` (pre-flight
 * ruling C1), never through a step.
 */
import { DUR, EASE } from '@design/motion';
import { RampTracker } from '../synth/envelope';
import { pitchHz } from '../synth/tuning';
import { DEADLOCK_HOLD_MS, DEREZZ_DUCK_MS, DEREZZ_RESTORE_MS, PULSE_GATE, STRAIN_DETUNE_CENTS, TOMBSTONE_AFTER_FRACTURE_MS } from '../synth/constants';
import type { VoiceAllocator } from '../VoiceBudget';
import type { Voice, VoiceParams } from '../voices/Voice';
import { DroneVoice } from '../voices/DroneVoice';
import { NoiseVoice } from '../voices/NoiseVoice';
import { LAYERS, LAYER_IDS, type LayerId, type LayerTargets } from './layers';

const SETTLE_SECONDS = DUR.travel / 1000;
const LOOKAHEAD = 0.15;

interface LayerState {
  voice: Voice;
  tracker: RampTracker;
  /** The load-driven target, kept while ducked or held so restore knows where to go. */
  wanted: number;
}

export class Score {
  private readonly layers = new Map<LayerId, LayerState>();
  private readonly params: Record<LayerId, VoiceParams>;
  private restoreAt = -1;
  private ducked = false;
  private holdUntil = -1;
  private silenced = false;
  private nextGate = 0;
  private gateRateHz: number = PULSE_GATE.minHz;
  private lastStrain = -1;
  private lastContention = -1;
  private swells = 0;
  reducedMotion = false;

  constructor(private readonly allocator: VoiceAllocator, private rootMidi: number) {
    this.params = {
      bed: layerParams('bed', rootMidi),
      pulse: layerParams('pulse', rootMidi),
      strain: layerParams('strain', rootMidi),
      contention: layerParams('contention', rootMidi),
      alarm: layerParams('alarm', rootMidi),
    };
  }

  get alarmSwells(): number {
    return this.swells;
  }

  get isDucked(): boolean {
    return this.ducked;
  }

  get holdEndsAt(): number {
    return this.holdUntil;
  }

  layerVoice(id: LayerId): Voice | null {
    return this.layers.get(id)?.voice ?? null;
  }

  /** The modelled gain of a layer at `t`. */
  layerGainAt(id: LayerId, t: number): number {
    return this.layers.get(id)?.tracker.valueAt(t) ?? 0;
  }

  /** Acquire the five layer voices and bring the bed up. */
  start(when: number): void {
    for (const id of LAYER_IDS) {
      const spec = LAYERS[id];
      const voice = this.allocator.acquire(spec.kind, 'score', when, id === 'alarm');
      if (voice === null) continue;
      voice.start(when, this.params[id]);
      const tracker = new RampTracker(0, EASE.settle);
      tracker.hold(0, when);
      this.layers.set(id, { voice, tracker, wanted: id === 'bed' ? 1 : 0 });
    }
    this.nextGate = when;
    const bed = this.layers.get('bed');
    if (bed !== undefined) bed.tracker.rampTo(bed.voice.level, LAYERS.bed.maxGain, when, SETTLE_SECONDS);
  }

  /** Transpose every layer. One number per leg, package section 4. */
  setRoot(midi: number, when: number): void {
    this.rootMidi = midi;
    for (const id of LAYER_IDS) {
      const state = this.layers.get(id);
      if (state === undefined) continue;
      const spec = LAYERS[id];
      const hz = pitchHz(midi, spec.degree, spec.octave);
      if (state.voice instanceof DroneVoice) state.voice.setPitch(hz, when, SETTLE_SECONDS);
      else if (state.voice instanceof NoiseVoice) state.voice.setBand(hz, 0.4, when, SETTLE_SECONDS);
    }
  }

  /** Once per frame with the load model's targets. */
  update(now: number, targets: LayerTargets, pulseRateHz: number): void {
    if (this.silenced) return;
    for (const id of LAYER_IDS) {
      if (id === 'alarm') continue;
      const state = this.layers.get(id);
      if (state === undefined) continue;
      state.wanted = Math.min(1, Math.max(0, targets[id]));
    }
    if (now < this.holdUntil) return;
    if (this.ducked) {
      if (now < this.restoreAt) return;
      this.ducked = false;
      this.restore(now);
    } else {
      for (const id of LAYER_IDS) {
        if (id === 'alarm') continue;
        this.settle(id, now, SETTLE_SECONDS);
      }
    }
    this.shapeStrain(targets.strain, now);
    this.shapeContention(targets.contention, now);
    this.gateRateHz = Math.min(PULSE_GATE.maxHz, Math.max(PULSE_GATE.minHz, pulseRateHz));
    this.scheduleGate(now);
  }

  /** The next rising edge of the pulse gate at or after `now`. */
  nextGateTime(now: number): number {
    const period = 1 / this.gateRateHz;
    let t = this.nextGate;
    while (t < now) t += period;
    return t;
  }

  /**
   * Derezz pre-roll, package line 228 and visual bible 9.4: every layer except
   * the bed ducks to zero over 400 ms, holds through the mote, and restores over
   * 1.2 s once the tombstone has risen.
   */
  duck(now: number): void {
    if (this.silenced) return;
    for (const id of LAYER_IDS) {
      if (id === 'bed') continue;
      const state = this.layers.get(id);
      if (state === undefined) continue;
      state.tracker.linearTo(state.voice.level, 0, now, DEREZZ_DUCK_MS / 1000);
    }
    this.ducked = true;
    this.restoreAt = now + (DEREZZ_DUCK_MS + TOMBSTONE_AFTER_FRACTURE_MS) / 1000;
  }

  /** One swell and decay. Removed entirely under reduced motion. */
  swellAlarm(at: number): void {
    if (this.silenced || this.reducedMotion) return;
    const state = this.layers.get('alarm');
    if (state === undefined) return;
    this.swells += 1;
    state.tracker.rampTo(state.voice.level, LAYERS.alarm.maxGain, at, SETTLE_SECONDS);
    state.tracker.thenLinearTo(state.voice.level, 0, DUR.ambient / 1000);
  }

  /** Deadlock: nothing in the score moves until the hold ends; then the alarm. */
  hold(now: number): number {
    this.holdUntil = now + DEADLOCK_HOLD_MS / 1000;
    this.nextGate = this.holdUntil;
    this.swellAlarm(this.holdUntil);
    return this.holdUntil;
  }

  /** Panic: every layer to silence and nothing comes back until `reset`. */
  silence(now: number): void {
    for (const id of LAYER_IDS) {
      const state = this.layers.get(id);
      if (state === undefined) continue;
      state.tracker.linearTo(state.voice.level, 0, now, DUR.quick / 1000);
    }
    this.silenced = true;
  }

  /** Lift the panic silence, for a new leg. */
  reset(now: number): void {
    this.silenced = false;
    this.ducked = false;
    this.holdUntil = -1;
    const bed = this.layers.get('bed');
    if (bed !== undefined) bed.tracker.rampTo(bed.voice.level, LAYERS.bed.maxGain, now, SETTLE_SECONDS);
  }

  dispose(): void {
    for (const state of this.layers.values()) state.voice.stop(0);
    this.layers.clear();
  }

  private settle(id: LayerId, now: number, seconds: number): void {
    const state = this.layers.get(id);
    if (state === undefined) return;
    const target = state.wanted * LAYERS[id].maxGain;
    // Hysteresis: a target that moved less than this since the last ramp is not
    // worth a new curve, and re-ramping every frame chatters the automation.
    if (Math.abs(target - state.tracker.target) < 0.012) return;
    state.tracker.rampTo(state.voice.level, target, now, seconds);
  }

  private restore(now: number): void {
    for (const id of LAYER_IDS) {
      if (id === 'alarm' || id === 'bed') continue;
      this.settle(id, now, DEREZZ_RESTORE_MS / 1000);
    }
  }

  private shapeStrain(strain: number, now: number): void {
    if (Math.abs(strain - this.lastStrain) < 0.02) return;
    this.lastStrain = strain;
    const state = this.layers.get('strain');
    if (state === undefined || !(state.voice instanceof DroneVoice)) return;
    state.voice.setDetune(LAYERS.strain.detuneCents + STRAIN_DETUNE_CENTS * strain, now, SETTLE_SECONDS);
  }

  private shapeContention(contention: number, now: number): void {
    if (Math.abs(contention - this.lastContention) < 0.02) return;
    this.lastContention = contention;
    const state = this.layers.get('contention');
    if (state === undefined || !(state.voice instanceof NoiseVoice)) return;
    const spec = LAYERS.contention;
    state.voice.setBand(pitchHz(this.rootMidi, spec.degree, spec.octave), 0.3 + 2.5 * contention, now, SETTLE_SECONDS);
  }

  private scheduleGate(now: number): void {
    const state = this.layers.get('pulse');
    if (state === undefined || !(state.voice instanceof DroneVoice)) return;
    const period = 1 / this.gateRateHz;
    const open = period * PULSE_GATE.duty;
    if (this.nextGate < now) this.nextGate = now;
    while (this.nextGate < now + LOOKAHEAD) {
      state.voice.gate.setValueAtTime(1, this.nextGate);
      state.voice.gate.setValueAtTime(0, this.nextGate + open);
      this.nextGate += period;
    }
  }
}

function layerParams(id: LayerId, rootMidi: number): VoiceParams {
  const spec = LAYERS[id];
  const hz = pitchHz(rootMidi, spec.degree, spec.octave);
  return { hz, detuneCents: spec.detuneCents, filterHz: hz * spec.filterMul, gain: spec.maxGain, layer: true, pan: 0 };
}

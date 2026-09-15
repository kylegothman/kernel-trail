/**
 * Envelopes and the automation model. Package section 4: ADSR from
 * `setValueAtTime`, `linearRampToValueAtTime` and `exponentialRampToValueAtTime`,
 * and never an exponential ramp to or from exactly zero.
 */
import type { ParamLike } from '../context';
import { MIN_EXP_TARGET } from './constants';

export interface Adsr {
  /** Seconds. */
  readonly attack: number;
  readonly decay: number;
  /** Fraction of peak, 0 to 1. */
  readonly sustain: number;
  readonly release: number;
}

/** Clamp an exponential ramp target away from zero. Acceptance criterion 18. */
export function safeExpTarget(value: number): number {
  return value > MIN_EXP_TARGET ? value : MIN_EXP_TARGET;
}

/**
 * The only exponential ramp call in src/audio. The runtime assertion is the
 * second half of acceptance criterion 18: the source scan proves nothing else
 * calls the raw method, and this guard proves the clamp cannot be bypassed.
 */
export function rampExp(param: ParamLike, value: number, endTime: number): void {
  if (!Number.isFinite(value) || !Number.isFinite(endTime)) {
    throw new Error(`rampExp: non-finite target ${String(value)} or time ${String(endTime)}`);
  }
  const target = safeExpTarget(value);
  if (!(target > 0)) {
    throw new Error(`rampExp: target ${String(value)} is not a positive finite number`);
  }
  param.exponentialRampToValueAtTime(target, endTime);
}

/**
 * Attack and decay from silence at `when`. Returns the sustain level, which the
 * caller keeps for `applyRelease`, so no object is allocated per trigger.
 */
export function applyAttack(param: ParamLike, when: number, adsr: Adsr, peak: number, scale: number): number {
  const attackEnd = when + Math.max(0.001, adsr.attack * scale);
  const decayEnd = attackEnd + Math.max(0.001, adsr.decay * scale);
  const sustain = Math.max(MIN_EXP_TARGET, peak * adsr.sustain);
  param.cancelScheduledValues(when);
  param.setValueAtTime(MIN_EXP_TARGET, when);
  rampExp(param, peak, attackEnd);
  rampExp(param, sustain, decayEnd);
  return sustain;
}

/** Release from a known level. Returns the time the voice is silent. */
export function applyRelease(param: ParamLike, when: number, fromLevel: number, release: number, scale: number): number {
  const end = when + Math.max(0.002, release * scale);
  param.cancelScheduledValues(when);
  param.setValueAtTime(safeExpTarget(fromLevel), when);
  rampExp(param, MIN_EXP_TARGET, end);
  return end;
}

/**
 * One-shot cue: attack, decay, hold at sustain for `hold`, then release.
 * Returns the time the cue is silent.
 */
export function applyOneShot(param: ParamLike, when: number, adsr: Adsr, peak: number, hold: number, scale: number): number {
  const sustain = applyAttack(param, when, adsr, peak, scale);
  const releaseAt = when + (adsr.attack + adsr.decay) * scale + Math.max(0, hold);
  const end = releaseAt + Math.max(0.002, adsr.release * scale);
  param.setValueAtTime(sustain, releaseAt);
  rampExp(param, MIN_EXP_TARGET, end);
  return end;
}

/**
 * A ramp along a design easing curve. Web Audio has no eased ramp, so the curve
 * is sampled into a preallocated table and scheduled with `setValueCurveAtTime`.
 * `RampTracker` keeps the model of what was scheduled so the next ramp can start
 * from the true current value rather than stepping.
 */
export class RampTracker {
  private startValue: number;
  private endValue: number;
  private startTime = 0;
  private duration = 0;
  private readonly table: Float32Array;

  constructor(initial: number, private readonly ease: (x: number) => number, points = 48) {
    this.startValue = initial;
    this.endValue = initial;
    this.table = new Float32Array(points);
  }

  get target(): number {
    return this.endValue;
  }

  /** An optional linear tail after the main segment, for the alarm's decay. */
  private tailValue = 0;
  private tailDuration = 0;

  /** The modelled value at `t`, matching what the platform will have produced. */
  valueAt(t: number): number {
    const mainEnd = this.startTime + this.duration;
    if (this.tailDuration > 0 && t >= mainEnd) {
      if (t >= mainEnd + this.tailDuration) return this.tailValue;
      return this.endValue + (this.tailValue - this.endValue) * ((t - mainEnd) / this.tailDuration);
    }
    if (this.duration <= 0 || t >= mainEnd) return this.endValue;
    if (t <= this.startTime) return this.startValue;
    const x = (t - this.startTime) / this.duration;
    return this.startValue + (this.endValue - this.startValue) * this.ease(x);
  }

  /** Append a linear segment after the current one. Call right after `rampTo`. */
  thenLinearTo(param: ParamLike, target: number, seconds: number): void {
    this.tailValue = target;
    this.tailDuration = Math.max(0.001, seconds);
    param.linearRampToValueAtTime(target, this.startTime + this.duration + this.tailDuration);
  }

  /** Schedule an eased ramp from the modelled current value to `target`. */
  rampTo(param: ParamLike, target: number, when: number, seconds: number): void {
    const from = this.valueAt(when);
    this.startValue = from;
    this.endValue = target;
    this.startTime = when;
    this.duration = Math.max(0.001, seconds);
    this.tailDuration = 0;
    const n = this.table.length;
    for (let i = 0; i < n; i++) {
      this.table[i] = from + (target - from) * this.ease(i / (n - 1));
    }
    param.cancelScheduledValues(when);
    param.setValueAtTime(from, when);
    param.setValueCurveAtTime(this.table, when, this.duration);
  }

  /** Schedule a linear ramp; used where the package names a fixed linear beat. */
  linearTo(param: ParamLike, target: number, when: number, seconds: number): void {
    const from = this.valueAt(when);
    this.startValue = from;
    this.endValue = target;
    this.startTime = when;
    this.duration = Math.max(0.001, seconds);
    this.tailDuration = 0;
    param.cancelScheduledValues(when);
    param.setValueAtTime(from, when);
    param.linearRampToValueAtTime(target, when + this.duration);
  }

  /** Reset the model to a known held value without scheduling anything. */
  hold(value: number, at: number): void {
    this.startValue = value;
    this.endValue = value;
    this.startTime = at;
    this.duration = 0;
    this.tailDuration = 0;
  }
}

/** Identity easing, for callers that want a linear curve through the tracker. */
export const linearEase = (x: number): number => x;

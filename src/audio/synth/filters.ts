/**
 * Filter helpers and the soft-clip curve. All pure; the curve is deterministic
 * and needs no rng.
 */
import type { BiquadLike, BiquadTypeLike, ParamLike } from '../context';
import { rampExp } from './envelope';

export const MIN_FILTER_HZ = 20;
export const MAX_FILTER_HZ = 18000;

export function clampHz(hz: number): number {
  if (!Number.isFinite(hz)) return MIN_FILTER_HZ;
  return Math.min(MAX_FILTER_HZ, Math.max(MIN_FILTER_HZ, hz));
}

export function configureBiquad(node: BiquadLike, type: BiquadTypeLike, hz: number, q: number, when: number): void {
  node.type = type;
  node.frequency.setValueAtTime(clampHz(hz), when);
  node.Q.setValueAtTime(Math.max(0.0001, q), when);
}

/** Exponential frequency sweep, which is what a pitched glide sounds like. */
export function sweepHz(param: ParamLike, fromHz: number, toHz: number, when: number, seconds: number): void {
  param.cancelScheduledValues(when);
  param.setValueAtTime(clampHz(fromHz), when);
  rampExp(param, clampHz(toHz), when + Math.max(0.001, seconds));
}

/** Q for a bandpass of the given bandwidth in octaves. */
export function bandwidthToQ(octaves: number): number {
  const o = Math.max(0.05, octaves);
  return Math.sqrt(Math.pow(2, o)) / (Math.pow(2, o) - 1);
}

/**
 * A tanh soft-clip transfer curve. Symmetric, so it adds only odd harmonics and
 * reads as weight rather than fizz on the impact voices.
 */
export function softClipCurve(samples = 1024, drive = 2.5): Float32Array {
  const curve = new Float32Array(samples);
  const norm = Math.tanh(drive);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / norm;
  }
  return curve;
}

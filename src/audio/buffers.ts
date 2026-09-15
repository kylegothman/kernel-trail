/**
 * `generateBuffers(seed)`: the pure, transferable buffer set. This is the
 * contract WP-18's `bake.worker.ts` calls off the main thread and the main
 * thread calls at boot when no worker is available. The output holds only
 * `Float32Array`s, so `transferList` hands every backing store across a worker
 * boundary with zero copy, and `isAudioBufferSet` validates what comes back.
 *
 * Determinism: the only source of randomness is `createRng(seed, 'audio')`,
 * the one kernel value import this package may make (scope correction and
 * pre-flight ruling C5). Same seed, same bytes, asserted in Node.
 */
import { createRng } from '@kernel/index';
import { fillGrain, fillImpulse, fillPink, fillWhite } from './synth/noise';
import { softClipCurve } from './synth/filters';
import { GRAIN_BUFFER_SECONDS, IMPULSE_SECONDS, NOISE_SECONDS } from './synth/constants';

export const DEFAULT_SAMPLE_RATE = 48000;

export interface AudioBufferSet {
  readonly sampleRate: number;
  readonly white: Float32Array;
  readonly pink: Float32Array;
  readonly grain: Float32Array;
  readonly impulseHigh: Float32Array;
  readonly impulseMedium: Float32Array;
  readonly softClip: Float32Array;
}

export function generateBuffers(seed: number, sampleRate = DEFAULT_SAMPLE_RATE): AudioBufferSet {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError('generateBuffers: sampleRate must be a positive integer');
  }
  const rng = createRng(seed | 0, 'audio');
  const white = new Float32Array(sampleRate * NOISE_SECONDS);
  const pink = new Float32Array(sampleRate * NOISE_SECONDS);
  const grain = new Float32Array(sampleRate * GRAIN_BUFFER_SECONDS);
  const impulseHigh = new Float32Array(Math.round(sampleRate * IMPULSE_SECONDS.high));
  const impulseMedium = new Float32Array(Math.round(sampleRate * IMPULSE_SECONDS.medium));
  // Fixed fill order: each generator's draws follow the previous one's, so the
  // order is part of the contract and changing it changes every buffer.
  fillWhite(white, rng);
  fillPink(pink, rng);
  fillGrain(grain, rng);
  fillImpulse(impulseHigh, rng, sampleRate);
  fillImpulse(impulseMedium, rng, sampleRate);
  return { sampleRate, white, pink, grain, impulseHigh, impulseMedium, softClip: softClipCurve() };
}

/** The transfer list for `postMessage`, so a worker hands the set over without copying. */
export function transferList(set: AudioBufferSet): ArrayBufferLike[] {
  return [set.white.buffer, set.pink.buffer, set.grain.buffer, set.impulseHigh.buffer, set.impulseMedium.buffer, set.softClip.buffer];
}

const KEYS = ['white', 'pink', 'grain', 'impulseHigh', 'impulseMedium', 'softClip'] as const;

/** Narrow an unknown message payload to a buffer set. */
export function isAudioBufferSet(value: unknown): value is AudioBufferSet {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record['sampleRate'] !== 'number') return false;
  for (const key of KEYS) {
    if (!(record[key] instanceof Float32Array)) return false;
  }
  return true;
}

/** Byte-for-byte equality of two sets. Used by the determinism assertions. */
export function sameBuffers(a: AudioBufferSet, b: AudioBufferSet): boolean {
  if (a.sampleRate !== b.sampleRate) return false;
  for (const key of KEYS) {
    const x = a[key];
    const y = b[key];
    if (x.length !== y.length) return false;
    const bx = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    const by = new Uint8Array(y.buffer, y.byteOffset, y.byteLength);
    for (let i = 0; i < bx.length; i++) {
      if (bx[i] !== by[i]) return false;
    }
  }
  return true;
}

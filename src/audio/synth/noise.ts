/**
 * Seeded noise and impulse generators. Every draw comes from the `Rng` the
 * caller hands in, which `generateBuffers` constructs with
 * `createRng(seed, 'audio')`, so the same seed fills the same bytes.
 */
import type { Rng } from '@kernel/types';

/** Uniform white noise in [-1, 1). */
export function fillWhite(out: Float32Array, rng: Rng): void {
  for (let i = 0; i < out.length; i++) {
    out[i] = rng.next() * 2 - 1;
  }
}

/**
 * Pink noise by Paul Kellet's economy filter. The coefficients are the
 * published ones; the state starts at zero so the output is a pure function of
 * the draws.
 */
export function fillPink(out: Float32Array, rng: Rng): void {
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < out.length; i++) {
    const white = rng.next() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    out[i] = (b0 + b1 + b2 + white * 0.1848) * 0.25;
  }
}

/**
 * Exponentially decaying noise, the impulse the convolver reads. `decayDb` is
 * the level at the end of the buffer relative to the start; sixty decibels is
 * the conventional reverberation time.
 */
export function fillImpulse(out: Float32Array, rng: Rng, sampleRate: number, decayDb = 60): void {
  const seconds = out.length / sampleRate;
  const k = (decayDb / 20) * Math.LN10 / Math.max(seconds, 1e-3);
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate;
    out[i] = (rng.next() * 2 - 1) * Math.exp(-k * t);
  }
}

/**
 * Grain material: white noise with a slow random amplitude walk so consecutive
 * grains read from different textures rather than one flat hiss.
 */
export function fillGrain(out: Float32Array, rng: Rng): void {
  let level = 0.7;
  for (let i = 0; i < out.length; i++) {
    if ((i & 1023) === 0) level = 0.4 + rng.next() * 0.6;
    out[i] = (rng.next() * 2 - 1) * level;
  }
}

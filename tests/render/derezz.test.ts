import { describe, expect, it } from 'vitest';
import { BoxGeometry } from 'three/webgpu';
import { cellForBounds, fracture, fractureForTier } from '../../src/render/derezz/fracture';
import { DEREZZ_VARIANTS, DEREZZ_BEATS, DEREZZ_TIMING, TERMINATION_REASONS } from '../../src/render/derezz/variants';

const rng = (seed = 1) => ({ next: () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; } });

describe('derezz fracture', () => {
  it('is deterministic and carries all fracture attributes', () => {
    const source = new BoxGeometry(1, 1, 1);
    const a = fracture(source, 0.12, rng(42));
    const b = fracture(source, 0.12, rng(42));
    for (const name of ['position', 'aCentroid', 'aRandom', 'aSeed', 'aSurface']) expect(Array.from(a.geometry.getAttribute(name).array as ArrayLike<number>)).toEqual(Array.from(b.geometry.getAttribute(name).array as ArrayLike<number>));
    expect(a.geometry.getAttribute('position').count).toBe(a.cubes * 36);
    expect(a.geometry.getAttribute('aSurface').count).toBe(a.cubes * 36);
    source.dispose(); a.geometry.dispose(); b.geometry.dispose();
  });

  it('uses named and anonymous cells, scales to tier caps, and marks interior cubes', () => {
    const source = new BoxGeometry(1, 1, 1);
    expect(cellForBounds(source, true)).toBe(0.06);
    expect(cellForBounds(source, false)).toBe(0.12);
    const large = new BoxGeometry(5, 5, 5);
    expect(cellForBounds(large, false)).toBe(0.2);
    const low = fractureForTier(source, true, 'low', rng(1));
    const medium = fractureForTier(source, true, 'medium', rng(1));
    const high = fractureForTier(source, true, 'high', rng(1));
    expect(low.cubes).toBeLessThanOrEqual(600);
    expect(medium.cubes).toBeLessThanOrEqual(1800);
    expect(high.cubes).toBeLessThanOrEqual(4096);
    expect(Array.from(high.geometry.getAttribute('aSurface').array as ArrayLike<number>)).toContain(0);
    source.dispose(); large.dispose(); low.geometry.dispose(); medium.geometry.dispose(); high.geometry.dispose();
  });

  it('defines ten distinct termination uniforms and the documented timing', () => {
    expect(TERMINATION_REASONS).toHaveLength(10);
    const signatures = new Set(TERMINATION_REASONS.map((reason) => JSON.stringify(DEREZZ_VARIANTS[reason])));
    expect(signatures.size).toBe(10);
    expect(DEREZZ_VARIANTS.starvation.spike).toBe(0);
    expect(DEREZZ_VARIANTS.deadlock_victim.freezeStart).toBe(0.45);
    expect(DEREZZ_VARIANTS.deadlock_victim.freezeDuration).toBe(0.2);
    expect(DEREZZ_VARIANTS.out_of_memory.collapse).toBe(-1);
    expect(DEREZZ_VARIANTS.protection_fault.plane).toBe(true);
    expect(DEREZZ_TIMING.convoy.preRoll).toBe(400);
    expect(DEREZZ_TIMING.convoy.release).toBe(4700);
    expect(DEREZZ_TIMING.anonymous.total).toBe(520);
    expect(DEREZZ_BEATS.map((beat) => beat.name)).toEqual(['pre_roll', 'fracture', 'spike', 'scatter', 'fade', 'mote', 'fall', 'tombstone']);
  });
});

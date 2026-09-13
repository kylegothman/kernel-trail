import { describe, expect, it } from 'vitest';
import { contiguousFragmentation, pagingFragmentation } from '@kernel/memory/fragmentation';
import { DEFAULT_REPLACEMENT_SCOPE, framesPerProcess, validateFrameBudget } from '@kernel/memory/rations';
import type { Rations } from '@kernel/memory/rations';
import { asPid } from '@kernel/types';

describe('fragmentation metrics', () => {
  it.each([
    [8, 4, 1], [16, 256, 2], [32, 1024, 4],
    [64, 4096, 8], [128, 8192, 16], [512, 65536, 32],
  ])('MEM-FRAG-1: paging has literal zero external fragmentation with %i frames, %i byte pages and %i processes', (totalFrames, pageSize, count) => {
    const framesHeld = Math.floor(totalFrames / count);
    const allocations = Array.from({ length: count }, (_, index) => ({
      framesHeld, bytesRequested: framesHeld * pageSize - Math.min(index + 1, pageSize - 1),
    }));
    expect(pagingFragmentation(allocations, pageSize).externalFragmentation).toBe(0);
  });

  it('computes the four-process paging internal-fragmentation example exactly', () => {
    const values = [5000, 9000, 1, 4096].map(bytesRequested => ({ framesHeld: Math.ceil(bytesRequested / 4096), bytesRequested }));
    expect(values.map(value => pagingFragmentation([value], 4096).internalFragmentation)).toEqual([3192, 3288, 4095, 0]);
    expect(pagingFragmentation(values, 4096).internalFragmentation).toBe(10575);
  });

  it('gives zero external fragmentation for one hole and for no free memory', () => {
    expect(contiguousFragmentation([{ start: 0, size: 1024 }], []).externalFragmentation).toBe(0);
    const empty = contiguousFragmentation([], []);
    expect(empty).toEqual({ externalFragmentation: 0, internalFragmentation: 0 });
    expect(Object.values(empty).every(Number.isFinite)).toBe(true);
  });

  it('matches first-fit, best-fit and worst-fit remaining-hole arithmetic', () => {
    const holes = (sizes: readonly number[]) => sizes.map((size, index) => ({ start: index * 1000, size }));
    expect(contiguousFragmentation(holes([100, 176, 200, 300, 183]), []).externalFragmentation).toBeCloseTo(1 - 300 / 959, 9);
    expect(contiguousFragmentation(holes([100, 83, 88, 88, 174]), []).externalFragmentation).toBeCloseTo(1 - 174 / 533, 9);
    expect(contiguousFragmentation(holes([100, 83, 200, 300, 276]), []).externalFragmentation).toBeCloseTo(1 - 300 / 959, 9);
  });

  it('MEM-BUDDY-1: counts the 11 KB difference between allocated and requested bytes', () => {
    expect(contiguousFragmentation([], [{ pid: asPid(2), base: 0, limit: 32 * 1024, requested: 21 * 1024 }])
      .internalFragmentation).toBe(11 * 1024);
  });

  it('rejects malformed resident allocations instead of generating negative metrics', () => {
    expect(() => pagingFragmentation([{ framesHeld: 1, bytesRequested: 4097 }], 4096)).toThrow();
    expect(() => pagingFragmentation([{ framesHeld: 0.5, bytesRequested: 1 }], 4096)).toThrow();
    expect(() => contiguousFragmentation([], [{ pid: asPid(2), base: 0, limit: 1, requested: 2 }])).toThrow();
  });
});

describe('rations and frame budgets', () => {
  const choices: readonly Rations[] = ['generous', 'standard', 'lean', 'starved'];

  it('matches the 64-frame, eight-process rations table', () => {
    expect(choices.map(rations => framesPerProcess(rations, 64, 8))).toEqual([12, 8, 4, 3]);
  });

  it('keeps every suggested quota at least three when 40 processes share 64 frames', () => {
    expect(choices.map(rations => framesPerProcess(rations, 64, 40))).toEqual([3, 3, 3, 3]);
  });

  it('floors after the multiplier as directed, caps capacity and returns integer quotas', () => {
    expect(framesPerProcess('generous', 11, 2)).toBe(8);
    expect(framesPerProcess('generous', 64, 1)).toBe(64);
    for (let active = 1; active <= 100; active += 1) {
      expect(choices.map(rations => framesPerProcess(rations, 64, active)).every(Number.isInteger)).toBe(true);
    }
  });

  it('weights proportional shares by declared page counts and defaults replacement to local', () => {
    const options = { allocationScheme: 'proportional', pageCount: 10, totalPageCount: 40 } as const;
    expect(choices.map(rations => framesPerProcess(rations, 64, 8, options))).toEqual([24, 16, 9, 3]);
    expect(DEFAULT_REPLACEMENT_SCOPE).toBe('local');
  });

  it('separates safe quota suggestions from explicit development budget validation', () => {
    expect(() => validateFrameBudget(1, { totalFrames: 64, devBuild: true })).toThrow();
    expect(validateFrameBudget(1, { totalFrames: 64 })).toBe(3);
    expect(() => validateFrameBudget(100, { totalFrames: 64, devBuild: true })).toThrow();
    expect(validateFrameBudget(100, { totalFrames: 64 })).toBe(64);
    expect(validateFrameBudget(5, { totalFrames: 64, devBuild: true })).toBe(5);
  });

  it('handles idle allocation and physical memories smaller than the textbook minimum', () => {
    expect(framesPerProcess('standard', 64, 0)).toBe(0);
    expect(framesPerProcess('standard', 0, 1)).toBe(0);
    expect(choices.map(rations => framesPerProcess(rations, 2, 1))).toEqual([2, 2, 2, 2]);
    expect(validateFrameBudget(3, { totalFrames: 2 })).toBe(2);
  });
});

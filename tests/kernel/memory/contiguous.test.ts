import { describe, expect, it } from 'vitest';
import { HoleList, type AllocationResult, type Hole } from '@kernel/memory/contiguous/HoleList';
import { BuddyAllocator, buddyAddress, select as buddySelect } from '@kernel/memory/contiguous/buddy';
import { ALLOCATORS } from '@kernel/memory/contiguous';
import { createRng } from '@kernel/rng';
import { asPid } from '@kernel/types';
import type { AllocationStrategy, Pid } from '@kernel/types';
import { canonical } from '../canonical';

const KB = 1024;
const STRATEGIES: readonly AllocationStrategy[] = ['first_fit', 'best_fit', 'worst_fit', 'buddy'];
const REQUESTS = [212, 417, 112, 426];

function fitFixture(strategy: AllocationStrategy): HoleList {
  let next = 0;
  const holes = [100, 500, 200, 300, 600].map(size => {
    const hole = { start: next, size: size * KB };
    next += (size + 1) * KB;
    return hole;
  });
  // One occupied kilobyte separates each textbook hole from the next one.
  return new HoleList(next - KB, strategy, KB, holes);
}

function allocation(result: AllocationResult) {
  if (!result.ok) throw new Error(`unexpected allocation failure: ${result.reason}`);
  return result.partition;
}

function assertRanges(holes: readonly Readonly<Hole>[]): void {
  for (let index = 0; index < holes.length; index++) {
    const hole = holes[index]; if (hole === undefined) throw new Error('missing free hole');
    expect(hole.size).toBeGreaterThan(0);
    expect(Number.isSafeInteger(hole.start)).toBe(true);
    expect(Number.isSafeInteger(hole.size)).toBe(true);
    const previous = holes[index - 1];
    if (previous !== undefined) {
      expect(hole.start).toBeGreaterThan(previous.start);
      expect(hole.start).toBeGreaterThanOrEqual(previous.start + previous.size);
    }
  }
}

describe('contiguous textbook allocation', () => {
  it.each([
    ['MEM-FIT-1a', 'first_fit', [500, 600, 288, null], [
      [100, 288, 200, 300, 600], [100, 288, 200, 300, 183],
      [100, 176, 200, 300, 183], [100, 176, 200, 300, 183],
    ], 959, 300],
    ['MEM-FIT-1b', 'best_fit', [300, 500, 200, 600], [
      [100, 500, 200, 88, 600], [100, 83, 200, 88, 600],
      [100, 83, 88, 88, 600], [100, 83, 88, 88, 174],
    ], 533, 174],
    ['MEM-FIT-1c', 'worst_fit', [600, 500, 388, null], [
      [100, 500, 200, 300, 388], [100, 83, 200, 300, 388],
      [100, 83, 200, 300, 276], [100, 83, 200, 300, 276],
    ], 959, 300],
  ] as const)('%s reproduces each selected hole and remainder', (_name, strategy, selected, expectedHoles, free, largest) => {
    const list = fitFixture(strategy);
    for (let index = 0; index < REQUESTS.length; index++) {
      const request = REQUESTS[index]; if (request === undefined) throw new Error('missing request');
      const before = list.holes.map(hole => ({ ...hole }));
      const result = list.allocate(asPid(index + 2), request * KB);
      if (selected[index] === null) expect(result).toEqual({ ok: false, reason: 'fragmentation' });
      else {
        const partition = allocation(result);
        expect(before.find(hole => hole.start === partition.base)?.size).toBe((selected[index] ?? 0) * KB);
        expect(partition.limit).toBe(request * KB);
        expect(partition.requested).toBe(request * KB);
      }
      expect(list.holes.map(hole => hole.size / KB)).toEqual(expectedHoles[index]);
    }
    expect(list.totalFreeBytes).toBe(free * KB);
    expect(list.largestFreeHole).toBe(largest * KB);
    expect(1 - list.largestFreeHole / list.totalFreeBytes).toBeCloseTo(1 - largest / free, 9);
  });

  it('best fit places all four requests where first and worst fit strand the last', () => {
    const outcomes = ['first_fit', 'best_fit', 'worst_fit'].map(strategy => {
      if (strategy !== 'first_fit' && strategy !== 'best_fit' && strategy !== 'worst_fit') throw new Error('unknown fit strategy');
      const list = fitFixture(strategy);
      return REQUESTS.map((request, index) => list.allocate(asPid(index + 2), request * KB).ok);
    });
    expect(outcomes).toEqual([[true, true, true, false], [true, true, true, true], [true, true, true, false]]);
  });

  it('distinguishes total exhaustion from external fragmentation, including equal total free bytes', () => {
    const list = new HoleList(110, 'first_fit', 1, [{ start: 0, size: 50 }, { start: 60, size: 50 }]);
    expect(list.allocate(asPid(2), 101)).toEqual({ ok: false, reason: 'no_space' });
    expect(list.allocate(asPid(2), 75)).toEqual({ ok: false, reason: 'fragmentation' });
    expect(list.allocate(asPid(2), 100)).toEqual({ ok: false, reason: 'fragmentation' });
    expect(list.partitions).toEqual([]);
  });

  it('coalesces two adjacent released partitions and the free tail', () => {
    const list = new HoleList(100, 'first_fit', 1);
    allocation(list.allocate(asPid(2), 20)); allocation(list.allocate(asPid(3), 20));
    list.free(asPid(2)); list.free(asPid(3));
    expect(list.holes).toEqual([{ start: 0, size: 100 }]);
    expect(list.free(asPid(2))).toBe(false);
  });

  it('coalesces a freed partition with holes on both sides', () => {
    const list = new HoleList(100, 'first_fit', 1);
    for (const pid of [2, 3, 4]) allocation(list.allocate(asPid(pid), 20));
    list.free(asPid(2)); list.free(asPid(4));
    expect(list.holes).toEqual([{ start: 0, size: 20 }, { start: 40, size: 60 }]);
    list.free(asPid(3));
    expect(list.holes).toEqual([{ start: 0, size: 100 }]);
  });

  it('best and worst fit break equal-size ties by lower address', () => {
    const holes = [{ start: 100, size: 20 }, { start: 0, size: 20 }];
    expect(ALLOCATORS.best_fit.select(holes, 10)).toBe(1);
    expect(ALLOCATORS.worst_fit.select(holes, 10)).toBe(1);
    expect(ALLOCATORS.first_fit.select(holes, 10)).toBe(0);
  });

  it.each(STRATEGIES)('%s keeps holes ordered and conserves every byte over 500 seeded operations', strategy => {
    const list = new HoleList(1024, strategy, 1); const rng = createRng(0x484f4c45);
    const live: Pid[] = []; let nextPid = 2;
    for (let operation = 0; operation < 500; operation++) {
      if (live.length > 0 && rng.chance(0.45)) {
        const index = rng.int(0, live.length); const pid = live[index];
        if (pid === undefined) throw new Error('missing live allocation');
        expect(list.free(pid)).toBe(true); live.splice(index, 1);
      } else {
        const pid = asPid(nextPid++);
        if (list.allocate(pid, rng.int(1, 101)).ok) live.push(pid);
      }
      assertRanges(list.holes);
      expect(list.totalFreeBytes + list.partitions.reduce((sum, partition) => sum + partition.limit, 0)).toBe(1024);
    }
    for (const pid of live) list.free(pid);
    expect(list.holes).toEqual([{ start: 0, size: 1024 }]);
  });
});

describe('buddy allocation', () => {
  it('MEM-BUDDY-1 rounds 21 KB to 32 KB and exposes all three remaining orders', () => {
    const list = new HoleList(256 * KB, 'buddy', KB);
    const partition = allocation(list.allocate(asPid(2), 21 * KB));
    expect(partition).toEqual({ pid: asPid(2), base: 0, limit: 32 * KB, requested: 21 * KB });
    expect(partition.limit - partition.requested).toBe(11 * KB);
    expect(list.holes).toEqual([{ start: 32 * KB, size: 32 * KB }, { start: 64 * KB, size: 64 * KB }, { start: 128 * KB, size: 128 * KB }]);
    expect(list.buddyFreeLists.map((blocks, order) => ({ order, blocks })).filter(entry => entry.blocks.length > 0))
      .toEqual([{ order: 15, blocks: [32 * KB] }, { order: 16, blocks: [64 * KB] }, { order: 17, blocks: [128 * KB] }]);
    expect(list.totalFreeBytes).toBe(224 * KB);
  });

  it('coalesces the two 32 KB buddies, then returns the entire 256 KB region', () => {
    const buddy = new BuddyAllocator(256 * KB, KB);
    const first = buddy.allocate(32 * KB); const second = buddy.allocate(32 * KB); const guard = buddy.allocate(64 * KB);
    if (first === null || second === null || guard === null) throw new Error('buddy allocation failed');
    expect([first.base, second.base, guard.base]).toEqual([0, 32 * KB, 64 * KB]);
    buddy.free(first.base); buddy.free(second.base);
    expect(buddy.freeLists[16]).toEqual([0]);
    expect(buddy.freeLists[15]).toEqual([]);
    buddy.free(guard.base);
    expect(buddy.freeHoles).toEqual([{ start: 0, size: 256 * KB }]);
    expect(buddy.free(first.base)).toBe(false);
  });

  it('computes XOR buddies for 64 address/order pairs and preserves large addresses', () => {
    for (let index = 0; index < 64; index++) {
      const order = 10 + index % 6; const base = Math.floor(index / 6) * 2 ** order;
      expect(buddyAddress(base, order)).toBe(base ^ 2 ** order);
      expect(buddyAddress(buddyAddress(base, order), order)).toBe(base);
    }
    expect(buddyAddress(2 ** 32, 12)).toBe(2 ** 32 + 4096);
  });

  it('selects the smallest available order before the lowest address', () => {
    const buddy = new BuddyAllocator(256 * KB, KB, [
      { start: 0, size: 128 * KB }, { start: 192 * KB, size: 32 * KB },
    ]);
    expect(buddy.allocate(21 * KB)?.base).toBe(192 * KB);
    expect(buddySelect([{ start: 0, size: 96 * KB }, { start: 192 * KB, size: 32 * KB }], 21 * KB, KB)).toBe(0);
  });

  it('reports no_space when free bytes cannot form the required buddy block', () => {
    const list = new HoleList(256, 'buddy', 16, [{ start: 0, size: 32 }, { start: 64, size: 32 }]);
    expect(list.totalFreeBytes).toBe(64);
    expect(list.allocate(asPid(2), 40)).toEqual({ ok: false, reason: 'no_space' });
  });

  it('preserves low-level free lists and allocations across validated restore', () => {
    const first = new BuddyAllocator(256 * KB, KB);
    const block = first.allocate(21 * KB); const other = first.allocate(40 * KB);
    if (block === null || other === null) throw new Error('buddy allocation failed');
    first.free(block.base);
    const saved = first.saveState(); const encoded = canonical(saved);
    const restored = new BuddyAllocator(256 * KB, KB); restored.restoreState(structuredClone(saved));
    expect(canonical(restored.saveState())).toBe(encoded);
    expect(restored.allocate(13 * KB)).toEqual(first.allocate(13 * KB));
    expect(restored.free(other.base)).toBe(first.free(other.base));
    expect(canonical(restored.saveState())).toBe(canonical(first.saveState()));
    expect(canonical(saved)).toBe(encoded);
    const before = canonical(restored.saveState());
    const invalid: unknown[] = [null, { ...saved, minBlock: 0 }, { ...saved, freeLists: [[0]] },
      { ...saved, reserved: [{ start: 0, size: 256 * KB }] },
      { ...saved, allocations: [...saved.allocations, ...saved.allocations] }];
    for (const state of invalid) {
      expect(() => restored.restoreState(state)).toThrow();
      expect(canonical(restored.saveState())).toBe(before);
    }
  });
});

describe('strategy changes and contiguous persistence', () => {
  const swaps = STRATEGIES.flatMap(from => STRATEGIES.filter(to => from !== to).map(to => [from, to] as const));
  it.each(swaps)('%s to %s preserves live placement and the restored next allocation', (from, to) => {
    const list = new HoleList(1024, from, 16);
    allocation(list.allocate(asPid(2), 10)); allocation(list.allocate(asPid(3), 17));
    const placements = canonical(list.partitions);
    list.setStrategy(to);
    expect(canonical(list.partitions)).toBe(placements);
    const saved = list.saveState(); const encoded = canonical(saved);
    const restored = new HoleList(1024, 'first_fit', 16);
    restored.restoreState(structuredClone(saved));
    expect(canonical(restored.saveState())).toBe(encoded);
    expect(restored.holes).toEqual(list.holes);
    expect(restored.buddyFreeLists).toEqual(list.buddyFreeLists);
    expect(restored.allocate(asPid(4), 33)).toEqual(list.allocate(asPid(4), 33));
    expect(restored.free(asPid(2))).toBe(list.free(asPid(2)));
    expect(canonical(restored.saveState())).toBe(canonical(list.saveState()));
    expect(canonical(saved)).toBe(encoded);
  });

  it('buddy preserves unaligned fit partitions and leaves slivers reusable by later fit allocation', () => {
    const list = new HoleList(1024, 'first_fit', 16);
    allocation(list.allocate(asPid(2), 7)); allocation(list.allocate(asPid(3), 10));
    const before = canonical(list.partitions);
    list.setStrategy('buddy');
    expect(canonical(list.partitions)).toBe(before);
    expect(allocation(list.allocate(asPid(4), 17))).toMatchObject({ base: 32, limit: 32 });
    expect(list.holes).toContainEqual({ start: 17, size: 15 });
    list.setStrategy('first_fit');
    expect(allocation(list.allocate(asPid(5), 4))).toMatchObject({ base: 17, limit: 4 });
    for (const pid of [2, 3, 4, 5]) list.free(asPid(pid));
    list.setStrategy('buddy');
    expect(list.buddyFreeLists[10]).toEqual([0]);
  });

  it('rejects invalid requests, double allocation and incompatible buddy swaps atomically', () => {
    const list = new HoleList(1000, 'first_fit', 16); allocation(list.allocate(asPid(2), 10));
    const before = canonical(list.saveState());
    for (const operation of [() => list.allocate(asPid(2), 20), () => list.allocate(asPid(3), 0),
      () => list.allocate(asPid(3), -1), () => list.allocate(asPid(3), 1.5), () => list.setStrategy('buddy')]) {
      expect(operation).toThrow(); expect(canonical(list.saveState())).toBe(before);
    }
  });

  it('validates malformed restore data before changing fragmented live state', () => {
    const list = fitFixture('best_fit');
    allocation(list.allocate(asPid(2), 212 * KB)); allocation(list.allocate(asPid(3), 417 * KB));
    const saved = list.saveState(); const before = canonical(saved);
    const first = saved.partitions[0]; if (first === undefined) throw new Error('missing saved partition');
    const invalid: unknown[] = [null, { ...saved, totalBytes: 123 }, { ...saved, strategy: 'unknown' },
      { ...saved, holes: [{ start: 0, size: 1 }, { start: 1, size: 1 }] },
      { ...saved, partitions: [...saved.partitions, first] },
      { ...saved, partitions: [{ ...first, requested: first.limit + 1 }] },
      { ...saved, holes: [{ start: 0, size: Infinity }] }, { ...saved, reserved: [] }];
    for (const state of invalid) {
      expect(() => list.restoreState(state)).toThrow();
      expect(canonical(list.saveState())).toBe(before);
    }
    const restored = new HoleList(list.totalBytes, 'first_fit', KB);
    restored.restoreState(saved);
    expect(restored.allocate(asPid(4), 112 * KB)).toEqual(list.allocate(asPid(4), 112 * KB));
    expect(canonical(restored.saveState())).toBe(canonical(list.saveState()));
  });
});

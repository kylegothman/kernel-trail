import { describe, expect, it } from 'vitest';
import { createReplacementPolicy } from '@kernel/memory/replacement/registry';
import { memorySpace } from '@kernel/memory/FrameTable';
import { createRng } from '@kernel/rng';
import { asFrameId, asPageId, asTick } from '@kernel/types';
import type { Frame, MemoryContext, PageId, PageReplacementId, PageTableEntry } from '@kernel/types';

const REFERENCES = [1, 2, 3, 4, 1, 2, 5, 1, 2, 3, 4, 5];
const SPACE = memorySpace(2, 'Belady fixture space');
function simulate(id: PageReplacementId, capacity: number, references = REFERENCES): { faults: number; residents: number[][] } {
  const frames: Frame[] = Array.from({ length: capacity }, (_, index) => ({
    id: asFrameId(index), owner: null, page: null, pinned: false, loadedAtTick: null, lastAccessTick: null, referenceBit: false,
  }));
  const entries = new Map<PageId, PageTableEntry>();
  const policy = createReplacementPolicy(id); policy.reset(frames);
  const rng = createRng(1234).fork('vm');
  let faults = 0;
  const residents: number[][] = [];
  for (const [index, reference] of references.entries()) {
    const page = asPageId(reference);
    const ctx: MemoryContext = { tick: asTick(index + 1), rng, frames,
      futureReferences: references.slice(index + 1).map(asPageId), pageTable: () => entries, emit: () => {} };
    let entry = entries.get(page);
    if (entry === undefined) {
      entry = { page, frame: null, valid: false, dirty: false, referenced: false, readable: true,
        writable: true, executable: true, swapped: false, lastAccessTick: null, accessCount: 0 };
      entries.set(page, entry);
    }
    if (!entry.valid) {
      faults += 1;
      const frame = frames.find(frame => frame.owner === null) ?? frames[policy.selectVictim(ctx)];
      if (frame === undefined) throw new Error('fixture has no frame');
      if (frame.page !== null) {
        const previous = entries.get(frame.page);
        if (previous !== undefined) { previous.valid = false; previous.frame = null; }
      }
      frame.owner = SPACE; frame.page = page; entry.frame = frame.id; entry.valid = true;
      policy.onLoad(SPACE, page, frame.id, ctx);
    }
    policy.onAccess(SPACE, page, entry.frame as Frame['id'], ctx);
    residents.push(frames.flatMap(frame => frame.page === null ? [] : [frame.page]));
  }
  return { faults, residents };
}

describe('Belady anomaly and stack-algorithm bounds', () => {
  it('VM-BELADY-1: FIFO worsens from nine to ten faults with one more frame', () => {
    const three = simulate('fifo', 3); const four = simulate('fifo', 4);
    expect(three.faults).toBe(9); expect(four.faults).toBe(10);
    expect(four.faults).toBeGreaterThan(three.faults);
    expect(three.residents).toEqual([[1], [1, 2], [1, 2, 3], [4, 2, 3], [4, 1, 3], [4, 1, 2],
      [5, 1, 2], [5, 1, 2], [5, 1, 2], [5, 3, 2], [5, 3, 4], [5, 3, 4]]);
    expect(four.residents).toEqual([[1], [1, 2], [1, 2, 3], [1, 2, 3, 4], [1, 2, 3, 4], [1, 2, 3, 4],
      [5, 2, 3, 4], [5, 1, 3, 4], [5, 1, 2, 4], [5, 1, 2, 3], [4, 1, 2, 3], [4, 5, 2, 3]]);
  });

  it.each([
    ['VM-BELADY-2', 'lru', 10, 8], ['VM-BELADY-3', 'optimal', 7, 6],
  ] as const)('%s: %s improves from %i to %i faults', (_fixture, id, faults3, faults4) => {
    const three = simulate(id, 3); const four = simulate(id, 4);
    expect(three.faults).toBe(faults3); expect(four.faults).toBe(faults4);
    expect(four.faults).toBeLessThanOrEqual(three.faults);
  });

  it.each(['lru', 'optimal'] as const)('%s fault counts never increase across capacities on 100 seeded traces', id => {
    const rng = createRng(0x4b54524c);
    for (let trace = 0; trace < 100; trace += 1) {
      const references = Array.from({ length: 100 }, () => rng.int(0, 12));
      let previous = references.length;
      for (let capacity = 1; capacity <= 8; capacity += 1) {
        const result = simulate(id, capacity, references);
        expect(result.faults).toBeLessThanOrEqual(previous);
        previous = result.faults;
      }
    }
  });

  it.each(['lru', 'optimal'] as const)('%s has the stack-algorithm count bound for capacities one through seven on the Belady string', id => {
    for (let capacity = 1; capacity <= 6; capacity += 1) {
      expect(simulate(id, capacity + 1).faults).toBeLessThanOrEqual(simulate(id, capacity).faults);
    }
  });
});

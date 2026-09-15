import { describe, expect, it } from 'vitest';
import { FreeSpace, firstFreeBlock, fsBlock, validateAllocationPair } from '@kernel/fs/freeSpace';
import { KernelConfigError } from '@kernel/errors';
import { createStreamRegistry } from '@kernel/rng';
import type { BlockId, FsFreeSpaceSnapshot } from '@kernel/types';

describe('filesystem free-space methods', () => {
  it('FS-BITMAP-1 uses exactly 200 words and 800 bytes at 6400 blocks', () => {
    const space = new FreeSpace(6400); expect(space.bitmap.length).toBe(200); expect(space.overheadBytes).toBe(800);
    expect(space.allocate()).toEqual([0]); expect(space.bitmap[0]).toBe(1);
  });
  it('firstFreeBlock skips full words and finds bit 7 of word 100', () => {
    const bitmap = new Uint32Array(200).fill(0xffffffff); bitmap[100] = (0xffffffff & ~(1 << 7)) >>> 0;
    let comparisons = 0; expect(firstFreeBlock(bitmap, () => { comparisons += 1; })).toBe(3207); expect(comparisons).toBe(101);
  });
  it('a full 200-word scan performs exactly 200 comparisons', () => {
    let comparisons = 0; expect(firstFreeBlock(new Uint32Array(200).fill(0xffffffff), () => { comparisons += 1; })).toBeNull(); expect(comparisons).toBe(200);
  });
  it('finds runs and refuses scattered space without consuming it', () => {
    const space = new FreeSpace(32, 'bitmap', [fsBlock(0), fsBlock(9)]);
    expect(space.allocateRun(8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const scattered = new FreeSpace(16, 'bitmap', Array.from({ length: 8 }, (_, i) => fsBlock(i * 2))); const before = scattered.snapshot();
    expect(scattered.allocateRun(8)).toBeNull(); expect(scattered.snapshot()).toEqual(before);
  });
  it('linked-list allocation and free each touch one block with no extra disk space', () => {
    const space = new FreeSpace(100, 'linked_list'); expect(space.allocate()).toEqual([0]); expect(space.reads).toBe(1); expect(space.writes).toBe(0);
    space.release([fsBlock(0)]); expect(space.reads).toBe(1); expect(space.writes).toBe(1); expect(space.overheadBytes).toBe(0);
    expect(space.allocate()).toEqual([0]);
  });
  it('linked lists refuse contiguous requests without traversing and reject the config pair', () => {
    const space = new FreeSpace(6400, 'linked_list'); expect(space.allocateRun(2)).toBeNull(); expect(space.wordsScanned).toBe(0); expect(space.reads).toBe(0);
    expect(() => validateAllocationPair('contiguous', 'linked_list')).toThrow(KernelConfigError);
    expect(() => validateAllocationPair('extent', 'counting')).not.toThrow();
  });
  it('counting represents a 40-block run as a single pair and coalesces releases', () => {
    const space = new FreeSpace(40, 'counting'); expect(space.snapshot()).toEqual({ kind: 'counting', runs: [{ start: 0, length: 40 }] });
    expect(space.allocateRun(8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]); space.release([fsBlock(3), fsBlock(4)]);
    expect(space.snapshot()).toEqual({ kind: 'counting', runs: [{ start: 3, length: 2 }, { start: 8, length: 32 }] });
    space.release([fsBlock(5), fsBlock(6), fsBlock(7)]); expect(space.snapshot()).toEqual({ kind: 'counting', runs: [{ start: 3, length: 37 }] });
  });
  it('grouping stores at most 127 entries per free header and restores the pop order', () => {
    const space = new FreeSpace(300, 'grouping'); const saved = space.snapshot();
    expect(saved.kind).toBe('grouping'); if (saved.kind !== 'grouping') throw new Error('fixture');
    expect(saved.groups.map(group => group.entries.length)).toEqual([127, 127, 43]);
    const copy = new FreeSpace(300, 'grouping'); copy.restore(saved); expect(copy.allocate(200)).toEqual(space.allocate(200));
  });
  it.each(['bitmap', 'linked_list', 'grouping', 'counting'] as const)('%s survives seeded allocate/free and restores exact continuation', method => {
    const rng = createStreamRegistry(0x4b54524c).stream('fs'); const space = new FreeSpace(97, method, [fsBlock(0)]); const held: BlockId[] = [];
    for (let i = 0; i < 300; i += 1) {
      if (held.length > 0 && rng.chance(0.45)) { const index = rng.int(0, held.length); const [block] = held.splice(index, 1); space.release([block!]); }
      else { const allocation = space.allocate(); if (allocation !== null) held.push(...allocation); }
    }
    const snapshot = JSON.parse(JSON.stringify(space.snapshot())) as FsFreeSpaceSnapshot; const copy = new FreeSpace(97, method); copy.restore(snapshot);
    expect(copy.snapshot()).toEqual(snapshot); expect(copy.allocate(Math.min(copy.freeCount, 20))).toEqual(space.allocate(Math.min(space.freeCount, 20)));
    expect(space.isFree(fsBlock(0))).toBe(false);
  });
  it('marks partial-word padding occupied and never returns an out-of-volume block', () => {
    const space = new FreeSpace(33); expect(space.allocate(33)).toHaveLength(33); expect(space.allocate()).toBeNull(); expect(firstFreeBlock(space.bitmap)).toBeNull();
    const before = space.snapshot(); expect(() => space.restore({ kind: 'bitmap', words: [0xffffffff, 1] })).toThrow('padding'); expect(space.snapshot()).toEqual(before);
  });
  it('rejects corrupt/cyclic snapshots atomically', () => {
    const space = new FreeSpace(4, 'linked_list'); const before = space.snapshot();
    expect(() => space.restore({ kind: 'linked_list', head: fsBlock(1), nodes: [{ block: fsBlock(1), next: fsBlock(1) }] })).toThrow('chain');
    expect(space.snapshot()).toEqual(before); expect(() => space.release([fsBlock(0)])).toThrow('release');
  });
});

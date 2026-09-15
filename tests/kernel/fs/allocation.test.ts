import { describe, expect, it } from 'vitest';
import { createStreamRegistry } from '@kernel/rng';
import { asTick } from '@kernel/types';
import type { DomainId, FileAllocationMethod, FsInodeSnapshot } from '@kernel/types';
import type { EmittableEvent } from '@kernel/EventBus';
import { FreeSpace, fsBlock } from '@kernel/fs/freeSpace';
import { InodeTable } from '@kernel/fs/InodeTable';
import { ALLOCATION_METHODS, allocateBlocks, allocationPolicy, fsBlockSectors, physicalReadCost, readPlan, usableBlockBytes } from '@kernel/fs/allocation/registry';

const domain = 'domain:user' as DomainId;
function file(method: FileAllocationMethod, count: number, variant: 'in_block' | 'fat' = 'in_block', capacity = 6400) {
  const table = new InodeTable(); const space = new FreeSpace(capacity, 'bitmap', [fsBlock(0)]);
  const empty = table.create({ name: 'fixture', owner: domain, tick: asTick(0), metadataBlock: fsBlock(0), method, linkedVariant: variant });
  const result = allocateBlocks(empty, Array.from({ length: count }, (_, i) => i), space, { nextGeneration: block => table.nextBlockGeneration(block) });
  if (!result.ok) throw new Error('allocation fixture failed'); table.set(result.inode);
  return { table, space, inode: result.inode, plan: result };
}

// These are the first draws from the unchanged reference root/fs stream.
const REFERENCE_INDICES = [46, 13, 13, 2, 25, 49, 42, 51, 16, 44, 49, 56, 33, 52, 25, 16, 60, 22, 50, 15];
describe('filesystem allocation policies', () => {
  it('FS-ALLOC-1 measures 699 actual chain reads from the pinned reference draws', () => {
    const rng = createStreamRegistry(0x4b54524c).stream('fs');
    const indices = Array.from({ length: 20 }, () => rng.int(0, 64));
    expect(indices).toEqual(REFERENCE_INDICES);
    const totals = ALLOCATION_METHODS.map(method => { const { inode } = file(method, 64); return indices.reduce((sum, i) => sum + readPlan(inode, [i]).reads, 0); });
    expect(totals).toEqual([20, 699, 40, 20]);
  });
  it.each([0, 1, 63, 999])('walks exactly i + 1 linked blocks for logical position %i', position => {
    expect(readPlan(file('linked', position + 1).inode, [position]).reads).toBe(position + 1);
  });
  it('FAT walks pointers in cached memory and exposes its useful capacity', () => {
    expect(readPlan(file('linked', 64, 'fat').inode, [63]).reads).toBe(1);
    expect(usableBlockBytes(file('linked', 64).inode) * 64).toBe(260096);
    expect(usableBlockBytes(file('linked', 64, 'fat').inode)).toBe(4096);
  });
  it('validates the actual cached FAT chain before its one disk read', () => {
    const { inode } = file('linked', 3, 'fat');
    if (inode.allocation.kind !== 'linked') throw new Error('fixture');
    const malformed: FsInodeSnapshot = { ...inode, allocation: { ...inode.allocation, links: inode.allocation.links.map((link, index) => index === 0 ? { ...link, next: link.block } : link) } };
    expect(() => readPlan(malformed, [2])).toThrow('chain');
  });
  it('FS-ALLOC-2 distinguishes logical run starts from sector/cylinder movement', () => {
    const table = new InodeTable(); const space = new FreeSpace(200, 'bitmap', Array.from({ length: 32 }, (_, i) => fsBlock(i)));
    const empty = table.create({ name: 'aligned', owner: domain, tick: asTick(0), metadataBlock: fsBlock(0), method: 'contiguous' });
    const allocation = allocateBlocks(empty, Array.from({ length: 64 }, (_, i) => i), space); if (!allocation.ok) throw new Error('fixture');
    const plan = readPlan(allocation.inode, Array.from({ length: 64 }, (_, i) => i), 'sequential');
    expect(plan.reads).toBe(64); expect(plan.logicalRunStarts).toBe(1);
    expect(new Set(plan.blocks.map(block => Math.floor(block / 32))).size).toBe(2);
    expect(physicalReadCost(plan.blocks, 0)).toEqual({ sectorReads: 512, cylinderTransitions: 2, headMovement: 2 });
    expect(fsBlockSectors(fsBlock(32))).toEqual([256, 257, 258, 259, 260, 261, 262, 263]);
    expect(readPlan(file('indexed', 64).inode, Array.from({ length: 64 }, (_, i) => i), 'sequential').reads).toBe(65);
    // An extent file written into a gapped free map costs 64 reads and one run start per extent.
    const { inode: extentFile, space: gapped } = file('extent', 0); gapped.reserve(Array.from({ length: 8 }, (_, i) => fsBlock(9 + i * 9)));
    const fragmented = allocateBlocks(extentFile, Array.from({ length: 64 }, (_, i) => i), gapped); if (!fragmented.ok) throw new Error('fixture');
    const extents = fragmented.inode.allocation.kind === 'extent' ? fragmented.inode.allocation.extents.length : 0; expect(extents).toBeGreaterThan(1);
    const extentPlan = readPlan(fragmented.inode, Array.from({ length: 64 }, (_, i) => i), 'sequential');
    expect(extentPlan.reads).toBe(64); expect(extentPlan.logicalRunStarts).toBe(extents);
    expect(readPlan(file('extent', 64).inode, Array.from({ length: 64 }, (_, i) => i), 'sequential').logicalRunStarts).toBe(1);
  });
  it('FS-ALLOC-3 relocates n blocks and separately counts the appended write', () => {
    const { inode, space } = file('contiguous', 8); space.reserve([fsBlock(9)]);
    const result = allocateBlocks(inode, [8], space); if (!result.ok) throw new Error('fixture');
    expect(result.relocations).toHaveLength(8); expect(result.reads).toBe(8); expect(result.writes).toBe(9);
    expect(result.freed).toEqual(inode.blocks); expect(result.inode.blocks).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect(inode.blocks.every(block => space.isFree(block))).toBe(true);
  });
  it('does not mutate space, generations or events when contiguous growth has no hole', () => {
    const { inode, space, table } = file('contiguous', 2, 'in_block', 10); space.reserve([fsBlock(3), fsBlock(5), fsBlock(7), fsBlock(9)]);
    const before = space.snapshot(); const events: EmittableEvent[] = []; let generations = 0;
    expect(allocateBlocks(inode, [2], space, { nextGeneration: block => { generations += 1; return table.nextBlockGeneration(block); }, emit: event => events.push(event) })).toEqual({ ok: false, errno: 'ENOSPC' });
    expect(space.snapshot()).toEqual(before); expect(generations).toBe(0); expect(events).toEqual([]);
  });
  it('a one-block indexed file uses one data and one actual index block', () => {
    const { inode, plan } = file('indexed', 1); expect(plan.allocated).toHaveLength(2);
    expect(inode.indexBlock).not.toBeNull(); expect(inode.blocks).toHaveLength(1);
    expect(readPlan(inode, [0]).reads).toBe(2);
  });
  it('persists sparse mappings and real multilevel index pointers', () => {
    const { inode, space, table } = file('indexed', 0); const positions = [0, 127, 128, 16511, 16512, 1000000];
    const result = allocateBlocks(inode, positions, space, { nextGeneration: block => table.nextBlockGeneration(block) }); if (!result.ok) throw new Error('fixture');
    expect(result.inode.mapping.map(entry => entry.logicalBlock)).toEqual(positions);
    expect(readPlan(result.inode, [1]).blocks).toEqual([]);
    expect(positions.map(position => readPlan(result.inode, [position]).reads)).toEqual([2, 2, 3, 3, 4, 4]);
    const restored: FsInodeSnapshot = JSON.parse(JSON.stringify(result.inode)) as FsInodeSnapshot;
    expect(readPlan(restored, positions)).toEqual(readPlan(result.inode, positions));
  });
  it('extends one extent without an extra metadata block', () => {
    const { inode, space } = file('extent', 64); expect(inode.allocation.kind === 'extent' && inode.allocation.extents).toEqual([{ logicalStart: 0, startBlock: 1, length: 64 }]);
    const result = allocateBlocks(inode, [64], space); if (!result.ok) throw new Error('fixture'); expect(result.metadataWrites).toBe(0); expect(result.writes).toBe(1);
  });
  it('emits fragmentation at five extents and a correctly labelled event for every allocated block', () => {
    const { inode, space } = file('extent', 0); space.reserve(Array.from({ length: 10 }, (_, i) => fsBlock(2 + i * 2)));
    const events: EmittableEvent[] = []; const result = allocationPolicy('extent').allocate(inode, [0, 1, 2, 3, 4], space, { emit: event => events.push(event) });
    if (!result.ok) throw new Error('fixture');
    expect(events.filter(event => event.type === 'fs.block_allocated')).toEqual(result.allocated.map(block => ({ type: 'fs.block_allocated', inode: inode.id, block, method: 'extent' })));
    expect(events.at(-1)).toEqual({ type: 'fs.fragmented', inode: inode.id, extents: 5 });
  });
  it('linked append counts the old pointer write, while FAT changes separate metadata', () => {
    for (const variant of ['in_block', 'fat'] as const) {
      const { inode, space } = file('linked', 3, variant); const result = allocateBlocks(inode, [3], space); if (!result.ok) throw new Error('fixture');
      expect(result.reads).toBe(variant === 'in_block' ? 1 : 0); expect(result.writes).toBe(variant === 'in_block' ? 2 : 1); expect(result.metadataWrites).toBe(variant === 'fat' ? 1 : 0);
    }
  });
  it('resolves all four policies to stable registry objects for mixed-method files', () => {
    expect(ALLOCATION_METHODS.map(method => allocationPolicy(method).id)).toEqual(['contiguous', 'linked', 'indexed', 'extent']);
    for (const method of ALLOCATION_METHODS) expect(allocationPolicy(method)).toBe(allocationPolicy(method));
  });
});

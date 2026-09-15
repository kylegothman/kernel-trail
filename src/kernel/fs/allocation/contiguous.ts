import type { BlockId, FsInodeSnapshot } from '../../types';
import { fsBlock } from '../freeSpace';
import type { FreeSpace } from '../freeSpace';
import type { LayoutPlan } from './registry';

/** External fragmentation is the disk analogue of contiguous memory in spec 6.3. */
export function planContiguous(inode: FsInodeSnapshot, logicalPositions: readonly number[], space: FreeSpace): LayoutPlan | null {
  const count = Math.max(inode.mapping.at(-1)?.logicalBlock ?? -1, ...logicalPositions) + 1;
  const existing = [...inode.blocks]; let blocks = existing; const allocations: BlockId[] = [];
  const relocations: { from: BlockId; to: BlockId }[] = []; const freed: BlockId[] = [];
  if (count > existing.length) {
    const start = existing[0]; const extension = start === undefined ? null : Array.from({ length: count - existing.length }, (_, index) => fsBlock(start + existing.length + index));
    if (extension !== null && extension.every(block => space.isFree(block))) {
      space.reserve(extension); allocations.push(...extension); blocks = [...existing, ...extension];
    } else {
      const run = space.allocateRun(count); if (run === null) return null;
      allocations.push(...run); blocks = run;
      existing.forEach((from, i) => relocations.push({ from, to: run[i]! }));
      if (existing.length > 0) { space.release(existing); freed.push(...existing); }
    }
  }
  return { blocks, mapping: blocks.map((block, logicalBlock) => ({ logicalBlock, block })), allocation: { kind: 'contiguous' }, indexBlock: null,
    allocated: allocations, freed, reads: relocations.length, writes: allocations.length, metadataWrites: 0, relocations };
}

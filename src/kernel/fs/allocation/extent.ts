import type { BlockId, FsInodeSnapshot } from '../../types';
import { fsBlock } from '../freeSpace';
import type { FreeSpace } from '../freeSpace';
import type { LayoutPlan } from './registry';

export function planExtent(inode: FsInodeSnapshot, logicalPositions: readonly number[], space: FreeSpace): LayoutPlan | null {
  const mapping = inode.mapping.map(({ logicalBlock, block }) => ({ logicalBlock, block })); const allocated: BlockId[] = [];
  for (const logicalBlock of logicalPositions) {
    if (mapping.some(entry => entry.logicalBlock === logicalBlock)) continue;
    const previous = mapping.find(entry => entry.logicalBlock === logicalBlock - 1);
    const preferred = previous === undefined ? undefined : fsBlock(previous.block + 1);
    let block: BlockId | undefined;
    if (preferred !== undefined && space.isFree(preferred)) { space.reserve([preferred]); block = preferred; }
    else block = space.allocate(1)?.[0];
    if (block === undefined) return null;
    allocated.push(block); mapping.push({ logicalBlock, block });
  }
  mapping.sort((a, b) => a.logicalBlock - b.logicalBlock);
  const extents: { logicalStart: number; startBlock: BlockId; length: number }[] = [];
  for (const entry of mapping) {
    const last = extents.at(-1);
    if (last !== undefined && last.logicalStart + last.length === entry.logicalBlock && last.startBlock + last.length === entry.block) last.length += 1;
    else extents.push({ logicalStart: entry.logicalBlock, startBlock: entry.block, length: 1 });
  }
  const previousExtents = inode.allocation.kind === 'extent' ? inode.allocation.extents.length : 0;
  return { blocks: mapping.map(entry => entry.block), mapping, allocation: { kind: 'extent', extents }, indexBlock: null, allocated, freed: [],
    reads: 0, writes: allocated.length, metadataWrites: extents.length > previousExtents ? 1 : 0, relocations: [] };
}

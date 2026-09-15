import type { FsInodeSnapshot } from '../../types';
import type { FreeSpace } from '../freeSpace';
import type { LayoutPlan } from './registry';

export const LINKED_USABLE_BYTES = 4096 - 32;
export function planLinked(inode: FsInodeSnapshot, logicalPositions: readonly number[], space: FreeSpace): LayoutPlan | null {
  const additions = logicalPositions.filter(position => !inode.mapping.some(entry => entry.logicalBlock === position));
  const allocated = space.allocate(additions.length); if (allocated === null) return null;
  const mapping = [...inode.mapping.map(({ logicalBlock, block }) => ({ logicalBlock, block })), ...allocated.map((block, index) => ({ logicalBlock: additions[index]!, block }))].sort((a, b) => a.logicalBlock - b.logicalBlock);
  const blocks = mapping.map(entry => entry.block);
  const variant = inode.allocation.kind === 'linked' ? inode.allocation.variant : 'in_block';
  const oldLinks = inode.allocation.kind === 'linked' ? new Map(inode.allocation.links.map(link => [link.block, link.next])) : new Map();
  const links = blocks.map((block, i) => ({ block, next: blocks[i + 1] ?? null }));
  const changedOld = links.filter(link => oldLinks.has(link.block) && oldLinks.get(link.block) !== link.next).length;
  // In-block append writes the old tail pointer as well as the new data block.
  return { blocks, mapping, allocation: { kind: 'linked', variant, links }, indexBlock: null, allocated, freed: [],
    reads: variant === 'in_block' ? changedOld : 0, writes: allocated.length + (variant === 'in_block' ? changedOld : 0), metadataWrites: variant === 'fat' && additions.length > 0 ? 1 : 0, relocations: [] };
}

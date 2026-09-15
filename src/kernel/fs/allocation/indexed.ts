import type { BlockId, FsInodeSnapshot } from '../../types';
import type { FreeSpace } from '../freeSpace';
import type { LayoutPlan } from './registry';

interface IndexNode { block: BlockId; level: 1 | 2 | 3; pointers: (BlockId | null)[] }
export function indexedAddress(logicalBlock: number): { logicalStart: number; level: 1 | 2 | 3; indices: number[] } {
  if (logicalBlock < 128) return { logicalStart: 0, level: 1, indices: [logicalBlock] };
  if (logicalBlock < 128 + 128 ** 2) { const p = logicalBlock - 128; return { logicalStart: 128, level: 2, indices: [Math.floor(p / 128), p % 128] }; }
  const p = logicalBlock - 128 - 128 ** 2;
  if (p >= 128 ** 3) return { logicalStart: 128 + 128 ** 2 + 128 ** 3, level: 1, indices: [p - 128 ** 3] };
  return { logicalStart: 128 + 128 ** 2, level: 3, indices: [Math.floor(p / 128 ** 2), Math.floor(p / 128) % 128, p % 128] };
}

/** A one-block file consumes a whole index block: 100 percent small-file overhead. */
export function planIndexed(inode: FsInodeSnapshot, logicalPositions: readonly number[], space: FreeSpace): LayoutPlan | null {
  const roots = inode.allocation.kind === 'indexed' ? inode.allocation.roots.map(root => ({ ...root })) : [];
  const nodes: IndexNode[] = inode.allocation.kind === 'indexed' ? inode.allocation.nodes.map(node => ({ ...node, pointers: [...node.pointers] })) : [];
  const mapping = inode.mapping.map(({ logicalBlock, block }) => ({ logicalBlock, block })); const allocated: BlockId[] = []; const touched = new Set<BlockId>();
  const addNode = (level: 1 | 2 | 3): IndexNode | null => { const block = space.allocate(1)?.[0]; if (block === undefined) return null; const node: IndexNode = { block, level, pointers: Array.from({ length: 128 }, () => null) }; nodes.push(node); allocated.push(block); touched.add(block); return node; };
  for (const logicalBlock of logicalPositions) {
    if (mapping.some(entry => entry.logicalBlock === logicalBlock)) continue;
    const address = indexedAddress(logicalBlock); let root = roots.find(entry => entry.logicalStart === address.logicalStart);
    if (root === undefined) { const node = addNode(address.level); if (node === null) return null; root = { logicalStart: address.logicalStart, level: address.level, block: node.block }; roots.push(root); }
    let node = nodes.find(entry => entry.block === root.block)!;
    for (let depth = 0; depth < address.indices.length; depth += 1) {
      const index = address.indices[depth]!; if (index < 0 || index >= 128) return null;
      if (depth === address.indices.length - 1) {
        const block = space.allocate(1)?.[0]; if (block === undefined) return null;
        allocated.push(block); node.pointers[index] = block; touched.add(node.block); mapping.push({ logicalBlock, block });
      } else {
        let next = node.pointers[index];
        if (next === null || next === undefined) {
          const child = addNode(node.level === 3 ? 2 : 1); if (child === null) return null;
          next = child.block; node.pointers[index] = next; touched.add(node.block);
        }
        const child = nodes.find(entry => entry.block === next); if (child === undefined) return null; node = child;
      }
    }
  }
  mapping.sort((a, b) => a.logicalBlock - b.logicalBlock); roots.sort((a, b) => a.logicalStart - b.logicalStart); nodes.sort((a, b) => a.block - b.block);
  const oldNodes = new Set(inode.allocation.kind === 'indexed' ? inode.allocation.nodes.map(node => node.block) : []);
  const dataWrites = mapping.length - inode.mapping.length;
  return { blocks: mapping.map(entry => entry.block), mapping, allocation: { kind: 'indexed', roots, nodes }, indexBlock: roots[0]?.block ?? null, allocated, freed: [],
    reads: [...touched].filter(block => oldNodes.has(block)).length, writes: dataWrites + touched.size, metadataWrites: touched.size, relocations: [] };
}

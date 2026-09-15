import type { EmittableEvent } from '../EventBus';
import type { BlockId, FsMetadataDeltaSnapshot, FsMetadataSnapshot, FsSnapshotState, InodeId, Tick } from '../types';
import { FreeSpace } from './freeSpace';
import { emptyMetadataDelta, type Mutable, type MutableFsPayload } from './journal';

type Corruption = FsSnapshotState['payload']['corruption'][number];
export interface FsckHost { state(): FsSnapshotState['payload']; tick(): Tick; emit(event: EmittableEvent): void }

export function reservedFsBlocks(state: FsSnapshotState['payload']): BlockId[] {
  const volume = state.volume; if (volume === null) return [];
  const result = new Set<BlockId>();
  for (let block = 0; block < Math.min(6, volume.blockCount); block++) result.add(block as BlockId);
  result.add(volume.superblock); result.add(volume.journalControlBlock);
  for (const block of [...volume.bitmapBlocks, ...volume.fatBlocks]) result.add(block);
  for (let i = 0; i < volume.journalPayloadBlocks; i++) result.add((volume.journalPayloadStart + i) as BlockId);
  return [...result].sort((a, b) => a - b);
}
export function ownedFsBlocks(metadata: FsMetadataSnapshot): BlockId[] {
  const result = new Set<BlockId>();
  for (const inode of metadata.inodes) {
    result.add(inode.metadataBlock); for (const block of inode.blocks) result.add(block);
    if (inode.indexBlock !== null) result.add(inode.indexBlock);
    if (inode.allocation.kind === 'indexed') for (const node of inode.allocation.nodes) result.add(node.block);
  }
  return [...result].sort((a, b) => a - b);
}
export function rebuiltFreeSpace(state: FsSnapshotState['payload']): FsMetadataSnapshot['freeSpace'] {
  if (state.volume === null) return structuredClone(state.metadata.freeSpace);
  const free = new FreeSpace(state.volume.blockCount, state.settings.freeSpaceMethod, reservedFsBlocks(state));
  free.reserve(ownedFsBlocks(state.metadata).filter(block => free.isFree(block))); return free.snapshot();
}

/** Diagnostics deliberately distinguish lost space from live ownership collisions. */
export function scanFileSystem(state: FsSnapshotState['payload'], tick: Tick): Corruption[] {
  if (state.volume === null) return [];
  const found: Corruption[] = [], inodes = new Map(state.metadata.inodes.map(inode => [inode.id, inode]));
  const references = new Map<InodeId, number>(), owned = new Map<BlockId, InodeId>();
  const record = (kind: Corruption['kind'], inode: InodeId | null, otherInode: InodeId | null = null,
    block: BlockId | null = null, expectedGeneration: number | null = null, observedGeneration: number | null = null) => {
    found.push({ kind, inode, otherInode, block, expectedGeneration, observedGeneration, discoveredAtTick: tick, reported: false });
  };
  for (const directory of state.metadata.directories) for (const entry of directory.entries) {
    const inode = inodes.get(entry.inode);
    if (inode === undefined || inode.generation !== entry.generation) record('dangling_entry', entry.inode, null, null,
      entry.generation, inode?.generation ?? null);
    else references.set(inode.id, (references.get(inode.id) ?? 0) + 1);
  }
  const free = new FreeSpace(state.volume.blockCount, state.settings.freeSpaceMethod, []); free.restore(state.metadata.freeSpace);
  for (const inode of state.metadata.inodes) {
    if (inode.id !== state.volume.rootInode && inode.id !== state.volume.lostFoundInode && (references.get(inode.id) ?? 0) === 0
      && !state.descriptors.some(descriptor => descriptor.inode === inode.id && descriptor.inodeGeneration === inode.generation)) record('orphan_inode', inode.id);
    const inodeBlocks = new Set([inode.metadataBlock, ...inode.blocks, ...(inode.indexBlock === null ? [] : [inode.indexBlock]),
      ...(inode.allocation.kind === 'indexed' ? inode.allocation.nodes.map(node => node.block) : [])]);
    for (const block of inodeBlocks) {
      const other = owned.get(block);
      if (other !== undefined || free.isFree(block)) record('duplicate_block', inode.id, other ?? null, block);
      owned.set(block, inode.id);
    }
  }
  const expected = new Set([...reservedFsBlocks(state), ...ownedFsBlocks(state.metadata)]);
  for (let block = 0; block < state.volume.blockCount; block++) {
    if (!free.isFree(block as BlockId) && !expected.has(block as BlockId)) record('leaked_block', null, null, block as BlockId);
  }
  return found;
}

/** A prepared repair delta can be sent through the normal durable journal path. */
export function prepareFsck(host: FsckHost): FsMetadataDeltaSnapshot {
  const state = host.state() as MutableFsPayload, before = structuredClone(state.metadata), after = structuredClone(before);
  const found = scanFileSystem(state, host.tick()), changes = emptyMetadataDelta();
  const lostFound = after.directories.find(directory => directory.inode === state.volume?.lostFoundInode);
  for (const issue of found) {
    const recoverable = issue.kind === 'orphan_inode' || issue.kind === 'leaked_block';
    host.emit({ type: 'fs.corruption', inode: issue.inode ?? state.volume!.rootInode, recoverable });
    if (issue.kind === 'orphan_inode' && issue.inode !== null && lostFound !== undefined) {
      const inode = after.inodes.find(item => item.id === issue.inode)!;
      let name = `inode-${inode.id}`;
      while (lostFound.entries.some(entry => entry.name === name)) name += '_';
      lostFound.entries.push({ name, inode: inode.id, generation: inode.generation });
      lostFound.entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      inode.linkCount = inode.kind === 'directory' ? 2 + after.directories.filter(directory => directory.parent === inode.id && directory.inode !== inode.id).length : 1;
      const directory = after.directories.find(item => item.inode === inode.id); if (directory !== undefined) directory.parent = lostFound.inode;
      host.emit({ type: 'fs.recovered', inode: inode.id, fromJournal: false });
    }
  }
  const lostFoundInode = after.inodes.find(inode => inode.id === lostFound?.inode);
  if (lostFoundInode !== undefined) lostFoundInode.linkCount = 2 + after.directories.filter(directory => directory.parent === lostFoundInode.id && directory.inode !== lostFoundInode.id).length;
  const rebuilt = rebuiltFreeSpace({ ...state, metadata: after });
  changes.freeSpace = { before: structuredClone(before.freeSpace), after: structuredClone(rebuilt) as Mutable<typeof rebuilt> };
  for (const inode of after.inodes) {
    const old = before.inodes.find(item => item.id === inode.id) ?? null;
    if (JSON.stringify(old) !== JSON.stringify(inode)) changes.inodes.push({ id: inode.id, before: old, after: inode });
  }
  for (const directory of after.directories) {
    const old = before.directories.find(item => item.inode === directory.inode) ?? null;
    if (JSON.stringify(old) !== JSON.stringify(directory)) changes.directories.push({ inode: directory.inode, before: old, after: directory });
  }
  state.counters.bitmapWordsScanned += Math.ceil((state.volume?.blockCount ?? 0) / 32);
  state.corruption = found.map(issue => ({ ...issue, reported: true }));
  return changes;
}

export function verifyFileSystem(host: FsckHost, checkOwnership = true): void {
  const state = host.state(); if (state.volume === null || state.mountState !== 'mounted') return;
  if (checkOwnership) {
    const problems = scanFileSystem(state, host.tick());
    if (problems.some(issue => issue.kind === 'duplicate_block' || issue.kind === 'leaked_block')) throw new Error('I-29: filesystem block ownership disagrees with free space');
  }
  for (const inode of state.metadata.inodes) {
    const entries = state.metadata.directories.flatMap(directory => directory.entries).filter(entry => entry.inode === inode.id && entry.generation === inode.generation).length;
    const expected = inode.kind === 'directory' ? 2 + state.metadata.directories.filter(directory => directory.parent === inode.id && directory.inode !== inode.id).length : entries;
    const unlinkedOpen = expected === 0 && state.descriptors.some(descriptor => descriptor.inode === inode.id);
    if (inode.linkCount !== expected && !unlinkedOpen) throw new Error('I-30: inode link count disagrees with directories');
  }
  const phases = new Map<number, number>();
  for (const entry of state.journal.entries) {
    const order = { begin: 0, write: 1, commit: 2, checkpoint: 3 }[entry.phase], previous = phases.get(entry.txId);
    if (previous === undefined ? order !== 0 : order < previous || order > previous + 1 || order === previous && order !== 1)
      throw new Error('I-31: invalid filesystem journal phase order');
    phases.set(entry.txId, order);
  }
}

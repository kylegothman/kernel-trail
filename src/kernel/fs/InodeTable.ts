import { KernelConfigError } from '../errors';
import type { BlockId, DomainId, FileAllocationMethod, FsDirectorySnapshot, FsFreeSpaceSnapshot, FsInodeSnapshot, FsMetadataSnapshot, Inode, InodeId, PermissionBits, Tick } from '../types';

export const FS_BLOCK_SIZE = 4096;
export const FS_POINTER_SIZE = 32;
export const POINTERS_PER_BLOCK = FS_BLOCK_SIZE / FS_POINTER_SIZE;
export const INODE_SIZE_COMPONENTS = [12 * FS_BLOCK_SIZE, POINTERS_PER_BLOCK * FS_BLOCK_SIZE, POINTERS_PER_BLOCK ** 2 * FS_BLOCK_SIZE, POINTERS_PER_BLOCK ** 3 * FS_BLOCK_SIZE] as const;
export const MAX_FILE_SIZE = INODE_SIZE_COMPONENTS.reduce((sum, size) => sum + size, 0);
export const inodeId = (id: number): InodeId => id as InodeId;

/** The cached Unix-style inode calculator is distinct from indexed allocation. */
export function inodeAddress(offset: number): { readonly logicalBlock: number; readonly reads: 1 | 2 | 3 | 4; readonly level: 0 | 1 | 2 | 3; readonly indices: readonly number[] } {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= MAX_FILE_SIZE) throw new KernelConfigError('file offset outside inode address space');
  const logicalBlock = Math.floor(offset / FS_BLOCK_SIZE);
  let position = logicalBlock;
  if (position < 12) return { logicalBlock, reads: 1, level: 0, indices: [position] };
  position -= 12;
  if (position < 128) return { logicalBlock, reads: 2, level: 1, indices: [position] };
  position -= 128;
  if (position < 128 ** 2) return { logicalBlock, reads: 3, level: 2, indices: [Math.floor(position / 128), position % 128] };
  position -= 128 ** 2;
  return { logicalBlock, reads: 4, level: 3, indices: [Math.floor(position / 128 ** 2), Math.floor(position / 128) % 128, position % 128] };
}

export interface CreateInode {
  readonly name: string;
  readonly kind?: Inode['kind'];
  readonly method?: FileAllocationMethod;
  readonly owner: DomainId;
  readonly permissions?: PermissionBits;
  readonly tick: Tick;
  readonly metadataBlock: BlockId;
  readonly symlinkTarget?: string;
  readonly programName?: string;
  readonly linkedVariant?: 'in_block' | 'fat';
  readonly id?: InodeId;
}

export function copyInode(record: FsInodeSnapshot): FsInodeSnapshot {
  return { ...record, permissions: { ...record.permissions }, blocks: [...record.blocks], mapping: record.mapping.map(entry => ({ ...entry })), allocation: record.allocation.kind === 'linked'
    ? { ...record.allocation, links: record.allocation.links.map(link => ({ ...link })) }
    : record.allocation.kind === 'indexed' ? { ...record.allocation, roots: record.allocation.roots.map(root => ({ ...root })), nodes: record.allocation.nodes.map(node => ({ ...node, pointers: [...node.pointers] })) }
      : record.allocation.kind === 'extent' ? { ...record.allocation, extents: record.allocation.extents.map(extent => ({ ...extent })) } : { kind: 'contiguous' } };
}

/** Immutable persistence records plus stable mutable objects for KernelSnapshot. */
export class InodeTable {
  readonly inodes: Inode[] = [];
  private readonly records = new Map<InodeId, FsInodeSnapshot>();
  private readonly views = new Map<InodeId, Inode>();
  private nextId = 2;
  private freeIds: InodeId[] = [];
  private readonly inodeGenerations = new Map<InodeId, number>();
  private readonly blockGenerations = new Map<BlockId, number>();

  get(id: InodeId): FsInodeSnapshot | undefined { return this.records.get(id); }
  generation(id: InodeId): number { return this.inodeGenerations.get(id) ?? 0; }
  blockGeneration(block: BlockId): number { return this.blockGenerations.get(block) ?? 0; }
  nextBlockGeneration(block: BlockId): number { const generation = this.blockGeneration(block) + 1; this.blockGenerations.set(block, generation); return generation; }
  snapshots(): FsInodeSnapshot[] { return [...this.records.values()].sort((a, b) => a.id - b.id).map(copyInode); }

  create(options: CreateInode): FsInodeSnapshot {
    const id = options.id ?? this.freeIds[0] ?? inodeId(this.nextId);
    if (!Number.isSafeInteger(id) || id < 2 || this.records.has(id)) throw new KernelConfigError('invalid or occupied inode id');
    this.freeIds = this.freeIds.filter(free => free !== id); this.nextId = Math.max(this.nextId, id + 1);
    const method = options.method ?? 'indexed'; const generation = this.generation(id) + 1;
    const kind = options.kind ?? 'file';
    const record: FsInodeSnapshot = { id, name: options.name, kind, sizeBytes: 0, method, blocks: [], indexBlock: null,
      owner: options.owner, permissions: { ...(options.permissions ?? { read: true, write: true, execute: kind === 'directory' }) },
      createdTick: options.tick, modifiedTick: options.tick, linkCount: kind === 'directory' ? 2 : 0,
      generation, metadataBlock: options.metadataBlock, symlinkTarget: options.symlinkTarget ?? null, programName: options.programName ?? null, mapping: [],
      allocation: method === 'linked' ? { kind: 'linked', variant: options.linkedVariant ?? 'in_block', links: [] }
        : method === 'indexed' ? { kind: 'indexed', roots: [], nodes: [] } : method === 'extent' ? { kind: 'extent', extents: [] } : { kind: 'contiguous' },
    };
    this.inodeGenerations.set(id, generation); this.set(record); return this.get(id)!;
  }

  set(record: FsInodeSnapshot): void {
    if (!Number.isSafeInteger(record.id) || record.id < 2 || !Number.isSafeInteger(record.generation) || record.generation < 1
      || record.method !== record.allocation.kind || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0 || record.sizeBytes > MAX_FILE_SIZE) throw new KernelConfigError('invalid inode record');
    const stored = copyInode(record); this.records.set(record.id, stored);
    this.inodeGenerations.set(record.id, Math.max(this.generation(record.id), record.generation)); this.nextId = Math.max(this.nextId, record.id + 1);
    this.freeIds = this.freeIds.filter(id => id !== record.id);
    let view = this.views.get(record.id);
    if (view === undefined || view.method !== record.method) {
      view = { id: record.id, name: record.name, kind: record.kind, sizeBytes: record.sizeBytes, method: record.method, blocks: [...record.blocks], indexBlock: record.indexBlock,
        owner: record.owner, permissions: { ...record.permissions }, createdTick: record.createdTick, modifiedTick: record.modifiedTick, linkCount: record.linkCount };
      this.views.set(record.id, view);
    } else {
      view.name = record.name; view.kind = record.kind; view.sizeBytes = record.sizeBytes; view.blocks.splice(0, view.blocks.length, ...record.blocks); view.indexBlock = record.indexBlock;
      view.owner = record.owner; view.permissions = { ...record.permissions }; view.createdTick = record.createdTick; view.modifiedTick = record.modifiedTick; view.linkCount = record.linkCount;
    }
    this.inodes.splice(0, this.inodes.length, ...[...this.views.values()].sort((a, b) => a.id - b.id));
  }

  update(id: InodeId, changes: Partial<FsInodeSnapshot>): FsInodeSnapshot {
    const previous = this.records.get(id); if (previous === undefined) throw new KernelConfigError('missing inode');
    if (changes.id !== undefined && changes.id !== id) throw new KernelConfigError('cannot change inode identity');
    this.set({ ...previous, ...changes }); return this.get(id)!;
  }

  retire(id: InodeId): FsInodeSnapshot {
    const record = this.records.get(id); if (record === undefined) throw new KernelConfigError('missing inode');
    this.records.delete(id); this.views.delete(id); this.freeIds.push(id); this.freeIds.sort((a, b) => a - b);
    this.inodes.splice(0, this.inodes.length, ...[...this.views.values()].sort((a, b) => a.id - b.id)); return record;
  }

  metadata(freeSpace: FsFreeSpaceSnapshot, directories: readonly FsDirectorySnapshot[]): FsMetadataSnapshot {
    return { nextInodeId: this.nextId, freeInodeIds: [...this.freeIds], inodeGenerations: [...this.inodeGenerations].sort(([a], [b]) => a - b).map(([inode, generation]) => ({ inode, generation })),
      blockGenerations: [...this.blockGenerations].sort(([a], [b]) => a - b).map(([block, generation]) => ({ block, generation })), inodes: this.snapshots(), directories, freeSpace };
  }

  restore(metadata: FsMetadataSnapshot): void {
    if (!Number.isSafeInteger(metadata.nextInodeId) || metadata.nextInodeId < 2 || new Set(metadata.inodes.map(record => record.id)).size !== metadata.inodes.length
      || new Set(metadata.freeInodeIds).size !== metadata.freeInodeIds.length || metadata.freeInodeIds.some((id, index) => !Number.isSafeInteger(id) || id < 2 || id >= metadata.nextInodeId || (index > 0 && id <= metadata.freeInodeIds[index - 1]!) || metadata.inodes.some(record => record.id === id))) throw new KernelConfigError('invalid inode allocator');
    const checked = new InodeTable();
    for (const entry of metadata.inodeGenerations) { if (!Number.isSafeInteger(entry.inode) || entry.inode < 2 || entry.inode >= metadata.nextInodeId || !Number.isSafeInteger(entry.generation) || entry.generation < 1 || checked.inodeGenerations.has(entry.inode)) throw new KernelConfigError('invalid inode generation'); checked.inodeGenerations.set(entry.inode, entry.generation); }
    for (const entry of metadata.blockGenerations) { if (!Number.isSafeInteger(entry.block) || entry.block < 0 || !Number.isSafeInteger(entry.generation) || entry.generation < 1 || checked.blockGenerations.has(entry.block)) throw new KernelConfigError('invalid block generation'); checked.blockGenerations.set(entry.block, entry.generation); }
    for (const record of metadata.inodes) { if (checked.generation(record.id) !== record.generation || record.id >= metadata.nextInodeId) throw new KernelConfigError('inode generation mismatch'); checked.set(record); }
    this.records.clear(); this.inodeGenerations.clear(); this.blockGenerations.clear();
    for (const id of [...this.views.keys()]) if (!checked.records.has(id)) this.views.delete(id);
    for (const [id, generation] of checked.inodeGenerations) this.inodeGenerations.set(id, generation);
    for (const [id, generation] of checked.blockGenerations) this.blockGenerations.set(id, generation);
    for (const record of checked.records.values()) this.set(record);
    this.nextId = metadata.nextInodeId; this.freeIds = [...metadata.freeInodeIds];
    this.inodes.splice(0, this.inodes.length, ...[...this.views.values()].sort((a, b) => a.id - b.id));
  }
}

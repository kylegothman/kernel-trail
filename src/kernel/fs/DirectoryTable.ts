import { KernelConfigError } from '../errors';
import type { FsDirectorySnapshot, FsInodeSnapshot, InodeId } from '../types';
import type { InodeTable } from './InodeTable';

export type DirectoryEntry = FsDirectorySnapshot['entries'][number];
interface DirectoryRecord { inode: InodeId; parent: InodeId; entries: DirectoryEntry[] }
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export class DirectoryTable {
  private readonly records = new Map<InodeId, DirectoryRecord>();
  version = 0;
  lastComparisons = 0;
  constructor(private readonly inodes?: InodeTable) {}

  create(inode: InodeId, parent: InodeId = inode): void {
    if (this.records.has(inode)) throw new KernelConfigError('directory already exists');
    this.records.set(inode, { inode, parent, entries: [] }); this.version += 1;
  }
  has(inode: InodeId): boolean { return this.records.has(inode); }
  parent(inode: InodeId): InodeId | undefined { return this.records.get(inode)?.parent; }
  list(inode: InodeId): readonly DirectoryEntry[] { return this.records.get(inode)?.entries.map(entry => ({ ...entry })) ?? []; }
  lookup(inode: InodeId, name: string): DirectoryEntry | undefined {
    this.lastComparisons = 0; const directory = this.records.get(inode); if (directory === undefined) return undefined;
    const index = this.position(directory.entries, name); const entry = directory.entries[index]; return entry?.name === name ? { ...entry } : undefined;
  }

  add(parent: InodeId, name: string, inode: FsInodeSnapshot, allowDirectory = false): void {
    this.validateName(name); const directory = this.records.get(parent); if (directory === undefined) throw new KernelConfigError('parent is not a directory');
    if (inode.kind === 'directory' && !allowDirectory) throw new KernelConfigError('hard links to directories are forbidden');
    if (inode.kind === 'directory' && (!this.records.has(inode.id) || this.parent(inode.id) !== parent || this.contains(inode.id, parent))) throw new KernelConfigError('directory link would introduce a cycle');
    const position = this.position(directory.entries, name); if (directory.entries[position]?.name === name) throw new KernelConfigError('directory name already exists');
    directory.entries.splice(position, 0, { name, inode: inode.id, generation: inode.generation });
    if (this.inodes !== undefined) {
      if (inode.kind === 'directory') { const record = this.inodes.get(parent); if (record !== undefined) this.inodes.update(parent, { linkCount: record.linkCount + 1 }); }
      else this.inodes.update(inode.id, { linkCount: this.inodes.get(inode.id)!.linkCount + 1 });
    }
    this.version += 1;
  }

  unlink(parent: InodeId, name: string): DirectoryEntry | undefined {
    this.validateName(name); const directory = this.records.get(parent); if (directory === undefined) return undefined;
    const index = this.position(directory.entries, name); const entry = directory.entries[index]; if (entry?.name !== name) return undefined;
    const target = this.inodes?.get(entry.inode);
    if (target?.kind === 'directory' && this.list(target.id).length !== 0) throw new KernelConfigError('directory is not empty');
    directory.entries.splice(index, 1);
    if (target !== undefined) {
      if (target.kind === 'directory') {
        const record = this.inodes!.get(parent); if (record !== undefined) this.inodes!.update(parent, { linkCount: record.linkCount - 1 });
        this.inodes!.update(target.id, { linkCount: 0 }); this.records.delete(target.id);
      } else this.inodes!.update(target.id, { linkCount: target.linkCount - 1 });
    }
    this.version += 1; return { ...entry };
  }

  remove(inode: InodeId): void { this.records.delete(inode); this.version += 1; }
  snapshots(): FsDirectorySnapshot[] { return [...this.records.values()].sort((a, b) => a.inode - b.inode).map(record => ({ ...record, entries: record.entries.map(entry => ({ ...entry })) })); }
  restore(records: readonly FsDirectorySnapshot[]): void {
    const next = new Map<InodeId, DirectoryRecord>();
    for (const record of records) {
      if (next.has(record.inode)) throw new KernelConfigError('duplicate directory');
      let previous: string | undefined;
      for (const entry of record.entries) { this.validateName(entry.name); if (previous !== undefined && compare(previous, entry.name) >= 0) throw new KernelConfigError('directory entries are not sorted'); previous = entry.name; }
      next.set(record.inode, { ...record, entries: record.entries.map(entry => ({ ...entry })) });
    }
    for (const directory of next.values()) {
      if (!next.has(directory.parent)) throw new KernelConfigError('missing directory parent');
      const seen = new Set<InodeId>(); let cursor = directory.inode;
      for (;;) { const parent = next.get(cursor)?.parent; if (parent === undefined) throw new KernelConfigError('missing parent'); if (parent === cursor) break; if (seen.has(cursor)) throw new KernelConfigError('directory cycle'); seen.add(cursor); cursor = parent; }
    }
    this.records.clear(); for (const [id, record] of next) this.records.set(id, record); this.version += 1;
  }

  private position(entries: readonly DirectoryEntry[], name: string): number {
    let low = 0; let high = entries.length;
    while (low < high) { const middle = (low + high) >>> 1; this.lastComparisons += 1; if (compare(entries[middle]!.name, name) < 0) low = middle + 1; else high = middle; }
    return low;
  }
  private validateName(name: string): void { if (name.length === 0 || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) throw new KernelConfigError('invalid directory entry name'); }
  private contains(ancestor: InodeId, child: InodeId): boolean {
    const visited = new Set<InodeId>(); let cursor = child;
    while (!visited.has(cursor)) { if (cursor === ancestor) return true; visited.add(cursor); const parent = this.parent(cursor); if (parent === undefined || parent === cursor) return false; cursor = parent; }
    return true;
  }
}

import { KernelConfigError } from '../errors';
import type { DomainId, Errno, FsInodeSnapshot, FsSnapshotState, InodeId } from '../types';
import { DirectoryTable } from './DirectoryTable';
import { inodeId } from './InodeTable';

type CachedPath = FsSnapshotState['payload']['caches']['dentries'][number];
export type PathResult = { readonly ok: true; readonly inode: FsInodeSnapshot; readonly reads: number; readonly traversal: readonly { readonly inode: InodeId; readonly generation: number }[] }
  | { readonly ok: false; readonly errno: Errno; readonly reads: number; readonly message: string };
export interface PathHost {
  readonly inode: (id: InodeId) => FsInodeSnapshot | undefined;
  /** Host emits exactly one denial when this check returns false. */
  readonly checkExecute: (domain: DomainId, inode: InodeId) => boolean;
}

export class PathResolver {
  private readonly cache = new Map<string, CachedPath>();
  private directoryVersion: number;
  private readonly maxDepth: number;
  private readonly capacity: number;
  private readonly root: InodeId;
  constructor(private readonly host: PathHost, private readonly directories: DirectoryTable,
    options: { readonly maxSymlinkDepth?: number; readonly dentryCacheEntries?: number; readonly root?: InodeId } = {}) {
    this.maxDepth = options.maxSymlinkDepth ?? 8; this.capacity = options.dentryCacheEntries ?? 128; this.root = options.root ?? inodeId(2);
    if (!Number.isSafeInteger(this.maxDepth) || this.maxDepth < 1 || !Number.isSafeInteger(this.capacity) || this.capacity < 0) throw new KernelConfigError('invalid path settings');
    this.directoryVersion = directories.version;
  }

  resolve(path: string, cwd: InodeId, domain: DomainId): PathResult {
    if (this.directoryVersion !== this.directories.version) this.invalidate();
    if (path.length === 0) return { ok: false, errno: 'EINVAL', reads: 0, message: 'empty path' };
    if (path.includes('\0')) return { ok: false, errno: 'EINVAL', reads: 0, message: 'path contains a null character' };
    const key = this.key(cwd, path); const cached = this.cache.get(key);
    if (cached !== undefined) {
      const inode = this.host.inode(cached.inode);
      if (inode?.generation === cached.generation && cached.traversal.every(entry => this.host.inode(entry.inode)?.generation === entry.generation)) {
        for (const entry of cached.traversal) if (!this.host.checkExecute(domain, entry.inode)) return { ok: false, errno: 'EACCES', reads: 0, message: 'execute denied on cached path' };
        this.cache.delete(key); this.cache.set(key, cached); return { ok: true, inode, reads: 0, traversal: cached.traversal };
      }
      this.cache.delete(key);
    }
    let current = path.startsWith('/') ? this.root : cwd; let parts = path.split('/').filter(part => part.length !== 0);
    let reads = 0; let depth = 0; let requiresDirectory = path.endsWith('/');
    const traversal: { inode: InodeId; generation: number }[] = [];
    const traverse = (record: FsInodeSnapshot): boolean => { traversal.push({ inode: record.id, generation: record.generation }); return this.host.checkExecute(domain, record.id); };
    while (parts.length > 0) {
      const record = this.host.inode(current); const part = parts.shift()!;
      if (record === undefined) return { ok: false, errno: 'ENOENT', reads, message: `missing component ${part}` };
      // Sim spec 14 substitutes EINVAL for ENOTDIR, absent from frozen Errno.
      if (record.kind !== 'directory') return { ok: false, errno: 'EINVAL', reads, message: `not a directory before ${part}` };
      if (!traverse(record)) return { ok: false, errno: 'EACCES', reads, message: `execute denied before ${part}` };
      reads += 1;
      if (part === '.') continue;
      if (part === '..') { current = this.directories.parent(current) ?? current; continue; }
      const entry = this.directories.lookup(current, part); const child = entry === undefined ? undefined : this.host.inode(entry.inode);
      if (entry === undefined || child === undefined || child.generation !== entry.generation) return { ok: false, errno: 'ENOENT', reads, message: `missing component ${part}` };
      if (child.kind !== 'link') { current = child.id; continue; }
      depth += 1; if (depth > this.maxDepth) return { ok: false, errno: 'EINVAL', reads, message: 'maximum symlink depth exceeded' };
      const target = child.symlinkTarget;
      if (target === null || target.length === 0) return { ok: false, errno: 'ENOENT', reads, message: `empty symlink ${part}` };
      if (target.startsWith('/')) current = this.root;
      if (parts.length === 0 && target.endsWith('/')) requiresDirectory = true;
      parts = [...target.split('/').filter(piece => piece.length !== 0), ...parts];
    }
    const inode = this.host.inode(current);
    if (inode === undefined) return { ok: false, errno: 'ENOENT', reads, message: 'missing final inode' };
    if (requiresDirectory && inode.kind !== 'directory') return { ok: false, errno: 'EINVAL', reads, message: 'trailing slash requires a directory' };
    if ((traversal.length === 0 || requiresDirectory) && inode.kind === 'directory' && !traverse(inode)) return { ok: false, errno: 'EACCES', reads, message: 'execute denied on directory' };
    if (this.capacity > 0) {
      this.cache.set(key, { cwd, path, inode: inode.id, generation: inode.generation, traversal });
      while (this.cache.size > this.capacity) this.cache.delete(this.cache.keys().next().value!);
    }
    return { ok: true, inode, reads, traversal };
  }

  invalidate(): void { this.cache.clear(); this.directoryVersion = this.directories.version; }
  snapshot(): CachedPath[] { if (this.directoryVersion !== this.directories.version) this.invalidate(); return [...this.cache.values()].map(entry => ({ ...entry, traversal: entry.traversal.map(item => ({ ...item })) })); }
  restore(entries: readonly CachedPath[]): void {
    if (entries.length > this.capacity) throw new KernelConfigError('dentry cache exceeds capacity');
    const next = new Map<string, CachedPath>();
    for (const entry of entries) {
      const key = this.key(entry.cwd, entry.path);
      if (next.has(key) || this.host.inode(entry.inode)?.generation !== entry.generation || entry.traversal.some(item => this.host.inode(item.inode)?.generation !== item.generation)) throw new KernelConfigError('invalid cached inode generation');
      next.set(key, { ...entry, traversal: entry.traversal.map(item => ({ ...item })) });
    }
    this.cache.clear(); for (const [key, value] of next) this.cache.set(key, value); this.directoryVersion = this.directories.version;
  }
  private key(cwd: InodeId, path: string): string { return `${cwd}:${path.length}:${path}`; }
}

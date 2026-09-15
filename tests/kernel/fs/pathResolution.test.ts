import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DirectoryTable } from '@kernel/fs/DirectoryTable';
import { InodeTable } from '@kernel/fs/InodeTable';
import { fsBlock } from '@kernel/fs/freeSpace';
import { PathResolver } from '@kernel/fs/pathResolution';
import { createStreamRegistry } from '@kernel/rng';
import { asTick } from '@kernel/types';
import type { DomainId, FsInodeSnapshot, InodeId } from '@kernel/types';

const owner = 'domain:user' as DomainId;
function fixture(cache = 128) {
  const table = new InodeTable(); const directories = new DirectoryTable(table); let nextBlock = 0;
  const root = table.create({ name: '/', kind: 'directory', owner, tick: asTick(0), metadataBlock: fsBlock(nextBlock++) }); directories.create(root.id);
  const denied = new Set<InodeId>(); const denials: { domain: DomainId; inode: InodeId }[] = []; const checks: InodeId[] = [];
  const resolver = new PathResolver({ inode: id => table.get(id), checkExecute: (domain, id) => { checks.push(id); if (denied.has(id)) { denials.push({ domain, inode: id }); return false; } return true; } }, directories, { dentryCacheEntries: cache });
  function add(parent: InodeId, name: string, kind: FsInodeSnapshot['kind'] = 'file', target?: string): FsInodeSnapshot {
    const inode = table.create({ name, kind, owner, tick: asTick(0), metadataBlock: fsBlock(nextBlock++), ...(target === undefined ? {} : { symlinkTarget: target }) });
    if (kind === 'directory') directories.create(inode.id, parent); directories.add(parent, name, inode, kind === 'directory'); return table.get(inode.id)!;
  }
  return { table, directories, root, resolver, denied, denials, checks, add };
}

describe('directories and path resolution', () => {
  it('FS-PATH-1 charges five directory-block reads and then zero on an authorized cache hit', () => {
    const { root, add, resolver, checks } = fixture(); let parent = root; const directories = [root.id];
    for (const name of ['a', 'b', 'c', 'd']) { parent = add(parent.id, name, 'directory'); directories.push(parent.id); } const target = add(parent.id, 'e');
    const first = resolver.resolve('/a/b/c/d/e', root.id, owner); expect(first.ok && first.inode.id).toBe(target.id); expect(first.reads).toBe(5);
    expect(checks).toEqual(directories); expect(first.ok && first.traversal.map(entry => entry.inode)).toEqual(directories);
    expect(resolver.resolve('/a/b/c/d/e', root.id, owner).reads).toBe(0);
  });
  it('absolute paths start at root 2 while relative paths start at cwd', () => {
    const { root, add, resolver } = fixture(); const child = add(root.id, 'sub', 'directory'); const outer = add(root.id, 'file'); const inner = add(child.id, 'file');
    const absolute = resolver.resolve('/file', child.id, owner); const relative = resolver.resolve('file', child.id, owner);
    expect(root.id).toBe(2); expect(absolute.ok && absolute.inode.id).toBe(outer.id); expect(relative.ok && relative.inode.id).toBe(inner.id);
  });
  it('dot, dotdot and repeated separators preserve the root-parent boundary', () => {
    const { root, add, resolver } = fixture(); const sub = add(root.id, 'sub', 'directory'); const target = add(root.id, 'file');
    const result = resolver.resolve('./..///../file', sub.id, owner); expect(result.ok && result.inode.id).toBe(target.id);
    const rootResult = resolver.resolve('/../../', root.id, owner); expect(rootResult.ok && rootResult.inode.id).toBe(root.id);
  });
  it('returns ENOENT naming the missing component and EINVAL for invalid path forms', () => {
    const { root, add, resolver } = fixture(); add(root.id, 'file');
    expect(resolver.resolve('/missing/child', root.id, owner)).toMatchObject({ ok: false, errno: 'ENOENT', message: 'missing component missing' });
    // Sim spec 14 uses EINVAL for ENOTDIR because Errno has no ENOTDIR member.
    for (const path of ['', '/file/child', '/file/', '/fi\0le']) expect(resolver.resolve(path, root.id, owner)).toMatchObject({ ok: false, errno: 'EINVAL' });
  });
  it('fails an intermediate execute check once, including when the path was cached', () => {
    const { root, add, resolver, denied, denials } = fixture(); const child = add(root.id, 'private', 'directory'); add(child.id, 'file');
    expect(resolver.resolve('/private/file', root.id, owner).ok).toBe(true); denied.add(child.id);
    expect(resolver.resolve('/private/file', root.id, owner)).toMatchObject({ ok: false, errno: 'EACCES', reads: 0 }); expect(denials).toEqual([{ domain: owner, inode: child.id }]);
    resolver.invalidate(); denials.length = 0; expect(resolver.resolve('/private/file', root.id, owner)).toMatchObject({ ok: false, errno: 'EACCES', reads: 1 }); expect(denials).toHaveLength(1);
  });
  it('resolves eight links, rejects nine and rejects a symlink loop without recursion', () => {
    const { root, add, resolver } = fixture(); const target = add(root.id, 'target');
    for (let i = 8; i >= 0; i -= 1) add(root.id, `link${i}`, 'link', i === 8 ? 'target' : `link${i + 1}`);
    const eight = resolver.resolve('/link1', root.id, owner); expect(eight.ok && eight.inode.id).toBe(target.id);
    expect(resolver.resolve('/link0', root.id, owner)).toMatchObject({ ok: false, errno: 'EINVAL' });
    add(root.id, 'loop', 'link', 'loop'); expect(resolver.resolve('/loop', root.id, owner)).toMatchObject({ ok: false, errno: 'EINVAL' });
  });
  it('resolves relative symlink targets from their containing directory and preserves remaining components', () => {
    const { root, add, resolver } = fixture(); const a = add(root.id, 'a', 'directory'); const b = add(root.id, 'b', 'directory'); const file = add(b.id, 'file'); add(a.id, 'relative', 'link', '../b'); add(a.id, 'absolute', 'link', '/b');
    for (const path of ['/a/relative/file', '/a/absolute/file']) { const result = resolver.resolve(path, root.id, owner); expect(result.ok && result.inode.id).toBe(file.id); }
  });
  it('binary search over 500 sorted entries uses at most nine comparisons', () => {
    const { root, add, directories } = fixture(); for (let i = 0; i < 500; i += 1) add(root.id, `entry${i.toString().padStart(3, '0')}`);
    for (let i = 0; i < 500; i += 1) { expect(directories.lookup(root.id, `entry${i.toString().padStart(3, '0')}`)).toBeDefined(); expect(directories.lastComparisons).toBeLessThanOrEqual(9); }
  });
  it('no file system source orders names with localeCompare', () => {
    const directory = join(__dirname, '../../../src/kernel/fs');
    const files = readdirSync(directory, { recursive: true }).map(String).filter(name => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(10);
    for (const name of files) expect(readFileSync(join(directory, name), 'utf8')).not.toContain('localeCompare');
  });
  it('200 seeded random insertions produce code-unit order rather than locale order', () => {
    const { root, add, directories } = fixture(); const rng = createStreamRegistry(0x4b54524c).stream('fs'); const names = Array.from({ length: 196 }, (_, i) => `n${i}`); names.push('Z', 'a', 'ä', '_'); const remaining = [...names];
    while (remaining.length > 0) add(root.id, remaining.splice(rng.int(0, remaining.length), 1)[0]!);
    expect(directories.list(root.id).map(entry => entry.name)).toEqual(names.sort((a, b) => a < b ? -1 : a > b ? 1 : 0));
  });
  it('namespace mutation invalidates the complete cache, and hits update LRU order', () => {
    const { root, add, resolver, directories } = fixture(2); for (const name of ['a', 'b', 'c']) add(root.id, name);
    resolver.resolve('/a', root.id, owner); resolver.resolve('/b', root.id, owner); resolver.resolve('/a', root.id, owner); resolver.resolve('/c', root.id, owner);
    expect(resolver.snapshot().map(entry => entry.path)).toEqual(['/a', '/c']); expect(resolver.resolve('/b', root.id, owner).reads).toBe(1);
    directories.unlink(root.id, 'c'); expect(resolver.snapshot()).toEqual([]); expect(resolver.resolve('/a', root.id, owner).reads).toBe(1);
    add(root.id, 'directory', 'directory'); expect(resolver.resolve('/a', root.id, owner).reads).toBe(1);
  });
  it('restores cache order and rechecks restored permissions without trusting cached access', () => {
    const { root, add, resolver, directories, table, denied } = fixture(); add(root.id, 'file'); resolver.resolve('/file', root.id, owner); const saved = resolver.snapshot();
    const copy = new PathResolver({ inode: id => table.get(id), checkExecute: (_domain, id) => !denied.has(id) }, directories); copy.restore(saved); expect(copy.snapshot()).toEqual(saved);
    denied.add(root.id); expect(copy.resolve('/file', root.id, owner)).toMatchObject({ ok: false, errno: 'EACCES' });
  });
});

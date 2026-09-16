/**
 * KERNEL TRAIL: the file system commands of Leg 11.
 *
 * Every read comes from the file system payload the host exposes: inodes and
 * directories for `inode` and `lsof`, the write-ahead log for `journal`, the
 * corruption list for `fsck`, the volume for `mount`. The kernel has no mount
 * namespace and no sharing semantics, so those flags return the F19 error.
 */
import type { TerminalCommandDef } from '@game/types';
import type { FsSnapshotState, InodeId, Pid } from '@kernel/types';
import { kv, table } from '../output';
import { parseInteger } from '../parser';
import { bindOrFail, fail, ok, pidArg, unavailable, type CommandFailure, type ShippedHandler } from '../registry';
import type { ShellContext } from '../Shell';

export const INODE_DEF: TerminalCommandDef = {
  name: 'inode',
  usage: 'inode <id> [--walk] [--blocks] [--method] [--links]',
  summary: 'Show a file metadata record, its block list, and the cost of reaching a block.',
  manual: [
    'inode prints one file metadata record: size, owner, permissions, timestamps, link',
    'count, allocation method, and the blocks it occupies.',
    '',
    'The inode is the file. The name is not; names live in directories, which are just',
    'files whose contents are name-to-inode pairs. This is why a file can have two names',
    '(two directory entries pointing at one inode, link count 2) and why deleting one name',
    'does not delete the file. It decrements the link count. The blocks are freed when the',
    'count reaches zero and no process still holds it open.',
    '',
    '--walk traces the path from the inode to a chosen block and counts the reads. The',
    'count depends entirely on the allocation method:',
    '  contiguous  start block plus offset. One read, always. Requires a run of free',
    '              blocks at creation time and cannot grow past its neighbour, which is',
    '              external fragmentation again, on disk, where compaction is far more',
    '              expensive than it was in memory.',
    '  linked      each block holds a pointer to the next. Grows freely, no external',
    '              fragmentation, and reaching block n costs n reads. Random access is',
    '              effectively unavailable. A single corrupted pointer orphans the rest of',
    '              the file.',
    '  indexed     one index block holds the block numbers. Two reads for any block:',
    '              index, then data. Costs one block per file even for tiny files, and the',
    '              index block itself sets a maximum file size unless you chain or nest',
    '              index blocks.',
    '  extent      records runs of consecutive blocks as (start, length) pairs. Behaves',
    '              like contiguous when the file is unfragmented and degrades gracefully',
    '              when it is not.',
    '',
    'Match the method to the access pattern. Sequential streams do well on contiguous and',
    'extent. Anything with random access needs indexed or extent, and choosing linked for',
    'it converts every read into a walk.',
    '',
    'See also: fsck, journal, lsof, codex allocation_methods.',
  ].join('\n'),
  chapter: { chapter: 14, title: 'File-System Implementation', sections: ['14.4.1', '14.4.2', '14.4.3'] },
};

export const JOURNAL_DEF: TerminalCommandDef = {
  name: 'journal',
  usage: 'journal [--tail <n>] [--enable] [--disable] [--mode metadata|ordered|data] [--checkpoint]',
  summary: 'Show the write-ahead log and set journaling mode.',
  manual: [
    'journal prints the log of transactions with their phases: begin, write, commit,',
    'checkpoint.',
    '',
    'A file system operation touches several blocks that must change together. Appending',
    'to a file writes the data block, updates the free-space map, and updates the inode.',
    'A crash between any two of those leaves the volume inconsistent, and the inconsistency',
    'is not detectable by looking at any single block.',
    '',
    'The journal is a write-ahead log. Before touching the real structures, the intended',
    'changes are written to the log and the transaction is committed there. Only then are',
    'the real blocks updated. If a crash happens before the commit record, the transaction',
    'never happened and the log is discarded. If it happens after, recovery replays the log',
    'and finishes the job. Either way the volume ends up in a state that a complete',
    'operation would have produced.',
    '',
    'This turns recovery from a scan of the entire volume into a replay of the last few',
    'transactions, which is the difference between minutes and moments on a large volume.',
    '',
    'Modes, and this is the part that is usually assumed rather than read:',
    '  metadata  journal only the structural changes. Recovery gives you a consistent',
    '            file system quickly, and it does not promise your file contents are',
    '            right. A file can survive the crash with correct metadata pointing at',
    '            blocks that hold whatever was there before.',
    '  ordered   journal metadata, and force the data blocks out before committing the',
    '            metadata that points at them. Cheap, and it rules out the worst case',
    '            above.',
    '  data      journal everything, contents included. Every block is written twice.',
    '            Safest and slowest.',
    '',
    'Journaling costs blocks and it costs write bandwidth, continuously, whether or not a',
    'crash ever happens. That is what insurance is. Deciding after the crash is not an',
    'option the system offers.',
    '',
    'See also: fsck, devstat, sync, codex journaling.',
  ].join('\n'),
  chapter: { chapter: 14, title: 'File-System Implementation', sections: ['14.7.1', '14.7.2'] },
};

export const FSCK_DEF: TerminalCommandDef = {
  name: 'fsck',
  usage: 'fsck [--check] [--repair] [--from-journal]',
  summary: 'Check and repair file system consistency after a crash.',
  manual: [
    'fsck checks the volume for inconsistencies and repairs what it can.',
    '',
    'It looks for the specific ways a partially completed operation leaves things wrong:',
    'blocks marked free that an inode also claims, blocks claimed by two inodes, inodes',
    'with a link count that disagrees with the number of directory entries pointing at',
    'them, and inodes reachable from no directory at all.',
    '',
    '--from-journal replays the log instead of scanning. It is faster by orders of',
    'magnitude and it is available only if the journal was enabled before the crash.',
    '',
    'Understand what a successful repair means and does not mean. fsck restores structural',
    'consistency: after it runs, the metadata describes a coherent file system. It has no',
    'way to know what your data was supposed to be. An inode whose blocks were never',
    'written will be repaired into a perfectly consistent file full of stale contents, and',
    'fsck will report success, because by its definition it succeeded.',
    '',
    'Orphaned inodes, meaning files with data and no name, are placed in the lost and found',
    'directory under their inode number. Whether you can identify them afterwards is your',
    'problem.',
    '',
    'See also: journal, inode, lsof, codex crash_consistency.',
  ].join('\n'),
  chapter: { chapter: 14, title: 'File-System Implementation', sections: ['14.7.1', '14.7.4'] },
};

export const LSOF_DEF: TerminalCommandDef = {
  name: 'lsof',
  usage: 'lsof [--pid <pid>] [--unlinked] [--counts]',
  summary: 'List open files by process, including files that have been deleted but not closed.',
  manual: [
    'lsof lists every open file descriptor with the process holding it and the inode it',
    'refers to.',
    '',
    '--unlinked is the interesting one. A file whose last directory entry has been removed',
    'is not necessarily gone. Its blocks are freed only when the link count reaches zero',
    'and no process still has it open. Until then the file exists with no name: invisible',
    'in every directory, absent from every listing, and still occupying its blocks.',
    '',
    'This is why a volume can report itself full while the sum of the visible files is far',
    'less than its capacity, and why deleting more files does not help. The blocks are held',
    'by descriptors. Closing the descriptor releases them, and so does ending the process',
    'that holds it.',
    '',
    'The behaviour is deliberate rather than a defect. It lets a running program keep',
    'reading a file that has been replaced underneath it, and it lets a program create a',
    'temporary file, unlink it immediately, and rely on the system to reclaim it no matter',
    'how the program exits.',
    '',
    'See also: fsck, inode --links, codex free_space.',
  ].join('\n'),
  chapter: { chapter: 14, title: 'File-System Implementation', sections: ['14.5.1'] },
};

export const MOUNT_DEF: TerminalCommandDef = {
  name: 'mount',
  usage: 'mount [--list] [<volume> <point>] [--semantics unix|session|immutable] [--vfs]',
  summary: 'Attach a volume into the namespace and set its sharing semantics.',
  manual: [
    'mount attaches a volume at a point in the directory namespace, so that the volume',
    'contents appear under that path.',
    '',
    'A mount point is an ordinary directory whose contents are replaced by the mounted',
    'volume root while the mount stands. Programs walking the path do not know a boundary',
    'was crossed, which is the point: one namespace, several volumes, possibly several',
    'different file system implementations underneath.',
    '',
    '--vfs shows the layer that makes that work. The virtual file system defines one set',
    'of operations (open, read, write, and the rest) and each file system type implements',
    'them. Programs call the general interface. The same mechanism is what lets a remote',
    'volume appear as a local directory.',
    '',
    '--semantics decides what a reader sees while a writer is writing, and shared volumes',
    'have no default that is right for everyone:',
    '  unix       writes are visible to other readers immediately. Simple to reason about',
    '             and expensive to provide across a network.',
    '  session    writes become visible when the writer closes the file. Readers who',
    '             opened earlier keep seeing the old contents until they reopen. Cheap,',
    '             and it means two readers can disagree about the file for a while.',
    '  immutable  once shared, contents cannot change; a new version is a new file. No',
    '             consistency problem, at the cost of the ability to edit in place.',
    '',
    'Pick by asking what a stale read costs you here. On this crossing it costs a Program',
    'that follows a route the convoy has already abandoned.',
    '',
    'See also: inode, lsof, codex vfs.',
  ].join('\n'),
  chapter: { chapter: 15, title: 'File-System Internals', sections: ['15.2', '15.3', '15.5', '15.7'] },
};

type FsPayload = FsSnapshotState['payload'];
type InodeRecord = FsPayload['metadata']['inodes'][number];

function fileSystem(ctx: ShellContext, topic: string): { readonly ok: true; readonly fs: FsPayload } | CommandFailure {
  const fs = ctx.host.fs();
  return fs === null ? fail(topic, 'the file system is not enabled on this leg.') : { ok: true, fs };
}

/** The names that point at an inode, as `/dir/name` paths built from the directory table. */
export function pathsOf(fs: FsPayload, inode: InodeId): string[] {
  const root = fs.volume?.rootInode;
  const pathTo = (target: InodeId, depth: number): string[] => {
    if (target === root) return ['/'];
    if (depth > 64) return [];
    const paths: string[] = [];
    for (const directory of fs.metadata.directories) {
      for (const entry of directory.entries) {
        if (entry.inode !== target) continue;
        for (const parent of pathTo(directory.inode, depth + 1)) paths.push(parent === '/' ? `/${entry.name}` : `${parent}/${entry.name}`);
      }
    }
    return paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  };
  return pathTo(inode, 0);
}

const permissions = (inode: InodeRecord): string => `${inode.permissions.read ? 'r' : '-'}${inode.permissions.write ? 'w' : '-'}${inode.permissions.execute ? 'x' : '-'}`;

const inodeHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('inode', argv, { walk: 0, blocks: 0, method: 0, links: 0 });
    if (!bound.ok) return bound;
    const mounted = fileSystem(ctx, 'inode');
    if (!mounted.ok) return mounted;
    const id = parseInteger(bound.args.positional[0]);
    if (id === null) return fail('inode', 'inode needs a numeric inode id.');
    const inode = mounted.fs.metadata.inodes.find(row => row.id === id);
    if (inode === undefined) return fail('inode', `no inode ${id} on the volume.`, 'ENOENT');
    const lines = kv([
      ['inode', inode.id], ['name', inode.name], ['kind', inode.kind], ['size', `${inode.sizeBytes} bytes`], ['method', inode.method],
      ['owner', inode.owner], ['permissions', permissions(inode)], ['links', inode.linkCount], ['created', `tick ${inode.createdTick}`],
      ['modified', `tick ${inode.modifiedTick}`], ['blocks', inode.blocks.length], ['generation', inode.generation],
    ]);
    if (bound.args.has('blocks')) lines.push(...table(['LOGICAL', 'BLOCK'], inode.mapping.map(row => [row.logicalBlock, row.block])));
    if (bound.args.has('method')) {
      const allocation = inode.allocation;
      switch (allocation.kind) {
        case 'contiguous': lines.push(`contiguous: blocks ${inode.blocks[0] ?? '-'} to ${inode.blocks[inode.blocks.length - 1] ?? '-'}`); break;
        case 'linked': lines.push(`linked (${allocation.variant}): ${allocation.links.map(link => `${link.block}->${link.next ?? 'end'}`).join(' ')}`); break;
        case 'indexed': lines.push(`indexed: ${allocation.roots.length} root blocks, ${allocation.nodes.length} index nodes, index block ${inode.indexBlock ?? '-'}`); break;
        case 'extent': lines.push(`extent: ${allocation.extents.map(extent => `[${extent.startBlock}+${extent.length} at ${extent.logicalStart}]`).join(' ')}`); break;
      }
    }
    if (bound.args.has('walk')) {
      const reads = (logical: number): number => {
        switch (inode.allocation.kind) {
          case 'contiguous': return 1;
          case 'linked': return logical + 1;
          case 'indexed': return 1 + (inode.allocation.roots.find(root => root.logicalStart <= logical)?.level ?? 1);
          case 'extent': return 1;
        }
      };
      lines.push(...table(['LOGICAL', 'BLOCK', 'READS'], inode.mapping.map(row => [row.logicalBlock, row.block, reads(row.logicalBlock)])));
    }
    if (bound.args.has('links')) {
      const paths = pathsOf(mounted.fs, inode.id);
      lines.push(`${paths.length} names: ${paths.join(' ') || '(none: unlinked)'}`);
    }
    return ok(lines);
  },
};

const journalHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('journal', argv, { tail: 1, enable: 0, disable: 0, mode: 1, checkpoint: 0 });
    if (!bound.ok) return bound;
    for (const flag of ['enable', 'disable', 'mode', 'checkpoint'] as const) {
      if (bound.args.has(flag)) return unavailable('journal', `--${flag}`, 'the journal mode is a kernel tuning value with no write path from the shell');
    }
    const mounted = fileSystem(ctx, 'journal');
    if (!mounted.ok) return mounted;
    const tail = bound.args.has('tail') ? parseInteger(bound.args.value('tail')) : 20;
    if (tail === null || tail < 1) return fail('journal', '--tail needs a positive count.');
    const journal = mounted.fs.journal;
    const entries = journal.entries.slice(-tail);
    return ok([
      ...kv([['mode', mounted.fs.settings.journalMode], ['entries', journal.entries.length], ['checkpointed through', journal.checkpointedThrough], ['transactions in flight', journal.transactions.length]]),
      ...table(['TICK', 'TX', 'PHASE', 'BLOCKS'], entries.map(entry => [entry.tick, entry.txId, entry.phase, entry.blocks.join(',') || '-'])),
    ]);
  },
};

const fsckHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('fsck', argv, { check: 0, repair: 0, 'from-journal': 0 });
    if (!bound.ok) return bound;
    if (bound.args.has('repair')) return unavailable('fsck', '--repair', 'repair has no write path from the shell');
    if (bound.args.has('from-journal')) return unavailable('fsck', '--from-journal', 'recovery has no write path from the shell');
    const mounted = fileSystem(ctx, 'fsck');
    if (!mounted.ok) return mounted;
    const { fs } = mounted;
    return ok([
      ...kv([
        ['mount state', fs.mountState],
        ['recovery', fs.recovery === null ? 'idle' : `${fs.recovery.kind} (${fs.recovery.phase})`],
        ['inodes', fs.metadata.inodes.length], ['directories', fs.metadata.directories.length],
        ['last crash', fs.lastCrash === null ? '-' : `tick ${fs.lastCrash.tick}`],
        ['inconsistencies', fs.corruption.length],
      ]),
      ...table(['KIND', 'INODE', 'OTHER', 'BLOCK', 'FOUND', 'REPORTED'], fs.corruption.map(row => [row.kind, row.inode ?? '-', row.otherInode ?? '-', row.block ?? '-', row.discoveredAtTick, row.reported ? 'yes' : 'no'])),
    ]);
  },
};

const lsofHandler: ShippedHandler = {
  completions: [{ flag: 'pid', kind: 'pid' }],
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('lsof', argv, { pid: 1, unlinked: 0, counts: 0 });
    if (!bound.ok) return bound;
    let filter: Pid | null = null;
    if (bound.args.has('pid')) {
      const parsed = pidArg(bound.args.value('pid'), 'lsof');
      if (!parsed.ok) return parsed;
      filter = parsed.pid;
    }
    const view = ctx.host.view();
    const fs = ctx.host.fs();
    if (fs === null) {
      const rows = view.processes.filter(pcb => filter === null || pcb.pid === filter).flatMap(pcb => pcb.openFiles.map(fd => [pcb.pid, fd] as const));
      return ok(['file system not enabled: descriptors from the process table only', ...table(['PID', 'FD'], rows.map(([pid, fd]) => [`P${pid}`, fd]))]);
    }
    const inodes = new Map(fs.metadata.inodes.map(inode => [inode.id, inode]));
    const descriptors = new Map(fs.descriptors.map(row => [row.fd, row]));
    const rows = fs.processes.filter(process => filter === null || process.pid === filter).flatMap(process => process.descriptors.map(membership => {
      const descriptor = descriptors.get(membership.fd);
      const inode = descriptor === undefined ? undefined : inodes.get(descriptor.inode);
      const names = descriptor === undefined ? [] : pathsOf(fs, descriptor.inode);
      return { pid: process.pid, fd: membership.fd, inode: descriptor?.inode, mode: descriptor?.mode ?? '-', offset: descriptor?.offset ?? 0, links: inode?.linkCount ?? 0, name: names[0] ?? (inode === undefined ? '?' : '(unlinked)') };
    }));
    const selected = bound.args.has('unlinked') ? rows.filter(row => row.links === 0) : rows;
    if (bound.args.has('counts')) {
      const counts = new Map<Pid, number>();
      for (const row of selected) counts.set(row.pid, (counts.get(row.pid) ?? 0) + 1);
      return ok(table(['PID', 'OPEN'], [...counts].sort((a, b) => a[0] - b[0]).map(([pid, count]) => [`P${pid}`, count])));
    }
    return ok(table(['PID', 'FD', 'INODE', 'MODE', 'OFFSET', 'LINKS', 'NAME'], selected.map(row => [`P${row.pid}`, row.fd, row.inode ?? '-', row.mode, row.offset, row.links, row.name])));
  },
};

const mountHandler: ShippedHandler = {
  run(argv, ctx: ShellContext) {
    const bound = bindOrFail('mount', argv, { list: 0, semantics: 1, vfs: 0 });
    if (!bound.ok) return bound;
    if (bound.args.positional.length > 0) return unavailable('mount', 'mounting a volume at a point', 'the kernel has one volume and no mount namespace');
    if (bound.args.has('semantics')) return unavailable('mount', '--semantics', 'the kernel models no sharing semantics');
    if (bound.args.has('vfs')) return unavailable('mount', '--vfs', 'the kernel has one file system implementation and no virtual layer to list');
    const mounted = fileSystem(ctx, 'mount');
    if (!mounted.ok) return mounted;
    const { fs } = mounted;
    return ok(kv([
      ['state', fs.mountState],
      ['device', fs.volume?.device ?? '-'],
      ['first sector', fs.volume?.firstSector ?? '-'],
      ['blocks', fs.volume?.blockCount ?? '-'],
      ['root inode', fs.volume?.rootInode ?? '-'],
      ['allocation', fs.settings.defaultAllocation],
      ['journal', fs.settings.journalMode],
      ['free space', fs.settings.freeSpaceMethod],
    ]));
  },
};

export const FILESYSTEM_HANDLERS: ReadonlyMap<string, ShippedHandler> = new Map([
  ['inode', inodeHandler], ['journal', journalHandler], ['fsck', fsckHandler], ['lsof', lsofHandler], ['mount', mountHandler],
]);

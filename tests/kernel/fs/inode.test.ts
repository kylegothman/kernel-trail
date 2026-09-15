import { describe, expect, it } from 'vitest';
import { DirectoryTable } from '@kernel/fs/DirectoryTable';
import { InodeTable, FS_BLOCK_SIZE, FS_POINTER_SIZE, INODE_SIZE_COMPONENTS, MAX_FILE_SIZE, POINTERS_PER_BLOCK, inodeAddress } from '@kernel/fs/InodeTable';
import { FreeSpace, fsBlock } from '@kernel/fs/freeSpace';
import { allocateBlocks, readPlan } from '@kernel/fs/allocation/registry';
import { createStreamRegistry } from '@kernel/rng';
import { asTick } from '@kernel/types';
import type { DomainId, FsMetadataSnapshot, InodeId } from '@kernel/types';

const owner = 'domain:user' as DomainId;
describe('inode layout and generations', () => {
  it('FS-INODE-1 preserves every exact size component and its maximum', () => {
    expect(FS_BLOCK_SIZE).toBe(4096); expect(FS_POINTER_SIZE).toBe(32); expect(POINTERS_PER_BLOCK).toBe(128);
    expect(INODE_SIZE_COMPONENTS).toEqual([49152, 524288, 67108864, 8589934592]); expect(MAX_FILE_SIZE).toBe(8657616896);
  });
  it.each([[0, 1], [49151, 1], [49152, 2], [573439, 2], [573440, 3], [67682303, 3], [67682304, 4], [8657616895, 4]])('offset %i costs %i reads', (offset, reads) => {
    expect(inodeAddress(offset).reads).toBe(reads);
  });
  it('exposes the actual indirect pointer indices and rejects out-of-range offsets', () => {
    expect(inodeAddress(MAX_FILE_SIZE - 1).indices).toEqual([127, 127, 127]);
    expect(inodeAddress(573440).indices).toEqual([0, 0]);
    for (const offset of [-1, 0.5, MAX_FILE_SIZE, Number.NaN]) expect(() => inodeAddress(offset)).toThrow();
  });
  it('file hard links increment references, directory links are forbidden and mkdir accounts for dotdot', () => {
    const table = new InodeTable(); const directories = new DirectoryTable(table);
    const root = table.create({ name: '/', kind: 'directory', owner, tick: asTick(0), metadataBlock: fsBlock(0) }); directories.create(root.id);
    const child = table.create({ name: 'child', kind: 'directory', owner, tick: asTick(0), metadataBlock: fsBlock(1) }); directories.create(child.id, root.id); directories.add(root.id, 'child', child, true);
    const file = table.create({ name: 'file', owner, tick: asTick(0), metadataBlock: fsBlock(2) }); directories.add(root.id, 'file', file); directories.add(child.id, 'alias', table.get(file.id)!);
    expect(table.get(root.id)?.linkCount).toBe(3); expect(table.get(child.id)?.linkCount).toBe(2); expect(table.get(file.id)?.linkCount).toBe(2);
    expect(() => directories.add(root.id, 'bad', child)).toThrow('hard links');
    directories.unlink(root.id, 'file'); expect(table.get(file.id)?.linkCount).toBe(1);
    directories.unlink(child.id, 'alias'); directories.unlink(root.id, 'child'); expect(table.get(root.id)?.linkCount).toBe(2); expect(table.get(child.id)?.linkCount).toBe(0);
  });
  it('remains acyclic after 500 seeded link/unlink operations', () => {
    const table = new InodeTable(); const directories = new DirectoryTable(table); const rng = createStreamRegistry(0x4b54524c).stream('fs');
    const root = table.create({ name: '/', kind: 'directory', owner, tick: asTick(0), metadataBlock: fsBlock(0) }); directories.create(root.id);
    const directoryIds: InodeId[] = [root.id];
    for (let i = 0; i < 9; i += 1) { const parent = directoryIds[rng.int(0, directoryIds.length)]!; const child = table.create({ name: `d${i}`, kind: 'directory', owner, tick: asTick(0), metadataBlock: fsBlock(i + 1) }); directories.create(child.id, parent); directories.add(parent, child.name, child, true); directoryIds.push(child.id); }
    const files = Array.from({ length: 10 }, (_, i) => table.create({ name: `f${i}`, owner, tick: asTick(0), metadataBlock: fsBlock(20 + i) }));
    const aliases: { parent: InodeId; name: string }[] = [];
    for (let i = 0; i < 500; i += 1) {
      if (aliases.length > 0 && rng.chance(0.5)) { const [entry] = aliases.splice(rng.int(0, aliases.length), 1); directories.unlink(entry!.parent, entry!.name); }
      else { const parent = directoryIds[rng.int(0, directoryIds.length)]!; const name = `alias${i}`; const target = files[rng.int(0, files.length)]!; directories.add(parent, name, table.get(target.id)!); aliases.push({ parent, name }); }
      const copy = new DirectoryTable(); expect(() => copy.restore(directories.snapshots())).not.toThrow();
    }
    for (const id of directoryIds) { const seen = new Set<InodeId>(); let cursor = id; for (;;) { expect(seen.has(cursor)).toBe(false); seen.add(cursor); const parent = directories.parent(cursor)!; if (parent === cursor) break; cursor = parent; } }
  });
  it('reuses the lowest retired ID with a new generation without changing stable views', () => {
    const table = new InodeTable(); const array = table.inodes; const first = table.create({ name: 'one', owner, tick: asTick(0), metadataBlock: fsBlock(0) }); const view = table.inodes[0];
    table.update(first.id, { sizeBytes: 100 }); expect(table.inodes).toBe(array); expect(table.inodes[0]).toBe(view); expect(view?.sizeBytes).toBe(100);
    table.retire(first.id); const second = table.create({ name: 'two', owner, tick: asTick(1), metadataBlock: fsBlock(0) }); expect(second.id).toBe(first.id); expect(second.generation).toBe(first.generation + 1);
  });
  it('round trips allocator state, sparse ownership, block incarnations and largest inode position', () => {
    const table = new InodeTable(); const space = new FreeSpace(100, 'bitmap', [fsBlock(0)]);
    const file = table.create({ name: 'sparse', owner, tick: asTick(0), metadataBlock: fsBlock(0), method: 'indexed' });
    const last = Math.floor((MAX_FILE_SIZE - 1) / FS_BLOCK_SIZE); const allocation = allocateBlocks(file, [0, last], space, { nextGeneration: block => table.nextBlockGeneration(block) });
    if (!allocation.ok) throw new Error('largest sparse inode failed'); table.set({ ...allocation.inode, sizeBytes: MAX_FILE_SIZE });
    const saved = JSON.parse(JSON.stringify(table.metadata(space.snapshot(), []))) as FsMetadataSnapshot;
    const copy = new InodeTable(); copy.restore(saved); expect(copy.metadata(space.snapshot(), [])).toEqual(saved);
    expect(readPlan(copy.get(file.id)!, [last]).reads).toBe(2); expect(readPlan(copy.get(file.id)!, [1]).reads).toBe(0);
    const oldGeneration = table.blockGeneration(allocation.inode.blocks[0]!); expect(table.nextBlockGeneration(allocation.inode.blocks[0]!)).toBe(oldGeneration + 1);
  });
  it('validates allocator restoration before changing any live object', () => {
    const table = new InodeTable(); const inode = table.create({ name: 'keep', owner, tick: asTick(0), metadataBlock: fsBlock(0) }); const free = new FreeSpace(10); const saved = table.metadata(free.snapshot(), []); const view = table.inodes[0];
    expect(() => table.restore({ ...saved, freeInodeIds: [inode.id] })).toThrow(); expect(table.inodes[0]).toBe(view); expect(table.metadata(free.snapshot(), [])).toEqual(saved);
  });
});

import { FileSystemSubsystem } from '@kernel/fs/FileSystemSubsystem';
import { StorageSubsystem } from '@kernel/storage/StorageSubsystem';
import { IoSubsystem } from '@kernel/io/IoSubsystem';
import { asPid } from '@kernel/types';
import type { AddressSpaceId, DeviceId, FileDescriptor, IoSnapshotState, Pid, ProcessControlBlock, SyscallRequest, SyscallResult, Tick, Tid } from '@kernel/types';
import type { EmittableEvent } from '@kernel/EventBus';

function mountedFs(mode: 'off' | 'metadata' | 'full' = 'metadata', method: 'contiguous' | 'linked' | 'indexed' | 'extent' = 'indexed', cacheEntries = 64) {
  let time = 0; const rng = createStreamRegistry(0x4b54524c); const events: EmittableEvent[] = []; const publications: { pid: Pid; result: SyscallResult }[] = [];
  const processes = new Map<Pid, ProcessControlBlock>();
  function actor(pid: Pid) { const pcb = processes.get(pid); return pcb === undefined ? undefined : { pid, tid: pcb.threads[0]! }; }
  function addProcess(id: number) { const pid = asPid(id); const pcb: ProcessControlBlock = { pid, parent: null, name: `fs actor ${id}`, state: 'running', priority: 0, basePriority: 0,
    arrivalTick: asTick(0), cpuBurstRemaining: 1000000, serviceRemaining: 1000000, totalCpuUsed: 0, readySince: null, lastScheduledTick: null, queueLevel: 0,
    addressSpaceId: id as AddressSpaceId, threads: [id as Tid], openFiles: [], heldResources: [], requestedResources: [], blockedOn: null, domain: owner, exitCode: null, terminationReason: null, convoyMemberId: null };
    processes.set(pid, pcb); return pcb; }
  const first = addProcess(1); const emit = (event: EmittableEvent) => events.push(event);
  const storage = new StorageSubsystem({ tick: () => asTick(time), enabled: () => true, emit, rng: rng.stream('storage') });
  const settings: IoSnapshotState['payload']['settings'] = { interruptServiceTicks: 2, maxInterruptsPerTick: 2, interruptStormThreshold: 32, interruptStormWindow: 10, maxPendingInterrupts: 256, dmaCycleStealRatio: 0.1, blockCacheEntries: cacheEntries };
  const io = new IoSubsystem({ tick: () => asTick(time), enabled: () => true, settings: () => settings, process: pid => processes.get(pid), thread: () => undefined, actor,
    block: ({ pid }, device) => { const pcb = processes.get(pid)!; pcb.state = 'waiting'; pcb.blockedOn = { kind: 'io', device }; }, emit, terminate: () => {}, chargeKernelDebt: () => {},
    abortStorage: () => { for (const id of storage.drives.keys()) storage.control(id as DeviceId, 'crash', []); } }, rng.stream('io'), storage);
  const fs = new FileSystemSubsystem({ tick: () => asTick(time), enabled: () => true, process: pid => processes.get(pid), actor, domain: pid => processes.get(pid)!.domain,
    block: ({ pid }, device) => { const pcb = processes.get(pid)!; pcb.state = 'waiting'; pcb.blockedOn = { kind: 'io', device }; }, publishResult: (pid, result) => publications.push({ pid, result }), emit,
    check: () => true, storage, io }, { defaultAllocation: method, maxSymlinkDepth: 8, dentryCacheEntries: 128, fragmentationWarnExtents: 4, freeSpaceMethod: 'bitmap', linkedVariant: 'in_block', journalMode: mode });
  function step() { time += 1; const tick = asTick(time); fs.expireTimers(tick); storage.expireTimers(tick); io.expireTimers(tick); storage.serviceCompletions(tick); io.serviceCompletions(tick); }
  function until(condition: () => boolean, maximum = 20000) { for (let count = 0; count < maximum && !condition(); count += 1) step(); expect(condition()).toBe(true); }
  function complete(pid = first.pid) { const a = actor(pid)!; until(() => fs.pending(a)?.stage === 'complete'); const operation = fs.pending(a)!; const result = fs.consume(pid, a.tid)!; const pcb = processes.get(pid)!; pcb.state = 'running'; pcb.blockedOn = null; return { result, contents: [...operation.contents] }; }
  function call(name: SyscallRequest['name'], args: SyscallRequest['args'], pid = first.pid) {
    const result = fs.syscall({ pid, name, args }); if (name === 'seek' || name === 'close' || !result.ok && fs.pending(actor(pid)!) === undefined) return { result, contents: [] };
    return complete(pid);
  }
  fs.format(); until(() => fs.mounted); return { fs, storage, io, first, processes, addProcess, actor, rng, events, publications, step, until, call, complete, time: () => time, setTime: (tick: Tick) => { time = tick; } };
}

function opened(h: ReturnType<typeof mountedFs>, path = '/file', pid = h.first.pid): FileDescriptor {
  const result = h.call('open', [path, 'rw'], pid).result; if (!result.ok || typeof result.value !== 'number') throw new Error(`open failed ${JSON.stringify(result)}`); return result.value as FileDescriptor;
}

describe('filesystem media and descriptor continuation', () => {
  it('formats through actual media and completes each asynchronous syscall exactly once', () => {
    const h = mountedFs(); expect(h.fs.state().counters.physicalSectorWrites).toBeGreaterThan(0);
    h.fs.createFile('/file'); h.until(() => !h.fs.busy); const fd = opened(h); const before = h.publications.length;
    h.fs.writeBytes(h.first.pid, fd, [17, 33, 65]); expect(h.fs.pending(h.actor(h.first.pid)!)?.stage).not.toBe('complete');
    expect(h.fs.instructionOutcome(h.actor(h.first.pid)!)).toEqual({ advance: false, deferService: true });
    expect(h.complete().result).toEqual({ ok: true, value: 3 }); expect(h.publications).toHaveLength(before + 1);
    expect(h.call('seek', [fd, 0, 0]).result).toEqual({ ok: true, value: 0 }); expect(h.call('read', [fd, 3]).contents).toEqual([17, 33, 65]);
    expect(() => h.fs.checkInvariants()).not.toThrow();
  });
  it.each(['contiguous', 'linked', 'indexed', 'extent'] as const)('preserves partial and appended data with timed %s reads', method => {
    const h = mountedFs('metadata', method); h.fs.createFile('/file'); h.until(() => !h.fs.busy); const fd = opened(h);
    const data = Array.from({ length: method === 'linked' ? 4065 : 4097 }, (_, i) => i % 251); h.fs.writeBytes(h.first.pid, fd, data); expect(h.complete().result.ok).toBe(true);
    h.call('seek', [fd, 2, 0]); h.fs.writeBytes(h.first.pid, fd, [255]); h.complete(); h.call('seek', [fd, 0, 0]);
    const read = h.call('read', [fd, data.length]); const expected = [...data]; expected[2] = 255; expect(read.contents).toEqual(expected);
    h.call('seek', [fd, 1000000, 0]); const oldSize = h.fs.inodeTable.get(h.fs.state().descriptors[0]!.inode)!.sizeBytes;
    expect(h.call('write', [fd, 0]).result).toEqual({ ok: true, value: 0 }); expect(h.fs.inodeTable.get(h.fs.state().descriptors[0]!.inode)!.sizeBytes).toBe(oldSize);
  });
  it('shares fork offsets and CLOEXEC membership while distinct opens delay final unlink reclamation', () => {
    const h = mountedFs(); const id = h.fs.createFile('/file'); h.until(() => !h.fs.busy); const fd = opened(h); const second = opened(h);
    h.fs.writeBytes(h.first.pid, fd, [1, 2, 3, 4]); h.complete(); h.call('seek', [fd, 0, 0]); h.fs.setCloseOnExec(h.first.pid, fd, true);
    const child = h.addProcess(2); child.openFiles.push(...h.first.openFiles); h.fs.fork(h.first, child); for (const descriptor of child.openFiles) h.fs.retainDescriptor(descriptor);
    expect(h.fs.closeOnExec(child, fd)).toBe(true); expect(h.call('read', [fd, 1], child.pid).contents).toEqual([1]); expect(h.call('read', [fd, 1]).contents).toEqual([2]);
    expect(h.call('unlink', ['/file']).result.ok).toBe(true); expect(h.fs.inodeTable.get(id)?.linkCount).toBe(0);
    h.call('close', [fd]); h.call('close', [fd], child.pid); expect(h.fs.inodeTable.get(id)).toBeDefined();
    h.call('close', [second]); h.call('close', [second], child.pid); h.until(() => !h.fs.busy); expect(h.fs.inodeTable.get(id)).toBeUndefined(); expect(() => h.fs.checkInvariants()).not.toThrow();
  });
  it('exit queue cleanup preserves membership long enough for lifecycle descriptor closure', () => {
    const h = mountedFs(); h.fs.createFile('/file'); h.until(() => !h.fs.busy); const fd = opened(h);
    h.fs.removeProcess(h.first.pid); h.fs.closeDescriptor(h.first, fd); expect(h.fs.state().descriptors).toEqual([]); expect(h.first.openFiles).toEqual([]);
  });
  it('restores pending media work into a fresh FS/storage/I/O trio with stable live inode mirrors', () => {
    const h = mountedFs(); h.fs.createFile('/file'); h.until(() => !h.fs.busy); const fd = opened(h); const stable = h.fs.inodes; const view = h.fs.inodes.find(inode => inode.name === 'file');
    h.fs.writeBytes(h.first.pid, fd, [9, 8, 7]); h.step(); h.step(); const fs = h.fs.saveState(); const storage = h.storage.saveState(); const io = h.io.saveState().io;
    const other = mountedFs(); other.setTime(fs.payload.tick); other.first.openFiles.push(fd); const storageCommit = other.storage.prepareRestore(storage); const ioCommit = other.io.prepareRestore(io); const fsCommit = other.fs.prepareRestore(fs);
    storageCommit(); ioCommit(); fsCommit(); const original = h.complete(); const restored = other.complete(); expect(restored.result).toEqual(original.result); expect(other.fs.saveState()).toEqual(h.fs.saveState());
    expect(h.fs.inodes).toBe(stable); expect(h.fs.inodes.find(inode => inode.name === 'file')).toBe(view);
  });
  // 120 journaled creates plus a 64-block write drive about 5,000 media ticks (4.6 s here);
  // the budget covers a CI runner several times slower, the way DET-D4 declares its own.
  it('keeps hard links, compact64-block inode images and multi-page directories durable through crash', () => {
    const h = mountedFs('off', 'indexed'); const id = h.fs.createFile('/file'); h.until(() => !h.fs.busy); const fd = opened(h);
    h.fs.writeBytes(h.first.pid, fd, Array<number>(64 * 4096).fill(31)); expect(h.complete().result.ok).toBe(true);
    expect(h.fs.hardLink(h.first.pid, '/file', '/alias').ok).toBe(true); h.until(() => !h.fs.busy);
    for (let i = 0; i < 120; i += 1) { h.fs.createFile(`/entry-${i}-${'x'.repeat(35)}`); h.until(() => !h.fs.busy); }
    expect(h.fs.inodeTable.get(h.fs.state().volume!.rootInode)!.blocks.length).toBeGreaterThan(1);
    h.fs.crash(); h.fs.recover(); h.until(() => h.fs.mounted && !h.fs.busy); expect(h.fs.inodeTable.get(id)?.linkCount).toBe(2);
    h.call('seek', [fd, 0, 0]); expect(h.call('read', [fd, 8]).contents).toEqual(Array<number>(8).fill(31)); expect(h.fs.resolve('/entry-119-' + 'x'.repeat(35), h.first.pid).ok).toBe(true);
  }, 30000);
});

import { createKernel } from '@kernel/Kernel';
import { instructionProgram } from '@kernel/process/Program';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';
import type { KernelEvent } from '@kernel/types';

describe('filesystem kernel boundary', () => {
  function kernel() { return createKernel({ ...REFERENCE_CONFIG, enabledSubsystems: ['process', 'scheduler', 'storage', 'io', 'fs'] }); }
  function until(k: ReturnType<typeof kernel>, condition: () => boolean, maximum = 20000) { for (let i = 0; i < maximum && !condition(); i += 1) k.step(); expect(condition()).toBe(true); }
  it('restores a formatted init-only kernel with stable FS mirrors', () => {
    const k = kernel(); const fs = k.fileSystemSubsystem; fs.format(); until(k, () => fs.mounted); fs.createFile('/saved'); until(k, () => !fs.busy);
    const snapshot = k.snapshot(); const fresh = kernel(); const mirror = fresh.fileSystemSubsystem.inodes; fresh.restore(snapshot);
    expect(fresh.snapshot()).toEqual(snapshot); expect(fresh.fileSystemSubsystem.inodes).toBe(mirror);
  });
  it('accepts an external file call from a new actor without an illegal new-to-waiting transition', () => {
    const k = kernel(); const fs = k.fileSystemSubsystem; fs.format(); until(k, () => fs.mounted); fs.createFile('/file'); until(k, () => !fs.busy);
    const pid = k.spawn({ name: 'future file caller', priority: 1, arrival: k.tick + 1000, burst: 1, service: 1, pages: 1 }); const pcb = k.table.get(pid)!;
    expect(() => k.syscall({ pid, name: 'open', args: ['/file', 'r'] })).not.toThrow(); expect(pcb.state).toBe('new');
    until(k, () => fs.pending({ pid, tid: pcb.threads[0]! })?.stage === 'complete'); expect(pcb.state).toBe('new'); expect(k.lastSyscallResult(pid)).toMatchObject({ ok: true, value: 0 });
  });
  it('defers final-instruction service until an actual write completes and emits its final syscall result once', () => {
    const k = kernel(); const fs = k.fileSystemSubsystem; fs.format(); until(k, () => fs.mounted); fs.createFile('/file'); until(k, () => !fs.busy);
    const pid = k.spawn({ name: 'single write', priority: 1, arrival: k.tick + 100, burst: 1, service: 1, pages: 1 }, { program: instructionProgram([{ kind: 'syscall', call: { pid: asPid(0), name: 'write', args: [0, 3] } }]) });
    const pcb = k.table.get(pid)!, thread = k.threads.table.get(pcb.threads[0]!)!; const events: KernelEvent[] = []; k.events.onAny(event => events.push(event));
    k.syscall({ pid, name: 'open', args: ['/file', 'rw'] }); until(k, () => fs.pending({ pid, tid: thread.tid })?.stage === 'complete'); fs.consume(pid, thread.tid);
    until(k, () => pcb.state === 'waiting'); expect(thread.programCounter).toBe(0); expect(pcb.serviceRemaining).toBe(1);
    until(k, () => pcb.state === 'zombie'); expect(thread.programCounter).toBe(1); expect(pcb.terminationReason).toBe('normal_exit');
    const writes = events.filter(event => event.type === 'syscall.invoked' && event.request.name === 'write'); expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ result: { ok: true, value: 3 } });
  });
});

describe('filesystem cache durability', () => {
  it.each(['write_back', 'write_through'] as const)('%s crash loses only unacknowledged cached file contents', policy => {
    const h = mountedFs('off', 'extent'); h.fs.createFile('/file'); h.until(() => !h.fs.busy); const fd = opened(h);
    h.fs.writeBytes(h.first.pid, fd, [1, 2, 3]); h.complete(); h.call('seek', [fd, 0, 0]); h.io.cache.setPolicy(policy);
    h.fs.writeBytes(h.first.pid, fd, [7, 8, 9]); expect(h.complete().result).toEqual({ ok: true, value: 3 });
    const dirty = h.io.cache.dirtyEntries(); expect(dirty.length > 0).toBe(policy === 'write_back');
    const tx = h.fs.state().journal.transactions.at(-1)!;
    if (policy === 'write_back') { expect(tx.checkpointAtTick).toBeNull(); expect(tx.images.every(image => image.homeTransferId === null)).toBe(true); }
    h.call('seek', [fd, 0, 0]); expect(h.call('read', [fd, 3]).contents).toEqual([7, 8, 9]);
    const states = h.rng.saveAll(); h.fs.crash(); expect(h.rng.saveAll()).toEqual(states); expect(h.fs.state().lastCrash?.droppedCacheBlocks.map(row => row.sectorLba)).toEqual(dirty);
    h.fs.mount(); h.call('seek', [fd, 0, 0]); expect(h.call('read', [fd, 3]).contents).toEqual(policy === 'write_back' ? [1, 2, 3] : [7, 8, 9]);
  });
  it('sync makes a write-back file survive crash with its acknowledged bytes', () => {
    const h = mountedFs('off'); h.fs.createFile('/file'); h.until(() => !h.fs.busy); const fd = opened(h); h.io.cache.setPolicy('write_back');
    h.fs.writeBytes(h.first.pid, fd, [91, 92]); h.complete(); expect(h.io.cache.dirtyEntries().length).toBeGreaterThan(0);
    expect(h.call('sync', []).result.ok).toBe(true); expect(h.io.cache.dirtyEntries()).toEqual([]); h.fs.crash(); h.fs.mount(); h.call('seek', [fd, 0, 0]); expect(h.call('read', [fd, 2]).contents).toEqual([91, 92]);
  });
  // A ten-block write through a four-entry cache evicts through real media twice (2.4 s here);
  // the budget covers a CI runner several times slower.
  it('a transaction larger than cache capacity resumes mid eviction without fake durable transfers', () => {
    const h = mountedFs('off', 'extent', 4); h.fs.createFile('/file'); h.until(() => !h.fs.busy); const fd = opened(h); h.io.cache.setPolicy('write_back');
    h.fs.writeBytes(h.first.pid, fd, Array<number>(10 * 4096).fill(53));
    h.until(() => h.fs.state().transfers.some(transfer => transfer.progress.kind === 'cache'));
    const fs = h.fs.saveState(), storage = h.storage.saveState(), io = h.io.saveState().io;
    const other = mountedFs('off', 'extent', 4); other.setTime(fs.payload.tick); other.first.openFiles.push(fd); other.storage.prepareRestore(storage)(); other.io.prepareRestore(io)(); other.fs.prepareRestore(fs)();
    expect(h.complete().result).toEqual({ ok: true, value: 10 * 4096 }); expect(other.complete().result).toEqual({ ok: true, value: 10 * 4096 });
    expect(other.fs.saveState()).toEqual(h.fs.saveState());
    const tx = h.fs.state().journal.transactions.at(-1)!; expect(tx.checkpointAtTick).toBeNull(); expect(tx.images.some(image => image.homeTransferId !== null)).toBe(true);
    expect(h.call('sync', []).result.ok).toBe(true); h.fs.crash(); h.fs.mount(); h.call('seek', [fd, 9 * 4096, 0]); expect(h.call('read', [fd, 8]).contents).toEqual(Array<number>(8).fill(53));
  }, 30000);
});

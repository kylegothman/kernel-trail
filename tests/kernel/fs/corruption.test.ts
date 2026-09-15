import { describe, expect, it } from 'vitest';
import { Journal, applyMetadataDelta, decodeFsRecord, emptyMetadataDelta, encodeFsRecord, fsSector,
  type JournalHost, type Mutable, type MutableFsPayload } from '../../../src/kernel/fs/journal';
import { Recovery } from '../../../src/kernel/fs/recovery';
import { crashFileSystem } from '../../../src/kernel/fs/crash';
import { prepareFsck, reservedFsBlocks, scanFileSystem, verifyFileSystem } from '../../../src/kernel/fs/fsck';
import { FreeSpace } from '../../../src/kernel/fs/freeSpace';
import { StorageSubsystem } from '../../../src/kernel/storage/StorageSubsystem';
import { createRng } from '../../../src/kernel/rng';
import type { EmittableEvent } from '../../../src/kernel/EventBus';
import { asTick, type BlockId, type DeviceId, type DomainId, type FsDirectorySnapshot, type FsInodeSnapshot,
  type FsMetadataSnapshot, type InodeId } from '../../../src/kernel/types';

const block = (value: number) => value as BlockId;
const inodeId = (value: number) => value as InodeId;
function fixture() {
  let tick = asTick(0); const rng = createRng(0x4b54524c), events: EmittableEvent[] = [];
  const state: MutableFsPayload = {
    tick, settings: { defaultAllocation: 'contiguous', maxSymlinkDepth: 8, dentryCacheEntries: 128,
      fragmentationWarnExtents: 4, freeSpaceMethod: 'bitmap', linkedVariant: 'in_block', journalMode: 'full' },
    mountState: 'mounted', volume: { device: 'disk0' as DeviceId, firstSector: block(0), blockCount: 6400,
      rootInode: inodeId(2), lostFoundInode: inodeId(3), superblock: block(0), bitmapBlocks: [block(1)],
      journalControlBlock: block(5375), journalPayloadStart: block(5376), journalPayloadBlocks: 1024, fatBlocks: [] },
    nextDescriptorId: 0, nextOperationId: 1, nextTransferId: 1, nextTransactionId: 1, nextImageGeneration: 1,
    lastTimerTick: null, metadata: { nextInodeId: 5, freeInodeIds: [], inodeGenerations: [{ inode: inodeId(4), generation: 1 }], blockGenerations: [{ block: block(100), generation: 1 }],
      inodes: [], directories: [], freeSpace: { kind: 'bitmap', words: [] } }, durableMetadata: [], caches: { dentries: [], metadata: [] },
    descriptors: [], processes: [], operations: [], transfers: [], journal: { entries: [], transactions: [], checkpointedThrough: 0, retained: null },
    recovery: null, corruption: [], lastCrash: null, counters: { completedOperations: 0, logicalBlockReads: 0, logicalBlockWrites: 0,
      logicalRunStarts: 0, physicalSectorReads: 0, physicalSectorWrites: 0, bitmapWordsScanned: 0 },
  };
  const makeInode = (id: number, directory: boolean): Mutable<FsInodeSnapshot> => ({ id: inodeId(id), name: id === 2 ? '/' : id === 3 ? 'lost+found' : 'log',
    kind: directory ? 'directory' : 'file', sizeBytes: directory ? 0 : 4096, method: 'contiguous', blocks: [block(directory ? id === 2 ? 3 : 5 : 100)],
    indexBlock: null, owner: 'domain:kernel' as DomainId, permissions: { read: true, write: true, execute: directory },
    createdTick: asTick(0), modifiedTick: asTick(0), linkCount: directory ? id === 2 ? 3 : 2 : 1, generation: 1,
    metadataBlock: block(id === 2 ? 2 : id === 3 ? 4 : 6), symlinkTarget: null, programName: null,
    mapping: directory ? [] : [{ logicalBlock: 0, block: block(100), generation: 1 }], allocation: { kind: 'contiguous' } });
  state.metadata.inodes = [makeInode(2, true), makeInode(3, true), makeInode(4, false)];
  state.metadata.directories = [{ inode: inodeId(2), parent: inodeId(2), entries: [{ name: 'log', inode: inodeId(4), generation: 1 }, { name: 'lost+found', inode: inodeId(3), generation: 1 }] },
    { inode: inodeId(3), parent: inodeId(2), entries: [] }];
  const free = new FreeSpace(6400, 'bitmap', reservedFsBlocks(state)); free.reserve([block(6), block(100)]);
  state.metadata.freeSpace = free.snapshot() as Mutable<FsMetadataSnapshot['freeSpace']>;
  const storage = new StorageSubsystem({ tick: () => tick, enabled: () => true, emit: event => events.push(event), rng });
  const host: JournalHost = { state: () => state, tick: () => tick, emit: event => events.push(event),
    transfer: id => state.transfers.find(item => item.id === id), submit: (purpose, command) => {
      let contents: readonly number[] = [];
      if (command.kind === 'write') {
        const source = command.source;
        contents = source.kind === 'inline' ? source.contents : source.kind === 'transaction_image'
          ? state.journal.transactions.find(tx => tx.id === source.txId)!.images[source.imageIndex]!.contents
          : state.journal.transactions.find(tx => tx.id === source.txId)!.controls[source.controlIndex]!.contents;
      }
      const requestId = storage.submitDevice('disk0' as DeviceId, command.kind === 'read'
        ? { kind: 'read', lba: command.sectorLba, bytes: command.bytes } : { kind: 'write', lba: command.sectorLba, data: contents }, { kind: 'direct' }, null);
      const id = state.nextTransferId++;
      state.transfers.push({ id, purpose: structuredClone(purpose) as Mutable<typeof purpose>, command: structuredClone(command) as Mutable<typeof command>, progress: { kind: 'storage', requestId } }); return id;
    } };
  const journal = new Journal(host), recovery = new Recovery(host);
  const step = () => {
    tick = asTick(tick + 1); state.tick = tick; storage.serviceCompletions(tick);
    for (const transfer of state.transfers) if (transfer.progress.kind === 'storage') {
      const completion = storage.takeCompletion(transfer.progress.requestId);
      if (completion !== null) transfer.progress = { kind: 'settled', atTick: completion.completedAtTick, result: structuredClone(completion.result) as Mutable<typeof completion.result> };
    }
    if (state.recovery !== null) recovery.advance(); else journal.advance();
  };
  const until = (done: () => boolean) => { for (let i = 0; i < 5000 && !done(); i++) step(); expect(done()).toBe(true); };
  const read = (b: number) => Array.from({ length: 8 }, (_, sector) => storage.readSector('disk0', fsSector(state, block(b), sector))).flat();
  const write = (b: number, value: unknown, data = false) => {
    const id = host.submit({ kind: 'format' }, { kind: 'write', sectorLba: fsSector(state, block(b)), source: { kind: 'inline', contents: data ? value as number[] : encodeFsRecord(value) } });
    until(() => host.transfer(id)?.progress.kind === 'settled');
  };
  const reloadMetadata = () => {
    state.metadata.inodes = [2, 4, 6].map(b => decodeFsRecord(read(b)) as FsInodeSnapshot | null).filter((inode): inode is FsInodeSnapshot => inode !== null) as Mutable<FsInodeSnapshot[]>;
    state.metadata.directories = [3, 5].map(b => decodeFsRecord(read(b)) as FsDirectorySnapshot) as Mutable<FsDirectorySnapshot[]>;
    state.metadata.freeSpace = decodeFsRecord(read(1)) as Mutable<FsMetadataSnapshot['freeSpace']>;
  };
  const initial = emptyMetadataDelta();
  initial.inodes = state.metadata.inodes.map(inode => ({ id: inode.id, before: null, after: structuredClone(inode) }));
  initial.directories = state.metadata.directories.map(directory => ({ inode: directory.inode, before: null, after: structuredClone(directory) }));
  const format = journal.prepare({ changes: initial, images: [
    ...state.metadata.inodes.map(inode => ({ homeBlock: inode.metadataBlock, generation: 1, kind: 'inode' as const, inode: inode.id,
      inodeGeneration: inode.generation, contents: encodeFsRecord(inode) })),
    ...state.metadata.directories.map(directory => ({ homeBlock: block(directory.inode === 2 ? 3 : 5), generation: 1, kind: 'directory' as const,
      inode: directory.inode, inodeGeneration: 1, contents: encodeFsRecord(directory) })),
    { homeBlock: block(1), generation: 1, kind: 'allocation', inode: null, inodeGeneration: null, contents: encodeFsRecord(state.metadata.freeSpace) },
    { homeBlock: block(100), generation: 1, kind: 'data', inode: inodeId(4), inodeGeneration: 1, contents: Array<number>(4096).fill(42) },
  ] }); until(() => journal.isComplete(format));
  const crash = (dropDirty: () => { device: DeviceId; sectorLba: BlockId }[] = () => []) => crashFileSystem({ ...host, dropDirty,
    abortIo: () => { storage.control('disk0' as DeviceId, 'crash', []); }, reloadMetadata }, journal);
  const corrupt = (parts: readonly ('A' | 'B' | 'C')[]) => {
    if (parts.includes('A')) write(3, { ...state.metadata.directories[0]!, entries: state.metadata.directories[0]!.entries.filter(entry => entry.name !== 'log') });
    if (parts.includes('B')) write(6, null);
    if (parts.includes('C')) { const released = free.clone(); released.release([block(100)]); write(1, released.snapshot()); }
    crash();
  };
  return { state, events, host, journal, recovery, storage, rng, read, write, step, until, crash, corrupt, reloadMetadata };
}

describe('durable-write crash subsets and corruption', () => {
  it('FS-CORRUPT-1 recognizes an orphan and prepares a lost+found repair preserving data', () => {
    const f = fixture(); f.corrupt(['A']);
    expect(scanFileSystem(f.state, f.host.tick()).map(issue => issue.kind)).toContain('orphan_inode');
    const delta = prepareFsck(f.host); applyMetadataDelta(f.state.metadata, delta);
    expect(f.state.metadata.directories.find(directory => directory.inode === 3)!.entries).toContainEqual({ name: 'inode-4', inode: 4, generation: 1 });
    expect(f.read(100)).toEqual(Array<number>(4096).fill(42));
    expect(f.events).toContainEqual({ type: 'fs.corruption', inode: 4, recoverable: true });
  });
  it('FS-CORRUPT-2 rebuilds leaked space after A and B reached real media', () => {
    const f = fixture(); f.corrupt(['A', 'B']);
    expect(scanFileSystem(f.state, f.host.tick()).map(issue => issue.kind)).toContain('leaked_block');
    applyMetadataDelta(f.state.metadata, prepareFsck(f.host));
    const free = new FreeSpace(6400); free.restore(f.state.metadata.freeSpace);
    expect(free.isFree(block(100))).toBe(true); expect(f.state.counters.bitmapWordsScanned).toBe(200);
    expect(scanFileSystem(f.state, f.host.tick())).toEqual([]);
  });
  it('FS-CORRUPT-3 detects a dangling entry and demonstrates reused-inode aliasing', () => {
    const f = fixture(); f.corrupt(['B']);
    expect(scanFileSystem(f.state, f.host.tick()).some(issue => issue.kind === 'dangling_entry')).toBe(true);
    const replacement = { ...f.state.journal.transactions[0]!.changes.inodes.find(item => item.id === 4)!.after!, generation: 2,
      name: 'replacement', blocks: [block(200)], mapping: [{ logicalBlock: 0, block: block(200), generation: 2 }] };
    f.write(6, replacement); f.write(200, Array<number>(4096).fill(99), true); f.reloadMetadata();
    const stale = f.state.metadata.directories[0]!.entries.find(entry => entry.name === 'log')!;
    const now = f.state.metadata.inodes.find(inode => inode.id === stale.inode)!;
    expect(now.generation).not.toBe(stale.generation); expect(f.read(now.blocks[0]!)[0]).toBe(99);
    prepareFsck(f.host); expect(f.events).toContainEqual({ type: 'fs.corruption', inode: 4, recoverable: false });
  });
  it('FS-CORRUPT-4 reports double allocation and I-29 catches its free-space conflict', () => {
    const f = fixture(); f.corrupt(['C']); f.state.mountState = 'mounted';
    expect(scanFileSystem(f.state, f.host.tick()).some(issue => issue.kind === 'duplicate_block')).toBe(true);
    expect(() => verifyFileSystem(f.host)).toThrow('I-29');
    prepareFsck(f.host); expect(f.events).toContainEqual({ type: 'fs.corruption', inode: 4, recoverable: false });
  });
  it('crash timing consumes no RNG draws and discards only explicitly dirty cache entries', () => {
    const f = fixture(), before = f.rng.save();
    f.crash(() => [{ device: 'disk0' as DeviceId, sectorLba: block(800) }]);
    expect(f.rng.save()).toEqual(before); expect(f.state.lastCrash?.droppedCacheBlocks).toEqual([{ device: 'disk0', sectorLba: 800 }]);
    expect(f.read(100)[0]).toBe(42); expect(f.events.at(-1)).toEqual({ type: 'kernel.panic', message: 'crash' });
  });
  it('ORRERY accepts retained full images, then completes recovery through actual media reads', () => {
    const f = fixture(); f.corrupt(['C']); f.write(100, Array<number>(4096).fill(99), true);
    expect(f.recovery.rebuildInodeFromJournal(inodeId(4))).toBe(true);
    expect(f.read(100)[0]).toBe(99); // True means accepted; asynchronous replay has not completed.
    f.until(() => f.state.recovery === null);
    expect(f.read(100)[0]).toBe(42); expect(scanFileSystem(f.state, f.host.tick())).toEqual([]);
    expect(f.events).toContainEqual({ type: 'fs.recovered', inode: 4, fromJournal: true });
  });
  it('ORRERY refuses absent history and rejects journal images damaged on media', () => {
    const f = fixture(); const retained = f.state.journal.retained!;
    f.state.journal.retained = null; expect(f.recovery.rebuildInodeFromJournal(inodeId(4))).toBe(false);
    f.state.journal.retained = retained;
    const image = retained.images.find(item => item.inode === 4 && item.kind === 'inode')!;
    f.write(image.journalBlock, Array<number>(4096).fill(99), true);
    expect(f.recovery.rebuildInodeFromJournal(inodeId(4))).toBe(true); f.until(() => f.state.recovery === null);
    expect(f.events).toContainEqual({ type: 'fs.corruption', inode: 4, recoverable: false });
  });
});

// The actual kernel fixtures below retain the original phases and invariant dispatch.
import { createKernel } from '../../../src/kernel/Kernel';
import { instructionProgram } from '../../../src/kernel/process/Program';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';
import type { FileDescriptor, KernelEvent, SyscallName, SyscallResult } from '../../../src/kernel/types';

function corruptibleKernel(checkInvariants: boolean) {
  const kernel = createKernel({ ...REFERENCE_CONFIG, enabledSubsystems: ['process', 'scheduler', 'storage', 'io', 'fs'] }, { checkInvariants, journalMode: 'off' });
  const fs = kernel.fileSystemSubsystem, events: KernelEvent[] = [];
  kernel.events.onAny(event => events.push(event));
  const pid = kernel.spawn({ name: 'corruption-reader', pages: 2, burst: 100000, service: 100000, priority: 10, arrival: 100000 }, { program: instructionProgram([{ kind: 'compute' }]) });
  const until = (done: () => boolean, budget = 20000) => { for (let i = 0; i < budget && !done(); i++) kernel.step(); expect(done()).toBe(true); };
  fs.format(); until(() => fs.mounted); const inode = fs.createFile('/original'); until(() => !fs.busy);
  const tid = kernel.process(pid)!.threads[0]!;
  const call = (name: SyscallName, args: readonly (string | number | boolean)[]): SyscallResult => {
    const result = kernel.syscall({ pid, name, args }), op = fs.pending({ pid, tid }); if (op === undefined) return result;
    until(() => op.stage === 'complete'); return fs.consume(pid, tid)!;
  };
  const open = call('open', ['/original', 'rw']); expect(open.ok).toBe(true); const fd = (open.ok ? open.value : -1) as FileDescriptor;
  fs.writeBytes(pid, fd, [42]); until(() => fs.pending({ pid, tid })?.stage === 'complete'); fs.consume(pid, tid); call('close', [fd]);
  return { kernel, fs, pid, tid, inode, events, until, call };
}
function commitCOnly(h: ReturnType<typeof corruptibleKernel>) {
  const { kernel, fs, pid, tid, until } = h;
  // Freeze only the installed FS timer; storage still acknowledges real media writes.
  kernel.installHooks({ fs: { expireTimers: () => {} } });
  expect(kernel.syscall({ pid, name: 'unlink', args: ['/original'] }).ok).toBe(true);
  const tx = fs.state().journal.transactions.find(row => row.operationId === fs.pending({ pid, tid })!.id)!;
  const bitmap = fs.state().volume!.bitmapBlocks[0]!, sector = fsSector(fs.state(), bitmap);
  const old = decodeFsRecord(Array.from({ length: 8 }, (_, i) => kernel.storageSubsystem.readSector('disk0', block(sector + i))).flat()) as Record<string, unknown>;
  const next = decodeFsRecord(tx.images.find(image => image.homeBlock === bitmap)!.contents) as Record<string, unknown>;
  // C changes free-block membership only. A is the directory image; B is the inode image.
  const bytes = encodeFsRecord({ ...old, words: next.words });
  const request = kernel.storageSubsystem.submitDevice('disk0' as DeviceId, { kind: 'write', lba: sector, data: bytes }, { kind: 'direct' }, null);
  until(() => kernel.storageSubsystem.peekCompletion(request) !== null); kernel.storageSubsystem.takeCompletion(request);
  fs.crash(); fs.consume(pid, tid); fs.mount();
  kernel.installHooks({ fs: { expireTimers: tick => fs.expireTimers(tick) } });
}

describe('kernel corruption timing and whole-I/O crash', () => {
  it('C-only durable membership change reaches the existing I-29 check at the next 50-tick boundary', () => {
    const h = corruptibleKernel(true); commitCOnly(h);
    const nextCheck = (Math.floor(h.kernel.tick / 50) + 1) * 50;
    while (h.kernel.tick + 1 < nextCheck) expect(() => h.kernel.step()).not.toThrow();
    expect(() => h.kernel.step()).toThrow('I-29'); expect(h.kernel.tick).toBe(nextCheck);
  });
  it('with diagnostics disabled the alias remains silent for 500 ticks, then a read terminates storage_corruption', () => {
    const h = corruptibleKernel(false); commitCOnly(h);
    const start = h.kernel.tick;
    h.kernel.run(500); expect(h.kernel.tick - start).toBe(500);
    expect(h.events.some(event => event.type === 'process.exited' && event.pid === h.pid)).toBe(false);
    const original = h.fs.inodeTable.get(h.inode)!;
    h.fs.createFile('/replacement'); h.until(() => !h.fs.busy);
    const opened = h.call('open', ['/replacement', 'rw']); const fd = (opened.ok ? opened.value : -1) as FileDescriptor;
    h.fs.writeBytes(h.pid, fd, [99]); h.until(() => h.fs.pending({ pid: h.pid, tid: h.tid })?.stage === 'complete'); h.fs.consume(h.pid, h.tid); h.call('close', [fd]);
    const replacement = h.fs.resolve('/replacement', h.pid); expect(replacement.ok && replacement.inode.blocks.some(b => original.blocks.includes(b))).toBe(true);
    const old = h.call('open', ['/original', 'r']); const oldFd = (old.ok ? old.value : -1) as FileDescriptor;
    const result = h.kernel.syscall({ pid: h.pid, name: 'read', args: [oldFd, 1] });
    expect(result.ok).toBe(false); expect(h.kernel.process(h.pid)?.terminationReason).toBe('storage_corruption');
    expect(h.events.filter(event => event.type === 'fs.corruption').length).toBeGreaterThan(0);
  });
  it('crash cancels devices, DMA, interrupts and queued storage while preserving acknowledged bytes and RNG states', () => {
    const h = corruptibleKernel(false), { kernel } = h;
    kernel.storageSubsystem.ensureDrive('auxiliary');
    const durable = kernel.storageSubsystem.submitDevice('auxiliary' as DeviceId, { kind: 'write', lba: block(0), data: Array<number>(512).fill(7) }, { kind: 'direct' }, null);
    h.until(() => kernel.storageSubsystem.peekCompletion(durable) !== null); kernel.storageSubsystem.takeCompletion(durable);
    kernel.storageSubsystem.submitDevice('auxiliary' as DeviceId, { kind: 'write', lba: block(512), data: Array<number>(512).fill(8) }, { kind: 'direct' }, null);
    kernel.ioSubsystem.submit({ kind: 'kernel', purpose: 'fixture' }, 'disk0' as DeviceId, { kind: 'write', lba: block(200), contents: Array<number>(512).fill(9) }, 'dma');
    kernel.ioSubsystem.submit({ kind: 'kernel', purpose: 'fixture' }, 'net0' as DeviceId, { kind: 'packet', contents: [1, 2, 3] }, 'interrupt');
    kernel.ioSubsystem.cache.setPolicy('write_back'); kernel.ioSubsystem.cache.write('disk0' as DeviceId, block(400), Array<number>(512).fill(12));
    const rng = kernel.ioSubsystem.rng.save(), panicCount = h.events.filter(event => event.type === 'kernel.panic').length;
    h.fs.crash();
    expect(kernel.ioSubsystem.rng.save()).toEqual(rng);
    const saved = kernel.ioSubsystem.saveState().io.payload;
    expect(saved.devices.every(device => device.requestOrder.length === 0 && device.activeRequestId === null)).toBe(true);
    expect(saved.requests).toEqual([]); expect(saved.interrupts.lines.every(line => line.pending.length === 0)).toBe(true); expect(saved.kernelDebt).toBe(0);
    expect(kernel.storageSubsystem.readSector('auxiliary', block(0))[0]).toBe(7);
    expect(kernel.storageSubsystem.readSector('auxiliary', block(512))[0]).toBe(0);
    expect(h.events.filter(event => event.type === 'kernel.panic')).toHaveLength(panicCount + 1);
    expect(() => kernel.ioSubsystem.assertInvariants()).not.toThrow();
  });
});

it('the registered crash control advances none of the twelve engine RNG streams', () => {
  const kernel = createKernel(REFERENCE_CONFIG, { checkInvariants: false });
  const before = kernel.snapshot().rng; kernel.fileSystemSubsystem.crash();
  expect(kernel.snapshot().rng).toEqual(before);
});

it.each(['prepared', 'payload', 'barrier1', 'commit', 'barrier2', 'home', 'checkpoint', 'complete'] as const)(
  'real unlink at %s survives or replays according to the second durable barrier', stage => {
    const h = corruptibleKernel(false); h.fs.setJournalMode('metadata');
    expect(h.kernel.syscall({ pid: h.pid, name: 'unlink', args: ['/original'] }).ok).toBe(true);
    const op = h.fs.pending({ pid: h.pid, tid: h.tid })!, tx = h.fs.state().journal.transactions.find(row => row.id === op.transactionId)!;
    h.until(() => tx.stage === stage);
    const committed = tx.secondBarrierAtTick !== null;
    h.fs.crash(); h.fs.consume(h.pid, h.tid); h.fs.recover(); h.until(() => h.fs.state().recovery === null);
    const resolved = h.fs.resolve('/original', h.pid); expect(resolved.ok).toBe(!committed);
    expect(h.events.filter(event => event.type === 'fs.corruption')).toEqual([]);
    expect(() => h.fs.checkInvariants()).not.toThrow();
    if (committed) {
      const metadata = h.fs.saveState().payload.metadata;
      const sectors = h.kernel.storageSubsystem.drives.get('disk0')!.saveState().sectors;
      h.fs.recovery.start(true); h.until(() => h.fs.state().recovery === null);
      expect(h.fs.saveState().payload.metadata).toEqual(metadata);
      expect(h.kernel.storageSubsystem.drives.get('disk0')!.saveState().sectors).toEqual(sectors);
    }
  });

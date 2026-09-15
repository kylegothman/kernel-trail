import { describe, expect, it } from 'vitest';
import { Journal, applyMetadataDelta, decodeFsRecord, emptyMetadataDelta, encodeFsRecord, fsSector,
  type JournalHost, type JournalImage, type MutableFsPayload } from '../../../src/kernel/fs/journal';
import { Recovery } from '../../../src/kernel/fs/recovery';
import { crashFileSystem } from '../../../src/kernel/fs/crash';
import { FreeSpace } from '../../../src/kernel/fs/freeSpace';
import { reservedFsBlocks } from '../../../src/kernel/fs/fsck';
import { StorageSubsystem } from '../../../src/kernel/storage/StorageSubsystem';
import { validateTransfer } from '../../../src/kernel/storage/DiskQueue';
import { serviceCost } from '../../../src/kernel/storage/costModel';
import { DEFAULT_DISK_GEOMETRY, blockToCylinder } from '../../../src/kernel/storage/geometry';
import { createRng } from '../../../src/kernel/rng';
import type { EmittableEvent } from '../../../src/kernel/EventBus';
import { asTick, type BlockId, type DeviceId, type FsMetadataDeltaSnapshot, type InodeId, type StorageResultSnapshot,
  type StorageTransferSnapshot, type Tick } from '../../../src/kernel/types';

type Completion = { readonly completedAtTick: Tick; readonly result: StorageResultSnapshot; readonly transfer: StorageTransferSnapshot };
type Sector = { readonly lba: number; readonly data: readonly number[] };
/** What the journal fixture needs from a block device; the disk media is WP-09's real StorageSubsystem. */
interface Media {
  submit(transfer: StorageTransferSnapshot): number;
  service(tick: Tick): void;
  take(id: number): Completion | null;
  readSector(lba: BlockId): readonly number[];
  crash(): void;
  sectors(): readonly Sector[];
}
function diskMedia(storage: StorageSubsystem): Media {
  return {
    submit: transfer => storage.submitDevice('disk0' as DeviceId, transfer, { kind: 'direct' }, null),
    service: tick => storage.serviceCompletions(tick),
    take: id => {
      const request = storage.request(id), completion = storage.takeCompletion(id);
      return completion === null || request === undefined ? null : { ...completion, transfer: request.transfer };
    },
    readSector: lba => storage.readSector('disk0', lba),
    crash: () => { storage.control('disk0' as DeviceId, 'crash', []); },
    sectors: () => storage.drives.get('disk0')!.saveState().sectors,
  };
}
/**
 * FCFS serial media over the same seek, rotation and transfer cost model as disk0.
 * FS-JOURNAL-COST leaves 16,003 sectors on the media, and DiskQueue.transfer (WP-09
 * territory) copies every stored sector on each write, which makes that run quadratic
 * and blows the CI budget. The sector count and the journal's write pattern are what
 * the fixture measures, so the cost fixture keeps a map of sectors instead.
 */
class SerialMedia implements Media {
  private readonly stored = new Map<number, number[]>();
  private readonly queue: { readonly id: number; readonly transfer: StorageTransferSnapshot }[] = [];
  private readonly done = new Map<number, Completion>();
  private active: { readonly id: number; readonly transfer: StorageTransferSnapshot; readonly completeAt: number } | null = null;
  private head = 0;
  private nextId = 0;
  submit(transfer: StorageTransferSnapshot): number {
    validateTransfer(transfer); const id = this.nextId++; this.queue.push({ id, transfer: structuredClone(transfer) }); return id;
  }
  service(tick: Tick): void {
    const active = this.active;
    if (active !== null && active.completeAt <= tick) {
      const transfer = active.transfer, length = transfer.kind === 'read' ? transfer.bytes : transfer.data.length, data: number[] = [];
      for (let i = 0; i < length; i += 1) {
        const lba = transfer.lba + Math.floor(i / 512), offset = i % 512;
        if (transfer.kind === 'read') data.push(this.stored.get(lba)?.[offset] ?? 0);
        else { let sector = this.stored.get(lba); if (sector === undefined) { sector = Array<number>(512).fill(0); this.stored.set(lba, sector); } sector[offset] = transfer.data[i]!; }
      }
      this.done.set(active.id, { completedAtTick: tick, result: { kind: 'ok', data }, transfer });
      this.head = blockToCylinder(transfer.lba); this.active = null;
    }
    if (this.active === null) {
      const next = this.queue.shift(); if (next === undefined) return;
      const cylinder = blockToCylinder(next.transfer.lba), bytes = next.transfer.kind === 'read' ? next.transfer.bytes : next.transfer.data.length;
      this.active = { ...next, completeAt: tick + serviceCost(Math.abs(cylinder - this.head), bytes, DEFAULT_DISK_GEOMETRY).ticks };
    }
  }
  take(id: number): Completion | null { const completion = this.done.get(id) ?? null; this.done.delete(id); return completion; }
  readSector(lba: BlockId): readonly number[] { return [...(this.stored.get(lba) ?? Array<number>(512).fill(0))]; }
  crash(): void {
    const tick = this.active === null ? asTick(0) : asTick(this.active.completeAt);
    for (const item of [...this.queue, ...(this.active === null ? [] : [this.active])]) this.done.set(item.id, { completedAtTick: tick, result: { kind: 'failed', reason: 'cancelled' }, transfer: item.transfer });
    this.queue.length = 0; this.active = null;
  }
  sectors(): readonly Sector[] { return [...this.stored].sort((a, b) => a[0] - b[0]).map(([lba, data]) => ({ lba, data })); }
}

function fixture(mode: 'off' | 'metadata' | 'full' = 'metadata', mediaKind: 'disk' | 'serial' = 'disk') {
  let tick = asTick(0);
  const events: EmittableEvent[] = [], state: MutableFsPayload = {
    tick, settings: { defaultAllocation: 'indexed', maxSymlinkDepth: 8, dentryCacheEntries: 128,
      fragmentationWarnExtents: 4, freeSpaceMethod: 'bitmap', linkedVariant: 'in_block', journalMode: mode },
    mountState: 'mounted', volume: { device: 'disk0' as DeviceId, firstSector: 0 as BlockId, blockCount: 6400,
      rootInode: 2 as InodeId, lostFoundInode: 3 as InodeId, superblock: 0 as BlockId, bitmapBlocks: [1 as BlockId],
      journalControlBlock: 5375 as BlockId, journalPayloadStart: 5376 as BlockId, journalPayloadBlocks: 1024, fatBlocks: [] },
    nextDescriptorId: 0, nextOperationId: 1, nextTransferId: 1, nextTransactionId: 1, nextImageGeneration: 1,
    lastTimerTick: null, metadata: { nextInodeId: 4, freeInodeIds: [], inodeGenerations: [], blockGenerations: [],
      inodes: [], directories: [], freeSpace: { kind: 'bitmap', words: [] } }, durableMetadata: [],
    caches: { dentries: [], metadata: [] }, descriptors: [], processes: [], operations: [], transfers: [],
    journal: { entries: [], transactions: [], checkpointedThrough: 0, retained: null }, recovery: null, corruption: [], lastCrash: null,
    counters: { completedOperations: 0, logicalBlockReads: 0, logicalBlockWrites: 0, logicalRunStarts: 0,
      physicalSectorReads: 0, physicalSectorWrites: 0, bitmapWordsScanned: 0 },
  };
  const free = new FreeSpace(6400, 'bitmap', reservedFsBlocks(state));
  state.metadata.freeSpace = free.snapshot() as MutableFsPayload['metadata']['freeSpace'];
  const storage = new StorageSubsystem({ tick: () => tick, enabled: () => true, emit: event => events.push(event), rng: createRng(17) });
  const media: Media = mediaKind === 'disk' ? diskMedia(storage) : new SerialMedia();
  let acknowledgedWrites = 0;
  // The journal asks for every image's transfer each tick, so the lookup is indexed by id.
  const index = new Map<number, MutableFsPayload['transfers'][number]>();
  const host: JournalHost = {
    state: () => state, tick: () => tick, emit: event => events.push(event),
    transfer: id => index.get(id),
    submit: (purpose, command) => {
      const id = state.nextTransferId++;
      let data: readonly number[] = [];
      if (command.kind === 'write') {
        const source = command.source;
        data = source.kind === 'inline' ? source.contents : source.kind === 'transaction_image'
          ? state.journal.transactions.find(tx => tx.id === source.txId)!.images[source.imageIndex]!.contents
          : state.journal.transactions.find(tx => tx.id === source.txId)!.controls[source.controlIndex]!.contents;
      }
      const requestId = media.submit(command.kind === 'read' ? { kind: 'read', lba: command.sectorLba, bytes: command.bytes } : { kind: 'write', lba: command.sectorLba, data });
      const row: MutableFsPayload['transfers'][number] = { id, purpose: structuredClone(purpose) as MutableFsPayload['transfers'][number]['purpose'],
        command: structuredClone(command) as MutableFsPayload['transfers'][number]['command'], progress: { kind: 'storage', requestId } };
      state.transfers.push(row); index.set(id, row); return id;
    },
  };
  const journal = new Journal(host), recovery = new Recovery(host);
  const step = () => {
    tick = asTick(tick + 1); state.tick = tick; media.service(tick);
    for (const transfer of state.transfers) {
      if (transfer.progress.kind !== 'storage') continue;
      const completion = media.take(transfer.progress.requestId);
      if (completion === null) continue;
      if (completion.result.kind === 'ok' && completion.transfer.kind === 'write') acknowledgedWrites += completion.transfer.data.length / 512;
      transfer.progress = { kind: 'settled', atTick: completion.completedAtTick,
        result: structuredClone(completion.result) as Extract<MutableFsPayload['transfers'][number]['progress'], { kind: 'settled' }>['result'] };
    }
    if (state.recovery === null) journal.advance(); else recovery.advance();
  };
  const until = (predicate: () => boolean, budget = 50000) => {
    for (let i = 0; i < budget && !predicate(); i++) step(); expect(predicate()).toBe(true);
  };
  const crash = () => crashFileSystem({ ...host, dropDirty: () => [], abortIo: () => { media.crash(); } }, journal);
  const image = (homeBlock = 100, kind: JournalImage['kind'] = 'data', byte = 7): JournalImage => ({ homeBlock: homeBlock as BlockId,
    generation: 1, kind, inode: kind === 'inode' ? 4 as InodeId : null, inodeGeneration: kind === 'inode' ? 1 : null,
    contents: Array<number>(4096).fill(byte) });
  const read = (block: number) => Array.from({ length: 8 }, (_, sector) => media.readSector(fsSector(state, block as BlockId, sector))).flat();
  return { state, storage, events, journal, recovery, host, image, read, step, until, crash, writes: () => acknowledgedWrites, sectors: () => media.sectors() };
}

describe('filesystem journal durability', () => {
  it('uses a bounded versioned metadata codec with Unicode and rejects oversized records', () => {
    const value = { name: 'café/λ/🪐', blocks: [0, 1, 6400] };
    expect(decodeFsRecord(encodeFsRecord(value))).toEqual(value);
    expect(() => encodeFsRecord({ text: 'x'.repeat(4096) })).toThrow('ENOSPC');
    expect(() => decodeFsRecord(Array<number>(4096).fill(0))).toThrow('header');
  });
  it('writes begin, write, commit and checkpoint with two acknowledged barriers in order', () => {
    const f = fixture('full'), id = f.journal.prepare({ images: [f.image()] });
    f.until(() => f.journal.isComplete(id));
    const tx = f.state.journal.transactions[0]!;
    expect(f.state.journal.entries.map(entry => entry.phase)).toEqual(['begin', 'write', 'commit', 'checkpoint']);
    expect(tx.firstBarrierAtTick).not.toBeNull(); expect(tx.secondBarrierAtTick).toBeGreaterThan(tx.firstBarrierAtTick!);
    expect(tx.checkpointAtTick).toBeGreaterThan(tx.secondBarrierAtTick!);
    const payload = f.host.transfer(tx.images[0]!.journalTransferId!)!.progress;
    const commit = f.host.transfer(tx.controls[1]!.transferId!)!.progress;
    const home = f.host.transfer(tx.images[0]!.homeTransferId!)!.progress;
    expect(payload.kind === 'settled' && payload.atTick <= tx.firstBarrierAtTick!).toBe(true);
    expect(commit.kind === 'settled' && commit.atTick <= tx.secondBarrierAtTick!).toBe(true);
    expect(home.kind === 'settled' && home.atTick < tx.checkpointAtTick!).toBe(true);
    expect(f.read(100)).toEqual(f.image().contents);
  });
  it('FS-JOURNAL-1 discards an incomplete transaction without touching its home', () => {
    const f = fixture('full'); f.journal.prepare({ images: [f.image()] });
    f.until(() => f.state.journal.transactions[0]!.stage === 'commit'); f.crash();
    expect(f.read(100)).toEqual(Array<number>(4096).fill(0));
    f.recovery.start(); f.until(() => f.state.recovery === null);
    expect(f.read(100)).toEqual(Array<number>(4096).fill(0)); expect(f.state.journal.transactions[0]!.stage).toBe('aborted');
  });
  it('an appended commit without the second barrier remains incomplete', () => {
    const f = fixture('full'); f.journal.prepare({ images: [f.image()] });
    f.until(() => f.state.journal.transactions[0]!.stage === 'barrier2'); f.crash();
    f.recovery.start(); f.until(() => f.state.recovery === null); expect(f.read(100)).toEqual(Array<number>(4096).fill(0));
    expect(f.state.journal.entries.map(entry => entry.phase)).toEqual(['begin', 'write']);
  });
  it('FS-JOURNAL-2 replays a durable commit before home writes and FS-JOURNAL-3 is idempotent', () => {
    const f = fixture('full'); f.journal.prepare({ images: [f.image()] });
    f.until(() => f.state.journal.transactions[0]!.stage === 'home'); expect(f.read(100)[0]).toBe(0); f.crash();
    f.recovery.start(); f.until(() => f.state.recovery === null); expect(f.read(100)).toEqual(f.image().contents);
    const media = f.sectors();
    f.recovery.start(true); f.until(() => f.state.recovery === null);
    expect(f.sectors()).toEqual(media);
    expect(f.state.counters.bitmapWordsScanned).toBe(400);
  });
  it('metadata mode journals allocation images and distinguishes bitmap words from device reads', () => {
    const f = fixture(); const id = f.journal.prepare({ images: [f.image(100), f.image(101, 'allocation')] });
    f.until(() => f.journal.isComplete(id));
    expect(f.state.journal.transactions[0]!.images.map(image => image.journalBlock)).toEqual([null, 5376]);
    f.recovery.start(true); f.until(() => f.state.recovery === null);
    expect(f.state.counters.bitmapWordsScanned).toBe(200);
    const reads = f.state.transfers.filter(transfer => transfer.command.kind === 'read'); expect(reads).toHaveLength(1);
    expect(reads[0]!.command).toMatchObject({ bytes: 4096 });
  });
  it('serializes queued transactions and preserves continuation when Journal is reconstructed', () => {
    const f = fixture('full'); const first = f.journal.prepare({ images: [f.image(100)] });
    const second = f.journal.prepare({ images: [f.image(101, 'data', 8)] });
    f.until(() => f.journal.isComplete(first)); expect(f.state.journal.transactions[1]!.stage).toBe('prepared');
    const restored = new Journal(f.host); restored.advance(); f.until(() => f.journal.isComplete(second));
    expect(f.state.journal.entries.map(entry => entry.txId)).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
    expect(f.state.journal.retained?.txId).toBe(second); expect(f.read(101)[0]).toBe(8);
  });
  it('rejects oversized transactions before changing IDs or protocol state', () => {
    const f = fixture('full'), before = structuredClone(f.state);
    expect(() => f.journal.prepare({ images: Array.from({ length: 1025 }, (_, i) => f.image(100 + i)) })).toThrow('ENOSPC');
    expect(f.state).toEqual(before);
  });
  it('replays idempotent assignment deltas and reports each affected inode once per invocation', () => {
    const f = fixture('full'), delta: FsMetadataDeltaSnapshot = { ...emptyMetadataDelta(),
      inodeAllocator: { nextBefore: 4, nextAfter: 5, freeBefore: [], freeAfter: [] } };
    applyMetadataDelta(f.state.metadata, delta); applyMetadataDelta(f.state.metadata, delta); expect(f.state.metadata.nextInodeId).toBe(5);
    applyMetadataDelta(f.state.metadata, delta, 'before'); expect(f.state.metadata.nextInodeId).toBe(4);
  });
  // Three serial-media runs of about 18,000 ticks each took 4.6 s on the devcontainer;
  // the budget below covers a CI runner four times slower, the way DET-D4 declares its own.
  it('FS-JOURNAL-COST measures every completed physical sector including three control writes', () => {
    const measured: number[] = [];
    for (const mode of ['off', 'metadata', 'full'] as const) {
      const f = fixture(mode, 'serial'), images = Array.from({ length: 1000 }, (_, i) => f.image(100 + i, i < 900 ? 'data' : 'allocation'));
      const id = f.journal.prepare({ images }); f.until(() => f.journal.isComplete(id));
      measured.push(f.writes());
      expect(f.sectors().length).toBe(f.writes());
    }
    expect(measured, 'S6 measured completed sectors must match the approved algebra; disagreement stops work').toEqual([8000, 8803, 16003]);
    expect(measured.map(value => value / measured[0]!)).toEqual([1, 1.100375, 2.000375]);
  }, 40_000);
});

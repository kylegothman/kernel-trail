import type { EmittableEvent } from '../EventBus';
import { KernelConfigError } from '../errors';
import type { IoSubsystem } from '../io/IoSubsystem';
import { plainData } from '../io/drivers/DeviceDriver';
import type { StorageSubsystem } from '../storage/StorageSubsystem';
import type { AccessRight, BlockId, BlockReason, DeviceId, DomainId, Errno, FileDescriptor, FileAllocationMethod,
  FsCallSnapshot, FsDirectorySnapshot, FsInodeSnapshot, FsMetadataDeltaSnapshot, FsMetadataSnapshot,
  FsOperationSnapshot, FsSnapshotState, FsTransactionSnapshot, FsTransferSnapshot, InodeId, JournalEntry, KernelSnapshot,
  Pid, ProcessControlBlock, SyscallRequest, SyscallResult, Tick, Tid } from '../types';
import { InodeTable, MAX_FILE_SIZE, inodeId } from './InodeTable';
import { DirectoryTable } from './DirectoryTable';
import { PathResolver, type PathResult } from './pathResolution';
import { FreeSpace, fsBlock, validateAllocationPair } from './freeSpace';
import { allocateBlocks, readPlan, usableBlockBytes } from './allocation/registry';
import { Journal, applyMetadataDelta, decodeFsRecord, emptyMetadataDelta, encodeFsRecord, fsSector,
  type JournalImage, type Mutable, type MutableFsPayload } from './journal';
import { Recovery } from './recovery';
import { crashFileSystem } from './crash';
import { tooManyOpenFiles } from '../syscall/errno';
import { prepareFsck, reservedFsBlocks, verifyFileSystem } from './fsck';

export type FsSettings = FsSnapshotState['payload']['settings'];
type Actor = { readonly pid: Pid; readonly tid: Tid };
type Operation = Mutable<FsOperationSnapshot>;
const success = (value: string | number | boolean | null = null): SyscallResult => ({ ok: true, value });
const failure = (errno: Errno, message: string): SyscallResult => ({ ok: false, errno, message });
const clone = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sameElements = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((item, index) => item === b[index]);
export interface FsHost {
  tick(): Tick;
  enabled(): boolean;
  process(pid: Pid): ProcessControlBlock | undefined;
  actor(pid: Pid): Actor | undefined;
  domain(pid: Pid): DomainId;
  block(actor: Actor, device: DeviceId): void;
  publishResult(pid: Pid, result: SyscallResult, request?: SyscallRequest): void;
  emit(event: EmittableEvent): void;
  check(domain: DomainId, inode: FsInodeSnapshot, right: AccessRight): boolean;
  inodeCreated?(inode: FsInodeSnapshot): void;
  /** Descriptors one process may hold open (sim spec 14.3); 32 when the host does not say. WP-11 decision D6. */
  maxOpenFiles?(): number;
  storage: StorageSubsystem;
  io: IoSubsystem;
}

export function emptyFsPayload(tick: Tick, settings: FsSettings): MutableFsPayload {
  return { tick, settings: { ...settings }, mountState: 'unformatted', volume: null,
    nextDescriptorId: 0, nextOperationId: 1, nextTransferId: 1, nextTransactionId: 1, nextImageGeneration: 1, lastTimerTick: null,
    metadata: { nextInodeId: 2, freeInodeIds: [], inodeGenerations: [], blockGenerations: [], inodes: [], directories: [], freeSpace: clone(new FreeSpace(0, settings.freeSpaceMethod).snapshot()) },
    durableMetadata: [], caches: { dentries: [], metadata: [] }, descriptors: [], processes: [], operations: [], transfers: [],
    journal: { entries: [], transactions: [], checkpointedThrough: 0, retained: null }, recovery: null, corruption: [], lastCrash: null,
    counters: { completedOperations: 0, logicalBlockReads: 0, logicalBlockWrites: 0, logicalRunStarts: 0,
      physicalSectorReads: 0, physicalSectorWrites: 0, bitmapWordsScanned: 0 } };
}

/** Namespace state is published on home acknowledgement; waits and byte sources are plain continuation data. */
export class FileSystemSubsystem {
  readonly inodeTable = new InodeTable();
  readonly directories = new DirectoryTable(this.inodeTable);
  readonly journalEntries: JournalEntry[] = [];
  readonly journal: Journal;
  readonly recovery: Recovery;
  readonly paths: PathResolver;
  private data: MutableFsPayload;
  private transferIndex: { readonly source: readonly FsTransferSnapshot[]; readonly byId: Map<number, FsTransferSnapshot> } | null = null;
  private mirrored: { inodes: readonly FsInodeSnapshot[]; directories: readonly FsDirectorySnapshot[]; entries: readonly JournalEntry[] } = { inodes: [], directories: [], entries: [] };
  constructor(private readonly host: FsHost, settings: FsSettings) {
    validateAllocationPair(settings.defaultAllocation, settings.freeSpaceMethod);
    this.data = emptyFsPayload(host.tick(), settings);
    this.paths = new PathResolver({ inode: id => this.inodeTable.get(id),
      checkExecute: (domain, id) => { const inode = this.inodeTable.get(id); return inode !== undefined && this.host.check(domain, inode, 'execute'); } }, this.directories, settings);
    this.journal = new Journal(this); this.recovery = new Recovery(this);
  }
  get inodes() { return this.inodeTable.inodes; }
  state(): FsSnapshotState['payload'] { return this.data; }
  tick(): Tick { return this.host.tick(); }
  emit(event: EmittableEvent): void { if (this.host.enabled()) this.host.emit(event); }
  get busy(): boolean { return this.data.mountState === 'formatting' || this.data.recovery !== null
    || this.data.journal.transactions.some(tx => !['complete', 'aborted'].includes(tx.stage))
    || this.data.operations.some(op => op.stage !== 'complete'); }
  get mounted(): boolean { return this.data.mountState === 'mounted'; }
  setJournalMode(mode: FsSettings['journalMode']): void {
    if (!['off', 'metadata', 'full'].includes(mode) || this.busy) throw new KernelConfigError('invalid journal mode or busy filesystem');
    this.data.settings.journalMode = mode;
  }
  setAllocation(method: FileAllocationMethod): void {
    validateAllocationPair(method, this.data.settings.freeSpaceMethod); this.data.settings.defaultAllocation = method;
  }
  /** Formatting is explicit. Constructing an enabled filesystem performs no I/O. */
  format(options: { readonly device?: DeviceId; readonly blockCount?: number; readonly firstSector?: BlockId; readonly owner?: DomainId } = {}): number {
    if (!this.host.enabled() || this.data.mountState !== 'unformatted') throw new KernelConfigError('filesystem is disabled or already formatted');
    const device = options.device ?? 'disk0' as DeviceId, firstSector = options.firstSector ?? fsBlock(0), blockCount = options.blockCount ?? 6400;
    const target = this.host.storage.deviceTarget(device);
    if (target === null || !Number.isSafeInteger(firstSector) || firstSector < 0 || !Number.isSafeInteger(blockCount) || blockCount < 16) throw new KernelConfigError('invalid filesystem volume');
    const drive = target.kind === 'disk' ? this.host.storage.drives.get(target.driveId) : undefined;
    if (drive !== undefined && firstSector + blockCount * 8 > drive.geometry.cylinders * drive.geometry.headsPerCylinder * drive.geometry.sectorsPerTrack) throw new KernelConfigError('filesystem exceeds storage capacity');
    const payload = Math.min(1024, Math.floor(blockCount / 4)), payloadStart = blockCount - payload;
    const bitmapCount = Math.ceil(blockCount / (4096 * 8));
    if (bitmapCount !== 1) throw new KernelConfigError('version 1 volume bitmap exceeds one reserved image');
    const fatCount = this.data.settings.linkedVariant === 'fat' ? Math.ceil(blockCount * 32 / 4096) : 0;
    if (payloadStart - 1 <= 6 + fatCount) throw new KernelConfigError('filesystem reservations leave no data blocks');
    this.data.volume = { device, firstSector, blockCount, rootInode: inodeId(2), lostFoundInode: inodeId(3), superblock: fsBlock(0),
      bitmapBlocks: [fsBlock(1)], journalControlBlock: fsBlock(payloadStart - 1), journalPayloadStart: fsBlock(payloadStart), journalPayloadBlocks: payload,
      fatBlocks: Array.from({ length: fatCount }, (_, i) => fsBlock(6 + i)) };
    const table = new InodeTable(), dirs = new DirectoryTable(table), free = new FreeSpace(blockCount, this.data.settings.freeSpaceMethod, reservedFsBlocks(this.data));
    const owner = options.owner ?? 'domain:kernel' as DomainId;
    const root = table.create({ id: inodeId(2), name: '/', kind: 'directory', method: 'extent', owner, tick: this.tick(), metadataBlock: fsBlock(2) });
    const lost = table.create({ id: inodeId(3), name: 'lost+found', kind: 'directory', method: 'extent', owner, tick: this.tick(), metadataBlock: fsBlock(4) });
    for (const [inode, block] of [[root, fsBlock(3)], [lost, fsBlock(5)]] as const) {
      const generation = table.nextBlockGeneration(block); table.nextBlockGeneration(inode.metadataBlock);
      table.update(inode.id, { blocks: [block], mapping: [{ logicalBlock: 0, block, generation }], allocation: { kind: 'extent', extents: [{ logicalStart: 0, startBlock: block, length: 1 }] } });
    }
    dirs.create(root.id); dirs.create(lost.id, root.id); dirs.add(root.id, 'lost+found', table.get(lost.id)!, true);
    const after = this.plannedMetadata(table, dirs, free), delta = metadataDifference(this.data.metadata, after);
    try {
      const images = this.metadataImages(after, delta);
      images.push(this.image(fsBlock(0), 'superblock', encodeFsRecord({ kind: 'superblock', volume: this.data.volume })));
      const id = this.journal.prepare({ images, changes: delta, mode: 'off' }); this.data.mountState = 'formatting'; return id;
    } catch (error) { this.data.volume = null; throw error; }
  }
  resolve(path: string, pid: Pid): PathResult {
    if (!this.mounted) return { ok: false, errno: 'EINVAL', reads: 0, message: 'filesystem is not mounted' };
    return this.paths.resolve(path, this.process(pid).cwd, this.host.domain(pid));
  }
  chdir(pid: Pid, path: string): SyscallResult {
    const result = this.resolve(path, pid); if (!result.ok) return failure(result.errno, result.message);
    if (result.inode.kind !== 'directory') return failure('EINVAL', 'cwd must be a directory');
    const process = this.process(pid); process.cwd = result.inode.id; process.cwdGeneration = result.inode.generation; return success();
  }
  createFile(path: string, options: { readonly pid?: Pid; readonly domain?: DomainId; readonly method?: FileAllocationMethod;
    readonly kind?: FsInodeSnapshot['kind']; readonly symlinkTarget?: string; readonly programName?: string } = {}): InodeId {
    if (!this.mounted || this.busy) throw new KernelConfigError('filesystem is not ready');
    const domain = options.domain ?? (options.pid === undefined ? 'domain:kernel' as DomainId : this.host.domain(options.pid));
    const cwd = options.pid === undefined ? this.data.volume!.rootInode : this.process(options.pid).cwd;
    const prepared = this.newNode(path, cwd, domain, options);
    this.journal.prepare({ images: this.metadataImages(prepared.after, prepared.delta), changes: prepared.delta });
    return prepared.inode.id;
  }
  hardLink(pid: Pid, source: string, destination: string): SyscallResult {
    if (this.busy) return failure('EBUSY', 'filesystem has pending work');
    const from = this.resolve(source, pid); if (!from.ok) return failure(from.errno, from.message);
    if (from.inode.kind === 'directory') return failure('EINVAL', 'directory hard links are forbidden');
    try {
      const { table, dirs, free } = this.plan(), { parent, name } = this.parent(destination, this.process(pid).cwd, this.host.domain(pid));
      dirs.add(parent.id, name, from.inode); const after = this.plannedMetadata(table, dirs, free), delta = metadataDifference(this.data.metadata, after);
      this.journal.prepare({ images: this.metadataImages(after, delta), changes: delta }); return success();
    } catch (error) { return this.error(error); }
  }
  bindProgram(inode: InodeId, name: string): void {
    if (this.busy) throw new KernelConfigError('filesystem has pending work');
    const { table, dirs, free } = this.plan(); table.update(inode, { programName: name, permissions: { ...table.get(inode)!.permissions, execute: true } });
    const after = this.plannedMetadata(table, dirs, free), delta = metadataDifference(this.data.metadata, after);
    this.journal.prepare({ images: this.metadataImages(after, delta), changes: delta });
  }
  execTarget(pid: Pid, path: string): { readonly result: SyscallResult; readonly inode?: FsInodeSnapshot; readonly programName?: string } {
    const resolved = this.resolve(path, pid); if (!resolved.ok) return { result: failure(resolved.errno, resolved.message) };
    const inode = resolved.inode;
    if (!inode.permissions.execute || !this.host.check(this.host.domain(pid), inode, 'execute')) return { result: failure('EACCES', 'execute denied') };
    if (inode.programName === null) return { result: failure('EINVAL', 'inode has no registered program') };
    return { result: success(), inode, programName: inode.programName };
  }
  syscall(request: SyscallRequest): SyscallResult {
    if (!this.host.enabled() || !this.mounted) return failure('EINVAL', 'filesystem is not mounted');
    const actor = this.host.actor(request.pid); if (actor === undefined) return failure('ESRCH', 'filesystem caller is missing');
    const existing = this.pending(actor); if (existing !== undefined) return existing.result ?? success();
    // Mode 'wx' is create-exclusive (sim spec 14.3): an existing path is EEXIST, otherwise the call proceeds as 'w'. WP-11 decision D6.
    if (request.name === 'open' && request.args[1] === 'wx' && request.args.length === 2 && typeof request.args[0] === 'string') {
      if (this.resolve(request.args[0], request.pid).ok) return failure('EEXIST', `path exists: ${request.args[0]}`);
      return this.syscall({ ...request, args: [request.args[0], 'w'] });
    }
    const decoded = decodeFileCall(request); if (!decoded.ok) return decoded.result;
    const call = decoded.call;
    if (call.name === 'close') return this.close(request.pid, call.fd);
    if (call.name === 'seek') return this.seek(request.pid, call.fd, call.offset, call.whence);
    const operation: Operation = { id: this.data.nextOperationId++, actor: { ...actor }, callerDomain: this.host.domain(actor.pid),
      requestedAtTick: this.tick(), call: clone(call), stage: 'queued', inode: null, inodeGeneration: null, descriptor: null,
      startOffset: null, nextOffset: null, transactionId: null, transferIds: [], cacheSyncId: null, contents: [], result: null,
      resultPublished: false, effectsApplied: false, instructionRetired: false, wakeable: false };
    this.data.operations.push(operation); this.advanceOperations();
    if (operation.stage !== 'complete') this.host.block(actor, this.data.volume!.device);
    return operation.result ?? success();
  }
  /** Byte-bearing helper uses the same pending operation as the scalar write ABI. */
  writeBytes(pid: Pid, fd: FileDescriptor, contents: readonly number[]): SyscallResult {
    if (contents.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) return failure('EINVAL', 'invalid byte');
    const actor = this.host.actor(pid); if (actor === undefined) return failure('ESRCH', 'filesystem caller is missing');
    const result = this.syscall({ pid, name: 'write', args: [fd, contents.length] });
    const operation = this.pending(actor); if (operation !== undefined && operation.stage !== 'complete') operation.contents = [...contents];
    return result;
  }
  readBytes(pid: Pid, fd: FileDescriptor, count: number): SyscallResult { return this.syscall({ pid, name: 'read', args: [fd, count] }); }
  operation(id: number): FsOperationSnapshot | undefined { return this.data.operations.find(op => op.id === id); }
  pending(actor: Actor): Operation | undefined { return this.data.operations.find(op => op.actor.pid === actor.pid && op.actor.tid === actor.tid && !op.instructionRetired); }
  ownsWait(pid: Pid, tid: Tid, reason: BlockReason): boolean { return reason.kind === 'io' && this.pending({ pid, tid }) !== undefined; }
  isSatisfied(pid: Pid, tid: Tid): boolean { return this.pending({ pid, tid })?.wakeable === true; }
  instructionOutcome(actor: Actor): { readonly advance: boolean; readonly deferService: boolean } | null {
    const operation = this.pending(actor); if (operation === undefined) return null;
    if (operation.stage !== 'complete') return { advance: false, deferService: true };
    operation.instructionRetired = true; return { advance: true, deferService: false };
  }
  consume(pid: Pid, tid: Tid): SyscallResult | null {
    const operation = this.pending({ pid, tid }); if (operation?.stage !== 'complete') return null;
    operation.instructionRetired = true; return operation.result;
  }
  retainDescriptor(fd: FileDescriptor): void { const descriptor = this.data.descriptors.find(row => row.fd === fd); if (descriptor !== undefined) descriptor.references++; }
  fork(parent: ProcessControlBlock, child: ProcessControlBlock): void {
    const old = this.data.processes.find(row => row.pid === parent.pid); if (old !== undefined) this.data.processes.push({ ...clone(old), pid: child.pid });
  }
  closeOnExec(pcb: ProcessControlBlock, fd: FileDescriptor): boolean { return this.data.processes.find(row => row.pid === pcb.pid)?.descriptors.find(row => row.fd === fd)?.closeOnExec ?? false; }
  setCloseOnExec(pid: Pid, fd: FileDescriptor, value: boolean): void { const membership = this.process(pid).descriptors.find(row => row.fd === fd); if (membership === undefined) throw new KernelConfigError('descriptor is not open'); membership.closeOnExec = value; }
  closeDescriptor(pcb: ProcessControlBlock, fd: FileDescriptor): void { this.close(pcb.pid, fd); }
  removeProcess(pid: Pid): void {
    for (const operation of this.data.operations.filter(op => op.actor.pid === pid && !op.instructionRetired && op.stage !== 'complete')) {
      operation.instructionRetired = true; operation.wakeable = false; operation.stage = 'complete';
      operation.result = { ok: false, errno: 'EINVAL', message: 'filesystem caller exited' }; operation.resultPublished = true;
    }
    const process = this.data.processes.find(row => row.pid === pid);
    if (process?.descriptors.length === 0) this.data.processes = this.data.processes.filter(row => row.pid !== pid);
  }
  transfer(id: number): FsTransferSnapshot | undefined {
    // The journal barrier scan asks for every image's transfer each tick; a linear find there is quadratic per tick.
    const rows = this.data.transfers;
    if (this.transferIndex?.source !== rows) this.transferIndex = { source: rows, byId: new Map(rows.map(row => [row.id, row])) };
    return this.transferIndex.byId.get(id);
  }
  submit(purpose: FsTransferSnapshot['purpose'], command: FsTransferSnapshot['command']): number {
    const id = this.data.nextTransferId++, row: Mutable<FsTransferSnapshot> = { id, purpose: clone(purpose), command: clone(command), progress: { kind: 'planned' } };
    this.data.transfers.push(row); if (this.transferIndex?.source === this.data.transfers) this.transferIndex.byId.set(id, row); return id;
  }
  expireTimers(tick: Tick): void {
    if (!this.host.enabled() || this.data.lastTimerTick === tick) return;
    this.data.tick = tick; this.data.lastTimerTick = tick; this.pumpTransfers();
    this.journal.advance(); this.recovery.advance(); this.refresh();
    if (this.data.mountState === 'formatting' && this.data.journal.transactions[0]?.stage === 'complete') this.data.mountState = 'mounted';
    this.advanceOperations();
    if (this.mounted && !this.busy) {
      const retired = this.data.metadata.inodes.find(inode => inode.linkCount === 0 && !this.data.descriptors.some(fd => fd.inode === inode.id && fd.inodeGeneration === inode.generation));
      if (retired !== undefined) this.reap(retired);
    }
    this.pumpTransfers(); this.refresh();
  }
  crash(): void {
    this.pumpTransfers();
    crashFileSystem({ state: () => this.data, tick: () => this.tick(), emit: event => this.emit(event),
      submit: (purpose, command) => this.submit(purpose, command), transfer: id => this.transfer(id),
      dropDirty: () => { const rows = this.host.io.cache.snapshot().entries.filter(row => row.generation > row.durableGeneration)
        .map(row => ({ device: row.device, sectorLba: row.block })); this.host.io.cache.dropDirty(); return rows; },
      abortIo: () => this.host.io.crashAbort(), reloadMetadata: () => this.reloadMetadata(),
    }, this.journal); this.paths.invalidate();
    for (const operation of this.data.operations) if (operation.stage === 'complete' && !operation.resultPublished) this.finish(operation, operation.result ?? failure('EINVAL', 'filesystem interrupted'));
    this.refresh();
  }
  /** Remount surviving home images without replay or repair for the crash lesson. */
  mount(): void {
    if (this.data.volume === null || !['crashed', 'unformatted'].includes(this.data.mountState)) throw new KernelConfigError('filesystem has no crashed volume to mount');
    this.reloadMetadata(); this.data.mountState = 'mounted'; this.paths.invalidate(); this.refresh();
  }
  recover(): void { this.recovery.start(); }
  fsck(): number { const delta = prepareFsck(this), after = clone(this.data.metadata); applyMetadataDelta(after, delta);
    return this.journal.prepare({ images: this.metadataImages(after, delta), changes: delta }); }
  rebuildInodeFromJournal(inode: InodeId): boolean { return this.recovery.rebuildInodeFromJournal(inode); }
  checkInvariants(slow = true): void { verifyFileSystem(this, slow); }
  saveState(): FsSnapshotState { this.observeCacheTransfers(); this.data.tick = this.tick(); this.data.caches.dentries = clone(this.paths.snapshot()); return { owner: 'fs', version: 1, payload: clone(this.data) }; }
  prepareRestore(state: FsSnapshotState): () => void {
    plainData(state); if (state.owner !== 'fs' || state.version !== 1) throw new KernelConfigError('invalid filesystem snapshot');
    const data = clone(state.payload), table = new InodeTable();
    if (!Number.isSafeInteger(data.tick) || data.tick < 0 || data.lastTimerTick !== null && (!Number.isSafeInteger(data.lastTimerTick) || data.lastTimerTick < 0 || data.lastTimerTick > data.tick)
      || Object.values(data.counters).some(value => !Number.isSafeInteger(value) || value < 0)
      || !Number.isSafeInteger(data.nextDescriptorId) || data.nextDescriptorId < 0 || !Number.isSafeInteger(data.nextImageGeneration) || data.nextImageGeneration < 1
      || !['unformatted', 'formatting', 'mounted', 'crashed'].includes(data.mountState)) throw new KernelConfigError('invalid filesystem counters or state');
    validateAllocationPair(data.settings.defaultAllocation, data.settings.freeSpaceMethod);
    if (!['contiguous', 'linked', 'indexed', 'extent'].includes(data.settings.defaultAllocation)
      || !['bitmap', 'linked_list', 'grouping', 'counting'].includes(data.settings.freeSpaceMethod) || !['in_block', 'fat'].includes(data.settings.linkedVariant)
      || !['off', 'metadata', 'full'].includes(data.settings.journalMode) || !Number.isSafeInteger(data.settings.fragmentationWarnExtents) || data.settings.fragmentationWarnExtents < 0) throw new KernelConfigError('invalid filesystem settings');
    if (data.volume !== null && (!Number.isSafeInteger(data.volume.blockCount) || data.volume.blockCount < 16 || !Number.isSafeInteger(data.volume.firstSector) || data.volume.firstSector < 0
      || data.volume.rootInode !== 2 || data.volume.lostFoundInode !== 3 || data.volume.journalPayloadStart + data.volume.journalPayloadBlocks > data.volume.blockCount
      || data.volume.journalControlBlock >= data.volume.journalPayloadStart || data.volume.journalPayloadBlocks < 1
      || reservedFsBlocks(data).some(block => block < 0 || block >= data.volume!.blockCount))) throw new KernelConfigError('invalid filesystem volume');
    if (data.volume === null && (data.metadata.inodes.length > 0 || data.descriptors.length > 0 || data.processes.length > 0 || data.operations.length > 0 || data.transfers.length > 0)) throw new KernelConfigError('unformatted filesystem contains owners');
    table.restore(data.metadata);
    const dirs = new DirectoryTable(table); dirs.restore(data.metadata.directories);
    const paths = new PathResolver({ inode: id => table.get(id), checkExecute: () => true }, dirs, data.settings); paths.restore(data.caches.dentries);
    if (data.volume !== null) { const free = new FreeSpace(data.volume.blockCount, data.settings.freeSpaceMethod); free.restore(data.metadata.freeSpace); }
    for (const [ids, next] of [[data.operations.map(op => op.id), data.nextOperationId], [data.transfers.map(row => row.id), data.nextTransferId], [data.journal.transactions.map(tx => tx.id), data.nextTransactionId]] as const)
      if (!Number.isSafeInteger(next) || next < 1 || new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id) || id < 1 || id >= next)) throw new KernelConfigError('invalid filesystem identifiers');
    for (const descriptor of data.descriptors) if (!Number.isSafeInteger(descriptor.fd) || descriptor.fd < 0 || !Number.isSafeInteger(descriptor.offset) || descriptor.offset < 0 || descriptor.offset > MAX_FILE_SIZE || !Number.isSafeInteger(descriptor.references) || descriptor.references < 1 || descriptor.fd >= data.nextDescriptorId || !['r', 'w', 'rw', 'a'].includes(descriptor.mode) || table.get(descriptor.inode)?.generation !== descriptor.inodeGeneration || descriptor.references !== data.processes.reduce((n, p) => n + Number(p.descriptors.some(fd => fd.fd === descriptor.fd)), 0)) throw new KernelConfigError('invalid filesystem descriptor references');
    if (new Set(data.descriptors.map(row => row.fd)).size !== data.descriptors.length || new Set(data.processes.map(row => row.pid)).size !== data.processes.length) throw new KernelConfigError('duplicate filesystem owner');
    for (const process of data.processes) if (table.get(process.cwd)?.generation !== process.cwdGeneration || new Set(process.descriptors.map(row => row.fd)).size !== process.descriptors.length || process.descriptors.some(row => !data.descriptors.some(fd => fd.fd === row.fd))) throw new KernelConfigError('invalid process file state');
    for (const op of data.operations) if (op.transferIds.some(id => !data.transfers.some(row => row.id === id)) || op.transactionId !== null && !data.journal.transactions.some(tx => tx.id === op.transactionId)) throw new KernelConfigError('invalid filesystem continuation');
    return () => { this.data = data; this.refresh(); this.paths.restore(data.caches.dentries); };
  }
  prepareKernelRestore(snapshot: KernelSnapshot): () => void {
    let state = snapshot.subsystems?.fs;
    if (state === undefined) {
      if (snapshot.subsystems !== undefined || snapshot.inodes.length !== 0 || snapshot.journal.length !== 0) throw new KernelConfigError('missing filesystem snapshot');
      const payload = emptyFsPayload(snapshot.tick, { ...this.data.settings, defaultAllocation: snapshot.config.fileAllocation });
      payload.lastTimerTick = snapshot.tick === 0 ? null : snapshot.tick; state = { owner: 'fs', version: 1, payload };
    }
    const commit = this.prepareRestore(state), table = new InodeTable(); table.restore(state.payload.metadata);
    if (state.payload.tick !== snapshot.tick || !same(table.inodes, snapshot.inodes) || !same(state.payload.journal.entries, snapshot.journal)) throw new KernelConfigError('filesystem shared mirrors disagree');
    for (const transfer of state.payload.transfers) if (transfer.progress.kind === 'storage'
      && !snapshot.subsystems?.storage?.payload.requests.some(request => request.id === (transfer.progress as { requestId: number }).requestId)) throw new KernelConfigError('filesystem storage continuation missing');
    for (const transfer of state.payload.transfers) if (transfer.progress.kind === 'cache') {
      const progress = transfer.progress, cache = snapshot.subsystems?.io?.payload.cache;
      if (cache === undefined || !cache.flushes.some(flush => flush.id === progress.flushId && flush.generation === progress.generation)) throw new KernelConfigError('filesystem cache continuation missing');
    }
    return commit;
  }
  private process(pid: Pid): MutableFsPayload['processes'][number] {
    let process = this.data.processes.find(row => row.pid === pid);
    if (process === undefined) { const root = this.data.volume!.rootInode; process = { pid, cwd: root, cwdGeneration: this.inodeTable.generation(root), descriptors: [] }; this.data.processes.push(process); this.data.processes.sort((a, b) => a.pid - b.pid); }
    return process;
  }
  private descriptor(pid: Pid, fd: FileDescriptor) { return this.process(pid).descriptors.some(item => item.fd === fd) ? this.data.descriptors.find(row => row.fd === fd) : undefined; }
  private close(pid: Pid, fd: FileDescriptor): SyscallResult {
    const descriptor = this.descriptor(pid, fd); if (descriptor === undefined) return failure('EINVAL', 'descriptor is not open');
    const process = this.process(pid); process.descriptors = process.descriptors.filter(row => row.fd !== fd);
    const pcb = this.host.process(pid); if (pcb !== undefined) { const i = pcb.openFiles.indexOf(fd); if (i >= 0) pcb.openFiles.splice(i, 1); }
    descriptor.references--; if (descriptor.references === 0) this.data.descriptors = this.data.descriptors.filter(row => row !== descriptor);
    const inode = this.inodeTable.get(descriptor.inode); if (inode?.linkCount === 0 && descriptor.references === 0 && !this.data.descriptors.some(row => row.inode === inode.id && row.inodeGeneration === inode.generation) && !this.busy) this.reap(inode);
    return success();
  }
  private seek(pid: Pid, fd: FileDescriptor, offset: number, whence: 0 | 1 | 2): SyscallResult {
    const descriptor = this.descriptor(pid, fd); if (descriptor === undefined) return failure('EINVAL', 'descriptor is not open');
    const inode = this.inodeTable.get(descriptor.inode); if (inode === undefined || inode.generation !== descriptor.inodeGeneration) return failure('EINVAL', 'stale descriptor');
    const next = offset + (whence === 0 ? 0 : whence === 1 ? descriptor.offset : inode.sizeBytes);
    if (!Number.isSafeInteger(next) || next < 0 || next > MAX_FILE_SIZE) return failure('EINVAL', 'invalid file offset');
    descriptor.offset = next; return success(next);
  }
  private finish(op: Operation, result: SyscallResult): void {
    op.stage = 'complete'; op.result = clone(result); op.wakeable = true;
    if (!op.resultPublished) { op.resultPublished = true; this.data.counters.completedOperations++; this.host.publishResult(op.actor.pid, result, operationRequest(op)); }
  }
  private advanceOperations(): void {
    if (!this.mounted || this.data.recovery !== null) return;
    const op = this.data.operations.find(row => row.stage !== 'complete'); if (op === undefined) return;
    if (op.stage === 'transaction') {
      const tx = this.data.journal.transactions.find(row => row.id === op.transactionId);
      if (tx?.stage === 'aborted') this.finish(op, tx.failure === null ? failure('EINVAL', 'transaction aborted') : { ok: false, ...tx.failure });
      else if (tx?.stage === 'complete') { this.applyOperationEffects(op); this.finish(op, op.result ?? success()); }
      return;
    }
    if (op.stage === 'syncing') {
      if (this.data.journal.transactions.some(tx => !['complete', 'aborted'].includes(tx.stage))) return;
      if (op.cacheSyncId === null) {
        const before = this.host.io.cache.snapshot().syncs.map(group => group.id); const result = this.host.io.sync(op.actor);
        const group = this.host.io.cache.snapshot().syncs.find(item => !before.includes(item.id));
        if (!result.ok) { this.finish(op, result); return; }
        if (group === undefined) { this.finish(op, success()); return; }
        op.cacheSyncId = group.id;
      }
      if (this.host.io.cache.isSatisfied(op.actor)) this.finish(op, success()); return;
    }
    if (op.stage === 'queued' && this.data.journal.transactions.some(tx => !['complete', 'aborted'].includes(tx.stage))) return;
    if (op.stage === 'reading') {
      const transfers = op.transferIds.map(id => this.transfer(id)!);
      if (transfers.some(row => row.progress.kind !== 'settled')) return;
      if (transfers.some(row => row.progress.kind === 'settled' && row.progress.result.kind === 'failed')) { this.finish(op, failure('EINVAL', 'filesystem read failed')); return; }
      try { this.afterReads(op); } catch (error) { this.finish(op, this.error(error)); } return;
    }
    try {
      const call = op.call;
      if (call.name === 'sync') { op.stage = 'syncing'; return; }
      if (call.name === 'read' || call.name === 'write') {
        const descriptor = this.descriptor(op.actor.pid, call.fd); if (descriptor === undefined) { this.finish(op, failure('EINVAL', 'descriptor is not open')); return; }
        const inode = this.inodeTable.get(descriptor.inode);
        if (inode === undefined || inode.generation !== descriptor.inodeGeneration || inode.mapping.some(row => this.inodeTable.blockGeneration(row.block) !== row.generation)) {
          if (inode !== undefined) this.emit({ type: 'fs.corruption', inode: inode.id, recoverable: false });
          this.finish(op, failure('EINVAL', 'storage_corruption: stale inode or block generation')); return;
        }
        if (call.name === 'write' ? descriptor.mode === 'r' : descriptor.mode === 'w' || descriptor.mode === 'a') { this.finish(op, failure('EACCES', 'descriptor mode denies access')); return; }
        if (!this.host.check(op.callerDomain, inode, call.name)) { this.finish(op, failure('EACCES', 'file access denied')); return; }
        op.inode = inode.id; op.inodeGeneration = inode.generation; op.descriptor = descriptor.fd;
        op.startOffset = call.name === 'write' && descriptor.mode === 'a' ? inode.sizeBytes : descriptor.offset;
        const bytes = call.name === 'read' ? Math.min(call.bytes, Math.max(0, inode.sizeBytes - op.startOffset)) : call.bytes;
        if (op.startOffset + bytes > MAX_FILE_SIZE) { this.finish(op, failure('EINVAL', 'file exceeds maximum size')); return; }
        op.nextOffset = op.startOffset + bytes;
        const positions = blockPositions(op.startOffset, bytes, usableBlockBytes(inode));
        const plan = readPlan(inode, positions, 'sequential'); this.data.counters.logicalBlockReads += plan.reads; this.data.counters.logicalRunStarts += plan.logicalRunStarts;
        // Reads are charged even when multiple positions share cached metadata.
        for (const block of plan.blocks) op.transferIds.push(this.submit({ kind: 'operation', operationId: op.id }, { kind: 'read', sectorLba: fsSector(this.data, block), bytes: 4096 }));
        if (call.name === 'write' && (inode.method === 'contiguous' || inode.method === 'linked')) for (const block of inode.blocks) if (!plan.blocks.includes(block)) op.transferIds.push(this.submit({ kind: 'operation', operationId: op.id }, { kind: 'read', sectorLba: fsSector(this.data, block), bytes: 4096 }));
        op.stage = 'reading'; return;
      }
      if (call.name === 'open' || call.name === 'stat') {
        const resolved = call.name === 'stat' && call.target.kind === 'descriptor' ? this.descriptorPath(op.actor.pid, call.target.fd)
          : this.paths.resolve(call.name === 'open' ? call.path : call.target.kind === 'path' ? call.target.path : '', this.process(op.actor.pid).cwd, op.callerDomain);
        if (!resolved.ok) { this.finish(op, failure(resolved.errno, resolved.message)); return; }
        op.inode = resolved.inode.id; op.inodeGeneration = resolved.inode.generation;
        if (call.name === 'open') {
          const rights: AccessRight[] = call.mode === 'r' ? ['read'] : call.mode === 'rw' ? ['read', 'write'] : ['write'];
          if (resolved.inode.kind === 'directory' && call.mode !== 'r') { this.finish(op, failure('EINVAL', 'cannot write a directory')); return; }
          if (rights.some(right => !this.host.check(op.callerDomain, resolved.inode, right))) { this.finish(op, failure('EACCES', 'open denied')); return; }
        }
        this.data.counters.logicalBlockReads += resolved.reads;
        for (const entry of resolved.traversal.slice(0, resolved.reads)) { const inode = this.inodeTable.get(entry.inode)!;
          if (inode.blocks[0] !== undefined) op.transferIds.push(this.submit({ kind: 'operation', operationId: op.id }, { kind: 'read', sectorLba: fsSector(this.data, inode.blocks[0]), bytes: 4096 })); }
        op.stage = 'reading'; return;
      }
      this.mutateCall(op);
    } catch (error) { this.finish(op, this.error(error)); }
  }
  private descriptorPath(pid: Pid, fd: FileDescriptor): PathResult {
    const descriptor = this.descriptor(pid, fd), inode = descriptor === undefined ? undefined : this.inodeTable.get(descriptor.inode);
    return inode === undefined || inode.generation !== descriptor?.inodeGeneration ? { ok: false, errno: 'EINVAL', reads: 0, message: 'invalid descriptor' }
      : { ok: true, inode, reads: 0, traversal: [] };
  }
  private afterReads(op: Operation): void {
    const inode = this.inodeTable.get(op.inode!); if (inode?.generation !== op.inodeGeneration) { this.finish(op, failure('EINVAL', 'stale filesystem operation')); return; }
    if (op.call.name === 'open') {
      const limit = this.host.maxOpenFiles?.() ?? 32, open = this.host.process(op.actor.pid)?.openFiles.length ?? 0;
      if (open >= limit) { this.finish(op, tooManyOpenFiles(op.actor.pid)); return; }
      let fd = 0; while (this.data.descriptors.some(row => row.fd === fd)) fd++;
      op.descriptor = fd as FileDescriptor; this.applyOperationEffects(op); this.finish(op, success(fd)); return;
    }
    if (op.call.name === 'stat') { this.finish(op, success(JSON.stringify({ id: inode.id, name: inode.name, kind: inode.kind, sizeBytes: inode.sizeBytes,
      method: inode.method, blocks: inode.blocks, owner: inode.owner, permissions: inode.permissions, linkCount: inode.linkCount }))); return; }
    if (op.call.name === 'read') {
      const bytes = this.readOperationBytes(op, inode); op.contents = bytes; this.applyOperationEffects(op); this.finish(op, success(bytes.length)); return;
    }
    if (op.call.name === 'write') { if (op.nextOffset === op.startOffset) { this.applyOperationEffects(op); this.finish(op, success(0)); } else this.prepareWrite(op, inode); return; }
  }
  private readOperationBytes(op: Operation, inode: FsInodeSnapshot): number[] {
    const count = op.nextOffset! - op.startOffset!, blockBytes = usableBlockBytes(inode), data: number[] = [];
    for (let position = op.startOffset!; position < op.startOffset! + count; position++) {
      const mapping = inode.mapping.find(row => row.logicalBlock === Math.floor(position / blockBytes));
      const bytes = mapping === undefined ? undefined : this.readResult(op, mapping.block);
      data.push(bytes?.[position % blockBytes] ?? 0);
    }
    return data;
  }
  private readResult(op: Operation, block: BlockId): readonly number[] | undefined {
    const transfer = op.transferIds.map(id => this.transfer(id)!).find(row => row.command.kind === 'read' && row.command.sectorLba === fsSector(this.data, block));
    return transfer?.progress.kind === 'settled' && transfer.progress.result.kind === 'ok' ? transfer.progress.result.data : undefined;
  }
  private prepareWrite(op: Operation, inode: FsInodeSnapshot): void {
    const { table, dirs, free } = this.plan(), start = op.startOffset!, count = op.nextOffset! - start;
    const events: EmittableEvent[] = [], result = allocateBlocks(inode, blockPositions(start, count, usableBlockBytes(inode)), free,
      { nextGeneration: block => table.nextBlockGeneration(block), emit: event => events.push(event), fragmentationWarnExtents: this.data.settings.fragmentationWarnExtents });
    if (!result.ok) { this.finish(op, failure(result.errno, 'file allocation failed')); return; }
    const next = { ...result.inode, sizeBytes: Math.max(inode.sizeBytes, op.nextOffset!), modifiedTick: this.tick() }; table.set(next);
    const after = this.plannedMetadata(table, dirs, free), delta = metadataDifference(this.data.metadata, after), images = this.metadataImages(after, delta);
    const updated = new Map<BlockId, number[]>(), blockBytes = usableBlockBytes(next);
    for (const relocation of result.relocations) updated.set(relocation.to, [...this.readResult(op, relocation.from) ?? Array<number>(4096).fill(0)]);
    for (let i = 0; i < count; i++) {
      const position = start + i, logical = Math.floor(position / blockBytes), mapping = next.mapping.find(row => row.logicalBlock === logical)!;
      let contents = updated.get(mapping.block); if (contents === undefined) { const old = inode.mapping.find(row => row.logicalBlock === logical);
        contents = [...(old === undefined ? Array<number>(4096).fill(0) : this.readResult(op, old.block) ?? Array<number>(4096).fill(0))]; updated.set(mapping.block, contents); }
      contents[position % blockBytes] = op.contents[i] ?? 0;
    }
    if (next.allocation.kind === 'linked' && next.allocation.variant === 'in_block') for (const link of next.allocation.links) {
      const previous = inode.allocation.kind === 'linked' ? inode.allocation.links.find(row => row.block === link.block) : undefined;
      if (updated.has(link.block) || previous?.next !== link.next) {
        const source = this.readResult(op, link.block);
        if (!updated.has(link.block) && source === undefined && inode.blocks.includes(link.block)) throw new Error('EINVAL: missing acknowledged linked-pointer read');
        const bytes = updated.get(link.block) ?? [...(source ?? Array<number>(4096).fill(0))];
        const value = link.next ?? 0xffffffff; for (let b = 0; b < 4; b++) bytes[4064 + b] = value >>> (b * 8) & 255; updated.set(link.block, bytes);
      }
    }
    for (const [block, contents] of updated) images.push(this.image(block, 'data', contents, next));
    op.transactionId = this.journal.prepare({ images, changes: delta, operationId: op.id }); op.stage = 'transaction'; op.result = { ok: true, value: count };
    this.data.counters.logicalBlockReads += result.reads; this.data.counters.logicalBlockWrites += result.writes;
    this.data.counters.bitmapWordsScanned += free.wordsScanned; for (const event of events) this.emit(event);
  }
  private mutateCall(op: Operation): void {
    const call = op.call, cwd = this.process(op.actor.pid).cwd;
    if (call.name === 'mkdir') {
      const prepared = this.newNode(call.path, cwd, op.callerDomain, { kind: 'directory' });
      op.transactionId = this.journal.prepare({ images: this.metadataImages(prepared.after, prepared.delta), changes: prepared.delta, operationId: op.id });
    } else if (call.name === 'chmod' || call.name === 'unlink') {
      const resolved = this.paths.resolve(call.path, cwd, op.callerDomain); if (!resolved.ok) { this.finish(op, failure(resolved.errno, resolved.message)); return; }
      const { table, dirs, free } = this.plan();
      if (call.name === 'chmod') {
        if (!this.host.check(op.callerDomain, resolved.inode, 'owner')) { this.finish(op, failure('EACCES', 'chmod requires ownership')); return; }
        table.update(resolved.inode.id, { permissions: { read: call.permissions[0] === 'r', write: call.permissions[1] === 'w', execute: call.permissions[2] === 'x' }, modifiedTick: this.tick() });
      } else {
        const { parent, name } = this.parent(call.path, cwd, op.callerDomain); dirs.unlink(parent.id, name);
        const target = table.get(resolved.inode.id)!;
        if (target.linkCount === 0 && !this.data.descriptors.some(fd => fd.inode === target.id)) this.releaseInode(table, free, target);
      }
      const after = this.plannedMetadata(table, dirs, free), delta = metadataDifference(this.data.metadata, after);
      op.transactionId = this.journal.prepare({ images: this.metadataImages(after, delta), changes: delta, operationId: op.id });
    } else { this.finish(op, failure('EINVAL', 'unsupported file operation')); return; }
    op.stage = 'transaction'; op.result = { ok: true, value: null };
  }
  private applyOperationEffects(op: Operation): void {
    if (op.effectsApplied) return;
    if (op.call.name === 'open') {
      const inode = this.inodeTable.get(op.inode!)!, fd = op.descriptor!;
      this.data.descriptors.push({ fd, inode: inode.id, inodeGeneration: inode.generation, mode: op.call.mode,
        offset: op.call.mode === 'a' ? inode.sizeBytes : 0, references: 1 }); this.data.descriptors.sort((a, b) => a.fd - b.fd);
      this.data.nextDescriptorId = Math.max(this.data.nextDescriptorId, fd + 1); this.process(op.actor.pid).descriptors.push({ fd, closeOnExec: false });
      this.host.process(op.actor.pid)?.openFiles.push(fd);
    } else if (op.nextOffset !== null && op.descriptor !== null) {
      const descriptor = this.data.descriptors.find(row => row.fd === op.descriptor); if (descriptor !== undefined) descriptor.offset = op.nextOffset;
    }
    op.effectsApplied = true;
  }
  private plan() {
    const table = new InodeTable(); table.restore(this.data.metadata); const dirs = new DirectoryTable(table); dirs.restore(this.data.metadata.directories);
    const free = new FreeSpace(this.data.volume!.blockCount, this.data.settings.freeSpaceMethod); free.restore(this.data.metadata.freeSpace); return { table, dirs, free };
  }
  private parent(path: string, cwd: InodeId, domain: DomainId): { parent: FsInodeSnapshot; name: string } {
    const pieces = path.split('/').filter(Boolean), name = pieces.pop(); if (name === undefined || name === '.' || name === '..') throw new KernelConfigError('invalid file name');
    const result = this.paths.resolve((path.startsWith('/') ? '/' : '') + pieces.join('/') || '.', cwd, domain);
    if (!result.ok) throw new Error(`${result.errno}: ${result.message}`);
    if (result.inode.kind !== 'directory') throw new Error('EINVAL: parent is not a directory');
    if (!this.host.check(domain, result.inode, 'write')) throw new Error('EACCES: directory write denied');
    return { parent: result.inode, name };
  }
  private newNode(path: string, cwd: InodeId, domain: DomainId, options: { readonly kind?: FsInodeSnapshot['kind']; readonly method?: FileAllocationMethod; readonly symlinkTarget?: string; readonly programName?: string }) {
    const { parent, name } = this.parent(path, cwd, domain), { table, dirs, free } = this.plan();
    const blocks = free.allocate(options.kind === 'directory' ? 2 : 1); if (blocks === null) throw new Error('ENOSPC: inode allocation failed');
    const inode = table.create({ ...options, name, owner: domain, tick: this.tick(), metadataBlock: blocks[0]!,
      method: options.kind === 'directory' ? 'extent' : options.method ?? this.data.settings.defaultAllocation, linkedVariant: this.data.settings.linkedVariant });
    table.nextBlockGeneration(blocks[0]!);
    if (inode.kind === 'directory') { const block = blocks[1]!, generation = table.nextBlockGeneration(block);
      table.update(inode.id, { blocks: [block], mapping: [{ logicalBlock: 0, block, generation }], allocation: { kind: 'extent', extents: [{ logicalStart: 0, startBlock: block, length: 1 }] } }); dirs.create(inode.id, parent.id); }
    dirs.add(parent.id, name, table.get(inode.id)!, inode.kind === 'directory');
    const after = this.plannedMetadata(table, dirs, free); return { inode: table.get(inode.id)!, after, delta: metadataDifference(this.data.metadata, after) };
  }
  private releaseInode(table: InodeTable, free: FreeSpace, inode: FsInodeSnapshot): void {
    const blocks = new Set<BlockId>([inode.metadataBlock, ...inode.blocks]); if (inode.indexBlock !== null) blocks.add(inode.indexBlock);
    if (inode.allocation.kind === 'indexed') for (const node of inode.allocation.nodes) blocks.add(node.block);
    free.release([...blocks]); table.retire(inode.id);
  }
  private reap(inode: FsInodeSnapshot): void {
    const { table, dirs, free } = this.plan(); this.releaseInode(table, free, inode);
    const after = this.plannedMetadata(table, dirs, free), delta = metadataDifference(this.data.metadata, after);
    this.journal.prepare({ images: this.metadataImages(after, delta), changes: delta });
  }
  private image(block: BlockId, kind: JournalImage['kind'], contents: readonly number[], inode?: FsInodeSnapshot): JournalImage {
    return { homeBlock: block, generation: this.data.nextImageGeneration++, kind, contents, inode: inode?.id ?? null, inodeGeneration: inode?.generation ?? null };
  }
  private plannedMetadata(table: InodeTable, dirs: DirectoryTable, free: FreeSpace): FsMetadataSnapshot {
    for (const directory of dirs.snapshots()) {
      const inode = table.get(directory.inode); if (inode === undefined) continue;
      const pages = directoryChunks(directory).length;
      if (inode.blocks.length < pages) {
        const result = allocateBlocks(inode, Array.from({ length: pages }, (_, i) => i), free, { nextGeneration: block => table.nextBlockGeneration(block) });
        if (!result.ok) throw new Error('ENOSPC: directory pages'); table.set(result.inode);
      }
    }
    return table.metadata(free.snapshot(), dirs.snapshots());
  }
  private metadataImages(after: FsMetadataSnapshot, delta: FsMetadataDeltaSnapshot): JournalImage[] {
    const images = new Map<BlockId, JournalImage>();
    for (const change of delta.inodes) {
      const inode = change.after ?? change.before!;
      images.set(inode.metadataBlock, this.image(inode.metadataBlock, 'inode', encodeFsRecord({ kind: 'inode', inode: change.after === null ? null : packInode(change.after) }), inode));
      if (change.after?.allocation.kind === 'indexed') for (const node of change.after.allocation.nodes) images.set(node.block,
        this.image(node.block, 'allocation', encodeFsRecord({ kind: 'index', inode: inode.id, node }), inode));
    }
    for (const change of delta.directories) {
      const inode = after.inodes.find(row => row.id === change.inode) ?? delta.inodes.find(row => row.id === change.inode)?.before;
      if (inode !== undefined && inode !== null) {
        const chunks = change.after === null ? [] : directoryChunks(change.after);
        for (let part = 0; part < inode.blocks.length; part += 1) {
          const block = inode.blocks[part]!;
          images.set(block, this.image(block, 'directory', encodeFsRecord({ kind: 'directory', inode: inode.id, parent: change.after?.parent ?? inode.id,
            part, parts: chunks.length, entries: chunks[part] ?? [] }), inode));
        }
      }
    }
    if (delta.freeSpace !== null || delta.inodeAllocator !== null || delta.blockGenerations.length !== 0) {
      const free = new FreeSpace(this.data.volume!.blockCount, this.data.settings.freeSpaceMethod); free.restore(after.freeSpace);
      const contents = encodeFsRecord({ kind: 'allocation', words: runs([...free.bitmap].map((word, index) => [index, word])), next: after.nextInodeId, free: runs(after.freeInodeIds.map(id => [id, 0])),
        ig: runs(after.inodeGenerations.map(row => [row.inode, row.generation])), im: mappingRuns(after.inodes.map(row => ({ logicalBlock: row.id, block: row.metadataBlock, generation: row.generation }))), bg: runs(after.blockGenerations.map(row => [row.block, row.generation])) });
      images.set(this.data.volume!.bitmapBlocks[0]!, this.image(this.data.volume!.bitmapBlocks[0]!, 'allocation', contents));
    }
    return [...images.values()].sort((a, b) => a.homeBlock - b.homeBlock);
  }
  private refresh(): void {
    // Metadata records and journal entries are replaced, never edited in place (applyMetadataDelta
    // splices and pushes clones, reloadMetadata and restore assign new arrays), so element identity
    // is a complete change detector and the per-tick JSON comparison of every inode is unnecessary.
    const { inodes, directories } = this.data.metadata, entries = this.data.journal.entries;
    if (!sameElements(this.mirrored.inodes, inodes)) {
      const old = new Map(this.inodeTable.snapshots().map(inode => [inode.id, inode.generation]));
      this.inodeTable.restore(this.data.metadata); this.mirrored.inodes = [...inodes];
      for (const inode of inodes) if (old.get(inode.id) !== inode.generation) this.host.inodeCreated?.(inode);
    }
    if (!sameElements(this.mirrored.directories, directories)) { this.directories.restore(directories); this.mirrored.directories = [...directories]; }
    if (!sameElements(this.mirrored.entries, entries)) {
      this.journalEntries.splice(0, this.journalEntries.length, ...entries.map(entry => ({ ...entry, blocks: [...entry.blocks] }))); this.mirrored.entries = [...entries];
    }
  }
  /** Off-mode logical acceptance is distinct from a durable home acknowledgement. */
  admitVolatile(transaction: FsTransactionSnapshot): boolean | null {
    if (transaction.mode !== 'off' || this.data.mountState !== 'mounted' || this.host.io.cache.policy !== 'write_back') return null;
    const tx = this.data.journal.transactions.find(row => row.id === transaction.id)!;
    this.observeCacheTransfers();
    for (let index = 0; index < tx.images.length; index += 1) {
      const image = tx.images[index]!, prior = image.homeTransferId === null ? undefined : this.transfer(image.homeTransferId);
      if (prior?.progress.kind === 'settled') {
        if (prior.progress.result.kind === 'failed') { tx.stage = 'aborted'; tx.failure = { errno: 'EINVAL', message: 'cache eviction failed' }; return false; }
        continue;
      }
      const sector = fsSector(this.data, image.homeBlock), cached = this.host.io.cache.peek(this.data.volume!.device, sector);
      if (cached !== null && same(cached, image.contents)) continue;
      if (!this.host.io.cache.write(this.data.volume!.device, sector, image.contents)) {
        this.captureCacheEvictions(tx); return false;
      }
    }
    this.captureCacheEvictions(tx); return true;
  }
  private captureCacheEvictions(tx: Mutable<FsTransactionSnapshot>): void {
    const cache = this.host.io.cache.snapshot();
    for (let index = 0; index < tx.images.length; index += 1) {
      const image = tx.images[index]!; if (image.homeTransferId !== null) continue;
      const flush = cache.flushes.find(row => row.device === this.data.volume!.device && row.block === fsSector(this.data, image.homeBlock) && same(row.contents, image.contents));
      if (flush === undefined) continue;
      const id = this.submit({ kind: 'journal', txId: tx.id, phase: 'home' }, { kind: 'write', sectorLba: flush.block, source: { kind: 'transaction_image', txId: tx.id, imageIndex: index } });
      this.data.transfers.find(row => row.id === id)!.progress = { kind: 'cache', flushId: flush.id, generation: flush.generation }; image.homeTransferId = id;
    }
  }
  private observeCacheTransfers(): void {
    if (this.data.volume === null || !this.data.transfers.some(transfer => transfer.progress.kind === 'cache')) return;
    const cache = this.host.io.cache.snapshot();
    for (const transfer of this.data.transfers) {
      if (transfer.progress.kind !== 'cache') continue;
      const progress = transfer.progress, flush = cache.flushes.find(row => row.id === progress.flushId && row.generation === progress.generation);
      const entry = cache.entries.find(row => row.device === this.data.volume!.device && row.block === transfer.command.sectorLba);
      const result = flush?.progress.kind === 'completed' ? flush.progress.result
        : entry !== undefined && entry.durableGeneration >= progress.generation ? { kind: 'ok' as const, data: [] }
          : flush === undefined && entry === undefined ? { kind: 'failed' as const, reason: 'cancelled' as const } : null;
      if (result === null) continue;
      transfer.progress = { kind: 'settled', atTick: this.tick(), result: clone(result) };
      if (result.kind === 'ok') this.data.counters.physicalSectorWrites += this.transferBytes(transfer).length / 512;
    }
  }
  isDurable(id: number): boolean { const progress = this.transfer(id)?.progress; return progress?.kind === 'settled' && progress.result.kind === 'ok'; }
  private pumpTransfers(): void {
    if (this.data.volume === null) return;
    this.observeCacheTransfers();
    for (const transfer of this.data.transfers) {
      if (transfer.progress.kind === 'storage') {
        const completion = this.host.storage.takeCompletion(transfer.progress.requestId); if (completion === null) continue;
        transfer.progress = { kind: 'settled', atTick: completion.completedAtTick, result: clone(completion.result) };
        if (completion.result.kind === 'ok') {
          const sectors = (transfer.command.kind === 'read' ? transfer.command.bytes : this.transferBytes(transfer).length) / 512;
          if (transfer.command.kind === 'read') this.data.counters.physicalSectorReads += sectors;
          else this.data.counters.physicalSectorWrites += sectors;
        }
      }
      if (transfer.progress.kind !== 'planned' || this.data.mountState === 'crashed' && this.data.recovery === null) continue;
      try {
        if (transfer.command.kind === 'read' && transfer.purpose.kind === 'operation') {
          const cached = this.host.io.cache.read(this.data.volume.device, transfer.command.sectorLba);
          if (cached !== null && cached.length >= transfer.command.bytes) {
            transfer.progress = { kind: 'settled', atTick: this.tick(), result: { kind: 'ok', data: cached.slice(0, transfer.command.bytes) } }; continue;
          }
        }
        const requestId = this.host.storage.submitDevice(this.data.volume.device, transfer.command.kind === 'read'
          ? { kind: 'read', lba: transfer.command.sectorLba, bytes: transfer.command.bytes }
          : { kind: 'write', lba: transfer.command.sectorLba, data: this.transferBytes(transfer) }, { kind: 'direct' }, null);
        transfer.progress = { kind: 'storage', requestId };
      } catch { transfer.progress = { kind: 'settled', atTick: this.tick(), result: { kind: 'failed', reason: 'device_failed' } }; }
    }
  }
  private transferBytes(transfer: FsTransferSnapshot): readonly number[] {
    if (transfer.command.kind !== 'write') return [];
    const source = transfer.command.source; if (source.kind === 'inline') return source.contents;
    const tx = this.data.journal.transactions.find(row => row.id === source.txId); if (tx === undefined) throw new Error('missing transaction byte source');
    return source.kind === 'transaction_image' ? tx.images[source.imageIndex]!.contents : tx.controls[source.controlIndex]!.contents;
  }
  private readMediaBlock(block: BlockId): number[] {
    const volume = this.data.volume!, target = this.host.storage.deviceTarget(volume.device);
    if (target?.kind !== 'disk') throw new Error('EINVAL: direct metadata mount requires a disk');
    return Array.from({ length: 8 }, (_, i) => [...this.host.storage.readSector(target.driveId, fsSector(this.data, block, i))]).flat();
  }
  private reloadMetadata(): void {
    const volume = this.data.volume; if (volume === null) return;
    const metadata = clone(emptyFsPayload(this.tick(), this.data.settings).metadata), records: { block: BlockId; value: Record<string, unknown> }[] = [];
    // Inspect surviving home metadata only; this scan never claims a charged syscall read.
    for (let b = 0; b < volume.journalControlBlock; b++) {
      try { const value = decodeFsRecord(this.readMediaBlock(fsBlock(b))) as Record<string, unknown>; records.push({ block: fsBlock(b), value }); } catch { /* Unallocated and data blocks have no metadata header. */ }
    }
    const allocationImage = records.find(row => volume.bitmapBlocks.includes(row.block) && row.value.kind === 'allocation');
    const inodeLocations = allocationImage === undefined ? [] : (allocationImage.value.im as number[][]).flatMap(([id, block, generation, count]) => Array.from({ length: count! }, (_, i) => ({ id: id! + i, block: block! + i, generation: generation! })));
    for (const { block, value } of records) {
      if (value.kind === 'allocation' && volume.bitmapBlocks.includes(block)) {
        const free = new FreeSpace(volume.blockCount, 'bitmap'); free.restore({ kind: 'bitmap', words: expandRuns(value.words as number[][]).map(row => row[1]!) });
        const target = new FreeSpace(volume.blockCount, this.data.settings.freeSpaceMethod); target.reserve(Array.from({ length: volume.blockCount }, (_, i) => fsBlock(i)).filter(block => !free.isFree(block)));
        metadata.freeSpace = clone(target.snapshot()); metadata.nextInodeId = value.next as number; metadata.freeInodeIds = expandRuns(value.free as number[][]).map(row => row[0] as InodeId);
        metadata.inodeGenerations = expandRuns(value.ig as number[][]).map(([inode, generation]) => ({ inode: inode as InodeId, generation: generation! }));
        metadata.blockGenerations = expandRuns(value.bg as number[][]).map(([block, generation]) => ({ block: block as BlockId, generation: generation! }));
      } else if (value.kind === 'inode' && value.inode !== null && inodeLocations.some(location => location.block === block)) {
        const inode = unpackInode(value.inode as ReturnType<typeof packInode>);
        if (inodeLocations.some(location => location.block === block && location.id === inode.id && location.generation === inode.generation)) metadata.inodes.push(clone(inode));
      }

    }
    for (const inode of metadata.inodes) {
      if (inode.allocation.kind === 'indexed') {
        const pending = inode.allocation.roots.map(root => ({ block: root.block, level: root.level })), seen = new Set<BlockId>();
        inode.allocation.nodes = [];
        while (pending.length > 0) {
          const expected = pending.shift()!; if (seen.has(expected.block)) continue; seen.add(expected.block);
          const image = records.find(row => row.block === expected.block && row.value.kind === 'index' && row.value.inode === inode.id);
          if (image === undefined) continue;
          const node = clone(image.value.node) as Mutable<Extract<FsInodeSnapshot['allocation'], { kind: 'indexed' }>['nodes'][number]>;
          if (node.block !== expected.block || node.level !== expected.level || node.pointers.length !== 128) continue;
          inode.allocation.nodes.push(node);
          if (node.level > 1) for (const block of node.pointers) if (block !== null) pending.push({ block, level: node.level === 3 ? 2 : 1 });
        }
        inode.allocation.nodes.sort((a, b) => a.block - b.block);
      }
      if (inode.kind === 'directory') {
        const pages = records.filter(row => row.value.kind === 'directory' && row.value.inode === inode.id && inode.blocks.includes(row.block)
          && Number(row.value.part) < Number(row.value.parts)).sort((a, b) => Number(a.value.part) - Number(b.value.part));
        if (pages.length > 0) metadata.directories.push({ inode: inode.id, parent: pages[0]!.value.parent as InodeId,
          entries: pages.flatMap(row => (row.value.entries as [string, InodeId, number][]).map(([name, id, generation]) => ({ name, inode: id, generation }))) });
      }
    }
    metadata.inodes.sort((a, b) => a.id - b.id); metadata.directories.sort((a, b) => a.inode - b.inode);
    this.data.metadata = metadata;
  }
  private error(error: unknown): SyscallResult {
    const message = error instanceof Error ? error.message : 'filesystem operation failed';
    const code = message.split(':')[0]; return failure(code === 'ENOSPC' || code === 'EACCES' || code === 'ENOENT' || code === 'EINVAL' ? code : 'EINVAL', message);
  }
}

function blockPositions(start: number, bytes: number, blockBytes: number): number[] { return bytes === 0 ? [] : Array.from({ length: Math.floor((start + bytes - 1) / blockBytes) - Math.floor(start / blockBytes) + 1 }, (_, i) => Math.floor(start / blockBytes) + i); }
export function metadataDifference(before: FsMetadataSnapshot, after: FsMetadataSnapshot): FsMetadataDeltaSnapshot {
  const delta = emptyMetadataDelta();
  for (const id of [...new Set([...before.inodes, ...after.inodes].map(row => row.id))].sort((a, b) => a - b)) {
    const old = before.inodes.find(row => row.id === id) ?? null, next = after.inodes.find(row => row.id === id) ?? null;
    if (!same(old, next)) delta.inodes.push({ id, before: clone(old), after: clone(next) });
  }
  for (const inode of [...new Set([...before.directories, ...after.directories].map(row => row.inode))].sort((a, b) => a - b)) {
    const old = before.directories.find(row => row.inode === inode) ?? null, next = after.directories.find(row => row.inode === inode) ?? null;
    if (!same(old, next)) delta.directories.push({ inode, before: clone(old), after: clone(next) });
  }
  if (!same(before.freeSpace, after.freeSpace)) delta.freeSpace = { before: clone(before.freeSpace), after: clone(after.freeSpace) };
  if (before.nextInodeId !== after.nextInodeId || !same(before.freeInodeIds, after.freeInodeIds)) delta.inodeAllocator = { nextBefore: before.nextInodeId, nextAfter: after.nextInodeId, freeBefore: [...before.freeInodeIds], freeAfter: [...after.freeInodeIds] };
  for (const row of after.inodeGenerations) { const previous = before.inodeGenerations.find(old => old.inode === row.inode)?.generation ?? null; if (previous !== row.generation) delta.inodeGenerations.push({ inode: row.inode, before: previous, after: row.generation }); }
  for (const row of after.blockGenerations) { const previous = before.blockGenerations.find(old => old.block === row.block)?.generation ?? null; if (previous !== row.generation) delta.blockGenerations.push({ block: row.block, before: previous, after: row.generation }); }
  return delta;
}
function runs(rows: readonly (readonly number[])[]): number[][] {
  const result: number[][] = []; for (const [id, value] of rows) { const last = result.at(-1);
    if (last !== undefined && last[0]! + last[2]! === id && last[1] === value) last[2]!++; else result.push([id!, value!, 1]); } return result;
}
function expandRuns(rows: readonly (readonly number[])[]): number[][] { return rows.flatMap(([start, value, count]) => Array.from({ length: count! }, (_, i) => [start! + i, value!])); }
function mappingRuns(rows: readonly { readonly logicalBlock: number; readonly block: BlockId; readonly generation: number }[]): number[][] {
  const mapping: number[][] = []; for (const row of rows) { const last = mapping.at(-1);
    if (last !== undefined && last[0]! + last[3]! === row.logicalBlock && last[1]! + last[3]! === row.block && last[2] === row.generation) last[3]!++;
    else mapping.push([row.logicalBlock, row.block, row.generation, 1]); } return mapping;
}
function packInode(inode: FsInodeSnapshot) {
  const mapping = mappingRuns(inode.mapping);
  return { ...inode, blocks: [], mapping, allocation: inode.allocation.kind === 'linked' ? { ...inode.allocation, links: [] } : inode.allocation.kind === 'indexed' ? { ...inode.allocation, nodes: [] } : inode.allocation };
}
function unpackInode(packed: ReturnType<typeof packInode>): FsInodeSnapshot {
  const mapping = packed.mapping.flatMap(([logical, block, generation, count]) => Array.from({ length: count! }, (_, i) => ({ logicalBlock: logical! + i, block: fsBlock(block! + i), generation: generation! })));
  const blocks = mapping.map(row => row.block), allocation = packed.allocation.kind === 'linked'
    ? { ...packed.allocation, links: blocks.map((block, i) => ({ block, next: blocks[i + 1] ?? null })) } : packed.allocation;
  return { ...packed, blocks, mapping, allocation };
}
function decodeFileCall(request: SyscallRequest): { ok: true; call: FsCallSnapshot } | { ok: false; result: SyscallResult } {
  const [a, b, c] = request.args, name = request.name;
  const invalid = { ok: false as const, result: failure('EINVAL', 'invalid file syscall arguments') };
  if (name === 'sync') return request.args.length === 0 ? { ok: true, call: { name } } : invalid;
  if (name === 'open' && typeof a === 'string' && (b === 'r' || b === 'w' || b === 'rw' || b === 'a') && request.args.length === 2) return { ok: true, call: { name, path: a, mode: b } };
  if ((name === 'mkdir' || name === 'unlink') && typeof a === 'string' && request.args.length === 1) return { ok: true, call: { name, path: a } };
  if (name === 'chmod' && typeof a === 'string' && typeof b === 'string' && /^[r-][w-][x-]$/.test(b) && request.args.length === 2) return { ok: true, call: { name, path: a, permissions: b } };
  if (name === 'stat' && request.args.length === 1 && (typeof a === 'string' || typeof a === 'number' && Number.isSafeInteger(a) && a >= 0)) return { ok: true, call: { name, target: typeof a === 'string' ? { kind: 'path', path: a } : { kind: 'descriptor', fd: a as FileDescriptor } } };
  if (typeof a !== 'number' || !Number.isSafeInteger(a) || a < 0) return invalid;
  if (name === 'close' && request.args.length === 1) return { ok: true, call: { name, fd: a as FileDescriptor } };
  if ((name === 'read' || name === 'write') && typeof b === 'number' && Number.isSafeInteger(b) && b >= 0 && request.args.length === 2) return { ok: true, call: { name, fd: a as FileDescriptor, bytes: b } };
  if (name === 'seek' && typeof b === 'number' && Number.isSafeInteger(b) && (c === 0 || c === 1 || c === 2) && request.args.length === 3) return { ok: true, call: { name, fd: a as FileDescriptor, offset: b, whence: c } };
  return invalid;
}

function directoryChunks(directory: FsDirectorySnapshot): [string, InodeId, number][][] {
  const chunks: [string, InodeId, number][][] = [[]];
  for (const entry of directory.entries) {
    const tuple: [string, InodeId, number] = [entry.name, entry.inode, entry.generation];
    const chunk = chunks.at(-1)!; chunk.push(tuple);
    try { encodeFsRecord({ kind: 'directory', inode: directory.inode, parent: directory.parent, part: chunks.length - 1, parts: 99999, entries: chunk }); }
    catch {
      chunk.pop(); const next = [tuple];
      encodeFsRecord({ kind: 'directory', inode: directory.inode, parent: directory.parent, part: chunks.length, parts: 99999, entries: next }); chunks.push(next);
    }
  }
  return chunks;
}

function operationRequest(operation: FsOperationSnapshot): SyscallRequest {
  const call = operation.call; const pid = operation.actor.pid;
  switch (call.name) {
    case 'open': return { pid, name: call.name, args: [call.path, call.mode] };
    case 'close': return { pid, name: call.name, args: [call.fd] };
    case 'read': case 'write': return { pid, name: call.name, args: [call.fd, call.bytes] };
    case 'seek': return { pid, name: call.name, args: [call.fd, call.offset, call.whence] };
    case 'stat': return { pid, name: call.name, args: [call.target.kind === 'path' ? call.target.path : call.target.fd] };
    case 'unlink': case 'mkdir': return { pid, name: call.name, args: [call.path] };
    case 'chmod': return { pid, name: call.name, args: [call.path, call.permissions] };
    case 'sync': return { pid, name: call.name, args: [] };
  }
}

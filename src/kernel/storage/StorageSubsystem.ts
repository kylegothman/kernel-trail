import type { EmittableEvent } from '../EventBus';
import type { AddressSpaceId, BlockId, DeviceId, DiskHead, DiskRequest, DiskSchedulingId, FrameId,
  KernelSnapshot, PageId, Pid, Rng, StorageConsumerSnapshot, StorageDiskOperationSnapshot,
  StoragePagingAdapterSnapshot, StoragePagingTransferSnapshot, StorageRequestSnapshot, StorageResultSnapshot,
  StorageSnapshotState, StorageTransferSnapshot, SyscallResult, Tick } from '../types';
import { DiskQueue, requireDiskPolicy, textOrder, validateResult, validateTransfer } from './DiskQueue';
import { blockToCylinder, capacity, diskGeometry } from './geometry';
import { MS_PER_TICK, positiveFactor } from './costModel';
import { NvmDevice } from './nvm';
import { RaidArray } from './raid';

type Payload = StorageSnapshotState['payload'];
export type StorageTarget = StoragePagingAdapterSnapshot['target'];
export interface StorageHost {
  tick(): Tick;
  enabled(): boolean;
  emit(event: EmittableEvent): void;
  readonly rng: Rng;
  isPagingBackingLive?(space: AddressSpaceId, page: PageId): boolean;
}
export type StorageOptions = {
  readonly totalCylinders?: number;
  readonly policy?: DiskSchedulingId;
  readonly settings?: Partial<Payload['settings']>;
  readonly nvmWriteBufferPages?: number;
};
export type PagingStorageInput = {
  readonly requestId: number; readonly kind: 'read' | 'write'; readonly pid: Pid;
  readonly space: AddressSpaceId; readonly page: PageId; readonly frame: FrameId; readonly completeAt: Tick;
};
export type PagingStorageOptions = {
  readonly target?: StorageTarget; readonly firstSector?: BlockId; readonly sectorCount?: number; readonly pageBytes?: number;
};
const ok = (value: number | null = null): SyscallResult => ({ ok: true, value });
const invalid = (message: string): SyscallResult => ({ ok: false, errno: 'EINVAL', message });
const safe = (value: number, minimum = 0): boolean => Number.isSafeInteger(value) && value >= minimum;
/** Reject hidden/non-JSON continuation before preparing any commit closure. */
function plain(value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) plain(item); return; }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const item of Object.values(value)) plain(item); return;
  }
  throw new RangeError('storage state must contain plain finite JSON values');
}
export class StorageSubsystem {
  readonly diskQueue: DiskRequest[] = [];
  readonly drives = new Map<string, DiskQueue>();
  readonly nvm = new Map<DeviceId, NvmDevice>();
  readonly raid = new Map<string, RaidArray>();
  private requests = new Map<number, StorageRequestSnapshot>();
  private readyRequestIds: number[] = [];
  private readyPhysicalOperationIds: number[] = [];
  private nextRequestId = 0;
  private nextPhysicalOperationId = 0;
  private policy: DiskSchedulingId;
  private factor = 1;
  private settings: Payload['settings'];
  private paging: StoragePagingAdapterSnapshot | null = null;
  /** Rebound on restore so newly prepared media retains live callbacks. */
  private readonly bridge: { owner: StorageSubsystem } = { owner: this };
  constructor(private readonly host: StorageHost, private readonly options: StorageOptions = {}) {
    this.policy = options.policy ?? 'fcfs'; requireDiskPolicy(this.policy);
    this.settings = { msPerTick: MS_PER_TICK, diskStarvationThreshold: 400,
      rebuildBlocksPerTick: 4, rebuildProgressInterval: 10, ...options.settings };
    this.validateSettings(this.settings);
    this.ensureDrive('disk0', options.totalCylinders ?? 200);
    const device = new NvmDevice(this.mediaHost(), { deviceId: 'nvm0' as DeviceId,
      writeBufferPages: options.nvmWriteBufferPages ?? 8, msPerTick: this.settings.msPerTick });
    this.nvm.set('nvm0' as DeviceId, device);
  }
  private validateSettings(settings: Payload['settings']): void {
    positiveFactor(settings.msPerTick);
    for (const key of ['diskStarvationThreshold', 'rebuildBlocksPerTick', 'rebuildProgressInterval'] as const) {
      if (!safe(settings[key], 1)) throw new RangeError(`invalid storage ${key}`);
    }
  }
  private mediaHost() {
    const current = () => this.bridge.owner;
    return {
      tick: () => current().host.tick(), request: (id: number) => current().request(id),
      completeRequest: (id: number, result: StorageResultSnapshot, tick: Tick) => current().completeRequest(id, result, tick),
      costMultiplier: () => current().factor,
      issuePhysical: (drive: string, transfer: StorageTransferSnapshot, owner: StorageDiskOperationSnapshot['owner'], pid: Pid | null) => current().issuePhysical(drive, transfer, owner, pid),
      takePhysicalCompletion: (id: number) => current().takePhysicalCompletion(id),
      readSector: (drive: string, lba: BlockId) => current().readSector(drive, lba),
      ensureDrive: (drive: string, cylinders?: number) => current().ensureDrive(drive, cylinders),
      failDrive: (drive: string) => current().failDrive(drive),
      emit: (event: EmittableEvent) => current().host.emit(event),
    };
  }
  get diskHead(): DiskHead { return this.drives.get('disk0')!.head; }
  get activePolicy(): DiskSchedulingId { return this.policy; }
  get costMultiplier(): number { return this.factor; }
  get pagingAttached(): boolean { return this.paging !== null; }
  setPolicy(id: DiskSchedulingId): void { requireDiskPolicy(id); this.policy = id; }
  setCostMultiplier(factor: number): void { positiveFactor(factor); this.factor = factor; }
  ensureDrive(id: string, cylinders = this.options.totalCylinders ?? 200): void {
    if (typeof id !== 'string' || id.length === 0) throw new RangeError('empty disk identity');
    if (!this.drives.has(id)) this.drives.set(id, new DiskQueue(id, diskGeometry({ cylinders }),
      event => { if (this.host.enabled()) this.host.emit(event); }, this.settings.msPerTick));
  }
  registerRaid(options: ConstructorParameters<typeof RaidArray>[1]): RaidArray {
    const id = options.arrayId ?? 'raid0';
    if (this.raid.has(id)) throw new RangeError('duplicate RAID array');
    const requested = [...options.members, ...options.spares ?? []];
    const assigned = new Set([...this.raid.values()].flatMap(array => { const saved = array.saveState();
      return [...saved.members.map(member => member.driveId), ...saved.spareDriveIds, ...saved.rebuilds.map(job => job.spareDriveId)]; }));
    for (const driveId of requested) {
      const geometry = this.drives.get(driveId)?.geometry ?? diskGeometry({ cylinders: this.options.totalCylinders ?? 200 });
      if (typeof driveId !== 'string' || driveId.length === 0 || assigned.has(driveId)
        || options.blocksPerMember > capacity(geometry) / 512) throw new RangeError('invalid or already assigned RAID drive');
    }
    const array = new RaidArray(this.mediaHost(), { ...options, rebuildBlocksPerTick: this.settings.rebuildBlocksPerTick,
      rebuildProgressInterval: this.settings.rebuildProgressInterval });
    for (const driveId of requested) this.ensureDrive(driveId);
    this.raid.set(id, array); return array;
  }
  deviceTarget(device: DeviceId): StorageTarget | null {
    if (!this.host.enabled()) return null;
    if (this.raid.has(device)) return { kind: 'raid', arrayId: device };
    if (this.nvm.has(device)) return { kind: 'nvm', deviceId: device };
    if (this.drives.has(device)) return { kind: 'disk', driveId: device };
    return null;
  }
  submitDevice(device: DeviceId, transfer: StorageTransferSnapshot, consumer: StorageConsumerSnapshot, pid: Pid | null): number {
    const target = this.deviceTarget(device); if (target === null) throw new RangeError('storage device unavailable');
    return this.submit(target, transfer, consumer, pid);
  }
  submit(target: StorageTarget, transfer: StorageTransferSnapshot, consumer: StorageConsumerSnapshot = { kind: 'direct' }, pid: Pid | null = null): number {
    if (!this.host.enabled()) throw new RangeError('storage subsystem disabled');
    validateTransfer(transfer); this.validateConsumer(consumer);
    if (pid !== null && !safe(pid)) throw new RangeError('invalid storage pid');
    if ((target.kind === 'disk' && !this.drives.has(target.driveId)) || (target.kind === 'nvm' && !this.nvm.has(target.deviceId))
      || (target.kind === 'raid' && !this.raid.has(target.arrayId))) throw new RangeError('unknown storage target');
    if (target.kind === 'disk') validateTransfer(transfer, capacity(this.drives.get(target.driveId)!.geometry));
    const id = this.nextRequestId++;
    const request: StorageRequestSnapshot = { id, consumer: structuredClone(consumer), pid, transfer: structuredClone(transfer),
      queuedAtTick: this.host.tick(), target: null, cancelledAtTick: null, completion: null };
    this.requests.set(id, request);
    try {
      let committed: StorageRequestSnapshot['target'];
      if (target.kind === 'disk') committed = { ...target, physicalOperationId: this.issuePhysical(target.driveId, transfer, { kind: 'request', requestId: id }, pid) };
      else if (target.kind === 'nvm') { committed = target; this.requests.set(id, { ...request, target }); this.nvm.get(target.deviceId)!.submit(id); }
      else { const transactionId = this.raid.get(target.arrayId)!.submit(id); committed = { ...target, transactionId }; }
      const current = this.requests.get(id)!;
      this.requests.set(id, { ...current, target: current.completion === null ? committed : null });
    } catch (error) { this.requests.delete(id); throw error; }
    this.refreshViews(); return id;
  }
  request(id: number): StorageRequestSnapshot | undefined { return this.requests.get(id); }
  peekCompletion(id: number): StorageRequestSnapshot['completion'] { return this.requests.get(id)?.completion ?? null; }
  takeCompletion(id: number): StorageRequestSnapshot['completion'] {
    const completion = this.peekCompletion(id); if (completion === null) return null;
    this.requests.delete(id); this.readyRequestIds = this.readyRequestIds.filter(value => value !== id);
    return structuredClone(completion);
  }
  completeRequest(id: number, result: StorageResultSnapshot, tick: Tick): void {
    validateResult(result);
    const request = this.requests.get(id); if (request === undefined || request.completion !== null) return;
    if (request.cancelledAtTick !== null) { this.requests.delete(id); this.readyRequestIds = this.readyRequestIds.filter(value => value !== id); return; }
    this.requests.set(id, { ...request, target: null, completion: { completedAtTick: tick, result: structuredClone(result) } });
    this.readyRequestIds.push(id);
  }
  issuePhysical(driveId: string, transfer: StorageTransferSnapshot, owner: StorageDiskOperationSnapshot['owner'], pid: Pid | null): number {
    const drive = this.drives.get(driveId); if (drive === undefined) throw new RangeError('unknown physical drive');
    validateTransfer(transfer, capacity(drive.geometry));
    const id = this.nextPhysicalOperationId++;
    drive.enqueue({ id, driveId, owner: structuredClone(owner), pid, cylinder: blockToCylinder(transfer.lba, drive.geometry),
      transfer: structuredClone(transfer), queuedAtTick: this.host.tick(), servedAtTick: null, starvationNotified: false, result: null });
    this.refreshViews(); return id;
  }
  takePhysicalCompletion(id: number): StorageResultSnapshot | null {
    for (const drive of this.drives.values()) {
      const op = drive.operations.get(id); if (op?.result == null) continue;
      drive.operations.delete(id); this.readyPhysicalOperationIds = this.readyPhysicalOperationIds.filter(value => value !== id);
      return structuredClone(op.result);
    }
    return null;
  }
  readSector(driveId: string, lba: BlockId): readonly number[] {
    const drive = this.drives.get(driveId); if (drive === undefined) throw new RangeError('unknown physical drive'); return drive.readSector(lba);
  }
  failDrive(driveId: string): void {
    const drive = this.drives.get(driveId); if (drive === undefined) throw new RangeError('unknown physical drive');
    this.readyPhysicalOperationIds.push(...drive.fail(this.host.tick())); this.refreshViews();
  }
  cancel(id: number): void {
    const request = this.requests.get(id); if (request === undefined) return;
    if (request.completion !== null) { this.takeCompletion(id); return; }
    this.requests.set(id, { ...request, cancelledAtTick: this.host.tick() });
    const target = request.target;
    if (target?.kind === 'disk') {
      if (this.drives.get(target.driveId)!.cancel(target.physicalOperationId)) this.requests.delete(id);
    } else if (target?.kind === 'nvm') this.nvm.get(target.deviceId)!.cancel(id);
    else if (target?.kind === 'raid') this.raid.get(target.arrayId)!.cancel(id);
    this.refreshViews();
  }
  removeWaiter(pid: Pid): void {
    // DemandPager owns shared-waiter transfer/cancellation after memory teardown.
    for (const request of [...this.requests.values()]) if (request.pid === pid && request.consumer.kind !== 'paging') this.cancel(request.id);
  }
  expireTimers(tick: Tick): void {
    if (!this.host.enabled()) return;
    for (const drive of this.orderedDrives()) drive.expireTimers(tick, this.policy, this.settings.diskStarvationThreshold);
    for (const [, device] of [...this.nvm].sort((a, b) => textOrder(a[0], b[0]))) device.expireTimers(tick);
    for (const [, array] of [...this.raid].sort((a, b) => textOrder(a[0], b[0]))) array.expireTimers(tick);
  }
  serviceCompletions(tick: Tick): void {
    if (!this.host.enabled()) return;
    for (const drive of this.orderedDrives()) this.readyPhysicalOperationIds.push(...drive.advance(tick, this.policy, this.factor));
    for (const id of [...this.readyPhysicalOperationIds]) {
      const op = this.physical(id); if (op?.owner.kind !== 'request' || op.result === null) continue;
      const result = this.takePhysicalCompletion(id)!; this.completeRequest(op.owner.requestId, result, op.servedAtTick!);
    }
    for (const [, device] of [...this.nvm].sort((a, b) => textOrder(a[0], b[0]))) device.serviceCompletions(tick);
    for (const [, array] of [...this.raid].sort((a, b) => textOrder(a[0], b[0]))) array.serviceCompletions(tick);
    this.pumpPaging(); this.refreshViews();
  }
  private orderedDrives(): DiskQueue[] { return [...this.drives].sort((a, b) => textOrder(a[0], b[0])).map(([, drive]) => drive); }
  private physical(id: number): StorageDiskOperationSnapshot | undefined {
    for (const drive of this.drives.values()) { const op = drive.operations.get(id); if (op !== undefined) return op; } return undefined;
  }
  private refreshViews(): void {
    const disk = this.drives.get('disk0');
    this.diskQueue.splice(0, this.diskQueue.length, ...(disk?.queued.flatMap(op => { const request = disk.projectRequest(op); return request === null ? [] : [request]; }) ?? []));
  }
  projectedPath(): readonly number[] { return this.drives.get('disk0')!.projectedPath(this.policy); }
  waitUniformity(): number { return this.drives.get('disk0')!.waitUniformity(); }
  attachPagingStorage(options: PagingStorageOptions = {}): void {
    if (!this.host.enabled()) throw new RangeError('storage subsystem disabled');
    if (this.paging !== null) throw new RangeError('paging storage already attached');
    const target = options.target ?? { kind: 'disk', driveId: 'disk0' };
    const firstSector = options.firstSector ?? 0 as BlockId;
    const sectorCount = options.sectorCount ?? (target.kind === 'disk' ? capacity(this.drives.get(target.driveId)!.geometry) / 512 - firstSector : 1024);
    const candidate: StoragePagingAdapterSnapshot = { target, firstSector, sectorCount, pageBytes: options.pageBytes ?? 4096, mappings: [], transfers: [] };
    this.validatePaging(candidate); this.paging = candidate;
  }
  enqueuePaging(input: PagingStorageInput): void {
    this.reclaimPagingMappings();
    const paging = this.paging; if (paging === null) throw new RangeError('paging storage not attached');
    if (![input.requestId, input.pid, input.space, input.page, input.frame, input.completeAt].every(value => safe(value))
      || !['read', 'write'].includes(input.kind)) throw new RangeError('invalid paging stage');
    if (this.hasPagingTransfer(input.requestId, input.kind)) throw new RangeError('duplicate paging stage');
    let mappings = paging.mappings;
    let mapping = paging.mappings.find(row => row.space === input.space && row.page === input.page);
    if (mapping === undefined) {
      const span = Math.ceil(paging.pageBytes / 512), occupied = new Set(paging.mappings.map(row => row.firstSector));
      let sector = paging.firstSector as number;
      while (occupied.has(sector as BlockId)) sector += span;
      if (sector + span > paging.firstSector + paging.sectorCount) throw new RangeError('paging backing storage full');
      mapping = { space: input.space, page: input.page, firstSector: sector as BlockId };
      mappings = [...paging.mappings, mapping].sort((a, b) => a.space - b.space || a.page - b.page);
    }
    const transfer: StorageTransferSnapshot = input.kind === 'read' ? { kind: 'read', lba: mapping.firstSector, bytes: paging.pageBytes }
      : { kind: 'write', lba: mapping.firstSector, data: Array<number>(paging.pageBytes).fill(0) };
    // WP-06 models frame metadata, not process byte images. The backing identity
    // and physical transfer still participate in real service and durability.
    const id = this.submit(paging.target, transfer, { kind: 'paging', vmRequestId: input.requestId, operation: input.kind }, input.pid);
    const saved: StoragePagingTransferSnapshot = { storageRequestId: id, vmRequestId: input.requestId, operation: input.kind, pid: input.pid,
      backing: { space: input.space, page: input.page }, frame: input.frame, notBeforeTick: input.completeAt, state: { kind: 'pending' } };
    this.paging = { ...paging, mappings, transfers: [...paging.transfers, saved] };
  }
  hasPagingTransfer(requestId: number, kind: 'read' | 'write'): boolean {
    return this.paging?.transfers.some(row => row.vmRequestId === requestId && row.operation === kind && row.state.kind !== 'cancelled') ?? false;
  }
  pagingResult(requestId: number, kind: 'read' | 'write'): StorageResultSnapshot | null {
    const transfer = this.paging?.transfers.find(row => row.vmRequestId === requestId && row.operation === kind);
    return transfer?.state.kind === 'acknowledged' && this.host.tick() >= transfer.notBeforeTick ? structuredClone(transfer.state.result) : null;
  }
  acknowledgePaging(requestId: number, kind: 'read' | 'write'): void {
    if (this.paging === null) return;
    const row = this.paging.transfers.find(t => t.vmRequestId === requestId && t.operation === kind);
    if (row === undefined) return;
    if (row.state.kind !== 'acknowledged' || this.host.tick() < row.notBeforeTick) throw new RangeError('paging stage not complete');
    this.paging = { ...this.paging, transfers: this.paging.transfers.filter(t => t !== row) };
  }
  cancelPaging(requestId: number): void {
    if (this.paging === null) return;
    const transfers: StoragePagingTransferSnapshot[] = [];
    for (const row of this.paging.transfers) {
      if (row.vmRequestId !== requestId) { transfers.push(row); continue; }
      this.cancel(row.storageRequestId);
      if (this.requests.has(row.storageRequestId)) transfers.push({ ...row, state: { kind: 'cancelled', cancelledAtTick: this.host.tick() } });
    }
    this.paging = { ...this.paging, transfers };
  }
  reassignPaging(requestId: number, pid: Pid): void {
    if (this.paging === null) return;
    this.paging = { ...this.paging, transfers: this.paging.transfers.map(row => {
      if (row.vmRequestId !== requestId) return row;
      const request = this.requests.get(row.storageRequestId);
      if (request !== undefined) this.requests.set(request.id, { ...request, pid });
      for (const drive of this.drives.values()) for (const op of drive.operations.values()) {
        const owner = op.owner;
        const belongs = owner.kind === 'request' ? owner.requestId === row.storageRequestId
          : this.raid.get(owner.arrayId)?.saveState().transactions.some(tx => tx.id === owner.transactionId
            && tx.purpose.kind === 'request' && tx.purpose.requestId === row.storageRequestId) ?? false;
        if (belongs) drive.operations.set(op.id, { ...op, pid });
      }
      return { ...row, pid };
    }) }; this.refreshViews();
  }
  private pumpPaging(): void {
    if (this.paging === null) return;
    this.paging = { ...this.paging, transfers: this.paging.transfers.flatMap(row => {
      if (row.state.kind === 'cancelled') return this.requests.has(row.storageRequestId) ? [row] : [];
      if (row.state.kind === 'acknowledged') return [row];
      const completion = this.takeCompletion(row.storageRequestId);
      return completion === null ? [row] : [{ ...row, state: { kind: 'acknowledged' as const, completedAtTick: completion.completedAtTick, result: completion.result } }];
    }) };
    this.reclaimPagingMappings();
  }
  private reclaimPagingMappings(): void {
    const paging = this.paging, live = this.host.isPagingBackingLive;
    if (paging === null || live === undefined) return;
    // Cancelled committed work still owns its sectors until the media drains.
    const mappings = paging.mappings.filter(row => live(row.space, row.page)
      || paging.transfers.some(transfer => transfer.backing.space === row.space && transfer.backing.page === row.page));
    if (mappings.length !== paging.mappings.length) this.paging = { ...paging, mappings };
  }
  control(device: DeviceId, command: string, args: readonly (string | number | boolean)[], _pid: Pid | null = null): SyscallResult {
    if (!this.host.enabled()) return invalid('storage disabled');
    try {
      if (command === 'set_policy' && device === 'disk0' && typeof args[0] === 'string') { this.setPolicy(args[0] as DiskSchedulingId); return ok(); }
      if (command === 'trim' && this.nvm.has(device) && typeof args[0] === 'number' && typeof args[1] === 'number') return this.nvm.get(device)!.trim(args[0], args[1]);
      if (command === 'flush' && this.nvm.has(device)) return ok(this.nvm.get(device)!.flush());
      if (command === 'fail_disk' && this.raid.has(device) && typeof args[0] === 'number') { this.raid.get(device)!.failDisk(args[0]); return ok(); }
      if (command === 'reset' || command === 'crash') {
        const target = this.deviceTarget(device); if (target === null) return invalid('unknown storage device');
        // A device reset fails live requests; process teardown alone discards their
        // waiters. In particular, a paging stage must receive a failed media ACK.
        if (target.kind === 'disk') {
          this.readyPhysicalOperationIds.push(...this.drives.get(target.driveId)!.fail(this.host.tick(), 'cancelled'));
        } else if (target.kind === 'nvm') {
          for (const request of [...this.requests.values()]) if (request.target?.kind === 'nvm' && request.target.deviceId === target.deviceId) this.nvm.get(target.deviceId)!.cancel(request.id);
        } else {
          const array = this.raid.get(target.arrayId)!;
          for (const request of [...this.requests.values()]) if (request.target?.kind === 'raid' && request.target.arrayId === target.arrayId) array.cancel(request.id);
          const saved = array.saveState();
          for (const driveId of new Set([...saved.members.map(member => member.driveId), ...saved.rebuilds.map(row => row.spareDriveId)])) {
            this.readyPhysicalOperationIds.push(...this.drives.get(driveId)!.fail(this.host.tick(), 'cancelled'));
          }
        }
        this.refreshViews(); return ok();
      }
    } catch (error) { return invalid(error instanceof Error ? error.message : 'storage control failed'); }
    return invalid('unknown storage command');
  }
  saveState(): StorageSnapshotState {
    return structuredClone({ owner: 'storage', version: 1, payload: {
      tick: this.host.tick(), settings: this.settings, policy: this.policy, costMultiplier: this.factor,
      nextRequestId: this.nextRequestId, nextPhysicalOperationId: this.nextPhysicalOperationId,
      requests: [...this.requests.values()].sort((a, b) => a.id - b.id), physicalOperations: this.orderedDrives().flatMap(drive => [...drive.operations.values()]).sort((a, b) => a.id - b.id),
      readyRequestIds: this.readyRequestIds, readyPhysicalOperationIds: this.readyPhysicalOperationIds,
      drives: this.orderedDrives().map(drive => drive.saveState()),
      nvm: [...this.nvm].sort((a, b) => textOrder(a[0], b[0])).map(([, device]) => device.saveState()),
      raid: [...this.raid].sort((a, b) => textOrder(a[0], b[0])).map(([, array]) => array.saveState()), paging: this.paging,
    } });
  }
  prepareRestore(state: StorageSnapshotState): () => void {
    const candidate = this.prepare(state);
    return () => {
      this.policy = candidate.policy; this.factor = candidate.factor; this.settings = candidate.settings;
      this.nextRequestId = candidate.nextRequestId; this.nextPhysicalOperationId = candidate.nextPhysicalOperationId;
      this.requests = candidate.requests; this.readyRequestIds = candidate.readyRequestIds; this.readyPhysicalOperationIds = candidate.readyPhysicalOperationIds;
      this.paging = candidate.paging; candidate.bridge.owner = this;
      this.drives.clear(); for (const [id, drive] of candidate.drives) this.drives.set(id, drive);
      this.nvm.clear(); for (const [id, device] of candidate.nvm) this.nvm.set(id, device);
      this.raid.clear(); for (const [id, array] of candidate.raid) this.raid.set(id, array);
      this.refreshViews();
    };
  }
  prepareKernelRestore(snapshot: KernelSnapshot): () => void {
    let state = snapshot.subsystems?.storage;
    if (state === undefined) {
      if (snapshot.subsystems !== undefined || snapshot.diskQueue.length !== 0 || snapshot.diskHead.cylinder !== 0
        || snapshot.diskHead.direction !== 'up' || snapshot.diskHead.totalCylinders !== this.diskHead.totalCylinders) throw new RangeError('missing storage snapshot');
      // Pre-contribution init-only snapshots contain no storage work to recover.
      state = new StorageSubsystem({ ...this.host, tick: () => snapshot.tick },
        { ...this.options, policy: snapshot.config.diskPolicy }).saveState();
    }
    const candidate = this.prepare(state);
    if (state.payload.tick !== snapshot.tick || state.payload.policy !== snapshot.config.diskPolicy || JSON.stringify(candidate.diskQueue) !== JSON.stringify(snapshot.diskQueue)
      || JSON.stringify(candidate.diskHead) !== JSON.stringify(snapshot.diskHead)) throw new RangeError('storage shared snapshot mismatch');
    const paging = state.payload.paging, vm = snapshot.subsystems?.vm?.payload;
    if (paging !== null) {
      if (vm === undefined && paging.transfers.some(row => row.state.kind !== 'cancelled')) throw new RangeError('paging transfer has no VM owner');
      for (const row of paging.transfers) {
        if (row.state.kind === 'cancelled') continue;
        const request = vm?.demand.requests.find(request => request.id === row.vmRequestId);
        const frame = snapshot.frames.find(frame => frame.id === row.frame);
        if (request === undefined || frame === undefined || request.pid !== row.pid || request.frame !== row.frame
          || request.phase !== (row.operation === 'write' ? 'write_back' : 'read')) throw new RangeError('paging VM stage mismatch');
        const backing = row.operation === 'write' ? request.victim : { space: frame.owner, page: frame.page };
        const base = Math.max(request.faultTick, (frame.loadedAtTick ?? request.faultTick + 1) - 1);
        const floor = row.operation === 'write' ? base + vm!.settings.majorFaultTicks : request.dueTick;
        if (backing === null || backing.space !== row.backing.space || backing.page !== row.backing.page
          || floor !== row.notBeforeTick) throw new RangeError('paging backing or deadline mismatch');
      }
      for (const request of vm?.demand.requests ?? []) {
        if (request.phase !== 'write_back' && request.phase !== 'read') continue;
        const frame = snapshot.frames.find(frame => frame.id === request.frame);
        const base = Math.max(request.faultTick, (frame?.loadedAtTick ?? request.faultTick + 1) - 1);
        // Existing VM state records the prefetch shortcut as a shortened floor.
        const maySkipRead = request.phase === 'read' && request.dueTick !== null
          && request.dueTick <= base + (request.victim?.dirty ? vm!.settings.majorFaultTicks : 1);
        if (!maySkipRead && !paging.transfers.some(row => row.vmRequestId === request.id
          && row.operation === (request.phase === 'write_back' ? 'write' : 'read') && row.state.kind !== 'cancelled')) {
          throw new RangeError('VM stage has no paging transfer');
        }
      }
    }
    return this.prepareRestore(state);
  }
  private validateConsumer(consumer: StorageConsumerSnapshot): void {
    if (consumer === null || typeof consumer !== 'object') throw new RangeError('invalid storage consumer');
    if (consumer.kind === 'direct') return;
    if (consumer.kind === 'io' && safe(consumer.requestId)) return;
    if (consumer.kind === 'cache' && safe(consumer.flushId)) return;
    if (consumer.kind === 'paging' && safe(consumer.vmRequestId) && ['read', 'write'].includes(consumer.operation)) return;
    throw new RangeError('invalid storage consumer');
  }
  private validatePaging(paging: StoragePagingAdapterSnapshot): void {
    if (!safe(paging.firstSector) || !safe(paging.sectorCount, 1) || !safe(paging.pageBytes, 1)) throw new RangeError('invalid paging backing extent');
    const target = paging.target;
    if ((target.kind === 'disk' && !this.drives.has(target.driveId)) || (target.kind === 'nvm' && !this.nvm.has(target.deviceId))
      || (target.kind === 'raid' && !this.raid.has(target.arrayId)) || !['disk', 'nvm', 'raid'].includes(target.kind)) throw new RangeError('unknown paging target');
    if (target.kind === 'disk' && (paging.firstSector + paging.sectorCount) * 512 > capacity(this.drives.get(target.driveId)!.geometry)) throw new RangeError('paging extent out of range');
    const keys = new Set<string>(), slots = new Set<number>(), span = Math.ceil(paging.pageBytes / 512);
    if (span > paging.sectorCount) throw new RangeError('paging extent cannot hold one page');
    for (const row of paging.mappings) {
      const key = `${row.space}:${row.page}`;
      if (!safe(row.space) || !safe(row.page) || keys.has(key) || slots.has(row.firstSector) || !safe(row.firstSector)
        || row.firstSector < paging.firstSector || row.firstSector + span > paging.firstSector + paging.sectorCount
        || (row.firstSector - paging.firstSector) % span !== 0) throw new RangeError('invalid paging mapping');
      keys.add(key); slots.add(row.firstSector);
    }
    const ids = new Set<number>(), stages = new Set<string>();
    for (const row of paging.transfers) {
      const stage = `${row.vmRequestId}:${row.operation}`;
      if (!safe(row.storageRequestId) || !safe(row.vmRequestId) || !safe(row.pid) || !safe(row.frame) || !safe(row.notBeforeTick)
        || !['read', 'write'].includes(row.operation) || !keys.has(`${row.backing.space}:${row.backing.page}`)
        || ids.has(row.storageRequestId) || stages.has(stage)) throw new RangeError('invalid paging transfer');
      ids.add(row.storageRequestId); stages.add(stage);
      if (row.storageRequestId >= this.nextRequestId) throw new RangeError('paging request allocator mismatch');
      if (row.state.kind === 'acknowledged') { validateResult(row.state.result);
        if (!safe(row.state.completedAtTick) || row.state.completedAtTick > this.host.tick() || this.requests.has(row.storageRequestId)) throw new RangeError('paging acknowledgement has duplicate owner');
      } else if (row.state.kind === 'pending' || row.state.kind === 'cancelled') {
        const request = this.requests.get(row.storageRequestId);
        if (request === undefined || request.consumer.kind !== 'paging' || request.consumer.vmRequestId !== row.vmRequestId
          || request.consumer.operation !== row.operation || request.pid !== row.pid) throw new RangeError('paging request ownership mismatch');
        const mapping = paging.mappings.find(mapping => mapping.space === row.backing.space && mapping.page === row.backing.page)!;
        const bytes = request.transfer.kind === 'read' ? request.transfer.bytes : request.transfer.data.length;
        if (request.transfer.kind !== row.operation || request.transfer.lba !== mapping.firstSector || bytes !== paging.pageBytes) throw new RangeError('paging transfer address mismatch');
        if (row.state.kind === 'pending' && request.cancelledAtTick !== null) throw new RangeError('cancelled paging request still pending');
        if (row.state.kind === 'cancelled' && (!safe(row.state.cancelledAtTick) || request.cancelledAtTick !== row.state.cancelledAtTick)) throw new RangeError('invalid paging cancellation');
      } else throw new RangeError('invalid paging transfer state');
    }
  }
  private prepare(state: StorageSnapshotState): StorageSubsystem {
    plain(state);
    if (state.owner !== 'storage' || state.version !== 1) throw new RangeError('unsupported storage snapshot');
    const p = state.payload; this.validateSettings(p.settings); requireDiskPolicy(p.policy); positiveFactor(p.costMultiplier);
    if (JSON.stringify(p.settings) !== JSON.stringify(this.settings) || !safe(p.tick) || !safe(p.nextRequestId) || !safe(p.nextPhysicalOperationId)) throw new RangeError('storage snapshot configuration mismatch');
    const candidate = new StorageSubsystem({ tick: () => p.tick, enabled: () => this.host.enabled(),
      emit: event => this.host.emit(event), rng: this.host.rng }, this.options);
    candidate.policy = p.policy; candidate.factor = p.costMultiplier; candidate.settings = structuredClone(p.settings);
    candidate.nextRequestId = p.nextRequestId; candidate.nextPhysicalOperationId = p.nextPhysicalOperationId;
    candidate.drives.clear(); candidate.nvm.clear(); candidate.raid.clear();
    const physicalIds = new Set<number>();
    for (const op of p.physicalOperations) {
      if (physicalIds.has(op.id) || op.id >= p.nextPhysicalOperationId) throw new RangeError('duplicate physical operation'); physicalIds.add(op.id);
    }
    for (const drive of p.drives) {
      if (candidate.drives.has(drive.driveId)) throw new RangeError('duplicate physical disk');
      const disk = new DiskQueue(drive.driveId, drive.geometry, event => { if (candidate.bridge.owner.host.enabled()) candidate.bridge.owner.host.emit(event); }, p.settings.msPerTick);
      disk.prepareRestore(drive, p.physicalOperations.filter(op => op.driveId === drive.driveId))(); candidate.drives.set(drive.driveId, disk);
    }
    if (!candidate.drives.has('disk0') || candidate.diskHead.totalCylinders !== this.diskHead.totalCylinders) throw new RangeError('missing or mismatched disk0');
    for (const op of p.physicalOperations) if (!candidate.drives.has(op.driveId)) throw new RangeError('orphaned physical disk');
    for (const request of p.requests) {
      validateTransfer(request.transfer); candidate.validateConsumer(request.consumer);
      if (!safe(request.id) || request.id >= p.nextRequestId || candidate.requests.has(request.id) || !safe(request.queuedAtTick)
        || request.queuedAtTick > p.tick || (request.pid !== null && !safe(request.pid))
        || (request.cancelledAtTick !== null && (!safe(request.cancelledAtTick) || request.cancelledAtTick < request.queuedAtTick || request.cancelledAtTick > p.tick))) throw new RangeError('invalid storage request');
      if (request.completion !== null) { validateResult(request.completion.result);
        if (!safe(request.completion.completedAtTick) || request.completion.completedAtTick < request.queuedAtTick || request.completion.completedAtTick > p.tick || request.target !== null) throw new RangeError('invalid logical completion');
      } else if (request.target === null) throw new RangeError('pending storage request has no target');
      candidate.requests.set(request.id, structuredClone(request));
    }
    for (const saved of p.nvm) {
      if (candidate.nvm.has(saved.deviceId)) throw new RangeError('duplicate NVM');
      const device = new NvmDevice(candidate.mediaHost(), { ...saved.geometry, deviceId: saved.deviceId,
        writeBufferPages: saved.writeBufferPages, msPerTick: p.settings.msPerTick });
      device.prepareRestore(saved)(); candidate.nvm.set(saved.deviceId, device);
    }
    const assignedRaidDrives = new Set<string>();
    for (const saved of p.raid) {
      for (const driveId of [...saved.members.map(member => member.driveId), ...saved.spareDriveIds, ...saved.rebuilds.map(job => job.spareDriveId)]) {
        const drive = candidate.drives.get(driveId);
        if (drive === undefined || assignedRaidDrives.has(driveId) || saved.blocksPerMember > capacity(drive.geometry) / 512) throw new RangeError('RAID physical drive mismatch');
        assignedRaidDrives.add(driveId);
      }
      if (candidate.raid.has(saved.arrayId)) throw new RangeError('duplicate RAID');
      const array = new RaidArray(candidate.mediaHost(), { arrayId: saved.arrayId, level: saved.level,
        members: saved.members.map(member => member.driveId), blocksPerMember: saved.blocksPerMember, spares: saved.spareDriveIds,
        rebuildBlocksPerTick: p.settings.rebuildBlocksPerTick, rebuildProgressInterval: p.settings.rebuildProgressInterval });
      array.prepareRestore(saved)(); candidate.raid.set(saved.arrayId, array);
    }
    const validateReady = (ids: readonly number[], expected: readonly number[]) => {
      if (new Set(ids).size !== ids.length || ids.length !== expected.length || ids.some(id => !expected.includes(id))) throw new RangeError('completion queue mismatch');
    };
    validateReady(p.readyRequestIds, p.requests.filter(row => row.completion !== null).map(row => row.id));
    validateReady(p.readyPhysicalOperationIds, p.physicalOperations.filter(row => row.result !== null).map(row => row.id));
    candidate.readyRequestIds = [...p.readyRequestIds]; candidate.readyPhysicalOperationIds = [...p.readyPhysicalOperationIds];
    for (const request of candidate.requests.values()) {
      const t = request.target;
      if (t?.kind === 'disk') {
        const op = candidate.physical(t.physicalOperationId);
        if (op?.owner.kind !== 'request' || op.owner.requestId !== request.id || op.driveId !== t.driveId
          || op.pid !== request.pid || op.queuedAtTick !== request.queuedAtTick
          || JSON.stringify(op.transfer) !== JSON.stringify(request.transfer)) throw new RangeError('disk request target mismatch');
      } else if (t?.kind === 'nvm') {
        if (!p.nvm.find(d => d.deviceId === t.deviceId)?.requests.some(r => r.requestId === request.id)) throw new RangeError('NVM request target mismatch');
      } else if (t?.kind === 'raid') {
        const tx = p.raid.find(a => a.arrayId === t.arrayId)?.transactions.find(tx => tx.id === t.transactionId);
        if (tx?.purpose.kind !== 'request' || tx.purpose.requestId !== request.id) throw new RangeError('RAID request target mismatch');
      } else if (t !== null) throw new RangeError('unknown storage target');
    }
    for (const device of p.nvm) for (const row of device.requests) {
      const target = candidate.request(row.requestId)?.target;
      if (target?.kind !== 'nvm' || target.deviceId !== device.deviceId) throw new RangeError('orphaned NVM request');
    }
    for (const array of p.raid) for (const tx of array.transactions) {
      if (tx.purpose.kind === 'request') {
        const target = candidate.request(tx.purpose.requestId)?.target;
        if (target?.kind !== 'raid' || target.arrayId !== array.arrayId || target.transactionId !== tx.id) throw new RangeError('orphaned RAID transaction');
      }
      for (const row of tx.operations) if (row.state.kind === 'submitted') {
        const op = candidate.physical(row.state.physicalOperationId), owner = op?.owner;
        if (owner?.kind !== 'raid' || owner.arrayId !== array.arrayId || owner.transactionId !== tx.id
          || owner.operationId !== row.id) throw new RangeError('RAID plan has no physical operation');
      }
    }
    for (const op of p.physicalOperations) {
      if (op.queuedAtTick > p.tick || (op.servedAtTick !== null && op.servedAtTick > p.tick)) throw new RangeError('future physical operation');
      if (op.owner.kind === 'request') {
        const request = candidate.request(op.owner.requestId);
        if (request?.target?.kind !== 'disk' || request.target.physicalOperationId !== op.id) throw new RangeError('orphaned physical request');
      } else if (op.owner.kind === 'raid') {
        const owner = op.owner, tx = p.raid.find(a => a.arrayId === owner.arrayId)?.transactions.find(t => t.id === owner.transactionId);
        const row = tx?.operations.find(o => o.id === owner.operationId);
        const pid = tx?.purpose.kind === 'request' ? candidate.request(tx.purpose.requestId)?.pid : null;
        if (row?.state.kind !== 'submitted' || row.state.physicalOperationId !== op.id || row.driveId !== op.driveId
          || row.sectorLba !== op.transfer.lba || row.operation.kind !== op.transfer.kind || pid !== op.pid
          || (op.transfer.kind === 'read' ? op.transfer.bytes : op.transfer.data.length) !== 512) throw new RangeError('orphaned or mismatched RAID operation');
      } else throw new RangeError('invalid physical owner');
    }
    candidate.paging = structuredClone(p.paging); if (candidate.paging !== null) candidate.validatePaging(candidate.paging);
    for (const request of candidate.requests.values()) if (request.consumer.kind === 'paging'
      && !candidate.paging?.transfers.some(row => row.storageRequestId === request.id
        && row.vmRequestId === (request.consumer.kind === 'paging' ? request.consumer.vmRequestId : -1)
        && row.state.kind !== 'acknowledged')) throw new RangeError('orphaned paging request');
    candidate.refreshViews(); return candidate;
  }
  assertInvariants(): void {
    if (!this.host.enabled()) return;
    for (const drive of this.drives.values()) {
      if (drive.head.cylinder < 0 || drive.head.cylinder >= drive.head.totalCylinders) throw new Error('I-27 disk head out of range');
      for (const op of drive.queued) if (op.servedAtTick !== null) throw new Error('I-28 queued request already served');
      for (const op of drive.operations.values()) if (op.servedAtTick !== null && op.servedAtTick < op.queuedAtTick) throw new Error('I-28 completion predates request');
    }
  }
}

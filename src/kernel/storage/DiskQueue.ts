import type { EmittableEvent } from '../EventBus';
import type { BlockId, DiskHead, DiskRequest, DiskSchedulingId, DiskSchedulingPolicy,
  StorageDiskDriveSnapshot, StorageDiskOperationSnapshot, StorageResultSnapshot, StorageTransferSnapshot, Tick } from '../types';
import { asTick } from '../types';
import { capacity, diskGeometry, blockToCylinder, validateGeometry, type DiskGeometry } from './geometry';
import { MS_PER_TICK, seekTimeMs, serviceCost } from './costModel';
export type DiskCandidate = { readonly id: number; readonly cylinder: number; readonly queuedAtTick: Tick };
export const byCylinderThenId = (a: DiskCandidate, b: DiskCandidate): number => a.cylinder - b.cylinder || a.id - b.id;
export const textOrder = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const DISK_IDS: readonly DiskSchedulingId[] = ['fcfs', 'sstf', 'scan', 'cscan', 'look', 'clook'];
export function requireDiskPolicy(id: DiskSchedulingId): void {
  if (!DISK_IDS.includes(id)) throw new RangeError('unknown disk policy');
}
export type DiskRoute = { readonly index: number; readonly path: readonly number[]; readonly direction: 'up' | 'down' };
/** Shared with ownerless physical work. No fabricated DiskRequest is needed. */
export function planDiskRoute(policy: DiskSchedulingId, queue: readonly DiskCandidate[], head: DiskHead): DiskRoute {
  requireDiskPolicy(policy);
  if (queue.length === 0) return { index: -1, path: [head.cylinder], direction: head.direction };
  let index = 0, direction = head.direction;
  const path = [head.cylinder];
  if (policy === 'sstf') {
    for (let i = 1; i < queue.length; i++) {
      const a = queue[i]!, b = queue[index]!;
      if ((Math.abs(a.cylinder - head.cylinder) - Math.abs(b.cylinder - head.cylinder) || byCylinderThenId(a, b)) < 0) index = i;
    }
  } else if (policy !== 'fcfs') {
    const sorted = queue.map((request, originalIndex) => ({ request, originalIndex })).sort((a, b) => byCylinderThenId(a.request, b.request));
    const choose = (travel: 'up' | 'down', side: boolean) => sorted.filter(({ request }) => !side
      || (travel === 'up' ? request.cylinder >= head.cylinder : request.cylinder <= head.cylinder))
      .sort((a, b) => (travel === 'up' ? a.request.cylinder - b.request.cylinder : b.request.cylinder - a.request.cylinder)
        || a.request.id - b.request.id)[0];
    let next = choose(direction, true);
    if (next === undefined) {
      if (policy === 'scan' || policy === 'cscan') {
        const end = direction === 'up' ? head.totalCylinders - 1 : 0;
        if (end !== path[path.length - 1]) path.push(end);
        if (policy === 'cscan') {
          const start = direction === 'up' ? 0 : head.totalCylinders - 1;
          if (start !== path[path.length - 1]) path.push(start);
        }
      }
      if (policy === 'scan' || policy === 'look') direction = direction === 'up' ? 'down' : 'up';
      next = choose(direction, false);
    }
    index = next!.originalIndex;
  }
  path.push(queue[index]!.cylinder); // Include a zero-distance real service.
  return { index, path, direction };
}
export function projectedDiskPath(policy: DiskSchedulingId, queue: readonly DiskCandidate[], head: DiskHead): number[] {
  const remaining = [...queue], cursor = { ...head }, path = [cursor.cylinder];
  while (remaining.length > 0) {
    const route = planDiskRoute(policy, remaining, cursor);
    path.push(...route.path.slice(1)); remaining.splice(route.index, 1);
    cursor.cylinder = route.path[route.path.length - 1]!; cursor.direction = route.direction;
  }
  return path;
}
export type BoundDiskPolicy = DiskSchedulingPolicy & { bind(queue: readonly DiskRequest[], head: DiskHead): void };
export function makeDiskPolicy(id: DiskSchedulingId, displayName: string): BoundDiskPolicy {
  let queue: readonly DiskRequest[] = [], head: DiskHead = { cylinder: 0, direction: 'up', totalCylinders: 200 };
  return { id, displayName,
    bind(nextQueue, nextHead) { queue = nextQueue; head = nextHead; },
    select(nextQueue, nextHead) { queue = nextQueue; head = nextHead;
      const plan = planDiskRoute(id, queue, head); head.direction = plan.direction; return plan.index; },
    snapshot: () => ({ policy: id, projectedPath: projectedDiskPath(id, queue, head) }) };
}
export function transferBytes(transfer: StorageTransferSnapshot): number { return transfer.kind === 'read' ? transfer.bytes : transfer.data.length; }
export function validateTransfer(transfer: StorageTransferSnapshot, byteCapacity?: number): void {
  if (transfer === null || typeof transfer !== 'object' || !['read', 'write'].includes(transfer.kind)
    || !Number.isSafeInteger(transfer.lba) || transfer.lba < 0) throw new RangeError('invalid storage transfer');
  if (transfer.kind === 'write' && (!Array.isArray(transfer.data) || transfer.data.some(v => !Number.isInteger(v) || v < 0 || v > 255))) throw new RangeError('invalid storage bytes');
  const bytes = transferBytes(transfer);
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || !Number.isSafeInteger(transfer.lba * 512 + bytes)
    || (byteCapacity !== undefined && transfer.lba * 512 + bytes > byteCapacity)) throw new RangeError('storage transfer out of range');
}
export function validateResult(result: StorageResultSnapshot): void {
  if (result === null || typeof result !== 'object') throw new RangeError('invalid storage result');
  if (result.kind === 'ok') {
    if (!Array.isArray(result.data) || result.data.some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw new RangeError('invalid result bytes');
  } else if (result.kind !== 'failed' || !['io_timeout', 'storage_corruption', 'cancelled', 'device_failed'].includes(result.reason)) throw new RangeError('invalid storage result');
}
export class DiskQueue {
  readonly head: DiskHead;
  readonly operations = new Map<number, StorageDiskOperationSnapshot>();
  private state: StorageDiskDriveSnapshot;
  constructor(readonly driveId = 'disk0', geometry: DiskGeometry = diskGeometry(),
    private readonly emit: (event: EmittableEvent) => void = () => {}, readonly msPerTick = MS_PER_TICK) {
    validateGeometry(geometry);
    this.head = { cylinder: 0, direction: 'up', totalCylinders: geometry.cylinders };
    this.state = { driveId, geometry: { ...geometry }, head: this.head, queue: [], active: null, sectors: [],
      statistics: { totalHeadMovement: 0, completedRequests: 0, meanWaitTicks: 0, waitM2TicksSquared: 0 } };
  }
  get geometry(): DiskGeometry { return this.state.geometry; }
  get queued(): readonly StorageDiskOperationSnapshot[] { return this.state.queue.map(id => this.operations.get(id)!); }
  get active(): StorageDiskDriveSnapshot['active'] { return this.state.active; }
  get totalHeadMovement(): number { return this.state.statistics.totalHeadMovement; }
  waitUniformity(): number { const s = this.state.statistics; return s.completedRequests < 2 ? 0 : Math.sqrt(Math.max(0, s.waitM2TicksSquared / s.completedRequests)); }
  projectRequest(op: StorageDiskOperationSnapshot): DiskRequest | null {
    return op.pid === null ? null : { id: op.id, pid: op.pid, cylinder: op.cylinder, write: op.transfer.kind === 'write', queuedAtTick: op.queuedAtTick, servedAtTick: op.servedAtTick };
  }
  enqueue(op: StorageDiskOperationSnapshot): void {
    validateTransfer(op.transfer, capacity(this.geometry));
    if (op.driveId !== this.driveId || this.operations.has(op.id) || op.servedAtTick !== null || op.cylinder !== blockToCylinder(op.transfer.lba, this.geometry)) throw new RangeError('invalid queued disk operation');
    this.operations.set(op.id, structuredClone(op)); this.state = { ...this.state, queue: [...this.state.queue, op.id] };
    const request = this.projectRequest(op); if (request !== null) this.emit({ type: 'disk.queued', request });
  }
  projectedPath(policy: DiskSchedulingId): number[] {
    const active = this.state.active;
    if (active === null) return projectedDiskPath(policy, this.queued, this.head);
    const path = [this.head.cylinder, ...active.legs.slice(active.nextLegIndex).map(leg => leg.to)];
    const final = active.legs[active.legs.length - 1]!.to;
    return [...path, ...projectedDiskPath(policy, this.queued, { ...this.head, cylinder: final, direction: active.directionAfter }).slice(1)];
  }
  expireTimers(tick: Tick, policy: DiskSchedulingId, threshold: number): void {
    if (policy !== 'sstf') return;
    for (const op of this.queued) if (op.pid !== null && !op.starvationNotified && tick - op.queuedAtTick > threshold) {
      this.operations.set(op.id, { ...op, starvationNotified: true });
      this.emit({ type: 'process.starving', pid: op.pid, waitedTicks: tick - op.queuedAtTick, fatal: false });
    }
  }
  advance(tick: Tick, policy: DiskSchedulingId, multiplier = 1): number[] {
    const completed: number[] = [];
    let active = this.state.active;
    if (active !== null) {
      let next = active.nextLegIndex, movement = 0;
      while (next < active.legs.length && active.legs[next]!.completeAtTick <= tick) {
        const leg = active.legs[next++]!, distance = Math.abs(leg.to - leg.from);
        this.head.cylinder = leg.to; movement += distance; this.emit({ type: 'disk.seek', from: leg.from, to: leg.to, distance });
      }
      active = { ...active, nextLegIndex: next };
      this.state = { ...this.state, active, statistics: { ...this.state.statistics, totalHeadMovement: this.state.statistics.totalHeadMovement + movement } };
      if (active.completeAtTick <= tick) {
        const op = this.operations.get(active.physicalOperationId)!, result = this.transfer(op.transfer);
        const served = { ...op, servedAtTick: tick, result }; this.operations.set(op.id, served); completed.push(op.id);
        this.head.direction = active.directionAfter;
        const s = this.state.statistics, count = s.completedRequests + 1, wait = tick - op.queuedAtTick;
        const delta = wait - s.meanWaitTicks, mean = s.meanWaitTicks + delta / count;
        this.state = { ...this.state, active: null, statistics: { ...s, completedRequests: count, meanWaitTicks: mean, waitM2TicksSquared: s.waitM2TicksSquared + delta * (wait - mean) } };
        const request = this.projectRequest(served); if (request !== null) this.emit({ type: 'disk.served', request, waitTicks: wait });
      }
    }
    if (this.state.active === null && this.state.queue.length > 0) {
      const plan = planDiskRoute(policy, this.queued, this.head), id = this.state.queue[plan.index]!, op = this.operations.get(id)!;
      let distance = 0;
      const legs = plan.path.slice(1).map((to, i) => { const from = plan.path[i]!; distance += Math.abs(to - from);
        return { from, to, completeAtTick: asTick(tick + Math.round(seekTimeMs(distance, this.geometry, multiplier) / this.msPerTick)) }; });
      const ticks = serviceCost(distance, transferBytes(op.transfer), this.geometry, multiplier, this.msPerTick).ticks;
      this.state = { ...this.state, queue: this.state.queue.filter(value => value !== id), active: {
        physicalOperationId: id, policy, startedAtTick: tick, completeAtTick: asTick(tick + ticks), directionAfter: plan.direction, legs, nextLegIndex: 0 } };
    }
    return completed;
  }
  cancel(id: number): boolean {
    if (this.state.active?.physicalOperationId === id) return false;
    this.state = { ...this.state, queue: this.state.queue.filter(value => value !== id) }; this.operations.delete(id); return true;
  }
  fail(tick: Tick, reason: Extract<StorageResultSnapshot, { kind: 'failed' }>['reason'] = 'device_failed'): number[] {
    const ids = [...this.state.queue, ...(this.state.active === null ? [] : [this.state.active.physicalOperationId])];
    for (const id of ids) this.operations.set(id, { ...this.operations.get(id)!, servedAtTick: tick, result: { kind: 'failed', reason } });
    this.state = { ...this.state, queue: [], active: null }; return ids;
  }
  readSector(lba: BlockId): readonly number[] {
    blockToCylinder(lba, this.geometry); return [...(this.state.sectors.find(s => s.lba === lba)?.data ?? Array<number>(512).fill(0))];
  }
  private transfer(transfer: StorageTransferSnapshot): StorageResultSnapshot {
    const length = transferBytes(transfer), result: number[] = [], sectors = new Map(this.state.sectors.map(s => [s.lba, [...s.data]]));
    for (let i = 0; i < length; i++) {
      const lba = (transfer.lba + Math.floor(i / 512)) as BlockId, offset = i % 512;
      if (transfer.kind === 'read') result.push(sectors.get(lba)?.[offset] ?? 0);
      else { let data = sectors.get(lba); if (data === undefined) { data = Array<number>(512).fill(0); sectors.set(lba, data); } data[offset] = transfer.data[i]!; }
    }
    if (transfer.kind === 'write') this.state = { ...this.state, sectors: [...sectors].sort((a, b) => a[0] - b[0]).map(([lba, data]) => ({ lba, data })) };
    return { kind: 'ok', data: result };
  }
  saveState(): StorageDiskDriveSnapshot { return structuredClone({ ...this.state, head: this.head }); }
  prepareRestore(state: StorageDiskDriveSnapshot, operations: readonly StorageDiskOperationSnapshot[]): () => void {
    validateGeometry(state.geometry);
    if (state.driveId !== this.driveId || state.geometry.cylinders !== this.head.totalCylinders || !Number.isSafeInteger(state.head.cylinder)
      || state.head.cylinder < 0 || state.head.cylinder >= state.geometry.cylinders || !['up', 'down'].includes(state.head.direction)) throw new RangeError('invalid saved disk head');
    const byId = new Map<number, StorageDiskOperationSnapshot>();
    for (const op of operations) {
      validateTransfer(op.transfer, capacity(state.geometry));
      if (!Number.isSafeInteger(op.id) || op.id < 0 || byId.has(op.id) || op.driveId !== this.driveId || op.cylinder !== blockToCylinder(op.transfer.lba, state.geometry)
        || !Number.isSafeInteger(op.queuedAtTick) || op.queuedAtTick < 0 || (op.pid !== null && (!Number.isSafeInteger(op.pid) || op.pid < 0))
        || typeof op.starvationNotified !== 'boolean') throw new RangeError('invalid disk operation');
      if (op.servedAtTick !== null && (!Number.isSafeInteger(op.servedAtTick) || op.servedAtTick < op.queuedAtTick)) throw new RangeError('invalid disk completion');
      if ((op.servedAtTick === null) !== (op.result === null)) throw new RangeError('disk completion result mismatch');
      if (op.result !== null) validateResult(op.result); byId.set(op.id, structuredClone(op));
    }
    const pending = new Set<number>();
    for (const id of state.queue) { if (pending.has(id) || byId.get(id)?.servedAtTick !== null) throw new RangeError('invalid disk queue'); pending.add(id); }
    if (state.active !== null) {
      const a = state.active; requireDiskPolicy(a.policy);
      if (pending.has(a.physicalOperationId) || byId.get(a.physicalOperationId)?.servedAtTick !== null || !Number.isSafeInteger(a.nextLegIndex)
        || a.nextLegIndex < 0 || a.nextLegIndex > a.legs.length || a.legs.length === 0 || !['up', 'down'].includes(a.directionAfter)
        || !Number.isSafeInteger(a.startedAtTick) || a.startedAtTick < 0 || !Number.isSafeInteger(a.completeAtTick) || a.completeAtTick <= a.startedAtTick) throw new RangeError('invalid committed disk route');
      pending.add(a.physicalOperationId); let priorTick = a.startedAtTick, priorTo: number | undefined;
      for (const leg of a.legs) {
        if (![leg.from, leg.to].every(v => Number.isSafeInteger(v) && v >= 0 && v < state.geometry.cylinders)
          || (priorTo !== undefined && priorTo !== leg.from) || !Number.isSafeInteger(leg.completeAtTick) || leg.completeAtTick < priorTick || leg.completeAtTick > a.completeAtTick) throw new RangeError('invalid disk route leg');
        priorTick = leg.completeAtTick; priorTo = leg.to;
      }
      if (priorTo !== byId.get(a.physicalOperationId)!.cylinder || state.head.cylinder !== (a.nextLegIndex === 0 ? a.legs[0]!.from : a.legs[a.nextLegIndex - 1]!.to)) throw new RangeError('disk route cursor mismatch');
    }
    for (const op of byId.values()) if (op.servedAtTick === null && !pending.has(op.id)) throw new RangeError('orphaned disk operation');
    let priorLba = -1;
    for (const s of state.sectors) { blockToCylinder(s.lba, state.geometry);
      if (s.lba <= priorLba || s.data.length !== 512 || s.data.some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw new RangeError('invalid disk sectors'); priorLba = s.lba; }
    const s = state.statistics;
    if (![s.totalHeadMovement, s.completedRequests].every(v => Number.isSafeInteger(v) && v >= 0)
      || ![s.meanWaitTicks, s.waitM2TicksSquared].every(v => Number.isFinite(v) && v >= 0)) throw new RangeError('invalid disk statistics');
    const saved = structuredClone(state);
    return () => { this.state = saved; this.head.cylinder = saved.head.cylinder; this.head.direction = saved.head.direction;
      this.operations.clear(); for (const [id, op] of byId) this.operations.set(id, op); };
  }
}

import { describe, expect, it } from 'vitest';
import type { BlockId, DiskHead, DiskRequest, DiskSchedulingId, StorageDiskOperationSnapshot } from '../../../src/kernel/types';
import { asPid, asTick } from '../../../src/kernel/types';
import type { EmittableEvent } from '../../../src/kernel/EventBus';
import { DiskQueue, byCylinderThenId, planDiskRoute, projectedDiskPath } from '../../../src/kernel/storage/DiskQueue';
import { createDiskPolicy, DISK_POLICIES } from '../../../src/kernel/storage/registry';
import { diskGeometry } from '../../../src/kernel/storage/geometry';
import { StorageSubsystem } from '../../../src/kernel/storage/StorageSubsystem';
import { createRng } from '../../../src/kernel/rng';
import { createKernel } from '../../../src/kernel/Kernel';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';

const cylinders = [98, 183, 37, 122, 14, 124, 65, 67];
const rows: readonly [string, DiskSchedulingId, 'up' | 'down', readonly number[], number][] = [
  ['DISK-FCFS-1', 'fcfs', 'up', [53,98,183,37,122,14,124,65,67], 640],
  ['DISK-SSTF-1', 'sstf', 'up', [53,65,67,37,14,98,122,124,183], 236],
  ['DISK-SCAN-1', 'scan', 'down', [53,37,14,0,65,67,98,122,124,183], 236],
  ['DISK-SCAN-2', 'scan', 'up', [53,65,67,98,122,124,183,199,37,14], 331],
  ['DISK-LOOK-1', 'look', 'down', [53,37,14,65,67,98,122,124,183], 208],
  ['DISK-LOOK-2', 'look', 'up', [53,65,67,98,122,124,183,37,14], 299],
  ['DISK-CSCAN-1', 'cscan', 'up', [53,65,67,98,122,124,183,199,0,14,37], 382],
  ['DISK-CSCAN-2', 'cscan', 'down', [53,37,14,0,199,183,124,122,98,67,65], 386],
  ['DISK-CLOOK-1', 'clook', 'up', [53,65,67,98,122,124,183,14,37], 322],
  ['DISK-CLOOK-2', 'clook', 'down', [53,37,14,183,124,122,98,67,65], 326],
];
const request = (cylinder: number, id: number): DiskRequest => ({ id, pid: asPid(id + 2), cylinder, write: false, queuedAtTick: asTick(0), servedAtTick: null });
const operation = (cylinder: number, id: number): StorageDiskOperationSnapshot => ({ id, driveId: 'disk0', owner: { kind: 'request', requestId: id },
  pid: asPid(id + 2), cylinder, transfer: { kind: 'read', lba: cylinder * 256 as BlockId, bytes: 4096 },
  queuedAtTick: asTick(0), servedAtTick: null, starvationNotified: false, result: null });
function queue(direction: 'up' | 'down' = 'up', emit: (event: EmittableEvent) => void = () => {}) {
  const disk = new DiskQueue('disk0', diskGeometry(), emit); disk.head.cylinder = 53; disk.head.direction = direction;
  cylinders.forEach((cylinder, id) => disk.enqueue(operation(cylinder, id))); return disk;
}
function drain(disk: DiskQueue, policy: DiskSchedulingId, from = 0) {
  for (let tick = from; tick < 500; tick++) { disk.advance(asTick(tick), policy); if (disk.queued.length === 0 && disk.active === null) return tick; }
  throw new Error('disk did not drain');
}
describe('disk scheduling and committed service', () => {
  it.each(rows)('%s exact path, movement and real request count', (_name, policy, direction, expected, total) => {
    const events: EmittableEvent[] = [], disk = queue(direction, event => events.push(event));
    expect(disk.projectedPath(policy)).toEqual(expected);
    drain(disk, policy);
    const seeks = events.filter(event => event.type === 'disk.seek');
    expect([53, ...seeks.map(event => event.to)]).toEqual(expected);
    expect(seeks.reduce((sum, event) => sum + event.distance, 0)).toBe(total);
    expect(disk.totalHeadMovement).toBe(total);
    for (const seek of seeks) expect(seek.distance).toBe(Math.abs(seek.to - seek.from));
    expect(events.filter(event => event.type === 'disk.queued')).toHaveLength(8);
    expect(events.filter(event => event.type === 'disk.served')).toHaveLength(8);
  });
  it('FCFS has all eight individual movements', () => {
    const path = projectedDiskPath('fcfs', cylinders.map(request), { cylinder: 53, direction: 'up', totalCylinders: 200 });
    expect(path.slice(1).map((c, i) => Math.abs(c - path[i]!))).toEqual([45,85,146,85,108,110,59,2]);
  });
  it('frozen policy wrappers return queue indices and pure projections', () => {
    for (const id of Object.keys(DISK_POLICIES) as DiskSchedulingId[]) {
      const policy = createDiskPolicy(id), requests = cylinders.map(request);
      const head: DiskHead = { cylinder: 53, direction: 'down', totalCylinders: 200 };
      policy.bind(requests, head); const before = structuredClone({ requests, head });
      expect(policy.snapshot().projectedPath).toEqual(projectedDiskPath(id, requests, head));
      expect({ requests, head }).toEqual(before);
      const index = policy.select(requests, head); expect(Number.isInteger(index)).toBe(true); expect(index).toBeGreaterThanOrEqual(0); expect(index).toBeLessThan(requests.length);
      expect(policy.select([], head)).toBe(-1);
    }
  });
  it('SSTF resolves distance ties by cylinder, then id', () => {
    const requests = [request(60, 7), request(40, 8), request(40, 2)];
    expect(createDiskPolicy('sstf').select(requests, { cylinder: 50, direction: 'up', totalCylinders: 200 })).toBe(2);
  });
  it('all directional comparators prefer the lower id at a shared cylinder', () => {
    const requests = [request(40, 7), request(40, 2)];
    for (const id of ['scan', 'cscan', 'look', 'clook'] as const) expect(planDiskRoute(id, requests, { cylinder: 50, direction: 'down', totalCylinders: 200 }).index).toBe(1);
    for (let i = 0; i < 500; i++) { const a = request(i % 200, i), b = request((i + 1) % 200, i + 1);
      expect(byCylinderThenId(a, b)).not.toBe(0); expect(Math.sign(byCylinderThenId(a, b))).toBe(-Math.sign(byCylinderThenId(b, a))); }
  });
  it('pins actual batch population SD instead of claiming C-SCAN wins', () => {
    for (const [policy, direction, expected] of [ ['scan', 'up', 30.650244697228764], ['cscan', 'up', 32.1082154595985],
      ['scan', 'down', 27.146592788046163], ['cscan', 'down', 32.1082154595985], ['look', 'down', 26.143832925], ['look', 'up', 29.576172842340505] ] as const) {
      const disk = queue(direction); drain(disk, policy); expect(disk.waitUniformity()).toBeCloseTo(expected, 8);
    }
  });
  it('measures LOOK-up service times used by the population SD fixture', () => {
    const events: EmittableEvent[] = [], disk = queue('up', event => events.push(event)); drain(disk, 'look');
    expect(events.filter(event => event.type === 'disk.served').map(event => event.waitTicks)).toEqual([10,20,32,43,53,67,88,99]);
  });
  it('preserves queued work and committed service through all six Kernel policy changes', () => {
    const kernel = createKernel({ ...REFERENCE_CONFIG, enabledSubsystems: ['storage'] });
    kernel.storageSubsystem.diskHead.cylinder = 53;
    const ids = cylinders.map(cylinder => kernel.storageSubsystem.submit({ kind: 'disk', driveId: 'disk0' },
      { kind: 'read', lba: cylinder * 256 as BlockId, bytes: 4096 }, { kind: 'direct' }, asPid(3)));
    kernel.step();
    const before = kernel.storageSubsystem.saveState().payload, view = kernel.storageSubsystem.diskQueue;
    for (const id of Object.keys(DISK_POLICIES) as DiskSchedulingId[]) {
      kernel.setDiskPolicy(id);
      const after = kernel.storageSubsystem.saveState().payload;
      expect(kernel.activeDiskPolicy).toBe(id); expect(kernel.config.diskPolicy).toBe(id);
      expect(kernel.storageSubsystem.diskQueue).toBe(view); expect(after.requests).toEqual(before.requests);
      expect(after.physicalOperations).toEqual(before.physicalOperations); expect(after.drives).toEqual(before.drives);
    }
    kernel.run(200);
    for (const id of ids) expect(kernel.storageSubsystem.takeCompletion(id)?.result.kind).toBe('ok');
    expect(kernel.snapshot().diskQueue).toEqual([]);
  });
  it('reports starvation once and never attributes kernel work to a fake pid', () => {
    const events: EmittableEvent[] = [], disk = new DiskQueue('disk0', diskGeometry(), event => events.push(event));
    disk.enqueue(operation(190, 0)); disk.enqueue({ ...operation(191, 1), pid: null });
    disk.expireTimers(asTick(400), 'sstf', 400); expect(events.filter(event => event.type === 'process.starving')).toHaveLength(0);
    disk.expireTimers(asTick(401), 'sstf', 400); disk.expireTimers(asTick(402), 'sstf', 400);
    expect(events.filter(event => event.type === 'process.starving')).toEqual([{ type: 'process.starving', pid: asPid(2), waitedTicks: 401, fatal: false }]);
  });
  it('preserves a committed route when policy and multiplier change', () => {
    const disk = new DiskQueue(); disk.head.cylinder = 183; disk.enqueue(operation(14, 0));
    disk.advance(asTick(0), 'cscan'); const committed = structuredClone(disk.active);
    disk.advance(asTick(1), 'fcfs', 0.5); expect(disk.active).toEqual(committed);
    drain(disk, 'fcfs', 2); expect(disk.totalHeadMovement).toBe(229); expect(disk.operations.get(0)!.servedAtTick).toBe(28);
  });
  it('continues the exact event suffix after a detached mid-route restore', () => {
    const events: EmittableEvent[] = [], disk = queue('up', event => events.push(event));
    for (let t = 0; t <= 70; t++) disk.advance(asTick(t), 'cscan');
    const saved = disk.saveState(), operations = [...disk.operations.values()], restoredEvents: EmittableEvent[] = [];
    const restored = new DiskQueue('disk0', diskGeometry(), event => restoredEvents.push(event));
    const commit = restored.prepareRestore(saved, operations); expect(restored.head.cylinder).toBe(0); commit();
    const offset = events.length;
    expect(restored.projectedPath('cscan')).toEqual(disk.projectedPath('cscan'));
    drain(disk, 'cscan', 71); drain(restored, 'cscan', 71);
    expect(restoredEvents).toEqual(events.slice(offset)); expect(restored.saveState()).toEqual(disk.saveState());
    const invalid = structuredClone(saved); Object.assign(invalid.head, { cylinder: 200 });
    const before = restored.saveState(); expect(() => restored.prepareRestore(invalid, operations)).toThrow(); expect(restored.saveState()).toEqual(before);
  });
  it('retains bytes until durable completion and supports a partial final sector', () => {
    const disk = new DiskQueue(), write = { ...operation(0, 0), transfer: { kind: 'write' as const, lba: 0 as BlockId, data: Array<number>(513).fill(7) } };
    disk.enqueue(write); disk.advance(asTick(0), 'fcfs'); expect(disk.readSector(0 as BlockId)[0]).toBe(0);
    drain(disk, 'fcfs', 1); expect(disk.readSector(0 as BlockId)).toEqual(Array<number>(512).fill(7));
    expect(disk.readSector(1 as BlockId).slice(0, 2)).toEqual([7, 0]);
  });
});

describe('storage completion ownership and detached persistence', () => {
  function host(enabled = true) {
    let tick = 0;
    const events: EmittableEvent[] = [];
    const storage = new StorageSubsystem({ tick: () => asTick(tick), enabled: () => enabled,
      emit: event => events.push(event), rng: createRng(47) });
    return { storage, events, setTick: (value: number) => { tick = value; }, step: (value: number) => {
      tick = value; storage.expireTimers(asTick(value)); storage.serviceCompletions(asTick(value));
    } };
  }
  it('restores an in-flight raw disk write and delivers one durable result', () => {
    const a = host();
    const id = a.storage.submit({ kind: 'disk', driveId: 'disk0' }, { kind: 'write', lba: 256 as BlockId, data: Array<number>(512).fill(23) }, { kind: 'direct' }, asPid(3));
    a.step(0); a.step(1); const saved = a.storage.saveState();
    const b = host(); b.setTick(1); const before = b.storage.saveState(); const commit = b.storage.prepareRestore(saved);
    expect(b.storage.saveState()).toEqual(before); commit();
    for (let tick = 2; tick < 20; tick++) { a.step(tick); b.step(tick); }
    expect(b.storage.saveState()).toEqual(a.storage.saveState());
    expect(a.storage.peekCompletion(id)?.result).toEqual({ kind: 'ok', data: [] });
    expect(a.storage.takeCompletion(id)?.result).toEqual({ kind: 'ok', data: [] });
    expect(a.storage.takeCompletion(id)).toBeNull(); expect(a.storage.readSector('disk0', 256 as BlockId)).toEqual(Array<number>(512).fill(23));
  });
  it('prepares an active NVM snapshot against saved time, not the fresh host clock', () => {
    const a = host(); a.setTick(100);
    const id = a.storage.submit({ kind: 'nvm', deviceId: 'nvm0' as import('../../../src/kernel/types').DeviceId },
      { kind: 'read', lba: 0 as BlockId, bytes: 4096 }, { kind: 'direct' }, asPid(4));
    const saved = a.storage.saveState(); const b = host();
    const commit = b.storage.prepareRestore(saved); commit(); b.setTick(100);
    for (let tick = 101; tick <= 104; tick++) { a.step(tick); b.step(tick); }
    expect(b.storage.saveState()).toEqual(a.storage.saveState()); expect(b.storage.takeCompletion(id)?.result.kind).toBe('ok');
  });
  it('cancels queued work and drains active media without retaining waiters', () => {
    const a = host();
    const first = a.storage.submit({ kind: 'disk', driveId: 'disk0' }, { kind: 'read', lba: 0 as BlockId, bytes: 512 }, { kind: 'io', requestId: 2 }, asPid(7));
    a.step(0);
    a.storage.submit({ kind: 'disk', driveId: 'disk0' }, { kind: 'read', lba: 8 as BlockId, bytes: 512 }, { kind: 'io', requestId: 3 }, asPid(7));
    a.storage.removeWaiter(asPid(7)); expect(a.storage.diskQueue).toEqual([]);
    const saved = a.storage.saveState(); expect(saved.payload.requests).toHaveLength(1);
    const b = host(); b.storage.prepareRestore(saved)();
    for (let tick = 1; tick < 20; tick++) { a.step(tick); b.step(tick); }
    expect(a.storage.peekCompletion(first)).toBeNull(); expect(a.storage.saveState().payload.requests).toEqual([]);
    expect(b.storage.saveState()).toEqual(a.storage.saveState());
  });
  it('rejects cross-table corruption before any commit', () => {
    const a = host(); a.storage.submit({ kind: 'disk', driveId: 'disk0' }, { kind: 'read', lba: 0 as BlockId, bytes: 512 });
    const saved = a.storage.saveState(), corrupt = structuredClone(saved);
    Object.assign(corrupt.payload, { nextPhysicalOperationId: 0 });
    expect(() => a.storage.prepareRestore(corrupt)).toThrow(); expect(a.storage.saveState()).toEqual(saved);
    const orphan = structuredClone(saved); Object.assign(orphan.payload, { requests: [] });
    expect(() => a.storage.prepareRestore(orphan)).toThrow(); expect(a.storage.saveState()).toEqual(saved);
  });
  it.each(['disk0', 'nvm0', 'raid-test'] as const)('reset on %s delivers a failed paging ACK instead of abandoning the stage', device => {
    const a = host();
    if (device === 'raid-test') a.storage.registerRaid({ arrayId: device, level: 1, members: ['member-a', 'member-b'], blocksPerMember: 16 });
    const target = a.storage.deviceTarget(device as import('../../../src/kernel/types').DeviceId)!;
    a.storage.attachPagingStorage({ target, sectorCount: 16 });
    a.storage.enqueuePaging({ requestId: 1, kind: 'read', pid: asPid(5),
      space: 1 as import('../../../src/kernel/types').AddressSpaceId, page: 2 as import('../../../src/kernel/types').PageId,
      frame: 0 as import('../../../src/kernel/types').FrameId, completeAt: asTick(0) });
    a.step(0);
    expect(a.storage.control(device as import('../../../src/kernel/types').DeviceId, 'reset', []).ok).toBe(true);
    a.step(1);
    expect(a.storage.pagingResult(1, 'read')).toEqual({ kind: 'failed', reason: 'cancelled' });
    expect(a.storage.saveState().payload.requests).toEqual([]);
    const b = host(); b.setTick(1); b.storage.prepareRestore(a.storage.saveState())();
    expect(b.storage.pagingResult(1, 'read')).toEqual({ kind: 'failed', reason: 'cancelled' });
    b.storage.acknowledgePaging(1, 'read'); expect(b.storage.hasPagingTransfer(1, 'read')).toBe(false);
  });
  it('rejects logical and physical transfer disagreement without mutation', () => {
    const a = host(); a.storage.submit({ kind: 'disk', driveId: 'disk0' }, { kind: 'read', lba: 0 as BlockId, bytes: 512 });
    const saved = a.storage.saveState(), corrupt = structuredClone(saved);
    Object.assign(corrupt.payload.requests[0]!.transfer, { bytes: 1024 });
    expect(() => a.storage.prepareRestore(corrupt)).toThrow('disk request target mismatch'); expect(a.storage.saveState()).toEqual(saved);
  });
  it('rejects a submitted RAID operation whose sector disagrees with its plan', () => {
    const a = host(); a.storage.registerRaid({ arrayId: 'mirror', level: 1, members: ['a', 'b'], blocksPerMember: 16 });
    a.storage.submit({ kind: 'raid', arrayId: 'mirror' }, { kind: 'read', lba: 0 as BlockId, bytes: 512 });
    const saved = a.storage.saveState(), corrupt = structuredClone(saved);
    Object.assign(corrupt.payload.physicalOperations[0]!.transfer, { lba: 1 });
    expect(() => a.storage.prepareRestore(corrupt)).toThrow('mismatched RAID operation'); expect(a.storage.saveState()).toEqual(saved);
  });
  it('rejects a submitted RAID plan after its physical queue row is removed', () => {
    const a = host(); a.storage.registerRaid({ arrayId: 'mirror', level: 1, members: ['a', 'b'], blocksPerMember: 16 });
    a.storage.submit({ kind: 'raid', arrayId: 'mirror' }, { kind: 'read', lba: 0 as BlockId, bytes: 512 });
    const saved = a.storage.saveState(), corrupt = structuredClone(saved), op = corrupt.payload.physicalOperations[0]!;
    Object.assign(corrupt.payload, { physicalOperations: corrupt.payload.physicalOperations.filter(row => row.id !== op.id) });
    const drive = corrupt.payload.drives.find(row => row.driveId === op.driveId)!;
    Object.assign(drive, { queue: drive.queue.filter(id => id !== op.id) });
    expect(() => a.storage.prepareRestore(corrupt)).toThrow('RAID plan has no physical operation'); expect(a.storage.saveState()).toEqual(saved);
  });
  it('rejects a second RAID transaction claiming the same logical request', () => {
    const a = host(); a.storage.registerRaid({ arrayId: 'mirror', level: 1, members: ['a', 'b'], blocksPerMember: 16 });
    a.storage.submit({ kind: 'raid', arrayId: 'mirror' }, { kind: 'read', lba: 0 as BlockId, bytes: 512 });
    const saved = a.storage.saveState(), corrupt = structuredClone(saved), array = corrupt.payload.raid[0]!;
    Object.assign(array, { nextTransactionId: 2, transactions: [...array.transactions, { ...array.transactions[0]!, id: 1, operations: [] }] });
    expect(() => a.storage.prepareRestore(corrupt)).toThrow('orphaned RAID transaction'); expect(a.storage.saveState()).toEqual(saved);
  });
  it('rejects a second NVM device claiming the same logical request', () => {
    const a = host(); a.storage.submit({ kind: 'nvm', deviceId: 'nvm0' as import('../../../src/kernel/types').DeviceId },
      { kind: 'read', lba: 0 as BlockId, bytes: 512 });
    const saved = a.storage.saveState(), corrupt = structuredClone(saved);
    Object.assign(corrupt.payload, { nvm: [...corrupt.payload.nvm, { ...corrupt.payload.nvm[0]!, deviceId: 'other-nvm' }] });
    expect(() => a.storage.prepareRestore(corrupt)).toThrow('orphaned NVM request'); expect(a.storage.saveState()).toEqual(saved);
  });
  it('rejects RAID registration conflicts before creating extra drives', () => {
    const a = host(); a.storage.registerRaid({ arrayId: 'first', level: 1, members: ['a', 'b'], blocksPerMember: 16 });
    const saved = a.storage.saveState();
    expect(() => a.storage.registerRaid({ arrayId: 'second', level: 1, members: ['a', 'c'], blocksPerMember: 16 })).toThrow();
    expect(() => a.storage.registerRaid({ arrayId: 'second', level: 1, members: ['c', 'd'], blocksPerMember: 51201 })).toThrow();
    expect(a.storage.saveState()).toEqual(saved);
  });
  it('has no implicit paging adapter or shipping-device fallback while disabled', () => {
    const a = host(false); const before = a.storage.saveState();
    expect(a.storage.pagingAttached).toBe(false);
    expect(a.storage.deviceTarget('disk0' as import('../../../src/kernel/types').DeviceId)).toBeNull();
    expect(() => a.storage.submit({ kind: 'disk', driveId: 'disk0' }, { kind: 'read', lba: 0 as BlockId, bytes: 512 })).toThrow();
    a.storage.expireTimers(asTick(20)); a.storage.serviceCompletions(asTick(20));
    expect(a.storage.saveState()).toEqual(before); expect(a.events).toEqual([]);
  });
});

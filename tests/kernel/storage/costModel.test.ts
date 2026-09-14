import { describe, expect, it } from 'vitest';
import { DiskCostModel, MS_PER_TICK, serviceCost, ticksFor, seekTimeMs, rotationMs, transferMs } from '../../../src/kernel/storage/costModel';
import { blockToCylinder, capacity, diskGeometry } from '../../../src/kernel/storage/geometry';
import { StorageSubsystem } from '../../../src/kernel/storage/StorageSubsystem';
import { createRng } from '../../../src/kernel/rng';
import { createKernel, type KernelImpl } from '../../../src/kernel/Kernel';
import { instructionProgram, type Instruction } from '../../../src/kernel/process/Program';
import { asPageId, asPid, asResourceId, asTick } from '../../../src/kernel/types';
import type { AddressSpaceId, BlockId, FrameId, KernelEvent, KernelSnapshot } from '../../../src/kernel/types';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';

describe('disk geometry and service costs', () => {
  it('DISK-COST-1 preserves precision until presentation', () => {
    const cost = serviceCost(50, 4096);
    expect(cost.seekTimeMs).toBe(2.5);
    expect(cost.rotationMs.toFixed(4)).toBe('4.1667');
    expect(cost.transferMs.toFixed(4)).toBe('0.0410');
    expect(cost.serviceMs.toFixed(4)).toBe('6.7076');
    expect(cost.serviceMs).toBeCloseTo(6.707626666666667, 12);
  });
  it('DISK-COST-2 rounds once and has the default nine-tick zero-seek cost', () => {
    expect(MS_PER_TICK).toBe(0.5);
    expect(serviceCost(50, 4096).ticks).toBe(13);
    expect(serviceCost(0, 4096).ticks).toBe(9);
    for (let i = 0; i < 1000; i++) expect(ticksFor(i / 1000)).toBeGreaterThanOrEqual(1);
  });
  it('has the specified seek, rotation and transfer tables', () => {
    expect([0, 1, 50, 199].map(distance => seekTimeMs(distance))).toEqual([0.5, 0.54, 2.5, 8.46]);
    expect(rotationMs()).toBeCloseTo(4.166666666667, 10);
    expect(transferMs(4096)).toBe(0.04096);
  });
  it('addresses sectors without treating 4096-byte filesystem blocks as LBAs', () => {
    expect(capacity()).toBe(26_214_400);
    expect([0, 255, 256].map(lba => blockToCylinder(lba))).toEqual([0, 0, 1]);
    expect(blockToCylinder(51_199)).toBe(199);
    expect(() => blockToCylinder(51_200)).toThrow();
    expect(() => blockToCylinder(-1)).toThrow();
  });
  it('scales seek and device latency only, including a committed route distance', () => {
    const model = new DiskCostModel(); model.setCostMultiplier(0.5);
    const cost = model.evaluate(50, 4096);
    expect(cost.seekTimeMs).toBe(1.25);
    expect(cost.serviceMs.toFixed(4)).toBe('5.4576'); expect(cost.ticks).toBe(11);
    expect(cost.rotationMs).toBe(rotationMs()); expect(cost.transferMs).toBe(transferMs(4096));
    expect(model.deviceLatency(20)).toBe(10);
    expect(model.evaluate(229, 4096).seekTimeMs).toBeCloseTo(4.83, 12);
  });
  it('rejects invalid runtime cost and geometry inputs', () => {
    for (const factor of [0, -1, Infinity, NaN]) expect(() => new DiskCostModel().setCostMultiplier(factor)).toThrow();
    expect(() => ticksFor(-1)).toThrow(); expect(() => ticksFor(Infinity)).toThrow();
    expect(() => serviceCost(1, 0.5)).toThrow(); expect(() => diskGeometry({ cylinders: 0 })).toThrow();
    expect(() => diskGeometry({ bytesPerSector: 4096 })).toThrow();
  });
});

describe('opt-in paging storage integration', () => {
  const access = (page: number, write = false): Instruction => ({ kind: 'access', page: asPageId(page), write });
  const compute: Instruction = { kind: 'compute' };
  function fixture(instructions: readonly Instruction[], attached = true, majorFaultTicks = 3, frames = 3) {
    const kernel = createKernel({ ...REFERENCE_CONFIG, totalFrames: frames, replacementPolicy: 'fifo',
      enabledSubsystems: ['process', 'scheduler', 'memory', 'vm', 'storage'], thrashingThreshold: 1e9 },
    { majorFaultTicks, tlbMissTicks: 1, tlbHitTicks: 1, threadCreateTicks: 0, contextSwitchTicks: 0,
      thrashingCriticalDemandRatio: 1e9, thrashingSuspendInterval: 1000 });
    if (attached) kernel.attachPagingStorage();
    const pid = kernel.spawn({ name: 'backed page reader', priority: 10, arrival: 0, burst: 100, service: 100, pages: 3 },
      { program: instructionProgram(instructions) });
    const pcb = kernel.table.get(pid)!; const thread = kernel.threads.table.get(pcb.threads[0]!)!;
    const events: KernelEvent[] = []; const loads: { phase: number; tick: number }[] = []; let phase = 0;
    kernel.onPhase(value => { phase = value; });
    kernel.events.onAny(event => { events.push(event); if (event.type === 'memory.page_loaded') loads.push({ phase, tick: event.tick }); });
    return { kernel, pid, pcb, thread, events, loads };
  }
  function until(kernel: KernelImpl, condition: () => boolean, limit = 200) {
    for (let count = 0; count < limit && !condition(); count++) kernel.step();
    expect(condition()).toBe(true);
  }
  it('leaves the WP-06 deadline unchanged when storage is enabled without attachment', () => {
    const f = fixture([access(0), compute], false);
    until(f.kernel, () => f.thread.programCounter === 1);
    expect(f.loads).toEqual([{ phase: 1, tick: 1 + f.kernel.tuning.majorFaultTicks }]);
    expect(f.kernel.storageSubsystem.saveState().payload).toMatchObject({ paging: null, requests: [], physicalOperations: [] });
    expect(f.events.some(event => event.type === 'disk.queued')).toBe(false);
  });
  it('waits for media acknowledgement, loads in phase 2 and can wake in the same phase 4', () => {
    const f = fixture([access(0), compute]); f.kernel.step();
    expect(f.thread.programCounter).toBe(0); expect(f.pcb.state).toBe('waiting');
    f.kernel.run(f.kernel.tuning.majorFaultTicks);
    expect(f.loads).toEqual([]); expect(f.thread.programCounter).toBe(0);
    until(f.kernel, () => f.thread.programCounter === 1);
    const served = f.events.find(event => event.type === 'disk.served');
    expect(served?.tick).toBe(11); expect(f.loads).toEqual([{ phase: 2, tick: served!.tick }]);
    expect(f.pcb.state).toBe('running');
    expect(f.events.filter(event => event.type === 'memory.page_fault')).toHaveLength(1);
    expect(f.kernel.storageSubsystem.saveState().payload.paging?.transfers).toEqual([]);
  });
  it('keeps a longer VM deadline even when media acknowledges earlier', () => {
    const f = fixture([access(0), compute], true, 20);
    f.kernel.run(11); expect(f.loads).toEqual([]);
    expect(f.kernel.storageSubsystem.saveState().payload.paging?.transfers[0]?.state.kind).toBe('acknowledged');
    until(f.kernel, () => f.thread.programCounter === 1);
    expect(f.loads).toEqual([{ phase: 2, tick: 21 }]);
  });
  it('serializes dirty write-back acknowledgement before enqueueing the following read', () => {
    const f = fixture([access(0, true), access(1), compute], true, 3, 1);
    until(f.kernel, () => f.thread.programCounter === 2);
    const queued = f.events.filter(event => event.type === 'disk.queued');
    const served = f.events.filter(event => event.type === 'disk.served');
    expect(queued.map(event => event.request.write)).toEqual([false, true, false]);
    expect(served.map(event => event.request.write)).toEqual([false, true, false]);
    expect(queued[2]!.tick).toBe(served[1]!.tick);
    expect(f.loads[1]!.tick).toBe(served[2]!.tick);
    expect(f.kernel.memorySubsystem.metrics().writeBacks).toBe(1);
    expect(f.kernel.storageSubsystem.saveState().payload.paging?.mappings.map(row => [row.space, row.page]))
      .toEqual([[f.pcb.addressSpaceId, 0], [f.pcb.addressSpaceId, 1]]);
  });
  it('lets a prefetched read skip storage without skipping a dirty write-back', () => {
    const f = fixture([access(0, true), access(1), compute], true, 3, 1);
    until(f.kernel, () => f.thread.programCounter === 1);
    f.kernel.prefetchNextFaults(f.pid, 1);
    until(f.kernel, () => f.thread.programCounter === 2);
    expect(f.events.filter(event => event.type === 'disk.queued').map(event => event.request.write)).toEqual([false, true]);
    expect(f.loads).toHaveLength(2);
    expect(f.kernel.storageSubsystem.saveState().payload.paging?.transfers).toEqual([]);
  });
  it('cancels an exiting waiter while committed media drains without delivering a page', () => {
    const f = fixture([access(0)]); f.kernel.run(2);
    expect(f.kernel.syscall({ name: 'exit', pid: f.pid, args: [0] }).ok).toBe(true);
    f.kernel.run(15);
    expect(f.loads).toEqual([]);
    expect(f.kernel.storageSubsystem.saveState().payload).toMatchObject({ requests: [], physicalOperations: [] });
    expect(f.kernel.storageSubsystem.saveState().payload.paging?.transfers).toEqual([]);
  });
  function shared() {
    const f = fixture([compute]);
    const readers = [0, 1].map(index => f.kernel.spawn({ name: `shared storage reader ${index}`, priority: 10,
      arrival: 0, burst: 100, service: 100, pages: 0 }, { program: instructionProgram([access(0), compute]) }));
    f.kernel.step(); const id = asResourceId('paging storage shared backing');
    f.kernel.installHooks({ security: { rights: () => ['read'] } });
    f.kernel.ipc.createSharedRegion({ id, pages: [asPageId(0)], space: f.pcb.addressSpaceId, attached: [], value: 0 });
    for (const pid of readers) expect(f.kernel.ipc.mmap(pid, id, false)).toEqual({ ok: true, value: 0 });
    f.kernel.blockProcess(f.pid, { kind: 'sleep', untilTick: asTick(100) }); f.kernel.run(2);
    return { ...f, readers };
  }
  it('transfers a coalesced read to the surviving waiter and retains the backing ASID', () => {
    const f = shared(); const [first, second] = f.readers;
    expect(f.kernel.syscall({ name: 'exit', pid: first!, args: [0] }).ok).toBe(true);
    const state = f.kernel.storageSubsystem.saveState().payload;
    expect(state.paging?.transfers).toHaveLength(1);
    expect(state.paging?.transfers[0]).toMatchObject({ pid: second, backing: { space: f.pcb.addressSpaceId, page: 0 } });
    expect(state.requests[0]?.pid).toBe(second); expect(state.physicalOperations[0]?.pid).toBe(second);
    until(f.kernel, () => f.loads.length === 1);
    expect(f.events.filter(event => event.type === 'memory.page_loaded').map(event => event.pid)).toEqual([second]);
    expect(f.events.filter(event => event.type === 'disk.queued')).toHaveLength(1);
  });
  it('fails every coalesced waiter if backing storage fails', () => {
    const f = shared(); f.kernel.storageSubsystem.failDrive('disk0');
    until(f.kernel, () => f.readers.every(pid => ['zombie', 'terminated'].includes(f.kernel.process(pid)!.state)));
    expect(f.readers.map(pid => f.kernel.process(pid)?.terminationReason)).toEqual(['storage_corruption', 'storage_corruption']);
    expect(f.loads).toEqual([]);
    expect(f.kernel.memorySubsystem.pager.saveState().demand.requests).toEqual([]);
    expect(f.kernel.storageSubsystem.saveState().payload.paging?.transfers).toEqual([]);
  });
  it('rejects attachment during a pending default fault before changing either subsystem', () => {
    const f = fixture([access(0)], false); f.kernel.step();
    expect(() => f.kernel.attachPagingStorage()).toThrow('before pending faults');
    expect(f.kernel.storageSubsystem.pagingAttached).toBe(false);
    until(f.kernel, () => f.loads.length === 1);
    expect(f.loads[0]!.tick).toBe(1 + f.kernel.tuning.majorFaultTicks);
  });
  it('cleans up the reserved frame when the configured backing extent is full', () => {
    const f = fixture([access(0), access(1), compute], false, 3, 1);
    f.kernel.attachPagingStorage({ sectorCount: 8 });
    until(f.kernel, () => ['zombie', 'terminated'].includes(f.pcb.state));
    expect(f.pcb.terminationReason).toBe('out_of_memory');
    expect(f.loads).toHaveLength(1);
    expect(f.kernel.memorySubsystem.pager.saveState().demand.requests).toEqual([]);
    expect(f.kernel.memorySubsystem.frameTable.framesOf(f.pcb.addressSpaceId)).toEqual([]);
    expect(f.kernel.storageSubsystem.saveState().payload.paging?.transfers).toEqual([]);
  });
  it('reuses a dead address space backing extent for a later process', () => {
    const f = fixture([access(0), compute], false); f.kernel.attachPagingStorage({ sectorCount: 8 });
    until(f.kernel, () => f.thread.programCounter === 1);
    expect(f.kernel.syscall({ name: 'exit', pid: f.pid, args: [0] }).ok).toBe(true);
    const pid = f.kernel.spawn({ name: 'later backed reader', priority: 10, arrival: f.kernel.tick,
      burst: 100, service: 100, pages: 1 }, { program: instructionProgram([access(0), compute]) });
    const pcb = f.kernel.table.get(pid)!, thread = f.kernel.threads.table.get(pcb.threads[0]!)!;
    until(f.kernel, () => thread.programCounter === 1);
    expect(pcb.terminationReason).toBeNull();
    expect(f.kernel.storageSubsystem.saveState().payload.paging?.mappings).toEqual([
      { space: pcb.addressSpaceId, page: 0, firstSector: 0 },
    ]);
  });
  it('retains cancelled in-flight backing through restore and reclaims it only after media drains', () => {
    const f = fixture([access(0), compute], false); f.kernel.attachPagingStorage({ sectorCount: 8 }); f.kernel.run(2);
    expect(f.kernel.syscall({ name: 'exit', pid: f.pid, args: [0] }).ok).toBe(true);
    const saved = f.kernel.storageSubsystem.saveState(); let tick = f.kernel.tick;
    const restored = new StorageSubsystem({ tick: () => tick, enabled: () => true, emit: () => {},
      rng: createRng(47), isPagingBackingLive: () => false });
    restored.prepareRestore(saved)();
    const next = { requestId: 50, kind: 'read' as const, pid: asPid(50), space: 50 as AddressSpaceId,
      page: asPageId(0), frame: 0 as FrameId, completeAt: asTick(0) };
    expect(() => restored.enqueuePaging(next)).toThrow('backing storage full');
    for (let count = 0; count < 30 && restored.saveState().payload.paging!.transfers.length > 0; count++) {
      tick = asTick(tick + 1); restored.expireTimers(tick); restored.serviceCompletions(tick);
    }
    expect(restored.saveState().payload.paging?.mappings).toEqual([]);
    restored.enqueuePaging(next);
    expect(restored.saveState().payload.paging?.mappings).toEqual([{ space: 50, page: 0, firstSector: 0 }]);
  });
  it('restores the paired init-only envelopes and retains atomic rejection of a bad I/O half', () => {
    const source = createKernel(REFERENCE_CONFIG); source.attachPagingStorage();
    source.storageSubsystem.submit({ kind: 'disk', driveId: 'disk0' }, { kind: 'read', lba: 53 * 256 as BlockId, bytes: 4096 });
    source.run(2); const snapshot = source.snapshot();
    const target = createKernel(REFERENCE_CONFIG); const before = target.snapshot();
    const bad = structuredClone(snapshot) as unknown as { subsystems: { io: { version: number } } }; bad.subsystems.io.version = 99;
    expect(() => target.restore(bad as unknown as KernelSnapshot)).toThrow();
    expect(target.snapshot()).toEqual(before);
    const mismatchedPolicy = structuredClone(snapshot);
    Object.assign(mismatchedPolicy.subsystems!.storage!.payload, { policy: 'sstf' });
    expect(() => target.restore(mismatchedPolicy)).toThrow('storage shared snapshot mismatch');
    expect(target.snapshot()).toEqual(before);
    target.restore(structuredClone(snapshot)); expect(target.snapshot()).toEqual(snapshot);
    expect(target.storageSubsystem.pagingAttached).toBe(true);
    expect(target.run(30)).toEqual(source.run(30)); expect(target.snapshot()).toEqual(source.snapshot());
  });
});

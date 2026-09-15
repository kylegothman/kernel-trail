import { LocalityGenerator, type LocalityOptions } from '@kernel/memory/locality';
import { MemorySubsystem } from '@kernel/memory/MemorySubsystem';
import { createStreamRegistry, createRng } from '@kernel/rng';
import type { EmittableEvent } from '@kernel/EventBus';
import type { BlockReason, PageReplacementId, SubsystemEnvelope } from '@kernel/types';
import type { SuspendedProcess } from '@kernel/memory/demandPaging';
import { describe, expect, it } from 'vitest';
import { createKernel, type KernelImpl, type KernelOptions } from '@kernel/Kernel';
import { instructionProgram, generatedProgram, type Instruction } from '@kernel/process/Program';
import { demandPagingEat, type PagingStorageRequest } from '@kernel/memory/demandPaging';
import { asPageId, asPid, asResourceId, asTick } from '@kernel/types';
import type { FrameId, KernelConfig, KernelEvent, PageId, Pid } from '@kernel/types';
import type { ThreadControlBlock } from '@kernel/process/threads';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';

const compute: Instruction = { kind: 'compute' };
const access = (page: number, write = false): Instruction => ({ kind: 'access', page: asPageId(page), write });
const CONFIG: KernelConfig = {
  ...REFERENCE_CONFIG, enabledSubsystems: ['process', 'scheduler', 'memory', 'vm'],
  replacementPolicy: 'fifo', totalFrames: 3, thrashingThreshold: 1e9,
};
const TUNING: KernelOptions = {
  majorFaultTicks: 3, minorFaultTicks: 1, tlbMissTicks: 1, tlbHitTicks: 1, threadCreateTicks: 0,
  thrashingCriticalDemandRatio: 1e9, thrashingSuspendInterval: 1000,
};

function fixture(instructions: readonly Instruction[], options: {
  frames?: number; pages?: number; service?: number; tuning?: KernelOptions;
} = {}) {
  const kernel = createKernel({ ...CONFIG, totalFrames: options.frames ?? 3 }, { ...TUNING, ...options.tuning });
  const pid = kernel.spawn({ name: 'demand work', priority: 10, arrival: 0,
    burst: options.service ?? 100, service: options.service ?? 100, pages: options.pages ?? 8 },
  { program: instructionProgram(instructions) });
  const pcb = kernel.table.get(pid); const tid = pcb?.threads[0];
  const thread = tid === undefined ? undefined : kernel.threads.table.get(tid);
  if (pcb === undefined || thread === undefined) throw new Error('missing demand fixture process');
  const events: KernelEvent[] = []; kernel.events.onAny(event => events.push(event));
  const storage: PagingStorageRequest[] = []; kernel.memorySubsystem.pager.setStorage({ enqueue: request => storage.push(request) });
  return { kernel, pid, pcb, thread, events, storage, memory: kernel.memorySubsystem };
}
function until(kernel: KernelImpl, predicate: () => boolean, limit = 100): void {
  for (let count = 0; count < limit && !predicate(); count++) kernel.step();
  expect(predicate()).toBe(true);
}
function faultEvents(events: readonly KernelEvent[]) {
  return events.filter(event => event.type === 'memory.page_fault');
}
function loadEvents(events: readonly KernelEvent[]) {
  return events.filter(event => event.type === 'memory.page_loaded');
}
function evictionEvents(events: readonly KernelEvent[]) {
  return events.filter(event => event.type === 'memory.page_evicted');
}
function mappedFrame(f: ReturnType<typeof fixture>, page: number): FrameId {
  const frame = f.memory.pageTables.get(f.pcb.addressSpaceId, asPageId(page))?.frame;
  if (frame === undefined || frame === null) throw new Error('expected resident fixture page');
  return frame;
}
function fork(kernel: KernelImpl, pid: Pid): Pid {
  const result = kernel.syscall({ name: 'fork', pid, args: [] });
  if (!result.ok || typeof result.value !== 'number') throw new Error('fixture fork failed');
  return asPid(result.value);
}
function threadOf(kernel: KernelImpl, pid: Pid): ThreadControlBlock {
  const tid = kernel.process(pid)?.threads[0]; const thread = tid === undefined ? undefined : kernel.threads.table.get(tid);
  if (thread === undefined) throw new Error('missing fixture thread');
  return thread;
}
function retireToPool(f: ReturnType<typeof fixture>, pid: Pid, page: PageId): FrameId {
  const pcb = f.kernel.process(pid); if (pcb === undefined) throw new Error('missing pool owner');
  const pte = f.memory.pageTables.get(pcb.addressSpaceId, page); const frame = pte?.frame;
  if (pte === undefined || frame === undefined || frame === null) throw new Error('missing retained page');
  f.memory.tlb.shootdown(frame); pte.valid = false; pte.frame = null; pte.swapped = true;
  f.memory.frameTable.free(frame, true);
  return frame;
}

describe('demand paging service and restart', () => {
  it('nothing preloaded: forty declared pages hold no frames before the first access', () => {
    const f = fixture([compute, access(39)], { pages: 40 });
    expect(f.memory.pageTables.pageTable(f.pcb.addressSpaceId).size).toBe(40);
    expect(f.memory.frameTable.framesOf(f.pcb.addressSpaceId)).toEqual([]);
    f.kernel.step();
    expect(f.pcb.state).toBe('running'); expect(f.thread.programCounter).toBe(1);
    expect(f.memory.frameTable.framesOf(f.pcb.addressSpaceId)).toEqual([]);
    expect([...f.memory.pageTables.pageTable(f.pcb.addressSpaceId).values()].every(pte => !pte.valid)).toBe(true);
    expect(loadEvents(f.events)).toEqual([]);
    f.kernel.step();
    expect(f.pcb.blockedOn).toEqual({ kind: 'page_fault', page: asPageId(39) });
    expect(f.thread.programCounter).toBe(1); expect(loadEvents(f.events)).toEqual([]);
    until(f.kernel, () => loadEvents(f.events).length === 1);
    expect(mappedFrame(f, 39)).toBe(0);
  });

  it('a final-unit fault preserves PC and useful service until one successful restart', () => {
    const f = fixture([access(0)], { pages: 1, service: 1 });
    f.kernel.step();
    expect(f.thread.programCounter).toBe(0);
    expect(f.pcb).toMatchObject({ state: 'waiting', serviceRemaining: 1, totalCpuUsed: 1 });
    for (let elapsed = 1; elapsed < f.kernel.tuning.majorFaultTicks; elapsed++) {
      f.kernel.step(); expect(f.thread.programCounter).toBe(0);
      expect(f.pcb.serviceRemaining).toBe(1); expect(loadEvents(f.events)).toEqual([]);
    }
    f.kernel.step();
    expect(f.pcb).toMatchObject({ state: 'zombie', serviceRemaining: 0, totalCpuUsed: 2 });
    expect(f.thread.programCounter).toBe(1);
    expect(faultEvents(f.events)).toMatchObject([{ tick: 1, page: 0, major: true }]);
    expect(loadEvents(f.events)).toMatchObject([{ tick: 1 + f.kernel.tuning.majorFaultTicks, page: 0 }]);
    expect(f.events.filter(event => event.type === 'memory.access')).toHaveLength(1);
  });

  it.each([false, true])('protection first rejects a read-only non-COW write, resident=%s', resident => {
    const f = fixture([compute, access(0, true)], { pages: 1 }); f.kernel.step();
    if (resident) expect(f.memory.loadPage(f.pcb.addressSpaceId, asPageId(0))).not.toBeNull();
    const pte = f.memory.pageTables.get(f.pcb.addressSpaceId, asPageId(0));
    if (pte === undefined) throw new Error('missing protected page'); pte.writable = false;
    f.events.length = 0; f.kernel.step();
    expect(f.pcb).toMatchObject({ state: 'zombie', terminationReason: 'protection_fault' });
    expect(f.events.filter(event => event.type === 'security.access_denied')).toMatchObject([{ right: 'write' }]);
    expect(faultEvents(f.events)).toEqual([]); expect(loadEvents(f.events)).toEqual([]);
    expect(f.memory.saveState().vm.payload.demand.requests).toEqual([]);
  });

  function replacement(dirty: boolean) {
    const f = fixture([access(0, dirty), access(1), compute], { frames: 1, pages: 2 });
    until(f.kernel, () => f.thread.programCounter === 1);
    const victim = mappedFrame(f, 0); const cached = f.memory.tlb.entries.filter(entry => entry.valid && entry.frame === victim);
    expect(cached.length).toBeGreaterThan(0);
    f.events.length = 0; f.kernel.step();
    expect(f.thread.programCounter).toBe(1); expect(faultEvents(f.events)).toHaveLength(1);
    expect(evictionEvents(f.events)).toEqual([]); expect(loadEvents(f.events)).toEqual([]);
    f.kernel.step();
    expect(evictionEvents(f.events)).toMatchObject([{ frame: victim, page: 0, dirty }]);
    expect(cached.every(entry => !entry.valid)).toBe(true);
    expect(f.memory.tlb.entries.every(entry => !entry.valid || entry.frame !== victim)).toBe(true);
    expect(f.memory.pageTables.get(f.pcb.addressSpaceId, asPageId(0))).toMatchObject({ valid: false, swapped: true });
    until(f.kernel, () => loadEvents(f.events).length === 1);
    const fault = faultEvents(f.events)[0]; const loaded = loadEvents(f.events)[0];
    if (fault === undefined || loaded === undefined) throw new Error('missing replacement events');
    return { ...f, elapsed: loaded.tick - fault.tick };
  }

  it('service path order is fault, eviction, loaded and a clean victim requires no write-back', () => {
    const f = replacement(false);
    expect(f.events.filter(event => ['memory.page_fault', 'memory.page_evicted', 'memory.page_loaded'].includes(event.type)).map(event => event.type))
      .toEqual(['memory.page_fault', 'memory.page_evicted', 'memory.page_loaded']);
    expect(f.elapsed).toBe(f.kernel.tuning.majorFaultTicks); expect(f.memory.metrics().writeBacks).toBe(0);
    expect(f.storage.map(request => request.kind)).toEqual(['read', 'read']);
    expect(f.memory.metrics()).toMatchObject({ pageFaults: 2, majorFaults: 2, evictions: 1 });
    expect(f.thread.programCounter).toBe(2);
  });

  it('dirty write-back doubles the major service time and TLB shootdown precedes frame reuse', () => {
    const clean = replacement(false); const dirty = replacement(true);
    expect(dirty.elapsed).toBe(2 * clean.elapsed); expect(dirty.elapsed).toBe(2 * dirty.kernel.tuning.majorFaultTicks);
    expect(dirty.memory.metrics().writeBacks).toBe(1);
    expect(dirty.storage.map(request => request.kind)).toEqual(['read', 'write', 'read']);
    expect(evictionEvents(dirty.events)).toMatchObject([{ dirty: true }]);
  });

  it.each(['local', 'global'] as const)('%s replacement respects address-space candidate filtering', scope => {
    const f = fixture([compute], { frames: 1, pages: 1 });
    const peer = f.kernel.spawn({ name: 'replacement requester', priority: 10, arrival: 0, burst: 100, service: 100, pages: 1 },
      { program: instructionProgram([access(0)]) });
    f.kernel.step(); const ownerFrame = f.memory.loadPage(f.pcb.addressSpaceId, asPageId(0));
    if (ownerFrame === null) throw new Error('failed scope fixture load');
    f.memory.setFramePolicy('standard', 'equal', scope); f.events.length = 0;
    f.kernel.blockProcess(f.pid, { kind: 'sleep', untilTick: asTick(100) });
    if (scope === 'local') {
      until(f.kernel, () => f.kernel.process(peer)?.terminationReason === 'out_of_memory');
      expect(evictionEvents(f.events)).toEqual([]);
      expect(f.memory.frameTable.frames[ownerFrame]?.owner).toBe(f.pcb.addressSpaceId);
    } else {
      until(f.kernel, () => loadEvents(f.events).some(event => event.pid === peer));
      expect(evictionEvents(f.events)).toMatchObject([{ frame: ownerFrame, page: 0, dirty: false }]);
      expect(f.kernel.process(peer)?.terminationReason).toBeNull();
      expect(f.memory.frameTable.frames[ownerFrame]?.owner).toBe(f.kernel.process(peer)?.addressSpaceId);
    }
  });

  it('pinned exhaustion reports no_space and terminates the requester without evicting shared capacity', () => {
    const f = fixture([compute], { frames: 1, pages: 1 });
    const peer = f.kernel.spawn({ name: 'pinned requester', priority: 10, arrival: 0, burst: 100, service: 100, pages: 1 },
      { program: instructionProgram([access(0)]) });
    f.kernel.step(); const pinned = f.memory.loadPage(f.pcb.addressSpaceId, asPageId(0), true);
    if (pinned === null) throw new Error('failed pinned fixture load');
    f.memory.setFramePolicy('standard', 'equal', 'global');
    f.kernel.blockProcess(f.pid, { kind: 'sleep', untilTick: asTick(100) });
    until(f.kernel, () => f.kernel.process(peer)?.terminationReason === 'out_of_memory');
    expect(f.events.filter(event => event.type === 'memory.allocation_failed')).toMatchObject([{ pid: peer, reason: 'no_space' }]);
    expect(evictionEvents(f.events)).toEqual([]);
    expect(f.memory.frameTable.frames[pinned]).toMatchObject({ owner: f.pcb.addressSpaceId, page: 0, pinned: true });
    expect(f.memory.pageTables.get(f.pcb.addressSpaceId, asPageId(0))).toMatchObject({ frame: pinned, valid: true });
  });
});

describe('three minor-fault sources', () => {
  it('a retained free-pool page is reclaimed without a disk request and pays minorFaultTicks', () => {
    const f = fixture([compute, access(0)], { pages: 1, tuning: { minorFaultTicks: 3 } }); f.kernel.step();
    const frame = f.memory.loadPage(f.pcb.addressSpaceId, asPageId(0));
    if (frame === null) throw new Error('failed pool fixture load');
    const tag = f.memory.contentTag(frame); retireToPool(f, f.pid, asPageId(0));
    expect(f.memory.frameTable.freePool).toContain(frame); f.events.length = 0;
    for (let cost = 1; cost <= f.kernel.tuning.minorFaultTicks; cost++) {
      f.kernel.step();
      expect(f.thread.programCounter).toBe(cost === f.kernel.tuning.minorFaultTicks ? 2 : 1);
      expect(f.pcb.state).toBe('running');
      expect(f.memory.saveState().vm.payload.demand.requests).toEqual([]);
    }
    expect(faultEvents(f.events)).toMatchObject([{ major: false, page: 0 }]); expect(loadEvents(f.events)).toHaveLength(1);
    expect(mappedFrame(f, 0)).toBe(frame); expect(f.memory.contentTag(frame)).toBe(tag);
    expect(f.memory.metrics()).toMatchObject({ pageFaults: 1, majorFaults: 0, writeBacks: 0 }); expect(f.storage).toEqual([]);
  });

  it('a resident shared-region first touch reports one minor and preserves the backing frame and rights', () => {
    const f = fixture([compute], { pages: 1 });
    const peer = f.kernel.spawn({ name: 'shared reader', priority: 10, arrival: 0, burst: 100, service: 100, pages: 0 },
      { program: instructionProgram([access(0), access(0)]) });
    f.kernel.step(); const backing = f.memory.loadPage(f.pcb.addressSpaceId, asPageId(0));
    if (backing === null) throw new Error('failed shared fixture load');
    const id = asResourceId('resident backing');
    f.kernel.installHooks({ security: { rights: () => ['read'] } });
    f.kernel.ipc.createSharedRegion({ id, pages: [asPageId(0)], space: f.pcb.addressSpaceId, attached: [], value: 0 });
    expect(f.kernel.ipc.mmap(peer, id, false)).toEqual({ ok: true, value: 0 });
    const pcb = f.kernel.process(peer); if (pcb === undefined) throw new Error('missing shared reader');
    expect(f.memory.pageTables.get(pcb.addressSpaceId, asPageId(0))).toMatchObject({ frame: backing, valid: true, writable: false });
    expect(f.memory.frameTable.frames[backing]?.pinned).toBe(true);
    f.events.length = 0; f.kernel.blockProcess(f.pid, { kind: 'sleep', untilTick: asTick(100) });
    until(f.kernel, () => threadOf(f.kernel, peer).programCounter === 2);
    expect(faultEvents(f.events)).toMatchObject([{ pid: peer, page: 0, major: false }]);
    expect(loadEvents(f.events)).toMatchObject([{ pid: peer, page: 0, frame: backing }]);
    expect(f.events.filter(event => 'pid' in event && event.pid === peer
      && ['tlb.miss', 'memory.page_fault', 'memory.page_loaded', 'memory.access'].includes(event.type)).slice(0, 4).map(event => event.type))
      .toEqual(['tlb.miss', 'memory.page_fault', 'memory.page_loaded', 'memory.access']);
    expect(evictionEvents(f.events)).toEqual([]); expect(f.memory.metrics().majorFaults).toBe(0); expect(f.storage).toEqual([]);
    expect(f.memory.saveState().vm.payload.demand.requests).toEqual([]);
    expect(f.memory.frameTable.frames[backing]).toMatchObject({ owner: f.pcb.addressSpaceId, pinned: true });
  });

  it('a nonresident shared alias loads its backing page once and pins the shared frame', () => {
    const f = fixture([compute], { pages: 1 });
    const peer = f.kernel.spawn({ name: 'nonresident shared reader', priority: 10, arrival: 0, burst: 100, service: 100, pages: 0 },
      { program: instructionProgram([access(0)]) });
    f.kernel.step(); const id = asResourceId('nonresident backing');
    f.kernel.installHooks({ security: { rights: () => ['read'] } });
    f.kernel.ipc.createSharedRegion({ id, pages: [asPageId(0)], space: f.pcb.addressSpaceId, attached: [], value: 0 });
    expect(f.kernel.ipc.mmap(peer, id, false)).toEqual({ ok: true, value: 0 });
    const pcb = f.kernel.process(peer); if (pcb === undefined) throw new Error('missing shared reader');
    expect(f.memory.pageTables.get(pcb.addressSpaceId, asPageId(0))?.valid).toBe(false);
    f.kernel.blockProcess(f.pid, { kind: 'sleep', untilTick: asTick(100) });
    until(f.kernel, () => threadOf(f.kernel, peer).programCounter === 1);
    const backing = mappedFrame(f, 0);
    expect(f.memory.pageTables.get(pcb.addressSpaceId, asPageId(0))).toMatchObject({ valid: true, frame: backing, writable: false });
    expect(f.memory.frameTable.frames[backing]).toMatchObject({ owner: f.pcb.addressSpaceId, page: 0, pinned: true });
    expect(faultEvents(f.events)).toMatchObject([{ pid: peer, major: true }]);
    expect(loadEvents(f.events)).toMatchObject([{ pid: peer, frame: backing }]);
    expect(f.storage.map(request => request.kind)).toEqual(['read']);
  });

  it('concurrent faults on one shared backing page share one read and complete both aliases', () => {
    const f = fixture([compute], { pages: 1 });
    const readers = [0, 1].map(index => f.kernel.spawn({ name: `shared reader ${index}`, priority: 10, arrival: 0,
      burst: 100, service: 100, pages: 0 }, { program: instructionProgram([access(0)]) }));
    const [first, second] = readers;
    if (first === undefined || second === undefined) throw new Error('missing shared readers');
    f.kernel.step(); const id = asResourceId('coalesced shared backing');
    f.kernel.installHooks({ security: { rights: () => ['read'] } });
    f.kernel.ipc.createSharedRegion({ id, pages: [asPageId(0)], space: f.pcb.addressSpaceId, attached: [], value: 0 });
    for (const pid of readers) expect(f.kernel.ipc.mmap(pid, id, false)).toEqual({ ok: true, value: 0 });
    f.kernel.blockProcess(f.pid, { kind: 'sleep', untilTick: asTick(100) });
    f.kernel.step(); f.kernel.step();
    expect(readers.map(pid => f.kernel.process(pid)?.state)).toEqual(['waiting', 'waiting']);
    expect(faultEvents(f.events).map(event => ({ pid: event.pid, major: event.major })))
      .toEqual([{ pid: first, major: true }, { pid: second, major: true }]);
    const pending = f.memory.saveState().vm.payload.demand;
    expect(pending.requests).toHaveLength(1); expect(pending.references).toHaveLength(2);
    expect(pending.references.map(reference => reference.requestId)).toEqual([pending.requests[0]?.id, pending.requests[0]?.id]);
    expect(f.storage.map(request => request.kind)).toEqual(['read']);
    until(f.kernel, () => loadEvents(f.events).length === 2);
    const backing = mappedFrame(f, 0);
    expect(loadEvents(f.events).map(event => ({ pid: event.pid, frame: event.frame })))
      .toEqual([{ pid: first, frame: backing }, { pid: second, frame: backing }]);
    expect(new Set(loadEvents(f.events).map(event => event.tick)).size).toBe(1);
    for (const pid of readers) {
      const pcb = f.kernel.process(pid); if (pcb === undefined) throw new Error('missing shared reader');
      expect(f.memory.pageTables.get(pcb.addressSpaceId, asPageId(0))).toMatchObject({ frame: backing, valid: true });
    }
    expect(threadOf(f.kernel, first).programCounter).toBe(1);
    f.kernel.blockProcess(first, { kind: 'sleep', untilTick: asTick(100) });
    until(f.kernel, () => threadOf(f.kernel, second).programCounter === 1);
    expect(faultEvents(f.events)).toHaveLength(2); expect(loadEvents(f.events)).toHaveLength(2);
    expect(f.storage).toHaveLength(1); expect(f.memory.frameTable.frames.filter(frame => frame.owner !== null)).toHaveLength(1);
    expect(f.memory.saveState().vm.payload.demand.requests).toEqual([]);
  });

  it('VM-COW-1 keeps lifecycle ownership of one minor/load pair and one private copy', () => {
    const f = fixture([compute, access(0, true)], { pages: 1 }); f.kernel.step();
    const source = f.memory.loadPage(f.pcb.addressSpaceId, asPageId(0));
    if (source === null) throw new Error('failed COW fixture load');
    const child = fork(f.kernel, f.pid); const childPcb = f.kernel.process(child);
    if (childPcb === undefined) throw new Error('missing child');
    expect(f.kernel.lifecycle.cowRefCount.get(source)).toBe(2); f.events.length = 0;
    f.kernel.blockProcess(f.pid, { kind: 'sleep', untilTick: asTick(100) });
    until(f.kernel, () => threadOf(f.kernel, child).programCounter === 2);
    const copy = f.memory.pageTables.get(childPcb.addressSpaceId, asPageId(0))?.frame;
    expect(copy).not.toBe(source); expect(copy).not.toBeNull();
    expect(faultEvents(f.events)).toMatchObject([{ pid: child, page: 0, major: false }]);
    expect(loadEvents(f.events)).toMatchObject([{ pid: child, page: 0, frame: copy }]);
    expect(evictionEvents(f.events)).toEqual([]); expect(f.kernel.lifecycle.cowRefCount.get(source)).toBe(1);
    expect(f.memory.metrics()).toMatchObject({ pageFaults: 1, majorFaults: 0 }); expect(f.storage).toEqual([]);
    if (copy === undefined || copy === null) throw new Error('missing COW copy');
    expect(f.memory.contentTag(copy)).toBe(f.memory.contentTag(source));
  });

  it('COW waits for dirty replacement capacity without emitting a major or touching its protected copy source', () => {
    const f = fixture([compute, access(0, true)], { pages: 2, frames: 2 }); f.kernel.step();
    const source = f.memory.loadPage(f.pcb.addressSpaceId, asPageId(0));
    if (source === null) throw new Error('failed COW source load');
    const child = fork(f.kernel, f.pid); const childPcb = f.kernel.process(child);
    if (childPcb === undefined) throw new Error('missing child');
    const victim = f.memory.loadPage(childPcb.addressSpaceId, asPageId(1));
    const victimPage = f.memory.pageTables.get(childPcb.addressSpaceId, asPageId(1));
    if (victim === null || victimPage === undefined) throw new Error('failed dirty victim load');
    victimPage.dirty = true; const tag = f.memory.contentTag(source); f.events.length = 0;
    f.kernel.blockProcess(f.pid, { kind: 'sleep', untilTick: asTick(100) }); f.kernel.step();
    expect(faultEvents(f.events)).toMatchObject([{ pid: child, page: 0, major: false }]);
    expect(loadEvents(f.events)).toEqual([]); expect(evictionEvents(f.events)).toEqual([]);
    expect(threadOf(f.kernel, child).programCounter).toBe(1); expect(f.kernel.lifecycle.cowRefCount.get(source)).toBe(2);
    until(f.kernel, () => loadEvents(f.events).length === 1);
    expect(evictionEvents(f.events)).toMatchObject([{ frame: victim, page: 1, dirty: true }]);
    expect(loadEvents(f.events)).toMatchObject([{ pid: child, page: 0, frame: victim }]);
    expect(f.events.filter(event => ['memory.page_fault', 'memory.page_evicted', 'memory.page_loaded'].includes(event.type)).map(event => event.type))
      .toEqual(['memory.page_fault', 'memory.page_evicted', 'memory.page_loaded']);
    const fault = faultEvents(f.events)[0]; const load = loadEvents(f.events)[0];
    if (fault === undefined || load === undefined) throw new Error('missing COW service events');
    expect(load.tick - fault.tick).toBe(f.kernel.tuning.majorFaultTicks);
    expect(f.memory.contentTag(victim)).toBe(tag); expect(f.memory.contentTag(source)).toBe(tag);
    expect(f.kernel.lifecycle.cowRefCount.get(source)).toBe(1);
    expect(f.memory.metrics()).toMatchObject({ pageFaults: 1, majorFaults: 0, evictions: 1, writeBacks: 1 });
    expect(f.storage.map(request => request.kind)).toEqual(['write']);
    until(f.kernel, () => threadOf(f.kernel, child).programCounter === 2);
  });

  it('eviction clears lifecycle COW metadata before physical-frame reuse and a later fork', () => {
    const f = fixture([compute], { frames: 1, pages: 1 }); f.kernel.step();
    const source = f.memory.loadPage(f.pcb.addressSpaceId, asPageId(0));
    if (source === null) throw new Error('failed original COW load');
    const oldChild = fork(f.kernel, f.pid); const childPcb = f.kernel.process(oldChild);
    if (childPcb === undefined) throw new Error('missing original child');
    const requester = f.kernel.spawn({ name: 'reusing process', priority: 10, arrival: f.kernel.tick, burst: 100, service: 100, pages: 1 },
      { program: instructionProgram([access(0)]) });
    expect(f.kernel.lifecycle.cowRefCount.get(source)).toBe(2);
    f.memory.setFramePolicy('standard', 'equal', 'global');
    f.kernel.blockProcess(f.pid, { kind: 'sleep', untilTick: asTick(100) }); f.kernel.step();
    f.kernel.blockProcess(oldChild, { kind: 'sleep', untilTick: asTick(100) });
    until(f.kernel, () => threadOf(f.kernel, requester).programCounter === 1);
    expect(f.memory.pageTables.get(f.pcb.addressSpaceId, asPageId(0))?.valid).toBe(false);
    expect(f.memory.pageTables.get(childPcb.addressSpaceId, asPageId(0))?.valid).toBe(false);
    expect(f.kernel.lifecycle.cowRefCount.has(source)).toBe(false);
    const newOwner = f.kernel.process(requester); if (newOwner === undefined) throw new Error('missing replacement owner');
    expect(f.memory.pageTables.get(newOwner.addressSpaceId, asPageId(0))?.frame).toBe(source);
    const newChild = fork(f.kernel, requester); const newChildPcb = f.kernel.process(newChild);
    if (newChildPcb === undefined) throw new Error('missing replacement child');
    expect(f.kernel.lifecycle.cowRefCount.get(source)).toBe(2);
    expect(f.memory.pageTables.get(newChildPcb.addressSpaceId, asPageId(0))).toMatchObject({ valid: true, frame: source, writable: false });
  });

  it('major versus total remains distinct in a run containing a major, COW and retained reclaim', () => {
    const f = fixture([access(0), access(0, true)], { pages: 1, frames: 3 });
    until(f.kernel, () => f.thread.programCounter === 1);
    const child = fork(f.kernel, f.pid); f.kernel.blockProcess(f.pid, { kind: 'sleep', untilTick: asTick(100) });
    until(f.kernel, () => threadOf(f.kernel, child).programCounter === 2);
    retireToPool(f, child, asPageId(0));
    expect(f.memory.access(child, asPageId(0), false).hit).toBe(true);
    expect(f.memory.metrics()).toMatchObject({ pageFaults: 3, majorFaults: 1 });
    expect(faultEvents(f.events).map(event => event.major)).toEqual([true, false, false]);
    expect(f.memory.metrics().majorFaults).toBeLessThan(f.memory.metrics().pageFaults);
  });
});

describe('textbook demand-paging effective access time', () => {
  it.each([
    [0, '200.0000'], [1e-6, '207.9998'], [1 / 399990, '220.0000'],
    [1e-5, '279.9980'], [1e-4, '999.9800'], [1e-3, '8199.8000'],
  ])('VM-EAT-1 uses p=%s and produces %s ns', (probability, expected) => {
    expect(demandPagingEat(Number(probability)).toFixed(4)).toBe(expected);
  });
  it('VM-EAT-2 reaches ten percent degradation at exactly one fault per 399990 accesses', () => {
    expect(Math.abs(demandPagingEat(1 / 399990) - 200 * 1.1)).toBeLessThan(1e-9);
  });
});


describe('aggregate VM persistence', () => {

  const REFERENCES = [0, 1, 2, 3, 4, 0, 5, 1, 6, 2, 7, 3, 0, 6, 1, 5, 2, 7, 4, 3, 0, 1, 2, 3];
  const CONFIG = {
    ...REFERENCE_CONFIG, enabledSubsystems: ['process', 'scheduler', 'memory', 'vm'] as const,
    totalFrames: 3, pageSize: 64, tlbEntries: 3, replacementPolicy: 'random' as PageReplacementId, thrashingThreshold: 1e9,
  };
  const TUNING: KernelOptions = {
    majorFaultTicks: 4, minorFaultTicks: 2, tlbHitTicks: 1, tlbMissTicks: 2,
    localitySize: 2, workingSetWindow: 10, lfuAging: 7, degreeOfMultiprogramming: 4,
    threadCreateTicks: 0, thrashingCriticalDemandRatio: 1e9,
  };

  /** VM continuation requires the caller's compatible process/workload and RNG channels. */
  function component(policy: PageReplacementId = 'random', count = 1, frames = 3) {
    const config = { ...CONFIG, replacementPolicy: policy, totalFrames: frames };
    const kernel = createKernel(config, TUNING);
    const pids = Array.from({ length: count }, (_, index) => kernel.spawn({
      name: `VM restore process ${index}`, priority: 10, arrival: 0, service: 1000, burst: 1000, pages: 8,
      referenceString: REFERENCES,
    }));
    const processes = pids.map(pid => {
      const pcb = kernel.table.get(pid);
      if (pcb === undefined) throw new Error('missing VM restore process');
      pcb.state = 'ready'; pcb.readySince = asTick(0);
      return pcb;
    });
    let tick = asTick(0);
    const cursors = new Map(pids.map(pid => [pid, 0]));
    const registry = createStreamRegistry(config.seed);
    const events: { tick: number; event: EmittableEvent }[] = [];
    const storage: PagingStorageRequest[] = [];
    const resumed: SuspendedProcess[] = [];
    let memory: MemorySubsystem;
    const emit = (event: EmittableEvent) => { events.push({ tick, event }); memory.observeEvent(event); };
    memory = new MemorySubsystem(config, {
      rng: registry.stream('vm'), tick: () => tick, process: pid => kernel.process(pid), processes: () => kernel.processes,
      pageTables: kernel.pageTables, emit, accessKey: pid => `${pid}:${kernel.process(pid)?.threads[0]}`,
      futureReferences: pid => REFERENCES.slice((cursors.get(pid) ?? 0) + 1).map(asPageId),
      terminate: (pid, reason) => {
        const pcb = kernel.table.get(pid); if (pcb === undefined) throw new Error('missing terminating process');
        pcb.state = 'zombie'; pcb.terminationReason = reason;
      },
      suspend: (pid, suspendedAt, untilTick) => {
        const pcb = kernel.table.get(pid);
        if (pcb === undefined || !['ready', 'running', 'waiting'].includes(pcb.state)) throw new Error('invalid component suspension');
        const threads = pcb.threads.map(tid => kernel.threads.table.get(tid)!);
        const saved: SuspendedProcess = {
          pid, suspendedAt, untilTick, previousState: pcb.state as 'ready' | 'running' | 'waiting',
          previousBlockedOn: pcb.blockedOn === null ? null : { ...pcb.blockedOn },
          threads: threads.map(thread => ({ tid: thread.tid, state: thread.state,
            blockedOn: thread.blockedOn === null ? null : { ...thread.blockedOn } })),
        };
        const reason: BlockReason = { kind: 'sleep', untilTick };
        pcb.state = 'waiting'; pcb.blockedOn = reason;
        for (const thread of threads) if (thread.state !== 'terminated') { thread.state = 'waiting'; thread.blockedOn = reason; }
        return saved;
      },
      resume: saved => {
        resumed.push(saved);
        const pcb = kernel.table.get(saved.pid)!;
        pcb.state = saved.previousState === 'running' ? 'ready' : saved.previousState;
        pcb.blockedOn = saved.previousBlockedOn === null ? null : { ...saved.previousBlockedOn };
        for (const prior of saved.threads) {
          const thread = kernel.threads.table.get(prior.tid)!;
          thread.state = prior.state === 'running' ? 'ready' : prior.state;
          thread.blockedOn = prior.blockedOn === null ? null : { ...prior.blockedOn };
        }
      },
    }, { tuning: TUNING, freePoolRetain: 2 });
    memory.pager.setStorage({ enqueue: request => storage.push({ ...request }) });
    for (const process of processes) memory.admit(process);

    const advance = (execute = true) => {
      tick = asTick(tick + 1); memory.expireTimers(tick);
      if (execute) for (const pcb of processes) {
        if (memory.isSuspended(pcb.pid) || ['new', 'zombie', 'terminated'].includes(pcb.state)) continue;
        if (pcb.blockedOn !== null) {
          if (pcb.blockedOn.kind !== 'page_fault' || !memory.isSatisfied(pcb.pid, pcb.blockedOn)) continue;
          pcb.blockedOn = null; pcb.state = 'ready';
        }
        const index = cursors.get(pcb.pid)!; const page = REFERENCES[index];
        if (page === undefined) continue;
        const result = memory.access(pcb.pid, asPageId(page), index < 8 || index % 3 === 0);
        if (!result.hit) {
          emit({ type: 'memory.page_fault', pid: pcb.pid, page: asPageId(page), major: true });
          pcb.state = 'waiting'; pcb.blockedOn = { kind: 'page_fault', page: asPageId(page) };
        } else if (memory.accessComplete(pcb.pid)) cursors.set(pcb.pid, index + 1);
      }
      memory.metrics();
    };
    const world = () => ({
      tick, cursors: [...cursors], rng: registry.save(),
      processes: processes.map(pcb => ({ pid: pcb.pid, state: pcb.state, blockedOn: pcb.blockedOn === null ? null : { ...pcb.blockedOn } })),
      threads: processes.flatMap(pcb => pcb.threads.map(tid => ({ ...kernel.threads.table.get(tid)! }))),
    });
    const restoreWorld = (saved: ReturnType<typeof world>) => {
      tick = saved.tick; cursors.clear(); for (const [pid, cursor] of saved.cursors) cursors.set(pid, cursor);
      registry.restore(saved.rng);
      for (const prior of saved.processes) {
        const pcb = kernel.table.get(prior.pid)!; pcb.state = prior.state;
        pcb.blockedOn = prior.blockedOn === null ? null : { ...prior.blockedOn };
      }
      for (const prior of saved.threads) Object.assign(kernel.threads.table.get(prior.tid)!, prior);
    };
    return { kernel, memory, pids, processes, registry, events, storage, resumed, cursors, advance, world, restoreWorld,
      tick: () => tick, complete: () => [...cursors.values()].every(cursor => cursor === REFERENCES.length) };
  }
  type Component = ReturnType<typeof component>;
  function until(test: Component, condition: () => boolean, limit = 1000): void {
    for (let count = 0; count < limit && !condition(); count += 1) test.advance();
    expect(condition()).toBe(true);
  }
  function restored(source: Component, policy: PageReplacementId = 'random', count = 1, frames = 3) {
    const state = JSON.parse(JSON.stringify(source.memory.saveState())) as ReturnType<MemorySubsystem['saveState']>;
    const target = component(policy, count, frames);
    target.restoreWorld(JSON.parse(JSON.stringify(source.world())));
    const rng = target.registry.save(); const before = target.memory.saveState();
    const commit = target.memory.prepareRestore(state.memory, state.vm);
    expect(target.memory.saveState()).toEqual(before); expect(target.registry.save()).toEqual(rng);
    expect(target.events).toEqual([]); commit();
    expect(target.memory.saveState()).toEqual(state); expect(target.registry.save()).toEqual(rng);
    source.events.length = 0; source.storage.length = 0;
    return target;
  }
  function continueTogether(source: Component, target: Component) {
    for (let ticks = 0; ticks < 1000 && !source.complete(); ticks += 1) {
      source.advance(); target.advance();
      expect(target.memory.saveState()).toEqual(source.memory.saveState());
      expect(target.world()).toEqual(source.world());
    }
    expect(source.complete()).toBe(true); expect(target.complete()).toBe(true);
    expect(target.events).toEqual(source.events); expect(target.storage).toEqual(source.storage);
    expect(target.memory.metrics()).toEqual(source.memory.metrics());
  }

  describe('VM v2 aggregate continuation', () => {
    it.each(['queued', 'read', 'write_back'] as const)('resumes a %s major request with the same deadlines, events and shared RNG draws', phase => {
      const source = component();
      until(source, () => source.memory.saveState().vm.payload.demand.requests.some(request => request.phase === phase));
      const snapshot = source.memory.saveState();
      expect(snapshot.vm.version).toBe(2); expect(snapshot.memory.version).toBe(1);
      const target = restored(source);
      continueTogether(source, target);
      expect(source.memory.metrics().majorFaults).toBeGreaterThan(3);
      expect(source.memory.metrics().evictions).toBeGreaterThan(0);
      expect(source.memory.pager.workingSets.noiseDraws).toBeGreaterThan(0);
    });

    it.each(['fifo', 'lru', 'clock', 'optimal', 'lfu', 'random'] as const)('preserves %s replacement state through a dirty write-back restore', policy => {
      const source = component(policy);
      until(source, () => source.memory.saveState().vm.payload.demand.requests.some(request => request.phase === 'write_back'));
      const target = restored(source, policy);
      continueTogether(source, target);
    });

    it('restores a loaded reference with pending TLB cost without counting the reference or load again', () => {
      const source = component();
      until(source, () => source.memory.saveState().vm.payload.pending.length > 0);
      const saved = source.memory.saveState();
      expect(saved.vm.payload.demand.requests).toEqual([]);
      expect(saved.vm.payload.demand.references).toHaveLength(1);
      const target = restored(source);
      source.advance(); target.advance();
      expect(target.memory.saveState()).toEqual(source.memory.saveState());
      expect(target.cursors.get(target.pids[0]!)).toBe(1);
      expect(target.memory.metrics().pageFaults).toBe(saved.vm.payload.counters.pageFaults);
      expect(target.events.filter(record => record.event.type === 'memory.page_loaded')).toEqual([]);
      expect(target.memory.pager.workingSets.trueSize(target.pids[0]!)).toBe(1);
    });

    it('persists the logical remap and prefetch credits and applies remapping to OPT lookahead', () => {
      const source = component('optimal');
      until(source, () => source.cursors.get(source.pids[0]!) === 3);
      source.memory.prefetchNextFaults(source.pids[0]!, 5);
      source.memory.remapOptimalLocality(source.pids[0]!);
      expect(source.memory.pager.workingSets.trueSize(source.pids[0]!)).toBe(0);
      const controls = source.memory.saveState().vm.payload.controls;
      expect(controls.prefetchCredits).toEqual([[source.pids[0], 5]]);
      expect(controls.localityRemaps[0]?.pages).toHaveLength(8);
      expect(new Set(source.memory.pager.context(source.pids[0]).futureReferences).size).toBeLessThanOrEqual(2);
      const target = restored(source, 'optimal');
      continueTogether(source, target);
      expect(source.memory.pager.workingSets.trueSize(source.pids[0]!)).toBeLessThanOrEqual(2);
    });

    it('counts exactly 100 noise draws per active process per 1000 ticks and repeated metrics reads consume none', () => {
      const source = component('random', 2, 16);
      source.memory.setWorkingSetPrecision(true);
      for (let tick = 1; tick <= 500; tick += 1) { source.advance(false); source.memory.metrics(); source.memory.metrics(); }
      expect(source.memory.pager.workingSets.noiseDraws).toBe(100);
      const target = restored(source, 'random', 2, 16);
      for (let tick = 501; tick <= 1000; tick += 1) {
        // Replacement previews and the noise share root/vm; interleaving is caller ordered.
        if (tick % 17 === 0) expect(target.registry.stream('vm').pick([0, 2, 5])).toBe(source.registry.stream('vm').pick([0, 2, 5]));
        source.advance(false); target.advance(false);
        source.memory.metrics(); target.memory.metrics();
        expect(target.memory.saveState()).toEqual(source.memory.saveState());
      }
      expect(source.memory.pager.workingSets.noiseDraws).toBe(200);
      expect(target.registry.save()).toEqual(source.registry.save());
      expect(source.memory.saveState().vm.payload.workingSets.processes.every(process => process.noise >= -1 && process.noise <= 1)).toBe(true);
    });

    it('rejects corrupt contributions atomically without replacing held views or consuming RNG', () => {
      const source = component();
      until(source, () => source.memory.saveState().vm.payload.demand.requests.some(request => request.phase === 'write_back'));
      const saved = source.memory.saveState();
      const target = restored(source);
      const before = target.memory.saveState(); const random = target.registry.save();
      const frames = target.memory.frameTable.frames; const tlb = target.memory.tlb.entries;
      const pages = target.memory.pageTables.pageTable(target.processes[0]!.addressSpaceId);
      const invalid: { memory: SubsystemEnvelope; vm: SubsystemEnvelope }[] = [
        { memory: saved.memory, vm: { ...saved.vm, version: 1 } },
        { memory: saved.memory, vm: { ...saved.vm, payload: { ...saved.vm.payload,
          settings: { ...saved.vm.payload.settings, majorFaultTicks: saved.vm.payload.settings.majorFaultTicks + 1 } } } },
        { memory: saved.memory, vm: { ...saved.vm, payload: { ...saved.vm.payload,
          counters: { ...saved.vm.payload.counters, majorFaults: saved.vm.payload.counters.pageFaults + 1 } } } },
        { memory: saved.memory, vm: { ...saved.vm, payload: { ...saved.vm.payload,
          workingSets: { ...saved.vm.payload.workingSets, processes: [...saved.vm.payload.workingSets.processes, ...saved.vm.payload.workingSets.processes] } } } },
        { memory: saved.memory, vm: { ...saved.vm, payload: { ...saved.vm.payload,
          thrashing: { ...saved.vm.payload.thrashing, degreeOfMultiprogramming: 0 } } } },
        { memory: saved.memory, vm: { ...saved.vm, payload: { ...saved.vm.payload,
          demand: { ...saved.vm.payload.demand, nextRequestId: 0 } } } },
        { memory: saved.memory, vm: { ...saved.vm, payload: { ...saved.vm.payload,
          counters: { ...saved.vm.payload.counters, lastMetricsTick: asTick(source.tick() + 1) } } } },
        { memory: { ...saved.memory, payload: { ...saved.memory.payload, nextContent: 0 } }, vm: saved.vm },
      ];
      for (const state of invalid) {
        expect(() => target.memory.prepareRestore(state.memory, state.vm)).toThrow();
        expect(target.memory.saveState()).toEqual(before); expect(target.registry.save()).toEqual(random);
        expect(target.memory.frameTable.frames).toBe(frames); expect(target.memory.tlb.entries).toBe(tlb);
        expect(target.memory.pageTables.pageTable(target.processes[0]!.addressSpaceId)).toBe(pages);
        expect(target.events).toEqual([]);
      }
    });
  });

  describe('whole-process suspension across VM restore', () => {
    it('retains suspended membership and original waits while valid demand falls and recovery resumes lowest PID first', () => {
      const source = component('fifo', 3, 16);
      const [low, middle, high] = source.processes;
      if (low === undefined || middle === undefined || high === undefined) throw new Error('missing suspension processes');
      const wait: BlockReason = { kind: 'sleep', untilTick: asTick(1000) };
      low.state = 'waiting'; low.blockedOn = wait;
      const lowThread = source.kernel.threads.table.get(low.threads[0]!)!;
      lowThread.state = 'waiting'; lowThread.blockedOn = wait;
      for (const [pcb, size] of [[low, 2], [middle, 3], [high, 1]] as const) {
        for (let page = 0; page < size; page += 1) source.memory.pager.workingSets.push(pcb.pid, asPageId(page));
      }
      source.memory.setDegreeOfMultiprogramming(1);
      expect(source.memory.pager.control.suspendedRecords.map(record => record.pid)).toEqual([low.pid, middle.pid]);
      expect([...source.memory.pager.input().workingSets]).toEqual([[high.pid, 1]]);
      expect(source.memory.admissionAllowed()).toBe(false);
      const target = restored(source, 'fifo', 3, 16);
      for (let tick = 1; tick <= 125; tick += 1) { source.advance(false); target.advance(false); }
      expect(target.resumed).toEqual([]);
      expect(target.memory.isSuspended(low.pid)).toBe(true);
      expect(target.memory.pager.workingSets.noiseDraws).toBe(12);
      source.memory.setDegreeOfMultiprogramming(3); target.memory.setDegreeOfMultiprogramming(3);
      source.advance(false); target.advance(false);
      expect(target.resumed.map(record => record.pid)).toEqual([low.pid]);
      expect(target.processes[0]).toMatchObject({ state: 'waiting', blockedOn: wait });
      expect(target.kernel.threads.table.get(low.threads[0]!)?.blockedOn).toEqual(wait);
      for (let tick = 127; tick <= 176; tick += 1) { source.advance(false); target.advance(false); }
      expect(target.resumed.map(record => record.pid)).toEqual([low.pid, middle.pid]);
      expect(target.memory.saveState()).toEqual(source.memory.saveState()); expect(target.world()).toEqual(source.world());
    });

    it('uses the Kernel memory-suspension edge, preserves expired suspension gates through restore, and keeps an original sleep', () => {
      const kernel = createKernel({ ...CONFIG, totalFrames: 64, replacementPolicy: 'fifo' }, { ...TUNING, workingSetWindow: 10 });
      const pids = Array.from({ length: 3 }, (_, index) => kernel.spawn({
        name: `suspension process ${index}`, priority: 10, arrival: 0, service: 1000, burst: 1000, pages: 3,
      }, { program: instructionProgram([{ kind: 'compute' }]) }));
      kernel.step();
      const [low, middle, high] = pids;
      if (low === undefined || middle === undefined || high === undefined) throw new Error('missing kernel suspension PIDs');
      const wait: BlockReason = { kind: 'sleep', untilTick: asTick(1000) };
      kernel.blockProcess(low, wait);
      for (const [pid, size] of [[low, 2], [middle, 3], [high, 1]] as const) {
        for (let page = 0; page < size; page += 1) kernel.memorySubsystem.pager.workingSets.push(pid, asPageId(page));
      }
      kernel.setDegreeOfMultiprogramming(1);
      expect(kernel.memorySubsystem.pager.control.suspendedRecords.map(record => record.pid)).toEqual([low, middle]);
      expect(kernel.process(middle)?.state).toBe('waiting');
      const state = JSON.parse(JSON.stringify(kernel.memorySubsystem.saveState())) as ReturnType<MemorySubsystem['saveState']>;
      const rng = kernel.memorySubsystem.pager.rng.save();
      // Only the VM contribution is restored; the guarded process/workload channel is unchanged.
      kernel.memorySubsystem.pager.control.remove(low);
      kernel.memorySubsystem.prepareRestore(state.memory, state.vm)();
      expect(kernel.memorySubsystem.pager.rng.save()).toEqual(rng);
      expect(kernel.memorySubsystem.isSuspended(low)).toBe(true);
      kernel.run(125);
      expect(kernel.process(middle)?.state).toBe('waiting'); expect(kernel.memorySubsystem.isSuspended(middle)).toBe(true);
      expect(kernel.process(low)?.blockedOn?.kind).toBe('sleep');
      expect(kernel.process(low)?.blockedOn).not.toEqual(wait);
      kernel.setDegreeOfMultiprogramming(3); kernel.step();
      expect(kernel.memorySubsystem.isSuspended(low)).toBe(false);
      expect(kernel.process(low)).toMatchObject({ state: 'waiting', blockedOn: wait });
      const tid = kernel.process(low)?.threads[0];
      expect(tid === undefined ? undefined : kernel.threads.table.get(tid)?.blockedOn).toEqual(wait);
      kernel.run(50); expect(kernel.memorySubsystem.isSuspended(middle)).toBe(false);
      expect(kernel.process(middle)?.state).toBe('ready');
      expect(kernel.snapshot().completeness).toBe('full');
    });
  });
  it('rejects malformed in-flight stage, reservation and logical-reference bindings before commit', () => {
    const source = component();
    until(source, () => source.memory.saveState().vm.payload.demand.requests.some(request => request.phase === 'write_back'));
    const saved = source.memory.saveState();
    const target = restored(source);
    const request = saved.vm.payload.demand.requests[0]!;
    const reference = saved.vm.payload.demand.references[0]!;
    const resident = saved.memory.payload.frames.frames.find(frame => frame.id !== request.frame && frame.owner !== null)!;
    const cases = [
      { ...saved.vm.payload.demand, requests: [{ ...request, dueTick: null }] },
      { ...saved.vm.payload.demand, requests: [{ ...request, frame: null }] },
      { ...saved.vm.payload.demand, requests: [{ ...request, frame: resident.id }] },
      { ...saved.vm.payload.demand, references: [] },
      { ...saved.vm.payload.demand, references: [{ ...reference, fault: 'minor' }] },
      { ...saved.vm.payload.demand, references: [{ ...reference, page: asPageId((reference.page + 1) % 8) }] },
      { ...saved.vm.payload.demand, references: [{ ...reference, loaded: true }] },
    ];
    const before = target.memory.saveState(); const rng = target.registry.save();
    for (const demand of cases) {
      const vm = { ...saved.vm, payload: { ...saved.vm.payload, demand } };
      expect(() => target.memory.prepareRestore(saved.memory, vm)).toThrow();
      expect(target.memory.saveState()).toEqual(before); expect(target.registry.save()).toEqual(rng);
      expect(target.events).toEqual([]);
    }
  });

  it('rejects pending access costs without their loaded logical reference', () => {
    const source = component();
    until(source, () => source.memory.saveState().vm.payload.pending.length > 0);
    const saved = source.memory.saveState();
    const vm = { ...saved.vm, payload: { ...saved.vm.payload, demand: { ...saved.vm.payload.demand, references: [] } } };
    expect(() => source.memory.prepareRestore(saved.memory, vm)).toThrow('loaded logical reference');
    expect(source.memory.saveState()).toEqual(saved);
  });

  it('rejects mismatched suspended threads and future working-set or PFF control state atomically', () => {
    const source = component('fifo', 3, 16);
    source.memory.setDegreeOfMultiprogramming(1);
    const saved = source.memory.saveState();
    const target = restored(source, 'fifo', 3, 16);
    const suspension = saved.vm.payload.thrashing.suspended[0]!;
    const thread = suspension.threads[0]!;
    const invalidPayloads = [
      { ...saved.vm.payload, thrashing: { ...saved.vm.payload.thrashing,
        suspended: [{ ...suspension, threads: [{ ...thread, tid: thread.tid + 1000 }] }, ...saved.vm.payload.thrashing.suspended.slice(1)] } },
      { ...saved.vm.payload, thrashing: { ...saved.vm.payload.thrashing, pff: [] } },
      { ...saved.vm.payload, thrashing: { ...saved.vm.payload.thrashing, pff: saved.vm.payload.thrashing.pff.map((process, index) => index === 0
        ? { ...process, faultTicks: [[source.tick() + 1, 1]] } : process) } },
      { ...saved.vm.payload, workingSets: { ...saved.vm.payload.workingSets, processes: saved.vm.payload.workingSets.processes.map((process, index) => index === 0
        ? { ...process, nextNoiseTick: asTick(1000) } : process) } },
    ];
    const before = target.memory.saveState(); const rng = target.registry.save();
    for (const payload of invalidPayloads) {
      expect(() => target.memory.prepareRestore(saved.memory, { ...saved.vm, payload })).toThrow();
      expect(target.memory.saveState()).toEqual(before); expect(target.registry.save()).toEqual(rng);
    }
  });

  it('detaches replacement JSON during preparation so later caller mutation cannot cause a partial commit', () => {
    const source = component();
    until(source, () => source.memory.saveState().vm.payload.demand.requests.some(request => request.phase === 'write_back'));
    const expected = source.memory.saveState();
    const mutable = JSON.parse(JSON.stringify(expected));
    const target = component(); target.restoreWorld(source.world());
    const rng = target.registry.save();
    const commit = target.memory.prepareRestore(mutable.memory, mutable.vm);
    mutable.vm.payload.replacement.order.push(9999);
    mutable.vm.payload.replacement.policy = 'invalid';
    expect(() => commit()).not.toThrow();
    expect(target.memory.saveState()).toEqual(expected); expect(target.registry.save()).toEqual(rng);
  });
});


describe('fault ownership across retries and exits', () => {
  it('temporary reservations queue later faults and protect a completed page until its successful restart', () => {
    const f = fixture([access(0)], { frames: 1, pages: 1, service: 1 });
    const second = f.kernel.spawn({ name: 'queued access', priority: 10, arrival: 0, burst: 1, service: 1, pages: 1 },
      { program: instructionProgram([access(0)]) });
    f.memory.setFramePolicy('standard', 'equal', 'global');
    until(f.kernel, () => f.pcb.serviceRemaining === 0 && f.kernel.process(second)?.serviceRemaining === 0, 30);
    expect(f.pcb.terminationReason).toBe('normal_exit'); expect(f.kernel.process(second)?.terminationReason).toBe('normal_exit');
    expect(faultEvents(f.events).map(event => event.pid)).toEqual([f.pid, second]);
    expect(loadEvents(f.events).map(event => event.pid)).toEqual([f.pid, second]);
    expect(f.events.filter(event => event.type === 'memory.allocation_failed')).toEqual([]);
    expect(f.storage.map(request => request.kind)).toEqual(['read', 'read']);
  });

  it('former COW aliases regain private write permission when their shared frame is evicted', () => {
    const f = fixture([compute, access(0), access(0, true)], { frames: 1, pages: 1 }); f.kernel.step();
    const source = f.memory.loadPage(f.pcb.addressSpaceId, asPageId(0));
    if (source === null) throw new Error('failed original COW load');
    const child = fork(f.kernel, f.pid); const childPcb = f.kernel.process(child);
    if (childPcb === undefined) throw new Error('missing original child');
    const requester = f.kernel.spawn({ name: 'eviction requester', priority: 10, arrival: f.kernel.tick,
      burst: 100, service: 100, pages: 1 }, { program: instructionProgram([access(0)]) });
    f.memory.setFramePolicy('standard', 'equal', 'global');
    f.kernel.blockProcess(f.pid, { kind: 'sleep', untilTick: asTick(10) }); f.kernel.step();
    f.kernel.blockProcess(child, { kind: 'sleep', untilTick: asTick(100) });
    until(f.kernel, () => threadOf(f.kernel, requester).programCounter === 1);
    expect(f.memory.pageTables.get(f.pcb.addressSpaceId, asPageId(0))).toMatchObject({ valid: false, writable: true });
    expect(f.memory.pageTables.get(childPcb.addressSpaceId, asPageId(0))).toMatchObject({ valid: false, writable: true });
    expect(f.kernel.lifecycle.cowRefCount.has(source)).toBe(false);
    f.kernel.blockProcess(requester, { kind: 'sleep', untilTick: asTick(100) });
    until(f.kernel, () => f.thread.programCounter === 3, 30);
    expect(f.pcb.terminationReason).toBeNull();
    expect(f.memory.pageTables.get(f.pcb.addressSpaceId, asPageId(0))).toMatchObject({ valid: true, writable: true, dirty: true });
    expect(f.events.filter(event => event.type === 'security.access_denied')).toEqual([]);
  });

  it('a coalesced shared read transfers ownership when its original requester exits', () => {
    const f = fixture([compute], { pages: 1 });
    const readers = [0, 1].map(index => f.kernel.spawn({ name: `transferred reader ${index}`, priority: 10, arrival: 0,
      burst: 100, service: 100, pages: 0 }, { program: instructionProgram([access(0)]) }));
    const [first, second] = readers;
    if (first === undefined || second === undefined) throw new Error('missing shared readers');
    f.kernel.step(); const id = asResourceId('transferred backing');
    f.kernel.installHooks({ security: { rights: () => ['read'] } });
    f.kernel.ipc.createSharedRegion({ id, pages: [asPageId(0)], space: f.pcb.addressSpaceId, attached: [], value: 0 });
    for (const pid of readers) expect(f.kernel.ipc.mmap(pid, id, false)).toEqual({ ok: true, value: 0 });
    f.kernel.blockProcess(f.pid, { kind: 'sleep', untilTick: asTick(100) }); f.kernel.step(); f.kernel.step();
    expect(f.memory.saveState().vm.payload.demand.requests).toHaveLength(1);
    expect(f.kernel.syscall({ name: 'exit', pid: first, args: [0] }).ok).toBe(true);
    const pending = f.memory.saveState().vm.payload.demand;
    expect(pending.requests).toHaveLength(1); expect(pending.requests[0]?.pid).toBe(second);
    expect(pending.references.map(reference => reference.pid)).toEqual([second]);
    until(f.kernel, () => threadOf(f.kernel, second).programCounter === 1);
    const backing = mappedFrame(f, 0);
    expect(loadEvents(f.events)).toMatchObject([{ pid: second, page: 0, frame: backing }]);
    expect(f.memory.frameTable.frames[backing]).toMatchObject({ owner: f.pcb.addressSpaceId, pinned: true });
    expect(f.storage.map(request => request.kind)).toEqual(['read']);
    expect(f.memory.saveState().vm.payload.demand.requests).toEqual([]);
    expect(f.kernel.process(second)?.terminationReason).toBeNull();
  });
});


describe('VM controls and locality integration', () => {
  const aCompute: Instruction = { kind: 'compute' };
  const aAccess = (page: number, write = false): Instruction => ({ kind: 'access', page: asPageId(page), write });
  const ABILITY_CONFIG: KernelConfig = { ...REFERENCE_CONFIG, enabledSubsystems: ['process', 'scheduler', 'memory', 'vm'],
    replacementPolicy: 'fifo', totalFrames: 6, thrashingThreshold: 1e9 };
  const ABILITY_TUNING: KernelOptions = { majorFaultTicks: 4, minorFaultTicks: 1, tlbMissTicks: 1, tlbHitTicks: 1,
    threadCreateTicks: 0, thrashingCriticalDemandRatio: 1e9, thrashingSuspendInterval: 1000 };
  function abilityFixture(instructions: readonly Instruction[], options: {
    frames?: number; pages?: number; service?: number; tuning?: KernelOptions; scripted?: boolean; threads?: number;
  } = {}) {
    const kernel = createKernel({ ...ABILITY_CONFIG, totalFrames: options.frames ?? 6 }, { ...ABILITY_TUNING, ...options.tuning });
    const pid = kernel.spawn({ name: 'ability workload', priority: 10, arrival: 0,
      burst: options.service ?? 100, service: options.service ?? 100, pages: options.pages ?? 8 },
    { program: instructionProgram(instructions, options.scripted === false ? null
      : instructions.flatMap(instruction => instruction.kind === 'access' ? [instruction.page] : [])),
      threadCount: options.threads ?? 1, serialFraction: 1 });
    const pcb = kernel.table.get(pid)!; const thread = kernel.threads.table.get(pcb.threads[0]!)!;
    const events: KernelEvent[] = []; kernel.events.onAny(event => events.push(event));
    const storage: PagingStorageRequest[] = []; kernel.memorySubsystem.pager.setStorage({ enqueue: request => storage.push(request) });
    return { kernel, pid, pcb, thread, memory: kernel.memorySubsystem, events, storage };
  }
  function abilityUntil(kernel: KernelImpl, ready: () => boolean, limit = 250): void {
    for (let tick = 0; tick < limit && !ready(); tick += 1) kernel.step();
    expect(ready()).toBe(true);
  }
  function residentCount(f: ReturnType<typeof abilityFixture>): number {
    return [...f.memory.pageTables.pageTable(f.pcb.addressSpaceId).values()].filter(entry => entry.valid).length;
  }

  describe('approved memory ability primitives', () => {
    it('halves odd remaining useful work with conserved PCB/raw/TCB accounting and earlier completion', () => {
      const f = abilityFixture([aCompute], { service: 12, threads: 2 }); f.kernel.step();
      const beforeCpu = f.pcb.totalCpuUsed; const beforePc = f.thread.programCounter;
      const raw = f.kernel.table.raw.get(f.pid)!;
      expect(raw.rawService).toBe(11);
      f.kernel.halveRemainingBurst(f.pid);
      expect(raw).toMatchObject({ rawBurst: 6, rawService: 6 });
      expect(f.pcb).toMatchObject({ cpuBurstRemaining: 6, serviceRemaining: 6, totalCpuUsed: beforeCpu });
      expect(f.pcb.threads.reduce((sum, tid) => sum + f.kernel.threads.table.get(tid)!.serviceRemaining, 0)).toBe(6);
      expect(f.thread.programCounter).toBe(beforePc);
      abilityUntil(f.kernel, () => f.pcb.state === 'zombie');
      expect(f.pcb.totalCpuUsed - beforeCpu).toBe(6);
      expect(() => f.kernel.halveRemainingBurst(f.pid)).toThrow('no remaining work');
      expect(() => f.kernel.halveRemainingBurst(asPid(999))).toThrow('no remaining work');
    });

    it('halves an entirely blocked process immediately without losing its wait or faulting instruction', () => {
      const f = abilityFixture([aAccess(0)], { service: 9 }); f.kernel.step();
      const wait = structuredClone(f.pcb.blockedOn); const cpu = f.pcb.totalCpuUsed;
      expect(f.pcb.state).toBe('waiting'); expect(f.thread.programCounter).toBe(0);
      f.kernel.halveRemainingBurst(f.pid);
      expect(f.kernel.table.raw.get(f.pid)).toMatchObject({ rawBurst: 5, rawService: 5 });
      expect(f.pcb).toMatchObject({ state: 'waiting', blockedOn: wait, cpuBurstRemaining: 5, serviceRemaining: 5, totalCpuUsed: cpu });
      expect(f.thread).toMatchObject({ state: 'waiting', blockedOn: wait, programCounter: 0, serviceRemaining: 5 });
      abilityUntil(f.kernel, () => f.pcb.state === 'zombie');
      expect(f.pcb.totalCpuUsed - cpu).toBe(5);
    });

    it('prefetch credits apply to faults, survive intervening hits and leave subsequent faults normally timed', () => {
      const f = abilityFixture([aAccess(0), aAccess(0), aAccess(1), aAccess(2)], { pages: 3 });
      f.kernel.prefetchNextFaults(f.pid, 2);
      abilityUntil(f.kernel, () => f.thread.programCounter === 4);
      const faults = f.events.filter(event => event.type === 'memory.page_fault');
      const loads = f.events.filter(event => event.type === 'memory.page_loaded');
      expect(faults.map(event => event.page)).toEqual([0, 1, 2]);
      expect(loads.map((event, index) => event.tick - faults[index]!.tick)).toEqual([1, 1, f.kernel.tuning.majorFaultTicks]);
      expect(f.storage.map(request => [request.kind, request.page])).toEqual([['read', 2]]);
      expect(f.memory.saveState().vm.payload.controls.prefetchCredits).toEqual([[f.pid, 0]]);
    });

    it('prefetch preserves a dirty write-back while removing the ordinary read stall', () => {
      const f = abilityFixture([aAccess(0, true), aAccess(1)], { frames: 1, pages: 2 });
      abilityUntil(f.kernel, () => f.thread.programCounter === 1);
      f.events.length = 0; f.storage.length = 0; f.kernel.prefetchNextFaults(f.pid, 1);
      abilityUntil(f.kernel, () => f.thread.programCounter === 2);
      const fault = f.events.find(event => event.type === 'memory.page_fault');
      const loaded = f.events.find(event => event.type === 'memory.page_loaded');
      expect(fault).toBeDefined(); expect(loaded).toBeDefined();
      expect(loaded!.tick - fault!.tick).toBe(f.kernel.tuning.majorFaultTicks);
      expect(f.events.filter(event => event.type === 'memory.page_evicted')).toMatchObject([{ dirty: true }]);
      expect(f.storage.map(request => request.kind)).toEqual(['write']);
      expect(f.memory.metrics().writeBacks).toBe(1);
    });

    it('prefetch cannot bypass write protection or overwrite a pinned frame', () => {
      const protectedWork = abilityFixture([aCompute, aAccess(0, true)], { pages: 1 }); protectedWork.kernel.step();
      protectedWork.memory.pageTables.get(protectedWork.pcb.addressSpaceId, asPageId(0))!.writable = false;
      protectedWork.kernel.prefetchNextFaults(protectedWork.pid, 5); protectedWork.kernel.step();
      expect(protectedWork.pcb.terminationReason).toBe('protection_fault');
      expect(protectedWork.events.filter(event => event.type === 'memory.page_loaded')).toEqual([]);
      const pinnedWork = abilityFixture([aCompute, aAccess(1)], { frames: 1, pages: 2 }); pinnedWork.kernel.step();
      const frame = pinnedWork.memory.loadPage(pinnedWork.pcb.addressSpaceId, asPageId(0), true)!;
      const tag = pinnedWork.memory.contentTag(frame);
      pinnedWork.kernel.prefetchNextFaults(pinnedWork.pid, 5);
      abilityUntil(pinnedWork.kernel, () => pinnedWork.pcb.terminationReason === 'out_of_memory');
      expect(pinnedWork.events.filter(event => event.type === 'memory.page_evicted')).toEqual([]);
      // Teardown may discard private pinned state; prefetch must never install page 1.
      expect(pinnedWork.events.filter(event => event.type === 'memory.page_loaded')).toEqual([]);
      expect(tag).toBeDefined();
    });

    it('remap compacts future references, resets true WSS, preserves writes and applies equally to OPT lookahead', () => {
      const f = abilityFixture([0, 1, 2, 3].map(page => aAccess(page)).concat([aAccess(4, true), aAccess(5)]),
        { frames: 6, pages: 6, tuning: { localitySize: 2 } });
      abilityUntil(f.kernel, () => f.thread.programCounter === 4);
      expect(f.memory.pager.workingSets.trueSize(f.pid)).toBe(4);
      f.kernel.remapOptimalLocality(f.pid);
      expect(f.memory.pager.workingSets.trueSize(f.pid)).toBe(0);
      expect(f.memory.pager.context(f.pid).futureReferences).toEqual([1]);
      expect(f.kernel.program(f.pid)!.at(4)).toEqual(aAccess(4, true));
      f.events.length = 0;
      abilityUntil(f.kernel, () => f.thread.programCounter === 6);
      expect(f.events.filter(event => event.type === 'memory.access').map(event => event.page)).toEqual([0, 1]);
      expect(f.memory.pageTables.get(f.pcb.addressSpaceId, asPageId(0))!.dirty).toBe(true);
      expect(f.memory.pager.workingSets.trueSize(f.pid)).toBe(2);
      expect(f.memory.saveState().vm.payload.controls.localityRemaps).toEqual([{ pid: f.pid,
        pages: [[0, 0], [1, 1], [2, 0], [3, 1], [4, 0], [5, 1]] }]);
    });

    it('remapped writes still obey the destination page permissions', () => {
      const f = abilityFixture([aCompute, aAccess(4, true)], { pages: 6, tuning: { localitySize: 2 } }); f.kernel.step();
      f.memory.pageTables.get(f.pcb.addressSpaceId, asPageId(0))!.writable = false;
      f.kernel.remapOptimalLocality(f.pid); f.kernel.step();
      expect(f.pcb.terminationReason).toBe('protection_fault');
      expect(f.events.filter(event => event.type === 'security.access_denied')).toMatchObject([{ object: 'page:0', right: 'write' }]);
      expect(f.events.filter(event => event.type === 'memory.page_loaded')).toEqual([]);
    });

    it('credits and compacted locality survive a component restore and resume the same event stream', () => {
      const instructions = [aCompute, aAccess(4), aAccess(5), aAccess(2)];
      const source = abilityFixture(instructions, { pages: 6, tuning: { localitySize: 2 } });
      const target = abilityFixture(instructions, { pages: 6, tuning: { localitySize: 2 } });
      source.kernel.step(); target.kernel.step();
      source.kernel.prefetchNextFaults(source.pid, 2); source.kernel.remapOptimalLocality(source.pid);
      const state = JSON.parse(JSON.stringify(source.memory.saveState())) as ReturnType<typeof source.memory.saveState>;
      target.memory.restoreState(state.memory, state.vm);
      expect(target.memory.saveState().vm.payload.controls).toEqual(state.vm.payload.controls);
      source.events.length = 0; target.events.length = 0;
      abilityUntil(source.kernel, () => source.thread.programCounter === 4);
      abilityUntil(target.kernel, () => target.thread.programCounter === 4);
      expect(target.events).toEqual(source.events);
      expect(target.memory.saveState()).toEqual(source.memory.saveState());
    });
  });

  describe('OPT activation safety', () => {
    it.each([true, false])('refuses an unscripted runnable workload without changing policy, dev=%s', checkInvariants => {
      const f = abilityFixture([aCompute], { scripted: false, tuning: { checkInvariants } }); f.kernel.step();
      f.kernel.setReplacementPolicy('optimal');
      expect(f.kernel.activeReplacementPolicy).toBe('fifo'); expect(f.memory.pager.policy.id).toBe('fifo');
      expect(f.events.filter(event => event.type === 'kernel.panic')).toHaveLength(checkInvariants ? 1 : 0);
    });

    it('admits scripted OPT and returns to FIFO when a later unscripted process invalidates its lookahead', () => {
      const f = abilityFixture([aCompute], { frames: 1, pages: 1 }); f.kernel.step(); f.kernel.setReplacementPolicy('optimal');
      expect(f.kernel.activeReplacementPolicy).toBe('optimal');
      const peer = f.kernel.spawn({ name: 'later unscripted workload', arrival: f.kernel.tick, priority: 10,
        burst: 100, service: 100, pages: 2 }, { program: instructionProgram([aAccess(0), aAccess(1)]) });
      f.memory.setFramePolicy('standard', 'equal', 'global');
      expect(f.kernel.syscall({ name: 'exit', pid: f.pid, args: [0] }).ok).toBe(true);
      const thread = f.kernel.threads.table.get(f.kernel.process(peer)!.threads[0]!)!;
      abilityUntil(f.kernel, () => thread.programCounter >= 2 || f.kernel.process(peer)!.terminationReason !== null);
      expect(f.kernel.process(peer)!.terminationReason).toBeNull();
      expect(thread.programCounter).toBe(2);
      expect(f.kernel.activeReplacementPolicy).toBe('fifo'); expect(f.memory.pager.policy.id).toBe('fifo');
      expect(f.events.some(event => event.type === 'kernel.panic')).toBe(true);
      expect(f.events.filter(event => event.type === 'memory.allocation_failed')).toEqual([]);
    });
  });

  describe('local allocation budgets are effective', () => {
    it('starved local allocation replaces within three frames while generous rations allow growth', () => {
      const f = abilityFixture([0, 1, 2, 3, 4].map(page => aAccess(page)), { frames: 8, pages: 8 });
      f.memory.setFramePolicy('starved', 'equal', 'local');
      abilityUntil(f.kernel, () => f.thread.programCounter === 4);
      expect(f.memory.pager.control.frameBudget(f.pid)).toBe(3);
      expect(residentCount(f)).toBe(3);
      expect(f.events.filter(event => event.type === 'memory.page_evicted')).toMatchObject([{ page: 0, policy: 'fifo' }]);
      f.memory.setFramePolicy('generous', 'equal', 'local');
      expect(f.memory.pager.control.frameBudget(f.pid)).toBe(8);
      abilityUntil(f.kernel, () => f.thread.programCounter === 5);
      expect(residentCount(f)).toBe(4);
      expect(f.events.filter(event => event.type === 'memory.page_evicted')).toHaveLength(1);
    });

    it('future new processes do not dilute an admitted process quota', () => {
      const f = abilityFixture([aCompute], { frames: 8, pages: 8 });
      f.kernel.spawn({ name: 'future quota peer', priority: 10, arrival: 1000, burst: 100, service: 100, pages: 8 },
        { program: instructionProgram([aCompute], []) });
      f.kernel.step();
      expect(f.memory.pager.control.frameBudget(f.pid)).toBe(8);
    });
  });

  describe('locality draw protocol and generated-program validation', () => {
    it.each([0, 1])('consumes exactly three draws plus one per shift, shift chance=%i', localityShiftChance => {
      const rng = createRng(1234).fork('vm'); const reference = createRng(1234).fork('vm');
      const generator = new LocalityGenerator(rng, 8, { localitySize: 4, localityShiftChance });
      for (let index = 0; index < 100; index += 1) generator.next();
      for (let draw = 0; draw < 100 * (3 + localityShiftChance); draw += 1) reference.next();
      expect(rng.save()).toEqual(reference.save());
      expect(generator.shiftDecisions).toBe(localityShiftChance * 100);
    });

    it('Kernel spawn uses the shared root/vm stream for eager generation and later reads consume no draws', () => {
      const kernel = createKernel(ABILITY_CONFIG, { ...ABILITY_TUNING, localitySize: 3, localityShiftChance: 0.25, writeRatio: 0.4 });
      const stream = kernel.memorySubsystem.pager.rng;
      expect(stream.save().label).toBe('root/vm');
      const reference = createRng(0); reference.restore(stream.save());
      const expected = generatedProgram(reference, { pages: 9, service: 20 }, kernel.tuning);
      const pid = kernel.spawn({ name: 'seeded generated workload', priority: 10, arrival: 0, burst: 20, service: 20, pages: 9 });
      expect(Array.from({ length: 20 }, (_, pc) => kernel.program(pid)!.at(pc)))
        .toEqual(Array.from({ length: 20 }, (_, pc) => expected.at(pc)));
      expect(stream.save()).toEqual(reference.save());
      const after = stream.save();
      for (let pc = 19; pc >= 0; pc -= 1) kernel.program(pid)!.at(pc);
      expect(stream.save()).toEqual(after);
    });

    it.each([
      { localitySize: 0 }, { localitySize: 1.5 }, { localitySize: Number.NaN }, { localityShiftChance: -0.1 },
      { localityShiftChance: 1.1 }, { localityShiftChance: Number.POSITIVE_INFINITY }, { writeRatio: -1 }, { writeRatio: Number.NaN },
    ])('rejects invalid locality options before advancing any stream: %o', options => {
      const rng = createRng(1234).fork('vm'); const before = rng.save();
      expect(() => new LocalityGenerator(rng, 0, options as LocalityOptions)).toThrow();
      expect(rng.save()).toEqual(before);
      expect(() => generatedProgram(rng, { pages: 0, service: 0 }, options as LocalityOptions)).toThrow();
      expect(rng.save()).toEqual(before);
    });

    it.each([[-1, 1], [1, -1], [0.5, 1], [1, Number.NaN]])('rejects generated dimensions pages=%i service=%i without draws', (pages, service) => {
      const rng = createRng(1234).fork('vm'); const before = rng.save();
      expect(() => generatedProgram(rng, { pages, service })).toThrow();
      expect(rng.save()).toEqual(before);
    });
  });
});

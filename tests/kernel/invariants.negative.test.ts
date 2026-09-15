/** WP-11: forty negative cases, one per invariant, each the smallest state that violates it (sim spec 16.13 INV-NEG-1 to 4 among them). */
import { describe, expect, it } from 'vitest';
import { createKernel, type KernelImpl } from '@kernel/Kernel';
import { createStreamRegistry } from '@kernel/rng';
import { KernelInvariantError } from '@kernel/errors';
import { checkInvariants, assertSecretAbsent, assertSnapshotPure, type InvariantView } from '@kernel/invariants';
import { asPid, asResourceId, asTick } from '@kernel/types';
import type { Frame, KernelEvent, Pid, ProcessControlBlock, ResourceType, SyncPrimitive } from '@kernel/types';
import { REFERENCE_CONFIG } from './fixtures/referenceConfig';
import { referenceWorkload } from './fixtures/workloads';
import { canonical } from './canonical';

const NOOP_SUBSYSTEMS: InvariantView['subsystems'] = { deadlock: () => {}, storage: () => {}, fs: () => {}, security: () => {}, io: () => {} };

/** A healthy view from a running workload, detached from subsystem callbacks unless a case wires one. */
function healthy(config = REFERENCE_CONFIG, ticks = 40): { kernel: KernelImpl; view: InvariantView } {
  const { kernel } = referenceWorkload(config); kernel.run(ticks);
  const view = kernel.invariantState();
  return { kernel, view: { ...view, subsystems: NOOP_SUBSYSTEMS } };
}
function expectViolation(run: () => void, invariant: number): void {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(KernelInvariantError);
  if (caught instanceof KernelInvariantError) expect(caught.invariant).toBe(invariant);
}
const edited = (pcb: Readonly<ProcessControlBlock>, patch: Partial<ProcessControlBlock>): ProcessControlBlock => ({ ...pcb, threads: [...pcb.threads], openFiles: [...pcb.openFiles], heldResources: [...pcb.heldResources], requestedResources: [...pcb.requestedResources], ...patch });
function withProcess(view: InvariantView, pid: Pid, patch: Partial<ProcessControlBlock>): InvariantView {
  return { ...view, processes: view.processes.map(pcb => (pcb.pid === pid ? edited(pcb, patch) : pcb)) };
}
function userPid(view: InvariantView, state: ProcessControlBlock['state'] = 'ready'): Pid {
  const pcb = view.processes.find(p => p.pid > 1 && p.state === state); if (pcb === undefined) throw new Error(`no ${state} user process`); return pcb.pid;
}

describe('process and scheduling', () => {
  it('I-1: a duplicated pid', () => { const { view } = healthy(); const p = view.processes[1]; if (p === undefined) throw new Error('missing'); expectViolation(() => checkInvariants({ ...view, processes: [...view.processes, edited(p, {})] }), 1); });
  it('INV-NEG-2, I-2: two processes forced into state running', () => {
    const { view } = healthy();
    const [a, b] = view.processes.filter(p => p.pid > 1);
    if (a === undefined || b === undefined) throw new Error('need two processes');
    expectViolation(() => checkInvariants({ ...withProcess(withProcess(view, a.pid, { state: 'running', readySince: null }), b.pid, { state: 'running', readySince: null }), running: a.pid }), 2);
  });
  it('I-3: busy ticks beyond the tick', () => { const { view } = healthy(); expectViolation(() => checkInvariants({ ...view, busyTicks: view.tick + 1 }), 3); });
  it('I-4: negative service accounting', () => { const { view } = healthy(); expectViolation(() => checkInvariants(withProcess(view, userPid(view), { totalCpuUsed: -1 })), 4); });
  it('INV-NEG-4, I-5: available plus held exceeding the total', () => {
    const { view } = healthy();
    const resource: ResourceType = { id: asResourceId('printer'), displayName: 'printer', totalInstances: 1, availableInstances: 1, preemptible: false };
    const pid = userPid(view);
    expectViolation(() => checkInvariants({ ...withProcess(view, pid, { heldResources: [resource.id] }), resources: [resource] }), 5);
  });
  it('I-6: a process blocked on a resource only it holds', () => {
    const { view } = healthy();
    const resource: ResourceType = { id: asResourceId('printer'), displayName: 'printer', totalInstances: 1, availableInstances: 0, preemptible: false };
    expectViolation(() => checkInvariants({ ...withProcess(view, userPid(view), { heldResources: [resource.id], requestedResources: [resource.id] }), resources: [resource] }), 6);
  });
  it('I-7: a live process with no threads', () => { const { view } = healthy(); expectViolation(() => checkInvariants(withProcess(view, userPid(view), { threads: [] })), 7); });
  it('I-8: a program counter advanced past a pending page fault', () => {
    const { view } = healthy();
    const waiting = view.processes.find(p => p.pid > 1 && p.threads.some(tid => view.threads.get(tid)?.blockedOn?.kind === 'page_fault'));
    const pcb = waiting ?? view.processes.find(p => p.pid > 1); if (pcb === undefined) throw new Error('missing');
    const tid = pcb.threads[0]; if (tid === undefined) throw new Error('no thread');
    const thread = view.threads.get(tid); if (thread === undefined) throw new Error('no tcb');
    const threads = new Map(view.threads); threads.set(tid, { ...thread, state: 'waiting', blockedOn: { kind: 'page_fault', page: 0 as never }, programCounter: thread.programCounter + 1 });
    const event = { type: 'memory.page_fault', pid: pcb.pid, page: 0, major: true, tick: view.tick, seq: 1 } as unknown as KernelEvent;
    expectViolation(() => checkInvariants({ ...view, threads, lastFrame: [event], tickStart: { states: new Map(), counters: new Map([[tid, thread.programCounter]]) } }), 8);
  });
  it('I-9: a TLB entry naming a frame with a different owner', () => {
    const { view } = healthy();
    expectViolation(() => checkInvariants({ ...view, tlb: [{ space: 999 as never, page: 0 as never, frame: 0 as never, valid: true }] }), 9);
  });
  it('I-10: a pid queued on a primitive without a matching wait', () => {
    const { view } = healthy();
    const mutex: SyncPrimitive = { id: asResourceId('m'), kind: 'mutex', displayName: 'm', value: 0, capacity: 1, holders: [], waitQueue: [userPid(view)], ordered: true };
    expectViolation(() => checkInvariants({ ...view, syncPrimitives: [mutex] }), 10);
  });
  it('I-11: a zombie that came back to ready', () => {
    const { view } = healthy(); const pid = userPid(view);
    expectViolation(() => checkInvariants({ ...view, tickStart: { states: new Map([[pid, 'zombie']]), counters: new Map() } }), 11);
  });
  it('I-12: ready without readySince', () => { const { view } = healthy(); expectViolation(() => checkInvariants(withProcess(view, userPid(view), { readySince: null })), 12); });
  it('I-13: a ready process missing from the queues', () => { const { view } = healthy(); expectViolation(() => checkInvariants({ ...view, queues: [[]] }), 13); });
  it('I-14: a process admitted this tick that has already waited', () => {
    const { view } = healthy(); const pid = userPid(view);
    expectViolation(() => checkInvariants({ ...withProcess(view, pid, { readySince: asTick(view.tick - 1) }), admittedThisTick: new Set([pid]) }), 14);
  });
  it('I-15: a priority out of range', () => { const { view } = healthy(); expectViolation(() => checkInvariants(withProcess(view, userPid(view), { priority: 40 })), 15); });
  it('I-16: an unbounded worst wait under a starvation-free policy', () => {
    const { view } = healthy({ ...REFERENCE_CONFIG, scheduler: 'rr' });
    expectViolation(() => checkInvariants({ ...view, metrics: { ...view.metrics, scheduling: { ...view.metrics.scheduling, worstWait: 1_000_000 } } }), 16);
  });
});

describe('memory', () => {
  it('INV-NEG-1, I-17: a duplicated frame in the free list', () => {
    const { view } = healthy(); const first = view.freeList[0]; if (first === undefined) throw new Error('empty free list');
    expectViolation(() => checkInvariants({ ...view, freeList: [first, first, ...view.freeList.slice(2)] }), 17);
  });
  it('I-18: a valid page table entry with no frame', () => {
    const { view } = healthy();
    const [space, entries] = [...view.pageTables].find(([, rows]) => rows.length > 0) ?? []; if (space === undefined || entries === undefined) throw new Error('no page table');
    const tables = new Map(view.pageTables); tables.set(space, entries.map((entry, index) => (index === 0 ? { ...entry, valid: true, frame: null } : entry)));
    expectViolation(() => checkInvariants({ ...view, pageTables: tables }), 18);
  });
  it('I-19: a non-finite metric', () => { const { view } = healthy(); expectViolation(() => checkInvariants({ ...view, metrics: { ...view.metrics, memory: { ...view.metrics.memory, faultRate: Number.NaN } } }), 19); });
  it('I-20: a free list out of order', () => {
    const { view } = healthy(); if (view.freeList.length < 2) throw new Error('need two free frames');
    expectViolation(() => checkInvariants({ ...view, freeList: [...view.freeList].reverse() }), 20);
  });
});

describe('synchronisation and deadlock', () => {
  it('INV-NEG-3, I-21: a mutex with two holders', () => {
    const { view } = healthy();
    const mutex: SyncPrimitive = { id: asResourceId('m'), kind: 'mutex', displayName: 'm', value: 0, capacity: 1, holders: [asPid(2), asPid(3)], waitQueue: [], ordered: true };
    expectViolation(() => checkInvariants({ ...view, syncPrimitives: [mutex] }), 21);
  });
  it('I-22: a bounded buffer whose conservation sum misses', () => {
    const { view } = healthy();
    const empty: SyncPrimitive = { id: asResourceId('empty'), kind: 'semaphore', displayName: 'e', value: 2, capacity: 4, holders: [], waitQueue: [], ordered: true };
    const full: SyncPrimitive = { id: asResourceId('full'), kind: 'semaphore', displayName: 'f', value: 1, capacity: 4, holders: [], waitQueue: [], ordered: true };
    const scenario = { kind: 'bounded_buffer' as const, id: 'bb', variant: 'correct' as const, capacity: 4, mutex: asResourceId('bm'), empty: empty.id, full: full.id, cell: 'c', items: [1], produced: 1, consumed: 0, inFlight: 0, reservations: [], actors: [] };
    expectViolation(() => checkInvariants({ ...view, syncPrimitives: [empty, full], scenarios: [scenario] }), 22);
  });
  it('I-23: a mutex owner waiting on its own mutex', () => {
    const { view } = healthy();
    const owner = { pid: asPid(2), tid: 1 as never };
    const state = { id: asResourceId('m'), displayName: 'm', capacity: 1, ordered: true, kind: 'mutex' as const, owner, entryQueue: [7] };
    const wait = { generation: 7, actor: owner, resource: state.id, operation: { kind: 'mutex' as const }, requestedAt: asTick(1), entriesObserved: 0, boundedWarningEmitted: false, starvationWarningEmitted: false, starvationFatalEmitted: false };
    expectViolation(() => checkInvariants({ ...view, syncStates: [state], syncWaits: [wait], reserved: () => false }), 23);
  });
  it('I-24: a wait-for cycle under prevention', () => {
    const { view } = healthy({ ...REFERENCE_CONFIG, deadlockStrategy: 'prevent' });
    const [p, q] = view.processes.filter(row => row.pid > 1); if (p === undefined || q === undefined) throw new Error('need two');
    const a: ResourceType = { id: asResourceId('a'), displayName: 'a', totalInstances: 1, availableInstances: 0, preemptible: false };
    const b: ResourceType = { id: asResourceId('b'), displayName: 'b', totalInstances: 1, availableInstances: 0, preemptible: false };
    // P holds a and waits for b; Q holds b and waits for a: the cycle the ordering rule makes impossible.
    const cyclic = withProcess(withProcess(view, p.pid, { heldResources: [a.id], requestedResources: [b.id] }), q.pid, { heldResources: [b.id], requestedResources: [a.id] });
    expectViolation(() => checkInvariants({ ...cyclic, resources: [a, b] }), 24);
  });
  it('I-25: an unsafe allocation under avoidance', () => {
    const { kernel } = referenceWorkload({ ...REFERENCE_CONFIG, deadlockStrategy: 'avoid' });
    kernel.declareResource({ id: asResourceId('r'), displayName: 'r', totalInstances: 2, preemptible: false });
    const [a, b] = kernel.processes.filter(p => p.pid > 1).map(p => p.pid); if (a === undefined || b === undefined) throw new Error('need two');
    kernel.declareClaims(a, [[asResourceId('r'), 2]]); kernel.declareClaims(b, [[asResourceId('r'), 2]]);
    kernel.run(10);
    const view = kernel.invariantState();
    const resource = view.resources.find(row => row.id === 'r'); if (resource === undefined) throw new Error('missing resource');
    // Each holds one of two with a maximum of two: conserved, and no process can finish.
    (resource as { availableInstances: number }).availableInstances = 0;
    for (const pid of [a, b]) kernel.table.get(pid)?.heldResources.push(asResourceId('r'));
    expectViolation(() => checkInvariants(kernel.invariantState()), 25);
  });
  it('I-26: a reported cycle that is not the witness (delegated evidence check)', () => {
    const { view } = healthy();
    // The captured detection evidence is private to the deadlock subsystem, so the violation is delivered through its composed check.
    expectViolation(() => checkInvariants({ ...view, subsystems: { ...NOOP_SUBSYSTEMS, deadlock: () => { throw new KernelInvariantError(26, 'report differs from its actor witness'); } } }), 26);
  });
});

describe('storage, I/O and file system', () => {
  it('I-27: a disk head outside the cylinder range', () => { const { view } = healthy(); expectViolation(() => checkInvariants({ ...view, diskHead: { ...view.diskHead, cylinder: view.diskHead.totalCylinders } }), 27); });
  it('I-28: a request served before it was queued', () => {
    const { view } = healthy();
    expectViolation(() => checkInvariants({ ...view, diskQueue: [{ id: 1, pid: asPid(2), cylinder: 0, write: false, queuedAtTick: asTick(10), servedAtTick: asTick(5) }] }), 28);
  });
  it('I-29: a block owned by two inodes', () => {
    const { kernel } = referenceWorkload(); const fs = kernel.fileSystemSubsystem; fs.format();
    for (let guard = 0; guard < 5000 && !fs.mounted; guard++) kernel.step();
    fs.createFile('/a'); for (let guard = 0; guard < 5000 && fs.busy; guard++) kernel.step();
    const aId = fs.resolve('/a', asPid(1)); if (!aId.ok) throw new Error('no file');
    const root = fs.state().volume?.rootInode; if (root === undefined) throw new Error('no root');
    const rootBlock = fs.inodeTable.get(root)?.blocks[0]; if (rootBlock === undefined) throw new Error('root has no block');
    while (kernel.tick % 50 !== 0) kernel.step();
    // fsck reads the persisted metadata rows, so the corruption goes into the payload the way a bad write would.
    const row = fs.state().metadata.inodes.find(inode => inode.id === aId.inode.id) as unknown as { blocks: number[] } | undefined;
    row?.blocks.push(rootBlock);
    expectViolation(() => checkInvariants(kernel.invariantState()), 29);
  });
  it('I-30: a link count that disagrees with the directories', () => {
    const { kernel } = referenceWorkload(); const fs = kernel.fileSystemSubsystem; fs.format();
    for (let guard = 0; guard < 5000 && !fs.mounted; guard++) kernel.step();
    fs.createFile('/a'); for (let guard = 0; guard < 5000 && fs.busy; guard++) kernel.step();
    const a = fs.resolve('/a', asPid(1)); if (!a.ok) throw new Error('no file');
    while (kernel.tick % 50 !== 0) kernel.step();
    const row = fs.state().metadata.inodes.find(inode => inode.id === a.inode.id) as unknown as { linkCount: number } | undefined;
    if (row === undefined) throw new Error('no inode row');
    row.linkCount = 7;
    expectViolation(() => checkInvariants(kernel.invariantState()), 30);
  });
  it('I-31: a journal commit before its begin', () => {
    const { kernel } = referenceWorkload(); const fs = kernel.fileSystemSubsystem; fs.format();
    for (let guard = 0; guard < 5000 && !fs.mounted; guard++) kernel.step();
    (fs.state().journal as unknown as { entries: unknown[] }).entries.push({ txId: 999, phase: 'commit', blocks: [], tick: kernel.tick });
    expectViolation(() => checkInvariants(kernel.invariantState()), 31);
  });
  it('I-32: a pid in a device queue that is not waiting on it', () => {
    const { view } = healthy(); const device = view.devices[0]; if (device === undefined) throw new Error('no device');
    expectViolation(() => checkInvariants({ ...view, devices: [{ ...device, queue: [userPid(view)] }] }), 32);
  });
  it('I-33: a negative pending count', () => { const { view } = healthy(); expectViolation(() => checkInvariants({ ...view, interruptLines: [{ device: 'disk0', pending: -1 }] }), 33); });
});

describe('security', () => {
  it('I-34: a trap stack that returns to a more privileged ring', () => {
    const { kernel } = referenceWorkload(); kernel.run(5);
    const pid = kernel.processes.find(p => p.pid > 1)?.pid ?? asPid(2); kernel.securitySubsystem.ring(pid);
    const row = kernel.securitySubsystem.state().processes.find(p => p.pid === pid); if (row === undefined) throw new Error('no security row');
    (row as unknown as { traps: unknown[] }).traps.push({ id: 900, savedDomain: row.domain, savedRing: 1, committedReturn: null }, { id: 901, savedDomain: row.domain, savedRing: 3, committedReturn: null });
    expectViolation(() => checkInvariants(kernel.invariantState()), 34);
  });
  it('I-35: a user-domain process in ring 0 outside a trap', () => {
    const { kernel } = referenceWorkload(); kernel.run(5);
    const pid = kernel.processes.find(p => p.pid > 1)?.pid ?? asPid(2);
    kernel.securitySubsystem.defineDomain('domain:user' as never, 'user', 3); kernel.securitySubsystem.bindProcess(pid, 'domain:user' as never);
    const row = kernel.securitySubsystem.state().processes.find(p => p.pid === pid); if (row === undefined) throw new Error('no security row');
    (row as { ring: number }).ring = 0;
    expectViolation(() => checkInvariants(kernel.invariantState()), 35);
  });
  it('I-36: an ACL view that disagrees with the domain matrix', () => {
    const { kernel } = referenceWorkload(); kernel.run(5);
    kernel.securitySubsystem.defineDomain('domain:user' as never, 'user', 3);
    kernel.securitySubsystem.matrix.grant('domain:user' as never, 'file:x', ['read']);
    const state = kernel.securitySubsystem.state();
    (state as unknown as { acl: unknown[] }).acl.push({ object: 'file:ghost', entries: [] });
    expectViolation(() => checkInvariants(kernel.invariantState()), 36);
  });
  it('I-37: a planted secret is found in an event log', () => {
    const kernel = createKernel(REFERENCE_CONFIG);
    // The secret is the first draw of the security stream; rebuilding the registry from the seed reproduces it here only to plant it.
    const secret = createStreamRegistry(REFERENCE_CONFIG.seed).stream('security').int(0, 0x100000000);
    expect(kernel.securitySubsystem.secretAppearsIn(`leak ${secret}`)).toBe(true);
    const planted = { type: 'kernel.panic', message: `seal ${secret}`, tick: 1, seq: 0 } as unknown as KernelEvent;
    expectViolation(() => assertSecretAbsent(text => kernel.securitySubsystem.secretAppearsIn(text), [planted], asTick(1)), 37);
  });
});

describe('determinism', () => {
  it('I-38: a decreasing sequence within a frame', () => {
    const { view } = healthy();
    const events = [{ type: 'kernel.panic', message: 'a', tick: view.tick, seq: 5 }, { type: 'kernel.panic', message: 'b', tick: view.tick, seq: 4 }] as unknown as KernelEvent[];
    expectViolation(() => checkInvariants({ ...view, lastFrame: events }), 38);
  });
  it('I-39: a registry out of order and a stream that is not sfc32', () => {
    const { view } = healthy();
    expectViolation(() => checkInvariants({ ...view, rng: [...view.rng].reverse() }), 39);
    expectViolation(() => checkInvariants({ ...view, rng: view.rng.map(state => ({ ...state, algorithm: 'xorshift' as never })) }), 39);
  });
  it('I-40: an impure snapshot', () => {
    const kernel = createKernel(REFERENCE_CONFIG); let calls = 0;
    expectViolation(() => assertSnapshotPure({ tick: kernel.tick, snapshot: () => ({ ...kernel.snapshot(), seq: calls++ }) }, canonical), 40);
  });
});

describe('the live kernel path', () => {
  it('a corrupted free list trips the harness inside step() with the panic event first', () => {
    const { kernel } = referenceWorkload(); kernel.run(20);
    const frame = kernel.frame(0 as never) as Frame | undefined; if (frame === undefined) throw new Error('no frame');
    kernel.installHooks({ invariants: { check: k => { const view = k.invariantState(); checkInvariants({ ...view, freeList: [...view.freeList, ...view.freeList.slice(0, 1)] }); } } });
    let panic = false; kernel.events.onAny(event => { if (event.type === 'kernel.panic' && event.message.startsWith('I-17')) panic = true; });
    expectViolation(() => kernel.step(), 17);
    expect(panic).toBe(true);
  });
});

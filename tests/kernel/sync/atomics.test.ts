import { describe, expect, it } from 'vitest';
import { createKernel } from '@kernel/Kernel';
import type { EmittableEvent } from '@kernel/EventBus';
import { instructionProgram } from '@kernel/process/Program';
import type { ThreadControlBlock } from '@kernel/process/threads';
import { createRng } from '@kernel/rng';
import { SyncSubsystem } from '@kernel/sync/SyncSubsystem';
import type { Actor, SyncHost, SyncSettings } from '@kernel/sync/SyncSubsystem';
import { asPageId, asPid, asResourceId, asTick } from '@kernel/types';
import type { AddressSpaceId, DomainId, Pid, ProcessControlBlock, SyncSnapshotMemoryOrder, Tid } from '@kernel/types';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';

const A: Actor = { pid: asPid(3), tid: 3 as Tid };
const B: Actor = { pid: asPid(4), tid: 4 as Tid };
const C: Actor = { pid: asPid(5), tid: 5 as Tid };
const D: Actor = { pid: asPid(6), tid: 6 as Tid };
const ACTORS = [A, B, C, D];
const RESOURCE = asResourceId('atomic:lock');
const REGION = asResourceId('counter');
const CELL = 'region:counter';
const settings: SyncSettings = { progressStallLimit: 4, boundedWaitLimit: 0, spinWaitTicks: 1,
  storeBufferDepth: 2, priorityInheritance: false, rwlockPolicy: 'writer_pref',
  starvationThreshold: 120, starvationFatalThreshold: 300 };

function fixture(overrides: Partial<SyncSettings> = {}) {
  let tick = 0, value = 0;
  const events: EmittableEvent[] = [];
  const processes = new Map<Pid, ProcessControlBlock>();
  const threads = new Map<Tid, ThreadControlBlock>();
  for (const actor of ACTORS) {
    processes.set(actor.pid, { pid: actor.pid, parent: null, name: `P${actor.pid}`, state: 'running',
      priority: 1, basePriority: 1, arrivalTick: asTick(0), cpuBurstRemaining: 10000,
      serviceRemaining: 10000, totalCpuUsed: 0, readySince: null, lastScheduledTick: asTick(0),
      queueLevel: 0, addressSpaceId: actor.pid as unknown as AddressSpaceId, threads: [actor.tid],
      openFiles: [], heldResources: [], requestedResources: [], blockedOn: null,
      domain: 'user' as DomainId, exitCode: null, terminationReason: null, convoyMemberId: null });
    threads.set(actor.tid, { tid: actor.tid, pid: actor.pid, state: 'running', programCounter: 0,
      serviceRemaining: 10000, lwp: actor.tid, blockedOn: null });
  }
  const host: SyncHost = {
    tick: () => asTick(tick), process: pid => processes.get(pid), processes: () => [...processes.values()],
    thread: tid => threads.get(tid), actor: pid => ACTORS.find(actor => actor.pid === pid),
    block: (pid, reason, tid) => {
      const process = processes.get(pid), thread = threads.get(tid);
      if (process === undefined || thread === undefined) throw new Error('missing fixture actor');
      process.state = 'waiting'; process.blockedOn = reason; thread.state = 'waiting'; thread.blockedOn = reason;
    },
    emit: event => events.push(event), terminate: () => { throw new Error('unexpected termination'); },
    complete: () => { throw new Error('unexpected completion'); }, settings: () => ({ ...settings, ...overrides }),
    cell: binding => binding.kind === 'region' && binding.region === REGION ? { get: () => value, set: next => { value = next; } } : undefined,
  };
  const rng = createRng(REFERENCE_CONFIG.seed).fork('sync');
  const sync = new SyncSubsystem(host, rng);
  sync.addRegionCell(CELL, REGION);
  return {
    sync, rng, events, processes, threads,
    get tick() { return asTick(tick); }, get value() { return value; },
    clock(next: number) { tick = next; },
    attempt<T>(actor: Actor, work: () => T): T {
      tick += 1; sync.beginAttempt(actor);
      try { return work(); } finally { sync.endAttempt(actor); }
    },
  };
}

function preparedCopy(memory: SyncSnapshotMemoryOrder): SyncSnapshotMemoryOrder {
  return JSON.parse(JSON.stringify(memory)) as SyncSnapshotMemoryOrder;
}

describe('attempt-counted store buffers', () => {
  it('D=1 drains FIFO without consuming root/sync randomness', () => {
    const f = fixture(); f.sync.setMemoryOrder(A.pid, true, 1);
    const rng = f.rng.save();
    for (let next = 1; next <= 20; next += 1) {
      expect(f.attempt(A, () => f.sync.store(A, CELL, next))).toBe(true);
      expect(f.value).toBe(next);
    }
    expect(f.sync.memoryOrder.save().buffers[0]?.writes).toEqual([]);
    expect(f.rng.save()).toEqual(rng);
  });

  it('compute attempts drain at the configured cadence and loads forward only within the issuing process', () => {
    const f = fixture(); f.sync.setMemoryOrder(A.pid, true, 2);
    f.attempt(A, () => f.sync.store(A, CELL, 7));
    expect(f.value).toBe(0);
    expect(f.sync.load(A, CELL)).toBe(7); expect(f.sync.load(B, CELL)).toBe(0);
    f.attempt(A, () => undefined);
    expect(f.value).toBe(7);
  });

  it('D>1 shuffles address heads once, with precisely k-1 draws', () => {
    const f = fixture(); f.sync.addControlCell('flag', 0); f.sync.addControlCell('turn', 0);
    f.sync.setMemoryOrder(A.pid, true, 2);
    const expected = createRng(REFERENCE_CONFIG.seed).fork('sync');
    expected.shuffle(['flag', 'turn']);
    f.attempt(A, () => f.sync.store(A, 'flag', 1));
    f.attempt(A, () => f.sync.store(A, 'turn', 1));
    expect(f.rng.save()).toEqual(expected.save());
    expect(f.sync.memoryOrder.peek('flag') + f.sync.memoryOrder.peek('turn')).toBe(1);
    expect(f.sync.memoryOrder.save().buffers[0]?.writes).toHaveLength(1);
  });

  it('full buffers retry without allocating a write or violating per-address store order', () => {
    const f = fixture(); f.sync.setMemoryOrder(A.pid, true, 2);
    for (const value of [1, 2, 3]) expect(f.attempt(A, () => f.sync.store(A, CELL, value))).toBe(true);
    expect(f.value).toBe(1);
    const nextId = f.sync.memoryOrder.save().nextWriteId;
    expect(f.attempt(A, () => f.sync.store(A, CELL, 4))).toBe(false);
    expect(f.value).toBe(2); expect(f.sync.memoryOrder.save().nextWriteId).toBe(nextId);
    expect(f.attempt(A, () => f.sync.store(A, CELL, 4))).toBe(true);
    f.sync.memoryOrder.fence(A.pid);
    expect(f.value).toBe(4);
    expect(f.rng.save()).toEqual(createRng(REFERENCE_CONFIG.seed).fork('sync').save());
  });

  it('fences and atomic operations publish pending stores in issue order without a second ordinary drain', () => {
    const f = fixture(); f.sync.addControlCell('lock', 0); f.sync.setMemoryOrder(A.pid, true, 3);
    f.attempt(A, () => f.sync.store(A, CELL, 1)); f.attempt(A, () => f.sync.store(A, CELL, 2));
    const before = f.rng.save();
    f.attempt(A, () => { expect(f.sync.memoryOrder.tas(A, 'lock')).toBe(0); expect(f.value).toBe(2); });
    expect(f.sync.memoryOrder.save().buffers[0]?.writes).toEqual([]);
    expect(f.rng.save()).toEqual(before);
    f.attempt(A, () => f.sync.store(A, CELL, 3));
    f.attempt(A, () => f.sync.memoryOrder.fence(A.pid));
    expect(f.value).toBe(3);
  });

  it('process cleanup flushes outstanding shared stores before discarding the process buffer', () => {
    const f = fixture(); f.sync.setMemoryOrder(A.pid, true, 2);
    f.attempt(A, () => f.sync.store(A, CELL, 12));
    f.sync.memoryOrder.removeProcess(A.pid);
    expect(f.value).toBe(12); expect(f.sync.memoryOrder.save().buffers).toEqual([]);
  });

  it('restores pending RMW evidence and drain residue without restoring RNG or external cells', () => {
    const source = fixture(); source.sync.setMemoryOrder(A.pid, true, 2); source.sync.setMemoryOrder(B.pid, true, 2);
    source.attempt(A, () => source.sync.load(A, CELL, true));
    source.attempt(A, () => undefined);
    source.attempt(A, () => source.sync.store(A, CELL, 1, true));
    source.attempt(B, () => source.sync.load(B, CELL, true));
    const memory = source.sync.memoryOrder.save(), races = source.sync.raceDetector.save();
    const target = fixture(); target.clock(source.tick); target.rng.restore(source.rng.save());
    const before = target.rng.save(), original = target.sync.memoryOrder.save();
    const restoreMemory = target.sync.memoryOrder.prepareRestore(memory);
    const restoreRace = target.sync.raceDetector.prepareRestore(races, memory);
    expect(target.sync.memoryOrder.save()).toEqual(original); expect(target.value).toBe(0); expect(target.rng.save()).toEqual(before);
    restoreMemory(); restoreRace();
    for (const f of [source, target]) {
      f.attempt(B, () => f.sync.store(B, CELL, 1, true)); f.attempt(A, () => undefined);
    }
    expect(target.value).toBe(1); expect(target.sync.raceDetector.save().cells[0]?.serialValue).toBe(2);
    expect(target.events).toEqual(source.events.slice(-target.events.length));
    expect(target.sync.memoryOrder.save()).toEqual(source.sync.memoryOrder.save());
    expect(target.sync.raceDetector.save()).toEqual(source.sync.raceDetector.save());
    expect(target.rng.save()).toEqual(source.rng.save());
  });

  it('rejects malformed buffer state before mutating live values or RNG', () => {
    const f = fixture(); f.sync.setMemoryOrder(A.pid, true, 2);
    f.attempt(A, () => f.sync.store(A, CELL, 1));
    const state = f.sync.memoryOrder.save(), rng = f.rng.save();
    const buffer = state.buffers[0]; if (buffer === undefined) throw new Error('missing buffer');
    const write = buffer.writes[0]; if (write === undefined) throw new Error('missing write');
    const invalid: SyncSnapshotMemoryOrder[] = [
      { ...state, buffers: [{ ...buffer, depth: 0 }] },
      { ...state, buffers: [{ ...buffer, attemptResidue: 2 }] },
      { ...state, buffers: [{ ...buffer, writes: [write, write] }] },
      { ...state, buffers: [{ ...buffer, writes: [{ ...write, issuedAt: asTick(2) }] }] },
      { ...state, buffers: [{ ...buffer, pid: asPid(999) }] },
      { ...state, cells: [{ id: 'missing', kind: 'region', region: asResourceId('missing') }] },
    ];
    for (const bad of invalid) {
      expect(() => f.sync.memoryOrder.prepareRestore(preparedCopy(bad))).toThrow();
      expect(f.sync.memoryOrder.save()).toEqual(state); expect(f.rng.save()).toEqual(rng); expect(f.value).toBe(0);
    }
  });
});

describe('atomic primitives and bounded handoff', () => {
  it('TAS and successful CAS are indivisible; failed CAS leaves the word unchanged', () => {
    const f = fixture(); f.sync.addControlCell('word', 0);
    expect(f.attempt(A, () => f.sync.memoryOrder.tas(A, 'word'))).toBe(0);
    expect(f.attempt(B, () => f.sync.memoryOrder.tas(B, 'word'))).toBe(1);
    expect(f.attempt(B, () => f.sync.memoryOrder.cas(B, 'word', 0, 9))).toBe(1);
    expect(f.sync.memoryOrder.peek('word')).toBe(1);
    expect(f.attempt(A, () => f.sync.memoryOrder.cas(A, 'word', 1, 0))).toBe(1);
    expect(f.sync.memoryOrder.peek('word')).toBe(0);
  });

  it('100 interleaved CAS increments each retry to exactly 200 and produce no race reports', () => {
    const f = fixture();
    for (let index = 0; index < 100; index += 1) {
      const left = f.attempt(A, () => f.sync.memoryOrder.cas(A, CELL, 0, 0));
      let right = f.attempt(B, () => f.sync.memoryOrder.cas(B, CELL, 0, 0));
      expect(f.attempt(A, () => f.sync.memoryOrder.cas(A, CELL, left, left + 1))).toBe(left);
      const failed = f.attempt(B, () => f.sync.memoryOrder.cas(B, CELL, right, right + 1));
      expect(failed).not.toBe(right); right = failed;
      expect(f.attempt(B, () => f.sync.memoryOrder.cas(B, CELL, right, right + 1))).toBe(right);
    }
    expect(f.value).toBe(200); expect(f.events.filter(event => event.type === 'sync.race_detected')).toEqual([]);
  });

  it('mixing atomic writes with an unprotected ordinary RMW diagnoses the lost update', () => {
    const f = fixture(); const stale = f.attempt(A, () => f.sync.load(A, CELL, true));
    f.attempt(B, () => f.sync.memoryOrder.cas(B, CELL, 0, 1));
    f.attempt(A, () => f.sync.store(A, CELL, stale + 1, true));
    expect(f.value).toBe(1);
    expect(f.events.filter(event => event.type === 'sync.race_detected').at(-1)).toMatchObject({ race: { corruptedValue: 1, expectedValue: 2 } });
  });

  it('bounded CAS transfers ownership cyclically while the lock word remains set', () => {
    const f = fixture(); f.sync.createAtomicLock(RESOURCE, 'cas_bounded', ACTORS, 'lock');
    expect(f.attempt(A, () => f.sync.atomicAcquire(A, RESOURCE))).toBe(true);
    for (const actor of [B, C, D]) expect(f.attempt(actor, () => {
        const acquired = f.sync.atomicAcquire(actor, RESOURCE); if (!acquired) f.sync.spin(actor, RESOURCE); return acquired;
      })).toBe(false);
    let owner = A;
    for (const next of [B, C, D, A, B, C, D, A]) {
      f.attempt(owner, () => f.sync.atomicRelease(owner, RESOURCE));
      expect(f.sync.memoryOrder.peek('lock')).toBe(1);
      expect(f.sync.atomics.save()[0]).toMatchObject({ owner: next, handoff: next });
      expect(f.attempt(owner, () => f.sync.atomicAcquire(owner, RESOURCE))).toBe(false);
      expect(f.attempt(next, () => f.sync.atomicAcquire(next, RESOURCE))).toBe(true);
      expect(f.sync.atomics.held(next)).toEqual([RESOURCE]); owner = next;
    }
    expect(f.sync.allWaits().every(wait => wait.entriesObserved <= ACTORS.length - 1)).toBe(true);
    expect(f.events.some(event => event.type === 'process.starving')).toBe(false);
  });

  it('release flushes the owner payload before publishing a bounded handoff', () => {
    const f = fixture(); f.sync.createAtomicLock(RESOURCE, 'cas_bounded', [A, B], 'lock');
    f.sync.setMemoryOrder(A.pid, true, 4);
    f.attempt(A, () => f.sync.atomicAcquire(A, RESOURCE)); f.attempt(B, () => f.sync.atomicAcquire(B, RESOURCE));
    f.attempt(A, () => f.sync.store(A, CELL, 31)); expect(f.value).toBe(0);
    f.attempt(A, () => f.sync.atomicRelease(A, RESOURCE));
    expect(f.value).toBe(31); expect(f.sync.atomics.save()[0]?.handoff).toEqual(B);
  });

  it('SYNC-TAS-1: the pinned greedy reacquisition schedule demonstrates bounded-wait failure', () => {
    const f = fixture(); f.sync.createAtomicLock(RESOURCE, 'tas', ACTORS, 'lock');
    f.attempt(A, () => f.sync.atomicAcquire(A, RESOURCE));
    for (const actor of [B, C, D]) f.attempt(actor, () => f.sync.atomicAcquire(actor, RESOURCE));
    // This unit schedule explicitly gives A release/reacquire before B, C and D poll; it is not the RR fixture.
    for (let index = 0; index < 5; index += 1) {
      f.attempt(A, () => f.sync.atomicRelease(A, RESOURCE));
      expect(f.attempt(A, () => f.sync.atomicAcquire(A, RESOURCE))).toBe(true);
      for (const actor of [B, C, D]) expect(f.attempt(actor, () => {
        const acquired = f.sync.atomicAcquire(actor, RESOURCE); if (!acquired) f.sync.spin(actor, RESOURCE); return acquired;
      })).toBe(false);
    }
    expect(f.sync.allWaits().filter(wait => wait.entriesObserved > ACTORS.length - 1)).toHaveLength(3);
    expect(f.events.some(event => event.type === 'process.starving')).toBe(true);
    expect(f.events.filter(event => event.type === 'sync.busy_wait').length).toBeGreaterThan(0);
  });

  it('restores a pending handoff and rejects owner/control inconsistencies without mutation', () => {
    const f = fixture(); f.sync.createAtomicLock(RESOURCE, 'cas_bounded', [A, B], 'lock');
    f.attempt(A, () => f.sync.atomicAcquire(A, RESOURCE)); f.attempt(B, () => f.sync.atomicAcquire(B, RESOURCE));
    f.attempt(A, () => f.sync.atomicRelease(A, RESOURCE));
    const state = f.sync.atomics.save(), memory = f.sync.memoryOrder.save();
    const g = fixture(); g.clock(f.tick);
    const loadMemory = g.sync.memoryOrder.prepareRestore(memory), loadLocks = g.sync.atomics.prepareRestore(state, memory, f.tick, []);
    expect(g.sync.atomics.save()).toEqual([]); loadMemory(); loadLocks();
    expect(g.attempt(B, () => g.sync.atomicAcquire(B, RESOURCE))).toBe(true);
    const lock = state[0]; if (lock === undefined) throw new Error('missing atomic lock');
    const before = f.sync.atomics.save();
    expect(() => f.sync.atomics.prepareRestore([{ ...lock, owner: null }], memory, f.tick)).toThrow();
    expect(() => f.sync.atomics.prepareRestore([{ ...lock, contenders: [] }], memory, f.tick)).toThrow();
    expect(f.sync.atomics.save()).toEqual(before);
  });
});

it('100 scheduled spin ticks charge CPU and utilization but no service, PC, or counter progress', () => {
  const kernel = createKernel({ ...REFERENCE_CONFIG, scheduler: 'rr',
    schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1 }, enabledSubsystems: ['process', 'scheduler', 'sync'] },
  { threadCreateTicks: 0, contextSwitchTicks: 0 });
  const program = instructionProgram([{ kind: 'sync', operation: { op: 'scenario', scenario: 'spin', step: 0 } }]);
  const spawnActor = (name: string): Actor => {
    const pid = kernel.spawn({ name, priority: 1, burst: 1000, service: 1000, arrival: 0, pages: 0 }, { program, serialFraction: 1 });
    const tid = kernel.process(pid)?.threads[0]; if (tid === undefined) throw new Error('missing thread'); return { pid, tid };
  };
  const holder = spawnActor('holder'), spinner = spawnActor('spinner');
  kernel.syncSubsystem.createAtomicLock(RESOURCE, 'tas', [holder, spinner], 'lock');
  kernel.syncSubsystem.addScenario({ id: 'spin', kind: 'spinlock', resource: RESOURCE, criticalTicks: 1,
    remainderTicks: 0, iterationLimit: null, actors: [holder, spinner].map(actor => ({ actor, completedEntries: 0 })) });
  kernel.step(); kernel.blockProcess(holder.pid, { kind: 'sleep', untilTick: asTick(200) });
  const service = kernel.process(spinner.pid)?.serviceRemaining;
  const events = kernel.run(100);
  expect(kernel.process(spinner.pid)?.totalCpuUsed).toBe(100);
  expect(kernel.process(spinner.pid)?.serviceRemaining).toBe(service);
  expect(kernel.threads.table.get(spinner.tid)?.programCounter).toBe(0);
  expect(kernel.saveSchedulerState().payload.accounting.busyTicks / kernel.tick).toBe(1);
  expect(events.filter(event => event.type === 'sync.busy_wait')).toHaveLength(100);
  expect(events.filter(event => event.type === 'sync.busy_wait').at(-1)).toMatchObject({ pid: spinner.pid, spunTicks: 100 });
});


it('an interrupted two-tick spin finishes its cost before polling the newly free lock', () => {
  const f = fixture({ spinWaitTicks: 2 }); f.sync.createAtomicLock(RESOURCE, 'tas', [A, B], 'lock');
  f.sync.addScenario({ kind: 'spinlock', id: 'partial', resource: RESOURCE, criticalTicks: 1, remainderTicks: 0, iterationLimit: null,
    actors: [A, B].map(actor => ({ actor, completedEntries: 0 })) });
  const operation = { op: 'scenario', scenario: 'partial', step: 0 } as const;
  expect(f.attempt(A, () => f.sync.execute(A, operation)).advance).toBe(true);
  expect(f.attempt(B, () => f.sync.execute(B, operation)).deferService).toBe(true);
  f.attempt(A, () => f.sync.atomicRelease(A, RESOURCE));
  expect(f.attempt(B, () => f.sync.execute(B, operation)).deferService).toBe(true);
  expect(f.sync.atomics.save()[0]?.owner).toBeNull();
  expect(f.events.filter(event => event.type === 'sync.busy_wait')).toMatchObject([{ pid: B.pid, spunTicks: 2 }]);
  expect(f.attempt(B, () => f.sync.execute(B, operation)).advance).toBe(true);
});

it('cancels every dying sibling before a bounded owner can hand a lock back to that PID', () => {
  const f = fixture(); const sibling: Actor = { pid: A.pid, tid: 30 as Tid };
  const pcb = f.processes.get(A.pid); const thread = f.threads.get(A.tid); if (pcb === undefined || thread === undefined) throw new Error('missing actor');
  pcb.threads.push(sibling.tid); f.threads.set(sibling.tid, { ...thread, tid: sibling.tid });
  f.sync.createAtomicLock(RESOURCE, 'cas_bounded', [A, sibling, B], 'lock');
  f.sync.atomicAcquire(A, RESOURCE); f.sync.atomicAcquire(sibling, RESOURCE); f.sync.atomicAcquire(B, RESOURCE);
  f.sync.releaseAll(pcb);
  expect(f.sync.atomics.save()[0]?.owner).toEqual(B);
  expect(f.sync.allWaits().some(wait => wait.actor.pid === A.pid)).toBe(false);
});

it.each(['tas', 'cas_bounded'] as const)('%s keeps four scheduled contenders mutually exclusive for 5000 ticks', algorithm => {
  const kernel = createKernel({ ...REFERENCE_CONFIG, scheduler: 'rr', schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1 },
    enabledSubsystems: ['process', 'scheduler', 'sync'] }, { threadCreateTicks: 0 });
  const program = instructionProgram(Array.from({ length: 4 }, (_, step) => ({ kind: 'sync' as const, operation: { op: 'scenario' as const, scenario: 'four', step } })));
  const actors = [0, 1, 2, 3].map(index => {
    const pid = kernel.spawn({ name: `contender:${index}`, priority: 20, arrival: 0, burst: 100000, service: 100000, pages: 0 }, { program, serialFraction: 1 });
    const tid = kernel.process(pid)?.threads[0]; if (tid === undefined) throw new Error('missing actor'); return { pid, tid };
  });
  kernel.syncSubsystem.createAtomicLock(RESOURCE, algorithm, actors, 'lock');
  kernel.syncSubsystem.addScenario({ kind: 'spinlock', id: 'four', resource: RESOURCE, criticalTicks: 3, remainderTicks: 1, iterationLimit: null,
    actors: actors.map(actor => ({ actor, completedEntries: 0 })) });
  for (let tick = 0; tick < 5000; tick++) {
    kernel.step(); expect(kernel.syncSubsystem.requirements.state(RESOURCE)?.criticalActors.length).toBeLessThanOrEqual(1);
  }
  const state = kernel.syncSubsystem.scenario('four'); if (state.kind !== 'spinlock') throw new Error('missing scenario');
  expect(state.actors.every(actor => actor.completedEntries > 0)).toBe(true);
  if (algorithm === 'cas_bounded') expect(kernel.syncSubsystem.allWaits().every(wait => wait.entriesObserved <= 3)).toBe(true);
});

it('records exact CPU utilization for the same 100+100 increment workload under CAS and mutex', () => {
  const rows = (['cas', 'mutex'] as const).map(kind => {
    const kernel = createKernel({ ...REFERENCE_CONFIG, scheduler: 'rr', schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1 },
      enabledSubsystems: ['process', 'scheduler', 'sync'] }, { threadCreateTicks: 0 });
    const program = instructionProgram(Array.from({ length: 5 }, (_, step) => ({ kind: 'sync' as const, operation: { op: 'scenario' as const, scenario: 'increments', step } })));
    const actors = [0, 1].map(index => {
      const pid = kernel.spawn({ name: `counter:${index}`, priority: 20, arrival: 0, burst: 10000, service: 10000, pages: 1 }, { program, serialFraction: 1 });
      const tid = kernel.process(pid)?.threads[0]; if (tid === undefined) throw new Error('missing actor'); return { pid, tid };
    });
    const first = actors[0]; const pcb = first === undefined ? undefined : kernel.process(first.pid); if (pcb === undefined) throw new Error('missing backing process');
    kernel.ipc.createSharedRegion({ id: REGION, space: pcb.addressSpaceId, pages: [asPageId(0)], attached: [], value: 0 }); kernel.syncSubsystem.addRegionCell(CELL, REGION);
    if (kind === 'mutex') kernel.syncSubsystem.createMutex(RESOURCE);
    kernel.syncSubsystem.addScenario({ kind: 'counter', id: 'increments', cell: CELL,
      protection: kind === 'cas' ? { kind: 'cas' } : { kind: 'mutex', mutex: RESOURCE },
      actors: actors.map(actor => ({ actor, increments: 100, incrementBy: 1, completedIncrements: 0 })) });
    const events = kernel.run(2000);
    expect(kernel.ipc.sharedRegion(REGION)?.value).toBe(200); expect(events.some(event => event.type === 'sync.race_detected')).toBe(false);
    return { kind, busy: kernel.saveSchedulerState().payload.accounting.busyTicks, utilization: kernel.saveSchedulerState().payload.accounting.busyTicks / 2000 };
  });
  expect(rows).toEqual([{ kind: 'cas', busy: 1002, utilization: 0.501 }, { kind: 'mutex', busy: 1000, utilization: 0.5 }]);
});

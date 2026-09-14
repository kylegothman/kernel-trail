import { describe, expect, it, vi } from 'vitest';
import { createKernel } from '@kernel/Kernel';
import type { KernelImpl } from '@kernel/Kernel';
import { DeadlockSubsystem, deadlockSettings } from '@kernel/deadlock/DeadlockSubsystem';
import type { EmittableEvent } from '@kernel/EventBus';
import { instructionProgram } from '@kernel/process/Program';
import { createBoundedBuffer } from '@kernel/sync/scenarios/boundedBuffer';
import { createPhilosophers } from '@kernel/sync/scenarios/philosophers';
import type { DeadlockSnapshotState, KernelConfig, KernelEvent, Pid, Tick, Tid } from '@kernel/types';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';
import { detectMultipleInstances } from '@kernel/deadlock/detection';
import type { DetectionState } from '@kernel/deadlock/detection';
import { needMatrix } from '@kernel/deadlock/bankers';
import { KernelInvariantError } from '@kernel/errors';
import { asPid, asResourceId, asTick } from '@kernel/types';

function textbookDetection(): DetectionState {
  return {
    processes: [0, 1, 2, 3, 4].map(asPid), resources: ['A', 'B', 'C'].map(asResourceId),
    available: [0, 0, 0],
    allocation: [[0, 1, 0], [2, 0, 0], [3, 0, 3], [2, 1, 1], [0, 0, 2]],
    request: [[0, 0, 0], [2, 0, 2], [0, 0, 0], [1, 0, 0], [0, 0, 2]],
  };
}

describe('multiple-instance detection, Ch. 8.7.2', () => {
  it('DL-DETECT-1: zero Available is not a deadlock when current requests can finish', () => {
    const state = textbookDetection();
    const before = JSON.stringify(state);
    const result = detectMultipleInstances(state);
    expect(result.deadlocked).toEqual([]);
    expect(result.finishOrder).toEqual([0, 2, 1, 3, 4]);
    expect(result.finished).toEqual([true, true, true, true, true]);
    expect(result.trace).toEqual([
      { candidate: 0, work: [0, 1, 0] },
      { candidate: 2, work: [3, 1, 3] },
      { candidate: 1, work: [5, 1, 3] },
      { candidate: 3, work: [7, 2, 4] },
      { candidate: 4, work: [7, 2, 6] },
    ]);
    expect(result.work).toEqual([7, 2, 6]);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('DL-DETECT-2: P2 requesting one C instance leaves P1, P2, P3 and P4 deadlocked', () => {
    const initial = textbookDetection();
    const state = { ...initial, request: initial.request.map((row, i) => i === 2 ? [0, 0, 1] : [...row]) };
    const result = detectMultipleInstances(state);
    expect(result.deadlocked).toEqual([1, 2, 3, 4]);
    expect(result.finishOrder).toEqual([0]);
    expect(result.finished).toEqual([true, false, false, false, false]);
    expect(result.work).toEqual([0, 1, 0]);
    expect(result.trace).toEqual([{ candidate: 0, work: [0, 1, 0] }]);
  });

  it('uses outstanding Request, not the declared remaining Need', () => {
    const state = textbookDetection();
    const maximum = state.processes.map(() => [7, 2, 6]);
    const mistakenNeed = needMatrix(maximum, state.allocation);
    expect(detectMultipleInstances(state).deadlocked).toEqual([]);
    const incorrect = detectMultipleInstances({ ...state, request: mistakenNeed });
    expect(incorrect.deadlocked).toEqual([0, 1, 2, 3, 4]);
    expect(incorrect.finishOrder).toEqual([]);
    expect(incorrect.work).toEqual([0, 0, 0]);
  });

  it('marks an empty allocation finished initially even when its request cannot be satisfied', () => {
    const result = detectMultipleInstances({
      processes: [1, 2].map(asPid), resources: [asResourceId('A')], available: [0],
      allocation: [[0], [1]], request: [[100], [1]],
    });
    expect(result.finished).toEqual([true, false]);
    expect(result.deadlocked).toEqual([2]);
    expect(result.finishOrder).toEqual([]);
    expect(result.trace).toEqual([]);
    expect(result.work).toEqual([0]);
  });

  it('restarts at the lowest index after each returned allocation', () => {
    const result = detectMultipleInstances({
      processes: [1, 2, 3].map(asPid), resources: [asResourceId('A')], available: [0],
      allocation: [[1], [1], [1]], request: [[1], [2], [0]],
    });
    expect(result.finishOrder).toEqual([3, 1, 2]);
    expect(result.trace.map(step => step.work)).toEqual([[1], [2], [3]]);
    expect(result.deadlocked).toEqual([]);
  });

  it('handles no processes and zero resource columns', () => {
    expect(detectMultipleInstances({ processes: [], resources: [], available: [], allocation: [], request: [] }))
      .toEqual({ deadlocked: [], finishOrder: [], finished: [], work: [], trace: [] });
    expect(detectMultipleInstances({ processes: [asPid(1)], resources: [], available: [], allocation: [[]], request: [[]] }))
      .toEqual({ deadlocked: [], finishOrder: [], finished: [true], work: [], trace: [] });
  });

  it('rejects malformed or negative outstanding requests rather than treating them as zero', () => {
    expect(() => detectMultipleInstances({ ...textbookDetection(), request: [[0, 0, 0]] }))
      .toThrow(KernelInvariantError);
    const state = textbookDetection();
    expect(() => detectMultipleInstances({
      ...state, request: state.request.map((row, i) => i === 2 ? [0, -1, 0] : row),
    })).toThrow(KernelInvariantError);
  });
});


function scenarioKernel(strategy: KernelConfig['deadlockStrategy'] = 'detect', interval = 20, enabled = true) {
  return createKernel({ ...REFERENCE_CONFIG, scheduler: 'rr',
    schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1 }, deadlockStrategy: strategy,
    enabledSubsystems: enabled ? ['process', 'scheduler', 'sync', 'deadlock'] : ['process', 'scheduler', 'sync'],
  }, { threadCreateTicks: 0, contextSwitchTicks: 0, deadlockDetectionInterval: interval, deadlockRecovery: 'none' });
}

const fourConditions = ['mutual_exclusion', 'hold_and_wait', 'no_preemption', 'circular_wait'];

describe('deadlock detection through the real phase-nine dispatch', () => {
  it('SYNC-BB-DEADLOCK confirms a two-process witness only after every consumer is trapped', () => {
    const kernel = scenarioKernel();
    const state = createBoundedBuffer(kernel, { variant: 'wrong_order' });
    const detected: Extract<KernelEvent, { type: 'deadlock.detected' }>[] = [];
    const resolved: KernelEvent[] = [];
    kernel.events.on('deadlock.detected', event => detected.push(event));
    kernel.events.on('deadlock.resolved', event => resolved.push(event));
    kernel.run(200);
    const report = detected[0]?.report;
    expect(report).toBeDefined();
    expect(report?.cycle).toHaveLength(2);
    expect(report?.conditions).toEqual(fourConditions);
    expect(report?.resources).toEqual([state.empty, state.mutex].sort());
    expect(report?.cycle.some(pid => state.actors.some(row => row.actor.pid === pid && row.role === 'producer'))).toBe(true);
    expect(report?.cycle.some(pid => state.actors.some(row => row.actor.pid === pid && row.role === 'consumer'))).toBe(true);
    const proof = kernel.deadlockSubsystem.saveState().deadlock.payload.lastDetection;
    const signalers = proof?.dependencies.find(dependency => dependency.source.kind === 'sync_wait' && dependency.source.resource === state.empty);
    expect(signalers?.alternatives).toEqual(state.actors.filter(row => row.role === 'consumer').map(row => row.actor));
    expect(resolved).toEqual([]);
  });

  it('SYNC-PHIL-NAIVE emits one five-process cycle at the first detection interval after tick 61', () => {
    const kernel = scenarioKernel();
    const state = createPhilosophers(kernel, { solution: 'naive' });
    const detected: Extract<KernelEvent, { type: 'deadlock.detected' }>[] = [];
    kernel.events.on('deadlock.detected', event => detected.push(event));
    kernel.run(200);
    expect(detected).toHaveLength(1);
    expect(detected[0]?.report).toMatchObject({ tick: 80, cycle: state.actors.map(row => row.actor.pid), conditions: fourConditions });
    expect(kernel.deadlockSubsystem.saveState().deadlock.payload.lastDetection?.actorCycle).toEqual(state.actors.map(row => row.actor));
  });

  it.each(['asymmetric', 'room', 'monitor'] as const)('SYNC-PHIL %s completes meals without a detection for 20,000 ticks', solution => {
    const kernel = scenarioKernel();
    const state = createPhilosophers(kernel, { solution });
    const detected: KernelEvent[] = [];
    const panics: KernelEvent[] = [];
    kernel.events.on('deadlock.detected', event => detected.push(event));
    kernel.events.on('kernel.panic', event => panics.push(event));
    kernel.run(20_000);
    const final = kernel.syncSubsystem.scenario(state.id);
    if (final.kind !== 'philosophers') throw new Error('missing philosophers');
    expect(final.actors.reduce((sum, row) => sum + row.meals, 0)).toBeGreaterThan(0);
    expect(detected).toEqual([]);
    expect(panics).toEqual([]);
    expect(kernel.deadlockSubsystem.saveState().deadlock.payload.statistics.deadlocks).toBe(0);
  });

  it('calls maybeDetect only on interval ticks, while observation continues between them', () => {
    const kernel = scenarioKernel('detect', 40);
    createPhilosophers(kernel, { solution: 'naive' });
    const calls: Tick[] = [];
    const original = kernel.deadlockSubsystem.maybeDetect.bind(kernel.deadlockSubsystem);
    const spy = vi.spyOn(kernel.deadlockSubsystem, 'maybeDetect').mockImplementation(tick => { calls.push(tick); original(tick); });
    kernel.run(119);
    expect(calls).toEqual([40, 80]);
    const saved = kernel.deadlockSubsystem.saveState().deadlock.payload;
    expect(saved.lastObservationTick).toBe(119);
    expect(saved.statistics.deadlocks).toBe(1);
    spy.mockRestore();
  });

  it.each(['ignore', 'avoid'] as const)('%s observes the same stalled scenario without automatic cycle detection', strategy => {
    const kernel = scenarioKernel(strategy);
    createPhilosophers(kernel, { solution: 'naive' });
    const calls = vi.spyOn(kernel.deadlockSubsystem, 'maybeDetect');
    const detected: KernelEvent[] = [];
    kernel.events.on('deadlock.detected', event => detected.push(event));
    kernel.run(1000);
    expect(calls).not.toHaveBeenCalled();
    expect(detected).toEqual([]);
    expect(kernel.deadlockSubsystem.saveState().deadlock.payload.statistics.deadlocks).toBe(0);
    calls.mockRestore();
  });

  it('the disabled deadlock subsystem is never called by phase nine', () => {
    const kernel = scenarioKernel('detect', 20, false);
    createPhilosophers(kernel, { solution: 'naive' });
    const calls = vi.spyOn(kernel.deadlockSubsystem, 'maybeDetect');
    kernel.run(200);
    expect(calls).not.toHaveBeenCalled();
    calls.mockRestore();
  });

  it('detects a mixed resource-table and mutex cycle without pruning the zero-Request mutex waiter', () => {
    const kernel = scenarioKernel();
    const resource = asResourceId('mixed:R'), lock = asResourceId('mixed:lock');
    kernel.deadlockSubsystem.declare({ id: resource, displayName: 'R', totalInstances: 1, preemptible: false });
    kernel.syncSubsystem.createMutex(lock);
    const first = kernel.spawn({ name: 'resource-first', priority: 20, arrival: 0, burst: 1000, service: 1000, pages: 0 }, {
      program: instructionProgram([
        { kind: 'syscall', call: { name: 'request', pid: asPid(0), args: [resource, 1] } },
        { kind: 'syscall', call: { name: 'mutex_lock', pid: asPid(0), args: [lock] } },
      ]),
    });
    const second = kernel.spawn({ name: 'mutex-first', priority: 20, arrival: 0, burst: 1000, service: 1000, pages: 0 }, {
      program: instructionProgram([
        { kind: 'syscall', call: { name: 'mutex_lock', pid: asPid(0), args: [lock] } },
        { kind: 'syscall', call: { name: 'request', pid: asPid(0), args: [resource, 1] } },
      ]),
    });
    const detected: Extract<KernelEvent, { type: 'deadlock.detected' }>[] = [];
    kernel.events.on('deadlock.detected', event => detected.push(event));
    kernel.run(20);
    expect(detected[0]?.report).toMatchObject({ cycle: [first, second], conditions: fourConditions });
    expect(detected[0]?.report.resources).toEqual([resource, lock].sort());
  });
});

const savedA = asResourceId('saved:A'), savedB = asResourceId('saved:B');

function stalledResourceKernel() {
  const kernel = scenarioKernel();
  for (const resource of [savedA, savedB]) kernel.declareResource({ id: resource, displayName: resource, totalInstances: 1, preemptible: false });
  const actors = [[savedA, savedB], [savedB, savedA]].map((resources, i) => {
    const pid = kernel.spawn({ name: `saved-${i}`, priority: 20, arrival: 0, burst: 1000, service: 1000, pages: 0 }, {
      program: instructionProgram(resources.map(resource => ({ kind: 'syscall', call: { name: 'request', pid: asPid(0), args: [resource ?? savedA, 1] } }))),
    });
    kernel.declareClaims(pid, [[savedA, 1], [savedB, 1]]);
    return pid;
  });
  kernel.run(24);
  expect(actors.every(pid => kernel.process(pid)?.state === 'waiting')).toBe(true);
  expect(kernel.deadlockSubsystem.saveState().deadlock.payload.statistics.deadlocks).toBe(1);
  return { kernel, actors };
}

/** Independent owner copies model WP-11's staged tables, without pretending to restore a full kernel. */
function stagedDeadlockOwner(kernel: KernelImpl) {
  let tick = kernel.tick;
  const processes = kernel.table.processes.filter(pcb => pcb.pid > 1).map(pcb => structuredClone(pcb));
  const threads = [...kernel.threads.table.values()].filter(thread => thread.pid > 1).map(thread => structuredClone(thread));
  const events: EmittableEvent[] = [], completed: Pid[] = [];
  const subsystem = new DeadlockSubsystem({
    tick: () => tick, strategy: () => kernel.config.deadlockStrategy, settings: () => deadlockSettings(kernel.tuning),
    processes: () => processes, process: pid => processes.find(pcb => pcb.pid === pid), threads: () => threads,
    actor: pid => { const thread = threads.find(row => row.pid === pid); return thread === undefined ? undefined : { pid, tid: thread.tid }; },
    program: pid => kernel.program(pid), sync: kernel.syncSubsystem, ipc: kernel.ipc,
    block: () => { throw new Error('this continuation only restores existing waits'); },
    complete: pid => completed.push(pid),
    terminate: () => { throw new Error('recovery is disabled for this continuation'); },
    rollback: () => { throw new Error('recovery is disabled for this continuation'); },
    emit: event => events.push(event),
  });
  return { subsystem, processes, threads, events, completed, setTick(value: Tick) { tick = value; } };
}

describe('deadlock snapshot continuation and staged validation', () => {
  it('restores a blocked witness into an independent owner and continues clocks, episode identity and integer statistics', () => {
    const { kernel } = stalledResourceKernel();
    kernel.setPreemptible(savedA, true, asTick(30));
    const saved = kernel.deadlockSubsystem.saveState().deadlock;
    const target = stagedDeadlockOwner(kernel);
    const before = target.subsystem.saveState();
    const ownersBefore = structuredClone([target.processes, target.threads]);
    const commit = target.subsystem.prepareRestore(saved);
    expect(target.subsystem.saveState()).toEqual(before);
    expect([target.processes, target.threads]).toEqual(ownersBefore);
    expect(target.events).toEqual([]);
    commit();
    expect(target.subsystem.saveState().deadlock).toEqual(saved);
    expect(target.subsystem.resources.resources).not.toBe(kernel.deadlockSubsystem.resources.resources);
    expect(Object.isFrozen(saved.payload.requests[0]?.resources)).toBe(true);
    expect(Object.isFrozen(saved.payload.lastDetection?.report)).toBe(true);
    for (let i = 0; i < 16; i += 1) {
      kernel.step(); target.setTick(kernel.tick);
      target.subsystem.onPhase(1, kernel.tick);
      target.subsystem.onPhase(9, kernel.tick);
      if (kernel.tick % kernel.tuning.deadlockDetectionInterval === 0) target.subsystem.maybeDetect(kernel.tick);
      target.subsystem.onPhase(11, kernel.tick);
      expect(target.subsystem.saveState()).toEqual(kernel.deadlockSubsystem.saveState());
    }
    expect(target.subsystem.resources.get(savedA)?.preemptible).toBe(false);
    expect(target.subsystem.saveState().deadlock.payload.statistics.deadlocks).toBe(1);
    expect(target.events).toEqual([]);
    expect(saved.payload.preemptibilityOverrides).toHaveLength(1);
  });

  it('keeps a reserved atomic vector allocated once, readiness pure and generations monotonic after wake', () => {
    const kernel = scenarioKernel();
    for (const resource of [savedA, savedB]) kernel.declareResource({ id: resource, displayName: resource, totalInstances: 1, preemptible: false });
    const owner = kernel.spawn({ name: 'vector holder', priority: 20, arrival: 0, burst: 1000, service: 1000, pages: 0 });
    const waiter = kernel.spawn({ name: 'vector waiter', priority: 20, arrival: 0, burst: 1000, service: 1000, pages: 0 });
    const dispatch = (pid: Pid) => { for (let i = 0; i < 10 && kernel.process(pid)?.state !== 'running'; i += 1) kernel.step(); expect(kernel.process(pid)?.state).toBe('running'); };
    dispatch(owner);
    expect(kernel.syscall({ pid: owner, name: 'request', args: [savedA, 1, savedB, 1] }).ok).toBe(true);
    dispatch(waiter);
    expect(kernel.syscall({ pid: waiter, name: 'request', args: [savedA, 1, savedB, 1] })).toMatchObject({ ok: false, errno: 'EAGAIN' });
    expect(kernel.syscall({ pid: owner, name: 'release', args: [savedA, 1] }).ok).toBe(true);
    expect(kernel.process(waiter)?.heldResources).toEqual([]);
    expect(kernel.syscall({ pid: owner, name: 'release', args: [savedB, 1] }).ok).toBe(true);
    const saved = kernel.deadlockSubsystem.saveState().deadlock;
    expect(saved.payload.requests[0]?.grantedAt).toBe(kernel.tick);
    const target = stagedDeadlockOwner(kernel);
    target.subsystem.prepareRestore(saved)();
    const actor = saved.payload.requests[0]?.actor;
    if (actor === undefined) throw new Error('missing reserved actor');
    const before = target.subsystem.saveState();
    expect(target.subsystem.isSatisfied(waiter, { kind: 'semaphore', resource: savedA }, actor.tid)).toBe(true);
    expect(target.subsystem.isSatisfied(waiter, { kind: 'semaphore', resource: savedA }, actor.tid)).toBe(true);
    expect(target.subsystem.saveState()).toEqual(before);
    expect(target.processes.find(pcb => pcb.pid === waiter)?.heldResources).toEqual([savedA, savedB]);
    expect(target.subsystem.resources.resources.map(resource => resource.availableInstances)).toEqual([0, 0]);
    const pcb = target.processes.find(row => row.pid === waiter), thread = target.threads.find(row => row.tid === actor.tid);
    if (pcb === undefined || thread === undefined) throw new Error('missing staged waiter');
    Object.assign(pcb, { state: 'ready', blockedOn: null }); thread.state = 'ready'; thread.blockedOn = null;
    target.setTick(asTick(kernel.tick + 1)); target.subsystem.onPhase(9, asTick(kernel.tick + 1));
    expect(target.subsystem.saveState().deadlock.payload.requests).toEqual([]);
    expect(target.subsystem.saveState().deadlock.payload.nextRequestGeneration).toBe(saved.payload.nextRequestGeneration);
    expect(target.completed).toEqual([]);
  });

  const malformed: readonly [string, (saved: DeadlockSnapshotState) => void][] = [
    ['owner', saved => Object.assign(saved, { owner: 'sync' })],
    ['version', saved => Object.assign(saved, { version: 2 })],
    ['clock', saved => Object.assign(saved.payload, { tick: -1 })],
    ['tuning', saved => Object.assign(saved.payload.settings, { deadlockDetectionInterval: 1 })],
    ['generation', saved => Object.assign(saved.payload, { nextRequestGeneration: 0 })],
    ['actor', saved => Object.assign(saved.payload.requests[0] ?? {}, { actor: { pid: asPid(2), tid: 999 as Tid } })],
    ['duplicate vector', saved => Object.assign(saved.payload.requests[0] ?? {}, { resources: [[savedB, 1], [savedB, 1]] })],
    ['duplicate request', saved => Object.assign(saved.payload, { requests: [...saved.payload.requests, saved.payload.requests[0]] })],
    ['reservation exceeds holdings', saved => Object.assign(saved.payload.requests[0] ?? {}, { grantedAt: saved.payload.tick })],
    ['rank', saved => Object.assign(saved.payload.ranks[0] ?? {}, { resource: asResourceId('undeclared') })],
    ['expired override', saved => Object.assign(saved.payload, { preemptibilityOverrides: [{ resource: savedA, preemptible: true, untilTick: saved.payload.tick }] })],
    ['checkpoint identity', saved => Object.assign(saved.payload.checkpoints[0] ?? {}, { tid: 999 as Tid })],
    ['missing observation', saved => Object.assign(saved.payload, { observations: [] })],
    ['statistics', saved => Object.assign(saved.payload.statistics, { occupiedInstanceTicks: Number.MAX_SAFE_INTEGER })],
    ['incomplete Coffman evidence', saved => Object.assign(saved.payload.lastDetection?.report ?? {}, { conditions: ['circular_wait'] })],
    ['wrong projected cycle', saved => Object.assign(saved.payload.lastDetection?.report ?? {}, { cycle: [asPid(777)] })],
    ['unclosed OR alternative', saved => {
      const row = saved.payload.lastDetection?.dependencies[0];
      if (row === undefined) throw new Error('missing witness');
      Object.assign(row, { alternatives: [...row.alternatives, { pid: asPid(777), tid: 777 as Tid }] });
    }],
    ['non-JSON object', saved => Object.assign(saved.payload, { requests: new Map() })],
  ];
  it.each(malformed)('rejects %s without mutating live state, staged owners or emitting events', (_label, corrupt) => {
    const { kernel } = stalledResourceKernel();
    const target = stagedDeadlockOwner(kernel);
    const valid = kernel.deadlockSubsystem.saveState().deadlock;
    target.subsystem.prepareRestore(valid)();
    const before = target.subsystem.saveState(), owners = structuredClone([target.processes, target.threads]);
    const bad = structuredClone(valid); corrupt(bad);
    expect(() => target.subsystem.prepareRestore(bad)).toThrow();
    expect(target.subsystem.saveState()).toEqual(before);
    expect([target.processes, target.threads]).toEqual(owners);
    expect(target.events).toEqual([]);
  });

  it('validates I-26 using historical evidence after recovery has removed a victim and its live dependencies', () => {
    const kernel = createKernel({ ...REFERENCE_CONFIG, scheduler: 'rr', deadlockStrategy: 'detect',
      schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1 }, enabledSubsystems: ['process', 'scheduler', 'sync', 'deadlock'],
    }, { threadCreateTicks: 0, contextSwitchTicks: 0, deadlockRecovery: 'abort_one' });
    createPhilosophers(kernel, { solution: 'naive' }); kernel.run(80);
    const saved = kernel.deadlockSubsystem.saveState().deadlock;
    expect(saved.payload.statistics.processesLost).toBeGreaterThan(0);
    expect(saved.payload.lastDetection).not.toBeNull();
    const target = stagedDeadlockOwner(kernel);
    target.subsystem.prepareRestore(saved)();
    expect(target.subsystem.saveState().deadlock).toEqual(saved);
    expect(() => target.subsystem.assertInvariants()).not.toThrow();
  });
});

describe('witness isolation and prevention transition regressions', () => {
  function spawnMutexCycle(kernel: ReturnType<typeof createKernel>, prefix: string, arrival: number) {
    const left = asResourceId(`${prefix}:left`), right = asResourceId(`${prefix}:right`);
    kernel.syncSubsystem.createMutex(left); kernel.syncSubsystem.createMutex(right);
    const spawn = (first: typeof left, second: typeof left) => kernel.spawn({ name: `${prefix}:${first}`, priority: 20,
      arrival, burst: 1000, service: 1000, pages: 0 }, { program: instructionProgram([
      { kind: 'syscall', call: { name: 'mutex_lock', pid: asPid(0), args: [first] } },
      { kind: 'syscall', call: { name: 'mutex_lock', pid: asPid(0), args: [second] } },
    ]) });
    return { pids: [spawn(left, right), spawn(right, left)], resources: [left, right] };
  }

  it('an unrelated later cycle and incoming tail leave the first witness episode and latency unchanged', () => {
    const kernel = scenarioKernel();
    const early = spawnMutexCycle(kernel, 'early', 0);
    spawnMutexCycle(kernel, 'late', 30);
    const resource = early.resources[0]; if (resource === undefined) throw new Error('missing early lock');
    kernel.spawn({ name: 'incoming tail', priority: 20, arrival: 35, burst: 1000, service: 1000, pages: 0 }, {
      program: instructionProgram([{ kind: 'syscall', call: { name: 'mutex_lock', pid: asPid(0), args: [resource] } }]),
    });
    const detected: Extract<KernelEvent, { type: 'deadlock.detected' }>[] = [];
    kernel.events.on('deadlock.detected', event => detected.push(event));
    kernel.run(20);
    expect(detected).toHaveLength(1);
    expect(detected[0]?.report).toMatchObject({ tick: 20, cycle: early.pids, resources: early.resources });
    expect(kernel.deadlockSubsystem.averageDetectionLatency()).toBe(16);
    const first = kernel.deadlockSubsystem.saveState().deadlock.payload;
    kernel.run(20);
    const later = kernel.deadlockSubsystem.saveState().deadlock.payload;
    expect(detected).toHaveLength(1);
    expect(later.statistics).toMatchObject({ deadlocks: 1, detectionSamples: 1, detectionLatencyTicks: 16 });
    expect(later.confirmedEpisodes).toEqual(first.confirmedEpisodes);
    expect(later.lastDetection?.dependencies).toEqual(first.lastDetection?.dependencies);
    expect(later.observations.length).toBeGreaterThan(first.observations.length);
  });

  it('a switch into ordering rejects a pre-existing sync rank violation without changing strategy', () => {
    const kernel = scenarioKernel('ignore');
    spawnMutexCycle(kernel, 'existing', 0);
    kernel.run(4);
    const before = kernel.deadlockSubsystem.saveState();
    expect(() => kernel.setDeadlockStrategy('prevent')).toThrow(KernelInvariantError);
    expect(kernel.config.deadlockStrategy).toBe('ignore');
    expect(kernel.deadlockSubsystem.saveState()).toEqual(before);
    expect(kernel.syncSubsystem.allWaits()).toHaveLength(2);
  });

  it('all-or-nothing rejects a partial existing queued claim at the strategy boundary', () => {
    const kernel = createKernel({ ...REFERENCE_CONFIG, scheduler: 'rr', deadlockStrategy: 'ignore',
      schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1 },
      enabledSubsystems: ['process', 'scheduler', 'sync', 'deadlock'],
    }, { threadCreateTicks: 0, deadlockRecovery: 'none', preventionMode: 'all_or_nothing' });
    const a = asResourceId('claim:A'), b = asResourceId('claim:B');
    for (const id of [a, b]) kernel.declareResource({ id, displayName: id, totalInstances: 1, preemptible: false });
    const first = kernel.spawn({ name: 'partial claim', priority: 20, arrival: 0, burst: 1000, service: 1000, pages: 0 }, {
      program: instructionProgram([
        { kind: 'syscall', call: { name: 'request', pid: asPid(0), args: [a, 1] } },
        { kind: 'syscall', call: { name: 'request', pid: asPid(0), args: [b, 1] } },
      ]),
    });
    const second = kernel.spawn({ name: 'B holder', priority: 20, arrival: 0, burst: 1000, service: 1000, pages: 0 }, {
      program: instructionProgram([{ kind: 'syscall', call: { name: 'request', pid: asPid(0), args: [b, 1] } }]),
    });
    kernel.declareClaims(first, [[a, 1], [b, 1]]); kernel.declareClaims(second, [[b, 1]]);
    kernel.run(4);
    expect(kernel.process(first)).toMatchObject({ state: 'waiting', heldResources: [a], requestedResources: [b] });
    expect(() => kernel.setDeadlockStrategy('prevent')).toThrow(KernelInvariantError);
    expect(kernel.config.deadlockStrategy).toBe('ignore');
  });

  it('all-or-nothing permits a complete queued claim with no holdings when switching strategy', () => {
    const kernel = createKernel({ ...REFERENCE_CONFIG, scheduler: 'rr', deadlockStrategy: 'ignore',
      schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1 },
      enabledSubsystems: ['process', 'scheduler', 'sync', 'deadlock'],
    }, { threadCreateTicks: 0, deadlockRecovery: 'none', preventionMode: 'all_or_nothing' });
    const a = asResourceId('complete:A'), b = asResourceId('complete:B');
    for (const id of [a, b]) kernel.declareResource({ id, displayName: id, totalInstances: 1, preemptible: false });
    const holder = kernel.spawn({ name: 'full B claim', priority: 20, arrival: 0, burst: 1000, service: 1000, pages: 0 }, {
      program: instructionProgram([{ kind: 'syscall', call: { name: 'request', pid: asPid(0), args: [b, 1] } }]),
    });
    const waiter = kernel.spawn({ name: 'full A+B claim', priority: 20, arrival: 0, burst: 1000, service: 1000, pages: 0 }, {
      program: instructionProgram([{ kind: 'syscall', call: { name: 'request', pid: asPid(0), args: [a, 1, b, 1] } }]),
    });
    kernel.declareClaims(holder, [[b, 1]]); kernel.declareClaims(waiter, [[a, 1], [b, 1]]);
    kernel.run(2);
    expect(kernel.process(waiter)).toMatchObject({ state: 'waiting', heldResources: [], requestedResources: [a, b] });
    expect(() => kernel.setDeadlockStrategy('prevent')).not.toThrow();
    expect(kernel.config.deadlockStrategy).toBe('prevent');
    expect(kernel.syscall({ pid: holder, name: 'release', args: [b, 1] }).ok).toBe(true);
    expect(() => kernel.step()).not.toThrow();
    expect(kernel.process(waiter)?.heldResources).toEqual([a, b]);
  });
});

describe('all-or-nothing actor serialization', () => {
  function duplicateClaimFixture(strategy: KernelConfig['deadlockStrategy']) {
    const kernel = createKernel({ ...REFERENCE_CONFIG, scheduler: 'rr', deadlockStrategy: strategy,
      schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1 },
      enabledSubsystems: ['process', 'scheduler', 'sync', 'deadlock'],
    }, { threadCreateTicks: 0, deadlockRecovery: 'none', preventionMode: 'all_or_nothing' });
    const resource = asResourceId('sibling:resource');
    kernel.declareResource({ id: resource, displayName: resource, totalInstances: 1, preemptible: false });
    const program = instructionProgram([{ kind: 'syscall', call: { name: 'request', pid: asPid(0), args: [resource, 1] } }]);
    const holder = kernel.spawn({ name: 'outside holder', priority: 20, arrival: 0, burst: 1000, service: 1000, pages: 0 }, { program });
    const waiter = kernel.spawn({ name: 'two sibling claimants', priority: 20, arrival: 0, burst: 1000, service: 1000, pages: 0 }, { program, threadCount: 2 });
    kernel.declareClaims(holder, [[resource, 1]]); kernel.declareClaims(waiter, [[resource, 1]]);
    kernel.run(4);
    return { kernel, holder, waiter, resource };
  }

  it('rejects a sibling full-claim request while the same PID already has a queued claim', () => {
    const { kernel, holder, waiter, resource } = duplicateClaimFixture('prevent');
    expect(kernel.deadlockSubsystem.saveState().deadlock.payload.requests.filter(row => row.actor.pid === waiter)).toHaveLength(1);
    expect(kernel.lastSyscallResult(waiter)).toMatchObject({ ok: false, errno: 'EDEADLK' });
    expect(kernel.syscall({ pid: holder, name: 'release', args: [resource, 1] }).ok).toBe(true);
    expect(() => kernel.step()).not.toThrow();
  });

  it('rejects a switch with pre-existing duplicate sibling full claims without changing state', () => {
    const { kernel, waiter } = duplicateClaimFixture('ignore');
    const before = kernel.deadlockSubsystem.saveState();
    expect(before.deadlock.payload.requests.filter(row => row.actor.pid === waiter)).toHaveLength(2);
    expect(() => kernel.setDeadlockStrategy('prevent')).toThrow(KernelInvariantError);
    expect(kernel.config.deadlockStrategy).toBe('ignore');
    expect(kernel.deadlockSubsystem.saveState()).toEqual(before);
  });
});

describe('closed mailbox protocol persistence', () => {
  it('uses declared peers and actual IPC waits for a rendezvous cycle, then restores the branded endpoints', () => {
    const kernel = scenarioKernel();
    const left = asResourceId('protocol:left'), right = asResourceId('protocol:right');
    kernel.ipc.createMailbox(left, 0); kernel.ipc.createMailbox(right, 0);
    const first = kernel.spawn({ name: 'send left first', priority: 20, arrival: 0, burst: 1000, service: 1000, pages: 0 });
    const second = kernel.spawn({ name: 'send right first', priority: 20, arrival: 0, burst: 1000, service: 1000, pages: 0 });
    const actor = (pid: Pid) => {
      const tid = kernel.process(pid)?.threads[0];
      if (tid === undefined) throw new Error('missing protocol thread');
      return { pid, tid };
    };
    kernel.deadlockSubsystem.declareMailboxEndpoints(left, [actor(first)], [actor(second)]);
    kernel.deadlockSubsystem.declareMailboxEndpoints(right, [actor(second)], [actor(first)]);
    expect(() => kernel.declareResource({ id: left, displayName: 'collision', totalInstances: 1, preemptible: false })).toThrow();
    expect(() => kernel.syncSubsystem.createMutex(right)).toThrow();
    expect(kernel.detectDeadlock()).toBeNull();
    for (const [pid, mailbox] of [[first, left], [second, right]] as const) {
      for (let i = 0; i < 10 && kernel.process(pid)?.state !== 'running'; i += 1) kernel.step();
      expect(kernel.ipc.send(pid, mailbox, 42, kernel.tick).ok).toBe(true);
    }
    const report = kernel.detectDeadlock();
    expect(report).toMatchObject({ cycle: [first, second], conditions: fourConditions });
    expect(report?.resources).toEqual(['mbox:protocol:left:send', 'mbox:protocol:right:send']);
    const saved = kernel.deadlockSubsystem.saveState().deadlock;
    const target = stagedDeadlockOwner(kernel);
    target.subsystem.prepareRestore(saved)();
    expect(target.subsystem.saveState().deadlock).toEqual(saved);
    expect(target.subsystem.detectDeadlock()).toEqual(report);
    expect(target.events).toEqual([]);
    const corrupted = structuredClone(saved);
    Object.assign(corrupted.payload.mailboxEndpoints[0] ?? {}, { mailbox: asResourceId('missing') });
    expect(() => target.subsystem.prepareRestore(corrupted)).toThrow(/mailbox/);
    expect(target.subsystem.saveState().deadlock).toEqual(saved);
  });
});

function cycleAtTickTwentyThree() {
  const kernel = scenarioKernel('detect', 20);
  const a = asResourceId('latency:a'), b = asResourceId('latency:b');
  for (const id of [a, b]) kernel.declareResource({ id, displayName: id, totalInstances: 1, preemptible: false });
  const first = kernel.spawn({ name: 'latency first', priority: 20, arrival: 0, burst: 1000, service: 1000, pages: 0 }, {
    program: instructionProgram([
      { kind: 'syscall', call: { name: 'request', pid: asPid(0), args: [a, 1] } },
      { kind: 'syscall', call: { name: 'request', pid: asPid(0), args: [b, 1] } },
    ]),
  });
  const second = kernel.spawn({ name: 'latency second', priority: 20, arrival: 0, burst: 1000, service: 1000, pages: 0 }, {
    program: instructionProgram([
      { kind: 'syscall', call: { name: 'request', pid: asPid(0), args: [b, 1] } },
      // The first actor blocks at tick 3; these compute ticks run from 4 through 22.
      ...Array.from({ length: 19 }, () => ({ kind: 'compute' as const })),
      { kind: 'syscall', call: { name: 'request', pid: asPid(0), args: [a, 1] } },
    ]),
  });
  const detected: Extract<KernelEvent, { type: 'deadlock.detected' }>[] = [];
  kernel.events.on('deadlock.detected', event => detected.push(event));
  return { kernel, first, second, detected };
}

describe('exact detection interval and latency', () => {
  it('a cycle closing at tick 23 is first detected at tick 40 with latency exactly 17', () => {
    const { kernel, first, second, detected } = cycleAtTickTwentyThree();
    kernel.run(22);
    expect(kernel.process(first)?.state).toBe('waiting');
    expect(kernel.process(second)?.state).toBe('running');
    expect(detected).toEqual([]);
    kernel.step();
    expect(kernel.tick).toBe(23);
    expect(kernel.process(second)?.state).toBe('waiting');
    expect(kernel.deadlockSubsystem.saveState().deadlock.payload.observations.map(row => row.sinceTick).sort((a, b) => a - b))
      .toEqual([3, 23]);
    expect(detected).toEqual([]);
    kernel.run(16);
    expect(kernel.tick).toBe(39);
    expect(detected).toEqual([]);
    kernel.step();
    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({ tick: 40, report: { tick: 40, cycle: [first, second], conditions: fourConditions } });
    expect(kernel.deadlockSubsystem.averageDetectionLatency()).toBe(17);
    expect(kernel.deadlockSubsystem.saveState().deadlock.payload.statistics)
      .toMatchObject({ deadlocks: 1, detectionSamples: 1, detectionLatencyTicks: 17 });
  });

  it('runs the installed detector on ticks 20,40,60 and never between them', () => {
    const { kernel, detected } = cycleAtTickTwentyThree();
    const hook = vi.spyOn(kernel.deadlockSubsystem, 'maybeDetect');
    const detectorTicks: Tick[] = [];
    const original = kernel.deadlockSubsystem.detectDeadlock.bind(kernel.deadlockSubsystem);
    const detector = vi.spyOn(kernel.deadlockSubsystem, 'detectDeadlock').mockImplementation(() => {
      detectorTicks.push(kernel.tick);
      return original();
    });
    try {
      kernel.run(61);
      expect(hook.mock.calls.map(([tick]) => tick)).toEqual([20, 40, 60]);
      expect(detectorTicks).toEqual([20, 40, 60]);
      expect(kernel.deadlockSubsystem.saveState().deadlock.payload.lastObservationTick).toBe(61);
      expect(detected.map(event => event.tick)).toEqual([40]);
      expect(kernel.deadlockSubsystem.averageDetectionLatency()).toBe(17);
    } finally {
      detector.mockRestore();
      hook.mockRestore();
    }
  });
});

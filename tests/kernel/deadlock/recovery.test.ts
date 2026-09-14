import { describe, expect, it } from 'vitest';
import { ResourceTable } from '@kernel/deadlock/resources';
import { detectMultipleInstances } from '@kernel/deadlock/detection';
import { ResourceOrdering } from '@kernel/deadlock/ordering';
import { canRollback, chooseVictim, compareVictims, suggestedVictims } from '@kernel/deadlock/recovery';
import type { RollbackEligibility, VictimCandidate } from '@kernel/deadlock/recovery';
import { KernelInvariantError } from '@kernel/errors';
import { createKernel } from '@kernel/Kernel';
import type { KernelImpl, KernelOptions } from '@kernel/Kernel';
import { createBoundedBuffer } from '@kernel/sync/scenarios/boundedBuffer';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';
import { instructionProgram } from '@kernel/process/Program';
import type { Instruction } from '@kernel/process/Program';
import type { ThreadControlBlock } from '@kernel/process/threads';
import { createRng } from '@kernel/rng';
import { asPid, asResourceId, asTick } from '@kernel/types';
import type { AddressSpaceId, ConvoyMemberId, DomainId, KernelEvent, Pid, ProcessControlBlock, ResourceId, Tid } from '@kernel/types';

const A = asResourceId('a'), B = asResourceId('b'), C = asResourceId('c');

function process(id: number): ProcessControlBlock {
  return {
    pid: asPid(id), parent: null, name: `P${id}`, state: 'new', priority: 4, basePriority: 4,
    arrivalTick: asTick(0), cpuBurstRemaining: 30, serviceRemaining: 30, totalCpuUsed: 0,
    readySince: null, lastScheduledTick: null, queueLevel: 0, addressSpaceId: id as AddressSpaceId,
    threads: [id as Tid], openFiles: [], heldResources: [], requestedResources: [], blockedOn: null,
    domain: 'user' as DomainId, exitCode: null, terminationReason: null, convoyMemberId: null,
  };
}

function table(processes: ProcessControlBlock[]): ResourceTable {
  const resources = new ResourceTable({ processes: () => processes });
  resources.declare({ id: C, displayName: 'C', totalInstances: 6, preemptible: false });
  resources.declare({ id: A, displayName: 'A', totalInstances: 7, preemptible: true });
  resources.declare({ id: B, displayName: 'B', totalInstances: 2, preemptible: true });
  return resources;
}

function candidate(id: number, overrides: Partial<VictimCandidate> = {}): VictimCandidate {
  return { pid: asPid(id), convoyMemberId: null, priority: 4, totalCpuUsed: 8, heldResources: [A], serviceRemaining: 20, ...overrides };
}

function eligibility(): RollbackEligibility {
  const pcb = process(2);
  pcb.state = 'waiting'; pcb.heldResources = [A]; pcb.requestedResources = [B];
  pcb.blockedOn = { kind: 'semaphore', resource: B };
  const thread: ThreadControlBlock = {
    tid: 2 as Tid, pid: pcb.pid, state: 'waiting', programCounter: 4,
    serviceRemaining: 26, lwp: 2, blockedOn: pcb.blockedOn,
  };
  return {
    process: pcb, threads: [thread], checkpoint: { pid: pcb.pid, tid: thread.tid, tick: asTick(0), programCounter: 0 },
    program: instructionProgram([
      { kind: 'syscall', call: { name: 'request', pid: pcb.pid, args: [A, 1] } },
      { kind: 'compute' }, { kind: 'compute' },
      { kind: 'syscall', call: { name: 'request', pid: pcb.pid, args: [B, 1] } },
    ]),
    preemptionCount: 0, maxPreemptions: 3, hasSyncOwnership: false, hasUnrelatedContinuation: false,
    preemptible: () => true, isOwnedResource: resource => resource === A || resource === B,
  };
}

describe('deadlock victim selection and rollback eligibility', () => {
  it('DL-VICTIM-1 ranks the six comparator keys in their specified order', () => {
    const candidates = [candidate(1, { priority: 1, totalCpuUsed: 0, heldResources: [A, B, C] }),
      candidate(2, { priority: 7, totalCpuUsed: 5 }), candidate(3, { priority: 7, totalCpuUsed: 2 })];
    const byPid = new Map(candidates.map(entry => [entry.pid, entry]));
    expect(suggestedVictims(candidates.map(entry => entry.pid), pid => byPid.get(pid))).toEqual([3, 2, 1]);
    expect(chooseVictim(candidates.map(entry => entry.pid), pid => byPid.get(pid))).toBe(3);
    const comparisons: readonly [VictimCandidate, VictimCandidate][] = [
      [candidate(1), candidate(2, { convoyMemberId: 'convoy' as ConvoyMemberId, priority: 1000 })],
      [candidate(1, { priority: 5 }), candidate(2)],
      [candidate(1, { totalCpuUsed: 2 }), candidate(2)],
      [candidate(1, { heldResources: [A, B] }), candidate(2)],
      [candidate(1, { serviceRemaining: 30 }), candidate(2)],
      [candidate(3), candidate(2)],
    ];
    for (const [preferred, other] of comparisons) expect(compareVictims(preferred, other)).toBeLessThan(0);
  });

  it('comparator is total and antisymmetric for 500 seeded distinct PID pairs', () => {
    const rng = createRng(0x4b54524c, 'victim-test');
    for (let i = 0; i < 500; i += 1) {
      const a = candidate(i * 2 + 2, { priority: rng.int(0, 5), totalCpuUsed: rng.int(0, 10), serviceRemaining: rng.int(1, 50) });
      const b = candidate(i * 2 + 3, { priority: rng.int(0, 5), totalCpuUsed: rng.int(0, 10), serviceRemaining: rng.int(1, 50) });
      expect(compareVictims(a, b)).not.toBe(0);
      expect(Math.sign(compareVictims(a, b))).toBe(-Math.sign(compareVictims(b, a)));
    }
  });

  it('convoy processes sort last even when every other key would prefer them', () => {
    const plain = candidate(2, { priority: 0, totalCpuUsed: 100, heldResources: [], serviceRemaining: 1 });
    const convoy = [candidate(3, { convoyMemberId: 'one' as ConvoyMemberId, priority: 999 }), candidate(4, { convoyMemberId: 'two' as ConvoyMemberId, priority: 999 })];
    expect([...convoy, plain].sort(compareVictims).map(entry => entry.pid)).toEqual([2, 4, 3]);
    expect(convoy.sort(compareVictims).map(entry => entry.pid)).toEqual([4, 3]);
  });

  it('rejects empty victim sets and stale PID evidence', () => {
    expect(() => chooseVictim([], () => undefined)).toThrow(KernelInvariantError);
    expect(() => suggestedVictims([asPid(7)], () => undefined)).toThrow(KernelInvariantError);
  });

  it('allows resource-only replay without mutating PC, budgets, CPU, waits or holdings', () => {
    const input = eligibility();
    const before = JSON.stringify({ process: input.process, threads: input.threads, checkpoint: input.checkpoint });
    expect(canRollback(input)).toBe(true);
    expect(JSON.stringify({ process: input.process, threads: input.threads, checkpoint: input.checkpoint })).toBe(before);
    expect(Object.keys(input.checkpoint ?? {}).sort()).toEqual(['pid', 'programCounter', 'tick', 'tid']);
  });

  it('preemption guard rejects the fourth attempt, including after a caller preserves the PID count across exec', () => {
    expect(canRollback({ ...eligibility(), preemptionCount: 2 })).toBe(true);
    expect(canRollback({ ...eligibility(), preemptionCount: 3 })).toBe(false);
  });

  it('allows a placeholder syscall pid because kernel execution binds the running actor', () => {
    expect(canRollback({ ...eligibility(), program: instructionProgram([
      { kind: 'syscall', call: { pid: asPid(99), name: 'request', args: [A, 1] } },
    ]) })).toBe(true);
  });

  it.each(['request', 'release'] as const)('%s rollback validates every resource/count pair in an atomic vector', name => {
    const input = eligibility();
    const replay = (args: readonly (string | number | boolean)[]) => canRollback({ ...input,
      program: instructionProgram([{ kind: 'syscall', call: { pid: asPid(99), name, args } }]),
    });
    expect(replay([A, 1, B, 2])).toBe(true);
    expect(replay([A, 0, B, 1])).toBe(true);
    expect(replay([A, 1, 'another-subsystem', 1])).toBe(false);
    expect(replay([A, 1, B, 1, 'another-subsystem', 1])).toBe(false);
    for (const malformed of [[], [A], [A, 1, B], [A, 1, true, 1], [A, 1, B, false],
      [A, 1, B, -1], [A, 1, B, 0.5], [A, 1, B, Number.NaN]] as const) {
      expect(replay(malformed)).toBe(false);
    }
  });

  it('requires a matching single live thread, valid checkpoint, preemptible holdings and no external continuation', () => {
    const input = eligibility();
    const first = input.threads[0];
    if (first === undefined || input.checkpoint === undefined) throw new Error('missing rollback fixture');
    const invalid: RollbackEligibility[] = [
      { ...input, checkpoint: undefined }, { ...input, program: undefined },
      { ...input, checkpoint: { ...input.checkpoint, tid: 999 as Tid } },
      { ...input, checkpoint: { ...input.checkpoint, programCounter: 5 } },
      { ...input, threads: [...input.threads, { ...first, tid: 99 as Tid }] },
      { ...input, hasSyncOwnership: true }, { ...input, hasUnrelatedContinuation: true },
      { ...input, preemptible: () => false }, { ...input, isOwnedResource: () => false },
    ];
    for (const invalidInput of invalid) expect(canRollback(invalidInput)).toBe(false);
  });

  it('rejects replay with memory, sync, I/O or lifecycle effects', () => {
    const input = eligibility();
    const effects: Instruction[] = [
      { kind: 'access', page: 0 as never, write: false }, { kind: 'acquire', resource: A },
      { kind: 'thread_create' }, { kind: 'io', device: 'disk' as never },
      { kind: 'syscall', call: { pid: input.process.pid, name: 'fork', args: [] } },
      { kind: 'syscall', call: { pid: input.process.pid, name: 'release', args: ['unknown', 1] } },
    ];
    for (const effect of effects) expect(canRollback({ ...input, program: instructionProgram([effect]) })).toBe(false);
  });
});

describe('resource table conservation and prevention ordering', () => {
  it('keeps resource columns lexical and the live array stable while ranks follow declaration order', () => {
    const resources = table([process(2)]);
    const live = resources.resources;
    const ordering = new ResourceOrdering();
    ordering.declare(C, 'resource'); ordering.declare(A, 'sync'); ordering.declare(B, 'resource');
    expect(resources.bankersState().resources).toEqual([A, B, C]);
    expect(ordering.entries().map(entry => entry.resource)).toEqual([C, A, B]);
    resources.setEffectivePreemptible(C, true);
    expect(resources.resources).toBe(live);
    expect(resources.get(C)?.preemptible).toBe(true);
    expect(resources.declarations().find(entry => entry.id === C)?.preemptible).toBe(false);
    resources.setEffectivePreemptible(C, false);
    expect(resources.resources).toBe(live);
  });

  it('normalizes sparse vectors and refuses duplicate, negative, fractional or unknown columns', () => {
    const resources = table([process(2)]);
    expect(resources.normalizeVector([[C, 0], [B, 1], [A, 2]])).toEqual([[A, 2], [B, 1]]);
    expect(resources.normalizeVector([[A, 0]])).toEqual([]);
    for (const vector of [[[A, 1], [A, 2]], [[A, -1]], [[A, 1.5]], [[asResourceId('x'), 1]]] as const) {
      expect(() => resources.normalizeVector(vector)).toThrow(RangeError);
    }
  });

  it('declares Max before admission and derives Allocation and Need from current PCB multisets', () => {
    const pcb = process(2), resources = table([pcb]);
    expect(resources.bankersState().max).toEqual([[0, 0, 0]]);
    resources.declareClaims(pcb.pid, [[A, 4], [B, 2]]);
    resources.grant(pcb.pid, [[A, 2], [B, 1]]);
    expect(pcb.heldResources).toEqual([A, A, B]);
    expect(resources.bankersState()).toMatchObject({ available: [5, 1, 6], max: [[4, 2, 0]], allocation: [[2, 1, 0]], need: [[2, 1, 0]] });
    resources.release(pcb.pid, [[A, 1]]);
    expect(resources.bankersState().allocation).toEqual([[1, 1, 0]]);
    pcb.state = 'ready';
    expect(() => resources.declareClaims(pcb.pid, [[A, 3]])).toThrow(/before admission/);
    resources.clearClaims(pcb.pid);
    expect(resources.bankersState().need).toEqual([[-1, -1, 0]]);
    resources.assertConservation();
  });

  it('validates the entire grant and release vectors before changing any owner or availability', () => {
    const pcb = process(2), resources = table([pcb]);
    const before = resources.bankersState();
    expect(() => resources.grant(pcb.pid, [[A, 1], [B, 3]])).toThrow(/unavailable/);
    expect(resources.bankersState()).toEqual(before);
    resources.grant(pcb.pid, [[A, 2], [B, 1]]);
    const granted = resources.bankersState();
    expect(() => resources.release(pcb.pid, [[A, 1], [B, 2]])).toThrow(/does not hold/);
    expect(resources.bankersState()).toEqual(granted);
    expect(resources.releaseAll(pcb.pid)).toEqual([[A, 2], [B, 1]]);
    expect(resources.bankersState()).toEqual(before);
  });

  it('preserves I-5 over 5000 seeded allocation and release decisions including blocked holders', () => {
    const processes = [process(2), process(3), process(4)], resources = table(processes);
    const rng = createRng(0x4b54524c, 'resource-test');
    for (let tick = 0; tick < 5000; tick += 1) {
      const pcb = rng.pick(processes), id = rng.pick([A, B, C]);
      pcb.state = rng.chance(0.5) ? 'waiting' : 'running';
      if (pcb.heldResources.includes(id) && rng.chance(0.5)) resources.release(pcb.pid, [[id, 1]]);
      else if (resources.available([[id, 1]])) resources.grant(pcb.pid, [[id, 1]]);
      resources.assertConservation();
    }
    for (const pcb of processes) resources.releaseAll(pcb.pid);
    expect(resources.bankersState().available).toEqual([7, 2, 6]);
  });

  it('restores availability from staged holdings and validates all data before replacing its own table', () => {
    const pcb = process(2), resources = table([pcb]);
    resources.declareClaims(pcb.pid, [[A, 4]]); resources.grant(pcb.pid, [[A, 2]]);
    const declarations = resources.declarations(), claims = resources.claimsSnapshot(), live = resources.resources;
    resources.restore(declarations, claims);
    expect(resources.resources).toBe(live);
    expect(resources.get(A)?.availableInstances).toBe(5);
    const before = resources.bankersState();
    expect(() => resources.restore(declarations, [...claims, ...claims])).toThrow(/duplicate/);
    expect(resources.bankersState()).toEqual(before);
    expect(() => resources.restore(declarations.map(entry => entry.id === A ? { ...entry, totalInstances: 1 } : entry), [])).toThrow(KernelInvariantError);
    expect(resources.bankersState()).toEqual(before);
  });

  it('rejects resource declarations colliding with sync or synthetic mailbox IDs', () => {
    const resources = new ResourceTable({ processes: () => [], collides: id => id === A });
    expect(() => resources.declare({ id: A, displayName: 'sync collision', totalInstances: 1, preemptible: false })).toThrow(RangeError);
    expect(() => resources.declare({ id: asResourceId('mbox:channel:send'), displayName: 'mailbox collision', totalInstances: 1, preemptible: false })).toThrow(RangeError);
  });

  it('DL-PREVENT-1 rejects rank decreases, same-rank reacquisition and partial all-or-nothing claims', () => {
    const ordering = new ResourceOrdering();
    ordering.declare(A, 'resource'); ordering.declare(B, 'sync'); ordering.declare(C, 'resource');
    expect(ordering.checkOrdering([C], [A])).toBe(false);
    expect(ordering.checkOrdering([B], [B])).toBe(false);
    expect(ordering.checkOrdering([A], [B, C])).toBe(true);
    expect(ordering.checkAllOrNothing([], [[A, 1], [B, 1]], [[B, 1], [A, 1]])).toBe(true);
    expect(ordering.checkAllOrNothing([], [[A, 1]], [[A, 1], [B, 1]])).toBe(false);
    expect(ordering.checkAllOrNothing([C], [[A, 1], [B, 1]], [[A, 1], [B, 1]])).toBe(false);
    const restored = new ResourceOrdering(); restored.restore(ordering.entries());
    expect(restored.entries()).toEqual(ordering.entries());
    expect(restored.checkOrdering([B], [A])).toBe(false);
  });
});

function recoveryKernel(options: KernelOptions = {}): KernelImpl {
  return createKernel({
    ...REFERENCE_CONFIG, scheduler: 'rr', deadlockStrategy: 'detect',
    schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1, agingInterval: 0,
      starvationThreshold: 10_000, starvationFatalThreshold: 20_000 },
    enabledSubsystems: ['process', 'scheduler', 'sync', 'deadlock'],
  }, { threadCreateTicks: 0, contextSwitchTicks: 0, ...options });
}

function recoveryWorker(kernel: KernelImpl, name: string, priority = 10, arrival = 0): Pid {
  return kernel.spawn({ name, priority, arrival, burst: 10_000, service: 10_000, pages: 0 },
    { program: instructionProgram([]), serialFraction: 1 });
}

function runUntilDispatched(kernel: KernelImpl, pid: Pid): void {
  for (let remaining = 100; remaining > 0 && kernel.process(pid)?.state !== 'running'; remaining -= 1) kernel.step();
  expect(kernel.process(pid)?.state).toBe('running');
}

function requestResource(kernel: KernelImpl, pid: Pid, resource: ResourceId): void {
  runUntilDispatched(kernel, pid);
  expect(kernel.syscall({ pid, name: 'request', args: [resource, 1] })).toMatchObject({ ok: true });
}

function blockForResource(kernel: KernelImpl, pid: Pid, resource: ResourceId): void {
  runUntilDispatched(kernel, pid);
  expect(kernel.syscall({ pid, name: 'request', args: [resource, 1] })).toMatchObject({ ok: false, errno: 'EAGAIN' });
  expect(kernel.process(pid)?.state).toBe('waiting');
}

function pairCycle(kernel: KernelImpl, first: Pid, second: Pid, a: ResourceId = A, b: ResourceId = B): void {
  requestResource(kernel, first, a);
  requestResource(kernel, second, b);
  blockForResource(kernel, first, b);
  blockForResource(kernel, second, a);
}

function recoveryBoundary(kernel: KernelImpl): void {
  const interval = kernel.tuning.deadlockDetectionInterval;
  kernel.run(interval - kernel.tick % interval);
}

function declareRecoveryPair(kernel: KernelImpl, preemptibleA: boolean, preemptibleB = preemptibleA): void {
  for (const [id, preemptible] of [[A, preemptibleA], [B, preemptibleB]] as const) {
    kernel.declareResource({ id, displayName: id, totalInstances: 1, preemptible });
  }
}

function recoveryEvents(kernel: KernelImpl): KernelEvent[] {
  const events: KernelEvent[] = [];
  kernel.events.onAny(event => events.push(event));
  return events;
}

function recoveryThread(kernel: KernelImpl, pid: Pid): ThreadControlBlock {
  const tid = kernel.process(pid)?.threads[0];
  const thread = tid === undefined ? undefined : kernel.threads.table.get(tid);
  if (thread === undefined) throw new Error('Missing recovery actor.');
  return thread;
}

function accountingState(kernel: KernelImpl, pid: Pid) {
  const pcb = kernel.process(pid);
  const thread = recoveryThread(kernel, pid);
  return structuredClone({
    tick: kernel.tick, raw: kernel.table.raw.get(pid), accounting: kernel.threads.accountingState(pid),
    totalCpuUsed: pcb?.totalCpuUsed, cpuBurstRemaining: pcb?.cpuBurstRemaining,
    serviceRemaining: pcb?.serviceRemaining, threadServiceRemaining: thread.serviceRemaining,
    config: kernel.config, tuning: kernel.tuning,
  });
}

describe('recovery through the installed kernel hook', () => {
  it('abort_one re-detects and terminates one victim from each independent cycle', () => {
    const kernel = recoveryKernel({ deadlockRecovery: 'abort_one' });
    const D = asResourceId('d');
    for (const id of [A, B, C, D]) kernel.declareResource({ id, displayName: id, totalInstances: 1, preemptible: false });
    const pids = Array.from({ length: 4 }, (_, index) => recoveryWorker(kernel, `independent ${index}`, 10 + index));
    const [p0, p1, p2, p3] = pids;
    if (p0 === undefined || p1 === undefined || p2 === undefined || p3 === undefined) throw new Error('Missing cycle actors.');
    const events = recoveryEvents(kernel);
    pairCycle(kernel, p0, p1);
    pairCycle(kernel, p2, p3, C, D);
    expect(events.filter(event => event.type === 'deadlock.detected')).toEqual([]);
    recoveryBoundary(kernel);
    expect(events.filter(event => event.type === 'deadlock.detected')).toMatchObject([
      { report: { cycle: [p0, p1] } }, { report: { cycle: [p2, p3] } },
    ]);
    expect(events.filter(event => event.type === 'deadlock.resolved')).toMatchObject([
      { victims: [p1], method: 'terminate' }, { victims: [p3], method: 'terminate' },
    ]);
    expect([p1, p3].map(pid => kernel.process(pid)?.terminationReason)).toEqual(['deadlock_victim', 'deadlock_victim']);
    expect([p0, p2].map(pid => kernel.process(pid)?.terminationReason)).toEqual([null, null]);
    expect(kernel.deadlockSubsystem.strategyReport()).toMatchObject({ deadlocks: 2, processesLost: 2 });
    expect(kernel.detectDeadlock()).toBeNull();
    kernel.deadlockSubsystem.resources.assertConservation();
  });

  it('abort_all terminates every member of the discovered deadlock in one recovery pass', () => {
    const kernel = recoveryKernel({ deadlockRecovery: 'abort_all' });
    declareRecoveryPair(kernel, false);
    const first = recoveryWorker(kernel, 'abort all first'), second = recoveryWorker(kernel, 'abort all second');
    const events = recoveryEvents(kernel);
    pairCycle(kernel, first, second);
    recoveryBoundary(kernel);
    const resolved = events.filter(event => event.type === 'deadlock.resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ method: 'terminate' });
    expect(resolved[0]?.victims.slice().sort((a, b) => a - b)).toEqual([first, second]);
    expect([first, second].map(pid => kernel.process(pid)?.terminationReason)).toEqual(['deadlock_victim', 'deadlock_victim']);
    expect(kernel.deadlockSubsystem.resources.bankersState().available).toEqual([1, 1]);
    expect(kernel.deadlockSubsystem.strategyReport()).toMatchObject({ processesLost: 2 });
  });

  it('abort_all includes a multi-instance deadlocked holder tail beyond the selected cycle', () => {
    const kernel = recoveryKernel({ deadlockRecovery: 'abort_all' });
    declareRecoveryPair(kernel, false);
    kernel.declareResource({ id: C, displayName: 'two instances on the tail', totalInstances: 2, preemptible: false });
    const first = recoveryWorker(kernel, 'cycle first', 10), second = recoveryWorker(kernel, 'cycle second', 11);
    const tail = recoveryWorker(kernel, 'blocked holder tail', 12), empty = recoveryWorker(kernel, 'holds nothing', 13);
    const events = recoveryEvents(kernel);
    pairCycle(kernel, first, second);
    requestResource(kernel, tail, C);
    blockForResource(kernel, tail, A);
    blockForResource(kernel, empty, A);
    const state = kernel.deadlockSubsystem.resources.bankersState();
    expect(detectMultipleInstances({ ...state, request: kernel.deadlockSubsystem.resources.requestMatrix() }).deadlocked)
      .toEqual([first, second, tail]);
    recoveryBoundary(kernel);
    const detected = events.filter(event => event.type === 'deadlock.detected');
    expect(detected).toHaveLength(1);
    expect(detected[0]?.report.cycle).toEqual([first, second]);
    const resolved = events.filter(event => event.type === 'deadlock.resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ method: 'terminate' });
    expect(resolved[0]?.victims.slice().sort((a, b) => a - b)).toEqual([first, second, tail]);
    expect([first, second, tail].map(pid => kernel.process(pid)?.terminationReason))
      .toEqual(['deadlock_victim', 'deadlock_victim', 'deadlock_victim']);
    expect(kernel.process(empty)?.terminationReason).toBeNull();
    expect(kernel.deadlockSubsystem.strategyReport().processesLost).toBe(3);
    kernel.deadlockSubsystem.resources.assertConservation();
  });

  it('preempt preferred emits detected and resolved rollback events without terminating either actor', () => {
    const kernel = recoveryKernel({ deadlockRecovery: 'preempt' });
    declareRecoveryPair(kernel, true, false);
    const first = recoveryWorker(kernel, 'preemptible holder', 20), second = recoveryWorker(kernel, 'nonpreemptible holder', 5);
    const events = recoveryEvents(kernel);
    pairCycle(kernel, first, second);
    const checkpoint = kernel.deadlockSubsystem.saveState().deadlock.payload.checkpoints.find(row => row.pid === first);
    expect(checkpoint).toBeDefined();
    recoveryBoundary(kernel);
    expect(events.filter(event => event.type.startsWith('deadlock.'))).toMatchObject([
      { type: 'deadlock.detected', report: { cycle: [first, second],
        conditions: ['mutual_exclusion', 'hold_and_wait', 'no_preemption', 'circular_wait'] } },
      { type: 'deadlock.resolved', victims: [first], method: 'rollback' },
    ]);
    expect(kernel.process(first)).toMatchObject({ state: 'ready', blockedOn: null, heldResources: [], requestedResources: [], terminationReason: null });
    expect(kernel.process(second)?.terminationReason).toBeNull();
    expect(recoveryThread(kernel, first).programCounter).toBe(checkpoint?.programCounter);
    expect(kernel.deadlockSubsystem.saveState().deadlock.payload.preemptionCounts).toEqual([[first, 1]]);
    expect(kernel.deadlockSubsystem.strategyReport().processesLost).toBe(0);
    expect(kernel.detectDeadlock()).toBeNull();
    kernel.deadlockSubsystem.resources.assertConservation();
  });

  it('preempt falls back to termination when neither holder has preemptible resources', () => {
    const kernel = recoveryKernel({ deadlockRecovery: 'preempt' });
    declareRecoveryPair(kernel, false);
    const first = recoveryWorker(kernel, 'fallback victim', 20), second = recoveryWorker(kernel, 'fallback survivor', 5);
    const events = recoveryEvents(kernel);
    pairCycle(kernel, first, second);
    recoveryBoundary(kernel);
    expect(events.filter(event => event.type.startsWith('deadlock.'))).toMatchObject([
      { type: 'deadlock.detected' }, { type: 'deadlock.resolved', method: 'terminate', victims: [first] },
    ]);
    expect(kernel.process(first)?.terminationReason).toBe('deadlock_victim');
    expect(kernel.process(second)?.terminationReason).toBeNull();
    expect(kernel.deadlockSubsystem.saveState().deadlock.payload.preemptionCounts).toEqual([]);
  });

  it('restores a twelve-tick-old resource-free PC without rewinding service, CPU, raw work, Amdahl price or tuning', () => {
    const kernel = recoveryKernel({ deadlockRecovery: 'preempt' });
    declareRecoveryPair(kernel, true, false);
    const first = recoveryWorker(kernel, 'PC-only victim', 20), second = recoveryWorker(kernel, 'later holder', 5, 9);
    const events = recoveryEvents(kernel);
    kernel.run(8);
    requestResource(kernel, first, A);
    const checkpoint = kernel.deadlockSubsystem.saveState().deadlock.payload.checkpoints.find(row => row.pid === first);
    expect(checkpoint?.tick).toBe(8);
    requestResource(kernel, second, B);
    blockForResource(kernel, first, B);
    blockForResource(kernel, second, A);
    const beforePc = recoveryThread(kernel, first).programCounter;
    expect(beforePc).toBeGreaterThan(checkpoint?.programCounter ?? -1);
    let accountingBefore: ReturnType<typeof accountingState> | undefined;
    kernel.onPhase((phase, tick) => { if (phase === 9 && tick === 20) accountingBefore = accountingState(kernel, first); });
    recoveryBoundary(kernel);
    expect(kernel.tick).toBe(20);
    expect(accountingBefore).toBeDefined();
    expect(accountingState(kernel, first)).toEqual(accountingBefore);
    expect(recoveryThread(kernel, first)).toMatchObject({ programCounter: checkpoint?.programCounter, state: 'ready', blockedOn: null });
    expect(kernel.process(first)).toMatchObject({ state: 'ready', readySince: 20, blockedOn: null, heldResources: [], requestedResources: [] });
    expect(kernel.deadlockSubsystem.saveState().deadlock.payload.requests.some(row => row.actor.pid === first)).toBe(false);
    expect(events.filter(event => event.type === 'deadlock.resolved')).toMatchObject([{ method: 'rollback', victims: [first] }]);
  });

  it('refreshes resource-free checkpoints at 25,50,75 with only pid,tid,tick,programCounter', () => {
    const kernel = recoveryKernel({ rollbackCheckpointInterval: 25 });
    const pid = recoveryWorker(kernel, 'checkpoint cadence');
    kernel.run(24);
    expect(kernel.deadlockSubsystem.saveState().deadlock.payload.checkpoints).toEqual([]);
    for (const tick of [25, 50, 75]) {
      kernel.run(tick - kernel.tick);
      const checkpoint = kernel.deadlockSubsystem.saveState().deadlock.payload.checkpoints.find(row => row.pid === pid);
      expect(checkpoint).toEqual({ pid, tid: recoveryThread(kernel, pid).tid, tick, programCounter: recoveryThread(kernel, pid).programCounter });
      expect(Object.keys(checkpoint ?? {}).sort()).toEqual(['pid', 'programCounter', 'tick', 'tid']);
      kernel.run(1);
      expect(kernel.deadlockSubsystem.saveState().deadlock.payload.checkpoints.find(row => row.pid === pid)).toEqual(checkpoint);
    }
  });

  it('after three successful rollbacks the fourth recovery terminates the same holder even after exec', () => {
    const kernel = recoveryKernel({ deadlockRecovery: 'preempt', maxPreemptionsPerProcess: 3 });
    declareRecoveryPair(kernel, true, false);
    const first = recoveryWorker(kernel, 'bounded rollback victim', 20), second = recoveryWorker(kernel, 'persistent partner', 5);
    const events = recoveryEvents(kernel);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      pairCycle(kernel, first, second);
      recoveryBoundary(kernel);
      const resolved = events.filter(event => event.type === 'deadlock.resolved').at(-1);
      expect(resolved).toMatchObject({ victims: [first], method: attempt <= 3 ? 'rollback' : 'terminate' });
      expect(kernel.deadlockSubsystem.saveState().deadlock.payload.preemptionCounts).toEqual([[first, Math.min(attempt, 3)]]);
      if (attempt <= 3) {
        expect(kernel.process(first)?.terminationReason).toBeNull();
        expect(kernel.syscall({ pid: second, name: 'release', args: [A, 1, B, 1] })).toMatchObject({ ok: true });
        runUntilDispatched(kernel, second);
        if (attempt === 3) {
          kernel.registerProgram('fresh recovery program', instructionProgram(Array.from({ length: 1000 }, (): Instruction => ({ kind: 'compute' }))));
          expect(kernel.syscall({ pid: first, name: 'exec', args: ['fresh recovery program'] })).toMatchObject({ ok: true });
          expect(kernel.deadlockSubsystem.saveState().deadlock.payload.preemptionCounts).toEqual([[first, 3]]);
          expect(kernel.deadlockSubsystem.saveState().deadlock.payload.checkpoints.some(row => row.pid === first)).toBe(false);
        }
      }
    }
    expect(events.filter(event => event.type === 'deadlock.detected')).toHaveLength(4);
    expect(events.filter(event => event.type === 'deadlock.resolved')).toHaveLength(4);
    expect(kernel.process(first)?.terminationReason).toBe('deadlock_victim');
    expect(kernel.deadlockSubsystem.strategyReport().processesLost).toBe(1);
  });

  it('a temporary shield permits rollback and expires back to its declared value at the exact boundary', () => {
    const kernel = recoveryKernel({ deadlockRecovery: 'preempt' });
    declareRecoveryPair(kernel, false);
    const first = recoveryWorker(kernel, 'shielded holder', 20), second = recoveryWorker(kernel, 'shield partner', 5);
    const events = recoveryEvents(kernel);
    kernel.setPreemptible(A, true, asTick(21));
    pairCycle(kernel, first, second);
    recoveryBoundary(kernel);
    expect(kernel.deadlockSubsystem.resources.get(A)?.preemptible).toBe(true);
    expect(events.filter(event => event.type === 'deadlock.resolved')).toMatchObject([{ method: 'rollback', victims: [first] }]);
    kernel.step();
    expect(kernel.tick).toBe(21);
    expect(kernel.deadlockSubsystem.resources.get(A)?.preemptible).toBe(false);
    expect(kernel.deadlockSubsystem.saveState().deadlock.payload.preemptibilityOverrides).toEqual([]);
  });

  it('replacing an override expires to the declaration, never to the superseded temporary value', () => {
    const kernel = recoveryKernel();
    kernel.declareResource({ id: A, displayName: 'declared preemptible', totalInstances: 1, preemptible: true });
    kernel.setPreemptible(A, false, asTick(40));
    kernel.run(5);
    kernel.setPreemptible(A, false, asTick(10));
    kernel.run(4);
    expect(kernel.deadlockSubsystem.resources.get(A)?.preemptible).toBe(false);
    kernel.step();
    expect(kernel.deadlockSubsystem.resources.get(A)?.preemptible).toBe(true);
    kernel.run(30);
    expect(kernel.deadlockSubsystem.resources.get(A)?.preemptible).toBe(true);
    expect(kernel.deadlockSubsystem.saveState().deadlock.payload.preemptibilityOverrides).toEqual([]);
  });

  it.each(['exit', 'exec'] as const)('%s hands off a scenario mutex permit while keeping a generic counting permit unavailable', operation => {
    const kernel = recoveryKernel();
    const scenario = createBoundedBuffer(kernel, { id: `cleanup-${operation}`, producers: 1, consumers: 1, producerItems: 1, consumerItems: 1 });
    const owner = scenario.actors[0]?.actor, waiter = scenario.actors[1]?.actor;
    if (owner === undefined || waiter === undefined) throw new Error('Missing bounded-buffer actors.');
    const generic = asResourceId(`cleanup-${operation}:generic`);
    kernel.syncSubsystem.createSemaphore(generic, 1, 1);
    expect(kernel.syncSubsystem.call(owner, { op: 'sem_wait', resource: scenario.mutex }).ok).toBe(true);
    expect(kernel.syncSubsystem.call(owner, { op: 'sem_wait', resource: generic }).ok).toBe(true);
    let blocked = false;
    kernel.onPhase(phase => {
      if (phase !== 8 || blocked || kernel.process(waiter.pid)?.state !== 'running') return;
      blocked = true;
      expect(kernel.syncSubsystem.call(waiter, { op: 'sem_wait', resource: scenario.mutex }).ok).toBe(true);
    });
    while (!blocked && kernel.tick < 10) kernel.step();
    expect(blocked).toBe(true);
    expect(kernel.process(waiter.pid)?.blockedOn).toEqual({ kind: 'semaphore', resource: scenario.mutex });
    const generation = kernel.syncSubsystem.allWaits().find(wait => wait.actor.pid === waiter.pid)?.generation;
    expect(generation).toBeDefined();
    const events = recoveryEvents(kernel);
    if (operation === 'exec') kernel.registerProgram('cleanup replacement', instructionProgram([{ kind: 'compute' }]));
    expect(kernel.syscall({ pid: owner.pid, name: operation, args: operation === 'exec' ? ['cleanup replacement'] : [0] }).ok).toBe(true);
    const lock = kernel.syncSubsystem.get(scenario.mutex), permit = kernel.syncSubsystem.get(generic);
    if (lock?.kind !== 'semaphore' || permit?.kind !== 'semaphore' || generation === undefined) throw new Error('Missing cleanup semaphores.');
    expect(lock.debits.map(debit => debit.actor)).toEqual([waiter]);
    expect(kernel.syncSubsystem.reserved(generation)).toBe(true);
    expect(permit.debits).toHaveLength(1);
    expect(permit.debits[0]?.actor).toBeNull();
    expect(events.filter(event => event.type === 'sync.released' && event.resource === scenario.mutex)).toMatchObject([{ woke: waiter.pid }]);
    expect(events.filter(event => event.type === 'sync.released' && event.resource === generic)).toEqual([]);
  });
});

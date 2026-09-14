import { describe, expect, it } from 'vitest';
import { KernelInvariantError } from '@kernel/errors';
import { createKernel } from '@kernel/Kernel';
import type { KernelImpl } from '@kernel/Kernel';
import { instructionProgram } from '@kernel/process/Program';
import type { Instruction } from '@kernel/process/Program';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';
import { at, needMatrix, previewRequest, safetyCheck, safetyCheckWithOrder } from '@kernel/deadlock/bankers';
import { asPid, asResourceId } from '@kernel/types';
import type { BankersState, KernelEvent, Pid, ResourceId } from '@kernel/types';

function textbook(): BankersState {
  const max = [[7, 5, 3], [3, 2, 2], [9, 0, 2], [2, 2, 2], [4, 3, 3]];
  const allocation = [[0, 1, 0], [2, 0, 0], [3, 0, 2], [2, 1, 1], [0, 0, 2]];
  return {
    processes: [0, 1, 2, 3, 4].map(asPid), resources: ['A', 'B', 'C'].map(asResourceId),
    available: [3, 3, 2], max, allocation, need: needMatrix(max, allocation),
  };
}

function afterFirstRequest(): BankersState {
  const preview = previewRequest(textbook(), asPid(1), [1, 0, 2]);
  if (preview.kind !== 'safe') throw new Error('The worked first request must be safe.');
  return preview.state;
}

const expectedWork = [[5, 3, 2], [7, 4, 3], [7, 5, 3], [10, 5, 5], [10, 5, 7]];

describe('Banker safety algorithm, Ch. 8.6.3.1', () => {
  it('DL-BANKERS-1: restarts ascending-first-match and reproduces all five Work vectors', () => {
    const result = safetyCheck(textbook());
    expect(result.safe).toBe(true);
    expect(result.sequence).toEqual([1, 3, 0, 2, 4]);
    expect(result.trace).toHaveLength(5);
    expect(result.trace.every(step => step.admitted && step.candidate !== null)).toBe(true);
    expect(result.trace.map(step => step.work)).toEqual(expectedWork);
  });

  it('DL-BANKERS-1A: the documented textbook order is also safe and differs from the simulator order', () => {
    const simulator = safetyCheck(textbook());
    const printed = safetyCheckWithOrder(textbook(), [1, 3, 4, 0, 2].map(asPid));
    expect(printed.safe).toBe(true);
    expect(printed.sequence).toEqual([1, 3, 4, 0, 2]);
    expect(simulator.sequence).toEqual([1, 3, 0, 2, 4]);
    expect(printed.sequence).not.toEqual(simulator.sequence);
    expect(printed.trace.map(step => step.work)).toEqual([
      [5, 3, 2], [7, 4, 3], [7, 4, 5], [7, 5, 5], [10, 5, 7],
    ]);
  });

  it('computes all fifteen Need cells from Max minus Allocation, even when an exposed projection is stale', () => {
    const state = textbook();
    expect(needMatrix(state.max, state.allocation)).toEqual([
      [7, 4, 3], [1, 2, 2], [6, 0, 0], [0, 1, 1], [4, 3, 1],
    ]);
    expect(safetyCheck({ ...state, need: state.need.map(row => row.map(() => 0)) }))
      .toEqual(safetyCheck(state));
  });

  it('accounts for allocated totals A=7, B=2, C=5 and Available=(3,3,2)', () => {
    const state = textbook();
    const allocated = state.resources.map((_, j) => state.processes.reduce((sum, __, i) => sum + at(state.allocation, i, j), 0));
    expect(allocated).toEqual([7, 2, 5]);
    expect(state.available).toEqual([3, 3, 2]);
    expect(allocated.map((value, j) => value + at([state.available], 0, j))).toEqual([10, 5, 7]);
  });

  it('restarts at index zero after index three makes index one eligible', () => {
    const max = [[4], [2], [4], [1]];
    const allocation = [[0], [1], [0], [1]];
    const result = safetyCheck({
      processes: [0, 1, 2, 3].map(asPid), resources: [asResourceId('a')], available: [0],
      max, allocation, need: needMatrix(max, allocation),
    });
    expect(result.trace.map(step => step.candidate)).toEqual([3, 1, null]);
    expect(result.trace.map(step => step.work)).toEqual([[1], [2], [2]]);
  });

  it('uses the exact admission and unsafe terminal explanations without long dashes', () => {
    for (const step of safetyCheck(textbook()).trace) {
      expect(step.explanation).toBe(`Need[P${step.candidate}] fits in Work; assume it finishes and returns its allocation. Work becomes [${step.work.join(', ')}].`);
      expect(step.explanation).not.toMatch(/[\u2013\u2014]/u);
    }
    const rejected = previewRequest(afterFirstRequest(), asPid(0), [0, 2, 0]);
    expect(rejected.result.trace).toEqual([{
      work: [2, 1, 0], candidate: null, admitted: false,
      explanation: 'No remaining process has Need <= Work [2, 1, 0]. Stuck: P0, P1, P2, P3, P4. State is UNSAFE.',
    }]);
    expect(rejected.result.trace[0]?.explanation).not.toMatch(/[\u2013\u2014]/u);
  });

  it('ends an empty safe state without an invented terminal failure', () => {
    expect(safetyCheck({ processes: [], resources: [], available: [], max: [], allocation: [], need: [] }))
      .toEqual({ safe: true, sequence: [], trace: [] });
  });

  it('rejects a forced order which is not a permutation and stops when its next candidate cannot finish', () => {
    expect(() => safetyCheckWithOrder(textbook(), [1, 1, 2, 3, 4].map(asPid))).toThrow(KernelInvariantError);
    const failed = safetyCheckWithOrder(textbook(), [0, 1, 2, 3, 4].map(asPid));
    expect(failed.safe).toBe(false);
    expect(failed.sequence).toBeNull();
    expect(failed.trace).toHaveLength(1);
    expect(failed.trace[0]).toMatchObject({ admitted: false, candidate: null, work: [3, 3, 2] });
  });
});

describe('atomic resource-request previews, Ch. 8.6.3.2', () => {
  it('DL-BANKERS-2: P1 requests (1,0,2) as one safe tentative allocation', () => {
    const original = textbook();
    const saved = JSON.stringify(original);
    const preview = previewRequest(original, asPid(1), [1, 0, 2]);
    expect(preview.kind).toBe('safe');
    if (preview.kind !== 'safe') throw new Error('Expected safe request.');
    expect(preview.state.available).toEqual([2, 3, 0]);
    expect(preview.state.allocation[1]).toEqual([3, 0, 2]);
    expect(preview.state.need[1]).toEqual([0, 2, 0]);
    expect(preview.result.sequence).toEqual([1, 3, 0, 2, 4]);
    expect(preview.result.trace.map(step => step.work)).toEqual(expectedWork);
    expect(JSON.stringify(original)).toBe(saved);
  });

  it('DL-BANKERS-3: P4 requests (3,3,0) and fails availability before the safety scan', () => {
    const state = afterFirstRequest();
    const saved = JSON.stringify(state);
    const result = previewRequest(state, asPid(4), [3, 3, 0]);
    expect(result.kind).toBe('unavailable');
    expect(result.result).toMatchObject({ safe: false, sequence: null });
    expect(result.result.trace).toEqual([{
      work: [2, 3, 0], candidate: null, admitted: false,
      explanation: 'Request for P4 exceeds Available for A; the resources are unavailable.',
    }]);
    expect(JSON.stringify(state)).toBe(saved);
  });

  it('DL-BANKERS-4: P0 requests (0,2,0), is unsafe, and leaves all original cells unchanged', () => {
    const state = afterFirstRequest();
    const saved = JSON.stringify(state);
    const rejected = previewRequest(state, asPid(0), [0, 2, 0]);
    expect(rejected.kind).toBe('unsafe');
    expect(rejected.result.safe).toBe(false);
    expect(rejected.result.trace.at(-1)).toMatchObject({ candidate: null, admitted: false, work: [2, 1, 0] });
    expect(state.available).toEqual([2, 3, 0]);
    expect(state.allocation[0]).toEqual([0, 1, 0]);
    expect(JSON.stringify(state)).toBe(saved);
  });

  it('DL-BANKERS-5: exceeding the declared maximum is invalid even before availability', () => {
    const result = previewRequest(textbook(), asPid(1), [2, 0, 0]);
    expect(result.kind).toBe('invalid');
    expect(result.result.trace).toEqual([{
      work: [3, 3, 2], candidate: null, admitted: false,
      explanation: 'Request for P1 exceeds its declared maximum claim for A.',
    }]);
  });

  it('repeated previews produce identical results without committing', () => {
    const state = textbook();
    const before = JSON.stringify(state);
    const first = previewRequest(state, asPid(1), [1, 0, 2]);
    expect(previewRequest(state, asPid(1), [1, 0, 2])).toEqual(first);
    expect(JSON.stringify(state)).toBe(before);
    if (first.kind !== 'safe') throw new Error('Expected safe request.');
    expect(first.state.max).not.toBe(state.max);
    expect(first.state.allocation[0]).not.toBe(state.allocation[0]);
  });

  it.each([[1], [-1, 0, 0], [0.5, 0, 0], [Number.NaN, 0, 0], [0, 0, 0]])(
    'returns an invalid terminal precheck for malformed vector %j', (...request: number[]) => {
      const result = previewRequest(textbook(), asPid(1), request);
      expect(result.kind).toBe('invalid');
      expect(result.result).toMatchObject({ safe: false, sequence: null });
      expect(result.result.trace).toMatchObject([{ admitted: false, candidate: null }]);
    },
  );

  it('returns an invalid terminal precheck for an unknown pid', () => {
    expect(previewRequest(textbook(), asPid(100), [1, 0, 0])).toMatchObject({
      kind: 'invalid', result: { safe: false, sequence: null },
    });
  });
});

describe('resource matrix guards', () => {
  it('never silently turns an absent cell into zero', () => {
    expect(at([[4]], 0, 0)).toBe(4);
    for (const [row, column] of [[1, 0], [0, 1], [-1, 0], [0, -1], [0.5, 0]] as const) {
      expect(() => at([[4]], row, column)).toThrow(KernelInvariantError);
    }
  });

  it('rejects ragged matrices, impossible negative Need and invalid counts', () => {
    expect(() => needMatrix([[1], [1, 2]], [[0], [0, 0]])).toThrow(KernelInvariantError);
    expect(() => needMatrix([[1]], [[2]])).toThrow(KernelInvariantError);
    expect(() => needMatrix([[Number.POSITIVE_INFINITY]], [[0]])).toThrow(KernelInvariantError);
    expect(() => safetyCheck({ ...textbook(), available: [3, 3] })).toThrow(KernelInvariantError);
  });

  it('requires ascending process rows and lexicographic resource columns', () => {
    expect(() => safetyCheck({ ...textbook(), processes: [1, 0, 2, 3, 4].map(asPid) })).toThrow(KernelInvariantError);
    expect(() => safetyCheck({ ...textbook(), resources: ['C', 'A', 'B'].map(asResourceId) })).toThrow(KernelInvariantError);
  });
});

const A = asResourceId('A');
const B = asResourceId('B');
const C = asResourceId('C');
const workProgram = () => instructionProgram(Array.from({ length: 1000 }, (): Instruction => ({ kind: 'compute' })));

function integrationKernel(): KernelImpl {
  return createKernel({
    ...REFERENCE_CONFIG, scheduler: 'rr',
    schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1 },
    deadlockStrategy: 'ignore', enabledSubsystems: ['process', 'scheduler', 'sync', 'deadlock'],
  }, { threadCreateTicks: 0, contextSwitchTicks: 0 });
}

function spawnWorker(kernel: KernelImpl, name: string): Pid {
  return kernel.spawn({ name, priority: 10, burst: 1000, service: 1000, arrival: 0, pages: 0 }, { program: workProgram() });
}

function dispatch(kernel: KernelImpl, pid: Pid): void {
  for (let remaining = 100; remaining > 0 && kernel.process(pid)?.state !== 'running'; remaining -= 1) kernel.step();
  expect(kernel.process(pid)?.state).toBe('running');
}

function liveBankers() {
  const kernel = integrationKernel();
  for (const [id, totalInstances] of [[A, 10], [B, 5], [C, 7]] as const) {
    kernel.declareResource({ id, displayName: id, totalInstances, preemptible: false });
  }
  const pids = [0, 1, 2, 3, 4].map(index => spawnWorker(kernel, `Bankers P${index}`));
  const source = textbook();
  const vector = (row: readonly number[]): readonly (readonly [ResourceId, number])[] =>
    source.resources.map((id, j) => [id, at([row], 0, j)] as const);
  pids.forEach((pid, i) => {
    const maximum = source.max[i];
    if (maximum === undefined) throw new Error('Missing textbook maximum.');
    kernel.declareClaims(pid, vector(maximum));
  });
  // Arrange the published starting matrix; requests below use the real subsystem path.
  pids.forEach((pid, i) => {
    const allocation = source.allocation[i];
    if (allocation === undefined) throw new Error('Missing textbook allocation.');
    kernel.deadlockSubsystem.resources.grant(pid, vector(allocation));
  });
  kernel.setDeadlockStrategy('avoid');
  const events: KernelEvent[] = [];
  kernel.events.onAny(event => events.push(event));
  const pid = (index: number): Pid => {
    const value = pids[index];
    if (value === undefined) throw new Error('Missing fixture pid.');
    return value;
  };
  const firstRequest = () => {
    dispatch(kernel, pid(1));
    expect(kernel.deadlockSubsystem.requestVector(pid(1), [[C, 2], [A, 1]])).toMatchObject({ ok: true });
  };
  return { kernel, pids, pid, events, firstRequest };
}

function continuation(kernel: KernelImpl): string {
  return JSON.stringify({
    tick: kernel.tick, processes: kernel.processes, threads: [...kernel.threads.table.values()],
    matrices: kernel.deadlockSubsystem.resources.bankersState(),
    deadlock: kernel.deadlockSubsystem.saveState(),
  });
}

describe('Bankers integration with resource syscalls and continuation state', () => {
  it('DL-BANKERS-2 commits the entire vector with lexical resource events and one complete safety trace', () => {
    const { kernel, pid, events } = liveBankers();
    dispatch(kernel, pid(1));
    events.length = 0;
    expect(kernel.deadlockSubsystem.requestVector(pid(1), [[C, 2], [A, 1]])).toEqual({ ok: true, value: null });
    const state = kernel.deadlockSubsystem.resources.bankersState();
    expect(state.processes).toEqual([2, 3, 4, 5, 6]);
    expect(state.available).toEqual([2, 3, 0]);
    expect(state.allocation[1]).toEqual([3, 0, 2]);
    expect(state.need[1]).toEqual([0, 2, 0]);
    expect(kernel.process(pid(1))?.heldResources.filter(id => id === A)).toHaveLength(3);
    expect(kernel.process(pid(1))?.heldResources.filter(id => id === C)).toHaveLength(2);
    expect(events.filter(event => event.type.startsWith('resource.'))).toMatchObject([
      { type: 'resource.requested', pid: pid(1), resource: A, instances: 1 },
      { type: 'resource.requested', pid: pid(1), resource: C, instances: 2 },
      { type: 'resource.granted', pid: pid(1), resource: A, instances: 1 },
      { type: 'resource.granted', pid: pid(1), resource: C, instances: 2 },
    ]);
    expect(events.filter(event => event.type === 'bankers.evaluated')).toMatchObject([{
      forRequest: { pid: pid(1), resource: A }, result: { safe: true, sequence: [3, 5, 2, 4, 6] },
    }]);
    kernel.deadlockSubsystem.resources.assertConservation();
  });

  it('DL-BANKERS-3 returns EAGAIN unavailable, blocks on the first column, and never partially allocates', () => {
    const { kernel, pid, events, firstRequest } = liveBankers();
    firstRequest();
    dispatch(kernel, pid(4));
    const before = kernel.deadlockSubsystem.resources.bankersState();
    events.length = 0;
    expect(kernel.deadlockSubsystem.requestVector(pid(4), [[B, 3], [A, 3]])).toMatchObject({ ok: false, errno: 'EAGAIN' });
    expect(kernel.process(pid(4))).toMatchObject({ state: 'waiting', blockedOn: { kind: 'semaphore', resource: A } });
    expect(kernel.process(pid(4))?.requestedResources).toEqual([A, A, A, B, B, B]);
    const after = kernel.deadlockSubsystem.resources.bankersState();
    expect(after.available).toEqual([2, 3, 0]);
    expect(after.allocation).toEqual(before.allocation);
    expect(events.filter(event => event.type === 'resource.denied')).toMatchObject([
      { pid: pid(4), resource: A, reason: 'unavailable' },
      { pid: pid(4), resource: B, reason: 'unavailable' },
    ]);
    expect(events.filter(event => event.type === 'resource.granted')).toHaveLength(0);
    kernel.deadlockSubsystem.resources.assertConservation();
  });

  it('DL-BANKERS-4 uses the scalar request syscall, returns EAGAIN unsafe, and rolls back every matrix cell', () => {
    const { kernel, pid, events, firstRequest } = liveBankers();
    firstRequest();
    dispatch(kernel, pid(0));
    const before = kernel.deadlockSubsystem.resources.bankersState();
    events.length = 0;
    expect(kernel.syscall({ name: 'request', pid: pid(0), args: [B, 2] })).toMatchObject({ ok: false, errno: 'EAGAIN' });
    const after = kernel.deadlockSubsystem.resources.bankersState();
    expect(after.available).toEqual([2, 3, 0]);
    expect(after.allocation[0]).toEqual([0, 1, 0]);
    expect(after.max).toEqual(before.max);
    expect(after.allocation).toEqual(before.allocation);
    expect(after.need).toEqual(before.need);
    expect(kernel.process(pid(0))).toMatchObject({ state: 'waiting', blockedOn: { kind: 'semaphore', resource: B } });
    expect(events.filter(event => event.type === 'resource.denied')).toMatchObject([{ pid: pid(0), resource: B, reason: 'unsafe' }]);
    const evaluated = events.find(event => event.type === 'bankers.evaluated');
    expect(evaluated?.type).toBe('bankers.evaluated');
    if (evaluated?.type !== 'bankers.evaluated') throw new Error('Missing safety evaluation.');
    expect(evaluated.result.trace).toEqual([{
      work: [2, 1, 0], candidate: null, admitted: false,
      explanation: 'No remaining process has Need <= Work [2, 1, 0]. Stuck: P2, P3, P4, P5, P6. State is UNSAFE.',
    }]);
    kernel.deadlockSubsystem.resources.assertConservation();
  });

  it('DL-BANKERS-5 returns EINVAL through the scalar syscall and exits with protection_fault', () => {
    const { kernel, pid } = liveBankers();
    dispatch(kernel, pid(1));
    expect(kernel.syscall({ name: 'request', pid: pid(1), args: [A, 2] })).toMatchObject({ ok: false, errno: 'EINVAL' });
    expect(kernel.process(pid(1))?.terminationReason).toBe('protection_fault');
    expect(kernel.process(pid(1))?.heldResources).toEqual([]);
    expect(kernel.deadlockSubsystem.resources.get(A)?.availableInstances).toBe(5);
    kernel.deadlockSubsystem.resources.assertConservation();
  });

  it('evaluateBankers emits its result twice and changes no process, allocation, request, checkpoint or clock', () => {
    const { kernel, pid, events } = liveBankers();
    dispatch(kernel, pid(1));
    events.length = 0;
    const before = continuation(kernel);
    const first = kernel.evaluateBankers(pid(1), A, 1);
    expect(kernel.evaluateBankers(pid(1), A, 1)).toEqual(first);
    expect(continuation(kernel)).toBe(before);
    expect(events.map(event => event.type)).toEqual(['bankers.evaluated', 'bankers.evaluated']);
    expect(events).toMatchObject([
      { type: 'bankers.evaluated', result: first, forRequest: { pid: pid(1), resource: A } },
      { type: 'bankers.evaluated', result: first, forRequest: { pid: pid(1), resource: A } },
    ]);
  });

  it('invalid and unavailable previews only emit terminal bankers.evaluated results', () => {
    const { kernel, pid, events, firstRequest } = liveBankers();
    firstRequest();
    events.length = 0;
    const before = continuation(kernel);
    for (const [process, resource, instances] of [[pid(4), A, 3], [pid(1), A, 2], [pid(0), asResourceId('missing'), 1], [asPid(100), A, 1]] as const) {
      const result = kernel.evaluateBankers(process, resource, instances);
      expect(result).toMatchObject({ safe: false, sequence: null });
      expect(result.trace).toHaveLength(1);
      expect(result.trace[0]).toMatchObject({ candidate: null, admitted: false });
    }
    expect(continuation(kernel)).toBe(before);
    expect(events.map(event => event.type)).toEqual(Array.from({ length: 4 }, () => 'bankers.evaluated'));
    expect(kernel.process(pid(1))?.terminationReason).toBeNull();
  });

  it('vector previews label the first nonzero lexical resource while retaining the full result', () => {
    const { kernel, pid, events } = liveBankers();
    const before = continuation(kernel);
    const result = kernel.deadlockSubsystem.evaluateVector(pid(1), [[C, 2], [B, 0], [A, 1]]);
    expect(result.sequence).toEqual([3, 5, 2, 4, 6]);
    expect(result.trace.map(step => step.work)).toEqual(expectedWork);
    expect(events).toMatchObject([{ type: 'bankers.evaluated', forRequest: { pid: pid(1), resource: A }, result }]);
    expect(events).toHaveLength(1);
    expect(continuation(kernel)).toBe(before);
  });

  it('columns follow lexical ids c,a,b independently of declaration ranks and projection rebuilds', () => {
    const kernel = integrationKernel();
    for (const id of ['c', 'a', 'b'].map(asResourceId)) kernel.declareResource({ id, displayName: id, totalInstances: 5, preemptible: false });
    const pid = spawnWorker(kernel, 'lexical columns');
    kernel.declareClaims(pid, [[asResourceId('c'), 3], [asResourceId('a'), 1], [asResourceId('b'), 2]]);
    const initial = kernel.deadlockSubsystem.resources.bankersState();
    expect(initial.resources).toEqual(['a', 'b', 'c']);
    expect(initial.max).toEqual([[1, 2, 3]]);
    dispatch(kernel, pid);
    expect(kernel.syscall({ name: 'request', pid, args: ['b', 2] })).toMatchObject({ ok: true });
    const granted = kernel.deadlockSubsystem.resources.bankersState();
    expect(granted.available).toEqual([5, 3, 5]);
    expect(granted.allocation).toEqual([[0, 2, 0]]);
    expect(granted.need).toEqual([[1, 0, 3]]);
    expect(initial.allocation).toEqual([[0, 0, 0]]);
    expect(kernel.syscall({ name: 'release', pid, args: ['b', 1] })).toMatchObject({ ok: true });
    expect(kernel.deadlockSubsystem.resources.bankersState().allocation).toEqual([[0, 1, 0]]);
    kernel.deadlockSubsystem.resources.assertConservation();
  });

  it('undeclared claims are zero and declarations after admission are rejected', () => {
    const kernel = integrationKernel();
    kernel.declareResource({ id: A, displayName: 'A', totalInstances: 1, preemptible: false });
    const pid = spawnWorker(kernel, 'zero claim');
    expect(kernel.deadlockSubsystem.resources.bankersState().max).toEqual([[0]]);
    kernel.setDeadlockStrategy('avoid');
    dispatch(kernel, pid);
    expect(() => kernel.declareClaims(pid, [[A, 1]])).toThrow(/before admission/);
    expect(kernel.syscall({ name: 'request', pid, args: [A, 1] })).toMatchObject({ ok: false, errno: 'EINVAL' });
    expect(kernel.process(pid)?.terminationReason).toBe('protection_fault');
  });

  it('fork inherits no claims, and exec clears the parent claim, owned resources and checkpoint', () => {
    const kernel = integrationKernel();
    kernel.declareResource({ id: A, displayName: 'A', totalInstances: 2, preemptible: true });
    const parent = spawnWorker(kernel, 'claim parent');
    kernel.declareClaims(parent, [[A, 2]]);
    dispatch(kernel, parent);
    expect(kernel.syscall({ name: 'request', pid: parent, args: [A, 1] })).toMatchObject({ ok: true });
    const fork = kernel.syscall({ name: 'fork', pid: parent, args: [] });
    expect(fork.ok).toBe(true);
    if (!fork.ok || typeof fork.value !== 'number') throw new Error('Expected fork child pid.');
    const child = asPid(fork.value);
    expect(kernel.deadlockSubsystem.resources.claim(child)).toEqual([]);
    expect(kernel.deadlockSubsystem.resources.claim(parent)).toEqual([[A, 2]]);
    kernel.registerProgram('fresh claimant', workProgram());
    expect(kernel.syscall({ name: 'exec', pid: parent, args: ['fresh claimant'] })).toMatchObject({ ok: true });
    expect(kernel.deadlockSubsystem.resources.claim(parent)).toEqual([]);
    expect(kernel.process(parent)?.heldResources).toEqual([]);
    expect(kernel.deadlockSubsystem.resources.get(A)?.availableInstances).toBe(2);
    const state = kernel.deadlockSubsystem.saveState();
    expect(state.deadlock.payload.checkpoints.some(checkpoint => checkpoint.pid === parent)).toBe(false);
    kernel.deadlockSubsystem.resources.assertConservation();
  });

  it('refuses to enter avoidance over an unsafe allocation without changing the active strategy', () => {
    const kernel = integrationKernel();
    kernel.declareResource({ id: A, displayName: 'A', totalInstances: 2, preemptible: false });
    const first = spawnWorker(kernel, 'unsafe first');
    const second = spawnWorker(kernel, 'unsafe second');
    kernel.declareClaims(first, [[A, 2]]);
    kernel.declareClaims(second, [[A, 2]]);
    kernel.deadlockSubsystem.resources.grant(first, [[A, 1]]);
    kernel.deadlockSubsystem.resources.grant(second, [[A, 1]]);
    const before = continuation(kernel);
    expect(() => kernel.setDeadlockStrategy('avoid')).toThrow(/unsafe|inconsistent/);
    expect(kernel.config.deadlockStrategy).toBe('ignore');
    expect(continuation(kernel)).toBe(before);
  });

  it('refuses to enter avoidance when existing holdings exceed an undeclared maximum', () => {
    const kernel = integrationKernel();
    kernel.declareResource({ id: A, displayName: 'A', totalInstances: 1, preemptible: false });
    const pid = spawnWorker(kernel, 'inconsistent allocation');
    kernel.deadlockSubsystem.resources.grant(pid, [[A, 1]]);
    expect(() => kernel.setDeadlockStrategy('avoid')).toThrow(/unsafe|inconsistent/);
    expect(kernel.config.deadlockStrategy).toBe('ignore');
  });
});

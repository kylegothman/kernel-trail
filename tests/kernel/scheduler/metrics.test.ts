import { describe, expect, it, vi } from 'vitest';
import { createKernel } from '@kernel/Kernel';
import { KernelInvariantError } from '@kernel/errors';
import { MinHeap } from '@kernel/scheduler/MinHeap';
import { SjfScheduler } from '@kernel/scheduler/sjf';
import { SchedulingAccounting, computeSchedulingMetrics } from '@kernel/scheduler/metrics';
import type { CompletedRecord, MetricsInput } from '@kernel/scheduler/metrics';
import { snapshotArray, snapshotObject } from '@kernel/scheduler/SchedulerBase';
import { tieBreak } from '@kernel/scheduler/tieBreak';
import { asPid, asTick } from '@kernel/types';
import type { JsonValue, ProcessControlBlock } from '@kernel/types';
import { canonical } from '../canonical';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';

const EMPTY: MetricsInput = {
  completed: [], tick: 0, busyTicks: 0, contextSwitches: 0, readyWaits: [],
};

function completed(arrival: number, firstRun: number, completion: number, service: number): CompletedRecord {
  return { arrivalTick: asTick(arrival), firstRunTick: asTick(firstRun), turnaround: completion - arrival, totalService: service };
}

function pcb(id: number, arrival = 0, service = 1): ProcessControlBlock {
  return {
    pid: asPid(id), parent: null, name: `P${id}`, state: 'ready',
    priority: 0, basePriority: 0, arrivalTick: asTick(arrival),
    cpuBurstRemaining: service, serviceRemaining: service, totalCpuUsed: 0,
    readySince: asTick(arrival), lastScheduledTick: null, queueLevel: 0,
    addressSpaceId: id as ProcessControlBlock['addressSpaceId'], threads: [],
    openFiles: [], heldResources: [], requestedResources: [], blockedOn: null,
    domain: 'user' as ProcessControlBlock['domain'], exitCode: null,
    terminationReason: null, convoyMemberId: null,
  };
}

describe('scheduling metric arithmetic', () => {
  it('empty completed and ready sets give finite zeros', () => {
    const result = computeSchedulingMetrics(EMPTY);
    expect(result).toEqual({
      averageWaitingTime: 0, averageTurnaroundTime: 0, averageResponseTime: 0,
      throughput: 0, cpuUtilisation: 0, contextSwitches: 0, worstWait: 0,
    });
    expect(Object.values(result).every(Number.isFinite)).toBe(true);
    expect(() => canonical(result)).not.toThrow();
  });

  it('keeps empty averages and ready waits at zero after elapsed idle time', () => {
    expect(computeSchedulingMetrics({ ...EMPTY, tick: 400 }).worstWait).toBe(0);
    expect(computeSchedulingMetrics({ ...EMPTY, tick: 400 }).averageWaitingTime).toBe(0);
  });

  it('computes unweighted textbook FCFS means from completed records', () => {
    const result = computeSchedulingMetrics({
      ...EMPTY, tick: 30, busyTicks: 30, contextSwitches: 3,
      completed: [completed(0, 0, 24, 24), completed(0, 24, 27, 3), completed(0, 27, 30, 3)],
    });
    expect(result).toEqual({
      averageWaitingTime: 17, averageTurnaroundTime: 27, averageResponseTime: 17,
      throughput: 10, cpuUtilisation: 1, contextSwitches: 3, worstWait: 0,
    });
  });

  it('reports completions per 100 ticks and the fraction of busy ticks', () => {
    const result = computeSchedulingMetrics({
      ...EMPTY, completed: Array.from({ length: 8 }, () => completed(0, 0, 1, 1)),
      tick: 400, busyTicks: 300,
    });
    expect(result.throughput).toBe(2);
    expect(result.cpuUtilisation).toBe(0.75);
  });

  it('guards elapsed-time division at tick zero even with supplied counters', () => {
    const result = computeSchedulingMetrics({
      ...EMPTY, completed: [completed(0, 0, 1, 1)], busyTicks: 1,
    });
    expect(result.throughput).toBe(0);
    expect(result.cpuUtilisation).toBe(0);
    expect(Object.values(result).every(Number.isFinite)).toBe(true);
  });

  it('takes the longest current ready residence', () => {
    expect(computeSchedulingMetrics({ ...EMPTY, readyWaits: [3, 40, 12] }).worstWait).toBe(40);
  });
});

describe('scheduling accounting', () => {
  it('reproduces SRTF metrics from dispatch and completion boundaries', () => {
    const accounting = new SchedulingAccounting();
    const first = pcb(2, 1, 8);
    const second = pcb(3, 2, 4);
    const third = pcb(4, 3, 9);
    const fourth = pcb(5, 4, 5);
    accounting.dispatch(first, asTick(0));
    accounting.dispatch(second, asTick(1));
    accounting.dispatch(fourth, asTick(5));
    accounting.dispatch(first, asTick(10));
    accounting.dispatch(third, asTick(17));
    for (const [process, completion] of [[second, 5], [fourth, 10], [first, 17], [third, 26]] as const) {
      process.totalCpuUsed = process.serviceRemaining;
      accounting.complete(process, asTick(completion));
    }
    for (let tick = 0; tick < 26; tick += 1) accounting.accountBusyTick();
    expect(accounting.recompute(asTick(26), [], 5)).toEqual({
      averageWaitingTime: 6.5, averageTurnaroundTime: 13, averageResponseTime: 4.25,
      throughput: 400 / 26, cpuUtilisation: 1, contextSwitches: 5, worstWait: 0,
    });
  });

  it('records first dispatch and completion once, independent of later PCB changes', () => {
    const accounting = new SchedulingAccounting();
    const process = pcb(2, 1, 3);
    accounting.dispatch(process, asTick(2));
    accounting.dispatch(process, asTick(6));
    process.totalCpuUsed = 3;
    accounting.complete(process, asTick(9));
    const before = accounting.recompute(asTick(10), [], 2);
    process.totalCpuUsed = 100;
    process.serviceRemaining = 200;
    accounting.complete(process, asTick(100));
    expect(accounting.recompute(asTick(10), [], 2)).toEqual(before);
    expect(before).toMatchObject({ averageWaitingTime: 6, averageTurnaroundTime: 9, averageResponseTime: 2, throughput: 10 });
  });

  it('handles never-dispatched termination without non-finite response time', () => {
    const accounting = new SchedulingAccounting();
    const process = pcb(2, 1);
    process.state = 'zombie';
    accounting.complete(process, asTick(300));
    expect(accounting.recompute(asTick(300), [process], 0)).toMatchObject({
      averageWaitingTime: 300, averageTurnaroundTime: 300, averageResponseTime: 0,
    });
  });

  it('excludes idle and init, and counts waits only for currently ready user processes', () => {
    const accounting = new SchedulingAccounting();
    const idle = pcb(0);
    const init = pcb(1);
    const ready = pcb(2, 10);
    const waiting = pcb(3);
    const running = pcb(4);
    waiting.state = 'waiting';
    running.state = 'running';
    for (const process of [idle, init]) {
      accounting.dispatch(process, asTick(0));
      accounting.complete(process, asTick(40));
    }
    const result = accounting.recompute(asTick(40), [idle, init, ready, waiting, running], 0);
    expect(result).toMatchObject({ throughput: 0, averageTurnaroundTime: 0, worstWait: 30 });
    ready.readySince = null;
    expect(accounting.recompute(asTick(40), [ready], 0).worstWait).toBe(0);
  });

  it('recomputes bit-identical values after 500 ticks with no intervening state change', () => {
    const accounting = new SchedulingAccounting();
    const process = pcb(2, 1, 300);
    accounting.dispatch(process, asTick(0));
    for (let tick = 1; tick <= 500; tick += 1) {
      if (tick <= 300) accounting.accountBusyTick();
      if (tick === 300) {
        process.totalCpuUsed = 300;
        process.state = 'zombie';
        accounting.complete(process, asTick(tick));
      }
      accounting.recompute(asTick(tick), [process], 1);
    }
    const held = structuredClone(accounting.recompute(asTick(500), [process], 1));
    const recomputed = accounting.recompute(asTick(500), [process], 1);
    expect(canonical(recomputed)).toBe(canonical(held));
    expect(recomputed.cpuUtilisation).toBe(0.6);
    expect(recomputed.throughput).toBe(0.2);
  });

  it('reset clears completion records, first dispatches and busy counters', () => {
    const accounting = new SchedulingAccounting();
    const process = pcb(2, 1);
    accounting.dispatch(process, asTick(0));
    process.totalCpuUsed = 1;
    accounting.complete(process, asTick(1));
    accounting.accountBusyTick();
    accounting.reset();
    expect(accounting.recompute(asTick(0), [], 0)).toEqual(computeSchedulingMetrics(EMPTY));
    accounting.dispatch(process, asTick(4));
    accounting.complete(process, asTick(5));
    expect(accounting.recompute(asTick(5), [], 1).averageResponseTime).toBe(4);
  });

  it('keeps reference kernel metrics canonical-safe through 5000 FCFS ticks', () => {
    // Real round robin is WP-04. This test deliberately requests FCFS.
    const kernel = createKernel({ ...REFERENCE_CONFIG, scheduler: 'fcfs' });
    for (let tick = 0; tick < 5000; tick += 1) {
      kernel.step();
      expect(() => canonical(kernel.snapshot().metrics.scheduling)).not.toThrow();
    }
    const held = canonical(kernel.snapshot().metrics.scheduling);
    kernel.run(0);
    expect(canonical(kernel.snapshot().metrics.scheduling)).toBe(held);
  });

  it('feeds completed FCFS work and idle time into the actual kernel metrics', () => {
    const recompute = vi.spyOn(SchedulingAccounting.prototype, 'recompute');
    try {
      const kernel = createKernel({ ...REFERENCE_CONFIG, scheduler: 'fcfs', enabledSubsystems: ['process', 'scheduler'] }, { threadCreateTicks: 0 });
      for (const [index, burst] of [24, 3, 3].entries()) {
        kernel.spawn({ name: `P${index + 1}`, priority: 0, burst, service: burst, arrival: 0, pages: 0 });
      }
      kernel.run(500);
      const latest = recompute.mock.results.at(-1);
      if (latest?.type !== 'return') throw new Error('kernel did not compute scheduling metrics');
      expect(latest.value).toMatchObject({
        averageWaitingTime: 17, averageTurnaroundTime: 27, averageResponseTime: 17,
        throughput: 0.6, cpuUtilisation: 0.06, worstWait: 0,
      });
      const calls = recompute.mock.calls.length;
      kernel.run(0);
      expect(recompute.mock.calls).toHaveLength(calls);
    } finally {
      recompute.mockRestore();
    }
  });

  it('keeps external termination after a serviced tick from producing negative wait', () => {
    const recompute = vi.spyOn(SchedulingAccounting.prototype, 'recompute');
    try {
      const kernel = createKernel({ ...REFERENCE_CONFIG, scheduler: 'fcfs', enabledSubsystems: ['process', 'scheduler'] }, { threadCreateTicks: 0 });
      const pid = kernel.spawn({ name: 'worker', priority: 0, burst: 10, service: 10, arrival: 0, pages: 0 });
      kernel.step();
      expect(kernel.syscall({ name: 'kill', pid, args: [pid] }).ok).toBe(true);
      expect(() => kernel.step()).not.toThrow();
      const latest = recompute.mock.results.at(-1);
      if (latest?.type !== 'return') throw new Error('kernel did not compute scheduling metrics');
      expect(latest.value).toMatchObject({ averageWaitingTime: 0, averageTurnaroundTime: 1, averageResponseTime: 0 });
    } finally {
      recompute.mockRestore();
    }
  });
});

describe('scheduling accounting persistence', () => {
  function savedFixture() {
    return {
      busyTicks: 5,
      firstRuns: [[2, 3], [9, 0]],
      completed: [{ pid: 9, arrivalTick: 0, firstRunTick: 0, turnaround: 3, totalService: 3 }],
    };
  }

  it('round-trips completed and unfinished work, then continues with exact metrics', () => {
    const source = new SchedulingAccounting();
    const done = pcb(9, 1, 3);
    const unfinished = pcb(2, 2, 5);
    const waiting = pcb(5, 4);
    source.dispatch(done, asTick(0));
    done.totalCpuUsed = 3;
    done.state = 'zombie';
    source.complete(done, asTick(3));
    source.dispatch(unfinished, asTick(3));
    unfinished.totalCpuUsed = 2;
    unfinished.state = 'running';
    for (let tick = 0; tick < 5; tick += 1) source.accountBusyTick();
    expect(source.saveState()).toEqual(savedFixture());
    const restored = new SchedulingAccounting();
    restored.restoreState(source.saveState());
    const processes = [done, unfinished, waiting];
    expect(canonical(restored.recompute(asTick(5), processes, 2)))
      .toBe(canonical(source.recompute(asTick(5), processes, 2)));
    unfinished.totalCpuUsed = 5;
    unfinished.state = 'zombie';
    for (const accounting of [source, restored]) {
      accounting.dispatch(unfinished, asTick(5));
      for (let tick = 0; tick < 3; tick += 1) accounting.accountBusyTick();
      accounting.complete(unfinished, asTick(8));
    }
    expect(canonical(restored.saveState())).toBe(canonical(source.saveState()));
    expect(canonical(restored.recompute(asTick(10), processes, 2)))
      .toBe(canonical(source.recompute(asTick(10), processes, 2)));
    expect(restored.recompute(asTick(10), processes, 2)).toEqual({
      averageWaitingTime: 1, averageTurnaroundTime: 5, averageResponseTime: 1,
      throughput: 20, cpuUtilisation: 0.8, contextSwitches: 2, worstWait: 6,
    });
  });

  it('serializes first dispatches and completion records in ascending pid order', () => {
    const accounting = new SchedulingAccounting();
    const first = pcb(9);
    const second = pcb(2);
    for (const process of [first, second]) {
      accounting.dispatch(process, asTick(0));
      accounting.complete(process, asTick(0));
    }
    expect(accounting.saveState()).toEqual({
      busyTicks: 0,
      firstRuns: [[2, 0], [9, 0]],
      completed: [
        { pid: 2, arrivalTick: 0, firstRunTick: 0, turnaround: 0, totalService: 0 },
        { pid: 9, arrivalTick: 0, firstRunTick: 0, turnaround: 0, totalService: 0 },
      ],
    });
  });

  it('detaches every saved row and pair from live accounting state', () => {
    const accounting = new SchedulingAccounting();
    accounting.restoreState(savedFixture());
    const before = canonical(accounting.saveState());
    const saved = snapshotObject(accounting.saveState(), 'saved accounting');
    Reflect.set(saved, 'busyTicks', 100);
    const firstRuns = snapshotArray(saved['firstRuns'], 'saved first runs');
    const pair = snapshotArray(firstRuns[0], 'saved first run');
    Reflect.set(pair, 1, 99);
    const rows = snapshotArray(saved['completed'], 'saved completions');
    const record = snapshotObject(rows[0], 'saved completion');
    Reflect.set(record, 'totalService', 100);
    expect(canonical(accounting.saveState())).toBe(before);
  });

  it('prepares without mutation and detaches parsed data before committing', () => {
    const accounting = new SchedulingAccounting();
    const before = canonical(accounting.saveState());
    const state = savedFixture();
    const expected = canonical(state);
    const commit = accounting.prepareRestore(state);
    expect(canonical(accounting.saveState())).toBe(before);
    state.busyTicks = 100;
    state.firstRuns[0] = [2, 100];
    state.completed[0] = { pid: 9, arrivalTick: 0, firstRunTick: 0, turnaround: 100, totalService: 100 };
    commit();
    expect(canonical(accounting.saveState())).toBe(expected);
  });

  it('rejects malformed counters, identities and records without partial mutation', () => {
    const accounting = new SchedulingAccounting();
    const valid = savedFixture();
    accounting.restoreState(valid);
    const before = canonical(accounting.saveState());
    const record = { pid: 9, arrivalTick: 0, firstRunTick: 0, turnaround: 3, totalService: 3 };
    const malformed: readonly JsonValue[] = [
      null,
      {},
      { ...valid, busyTicks: -1 },
      { ...valid, busyTicks: 1.5 },
      { ...valid, busyTicks: Number.NaN },
      { ...valid, busyTicks: Number.POSITIVE_INFINITY },
      { ...valid, busyTicks: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, firstRuns: [[0, 1]] },
      { ...valid, firstRuns: [[1, 1]] },
      { ...valid, firstRuns: [[2.5, 1]] },
      { ...valid, firstRuns: [[2, -1]] },
      { ...valid, firstRuns: [[2, 0.5]] },
      { ...valid, firstRuns: [[2]] },
      { ...valid, firstRuns: [[2, 1, 2]] },
      { ...valid, firstRuns: [[2, 3], [2, 4]] },
      { ...valid, completed: [{ ...record, pid: 1 }] },
      { ...valid, completed: [record, { ...record }] },
      { ...valid, completed: [{ ...record, arrivalTick: -1 }] },
      { ...valid, completed: [{ ...record, firstRunTick: Number.NaN }] },
      { ...valid, completed: [{ ...record, turnaround: Number.POSITIVE_INFINITY }] },
      { ...valid, completed: [{ ...record, turnaround: 2 }] },
      { ...valid, completed: [{ ...record, totalService: -1 }] },
      { ...valid, completed: [{ ...record, totalService: 0.5 }] },
      { ...valid, completed: [{ ...record, arrivalTick: 1 }] },
      { ...valid, completed: [{ ...record, firstRunTick: 1 }] },
      { ...valid, firstRuns: [[9, 1]] },
      { ...valid, firstRuns: [] },
      { ...valid, firstRuns: [[9, Number.MAX_SAFE_INTEGER]], completed: [
        { ...record, arrivalTick: Number.MAX_SAFE_INTEGER, firstRunTick: Number.MAX_SAFE_INTEGER },
      ] },
    ];
    for (const state of malformed) {
      expect(() => accounting.prepareRestore(state)).toThrow();
      expect(canonical(accounting.saveState())).toBe(before);
      expect(() => accounting.restoreState(state)).toThrow();
      expect(canonical(accounting.saveState())).toBe(before);
    }
  });

  it('round-trips a terminated process that never received a dispatch', () => {
    const source = new SchedulingAccounting();
    const neverRan = pcb(2, 1);
    source.complete(neverRan, asTick(300));
    const restored = new SchedulingAccounting();
    restored.restoreState(source.saveState());
    expect(canonical(restored.recompute(asTick(300), [], 0)))
      .toBe(canonical(source.recompute(asTick(300), [], 0)));
  });
});

describe('scheduler heap maintenance', () => {
  function fixture() {
    const processes = Array.from({ length: 32 }, (_, index) => pcb(index + 2, index % 4, 32 - index));
    let comparisons = 0;
    const heap = new MinHeap(
      pid => processes.find(process => process.pid === pid),
      (a, b) => { comparisons += 1; return a.serviceRemaining - b.serviceRemaining || tieBreak(a, b); },
    );
    for (const process of processes) heap.push(process.pid);
    return { heap, processes, comparisons: () => comparisons };
  }

  it('caches a sorted view without repeating comparisons on repeated snapshots', () => {
    const { heap, comparisons } = fixture();
    const view = heap.toArray();
    expect(view).toEqual(Array.from({ length: 32 }, (_, index) => asPid(33 - index)));
    const count = comparisons();
    for (let repeat = 0; repeat < 10000; repeat += 1) expect(heap.toArray()).toBe(view);
    expect(comparisons()).toBe(count);
  });

  it('deduplicates membership and repairs arbitrary removals in both heap directions', () => {
    const { heap, processes } = fixture();
    for (const process of processes) heap.push(process.pid);
    expect(heap.size).toBe(32);
    for (const pid of [asPid(13), asPid(33), asPid(2), asPid(17)]) {
      expect(heap.remove(pid)).toBe(true);
      expect(heap.remove(pid)).toBe(false);
    }
    const expected = processes.filter(process => ![13, 33, 2, 17].includes(process.pid))
      .sort((a, b) => a.serviceRemaining - b.serviceRemaining || tieBreak(a, b)).map(process => process.pid);
    expect(heap.toArray()).toEqual(expected);
    expect(expected.map(() => heap.pop())).toEqual(expected);
    expect(heap.size).toBe(0);
    expect(heap.peek()).toBeNull();
    expect(heap.pop()).toBeNull();
    expect(heap.toArray()).toEqual([]);
  });

  it('rebuilds changed keys with a linear number of comparisons and invalidates the view', () => {
    const { heap, processes, comparisons } = fixture();
    const view = heap.toArray();
    for (const process of processes) process.serviceRemaining = process.pid;
    const before = comparisons();
    heap.rebuild();
    expect(comparisons() - before).toBeLessThan(processes.length * 2);
    expect(heap.peek()).toBe(asPid(2));
    expect(heap.toArray()).toBe(view);
    expect(view).toEqual(processes.map(process => process.pid));
  });

  it('rejects an unknown process before adding it', () => {
    const { heap } = fixture();
    expect(() => heap.push(asPid(1000))).toThrow(KernelInvariantError);
    expect(heap.size).toBe(32);
  });
});


describe('phase 10 metrics hook dispatch', () => {
  it('merges independent memory registrations and runs enabled metrics after execution', () => {
    const kernel = createKernel(REFERENCE_CONFIG);
    const memoryValue = kernel.snapshot().metrics.memory;
    const calls: string[] = [];
    kernel.installHooks({ metrics: { memory: tick => { calls.push(`memory:${tick}`); return memoryValue; } } });
    kernel.installHooks({ metrics: { scheduler: tick => {
      calls.push(`scheduler:${tick}`);
      return computeSchedulingMetrics({ ...EMPTY, tick });
    } } });
    kernel.onPhase(phase => { if (phase >= 8) calls.push(`phase:${phase}`); });
    kernel.step();
    expect(calls).toEqual(['phase:8', 'phase:9', 'phase:10', 'scheduler:1', 'memory:1', 'phase:11']);
  });
  it('does not invoke disabled subsystem metrics hooks', () => {
    const kernel = createKernel({ ...REFERENCE_CONFIG, enabledSubsystems: ['process'] });
    const never = vi.fn((): never => { throw new Error('disabled metrics hook ran'); });
    kernel.installHooks({ metrics: { scheduler: never, memory: never } });
    kernel.run(3);
    expect(never).not.toHaveBeenCalled();
  });
  it('retains scheduler accounting when only the memory hook is replaced', () => {
    const kernel = createKernel(REFERENCE_CONFIG);
    const memoryValue = kernel.snapshot().metrics.memory;
    const spy = vi.spyOn(SchedulingAccounting.prototype, 'recompute');
    try {
      kernel.installHooks({ metrics: { memory: () => memoryValue } });
      kernel.spawn({ name: 'work', arrival: 0, burst: 2, service: 2, priority: 20, pages: 0 });
      kernel.run(2);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.results.at(-1)?.value).toMatchObject({ averageWaitingTime: 0,
        averageTurnaroundTime: 2, throughput: 50, cpuUtilisation: 1 });
    } finally { spy.mockRestore(); }
  });
});


it('kernel supplies raw bursts and updates estimates in phase 10 of the completing tick', () => {
  const observed = vi.spyOn(SjfScheduler.prototype, 'observeProcesses');
  try {
    const kernel = createKernel({ ...REFERENCE_CONFIG, scheduler: 'sjf' }, { threadCreateTicks: 0 });
    const pid = kernel.spawn({ name: 'burst', arrival: 0, burst: 10, service: 30, priority: 10, pages: 0 });
    kernel.run(6);
    kernel.blockProcess(pid, { kind: 'sleep', untilTick: asTick(8) });
    const policy: unknown = observed.mock.contexts.at(-1);
    if (!(policy instanceof SjfScheduler)) throw new Error('phase 10 did not observe the scheduler');
    expect(policy.estimatedNextBurst(pid)).toBe(8);
    kernel.run(5);
    expect(kernel.process(pid)?.totalCpuUsed).toBe(10);
    expect(policy.estimatedNextBurst(pid)).toBe(6);
    kernel.step();
    expect(policy.estimatedNextBurst(pid)).toBe(6);
  } finally { observed.mockRestore(); }
});

it('kernel initializes an accelerated process estimate from its raw spec burst', () => {
  const observed = vi.spyOn(SjfScheduler.prototype, 'observeProcesses');
  try {
    const kernel = createKernel({ ...REFERENCE_CONFIG, scheduler: 'sjf' }, { threadCreateTicks: 0, coreCount: 2 });
    const pid = kernel.spawn({ name: 'parallel', arrival: 0, burst: 10, service: 100, priority: 10, pages: 0 },
      { threadCount: 2, serialFraction: 0.25 });
    kernel.step();
    const policy: unknown = observed.mock.contexts.at(-1);
    if (!(policy instanceof SjfScheduler)) throw new Error('phase 10 did not observe the scheduler');
    expect(kernel.process(pid)?.cpuBurstRemaining).toBeLessThan(10);
    expect(policy.estimatedNextBurst(pid)).toBe(10);
  } finally { observed.mockRestore(); }
});

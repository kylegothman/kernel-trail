import { describe, expect, it } from 'vitest';
import { createKernel } from '@kernel/Kernel';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';
import { SchedulerBase } from '@kernel/scheduler/SchedulerBase';
import { createScheduler, SCHEDULERS, EMPTY_METRICS } from '@kernel/scheduler/SchedulerRegistry';
import { SjfScheduler, sjfCmp } from '@kernel/scheduler/sjf';
import { SrtfScheduler, srtfCmp } from '@kernel/scheduler/srtf';
import { priorityCmp } from '@kernel/scheduler/priority';
import { assertTotalOrder, tieBreak } from '@kernel/scheduler/tieBreak';
import { asPid, asTick } from '@kernel/types';
import type { JsonValue, Pid, ProcessControlBlock, SchedulerContext, SchedulerId,
  SchedulingDecision, SubsystemEnvelope } from '@kernel/types';
import { canonical } from '../canonical';
import { createWorkloadKernel, IMPLEMENTED_POLICIES, runWorkload, schedulerParams,
  unitContext, unitProcesses, type WorkloadRow } from './workloadRunner';

const LONG_FIRST: readonly WorkloadRow[] = [
  { name: 'P1', arrival: 0, burst: 24 },
  { name: 'P2', arrival: 0, burst: 3 },
  { name: 'P3', arrival: 0, burst: 3 },
];
const SHORT_FIRST: readonly WorkloadRow[] = [LONG_FIRST[1]!, LONG_FIRST[2]!, LONG_FIRST[0]!];

describe('FCFS textbook fixtures', () => {
  it('SCHED-FCFS-1: long process first', () => {
    const result = runWorkload('fcfs', {}, LONG_FIRST);
    expect(result.gantt).toBe('P1[0-24] P2[24-27] P3[27-30]');
    expect(result.averages.waiting).toBeCloseTo(17, 9);
    expect(result.averages.turnaround).toBeCloseTo(27, 9);
    expect(result.averages.response).toBeCloseTo(17, 9);
    expect(result.contextSwitches).toBe(3);
    expect(result.dispatches).toBe(3);
    expect(result.quantumExpiries).toBe(0);
    expect(result.perProcess).toEqual(new Map([
      ['P1', { waiting: 0, turnaround: 24, response: 0 }],
      ['P2', { waiting: 24, turnaround: 27, response: 24 }],
      ['P3', { waiting: 27, turnaround: 30, response: 27 }],
    ]));
  });

  it('SCHED-FCFS-2: short processes first', () => {
    const result = runWorkload('fcfs', {}, SHORT_FIRST);
    expect(result.gantt).toBe('P2[0-3] P3[3-6] P1[6-30]');
    expect(result.averages.waiting).toBeCloseTo(3, 9);
    expect(result.averages.turnaround).toBeCloseTo(13, 9);
    expect(result.averages.response).toBeCloseTo(3, 9);
  });

  it('convoy effect: submission order changes waiting despite identical service', () => {
    expect(LONG_FIRST.reduce((sum, row) => sum + row.burst, 0))
      .toBe(SHORT_FIRST.reduce((sum, row) => sum + row.burst, 0));
    expect(runWorkload('fcfs', {}, LONG_FIRST).averages.waiting)
      .toBeGreaterThan(runWorkload('fcfs', {}, SHORT_FIRST).averages.waiting);
  });

  it('non-preemptive: a higher-priority arrival waits for completion', () => {
    const result = runWorkload('fcfs', { preemptive: true }, [
      { name: 'running', arrival: 0, burst: 5, priority: 9 },
      { name: 'arrival', arrival: 1, burst: 1, priority: 1 },
    ]);
    expect(result.gantt).toBe('running[0-5] arrival[5-6]');
    expect(result.events.filter(event => event.type === 'context.switch' && event.tick > 1 && event.tick <= 5)).toEqual([]);
  });

  it('an unblock enters ahead of a same-tick admission, even with a higher pid', () => {
    const { kernel, pids } = createWorkloadKernel('fcfs', {}, [
      { name: 'arrival', arrival: 3, burst: 5 },
      { name: 'sleeper', arrival: 0, burst: 5 },
    ]);
    const sleeper = pids.get('sleeper');
    const arrival = pids.get('arrival');
    if (sleeper === undefined || arrival === undefined) throw new Error('missing fixture processes');
    kernel.step();
    kernel.blockProcess(sleeper, { kind: 'sleep', untilTick: asTick(4) });
    kernel.run(3);
    expect(kernel.process(sleeper)?.state).toBe('running');
    expect(kernel.process(arrival)).toMatchObject({ state: 'ready', readySince: 4 });
  });

  it('idle and init stay outside user ready queues and dispatches', () => {
    const { kernel } = createWorkloadKernel('fcfs', {}, [{ name: 'user', arrival: 3, burst: 2 }]);
    const readyPids: number[] = [];
    kernel.installHooks({ scheduler: { ageAndDetectStarvation: ctx => readyPids.push(...ctx.readyQueue) } });
    const events = kernel.run(8);
    expect(readyPids.every(pid => pid > 1)).toBe(true);
    expect(readyPids.length).toBeGreaterThan(0);
    for (const event of events) {
      if (event.type === 'context.switch' && event.to !== null) expect(event.to).toBeGreaterThan(1);
    }
    expect(kernel.processes.some(pcb => pcb.pid === 0)).toBe(false);
  });
});

describe('scheduler foundation', () => {
  it.each(IMPLEMENTED_POLICIES)('%s retains snapshot and queue identities across 10,000 reads', id => {
    const policy = createScheduler(id, schedulerParams());
    const processes = unitProcesses([{ name: 'P1', arrival: 0, burst: 20 }, { name: 'P2', arrival: 1, burst: 10 }]);
    const ctx = unitContext(processes);
    for (const pcb of processes) policy.onAdmit(pcb, ctx);
    const snapshot = policy.snapshot();
    const queues = snapshot.queues;
    const queue = queues[0];
    for (let index = 0; index < 10_000; index++) {
      const current = policy.snapshot();
      expect(current).toBe(snapshot);
      expect(current.queues).toBe(queues);
      expect(current.queues[0]).toBe(queue);
    }
    policy.configure(schedulerParams({ quantum: 8 }));
    expect(policy.snapshot().queues.flat()).toEqual(processes.map(pcb => pcb.pid).sort((a, b) => {
      const first = processes.find(pcb => pcb.pid === a);
      const second = processes.find(pcb => pcb.pid === b);
      if (first === undefined || second === undefined) throw new Error('missing queue process');
      return id === 'sjf' || id === 'srtf' ? sjfCmp(first, second) : tieBreak(first, second);
    }));
  });

  it.each(['priority_aging', 'rr', 'mlfq'] as const)('%s is an explicit WP-04 stub', id => {
    expect(() => SCHEDULERS[id]()).toThrow(`not implemented: ${id}`);
    expect(() => createScheduler(id, schedulerParams())).toThrow(/^not implemented:/);
  });

  it.each([
    ['tieBreak', tieBreak], ['sjfCmp', sjfCmp], ['srtfCmp', srtfCmp], ['priorityCmp', priorityCmp],
  ] as const)('%s is total over 500 distinct PCB pairs', (_name, comparator) => {
    const samples = unitProcesses(Array.from({ length: 1_000 }, (_, index) => ({
      name: `pair-${index}`, arrival: Math.floor(index / 4) % 5,
      burst: 1 + Math.floor(index / 2) % 7, priority: Math.floor(index / 2) % 3,
    })));
    for (let index = 0; index < 1_000; index += 2) {
      const a = samples[index];
      const b = samples[index + 1];
      if (a === undefined || b === undefined) throw new Error('missing comparator pair');
      expect(() => assertTotalOrder(comparator, [a, b])).not.toThrow();
      expect(comparator(a, b)).not.toBe(0);
    }
  });

  const swaps = IMPLEMENTED_POLICIES.flatMap(from => IMPLEMENTED_POLICIES
    .filter(to => to !== from).map(to => [from, to] as const));
  it.each(swaps)('setScheduler %s to %s preserves the ready set mid-run', (from, to) => {
    const { kernel } = createWorkloadKernel(from, {}, [
      { name: 'P1', arrival: 0, burst: 40, priority: 5 },
      { name: 'P2', arrival: 0, burst: 30, priority: 3 },
      { name: 'P3', arrival: 0, burst: 20, priority: 1 },
    ]);
    kernel.run(3);
    const readyBefore = kernel.processes.filter(pcb => pcb.pid > 1 && pcb.state === 'ready').map(pcb => pcb.pid);
    const runningBefore = kernel.processes.find(pcb => pcb.pid > 1 && pcb.state === 'running')?.pid;
    const events: string[] = [];
    kernel.events.onAny(event => events.push(event.type));
    kernel.setScheduler(to, { preemptive: true });
    expect(kernel.processes.filter(pcb => pcb.pid > 1 && pcb.state === 'ready').map(pcb => pcb.pid)).toEqual(readyBefore);
    expect(kernel.processes.find(pcb => pcb.pid > 1 && pcb.state === 'running')?.pid).toBe(runningBefore);
    expect(events).not.toContain('context.switch');
    expect(() => kernel.run(3)).not.toThrow();
    expect(kernel.processes.filter(pcb => pcb.pid > 1 && ['ready', 'running'].includes(pcb.state))).toHaveLength(3);
    expect(kernel.processes.filter(pcb => pcb.pid > 1 && pcb.state === 'running')).toHaveLength(1);
  });
});


it('phase 6 receives ready insertion order with unblocks before lower-pid admissions', () => {
  const { kernel, pids } = createWorkloadKernel('fcfs', {}, [
    { name: 'arrival', arrival: 3, burst: 4 },
    { name: 'sleeper', arrival: 0, burst: 4 },
  ]);
  const sleeper = pids.get('sleeper'); const arrival = pids.get('arrival');
  if (sleeper === undefined || arrival === undefined) throw new Error('missing ordered-ready fixture');
  const observed: number[][] = [];
  kernel.installHooks({ scheduler: { ageAndDetectStarvation: ctx => {
    if (ctx.tick === 4) observed.push([...ctx.readyQueue]);
  } } });
  kernel.step(); kernel.blockProcess(sleeper, { kind: 'sleep', untilTick: asTick(4) });
  kernel.run(3);
  expect(observed).toEqual([[sleeper, arrival]]);
  expect(kernel.process(sleeper)?.state).toBe('running');
});


function persistentPolicy(id: SchedulerId): SchedulerBase {
  const policy = createScheduler(id, schedulerParams({ preemptive: true, quantum: 7 }));
  if (!(policy instanceof SchedulerBase)) throw new Error('registry must use the shared base');
  return policy;
}

interface PolicyRun {
  readonly policy: SchedulerBase;
  readonly processes: ProcessControlBlock[];
  tick: number;
  running: Pid | null;
  sliceElapsed: number;
}

function runContext(run: PolicyRun): SchedulerContext {
  return unitContext(run.processes, { tick: asTick(run.tick), running: run.running,
    sliceElapsed: run.sliceElapsed, params: run.policy.configuredParams });
}

function advancePolicy(run: PolicyRun): SchedulingDecision {
  for (const pcb of run.processes) {
    if (pcb.state === 'new' && pcb.arrivalTick <= run.tick + 1) {
      pcb.state = 'ready'; pcb.readySince = asTick(run.tick);
      run.policy.onAdmit(pcb, runContext(run));
    }
  }
  const decision = run.policy.onTick(runContext(run));
  if (decision.next !== run.running) {
    const outgoing = run.processes.find(pcb => pcb.pid === run.running);
    if (outgoing !== undefined && outgoing.state === 'running') {
      outgoing.state = 'ready'; outgoing.readySince = asTick(run.tick);
      run.running = null;
      run.policy.onUnblock(outgoing, runContext(run));
    }
    const incoming = run.processes.find(pcb => pcb.pid === decision.next);
    if (decision.next !== null && incoming === undefined) throw new Error('missing selected process');
    if (incoming !== undefined) {
      expect(incoming.state).toBe('ready');
      incoming.state = 'running'; incoming.readySince = null;
      incoming.lastScheduledTick = asTick(run.tick);
    }
    run.running = decision.next; run.sliceElapsed = 0;
    run.policy.setRunning(run.running);
  }
  const current = run.processes.find(pcb => pcb.pid === run.running);
  if (current !== undefined) {
    current.totalCpuUsed += 1;
    current.cpuBurstRemaining -= 1;
    current.serviceRemaining -= 1;
    run.sliceElapsed += 1;
    if (current.serviceRemaining === 0) {
      current.exitCode = 0; current.terminationReason = 'normal_exit';
      run.policy.onExit(current, runContext(run));
      current.state = 'zombie';
      run.running = null; run.sliceElapsed = 0;
      run.policy.setRunning(null);
    }
  }
  if (run.policy instanceof SjfScheduler) run.policy.observeProcesses(run.processes);
  run.tick += 1;
  return decision;
}

function runningFixture(id: SchedulerId): PolicyRun {
  const policy = persistentPolicy(id);
  const processes = unitProcesses([
    { name: 'P1', arrival: 0, burst: 12, priority: 5 },
    { name: 'P2', arrival: 4, burst: 2, priority: 1 },
    { name: 'P3', arrival: 0, burst: 7, priority: 3 },
  ]);
  for (const pcb of processes) { pcb.state = 'new'; pcb.readySince = null; }
  const run: PolicyRun = { policy, processes, tick: 0, running: null, sliceElapsed: 0 };
  for (let tick = 0; tick < 5; tick++) advancePolicy(run);
  policy.acceptMetrics({ averageWaitingTime: 2.5, averageTurnaroundTime: 7.5,
    averageResponseTime: 1.5, throughput: 20, cpuUtilisation: 0.8,
    contextSwitches: 3, worstWait: 4 });
  return run;
}

function payloadObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function replacePayload(envelope: SubsystemEnvelope, changes: { readonly [key: string]: JsonValue }): SubsystemEnvelope {
  if (!payloadObject(envelope.payload)) throw new Error('scheduler envelope must contain an object payload');
  return { ...envelope, payload: { ...envelope.payload, ...changes } };
}

describe('scheduler envelope persistence', () => {
  it.each(IMPLEMENTED_POLICIES)('%s resumes identical decisions and state from a mid-run envelope', id => {
    const original = runningFixture(id);
    const saved = original.policy.saveState();
    const encoded = canonical(saved);
    expect(saved).toMatchObject({ owner: 'scheduler', version: 1 });
    const restored = persistentPolicy(id);
    restored.configure(schedulerParams({ quantum: 19, preemptive: false }));
    const resumed: PolicyRun = { ...original, policy: restored, processes: structuredClone(original.processes) };
    const live = restored.snapshot();
    const queues = live.queues;
    const queue = queues[0];
    restored.restoreState(structuredClone(saved), runContext(resumed));
    expect(restored.snapshot()).toBe(live);
    expect(restored.snapshot().queues).toBe(queues);
    expect(restored.snapshot().queues[0]).toBe(queue);
    expect(restored.configuredParams).toEqual(original.policy.configuredParams);
    expect(restored.snapshot().metrics).toEqual(original.policy.snapshot().metrics);
    expect(canonical(restored.saveState())).toBe(encoded);
    const originalDecisions: SchedulingDecision[] = [];
    const restoredDecisions: SchedulingDecision[] = [];
    while (original.processes.some(pcb => pcb.state !== 'zombie') && original.tick < 100) {
      originalDecisions.push(advancePolicy(original));
      restoredDecisions.push(advancePolicy(resumed));
      expect(canonical(restored.saveState())).toBe(canonical(original.policy.saveState()));
      expect(canonical(resumed.processes)).toBe(canonical(original.processes));
    }
    expect(original.tick).toBeLessThan(100);
    expect(restoredDecisions).toEqual(originalDecisions);
    expect(canonical(saved)).toBe(encoded);
  });

  it.each([12, 13])('FCFS retains callback phase and tick metadata before another admission at tick %i', tick => {
    const processes = unitProcesses([
      { name: 'new-low-pid', arrival: 0, burst: 5 },
      { name: 'woken-high-pid', arrival: 0, burst: 5 },
      { name: 'new-high-pid', arrival: 0, burst: 5 },
    ]);
    const [later, woken, admitted] = processes;
    if (later === undefined || woken === undefined || admitted === undefined) throw new Error('missing FCFS restore fixture');
    later.state = 'new'; later.readySince = null;
    admitted.state = 'new'; admitted.readySince = null;
    woken.readySince = asTick(12);
    const original = persistentPolicy('fcfs');
    const beforeContext = (): SchedulerContext => unitContext(processes, { tick: asTick(12) });
    original.onUnblock(woken, beforeContext());
    admitted.state = 'ready'; admitted.readySince = asTick(12);
    original.onAdmit(admitted, beforeContext());
    const saved = original.saveState();
    const copies = structuredClone(processes);
    const restored = persistentPolicy('fcfs');
    restored.restoreState(saved, unitContext(copies, { tick: asTick(12) }));
    const copiedLater = copies.find(pcb => pcb.pid === later.pid);
    if (copiedLater === undefined) throw new Error('missing rebound FCFS process');
    later.state = 'ready'; later.readySince = asTick(tick);
    copiedLater.state = 'ready'; copiedLater.readySince = asTick(tick);
    original.onAdmit(later, unitContext(processes, { tick: asTick(tick) }));
    restored.onAdmit(copiedLater, unitContext(copies, { tick: asTick(tick) }));
    const expected = tick === 12 ? [woken.pid, later.pid, admitted.pid] : [woken.pid, admitted.pid, later.pid];
    expect(original.snapshot().queues[0]).toEqual(expected);
    expect(restored.snapshot().queues[0]).toEqual(expected);
    expect(canonical(restored.saveState())).toBe(canonical(original.saveState()));
  });

  it('SRTF restores a preempted ready job, burst observations and estimated-selection mode', () => {
    const original = runningFixture('srtf');
    if (!(original.policy instanceof SrtfScheduler)) throw new Error('expected SRTF policy');
    const oldRunning = original.processes.find(pcb => pcb.name === 'P3');
    const shortService = original.processes.find(pcb => pcb.name === 'P2');
    const longService = original.processes.find(pcb => pcb.name === 'P1');
    if (oldRunning === undefined || shortService === undefined || longService === undefined) throw new Error('missing SRTF restore processes');
    expect(oldRunning.state).toBe('ready');
    expect(oldRunning.serviceRemaining).toBe(3);
    expect(original.policy.snapshot().queues[0]).toContain(oldRunning.pid);
    original.policy.recordBurst(longService.pid, 0);
    original.policy.recordBurst(longService.pid, 0);
    original.policy.recordBurst(shortService.pid, 20);
    original.policy.setUseEstimatedBurst(true);
    const saved = original.policy.saveState();
    const policy = new SrtfScheduler();
    const resumed: PolicyRun = { ...original, policy, processes: structuredClone(original.processes) };
    policy.restoreState(saved, runContext(resumed));
    expect(policy.estimatedNextBurst(longService.pid)).toBe(original.policy.estimatedNextBurst(longService.pid));
    expect(policy.estimatedNextBurst(oldRunning.pid)).toBe(original.policy.estimatedNextBurst(oldRunning.pid));
    expect(policy.snapshot().queues[0]).toContain(oldRunning.pid);
    const expected = advancePolicy(original);
    expect(expected.next).toBe(longService.pid);
    expect(advancePolicy(resumed)).toEqual(expected);
    expect(canonical(policy.saveState())).toBe(canonical(original.policy.saveState()));
  });

  it.each(IMPLEMENTED_POLICIES)('%s rejects malformed envelopes without changing live state', id => {
    const run = runningFixture(id);
    const saved = run.policy.saveState();
    const encoded = canonical(saved);
    const live = run.policy.snapshot();
    const ready = runContext(run).readyQueue[0];
    if (ready === undefined) throw new Error('malformed envelope fixture requires a ready process');
    const malformed: readonly SubsystemEnvelope[] = [
      { ...saved, owner: 'memory' },
      { ...saved, version: 2 },
      replacePayload(saved, { policy: id === 'fcfs' ? 'sjf' : 'fcfs' }),
      replacePayload(saved, { queues: [[asPid(999_999)]] }),
      replacePayload(saved, { queues: [[ready, ready]] }),
      replacePayload(saved, { queues: [[]] }),
      replacePayload(saved, { running: ready }),
      replacePayload(saved, { quantumRemaining: -1 }),
      { ...saved, payload: null },
    ];
    for (const envelope of malformed) {
      expect(() => run.policy.restoreState(envelope, runContext(run))).toThrow();
      expect(run.policy.snapshot()).toBe(live);
      expect(canonical(run.policy.saveState())).toBe(encoded);
    }
  });
});


describe('kernel scheduler contribution', () => {
  it.each(IMPLEMENTED_POLICIES)('%s restores a populated scheduler against compatible process state and continues identically', id => {
    const rows: readonly WorkloadRow[] = [
      { name: 'P1', arrival: 0, burst: 14, priority: 5 },
      { name: 'P2', arrival: 1, burst: 2, priority: 1 },
      { name: 'P3', arrival: 2, burst: 8, priority: 3 },
    ];
    const a = createWorkloadKernel(id, { preemptive: true }, rows).kernel;
    const b = createWorkloadKernel(id, { preemptive: true }, rows).kernel;
    a.run(6); b.run(6);
    const saved = a.saveSchedulerState();
    const frozen = canonical(saved);
    expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);
    b.setScheduler(id === 'priority' ? 'fcfs' : 'priority', { quantum: 17, starvationThreshold: 1000 });
    b.restoreSchedulerState(structuredClone(saved));
    expect(canonical(b.saveSchedulerState())).toBe(frozen);
    expect(canonical(b.run(40))).toBe(canonical(a.run(40)));
    expect(canonical(b.saveSchedulerState())).toBe(canonical(a.saveSchedulerState()));
    expect(canonical(b.processes)).toBe(canonical(a.processes));
    expect(canonical(saved)).toBe(frozen);
  });

  it('restores pending context-switch cost and integer busy counters', () => {
    const config = { ...REFERENCE_CONFIG, scheduler: 'srtf' as const };
    const a = createKernel(config, { contextSwitchTicks: 2, threadCreateTicks: 0 });
    const b = createKernel(config, { contextSwitchTicks: 2, threadCreateTicks: 0 });
    for (const kernel of [a, b]) {
      kernel.spawn({ name: 'P1', arrival: 0, burst: 8, service: 8, priority: 5, pages: 0 });
      kernel.spawn({ name: 'P2', arrival: 2, burst: 2, service: 2, priority: 1, pages: 0 });
      kernel.step();
    }
    const saved = a.saveSchedulerState();
    b.setScheduler('fcfs'); b.restoreSchedulerState(saved);
    expect(canonical(b.run(30))).toBe(canonical(a.run(30)));
    expect(canonical(b.saveSchedulerState())).toBe(canonical(a.saveSchedulerState()));
  });

  it.each(IMPLEMENTED_POLICIES)('%s resumes a blocked multi-burst process and later arrivals', id => {
    const config = { ...REFERENCE_CONFIG, scheduler: id };
    const a = createKernel(config, { contextSwitchTicks: 0, threadCreateTicks: 0 });
    const b = createKernel(config, { contextSwitchTicks: 0, threadCreateTicks: 0 });
    for (const kernel of [a, b]) {
      const sleeper = kernel.spawn({ name: 'sleeper', arrival: 0, burst: 3, service: 11, priority: 3, pages: 0 });
      kernel.spawn({ name: 'arrival', arrival: 4, burst: 2, service: 6, priority: 1, pages: 0 });
      kernel.run(2); kernel.blockProcess(sleeper, { kind: 'sleep', untilTick: asTick(5) });
      kernel.step();
      expect(kernel.process(sleeper)?.state).toBe('waiting');
    }
    const saved = a.saveSchedulerState();
    b.setScheduler(id === 'fcfs' ? 'sjf' : 'fcfs'); b.restoreSchedulerState(saved);
    expect(canonical(b.run(30))).toBe(canonical(a.run(30)));
    expect(canonical(b.saveSchedulerState())).toBe(canonical(a.saveSchedulerState()));
    expect(canonical(b.processes)).toBe(canonical(a.processes));
  });

  it('continues starvation timing after a warning without emitting a second warning', () => {
    const rows = [{ name: 'holder', arrival: 0, burst: 40 }, { name: 'victim', arrival: 0, burst: 40 }];
    const params = { starvationThreshold: 3, starvationFatalThreshold: 8 };
    const a = createWorkloadKernel('fcfs', params, rows).kernel;
    const b = createWorkloadKernel('fcfs', params, rows).kernel;
    const prefix = a.run(5); b.run(5);
    expect(prefix.filter(event => event.type === 'process.starving' && !event.fatal)).toHaveLength(1);
    b.setScheduler('srtf'); b.restoreSchedulerState(a.saveSchedulerState());
    const tail = b.run(40);
    expect(tail.filter(event => event.type === 'process.starving' && !event.fatal)).toHaveLength(0);
    expect(tail.filter(event => event.type === 'process.starving' && event.fatal)).toHaveLength(1);
    expect(canonical(tail)).toBe(canonical(a.run(40)));
    expect(canonical(b.saveSchedulerState())).toBe(canonical(a.saveSchedulerState()));
  });

  it('fills KernelSnapshot.subsystems.scheduler and preserves legacy init-only loads', () => {
    const a = createKernel(REFERENCE_CONFIG); a.run(20);
    const saved = a.snapshot();
    expect(saved.subsystems?.scheduler).toMatchObject({ owner: 'scheduler', version: 1 });
    const b = createKernel(REFERENCE_CONFIG); b.restore(structuredClone(saved));
    expect(canonical(b.snapshot())).toBe(canonical(saved));
    const legacy = { ...saved }; delete legacy.subsystems;
    const c = createKernel(REFERENCE_CONFIG); c.restore(legacy);
    expect(canonical(c.snapshot())).toBe(canonical(saved));
  });

  it('rejects a malformed scheduler contribution before mutating kernel restore state', () => {
    const a = createKernel(REFERENCE_CONFIG); a.run(20);
    const saved = a.snapshot(); const envelope = saved.subsystems?.scheduler;
    if (envelope === undefined || !payloadObject(envelope.payload)) throw new Error('missing scheduler contribution');
    const runtime = envelope.payload['runtime'];
    if (runtime === undefined || !payloadObject(runtime)) throw new Error('missing scheduler runtime');
    const invalid = replacePayload(envelope, { runtime: { ...runtime, tick: 19 } });
    const b = createKernel(REFERENCE_CONFIG); b.run(5);
    const before = canonical(b.snapshot());
    expect(() => b.restore({ ...saved, subsystems: { scheduler: invalid } })).toThrow();
    expect(canonical(b.snapshot())).toBe(before);
  });

  it('rejects inconsistent policy, runtime and kernel configuration before mutation', () => {
    const { kernel } = createWorkloadKernel('priority', {}, LONG_FIRST); kernel.run(2);
    const saved = kernel.saveSchedulerState();
    if (!payloadObject(saved.payload)) throw new Error('missing contribution');
    const runtime = saved.payload['runtime'];
    if (runtime === undefined || !payloadObject(runtime)) throw new Error('missing runtime');
    const params = runtime['params'];
    if (params === undefined || !payloadObject(params)) throw new Error('missing params');
    const invalid = replacePayload(saved, { runtime: { ...runtime, params: { ...params, preemptive: !params['preemptive'] } } });
    const before = canonical(kernel.saveSchedulerState());
    expect(() => kernel.restoreSchedulerState(invalid)).toThrow('params disagree');
    expect(canonical(kernel.saveSchedulerState())).toBe(before);

    const empty = createKernel(REFERENCE_CONFIG); empty.run(5);
    const snapshot = empty.snapshot();
    const untouched = canonical(snapshot);
    expect(() => empty.restore({ ...snapshot, config: { ...snapshot.config, scheduler: 'sjf' } }))
      .toThrow('disagrees with kernel config');
    expect(canonical(empty.snapshot())).toBe(untouched);
  });

  it('preserves a custom metrics view independently of execution counters', () => {
    const a = createWorkloadKernel('fcfs', {}, LONG_FIRST).kernel;
    const b = createWorkloadKernel('fcfs', {}, LONG_FIRST).kernel;
    for (const kernel of [a, b]) {
      kernel.installHooks({ metrics: { scheduler: () => ({ ...EMPTY_METRICS, contextSwitches: 99 }) } });
      kernel.run(2);
    }
    const saved = a.saveSchedulerState();
    b.setScheduler('sjf'); b.restoreSchedulerState(saved);
    expect(canonical(b.saveSchedulerState())).toBe(canonical(saved));
    expect(canonical(b.run(40))).toBe(canonical(a.run(40)));
    expect(canonical(b.saveSchedulerState())).toBe(canonical(a.saveSchedulerState()));
  });

  it('rejects corrupt accounting without replacing an active policy or its queues', () => {
    const { kernel } = createWorkloadKernel('srtf', {}, LONG_FIRST); kernel.run(2);
    const saved = kernel.saveSchedulerState();
    if (!payloadObject(saved.payload)) throw new Error('missing scheduler contribution');
    const accounting = saved.payload['accounting'];
    if (accounting === undefined || !payloadObject(accounting)) throw new Error('missing accounting');
    const invalid = replacePayload(saved, { accounting: { ...accounting, busyTicks: -1 } });
    const before = canonical(kernel.saveSchedulerState());
    expect(() => kernel.restoreSchedulerState(invalid)).toThrow();
    expect(canonical(kernel.saveSchedulerState())).toBe(before);
  });
});

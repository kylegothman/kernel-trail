import { describe, expect, it } from 'vitest';
import { SchedulerBase } from '@kernel/scheduler/SchedulerBase';
import { createScheduler, SCHEDULERS } from '@kernel/scheduler/SchedulerRegistry';
import { sjfCmp } from '@kernel/scheduler/sjf';
import { srtfCmp } from '@kernel/scheduler/srtf';
import { priorityCmp } from '@kernel/scheduler/priority';
import { assertTotalOrder, tieBreak } from '@kernel/scheduler/tieBreak';
import { asTick } from '@kernel/types';
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


it('refuses persistent scheduler state until its frozen snapshot slot is approved', () => {
  const policy = createScheduler('fcfs', schedulerParams());
  if (!(policy instanceof SchedulerBase)) throw new Error('registry must use the shared base');
  expect(() => policy.saveState()).toThrow(/not implemented: scheduler save state.*SubsystemSnapshots.scheduler/);
  expect(() => policy.restoreState()).toThrow(/not implemented: scheduler restore.*SubsystemSnapshots.scheduler/);
});

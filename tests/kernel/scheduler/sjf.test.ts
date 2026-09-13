import { describe, expect, it } from 'vitest';
import { SjfScheduler, sjfCmp } from '@kernel/scheduler/sjf';
import { SrtfScheduler } from '@kernel/scheduler/srtf';
import { createRng } from '@kernel/rng';
import { runWorkload, schedulerParams, unitContext, unitProcesses, type WorkloadRow } from './workloadRunner';

const WORKLOAD: readonly WorkloadRow[] = [
  { name: 'P1', arrival: 0, burst: 6 },
  { name: 'P2', arrival: 0, burst: 8 },
  { name: 'P3', arrival: 0, burst: 7 },
  { name: 'P4', arrival: 0, burst: 3 },
];

describe('SJF textbook fixtures', () => {
  it('SCHED-SJF-1: shortest service first', () => {
    const result = runWorkload('sjf', {}, WORKLOAD);
    expect(result.gantt).toBe('P4[0-3] P1[3-9] P3[9-16] P2[16-24]');
    expect(result.averages.waiting).toBeCloseTo(7, 9);
    expect(result.averages.turnaround).toBeCloseTo(13, 9);
    expect(result.averages.response).toBeCloseTo(7, 9);
    expect(result.perProcess).toEqual(new Map([
      ['P1', { waiting: 3, turnaround: 9, response: 3 }],
      ['P2', { waiting: 16, turnaround: 24, response: 16 }],
      ['P3', { waiting: 9, turnaround: 16, response: 9 }],
      ['P4', { waiting: 0, turnaround: 3, response: 0 }],
    ]));
  });

  it('SCHED-SJF-1F: FCFS comparison on the same workload', () => {
    const result = runWorkload('fcfs', {}, WORKLOAD);
    expect(result.gantt).toBe('P1[0-6] P2[6-14] P3[14-21] P4[21-24]');
    expect(result.averages.waiting).toBeCloseTo(10.25, 9);
    expect(result.averages.turnaround).toBeCloseTo(16.25, 9);
    expect(result.averages.response).toBeCloseTo(10.25, 9);
  });

  it('SJF beats FCFS on average waiting for the same service demands', () => {
    expect(runWorkload('sjf', {}, WORKLOAD).averages.waiting)
      .toBeLessThan(runWorkload('fcfs', {}, WORKLOAD).averages.waiting);
  });

  it('does not preempt for a shorter arrival', () => {
    expect(runWorkload('sjf', { preemptive: true }, [
      { name: 'long', arrival: 0, burst: 8 },
      { name: 'short', arrival: 1, burst: 1 },
    ]).gantt).toBe('long[0-8] short[8-9]');
  });
});

describe('SJF queue and burst estimation', () => {
  it('200 seeded admissions dispatch exactly in sjfCmp order', () => {
    const rng = createRng(0x534a4620);
    const processes = unitProcesses(Array.from({ length: 200 }, (_, index) => ({
      name: `P${index}`, arrival: rng.int(0, 10), burst: rng.int(1, 50),
    })));
    const policy = new SjfScheduler();
    policy.configure(schedulerParams());
    const expected = [...processes].sort(sjfCmp).map(pcb => pcb.pid);
    const admitted = rng.shuffle([...processes]);
    for (const pcb of admitted) policy.onAdmit(pcb, unitContext(processes));
    const popped = [];
    for (let index = 0; index < processes.length; index++) {
      const ctx = unitContext(processes);
      const next = policy.onTick(ctx).next;
      if (next === null) throw new Error('scheduler exhausted before all jobs dispatched');
      popped.push(next);
      const pcb = ctx.process(next);
      if (pcb === undefined) throw new Error('scheduler selected an unknown process');
      pcb.state = 'zombie';
      policy.onExit(pcb, ctx);
    }
    expect(popped).toEqual(expected);
    expect(policy.snapshot().queues[0]).toEqual([]);
    expect(policy.onTick(unitContext(processes)).next).toBeNull();
  });

  it('estimator follows the alpha 0.5 recurrence from the initial burst', () => {
    const [pcb] = unitProcesses([{ name: 'P1', arrival: 0, burst: 10 }]);
    if (pcb === undefined) throw new Error('missing estimator process');
    const policy = new SjfScheduler();
    policy.onAdmit(pcb, unitContext([pcb]));
    let expected = 10;
    expect(policy.estimatedNextBurst(pcb.pid)).toBe(expected);
    for (const observed of [6, 4, 6, 4, 13, 13, 13]) {
      expected = 0.5 * observed + 0.5 * expected;
      policy.recordBurst(pcb.pid, observed);
      expect(policy.estimatedNextBurst(pcb.pid)).toBeCloseTo(expected, 9);
    }
  });

  it('records completed burst service on blocking without counting the wait', () => {
    const [pcb] = unitProcesses([{ name: 'P1', arrival: 0, burst: 10 }]);
    if (pcb === undefined) throw new Error('missing estimator process');
    const policy = new SjfScheduler();
    const ctx = unitContext([pcb]);
    policy.onAdmit(pcb, ctx);
    policy.onTick(ctx);
    pcb.totalCpuUsed = 6;
    pcb.cpuBurstRemaining = 4;
    pcb.state = 'waiting';
    policy.onBlock(pcb, unitContext([pcb]));
    expect(policy.estimatedNextBurst(pcb.pid)).toBeCloseTo(8, 9);
    pcb.state = 'ready';
    policy.onUnblock(pcb, unitContext([pcb]));
    expect(policy.estimatedNextBurst(pcb.pid)).toBeCloseTo(8, 9);
    pcb.totalCpuUsed = 10;
    pcb.cpuBurstRemaining = 0;
    pcb.state = 'zombie';
    policy.onExit(pcb, unitContext([pcb]));
    expect(policy.estimatedNextBurst(pcb.pid)).toBeCloseTo(6, 9);
  });

  it('initial burst provider retains the raw specification burst after thread acceleration', () => {
    const [pcb] = unitProcesses([{ name: 'P1', arrival: 0, burst: 10 }]);
    if (pcb === undefined) throw new Error('missing accelerated process');
    pcb.cpuBurstRemaining = 6;
    const policy = new SjfScheduler();
    policy.setInitialBurstSource(pid => pid === pcb.pid ? 10 : undefined);
    policy.onAdmit(pcb, unitContext([pcb]));
    expect(policy.estimatedNextBurst(pcb.pid)).toBe(10);
  });

  it.each([['SJF', SjfScheduler], ['SRTF', SrtfScheduler]] as const)('%s adopts estimator state for a running process during a policy swap', (_name, Policy) => {
    const [pcb] = unitProcesses([{ name: 'P1', arrival: 0, burst: 10 }]);
    if (pcb === undefined) throw new Error('missing adopted process');
    pcb.state = 'running';
    pcb.readySince = null;
    pcb.totalCpuUsed = 4;
    pcb.cpuBurstRemaining = 6;
    const policy = new Policy();
    policy.setInitialBurstSource(() => 10);
    expect(policy.onTick(unitContext([pcb], { running: pcb.pid, sliceElapsed: 4 })).next).toBe(pcb.pid);
    expect(policy.estimatedNextBurst(pcb.pid)).toBe(10);
    expect(policy.snapshot().queues[0]).toEqual([]);
  });

  it('phase 10 observes a completed burst immediately after the kernel resets its remainder', () => {
    const [pcb] = unitProcesses([{ name: 'P1', arrival: 0, burst: 10 }]);
    if (pcb === undefined) throw new Error('missing burst-boundary process');
    const policy = new SjfScheduler();
    policy.onAdmit(pcb, unitContext([pcb]));
    pcb.state = 'running';
    pcb.totalCpuUsed = 6;
    pcb.cpuBurstRemaining = 4;
    pcb.state = 'waiting';
    policy.onBlock(pcb, unitContext([pcb]));
    expect(policy.estimatedNextBurst(pcb.pid)).toBe(8);
    policy.observeProcesses([pcb]);
    policy.observeProcesses([pcb]);
    expect(policy.estimatedNextBurst(pcb.pid)).toBe(8);
    pcb.state = 'ready';
    policy.onUnblock(pcb, unitContext([pcb]));
    policy.onTick(unitContext([pcb]));
    pcb.state = 'running';
    for (let elapsed = 1; elapsed <= 4; elapsed++) {
      pcb.totalCpuUsed = 6 + elapsed;
      pcb.cpuBurstRemaining = elapsed === 4 ? 10 : 4 - elapsed;
      policy.observeProcesses([pcb]);
      expect(policy.estimatedNextBurst(pcb.pid)).toBe(elapsed === 4 ? 6 : 8);
    }
    policy.onTick(unitContext([pcb], { running: pcb.pid }));
    policy.observeProcesses([pcb]);
    expect(policy.estimatedNextBurst(pcb.pid)).toBe(6);
    pcb.totalCpuUsed = 12;
    pcb.cpuBurstRemaining = 8;
    policy.onExit(pcb, unitContext([pcb], { running: pcb.pid }));
    pcb.state = 'zombie';
    policy.observeProcesses([pcb]);
    policy.observeProcesses([pcb]);
    expect(policy.estimatedNextBurst(pcb.pid)).toBe(4);
  });

  it.each([['SJF', SjfScheduler], ['SRTF', SrtfScheduler]] as const)('%s can select by estimates while exact service remains the default', (_name, Policy) => {
    const processes = unitProcesses([
      { name: 'long-service', arrival: 0, burst: 100 },
      { name: 'short-service', arrival: 0, burst: 5 },
    ]);
    const [long, short] = processes;
    if (long === undefined || short === undefined) throw new Error('missing estimated-burst processes');
    long.cpuBurstRemaining = 2;
    short.cpuBurstRemaining = 20;
    const exact = new Policy();
    const estimated = new Policy();
    const ctx = unitContext(processes);
    for (const pcb of processes) { exact.onAdmit(pcb, ctx); estimated.onAdmit(pcb, ctx); }
    estimated.setUseEstimatedBurst(true);
    expect(exact.onTick(ctx).next).toBe(short.pid);
    expect(estimated.onTick(ctx).next).toBe(long.pid);
  });
});

import { describe, expect, it } from 'vitest';
import { SrtfScheduler } from '@kernel/scheduler/srtf';
import { asTick } from '@kernel/types';
import { runWorkload, schedulerParams, unitContext, unitProcesses, type WorkloadRow } from './workloadRunner';

const WORKLOAD: readonly WorkloadRow[] = [
  { name: 'P1', arrival: 0, burst: 8 },
  { name: 'P2', arrival: 1, burst: 4 },
  { name: 'P3', arrival: 2, burst: 9 },
  { name: 'P4', arrival: 3, burst: 5 },
];

describe('SRTF textbook fixtures', () => {
  it('SCHED-SRTF-1: preemption follows strictly shorter remaining service', () => {
    const result = runWorkload('srtf', {}, WORKLOAD);
    expect(result.gantt).toBe('P1[0-1] P2[1-5] P4[5-10] P1[10-17] P3[17-26]');
    expect(result.averages.waiting).toBeCloseTo(6.5, 9);
    expect(result.averages.turnaround).toBeCloseTo(13, 9);
    expect(result.averages.response).toBeCloseTo(4.25, 9);
    expect(result.contextSwitches).toBe(5);
    expect(result.dispatches).toBe(5);
    expect(result.perProcess).toEqual(new Map([
      ['P1', { waiting: 9, turnaround: 17, response: 0 }],
      ['P2', { waiting: 0, turnaround: 4, response: 0 }],
      ['P3', { waiting: 15, turnaround: 24, response: 15 }],
      ['P4', { waiting: 2, turnaround: 7, response: 2 }],
    ]));
  });

  it('SCHED-SRTF-1S: non-preemptive SJF comparison', () => {
    const result = runWorkload('sjf', {}, WORKLOAD);
    expect(result.gantt).toBe('P1[0-8] P2[8-12] P4[12-17] P3[17-26]');
    expect(result.averages.waiting).toBeCloseTo(7.75, 9);
    expect(result.averages.turnaround).toBeCloseTo(14.25, 9);
    expect(result.averages.response).toBeCloseTo(7.75, 9);
  });

  it('strict comparison: an equal remaining-time arrival does not preempt', () => {
    const result = runWorkload('srtf', {}, [
      { name: 'P1', arrival: 0, burst: 5 },
      { name: 'P2', arrival: 1, burst: 4 },
    ]);
    expect(result.gantt).toBe('P1[0-5] P2[5-9]');
    expect(result.events.filter(event => event.type === 'context.switch' && event.tick - 1 === 1)).toEqual([]);
  });

  it('the running process stays outside the heap and re-enters after preemption with its remainder', () => {
    const [first, shorter] = unitProcesses([
      { name: 'P1', arrival: 0, burst: 8 },
      { name: 'P2', arrival: 1, burst: 4 },
    ]);
    if (first === undefined || shorter === undefined) throw new Error('missing preemption processes');
    shorter.state = 'new';
    const processes = [first, shorter];
    const policy = new SrtfScheduler();
    policy.configure(schedulerParams());
    policy.onAdmit(first, unitContext(processes));
    expect(policy.onTick(unitContext(processes)).next).toBe(first.pid);
    first.state = 'running';
    first.readySince = null;
    first.totalCpuUsed = 1;
    first.serviceRemaining = 7;
    first.cpuBurstRemaining = 7;
    policy.setRunning(first.pid);
    expect(policy.snapshot().queues[0]).not.toContain(first.pid);

    shorter.state = 'ready';
    shorter.readySince = asTick(1);
    const arrivalContext = unitContext(processes, { tick: asTick(1), running: first.pid, sliceElapsed: 1 });
    policy.onAdmit(shorter, arrivalContext);
    expect(policy.onTick(arrivalContext).next).toBe(shorter.pid);
    expect(policy.snapshot().queues[0]).not.toContain(first.pid);
    // The kernel applies the decision, then calls onUnblock for running -> ready.
    first.state = 'ready';
    first.readySince = asTick(1);
    policy.onUnblock(first, unitContext(processes, { tick: asTick(1) }));
    shorter.state = 'running';
    shorter.readySince = null;
    policy.setRunning(shorter.pid);
    expect(policy.snapshot().queues[0]).toEqual([first.pid]);
    expect(first.serviceRemaining).toBe(7);
    expect(policy.snapshot().running).toBe(shorter.pid);
    expect(policy.estimatedNextBurst(first.pid)).toBe(8);
  });
});

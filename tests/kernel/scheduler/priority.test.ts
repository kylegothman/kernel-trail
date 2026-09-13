import { describe, expect, it, vi } from 'vitest';
import { PriorityScheduler } from '@kernel/scheduler/priority';
import { MinHeap } from '@kernel/scheduler/MinHeap';
import { createWorkloadKernel, runWorkload, schedulerParams, unitContext, unitProcesses } from './workloadRunner';

describe('priority scheduling', () => {
  it('SCHED-PRIO-1: lowest priority number wins', () => {
    const result = runWorkload('priority', {}, [
      { name: 'P1', arrival: 0, burst: 10, priority: 3 },
      { name: 'P2', arrival: 0, burst: 1, priority: 1 },
      { name: 'P3', arrival: 0, burst: 2, priority: 4 },
      { name: 'P4', arrival: 0, burst: 1, priority: 5 },
      { name: 'P5', arrival: 0, burst: 5, priority: 2 },
    ]);
    expect(result.gantt).toBe('P2[0-1] P5[1-6] P1[6-16] P3[16-18] P4[18-19]');
    expect(result.averages.waiting).toBeCloseTo(8.2, 9);
    expect(result.averages.turnaround).toBeCloseTo(12, 9);
    expect(result.averages.response).toBeCloseTo(8.2, 9);
    expect(result.perProcess).toEqual(new Map([
      ['P1', { waiting: 6, turnaround: 16, response: 6 }],
      ['P2', { waiting: 0, turnaround: 1, response: 0 }],
      ['P3', { waiting: 16, turnaround: 18, response: 16 }],
      ['P4', { waiting: 18, turnaround: 19, response: 18 }],
      ['P5', { waiting: 1, turnaround: 6, response: 1 }],
    ]));
  });

  it('preemptive flag: exactly one switch on the higher-priority arrival tick', () => {
    const result = runWorkload('priority', { preemptive: true }, [
      { name: 'P1', arrival: 0, burst: 10, priority: 5 },
      { name: 'P2', arrival: 3, burst: 2, priority: 0 },
    ]);
    expect(result.gantt).toBe('P1[0-3] P2[3-5] P1[5-12]');
    expect(result.events.filter(event => event.type === 'context.switch' && event.tick - 1 === 3)).toHaveLength(1);
  });

  it('non-preemptive is the constructor default and retains the running job', () => {
    expect(new PriorityScheduler().isPreemptive).toBe(false);
    const result = runWorkload('priority', { preemptive: false }, [
      { name: 'P1', arrival: 0, burst: 10, priority: 5 },
      { name: 'P2', arrival: 3, burst: 2, priority: 0 },
    ]);
    expect(result.gantt).toBe('P1[0-10] P2[10-12]');
  });

  it('strictly smaller: equal priority never preempts the current process', () => {
    const result = runWorkload('priority', { preemptive: true }, [
      { name: 'P1', arrival: 0, burst: 8, priority: 5 },
      { name: 'P2', arrival: 3, burst: 2, priority: 5 },
    ]);
    expect(result.gantt).toBe('P1[0-8] P2[8-10]');
    expect(result.events.filter(event => event.type === 'context.switch' && event.tick - 1 === 3)).toEqual([]);
  });

  it('aging is forced off in effective params and never lowers a waiting priority', () => {
    const policy = new PriorityScheduler();
    const params = schedulerParams({ agingInterval: 10 });
    policy.configure(params);
    expect(policy.configuredParams.agingInterval).toBe(0);
    expect(params.agingInterval).toBe(10);
    const { kernel, pids } = createWorkloadKernel('priority', { agingInterval: 10 }, [
      { name: 'low', arrival: 0, burst: 5, priority: 9 },
      { name: 'high', arrival: 0, burst: 200, priority: 1 },
    ]);
    kernel.run(150);
    const low = pids.get('low');
    if (low === undefined) throw new Error('missing low priority process');
    expect(kernel.process(low)).toMatchObject({ state: 'ready', priority: 9, totalCpuUsed: 0 });
  });

  it('starves a low-priority process under a continuous stream of higher-priority jobs', () => {
    const { kernel, pids } = createWorkloadKernel('priority', { agingInterval: 10, starvationFatalThreshold: 300 }, [
      { name: 'low', arrival: 0, burst: 5, priority: 9 },
      ...Array.from({ length: 77 }, (_, index) => ({ name: `H${index}`, arrival: index * 4, burst: 4, priority: 1 })),
    ]);
    const events = kernel.run(301);
    const low = pids.get('low');
    if (low === undefined) throw new Error('missing low priority process');
    expect(kernel.process(low)).toMatchObject({ state: 'zombie', terminationReason: 'starvation', priority: 9, totalCpuUsed: 0 });
    expect(events.filter(event => event.type === 'process.starving' && event.pid === low && event.fatal))
      .toEqual([expect.objectContaining({ tick: 301, waitedTicks: 300, fatal: true })]);
  });

  it('equal priorities dispatch in arrival order even when submission order differs', () => {
    const result = runWorkload('priority', { preemptive: true }, [4, 0, 3, 2, 1].map(arrival => ({
      name: `P${arrival}`, arrival, burst: 3, priority: 4,
    })));
    expect(result.gantt).toBe('P0[0-3] P1[3-6] P2[6-9] P3[9-12] P4[12-15]');
  });

  it('priority changes rebuild the heap at most once before the next decision', () => {
    const processes = unitProcesses([
      { name: 'P1', arrival: 0, burst: 5, priority: 3 },
      { name: 'P2', arrival: 0, burst: 5, priority: 4 },
      { name: 'P3', arrival: 0, burst: 5, priority: 5 },
    ]);
    const [first, second, third] = processes;
    if (first === undefined || second === undefined || third === undefined) throw new Error('missing priority processes');
    const policy = new PriorityScheduler();
    const ctx = unitContext(processes);
    for (const pcb of processes) policy.onAdmit(pcb, ctx);
    const rebuild = vi.spyOn(MinHeap.prototype, 'rebuild');
    try {
      second.priority = 2;
      third.priority = 1;
      policy.markPrioritiesDirty();
      policy.markPrioritiesDirty();
      expect(policy.onTick(ctx).next).toBe(third.pid);
      expect(rebuild).toHaveBeenCalledTimes(1);
      expect(policy.snapshot().queues[0]).toEqual([second.pid, first.pid]);
    } finally { rebuild.mockRestore(); }
  });
});

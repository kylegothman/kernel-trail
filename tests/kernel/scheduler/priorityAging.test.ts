import { describe, expect, it } from 'vitest';
import { applyAging } from '@kernel/scheduler/aging';
import { asTick } from '@kernel/types';
import { createWorkloadKernel, runWorkload, schedulerParams, unitContext, unitProcesses, type WorkloadRow } from './workloadRunner';

const WORKLOAD: readonly WorkloadRow[] = [
  { name: 'PL', arrival: 0, burst: 5, priority: 5 },
  ...[1, 2, 3, 4].map(index => ({ name: `H${index}`, arrival: (index - 1) * 4, burst: 4, priority: 1 })),
];
const WITHOUT_AGING = 'H1[0-4] H2[4-8] H3[8-12] H4[12-16] PL[16-21]';
const WITH_AGING = 'H1[0-4] H2[4-8] PL[8-13] H3[13-17] H4[17-21]';

describe('priority with aging', () => {
  it('SCHED-AGING-1A: pure priority has worst waiting time 16', () => {
    const result = runWorkload('priority', { agingInterval: 0 }, WORKLOAD);
    expect(result.gantt).toBe(WITHOUT_AGING);
    expect(result.averages).toEqual({ waiting: 3.2, turnaround: 7.4, response: 3.2 });
    expect(result.worstWait).toBe(16);
  });

  it('SCHED-AGING-1B: aging halves worst waiting time to 8', () => {
    const result = runWorkload('priority_aging', { agingInterval: 2 }, WORKLOAD);
    expect(result.gantt).toBe(WITH_AGING);
    expect(result.averages).toEqual({ waiting: 3.6, turnaround: 7.8, response: 3.6 });
    expect(result.worstWait).toBe(8);
  });

  it('ages PL to priorities 4, 3, 2 and 1 before the decisions at boundaries 2, 4, 6 and 8', () => {
    const { kernel, pids } = createWorkloadKernel('priority_aging', { agingInterval: 2 }, WORKLOAD);
    const pid = pids.get('PL');
    if (pid === undefined) throw new Error('missing PL');
    const trace: [number, number][] = [];
    kernel.onPhase((phase, tick) => {
      const boundary = tick - 1;
      if (phase === 7 && [2, 4, 6, 8].includes(boundary)) {
        const pcb = kernel.process(pid);
        if (pcb === undefined) throw new Error('missing aged process');
        trace.push([boundary, pcb.priority]);
      }
    });
    kernel.run(9);
    expect(trace).toEqual([[2, 4], [4, 3], [6, 2], [8, 1]]);
  });

  it('never ages priority below zero', () => {
    const [pcb] = unitProcesses([{ name: 'low', arrival: 0, burst: 50, priority: 3 }]);
    if (pcb === undefined) throw new Error('missing process');
    pcb.readySince = asTick(0);
    for (let tick = 1; tick <= 20; tick++) {
      applyAging(unitContext([pcb], { tick: asTick(tick), params: schedulerParams({ agingInterval: 1 }) }), [pcb.pid]);
      expect(pcb.priority).toBeGreaterThanOrEqual(0);
    }
    expect(pcb.priority).toBe(0);
  });

  it('restores base priority on PL dispatch at boundary 8', () => {
    const { kernel, pids } = createWorkloadKernel('priority_aging', { agingInterval: 2 }, WORKLOAD);
    const pid = pids.get('PL');
    if (pid === undefined) throw new Error('missing PL');
    kernel.run(9);
    expect(kernel.process(pid)).toMatchObject({ state: 'running', priority: 5, basePriority: 5 });
  });

  it('breaks the aged priority tie at boundary 8 using PL earlier arrival', () => {
    const { kernel, pids } = createWorkloadKernel('priority_aging', { agingInterval: 2 }, WORKLOAD);
    const pl = pids.get('PL'); const newcomer = pids.get('H3');
    if (pl === undefined || newcomer === undefined) throw new Error('missing tie processes');
    const events = kernel.run(9);
    expect(events.filter(event => event.type === 'context.switch' && event.tick === 9))
      .toMatchObject([{ to: pl }]);
    expect(kernel.process(newcomer)?.state).toBe('ready');
  });

  it('does not age a process admitted this tick', () => {
    const [pcb] = unitProcesses([{ name: 'new', arrival: 0, burst: 5, priority: 3 }]);
    if (pcb === undefined) throw new Error('missing process');
    pcb.readySince = asTick(5);
    applyAging(unitContext([pcb], { tick: asTick(5), params: schedulerParams({ agingInterval: 1 }) }), [pcb.pid]);
    expect(pcb.priority).toBe(3);
  });

  it('pure priority still starves when a nonzero aging interval was requested', () => {
    const result = runWorkload('priority', { agingInterval: 2 }, WORKLOAD);
    expect(result.gantt).toBe(WITHOUT_AGING);
    expect(result.worstWait).toBe(16);
  });
});

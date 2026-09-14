import { describe, expect, it } from 'vitest';
import type { EmittableEvent } from '@kernel/EventBus';
import { MlfqScheduler } from '@kernel/scheduler/mlfq';
import { asTick } from '@kernel/types';
import type { ProcessControlBlock, SchedulerContext, SchedulerParams } from '@kernel/types';
import { createWorkloadKernel, runWorkload, schedulerParams, unitContext, unitProcesses } from './workloadRunner';

const MIXED = [
  { name: 'P1', arrival: 0, burst: 20 },
  { name: 'P2', arrival: 0, burst: 6 },
  { name: 'P3', arrival: 10, burst: 4 },
] as const;

function unit(mode: 'per_slice' | 'cumulative' = 'per_slice', params: Partial<SchedulerParams> = {}) {
  const events: EmittableEvent[] = [];
  const policy = new MlfqScheduler({ maxProcesses: 64, mlfqAccounting: mode, emit: event => events.push(event) });
  policy.configure(schedulerParams({ levelQuanta: [4, 8, 16], agingInterval: 50, ...params }));
  const pcb = unitProcesses([{ name: 'P1', arrival: 0, burst: 1000 }])[0]!;
  const context = (tick: number, running = false): SchedulerContext => unitContext([pcb], {
    tick: asTick(tick), running: running ? pcb.pid : null, params: policy.configuredParams,
  });
  return { policy, pcb, events, context };
}

function waitAtBottom(policy: MlfqScheduler, pcb: ProcessControlBlock, context: (tick: number, running?: boolean) => SchedulerContext): void {
  policy.onAdmit(pcb, context(0)); policy.onTick(context(0));
  pcb.state = 'running'; pcb.readySince = null; policy.setRunning(pcb.pid);
  pcb.totalCpuUsed = 4; policy.onTick(context(4, true));
  pcb.totalCpuUsed = 12; policy.onTick(context(12, true));
  expect(pcb.queueLevel).toBe(2);
  pcb.state = 'waiting'; policy.onBlock(pcb, context(12));
  pcb.state = 'ready'; pcb.readySince = asTick(12); policy.setRunning(null); policy.onUnblock(pcb, context(12));
}

describe('MLFQ textbook fixture and CPU budgets', () => {
  it('SCHED-MLFQ-1: exact chart, averages, dispatches and per-process final levels', () => {
    const result = runWorkload('mlfq', { levelQuanta: [4, 8, 16], agingInterval: 50 }, MIXED);
    expect(result.gantt).toBe('P1[0-4] P2[4-8] P1[8-10] P3[10-14] P2[14-16] P1[16-30]');
    expect(result.averages.waiting).toBeCloseTo(20 / 3, 9);
    expect(result.averages.turnaround).toBeCloseTo(50 / 3, 9);
    expect(result.averages.response).toBeCloseTo(4 / 3, 9);
    expect(result.dispatches).toBe(6);
    expect(result.finalLevels).toEqual(new Map([['P1', 2], ['P2', 1], ['P3', 0]]));
    expect(result.perProcess).toEqual(new Map([
      ['P1', { waiting: 10, turnaround: 30, response: 0 }],
      ['P2', { waiting: 10, turnaround: 16, response: 4 }],
      ['P3', { waiting: 0, turnaround: 4, response: 0 }],
    ]));
    expect(result.events.filter(event => event.type === 'quantum.expired').map(event => [event.tick - 1, event.level]))
      .toEqual([[4, 0], [8, 0], [24, 1]]);
  });

  it('higher-level arrival preempts without demotion and appends behind its existing peers', () => {
    const { kernel, pids } = createWorkloadKernel('mlfq', { levelQuanta: [4, 8, 16] }, MIXED);
    kernel.run(11);
    const saved = kernel.saveSchedulerState();
    expect(kernel.process(pids.get('P1')!)?.queueLevel).toBe(1);
    expect(kernel.process(pids.get('P3')!)?.state).toBe('running');
    expect(saved.payload.policy.queues[1]).toEqual([pids.get('P2'), pids.get('P1')]);
  });

  it('completion at the quantum boundary wins over demotion', () => {
    const result = runWorkload('mlfq', { levelQuanta: [4, 8, 16] }, [{ name: 'P3', arrival: 0, burst: 4 }]);
    expect(result.quantumExpiries).toBe(0); expect(result.finalLevels.get('P3')).toBe(0);
    expect(result.events.some(event => event.type === 'process.exited')).toBe(true);
  });

  it('compute-bound work reaches the bottom and renews there without extra dispatches', () => {
    const result = runWorkload('mlfq', { levelQuanta: [4, 8, 16], agingInterval: 0 }, [{ name: 'P1', arrival: 0, burst: 50 }]);
    expect(result.finalLevels.get('P1')).toBe(2); expect(result.dispatches).toBe(1);
    expect(result.events.filter(event => event.type === 'quantum.expired').map(event => [event.tick - 1, event.level]))
      .toEqual([[4, 0], [12, 1], [28, 2], [44, 2]]);
  });

  it('bottom-level expiry rotates peers at the tail and counts only real demotions', () => {
    const result = runWorkload('mlfq', { levelQuanta: [1], agingInterval: 0 }, [
      { name: 'P1', arrival: 0, burst: 3 }, { name: 'P2', arrival: 0, burst: 3 },
    ]);
    expect(result.gantt).toBe('P1[0-1] P2[1-2] P1[2-3] P2[3-4] P1[4-5] P2[5-6]');
    const { policy, pcb, context } = unit('cumulative', { levelQuanta: [1] });
    policy.onAdmit(pcb, context(0)); policy.onTick(context(0)); pcb.state = 'running';
    pcb.totalCpuUsed = 1; policy.onTick(context(1, true));
    const state = policy.saveState().payload;
    if (state.policy !== 'mlfq') throw new Error('wrong fixture policy');
    expect(state.detail.processes[0]?.demotions).toBe(0);
  });

  it.each(['per_slice', 'cumulative'] as const)('%s excludes context-switch debt from level CPU budgets', mode => {
    const { kernel, pids } = createWorkloadKernel('mlfq', { levelQuanta: [4, 8, 16] }, [{ name: 'P1', arrival: 0, burst: 30 }],
      { contextSwitchTicks: 2, mlfqAccounting: mode });
    const events = kernel.run(7).filter(event => event.type === 'quantum.expired');
    expect(events).toHaveLength(1); expect(events[0]?.tick).toBe(7);
    expect(kernel.process(pids.get('P1')!)?.totalCpuUsed).toBe(5);
  });

  it('expiry wins when a higher-level arrival occurs on the same decision', () => {
    const { kernel, pids } = createWorkloadKernel('mlfq', { levelQuanta: [2, 4, 8], agingInterval: 0 }, [
      { name: 'P1', arrival: 0, burst: 30 }, { name: 'P2', arrival: 6, burst: 2 },
    ]);
    const events = kernel.run(7).filter(event => event.type === 'quantum.expired');
    expect(events.map(event => [event.tick - 1, event.level])).toEqual([[2, 0], [6, 1]]);
    expect(kernel.process(pids.get('P1')!)?.queueLevel).toBe(2);
    expect(kernel.process(pids.get('P2')!)?.state).toBe('running');
  });
});

describe('MLFQ blocking, aging and accounting modes', () => {
  it('voluntary release before expiry preserves its current level', () => {
    const { kernel, pids } = createWorkloadKernel('mlfq', { levelQuanta: [4, 8, 16] }, [{ name: 'P1', arrival: 0, burst: 100 }]);
    const pid = pids.get('P1')!; kernel.run(6);
    expect(kernel.process(pid)?.queueLevel).toBe(1);
    kernel.blockProcess(pid, { kind: 'sleep', untilTick: asTick(9) }); kernel.run(3);
    expect(kernel.process(pid)).toMatchObject({ state: 'running', queueLevel: 1 });
  });

  it('forty two-tick CPU bursts separated by blocking remain at level zero', () => {
    const { kernel, pids } = createWorkloadKernel('mlfq', { levelQuanta: [4, 8, 16], agingInterval: 0 }, [{ name: 'P1', arrival: 0, burst: 1000 }]);
    const pid = pids.get('P1')!; let previousCpu = 0; let blocks = 0;
    while (blocks < 40 && kernel.tick < 300) {
      kernel.step(); const pcb = kernel.process(pid)!;
      if (pcb.state === 'running' && pcb.totalCpuUsed - previousCpu === 2) {
        expect(pcb.queueLevel).toBe(0); previousCpu = pcb.totalCpuUsed;
        kernel.blockProcess(pid, { kind: 'sleep', untilTick: asTick(kernel.tick + 2) }); blocks += 1;
      }
    }
    expect(blocks).toBe(40); expect(kernel.process(pid)?.queueLevel).toBe(0);
  });

  it.each(['per_slice', 'cumulative'] as const)('token I/O gaming under %s accounting', mode => {
    const { kernel, pids } = createWorkloadKernel('mlfq', { levelQuanta: [4, 8, 16], agingInterval: 0 }, [{ name: 'gamer', arrival: 0, burst: 1000 }],
      { mlfqAccounting: mode });
    const pid = pids.get('gamer')!; let previousCpu = 0; let highestLevel = 0;
    for (let tick = 0; tick < 200; tick++) {
      kernel.step(); const pcb = kernel.process(pid)!; highestLevel = Math.max(highestLevel, pcb.queueLevel);
      if (pcb.state === 'running' && pcb.totalCpuUsed - previousCpu === 3) {
        previousCpu = pcb.totalCpuUsed;
        kernel.blockProcess(pid, { kind: 'sleep', untilTick: asTick(kernel.tick + 2) });
      }
    }
    if (mode === 'per_slice') expect(highestLevel).toBe(0); else expect(highestLevel).toBe(2);
  });

  it.each(['per_slice', 'cumulative'] as const)('%s handles blocking exactly at a spent quantum before another CPU tick', mode => {
    const { policy, pcb, events, context } = unit(mode);
    policy.onAdmit(pcb, context(0)); policy.onTick(context(0));
    pcb.state = 'running'; pcb.totalCpuUsed = 4;
    pcb.state = 'waiting'; policy.onBlock(pcb, context(4));
    pcb.state = 'ready'; pcb.readySince = asTick(5); policy.onUnblock(pcb, context(5));
    expect(policy.onTick(context(5)).next).toBe(pcb.pid);
    expect(pcb.totalCpuUsed).toBe(4);
    expect(pcb.queueLevel).toBe(mode === 'cumulative' ? 1 : 0);
    expect(events.filter(event => event.type === 'quantum.expired')).toHaveLength(mode === 'cumulative' ? 1 : 0);
  });

  it('a completed unblocked process is not demoted even if its cumulative budget is spent', () => {
    const { policy, pcb, events, context } = unit('cumulative');
    policy.onAdmit(pcb, context(0)); policy.onTick(context(0));
    pcb.state = 'waiting'; pcb.totalCpuUsed = 4; pcb.serviceRemaining = 0; policy.onBlock(pcb, context(4));
    pcb.state = 'ready'; pcb.readySince = asTick(5); policy.onUnblock(pcb, context(5));
    expect(policy.onTick(context(5)).next).toBe(pcb.pid);
    expect(pcb.queueLevel).toBe(0); expect(events).toEqual([]);
  });

  it.each([['per_slice', 15], ['cumulative', 13]] as const)('%s accounting after higher-level preemption expires at textbook tick %i', (mode, expected) => {
    const result = runWorkload('mlfq', { levelQuanta: [4, 8, 16], agingInterval: 0 }, [
      { name: 'P1', arrival: 0, burst: 25 }, { name: 'P2', arrival: 6, burst: 1 },
    ], 1000, { mlfqAccounting: mode });
    expect(result.events.filter(event => event.type === 'quantum.expired' && event.level === 1).map(event => event.tick - 1)).toEqual([expected]);
  });

  it('aging promotes one level, resets readySince and cannot fire twice in one tick', () => {
    const { policy, pcb, context } = unit('cumulative', { agingInterval: 10 });
    waitAtBottom(policy, pcb, context);
    policy.age(context(21)); expect(pcb.queueLevel).toBe(2);
    policy.age(context(22)); expect(pcb).toMatchObject({ queueLevel: 1, readySince: 22 });
    expect(policy.snapshot().queues[1]).toEqual([pcb.pid]);
    policy.age(context(22)); expect(pcb.queueLevel).toBe(1);
    policy.age(context(32)); expect(pcb).toMatchObject({ queueLevel: 0, readySince: 32 });
    const saved = policy.saveState().payload;
    if (saved.policy !== 'mlfq') throw new Error('wrong fixture policy');
    expect(saved.detail.processes[0]?.levelStartCpu).toBe(pcb.totalCpuUsed);
  });

  it('snapshot retains its object and all three queue arrays through promotions', () => {
    const { policy, pcb, context } = unit('per_slice', { agingInterval: 10 });
    waitAtBottom(policy, pcb, context);
    const snapshot = policy.snapshot(); const queues = snapshot.queues; const levels = [...queues];
    expect(levels).toHaveLength(3);
    for (let index = 0; index < 10_000; index++) {
      if (index === 100) policy.age(context(22)); if (index === 200) policy.age(context(32));
      expect(policy.snapshot()).toBe(snapshot); expect(policy.snapshot().queues).toBe(queues);
      for (let level = 0; level < 3; level++) expect(policy.snapshot().queues[level]).toBe(levels[level]);
    }
  });

  it('defaults missing levelQuanta to three levels without mutating the supplied parameters', () => {
    const { levelQuanta: _removed, ...params } = schedulerParams();
    const frozen = Object.freeze(params);
    const { policy } = unit(); policy.configure(frozen);
    expect(policy.snapshot().queues).toHaveLength(3); expect(Object.hasOwn(frozen, 'levelQuanta')).toBe(false);
    expect(() => policy.configure({ ...params, levelQuanta: [] })).toThrow();
    expect(() => policy.configure({ ...params, levelQuanta: [4, 0, 16] })).toThrow();
  });

  it('a policy switch enrolls both already-running and previously-blocked processes at level zero', () => {
    const first = unit(); first.pcb.queueLevel = 2; first.pcb.state = 'running';
    first.policy.onTick(first.context(20, true)); expect(first.pcb.queueLevel).toBe(0);
    const second = unit(); second.pcb.queueLevel = 2;
    second.policy.onUnblock(second.pcb, second.context(20)); expect(second.pcb.queueLevel).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import type { KernelImpl } from '@kernel/Kernel';
import { asTick } from '@kernel/types';
import type { KernelEvent, Pid, SchedulerSnapshotState } from '@kernel/types';
import { canonical } from '../canonical';
import { createWorkloadKernel, type WorkloadRow } from './workloadRunner';

type AccountingMode = 'per_slice' | 'cumulative';

const MIXED_ROWS: readonly WorkloadRow[] = [
  { name: 'completed-first', arrival: 0, burst: 1 },
  { name: 'sleeper', arrival: 0, burst: 80 },
  ...Array.from({ length: 4 }, (_, index) => ({ name: `long-${index}`, arrival: 0, burst: 150 })),
  ...Array.from({ length: 8 }, (_, index) => ({ name: `later-${index}`, arrival: 35 + Math.floor(index / 3) * 3, burst: 20 })),
  { name: 'future', arrival: 180, burst: 5 },
];

function sleepAfterShortBurst(kernel: KernelImpl, sleeper: Pid): void {
  const pcb = kernel.process(sleeper);
  if (pcb?.state === 'running' && pcb.totalCpuUsed > 0 && pcb.totalCpuUsed % 2 === 0) {
    kernel.blockProcess(sleeper, { kind: 'sleep', untilTick: asTick(kernel.tick + 7) });
  }
}

/** WP-11 owns process reconstruction; both kernels deliberately stage equal process state. */
function mixedContributionState(mode: AccountingMode) {
  const params = { levelQuanta: [2, 4, 8], agingInterval: 20,
    starvationThreshold: 2000, starvationFatalThreshold: 3000 };
  const original = createWorkloadKernel('mlfq', params, MIXED_ROWS, { mlfqAccounting: mode });
  const target = createWorkloadKernel('mlfq', params, MIXED_ROWS, { mlfqAccounting: mode });
  const sleeper = original.pids.get('sleeper');
  if (sleeper === undefined) throw new Error('missing sleeper');
  const aged = new Set<Pid>();
  for (let step = 0; step < 300; step++) {
    const before = new Map(original.kernel.processes.map(pcb => [pcb.pid, { state: pcb.state, level: pcb.queueLevel }]));
    sleepAfterShortBurst(original.kernel, sleeper);
    sleepAfterShortBurst(target.kernel, sleeper);
    expect(canonical(target.kernel.step())).toBe(canonical(original.kernel.step()));
    for (const pcb of original.kernel.processes) {
      const prior = before.get(pcb.pid);
      if (prior?.state === 'ready' && pcb.queueLevel < prior.level) aged.add(pcb.pid);
    }
    const saved = original.kernel.saveSchedulerState();
    const policy = saved.payload.policy;
    if (policy.policy !== 'mlfq') throw new Error('expected MLFQ contribution');
    const running = policy.detail.slice === null ? undefined : original.kernel.process(policy.detail.slice.pid);
    const consumed = running === undefined || policy.detail.slice === null ? 0
      : running.totalCpuUsed - policy.detail.slice.startCpu;
    const quantum = running === undefined ? 0 : params.levelQuanta[running.queueLevel] ?? 0;
    if (aged.size > 0 && policy.queues.length === 3 && policy.queues.every(queue => queue.length > 0)
      && saved.payload.accounting.completed.length > 0 && consumed > 0 && consumed < quantum
      && policy.quantumRemaining > 0 && policy.quantumRemaining < quantum) {
      expect(policy.detail.processes.some(row => row.demotions > 0)).toBe(true);
      expect(policy.detail.lastAgingTick).toBe(original.kernel.tick);
      expect(canonical(target.kernel.processes)).toBe(canonical(original.kernel.processes));
      return { original: original.kernel, target: target.kernel, saved, sleeper, aged };
    }
  }
  throw new Error('mixed workload did not reach three nonempty MLFQ queues after aging with a partial slice');
}

function stateOf(kernel: KernelImpl): string {
  return canonical({ scheduler: kernel.saveSchedulerState(), processes: kernel.processes });
}

function omit(value: object, key: string): Record<string, unknown> {
  const result: Record<string, unknown> = { ...value };
  delete result[key];
  return result;
}

function replacePolicyDetail(saved: SchedulerSnapshotState, detail: unknown): unknown {
  return { ...saved, payload: { ...saved.payload, policy: { ...saved.payload.policy, detail } } };
}

describe('typed scheduler version 2 contribution', () => {
  it.each(['priority_aging', 'rr'] as const)('%s preserves its aging or slice cursor and subsequent accounting', id => {
    const rows = [
      { name: 'done', arrival: 0, burst: 1, priority: 0 },
      { name: 'holder', arrival: 0, burst: 20, priority: 1 },
      { name: 'aged', arrival: 0, burst: 50, priority: 10 },
    ];
    const original = createWorkloadKernel(id, { quantum: 3, agingInterval: 2 }, rows).kernel;
    const target = createWorkloadKernel(id, { quantum: 3, agingInterval: 2 }, rows).kernel;
    original.run(9); target.run(9);
    const saved = original.saveSchedulerState();
    const policy = saved.payload.policy;
    if (policy.policy === 'priority_aging') {
      expect(policy.detail.lastAgingTick).toBe(9);
      expect(original.processes.some(pcb => pcb.state === 'ready' && pcb.priority < pcb.basePriority)).toBe(true);
    } else if (policy.policy === 'rr') {
      expect(policy.detail.slice).not.toBeNull();
      expect(policy.quantumRemaining).toBe(1);
    } else throw new Error('unexpected policy');
    expect(saved.payload.accounting.completed).toHaveLength(1);
    target.setScheduler('fcfs');
    target.restoreSchedulerState(structuredClone(saved));
    expect(canonical(target.saveSchedulerState())).toBe(canonical(saved));
    expect(canonical(target.run(100))).toBe(canonical(original.run(100)));
    expect(stateOf(target)).toBe(stateOf(original));
  });

  it.each((['rr', 'mlfq'] as const).flatMap(id => [false, true].map(hasReady => [id, hasReady] as const)))
    ('%s restores a policy switch before its first decision with ready peers=%s', (id, hasReady) => {
      const rows = [{ name: 'holder', arrival: 0, burst: 100 },
        ...(hasReady ? [{ name: 'peer', arrival: 0, burst: 100 }] : [])];
      const params = { quantum: 3, levelQuanta: [2, 4, 8], agingInterval: 50 };
      const original = createWorkloadKernel('mlfq', params, rows).kernel;
      const target = createWorkloadKernel('mlfq', params, rows).kernel;
      original.run(16); target.run(16);
      expect(original.processes.find(pcb => pcb.state === 'running')?.queueLevel).toBe(2);
      for (const kernel of [original, target]) {
        kernel.setScheduler('rr'); kernel.setScheduler(id);
      }
      const saved = original.saveSchedulerState();
      const policy = saved.payload.policy;
      if (policy.policy !== 'rr' && policy.policy !== 'mlfq') throw new Error('expected quantum policy');
      expect(policy.running).not.toBeNull();
      expect(policy.detail.slice).toBeNull();
      expect(policy.quantumRemaining).toBe(0);
      if (policy.policy === 'mlfq') expect(policy.detail.lastAgingTick).toBeNull();
      target.restoreSchedulerState(structuredClone(saved));
      expect(canonical(target.saveSchedulerState())).toBe(canonical(saved));
      expect(canonical(target.run(220))).toBe(canonical(original.run(220)));
      expect(stateOf(target)).toBe(stateOf(original));
    });

  it.each(['per_slice', 'cumulative'] as const)('%s resumes all three levels after aging with accounting history intact', mode => {
    const { original, target, saved, sleeper, aged } = mixedContributionState(mode);
    const encoded = canonical(saved);
    expect(aged.size).toBeGreaterThan(0);
    expect(saved).toMatchObject({ owner: 'scheduler', version: 2 });
    expect(saved.payload.policy).not.toHaveProperty('metrics');
    expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);
    expect(saved.payload.accounting.busyTicks).toBeGreaterThan(0);
    expect(saved.payload.accounting.firstRuns.length).toBeGreaterThan(1);
    target.setScheduler('fcfs', { quantum: 19, agingInterval: 0 });
    const restoreEvents: KernelEvent[] = [];
    const unsubscribe = target.events.onAny(event => restoreEvents.push(event));
    target.restoreSchedulerState(structuredClone(saved));
    unsubscribe();
    expect(restoreEvents).toEqual([]);
    expect(canonical(target.saveSchedulerState())).toBe(encoded);
    const originalTail: KernelEvent[] = [];
    const targetTail: KernelEvent[] = [];
    original.events.onAny(event => originalTail.push(event));
    target.events.onAny(event => targetTail.push(event));
    for (let step = 0; step < 350; step++) {
      sleepAfterShortBurst(original, sleeper);
      sleepAfterShortBurst(target, sleeper);
      original.step(); target.step();
    }
    expect(targetTail.length).toBeGreaterThan(0);
    expect(targetTail.some(event => event.type === 'quantum.expired')).toBe(true);
    expect(targetTail.some(event => event.type === 'process.exited')).toBe(true);
    expect(canonical(targetTail)).toBe(canonical(originalTail));
    expect(stateOf(target)).toBe(stateOf(original));
    expect(original.saveSchedulerState().payload.accounting.completed.length).toBeGreaterThan(saved.payload.accounting.completed.length);
    expect(canonical(saved)).toBe(encoded);
  });

  it('rejects missing accumulators and explicit version 1 without altering active state', () => {
    const { original, saved } = mixedContributionState('cumulative');
    const before = stateOf(original);
    const missing = ['busyTicks', 'firstRuns', 'completed'].map(key => ({
      ...saved, payload: { ...saved.payload, accounting: omit(saved.payload.accounting, key) },
    }));
    const malformed: readonly unknown[] = [
      { ...saved, version: 1 },
      { ...saved, owner: 'memory' },
      { ...saved, payload: omit(saved.payload, 'accounting') },
      ...missing,
      { ...saved, payload: { ...saved.payload, accounting: { ...saved.payload.accounting, busyTicks: saved.payload.runtime.tick + 1 } } },
      { ...saved, payload: { ...saved.payload, runtime: { ...saved.payload.runtime, tick: saved.payload.runtime.tick + 1 } } },
    ];
    for (const invalid of malformed) {
      expect(() => original.restoreSchedulerState(invalid)).toThrow();
      expect(stateOf(original)).toBe(before);
    }
  });

  it('rejects corrupt MLFQ queue, aging and CPU history atomically', () => {
    const { original, saved } = mixedContributionState('cumulative');
    const policy = saved.payload.policy;
    if (policy.policy !== 'mlfq' || policy.detail.slice === null) throw new Error('expected active MLFQ');
    const detail = policy.detail;
    const first = detail.processes[0];
    const queued = policy.queues.flat()[0];
    if (first === undefined || queued === undefined) throw new Error('expected populated MLFQ');
    const malformed: readonly unknown[] = [
      replacePolicyDetail(saved, omit(detail, 'processes')),
      replacePolicyDetail(saved, omit(detail, 'accountingMode')),
      replacePolicyDetail(saved, omit(detail, 'lastAgingTick')),
      { ...saved, payload: { ...saved.payload, policy: { ...policy, quantumRemaining: 0, detail: {
        ...detail, slice: null, processes: detail.processes.filter(row => row.pid !== policy.detail.slice?.pid),
      } } } },
      replacePolicyDetail(saved, { ...detail, accountingMode: 'per_slice' }),
      replacePolicyDetail(saved, { ...detail, lastAgingTick: saved.payload.runtime.tick + 1 }),
      replacePolicyDetail(saved, { ...detail, slice: { ...detail.slice, startCpu: Number.MAX_SAFE_INTEGER } }),
      replacePolicyDetail(saved, { ...detail, processes: [...detail.processes, first] }),
      replacePolicyDetail(saved, { ...detail, processes: detail.processes.map(row => row.pid === first.pid ? { ...row, demotions: -1 } : row) }),
      replacePolicyDetail(saved, { ...detail, processes: detail.processes.map(row => row.pid === first.pid ? { ...row, level: 3 } : row) }),
      replacePolicyDetail(saved, { ...detail, processes: detail.processes.map(row => row.pid === first.pid ? { ...row, levelStartCpu: Number.MAX_SAFE_INTEGER } : row) }),
      { ...saved, payload: { ...saved.payload, policy: { ...policy, queues: [[queued], ...policy.queues] } } },
      { ...saved, payload: { ...saved.payload, policy: { ...policy, queues: [[], [], []] } } },
      { ...saved, payload: { ...saved.payload, policy: { ...policy, quantumRemaining: Number.MAX_SAFE_INTEGER } } },
    ];
    const before = stateOf(original);
    for (const invalid of malformed) {
      expect(() => original.restoreSchedulerState(invalid)).toThrow();
      expect(stateOf(original)).toBe(before);
    }
  });
});

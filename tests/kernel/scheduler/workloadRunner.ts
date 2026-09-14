import { createKernel, type KernelImpl, type KernelOptions } from '@kernel/Kernel';
import { createRng } from '@kernel/rng';
import { asTick } from '@kernel/types';
import type {
  KernelEvent, Pid, ProcessControlBlock, SchedulerContext, SchedulerId, SchedulerParams,
} from '@kernel/types';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';

export interface WorkloadRow {
  readonly name: string;
  readonly arrival: number;
  readonly burst: number;
  readonly priority?: number;
}

export interface WorkloadResult {
  readonly gantt: string;
  readonly perProcess: ReadonlyMap<string, { waiting: number; turnaround: number; response: number }>;
  readonly averages: { waiting: number; turnaround: number; response: number };
  readonly contextSwitches: number;
  readonly dispatches: number;
  readonly quantumExpiries: number;
  /** Maximum completed-process waiting time in the textbook fixture. */
  readonly worstWait: number;
  readonly finalLevels: ReadonlyMap<string, number>;
  readonly events: readonly KernelEvent[];
}

export const IMPLEMENTED_POLICIES = ['fcfs', 'sjf', 'srtf', 'priority'] as const;

export function schedulerParams(params: Partial<SchedulerParams> = {}): SchedulerParams {
  return { ...REFERENCE_CONFIG.schedulerParams, preemptive: false, ...params };
}

export function createWorkloadKernel(
  id: SchedulerId,
  params: Partial<SchedulerParams>,
  rows: readonly WorkloadRow[],
  tuning: KernelOptions = {},
): { kernel: KernelImpl; pids: ReadonlyMap<string, Pid> } {
  const capacity = Math.max(64, rows.length + 2);
  const kernel = createKernel({
    ...REFERENCE_CONFIG, scheduler: id, schedulerParams: schedulerParams(params),
    enabledSubsystems: ['process', 'scheduler'],
  }, { threadCreateTicks: 0, contextSwitchTicks: 0, maxProcesses: capacity,
    degreeOfMultiprogramming: capacity, ...tuning });
  const pids = new Map<string, Pid>();
  for (const row of rows) {
    if (pids.has(row.name)) throw new Error(`duplicate workload name: ${row.name}`);
    // The kernel's first decision is in tick 1. Textbook intervals start at 0.
    const pid = kernel.spawn({ name: row.name, arrival: row.arrival + 1,
      burst: row.burst, service: row.burst, priority: row.priority ?? 20, pages: 0 });
    pids.set(row.name, pid);
  }
  return { kernel, pids };
}

export interface GanttSegment { readonly name: string; readonly start: number; readonly end: number; }

/** ASCII intervals use the same boundary convention as the textbook figures. */
export function renderGantt(segments: readonly GanttSegment[]): string {
  return segments.map(segment => `${segment.name}[${segment.start}-${segment.end}]`).join(' ');
}

/** Run the real kernel and retain every dispatch, including adjacent slices. */
export function runWorkload(
  id: SchedulerId,
  params: Partial<SchedulerParams>,
  rows: readonly WorkloadRow[],
  maxTicks = 10_000,
  tuning: KernelOptions = {},
): WorkloadResult {
  const { kernel, pids } = createWorkloadKernel(id, params, rows, tuning);
  const names = new Map([...pids].map(([name, pid]) => [pid, name]));
  const firstRuns = new Map<Pid, number>();
  const completions = new Map<Pid, number>();
  const events: KernelEvent[] = [];
  const segments: GanttSegment[] = [];
  let active: { pid: Pid; start: number } | null = null;
  const finishSegment = (end: number): void => {
    if (active === null) return;
    const name = names.get(active.pid);
    if (name === undefined) throw new Error('a system process entered a user workload');
    segments.push({ name, start: active.start, end });
    active = null;
  };
  kernel.events.onAny(event => {
    events.push(event);
    if (event.type === 'context.switch') {
      const start = event.tick - 1;
      finishSegment(start);
      if (event.to !== null) {
        active = { pid: event.to, start };
        if (!firstRuns.has(event.to)) firstRuns.set(event.to, start);
      }
    } else if (event.type === 'process.exited') {
      completions.set(event.pid, event.tick);
      if (active?.pid === event.pid) finishSegment(event.tick);
    }
  });
  while (completions.size < rows.length && kernel.tick < maxTicks) kernel.step();
  if (completions.size !== rows.length) throw new Error(`workload did not finish within ${maxTicks} ticks`);

  const perProcess = new Map<string, { waiting: number; turnaround: number; response: number }>();
  const finalLevels = new Map<string, number>();
  const sums = { waiting: 0, turnaround: 0, response: 0 };
  for (const row of rows) {
    const pid = pids.get(row.name);
    if (pid === undefined) throw new Error(`missing pid for ${row.name}`);
    const completion = completions.get(pid);
    const firstRun = firstRuns.get(pid);
    const pcb = kernel.process(pid);
    if (completion === undefined || firstRun === undefined || pcb === undefined) {
      throw new Error(`incomplete trace for ${row.name}`);
    }
    const turnaround = completion - row.arrival;
    const metrics = { waiting: turnaround - row.burst, turnaround, response: firstRun - row.arrival };
    perProcess.set(row.name, metrics);
    finalLevels.set(row.name, pcb.queueLevel);
    sums.waiting += metrics.waiting;
    sums.turnaround += metrics.turnaround;
    sums.response += metrics.response;
  }
  const n = rows.length;
  return { gantt: renderGantt(segments), perProcess,
    averages: { waiting: n === 0 ? 0 : sums.waiting / n,
      turnaround: n === 0 ? 0 : sums.turnaround / n,
      response: n === 0 ? 0 : sums.response / n },
    contextSwitches: events.filter(event => event.type === 'context.switch').length,
    dispatches: events.filter(event => event.type === 'context.switch' && event.to !== null).length,
    quantumExpiries: events.filter(event => event.type === 'quantum.expired').length,
    worstWait: Math.max(0, ...[...perProcess.values()].map(row => row.waiting)),
    finalLevels, events };
}

/** Real PCB construction keeps unit fixtures aligned with the frozen contract. */
export function unitProcesses(rows: readonly WorkloadRow[]): ProcessControlBlock[] {
  const { kernel, pids } = createWorkloadKernel('fcfs', {}, rows);
  return rows.map(row => {
    const pid = pids.get(row.name);
    const pcb = pid === undefined ? undefined : kernel.table.get(pid);
    if (pcb === undefined) throw new Error(`missing unit process ${row.name}`);
    pcb.state = 'ready';
    pcb.readySince = asTick(0);
    return pcb;
  });
}

export function unitContext(
  processes: readonly ProcessControlBlock[],
  overrides: Partial<SchedulerContext> = {},
): SchedulerContext {
  const byPid = new Map(processes.map(pcb => [pcb.pid, pcb]));
  return { tick: asTick(0), rng: createRng(0x53434844), params: schedulerParams(),
    running: null, sliceElapsed: 0, process: pid => byPid.get(pid),
    readyQueue: processes.filter(pcb => pcb.state === 'ready').map(pcb => pcb.pid),
    emit: () => {}, ...overrides };
}

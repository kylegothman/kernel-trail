import { SjfScheduler } from './sjf';
import { snapshotArray, snapshotInteger, snapshotObject, snapshotPid } from './SchedulerBase';
import { asTick } from '../types';
import type { JsonValue, Pid, ProcessControlBlock, SchedulerPolicy, SchedulingMetrics, Tick } from '../types';

/** Fixed at completion, so computing metrics never needs the event history. */
export interface CompletedRecord {
  readonly arrivalTick: Tick;
  readonly firstRunTick: Tick;
  readonly turnaround: number;
  readonly totalService: number;
}

export interface MetricsInput {
  readonly completed: readonly CompletedRecord[];
  readonly tick: number;
  readonly busyTicks: number;
  readonly contextSwitches: number;
  readonly readyWaits: readonly number[];
}

/** Recompute means from integer state rather than accumulating float averages. */
export function computeSchedulingMetrics(k: MetricsInput): SchedulingMetrics {
  let waiting = 0;
  let turnaround = 0;
  let response = 0;
  for (const process of k.completed) {
    waiting += process.turnaround - process.totalService;
    turnaround += process.turnaround;
    response += process.firstRunTick - process.arrivalTick;
  }
  let worstWait = 0;
  for (const waited of k.readyWaits) worstWait = Math.max(worstWait, waited);
  const count = k.completed.length;
  return {
    averageWaitingTime: count === 0 ? 0 : waiting / count,
    averageTurnaroundTime: count === 0 ? 0 : turnaround / count,
    averageResponseTime: count === 0 ? 0 : response / count,
    throughput: k.tick === 0 ? 0 : count * 100 / k.tick,
    cpuUtilisation: k.tick === 0 ? 0 : k.busyTicks / k.tick,
    contextSwitches: k.contextSwitches,
    worstWait,
  };
}

/** Completion records and integer counters are independent of the active policy. */
export class SchedulingAccounting {
  private readonly completed = new Map<Pid, CompletedRecord>();
  private readonly firstRuns = new Map<Pid, Tick>();
  private busyTicks = 0;

  dispatch(pcb: Readonly<ProcessControlBlock>, boundary: Tick): void {
    if (pcb.pid <= 1 || this.firstRuns.has(pcb.pid)) return;
    this.firstRuns.set(pcb.pid, boundary);
  }

  complete(pcb: Readonly<ProcessControlBlock>, boundary: Tick): void {
    if (pcb.pid <= 1 || this.completed.has(pcb.pid)) return;
    // Kernel phases label the first service interval tick 1. Metrics use the
    // corresponding boundary 0, including processes admitted in later ticks.
    const arrivalTick = asTick(Math.max(0, pcb.arrivalTick - 1));
    this.completed.set(pcb.pid, {
      arrivalTick,
      firstRunTick: this.firstRuns.get(pcb.pid) ?? arrivalTick,
      turnaround: boundary - arrivalTick,
      totalService: pcb.totalCpuUsed,
    });
  }

  accountBusyTick(): void { this.busyTicks += 1; }

  recompute(
    tick: Tick,
    processes: readonly Readonly<ProcessControlBlock>[],
    contextSwitches: number,
    policy?: SchedulerPolicy,
  ): SchedulingMetrics {
    if (policy instanceof SjfScheduler) policy.observeProcesses(processes);
    const readyWaits: number[] = [];
    for (const pcb of processes) {
      if (pcb.pid > 1 && pcb.state === 'ready' && pcb.readySince !== null) {
        readyWaits.push(tick - pcb.readySince);
      }
    }
    return computeSchedulingMetrics({
      completed: Array.from(this.completed.values()),
      tick,
      busyTicks: this.busyTicks,
      contextSwitches,
      readyWaits,
    });
  }

  saveState(): JsonValue {
    return {
      busyTicks: this.busyTicks,
      firstRuns: [...this.firstRuns].sort(([a], [b]) => a - b).map(([pid, tick]) => [pid, tick]),
      completed: [...this.completed].sort(([a], [b]) => a - b).map(([pid, record]) => ({ pid, ...record })),
    };
  }

  /** Parse the entire contribution before allowing the caller to commit it. */
  prepareRestore(state: JsonValue): () => void {
    const source = snapshotObject(state, 'scheduler accounting');
    const busyTicks = snapshotInteger(source['busyTicks'], 'scheduler accounting busy ticks');
    const firstRuns = new Map<Pid, Tick>();
    for (const value of snapshotArray(source['firstRuns'], 'scheduler accounting first runs')) {
      const pair = snapshotArray(value, 'scheduler accounting first run');
      if (pair.length !== 2) throw new Error('invalid scheduler accounting first run pair');
      const pid = snapshotPid(pair[0], 'scheduler accounting first run pid');
      if (pid <= 1 || firstRuns.has(pid)) throw new Error('invalid or duplicate scheduler accounting first run pid');
      firstRuns.set(pid, asTick(snapshotInteger(pair[1], 'scheduler accounting first run tick')));
    }
    const completed = new Map<Pid, CompletedRecord>();
    for (const value of snapshotArray(source['completed'], 'scheduler accounting completed records')) {
      const row = snapshotObject(value, 'scheduler accounting completed record');
      const pid = snapshotPid(row['pid'], 'scheduler accounting completed pid');
      if (pid <= 1 || completed.has(pid)) throw new Error('invalid or duplicate scheduler accounting completed pid');
      const record: CompletedRecord = {
        arrivalTick: asTick(snapshotInteger(row['arrivalTick'], 'scheduler accounting arrival tick')),
        firstRunTick: asTick(snapshotInteger(row['firstRunTick'], 'scheduler accounting first run tick')),
        turnaround: snapshotInteger(row['turnaround'], 'scheduler accounting turnaround'),
        totalService: snapshotInteger(row['totalService'], 'scheduler accounting total service'),
      };
      const response = record.firstRunTick - record.arrivalTick;
      if (record.turnaround < record.totalService || response < 0 || response > record.turnaround - record.totalService) {
        throw new Error('invalid scheduler accounting waiting or response time');
      }
      snapshotInteger(record.arrivalTick + record.turnaround, 'scheduler accounting completion tick');
      const firstRun = firstRuns.get(pid);
      if (firstRun === undefined ? record.totalService !== 0 || response !== 0 : firstRun !== record.firstRunTick) {
        throw new Error('scheduler accounting completed record disagrees with first dispatch');
      }
      completed.set(pid, record);
    }
    return () => {
      this.reset();
      this.busyTicks = busyTicks;
      for (const [pid, tick] of firstRuns) this.firstRuns.set(pid, tick);
      for (const [pid, record] of completed) this.completed.set(pid, record);
    };
  }

  restoreState(state: JsonValue): void { this.prepareRestore(state)(); }

  reset(): void {
    this.completed.clear();
    this.firstRuns.clear();
    this.busyTicks = 0;
  }
}

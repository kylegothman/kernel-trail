import { asPid } from '../types';
import type {
  JsonValue, SubsystemEnvelope, Pid, ProcessControlBlock, SchedulerContext, SchedulerId, SchedulerParams,
  SchedulerPolicy, SchedulerSnapshot, SchedulingDecision, SchedulingMetrics,
} from '../types';
import { DEFAULT_SCHEDULER_PARAMS, EMPTY_METRICS } from './common';

/** Shared lifecycle and a stable presentation view, independent of queue policy. */
export abstract class SchedulerBase implements SchedulerPolicy {
  abstract readonly id: SchedulerId;
  abstract readonly displayName: string;
  abstract readonly isPreemptive: boolean;
  protected params: Readonly<SchedulerParams> = DEFAULT_SCHEDULER_PARAMS;
  private readonly queues: Pid[][] = [[]];
  private running: Pid | null = null;
  private quantumRemaining = 0;
  private metrics: SchedulingMetrics = EMPTY_METRICS;
  private readonly view: SchedulerSnapshot;

  constructor() {
    const self = this;
    this.view = {
      get policy() { return self.id; },
      get running() { return self.running; },
      queues: this.queues,
      get quantumRemaining() { return self.quantumRemaining; },
      get metrics() { return self.metrics; },
    };
  }

  configure(params: SchedulerParams): void {
    this.params = { ...params,
      ...(params.levelQuanta === undefined ? {} : { levelQuanta: [...params.levelQuanta] }) };
  }
  get configuredParams(): Readonly<SchedulerParams> { return this.params; }
  onAdmit(pcb: ProcessControlBlock, ctx: SchedulerContext): void { this.insert(pcb, ctx, 'admit'); }
  onUnblock(pcb: ProcessControlBlock, ctx: SchedulerContext): void { this.insert(pcb, ctx, 'unblock'); }
  onBlock(pcb: ProcessControlBlock, _ctx: SchedulerContext): void { this.remove(pcb.pid); }
  onExit(pcb: ProcessControlBlock, _ctx: SchedulerContext): void { this.remove(pcb.pid); }
  abstract onTick(ctx: SchedulerContext): SchedulingDecision;
  protected abstract insert(pcb: ProcessControlBlock, ctx: SchedulerContext, source: 'admit' | 'unblock'): void;
  protected abstract remove(pid: Pid): void;

  protected onAge?(ctx: SchedulerContext): void;
  /** Phase 6 uses this public bridge to the optional protected extension hook. */
  age(ctx: SchedulerContext): void { this.onAge?.(ctx); }
  snapshot(): SchedulerSnapshot { return this.view; }
  setRunning(pid: Pid | null): void { this.running = pid; }
  acceptMetrics(metrics: SchedulingMetrics): void { this.metrics = metrics; }
  protected rationale(next: Pid | null, reason: string): string {
    return next === null ? `CPU idle: ${reason}.` : `${this.displayName}: ${reason}.`;
  }
  protected decision(ctx: SchedulerContext, next: Pid | null, reason: string): SchedulingDecision {
    return { next, isContextSwitch: next !== ctx.running, rationale: this.rationale(next, reason) };
  }
  protected current(ctx: SchedulerContext): ProcessControlBlock | undefined {
    const pcb = ctx.running === null ? undefined : ctx.process(ctx.running);
    return pcb?.state === 'running' ? pcb : undefined;
  }
  protected buildSnapshot(queues: readonly (readonly Pid[])[], quantumRemaining: number,
    metrics: SchedulingMetrics = this.metrics): SchedulerSnapshot {
    this.queues.length = queues.length;
    for (let level = 0; level < queues.length; level++) {
      const source = queues[level];
      if (source === undefined) continue;
      let target = this.queues[level];
      if (target === undefined) { target = []; this.queues[level] = target; }
      if (target !== source) {
        target.length = source.length;
        for (let index = 0; index < source.length; index++) {
          const pid = source[index];
          if (pid !== undefined) target[index] = pid;
        }
      }
    }
    this.quantumRemaining = quantumRemaining;
    this.metrics = metrics;
    return this.view;
  }

  protected abstract saveDetails(): JsonValue;
  protected abstract prepareRestoreDetails(detail: JsonValue, queues: readonly (readonly Pid[])[], ctx: SchedulerContext): () => void;

  /** A detached save contribution. The live snapshot remains allocation-free. */
  saveState(): SubsystemEnvelope {
    return { owner: 'scheduler', version: 1, payload: {
      policy: this.id, params: saveSchedulerParams(this.params),
      queues: this.queues.map(queue => [...queue]), running: this.running,
      quantumRemaining: this.quantumRemaining, metrics: { ...this.metrics }, detail: this.saveDetails(),
    } };
  }

  restoreState(envelope: SubsystemEnvelope, ctx: SchedulerContext): void {
    if (envelope.owner !== 'scheduler' || envelope.version !== 1) throw new Error('invalid scheduler envelope owner or version');
    const payload = snapshotObject(envelope.payload, 'policy payload');
    if (payload['policy'] !== this.id) throw new Error('scheduler snapshot policy mismatch');
    const params = restoreSchedulerParams(payload['params']);
    const queues = snapshotArray(payload['queues'], 'queues').map(value =>
      snapshotArray(value, 'queue').map(pid => snapshotPid(pid, 'queued pid')));
    const ready = queues.flat();
    if (new Set(ready).size !== ready.length || ready.length !== ctx.readyQueue.length
      || ready.some(pid => ctx.process(pid)?.state !== 'ready' || !ctx.readyQueue.includes(pid))) {
      throw new Error('scheduler snapshot ready membership mismatch');
    }
    const running = payload['running'] === null ? null : snapshotPid(payload['running'], 'running');
    if (running !== ctx.running || (running !== null && ctx.process(running)?.state !== 'running')) {
      throw new Error('scheduler snapshot running process mismatch');
    }
    const quantum = snapshotInteger(payload['quantumRemaining'], 'quantum remaining');
    const metrics = restoreSchedulingMetrics(payload['metrics']);
    const detail = payload['detail'];
    if (detail === undefined) throw new Error('missing scheduler detail');
    const commit = this.prepareRestoreDetails(detail, queues, ctx);
    this.configure(params);
    commit();
    this.running = running;
    this.buildSnapshot(queues, quantum, metrics);
  }
}

function isSnapshotObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function snapshotObject(value: JsonValue | undefined, label: string): { readonly [key: string]: JsonValue } {
  if (!isSnapshotObject(value)) throw new Error(`invalid scheduler ${label}`);
  return value;
}
export function snapshotArray(value: JsonValue | undefined, label: string): readonly JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`invalid scheduler ${label}`);
  return value;
}
export function snapshotInteger(value: JsonValue | undefined, label: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error(`invalid scheduler ${label}`);
  return value;
}
export function snapshotNumber(value: JsonValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`invalid scheduler ${label}`);
  return value;
}
export function snapshotBoolean(value: JsonValue | undefined, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`invalid scheduler ${label}`);
  return value;
}
export function snapshotPid(value: JsonValue | undefined, label: string): Pid { return asPid(snapshotInteger(value, label, 2)); }
export function saveSchedulerParams(params: Readonly<SchedulerParams>): JsonValue {
  return { ...params, ...(params.levelQuanta === undefined ? {} : { levelQuanta: [...params.levelQuanta] }) };
}
export function restoreSchedulerParams(value: JsonValue | undefined): SchedulerParams {
  const params = snapshotObject(value, 'params');
  return {
    quantum: snapshotInteger(params['quantum'], 'quantum', 1),
    agingInterval: snapshotInteger(params['agingInterval'], 'aging interval'),
    starvationThreshold: snapshotInteger(params['starvationThreshold'], 'starvation threshold'),
    starvationFatalThreshold: snapshotInteger(params['starvationFatalThreshold'], 'fatal threshold'),
    preemptive: snapshotBoolean(params['preemptive'], 'preemptive'),
    ...(params['levelQuanta'] === undefined ? {} : {
      levelQuanta: snapshotArray(params['levelQuanta'], 'level quanta').map(item => snapshotInteger(item, 'level quantum', 1)),
    }),
  };
}
function restoreSchedulingMetrics(value: JsonValue | undefined): SchedulingMetrics {
  const metrics = snapshotObject(value, 'metrics');
  const cpuUtilisation = snapshotNumber(metrics['cpuUtilisation'], 'CPU utilisation');
  if (cpuUtilisation > 1) throw new Error('invalid scheduler CPU utilisation');
  return {
    averageWaitingTime: snapshotNumber(metrics['averageWaitingTime'], 'average waiting'),
    averageTurnaroundTime: snapshotNumber(metrics['averageTurnaroundTime'], 'average turnaround'),
    averageResponseTime: snapshotNumber(metrics['averageResponseTime'], 'average response'),
    throughput: snapshotNumber(metrics['throughput'], 'throughput'), cpuUtilisation,
    contextSwitches: snapshotInteger(metrics['contextSwitches'], 'context switches'),
    worstWait: snapshotInteger(metrics['worstWait'], 'worst wait'),
  };
}

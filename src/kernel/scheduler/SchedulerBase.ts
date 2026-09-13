import type {
  Pid, ProcessControlBlock, SchedulerContext, SchedulerId, SchedulerParams,
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

  // TODO(astra): blocked on contract change, see report
  saveState(): never {
    throw new Error('not implemented: scheduler save state requires a typed SubsystemSnapshots.scheduler slot');
  }
  // TODO(astra): blocked on contract change, see report
  restoreState(): never {
    throw new Error('not implemented: scheduler restore requires a typed SubsystemSnapshots.scheduler slot');
  }
}

import type { Pid, ProcessControlBlock, SchedulerContext, SchedulerId, SchedulingDecision } from '../types';
import { KernelInvariantError } from '../errors';
import { SchedulerBase } from './SchedulerBase';
import { MinHeap } from './MinHeap';
import { tieBreak } from './tieBreak';

export const sjfCmp = (a: ProcessControlBlock, b: ProcessControlBlock): number =>
  a.serviceRemaining - b.serviceRemaining || tieBreak(a, b);

interface BurstEstimate {
  estimate: number;
  startCpu: number;
  lastCpu: number;
  lastRemaining: number;
}

export class SjfScheduler extends SchedulerBase {
  readonly id: SchedulerId = 'sjf';
  readonly displayName: string = 'Shortest Job First';
  readonly isPreemptive: boolean = false;
  protected context: SchedulerContext | undefined;
  protected readonly heap = new MinHeap(pid => this.context?.process(pid), (a, b) => this.compare(a, b));
  private readonly estimates = new Map<Pid, BurstEstimate>();
  private initialBurst: (pid: Pid) => number | undefined = () => undefined;
  private useEstimatedBurst = false;
  private readonly levels: (readonly Pid[])[] = [[]];

  setInitialBurstSource(source: (pid: Pid) => number | undefined): void { this.initialBurst = source; }
  /** Phase 10 observes service before consumers read the completed tick. */
  observeProcesses(processes: readonly Readonly<ProcessControlBlock>[]): void {
    for (const pcb of processes) {
      if (pcb.pid <= 1 || pcb.state === 'new') continue;
      this.initialiseEstimate(pcb);
      this.observe(pcb, pcb.state === 'waiting' || pcb.state === 'zombie' || pcb.state === 'terminated');
    }
  }
  setUseEstimatedBurst(enabled: boolean): void {
    this.useEstimatedBurst = enabled; this.heap.rebuild(); this.refresh();
  }
  estimatedNextBurst(pid: Pid): number | undefined { return this.estimates.get(pid)?.estimate; }
  recordBurst(pid: Pid, actual: number): void {
    if (!Number.isSafeInteger(actual) || actual < 0) throw new RangeError('burst duration must be a non-negative integer');
    const state = this.estimates.get(pid);
    if (state === undefined) throw new KernelInvariantError(13, 'burst estimate requires an admitted process');
    state.estimate = 0.5 * actual + 0.5 * state.estimate;
    this.heap.rebuild(); this.refresh();
  }
  protected key(pcb: ProcessControlBlock): number {
    return this.useEstimatedBurst ? this.estimates.get(pcb.pid)?.estimate ?? pcb.cpuBurstRemaining : pcb.serviceRemaining;
  }
  protected compare(a: ProcessControlBlock, b: ProcessControlBlock): number {
    return this.key(a) - this.key(b) || tieBreak(a, b);
  }
  protected insert(pcb: ProcessControlBlock, ctx: SchedulerContext, _source: 'admit' | 'unblock'): void {
    this.context = ctx;
    this.initialiseEstimate(pcb);
    this.observe(pcb, false);
    this.heap.push(pcb.pid); this.refresh();
  }
  protected remove(pid: Pid): void { this.heap.remove(pid); this.refresh(); }
  override onBlock(pcb: ProcessControlBlock, ctx: SchedulerContext): void {
    this.context = ctx; this.observe(pcb, true); super.onBlock(pcb, ctx);
  }
  override onExit(pcb: ProcessControlBlock, ctx: SchedulerContext): void {
    this.context = ctx; this.observe(pcb, true); super.onExit(pcb, ctx);
  }
  protected prepare(ctx: SchedulerContext): void {
    this.context = ctx;
    const current = this.current(ctx);
    if (current !== undefined) { this.initialiseEstimate(current); this.observe(current, false); }
  }
  protected nextReady(ctx: SchedulerContext): ProcessControlBlock | undefined {
    let pid = this.heap.peek();
    while (pid !== null) {
      const pcb = ctx.process(pid);
      if (pcb?.state === 'ready' && ctx.readyQueue.includes(pid)) return pcb;
      this.heap.pop(); this.refresh(); pid = this.heap.peek();
    }
    return undefined;
  }
  protected dispatch(ctx: SchedulerContext, next: ProcessControlBlock | undefined, reason: string): SchedulingDecision {
    if (next !== undefined) this.heap.remove(next.pid);
    this.refresh(); return this.decision(ctx, next?.pid ?? null, reason);
  }
  onTick(ctx: SchedulerContext): SchedulingDecision {
    this.prepare(ctx);
    const running = this.current(ctx);
    if (running !== undefined) return this.decision(ctx, running.pid, 'the running job completes before a shorter arrival');
    const next = this.nextReady(ctx);
    return this.dispatch(ctx, next, next === undefined ? 'no process is ready' : `shortest service, ${this.key(next)} ticks`);
  }
  protected refresh(): void { this.levels[0] = this.heap.toArray(); this.buildSnapshot(this.levels, 0); }
  private initialiseEstimate(pcb: Readonly<ProcessControlBlock>): void {
    if (!this.estimates.has(pcb.pid)) this.estimates.set(pcb.pid, {
      estimate: this.initialBurst(pcb.pid) ?? pcb.cpuBurstRemaining,
      startCpu: pcb.totalCpuUsed, lastCpu: pcb.totalCpuUsed, lastRemaining: pcb.cpuBurstRemaining,
    });
  }
  private observe(pcb: Readonly<ProcessControlBlock>, finished: boolean): void {
    const state = this.estimates.get(pcb.pid);
    if (state === undefined) return;
    const delta = pcb.totalCpuUsed - state.lastCpu;
    if (pcb.totalCpuUsed < state.lastCpu) {
      state.estimate = pcb.cpuBurstRemaining; state.startCpu = pcb.totalCpuUsed;
    } else if ((finished || (delta > 0 && delta >= state.lastRemaining)) && pcb.totalCpuUsed > state.startCpu) {
      state.estimate = 0.5 * (pcb.totalCpuUsed - state.startCpu) + 0.5 * state.estimate;
      state.startCpu = pcb.totalCpuUsed;
    }
    state.lastCpu = pcb.totalCpuUsed; state.lastRemaining = pcb.cpuBurstRemaining;
  }
}

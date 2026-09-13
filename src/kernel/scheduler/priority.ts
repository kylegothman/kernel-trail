import type { Pid, ProcessControlBlock, SchedulerContext, SchedulerId, SchedulerParams, SchedulingDecision } from '../types';
import { SchedulerBase } from './SchedulerBase';
import { MinHeap } from './MinHeap';
import { tieBreak } from './tieBreak';
import { DEFAULT_SCHEDULER_PARAMS } from './common';

export const priorityCmp = (a: ProcessControlBlock, b: ProcessControlBlock): number =>
  a.priority - b.priority || tieBreak(a, b);

export class PriorityScheduler extends SchedulerBase {
  readonly id: SchedulerId = 'priority';
  readonly displayName: string = 'Priority Scheduling';
  get isPreemptive(): boolean { return this.params.preemptive; }
  protected context: SchedulerContext | undefined;
  protected readonly heap = new MinHeap(pid => this.context?.process(pid), priorityCmp);
  private readonly priorities = new Map<Pid, number>();
  private dirty = false;
  private readonly levels: (readonly Pid[])[] = [[]];

  constructor() { super(); this.configure({ ...DEFAULT_SCHEDULER_PARAMS, preemptive: false }); }
  override configure(params: SchedulerParams): void { super.configure({ ...params, agingInterval: 0 }); }
  /** WP-04 marks ordering dirty after changing ready priorities in phase 6. */
  markPrioritiesDirty(): void { this.dirty = true; }
  protected insert(pcb: ProcessControlBlock, ctx: SchedulerContext, _source: 'admit' | 'unblock'): void {
    this.context = ctx; this.heap.push(pcb.pid); this.priorities.set(pcb.pid, pcb.priority); this.refresh();
  }
  protected remove(pid: Pid): void { this.heap.remove(pid); this.priorities.delete(pid); this.refresh(); }
  onTick(ctx: SchedulerContext): SchedulingDecision {
    this.context = ctx;
    for (const pid of ctx.readyQueue) {
      const pcb = ctx.process(pid);
      if (pcb !== undefined && this.priorities.get(pid) !== pcb.priority) {
        this.dirty = true; this.priorities.set(pid, pcb.priority);
      }
    }
    if (this.dirty) { this.heap.rebuild(); this.dirty = false; this.refresh(); }
    let next: ProcessControlBlock | undefined;
    while (this.heap.peek() !== null) {
      const pid = this.heap.peek(); if (pid === null) break;
      const candidate = ctx.process(pid);
      if (candidate?.state === 'ready' && ctx.readyQueue.includes(pid)) { next = candidate; break; }
      this.remove(pid);
    }
    const running = this.current(ctx);
    if (running !== undefined && (!this.isPreemptive || next === undefined || next.priority >= running.priority)) {
      return this.decision(ctx, running.pid, 'the running process retains the CPU under the priority rule');
    }
    if (next !== undefined) this.remove(next.pid);
    return this.decision(ctx, next?.pid ?? null, next === undefined ? 'no process is ready'
      : `highest priority, ${next.priority} is the smallest ready priority number`);
  }
  private refresh(): void { this.levels[0] = this.heap.toArray(); this.buildSnapshot(this.levels, 0); }
}

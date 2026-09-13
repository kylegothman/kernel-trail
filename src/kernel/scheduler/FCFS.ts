import type { JsonValue, Pid, ProcessControlBlock, SchedulerContext, SchedulingDecision, Tick } from '../types';
import { SchedulerBase, snapshotArray, snapshotInteger, snapshotObject } from './SchedulerBase';
import { asTick } from '../types';
import { tieBreak } from './tieBreak';

/** FIFO admission order, preserving the phase-4 unblock before phase-5 admit. */
export class FcfsScheduler extends SchedulerBase {
  readonly id = 'fcfs';
  readonly displayName = 'First Come, First Served';
  readonly isPreemptive = false;
  private readonly queue: Pid[] = [];
  private readonly entered: { tick: Tick; source: 'admit' | 'unblock' }[] = [];
  private head = 0;
  private readonly visible: Pid[] = [];
  private readonly levels = [this.visible];

  protected insert(pcb: ProcessControlBlock, ctx: SchedulerContext, source: 'admit' | 'unblock'): void {
    if (this.queue.indexOf(pcb.pid, this.head) >= 0) return;
    let index = this.queue.length;
    // Only reorder the contiguous callback batch from this phase and tick.
    while (index > this.head) {
      const entry = this.entered[index - 1];
      const pid = this.queue[index - 1];
      if (entry?.tick !== ctx.tick || entry.source !== source || pid === undefined) break;
      const other = ctx.process(pid);
      if (other === undefined || tieBreak(other, pcb) <= 0) break;
      index -= 1;
    }
    this.queue.splice(index, 0, pcb.pid);
    this.entered.splice(index, 0, { tick: ctx.tick, source });
    this.refresh();
  }
  protected remove(pid: Pid): void {
    const index = this.queue.indexOf(pid, this.head);
    if (index < 0) return;
    if (index === this.head) this.head += 1;
    else { this.queue.splice(index, 1); this.entered.splice(index, 1); }
    this.compact(); this.refresh();
  }
  onTick(ctx: SchedulerContext): SchedulingDecision {
    const running = this.current(ctx);
    if (running !== undefined) return this.decision(ctx, running.pid, 'the running process keeps the CPU until it blocks or finishes');
    while (this.head < this.queue.length) {
      const pid = this.queue[this.head]; this.head += 1;
      if (pid === undefined) continue;
      const pcb = ctx.process(pid);
      if (pcb?.state !== 'ready' || !ctx.readyQueue.includes(pid)) continue;
      this.compact(); this.refresh();
      return this.decision(ctx, pid, 'head of the arrival queue');
    }
    this.compact(); this.refresh();
    return this.decision(ctx, null, 'no process is ready');
  }
  protected saveDetails(): JsonValue {
    return this.entered.slice(this.head).map(entry => ({ tick: entry.tick, source: entry.source }));
  }
  protected prepareRestoreDetails(detail: JsonValue, queues: readonly (readonly Pid[])[], ctx: SchedulerContext): () => void {
    const queue = queues[0];
    if (queues.length !== 1 || queue === undefined) throw new Error('FCFS requires one queue');
    const entries = snapshotArray(detail, 'FCFS entries').map((value): { tick: Tick; source: 'admit' | 'unblock' } => {
      const entry = snapshotObject(value, 'FCFS entry');
      const tick = asTick(snapshotInteger(entry['tick'], 'FCFS insertion tick'));
      const source = entry['source'];
      if (tick > ctx.tick || (source !== 'admit' && source !== 'unblock')) throw new Error('invalid FCFS insertion metadata');
      return { tick, source };
    });
    if (entries.length !== queue.length) throw new Error('FCFS insertion metadata length mismatch');
    for (let i = 1; i < entries.length; i++) {
      if ((entries[i]?.tick ?? 0) < (entries[i - 1]?.tick ?? 0)) throw new Error('FCFS insertion ticks out of order');
    }
    return () => {
      this.queue.length = 0; this.entered.length = 0; this.head = 0;
      for (const pid of queue) this.queue.push(pid);
      for (const entry of entries) this.entered.push(entry);
      this.refresh();
    };
  }
  private compact(): void {
    if (this.head > this.queue.length / 2) {
      this.queue.splice(0, this.head); this.entered.splice(0, this.head); this.head = 0;
    }
  }
  private refresh(): void {
    this.visible.length = 0;
    for (let index = this.head; index < this.queue.length; index++) {
      const pid = this.queue[index]; if (pid !== undefined) this.visible.push(pid);
    }
    this.buildSnapshot(this.levels, 0);
  }
}

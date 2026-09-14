import type { Pid, ProcessControlBlock, SchedulerContext, SchedulerCpuSliceSnapshot,
  SchedulerParams, SchedulerSnapshot, SchedulingDecision } from '../types';
import { CircularQueue } from './CircularQueue';
import { SchedulerBase, restoreSchedulerParams, snapshotInteger, snapshotObject, snapshotPid, type SchedulerPolicyDetails } from './SchedulerBase';
import type { SchedulerHost } from './SchedulerRegistry';
import { tieBreak } from './tieBreak';

/** Mirrors Pace in @game/types without importing the game layer into the kernel. */
export const RR_PACE_QUANTA: Readonly<Record<'conservative' | 'steady' | 'aggressive' | 'reckless', number>> =
  Object.freeze({ conservative: 16, steady: 8, aggressive: 4, reckless: 1 });

/** A CPU cursor excludes switch/copy debt and renews without a fake dispatch. */
export function restoreCpuSlice(value: unknown, ctx: SchedulerContext): SchedulerCpuSliceSnapshot | null {
  if (value === null) return null;
  const row = snapshotObject(value, 'CPU slice');
  const pid = snapshotPid(row['pid'], 'slice pid');
  const startCpu = snapshotInteger(row['startCpu'], 'slice start CPU');
  const pcb = ctx.process(pid);
  if (pid !== ctx.running || pcb?.state !== 'running' || startCpu > pcb.totalCpuUsed) throw new Error('scheduler slice does not match running CPU history');
  return { pid, startCpu };
}

export class RoundRobinScheduler extends SchedulerBase {
  readonly id = 'rr';
  readonly displayName = 'Round Robin';
  readonly isPreemptive = true;
  private readonly queue: CircularQueue;
  private readonly levels: (readonly Pid[])[];
  private slice: SchedulerCpuSliceSnapshot | null = null;
  private active: ProcessControlBlock | undefined;
  private batchTick = -1;
  private batchSource = '';
  private readonly batch: Pid[] = [];

  constructor(private readonly host: SchedulerHost) {
    super(); this.queue = new CircularQueue(host.maxProcesses); this.levels = [this.queue.toArray()]; this.refresh();
  }
  override configure(params: SchedulerParams): void {
    if (!Number.isSafeInteger(params.quantum) || params.quantum < 1) throw new Error('RR quantum must be a positive integer');
    super.configure(restoreSchedulerParams(params));
  }
  protected insert(pcb: ProcessControlBlock, ctx: SchedulerContext, source: 'admit' | 'unblock'): void {
    if (pcb.pid <= 1 || this.queue.contains(pcb.pid)) return;
    if (this.batchTick !== ctx.tick || this.batchSource !== source) {
      this.batch.length = 0; this.batchTick = ctx.tick; this.batchSource = source;
    }
    let index = 0;
    while (index < this.batch.length) {
      const other = ctx.process(this.batch[index]!);
      if (other !== undefined && tieBreak(pcb, other) < 0) break;
      index += 1;
    }
    const before = this.batch[index];
    if (before === undefined) this.queue.enqueue(pcb.pid); else this.queue.insertBefore(pcb.pid, before);
    this.batch.splice(index, 0, pcb.pid); this.refresh();
  }
  protected remove(pid: Pid): void {
    this.queue.remove(pid);
    if (this.slice?.pid === pid) { this.slice = null; this.active = undefined; }
    const index = this.batch.indexOf(pid); if (index >= 0) this.batch.splice(index, 1);
    this.refresh();
  }
  onTick(ctx: SchedulerContext): SchedulingDecision {
    this.batch.length = 0; this.batchTick = -1;
    const running = this.current(ctx);
    if (running !== undefined) {
      if (this.slice?.pid !== running.pid) this.start(running);
      if (running.serviceRemaining === 0 || this.elapsed() < this.params.quantum) {
        this.refresh(); return this.decision(ctx, running.pid, 'the current quantum has CPU time remaining');
      }
      this.host.emit({ type: 'quantum.expired', pid: running.pid, level: 0 });
      this.queue.enqueue(running.pid);
    }
    this.slice = null; this.active = undefined;
    let next: ProcessControlBlock | undefined;
    while (this.queue.size > 0) {
      const pid = this.queue.dequeue(); if (pid === null) break;
      const candidate = ctx.process(pid);
      if (candidate !== undefined && (candidate === running || (candidate.state === 'ready' && ctx.readyQueue.includes(pid)))) { next = candidate; break; }
    }
    if (next !== undefined) this.start(next);
    this.refresh();
    return this.decision(ctx, next?.pid ?? null, next === undefined ? 'no process is ready' : 'head of the round-robin queue');
  }
  override snapshot(): SchedulerSnapshot { this.refresh(); return super.snapshot(); }
  protected saveDetails(): SchedulerPolicyDetails { return { policy: 'rr', detail: { slice: this.slice === null ? null : { ...this.slice } } }; }
  protected prepareRestoreDetails(detail: unknown, queues: readonly (readonly Pid[])[], ctx: SchedulerContext, quantumRemaining: number): () => void {
    const row = snapshotObject(detail, 'RR detail');
    const slice = restoreCpuSlice(row['slice'], ctx);
    const queue = queues[0];
    if (queues.length !== 1 || queue === undefined || queue.length > this.host.maxProcesses) throw new Error('invalid RR queue shape');
    const active = slice === null ? undefined : ctx.process(slice.pid);
    const expected = slice === null || active === undefined ? 0 : Math.max(0, ctx.params.quantum - (active.totalCpuUsed - slice.startCpu));
    if (quantumRemaining !== expected) throw new Error('RR quantum remaining disagrees with CPU cursor');
    return () => {
      while (this.queue.dequeue() !== null) { /* Restore a canonical head-to-tail buffer. */ }
      for (const pid of queue) this.queue.enqueue(pid);
      this.slice = slice; this.active = active; this.batch.length = 0; this.batchTick = -1; this.refresh();
    };
  }
  private start(pcb: ProcessControlBlock): void { this.active = pcb; this.slice = { pid: pcb.pid, startCpu: pcb.totalCpuUsed }; }
  private elapsed(): number { return this.slice === null || this.active === undefined ? 0 : this.active.totalCpuUsed - this.slice.startCpu; }
  private refresh(): void {
    this.queue.toArray();
    this.buildSnapshot(this.levels, this.slice === null ? 0 : Math.max(0, this.params.quantum - this.elapsed()));
  }
}

import { asTick } from '../types';
import type { Pid, ProcessControlBlock, SchedulerContext, SchedulerCpuSliceSnapshot,
  SchedulerParams, SchedulerSnapshot, SchedulingDecision, Tick } from '../types';
import { CircularQueue } from './CircularQueue';
import { SchedulerBase, restoreSchedulerParams, snapshotArray, snapshotInteger, snapshotObject,
  snapshotPid, type SchedulerPolicyDetails } from './SchedulerBase';
import type { SchedulerHost } from './SchedulerRegistry';
import { restoreCpuSlice } from './rr';
import { tieBreak } from './tieBreak';

const DEFAULT_QUANTA = [4, 8, 16] as const;
interface LevelHistory {
  pcb: ProcessControlBlock;
  level: number;
  levelStartCpu: number;
  demotions: number;
}

export class MlfqScheduler extends SchedulerBase {
  readonly id = 'mlfq';
  readonly displayName = 'Multilevel Feedback Queue';
  readonly isPreemptive = true;
  private readonly levelQueues: CircularQueue[] = [];
  private readonly levels: (readonly Pid[])[] = [];
  private readonly membership = new Map<Pid, number>();
  private readonly history = new Map<Pid, LevelHistory>();
  private quanta: readonly number[] = DEFAULT_QUANTA;
  private lastAgingTick: Tick | null = null;
  private slice: SchedulerCpuSliceSnapshot | null = null;
  private active: ProcessControlBlock | undefined;
  private batchTick = -1;
  private batchSource = '';
  private readonly batch: Pid[] = [];

  constructor(private readonly host: SchedulerHost) {
    super(); this.resizeQueues(DEFAULT_QUANTA.length); this.refresh();
  }
  override configure(params: SchedulerParams): void {
    const checked = restoreSchedulerParams(params);
    const quanta = checked.levelQuanta ?? DEFAULT_QUANTA;
    if (quanta.length === 0 || quanta.some(q => !Number.isSafeInteger(q) || q < 1)) throw new Error('MLFQ requires positive integer level quanta');
    super.configure(checked); this.quanta = [...quanta];
    if (this.levelQueues.length !== quanta.length) {
      const previous = this.levelQueues.map(queue => [...queue.toArray()]);
      this.resizeQueues(quanta.length); this.membership.clear();
      for (const row of this.history.values()) {
        if (row.level >= quanta.length) { row.level = quanta.length - 1; row.pcb.queueLevel = row.level; row.levelStartCpu = row.pcb.totalCpuUsed; }
      }
      for (const queue of previous) for (const pid of queue) {
        const row = this.history.get(pid); if (row !== undefined) this.enqueue(row.pcb);
      }
    }
    this.refresh();
  }
  override onAdmit(pcb: ProcessControlBlock, ctx: SchedulerContext): void {
    if (!this.history.has(pcb.pid)) pcb.queueLevel = 0;
    super.onAdmit(pcb, ctx);
  }
  protected insert(pcb: ProcessControlBlock, ctx: SchedulerContext, source: 'admit' | 'unblock'): void {
    if (pcb.pid <= 1 || this.membership.has(pcb.pid)) return;
    const row = this.record(pcb);
    if (this.batchTick !== ctx.tick || this.batchSource !== source) {
      this.batch.length = 0; this.batchTick = ctx.tick; this.batchSource = source;
    }
    let index = 0;
    while (index < this.batch.length) {
      const other = ctx.process(this.batch[index]!);
      if (other !== undefined && tieBreak(pcb, other) < 0) break;
      index += 1;
    }
    const before = this.batch.slice(index).find(pid => this.membership.get(pid) === row.level);
    const queue = this.levelQueues[row.level]!;
    if (before === undefined) queue.enqueue(pcb.pid); else queue.insertBefore(pcb.pid, before);
    this.membership.set(pcb.pid, row.level); this.batch.splice(index, 0, pcb.pid); this.refresh();
  }
  protected remove(pid: Pid): void {
    const level = this.membership.get(pid);
    if (level !== undefined) this.levelQueues[level]?.remove(pid);
    this.membership.delete(pid);
    if (this.slice?.pid === pid) { this.slice = null; this.active = undefined; }
    const index = this.batch.indexOf(pid); if (index >= 0) this.batch.splice(index, 1);
    this.refresh();
  }
  protected override onAge(ctx: SchedulerContext): void {
    if (this.lastAgingTick === ctx.tick) return;
    this.lastAgingTick = ctx.tick;
    if (this.params.agingInterval <= 0) return;
    for (const pid of [...ctx.readyQueue].sort((a, b) => a - b)) {
      const pcb = ctx.process(pid); const row = this.history.get(pid);
      if (pcb?.state !== 'ready' || pcb.readySince === null || row === undefined || row.level === 0) continue;
      const waited = ctx.tick - pcb.readySince;
      if (waited <= 0 || waited % this.params.agingInterval !== 0) continue;
      this.levelQueues[row.level]!.remove(pid); this.membership.delete(pid);
      row.level -= 1; pcb.queueLevel = row.level; row.levelStartCpu = pcb.totalCpuUsed; pcb.readySince = ctx.tick;
      this.enqueue(pcb);
    }
    this.refresh();
  }
  onTick(ctx: SchedulerContext): SchedulingDecision {
    this.batch.length = 0; this.batchTick = -1;
    const running = this.current(ctx);
    if (running !== undefined) {
      const row = this.record(running);
      if (this.slice?.pid !== running.pid) this.start(running);
      if (running.serviceRemaining === 0) {
        this.refresh(); return this.decision(ctx, running.pid, 'the completed process exits before quantum expiry');
      }
      if (this.usedAtLevel(row) >= this.quanta[row.level]!) {
        this.expire(running, row);
      } else if (this.firstReadyLevel() >= 0 && this.firstReadyLevel() < row.level) {
        this.enqueue(running);
      } else {
        this.refresh(); return this.decision(ctx, running.pid, 'the running level has the highest priority and CPU budget remaining');
      }
    }
    this.slice = null; this.active = undefined;
    let next: ProcessControlBlock | undefined;
    for (const queue of this.levelQueues) {
      while (queue.size > 0) {
        const pid = queue.dequeue(); if (pid === null) break;
        this.membership.delete(pid);
        const candidate = ctx.process(pid);
        if (candidate !== undefined && (candidate === running || (candidate.state === 'ready' && ctx.readyQueue.includes(pid)))) {
          const row = this.record(candidate);
          // Blocking at the boundary must not buy another CPU tick in cumulative mode.
          if (candidate.serviceRemaining > 0 && this.host.mlfqAccounting === 'cumulative'
            && candidate.totalCpuUsed - row.levelStartCpu >= this.quanta[row.level]!) {
            this.expire(candidate, row); continue;
          }
          next = candidate; break;
        }
      }
      if (next !== undefined) break;
    }
    if (next !== undefined) this.start(next);
    this.refresh();
    return this.decision(ctx, next?.pid ?? null, next === undefined ? 'no process is ready' : `head of highest ready level ${next.queueLevel}`);
  }
  override snapshot(): SchedulerSnapshot { this.refresh(); return super.snapshot(); }
  protected saveDetails(): SchedulerPolicyDetails {
    return { policy: 'mlfq', detail: { accountingMode: this.host.mlfqAccounting, lastAgingTick: this.lastAgingTick,
      slice: this.slice === null ? null : { ...this.slice },
      processes: [...this.history].sort(([a], [b]) => a - b).map(([pid, row]) => ({ pid, level: row.level,
        levelStartCpu: row.levelStartCpu, demotions: row.demotions })) } };
  }
  protected prepareRestoreDetails(detail: unknown, queues: readonly (readonly Pid[])[], ctx: SchedulerContext, quantumRemaining: number): () => void {
    const value = snapshotObject(detail, 'MLFQ detail');
    if (value['accountingMode'] !== this.host.mlfqAccounting) throw new Error('MLFQ accounting mode does not match tuning');
    const quanta = ctx.params.levelQuanta ?? DEFAULT_QUANTA;
    if (queues.length !== quanta.length || queues.some(queue => queue.length > this.host.maxProcesses)) throw new Error('MLFQ queue count does not match level quanta');
    const lastAgingTick = value['lastAgingTick'] === null ? null : asTick(snapshotInteger(value['lastAgingTick'], 'last aging tick'));
    if (lastAgingTick !== null && lastAgingTick > ctx.tick) throw new Error('MLFQ aging clock is in the future');
    const slice = restoreCpuSlice(value['slice'], ctx);
    const records = new Map<Pid, LevelHistory>();
    let lastPid = 1;
    for (const item of snapshotArray(value['processes'], 'MLFQ process history')) {
      const row = snapshotObject(item, 'MLFQ process');
      const pid = snapshotPid(row['pid'], 'MLFQ process pid');
      const level = snapshotInteger(row['level'], 'MLFQ level');
      const levelStartCpu = snapshotInteger(row['levelStartCpu'], 'MLFQ level start CPU');
      const demotions = snapshotInteger(row['demotions'], 'MLFQ demotions');
      const pcb = ctx.process(pid);
      if (pid <= lastPid || pcb === undefined || pcb.state === 'new' || level >= quanta.length || pcb.queueLevel !== level
        || levelStartCpu > pcb.totalCpuUsed || demotions > pcb.totalCpuUsed) throw new Error('MLFQ history does not match process state');
      records.set(pid, { pcb, level, levelStartCpu, demotions }); lastPid = pid;
    }
    for (let level = 0; level < queues.length; level++) for (const pid of queues[level]!) {
      if (records.get(pid)?.level !== level) throw new Error('MLFQ queued process level mismatch');
    }
    // Before the first phase-6/7 pass, a newly installed policy has not enrolled the CPU owner.
    if (ctx.running !== null && !records.has(ctx.running) && (slice !== null || lastAgingTick !== null)) {
      throw new Error('MLFQ running process history is missing');
    }
    const active = slice === null ? undefined : ctx.process(slice.pid);
    const activeRow = slice === null ? undefined : records.get(slice.pid);
    if (slice !== null && (activeRow === undefined || slice.startCpu < activeRow.levelStartCpu)) throw new Error('MLFQ slice precedes level entry');
    const used = active === undefined || activeRow === undefined || slice === null ? 0 : active.totalCpuUsed
      - (this.host.mlfqAccounting === 'cumulative' ? activeRow.levelStartCpu : slice.startCpu);
    const expected = activeRow === undefined || slice === null ? 0 : Math.max(0, quanta[activeRow.level]! - used);
    if (quantumRemaining !== expected) throw new Error('MLFQ quantum remaining disagrees with CPU cursor');
    return () => {
      this.history.clear(); this.membership.clear();
      for (const [pid, row] of records) this.history.set(pid, row);
      for (let level = 0; level < queues.length; level++) {
        const queue = this.levelQueues[level]!;
        while (queue.dequeue() !== null) { /* Restore canonical queue order. */ }
        for (const pid of queues[level]!) { queue.enqueue(pid); this.membership.set(pid, level); }
      }
      this.slice = slice; this.active = active; this.lastAgingTick = lastAgingTick;
      this.batch.length = 0; this.batchTick = -1; this.refresh();
    };
  }
  private record(pcb: ProcessControlBlock): LevelHistory {
    let row = this.history.get(pcb.pid);
    if (row === undefined) {
      // First encounter after a policy switch starts at the highest level.
      const level = 0;
      pcb.queueLevel = level; row = { pcb, level, levelStartCpu: pcb.totalCpuUsed, demotions: 0 }; this.history.set(pcb.pid, row);
    }
    return row;
  }
  private expire(pcb: ProcessControlBlock, row: LevelHistory): void {
    const oldLevel = row.level;
    row.level = Math.min(oldLevel + 1, this.quanta.length - 1);
    if (row.level > oldLevel) row.demotions += 1;
    pcb.queueLevel = row.level; row.levelStartCpu = pcb.totalCpuUsed;
    this.enqueue(pcb); this.host.emit({ type: 'quantum.expired', pid: pcb.pid, level: oldLevel });
  }
  private enqueue(pcb: ProcessControlBlock): void {
    if (this.membership.has(pcb.pid)) return;
    const row = this.record(pcb); this.levelQueues[row.level]!.enqueue(pcb.pid); this.membership.set(pcb.pid, row.level);
  }
  private start(pcb: ProcessControlBlock): void { this.record(pcb); this.active = pcb; this.slice = { pid: pcb.pid, startCpu: pcb.totalCpuUsed }; }
  private usedAtLevel(row: LevelHistory): number {
    const start = this.host.mlfqAccounting === 'cumulative' ? row.levelStartCpu : this.slice?.startCpu ?? row.pcb.totalCpuUsed;
    return row.pcb.totalCpuUsed - start;
  }
  private firstReadyLevel(): number { return this.levelQueues.findIndex(queue => queue.size > 0); }
  private resizeQueues(count: number): void {
    this.levelQueues.length = 0; this.levels.length = 0;
    for (let level = 0; level < count; level++) {
      const queue = new CircularQueue(this.host.maxProcesses); this.levelQueues.push(queue); this.levels.push(queue.toArray());
    }
  }
  private refresh(): void {
    for (const queue of this.levelQueues) queue.toArray();
    const row = this.active === undefined ? undefined : this.history.get(this.active.pid);
    this.buildSnapshot(this.levels, row === undefined || this.slice === null ? 0 : Math.max(0, this.quanta[row.level]! - this.usedAtLevel(row)));
  }
}

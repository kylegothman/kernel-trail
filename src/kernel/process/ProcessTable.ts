import { KernelInvariantError } from '../errors';
import { asPid } from '../types';
import type { Pid, ProcessControlBlock } from '../types';

export interface RawProcessWork {
  rawBurst: number;
  rawService: number;
  serialFraction: number;
}

/** Ordered lookup is shared by all process algorithms, independent of Map order. */
export class ProcessTable {
  private readonly records = new Map<Pid, ProcessControlBlock>();
  private readonly orderedPids: Pid[] = [];
  private pidCounter = 1;
  readonly raw = new Map<Pid, RawProcessWork>();
  // The frozen PCB makes parent readonly. This side table deliberately owns
  // the mutable link; each stored PCB exposes it through a readonly getter.
  readonly parents = new Map<Pid, Pid | null>();
  readonly createdEvents = new Set<Pid>();

  get nextPid(): number { return this.pidCounter; }

  allocatePid(): Pid {
    if (!Number.isSafeInteger(this.pidCounter)) {
      throw new KernelInvariantError(11, 'PID allocation exhausted');
    }
    const pid = asPid(this.pidCounter);
    this.pidCounter += 1;
    return pid;
  }

  insert(pcb: ProcessControlBlock, raw?: RawProcessWork): ProcessControlBlock {
    if (this.records.has(pcb.pid)) {
      throw new KernelInvariantError(11, `duplicate pid ${pcb.pid}`);
    }
    const last = this.orderedPids[this.orderedPids.length - 1];
    if (last !== undefined && pcb.pid <= last) {
      throw new KernelInvariantError(11, 'process insertion must follow ascending pid order');
    }
    this.parents.set(pcb.pid, pcb.parent);
    const parents = this.parents;
    const stored: ProcessControlBlock = {
      ...pcb,
      get parent(): Pid | null { return parents.get(pcb.pid) ?? null; },
    };
    this.records.set(stored.pid, stored);
    this.orderedPids.push(stored.pid);
    if (raw !== undefined) this.raw.set(stored.pid, { ...raw });
    this.pidCounter = Math.max(this.pidCounter, stored.pid + 1);
    return stored;
  }

  get(pid: Pid): ProcessControlBlock | undefined { return this.records.get(pid); }

  parentOf(pid: Pid): Pid | null { return this.parents.get(pid) ?? null; }

  reparent(pid: Pid, parent: Pid | null): void {
    if (!this.records.has(pid)) throw new KernelInvariantError(11, `missing pid ${pid}`);
    this.parents.set(pid, parent);
  }

  forEachAscending(fn: (pcb: ProcessControlBlock) => void): void {
    for (const pid of this.orderedPids) {
      const pcb = this.records.get(pid);
      if (pcb === undefined) throw new KernelInvariantError(11, `missing ordered pid ${pid}`);
      fn(pcb);
    }
  }

  filterAscending(pred: (pcb: ProcessControlBlock) => boolean): ProcessControlBlock[] {
    const matches: ProcessControlBlock[] = [];
    this.forEachAscending(pcb => { if (pred(pcb)) matches.push(pcb); });
    return matches;
  }

  get processes(): readonly Readonly<ProcessControlBlock>[] {
    return Object.freeze(this.filterAscending(pcb => pcb.pid !== asPid(0)));
  }

  /** Reaped tombstones stay inspectable but release their process-table slot. */
  get activeCount(): number {
    return this.filterAscending(pcb => pcb.pid !== asPid(0) && pcb.state !== 'terminated').length;
  }

  markCreated(pid: Pid): boolean {
    if (this.createdEvents.has(pid)) return false;
    this.createdEvents.add(pid);
    return true;
  }

  clear(): void {
    this.records.clear();
    this.orderedPids.length = 0;
    this.parents.clear();
    this.raw.clear();
    this.createdEvents.clear();
    this.pidCounter = 1;
  }

  setNextPid(next: number): void {
    if (!Number.isSafeInteger(next) || next < this.pidCounter) {
      throw new KernelInvariantError(11, 'restored next pid must exceed all allocated pids');
    }
    this.pidCounter = next;
  }
}

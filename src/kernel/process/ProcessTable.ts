import { KernelInvariantError } from '../errors';
import { asPid } from '../types';
import type { Pid, ProcessControlBlock } from '../types';

export interface ProcessTableContribution {
  readonly rawWork: readonly (readonly [Pid, number])[];
  readonly rawBursts: readonly (readonly [Pid, number])[];
  readonly createdEvents: readonly Pid[];
  readonly nextPid: number;
}

export interface ProcessTableRestore {
  /** Ascending by pid, idle included; each is inserted as given. */
  readonly processes: readonly ProcessControlBlock[];
  readonly raw: readonly { readonly pid: Pid; readonly rawBurst: number; readonly rawService: number; readonly serialFraction: number }[];
  readonly createdEvents: readonly Pid[];
  readonly nextPid: number;
}

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

  /** Detached, ascending copies of the raw work, creation marks and the pid allocator (WP-11, amendment 14). */
  snapshotContribution(): ProcessTableContribution {
    const raw = [...this.raw].sort(([a], [b]) => a - b);
    return {
      rawWork: raw.map(([pid, work]) => [pid, work.rawService] as const),
      rawBursts: raw.map(([pid, work]) => [pid, work.rawBurst] as const),
      createdEvents: [...this.createdEvents].sort((a, b) => a - b),
      nextPid: this.pidCounter,
    };
  }

  /**
   * Replace the whole table from staged control blocks. Each block is inserted in
   * ascending pid order with its raw work; validation runs before any mutation.
   */
  restoreContribution(data: ProcessTableRestore): void {
    const count = (value: unknown, minimum: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
    const pids = data.processes.map(pcb => pcb.pid);
    if (pids.some((pid, index) => !count(pid, 0) || (index > 0 && pid <= (pids[index - 1] ?? -1)))) throw new KernelInvariantError(1, 'restored processes must ascend by pid');
    const known = new Set<number>(pids);
    for (const row of data.raw) {
      if (!known.has(row.pid) || !count(row.rawBurst, 0) || !count(row.rawService, 0) || !(row.serialFraction >= 0 && row.serialFraction <= 1)) throw new KernelInvariantError(4, 'invalid restored raw work', { pid: row.pid });
    }
    for (const pid of data.createdEvents) if (!known.has(pid)) throw new KernelInvariantError(11, 'creation mark for an unknown process', { pid });
    const highest = pids[pids.length - 1] ?? 0;
    if (!count(data.nextPid, highest + 1)) throw new KernelInvariantError(11, 'restored next pid must exceed all allocated pids');
    this.clear();
    for (const pcb of data.processes) {
      const raw = data.raw.find(row => row.pid === pcb.pid);
      this.insert(pcb, raw === undefined ? undefined : { rawBurst: raw.rawBurst, rawService: raw.rawService, serialFraction: raw.serialFraction });
    }
    for (const pid of data.createdEvents) this.createdEvents.add(pid);
    this.pidCounter = data.nextPid;
  }

  setNextPid(next: number): void {
    if (!Number.isSafeInteger(next) || next < this.pidCounter) {
      throw new KernelInvariantError(11, 'restored next pid must exceed all allocated pids');
    }
    this.pidCounter = next;
  }
}

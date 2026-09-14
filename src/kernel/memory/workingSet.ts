import type { PageId, Pid, Rng, Tick, VmSnapshotState } from '../types';
import { asPageId, asPid, asTick } from '../types';

export type WorkingSetsState = VmSnapshotState['payload']['workingSets'];

/** A reference history, with constant-time insertion and distinct-page count. */
export class WorkingSet {
  private readonly ring: (PageId | undefined)[];
  private readonly counts = new Map<PageId, number>();
  private head = 0;
  private length = 0;

  constructor(readonly capacity = 10) {
    integer(capacity, 'working-set capacity', 1);
    this.ring = new Array<PageId | undefined>(capacity);
  }

  get distinctCount(): number { return this.counts.size; }
  get size(): number { return this.length; }
  get references(): readonly PageId[] {
    return Array.from({ length: this.length }, (_, offset) => this.ring[(this.head + offset) % this.capacity]!);
  }
  get pages(): ReadonlySet<PageId> { return new Set(this.counts.keys()); }

  push(page: PageId): void {
    integer(page, 'working-set page');
    const position = (this.head + this.length) % this.capacity;
    if (this.length === this.capacity) {
      const old = this.ring[this.head]!;
      const remaining = this.counts.get(old)! - 1;
      if (remaining === 0) this.counts.delete(old);
      else this.counts.set(old, remaining);
      this.head = (this.head + 1) % this.capacity;
    } else this.length += 1;
    this.ring[position] = page;
    this.counts.set(page, (this.counts.get(page) ?? 0) + 1);
  }

  reset(): void {
    this.ring.fill(undefined); this.counts.clear(); this.head = 0; this.length = 0;
  }
}

type Estimate = { ring: WorkingSet; noise: number; nextNoiseTick: Tick };

/** True demand is independent of the neutral precision input and reported noise. */
export class WorkingSetModel {
  private readonly processes = new Map<Pid, Estimate>();
  private precise = false;
  private draws = 0;

  constructor(readonly capacity: number, private readonly rng: Rng) { integer(capacity, 'working-set capacity', 1); }

  get noiseDraws(): number { return this.draws; }
  get preciseEstimates(): boolean { return this.precise; }
  setPrecision(precise: boolean): void { this.precise = precise; }

  admit(pid: Pid, tick: Tick): void {
    integer(pid, 'working-set pid', 2); integer(tick, 'working-set admission tick');
    if (this.processes.has(pid)) return;
    this.processes.set(pid, {
      ring: new WorkingSet(this.capacity), noise: 0,
      nextNoiseTick: asTick(Math.max(10, Math.ceil(tick / 10) * 10)),
    });
  }
  remove(pid: Pid): void { this.processes.delete(pid); }
  reset(pid: Pid): void { this.processes.get(pid)?.ring.reset(); }
  push(pid: Pid, page: PageId): void {
    const entry = this.processes.get(pid);
    if (entry === undefined) throw new Error('working-set reference requires admission');
    entry.ring.push(page);
  }
  trueSize(pid: Pid): number { return this.processes.get(pid)?.ring.distinctCount ?? 0; }

  /** Caller supplies admitted, live, non-suspended user PIDs; order is canonical. */
  updateNoise(tick: Tick, eligiblePids: readonly Pid[]): void {
    integer(tick, 'working-set noise tick');
    if (tick === 0 || tick % 10 !== 0) return;
    for (const pid of [...new Set(eligiblePids)].sort((a, b) => a - b)) {
      const entry = this.processes.get(pid);
      if (entry === undefined || tick < entry.nextNoiseTick) continue;
      entry.noise = this.precise ? this.rng.int(-1, 2) : this.rng.int(-2, 3);
      this.draws += 1;
      entry.nextNoiseTick = asTick(tick + 10);
    }
  }

  trueSizes(eligiblePids: readonly Pid[] = [...this.processes.keys()]): ReadonlyMap<Pid, number> {
    return this.sizes(eligiblePids, false);
  }
  reportedSizes(eligiblePids: readonly Pid[] = [...this.processes.keys()]): ReadonlyMap<Pid, number> {
    return this.sizes(eligiblePids, true);
  }
  private sizes(pids: readonly Pid[], reported: boolean): ReadonlyMap<Pid, number> {
    const result = new Map<Pid, number>();
    for (const pid of [...new Set(pids)].sort((a, b) => a - b)) {
      const entry = this.processes.get(pid);
      if (entry !== undefined) result.set(pid, Math.max(0, entry.ring.distinctCount + (reported ? entry.noise : 0)));
    }
    return result;
  }

  saveState(): WorkingSetsState {
    return {
      preciseEstimates: this.precise, noiseDraws: this.draws,
      processes: [...this.processes].sort(([a], [b]) => a - b).map(([pid, entry]) => ({
        pid, references: entry.ring.references, noise: entry.noise, nextNoiseTick: entry.nextNoiseTick,
      })),
    };
  }

  /** Validate the complete contribution before replacing any live rings. */
  prepareRestore(input: unknown): () => void {
    const state = object(input, 'working sets');
    if (typeof state.preciseEstimates !== 'boolean') throw new Error('invalid working-set precision');
    const precise = state.preciseEstimates;
    const draws = integer(state.noiseDraws, 'working-set noise draws');
    if (!Array.isArray(state.processes)) throw new Error('invalid working-set processes');
    const prepared = new Map<Pid, Estimate>();
    let previous = 1;
    for (const value of state.processes) {
      const entry = object(value, 'working-set process');
      const pid = asPid(integer(entry.pid, 'working-set pid', previous + 1));
      previous = pid;
      if (!Array.isArray(entry.references) || entry.references.length > this.capacity) throw new Error('invalid working-set references');
      const ring = new WorkingSet(this.capacity);
      for (const page of entry.references) ring.push(asPageId(integer(page, 'working-set page')));
      const noise = integer(entry.noise, 'working-set noise', -2);
      if (noise > 2) throw new Error('invalid working-set noise');
      const nextNoiseTick = asTick(integer(entry.nextNoiseTick, 'working-set next noise tick', 10));
      if (nextNoiseTick % 10 !== 0) throw new Error('invalid working-set noise cadence');
      prepared.set(pid, { ring, noise, nextNoiseTick });
    }
    return () => {
      this.precise = precise; this.draws = draws; this.processes.clear();
      for (const [pid, entry] of prepared) this.processes.set(pid, entry);
    };
  }
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error(`invalid ${label}`);
  return value;
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${label}`);
  return value as Record<string, unknown>;
}

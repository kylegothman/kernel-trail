import type { BlockId, DeviceId, IoSnapshotActor, IoSnapshotMediaResult, IoSnapshotState, Pid, SyscallResult, Tick } from '../types';
import { check, compareText, success, validInteger } from './drivers/DeviceDriver';
import type { Mutable } from './drivers/DeviceDriver';

type State = IoSnapshotState['payload']['cache'];
export type CacheFlush = State['flushes'][number];
export interface CacheHost {
  tick(): Tick;
  capacity(): number;
  nextFlush(): number;
  nextSync(): number;
  submit(flush: CacheFlush): Exclude<CacheFlush['progress'], { kind: 'queued' } | { kind: 'completed' }> | null;
  take(flush: CacheFlush): IoSnapshotMediaResult | null;
  cancel(flush: CacheFlush): void;
  block(actor: IoSnapshotActor, device: DeviceId): void;
}
export class BlockCache {
  private data: Mutable<State> = { policy: 'write_through', nextGeneration: 1, hits: 0, misses: 0, entries: [], flushes: [], admissions: [], syncs: [] };
  constructor(private readonly host: CacheHost) {}
  setPolicy(policy: State['policy']): void { check(policy === 'write_through' || policy === 'write_back', 'cache policy'); this.data.policy = policy; }
  get policy(): State['policy'] { return this.data.policy; }
  get hitRate(): number { const count = this.data.hits + this.data.misses; return count === 0 ? 0 : this.data.hits / count; }
  read(device: DeviceId, block: BlockId): readonly number[] | null {
    const entry = this.find(device, block);
    if (entry === undefined) { this.data.misses += 1; return null; }
    this.data.hits += 1; entry.lastAccessTick = this.host.tick(); return [...entry.contents];
  }
  peek(device: DeviceId, block: BlockId): readonly number[] | null { const entry = this.find(device, block); return entry === undefined ? null : [...entry.contents]; }
  fill(device: DeviceId, block: BlockId, contents: readonly number[]): boolean {
    if (this.find(device, block) !== undefined) return true;
    if (!this.room(device, block, null)) return false;
    const generation = this.data.nextGeneration++;
    this.data.entries.push({ device, block, contents: [...contents], loadedAtTick: this.host.tick(), lastAccessTick: null, generation, durableGeneration: generation });
    return true;
  }
  write(device: DeviceId, block: BlockId, contents: readonly number[], requestId: number | null = null): boolean {
    check(contents.every(byte => validInteger(byte) && byte <= 255), 'cache bytes');
    let entry = this.find(device, block);
    if (entry === undefined) {
      if (!this.room(device, block, requestId)) return false;
      entry = { device, block, contents: [], loadedAtTick: this.host.tick(), lastAccessTick: null, generation: 0, durableGeneration: 0 };
      this.data.entries.push(entry);
    }
    entry.contents = [...contents]; entry.generation = this.data.nextGeneration++; entry.lastAccessTick = this.host.tick();
    if (this.data.policy === 'write_through') this.flush(entry, 'write_through');
    this.submitQueued(); return true;
  }
  dirtyEntries(): readonly BlockId[] {
    return this.data.policy === 'write_through' ? [] : this.data.entries.filter(row => row.generation > row.durableGeneration)
      .sort((a, b) => a.block - b.block || compareText(a.device, b.device)).map(row => row.block);
  }
  dropDirty(): readonly BlockId[] {
    const removed = this.data.entries.filter(row => row.generation > row.durableGeneration);
    const matches = (device: DeviceId, block: BlockId): boolean => removed.some(row => row.device === device && row.block === block);
    for (const flush of this.data.flushes) if (matches(flush.device, flush.block) && flush.progress.kind !== 'completed') {
      this.host.cancel(flush); flush.progress = { kind: 'completed', result: { kind: 'failed', reason: 'cancelled' } };
    }
    this.data.entries = this.data.entries.filter(row => !matches(row.device, row.block));
    this.data.admissions = this.data.admissions.filter(row => !matches(row.device, row.block));
    return removed.sort((a, b) => a.block - b.block || compareText(a.device, b.device)).map(row => row.block);
  }
  sync(actor: IoSnapshotActor): SyscallResult {
    const flushIds = this.data.entries.filter(row => row.generation > row.durableGeneration).map(row => this.flush(row, 'sync').id);
    this.submitQueued();
    if (flushIds.length === 0) return success(0);
    const id = this.host.nextSync(); this.data.syncs.push({ id, actor: { ...actor }, requestedAtTick: this.host.tick(), flushIds, completed: false });
    const first = this.data.flushes.find(row => row.id === flushIds[0]); check(first !== undefined, 'sync flush');
    this.host.block(actor, first.device); return success(flushIds.length);
  }
  isSatisfied(actor: IoSnapshotActor): boolean {
    const group = this.data.syncs.find(row => row.actor.pid === actor.pid && row.actor.tid === actor.tid);
    if (group?.completed !== true) return false;
    this.data.syncs = this.data.syncs.filter(row => row !== group); this.collect(); return true;
  }
  pump(): void {
    for (const flush of this.data.flushes) {
      if (flush.progress.kind !== 'storage' && flush.progress.kind !== 'io') continue;
      const result = this.host.take(flush); if (result === null) continue;
      flush.progress = { kind: 'completed', result: structuredClone(result) as Mutable<IoSnapshotMediaResult> };
      const entry = this.find(flush.device, flush.block);
      if (result.kind === 'ok' && entry !== undefined) entry.durableGeneration = Math.max(entry.durableGeneration, flush.generation);
    }
    for (const group of this.data.syncs) group.completed = group.flushIds.every(id => this.data.flushes.find(row => row.id === id)?.progress.kind === 'completed');
    this.submitQueued(); this.collect();
  }
  isDurable(device: DeviceId, block: BlockId): boolean { const entry = this.find(device, block); return entry !== undefined && entry.durableGeneration === entry.generation; }
  invalidate(device: DeviceId): void { this.data.entries = this.data.entries.filter(entry => entry.device !== device); }
  abortDevice(device: DeviceId): void {
    for (const flush of this.data.flushes) if (flush.device === device && flush.progress.kind !== 'completed') {
      this.host.cancel(flush); flush.progress = { kind: 'completed', result: { kind: 'failed', reason: 'cancelled' } };
    }
    this.data.admissions = this.data.admissions.filter(row => row.device !== device);
  }
  pendingWrite(device: DeviceId, block: BlockId): boolean {
    return this.data.flushes.some(row => row.device === device && row.block === block && row.progress.kind !== 'completed');
  }
  removeWaiter(pid: Pid, requestIds: ReadonlySet<number>): void {
    this.data.syncs = this.data.syncs.filter(row => row.actor.pid !== pid);
    this.data.admissions = this.data.admissions.filter(row => !requestIds.has(row.requestId)); this.collect();
  }
  snapshot(): State {
    return structuredClone({ ...this.data, entries: [...this.data.entries].sort((a, b) => compareText(a.device, b.device) || a.block - b.block) });
  }
  restore(state: State): void { this.validate(state); this.data = structuredClone(state) as Mutable<State>; }
  validate(state: State): void {
    check(['write_through', 'write_back'].includes(state.policy) && validInteger(state.nextGeneration, 1)
      && validInteger(state.hits) && validInteger(state.misses) && state.entries.length <= this.host.capacity(), 'cache header');
    const keys = new Set<string>(); const flushIds = new Set<number>();
    for (const entry of state.entries) {
      const key = entry.device + ':' + entry.block; check(!keys.has(key), 'duplicate cache block'); keys.add(key);
      check(validInteger(entry.block) && validInteger(entry.generation, 1) && entry.generation < state.nextGeneration
        && validInteger(entry.durableGeneration) && entry.durableGeneration <= entry.generation, 'cache generation');
      check(entry.contents.every(byte => validInteger(byte) && byte <= 255), 'cache content');
    }
    for (const flush of state.flushes) {
      check(validInteger(flush.id, 1) && !flushIds.has(flush.id) && validInteger(flush.generation, 1) && flush.generation < state.nextGeneration, 'flush identity'); flushIds.add(flush.id);
      check(['queued', 'io', 'storage', 'completed'].includes(flush.progress.kind), 'flush progress');
    }
    for (const group of state.syncs) check(group.flushIds.every(id => flushIds.has(id)) && new Set(group.flushIds).size === group.flushIds.length, 'sync references');
    for (const admission of state.admissions) check(admission.evictionFlushId === null || flushIds.has(admission.evictionFlushId), 'eviction reference');
  }
  private find(device: DeviceId, block: BlockId): Mutable<State>['entries'][number] | undefined { return this.data.entries.find(row => row.device === device && row.block === block); }
  private room(device: DeviceId, block: BlockId, requestId: number | null): boolean {
    if (this.data.entries.length < this.host.capacity()) return true;
    const victim = [...this.data.entries].sort((a, b) => (a.lastAccessTick ?? a.loadedAtTick) - (b.lastAccessTick ?? b.loadedAtTick)
      || a.block - b.block || compareText(a.device, b.device))[0]; check(victim !== undefined, 'cache victim');
    if (victim.generation > victim.durableGeneration) {
      const flush = this.flush(victim, 'eviction');
      if (requestId !== null && !this.data.admissions.some(row => row.requestId === requestId)) this.data.admissions.push({ requestId, device, block, evictionFlushId: flush.id });
      this.submitQueued(); return false;
    }
    this.data.entries = this.data.entries.filter(row => row !== victim);
    this.data.admissions = this.data.admissions.filter(row => row.requestId !== requestId); return true;
  }
  private flush(entry: Mutable<State>['entries'][number], reason: CacheFlush['reason']): Mutable<CacheFlush> {
    const existing = this.data.flushes.find(row => row.device === entry.device && row.block === entry.block && row.generation === entry.generation
      && (row.progress.kind !== 'completed' || row.progress.result.kind === 'ok'));
    if (existing !== undefined) return existing;
    const flush: Mutable<CacheFlush> = { id: this.host.nextFlush(), device: entry.device, block: entry.block, generation: entry.generation,
      contents: [...entry.contents], reason, progress: { kind: 'queued' } };
    this.data.flushes.push(flush); return flush;
  }
  private submitQueued(): void {
    for (const flush of this.data.flushes) if (flush.progress.kind === 'queued') {
      if (this.data.flushes.some(other => other.id < flush.id && other.device === flush.device && other.block === flush.block && other.progress.kind !== 'completed')) continue;
      const progress = this.host.submit(flush); if (progress !== null) flush.progress = progress;
    }
  }
  private collect(): void {
    const retained = new Set(this.data.syncs.flatMap(row => row.flushIds));
    for (const admission of this.data.admissions) if (admission.evictionFlushId !== null) retained.add(admission.evictionFlushId);
    this.data.flushes = this.data.flushes.filter(row => row.progress.kind !== 'completed' || retained.has(row.id));
  }
}

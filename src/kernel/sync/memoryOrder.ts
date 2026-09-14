import type { Pid, ResourceId, Rng, SyncSnapshotCell, SyncSnapshotMemoryOrder, Tick } from '../types';
import { check, compareStrings, integer } from './SyncSubsystem';
import type { Actor, SyncHost } from './SyncSubsystem';
import { detachSyncData, RaceDetector, validateActor, validateHeld } from './raceDetector';

type Write = SyncSnapshotMemoryOrder['buffers'][number]['writes'][number];
type Binding = { get(): number; set(value: number): void };
type Buffer = {
  pid: Pid; reordering: boolean; depth: number; attemptResidue: number;
  writes: Write[]; active: boolean; suppressed: boolean;
};

/** Attempt-counted weak ordering; only protocol control values are owned here. */
export class MemoryOrder {
  private cells = new Map<string, SyncSnapshotCell>();
  private bindings = new Map<string, Binding>();
  private buffers = new Map<Pid, Buffer>();
  private nextWriteId = 0;
  private readonly flushing = new Set<Pid>();

  constructor(private readonly host: SyncHost, private readonly rng: Rng,
    private readonly race: RaceDetector, private readonly held: (actor: Actor) => readonly ResourceId[]) {}

  register(input: SyncSnapshotCell): void {
    const cell = detachSyncData(input);
    check(!this.cells.has(cell.id), `duplicate cell ${cell.id}`);
    const binding = this.validateCell(cell);
    if (binding !== null) {
      this.race.register(cell.id, binding.get());
      this.bindings.set(cell.id, binding);
    }
    this.cells.set(cell.id, cell);
  }

  has(cell: string): boolean { return this.cells.has(cell); }
  isControl(cell: string): boolean { return this.cells.get(cell)?.kind === 'control'; }

  configure(pid: Pid, settings: { readonly reordering: boolean; readonly depth: number }): void {
    check(integer(pid, 2) && typeof settings.reordering === 'boolean' && integer(settings.depth, 1), 'memory-order configuration');
    const previous = this.buffers.get(pid);
    check(previous === undefined || (!previous.active && previous.writes.length === 0), 'reconfigure non-empty/active buffer');
    this.buffers.set(pid, { pid, reordering: settings.reordering, depth: settings.depth,
      attemptResidue: previous?.depth === settings.depth ? previous.attemptResidue : 0,
      writes: [], active: false, suppressed: false });
  }

  beginAttempt(pid: Pid): void {
    const buffer = this.buffer(pid);
    check(!buffer.active, 'nested instruction attempt');
    buffer.active = true; buffer.suppressed = false;
    buffer.attemptResidue = (buffer.attemptResidue + 1) % buffer.depth;
  }

  endAttempt(pid: Pid): void {
    const buffer = this.buffers.get(pid);
    // Exit/exec may have removed this process's execution state during the attempt.
    if (buffer === undefined) return;
    check(buffer.active, 'instruction attempt was not begun');
    try {
      if (!buffer.suppressed && buffer.attemptResidue === 0 && buffer.writes.length > 0) this.drain(buffer);
    } finally { buffer.active = false; buffer.suppressed = false; }
  }

  load(actor: Actor, cell: string, rmw = false): number {
    validateActor(actor);
    const descriptor = this.requireCell(cell), buffer = this.buffer(actor.pid);
    check(!rmw || descriptor.kind !== 'control', 'control word cannot start an application RMW');
    const value = buffer.writes.findLast(write => write.cell === cell)?.value ?? this.peek(cell);
    if (descriptor.kind !== 'control') this.race.load(actor, cell, value, this.held(actor), rmw);
    return value;
  }

  store(actor: Actor, cell: string, value: number, rmw = false): boolean {
    validateActor(actor); check(Number.isSafeInteger(value), 'store value');
    const descriptor = this.requireCell(cell), buffer = this.buffer(actor.pid);
    check(!rmw || descriptor.kind !== 'control', 'control word cannot complete an application RMW');
    if (buffer.reordering && buffer.writes.length === buffer.depth) return false;
    const operation = rmw ? this.race.pending(actor, cell) : null;
    check(!rmw || operation !== null, 'RMW store has no matching load');
    check(integer(this.nextWriteId + 1), 'write ID overflow');
    const write: Write = { id: this.nextWriteId++, actor: { ...actor }, cell, value, issuedAt: this.host.tick(),
      held: [...new Set(this.held(actor))].sort(compareStrings), rmw: operation };
    if (buffer.reordering) {
      if (operation !== null) this.race.queue(cell, operation, write.id);
      buffer.writes.push(write);
    } else this.commit(write);
    return true;
  }

  /** Read the committed word for protocol inspection, without recording an access. */
  peek(cell: string): number {
    const descriptor = this.requireCell(cell);
    if (descriptor.kind === 'control') return descriptor.value;
    const binding = this.bindings.get(cell); check(binding !== undefined, `missing binding ${cell}`);
    const value = binding.get(); check(Number.isSafeInteger(value), 'external cell value'); return value;
  }

  /** Releases and fences flush before publishing their ordering effect. */
  flush(pid: Pid): void {
    const buffer = this.buffers.get(pid);
    if (buffer === undefined) return;
    buffer.suppressed = buffer.active;
    if (this.flushing.has(pid)) return;
    this.flushing.add(pid);
    try {
      while (buffer.writes.length > 0) {
        const write = buffer.writes.shift(); check(write !== undefined, 'missing buffered write'); this.commit(write);
      }
    } finally { this.flushing.delete(pid); }
  }

  fence(pid: Pid): void { this.flush(pid); }

  tas(actor: Actor, cell: string): number {
    this.flush(actor.pid);
    const value = this.atomicLoad(actor, cell);
    this.atomicWrite(actor, cell, value, 1);
    return value;
  }

  cas(actor: Actor, cell: string, expected: number, replacement: number): number {
    check(Number.isSafeInteger(expected) && Number.isSafeInteger(replacement), 'CAS operands');
    this.flush(actor.pid);
    const value = this.atomicLoad(actor, cell);
    if (value === expected) this.atomicWrite(actor, cell, value, replacement);
    return value;
  }

  atomicStore(actor: Actor, cell: string, value: number): void {
    check(Number.isSafeInteger(value), 'atomic store value'); this.flush(actor.pid);
    this.atomicWrite(actor, cell, this.peek(cell), value);
  }

  removeProcess(pid: Pid): void { this.flush(pid); this.buffers.delete(pid); }

  save(): SyncSnapshotMemoryOrder {
    check([...this.buffers.values()].every(buffer => !buffer.active), 'snapshot during instruction attempt');
    return detachSyncData({ cells: [...this.cells.values()].sort((a, b) => compareStrings(a.id, b.id)), nextWriteId: this.nextWriteId,
      buffers: [...this.buffers.values()].sort((a, b) => a.pid - b.pid).map(buffer => ({ pid: buffer.pid,
        reordering: buffer.reordering, depth: buffer.depth, attemptResidue: buffer.attemptResidue, writes: buffer.writes })) });
  }

  prepareRestore(input: SyncSnapshotMemoryOrder, snapshotTick: Tick = this.host.tick()): () => void {
    const state = detachSyncData(input);
    check(state !== null && typeof state === 'object' && integer(state.nextWriteId) && Array.isArray(state.cells)
      && Array.isArray(state.buffers) && integer(snapshotTick), 'memory-order state');
    const cells = new Map<string, SyncSnapshotCell>(), bindings = new Map<string, Binding>();
    let previousCell: string | undefined;
    for (const cell of state.cells) {
      const binding = this.validateCell(cell);
      check(previousCell === undefined || previousCell < cell.id, 'cell order/duplicate'); previousCell = cell.id;
      cells.set(cell.id, cell); if (binding !== null) bindings.set(cell.id, binding);
    }
    const buffers = new Map<Pid, Buffer>(), writeIds = new Set<number>();
    let previousPid = 1;
    for (const buffer of state.buffers) {
      check(buffer !== null && typeof buffer === 'object' && integer(buffer.pid, 2) && buffer.pid > previousPid
        && this.host.process(buffer.pid) !== undefined, 'buffer process/order'); previousPid = buffer.pid;
      check(typeof buffer.reordering === 'boolean' && integer(buffer.depth, 1) && integer(buffer.attemptResidue)
        && buffer.attemptResidue < buffer.depth && Array.isArray(buffer.writes) && buffer.writes.length <= buffer.depth
        && (buffer.reordering || buffer.writes.length === 0), 'buffer capacity/residue');
      let previousWrite = -1;
      for (const write of buffer.writes) {
        check(write !== null && typeof write === 'object' && integer(write.id) && write.id < state.nextWriteId
          && write.id > previousWrite && !writeIds.has(write.id), 'write ID/order');
        previousWrite = write.id; writeIds.add(write.id); validateActor(write.actor); validateHeld(write.held);
        const descriptor = cells.get(write.cell), origin = this.host.thread(write.actor.tid);
        check(write.actor.pid === buffer.pid && (origin === undefined || origin.pid === buffer.pid), 'write origin');
        check(descriptor !== undefined && Number.isSafeInteger(write.value) && integer(write.issuedAt)
          && write.issuedAt <= snapshotTick, 'write target/value/tick');
        check(write.rmw === null || (integer(write.rmw) && descriptor.kind !== 'control'), 'write RMW');
      }
      buffers.set(buffer.pid, { ...buffer, writes: [...buffer.writes], active: false, suppressed: false });
    }
    return () => { this.cells = cells; this.bindings = bindings; this.buffers = buffers; this.nextWriteId = state.nextWriteId; this.flushing.clear(); };
  }

  private buffer(pid: Pid): Buffer {
    let buffer = this.buffers.get(pid);
    if (buffer === undefined) {
      this.configure(pid, { reordering: false, depth: this.host.settings().storeBufferDepth });
      buffer = this.buffers.get(pid);
    }
    check(buffer !== undefined, 'missing process buffer'); return buffer;
  }

  private drain(buffer: Buffer): void {
    const seen = new Set<string>(), eligible: Write[] = [];
    for (const write of buffer.writes) if (!seen.has(write.cell)) { seen.add(write.cell); eligible.push(write); }
    if (buffer.depth > 1) this.rng.shuffle(eligible);
    const selected = eligible[0]; check(selected !== undefined, 'empty drain event');
    const index = buffer.writes.indexOf(selected); check(index >= 0, 'drain selection');
    buffer.writes.splice(index, 1); this.commit(selected);
  }

  private commit(write: Write): void {
    const descriptor = this.requireCell(write.cell), previous = this.peek(write.cell);
    this.writeValue(descriptor, write.value);
    if (descriptor.kind !== 'control') this.race.store(write.actor, write.cell, previous, write.value, write.held, write.rmw);
  }

  private atomicLoad(actor: Actor, cell: string): number {
    validateActor(actor); const value = this.peek(cell);
    if (this.requireCell(cell).kind !== 'control') this.race.load(actor, cell, value, this.held(actor), false, true);
    return value;
  }

  private atomicWrite(actor: Actor, cell: string, previous: number, value: number): void {
    validateActor(actor); const descriptor = this.requireCell(cell);
    this.writeValue(descriptor, value);
    if (descriptor.kind !== 'control') this.race.store(actor, cell, previous, value, this.held(actor), null, true);
  }

  private writeValue(descriptor: SyncSnapshotCell, value: number): void {
    if (descriptor.kind === 'control') this.cells.set(descriptor.id, { ...descriptor, value });
    else { const binding = this.bindings.get(descriptor.id); check(binding !== undefined, 'missing cell binding'); binding.set(value); }
  }

  private requireCell(cell: string): SyncSnapshotCell {
    const descriptor = this.cells.get(cell); check(descriptor !== undefined, `unknown cell ${cell}`); return descriptor;
  }

  private validateCell(cell: SyncSnapshotCell): Binding | null {
    check(cell !== null && typeof cell === 'object' && typeof cell.id === 'string' && cell.id.length > 0, 'cell identity');
    switch (cell.kind) {
      case 'control': check(Number.isSafeInteger(cell.value), 'control value'); return null;
      case 'region': check(typeof cell.region === 'string' && cell.region.length > 0, 'region binding'); break;
      case 'inode': check(integer(cell.inode, 1) && typeof cell.field === 'string' && cell.field.length > 0, 'inode binding'); break;
      default: throw new Error('invalid sync state: cell kind');
    }
    const binding = this.host.cell(cell); check(binding !== undefined && Number.isSafeInteger(binding.get()), 'unavailable cell binding'); return binding;
  }
}

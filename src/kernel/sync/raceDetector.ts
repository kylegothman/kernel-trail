import type { Pid, ResourceId, SyncSnapshotAccess, SyncSnapshotMemoryOrder, SyncSnapshotRaceCell, SyncSnapshotState, Tick } from '../types';
import { actorKey, check, compareStrings, integer, sameActor } from './SyncSubsystem';
import type { Actor, SyncHost } from './SyncSubsystem';

export type RaceState = SyncSnapshotState['payload']['raceDetector'];
type Category = keyof SyncSnapshotRaceCell['observed'];
const CATEGORIES: readonly Category[] = ['plainReads', 'plainWrites', 'atomicReads', 'atomicWrites'];

/** Snapshot parsing rejects non-JSON state before making a detached copy. */
export function detachSyncData<T>(value: T): T {
  const visit = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') { check(Number.isFinite(item), 'non-finite number'); return; }
    check(typeof item === 'object', 'non-JSON value');
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index += 1) {
        check(Object.hasOwn(item, index), 'sparse array'); visit(item[index]);
      }
      return;
    }
    check(Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null, 'non-plain object');
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {
      check(Object.hasOwn(descriptor, 'value'), 'snapshot accessor'); visit(descriptor.value);
    }
  };
  visit(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function validateActor(actor: Actor): void {
  check(actor !== null && typeof actor === 'object' && integer(actor.pid, 2) && integer(actor.tid, 1), 'actor identity');
}

export function validateHeld(held: readonly ResourceId[]): void {
  check(Array.isArray(held), 'held array');
  let previous: string | undefined;
  for (const resource of held) {
    check(typeof resource === 'string' && resource.length > 0 && (previous === undefined || previous < resource), 'held resource order');
    previous = resource;
  }
}

function copyHeld(held: readonly ResourceId[]): readonly ResourceId[] {
  return [...new Set(held)].sort(compareStrings);
}

function category(record: SyncSnapshotAccess): Category {
  if (record.atomic) return record.op === 'load' ? 'atomicReads' : 'atomicWrites';
  return record.op === 'load' ? 'plainReads' : 'plainWrites';
}

function format(cell: string, record: SyncSnapshotAccess): string {
  return `t=${record.tick} P${record.actor.pid} ${record.op === 'load' ? 'LOAD ' : 'STORE'} ${cell} `
    + `${record.op === 'load' ? '->' : '<-'} ${record.value}`
    + (record.held.length > 0 ? ` [holds ${record.held.join(',')}]` : ' [holds nothing]');
}

/** Two detectors share bounded access evidence; authoritative values stay outside. */
export class RaceDetector {
  private cells = new Map<string, SyncSnapshotRaceCell>();
  private nextAccessId = 0;

  constructor(private readonly host: Pick<SyncHost, 'tick' | 'emit'>) {}

  register(cell: string, initialValue: number): void {
    check(cell.length > 0 && Number.isSafeInteger(initialValue) && !this.cells.has(cell), 'race cell registration');
    this.cells.set(cell, { cell, serialValue: initialValue, lockSet: null, history: [],
      observed: { plainReads: [], plainWrites: [], atomicReads: [], atomicWrites: [] }, episodeOrigin: null, pending: [] });
  }

  has(cell: string): boolean { return this.cells.has(cell); }

  pending(actor: Actor, cell: string): number | null {
    const found = this.require(cell).pending.find(row => row.writeId === null && sameActor(row.load.actor, actor));
    return found?.load.id ?? null;
  }

  load(actor: Actor, cell: string, value: number, held: readonly ResourceId[], rmw = false, atomic = false): number | null {
    const state = this.require(cell);
    check(!rmw || (!atomic && this.pending(actor, cell) === null), 'overlapping unqueued RMW');
    const record = this.access(actor, 'load', value, held, atomic, rmw ? this.nextAccessId : null);
    const recorded = this.record(state, record);
    const next: SyncSnapshotRaceCell = rmw ? { ...recorded, episodeOrigin: state.episodeOrigin ?? record,
      pending: [...state.pending, { load: record, writeId: null, witness: null }] } : recorded;
    this.cells.set(cell, next);
    this.potential(next, record, value);
    return rmw ? record.id : null;
  }

  queue(cell: string, rmw: number, writeId: number): void {
    const state = this.require(cell);
    const pending = state.pending.find(row => row.load.id === rmw);
    check(pending !== undefined && pending.writeId === null && integer(writeId), 'queued RMW reference');
    this.cells.set(cell, { ...state, pending: state.pending.map(row => row === pending ? { ...row, writeId } : row) });
  }

  store(actor: Actor, cell: string, previous: number, value: number, held: readonly ResourceId[], rmw: number | null = null, atomic = false): void {
    const state = this.require(cell);
    const operation = rmw === null ? undefined : state.pending.find(row => row.load.id === rmw);
    check(rmw === null || (operation !== undefined && sameActor(operation.load.actor, actor)), 'store RMW reference');
    const record = this.access(actor, 'store', value, held, atomic, rmw);
    const serialValue = operation !== undefined ? state.serialValue + value - operation.load.value
      : atomic ? state.serialValue + value - previous : value;
    check(Number.isSafeInteger(serialValue), 'serial counter overflow');
    const pending = state.pending.filter(row => row !== operation).map(row => {
      if (row.witness !== null || sameActor(row.load.actor, actor) || value === row.load.value) return row;
      return { ...row, witness: { load: operation?.load ?? null, store: record } };
    });
    const next = this.record({ ...state, serialValue, pending, episodeOrigin: pending.length === 0 ? null : state.episodeOrigin }, record);
    this.cells.set(cell, next);
    this.potential(next, record, value);
    if (operation !== undefined && operation.witness !== null && operation.load.value !== previous) {
      const evidence = [operation.load, ...(operation.witness === null ? []
        : [...(operation.witness.load === null ? [] : [operation.witness.load]), operation.witness.store]),
      ...(state.episodeOrigin === null ? [] : [state.episodeOrigin]), record];
      const actors = [actor, ...(operation.witness === null ? [] : [operation.witness.store.actor])];
      this.report(next, record, value, actors, evidence);
    }
  }

  removeActor(actor: Actor): void {
    for (const [cell, state] of this.cells) {
      const pending = state.pending.filter(row => row.writeId !== null || !sameActor(row.load.actor, actor));
      if (pending.length !== state.pending.length) this.cells.set(cell, { ...state, pending, episodeOrigin: pending.length === 0 ? null : state.episodeOrigin });
    }
  }

  save(): RaceState {
    return detachSyncData({ nextAccessId: this.nextAccessId, cells: [...this.cells.values()].sort((a, b) => compareStrings(a.cell, b.cell)) });
  }

  prepareRestore(input: RaceState, memory: SyncSnapshotMemoryOrder, snapshotTick: Tick = this.host.tick()): () => void {
    const state = detachSyncData(input);
    check(state !== null && typeof state === 'object' && integer(state.nextAccessId) && Array.isArray(state.cells), 'race state');
    const external = new Set(memory.cells.filter(cell => cell.kind !== 'control').map(cell => cell.id));
    const writes = new Map(memory.buffers.flatMap(buffer => buffer.writes.map(write => [write.id, write] as const)));
    const accessCopies = new Map<number, string>();
    const validateAccess = (record: SyncSnapshotAccess): void => {
      check(record !== null && typeof record === 'object' && integer(record.id) && record.id < state.nextAccessId, 'access ID');
      validateActor(record.actor); validateHeld(record.held);
      check(integer(record.tick) && record.tick <= snapshotTick && Number.isSafeInteger(record.value), 'access value/tick');
      check((record.op === 'load' || record.op === 'store') && typeof record.atomic === 'boolean', 'access kind');
      check(record.rmw === null || (integer(record.rmw) && record.rmw < state.nextAccessId && !record.atomic), 'access RMW');
      const encoded = JSON.stringify(record), existing = accessCopies.get(record.id);
      check(existing === undefined || existing === encoded, 'conflicting copies of an access'); accessCopies.set(record.id, encoded);
    };
    const cells = new Map<string, SyncSnapshotRaceCell>();
    const rmws = new Set<number>();
    let previousCell: string | undefined;
    for (const cell of state.cells) {
      check(cell !== null && typeof cell === 'object' && typeof cell.cell === 'string' && external.has(cell.cell)
        && (previousCell === undefined || previousCell < cell.cell), 'race cell identity/order');
      previousCell = cell.cell;
      check(Number.isSafeInteger(cell.serialValue), 'serial value');
      if (cell.lockSet !== null) validateHeld(cell.lockSet);
      check(Array.isArray(cell.history) && cell.history.length <= 32 && Array.isArray(cell.pending), 'race record bounds');
      let previousAccess = -1;
      for (const record of cell.history) { validateAccess(record); check(record.id > previousAccess, 'history order'); previousAccess = record.id; }
      check(cell.observed !== null && typeof cell.observed === 'object', 'lifetime access summary');
      for (const key of CATEGORIES) {
        const records = cell.observed[key];
        check(Array.isArray(records) && records.length <= 2, 'lifetime witness bound');
        const actors = new Set<string>();
        for (const record of records) { validateAccess(record); check(category(record) === key && !actors.has(actorKey(record.actor)), 'lifetime witness category/actor'); actors.add(actorKey(record.actor)); }
      }
      if (cell.episodeOrigin !== null) { validateAccess(cell.episodeOrigin); check(cell.episodeOrigin.op === 'load' && cell.episodeOrigin.rmw === cell.episodeOrigin.id, 'episode origin'); }
      check((cell.pending.length === 0) === (cell.episodeOrigin === null), 'episode lifetime');
      const unqueued = new Set<string>();
      for (const pending of cell.pending) {
        validateAccess(pending.load);
        check(pending.load.op === 'load' && !pending.load.atomic && pending.load.rmw === pending.load.id && !rmws.has(pending.load.id), 'pending RMW load');
        rmws.add(pending.load.id);
        if (pending.writeId === null) { const key = actorKey(pending.load.actor); check(!unqueued.has(key), 'duplicate unqueued RMW'); unqueued.add(key); }
        else {
          check(integer(pending.writeId), 'pending write ID'); const write = writes.get(pending.writeId);
          check(write !== undefined && write.cell === cell.cell && write.rmw === pending.load.id && sameActor(write.actor, pending.load.actor), 'pending/buffer linkage');
        }
        if (pending.witness !== null) {
          validateAccess(pending.witness.store); check(pending.witness.store.op === 'store' && pending.witness.store.id > pending.load.id
            && !sameActor(pending.witness.store.actor, pending.load.actor), 'competing store witness');
          if (pending.witness.load !== null) { validateAccess(pending.witness.load); check(pending.witness.load.op === 'load'
            && pending.witness.store.rmw === pending.witness.load.id && sameActor(pending.witness.load.actor, pending.witness.store.actor), 'competing load witness'); }
        }
      }
      cells.set(cell.cell, cell);
    }
    check(cells.size === external.size, 'missing external race cell');
    for (const write of writes.values()) if (write.rmw !== null) check(rmws.has(write.rmw), 'buffered RMW is missing');
    return () => { this.cells = cells; this.nextAccessId = state.nextAccessId; };
  }

  private require(cell: string): SyncSnapshotRaceCell {
    const state = this.cells.get(cell); check(state !== undefined, `unknown race cell ${cell}`); return state;
  }

  private access(actor: Actor, op: 'load' | 'store', value: number, held: readonly ResourceId[], atomic: boolean, rmw: number | null): SyncSnapshotAccess {
    validateActor(actor); check(Number.isSafeInteger(value) && integer(this.nextAccessId + 1), 'access value/ID overflow');
    return { id: this.nextAccessId++, tick: this.host.tick(), actor: { ...actor }, op, value, held: copyHeld(held), atomic, rmw };
  }

  private record(state: SyncSnapshotRaceCell, record: SyncSnapshotAccess): SyncSnapshotRaceCell {
    const key = category(record), representatives = state.observed[key];
    const observed = representatives.length < 2 && !representatives.some(row => sameActor(row.actor, record.actor))
      ? { ...state.observed, [key]: [...representatives, record] } : state.observed;
    return { ...state, lockSet: state.lockSet === null ? [...record.held] : state.lockSet.filter(resource => record.held.includes(resource)),
      observed, history: [...state.history.slice(-31), record] };
  }

  private potential(state: SyncSnapshotRaceCell, record: SyncSnapshotAccess, value: number): void {
    if (state.lockSet === null || state.lockSet.length > 0) return;
    const conflicting = CATEGORIES.flatMap(key => state.observed[key]).find(other => !sameActor(other.actor, record.actor)
      && (other.op === 'store' || record.op === 'store') && (!other.atomic || !record.atomic));
    if (conflicting !== undefined) this.report(state, record, value, [record.actor, conflicting.actor], [conflicting, record]);
  }

  private report(state: SyncSnapshotRaceCell, record: SyncSnapshotAccess, value: number, actors: readonly Actor[], witness: readonly SyncSnapshotAccess[]): void {
    const from = Math.min(...witness.map(row => row.id));
    const union = new Map<number, SyncSnapshotAccess>();
    for (const row of [...state.history.filter(row => row.id >= from), ...witness]) union.set(row.id, row);
    const participants: Pid[] = [...new Set(actors.map(actor => actor.pid))].sort((a, b) => a - b);
    this.host.emit({ type: 'sync.race_detected', race: { tick: record.tick, participants, location: state.cell,
      interleaving: [...union.values()].sort((a, b) => a.id - b.id).map(row => format(state.cell, row)),
      expectedValue: state.serialValue, corruptedValue: value } });
  }
}

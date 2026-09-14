import type { ResourceId, SyscallResult } from '../types';
import { actorKey, check, integer, ok, sameActor, type Actor, type PrimitiveContext, type PrimitiveState } from './SyncSubsystem';

type Rwlock = Extract<PrimitiveState, { kind: 'rwlock' }>;
type Operation = 'rw_read_lock' | 'rw_read_unlock' | 'rw_write_lock' | 'rw_write_unlock';

export function createRwlock(id: ResourceId, capacity: number,
  policy: Rwlock['policy'] = 'writer_pref', displayName: string = id): Rwlock {
  if (!integer(capacity, 1)) throw new RangeError('invalid reader capacity');
  return { id, kind: 'rwlock', displayName, capacity, ordered: policy === 'fair', policy,
    writer: null, readers: [], waitQueue: [] };
}

/** Grant reservations before wake; cancellation can also call this admission pass. */
export function grantRwWaiters(ctx: PrimitiveContext, state: Rwlock): { state: Rwlock; granted: readonly Actor[] } {
  if (state.writer !== null || state.waitQueue.length === 0) return { state, granted: [] };
  const waits = state.waitQueue.map(generation => {
    const wait = ctx.wait(generation); check(wait !== undefined, 'rwlock queue references a missing wait'); return wait;
  });
  const writer = waits.find(wait => wait.operation.kind === 'rw_write');
  const reader = waits.find(wait => wait.operation.kind === 'rw_read');
  let selected: typeof waits = [];
  if (state.policy === 'writer_pref' && writer !== undefined) {
    if (state.readers.length === 0) selected = [writer];
  } else if (state.policy === 'reader_pref' && reader === undefined) {
    if (state.readers.length === 0 && writer !== undefined) selected = [writer];
  } else if (state.policy === 'fair' && waits[0]?.operation.kind === 'rw_write') {
    if (state.readers.length === 0) selected = [waits[0]];
  } else {
    let available = state.capacity - state.readers.length;
    for (const wait of waits) {
      if (wait.operation.kind !== 'rw_read') { if (state.policy === 'fair') break; continue; }
      if (available === 0) break;
      selected.push(wait); available -= 1;
    }
  }
  if (selected.length === 0) return { state, granted: [] };
  const generations = new Set(selected.map(wait => wait.generation));
  const first = selected[0]; check(first !== undefined, 'empty rwlock grant');
  const writing = first.operation.kind === 'rw_write';
  const next: Rwlock = { ...state, writer: writing ? first.actor : null,
    readers: writing ? [] : [...state.readers, ...selected.map(wait => wait.actor)],
    waitQueue: state.waitQueue.filter(generation => !generations.has(generation)) };
  ctx.set(next);
  for (const wait of selected) { ctx.enter(wait.actor, state.id); ctx.reserve(wait.generation); }
  return { state: next, granted: selected.map(wait => wait.actor) };
}

export function rwlockOperation(ctx: PrimitiveContext, state: Rwlock, actor: Actor, operation: Operation): SyscallResult {
  if (operation === 'rw_read_lock' || operation === 'rw_write_lock') {
    if (sameActor(state.writer, actor) || state.readers.some(reader => sameActor(reader, actor))) {
      return { ok: false, errno: 'EDEADLK', message: 'rwlock recursive acquisition and upgrades are unsupported' };
    }
    const hasWriter = state.waitQueue.some(generation => ctx.wait(generation)?.operation.kind === 'rw_write');
    const fairTurn = state.policy !== 'fair' || state.waitQueue.length === 0;
    const canRead = state.writer === null && state.readers.length < state.capacity && fairTurn
      && (state.policy === 'reader_pref' || !hasWriter);
    const canWrite = state.writer === null && state.readers.length === 0 && state.waitQueue.length === 0;
    if ((operation === 'rw_read_lock' && canRead) || (operation === 'rw_write_lock' && canWrite)) {
      ctx.set(operation === 'rw_read_lock' ? { ...state, readers: [...state.readers, actor] } : { ...state, writer: actor });
      ctx.enter(actor, state.id);
      ctx.emit({ type: 'sync.acquired', pid: actor.pid, resource: state.id, kind: 'rwlock' }); return ok();
    }
    if (!ctx.canBlock(actor)) return { ok: false, errno: 'EBUSY', message: 'blocking requires a running actor' };
    const generation = ctx.newWait(actor, state.id, { kind: operation === 'rw_read_lock' ? 'rw_read' : 'rw_write' });
    const queued = { ...state, waitQueue: [...state.waitQueue, generation] };
    ctx.set(queued); ctx.block(generation);
    ctx.emit({ type: 'sync.blocked', pid: actor.pid, resource: state.id, queueLength: queued.waitQueue.length });
    grantRwWaiters(ctx, queued); return ok();
  }
  const index = state.readers.findIndex(reader => sameActor(reader, actor));
  if (operation === 'rw_write_unlock' ? !sameActor(state.writer, actor) : index < 0) {
    return { ok: false, errno: 'EPERM', message: 'rwlock unlock requires a matching owner' };
  }
  ctx.flush(actor.pid);
  const released: Rwlock = operation === 'rw_write_unlock' ? { ...state, writer: null }
    : { ...state, readers: state.readers.filter((_, position) => position !== index) };
  ctx.set(released); ctx.leave(actor, state.id);
  const result = grantRwWaiters(ctx, released);
  ctx.emit({ type: 'sync.released', pid: actor.pid, resource: state.id, woke: result.granted[0]?.pid ?? null });
  return ok();
}

export function validateRwlock(state: Rwlock, ctx: PrimitiveContext): void {
  check(integer(state.capacity, 1) && ['reader_pref', 'writer_pref', 'fair'].includes(state.policy)
    && state.ordered === (state.policy === 'fair'), 'rwlock configuration');
  check(state.readers.length <= state.capacity && (state.writer === null || state.readers.length === 0), 'rwlock reader/writer exclusion');
  check(new Set(state.readers.map(actorKey)).size === state.readers.length, 'duplicate rwlock reader');
  check(new Set(state.waitQueue).size === state.waitQueue.length, 'duplicate rwlock waiter');
  let previous = -1;
  for (const generation of state.waitQueue) {
    const wait = ctx.wait(generation);
    check(integer(generation) && wait?.resource === state.id && ['rw_read', 'rw_write'].includes(wait.operation.kind), 'rwlock wait reference');
    check(!sameActor(state.writer, wait.actor) && !state.readers.some(reader => sameActor(reader, wait.actor)), 'rwlock owner waits on itself');
    if (state.policy === 'fair') check(generation > previous, 'fair rwlock ticket order');
    previous = generation;
  }
}

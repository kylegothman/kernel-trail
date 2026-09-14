import type { ResourceId, SyscallResult } from '../types';
import { check, integer, invalid, ok, sameActor, type Actor, type PrimitiveContext, type PrimitiveState } from './SyncSubsystem';

type Semaphore = Extract<PrimitiveState, { kind: 'semaphore' }>;

export function createSemaphore(ctx: Pick<PrimitiveContext, 'nextPermit'>, id: ResourceId, capacity: number,
  initialValue: number, ordered = true, displayName: string = id): Semaphore {
  if (!integer(capacity, 1) || !integer(initialValue) || initialValue > capacity) throw new RangeError('invalid semaphore capacity or initial value');
  return { id, kind: 'semaphore', displayName, capacity, ordered, initialValue, waitQueue: [],
    debits: Array.from({ length: capacity - initialValue }, () => ({ id: ctx.nextPermit(), actor: null })) };
}

export function semaphoreValue(state: Semaphore): number {
  return state.waitQueue.length > 0 ? -state.waitQueue.length : state.capacity - state.debits.length;
}

export function semaphoreOperation(ctx: PrimitiveContext, state: Semaphore, actor: Actor,
  operation: 'sem_wait' | 'sem_post'): SyscallResult {
  if (operation === 'sem_wait') {
    if (semaphoreValue(state) > 0) {
      ctx.set({ ...state, debits: [...state.debits, { id: ctx.nextPermit(), actor }] });
      ctx.enter(actor, state.id);
      ctx.emit({ type: 'sync.acquired', pid: actor.pid, resource: state.id, kind: 'semaphore' });
      return ok();
    }
    if (!ctx.canBlock(actor)) return { ok: false, errno: 'EBUSY', message: 'blocking requires a running actor' };
    const generation = ctx.newWait(actor, state.id, { kind: 'semaphore' });
    const waitQueue = [...state.waitQueue, generation];
    ctx.set({ ...state, waitQueue }); ctx.block(generation);
    ctx.emit({ type: 'sync.blocked', pid: actor.pid, resource: state.id, queueLength: waitQueue.length });
    return ok();
  }
  if (state.debits.length === 0) return invalid('semaphore post exceeds capacity');
  ctx.flush(actor.pid);
  let debitIndex = state.debits.findIndex(debit => sameActor(debit.actor, actor));
  if (debitIndex < 0) debitIndex = 0;
  const retired = state.debits[debitIndex];
  check(retired !== undefined, 'missing semaphore debit');
  const debits = state.debits.filter((_, index) => index !== debitIndex);
  const waitQueue = [...state.waitQueue];
  const index = state.ordered || waitQueue.length === 0 ? 0 : ctx.rng.int(0, waitQueue.length);
  const generation = waitQueue.splice(index, 1)[0];
  const waiter = generation === undefined ? undefined : ctx.wait(generation);
  check(generation === undefined || waiter !== undefined, 'semaphore queue references a missing wait');
  if (waiter !== undefined) debits.push({ id: ctx.nextPermit(), actor: waiter.actor });
  ctx.set({ ...state, debits, waitQueue });
  if (retired.actor !== null) ctx.leave(retired.actor, state.id);
  if (waiter !== undefined) { ctx.enter(waiter.actor, state.id); ctx.reserve(waiter.generation); }
  ctx.emit({ type: 'sync.released', pid: actor.pid, resource: state.id, woke: waiter?.actor.pid ?? null });
  return ok();
}

/** Cleanup keeps the permit unavailable; it only erases the departing actor. */
export function anonymizeSemaphoreActor(ctx: PrimitiveContext, state: Semaphore, actor: Actor): void {
  const released = state.debits.filter(debit => sameActor(debit.actor, actor));
  ctx.set({ ...state, debits: state.debits.map(debit => sameActor(debit.actor, actor) ? { ...debit, actor: null } : debit) });
  for (const _debit of released) ctx.leave(actor, state.id);
}

export function validateSemaphore(state: Semaphore, ctx: PrimitiveContext): void {
  check(integer(state.capacity, 1) && integer(state.initialValue) && state.initialValue <= state.capacity, 'semaphore configuration');
  check(state.debits.length <= state.capacity && (state.waitQueue.length === 0 || state.debits.length === state.capacity), 'semaphore conservation');
  check(new Set(state.debits.map(debit => debit.id)).size === state.debits.length && state.debits.every(debit => integer(debit.id)), 'semaphore debit IDs');
  check(new Set(state.waitQueue).size === state.waitQueue.length, 'duplicate semaphore waiter');
  for (const generation of state.waitQueue) {
    const wait = ctx.wait(generation);
    check(integer(generation) && wait?.resource === state.id && wait.operation.kind === 'semaphore', 'semaphore wait reference');
  }
}

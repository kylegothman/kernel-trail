import type { ResourceId, SyscallResult } from '../types';
import { check, integer, ok, sameActor, type Actor, type PrimitiveContext, type PrimitiveState } from './SyncSubsystem';

type Mutex = Extract<PrimitiveState, { kind: 'mutex' }>;

export function createMutex(id: ResourceId, displayName: string = id): Mutex {
  return { id, kind: 'mutex', displayName, capacity: 1, ordered: true, owner: null, entryQueue: [] };
}

export function mutexOperation(ctx: PrimitiveContext, state: Mutex, actor: Actor,
  operation: 'mutex_lock' | 'mutex_unlock'): SyscallResult {
  if (operation === 'mutex_lock') {
    if (sameActor(state.owner, actor)) return { ok: false, errno: 'EDEADLK', message: 'mutex is not recursive' };
    if (state.owner === null) {
      ctx.set({ ...state, owner: actor }); ctx.enter(actor, state.id);
      ctx.emit({ type: 'sync.acquired', pid: actor.pid, resource: state.id, kind: 'mutex' });
      return ok();
    }
    if (!ctx.canBlock(actor)) return { ok: false, errno: 'EBUSY', message: 'blocking requires a running actor' };
    const generation = ctx.newWait(actor, state.id, { kind: 'mutex' });
    const entryQueue = [...state.entryQueue, generation];
    ctx.set({ ...state, entryQueue }); ctx.block(generation);
    ctx.emit({ type: 'sync.blocked', pid: actor.pid, resource: state.id, queueLength: entryQueue.length });
    return ok();
  }
  if (!sameActor(state.owner, actor)) return { ok: false, errno: 'EPERM', message: 'mutex unlock requires its owner' };
  ctx.flush(actor.pid);
  const generation = state.entryQueue[0];
  const waiter = generation === undefined ? undefined : ctx.wait(generation);
  check(generation === undefined || waiter !== undefined, 'mutex queue references a missing wait');
  ctx.set({ ...state, owner: waiter?.actor ?? null, entryQueue: state.entryQueue.slice(1) });
  ctx.leave(actor, state.id);
  if (waiter !== undefined) { ctx.enter(waiter.actor, state.id); ctx.reserve(waiter.generation); }
  ctx.emit({ type: 'sync.released', pid: actor.pid, resource: state.id, woke: waiter?.actor.pid ?? null });
  return ok();
}

export function validateMutex(state: Mutex, ctx: PrimitiveContext): void {
  check(state.capacity === 1 && state.ordered, 'mutex configuration');
  check(new Set(state.entryQueue).size === state.entryQueue.length, 'duplicate mutex waiter');
  for (const generation of state.entryQueue) {
    const wait = ctx.wait(generation);
    check(integer(generation) && wait?.resource === state.id && wait.operation.kind === 'mutex', 'mutex wait reference');
    check(!sameActor(state.owner, wait.actor), 'mutex owner waits on itself');
  }
}

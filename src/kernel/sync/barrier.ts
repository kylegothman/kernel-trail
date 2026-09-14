import type { ResourceId, SyscallResult } from '../types';
import { actorKey, check, integer, ok, type Actor, type PrimitiveContext, type PrimitiveState } from './SyncSubsystem';

type Barrier = Extract<PrimitiveState, { kind: 'barrier' }>;

export function createBarrier(id: ResourceId, capacity: number, displayName: string = id): Barrier {
  if (!integer(capacity, 1)) throw new RangeError('invalid barrier capacity');
  return { id, kind: 'barrier', displayName, capacity, ordered: true, generation: 0, arrivals: [] };
}

export function barrierOperation(ctx: PrimitiveContext, state: Barrier, actor: Actor): SyscallResult {
  if (!ctx.canBlock(actor)) return { ok: false, errno: 'EBUSY', message: 'barrier requires a running actor' };
  ctx.flush(actor.pid);
  const generation = ctx.newWait(actor, state.id, { kind: 'barrier', barrierGeneration: state.generation });
  const arrivals = [...state.arrivals, generation];
  ctx.set({ ...state, arrivals }); ctx.block(generation);
  ctx.emit({ type: 'sync.blocked', pid: actor.pid, resource: state.id, queueLength: arrivals.length });
  if (arrivals.length === state.capacity) {
    const waiters = arrivals.map(id => ctx.wait(id));
    check(waiters.every(wait => wait !== undefined), 'barrier references a missing wait');
    ctx.set({ ...state, generation: state.generation + 1, arrivals: [] });
    for (const id of arrivals) ctx.reserve(id);
    ctx.emit({ type: 'sync.released', pid: actor.pid, resource: state.id, woke: null });
  }
  return ok();
}

export function validateBarrier(state: Barrier, ctx: PrimitiveContext): void {
  check(integer(state.capacity, 1) && integer(state.generation) && state.ordered, 'barrier configuration');
  check(state.arrivals.length < state.capacity && new Set(state.arrivals).size === state.arrivals.length, 'barrier arrivals');
  const actors: string[] = [];
  for (const generation of state.arrivals) {
    const wait = ctx.wait(generation);
    check(integer(generation) && wait?.resource === state.id && wait.operation.kind === 'barrier'
      && wait.operation.barrierGeneration === state.generation, 'barrier wait reference');
    actors.push(actorKey(wait.actor));
  }
  check(new Set(actors).size === actors.length, 'duplicate barrier actor');
}

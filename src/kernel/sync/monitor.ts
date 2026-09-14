import type { ResourceId, SyscallResult, SyncPrimitive, Pid } from '../types';
import { check, compareStrings, integer, invalid, ok, sameActor, type Actor, type PrimitiveContext, type PrimitiveState } from './SyncSubsystem';

type MonitorState = Extract<PrimitiveState, { kind: 'monitor' }>;

/** Live condition queues are separate from the monitor entry queue. */
export interface Monitor extends SyncPrimitive {
  readonly conditions: Map<string, Pid[]>;
  readonly signalDiscipline: 'signal_and_continue' | 'signal_and_wait';
}

export function monitorView(base: SyncPrimitive, state: MonitorState, ctx: PrimitiveContext): Monitor {
  return { ...base, signalDiscipline: state.signalDiscipline, conditions: new Map(state.conditions.map(condition =>
    [condition.name, condition.waitQueue.flatMap(generation => { const wait = ctx.wait(generation); return wait === undefined ? [] : [wait.actor.pid]; })])) };
}

export function refreshMonitorView(view: SyncPrimitive, state: MonitorState, ctx: PrimitiveContext): boolean {
  if (!isMonitor(view) || view.signalDiscipline !== state.signalDiscipline) return false;
  const next = monitorView(view, state, ctx);
  for (const key of view.conditions.keys()) if (!next.conditions.has(key)) view.conditions.delete(key);
  for (const [name, queue] of next.conditions) {
    const previous: unknown = view.conditions.get(name);
    if (Array.isArray(previous)) previous.splice(0, previous.length, ...queue);
    else view.conditions.set(name, queue);
  }
  return true;
}
function isMonitor(view: SyncPrimitive): view is Monitor {
  return view.kind === 'monitor' && 'conditions' in view && view.conditions instanceof Map && 'signalDiscipline' in view
    && (view.signalDiscipline === 'signal_and_continue' || view.signalDiscipline === 'signal_and_wait');
}

type Operation = 'monitor_enter' | 'monitor_exit' | 'cond_wait' | 'cond_signal' | 'cond_broadcast';

export function createMonitor(id: ResourceId, conditions: readonly string[] = [],
  signalDiscipline: MonitorState['signalDiscipline'] = 'signal_and_continue', displayName: string = id): MonitorState {
  if (new Set(conditions).size !== conditions.length || conditions.some(name => name.length === 0)) throw new RangeError('invalid monitor conditions');
  return { id, kind: 'monitor', displayName, capacity: 1, ordered: true, owner: null, signalDiscipline,
    entryQueue: [], conditions: [...conditions].sort(compareStrings).map(name => ({ name, waitQueue: [] })) };
}

function release(ctx: PrimitiveContext, state: MonitorState, actor: Actor): void {
  const generation = state.entryQueue[0];
  const waiter = generation === undefined ? undefined : ctx.wait(generation);
  check(generation === undefined || waiter !== undefined, 'monitor entry queue references a missing wait');
  ctx.set({ ...state, owner: waiter?.actor ?? null, entryQueue: state.entryQueue.slice(1) });
  ctx.leave(actor, state.id);
  if (waiter !== undefined) { ctx.enter(waiter.actor, state.id); ctx.reserve(waiter.generation); }
  ctx.emit({ type: 'sync.released', pid: actor.pid, resource: state.id, woke: waiter?.actor.pid ?? null });
}

export function monitorOperation(ctx: PrimitiveContext, state: MonitorState, actor: Actor,
  operation: Operation, condition?: string): SyscallResult {
  if (operation === 'monitor_enter') {
    if (sameActor(state.owner, actor)) return { ok: false, errno: 'EDEADLK', message: 'monitor is not recursive' };
    if (state.owner === null) {
      ctx.set({ ...state, owner: actor }); ctx.enter(actor, state.id);
      ctx.emit({ type: 'sync.acquired', pid: actor.pid, resource: state.id, kind: 'monitor' }); return ok();
    }
    if (!ctx.canBlock(actor)) return { ok: false, errno: 'EBUSY', message: 'blocking requires a running actor' };
    const generation = ctx.newWait(actor, state.id, { kind: 'monitor_entry' });
    const entryQueue = [...state.entryQueue, generation];
    ctx.set({ ...state, entryQueue }); ctx.block(generation);
    ctx.emit({ type: 'sync.blocked', pid: actor.pid, resource: state.id, queueLength: entryQueue.length }); return ok();
  }
  if (!sameActor(state.owner, actor)) return { ok: false, errno: 'EPERM', message: 'monitor operation requires its owner' };
  if (operation === 'monitor_exit') { ctx.flush(actor.pid); release(ctx, state, actor); return ok(); }
  const queue = state.conditions.find(item => item.name === condition);
  if (queue === undefined) return invalid('unknown monitor condition');
  if (operation === 'cond_wait') {
    if (!ctx.canBlock(actor)) return { ok: false, errno: 'EBUSY', message: 'blocking requires a running actor' };
    ctx.flush(actor.pid);
    const generation = ctx.newWait(actor, state.id, { kind: 'condition', condition: queue.name });
    const conditions = state.conditions.map(item => item === queue ? { ...item, waitQueue: [...item.waitQueue, generation] } : item);
    release(ctx, { ...state, conditions }, actor); ctx.block(generation);
    ctx.emit({ type: 'sync.blocked', pid: actor.pid, resource: state.id, queueLength: queue.waitQueue.length + 1 }); return ok();
  }
  if (queue.waitQueue.length === 0) return ok();
  if (operation === 'cond_broadcast') {
    ctx.set({ ...state, entryQueue: [...state.entryQueue, ...queue.waitQueue],
      conditions: state.conditions.map(item => item === queue ? { ...item, waitQueue: [] } : item) });
    return ok();
  }
  const generation = queue.waitQueue[0];
  const waiter = generation === undefined ? undefined : ctx.wait(generation);
  check(waiter !== undefined, 'condition queue references a missing wait');
  const conditions = state.conditions.map(item => item === queue ? { ...item, waitQueue: item.waitQueue.slice(1) } : item);
  if (state.signalDiscipline === 'signal_and_continue') {
    ctx.set({ ...state, conditions, entryQueue: [...state.entryQueue, waiter.generation] });
    return ok();
  }
  if (!ctx.canBlock(actor)) return { ok: false, errno: 'EBUSY', message: 'Hoare signal requires a running actor' };
  ctx.flush(actor.pid);
  const signaller = ctx.newWait(actor, state.id, { kind: 'monitor_entry' });
  ctx.set({ ...state, conditions, owner: waiter.actor, entryQueue: [...state.entryQueue, signaller] });
  ctx.leave(actor, state.id); ctx.enter(waiter.actor, state.id); ctx.reserve(waiter.generation); ctx.block(signaller);
  ctx.emit({ type: 'sync.released', pid: actor.pid, resource: state.id, woke: waiter.actor.pid });
  return ok();
}

export function validateMonitor(state: MonitorState, ctx: PrimitiveContext): void {
  check(state.capacity === 1 && state.ordered && ['signal_and_continue', 'signal_and_wait'].includes(state.signalDiscipline), 'monitor configuration');
  const names = state.conditions.map(condition => condition.name);
  check(new Set(names).size === names.length && names.every(name => name.length > 0), 'monitor condition names');
  const generations = [...state.entryQueue, ...state.conditions.flatMap(condition => condition.waitQueue)];
  check(new Set(generations).size === generations.length, 'duplicate monitor waiter');
  for (const generation of state.entryQueue) {
    const wait = ctx.wait(generation);
    check(integer(generation) && wait?.resource === state.id, 'monitor entry reference');
    check(wait.operation.kind === 'monitor_entry' || (wait.operation.kind === 'condition' && names.includes(wait.operation.condition)), 'monitor entry operation');
    check(!sameActor(state.owner, wait.actor), 'monitor owner waits for entry');
  }
  for (const condition of state.conditions) for (const generation of condition.waitQueue) {
    const wait = ctx.wait(generation);
    check(integer(generation) && wait?.resource === state.id && wait.operation.kind === 'condition'
      && wait.operation.condition === condition.name, 'monitor condition reference');
    check(!sameActor(state.owner, wait.actor), 'monitor owner is a condition waiter');
  }
}

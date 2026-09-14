import type { KernelImpl } from '../../Kernel';
import { instructionProgram } from '../../process/Program';
import { asPageId, asResourceId } from '../../types';
import type { SyncSnapshotScenario } from '../../types';
import { RETIRE, RETRY, check, sameActor } from '../SyncSubsystem';
import type { Actor, AttemptResult, ScenarioContext, SyncInstruction } from '../SyncSubsystem';

export type ReadersWritersState = Extract<SyncSnapshotScenario, { kind: 'readers_writers' }>;
export interface ReadersWritersOptions {
  readonly id?: string;
  readonly policy?: ReadersWritersState['policy'];
  readonly readers?: number;
  readonly readerTicks?: number;
  readonly writerTicks?: number;
  readonly readerIterations?: number | null;
  readonly writerIterations?: number | null;
}

export function executeReadersWriters(ctx: ScenarioContext, initial: ReadersWritersState, actor: Actor, step: number): AttemptResult {
  const row = initial.actors.find(value => sameActor(value.actor, actor));
  check(row !== undefined && step >= 0 && step <= 8, 'readers-writers actor or step');
  const reader = row.role === 'reader'; const semaphore = initial.bindings.kind === 'semaphores';
  if (step === 0) {
    if (row.waitStartedAt === null) ctx.setScenario({ ...initial, actors: initial.actors.map(value => sameActor(value.actor, actor) ? { ...value, waitStartedAt: ctx.tick() } : value) });
    const operation: SyncInstruction = initial.bindings.kind === 'semaphores'
      ? { op: 'sem_wait', resource: reader ? initial.bindings.mutex : initial.bindings.rwMutex }
      : { op: reader ? 'rw_read_lock' : 'rw_write_lock', resource: initial.bindings.rwlock };
    check(ctx.call(actor, operation).ok, 'readers-writers entry'); return RETIRE;
  }
  if (reader && initial.bindings.kind === 'semaphores') {
    const bindings = initial.bindings;
    if (step === 1 || step === 6) {
      const count = ctx.load(actor, bindings.readCountCell);
      check(ctx.store(actor, bindings.readCountCell, count + (step === 1 ? 1 : -1)), 'read-count store'); return RETIRE;
    }
    if (step === 2) {
      if (ctx.load(actor, bindings.readCountCell) === 1) check(ctx.call(actor, { op: 'sem_wait', resource: bindings.rwMutex }).ok, 'first-reader wait');
      return RETIRE;
    }
    if (step === 3 || step === 5 || step === 7 || step === 8) {
      if (step === 7 && ctx.load(actor, bindings.readCountCell) !== 0) return RETIRE;
      const resource = step === 7 ? bindings.rwMutex : bindings.mutex;
      check(ctx.call(actor, { op: step === 5 ? 'sem_wait' : 'sem_post', resource }).ok, 'reader semaphore protocol');
      return step === 8 ? finish(ctx, initial.id, actor) : RETIRE;
    }
  }
  const workStep = reader && semaphore ? 4 : 1;
  if (step === workStep) {
    const state = readersWritersState(ctx, initial.id); const current = state.actors.find(value => sameActor(value.actor, actor));
    check(current !== undefined, 'readers-writers work actor');
    if (current.waitStartedAt !== null) ctx.setScenario({ ...state,
      actors: state.actors.map(value => sameActor(value.actor, actor)
        ? { ...value, worstWait: Math.max(value.worstWait, ctx.tick() - (value.waitStartedAt ?? ctx.tick())), waitStartedAt: null } : value) });
    if (ctx.register(actor, 'rw.loaded') === 0) {
      ctx.setRegister(actor, 'rw.value', ctx.load(actor, initial.cell, !reader)); ctx.setRegister(actor, 'rw.loaded', 1);
    }
    if (ctx.register(actor, 'rw.workDone') === 0) {
      const work = ctx.work(actor, row.workTicks); if (!work.advance) return work;
      ctx.setRegister(actor, 'rw.workDone', 1);
    }
    if (!reader && !ctx.store(actor, initial.cell, ctx.register(actor, 'rw.value') + 1, true)) return RETRY;
    ctx.setRegister(actor, 'rw.loaded', 0); ctx.setRegister(actor, 'rw.workDone', 0); return RETIRE;
  }
  check(step === 2, 'readers-writers release step');
  const operation: SyncInstruction = initial.bindings.kind === 'semaphores'
    ? { op: 'sem_post', resource: initial.bindings.rwMutex }
    : { op: reader ? 'rw_read_unlock' : 'rw_write_unlock', resource: initial.bindings.rwlock };
  check(ctx.call(actor, operation).ok, 'readers-writers release');
  return finish(ctx, initial.id, actor);
}

function readersWritersState(ctx: ScenarioContext, id: string): ReadersWritersState {
  const state = ctx.scenario(id); check(state.kind === 'readers_writers', 'readers-writers kind'); return state;
}
function finish(ctx: ScenarioContext, id: string, actor: Actor): AttemptResult {
  const state = readersWritersState(ctx, id); const row = state.actors.find(value => sameActor(value.actor, actor));
  check(row !== undefined, 'readers-writers completion actor');
  const completedOperations = row.completedOperations + 1;
  const complete = row.iterationLimit !== null && completedOperations >= row.iterationLimit;
  ctx.setScenario({ ...state, actors: state.actors.map(value => sameActor(value.actor, actor)
    ? { ...value, completedOperations, outcome: complete ? 'completed' as const : 'active' as const } : value) });
  if (complete) { ctx.complete(actor.pid); return RETIRE; }
  return { advance: false, deferService: false, target: 0 };
}

export function createReadersWriters(kernel: KernelImpl, options: ReadersWritersOptions = {}): ReadersWritersState {
  const id = options.id ?? 'readers_writers'; const policy = options.policy ?? 'reader_pref';
  const readers = options.readers ?? 6; const readerTicks = options.readerTicks ?? 10; const writerTicks = options.writerTicks ?? 10;
  for (const value of [readers, readerTicks, writerTicks]) check(Number.isSafeInteger(value) && value > 0, 'readers-writers configuration');
  const sync = kernel.syncSubsystem; let bindings: ReadersWritersState['bindings'];
  if (policy === 'reader_pref') {
    const mutex = asResourceId(`${id}:mutex`); const rwMutex = asResourceId(`${id}:rw_mutex`); const readCountCell = `${id}:read_count`;
    sync.createSemaphore(mutex, 1, 1); sync.createSemaphore(rwMutex, 1, 1); sync.addControlCell(readCountCell, 0);
    bindings = { kind: 'semaphores', mutex, rwMutex, readCountCell };
  } else {
    const rwlock = asResourceId(`${id}:rwlock`); sync.createRwlock(rwlock, readers, policy); bindings = { kind: 'rwlock', rwlock };
  }
  const program = instructionProgram(Array.from({ length: 9 }, (_, step) => ({ kind: 'sync' as const, operation: { op: 'scenario' as const, scenario: id, step } })));
  const actors: ReadersWritersState['actors'][number][] = [];
  for (let index = 0; index <= readers; index++) {
    const reader = index < readers; const role = reader ? 'reader' : 'writer';
    const pid = kernel.spawn({ name: `${id}:${role}:${index}`, priority: 20, arrival: reader ? index * 3 : 5,
      burst: 1_000_000, service: 1_000_000, pages: 1 }, { program, serialFraction: 1 });
    const tid = kernel.process(pid)?.threads[0]; check(tid !== undefined, 'readers-writers TCB');
    const actor = { pid, tid }; sync.registerActor(actor, id); sync.setMemoryOrder(pid, false);
    actors.push({ actor, role, workTicks: reader ? readerTicks : writerTicks,
      iterationLimit: reader ? options.readerIterations ?? null : options.writerIterations === undefined ? 1 : options.writerIterations,
      completedOperations: 0, waitStartedAt: null, worstWait: 0, outcome: 'active' });
  }
  const first = actors[0]; check(first !== undefined, 'readers-writers initial actor');
  const pcb = kernel.process(first.actor.pid); check(pcb !== undefined, 'readers-writers backing space');
  const region = asResourceId(`${id}:value`); const cell = `region:${id}:data`;
  kernel.ipc.createSharedRegion({ id: region, space: pcb.addressSpaceId, pages: [asPageId(0)], attached: [], value: 0 }); sync.addRegionCell(cell, region);
  const state: ReadersWritersState = { kind: 'readers_writers', id, policy, cell, bindings, actors };
  sync.addScenario(state); return state;
}

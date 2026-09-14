import type { KernelImpl } from '../../Kernel';
import { instructionProgram } from '../../process/Program';
import type { Instruction } from '../../process/Program';
import { asResourceId } from '../../types';
import type { ResourceId, SyncSnapshotScenario } from '../../types';
import { RETIRE, check, sameActor } from '../SyncSubsystem';
import type { Actor, AttemptResult, ScenarioContext } from '../SyncSubsystem';

export type PhilosophersState = Extract<SyncSnapshotScenario, { kind: 'philosophers' }>;
export interface PhilosophersOptions {
  readonly id?: string;
  readonly solution?: PhilosophersState['solution'];
  /** Separate deterministic witness; ordinary comparisons use every RNG draw. */
  readonly monitorStarvationWitness?: boolean;
}

export function executePhilosophers(ctx: ScenarioContext, initial: PhilosophersState, actor: Actor, step: number): AttemptResult {
  const index = initial.actors.findIndex(value => sameActor(value.actor, actor));
  check(index >= 0 && index < 5 && Number.isSafeInteger(step) && step >= 0, 'philosopher actor or step');
  if (step === 0) return ctx.work(actor, () => ctx.rng.int(5, 15));
  if (initial.bindings.kind === 'monitor') return monitorStep(ctx, initial, actor, index, step);
  const bindings = initial.bindings; const room = initial.solution === 'room';
  const left = bindings.chopsticks[index]; const right = bindings.chopsticks[(index + 1) % 5];
  check(left !== undefined && right !== undefined, 'philosopher chopsticks');
  const reversed = initial.solution === 'asymmetric' && index % 2 === 1;
  const first = reversed ? right : left; const second = reversed ? left : right;
  if (step === 1) {
    makeHungry(ctx, initial.id, index);
    check(ctx.call(actor, { op: 'sem_wait', resource: room ? requireRoom(initial) : first }).ok, 'philosopher first acquisition'); return RETIRE;
  }
  if (step === 2 || room && step === 3) {
    check(ctx.call(actor, { op: 'sem_wait', resource: room && step === 2 ? first : second }).ok, 'philosopher second acquisition'); return RETIRE;
  }
  const eatStep = room ? 4 : 3;
  if (step === eatStep) return eat(ctx, initial.id, actor, index);
  if (step === eatStep + 1 || step === eatStep + 2) {
    const resource = room ? step === eatStep + 1 ? second : first : step === eatStep + 1 ? first : second;
    check(ctx.call(actor, { op: 'sem_post', resource }).ok, 'philosopher release');
    if (!room && step === eatStep + 2) makeThinking(ctx, initial.id, index); return RETIRE;
  }
  if (room && step === 7) {
    check(ctx.call(actor, { op: 'sem_post', resource: requireRoom(initial) }).ok, 'philosopher room release');
    makeThinking(ctx, initial.id, index); return RETIRE;
  }
  check(step === (room ? 8 : 6), 'philosopher remainder step'); return thinkAndRepeat(ctx, actor);
}

function requireRoom(state: PhilosophersState) {
  check(state.bindings.kind === 'chopsticks' && state.bindings.room !== null, 'philosopher room binding'); return state.bindings.room;
}
function getState(ctx: ScenarioContext, id: string): PhilosophersState {
  const state = ctx.scenario(id); check(state.kind === 'philosophers', 'philosopher scenario kind'); return state;
}
function makeHungry(ctx: ScenarioContext, id: string, index: number): void {
  const state = getState(ctx, id);
  ctx.setScenario({ ...state, actors: state.actors.map((row, position) => position === index
    ? { ...row, state: 'hungry' as const, hungrySince: row.hungrySince ?? ctx.tick() } : row) });
}
function makeThinking(ctx: ScenarioContext, id: string, index: number): void {
  const state = getState(ctx, id); ctx.setScenario({ ...state, actors: state.actors.map((row, position) => position === index ? { ...row, state: 'thinking' as const } : row) });
}
function grantEating(ctx: ScenarioContext, id: string, index: number): void {
  const state = getState(ctx, id);
  ctx.setScenario({ ...state, actors: state.actors.map((row, position) => position === index
    ? { ...row, state: 'eating' as const, hungrySince: null, worstWait: Math.max(row.worstWait, ctx.tick() - (row.hungrySince ?? ctx.tick())) } : row) });
}
function eat(ctx: ScenarioContext, id: string, actor: Actor, index: number): AttemptResult {
  const before = getState(ctx, id); if (before.actors[index]?.state !== 'eating') grantEating(ctx, id, index);
  const result = ctx.work(actor, () => ctx.register(actor, 'philosopher.eatTicks') || ctx.rng.int(5, 15));
  if (result.advance) {
    const state = getState(ctx, id); ctx.setScenario({ ...state, actors: state.actors.map((row, position) => position === index ? { ...row, meals: row.meals + 1 } : row) });
  }
  return result;
}
function thinkAndRepeat(ctx: ScenarioContext, actor: Actor): AttemptResult {
  const result = ctx.work(actor, () => ctx.register(actor, 'philosopher.thinkTicks') || ctx.rng.int(5, 15));
  return result.advance ? { advance: false, deferService: false, target: 2 } : result;
}

/** The monitor's test is indivisible while its caller owns the monitor lock. */
function testNeighbor(ctx: ScenarioContext, id: string, caller: Actor, index: number): void {
  const state = getState(ctx, id); check(state.bindings.kind === 'monitor', 'philosopher monitor binding');
  if (state.actors[index]?.state !== 'hungry' || state.actors[(index + 4) % 5]?.state === 'eating' || state.actors[(index + 1) % 5]?.state === 'eating') return;
  grantEating(ctx, id, index);
  const condition = state.bindings.conditions[index]; check(condition !== undefined, 'philosopher condition');
  check(ctx.call(caller, { op: 'cond_signal', monitor: state.bindings.monitor, condition }).ok, 'philosopher signal');
}
function monitorStep(ctx: ScenarioContext, initial: PhilosophersState, actor: Actor, index: number, step: number): AttemptResult {
  check(initial.bindings.kind === 'monitor' && step <= 12, 'philosopher monitor step'); const monitor = initial.bindings.monitor;
  if (step === 1 || step === 7) {
    if (step === 1) {
      const state = getState(ctx, initial.id); ctx.setScenario({ ...state, actors: state.actors.map((row, position) => position === index ? { ...row, hungrySince: ctx.tick() } : row) });
    }
    check(ctx.call(actor, { op: 'monitor_enter', resource: monitor }).ok, 'philosopher monitor enter'); return RETIRE;
  }
  if (step === 2) { makeHungry(ctx, initial.id, index); return RETIRE; }
  if (step === 3 || step === 9 || step === 10) {
    testNeighbor(ctx, initial.id, actor, step === 3 ? index : (index + (step === 9 ? 4 : 1)) % 5); return RETIRE;
  }
  if (step === 4) {
    if (getState(ctx, initial.id).actors[index]?.state !== 'eating') {
      const condition = initial.bindings.conditions[index]; check(condition !== undefined, 'philosopher own condition');
      check(ctx.call(actor, { op: 'cond_wait', monitor, condition }).ok, 'philosopher condition wait');
    }
    return RETIRE;
  }
  if (step === 5 || step === 11) { check(ctx.call(actor, { op: 'monitor_exit', resource: monitor }).ok, 'philosopher monitor exit'); return RETIRE; }
  if (step === 6) return eat(ctx, initial.id, actor, index);
  if (step === 8) { makeThinking(ctx, initial.id, index); return RETIRE; }
  check(step === 12, 'philosopher monitor remainder'); return thinkAndRepeat(ctx, actor);
}

export function createPhilosophers(kernel: KernelImpl, options: PhilosophersOptions = {}): PhilosophersState {
  const id = options.id ?? 'philosophers'; const solution = options.solution ?? 'naive'; const sync = kernel.syncSubsystem;
  check(!options.monitorStarvationWitness || solution === 'monitor', 'monitor witness solution');
  const rendezvous = asResourceId(`${id}:rendezvous`); sync.createBarrier(rendezvous, 5);
  let bindings: PhilosophersState['bindings'];
  if (solution === 'monitor') {
    const monitor = asResourceId(`${id}:monitor`); const conditions: [string, string, string, string, string] = ['self:0', 'self:1', 'self:2', 'self:3', 'self:4'];
    sync.createMonitor(monitor, conditions); bindings = { kind: 'monitor', monitor, conditions };
  } else {
    const stick = (index: number): ResourceId => asResourceId(`${id}:chopstick:${index}`);
    const chopsticks: [ResourceId, ResourceId, ResourceId, ResourceId, ResourceId] = [stick(0), stick(1), stick(2), stick(3), stick(4)];
    for (const chopstick of chopsticks) sync.createSemaphore(chopstick, 1, 1);
    const room = solution === 'room' ? asResourceId(`${id}:room`) : null; if (room !== null) sync.createSemaphore(room, 4, 4);
    bindings = { kind: 'chopsticks', chopsticks, room };
  }
  const actors: PhilosophersState['actors'][number][] = [];
  for (let index = 0; index < 5; index++) {
    const operations: Instruction[] = [
      { kind: 'sync', operation: { op: 'scenario', scenario: id, step: 0 } },
      { kind: 'sync', operation: { op: 'barrier_wait', resource: rendezvous } },
    ];
    // Witness actors 3 and 4 remain in a finite remainder while 0 and 2 overlap.
    if (options.monitorStarvationWitness && index >= 3) operations.push({ kind: 'sync', operation: { op: 'work', ticks: 100_000 } });
    const steps = solution === 'monitor' ? 12 : solution === 'room' ? 8 : 6;
    for (let step = 1; step <= steps; step++) operations.push({ kind: 'sync', operation: { op: 'scenario', scenario: id, step } });
    const pid = kernel.spawn({ name: `${id}:${index}`, priority: 20, arrival: 0, burst: 1_000_000, service: 1_000_000, pages: 1 },
      { program: instructionProgram(operations), serialFraction: 1 });
    const tid = kernel.process(pid)?.threads[0]; check(tid !== undefined, 'philosopher TCB');
    const actor = { pid, tid }; sync.registerActor(actor, id); sync.setMemoryOrder(pid, false);
    if (options.monitorStarvationWitness) {
      sync.setRegister(actor, 'philosopher.thinkTicks', 1);
      sync.setRegister(actor, 'philosopher.eatTicks', index === 2 ? 40 : 20);
    }
    actors.push({ actor, state: 'thinking', hungrySince: null, meals: 0, worstWait: 0 });
  }
  const state: PhilosophersState = { kind: 'philosophers', id, solution, rendezvous, bindings, actors }; sync.addScenario(state); return state;
}

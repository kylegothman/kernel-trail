import type { KernelImpl } from '../Kernel';
import { instructionProgram } from '../process/Program';
import type { Instruction, Program } from '../process/Program';
import { asPageId, asResourceId } from '../types';
import type { SyncSnapshotScenario } from '../types';
import { RETIRE, RETRY, check, sameActor } from './SyncSubsystem';
import type { Actor, AttemptResult, ScenarioContext } from './SyncSubsystem';

export type PetersonState = Extract<SyncSnapshotScenario, { kind: 'peterson' }>;
export interface PetersonOptions {
  readonly id?: string;
  readonly reordering?: boolean;
  readonly depth?: number;
  readonly fenced?: boolean;
}

/** Exactly six textbook entry/remainder lines, with an optional separate fence. */
export function executePeterson(ctx: ScenarioContext, state: PetersonState, actor: Actor, step: number): AttemptResult {
  const index = state.actors.findIndex(value => sameActor(value, actor));
  check((index === 0 || index === 1) && step >= 0 && step < 6, 'Peterson actor or step');
  const own = state.flagCells[index]; const other = state.flagCells[1 - index];
  check(own !== undefined && other !== undefined, 'Peterson flag binding');
  if (step === 0) return ctx.store(actor, own, 1) ? RETIRE : RETRY;
  if (step === 1) return ctx.store(actor, state.turnCell, 1 - index) ? RETIRE : RETRY;
  if (step === 2) {
    const waits = ctx.load(actor, other) !== 0 && ctx.load(actor, state.turnCell) === 1 - index;
    return waits ? ctx.spin(actor, state.requirement) : RETIRE;
  }
  if (step === 3) {
    if (ctx.register(actor, 'peterson.inside') === 0) {
      ctx.enter(actor, state.requirement); ctx.setRegister(actor, 'peterson.inside', 1);
      const latest = ctx.scenario(state.id); check(latest.kind === 'peterson', 'Peterson scenario kind');
      const entries: [number, number] = [...latest.entries]; entries[index] += 1;
      ctx.setScenario({ ...latest, entries });
    }
    if (ctx.register(actor, 'peterson.loaded') === 0) {
      ctx.setRegister(actor, 'peterson.value', ctx.load(actor, state.counterCell, true)); ctx.setRegister(actor, 'peterson.loaded', 1);
    }
    if (!ctx.store(actor, state.counterCell, ctx.register(actor, 'peterson.value') + 1, true)) return RETRY;
    ctx.setRegister(actor, 'peterson.loaded', 0); return RETIRE;
  }
  if (step === 4) {
    // Publishing flag=false releases the software lock after prior application writes.
    ctx.flush(actor.pid);
    if (!ctx.store(actor, own, 0)) return RETRY;
    ctx.leave(actor, state.requirement); ctx.setRegister(actor, 'peterson.inside', 0); return RETIRE;
  }
  return RETIRE;
}

export function createPeterson(kernel: KernelImpl, options: PetersonOptions = {}): PetersonState {
  const id = options.id ?? 'peterson'; const sync = kernel.syncSubsystem;
  const flagCells: [string, string] = [`${id}:flag:0`, `${id}:flag:1`]; const turnCell = `${id}:turn`;
  sync.addControlCell(flagCells[0], 0); sync.addControlCell(flagCells[1], 0); sync.addControlCell(turnCell, 0);
  const requirement = asResourceId(`${id}:critical`); sync.configureRequirement(requirement, 1, 'observe');
  const instructions: Instruction[] = [];
  for (let step = 0; step < 6; step++) {
    instructions.push({ kind: 'sync', operation: { op: 'scenario', scenario: id, step } });
    if (step === 1 && options.fenced) instructions.push({ kind: 'sync', operation: { op: 'mfence' } });
  }
  const source = instructionProgram(instructions);
  // Lookup has no side effects; the real TCB PC keeps the complete instruction count.
  const program: Program = Object.freeze({ length: source.length, referenceString: null,
    at: (index: number): Instruction => source.at(index % source.length) });
  const actors: Actor[] = [];
  for (let index = 0; index < 2; index++) {
    const pid = kernel.spawn({ name: `${id}:${index}`, priority: 20, arrival: 0, burst: 1_000_000, service: 1_000_000, pages: 1 }, { program, serialFraction: 1 });
    const tid = kernel.process(pid)?.threads[0]; check(tid !== undefined, 'Peterson TCB');
    const actor = { pid, tid }; actors.push(actor); sync.registerActor(actor, id);
    sync.setMemoryOrder(pid, options.reordering ?? false, options.depth ?? 2);
  }
  const first = actors[0]; const second = actors[1]; check(first !== undefined && second !== undefined, 'Peterson actor pair');
  const pcb = kernel.process(first.pid); check(pcb !== undefined, 'Peterson backing space');
  const region = asResourceId(`${id}:value`); const counterCell = `region:${id}:counter`;
  kernel.ipc.createSharedRegion({ id: region, space: pcb.addressSpaceId, pages: [asPageId(0)], attached: [], value: 0 }); sync.addRegionCell(counterCell, region);
  const state: PetersonState = { kind: 'peterson', id, actors: [first, second], flagCells, turnCell, counterCell, requirement,
    fenced: options.fenced ?? false, entries: [0, 0] };
  sync.addScenario(state); return state;
}

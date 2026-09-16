/**
 * WP-20 section 3 and scope correction W12: the script executor and the
 * three stand-in policies, behind one `Driver` interface the harness pumps.
 *
 * Every command a driver issues goes through `CommandBus.dispatch` with
 * `origin: { source: 'replay', legId }`, so the resulting `RunState.decisions`
 * is the shape a real session would produce and the run is replayable. The
 * runner's own verbs (crossings, depots, reclamation) write their own
 * `DecisionRecord`s (W7), so a scripted run is replayable without the script.
 *
 * `competent` is generic by construction: this module imports nothing from
 * `tests/legs/<leg_id>/`, asserted by the `competent is generic` scan.
 */
import { createRng } from '@kernel/rng';
import type { AllocationStrategy, ConvoyMemberId, DiskSchedulingId, KernelEvent, PageReplacementId, Rng, SchedulerId } from '@kernel/types';
import type { Command } from '@game/CommandBus';
import { AFFLICTION_TABLE } from '@game/afflictions/table';
import type { CrossingDef, CrossingResult } from '@game/crossing/Crossing';
import { quoteAll, type CrossingContext, type CrossingOption, type CrossingQuote } from '@game/crossing/options';
import type { DepotItemId, PurchaseResult } from '@game/depot/Depot';
import type { ReclamationResult, ReclamationTrace } from '@game/reclamation/Reclamation';
import type { ReplayKernel } from '@game/replay/types';
import type { AfflictionId, LegId, Pace, Rations, RunState } from '@game/types';
import { describeStep, isWhenStep, type DecisionScript, type ScriptStep, type ScriptTrigger } from './decisionScript';

export type PolicyName = 'passive' | 'competent' | 'chaotic';

/** What a driver may read and do at a fire slot. Actions run through the runner's verbs, never a reimplementation. */
export interface DriverContext {
  readonly legId: LegId;
  readonly tick: number;
  readonly kernel: ReplayKernel;
  readonly run: Readonly<RunState>;
  /** `bus.dispatch(command, { source: 'replay', legId })`; applied at the drain that follows. */
  dispatch(command: Command): void;
  /** Drain and observe the commands dispatched so far, so an action follows the commands declared before it. */
  flushCommands(): void;
  crossing(def: CrossingDef, option: CrossingOption): CrossingResult;
  depot(item: DepotItemId, target: ConvoyMemberId | null): PurchaseResult;
  reclamation(trace: ReclamationTrace): ReclamationResult;
  note(message: string): void;
}

export interface Driver {
  readonly name: string;
  /** The fire slot: immediately before the drain that precedes `tick`'s step. */
  beforeTick(ctx: DriverContext): void;
  /** After `postTick`, with the events captured for that tick. */
  afterTick(ctx: DriverContext, events: readonly KernelEvent[]): void;
  /** The option for a crossing the harness opened from `HarnessOptions.crossings` (ruling F3). */
  chooseCrossing(context: CrossingContext): CrossingOption;
  unfired(): readonly ScriptStep[];
}

interface StepState {
  readonly step: ScriptStep;
  fired: boolean;
  armed: boolean;
}

/** Executes a `DecisionScript` against a live runner through the driver context. */
export class ScriptedDecisions implements Driver {
  readonly name = 'script';
  private readonly states: StepState[];
  private readonly crossings: ReadonlyMap<string, CrossingDef>;
  private readonly eventCounts = new Map<string, number>();
  private primed = false;

  constructor(private readonly script: DecisionScript) {
    this.states = script.steps.map((step) => ({ step, fired: false, armed: false }));
    this.crossings = new Map((script.crossings ?? []).map((def) => [def.id, def]));
  }

  beforeTick(ctx: DriverContext): void {
    if (!this.primed) {
      this.primed = true;
      this.evaluateTriggers(ctx.run);
    }
    for (const state of this.states) {
      if (state.fired) continue;
      const step = state.step;
      if (isWhenStep(step)) {
        if (!state.armed) continue;
      } else if (step.at > ctx.tick) {
        continue;
      } else if (step.at < ctx.tick) {
        ctx.note(`${this.script.label}: ${describeStep(step)} fired at tick ${ctx.tick}; tick ${step.at} was passed inside an action`);
      }
      state.fired = true;
      this.fire(step, ctx);
    }
  }

  private fire(step: ScriptStep, ctx: DriverContext): void {
    if ('command' in step) {
      ctx.dispatch(step.command);
      return;
    }
    ctx.flushCommands();
    if ('crossing' in step) {
      const def = this.crossings.get(step.crossing);
      if (def === undefined) {
        ctx.note(`${this.script.label}: crossing ${step.crossing} is not declared; step skipped`);
        return;
      }
      ctx.crossing(def, step.option);
      return;
    }
    if ('depot' in step) {
      const purchase = ctx.depot(step.depot, step.target);
      if (!purchase.ok) ctx.note(`${this.script.label}: depot ${step.depot} refused: ${purchase.reason ?? 'no reason'}`);
      return;
    }
    ctx.reclamation(step.reclamation);
  }

  afterTick(ctx: DriverContext, events: readonly KernelEvent[]): void {
    for (const event of events) this.eventCounts.set(event.type, (this.eventCounts.get(event.type) ?? 0) + 1);
    this.evaluateTriggers(ctx.run);
  }

  private evaluateTriggers(run: Readonly<RunState>): void {
    for (const state of this.states) {
      if (state.fired || state.armed || !isWhenStep(state.step)) continue;
      if (this.holds(state.step.when, run)) state.armed = true;
    }
  }

  private holds(trigger: ScriptTrigger, run: Readonly<RunState>): boolean {
    switch (trigger.kind) {
      case 'event':
        return (this.eventCounts.get(trigger.type) ?? 0) >= ('nth' in trigger ? trigger.nth : 1);
      case 'integrity_below': {
        const member = run.convoy.find((candidate) => candidate.id === trigger.member);
        return member !== undefined && member.integrity < trigger.value;
      }
      case 'affliction':
        return run.convoy.some((member) => member.afflictions.some((affliction) => affliction.id === trigger.id));
      case 'progress_at_least':
        return run.legProgress >= trigger.value;
      case 'resource_below':
        if (trigger.resource === 'integrity') return run.convoy.some((member) => member.status !== 'derezzed' && member.integrity < trigger.value);
        return run.resources[trigger.resource] < trigger.value;
    }
  }

  chooseCrossing(): CrossingOption {
    return 'block';
  }

  unfired(): readonly ScriptStep[] {
    return this.states.filter((state) => !state.fired).map((state) => state.step);
  }
}

/* ------------------------------------------------------------------ */
/* The stand-in policies, architecture 11.5 and W12                     */
/* ------------------------------------------------------------------ */

const OPTIONS: readonly CrossingOption[] = ['spin', 'block', 'monitor', 'wait'];
const SCHEDULERS: readonly SchedulerId[] = ['fcfs', 'sjf', 'srtf', 'priority', 'priority_aging', 'rr', 'mlfq'];
const REPLACEMENTS: readonly PageReplacementId[] = ['fifo', 'lru', 'clock', 'optimal', 'lfu', 'random'];
const DISKS: readonly DiskSchedulingId[] = ['fcfs', 'sstf', 'scan', 'cscan', 'look', 'clook'];
const ALLOCATIONS: readonly AllocationStrategy[] = ['first_fit', 'best_fit', 'worst_fit', 'buddy'];
const PACES: readonly Pace[] = ['conservative', 'steady', 'aggressive', 'reckless'];
const RATIONS: readonly Rations[] = ['generous', 'standard', 'lean', 'starved'];
const QUANTA: readonly number[] = [1, 2, 4, 8, 16];
/** The chaotic rotation cadence, in ticks (section 3). */
export const CHAOTIC_PERIOD = 40;

/** Dispatches nothing; the convoy travels on its entry settings. A scheduled crossing blocks, the textbook default. */
export class PassivePolicy implements Driver {
  readonly name = 'passive';
  beforeTick(): void {}
  afterTick(): void {}
  chooseCrossing(): CrossingOption {
    return 'block';
  }
  unfired(): readonly ScriptStep[] {
    return [];
  }
}

function degreeCeiling(kernel: ReplayKernel): number {
  return kernel.memorySubsystem.pager.control.maximumDegree;
}

/** The cheapest viable option (W12): `successP` at least 0.9, cost `cycles + quota / 2`, else the highest `successP`. */
export function competentCrossingChoice(context: CrossingContext): CrossingOption {
  const quotes = quoteAll(context);
  const cost = (quote: CrossingQuote): number => quote.cyclesCost + quote.quotaCost / 2;
  const viable = OPTIONS.filter((option) => quotes[option].successP >= 0.9);
  if (viable.length > 0) return viable.reduce((best, option) => (cost(quotes[option]) < cost(quotes[best]) ? option : best));
  return OPTIONS.reduce((best, option) => (quotes[option].successP > quotes[best].successP ? option : best));
}

/**
 * Applies `AFFLICTION_TABLE` remedies to afflictions as bound Programs acquire
 * them, lowers the degree by one on `memory.thrashing` (never below 1, never
 * above the kernel ceiling), and takes the cheapest viable crossing option.
 */
export class CompetentPolicy implements Driver {
  readonly name = 'competent';
  private readonly known = new Map<ConvoyMemberId, Set<AfflictionId>>();

  beforeTick(): void {}

  afterTick(ctx: DriverContext, events: readonly KernelEvent[]): void {
    let degree: number | null = null;
    const current = ctx.run.policy.degreeOfMultiprogramming;
    const lower = (by: number): void => {
      const target = Math.min(degreeCeiling(ctx.kernel), Math.max(1, current - by));
      if (target !== current) degree = degree === null ? target : Math.min(degree, target);
    };
    if (events.some((event) => event.type === 'memory.thrashing')) lower(1);
    const issued = new Set<AfflictionId>();
    for (const member of ctx.run.convoy) {
      const seen = this.known.get(member.id) ?? new Set<AfflictionId>();
      for (const id of [...seen]) if (!member.afflictions.some((affliction) => affliction.id === id)) seen.delete(id);
      for (const affliction of member.afflictions) {
        if (seen.has(affliction.id)) continue;
        seen.add(affliction.id);
        if (issued.has(affliction.id)) continue;
        issued.add(affliction.id);
        const remedy = AFFLICTION_TABLE[affliction.id].remedy;
        switch (remedy.kind) {
          case 'set_scheduler':
            ctx.dispatch({ kind: 'set_scheduler', to: remedy.to });
            break;
          case 'set_replacement':
            ctx.dispatch({ kind: 'set_replacement', to: remedy.to });
            break;
          case 'set_disk_policy':
            ctx.dispatch({ kind: 'set_disk_policy', to: remedy.to });
            break;
          case 'set_allocation':
            ctx.dispatch({ kind: 'set_allocation', to: remedy.to });
            break;
          case 'adjust_quantum': {
            const view = ctx.kernel.invariantState();
            const quantum = view.schedulerParams.quantum;
            const next = remedy.direction === 'increase' ? quantum * 2 : Math.max(1, Math.floor(quantum / 2));
            ctx.dispatch({ kind: 'set_scheduler', to: view.schedulerId, quantum: next });
            break;
          }
          case 'reduce_degree':
            lower(remedy.by);
            break;
          case 'terminal':
          case 'spend':
          case 'ability':
            ctx.note(`competent: the ${remedy.kind} remedy for ${affliction.id} on ${member.id} is not issuable headlessly; skipped`);
            break;
        }
      }
      this.known.set(member.id, seen);
    }
    if (degree !== null) ctx.dispatch({ kind: 'set_degree', to: degree });
  }

  chooseCrossing(context: CrossingContext): CrossingOption {
    return competentCrossingChoice(context);
  }

  unfired(): readonly ScriptStep[] {
    return [];
  }
}

/**
 * Rotates the dials every 40 ticks from `createRng(seed, 'chaotic')`: the
 * scheduler and its quantum, pace, rations and degree, plus the replacement,
 * disk and allocation policies when the leg enables `vm`, `storage` or
 * `memory`. `optimal` is never chosen on an unscripted workload, because the
 * kernel refuses it with a `kernel.panic` in a dev build.
 */
export class ChaoticPolicy implements Driver {
  readonly name = 'chaotic';
  private readonly rng: Rng;
  private lastSlot = -1;

  constructor(seed: number) {
    this.rng = createRng(seed, 'chaotic');
  }

  beforeTick(ctx: DriverContext): void {
    const slot = Math.floor(ctx.tick / CHAOTIC_PERIOD);
    if (slot <= this.lastSlot) return;
    this.lastSlot = slot;
    const enabled = new Set(ctx.kernel.config.enabledSubsystems);
    ctx.dispatch({ kind: 'set_scheduler', to: this.rng.pick(SCHEDULERS), quantum: this.rng.pick(QUANTA) });
    ctx.dispatch({ kind: 'set_pace', to: this.rng.pick(PACES) });
    ctx.dispatch({ kind: 'set_rations', to: this.rng.pick(RATIONS) });
    ctx.dispatch({ kind: 'set_degree', to: this.rng.int(1, degreeCeiling(ctx.kernel) + 1) });
    if (enabled.has('vm')) {
      const choices = ctx.kernel.allProgramsScripted() ? REPLACEMENTS : REPLACEMENTS.filter((id) => id !== 'optimal');
      ctx.dispatch({ kind: 'set_replacement', to: this.rng.pick(choices) });
    }
    if (enabled.has('storage')) ctx.dispatch({ kind: 'set_disk_policy', to: this.rng.pick(DISKS) });
    if (enabled.has('memory')) ctx.dispatch({ kind: 'set_allocation', to: this.rng.pick(ALLOCATIONS) });
  }

  afterTick(): void {}

  chooseCrossing(): CrossingOption {
    return this.rng.pick(OPTIONS);
  }

  unfired(): readonly ScriptStep[] {
    return [];
  }
}

export function makePolicy(name: PolicyName, seed: number): Driver {
  switch (name) {
    case 'passive':
      return new PassivePolicy();
    case 'competent':
      return new CompetentPolicy();
    case 'chaotic':
      return new ChaoticPolicy(seed);
  }
}

/** A script when given, else the named policy, else passive. */
export function makeDriver(script: DecisionScript | undefined, policy: PolicyName | undefined, seed: number): Driver {
  if (script !== undefined) return new ScriptedDecisions(script);
  return makePolicy(policy ?? 'passive', seed);
}

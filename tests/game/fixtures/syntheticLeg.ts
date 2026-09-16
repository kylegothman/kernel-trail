/**
 * The synthetic test leg every WP-18 case runs (scope correction U13). It
 * implements the full frozen `Leg`, so the staged and the headless paths can
 * both run it, and its shape is what replay expects of a phase 2 leg:
 *
 *  - `kernelConfig(run)` returns a complete `KernelConfig` whose seed is
 *    `run.seed`; the replay overrides the seed with the request's anyway.
 *  - `populate(ctx)` spawns only through `ctx.spawn`, binds the five Programs
 *    through `ctx.bind` in `ConvoyMemberId` order, draws only from `ctx.rng`,
 *    and declares one resource and one sync primitive so both verbs are
 *    exercised.
 *  - `createStage` builds nothing that touches the simulation. A leg that
 *    breaks that rule fails the `headless equals staged` case.
 *  - `evaluate` reads the convoy, the snapshot and the tick count, never a
 *    clock.
 *  - `eventTable` is empty: random events are WP-19's through
 *    `ReplayHooks.beforeStep`, which the `hooks` option attaches.
 */
import type { ConvoyMemberId, KernelConfig } from '@kernel/types';
import type { ChapterRef, Leg, LegEvaluationContext, LegId, LegOutcome, LegSetupContext, StageContext } from '@game/types';
import { headlessOf, registerHeadlessLeg } from '../../../src/game/replay/headlessLegs';
import type { HeadlessLeg, ReplayHooks } from '../../../src/game/replay/types';

export const CONVOY_ROSTER: readonly ConvoyMemberId[] = ['lumen', 'sable', 'orrery', 'kestrel', 'vesper'];

/** A citation the curriculum already carries, in the form the cards test uses. */
export const SYNTHETIC_CHAPTER: ChapterRef = { chapter: 5, sections: [], title: 'CPU Scheduling' };

export interface SyntheticLegOptions {
  readonly id?: LegId;
  readonly index?: number;
  /** Workload processes beyond the five bound Programs. Default 6. */
  readonly processes?: number;
  /** Service ticks drawn per process, inclusive lower and exclusive upper bound. Default 40 to 120. */
  readonly service?: readonly [number, number];
  /** Reference strings on every process, so `allProgramsScripted()` holds and the optimal row applies. */
  readonly scripted?: boolean;
  readonly config?: Partial<KernelConfig>;
  /** Attached to the headless form by `syntheticHeadless` and `registerSynthetic`. */
  readonly hooks?: ReplayHooks;
  /** Observed by the `headless equals staged` case. */
  readonly onStage?: (ctx: StageContext) => void;
}

export function syntheticConfig(seed: number, patch: Partial<KernelConfig> = {}): KernelConfig {
  return {
    seed,
    scheduler: 'rr',
    schedulerParams: { quantum: 4, levelQuanta: [4, 8, 16], agingInterval: 50, starvationThreshold: 120, starvationFatalThreshold: 300, preemptive: true },
    totalFrames: 64,
    pageSize: 4096,
    replacementPolicy: 'lru',
    allocationStrategy: 'first_fit',
    tlbEntries: 16,
    diskPolicy: 'look',
    totalCylinders: 200,
    raidLevel: 5,
    fileAllocation: 'indexed',
    journalingEnabled: true,
    deadlockStrategy: 'detect',
    thrashingThreshold: 200,
    enabledSubsystems: ['process', 'scheduler', 'memory', 'vm', 'sync', 'deadlock', 'storage', 'io', 'fs', 'security'],
    ...patch,
  };
}

/** A deterministic reference string over `pages` pages, one access per service tick. */
function references(service: number, pages: number, salt: number): number[] {
  return Array.from({ length: service }, (_, k) => (k * 7 + salt * 3) % pages);
}

export function createSyntheticLeg(options: SyntheticLegOptions = {}): Leg {
  const id = options.id ?? 'boot_sector';
  const index = options.index ?? 0;
  const workload = options.processes ?? 6;
  const [lo, hi] = options.service ?? [40, 120];
  const scripted = options.scripted === true;
  return {
    id,
    index,
    title: 'Synthetic leg',
    subtitle: 'A fixture for the replay suite',
    chapters: [SYNTHETIC_CHAPTER],
    objectives: [],
    kernelConfig: (run) => syntheticConfig(run.seed, options.config),
    populate(ctx: LegSetupContext): void {
      CONVOY_ROSTER.forEach((member, i) => {
        const service = ctx.rng.int(lo, hi);
        const burst = ctx.rng.int(3, 9);
        const pid = ctx.spawn({ name: member, priority: 10 + i, burst, service, arrival: i * 2, pages: 6, ...(scripted ? { referenceString: references(service, 6, i) } : {}) });
        ctx.bind(member, pid);
      });
      for (let w = 0; w < workload; w++) {
        const service = ctx.rng.int(lo, hi);
        const burst = ctx.rng.int(2, 6);
        ctx.spawn({ name: `w${w}`, priority: 20 + (w % 5), burst, service, arrival: 5 + w * 3, pages: 4, ...(scripted ? { referenceString: references(service, 4, w + 5) } : {}) });
      }
      ctx.declareResource('printer', 1, false);
      ctx.declareSync('vault', 'mutex', 1);
    },
    createStage(ctx) {
      options.onStage?.(ctx);
      return { update: () => undefined, anchor: () => null, dispose: () => undefined };
    },
    interactions: [],
    terminalCommands: [],
    eventTable: [],
    evaluate(ctx: LegEvaluationContext): LegOutcome {
      const casualties = ctx.run.convoy.filter((m) => m.status === 'derezzed').map((m) => m.id);
      const survived = casualties.length === 0;
      return {
        survived,
        objectivesMet: survived ? ['synthetic.survive'] : [],
        casualties,
        resourceDelta: { cycles: -ctx.ticksElapsed },
        codexUnlocked: survived ? [] : ['codex.synthetic_loss'],
        debrief: {
          headline: survived ? 'The convoy crossed the synthetic leg' : 'The synthetic leg took a Program',
          whatHappened: `${ctx.ticksElapsed} ticks elapsed and ${ctx.events.length} events were logged.`,
          whyItHappened: `The snapshot ended at tick ${String(ctx.kernelSnapshot.tick)}.`,
          counterfactual: null,
          chapter: SYNTHETIC_CHAPTER,
        },
      };
    },
  };
}

export function syntheticHeadless(options: SyntheticLegOptions = {}): HeadlessLeg {
  return headlessOf(createSyntheticLeg(options), options.hooks);
}

/** Install the synthetic leg under its id; returns the undo that puts the phase 2 stub back. */
export function registerSynthetic(options: SyntheticLegOptions = {}): () => void {
  return registerHeadlessLeg(options.id ?? 'boot_sector', () => syntheticHeadless(options));
}

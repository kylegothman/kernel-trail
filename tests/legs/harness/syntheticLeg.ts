/**
 * WP-20 scope correction W8: the composite synthetic leg the harness's own
 * suite runs, built over `tests/game/fixtures/syntheticLeg.ts`. It is small,
 * complete and exercises every path: two objectives, one crossing, one
 * depot visit (it takes `fork_fields`, a `DEPOT_LEGS` member), one
 * reclamation round, an event table summing to 100, three interactions
 * whose anchors the synthetic stage resolves, and a known-good and a
 * known-bad script. It keeps the base fixture's config, every subsystem
 * enabled, so a run emits a realistic event volume and the reclamation
 * Verge is generated at zero external fragmentation.
 *
 * The known-bad path fails by arithmetic rather than by a roll: starved
 * rations drain 1.0 integrity per tick, the `gate_overclock` interaction
 * costs LUMEN 90, and a `wait` crossing then simulates enough ticks for the
 * drain to reach zero, so the crossing record is marked `fatal` and LUMEN's
 * tombstone reads `starvation` on every seed.
 *
 * WP-21 section 6: the leg ships a `content` companion, `HARNESS_CONTENT`,
 * carrying its crossing, a handler per interaction and a layout whose
 * anchors are the three interaction anchors, and its stage is
 * `layoutStage` over that layout.
 */
import type { LegId, Leg, LegEvaluationContext, LegOutcome, InteractionDef, RandomEventDef, LearningObjective } from '@game/types';
import type { CrossingDef } from '@game/crossing/Crossing';
import type { LegContent } from '@legs/content';
import { layoutStage } from '@legs/layout';
import { createSyntheticLeg, SYNTHETIC_CHAPTER, type SyntheticLegOptions } from '../../game/fixtures/syntheticLeg';
import type { DecisionScript } from './decisionScript';
import type { OutcomeExpectation } from './expectOutcome';
import { rememberContent } from './loadLeg';

export const HARNESS_LEG_ID: LegId = 'fork_fields';
export const HARNESS_LEG_INDEX = 1;
export { FIXTURE_SEED } from './fixtureContract';

export const HARNESS_ANCHORS: readonly string[] = ['vault', 'console', 'gate'];
export const HARNESS_OBJECTIVE_IDS: readonly string[] = ['synthetic.survive', 'synthetic.cross'];

export const HARNESS_CROSSING: CrossingDef = {
  id: 'vault_gate', legId: HARNESS_LEG_ID, lockId: 'vault', kind: 'mutex', ordered: true, anchor: 'vault', crosser: 'lumen',
};

const OBJECTIVES: readonly LearningObjective[] = [
  { id: 'synthetic.survive', statement: 'bring every Program through the leg', chapter: SYNTHETIC_CHAPTER, assessedBy: 'survival' },
  { id: 'synthetic.cross', statement: 'cross the vault gate without losing a Program', chapter: SYNTHETIC_CHAPTER, assessedBy: 'decision' },
];

/** Weights 40, 30, 20 and 10, summing to exactly 100 (section 6, event table). */
export const HARNESS_EVENT_TABLE: readonly RandomEventDef[] = [
  { id: 'quota_windfall', weight: 40, title: 'Quota windfall', narration: 'A freed page run lands in the convoy quota.', targets: null, inflicts: null, resourceDelta: { quota: 8 }, onlyIf: null },
  { id: 'cycle_tax', weight: 30, title: 'Cycle tax', narration: 'A spurious interrupt storm taxes the cycle budget.', targets: null, inflicts: null, resourceDelta: { cycles: -3 }, onlyIf: null },
  { id: 'cache_gust', weight: 20, title: 'Cache gust', narration: 'A gust of evictions leaves one Program thrashing its cache.', targets: null, inflicts: 'cache_thrash', resourceDelta: {}, onlyIf: null },
  { id: 'sentinel_relay', weight: 10, title: 'Sentinel relay', narration: 'The sentinel relays a spare block cache from the far shore.', targets: 'sentinel', inflicts: null, resourceDelta: { blocks: 2 }, onlyIf: (run) => run.legProgress > 0.5 },
];

export const HARNESS_INTERACTIONS: readonly InteractionDef[] = [
  { id: 'vault_inspect', label: 'Inspect the vault', description: 'Read the lock state.', anchor: 'vault', cost: { cycles: 2 }, enabledWhen: () => true },
  { id: 'console_query', label: 'Query the console', description: 'Ask the console for the queue.', anchor: 'console', cost: { bandwidth: 1 }, enabledWhen: () => true },
  { id: 'gate_overclock', label: 'Overclock the gate', description: 'Push a Program through the gate at a cost to its integrity.', anchor: 'gate', cost: { integrity: 90 }, enabledWhen: () => true },
];

/** The companion (WP-21 section 6): every anchor is an interaction anchor, so `extras` is empty; `gate_overclock` lands its integrity cost on LUMEN. */
export const HARNESS_CONTENT: LegContent = {
  legId: HARNESS_LEG_ID,
  crossings: [HARNESS_CROSSING],
  interactions: {
    vault_inspect: { run: () => undefined, target: null },
    console_query: { run: () => undefined, target: null },
    gate_overclock: { run: () => undefined, target: 'lumen' },
  },
  epitaphs: [],
  codex: [],
  terminalHandlers: {},
  layout: {
    anchors: [
      { id: 'vault', kind: 'frame_vault', position: [0, 0, -8], label: 'The vault' },
      { id: 'console', kind: 'stele', position: [4, 0, 0], facing: [0, 0, 1], label: 'The console' },
      { id: 'gate', kind: 'beam', position: [-4, 0, 6], label: 'The gate' },
    ],
    cameraTargets: ['vault', 'gate'],
    extras: [],
  },
};

export interface HarnessLegOptions extends SyntheticLegOptions {
  /** Observed by the `no stage` and anchor cases. */
  readonly onDispose?: () => void;
}

export function createHarnessLeg(options: HarnessLegOptions = {}): Leg {
  const base = createSyntheticLeg({ id: HARNESS_LEG_ID, index: HARNESS_LEG_INDEX, ...options });
  const leg: Leg = {
    ...base,
    title: 'Synthetic harness leg',
    subtitle: 'The composite fixture the smoke-test harness proves itself on',
    objectives: OBJECTIVES,
    eventTable: HARNESS_EVENT_TABLE,
    interactions: HARNESS_INTERACTIONS,
    createStage(ctx) {
      options.onStage?.(ctx);
      const stage = layoutStage(HARNESS_CONTENT.layout);
      return { ...stage, dispose: () => { stage.dispose(); options.onDispose?.(); } };
    },
    evaluate(ctx: LegEvaluationContext): LegOutcome {
      const casualties = ctx.run.convoy.filter((member) => member.status === 'derezzed').map((member) => member.id);
      const crossed = ctx.run.decisions.some((record) => record.legId === HARNESS_LEG_ID && record.kind === 'crossing' && record.outcome !== 'fatal');
      const objectivesMet = [...(casualties.length === 0 ? ['synthetic.survive'] : []), ...(crossed ? ['synthetic.cross'] : [])];
      return {
        survived: casualties.length < ctx.run.convoy.length,
        objectivesMet,
        casualties,
        resourceDelta: { cycles: -Math.floor(ctx.ticksElapsed / 10) },
        codexUnlocked: casualties.length === 0 ? [] : ['codex.synthetic_loss'],
        debrief: {
          headline: casualties.length === 0 ? 'The convoy crossed the synthetic leg' : 'The synthetic leg took a Program',
          whatHappened: `${ctx.ticksElapsed} ticks elapsed and ${ctx.events.length} events were logged.`,
          whyItHappened: `The snapshot ended at tick ${String(ctx.kernelSnapshot.tick)}.`,
          counterfactual: null,
          chapter: SYNTHETIC_CHAPTER,
        },
      };
    },
  };
  rememberContent(leg, HARNESS_CONTENT);
  return leg;
}

/** The first leaked block of the Verge at zero fragmentation: 20 fragments precede the leaked blocks (narrative 11.6 at F = 0). */
export const FIRST_LEAKED_BLOCK = 20;

export const KNOWN_GOOD_SCRIPT: DecisionScript = {
  legId: HARNESS_LEG_ID,
  label: 'synthetic known-good',
  crossings: [HARNESS_CROSSING],
  interactions: [{ id: 'vault_inspect', target: null }],
  steps: [
    { at: 5, command: { kind: 'set_pace', to: 'steady' } },
    { at: 10, command: { kind: 'interaction', id: 'vault_inspect', anchor: 'vault' } },
    { at: 15, crossing: 'vault_gate', option: 'block' },
    { at: 46, depot: 'quota_lot', target: null },
    { at: 50, reclamation: [{ atSeconds: 3, action: 'collect', blockId: FIRST_LEAKED_BLOCK }] },
    { when: { kind: 'progress_at_least', value: 0.5 }, command: { kind: 'set_rations', to: 'generous' } },
  ],
};

export const KNOWN_GOOD_EXPECTATION: OutcomeExpectation = {
  survived: true,
  objectivesMet: HARNESS_OBJECTIVE_IDS,
  casualties: [],
  eventTypesAbsent: ['kernel.panic'],
  debrief: { chapter: { chapter: SYNTHETIC_CHAPTER.chapter, sections: SYNTHETIC_CHAPTER.sections } },
};

export const KNOWN_BAD_SCRIPT: DecisionScript = {
  legId: HARNESS_LEG_ID,
  label: 'synthetic known-bad',
  crossings: [HARNESS_CROSSING],
  interactions: [{ id: 'gate_overclock', target: 'lumen' }],
  steps: [
    { at: 2, command: { kind: 'set_rations', to: 'lean' } },
    { at: 4, command: { kind: 'interaction', id: 'gate_overclock', anchor: 'gate' } },
    { at: 6, crossing: 'vault_gate', option: 'wait' },
  ],
};

export const KNOWN_BAD_EXPECTATION: OutcomeExpectation = {
  survived: true,
  casualties: ['lumen'],
  casualtyCount: 1,
  objectivesMet: [],
  decisionOutcomes: [{ kind: 'crossing', outcome: 'fatal' }],
  ticksBetween: [40, 400],
  eventTypesPresent: ['process.exited'],
  eventTypesAbsent: ['kernel.panic'],
};

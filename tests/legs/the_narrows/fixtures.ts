/**
 * WP-L04: the Narrows' two fixtures.
 *
 * The known-good path is a playthrough that reads the ledger post, sees the
 * number disagree with the convoy, and fixes the protocol: it spins across the
 * cheap plank, swaps the test-then-set for compare-and-swap on the first race
 * and proves it with a replay, marks the guarded region, pays the monitor toll
 * at the second ford, sets the ford count to the width of the ford, blocks
 * across it, and enables inheritance the moment the inversion lands. It also
 * treats the afflictions the event deck deals, which is what keeps SABLE
 * standing: at two points it takes the aging policy and comes straight back to
 * round robin, which clears a starvation and, with the wider quantum, the lock
 * convoy behind the manifest.
 *
 * The known-bad path spins at every section, never marks anything, never
 * swaps the primitive and never enables inheritance, and ends by sitting down
 * to wait at the ford it should have blocked on. SABLE dies inside that wait.
 *
 * The entering ledger is Quantum Pass's golden closing ledger, as the
 * comment beside the constant says; until WP-23 it was the analytical curve
 * of narrative 5.5 (1328 cycles), and the balance ledger's continuity test
 * caught the difference on its first run.
 */
import { FIXTURE_SEED, type LegFixture } from '../harness/fixtureContract';
import type { DecisionScript, ScriptStep } from '../harness/decisionScript';
import { content } from '@legs/the_narrows';
import { PLANK, SECOND_FORD, WIDE_FORD, WIDE_FORD_3 } from '@legs/the_narrows/crossings';
import { GUARDED_REGION } from '@legs/the_narrows/ledger';
import { OBJECTIVE_IDS } from '@legs/the_narrows/objectives';
import { CODEX_IDS } from '@legs/the_narrows/copy';

/** Quantum Pass's good-path golden closing ledger, tests/golden/balance.json quantum_pass.good.closingLedger, re-sourced by WP-23 from the narrative 5.5 curve (1328 cycles) once the balance ledger's continuity test found the two apart. */
const ENTERING = { cycles: 1439.2, quota: 725, blocks: 120, bandwidth: 72 };

/** The smallest region containing every access to the far post, as the player would type it. */
const MARK = `lock --mark ${GUARDED_REGION.first} ${GUARDED_REGION.last}`;

const GOOD_STEPS: readonly ScriptStep[] = [
  { at: 4, command: { kind: 'interaction', id: 'narrows.read_stone', anchor: 'anchor.peterson_stone' } },
  { at: 8, command: { kind: 'interaction', id: 'narrows.cross_spin', anchor: 'anchor.turnstile' } },
  { at: 10, crossing: PLANK, option: 'spin' },
  // The three moves the first race earns, in the order the man pages teach them.
  { when: { kind: 'event', type: 'sync.race_detected' }, command: { kind: 'terminal', line: 'race --show 1' } },
  { when: { kind: 'event', type: 'sync.race_detected' }, command: { kind: 'interaction', id: 'narrows.use_cas', anchor: 'anchor.plank' } },
  { when: { kind: 'event', type: 'sync.race_detected' }, command: { kind: 'terminal', line: 'trace --replay 1' } },
  // The aging policy clears a starvation and coming back with a wider quantum
  // clears the convoy behind the manifest. Both are fixed ticks rather than
  // triggers, because a fixture may not contain a step that never fires.
  { at: 30, command: { kind: 'set_scheduler', to: 'priority_aging' } },
  { at: 32, command: { kind: 'set_scheduler', to: 'rr', quantum: 12 } },
  { at: 40, command: { kind: 'terminal', line: MARK } },
  { at: 44, command: { kind: 'interaction', id: 'narrows.cross_monitor', anchor: 'anchor.turnstile' } },
  { at: 46, crossing: SECOND_FORD, option: 'monitor' },
  { at: 56, command: { kind: 'set_scheduler', to: 'priority_aging' } },
  { at: 58, command: { kind: 'set_scheduler', to: 'rr', quantum: 16 } },
  { at: 60, command: { kind: 'interaction', id: 'narrows.set_capacity', anchor: 'anchor.wide_ford' } },
  { at: 64, command: { kind: 'interaction', id: 'narrows.cross_block', anchor: 'anchor.turnstile' } },
  { at: 66, crossing: WIDE_FORD_3, option: 'block' },
  { when: { kind: 'affliction', id: 'priority_inversion' }, command: { kind: 'interaction', id: 'narrows.toggle_inheritance', anchor: 'anchor.inheritance_toggle' } },
];

const BAD_STEPS: readonly ScriptStep[] = [
  { at: 10, command: { kind: 'interaction', id: 'narrows.cross_spin', anchor: 'anchor.turnstile' } },
  { at: 12, crossing: PLANK, option: 'spin' },
  { at: 40, crossing: SECOND_FORD, option: 'spin' },
  { at: 56, command: { kind: 'interaction', id: 'narrows.cross_wait', anchor: 'anchor.turnstile' } },
  { at: 58, crossing: WIDE_FORD, option: 'wait' },
];

/** Every script that steps through a crossing carries the companion's list: `validateScript` is static and does not read the companion. */
const script = (label: string, steps: readonly ScriptStep[]): DecisionScript => ({
  legId: 'the_narrows', label, crossings: content.crossings, steps,
});

export const knownGood: LegFixture = {
  legId: 'the_narrows',
  path: 'good',
  failureMode: 'casualty',
  seed: FIXTURE_SEED,
  discClass: 'shell',
  difficulty: 'operator',
  pace: 'steady',
  rations: 'standard',
  enteringLedger: ENTERING,
  enteringDecisions: [],
  script: script('the narrows known-good', GOOD_STEPS),
  expect: {
    survived: true,
    objectivesMet: OBJECTIVE_IDS,
    casualties: [],
    codexUnlocked: CODEX_IDS,
    ticksBetween: [80, 160],
    eventTypesPresent: ['sync.acquired', 'sync.blocked', 'sync.race_detected'],
    eventTypesAbsent: ['kernel.panic', 'deadlock.detected'],
    debrief: { chapter: { chapter: 6, sections: ['6.2'] }, headlineMatches: /Narrows|manifest/ },
  },
};

export const knownBad: LegFixture = {
  legId: 'the_narrows',
  path: 'bad',
  failureMode: 'casualty',
  seed: FIXTURE_SEED,
  discClass: 'shell',
  difficulty: 'operator',
  pace: 'steady',
  rations: 'standard',
  enteringLedger: ENTERING,
  enteringDecisions: [],
  script: script('the narrows known-bad', BAD_STEPS),
  expect: {
    survived: true,
    casualties: ['sable'],
    casualtyCount: 1,
    objectivesMet: [],
    decisionOutcomes: [{ kind: 'crossing', outcome: 'fatal' }],
    ticksBetween: [90, 180],
    eventTypesPresent: ['sync.race_detected', 'process.exited'],
    eventTypesAbsent: ['kernel.panic', 'deadlock.detected'],
    debrief: { headlineMatches: /manifest is wrong/, counterfactualPresent: true },
  },
};

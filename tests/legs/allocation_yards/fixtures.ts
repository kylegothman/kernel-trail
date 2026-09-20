/**
 * WP-L07: the Allocation Yards' known-good and known-bad fixtures.
 *
 * Neither script carries an `interactions` list. A script that names one
 * replaces the leg's own handler for that id with a no-op (scope correction
 * section 7), and this leg's handlers are its only write channel: they settle
 * the fuse, the wrong remedy and the hand-off record. The companion's
 * handlers are applied at entry and are what these scripts exercise.
 *
 * The entering ledger is analytical, not a golden: leg 6 has not shipped. It
 * is the curve of narrative 5.5 as `tests/game/economyCurve.test.ts` computes
 * it, which puts the shell at operator into the Yards with 1022 cycles
 * (scope correction section 9). Quota, blocks and bandwidth are the starting
 * ledger, and bandwidth is refilled at entry in any case. Replace the cycles
 * figure with leg 6's golden closing ledger when the Gridlock lands.
 */
import type { LegFixture } from '../harness/fixtureContract';
import { FIXTURE_SEED } from '../harness/fixtureContract';
import type { DecisionScript } from '../harness/decisionScript';
import type { OutcomeExpectation } from '../harness/expectOutcome';

/** The entering ledger is analytical, not a golden: leg 6 has not shipped. It is the curve of narrative 5.5 as tests/game/economyCurve.test.ts computes it, which puts the shell at operator into the Yards with 1022 cycles (scope correction section 9). */
const ENTERING_LEDGER = { cycles: 1022, quota: 900, blocks: 120, bandwidth: 60 } as const;

/**
 * The package's known-good sequence. It reads the refusal before it spends,
 * compacts once, converts, sizes the page, answers the gate on its one
 * attempt, clears the executable bit before the injection, takes the
 * contiguous route and buys no entries.
 */
const GOOD: DecisionScript = {
  legId: 'allocation_yards',
  label: 'allocation_yards known-good',
  steps: [
    { at: 2, command: { kind: 'terminal', line: 'free -f' } },
    { at: 4, command: { kind: 'terminal', line: 'frag --compare' } },
    { at: 6, command: { kind: 'set_allocation', to: 'best_fit' } },
    { at: 8, command: { kind: 'interaction', id: 'yards.compact', anchor: 'anchor.compaction_crew' } },
    { at: 20, command: { kind: 'interaction', id: 'yards.convert_to_paging', anchor: 'anchor.paging_gate' } },
    { at: 24, command: { kind: 'interaction', id: 'yards.page_size_up', anchor: 'anchor.page_size_dial' } },
    { at: 30, command: { kind: 'terminal', line: 'pagetable 2' } },
    { at: 32, command: { kind: 'interaction', id: 'yards.answer_translation', anchor: 'anchor.translation_gate' } },
    { at: 36, command: { kind: 'interaction', id: 'yards.clear_executable', anchor: 'anchor.protection_bench' } },
    { at: 40, command: { kind: 'interaction', id: 'yards.route_contiguous', anchor: 'anchor.route_fork' } },
    { at: 44, command: { kind: 'interaction', id: 'yards.vesper_remap', anchor: 'anchor.index_board' } },
    { at: 50, command: { kind: 'terminal', line: 'tlb --stats' } },
    { at: 52, command: { kind: 'terminal', line: 'pagetable 2 --bits' } },
    { at: 54, command: { kind: 'terminal', line: 'pagetable 2 --translate 8892' } },
  ],
};

const GOOD_EXPECTATION: OutcomeExpectation = {
  survived: true,
  objectivesMet: [
    'obj.allocation_yards.strategy_choice',
    'obj.allocation_yards.diagnose_fragmentation',
    'obj.allocation_yards.paging_trade',
    'obj.allocation_yards.translate_address',
    'obj.allocation_yards.locality_over_hardware',
    'obj.allocation_yards.protection_bits',
    'obj.allocation_yards.page_size_tradeoff',
  ],
  casualties: [],
  codexUnlocked: [
    'codex.address_binding', 'codex.logical_vs_physical', 'codex.contiguous_allocation',
    'codex.fragmentation', 'codex.paging', 'codex.tlb', 'codex.page_protection',
    'codex.page_table_structure',
  ],
  debrief: { headlineMatches: /^Placed\.$/, counterfactualPresent: true, chapter: { chapter: 9, sections: ['9.2.3'] } },
  ticksBetween: [80, 90],
  eventTypesPresent: ['memory.allocated', 'memory.allocation_failed', 'tlb.miss'],
  eventTypesAbsent: ['kernel.panic', 'memory.page_evicted', 'memory.thrashing'],
  decisionOutcomes: [{ kind: 'executable_bit', outcome: 'pending' }],
};

/**
 * The package's known-bad sequence: worst fit for the whole leg, quota bought
 * on the first fragmentation failure, no conversion, the scattered route, the
 * executable bit left set. VESPER stands unplaced, acquires this leg's
 * `fragmented` thirty ticks in, and derezzes thirty ticks after that.
 */
const BAD: DecisionScript = {
  legId: 'allocation_yards',
  label: 'allocation_yards known-bad',
  steps: [
    { at: 3, command: { kind: 'set_allocation', to: 'worst_fit' } },
    { at: 12, depot: 'quota_lot', target: null },
    { at: 32, command: { kind: 'interaction', id: 'yards.route_scattered', anchor: 'anchor.route_fork' } },
    { at: 75, command: { kind: 'interaction', id: 'yards.answer_translation', anchor: 'anchor.translation_gate' } },
  ],
};

const BAD_EXPECTATION: OutcomeExpectation = {
  survived: true,
  casualties: ['vesper'],
  casualtyCount: 1,
  objectivesMet: [],
  decisionOutcomes: [
    { kind: 'unplaced_program', outcome: 'fatal' },
    { kind: 'buy_quota_on_fragmentation', outcome: 'costly' },
    { kind: 'executable_bit', outcome: 'pending' },
  ],
  ticksBetween: [80, 90],
  eventTypesPresent: ['process.exited', 'memory.allocation_failed'],
  eventTypesAbsent: ['kernel.panic'],
  debrief: { headlineMatches: /nowhere to put it/, counterfactualPresent: true },
};

export const knownGood: LegFixture = {
  legId: 'allocation_yards',
  path: 'good',
  failureMode: 'casualty',
  seed: FIXTURE_SEED,
  discClass: 'shell',
  difficulty: 'operator',
  pace: 'steady',
  rations: 'standard',
  enteringLedger: ENTERING_LEDGER,
  enteringDecisions: [],
  script: GOOD,
  expect: GOOD_EXPECTATION,
};

export const knownBad: LegFixture = {
  legId: 'allocation_yards',
  path: 'bad',
  failureMode: 'casualty',
  seed: FIXTURE_SEED,
  discClass: 'shell',
  difficulty: 'operator',
  pace: 'steady',
  rations: 'standard',
  enteringLedger: ENTERING_LEDGER,
  enteringDecisions: [],
  script: BAD,
  expect: BAD_EXPECTATION,
};

/**
 * KERNEL TRAIL: Quantum Pass, the two recorded playthroughs (scope correction
 * section 6). Exactly two exports, `knownGood` and `knownBad`, both at the
 * shared fixture seed, both entering with the analytical ledger of section 9.
 *
 * The known-good ladder is the leg read correctly: watch the counters, ask the
 * ribbon what the alternatives cost, fix the policy rather than the Program
 * when the warning fires, size a quantum against the set it has to serve, and
 * let the feedback queue sort the interactive work from the CPU-bound work. It
 * meets all seven objectives and brings every Program through.
 *
 * The known-bad ladder is the leg read wrongly in the one way the leg is built
 * to punish: the warning fires, the player raises the quantum, and the quantum
 * is not what is excluding SABLE. She is ready for thirty-five consecutive
 * ticks and derezzes on the thirty-sixth. Four Programs cross, so the convoy
 * survives, which is why `survived` is true beside a casualty.
 */
import { FIXTURE_SEED, type LegFixture } from '../harness/fixtureContract';
import type { DecisionScript } from '../harness/decisionScript';
import { CODEX_IDS } from '../../../src/legs/quantum_pass/copy';
import { OBJECTIVE_IDS } from '../../../src/legs/quantum_pass/objectives';
import { UNREMEDIED_KIND, WRONG_REMEDY_KIND } from '../../../src/legs/quantum_pass/decisions';
import { ANCHORS, INTERACTION_IDS } from '../../../src/legs/quantum_pass/interactions';

/**
 * Scope correction section 9. The Boot Sector, the Fork Fields and the Weave
 * have not shipped, so this is the analytical curve of narrative 5.5 rather
 * than a predecessor's golden closing ledger: `startingLedger('shell',
 * 'operator')` is 1600 cycles, and the three earlier legs after the Boot
 * Sector leave 1425. Quota, blocks and bandwidth stay at the starting ledger,
 * and the runner refills bandwidth at entry in any case. Replace all four with
 * the Weave's closing ledger when it lands.
 */
const ENTERING_LEDGER = { cycles: 1425, quota: 900, blocks: 120, bandwidth: 60 } as const;

const GOOD_SCRIPT: DecisionScript = {
  legId: 'quantum_pass',
  label: 'quantum pass known-good',
  steps: [
    // Read the pass before touching it. The wait counters are the instrument the leg is about.
    { at: 2, command: { kind: 'interaction', id: INTERACTION_IDS.readWaitCounters, anchor: ANCHORS.pass } },
    { at: 3, command: { kind: 'terminal', line: 'gantt --metrics' } },
    // Three non-preemptive policies on the recorded arrivals, then the shortest-job commitment.
    { at: 5, command: { kind: 'terminal', line: 'gantt --replay sjf' } },
    { at: 6, command: { kind: 'terminal', line: 'gantt --replay fcfs' } },
    { at: 7, command: { kind: 'terminal', line: 'gantt --replay priority' } },
    // The warning fires at tick 15. Fix the policy, not the Program.
    { when: { kind: 'event', type: 'process.starving' }, command: { kind: 'set_scheduler', to: 'priority_aging' } },
    { at: 16, command: { kind: 'interaction', id: INTERACTION_IDS.setAging, anchor: ANCHORS.ledgeControl } },
    { at: 25, command: { kind: 'set_scheduler', to: 'sjf' } },
    { at: 26, command: { kind: 'interaction', id: INTERACTION_IDS.setPolicy, anchor: ANCHORS.ledgeControl } },
    // A quantum of 8 against the sweep stream's median burst of 4.
    { at: 30, command: { kind: 'set_scheduler', to: 'rr', quantum: 8 } },
    { at: 31, command: { kind: 'interaction', id: INTERACTION_IDS.readGantt, anchor: ANCHORS.ganttWall } },
    // The feedback queue takes the grind down two levels and leaves the taps where they are.
    { at: 37, command: { kind: 'set_scheduler', to: 'mlfq' } },
    { at: 38, command: { kind: 'terminal', line: 'sched --levels 4,8,16' } },
  ],
};

const BAD_SCRIPT: DecisionScript = {
  legId: 'quantum_pass',
  label: 'quantum pass known-bad',
  steps: [
    // The warning fires and the player reaches for the quantum, which is not what is excluding her.
    { when: { kind: 'event', type: 'process.starving' }, command: { kind: 'interaction', id: INTERACTION_IDS.setQuantum, anchor: ANCHORS.ledgeControl } },
    { when: { kind: 'event', type: 'process.starving' }, command: { kind: 'set_scheduler', to: 'priority', quantum: 16 } },
    // Well after the derezz: the counter is still climbing on somebody else.
    { when: { kind: 'progress_at_least', value: 0.6 }, command: { kind: 'interaction', id: INTERACTION_IDS.readWaitCounters, anchor: ANCHORS.pass } },
  ],
};

export const knownGood: LegFixture = {
  legId: 'quantum_pass',
  path: 'good',
  failureMode: 'casualty',
  seed: FIXTURE_SEED,
  discClass: 'shell',
  difficulty: 'operator',
  pace: 'steady',
  rations: 'standard',
  enteringLedger: ENTERING_LEDGER,
  enteringDecisions: [],
  script: GOOD_SCRIPT,
  expect: {
    survived: true,
    objectivesMet: [
      OBJECTIVE_IDS.waitingTimeTarget,
      OBJECTIVE_IDS.sjfIsOptimal,
      OBJECTIVE_IDS.quantumSizing,
      OBJECTIVE_IDS.clearStarvation,
      OBJECTIVE_IDS.avoidConvoyEffect,
      OBJECTIVE_IDS.tuneMlfq,
      OBJECTIVE_IDS.switchRate,
    ],
    casualties: [],
    codexUnlocked: [
      CODEX_IDS.criteria, CODEX_IDS.convoy, CODEX_IDS.sjf, CODEX_IDS.roundRobin,
      CODEX_IDS.starvation, CODEX_IDS.mlfq, CODEX_IDS.preemption,
    ],
    ticksBetween: [70, 70],
    eventTypesPresent: ['context.switch', 'quantum.expired', 'process.starving'],
    eventTypesAbsent: ['kernel.panic'],
    debrief: { headlineMatches: /^Over the pass\.$/, counterfactualPresent: true, chapter: { chapter: 5, sections: ['5.3.4'] } },
  },
};

export const knownBad: LegFixture = {
  legId: 'quantum_pass',
  path: 'bad',
  failureMode: 'casualty',
  seed: FIXTURE_SEED,
  discClass: 'shell',
  difficulty: 'operator',
  pace: 'steady',
  rations: 'standard',
  enteringLedger: ENTERING_LEDGER,
  enteringDecisions: [],
  script: BAD_SCRIPT,
  expect: {
    survived: true,
    casualties: ['sable'],
    casualtyCount: 1,
    // None. Declining first come first served is not the same as never having asked what it cost,
    // so the convoy-effect objective is not met by a player who touched nothing.
    objectivesMet: [],
    decisionOutcomes: [
      { kind: UNREMEDIED_KIND, outcome: 'fatal' },
      { kind: WRONG_REMEDY_KIND, outcome: 'costly' },
    ],
    ticksBetween: [70, 70],
    eventTypesPresent: ['context.switch', 'process.starving', 'process.exited'],
    eventTypesAbsent: ['kernel.panic'],
    debrief: { headlineMatches: /^SABLE never ran\.$/, counterfactualPresent: true, chapter: { chapter: 5, sections: ['5.3.4'] } },
  },
};

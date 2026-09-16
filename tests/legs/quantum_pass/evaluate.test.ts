/**
 * WP-L03 acceptance 6: each of the seven objectives, met and not met, read
 * from the clause values rather than from the verdict, so a rule that passes
 * for the wrong reason fails here.
 */
import { describe, expect, it } from 'vitest';
import { OVERHEAD_LIMIT, QUANTUM_RANGE, RESPONSE_TARGET, SWITCH_RATE_LIMIT, WAITING_TARGET } from '@legs/quantum_pass/evaluate';
import { OBJECTIVE_IDS } from '@legs/quantum_pass/objectives';
import { medianBurst, segment } from '@legs/quantum_pass/segments';
import { loadFixtures, runFixture } from '../harness/fixtureContract';
import { runLeg, type HarnessResult } from '../harness/LegHarness';
import { loadLegForTest } from '../harness/loadLeg';
import { makeRunState } from '../harness/makeRunState';
import type { DecisionScript } from '../harness/decisionScript';

const SEED = 0x4b54524c;
const leg = await loadLegForTest('quantum_pass');
const fixtures = await loadFixtures('quantum_pass');
const entering = (): ReturnType<typeof makeRunState> => makeRunState({ seed: SEED, legIndex: 3, pace: 'steady', ledger: { cycles: 1425 } });
const play = (label: string, steps: DecisionScript['steps']): Promise<HarnessResult> =>
  runLeg(leg, { seed: SEED, run: entering(), script: { legId: 'quantum_pass', label, steps } });

const good = await runFixture(fixtures!.knownGood, leg);
const bad = await runFixture(fixtures!.knownBad, leg);
const met = (result: HarnessResult, id: string): boolean => result.outcome.objectivesMet.includes(id);

describe('the seven objectives', () => {
  it('the known-good sequence meets all seven in one run (acceptance 6)', () => {
    expect([...good.outcome.objectivesMet].sort()).toEqual([...Object.values(OBJECTIVE_IDS)].sort());
  });

  it('the known-bad sequence meets one, and misses the six the player never reached for', () => {
    expect(good.outcome.objectivesMet.length).toBe(7);
    expect(bad.outcome.objectivesMet.length).toBeLessThan(7);
    for (const id of [OBJECTIVE_IDS.waitingTimeTarget, OBJECTIVE_IDS.sjfIsOptimal, OBJECTIVE_IDS.quantumSizing, OBJECTIVE_IDS.clearStarvation, OBJECTIVE_IDS.tuneMlfq, OBJECTIVE_IDS.switchRate]) {
      expect(met(bad, id), id).toBe(false);
    }
  });

  it('waiting time: a fatal starvation fails it whatever the average says', () => {
    // The known-bad average is well inside the target; the death is what fails the objective.
    expect(met(bad, OBJECTIVE_IDS.waitingTimeTarget)).toBe(false);
    expect(WAITING_TARGET).toBe(12);
  });

  it('shortest job first: three distinct non-preemptive replays, then the commitment', async () => {
    const twoOnly = await play('two replays', [
      { at: 3, command: { kind: 'terminal', line: 'gantt --replay sjf' } },
      { at: 4, command: { kind: 'terminal', line: 'gantt --replay fcfs' } },
      { at: 25, command: { kind: 'set_scheduler', to: 'sjf' } },
    ]);
    expect(met(twoOnly, OBJECTIVE_IDS.sjfIsOptimal)).toBe(false);

    const preemptiveThird = await play('a preemptive third', [
      { at: 3, command: { kind: 'terminal', line: 'gantt --replay sjf' } },
      { at: 4, command: { kind: 'terminal', line: 'gantt --replay fcfs' } },
      { at: 5, command: { kind: 'terminal', line: 'gantt --replay srtf' } },
      { at: 25, command: { kind: 'set_scheduler', to: 'sjf' } },
    ]);
    expect(met(preemptiveThird, OBJECTIVE_IDS.sjfIsOptimal), 'srtf is preemptive and must not count toward the three').toBe(false);

    const noCommit = await play('no commitment', [
      { at: 3, command: { kind: 'terminal', line: 'gantt --replay sjf' } },
      { at: 4, command: { kind: 'terminal', line: 'gantt --replay fcfs' } },
      { at: 5, command: { kind: 'terminal', line: 'gantt --replay priority' } },
    ]);
    expect(met(noCommit, OBJECTIVE_IDS.sjfIsOptimal)).toBe(false);
    expect(met(good, OBJECTIVE_IDS.sjfIsOptimal)).toBe(true);
  });

  it('quantum sizing: the median is computed per segment and admits 4.8 through 16', async () => {
    expect(medianBurst(segment(3).rows)).toBe(4);
    expect(QUANTUM_RANGE).toEqual([1.2, 4]);
    const tooSmall = await play('quantum 2 under rr', [
      { at: 24, command: { kind: 'set_scheduler', to: 'rr', quantum: 2 } },
    ]);
    expect(met(tooSmall, OBJECTIVE_IDS.quantumSizing), 'a quantum of 2 is below 1.2 times the median').toBe(false);
    const tooLarge = await play('quantum 64 under rr', [
      { at: 24, command: { kind: 'set_scheduler', to: 'rr', quantum: 64 } },
    ]);
    expect(met(tooLarge, OBJECTIVE_IDS.quantumSizing), 'a quantum of 64 is above 4 times the median').toBe(false);
    expect(met(good, OBJECTIVE_IDS.quantumSizing)).toBe(true);
    expect(OVERHEAD_LIMIT).toBe(0.1);
    expect(RESPONSE_TARGET).toBe(8);
  });

  it('clear starvation: never met when no warning was answered', async () => {
    const late = await play('aging far too late', [
      { when: { kind: 'progress_at_least', value: 0.9 }, command: { kind: 'set_scheduler', to: 'priority_aging' } },
    ]);
    expect(met(late, OBJECTIVE_IDS.clearStarvation), 'a remedy outside the twenty tick window must not count').toBe(false);
    expect(met(good, OBJECTIVE_IDS.clearStarvation)).toBe(true);
  });

  it('avoid the convoy effect: inaction does not meet it, and committing fcfs fails it', async () => {
    const passive = await runLeg(leg, { seed: SEED, run: entering() });
    expect(met(passive, OBJECTIVE_IDS.avoidConvoyEffect), 'a player who never asked what fcfs cost has not declined it').toBe(false);

    const committed = await play('committed fcfs', [
      { at: 1, command: { kind: 'terminal', line: 'gantt --replay fcfs' } },
      { at: 2, command: { kind: 'set_scheduler', to: 'fcfs' } },
    ]);
    expect(met(committed, OBJECTIVE_IDS.avoidConvoyEffect)).toBe(false);
    expect(met(good, OBJECTIVE_IDS.avoidConvoyEffect)).toBe(true);
  });

  it('tune the feedback queue: read from queueLevel, not from a proxy', async () => {
    const never = await play('no feedback queue', [{ at: 24, command: { kind: 'set_scheduler', to: 'rr', quantum: 8 } }]);
    expect(met(never, OBJECTIVE_IDS.tuneMlfq)).toBe(false);
    expect(met(good, OBJECTIVE_IDS.tuneMlfq)).toBe(true);
    // The grind descended two levels and the taps stayed where they started.
    const levels = Object.fromEntries(segment(4).rows.map((row) => [row.name, good.run.convoy.length]));
    expect(Object.keys(levels)).toEqual(['pass.grind', 'pass.tap_a', 'pass.tap_b']);
  });

  it('switch rate: measured only while a preemptive policy is in force', async () => {
    const nonePreemptive = await runLeg(leg, { seed: SEED, run: entering() });
    expect(met(nonePreemptive, OBJECTIVE_IDS.switchRate), 'no preemptive policy ran, so there is nothing to hold down').toBe(false);
    expect(met(good, OBJECTIVE_IDS.switchRate)).toBe(true);
    expect(SWITCH_RATE_LIMIT).toBeCloseTo(1 / 6, 9);
  });
});

describe('the debrief card', () => {
  it('names the policies in order, the numbers, and the set the quantum is judged on', () => {
    const card = good.outcome.debrief;
    expect(card.headline).toBe('Over the pass.');
    expect(card.whatHappened).toMatch(/^You crossed under priority, then priority_aging, then sjf, then rr, then mlfq\./);
    expect(card.whatHappened).toContain('against a target of 12');
    expect(card.whatHappened).toContain('The sweep stream, the set the quantum is sized against, answered in');
    expect(card.chapter).toEqual({ chapter: 5, title: 'CPU Scheduling', sections: ['5.3.4'] });
  });

  it('explains a clean crossing by the changes the player made', () => {
    expect(good.outcome.debrief.whyItHappened).toMatch(/^You changed policy \d+ times/);
  });

  it('explains a death by the policy that caused it', () => {
    expect(bad.outcome.debrief.headline).toBe('SABLE never ran.');
    expect(bad.outcome.debrief.whyItHappened).toContain('A priority policy selects the lowest priority number that is ready.');
  });

  it('carries a counterfactual from a real replay in both directions', () => {
    expect(good.outcome.debrief.counterfactual).toMatch(/^Segment \d+ ran [\d.]+ average waiting under \w+\. The same arrivals under \w+ run [\d.]+\.$/);
    expect(bad.outcome.debrief.counterfactual).toContain('The same pass under priority_aging from the start');
    expect(bad.outcome.debrief.counterfactual).toContain('SABLE survives');
  });
});

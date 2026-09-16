/**
 * WP-L03 acceptance 7: the known-bad playthrough. The warning fires, the
 * player raises the quantum, and the quantum is not what is excluding her.
 */
import { describe, expect, it } from 'vitest';
import { STARVATION_FATAL_THRESHOLD, STARVATION_THRESHOLD } from '@legs/quantum_pass/config';
import { STARVATION_CAUSE } from '@legs/quantum_pass/copy';
import { UNREMEDIED_KIND, WRONG_REMEDY_KIND } from '@legs/quantum_pass/decisions';
import { OBJECTIVE_IDS } from '@legs/quantum_pass/objectives';
import { checkFixtureRun, loadFixtures, runFixture } from '../harness/fixtureContract';
import { assertClean, remainderHashAfter } from '../harness/LegHarness';
import { loadLegForTest } from '../harness/loadLeg';
import { expectOutcome } from '../harness/expectOutcome';

const leg = await loadLegForTest('quantum_pass');
const fixtures = await loadFixtures('quantum_pass');
const fixture = fixtures!.knownBad;
const result = await runFixture(fixture, leg);

describe('the known-bad playthrough', () => {
  it('completes with no panic and every step fired', () => {
    assertClean(result);
    expect(result.unfiredSteps).toEqual([]);
    expect(result.ticks).toBe(70);
  });

  it('SABLE is ready for the whole threshold and then derezzes of starvation', () => {
    const hers = result.events.filter((event) => event.type === 'process.starving' && event.pid === 3);
    expect(hers.some((event) => event.type === 'process.starving' && !event.fatal && event.waitedTicks === STARVATION_THRESHOLD)).toBe(true);
    expect(hers.some((event) => event.type === 'process.starving' && event.fatal && event.waitedTicks === STARVATION_FATAL_THRESHOLD)).toBe(true);
    const exit = result.events.find((event) => event.type === 'process.exited' && event.pid === 3);
    expect(exit?.type === 'process.exited' && exit.reason).toBe('starvation');
    expect(result.outcome.casualties).toEqual(['sable']);
  });

  it('the stone carries the number the counter showed and the codex link', () => {
    const stone = result.run.tombstones.find((candidate) => candidate.member === 'sable');
    expect(stone?.legId).toBe('quantum_pass');
    expect(stone?.reason).toBe('starvation');
    expect(stone?.tick).toBe(STARVATION_FATAL_THRESHOLD + 1);
    expect(stone?.inscription).toBe('HERE LIES SABLE, READY SINCE TICK ONE');
    expect(stone?.cause).toBe(STARVATION_CAUSE);
    expect(stone?.codexEntry).toBe('codex.priority_starvation');
  });

  it('the convoy survives, because four Programs cross', () => {
    expect(result.outcome.survived).toBe(true);
    expect(result.run.convoy.filter((member) => member.status !== 'derezzed')).toHaveLength(4);
  });

  it('the wrong remedy is recorded costly and the death is recorded fatal', () => {
    const wrong = result.decisions.filter((record) => record.kind === WRONG_REMEDY_KIND);
    expect(wrong).toHaveLength(1);
    expect(wrong[0]?.outcome).toBe('costly');
    const death = result.decisions.filter((record) => record.kind === UNREMEDIED_KIND);
    expect(death).toHaveLength(1);
    expect(death[0]?.outcome).toBe('fatal');
    expect(death[0]?.choice).toBe('sable');
  });

  it('misses the objectives the player never reached for', () => {
    for (const id of [OBJECTIVE_IDS.waitingTimeTarget, OBJECTIVE_IDS.sjfIsOptimal, OBJECTIVE_IDS.quantumSizing, OBJECTIVE_IDS.clearStarvation, OBJECTIVE_IDS.tuneMlfq, OBJECTIVE_IDS.switchRate]) {
      expect(result.outcome.objectivesMet, id).not.toContain(id);
    }
    expect(result.outcome.objectivesMet, 'a player who touched nothing meets nothing').toEqual([]);
    expect(result.outcome.objectivesMet).not.toContain(OBJECTIVE_IDS.avoidConvoyEffect);
  });

  it('the counterfactual is a real replay in which she survives', () => {
    const card = result.outcome.debrief;
    expect(card.headline).toBe('SABLE never ran.');
    expect(card.counterfactual).toContain('The same pass under priority_aging from the start');
    expect(card.counterfactual).toContain('SABLE survives');
    expect(card.counterfactual).toContain(String(STARVATION_FATAL_THRESHOLD));
  });

  it('unlocks the starvation codex entry on the warning, before the death', () => {
    expect(result.outcome.codexUnlocked).toContain('codex.priority_starvation');
    const warning = result.events.find((event) => event.type === 'process.starving');
    const death = result.events.find((event) => event.type === 'process.exited' && event.reason === 'starvation');
    expect((warning?.tick ?? 0) < (death?.tick ?? 0), 'the remedy must be readable before the fatal threshold').toBe(true);
  });

  it('meets its expectation, repeats, and restores identically', async () => {
    expectOutcome(result, fixture.expect);
    expect(checkFixtureRun(fixture, result, leg)).toEqual([]);
    const second = await runFixture(fixture, leg);
    expect(second.logHash).toBe(result.logHash);
    const restored = await runFixture(fixture, leg, { restoreAt: Math.floor(result.ticks / 2) });
    expect(restored.logHash).toBe(result.logHash);
    if (restored.restore !== null) expect(restored.restore.remainderHash).toBe(remainderHashAfter(result, restored.restore.seq));
  });
});

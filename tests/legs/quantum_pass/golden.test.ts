/**
 * WP-L03 acceptance 2 and 6: the golden playthrough, asserted on its own terms.
 *
 * The shared goldens suite compares this run against the checked-in
 * fingerprint and summary. What this file asserts is the run itself: that the
 * ladder the fixture records meets every objective, loses nobody, holds the
 * numbers the objectives turn on, and gives the same log twice and across a
 * restore at the midpoint.
 */
import { describe, expect, it } from 'vitest';
import { checkFixtureRun, isWarning, loadFixtures, runFixture, validateFixture } from '../harness/fixtureContract';
import { assertClean, remainderHashAfter } from '../harness/LegHarness';
import { loadLegForTest } from '../harness/loadLeg';
import { expectOutcome } from '../harness/expectOutcome';
import { OBJECTIVE_IDS } from '@legs/quantum_pass/objectives';
import { CODEX_IDS } from '@legs/quantum_pass/copy';
import { REQUIRED_EVENTS } from '../harness/requiredEvents';

const leg = await loadLegForTest('quantum_pass');
const fixtures = await loadFixtures('quantum_pass');
const fixture = fixtures!.knownGood;
const result = await runFixture(fixture, leg);

describe('the golden playthrough', () => {
  it('runs headlessly to completion with no panic and no leg failure (acceptance 2)', () => {
    assertClean(result);
    expect(result.panics).toEqual([]);
    expect(result.legFailures).toEqual([]);
    expect(result.runnerFailures).toEqual([]);
    expect(result.unfiredSteps).toEqual([]);
    expect(result.stageCalls, 'the runner never builds a stage headlessly').toBe(0);
  });

  it('enters on the analytical ledger and the fixture seed', () => {
    expect(validateFixture(fixture, leg).filter((problem) => !isWarning(problem))).toEqual([]);
    expect(fixture.seed).toBe(0x4b54524c);
    expect(fixture.enteringLedger.cycles).toBe(1425);
    expect(fixture.pace).toBe('steady');
  });

  it('meets every objective and brings all five Programs through', () => {
    expect([...result.outcome.objectivesMet].sort()).toEqual([...Object.values(OBJECTIVE_IDS)].sort());
    expect(result.outcome.casualties).toEqual([]);
    expect(result.outcome.survived).toBe(true);
    expect(result.run.convoy.filter((member) => member.status === 'derezzed')).toEqual([]);
    expect(result.run.tombstones).toEqual([]);
  });

  it('adds all seven codex entries', () => {
    expect([...result.outcome.codexUnlocked].sort()).toEqual([...Object.values(CODEX_IDS)].sort());
  });

  it('fires every event the leg claims to teach from', () => {
    for (const required of REQUIRED_EVENTS.quantum_pass) {
      expect(result.eventTypes.has(required), `never emitted ${required}`).toBe(true);
    }
  });

  it('holds the numbers the objectives turn on', () => {
    // A starvation warning still fires: the leg opens under the policy that causes it, and the
    // player answering the warning is what the run is about. What must not happen is a fatal one.
    expect(result.eventTypes.has('process.starving')).toBe(true);
    const fatal = result.events.filter((event) => event.type === 'process.starving' && event.fatal);
    expect(fatal).toEqual([]);
    expect(result.ticks).toBe(70);
  });

  it('meets the fixture expectation and the harness run rules', () => {
    expectOutcome(result, fixture.expect);
    expect(checkFixtureRun(fixture, result, leg)).toEqual([]);
  });

  it('gives the same log twice in one process', async () => {
    const second = await runFixture(fixture, leg);
    expect(second.logHash).toBe(result.logHash);
    expect(second.ticks).toBe(result.ticks);
    expect(second.outcome.objectivesMet).toEqual(result.outcome.objectivesMet);
  });

  it('gives the same log across a snapshot and restore at the midpoint', async () => {
    const restored = await runFixture(fixture, leg, { restoreAt: Math.floor(result.ticks / 2) });
    expect(restored.restore).not.toBeNull();
    expect(restored.logHash).toBe(result.logHash);
    if (restored.restore !== null) {
      expect(restored.restore.remainderHash).toBe(remainderHashAfter(result, restored.restore.seq));
    }
  });
});

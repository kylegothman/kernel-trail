/**
 * The golden headless playthrough (acceptance 6): the known-good sequence
 * meets all six objectives, its overhead is 16, its closing ledger clears
 * every floor, and its log hash is stable across two runs and across a
 * snapshot-restore at the midpoint. The checked-in golden file is compared
 * by the shared goldens suite.
 */
import { describe, expect, it } from 'vitest';
import { bootSector } from './leg';
import { FLOORS } from '@legs/boot_sector/evaluate';
import { reduceRequisition, TRAP_COST, correctLabels } from '@legs/boot_sector/windows';
import { expectOutcome } from '../harness/expectOutcome';
import { checkFixtureRun, isWarning, runFixture, validateFixture } from '../harness/fixtureContract';
import { assertClean, remainderHashAfter } from '../harness/LegHarness';
import { knownGood } from './fixtures';
import { CODEX, KNOWN_GOOD_EXPECTATION } from './scripts';

describe('boot_sector golden playthrough', () => {
  it('the fixture validates with no problem and no warning', () => {
    expect(validateFixture(knownGood, bootSector).filter((problem) => !isWarning(problem))).toEqual([]);
    expect(validateFixture(knownGood, bootSector).filter(isWarning)).toEqual([]);
  });

  it('meets all six objectives with 16 cycles of overhead, clears every floor and adds the five codex entries', async () => {
    const result = await runFixture(knownGood, bootSector);
    assertClean(result);
    expect(result.unfiredSteps).toEqual([]);
    expectOutcome(result, KNOWN_GOOD_EXPECTATION);
    expect(checkFixtureRun(knownGood, result, bootSector)).toEqual([]);
    const state = reduceRequisition(result.run.decisions, 'shell', 'operator');
    expect(state.submissions).toHaveLength(4);
    expect(state.submissions.every((submission) => submission.errno === null)).toBe(true);
    expect(state.submissions.length * TRAP_COST).toBe(16);
    expect(correctLabels(state)).toBe(6);
    expect(result.ledgerAfter).toEqual({ cycles: 1184, quota: 940, blocks: 160, bandwidth: 86 });
    for (const key of ['cycles', 'quota', 'blocks', 'bandwidth'] as const) expect(result.ledgerAfter[key]).toBeGreaterThanOrEqual(FLOORS[key]);
    expect(result.outcome.codexUnlocked).toEqual(CODEX);
    expect(result.run.codexUnlocked).toEqual(CODEX);
    expect(result.run.objectivesMet).toEqual(knownGood.expect.objectivesMet);
    expect(result.run.decisions.some((record) => record.kind === 'leg_done' && record.choice === 'blocks')).toBe(true);
  });

  it('the class allocation is applied exactly once: the run enters with it and the leg returns no delta', async () => {
    const result = await runFixture(knownGood, bootSector);
    expect(result.ledgerBefore).toEqual({ ...knownGood.enteringLedger, bandwidth: knownGood.enteringLedger.bandwidth });
    expect(result.outcome.resourceDelta).toEqual({ cycles: 0, quota: 0, blocks: 0, bandwidth: 0 });
  });

  it('is stable across two runs in one process and across a snapshot-restore at the midpoint', async () => {
    const first = await runFixture(knownGood, bootSector);
    const second = await runFixture(knownGood, bootSector);
    expect(second.logHash).toBe(first.logHash);
    expect(second.run).toEqual(first.run);
    const restored = await runFixture(knownGood, bootSector, { restoreAt: Math.floor(first.ticks / 2) });
    expect(restored.restore).not.toBeNull();
    if (restored.restore !== null) expect(restored.restore.remainderHash).toBe(remainderHashAfter(first, restored.restore.seq));
    expect(restored.logHash).toBe(first.logHash);
    expect(restored.outcome).toEqual(first.outcome);
  });
});

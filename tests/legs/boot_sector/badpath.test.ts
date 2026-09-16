/**
 * The known-bad sequence (acceptance 7): six separate submissions, every
 * frame of quota released for cycles, no manual, four windows wrong. The
 * budget, manual and trap objectives fail, the counterfactual is case 2, and
 * the convoy still survives with no casualty.
 */
import { describe, expect, it } from 'vitest';
import { bootSector } from './leg';
import { OBJECTIVE_IDS } from '@legs/boot_sector/objectives';
import { reduceRequisition, TRAP_COST } from '@legs/boot_sector/windows';
import { expectOutcome } from '../harness/expectOutcome';
import { checkFixtureRun, isWarning, runFixture, validateFixture } from '../harness/fixtureContract';
import { assertClean } from '../harness/LegHarness';
import { knownBad } from './fixtures';
import { ENTERING_LEDGER, KNOWN_BAD_EXPECTATION } from './scripts';

describe('boot_sector known-bad path', () => {
  it('the fixture validates as a costly failure with no warning', () => {
    expect(knownBad.failureMode).toBe('costly');
    expect(validateFixture(knownBad, bootSector).filter((problem) => !isWarning(problem))).toEqual([]);
    expect(validateFixture(knownBad, bootSector).filter(isWarning)).toEqual([]);
  });

  it('fails the budget, the manual and the trap objectives, produces counterfactual case 2, and survives with zero casualties', async () => {
    const result = await runFixture(knownBad, bootSector);
    assertClean(result);
    expect(result.unfiredSteps).toEqual([]);
    expectOutcome(result, KNOWN_BAD_EXPECTATION);
    expect(checkFixtureRun(knownBad, result, bootSector)).toEqual([]);
    const met = result.outcome.objectivesMet;
    expect(met).not.toContain(OBJECTIVE_IDS.modeSwitchBudget);
    expect(met).not.toContain(OBJECTIVE_IDS.consultManual);
    expect(met).not.toContain(OBJECTIVE_IDS.acquireViaTrap);
    expect(met).not.toContain(OBJECTIVE_IDS.balancedLedger);
    expect(met).not.toContain(OBJECTIVE_IDS.classifyPrivilege);
    expect(met).not.toContain(OBJECTIVE_IDS.discClassTradeoff);
    const state = reduceRequisition(result.run.decisions, 'shell', 'operator');
    expect(state.submissions).toHaveLength(6);
    expect(state.submissions.filter((submission) => submission.errno === 'EPERM')).toHaveLength(4);
    expect(state.submissions.length * TRAP_COST).toBe(24);
    expect(result.ledgerAfter.quota).toBe(0);
    expect(result.ledgerAfter.cycles).toBe(ENTERING_LEDGER.cycles - 6 * TRAP_COST + 900 * 2);
    expect(result.outcome.debrief.counterfactual).toBe('You are carrying 0 quota. The Fork Fields needs enough to hold five address spaces plus the scouts you will create there.');
    expect(result.outcome.survived).toBe(true);
    expect(result.outcome.casualties).toEqual([]);
    expect(result.run.tombstones).toEqual([]);
    expect(result.decisions.filter((record) => record.outcome === 'costly').length).toBeGreaterThanOrEqual(5);
  });
});

/**
 * WP-L07: the golden headless playthrough. The checked-in fingerprint and
 * summary are `tests/legs/goldens.test.ts`'s to compare; this file asserts
 * what the run must contain for that golden to be worth recording.
 */
import { describe, expect, it } from 'vitest';
import { checkFixtureRun, runFixture, validateFixture, isWarning } from '../harness/fixtureContract';
import { expectOutcome } from '../harness/expectOutcome';
import { remainderHashAfter } from '../harness/LegHarness';
import { loadLegForTest } from '../harness/loadLeg';
import { REQUIRED_EVENTS } from '../harness/requiredEvents';
import { OBJECTIVE_IDS } from '@legs/allocation_yards/objectives';
import { CODEX_IDS } from '@legs/allocation_yards/copy';
import { readLeg } from '@legs/allocation_yards/evaluate';
import { replayYard } from '@legs/allocation_yards/yard';
import { knownGood } from './fixtures';

const leg = await loadLegForTest('allocation_yards');
const result = await runFixture(knownGood, leg);

describe('the known-good playthrough', () => {
  it('validates statically and satisfies the fixture contract after the run', () => {
    const findings = validateFixture(knownGood, leg);
    for (const warning of findings.filter(isWarning)) console.log(`golden: ${warning}`);
    expect(findings.filter((problem) => !isWarning(problem))).toEqual([]);
    expect(checkFixtureRun(knownGood, result, leg)).toEqual([]);
    expect(knownGood.seed).toBe(0x4b54524c);
    expect(knownGood.discClass).toBe('shell');
    expect(knownGood.difficulty).toBe('operator');
    expect(knownGood.pace).toBe('steady');
    expect(knownGood.rations).toBe('standard');
  });

  it('runs clean: no panic, no leg failure, no runner failure, every step fired', () => {
    expect(result.panics).toEqual([]);
    expect(result.legFailures).toEqual([]);
    expect(result.runnerFailures).toEqual([]);
    expect(result.unfiredSteps).toEqual([]);
    expect(result.stageCalls).toBe(0);
  });

  it('meets all seven objectives, loses nobody and unlocks all eight codex entries', () => {
    expect([...result.outcome.objectivesMet].sort()).toEqual([...OBJECTIVE_IDS].sort());
    expect(result.outcome.casualties).toEqual([]);
    expect(result.outcome.survived).toBe(true);
    expect([...result.outcome.codexUnlocked].sort()).toEqual([...CODEX_IDS].sort());
    expectOutcome(result, knownGood.expect);
  });

  it('ends with the yard placed, external at zero under paging and the cache warm on the contiguous route', () => {
    const reading = readLeg({ run: result.run, kernelSnapshot: {} as never, events: result.events, ticksElapsed: result.ticks });
    expect(reading.yard.unplaced).toEqual([]);
    expect(reading.converted).toBe(true);
    expect(reading.externalFragmentation).toBe(0);
    expect(reading.route).toBe('route.contiguous');
    expect(reading.hitRate).toBeGreaterThan(0.85);
    expect(reading.tlbEntries).toBe(16);
    expect(reading.pageSize).toBe(8192);
    // The contiguous yard underneath the conversion is tidy too.
    expect(replayYard(result.run.decisions, result.ticks).externalFragmentation).toBeLessThan(0.12);
  });

  it('records the executable bit cleared, which is what leg 12 reads back', () => {
    const decision = result.decisions.find((record) => record.kind === 'executable_bit');
    expect(decision?.choice).toBe('cleared');
    expect(decision?.outcome).toBe('pending');
  });

  it('fires every event REQUIRED_EVENTS demands of this leg', () => {
    for (const type of REQUIRED_EVENTS.allocation_yards) {
      expect(result.eventTypes.has(type), `never emitted ${type}`).toBe(true);
    }
    expect(result.eventTypes.has('memory.page_evicted')).toBe(false);
    expect(result.eventTypes.has('memory.thrashing')).toBe(false);
  });

  it('is repeatable in one process and identical across a mid-leg snapshot and restore', async () => {
    const second = await runFixture(knownGood, leg);
    expect(second.logHash).toBe(result.logHash);
    expect(second.ticks).toBe(result.ticks);
    const restored = await runFixture(knownGood, leg, { restoreAt: Math.floor(result.ticks / 2) });
    expect(restored.restore).not.toBeNull();
    if (restored.restore !== null) {
      expect(restored.restore.remainderHash).toBe(remainderHashAfter(result, restored.restore.seq));
    }
    expect(restored.logHash).toBe(result.logHash);
    expect(restored.decisions.map((record) => `${record.tick}:${record.kind}`))
      .toEqual(result.decisions.map((record) => `${record.tick}:${record.kind}`));
  });

  it('carries a closing ledger into the Reach, which has no depot of its own', () => {
    console.log(`golden: allocation_yards closing ledger ${JSON.stringify(result.ledgerAfter)} from ${JSON.stringify(result.ledgerBefore)}`);
    for (const value of Object.values(result.ledgerAfter)) expect(value).toBeGreaterThanOrEqual(0);
    expect(result.ledgerAfter.cycles).toBeGreaterThan(0);
    expect(result.ledgerAfter.quota).toBeGreaterThan(0);
  });
});

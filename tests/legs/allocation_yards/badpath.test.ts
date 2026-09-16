/** WP-L07 acceptance 6: the known-bad sequence and the loss it is designed to produce. */
import { describe, expect, it } from 'vitest';
import { checkFixtureRun, isWarning, runFixture, validateFixture } from '../harness/fixtureContract';
import { expectOutcome } from '../harness/expectOutcome';
import { loadLegForTest } from '../harness/loadLeg';
import { readLeg } from '@legs/allocation_yards/evaluate';
import { compareStrategies } from '@legs/allocation_yards/yard';
import { FUSE_DRAIN_PER_TICK, FUSE_FATAL_AFTER, UNPLACED_GRACE } from '@legs/allocation_yards/protection';
import { ROUTE_HIT_RATES } from '@legs/allocation_yards/fixtures';
import { knownBad } from './fixtures';

const leg = await loadLegForTest('allocation_yards');
const result = await runFixture(knownBad, leg);

describe('the known-bad sequence', () => {
  it('validates statically and satisfies the fixture contract after the run', () => {
    const findings = validateFixture(knownBad, leg);
    for (const warning of findings.filter(isWarning)) console.log(`badpath: ${warning}`);
    expect(findings.filter((problem) => !isWarning(problem))).toEqual([]);
    expect(checkFixtureRun(knownBad, result, leg)).toEqual([]);
    expect(knownBad.failureMode).toBe('casualty');
    expect(result.panics).toEqual([]);
    expect(result.unfiredSteps).toEqual([]);
  });

  it('holds worst fit for the whole leg and ends with the highest fragmentation of the three fits', () => {
    const compared = compareStrategies(result.run.decisions, result.ticks);
    expect(compared.worst_fit.externalFragmentation).toBeGreaterThan(compared.best_fit.externalFragmentation);
    expect(compared.worst_fit.externalFragmentation).toBeGreaterThan(compared.first_fit.externalFragmentation);
    const reading = readLeg({ run: result.run, kernelSnapshot: {} as never, events: result.events, ticksElapsed: result.ticks });
    expect(reading.converted).toBe(false);
    expect(reading.yard.unplaced.length).toBeGreaterThan(0);
  });

  it('leaves VESPER without a berth, fuses her and derezzes her with out_of_memory', () => {
    const vesper = result.run.convoy.find((member) => member.id === 'vesper');
    expect(vesper?.status).toBe('derezzed');
    expect(vesper?.epitaph?.reason).toBe('out_of_memory');
    expect(vesper?.epitaph?.legId).toBe('allocation_yards');
    expect(vesper?.epitaph?.codexEntry).toMatch(/^codex\./);
    expect(result.outcome.casualties).toEqual(['vesper']);
    // The grace runs first, then the fatal clock: thirty ticks each.
    expect(UNPLACED_GRACE).toBe(30);
    expect(FUSE_FATAL_AFTER).toBe(30);
    expect(FUSE_DRAIN_PER_TICK).toBe(1.5);
    expect(vesper?.epitaph?.tick ?? 0).toBeGreaterThanOrEqual(UNPLACED_GRACE + FUSE_FATAL_AFTER);
  });

  it('marks the unplaced decision fatal and the quota purchase costly', () => {
    const unplaced = result.decisions.find((record) => record.kind === 'unplaced_program');
    expect(unplaced?.choice).toBe('vesper');
    expect(unplaced?.outcome).toBe('fatal');
    const bought = result.decisions.find((record) => record.kind === 'buy_quota_on_fragmentation');
    expect(bought?.outcome).toBe('costly');
    expect(Number(bought?.choice)).toBeGreaterThan(25);
  });

  it('prints the free figure beside the purchase, so the player sees they bought space they had', () => {
    const bought = result.decisions.find((record) => record.kind === 'buy_quota_on_fragmentation');
    expect(result.outcome.debrief.whyItHappened).toContain('you bought 25 frames');
    expect(result.outcome.debrief.whyItHappened).toContain(String(bought?.choice));
    expect(result.outcome.debrief.whyItHappened).toContain('short of was a run, not a total');
  });

  it('takes the scattered route and reads 41 percent on the same hardware', () => {
    const reading = readLeg({ run: result.run, kernelSnapshot: {} as never, events: result.events, ticksElapsed: result.ticks });
    expect(reading.route).toBe('route.scattered');
    expect(reading.hitRate).toBe(ROUTE_HIT_RATES.scattered);
    expect(reading.tlbEntries).toBe(16);
  });

  it('plants the image, names the best strategy in the counterfactual, and the convoy survives', () => {
    expect(result.decisions.find((record) => record.kind === 'executable_bit')?.choice).toBe('left_set');
    expect(result.outcome.debrief.counterfactual).toContain('best_fit');
    expect(result.outcome.survived).toBe(true);
    expect(result.run.convoy.filter((member) => member.status !== 'derezzed')).toHaveLength(4);
    expectOutcome(result, knownBad.expect);
  });
});

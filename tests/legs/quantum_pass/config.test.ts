/**
 * WP-L03 acceptance 4 and 5: the entry configuration exactly, the pace table
 * behind the quantum, and inert-field independence over 400 ticks.
 */
import { describe, expect, it } from 'vitest';
import type { Pace } from '@game/types';
import { PACE_TABLE } from '@game/travel/paceRations';

import { AGING_INTERVAL, LEVEL_QUANTA, STARVATION_FATAL_THRESHOLD, STARVATION_THRESHOLD } from '@legs/quantum_pass/config';
import { runLeg, withInertPoison } from '../harness/LegHarness';
import { makeRunState } from '../harness/makeRunState';
import { loadLegForTest } from '../harness/loadLeg';

/** Loaded through the registry so the companion is remembered and the director can dispatch an interaction. */
const leg = await loadLegForTest('quantum_pass');

const PACES: readonly Pace[] = ['conservative', 'steady', 'aggressive', 'reckless'];
const INERT_TICKS = 400;

describe('the entry configuration', () => {
  it('opens under priority, non-preemptive, with the leg thresholds (acceptance 5)', () => {
    const config = leg.kernelConfig(makeRunState({ seed: 0x4b54524c, legIndex: 3, pace: 'steady' }));
    expect(config.scheduler).toBe('priority');
    expect(config.schedulerParams.preemptive).toBe(false);
    expect(config.schedulerParams.starvationThreshold).toBe(STARVATION_THRESHOLD);
    expect(config.schedulerParams.starvationFatalThreshold).toBe(STARVATION_FATAL_THRESHOLD);
    expect(config.schedulerParams.levelQuanta).toEqual(LEVEL_QUANTA);
    expect(config.schedulerParams.agingInterval).toBe(AGING_INTERVAL);
  });

  it('aging is inert under the entry policy whatever the interval says', () => {
    // Sim spec 5.5: the `priority` policy forces agingInterval to 0 regardless of what is passed,
    // so the interval the leg carries is the one a switch to priority_aging or mlfq inherits.
    const config = leg.kernelConfig(makeRunState({ seed: 0x4b54524c, legIndex: 3 }));
    expect(config.scheduler).toBe('priority');
    expect(config.schedulerParams.agingInterval).toBeGreaterThan(0);
  });

  it('the warning sits above the longest ordinary wait and below the death', () => {
    expect(STARVATION_THRESHOLD).toBeLessThan(STARVATION_FATAL_THRESHOLD);
    // The package's ratios: the warning at two fifths of the death, the window the remaining three fifths.
    expect(STARVATION_THRESHOLD / STARVATION_FATAL_THRESHOLD).toBeCloseTo(0.4, 1);
  });

  it('the quantum follows the pace table at all four paces', () => {
    for (const pace of PACES) {
      const config = leg.kernelConfig(makeRunState({ seed: 0x4b54524c, legIndex: 3, pace }));
      expect(config.schedulerParams.quantum, pace).toBe(PACE_TABLE[pace].quantum);
    }
    expect(PACES.map((pace) => PACE_TABLE[pace].quantum)).toEqual([16, 8, 4, 2]);
  });

  it('carries the inert defaults for every subsystem it does not enable', () => {
    const config = leg.kernelConfig(makeRunState({ seed: 0x4b54524c, legIndex: 3 }));
    expect(config.totalFrames).toBe(64);
    expect(config.pageSize).toBe(4096);
    expect(config.replacementPolicy).toBe('lru');
    expect(config.allocationStrategy).toBe('first_fit');
    expect(config.tlbEntries).toBe(16);
    expect(config.diskPolicy).toBe('look');
    expect(config.totalCylinders).toBe(200);
    expect(config.raidLevel).toBeNull();
    expect(config.fileAllocation).toBe('indexed');
    expect(config.journalingEnabled).toBe(false);
    expect(config.deadlockStrategy).toBe('ignore');
    expect(config.thrashingThreshold).toBe(200);
  });

  it('never reads an inert field, over 400 ticks (acceptance 4)', async () => {
    const run = makeRunState({ seed: 0x4b54524c, legIndex: 3 });
    const poisoned = withInertPoison(leg, run);
    expect(poisoned.fields.length).toBeGreaterThan(0);
    const clean = await runLeg(leg, { seed: 0x4b54524c, maxTicks: INERT_TICKS });
    const dirty = await runLeg(poisoned.leg, { seed: 0x4b54524c, maxTicks: INERT_TICKS });
    expect(dirty.logHash, `poisoning ${poisoned.fields.join(', ')} changed the log`).toBe(clean.logHash);
    expect(dirty.ticks).toBe(clean.ticks);
  });
});

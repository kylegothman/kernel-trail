/** WP-L07 acceptance 3 and 4: the subsystem set, the frozen sizes and inert-field independence. */
import { describe, expect, it } from 'vitest';
import { runLeg, withInertPoison } from '../harness/LegHarness';
import { loadLegForTest } from '../harness/loadLeg';
import { makeRunState } from '../harness/makeRunState';
import { PACE_TABLE } from '@game/travel/paceRations';
import type { Pace } from '@game/types';
import { TLB_ENTRIES, TOTAL_FRAMES } from '@legs/allocation_yards/config';

const leg = await loadLegForTest('allocation_yards');
const INERT_TICKS = 400;
const run = (pace: Pace = 'steady') => makeRunState({ seed: 0x4b54524c, legIndex: 7, pace });

describe('the Allocation Yards kernel configuration', () => {
  it('enables process, scheduler and memory, and never vm', () => {
    const config = leg.kernelConfig(run());
    expect([...config.enabledSubsystems]).toEqual(['process', 'scheduler', 'memory']);
    expect(config.enabledSubsystems).not.toContain('vm');
    expect(config.enabledSubsystems).not.toContain('security');
  });

  it('freezes the yard at twenty one frames and the translation cache at sixteen entries', () => {
    const config = leg.kernelConfig(run());
    expect(config.totalFrames).toBe(TOTAL_FRAMES);
    expect(config.totalFrames).toBe(21);
    expect(config.tlbEntries).toBe(TLB_ENTRIES);
    expect(config.tlbEntries).toBe(16);
    expect(config.pageSize).toBe(4096);
    expect(config.allocationStrategy).toBe('first_fit');
  });

  it('takes its quantum from the pace table rather than from a function of its own', () => {
    for (const pace of ['conservative', 'steady', 'aggressive', 'reckless'] as const) {
      expect(leg.kernelConfig(run(pace)).schedulerParams.quantum).toBe(PACE_TABLE[pace].quantum);
    }
    expect(leg.kernelConfig(run()).schedulerParams.agingInterval).toBe(0);
  });

  it('never reads an inert field: poisoning every disabled subsystem leaves the log hash unchanged', async () => {
    const poisoned = withInertPoison(leg, run());
    expect(poisoned.fields).toEqual(expect.arrayContaining([
      'replacementPolicy', 'thrashingThreshold', 'diskPolicy', 'totalCylinders',
      'raidLevel', 'fileAllocation', 'journalingEnabled', 'deadlockStrategy',
    ]));
    const clean = await runLeg(leg, { seed: 0x4b54524c, run: run(), maxTicks: INERT_TICKS });
    const dirty = await runLeg(poisoned.leg, { seed: 0x4b54524c, run: run(), maxTicks: INERT_TICKS });
    expect(dirty.logHash, `poisoning ${poisoned.fields.join(', ')} changed the log`).toBe(clean.logHash);
  });

  it('evicts nothing and thrashes never across a full run, because vm is off', async () => {
    const result = await runLeg(leg, { seed: 0x4b54524c, run: run(), policy: 'competent' });
    expect(result.eventTypes.has('memory.page_evicted')).toBe(false);
    expect(result.eventTypes.has('memory.thrashing')).toBe(false);
    expect(result.eventTypes.has('memory.page_fault')).toBe(false);
    expect(result.panics).toEqual([]);
  });
});

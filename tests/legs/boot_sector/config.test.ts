/**
 * Acceptance 3 and 4: the enabled set is exactly process and scheduler, and
 * no inert field is read during a headless run.
 */
import { describe, expect, it } from 'vitest';
import { bootSector, content } from './leg';
import { kernelConfig } from '@legs/boot_sector/config';
import { runLeg, withInertPoison } from '../harness/LegHarness';
import { makeRunState } from '../harness/makeRunState';
import { knownGood } from './fixtures';

const INERT_TICKS = 400;

describe('boot_sector kernel configuration', () => {
  it('enables process and scheduler and nothing else, with the seed from the run', () => {
    const run = makeRunState({ seed: 0x1234, legIndex: 0 });
    const config = kernelConfig(run);
    expect(config.enabledSubsystems).toEqual(['process', 'scheduler']);
    expect(config.seed).toBe(0x1234);
    expect(config.scheduler).toBe('fcfs');
    expect(config.schedulerParams.agingInterval).toBe(0);
    expect(config.schedulerParams.preemptive).toBe(false);
    expect(config.schedulerParams.quantum).toBe(8);
    expect(config.schedulerParams.starvationThreshold).toBe(120);
    expect(config.schedulerParams.starvationFatalThreshold).toBe(300);
    expect(config.raidLevel).toBeNull();
    expect(config.journalingEnabled).toBe(false);
    expect(config.deadlockStrategy).toBe('ignore');
  });

  it('inert-field independence: every field a disabled subsystem owns can change without moving the log hash', async () => {
    const run = makeRunState({ seed: 1, legIndex: 0 });
    const poisoned = withInertPoison(bootSector, run);
    expect([...poisoned.fields].sort()).toEqual([
      'allocationStrategy', 'deadlockStrategy', 'diskPolicy', 'fileAllocation', 'journalingEnabled', 'pageSize', 'raidLevel',
      'replacementPolicy', 'thrashingThreshold', 'tlbEntries', 'totalCylinders', 'totalFrames',
    ]);
    const clean = await runLeg(bootSector, { seed: 1, maxTicks: INERT_TICKS, script: knownGood.script, content });
    const dirty = await runLeg(poisoned.leg, { seed: 1, maxTicks: INERT_TICKS, script: knownGood.script, content });
    expect(dirty.logHash).toBe(clean.logHash);
    expect(dirty.ledgerAfter).toEqual(clean.ledgerAfter);
  });
});

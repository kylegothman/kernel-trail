/**
 * WP-L04 acceptance 3 and 4: the subsystems this leg enables, the preemption
 * it depends on, the deadlock it deliberately does not report, and the
 * independence of every field it leaves inert.
 */
import { describe, expect, it } from 'vitest';
import { PACE_TABLE } from '@game/travel/paceRations';
import type { Pace } from '@game/types';
import theNarrows from '@legs/the_narrows';
import { runLeg, withInertPoison } from '../harness/LegHarness';
import { makeRunState } from '../harness/makeRunState';
import { knownBad, knownGood } from './fixtures';

const run = makeRunState({ seed: 0x4b54524c, legIndex: 4 });
const INERT_TICKS = 400;

describe('the kernel the Narrows asks for', () => {
  it('enables process, scheduler and sync, and nothing else', () => {
    expect(theNarrows.kernelConfig(run).enabledSubsystems).toEqual(['process', 'scheduler', 'sync']);
  });

  it('is preemptive round robin with aging off, because the interleaving needs one and the inversion needs the other', () => {
    const config = theNarrows.kernelConfig(run);
    expect(config.scheduler).toBe('rr');
    expect(config.schedulerParams.preemptive).toBe(true);
    expect(config.schedulerParams.agingInterval).toBe(0);
    expect(config.schedulerParams.starvationThreshold).toBe(120);
    expect(config.schedulerParams.starvationFatalThreshold).toBe(300);
  });

  it('takes its quantum from the pace table at every pace', () => {
    for (const pace of ['conservative', 'steady', 'aggressive', 'reckless'] as const satisfies readonly Pace[]) {
      const paced = makeRunState({ seed: 1, legIndex: 4, pace });
      expect(theNarrows.kernelConfig(paced).schedulerParams.quantum).toBe(PACE_TABLE[pace].quantum);
    }
  });

  it('leaves the journal off, which is what makes a corrupted manifest unrecoverable later', () => {
    expect(theNarrows.kernelConfig(run).journalingEnabled).toBe(false);
  });

  it('never emits deadlock.detected on either fixture path: the Cistern deadlocks and the Gridlock names it', async () => {
    for (const fixture of [knownGood, knownBad]) {
      const result = await runLeg(theNarrows, { seed: fixture.seed, script: fixture.script, run: makeRunState({ seed: fixture.seed, legIndex: 4, ledger: fixture.enteringLedger }) });
      expect(result.eventTypes.has('deadlock.detected'), `${fixture.path} emitted deadlock.detected`).toBe(false);
      expect(result.eventTypes.has('bankers.evaluated')).toBe(false);
    }
  });

  it(`reads no field a disabled subsystem owns, over ${INERT_TICKS} ticks`, async () => {
    const poisoned = withInertPoison(theNarrows, run);
    expect(poisoned.fields.length).toBeGreaterThan(0);
    const clean = await runLeg(theNarrows, { seed: 1, maxTicks: INERT_TICKS });
    const dirty = await runLeg(poisoned.leg, { seed: 1, maxTicks: INERT_TICKS });
    expect(dirty.logHash, `poisoning ${poisoned.fields.join(', ')} changed the log`).toBe(clean.logHash);
  });
});

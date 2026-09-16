/** WP-L07 acceptance 16 and the long fuse: the decision record the Arbiter Wall reads. */
import { describe, expect, it } from 'vitest';
import { createKernel } from '@kernel/Kernel';
import { createRng } from '@kernel/rng';
import { createHeadlessSetupContext } from '@game/replay/headlessLegs';
import { runFixture } from '../harness/fixtureContract';
import { runLeg } from '../harness/LegHarness';
import { loadLegForTest } from '../harness/loadLeg';
import { makeRunState } from '../harness/makeRunState';
import { INJECTION_PROGRESS } from '@legs/allocation_yards/protection';
import { knownBad, knownGood } from './fixtures';

const leg = await loadLegForTest('allocation_yards');
const entering = { cycles: 1022, quota: 900, blocks: 120, bandwidth: 60 } as const;

describe('the protection bits are the hardware\'s, not the leg\'s', () => {
  it('spawns every page non-executable, which is the state the injection needs cleared', () => {
    const run = makeRunState({ seed: 0x4b54524c, legIndex: 7 });
    const kernel = createKernel(leg.kernelConfig(run), { devBuild: true, checkInvariants: true });
    leg.populate(createHeadlessSetupContext(kernel, run, createRng(0x4b54524c, 'leg'), new Map()));
    for (const [, entries] of kernel.invariantState().pageTables) {
      for (const entry of entries) {
        expect(entry.readable).toBe(true);
        expect(entry.writable).toBe(true);
        expect(entry.executable).toBe(false);
      }
    }
  });

  it('records acceptance 16 as unwritable: with vm off the translation path has no execute check to exercise', () => {
    // WP-05 checks `readable` and `writable` in `DemandPager.checkProtection`,
    // which only runs with `vm` enabled, and the instruction stream has no
    // execute access at all. The leg records the decision and derives fault
    // from execution from it (pre-flight ruling 8); the kernel-side assertion
    // the package asks for cannot be written against the engine that shipped.
    const run = makeRunState({ seed: 0x4b54524c, legIndex: 7 });
    expect(leg.kernelConfig(run).enabledSubsystems).not.toContain('vm');
    console.log('protection: acceptance 16 kernel assertion is unwritable with vm disabled; filed against WP-05');
  });
});

describe('the fuse', () => {
  it('cleared before the injection: nothing is planted and the objective is met', async () => {
    const result = await runFixture(knownGood, leg);
    const decision = result.decisions.find((record) => record.kind === 'executable_bit');
    expect(decision).toBeDefined();
    expect(decision?.choice).toBe('cleared');
    expect(decision?.outcome).toBe('pending');
    expect(decision?.relatedObjective).toBe('obj.allocation_yards.protection_bits');
    expect(result.outcome.objectivesMet).toContain('obj.allocation_yards.protection_bits');
  });

  it('left set: the image is planted and the decision carries the tick, pending for leg 12', async () => {
    const result = await runFixture(knownBad, leg);
    const decision = result.decisions.find((record) => record.kind === 'executable_bit');
    expect(decision).toBeDefined();
    expect(decision?.choice).toBe('left_set');
    expect(decision?.outcome).toBe('pending');
    expect(decision?.legId).toBe('allocation_yards');
    expect(decision?.tick).toBeGreaterThan(0);
    expect(result.outcome.objectivesMet).not.toContain('obj.allocation_yards.protection_bits');
  });

  it('is too late at the bench once the injection has run', async () => {
    const late = await runLeg(leg, {
      seed: 0x4b54524c, run: makeRunState({ seed: 0x4b54524c, legIndex: 7, ledger: entering }),
      script: { legId: 'allocation_yards', label: 'late clear', steps: [
        { when: { kind: 'progress_at_least', value: INJECTION_PROGRESS }, command: { kind: 'interaction', id: 'yards.clear_executable', anchor: 'anchor.protection_bench' } },
      ] },
    });
    const records = late.decisions.filter((record) => record.kind === 'executable_bit');
    expect(records).toHaveLength(1);
    expect(records[0]?.choice).toBe('left_set');
  });

  it('writes nothing at all when the player takes no interaction after the injection', async () => {
    const quiet = await runLeg(leg, {
      seed: 0x4b54524c, run: makeRunState({ seed: 0x4b54524c, legIndex: 7, ledger: entering }),
      script: { legId: 'allocation_yards', label: 'quiet', steps: [] },
    });
    // Leg 12 then opens clean on its documented default, which is the hand-off
    // contract when the record is absent.
    expect(quiet.decisions.filter((record) => record.kind === 'executable_bit')).toEqual([]);
  });
});

describe('the debrief says one line and no more', () => {
  it('appends exactly one line, and names neither the wall nor the consequence', async () => {
    const result = await runFixture(knownBad, leg);
    const card = result.outcome.debrief;
    const lines = card.whatHappened.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('The data pages are still executable.');
    const text = `${card.headline} ${card.whatHappened} ${card.whyItHappened} ${card.counterfactual ?? ''}`.toLowerCase();
    for (const forbidden of ['arbiter', 'wall', 'ring 0', 'escalation', 'injection', 'warning', 'leg 12']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('says nothing at all when the bit was cleared', async () => {
    const result = await runFixture(knownGood, leg);
    expect(result.outcome.debrief.whatHappened).not.toContain('still executable');
    expect(result.outcome.debrief.whatHappened.split('\n')).toHaveLength(1);
  });
});

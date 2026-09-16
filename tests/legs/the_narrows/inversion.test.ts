/**
 * WP-L04 acceptance 13 and the third failure mode: the priority inversion.
 *
 * The sweep at priority 9 holds the manifest lock, the hauler at priority 5
 * preempts it, and SABLE at priority 1 waits behind both. The affliction lands
 * on the waiter, which is the part everyone gets backwards, and it lands once
 * for the episode rather than once a tick.
 */
import { describe, expect, it } from 'vitest';
import { asPid } from '@kernel/types';
import { LOCK_MANIFEST, enableInheritance, inheritanceEnabled } from '@legs/the_narrows/ledger';
import theNarrows from '@legs/the_narrows';
import { runLeg } from '../harness/LegHarness';
import { makeRunState } from '../harness/makeRunState';
import { narrowsKernel } from './kernelFixture';
import { knownBad, knownGood } from './fixtures';

describe('the inversion, in the kernel', () => {
  it('has the lowest-priority Program holding the lock the highest-priority one is blocked on', () => {
    const fixture = narrowsKernel();
    fixture.run(100);
    const holder = fixture.events('sync.acquired').find((event) => event.type === 'sync.acquired' && event.resource === LOCK_MANIFEST);
    const blocked = fixture.events('sync.blocked').find((event) => event.type === 'sync.blocked' && event.resource === LOCK_MANIFEST);
    if (holder?.type !== 'sync.acquired' || blocked?.type !== 'sync.blocked') throw new Error('the manifest lock was never contended');
    expect(fixture.pids.get('narrows.sweep')).toBe(holder.pid);
    expect(fixture.pids.get('SABLE')).toBe(blocked.pid);
    expect(holder.tick).toBeLessThan(blocked.tick);
  });

  it('reports the inversion with the waiter blocked, the holder ready and a medium Program interposed', () => {
    const fixture = narrowsKernel();
    let seen: { blocked: number; holder: number; interposed: number } | undefined;
    for (let tick = 0; tick < 160 && seen === undefined; tick += 2) {
      fixture.run(2);
      seen = fixture.kernel.syncSubsystem.priorities.inversions()[0];
    }
    expect(seen, 'no inversion was ever detected').toBeDefined();
    if (seen === undefined) return;
    expect(seen.blocked).toBe(fixture.pids.get('SABLE'));
    expect(seen.holder).toBe(fixture.pids.get('narrows.sweep'));
    const blocked = fixture.kernel.process(asPid(seen.blocked));
    const holder = fixture.kernel.process(asPid(seen.holder));
    const interposed = fixture.kernel.process(asPid(seen.interposed));
    expect(holder?.priority).toBeGreaterThan(blocked?.priority ?? 0);
    expect(interposed?.priority).toBeGreaterThan(blocked?.priority ?? 0);
    expect(interposed?.priority).toBeLessThan(holder?.priority ?? 40);
  });

  it('opens the lock when inheritance is switched on, and keeps it shut when it is not', () => {
    const withToggle = narrowsKernel();
    withToggle.run(40);
    enableInheritance(withToggle.kernel);
    expect(inheritanceEnabled(withToggle.kernel)).toBe(true);
    withToggle.run(140);
    const handedOver = withToggle.events('sync.released').filter((event) => event.type === 'sync.released' && event.resource === LOCK_MANIFEST);
    expect(handedOver.length, 'the holder should finish its section once inheritance is on').toBeGreaterThan(0);

    const without = narrowsKernel();
    without.run(160);
    const blocked = without.events('sync.blocked').find((event) => event.type === 'sync.blocked' && event.resource === LOCK_MANIFEST);
    expect(blocked, 'SABLE should be waiting').toBeDefined();
    const released = without.events('sync.released').filter((event) => event.type === 'sync.released' && event.resource === LOCK_MANIFEST);
    expect(released, 'left alone the holder never reaches the end of its hold').toEqual([]);
  });
});

describe('the affliction, in the convoy', () => {
  it('lands on the waiter and never on the holder, which is the part that reads backwards', async () => {
    const result = await runLeg(theNarrows, {
      seed: knownBad.seed, script: knownBad.script,
      run: makeRunState({ seed: knownBad.seed, legIndex: 4, ledger: knownBad.enteringLedger }),
    });
    const sable = result.run.convoy.find((member) => member.id === 'sable');
    const stone = result.run.tombstones.find((epitaph) => epitaph.member === 'sable');
    const carried = sable?.afflictions.some((affliction) => affliction.id === 'priority_inversion') === true;
    expect(carried || stone !== undefined, 'SABLE should have carried the inversion').toBe(true);
    // The sweep and the hauler are unbound Programs; no convoy member other
    // than the waiter can pick this up, because none of them holds the lock.
    for (const member of result.run.convoy) {
      if (member.id === 'sable') continue;
      expect(member.afflictions.map((affliction) => affliction.id), member.id).not.toContain('priority_inversion');
    }
  });

  it('inflicts once for the episode rather than once a tick', async () => {
    const result = await runLeg(theNarrows, {
      seed: knownBad.seed, script: knownBad.script,
      run: makeRunState({ seed: knownBad.seed, legIndex: 4, ledger: knownBad.enteringLedger }),
    });
    for (const member of result.run.convoy) {
      const inversions = member.afflictions.filter((affliction) => affliction.id === 'priority_inversion');
      expect(inversions.length, member.id).toBeLessThanOrEqual(1);
    }
  });

  it('is cleared by the toggle on the known-good path, and SABLE crosses alive', async () => {
    const result = await runLeg(theNarrows, {
      seed: knownGood.seed, script: knownGood.script,
      run: makeRunState({ seed: knownGood.seed, legIndex: 4, ledger: knownGood.enteringLedger }),
    });
    const sable = result.run.convoy.find((member) => member.id === 'sable');
    expect(sable?.status).not.toBe('derezzed');
    expect(result.outcome.casualties).toEqual([]);
    expect(result.decisions.some((record) => record.kind === 'interaction' && record.choice.startsWith('narrows.toggle_inheritance'))).toBe(true);
  });
});

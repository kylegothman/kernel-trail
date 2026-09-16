/**
 * WP-L04 acceptance 8, and the third misconception.
 *
 * The switch is wired to one core and the wide ford is four, which is the
 * lesson: disabling interrupts is a single-processor answer to a
 * multiprocessor problem. The scheduler dispatches one Program per tick, so
 * there is no per-core interrupt mask for the switch to act on and the effect
 * cannot be demonstrated in the kernel. The verb is recorded and charged, the
 * crossing it stands at is declared four cores against the other two at one,
 * and the debrief states the one-core truth in as many words.
 */
import { describe, expect, it } from 'vitest';
import theNarrows from '@legs/the_narrows';
import { CORES, PLANK, SECOND_FORD, WIDE_FORD, WIDE_FORD_3, WIDE_FORD_4 } from '@legs/the_narrows/crossings';
import { DISABLE_INTERRUPTS, handlers } from '@legs/the_narrows/interactions';
import { INTERRUPT_NOTE } from '@legs/the_narrows/copy';
import { runLeg } from '../harness/LegHarness';
import { makeRunState } from '../harness/makeRunState';
import { narrowsKernel } from './kernelFixture';
import { knownGood } from './fixtures';

describe('the interrupt switch', () => {
  it('stands at its own anchor and costs eight cycles', () => {
    const def = theNarrows.interactions.find((entry) => entry.id === DISABLE_INTERRUPTS);
    expect(def?.anchor).toBe('anchor.interrupt_switch');
    expect(def?.cost).toEqual({ cycles: 8 });
    expect(def?.enabledWhen(makeRunState({ seed: 1, legIndex: 4 }))).toBe(true);
    expect(def?.enabledWhen({ ...makeRunState({ seed: 1, legIndex: 4 }), resources: { cycles: 4, quota: 1, blocks: 1, bandwidth: 1 } })).toBe(false);
  });

  it('changes no kernel state, because there is no per-core mask for it to change', () => {
    const fixture = narrowsKernel();
    fixture.run(40);
    const before = fixture.kernel.snapshot();
    handlers[DISABLE_INTERRUPTS]?.run(makeRunState({ seed: 1, legIndex: 4 }), before.tick, fixture.kernel);
    const after = fixture.kernel.snapshot();
    expect(after.syncPrimitives).toEqual(before.syncPrimitives);
    expect(after.tick).toBe(before.tick);
  });

  it('is offered at the four-core crossing, where the other three cores never received an interrupt to disable', () => {
    expect(CORES[WIDE_FORD]).toBe(4);
    expect(CORES[WIDE_FORD_3]).toBe(4);
    expect(CORES[WIDE_FORD_4]).toBe(4);
    expect(CORES[PLANK]).toBe(1);
    expect(CORES[SECOND_FORD]).toBe(1);
  });

  it('says so in the debrief when the player used it, rather than pretending it worked', async () => {
    const withSwitch = {
      ...knownGood.script,
      label: 'the narrows, with the switch thrown',
      steps: [...knownGood.script.steps, { at: 50, command: { kind: 'interaction' as const, id: DISABLE_INTERRUPTS, anchor: 'anchor.interrupt_switch' } }],
    };
    const result = await runLeg(theNarrows, {
      seed: knownGood.seed, script: withSwitch,
      run: makeRunState({ seed: knownGood.seed, legIndex: 4, ledger: knownGood.enteringLedger }),
    });
    expect(result.decisions.some((record) => record.kind === 'interaction' && record.choice.startsWith(DISABLE_INTERRUPTS))).toBe(true);
    expect(result.outcome.debrief.whyItHappened).toContain(INTERRUPT_NOTE);
    expect(INTERRUPT_NOTE).toContain('one core');
    expect(INTERRUPT_NOTE).toContain('four');
  });
});

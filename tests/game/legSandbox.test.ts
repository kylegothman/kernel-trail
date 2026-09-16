import { describe, expect, it, vi } from 'vitest';
import { createKernel } from '../../src/kernel/Kernel';
import { createRng } from '../../src/kernel/rng';
import { LegSandbox, type LegFailure } from '../../src/game/LegSandbox';
import { createHeadlessSetupContext } from '../../src/game/replay/headlessLegs';
import { initialRunState } from '../../src/game/replay/runReplay';
import type { InteractionDef, Leg, LegEvaluationContext, RandomEventDef } from '../../src/game/types';
import { createSyntheticLeg, SYNTHETIC_CHAPTER, syntheticConfig } from './fixtures/syntheticLeg';

const FAIL = new Error('synthetic leg entry point failed');
const throws = (): never => { throw FAIL; };

function rig(patch: Partial<Leg> = {}) {
  const leg: Leg = { ...createSyntheticLeg(), ...patch };
  const run = initialRunState(23, 'shell', 'operator');
  const reports: { failure: LegFailure; leg: Leg }[] = [];
  const sandbox = new LegSandbox(leg, (failure, source) => reports.push({ failure, leg: source }));
  const kernel = createKernel(syntheticConfig(run.seed));
  const setup = createHeadlessSetupContext(kernel, run, createRng(run.seed, 'sandbox'), new Map());
  const evaluation: LegEvaluationContext = { run, kernelSnapshot: kernel.snapshot(), events: [], ticksElapsed: 0 };
  return { sandbox, leg, run, reports, setup, evaluation };
}

function event(onlyIf: RandomEventDef['onlyIf']): RandomEventDef {
  return { id: 'synthetic.predicate', weight: 100, title: 'Predicate fixture', narration: 'Predicate fixture.', targets: null, inflicts: null, resourceDelta: {}, onlyIf };
}

describe('LegSandbox', () => {
  it('kernelConfig failure returns null, reports its phase and leaves the run unchanged', () => {
    const r = rig({ kernelConfig: throws });
    const before = structuredClone(r.run);
    expect(r.sandbox.kernelConfig(r.run)).toBeNull();
    expect(r.run).toEqual(before);
    expect(r.sandbox.degraded).toBe(true);
    expect(r.sandbox.failureList).toEqual([{ phase: 'kernelConfig', error: FAIL }]);
    expect(r.reports).toEqual([{ failure: { phase: 'kernelConfig', error: FAIL }, leg: r.leg }]);
  });

  it('populate failure returns false and the next healthy leg still populates', () => {
    const failed = rig({ populate: throws });
    expect(failed.sandbox.populate(failed.setup)).toBe(false);
    expect(failed.sandbox.failureList).toEqual([{ phase: 'populate', error: FAIL }]);
    const healthy = rig();
    expect(healthy.sandbox.populate(healthy.setup)).toBe(true);
    expect(healthy.sandbox.degraded).toBe(false);
  });

  it('createStage failure supplies the harmless null stage', () => {
    const r = rig({ createStage: throws });
    const stage = r.sandbox.createStage({ quality: 'low', run: r.run });
    expect(() => stage.update(1 / 20, 0)).not.toThrow();
    expect(stage.anchor('missing')).toBeNull();
    expect(() => stage.dispose()).not.toThrow();
    expect(r.sandbox.failureList).toEqual([{ phase: 'createStage', error: FAIL }]);
  });

  it('update failure disables further updates and records only the first throw', () => {
    const update = vi.fn(throws);
    const r = rig({ createStage: () => ({ update, anchor: () => null, dispose: () => undefined }) });
    const stage = r.sandbox.createStage({ quality: 'high', run: r.run });
    for (let frame = 0; frame < 60; frame += 1) stage.update(1 / 20, 0.5);
    expect(update).toHaveBeenCalledTimes(1);
    expect(r.sandbox.failureList).toEqual([{ phase: 'update', error: FAIL }]);
    expect(r.reports).toHaveLength(1);
  });

  it('anchor and dispose exceptions never escape the wrapped stage', () => {
    const r = rig({ createStage: () => ({ update: () => undefined, anchor: throws, dispose: throws }) });
    const stage = r.sandbox.createStage({ quality: 'medium', run: r.run });
    expect(stage.anchor('broken')).toBeNull();
    expect(() => stage.dispose()).not.toThrow();
    expect(r.sandbox.failureList).toEqual([]);
  });

  it('evaluate failure returns the exact neutral outcome and preserves convoy and resources', () => {
    const r = rig({ evaluate: throws });
    const before = structuredClone(r.run);
    expect(r.sandbox.evaluate(r.evaluation)).toEqual({
      survived: true, objectivesMet: [], casualties: [], resourceDelta: {}, codexUnlocked: [],
      debrief: {
        headline: 'Leg completed with reduced instrumentation',
        whatHappened: 'This segment finished, but part of its scoring module failed and its result could not be judged.',
        whyItHappened: 'A fault in the leg module, not in your decisions. Nothing has been taken from the convoy.',
        counterfactual: null,
        chapter: SYNTHETIC_CHAPTER,
      },
    });
    expect(r.run).toEqual(before);
    expect(r.sandbox.failureList).toEqual([{ phase: 'evaluate', error: FAIL }]);
  });

  it('neutral outcome uses the specified empty chapter fallback if no chapter exists', () => {
    const r = rig({ evaluate: throws, chapters: [] });
    expect(r.sandbox.evaluate(r.evaluation).debrief.chapter).toEqual({ chapter: 1, sections: [], title: '' });
  });

  it('event and interaction predicate failures return false and record interaction diagnostics', () => {
    const r = rig();
    const before = structuredClone(r.run);
    const interaction: InteractionDef = { id: 'broken', label: 'Broken', description: 'Synthetic predicate.', anchor: 'fixture', cost: {}, enabledWhen: throws };
    expect(r.sandbox.predicate(event(throws), r.run)).toBe(false);
    expect(r.sandbox.predicate(interaction, r.run)).toBe(false);
    expect(r.sandbox.failureList).toEqual([
      { phase: 'interaction', error: FAIL }, { phase: 'interaction', error: FAIL },
    ]);
    expect(r.run).toEqual(before);
  });

  it('healthy entry points and predicate values pass through without diagnostics', () => {
    const anchor = { fixture: true };
    const update = vi.fn();
    const dispose = vi.fn();
    const r = rig({ createStage: () => ({ update, anchor: () => anchor, dispose }) });
    expect(r.sandbox.kernelConfig(r.run)).toEqual(r.leg.kernelConfig(r.run));
    expect(r.sandbox.populate(r.setup)).toBe(true);
    const stage = r.sandbox.createStage({ quality: 'high', run: r.run });
    stage.update(0.05, 0.25);
    expect(update).toHaveBeenCalledWith(0.05, 0.25);
    expect(stage.anchor('present')).toBe(anchor);
    stage.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(r.sandbox.evaluate(r.evaluation)).toEqual(r.leg.evaluate(r.evaluation));
    expect(r.sandbox.predicate(event(null), r.run)).toBe(true);
    expect(r.sandbox.predicate(event(() => false), r.run)).toBe(false);
    expect(r.sandbox.predicate(event(() => true), r.run)).toBe(true);
    expect(r.sandbox.failureList).toEqual([]);
    expect(r.sandbox.degraded).toBe(false);
  });
});

/**
 * WP-L04 acceptance 6 and WP-21 section 16, hand-off 6: the number on the far
 * post leaves the leg as a `DecisionRecord` so the Archive can read it nine
 * legs later. It is written on every run, and its outcome says whether the
 * convoy is carrying a manifest that two Programs disagreed about.
 */
import { describe, expect, it } from 'vitest';
import theNarrows from '@legs/the_narrows';
import { MANIFEST_SEED } from '@legs/the_narrows/evaluate';
import { HANDOFFS, HANDOFF_KINDS } from '../harness/journey';
import { runLeg } from '../harness/LegHarness';
import { makeRunState } from '../harness/makeRunState';
import { knownBad, knownGood } from './fixtures';

const play = async (fixture: typeof knownGood) => runLeg(theNarrows, {
  seed: fixture.seed, script: fixture.script,
  run: makeRunState({ seed: fixture.seed, legIndex: 4, ledger: fixture.enteringLedger }),
});

describe('the manifest leaves the leg', () => {
  it('is the kind the journey harness watches for, from this leg to the Archive', () => {
    const spec = HANDOFFS.find((entry) => entry.handoff === 6);
    expect(spec?.producer).toBe('the_narrows');
    expect(spec?.consumer).toBe('the_archive');
    expect(spec?.kinds).toEqual([MANIFEST_SEED]);
    expect(HANDOFF_KINDS.has(MANIFEST_SEED)).toBe(true);
  });

  it('is written on every run and reaches the run state, which is the seam evaluate needed', async () => {
    for (const fixture of [knownGood, knownBad]) {
      const result = await play(fixture);
      const records = result.run.decisions.filter((record) => record.kind === MANIFEST_SEED);
      expect(records, `${fixture.path} wrote no manifest record`).toHaveLength(1);
      const record = records[0];
      expect(record?.legId).toBe('the_narrows');
      expect(Number.isSafeInteger(Number(record?.choice))).toBe(true);
    }
  });

  it('is marked costly when the post disagrees with the convoy, and good when it does not', async () => {
    const bad = await play(knownBad);
    const record = bad.run.decisions.find((entry) => entry.kind === MANIFEST_SEED);
    expect(record?.outcome).toBe('costly');
    expect(bad.outcome.debrief.headline).toBe('The manifest is wrong.');
    expect(bad.outcome.debrief.counterfactual).toContain('The manifest you are carrying reads');
  });

  it('carries the number the far post actually holds, not the number it should have held', async () => {
    const bad = await play(knownBad);
    const record = bad.run.decisions.find((entry) => entry.kind === MANIFEST_SEED);
    expect(bad.outcome.debrief.whatHappened).toContain(`the far post reads ${record?.choice ?? ''}`);
  });

  it('is not a command kind, so replay counts it as leg data and rides it through verbatim', () => {
    expect(MANIFEST_SEED).toBe('manifest_seed');
    expect(['set_scheduler', 'set_pace', 'interaction', 'terminal', 'crossing']).not.toContain(MANIFEST_SEED);
  });
});

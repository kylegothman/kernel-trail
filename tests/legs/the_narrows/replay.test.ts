/**
 * WP-L04 acceptance 9 and 10, as the engine permits them.
 *
 * The shipped `trace --replay` handler refuses the flag and the shadow kernel
 * a leg would drive is not part of the leg-visible surface, so the leg does
 * not build a second one. What it does instead is the property that made the
 * promise worth making: the whole leg replays from its seed and its decision
 * log alone and produces the identical event log, which is what lets a fix be
 * proved against the interleaving that broke it.
 *
 * This is also the check that the workload seam reaches the replay path: the
 * replay populates through the same `populateHeadless`, so a program that did
 * not arrive there would diverge on the first sync instruction.
 */
import { describe, expect, it } from 'vitest';
import { runReplay } from '@game/replay/runReplay';
import theNarrows from '@legs/the_narrows';
import { MANIFEST_SEED } from '@legs/the_narrows/evaluate';
import { runLeg } from '../harness/LegHarness';
import { makeRunState } from '../harness/makeRunState';
import { knownBad, knownGood } from './fixtures';

const play = async (fixture: typeof knownGood) => runLeg(theNarrows, {
  seed: fixture.seed, script: fixture.script,
  run: makeRunState({ seed: fixture.seed, legIndex: 4, ledger: fixture.enteringLedger }),
});

describe('the leg replays from its own decision log', () => {
  it.each([['good', knownGood], ['bad', knownBad]] as const)('%s: the replayed event log hashes identically to the run', async (_label, fixture) => {
    const result = await play(fixture);
    expect(result.entry, 'the run recorded no replay entry').not.toBeNull();
    if (result.entry === null) return;
    const replay = runReplay({
      seed: fixture.seed,
      discClass: fixture.discClass,
      difficulty: fixture.difficulty,
      legs: ['the_narrows'],
      decisions: result.run.decisions,
      overrides: { suppressRecordedPolicyChanges: false },
      maxTicks: 20_000,
      entry: result.entry,
    });
    expect(replay.ok, replay.ok ? '' : replay.message).toBe(true);
    if (!replay.ok) return;
    expect(replay.diagnostics.legs).toHaveLength(1);
    expect(replay.diagnostics.legs[0]?.eventLogHash).toBe(result.logHash);
    expect(replay.diagnostics.legs[0]?.ticks).toBe(result.ticks);
  });

  it('counts the manifest hand-off as leg data rather than a decision it can dispatch', async () => {
    const result = await play(knownGood);
    if (result.entry === null) throw new Error('no replay entry');
    const replay = runReplay({
      seed: knownGood.seed, discClass: knownGood.discClass, difficulty: knownGood.difficulty,
      legs: ['the_narrows'], decisions: result.run.decisions,
      overrides: { suppressRecordedPolicyChanges: false }, maxTicks: 20_000, entry: result.entry,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    const handoffs = result.run.decisions.filter((record) => record.kind === MANIFEST_SEED).length;
    expect(handoffs).toBe(1);
    // The hand-off is one of the records replay cannot dispatch, alongside the
    // modal openings the runner writes for itself. What matters is that none
    // of them changes the log: the hashes above already agreed.
    expect(replay.diagnostics.skippedDecisions).toBeGreaterThanOrEqual(handoffs);
  });

  it('replays the same run twice to the same hash, which is what the replay claim rests on', async () => {
    const first = await play(knownGood);
    const second = await play(knownGood);
    expect(second.logHash).toBe(first.logHash);
    expect(second.ticks).toBe(first.ticks);
    expect(second.outcome.objectivesMet).toEqual(first.outcome.objectivesMet);
  });

  it('leaves the live log and the run state untouched: a replay allocates its own store and kernel', async () => {
    const result = await play(knownGood);
    if (result.entry === null) throw new Error('no replay entry');
    const decisionsBefore = result.run.decisions.length;
    const hashBefore = result.logHash;
    const eventsBefore = result.events.length;
    for (let round = 0; round < 2; round += 1) {
      const replay = runReplay({
        seed: knownGood.seed, discClass: knownGood.discClass, difficulty: knownGood.difficulty,
        legs: ['the_narrows'], decisions: result.run.decisions,
        overrides: { suppressRecordedPolicyChanges: false }, maxTicks: 20_000, entry: result.entry,
      });
      expect(replay.ok).toBe(true);
    }
    expect(result.run.decisions).toHaveLength(decisionsBefore);
    expect(result.logHash).toBe(hashBefore);
    expect(result.events).toHaveLength(eventsBefore);
  });
});

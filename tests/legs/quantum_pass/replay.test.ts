/**
 * WP-L03 acceptance 10 and 11: the `gantt --replay` contract. The shadow run
 * reproduces the live run byte for byte under the policy that ran, touches
 * neither the live event log nor the live `RunState`, and returns two ribbons
 * on one time axis with the tick they diverge at.
 *
 * Scope correction section 4: the shipped `gantt` handler is WP-15's and a leg
 * writes none. What the leg owns is the state that handler reads, which is
 * this module, and the debrief's counterfactual runs on the same road.
 */
import { describe, expect, it } from 'vitest';
import { canonicalise } from '@game/save';
import { hashEventLog } from '@game/replay/hash';
import type { SchedulerId } from '@kernel/types';

import { divergenceTick, renderRibbon, replayArrivalSet, shadowLeg } from '@legs/quantum_pass/replay';
import { ALL_POLICIES, segment } from '@legs/quantum_pass/segments';
import type { DecisionScript } from '../harness/decisionScript';
import { runLeg } from '../harness/LegHarness';
import { makeRunState } from '../harness/makeRunState';
import { loadLegForTest } from '../harness/loadLeg';

/** Loaded through the registry so the companion is remembered and the director can dispatch an interaction. */
const leg = await loadLegForTest('quantum_pass');

const SEED = 0x4b54524c;
const REPLAYS = 200;
const entering = (): ReturnType<typeof makeRunState> => makeRunState({ seed: SEED, legIndex: 3, pace: 'steady', ledger: { cycles: 1425 } });

/** The leg played straight through under one policy, committed at the first tick. */
function underPolicy(policy: SchedulerId): DecisionScript {
  return { legId: 'quantum_pass', label: `under ${policy}`, steps: [{ at: 0, command: { kind: 'set_scheduler', to: policy } }] };
}

describe('gantt --replay', () => {
  it('reproduces the live run byte for byte under each of the seven policies (acceptance 10)', async () => {
    for (const policy of ALL_POLICIES) {
      const live = await runLeg(leg, { seed: SEED, script: underPolicy(policy), run: entering() });
      const mirror = shadowLeg({ run: live.run, pace: 'steady', ticks: live.ticks, policy, keepRecordedChanges: true });
      expect(mirror.hash, `${policy}: the shadow log differs from the live log`).toBe(live.logHash);
      expect(mirror.ticks, policy).toBe(live.ticks);
      expect(mirror.events.length, policy).toBe(live.events.length);
    }
  });

  it('reproduces the live run byte for byte on the passive pass at every pace', async () => {
    for (const pace of ['conservative', 'steady', 'aggressive', 'reckless'] as const) {
      const live = await runLeg(leg, { seed: SEED, run: makeRunState({ seed: SEED, legIndex: 3, pace, ledger: { cycles: 1425 } }) });
      const mirror = shadowLeg({ run: live.run, pace, ticks: live.ticks, policy: 'priority', keepRecordedChanges: true });
      expect(mirror.hash, pace).toBe(live.logHash);
    }
  });

  it('mutates neither the live log nor the live run state, over two hundred replays (acceptance 11)', async () => {
    const live = await runLeg(leg, { seed: SEED, run: entering() });
    const logBefore = hashEventLog(live.events);
    const runBefore = canonicalise(live.run);
    for (let index = 0; index < REPLAYS; index++) {
      const policy = ALL_POLICIES[index % ALL_POLICIES.length] ?? 'priority';
      shadowLeg({ run: live.run, pace: 'steady', ticks: live.ticks, policy, keepRecordedChanges: false });
    }
    expect(hashEventLog(live.events)).toBe(logBefore);
    expect(canonicalise(live.run)).toBe(runBefore);
  }, 60_000);

  it('returns two ribbons on one time axis that diverge where the policies first disagree', async () => {
    const live = await runLeg(leg, { seed: SEED, run: entering() });
    const actual = shadowLeg({ run: live.run, pace: 'steady', ticks: live.ticks, policy: 'priority', keepRecordedChanges: true });
    const alternative = shadowLeg({ run: live.run, pace: 'steady', ticks: live.ticks, policy: 'fcfs', keepRecordedChanges: false });
    expect(actual.ribbon.ticks).toBe(alternative.ribbon.ticks);
    const tick = divergenceTick(actual.ribbon, alternative.ribbon);
    expect(tick).not.toBeNull();
    // Before the divergence the two ribbons name the same process in every tick; at it they do not.
    const holder = (ribbon: typeof actual.ribbon, at: number): string | null => ribbon.segments.find((band) => band.start <= at && at < band.end)?.name ?? null;
    for (let at = 0; at < (tick ?? 0); at++) expect(holder(actual.ribbon, at), `tick ${at}`).toBe(holder(alternative.ribbon, at));
    expect(holder(actual.ribbon, tick ?? 0)).not.toBe(holder(alternative.ribbon, tick ?? 0));
  });

  it('replaying the same policy twice gives the same ribbon and the same metrics', async () => {
    const live = await runLeg(leg, { seed: SEED, run: entering() });
    const first = shadowLeg({ run: live.run, pace: 'steady', ticks: live.ticks, policy: 'sjf', keepRecordedChanges: false });
    const second = shadowLeg({ run: live.run, pace: 'steady', ticks: live.ticks, policy: 'sjf', keepRecordedChanges: false });
    expect(second.hash).toBe(first.hash);
    expect(renderRibbon(second.ribbon)).toBe(renderRibbon(first.ribbon));
    expect(second.metrics).toEqual(first.metrics);
  });

  it('draws the switch cost as area, one gap per dispatch', async () => {
    const live = await runLeg(leg, { seed: SEED, run: entering() });
    const mirror = shadowLeg({ run: live.run, pace: 'steady', ticks: live.ticks, policy: 'priority', keepRecordedChanges: true });
    const dispatches = mirror.events.filter((event) => event.type === 'context.switch' && event.to !== null).length;
    expect(mirror.ribbon.gaps).toHaveLength(dispatches);
    for (const gap of mirror.ribbon.gaps) expect(gap.width).toBeGreaterThan(0);
    // A gap sits at the boundary it was charged at, so the ribbon can draw overhead against the same axis as the work.
    for (const gap of mirror.ribbon.gaps) expect(mirror.ribbon.segments.some((band) => band.start === gap.at)).toBe(true);
  });

  it('runs an arrival set alone to completion, which is what the segment replay prints', () => {
    const rows = segment(2).rows;
    const run = replayArrivalSet({ rows, policy: 'sjf' });
    expect(run.perProcess.filter((row) => row.completion !== null)).toHaveLength(rows.length);
    // `SCHED-SJF-1`'s order exactly, under this leg's own names for the set: P4, P1, P3, P2.
    expect(renderRibbon(run.ribbon)).toBe('pass.sjf_4[0-3] pass.sjf_1[3-9] pass.sjf_3[9-16] pass.sjf_2[16-24]');
  });
});

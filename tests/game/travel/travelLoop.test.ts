import { describe, expect, it } from 'vitest';
import { createRng } from '@kernel/index';
import { applyDelta, refillBandwidth, startingLedger } from '@game/travel/ledger';
import type { LegId, Pace, TravelPolicy } from '@game/types';
import { LEG_SEGMENTS, DEPOT_LEGS } from '@game/travel/segments';
import { PACE_TABLE } from '@game/travel/paceRations';
import { advance, createTravelState, drawsDue, legProgress, remainingTravelCharge, ticksForLeg } from '@game/travel/TravelLoop';

function simulate(legId: LegId, pace: Pace, onCredit = false) {
  const state = createTravelState(legId, onCredit);
  const policy: TravelPolicy = { pace, rations: 'standard', degreeOfMultiprogramming: 5 };
  let cycles = 0; let quota = 0; let draws = 0;
  while (legProgress(state) < 1) {
    const charge = remainingTravelCharge(state, policy, 5);
    cycles += charge.cycles; quota += charge.quota;
    advance(state, charge); draws += drawsDue(state);
  }
  return { state, cycles, quota, draws };
}
describe('travel integration', () => {
  it('keeps blocks and bandwidth nonnegative through 100,000 seeded economy ticks', () => {
    const rng = createRng(0x57403139, 'economy-floor-acceptance');
    const ledger = startingLedger('compiler', 'architect');
    let exhaustedBlocks = 0; let exhaustedBandwidth = 0; let gains = 0;
    for (let tick = 0; tick < 100_000; tick++) {
      const blockChange = rng.int(-90, 61);
      const bandwidthChange = rng.int(-45, 31);
      const previousBlocks = ledger.blocks; const previousBandwidth = ledger.bandwidth;
      applyDelta(ledger, { cycles: rng.int(-40, 31) / 2, quota: rng.int(-25, 21) / 10,
        blocks: blockChange, bandwidth: bandwidthChange });
      expect(ledger.blocks).toBeGreaterThanOrEqual(0);
      expect(ledger.bandwidth).toBeGreaterThanOrEqual(0);
      if (previousBlocks + blockChange < 0) { expect(ledger.blocks).toBe(0); exhaustedBlocks++; }
      if (previousBandwidth + bandwidthChange < 0) { expect(ledger.bandwidth).toBe(0); exhaustedBandwidth++; }
      if (blockChange > 0 && bandwidthChange > 0) {
        expect(ledger.blocks).toBe(previousBlocks + blockChange);
        expect(ledger.bandwidth).toBe(previousBandwidth + bandwidthChange); gains++;
      }
      if (tick % 100 === 0) refillBandwidth(ledger, 'compiler', 'architect', tick % 1000 === 0);
    }
    expect(exhaustedBlocks).toBeGreaterThan(0); expect(exhaustedBandwidth).toBeGreaterThan(0); expect(gains).toBeGreaterThan(0);
  });
  it('contains 1020 travel segments, no Boot travel, and the seven authorised depots', () => {
    expect(Object.values(LEG_SEGMENTS).reduce((sum, n) => sum + n, 0)).toBe(1020);
    expect(simulate('boot_sector', 'steady')).toMatchObject({ cycles: 0, quota: 0, draws: 0, state: { ticksElapsed: 0 } });
    expect(DEPOT_LEGS).toEqual(['fork_fields', 'quantum_pass', 'the_cistern', 'allocation_yards', 'the_platters', 'the_archive', 'arbiter_wall']);
    expect(DEPOT_LEGS).not.toContain('drowned_reach');
  });
  it.each([
    ['conservative', 126, 134, 335, 13], ['steady', 200, 80, 200, 8],
    ['aggressive', 360, 54, 135, 5], ['reckless', 704, 39, 97.5, 4],
  ] as const)('uses the R8 runtime numbers for %s', (pace, cycles, ticks, quota, draws) => {
    const result = simulate('the_gridlock', pace);
    expect(result.cycles).toBeCloseTo(cycles, 8);
    expect(result.state.ticksElapsed).toBe(ticks);
    expect(result.quota).toBe(quota);
    expect(result.draws).toBe(draws);
    expect(drawsDue(result.state)).toBe(0);
    expect(legProgress(result.state)).toBe(1);
  });
  it('agrees with closed forms at every leg length and pace without a fractional tick', () => {
    for (const legId of Object.keys(LEG_SEGMENTS) as LegId[]) {
      for (const pace of Object.keys(PACE_TABLE) as Pace[]) {
        const result = simulate(legId, pace);
        expect(result.cycles).toBeCloseTo(LEG_SEGMENTS[legId] * PACE_TABLE[pace].effectiveCyclesPerSegment, 8);
        expect(result.state.ticksElapsed).toBe(ticksForLeg(legId, pace));
        expect(result.quota).toBe(ticksForLeg(legId, pace) * 2.5);
      }
    }
  });
  it('prorates only final movement and cycles, and leaves full integrity and quota', () => {
    const state = createTravelState('fork_fields'); state.segmentsDone = 59.8;
    const charge = remainingTravelCharge(state, { pace: 'reckless', rations: 'lean', degreeOfMultiprogramming: 1 }, 5);
    expect(charge.segments).toBeCloseTo(.2, 10);
    expect(charge.cycles).toBeCloseTo(1.76, 10);
    expect(charge.quota).toBe(1.5); expect(charge.integrityPerProgram).toBe(.3);
    advance(state, charge); expect(state.ticksElapsed).toBe(1); expect(state.segmentsDone).toBe(60);
  });
  it('credit travels conservatively for zero cycles and adds draws every20credit ticks', () => {
    const result = simulate('the_gridlock', 'reckless', true);
    expect(result.cycles).toBe(0); expect(result.state.ticksElapsed).toBe(134);
    expect(result.draws).toBe(19);
    const state = createTravelState('fork_fields');
    const policy: TravelPolicy = { pace: 'steady', rations: 'standard', degreeOfMultiprogramming: 5 };
    for (let tick = 0; tick < 19; tick++) { advance(state, remainingTravelCharge(state, policy, 5)); drawsDue(state); }
    state.onCredit = true;
    advance(state, remainingTravelCharge(state, policy, 5));
    expect(drawsDue(state)).toBe(1); expect(state.creditTicks).toBe(1);
    for (let tick = 1; tick < 20; tick++) { advance(state, remainingTravelCharge(state, policy, 5)); drawsDue(state); }
    expect(state.creditTicks).toBe(20); expect(state.drawsFired).toBe(4);
  });
});


describe('travel progress and event positions', () => {
  it.each(['conservative', 'steady', 'aggressive', 'reckless'] as const)
    ('keeps every non-Boot leg history monotonic and bounded at %s', (pace) => {
      const policy: TravelPolicy = { pace, rations: 'standard', degreeOfMultiprogramming: 5 };
      for (const legId of Object.keys(LEG_SEGMENTS) as LegId[]) {
        if (legId === 'boot_sector') continue;
        const state = createTravelState(legId);
        const history = [legProgress(state)];
        expect(history[0]).toBe(0);
        const expectedTicks = ticksForLeg(legId, pace);
        for (let tick = 1; tick <= expectedTicks; tick++) {
          const before = state.segmentsDone;
          advance(state, remainingTravelCharge(state, policy, 5));
          history.push(legProgress(state));
          expect(state.segmentsDone).toBeGreaterThan(before);
          expect(state.segmentsDone).toBeLessThanOrEqual(LEG_SEGMENTS[legId]);
          expect(state.ticksElapsed).toBe(tick);
        }
        expect(history).toHaveLength(expectedTicks + 1);
        for (let index = 1; index < history.length; index++) {
          expect(history[index]).toBeGreaterThan(history[index - 1]!);
          expect(history[index]).toBeLessThanOrEqual(1);
        }
        expect(history.at(-1)).toBe(1);
        expect(state.segmentsDone).toBe(LEG_SEGMENTS[legId]);
        const complete = structuredClone(state);
        for (let attempt = 0; attempt < 3; attempt++) {
          const charge = remainingTravelCharge(state, policy, 5);
          expect(charge).toEqual({ segments: 0, cycles: 0, quota: 0, integrityPerProgram: 0 });
          advance(state, charge);
          expect(state).toEqual(complete);
          expect(legProgress(state)).toBe(1);
        }
      }
    });

  it.each([
    ['conservative', 134, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130]],
    ['steady', 80, [10, 20, 30, 40, 50, 60, 70, 80]],
    ['aggressive', 54, [10, 20, 30, 40, 50]],
    ['reckless', 39, [10, 20, 30, 39]],
  ] as const)('draws at the exact 80-segment tick positions at %s', (pace, finalTick, expected) => {
    const state = createTravelState('the_gridlock');
    const policy: TravelPolicy = { pace, rations: 'standard', degreeOfMultiprogramming: 5 };
    const drawTicks: number[] = [];
    expect(drawsDue(state)).toBe(0);
    for (let tick = 1; tick <= finalTick; tick++) {
      advance(state, remainingTravelCharge(state, policy, 5));
      const due = drawsDue(state);
      expect(due).toBe(expected.some((at) => at === tick) ? 1 : 0);
      if (due === 1) drawTicks.push(state.ticksElapsed);
      expect(drawsDue(state)).toBe(0);
    }
    expect(drawTicks).toEqual(expected);
    expect(legProgress(state)).toBe(1);
  });

  it.each([
    ['the_gridlock', 'aggressive', 54, 4, [10, 20, 30, 40, 50]],
    ['the_narrows', 'steady', 75, 5, [10, 20, 30, 40, 50, 60, 70, 75]],
  ] as const)('trailing draw at %s/%s ends on tick %s with remainder %s', (legId, pace, finalTick, remainder, expected) => {
    const state = createTravelState(legId);
    const policy: TravelPolicy = { pace, rations: 'standard', degreeOfMultiprogramming: 5 };
    const drawTicks: number[] = [];
    for (let tick = 1; tick <= finalTick; tick++) {
      advance(state, remainingTravelCharge(state, policy, 5));
      const due = drawsDue(state);
      if (due > 0) drawTicks.push(state.ticksElapsed);
      if (tick === finalTick - 1) expect(legProgress(state)).toBeLessThan(1);
      if (tick === finalTick) expect(due).toBe(remainder === 5 ? 1 : 0);
    }
    expect(state.ticksElapsed % 10).toBe(remainder);
    expect(drawTicks).toEqual(expected);
    expect(legProgress(state)).toBe(1);
    expect(drawsDue(state)).toBe(0);
  });

  it('adds credit draws at exact twentieth ticks without moving ordinary draw positions', () => {
    const state = createTravelState('the_gridlock', true);
    const policy: TravelPolicy = { pace: 'reckless', rations: 'standard', degreeOfMultiprogramming: 5 };
    const at: (readonly [number, number])[] = [];
    for (let tick = 1; tick <= 134; tick++) {
      advance(state, remainingTravelCharge(state, policy, 5));
      const due = drawsDue(state);
      if (due > 0) at.push([state.ticksElapsed, due]);
      expect(drawsDue(state)).toBe(0);
    }
    expect(at).toEqual([[10, 1], [20, 2], [30, 1], [40, 2], [50, 1], [60, 2], [70, 1],
      [80, 2], [90, 1], [100, 2], [110, 1], [120, 2], [130, 1]]);
    expect(legProgress(state)).toBe(1);
    expect(state.drawsFired).toBe(19);
  });
});

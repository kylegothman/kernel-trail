import type { LegId, Pace, TravelPolicy } from '../types';
import { PACE_TABLE, RATIONS_TABLE, quotaPerTick } from './paceRations';
import { LEG_SEGMENTS } from './segments';

export interface TravelState {
  readonly legId: LegId;
  readonly segmentsTotal: number;
  segmentsDone: number;
  ticksElapsed: number;
  nextDrawAtTick: number;
  onCredit: boolean;
  drawsFired: number;
  /** Credit exposure counts only ticks after issuance, including mid-leg issuance. */
  creditTicks?: number;
}
export interface TravelCharge {
  readonly segments: number;
  readonly cycles: number;
  readonly quota: number;
  readonly integrityPerProgram: number;
}
export function createTravelState(legId: LegId, onCredit = false): TravelState {
  return { legId, segmentsTotal: LEG_SEGMENTS[legId], segmentsDone: 0, ticksElapsed: 0,
    nextDrawAtTick: 10, onCredit, drawsFired: 0, creditTicks: 0 };
}
export function travelCharge(policy: TravelPolicy, aliveCount: number): TravelCharge {
  const pace = PACE_TABLE[policy.pace];
  return { segments: pace.segmentsPerTick,
    cycles: pace.segmentsPerTick * pace.cyclesPerSegment * pace.quantumOverhead,
    quota: quotaPerTick(policy.rations, aliveCount),
    integrityPerProgram: RATIONS_TABLE[policy.rations].integrityCostPerTick };
}

/** R8: full final-tick quota and integrity; prorate only movement and cycles. */
export function remainingTravelCharge(state: TravelState, policy: TravelPolicy, aliveCount: number): TravelCharge {
  const charge = travelCharge(state.onCredit ? { ...policy, pace: 'conservative' } : policy, aliveCount);
  const segments = Math.min(charge.segments, Math.max(0, state.segmentsTotal - state.segmentsDone));
  if (segments === 0) return { segments: 0, cycles: 0, quota: 0, integrityPerProgram: 0 };
  return { ...charge, segments, cycles: state.onCredit ? 0 : charge.cycles * segments / charge.segments };
}
export function advance(state: TravelState, charge: TravelCharge): void {
  if (charge.segments <= 0 || state.segmentsDone >= state.segmentsTotal) return;
  // Snap insignificant floating-point residue so e.g. 60 / .6 takes exactly 100 ticks.
  const done = Math.min(state.segmentsTotal, state.segmentsDone + charge.segments);
  state.segmentsDone = state.segmentsTotal - done < 1e-9 ? state.segmentsTotal : done;
  state.ticksElapsed += 1;
  if (state.onCredit) state.creditTicks = (state.creditTicks ?? 0) + 1;
}
export function legProgress(state: TravelState): number {
  return state.segmentsTotal === 0 ? 1 : Math.max(0, Math.min(1, state.segmentsDone / state.segmentsTotal));
}
export function ticksForLeg(legId: LegId, pace: Pace): number {
  return Math.ceil(LEG_SEGMENTS[legId] / PACE_TABLE[pace].segmentsPerTick);
}

/** Consume scheduled draws once. Crossing draws are separate and do not call this. */
export function drawsDue(state: TravelState): number {
  const complete = state.segmentsDone >= state.segmentsTotal;
  const normal = Math.floor(state.ticksElapsed / 10) + (complete && state.ticksElapsed % 10 >= 5 ? 1 : 0);
  const credit = Math.floor((state.creditTicks ?? (state.onCredit ? state.ticksElapsed : 0)) / 20);
  const total = normal + credit;
  const due = Math.max(0, total - state.drawsFired);
  state.drawsFired += due;
  state.nextDrawAtTick = (Math.floor(state.ticksElapsed / 10) + 1) * 10;
  return due;
}

import type { AfflictionId, Pace, Rations } from '../types';

export interface PaceRow {
  readonly quantum: number;
  readonly segmentsPerTick: number;
  readonly cyclesPerSegment: number;
  readonly quantumOverhead: number;
  readonly effectiveCyclesPerSegment: number;
  readonly workloadArrivalRate: number;
}

/** Narrative bible 6.1; every column is independent reviewable source data. */
export const PACE_TABLE: Readonly<Record<Pace, PaceRow>> = {
  conservative: { quantum: 16, segmentsPerTick: 0.6, cyclesPerSegment: 1.4, quantumOverhead: 1.125, effectiveCyclesPerSegment: 1.575, workloadArrivalRate: 0.70 },
  steady: { quantum: 8, segmentsPerTick: 1.0, cyclesPerSegment: 2.0, quantumOverhead: 1.25, effectiveCyclesPerSegment: 2.50, workloadArrivalRate: 1.00 },
  aggressive: { quantum: 4, segmentsPerTick: 1.5, cyclesPerSegment: 3.0, quantumOverhead: 1.50, effectiveCyclesPerSegment: 4.50, workloadArrivalRate: 1.45 },
  reckless: { quantum: 2, segmentsPerTick: 2.1, cyclesPerSegment: 4.4, quantumOverhead: 2.00, effectiveCyclesPerSegment: 8.80, workloadArrivalRate: 2.00 },
};

export function quantumOverhead(quantum: number): number { return 1 + 2 / quantum; }

export interface RationsRow {
  readonly framesPerProgram: number;
  readonly integrityCostPerTick: number;
  readonly afflictionChancePerTick: number;
  readonly afflictionOnRoll: AfflictionId | null;
}

/** Narrative bible 6.2 pays for convoy memory; the kernel has its own allocation table. */
export const RATIONS_TABLE: Readonly<Record<Rations, RationsRow>> = {
  generous: { framesPerProgram: 4.0, integrityCostPerTick: 0, afflictionChancePerTick: 0, afflictionOnRoll: null },
  standard: { framesPerProgram: 2.5, integrityCostPerTick: 0, afflictionChancePerTick: 0, afflictionOnRoll: null },
  lean: { framesPerProgram: 1.5, integrityCostPerTick: 0.3, afflictionChancePerTick: 0.04, afflictionOnRoll: 'cache_thrash' },
  starved: { framesPerProgram: 0.8, integrityCostPerTick: 1.0, afflictionChancePerTick: 0.06, afflictionOnRoll: 'thrashing' },
};

export function quotaPerTick(rations: Rations, aliveCount: number): number {
  return RATIONS_TABLE[rations].framesPerProgram * aliveCount * 0.2;
}

import type { DifficultyTier, DiscClass, LegId, ResourceLedger } from '../types';
import { TIER_TABLE } from '../tiers';
import { PACE_TABLE } from './paceRations';
import { LEG_SEGMENTS } from './segments';

const STARTING: Readonly<Record<DiscClass, Readonly<ResourceLedger>>> = {
  shell: { cycles: 1600, quota: 900, blocks: 120, bandwidth: 60 },
  daemon: { cycles: 1100, quota: 650, blocks: 160, bandwidth: 45 },
  compiler: { cycles: 700, quota: 420, blocks: 90, bandwidth: 30 },
};

export function startingLedger(disc: DiscClass, tier: DifficultyTier): ResourceLedger {
  const base = STARTING[disc];
  const factor = TIER_TABLE[tier].resourceFactor;
  return { cycles: Math.floor(base.cycles * factor), quota: Math.floor(base.quota * factor),
    blocks: Math.floor(base.blocks * factor), bandwidth: Math.floor(base.bandwidth * factor) };
}

export function legDividend(legIndex: number, throughputFactor: number, disc: DiscClass): number {
  return (60 + 6 * legIndex) * Math.max(0.6, Math.min(1.4, throughputFactor)) * (disc === 'compiler' ? 1.25 : 1);
}

/** Mutate only a ledger owned by the caller's runStore.mutate callback. */
export function refillBandwidth(ledger: ResourceLedger, disc: DiscClass, tier: DifficultyTier, atDepot: boolean): void {
  ledger.bandwidth = startingLedger(disc, tier).bandwidth * (atDepot ? 1 : 0.6);
}

/** Event deltas floor every stock at zero. Optional spending must be admitted first. */
export function applyDelta(ledger: ResourceLedger, delta: Partial<ResourceLedger>): void {
  for (const resource of ['cycles', 'quota', 'blocks', 'bandwidth'] as const) {
    ledger[resource] = Math.max(0, ledger[resource] + (delta[resource] ?? 0));
  }
}

export function canAfford(ledger: Readonly<ResourceLedger>, cost: Partial<ResourceLedger>): boolean {
  return (['cycles', 'quota', 'blocks', 'bandwidth'] as const).every(resource => ledger[resource] >= (cost[resource] ?? 0));
}

export function emergencyCreditNeeded(ledger: ResourceLedger, legId: LegId): boolean {
  return ledger.cycles < LEG_SEGMENTS[legId] * PACE_TABLE.conservative.effectiveCyclesPerSegment;
}

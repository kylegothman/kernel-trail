import type { DifficultyTier } from './types';

export interface TierRow {
  readonly resourceFactor: number;
  readonly afflictionFrequency: number;
  readonly afflictionDrain: number;
  readonly fatalAfter: number;
  readonly policyChangeCost: number;
  /** WP-19 charges writes only; the shell must supply the future read audit hook. */
  readonly terminalCommandCost: number;
  readonly scoreMultiplier: number;
}

/** Narrative bible 13. Terminal read charges need the terminal track's audit hook. */
export const TIER_TABLE: Readonly<Record<DifficultyTier, TierRow>> = {
  novice: { resourceFactor: 1.35, afflictionFrequency: 0.60, afflictionDrain: 0.75, fatalAfter: 1.50, policyChangeCost: 0, terminalCommandCost: 0, scoreMultiplier: 0.5 },
  operator: { resourceFactor: 1.00, afflictionFrequency: 1.00, afflictionDrain: 1.00, fatalAfter: 1.00, policyChangeCost: 0, terminalCommandCost: 0, scoreMultiplier: 1.0 },
  architect: { resourceFactor: 0.80, afflictionFrequency: 1.35, afflictionDrain: 1.10, fatalAfter: 0.90, policyChangeCost: 15, terminalCommandCost: 1, scoreMultiplier: 1.6 },
  kernel_space: { resourceFactor: 0.65, afflictionFrequency: 1.70, afflictionDrain: 1.25, fatalAfter: 0.80, policyChangeCost: 25, terminalCommandCost: 2, scoreMultiplier: 2.5 },
};

export function afflictionFrequency(chance: number, tier: DifficultyTier = 'operator'): number {
  return Math.max(0, Math.min(1, chance * TIER_TABLE[tier].afflictionFrequency));
}

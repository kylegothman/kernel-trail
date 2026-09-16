import type { DifficultyTier } from '../types';

export type DepotItemId = 'quota_lot' | 'block_lot' | 'bandwidth_lot' | 'repair' | 'policy_hint' | 'journal_checkpoint' | 'recruit';

export const DEPOT_TIER_FACTOR: Readonly<Record<DifficultyTier, number>> = { novice: 0.80, operator: 1.00, architect: 1.15, kernel_space: 1.35 };
export const BASE_PRICES: Readonly<Record<DepotItemId, { readonly cycles: number; readonly blocks: number }>> = {
  quota_lot: { cycles: 50, blocks: 0 }, block_lot: { cycles: 30, blocks: 0 }, bandwidth_lot: { cycles: 20, blocks: 0 },
  repair: { cycles: 15, blocks: 8 }, policy_hint: { cycles: 60, blocks: 0 }, journal_checkpoint: { cycles: 90, blocks: 25 }, recruit: { cycles: 220, blocks: 40 },
};
export const DEPOT_ITEMS: readonly DepotItemId[] = ['quota_lot', 'block_lot', 'bandwidth_lot', 'repair', 'policy_hint', 'journal_checkpoint', 'recruit'];

export function price(base: number, legIndex: number, tier: DifficultyTier): number {
  return Math.round(base * (1 + 0.09 * legIndex) * DEPOT_TIER_FACTOR[tier]);
}

export function depotPrice(item: DepotItemId, legIndex: number, tier: DifficultyTier): { readonly cycles: number; readonly blocks: number } {
  return { cycles: price(BASE_PRICES[item].cycles, legIndex, tier), blocks: price(BASE_PRICES[item].blocks, legIndex, tier) };
}

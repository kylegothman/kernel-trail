import type { DiscClass } from '../types';

export interface ReclamationTally {
  readonly leakedFrames: number;
  readonly fragmentsCollected: number;
  readonly longestUnbrokenChain: number;
  readonly liveBlocksReclaimed: number;
}

export interface ReclamationYield {
  readonly quota: number;
  readonly blocks: number;
  readonly cycles: number;
  readonly coalesceMultiplier: number;
  readonly cleanSweepBonus: number;
  readonly classMultiplier: number;
  readonly returnsMultiplier: number;
}

/** Narrative 11.4 and R11: returns precede rounding; refund uses final quota. */
export function scoreReclamation(tally: ReclamationTally, disc: DiscClass, runIndex = 1): ReclamationYield {
  if (!Number.isInteger(runIndex) || runIndex < 1 || runIndex > 3) throw new RangeError('Reclamation runIndex must be 1, 2 or 3.');
  const coalesceMultiplier = Math.min(3, 1 + 0.15 * Math.max(0, tally.longestUnbrokenChain - 1));
  const cleanSweepBonus = tally.liveBlocksReclaimed === 0 ? 1.20 : 1.00;
  const classMultiplier = disc === 'compiler' ? 1.35 : 1.00;
  const returnsMultiplier = 0.6 ** (runIndex - 1);
  const quota = Math.max(0, tally.leakedFrames * cleanSweepBonus * classMultiplier - 25 * tally.liveBlocksReclaimed) * returnsMultiplier;
  const blocks = Math.round(tally.fragmentsCollected * 0.5 * coalesceMultiplier * returnsMultiplier);
  const cycles = Math.min(30, Math.floor(quota / 10));
  return { quota, blocks, cycles, coalesceMultiplier, cleanSweepBonus, classMultiplier, returnsMultiplier };
}

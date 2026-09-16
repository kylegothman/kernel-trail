import type { Rng } from '@kernel/index';
import type { DifficultyTier } from '../types';

export interface VergeFragment {
  readonly id: number;
  readonly frames: number;
  /** Normalised position around the Verge, shared with its adjacent neighbours. */
  readonly position: number;
  readonly adjacent: readonly number[];
}

export interface VergeBlock {
  readonly id: number;
  readonly frames: number;
  readonly position: number;
}

export interface VergeLayout {
  readonly f: number;
  readonly fragments: readonly VergeFragment[];
  readonly leaked: readonly VergeBlock[];
  readonly live: readonly VergeBlock[];
  readonly markDecaySeconds: number;
  readonly rotationDegPerSec: number;
  readonly adjacency: number;
  readonly seconds: number;
}

export const RECLAMATION_SECONDS: Readonly<Record<DifficultyTier, number>> = { novice: 90, operator: 75, architect: 65, kernel_space: 55 };

/** R10 preserves the seven generation formulas without claiming balance targets. */
export function generateVerge(f: number, rng: Rng, tier: DifficultyTier): VergeLayout {
  if (!Number.isFinite(f) || f < 0 || f > 1) throw new RangeError('externalFragmentation must be between 0 and 1.');
  const count = Math.round(20 + 90 * f);
  const leakedCount = Math.round(12 + 26 * f);
  const adjacency = 0.8 - 0.6 * f;
  const edges = Array.from({ length: count - 1 }, () => rng.next() < adjacency);
  const fragments: VergeFragment[] = Array.from({ length: count }, (_, id) => ({
    id, frames: 6 - 4.5 * f, position: rng.next(),
    adjacent: [...(edges[id - 1] === true ? [id - 1] : []), ...(edges[id] === true ? [id + 1] : [])],
  }));
  const leaked: VergeBlock[] = Array.from({ length: leakedCount }, (_, index) => ({ id: count + index, frames: 5.5 - 3.0 * f, position: rng.next() }));
  // A live block shares each leak's region, so every valuable region has visible risk.
  const live: VergeBlock[] = leaked.map((block, index) => ({ id: count + leakedCount + index, frames: block.frames, position: block.position }));
  // TODO(astra): reclamation balance pass specifies the layout and trace model
  return { f, fragments, leaked, live, markDecaySeconds: 12 - 10 * f, rotationDegPerSec: 4 + 16 * f, adjacency, seconds: RECLAMATION_SECONDS[tier] };
}

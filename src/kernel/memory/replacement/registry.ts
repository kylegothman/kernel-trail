import type { PageReplacementId } from '../../types';
import { FifoPolicy } from './fifo';
import type { PersistentReplacementPolicy } from './fifo';
import { LruPolicy } from './lru';
import { ClockPolicy } from './clock';
import { OptimalPolicy } from './optimal';
import { LfuPolicy } from './lfu';
import { RandomPolicy } from './random';

export type ReplacementOptions = { readonly lfuAging?: number };
export type ReplacementFactory = (options?: ReplacementOptions) => PersistentReplacementPolicy;
export const REPLACEMENT_POLICIES: Readonly<Record<PageReplacementId, ReplacementFactory>> = Object.freeze({
  fifo: () => new FifoPolicy(),
  lru: () => new LruPolicy(),
  clock: () => new ClockPolicy(),
  optimal: () => new OptimalPolicy(),
  lfu: (options: ReplacementOptions = {}) => new LfuPolicy(options.lfuAging),
  random: () => new RandomPolicy(),
});
export function createReplacementPolicy(id: PageReplacementId, options: ReplacementOptions = {}): PersistentReplacementPolicy {
  const create = REPLACEMENT_POLICIES[id];
  if (create === undefined) throw new Error(`unknown page replacement policy ${id}`);
  return create(options);
}
export type { PersistentReplacementPolicy } from './fifo';

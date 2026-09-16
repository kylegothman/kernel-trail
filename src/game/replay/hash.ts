/**
 * `hashEventLog` produces `ReplayResult.eventLogHash` and the per-leg hashes
 * in `ReplayRecord.legEventHashes`.
 *
 * It imports `canonicalise`, `fnv1a64` and `withoutMapsAndSets` from
 * `@game/save`, the same three functions the save checksum runs, so there is
 * exactly one canonical serialisation, one flattening rule and one FNV-1a 64
 * in the game layer (WP-18 scope correction U6). Three implementations of
 * the same hash would be three chances to diverge. `tests/kernel/canonical.ts`
 * is the kernel suite's own encoder and agrees with `canonicalise` byte for
 * byte on Map-free values, asserted by the `hash shared` case; its `hash` is a
 * 32-bit FNV-1a for fixture comparison and is deliberately not used here.
 */

import type { KernelEvent } from '@kernel/types';
import { canonicalise, fnv1a64, withoutMapsAndSets } from '@game/save';

export function hashEventLog(events: readonly KernelEvent[]): string {
  return fnv1a64(canonicalise(withoutMapsAndSets(events)));
}

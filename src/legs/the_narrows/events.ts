/**
 * KERNEL TRAIL, the Narrows: the event deck.
 *
 * Transcribed from `docs/04-NARRATIVE-BIBLE.md` section 8, "Leg 4. The
 * Narrows, Ch. 6", byte for byte and extracted from the document rather than
 * retyped. Seven entries, weights summing to exactly 100.
 */
import type { RandomEventDef } from '@game/types';

export const narrowsEvents: readonly RandomEventDef[] = [
  {
    id: 'narrows.race',
    weight: 14,
    title: 'Interleaved',
    narration: 'Two Programs read the same counter, both increment it, and both write it back. The counter advanced once and the record of what happened is now wrong.',
    targets: null, inflicts: null,
    resourceDelta: { blocks: -14, quota: -30 },
    onlyIf: null,
  },
  {
    id: 'narrows.spin_field',
    weight: 13,
    title: 'Mutual Courtesy',
    narration: 'Two Programs reach the gap together, both defer, both retry on the same tick, and do it again. They are running at full rate and neither has moved.',
    targets: null, inflicts: 'livelock',
    resourceDelta: { cycles: -35 },
    onlyIf: null,
  },
  {
    id: 'narrows.test_and_set_burn',
    weight: 13,
    title: 'Spinning',
    narration: 'The convoy holds the gate with a test-and-set loop while the holder is off the processor entirely. Every spin is a cycle spent proving the lock is still taken.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -60 },
    onlyIf: null,
  },
  {
    id: 'narrows.bounded_wait_violation',
    weight: 11,
    title: 'Unordered Queue',
    narration: 'The gate\'s wait queue has no ordering, so arrivals are woken in whatever sequence the Substrate finds convenient. One Program has been at the gate since before the convoy arrived.',
    targets: null, inflicts: 'starvation',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'narrows.peterson_marker',
    weight: 15,
    title: 'Two-Process Marker',
    narration: 'A stone at the gap carries a solution for exactly two processes, in full, with the turn variable named. It is correct, it is ancient, and it does not extend to five.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 45 },
    onlyIf: null,
  },
  {
    id: 'narrows.atomic_cache',
    weight: 17,
    title: 'Atomic Instruction Cache',
    narration: 'A cache of compare-and-swap primitives is intact and unclaimed at the second gate. The convoy takes them and stops paying for spin loops.',
    targets: null, inflicts: null,
    resourceDelta: { bandwidth: 12, cycles: 30 },
    onlyIf: null,
  },
  {
    id: 'narrows.mutex_recovered',
    weight: 17,
    title: 'Recovered Mutex',
    narration: 'A mutex left behind by a convoy that did not finish is still valid and still unheld. SABLE takes it and says nothing about the convoy.',
    targets: 'sentinel', inflicts: null,
    resourceDelta: { blocks: 18, cycles: 25 },
    onlyIf: null,
  },
];

import { asTick } from '../../types';
import type { Frame, FrameId, MemoryContext } from '../../types';
import { byLoad, ReplacementBase } from './fifo';

/** Ch. 10.4.7: counts belong to the current residency, with optional decay. */
export class LfuPolicy extends ReplacementBase {
  readonly id = 'lfu' as const;
  readonly displayName = 'Least frequently used';
  constructor(readonly lfuAging = 0) {
    super();
    if (!Number.isSafeInteger(lfuAging) || lfuAging < 0) throw new RangeError('lfuAging must be a nonnegative integer');
  }
  protected override beforeReference(ctx: MemoryContext): void {
    if (this.lfuAging === 0) return;
    const previous = this.lastAgingTick ?? 0;
    const shifts = Math.floor((ctx.tick - previous) / this.lfuAging);
    if (shifts <= 0) return;
    // Age all resident pages, not just the scope of this particular fault.
    const seen = new Set<object>();
    for (const frame of this.frames) {
      const entry = this.entry(frame);
      if (entry === undefined || !entry.valid || seen.has(entry)) continue;
      seen.add(entry);
      // Arithmetic shifting avoids signed overflow and modulo-32 shift counts.
      entry.accessCount = shifts > 52 ? 0 : Math.floor(entry.accessCount / 2 ** shifts);
    }
    this.lastAgingTick = asTick(previous + shifts * this.lfuAging);
  }
  protected rank(frames: Frame[]): readonly Frame[] {
    return frames.sort((a, b) => (this.entry(a)?.accessCount ?? 0)
      - (this.entry(b)?.accessCount ?? 0) || byLoad(a, b));
  }
  selectVictim(ctx: MemoryContext): FrameId {
    this.bindContext(ctx);
    this.beforeReference(ctx);
    return this.requireCandidate(this.rank(this.eligible(ctx))).id;
  }
}

import type { Frame, FrameId, MemoryContext } from '../../types';
import { ReplacementBase } from './fifo';

function byRecency(a: Frame, b: Frame): number {
  return (a.lastAccessTick ?? a.loadedAtTick ?? -1)
    - (b.lastAccessTick ?? b.loadedAtTick ?? -1) || a.id - b.id;
}

/** Ch. 10.4.4: counter implementation, scanning once per replacement. */
export class LruPolicy extends ReplacementBase {
  readonly id = 'lru' as const;
  readonly displayName = 'Least recently used';
  protected rank(frames: Frame[]): readonly Frame[] { return frames.sort(byRecency); }
  selectVictim(ctx: MemoryContext): FrameId {
    this.bindContext(ctx);
    const candidates = this.eligible(ctx);
    let victim = this.requireCandidate(candidates);
    for (const frame of candidates) if (byRecency(frame, victim) < 0) victim = frame;
    return victim.id;
  }
}

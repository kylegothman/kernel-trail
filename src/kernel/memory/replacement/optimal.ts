import type { Frame, FrameId, MemoryContext } from '../../types';
import { ReplacementBase } from './fifo';

/** Ch. 10.4.3: farthest next use, with lowest physical frame as the tie-break. */
export class OptimalPolicy extends ReplacementBase {
  readonly id = 'optimal' as const;
  readonly displayName = 'Optimal (lookahead)';
  protected rank(frames: Frame[]): readonly Frame[] {
    const future = this.ctx?.futureReferences;
    const distance = (frame: Frame): number => {
      const index = frame.page === null ? -1 : future?.indexOf(frame.page) ?? -1;
      return index < 0 ? Infinity : index;
    };
    return frames.sort((a, b) => {
      const left = distance(a); const right = distance(b);
      return left === right ? a.id - b.id : left > right ? -1 : 1;
    });
  }
  selectVictim(ctx: MemoryContext): FrameId {
    if (ctx.futureReferences === null) throw new Error('optimal replacement requires scripted future references');
    this.bindContext(ctx);
    return this.requireCandidate(this.rank(this.eligible(ctx))).id;
  }
}

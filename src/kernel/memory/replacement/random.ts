import { Sfc32Rng } from '../../rng';
import type { Frame, FrameId, MemoryContext } from '../../types';
import { ReplacementBase } from './fifo';

/** One root/vm draw per victim; rendering previews never advance that stream. */
export class RandomPolicy extends ReplacementBase {
  readonly id = 'random' as const;
  readonly displayName = 'Random';
  private readonly preview = new Sfc32Rng([0, 0, 0, 0], 'root/vm');
  protected rank(frames: Frame[]): readonly Frame[] {
    if (this.ctx === null || frames.length === 0) return frames;
    this.preview.restore(this.ctx.rng.save());
    // Every victim is equally likely. Put the deterministic next draw first,
    // then preview subsequent choices without changing the live stream.
    for (let index = 0; index < frames.length; index += 1) {
      const choice = this.preview.int(index, frames.length);
      const frame = frames[index];
      frames[index] = frames[choice] as Frame;
      frames[choice] = frame as Frame;
    }
    return frames;
  }
  selectVictim(ctx: MemoryContext): FrameId {
    this.bindContext(ctx);
    const candidates = this.eligible(ctx);
    this.requireCandidate(candidates);
    return ctx.rng.pick(candidates).id;
  }
}

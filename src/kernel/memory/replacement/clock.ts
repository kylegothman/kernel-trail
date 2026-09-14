import type { AddressSpaceId, Frame, FrameId, MemoryContext, PageId } from '../../types';
import { ReplacementBase } from './fifo';

/** Ch. 10.4.5.2: the hand uses physical frame positions, even under local scope. */
export class ClockPolicy extends ReplacementBase {
  readonly id = 'clock' as const;
  readonly displayName = 'Clock / second chance';
  protected rank(frames: Frame[]): readonly Frame[] {
    const hand = this.handIndex ?? 0;
    const position = (frame: Frame): number => {
      const index = this.frames.findIndex(candidate => candidate.id === frame.id);
      return (index - hand + this.frames.length) % Math.max(1, this.frames.length);
    };
    // A dry sweep first encounters existing zeroes, then the bits it would clear.
    return frames.sort((a, b) => Number(a.referenceBit) - Number(b.referenceBit) || position(a) - position(b));
  }
  override onLoad(space: AddressSpaceId, page: PageId, id: FrameId, ctx: MemoryContext): void {
    super.onLoad(space, page, id, ctx);
    const index = this.frames.findIndex(frame => frame.id === id);
    this.handIndex = (index + 1) % Math.max(1, this.frames.length);
  }
  selectVictim(ctx: MemoryContext): FrameId {
    this.bindContext(ctx);
    const eligible = this.eligible(ctx);
    this.requireCandidate(eligible);
    const ids = new Set(eligible.map(frame => frame.id));
    let hand = this.handIndex ?? 0;
    // Pinned/out-of-scope bits are never changed. At most two physical sweeps.
    for (let scanned = 0; scanned < Math.max(1, this.frames.length) * 2; scanned += 1) {
      const frame = this.frames[hand];
      if (frame !== undefined && ids.has(frame.id)) {
        if (!frame.referenceBit) {
          this.handIndex = hand;
          return frame.id;
        }
        frame.referenceBit = false;
        const entry = this.entry(frame);
        if (entry !== undefined && entry.frame === frame.id) entry.referenced = false;
      }
      hand = (hand + 1) % this.frames.length;
    }
    throw new Error('clock candidates are absent from the physical frame ring');
  }
}

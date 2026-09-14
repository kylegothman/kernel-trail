import { KernelInvariantError } from '../../errors';
import { asFrameId, asTick } from '../../types';
import type {
  AddressSpaceId, Frame, FrameId, MemoryContext, PageId, PageReplacementId,
  PageReplacementPolicy, PageReplacementSnapshot, PageTableEntry, Tick, VmReplacementState,
} from '../../types';
import { memoryArray, memoryInteger, memoryObject } from '../FrameTable';

/** Persistence and host binding stay outside the frozen policy contract. */
export interface PersistentReplacementPolicy extends PageReplacementPolicy {
  bindContext(ctx: MemoryContext, frames?: readonly Frame[]): void;
  advanceTick(ctx: MemoryContext): void;
  saveState(): VmReplacementState;
  prepareRestore(state: unknown, frames: readonly Frame[], ctx?: MemoryContext): () => void;
}

export function byLoad(a: Frame, b: Frame): number {
  return (a.loadedAtTick ?? -1) - (b.loadedAtTick ?? -1) || a.id - b.id;
}

/** Shared live metadata, stable views and transactional persistence. */
export abstract class ReplacementBase implements PersistentReplacementPolicy {
  abstract readonly id: PageReplacementId;
  abstract readonly displayName: string;
  protected frames: readonly Frame[] = [];
  protected ctx: MemoryContext | null = null;
  protected nextIndex = 0;
  protected handIndex: number | null = null;
  protected lastAgingTick: Tick | null = null;
  protected readonly candidates: Frame[] = [];
  protected readonly queue: FrameId[] = [];
  private readonly visibleOrder: FrameId[] = [];
  private view: PageReplacementSnapshot | null = null;
  // onLoad and its mandatory onAccess form one synchronous logical reference.
  private readonly loadedReferences = new Map<FrameId, { space: AddressSpaceId; page: PageId; tick: Tick }>();

  reset(frames: readonly Frame[]): void {
    this.frames = frames;
    this.ctx = null;
    this.nextIndex = 0;
    this.handIndex = this.id === 'clock' ? 0 : null;
    this.lastAgingTick = null;
    this.loadedReferences.clear();
    this.queue.length = 0;
    for (const frame of [...frames].sort(byLoad)) {
      if (frame.owner !== null && frame.page !== null) this.queue.push(frame.id);
    }
    this.snapshot();
  }

  bindContext(ctx: MemoryContext, frames?: readonly Frame[]): void {
    this.ctx = ctx;
    if (frames !== undefined) this.frames = frames;
  }
  advanceTick(ctx: MemoryContext): void {
    this.bindContext(ctx);
    this.beforeReference(ctx);
  }

  protected frame(id: FrameId): Frame {
    const frame = this.frames.find(candidate => candidate.id === id)
      ?? this.ctx?.frames.find(candidate => candidate.id === id);
    if (frame === undefined) throw new KernelInvariantError(17, `unknown replacement frame ${id}`);
    return frame;
  }

  protected entry(frame: Frame): PageTableEntry | undefined {
    if (frame.owner === null || frame.page === null) return undefined;
    return this.ctx?.pageTable(frame.owner).get(frame.page);
  }

  /** The host supplies scope; every policy also excludes pinned and unused frames. */
  protected eligible(ctx: MemoryContext | null = this.ctx): Frame[] {
    this.candidates.length = 0;
    for (const frame of ctx?.frames ?? this.frames) {
      if (frame.owner !== null && frame.page !== null && !frame.pinned) this.candidates.push(frame);
    }
    this.candidates.sort((a, b) => a.id - b.id);
    return this.candidates;
  }

  protected requireCandidate(frames: readonly Frame[]): Frame {
    const first = frames[0];
    if (first === undefined) throw new KernelInvariantError(17, 'no unpinned replacement frame');
    return first;
  }

  protected beforeReference(_ctx: MemoryContext): void {}

  onLoad(space: AddressSpaceId, page: PageId, id: FrameId, ctx: MemoryContext): void {
    this.bindContext(ctx);
    this.beforeReference(ctx);
    const frame = this.frame(id);
    frame.loadedAtTick = ctx.tick;
    frame.lastAccessTick = ctx.tick;
    frame.referenceBit = true;
    const entry = ctx.pageTable(space).get(page);
    if (entry !== undefined) {
      entry.accessCount = 1;
      entry.lastAccessTick = ctx.tick;
      entry.referenced = true;
    }
    this.loadedReferences.set(id, { space, page, tick: ctx.tick });
    const previous = this.queue.indexOf(id);
    if (previous >= 0) this.queue.splice(previous, 1);
    this.queue.push(id);
    this.queue.sort((a, b) => byLoad(this.frame(a), this.frame(b)));
    this.nextIndex = 0;
  }

  onAccess(space: AddressSpaceId, page: PageId, id: FrameId, ctx: MemoryContext): void {
    this.bindContext(ctx);
    this.beforeReference(ctx);
    const frame = this.frame(id);
    frame.lastAccessTick = ctx.tick;
    frame.referenceBit = true;
    const loaded = this.loadedReferences.get(id);
    const acknowledgesLoad = loaded?.space === space && loaded.page === page && loaded.tick === ctx.tick;
    this.loadedReferences.delete(id);
    const entry = ctx.pageTable(space).get(page);
    if (entry !== undefined) {
      if (!acknowledgesLoad) entry.accessCount += 1;
      entry.lastAccessTick = ctx.tick;
      entry.referenced = true;
    }
  }

  protected abstract rank(frames: Frame[]): readonly Frame[];
  abstract selectVictim(ctx: MemoryContext): FrameId;

  snapshot(): PageReplacementSnapshot {
    this.visibleOrder.length = 0;
    for (const frame of this.rank(this.eligible())) this.visibleOrder.push(frame.id);
    const owner = this;
    this.view ??= { policy: this.id, order: this.visibleOrder,
      get handIndex(): number | null { return owner.handIndex; } };
    return this.view;
  }

  saveState(): VmReplacementState {
    // Load metadata also incorporates reservations and lifecycle edits made by
    // the host. Derived victim views are reconstructed from metadata/context;
    // their persisted membership is canonical and independent of local scope.
    const order = this.id === 'clock'
      ? this.frames.map(frame => frame.id)
      : this.id === 'fifo'
        ? this.frames.filter(frame => frame.owner !== null && frame.page !== null).sort(byLoad).map(frame => frame.id)
        : this.frames.filter(frame => frame.owner !== null && frame.page !== null).map(frame => frame.id).sort((a, b) => a - b);
    return { policy: this.id, order, nextIndex: Math.min(this.nextIndex, Math.max(0, order.length - 1)),
      handIndex: this.handIndex, lastAgingTick: this.lastAgingTick };
  }

  prepareRestore(state: unknown, frames: readonly Frame[], ctx?: MemoryContext): () => void {
    const value = memoryObject(state, 'replacement state');
    if (value['policy'] !== this.id) throw new Error('replacement policy mismatch');
    const known = new Set(frames.map(frame => frame.id));
    const order = memoryArray(value['order'], 'replacement order').map(value => {
      const id = asFrameId(memoryInteger(value, 'replacement frame'));
      if (!known.has(id)) throw new Error('unknown frame in replacement order');
      return id;
    });
    if (new Set(order).size !== order.length) throw new Error('duplicate frame in replacement order');
    const nextIndex = memoryInteger(value['nextIndex'], 'replacement cursor');
    if (nextIndex >= Math.max(1, order.length)) throw new Error('replacement cursor out of range');
    const hand = value['handIndex'] === null ? null : memoryInteger(value['handIndex'], 'clock hand');
    if (this.id === 'clock') {
      if (hand === null || hand >= Math.max(1, frames.length)
        || order.length !== frames.length || order.some((id, index) => frames[index]?.id !== id)) {
        throw new Error('invalid clock ring or hand');
      }
    } else if (hand !== null) throw new Error('non-clock policy has a clock hand');
    const lastAgingTick = value['lastAgingTick'] === null ? null
      : asTick(memoryInteger(value['lastAgingTick'], 'LFU aging tick'));
    if ((this.id !== 'lfu' && lastAgingTick !== null)
      || (ctx !== undefined && lastAgingTick !== null && lastAgingTick > ctx.tick)) {
      throw new Error('invalid LFU aging tick');
    }
    if (this.id !== 'clock') {
      const expected = frames.filter(frame => frame.owner !== null && frame.page !== null)
        .sort(this.id === 'fifo' ? byLoad : (a, b) => a.id - b.id).map(frame => frame.id);
      if (expected.length !== order.length || expected.some((id, index) => id !== order[index])) {
        throw new Error('replacement order disagrees with owned frames');
      }
    }
    if (this.id !== 'fifo' && nextIndex !== 0) throw new Error('non-FIFO policy has a queue cursor');
    return () => {
      this.frames = frames;
      this.ctx = ctx ?? null;
      this.queue.splice(0, this.queue.length, ...order);
      this.nextIndex = nextIndex;
      this.handIndex = hand;
      this.lastAgingTick = lastAgingTick;
      this.loadedReferences.clear();
      this.snapshot();
    };
  }
}

/** Ch. 10.4.2: oldest load wins, independent of hits or scoped candidate order. */
export class FifoPolicy extends ReplacementBase {
  readonly id = 'fifo' as const;
  readonly displayName = 'FIFO';
  protected rank(frames: Frame[]): readonly Frame[] { return frames.sort(byLoad); }
  selectVictim(ctx: MemoryContext): FrameId {
    this.bindContext(ctx);
    const victim = this.requireCandidate(this.rank(this.eligible(ctx)));
    this.nextIndex = Math.max(0, this.queue.indexOf(victim.id));
    return victim.id;
  }
}

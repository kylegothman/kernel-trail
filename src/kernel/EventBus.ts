/**
 * KERNEL TRAIL - the kernel event stream.
 *
 * Implements the frozen `KernelEventStream` contract from @kernel/types. This
 * is the only channel between the simulation and everything visual, so it has
 * two hard requirements beyond the interface:
 *
 *  1. `seq` is a single monotonic counter across the whole run. It is never
 *     reset by `restore`, because `KernelSnapshot.seq` carries it. Spec 2.2.
 *  2. Emitting must not allocate beyond the event object itself. Handler lists
 *     are arrays walked by index, `lastFrame` is one array whose length is
 *     reset to 0 at the start of each step, and nothing here builds a closure,
 *     an iterator or a spread per event.
 */

import type {
  KernelEvent,
  KernelEventOf,
  KernelEventStream,
  KernelEventType,
  Tick,
  Unsubscribe,
} from './types';

/**
 * An event's own fields, without the envelope the bus stamps on. Callers pass
 * this to `emit` and the bus supplies `type`, `tick` and `seq`.
 */
export type KernelEventPayload<T extends KernelEventType> = Omit<
  KernelEventOf<T>,
  'type' | 'tick' | 'seq'
>;

/** Writable view of an event, used only where the bus stamps the envelope. */
type MutableEvent = { -readonly [K in keyof KernelEvent]: KernelEvent[K] };

/** A slot is null once its subscriber has unsubscribed. */
type Slot<H> = H | null;

export class KernelEventBus implements KernelEventStream {
  /** Reused across steps. Never reallocated; `beginFrame` truncates it. */
  private readonly frame: KernelEvent[] = [];

  private readonly typed = new Map<KernelEventType, Slot<(e: never) => void>[]>();
  private readonly anyHandlers: Slot<(e: KernelEvent) => void>[] = [];

  /** Count of null slots awaiting compaction, per list. */
  private readonly typedDead = new Map<KernelEventType, number>();
  private anyDead = 0;

  private seqCounter = 0;

  /** Events emitted during the most recent step, in order. */
  get lastFrame(): readonly KernelEvent[] {
    return this.frame;
  }

  /** The next value `emit` will stamp. Carried in `KernelSnapshot.seq`. */
  get seq(): number {
    return this.seqCounter;
  }

  /**
   * Restore the counter from a snapshot. Invariant I-38 requires `seq` to
   * strictly increase across the whole run including across a restore, so this
   * refuses to move the counter backwards past a value already handed out.
   */
  setSeq(next: number): void {
    if (!Number.isInteger(next) || next < 0) {
      throw new RangeError(`seq must be a non-negative integer, received ${next}`);
    }
    this.seqCounter = next;
  }

  on<T extends KernelEventType>(type: T, handler: (e: KernelEventOf<T>) => void): Unsubscribe {
    let list = this.typed.get(type);
    if (list === undefined) {
      list = [];
      this.typed.set(type, list);
      this.typedDead.set(type, 0);
    }
    const stored = handler as (e: never) => void;
    list.push(stored);
    let live = true;
    return (): void => {
      if (!live) return;
      live = false;
      const current = this.typed.get(type);
      if (current === undefined) return;
      // Identity scan rather than a captured index: compaction renumbers the
      // list, so an index captured at subscribe time goes stale.
      for (let i = 0; i < current.length; i++) {
        if (current[i] === stored) {
          current[i] = null;
          this.typedDead.set(type, (this.typedDead.get(type) ?? 0) + 1);
          return;
        }
      }
    };
  }

  onAny(handler: (e: KernelEvent) => void): Unsubscribe {
    this.anyHandlers.push(handler);
    let live = true;
    return (): void => {
      if (!live) return;
      live = false;
      for (let i = 0; i < this.anyHandlers.length; i++) {
        if (this.anyHandlers[i] === handler) {
          this.anyHandlers[i] = null;
          this.anyDead += 1;
          return;
        }
      }
    };
  }

  /**
   * Truncate `lastFrame`. Called once at the top of `Kernel.step()`, before
   * phase 1. The array object is reused so that a renderer holding a reference
   * to `lastFrame` keeps seeing the live buffer.
   */
  beginFrame(): void {
    this.frame.length = 0;
  }

  /**
   * Build, stamp and dispatch an event. The only allocation is the event
   * object itself.
   */
  emit<T extends KernelEventType>(
    tick: Tick,
    type: T,
    payload: KernelEventPayload<T>,
  ): KernelEventOf<T> {
    const event = { ...payload, type, tick, seq: this.seqCounter } as KernelEventOf<T>;
    this.seqCounter += 1;
    this.dispatch(event);
    return event;
  }

  /**
   * Dispatch an event a caller already built. `tick` and `seq` are overwritten
   * so that a policy handed a `SchedulerContext.emit` cannot invent an
   * out-of-order sequence number.
   */
  publish(event: KernelEvent, tick: Tick): KernelEvent {
    const writable = event as MutableEvent;
    writable.tick = tick;
    writable.seq = this.seqCounter;
    this.seqCounter += 1;
    this.dispatch(event);
    return event;
  }

  /** Drop every subscriber. Used when a kernel is torn down at a leg boundary. */
  clear(): void {
    this.typed.clear();
    this.typedDead.clear();
    this.anyHandlers.length = 0;
    this.anyDead = 0;
    this.frame.length = 0;
  }

  private dispatch(event: KernelEvent): void {
    this.frame.push(event);

    const list = this.typed.get(event.type);
    if (list !== undefined) {
      if ((this.typedDead.get(event.type) ?? 0) > 0) {
        this.compact(list);
        this.typedDead.set(event.type, 0);
      }
      for (let i = 0; i < list.length; i++) {
        const handler = list[i];
        if (handler !== null && handler !== undefined) {
          (handler as (e: KernelEvent) => void)(event);
        }
      }
    }

    if (this.anyDead > 0) {
      this.compact(this.anyHandlers);
      this.anyDead = 0;
    }
    for (let i = 0; i < this.anyHandlers.length; i++) {
      const handler = this.anyHandlers[i];
      if (handler !== null && handler !== undefined) {
        handler(event);
      }
    }
  }

  /**
   * Remove null slots. Runs only after an unsubscribe, never per event, so the
   * allocation-free emit path is preserved.
   */
  private compact<H>(list: Slot<H>[]): void {
    let write = 0;
    for (let read = 0; read < list.length; read++) {
      const value = list[read];
      if (value !== null && value !== undefined) {
        list[write] = value;
        write += 1;
      }
    }
    list.length = write;
  }
}

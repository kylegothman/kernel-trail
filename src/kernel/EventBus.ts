/**
 * KERNEL TRAIL - the synchronous kernel event stream.
 *
 * Frame storage and subscriber lists are reused. Dispatch captures both list
 * lengths before calling a subscriber so new subscriptions wait for the next
 * event, including when a typed subscriber adds an onAny subscriber.
 */

import { asTick } from './types';
import type {
  KernelEvent,
  KernelEventOf,
  KernelEventStream,
  KernelEventType,
  Tick,
  Unsubscribe,
} from './types';

export type EmittableEvent = {
  [T in KernelEventType]: Omit<KernelEventOf<T>, 'tick' | 'seq'>
}[KernelEventType];

/** The scaffold's three-argument emit API remains available to its consumers. */
export type KernelEventPayload<T extends KernelEventType> = Omit<
  KernelEventOf<T>,
  'type' | 'tick' | 'seq'
>;

export interface EventEmitter {
  /** Assigns tick and seq, appends to the frame, dispatches synchronously. */
  emit(event: EmittableEvent): void;
  /** Clears the frame buffer in place. Called at the top of step(). */
  beginFrame(): void;
  readonly stream: KernelEventStream;
  readonly seq: number;
  /** Restore path only. Sets the sequence counter. */
  setSeq(seq: number): void;
  setTick(tick: Tick): void;
}

interface Subscription {
  readonly handler: (event: KernelEvent) => void;
  readonly name: string;
  active: boolean;
}

interface HandlerList {
  readonly entries: Subscription[];
  dirty: boolean;
}

function hasType<T extends KernelEventType>(
  event: KernelEvent,
  type: T,
): event is KernelEventOf<T> {
  return event.type === type;
}

export class KernelEventBus implements KernelEventStream, EventEmitter {
  private readonly frame: KernelEvent[] = [];
  private readonly typed = new Map<KernelEventType, HandlerList>();
  private readonly anyHandlers: HandlerList = { entries: [], dirty: false };
  private readonly dirtyLists: HandlerList[] = [];
  private readonly failures: { name: string; error: unknown }[] = [];
  private dispatchDepth = 0;
  private seqCounter = 0;
  private currentTick = asTick(0);

  /** Readers receive the frozen stream contract without emitter methods. */
  readonly stream: KernelEventStream = {
    on: (type, handler) => this.on(type, handler),
    onAny: handler => this.onAny(handler),
    lastFrame: this.frame,
  };

  get lastFrame(): readonly KernelEvent[] {
    return this.frame;
  }

  get handlerFailures(): readonly { name: string; error: unknown }[] {
    return this.failures;
  }

  /** The next value emit will stamp, carried in KernelSnapshot.seq. */
  get seq(): number {
    return this.seqCounter;
  }

  /** Restore exactly the next sequence number recorded in a snapshot. */
  setSeq(next: number): void {
    if (!Number.isInteger(next) || next < 0) {
      throw new RangeError(`seq must be a non-negative integer, received ${next}`);
    }
    this.seqCounter = next;
  }

  setTick(tick: Tick): void {
    this.currentTick = tick;
  }

  on<T extends KernelEventType>(type: T, handler: (e: KernelEventOf<T>) => void): Unsubscribe {
    let list = this.typed.get(type);
    if (list === undefined) {
      list = { entries: [], dirty: false };
      this.typed.set(type, list);
    }
    // Narrow the frozen union at delivery instead of widening the callback.
    return this.subscribe(list, event => {
      if (hasType(event, type)) handler(event);
    }, handler.name);
  }

  onAny(handler: (e: KernelEvent) => void): Unsubscribe {
    return this.subscribe(this.anyHandlers, handler, handler.name);
  }

  beginFrame(): void {
    this.frame.length = 0;
  }

  emit(event: EmittableEvent): void;
  emit<T extends KernelEventType>(
    tick: Tick,
    type: T,
    payload: KernelEventPayload<T>,
  ): KernelEventOf<T>;
  emit<T extends KernelEventType>(
    eventOrTick: EmittableEvent | Tick,
    type?: T,
    payload?: KernelEventPayload<T>,
  ): KernelEvent | void {
    if (typeof eventOrTick === 'number') {
      if (type === undefined || payload === undefined) {
        throw new TypeError('emit: tick requires an event type and payload');
      }
      // The overload pairs T with its exact payload. TypeScript cannot retain
      // that correlation when spreading a generic Omit into the frozen union.
      const event = {
        ...payload, type, tick: eventOrTick, seq: this.seqCounter,
      } as KernelEventOf<T>;
      this.seqCounter += 1;
      this.dispatch(event);
      return event;
    }
    const event = { ...eventOrTick, tick: this.currentTick, seq: this.seqCounter };
    this.seqCounter += 1;
    this.dispatch(event);
  }

  /** Restamp a policy event without mutating its readonly envelope. */
  publish(event: KernelEvent, tick: Tick): KernelEvent {
    const stamped = { ...event, tick, seq: this.seqCounter };
    this.seqCounter += 1;
    this.dispatch(stamped);
    return stamped;
  }

  /** Drop subscribers and frame contents when a kernel is torn down. */
  clear(): void {
    for (const list of this.typed.values()) this.deactivate(list);
    this.deactivate(this.anyHandlers);
    this.frame.length = 0;
    if (this.dispatchDepth === 0) {
      this.compactDirtyLists();
      this.typed.clear();
    }
  }

  private subscribe(
    list: HandlerList,
    handler: (event: KernelEvent) => void,
    name: string,
  ): Unsubscribe {
    const subscription: Subscription = { handler, name, active: true };
    list.entries.push(subscription);
    return (): void => {
      if (!subscription.active) return;
      subscription.active = false;
      this.markDirty(list);
      if (this.dispatchDepth === 0) this.compactDirtyLists();
    };
  }

  private dispatch(event: KernelEvent): void {
    this.frame.push(event);
    const list = this.typed.get(event.type);
    const typedLength = list?.entries.length ?? 0;
    const anyLength = this.anyHandlers.entries.length;
    this.dispatchDepth += 1;
    try {
      if (list !== undefined) this.deliver(list, typedLength, event);
      this.deliver(this.anyHandlers, anyLength, event);
    } finally {
      this.dispatchDepth -= 1;
      // Nested emissions must not shift an outer emission's captured indexes.
      if (this.dispatchDepth === 0) this.compactDirtyLists();
    }
  }

  private deliver(list: HandlerList, length: number, event: KernelEvent): void {
    for (let i = 0; i < length; i++) {
      const subscription = list.entries[i];
      if (subscription === undefined || !subscription.active) continue;
      try {
        subscription.handler(event);
      } catch (error: unknown) {
        this.failures.push({ name: subscription.name, error });
      }
    }
  }

  private deactivate(list: HandlerList): void {
    for (let i = 0; i < list.entries.length; i++) {
      const subscription = list.entries[i];
      if (subscription !== undefined) subscription.active = false;
    }
    this.markDirty(list);
  }

  private markDirty(list: HandlerList): void {
    if (list.dirty) return;
    list.dirty = true;
    this.dirtyLists.push(list);
  }

  private compactDirtyLists(): void {
    while (this.dirtyLists.length > 0) {
      const list = this.dirtyLists.pop();
      if (list === undefined) continue;
      let write = 0;
      for (let read = 0; read < list.entries.length; read++) {
        const subscription = list.entries[read];
        if (subscription === undefined || !subscription.active) continue;
        list.entries[write] = subscription;
        write += 1;
      }
      list.entries.length = write;
      list.dirty = false;
    }
  }
}

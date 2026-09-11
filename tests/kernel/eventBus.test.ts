import { describe, expect, test } from 'vitest';
import { KernelEventBus } from '@kernel/EventBus';
import type { EmittableEvent, EventEmitter } from '@kernel/EventBus';
import { asPid, asTick } from '@kernel/types';
import type { KernelEvent, Unsubscribe } from '@kernel/types';

const panic: EmittableEvent = { type: 'kernel.panic', message: 'test event' };

const subscriptionKinds: readonly {
  name: string;
  subscribe: (bus: KernelEventBus, handler: () => void) => Unsubscribe;
}[] = [
  { name: 'typed', subscribe: (bus, handler) => bus.stream.on('kernel.panic', handler) },
  { name: 'onAny', subscribe: (bus, handler) => bus.stream.onAny(handler) },
];

describe('KernelEventBus', () => {
  test('seq monotonic', () => {
    const bus = new KernelEventBus();
    for (let i = 0; i < 50; i++) bus.emit(panic);
    expect(bus.stream.lastFrame.map(event => event.seq)).toEqual(
      Array.from({ length: 50 }, (_, i) => i),
    );
    expect(bus.seq).toBe(50);
  });

  test('seq survives beginFrame', () => {
    const bus = new KernelEventBus();
    for (let i = 0; i < 50; i++) bus.emit(panic);
    bus.beginFrame();
    bus.emit(panic);
    expect(bus.stream.lastFrame).toHaveLength(1);
    expect(bus.stream.lastFrame[0]?.seq).toBe(50);
  });

  test('tick stamping', () => {
    const emitter: EventEmitter = new KernelEventBus();
    emitter.emit(panic);
    emitter.setTick(asTick(7));
    emitter.emit(panic);
    expect(emitter.stream.lastFrame.map(event => event.tick)).toEqual([0, 7]);
    expect(panic).toEqual({ type: 'kernel.panic', message: 'test event' });
  });

  test('lastFrame identity', () => {
    const bus = new KernelEventBus();
    const frame = bus.stream.lastFrame;
    bus.emit(panic);
    bus.beginFrame();
    expect(bus.stream.lastFrame).toBe(frame);
    expect(bus.lastFrame).toBe(frame);
    expect(frame).toEqual([]);
    bus.emit(panic);
    expect(frame).toHaveLength(1);
  });

  test('lastFrame contents', () => {
    const bus = new KernelEventBus();
    bus.emit(panic);
    bus.beginFrame();
    for (const message of ['one', 'two', 'three']) {
      bus.emit({ type: 'kernel.panic', message });
    }
    expect(bus.stream.lastFrame).toEqual([
      { type: 'kernel.panic', message: 'one', tick: 0, seq: 1 },
      { type: 'kernel.panic', message: 'two', tick: 0, seq: 2 },
      { type: 'kernel.panic', message: 'three', tick: 0, seq: 3 },
    ]);
  });

  test('typed subscription', () => {
    const bus = new KernelEventBus();
    const names: string[] = [];
    bus.stream.on('process.created', event => names.push(event.name));
    bus.emit(panic);
    bus.emit({ type: 'process.created', pid: asPid(1), parent: null, name: 'first' });
    bus.emit({ type: 'process.created', pid: asPid(2), parent: asPid(1), name: 'second' });
    expect(names).toEqual(['first', 'second']);
  });

  test('onAny ordering preserves registration order within each group', () => {
    const bus = new KernelEventBus();
    const calls: string[] = [];
    bus.stream.onAny(() => calls.push('any first'));
    bus.stream.on('kernel.panic', event => {
      expect(bus.stream.lastFrame[0]).toBe(event);
      calls.push('typed first');
    });
    bus.stream.onAny(() => calls.push('any second'));
    bus.stream.on('kernel.panic', () => calls.push('typed second'));
    bus.emit(panic);
    expect(calls).toEqual(['typed first', 'typed second', 'any first', 'any second']);
  });

  for (const { name, subscribe } of subscriptionKinds) {
    test(`${name}: unsubscribe is idempotent`, () => {
      const bus = new KernelEventBus();
      let calls = 0;
      const unsubscribe = subscribe(bus, () => { calls += 1; });
      bus.emit(panic);
      unsubscribe();
      unsubscribe();
      bus.emit(panic);
      expect(calls).toBe(1);
    });

    test(`${name}: unsubscribe during dispatch skips a later handler`, () => {
      const bus = new KernelEventBus();
      const calls: string[] = [];
      subscribe(bus, () => {
        calls.push('first');
        unsubscribeLater();
      });
      const unsubscribeLater = subscribe(bus, () => calls.push('later'));
      subscribe(bus, () => calls.push('last'));
      bus.emit(panic);
      bus.emit(panic);
      expect(calls).toEqual(['first', 'last', 'first', 'last']);
    });

    test(`${name}: add during dispatch waits for the next event`, () => {
      const bus = new KernelEventBus();
      const calls: string[] = [];
      subscribe(bus, () => {
        calls.push('first');
        subscribe(bus, () => calls.push('new'));
      });
      bus.emit(panic);
      expect(calls).toEqual(['first']);
      bus.emit(panic);
      expect(calls).toEqual(['first', 'first', 'new']);
    });

    test(`${name}: duplicate callbacks unsubscribe their own registration`, () => {
      const bus = new KernelEventBus();
      const calls: string[] = [];
      const duplicate = (): void => { calls.push('duplicate'); };
      const unsubscribeFirst = subscribe(bus, duplicate);
      subscribe(bus, () => calls.push('middle'));
      const unsubscribeLast = subscribe(bus, duplicate);
      unsubscribeLast();
      unsubscribeLast();
      bus.emit(panic);
      expect(calls).toEqual(['duplicate', 'middle']);
      unsubscribeFirst();
      bus.emit(panic);
      expect(calls).toEqual(['duplicate', 'middle', 'middle']);
    });

    test(`${name}: a self-unsubscribing handler does not skip its successor`, () => {
      const bus = new KernelEventBus();
      const calls: string[] = [];
      const unsubscribeSelf = subscribe(bus, () => {
        calls.push('self');
        unsubscribeSelf();
      });
      subscribe(bus, () => calls.push('next'));
      bus.emit(panic);
      bus.emit(panic);
      expect(calls).toEqual(['self', 'next', 'next']);
    });
  }

  test('typed additions to onAny do not receive the current event', () => {
    const bus = new KernelEventBus();
    const received: number[] = [];
    bus.stream.on('kernel.panic', () => {
      bus.stream.onAny(event => received.push(event.seq));
    });
    bus.emit(panic);
    expect(received).toEqual([]);
    bus.emit(panic);
    expect(received).toEqual([1]);
  });

  test('throwing handlers record original names and continue dispatch', () => {
    const bus = new KernelEventBus();
    const error = new Error('typed failure');
    const calls: string[] = [];
    function typedFailure(): void { throw error; }
    function anyFailure(): void { throw 'any failure'; }
    bus.stream.on('kernel.panic', typedFailure);
    bus.stream.on('kernel.panic', () => calls.push('typed survivor'));
    bus.stream.onAny(anyFailure);
    bus.stream.onAny(() => calls.push('any survivor'));
    expect(() => bus.emit(panic)).not.toThrow();
    expect(calls).toEqual(['typed survivor', 'any survivor']);
    expect(bus.handlerFailures).toEqual([
      { name: 'typedFailure', error },
      { name: 'anyFailure', error: 'any failure' },
    ]);
    bus.beginFrame();
    bus.emit(panic);
    expect(bus.seq).toBe(2);
    expect(bus.handlerFailures).toHaveLength(4);
    expect(calls).toHaveLength(4);
  });

  test('reentrant emission does not compact an outer dispatch in progress', () => {
    const bus = new KernelEventBus();
    const calls: string[] = [];
    bus.stream.on('kernel.panic', event => {
      calls.push(`first ${event.seq}`);
      if (event.seq === 0) {
        unsubscribeLater();
        bus.emit(panic);
      }
    });
    const unsubscribeLater = bus.stream.on('kernel.panic', () => calls.push('removed'));
    bus.stream.on('kernel.panic', event => calls.push(`last ${event.seq}`));
    bus.stream.onAny(event => calls.push(`any ${event.seq}`));
    bus.emit(panic);
    expect(calls).toEqual(['first 0', 'first 1', 'last 1', 'any 1', 'last 0', 'any 0']);
    expect(bus.stream.lastFrame.map(event => event.seq)).toEqual([0, 1]);
    bus.emit(panic);
    expect(calls.slice(-3)).toEqual(['first 2', 'last 2', 'any 2']);
  });

  test('new handlers receive a nested event but not its outer event', () => {
    const bus = new KernelEventBus();
    const calls: string[] = [];
    bus.stream.on('kernel.panic', event => {
      if (event.seq === 0) {
        bus.stream.on('kernel.panic', next => calls.push(`typed ${next.seq}`));
        bus.stream.onAny(next => calls.push(`any ${next.seq}`));
        bus.emit(panic);
      }
    });
    bus.emit(panic);
    expect(calls).toEqual(['typed 1', 'any 1']);
  });

  test('setSeq restores the saved next value and rejects invalid counters', () => {
    const bus = new KernelEventBus();
    bus.emit(panic);
    const savedSeq = bus.seq;
    bus.emit(panic);
    bus.setSeq(savedSeq);
    bus.beginFrame();
    bus.emit(panic);
    expect(bus.stream.lastFrame[0]?.seq).toBe(savedSeq);
    for (const invalid of [-1, 0.5, NaN, Infinity]) {
      expect(() => bus.setSeq(invalid)).toThrow(RangeError);
    }
    expect(bus.seq).toBe(2);
  });

  test('scaffold emit and publish share the sequence counter', () => {
    const bus = new KernelEventBus();
    const legacy = bus.emit(asTick(3), 'process.created', {
      pid: asPid(1), parent: null, name: 'legacy',
    });
    expect(legacy.name).toBe('legacy');
    expect(legacy).toMatchObject({ tick: 3, seq: 0 });
    const policyEvent: KernelEvent = {
      type: 'kernel.panic', message: 'policy event', tick: asTick(99), seq: 99,
    };
    const published = bus.publish(policyEvent, asTick(4));
    expect(published).toMatchObject({ tick: 4, seq: 1 });
    expect(policyEvent).toMatchObject({ tick: 99, seq: 99 });
    bus.setTick(asTick(5));
    bus.emit(panic);
    expect(bus.stream.lastFrame.map(event => [event.tick, event.seq])).toEqual([
      [3, 0], [4, 1], [5, 2],
    ]);
  });

  test('clear removes subscriptions without replacing the frame or resetting seq', () => {
    const bus = new KernelEventBus();
    const frame = bus.stream.lastFrame;
    const calls: string[] = [];
    const handler = (): void => { calls.push('typed'); };
    const unsubscribeOld = bus.stream.on('kernel.panic', handler);
    bus.stream.onAny(() => calls.push('any'));
    bus.emit(panic);
    bus.clear();
    expect(bus.stream.lastFrame).toBe(frame);
    expect(frame).toEqual([]);
    bus.stream.on('kernel.panic', handler);
    unsubscribeOld();
    bus.emit(panic);
    expect(calls).toEqual(['typed', 'any', 'typed']);
    expect(frame[0]?.seq).toBe(1);
  });

  test('clear during dispatch removes later handlers and defers replacements', () => {
    const bus = new KernelEventBus();
    const calls: string[] = [];
    bus.stream.on('kernel.panic', () => {
      calls.push('first');
      bus.clear();
      bus.stream.on('kernel.panic', () => calls.push('new typed'));
      bus.stream.onAny(() => calls.push('new any'));
    });
    bus.stream.on('kernel.panic', () => calls.push('old typed'));
    bus.stream.onAny(() => calls.push('old any'));
    bus.emit(panic);
    expect(calls).toEqual(['first']);
    bus.emit(panic);
    expect(calls).toEqual(['first', 'new typed', 'new any']);
  });

  test('emit cost: 100,000 events with one no-op handler take under 250 ms', () => {
    const bus = new KernelEventBus();
    bus.stream.on('kernel.panic', () => {});
    const started = performance.now();
    for (let i = 0; i < 100_000; i++) bus.emit(panic);
    const elapsedMs = performance.now() - started;
    console.info(`EventBus 100,000 emits: ${elapsedMs} ms`);
    expect(bus.seq).toBe(100_000);
    expect(bus.stream.lastFrame).toHaveLength(100_000);
    expect(elapsedMs).toBeLessThan(250);
  });
});

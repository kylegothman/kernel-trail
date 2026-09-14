import { describe, expect, it } from 'vitest';
import type { DeviceId, IoSnapshotState, Pid, Tick } from '@kernel/types';
import type { EmittableEvent } from '@kernel/EventBus';
import { InterruptController } from '@kernel/io/InterruptController';
import { createRng } from '@kernel/rng';
import { createKernel } from '@kernel/Kernel';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';

const id = (value: string): DeviceId => value as DeviceId;
const settings: IoSnapshotState['payload']['settings'] = { interruptServiceTicks: 2, maxInterruptsPerTick: 2,
  interruptStormThreshold: 32, interruptStormWindow: 10, maxPendingInterrupts: 256, dmaCycleStealRatio: 0.1, blockCacheEntries: 64 };
function fixture(overrides: Partial<typeof settings> = {}) {
  let tick = 0; let next = 1; let debt = 0;
  const events: EmittableEvent[] = []; const seen: DeviceId[] = []; const masked: DeviceId[] = []; const terminated: Pid[] = [];
  let handler: (device: DeviceId) => void = () => {};
  const controller = new InterruptController({ tick: () => tick as Tick, settings: () => ({ ...settings, ...overrides }), nextToken: () => next++,
    source: token => token.kind === 'signal' ? token.sourcePid : null, handle: device => { seen.push(device); handler(device); },
    charge: (_device, _token, cost) => { debt += cost; }, emit: event => events.push(event), mitigate: device => masked.push(device), terminate: pid => terminated.push(pid) });
  return { controller, events, seen, masked, terminated, debt: () => debt, setHandler: (value: typeof handler) => { handler = value; },
    advance: () => { tick += 1; return controller.deliver(tick as Tick); }, setTick: (value: number) => { tick = value; } };
}

describe('I/O control and saturated completion continuation', () => {
  const config = { ...REFERENCE_CONFIG, enabledSubsystems: ['io'] as const };
  it('preserves a completion rejected by a full line through paired restore', () => {
    const a = createKernel(config), io = a.ioSubsystem;
    for (let count = 0; count < a.tuning.maxPendingInterrupts; count++) io.interrupts.raise(id('tty0'));
    const request = io.submit({ kind: 'kernel', purpose: 'fixture' }, id('tty0'), { kind: 'character', contents: [7] }); a.step();
    const saved = a.snapshot();
    expect(saved.subsystems!.io!.payload.devices.find(device => device.id === 'tty0')!.pollingTokens).toHaveLength(1);
    const b = createKernel(config); b.restore(structuredClone(saved));
    expect(b.run(160)).toEqual(a.run(160)); expect(b.snapshot()).toEqual(a.snapshot());
    expect(io.takeResult(request)).toEqual({ kind: 'ok', data: [] });
    expect(b.ioSubsystem.takeResult(request)).toEqual({ kind: 'ok', data: [] });
    expect(io.takeResult(request)).toBeNull();
    expect(io.interrupts.totalPending).toBe(0);
  });
  it('flush drains acknowledged tty0 output without accelerating an in-flight byte', () => {
    const kernel = createKernel(config), io = kernel.ioSubsystem;
    io.submit({ kind: 'kernel', purpose: 'fixture' }, id('tty0'), { kind: 'character', contents: [1, 2] });
    kernel.step(); expect(io.control(id('tty0'), 'flush', [], undefined)).toEqual({ ok: true, value: 0 });
    kernel.step(); expect(io.control(id('tty0'), 'flush', [], undefined)).toEqual({ ok: true, value: 2 });
    expect(io.control(id('tty0'), 'flush', [], undefined)).toEqual({ ok: true, value: 0 });
    expect(io.saveState().io.payload.devices.find(device => device.id === 'tty0')!.driver).toEqual({ kind: 'character_output', output: [] });
  });
  it('reset removes a partial buffer before its cancelled request can be consumed again', () => {
    const kernel = createKernel(config), io = kernel.ioSubsystem, device = id('buffered timer');
    io.registerTimerDevice({ id: device, latency: 20 }); io.configureBuffer(device, { kind: 'double' }, 3, 3);
    const request = io.submit({ kind: 'kernel', purpose: 'fixture' }, device); kernel.step();
    expect(io.saveState().io.payload.buffers[0]!.filling).not.toBeNull();
    expect(io.control(device, 'reset', [], undefined)).toEqual({ ok: true, value: null });
    expect(io.takeResult(request)).toEqual({ kind: 'failed', reason: 'cancelled' });
    kernel.run(10); expect(io.saveState().io.payload.buffers[0]).toMatchObject({ filling: null, draining: null, ready: [], producerWaiters: [] });
    expect(() => io.prepareRestore(io.saveState().io)).not.toThrow();
  });
});

describe('interrupt delivery and storm continuation', () => {
  it('delivers priorities before device IDs and shares a two-token tick budget', () => {
    const f = fixture(); for (const [device, priority] of [['b', 2], ['c', 1], ['a', 2], ['e', 4], ['d', 3]] as const) { f.controller.register(id(device), priority); f.controller.raise(id(device)); }
    expect(f.advance()).toBe(2); expect(f.seen).toEqual(['c', 'a']); expect(f.debt()).toBe(4);
    expect(f.controller.deliver(1 as Tick)).toBe(0); expect(f.advance()).toBe(2); expect(f.seen).toEqual(['c', 'a', 'b', 'd']);
  });
  it('strictly higher nested priority can enter, equal priority waits until return', () => {
    const f = fixture({ maxInterruptsPerTick: 4 });
    for (const [device, priority] of [['low', 5], ['equal', 5], ['high', 1]] as const) f.controller.register(id(device), priority);
    const inner: string[] = [];
    f.setHandler(device => { if (device !== 'low') return; f.controller.raise(id('equal')); f.controller.raise(id('high'));
      f.controller.deliver(1 as Tick); inner.push(...f.seen); expect(f.controller.inService).toBe('low'); });
    f.controller.raise(id('low')); f.advance(); expect(inner).toEqual(['low', 'high']); expect(f.seen).toEqual(['low', 'high', 'equal']);
  });
  it('NMI bypasses mask and nesting while reserving the shared budget before handlers', () => {
    const f = fixture(); f.controller.register(id('a'), 0); f.controller.register(id('timer'), 99, false); f.controller.mask.add(id('timer'));
    f.setHandler(device => { if (device === 'a') { f.controller.raise(id('timer'), { kind: 'timer' }); f.controller.raise(id('a')); f.controller.deliver(1 as Tick); } });
    f.controller.raise(id('a')); expect(f.advance()).toBe(2); expect(f.seen).toEqual(['a', 'timer']); expect(f.controller.totalPending).toBe(1);
  });
  it('sorts one hundred seeded random line sets consistently', () => {
    const rng = createRng(9);
    for (let trial = 0; trial < 100; trial++) {
      const f = fixture({ maxInterruptsPerTick: 30 }); const rows = Array.from({ length: 20 }, (_, n) => ({ device: id('d' + String(n).padStart(2, '0')), priority: rng.int(0, 5) }));
      for (const row of rng.shuffle([...rows])) { f.controller.register(row.device, row.priority); f.controller.raise(row.device); }
      f.advance(); expect(f.seen).toEqual(rows.sort((a, b) => a.priority - b.priority || a.device.localeCompare(b.device)).map(row => row.device));
    }
  });
  it('observes five in/two out at 11 and escalates once at 20, 30, and 50', () => {
    const f = fixture(); f.controller.register(id('storm')); const stageTicks: number[] = []; let prior = 'none';
    for (let tick = 1; tick <= 60; tick++) {
      f.setTick(tick); for (let n = 0; n < 5; n++) f.controller.raise(id('storm'), { kind: 'signal', sourcePid: 7 as Pid });
      f.controller.deliver(tick as Tick); const stage = f.controller.snapshot().storm?.stage ?? 'none';
      if (stage !== prior) { stageTicks.push(tick); prior = stage; }
      if (tick === 10) expect(f.controller.totalPending).toBe(30);
    }
    expect(stageTicks).toEqual([11, 20, 30, 50]); expect(f.masked).toEqual(['storm']); expect(f.terminated).toEqual([7]);
    expect(f.events.filter(event => event.type === 'io.interrupt' && event.pid === null)).toHaveLength(1);
  });
  it('uses the largest backlog and greatest source contribution for deterministic attribution', () => {
    const f = fixture({ maxInterruptsPerTick: 0, interruptStormThreshold: 1 }); f.controller.register(id('a'), 0); f.controller.register(id('b'), 10);
    f.controller.raise(id('a'), { kind: 'signal', sourcePid: 2 as Pid });
    for (const pid of [9, 8, 9, 8]) f.controller.raise(id('b'), { kind: 'signal', sourcePid: pid as Pid });
    f.advance(); expect(f.controller.snapshot().storm).toMatchObject({ device: 'b', sourcePid: 8 });
  });
  it('saturates without wrap and emits one panic at the limit', () => {
    const f = fixture({ maxPendingInterrupts: 4 }); f.controller.register(id('a'));
    for (let n = 0; n < 10; n++) f.controller.raise(id('a'));
    expect(f.controller.totalPending).toBe(4); expect(f.events.filter(event => event.type === 'kernel.panic')).toEqual([{ type: 'kernel.panic', message: 'interrupt storm on a' }]);
  });
  it('restores budget and FIFO tokens without replaying delivered interrupts', () => {
    const f = fixture(); f.controller.register(id('a')); for (let n = 0; n < 5; n++) f.controller.raise(id('a'));
    f.advance(); const snapshot = f.controller.snapshot(); const fresh = fixture(); fresh.controller.restore(snapshot);
    expect(fresh.controller.deliver(1 as Tick)).toBe(0); expect(fresh.controller.deliver(2 as Tick)).toBe(2);
    f.controller.deliver(2 as Tick); expect(fresh.controller.snapshot()).toEqual(f.controller.snapshot());
    expect(snapshot.lines[0]?.pending).toHaveLength(3);
  });
});

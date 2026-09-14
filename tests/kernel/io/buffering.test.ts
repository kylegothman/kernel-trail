import { describe, expect, it } from 'vitest';
import { DeviceBuffer } from '../../../src/kernel/io/buffering';
import { BlockCache, type CacheFlush } from '../../../src/kernel/io/blockCache';
import { Spooler } from '../../../src/kernel/io/spool';
import type { EmittableEvent } from '../../../src/kernel/EventBus';
import type { BlockId, DeviceId, InodeId, IoSnapshotActor, IoSnapshotBuffer, IoSnapshotMediaResult, Pid, Tick, Tid } from '../../../src/kernel/types';

const device = 'buffer-fixture' as DeviceId;
const actor = (pid: number): IoSnapshotActor => ({ pid: pid as Pid, tid: pid as Tid });
function bufferFixture(scheme: IoSnapshotBuffer['scheme'], producer = 1, consumer = 1) {
  const consumed: { id: number; bytes: readonly number[] }[] = [];
  const buffer = new DeviceBuffer(device, scheme, { contents: id => [id % 256],
    consumed: (id, bytes) => consumed.push({ id, bytes }) }, producer, consumer);
  return { buffer, consumed, step: (tick: number) => buffer.step(tick as Tick) };
}

describe('device buffering and bounded FIFO reuse', () => {
  function throughput(scheme: IoSnapshotBuffer['scheme'], producer: number, consumer: number) {
    const f = bufferFixture(scheme, producer, consumer);
    for (let id = 1; id <= 2000; id++) f.buffer.enqueue(id);
    for (let tick = 1; tick <= 2000; tick++) f.step(tick);
    return f.consumed.length / 2000;
  }
  it('IO-BUF-1 approaches twice the single-buffer throughput at matched rates', () => {
    const single = throughput({ kind: 'single' }, 1, 1); const double = throughput({ kind: 'double' }, 1, 1);
    expect(single).toBe(0.5); expect(double / single).toBeGreaterThanOrEqual(1.95); expect(double / single).toBeLessThanOrEqual(2.05);
  });
  it('the approved one-to-five skew gains twenty percent, not a doubling', () => {
    const single = throughput({ kind: 'single' }, 1, 5); const double = throughput({ kind: 'double' }, 1, 5);
    expect(double / single).toBeCloseTo(1.2, 2);
  });
  it.each([{ kind: 'single' }, { kind: 'double' }, { kind: 'circular', capacity: 3 }] as const)('preserves FIFO and capacity under $kind backpressure', scheme => {
    const f = bufferFixture(scheme, 1, 5);
    for (let id = 1; id <= 100; id++) f.buffer.enqueue(id);
    for (let tick = 1; tick <= 1000; tick++) { f.step(tick); expect(f.buffer.occupancy).toBeLessThanOrEqual(f.buffer.capacity); }
    expect(f.consumed.map(row => row.id)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
    expect(f.consumed.every(row => row.bytes[0] === row.id % 256)).toBe(true); expect(f.buffer.bufferStalls).toBeGreaterThan(0);
  });
  it('reports a fully occupied hundred-tick circular-buffer window', () => {
    const f = bufferFixture({ kind: 'circular', capacity: 3 }, 1, 500);
    for (let id = 1; id <= 10; id++) f.buffer.enqueue(id);
    for (let tick = 1; tick <= 103; tick++) f.step(tick);
    expect(f.buffer.snapshot().occupancySamples).toHaveLength(100); expect(f.buffer.bufferOccupancy).toBe(3);
  });
  it('resumes both partial fill and drain without duplicating bytes', () => {
    const a = bufferFixture({ kind: 'double' }, 3, 5); for (let id = 1; id <= 10; id++) a.buffer.enqueue(id);
    for (let tick = 1; tick <= 4; tick++) a.step(tick);
    const saved = a.buffer.snapshot(); expect(saved.filling).not.toBeNull(); expect(saved.draining).not.toBeNull();
    const b = bufferFixture({ kind: 'double' }, 3, 5); b.buffer.restore(structuredClone(saved));
    const offset = a.consumed.length;
    for (let tick = 5; tick <= 100; tick++) { a.step(tick); b.step(tick); expect(b.buffer.snapshot()).toEqual(a.buffer.snapshot()); }
    expect(b.consumed).toEqual(a.consumed.slice(offset));
  });
  it('removes queued and partial work when its owner is cancelled', () => {
    const f = bufferFixture({ kind: 'double' }, 3, 5); for (let id = 1; id <= 4; id++) f.buffer.enqueue(id);
    for (let tick = 1; tick <= 4; tick++) f.step(tick); f.buffer.remove(new Set([1, 2, 4]));
    for (let tick = 5; tick <= 30; tick++) f.step(tick);
    expect(f.consumed.map(row => row.id)).toEqual([3]);
  });
});

function cacheFixture(capacity = 2) {
  let tick = 0; let nextFlush = 1; let nextSync = 1;
  const sent: CacheFlush[] = []; const replies = new Map<number, IoSnapshotMediaResult>();
  const blocks: IoSnapshotActor[] = []; const cancelled: number[] = [];
  const cache = new BlockCache({ tick: () => tick as Tick, capacity: () => capacity,
    nextFlush: () => nextFlush++, nextSync: () => nextSync++,
    submit: flush => { sent.push(structuredClone(flush)); return { kind: 'storage', storageRequestId: flush.id }; },
    take: flush => { const result = replies.get(flush.id) ?? null; replies.delete(flush.id); return result; },
    cancel: flush => cancelled.push(flush.id), block: caller => blocks.push({ ...caller }) });
  return { cache, sent, blocks, cancelled, setTick: (value: number) => { tick = value; },
    ack: (id: number, result: IoSnapshotMediaResult = { kind: 'ok', data: [] }) => { replies.set(id, result); cache.pump(); } };
}

describe('block-cache durability, LRU and generation ownership', () => {
  it('counts hits/misses and evicts least-recently-used blocks', () => {
    const f = cacheFixture(); f.cache.fill(device, 0 as BlockId, [10]); f.cache.fill(device, 1 as BlockId, [11]);
    expect(f.cache.read(device, 9 as BlockId)).toBeNull(); f.setTick(1); expect(f.cache.read(device, 0 as BlockId)).toEqual([10]);
    f.setTick(2); expect(f.cache.fill(device, 2 as BlockId, [12])).toBe(true);
    expect(f.cache.snapshot().entries.map(row => row.block)).toEqual([0, 2]); expect(f.cache.hitRate).toBe(0.5);
  });
  it('uses block then device identity to resolve equal recency across 500 distinct pairs', () => {
    for (let base = 0; base < 500; base++) {
      const f = cacheFixture(); f.cache.fill(device, base as BlockId, [1]); f.cache.fill(device, (base + 1) as BlockId, [2]);
      f.cache.fill(device, (base + 1000) as BlockId, [3]); expect(f.cache.peek(device, base as BlockId)).toBeNull();
    }
    const f = cacheFixture(); f.cache.fill('b' as DeviceId, 0 as BlockId, [1]); f.cache.fill('a' as DeviceId, 0 as BlockId, [2]);
    f.cache.fill(device, 1 as BlockId, [3]); expect(f.cache.peek('a' as DeviceId, 0 as BlockId)).toBeNull();
  });
  it('write-through submits in the same tick and becomes durable only after acknowledgement', () => {
    const f = cacheFixture(); f.setTick(7); expect(f.cache.write(device, 0 as BlockId, [17])).toBe(true);
    expect(f.sent).toHaveLength(1); expect(f.sent[0]).toMatchObject({ contents: [17], reason: 'write_through' });
    expect(f.cache.pendingWrite(device, 0 as BlockId)).toBe(true);
    const entry = f.cache.snapshot().entries[0]!; expect(entry.durableGeneration).toBeLessThan(entry.generation);
    f.ack(f.sent[0]!.id); expect(f.cache.pendingWrite(device, 0 as BlockId)).toBe(false);
    const durable = f.cache.snapshot().entries[0]!; expect(durable.durableGeneration).toBe(durable.generation);
  });
  it('write-back keeps dirty data until sync completes every physical write', () => {
    const f = cacheFixture(); f.cache.setPolicy('write_back'); f.cache.write(device, 0 as BlockId, [1]); f.cache.write(device, 1 as BlockId, [2]);
    expect(f.sent).toEqual([]); expect(f.cache.dirtyEntries()).toEqual([0, 1]);
    expect(f.cache.sync(actor(2))).toEqual({ ok: true, value: 2 }); expect(f.blocks).toEqual([actor(2)]);
    f.ack(f.sent[0]!.id); expect(f.cache.isSatisfied(actor(2))).toBe(false); expect(f.cache.dirtyEntries()).toEqual([1]);
    f.ack(f.sent[1]!.id); expect(f.cache.isSatisfied(actor(2))).toBe(true); expect(f.cache.dirtyEntries()).toEqual([]);
  });
  it('an older completed flush cannot clean a newer write to the same block', () => {
    const f = cacheFixture(); f.cache.setPolicy('write_back'); f.cache.write(device, 0 as BlockId, [1]); f.cache.sync(actor(2));
    const old = f.sent[0]!; f.cache.write(device, 0 as BlockId, [2]); f.ack(old.id);
    expect(f.cache.isSatisfied(actor(2))).toBe(true); expect(f.cache.dirtyEntries()).toEqual([0]); expect(f.cache.read(device, 0 as BlockId)).toEqual([2]);
    f.cache.sync(actor(3)); const next = f.sent[1]!; expect(next.generation).toBeGreaterThan(old.generation); expect(next.contents).toEqual([2]);
    f.ack(next.id); expect(f.cache.isSatisfied(actor(3))).toBe(true); expect(f.cache.dirtyEntries()).toEqual([]);
  });
  it('retains a dirty eviction victim until its write completes', () => {
    const f = cacheFixture(1); f.cache.setPolicy('write_back'); f.cache.write(device, 0 as BlockId, [3]);
    expect(f.cache.write(device, 1 as BlockId, [4], 9)).toBe(false); expect(f.cache.peek(device, 0 as BlockId)).toEqual([3]);
    expect(f.cache.peek(device, 1 as BlockId)).toBeNull(); f.ack(f.sent[0]!.id);
    expect(f.cache.write(device, 1 as BlockId, [4], 9)).toBe(true); expect(f.cache.peek(device, 0 as BlockId)).toBeNull();
    expect(f.cache.dirtyEntries()).toEqual([1]);
  });
  it('crash drops only uncommitted dirty data and cancels its outstanding writes', () => {
    const f = cacheFixture(); f.cache.fill(device, 0 as BlockId, [9]); f.cache.setPolicy('write_back'); f.cache.write(device, 1 as BlockId, [10]);
    f.cache.sync(actor(2)); expect(f.cache.dropDirty()).toEqual([1]); expect(f.cancelled).toEqual([f.sent[0]!.id]);
    expect(f.cache.read(device, 0 as BlockId)).toEqual([9]); expect(f.cache.read(device, 1 as BlockId)).toBeNull();
  });
  it('restores pending flush ownership and counters without reissuing a write', () => {
    const a = cacheFixture(); a.cache.setPolicy('write_back'); a.cache.write(device, 0 as BlockId, [5]); a.cache.sync(actor(2));
    const state = a.cache.snapshot(); const b = cacheFixture(); b.cache.restore(structuredClone(state)); expect(b.sent).toEqual([]);
    a.ack(a.sent[0]!.id); b.ack(a.sent[0]!.id); expect(b.cache.snapshot()).toEqual(a.cache.snapshot());
    expect(b.cache.isSatisfied(actor(2))).toBe(true); expect(a.cache.isSatisfied(actor(2))).toBe(true);
  });
});

function spoolFixture(enabled: boolean) {
  let tick = 0; let next = 1;
  const output: number[] = []; const events: EmittableEvent[] = []; const completed: number[] = [];
  const spool = new Spooler({ tick: () => tick as Tick, nextJob: () => next++, emit: event => events.push(event),
    output: (_device, bytes) => output.push(...bytes), complete: job => completed.push(job.id) });
  spool.configure(device, enabled);
  const add = (pid: number, bytes: readonly number[]) => spool.submit(device, { kind: 'actor', actor: actor(pid) }, 42 as InodeId, bytes);
  return { spool, output, events, completed, add, step: () => { tick++; spool.step(); }, setTick: (value: number) => { tick = value; } };
}

describe('printer spool serialization and continuation', () => {
  it('IO-SPOOL-1 exposes corruption when unspooled processes interleave', () => {
    const f = spoolFixture(false); f.add(2, [65, 65, 65]); f.add(3, [66, 66, 66]);
    for (let tick = 0; tick < 6; tick++) f.step();
    expect(f.output).toEqual([65, 66, 65, 66, 65, 66]);
    expect(f.events).toContainEqual({ type: 'fs.corruption', inode: 42, recoverable: false });
  });
  it('serializes complete jobs in FCFS order with no corruption', () => {
    const f = spoolFixture(true); f.add(2, [65, 65, 65]); f.add(3, [66, 66, 66]); f.step();
    expect(f.spool.snapshot()[0]!.jobs[1]!.offset).toBe(0);
    for (let tick = 1; tick < 6; tick++) f.step();
    expect(f.output).toEqual([65, 65, 65, 66, 66, 66]); expect(f.events).toEqual([]); expect(f.completed).toEqual([1, 2]);
    expect(f.spool.snapshot()[0]!.activeJobId).toBeNull();
  });
  it('a fresh spool resumes the same job byte and next queued job', () => {
    const a = spoolFixture(true); a.add(2, [65, 65, 65]); a.add(3, [66, 66]); a.step();
    const b = spoolFixture(true); b.setTick(1); b.spool.restore(structuredClone(a.spool.snapshot()));
    for (let tick = 1; tick < 5; tick++) { a.step(); b.step(); expect(b.spool.snapshot()).toEqual(a.spool.snapshot()); }
    expect(b.output).toEqual(a.output.slice(1)); expect(b.completed).toEqual(a.completed);
  });
  it('cancels the exited actor without emitting the rest of its job', () => {
    const f = spoolFixture(true); f.add(2, [65, 65, 65]); f.add(3, [66, 66]); f.step(); f.spool.removeWaiter(2 as Pid);
    f.step(); f.step(); expect(f.output).toEqual([65, 66, 66]); expect(f.completed).toEqual([2]);
  });
});

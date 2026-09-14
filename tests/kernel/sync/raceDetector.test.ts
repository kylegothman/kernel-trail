import { describe, expect, it } from 'vitest';
import { createKernel } from '@kernel/Kernel';
import { instructionProgram, type Instruction, type Program } from '@kernel/process/Program';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';
import type { EmittableEvent } from '@kernel/EventBus';
import { asPageId, asPid, asResourceId, asTick } from '@kernel/types';
import type { ResourceId, SyncSnapshotActor, SyncSnapshotMemoryOrder, Tid } from '@kernel/types';
import { RaceDetector } from '@kernel/sync/raceDetector';

const CELL = 'region:counter';
const A: SyncSnapshotActor = { pid: asPid(3), tid: 3 as Tid };
const B: SyncSnapshotActor = { pid: asPid(4), tid: 4 as Tid };
const LOCK = asResourceId('mutex:counter');

function counter(initial = 0) {
  let tick = 0, value = initial;
  const events: EmittableEvent[] = [];
  const detector = new RaceDetector({ tick: () => asTick(tick), emit: event => events.push(event) });
  detector.register(CELL, initial);
  return {
    detector, events,
    get value() { return value; },
    clock(next: number) { tick = next; },
    advance() { tick += 1; },
    load(actor: SyncSnapshotActor, held: readonly ResourceId[] = [], rmw = true, atomic = false) {
      tick += 1; detector.load(actor, CELL, value, held, rmw, atomic); return value;
    },
    store(actor: SyncSnapshotActor, replacement: number, held: readonly ResourceId[] = [], rmw = true, atomic = false) {
      tick += 1; const previous = value; value = replacement;
      detector.store(actor, CELL, previous, value, held, rmw ? detector.pending(actor, CELL) : null, atomic);
    },
  };
}

function memory(): SyncSnapshotMemoryOrder {
  return { cells: [{ id: CELL, kind: 'region', region: asResourceId('counter') }], nextWriteId: 0, buffers: [] };
}

describe('two-detector shared-access evidence', () => {
  it('SYNC-RACE-1: 100 unprotected increments each lose 100 updates under the documented interleaving', () => {
    const c = counter();
    for (let index = 0; index < 100; index += 1) {
      const left = c.load(A), right = c.load(B);
      c.advance(); c.advance(); // Each actor's compute is a separate instruction tick.
      c.store(A, left + 1); c.store(B, right + 1);
    }
    expect(c.value).toBe(100);
    expect(c.detector.save().cells[0]?.serialValue).toBe(200);
    const events = c.events.filter(event => event.type === 'sync.race_detected');
    const final = events.at(-1);
    expect(final?.race).toMatchObject({ participants: [3, 4], location: CELL, corruptedValue: 100, expectedValue: 200 });
    if (final === undefined) throw new Error('missing race event');
    expect(final.race.expectedValue - final.race.corruptedValue).toBe(100);
    expect(events.some(event => event.race.interleaving.slice(-4).map(line => line.includes('LOAD ') ? 'load' : 'store').join('/') === 'load/load/store/store')).toBe(true);
  });

  it('reproduces the published four-line example as a direct detector formatting fixture', () => {
    const c = counter(100); c.clock(40);
    const left = c.load(A), right = c.load(B);
    c.store(A, left + 1); c.store(B, right + 1);
    const final = c.events.filter(event => event.type === 'sync.race_detected').at(-1);
    expect(final?.race).toEqual({ tick: 44, participants: [3, 4], location: CELL, corruptedValue: 101, expectedValue: 102,
      interleaving: [
        't=41 P3 LOAD  region:counter -> 100 [holds nothing]',
        't=42 P4 LOAD  region:counter -> 100 [holds nothing]',
        't=43 P3 STORE region:counter <- 101 [holds nothing]',
        't=44 P4 STORE region:counter <- 101 [holds nothing]',
      ] });
    for (const line of final?.race.interleaving ?? []) expect(line).toMatch(/^t=\d+ P\d+ (LOAD |STORE) \S+ (->|<-) -?\d+ \[holds .+\]$/);
  });

  it('SYNC-RACE-2: common-mutex increments serialize to exactly 200 with no races', () => {
    const c = counter();
    for (let index = 0; index < 100; index += 1) for (const actor of [A, B]) {
      const loaded = c.load(actor, [LOCK]); c.advance(); c.store(actor, loaded + 1, [LOCK]);
    }
    expect(c.value).toBe(200); expect(c.events).toEqual([]);
  });

  it('refines different locksets to empty and reports a potential race', () => {
    const c = counter();
    c.load(A, [LOCK]); c.store(A, 1, [LOCK]);
    c.load(B, [asResourceId('mutex:other')]);
    expect(c.detector.save().cells[0]?.lockSet).toEqual([]);
    expect(c.events.some(event => event.type === 'sync.race_detected')).toBe(true);
  });

  it('suppresses 1000 single-actor accesses and 1000 read-only cross-actor accesses', () => {
    const one = counter(), readers = counter();
    for (let index = 0; index < 500; index += 1) { const value = one.load(A); one.store(A, value + 1); }
    for (let index = 0; index < 1000; index += 1) readers.load(index % 2 === 0 ? A : B, [], false);
    expect(one.events).toEqual([]); expect(readers.events).toEqual([]);
  });

  it('10,000 correctly locked increments produce no confirmed or potential reports', () => {
    const c = counter();
    for (let index = 0; index < 10_000; index += 1) {
      const actor = index % 2 === 0 ? A : B;
      const value = c.load(actor, [LOCK]); c.store(actor, value + 1, [LOCK]);
    }
    expect(c.value).toBe(10_000); expect(c.events).toEqual([]);
  });

  it('retains a bounded conflicting pair when the 32-record ring has wrapped', () => {
    const c = counter(); const stale = c.load(A);
    const newer = c.load(B); c.store(B, newer + 1);
    for (let index = 0; index < 100; index += 1) c.load(B, [], false);
    const saved = c.detector.save();
    expect(saved.cells[0]?.history).toHaveLength(32);
    expect(saved.cells[0]?.pending).toHaveLength(1);
    expect(saved.cells[0]?.pending[0]?.witness?.load?.id).toBe(1);
    expect(saved.cells[0]?.pending[0]?.witness?.store.id).toBe(2);
    c.store(A, stale + 1);
    const final = c.events.filter(event => event.type === 'sync.race_detected').at(-1);
    expect(final?.race.interleaving[0]).toBe('t=1 P3 LOAD  region:counter -> 0 [holds nothing]');
    expect(final?.race.interleaving).toContain('t=2 P4 LOAD  region:counter -> 0 [holds nothing]');
    expect(final?.race.interleaving).toContain('t=3 P4 STORE region:counter <- 1 [holds nothing]');
    expect(final?.race.interleaving.length).toBeLessThanOrEqual(36);
    expect(final?.race).toMatchObject({ expectedValue: 2, corruptedValue: 1 });
  });

  it('keeps sibling RMWs and actor-specific locks distinct while events retain unique PIDs', () => {
    const c = counter(), sibling = { pid: A.pid, tid: 30 as Tid };
    const left = c.load(A, [LOCK]), right = c.load(sibling);
    expect(c.detector.save().cells[0]?.pending).toHaveLength(2);
    c.store(A, left + 1, [LOCK]); c.store(sibling, right + 1);
    const final = c.events.filter(event => event.type === 'sync.race_detected').at(-1);
    expect(final?.race).toMatchObject({ participants: [3], expectedValue: 2, corruptedValue: 1 });
  });

  it('suppresses atomic-only access and diagnoses a conflicting mixed pair', () => {
    const c = counter();
    c.load(A, [], false, true); c.store(A, 1, [], false, true);
    c.load(B, [], false, true); c.store(B, 2, [], false, true);
    expect(c.events).toEqual([]);
    c.load(B, [], false);
    expect(c.events.some(event => event.type === 'sync.race_detected')).toBe(true);
  });

  it('does not manufacture a mixed conflict from unrelated read/read and atomic/atomic pairs', () => {
    const c = counter();
    c.load(A, [], false, true); c.load(B, [], false); c.store(B, 1, [], false, true);
    expect(c.events).toEqual([]);
  });

  it('single-actor stale arithmetic is not a cross-actor data race', () => {
    const c = counter(); const stale = c.load(A);
    c.store(A, 1, [], false, true); c.store(A, stale + 1);
    expect(c.value).toBe(1); expect(c.events).toEqual([]);
  });

  it('prepares detached race state and resumes the same lost-update evidence', () => {
    const first = counter(), second = counter();
    first.load(A); first.load(B); first.store(A, 1); second.clock(3);
    const saved = first.detector.save(), before = second.detector.save();
    const commit = second.detector.prepareRestore(saved, memory());
    expect(second.detector.save()).toEqual(before); expect(second.events).toEqual([]);
    commit(); expect(second.detector.save()).toEqual(saved);
    first.store(B, 1);
    second.clock(4); second.detector.store(B, CELL, 1, 1, [], second.detector.pending(B, CELL));
    expect(second.events).toEqual(first.events.slice(-second.events.length));
    expect(second.detector.save()).toEqual(first.detector.save());
  });

  it('rejects malformed history/witness/serial state before changing any live state', () => {
    const c = counter(); c.load(A); c.load(B); c.store(A, 1);
    const before = c.detector.save(), eventsBefore = [...c.events];
    const row = before.cells[0]; if (row === undefined) throw new Error('missing fixture cell');
    const mutations = [
      { ...before, nextAccessId: -1 },
      { ...before, cells: [{ ...row, serialValue: Number.NaN }] },
      { ...before, cells: [{ ...row, history: Array.from({ length: 33 }, () => row.history[0]) }] },
      { ...before, cells: [{ ...row, episodeOrigin: null }] },
      { ...before, cells: [{ ...row, pending: [...row.pending, ...row.pending] }] },
    ];
    for (const mutation of mutations) {
      expect(() => c.detector.prepareRestore(mutation as ReturnType<RaceDetector['save']>, memory())).toThrow();
      expect(c.detector.save()).toEqual(before); expect(c.events).toEqual(eventsBefore);
    }
  });
});


function scheduledCounter(protectedCounter: boolean) {
  const kernel = createKernel({ ...REFERENCE_CONFIG, scheduler: 'rr', schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1 },
    enabledSubsystems: ['process', 'scheduler', 'sync'] }, { threadCreateTicks: 0 });
  const instructions: Instruction[] = [
    { kind: 'sync', operation: { op: 'load', cell: CELL, into: 'counter', rmw: true } },
    { kind: 'sync', operation: { op: 'add', into: 'counter', value: { kind: 'literal', value: 1 } } },
    { kind: 'sync', operation: { op: 'store', cell: CELL, value: { kind: 'register', name: 'counter' }, rmw: true } },
  ];
  if (protectedCounter) {
    kernel.syncSubsystem.createMutex(LOCK);
    instructions.unshift({ kind: 'sync', operation: { op: 'mutex_lock', resource: LOCK } });
    instructions.push({ kind: 'sync', operation: { op: 'mutex_unlock', resource: LOCK } });
  }
  const source = instructionProgram(instructions);
  const program: Program = { ...source, at: index => source.at(index % source.length) };
  const pids = [0, 1].map(index => kernel.spawn({ name: `counter:${index}`, priority: 20, arrival: 0,
    burst: 100 * source.length, service: 100 * source.length, pages: 1 }, { program, serialFraction: 1 }));
  const pcb = kernel.process(pids[0] ?? asPid(0)); if (pcb === undefined) throw new Error('missing counter process');
  const region = asResourceId('counter');
  kernel.ipc.createSharedRegion({ id: region, space: pcb.addressSpaceId, pages: [asPageId(0)], attached: [], value: 0 });
  kernel.syncSubsystem.addRegionCell(CELL, region);
  return { kernel, region, pids };
}

describe('scheduled load/compute/store counter', () => {
  it('records the actual RR q=1 ticks and loses exactly 100 of 200 unprotected increments', () => {
    const f = scheduledCounter(false); const events = f.kernel.run(1000);
    expect(f.kernel.ipc.sharedRegion(f.region)?.value).toBe(100);
    const last = events.filter(event => event.type === 'sync.race_detected').at(-1);
    if (last?.type !== 'sync.race_detected') throw new Error('missing scheduled race');
    expect(last.race.expectedValue).toBe(200); expect(last.race.corruptedValue).toBe(100);
    expect(last.race.participants).toEqual(f.pids);
    const first = events.find(event => event.type === 'sync.race_detected' && event.race.interleaving.length >= 4);
    if (first?.type !== 'sync.race_detected') throw new Error('missing four-access witness');
    expect(first.race.interleaving).toEqual([
      't=1 P2 LOAD  region:counter -> 0 [holds nothing]',
      't=2 P3 LOAD  region:counter -> 0 [holds nothing]',
      't=5 P2 STORE region:counter <- 1 [holds nothing]',
      't=6 P3 STORE region:counter <- 1 [holds nothing]',
    ]);
  });
  it('uses the same scheduled increment body under a mutex and finishes at exactly 200', () => {
    const f = scheduledCounter(true); const events = f.kernel.run(2000);
    expect(f.kernel.ipc.sharedRegion(f.region)?.value).toBe(200);
    expect(events.filter(event => event.type === 'sync.race_detected')).toEqual([]);
    expect(f.kernel.syncSubsystem.saveState().sync.payload.raceDetector.cells[0]?.serialValue).toBe(200);
  });
});

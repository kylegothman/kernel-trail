import { describe, expect, it } from 'vitest';
import { createKernel } from '@kernel/Kernel';
import type { KernelOptions } from '@kernel/Kernel';
import type { EmittableEvent } from '@kernel/EventBus';
import { MemorySubsystem } from '@kernel/memory/MemorySubsystem';
import { effectiveAccessTimeNs, Tlb } from '@kernel/memory/Tlb';
import type { TlbState } from '@kernel/memory/Tlb';
import { instructionProgram } from '@kernel/process/Program';
import type { Instruction } from '@kernel/process/Program';
import { asFrameId, asPageId, asPid, asTick } from '@kernel/types';
import type { AddressSpaceId, Frame, FrameId, KernelEvent } from '@kernel/types';
import { canonical } from '../canonical';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';

const FIRST = 2 as AddressSpaceId;
const SECOND = 3 as AddressSpaceId;

function fixture(capacity = 4) {
  const frames: Frame[] = Array.from({ length: 8 }, (_, index) => ({
    id: asFrameId(index), owner: FIRST, page: asPageId(index), pinned: false,
    loadedAtTick: asTick(0), lastAccessTick: null, referenceBit: false,
  }));
  const frame = (id: FrameId): Frame => {
    const value = frames[id];
    if (value === undefined) throw new Error(`missing frame ${id}`);
    return value;
  };
  const lookup = (id: FrameId): Frame | undefined => frames[id];
  const tlb = new Tlb(capacity, lookup);
  const install = (page: number, tick = 0): boolean => tlb.install(FIRST, asPageId(page), asFrameId(page), asTick(tick));
  return { frames, frame, lookup, tlb, install };
}

describe('TLB effective access time', () => {
  it.each([[0.5, 150], [0.8, 120], [0.9, 110], [0.99, 101]])('MEM-TLB-1: h=%s gives %s ns', (ratio, expected) => {
    expect(effectiveAccessTimeNs(ratio, 100, 0)).toBeCloseTo(expected, 9);
  });

  it.each([[0.8, 130], [0.99, 111]])('MEM-TLB-1b: h=%s with 10 ns search gives %s ns', (ratio, expected) => {
    expect(effectiveAccessTimeNs(ratio, 100, 10)).toBeCloseTo(expected, 9);
  });

  it('handles all-hit, all-miss and zero-cost boundaries', () => {
    expect(effectiveAccessTimeNs(1, 100, 10)).toBe(110);
    expect(effectiveAccessTimeNs(0, 100, 10)).toBe(210);
    expect(effectiveAccessTimeNs(0.5, 0, 0)).toBe(0);
  });

  it('rejects invalid probabilities and non-finite or negative access times', () => {
    for (const ratio of [-0.1, 1.1, NaN, Infinity]) expect(() => effectiveAccessTimeNs(ratio, 100, 0)).toThrow(RangeError);
    for (const time of [-1, NaN, Infinity]) {
      expect(() => effectiveAccessTimeNs(0.8, time, 0)).toThrow(RangeError);
      expect(() => effectiveAccessTimeNs(0.8, 100, time)).toThrow(RangeError);
    }
    expect(() => effectiveAccessTimeNs(0, Number.MAX_VALUE, Number.MAX_VALUE)).toThrow(RangeError);
  });
});

describe('ASID-tagged TLB replacement', () => {
  it('a hit on slot 3 refreshes LRU and prevents that slot from being evicted', () => {
    const { tlb, install } = fixture();
    for (let page = 0; page < 4; page++) install(page, page === 3 ? 0 : 1);
    expect(tlb.lookup(FIRST, asPageId(3), asTick(2))).toBe(3);
    expect(tlb.entries[3]?.lastUsedTick).toBe(2);
    install(4, 3);
    expect(tlb.entries.map(entry => entry.page)).toEqual([4, 1, 2, 3]);
  });

  it('LRU ties evict the lowest slot and reused invalid slots are chosen first', () => {
    const { tlb, install } = fixture();
    for (let page = 0; page < 4; page++) install(page, 1);
    install(4, 2);
    expect(tlb.entries.map(entry => entry.page)).toEqual([4, 1, 2, 3]);
    tlb.shootdown(asFrameId(2));
    install(5, 3);
    expect(tlb.entries.map(entry => entry.page)).toEqual([4, 1, 5, 3]);
  });

  it('keeps both ASIDs cached across 100 alternating process accesses', () => {
    const { tlb, frame, install } = fixture();
    frame(asFrameId(1)).owner = SECOND;
    frame(asFrameId(1)).page = asPageId(0);
    install(0);
    expect(tlb.install(SECOND, asPageId(0), asFrameId(1), asTick(0))).toBe(true);
    for (let tick = 1; tick <= 100; tick++) {
      const first = tick % 2 === 0;
      expect(tlb.lookup(first ? FIRST : SECOND, asPageId(0), asTick(tick))).toBe(first ? 0 : 1);
    }
    expect(tlb.entries.filter(entry => entry.valid)).toHaveLength(2);
  });

  it('explicit flush can target one ASID or invalidate the whole TLB', () => {
    const { tlb, frame, install } = fixture();
    install(0);
    frame(asFrameId(1)).owner = SECOND;
    tlb.install(SECOND, asPageId(1), asFrameId(1), asTick(1));
    tlb.flush(FIRST);
    expect(tlb.lookup(FIRST, asPageId(0), asTick(2))).toBeNull();
    expect(tlb.lookup(SECOND, asPageId(1), asTick(2))).toBe(1);
    tlb.flush();
    expect(tlb.entries.every(entry => !entry.valid)).toBe(true);
  });

  it('shootdown invalidates exactly the entries naming the target frame', () => {
    const { tlb, install } = fixture();
    install(0); install(1); install(2);
    tlb.shootdown(asFrameId(1));
    expect(tlb.entries.map(entry => entry.valid)).toEqual([true, false, true, false]);
    expect(tlb.lookup(FIRST, asPageId(0), asTick(1))).toBe(0);
    expect(tlb.lookup(FIRST, asPageId(1), asTick(1))).toBeNull();
    expect(tlb.lookup(FIRST, asPageId(2), asTick(1))).toBe(2);
  });

  it('updates a mapping in place and reuses stable slot objects', () => {
    const { tlb, frame, install } = fixture();
    const entries = tlb.entries;
    const slots = [...entries];
    install(0);
    frame(asFrameId(4)).page = asPageId(0);
    tlb.install(FIRST, asPageId(0), asFrameId(4), asTick(1));
    expect(tlb.entries.filter(entry => entry.valid)).toHaveLength(1);
    expect(tlb.lookup(FIRST, asPageId(0), asTick(2))).toBe(4);
    tlb.flush();
    expect(tlb.entries).toBe(entries);
    for (let index = 0; index < slots.length; index++) expect(tlb.entries[index]).toBe(slots[index]);
  });

  it('does not cache a COW or IPC alias and leaves physical ownership unchanged', () => {
    const { tlb, frame } = fixture();
    const original = { ...frame(asFrameId(0)) };
    expect(tlb.install(SECOND, asPageId(0), asFrameId(0), asTick(1))).toBe(false);
    expect(tlb.install(FIRST, asPageId(7), asFrameId(0), asTick(1))).toBe(false);
    expect(tlb.lookup(SECOND, asPageId(0), asTick(2))).toBeNull();
    expect(tlb.entries.every(entry => !entry.valid)).toBe(true);
    expect(frame(asFrameId(0))).toEqual(original);
  });

  it.each(['owner', 'page'] as const)('invalidates a stale %s before returning a hit', field => {
    const { tlb, frame, install } = fixture();
    install(0);
    if (field === 'owner') frame(asFrameId(0)).owner = SECOND;
    else frame(asFrameId(0)).page = asPageId(1);
    expect(tlb.lookup(FIRST, asPageId(0), asTick(1))).toBeNull();
    expect(tlb.entries[0]?.valid).toBe(false);
  });

  it('supports a disabled zero-entry TLB and rejects invalid input without truncation', () => {
    const { tlb, install, lookup } = fixture(0);
    expect(install(0)).toBe(false);
    expect(tlb.lookup(FIRST, asPageId(0), asTick(0))).toBeNull();
    tlb.flush(); tlb.shootdown(asFrameId(0));
    expect(tlb.entries).toEqual([]);
    for (const capacity of [-1, 0.5, NaN]) expect(() => new Tlb(capacity, lookup)).toThrow(RangeError);
    expect(() => tlb.lookup(FIRST, asPageId(-1), asTick(0))).toThrow(RangeError);
    expect(() => tlb.install(FIRST, asPageId(0), asFrameId(0), asTick(-1))).toThrow(RangeError);
  });
});

describe('TLB persistence', () => {
  it('preserves slot order, last-use ticks, invalid slots and subsequent LRU decisions', () => {
    const original = fixture();
    for (let page = 0; page < 4; page++) original.install(page, 1);
    original.tlb.lookup(FIRST, asPageId(3), asTick(3));
    original.tlb.shootdown(asFrameId(1));
    const saved = original.tlb.saveState();
    const before = canonical(saved);
    const restored = fixture();
    const entries = restored.tlb.entries;
    const slots = [...entries];
    restored.tlb.restoreState(structuredClone(saved), asTick(3));
    expect(canonical(restored.tlb.saveState())).toBe(before);
    expect(restored.tlb.entries).toBe(entries);
    for (let index = 0; index < slots.length; index++) expect(restored.tlb.entries[index]).toBe(slots[index]);
    for (const f of [original, restored]) { f.install(4, 4); f.install(5, 5); }
    expect(restored.tlb.entries.map(entry => entry.page)).toEqual([5, 4, 2, 3]);
    expect(canonical(restored.tlb.saveState())).toBe(canonical(original.tlb.saveState()));
    expect(canonical(saved)).toBe(before);
  });

  it('validates against prospective frames and delays changes until commit', () => {
    const source = fixture(); source.install(0, 2);
    const target = fixture(); target.frame(asFrameId(0)).owner = null;
    const state = source.tlb.saveState();
    const commit = target.tlb.prepareRestore(state, asTick(2), source.lookup);
    expect(target.tlb.entries.every(entry => !entry.valid)).toBe(true);
    target.frame(asFrameId(0)).owner = FIRST;
    commit();
    expect(target.tlb.lookup(FIRST, asPageId(0), asTick(3))).toBe(0);
  });

  it('rejects malformed or incoherent snapshots without partially replacing slots', () => {
    const { tlb, install } = fixture(2); install(0, 1); install(1, 2);
    const saved = tlb.saveState();
    const first = saved.entries[0]; const second = saved.entries[1];
    if (first === undefined || second === undefined) throw new Error('missing saved slots');
    const invalid: readonly unknown[] = [
      null, { ...saved, version: 2 }, { ...saved, entries: [first] },
      { ...saved, entries: [first, first] },
      { ...saved, entries: [first, { ...second, lastUsedTick: 3 }] },
      { ...saved, entries: [first, { ...second, valid: 'yes' }] },
      { ...saved, entries: [first, { ...second, space: SECOND }] },
      { ...saved, entries: [first, { ...second, page: asPageId(7) }] },
      { ...saved, entries: [first, { ...second, frame: asFrameId(99) }] },
      { ...saved, entries: [first, { ...second, lastUsedTick: NaN }] },
      { ...saved, entries: [first, { ...second, space: -1 }] },
    ];
    const before = canonical(tlb.saveState());
    for (const state of invalid) {
      expect(() => tlb.restoreState(state, asTick(2))).toThrow();
      expect(canonical(tlb.saveState())).toBe(before);
    }
  });

  it('owns detached data after restore rather than retaining the caller arrays', () => {
    const source = fixture(1); source.install(0, 1);
    const first = source.tlb.saveState().entries[0];
    if (first === undefined) throw new Error('missing slot');
    const entry = { ...first };
    const saved: TlbState = { version: 1, entries: [entry] };
    const target = fixture(1); target.tlb.restoreState(saved, asTick(1));
    entry.valid = false;
    entry.lastUsedTick = asTick(99);
    expect(target.tlb.lookup(FIRST, asPageId(0), asTick(2))).toBe(0);
  });
});

describe('memory access event ownership and hit metrics', () => {
  function memoryFixture() {
    const config = { ...REFERENCE_CONFIG, enabledSubsystems: REFERENCE_CONFIG.enabledSubsystems.filter(id => id !== 'vm'), scheduler: 'fcfs' as const };
    const kernel = createKernel({ ...config, enabledSubsystems: ['process', 'scheduler'] });
    const first = kernel.spawn({ name: 'first', priority: 10, arrival: 0, burst: 10, service: 10, pages: 0 });
    const second = kernel.spawn({ name: 'second', priority: 10, arrival: 0, burst: 10, service: 10, pages: 0 });
    const firstPcb = kernel.process(first); const secondPcb = kernel.process(second);
    if (firstPcb === undefined || secondPcb === undefined) throw new Error('missing memory access processes');
    const events: EmittableEvent[] = [];
    let tick = asTick(0);
    const memory = new MemorySubsystem(config, {
      tick: () => tick, process: pid => kernel.process(pid), processes: () => kernel.processes,
      pageTables: new Map(), emit: event => events.push(event),
    });
    const frame = memory.loadPage(firstPcb.addressSpaceId, asPageId(0));
    if (frame === null) throw new Error('failed fixture allocation');
    return { memory, events, first, second, firstPcb, secondPcb, frame,
      advance: () => { tick = asTick(tick + 1); } };
  }

  it('a resident miss emits exactly one tlb.miss and one memory.access from the subsystem', () => {
    const { memory, events, first } = memoryFixture();
    expect(memory.access(first, asPageId(0), false)).toEqual({ hit: true });
    expect(events).toEqual([
      { type: 'tlb.miss', pid: first, page: 0 },
      { type: 'memory.access', pid: first, page: 0, write: false, hit: false },
    ]);
    events.length = 0;
    expect(memory.access(first, asPageId(0), true)).toEqual({ hit: true });
    expect(events).toEqual([{ type: 'memory.access', pid: first, page: 0, write: true, hit: true }]);
  });

  it('reports zero hit rate initially and exactly 0.8 after 80 hits and 20 misses', () => {
    const f = memoryFixture();
    expect(f.memory.metrics().tlbHitRate).toBe(0);
    for (let cycle = 0; cycle < 20; cycle++) {
      f.memory.flush();
      for (let access = 0; access < 5; access++) {
        f.advance();
        f.memory.access(f.first, asPageId(0), false);
      }
    }
    expect(f.events.filter(event => event.type === 'tlb.miss')).toHaveLength(20);
    expect(f.events.filter(event => event.type === 'memory.access' && event.hit)).toHaveLength(80);
    expect(f.memory.metrics().tlbHitRate).toBe(0.8);
  });

  it('reads an authorized shared PTE without caching an entry with a different frame owner', () => {
    const f = memoryFixture();
    const alias = f.memory.pageTables.ensure(f.secondPcb.addressSpaceId, asPageId(0));
    alias.frame = f.frame; alias.valid = true;
    f.memory.access(f.first, asPageId(0), false);
    f.events.length = 0;
    for (let access = 0; access < 2; access++) f.memory.access(f.second, asPageId(0), false);
    expect(f.events.filter(event => event.type === 'tlb.miss')).toHaveLength(2);
    expect(f.memory.tlb.entries.filter(entry => entry.valid).every(entry => entry.space === f.firstPcb.addressSpaceId)).toBe(true);
    expect(f.memory.frameTable.frames[f.frame]?.owner).toBe(f.firstPcb.addressSpaceId);
  });

  it('shoots down a stale PTE translation even while the old physical frame is still owned', () => {
    const f = memoryFixture();
    f.memory.access(f.first, asPageId(0), false);
    const replacement = f.memory.allocateFrame(f.firstPcb.addressSpaceId, asPageId(0));
    if (replacement === null) throw new Error('failed replacement fixture allocation');
    const pte = f.memory.pageTables.ensure(f.firstPcb.addressSpaceId, asPageId(0));
    pte.frame = replacement;
    f.events.length = 0;
    f.memory.access(f.first, asPageId(0), false);
    expect(f.events.filter(event => event.type === 'tlb.miss')).toHaveLength(1);
    expect(f.memory.tlb.entries.find(entry => entry.valid)?.frame).toBe(replacement);
  });
});

describe('kernel TLB integration', () => {
  function kernelFixture(instructions: readonly Instruction[], options: KernelOptions = {}) {
    const kernel = createKernel({ ...REFERENCE_CONFIG, enabledSubsystems: ['process', 'scheduler', 'memory'] }, { threadCreateTicks: 0, ...options });
    const pid = kernel.spawn({ name: 'memory work', priority: 10, arrival: 0, burst: 40, service: 40, pages: 1 },
      { program: instructionProgram(instructions) });
    const pcb = kernel.process(pid);
    const tid = pcb?.threads[0];
    if (pcb === undefined || tid === undefined) throw new Error('missing kernel memory fixture process');
    const events: KernelEvent[] = [];
    kernel.events.onAny(event => events.push(event));
    return { kernel, pid, pcb, events, memory: kernel.memorySubsystem,
      pc: () => kernel.threads.table.get(tid)?.programCounter };
  }

  const twoReads: readonly Instruction[] = [
    { kind: 'access', page: asPageId(0), write: false },
    { kind: 'access', page: asPageId(0), write: false },
  ];

  it('retires a resident TLB miss in two CPU attempts and the following hit in one by default', () => {
    const f = kernelFixture(twoReads);
    const counters: (number | undefined)[] = [];
    for (let tick = 0; tick < 3; tick++) { f.kernel.step(); counters.push(f.pc()); }
    expect(counters).toEqual([0, 1, 2]);
    expect(f.events.filter(event => event.type === 'memory.access').map(event => ({ tick: event.tick, hit: event.hit })))
      .toEqual([{ tick: 1, hit: false }, { tick: 3, hit: true }]);
    expect(f.events.filter(event => event.type === 'tlb.miss')).toHaveLength(1);
    expect(f.events.filter(event => event.type === 'memory.page_fault')).toEqual([]);
    expect(f.memory.pageTables.get(f.pcb.addressSpaceId, asPageId(0))?.accessCount).toBe(2);
    expect(f.memory.metrics().tlbHitRate).toBe(0.5);
  });

  it('honors custom five-attempt misses and three-attempt hits without repeating access or fault events', () => {
    const f = kernelFixture(twoReads, { tlbHitTicks: 3, tlbMissTicks: 5 });
    const counters: (number | undefined)[] = [];
    for (let tick = 0; tick < 8; tick++) { f.kernel.step(); counters.push(f.pc()); }
    expect(counters).toEqual([0, 0, 0, 0, 1, 1, 1, 2]);
    expect(f.events.filter(event => event.type === 'memory.access').map(event => ({ tick: event.tick, hit: event.hit })))
      .toEqual([{ tick: 1, hit: false }, { tick: 6, hit: true }]);
    expect(f.events.filter(event => event.type === 'tlb.miss')).toHaveLength(1);
    expect(f.events.filter(event => event.type === 'memory.page_fault')).toEqual([]);
    expect(f.memory.pageTables.get(f.pcb.addressSpaceId, asPageId(0))?.accessCount).toBe(2);
    expect(f.memory.metrics().tlbHitRate).toBe(0.5);
  });

  it('ioctl tlb_flush invalidates every ASID and unknown subcommands leave translations intact', () => {
    const f = kernelFixture([{ kind: 'compute' }]);
    const second = f.kernel.spawn({ name: 'other address space', priority: 10, arrival: 0, burst: 40, service: 40, pages: 1 },
      { program: instructionProgram([{ kind: 'compute' }]) });
    f.kernel.step();
    f.memory.access(f.pid, asPageId(0), false);
    f.memory.access(second, asPageId(0), false);
    expect(f.memory.tlb.entries.filter(entry => entry.valid)).toHaveLength(2);
    const before = canonical(f.memory.tlb.saveState());
    for (const args of [[], ['unknown'], [42]]) {
      expect(f.kernel.syscall({ name: 'ioctl', pid: f.pid, args })).toMatchObject({ ok: false, errno: 'EINVAL' });
      expect(canonical(f.memory.tlb.saveState())).toBe(before);
    }
    expect(f.kernel.syscall({ name: 'ioctl', pid: f.pid, args: ['tlb_flush'] })).toEqual({ ok: true, value: null });
    expect(f.memory.tlb.entries.every(entry => !entry.valid)).toBe(true);
    expect(f.memory.pageTables.get(f.pcb.addressSpaceId, asPageId(0))?.valid).toBe(true);
  });

  it('exec flushes the caller ASID while preserving another process translation', () => {
    const f = kernelFixture([{ kind: 'compute' }]);
    const second = f.kernel.spawn({ name: 'other address space', priority: 10, arrival: 0, burst: 40, service: 40, pages: 1 },
      { program: instructionProgram([{ kind: 'compute' }]) });
    const other = f.kernel.process(second);
    if (other === undefined) throw new Error('missing exec fixture peer');
    f.kernel.step();
    f.memory.access(f.pid, asPageId(0), false);
    f.memory.access(second, asPageId(0), false);
    const otherEntry = f.memory.tlb.entries.find(entry => entry.valid && entry.space === other.addressSpaceId);
    if (otherEntry === undefined) throw new Error('missing peer translation');
    const before = { ...otherEntry };
    f.kernel.registerProgram('replacement', instructionProgram(Array.from({ length: 10 }, (): Instruction => ({ kind: 'compute' }))));
    expect(f.kernel.syscall({ name: 'exec', pid: f.pid, args: ['replacement'] }).ok).toBe(true);
    expect(f.memory.tlb.entries.some(entry => entry.valid && entry.space === f.pcb.addressSpaceId)).toBe(false);
    expect(otherEntry).toEqual(before);
    expect(f.memory.pageTables.pageTable(f.pcb.addressSpaceId).size).toBe(0);
    expect(f.memory.tlb.lookup(other.addressSpaceId, asPageId(0), f.kernel.tick)).toBe(before.frame);
  });

  it('emits one major fault while a page is pending and gates the successful resident retry', () => {
    const page = asPageId(7);
    const f = kernelFixture([{ kind: 'access', page, write: false }]);
    const calls: { pid: number; page: number; write: boolean }[] = [];
    f.memory.setDemandPaging({
      fault: (pid, requested, write) => { calls.push({ pid, page: requested, write }); return { hit: false }; },
      expireTimers: tick => {
        if (tick === 4 && f.memory.loadPage(f.pcb.addressSpaceId, page) === null) throw new Error('failed demand fixture load');
      },
    });
    const counters: (number | undefined)[] = [];
    const states: (string | undefined)[] = [];
    for (let tick = 0; tick < 5; tick++) { f.kernel.step(); counters.push(f.pc()); states.push(f.kernel.process(f.pid)?.state); }
    expect(calls).toEqual([{ pid: f.pid, page, write: false }]);
    expect(counters).toEqual([0, 0, 0, 0, 1]);
    expect(states).toEqual(['waiting', 'waiting', 'waiting', 'running', 'running']);
    expect(f.events.filter(event => event.type === 'memory.page_fault').map(event => ({ tick: event.tick, pid: event.pid, page: event.page, major: event.major })))
      .toEqual([{ tick: 1, pid: f.pid, page, major: true }]);
    expect(f.events.filter(event => event.type === 'memory.access').map(event => ({ tick: event.tick, hit: event.hit })))
      .toEqual([{ tick: 4, hit: false }]);
    expect(f.events.filter(event => event.type === 'tlb.miss').map(event => event.tick)).toEqual([1, 4]);
  });

  it('COW with the real frame table emits exactly one minor fault and one load before the write retires', () => {
    const f = kernelFixture([{ kind: 'compute' }, { kind: 'access', page: asPageId(0), write: true }]);
    f.kernel.step();
    const source = f.memory.pageTables.get(f.pcb.addressSpaceId, asPageId(0))?.frame;
    if (source === undefined || source === null) throw new Error('missing resident COW page');
    const fork = f.kernel.syscall({ name: 'fork', pid: f.pid, args: [] });
    if (!fork.ok || typeof fork.value !== 'number') throw new Error('COW fixture fork failed');
    const child = f.kernel.process(asPid(fork.value));
    if (child === undefined) throw new Error('missing COW child');
    expect(f.memory.pageTables.get(child.addressSpaceId, asPageId(0))?.frame).toBe(source);
    expect(f.memory.pageTables.get(f.pcb.addressSpaceId, asPageId(0))?.writable).toBe(false);
    const counters: (number | undefined)[] = [];
    for (let tick = 0; tick < 4; tick++) { f.kernel.step(); counters.push(f.pc()); }
    expect(counters).toEqual([1, 1, 1, 2]);
    const replacement = f.memory.pageTables.get(f.pcb.addressSpaceId, asPageId(0))?.frame;
    expect(replacement).not.toBe(source);
    expect(f.memory.pageTables.get(child.addressSpaceId, asPageId(0))?.frame).toBe(source);
    expect(f.memory.pageTables.get(f.pcb.addressSpaceId, asPageId(0))).toMatchObject({ writable: true, dirty: true });
    expect(f.events.filter(event => event.type === 'memory.page_fault').map(event => ({ tick: event.tick, pid: event.pid, major: event.major })))
      .toEqual([{ tick: 2, pid: f.pid, major: false }]);
    expect(f.events.filter(event => event.type === 'memory.page_loaded').map(event => ({ tick: event.tick, pid: event.pid, frame: event.frame })))
      .toEqual([{ tick: 2, pid: f.pid, frame: replacement }]);
    expect(f.events.filter(event => event.type === 'memory.access').map(event => ({ tick: event.tick, write: event.write, hit: event.hit })))
      .toEqual([{ tick: 4, write: true, hit: false }]);
    expect(f.memory.tlb.entries.filter(entry => entry.valid)).toHaveLength(1);
    expect(f.memory.tlb.entries.find(entry => entry.valid)).toMatchObject({ space: f.pcb.addressSpaceId, frame: replacement });
  });
});


describe('final instruction access timing', () => {
  it.each([{ tlbHitTicks: 1, tlbMissTicks: 2 }, { tlbHitTicks: 3, tlbMissTicks: 5 }])('keeps a service-one process alive through its $tlbMissTicks-tick resident miss', tuning => {
    const kernel = createKernel({ ...REFERENCE_CONFIG, enabledSubsystems: REFERENCE_CONFIG.enabledSubsystems.filter(id => id !== 'vm') }, { ...tuning, threadCreateTicks: 0 });
    const pid = kernel.spawn({ name: 'one access', priority: 5, arrival: 0, burst: 1, service: 1, pages: 1 },
      { program: instructionProgram([{ kind: 'access', page: asPageId(0), write: false }]) });
    const events: KernelEvent[] = [];
    for (let attempt = 1; attempt < tuning.tlbMissTicks; attempt++) {
      events.push(...kernel.step());
      expect(kernel.process(pid)).toMatchObject({ state: 'running', serviceRemaining: 1, totalCpuUsed: attempt });
    }
    events.push(...kernel.step());
    expect(kernel.process(pid)).toMatchObject({ state: 'zombie', serviceRemaining: 0, totalCpuUsed: tuning.tlbMissTicks });
    expect(events.filter(event => event.type === 'memory.access')).toHaveLength(1);
    expect(events.filter(event => event.type === 'memory.page_fault')).toHaveLength(0);
    expect(events.filter(event => event.type === 'process.exited').map(event => event.tick)).toEqual([tuning.tlbMissTicks]);
  });
});

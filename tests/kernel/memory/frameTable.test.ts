import { describe, expect, it } from 'vitest';
import { FrameTable, memorySpace } from '@kernel/memory/FrameTable';
import { PageTable } from '@kernel/memory/PageTable';
import { MemorySubsystem } from '@kernel/memory/MemorySubsystem';
import { createKernel } from '@kernel/Kernel';
import { instructionProgram } from '@kernel/process/Program';
import type { EmittableEvent } from '@kernel/EventBus';
import { createRng } from '@kernel/rng';
import { asFrameId, asPageId, asPid, asTick } from '@kernel/types';
import type { AddressSpaceId, FrameId, JsonValue, PageTableEntry, SubsystemEnvelope } from '@kernel/types';
import { canonical } from '../canonical';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';

const space = (value: number): AddressSpaceId => memorySpace(value, 'fixture address space');
function allocate(table: FrameTable, owner = 2, page = 0, pinned = false): FrameId {
  const frame = table.allocate(space(owner), asPageId(page), pinned);
  if (frame === null) throw new Error('fixture exhausted physical memory');
  return frame;
}

describe('physical frame allocation', () => {
  it('keeps a dense live array and ascending free list through 10000 seeded operations', () => {
    const table = new FrameTable(64, { freePoolRetain: 4 });
    const frames = table.frames;
    const free = table.freeList;
    const rng = createRng(0x4b54524c);
    const active = new Set<FrameId>();
    for (let operation = 0; operation < 10000; operation += 1) {
      if (active.size > 0 && rng.chance(0.5)) {
        const ids = [...active].sort((a, b) => a - b);
        const id = rng.pick(ids);
        table.free(id, rng.chance(0.8)); active.delete(id);
      } else {
        const id = table.allocate(space(rng.int(2, 8)), asPageId(operation), false);
        if (id !== null) active.add(id);
      }
      expect(table.frames).toBe(frames);
      expect(table.freeList).toBe(free);
      expect(free.every((id, index) => index === 0 || id > (free[index - 1] ?? -1))).toBe(true);
      expect(new Set([...free, ...table.freePool, ...active]).size).toBe(64);
      expect(free.length + table.freePool.length + active.size).toBe(64);
      expect(frames.every((frame, index) => frame.id === index)).toBe(true);
      expect(free.every(id => frames[id]?.owner === null)).toBe(true);
    }
  });

  it('reuses the same lowest free frame regardless of discard order', () => {
    const first = new FrameTable(8, { freePoolRetain: 0 });
    const second = new FrameTable(8, { freePoolRetain: 0 });
    for (let page = 0; page < 8; page += 1) { allocate(first, 2, page); allocate(second, 2, page); }
    for (const id of [5, 2, 7]) first.free(asFrameId(id));
    for (const id of [7, 5, 2]) second.free(asFrameId(id));
    expect(first.freeList).toEqual(second.freeList);
    expect(allocate(first)).toBe(asFrameId(2));
    expect(allocate(second)).toBe(asFrameId(2));
  });

  it('excludes pinned, unused and retained frames from replacement candidates', () => {
    const table = new FrameTable(8);
    allocate(table, 2, 0, true);
    allocate(table, 3, 0);
    allocate(table, 2, 1);
    allocate(table, 2, 2);
    table.free(asFrameId(2));
    expect(table.unpinnedFrames()).toEqual([asFrameId(1), asFrameId(3)]);
    expect(table.framesOf(space(2))).toEqual([asFrameId(0), asFrameId(2), asFrameId(3)]);
  });

  it('retains mappings in eviction order, spills the oldest and consumes the free list first', () => {
    const table = new FrameTable(6, { freePoolRetain: 4 });
    for (let page = 0; page < 6; page += 1) allocate(table, 2, page);
    for (const id of [3, 1, 4, 2, 0]) table.free(asFrameId(id));
    expect(table.freePool).toEqual([1, 4, 2, 0]);
    expect(table.freeList).toEqual([3]);
    expect(table.frames[1]).toMatchObject({ owner: space(2), page: asPageId(1) });
    expect(table.frames[3]).toMatchObject({ owner: null, page: null });
    expect(allocate(table, 9, 20)).toBe(asFrameId(3));
    expect(allocate(table, 9, 21)).toBe(asFrameId(1));
    expect(table.frames[1]).toMatchObject({ owner: space(9), page: asPageId(21) });
    expect(table.freePool).toEqual([4, 2, 0]);
  });

  it('takes fresh free frames before a lower retained id, and reclaims an exact retained page', () => {
    const table = new FrameTable(4);
    allocate(table, 2, 10);
    table.free(asFrameId(0));
    table.free(asFrameId(0));
    expect(table.freePool).toEqual([0]);
    expect(allocate(table, 3, 10)).toBe(asFrameId(1));
    expect(table.reclaim(space(3), asPageId(10))).toBeNull();
    expect(table.reclaim(space(2), asPageId(10))).toBe(asFrameId(0));
    expect(table.freePool).toEqual([]);
    expect(table.unpinnedFrames()).toEqual([0, 1]);
    table.discard(asFrameId(0));
    expect(table.frames[0]).toMatchObject({ owner: null, page: null });
  });

  it('returns null on exhaustion, including empty physical memory', () => {
    expect(new FrameTable(0).allocate(space(2), asPageId(0), false)).toBeNull();
    const table = new FrameTable(1);
    allocate(table);
    expect(table.allocate(space(2), asPageId(1), false)).toBeNull();
  });

  it('reconciles lifecycle mutations without reallocating an externally owned frame', () => {
    const existing = new FrameTable(4).frames;
    const table = new FrameTable(4, { frames: existing, tick: () => asTick(7) });
    const first = existing[0];
    if (first === undefined) throw new Error('missing fixture frame');
    first.owner = space(8); first.page = asPageId(2);
    expect(allocate(table)).toBe(asFrameId(1));
    expect(table.frames[1]?.loadedAtTick).toBe(asTick(7));
    first.owner = null; first.page = null;
    expect(allocate(table)).toBe(asFrameId(0));
    table.free(asFrameId(0));
    first.owner = space(9); first.page = asPageId(5);
    expect(table.freePool).toEqual([]);
    expect(table.framesOf(space(9))).toEqual([asFrameId(0)]);
  });

  it('round-trips typed detached frame state and resumes identical allocation', () => {
    const table = new FrameTable(8, { tick: () => asTick(10) });
    for (let page = 0; page < 6; page += 1) allocate(table, 2, page, page === 0);
    table.free(asFrameId(3)); table.free(asFrameId(1)); table.discard(asFrameId(4));
    const state = table.saveState();
    const serializable: JsonValue = state;
    expect(() => canonical(serializable)).not.toThrow();
    const restored = new FrameTable(8, { tick: () => asTick(10) });
    const heldFrames = restored.frames;
    const heldFrame = heldFrames[0];
    restored.restoreState(state);
    expect(restored.frames).toBe(heldFrames);
    expect(restored.frames[0]).toBe(heldFrame);
    expect(canonical(restored.saveState())).toBe(canonical(state));
    for (let page = 0; page < 5; page += 1) expect(allocate(restored, 4, page)).toBe(allocate(table, 4, page));
    expect(canonical(restored.saveState())).toBe(canonical(table.saveState()));
    expect(canonical(state)).not.toBe(canonical(table.saveState()));
  });

  it('validates all frame state before mutation and detaches the prepared commit', () => {
    const target = new FrameTable(4);
    allocate(target);
    const before = canonical(target.saveState());
    const source = new FrameTable(4); allocate(source, 9, 3); source.free(asFrameId(0));
    const state = source.saveState();
    const malformed: readonly unknown[] = [
      null, {}, { ...state, totalFrames: 5 }, { ...state, freePoolRetain: -1 },
      { ...state, freeList: [2, 1, 3] }, { ...state, freeList: [1, 1, 2, 3] },
      { ...state, freePool: [0, 0] }, { ...state, freePool: [1] },
      { ...state, frames: state.frames.map(frame => ({ ...frame, id: asFrameId(0) })) },
      { ...state, frames: state.frames.map(frame => ({ ...frame, loadedAtTick: Number.NaN })) },
      { ...state, frames: state.frames.map(frame => ({ ...frame, pinned: true })) },
    ];
    for (const snapshot of malformed) {
      expect(() => target.restoreState(snapshot)).toThrow();
      expect(canonical(target.saveState())).toBe(before);
    }
    const expected = canonical(state);
    const commit = target.prepareRestore(state);
    expect(canonical(target.saveState())).toBe(before);
    const row = state.frames[0];
    if (row === undefined) throw new Error('missing saved frame');
    Reflect.set(row, 'owner', space(42));
    Reflect.set(state.freePool, 0, 3);
    commit();
    expect(canonical(target.saveState())).toBe(expected);
  });
});

describe('live page table adapter', () => {
  it('creates pages lazily and returns the same live map without creating entries on reads', () => {
    const table = new PageTable();
    const view = table.pageTable(space(2));
    expect(view.size).toBe(0);
    expect(table.backing.has(space(2))).toBe(false);
    expect(table.pageTable(space(2))).toBe(view);
    const page = table.ensure(space(2), asPageId(3));
    expect(view.get(asPageId(3))).toBe(page);
    expect(page).toMatchObject({ valid: false, swapped: false, frame: null, accessCount: 0 });
    expect(table.ensure(space(2), asPageId(3))).toBe(page);
  });

  it('observes fork, IPC, replacement and teardown edits through a held map', () => {
    const backing = new Map<AddressSpaceId, PageTableEntry[]>();
    const table = new PageTable(backing);
    const parent = table.ensure(space(2), asPageId(0));
    parent.valid = true; parent.frame = asFrameId(4);
    const child = table.pageTable(space(3));
    backing.set(space(3), [{ ...parent, writable: false }]);
    expect(child.get(asPageId(0))).toMatchObject({ frame: asFrameId(4), writable: false });
    const entries = backing.get(space(3));
    if (entries === undefined) throw new Error('missing child page array');
    entries.push({ ...parent, page: asPageId(7) });
    entries.unshift({ ...parent, page: asPageId(2) });
    expect([...child.keys()]).toEqual([0, 2, 7]);
    entries.splice(entries.findIndex(entry => entry.page === asPageId(2)), 1);
    expect(child.has(asPageId(2))).toBe(false);
    backing.set(space(3), []);
    expect(child.size).toBe(0);
    backing.delete(space(3));
    expect(table.pageTable(space(3))).toBe(child);
    expect([...child]).toEqual([]);
  });

  it('uses ascending pages for every iteration API and detects duplicate backing entries', () => {
    const table = new PageTable();
    for (const page of [7, 2, 4]) table.ensure(space(2), asPageId(page));
    const view = table.pageTable(space(2));
    const keys: number[] = [];
    view.forEach((entry, key, map) => { expect(map).toBe(view); expect(entry.page).toBe(key); keys.push(key); });
    expect(keys).toEqual([2, 4, 7]);
    expect([...view.values()].map(entry => entry.page)).toEqual(keys);
    const entries = table.backing.get(space(2));
    const entry = entries?.[0];
    if (entries === undefined || entry === undefined) throw new Error('missing fixture page array');
    entries[1] = entry;
    expect(() => view.size).toThrow('duplicate page');
  });

  it('round-trips sorted typed pages with stable views and rejects malformed restore atomically', () => {
    const source = new PageTable();
    for (const owner of [8, 2]) for (const page of [7, 1]) source.ensure(space(owner), asPageId(page));
    const state = source.saveState();
    const serializable: JsonValue = state;
    expect(() => canonical(serializable)).not.toThrow();
    const target = new PageTable();
    const held = target.pageTable(space(8));
    target.restoreState(state);
    expect(target.pageTable(space(8))).toBe(held);
    expect([...held.keys()]).toEqual([1, 7]);
    expect(canonical(target.saveState())).toBe(canonical(state));
    const row = state.spaces[0];
    const entry = row?.entries[0];
    if (row === undefined || entry === undefined) throw new Error('missing saved page table');
    const before = canonical(target.saveState());
    const malformed: readonly unknown[] = [null, {},
      { spaces: [row, row] }, { spaces: [{ ...row, entries: [entry, entry] }] },
      { spaces: [{ ...row, entries: [{ ...entry, frame: asFrameId(0), valid: false }] }] },
      { spaces: [{ ...row, entries: [{ ...entry, accessCount: -1 }] }] },
      { spaces: [{ ...row, entries: [{ ...entry, lastAccessTick: Number.POSITIVE_INFINITY }] }] },
    ];
    for (const snapshot of malformed) {
      expect(() => target.restoreState(snapshot)).toThrow();
      expect(canonical(target.saveState())).toBe(before);
    }
    Reflect.set(entry, 'dirty', true);
    expect(target.get(row.space, entry.page)?.dirty).toBe(false);
    expect(target.deletePage(space(8), asPageId(7))).toBe(true);
    expect(target.deletePage(space(8), asPageId(7))).toBe(false);
    expect(target.deleteSpace(space(8))).toBe(true);
    expect(held.size).toBe(0);
  });
});

describe('aggregate memory and VM persistence', () => {
  function fixture(populate = false) {
    const config = { ...REFERENCE_CONFIG, enabledSubsystems: REFERENCE_CONFIG.enabledSubsystems.filter(id => id !== 'vm'), totalFrames: 16, pageSize: 64, tlbEntries: 4 };
    const kernel = createKernel(config, { threadCreateTicks: 0 });
    const pid = kernel.spawn({ name: 'snapshot fixture', priority: 5, burst: 20, service: 20, arrival: 0, pages: 3 });
    const process = kernel.table.get(pid);
    if (process === undefined) throw new Error('missing aggregate fixture process');
    let tick = asTick(5);
    const events: EmittableEvent[] = [];
    const memory = new MemorySubsystem(config, {
      tick: () => tick, process: id => kernel.process(id), processes: () => kernel.processes,
      pageTables: kernel.pageTables, emit: event => events.push(event), accessKey: id => `${id}:0`,
    }, { contiguousBytes: 1024, minBlock: 64, freePoolRetain: 2, tuning: { tlbHitTicks: 1, tlbMissTicks: 3 } });
    if (populate) {
      memory.admit(process);
      const retainedPage = memory.pageTables.get(process.addressSpaceId, asPageId(1));
      const retained = retainedPage?.frame;
      if (retainedPage === undefined || retained === undefined || retained === null) throw new Error('missing retained fixture page');
      retainedPage.valid = false; retainedPage.frame = null; retainedPage.swapped = true;
      memory.frameTable.free(retained);
      const original = memory.pageTables.get(process.addressSpaceId, asPageId(0))?.frame;
      const copy = memory.loadPage(process.addressSpaceId, asPageId(10));
      if (original === undefined || original === null || copy === null) throw new Error('missing content-copy fixture frame');
      memory.copyFrame(original, copy);
      expect(memory.contentTag(copy)).toBe(memory.contentTag(original));
      for (const [id, bytes] of [[2, 128], [3, 96], [4, 128]]) {
        if (id === undefined || bytes === undefined) throw new Error('missing contiguous fixture allocation');
        expect(memory.allocateContiguous(asPid(id), bytes).ok).toBe(true);
      }
      expect(memory.holes.free(asPid(3))).toBe(true);
      memory.setAllocationStrategy('best_fit');
      memory.setFramePolicy('generous', 'proportional', 'global');
      memory.access(pid, asPageId(0), false);
      tick = asTick(6); memory.access(pid, asPageId(0), false);
      tick = asTick(7); memory.access(pid, asPageId(0), false);
      tick = asTick(8); memory.access(pid, asPageId(0), false);
      memory.access(pid, asPageId(2), true);
      expect(memory.accessComplete(pid)).toBe(false);
    } else tick = asTick(8);
    return { memory, pid, owner: process.addressSpaceId, events, advance: (value: number) => { tick = asTick(value); } };
  }

  it('round-trips both envelopes and resumes identical placement, hits, tags and pending access timing', () => {
    const source = fixture(true);
    const state = source.memory.saveState();
    const target = fixture();
    const heldMap = target.memory.pageTables.pageTable(target.owner);
    const heldFrames = target.memory.frameTable.frames;
    const heldTlb = target.memory.tlb.entries;
    target.memory.restoreState(state.memory, state.vm);
    expect(canonical(target.memory.saveState())).toBe(canonical(state));
    expect(canonical(target.memory.metrics())).toBe(canonical(source.memory.metrics()));
    expect(target.memory.contiguousMetrics()).toEqual(source.memory.contiguousMetrics());
    expect(target.memory.contiguousMetrics().externalFragmentation).toBeGreaterThan(0);
    expect(target.memory.activeAllocationStrategy).toBe('best_fit');
    expect(target.memory.framePolicy).toEqual({ rations: 'generous', allocationScheme: 'proportional', replacementScope: 'global' });
    expect(target.memory.pageTables.pageTable(target.owner)).toBe(heldMap);
    expect(target.memory.frameTable.frames).toBe(heldFrames);
    expect(target.memory.tlb.entries).toBe(heldTlb);
    expect(target.memory.frameTable.freePool).toEqual(source.memory.frameTable.freePool);
    source.events.length = 0;
    for (const tick of [9, 10]) {
      source.advance(tick); target.advance(tick);
      expect(target.memory.access(target.pid, asPageId(2), true)).toEqual(source.memory.access(source.pid, asPageId(2), true));
      expect(target.memory.accessComplete(target.pid)).toBe(tick === 10);
      expect(target.memory.accessComplete(target.pid)).toBe(source.memory.accessComplete(source.pid));
    }
    source.advance(11); target.advance(11);
    expect(target.memory.access(target.pid, asPageId(0), false)).toEqual(source.memory.access(source.pid, asPageId(0), false));
    expect(target.memory.loadPage(space(4), asPageId(5))).toBe(source.memory.loadPage(space(4), asPageId(5)));
    expect(target.memory.allocateContiguous(asPid(6), 80)).toEqual(source.memory.allocateContiguous(asPid(6), 80));
    expect(canonical(target.events)).toBe(canonical(source.events));
    expect(canonical(target.memory.metrics())).toBe(canonical(source.memory.metrics()));
    expect(canonical(target.memory.saveState())).toBe(canonical(source.memory.saveState()));
  });

  it('rejects malformed contributions before changing any live table, counter or policy', () => {
    const source = fixture(true);
    const saved = source.memory.saveState();
    const target = fixture();
    const before = canonical(target.memory.saveState());
    const payload = saved.memory.payload;
    const virtual = saved.vm.payload;
    const malformed: readonly (readonly [SubsystemEnvelope, SubsystemEnvelope])[] = [
      [{ ...saved.memory, version: 2 }, saved.vm],
      [saved.memory, { ...saved.vm, version: 1 }],
      [{ ...saved.memory, payload: { ...payload, nextContent: 0 } }, saved.vm],
      [{ ...saved.memory, payload: { ...payload, contents: [...payload.contents, ...payload.contents] } }, saved.vm],
      [{ ...saved.memory, payload: { ...payload, requestedBytes: [...payload.requestedBytes, ...payload.requestedBytes] } }, saved.vm],
      [{ ...saved.memory, payload: { ...payload, rations: 'invalid' } }, saved.vm],
      [{ ...saved.memory, payload: { ...payload, holes: { ...payload.holes, totalBytes: 1 } } }, saved.vm],
      [saved.memory, { ...saved.vm, payload: { ...virtual, tlbHits: -1 } }],
      [saved.memory, { ...saved.vm, payload: { ...virtual, tlbMisses: Number.POSITIVE_INFINITY } }],
      [saved.memory, { ...saved.vm, payload: { ...virtual, pending: virtual.pending.map(entry => ({ ...entry, pid: asPid(99) })) } }],
      [saved.memory, { ...saved.vm, payload: { ...virtual, pending: virtual.pending.map(entry => ({ ...entry, remaining: 0 })) } }],
      [saved.memory, { ...saved.vm, payload: { ...virtual, pending: virtual.pending.map(entry => ({ ...entry, lastAttemptTick: asTick(9) })) } }],
    ];
    for (const [memory, vm] of malformed) {
      expect(() => target.memory.restoreState(memory, vm)).toThrow();
      expect(canonical(target.memory.saveState())).toBe(before);
    }
  });

  it('detaches a prepared aggregate restore from later edits to its source envelope', () => {
    const source = fixture(true);
    const saved = source.memory.saveState();
    const expected = canonical(saved);
    const target = fixture();
    const before = canonical(target.memory.saveState());
    const commit = target.memory.prepareRestore(saved.memory, saved.vm);
    expect(canonical(target.memory.saveState())).toBe(before);
    Reflect.set(saved.memory.payload.contents, 0, [asFrameId(0), 999]);
    Reflect.set(saved.vm.payload, 'tlbHits', 999);
    const pending = saved.vm.payload.pending[0];
    if (pending === undefined) throw new Error('missing saved pending access');
    Reflect.set(pending, 'remaining', 1);
    commit();
    expect(canonical(target.memory.saveState())).toBe(expected);
  });

  it('rejects future frame and PTE timestamps atomically', () => {
    const source = fixture(true);
    const saved = source.memory.saveState();
    const target = fixture();
    const before = canonical(target.memory.saveState());
    const payload = saved.memory.payload;
    const futureFrame = { ...saved.memory, payload: { ...payload, frames: { ...payload.frames,
      frames: payload.frames.frames.map(frame => frame.owner === null ? frame : { ...frame, loadedAtTick: asTick(99) }),
    } } };
    const futurePage = { ...saved.memory, payload: { ...payload, pageTables: { spaces: payload.pageTables.spaces.map(row => ({ ...row,
      entries: row.entries.map(entry => ({ ...entry, lastAccessTick: asTick(99) })),
    })) } } };
    for (const memory of [futureFrame, futurePage]) {
      expect(() => target.memory.restoreState(memory, saved.vm)).toThrow();
      expect(canonical(target.memory.saveState())).toBe(before);
    }
  });

  it('rejects a retained free-pool frame that is still named by a resident PTE', () => {
    const source = fixture(true);
    const saved = source.memory.saveState();
    const target = fixture();
    const before = canonical(target.memory.saveState());
    const retained = saved.memory.payload.frames.freePool[0];
    if (retained === undefined) throw new Error('missing retained snapshot frame');
    const altered = { ...saved.memory, payload: { ...saved.memory.payload, pageTables: {
      spaces: saved.memory.payload.pageTables.spaces.map(row => ({ ...row, entries: row.entries.map(entry => entry.page === asPageId(1)
        ? { ...entry, valid: true, swapped: false, frame: retained } : entry) })),
    } } };
    expect(() => target.memory.restoreState(altered, saved.vm)).toThrow();
    expect(canonical(target.memory.saveState())).toBe(before);
  });

  it('releases retained mappings and their content tags when an address space is torn down', () => {
    const source = fixture(true);
    const retained = source.memory.frameTable.freePool[0];
    if (retained === undefined) throw new Error('missing retained fixture frame');
    source.memory.freeAddressSpace(source.owner);
    expect(source.memory.frameTable.framesOf(source.owner)).toEqual([]);
    expect(source.memory.frameTable.freePool).toEqual([]);
    expect(source.memory.contentTag(retained)).toBeUndefined();
    expect(source.memory.accessComplete(source.pid)).toBe(true);
  });

  it('materializes one source content tag for repeated copies of an externally allocated frame', () => {
    const source = fixture();
    const original = source.memory.frameTable.allocate(source.owner, asPageId(0), false);
    const first = source.memory.allocateFrame(source.owner, asPageId(1));
    const second = source.memory.allocateFrame(source.owner, asPageId(2));
    if (original === null || first === null || second === null) throw new Error('missing external copy fixture frame');
    source.memory.copyFrame(original, first);
    source.memory.copyFrame(original, second);
    expect(source.memory.contentTag(original)).toBeDefined();
    expect(source.memory.contentTag(first)).toBe(source.memory.contentTag(original));
    expect(source.memory.contentTag(second)).toBe(source.memory.contentTag(original));
  });
});


describe('kernel memory snapshot dispatch and teardown', () => {
  it('dispatches snapshot-only registrations and validates them before changing kernel state', () => {
    const kernel = createKernel(REFERENCE_CONFIG);
    let retained = 5;
    kernel.installHooks({ snapshots: {
      saveState: () => ({ fs: { owner: 'fs', version: 1, payload: retained } }),
      restoreState: snapshot => {
        const value = snapshot.subsystems?.fs?.payload;
        if (typeof value !== 'number' || value < 0) throw new Error('invalid fixture contribution');
        return () => { retained = value; };
      },
    } });
    kernel.run(3); const saved = kernel.snapshot();
    expect(saved.subsystems?.memory?.owner).toBe('memory'); expect(saved.subsystems?.vm?.owner).toBe('vm');
    retained = 9; kernel.run(2); kernel.restore(saved);
    expect(retained).toBe(5); expect(canonical(kernel.snapshot())).toBe(canonical(saved));
    const before = canonical(kernel.snapshot());
    expect(() => kernel.restore({ ...saved, subsystems: { ...saved.subsystems, fs: { owner: 'fs', version: 1, payload: -1 } } })).toThrow();
    expect(canonical(kernel.snapshot())).toBe(before);
  });

  it('restores populated memory/vm slots through KernelSnapshot and rejects contradictory mirror tables', () => {
    const source = createKernel(REFERENCE_CONFIG); source.run(5);
    const memory = source.memorySubsystem;
    const frame = memory.loadPage(space(99), asPageId(3)); if (frame === null) throw new Error('missing backing frame');
    memory.tlb.install(space(99), asPageId(3), frame, source.tick);
    source.setAllocationStrategy('best_fit'); memory.allocateContiguous(asPid(2), 212);
    const saved = source.snapshot(); const target = createKernel(REFERENCE_CONFIG);
    target.restore(saved);
    expect(canonical(target.snapshot())).toBe(canonical(saved));
    expect(target.memorySubsystem.tlb.lookup(space(99), asPageId(3), target.tick)).toBe(frame);
    expect(target.memorySubsystem.allocateContiguous(asPid(3), 417)).toEqual(memory.allocateContiguous(asPid(3), 417));
    const before = canonical(target.snapshot());
    for (const config of [{ ...saved.config, totalFrames: saved.config.totalFrames + 1 }, { ...saved.config, allocationStrategy: 'worst_fit' as const }]) {
      expect(() => target.restore({ ...saved, config })).toThrow(); expect(canonical(target.snapshot())).toBe(before);
    }
    expect(() => target.restore({ ...saved, frames: saved.frames.map(value => value.id === frame ? { ...value, referenceBit: !value.referenceBit } : value) })).toThrow('shared snapshot tables');
    expect(canonical(target.snapshot())).toBe(before);
  });

  it.each(['exit', 'exec'] as const)('%s frees its contiguous partition through the existing lifecycle callbacks', action => {
    const kernel = createKernel(REFERENCE_CONFIG, { threadCreateTicks: 0 });
    const pid = kernel.spawn({ name: 'partition owner', priority: 5, arrival: 0, burst: 20, service: 20, pages: 0 }); kernel.step();
    const memory = kernel.memorySubsystem; const free = memory.holes.totalFreeBytes;
    expect(memory.allocateContiguous(pid, 212).ok).toBe(true);
    kernel.registerProgram('fresh', instructionProgram([{ kind: 'compute' }]));
    expect(kernel.syscall({ name: action, pid, args: action === 'exec' ? ['fresh'] : [0] }).ok).toBe(true);
    expect(memory.holes.partitions).toEqual([]); expect(memory.holes.totalFreeBytes).toBe(free);
  });

  it('computes the published 10575-byte paging waste from byte-granular live requests', () => {
    const kernel = createKernel(REFERENCE_CONFIG); const memory = kernel.memorySubsystem;
    for (const [index, bytes] of [5000, 9000, 1, 4096].entries()) {
      const addressSpace = space(index + 2);
      for (let page = 0; page < Math.ceil(bytes / REFERENCE_CONFIG.pageSize); page++) expect(memory.loadPage(addressSpace, asPageId(page))).not.toBeNull();
      memory.setRequestedBytes(addressSpace, bytes);
    }
    expect(memory.metrics().internalFragmentation).toBe(10575);
    expect(memory.metrics().externalFragmentation).toBe(0);
  });
});


describe('retained page freshness', () => {
  it('chooses the fresh free-list frame before discarding an obsolete retained copy', () => {
    const table = new FrameTable(3);
    const old = allocate(table, 2, 0);
    table.free(old);
    const current = allocate(table, 2, 0);
    expect(old).toBe(asFrameId(0));
    expect(current).toBe(asFrameId(1));
    expect(table.freePool).toEqual([]);
    expect(table.freeList).toEqual([asFrameId(0), asFrameId(2)]);
    expect(table.frames[old]).toMatchObject({ owner: null, page: null });
    table.free(current);
    expect(table.freePool).toEqual([current]);
    expect(table.reclaim(space(2), asPageId(0))).toBe(current);
  });

  it('retaining an externally remapped frame supersedes the older logical page copy', () => {
    const table = new FrameTable(3);
    const old = allocate(table, 2, 0); table.free(old);
    const current = allocate(table, 3, 3);
    const frame = table.frames[current];
    if (frame === undefined) throw new Error('missing externally remapped frame');
    frame.owner = space(2); frame.page = asPageId(0);
    table.free(current);
    expect(table.freePool).toEqual([current]);
    expect(table.freeList).toEqual([asFrameId(0), asFrameId(2)]);
    expect(table.reclaim(space(2), asPageId(0))).toBe(current);
  });

  it('rejects duplicate retained logical pages atomically during restore', () => {
    const source = new FrameTable(3);
    const first = allocate(source, 2, 0); const second = allocate(source, 3, 0);
    source.free(first); source.free(second);
    const saved = source.saveState();
    const malformed = { ...saved, frames: saved.frames.map(frame => frame.id === second
      ? { ...frame, owner: space(2) } : frame) };
    const target = new FrameTable(3); allocate(target, 9, 9);
    const before = canonical(target.saveState());
    expect(() => target.restoreState(malformed)).toThrow('duplicate retained memory page');
    expect(canonical(target.saveState())).toBe(before);
  });

  it('preserves active COW frames sharing owner and page during allocation and restore', () => {
    const source = new FrameTable(3);
    const original = allocate(source, 2, 0); const copy = allocate(source, 2, 0);
    expect([original, copy]).toEqual([asFrameId(0), asFrameId(1)]);
    expect(source.frames[original]).toMatchObject({ owner: space(2), page: asPageId(0) });
    expect(source.frames[copy]).toMatchObject({ owner: space(2), page: asPageId(0) });
    const saved = source.saveState(); const target = new FrameTable(3);
    expect(() => target.restoreState(saved)).not.toThrow();
    expect(canonical(target.saveState())).toBe(canonical(saved));
    expect(target.unpinnedFrames()).toEqual([original, copy]);
  });
});

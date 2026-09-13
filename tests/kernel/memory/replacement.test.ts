import { describe, expect, it } from 'vitest';
import { createReplacementPolicy, REPLACEMENT_POLICIES } from '@kernel/memory/replacement/registry';
import type { PersistentReplacementPolicy } from '@kernel/memory/replacement/registry';
import { memorySpace } from '@kernel/memory/FrameTable';
import { createRng } from '@kernel/rng';
import { asFrameId, asPageId, asTick } from '@kernel/types';
import type { AddressSpaceId, Frame, MemoryContext, PageId, PageReplacementId, PageTableEntry, VmReplacementState } from '@kernel/types';

const STANDARD = [7, 0, 1, 2, 0, 3, 0, 4, 2, 3, 0, 3, 2, 1, 2, 0, 1, 7, 0, 1];
const IDS = Object.keys(REPLACEMENT_POLICIES) as PageReplacementId[];
const SPACE = memorySpace(2, 'replacement fixture space');
function emptyFrame(id: number): Frame {
  return { id: asFrameId(id), owner: null, page: null, pinned: false,
    loadedAtTick: null, lastAccessTick: null, referenceBit: false };
}
function pte(page: number): PageTableEntry {
  return { page: asPageId(page), frame: null, valid: false, dirty: false, referenced: false,
    readable: true, writable: true, executable: true, swapped: false, lastAccessTick: null, accessCount: 0 };
}

class Rig {
  readonly frames: Frame[];
  readonly tables = new Map<AddressSpaceId, Map<PageId, PageTableEntry>>();
  readonly rng = createRng(1234).fork('vm');
  readonly policy: PersistentReplacementPolicy;
  tick = 0;
  future: readonly PageId[] | null = [];
  faults = 0;
  readonly evictions: number[] = [];
  readonly rows: { page: number; handBefore: number | null; bitsBefore: boolean[]; handAfter: number | null; frames: (number | null)[] }[] = [];
  constructor(id: PageReplacementId, count = 3, aging = 0) {
    this.frames = Array.from({ length: count }, (_, id) => emptyFrame(id));
    this.policy = createReplacementPolicy(id, { lfuAging: aging });
    this.policy.reset(this.frames);
  }
  table(space = SPACE): Map<PageId, PageTableEntry> {
    let table = this.tables.get(space);
    if (table === undefined) { table = new Map(); this.tables.set(space, table); }
    return table;
  }
  context(frames: readonly Frame[] = this.frames): MemoryContext {
    const rig = this;
    return { get tick() { return asTick(rig.tick); }, rng: this.rng, frames,
      get futureReferences() { return rig.future; }, pageTable: space => this.table(space), emit: () => {} };
  }
  access(page: number, space = SPACE): void {
    this.tick += 1;
    const ctx = this.context();
    const handBefore = this.policy.snapshot().handIndex;
    const bitsBefore = this.frames.map(frame => frame.referenceBit);
    const table = this.table(space);
    let entry = table.get(asPageId(page));
    if (entry === undefined) { entry = pte(page); table.set(entry.page, entry); }
    let frame = entry.valid ? this.frames.find(frame => frame.id === entry.frame) : undefined;
    if (frame === undefined) {
      this.faults += 1;
      frame = this.frames.find(frame => frame.owner === null && !frame.pinned);
      if (frame === undefined) {
        const victim = this.policy.selectVictim(ctx);
        frame = this.frames.find(frame => frame.id === victim);
      }
      if (frame === undefined) throw new Error('fixture could not select a frame');
      if (frame.owner !== null && frame.page !== null) {
        this.evictions.push(frame.page);
        const victim = this.table(frame.owner).get(frame.page);
        if (victim !== undefined) { victim.valid = false; victim.frame = null; victim.swapped = true; }
      }
      frame.owner = space; frame.page = entry.page;
      entry.frame = frame.id; entry.valid = true; entry.swapped = false;
      this.policy.onLoad(space, entry.page, frame.id, ctx);
    }
    this.policy.onAccess(space, entry.page, frame.id, ctx);
    this.rows.push({ page, handBefore, bitsBefore, handAfter: this.policy.snapshot().handIndex,
      frames: this.frames.map(frame => frame.page) });
  }
  run(references: readonly number[]): this {
    for (let index = 0; index < references.length; index += 1) {
      this.future = references.slice(index + 1).map(asPageId);
      this.access(references[index] as number);
    }
    return this;
  }
  restoreInto(target: Rig): void {
    target.tick = this.tick; target.future = this.future === null ? null : [...this.future];
    for (const [index, frame] of this.frames.entries()) Object.assign(target.frames[index] as Frame, frame);
    target.tables.clear();
    for (const [space, entries] of this.tables) target.tables.set(space,
      new Map([...entries].map(([page, entry]) => [page, { ...entry }])));
    target.rng.restore(this.rng.save());
    target.policy.prepareRestore(JSON.parse(JSON.stringify(this.policy.saveState())) as VmReplacementState,
      target.frames, target.context())();
  }
}

describe('textbook page replacement', () => {
  it.each([
    ['VM-FIFO-1', 'fifo', 15, [7, 0, 1, 2, 3, 0, 4, 2, 3, 0, 1, 2]],
    ['VM-LRU-1', 'lru', 12, [7, 1, 2, 3, 0, 4, 0, 3, 2]],
    ['VM-CLOCK-1', 'clock', 14, [7, 1, 2, 0, 3, 4, 2, 0, 3, 1, 2]],
    ['VM-OPT-1', 'optimal', 9, [7, 1, 0, 4, 3, 2]],
    ['VM-LFU-1', 'lfu', 13, [7, 1, 2, 3, 4, 2, 1, 2, 1, 7]],
  ] as const)('%s has exactly the specified count and eviction order', (_fixture, id, faults, evictions) => {
    const rig = new Rig(id).run(STANDARD);
    expect(rig.faults).toBe(faults);
    expect(rig.evictions).toEqual(evictions);
  });

  it('VM-FIFO-1 reproduces every row of the twenty-reference trace', () => {
    expect(new Rig('fifo').run(STANDARD).rows.map(row => row.frames)).toEqual([
      [7, null, null], [7, 0, null], [7, 0, 1], [2, 0, 1], [2, 0, 1],
      [2, 3, 1], [2, 3, 0], [4, 3, 0], [4, 2, 0], [4, 2, 3],
      [0, 2, 3], [0, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2],
      [0, 1, 2], [0, 1, 2], [7, 1, 2], [7, 0, 2], [7, 0, 1],
    ]);
  });

  it('VM-CLOCK-1 reproduces all three hand-sweep rows and references each new load', () => {
    const rig = new Rig('clock').run(STANDARD);
    expect(rig.rows[7]).toEqual({ page: 4, handBefore: 0, bitsBefore: [true, true, true], handAfter: 1, frames: [4, 0, 3] });
    expect(rig.rows[8]).toEqual({ page: 2, handBefore: 1, bitsBefore: [true, false, false], handAfter: 2, frames: [4, 2, 3] });
    expect(rig.rows[10]).toEqual({ page: 0, handBefore: 2, bitsBefore: [true, true, true], handAfter: 0, frames: [4, 2, 0] });
    expect(rig.rows[0]?.handAfter).toBe(1);
    expect(rig.rows[1]?.bitsBefore).toEqual([true, false, false]);
  });

  it('VM-RANDOM-1 freezes the root/vm seed-1234 trace', () => {
    const rig = new Rig('random').run(STANDARD);
    expect(rig.faults).toBe(13);
    expect(rig.evictions).toEqual([0, 1, 2, 0, 4, 7, 3, 0, 1, 7]);
    const expectedStream = createRng(1234).fork('vm');
    for (let draw = 0; draw < 10; draw += 1) expectedStream.next();
    expect(rig.rng.save()).toEqual(expectedStream.save());
    const repeated = new Rig('random').run(STANDARD);
    expect(repeated.evictions).toEqual(rig.evictions);
    expect(repeated.rng.save()).toEqual(rig.rng.save());
  });
});

describe('replacement contract and tie-breaks', () => {
  it.each(IDS)('%s is a fresh registry policy with a stable snapshot and order array', id => {
    const rig = new Rig(id);
    const view = rig.policy.snapshot(); const order = view.order;
    rig.run([1, 2, 3, 1]);
    expect(rig.policy.snapshot()).toBe(view);
    expect(view.order).toBe(order);
    const first = view.order[0];
    expect(rig.policy.selectVictim(rig.context())).toBe(first);
    expect(createReplacementPolicy(id)).not.toBe(rig.policy);
    rig.policy.reset(rig.frames);
    expect(rig.policy.snapshot()).toBe(view);
  });

  it.each(IDS)('%s excludes pinned and unused frames for 10000 seeded candidate sets', id => {
    const rig = new Rig(id, 16).run(Array.from({ length: 16 }, (_, index) => index));
    const choices = createRng(99);
    rig.future = [];
    for (let iteration = 0; iteration < 10000; iteration += 1) {
      const allowed = choices.int(0, rig.frames.length);
      for (const frame of rig.frames) frame.pinned = frame.id !== allowed;
      const context = rig.context([...rig.frames].reverse());
      const beforeBits = rig.frames.map(frame => frame.referenceBit);
      expect(rig.policy.selectVictim(context)).toBe(allowed);
      expect(rig.policy.snapshot().order).toEqual([allowed]);
      if (id === 'clock') {
        expect(rig.frames.every(frame => !frame.pinned || frame.referenceBit === beforeBits[frame.id])).toBe(true);
      }
    }
    for (const frame of rig.frames) frame.pinned = true;
    expect(() => rig.policy.selectVictim(rig.context())).toThrow('no unpinned replacement frame');
    for (const frame of rig.frames) { frame.pinned = false; frame.owner = null; frame.page = null; }
    expect(() => rig.policy.selectVictim(rig.context())).toThrow('no unpinned replacement frame');
  });

  it.each(['fifo', 'lru', 'lfu', 'optimal'] as const)('%s breaks complete ties by lowest frame id despite reversed context', id => {
    const rig = new Rig(id).run([1, 2, 3]);
    for (const frame of rig.frames) { frame.loadedAtTick = asTick(1); frame.lastAccessTick = null; }
    rig.future = [];
    expect(rig.policy.selectVictim(rig.context([...rig.frames].reverse()))).toBe(0);
  });

  it('LRU falls back to load time, then ranks oldest reference first', () => {
    const rig = new Rig('lru').run([1, 2, 3]);
    (rig.frames[0] as Frame).lastAccessTick = null;
    expect(rig.policy.selectVictim(rig.context())).toBe(0);
    rig.access(1);
    expect(rig.policy.snapshot().order).toEqual([1, 2, 0]);
    expect(rig.table().get(asPageId(1))).toMatchObject({ lastAccessTick: asTick(4), accessCount: 2, referenced: true });
    expect(rig.frames[0]).toMatchObject({ lastAccessTick: asTick(4), referenceBit: true });
  });

  it('Clock orders the dry sweep from its hand without clearing any live bits', () => {
    const rig = new Rig('clock').run([1, 2, 3]);
    (rig.frames[1] as Frame).referenceBit = false;
    const before = structuredClone(rig.frames);
    expect(rig.policy.snapshot().order).toEqual([1, 0, 2]);
    expect(rig.policy.snapshot().handIndex).toBe(0);
    expect(rig.frames).toEqual(before);
    expect(rig.policy.selectVictim(rig.context())).toBe(1);
    expect(rig.frames.map(frame => frame.referenceBit)).toEqual([false, false, true]);
  });

  it('Clock preserves a physical hand and skips out-of-scope frames and their bits', () => {
    const rig = new Rig('clock', 5).run([1, 2, 3, 4, 5]);
    const context = rig.context([rig.frames[1] as Frame, rig.frames[4] as Frame]);
    expect(rig.policy.selectVictim(context)).toBe(1);
    expect(rig.policy.snapshot().handIndex).toBe(1);
    expect(rig.frames.map(frame => frame.referenceBit)).toEqual([true, false, true, true, false]);
    rig.policy.onLoad(SPACE, asPageId(2), asFrameId(1), context);
    rig.policy.onAccess(SPACE, asPageId(2), asFrameId(1), context);
    expect(rig.policy.snapshot().handIndex).toBe(2);
  });

  it('Optimal refuses absent lookahead and chooses infinity before distant finite use', () => {
    const rig = new Rig('optimal').run([1, 2, 3]);
    rig.future = null;
    expect(() => rig.policy.selectVictim(rig.context())).toThrow('requires scripted future references');
    rig.future = [3, 1, 3, 1].map(asPageId);
    expect(rig.policy.selectVictim(rig.context())).toBe(1);
    rig.future = [1, 2, 1, 3].map(asPageId);
    expect(rig.policy.snapshot().order).toEqual([2, 1, 0]);
  });

  it('Random consumes exactly one ascending-candidate draw and no draws for any preview', () => {
    const rig = new Rig('random', 5).run([1, 2, 3, 4, 5]);
    (rig.frames[0] as Frame).pinned = true;
    (rig.frames[3] as Frame).pinned = true;
    const reference = createRng(0); reference.restore(rig.rng.save());
    const context = rig.context([...rig.frames].reverse()); rig.policy.bindContext(context);
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const state = rig.rng.save();
      const expected = reference.pick([1, 2, 4]);
      const preview = rig.policy.snapshot().order[0];
      rig.policy.snapshot(); rig.policy.saveState();
      expect(rig.rng.save()).toEqual(state);
      expect(rig.policy.selectVictim(context)).toBe(expected);
      expect(preview).toBe(expected);
      expect(rig.rng.save()).toEqual(reference.save());
    }
  });
});

describe('LFU residency and aging', () => {
  it('starts at one, acknowledges the immediate load callback once, and counts further same-tick accesses', () => {
    const rig = new Rig('lfu', 1).run([1]);
    const entry = rig.table().get(asPageId(1)) as PageTableEntry;
    expect(entry.accessCount).toBe(1);
    rig.policy.onAccess(SPACE, entry.page, asFrameId(0), rig.context());
    expect(entry.accessCount).toBe(2);
    rig.run([1, 1, 1, 1]);
    expect(entry.accessCount).toBe(6);
    rig.run([2, 1]);
    expect(entry.accessCount).toBe(1);
  });

  it('breaks equal counts by older load before lower frame id', () => {
    const rig = new Rig('lfu').run([1, 2, 3]);
    (rig.frames[0] as Frame).loadedAtTick = asTick(10);
    expect(rig.policy.selectVictim(rig.context())).toBe(1);
  });

  it('ages every elapsed interval once across all spaces, including pinned pages outside local scope', () => {
    const rig = new Rig('lfu', 3, 5).run([1, 2, 3]);
    const other = memorySpace(8, 'other space');
    (rig.frames[2] as Frame).owner = other;
    rig.table(other).set(asPageId(3), { ...(rig.table().get(asPageId(3)) as PageTableEntry) });
    (rig.frames[2] as Frame).pinned = true;
    const entries = [rig.table().get(asPageId(1)), rig.table().get(asPageId(2)), rig.table(other).get(asPageId(3))] as PageTableEntry[];
    for (const entry of entries) entry.accessCount = 17;
    rig.tick = 10;
    const context = rig.context([rig.frames[0] as Frame]);
    rig.policy.advanceTick(context);
    expect(entries.map(entry => entry.accessCount)).toEqual([4, 4, 4]);
    expect(rig.policy.saveState().lastAgingTick).toBe(10);
    rig.policy.advanceTick(context); rig.policy.selectVictim(context);
    expect(entries.map(entry => entry.accessCount)).toEqual([4, 4, 4]);
    rig.tick = 15;
    rig.policy.snapshot(); rig.policy.saveState();
    expect(entries.map(entry => entry.accessCount)).toEqual([4, 4, 4]);
    rig.policy.advanceTick(context);
    expect(entries.map(entry => entry.accessCount)).toEqual([2, 2, 2]);
  });

  it('handles more than 32 elapsed shifts and rejects invalid aging knobs', () => {
    const rig = new Rig('lfu', 1, 1).run([1]);
    const entry = rig.table().get(asPageId(1)) as PageTableEntry;
    entry.accessCount = Number.MAX_SAFE_INTEGER;
    rig.tick = 100;
    rig.policy.advanceTick(rig.context());
    expect(entry.accessCount).toBe(0);
    expect(() => createReplacementPolicy('lfu', { lfuAging: -1 })).toThrow('nonnegative integer');
    expect(() => createReplacementPolicy('lfu', { lfuAging: 0.5 })).toThrow('nonnegative integer');
  });

  it('with lfuAging eight, the formerly hot page zero decays every eight ticks and becomes the victim', () => {
    const rig = new Rig('lfu', 3, 8).run([0, 0, 0, 0, 0, 0, 1, 2]);
    const hot = rig.table().get(asPageId(0)) as PageTableEntry;
    expect(hot.accessCount).toBe(3);
    rig.tick = 16; rig.policy.advanceTick(rig.context());
    expect(hot.accessCount).toBe(1);
    rig.tick = 24; rig.policy.advanceTick(rig.context());
    expect(hot.accessCount).toBe(0);
    expect(rig.policy.selectVictim(rig.context())).toBe(0);
  });
});

describe('replacement continuation', () => {
  it.each(IDS)('%s resumes the same remaining trace, RNG and order after JSON restoration', id => {
    const source = new Rig(id, 3, 5).run(STANDARD.slice(0, 10));
    const restored = new Rig(id, 3, 5);
    source.restoreInto(restored);
    expect(restored.policy.snapshot()).toEqual(source.policy.snapshot());
    const beforeEvictions = source.evictions.length; const beforeFaults = source.faults;
    source.run(STANDARD.slice(10)); restored.run(STANDARD.slice(10));
    expect(restored.evictions).toEqual(source.evictions.slice(beforeEvictions));
    expect(restored.faults).toBe(source.faults - beforeFaults);
    expect(restored.rng.save()).toEqual(source.rng.save());
    expect(restored.policy.saveState()).toEqual(source.policy.saveState());
    expect(restored.frames).toEqual(source.frames);
    expect([...restored.tables]).toEqual([...source.tables]);
  });

  it.each(IDS)('%s validates a complete restore before changing any live policy state', id => {
    const rig = new Rig(id).run([1, 2, 3, 1]);
    const saved = rig.policy.saveState();
    const invalid = [
      { ...saved, order: [asFrameId(99)] },
      { ...saved, order: [asFrameId(0), asFrameId(0)] },
      { ...saved, nextIndex: -1 },
      { ...saved, nextIndex: 99 },
      { ...saved, handIndex: 99 },
      { ...saved, lastAgingTick: asTick(1000) },
    ];
    for (const state of invalid) {
      expect(() => rig.policy.prepareRestore(state, rig.frames, rig.context())).toThrow();
      expect(rig.policy.saveState()).toEqual(saved);
    }
    const beforeFrames = structuredClone(rig.frames);
    const commit = rig.policy.prepareRestore(saved, rig.frames, rig.context());
    expect(rig.frames).toEqual(beforeFrames);
    expect(rig.policy.saveState()).toEqual(saved);
    commit();
    expect(rig.policy.saveState()).toEqual(saved);
  });

  it.each(IDS)('%s persists canonical membership across scope changes and updates excluded alias metadata', id => {
    const rig = new Rig(id).run([1, 2, 3]);
    const globalState = rig.policy.saveState();
    const context = rig.context([rig.frames[1] as Frame]);
    rig.policy.bindContext(context);
    expect(rig.policy.snapshot().order).toEqual([1]);
    expect(rig.policy.saveState()).toEqual(globalState);
    // The COW/shared page can be legal to access while absent from candidates.
    rig.tick += 1;
    rig.policy.onAccess(SPACE, asPageId(1), asFrameId(0), context);
    expect(rig.frames[0]?.lastAccessTick).toBe(rig.tick);
    expect(rig.table().get(asPageId(1))?.accessCount).toBe(2);
    expect(rig.policy.selectVictim(context)).toBe(1);
  });

  it.each(IDS)('%s can prepare against detached frames then bind live frames without resetting policy state', id => {
    const source = new Rig(id, 3, 5).run([1, 2, 3, 1]);
    const restored = new Rig(id, 3, 5);
    const detached = structuredClone(source.frames);
    const context: MemoryContext = { ...source.context(detached), pageTable: space => source.table(space) };
    const commit = restored.policy.prepareRestore(source.policy.saveState(), detached, context);
    source.restoreInto(restored);
    commit();
    restored.policy.bindContext(restored.context(), restored.frames);
    const untouched = structuredClone(detached);
    const beforeEvictions = source.evictions.length;
    source.run([4, 2, 5]); restored.run([4, 2, 5]);
    expect(restored.evictions).toEqual(source.evictions.slice(beforeEvictions));
    expect(restored.frames).toEqual(source.frames);
    expect(detached).toEqual(untouched);
    expect(restored.policy.saveState()).toEqual(source.policy.saveState());
  });
});

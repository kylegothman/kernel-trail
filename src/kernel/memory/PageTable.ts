import { KernelInvariantError } from '../errors';
import { asFrameId, asPageId, asTick } from '../types';
import type { AddressSpaceId, PageId, PageTableEntry } from '../types';
import { memoryArray, memoryBoolean, memoryInteger, memoryObject, memorySpace } from './FrameTable';

export type SavedPageTableEntry = { readonly [K in keyof PageTableEntry]: PageTableEntry[K] };
export type PageTableState = {
  readonly spaces: readonly { readonly space: AddressSpaceId; readonly entries: readonly SavedPageTableEntry[] }[];
};

/** Reconciles lifecycle and IPC array edits whenever a held map view is read. */
class LivePageMap implements ReadonlyMap<PageId, PageTableEntry> {
  private readonly cache = new Map<PageId, PageTableEntry>();
  private readonly seen = new Set<PageId>();
  readonly [Symbol.toStringTag] = 'Map';
  constructor(private readonly entriesForSpace: () => readonly PageTableEntry[]) {}
  get size(): number { this.reconcile(); return this.cache.size; }
  get(page: PageId): PageTableEntry | undefined { this.reconcile(); return this.cache.get(page); }
  has(page: PageId): boolean { this.reconcile(); return this.cache.has(page); }
  entries(): MapIterator<[PageId, PageTableEntry]> { this.reconcile(); return this.cache.entries(); }
  keys(): MapIterator<PageId> { this.reconcile(); return this.cache.keys(); }
  values(): MapIterator<PageTableEntry> { this.reconcile(); return this.cache.values(); }
  [Symbol.iterator](): MapIterator<[PageId, PageTableEntry]> { return this.entries(); }
  forEach(callback: (value: PageTableEntry, key: PageId, map: ReadonlyMap<PageId, PageTableEntry>) => void, thisArg?: unknown): void {
    this.reconcile();
    for (const [page, entry] of this.cache) callback.call(thisArg, entry, page, this);
  }
  private reconcile(): void {
    const entries = this.entriesForSpace();
    let changed = this.cache.size !== entries.length;
    this.seen.clear();
    for (const entry of entries) {
      memoryInteger(entry.page, 'page number');
      if (this.seen.has(entry.page)) throw new KernelInvariantError(18, 'duplicate page table entry');
      this.seen.add(entry.page);
      if (this.cache.get(entry.page) !== entry) changed = true;
    }
    if (!changed) return;
    this.cache.clear();
    for (const entry of [...entries].sort((a, b) => a.page - b.page)) this.cache.set(entry.page, entry);
  }
}

const NO_ENTRIES: readonly PageTableEntry[] = [];

/** The kernel keeps authoritative arrays; consumers receive stable live maps. */
export class PageTable {
  private readonly views = new Map<AddressSpaceId, LivePageMap>();
  constructor(readonly backing: Map<AddressSpaceId, PageTableEntry[]> = new Map()) {}

  pageTable(space: AddressSpaceId): ReadonlyMap<PageId, PageTableEntry> {
    memorySpace(space, 'address space');
    let view = this.views.get(space);
    if (view === undefined) {
      view = new LivePageMap(() => this.backing.get(space) ?? NO_ENTRIES);
      this.views.set(space, view);
    }
    return view;
  }
  get(space: AddressSpaceId, page: PageId): PageTableEntry | undefined { return this.pageTable(space).get(page); }
  ensure(space: AddressSpaceId, page: PageId): PageTableEntry {
    memoryInteger(page, 'page number');
    const existing = this.get(space, page);
    if (existing !== undefined) return existing;
    const entry: PageTableEntry = { page, frame: null, valid: false, dirty: false, referenced: false,
      readable: true, writable: true, executable: false, swapped: false, lastAccessTick: null, accessCount: 0 };
    this.set(space, entry); return entry;
  }
  set(space: AddressSpaceId, entry: PageTableEntry): void {
    memorySpace(space, 'address space');
    memoryInteger(entry.page, 'page number');
    let entries = this.backing.get(space);
    if (entries === undefined) { entries = []; this.backing.set(space, entries); }
    const index = entries.findIndex(existing => existing.page === entry.page);
    if (index < 0) entries.push(entry); else entries[index] = entry;
  }
  deletePage(space: AddressSpaceId, page: PageId): boolean {
    const entries = this.backing.get(space);
    const index = entries?.findIndex(entry => entry.page === page) ?? -1;
    if (entries === undefined || index < 0) return false;
    entries.splice(index, 1); return true;
  }
  deleteSpace(space: AddressSpaceId): boolean { return this.backing.delete(space); }
  spaces(): readonly AddressSpaceId[] { return [...this.backing.keys()].sort((a, b) => a - b); }

  saveState(): PageTableState {
    return { spaces: this.spaces().map(space => ({ space,
      entries: [...this.pageTable(space).values()].map(entry => ({ ...entry })) })) };
  }

  prepareRestore(value: unknown): () => void {
    const source = memoryObject(value, 'page tables');
    const parsed = new Map<AddressSpaceId, PageTableEntry[]>();
    for (const value of memoryArray(source['spaces'], 'address spaces')) {
      const row = memoryObject(value, 'address space');
      const space = memorySpace(row['space'], 'address space id');
      if (parsed.has(space)) throw new Error('duplicate memory address space');
      const pages = new Set<PageId>();
      const entries = memoryArray(row['entries'], 'page entries').map(value => {
        const row = memoryObject(value, 'page entry');
        const page = asPageId(memoryInteger(row['page'], 'page number'));
        if (pages.has(page)) throw new Error('duplicate memory page number');
        pages.add(page);
        const frame = row['frame'] === null ? null : asFrameId(memoryInteger(row['frame'], 'mapped frame'));
        const valid = memoryBoolean(row['valid'], 'page valid');
        if (valid !== (frame !== null)) throw new Error('memory page validity disagrees with frame mapping');
        const entry: PageTableEntry = {
          page, frame, valid, dirty: memoryBoolean(row['dirty'], 'page dirty'),
          referenced: memoryBoolean(row['referenced'], 'page referenced'),
          readable: memoryBoolean(row['readable'], 'page readable'), writable: memoryBoolean(row['writable'], 'page writable'),
          executable: memoryBoolean(row['executable'], 'page executable'), swapped: memoryBoolean(row['swapped'], 'page swapped'),
          lastAccessTick: row['lastAccessTick'] === null ? null : asTick(memoryInteger(row['lastAccessTick'], 'page access tick')),
          accessCount: memoryInteger(row['accessCount'], 'page access count'),
        };
        if (entry.valid && entry.swapped) throw new Error('resident memory page cannot also be swapped');
        return entry;
      }).sort((a, b) => a.page - b.page);
      parsed.set(space, entries);
    }
    return () => {
      this.backing.clear();
      for (const [space, entries] of [...parsed].sort(([a], [b]) => a - b)) this.backing.set(space, entries.map(entry => ({ ...entry })));
    };
  }
  restoreState(value: unknown): void { this.prepareRestore(value)(); }
}

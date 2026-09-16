/**
 * KERNEL TRAIL - save, load and checksum. Architecture section 8.
 *
 * IndexedDB accessed through a thin hand-written wrapper, no library. The
 * access patterns are read one record by key, write one record by key, list a
 * store, delete by key: about 120 lines of IDBRequest plumbing whose entire
 * risk surface is "did you remember to await the transaction". Adding `idb` or
 * `dexie` would import 6 to 45 KB gzip to replace that.
 *
 * The checksum is FNV-1a 64-bit over a canonical serialisation, salted with the
 * build id, as 16 hex characters. It is not a signature and does not pretend to
 * be: the goal is detecting accidental corruption, partial writes and casual
 * hand-editing of `score` in an exported JSON file. Deterministic replay is the
 * actual verification path when it matters.
 */

import type { KernelSnapshot, RngState } from '@kernel/types';
import type { DecisionRecord, LegId, RunState, SaveFile } from '@game/types';

/* ------------------------------------------------------------------ */
/* Schema. Architecture section 8.2.                                   */
/* ------------------------------------------------------------------ */

export const DB_NAME = 'kernel-trail';
export const DB_VERSION = 1;

export type StoreName = 'saves' | 'runs' | 'replays' | 'codex' | 'settings' | 'diagnostics';

export interface StoredSave {
  /** `${runId}:${legIndex}` for boundary saves, `${runId}:provisional` otherwise. */
  readonly id: string;
  readonly runId: string;
  readonly kind: 'boundary' | 'provisional' | 'export';
  readonly legIndex: number;
  readonly savedAtIso: string;
  /** The frozen contract from @game/types, stored verbatim. */
  readonly file: SaveFile;
  /** Build that wrote it. Migration keys off this plus `SaveFile.version`. */
  readonly buildId: string;
  /** Bytes, precomputed so the storage panel need not serialise again. */
  readonly approxBytes: number;
}

export interface RunSummary {
  readonly runId: string;
  readonly seed: number;
  readonly startedAtIso: string;
  readonly updatedAtIso: string;
  readonly discClass: RunState['discClass'];
  readonly difficulty: RunState['difficulty'];
  readonly legIndex: number;
  readonly legId: LegId;
  readonly survivors: number;
  readonly status: RunState['status'];
  readonly score: number;
  /** Set when the most recent load found a checksum mismatch. */
  readonly integrity: 'ok' | 'checksum_failed' | 'unreadable' | 'repaired';
}

export interface ReplayRecord {
  readonly runId: string;
  readonly seed: number;
  readonly buildId: string;
  readonly discClass: RunState['discClass'];
  readonly difficulty: RunState['difficulty'];
  readonly decisions: readonly DecisionRecord[];
  /** RNG states at each leg start, so a replay can begin mid-journey. */
  readonly legEntryRng: readonly (readonly RngState[])[];
  /** Hash of the event log per leg, for the determinism regression test. */
  readonly legEventHashes: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Checksum. Architecture section 8.4.                                 */
/* ------------------------------------------------------------------ */

declare const __BUILD_ID__: string | undefined;

/**
 * Injected by the Vite `define` of architecture section 12.2. Falls back to
 * `dev` so the module is importable in a node test run, where the define does
 * not exist.
 */
export const CHECKSUM_SALT: string =
  typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

/**
 * Deterministic JSON: keys sorted, `undefined` dropped from objects, `-0`
 * normalised to `0`, non-finite numbers rejected, Maps and Sets rejected
 * because the snapshot code must convert them to arrays before they get here.
 *
 * Canonicalisation matters more than the hash function. Two saves representing
 * the same state must produce the same string.
 *
 * This is the same discipline as `tests/kernel/canonical.ts`, and the two agree
 * byte for byte on any value containing no Map and no Set (asserted by the
 * `consistent with kernel canonical` case). Two differences are deliberate:
 * the kernel helper encodes a Map or Set as a sorted array of pairs or items
 * because it compares live kernel state, while this one refuses them so a Map
 * cannot reach a save file unconverted; and the kernel's `hash` is a 32-bit
 * FNV-1a used only to compare fixtures, while `fnv1a64` below is the save
 * checksum. WP-17 scope correction S6.
 */
export function canonicalise(value: unknown): string {
  const out: string[] = [];
  write(value, out);
  return out.join('');
}

function write(v: unknown, out: string[]): void {
  if (v === null) {
    out.push('null');
    return;
  }
  const t = typeof v;
  if (t === 'number') {
    const n = v as number;
    if (!Number.isFinite(n)) throw new Error('Non-finite number in save data.');
    out.push(Object.is(n, -0) ? '0' : String(n));
    return;
  }
  if (t === 'string') {
    out.push(JSON.stringify(v));
    return;
  }
  if (t === 'boolean') {
    out.push(v === true ? 'true' : 'false');
    return;
  }
  if (t === 'undefined') {
    out.push('null');
    return;
  }
  if (Array.isArray(v)) {
    out.push('[');
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out.push(',');
      write(v[i], out);
    }
    out.push(']');
    return;
  }
  if (t === 'object') {
    if (v instanceof Map || v instanceof Set) {
      throw new Error('Map/Set must be converted to arrays before checksumming.');
    }
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    out.push('{');
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key === undefined) continue;
      if (i > 0) out.push(',');
      out.push(JSON.stringify(key), ':');
      write(o[key], out);
    }
    out.push('}');
    return;
  }
  throw new Error(`Unserialisable value of type ${t} in save data.`);
}

/**
 * 64-bit FNV-1a over the UTF-8 bytes of the input, as a pair of unsigned
 * 32-bit halves because JS has no fast u64. Offset basis 0xcbf29ce484222325,
 * prime 2^40 + 0x1b3. The multiply is exact in doubles: each half times
 * 0x1b3 stays under 2^41, and the low half's carry and the `lo << 40` term
 * both land in the high half modulo 2^32. Matches the reference FNV-1a 64
 * vectors on ASCII (`tests/game/checksum.test.ts` cross-checks a BigInt
 * implementation). A lone surrogate is encoded as three bytes so every
 * string still hashes deterministically.
 *
 * The scaffold's version, copied from architecture 8.4, was not FNV-1a: it
 * swapped the halves of the offset basis, dropped the carry between the
 * halves and folded the high byte of a code unit into the high word.
 * Corrected by WP-17; no save existed yet to invalidate.
 */
export function fnv1a64(input: string): string {
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  const mix = (byte: number): void => {
    lo = (lo ^ byte) >>> 0;
    const loProduct = lo * 0x1b3;
    const carry = Math.floor(loProduct / 0x100000000);
    const shifted = (lo * 0x100) >>> 0;
    hi = (hi * 0x1b3 + carry + shifted) >>> 0;
    lo = loProduct >>> 0;
  };
  const three = (c: number): void => {
    mix(0xe0 | (c >> 12));
    mix(0x80 | ((c >> 6) & 0x3f));
    mix(0x80 | (c & 0x3f));
  };
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c < 0x80) {
      mix(c);
    } else if (c < 0x800) {
      mix(0xc0 | (c >> 6));
      mix(0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < input.length) {
      const d = input.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i += 1;
        mix(0xf0 | (cp >> 18));
        mix(0x80 | ((cp >> 12) & 0x3f));
        mix(0x80 | ((cp >> 6) & 0x3f));
        mix(0x80 | (cp & 0x3f));
      } else {
        three(c);
      }
    } else {
      three(c);
    }
  }
  const hex = (n: number): string => n.toString(16).padStart(8, '0');
  return hex(hi) + hex(lo);
}

/**
 * Covers `version`, `run`, `kernel` and `rngStates`. `savedAtIso` is
 * deliberately excluded so that a save written twice from identical state has
 * an identical checksum, which is what makes the deduplication of architecture
 * section 8.5 possible.
 */
export function checksumOf(file: Omit<SaveFile, 'checksum'>, salt: string = CHECKSUM_SALT): string {
  return fnv1a64(
    salt +
      canonicalise({
        version: file.version,
        run: file.run,
        // `canonicalise` refuses a Map, and KernelSnapshot carries one in
        // metrics.memory.workingSets, so it is flattened to a key-sorted array
        // of pairs here. Both write and verify go through this, so the two
        // agree by construction.
        kernel: file.kernel === null ? null : checksumSafeSnapshot(file.kernel),
        rngStates: file.rngStates,
      }),
  );
}

export function verify(file: SaveFile): boolean {
  return checksumOf(file) === file.checksum;
}

export interface SaveFileInput {
  readonly run: RunState;
  readonly kernel: KernelSnapshot | null;
  readonly rngStates: readonly RngState[];
  readonly savedAtIso: string;
}

/**
 * Build a complete `SaveFile`. `run` is deep-copied at write time so a later
 * mutation cannot alter a pending write.
 */
export function buildSaveFile(input: SaveFileInput): SaveFile {
  const body = {
    version: 1 as const,
    savedAtIso: input.savedAtIso,
    run: deepCopy(input.run),
    kernel: input.kernel === null ? null : deepCopy(input.kernel),
    rngStates: input.rngStates.map(
      (s): RngState => ({
        algorithm: s.algorithm,
        words: [s.words[0], s.words[1], s.words[2], s.words[3]],
        label: s.label,
      }),
    ),
  };
  return { ...body, checksum: checksumOf(body) };
}

/**
 * Structured deep copy that keeps Maps as Maps. `KernelSnapshot.metrics.memory`
 * holds a `ReadonlyMap`, so a JSON round trip would silently drop it.
 */
function deepCopy<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>();
    for (const [k, v] of value) copy.set(k, deepCopy(v));
    return copy as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v: unknown) => deepCopy(v)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepCopy(v);
  return out as T;
}

const compareCanonical = (a: unknown, b: unknown): number => {
  const x = canonicalise(a);
  const y = canonicalise(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Numeric keys numerically, string keys by code unit, anything else by canonical form. */
const compareKeys = (a: unknown, b: unknown): number => {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return compareCanonical(a, b);
};

/**
 * Maps and Sets to arrays, recursively, so `canonicalise` accepts the value:
 * a Map becomes key-sorted pairs and a Set a list sorted by canonical form,
 * so the result is independent of insertion order. One rule shared by the
 * save checksum and the replay event log hash (WP-18 scope correction U6),
 * so a save and a replay flatten the same way.
 */
export function withoutMapsAndSets(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Map) {
    const pairs = [...value.entries()].map(([k, v]): readonly [unknown, unknown] => [withoutMapsAndSets(k), withoutMapsAndSets(v)]);
    return pairs.sort((a, b) => compareKeys(a[0], b[0]));
  }
  if (value instanceof Set) {
    return [...value].map((v) => withoutMapsAndSets(v)).sort(compareCanonical);
  }
  if (Array.isArray(value)) return value.map((v: unknown) => withoutMapsAndSets(v));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = withoutMapsAndSets(v);
  return out;
}

/**
 * `KernelSnapshot.metrics.memory.workingSets` and every
 * `ProtectionDomain.rights` are Maps, which `canonicalise` refuses. Convert
 * before checksumming or storing as an exported JSON file. Both are flattened
 * to key-sorted arrays of pairs, so the result is independent of insertion
 * order. (The domain rights were missed by the scaffold; WP-17 added them,
 * and WP-18 generalised the walk to `withoutMapsAndSets` with the same order.)
 */
export function checksumSafeSnapshot(snapshot: KernelSnapshot): unknown {
  return withoutMapsAndSets(snapshot);
}

/* ------------------------------------------------------------------ */
/* The IndexedDB wrapper. Architecture section 8.2.                    */
/* ------------------------------------------------------------------ */

export class Database {
  private db: IDBDatabase | null = null;

  /**
   * The version defaults to the schema's. Tests pass a higher one to drive
   * the `onblocked` path, which only an upgrade can reach; production code
   * never passes it.
   */
  constructor(private readonly version: number = DB_VERSION) {}

  async open(): Promise<void> {
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, this.version);
      req.onupgradeneeded = (): void => {
        const db = req.result;
        // Version 1 creates everything. Later versions branch on
        // req.transaction.oldVersion and never rewrite an existing store.
        if (!db.objectStoreNames.contains('saves')) {
          const saves = db.createObjectStore('saves', { keyPath: 'id' });
          saves.createIndex('byRun', 'runId');
          saves.createIndex('bySavedAt', 'savedAtIso');
        }
        if (!db.objectStoreNames.contains('runs')) {
          const runs = db.createObjectStore('runs', { keyPath: 'runId' });
          runs.createIndex('byStatus', 'status');
          runs.createIndex('byStartedAt', 'startedAtIso');
        }
        if (!db.objectStoreNames.contains('replays')) {
          db.createObjectStore('replays', { keyPath: 'runId' });
        }
        if (!db.objectStoreNames.contains('codex')) {
          db.createObjectStore('codex', { keyPath: 'entryId' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('diagnostics')) {
          const diag = db.createObjectStore('diagnostics', {
            keyPath: 'id',
            autoIncrement: true,
          });
          diag.createIndex('byCreatedAt', 'createdAtIso');
        }
      };
      let abandoned = false;
      req.onsuccess = (): void => {
        // A blocked open already rejected; when the other tab finally lets
        // the upgrade through, the connection it hands back must not leak.
        if (abandoned) req.result.close();
        else resolve(req.result);
      };
      req.onerror = (): void => reject(req.error ?? new Error('indexedDB.open failed'));
      req.onblocked = (): void => {
        abandoned = true;
        reject(new Error('IndexedDB upgrade blocked by another tab.'));
      };
    });

    // A second tab upgrading the schema must not corrupt this one's view.
    this.db.onversionchange = (): void => {
      this.db?.close();
      this.db = null;
    };
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private handle(): IDBDatabase {
    if (this.db === null) throw new Error('Database.open() has not completed.');
    return this.db;
  }

  async get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return this.request<T | undefined>(store, 'readonly', (s) => s.get(key));
  }

  async put<T>(store: StoreName, value: T): Promise<void> {
    await this.request<IDBValidKey>(store, 'readwrite', (s) => s.put(value as never));
  }

  async delete(store: StoreName, key: IDBValidKey): Promise<void> {
    await this.request<undefined>(store, 'readwrite', (s) => s.delete(key));
  }

  async list<T>(store: StoreName, index?: string, limit?: number): Promise<T[]> {
    const source = await this.request<T[]>(store, 'readonly', (s) => {
      const target = index === undefined ? s : s.index(index);
      return limit === undefined ? target.getAll() : target.getAll(null, limit);
    });
    return source;
  }

  private request<T>(
    store: StoreName,
    mode: IDBTransactionMode,
    run: (s: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const tx = this.handle().transaction(store, mode);
      const req = run(tx.objectStore(store));
      req.onsuccess = (): void => resolve(req.result as T);
      req.onerror = (): void => reject(req.error ?? new Error(`${store} request failed`));
      tx.onabort = (): void => reject(tx.error ?? new Error(`${store} transaction aborted`));
    });
  }
}

/* ------------------------------------------------------------------ */
/* Save and load                                                       */
/* ------------------------------------------------------------------ */

export type LoadIntegrity = RunSummary['integrity'];

export interface LoadResult {
  readonly file: SaveFile | null;
  readonly integrity: LoadIntegrity;
}

export interface SaveOptions {
  readonly kind: StoredSave['kind'];
  readonly buildId?: string;
}

/**
 * Write one save record. The id is `${runId}:${legIndex}` for a boundary save
 * and `${runId}:provisional` for the soft one, so a provisional save always
 * overwrites the previous provisional rather than accumulating.
 */
export async function saveGame(
  db: Database,
  file: SaveFile,
  options: SaveOptions,
): Promise<StoredSave> {
  const id =
    options.kind === 'boundary'
      ? `${file.run.runId}:${file.run.legIndex}`
      : `${file.run.runId}:${options.kind}`;

  const record: StoredSave = {
    id,
    runId: file.run.runId,
    kind: options.kind,
    legIndex: file.run.legIndex,
    savedAtIso: file.savedAtIso,
    file,
    buildId: options.buildId ?? CHECKSUM_SALT,
    approxBytes: canonicalise({
      version: file.version,
      run: file.run,
      kernel: file.kernel === null ? null : checksumSafeSnapshot(file.kernel),
      rngStates: file.rngStates,
    }).length,
  };

  await db.put('saves', record);
  return record;
}

/**
 * Read one save by id and verify it. A checksum mismatch is reported rather
 * than thrown, because architecture section 10.4 offers the player the choice
 * of loading a suspect save anyway.
 */
export async function loadGame(db: Database, id: string): Promise<LoadResult> {
  let record: StoredSave | undefined;
  try {
    record = await db.get<StoredSave>('saves', id);
  } catch {
    return { file: null, integrity: 'unreadable' };
  }
  if (record === undefined) return { file: null, integrity: 'unreadable' };

  let ok: boolean;
  try {
    ok = verify(record.file);
  } catch {
    return { file: record.file, integrity: 'unreadable' };
  }
  return { file: record.file, integrity: ok ? 'ok' : 'checksum_failed' };
}

/* ------------------------------------------------------------------ */
/* The replays store. WP-18 scope correction U11.                      */
/* ------------------------------------------------------------------ */

/** One record per run, keyed by `runId`; a later write replaces the earlier. */
export async function writeReplayRecord(db: Database, record: ReplayRecord): Promise<void> {
  await db.put('replays', record);
}

export async function readReplayRecord(db: Database, runId: string): Promise<ReplayRecord | undefined> {
  return db.get<ReplayRecord>('replays', runId);
}

/** Every save for one run, newest first. Drives the continue screen. */
export async function listSaves(db: Database, runId: string): Promise<StoredSave[]> {
  const all = await db.list<StoredSave>('saves');
  return all
    .filter((s) => s.runId === runId)
    .sort((a, b) => (a.savedAtIso < b.savedAtIso ? 1 : a.savedAtIso > b.savedAtIso ? -1 : 0));
}

export async function deleteSave(db: Database, id: string): Promise<void> {
  await db.delete('saves', id);
}

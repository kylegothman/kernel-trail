/**
 * KERNEL TRAIL - the write side of persistence. Architecture sections 8.2,
 * 8.5 and 10.7, WP-17 scope correction S5 and S10.
 *
 * `Database` stays the thin wrapper; this module holds what sits above it:
 * the run summary written beside every save, the twenty-record diagnostics
 * ring, the settings records, the codex profile as one record per entry,
 * and a serialised save queue that skips a write whose content is unchanged.
 * Everything here is plain data and pure functions plus awaited puts; the
 * worker that canonicalises off the main thread is WP-18's and calls the
 * same pure functions.
 */

import { LEG_ORDER, type LegId, type RunState } from '@game/types';
import type { CodexProfileState } from '@game/codexTypes';
import {
  buildSaveFile,
  checksumOf,
  saveGame,
  type Database,
  type RunSummary,
  type SaveFileInput,
  type SaveOptions,
  type StoredSave,
} from '../save';

/* ------------------------------------------------------------------ */
/* Run summaries                                                       */
/* ------------------------------------------------------------------ */

export interface RunTimestamps {
  readonly startedAtIso: string;
  readonly updatedAtIso: string;
}

/** The `runs` record the continue and history screens read without a full save. */
export function summariseRun(
  run: Readonly<RunState>,
  timestamps: RunTimestamps,
  integrity: RunSummary['integrity'] = 'ok',
): RunSummary {
  const legId: LegId = LEG_ORDER[Math.max(0, Math.min(LEG_ORDER.length - 1, run.legIndex))] ?? 'boot_sector';
  return {
    runId: run.runId,
    seed: run.seed,
    startedAtIso: timestamps.startedAtIso,
    updatedAtIso: timestamps.updatedAtIso,
    discClass: run.discClass,
    difficulty: run.difficulty,
    legIndex: run.legIndex,
    legId,
    survivors: run.convoy.filter((m) => m.status !== 'derezzed').length,
    status: run.status,
    score: run.score.total,
    integrity,
  };
}

export async function writeRunSummary(db: Database, summary: RunSummary): Promise<void> {
  await db.put('runs', summary);
}

export interface PersistOptions extends SaveOptions {
  readonly startedAtIso: string;
  readonly integrity?: RunSummary['integrity'];
}

export interface PersistResult {
  readonly record: StoredSave;
  readonly summary: RunSummary;
}

/** Build, write the save, then write the summary, in that order (pre-flight ruling 6.6). */
export async function persistSave(db: Database, input: SaveFileInput, options: PersistOptions): Promise<PersistResult> {
  const file = buildSaveFile(input);
  const record = await saveGame(db, file, { kind: options.kind, ...(options.buildId === undefined ? {} : { buildId: options.buildId }) });
  const summary = summariseRun(file.run, { startedAtIso: options.startedAtIso, updatedAtIso: file.savedAtIso }, options.integrity ?? 'ok');
  await writeRunSummary(db, summary);
  return { record, summary };
}

/**
 * Serialises writes so two triggers (a leg boundary and a tab hide) cannot
 * overlap, and skips a write whose checksum matches the last one written
 * under the same id. Architecture 8.5.
 */
export class SaveService {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly lastChecksum = new Map<string, string>();

  constructor(private readonly db: Database) {}

  /** Returns null when the content was unchanged and nothing was written. */
  save(input: SaveFileInput, options: PersistOptions): Promise<PersistResult | null> {
    const task = async (): Promise<PersistResult | null> => {
      const id = options.kind === 'boundary' ? `${input.run.runId}:${input.run.legIndex}` : `${input.run.runId}:${options.kind}`;
      const checksum = checksumOf({ version: 1, savedAtIso: input.savedAtIso, run: input.run, kernel: input.kernel, rngStates: input.rngStates });
      if (this.lastChecksum.get(id) === checksum) return null;
      const result = await persistSave(this.db, input, options);
      this.lastChecksum.set(id, checksum);
      return result;
    };
    const next = this.chain.then(task, task);
    this.chain = next;
    return next;
  }

  /** Resolves once every queued write has landed. */
  async idle(): Promise<void> {
    await this.chain;
  }
}

/* ------------------------------------------------------------------ */
/* Diagnostics ring                                                    */
/* ------------------------------------------------------------------ */

export const DIAGNOSTICS_CAP = 20;

export interface DiagnosticsBundle {
  readonly createdAtIso: string;
  readonly kind: string;
  readonly message: string;
  /** Plain data only; the record is stored as is. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface StoredDiagnostics extends DiagnosticsBundle {
  readonly id: number;
}

/** Append a bundle and delete the oldest beyond the cap. Architecture 8.2 and 10.7. */
export async function writeDiagnostics(db: Database, bundle: DiagnosticsBundle): Promise<void> {
  await db.put('diagnostics', bundle);
  const all = await db.list<StoredDiagnostics>('diagnostics', 'byCreatedAt');
  const excess = all.length - DIAGNOSTICS_CAP;
  if (excess <= 0) return;
  // The index orders by createdAtIso; ties fall back to the auto key so the
  // oldest write goes first.
  const oldest = [...all].sort((a, b) => (a.createdAtIso < b.createdAtIso ? -1 : a.createdAtIso > b.createdAtIso ? 1 : a.id - b.id));
  for (const record of oldest.slice(0, excess)) await db.delete('diagnostics', record.id);
}

export async function readDiagnostics(db: Database): Promise<StoredDiagnostics[]> {
  return db.list<StoredDiagnostics>('diagnostics', 'byCreatedAt');
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export interface SettingsRecord<T = unknown> {
  readonly key: string;
  readonly value: T;
}

export async function readSetting<T>(db: Database, key: string): Promise<T | undefined> {
  const record = await db.get<SettingsRecord<T>>('settings', key);
  return record?.value;
}

export async function writeSetting<T>(db: Database, key: string, value: T): Promise<void> {
  await db.put<SettingsRecord<T>>('settings', { key, value });
}

/** A small observable record, the shape of the audio engine's settings store (S10). */
export interface SettingsSource<T> {
  get(): T;
  update(patch: Partial<T>): unknown;
  subscribe(listener: (value: T) => void): () => void;
}

/**
 * On boot read the record, normalise it and push it into the store; on every
 * store change write it back. The store applies its own change to the engine,
 * so nothing here calls an engine method. Returns the unsubscribe.
 */
export async function bindSettings<T>(
  db: Database,
  key: string,
  source: SettingsSource<T>,
  normalise: (raw: unknown, fallback: T) => T,
): Promise<() => void> {
  const raw = await readSetting<unknown>(db, key);
  source.update(normalise(raw, source.get()));
  return source.subscribe((value) => {
    void writeSetting(db, key, value);
  });
}

/* ------------------------------------------------------------------ */
/* Codex profile                                                       */
/* ------------------------------------------------------------------ */

/** One record per entry (pre-flight ruling 6.4); `seq` keeps the first-encounter order. */
export interface CodexRecord {
  readonly entryId: string;
  readonly seq: number;
  readonly runId: string;
  readonly legId: LegId;
  readonly firstSeenIso: string;
  readonly demonstrated: boolean;
}

export async function readCodexProfile(db: Database): Promise<CodexProfileState> {
  const records = await db.list<CodexRecord>('codex');
  records.sort((a, b) => a.seq - b.seq || (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
  const firstSeen: Record<string, { runId: string; legId: LegId }> = {};
  for (const r of records) firstSeen[r.entryId] = { runId: r.runId, legId: r.legId };
  return {
    seen: records.map((r) => r.entryId),
    demonstrated: records.filter((r) => r.demonstrated).map((r) => r.entryId),
    firstSeen,
  };
}

export async function writeCodexProfile(db: Database, profile: CodexProfileState, nowIso: string): Promise<void> {
  const existing = new Map<string, CodexRecord>();
  for (const r of await db.list<CodexRecord>('codex')) existing.set(r.entryId, r);
  const demonstrated = new Set(profile.demonstrated);
  for (const [seq, entryId] of profile.seen.entries()) {
    const prior = existing.get(entryId);
    const first = profile.firstSeen[entryId];
    const record: CodexRecord = {
      entryId,
      seq,
      runId: first?.runId ?? prior?.runId ?? '',
      legId: first?.legId ?? prior?.legId ?? 'boot_sector',
      firstSeenIso: prior?.firstSeenIso ?? nowIso,
      demonstrated: demonstrated.has(entryId),
    };
    await db.put('codex', record);
  }
}

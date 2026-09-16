import 'fake-indexeddb/auto';
/**
 * Save and load over IndexedDB, WP-17 acceptance 22, 23, 26, 27, 29 and 30,
 * with the provisional fixtures written against a live workload kernel
 * (WP-11 has merged; pre-flight ruling 6.11).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KernelSnapshot, RngState } from '../../src/kernel/types';
import type { KernelImpl } from '../../src/kernel/Kernel';
import type { RunState, SaveFile } from '../../src/game/types';
import type { CodexProfileState } from '../../src/game/codexTypes';
import { canonical } from '../kernel/canonical';
import { referenceWorkload } from '../kernel/fixtures/workloads';
import {
  DB_NAME,
  DB_VERSION,
  Database,
  buildSaveFile,
  canonicalise,
  checksumSafeSnapshot,
  saveGame,
  type StoredSave,
  type StoreName,
} from '../../src/game/save';
import { loadOutcome, resumeRun, type LoadOutcome } from '../../src/game/persist/LoadService';
import {
  DIAGNOSTICS_CAP,
  SaveService,
  bindSettings,
  persistSave,
  readCodexProfile,
  readDiagnostics,
  readSetting,
  summariseRun,
  writeCodexProfile,
  writeDiagnostics,
  writeSetting,
} from '../../src/game/persist/SaveService';
import { worstCaseRun } from '../ui/fixtures';

const SAVED_AT = '2026-09-15T12:00:00.000Z';
const STARTED_AT = '2026-09-15T10:00:00.000Z';
const KB = 1024;

let db: Database;

async function resetDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    // A blocked delete proceeds once every connection closes; waiting for
    // success rather than resolving on blocked is what keeps a leaked
    // connection visible as a hook timeout instead of a silent wedge.
    req.onsuccess = (): void => resolve();
    req.onerror = (): void => resolve();
  });
}

beforeEach(async () => {
  await resetDatabase();
  db = new Database();
  await db.open();
});

afterEach(async () => {
  db.close();
  await resetDatabase();
});

/** A mid-journey run: leg 7, forty decisions, two tombstones, a dozen codex entries. */
function midJourneyRun(): RunState {
  const run = worstCaseRun();
  for (let i = 0; i < 40; i++) {
    run.decisions.push({ tick: (i * 120) as never, legId: 'the_cistern', kind: 'set_scheduler', choice: i % 2 === 0 ? 'rr q=8' : 'priority_aging', outcome: i % 7 === 0 ? 'costly' : 'good', relatedObjective: i % 5 === 0 ? `obj.${i}` : null });
  }
  run.tombstones.push(
    { member: 'lumen', tick: 900 as never, legId: 'quantum_pass', reason: 'starvation', inscription: 'LUMEN, waited for a turn that never came.', cause: 'Priority scheduling with no aging starves the lowest priority.', codexEntry: 'codex.starvation' },
    { member: 'orrery', tick: 2400 as never, legId: 'the_gridlock', reason: 'deadlock_victim', inscription: 'ORRERY, held one and asked for the other.', cause: 'Circular wait closes when every holder waits on the next.', codexEntry: 'codex.deadlock_detection' },
  );
  for (let i = 0; i < 12; i++) run.codexUnlocked.push(`codex.entry_${i}`);
  for (let i = 0; i < 15; i++) run.objectivesMet.push(`obj.${i}`);
  return run;
}

/** A live workload kernel run mid-leg, and its full snapshot. */
function liveWorkload(ticks = 300): { kernel: KernelImpl; snapshot: KernelSnapshot; rng: readonly RngState[] } {
  const { kernel } = referenceWorkload();
  kernel.run(ticks);
  const snapshot = kernel.snapshot();
  return { kernel, snapshot, rng: snapshot.rng };
}

async function rawOpen(version?: number, onVersionChange?: () => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
    req.onsuccess = (): void => {
      if (onVersionChange !== undefined) req.result.onversionchange = onVersionChange;
      resolve(req.result);
    };
    req.onerror = (): void => reject(req.error ?? new Error('open failed'));
  });
}

describe('Database', () => {
  it('schema: all six stores with their documented key paths and indices', async () => {
    const raw = await rawOpen();
    expect(raw.version).toBe(DB_VERSION);
    const names = [...raw.objectStoreNames].sort();
    expect(names).toEqual(['codex', 'diagnostics', 'replays', 'runs', 'saves', 'settings']);
    const expected: Record<StoreName, { keyPath: string; indices: string[]; autoIncrement: boolean }> = {
      saves: { keyPath: 'id', indices: ['byRun', 'bySavedAt'], autoIncrement: false },
      runs: { keyPath: 'runId', indices: ['byStartedAt', 'byStatus'], autoIncrement: false },
      replays: { keyPath: 'runId', indices: [], autoIncrement: false },
      codex: { keyPath: 'entryId', indices: [], autoIncrement: false },
      settings: { keyPath: 'key', indices: [], autoIncrement: false },
      diagnostics: { keyPath: 'id', indices: ['byCreatedAt'], autoIncrement: true },
    };
    const tx = raw.transaction(names, 'readonly');
    for (const [store, shape] of Object.entries(expected)) {
      const os = tx.objectStore(store);
      expect(os.keyPath, store).toBe(shape.keyPath);
      expect([...os.indexNames].sort(), store).toEqual(shape.indices);
      expect(os.autoIncrement, store).toBe(shape.autoIncrement);
    }
    expect(tx.objectStore('saves').index('byRun').keyPath).toBe('runId');
    expect(tx.objectStore('saves').index('bySavedAt').keyPath).toBe('savedAtIso');
    expect(tx.objectStore('runs').index('byStatus').keyPath).toBe('status');
    expect(tx.objectStore('runs').index('byStartedAt').keyPath).toBe('startedAtIso');
    expect(tx.objectStore('diagnostics').index('byCreatedAt').keyPath).toBe('createdAtIso');
    raw.close();
  });

  it('blocked: an upgrade held open by another tab rejects with a message naming it', async () => {
    // This tab's connection at version 1 ignores versionchange, as a stale tab would.
    const stale = await rawOpen(undefined, () => undefined);
    const upgrading = new Database(DB_VERSION + 1);
    await expect(upgrading.open()).rejects.toThrow(/blocked by another tab/);
    stale.close();
    upgrading.close();
    await resetDatabase();
  });

  it('versionchange: a second tab upgrading the schema closes this connection', async () => {
    await db.put('settings', { key: 'probe', value: 1 });
    const upgrade = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION + 1);
      req.onsuccess = (): void => resolve(req.result);
      req.onerror = (): void => reject(req.error ?? new Error('upgrade failed'));
      req.onblocked = (): void => reject(new Error('the wrapper did not close on versionchange'));
    });
    const other = await upgrade;
    expect(other.version).toBe(DB_VERSION + 1);
    await expect(db.get('settings', 'probe')).rejects.toThrow(/Database.open\(\) has not completed/);
    other.close();
    await resetDatabase();
  });

  it('diagnostics ring: capped at 20 records, oldest deleted on write', async () => {
    expect(DIAGNOSTICS_CAP).toBe(20);
    for (let i = 0; i < 25; i++) {
      await writeDiagnostics(db, { createdAtIso: `2026-09-15T12:00:${String(i).padStart(2, '0')}.000Z`, kind: 'probe', message: `bundle ${i}` });
    }
    const kept = await readDiagnostics(db);
    expect(kept).toHaveLength(20);
    expect(kept.map((b) => b.message)).toEqual(Array.from({ length: 20 }, (_, i) => `bundle ${i + 5}`));
    expect(kept.every((b) => typeof b.id === 'number')).toBe(true);
  });
});

describe('save and load', () => {
  it('boundary save: kernel is null and a mid-journey fixture is under 120 KB', async () => {
    const run = midJourneyRun();
    const file = buildSaveFile({ run, kernel: null, rngStates: [], savedAtIso: SAVED_AT });
    expect(file.kernel).toBeNull();
    const record = await saveGame(db, file, { kind: 'boundary' });
    expect(record.id).toBe(`${run.runId}:7`);
    expect(record.kind).toBe('boundary');
    const bytes = new TextEncoder().encode(JSON.stringify(file)).length;
    console.log(`boundary save: ${(bytes / KB).toFixed(1)} KB (approxBytes ${record.approxBytes})`);
    expect(bytes).toBeLessThan(120 * KB);
    expect(record.approxBytes).toBeLessThan(120 * KB);
    expect(record.approxBytes).toBeGreaterThan(4 * KB);
  });

  it('provisional save: carries a full snapshot of a live workload kernel', async () => {
    const { snapshot, rng } = liveWorkload();
    expect(snapshot.completeness).toBe('full');
    expect(snapshot.subsystems?.process).toBeDefined();
    expect(snapshot.processes.length).toBeGreaterThan(1);
    const file = buildSaveFile({ run: midJourneyRun(), kernel: snapshot, rngStates: rng, savedAtIso: SAVED_AT });
    expect(file.kernel).not.toBeNull();
    expect(file.kernel?.tick).toBe(snapshot.tick);
    const record = await saveGame(db, file, { kind: 'provisional' });
    expect(record.id).toBe(`${file.run.runId}:provisional`);
    const bytes = canonicalise({ version: 1, run: file.run, kernel: checksumSafeSnapshot(snapshot), rngStates: rng }).length;
    console.log(`provisional save: ${(bytes / KB).toFixed(1)} KB canonical (approxBytes ${record.approxBytes}), tick ${String(snapshot.tick)}, ${snapshot.processes.length} processes`);
    expect(record.approxBytes).toBe(bytes);
    expect(record.approxBytes).toBeGreaterThan(20 * KB);
    // A second provisional save replaces the first rather than accumulating.
    const again = await saveGame(db, buildSaveFile({ run: midJourneyRun(), kernel: snapshot, rngStates: rng, savedAtIso: '2026-09-15T12:05:00.000Z' }), { kind: 'provisional' });
    expect(again.id).toBe(record.id);
    const all = await db.list<StoredSave>('saves');
    expect(all).toHaveLength(1);
  });

  it('round trip: save then load then compare gives a canonically identical RunState, for both kinds', async () => {
    const run = midJourneyRun();
    const boundary = buildSaveFile({ run, kernel: null, rngStates: [], savedAtIso: SAVED_AT });
    const b = await saveGame(db, boundary, { kind: 'boundary' });
    const loadedB = await loadOutcome(db, b.id);
    expect(loadedB.kind).toBe('ok');
    if (loadedB.kind === 'ok') {
      expect(canonicalise(loadedB.file.run)).toBe(canonicalise(run));
      expect(canonicalise(loadedB.file)).toBe(canonicalise(boundary));
    }
    const { snapshot, rng } = liveWorkload();
    const provisional = buildSaveFile({ run, kernel: snapshot, rngStates: rng, savedAtIso: SAVED_AT });
    const p = await saveGame(db, provisional, { kind: 'provisional' });
    const loadedP = await loadOutcome(db, p.id);
    expect(loadedP.kind).toBe('ok');
    if (loadedP.kind === 'ok') {
      expect(canonicalise(loadedP.file.run)).toBe(canonicalise(run));
      expect(loadedP.file.kernel).not.toBeNull();
      if (loadedP.file.kernel !== null) expect(canonical(loadedP.file.kernel)).toBe(canonical(snapshot));
    }
  });

  it('load outcomes: all five variants are reachable', async () => {
    const run = midJourneyRun();
    const file = buildSaveFile({ run, kernel: null, rngStates: [], savedAtIso: SAVED_AT });
    const record = await saveGame(db, file, { kind: 'boundary' });
    const kinds: LoadOutcome['kind'][] = [];

    const ok = await loadOutcome(db, record.id);
    kinds.push(ok.kind);

    const missing = await loadOutcome(db, 'run-nobody:3');
    kinds.push(missing.kind);

    const tampered: SaveFile = { ...file, run: { ...file.run, score: { ...file.run.score, total: 123_456 } } };
    await db.put<StoredSave>('saves', { ...record, file: tampered });
    const failed = await loadOutcome(db, record.id);
    kinds.push(failed.kind);
    if (failed.kind === 'checksum_failed') expect(failed.file.run.score.total).toBe(123_456);

    const repaired = await loadOutcome(db, record.id, { repair: () => file });
    kinds.push(repaired.kind);
    if (repaired.kind === 'repaired') expect(canonicalise(repaired.file)).toBe(canonicalise(file));

    await db.put<StoredSave>('saves', { ...record, file: { ...file, version: 9 as unknown as 1 } });
    const unreadable = await loadOutcome(db, record.id);
    kinds.push(unreadable.kind);
    if (unreadable.kind === 'unreadable') expect(unreadable.message).toMatch(/newer/);

    expect(kinds).toEqual(['ok', 'not_found', 'checksum_failed', 'repaired', 'unreadable']);
    // A non-checksummable file is also unreadable rather than a throw.
    await db.put<StoredSave>('saves', { ...record, file: { ...file, run: { ...file.run, legProgress: Number.NaN } } });
    expect((await loadOutcome(db, record.id)).kind).toBe('unreadable');
    // A read failure is unreadable with the cause.
    const closed = new Database();
    const closedOutcome = await loadOutcome(closed, record.id);
    expect(closedOutcome.kind).toBe('unreadable');
    if (closedOutcome.kind === 'unreadable') expect(closedOutcome.message).toMatch(/open\(\) has not completed/);
  });

  it('resume order: a provisional resume calls populate before kernel.restore, and continues byte for byte', async () => {
    const source = liveWorkload(300);
    const run = midJourneyRun();
    const file = buildSaveFile({ run, kernel: source.snapshot, rngStates: source.rng, savedAtIso: SAVED_AT });
    const order: string[] = [];
    const outcome = resumeRun(file, {
      buildKernel: () => {
        order.push('buildKernel');
        // The leg's populate: the same workload the snapshot was taken from.
        const { kernel } = referenceWorkload();
        const restore = kernel.restore.bind(kernel);
        kernel.restore = (snapshot: KernelSnapshot): void => {
          order.push('restore');
          restore(snapshot);
        };
        return kernel;
      },
      populate: () => order.push('populate'),
    });
    expect(order).toEqual(['buildKernel', 'populate', 'restore']);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.resumed).toBe('provisional');
    expect(outcome.kernel.tick).toBe(source.snapshot.tick);
    expect(canonical(outcome.kernel.snapshot())).toBe(canonical(source.kernel.snapshot()));
    const tailA = source.kernel.run(200);
    const tailB = outcome.kernel.run(200);
    expect(tailB.length).toBeGreaterThan(0);
    expect(canonical(tailB)).toBe(canonical(tailA));
    expect(canonical(outcome.kernel.snapshot())).toBe(canonical(source.kernel.snapshot()));
    expect(outcome.run).not.toBe(file.run);
    expect(canonicalise(outcome.run)).toBe(canonicalise(run));

    // Boundary: populate runs and restore is never called.
    const boundaryOrder: string[] = [];
    const boundary = resumeRun(buildSaveFile({ run, kernel: null, rngStates: [], savedAtIso: SAVED_AT }), {
      buildKernel: () => {
        boundaryOrder.push('buildKernel');
        const { kernel } = referenceWorkload();
        kernel.restore = (): void => {
          boundaryOrder.push('restore');
        };
        return kernel;
      },
      populate: () => boundaryOrder.push('populate'),
    });
    expect(boundaryOrder).toEqual(['buildKernel', 'populate']);
    expect(boundary.kind === 'ok' && boundary.resumed).toBe('boundary');

    // A rejected snapshot becomes unreadable rather than a throw (S16).
    const bad = { ...source.snapshot, version: 2 } as unknown as KernelSnapshot;
    const rejected = resumeRun({ ...file, kernel: bad }, {
      buildKernel: () => referenceWorkload().kernel,
      populate: () => undefined,
    });
    expect(rejected.kind).toBe('unreadable');
    if (rejected.kind === 'unreadable') expect(rejected.message).toMatch(/rejected.*unsupported snapshot version/);
  });

  it('world rebuilt: the save contains no mesh, material or camera field', async () => {
    const { snapshot, rng } = liveWorkload();
    const file = buildSaveFile({ run: midJourneyRun(), kernel: snapshot, rngStates: rng, savedAtIso: SAVED_AT });
    const text = canonicalise({ ...file, kernel: checksumSafeSnapshot(snapshot) });
    // `diskHead.position` is a cylinder number, kernel state, and stays.
    const viewKey = /"(mesh|material|camera|scene|texture|shader|quaternion|fov|instanceMatrix|anchor|focus|worldPosition|worldMatrix|matrixWorld)"/;
    const hit = viewKey.exec(text);
    expect(hit === null ? null : text.slice(Math.max(0, hit.index - 60), hit.index + 40), 'view state in the save').toBeNull();
  });

  it('run summary: the runs store is readable without deserialising a full save', async () => {
    const run = midJourneyRun();
    const { snapshot, rng } = liveWorkload();
    const { record, summary } = await persistSave(db, { run, kernel: snapshot, rngStates: rng, savedAtIso: SAVED_AT }, { kind: 'provisional', startedAtIso: STARTED_AT });
    expect(record.kind).toBe('provisional');
    const stored = await db.get<typeof summary>('runs', run.runId);
    expect(stored).toEqual(summary);
    expect(stored).toEqual(summariseRun(run, { startedAtIso: STARTED_AT, updatedAtIso: SAVED_AT }, 'ok'));
    expect(stored?.legId).toBe('allocation_yards');
    expect(stored?.survivors).toBe(5);
    expect(stored?.score).toBe(run.score.total);
    expect(JSON.stringify(stored).length).toBeLessThan(1024);
    const byStatus = await db.list<typeof summary>('runs', 'byStatus');
    expect(byStatus.map((s) => s.runId)).toEqual([run.runId]);
  });

  it('save queue: writes are serialised and an unchanged save is skipped', async () => {
    const service = new SaveService(db);
    const run = midJourneyRun();
    const first = service.save({ run, kernel: null, rngStates: [], savedAtIso: SAVED_AT }, { kind: 'boundary', startedAtIso: STARTED_AT });
    const second = service.save({ run, kernel: null, rngStates: [], savedAtIso: '2026-09-15T12:09:00.000Z' }, { kind: 'boundary', startedAtIso: STARTED_AT });
    expect(await first).not.toBeNull();
    expect(await second).toBeNull();
    run.resources.cycles -= 1;
    const third = await service.save({ run, kernel: null, rngStates: [], savedAtIso: '2026-09-15T12:10:00.000Z' }, { kind: 'boundary', startedAtIso: STARTED_AT });
    expect(third?.record.file.run.resources.cycles).toBe(midJourneyRun().resources.cycles - 1);
    await service.idle();
    expect(await db.list<StoredSave>('saves')).toHaveLength(1);
  });
});

describe('settings and codex records', () => {
  it('settings: read and write one record per key, and bind an observable store', async () => {
    expect(await readSetting(db, 'audio')).toBeUndefined();
    await writeSetting(db, 'audio', { master: 0.5, mute: true });
    expect(await readSetting(db, 'audio')).toEqual({ master: 0.5, mute: true });

    interface Fake { master: number; mute: boolean }
    let current: Fake = { master: 0.8, mute: false };
    const listeners: ((v: Fake) => void)[] = [];
    const updates: Partial<Fake>[] = [];
    const store = {
      get: () => current,
      update: (patch: Partial<Fake>) => {
        updates.push(patch);
        current = { ...current, ...patch };
        for (const l of listeners) l(current);
        return current;
      },
      subscribe: (l: (v: Fake) => void) => {
        listeners.push(l);
        return () => listeners.splice(listeners.indexOf(l), 1);
      },
    };
    const normalise = (raw: unknown, fallback: Fake): Fake => {
      const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Fake>;
      return { master: typeof r.master === 'number' ? r.master : fallback.master, mute: typeof r.mute === 'boolean' ? r.mute : fallback.mute };
    };
    const unsubscribe = await bindSettings(db, 'audio', store, normalise);
    expect(updates).toEqual([{ master: 0.5, mute: true }]);
    store.update({ master: 0.25 });
    await new Promise((r) => setTimeout(r, 5));
    expect(await readSetting(db, 'audio')).toEqual({ master: 0.25, mute: true });
    unsubscribe();
    store.update({ master: 0.1 });
    await new Promise((r) => setTimeout(r, 5));
    expect(await readSetting(db, 'audio')).toEqual({ master: 0.25, mute: true });
  });

  it('codex profile: one record per entry, assembled back in first-encounter order', async () => {
    expect(await readCodexProfile(db)).toEqual({ seen: [], demonstrated: [], firstSeen: {} });
    const profile: CodexProfileState = {
      seen: ['codex.b', 'codex.a', 'codex.c'],
      demonstrated: ['codex.a'],
      firstSeen: { 'codex.b': { runId: 'r1', legId: 'the_weave' }, 'codex.a': { runId: 'r1', legId: 'quantum_pass' }, 'codex.c': { runId: 'r2', legId: 'boot_sector' } },
    };
    await writeCodexProfile(db, profile, SAVED_AT);
    const read = await readCodexProfile(db);
    expect(read).toEqual(profile);
    // Re-writing keeps the original first-seen timestamp and updates demonstrated.
    await writeCodexProfile(db, { ...profile, demonstrated: ['codex.a', 'codex.c'] }, '2026-09-16T00:00:00.000Z');
    const records = await db.list<{ entryId: string; firstSeenIso: string; demonstrated: boolean }>('codex');
    expect(records.map((r) => r.firstSeenIso)).toEqual([SAVED_AT, SAVED_AT, SAVED_AT]);
    expect((await readCodexProfile(db)).demonstrated).toEqual(['codex.a', 'codex.c']);
  });
});

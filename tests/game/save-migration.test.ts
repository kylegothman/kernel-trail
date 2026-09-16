import 'fake-indexeddb/auto';
/**
 * Save file migrations, WP-17 tests section. The registry is empty in this
 * build; the fixture entry below is added and removed by the test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DB_NAME, Database, buildSaveFile, saveGame, type StoredSave } from '../../src/game/save';
import { MIGRATIONS, SAVE_SCHEMA_VERSION, migrateSaveFile } from '../../src/game/persist/migrations';
import { loadOutcome } from '../../src/game/persist/LoadService';
import { canonicalise } from '../../src/game/save';
import { worstCaseRun } from '../ui/fixtures';

const SAVED_AT = '2026-09-15T12:00:00.000Z';
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
  MIGRATIONS.clear();
  await resetDatabase();
});

describe('save migrations', () => {
  it('version 1 identity: a version 1 save loads unchanged', async () => {
    expect(SAVE_SCHEMA_VERSION).toBe(1);
    const file = buildSaveFile({ run: worstCaseRun(), kernel: null, rngStates: [], savedAtIso: SAVED_AT });
    expect(file.version).toBe(1);
    const record = await saveGame(db, file, { kind: 'boundary' });
    const outcome = await loadOutcome(db, record.id);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(canonicalise(outcome.file)).toBe(canonicalise(file));
    const raw = migrateSaveFile(file);
    expect(raw).toEqual({ ok: true, file, migratedFrom: null });
  });

  it('unknown version: a save from a newer build produces unreadable with a clear message, not a throw', async () => {
    const file = buildSaveFile({ run: worstCaseRun(), kernel: null, rngStates: [], savedAtIso: SAVED_AT });
    const record = await saveGame(db, file, { kind: 'boundary' });
    const newer: StoredSave = { ...record, file: { ...file, version: 7 as unknown as 1 } };
    await db.put('saves', newer);
    const outcome = await loadOutcome(db, record.id);
    expect(outcome.kind).toBe('unreadable');
    if (outcome.kind === 'unreadable') expect(outcome.message).toMatch(/version 7 is newer than this build's 1/);
    expect(migrateSaveFile({ version: 'x' })).toEqual({ ok: false, message: "Save file carries an invalid version x." });
    expect(migrateSaveFile(null).ok).toBe(false);
    expect(migrateSaveFile({ version: 0 }).ok).toBe(false);
  });

  it('migration hook: the registry is keyed by version, empty, and a fixture entry runs', () => {
    expect(MIGRATIONS.size).toBe(0);
    const from1 = migrateSaveFile({ version: 1, run: {} }, 2);
    expect(from1).toEqual({ ok: false, message: 'No migration from save version 1 to 2 is registered in this build.' });
    const calls: number[] = [];
    MIGRATIONS.set(1, (file) => {
      calls.push(1);
      return { ...file, version: 2, migratedField: true };
    });
    const migrated = migrateSaveFile({ version: 1, run: {} }, 2);
    expect(calls).toEqual([1]);
    expect(migrated).toEqual({ ok: true, file: { version: 2, run: {}, migratedField: true }, migratedFrom: 1 });
    MIGRATIONS.set(1, (file) => ({ ...file, version: 5 }));
    expect(migrateSaveFile({ version: 1 }, 2)).toEqual({ ok: false, message: 'Migration from version 1 did not produce version 2.' });
  });
});

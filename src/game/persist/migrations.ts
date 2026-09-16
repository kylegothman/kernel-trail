/**
 * KERNEL TRAIL - save file migrations. Architecture section 8.3.
 *
 * `SaveFile.version` is the format version of the save envelope, and
 * `buildSaveFile` keeps writing the literal `1`. Bumping the schema means a
 * migration registered here, keyed by the version a file carries, plus a
 * fixture in tests/game/save-migration.test.ts. The registry is empty today.
 */

export const SAVE_SCHEMA_VERSION = 1;

/** Transforms a file at version `from` into the shape of version `from + 1`. */
export type Migration = (file: Record<string, unknown>) => Record<string, unknown>;

/** Keyed by the version a file carries. Empty until the schema moves. */
export const MIGRATIONS = new Map<number, Migration>();

export type MigrationOutcome =
  | { readonly ok: true; readonly file: Record<string, unknown>; readonly migratedFrom: number | null }
  | { readonly ok: false; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walk a raw file up to `SAVE_SCHEMA_VERSION`. A version this build has no
 * path from produces a message rather than a throw, per architecture 10.4:
 * the save came from a newer build and the player is told so.
 */
export function migrateSaveFile(raw: unknown, target = SAVE_SCHEMA_VERSION): MigrationOutcome {
  if (!isRecord(raw)) return { ok: false, message: 'Save file is not an object.' };
  const start = raw['version'];
  if (typeof start !== 'number' || !Number.isInteger(start) || start < 1) {
    return { ok: false, message: `Save file carries an invalid version ${String(start)}.` };
  }
  if (start === target) return { ok: true, file: raw, migratedFrom: null };
  if (start > target) {
    return { ok: false, message: `Save file version ${start} is newer than this build's ${target}. Export it to keep it.` };
  }
  let file = raw;
  for (let v = start; v < target; v++) {
    const step = MIGRATIONS.get(v);
    if (step === undefined) return { ok: false, message: `No migration from save version ${v} to ${v + 1} is registered in this build.` };
    file = step(file);
    if (file['version'] !== v + 1) return { ok: false, message: `Migration from version ${v} did not produce version ${v + 1}.` };
  }
  return { ok: true, file, migratedFrom: start };
}

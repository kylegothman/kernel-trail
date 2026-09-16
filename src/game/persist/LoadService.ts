/**
 * KERNEL TRAIL - loading and resuming. Architecture sections 8.8 and 10.4.
 *
 * `LoadOutcome` has five variants and none of them loses the run silently: a
 * checksum mismatch is reported with the file so the player can be offered
 * it flagged, an unknown version or a read failure carries a message, and a
 * missing id is `not_found`. Repair by replay belongs to WP-18; `loadOutcome`
 * takes a repair hook so the `repaired` variant has a caller.
 *
 * The resume path differs by save kind. Boundary: a fresh kernel, `populate`,
 * continue. Provisional: the same, then `kernel.restore(file.kernel)` after
 * `populate`, because `populate` declares the resources and sync primitives
 * the snapshot references by id. Either way the world is rebuilt from
 * nothing; no view state is ever persisted.
 */

import type { Kernel, KernelSnapshot } from '@kernel/types';
import type { RunState, SaveFile } from '@game/types';
import { Database, loadGame } from '../save';
import { migrateSaveFile } from './migrations';

export type LoadOutcome =
  | { readonly kind: 'ok' | 'repaired' | 'checksum_failed'; readonly file: SaveFile }
  | { readonly kind: 'unreadable'; readonly message: string }
  | { readonly kind: 'not_found' };

export interface LoadOptions {
  /** WP-18's repair by replay. Returns a repaired file or null when it cannot. */
  readonly repair?: (file: SaveFile) => SaveFile | null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loadOutcome(db: Database, id: string, options: LoadOptions = {}): Promise<LoadOutcome> {
  let stored: { file?: unknown } | undefined;
  try {
    stored = await db.get<{ file?: unknown }>('saves', id);
  } catch (error) {
    return { kind: 'unreadable', message: `Could not read save ${id}: ${describe(error)}` };
  }
  if (stored === undefined) return { kind: 'not_found' };
  const migrated = migrateSaveFile(stored.file);
  if (!migrated.ok) return { kind: 'unreadable', message: migrated.message };
  if (migrated.migratedFrom !== null) {
    // A migrated file is a shape this build understands but its checksum was
    // written against the old shape; WP-18's repair path re-signs it.
    return { kind: 'unreadable', message: `Save version ${migrated.migratedFrom} needs re-signing after migration; not supported in this build.` };
  }
  const result = await loadGame(db, id);
  if (result.file === null) return { kind: 'unreadable', message: `Save ${id} could not be verified.` };
  switch (result.integrity) {
    case 'ok':
      return { kind: 'ok', file: result.file };
    case 'checksum_failed': {
      const repaired = options.repair?.(result.file) ?? null;
      return repaired === null ? { kind: 'checksum_failed', file: result.file } : { kind: 'repaired', file: repaired };
    }
    case 'repaired':
      return { kind: 'repaired', file: result.file };
    case 'unreadable':
      return { kind: 'unreadable', message: `Save ${id} could not be verified: its contents are not checksummable.` };
    default:
      return { kind: 'unreadable', message: `Save ${id} reported an unknown integrity.` };
  }
}

/** The kernel surface a resume needs; the instance is built by the host. */
export type ResumableKernel = Pick<Kernel, 'restore' | 'tick' | 'config'>;

export interface ResumeHost<K extends ResumableKernel> {
  /** `Leg.kernelConfig(run)` then `createKernel`, in the host's hands. */
  buildKernel(run: RunState): K;
  /** `Leg.populate` through the host's `LegSetupContext`. Runs before any restore. */
  populate(kernel: K, run: RunState): void;
}

export type ResumeOutcome<K> =
  | { readonly kind: 'ok'; readonly resumed: 'boundary' | 'provisional'; readonly run: RunState; readonly kernel: K }
  | { readonly kind: 'unreadable'; readonly message: string };

/** Deep copy of plain data; a `KernelSnapshot` keeps its Maps. */
function cloneRun(run: RunState): RunState {
  return structuredClone(run);
}

/**
 * Resume a loaded file. `populate` runs before `restore` for a provisional
 * save; `Kernel.restore` returns void and throws on a version mismatch or a
 * rejected snapshot, and that throw becomes `unreadable` (scope correction
 * S16).
 */
export function resumeRun<K extends ResumableKernel>(file: SaveFile, host: ResumeHost<K>): ResumeOutcome<K> {
  const run = cloneRun(file.run);
  let kernel: K;
  try {
    kernel = host.buildKernel(run);
    host.populate(kernel, run);
  } catch (error) {
    return { kind: 'unreadable', message: `Could not rebuild the leg: ${describe(error)}` };
  }
  if (file.kernel === null) return { kind: 'ok', resumed: 'boundary', run, kernel };
  const snapshot: KernelSnapshot = file.kernel;
  try {
    kernel.restore(snapshot);
  } catch (error) {
    return { kind: 'unreadable', message: `The provisional snapshot was rejected: ${describe(error)}` };
  }
  return { kind: 'ok', resumed: 'provisional', run, kernel };
}

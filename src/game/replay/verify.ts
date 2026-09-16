/**
 * KERNEL TRAIL - save verification and the replay record. Architecture 8.6,
 * "verifying a save" and "reproducing a bug"; WP-18 specification section
 * 9, scope correction U11, pre-flight rulings 9 and 11.
 *
 * `verifySave` recomputes the checksum, and only when the caller asks for
 * the deep check does it replay the whole run from the seed and compare the
 * event log hash per leg with `ReplayRecord.legEventHashes`. The deep check
 * takes a few hundred milliseconds in a worker and runs on demand from the
 * diagnostics panel and before any future score submission. It is never on
 * the load path: `loadOutcome` and `resumeRun` do not know this module.
 *
 * The record builders are pure. WP-19's `LegRunner` calls
 * `startReplayRecord` at run start, `recordLegEntry` with `saveRunStreams`
 * at each leg start and `recordLegHash` at each leg end.
 */

import type { RngState } from '@kernel/types';
import { LEG_ORDER, type DecisionRecord, type LegId, type RunState, type SaveFile } from '@game/types';
import { CHECKSUM_SALT, checksumOf, type ReplayRecord } from '@game/save';
import type { ReplayRequest, ReplayResponse } from './types';

export type ReplayDispatch = (request: ReplayRequest) => Promise<ReplayResponse>;

/** A whole run can be long; the deep check is a diagnostic, so the valve is generous. */
export const DEEP_CHECK_MAX_TICKS = 200_000;

export interface VerifyOptions {
  /** Replay the run and compare per-leg hashes. Off by default and never on the load path. */
  readonly deep?: boolean;
  readonly replay?: ReplayDispatch;
  readonly record?: ReplayRecord | null;
  readonly salt?: string;
  readonly maxTicks?: number;
}

export type VerifyOutcome =
  | { readonly ok: true; readonly deep: boolean; readonly legsChecked: number }
  | {
      readonly ok: false;
      readonly stage: 'checksum' | 'record' | 'build' | 'replay' | 'leg_hash';
      readonly message: string;
      readonly legIndex?: number;
      readonly expected?: string;
      readonly actual?: string;
    };

export async function verifySave(file: SaveFile, options: VerifyOptions = {}): Promise<VerifyOutcome> {
  const salt = options.salt ?? CHECKSUM_SALT;
  let expected: string;
  try {
    expected = checksumOf(file, salt);
  } catch (error) {
    return { ok: false, stage: 'checksum', message: `The save is not checksummable: ${describe(error)}` };
  }
  if (expected !== file.checksum) return { ok: false, stage: 'checksum', message: 'The checksum does not match the contents.', expected, actual: file.checksum };
  if (options.deep !== true) return { ok: true, deep: false, legsChecked: 0 };
  const record = options.record ?? null;
  if (record === null) return { ok: false, stage: 'record', message: `No replay record for run ${file.run.runId}.` };
  if (record.runId !== file.run.runId) return { ok: false, stage: 'record', message: `The replay record belongs to run ${record.runId}, not ${file.run.runId}.` };
  if (options.replay === undefined) return { ok: false, stage: 'replay', message: 'The deep check needs a replay dispatch.' };
  return compareRecord(record, options.replay, options.maxTicks);
}

/**
 * Replay the whole run from the seed and compare each leg's hash with the
 * record's. A mismatch is reported with the leg and both hashes; a replay
 * that fails or throws is reported too. Nothing here throws.
 */
export async function compareRecord(record: ReplayRecord, replay: ReplayDispatch, maxTicks = DEEP_CHECK_MAX_TICKS): Promise<VerifyOutcome> {
  const legs: readonly LegId[] = LEG_ORDER.slice(0, record.legEventHashes.length);
  if (legs.length === 0) return { ok: true, deep: true, legsChecked: 0 };
  const request: ReplayRequest = {
    seed: record.seed,
    discClass: record.discClass,
    difficulty: record.difficulty,
    legs,
    decisions: record.decisions,
    overrides: { suppressRecordedPolicyChanges: false },
    maxTicks,
  };
  let response: ReplayResponse;
  try {
    response = await replay(request);
  } catch (error) {
    return { ok: false, stage: 'replay', message: `The replay threw: ${describe(error)}` };
  }
  if (!response.ok) return { ok: false, stage: 'replay', message: `The replay did not finish: ${response.reason}: ${response.message}` };
  for (const [legIndex, expected] of record.legEventHashes.entries()) {
    const actual = response.diagnostics.legs[legIndex]?.eventLogHash ?? '';
    if (actual !== expected) {
      return { ok: false, stage: 'leg_hash', legIndex, expected, actual, message: `Leg ${legIndex} (${legs[legIndex] ?? '?'}) replayed to ${actual || 'nothing'} but the record holds ${expected}.` };
    }
  }
  return { ok: true, deep: true, legsChecked: legs.length };
}

/* ------------------------------------------------------------------ */
/* The record builders, all pure                                        */
/* ------------------------------------------------------------------ */

const cloneRng = (state: RngState): RngState => ({ algorithm: state.algorithm, words: [state.words[0], state.words[1], state.words[2], state.words[3]], label: state.label });

export function startReplayRecord(run: Readonly<RunState>, buildId: string): ReplayRecord {
  return {
    runId: run.runId,
    seed: run.seed,
    buildId,
    discClass: run.discClass,
    difficulty: run.difficulty,
    decisions: run.decisions.map((d) => ({ ...d })),
    legEntryRng: [],
    legEventHashes: [],
  };
}

/** The streams at a leg start, in `saveRunStreams` order, so a replay can begin mid-journey. */
export function recordLegEntry(record: ReplayRecord, rngStates: readonly RngState[]): ReplayRecord {
  return { ...record, legEntryRng: [...record.legEntryRng, rngStates.map(cloneRng)] };
}

/** The leg's hash and the decision log as it stands at leg end (ruling 11). */
export function recordLegHash(record: ReplayRecord, hash: string, decisions: readonly DecisionRecord[]): ReplayRecord {
  return { ...record, decisions: decisions.map((d) => ({ ...d })), legEventHashes: [...record.legEventHashes, hash] };
}

/* ------------------------------------------------------------------ */
/* Reproducing a bug, and re-signing                                    */
/* ------------------------------------------------------------------ */

/** The detail a diagnostics bundle carries: enough to reproduce the run exactly under the same build. */
export interface ReproductionBundle {
  readonly record: ReplayRecord;
  readonly buildId: string;
}

export function bundleFor(record: ReplayRecord, buildId: string = CHECKSUM_SALT): ReproductionBundle {
  return { record, buildId };
}

/** Re-run a bundle under this build: a different build is reported, not replayed, because its hashes are not comparable. */
export async function reproduce(bundle: ReproductionBundle, replay: ReplayDispatch, buildId: string = CHECKSUM_SALT): Promise<VerifyOutcome> {
  if (bundle.buildId !== buildId) return { ok: false, stage: 'build', message: `The bundle was recorded under build ${bundle.buildId}; this is ${buildId}.`, expected: bundle.buildId, actual: buildId };
  return compareRecord(bundle.record, replay);
}

/**
 * A migrated file's checksum was written against the old shape. Re-sign it
 * under this build's salt. `LoadService.loadOutcome` still answers
 * `unreadable` for a migrated file; wiring this in is the follow-up named in
 * the WP-18 report.
 */
export function resignSaveFile(file: SaveFile, salt: string = CHECKSUM_SALT): SaveFile {
  const body = { version: file.version, savedAtIso: file.savedAtIso, run: file.run, kernel: file.kernel, rngStates: file.rngStates };
  return { ...body, checksum: checksumOf(body, salt) };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

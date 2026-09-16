import 'fake-indexeddb/auto';
/**
 * Save verification, the replay record and its store, WP-18 acceptance 28
 * and the tests table: shallow verify, the deep check, the load path, the
 * diagnostics bundle, and a replay begun mid-journey from legEntryRng.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RngState, Tick } from '../../src/kernel/types';
import type { RunState, SaveFile } from '../../src/game/types';
import { CHECKSUM_SALT, DB_NAME, Database, buildSaveFile, readReplayRecord, saveGame, verify as checksumMatches, writeReplayRecord, type ReplayRecord } from '../../src/game/save';
import { loadOutcome, resumeRun } from '../../src/game/persist/LoadService';
import { createKernel } from '../../src/kernel/Kernel';
import { createHeadlessSetupContext } from '../../src/game/replay/headlessLegs';
import { initialRunState, runReplay } from '../../src/game/replay/runReplay';
import { createRunStreams, type ReplayHooks, type ReplayRequest } from '../../src/game/replay/types';
import { ReplayWorkerHandle } from '../../src/game/workers/ReplayWorkerHandle';
import { bundleFor, compareRecord, recordLegEntry, recordLegHash, reproduce, resignSaveFile, startReplayRecord, verifySave } from '../../src/game/replay/verify';
import { createSyntheticLeg, registerSynthetic } from './fixtures/syntheticLeg';

const SAVED_AT = '2026-09-16T09:00:00.000Z';
let db: Database;

async function resetDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = (): void => resolve();
    req.onerror = (): void => resolve();
  });
}

const undos: (() => void)[] = [];
beforeEach(async () => {
  await resetDatabase();
  db = new Database();
  await db.open();
});
afterEach(async () => {
  while (undos.length > 0) undos.pop()?.();
  vi.restoreAllMocks();
  db.close();
  await resetDatabase();
});

/**
 * A director half that draws from the events stream mid-leg and spawns from
 * the draw, so a leg's log depends on the stream state at its entry and the
 * legEntryRng case has something to prove.
 */
const DRAWING_HOOKS: ReplayHooks = {
  beforeStep: (at, kernel, streams) => {
    if (at === 50) {
      const burst = streams.events.int(2, 6);
      const service = streams.events.int(20, 60);
      kernel.spawn({ name: 'event', priority: 15, burst, service, arrival: at + 1, pages: 2 });
    }
  },
};

function twoLegs(): void {
  undos.push(registerSynthetic({ id: 'boot_sector', index: 0, processes: 2, service: [30, 60], hooks: DRAWING_HOOKS }));
  undos.push(registerSynthetic({ id: 'fork_fields', index: 1, processes: 2, service: [30, 60], hooks: DRAWING_HOOKS }));
}

const dispatch = (request: ReplayRequest) => Promise.resolve(runReplay(request));

/** Play the whole two-leg run through the loop, building the record the way the leg runner will. */
function playRun(seed: number): { record: ReplayRecord; entries: { run: RunState; rng: readonly RngState[] }[] } {
  const entries: { run: RunState; rng: readonly RngState[] }[] = [];
  const initial = initialRunState(seed, 'shell', 'operator');
  let record = startReplayRecord(initial, CHECKSUM_SALT);
  const response = runReplay(
    { seed, discClass: 'shell', difficulty: 'operator', legs: ['boot_sector', 'fork_fields'], decisions: [], overrides: { suppressRecordedPolicyChanges: false }, maxTicks: 20_000 },
    {
      onLegEntry: (_index, _legId, run, rng) => {
        entries.push({ run: structuredClone(run), rng });
        record = recordLegEntry(record, rng);
      },
    },
  );
  if (!response.ok) throw new Error(response.message);
  for (const leg of response.diagnostics.legs) record = recordLegHash(record, leg.eventLogHash, initial.decisions);
  return { record, entries };
}

function file(): SaveFile {
  return buildSaveFile({ run: initialRunState(5, 'shell', 'operator'), kernel: null, rngStates: [], savedAtIso: SAVED_AT });
}

describe('verifySave', () => {
  it('checksum only: a shallow verify passes on a good save and fails on a tampered one', async () => {
    const good = file();
    expect(await verifySave(good)).toEqual({ ok: true, deep: false, legsChecked: 0 });
    const tampered: SaveFile = { ...good, run: { ...good.run, resources: { ...good.run.resources, cycles: 9999 } } };
    const outcome = await verifySave(tampered);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.stage).toBe('checksum');
      expect(outcome.actual).toBe(good.checksum);
      expect(outcome.expected).not.toBe(good.checksum);
    }
    // A shallow verify never asks for a replay, even when one is offered.
    const replay = vi.fn(dispatch);
    expect((await verifySave(good, { replay })).ok).toBe(true);
    expect(replay).not.toHaveBeenCalled();
    // Re-signing under another salt verifies under that salt only.
    const resigned = resignSaveFile(good, 'build-b');
    expect(resigned.checksum).not.toBe(good.checksum);
    expect((await verifySave(resigned, { salt: 'build-b' })).ok).toBe(true);
    expect((await verifySave(resigned)).ok).toBe(false);
    expect(checksumMatches(resignSaveFile(resigned))).toBe(true);
  });

  it('deep check: per-leg hashes compared, a mismatch reported rather than thrown, and the record round-trips the store', async () => {
    twoLegs();
    const { record } = playRun(9);
    expect(record.legEventHashes).toHaveLength(2);
    expect(record.legEntryRng).toHaveLength(2);
    expect(record.legEntryRng[0]?.map((s) => s.label)).toEqual(['run', 'run/leg', 'run/events', 'run/crossing', 'run/reclamation']);
    await writeReplayRecord(db, record);
    const stored = await readReplayRecord(db, record.runId);
    expect(stored).toEqual(record);
    expect(await readReplayRecord(db, 'run-nobody')).toBeUndefined();
    const save = buildSaveFile({ run: initialRunState(9, 'shell', 'operator'), kernel: null, rngStates: [], savedAtIso: SAVED_AT });
    expect(await verifySave(save, { deep: true, record: stored ?? null, replay: dispatch })).toEqual({ ok: true, deep: true, legsChecked: 2 });
    // A tampered second-leg hash is reported with the leg and both hashes.
    const tampered: ReplayRecord = { ...record, legEventHashes: [record.legEventHashes[0] ?? '', 'f'.repeat(16)] };
    const mismatch = await verifySave(save, { deep: true, record: tampered, replay: dispatch });
    expect(mismatch).toEqual({ ok: false, stage: 'leg_hash', legIndex: 1, expected: 'f'.repeat(16), actual: record.legEventHashes[1], message: expect.stringMatching(/Leg 1 \(fork_fields\)/) });
    // A record for another run, a missing record, and a replay that cannot run are all reported.
    expect((await verifySave(save, { deep: true, record: { ...record, runId: 'run-other' }, replay: dispatch })).ok).toBe(false);
    expect(await verifySave(save, { deep: true, replay: dispatch })).toEqual({ ok: false, stage: 'record', message: expect.stringMatching(/No replay record/) });
    const third: ReplayRecord = { ...record, legEventHashes: [...record.legEventHashes, '0'.repeat(16)] };
    const failed = await verifySave(save, { deep: true, record: third, replay: dispatch });
    expect(failed).toEqual({ ok: false, stage: 'replay', message: expect.stringMatching(/phase 2/) });
    const threw = await compareRecord(record, () => Promise.reject(new Error('worker gone')));
    expect(threw).toEqual({ ok: false, stage: 'replay', message: 'The replay threw: worker gone' });
  });

  it('not on load path: loading and resuming a save performs no deep check and never touches the worker handle', async () => {
    const run = vi.spyOn(ReplayWorkerHandle.prototype, 'run');
    const replay = vi.fn(dispatch);
    const saved = file();
    const record = await saveGame(db, saved, { kind: 'boundary' });
    const loaded = await loadOutcome(db, record.id);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind !== 'ok') return;
    const leg = createSyntheticLeg();
    const resumed = resumeRun(loaded.file, {
      buildKernel: (r) => createKernel(leg.kernelConfig(r)),
      populate: (kernel, r) => leg.populate(createHeadlessSetupContext(kernel, r, createRunStreams(r.seed).leg.fork('boot_sector'), new Map())),
    });
    expect(resumed.kind).toBe('ok');
    expect(run).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
    // The load service does not even know the verify module.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const name of ['LoadService.ts', 'SaveService.ts']) expect(readFileSync(join(__dirname, '..', '..', 'src', 'game', 'persist', name), 'utf8')).not.toMatch(/replay\/verify|ReplayWorkerHandle|verifySave/);
  });

  it('bundle reproduces: a diagnostics bundle with the record and the build id reproduces the per-leg hashes', async () => {
    twoLegs();
    const { record } = playRun(13);
    const bundle = bundleFor(record);
    expect(bundle.buildId).toBe(CHECKSUM_SALT);
    expect(await reproduce(bundle, dispatch)).toEqual({ ok: true, deep: true, legsChecked: 2 });
    const replay = vi.fn(dispatch);
    await reproduce(bundle, replay);
    expect(replay).toHaveBeenCalledTimes(1);
    expect(replay.mock.calls[0]?.[0].legs).toEqual(['boot_sector', 'fork_fields']);
    // A bundle from another build is reported, not replayed: its hashes are not comparable.
    const other = await reproduce({ ...bundle, buildId: 'build-z' }, replay);
    expect(other).toEqual({ ok: false, stage: 'build', message: expect.stringMatching(/build-z/), expected: 'build-z', actual: CHECKSUM_SALT });
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it('legEntryRng: a replay begun mid-journey from the recorded streams hashes like the one begun from the start', async () => {
    twoLegs();
    const { record, entries } = playRun(21);
    const second = entries[1];
    if (second === undefined) throw new Error('no second entry');
    expect(second.rng).toEqual(record.legEntryRng[1]);
    expect(second.run.legIndex).toBe(1);
    const request: ReplayRequest = { seed: 21, discClass: 'shell', difficulty: 'operator', legs: ['fork_fields'], decisions: [], overrides: { suppressRecordedPolicyChanges: false }, maxTicks: 20_000 };
    const midJourney = runReplay(request, { entry: { run: second.run, rng: record.legEntryRng[1] ?? [] } });
    if (!midJourney.ok) throw new Error(midJourney.message);
    expect(midJourney.diagnostics.legs[0]?.eventLogHash).toBe(record.legEventHashes[1]);
    expect(midJourney.eventLogHash).toBe(record.legEventHashes[1]);
    // Without the entry the events stream is fresh, the mid-leg draw differs, and so does the hash.
    const fromScratch = runReplay(request);
    if (!fromScratch.ok) throw new Error(fromScratch.message);
    expect(fromScratch.eventLogHash).not.toBe(record.legEventHashes[1]);
    // The first leg needs no entry, and its hash is the record's first.
    const first = runReplay({ ...request, legs: ['boot_sector'] });
    if (!first.ok) throw new Error(first.message);
    expect(first.eventLogHash).toBe(record.legEventHashes[0]);
    // A boundary save is the mid-journey entry in practice: run plus rngStates.
    const boundary = buildSaveFile({ run: second.run, kernel: null, rngStates: record.legEntryRng[1] ?? [], savedAtIso: SAVED_AT });
    const fromSave = runReplay(request, { entry: { run: boundary.run, rng: boundary.rngStates } });
    expect(fromSave.ok && fromSave.eventLogHash).toBe(record.legEventHashes[1]);
    expect((1 as Tick) > 0).toBe(true);
  });
});

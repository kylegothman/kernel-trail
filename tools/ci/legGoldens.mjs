#!/usr/bin/env node
/**
 * WP-20 section 9: the CI entry point, `node tools/ci/legGoldens.mjs`.
 *
 * 1. Enumerates LEG_ORDER and prints which legs have shipped and which
 *    fixtures and goldens exist, as a table, before running anything.
 * 2. Runs every shipped leg's known-good and known-bad golden playthrough.
 * 3. Runs the journey over the shipped prefix, twice, once with boundary
 *    restores, and replays it from the decision log.
 * 4. Prints one summary line per leg and path: id, path, ticks, survivors,
 *    objectives met, hash, pass or fail.
 * 5. On any failure prints the divergence window for that leg and exits 1.
 * 6. On success prints the journey hash and exits 0.
 *
 * It writes no golden file, ever. Recording is a human action. The harness
 * is TypeScript with the repository's path aliases, so the tsx loader is
 * registered here (scope correction W4) and the harness is imported through
 * it; nothing else runs in a second process.
 */
import { register } from 'tsx/esm/api';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const unregister = register({ tsconfig: resolve(ROOT, 'tsconfig.json') });

const { LEG_ORDER } = await import('../../src/game/types.ts');
const { tryLoadLegForTest } = await import('../../tests/legs/harness/loadLeg.ts');
const { checkFixtureRun, isWarning, loadFixtures, runFixture, validateFixture } = await import('../../tests/legs/harness/fixtureContract.ts');
const { compareTiers, readGolden, tiersOf } = await import('../../tests/legs/harness/goldenLog.ts');
const { fixtureStatus } = await import('../../tests/legs/harness/stubFixtures.ts');
const { replayJourney, runJourney } = await import('../../tests/legs/harness/journey.ts');
const { explainGolden } = await import('../golden/explain.ts');

const log = (line) => console.log(line);
const pad = (text, width) => String(text).padEnd(width);

async function main() {
  const shipped = [];
  const fixtures = new Map();
  log('legGoldens: leg               shipped fixture  good-golden bad-golden');
  for (const id of LEG_ORDER) {
    const loaded = await tryLoadLegForTest(id);
    const present = readGolden(id, 'good') !== null;
    const bad = readGolden(id, 'bad') !== null;
    log(`legGoldens: ${pad(id, 17)} ${pad(loaded.shipped ? 'yes' : 'no', 7)} ${pad(fixtureStatus(id), 8)} ${pad(present ? 'present' : 'missing', 11)} ${bad ? 'present' : 'missing'}`);
    if (loaded.shipped) {
      shipped.push(loaded.leg);
      fixtures.set(id, await loadFixtures(id));
    }
  }
  log(`legGoldens: ${shipped.length} of ${LEG_ORDER.length} legs shipped`);

  let failed = 0;
  const explain = async (legId, path) => {
    const outcome = await explainGolden({ legId, path });
    if (outcome.status === 'mismatch' || outcome.status === 'nondeterministic') log(outcome.report);
    else log(`legGoldens: ${legId} ${path}: explain reports ${outcome.status}${'reason' in outcome ? `: ${outcome.reason}` : ''}`);
  };
  const scripts = new Map();
  for (const leg of shipped) {
    const module = fixtures.get(leg.id) ?? null;
    if (module === null) {
      log(`legGoldens: ${leg.id}: FAIL, shipped without tests/legs/${leg.id}/fixtures.ts`);
      failed += 1;
      continue;
    }
    scripts.set(leg.id, module.knownGood.script);
    for (const path of ['good', 'bad']) {
      const fixture = path === 'good' ? module.knownGood : module.knownBad;
      const problems = validateFixture(fixture, leg).filter((problem) => !isWarning(problem));
      const expected = readGolden(leg.id, path);
      if (expected === null) problems.push('no golden checked in; record it with npm run golden:record');
      let line = `legGoldens: ${pad(leg.id, 17)} ${pad(path, 5)}`;
      if (problems.length === 0) {
        const result = await runFixture(fixture, leg);
        problems.push(...compareTiers(tiersOf(result), expected));
        problems.push(...checkFixtureRun(fixture, result, leg));
        const survivors = result.run.convoy.filter((member) => member.status !== 'derezzed').length;
        line += ` ticks=${pad(result.ticks, 6)} survivors=${survivors} objectives=${pad(result.outcome.objectivesMet.length, 2)} hash=${result.logHash}`;
      }
      if (problems.length === 0) log(`${line} pass`);
      else {
        failed += 1;
        log(`${line} FAIL`);
        for (const problem of problems) log(`legGoldens:   ${problem}`);
        if (expected !== null) await explain(leg.id, path);
      }
    }
  }

  if (shipped.length > 0 && failed === 0) {
    const prefix = [];
    for (const leg of shipped) {
      if (leg.index !== prefix.length) break;
      prefix.push(leg);
    }
    if (prefix.length === 0) {
      log('legGoldens: no shipped prefix from boot_sector; the journey runs once a contiguous prefix has shipped');
      return failed === 0 ? 0 : 1;
    }
    const base = { seed: 0x4b54524c, discClass: 'shell', difficulty: 'operator', scripts, legs: prefix };
    const first = await runJourney(base);
    try {
      const second = await runJourney(base);
      const restored = await runJourney({ ...base, restoreAtBoundaries: true });
      const replay = replayJourney(first, base);
      const problems = [];
      if (second.journeyHash !== first.journeyHash) problems.push(`two journeys from the same seed hashed ${first.journeyHash} and ${second.journeyHash}`);
      if (restored.journeyHash !== first.journeyHash) problems.push(`the journey with boundary restores hashed ${restored.journeyHash}, straight through ${first.journeyHash}`);
      if (!replay.ok) problems.push(...replay.problems);
      for (const observation of first.handoffs) log(`legGoldens: hand-off ${observation.handoff} ${observation.producer} -> ${observation.consumer}: ${observation.status} (${observation.reason})`);
      if (problems.length === 0) {
        log(`legGoldens: journey over ${prefix.map((leg) => leg.id).join(', ')}: hash ${first.journeyHash}, survivors ${first.survivors}, ${first.wallMs.toFixed(0)} ms${prefix.length === LEG_ORDER.length ? '' : ' (shipped prefix; journey.hash is recorded only when all fourteen legs are present)'}`);
      } else {
        failed += 1;
        log('legGoldens: journey FAIL');
        for (const problem of problems) log(`legGoldens:   ${problem}`);
      }
      second.release();
      restored.release();
    } finally {
      first.release();
    }
  } else if (shipped.length === 0) {
    log('legGoldens: no shipped leg; no golden playthrough and no journey to run');
  }
  return failed === 0 ? 0 : 1;
}

try {
  process.exitCode = await main();
} finally {
  await unregister();
}

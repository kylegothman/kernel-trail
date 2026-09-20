/**
 * WP-23 section 1: the browser playthrough. Runs under the Playwright and the
 * Vite server `tests/render/gpu/run.mjs` starts, after the real-app cases,
 * one context per backend the runner has. It drives the title screen and the
 * cards, never a seam other than the DEV-only `__kernelTrailDebug`, and
 * proves that the browser's frame loop drives the kernel exactly as the
 * headless harness's pump does: the per-leg event-log hashes are equal.
 *
 * Two runs per backend. The reload run (pre-flight ruling 3) starts the Boot
 * Sector, reloads the page at tick twenty or later, continues from the title
 * screen's Continue button and plays the leg out. Its losslessness proof is
 * three hashes: the leg's own hash equals an uninterrupted run's, the hash
 * read at pagehide equals a prefix of the uninterrupted log, the hash of the
 * events routed after the resume equals a suffix, and the prefix and suffix
 * meet at one index. The journey run then plays the four shipped legs
 * passively through the skip route, uninterrupted, and asserts each hash
 * against the harness's and Quantum Pass's against its checked-in golden.
 *
 * The harness side runs in this process before the browser launches, through
 * the tsx loader as tools/ci/legGoldens.mjs does. Every assertion prints the
 * value it saw beside the value it expected.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';
import { capturePageDiagnostics, formatPageDiagnostics } from '../render/gpu/harness.ts';
import { installGpuValidation } from '../render/gpu/validation.ts';
import { waitForLegRail } from '../render/gpu/realApp.mjs';
import { armPreReloadCapture, readPreReloadCapture, readSeam, waitForSeam, waitForTick } from './seams.ts';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
/** The shared fixture seed, `FIXTURE_SEED` in tests/legs/harness/fixtureContract.ts. */
export const SEED = 0x4b54524c;
export const LEGS = ['boot_sector', 'quantum_pass', 'the_narrows', 'allocation_yards'];
/**
 * The unshipped legs the skip route crosses before each shipped leg, in
 * LEG_ORDER: the Narrows (index 4) follows Quantum Pass (3) directly, and the
 * Cistern (5) and the Gridlock (6) sit between the Narrows and the Yards (7).
 * The document places the two skips before the Narrows; the order is a gap.
 */
const SKIPPED = { quantum_pass: ['fork_fields', 'the_weave'], the_narrows: [], allocation_yards: ['the_cistern', 'the_gridlock'] };
const RELOAD_AT_TICK = 20;
/** The whole playthrough per backend; twelve minutes is the document's hard timeout for CI. */
const HARD_TIMEOUT_MS = 12 * 60_000;

/**
 * Run the four shipped legs passively in one harness session from the game's
 * own initial run state, in journey order, exactly as the browser's skip
 * route does (a skip card touches no run state and `prepareLegEntry` sets the
 * leg index from the leg). Returns per-leg hashes, tick counts, entering
 * ledgers and the Boot Sector's event list for the reload proof.
 */
export async function prepareExpectations() {
  const unregister = register({ tsconfig: resolve(ROOT, 'tsconfig.json') });
  try {
    const { initialRunState } = await import('../../src/game/replay/runReplay.ts');
    const { throughputTargetFor } = await import('../../src/app/throughput.ts');
    const { hashEventLog } = await import('../../src/game/replay/hash.ts');
    const { HarnessSession, runLegInSession } = await import('../legs/harness/LegHarness.ts');
    const { tryLoadLegForTest } = await import('../legs/harness/loadLeg.ts');
    const { readGolden } = await import('../legs/harness/goldenLog.ts');
    const loaded = [];
    for (const id of LEGS) {
      const result = await tryLoadLegForTest(id);
      assert(result.shipped, `${id} has not shipped: ${result.reason}`);
      loaded.push(result);
    }
    const targets = loaded.map(entry => throughputTargetFor(entry.content));
    const target = targets[0];
    assert(targets.every(value => value === target), `the four legs declare different throughput targets ${JSON.stringify(targets)}; the shared harness session takes one`);
    let session = new HarnessSession(SEED, initialRunState(SEED, 'shell', 'operator'), target);
    const legs = {};
    for (const entry of loaded) {
      const outcome = runLegInSession(session, entry.leg, { seed: SEED, policy: 'passive' });
      session = outcome.session;
      const result = outcome.result;
      assert.equal(result.panics.length, 0, `${entry.leg.id}: the harness run panicked: ${result.panics.join('; ')}`);
      legs[entry.leg.id] = {
        title: entry.leg.title, hash: result.logHash, ticks: result.ticks, events: result.events.length,
        headline: result.outcome.debrief.headline, casualties: [...result.outcome.casualties],
        enteringLedger: { ...result.ledgerBefore }, closingLedger: { ...result.ledgerAfter },
      };
      if (entry.leg.id === 'boot_sector') {
        const events = result.events;
        legs.boot_sector.prefixHashes = events.map((_, i) => hashEventLog(events.slice(0, i + 1)));
        legs.boot_sector.suffixHashes = events.map((_, i) => hashEventLog(events.slice(i)));
        legs.boot_sector.eventTicks = events.map(event => event.tick);
      }
    }
    const golden = readGolden('quantum_pass', 'bad');
    assert(golden !== null, 'tests/golden/legs/quantum_pass.bad.fingerprint.txt is missing');
    for (const id of LEGS) console.log(`playthrough harness ${id}: hash=${legs[id].hash} ticks=${legs[id].ticks} events=${legs[id].events} headline=${JSON.stringify(legs[id].headline)} entering=${JSON.stringify(legs[id].enteringLedger)}`);
    return { seed: SEED, legs, quantumPassBadGolden: golden.fingerprint.hash };
  } finally {
    await unregister();
  }
}

/** Console errors, less the one rejection the absent-leg plugin throws by design (pre-flight ruling 10). */
export function consoleErrors(diagnostics) {
  return diagnostics.messages.filter(message => message.startsWith('[console.error]') && !message.includes('is not in this build'));
}

/** On a failure: every card on the overlay, the seam's view of the run, and a screenshot beside the results file. */
async function describeFailure(page, path) {
  const state = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.kt-card')].map(card => `${card.className}: ${card.textContent?.trim().slice(0, 160)}`);
    const seam = globalThis.__kernelTrailDebug;
    const rail = document.querySelector('.kt-tl')?.textContent ?? null;
    return { cards, rail, legId: seam?.legId() ?? null, tick: seam?.tick() ?? null, phase: seam?.phase() ?? null, legHashes: seam?.legHashes() ?? null };
  }).catch(error => ({ unavailable: String(error) }));
  console.error(`${path} page state:`, JSON.stringify(state));
  await page.screenshot({ path: join(os.tmpdir(), `${path}.png`) }).catch(() => undefined);
}

const same = (label, actual, expected) => {
  console.log(`playthrough ${label}: saw ${actual}, expected ${expected}${actual === expected ? '' : ' (MISMATCH)'}`);
  assert.equal(actual, expected, label);
};

async function openTitle(page, baseUrl, timeout) {
  await page.goto(`${baseUrl}/?seed=${SEED}`, { waitUntil: 'domcontentloaded', timeout });
  await page.getByRole('button', { name: 'New run', exact: true }).waitFor({ timeout });
}

async function startNewRun(page, timeout) {
  await page.locator('select[name="disc-class"]').selectOption('shell');
  await page.locator('select[name="difficulty"]').selectOption('operator');
  await page.locator('select[name="quality"]').selectOption('low');
  await page.getByRole('button', { name: 'New run', exact: true }).click();
  await waitForLegRail(page, 'The Boot Sector', timeout);
  await waitForSeam(page, timeout);
}

const debrief = page => page.locator('.kt-card--debrief');

async function waitForDebrief(page, legId, timeout) {
  await debrief(page).waitFor({ timeout });
  const snapshot = await readSeam(page);
  console.log(`playthrough ${legId} debrief: tick=${snapshot.tick} phase=${snapshot.phase} legHashes=${JSON.stringify(snapshot.legHashes)}`);
  return snapshot;
}

async function skipTo(page, legId, expected, timeout) {
  await debrief(page).getByRole('button', { name: 'Continue', exact: true }).click();
  for (const skipped of SKIPPED[legId]) {
    // The previous card is disposed on the next committed frame, so wait for the card that names this leg.
    const card = page.locator('.kt-card--unavailable', { hasText: skipped });
    await card.waitFor({ timeout });
    const text = await card.locator('.kt-leg').textContent();
    console.log(`playthrough skip card: ${JSON.stringify(text)}`);
    assert(text?.includes(skipped), `the unavailable card names ${skipped}: ${text}`);
    await card.getByRole('button', { name: 'Skip', exact: true }).click();
  }
  await waitForLegRail(page, expected.title, timeout);
  await page.waitForFunction(() => globalThis.__kernelTrailDebug?.phase() === 'travelling', undefined, { timeout, polling: 50 });
  const snapshot = await readSeam(page);
  same(`${legId} legId after the skip route`, snapshot.legId, legId);
  same(`${legId} phase after the skip route`, snapshot.phase, 'travelling');
}

/** Both runs on one backend; throws on the first failed assertion with the values printed. */
export async function playReload(context, baseUrl, backend, expectations, timeout) {
  const boot = expectations.legs.boot_sector;
  // Run 1: reload and resume inside the Boot Sector.
  {
    const path = `wp23-playthrough-${backend}-reload`;
    const page = await context.newPage();
    const diagnostics = capturePageDiagnostics(page);
    try {
      console.log(`Starting ${path}`);
      await openTitle(page, baseUrl, timeout);
      await startNewRun(page, timeout);
      await waitForTick(page, RELOAD_AT_TICK, timeout);
      const observed = await readSeam(page);
      console.log(`playthrough reload: observed tick ${observed.tick} before the reload`);
      assert(observed.tick >= RELOAD_AT_TICK, `tick before reload ${observed.tick} is at least ${RELOAD_AT_TICK}`);
      await armPreReloadCapture(page);
      await page.reload({ waitUntil: 'domcontentloaded', timeout });
      const captured = await readPreReloadCapture(page);
      assert(captured !== null, 'the pagehide capture recorded the pre-reload tick and hash');
      console.log(`playthrough reload: saved at tick ${captured.tick}, pre-reload logHash ${captured.logHash}`);
      const continueButton = page.getByRole('button', { name: 'Continue', exact: true });
      await continueButton.waitFor({ state: 'visible', timeout });
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll('.kt-title-screen button')].find(candidate => candidate.textContent === 'Continue');
        return button !== undefined && !button.hidden && !button.disabled;
      }, undefined, { timeout, polling: 50 });
      console.log('playthrough reload: the title screen offers Continue; the provisional save landed on pagehide');
      await continueButton.click();
      await waitForLegRail(page, 'The Boot Sector', timeout);
      await waitForSeam(page, timeout);
      const resumed = await readSeam(page);
      console.log(`playthrough reload: tick after resume ${resumed.tick}, tick before reload ${observed.tick}, saved tick ${captured.tick}`);
      same('legId after resume', resumed.legId, 'boot_sector');
      assert(resumed.tick >= observed.tick, `tick after resume ${resumed.tick} is at least the tick observed before the reload ${observed.tick}`);
      assert(resumed.tick >= captured.tick, `tick after resume ${resumed.tick} is at least the saved tick ${captured.tick}`);
      const end = await waitForDebrief(page, 'boot_sector', timeout);
      same('resumed Boot Sector legHashes length', end.legHashes.length, 1);
      same('resumed Boot Sector hash versus the uninterrupted harness run', end.legHashes[0].hash, boot.hash);
      same('resumed Boot Sector ticks', end.legHashes[0].ticks, boot.ticks);
      const prefixEnd = boot.prefixHashes.indexOf(captured.logHash) + 1;
      const suffixStart = boot.suffixHashes.indexOf(end.logHash);
      console.log(`playthrough reload: pre-reload hash is the prefix of ${prefixEnd} events (of ${boot.events}), post-resume hash is the suffix from event ${suffixStart}; saved tick ${captured.tick}, event ticks around the seam ${JSON.stringify(boot.eventTicks.slice(Math.max(0, prefixEnd - 2), prefixEnd + 2))}`);
      assert(prefixEnd > 0, `the pre-reload hash ${captured.logHash} is a prefix of the uninterrupted log`);
      assert(suffixStart >= 0, `the post-resume hash ${end.logHash} is a suffix of the uninterrupted log`);
      same('the prefix and the suffix meet at one index', suffixStart, prefixEnd);
      assert(prefixEnd < boot.events, 'the reload happened before the leg ended');
      const validation = await page.evaluate(() => globalThis.__kernelTrailGpuValidation.snapshot());
      assert.deepEqual(validation, [], `${path}: native GPU validation`);
      assert.equal(diagnostics.pageErrors.length, 0, `${path}: page errors`);
      assert.deepEqual(consoleErrors(diagnostics), [], `${path}: console errors`);
      return { first: { path, backend, observedTick: observed.tick, savedTick: captured.tick, resumedTick: resumed.tick, prefixEnd, suffixStart, events: boot.events, hash: end.legHashes[0].hash, expected: boot.hash } };
    } catch (error) {
      await describeFailure(page, path);
      console.error(formatPageDiagnostics(diagnostics));
      throw new Error(`${path}: ${error.stack || String(error)}`);
    } finally { await page.close(); }
  }
}

export async function playJourney(context, baseUrl, backend, expectations, timeout) {
  const path = `wp23-playthrough-${backend}-journey`;
  const page = await context.newPage();
  const diagnostics = capturePageDiagnostics(page);
  try {
    console.log(`Starting ${path}`);
    await openTitle(page, baseUrl, timeout);
    await startNewRun(page, timeout);
    const seen = [];
    // 2. The Boot Sector, uninterrupted: the equivalence assertion.
    const boot = await waitForDebrief(page, 'boot_sector', timeout);
    same('Boot Sector legHashes length', boot.legHashes.length, 1);
    same('Boot Sector hash versus harness', boot.legHashes[0].hash, expectations.legs.boot_sector.hash);
    same('Boot Sector logHash versus legHashes[0]', boot.logHash, boot.legHashes[0].hash);
    same('Boot Sector ticks', boot.legHashes[0].ticks, expectations.legs.boot_sector.ticks);
    seen.push(boot.legHashes[0]);
    // 3 and 4. Skip the Fork Fields and the Weave, then the Quantum Pass to its debrief.
    await skipTo(page, 'quantum_pass', expectations.legs.quantum_pass, timeout);
    const pass = await waitForDebrief(page, 'quantum_pass', timeout);
    const headline = await debrief(page).locator('.kt-headline').textContent();
    console.log(`playthrough Quantum Pass headline: ${JSON.stringify(headline)}`);
    assert.match(headline ?? '', /SABLE never ran\./, 'the Quantum Pass passive headline');
    const sable = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.kt-pip')].find(pip => pip.querySelector('.kt-value')?.textContent === 'SABLE');
      return row?.querySelector('.kt-label')?.textContent ?? null;
    });
    console.log(`playthrough SABLE pip: ${JSON.stringify(sable)}`);
    assert.match(sable ?? '', /derezzed/i, "SABLE's convoy pip reads derezzed");
    same('Quantum Pass legHashes length', pass.legHashes.length, 2);
    same('Quantum Pass hash versus harness', pass.legHashes[1].hash, expectations.legs.quantum_pass.hash);
    same('Quantum Pass hash versus the checked-in bad golden', pass.legHashes[1].hash, expectations.quantumPassBadGolden);
    seen.push(pass.legHashes[1]);
    // 5. The Narrows, uninterrupted (pre-flight ruling 3); it follows Quantum Pass directly in LEG_ORDER.
    await skipTo(page, 'the_narrows', expectations.legs.the_narrows, timeout);
    const narrows = await waitForDebrief(page, 'the_narrows', timeout);
    same('Narrows legHashes length', narrows.legHashes.length, 3);
    same('Narrows hash versus harness', narrows.legHashes[2].hash, expectations.legs.the_narrows.hash);
    seen.push(narrows.legHashes[2]);
    // 6. Skip the Cistern and the Gridlock, then the Allocation Yards to its debrief.
    await skipTo(page, 'allocation_yards', expectations.legs.allocation_yards, timeout);
    const yards = await waitForDebrief(page, 'allocation_yards', timeout);
    same('Yards legHashes length', yards.legHashes.length, 4);
    same('Yards hash versus harness', yards.legHashes[3].hash, expectations.legs.allocation_yards.hash);
    seen.push(yards.legHashes[3]);
    for (const [i, id] of LEGS.entries()) same(`legHashes[${i}].legId`, yards.legHashes[i].legId, id);
    const validation = await page.evaluate(() => globalThis.__kernelTrailGpuValidation.snapshot());
    assert.deepEqual(validation, [], `${path}: native GPU validation`);
    assert.equal(diagnostics.pageErrors.length, 0, `${path}: page errors`);
    assert.deepEqual(consoleErrors(diagnostics), [], `${path}: console errors`);
    return { path, backend, legs: seen.map((entry, i) => ({ ...entry, expected: expectations.legs[LEGS[i]].hash })) };
  } catch (error) {
    await describeFailure(page, path);
    console.error(formatPageDiagnostics(diagnostics));
    throw new Error(`${path}: ${error.stack || String(error)}`);
  } finally { await page.close(); }
}

/** One context per backend, viewport 1440 by 900 at device scale 2, the GPU validation probe installed. */
export async function runPlaythrough(browser, baseUrl, webgpuAvailable, expectations, options = {}) {
  const scale = options.scale ?? 1;
  const timeout = 90_000 * scale;
  const results = [], failures = [];
  for (const backend of webgpuAvailable ? ['webgpu', 'webgl2'] : ['webgl2']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    if (backend === 'webgl2') await context.addInitScript(() => {
      Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
    });
    await context.addInitScript(installGpuValidation);
    const started = performance.now();
    let hardTimer;
    try {
      const outcome = await Promise.race([
        (async () => {
          const reload = await playReload(context, baseUrl, backend, expectations, timeout);
          const journey = await playJourney(context, baseUrl, backend, expectations, timeout);
          return { backend, reload: reload.first, journey };
        })(),
        new Promise((_, reject) => { hardTimer = setTimeout(() => reject(new Error(`the ${backend} playthrough exceeded the hard timeout of ${HARD_TIMEOUT_MS / 60_000} minutes`)), HARD_TIMEOUT_MS); }),
      ]);
      const wallMs = Math.round(performance.now() - started);
      console.log(`wp23-playthrough-${backend}: passed in ${wallMs} ms`, JSON.stringify(outcome));
      results.push({ path: `wp23-playthrough-${backend}`, wallMs, ...outcome });
    } catch (error) {
      console.error(`Playthrough failed on ${backend}:`, error.stack || String(error));
      failures.push(`wp23-playthrough-${backend}: ${error.stack || String(error)}`);
    } finally {
      clearTimeout(hardTimer);
      await context.close();
    }
  }
  return { results, failures };
}

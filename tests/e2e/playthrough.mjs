/**
 * WP-23 section 1: the browser playthrough. Runs under the Playwright and the
 * Vite server `tests/render/gpu/run.mjs` starts, after the real-app cases,
 * one context per backend the runner has. It drives the title screen and the
 * cards, never a seam other than the DEV-only `__kernelTrailDebug`, and
 * proves that the browser's frame loop drives the kernel exactly as the
 * headless harness's pump does: the per-leg event-log hashes are equal.
 *
 * Three runs per backend (WP-24 section 6). The tutorial run comes first on
 * a fresh profile: the eight beats driven through the real UI, each exit
 * asserted in order, the decisions the harness's known-good script records,
 * the pacing rule with a question open, and the profile flag. The reload and
 * journey runs then take Skip tutorial, which a completed profile is offered
 * once, so a skipped tutorial is the passive leg (pre-flight ruling 9.1).
 * The player's clock is two ticks a second; both runs step to four with the
 * bracket key, real input, so a passive Boot Sector is fifty seconds.
 *
 * The reload run (WP-23 pre-flight ruling 3) starts the Boot
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
/** The whole playthrough per backend; twelve minutes is the document's hard timeout for CI. WP-24 adds the tutorial run and a slower clock; the budget is held by stepping to four ticks a second. */
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
    const { DB_NAME } = await import('../../src/game/save.ts');
    const { BOOT_SECTOR_COMPLETED_KEY } = await import('../../src/game/persist/SaveService.ts');
    const { ONBOARDING } = await import('../../src/legs/boot_sector/onboarding.ts');
    const { KNOWN_GOOD_SCRIPT } = await import('../legs/boot_sector/scripts.ts');
    const { describeChoice } = await import('../../src/game/CommandBus.ts');
    // What the harness records for a terminal step of `syscall getpid`: one terminal decision with the line, and nothing else, because the harness never runs the shell.
    const harnessTerminalStep = { kind: 'terminal', choice: describeChoice({ kind: 'terminal', line: 'syscall getpid' }) };
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
    // The known-good script's own records for the four things the tutorial run must leave in run.decisions, in the script's order.
    const scripted = KNOWN_GOOD_SCRIPT.steps.filter(step => step.command.kind === 'terminal' && step.command.line === 'man EPERM'
      || step.command.kind === 'interaction' && ['boot.direct_reach', 'boot.trap_purchase', 'boot.choose_disc'].includes(step.command.id))
      .map(step => ({ kind: step.command.kind, choice: describeChoice(step.command) }));
    return { seed: SEED, legs, quantumPassBadGolden: golden.fingerprint.hash, dbName: DB_NAME, flagKey: BOOT_SECTOR_COMPLETED_KEY,
      beats: ONBOARDING.map(beat => beat.id), hints: Object.fromEntries(ONBOARDING.map(beat => [beat.id, beat.hint])), scripted, harnessTerminalStep };
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

/** Start a new run; with `skip`, take the Skip tutorial card a completed profile is offered. Then step the clock to four ticks a second. */
async function startNewRun(page, timeout, { skip = false } = {}) {
  await page.locator('select[name="disc-class"]').selectOption('shell');
  await page.locator('select[name="difficulty"]').selectOption('operator');
  await page.locator('select[name="quality"]').selectOption('low');
  await page.getByRole('button', { name: 'New run', exact: true }).click();
  if (skip) {
    const card = page.locator('.kt-card--tutorial');
    await card.waitFor({ timeout });
    console.log(`playthrough skip: ${JSON.stringify(await card.textContent())}`);
    await card.getByRole('button', { name: 'Skip tutorial', exact: true }).click();
  }
  await waitForLegRail(page, 'The Boot Sector', timeout);
  await waitForSeam(page, timeout);
  await page.keyboard.press(']'); await page.keyboard.press(']');
  const pace = await page.locator('.kt-pace').textContent();
  console.log(`playthrough pace after two bracket presses: ${JSON.stringify(pace)}`);
}

const readBeat = page => page.evaluate(() => globalThis.__kernelTrailDebug?.beat() ?? null);

/** Resolves when the driver reports `beat`, or null once the tutorial is done. */
async function waitForBeat(page, beat, timeout) {
  await page.waitForFunction(expected => (globalThis.__kernelTrailDebug?.beat() ?? null) === expected, beat, { timeout, polling: 50 });
}

const decisionsOf = page => page.evaluate(() => globalThis.__kernelTrailDebug.run().decisions.map(record => ({ kind: record.kind, choice: record.choice, outcome: record.outcome })));

async function terminalSubmit(page, line) {
  const input = page.locator('input[aria-label="terminal input"]');
  await input.fill(line);
  await input.press('Enter');
}

/** The tutorial on a fresh profile: the eight beats through the real UI, each exit in order. Returns the wall time each beat took. */
export async function playTutorial(context, baseUrl, backend, expectations, timeout) {
  const path = `wp24-tutorial-${backend}`;
  const page = await context.newPage();
  const diagnostics = capturePageDiagnostics(page);
  const timings = [];
  let previous = performance.now();
  /** The ruling before the replay: every beat has a non-empty hint in the data and a card in the DOM saying it while the beat is active. */
  const cardSays = async (beat) => {
    const hint = expectations.hints[beat];
    assert(typeof hint === 'string' && hint.trim() !== '', `${beat} has a non-empty hint in the data file`);
    const card = page.locator(`.kt-card--beat[data-beat="${beat}"] .kt-beat-hint`);
    await card.waitFor({ timeout });
    same(`the ${beat} card`, await card.textContent(), hint);
  };
  const arrived = async (beat) => {
    await waitForBeat(page, beat, timeout);
    await cardSays(beat);
    const now = performance.now();
    timings.push({ beat, wallMs: Math.round(now - previous) });
    previous = now;
    console.log(`playthrough tutorial: ${beat} reached (${timings.at(-1).wallMs} ms since the previous beat)`);
  };
  try {
    console.log(`Starting ${path}`);
    await openTitle(page, baseUrl, timeout);
    await startNewRun(page, timeout);
    // 1. Nothing exists: the clock is held for the beat's duration; no tick passes. The anchors panel lists the leg's seven verbs
    // from entry, as WP-22 listed them, and enables none of them before the reach, so the beats cannot be skipped from it.
    // The driver is mounted on a fresh profile (beat() is non-null and no Skip tutorial card was offered), the world is the void
    // (the HUD hidden), and the clock is held; the M3 playtest asked for each of these, since it saw the clock run free.
    same('tutorial first beat', await readBeat(page), expectations.beats[0]);
    await cardSays(expectations.beats[0]);
    same('no skip card on a fresh profile', await page.locator('.kt-card--tutorial').count(), 0);
    same('the HUD is hidden in beat.void', await page.locator('.kt-hud').isHidden(), true);
    const verbs = page.locator('.kt-panel--interactions [data-interaction]');
    same('verbs listed at entry', await verbs.count(), 7);
    same('verbs enabled before the reach', await page.locator('.kt-panel--interactions [data-interaction] button:enabled').count(), 0);
    const void0 = await readSeam(page);
    const pace = await page.locator('.kt-pace').textContent();
    console.log(`playthrough tutorial: pace during beat.void ${JSON.stringify(pace)}`);
    assert.match(pace ?? '', /paused \(beat\.void\)/, 'the pace indicator names the beat one hold');
    // 2 and 3. The floor writes itself, then the convoy lights.
    await arrived('beat.floor');
    same('the HUD appears with the floor', await page.locator('.kt-hud').isVisible(), true);
    const void1 = await readSeam(page);
    same('ticks during beat.void', void1.tick - void0.tick, 0);
    // The hold rule's other half: once the beat one hold lifts, the clock advances again.
    await page.waitForFunction(tick => globalThis.__kernelTrailDebug.tick() > tick, void1.tick, { timeout, polling: 50 });
    console.log('playthrough tutorial: the clock advanced again once the beat.void hold lifted');
    await arrived('beat.convoy');
    // The player clicks a stele: the first to light, at the point the seam projects it to; the rig engages on the hit.
    await page.waitForFunction(() => globalThis.__kernelTrailDebug.anchorOnScreen('anchor.convoy.lumen') !== null, undefined, { timeout, polling: 50 });
    // Pointer events through the real DOM: the HUD container is none, inline by the Hud's own hand and not overridden, and a canvas point inside the safe
    // inset resolves to the canvas, so a click there is the world's (609585a; the M3 playtest reported nothing clickable).
    const hit = await page.evaluate(() => {
      const hud = document.querySelector('.kt-hud');
      const point = globalThis.__kernelTrailDebug.anchorOnScreen('anchor.convoy.lumen');
      const at = document.elementFromPoint(point.x, point.y);
      return { computed: hud === null ? null : getComputedStyle(hud).pointerEvents, inline: hud?.style.pointerEvents ?? null, at: at === null ? null : `${at.tagName}#${at.id}`, point };
    });
    console.log(`playthrough pointer: ${JSON.stringify(hit)}`);
    same('the HUD container is pointer-events none', hit.computed, 'none');
    same('the HUD container\'s own inline pointer-events (set by the Hud, not the session)', hit.inline, 'none');
    same('elementFromPoint at a canvas point inside the safe inset', hit.at, 'CANVAS#stage');
    // The stele read as clickable: hovering one turns the cursor to a pointer and the HUD's focus hint names it.
    await page.mouse.move(hit.point.x, hit.point.y);
    await page.waitForFunction(() => document.querySelector('#stage')?.style.cursor === 'pointer', undefined, { timeout, polling: 50 });
    const hover = await page.evaluate(() => ({ cursor: document.querySelector('#stage')?.style.cursor, hint: document.querySelector('.kt-hint')?.textContent ?? '' }));
    console.log(`playthrough hover over the lumen stele: ${JSON.stringify(hover)}`);
    same('the cursor over a stele', hover.cursor, 'pointer');
    assert(hover.hint.includes('anchor.convoy.lumen'), `the focus hint names the hovered stele: ${JSON.stringify(hover.hint)}`);
    await page.mouse.move(2, 2);
    await page.waitForFunction(() => document.querySelector('#stage')?.style.cursor === '', undefined, { timeout, polling: 50 });
    for (let attempt = 0; attempt < 20 && (await readBeat(page)) === 'beat.convoy'; attempt++) {
      const point = await page.evaluate(() => globalThis.__kernelTrailDebug.anchorOnScreen('anchor.convoy.lumen'));
      assert(point !== null, 'the lumen stele projects onto the screen');
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(400);
    }
    // 4. The reach: release the focus lock with the engage key, then the one verb, and the hard stop.
    await arrived('beat.reach');
    await page.keyboard.press('F');
    // The reach verb has been listed since entry, so the beat's own signal is the panel narrowing to that one row on the release.
    await page.waitForFunction(() => document.querySelectorAll('.kt-panel--interactions [data-interaction]').length === 1, undefined, { timeout, polling: 50 });
    const reach = page.getByRole('button', { name: 'Take the blocks', exact: true });
    await reach.waitFor({ timeout });
    same('verbs shown in beat.reach', await page.locator('.kt-panel--interactions [data-interaction]').count(), 1);
    same('the one verb shown is the reach', await page.locator('.kt-panel--interactions [data-interaction]').getAttribute('data-interaction'), 'boot.direct_reach');
    // A HUD-layer button is hittable through the real DOM: elementFromPoint at its centre is the button itself.
    const centre = await reach.evaluate(button => { const r = button.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return at === button ? 'the button' : `${at?.tagName ?? 'nothing'}.${at?.className ?? ''}`; });
    same('elementFromPoint at the centre of a HUD button', centre, 'the button');
    await reach.click();
    const refusal = page.locator('.kt-panel--interactions .kt-refusal');
    await refusal.waitFor({ timeout });
    same('the refusal line on the reach', await refusal.textContent(), 'EPERM. man EPERM.');
    // 5. The terminal: the hint names the key, the key opens it with the one character prompt, and man EPERM ends the beat.
    await arrived('beat.terminal');
    same('the focus hint in beat.terminal', await page.locator('.kt-hint').textContent(), 'terminal  [`] open');
    await page.keyboard.press('`');
    await page.locator('input[aria-label="terminal input"]').waitFor({ timeout });
    const prompt = await page.locator('.kt-terminal').textContent();
    assert(prompt?.includes('> '), `the terminal shows the one character prompt: ${JSON.stringify(prompt?.slice(0, 80))}`);
    // The M3 playtest found the terminal painted behind the panels: while it is open it is the topmost layer and the panels are dimmed.
    const layered = await page.evaluate(() => {
      const anchors = document.querySelector('.kt-panel--interactions');
      const r = anchors.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { overTerminal: at !== null && document.querySelector('.kt-terminal').contains(at), anchorsOpacity: getComputedStyle(anchors).opacity };
    });
    console.log(`playthrough terminal layering: ${JSON.stringify(layered)}`);
    same('elementFromPoint at the centre of the Anchors panel with the terminal open', layered.overTerminal, true);
    assert(Number(layered.anchorsOpacity) < 1, `the Anchors panel is dimmed under the terminal: opacity ${layered.anchorsOpacity}`);
    // Pre-flight ruling 9.3: a terminal line is a decision. The ruling named `sched rr`, which the Boot Sector's shell does not carry (its
    // sixteen commands are the base fourteen plus man, syscall and mode), so the leg's own `syscall getpid` is the command that
    // mutates through the sink; it records its syscall and its line once each, in that order.
    const before = (await decisionsOf(page)).length;
    await terminalSubmit(page, 'syscall getpid');
    await page.waitForFunction(count => globalThis.__kernelTrailDebug.run().decisions.length > count, before, { timeout, polling: 50 });
    const gained = (await decisionsOf(page)).slice(before);
    console.log(`playthrough tutorial: syscall getpid recorded ${JSON.stringify(gained)}; the harness records ${JSON.stringify(expectations.harnessTerminalStep)} for the same step`);
    assert.deepEqual(gained.map(record => record.kind), ['syscall', 'terminal'], 'syscall getpid records its syscall and its line, each once, in that order');
    same('the recorded terminal line', gained[1].choice.replace('[terminal] ', ''), expectations.harnessTerminalStep.choice);
    await terminalSubmit(page, 'man EPERM');
    // 6. The trap: the requisition opens and holds the clock; a question open stops time (section 1).
    await arrived('beat.trap');
    await page.locator('.kt-panel--requisition').waitFor({ timeout });
    // The beat card is never covered by a panel: its box and the requisition's do not intersect.
    const boxes = await page.evaluate(() => {
      const card = document.querySelector('.kt-card--beat').getBoundingClientRect();
      const panel = document.querySelector('.kt-panel--requisition').getBoundingClientRect();
      const intersects = card.left < panel.right && panel.left < card.right && card.top < panel.bottom && panel.top < card.bottom;
      return { intersects, card: [card.left, card.top, card.right, card.bottom].map(Math.round), panel: [panel.left, panel.top, panel.right, panel.bottom].map(Math.round) };
    });
    console.log(`playthrough beat card versus the requisition: ${JSON.stringify(boxes)}`);
    same('the beat card does not intersect the requisition panel', boxes.intersects, false);
    // The M3 playtest found Submit below the panel's visible edge at 1000 px tall: at both viewports it is inside the viewport while the panel is open.
    for (const [width, height] of [[1280, 720], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(250);
      const submitBox = await page.evaluate(() => { const r = document.querySelector('.kt-panel--requisition [aria-label="Submit"]').getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: innerWidth, h: innerHeight }; });
      console.log(`playthrough Submit at ${width}x${height}: ${JSON.stringify(submitBox)}`);
      assert(submitBox.top >= 0 && submitBox.left >= 0 && submitBox.bottom <= submitBox.h && submitBox.right <= submitBox.w, `Submit is inside the ${width}x${height} viewport`);
    }
    const held = await readSeam(page);
    await page.waitForTimeout(2000);
    const stillHeld = await readSeam(page);
    same('ticks across two seconds with the requisition open', stillHeld.tick - held.tick, 0);
    // The label lands through the HUD's batch on the flush after the hold changes, so it is awaited, bounded by the timeout.
    await page.waitForFunction(() => /paused \(requisition\)/.test(document.querySelector('.kt-pace')?.textContent ?? ''), undefined, { timeout, polling: 50 });
    console.log(`playthrough tutorial: pace with the requisition open ${JSON.stringify(await page.locator('.kt-pace').textContent())}`);
    const requisition = page.locator('.kt-panel--requisition');
    await requisition.getByRole('button', { name: 'Request memory quota mode', exact: true }).click();
    await requisition.locator('[aria-label="Request memory quota amount"]').fill('40');
    await requisition.locator('[aria-label="Request memory quota amount"]').dispatchEvent('change');
    await requisition.getByRole('button', { name: 'Add Request memory quota', exact: true }).click();
    await requisition.getByRole('button', { name: 'Submit', exact: true }).click();
    // 7. The batching lesson: the signage in the heading, until Close.
    await arrived('beat.batching');
    const heading = await requisition.locator('h2').textContent();
    console.log(`playthrough tutorial: requisition heading ${JSON.stringify(heading)}`);
    assert.match(heading ?? '', /^Trap: 4 cycles/, 'the depot signage states the trap price');
    await requisition.getByRole('button', { name: 'Close', exact: true }).click();
    // 8. The gate opens on the next frame and holds in its turn; the pace indicator names it. The leg ends on leg_done; the debrief follows.
    await arrived('beat.gate');
    await page.locator('.kt-panel--gate').waitFor({ timeout });
    await page.waitForFunction(() => /paused \(gate\)/.test(document.querySelector('.kt-pace')?.textContent ?? ''), undefined, { timeout, polling: 50 });
    console.log(`playthrough tutorial: pace with the gate open ${JSON.stringify(await page.locator('.kt-pace').textContent())}`);
    await page.locator('.kt-panel--gate').getByRole('button', { name: 'blocks', exact: true }).click();
    const end = await waitForDebrief(page, 'boot_sector', timeout);
    same('tutorial beat after the gate', await readBeat(page), null);
    same('no beat card after the gate', await page.locator('.kt-card--beat').count(), 0);
    const decisions = await decisionsOf(page);
    const relevant = decisions.filter(record => record.kind === 'leg_done' || record.kind === 'terminal' && record.choice.endsWith('man EPERM')
      || record.kind === 'interaction' && ['boot.direct_reach', 'boot.trap_purchase', 'boot.choose_disc'].some(id => record.choice.startsWith(`${id} @`)));
    console.log(`playthrough tutorial: decisions ${JSON.stringify(relevant)}`);
    // The script reads the manual before it reaches; the tutorial's beats reach first. Same kinds and outcomes, the order the beats fix.
    const expectedKinds = ['interaction', 'terminal', 'interaction', 'interaction', 'leg_done'];
    assert.deepEqual(relevant.map(record => record.kind), expectedKinds, 'the reach, the manual, one submission, the gate and leg_done');
    same('the reach is costly', relevant[0].outcome, 'costly');
    same('the manual line', relevant[1].choice.replace('[terminal] ', ''), 'man EPERM');
    same('the submission is good', relevant[2].outcome, 'good');
    same('the gate is good', relevant[3].outcome, 'good');
    same('the gate answer', relevant[3].choice, expectations.scripted.find(record => record.choice.startsWith('boot.choose_disc')).choice);
    same('the gate writes leg_done', relevant[4].choice, 'blocks');
    same('tutorial legHashes length', end.legHashes.length, 1);
    assert(end.legHashes[0].ticks < 200, `the tutorial ended on the gate at tick ${end.legHashes[0].ticks}, before the allowance the browser did not pass`);
    // The profile records the completed Boot Sector.
    const flag = await page.evaluate(([name, key]) => new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const get = db.transaction('settings', 'readonly').objectStore('settings').get(key);
        get.onsuccess = () => { db.close(); resolve(get.result?.value ?? null); };
        get.onerror = () => { db.close(); reject(get.error); };
      };
    }), [expectations.dbName, expectations.flagKey]);
    same('bootSectorCompleted in the profile', flag, true);
    const validation = await page.evaluate(() => globalThis.__kernelTrailGpuValidation.snapshot());
    assert.deepEqual(validation, [], `${path}: native GPU validation`);
    assert.equal(diagnostics.pageErrors.length, 0, `${path}: page errors`);
    assert.deepEqual(consoleErrors(diagnostics), [], `${path}: console errors`);
    return { path, backend, timings, ticks: end.legHashes[0].ticks, hash: end.legHashes[0].hash };
  } catch (error) {
    await describeFailure(page, path);
    console.error(formatPageDiagnostics(diagnostics));
    throw new Error(`${path}: ${error.stack || String(error)}`);
  } finally { await page.close(); }
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
      await startNewRun(page, timeout, { skip: true });
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
      console.log('playthrough reload: the title screen offers Continue; the provisional save landed at beforeunload');
      await continueButton.click();
      await waitForLegRail(page, 'The Boot Sector', timeout);
      await waitForSeam(page, timeout);
      await page.keyboard.press(']'); await page.keyboard.press(']');
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
    await startNewRun(page, timeout, { skip: true });
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
          const tutorial = await playTutorial(context, baseUrl, backend, expectations, timeout);
          const reload = await playReload(context, baseUrl, backend, expectations, timeout);
          const journey = await playJourney(context, baseUrl, backend, expectations, timeout);
          return { backend, tutorial, reload: reload.first, journey };
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

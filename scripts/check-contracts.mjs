#!/usr/bin/env node
/**
 * KERNEL TRAIL contract guard.
 *
 * Runs in CI and locally as `npm run check:contracts`. Zero dependencies on
 * purpose: it must work on a machine where `npm install` has not finished, and
 * it must never be the thing that breaks.
 *
 * WHY THIS EXISTS. Thirty-four agents build this project in parallel against
 * frozen interfaces. Three failure modes are invisible in a green test run and
 * expensive to unwind later:
 *
 *   1. An agent edits a frozen contract to make its own package compile. Every
 *      other package in flight is now building against a file that moved.
 *   2. An agent writes a second scanner, linter or helper with a policy that
 *      contradicts the existing one. This already happened once, in WP-01, and
 *      cost a full round trip.
 *   3. An agent makes a failing test pass by skipping it.
 *
 * Tests cannot catch these, because in each case the test suite is green. The
 * check has to sit beside the suite rather than inside it.
 *
 * Every rule below fails with the specific file, the specific line, and the
 * specific remedy. A guard rail that says only "failed" trains people to
 * disable it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const LOCK = JSON.parse(readFileSync(join(ROOT, 'contracts.lock.json'), 'utf8'));

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.stale', 'coverage', '.devcontainer']);

const failures = [];
const notes = [];
const fail = (rule, detail, remedy) => failures.push({ rule, detail, remedy });

function walk(dir, filter, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(full, filter, out);
    else if (filter(entry)) out.push(full);
  }
  return out;
}

const rel = (p) => relative(ROOT, p).split(sep).join('/');
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/* ------------------------------------------------------------------ */
/* Rule 1: the frozen contracts have not moved                         */
/* ------------------------------------------------------------------ */
/*
 * Hash comparison rather than a git diff against a base ref, so this works on a
 * detached checkout, in a shallow CI clone, and on a machine with no network.
 */
for (const [path, expected] of Object.entries(LOCK.frozen)) {
  let actual;
  try {
    actual = sha256(readFileSync(join(ROOT, path), 'utf8'));
  } catch {
    fail('frozen-contract', `${path} is missing`, 'Restore it from git. This file may not be deleted or renamed.');
    continue;
  }
  if (actual !== expected) {
    fail(
      'frozen-contract',
      `${path} has changed (expected ${expected.slice(0, 12)}, found ${actual.slice(0, 12)})`,
      'Frozen interfaces may not be edited by a work package. Revert the file, then follow the escalation\n' +
        '    procedure in docs/astra/00-ASTRA-BRIEFING.md section 2: leave a throwing stub, finish the rest,\n' +
        '    and report. If a human has deliberately approved this change, regenerate the lock with\n' +
        '    `npm run check:contracts -- --update` and say so in the commit message.',
    );
  }
}

/* ------------------------------------------------------------------ */
/* Rule 2: exactly one source scanner                                  */
/* ------------------------------------------------------------------ */
/*
 * The WP-01 failure in full: the scaffold's scanner stripped comments by design
 * and said so in its header, while a second scanner written days later did not.
 * Both were reasonable alone. Together they made the rule unsatisfiable, because
 * the frozen types.ts header states the prohibition in prose. One scanner, one
 * policy.
 */
const scannerDefs = walk(join(ROOT, 'tests'), (f) => f.endsWith('.ts')).filter((f) =>
  /export\s+(?:async\s+)?function\s+stripComments\s*\(/.test(readFileSync(f, 'utf8')),
);
if (scannerDefs.length === 0) {
  fail('single-scanner', 'no file exports stripComments', 'tests/kernel/sourceScan.ts must export it. Restore it from git.');
} else if (scannerDefs.length > 1) {
  fail(
    'single-scanner',
    `stripComments is defined in ${scannerDefs.length} files: ${scannerDefs.map(rel).join(', ')}`,
    'There is one source scanner, tests/kernel/sourceScan.ts, and every guard imports it. Delete the\n' +
      '    duplicate and import the shared one. Two scanners means two policies, which is how WP-01 blocked.',
  );
} else if (rel(scannerDefs[0]) !== LOCK.scanner) {
  fail('single-scanner', `the scanner moved to ${rel(scannerDefs[0])}`, `It belongs at ${LOCK.scanner}. Move it back or update contracts.lock.json deliberately.`);
}

/* ------------------------------------------------------------------ */
/* Rule 3: the skip budget only ever goes down                         */
/* ------------------------------------------------------------------ */
/*
 * A skipped test is a failing test with the alarm disconnected. Deferring one is
 * sometimes right, which is why the budget is a number rather than zero, but it
 * is a decision a human makes by lowering this number, never a side effect of a
 * package being in a hurry.
 */
const SKIP_RE = /\b(?:it|test|describe)\s*\.\s*(?:skip|todo)\s*\(/g;
const skips = [];
for (const file of walk(join(ROOT, 'tests'), (f) => f.endsWith('.ts'))) {
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    SKIP_RE.lastIndex = 0;
    if (SKIP_RE.test(line)) skips.push(`${rel(file)}:${i + 1}`);
  });
}
if (skips.length > LOCK.skipBudget) {
  fail(
    'skip-budget',
    `${skips.length} skipped tests, budget is ${LOCK.skipBudget}:\n      ${skips.join('\n      ')}`,
    'Make the test pass or delete it. If the skip is a deliberate deferral, lower nothing and instead raise\n' +
      '    contracts.lock.json skipBudget in the same commit, with the reason in the commit message.',
  );
} else if (skips.length < LOCK.skipBudget) {
  notes.push(`skip budget has slack: ${skips.length} of ${LOCK.skipBudget}. Lower it in contracts.lock.json to lock the gain in.`);
}

/* ------------------------------------------------------------------ */
/* Rule 4: no em dashes, anywhere                                      */
/* ------------------------------------------------------------------ */
/*
 * A house style rule, enforced because it applies to player-facing copy and to
 * every document an agent generates, and agents reintroduce it constantly.
 */
// Written as escapes, not as literal characters, so this file does not trip its
// own rule. A guard rail that needs an exemption for itself is a broken guard rail.
const DASH_RE = /[\u2014\u2013]/;
const prose = [
  ...walk(join(ROOT, 'src'), (f) => /\.(ts|tsx|html|css)$/.test(f)),
  ...walk(join(ROOT, 'tests'), (f) => f.endsWith('.ts')),
  ...walk(join(ROOT, 'docs'), (f) => f.endsWith('.md')),
  ...walk(join(ROOT, 'scripts'), (f) => f.endsWith('.mjs')),
];
const dashHits = [];
for (const file of prose) {
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (DASH_RE.test(line)) dashHits.push(`${rel(file)}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
}
if (dashHits.length) {
  fail(
    'no-em-dashes',
    `${dashHits.length} line(s):\n      ${dashHits.slice(0, 25).join('\n      ')}${dashHits.length > 25 ? `\n      ...and ${dashHits.length - 25} more` : ''}`,
    'Replace with a comma, colon, parenthesis, semicolon, or two sentences. This applies to code comments\n' +
      '    and generated documents as well as to anything a player reads.',
  );
}

/* ------------------------------------------------------------------ */
/* Rule 5: no borrowed IP outside the files that forbid it             */
/* ------------------------------------------------------------------ */
/*
 * Three documents have to name the property in order to prohibit it. Everywhere
 * else, a hit is a real leak. This one matters most in src/, because that is
 * what ships to a player, and in a portfolio project that ships publicly.
 */
const IP_RE = new RegExp(`\\b(${LOCK.forbiddenTerms.join('|')})\\b`, 'i');
const ipAllow = new Set(LOCK.ipAllowlist);
const ipHits = [];
for (const file of [...prose, join(ROOT, 'README.md')]) {
  const name = rel(file);
  if (ipAllow.has(name)) continue;
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  source.split('\n').forEach((line, i) => {
    const m = IP_RE.exec(line);
    if (m) ipHits.push(`${name}:${i + 1}  ${m[0]}  ${line.trim().slice(0, 80)}`);
  });
}
if (ipHits.length) {
  fail(
    'ip-leak',
    `${ipHits.length} hit(s):\n      ${ipHits.slice(0, 25).join('\n      ')}`,
    'This project is an aesthetic homage with original names. See docs/astra/00-ASTRA-BRIEFING.md section 8.\n' +
      '    Rename it. If the file legitimately has to name the property in order to forbid it, add the path to\n' +
      '    ipAllowlist in contracts.lock.json and say why in the commit message.',
  );
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

if (process.argv.includes('--update')) {
  const next = { ...LOCK, frozen: {} };
  for (const path of Object.keys(LOCK.frozen)) next.frozen[path] = sha256(readFileSync(join(ROOT, path), 'utf8'));
  next.skipBudget = skips.length;
  console.log(JSON.stringify(next, null, 2));
  console.log('\nWrite the JSON above to contracts.lock.json. Do this only when a human approved the change.');
  process.exit(0);
}

for (const note of notes) console.log(`note: ${note}`);

if (failures.length === 0) {
  console.log(`contract check passed: ${Object.keys(LOCK.frozen).length} frozen files, 1 scanner, ${skips.length}/${LOCK.skipBudget} skips, 0 em dashes, 0 IP leaks`);
  process.exit(0);
}

console.error(`\ncontract check FAILED with ${failures.length} violation(s)\n`);
for (const f of failures) {
  console.error(`  [${f.rule}] ${f.detail}`);
  console.error(`    remedy: ${f.remedy}\n`);
}
console.error('These rules exist because a green test suite cannot detect any of them.');
console.error('Do not disable a rule to get past it. Fix the cause, or escalate.\n');
process.exit(1);

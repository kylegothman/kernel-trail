/**
 * WP-20 section 7.2: for every shipped leg, for each of its two fixtures,
 * the golden hash, the second-run hash, the restore-at-midpoint hash and
 * the fixture's expectation. A missing golden file is a failure, never a
 * silent record: recording is `golden:record`, a human action. Every
 * checked-in golden is also scanned for an em dash or an en dash.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEG_ORDER, type Leg } from '@game/types';
import { checkFixtureRun, isWarning, loadFixtures, runFixture, validateFixture, type LegFixture, type LegFixtureModule } from './harness/fixtureContract';
import { compareTiers, GOLDEN_DIR, goldenFiles, readGolden, tiersOf, type GoldenPath } from './harness/goldenLog';
import { remainderHashAfter } from './harness/LegHarness';
import { loadShippedSet, skipLine } from './harness/loadLeg';
import { fixtureStatus, owedFixtures } from './harness/stubFixtures';
import { readBalanceLedger } from '../../tools/golden/balance';

const shipped = await loadShippedSet();
const fixturesByLeg = new Map<string, LegFixtureModule | null>();
for (const leg of shipped.legs) fixturesByLeg.set(leg.id, await loadFixtures(leg.id));
for (const entry of shipped.skipped) console.log(skipLine('goldens', entry.id, entry.reason));

const DASH = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`);

describe('golden playthroughs', () => {
  it('reports every leg, its fixture status and its goldens as a fourteen-row table', () => {
    const shippedIds = new Set(shipped.legs.map((leg) => leg.id));
    console.log('goldens: leg               shipped fixture  good-golden bad-golden');
    for (const id of LEG_ORDER) {
      const good = readGolden(id, 'good') === null ? 'missing' : 'present';
      const bad = readGolden(id, 'bad') === null ? 'missing' : 'present';
      console.log(`goldens: ${id.padEnd(17)} ${(shippedIds.has(id) ? 'yes' : 'no').padEnd(7)} ${fixtureStatus(id).padEnd(8)} ${good.padEnd(11)} ${bad}`);
    }
    console.log(`goldens: fixtures owed: ${owedFixtures().join(', ') || 'none'}`);
    expect(owedFixtures().length + LEG_ORDER.filter((id) => fixtureStatus(id) === 'present').length).toBe(LEG_ORDER.length);
  });

  it('checked-in golden files carry no em dash or en dash and parse as their tier', () => {
    if (!existsSync(GOLDEN_DIR)) {
      console.log('goldens: tests/golden/legs does not exist yet; no golden file to scan');
      return;
    }
    const files = readdirSync(GOLDEN_DIR).filter((name) => name.endsWith('.txt'));
    for (const name of files) {
      const text = readFileSync(join(GOLDEN_DIR, name), 'utf8');
      expect(DASH.test(text), `${name} contains a dash`).toBe(false);
    }
    for (const id of LEG_ORDER) for (const path of ['good', 'bad'] as const) {
      const files = goldenFiles(id, path);
      if (existsSync(files.fingerprint) !== existsSync(files.summary)) throw new Error(`${id} ${path}: one tier is present without the other`);
      if (existsSync(files.fingerprint)) expect(readGolden(id, path)).not.toBeNull();
    }
  });

  it('every recorded golden has a row in tests/golden/balance.json (WP-23 section 3)', () => {
    const ledger = readBalanceLedger();
    for (const id of LEG_ORDER) for (const path of ['good', 'bad'] as const) {
      if (readGolden(id, path) === null) continue;
      expect(ledger?.[id]?.[path], `${id} ${path}: a golden is recorded without a balance row; run npm run golden:record -- --leg ${id} --path ${path} --force or npm run golden:balance`).toBeDefined();
    }
  });

  for (const leg of shipped.legs) {
    const fixtures = fixturesByLeg.get(leg.id) ?? null;
    describe(leg.id, () => {
      it('supplies both fixtures', () => {
        expect(fixtures, `${leg.id} has shipped without tests/legs/${leg.id}/fixtures.ts`).not.toBeNull();
      });
      if (fixtures === null) return;
      for (const path of ['good', 'bad'] as const) {
        const fixture: LegFixture = path === 'good' ? fixtures.knownGood : fixtures.knownBad;
        describe(path, () => {
          it('validates against the fixture contract', () => {
            const findings = validateFixture(fixture, leg);
            for (const warning of findings.filter(isWarning)) console.log(`goldens: ${leg.id} ${path}: ${warning}`);
            expect(findings.filter((problem) => !isWarning(problem))).toEqual([]);
            expect(fixture.path).toBe(path);
          });
          it('matches the checked-in golden, is repeatable in one process, restores at the midpoint identically and meets its expectation', async () => {
            const expected = readGolden(leg.id, path);
            expect(expected, `${leg.id} ${path}: no golden is checked in; record it with npm run golden:record -- --leg ${leg.id} --path ${path}`).not.toBeNull();
            if (expected === null) return;
            const first = await runFixture(fixture, leg);
            expect(compareTiers(tiersOf(first), expected), `${leg.id} ${path}: run npm run golden:explain -- ${leg.id} ${path}`).toEqual([]);
            const second = await runFixture(fixture, leg);
            expect(second.logHash).toBe(first.logHash);
            const restored = await runFixture(fixture, leg, { restoreAt: Math.floor(first.ticks / 2) });
            expect(restored.restore).not.toBeNull();
            if (restored.restore !== null) expect(restored.restore.remainderHash).toBe(remainderHashAfter(first, restored.restore.seq));
            expect(restored.logHash).toBe(first.logHash);
            expect(checkFixtureRun(fixture, first, leg)).toEqual([]);
          });
        });
      }
    });
  }
});

export type { GoldenPath, Leg };

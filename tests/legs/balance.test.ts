/**
 * WP-23 section 3: the balance ledger's test. For every shipped leg with
 * fixtures, the row in `tests/golden/balance.json` exists for both paths,
 * running the fixture reproduces every number in it exactly (the runs are
 * deterministic, so equality and not tolerance), the recomputed throughput
 * factor agrees with the observed throughput within the clamp so drift
 * between the recorder's arithmetic and `LegRunner.effectiveOutcome` shows
 * up, and the entering ledger is continuous with the predecessor's closing
 * ledger when the predecessor has shipped. Every provisional number is
 * listed in one printed table at the end so the count is visible on every
 * run. The test asserts that the numbers are what the file says and that
 * the file says where each came from; it does not assert that any number
 * is good.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { LEG_ORDER, type Leg } from '@game/types';
import { enteringSourceOf, pathRowOf, readBalanceLedger, rowFragmentOf, throughputFactorOf, type BalanceLedger, type BalanceRow } from '../../tools/golden/balance';
import { loadFixtures, runFixture, type LegFixtureModule } from './harness/fixtureContract';
import { readGolden } from './harness/goldenLog';
import { loadShippedSet, skipLine, tryLoadLegForTest } from './harness/loadLeg';

const shipped = await loadShippedSet();
const fixturesByLeg = new Map<string, LegFixtureModule | null>();
for (const leg of shipped.legs) fixturesByLeg.set(leg.id, await loadFixtures(leg.id));
for (const entry of shipped.skipped) console.log(skipLine('balance', entry.id, entry.reason));
const ledger: BalanceLedger = readBalanceLedger() ?? {};
const shippedIds = new Set(shipped.legs.map((leg) => leg.id));
const ANALYTICAL = /analytical/i;

const provisional: string[] = [];

describe('the balance ledger', () => {
  it('exists when any golden is recorded', () => {
    const recorded = LEG_ORDER.some((id) => readGolden(id, 'good') !== null || readGolden(id, 'bad') !== null);
    if (recorded) expect(readBalanceLedger(), 'tests/golden/balance.json is missing; run npm run golden:balance').not.toBeNull();
    else console.log('balance: no golden is recorded yet; the ledger has nothing to hold');
  });

  for (const leg of shipped.legs) {
    const fixtures = fixturesByLeg.get(leg.id) ?? null;
    if (fixtures === null) continue;
    describe(leg.id, () => {
      const row = ledger[leg.id];
      it('has a row for both paths', () => {
        expect(row, `${leg.id}: no balance row; run npm run golden:balance`).toBeDefined();
        expect(row?.good, `${leg.id} good: no balance block`).toBeDefined();
        expect(row?.bad, `${leg.id} bad: no balance block`).toBeDefined();
      });
      if (row === undefined) return;
      it('says where its entering ledger came from, and the fixture agrees', async () => {
        const loaded = await tryLoadLegForTest(leg.id);
        expect(loaded.shipped).toBe(true);
        if (!loaded.shipped) return;
        const fragment = rowFragmentOf(fixtures.knownGood, loaded.content, enteringSourceOf(leg.id));
        expect(row.enteringLedger).toEqual(fragment.enteringLedger);
        expect(row.enteringSource).toBe(fragment.enteringSource);
        expect(row.throughputTarget).toEqual(fragment.throughputTarget);
        if (row.throughputTarget.provisional) provisional.push(`${leg.id.padEnd(17)} throughputTarget ${String(row.throughputTarget.value).padEnd(6)} PROVISIONAL_THROUGHPUT_TARGET; the companion declares none`);
      });
      for (const path of ['good', 'bad'] as const) {
        it(`${path}: running the fixture reproduces every number in the row exactly`, async () => {
          const block = row[path];
          expect(block, `${leg.id} ${path}: no balance block`).toBeDefined();
          if (block === undefined) return;
          const result = await runFixture(path === 'good' ? fixtures.knownGood : fixtures.knownBad, leg);
          const actual = pathRowOf(result, row.throughputTarget.value);
          console.log(`balance: ${leg.id} ${path}: ticks=${actual.ticks} objectivesMet=${actual.objectivesMet} casualties=[${actual.casualties.join(', ')}] closing=${JSON.stringify(actual.closingLedger)} dividend=${actual.dividend} throughput=${result.throughput} factor=${actual.throughputFactor}`);
          expect(actual).toEqual(block);
          // The recorder's clamp against the runner's: the factor times the target is the throughput inside the clamp, and the clamp's edge outside it.
          const ratio = result.throughput / row.throughputTarget.value;
          expect(throughputFactorOf(result.throughput, row.throughputTarget.value)).toBe(block.throughputFactor);
          if (block.throughputFactor > 0.6 && block.throughputFactor < 1.4) expect(block.throughputFactor * row.throughputTarget.value).toBeCloseTo(result.throughput, 9);
          else if (block.throughputFactor === 0.6) expect(ratio).toBeLessThanOrEqual(0.6);
          else expect(ratio).toBeGreaterThanOrEqual(1.4);
        });
      }
      it('enters with its predecessor\'s closing ledger when the predecessor has shipped', () => {
        const index = LEG_ORDER.indexOf(leg.id);
        const previous = index > 0 ? LEG_ORDER[index - 1] : undefined;
        if (previous === undefined) {
          console.log(`balance: ${leg.id} enters with the starting ledger ${JSON.stringify(row.enteringLedger)} (${row.enteringSource})`);
          return;
        }
        if (!shippedIds.has(previous)) {
          console.log(`balance: ${leg.id} enters with ${JSON.stringify(row.enteringLedger)}; ${previous} has not shipped, so the row is the analytical curve: ${row.enteringSource}`);
          return;
        }
        const closing: BalanceRow | undefined = ledger[previous];
        expect(closing?.good, `${previous}: no good-path block to check ${leg.id}'s entering ledger against`).toBeDefined();
        expect(row.enteringLedger, `${leg.id} enters with a ledger no player can arrive with; ${previous}'s golden closing ledger differs`).toEqual(closing?.good?.closingLedger);
        expect(ANALYTICAL.test(row.enteringSource), `${leg.id}: ${previous} has shipped but the entering ledger is still sourced from the analytical curve: ${row.enteringSource}`).toBe(false);
      });
    });
  }
});

afterAll(() => {
  console.log(`balance: ${provisional.length} provisional number(s)`);
  if (provisional.length > 0) {
    console.log('balance: leg               number           source');
    for (const line of provisional) console.log(`balance: ${line}`);
  }
});

export type { Leg };

/** WP-L07 acceptance 5: each of the seven objectives, met and not met. */
import { describe, expect, it } from 'vitest';
import type { ScriptStep } from '../harness/decisionScript';
import { runLeg } from '../harness/LegHarness';
import { loadLegForTest } from '../harness/loadLeg';
import { makeRunState } from '../harness/makeRunState';
import { runFixture } from '../harness/fixtureContract';
import { OBJECTIVE_IDS } from '@legs/allocation_yards/objectives';
import { knownBad, knownGood } from './fixtures';

const leg = await loadLegForTest('allocation_yards');
const entering = { cycles: 1022, quota: 900, blocks: 120, bandwidth: 60 } as const;

const interact = (at: number, id: string, anchor: string): ScriptStep =>
  ({ at, command: { kind: 'interaction', id, anchor } });
const line = (at: number, text: string): ScriptStep => ({ at, command: { kind: 'terminal', line: text } });

async function met(label: string, steps: readonly ScriptStep[]): Promise<readonly string[]> {
  const result = await runLeg(leg, {
    seed: 0x4b54524c,
    run: makeRunState({ seed: 0x4b54524c, legIndex: 7, ledger: entering }),
    script: { legId: 'allocation_yards', label, steps: [...steps] },
  });
  expect(result.panics, label).toEqual([]);
  return result.outcome.objectivesMet;
}

const PLACE: readonly ScriptStep[] = [
  { at: 6, command: { kind: 'set_allocation', to: 'best_fit' } },
  interact(8, 'yards.compact', 'anchor.compaction_crew'),
];

describe('strategy_choice', () => {
  it('is met when every Program is placed and fragmentation ends under 12 percent', async () => {
    expect(await met('placed', PLACE)).toContain('obj.allocation_yards.strategy_choice');
  });
  it('is not met while a Program is still without a berth', async () => {
    expect(await met('unplaced', [{ at: 3, command: { kind: 'set_allocation', to: 'worst_fit' } }]))
      .not.toContain('obj.allocation_yards.strategy_choice');
  });
});

describe('diagnose_fragmentation', () => {
  it('is met by reading free -f after the refusal and before spending on compaction', async () => {
    expect(await met('diagnosed', [line(2, 'free -f'), ...PLACE])).toContain('obj.allocation_yards.diagnose_fragmentation');
  });
  it('is not met by compacting without reading anything', async () => {
    expect(await met('habit', PLACE)).not.toContain('obj.allocation_yards.diagnose_fragmentation');
  });
  it('is not met by a player who compacts a yard that is already one free run', async () => {
    // The first pass is the right cure. The second is bought against a yard
    // that has nothing left to slide, which is what the man page means by
    // "compaction will not help".
    const outcome = await met('wrong cure', [
      line(2, 'free -f'), ...PLACE, interact(40, 'yards.compact', 'anchor.compaction_crew'),
    ]);
    expect(outcome).not.toContain('obj.allocation_yards.diagnose_fragmentation');
  });
});

describe('paging_trade', () => {
  it('is met on conversion, with external at exactly zero and internal within half a frame per Program', async () => {
    expect(await met('converted', [...PLACE, interact(20, 'yards.convert_to_paging', 'anchor.paging_gate')]))
      .toContain('obj.allocation_yards.paging_trade');
  });
  it('is not met by a yard that stays contiguous', async () => {
    expect(await met('contiguous', PLACE)).not.toContain('obj.allocation_yards.paging_trade');
  });
});

describe('locality_over_hardware', () => {
  it('is met by the contiguous route with the cache untouched', async () => {
    expect(await met('route', [interact(20, 'yards.route_contiguous', 'anchor.route_fork')]))
      .toContain('obj.allocation_yards.locality_over_hardware');
  });
  it('is not met on the scattered route, whose hit rate is 41 percent', async () => {
    expect(await met('scattered', [interact(20, 'yards.route_scattered', 'anchor.route_fork')]))
      .not.toContain('obj.allocation_yards.locality_over_hardware');
  });
  it('is not met by a player at a good hit rate who bought entries', async () => {
    const outcome = await met('bought', [
      interact(20, 'yards.route_contiguous', 'anchor.route_fork'),
      interact(24, 'yards.buy_tlb_entries', 'anchor.tlb_console'),
    ]);
    expect(outcome).not.toContain('obj.allocation_yards.locality_over_hardware');
  });
});

describe('protection_bits and page_size_tradeoff', () => {
  it('protection_bits is met by clearing the bit and not met by leaving it', async () => {
    expect(await met('cleared', [interact(30, 'yards.clear_executable', 'anchor.protection_bench')]))
      .toContain('obj.allocation_yards.protection_bits');
    expect(await met('left set', [])).not.toContain('obj.allocation_yards.protection_bits');
  });

  it('page_size_tradeoff is met on an admissible size and lost on one that wastes too much', async () => {
    const admissible = await met('8192', [...PLACE,
      interact(20, 'yards.convert_to_paging', 'anchor.paging_gate'),
      interact(24, 'yards.page_size_up', 'anchor.page_size_dial'),
    ]);
    expect(admissible).toContain('obj.allocation_yards.page_size_tradeoff');
    const wasteful = await met('32768', [...PLACE,
      interact(20, 'yards.convert_to_paging', 'anchor.paging_gate'),
      interact(24, 'yards.page_size_up', 'anchor.page_size_dial'),
      interact(28, 'yards.page_size_up', 'anchor.page_size_dial'),
      interact(32, 'yards.page_size_up', 'anchor.page_size_dial'),
    ]);
    expect(wasteful).not.toContain('obj.allocation_yards.page_size_tradeoff');
  });
});

describe('the whole set', () => {
  it('the known-good run meets all seven and the known-bad run meets none', async () => {
    const good = await runFixture(knownGood, leg);
    expect([...good.outcome.objectivesMet].sort()).toEqual([...OBJECTIVE_IDS].sort());
    const bad = await runFixture(knownBad, leg);
    expect(bad.outcome.objectivesMet).toEqual([]);
  });
});

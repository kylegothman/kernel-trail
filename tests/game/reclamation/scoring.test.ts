import { describe, expect, it, vi } from 'vitest';
import type { ConvoyMemberId } from '@kernel/index';
import { Reclamation } from '../../../src/game/reclamation/Reclamation';
import { scoreReclamation } from '../../../src/game/reclamation/scoring';
import { createRunStreams } from '../../../src/game/replay/types';
import { initialRunState } from '../../../src/game/replay/runReplay';
import { createRunStore } from '../../../src/game/runStore';

const tally = { leakedFrames: 100, fragmentsCollected: 10, longestUnbrokenChain: 1, liveBlocksReclaimed: 0 };

function harness() {
  const store = createRunStore(initialRunState(9, 'shell', 'operator'));
  const rng = createRunStreams(9).reclamation; const record = vi.fn();
  const onIntegrity = vi.fn((id: ConvoyMemberId, amount: number) => store.mutate((run) => { const member = run.convoy.find((candidate) => candidate.id === id); if (member !== undefined) member.integrity -= amount; }));
  const round = new Reclamation({ getRun: store.get, mutate: store.mutate, rng, onIntegrity, record });
  return { store, round, rng, onIntegrity, record };
}

describe('reclamation scoring', () => {
  it('yield formulas and compiler multiplier use unrounded quota', () => {
    expect(scoreReclamation(tally, 'shell')).toMatchObject({ quota: 120, blocks: 5, cycles: 12, coalesceMultiplier: 1, cleanSweepBonus: 1.2, classMultiplier: 1 });
    expect(scoreReclamation(tally, 'compiler').quota).toBe(162);
    expect(scoreReclamation({ ...tally, leakedFrames: 1000 }, 'shell').cycles).toBe(30);
  });
  it.each([[1, 1], [2, 1.15], [14, 2.95], [15, 3], [100, 3]])('coalesce multiplier at chain %s is %s', (chain, expected) => expect(scoreReclamation({ ...tally, longestUnbrokenChain: chain }, 'shell').coalesceMultiplier).toBeCloseTo(expected, 12));
  it('live blocks cost 25 quota each and remove the clean sweep bonus', () => {
    expect(scoreReclamation({ ...tally, liveBlocksReclaimed: 1 }, 'shell')).toMatchObject({ quota: 75, cycles: 7, cleanSweepBonus: 1 });
    expect(scoreReclamation({ ...tally, liveBlocksReclaimed: 5 }, 'shell').quota).toBe(0);
  });
  it.each([[90, 8, 9], [150, 18, 15], [220, 30, 22], [265, 38, 26]])('R10 explicit scoring fixture: %s quota %s blocks %s cycles', (quota, blocks, cycles) => {
    // Accepted R10 tests scoring fixtures; generated layout balance is deferred.
    const result = scoreReclamation({ leakedFrames: quota / 1.2, fragmentsCollected: blocks * 2, longestUnbrokenChain: 1, liveBlocksReclaimed: 0 }, 'shell');
    expect(result.quota).toBeCloseTo(quota, 12); expect(result.blocks).toBe(blocks); expect(result.cycles).toBe(cycles);
  });
  it.each([[1, 1], [2, 0.6], [3, 0.36]])('run %s returns multiplier %s', (runIndex, expected) => {
    expect(scoreReclamation(tally, 'shell', runIndex).returnsMultiplier).toBe(expected);
    expect(scoreReclamation(tally, 'shell', runIndex).quota).toBeCloseTo(120 * expected, 12);
  });
  it('R11 applies diminishing returns before block rounding and computes refund from final quota', () => {
    expect(scoreReclamation({ ...tally, fragmentsCollected: 3, longestUnbrokenChain: 2 }, 'shell', 2).blocks).toBe(1);
    expect(scoreReclamation(tally, 'shell', 3).cycles).toBe(4);
  });
});

describe('reclamation lifecycle', () => {
  it('first round is free at zero bandwidth, runs two and three cost 8, fourth is refused', () => {
    const h = harness(); h.store.mutate((run) => { run.resources.bandwidth = 0; });
    h.round.open(0.5, 'operator', 1); h.round.close();
    expect(() => h.round.open(0.5, 'operator', 1)).toThrow('in order');
    const rng = h.rng.save(); expect(() => h.round.open(0.5, 'operator', 2)).toThrow('Insufficient'); expect(h.rng.save()).toEqual(rng);
    h.store.mutate((run) => { run.resources.bandwidth = 16; });
    h.round.open(0.5, 'operator', 2); expect(h.store.get().resources.bandwidth).toBe(8); h.round.close();
    h.round.open(0.5, 'operator', 3); expect(h.store.get().resources.bandwidth).toBe(0); h.round.close();
    expect(() => h.round.open(0.5, 'operator', 4)).toThrow('three');
  });
  it('a live collect inflicts 6 integrity, blanks 4 seconds, and forfeits the bonus', () => {
    const h = harness(); const layout = h.round.open(0.5, 'operator', 1);
    const leak = layout.leaked[0]; const live = layout.live[0]; if (leak === undefined || live === undefined) throw new Error('missing fixture targets');
    const result = h.round.submit([{ atSeconds: 3, action: 'collect', blockId: leak.id }, { atSeconds: 4, action: 'collect', blockId: live.id }]);
    expect(result.lightingBlankedUntil).toBe(8); expect(h.onIntegrity).toHaveBeenCalledWith(expect.any(String), 6);
    expect(h.store.get().convoy.reduce((sum, member) => sum + member.integrity, 0)).toBe(494);
    expect(result.yield.cleanSweepBonus).toBe(1); expect(h.record).toHaveBeenCalledTimes(1);
    expect(() => h.round.submit([])).toThrow('one trace');
  });
  it('malformed traces fail before integrity, ledger or random-stream mutation', () => {
    const h = harness(); const layout = h.round.open(0.5, 'operator', 1); const live = layout.live[0]; if (live === undefined) throw new Error('missing fixture target');
    const before = h.rng.save(); const ledger = { ...h.store.get().resources };
    expect(() => h.round.submit([{ atSeconds: 4, action: 'collect', blockId: live.id }, { atSeconds: 3, action: 'collect', blockId: -1 }])).toThrow('ordered');
    expect(h.onIntegrity).not.toHaveBeenCalled(); expect(h.rng.save()).toEqual(before); expect(h.store.get().resources).toEqual(ledger);
  });
  it('coalescing only continues through declared adjacency and collection breaks the chain', () => {
    const h = harness(); h.round.open(0.5, 'operator', 1);
    const snapshot = h.round.snapshot(); const layout = snapshot.layout; if (layout === null) throw new Error('missing layout');
    const fixtures = [0, 1, 2].map((id) => ({ id, frames: 1, position: id, adjacent: [id - 1, id + 1] }));
    h.round.restore({ ...snapshot, layout: { ...layout, fragments: fixtures } });
    const result = h.round.submit([{ atSeconds: 3, action: 'coalesce', blockId: 0 }, { atSeconds: 4, action: 'collect', blockId: 1 }, { atSeconds: 5, action: 'coalesce', blockId: 2 }]);
    expect(result.yield.coalesceMultiplier).toBe(1);
  });
});

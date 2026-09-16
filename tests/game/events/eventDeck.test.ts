import { describe, expect, it, vi } from 'vitest';
import { asTick } from '../../../src/kernel/types';
import { createRng } from '../../../src/kernel/rng';
import { apply, draw, eligible, validateTable } from '../../../src/game/events/EventDeck';
import { LegSandbox } from '../../../src/game/LegSandbox';
import { initialRunState } from '../../../src/game/replay/runReplay';
import type { RandomEventDef } from '../../../src/game/types';
import { createSyntheticLeg } from '../fixtures/syntheticLeg';

function event(id: string, weight: number, patch: Partial<RandomEventDef> = {}): RandomEventDef {
  return { id, weight, title: id, narration: 'Synthetic event fixture.', targets: null, inflicts: null, resourceDelta: {}, onlyIf: null, ...patch };
}
const table = [event('first', 5), event('second', 10), event('third', 20), event('fourth', 30), event('last', 35)];

function context(seed = 19) {
  return { run: initialRunState(seed, 'shell', 'operator'), rng: createRng(seed, 'events'), at: asTick(10), legId: 'boot_sector' as const };
}

describe('EventDeck', () => {
  it('weighted draw reproduces each weight within one percentage point over 100,000 seeded draws', () => {
    const ctx = context();
    const counts = new Map(table.map(def => [def.id, 0]));
    for (let n = 0; n < 100_000; n += 1) {
      const def = draw(table, ctx);
      if (def === null) throw new Error('nonempty table returned null');
      counts.set(def.id, (counts.get(def.id) ?? 0) + 1);
    }
    for (const def of table) expect(Math.abs((counts.get(def.id) ?? 0) / 100_000 - def.weight / 100), def.id).toBeLessThan(0.01);
  });

  it('10,000 draws are identical across equal seeds and across RNG save/restore', () => {
    const a = context(71);
    const b = context(71);
    const start = a.rng.save();
    const sequence = Array.from({ length: 10_000 }, () => draw(table, a)?.id);
    expect(Array.from({ length: 10_000 }, () => draw(table, b)?.id)).toEqual(sequence);
    a.rng.restore(start);
    expect(Array.from({ length: 10_000 }, () => draw(table, a)?.id)).toEqual(sequence);
    expect(a.rng.save()).toEqual(b.rng.save());
  });

  it('draws from the inclusive first weight through the final weight using the RNG exclusive upper bound', () => {
    const ctx = context();
    const int = vi.spyOn(ctx.rng, 'int').mockReturnValueOnce(1).mockReturnValueOnce(100);
    expect(draw(table, ctx)?.id).toBe('first');
    expect(draw(table, ctx)?.id).toBe('last');
    expect(int.mock.calls).toEqual([[1, 101], [1, 101]]);
  });

  it('an empty or all-ineligible table returns null without consuming RNG', () => {
    const ctx = context();
    const before = ctx.rng.save();
    expect(draw([], ctx)).toBeNull();
    expect(draw([event('excluded', 100, { onlyIf: () => false })], ctx)).toBeNull();
    expect(ctx.rng.save()).toEqual(before);
  });

  it('filters eligibility without reordering or changing weights and renormalises the draw', () => {
    const ctx = context();
    const entries = [event('z', 10), event('excluded', 70, { onlyIf: () => false }), event('a', 20)];
    const before = structuredClone(entries.map(({ onlyIf: _onlyIf, ...rest }) => rest));
    expect(eligible(entries, ctx.run).map(def => [def.id, def.weight])).toEqual([['z', 10], ['a', 20]]);
    const int = vi.spyOn(ctx.rng, 'int').mockReturnValueOnce(10).mockReturnValueOnce(11).mockReturnValueOnce(30);
    expect(draw(entries, ctx)?.id).toBe('z');
    expect(draw(entries, ctx)?.id).toBe('a');
    expect(draw(entries, ctx)?.id).toBe('a');
    expect(int.mock.calls).toEqual([[1, 31], [1, 31], [1, 31]]);
    expect(entries.map(({ onlyIf: _onlyIf, ...rest }) => rest)).toEqual(before);
  });

  it('onlyIf exceptions are excluded and recorded through the injected sandbox predicate', () => {
    const ctx = context();
    const error = new Error('predicate fixture');
    const onFailure = vi.fn();
    const sandbox = new LegSandbox(createSyntheticLeg(), onFailure);
    const entries = [event('broken', 80, { onlyIf: () => { throw error; } }), event('remaining', 20)];
    expect(draw(entries, { ...ctx, predicate: (def, run) => sandbox.predicate(def, run) })?.id).toBe('remaining');
    expect(sandbox.failureList).toEqual([{ phase: 'interaction', error }]);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(entries.map(def => def.weight)).toEqual([80, 20]);
  });

  it('role-targeted application selects only a living matching Program and applies its affliction', () => {
    const ctx = context();
    const def = event('codec', 100, { targets: 'codec', inflicts: 'memory_leak', resourceDelta: { quota: -25 } });
    const result = apply(def, ctx);
    expect(result.target).toBe('orrery');
    expect(result.inflicted).toBe('memory_leak');
    expect(ctx.run.convoy.find(member => member.id === 'orrery')?.afflictions.map(a => a.id)).toEqual(['memory_leak']);
    expect(ctx.run.resources.quota).toBe(875);
    expect(ctx.run.convoy.filter(member => member.id !== 'orrery').every(member => member.afflictions.length === 0)).toBe(true);
  });

  it('a role with no living match retains its resource effect with a null target and no affliction', () => {
    const ctx = context();
    const codec = ctx.run.convoy.find(member => member.role === 'codec');
    if (codec === undefined) throw new Error('codec fixture missing');
    codec.integrity = 0;
    codec.status = 'derezzed';
    const before = ctx.rng.save();
    const result = apply(event('codec', 100, { targets: 'codec', inflicts: 'memory_leak', resourceDelta: { cycles: -40 } }), ctx);
    expect(result.target).toBeNull();
    expect(result.inflicted).toBeNull();
    expect(ctx.run.resources.cycles).toBe(1560);
    expect(ctx.rng.save()).toEqual(before);
    expect(codec.afflictions).toEqual([]);
  });

  it('untargeted events select living members in id order independent of roster array order', () => {
    const a = context();
    const b = context();
    b.run.convoy.reverse();
    for (const ctx of [a, b]) {
      const kestrel = ctx.run.convoy.find(member => member.id === 'kestrel');
      if (kestrel === undefined) throw new Error('courier fixture missing');
      kestrel.integrity = 0;
      kestrel.status = 'derezzed';
      vi.spyOn(ctx.rng, 'int').mockReturnValue(0);
    }
    const def = event('any', 100, { inflicts: 'bit_rot' });
    expect(apply(def, a).target).toBe('lumen');
    expect(apply(def, b).target).toBe('lumen');
    expect(a.rng.int).toHaveBeenCalledWith(0, 4);
    expect(b.rng.int).toHaveBeenCalledWith(0, 4);
  });

  it('an event with no living Program still applies its ledger delta without a target roll', () => {
    const ctx = context();
    for (const member of ctx.run.convoy) { member.integrity = 0; member.status = 'derezzed'; }
    const before = ctx.rng.save();
    expect(apply(event('empty convoy', 100, { resourceDelta: { blocks: -1000 } }), ctx).target).toBeNull();
    expect(ctx.run.resources.blocks).toBe(0);
    expect(ctx.rng.save()).toEqual(before);
  });

  it('validates positive integer weights, duplicate ids, total weight and nonempty narration separately', () => {
    expect(validateTable(table)).toEqual([]);
    expect(validateTable([event('fraction', 0.5), event('rest', 99.5)])).toContain('fraction: weight must be a positive integer');
    expect(validateTable([event('zero', 0), event('rest', 100)])).toContain('zero: weight must be a positive integer');
    expect(validateTable([event('duplicate', 50), event('duplicate', 50)])).toEqual(['duplicate: duplicate id']);
    expect(validateTable([event('short', 99)])).toEqual(['weights total 99, expected 100']);
    expect(validateTable([event('empty', 100, { narration: '   ' })])).toEqual(['empty: empty narration']);
  });
});

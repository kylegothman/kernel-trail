/** WP-L07: the population, its page counts, its arrivals and what it does not declare. */
import { describe, expect, it } from 'vitest';
import type { ConvoyMemberId } from '@kernel/types';
import type { LegSetupContext, ProcessSpec } from '@game/types';
import { loadLegForTest } from '../harness/loadLeg';
import { makeRunState } from '../harness/makeRunState';
import { CONVOY, SPAWN_COUNT, TOUCHED_PAGES, YARD } from '@legs/allocation_yards/populate';
import { TOTAL_FRAMES } from '@legs/allocation_yards/config';

const leg = await loadLegForTest('allocation_yards');

function record(): { spawns: ProcessSpec[]; bound: ConvoyMemberId[]; resources: string[]; syncs: string[] } {
  const spawns: ProcessSpec[] = [];
  const bound: ConvoyMemberId[] = [];
  const resources: string[] = [];
  const syncs: string[] = [];
  let pid = 2;
  const ctx: LegSetupContext = {
    run: makeRunState({ seed: 0x4b54524c, legIndex: 7 }),
    rng: { next: () => 0.5, int: (a) => a },
    spawn: (spec) => { spawns.push(spec); return (pid++) as never; },
    bind: (member) => { bound.push(member); },
    declareResource: (id) => { resources.push(id); },
    declareSync: (id) => { syncs.push(id); },
  };
  leg.populate(ctx);
  return { spawns, bound, resources, syncs };
}

describe('the Allocation Yards population', () => {
  it('spawns five Programs and seven yard processes, and binds the five', () => {
    const { spawns, bound } = record();
    expect(spawns).toHaveLength(SPAWN_COUNT);
    expect(spawns).toHaveLength(12);
    expect(bound).toEqual(['lumen', 'sable', 'orrery', 'kestrel', 'vesper']);
    expect(spawns.slice(0, 5).map((spec) => spec.name)).toEqual(['LUMEN', 'SABLE', 'ORRERY', 'KESTREL', 'VESPER']);
    expect(spawns.slice(5).map((spec) => spec.name)).toEqual(YARD.map((spawn) => spawn.name));
  });

  it('carries the curriculum map page counts on the convoy', () => {
    const { spawns } = record();
    expect(spawns.slice(0, 5).map((spec) => spec.pages)).toEqual([12, 10, 10, 8, 11]);
    expect(spawns.slice(0, 5).map((spec) => spec.priority)).toEqual(CONVOY.map((spawn) => spawn.priority));
    expect(spawns.slice(0, 5).map((spec) => spec.service)).toEqual([64, 58, 58, 52, 58]);
    expect(spawns.slice(0, 5).every((spec) => spec.arrival === 0)).toBe(true);
  });

  it('keeps the yard transients on the package arrival schedule', () => {
    const { spawns } = record();
    const yard = spawns.slice(5);
    expect(yard.map((spec) => spec.arrival)).toEqual([0, 0, 12, 20, 28, 36, 44]);
  });

  it('seats exactly the frame table at tick zero, so the next arrival is refused', () => {
    const { spawns } = record();
    const atZero = spawns.filter((spec) => spec.arrival === 0);
    expect(atZero).toHaveLength(7);
    expect(atZero.length * TOUCHED_PAGES).toBe(TOTAL_FRAMES);
  });

  it('never touches a page outside the frame budget, which is what keeps a vm-off kernel from throwing', () => {
    const { spawns } = record();
    for (const spec of spawns) {
      const references = spec.referenceString ?? [];
      for (const page of references) expect(page, spec.name).toBeLessThan(TOUCHED_PAGES);
    }
    // A transient the yard refuses holds no frame at all, so it may not reference one.
    for (const spec of spawns.slice(5)) {
      const yardSpawn = YARD.find((candidate) => candidate.name === spec.name);
      if (yardSpawn?.resident === false) expect(spec.referenceString, spec.name).toEqual([]);
    }
  });

  it('declares no resource and no synchronisation primitive: there is no contention in the Yards', () => {
    const { resources, syncs } = record();
    expect(resources).toEqual([]);
    expect(syncs).toEqual([]);
  });
});

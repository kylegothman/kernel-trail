/**
 * WP-L04: nine spawns, five bindings and the primitives, checked against the
 * recording setup context rather than a kernel, which is what
 * `validateContent` uses and what a crossing definition is validated against.
 */
import { describe, expect, it } from 'vitest';
import { recordDeclarations } from '@legs/content';
import theNarrows from '@legs/the_narrows';
import { FORD_WIDTH } from '@legs/the_narrows/ledger';
import { ROSTER, SYNC_DECLARATIONS } from '@legs/the_narrows/populate';
import { narrowsKernel } from './kernelFixture';

describe('what the Narrows puts on the substrate', () => {
  it('spawns nine Programs and binds the five of the convoy', () => {
    const declared = recordDeclarations(theNarrows);
    expect(declared.error).toBeNull();
    expect(declared.spawned.size).toBe(9);
    expect([...declared.bound].sort()).toEqual(['kestrel', 'lumen', 'orrery', 'sable', 'vesper']);
    expect(ROSTER).toHaveLength(9);
    expect(ROSTER.filter((spec) => spec.member !== null)).toHaveLength(5);
  });

  it('asks for three pages or fewer per Program, which is the floor at starved rations with vm disabled', () => {
    const fixture = narrowsKernel();
    for (const spec of ROSTER) {
      const pid = fixture.pids.get(spec.name);
      expect(pid, spec.name).toBeDefined();
      const space = pid === undefined ? undefined : fixture.kernel.process(pid)?.addressSpaceId;
      const table = space === undefined ? [] : fixture.kernel.pageTables.get(space) ?? [];
      expect(table.length, spec.name).toBeLessThanOrEqual(3);
    }
  });

  it('spawns the holder first, so it takes the manifest lock before anything else is runnable', () => {
    expect(ROSTER[0]?.name).toBe('narrows.sweep');
    expect(ROSTER[0]?.arrival).toBe(0);
    for (const spec of ROSTER.slice(1)) expect(spec.arrival, spec.name).toBeGreaterThan(0);
  });

  it('puts the six Programs that carry the leg at the six lowest pids, which is the default degree of multiprogramming', () => {
    expect(ROSTER.slice(0, 6).map((spec) => spec.name)).toEqual(['narrows.sweep', 'narrows.pilgrim_a', 'narrows.pilgrim_b', 'narrows.hauler', 'LUMEN', 'SABLE']);
  });

  it('declares eight primitives with the ids, kinds and counts the crossings read', () => {
    const declared = recordDeclarations(theNarrows);
    expect([...declared.sync].sort()).toEqual([
      'lock.ford_a', 'lock.ford_b', 'lock.manifest', 'lock.plank', 'mon.ford', 'sem.ford', 'sem.ford.3', 'sem.ford.4',
    ]);
    expect(SYNC_DECLARATIONS.filter((entry) => entry.kind === 'semaphore').map((entry) => entry.capacity)).toEqual([1, FORD_WIDTH, 4]);
    expect(SYNC_DECLARATIONS.filter((entry) => entry.kind === 'mutex')).toHaveLength(4);
    expect(SYNC_DECLARATIONS.filter((entry) => entry.kind === 'monitor')).toHaveLength(1);
  });

  it('creates every declared primitive ordered, because declareSync has no way to ask for anything else', () => {
    const fixture = narrowsKernel();
    const view = fixture.kernel.invariantState();
    expect(view.syncPrimitives).toHaveLength(SYNC_DECLARATIONS.length);
    for (const primitive of view.syncPrimitives) expect(primitive.ordered, primitive.id).toBe(true);
  });

  it('declares no resource, because this leg contends for primitives rather than resource instances', () => {
    expect([...recordDeclarations(theNarrows).resources]).toEqual([]);
  });
});

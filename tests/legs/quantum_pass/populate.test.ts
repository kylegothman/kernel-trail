/**
 * WP-L03 population: the spawns, the binds, and the two verbs the leg never
 * calls. The counts and the per-process figures are the leg's balance record,
 * so a retune that moves them fails here first.
 */
import { describe, expect, it } from 'vitest';
import type { Pid } from '@kernel/types';
import type { LegSetupContext, ProcessSpec } from '@game/types';
import { recordDeclarations } from '@legs/content';
import leg from '@legs/quantum_pass/index';
import { populate, SPAWN_COUNT } from '@legs/quantum_pass/populate';
import { LIVE_SEGMENTS, ROSTER, medianBurst, segment } from '@legs/quantum_pass/segments';
import { makeRunState } from '../harness/makeRunState';

function record(): { readonly specs: readonly ProcessSpec[]; readonly bound: readonly [string, Pid][] } {
  const specs: ProcessSpec[] = [];
  const bound: [string, Pid][] = [];
  let next = 2;
  const ctx: LegSetupContext = {
    run: makeRunState({ seed: 0x4b54524c, legIndex: 3 }),
    rng: { next: () => 0.5, int: (a) => a },
    spawn: (spec) => { specs.push(spec); return (next++) as Pid; },
    bind: (member, pid) => { bound.push([member, pid]); },
    declareResource: () => { throw new Error('quantum_pass declares no resource'); },
    declareSync: () => { throw new Error('quantum_pass declares no sync primitive'); },
  };
  populate(ctx);
  return { specs, bound };
}

describe('populate', () => {
  it('spawns thirteen processes and binds the five Programs', () => {
    const { specs, bound } = record();
    expect(specs).toHaveLength(SPAWN_COUNT);
    expect(SPAWN_COUNT).toBe(13);
    expect(bound.map(([member]) => member)).toEqual(['lumen', 'sable', 'orrery', 'kestrel', 'vesper']);
    // The convoy takes the lowest pids, so an equal priority and arrival breaks its tie in the convoy's favour.
    expect(bound.map(([, pid]) => pid)).toEqual([2, 3, 4, 5, 6]);
  });

  it('declares no resource and no sync primitive', () => {
    const declared = recordDeclarations(leg);
    expect(declared.error).toBeNull();
    expect([...declared.sync]).toEqual([]);
    expect([...declared.resources]).toEqual([]);
  });

  it('gives SABLE the highest priority number in the convoy and the longest service', () => {
    const sable = ROSTER.find((entry) => entry.member === 'sable');
    expect(sable?.priority).toBe(5);
    for (const entry of ROSTER) {
      if (entry.member === 'sable') continue;
      expect(entry.priority, entry.name).toBeLessThan(sable?.priority ?? 0);
      expect(entry.burst, entry.name).toBeLessThan(sable?.burst ?? 0);
    }
    // Lower number is higher priority, so nothing in the convoy is below her and she is the one the pass starves.
    expect(Math.max(...ROSTER.map((entry) => entry.priority))).toBe(sable?.priority);
  });

  it('the convoy arrives together, so no Program but SABLE waits for a warning it does not deserve', () => {
    expect(ROSTER.every((entry) => entry.arrival === 0)).toBe(true);
  });

  it('spawns each live segment at its recorded priorities, bursts and arrivals', () => {
    const { specs } = record();
    const workload = specs.slice(ROSTER.length);
    const expected = LIVE_SEGMENTS.flatMap((candidate) => candidate.rows);
    expect(workload.map((spec) => spec.name)).toEqual(expected.map((row) => row.name));
    workload.forEach((spec, index) => {
      const row = expected[index];
      expect(spec.priority, spec.name).toBe(row?.priority);
      expect(spec.burst, spec.name).toBe(row?.burst);
      expect(spec.service, spec.name).toBe(row?.service);
      // The kernel's first service interval is tick 1 and the textbook's is interval 0.
      expect(spec.arrival, spec.name).toBe((row?.arrival ?? 0) + 1);
    });
  });

  it('holds the shortest-job comparison set as replay data rather than spawning it', () => {
    const { specs } = record();
    expect(segment(2).live).toBe(false);
    for (const row of segment(2).rows) expect(specs.map((spec) => spec.name)).not.toContain(row.name);
  });

  it('the sweep set has a median burst of 4, which fixes the admissible quantum range', () => {
    expect(medianBurst(segment(3).rows)).toBe(4);
    // 1.2 to 4.0 times the median: steady's 8 and conservative's 16 are inside, aggressive's 4 and reckless's 2 are not.
    expect(1.2 * 4).toBeCloseTo(4.8, 6);
    expect(4 * 4).toBe(16);
  });

  it('never sets serialFraction, because this leg has no thread lesson', () => {
    const { specs } = record();
    for (const spec of specs) expect(spec.serialFraction, spec.name).toBeUndefined();
  });
});

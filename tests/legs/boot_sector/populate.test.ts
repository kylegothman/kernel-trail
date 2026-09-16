/** Acceptance 5: five spawns, five binds, nothing declared, arrivals staggered in roster order. */
import { describe, expect, it, vi } from 'vitest';
import { asPid, type Pid } from '@kernel/types';
import type { LegSetupContext, ProcessSpec } from '@game/types';
import { recordDeclarations } from '@legs/content';
import bootSector from '@legs/boot_sector';
import { populate, ROSTER } from '@legs/boot_sector/populate';
import { makeRunState } from '../harness/makeRunState';

describe('boot_sector populate', () => {
  it('spawns exactly five processes and binds five members, with no resource or sync declarations', () => {
    const specs: ProcessSpec[] = [];
    const bound: [string, Pid][] = [];
    let next = 2;
    const ctx: LegSetupContext = {
      run: makeRunState({ seed: 1, legIndex: 0 }),
      rng: { next: () => 0.5, int: (a) => a },
      spawn: vi.fn((spec: ProcessSpec) => { specs.push(spec); return asPid(next++); }),
      bind: vi.fn((member, pid) => { bound.push([member, pid]); }),
      declareResource: vi.fn(),
      declareSync: vi.fn(),
    };
    populate(ctx);
    expect(ctx.spawn).toHaveBeenCalledTimes(5);
    expect(ctx.bind).toHaveBeenCalledTimes(5);
    expect(ctx.declareResource).not.toHaveBeenCalled();
    expect(ctx.declareSync).not.toHaveBeenCalled();
    expect(specs.map((spec) => spec.arrival)).toEqual([0, 2, 4, 6, 8]);
    expect(specs.map((spec) => spec.name)).toEqual(['LUMEN', 'SABLE', 'ORRERY', 'KESTREL', 'VESPER']);
    expect(specs.map((spec) => spec.priority)).toEqual([2, 2, 3, 3, 3]);
    for (const spec of specs) {
      expect(spec.burst).toBe(4);
      expect(spec.service).toBe(12);
      expect(spec.pages).toBe(4);
      expect(spec.referenceString).toBeUndefined();
    }
    expect(bound).toEqual(ROSTER.map((entry, i) => [entry.member, asPid(2 + i)]));
  });

  it('declares nothing against the recording context either', () => {
    const declared = recordDeclarations(bootSector);
    expect(declared.error).toBeNull();
    expect([...declared.sync]).toEqual([]);
    expect([...declared.resources]).toEqual([]);
    expect([...declared.bound].sort()).toEqual(['kestrel', 'lumen', 'orrery', 'sable', 'vesper']);
  });
});

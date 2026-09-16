import { describe, expect, it } from 'vitest';
import { createRunStreams } from '../../../src/game/replay/types';
import { generateVerge, RECLAMATION_SECONDS } from '../../../src/game/reclamation/verge';

describe('Verge generation', () => {
  it.each([
    [0.1, 29, 5.55, 15, 5.2, 11, 5.6, 0.74],
    [0.5, 65, 3.75, 25, 4.0, 7, 12, 0.50],
    [0.9, 101, 1.95, 35, 2.8, 3, 18.4, 0.26],
  ])('all seven exact narrative 11.6 formulas at F=%s', (f, fragments, fragmentSize, leaked, leakSize, decay, rotation, adjacency) => {
    const layout = generateVerge(f, createRunStreams(9).reclamation, 'operator');
    expect(layout.fragments).toHaveLength(fragments); expect(layout.leaked).toHaveLength(leaked);
    expect(layout.fragments.reduce((sum, block) => sum + block.frames, 0) / fragments).toBeCloseTo(fragmentSize, 12);
    expect(layout.leaked.reduce((sum, block) => sum + block.frames, 0) / leaked).toBeCloseTo(leakSize, 12);
    expect(layout.markDecaySeconds).toBeCloseTo(decay, 12); expect(layout.rotationDegPerSec).toBeCloseTo(rotation, 12); expect(layout.adjacency).toBeCloseTo(adjacency, 12);
  });
  it('same injected stream state produces identical layouts and restores exactly', () => {
    const a = createRunStreams(99).reclamation; const b = createRunStreams(99).reclamation;
    const before = a.save(); const first = generateVerge(0.5, a, 'operator');
    expect(generateVerge(0.5, b, 'operator')).toEqual(first); a.restore(before); expect(generateVerge(0.5, a, 'operator')).toEqual(first);
  });
  it('time limits are 90, 75, 65 and 55 seconds', () => expect(RECLAMATION_SECONDS).toEqual({ novice: 90, operator: 75, architect: 65, kernel_space: 55 }));
  it('every leaked region includes a live block and all target ids are unique', () => {
    const layout = generateVerge(0.5, createRunStreams(8).reclamation, 'operator');
    expect(layout.leaked.every((leak) => layout.live.some((live) => live.position === leak.position))).toBe(true);
    const ids = [...layout.fragments, ...layout.leaked, ...layout.live].map((block) => block.id); expect(new Set(ids).size).toBe(ids.length);
  });
  it.each([-0.1, 1.1, Number.NaN])('rejects invalid fragmentation %s before generation', (f) => expect(() => generateVerge(f, createRunStreams(8).reclamation, 'operator')).toThrow(RangeError));
});

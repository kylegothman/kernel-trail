import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { EffectPool } from '../../src/world/EffectPool';
import type { EffectSpawn } from '../../src/world/effects/types';

const spawn = (at = new Vector3(1, 2, 3)): EffectSpawn => ({ kind: 'fault_mote', at, lifetimeSeconds: 1, intensity: 0.5, colour: 1 });

describe('EffectPool', () => {
  it('copies values, ages wall time and tolerates a missing follow anchor', () => {
    const pool = new EffectPool({ capacity: 2, overflow: 'recycle_oldest' });
    const at = new Vector3(1, 2, 3);
    const effect = pool.spawn({ ...spawn(at), follow: 'missing-anchor' as never });
    at.set(9, 9, 9);
    expect(effect?.at.toArray()).toEqual([1, 2, 3]);
    pool.update(0.9);
    expect(pool.activeCount).toBe(1);
    pool.update(0.1);
    expect(pool.activeCount).toBe(0);
  });

  it('implements recycle, aggregate and drop policies', () => {
    const recycle = new EffectPool({ capacity: 1, overflow: 'recycle_oldest' });
    const first = recycle.spawn(spawn())!;
    const firstId = first.id;
    const second = recycle.spawn(spawn(new Vector3(4, 5, 6)))!;
    expect(second.slot).toBe(first.slot);
    expect(second.id).not.toBe(firstId);
    const aggregate = new EffectPool({ capacity: 1, overflow: 'aggregate' });
    aggregate.spawn(spawn());
    expect(aggregate.spawn({ ...spawn(), intensity: 1 })).toBeNull();
    expect(aggregate.active[0]?.intensity).toBeGreaterThan(0.5);
    const drop = new EffectPool({ capacity: 1, overflow: 'drop' });
    drop.spawn(spawn());
    expect(drop.spawn(spawn())).toBeNull();
  });

  it('does not allocate Three math objects after construction', () => {
    const pool = new EffectPool({ capacity: 1000, overflow: 'drop' });
    let allocations = 0;
    const spec = spawn();
    const prior = (globalThis as { __ktAlloc?: (name: string) => void }).__ktAlloc;
    (globalThis as { __ktAlloc?: (name: string) => void }).__ktAlloc = () => { allocations += 1; };
    try {
      for (let i = 0; i < 100000; i += 1) { pool.spawn(spec); pool.update(2); }
    } finally {
      if (prior) (globalThis as { __ktAlloc?: (name: string) => void }).__ktAlloc = prior;
      else delete (globalThis as { __ktAlloc?: (name: string) => void }).__ktAlloc;
    }
    expect(allocations).toBe(0);
  });

  it('does not grow and clears back to a reusable fixed stack', () => {
    const pool = new EffectPool({ capacity: 1000, overflow: 'drop' });
    for (let i = 0; i < 100000; i += 1) { pool.spawn(spawn()); pool.update(2); }
    expect(pool.capacity).toBe(1000);
    expect(pool.inUse).toBe(0);
    pool.spawn(spawn()); pool.clear(); pool.spawn(spawn());
    expect(pool.inUse).toBe(1);
  });
});

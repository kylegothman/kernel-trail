import type { QualityTier } from '@platform';
import { PROFILES } from '@platform';
import { EffectPool } from '../EffectPool';
import type { EffectKind, EffectSpawn, LiveEffect, OverflowPolicy } from './types';

interface KindConfig { readonly capacity: Readonly<Record<QualityTier, number>>; readonly overflow: OverflowPolicy; }

export const EFFECT_CONFIG: Readonly<Record<EffectKind, KindConfig>> = {
  derezz: { capacity: { low: 4, medium: 8, high: 16 }, overflow: 'recycle_oldest' },
  page_flare: { capacity: { low: 64, medium: 192, high: 384 }, overflow: 'recycle_oldest' },
  page_dissolve: { capacity: { low: 48, medium: 128, high: 256 }, overflow: 'recycle_oldest' },
  fault_mote: { capacity: { low: 32, medium: 96, high: 192 }, overflow: 'aggregate' },
  fault_surge: { capacity: { low: 2, medium: 4, high: 6 }, overflow: 'aggregate' },
  seek_arc: { capacity: { low: 16, medium: 48, high: 96 }, overflow: 'recycle_oldest' },
  interrupt_spike: { capacity: { low: 24, medium: 64, high: 128 }, overflow: 'recycle_oldest' },
  lock_pulse: { capacity: { low: 16, medium: 32, high: 64 }, overflow: 'recycle_oldest' },
  race_shear: { capacity: { low: 2, medium: 4, high: 8 }, overflow: 'drop' },
  deadlock_ring: { capacity: { low: 1, medium: 2, high: 4 }, overflow: 'drop' },
  journal_stamp: { capacity: { low: 8, medium: 24, high: 48 }, overflow: 'recycle_oldest' },
  denial_ward: { capacity: { low: 4, medium: 12, high: 24 }, overflow: 'recycle_oldest' },
  trap_arc: { capacity: { low: 8, medium: 24, high: 48 }, overflow: 'drop' },
};

export class EffectRegistry {
  private readonly pools = new Map<EffectKind, EffectPool>();
  constructor(readonly tier: QualityTier) {
    for (const kind of Object.keys(EFFECT_CONFIG) as EffectKind[]) {
      const config = EFFECT_CONFIG[kind]!;
      this.pools.set(kind, new EffectPool({ capacity: config.capacity[tier], overflow: config.overflow }));
    }
  }
  spawn(spec: EffectSpawn): LiveEffect | null { return this.pools.get(spec.kind)?.spawn(spec) ?? null; }
  update(dtSeconds: number): void { for (const pool of this.pools.values()) pool.update(dtSeconds); }
  forEach(kind: EffectKind, fn: (effect: LiveEffect) => void): void { this.pools.get(kind)?.forEachLive(fn); }
  pool(kind: EffectKind): EffectPool | undefined { return this.pools.get(kind); }
  get liveTotal(): number { let total = 0; for (const pool of this.pools.values()) total += pool.inUse; return total; }
  get maxLiveEffects(): number { return PROFILES[this.tier].maxLiveEffects; }
  disposeAll(): void { for (const pool of this.pools.values()) pool.clear(); }
}

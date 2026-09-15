import type { Vector3 } from 'three/webgpu';
import type { AnchorId } from '../contracts';

export type EffectKind =
  | 'derezz' | 'page_flare' | 'page_dissolve' | 'fault_mote' | 'fault_surge'
  | 'seek_arc' | 'interrupt_spike' | 'lock_pulse' | 'race_shear'
  | 'deadlock_ring' | 'journal_stamp' | 'denial_ward' | 'trap_arc';

export interface EffectSpawn {
  readonly kind: EffectKind;
  readonly at: Vector3;
  readonly to?: Vector3;
  readonly follow?: AnchorId;
  readonly lifetimeSeconds: number;
  readonly intensity: number;
  readonly colour: number;
  readonly a?: number;
  readonly b?: number;
  readonly c?: number;
  readonly d?: number;
}

export interface LiveEffect extends EffectSpawn {
  age: number;
  slot: number;
  readonly id: number;
  alive: boolean;
}

export type OverflowPolicy = 'recycle_oldest' | 'aggregate' | 'drop';

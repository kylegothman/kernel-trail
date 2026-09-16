/**
 * KERNEL TRAIL - the two game-layer store instances the HUD observes.
 * Architecture section 4.4, WP-17 scope correction S7 and pre-flight ruling 6.1.
 *
 * `createRunStore` is a thin factory over the typed store in `store.ts`; it
 * adds no store class. `HudTelemetry` is the per-frame slice the host copies
 * out of `KernelSnapshot.metrics`, `KernelConfig` and the current leg, so the
 * HUD never holds a kernel reference. `RunState` is frozen and has no room for
 * these fields, which is why they live in a second store rather than on it.
 */

import type {
  AllocationStrategy,
  DiskSchedulingId,
  PageReplacementId,
  SchedulerId,
} from '@kernel/types';
import type { ConvoyMember, ResourceLedger, RunState, TravelPolicy } from '@game/types';
import { createStore, type Store } from './store';

export type RunStore = Store<RunState>;

export function createRunStore(initial: RunState): RunStore {
  return createStore<RunState>(initial);
}

/** What the top-left rail prints. Supplied by the host; no leg module exists yet. */
export interface HudLeg {
  readonly title: string;
  /** 0 for the boot sector, 1 to 13 for the legs. */
  readonly index: number;
  /** The number the rail prints after "of". */
  readonly count: number;
}

/**
 * The numbers the player steers by, copied once per frame by the host. Every
 * field is a scalar or a small record, so each is watchable with `Object.is`.
 */
export interface HudTelemetry {
  tick: number;
  /** `SchedulingMetrics.cpuUtilisation`, 0 to 1. */
  cpuUtilisation: number;
  /** `MemoryMetrics.faultRate`, faults per thousand ticks. */
  faultRate: number;
  /** `KernelConfig.thrashingThreshold`, the marked threshold on the fault meter. */
  thrashingThreshold: number;
  scheduler: SchedulerId;
  quantum: number;
  replacement: PageReplacementId;
  disk: DiskSchedulingId;
  allocation: AllocationStrategy;
  leg: HudLeg;
}

export type TelemetryStore = Store<HudTelemetry>;

export function createTelemetryStore(initial: HudTelemetry): TelemetryStore {
  return createStore<HudTelemetry>(initial);
}

/* ------------------------------------------------------------------ */
/* Selectors the HUD regions watch                                     */
/* ------------------------------------------------------------------ */

export const selectLegProgress = (s: Readonly<RunState>): number => s.legProgress;
export const selectConvoy = (s: Readonly<RunState>): readonly ConvoyMember[] => s.convoy;
export const selectResources = (s: Readonly<RunState>): Readonly<ResourceLedger> => s.resources;
export const selectPolicy = (s: Readonly<RunState>): Readonly<TravelPolicy> => s.policy;
export const selectTick = (t: Readonly<HudTelemetry>): number => t.tick;

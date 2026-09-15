import { AMBER, CYAN, SLATE } from '@design';

export type TerminationReason =
  | 'normal_exit' | 'killed_by_user' | 'killed_by_parent' | 'starvation'
  | 'deadlock_victim' | 'out_of_memory' | 'thrashing_collapse' | 'protection_fault'
  | 'io_timeout' | 'storage_corruption';

export type DerezzOrigin = 'base' | 'centre' | 'top' | 'plane';

export interface DerezzVariant {
  readonly reason: TerminationReason;
  readonly base: number;
  readonly hot: number;
  readonly dead: number;
  readonly dispersion: number;
  readonly gravity: number;
  readonly spread: number;
  readonly collapse: number;
  readonly spike: number;
  readonly freezeStart: number;
  readonly freezeDuration: number;
  readonly plane: boolean;
  readonly origin: DerezzOrigin;
  readonly extraBeat: 'none' | 'plane_sweep' | 'parent_beam' | 'drain' | 'freeze' | 'collapse' | 'ground_dissolve' | 'corruption';
  readonly corrupt: number;
  readonly drainBeforeFracture: number;
}

const common = { dead: SLATE.dead, freezeStart: -1, freezeDuration: 0, plane: false, origin: 'centre' as const, extraBeat: 'none' as const, corrupt: 0, drainBeforeFracture: 0 } as const;

export const DEREZZ_VARIANTS: Readonly<Record<TerminationReason, DerezzVariant>> = {
  normal_exit: { ...common, reason: 'normal_exit', base: CYAN.core, hot: CYAN.hot, dispersion: 0.9, gravity: 1.2, spread: 1, collapse: 1, spike: 1 },
  killed_by_user: { ...common, reason: 'killed_by_user', base: CYAN.core, hot: CYAN.white, dispersion: 1.6, gravity: 2.4, spread: 1, collapse: 1, spike: 1, origin: 'top', extraBeat: 'plane_sweep' },
  killed_by_parent: { ...common, reason: 'killed_by_parent', base: CYAN.core, hot: CYAN.white, dispersion: 1.4, gravity: 2.4, spread: 1, collapse: 1, spike: 1, origin: 'base', extraBeat: 'parent_beam' },
  starvation: { ...common, reason: 'starvation', base: SLATE.dead, hot: SLATE.dead, dispersion: 0.2, gravity: 9.8, spread: 0.35, collapse: 1, spike: 0, origin: 'base', extraBeat: 'drain', drainBeforeFracture: 0.6 },
  deadlock_victim: { ...common, reason: 'deadlock_victim', base: AMBER.core, hot: AMBER.hot, dispersion: 1.6, gravity: 2.4, spread: 1, collapse: 1, spike: 1, extraBeat: 'freeze', freezeStart: 0.45, freezeDuration: 0.2 },
  out_of_memory: { ...common, reason: 'out_of_memory', base: AMBER.core, hot: AMBER.white, dispersion: 1.2, gravity: 0, spread: 1, collapse: -1, spike: 1, extraBeat: 'collapse' },
  thrashing_collapse: { ...common, reason: 'thrashing_collapse', base: AMBER.core, hot: AMBER.hot, dispersion: 1, gravity: 9.8, spread: 0.8, collapse: -1, spike: 0, origin: 'base', extraBeat: 'ground_dissolve' },
  protection_fault: { ...common, reason: 'protection_fault', base: AMBER.core, hot: AMBER.white, dispersion: 2.2, gravity: 1, spread: 1, collapse: 1, spike: 1, origin: 'plane', plane: true, extraBeat: 'plane_sweep' },
  io_timeout: { ...common, reason: 'io_timeout', base: CYAN.core, hot: CYAN.core, dispersion: 0.8, gravity: 0.4, spread: 0.8, collapse: 1, spike: 0 },
  storage_corruption: { ...common, reason: 'storage_corruption', base: AMBER.core, hot: AMBER.white, dispersion: 1.4, gravity: 3, spread: 1, collapse: 1, spike: 1, extraBeat: 'corruption', corrupt: 1 },
};

export const TERMINATION_REASONS: readonly TerminationReason[] = [
  'normal_exit', 'killed_by_user', 'killed_by_parent', 'starvation', 'deadlock_victim',
  'out_of_memory', 'thrashing_collapse', 'protection_fault', 'io_timeout', 'storage_corruption',
];

export interface DerezzBeat { readonly name: 'pre_roll' | 'fracture' | 'spike' | 'scatter' | 'fade' | 'mote' | 'fall' | 'tombstone'; readonly startMs: number; readonly endMs: number; }

export const DEREZZ_BEATS: readonly DerezzBeat[] = Object.freeze([
  { name: 'pre_roll', startMs: -400, endMs: 0 }, { name: 'fracture', startMs: 0, endMs: 170 },
  { name: 'spike', startMs: 120, endMs: 250 }, { name: 'scatter', startMs: 170, endMs: 900 },
  { name: 'fade', startMs: 500, endMs: 1400 }, { name: 'mote', startMs: 1400, endMs: 3400 },
  { name: 'fall', startMs: 3400, endMs: 3900 }, { name: 'tombstone', startMs: 3900, endMs: 4700 },
]);

export const DEREZZ_TIMING = Object.freeze({
  convoy: Object.freeze({ preRoll: 400, fracture: 170, spikeStart: 120, spikeEnd: 250, scatterStart: 170, scatterEnd: 900, fadeStart: 500, fadeEnd: 1400, moteStart: 1400, moteEnd: 3400, fallStart: 3400, fallEnd: 3900, tombstone: 3900, release: 4700 }),
  anonymous: Object.freeze({ total: 520, dispersion: 0.6, gravity: 6, spread: 0.35 }),
});

export function terminationVariant(reason: TerminationReason): DerezzVariant { return DEREZZ_VARIANTS[reason]; }

/**
 * KERNEL TRAIL - replay types. Architecture 8.6 and 9.4, WP-18 scope
 * correction U1, U3, U4, U5 and U12, pre-flight rulings 2, 3 and 4.
 *
 * Not frozen by this package. A contract amendment freezes this file when
 * WP-19 lands, the same way `codexTypes.ts` will be. The request, override,
 * result and envelope shapes are the architecture's verbatim, with the
 * additions each comment names.
 */

import type { createKernel, KernelOptions } from '@kernel/Kernel';
import type {
  AllocationStrategy,
  DiskSchedulingId,
  KernelConfig,
  KernelEvent,
  PageReplacementId,
  Rng,
  RngState,
  SchedulerId,
  Tick,
} from '@kernel/types';
import { createRng } from '@kernel/rng';
import type {
  DecisionRecord,
  DifficultyTier,
  DiscClass,
  Leg,
  LegId,
  Pace,
  Rations,
  RunState,
  ScoreBreakdown,
  TravelPolicy,
} from '@game/types';
import type { Store } from '@game/store';

/* ------------------------------------------------------------------ */
/* Architecture 8.6                                                    */
/* ------------------------------------------------------------------ */

export interface ReplayRequest {
  readonly seed: number;
  readonly discClass: DiscClass;
  readonly difficulty: DifficultyTier;
  /** Which legs to run. A counterfactual usually runs exactly one. */
  readonly legs: readonly LegId[];
  readonly decisions: readonly DecisionRecord[];
  /** Policy substitutions applied instead of the recorded decisions. */
  readonly overrides: ReplayOverrides;
  /** Safety valve. A replay that exceeds this is aborted and reported. */
  readonly maxTicks: number;
  /**
   * Pre-flight ruling 2. `deadlockStrategy` is not a player verb and has no
   * `ReplayOverrides` field, so the planner's deadlock row cannot be expressed
   * as a decision. `runReplay` applies this patch by wrapping the resolved
   * headless factory so that `kernelConfig(run)` returns the patched config
   * before the kernel is built, which is the substitution architecture 8.7
   * describes. It is plain data, so it crosses the worker boundary with the
   * rest of the request, and it is never written to a decision log.
   */
  readonly configPatch?: { readonly deadlockStrategy?: KernelConfig['deadlockStrategy'] };
}

export interface ReplayOverrides {
  readonly scheduler?: SchedulerId;
  readonly quantum?: number;
  readonly replacement?: PageReplacementId;
  readonly diskPolicy?: DiskSchedulingId;
  readonly allocation?: AllocationStrategy;
  readonly pace?: Pace;
  readonly rations?: Rations;
  readonly degreeOfMultiprogramming?: number;
  /** When true, every recorded decision of an overridden kind is dropped. */
  readonly suppressRecordedPolicyChanges: boolean;
}

export interface ReplayResult {
  readonly ok: true;
  readonly ticks: number;
  readonly eventLogHash: string;
  readonly survivors: readonly string[];
  readonly casualties: readonly { readonly member: string; readonly reason: string; readonly tick: number }[];
  readonly scheduling: {
    readonly averageWaitingTime: number;
    readonly averageTurnaroundTime: number;
    readonly averageResponseTime: number;
    readonly contextSwitches: number;
    readonly cpuUtilisation: number;
    readonly worstWait: number;
  };
  readonly memory: {
    readonly pageFaults: number;
    readonly evictions: number;
    readonly faultRate: number;
  };
  /** U5: no seek metric exists in the snapshot, so head movement is summed from `disk.seek` events. */
  readonly storage: {
    readonly seekDistance: number;
  };
  readonly score: ScoreBreakdown;
  /** Up to 400 events chosen for the debrief timeline, already downsampled. */
  readonly highlights: readonly ReplayHighlight[];
  /** Pre-flight ruling 3: the skip count U2 asks for, and the per-leg hashes the deep check compares. */
  readonly diagnostics: {
    readonly skippedDecisions: number;
    readonly legs: readonly { readonly legId: LegId; readonly ticks: number; readonly eventLogHash: string }[];
  };
}

/** What a leg produced, live or replayed, in the shape the planner and the phrasing read. */
export type ObservedLeg = Pick<ReplayResult, 'casualties' | 'scheduling' | 'memory' | 'storage'>;

export interface ReplayHighlight {
  readonly tick: number;
  readonly type: string;
  readonly summary: string;
  readonly severity: 'info' | 'warning' | 'fatal';
}

export type ReplayResponse =
  | ReplayResult
  | { readonly ok: false; readonly reason: 'aborted' | 'error' | 'timeout'; readonly message: string };

/* ------------------------------------------------------------------ */
/* Architecture 9.4: the envelope                                      */
/* ------------------------------------------------------------------ */

export interface Envelope<TKind extends string, TPayload> {
  readonly id: number;
  readonly kind: TKind;
  readonly payload: TPayload;
}

export type ReplayRequestMessage = Envelope<'replay', ReplayRequest>;
export type ReplayCancelMessage = Envelope<'cancel', { readonly targetId: number }>;
export type ReplayInbound = ReplayRequestMessage | ReplayCancelMessage;

export type ReplayProgress = Envelope<'progress', { readonly targetId: number; readonly ticks: number }>;
export type ReplayDone = Envelope<'done', ReplayResponse>;
export type ReplayOutbound = ReplayProgress | ReplayDone;

/* ------------------------------------------------------------------ */
/* U3: the policy binding                                              */
/* ------------------------------------------------------------------ */

export type ReplayKernel = ReturnType<typeof createKernel>;

export interface PolicyBinding {
  /** Called after every policy change and once after populate. */
  apply(kernel: ReplayKernel, policy: Readonly<TravelPolicy>): void;
}

/**
 * Degree reaches the kernel through its one hook. Pace and rations mutate
 * `RunState.policy` only, because their kernel effect is the leg runner's
 * mapping, which does not exist yet.
 */
export const DEFAULT_POLICY_BINDING: PolicyBinding = {
  apply(kernel, policy) {
    kernel.setDegreeOfMultiprogramming(policy.degreeOfMultiprogramming);
    // TODO(astra): WP-19 supplies the pace and rations binding and replay must use the same one
  },
};

/**
 * Pre-flight ruling 4. The invariant harness costs about three times the
 * tick (52 versus 18 microseconds on the reference workload) and only
 * publishes a `kernel.panic` immediately before throwing, so a live run that
 * did not crash hashes identically with it off. `devBuild` stays true because
 * it gates a real event, the refusal of OPT on an unscripted workload. The
 * live runner must keep `devBuild` true for the same reason.
 */
export const REPLAY_KERNEL_OPTIONS: KernelOptions = Object.freeze({ devBuild: true, checkInvariants: false });

/* ------------------------------------------------------------------ */
/* U4: the game layer's streams and the per-tick hooks                 */
/* ------------------------------------------------------------------ */

/**
 * The run-level streams WP-19's determinism section names, forked from
 * `createRng(seed, 'run')` in this fixed order. `ReplayRecord.legEntryRng`
 * holds `saveRunStreams` at each leg start in the same order.
 */
export interface RunStreams {
  readonly root: Rng;
  readonly leg: Rng;
  readonly events: Rng;
  readonly crossing: Rng;
  readonly reclamation: Rng;
}

export const RUN_STREAM_LABELS = ['leg', 'events', 'crossing', 'reclamation'] as const;

export function createRunStreams(seed: number): RunStreams {
  const root = createRng(seed, 'run');
  return { root, leg: root.fork('leg'), events: root.fork('events'), crossing: root.fork('crossing'), reclamation: root.fork('reclamation') };
}

/** Root first, then the four forks in `RUN_STREAM_LABELS` order. */
export function saveRunStreams(streams: RunStreams): RngState[] {
  return [streams.root.save(), ...RUN_STREAM_LABELS.map((label) => streams[label].save())];
}

export function restoreRunStreams(streams: RunStreams, states: readonly RngState[]): void {
  const expected = ['run', ...RUN_STREAM_LABELS.map((label) => `run/${label}`)];
  if (states.length !== expected.length) throw new Error(`run streams expect ${expected.length} states, received ${states.length}`);
  states.forEach((state, i) => {
    if (state.label !== expected[i]) throw new Error(`run streams expect ${expected[i]} at index ${i}, received ${state.label}`);
  });
  const ordered: readonly Rng[] = [streams.root, ...RUN_STREAM_LABELS.map((label) => streams[label])];
  ordered.forEach((rng, i) => {
    const state = states[i];
    if (state !== undefined) rng.restore(state);
  });
}

export interface ReplayHooks {
  /** Before every kernel step: WP-19's director headless half (event draws, travel charge, arrivals). */
  beforeStep?(tick: Tick, kernel: ReplayKernel, streams: RunStreams, store: Store<RunState>): void;
  /** After every step with that tick's events: WP-19's postTick half (integrity, decision outcomes). */
  afterStep?(tick: Tick, kernel: ReplayKernel, events: readonly KernelEvent[], store: Store<RunState>): void;
  /** Leg end. Default: no process above pid 1 is live. */
  isComplete?(tick: Tick, kernel: ReplayKernel, run: Readonly<RunState>): boolean;
}

/* ------------------------------------------------------------------ */
/* U13: the headless half of a leg                                     */
/* ------------------------------------------------------------------ */

/**
 * A leg with `createStage` removed. This is why `Leg` splits simulation
 * concerns from `createStage`: a leg that puts simulation logic inside
 * `createStage` breaks replay and therefore breaks the counterfactual, and
 * the `headless equals staged` case is the assertion that catches it.
 */
export interface HeadlessLeg extends Pick<Leg, 'id' | 'index' | 'kernelConfig' | 'populate' | 'eventTable' | 'evaluate'> {
  readonly hooks?: ReplayHooks;
}

export type HeadlessLegFactory = () => HeadlessLeg;

/** A mid-journey start: a boundary save's `run` and its `rngStates`, which are `saveRunStreams` at leg entry. */
export interface ReplayEntry {
  readonly run: RunState;
  readonly rng: readonly RngState[];
}

export interface ReplayOptions {
  readonly binding?: PolicyBinding;
  /** Leg resolution; the default is the headless registry. */
  readonly legs?: (id: LegId) => HeadlessLeg;
  readonly kernelOptions?: KernelOptions;
  /** Called at most once per 500 ticks with the total ticks so far. */
  readonly onProgress?: (ticks: number) => void;
  /** Polled every 500 ticks; true aborts the replay at that boundary. */
  readonly isCancelled?: () => boolean;
  readonly entry?: ReplayEntry;
  /** The run and streams at each leg start, in the shape `ReplayRecord.legEntryRng` records. */
  readonly onLegEntry?: (index: number, legId: LegId, run: Readonly<RunState>, rng: readonly RngState[]) => void;
}

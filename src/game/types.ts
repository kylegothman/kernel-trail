/**
 * KERNEL TRAIL - game layer contracts.
 *
 * The game layer owns the run: the convoy, the resource ledger, the journey, and
 * the scoring. It drives the kernel; the kernel knows nothing about it.
 *
 * Dependency direction is strictly one way:
 *   legs -> game -> kernel
 *   world/render/ui/audio -> (read) game + kernel event stream
 * Nothing in @kernel may import from here.
 */

import type {
  ConvoyMemberId,
  KernelConfig,
  KernelSnapshot,
  Pid,
  RngState,
  SchedulerId,
  PageReplacementId,
  DiskSchedulingId,
  AllocationStrategy,
  TerminationReason,
  Tick,
} from '@kernel/types';

/* ------------------------------------------------------------------ */
/* The journey                                                         */
/* ------------------------------------------------------------------ */

export type LegId =
  | 'boot_sector'
  | 'fork_fields'
  | 'the_weave'
  | 'quantum_pass'
  | 'the_narrows'
  | 'the_cistern'
  | 'the_gridlock'
  | 'allocation_yards'
  | 'drowned_reach'
  | 'the_platters'
  | 'the_bus'
  | 'the_archive'
  | 'arbiter_wall'
  | 'the_portal';

/** Canonical journey order. The only place leg sequence is defined. */
export const LEG_ORDER: readonly LegId[] = [
  'boot_sector',
  'fork_fields',
  'the_weave',
  'quantum_pass',
  'the_narrows',
  'the_cistern',
  'the_gridlock',
  'allocation_yards',
  'drowned_reach',
  'the_platters',
  'the_bus',
  'the_archive',
  'arbiter_wall',
  'the_portal',
] as const;

/** A citation into Silberschatz, Operating System Concepts, 10th edition. */
export interface ChapterRef {
  readonly chapter: number;
  readonly sections: readonly string[];
  readonly title: string;
}

export interface LearningObjective {
  readonly id: string;
  /** Phrased as the player, not the student: "choose a quantum that avoids starvation". */
  readonly statement: string;
  readonly chapter: ChapterRef;
  /** How the game decides the player actually demonstrated this. */
  readonly assessedBy: 'outcome' | 'decision' | 'terminal_command' | 'survival';
}

/* ------------------------------------------------------------------ */
/* The convoy                                                          */
/* ------------------------------------------------------------------ */

export type ConvoyRole = 'compiler' | 'sentinel' | 'codec' | 'courier' | 'cartographer';

export interface ConvoyMember {
  readonly id: ConvoyMemberId;
  readonly name: string;
  readonly role: ConvoyRole;
  /** Live process backing this Program once the leg's kernel is built. */
  pid: Pid | null;
  /** 0 to 100. At 0 the Program derezzes. */
  integrity: number;
  status: ConvoyStatus;
  /** Set once, permanently, when the Program dies. Drives the tombstone. */
  epitaph: Epitaph | null;
  /** Uses remaining of the active ability this leg. */
  abilityCharges: number;
  /** Conditions currently afflicting this Program. Oregon Trail's dysentery slot. */
  afflictions: Affliction[];
}

export type ConvoyStatus = 'nominal' | 'degraded' | 'critical' | 'derezzed';

/**
 * Every affliction is a real OS pathology, and every one has a real remedy that
 * the player is expected to work out from the concept rather than from a tooltip.
 */
export type AfflictionId =
  | 'priority_inversion'
  | 'memory_leak'
  | 'starvation'
  | 'thrashing'
  | 'lock_convoy'
  | 'livelock'
  | 'orphaned'
  | 'fragmented'
  | 'cache_thrash'
  | 'bit_rot'
  | 'stack_overflow'
  | 'false_sharing'
  | 'interrupt_storm';

export interface Affliction {
  readonly id: AfflictionId;
  readonly displayName: string;
  readonly acquiredAtTick: Tick;
  /** Integrity lost per travel tick while untreated. */
  readonly drainPerTick: number;
  /** Ticks until this becomes fatal, or null if it merely drains. */
  readonly fatalAfter: number | null;
  /** What the player must actually do. Not shown until the codex entry unlocks. */
  readonly remedy: AfflictionRemedy;
}

export type AfflictionRemedy =
  | { readonly kind: 'set_scheduler'; readonly to: SchedulerId }
  | { readonly kind: 'set_replacement'; readonly to: PageReplacementId }
  | { readonly kind: 'set_disk_policy'; readonly to: DiskSchedulingId }
  | { readonly kind: 'set_allocation'; readonly to: AllocationStrategy }
  | { readonly kind: 'adjust_quantum'; readonly direction: 'increase' | 'decrease' }
  | { readonly kind: 'reduce_degree'; readonly by: number }
  | { readonly kind: 'spend'; readonly resource: ResourceKind; readonly amount: number }
  | { readonly kind: 'terminal'; readonly command: string }
  | { readonly kind: 'ability'; readonly member: ConvoyMemberId };

export interface Epitaph {
  readonly member: ConvoyMemberId;
  readonly tick: Tick;
  readonly legId: LegId;
  readonly reason: TerminationReason;
  /** The joke line, in the Oregon Trail tombstone register. */
  readonly inscription: string;
  /** The teaching line. Always shown beneath the joke. */
  readonly cause: string;
  /** Codex entry the tombstone links into. This is the point of dying. */
  readonly codexEntry: string;
}

/* ------------------------------------------------------------------ */
/* Resources                                                           */
/* ------------------------------------------------------------------ */

export type ResourceKind = 'cycles' | 'quota' | 'blocks' | 'bandwidth' | 'integrity';

export interface ResourceLedger {
  /** CPU budget. Spent to travel. Also the currency at depots. */
  cycles: number;
  /** Memory quota, in frames. The "food". Running out starves the convoy. */
  quota: number;
  /** Storage blocks. Spare parts: spent to repair, to journal, to rebuild RAID. */
  blocks: number;
  /** I/O budget. Caps how many actions a leg permits. */
  bandwidth: number;
}

/** Oregon Trail's pace. Maps directly onto the scheduler quantum. */
export type Pace = 'conservative' | 'steady' | 'aggressive' | 'reckless';

/** Oregon Trail's rations. Maps onto frames allocated per process. */
export type Rations = 'generous' | 'standard' | 'lean' | 'starved';

export interface TravelPolicy {
  pace: Pace;
  rations: Rations;
  /** Degree of multiprogramming. Ch. 10.6.1: raise it too far and you thrash. */
  degreeOfMultiprogramming: number;
}

/* ------------------------------------------------------------------ */
/* Run state                                                           */
/* ------------------------------------------------------------------ */

/** Oregon Trail's banker / carpenter / farmer. */
export type DiscClass = 'shell' | 'daemon' | 'compiler';

export type DifficultyTier = 'novice' | 'operator' | 'architect' | 'kernel_space';

export interface RunState {
  readonly runId: string;
  readonly seed: number;
  readonly discClass: DiscClass;
  readonly difficulty: DifficultyTier;
  legIndex: number;
  /** Distance travelled within the current leg, 0 to 1. */
  legProgress: number;
  convoy: ConvoyMember[];
  resources: ResourceLedger;
  policy: TravelPolicy;
  tombstones: Epitaph[];
  codexUnlocked: string[];
  objectivesMet: string[];
  /** Append-only decision log. Drives the end-of-run report and the replay. */
  decisions: DecisionRecord[];
  score: ScoreBreakdown;
  status: 'in_progress' | 'complete' | 'failed';
}

export interface DecisionRecord {
  readonly tick: Tick;
  readonly legId: LegId;
  readonly kind: string;
  readonly choice: string;
  /** Whether the sim later showed this to have been the right call. */
  outcome: 'good' | 'costly' | 'fatal' | 'pending';
  readonly relatedObjective: string | null;
}

export interface ScoreBreakdown {
  readonly survivors: number;
  readonly throughput: number;
  readonly efficiency: number;
  readonly correctness: number;
  readonly conceptsMastered: number;
  readonly classMultiplier: number;
  readonly total: number;
}

/* ------------------------------------------------------------------ */
/* Legs - the parallelisation boundary                                 */
/* ------------------------------------------------------------------ */

/**
 * One journey leg. This is the unit of work handed to a build agent: a leg is a
 * self-contained module that touches nothing outside this interface, so several
 * can be built simultaneously without conflicting.
 */
export interface Leg {
  readonly id: LegId;
  readonly index: number;
  readonly title: string;
  readonly subtitle: string;
  readonly chapters: readonly ChapterRef[];
  readonly objectives: readonly LearningObjective[];

  /** Kernel configuration this leg needs. Enable only the relevant subsystems. */
  kernelConfig(run: RunState): KernelConfig;

  /** Seed the kernel with this leg's initial processes and resources. */
  populate(ctx: LegSetupContext): void;

  /** Build the 3D world. Implemented in src/world, never here. */
  createStage(ctx: StageContext): LegStage;

  /** Player verbs available this leg, beyond the always-on ones. */
  readonly interactions: readonly InteractionDef[];

  /** Terminal commands this leg adds on top of the base shell. */
  readonly terminalCommands: readonly TerminalCommandDef[];

  /** Weighted table the travel loop draws from. Oregon Trail's event deck. */
  readonly eventTable: readonly RandomEventDef[];

  /** Judged when the leg ends. Decides survival, score, and objectives met. */
  evaluate(ctx: LegEvaluationContext): LegOutcome;
}

export interface LegSetupContext {
  readonly run: RunState;
  readonly rng: { next(): number; int(a: number, b: number): number };
  spawn(spec: ProcessSpec): Pid;
  /** Bind a convoy Program to a process so its death is narrative, not statistical. */
  bind(member: ConvoyMemberId, pid: Pid): void;
  declareResource(id: string, instances: number, preemptible: boolean): void;
  declareSync(id: string, kind: 'mutex' | 'semaphore' | 'monitor' | 'rwlock', capacity: number): void;
}

export interface ProcessSpec {
  readonly name: string;
  readonly priority: number;
  readonly burst: number;
  readonly service: number;
  readonly arrival: number;
  readonly pages: number;
  /** Page reference string, if this leg drives memory deterministically. */
  readonly referenceString?: readonly number[];
}

export interface LegEvaluationContext {
  readonly run: RunState;
  readonly kernelSnapshot: KernelSnapshot;
  readonly events: readonly { readonly type: string }[];
  readonly ticksElapsed: number;
}

export interface LegOutcome {
  readonly survived: boolean;
  readonly objectivesMet: readonly string[];
  readonly casualties: readonly ConvoyMemberId[];
  readonly resourceDelta: Partial<ResourceLedger>;
  readonly codexUnlocked: readonly string[];
  /** Shown on the leg-complete card. Explains what the player's choices caused. */
  readonly debrief: DebriefCard;
}

export interface DebriefCard {
  readonly headline: string;
  readonly whatHappened: string;
  readonly whyItHappened: string;
  /** Concrete counterfactual: what the same run looks like under a better policy. */
  readonly counterfactual: string | null;
  readonly chapter: ChapterRef;
}

/* ------------------------------------------------------------------ */
/* Player verbs                                                        */
/* ------------------------------------------------------------------ */

export interface InteractionDef {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Which diegetic object in the 3D world exposes this verb. */
  readonly anchor: string;
  readonly cost: Partial<Record<ResourceKind, number>>;
  readonly enabledWhen: (run: RunState) => boolean;
}

export interface TerminalCommandDef {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  /** Man page text. Written to teach, not merely to document. */
  readonly manual: string;
  readonly chapter: ChapterRef | null;
}

export interface RandomEventDef {
  readonly id: string;
  readonly weight: number;
  readonly title: string;
  readonly narration: string;
  /** Null means it can strike any Program. */
  readonly targets: ConvoyRole | null;
  readonly inflicts: AfflictionId | null;
  readonly resourceDelta: Partial<ResourceLedger>;
  readonly onlyIf: ((run: RunState) => boolean) | null;
}

/* ------------------------------------------------------------------ */
/* Stage handles (implemented in @world, declared here to avoid a cycle) */
/* ------------------------------------------------------------------ */

export interface StageContext {
  readonly quality: 'low' | 'medium' | 'high';
  readonly run: RunState;
}

export interface LegStage {
  /** Called once per rendered frame with interpolated sim time. */
  update(dtSeconds: number, alpha: number): void;
  /** Named anchors interactions and the focus camera can target. */
  anchor(id: string): unknown | null;
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/* Save format                                                         */
/* ------------------------------------------------------------------ */

export interface SaveFile {
  readonly version: 1;
  readonly savedAtIso: string;
  readonly run: RunState;
  readonly kernel: KernelSnapshot | null;
  readonly rngStates: readonly RngState[];
  /** Enough to replay the run from the seed and verify the save was not edited. */
  readonly checksum: string;
}

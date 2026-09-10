# WP-L06: The Gridlock

Leg id `the_gridlock`, index 6. Subtitle: *Nothing is broken. Nothing is moving.*

**Legs are independent and may be built concurrently.** This package touches no other leg,
imports from no other leg, and shares no source file with any other leg.

**This is one of the three high-value packages.** It is the first of the two difficulty spikes.
The spike is structural rather than lexical: eight new terms is not unusual, and the difficulty
is that the leg asks the player to diagnose a failure that produces no error, no damage and no
signal, then choose among four strategies whose costs are paid in different currencies. It is
also the first leg where the correct answer depends on what the player expects to happen later,
since prevention and avoidance are investments. Budget accordingly.

---

## Objective

A module at `src/legs/the_gridlock/` implementing the frozen `Leg` interface, playable end to
end. Four gates stand in a square, each opened by a key held on the far side of the next. Four
Programs, one at each gate, each already holding the key to the gate behind them and waiting for
the one ahead. Beams close between them into a ring. Then nothing happens, and keeps not
happening.

The wait-for graph is a physical ring of light beams between Programs, drawn from
`DeadlockReport.cycle` and labelled with `DeadlockReport.conditions`. The player either runs the
safety algorithm before granting a request, imposes a total order on the four gate resources, or
chooses a victim to derezz to break the cycle.

The leg's data is the sim spec's worked Banker's example, unchanged, so every number the player
sees is verifiable against a known-correct fixture.

---

## Citation corrections

Three section citations in the frozen types do not match the 10th edition. The frozen files stay
exactly as they are. **Use the corrected numbers in every string this leg generates**: man
pages, codex prose, `ChapterRef` values constructed in code, event rationale strings,
`SafetyTraceStep.explanation`, debrief text and epitaph text.

| Location in frozen code | Cited there | Correct for the 10th edition | Used where in this leg |
|---|---|---|---|
| pace to quantum, design brief | 5.3.4 | **5.3.3** | any quantum reference in copy |
| `SafetyCheckResult.sequence` | 8.6.2 | **8.6.1** | the `bankers` man page, `codex.safe_state`, `codex.bankers`, `SafetyTraceStep.explanation` |
| `DeadlockReport.cycle` | 8.3.2 | **8.7.1** | the `wfg` man page, `codex.deadlock_detection`, the cycle label in the world |

`ProcessControlBlock.priority` citing 5.3.4 for "lower number is higher priority" is correct and
stays.

Two places where the distinction matters and is easy to get wrong:

- **8.3.2 is the resource-allocation graph.** That is a real thing this leg draws and cites, and
  it keeps 8.3.2. What must move to 8.7.1 is the **wait-for graph and its cycle test**.
- **8.6.2 is the resource-allocation-graph algorithm** for single-instance types. That also
  stays where it is cited in the chapter list. What must move to 8.6.1 is **safe state and the
  safe sequence**.

Both appear in this leg's chapter array, so read the array below carefully rather than
find-and-replacing.

---

## Prerequisites

**Engine work packages that must be complete and green on the shared branch:**

| Package | Why this leg needs it |
|---|---|
| WP-01 | `Rng`, event bus, canonical serialiser, determinism fixtures. |
| WP-02 | Process table, PCB, `heldResources` and `requestedResources`, kernel step order. |
| WP-03 | Scheduler foundation and the single-queue policies. |
| WP-04 | `priority_aging`, `rr`, `mlfq`. The leg does not teach scheduling and does need the policies to exist. |
| WP-07 | Synchronisation primitives and the wait queues the wait-for graph is built from. |
| **WP-08** | **The whole of it.** Wait-for graph, Banker's safety and request algorithms, detection, victim selection, recovery, and the four strategies. This leg is WP-08's principal consumer. |
| WP-11 | Syscalls, snapshot and restore, the invariant set including I-24. |
| WP-12 | Renderer backend, post chain, design tokens, draw call budget. |
| WP-13 | Focus camera and the diegetic structure base classes. |
| WP-14 | World event router, effect pooling, derezz. `deadlock.detected` and `bankers.evaluated` must have visual treatments. |
| WP-15 | The terminal. |
| WP-17 | HUD, codex, save and load, scoring. |
| WP-18 | The counterfactual replay worker. The debrief replays the crossing under a second strategy. |

**Kernel subsystems that must be working:** `process`, `scheduler`, `sync`, `deadlock`.

WP-08 must provide, exactly:

- `Kernel.evaluateBankers(pid, resource, instances)` returning a `SafetyCheckResult` with a
  full `SafetyTraceStep[]`, without committing.
- `Kernel.detectDeadlock()` returning a `DeadlockReport` or null, with `cycle` rotated to start
  at the lowest pid.
- All four values of `KernelConfig.deadlockStrategy`, switchable mid-run.
- `resource.denied` carrying `reason: 'unsafe'` and `reason: 'unavailable'` as distinct values.
- Resource ranking under `prevent`, refusing an out-of-order acquisition with `EDEADLK` and
  **without blocking**, per fixture `DL-PREVENT-1`, with invariant I-24 holding every tick.
- Victim selection per the §9.6 comparator, with the guarantee that a convoy Program never sorts
  first when a non-convoy process is present.

Fixtures `DL-BANKERS-1` through `DL-BANKERS-5`, `DL-DETECT-1`, `DL-DETECT-2`, `DL-CYCLE-1`,
`DL-CYCLE-2`, `DL-VICTIM-1` and `DL-PREVENT-1` must all pass before this leg starts.

---

## Required reading

- `docs/00-DESIGN-BRIEF.md`, sections 5, 6, 7, 9.
- `docs/05-CURRICULUM-MAP.md`, "Leg 6. THE GRIDLOCK" in full; section 0.1 (the three citation
  corrections); section D (the difficulty curve, specifically "The two spikes" and "Relief
  placement", which explain why leg 5 and leg 7 are shaped the way they are around this one).
- `docs/02-KERNEL-SIM-SPEC.md`, **section 9 in full** (Deadlock, Ch. 8), especially 9.4.1 the
  safety algorithm, 9.4.2 the resource-request algorithm, **9.4.3 the worked example**, and 9.6
  the victim comparator; section 16.8 (the `DL-*` test vectors).
- `docs/04-NARRATIVE-BIBLE.md`, section 12 (critical section crossings; the Gridlock owns two of
  the nine); section 7 entries for `lock_convoy` and `livelock`; section 8 leg 6 event table;
  section 9 epitaphs for `deadlock_victim`; section 5.7 (depot prices, so the gate house toll is
  priced consistently even though leg 6 has no depot).
- `docs/03-VISUAL-BIBLE.md`, section 10 "Leg 6, The Gridlock"; section 8 (motion language, for
  the instant all-edges transition when the ring closes); section 13 (quality tiers).

---

## Frozen contracts

These types are frozen. You may not edit, extend, narrow or re-declare any of them.
A leg that appears to need a contract change stops and escalates, because every other
leg in flight depends on this file. Copy them into your leg only by importing:

```ts
import type { Leg, LegSetupContext, LegStage, LegOutcome /* ... */ } from '@game/types';
import type { KernelConfig, SubsystemId /* ... */ } from '@kernel/types';
```

### The `Leg` interface

```ts
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
```

### Journey identity

```ts
export type LegId =
  | 'boot_sector' | 'fork_fields' | 'the_weave' | 'quantum_pass'
  | 'the_narrows' | 'the_cistern' | 'the_gridlock' | 'allocation_yards'
  | 'drowned_reach' | 'the_platters' | 'the_bus' | 'the_archive'
  | 'arbiter_wall' | 'the_portal';

export const LEG_ORDER: readonly LegId[] = [
  'boot_sector', 'fork_fields', 'the_weave', 'quantum_pass',
  'the_narrows', 'the_cistern', 'the_gridlock', 'allocation_yards',
  'drowned_reach', 'the_platters', 'the_bus', 'the_archive',
  'arbiter_wall', 'the_portal',
] as const;

/** A citation into Silberschatz, Operating System Concepts, 10th edition. */
export interface ChapterRef {
  readonly chapter: number;
  readonly sections: readonly string[];
  readonly title: string;
}

export interface LearningObjective {
  readonly id: string;
  readonly statement: string;
  readonly chapter: ChapterRef;
  readonly assessedBy: 'outcome' | 'decision' | 'terminal_command' | 'survival';
}
```

### Setup and population

```ts
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
```

### Evaluation and outcome

```ts
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
```

### Player verbs

```ts
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
```

### Stage handles

```ts
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
```

### Run state the leg reads but never writes

```ts
export type ConvoyRole = 'compiler' | 'sentinel' | 'codec' | 'courier' | 'cartographer';
export type ConvoyMemberId = 'lumen' | 'sable' | 'orrery' | 'kestrel' | 'vesper';
export type ResourceKind = 'cycles' | 'quota' | 'blocks' | 'bandwidth' | 'integrity';
export type DiscClass = 'shell' | 'daemon' | 'compiler';
export type DifficultyTier = 'novice' | 'operator' | 'architect' | 'kernel_space';
export type Pace = 'conservative' | 'steady' | 'aggressive' | 'reckless';
export type Rations = 'generous' | 'standard' | 'lean' | 'starved';

export interface ResourceLedger {
  cycles: number;   // CPU budget. Spent to travel. Currency at depots.
  quota: number;    // Memory quota in frames. The food.
  blocks: number;   // Storage blocks. Spare parts.
  bandwidth: number;// I/O budget. Caps actions per leg.
}

export interface TravelPolicy {
  pace: Pace;
  rations: Rations;
  degreeOfMultiprogramming: number;
}

export interface RunState {
  readonly runId: string;
  readonly seed: number;
  readonly discClass: DiscClass;
  readonly difficulty: DifficultyTier;
  legIndex: number;
  legProgress: number;
  convoy: ConvoyMember[];
  resources: ResourceLedger;
  policy: TravelPolicy;
  tombstones: Epitaph[];
  codexUnlocked: string[];
  objectivesMet: string[];
  decisions: DecisionRecord[];
  score: ScoreBreakdown;
  status: 'in_progress' | 'complete' | 'failed';
}

export interface DecisionRecord {
  readonly tick: Tick;
  readonly legId: LegId;
  readonly kind: string;
  readonly choice: string;
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

export type AfflictionId =
  | 'priority_inversion' | 'memory_leak' | 'starvation' | 'thrashing'
  | 'lock_convoy' | 'livelock' | 'orphaned' | 'fragmented'
  | 'cache_thrash' | 'bit_rot' | 'stack_overflow' | 'false_sharing'
  | 'interrupt_storm';
```

### The kernel configuration you return

```ts
export interface KernelConfig {
  readonly seed: number;
  readonly scheduler: SchedulerId;
  readonly schedulerParams: SchedulerParams;
  readonly totalFrames: number;
  readonly pageSize: number;
  readonly replacementPolicy: PageReplacementId;
  readonly allocationStrategy: AllocationStrategy;
  readonly tlbEntries: number;
  readonly diskPolicy: DiskSchedulingId;
  readonly totalCylinders: number;
  readonly raidLevel: RaidLevel | null;
  readonly fileAllocation: FileAllocationMethod;
  readonly journalingEnabled: boolean;
  readonly deadlockStrategy: 'ignore' | 'detect' | 'avoid' | 'prevent';
  readonly thrashingThreshold: number;
  readonly enabledSubsystems: readonly SubsystemId[];
}

export type SubsystemId =
  | 'process' | 'scheduler' | 'memory' | 'vm' | 'sync'
  | 'deadlock' | 'storage' | 'io' | 'fs' | 'security';

export interface SchedulerParams {
  quantum: number;
  levelQuanta?: readonly number[];
  agingInterval: number;          // 0 disables aging
  starvationThreshold: number;
  starvationFatalThreshold: number;
  preemptive: boolean;
}

export type SchedulerId = 'fcfs' | 'sjf' | 'srtf' | 'priority' | 'priority_aging' | 'rr' | 'mlfq';
export type PageReplacementId = 'fifo' | 'lru' | 'clock' | 'optimal' | 'lfu' | 'random';
export type AllocationStrategy = 'first_fit' | 'best_fit' | 'worst_fit' | 'buddy';
export type DiskSchedulingId = 'fcfs' | 'sstf' | 'scan' | 'cscan' | 'look' | 'clook';
export type RaidLevel = 0 | 1 | 4 | 5 | 6 | 10;
export type FileAllocationMethod = 'contiguous' | 'linked' | 'indexed' | 'extent';
```

Every field of `KernelConfig` is required, including the ones your leg does not use.
Set the unused ones to the inert defaults given in the Kernel configuration section
below and leave their subsystem out of `enabledSubsystems`. An inert field is never
read, and the smoke test asserts that.


---

## Curriculum

### Chapters

```ts
export const chapters: readonly ChapterRef[] = [
  { chapter: 8, title: 'Deadlocks',
    sections: ['8.1', '8.2', '8.3.1', '8.3.2', '8.4',
               '8.5.1', '8.5.2', '8.5.3', '8.5.4',
               '8.6.1', '8.6.2', '8.6.3',
               '8.7.1', '8.7.2', '8.7.3', '8.8.1', '8.8.2'] },
];
```

Both `8.6.1` and `8.6.2` are present, and both `8.3.2` and `8.7.1` are present. That is correct
and it is not a duplication of the correction. The corrections change **which section a given
sentence cites**, not which sections the leg covers.

### Learning objectives

Copy verbatim into `src/legs/the_gridlock/objectives.ts`.

```ts
export const objectives: readonly LearningObjective[] = [
  {
    id: 'obj.the_gridlock.name_the_condition',
    statement: 'Points at one edge of the live wait-for graph, names which of the four Coffman conditions the chosen remedy removes, and applies a remedy that ends the cycle within 10 ticks.',
    chapter: { chapter: 8, title: 'Deadlocks', sections: ['8.3.1', '8.5.1', '8.5.2', '8.5.3', '8.5.4'] },
    assessedBy: 'terminal_command',
  },
  {
    id: 'obj.the_gridlock.safe_admission',
    statement: 'Runs the safety check before each grant so that every granted request leaves the system in a safe state, ending the leg with zero deadlock.detected events and at most two resource.denied events.',
    chapter: { chapter: 8, title: 'Deadlocks', sections: ['8.6.1', '8.6.3'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.the_gridlock.unsafe_is_not_deadlocked',
    statement: 'Grants a request that produces an unsafe but not deadlocked state only when no safe alternative exists, and records the safe sequence that justified every other admitted grant.',
    chapter: { chapter: 8, title: 'Deadlocks', sections: ['8.6.1'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.the_gridlock.total_ordering',
    statement: 'Imposes a single total order on the four gate resources and holds it across the whole crossing, so circular_wait never appears in any DeadlockReport.',
    chapter: { chapter: 8, title: 'Deadlocks', sections: ['8.5.4'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.the_gridlock.victim_selection',
    statement: 'When detection fires, selects the victim with the lowest rollback cost rather than the lowest priority, keeping total lost work under 40 ticks.',
    chapter: { chapter: 8, title: 'Deadlocks', sections: ['8.8.2'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.the_gridlock.preempt_safely',
    statement: 'Spends SABLE shield only on a resource whose holder can be rolled back, so the preemption produces no storage_corruption event.',
    chapter: { chapter: 8, title: 'Deadlocks', sections: ['8.5.3', '8.8.1'] },
    assessedBy: 'survival',
  },
  {
    id: 'obj.the_gridlock.detection_interval',
    statement: 'Sets the detection interval so the algorithm runs at most once per 25 ticks and still reports every cycle before any participant reaches its starvation threshold.',
    chapter: { chapter: 8, title: 'Deadlocks', sections: ['8.7.3'] },
    assessedBy: 'decision',
  },
];
```

### Codex entries this leg adds to `codexUnlocked`

`codex.coffman`, `codex.resource_allocation_graph`, `codex.deadlock_prevention`,
`codex.safe_state`, `codex.bankers`, `codex.deadlock_detection`, `codex.deadlock_recovery`,
`codex.deadlock_handling`.

| Entry | Added when | Citation in its prose |
|---|---|---|
| `codex.coffman` | The first `wfg --explain` on any edge, or the first `deadlock.detected`. | 8.3.1, 8.5.1 to 8.5.4 |
| `codex.resource_allocation_graph` | The player opens the graph at the gate house. | 8.3.2 |
| `codex.deadlock_prevention` | First `resources --rank`. | 8.5.4 |
| `codex.safe_state` | First `bankers --check` returning safe, or the first `resource.denied { reason: 'unsafe' }`. | **8.6.1** |
| `codex.bankers` | First `bankers --state`. Carries this leg's four matrices as its worked example. | 8.6.3, with the safe sequence cited to **8.6.1** |
| `codex.deadlock_detection` | First `deadlock.detected` event under `detect`. | **8.7.1** for the cycle test, 8.7.3 for interval tuning |
| `codex.deadlock_recovery` | First victim selection. | 8.8.1, 8.8.2 |
| `codex.deadlock_handling` | The gate house strategy selector is first opened. | 8.1, 8.4 |

`codex.dining_philosophers` is **not** added here; leg 5 owns it. This leg registers a
forward cross-link into it, and the Gridlock's opening card names the Cistern ring by tick
number. Read that tick from `RunState.decisions` where leg 5 recorded it with
`kind: 'ring_closed'`. If the entry is absent, because the player broke the ring, the opening
card says so instead and names the option they used.

### Misconceptions this leg must break

**"A deadlock is a crash, or a hang the system will notice and report."** Students expect an
error message. The break is the leg's opening 60 ticks under `ignore`: everything is healthy.
`ps` shows four Programs in `waiting`, which is a normal state they have seen a dozen times.
`top` shows 0 percent processor use, which reads as an idle system. The terminal responds
instantly. No event fires, because `deadlock.detected` only fires under `detect`, and the player
has not turned it on. The player has to notice that the travel meter is draining and nothing
else is changing, and then go and build the wait-for graph themselves.

Build requirements:
- The leg opens under `deadlockStrategy: 'ignore'`. Not `detect`.
- For the first 60 ticks nothing in the HUD, the world or the terminal reports anything unusual.
  The stele stay lit. No amber, no warning, no sound cue beyond the ambient. Diagnosing by
  absence is the skill and the leg refuses to hand it over.
- The only moving thing is the travel meter, and it is already on screen for other reasons.
- `wfg` is available from tick 0 and nothing points at it.

**"Unsafe means deadlocked."** The banker's refusals feel arbitrary until this is broken, and
students who believe it conclude that avoidance is simply detection done earlier. The break is a
scripted grant at the third gate: the player is offered a request that `bankers --check` calls
unsafe, and if they grant it anyway, it completes fine, and so does the next one, and the
crossing finishes. Then `bankers --sequence` shows that no safe sequence existed at any point
during that stretch, so the system had no guarantee and got away with it. The debrief replays
the same grant on a seed where the maximum claims are actually exercised and it deadlocks.

Build requirements:
- The scripted unsafe grant is `DL-BANKERS-4`: from the state after `DL-BANKERS-2`, P0 requests
  (0, 2, 0). Under `avoid` this is denied unsafe, rolled back, with a trace ending
  `candidate: null, admitted: false` and a stuck set of all five processes.
- The player must be able to override the denial. Under `detect` or `ignore` the same request is
  granted and the crossing completes, because P0 and P2 never actually exercise their declared
  maximums on this seed.
- `bankers --sequence` after the override returns null for every tick of that stretch, and the
  world's safe-sequence display shows an empty ordering rather than an error.
- The debrief's counterfactual re-runs the identical decision on the sibling seed where the
  maximums are exercised, through WP-18's replay worker, and it deadlocks. Do not simulate this
  with a text template; run it.

**"Prevention is strictly better than the alternatives, so a well-built system prevents
deadlock."** This is what the ordering of the textbook chapter suggests to a student skimming
it. The break is a direct measurement the leg forces: the crossing must be run under two
strategies, because the gate house charges a toll that makes a single strategy insufficient for
the full width. Ordering-based prevention completes the crossing in 340 ticks with all Programs
alive. Avoidance completes it in 245 with all Programs alive and two denied requests. Both are
correct, one is 40 percent slower, and the slower one is the one students name as the right
answer on a written exam. The debrief prints both times.

Build requirements:
- The gate house toll is structural: the crossing is two halves, and the strategy selector
  charges cycles per change, so the player commits a strategy per half and cannot run one
  strategy for both without paying a width penalty that makes the leg unfinishable at steady
  pace. Price the toll from the depot scaling function at `legIndex: 6` so it is consistent with
  the economy even though there is no depot here.
- 340 and 245 are **frozen fixtures**. Tune the crossing so that at steady pace, on the golden
  seed, prevention takes 340 ticks and avoidance takes 245, both with zero casualties. Freeze
  them once the first correct implementation establishes them, and quote them in the debrief.
- Prevention's cost is the concurrency loss stated in the `resources` man page: "On this
  crossing that loss is about 40 percent of the segment." 340 against 245 is 38.8 percent
  slower, which is what "about 40 percent" has to mean. If your tuning drifts, fix the tuning.

---

## Kernel configuration

```ts
export function kernelConfig(run: RunState): KernelConfig {
  return {
    seed: run.seed,
    scheduler: 'rr',                       // round robin: the leg is not about scheduling and rr keeps the four gate holders interleaving visibly
    schedulerParams: {
      quantum: quantumForPace(run.policy.pace),  // Ch. 5.3.3
      agingInterval: 0,                    // aging would rescue a cycle participant by accident; it must not
      starvationThreshold: 120,            // a cycle participant crosses this before it dies; the detection interval objective is measured against it
      starvationFatalThreshold: 300,
      preemptive: true,
    },
    totalFrames: 64,                       // inert: 'memory' is not enabled
    pageSize: 4096,                        // inert
    replacementPolicy: 'lru',              // inert
    allocationStrategy: 'first_fit',       // inert
    tlbEntries: 16,                        // inert
    diskPolicy: 'look',                    // inert
    totalCylinders: 200,                   // inert
    raidLevel: null,                       // inert
    fileAllocation: 'indexed',             // inert
    journalingEnabled: false,              // inert, AND load-bearing: the archive write lock preemption corrupts unrecoverably
    deadlockStrategy: 'ignore',            // THE ENTRY VALUE IS DELIBERATE. See misconception one.
    thrashingThreshold: 200,               // inert
    enabledSubsystems: ['process', 'scheduler', 'sync', 'deadlock'],
  };
}
```

`enabledSubsystems` is `['process', 'scheduler', 'sync', 'deadlock']`. `sync` is present because
the wait-for graph is built from the sync subsystem's wait queues and because the leg owns two
of the nine critical section crossings. Nothing else is enabled.

Three entry values carry the leg's teaching and must not be tidied away:

- `deadlockStrategy: 'ignore'` on entry. A player who never opens the gate house watches the
  convoy stop for no stated reason.
- `agingInterval: 0`. Aging would raise a cycle participant's priority and, under some
  schedulers, change which process the recovery step picks. The cycle must be broken by a
  deadlock decision, not by an unrelated scheduling one.
- `journalingEnabled: false`. SABLE's shield on the archive write lock corrupts the partial
  write, producing `fs.corruption` with `recoverable: false` and a `storage_corruption` death
  later in the Archive. With journaling on, that corruption would be recoverable and the third
  wrong remedy would lose its consequence. Leg 11 decides recoverability; this leg only has to
  leave the corruption unjournaled.

`deadlockStrategy` is the one field the player writes directly. Every change goes through
`resources --strategy` or the gate house selector, is recorded in the decision log, and costs
cycles.

---

## Population

The leg's resource data **is** the sim spec's worked example from §9.4.3, mapped onto the four
gates plus one non-gate resource. Using the textbook's own matrices means every number the
player sees is checkable against `DL-BANKERS-1` through `DL-BANKERS-5`.

### The processes

```ts
export function populate(ctx: LegSetupContext): void {
  // The convoy. Four of the five stand at the four gates; VESPER surveys.
  const roster: readonly [ConvoyMemberId, string, number, number, number][] = [
    // member,      name,      priority, burst, service
    ['lumen',   'LUMEN',   2, 6, 62],
    ['sable',   'SABLE',   2, 5, 56],   // the shield holder; the only way to break a ring without a loss
    ['orrery',  'ORRERY',  3, 5, 56],
    ['kestrel', 'KESTREL', 3, 4, 50],
    ['vesper',  'VESPER',  3, 5, 56],
  ];
  roster.forEach(([member, name, priority, burst, service], i) => {
    const pid = ctx.spawn({ name, priority, burst, service, arrival: i, pages: 6 });
    ctx.bind(member, pid);
  });

  // The five banker's processes, P0 to P4, in the fixture's order. These are the junction's
  // own traffic and they are what the matrices describe.
  const bankers: readonly [string, number, number, number][] = [
    // name,             priority, burst, service
    ['junction.p0',      4, 4, 70],
    ['junction.p1',      4, 3, 60],
    ['junction.p2',      4, 5, 80],
    ['junction.p3',      4, 3, 55],
    ['junction.p4',      4, 4, 65],
  ];
  bankers.forEach(([name, priority, burst, service], i) => {
    ctx.spawn({ name, priority, burst, service, arrival: 4 + i * 2, pages: 4 });
  });

  // The four gate resources, three instances of the first three types and two of the fourth,
  // matching the fixture's A = 10, B = 5, C = 7 split across the gates. See the mapping table.
  ctx.declareResource('gate_a', 10, false);  // A. Not preemptible: a gate key cannot be taken back
  ctx.declareResource('gate_b',  5, false);  // B
  ctx.declareResource('gate_c',  7, false);  // C
  ctx.declareResource('gate_d',  4, true);   // the ONLY preemptible gate. SABLE's shield target.
  // The trap. Preemptible in the type system and NOT rollbackable in fact.
  ctx.declareResource('archive_write_lock', 1, true);

  // The two critical section crossings this leg owns.
  ctx.declareSync('lock.junction_ledger', 'mutex',     1);
  ctx.declareSync('sem.gatehouse',        'semaphore', 2);
}
```

### The Banker's matrices, verbatim from §9.4.3

Five processes P0 to P4, three resource types A, B and C with 10, 5 and 7 instances. These are
`gate_a`, `gate_b` and `gate_c`. `gate_d` is outside the matrices and exists only as the
preemptible resource SABLE's shield can legally target.

**Allocation:**

| | A | B | C |
|---|---|---|---|
| P0 | 0 | 1 | 0 |
| P1 | 2 | 0 | 0 |
| P2 | 3 | 0 | 2 |
| P3 | 2 | 1 | 1 |
| P4 | 0 | 0 | 2 |

**Max:**

| | A | B | C |
|---|---|---|---|
| P0 | 7 | 5 | 3 |
| P1 | 3 | 2 | 2 |
| P2 | 9 | 0 | 2 |
| P3 | 2 | 2 | 2 |
| P4 | 4 | 3 | 3 |

**Need, which is Max minus Allocation:**

| | A | B | C |
|---|---|---|---|
| P0 | 7 | 4 | 3 |
| P1 | 1 | 2 | 2 |
| P2 | 6 | 0 | 0 |
| P3 | 0 | 1 | 1 |
| P4 | 4 | 3 | 1 |

**Available is (3, 3, 2).** Check: allocated totals are A = 7, B = 2, C = 5, and 10 - 7 = 3,
5 - 2 = 3, 7 - 5 = 2.

**Safety trace, ascending-first-match:**

| Step | Candidate | Need | Work before | Work after |
|---|---|---|---|---|
| 1 | P1 | (1,2,2) | (3,3,2) | (5,3,2) |
| 2 | P3 | (0,1,1) | (5,3,2) | (7,4,3) |
| 3 | P0 | (7,4,3) | (7,4,3) | (7,5,3) |
| 4 | P2 | (6,0,0) | (7,5,3) | (10,5,5) |
| 5 | P4 | (4,3,1) | (10,5,5) | (10,5,7) |

**The state is safe. Safe sequence `<P1, P3, P0, P2, P4>`.** Fixture `DL-BANKERS-1`.

The textbook prints `<P1, P3, P4, P0, P2>`, which is also safe. Both are correct. The
simulator's ascending-first-match rule selects P0 at step 3 because P0's need (7,4,3) fits Work
(7,4,3) exactly and P0 has a lower index than P4. **A test that asserts the textbook's sequence
instead of the simulator's is testing the wrong thing.** `DL-BANKERS-1A` asserts that the
textbook sequence is also safe by running the safety check with a forced admission order, and
this leg must expose that forced-order path so `bankers --sequence` can show a player who has
read the book that their answer is not wrong.

### The three scripted requests

These are the leg's three decision points at the gates, in order.

**Request 1, at gate two: P1 requests (1, 0, 2).** Fixture `DL-BANKERS-2`.

- Step 1: `(1,0,2) <= Need[P1] = (1,2,2)`. Passes.
- Step 2: `(1,0,2) <= Available = (3,3,2)`. Passes.
- Step 3, tentative: `Available = (2,3,0)`, `Allocation[P1] = (3,0,2)`, `Need[P1] = (0,2,0)`.
- Step 4 safety trace:

| Step | Candidate | Need | Work before | Work after |
|---|---|---|---|---|
| 1 | P1 | (0,2,0) | (2,3,0) | (5,3,2) |
| 2 | P3 | (0,1,1) | (5,3,2) | (7,4,3) |
| 3 | P0 | (7,4,3) | (7,4,3) | (7,5,3) |
| 4 | P2 | (6,0,0) | (7,5,3) | (10,5,5) |
| 5 | P4 | (4,3,1) | (10,5,5) | (10,5,7) |

**Safe. Granted.** Safe sequence `<P1, P3, P0, P2, P4>`.

**Request 2, at gate three: P4 requests (3, 3, 0).** Fixture `DL-BANKERS-3`.

Step 2 fails: `Available = (2,3,0)` and `3 > 2` in column A. **Denied, `EAGAIN`,
`resource.denied { reason: 'unavailable' }`.** This denial has nothing to do with safety. The
resources simply are not there, and the event carries `'unavailable'` rather than `'unsafe'` so
the codex can distinguish the two. The gate house must display the two denial reasons with
different words and never collapse them into "denied".

**Request 3, at gate three: P0 requests (0, 2, 0).** Fixture `DL-BANKERS-4`. This is the
scripted unsafe grant and it is the second misconception's whole break.

- Step 1: `(0,2,0) <= Need[P0] = (7,4,3)`. Passes.
- Step 2: `(0,2,0) <= Available = (2,3,0)`. Passes.
- Step 3, tentative: `Available = (2,1,0)`, `Allocation[P0] = (0,3,0)`, `Need[P0] = (7,2,3)`.
- Step 4: no candidate's Need fits Work (2,1,0). The trace ends with
  `candidate: null, admitted: false` and a stuck set of {P0, P1, P2, P3, P4}.

**Denied unsafe under `avoid`, rolled back exactly, `resource.denied { reason: 'unsafe' }`.**
Under `detect` or `ignore` the same request is granted and the crossing finishes, because P0 and
P2 do not exercise their declared maximums on the golden seed.

**A fourth request the player can attempt and should not: P1 requests (2, 0, 0) with
Need[P1] = (1,2,2).** Fixture `DL-BANKERS-5`. `EINVAL`, exceeds the declared maximum. The gate
house must say so in those words, because "you asked for more than you said you would ever need"
is a different failure from both denials above and the player has to be able to tell three
things apart.

### The detection set

The four-gate ring is the leg's own structure and is separate from the banker's five. Use
`DL-DETECT-1` and `DL-DETECT-2` as the detection segment's data.

`DL-DETECT-1`: A/B/C totals 7/2/6. Allocation rows (0,1,0), (2,0,0), (3,0,3), (2,1,1), (0,0,2).
Request rows (0,0,0), (2,0,2), (0,0,0), (1,0,0), (0,0,2). Available (0,0,0). **No deadlock.**
Finish order P0, P2, P1, P3, P4. Final Work (7,2,6).

`DL-DETECT-2`: the same, with P2's request changed to (0,0,1). **Deadlocked set
{P1, P2, P3, P4}.** Only P0 finishes. Work stops at (0,1,0).

The distinction between these two is the leg's sharpest single teaching moment after the silent
ring, because the two states differ by one instance of one resource type. Put them adjacent: the
detection segment runs `DL-DETECT-1` first, the player runs `wfg` and finds nothing, then one
request changes and `DL-DETECT-2` holds. Nothing else about the world changes.

`DL-CYCLE-1`: a wait-for graph P1 to P2 to P3 to P1 yields cycle `[1, 2, 3]`, rotated to start
at the lowest pid. The world's beam ring must be drawn in that rotation so the graph and the
picture agree.

### The four-gate ring itself

Four gates in a square. Four Programs, one at each. Each holds the key to the gate behind and
requests the one ahead:

| Program | Holds | Requests | Coffman condition its edge demonstrates |
|---|---|---|---|
| `junction.p1` | `gate_a` | `gate_b` | `hold_and_wait` |
| `junction.p2` | `gate_b` | `gate_c` | `no_preemption` |
| `junction.p3` | `gate_c` | `gate_d` | `mutual_exclusion` |
| `junction.p4` | `gate_d` | `gate_a` | `circular_wait` |

`DeadlockReport.conditions` carries all four and `wfg --explain <edge>` names the one that edge
demonstrates. `obj.the_gridlock.name_the_condition` is met when the named condition matches the
one the applied remedy actually removes, so the mapping above must be the mapping WP-08 produces
and not a leg-local table. Assert equality with `detectDeadlock().conditions`.

### The victim comparator data

`DL-VICTIM-1` requires a cycle of three with distinct priorities, distinct `totalCpuUsed` and
distinct held counts, and asserts that `suggestedVictims[0]` matches the §9.6 comparator and
that a convoy Program never sorts first when a non-convoy process is present.

Set the junction processes' `totalCpuUsed` at the moment the ring closes so that the lowest
rollback cost and the lowest priority are **different processes**. That is the whole of
`obj.the_gridlock.victim_selection`: the player who picks by priority picks wrong. Freeze the
values once established:

| Process | Priority | `totalCpuUsed` at ring close | Held instances | Rollback cost |
|---|---|---|---|---|
| `junction.p1` | 4 | high | 2 | high |
| `junction.p2` | 6 | low | 1 | **lowest** |
| `junction.p3` | 4 | medium | 2 | medium |
| `junction.p4` | 8 | high | 1 | high |

`junction.p4` has the lowest priority and `junction.p2` has the lowest rollback cost. Total lost
work under 40 ticks is achievable only by choosing `junction.p2`.

---

## Stage

**Form.** The wait-for graph, as a ring of beams between stele.
**Accent.** `AMBER.core`, the most amber-dominant leg in the game.
**Environment.** An interchange: multiple lanes of convoy traffic crossing at a junction of
resource rings, everything stalled, everything still lit.
**Hero visual.** The cycle closing. Beams accumulate one at a time as processes block, and the
instant `deadlock.detected` fires and the last edge completes the ring, every beam in the cycle
goes from `blocked` amber to `denied` amber at `critical` gain simultaneously, and the ring
holds, motionless and bright. The four Coffman conditions are labelled on the four edges that
demonstrate them, from `DeadlockReport.conditions`.

Under `ignore` the last edge still closes and the beams do **not** change gain, because no report
fired. That difference is the first misconception, drawn: the same physical arrangement, with
and without the system noticing.

| Anchor id | Structure | Focus camera target |
|---|---|---|
| `anchor.interchange` | The whole junction, several lanes crossing | wide establishing; the ring hero shot frames from here, overhead |
| `anchor.ring` | The four-gate square with the beam ring between the four Programs | **overhead orthographic**, matching leg 5's ring composition exactly |
| `anchor.gate.a` … `anchor.gate.d` | The four gates, each with its key visibly held on the far side of the next | head-on per gate; the key and the requester both in frame |
| `anchor.edge.<from>_<to>` | One anchor per wait-for edge, created and destroyed as edges form and clear | head-on; the edge's Coffman label legible |
| `anchor.gate_house` | The strategy selector: ignore, detect, avoid, prevent, each with its cost posted | head-on orthographic; all four strategies and their costs in one frame |
| `anchor.matrix_board` | The four Banker's matrices drawn as a physical index board: available, max, allocation, need | head-on orthographic; this is the leg's most important lock and all four matrices must be legible at once |
| `anchor.sequence_rail` | The safe sequence drawn as an ordered rail of five markers, empty when no safe sequence exists | head-on; the empty state must read as empty rather than as broken |
| `anchor.rank_posts` | The four rank posts under `prevent`, numbered, with the acquisition order carved | head-on |
| `anchor.detection_sweep` | The detection sweep, drawn as a rotating scan bar over the junction at the configured interval | included in the establishing shot; the interval must be readable from the sweep rate |
| `anchor.shield` | SABLE's shield target selector, listing each resource's `preemptible` flag | head-on; the flag and the rollback truth are different columns |
| `anchor.travel_meter` | The convoy's travel meter, the only moving thing during the silent 60 ticks | always visible |
| `anchor.convoy.<member>` | Per-Program stele | head-on |

### Two hard stage requirements

**The silent 60 ticks.** From leg entry to tick 60, nothing at `anchor.interchange` changes
except the travel meter. The four stele stay at `nominal` gain. No beam is amber. No audio cue
fires beyond the ambient bed. The HUD shows four Programs in `waiting`, which the player has
seen a dozen times, and the processor at 0 percent, which reads as idle. This is the hardest
thing in the leg to hold, because every instinct in the render layer is to signal. Hold it.

**The matrix board.** Four matrices, drawn as physical index boards, all four legible in one
orthographic lock. Available is one row of three. Max, Allocation and Need are five rows of
three each. A safety check animates as a scan down the Need board with the Work row updating
beside it, one step per `SafetyTraceStep`, and each step's `explanation` string is drawn beside
the row it concerns. The player must be able to watch the algorithm run rather than read that it
ran. `bankers.evaluated` carries the full result, so the world layer needs nothing else.

---

## Interactions

```ts
export const interactions: readonly InteractionDef[] = [
  {
    id: 'gridlock.set_strategy',
    label: 'Set the deadlock strategy',
    description: 'Ignore, detect, avoid, or prevent. There is no free option. Pick the one whose cost you can afford on this crossing.',
    anchor: 'anchor.gate_house',
    cost: { cycles: 12 },
    enabledWhen: (run) => run.resources.cycles >= 12,
  },
  {
    id: 'gridlock.run_safety_check',
    label: 'Run the safety check',
    description: 'Test one hypothetical grant against every process remaining need. Prints the safe sequence if one exists.',
    anchor: 'anchor.matrix_board',
    cost: { bandwidth: 3 },
    enabledWhen: (run) => run.resources.bandwidth >= 3,
  },
  {
    id: 'gridlock.grant_request',
    label: 'Grant this request',
    description: 'Hand over the instances asked for. Under avoid this runs the safety check first and may refuse.',
    anchor: 'anchor.gate_house',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'gridlock.override_denial',
    label: 'Grant it anyway',
    description: 'Grant a request the safety check called unsafe. Unsafe and deadlocked are different states.',
    anchor: 'anchor.gate_house',
    cost: { cycles: 8 },
    enabledWhen: (run) => run.resources.cycles >= 8,
  },
  {
    id: 'gridlock.rank_resource',
    label: 'Rank this resource',
    description: 'Assign a number. Any process taking more than one must take them in increasing order.',
    anchor: 'anchor.rank_posts',
    cost: { cycles: 6 },
    enabledWhen: (run) => run.resources.cycles >= 6,
  },
  {
    id: 'gridlock.set_detection_interval',
    label: 'Set the detection interval',
    description: 'How often the cycle test runs. Running it every tick finds everything and costs a sweep every tick.',
    anchor: 'anchor.detection_sweep',
    cost: { cycles: 6 },
    enabledWhen: (run) => run.resources.cycles >= 6,
  },
  {
    id: 'gridlock.choose_victim',
    label: 'Choose a victim',
    description: 'End one Program in the cycle and the cycle opens. The work it had done is lost with it.',
    anchor: 'anchor.ring',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'gridlock.spend_shield',
    label: 'Spend SABLE shield',
    description: 'Make one resource preemptible for 20 ticks. Read whether its holder can be rolled back before you choose.',
    anchor: 'anchor.shield',
    cost: { bandwidth: 8 },
    enabledWhen: (run) => sableAlive(run) && run.resources.bandwidth >= 8,
  },
  {
    id: 'gridlock.restart_crossing',
    label: 'Restart the crossing',
    description: 'Back everyone out and try again.',
    anchor: 'anchor.interchange',
    cost: { cycles: 20 },
    enabledWhen: (run) => run.resources.cycles >= 20,
  },
];
```

`gridlock.restart_crossing` is offered and does nothing useful. The same order produces the same
cycle, deterministically, which the player can verify with `trace --replay`. That is the second
of the three instructive wrong remedies and its availability is the point.

Costs above are `operator` values; scale with `tierFactor` (novice 0.80, operator 1.00,
architect 1.15, kernel_space 1.35) and with the `legIndex: 6` distance factor
`1 + 0.09 * 6 = 1.54` where the economy applies it.

---

## Terminal commands

Three commands, copied verbatim from the curriculum map into
`src/legs/the_gridlock/commands.ts`: `wfg`, `bankers`, `resources`. The full `manual` text is in
`docs/05-CURRICULUM-MAP.md`, "Leg 6. THE GRIDLOCK". Copy byte for byte; a test asserts the match
against a checked-in fixture.

**One deliberate edit, and only one.** The manual text as printed in the curriculum map contains
no explicit section numbers, so the citation corrections do not change any manual string. They
change the `chapter` field on each `TerminalCommandDef`:

```ts
// wfg
chapter: { chapter: 8, title: 'Deadlocks', sections: ['8.3.1', '8.3.2', '8.7.1'] },
// bankers
chapter: { chapter: 8, title: 'Deadlocks', sections: ['8.6.1', '8.6.3'] },
// resources
chapter: { chapter: 8, title: 'Deadlocks', sections: ['8.1', '8.4', '8.5.4', '8.7.3'] },
```

Those are already the corrected values in the curriculum map. Use them exactly. If your copy
carries 8.6.2 on `bankers` or 8.3.2 alone on `wfg`, you have an old copy.

Load-bearing lines you must not lose in transcription:

- `wfg`: "The wait-for graph is a collapsed form of the resource-allocation graph, and the
  collapse is only valid when every resource type has exactly one instance." This is why the leg
  has both a single-instance ring and a multi-instance banker's set, and why the player needs
  both tools.
- `wfg`: "Notice what a deadlock does not look like. No process has failed. No error has been
  raised. Processor use is low because there is nothing to run, which reads as an idle system
  rather than a broken one. Deadlock is diagnosed by noticing an absence, and this graph is how
  you make the absence visible." That paragraph is the first misconception's answer and the
  player will only find it if they go looking, which is correct.
- `bankers`: "Read that last clause again, because it is the part that feels wrong. The banker
  refuses requests it could satisfy."
- `bankers`: "Safe, unsafe and deadlocked are three states, not two. Every deadlocked state is
  unsafe. Most unsafe states are not deadlocked and never become deadlocked, because processes
  usually do not request their full declared maximum."
- `resources`: "Prevention converts a deadlock risk into a certain loss of concurrency. On this
  crossing that loss is about 40 percent of the segment."
- `resources`: "There is no free option. Pick the one whose cost you can afford on this
  crossing."

### `wfg --explain` implementation contract

`wfg --explain <edge>` takes an edge identifier of the form `<from>-<to>` and returns:

1. The two pids and the resource the edge is about.
2. Which of the four `CoffmanCondition` values that edge demonstrates, read from
   `DeadlockReport.conditions` and never from a leg-local table.
3. One sentence naming the remedy that removes that condition, without naming a button.
4. The cost of that remedy in the currency it is paid in.

`obj.the_gridlock.name_the_condition` requires a `wfg --explain` invocation whose named condition
matches the condition the **applied remedy actually removes**, followed by the cycle clearing
within 10 ticks. So the leg must maintain a mapping from remedy to condition removed:

| Remedy | Condition removed |
|---|---|
| `resources --rank` and a total order held | `circular_wait` |
| SABLE's shield making a resource preemptible | `no_preemption` |
| Requiring all resources acquired at once at the gate house | `hold_and_wait` |
| Routing through the monitor, so the resource is shareable for the duration | `mutual_exclusion` |

Choosing a victim removes nothing. It ends the cycle by ending a participant, and
`wfg --explain` must say so rather than naming a condition, because a player who believes
termination "removes circular wait" has the wrong model.

---

## Event table

Copied verbatim from `04-NARRATIVE-BIBLE.md` section 8, leg 6. Weights sum to 100.

```ts
export const gridlockEvents: readonly RandomEventDef[] = [
  {
    id: 'gridlock.circular_wait',
    weight: 13,
    title: 'The Ring Closes',
    narration: 'Four Programs each hold one resource and request the next one around. Every one of them is behaving correctly and the ring will not open on its own.',
    targets: null, inflicts: 'livelock',
    resourceDelta: { cycles: -55 },
    onlyIf: null,
  },
  {
    id: 'gridlock.hold_and_wait',
    weight: 12,
    title: 'Held Across a Wait',
    narration: 'A Program acquires the first resource, then blocks on the second while still holding the first. Everything behind it inherits the wait.',
    targets: null, inflicts: 'lock_convoy',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'gridlock.victim_selected',
    weight: 12,
    title: 'Victim Selected',
    narration: 'The detector finds the cycle and terminates the process with the least accumulated work. The convoy loses the frames that process was holding on their behalf.',
    targets: null, inflicts: null,
    resourceDelta: { quota: -75 },
    onlyIf: null,
  },
  {
    id: 'gridlock.rollback',
    weight: 11,
    title: 'Rolled Back',
    narration: 'Recovery unwinds a transaction to its last safe point and the work between here and there is discarded. The blocks it wrote are freed and their contents are not.',
    targets: null, inflicts: null,
    resourceDelta: { blocks: -20 },
    onlyIf: null,
  },
  {
    id: 'gridlock.bankers_refusal',
    weight: 13,
    title: 'Request Denied As Unsafe',
    narration: 'The convoy asks for two more instances and the safety check refuses, because granting them leaves no sequence in which everyone finishes. The refusal costs time and it is the reason the convoy is still moving.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -30, bandwidth: -3 },
    onlyIf: null,
  },
  {
    id: 'gridlock.preemptible_found',
    weight: 15,
    title: 'Preemptible Instance',
    narration: 'One resource type at the junction can be taken back from its holder without corrupting it. SABLE marks it, because that is the one that breaks a ring.',
    targets: 'sentinel', inflicts: null,
    resourceDelta: { blocks: 22, cycles: 25 },
    onlyIf: null,
  },
  {
    id: 'gridlock.wfg_survey',
    weight: 12,
    title: 'Graph Survey',
    narration: 'A survey post publishes the current wait-for graph for the whole junction, updated every tick. There is one cycle in it and it does not include the convoy.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 45, bandwidth: 6 },
    onlyIf: null,
  },
  {
    id: 'gridlock.ordered_cairn',
    weight: 12,
    title: 'Ordered Cairn',
    narration: 'Someone numbered every resource at this junction and left the ordering carved where it can be read. Acquire in increasing order and no ring can form.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 60 },
    onlyIf: null,
  },
];
```

`gridlock.wfg_survey` must draw a real cycle from a real `detectDeadlock()` call on a real
secondary set of processes. It is the one event in this leg that shows the player a cycle that
is not theirs, and if it is faked the player who runs `wfg` after reading it will find nothing
and learn the wrong thing.

`gridlock.preemptible_found` marks `gate_d`, which is the one resource whose `preemptible` flag
is true **and** whose holder can genuinely be rolled back. It must not mark
`archive_write_lock`, whose flag is also true and whose holder cannot. That difference is
`obj.the_gridlock.preempt_safely`.

---

## Evaluation

### Survival

The leg is survived when at least one convoy Program is alive at leg end.

**The failure is that the convoy stops.** That is the failure, and its horror is that it is not
an error. Under `deadlockStrategy: 'ignore'` the four Programs hold `waiting` indefinitely, the
leg's travel budget drains, and each acquires `lock_convoy` (2 integrity per travel tick, fatal
after 50 in this leg's instance; the ambient table value of 0.6 per tick with no fatal clock is
the out-of-leg baseline and this leg overrides it). At zero integrity they derezz with
`TerminationReason: 'deadlock_victim'`.

The epitaph cause line reads exactly:

> "it held gate two and waited for gate three. Three held three and waited for four. Nothing
> failed. Every Program was doing exactly what it was told, in a circle."

`codexEntry` is `codex.coffman`.

### The three instructive wrong remedies

All three are available and all three must behave exactly as specified.

**1. Killing a Program in the cycle.** This does break it, immediately, and it is the correct
emergency action. It is also the most expensive one, because the killed Program is gone
permanently. Record it as `outcome: 'costly'` rather than `'fatal'`, and have the debrief show
the avoidance run on the same seed finishing with four survivors. The avoidance run is a real
WP-18 replay, not a claim.

**2. Restarting the crossing.** This does nothing. The same order produces the same cycle,
deterministically, which the player can verify with `trace --replay`. The restart costs 20
cycles and the ring closes again at the same relative tick. Assert this: two restarts produce
three byte-identical cycle formations.

**3. SABLE's shield on a non-rollbackable resource.** Spending the shield on
`archive_write_lock` preempts it successfully and corrupts the partial write, producing
`fs.corruption` with `recoverable: false` and a `storage_corruption` death later in the Archive.
Preemption is only safe when the holder's state can be restored, and the leg makes the player
find the edge of that rule.

The trap's shape matters: `archive_write_lock` is declared with `preemptible: true`. The type
system says it can be preempted. The world says so too, on the shield selector. What the shield
selector must **also** show, in a separate column, is whether the holder can be rolled back, and
for `archive_write_lock` that column reads no. A player who reads only the `preemptible` flag
walks into it. That is a fair trap because both columns are visible before the spend.

Record the corruption in the leg outcome for leg 11 to read, the same way leg 4 records its
corrupted manifest. Agree the field with WP-17.

### Objectives

| Objective | Computed from |
|---|---|
| `obj.the_gridlock.name_the_condition` | A `wfg --explain <edge>` invocation whose named `CoffmanCondition` matches the condition the applied remedy actually removes, per the remedy-to-condition table, followed by `detectDeadlock()` returning null within 10 ticks. |
| `obj.the_gridlock.safe_admission` | Zero `deadlock.detected` events across the leg **and** at most two `resource.denied` events carrying `reason: 'unsafe'`. Denials carrying `'unavailable'` do not count against this. |
| `obj.the_gridlock.unsafe_is_not_deadlocked` | For every admitted grant, a `bankers.evaluated` event with `result.safe === true` precedes it in the log, **except** where the player used `gridlock.override_denial` and `bankers --sequence` returned null for every alternative ordering at that tick. |
| `obj.the_gridlock.total_ordering` | Every `resource.granted` sequence per pid has monotonically increasing rank, **and** `circular_wait` appears in no `DeadlockReport` across the leg. Poll `detectDeadlock()` rather than counting events, because under `prevent` no report ever fires. |
| `obj.the_gridlock.victim_selection` | The chosen victim's `totalCpuUsed` at the moment of choice is the minimum among the cycle's participants, **and** summed lost work across all victim choices is under 40 ticks. |
| `obj.the_gridlock.preempt_safely` | Every `gridlock.spend_shield` targeted a resource whose holder was rollbackable, **and** zero `fs.corruption` events followed a shield spend. |
| `obj.the_gridlock.detection_interval` | The configured interval is at most one run per 25 ticks, **and** the worst observed latency from cycle formation to `deadlock.detected` is less than the smallest gap between any participant's `readySince` and `starvationThreshold`. |

Two of these need care.

`total_ordering` must poll rather than count. Under `prevent` a violation is refused with
`EDEADLK` before it can form a cycle, so an implementation that counts `deadlock.detected`
events passes vacuously and also passes a player who never enabled `prevent` at all. Poll
`detectDeadlock()` every tick of the segment and also assert that at least one
`resources --rank` was issued.

`detection_interval` compares two quantities that both move. Compute it as: for each cycle that
formed during the leg, `detectionTick - formationTick`, and take the maximum. Compare that
maximum against `min over participants of (starvationThreshold - readySinceAtFormation)`. The
objective is met when the maximum latency is strictly less than that minimum margin and the
configured interval is at most 25. An interval of 1 satisfies the latency and fails nothing, but
costs a sweep every tick; the leg should charge the sweep in cycles so the player feels the
tradeoff, and the objective deliberately does not punish it, because 8.7.3's lesson is that the
interval is a cost decision rather than a correctness one.

### Debrief card

```ts
{
  headline: /* 'Through the junction.' or 'Nothing was moving.' */,
  whatHappened:
    `You crossed the first half under ${strategyA} and the second under ${strategyB}. ` +
    `Cycles formed: ${cyclesFormed}. Detected: ${cyclesDetected}. ` +
    `Requests denied unsafe: ${unsafeDenials}. Denied unavailable: ${unavailableDenials}. ` +
    `Total crossing time: ${ticks} ticks.`,
  whyItHappened: /* selected from the cases below */,
  counterfactual: /* a real WP-18 replay, see below */,
  chapter: { chapter: 8, title: 'Deadlocks', sections: ['8.6.1'] },
}
```

Note the `chapter` field cites **8.6.1** for the safe sequence, per the correction.

`whyItHappened`, selected by what actually occurred:

- **A cycle held under `ignore`.** "Four Programs each held one resource and requested the next
  one around. No process failed and no error was raised. The system had nothing to report
  because you had not asked it to look."
- **Prevention was used for the whole crossing.** "Ranking the resources made a cycle
  structurally impossible and it also made every process hold a resource it was not yet using.
  You paid for a guarantee against something that might not have happened."
- **An unsafe grant completed.** "The state had no safe sequence from tick ${t} to tick ${t2}.
  Nothing went wrong. The system could not have promised that, and this time it did not need
  to."
- **A victim was chosen by priority.** "You ended the lowest-priority Program. The lowest
  rollback cost was ${otherName}, at ${otherWork} ticks of accumulated work against
  ${chosenWork}."
- **Clean crossing.** "Every grant left a safe sequence and you can name it."

The counterfactual is a **real replay through WP-18**, never a text template. Two cases, and the
priority order matters:

1. **A Program derezzed with `deadlock_victim`, or a cycle held under `ignore`.** Replay the
   crossing from the tick the ring closed, under `avoid`, and report the result:
   > "The same crossing under avoidance finishes in ${ticks} ticks with ${survivors} survivors
   > and ${denials} denied requests."
   On the golden seed that number is **245 ticks with four survivors and two denials**.
2. **An unsafe grant was overridden and the crossing completed.** Replay the identical decision
   on the sibling seed where the maximum claims are exercised, and report:
   > "On a run where P0 and P2 request their full declared maximums, that grant deadlocks at
   > tick ${t}. The state you were in could not promise otherwise."
3. **Prevention used for both halves.** Report both times:
   > "Ordering-based prevention completed the crossing in 340 ticks. Avoidance completes the
   > same crossing in 245, with two denied requests and the same four survivors."
4. `null` only when the player ran avoidance cleanly with zero cycles and zero casualties.

340 and 245 are the frozen fixtures from the third misconception. Quote them from the fixture
file, not from a string literal in the debrief, so a tuning change cannot desynchronise the
prose from the simulation.

---

## Acceptance criteria

1. `src/legs/the_gridlock/index.ts` satisfies `Leg` under `tsc --strict`,
   `id === 'the_gridlock'`, `index === 6`.
2. The leg runs headlessly to completion via the smoke-test harness, with no Three.js or DOM
   import reachable from the leg module graph.
3. `enabledSubsystems` deep-equals `['process', 'scheduler', 'sync', 'deadlock']`. No memory,
   vm, storage, io, fs or security subsystem is enabled.
4. The leg's entry configuration is exact: `deadlockStrategy: 'ignore'`, `agingInterval: 0`,
   `journalingEnabled: false`, `scheduler: 'rr'`, `preemptive: true`.
5. Inert-field independence: mutating every `KernelConfig` field not named in the Kernel
   configuration section leaves the canonical event log hash unchanged over 400 ticks.
6. Every objective can be met by the known-good decision sequence; all seven met in one run.
7. The known-bad sequence produces the intended failure: the ring closes under `ignore`, no
   `deadlock.detected` fires, `detectDeadlock()` returns a four-pid cycle, four Programs acquire
   `lock_convoy`, and at least one derezzes with `TerminationReason: 'deadlock_victim'` carrying
   the exact epitaph cause text.
8. **The silence holds.** From leg entry to tick 60 under the entry configuration, the leg emits
   zero `deadlock.detected`, zero affliction acquisitions, zero HUD warnings and zero audio cues
   beyond the ambient bed. Asserted by capturing every emitted event and every UI signal in that
   window and comparing against an empty expected set.
9. `DL-BANKERS-1` through `DL-BANKERS-5` all reproduce exactly against this leg's declared
   resources and processes, including the safe sequence `<P1, P3, P0, P2, P4>` and the
   `DL-BANKERS-1A` forced-order path yielding the textbook's `<P1, P3, P4, P0, P2>` as also safe.
10. `DL-BANKERS-3` produces `resource.denied { reason: 'unavailable' }` and `DL-BANKERS-4`
    produces `resource.denied { reason: 'unsafe' }`, and the gate house displays them with
    different words. `DL-BANKERS-5` produces `EINVAL` with a third form of words.
11. `DL-DETECT-1` yields no deadlock with finish order P0, P2, P1, P3, P4 and final Work
    (7,2,6). `DL-DETECT-2`, differing only in P2's request, yields the deadlocked set
    {P1, P2, P3, P4} with only P0 finishing and Work stopping at (0,1,0).
12. `DL-CYCLE-1` yields cycle `[1, 2, 3]` rotated to the lowest pid, and the world's beam ring is
    drawn in that rotation. `DL-CYCLE-2` yields null.
13. `DL-VICTIM-1` holds: `suggestedVictims[0]` matches the §9.6 comparator and a convoy Program
    never sorts first when a non-convoy process is present.
14. `DL-PREVENT-1` holds: under `prevent`, a process holding rank 3 requesting rank 1 gets
    `EDEADLK` with **no block**, and invariant I-24 holds every tick of the run.
15. The four ring edges' Coffman conditions come from `detectDeadlock().conditions` and are equal
    to the mapping table. Asserted by equality against the kernel, not against a leg constant.
16. Restarting the crossing reproduces the identical cycle. Two restarts produce three byte-
    identical cycle formations.
17. SABLE's shield on `gate_d` breaks the cycle with zero `fs.corruption`. On
    `archive_write_lock` it breaks the cycle and produces exactly one `fs.corruption` with
    `recoverable: false`, recorded in the leg outcome.
18. Prevention completes the crossing in the frozen 340 ticks with zero casualties; avoidance
    completes it in the frozen 245 with zero casualties and exactly two denials. Both asserted
    against the fixture file.
19. Event table weights sum to exactly 100; all ids unique. `gridlock.wfg_survey` draws a real
    cycle from a real `detectDeadlock()` call.
20. All three terminal command `manual` strings match the curriculum map byte for byte, and the
    three `chapter` fields carry 8.7.1 on `wfg`, 8.6.1 on `bankers`, and 8.5.4 plus 8.7.3 on
    `resources`.
21. No string this leg generates cites 8.6.2 for the safe sequence or 8.3.2 for the wait-for
    graph cycle. Asserted by a lint test over every generated string in the leg, including man
    pages, codex prose, debrief text, epitaph text and `SafetyTraceStep.explanation`.
22. Draw calls stay under the tier budget of 220 / 450 / 900, measured at the heaviest frame,
    which is the closed ring at `critical` gain with four labelled edges plus the matrix board
    and the safe-sequence rail in view.
23. The ring hero visual holds at all three tiers: every beam in the cycle transitions from
    `blocked` amber to `denied` amber at `critical` gain in the same frame `deadlock.detected`
    fires, and the ring then holds motionless.
24. Under `ignore` the same last edge closes and **no** beam changes gain. Asserted as a
    separate frame-level test, because it is the visual half of the first misconception.

---

## Tests you must write

All under `tests/legs/the_gridlock/`. This directory is owned exclusively by this package.

**`contract.test.ts`**: `Leg` conformance, exact ids, the seventeen-section chapters array,
seven objectives, every `chapter.sections` entry present in `chapters`.

**`citations.test.ts`**: the correction lint.
- Every string the leg can generate is collected: the three `manual` fields, every codex prose
  body this leg registers, every debrief branch, every epitaph, every
  `SafetyTraceStep.explanation` produced across a full run, every event narration.
- Assert none contains `8.6.2` in a sentence about the safe sequence, and none contains `8.3.2`
  in a sentence about the wait-for graph cycle.
- Assert the three `TerminalCommandDef.chapter` values exactly.
- Assert no quantum reference cites 5.3.4.

**`config.test.ts`**: the entry configuration exactly; `enabledSubsystems` exact; inert-field
independence over 400 ticks; `journalingEnabled === false`.

**`populate.test.ts`**: ten spawns (five convoy plus five junction), five binds, five
`declareResource` calls with exact instance counts and `preemptible` flags, two `declareSync`
calls. Assert `gate_d.preemptible === true` and `archive_write_lock.preemptible === true` and
that the rollbackable column differs between them.

**`bankers.test.ts`**: the worked example, in full.
- The four matrices at leg start equal the §9.4.3 tables exactly.
- `DL-BANKERS-1`: safe, sequence `<P1, P3, P0, P2, P4>`, five admitted trace steps, and each
  step's Work before and after matches the trace table row by row.
- `DL-BANKERS-1A`: forced admission order P1, P3, P4, P0, P2 is also safe.
- `DL-BANKERS-2`: P1 requests (1,0,2), granted, Available becomes (2,3,0), Need[P1] becomes
  (0,2,0), safe sequence unchanged.
- `DL-BANKERS-3`: P4 requests (3,3,0), denied `EAGAIN` with `reason: 'unavailable'`.
- `DL-BANKERS-4`: P0 requests (0,2,0), denied unsafe, **rolled back exactly** (assert the
  snapshot before and after are byte-identical apart from the denial event), trace ends
  `candidate: null, admitted: false`, stuck set is all five.
- `DL-BANKERS-5`: P1 requests (2,0,0), `EINVAL`.
- `bankers --sequence` returns null for every tick of the overridden-unsafe stretch.

**`detection.test.ts`**: `DL-DETECT-1` and `DL-DETECT-2` exactly, including finish orders and
final Work vectors. `DL-CYCLE-1` rotation and `DL-CYCLE-2` null.

**`silence.test.ts`**: the first misconception's mechanical half.
- Run the entry configuration for 60 ticks. Capture every `KernelEvent`, every affliction
  acquisition, every HUD signal and every audio cue.
- Assert the set of anything the player could read as a warning is empty.
- Assert `ps` reports four Programs in `waiting` and `top` reports 0 percent processor use.
- Assert the travel meter is the only value that changed.
- Assert `detectDeadlock()` called manually at tick 60 returns a four-pid cycle, so the state is
  genuinely deadlocked and genuinely unreported.

**`strategies.test.ts`**: the four strategies.
- `ignore`: the cycle holds, no event, `lock_convoy` accrues, at least one derezz.
- `detect`: `deadlock.detected` fires within the configured interval, victim selection runs.
- `avoid`: every grant preceded by a `bankers.evaluated` with `safe: true`; exactly two denials
  on the golden seed; zero cycles.
- `prevent`: `DL-PREVENT-1`; out-of-order acquisition returns `EDEADLK` without blocking; I-24
  holds every tick; zero cycles.
- The frozen crossing times: prevention 340 ticks, avoidance 245, both zero casualties.

**`victims.test.ts`**: `DL-VICTIM-1`. The comparator picks `junction.p2`. Picking by priority
picks `junction.p4` and produces lost work above 40 ticks, failing the objective. A convoy
Program never sorts first while a non-convoy process is in the cycle.

**`shield.test.ts`**: SABLE's shield.
- On `gate_d`: cycle broken, zero `fs.corruption`, objective met.
- On `archive_write_lock`: cycle broken, exactly one `fs.corruption { recoverable: false }`,
  objective failed, corruption recorded in the leg outcome.
- The shield selector exposes both the `preemptible` flag and the rollbackable truth as separate
  values, and they differ for `archive_write_lock`.

**`restart.test.ts`**: restarting reproduces the identical cycle; two restarts give three
byte-identical formations; `trace --replay` confirms it.

**`explain.test.ts`**: `wfg --explain` on all four edges returns the condition from
`detectDeadlock().conditions`; the remedy-to-condition mapping is exercised in both directions;
choosing a victim returns "ends the cycle by ending a participant" rather than naming a
condition.

**`evaluate.test.ts`**: each of the seven objectives, met and not met. In particular:
- `total_ordering` fails for a player who never ranked anything, even though zero events fired.
- `safe_admission` is unaffected by `'unavailable'` denials and affected by `'unsafe'` ones.
- `detection_interval` computes maximum formation-to-detection latency against the minimum
  starvation margin, and an interval of 1 passes.

**`golden.test.ts`**: the golden headless playthrough.
- Fixture: `seed: 0x4b54524c`, `discClass: 'shell'`, `difficulty: 'operator'`, steady pace,
  standard rations, entering with the leg 5 golden closing ledger and with leg 5's
  `ring_closed` decision present.
- Known-good sequence, in order:
  1. `wfg` at tick 40, during the silence, finding the four-edge ring.
  2. `wfg --explain p1-p2`, naming `hold_and_wait`.
  3. `gridlock.set_strategy` to `avoid` for the first half.
  4. `bankers --state`, then `bankers --check 1 gate_a 1` before granting request 1.
  5. Grant request 1 (safe). Observe request 2 denied unavailable and request 3 denied unsafe.
  6. `gridlock.set_strategy` to `prevent` for the second half; rank `gate_a` 1, `gate_b` 2,
     `gate_c` 3, `gate_d` 4.
  7. On the one cycle that forms before the ranking takes effect, `gridlock.spend_shield` on
     `gate_d`.
  8. `gridlock.set_detection_interval` to 20.
- Assert: all seven objectives met, zero casualties, zero `fs.corruption`, at most two unsafe
  denials, eight codex entries added, the opening card named leg 5's ring tick, canonical
  event log hash matches the checked-in golden file, stable across two runs and across a
  snapshot-restore at the midpoint.

**`badpath.test.ts`**: the known-bad sequence.
- Never open the gate house. Never run `wfg`. Restart the crossing twice.
- Assert: the ring holds for the whole leg, zero `deadlock.detected`, `detectDeadlock()` returns
  a four-pid cycle from tick 60 onward, four Programs acquire `lock_convoy`, at least one
  derezzes with `deadlock_victim` and the exact epitaph text, counterfactual case 1 runs a real
  avoidance replay returning 245 ticks and four survivors, and `survived === true`.

**`badpath2.test.ts`**: the shield trap.
- Reach the cycle, then spend the shield on `archive_write_lock`.
- Assert: the cycle breaks, one `fs.corruption { recoverable: false }`,
  `obj.the_gridlock.preempt_safely` failed, the corruption recorded in the leg outcome, and the
  debrief names the rollbackable column the player did not read.

**`manuals.test.ts`**: three manual strings against the curriculum map fixture; every
`See also:` topic resolves; the `resources` strategy table lists all four values with their
costs; the `wfg` Coffman block lists all four conditions.

**`stage.test.ts`** (headless renderer rig)
- Every anchor id resolves; every `InteractionDef.anchor` resolves.
- Draw calls under 220 / 450 / 900 at the heaviest frame.
- All four matrices legible in one orthographic lock at `anchor.matrix_board` at every tier.
- The ring transition test: on `deadlock.detected`, every cycle beam changes gain in the same
  frame. Under `ignore`, the same edge closure changes no gain.
- The `anchor.ring` overhead framing matches leg 5's documented composition.

---

## Out of scope

- Do not touch any other leg. Do not import from `src/legs/*` other than your own directory.
- Do not modify `src/game/types.ts` or `src/kernel/types.ts`. They are frozen, including the
  three citations that are wrong. Correct the citations in the strings you generate and leave
  the type files alone.
- Do not modify anything under `src/kernel`, `src/render`, `src/world`, `src/terminal`,
  `src/ui`, `src/audio`, `src/design`, `src/platform` or `src/app`. If the safety algorithm, the
  victim comparator or the cycle rotation is wrong, file it against WP-08 and stop.
- Do not enable `memory`, `vm`, `storage`, `io`, `fs` or `security`. The `fs.corruption` from
  the shield trap is emitted by the deadlock recovery path and recorded in the leg outcome; it
  does not require a file system.
- Do not open the leg under `detect`. `ignore` is the entry value and the silence is the lesson.
- Do not add a warning, a hint, an audio sting, a HUD badge or a highlight during the first 60
  ticks. Every instinct will push you to add one. The `wfg` man page is the only route in and
  the player has to find it.
- Do not make `gridlock.restart_crossing` work. It reproduces the cycle exactly.
- Do not fix the `archive_write_lock` trap by setting `preemptible: false`. The flag says true
  and the rollbackable column says no, and finding the difference is the objective.
- Do not enable journaling to make the corruption recoverable. Leg 11 decides that.
- Do not add `codex.dining_philosophers`. Leg 5 owns it; register a cross-link.
- Do not write the words "you are deadlocked" anywhere. The player diagnoses it.

### Files this package owns exclusively

```
src/legs/the_gridlock/index.ts
src/legs/the_gridlock/chapters.ts
src/legs/the_gridlock/objectives.ts
src/legs/the_gridlock/config.ts
src/legs/the_gridlock/populate.ts
src/legs/the_gridlock/interactions.ts
src/legs/the_gridlock/commands.ts
src/legs/the_gridlock/events.ts
src/legs/the_gridlock/evaluate.ts
src/legs/the_gridlock/matrices.ts
src/legs/the_gridlock/ring.ts
src/legs/the_gridlock/strategies.ts
src/legs/the_gridlock/fixtures.ts
src/legs/the_gridlock/stage.ts
src/legs/the_gridlock/copy.ts
tests/legs/the_gridlock/**
```

No other package writes to these paths and this package writes to no others.

---

## Report back

1. The commit or branch, and the full `tests/legs/the_gridlock/` output.
2. The golden playthrough hash and the file it is checked in at.
3. The frozen fixtures, as a table: prevention crossing time, avoidance crossing time, the tick
   the ring closes at each of the four paces, and the four junction processes' `totalCpuUsed`,
   priority and held counts at ring close.
4. Every `DL-*` fixture result against its expected value, including both banker's safe
   sequences and both detection outcomes.
5. Confirmation that the silence test passes, with the captured event set from the first 60
   ticks printed in full so a reviewer can see it is empty.
6. The output of the citation lint, listing every generated string it scanned and confirming
   zero uses of 8.6.2 for the safe sequence and 8.3.2 for the wait-for graph cycle.
7. Draw calls at each of the three quality tiers at the heaviest frame, and confirmation that
   all four matrices are legible in one lock at low tier.
8. The field carrying the shield-trap corruption to leg 11, agreed with WP-17.
9. Confirmation that WP-18's replay worker served both counterfactual cases without a second
   implementation.
10. Any place where the curriculum map, the narrative bible, the visual bible and the sim spec
    disagreed, what you did, and which document you followed. The design brief wins over all.
11. Confirmation that no file outside the owned list was created or modified.

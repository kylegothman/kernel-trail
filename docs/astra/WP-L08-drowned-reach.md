# WP-L08: The Drowned Reach

Leg id `drowned_reach`, index 8. Subtitle: *The ground arrives when you step, and it is starting
to leave faster.*

**Legs are independent and may be built concurrently.** This package touches no other leg,
imports from no other leg, and shares no source file with any other leg.

---

## This is the showpiece

Read this section before anything else in the package.

The design brief names leg 8 as the showpiece in section 4 and states the mechanic in one
paragraph: demand paging is rendered as an ocean that materialises into solid ground only where
the convoy steps; pages you have not touched do not exist yet; eviction visibly dissolves ground
behind you; thrashing is the moment the ground starts vanishing faster than it appears, and the
player has to reduce the degree of multiprogramming while standing on almost nothing.

Everything in this package serves that paragraph. Three consequences follow and they govern
every decision you will make while building it.

**One. The world is the teaching, and there is no fallback.** Other legs explain a concept and
then draw it. This leg draws a concept and never explains it. There is no tutorial text for the
ocean, no callout for the first page fault, and no warning when the ground starts receding
faster than it forms. The remedy is on screen the entire time and the game never says it. If you
find yourself adding a hint, you have found the place where the visual is not doing its job, and
the fix is the visual.

**Two. Every visual element is driven by a real event from the kernel.** Not one tile rises, one
tile dissolves or one ripple crosses the water except in response to a `KernelEvent`. The ocean
is a rendering of `MemoryMetrics` and nothing else. A tile that dissolves without a
`memory.page_evicted` is a bug that destroys the entire leg, because the player is being asked
to reason about the memory system from what they can see, and the moment the picture and the
simulator can disagree the reasoning is worthless.

**Three. The leg is allowed to be unfair and is not allowed to be arbitrary.** Tiles dissolve
under the convoy's feet at critical severity. The convoy falls. Nothing prevents it. The
replacement policy chose that victim and the player chose the replacement policy. That is fair
in the only sense that matters here: it is a consequence of a decision the player made and can
inspect. What is forbidden is any damage the player cannot trace to a decision and a metric.

The leg is the second of the two difficulty spikes and the spike is both lexical and structural:
nine new terms, an anomaly that contradicts intuition, an allocation problem with a hard
constraint, and a collapse that accelerates while the player is deciding. It is also the leg
where the game deliberately offers a wrong action in reasonable language, which raises load
because the player must distrust the interface.

**There is no depot in the Drowned Reach.** The convoy crosses on what it carried out of the
Allocation Yards. This is the central scarcity decision of the game and it is not negotiable in
balancing. Every playtest note about leg 8 being too punishing is answered by adjusting the
Yards depot, never by putting a depot in the Reach. If you believe the leg needs a depot, you
have found a balance problem in leg 7 and you should report it there.

---

## Objective

A module at `src/legs/drowned_reach/` implementing the frozen `Leg` interface, playable end to
end.

The Reach is water to the horizon with no road across it. A Program steps forward anyway, and a
slab of ground rises under its foot after a visible pause, arriving from somewhere below. Then
the next one, on the next step. The convoy is walking on ground that does not exist until it is
needed, which is fine, until the player looks back and sees the slabs behind them dissolving to
make the ones ahead.

The player sets `PageReplacementId` at the reach console, sets `Rations` (which maps onto frames
allocated per process), and sets `TravelPolicy.degreeOfMultiprogramming` from 2 to 9. The leg
ends when the convoy reaches the far shore or when there is nobody left to walk.

---

## Prerequisites

**Engine work packages that must be complete and green on the shared branch:**

| Package | Why this leg needs it |
|---|---|
| WP-01 | `Rng`, event bus, canonical serialiser, determinism fixtures. |
| WP-02 | Process table, PCB, `addressSpaceId`, kernel step order, `fork` for the copy-on-write case. |
| WP-03, WP-04 | Scheduler policies. The leg does not teach scheduling and needs the policies to exist. |
| WP-05 | Frame table, page tables, the valid bit, the TLB, translation. Leg 7 established these and this leg cannot be explained without them. |
| **WP-06** | **The whole of it.** Demand paging, all six replacement policies, working set estimation, the thrashing detector, locality generation. This leg is WP-06's principal consumer and the only leg that exercises all of it. |
| WP-11 | Syscalls, snapshot and restore, the invariant set. |
| WP-12 | Renderer backend, post chain, design tokens, draw call budget, HDR target, reflection target. |
| WP-13 | Focus camera, structure base classes, instancing. |
| WP-14 | World event router, effect pooling, **the derezz shader** (the tile dissolve reuses it). |
| WP-15 | The terminal. |
| WP-17 | HUD, codex, save and load. |
| WP-18 | The counterfactual replay worker. `belady --compare` and the debrief both consume it. |

**Kernel subsystems that must be working:** `process`, `scheduler`, `memory`, `vm`.

WP-06 must provide, exactly:

- Demand paging with the valid bit: a reference to a page whose valid bit is clear traps, the
  kernel finds a free frame, reads from the backing store, fixes the table, and restarts the
  faulting instruction.
- `memory.page_fault` distinguishing `major: true` (reads the backing store) from `major: false`
  (satisfied without I/O, including the copy-on-write copy).
- All six `PageReplacementId` values, each reproducing its `VM-*` fixture, including `optimal`
  with a reference string lookahead available only in scripted teaching scenarios.
- `memory.page_evicted` carrying `frame`, `page`, `dirty` and `policy`.
- Write-back on eviction of a dirty frame, costing more than a clean eviction.
- `MemoryMetrics.workingSets` as a live per-process map, with a configurable window.
- `MemoryMetrics.faultRate` as faults per thousand ticks, smoothed.
- `memory.thrashing` at `severity: 'warning'` and `severity: 'critical'`, per `VM-THRASH-1` and
  `VM-THRASH-2`.
- Global and local replacement as a switchable mode.
- Copy-on-write on `fork`, per `VM-COW-1`.
- `PageReplacementSnapshot` with `order` and, for clock, `handIndex`.

Fixtures `VM-FIFO-1`, `VM-LRU-1`, `VM-CLOCK-1`, `VM-OPT-1`, `VM-LFU-1`, `VM-BELADY-1`,
`VM-BELADY-2`, `VM-BELADY-3`, `VM-EAT-1`, `VM-EAT-2`, `VM-WS-1`, `VM-WS-2`, `VM-THRASH-1`,
`VM-THRASH-2` and `VM-COW-1` must all pass before this leg starts.

---

## Required reading

- `docs/00-DESIGN-BRIEF.md`, **section 4 in full**, which is where the showpiece is specified;
  sections 5, 7, 8, 9.
- `docs/05-CURRICULUM-MAP.md`, "Leg 8. THE DROWNED REACH" in full; section D, "The two spikes".
- `docs/02-KERNEL-SIM-SPEC.md`, **section 7 in full** (Virtual memory, Ch. 10); section 16.6 (the
  `VM-*` test vectors).
- `docs/03-VISUAL-BIBLE.md`, **section 10.1 in full**, which is the only per-leg visual section
  written at implementation depth; section 9 (the derezz effect, which the tile dissolve reuses);
  section 4 (the post chain); section 8 (motion language); section 13 (quality tiers).
- `docs/04-NARRATIVE-BIBLE.md`, section 5.3 (leg lengths; the Reach is 100 segments and has no
  depot); section 6.2 (rations, which set frames per Program, and the generous-rations trap);
  section 7 entry for `thrashing`; section 8 leg 8 event table; section 9 epitaphs for
  `thrashing_collapse`.

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
  { chapter: 10, title: 'Virtual Memory',
    sections: ['10.1', '10.2.1', '10.2.2', '10.2.3', '10.3',
               '10.4.1', '10.4.2', '10.4.3', '10.4.4', '10.4.5', '10.4.6',
               '10.5.1', '10.5.2', '10.5.3',
               '10.6.1', '10.6.2', '10.6.3', '10.7', '10.8.1', '10.8.2'] },
];
```

Twenty sections, the largest chapter coverage of any leg.

### Prerequisite concepts

From `allocation_yards`: pages, frames, the page table, **the valid bit**, the TLB, and locality.
From `quantum_pass`: the degree of multiprogramming as a thing the player sets. From
`fork_fields`: `fork`, which returns here as the copy-on-write case.

Without the valid bit from leg 7 the Reach cannot be explained at all, which is why the two legs
are adjacent and why paging is not taught here. If leg 7 has not shipped, this leg cannot be
integration-tested, though it can be built.

### Learning objectives

Copy verbatim into `src/legs/drowned_reach/objectives.ts`.

```ts
export const objectives: readonly LearningObjective[] = [
  {
    id: 'obj.drowned_reach.effective_access_time',
    statement: 'Holds the page fault rate below 0.4 percent so effective access time stays under three times the memory access time across the crossing.',
    chapter: { chapter: 10, title: 'Virtual Memory', sections: ['10.2.3'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.drowned_reach.replacement_choice',
    statement: 'Selects a replacement policy whose fault count on this leg reference string lands within 20 percent of the optimal policy count, and confirms the gap with belady --compare.',
    chapter: { chapter: 10, title: 'Virtual Memory', sections: ['10.4.2', '10.4.3', '10.4.4', '10.4.5'] },
    assessedBy: 'terminal_command',
  },
  {
    id: 'obj.drowned_reach.reproduce_belady',
    statement: 'Reproduces Belady anomaly by raising FIFO frame count from three to four on the scripted string and observing the fault count rise, then shows LRU does not do this on the same string.',
    chapter: { chapter: 10, title: 'Virtual Memory', sections: ['10.4.2'] },
    assessedBy: 'terminal_command',
  },
  {
    id: 'obj.drowned_reach.working_set_allocation',
    statement: 'Allocates frames so that no Program holds fewer frames than its measured working set while total allocation stays at or under the frame budget.',
    chapter: { chapter: 10, title: 'Virtual Memory', sections: ['10.5.1', '10.5.2', '10.6.2'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.drowned_reach.recover_from_thrashing',
    statement: 'On a memory.thrashing warning, reduces the degree of multiprogramming until the fault rate falls below the threshold, and does so before any Program integrity drops below 40.',
    chapter: { chapter: 10, title: 'Virtual Memory', sections: ['10.6.1', '10.6.3'] },
    assessedBy: 'survival',
  },
  {
    id: 'obj.drowned_reach.global_versus_local',
    statement: 'Switches from global to local replacement once one Program fault storm begins taking frames from Programs that were not faulting, and shows the victim Program fault rate falling afterwards.',
    chapter: { chapter: 10, title: 'Virtual Memory', sections: ['10.5.3'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.drowned_reach.copy_on_write',
    statement: 'Forks the scout with copy-on-write so the fork costs fewer than four frames rather than a full address space copy.',
    chapter: { chapter: 10, title: 'Virtual Memory', sections: ['10.3'] },
    assessedBy: 'decision',
  },
];
```

### Codex entries this leg adds to `codexUnlocked`

Nine, the highest count of any leg.

`codex.demand_paging`, `codex.copy_on_write`, `codex.page_replacement`, `codex.beladys_anomaly`,
`codex.frame_allocation`, `codex.global_vs_local`, `codex.working_set`, `codex.thrashing`,
`codex.kernel_memory`.

| Entry | Added when |
|---|---|
| `codex.demand_paging` | The first `memory.page_fault`, which is the convoy's first step. |
| `codex.copy_on_write` | The first `memory.page_fault { major: false }` arising from a fork. |
| `codex.page_replacement` | The first `memory.page_evicted`. |
| `codex.beladys_anomaly` | A `belady` invocation at three frames followed by one at four frames on the scripted string, under `fifo`, where the second returns more faults. |
| `codex.frame_allocation` | The first rations change, or the first `ws --budget`. |
| `codex.global_vs_local` | The first eviction that takes a frame from a Program other than the faulting one. |
| `codex.working_set` | The first `ws` invocation. |
| `codex.thrashing` | The first `memory.thrashing { severity: 'warning' }`. |
| `codex.kernel_memory` | The leg completes, or the player inspects the pinned causeway. |

`codex.thrashing` is added on the **warning**, not on the critical event and not on a death. That
is the codex contract at its most load-bearing: the player who reads the warning has the remedy
available before the collapse. Everything about the leg's difficulty assumes they will not read
it the first time.

### Misconceptions this leg must break

**"More frames always mean fewer faults."** It is monotonic in every student's mental model and
it is false. The break is Belady's anomaly, run by the player rather than described: the
scripted reference string is posted at the reach console, and the player is asked to predict the
fault count at four frames after seeing it at three. FIFO at three frames gives nine faults; at
four frames it gives ten. The player then runs the same pair under LRU and gets the monotonic
result they expected. The anomaly is not a curiosity here, it is the evidence that intuitions
about replacement need to be checked against a simulation.

The exact data is in the Belady section below and it is not negotiable.

**"Thrashing means there is not enough memory, and the processor being idle means I should run
more."** These are two beliefs that combine into the worst possible action, which is why the leg
puts them in one interaction. The reach console literally offers "processor utilisation is at 22
percent. Admit two more Programs?" at the moment thrashing begins.

The first belief is nearly right and incomplete: the shortage is relative to the working sets of
the admitted processes, so it can be fixed by admitting fewer without adding any memory. The
second is the classic misreading of the utilisation curve. The `degree` man page names the
diagnostic that separates the two cases, which is fault rate rather than utilisation, and the
debrief replays the counterfactual where the player reduced the degree instead.

**"LRU is what operating systems use, and it is implemented with a timestamp on each page."**
Students carry LRU out of the course as the practical answer, and it is a model rather than an
implementation. The break is priced: the reach console sells exact LRU, and its cost is charged
in bandwidth **per memory access** rather than as a flat fee, so the meter drains continuously
while the policy is active. Clock costs one bit per frame and a hand position, drawn in the
world as a rotating arm over the frame slabs. `belady --compare` shows clock landing within a
few faults of LRU on the leg's string. The player pays the difference and then chooses to stop
paying it.

---

## Kernel configuration

```ts
export function kernelConfig(run: RunState): KernelConfig {
  return {
    seed: run.seed,
    scheduler: 'rr',                       // the leg is not about scheduling; rr keeps every admitted Program touching memory
    schedulerParams: {
      quantum: quantumForPace(run.policy.pace),  // Ch. 5.3.3
      agingInterval: 0,                    // aging would mask the collapse by reordering who faults first
      starvationThreshold: 120,            // valid; a thrashing Program blocks on paging rather than starving in the ready queue
      starvationFatalThreshold: 300,
      preemptive: true,
    },
    totalFrames: 48,                       // THE BUDGET. Tighter than every other leg. See the note below.
    pageSize: 4096,                        // carried from the Yards; the player does not change it here
    replacementPolicy: 'fifo',             // THE ENTRY VALUE IS DELIBERATE. Belady is reachable from tick 0.
    allocationStrategy: 'first_fit',       // inert under paging: any free frame fits any page
    tlbEntries: 16,                        // real: locality still pays, and VESPER's remap still helps
    diskPolicy: 'look',                    // inert: 'storage' is not enabled. The backing store is a latency, not a queue.
    totalCylinders: 200,                   // inert
    raidLevel: null,                       // inert
    fileAllocation: 'indexed',             // inert: 'fs' is not enabled
    journalingEnabled: false,              // inert
    deadlockStrategy: 'ignore',            // inert: 'deadlock' is not enabled
    thrashingThreshold: 200,               // REAL AND CENTRAL. Faults per thousand ticks above which thrashing begins.
    enabledSubsystems: ['process', 'scheduler', 'memory', 'vm'],
  };
}
```

`enabledSubsystems` is `['process', 'scheduler', 'memory', 'vm']`. `vm` is what this leg
teaches and it is enabled here for the first time in the run.

### The three numbers that are the leg

**`totalFrames: 48`.** Early legs run 64 frames and the Reach runs 48. The convoy walks out of
the roomiest leg in the game straight into the tightest, and it does so with no depot behind it.
48 frames is the constraint every mechanic in the leg presses against, and it is what makes the
generous-rations trap bite: generous rations pin 20 of those 48, which is 42 percent of the
Reach, and the workload's fault rate climbs past `thrashingThreshold` as a direct consequence.

**`thrashingThreshold: 200`.** Faults per thousand ticks. `MemoryMetrics.faultRate` is smoothed
and compared against this. Every visual in the leg keys off the ratio
`faultRate / thrashingThreshold`, so this number is not a tuning knob you may change casually;
`tilesAhead` is defined against it and so is every severity band.

**`replacementPolicy: 'fifo'`.** The entry value is FIFO, which means Belady's anomaly is
reachable from the first tick and means the player's default is the one policy that can get
worse when given more. That is deliberate. The reach console offers all six.

### Rations to frames

`Rations` maps onto frames allocated per Program, and this leg's mapping is stated in the
curriculum map and overrides the general table in the narrative bible:

| `Rations` | Frames per Program | Five Programs pin | Percent of 48 |
|---|---|---|---|
| `generous` | 24 | 120 | over budget on its own |
| `standard` | 16 | 80 | over budget on its own |
| `lean` | 10 | 50 | over budget on its own |
| `starved` | 6 | 30 | 62.5 percent |

Read that table carefully, because it is the leg's hard constraint stated as arithmetic. **Five
Programs at any ration above `starved` cannot all be resident in 48 frames.** The player cannot
solve this leg by choosing a ration. They solve it by choosing how many Programs are admitted,
which is `degreeOfMultiprogramming`, and that is the entire point of Ch. 10.6.1.

A degree of 2 at `generous` is 48 frames exactly. A degree of 3 at `standard` is 48 exactly. A
degree of 4 at `lean` is 40, leaving 8 free. A degree of 8 at `starved` is 48 exactly and every
Program is below its working set. Those four rows are the leg's decision space and the player
finds them by measurement.

Freeze the per-Program working sets so the arithmetic is checkable, and post them at the working
set beacon:

| Program | Working set size at the crossing's mid-point |
|---|---|
| LUMEN | 14 |
| SABLE | 11 |
| ORRERY | 12 |
| KESTREL | 9 |
| VESPER | 10 |

Sum: 56 against 48 frames. **The sum of the working sets exceeds the supply.** `ws --budget`
says so plainly: "If the sum exceeds the supply, no allocation policy can fix it. Something has
to be suspended." The convoy cannot cross with all five admitted, and finding that out is the
leg.

VESPER's remap lowers one Program's working set for the rest of the leg, which is how a player
who used it in the Yards arrives with 56 reduced to something crossable. That is the reward for
leg 7 play, paid here.

---

## Population

```ts
export function populate(ctx: LegSetupContext): void {
  const roster: readonly [ConvoyMemberId, string, number, number, number, number][] = [
    // member,      name,      priority, burst, service, pages
    ['lumen',   'LUMEN',   2, 6, 70, 22],   // vulnerable to thrashing per the convoy table
    ['sable',   'SABLE',   2, 5, 64, 18],
    ['orrery',  'ORRERY',  3, 5, 64, 19],
    ['kestrel', 'KESTREL', 3, 4, 58, 15],
    ['vesper',  'VESPER',  3, 5, 64, 17],
  ];
  roster.forEach(([member, name, priority, burst, service, pages], i) => {
    const pid = ctx.spawn({
      name, priority, burst, service, arrival: i, pages,
      referenceString: convoyReferenceString(member),  // see below: deterministic, locality-shaped
    });
    ctx.bind(member, pid);
  });

  // The Reach's own workload. The degree of multiprogramming admits from this pool plus the
  // convoy, so raising the degree genuinely admits more working sets.
  for (let i = 0; i < 6; i++) {
    ctx.spawn({
      name: `reach.drifter_${i}`,
      priority: 4, burst: 3, service: 90, arrival: 8 + i * 6, pages: 12,
      referenceString: drifterReferenceString(i),
    });
  }
}
```

No `declareResource` and no `declareSync`. There is no contention in the Reach beyond the frames
themselves, and frames are contended through the replacement policy rather than through a lock.

### Reference strings

Every process carries a `referenceString`. This is the one leg where memory is driven
deterministically rather than emergently, because the whole leg's teaching depends on the player
being able to replay a string under a different policy and get a comparable answer.

Three requirements on the generator:

1. **Locality-shaped.** Programs do not access memory uniformly; they work in one region for a
   while, then move to another. That is why demand paging works at all rather than being a
   disaster. Generate each string as a sequence of locality phases: pick a working set of pages,
   reference within it for a phase length drawn from the leg's `Rng`, then shift. The measured
   working set at any window must match the phase's set.
2. **Deterministic from the leg's `Rng` fork.** Same seed, same string, every time. Assert
   byte-equality across two runs.
3. **The working set sizes above are the target.** Tune phase widths so that the measured
   `MemoryMetrics.workingSets` entry for each convoy Program at the crossing's mid-point equals
   the frozen table. Freeze the generator parameters once the first correct implementation
   establishes them.

Validate the generator against `VM-WS-1` and `VM-WS-2`. Window Δ=10 over `2 6 1 5 7 7 7 7 5 1`
gives WS = {1,2,5,6,7}, WSS = 5. Window Δ=10 over `3 4 3 4 4 4 3 4 4 4` gives WS = {3,4},
WSS = 2. If your working set estimator does not reproduce both, the estimator is wrong and
nothing downstream of it is measurable.

### The scripted teaching strings

Two strings are fixed constants rather than generated, because they are the leg's instruments and
their fault counts are quoted in the curriculum.

**The comparison string**, posted at the reach console:

```
7, 0, 1, 2, 0, 3, 0, 4, 2, 3, 0, 3, 2, 1, 2, 0, 1, 7, 0, 1
```

Twenty references, three frames. Fault counts, from `VM-FIFO-1` through `VM-LFU-1`:

| Policy | Faults | Eviction order |
|---|---|---|
| `fifo` | **15** | 7, 0, 1, 2, 3, 0, 4, 2, 3, 0, 1, 2 |
| `lru` | **12** | 7, 1, 2, 3, 0, 4, 0, 3, 2 |
| `clock` | **14** | 7, 1, 2, 0, 3, 4, 2, 0, 3, 1, 2 |
| `optimal` | **9** | 7, 1, 0, 4, 3, 2 |
| `lfu` | **13** | 7, 1, 2, 3, 4, 2, 1, 2, 1, 7 |
| `random` | recorded at implementation, seed `root/vm` from 1234 | recorded |

`obj.drowned_reach.replacement_choice` requires the leg's own fault count within 20 percent of
optimal. On this string optimal is 9, so the admissible band is up to 10.8 faults, which
**only optimal itself reaches**. That is correct and it is not a bug in the objective: the
objective is measured against the **leg's** reference string, not this one. This string is the
teaching instrument. Tune the leg's own string so that `lru` and `clock` both land inside 20
percent of optimal on it and `fifo` and `lfu` do not, and freeze all six counts.

The eviction orders matter as much as the counts. `belady --compare` prints the frame contents at
each step, and the player who is checking will check the order.

**The anomaly string**, posted beside it:

```
1, 2, 3, 4, 1, 2, 5, 1, 2, 3, 4, 5
```

Twelve references. Fault counts at three and four frames:

| Policy | 3 frames | 4 frames | Property |
|---|---|---|---|
| `fifo` | **9** | **10** | more frames, more faults. The anomaly. |
| `lru` | 10 | 8 | monotonic. A stack algorithm cannot do this. |
| `optimal` | 7 | 6 | monotonic. |

`VM-BELADY-1` asserts `faults(4) > faults(3)`. `VM-BELADY-2` and `VM-BELADY-3` assert
`faults(4) <= faults(3)`, which is the stack-algorithm property.

Nine and ten. Those two numbers are the whole of the first misconception and they must be
exactly right.

### The effective access time arithmetic

`obj.drowned_reach.effective_access_time` reads `MemoryMetrics.faultRate` converted to a
per-access probability under 0.004 across the crossing window.

`VM-EAT-1`: `(1-p) * 200 + p * 8e6` nanoseconds, for p in 0, 1e-6, 2.5000625e-6, 1e-5, 1e-4,
1e-3, gives 200.0000, 207.9998, 219.9995, 279.9980, 999.9800 and 8199.8000 ns.

`VM-EAT-2`: the p for 10 percent degradation is 2.5000625e-6, which is one fault per 399,990
accesses.

The `vmstat` man page states the same thing in prose: "a fault rate p of just 1 in 1000 makes the
average access about 40 times slower than memory. To keep the slowdown under 10 percent you need
p below roughly 1 in 400,000. Page fault rates are not judged on a scale where 1 percent sounds
small."

Post the `VM-EAT-1` table at the reach console so the player can read their own fault rate off
it. The objective's 0.4 percent threshold corresponds to an effective access time under three
times the memory access, which is generous against the 10 percent figure and is the right
difficulty for a leg the player is crossing under pressure.

---

## Stage

This section is the specification of the showpiece. Build it exactly.

### The ocean

A single plane, 3000 x 3000 m, at `y = 0`, two triangles, one shader. **There is no fluid
simulation and no wave mesh.** Vertex displacement is not applied. The plane stays flat and the
perturbation exists only in the normal used for the fresnel and the reflection offset. A flat
plane reflecting distorted light reads as a still, deep, black liquid, and it costs nothing.

```glsl
// src/legs/drowned_reach/ocean.frag.glsl
uniform float uTime;
uniform float uAgitation;     // 0 calm, 1 thrashing critical
uniform vec3  uFloorTint;     // VOID.floor
uniform sampler2D uReflection;

varying vec3 vWorld;

void main() {
  // Surface perturbation exists only to break up the reflection. Amplitude is
  // 6 cm at rest, doubling under thrashing. Two octaves, scrolling in opposite
  // directions so no repeating pattern is visible.
  vec2 p = vWorld.xz * 0.09;
  float n = vnoise(vec3(p + vec2(uTime * 0.03, 0.0), uTime * 0.02)) * 0.7
          + vnoise(vec3(p * 2.7 - vec2(0.0, uTime * 0.021), uTime * 0.03)) * 0.3;
  float amp = 0.06 * (1.0 + uAgitation);
  vec3 nrm = normalize(vec3(dFdx(n) * amp * 40.0, 1.0, dFdy(n) * amp * 40.0));

  float ndv = clamp(dot(nrm, normalize(cameraPosition - vWorld)), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  vec2 suv = gl_FragCoord.xy / uResolution;
  vec2 distort = nrm.xz * 0.035;
  vec3 refl = texture2D(uReflection, suv + distort).rgb;

  // The water is black. Everything you can see in it is the convoy's own light.
  gl_FragColor = vec4(uFloorTint + refl * fres * 0.55, 1.0);
}
```

The water has no colour of its own and no specular highlight from a light source, because there
is no light source. Everything visible in it is a reflection of the convoy's own emission and of
the resident tiles. When the convoy's light goes out, the water is indistinguishable from the
void, and that is the point.

`uAgitation` is driven from `MemoryMetrics.faultRate` and from cube impacts, never from time.
Its mapping is given in the thrashing section.

### Pages as ground

Each virtual page maps to one hexagonal tile of 1.60 m circumradius.

Hexagons rather than squares for two reasons: the tiled region's boundary reads as an organic
island rather than as a chart, and a hex has six neighbours, so locality of reference produces a
compact blob instead of a cross.

The mapping from `PageId` to tile position is a **deterministic spiral from the origin**,
computed in `src/legs/drowned_reach/hexmap.ts`, so a page's location is stable across a replay
and a page's neighbours in the tiling are its neighbours in the address space.

That last property is load-bearing. It is what makes the working set legible as a shape: a
Program working within pages 40 to 52 produces a compact blob of solid ground, and a Program
striding across its address space produces scattered islands the convoy cannot walk between. The
player reads locality off the ground without being told the word.

Tiles are one `InstancedMesh`. Per-instance attributes:

| Attribute | Meaning |
|---|---|
| `aState` | 0 absent, 1 materialising, 2 resident clean, 3 resident dirty, 4 dissolving |
| `aPhase` | 0 to 1 within the current state |
| `aFrame` | the `FrameId`, drawn as a hairline etched into the surface |
| `aHeight` | current `y` |

**One draw call for the whole ground, at any tile count.** This is not an optimisation, it is a
requirement: at critical severity there can be dozens of tiles in transition at once and the
draw call budget is 220 at low tier for the entire scene.

### Materialising

| Event | What happens |
|---|---|
| `memory.page_fault { page, major }` | A caustic ring appears on the water at the tile's centre, radius 3.2 m, contracting to 1.6 m over the fault's service time. It is a thin `CYAN.dim` ring drawn into the ocean shader as an extra term, so it appears to be under the surface rather than on it. Major faults also open a beam from the tile to the platter structure at the horizon. |
| `memory.page_loaded { page, frame }` | The tile rises from `y = -0.9` to `y = 0.0` over 260 ms with `EASE.out` and a 6 percent overshoot, water displacing off its top face as a brief radial ripple in the ocean's `uAgitation` field. Its six edges light `CYAN.core` at `active` for 80 ms, then settle to `dim`. The frame index etches in as a `SLATE.protected` hairline at 0.09 m cap height. |
| `memory.access { write: true }` | The tile's state goes to dirty: its surface gains the diagonal hatch and its edges go `AMBER.core` at `dim`. |
| `memory.access { hit: true }` | The tile's centre pulses to `active` for 90 ms. Watching the convoy walk, the player sees a trail of pulses behind them, which is the working set made visible. |

**The pause between the ring and the rise is the fault service time.** It is not a fixed
animation duration. A major fault reads the backing store and takes longer, and the beam to the
horizon is what tells the player which kind of fault they just took. A minor fault, including a
copy-on-write copy, has no beam and a shorter contraction. The player learns to tell them apart
by feel long before they run `vmstat --faults`, and then `vmstat` confirms what they already
knew, which is the correct order.

**The convoy can only stand on resident tiles.** Movement is constrained to the tiled region,
and the game does not prevent the player from walking toward the edge. Walking off a tile is a
page fault, which materialises the tile ahead, which is exactly how demand paging works and
which the player discovers in the first thirty seconds of the leg.

That discovery is the leg's opening and it must land in the first thirty seconds. Sequence it:

1. The convoy stands on a small island of resident ground, six or seven tiles, water to the
   horizon in every direction. No instruction. No marker.
2. The player moves. The lead Program's foot leaves the tiled region.
3. The caustic ring appears under the foot that is already falling. The pause is real and it is
   uncomfortable.
4. The tile rises into the foot with a 6 percent overshoot and the Program lands on it.
5. Nothing is said. The player does it again.

Step 3 is the whole leg in one moment. The ground forms under a foot that is already committed,
and the player feels the fault as a hesitation rather than reading it as a number. Do not
shorten the pause to make the movement feel better. The pause is the cost.

### Eviction

On `memory.page_evicted { frame, page, dirty, policy }`:

1. **If dirty**, an `AMBER.core` ribbon beam opens from the tile to the platter at the horizon
   and flows for 200 ms. The tile stays lit and solid throughout. This delay is the write-back
   cost and the player will learn to feel it.
2. The tile's edges ramp to zero over 120 ms.
3. The tile dissolves using the **derezz shader** at `cell = 0.12`, `uDispersion = 0.35`,
   `uGravity = 9.8`, `uOrigin` at the tile's centre, over 340 ms. The cubes fall into the water.
   Each cube that hits `y = 0` adds a ripple to the ocean's agitation field.
4. The water closes over the tile's footprint. **There is no marker left behind.** The page is
   gone and there is no way to tell from the surface that it was ever there.

Step 4 is the hardest discipline in the leg and the most important. Every instinct says to leave
a ghost, a faint outline, a "this was here" trace, because it helps the player find their way. Do not.
A page that is not resident does not exist. The absence of any trace is what makes the ground
feel provisional, and the provisionality is the concept.

**Total eviction time: 660 ms for a dirty page, 460 ms for a clean one.** Compare that against
the 260 ms rise at calm and note that eviction is already slower than formation when nothing is
wrong. Under critical severity the rise slows to 520 ms while eviction stays at 340 ms plus the
ramp, and the relationship inverts. That inversion is the mechanical heart of the whole leg and
it is stated again in the thrashing section because it is the thing to get right.

**If the convoy is standing on a tile that gets evicted, the convoy falls, and falling costs
integrity on every member.** Nothing prevents this. The replacement policy chose that victim,
and the player chose the replacement policy.

### The working set as visible extent

The player never sees a number called "working set" until they run `ws`. What they see is the
extent of solid ground around the party, and that extent **is** the working set, drawn.

Three properties make it readable:

1. **The hex neighbourhood mirrors the address space.** Pages adjacent in the spiral are
   adjacent on the ground. A Program working within a tight page range stands on a compact blob.
2. **Hit pulses trail the convoy.** `memory.access { hit: true }` pulses the tile centre for 90
   ms. Walking, the player leaves a trail of pulses across the tiles they are actively using,
   and the shape of that trail across the last window of ticks is the working set.
3. **Each Program's tiles carry its frame hairlines.** `aFrame` etches the `FrameId` into the
   surface. Under local replacement, one Program's ground is visibly its own. Under global
   replacement, the frame indices on the ground around a faulting Program start belonging to
   somebody else, which is `obj.drowned_reach.global_versus_local` made visible before it is
   named.

When the player finally runs `ws`, the numbers confirm a shape they have been standing on for
ten minutes. That is the intended order and it is why the command is introduced here rather than
earlier.

### Thrashing

Driven by `memory.thrashing { faultRate, severity }` and by `MemoryMetrics.faultRate`.

**The core relationship the leg teaches: tiles ahead of the convoy is a function of the fault
rate, and the fault rate is a function of the degree of multiprogramming.**

```ts
/** Number of resident tiles ahead of the convoy's lead Program along its heading.
 *  This is the number the player is actually managing, and it is what the whole
 *  leg's difficulty rests on. */
export function tilesAhead(m: MemoryMetrics, cfg: KernelConfig): number {
  const ratio = m.faultRate / cfg.thrashingThreshold;   // 1.0 = at the threshold
  // At ratio 0 the ground extends comfortably. At ratio 1 it is marginal. Above
  // 1.6 the convoy cannot maintain a step.
  return Math.max(0, Math.round(9 * Math.pow(Math.max(0, 1 - ratio * 0.62), 1.4)));
}
```

Copy this function verbatim. Do not re-derive it, do not re-tune the constants, and do not
replace it with a lookup table. Its shape is the leg's difficulty curve.

| `ratio` | `tilesAhead` | What it feels like |
|---|---|---|
| 0.0 | 9 | a comfortable path |
| 0.5 | 6 | fine, and you can see the edge |
| 1.0 | 3 | requires attention |
| 1.3 | 1 | one step of margin |
| 1.6 | 0 | stepping onto tiles that have not finished rising |

**Warning severity.** On `memory.thrashing { severity: 'warning' }`:

- The horizon band dims by 40 percent.
- Tile rise time increases from 260 ms to 365 ms.
- Ocean agitation goes from 0.0 to 0.45.
- The HUD fault-rate meter enters its amber band.
- The convoy's stride shortens by 15 percent, which the player feels before they read anything.

That last item is the one to get right. The stride change is proprioceptive: the player is
moving and the movement changes. Nothing is announced. Most players notice the stride before the
meter.

**Critical severity.** On `memory.thrashing { severity: 'critical' }`, everything from warning
plus:

- **Tiles begin dissolving while the convoy is standing on them.** Eviction no longer respects
  occupancy, because the kernel does not know or care where the convoy is standing.
- **Camera FOV widens from 46 to 52 degrees over 900 ms with `EASE.inOut`.** This is the only
  FOV change in the game. Widening the FOV while the ground shrinks makes the tiles appear to
  fall away from the camera, and it produces a physical sensation of the floor going out from
  under the player without moving the camera at all. It reverses over 900 ms when the fault rate
  drops below the threshold. **Disabled under `reducedMotion`.**
- Ocean agitation reaches 1.0. The reflections break up, which means the convoy's own light stops
  being readable in the water, which removes the last depth cue.
- Global ambient drops from 0.06 to 0.024, so the matte bodies of the convoy's own stele go
  nearly black and only their emissive edges remain.
- **Tile rise time increases to 520 ms while eviction stays at 340 ms.** This is the mechanical
  heart of the whole leg: **the ground now fails faster than it forms**, and no amount of player
  skill at moving can fix it, because the problem is not where the convoy is standing.

### The thrashing spiral, step by step

Specify the collapse as a sequence, because it has to accelerate while the player is deciding
and that is a timing problem rather than a rendering one.

**Phase 0, stable.** Degree at or below what the frame budget supports. `faultRate` well under
200. `tilesAhead` at 6 to 9. The convoy walks. Evictions happen and they happen behind the
convoy, out of the path, because the replacement policy is picking pages nobody is about to
need.

**Phase 1, pressure.** The player raises the degree, or a drifter is admitted, or rations were
set too generous and the workload is short. Each admitted process's resident set falls. Fault
rate climbs toward 200. `tilesAhead` drops to 4 or 5. The player can still see the edge of the
ground ahead and it is closer than it was.

**Phase 2, warning.** `faultRate` crosses 200. `memory.thrashing { severity: 'warning' }` fires.
Stride shortens 15 percent, rise time goes to 365 ms, agitation to 0.45, horizon dims 40 percent.
`tilesAhead` is 3. The codex entry `codex.thrashing` is added here, so the remedy becomes
readable at exactly this moment.

**Phase 3, the offer.** The reach console offers, in plain and reasonable language:

> "Processor utilisation is at 22 percent. Admit two more Programs?"

The utilisation figure is **real**, read from `SchedulingMetrics.cpuUtilisation`, and it is
genuinely low, because everything is blocked on paging. The offer is genuinely the correct
response to low utilisation under every circumstance except this one. Taking it is correct
reasoning from a wrong model.

**Phase 4, acceleration.** If the offer is taken, the two new Programs get frames taken from
Programs that were already short. Every resident set falls further. Every fault evicts a frame
another Program is about to need. `faultRate` climbs past 320, `ratio` past 1.6, `tilesAhead`
reaches 0.

The collapse is now self-sustaining and the leg gives the player about **40 ticks** before
certain death. That number is the design's, from the curriculum map: taking the option
"accelerates the collapse to certain death within about 40 ticks". Freeze it and assert it.

**Phase 5, critical.** `memory.thrashing { severity: 'critical' }`. FOV widens. Tiles dissolve
under standing Programs. Rise 520 ms against eviction 340 ms. The convoy is standing on almost
nothing and the ground is going faster than it comes.

**Phase 6, the way out, which is on screen the whole time.** The number of convoy stele standing
on the water is the degree of multiprogramming. Every Program the player has running is one more
working set competing for the same frames. When the player finally suspends one,
`degreeOfMultiprogramming` drops, the fault rate falls, `tilesAhead` climbs, and **the ground
comes back, visibly, in about two seconds.**

Two seconds. That recovery has to be fast and legible, because it is the moment the player
understands the whole leg. The causal chain from "I suspended one Program" to "the ground came
back" must be short enough to feel like cause and effect rather than like luck.

**The remedy is on screen the entire time and the game never says it. That is the design thesis
from section 1 of the brief, executed.**

### Hero visual

The convoy standing on a single hexagonal tile, black water on all six sides, no other ground in
view to the horizon, watching the tile they are standing on begin to fracture.

That frame must be reachable in normal play, at every quality tier, and it must be the frame a
player remembers. Verify it exists by driving the runner into phase 5 and capturing it.

### Anchors

| Anchor id | Structure | Focus camera target |
|---|---|---|
| `anchor.reach` | The whole crossing, water to the horizon | wide establishing; the hero shot frames from here |
| `anchor.ocean` | The ocean plane | not a lock target; carries `uAgitation` |
| `anchor.tile.<pageId>` | One anchor per resident tile, created on materialise and destroyed on dissolve | head-on; the frame hairline legible |
| `anchor.reach_console` | Replacement policy, rations, degree, and the admit offer | head-on orthographic; policy, fault rate, utilisation and degree all in one frame |
| `anchor.reference_board` | The two scripted strings, posted | head-on orthographic; both strings legible in full |
| `anchor.eat_table` | The `VM-EAT-1` table, posted beside the console | head-on |
| `anchor.frame_slabs` | The 48 frames as a physical rank, each showing its owner and its reference bit | head-on orthographic; **the clock hand rotates over these** |
| `anchor.clock_hand` | The rotating arm over the frame slabs, position from `PageReplacementSnapshot.handIndex` | included in the frame slab framing |
| `anchor.ws_beacon` | The working set beacon: measured working set per process, live | head-on; all admitted processes and the budget sum in one frame |
| `anchor.platter_horizon` | The backing store at the horizon. Major faults beam to it; dirty evictions beam from tiles to it. | visible from everywhere; never a lock target |
| `anchor.lru_meter` | The exact-LRU purchase and its per-access bandwidth drain | head-on; the meter must visibly drain while the policy is active |
| `anchor.fork_post` | The scout fork, with copy-on-write as an option | head-on |
| `anchor.convoy.<member>` | Per-Program stele | head-on |

### Performance

The draw call budget is 220 / 450 / 900 at low / medium / high, for the entire scene. The ground
is one draw call. The ocean is one. The reflection target is one pass. That leaves ample room,
which is why this leg can afford the derezz dissolve on many tiles at once.

The constraint that binds is **concurrent derezz**: 2 at low, 6 at medium, 16 at high. At
critical severity more than 16 tiles can be dissolving simultaneously. Handle this by pooling
and aggregating per the visual bible's budget rules: dissolves beyond the cap are collapsed into
a shared instanced dissolve at reduced cube count rather than dropped. **An eviction must never
be silently skipped visually**, because a tile that vanishes without dissolving reads as a bug
and a tile that stays after being evicted is a lie about the simulator's state.

Derezz cube cap is 600 at low, 1800 at medium, 4096 at high. A single tile dissolve at
`cell = 0.12` on a 1.60 m circumradius hex is well inside that; the aggregation rule is about
concurrency rather than about any one tile.

---

## Interactions

```ts
export const interactions: readonly InteractionDef[] = [
  {
    id: 'reach.set_replacement',
    label: 'Set the replacement policy',
    description: 'Which page is evicted when a frame is needed. Six choices and one of them can get worse when you give it more frames.',
    anchor: 'anchor.reach_console',
    cost: { cycles: 8 },
    enabledWhen: (run) => run.resources.cycles >= 8,
  },
  {
    id: 'reach.set_rations',
    label: 'Set rations',
    description: 'Frames guaranteed per Program. Generous 24, standard 16, lean 10, starved 6. There are 48 frames.',
    anchor: 'anchor.reach_console',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'reach.set_degree',
    label: 'Set the degree of multiprogramming',
    description: 'How many Programs are admitted to memory. Two to nine.',
    anchor: 'anchor.reach_console',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'reach.admit_more',
    label: 'Admit two more Programs',
    description: 'Processor utilisation is low. More admitted processes mean more chances something is ready when the processor is free.',
    anchor: 'anchor.reach_console',
    cost: {},
    enabledWhen: (run) => run.policy.degreeOfMultiprogramming <= 7,
  },
  {
    id: 'reach.suspend',
    label: 'Suspend a Program',
    description: 'Swap it out entirely, freeing all its frames at once.',
    anchor: 'anchor.reach_console',
    cost: { bandwidth: 4 },
    enabledWhen: (run) => run.resources.bandwidth >= 4,
  },
  {
    id: 'reach.set_replacement_scope',
    label: 'Global or local replacement',
    description: 'Whether a faulting Program may take a frame from another Program.',
    anchor: 'anchor.frame_slabs',
    cost: { cycles: 10 },
    enabledWhen: (run) => run.resources.cycles >= 10,
  },
  {
    id: 'reach.buy_exact_lru',
    label: 'Buy exact LRU',
    description: 'An exact ordering updated on every memory access. Charged per access.',
    anchor: 'anchor.lru_meter',
    cost: { bandwidth: 0 },   // charged continuously per access while active, not at commit
    enabledWhen: (run) => run.resources.bandwidth > 0,
  },
  {
    id: 'reach.fork_scout',
    label: 'Fork the scout',
    description: 'Copy the address space, or share it until somebody writes.',
    anchor: 'anchor.fork_post',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'reach.kestrel_prefetch',
    label: 'KESTREL: prefetch',
    description: 'Satisfy the next five page faults instantly.',
    anchor: 'anchor.reach',
    cost: { bandwidth: 10 },
    enabledWhen: (run) => kestrelAlive(run) && run.resources.bandwidth >= 10,
  },
  {
    id: 'reach.vesper_remap',
    label: 'VESPER: remap',
    description: 'Rebuild one page table with optimal locality, lowering that Program working set for the rest of the leg.',
    anchor: 'anchor.ws_beacon',
    cost: { bandwidth: 8 },
    enabledWhen: (run) => vesperAlive(run) && run.resources.bandwidth >= 8,
  },
];
```

### On `reach.admit_more`

This is the single most instructive wrong button in the game and its construction has to be
exact.

- **The label and description are reasonable and true.** More admitted processes do mean more
  chances that something is ready when the processor is free. That is a correct statement about
  scheduling and it is why the button exists.
- **The utilisation figure quoted is real**, read live from `SchedulingMetrics.cpuUtilisation`.
- **It appears when thrashing begins**, not before and not after. Gate it on the first
  `memory.thrashing { severity: 'warning' }`.
- **It is not styled as a warning, a risk or a trap.** It looks like every other console option.
- **Taking it accelerates the collapse to certain death within about 40 ticks.** Freeze and
  assert that window.
- **It is recorded in the decision log** with `kind: 'admit_during_thrashing'` and
  `outcome: 'pending'`, marked `fatal` when the collapse kills someone. It is the leading
  candidate for panel 5 of the end-of-run report.

The `degree` man page names the diagnostic that separates the two cases and it is the only place
the answer is written down: "Idle processor with a low fault rate means admit more work. Idle
processor with a high fault rate means suspend something." A player who has read it will not
take the button. Most players have not read it.

### On `reach.buy_exact_lru`

The cost is charged **per memory access**, continuously, while the policy is active. It is not a
flat purchase. The bandwidth meter drains visibly and constantly, and the player watches it, and
after a while they run `belady --compare` and see clock landing within a few faults of LRU on
the leg's string, and they stop paying. That sequence is the third misconception and the pricing
model is the whole of it.

Clock costs one bit per frame and a hand position, and the hand is drawn in the world as a
rotating arm over the frame slabs, from `PageReplacementSnapshot.handIndex`. The player can
watch the mechanism that costs almost nothing running beside the meter that costs continuously.

---

## Terminal commands

Four commands, copied verbatim from the curriculum map into
`src/legs/drowned_reach/commands.ts`: `vmstat`, `ws`, `belady`, `degree`. The full `manual` text
is in `docs/05-CURRICULUM-MAP.md`, "Leg 8. THE DROWNED REACH". Copy byte for byte; a test asserts
the match against a checked-in fixture.

Load-bearing lines you must not lose in transcription:

- `vmstat`: "a fault rate p of just 1 in 1000 makes the average access about 40 times slower
  than memory. To keep the slowdown under 10 percent you need p below roughly 1 in 400,000. Page
  fault rates are not judged on a scale where 1 percent sounds small."
- `vmstat`: "Watch the eviction count against the fault count. When they rise together and stay
  together, pages are being evicted and immediately faulted back in, which is the shape of
  thrashing."
- `ws`: "if a process has fewer frames than its working set, it will fault continuously, and
  giving it more processor time will not help. A process below its working set is not slow. It
  is unable to make progress, because every page it needs evicts another page it needs."
- `ws --budget`: "If the sum exceeds the supply, no allocation policy can fix it. Something has
  to be suspended. That is not a failure of the memory system; it is the memory system telling
  you the truth about the workload." With the frozen working sets summing to 56 against 48
  frames, this command tells the player the leg's central fact the first time they run it.
- `belady`: "fifo ... suffers Belady anomaly: adding frames can increase faults. Try --frames 3
  and then --frames 4 on the scripted string and read the totals." That sentence is the
  instruction for `obj.drowned_reach.reproduce_belady` and it is the only instruction the leg
  gives.
- `belady`: "A note on the gap between lru and clock. Exact LRU requires updating an ordering on
  every access, in hardware, on the critical path of every load and store. Nobody does this.
  Clock gets most of the benefit from one bit and a pointer. When you pick lru here you are
  picking a model; when a real kernel picks it, it picks clock."
- `degree`: "Here is the trap, and it has killed more convoys than any other single thing on
  this crossing." The whole paragraph after it is the answer to the button, and it is written in
  the man page rather than in the interface.
- `degree`: "Tell the two apart by reading the fault rate, not the utilisation."

### `belady --compare` implementation contract

The leg's arbiter and the instrument all three of its terminal-assessed objectives run through.

1. Record the leg's own reference string as it is consumed, per process and merged.
2. `belady --policy <id> --frames <n> --string <refs>` replays a string under a policy at a frame
   count and returns the fault count **and the frame contents at each step**.
3. `belady --compare` runs all six policies at the current frame count on the current string.
4. The replay uses a shadow memory manager. It must not touch the live frame table, must not
   emit into the live event stream, and must not advance the leg's `Rng`. Assert over 200
   invocations that the live event log hash is unchanged.
5. `optimal` requires a reference string lookahead. It is available here because the string is
   recorded and finite. Do not make `optimal` available as a live `replacementPolicy` for the
   crossing itself; it exists as a yardstick.
6. On the scripted comparison string at three frames, the six results must be exactly the
   `VM-*` fixture values, including eviction orders.
7. On the scripted anomaly string, `fifo` at three frames returns 9 and at four returns 10.

Reuse WP-18's shadow-run machinery, or leg 7's shadow memory manager behind `frag --compare` if
that shipped first. The two commands are the same idea over different subsystems and the
codebase should have one of them. Report which you used.

---

## Event table

Copied verbatim from `04-NARRATIVE-BIBLE.md` section 8, leg 8. Weights sum to 100. Note that
`reach.beladys_step` carries a comment rather than a predicate in the source; implement the
predicate in the leg module.

```ts
export const drownedReachEvents: readonly RandomEventDef[] = [
  {
    id: 'reach.ground_recedes',
    weight: 14,
    title: 'Faster Out Than In',
    narration: 'Pages are being evicted ahead of the convoy faster than the convoy can fault them in. The ground is arriving late and leaving early and there is water on both sides.',
    targets: null, inflicts: 'thrashing',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'reach.eviction_wave',
    weight: 13,
    title: 'Eviction Wave',
    narration: 'A replacement pass takes every frame the convoy touched more than forty ticks ago. Most of it will be needed within twenty.',
    targets: null, inflicts: null,
    resourceDelta: { quota: -90 },
    onlyIf: null,
  },
  {
    id: 'reach.beladys_step',
    weight: 10,
    title: 'More Frames, More Faults',
    narration: 'The convoy is given four extra frames and the fault rate rises. Under this replacement policy that is a legal outcome and nobody is going to explain it.',
    targets: null, inflicts: null,
    resourceDelta: { quota: -60, cycles: -30 },
    onlyIf: (run) => currentReplacementPolicy(run) === 'fifo',
  },
  {
    id: 'reach.dirty_writeback',
    weight: 12,
    title: 'Dirty',
    narration: 'Every frame selected for eviction has been written to, so every eviction is two operations instead of one. The backing store is the only thing here making progress.',
    targets: null, inflicts: null,
    resourceDelta: { bandwidth: -10, cycles: -35 },
    onlyIf: null,
  },
  {
    id: 'reach.clock_hand',
    weight: 11,
    title: 'Second Sweep',
    narration: 'The clock hand goes all the way around without finding a frame whose reference bit is clear. It goes around again and clears them itself.',
    targets: null, inflicts: 'cache_thrash',
    resourceDelta: { cycles: -25 },
    onlyIf: null,
  },
  {
    id: 'reach.working_set_beacon',
    weight: 15,
    title: 'Working Set Beacon',
    narration: 'A beacon on a standing spar reports the measured working set of everything within range, per process, updated continuously. VESPER stops estimating and starts reading.',
    targets: 'cartographer', inflicts: null,
    resourceDelta: { quota: 85, cycles: 25 },
    onlyIf: null,
  },
  {
    id: 'reach.prepage_shoal',
    weight: 14,
    title: 'Warm Shoal',
    narration: 'A stretch of the Reach is already resident because something crossed here recently and nothing has reclaimed it yet. The convoy walks forty segments without a single fault.',
    targets: null, inflicts: null,
    resourceDelta: { quota: 70, cycles: 40 },
    onlyIf: null,
  },
  {
    id: 'reach.pinned_causeway',
    weight: 11,
    title: 'Pinned Causeway',
    narration: 'Somebody pinned a narrow line of frames across the deep water and then did not come back for them. The pins hold for as long as the convoy needs them.',
    targets: null, inflicts: null,
    resourceDelta: { quota: 60, blocks: 12 },
    onlyIf: null,
  },
];
```

Four of these events must act on the live memory system rather than only on the ledger, because
the player is standing on the memory system and a narrated change that does not happen is
visible as a lie:

- `reach.eviction_wave` genuinely evicts every frame untouched for 40 ticks. The player watches a
  band of ground dissolve.
- `reach.prepage_shoal` genuinely marks a stretch of pages resident. The player walks onto
  ground that is already there and takes no faults.
- `reach.pinned_causeway` genuinely sets `Frame.pinned` on a line of frames across the water.
  Pinned frames are never selected as victims, so the causeway holds through a collapse, which
  is the only thing in the leg that does.
- `reach.clock_hand` fires only under `clock` and genuinely runs the second sweep, clearing
  reference bits. Add the predicate.

---

## Evaluation

### Survival

The leg is survived when at least one convoy Program is alive at leg end.

**Thrashing is the signature death of the game.** As the degree of multiprogramming rises past
what the frame budget supports, every Program's resident set falls below its working set, so
every Program faults on almost every access, so every fault evicts a frame another Program is
about to need. Processor use collapses because everything is blocked on paging. The ground
dissolves faster than it forms and the convoy is standing on almost nothing.

`memory.thrashing` fires at `severity: 'warning'`, Programs acquire `thrashing` (4 integrity per
travel tick, fatal after 25 in this leg's instance; the ambient table value of 2.0 per tick and
90 ticks is the out-of-leg baseline and this leg overrides it), and at `severity: 'critical'` a
Program derezzes with `TerminationReason: 'thrashing_collapse'`.

**LUMEN is vulnerable to thrashing** per the convoy table, so the compiler is usually the first
to go, and losing LUMEN raises every later leg's service times by 15 percent. Do not compensate
for this. It is the convoy composition doing its job.

The epitaph cause line reads exactly:

> "it faulted 41 times in 50 ticks. Its working set was 14 frames. It had been allocated 6."

Fourteen is LUMEN's frozen working set from the table above and six is the `starved` ration. The
numbers in the epitaph must be the numbers the simulator produced, so read them from
`MemoryMetrics` at the moment of death rather than hardcoding, and assert that on the golden bad
path they come out as 14 and 6.

`codexEntry` is `codex.thrashing`.

**Falling.** If the convoy is standing on a tile that gets evicted, they fall, and falling costs
integrity on every member. That is a second damage source, separate from the affliction, and it
only occurs at critical severity where eviction stops respecting occupancy.

**The remedies** are `{ kind: 'reduce_degree', by: 2 }`, or moving from global to local
replacement, or raising rations at the cost of admitting fewer Programs. All three work. The
first is fastest and the third is the one that looks most like generosity and is not.

### Objectives

| Objective | Computed from |
|---|---|
| `obj.drowned_reach.effective_access_time` | `MemoryMetrics.faultRate` converted to a per-access probability, under 0.004, across the crossing window. |
| `obj.drowned_reach.replacement_choice` | The leg's `MemoryMetrics.pageFaults` against a shadow run of `optimal` on the identical reference string, requiring a ratio under 1.20, **and** at least one `belady --compare` invocation. |
| `obj.drowned_reach.reproduce_belady` | Two `belady` invocations on the scripted anomaly string differing only in frame count, under `fifo`, with the higher count returning the higher fault total, **followed by** the same pair under `lru`. All four invocations required, in that order. |
| `obj.drowned_reach.working_set_allocation` | Each pid's allocated frame count against its `MemoryMetrics.workingSets` entry, and the sum against `totalFrames`. No Program below its working set and the total at or under 48. |
| `obj.drowned_reach.recover_from_thrashing` | After the first `memory.thrashing { severity: 'warning' }`, `degreeOfMultiprogramming` decreases **and** `faultRate` falls below `thrashingThreshold` **before** any convoy member's `integrity` reaches 40. |
| `obj.drowned_reach.global_versus_local` | A switch from global to local replacement following an eviction that took a frame from a non-faulting Program, **and** that Program's fault rate measurably falling afterwards. |
| `obj.drowned_reach.copy_on_write` | The scout fork cost fewer than four frames. Per `VM-COW-1`, a correct copy-on-write fork produces exactly one `memory.page_fault { major: false }`, one `memory.page_loaded` and zero `memory.page_evicted` when the child writes one shared page. |

`working_set_allocation` deserves a note, because it is the objective that looks impossible and
is not. The five convoy working sets sum to 56 against 48 frames, so it cannot be met with all
five admitted. It can be met at a degree of 4 by suspending the largest, or at a degree of 5 if
VESPER's remap has lowered one Program's working set enough. Both routes must work and both must
be reachable. Assert both.

### Debrief card

```ts
{
  headline: /* 'Across the Reach.' or 'The ground went first.' */,
  whatHappened:
    `You crossed under ${policy} at ${rations} rations with a degree of ${degree}. ` +
    `Peak fault rate ${peakRate} per thousand ticks against a threshold of 200. ` +
    `Faults ${faults}, evictions ${evictions}, write-backs ${writeBacks}. ` +
    `Optimal on your reference string was ${optimalFaults}.`,
  whyItHappened: /* selected */,
  counterfactual: /* a real WP-18 replay */,
  chapter: { chapter: 10, title: 'Virtual Memory', sections: ['10.6.1'] },
}
```

`whyItHappened`, selected by what actually occurred:

- **The admit offer was taken.** "Processor utilisation was 22 percent because every admitted
  Program was blocked on paging. Admitting two more gave them frames taken from Programs that
  were already short of them."
- **A Program died of thrashing.** "${name}'s working set was ${ws} frames and it held ${held}.
  Below its working set a process is unable to make progress, because every page it needs
  evicts another page it needs. Processor time would not have helped."
- **Rations were generous.** "Generous rations pinned ${pinned} of 48 frames for the convoy.
  What the convoy did not use, the workload could not have."
- **FIFO held for the crossing.** "FIFO evicted the oldest loaded page ${evictions} times without
  consulting whether anything still needed it. Optimal on the same string faults
  ${optimalFaults} times."
- **Clean crossing.** "Every admitted Program held at least its working set and the sum stayed
  inside the budget."

The counterfactual is a **real WP-18 replay**, never a template. In priority order:

1. **The admit offer was taken and someone died.** Replay from the tick of the offer with the
   degree reduced by two instead:
   > "Reducing the degree at tick ${t} instead brings the fault rate to ${rate} within ${n}
   > ticks and ${name} reaches the far shore."
   This is the leg's headline counterfactual and it is the leading candidate for panel 5 of the
   end-of-run report.
2. **The crossing was made under a policy well off optimal.** Replay the recorded string under
   the best available policy:
   > "Your reference string under ${best} faults ${n} times against your ${actual}. Optimal is
   > ${opt}."
3. **Rations left the workload short.** Replay at the ration one step leaner and report the peak
   fault rate and the survivors.
4. `null`, only when the crossing was made with every Program at or above its working set, the
   fault rate never crossed the threshold, and nobody was lost.

---

## Acceptance criteria

Numbered and mechanically verifiable.

1. `src/legs/drowned_reach/index.ts` satisfies `Leg` under `tsc --strict`,
   `id === 'drowned_reach'`, `index === 8`.
2. The leg runs headlessly to completion via the smoke-test harness, with no Three.js or DOM
   import reachable from the leg module graph. The ocean shader and the hex map live in the leg
   directory and the hex map is importable headlessly.
3. `enabledSubsystems` deep-equals `['process', 'scheduler', 'memory', 'vm']`. No sync, deadlock,
   storage, io, fs or security subsystem is enabled.
4. `totalFrames === 48` and `thrashingThreshold === 200` and `replacementPolicy === 'fifo'` at
   leg entry. Asserted exactly.
5. Inert-field independence: mutating `diskPolicy`, `totalCylinders`, `raidLevel`,
   `fileAllocation`, `journalingEnabled` and `deadlockStrategy` leaves the canonical event log
   hash unchanged over 400 ticks.
6. Every objective can be met by the known-good decision sequence; all seven met in one run.
   Both routes to `working_set_allocation` are separately verified.
7. The known-bad sequence produces the intended failure: the admit offer taken at the warning,
   collapse to critical, LUMEN derezzing with `TerminationReason: 'thrashing_collapse'` and the
   epitaph reading 41 faults in 50 ticks, working set 14, allocated 6.
8. **The 40-tick window:** taking `reach.admit_more` at the first warning leads to a
   `thrashing_collapse` death within 40 ticks, plus or minus 4, on the golden seed. Frozen and
   asserted.
9. **The two-second recovery:** suspending one Program at critical severity raises `tilesAhead`
   from 0 to at least 3 within 2 seconds of wall time at 60 fps, which is 120 frames. Asserted
   in the render harness.
10. `VM-FIFO-1`, `VM-LRU-1`, `VM-CLOCK-1`, `VM-OPT-1` and `VM-LFU-1` reproduce exactly on the
    scripted comparison string at three frames, **including eviction orders**: 15, 12, 14, 9 and
    13 faults.
11. `VM-BELADY-1` reproduces exactly: `fifo` on the anomaly string gives **9** faults at three
    frames and **10** at four. `VM-BELADY-2` gives 10 and 8 under `lru`. `VM-BELADY-3` gives 7
    and 6 under `optimal`.
12. `VM-EAT-1` and `VM-EAT-2` reproduce to four decimal places at every listed probability.
13. `VM-WS-1` and `VM-WS-2` reproduce exactly through the leg's working set estimator.
14. `VM-THRASH-1` and `VM-THRASH-2` reproduce: demand D = 70 with m = 64 gives a warning and
    stops admission; D = 100 with m = 64 gives critical and suspends the largest working set.
15. `VM-COW-1` reproduces: a fork followed by the child writing one shared page produces exactly
    one `memory.page_fault { major: false }`, one `memory.page_loaded`, zero
    `memory.page_evicted`, and `cowRefCount` dropping from 2 to 1.
16. The frozen convoy working sets are produced by the reference string generator at the
    crossing's mid-point: LUMEN 14, SABLE 11, ORRERY 12, KESTREL 9, VESPER 10, summing to 56.
17. Reference strings are byte-identical across two runs from the same seed, and across a
    snapshot-restore at the midpoint.
18. `tilesAhead` is the verbatim function from the visual bible and returns 9, 6, 3, 1 and 0 at
    ratios 0.0, 0.5, 1.0, 1.3 and 1.6.
19. **Every tile transition is event-driven.** A test drives 2000 ticks, records every tile state
    change, and asserts a one-to-one correspondence with `memory.page_loaded`,
    `memory.page_evicted`, `memory.access` and `memory.page_fault` events. Zero unmatched
    transitions in either direction.
20. **No trace is left after a dissolve.** After a tile completes state 4, its instance is fully
    absent: `aState === 0`, no geometry, no decal, no ocean shader term at that footprint.
    Asserted by sampling the render target at the footprint before and after.
21. Timing is exact: rise 260 ms at calm, 365 ms at warning, 520 ms at critical. Dissolve 340 ms
    plus a 120 ms edge ramp. Dirty write-back adds 200 ms before the ramp. Total dirty eviction
    660 ms, clean 460 ms.
22. **The inversion holds:** at critical severity, rise time (520 ms) exceeds dissolve time
    (340 ms). Asserted as an arithmetic test on the timing constants, so a future tuning change
    that breaks the leg's central mechanic fails the build.
23. Ocean `uAgitation` is driven only from `MemoryMetrics.faultRate` and cube impacts, never
    from `uTime`. Asserted by holding the fault rate constant and checking agitation does not
    drift over 2000 frames.
24. The FOV widening is the only FOV change in the game, runs 46 to 52 degrees over 900 ms,
    reverses over 900 ms, and is disabled under `reducedMotion`. Asserted including the disabled
    case.
25. `reach.admit_more` appears only after the first `memory.thrashing { severity: 'warning' }`,
    quotes a live `cpuUtilisation` figure, and is not styled as a warning. Asserted on the
    interaction definition and on the rendered element's style tokens.
26. `belady --compare` never mutates the live frame table, event log or `Rng`, over 200
    invocations.
27. Exact LRU is charged per memory access and the bandwidth meter drains continuously while it
    is active. Asserted by measuring bandwidth over a window with the policy on and off.
28. The clock hand's world position tracks `PageReplacementSnapshot.handIndex` exactly.
29. `reach.eviction_wave`, `reach.prepage_shoal` and `reach.pinned_causeway` act on the live
    frame table. Pinned frames are never selected as victims, including at critical severity.
30. Event table weights sum to exactly 100; all ids unique; `reach.beladys_step` gates on `fifo`
    and `reach.clock_hand` gates on `clock`.
31. All four terminal command `manual` strings match the curriculum map byte for byte.
32. **The ground is one draw call** at any tile count, and the ocean is one. Total draw calls
    stay under 220 / 450 / 900 at the heaviest frame, which is critical severity with the
    maximum concurrent dissolves, the frame slab rank, the working set beacon and the reference
    board in view.
33. Concurrent dissolves beyond the tier cap (2 / 6 / 16) are aggregated into a shared instanced
    dissolve at reduced cube count. **No eviction is ever visually skipped.** Asserted by
    counting dissolve starts against `memory.page_evicted` events at critical severity.
34. The hero visual is reachable in normal play at every tier: the convoy on a single tile,
    water on all six sides, no other ground to the horizon, that tile fracturing. Captured from
    the harness and checked in as a reference frame.
35. **There is no depot.** Asserted by checking the leg registers no depot anchor and no depot
    interaction.

---

## Tests you must write

All under `tests/legs/drowned_reach/`. This directory is owned exclusively by this package.

**`contract.test.ts`**: `Leg` conformance, exact ids, the twenty-section chapters array, seven
objectives, every `chapter.sections` entry present in `chapters`.

**`config.test.ts`**: `enabledSubsystems` exact; `totalFrames === 48`;
`thrashingThreshold === 200`; `replacementPolicy === 'fifo'`; `agingInterval === 0`; inert-field
independence over 400 ticks; no depot registered.

**`populate.test.ts`**: eleven spawns (five convoy plus six drifters), five binds, exact page
counts, every spawn carrying a `referenceString`, zero resource and sync declarations.

**`refstrings.test.ts`**: the generator.
- Byte-identical strings across two runs from the same seed and across a snapshot-restore.
- `VM-WS-1` and `VM-WS-2` through the leg's estimator.
- The frozen working sets at the crossing mid-point: 14, 11, 12, 9, 10, summing to 56.
- Every string is locality-shaped: measured working set at any window matches the phase's set.

**`replacement.test.ts`**: the comparison string.
- All six policies on `7,0,1,2,0,3,0,4,2,3,0,3,2,1,2,0,1,7,0,1` at three frames.
- Fault counts exactly 15, 12, 14, 9, 13 and the recorded `random` value.
- Eviction orders exactly as the fixture table.
- The leg's own string: `lru` and `clock` inside 20 percent of optimal, `fifo` and `lfu` outside.
  All six counts frozen.

**`belady.test.ts`**: the anomaly.
- `VM-BELADY-1`: `fifo` on `1,2,3,4,1,2,5,1,2,3,4,5` gives **9** at three frames and **10** at
  four. Assert `faults(4) > faults(3)` explicitly, as the fixture does.
- `VM-BELADY-2`: `lru` gives 10 and 8. Assert `faults(4) <= faults(3)`.
- `VM-BELADY-3`: `optimal` gives 7 and 6. Assert `faults(4) <= faults(3)`.
- The objective requires all four invocations in order and fails if the `lru` pair is missing.
- `belady --compare` leaves the live frame table, event log and `Rng` unchanged over 200
  invocations.

**`eat.test.ts`**: `VM-EAT-1` at all six probabilities to four decimals; `VM-EAT-2`'s
2.5000625e-6 and its one-in-399,990 restatement. The objective's 0.004 threshold maps to an
effective access time under three times memory.

**`thrashing.test.ts`**: the spiral.
- `VM-THRASH-1` and `VM-THRASH-2` exactly.
- The six phases in order, from a scripted decision sequence, with the fault rate, `tilesAhead`
  and severity asserted at each phase boundary.
- The 40-tick window: taking `reach.admit_more` at the first warning kills someone within 40
  ticks plus or minus 4.
- The recovery: suspending one Program at critical raises `tilesAhead` from 0 to at least 3, and
  the fault rate falls below 200, within 120 simulated frames.
- `tilesAhead` returns 9, 6, 3, 1, 0 at ratios 0.0, 0.5, 1.0, 1.3, 1.6.
- The ration arithmetic: five Programs at `generous`, `standard` and `lean` each exceed 48
  frames; at `starved` they fit exactly.
- Falling: at critical, an eviction under a standing Program costs integrity on every member.

**`cow.test.ts`**: `VM-COW-1` exactly. A full-copy fork costs the whole address space in
frames; a copy-on-write fork costs fewer than four.

**`scope.test.ts`**: global against local replacement.
- Under global, a faulting Program takes a frame from a non-faulting one and the victim's fault
  rate rises.
- Switching to local stops it and the victim's fault rate falls. Asserted as a measured fall,
  not as a switch having occurred.
- Under local, the frame hairlines on a Program's ground all belong to that Program.

**`tiles.test.ts`**: the ground, under the headless renderer rig.
- Every tile state change over 2000 ticks corresponds one-to-one with a memory event. Zero
  unmatched in either direction.
- Timing constants exactly: 260 / 365 / 520 ms rise, 340 ms dissolve, 120 ms ramp, 200 ms
  write-back.
- The inversion: 520 > 340 at critical, asserted arithmetically.
- After a dissolve completes, nothing remains at the footprint.
- The hex map: `PageId` to position is a deterministic spiral; adjacent pages are adjacent tiles;
  positions are stable across a replay.
- One draw call for the ground at 1, 48 and 400 tiles.
- Concurrent dissolves beyond the tier cap aggregate; dissolve starts equal
  `memory.page_evicted` count at critical severity.
- Pinned frames are never selected as victims.

**`ocean.test.ts`**: `uAgitation` tracks `faultRate` and cube impacts and does not drift with
`uTime` over 2000 frames. The plane is two triangles. No vertex displacement is applied.

**`camera.test.ts`**: the FOV widening: 46 to 52 over 900 ms, reversing over 900 ms, disabled
under `reducedMotion`, and occurring nowhere else in the leg.

**`console.test.ts`**: `reach.admit_more`.
- Absent before the first warning, present after.
- Quotes a live `cpuUtilisation` figure that matches `SchedulingMetrics`.
- Carries no warning styling tokens.
- Recorded as `kind: 'admit_during_thrashing'` with `outcome: 'pending'`, marked `fatal` on a
  subsequent death.
- Exact LRU charges per access; bandwidth drains measurably faster with it active.

**`evaluate.test.ts`**: each of the seven objectives, met and not met. In particular:
- `working_set_allocation` met by suspending the largest at degree 4, and met at degree 5 after
  a VESPER remap. Both routes.
- `recover_from_thrashing` fails when the degree drops after a convoy member passes 40 integrity.
- `reproduce_belady` fails when only the `fifo` pair is run.

**`golden.test.ts`**: the golden headless playthrough.
- Fixture: `seed: 0x4b54524c`, `discClass: 'shell'`, `difficulty: 'operator'`, steady pace,
  entering with the leg 7 golden closing ledger and no depot available.
- Known-good sequence, in order:
  1. Walk. Take the first fault. Do nothing about it.
  2. `ws --budget`, reading 56 against 48.
  3. `belady --policy fifo --frames 3` and `--frames 4` on the anomaly string, then the same pair
     under `lru`.
  4. `belady --compare` on the leg's string.
  5. `reach.set_replacement` to `clock`.
  6. `reach.set_rations` to `lean`.
  7. `reach.suspend` the largest working set, bringing the degree to 4.
  8. On the first warning, decline `reach.admit_more` and `reach.set_degree` down by 2.
  9. `reach.set_replacement_scope` to local after the first cross-Program eviction.
  10. `reach.fork_scout` with copy-on-write.
  11. `reach.vesper_remap` on the Program with the largest working set.
- Assert: all seven objectives met, zero casualties, peak fault rate under 200, faults within 20
  percent of optimal, nine codex entries added, canonical event log hash matches the
  checked-in golden file, stable across two runs and across a snapshot-restore at the midpoint.

**`badpath.test.ts`**: the known-bad sequence.
- `generous` rations, degree 8, `fifo` throughout, take `reach.admit_more` at the warning.
- Assert: collapse to critical, LUMEN derezzes with `thrashing_collapse` within 40 ticks of the
  offer, the epitaph reads 41 faults in 50 ticks with working set 14 and allocated 6, the
  decision is marked `fatal`, counterfactual case 1 runs a real replay in which LUMEN survives,
  and `survived === true` because Programs remain.

**`manuals.test.ts`**: four manual strings against the curriculum map fixture; every
`See also:` topic resolves; `belady`'s policy block lists all five named policies; `degree`'s
trap paragraph is present in full.

**`stage.test.ts`**: anchors resolve; interaction anchors resolve; draw calls under budget at
the heaviest frame; the hero visual reference frame is reproduced at all three tiers.

---

## Out of scope

- Do not touch any other leg. Do not import from `src/legs/*` other than your own directory.
- Do not modify `src/game/types.ts` or `src/kernel/types.ts`.
- Do not modify anything under `src/kernel`, `src/render`, `src/world`, `src/terminal`,
  `src/ui`, `src/audio`, `src/design`, `src/platform` or `src/app`. If a replacement policy, the
  working set estimator or the thrashing detector is wrong, file it against WP-06 and stop.
- **Do not add a depot.** Not a small one, not a partial one, not an emergency one. If the leg is
  unsurvivable in playtest, the answer is the Yards depot in leg 7.
- **Do not add a hint, a tutorial line, a callout or an arrow.** The remedy is on screen the
  entire time and the game never says it.
- **Do not leave a trace where a tile dissolved.** No ghost, no outline, no marker.
- Do not shorten the fault pause to make movement feel better. The pause is the cost.
- Do not prevent the convoy from falling when a tile is evicted underneath them at critical
  severity.
- Do not style `reach.admit_more` as a warning, a risk, or anything other than an ordinary
  console option. Do not make its quoted utilisation figure fake.
- Do not make `optimal` available as a live replacement policy for the crossing. It is a
  yardstick and it requires knowing the future.
- Do not enable `storage`. The backing store is a latency and a beam to the horizon; leg 9 makes
  it a queue with an arm.
- Do not compensate for LUMEN being vulnerable to thrashing.
- Do not re-tune `tilesAhead`.
- Do not silently skip an eviction's dissolve under budget pressure. Aggregate instead.

### Files this package owns exclusively

```
src/legs/drowned_reach/index.ts
src/legs/drowned_reach/chapters.ts
src/legs/drowned_reach/objectives.ts
src/legs/drowned_reach/config.ts
src/legs/drowned_reach/populate.ts
src/legs/drowned_reach/interactions.ts
src/legs/drowned_reach/commands.ts
src/legs/drowned_reach/events.ts
src/legs/drowned_reach/evaluate.ts
src/legs/drowned_reach/hexmap.ts
src/legs/drowned_reach/tiles.ts
src/legs/drowned_reach/ocean.ts
src/legs/drowned_reach/ocean.frag.glsl
src/legs/drowned_reach/ocean.vert.glsl
src/legs/drowned_reach/thrashing.ts
src/legs/drowned_reach/refstrings.ts
src/legs/drowned_reach/fixtures.ts
src/legs/drowned_reach/stage.ts
src/legs/drowned_reach/copy.ts
tests/legs/drowned_reach/**
```

No other package writes to these paths and this package writes to no others.

---

## Report back

1. The commit or branch, and the full `tests/legs/drowned_reach/` output.
2. The golden playthrough hash and the file it is checked in at.
3. The frozen fixtures, as a table: the reference string generator parameters; the six fault
   counts on the leg's own string; the measured working sets at the crossing mid-point; the
   tick of the first warning at each ration and degree combination; the measured window from
   taking `reach.admit_more` to the first death.
4. Every `VM-*` fixture result against its expected value, including the eviction orders.
5. **The event-to-tile correspondence audit:** the count of tile state changes and the count of
   matching memory events over the 2000-tick test, and confirmation that both directions are
   zero-unmatched.
6. Measured timings for rise, ramp, dissolve and write-back at all three severities, and the
   arithmetic showing the inversion holds at critical.
7. Draw calls at each of the three quality tiers at the heaviest frame, the concurrent dissolve
   count at that frame, and how many were aggregated.
8. The captured hero visual, at all three tiers, as reference frames.
9. The measured recovery time from suspending one Program at critical severity to `tilesAhead`
   reaching 3, in frames and in simulated ticks.
10. Where the shadow memory manager behind `belady --compare` lives, and whether it is shared
    with leg 7's `frag --compare` or with WP-18.
11. **Your honest assessment of whether the leg is survivable** on the golden ledger from leg 7,
    at each of the three disc classes, at `operator` difficulty. If it is not, say so and name
    the Yards depot change that would fix it. Do not fix it here.
12. Any place where the design brief, the visual bible, the curriculum map, the narrative bible
    and the sim spec disagreed, what you did, and which document you followed. The design brief
    wins over all four.
13. Confirmation that no file outside the owned list was created or modified, that no depot
    exists in this leg, and that no hint, callout or tutorial line was added anywhere.

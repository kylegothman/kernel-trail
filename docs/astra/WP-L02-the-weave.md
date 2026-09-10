# WP-L02: The Weave

Leg id `the_weave`, index 2. Subtitle: *Eight strands, one bridge.*

**Legs are independent and may be built concurrently.** This package touches no other leg,
imports from no other leg, and shares no source file with any other leg.

---

## Objective

A module at `src/legs/the_weave/` implementing the frozen `Leg` interface, playable end to end.
The convoy crosses a braided bridge whose deck is woven from thread filaments. The player sets
a strand count per Program per segment, picks a multithreading model at the model gate, sorts
five variables into shared or thread-local storage at the tally slab, sizes a thread pool, and
cancels a runaway strand at a declared cancellation point.

This is the measurement leg. Failure drains and rarely kills.

---

## Prerequisites

**Engine work packages:** WP-01 Determinism core, WP-02 Process and PCB layer, WP-03
Scheduler registry, WP-11 Syscall interface, WP-17 Run state and ledger, WP-19 Leg runner,
WP-15 Terminal shell, WP-17 HUD and codex, WP-12 Renderer core, WP-13 Focus camera, WP-13
World structures (filament ribbons, woven deck geometry, the tally slab), WP-14 Derezz, WP-20
Smoke-test harness.

**Kernel subsystems:** `process` and `scheduler`, plus the thread layer inside WP-02. The
thread layer must implement all three mapping models with the semantics in fixtures
`THREAD-M1`, `THREAD-11` and `THREAD-MM`, must emit `thread.created` and `thread.joined`, must
support thread-local storage, and must support deferred and asynchronous cancellation. Amdahl
speedup must be computed by the kernel per fixtures `AMDAHL-1` through `AMDAHL-3`, not by the
leg.

---

## Required reading

- `docs/05-CURRICULUM-MAP.md`, "Leg 2. THE WEAVE" in full.
- `docs/02-KERNEL-SIM-SPEC.md`, section 4 (Threads, Ch. 4) in full; section 16.4 (the thread
  and Amdahl test vectors).
- `docs/04-NARRATIVE-BIBLE.md`, section 7 entries for `cache_thrash`, `false_sharing`,
  `memory_leak` and `lock_convoy`; section 8 leg 2 event table; section 6.1 (pace and quantum).
- `docs/03-VISUAL-BIBLE.md`, section 10 "Leg 2, The Weave"; section 13 (quality tiers).

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
  { chapter: 4, title: 'Threads & Concurrency',
    sections: ['4.1.1', '4.1.2', '4.2', '4.2.1', '4.2.2',
               '4.3.1', '4.3.2', '4.3.3', '4.5.1', '4.5.2',
               '4.6.1', '4.6.3', '4.6.4'] },
];
```

Amdahl's Law is presented within 4.2 in the 10th edition rather than as a numbered subsection.
Cite `4.2` for it and quote the formula in the codex entry.

### Learning objectives

```ts
export const objectives: readonly LearningObjective[] = [
  {
    id: 'obj.the_weave.speedup_prediction',
    statement: 'Sets the strand count for the weave crossing so that measured speedup lands within 15 percent of the Amdahl prediction for the segment stated serial fraction.',
    chapter: { chapter: 4, title: 'Threads & Concurrency', sections: ['4.2'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.the_weave.stop_adding_strands',
    statement: 'Stops adding strands at or before the point where the next strand buys under 3 percent additional speedup, and finishes the leg with at least 20 percent of bandwidth unspent.',
    chapter: { chapter: 4, title: 'Threads & Concurrency', sections: ['4.2', '4.2.1'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.the_weave.shared_versus_private',
    statement: 'Places the running tally in shared state and the per-strand scratch counters in thread-local storage, producing zero false_sharing events on the tally slab.',
    chapter: { chapter: 4, title: 'Threads & Concurrency', sections: ['4.1.2', '4.6.4'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.the_weave.model_choice',
    statement: 'Selects one-to-one mapping for the segment containing a blocking read, so that no single blocked strand stalls the other strands of the same Program.',
    chapter: { chapter: 4, title: 'Threads & Concurrency', sections: ['4.3.1', '4.3.2'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.the_weave.pool_sizing',
    statement: 'Sizes the strand pool so that no queued task waits more than 20 ticks for a worker and no worker idles for more than 30 percent of the segment.',
    chapter: { chapter: 4, title: 'Threads & Concurrency', sections: ['4.5.1'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.the_weave.deferred_cancellation',
    statement: 'Cancels the runaway strand at a declared cancellation point rather than immediately, so the shared tally is left consistent and no fs.corruption event follows.',
    chapter: { chapter: 4, title: 'Threads & Concurrency', sections: ['4.6.3'] },
    assessedBy: 'terminal_command',
  },
  {
    id: 'obj.the_weave.concurrency_versus_parallelism',
    statement: 'Correctly labels the single-core segment as concurrent and the four-core segment as parallel at the checkpoint gate, having measured both.',
    chapter: { chapter: 4, title: 'Threads & Concurrency', sections: ['4.1.1'] },
    assessedBy: 'decision',
  },
];
```

### Codex entries this leg adds to `codexUnlocked`

`codex.thread_concept`, `codex.concurrency_vs_parallelism`, `codex.amdahl`,
`codex.multithreading_models`, `codex.thread_pool`, `codex.false_sharing`, `codex.tls`.

| Entry | Added when |
|---|---|
| `codex.thread_concept` | First `thread.created` event. |
| `codex.concurrency_vs_parallelism` | The checkpoint gate is answered, right or wrong. |
| `codex.amdahl` | First `amdahl` invocation, or the first segment where measured speedup falls under 0.9 times the strand count, whichever is first. |
| `codex.multithreading_models` | The model gate is committed. |
| `codex.thread_pool` | First pool size change. |
| `codex.false_sharing` | First `false_sharing` affliction acquired. |
| `codex.tls` | First variable placed in thread-local storage. |

### Misconceptions this leg must break

**"Threads make a program faster in proportion to how many you create."** Stage the break in
two parts so the player cannot dismiss the first as noise. The braid pays out near-linear
speedup at two strands, which confirms the belief. Then the same dial at four and eight returns
1.7x and 1.9x on a segment whose serial fraction is posted on a sign at the entrance.
`amdahl --serial 0.4 --cores 4` prints 2.1 and the measured 1.9 sits just under it. The gap
between belief and measurement must be checkable rather than asserted, which means the serial
fraction has to be posted in the world before the player chooses.

**"Threads have their own memory, like small processes."** The tally slab. Ask the player to
have eight strands each add 1000 to a shared counter. The result is not 8000, visibly, on a lit
slab in the world. Run the same experiment with eight forked processes and produce eight
separate slabs each reading 1000, because each has its own address space. The two results side
by side make the distinction concrete before any lock is introduced, which is what sets up the
Narrows. Both experiments must be available at the same anchor and must be re-runnable.

**"Concurrency and parallelism are two words for the same thing."** The break is a measurement,
not a definition. The first braid is single-core: eight strands finish the batch in the same
wall time as one strand, and the strand ribbons visibly interleave on one lane. The second
braid is four-core: the same eight strands finish in roughly a quarter of the time, and four
ribbons move at once. At the checkpoint gate the player must label which braid was which, and
the gate does not open on a wrong label.

---

## Kernel configuration

```ts
export function kernelConfig(run: RunState): KernelConfig {
  return {
    seed: run.seed,
    scheduler: 'rr',                       // round robin: strands need to interleave visibly
    schedulerParams: {
      quantum: quantumForPace(run.policy.pace),  // 16/8/4/2
      agingInterval: 0,                    // aging belongs to leg 3
      starvationThreshold: 120,            // valid; nothing starves under rr
      starvationFatalThreshold: 300,
      preemptive: true,                    // rr is preemptive; interleaving is the lesson
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
    journalingEnabled: false,              // inert
    deadlockStrategy: 'ignore',            // inert: 'deadlock' is not enabled
    thrashingThreshold: 200,               // inert
    enabledSubsystems: ['process', 'scheduler'],
  };
}
```

`enabledSubsystems` is `['process', 'scheduler']`. Threads live inside the process subsystem in
WP-02 and need no separate id. The tally slab is a leg construct with a race detector local to
the leg; do not enable `sync` for it, because `sync` brings mutexes and the Narrows owns those.
Cache lines are modelled as a leg-local property of the tally slab layout, not as a memory
subsystem.

Core count is a leg parameter, not a `KernelConfig` field. The leg sets it per segment through
`LegSetupContext` population and it is 1 for braid one and 4 for braid two.

---

## Population

```ts
export function populate(ctx: LegSetupContext): void {
  const roster: readonly [ConvoyMemberId, string, number, number, number][] = [
    ['lumen',   'LUMEN',   2, 6, 52],
    ['sable',   'SABLE',   2, 5, 46],
    ['orrery',  'ORRERY',  3, 5, 46],
    ['kestrel', 'KESTREL', 3, 4, 40],
    ['vesper',  'VESPER',  3, 5, 46],
  ];
  roster.forEach(([member, name, priority, burst, service], i) => {
    const pid = ctx.spawn({ name, priority, burst, service, arrival: i, pages: 6 });
    ctx.bind(member, pid);
  });

  // The weave's own workload: the batch each braid processes.
  ctx.spawn({ name: 'weave.batch_a', priority: 4, burst: 4, service: 100, arrival: 4,  pages: 4 });
  ctx.spawn({ name: 'weave.batch_b', priority: 4, burst: 4, service: 100, arrival: 40, pages: 4 });
  ctx.spawn({ name: 'weave.reader',  priority: 4, burst: 2, service: 30,  arrival: 60, pages: 3 });
}
```

No `declareResource` and no `declareSync`.

### The four segments and their known-correct numbers

Use the `AMDAHL-*` fixtures so the leg is verifiable against the sim spec's own arithmetic.

| Segment | Cores | Serial fraction S | Posted at | Amdahl ceiling by strand count |
|---|---|---|---|---|
| `seg.braid_one` | 1 | 0.25 | the braid entrance sign | speedup is 1.0 at every N, because N is cores |
| `seg.braid_two` | 4 | 0.40 | the braid entrance sign | 1, 2, 4, 8 strands over 4 cores: 2.105 ceiling |
| `seg.blocking_read` | 4 | 0.25 | the model gate | model choice decides whether a blocked strand stalls the rest |
| `seg.pool` | 4 | 0.10 | the pool console | 1.818 at 2, 3.077 at 4, 4.706 at 8 |

`amdahlSpeedup(0.25, N)` for N = 1, 2, 4, 8, 16, 32 is 1.0000, 1.6000, 2.2857, 2.9091, 3.3684,
3.6571 (fixture `AMDAHL-1`). `amdahlSpeedup(0.10, N)` is 1.0000, 1.8182, 3.0769, 4.7059,
6.4000, 7.8049 (`AMDAHL-1b`). `amdahlSpeedup(0.50, N)` is 1.0000, 1.3333, 1.6000, 1.7778,
1.8824, 1.9394 (`AMDAHL-1c`). A raw burst of 100 at S = 0.25 accelerates to 100, 63, 44, 34,
30, 27 at those N (`AMDAHL-2`). Use these to set the strand dial's payoff curve; do not invent
your own.

`obj.the_weave.stop_adding_strands` needs the marginal-speedup knee to be findable. On
`seg.braid_two` at S = 0.40 over 4 cores, marginal speedup drops under 0.03 at the fifth
strand. The objective therefore passes at strand counts 1 through 5 and fails at 6 and above.
Record the exact knee as a frozen fixture once the first correct implementation establishes it.

### The tally slab

Five variables, dragged by the player into either the shared region or the thread-local region:

| Variable | Correct region | Why |
|---|---|---|
| `tally.total` | shared | It is the running total every strand contributes to. |
| `scratch.a` … `scratch.d` | thread-local | Per-strand working values that no other strand reads. |

Placing a scratch counter in the shared region within the same 64-byte cache line as
`tally.total` produces `false_sharing`. Placing `tally.total` in thread-local storage produces
five separate totals and a final value that is wrong by construction, which is the second
misconception's control condition.

### The runaway strand

At `seg.pool` one worker enters an unbounded loop mid-update to `tally.total`. The player
cancels it with `threads --cancel <tid>`. Under `--mode async` the strand stops mid-update, the
tally is left half-written, and an `fs.corruption` event follows. Under `--mode deferred` it
stops at the next declared cancellation point with the update complete and no corruption. Both
paths must be reachable and the difference must be exactly this.

---

## Stage

**Form.** Filaments, and a deck woven from them.
**Accent.** `CYAN.core` for parallel filaments, `SLATE.primary` for the serial section.
**Environment.** A bridge over nothing whose deck is literally woven from thread filaments. More
threads means a wider deck and a faster crossing. The deck is wide where the workload
parallelises and narrows to a single strand where it cannot.
**Hero visual.** The Amdahl moment. The player adds threads, the deck widens, and then it stops
widening. Adding the twelfth filament produces a deck visibly no wider than the eighth, because
the serial section is a single strand that no number of filaments can widen, and the convoy has
to walk across it one at a time regardless.

| Anchor id | Structure | Focus camera target |
|---|---|---|
| `anchor.bridge` | The whole span | wide establishing, no lock |
| `anchor.loom` | The strand dial, 1 to 16, per Program per segment | head-on, dial and current count legible |
| `anchor.braid_one` | The single-core braid, ribbons interleaving on one lane | side-on, all eight ribbons on one lane visible |
| `anchor.braid_two` | The four-core braid, four ribbons moving at once | side-on, four lanes visible |
| `anchor.serial_span` | The single-file section. The deck narrows to one strand here. | head-on down the span |
| `anchor.tally_slab` | The lit slab holding `tally.total` and the five draggable variables, with cache-line boundaries etched at 64-byte intervals | head-on orthographic; the cache line etching must be legible |
| `anchor.model_gate` | The many-to-one / one-to-one / many-to-many selector | head-on, three options with their blocking behaviour posted |
| `anchor.pool_console` | The pool size dial and the live task queue | head-on, queue depth and worker idle fraction legible |
| `anchor.checkpoint_gate` | The concurrency-or-parallelism label gate | head-on, both braids visible behind it |
| `anchor.serial_sign` | The posted serial fraction at each braid entrance | head-on |

The cache-line etching at `anchor.tally_slab` is load-bearing. False sharing is invisible
without it, and the whole point of `codex.false_sharing` is that it is invisible contention.
Draw the 64-byte boundaries as physical grooves and place the variables in them by position.

---

## Interactions

```ts
export const interactions: readonly InteractionDef[] = [
  {
    id: 'weave.set_strands',
    label: 'Set strand count',
    description: 'How many strands this Program runs on this segment. Each strand costs bandwidth to create and adds switching load.',
    anchor: 'anchor.loom',
    cost: { bandwidth: 2 },
    enabledWhen: (run) => run.resources.bandwidth >= 2,
  },
  {
    id: 'weave.choose_model',
    label: 'Choose the mapping model',
    description: 'Many-to-one, one-to-one, or many-to-many. Read what each does when a strand blocks.',
    anchor: 'anchor.model_gate',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'weave.place_variable',
    label: 'Place a variable',
    description: 'Drag a variable into the shared region or the thread-local region. Watch which cache line it lands in.',
    anchor: 'anchor.tally_slab',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'weave.run_tally_experiment',
    label: 'Run the tally experiment',
    description: 'Eight strands each add 1000 to the counter. Read the result on the slab.',
    anchor: 'anchor.tally_slab',
    cost: { bandwidth: 3 },
    enabledWhen: (run) => run.resources.bandwidth >= 3,
  },
  {
    id: 'weave.run_process_experiment',
    label: 'Run the same thing with processes',
    description: 'Eight forked processes each add 1000. Read the eight results.',
    anchor: 'anchor.tally_slab',
    cost: { quota: 24, bandwidth: 3 },
    enabledWhen: (run) => run.resources.quota >= 24 && run.resources.bandwidth >= 3,
  },
  {
    id: 'weave.set_pool_size',
    label: 'Set pool size',
    description: 'Workers in the standing pool. Watch queue wait against worker idle.',
    anchor: 'anchor.pool_console',
    cost: { bandwidth: 2 },
    enabledWhen: (run) => run.resources.bandwidth >= 2,
  },
  {
    id: 'weave.label_braid',
    label: 'Label this braid',
    description: 'Concurrent or parallel. The gate does not open on a wrong label.',
    anchor: 'anchor.checkpoint_gate',
    cost: {},
    enabledWhen: () => true,
  },
];
```

Cancellation is done from the terminal with `threads --cancel`, not from an interaction. The
`--mode` flag and its man page are the teaching.

---

## Terminal commands

Three commands, copied verbatim from the curriculum map into `src/legs/the_weave/commands.ts`:
`threads`, `amdahl`, `top`. The full `manual` text for each is in `docs/05-CURRICULUM-MAP.md`,
"Leg 2. THE WEAVE", "Terminal commands introduced". Copy byte for byte; a test asserts the
match.

Load-bearing lines you must not lose:

- `threads`: "Two processes cannot corrupt each other memory. Two threads do it by default."
- `threads`: "deferred is the correct default and async is for the case where correctness has
  already been lost."
- `amdahl`: "N in the formula is cores, not threads. Adding threads beyond the core count does
  not increase N."
- `top`: "Idle time is not always waste. A pool with 20 percent worker idle and no queued task
  waiting is correctly sized."

`top` is introduced here and stays in the shell for the rest of the run. Leg 1's second
misconception break also uses it, so confirm with WP-15 whether `top` should move into the
base shell instead. If it moves, delete it from this list and note the change; do not ship two
copies.

---

## Event table

Copied verbatim from `04-NARRATIVE-BIBLE.md` section 8, leg 2. Weights sum to 100.

```ts
export const weaveEvents: readonly RandomEventDef[] = [
  {
    id: 'weave.overthreading',
    weight: 13,
    title: 'Too Many Hands',
    narration: 'The convoy spawns a thread per unit of work and the scheduler spends more time arranging them than they spend working. Speedup falls while the thread count rises.',
    targets: null, inflicts: 'cache_thrash',
    resourceDelta: { cycles: -40 },
    onlyIf: null,
  },
  {
    id: 'weave.false_sharing',
    weight: 14,
    title: 'One Line, Two Owners',
    narration: 'Two Programs write to addresses twelve bytes apart on a line sixty-four wide. Every write by either one throws away the other one\'s copy.',
    targets: null, inflicts: 'false_sharing',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'weave.thread_pool',
    weight: 16,
    title: 'Standing Pool',
    narration: 'A pool of workers left behind by a finished job is still warm and still accepting tasks. The convoy borrows it rather than paying creation cost again.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 60 },
    onlyIf: null,
  },
  {
    id: 'weave.amdahl_wall',
    weight: 13,
    title: 'The Serial Fraction',
    narration: 'Eight cores are available and the speedup readout will not pass 2.4. The part that cannot be split is eleven percent of the work and it is the whole ceiling.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -55 },
    onlyIf: null,
  },
  {
    id: 'weave.detached_leak',
    weight: 12,
    title: 'Detached and Forgotten',
    narration: 'A detached thread finishes and its stack is never released because nothing joined it. The frames stay allocated to a thread that no longer exists.',
    targets: null, inflicts: 'memory_leak',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'weave.join_storm',
    weight: 14,
    title: 'Join Storm',
    narration: 'Sixty threads reach their barrier within four ticks of each other and every one of them blocks the main line while it is collected. The convoy stops moving until the last one is in.',
    targets: null, inflicts: 'lock_convoy',
    resourceDelta: { bandwidth: -6 },
    onlyIf: null,
  },
  {
    id: 'weave.affinity_windfall',
    weight: 18,
    title: 'Affinity Held',
    narration: 'The scheduler keeps each convoy thread on the core it warmed, for eleven straight slices. Nothing has to be reloaded and the leg gets quietly cheaper.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 45, quota: 25 },
    onlyIf: null,
  },
];
```

---

## Evaluation

### Survival

The leg is survived when at least one convoy Program is alive at leg end. Death is possible and
uncommon by design: the Weave is the relief slope before the Quantum Pass and it should hurt
without killing.

Past roughly six strands on a four-core segment the context switch count climbs faster than the
work completes, cache lines bounce between cores, and the strands acquire `cache_thrash` (1
integrity per travel tick, drains only) and `false_sharing` (1.5 per tick, drains only) if the
tally was left shared without padding. Neither is fatal on its own. If a Program does reach
zero integrity it derezzes with `TerminationReason: 'thrashing_collapse'`, and the epitaph must
name **cache** thrashing rather than page thrashing, so the two are separated from the first
encounter. Leg 8 owns page thrashing and the two epitaph texts must not be confusable.

LUMEN's 15 percent service reduction masks the problem slightly. A convoy that still has LUMEN
will over-thread further before noticing. Do not compensate for this; it is a designed trap.

The remedy is `{ kind: 'reduce_degree', by: 2 }` on the strand dial, and padding or privatising
the tally.

### Objectives

| Objective | Computed from |
|---|---|
| `obj.the_weave.speedup_prediction` | `abs(measured / predicted - 1) < 0.15` for the committed strand count, where measured is the segment's tick count against the single-strand baseline the leg records at entry, and predicted is `amdahlSpeedup(S, cores)`. |
| `obj.the_weave.stop_adding_strands` | The highest strand count committed is at or below the first N where marginal speedup drops under 0.03, **and** closing `bandwidth` is at least 20 percent of the leg's opening bandwidth. |
| `obj.the_weave.shared_versus_private` | Zero `false_sharing` afflictions acquired **and** the tally value at segment end equals the sum the leg computed serially. |
| `obj.the_weave.model_choice` | `one_to_one` was committed at the model gate for `seg.blocking_read`. |
| `obj.the_weave.pool_sizing` | From the pool's own instrumentation: max queue wait under 20 ticks and worker idle fraction under 0.30. |
| `obj.the_weave.deferred_cancellation` | A `threads --cancel` invocation with `--mode deferred` on the runaway tid, followed by zero `fs.corruption` events. |
| `obj.the_weave.concurrency_versus_parallelism` | Both braids labelled correctly at the checkpoint gate, with the labels submitted after both braids were measured. |

### Debrief card

```ts
{
  headline: /* 'Across the weave.' */,
  whatHappened:
    `You committed ${strands} strands on a ${cores}-core segment with a serial fraction of ${S}. ` +
    `Amdahl's ceiling was ${predicted.toFixed(2)}. You measured ${measured.toFixed(2)}.`,
  whyItHappened:
    'The ceiling is set by the part that cannot be split. Adding strands past the core count ' +
    'does not raise the core count; it raises the number of things competing for the cores you ' +
    'have, and the switching is charged to you.',
  counterfactual: /* computed */,
  chapter: { chapter: 4, title: 'Threads & Concurrency', sections: ['4.2'] },
}
```

Counterfactual, in priority order:

1. **Over-threaded past the knee.** `"At ${knee} strands this segment finishes in ${t1} ticks.
   At ${strands} it finishes in ${t2}, and the difference went to context switches."`
2. **False sharing occurred.** `"The scratch counters shared a cache line with the tally. Moving
   them to thread-local storage costs nothing and would have removed ${count} false-sharing
   events."`
3. **Async cancellation used.** `"The strand stopped mid-update and the tally was left
   half-written. A deferred cancellation stops at the next declared point, with the update
   finished."`
4. **Pool mis-sized.** `"A pool of ${correct} workers holds queue wait under 20 ticks with idle
   under 30 percent. Yours ran ${actual}."`
5. `null`.

---

## Acceptance criteria

1. `src/legs/the_weave/index.ts` satisfies `Leg` under `tsc --strict`, `id === 'the_weave'`,
   `index === 2`.
2. The leg runs headlessly to completion via the WP-20 smoke-test harness.
3. `enabledSubsystems` deep-equals `['process', 'scheduler']`. In particular `sync` is not
   enabled and no mutex, semaphore, monitor or rwlock is created anywhere in this leg.
4. Inert-field independence over 400 ticks.
5. Every objective can be met by the known-good decision sequence; all seven met in one run.
6. The known-bad sequence produces the intended failure: sixteen strands on the four-core
   segment with the scratch counters left shared, producing `cache_thrash` and `false_sharing`
   on at least three Programs and measured speedup below 1.4.
7. Amdahl arithmetic matches fixtures `AMDAHL-1`, `AMDAHL-1b`, `AMDAHL-1c`, `AMDAHL-2` and
   `AMDAHL-3` to a tolerance of 1e-4.
8. Thread model semantics match `THREAD-M1`, `THREAD-11` and `THREAD-MM` exactly.
9. The single-core braid finishes the batch in the same wall time at 1 strand and at 8 strands,
   within 5 percent. The four-core braid finishes at roughly a quarter with 8 strands.
10. Async cancellation mid-update produces exactly one `fs.corruption` event; deferred
    cancellation produces zero.
11. The tally experiment with eight strands on a shared unprotected counter produces a value
    strictly below 8000. The same with eight processes produces eight slabs each reading 1000.
12. Event table weights sum to exactly 100; all ids unique.
13. All three terminal command `manual` strings match the curriculum map byte for byte.
14. Draw calls stay under 220 / 450 / 900 at the heaviest frame, which is 16 filament ribbons
    across four lanes with the tally slab and both braids in view.
15. The Amdahl hero visual holds: at S = 0.40 over 4 cores, the deck at 12 filaments is no
    wider than at 8, measured in world units, and the serial span is one strand wide at every
    filament count.

---

## Tests you must write

All under `tests/legs/the_weave/`.

**`contract.test.ts`**: `Leg` conformance, exact ids, chapters, seven objectives.

**`config.test.ts`**: `enabledSubsystems` exact; no sync primitive is ever declared; inert-field
independence; `agingInterval === 0`.

**`populate.test.ts`**: eight spawns, five binds, zero resource and sync declarations.

**`amdahl.test.ts`**: the five Amdahl fixtures to 1e-4; the knee on `seg.braid_two` at S = 0.40
over 4 cores is at strand 5 and is frozen as a fixture.

**`models.test.ts`**: `THREAD-M1`: many-to-one, 4 threads, one blocks, the whole PCB moves to
`waiting`, zero ticks to the other three. `THREAD-11`: one-to-one, PCB stays `ready`,
`usableCores` drops 4 to 3. `THREAD-MM`: 8 threads over a pool of 4 with 4 cores, `usableCores`
is 4 and lwp assignment is round-robin over ascending tid.

**`tally.test.ts`**: eight strands on a shared counter produce under 8000; eight processes
produce eight independent 1000s; a scratch counter in the same cache line as the tally produces
a `false_sharing` affliction; moving it to thread-local storage produces zero.

**`cancel.test.ts`**: async cancellation mid-update leaves the tally inconsistent and emits one
`fs.corruption`; deferred cancellation completes the update and emits zero.

**`pool.test.ts`**: for pool sizes 1 through 8 on `seg.pool`, assert queue wait and idle
fraction, and assert exactly which sizes satisfy the objective.

**`evaluate.test.ts`**: each of the seven objectives, met and not met.

**`golden.test.ts`**: the golden headless playthrough.
- Fixture: `seed: 0x4b54524c`, `discClass: 'shell'`, `difficulty: 'operator'`, steady pace,
  standard rations, entering with the leg 1 golden closing ledger.
- Known-good sequence: measure braid one at 1 and 8 strands, measure braid two at 1 and 4,
  label both braids at the checkpoint gate, commit 4 strands on braid two, choose one-to-one at
  the model gate, place `tally.total` shared and all four scratch counters thread-local, set
  pool size to the value that satisfies the objective, `threads --cancel <tid> --mode deferred`
  on the runaway.
- Assert: all seven objectives met, zero `false_sharing`, zero `fs.corruption`, canonical event
  log hash matches the checked-in golden file, stable across two runs and a snapshot-restore.

**`badpath.test.ts`**: 16 strands on braid two, scratch counters left shared adjacent to the
tally, async cancellation. Assert `cache_thrash` and `false_sharing` on at least three Programs,
one `fs.corruption`, measured speedup under 1.4, counterfactual case 1, and `survived === true`.

**`manuals.test.ts`**: three manual strings against the fixture; every `See also:` resolves.

**`stage.test.ts`**: anchors resolve; interaction anchors resolve; draw calls under budget;
the deck-width assertion for the Amdahl hero visual.

---

## Out of scope

- Do not touch any other leg. Do not import from `src/legs/*` other than your own directory.
- Do not modify the frozen type files or anything under `src/kernel`, `src/render`,
  `src/world`, `src/terminal`, `src/ui`, `src/audio`, `src/design`, `src/platform`, `src/app`.
- Do not enable `sync`. Do not create a mutex, semaphore, monitor or rwlock. The broken tally
  is the setup for the Narrows and it must stay broken here.
- Do not enable `memory`. Cache lines are a leg-local property of the tally slab layout.
- Do not make the failure fatal. Both afflictions drain and neither has a fatal clock in this
  leg. A death here is possible only by arriving already damaged.
- Do not explain what a mutex is, in copy, in a man page, or in the codex.
- Do not compensate for LUMEN masking the over-threading problem.

### Files this package owns exclusively

```
src/legs/the_weave/index.ts
src/legs/the_weave/chapters.ts
src/legs/the_weave/objectives.ts
src/legs/the_weave/config.ts
src/legs/the_weave/populate.ts
src/legs/the_weave/interactions.ts
src/legs/the_weave/commands.ts
src/legs/the_weave/events.ts
src/legs/the_weave/evaluate.ts
src/legs/the_weave/segments.ts
src/legs/the_weave/tally.ts
src/legs/the_weave/pool.ts
src/legs/the_weave/stage.ts
src/legs/the_weave/copy.ts
tests/legs/the_weave/**
```

---

## Report back

1. Commit or branch, and the full `tests/legs/the_weave/` output.
2. Golden playthrough hash and its checked-in path.
3. The frozen knee fixture: the strand count at which marginal speedup first drops under 0.03
   on each of the four segments.
4. Measured speedup at 1, 2, 4, 8 and 16 strands on both braids, as a table, against the Amdahl
   prediction.
5. Draw calls at each tier, and the measured deck width at 8 and 12 filaments.
6. Whether `top` stayed in this leg or moved to the base shell, and the item filed if it moved.
7. Any document disagreement, what you did, and which document you followed.
8. Confirmation that no file outside the owned list was created or modified, and that no sync
   primitive is created anywhere in the leg.

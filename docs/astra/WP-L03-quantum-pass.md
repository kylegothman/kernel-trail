# WP-L03: Quantum Pass

Leg id `quantum_pass`, index 3. Subtitle: *Someone has to go last.*

**Legs are independent and may be built concurrently.** This package touches no other leg,
imports from no other leg, and shares no source file with any other leg.

**This is one of the three high-value packages.** It is the first leg where a policy the player
set can kill a Program, and it builds the counterfactual machinery (`gantt --replay`) that the
end-of-run report is made of. Budget accordingly.

---

## Objective

A module at `src/legs/quantum_pass/` implementing the frozen `Leg` interface, playable end to
end. The pass narrows to a single ledge that takes one runner at a time. The player sets
`SchedulerId` at the ledge control with all seven policies available, sets `quantum`,
`agingInterval` and the MLFQ `levelQuanta` array, and can `nice` an individual pid. The Gantt
ribbon runs along the ledge wall, drawn from the live event log, with context switch cost
rendered as a visible gap.

Two things this leg ships that the rest of the run depends on:

1. **The first policy death.** Starvation, from a legal and common configuration, on a normal
   workload with no adversarial input.
2. **`gantt --replay`.** Re-runs the recorded arrival set under a different policy and prints
   both ribbons. This is the first appearance of the counterfactual machinery. Panel 5 of the
   end-of-run report is built on the same mechanism, so get the interface right here.

---

## Prerequisites

**Engine work packages:** WP-01 Determinism core, WP-02 Process and PCB layer, **WP-03 and WP-04
Scheduler registry complete and frozen with all seven policies**, WP-11 Syscall interface,
WP-17 Run state, ledger, afflictions and epitaphs, WP-19 Leg runner, WP-15 Terminal shell,
WP-17 HUD and codex, WP-18 Debrief and counterfactual replay (this leg is its first consumer;
coordinate the replay interface with that package before you build), WP-12 Renderer core,
WP-13 Focus camera, WP-13 World structures (switchback tiers, the quantum drum, the Gantt
ribbon), WP-14 Derezz and tombstones, WP-20 Smoke-test runner.

**Kernel subsystems:** `process` and `scheduler`. The scheduler registry must be complete:
`fcfs`, `sjf`, `srtf`, `priority`, `priority_aging`, `rr` and `mlfq`, each independently
verified against its `SCHED-*` fixture. `Kernel.setScheduler` must swap policies mid-run
without resetting `readySince`, `totalCpuUsed` or `queueLevel`, because the whole leg is about
changing policy on a running system. `process.starving` must fire at `starvationThreshold` with
`fatal: false` and at `starvationFatalThreshold` with `fatal: true`.

Deterministic replay must be available: the leg needs to re-run a recorded arrival set under a
different policy and get a byte-identical result for the same policy. That is fixture `DET-D1`
plus the ability to fork a shadow kernel from a snapshot.

---

## Required reading

- `docs/00-DESIGN-BRIEF.md`, sections 5, 7, 9.
- `docs/05-CURRICULUM-MAP.md`, "Leg 3. QUANTUM PASS" in full; section 0.1 (the pace-to-quantum
  citation is 5.3.3, not 5.3.4).
- `docs/02-KERNEL-SIM-SPEC.md`, section 5 (CPU scheduling, Ch. 5) in full; section 16.3 (the
  `SCHED-*` test vectors, all fourteen rows plus the per-process detail table).
- `docs/04-NARRATIVE-BIBLE.md`, section 6.1 (pace, which sets the quantum, and the workload
  arrival rate table); section 7 entries for `starvation`, `priority_inversion` and
  `cache_thrash`; section 8 leg 3 event table; section 9 epitaphs for `starvation`; section 10
  (the leg 3 depot); section 15.3 panel 5 (the counterfactual replay).
- `docs/03-VISUAL-BIBLE.md`, section 10 "Leg 3, Quantum Pass"; section 8 (motion language, for
  the Gantt ribbon's snap on policy change); section 13 (quality tiers).

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
  { chapter: 5, title: 'CPU Scheduling',
    sections: ['5.1.1', '5.1.2', '5.1.3', '5.2',
               '5.3.1', '5.3.2', '5.3.3', '5.3.4', '5.3.5', '5.3.6',
               '5.4', '5.5.1', '5.8.1', '5.8.2'] },
];
```

Section 5.6 (real-time scheduling) is touched only by the deadline flag on one workload and is
listed as partial in the audit. Do not build a real-time scheduler.

### Learning objectives

```ts
export const objectives: readonly LearningObjective[] = [
  {
    id: 'obj.quantum_pass.waiting_time_target',
    statement: 'Brings average waiting time across the pass below 12 ticks with zero process.starving events marked fatal.',
    chapter: { chapter: 5, title: 'CPU Scheduling', sections: ['5.2'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.quantum_pass.sjf_is_optimal',
    statement: 'Runs the same arrival set under at least three non-preemptive policies with gantt --replay and identifies shortest-job-first as the one with the lowest average waiting time, recording the margin.',
    chapter: { chapter: 5, title: 'CPU Scheduling', sections: ['5.3.2', '5.8.2'] },
    assessedBy: 'terminal_command',
  },
  {
    id: 'obj.quantum_pass.quantum_sizing',
    statement: 'Sets a round-robin quantum between 1.2 and 4 times the median burst, holding context switch overhead under 10 percent of total CPU while average response time stays under 8 ticks.',
    chapter: { chapter: 5, title: 'CPU Scheduling', sections: ['5.3.3'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.quantum_pass.clear_starvation',
    statement: 'Clears an active starvation affliction within 20 ticks of the first warning, by switching to priority_aging or by raising the starved Program priority with nice.',
    chapter: { chapter: 5, title: 'CPU Scheduling', sections: ['5.3.4'] },
    assessedBy: 'survival',
  },
  {
    id: 'obj.quantum_pass.avoid_convoy_effect',
    statement: 'Declines first-come-first-served on the segment where one long CPU-bound Program arrives ahead of four short ones, finishing at least 30 percent below the recorded FCFS waiting-time baseline.',
    chapter: { chapter: 5, title: 'CPU Scheduling', sections: ['5.3.1'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.quantum_pass.tune_mlfq',
    statement: 'Configures multilevel feedback queue level quanta so the two interactive Programs remain at level 0 and the CPU-bound Program descends at least two levels, with no Program left below its aging interval at the end of the segment.',
    chapter: { chapter: 5, title: 'CPU Scheduling', sections: ['5.3.5', '5.3.6'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.quantum_pass.switch_rate',
    statement: 'Holds context switches under one per six ticks of simulated CPU while running a preemptive policy.',
    chapter: { chapter: 5, title: 'CPU Scheduling', sections: ['5.1.3', '5.3.3'] },
    assessedBy: 'outcome',
  },
];
```

### Codex entries this leg adds to `codexUnlocked`

`codex.scheduling_criteria`, `codex.fcfs_convoy`, `codex.sjf_optimality`, `codex.round_robin`,
`codex.priority_starvation`, `codex.mlfq`, `codex.preemption_cost`.

| Entry | Added when |
|---|---|
| `codex.scheduling_criteria` | First `gantt --metrics` invocation. |
| `codex.fcfs_convoy` | The convoy-effect segment completes under `fcfs`, or a `gantt --replay fcfs` is run on it. |
| `codex.sjf_optimality` | Three `gantt --replay` invocations naming distinct non-preemptive policies. |
| `codex.round_robin` | First quantum change under `rr`. |
| `codex.priority_starvation` | First `process.starving` event, at either severity. |
| `codex.mlfq` | First `sched --levels` invocation. |
| `codex.preemption_cost` | Context switch overhead first exceeds 15 percent of total CPU. |

`codex.priority_starvation` is the one that matters. It is added on the warning, not on the
death, so a player who reads the warning has the remedy available before the fatal threshold.
That is the whole "codex is added by encountering the pathology" contract, and this is its
sharpest instance.

### Misconceptions this leg must break

**"Priority scheduling means important work finishes sooner, and starvation is a rare corner
case."** The break is the leg's default configuration. The pass opens under `priority` with
`agingInterval: 0`, which is a legal and common configuration, and the convoy contains one
Program with a high priority number. It never runs. Not rarely, never, for 340 consecutive
ticks, with the wait counter over its head the whole time. The player watches indefinite
blocking happen on a normal workload with no adversarial input, which is the actual claim the
textbook makes and which almost nobody believes until they see it.

Requirements this places on the build:
- The default policy on leg entry is `priority` with `agingInterval: 0`. Do not open on `rr`.
- The wait counter must be a world object above the starved stele, not a HUD number, and it
  must be readable from the establishing shot.
- 340 consecutive ticks must be reachable within the leg's 70-tick steady-pace length by the
  segment structure, so either the segment runs longer than the travel meter or the counter
  accumulates across segments. Choose the second: `readySince` accumulates and the counter
  reads from it directly.

**"Smaller quantum is more responsive, so the smallest quantum is best."** Half true, which is
what makes it durable. The break is the reckless pace setting, which is quantum 2 in the pace
table. The Gantt ribbon fills with switch gaps until the gaps are wider than the work bands,
and `gantt --metrics` shows response time improved by 0.4 ticks while utilisation fell 22
points and throughput fell with it. The player sees both halves of the trade in one chart,
which is why the ribbon must draw overhead to scale rather than reporting it as a number.

Fixture `SCHED-RR-2a` gives you the shape: `rr` at q=1 on P1: 0,24; P2: 0,3; P3: 0,3 produces
10 dispatches with identical average waiting time to q=4 and response time down from 3.667 to
1.0. Use that pair as the tuning reference.

**"SJF works because the OS knows how long each job will take."** The break is the burst
estimate depot. The player can buy predicted burst lengths, and the predictions are produced by
exponential averaging over previous bursts, which is what a real system does. On the segment
where a Program changes behaviour, the estimate is wrong, SRTF on the wrong estimate makes the
wrong preemption, and `gantt --replay rr` shows round robin beating it on the same arrivals.
SJF stays optimal in theory and loses in practice within the same leg, from the same data.

The exponential averaging must be real: `tau(n+1) = alpha * t(n) + (1 - alpha) * tau(n)` with
alpha 0.5, computed by the kernel over the process's own previous bursts. Do not fake the
prediction. The break only works if the player can inspect the estimate and see why it was
wrong.

---

## Kernel configuration

```ts
export function kernelConfig(run: RunState): KernelConfig {
  return {
    seed: run.seed,
    scheduler: 'priority',                 // THE DEFAULT IS DELIBERATE. See misconception one.
    schedulerParams: {
      quantum: quantumForPace(run.policy.pace),  // conservative 16, steady 8, aggressive 4, reckless 2
      levelQuanta: [4, 8, 16],             // MLFQ default; the player edits it at the ledge control
      agingInterval: 0,                    // AGING OFF BY DEFAULT. This is what starves the convoy.
      starvationThreshold: 120,            // warning fires here; the player has time to act
      starvationFatalThreshold: 300,       // derezz here; 180 ticks of warning window
      preemptive: false,                   // priority as configured here is non-preemptive
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

`enabledSubsystems` is `['process', 'scheduler']`. This leg teaches scheduling and nothing else.
Do not enable `sync` for the priority-inversion event; that event inflicts an affliction through
the event table, and the affliction's mechanics live in WP-17, not in a simulated mutex. The
Narrows owns real priority inversion.

The three defaults that carry the leg's teaching, restated so nobody tidies them away:

- `scheduler: 'priority'` on entry. A player who never touches the ledge control watches
  somebody starve.
- `agingInterval: 0` on entry. Aging is the structural fix and the player has to find it.
- `preemptive: false` under `priority`. Preemption arrives with `srtf` and `rr`, and the
  contrast is the leg's second half.

Pace writes `quantum` directly, per the pace table: conservative 16, steady 8, aggressive 4,
reckless 2. Pace also scales `workloadArrivalRate` by 0.70, 1.00, 1.45 and 2.00, which is where
starvation actually comes from at fast pace. That scaling is applied in `populate` through
arrival times, not in `KernelConfig`.

---

## Population

The leg runs four segments. Each has a designed arrival set with known-correct metrics taken
from the `SCHED-*` fixtures, so the leg is verifiable against the sim spec's own arithmetic.

```ts
export function populate(ctx: LegSetupContext): void {
  const roster: readonly [ConvoyMemberId, string, number, number, number][] = [
    // member,      name,      priority, burst, service
    ['lumen',   'LUMEN',   3, 10, 60],   // the long CPU-bound one; the convoy effect's head
    ['sable',   'SABLE',   5,  4, 24],   // HIGH PRIORITY NUMBER = LOW PRIORITY. This one starves.
    ['orrery',  'ORRERY',  1,  3, 18],
    ['kestrel', 'KESTREL', 1,  2, 14],
    ['vesper',  'VESPER',  2,  3, 18],
  ];
  roster.forEach(([member, name, priority, burst, service], i) => {
    const pid = ctx.spawn({ name, priority, burst, service, arrival: i, pages: 6 });
    ctx.bind(member, pid);
  });

  // Segment 1: the convoy effect. One long job ahead of four short ones. SCHED-FCFS-1 shape.
  ctx.spawn({ name: 'pass.haul',   priority: 3, burst: 24, service: 24, arrival: 0, pages: 5 });
  ctx.spawn({ name: 'pass.check_a',priority: 3, burst: 3,  service: 3,  arrival: 0, pages: 3 });
  ctx.spawn({ name: 'pass.check_b',priority: 3, burst: 3,  service: 3,  arrival: 0, pages: 3 });
  ctx.spawn({ name: 'pass.check_c',priority: 3, burst: 3,  service: 3,  arrival: 0, pages: 3 });

  // Segment 2: the SJF comparison set. SCHED-SJF-1 exactly.
  ctx.spawn({ name: 'pass.sjf_1', priority: 3, burst: 6, service: 6, arrival: 40, pages: 3 });
  ctx.spawn({ name: 'pass.sjf_2', priority: 3, burst: 8, service: 8, arrival: 40, pages: 3 });
  ctx.spawn({ name: 'pass.sjf_3', priority: 3, burst: 7, service: 7, arrival: 40, pages: 3 });
  ctx.spawn({ name: 'pass.sjf_4', priority: 3, burst: 3, service: 3, arrival: 40, pages: 3 });

  // Segment 3: the starvation set. SCHED-AGING-1A shape: one low-priority, four high arrivals.
  ctx.spawn({ name: 'pass.sweep_1', priority: 1, burst: 4, service: 4, arrival: 80,  pages: 3 });
  ctx.spawn({ name: 'pass.sweep_2', priority: 1, burst: 4, service: 4, arrival: 84,  pages: 3 });
  ctx.spawn({ name: 'pass.sweep_3', priority: 1, burst: 4, service: 4, arrival: 88,  pages: 3 });
  ctx.spawn({ name: 'pass.sweep_4', priority: 1, burst: 4, service: 4, arrival: 92,  pages: 3 });

  // Segment 4: the MLFQ set. SCHED-MLFQ-1 shape plus two interactive Programs.
  ctx.spawn({ name: 'pass.grind',  priority: 3, burst: 20, service: 20, arrival: 120, pages: 4 });
  ctx.spawn({ name: 'pass.tap_a',  priority: 3, burst: 6,  service: 6,  arrival: 120, pages: 3 });
  ctx.spawn({ name: 'pass.tap_b',  priority: 3, burst: 4,  service: 4,  arrival: 130, pages: 3 });
}
```

No `declareResource` and no `declareSync`.

### Known-correct numbers, from the sim spec's fixtures

Segment 1, the convoy effect. `SCHED-FCFS-1`: P1: 0,24; P2: 0,3; P3: 0,3 under `fcfs` gives the
Gantt `P1[0-24] P2[24-27] P3[27-30]`, average waiting 17.0, turnaround 27.0, response 17.0. The
same three submitted P2, P3, P1 (`SCHED-FCFS-2`) gives average waiting 3.0. The leg records the
FCFS baseline at segment entry and `obj.quantum_pass.avoid_convoy_effect` requires finishing at
least 30 percent below it.

Segment 2, SJF optimality. `SCHED-SJF-1`: P1: 0,6; P2: 0,8; P3: 0,7; P4: 0,3 under `sjf` gives
`P4[0-3] P1[3-9] P3[9-16] P2[16-24]`, average waiting **7.0**. The same set under `fcfs` in
arrival order (`SCHED-SJF-1F`) gives average waiting **10.25**. The margin the player records is
3.25 ticks. `srtf` on `SCHED-SRTF-1` gives 6.5 against `sjf`'s 7.75 on the same arrivals, which
is the preemptive comparison for the third non-preemptive policy the objective asks for; note
that `srtf` is preemptive and does not count toward the three non-preemptive replays.

The three non-preemptive policies available for `gantt --replay` are `fcfs`, `sjf` and
`priority`. `SCHED-PRIO-1` gives average waiting 8.2 on its own set. Design segment 2 so all
three are runnable on the identical arrival set and SJF wins.

Segment 3, starvation. `SCHED-AGING-1A`: PL: 0,5,p5; H1: 0,4,p1; H2: 4,4,p1; H3: 8,4,p1;
H4: 12,4,p1 under `priority` with aging 0 gives `H1[0-4] H2[4-8] H3[8-12] H4[12-16] PL[16-21]`,
average waiting 3.2, **worst wait 16**. `SCHED-AGING-1B`, the same set under `priority_aging`
with aging 2, gives `H1[0-4] H2[4-8] PL[8-13] H3[13-17] H4[17-21]`, average waiting 3.6, **worst
wait 8**. Average waiting got worse and worst wait halved. That trade is the entire
`priority_aging` lesson and both numbers must appear in `gantt --metrics`.

The leg's own starvation is longer than the fixture, because SABLE is at priority 5 against a
stream of priority 1 arrivals whose rate scales with pace. Tune the sweep arrival stream so
that at steady pace, with no intervention, SABLE's `readySince` reaches 340 ticks. Freeze that
as a fixture. The epitaph quotes it: "it was ready to run for 340 consecutive ticks."

Segment 4, MLFQ. `SCHED-MLFQ-1`: levels [4,8,16], aging 50, P1: 0,20; P2: 0,6; P3: 10,4 gives
`P1[0-4] P2[4-8] P1[8-10] P3[10-14] P2[14-16] P1[16-30]`, average waiting 6.667, turnaround
16.667, response 1.333, and final queue levels P1 = 2, P2 = 1, P3 = 0.
`obj.quantum_pass.tune_mlfq` reads exactly this: the two interactive Programs at level 0 and
the CPU-bound one descended at least two levels.

Median burst for `obj.quantum_pass.quantum_sizing` is computed over the segment's `ProcessSpec`
set. On segment 2 the bursts are 3, 6, 7, 8 and the median is 6.5, so the admissible quantum
range is 7.8 to 26, which rounds to 8 through 26. Steady pace gives quantum 8 and passes;
reckless gives 2 and fails; conservative gives 16 and passes. Compute the median per segment
rather than hardcoding.

---

## Stage

**Form.** A procession of stele on switchback tiers, and a rotating quantum drum at the CPU
column.
**Accent.** `CYAN.core`, with `AMBER.dim` accumulating on aging processes.
**Environment.** A mountain pass climbing through switchbacks. Each switchback tier is one MLFQ
queue level, with the highest-priority level at the top and the longest quanta at the bottom.
Demotion is a process physically dropping to the tier below.
**Hero visual.** A starving process on the bottom tier, its stele shortened and drained to
slate, holding still while the top tier cycles through six processes in the same time. The whole
starvation lesson is one wide shot, and the remedy (priority aging) is visible as the starved
stele climbing back up a tier.

| Anchor id | Structure | Focus camera target |
|---|---|---|
| `anchor.pass` | The whole switchback pass | wide establishing; the starvation hero shot frames from here |
| `anchor.ledge` | The single-runner ledge | head-on down the ledge |
| `anchor.ledge_control` | The policy selector: seven policies, quantum dial, aging dial, level quanta array | head-on orthographic; all seven policies and their current parameters legible |
| `anchor.quantum_drum` | The rotating drum at the CPU column, one revolution per quantum, gaps drawn at switches | head-on, revolution rate readable |
| `anchor.gantt_wall` | The Gantt ribbon along the ledge wall, drawn from the live event log, switches as gaps to scale | head-on orthographic; this is the leg's most important lock and must stay readable at 300+ ticks of history |
| `anchor.tier.0` … `anchor.tier.2` | The three MLFQ switchback tiers | head-on per tier; a demotion is a physical drop between them |
| `anchor.wait_counter.<pid>` | The wait counter above each ready stele, reading `readySince` directly | included in the establishing shot; must be readable without a lock |
| `anchor.estimate_depot` | The burst estimate depot. Sells predicted burst lengths from exponential averaging. | head-on, estimate against actual for each process |
| `anchor.depot` | The leg 3 depot | head-on |
| `anchor.convoy.<member>` | Per-Program stele | head-on |

### The Gantt ribbon

This is the leg's central instrument and it has three hard requirements.

1. **Overhead is drawn to scale, as area.** A context switch is a gap whose width is the switch
   cost in ticks. At quantum 2 the gaps must be visibly wider than the work bands. Never report
   overhead as a number where a gap would do.
2. **It is drawn from the live event log**, specifically `context.switch` and `quantum.expired`
   events, and never from a parallel bookkeeping structure in the leg. If the ribbon and the
   event log can disagree, the ribbon is wrong.
3. **Policy change snaps.** Per the visual bible's motion language, a policy change redraws the
   ribbon's future projection instantly rather than easing. The past does not redraw.

`gantt --replay` draws two ribbons stacked on the same wall with the same time axis, the run
that happened above and the replay below, diverging at the tick where the policies first make
different decisions. WP-18's counterfactual replay uses the same two-ribbon presentation, so
build the drawing code as a world structure with a documented interface and tell WP-18 where
it is.

---

## Interactions

```ts
export const interactions: readonly InteractionDef[] = [
  {
    id: 'pass.set_policy',
    label: 'Set scheduling policy',
    description: 'Change the policy on the running system. All seven are available and none of them is free.',
    anchor: 'anchor.ledge_control',
    cost: { cycles: 6 },
    enabledWhen: (run) => run.resources.cycles >= 6,
  },
  {
    id: 'pass.set_quantum',
    label: 'Set the quantum',
    description: 'Ticks each ready process gets in turn. There is a floor and a ceiling and both hurt.',
    anchor: 'anchor.ledge_control',
    cost: { cycles: 4 },
    enabledWhen: (run) => run.resources.cycles >= 4,
  },
  {
    id: 'pass.set_aging',
    label: 'Set the aging interval',
    description: 'Ticks a ready process waits before gaining a priority level. Zero disables it.',
    anchor: 'anchor.ledge_control',
    cost: { cycles: 4 },
    enabledWhen: (run) => run.resources.cycles >= 4,
  },
  {
    id: 'pass.set_levels',
    label: 'Set the level quanta',
    description: 'One quantum per multilevel feedback queue level, highest priority first.',
    anchor: 'anchor.ledge_control',
    cost: { cycles: 6 },
    enabledWhen: (run) => run.resources.cycles >= 6,
  },
  {
    id: 'pass.buy_estimates',
    label: 'Buy burst estimates',
    description: 'Predicted burst lengths from exponential averaging over previous bursts. They are predictions.',
    anchor: 'anchor.estimate_depot',
    cost: { cycles: 30, bandwidth: 4 },
    enabledWhen: (run) => run.resources.cycles >= 30 && run.resources.bandwidth >= 4,
  },
  {
    id: 'pass.read_gantt',
    label: 'Read the ribbon',
    description: 'Lock to the Gantt wall. Gaps are switches and idle, drawn to scale.',
    anchor: 'anchor.gantt_wall',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'pass.read_wait_counters',
    label: 'Read the wait counters',
    description: 'How long each ready Program has been ready without running.',
    anchor: 'anchor.pass',
    cost: {},
    enabledWhen: () => true,
  },
];
```

`nice` is terminal-only. `gantt --replay` is terminal-only. Both are the leg's teaching
instruments and the player must go and read a man page to use them.

At `architect` and above, per the economy, every policy change costs cycles. The costs above are
the `operator` values; scale them with `tierFactor`.

---

## Terminal commands

Three commands, copied verbatim from the curriculum map into
`src/legs/quantum_pass/commands.ts`: `sched`, `nice`, `gantt`. The full `manual` text is in
`docs/05-CURRICULUM-MAP.md`, "Leg 3. QUANTUM PASS". Copy byte for byte.

The `sched` man page contains the full seven-policy table, and every line of it is load-bearing.
Three that are load-bearing beyond the rest:

- "This policy starves processes. It is not a defect in the implementation." That sentence is
  the entire first misconception, stated in advance, and the player will still not believe it
  until they watch it.
- "Set it near 1 and the system spends its time saving and restoring registers; measure it with
  top and watch sys climb while throughput falls." That is the second misconception's
  instruction for how to check.
- "Requires knowing burst lengths in advance, which no real system does; see --estimate." That
  is the third misconception's setup.

From `nice`: "Using nice to rescue a starving process works, once. It fixes this process now.
It does not fix the policy that starved it, and the next process down will starve in exactly
the same way. Aging fixes the policy."

From `gantt`: "--replay re-runs the exact arrival times and burst lengths you already
experienced, under a different policy, and prints both charts. The run is deterministic, so this
is a real comparison rather than an estimate."

### `gantt --replay` implementation contract

This is the leg's most reusable artefact. Build it as follows.

1. Snapshot the kernel at the segment's arrival tick and keep the snapshot for the leg's
   lifetime.
2. On `--replay <policy>`, construct a shadow kernel from that snapshot, call `setScheduler`
   with the named policy, run it for the segment's tick count, and collect its
   `SchedulingMetrics` and its `context.switch` sequence.
3. The shadow kernel must not emit into the live event stream and must not touch `RunState`.
   Assert this with a test that runs 200 replays and checks the live event log hash is
   unchanged.
4. Replaying the current policy must reproduce the live run exactly, byte for byte. That is the
   correctness check for the whole mechanism and it is fixture `DET-D1` applied to a subrange.
5. Return both ribbons plus the four metrics for each: waiting, turnaround, response,
   utilisation.

WP-18's counterfactual replay is the same operation at run scale rather than segment scale.
Coordinate the interface before you build so the report can call it without a second
implementation.

---

## Event table

Copied verbatim from `04-NARRATIVE-BIBLE.md` section 8, leg 3. Weights sum to 100. Note that
`quantum.short_job_flood` carries a comment rather than a predicate in the source; implement the
predicate in the leg module.

```ts
export const quantumPassEvents: readonly RandomEventDef[] = [
  {
    id: 'quantum.priority_sweep',
    weight: 14,
    title: 'Priority Sweep',
    narration: 'A maintenance sweep enters the pass at priority 4 and stays for two hundred ticks. Everything the convoy has below it stops being scheduled and stays ready.',
    targets: null, inflicts: 'starvation',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'quantum.short_job_flood',
    weight: 12,
    title: 'Short Job Flood',
    narration: 'A stream of two-tick jobs arrives and the shortest-first policy serves every one of them ahead of the convoy. The convoy has the longest burst on the board and always will.',
    targets: null, inflicts: 'starvation',
    resourceDelta: {},
    onlyIf: (run) => currentScheduler(run) === 'sjf' || currentScheduler(run) === 'srtf',
  },
  {
    id: 'quantum.expiry_storm',
    weight: 13,
    title: 'Expiry Storm',
    narration: 'The quantum expires on the convoy nine times in forty ticks, each time three instructions into useful work. The saving and restoring is charged at full rate.',
    targets: null, inflicts: 'cache_thrash',
    resourceDelta: { cycles: -50 },
    onlyIf: null,
  },
  {
    id: 'quantum.inversion_chapel',
    weight: 12,
    title: 'The Low Holder',
    narration: 'A background process at priority 34 holds the pass gate and is preempted every time it nearly finishes. Everything above it waits on something below it.',
    targets: 'sentinel', inflicts: 'priority_inversion',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'quantum.mlfq_demotion',
    weight: 11,
    title: 'Demoted',
    narration: 'A convoy Program uses its full slice twice and the multilevel queue drops it a level for it. Being busy is indistinguishable from being greedy at this altitude.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -35, bandwidth: -4 },
    onlyIf: null,
  },
  {
    id: 'quantum.aging_beacon',
    weight: 16,
    title: 'Aging Beacon',
    narration: 'An abandoned aging beacon still raises the priority of anything that has waited too long near it. SABLE marks the position and the convoy keeps to that side of the pass.',
    targets: 'sentinel', inflicts: null,
    resourceDelta: { cycles: 55 },
    onlyIf: null,
  },
  {
    id: 'quantum.gantt_survey',
    weight: 12,
    title: 'Completed Survey',
    narration: 'A survey marker at the summit records every schedule that has crossed here and what it cost. Average waiting time for the convoy\'s current policy is on the stone.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 40, bandwidth: 6 },
    onlyIf: null,
  },
  {
    id: 'quantum.idle_windfall',
    weight: 10,
    title: 'Idle CPU',
    narration: 'For thirty-one ticks nothing else is runnable and the convoy has the whole processor. It does not happen again.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 70, quota: 20 },
    onlyIf: null,
  },
];
```

`quantum.gantt_survey` must print a real number read from the live `SchedulingMetrics`, not a
narration string with a placeholder. It is the only event in the game that reports simulator
state as its payoff.

---

## Evaluation

### Survival

The leg is survived when at least one convoy Program is alive at leg end.

**The death path, in full.** Under `priority` with aging disabled, the lowest-priority Program
in the convoy stops being selected. `readySince` stops advancing toward `lastScheduledTick`. At
`starvationThreshold` (120) a `process.starving` event fires with `fatal: false` and the Program
acquires the `starvation` affliction (2.5 integrity per travel tick, fatal after 45 in this
leg's instance). At `starvationFatalThreshold` (300) it derezzes with
`TerminationReason: 'starvation'`.

SABLE survives three times the normal threshold per the convoy table, so a convoy that still
has SABLE gets a longer warning window, and a player who does not read the warning still loses
somebody else. Implement the SABLE multiplier as a per-member override on the threshold, not as
a global change.

The epitaph `cause` line reads exactly: *"it was ready to run for 340 consecutive ticks. A
priority policy with no aging will pick a higher-priority process every single time one
exists."* The 340 comes from the frozen fixture; if your tuning produces a different number,
change the tuning rather than the sentence, because the sentence is quoted in the design brief
lineage and the number has to be the one the wait counter showed.

`codexEntry` on the epitaph is `codex.priority_starvation`.

**The remedies.** `{ kind: 'set_scheduler', to: 'priority_aging' }` or
`{ kind: 'terminal', command: 'nice' }`.

**The instructive wrong remedy.** Raising the quantum does nothing at all under a priority
policy, because the quantum is not what is excluding the Program. The game lets the player try
it and watch the counter keep climbing. Record it in the decision log with
`kind: 'raise_quantum_under_priority'` and mark it `costly` when the Program later dies, `good`
never. The quantum change must genuinely have no effect on selection under `priority`; do not
give it a small effect to be kind.

### Objectives

| Objective | Computed from |
|---|---|
| `obj.quantum_pass.waiting_time_target` | `SchedulingMetrics.averageWaitingTime < 12` at `evaluate()` **and** zero `process.starving` events carrying `fatal: true`. |
| `obj.quantum_pass.sjf_is_optimal` | At least three `gantt --replay` invocations naming distinct **non-preemptive** policies on the same recorded arrival set, followed by the player committing `sjf` for that segment. The margin is recorded in the decision log. |
| `obj.quantum_pass.quantum_sizing` | The committed quantum is between 1.2 and 4.0 times the median `burst` of the segment's `ProcessSpec` set, **and** `contextSwitches * SWITCH_COST / totalCpuTicks < 0.10`, **and** `averageResponseTime < 8`. |
| `obj.quantum_pass.clear_starvation` | An active `starvation` affliction was cleared within 20 ticks of the first `process.starving` warning, by a `setScheduler` to `priority_aging` or a `nice` on the starved pid. |
| `obj.quantum_pass.avoid_convoy_effect` | On segment 1, the committed policy is not `fcfs` and the segment's average waiting time is at least 30 percent below the recorded FCFS baseline. |
| `obj.quantum_pass.tune_mlfq` | At segment 4 end, read `queueLevel` per PCB: both interactive Programs at level 0, the CPU-bound Program at level 2 or lower, and no Program's ready time exceeds the aging interval. |
| `obj.quantum_pass.switch_rate` | `contextSwitches / totalCpuTicks < 1/6` while a preemptive policy is in force. |

### Debrief card

```ts
{
  headline: /* 'Over the pass.' or 'SABLE never ran.' */,
  whatHappened:
    `You crossed under ${policyList.join(', then ')}. Average waiting time was ` +
    `${avgWait.toFixed(1)} ticks against a target of 12. Context switches: ${switches}, ` +
    `costing ${(switchPct * 100).toFixed(0)} percent of total processor time. ` +
    `Worst wait: ${worstWait} ticks, by ${worstName}.`,
  whyItHappened: /* selected from the four cases below */,
  counterfactual: /* computed from a real shadow replay, see below */,
  chapter: { chapter: 5, title: 'CPU Scheduling', sections: ['5.3.4'] },
}
```

`whyItHappened`, selected by what actually occurred:

- **A Program starved.** "A priority policy selects the lowest priority number that is ready.
  With aging disabled there is no path from waiting to the front except becoming more urgent,
  and nothing was going to make it more urgent."
- **Convoy effect.** "First come first served ran the long job to completion while four
  three-tick jobs waited behind all of it. Nothing failed. The ordering was the cost."
- **Switch overhead.** "The quantum was ${q} against a median burst of ${m}. Almost no burst
  finished inside a slice, so almost every slice ended in a save and a restore."
- **Clean crossing.** "You changed policy ${n} times and each change was in response to
  something on the ribbon."

The counterfactual is a **real shadow replay**, not a text template. Pick the segment with the
worst average waiting time, replay it under the best alternative policy, and report both
numbers:

> "Segment ${i} ran ${avgActual} average waiting under ${actual}. The same arrivals under
> ${best} run ${avgBest}."

If a Program died, the counterfactual replays under `priority_aging` from the tick of the first
starvation warning and reports whether that Program survives in the replay. This is the
strongest single moment in the leg, and it is the machinery panel 5 of the end-of-run report
reuses.

---

## Acceptance criteria

1. `src/legs/quantum_pass/index.ts` satisfies `Leg` under `tsc --strict`, `id === 'quantum_pass'`,
   `index === 3`.
2. The leg runs headlessly to completion via the WP-20 smoke-test harness.
3. `enabledSubsystems` deep-equals `['process', 'scheduler']`; `sync` and `deadlock` are not
   enabled and no sync primitive is created.
4. Inert-field independence over 400 ticks.
5. The leg opens under `priority` with `agingInterval: 0` and `preemptive: false`. A test
   asserts the entry configuration exactly.
6. Every objective can be met by the known-good decision sequence; all seven met in one run.
7. The known-bad sequence produces the intended failure: no policy change, SABLE's `readySince`
   reaches 340, a `process.starving { fatal: true }` fires, SABLE derezzes with
   `TerminationReason: 'starvation'`, and the epitaph cause line matches the frozen text
   including the number 340.
8. Raising the quantum under `priority` changes no scheduling decision. Asserted by running the
   segment at quantum 2, 8 and 32 and comparing `context.switch` sequences for equality.
9. All fourteen `SCHED-*` fixtures pass against the policies this leg exposes, including the
   per-process detail table for `SCHED-SRTF-1`, `SCHED-PRIO-1` and `SCHED-MLFQ-1`.
10. `gantt --replay` under the current policy reproduces the live run byte for byte. Asserted
    over all four segments and all seven policies.
11. `gantt --replay` never mutates the live event log or `RunState`. Asserted over 200 replays
    by hashing the live log before and after.
12. Segment 2's SJF advantage is exactly the fixture: `sjf` 7.0 average waiting against `fcfs`
    10.25, a margin of 3.25.
13. `priority_aging` on the `SCHED-AGING-1B` set produces worst wait 8 against `priority`'s 16,
    with average waiting rising from 3.2 to 3.6. Both directions asserted.
14. MLFQ final queue levels on `SCHED-MLFQ-1` are P1 = 2, P2 = 1, P3 = 0.
15. Burst estimates use exponential averaging with alpha 0.5 over the process's own previous
    bursts, and the estimate is wrong on the behaviour-change segment by at least 40 percent.
16. Event table weights sum to exactly 100; all ids unique; `quantum.short_job_flood`'s
    predicate gates on `sjf` or `srtf`.
17. All three terminal command `manual` strings match the curriculum map byte for byte.
18. Draw calls stay under 220 / 450 / 900 at the heaviest frame, which is three tiers populated
    with 16 stele plus 300 ticks of Gantt ribbon plus a two-ribbon replay in view.
19. The Gantt ribbon remains readable at 300 ticks of history at every tier, with switch gaps
    drawn to scale and distinguishable from work bands at the low tier's SDF glyph size.
20. The starvation hero shot holds: from `anchor.pass`, the starved stele's wait counter is
    readable and the top tier visibly cycles at least six processes in the time the starved
    stele holds still.

---

## Tests you must write

All under `tests/legs/quantum_pass/`.

**`contract.test.ts`**: `Leg` conformance, exact ids, chapters, seven objectives.

**`config.test.ts`**: the entry configuration exactly: `scheduler: 'priority'`,
`agingInterval: 0`, `preemptive: false`, `starvationThreshold: 120`,
`starvationFatalThreshold: 300`, `levelQuanta: [4, 8, 16]`. `enabledSubsystems` exact.
Inert-field independence. Quantum follows the pace table for all four paces.

**`populate.test.ts`**: twenty spawns (five convoy plus fifteen workload), five binds, exact
priorities, bursts, services and arrivals. Zero resource and sync declarations.

**`fixtures.test.ts`**: every `SCHED-*` row from `docs/02-KERNEL-SIM-SPEC.md` section 16.3,
run through this leg's segments where the workload matches, including the per-process waiting,
turnaround and response detail table.

**`replay.test.ts`**: the `gantt --replay` contract.
- Replaying the current policy reproduces the live run byte for byte, for all four segments and
  all seven policies.
- Replay does not mutate the live log or `RunState`, over 200 replays.
- Two ribbons are returned with the same time axis and the divergence tick is correct.
- Metrics returned match a direct kernel run of the same policy on the same snapshot.

**`starvation.test.ts`**: the death path.
- Under the entry configuration with no intervention, SABLE's `readySince` reaches 340 and a
  `process.starving { fatal: true }` fires.
- SABLE's threshold multiplier is 3x and applies to SABLE only; a convoy without SABLE loses a
  different member sooner.
- Switching to `priority_aging` within 20 ticks of the warning clears the affliction.
- `nice -n -5` on the starved pid clears it once and the next Program down starves.
- Raising the quantum changes nothing: identical `context.switch` sequences at quantum 2, 8, 32.
- The epitaph text, including the number 340, matches the frozen fixture exactly.

**`estimates.test.ts`**: exponential averaging with alpha 0.5 over previous bursts; the
estimate on the behaviour-change segment is wrong by at least 40 percent; `srtf` on that
estimate makes a preemption that `gantt --replay rr` beats.

**`evaluate.test.ts`**: each of the seven objectives, met and not met. In particular:
`sjf_is_optimal` fails when one of the three replays names a preemptive policy;
`quantum_sizing` computes the median per segment and admits 8 through 26 on segment 2;
`tune_mlfq` reads `queueLevel` and not a proxy.

**`golden.test.ts`**: the golden headless playthrough.
- Fixture: `seed: 0x4b54524c`, `discClass: 'shell'`, `difficulty: 'operator'`, steady pace,
  standard rations, entering with the leg 2 golden closing ledger.
- Known-good sequence, in order:
  1. `pass.read_wait_counters`, then `gantt --metrics` on segment 1.
  2. `gantt --replay sjf`, `gantt --replay fcfs`, `gantt --replay priority` on segment 2.
  3. `pass.set_policy` to `sjf` for segment 2.
  4. On the first `process.starving` warning: `pass.set_policy` to `priority_aging` and
     `pass.set_aging` to 2, within 20 ticks.
  5. `pass.set_policy` to `rr` and `pass.set_quantum` to 8 for the switch-rate segment.
  6. `pass.set_policy` to `mlfq` and `pass.set_levels` to `[4, 8, 16]` for segment 4.
- Assert: all seven objectives met, zero casualties, average waiting under 12, switch rate under
  1 per 6, MLFQ levels P1 = 2, P2 = 1, P3 = 0, seven codex entries added, canonical event log
  hash matches the checked-in golden file, stable across two runs and a snapshot-restore.

**`badpath.test.ts`**: the known-bad sequence.
- Change nothing. Cross at reckless pace.
- Assert: SABLE reaches 340 ready ticks, `process.starving { fatal: true }`, SABLE derezzes with
  `TerminationReason: 'starvation'`, epitaph text and `codexEntry` exact, four objectives failed,
  counterfactual is a real replay under `priority_aging` in which SABLE survives, and
  `survived === true` because four Programs remain.

**`badpath2.test.ts`**: the second known-bad sequence.
- Reckless pace, quantum 2, never leave `rr`.
- Assert: switch overhead above 30 percent of total CPU, `obj.quantum_pass.switch_rate` and
  `obj.quantum_pass.quantum_sizing` both failed, response time improved by under 1 tick against
  quantum 8 while utilisation fell by at least 20 points.

**`manuals.test.ts`**: three manual strings against the curriculum map fixture; every
`See also:` topic resolves; the `sched` policy table lists all seven ids.

**`stage.test.ts`**: anchors resolve; interaction anchors resolve; draw calls under budget at
the heaviest frame; the Gantt ribbon renders 300 ticks of history within budget at low tier;
the starvation hero shot assertion.

---

## Out of scope

- Do not touch any other leg. Do not import from `src/legs/*` other than your own directory.
- Do not modify the frozen type files or anything under `src/kernel`, `src/render`,
  `src/world`, `src/terminal`, `src/ui`, `src/audio`, `src/design`, `src/platform`, `src/app`.
  If a scheduler policy is wrong, file it against WP-03 or WP-04; do not patch it from the leg.
- Do not enable `sync`. The priority-inversion event inflicts an affliction; it does not
  simulate a mutex. The Narrows owns real priority inversion.
- Do not open the leg on a safe policy. `priority` with `agingInterval: 0` is the entry
  configuration and it is the whole first misconception.
- Do not give the quantum a partial effect under `priority` to soften the wrong remedy.
- Do not implement a second replay mechanism for WP-18. Coordinate and share one.
- Do not implement real-time scheduling for section 5.6.
- Do not change the epitaph's 340 to match a different tuning. Change the tuning.

### Files this package owns exclusively

```
src/legs/quantum_pass/index.ts
src/legs/quantum_pass/chapters.ts
src/legs/quantum_pass/objectives.ts
src/legs/quantum_pass/config.ts
src/legs/quantum_pass/populate.ts
src/legs/quantum_pass/interactions.ts
src/legs/quantum_pass/commands.ts
src/legs/quantum_pass/events.ts
src/legs/quantum_pass/evaluate.ts
src/legs/quantum_pass/segments.ts
src/legs/quantum_pass/replay.ts
src/legs/quantum_pass/estimates.ts
src/legs/quantum_pass/stage.ts
src/legs/quantum_pass/copy.ts
tests/legs/quantum_pass/**
```

---

## Report back

1. Commit or branch, and the full `tests/legs/quantum_pass/` output.
2. Golden playthrough hash and its checked-in path.
3. The frozen starvation fixture: the tick SABLE's `readySince` reaches 340 at steady pace with
   no intervention, and the same at each of the other three paces.
4. A table of all four segments under all seven policies: average waiting, turnaround, response,
   utilisation, context switches. This table is the leg's balance record and the debrief quotes
   from it.
5. The `gantt --replay` interface as you built it, and confirmation that WP-18 has agreed to
   consume it rather than reimplement it.
6. Draw calls at each tier, and the measured legibility of the Gantt ribbon at 300 ticks of
   history at low tier.
7. Every `SCHED-*` fixture result against its expected value.
8. Any document disagreement, what you did, and which document you followed.
9. Confirmation that no file outside the owned list was created or modified.

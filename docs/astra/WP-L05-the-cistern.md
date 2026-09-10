# WP-L05: The Cistern

Leg id `the_cistern`, index 5. Subtitle: *Filling, draining, and the five who cannot eat.*

**Legs are independent and may be built concurrently.** This package touches no other leg,
imports from no other leg, and shares no source file with any other leg.

---

## Objective

A module at `src/legs/the_cistern/` implementing the frozen `Leg` interface, playable end to
end. The Cistern is a lit tank with intake pipes above and drain taps below, and the convoy
needs it at a stable level to refill quota. The second half of the leg is a ring of five taps in
a circle, each needing two handles, with one handle between each adjacent pair.

**This leg deadlocks the player one leg before deadlock is named.** That is deliberate and it is
the structural reason the Gridlock works. The Gridlock's opening card names the Cistern ring by
tick number, so this leg must record that tick and hand it forward.

Concept density here is in application rather than in new terms: six new codex entries against
leg 4's eight, almost entirely reusing leg 4's primitives. It is the relief slope before the
deadlock spike, and its own load is still high.

---

## Prerequisites

**Engine work packages:** WP-01 Determinism core, WP-02 Process and PCB layer, WP-03
Scheduler registry, **WP-07 Synchronisation complete**, WP-11 Syscall interface, WP-17 Run
state and afflictions, WP-19 Leg runner including the crossing system, WP-15 Terminal shell,
WP-17 HUD and codex, WP-12 Renderer core, WP-13 Focus camera, WP-13 World structures (the
tank, the slot column, the five-node ring with beams), WP-14 Derezz, WP-20 Smoke-test runner.

**Kernel subsystems:** `process`, `scheduler`, `sync`, `deadlock`. The `deadlock` subsystem is
enabled but its strategy is `ignore`, which means cycles form and nothing reports them except
where the leg explicitly turns detection on for the two-node intake case. Fixtures `SYNC-BB-1`,
`SYNC-BB-DEADLOCK`, `SYNC-RW-STARVE`, `SYNC-RW-WRITERPREF`, `SYNC-PHIL-NAIVE`,
`SYNC-PHIL-ASYM`, `SYNC-PHIL-ROOM` and `SYNC-PHIL-MONITOR` must pass before this leg starts.

Monitor semantics must be switchable between signal-and-continue (Mesa) and signal-and-wait
(Hoare), because the third misconception break needs the player to flip between them.

---

## Required reading

- `docs/05-CURRICULUM-MAP.md`, "Leg 5. THE CISTERN" in full.
- `docs/02-KERNEL-SIM-SPEC.md`, section 8 (Synchronisation, Ch. 6 and 7), specifically the
  bounded buffer, readers-writers and dining philosophers material; section 16.7.
- `docs/04-NARRATIVE-BIBLE.md`, section 12 (critical section crossings; the Cistern owns two of
  the nine); section 7 entries for `starvation`, `livelock` and `lock_convoy`; section 8 leg 5
  event table; section 10 (the leg 5 depot).
- `docs/03-VISUAL-BIBLE.md`, section 10 "Leg 5, The Cistern"; section 13 (quality tiers).

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
  { chapter: 7, title: 'Synchronization Examples',
    sections: ['7.1.1', '7.1.2', '7.1.3', '7.2.1', '7.2.2', '7.5.1', '7.5.2'] },
  { chapter: 6, title: 'Synchronization Tools',
    sections: ['6.6.2', '6.7.2'] },
];
```

The chapter 6 citations carry forward the counting semaphore and the condition variable, which
the Cistern uses rather than introduces. Sections 7.3 and 7.4 are API-specific (POSIX and Java)
and are out of scope.

### Learning objectives

```ts
export const objectives: readonly LearningObjective[] = [
  {
    id: 'obj.the_cistern.stable_buffer',
    statement: 'Sets producer count, consumer count and buffer capacity so cistern occupancy stays between 10 and 90 percent for 400 consecutive ticks, with zero overflow spills and zero underflow draws.',
    chapter: { chapter: 7, title: 'Synchronization Examples', sections: ['7.1.1'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.the_cistern.semaphore_ordering',
    statement: 'Orders the empty, full and mutex acquisitions so that the mutex is taken after the counting semaphore in both producer and consumer, producing zero deadlock.detected events on the intake path.',
    chapter: { chapter: 7, title: 'Synchronization Examples', sections: ['7.1.1'] },
    assessedBy: 'terminal_command',
  },
  {
    id: 'obj.the_cistern.reader_writer_policy',
    statement: 'Chooses an rwlock policy under which the pending writer waits no more than 30 ticks while reader throughput stays above 60 percent of the reader-preference baseline.',
    chapter: { chapter: 7, title: 'Synchronization Examples', sections: ['7.1.2'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.the_cistern.clear_writer_starvation',
    statement: 'Clears a starvation affliction on the writer Program by moving the rwlock from reader preference to writer preference or to fair queueing, before the writer reaches its fatal threshold.',
    chapter: { chapter: 7, title: 'Synchronization Examples', sections: ['7.1.2'] },
    assessedBy: 'survival',
  },
  {
    id: 'obj.the_cistern.break_the_ring',
    statement: 'Breaks the five-tap ring by capping simultaneous seaters at four or by reversing one Program acquisition order, ending the segment with zero deadlock.detected events.',
    chapter: { chapter: 7, title: 'Synchronization Examples', sections: ['7.1.3'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.the_cistern.signal_after_predicate',
    statement: 'Signals the condition variable after changing the predicate it guards, leaving zero Programs blocked on a condition whose predicate is already true at segment end.',
    chapter: { chapter: 6, title: 'Synchronization Tools', sections: ['6.7.2'] },
    assessedBy: 'outcome',
  },
];
```

### Codex entries this leg adds to `codexUnlocked`

`codex.bounded_buffer`, `codex.readers_writers`, `codex.dining_philosophers`,
`codex.condition_variable`, `codex.mesa_vs_hoare`, `codex.kernel_sync`.

| Entry | Added when |
|---|---|
| `codex.bounded_buffer` | First `buffer` invocation, or the first overflow or underflow. |
| `codex.readers_writers` | First `rwlock` invocation. |
| `codex.dining_philosophers` | The ring closes: five Programs each holding one handle. |
| `codex.condition_variable` | First block on a `BlockReason` of kind `condition`. |
| `codex.mesa_vs_hoare` | The Mesa toggle is flipped, in either direction. |
| `codex.kernel_sync` | The intake ordering error is fixed, or the leg completes. |

`codex.dining_philosophers` is cross-linked from the Gridlock and from the Bus. Register the
back-links here; the two later legs register their forward links.

### Misconceptions this leg must break

**"A semaphore is just a lock with a longer name."** Students who met mutexes first collapse the
two and the counting behaviour never registers. The break is a forced comparison at the intake:
the cistern has three intake ports and the player is first given only a mutex. Throughput is one
third of capacity and the world shows two idle ports. Replacing it with a semaphore of count 3
fills all three ports with no correctness change, and `sem --list` shows the value dropping 3,
2, 1, 0 as they enter.

Build requirement: three physical intake ports at the tank, visibly idle under the mutex. The
throughput difference must be measurable and must be exactly 3x, so the player can check it.

**"signal hands the monitor and the condition straight to the waiter, so if I checked the
predicate before waiting I do not need to check it again."** This produces the `if` instead of
`while` bug, which is invisible until a third party intervenes. The break is the Mesa toggle at
the alcove. The Cistern runs signal-and-continue, which is what every real system does. A
consumer is signalled that the buffer is non-empty, and by the time it is scheduled another
consumer has taken the item. Under the `if` version it draws air and takes integrity damage;
under the `while` version it re-checks and sleeps again. The player can flip the toggle to
signal-and-wait and watch the `if` version start working.

Build requirement: both the predicate-check style (`if` or `while`) and the monitor semantics
(Mesa or Hoare) are player-settable, independently. Four combinations, and the player can run
all four. Only `while` under Mesa and both styles under Hoare are correct, and the codex entry
shows the two-line difference.

**"Dining philosophers is a puzzle, not a thing that happens."** The break is placed two legs
later on purpose: the same five-node ring reappears in the Gridlock as four Programs holding
gate keys, and again in the Bus as two Programs each holding one of two device locks. The claim
being broken is that the shape is artificial, and the refutation is that the player meets it
three times in unrelated subsystems.

Build requirement here: record the tick at which the ring closes and hand it forward in the leg
outcome. The Gridlock's opening card names it. Coordinate the field with WP-17.

---

## Kernel configuration

```ts
export function kernelConfig(run: RunState): KernelConfig {
  return {
    seed: run.seed,
    scheduler: 'rr',                       // preemption drives the interleaving the leg depends on
    schedulerParams: {
      quantum: quantumForPace(run.policy.pace),
      agingInterval: 0,                    // writer starvation must be curable by POLICY, not by aging
      starvationThreshold: 120,            // the writer's warning
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
    journalingEnabled: false,              // inert
    deadlockStrategy: 'ignore',            // THE DEFAULT IS DELIBERATE. The ring stops and nothing reports it.
    thrashingThreshold: 200,               // inert
    enabledSubsystems: ['process', 'scheduler', 'sync', 'deadlock'],
  };
}
```

`enabledSubsystems` includes `deadlock`, and `deadlockStrategy` is `ignore`. That combination is
exact and it is the leg's whole ending: cycles form, `Kernel.detectDeadlock()` would find them
if asked, and no `deadlock.detected` event fires under `ignore`. The Programs stop and the
convoy stops with them.

One exception: the intake ordering error produces a two-node cycle that **does** fire
`deadlock.detected`, per fixture `SYNC-BB-DEADLOCK` and per the curriculum map's failure mode
text. Implement that by having the intake path run under `detect` for its own primitives while
the ring runs under `ignore`. If WP-08 cannot scope the strategy per resource, run the whole
leg under `detect` and suppress the ring's report in the leg, and note which you did. Do not
change the player-visible behaviour: the ring must stop silently.

`agingInterval: 0` is load-bearing. Writer starvation here must be cured by moving the rwlock
policy, not by aging, which is what distinguishes it from the Quantum Pass version of the same
affliction.

---

## Population

```ts
export function populate(ctx: LegSetupContext): void {
  const roster: readonly [ConvoyMemberId, string, number, number, number][] = [
    ['lumen',   'LUMEN',   2, 6, 58],
    ['sable',   'SABLE',   2, 5, 52],
    ['orrery',  'ORRERY',  3, 5, 52],   // the writer; ORRERY starves under reader preference
    ['kestrel', 'KESTREL', 3, 4, 46],
    ['vesper',  'VESPER',  3, 5, 52],
  ];
  roster.forEach(([member, name, priority, burst, service], i) => {
    const pid = ctx.spawn({ name, priority, burst, service, arrival: i, pages: 6 });
    ctx.bind(member, pid);
  });

  // Bounded buffer workload. Player sets counts; these are the pool the counts draw from.
  for (let i = 0; i < 6; i++) {
    ctx.spawn({ name: `cistern.producer_${i}`, priority: 4, burst: 3, service: 60, arrival: 6 + i, pages: 3 });
  }
  for (let i = 0; i < 6; i++) {
    ctx.spawn({ name: `cistern.consumer_${i}`, priority: 4, burst: 3, service: 60, arrival: 6 + i, pages: 3 });
  }

  // Readers-writers workload at the archive alcove. Six readers against one writer (ORRERY).
  for (let i = 0; i < 6; i++) {
    ctx.spawn({ name: `cistern.reader_${i}`, priority: 4, burst: 2, service: 50, arrival: 40 + i * 2, pages: 3 });
  }

  // The ring. Five seaters, one per tap.
  for (let i = 0; i < 5; i++) {
    ctx.spawn({ name: `cistern.seat_${i}`, priority: 4, burst: 2, service: 70, arrival: 80, pages: 3 });
  }

  // Primitives.
  ctx.declareSync('sem.empty',  'semaphore', 16);  // free slots; capacity tracks buffer capacity
  ctx.declareSync('sem.full',   'semaphore', 0);   // filled slots
  ctx.declareSync('mutex.buf',  'mutex',     1);   // protects the buffer structure
  ctx.declareSync('sem.intake', 'semaphore', 1);   // player raises this to 3; three physical ports
  ctx.declareSync('rw.archive', 'rwlock',    6);   // readers-writers at the alcove
  ctx.declareSync('mon.cistern','monitor',   1);   // the condition variable lives here
  for (let i = 0; i < 5; i++) {
    ctx.declareSync(`handle.${i}`, 'mutex', 1);    // the five handles between the five taps
  }
  ctx.declareSync('sem.room',   'semaphore', 5);   // the seating cap; player lowers it to 4
}
```

### Known-correct numbers

Take these from the sim spec's fixtures so the leg is verifiable.

`SYNC-BB-1`: bounded buffer n=4, 3 producers of 20 items each, 2 consumers of 30 each. Produced
equals consumed equals 60. Occupancy always in [0, 4]. Zero races. Use this as the balanced
reference; `obj.the_cistern.stable_buffer` asks for a larger buffer over a longer window, so
scale it: buffer capacity 16, 3 producers, 3 consumers, occupancy held in [1.6, 14.4] for 400
consecutive ticks.

The invariant `empty + full == capacity` must hold at every tick. `sem --list` shows both, and a
drift means a signal was lost. Assert the invariant every tick in the dev build.

`SYNC-BB-DEADLOCK`: a producer that takes the mutex before waiting on `empty` produces
`deadlock.detected` with a cycle of exactly 2 pids. That is the intake ordering error and it is
the sharper of the leg's two failures.

`SYNC-RW-STARVE`: reader-preferring, 6 readers, 1 writer, produces exactly one
`process.starving { fatal: true }` naming the writer. `SYNC-RW-WRITERPREF`: the same workload
under writer preference completes the writer and a reader becomes the longest waiter. Record the
reader-preference baseline for reader throughput at segment entry;
`obj.the_cistern.reader_writer_policy` needs throughput above 60 percent of it with writer wait
under 30 ticks. Fair queueing sits between the two and satisfies both; writer preference
satisfies the wait and may or may not satisfy the throughput floor depending on tuning. Tune so
that both `fair` and `writer` pass and `reader` fails, and freeze the numbers.

`SYNC-PHIL-NAIVE`: five philosophers, left-then-right, quantum 1, produces `deadlock.detected`
by tick 200 with a cycle of exactly 5 pids and `conditions` containing all four Coffman values.
Under this leg's `ignore` strategy the cycle forms identically and no event fires; assert the
cycle exists by calling `detectDeadlock()` in the test rather than by waiting for an event.

`SYNC-PHIL-ASYM`: odd philosophers take right first, zero deadlocks over 20,000 ticks.
`SYNC-PHIL-ROOM`: `sem.room` capacity 4, zero deadlocks over 20,000 ticks.
`SYNC-PHIL-MONITOR`: the Ch. 7.1.3 monitor, zero deadlocks and at least one philosopher crosses
`starvationThreshold`. All four options must be offered at the ring and all four must behave
exactly as their fixture says.

---

## Stage

**Form.** A vertical column of slots, filling and draining.
**Accent.** `CYAN.core` when the buffer has room, `AMBER.core` at full or empty.
**Environment.** A flooded cylindrical chamber. The bounded buffer is a column of lit slots in
its centre; producers stand on a gantry above, consumers below.
**Hero visual.** The dining philosophers' ring: five stele in a circle, five resource rings
between them, and every stele holding the ring on its left while a beam reaches for the ring on
its right. The ring of amber beams closes and the whole structure stops. It is the same picture
as leg 6's deadlock, seen for the first time and without the name.

| Anchor id | Structure | Focus camera target |
|---|---|---|
| `anchor.chamber` | The flooded cylinder | wide establishing |
| `anchor.slot_column` | The bounded buffer as a column of lit slots, occupancy visible from any angle | head-on orthographic; slot count and fill legible |
| `anchor.intake_ports` | Three physical intake ports above, with the intake semaphore's value etched beside them | head-on; all three ports and the current value in frame |
| `anchor.gantry` | The producer gantry | head-on |
| `anchor.taps` | The consumer drain taps below | head-on |
| `anchor.cistern_console` | Producer count, consumer count, buffer capacity | head-on orthographic; all three dials legible |
| `anchor.archive_alcove` | The readers-writers structure: readers admitted in parallel, the writer waiting | head-on; the reader count and the writer's wait age both legible |
| `anchor.rwlock_selector` | reader / writer / fair | head-on |
| `anchor.mesa_toggle` | signal-and-continue against signal-and-wait, and the `if` against `while` predicate style | head-on orthographic; the two-line difference shown as two-line difference |
| `anchor.ring` | The five-tap ring: five stele, five handles between them | overhead orthographic; the closing beams must read as a closed circle |
| `anchor.ring_options` | Cap at four, reverse one order, take both atomically, use the monitor | head-on |
| `anchor.depot` | The leg 5 depot | head-on |
| `anchor.convoy.<member>` | Per-Program stele | head-on |

The ring's overhead framing is the hero shot and it is the same composition leg 6 uses for its
own hero visual. Build it so the two are recognisably the same picture; that recognition is the
Gridlock's entire opening.

---

## Interactions

```ts
export const interactions: readonly InteractionDef[] = [
  {
    id: 'cistern.set_producers',
    label: 'Set producer count',
    description: 'One to six. If occupancy trends in one direction, this dial or the consumer dial is the answer, not capacity.',
    anchor: 'anchor.cistern_console',
    cost: { bandwidth: 2 },
    enabledWhen: (run) => run.resources.bandwidth >= 2,
  },
  {
    id: 'cistern.set_consumers',
    label: 'Set consumer count',
    description: 'One to six.',
    anchor: 'anchor.cistern_console',
    cost: { bandwidth: 2 },
    enabledWhen: (run) => run.resources.bandwidth >= 2,
  },
  {
    id: 'cistern.set_capacity',
    label: 'Set buffer capacity',
    description: 'Four to thirty-two. Capacity absorbs variance around a rate that already matches.',
    anchor: 'anchor.cistern_console',
    cost: { cycles: 6 },
    enabledWhen: (run) => run.resources.cycles >= 6,
  },
  {
    id: 'cistern.set_intake',
    label: 'Set the intake primitive',
    description: 'A mutex, or a counting semaphore. There are three ports.',
    anchor: 'anchor.intake_ports',
    cost: { cycles: 4 },
    enabledWhen: (run) => run.resources.cycles >= 4,
  },
  {
    id: 'cistern.set_acquisition_order',
    label: 'Set acquisition order',
    description: 'Counting semaphore first, then mutex. Or the other way around.',
    anchor: 'anchor.cistern_console',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'cistern.set_rwlock_policy',
    label: 'Set the reader-writer policy',
    description: 'Reader preference, writer preference, or fair queueing. Each has a victim.',
    anchor: 'anchor.rwlock_selector',
    cost: { cycles: 6 },
    enabledWhen: (run) => run.resources.cycles >= 6,
  },
  {
    id: 'cistern.set_monitor_semantics',
    label: 'Set monitor semantics',
    description: 'Signal-and-continue or signal-and-wait.',
    anchor: 'anchor.mesa_toggle',
    cost: { cycles: 4 },
    enabledWhen: (run) => run.resources.cycles >= 4,
  },
  {
    id: 'cistern.set_predicate_style',
    label: 'Set the predicate check',
    description: 'Check once with if, or re-check in a loop with while.',
    anchor: 'anchor.mesa_toggle',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'cistern.break_ring',
    label: 'Break the ring',
    description: 'Cap seating at four, reverse one Program acquisition order, require both handles atomically, or route through the monitor.',
    anchor: 'anchor.ring_options',
    cost: { cycles: 10 },
    enabledWhen: (run) => run.resources.cycles >= 10,
  },
];
```

The Cistern owns two of the nine critical section crossings. Place them at the intake and at the
archive alcove, and route them through WP-19's shared crossing system with contention computed
from the live snapshot.

---

## Terminal commands

Three commands, copied verbatim from the curriculum map into `src/legs/the_cistern/commands.ts`:
`sem`, `buffer`, `rwlock`. The full `manual` text is in `docs/05-CURRICULUM-MAP.md`, "Leg 5. THE
CISTERN". Copy byte for byte.

Load-bearing lines:

- `sem`: "empty + full is always the capacity. Watch that invariant; if it drifts, a signal has
  been lost."
- `sem`: "A producer that takes mutex first and then waits on empty is holding the mutex while
  asleep. The consumer that would have made room needs the mutex to do it. Nobody moves again,
  and the code reads perfectly well."
- `sem --order`: "Compare two processes and look for a pair taken in opposite orders. That pair
  is a cycle waiting for the right timing." This is the forward reference to `wfg` in leg 6.
- `buffer`: "The buffer cannot fix a rate mismatch. It can only absorb variance around a rate
  that already matches."
- `rwlock`: "This starves writers, and it starves them silently, because every reader is being
  served promptly and the system looks healthy."

---

## Event table

Copied verbatim from `04-NARRATIVE-BIBLE.md` section 8, leg 5. Weights sum to 100.

```ts
export const cisternEvents: readonly RandomEventDef[] = [
  {
    id: 'cistern.producer_overrun',
    weight: 13,
    title: 'The Buffer Is Full',
    narration: 'The producer fills the bounded buffer and keeps producing into a slot that has not been emptied. What was in that slot is gone and nothing recorded that it existed.',
    targets: null, inflicts: null,
    resourceDelta: { quota: -85 },
    onlyIf: null,
  },
  {
    id: 'cistern.reader_flood',
    weight: 13,
    title: 'Readers Preferred',
    narration: 'Readers keep arriving and the lock keeps admitting them, because there is always at least one reader inside. The writer has been waiting since the convoy arrived and will not get in.',
    targets: null, inflicts: 'starvation',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'cistern.philosophers_fast',
    weight: 12,
    title: 'Five Seated, None Eating',
    narration: 'Five processes each hold one of the two things they need and wait for the other. They will hold that arrangement until something takes a resource away from one of them.',
    targets: null, inflicts: 'lock_convoy',
    resourceDelta: { cycles: -45 },
    onlyIf: null,
  },
  {
    id: 'cistern.spurious_wake',
    weight: 11,
    title: 'Woken Early',
    narration: 'A Program is signalled, wakes, and finds the condition it was waiting for is no longer true. It proceeds anyway, because it checked once with an if.',
    targets: null, inflicts: null,
    resourceDelta: { blocks: -16 },
    onlyIf: null,
  },
  {
    id: 'cistern.consumer_stall',
    weight: 12,
    title: 'Consumer Stalled',
    narration: 'The consumer blocks on an empty buffer while the producer blocks on a full one, because both counts were read before either was updated. The Cistern is silent for forty ticks.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -50, bandwidth: -5 },
    onlyIf: null,
  },
  {
    id: 'cistern.monitor_granted',
    weight: 16,
    title: 'Monitor Access',
    narration: 'A maintained monitor at the north wall handles entry, exit and every condition variable correctly, and it is added. The convoy uses it and pays nothing.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 55, bandwidth: 8 },
    onlyIf: null,
  },
  {
    id: 'cistern.semaphore_surplus',
    weight: 12,
    title: 'Counting Semaphore',
    narration: 'A counting semaphore with a capacity of nine has three permits nobody claimed. ORRERY logs the count before and after, out of habit.',
    targets: 'codec', inflicts: null,
    resourceDelta: { bandwidth: 10, quota: 30 },
    onlyIf: null,
  },
  {
    id: 'cistern.clean_drain',
    weight: 11,
    title: 'Clean Drain',
    narration: 'Producer and consumer rates match for two hundred ticks and the buffer never touches either bound. It is the only stretch of the journey where a system is simply working.',
    targets: null, inflicts: null,
    resourceDelta: { quota: 70, cycles: 30 },
    onlyIf: null,
  },
];
```

---

## Evaluation

### Survival

The leg is survived when at least one convoy Program is alive at leg end.

**Producer-consumer collapse.** Overflow spills payload, costing `blocks` directly. Underflow
gives consumers `livelock` because they keep waking, finding nothing, and sleeping again.
Sustained underflow costs quota, and a Program starved of quota derezzes with
`TerminationReason: 'out_of_memory'`.

**The ordering error**, and it is the one worth building for. A producer that takes the mutex
first and then waits on `empty` holds the mutex while blocked, so no consumer can take the mutex
to make room, so `empty` never rises. `deadlock.detected` fires with a two-node cycle and both
Programs derezz with `TerminationReason: 'deadlock_victim'` unless the player intervenes.

**Writer starvation** under reader preference produces the `starvation` affliction on ORRERY.
The remedy is a policy change rather than a `nice`, which is what distinguishes it from the
Quantum Pass version.

**The ring** produces the canonical five-way circular wait. Under `deadlockStrategy: 'ignore'`
the Programs simply stop and the convoy stops with them. No event, no error, no damage. The
travel meter drains and each acquires `lock_convoy`. Record the tick the ring closed and put it
in the leg outcome for the Gridlock.

### Objectives

| Objective | Computed from |
|---|---|
| `obj.the_cistern.stable_buffer` | Sample occupancy every tick for the segment; require the full 400-tick window inside [0.10, 0.90] of capacity, with zero spill and zero underflow events. |
| `obj.the_cistern.semaphore_ordering` | Read the acquisition order from the `sync.acquired` sequence per producer and per consumer; require the counting semaphore before the mutex in both roles. Zero `deadlock.detected` on the intake path. |
| `obj.the_cistern.reader_writer_policy` | The writer's max queue wait, from `sync.blocked` to `sync.acquired`, is at most 30 ticks; reader completion count is above 60 percent of the recorded reader-preference baseline. |
| `obj.the_cistern.clear_writer_starvation` | An active `starvation` affliction on ORRERY was cleared by an rwlock policy change to `writer` or `fair` before the fatal threshold. A `nice` does not satisfy this. |
| `obj.the_cistern.break_the_ring` | Zero `deadlock.detected` events across the ring segment **and** `detectDeadlock()` returns null at every tick of the segment. Both, because the strategy is `ignore` and the event alone proves nothing. |
| `obj.the_cistern.signal_after_predicate` | The closing snapshot has no `blockedOn` of kind `condition` whose predicate evaluates true. |

`break_the_ring`'s second clause is the important one. Under `ignore` no event fires whether or
not there is a cycle, so an objective that reads only the event count would pass a player who
deadlocked. Poll `detectDeadlock()` in the leg's own evaluation loop.

### Debrief card

```ts
{
  headline: /* 'The Cistern held.' or 'Five seated, none eating.' */,
  whatHappened:
    `Occupancy stayed inside [${lo}, ${hi}] percent for ${window} ticks with ${producers} ` +
    `producers against ${consumers} consumers at capacity ${cap}. The writer waited ` +
    `${writerWait} ticks under ${rwPolicy}. The ring ${ringOutcome}.`,
  whyItHappened: /* selected */,
  counterfactual: /* computed */,
  chapter: { chapter: 7, title: 'Synchronization Examples', sections: ['7.1.1'] },
}
```

Counterfactual, in priority order:

1. **The ring closed and was not broken.** `"Five Programs each held the handle on their left and
   waited for the one on their right, from tick ${ringTick}. Capping seating at four leaves one
   handle free and the ring cannot close."` Name the mechanism, not the button.
2. **The intake ordering error deadlocked.** `"The producer held the mutex while waiting on
   empty. Taking the counting semaphore first releases the mutex to whoever would have made
   room."`
3. **Writer starved.** `"ORRERY waited ${writerWait} ticks under reader preference while readers
   completed ${readerCount} operations. Fair queueing serves arrivals in order and costs
   ${throughputDelta} percent of read throughput."`
4. **Buffer pinned.** `"Occupancy sat at ${wall} for ${ticks} ticks. A buffer pinned at ${wall}
   means the ${side} are blocked and the rate mismatch is ${producers} against ${consumers}."`
5. `null`.

### The forward hand-off

`LegOutcome` must carry the ring-close tick to the Gridlock. Agree the field with WP-17; the
natural home is a `DecisionRecord` with `kind: 'ring_closed'` and `choice: String(tick)`, which
needs no contract change and is readable by leg 6 from `RunState.decisions`. Use that unless
WP-17 offers something better.

---

## Acceptance criteria

1. `src/legs/the_cistern/index.ts` satisfies `Leg` under `tsc --strict`, `id === 'the_cistern'`,
   `index === 5`.
2. The leg runs headlessly to completion via the WP-20 smoke-test harness.
3. `enabledSubsystems` deep-equals `['process', 'scheduler', 'sync', 'deadlock']` and
   `deadlockStrategy === 'ignore'`.
4. Inert-field independence over 400 ticks.
5. Every objective can be met by the known-good decision sequence; all six met in one run.
6. The known-bad sequence produces the intended failure: the ring closes silently, no
   `deadlock.detected` fires, `detectDeadlock()` returns a five-pid cycle, five Programs acquire
   `lock_convoy`, and the ring-close tick is recorded in the leg outcome.
7. The invariant `empty + full === capacity` holds at every tick of every run. Asserted in the
   dev build as a per-tick check.
8. `SYNC-BB-1`, `SYNC-BB-DEADLOCK`, `SYNC-RW-STARVE`, `SYNC-RW-WRITERPREF`, `SYNC-PHIL-NAIVE`,
   `SYNC-PHIL-ASYM`, `SYNC-PHIL-ROOM` and `SYNC-PHIL-MONITOR` all pass against the primitives
   this leg exposes.
9. Intake throughput under a mutex is exactly one third of throughput under a semaphore of count
   3, on the same workload, and two of the three ports are visibly idle under the mutex.
10. All four combinations of monitor semantics and predicate style are reachable. `if` under
    Mesa draws air and costs integrity; `while` under Mesa does not; `if` under Hoare does not.
11. The intake ordering error produces `deadlock.detected` with a cycle of exactly 2 pids, while
    the ring produces no event.
12. Reader preference starves ORRERY with exactly one `process.starving { fatal: true }`. Writer
    preference and fair queueing both satisfy `obj.the_cistern.reader_writer_policy`; reader
    preference does not.
13. All four ring-breaking options work and each produces zero cycles over 20,000 ticks, except
    the monitor option which produces zero deadlocks and at least one philosopher crossing
    `starvationThreshold`.
14. Event table weights sum to exactly 100; all ids unique.
15. All three terminal command `manual` strings match the curriculum map byte for byte.
16. Draw calls stay under 220 / 450 / 900 at the heaviest frame, which is the ring closed with
    five beams at `denied` amber plus the slot column and both gantries in view.
17. The ring hero visual is compositionally the same picture as leg 6's, framed from
    `anchor.ring` overhead. Verified by a reference screenshot comparison against leg 6's, or by
    a documented shared world structure if leg 6 has not shipped.

---

## Tests you must write

All under `tests/legs/the_cistern/`.

**`contract.test.ts`**: `Leg` conformance, exact ids, chapters (two entries), six objectives.

**`config.test.ts`**: `enabledSubsystems` exact; `deadlockStrategy === 'ignore'`;
`agingInterval === 0`; inert-field independence.

**`populate.test.ts`**: five convoy spawns plus twenty-three workload spawns, five binds,
fourteen `declareSync` calls with exact ids, kinds and capacities.

**`buffer.test.ts`**: the bounded buffer.
- `SYNC-BB-1` exactly: produced equals consumed equals 60, occupancy in [0, 4], zero races.
- `empty + full === capacity` at every tick, over 2000 ticks, at every producer and consumer
  count from 1 to 6 and every capacity from 4 to 32.
- Overflow spills and costs blocks; underflow inflicts `livelock` on consumers.
- Occupancy trending monotonically is not fixed by raising capacity. Asserted by running a rate
  mismatch at capacity 4 and at capacity 32 and showing both fill.

**`ordering.test.ts`**: `SYNC-BB-DEADLOCK`: mutex-before-semaphore produces
`deadlock.detected` with a cycle of exactly 2 pids. Semaphore-before-mutex produces zero.
`sem --order` reports both orders correctly.

**`intake.test.ts`**: mutex against semaphore of count 3: throughput ratio exactly 3, two ports
idle under the mutex, `sem --list` value sequence 3, 2, 1, 0.

**`rwlock.test.ts`**: `SYNC-RW-STARVE` and `SYNC-RW-WRITERPREF` exactly. The reader-preference
baseline is recorded and frozen. All three policies against
`obj.the_cistern.reader_writer_policy`: reader fails, writer passes, fair passes.

**`monitor.test.ts`**: the four combinations of semantics and predicate style. Mesa plus `if`
draws air; Mesa plus `while` does not; Hoare plus `if` does not; Hoare plus `while` does not.
Assert the integrity damage in the failing case.

**`ring.test.ts`**: the five-tap ring.
- Naive left-then-right closes a five-pid cycle by tick 200, `detectDeadlock()` finds it, and
  under `ignore` no `deadlock.detected` event fires.
- The cycle's `conditions` contains all four Coffman values.
- All four breaking options: `SYNC-PHIL-ASYM`, `SYNC-PHIL-ROOM`, atomic-both-handles, and
  `SYNC-PHIL-MONITOR`, each over 20,000 ticks.
- The ring-close tick is recorded in the leg outcome.

**`evaluate.test.ts`**: each of the six objectives, met and not met. In particular
`break_the_ring` fails when a cycle exists even though no event fired.

**`golden.test.ts`**: the golden headless playthrough.
- Fixture: `seed: 0x4b54524c`, `discClass: 'shell'`, `difficulty: 'operator'`, steady pace,
  standard rations, entering with the leg 4 golden closing ledger.
- Known-good sequence: set intake to a semaphore of count 3; set producers 3, consumers 3,
  capacity 16; set acquisition order semaphore-then-mutex; on the writer's starvation warning,
  set the rwlock policy to fair; set predicate style to `while`; cap ring seating at four.
- Assert: all six objectives met, zero cycles at any tick, occupancy inside [10, 90] percent for
  400 consecutive ticks, zero casualties, six codex entries added, canonical event log hash
  matches the golden file, stable across two runs and a snapshot-restore.

**`badpath.test.ts`**: the known-bad sequence.
- Mutex intake, mutex-before-semaphore ordering, reader preference, `if` predicate style,
  naive ring.
- Assert: intake throughput one third, a two-pid `deadlock.detected` on the intake path, ORRERY
  starving fatally, spurious wakeups drawing air, the ring closing silently with a five-pid
  cycle, counterfactual case 1, and the ring-close tick recorded.

**`manuals.test.ts`**: three manual strings against the curriculum map fixture; every
`See also:` resolves, including the forward reference to `wfg`.

**`stage.test.ts`**: anchors resolve; interaction anchors resolve; draw calls under budget; the
ring overhead framing matches the documented shared composition.

---

## Out of scope

- Do not touch any other leg. Do not import from `src/legs/*` other than your own directory.
- Do not modify the frozen type files or anything under `src/kernel`, `src/render`,
  `src/world`, `src/terminal`, `src/ui`, `src/audio`, `src/design`, `src/platform`, `src/app`.
- Do not name deadlock. The word does not appear in any copy, man page, codex entry title or
  world label in this leg, except inside `deadlock.detected`'s own event type, which the player
  does not see under `ignore`. The Gridlock names it.
- Do not introduce `wfg`, `bankers` or `resources`. Those are leg 6's commands.
- Do not set `deadlockStrategy` to anything but `ignore` for the ring.
- Do not fix writer starvation with aging. `agingInterval` stays 0.
- Do not reimplement the crossing cost formulas; use WP-19's shared system.
- Do not make the ring's stop produce an error, a warning, or any signal at all. Silence is the
  teaching.

### Files this package owns exclusively

```
src/legs/the_cistern/index.ts
src/legs/the_cistern/chapters.ts
src/legs/the_cistern/objectives.ts
src/legs/the_cistern/config.ts
src/legs/the_cistern/populate.ts
src/legs/the_cistern/interactions.ts
src/legs/the_cistern/commands.ts
src/legs/the_cistern/events.ts
src/legs/the_cistern/evaluate.ts
src/legs/the_cistern/buffer.ts
src/legs/the_cistern/ring.ts
src/legs/the_cistern/stage.ts
src/legs/the_cistern/copy.ts
tests/legs/the_cistern/**
```

---

## Report back

1. Commit or branch, and the full `tests/legs/the_cistern/` output.
2. Golden playthrough hash and its checked-in path.
3. The frozen fixtures: the reader-preference baseline for reader throughput, the writer's wait
   under each of the three policies, and the tick at which the naive ring closes at each pace.
4. How you scoped `deadlockStrategy` so the intake fires an event and the ring does not, and the
   item filed against WP-08 if scoping was not available.
5. The field carrying the ring-close tick to leg 6, agreed with WP-17.
6. Results for all eight `SYNC-*` fixtures this leg exercises.
7. Draw calls at each tier, and confirmation that the ring framing matches leg 6's composition.
8. Any document disagreement, what you did, and which document you followed.
9. Confirmation that no file outside the owned list was created or modified, and that the word
   "deadlock" appears in no player-visible string in this leg.

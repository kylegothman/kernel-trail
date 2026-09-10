# WP-L04: The Narrows

Leg id `the_narrows`, index 4. Subtitle: *Two feet, one plank.*

**Legs are independent and may be built concurrently.** This package touches no other leg,
imports from no other leg, and shares no source file with any other leg.

---

## Objective

A module at `src/legs/the_narrows/` implementing the frozen `Leg` interface, playable end to
end. The crossing is a single plank over a gap with a ledger post at each end recording who has
crossed. Two Programs step on together because nothing stops them, both read the ledger, both
write it, and the number on the post is now one less than the number of Programs standing on the
far side. The convoy's own manifest is that number.

This is the first correctness failure as distinct from a performance failure, and it is the leg
that explains the Weave's broken tally.

The Narrows owns three of the game's nine critical section crossings. The Cistern owns two, the
Gridlock two, the Archive one and the Arbiter Wall one. The four options and their cost formulas
are shared and live in WP-19; this leg is their first consumer.

---

## Prerequisites

**Engine work packages:** WP-01 Determinism core, WP-02 Process and PCB layer, WP-03
Scheduler registry, **WP-07 Synchronisation complete**, WP-11 Syscall interface, WP-17 Run
state, ledger and afflictions, **WP-19 Leg runner including the critical section crossing
system** (contention formula and the four options), WP-15 Terminal shell, WP-17 HUD and codex,
WP-12 Renderer core, WP-13 Focus camera, WP-13 World structures (the span, the turnstile,
ghost-image overlays for the race), WP-14 Derezz and tombstones, WP-20 Smoke-test runner.

**Kernel subsystems:** `process`, `scheduler`, `sync`. WP-07 must provide: mutex, counting
semaphore, monitor with condition variables, rwlock; ordered and unordered wait queues; the race
detector emitting `sync.race_detected` with a full `RaceCondition` including the instruction
interleaving; `sync.busy_wait` with `spunTicks`; priority inheritance as a per-primitive flag;
test-and-set and compare-and-swap as distinct primitives; Peterson's algorithm with a
configurable memory-reordering model. Fixtures `SYNC-PETERSON-1` through `SYNC-TAS-1` must pass
before this leg starts.

Deterministic interleaving replay must work: `trace --replay <n>` re-runs a recorded race's
exact sequence of scheduling decisions against whatever protocol is currently installed.

---

## Required reading

- `docs/05-CURRICULUM-MAP.md`, "Leg 4. THE NARROWS" in full.
- `docs/02-KERNEL-SIM-SPEC.md`, section 8 (Synchronisation, Ch. 6 and 7), sections 6.1 through
  6.9 material; section 16.7 (the `SYNC-*` test vectors).
- `docs/04-NARRATIVE-BIBLE.md`, **section 12 in full** (critical section crossings: the
  contention formula and the four options with their exact cost equations and failure modes);
  section 7 entries for `priority_inversion` and `livelock`; section 8 leg 4 event table;
  section 9 epitaphs for `storage_corruption`.
- `docs/03-VISUAL-BIBLE.md`, section 10 "Leg 4, The Narrows"; section 13 (quality tiers).

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
  { chapter: 6, title: 'Synchronization Tools',
    sections: ['6.1', '6.2', '6.3', '6.4.1', '6.4.2', '6.4.3',
               '6.5', '6.6.1', '6.6.2', '6.7.1', '6.7.2', '6.8', '6.9'] },
];
```

### Learning objectives

```ts
export const objectives: readonly LearningObjective[] = [
  {
    id: 'obj.the_narrows.three_requirements',
    statement: 'Selects a ford protocol that holds mutual exclusion, progress and bounded waiting together, ending the leg with zero sync.race_detected events and no Program waiting more than three turns for the plank.',
    chapter: { chapter: 6, title: 'Synchronization Tools', sections: ['6.2'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.the_narrows.spin_versus_block',
    statement: 'Spins only where the expected hold time is under the 4-tick context switch cost and blocks otherwise, keeping total sync.busy_wait spun ticks under 25 for the leg.',
    chapter: { chapter: 6, title: 'Synchronization Tools', sections: ['6.5', '6.9'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.the_narrows.minimal_critical_section',
    statement: 'Marks a guarded region with lock --mark that covers every write to the shared ledger and is under 6 ticks long, so no unguarded write remains and no Program is excluded longer than necessary.',
    chapter: { chapter: 6, title: 'Synchronization Tools', sections: ['6.2', '6.5'] },
    assessedBy: 'terminal_command',
  },
  {
    id: 'obj.the_narrows.atomic_primitive',
    statement: 'Replaces the test-then-set crossing with compare_and_swap and reruns the identical recorded interleaving with trace --replay, observing the race count fall to zero.',
    chapter: { chapter: 6, title: 'Synchronization Tools', sections: ['6.4.2', '6.4.3'] },
    assessedBy: 'terminal_command',
  },
  {
    id: 'obj.the_narrows.semaphore_capacity',
    statement: 'Sets the ford semaphore count to the number of Programs the ford physically holds, so no Program blocks while capacity is free and none is admitted past capacity.',
    chapter: { chapter: 6, title: 'Synchronization Tools', sections: ['6.6.1'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.the_narrows.priority_inversion',
    statement: 'Clears a priority_inversion affliction before the high-priority Program deadline, by enabling priority inheritance on the contended mutex or by spending SABLE shield on it.',
    chapter: { chapter: 6, title: 'Synchronization Tools', sections: ['6.8'] },
    assessedBy: 'survival',
  },
];
```

### Codex entries this leg adds to `codexUnlocked`

`codex.race_condition`, `codex.critical_section`, `codex.petersons`, `codex.atomic_hardware`,
`codex.mutex_semaphore`, `codex.spin_vs_block`, `codex.monitor`, `codex.priority_inversion`.

| Entry | Added when |
|---|---|
| `codex.race_condition` | First `sync.race_detected` event. |
| `codex.critical_section` | First `lock --mark`. |
| `codex.petersons` | The Peterson marker event fires, or the player inspects the two-process stone. |
| `codex.atomic_hardware` | First `compare_and_swap` or test-and-set crossing. |
| `codex.mutex_semaphore` | First `declareSync` of kind `semaphore` with capacity above 1. |
| `codex.spin_vs_block` | First `sync.busy_wait` event. |
| `codex.monitor` | First monitor crossing taken. |
| `codex.priority_inversion` | First `priority_inversion` affliction acquired. |

### Misconceptions this leg must break

**"count++ is a single operation, so it cannot be interrupted halfway."** The single most common
wrong belief in an OS course, and it survives being told otherwise. The break is `race --show 1`,
which does not argue: it prints the load, the add and the store for both Programs on a shared
timeline with the preemption marked between the load and the store. The player has already seen
the wrong number on the ledger post in the world, so the trace explains something they have
witnessed rather than claiming something hypothetical.

Build requirement: `RaceCondition.interleaving` must carry the four-line load/load/store/store
pattern as real strings from the kernel, per fixture `SYNC-RACE-1`. The world draws those strings
as world-space labels along the span in execution order, per the visual bible.

**"A mutex protects a variable."** Students draw a line from lock to data and believe the system
enforces it. The break is a scripted crossing: the second ford guards the same manifest with a
second, differently named mutex, and both crossings are individually correct. The race still
happens, `lock --list` shows two primitives both with zero contention, and the manifest is still
wrong.

Build requirement: two mutexes, `lock.ford_a` and `lock.ford_b`, both correct in isolation, both
guarding writes to the same ledger address. This must be a genuine configuration the kernel
permits, not a scripted event. The lesson is in the `lock` man page: the association between a
lock and its data lives in convention.

**"On a fast machine the critical section is short enough that a race will not realistically
happen, and disabling interrupts would fix it anyway."** Two halves. First, the leg replays the
identical interleaving on demand, so "unlikely" stops being a defence. Second, the
interrupt-disable option is available at the third crossing and it works, on one core, and the
third crossing is four cores. The other three cores never received an interrupt to disable and
step onto the plank exactly as before. `race --list` fills up while the player's chosen
protection is still enabled.

Build requirement: core count is a per-crossing property. Crossings one and two are single-core;
crossing three is four-core. The interrupt-disable option must be offered at crossing three and
must genuinely work on one core.

---

## Kernel configuration

```ts
export function kernelConfig(run: RunState): KernelConfig {
  return {
    seed: run.seed,
    scheduler: 'rr',                       // preemption is what makes the interleaving happen at all
    schedulerParams: {
      quantum: quantumForPace(run.policy.pace),
      agingInterval: 0,                    // aging is available but off; priority inversion needs strict priority
      starvationThreshold: 120,            // an unordered wait queue can starve a crosser; this is where it warns
      starvationFatalThreshold: 300,
      preemptive: true,                    // required: without preemption there is no race
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
    journalingEnabled: false,              // inert: the corrupted manifest must be unrecoverable here
    deadlockStrategy: 'ignore',            // inert: 'deadlock' is not enabled. The Cistern deadlocks; the Gridlock names it.
    thrashingThreshold: 200,               // inert
    enabledSubsystems: ['process', 'scheduler', 'sync'],
  };
}
```

`enabledSubsystems` is `['process', 'scheduler', 'sync']`. `sync` is what this leg teaches.
`deadlock` is not enabled: a deadlock in the Narrows would preempt the Cistern's ordering error
and the Gridlock's naming. If a two-node cycle forms here, the Programs simply block and the
travel meter drains, with no `deadlock.detected` event.

`journalingEnabled: false` is load-bearing rather than inert-adjacent. The corrupted manifest
from a race here becomes an `fs.corruption` in leg 11 with `recoverable: false`. ORRERY can
restore it only if ORRERY is alive **and the journal exists**, and the journal does not exist
yet. Leg 11 decides that; this leg only has to leave the corruption in place.

---

## Population

```ts
export function populate(ctx: LegSetupContext): void {
  const roster: readonly [ConvoyMemberId, string, number, number, number][] = [
    ['lumen',   'LUMEN',   2, 6, 54],
    ['sable',   'SABLE',   1, 5, 48],   // high priority: the priority inversion victim
    ['orrery',  'ORRERY',  3, 5, 48],
    ['kestrel', 'KESTREL', 3, 4, 42],
    ['vesper',  'VESPER',  3, 5, 48],
  ];
  roster.forEach(([member, name, priority, burst, service], i) => {
    const pid = ctx.spawn({ name, priority, burst, service, arrival: i, pages: 6 });
    ctx.bind(member, pid);
  });

  // The low-priority lock holder. This is the priority inversion's bottom.
  ctx.spawn({ name: 'narrows.sweep',   priority: 9, burst: 4, service: 80, arrival: 4,  pages: 3 });
  // The medium-priority preemptor. This is what makes the inversion an inversion.
  ctx.spawn({ name: 'narrows.hauler',  priority: 5, burst: 8, service: 90, arrival: 8,  pages: 4 });
  // Two contenders for the ford, so the semaphore capacity question has an answer.
  ctx.spawn({ name: 'narrows.pilgrim_a', priority: 4, burst: 3, service: 40, arrival: 12, pages: 3 });
  ctx.spawn({ name: 'narrows.pilgrim_b', priority: 4, burst: 3, service: 40, arrival: 14, pages: 3 });

  // The primitives.
  ctx.declareSync('lock.ford_a',   'mutex',     1);   // guards the ledger, correctly, in isolation
  ctx.declareSync('lock.ford_b',   'mutex',     1);   // guards the SAME ledger with a DIFFERENT name
  ctx.declareSync('sem.ford',      'semaphore', 1);   // player sets capacity; the ford physically holds 3
  ctx.declareSync('mon.ford',      'monitor',   1);   // the paid crossing
  ctx.declareSync('lock.manifest', 'mutex',     1);   // the contended lock for priority inheritance
}
```

`sem.ford` is declared with capacity 1 and the player raises it. The ford physically holds
**three** Programs, which is visible in the world: the span is three body-widths wide at the
ford section and one at the plank section. `obj.the_narrows.semaphore_capacity` is met when the
capacity equals 3. Capacity 1 blocks Programs while capacity is free; capacity 4 or above admits
a fourth and the fourth falls.

### The three crossings

The four options and their cost formulas come from narrative bible section 12 and are shared
code in WP-19. Do not reimplement them. Contention `C` is computed from the live
`KernelSnapshot` by the shared formula:

```
C = clamp01(0.50 * queuePressure + 0.30 * holdPressure + 0.20 * systemPressure)
```

| Crossing | Cores | Primitive under test | Designed contention at arrival | What it teaches |
|---|---|---|---|---|
| `crossing.plank` | 1 | none, initially | ~0.20 | The unguarded race. Two step on together. |
| `crossing.second_ford` | 1 | `lock.ford_a` and `lock.ford_b` | ~0.45 | A mutex protects nothing by itself. |
| `crossing.wide_ford` | 4 | `sem.ford`, `mon.ford`, interrupt-disable option | ~0.70 | Interrupt-disable works on one core of four. |

At `C = 0.20` spin-wait costs 30 cycles and 10 ticks with a 96.6 percent success rate, which is
the cheapest crossing in the game. At `C = 0.70` spin-wait's success rate is `1 - 0.85 * 0.49 =
0.5835` and its failure inflicts `lock_convoy` on the crosser and everything behind it. Those
numbers come from the shared formulas; assert them rather than restating them.

`obj.the_narrows.spin_versus_block` requires total `spunTicks` under 25 across the leg.
Spinning once at `crossing.plank` costs about 10 ticks of spinning. Spinning at
`crossing.wide_ford` costs about 25 on its own. So the objective admits spinning at the cheap
crossing and forbids spinning at the expensive one, which is exactly the textbook condition:
spin when the expected wait is shorter than a context switch.

---

## Stage

**Form.** A single-file span with a turnstile at its mouth.
**Accent.** `SLATE.primary` for the lock, `AMBER.core` for a violation.
**Environment.** A canyon of black glass with one lit span across it, one entity wide. The walls
are close enough that the convoy is visibly funnelled.
**Hero visual.** A race condition drawn as two ghost images of the same crossing, overlapping
and both partly transparent, resolving into a single wrong value at the far side. The
`RaceCondition.interleaving` strings are drawn as world-space labels along the span in the order
they executed, so the player can read the interleaving that produced the corruption.

| Anchor id | Structure | Focus camera target |
|---|---|---|
| `anchor.canyon` | The whole crossing | wide establishing |
| `anchor.plank` | The single-entity span | head-on down the span; the ghost images resolve here |
| `anchor.ledger_post.near`, `.far` | The two posts recording who has crossed, each showing its current value | head-on orthographic, value legible |
| `anchor.turnstile` | The protocol selector at the span's mouth: spin, block, monitor, wait | head-on, four options with their live costs at current C |
| `anchor.contention_readout` | `C = 0.64`, as a number, nothing else | included in the turnstile framing |
| `anchor.second_ford` | The two-mutex crossing, both locks drawn as separate physical objects over the same ledger | head-on; both locks and the single ledger in one frame |
| `anchor.wide_ford` | The four-core ford, three body-widths wide, with the semaphore capacity dial | head-on; all four cores' lanes visible |
| `anchor.interrupt_switch` | The interrupt-disable option at the wide ford, wired to one core only, visibly | head-on; the wiring to one core of four must be readable |
| `anchor.peterson_stone` | The two-process solution carved in full, with the turn variable named | head-on orthographic, full text legible |
| `anchor.inheritance_toggle` | Priority inheritance on `lock.manifest` | head-on |
| `anchor.convoy.<member>` | Per-Program stele | head-on |

The contention readout is a number and never a colour band. `C = 0.64` is the whole HUD element,
per narrative bible 12.1.

The `anchor.interrupt_switch` wiring is load-bearing for the third misconception. The player must
be able to see that the switch reaches one core and not the other three, before they use it.

---

## Interactions

```ts
export const interactions: readonly InteractionDef[] = [
  {
    id: 'narrows.cross_spin',
    label: 'Spin and cross',
    description: 'Hold the processor and test the lock in a loop until it clears. Costs cycles proportional to the hold, and no context switch.',
    anchor: 'anchor.turnstile',
    cost: { cycles: 0 },   // computed at commit from C by the shared crossing system
    enabledWhen: () => true,
  },
  {
    id: 'narrows.cross_block',
    label: 'Block and cross',
    description: 'Sleep on the lock and be woken when it is released. Costs one context switch each way, and quota while asleep.',
    anchor: 'anchor.turnstile',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'narrows.cross_monitor',
    label: 'Pay the monitor toll',
    description: 'Enter through a maintained monitor that handles mutual exclusion and condition variables correctly, and charges for it.',
    anchor: 'anchor.turnstile',
    cost: { bandwidth: 6 },
    enabledWhen: (run) => run.resources.bandwidth >= 6,
  },
  {
    id: 'narrows.cross_wait',
    label: 'Wait for the ford to clear',
    description: 'Costs travel ticks and risks an event draw.',
    anchor: 'anchor.turnstile',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'narrows.set_capacity',
    label: 'Set the ford semaphore count',
    description: 'How many Programs the semaphore admits at once. Look at how wide the ford actually is.',
    anchor: 'anchor.wide_ford',
    cost: { cycles: 4 },
    enabledWhen: (run) => run.resources.cycles >= 4,
  },
  {
    id: 'narrows.toggle_inheritance',
    label: 'Priority inheritance',
    description: 'While a low-priority holder blocks a high-priority waiter, the holder runs at the waiter priority.',
    anchor: 'anchor.inheritance_toggle',
    cost: { cycles: 6 },
    enabledWhen: (run) => run.resources.cycles >= 6,
  },
  {
    id: 'narrows.disable_interrupts',
    label: 'Disable interrupts',
    description: 'Stop this core being preempted for the duration of the section.',
    anchor: 'anchor.interrupt_switch',
    cost: { cycles: 8 },
    enabledWhen: (run) => run.resources.cycles >= 8,
  },
  {
    id: 'narrows.use_cas',
    label: 'Use compare-and-swap',
    description: 'Replace the test-then-set with a single atomic instruction.',
    anchor: 'anchor.plank',
    cost: { bandwidth: 4 },
    enabledWhen: (run) => run.resources.bandwidth >= 4,
  },
  {
    id: 'narrows.read_stone',
    label: 'Read the two-process stone',
    description: 'A software-only solution for exactly two processes, in full.',
    anchor: 'anchor.peterson_stone',
    cost: {},
    enabledWhen: () => true,
  },
];
```

`lock --mark` is terminal-only. Marking a critical section is a claim the player makes about
their own code, and it should feel like typing rather than clicking.

---

## Terminal commands

Three commands, copied verbatim from the curriculum map into `src/legs/the_narrows/commands.ts`:
`lock`, `race`, `trace`. The full `manual` text is in `docs/05-CURRICULUM-MAP.md`, "Leg 4. THE
NARROWS". Copy byte for byte.

Load-bearing lines:

- `lock`: "Nothing in the hardware associates a lock with the data it protects. The association
  exists only in the discipline of the code, which is why two crossings guarding the same ledger
  with two different mutexes will still corrupt it, and why both crossings will look correct in
  isolation." This is the second misconception's answer and it must be readable before the
  player reaches the second ford.
- `lock`: the three-requirement block. "A protocol missing any one of them fails, and it usually
  fails on the third, quietly, under load."
- `race`: "Between any two of those operations the scheduler may preempt you, because the
  scheduler has no idea that those three operations were meant to be one thing."
- `trace`: "On a real machine you fix a race, the race stops appearing, and you have no way to
  know whether you fixed it or got lucky. Here you can fix it and prove it, against the exact
  interleaving that broke it."

### `trace --replay` implementation contract

Same shape as leg 3's `gantt --replay`, and it must share the shadow-kernel machinery.

1. On `sync.race_detected`, record the snapshot at the race's start tick and the exact sequence
   of scheduling decisions through the race window.
2. `trace --replay <n>` constructs a shadow kernel from that snapshot, forces the recorded
   scheduling decision sequence, and runs it against whatever protocol is currently installed.
3. Replaying with the protocol unchanged must reproduce the race exactly, including
   `corruptedValue` and `expectedValue`.
4. Replaying after installing `compare_and_swap` must produce zero races on the identical
   decision sequence. That is `obj.the_narrows.atomic_primitive`.
5. The shadow kernel must not emit into the live event stream and must not touch `RunState`.

If leg 3 shipped first, reuse its shadow-kernel helper from WP-18. If this leg ships first,
build the helper in WP-18 and tell leg 3 where it is. Do not build two.

---

## Event table

Copied verbatim from `04-NARRATIVE-BIBLE.md` section 8, leg 4. Weights sum to 100.

```ts
export const narrowsEvents: readonly RandomEventDef[] = [
  {
    id: 'narrows.race',
    weight: 14,
    title: 'Interleaved',
    narration: 'Two Programs read the same counter, both increment it, and both write it back. The counter advanced once and the record of what happened is now wrong.',
    targets: null, inflicts: null,
    resourceDelta: { blocks: -14, quota: -30 },
    onlyIf: null,
  },
  {
    id: 'narrows.spin_field',
    weight: 13,
    title: 'Mutual Courtesy',
    narration: 'Two Programs reach the gap together, both defer, both retry on the same tick, and do it again. They are running at full rate and neither has moved.',
    targets: null, inflicts: 'livelock',
    resourceDelta: { cycles: -35 },
    onlyIf: null,
  },
  {
    id: 'narrows.test_and_set_burn',
    weight: 13,
    title: 'Spinning',
    narration: 'The convoy holds the gate with a test-and-set loop while the holder is off the processor entirely. Every spin is a cycle spent proving the lock is still taken.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -60 },
    onlyIf: null,
  },
  {
    id: 'narrows.bounded_wait_violation',
    weight: 11,
    title: 'Unordered Queue',
    narration: 'The gate\'s wait queue has no ordering, so arrivals are woken in whatever sequence the Substrate finds convenient. One Program has been at the gate since before the convoy arrived.',
    targets: null, inflicts: 'starvation',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'narrows.peterson_marker',
    weight: 15,
    title: 'Two-Process Marker',
    narration: 'A stone at the gap carries a solution for exactly two processes, in full, with the turn variable named. It is correct, it is ancient, and it does not extend to five.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 45 },
    onlyIf: null,
  },
  {
    id: 'narrows.atomic_cache',
    weight: 17,
    title: 'Atomic Instruction Cache',
    narration: 'A cache of compare-and-swap primitives is intact and unclaimed at the second gate. The convoy takes them and stops paying for spin loops.',
    targets: null, inflicts: null,
    resourceDelta: { bandwidth: 12, cycles: 30 },
    onlyIf: null,
  },
  {
    id: 'narrows.mutex_recovered',
    weight: 17,
    title: 'Recovered Mutex',
    narration: 'A mutex left behind by a convoy that did not finish is still valid and still unheld. SABLE takes it and says nothing about the convoy.',
    targets: 'sentinel', inflicts: null,
    resourceDelta: { blocks: 18, cycles: 25 },
    onlyIf: null,
  },
];
```

---

## Evaluation

### Survival

The leg is survived when at least one convoy Program is alive at leg end. Three distinct
failures, deliberately separated.

**The race corrupts the convoy manifest.** The corrupted value propagates. The manifest is what
the Archive later uses to find the convoy's own map file, so a race here that is never noticed
becomes an `fs.corruption` event in leg 11 with `recoverable: false`. A Program that acts on the
corrupted manifest derezzes with `TerminationReason: 'storage_corruption'`. ORRERY can restore
it if ORRERY is alive and the journal exists, which is the first time the convoy composition
changes what survivable means.

Implementation: the corrupted manifest value is written into `RunState` through the leg outcome
so leg 11 can read it. Coordinate the field with WP-17. Do not write it into `KernelSnapshot`;
the kernel does not know about the convoy's manifest.

**Priority inversion.** `narrows.sweep` at priority 9 holds `lock.manifest`, `narrows.hauler` at
priority 5 preempts it and runs, and SABLE at priority 1 waits behind both. The affliction is
`priority_inversion` (3 integrity per travel tick, fatal after 30 in this leg's instance) on the
**high-priority** Program, which is exactly backwards from what the player expects and is the
point. The epitaph cause reads: *"it was the highest-priority Program in the convoy and it
waited 210 ticks for a lock held by the lowest. Priority does not transfer through a lock unless
you make it."*

The 210 is a frozen fixture. Tune the sweep and hauler service times so that, at steady pace
with inheritance off and no intervention, SABLE's wait on `lock.manifest` reaches 210 ticks.

**Spin-based politeness.** Two Programs each yield to the other forever, acquiring `livelock`
(1 integrity per travel tick, never fatal, blocks progress). Nothing dies and nothing moves,
which is a preview of the Gridlock two legs later. Do not add a `deadlock.detected` event; the
`deadlock` subsystem is off.

### Objectives

| Objective | Computed from |
|---|---|
| `obj.the_narrows.three_requirements` | Zero `sync.race_detected` events **and**, from the `SyncPrimitive` wait queues, no pid overtaken more than twice. `ordered: true` on the chosen primitive satisfies bounded waiting structurally, so this also passes when the player picks an ordered primitive and never notices why. Both routes must pass. |
| `obj.the_narrows.spin_versus_block` | Sum `spunTicks` across all `sync.busy_wait` events; require under 25. |
| `obj.the_narrows.minimal_critical_section` | Every `memory.access` with `write: true` to the ledger address falls between a matching `sync.acquired` and `sync.released` pair, **and** the mean interval between them is under 6 ticks. |
| `obj.the_narrows.atomic_primitive` | A `trace --replay` invocation on a recorded race, followed by zero races on the identical replay, with `compare_and_swap` installed. |
| `obj.the_narrows.semaphore_capacity` | `sem.ford.capacity === 3` at the wide ford, **and** zero `sync.blocked` events on `sem.ford` while its `value > 0`, **and** zero Programs admitted past 3. |
| `obj.the_narrows.priority_inversion` | The `priority_inversion` affliction on SABLE was cleared before the deadline, by `narrows.toggle_inheritance` on `lock.manifest` or by SABLE's shield. |

Note on `three_requirements`: `memory.access` events on the ledger address require the `memory`
subsystem, which this leg does not enable. Resolve this by having WP-07's race detector emit
ledger writes as part of `sync.race_detected`'s `RaceCondition.interleaving` and by tracking
guarded-region membership in the sync subsystem itself. If WP-07 cannot do that, file it
against WP-07 rather than enabling `memory` here. Enabling `memory` would put page tables in
the Narrows, which belongs to leg 7.

### Debrief card

```ts
{
  headline: /* 'Across the Narrows.' or 'The manifest is wrong.' */,
  whatHappened:
    `You crossed three sections: ${optionList.join(', ')}. Contention at each was ` +
    `${cValues.map(c => c.toFixed(2)).join(', ')}. Races detected: ${raceCount}. ` +
    `Spun ticks: ${spunTicks}.`,
  whyItHappened: /* selected */,
  counterfactual: /* computed from a real trace replay */,
  chapter: { chapter: 6, title: 'Synchronization Tools', sections: ['6.2'] },
}
```

Counterfactual, in priority order:

1. **A race survived to leg end.** Replay the recorded interleaving with `compare_and_swap` and
   report: `"The same interleaving under compare-and-swap produces ${expected} instead of
   ${corrupted}. The manifest you are carrying reads ${corrupted}."` Do not say what leg 11 will
   do with it.
2. **Priority inversion killed or nearly killed SABLE.** `"SABLE waited ${wait} ticks for a lock
   held by a Program at priority 9. With inheritance enabled the holder runs at SABLE's priority
   and finishes in ${holdTicks} ticks."`
3. **Spun over 25 ticks.** `"You spun ${spunTicks} ticks. A context switch costs 4. Spinning is
   cheaper than switching only while the expected wait is under 4."`
4. **Semaphore capacity wrong.** `"The ford holds three. Your semaphore admitted ${cap}."`
5. `null`.

---

## Acceptance criteria

1. `src/legs/the_narrows/index.ts` satisfies `Leg` under `tsc --strict`, `id === 'the_narrows'`,
   `index === 4`.
2. The leg runs headlessly to completion via the WP-20 smoke-test harness.
3. `enabledSubsystems` deep-equals `['process', 'scheduler', 'sync']`. `deadlock` is not
   enabled; a two-node block produces no `deadlock.detected` event.
4. Inert-field independence over 400 ticks.
5. Every objective can be met by the known-good decision sequence; all six met in one run.
6. The known-bad sequence produces the intended failure: the plank crossed unguarded, a
   `sync.race_detected` fires with the four-line interleaving, the manifest is corrupted, and
   the corruption is written into the leg outcome for leg 11 to read.
7. The two-mutex second ford corrupts the ledger while `lock --list` shows both primitives with
   zero contention. Asserted directly.
8. Interrupt-disable at the four-core wide ford prevents preemption on one core and not on the
   other three. `race --list` still fills.
9. `trace --replay` with the protocol unchanged reproduces the race exactly, including
   `corruptedValue` and `expectedValue`. With `compare_and_swap` installed it produces zero
   races on the identical decision sequence.
10. `trace --replay` never mutates the live event log or `RunState`, over 200 replays.
11. Fixtures `SYNC-PETERSON-1`, `SYNC-PETERSON-2`, `SYNC-PETERSON-3`, `SYNC-RACE-1`,
    `SYNC-RACE-2` and `SYNC-TAS-1` all pass against the primitives this leg exposes.
12. Crossing costs match narrative bible section 12's formulas exactly at `C` values 0.0, 0.2,
    0.45, 0.70 and 1.0, for all four options.
13. Priority inheritance on `lock.manifest` bounds SABLE's wait; without it SABLE's wait reaches
    the frozen fixture of 210 ticks at steady pace.
14. Semaphore capacity 3 admits exactly three; capacity 1 blocks while `value > 0` is false;
    capacity 4 admits a fourth and the fourth falls.
15. Event table weights sum to exactly 100; all ids unique.
16. All three terminal command `manual` strings match the curriculum map byte for byte.
17. Draw calls stay under 220 / 450 / 900 at the heaviest frame, which is the ghost-image race
    resolution with the full interleaving drawn as world-space labels along the span.
18. The race hero visual holds: two overlapping partly transparent ghost crossings resolving
    into one wrong value, with the `interleaving` strings placed along the span in execution
    order, at all three tiers.

---

## Tests you must write

All under `tests/legs/the_narrows/`.

**`contract.test.ts`**: `Leg` conformance, exact ids, chapters, six objectives.

**`config.test.ts`**: `enabledSubsystems` exact; `preemptive: true`; no `deadlock.detected`
event is ever emitted; inert-field independence.

**`populate.test.ts`**: nine spawns, five binds, five `declareSync` calls with exact ids, kinds
and initial capacities.

**`race.test.ts`**: the race detector.
- Unguarded plank crossing produces `sync.race_detected` with the four-line
  load/load/store/store `interleaving`, per `SYNC-RACE-1`.
- The same wrapped in a mutex produces zero races and a final value of exactly the expected sum,
  per `SYNC-RACE-2`.
- The two-mutex second ford corrupts the ledger with both locks showing zero contention.
- Peterson with reordering off holds mutual exclusion for 10,000 ticks; with reordering on and
  store buffer depth 2 it violates; with an `mfence` between lines 2 and 3 it holds.

**`crossings.test.ts`**: the four options against the shared formulas.
- For each of `C` = 0.0, 0.2, 0.45, 0.70, 1.0: spin cost `round(12 + 90C)` cycles and
  `round(4 + 30C)` ticks with `successP = 1 - 0.85C^2`; block `round(20 + 60C)` ticks, 0 cycles,
  quota by the formula, `successP` 0.99 if ordered else `1 - 0.55C^2`; monitor
  `round(45 + 120C)` cycles, 6 bandwidth, 8 ticks, `successP` 0.97; wait by the shared rule.
- Spin failure at `C <= 0.70` inflicts `lock_convoy` on the crosser and everything behind.
  Above 0.70 it inflicts `livelock` on the crosser and one other.
- Block failure on an unordered queue inflicts `starvation`.
- Monitor failure inflicts `bit_rot` and costs 20 blocks.

**`interrupts.test.ts`**: interrupt-disable prevents preemption on one core; on the four-core
ford the other three cores still enter the section; `race --list` fills while the switch is on.

**`replay.test.ts`**: the `trace --replay` contract, all five points from the implementation
contract above.

**`inversion.test.ts`**: priority inversion.
- With inheritance off, SABLE's wait on `lock.manifest` reaches the frozen 210 ticks.
- With inheritance on, the holder runs at SABLE's priority and the wait is bounded.
- SABLE's shield achieves the same by making the resource preemptible for 20 ticks.
- The affliction lands on the **waiter**, not the holder. Asserted explicitly, because getting
  this backwards is the easy bug.

**`semaphore.test.ts`**: capacity 1, 3 and 4 at the wide ford; the objective passes only at 3.

**`evaluate.test.ts`**: each of the six objectives, met and not met. Both routes through
`three_requirements` tested: the player who reasons about bounded waiting and the player who
picks an ordered primitive by accident.

**`golden.test.ts`**: the golden headless playthrough.
- Fixture: `seed: 0x4b54524c`, `discClass: 'shell'`, `difficulty: 'operator'`, steady pace,
  standard rations, entering with the leg 3 golden closing ledger.
- Known-good sequence: cross the plank by spinning at `C = 0.20`; on the first race, `race
  --show 1`, then `narrows.use_cas`, then `trace --replay 1` and observe zero; `lock --mark` the
  ledger region at the second ford, guarding every write, under 6 ticks; set `sem.ford` capacity
  to 3; cross the wide ford by blocking; enable inheritance on `lock.manifest` on the first
  `priority_inversion` warning.
- Assert: all six objectives met, zero races surviving to leg end, zero casualties, spun ticks
  under 25, eight codex entries added, canonical event log hash matches the golden file,
  stable across two runs and a snapshot-restore.

**`badpath.test.ts`**: the known-bad sequence.
- Cross everything by spinning, never mark a critical section, leave the two-mutex ford as it
  is, never enable inheritance.
- Assert: at least two `sync.race_detected`, the manifest corrupted and the corruption written
  into the leg outcome, `priority_inversion` on SABLE reaching 210 ticks, spun ticks above 60,
  `livelock` acquired at the wide ford, counterfactual case 1, and `survived === true`.

**`manuals.test.ts`**: three manual strings against the curriculum map fixture; every
`See also:` resolves.

**`stage.test.ts`**: anchors resolve; interaction anchors resolve; draw calls under budget; the
`anchor.interrupt_switch` wiring reaches exactly one core object; the race hero visual assertion.

---

## Out of scope

- Do not touch any other leg. Do not import from `src/legs/*` other than your own directory.
- Do not modify the frozen type files or anything under `src/kernel`, `src/render`,
  `src/world`, `src/terminal`, `src/ui`, `src/audio`, `src/design`, `src/platform`, `src/app`.
- Do not enable `deadlock`. A two-node cycle here blocks silently. The Cistern deadlocks the
  player and the Gridlock names it, and stealing that sequence breaks two legs.
- Do not enable `memory`. If the race detector cannot report ledger writes without it, file it
  against WP-07.
- Do not enable `fs`. The corrupted manifest is a value carried in the leg outcome, not an
  inode.
- Do not reimplement the crossing cost formulas. They are shared code in WP-19.
- Do not reimplement the shadow-kernel replay helper. Share it with leg 3 through WP-18.
- Do not fix the two-mutex ford. Both mutexes are individually correct and the ledger is still
  wrong, and that is the lesson.
- Do not make the monitor's 3 percent failure rate zero. The spurious wakeup is the highest
  value four seconds in the course.

### Files this package owns exclusively

```
src/legs/the_narrows/index.ts
src/legs/the_narrows/chapters.ts
src/legs/the_narrows/objectives.ts
src/legs/the_narrows/config.ts
src/legs/the_narrows/populate.ts
src/legs/the_narrows/interactions.ts
src/legs/the_narrows/commands.ts
src/legs/the_narrows/events.ts
src/legs/the_narrows/evaluate.ts
src/legs/the_narrows/crossings.ts
src/legs/the_narrows/ledger.ts
src/legs/the_narrows/stage.ts
src/legs/the_narrows/copy.ts
tests/legs/the_narrows/**
```

---

## Report back

1. Commit or branch, and the full `tests/legs/the_narrows/` output.
2. Golden playthrough hash and its checked-in path.
3. The frozen fixtures: SABLE's wait on `lock.manifest` with inheritance off at each of the four
   paces, and the designed contention at each of the three crossings at arrival.
4. Crossing cost and success rate for all four options at `C` = 0.0, 0.2, 0.45, 0.70 and 1.0, as
   a table, against the shared formulas.
5. How you resolved the `memory.access` question in `obj.the_narrows.minimal_critical_section`,
   and the item filed against WP-07 if one was needed.
6. Where the shadow-kernel replay helper lives, and confirmation that leg 3 and WP-18 use the
   same one.
7. The field on the leg outcome that carries the corrupted manifest to leg 11, agreed with
   WP-17.
8. Draw calls at each tier at the heaviest frame.
9. Any document disagreement, what you did, and which document you followed.
10. Confirmation that no file outside the owned list was created or modified.

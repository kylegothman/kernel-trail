# WP-L07: The Allocation Yards

Leg id `allocation_yards`, index 7. Subtitle: *There is enough room. There is nowhere to stand.*

**Legs are independent and may be built concurrently.** This package touches no other leg,
imports from no other leg, and shares no source file with any other leg.

This leg sits between the two difficulty spikes and it is deliberate relief. Its failures are
visible, its remedies are immediate, and `frag --compare` will settle any argument in ten
seconds. The player rebuilds confidence on a leg where being careful reliably works, which is
not true of leg 6 and is barely true of leg 8. Do not make it harder than it is written.

---

## Objective

A module at `src/legs/allocation_yards/` implementing the frozen `Leg` interface, playable end to
end. The yards are long rows of lit slabs in numbered bays, most of them dark and unclaimed. The
convoy needs five contiguous berths for five address spaces. The request is refused with
`ENOMEM`, and the player can see free slabs from where they are standing, dozens of them,
scattered between occupied runs in strips of two and three.

First fit, best fit and worst fit are literal parking decisions: a request arrives, the yard
office picks a bay, and the leftover strip stays where it was left. Fragmentation accumulates
visibly across the leg, run by run, until the yard is a picture of every decision the player has
made.

Then the yard converts to paged allocation and external fragmentation goes to exactly zero while
internal fragmentation rises from zero in the same frame, on two adjacent meters.

The leg also plants the run's longest fuse: the executable bit on the data pages. Leaving it set
lets a scripted injection run, which kills nothing here and resurfaces at the Arbiter Wall five
legs and roughly forty minutes later.

---

## Prerequisites

**Engine work packages that must be complete and green on the shared branch:**

| Package | Why this leg needs it |
|---|---|
| WP-01 | `Rng`, event bus, canonical serialiser. |
| WP-02 | Process table, PCB, `addressSpaceId`, kernel step order. |
| WP-03, WP-04 | Scheduler policies. The leg does not teach scheduling and needs the policies to exist. |
| **WP-05** | **The whole of it.** Frame table, the four allocation strategies, page tables, the TLB, address translation. This leg is WP-05's principal consumer. |
| WP-11 | Syscalls, snapshot and restore, the invariant set. |
| WP-12 | Renderer backend, post chain, design tokens, draw call budget. |
| WP-13 | Focus camera and the diegetic structure base classes. |
| WP-14 | World event router. `memory.allocated`, `memory.allocation_failed` and `tlb.miss` must have visual treatments. |
| WP-15 | The terminal. |
| WP-17 | HUD, codex, save and load. |
| WP-18 | The counterfactual replay worker, for `frag --compare` and the debrief. |

**Kernel subsystems that must be working:** `process`, `scheduler`, `memory`.

WP-05 must provide, exactly:

- All four `AllocationStrategy` values, each reproducing its `MEM-FIT-1*` fixture.
- Compaction, sliding every occupied run together and updating every base register, with a cost
  proportional to the number of occupied runs moved.
- `memory.allocation_failed` carrying `reason: 'no_space'` and `reason: 'fragmentation'` as
  distinct values.
- `MemoryMetrics.externalFragmentation` and `.internalFragmentation` as separate live figures.
- Page tables with per-entry `readable`, `writable` and `executable` bits enforced by the
  translation path rather than by any caller.
- A TLB with a configurable entry count, a flush operation, and `MemoryMetrics.tlbHitRate`.
- Configurable `pageSize`, changing both page table size and internal fragmentation.

Fixtures `MEM-FIT-1a`, `MEM-FIT-1b`, `MEM-FIT-1c`, `MEM-BUDDY-1`, `MEM-XLATE-1`, `MEM-XLATE-2`,
`MEM-TLB-1`, `MEM-TLB-1b` and `MEM-FRAG-1` must all pass before this leg starts.

**Not required and must not be enabled:** `vm`. Demand paging, replacement policies, working
sets and thrashing all belong to leg 8. This leg establishes pages, frames, the page table and
the valid bit, and leg 8 cannot be explained at all without them, which is why the two legs are
adjacent and why paging is not taught in the Reach.

---

## Required reading

- `docs/05-CURRICULUM-MAP.md`, "Leg 7. THE ALLOCATION YARDS" in full; section D, "Relief
  placement", which explains this leg's job in the curve.
- `docs/02-KERNEL-SIM-SPEC.md`, **section 6 in full** (Main memory, Ch. 9); section 16.5 (the
  `MEM-*` test vectors).
- `docs/04-NARRATIVE-BIBLE.md`, section 7 entries for `fragmented` and `memory_leak`; section 8
  leg 7 event table; section 10 (the leg 7 depot, which is the last depot before the Drowned
  Reach and is therefore the one balancing pass should touch); section 11 (reclamation).
- `docs/03-VISUAL-BIBLE.md`, section 10 "Leg 7, The Allocation Yards"; section 13 (quality
  tiers).

The leg 7 depot deserves a note. Leg 8 has no depot. Every playtest note about leg 8 being too
punishing is answered by adjusting the Yards depot and never by putting a depot in the Reach.
That makes this leg's depot the load-bearing one in the second half of the run, so price it
exactly per the economy and report what the convoy typically leaves with.

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
  { chapter: 9, title: 'Main Memory',
    sections: ['9.1.1', '9.1.2', '9.1.3', '9.1.4', '9.1.5',
               '9.2.1', '9.2.2', '9.2.3',
               '9.3.1', '9.3.2', '9.3.3', '9.3.4',
               '9.4.1', '9.4.3', '9.5.1', '9.5.2'] },
];
```

### Learning objectives

```ts
export const objectives: readonly LearningObjective[] = [
  {
    id: 'obj.allocation_yards.strategy_choice',
    statement: 'Selects an allocation strategy that places every Program in the convoy and leaves external fragmentation under 12 percent of total yard space at leg end.',
    chapter: { chapter: 9, title: 'Main Memory', sections: ['9.2.2', '9.2.3'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.allocation_yards.diagnose_fragmentation',
    statement: 'Distinguishes an allocation failure caused by fragmentation from one caused by genuine exhaustion using free -f, and spends cycles on compaction only in the first case.',
    chapter: { chapter: 9, title: 'Main Memory', sections: ['9.2.3'] },
    assessedBy: 'terminal_command',
  },
  {
    id: 'obj.allocation_yards.paging_trade',
    statement: 'Converts the yard to paged allocation and reports external fragmentation at exactly zero while internal fragmentation rises to no more than half a frame per Program.',
    chapter: { chapter: 9, title: 'Main Memory', sections: ['9.3.1'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.allocation_yards.translate_address',
    statement: 'Reads a page table with pagetable and translates a given logical address to the correct frame number and offset on the first attempt at the translation gate.',
    chapter: { chapter: 9, title: 'Main Memory', sections: ['9.3.1', '9.3.2'] },
    assessedBy: 'terminal_command',
  },
  {
    id: 'obj.allocation_yards.locality_over_hardware',
    statement: 'Raises the TLB hit rate above 85 percent by choosing the contiguous access route over the scattered one, without buying additional TLB entries.',
    chapter: { chapter: 9, title: 'Main Memory', sections: ['9.3.2'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.allocation_yards.protection_bits',
    statement: 'Clears the executable bit on the data pages so the scripted write-then-execute attempt raises a protection fault instead of running.',
    chapter: { chapter: 9, title: 'Main Memory', sections: ['9.3.3'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.allocation_yards.page_size_tradeoff',
    statement: 'Chooses a page size that holds each Program page table under 64 entries while keeping internal fragmentation under 8 percent of allocated memory.',
    chapter: { chapter: 9, title: 'Main Memory', sections: ['9.3.1', '9.4.1'] },
    assessedBy: 'decision',
  },
];
```

### Codex entries this leg adds to `codexUnlocked`

`codex.address_binding`, `codex.logical_vs_physical`, `codex.contiguous_allocation`,
`codex.fragmentation`, `codex.paging`, `codex.tlb`, `codex.page_protection`,
`codex.page_table_structure`.

| Entry | Added when |
|---|---|
| `codex.address_binding` | The first `memory.allocated` event with a base register assignment. |
| `codex.logical_vs_physical` | First `pagetable --translate`. |
| `codex.contiguous_allocation` | First allocation strategy change at the yard office. |
| `codex.fragmentation` | First `memory.allocation_failed { reason: 'fragmentation' }`, which is the leg's opening event. |
| `codex.paging` | The yard converts to paged allocation. |
| `codex.tlb` | First `tlb --stats`. |
| `codex.page_protection` | First `pagetable --bits`. |
| `codex.page_table_structure` | First page size change, or the first `pagetable` on a Program whose table exceeds 64 entries. |

### Misconceptions this leg must break

**"Out of memory means memory is full."** The break is the leg's opening event and it is put
first for that reason. `ENOMEM` fires with 38 percent of the yard free and visibly dark, and
`free -f` shows 41 free runs whose largest is 9 frames against a request for 12. The word "out"
is doing the damage, and the fix is to make the player look at the shape rather than the total.

Build requirements:
- The opening allocation failure carries `reason: 'fragmentation'` and the yard is 38 percent
  free at that tick. Freeze both numbers.
- `free -f` reports 41 free runs, largest 9, against a request for 12.
- Every later out-of-memory event in the run prints its `reason` field for the same purpose,
  including the ones in the Drowned Reach. Register the presentation convention with WP-17 so
  leg 8 inherits it rather than reinventing it.

**"Paging solves fragmentation."** Students who meet paging after contiguous allocation conclude
that fragmentation is now behind them, and it is a half-truth that costs them later when they
reason about page size or slab allocation. The break is instrumented: the moment the yard
converts to paging, `frag` shows external fragmentation dropping to exactly 0 and internal
fragmentation rising from 0 to a nonzero number **in the same frame**, on two adjacent meters.
The player then chooses a page size and watches the internal figure move inversely against the
page table size on the index board. The trade is visible as two numbers moving in opposite
directions under one dial.

Build requirements:
- Two adjacent meters, physically adjacent in the world, at `anchor.frag_meters`. Not two HUD
  numbers and not two separate locks.
- The transition is one frame. `MEM-FRAG-1` guarantees `externalFragmentation === 0` for every
  paged configuration, so the external meter goes to zero and stays there.
- The page size dial moves the internal meter and the index board's row count in opposite
  directions, live, while the player holds the dial.

**"Address translation is free because the MMU does it in hardware."** The break is the
`--flush` demonstration. The player is given a segment with the TLB disabled and the crossing
takes almost exactly twice as long, which `tlb --stats` attributes precisely: every access became
two accesses. Then the TLB is restored and the player is offered two routes through the yard
with identical distance and different locality. The contiguous route hits 92 percent and the
scattered route hits 41 percent, on the same hardware, with the same number of entries.

Build requirements:
- The TLB-disabled segment takes between 1.95x and 2.05x the TLB-enabled time. That follows from
  `MEM-TLB-1` at `h = 0`: EAT is 200 ns against a 100 ns memory access.
- The two routes have **identical distance** and different locality. Assert the distance
  equality in a test, because a player who suspects the scattered route is simply longer has not
  been shown anything.
- Contiguous route hit rate 92 percent, scattered 41 percent, both frozen fixtures, both with
  `KernelConfig.tlbEntries` unchanged.

---

## Kernel configuration

```ts
export function kernelConfig(run: RunState): KernelConfig {
  return {
    seed: run.seed,
    scheduler: 'rr',                       // the leg is not about scheduling; rr keeps the yard traffic even
    schedulerParams: {
      quantum: quantumForPace(run.policy.pace),  // Ch. 5.3.3
      agingInterval: 0,                    // nothing here starves; aging would only add noise
      starvationThreshold: 120,
      starvationFatalThreshold: 300,
      preemptive: true,
    },
    totalFrames: 96,                       // the yard. Larger than the 64-frame default because the leg needs visible holes.
    pageSize: 4096,                        // the entry value; the player changes it at the gate
    replacementPolicy: 'lru',              // INERT: 'vm' is not enabled. Nothing is ever evicted in this leg.
    allocationStrategy: 'first_fit',       // the entry value; the player changes it at the yard office
    tlbEntries: 16,                        // real and load-bearing. The locality objective forbids changing it.
    diskPolicy: 'look',                    // inert: 'storage' is not enabled
    totalCylinders: 200,                   // inert
    raidLevel: null,                       // inert
    fileAllocation: 'indexed',             // inert: 'fs' is not enabled
    journalingEnabled: false,              // inert
    deadlockStrategy: 'ignore',            // inert: 'deadlock' is not enabled
    thrashingThreshold: 200,               // INERT here. Leg 8 makes it real.
    enabledSubsystems: ['process', 'scheduler', 'memory'],
  };
}
```

`enabledSubsystems` is `['process', 'scheduler', 'memory']`. **`vm` is not enabled.** That is the
single most important line in this configuration. With `vm` off there is no demand paging, no
replacement policy, no eviction and no fault path: every page a Program owns is resident from
allocation, the valid bit is set for every mapped page, and `replacementPolicy` is never read.
Leg 8 turns `vm` on and the valid bit starts meaning something.

`totalFrames: 96` against the reference configuration's 64 is deliberate. The leg needs enough
bays for 41 free runs to be a legible picture rather than a crowded one. Note that leg 8 runs
**48** frames, so the convoy is walking from the roomiest leg in the game straight into the
tightest, which is the shape the curve wants.

`tlbEntries: 16` is real. `obj.allocation_yards.locality_over_hardware` requires the hit rate
above 85 percent **with `tlbEntries` unchanged from the leg's opening value**, so the leg must
record the opening value and compare against it, and the TLB purchase at the yard office must be
recorded as a decision that fails the objective if taken.

---

## Population

```ts
export function populate(ctx: LegSetupContext): void {
  // The convoy. Five address spaces needing contiguous berths.
  const roster: readonly [ConvoyMemberId, string, number, number, number, number][] = [
    // member,      name,      priority, burst, service, pages
    ['lumen',   'LUMEN',   2, 6, 64, 12],
    ['sable',   'SABLE',   2, 5, 58, 10],
    ['orrery',  'ORRERY',  3, 5, 58, 10],
    ['kestrel', 'KESTREL', 3, 4, 52,  8],
    ['vesper',  'VESPER',  3, 5, 58, 11],   // VESPER's remap is the strongest single move in the leg
  ];
  roster.forEach(([member, name, priority, burst, service, pages], i) => {
    const pid = ctx.spawn({ name, priority, burst, service, arrival: i, pages });
    ctx.bind(member, pid);
  });

  // The yard's resident traffic. These are what fragmented the yard before the convoy arrived,
  // and their arrivals and departures keep fragmenting it during the leg.
  const yard: readonly [string, number, number, number][] = [
    // name,              arrival, pages, service
    ['yard.resident_a',   0,  9, 200],
    ['yard.resident_b',   0,  6, 200],
    ['yard.resident_c',   0,  7, 200],
    ['yard.resident_d',   0,  5, 200],
    ['yard.transient_a', 12,  4,  40],   // departs at 52, leaving a 4-frame strip
    ['yard.transient_b', 20,  3,  35],   // departs at 55, leaving a 3-frame strip
    ['yard.transient_c', 28,  2,  30],   // departs at 58, leaving a 2-frame strip
    ['yard.transient_d', 36,  4,  44],
    ['yard.transient_e', 44,  3,  38],
  ];
  yard.forEach(([name, arrival, pages, service]) => {
    ctx.spawn({ name, priority: 4, burst: 4, service, arrival, pages });
  });
}
```

No `declareResource` and no `declareSync`. There is no contention in the Yards; the leg's whole
subject is placement.

### The strategy comparison set, verbatim from `MEM-FIT-1*`

The yard office's `frag --compare` replays the recorded allocation sequence under all four
strategies. Use the sim spec's fixture as the leg's own comparison set so the comparison is
verifiable and so a player who checks the arithmetic finds it correct.

Holes, in yard order: **100, 500, 200, 300, 600**.
Requests, in order: **212, 417, 112, 426**.

| Strategy | Placement | Outcome | Free after | Largest run after |
|---|---|---|---|---|
| **first fit** | 212 into 500; 417 into 600; 112 into 288 | 426 **fails** | 959 K | 300 K |
| **best fit** | 212 into 300; 417 into 500; 112 into 200; 426 into 600 | all fit | 533 K | 174 K |
| **worst fit** | 212 into 600; 417 into 500; 112 into 388 | 426 **fails** | 959 K | 300 K |

Fixtures `MEM-FIT-1a`, `MEM-FIT-1b` and `MEM-FIT-1c`. Read the table before you tune anything:
on this sequence first fit and worst fit produce **identical** free totals and identical largest
runs, and both fail the fourth request, while best fit places everything and leaves 533 K free
in a largest run of 174 K.

Two things follow, and both are teaching.

First, `frag --compare` must print the placement, not only the totals, because first fit and
worst fit have the same totals and got there by different routes. The man page says first fit
and best fit usually land close together with first fit faster, and worst fit does badly. On
this particular sequence first fit also fails, which is honest and which the player should see:
strategy comparisons are per-sequence and the general claim is a tendency rather than a law.

Second, worst fit is the trap for players who reason that leaving the largest remaining hole
must be good. It produces the worst external fragmentation of the four across the **leg's full
sequence**, which is longer than the fixture's four requests. Extend the fixture sequence with
the yard's own arrivals and departures so that across the whole leg worst fit is clearly worst,
and freeze the resulting fragmentation figures for all four strategies.

Buddy allocation is the fourth strategy. `MEM-BUDDY-1`: a 256 KB region, a 21 KB request, a
1 KB minimum block, yields a 32 KB block with 11 KB of internal fragmentation, and the free
lists hold one 32 K, one 64 K and one 128 K. The yard physically re-stripes into powers of two
when buddy is selected, which is the visual bible's stated treatment, and the re-striping is
what makes the internal waste legible.

### The translation gate

`obj.allocation_yards.translate_address` is a single gated answer, checked against the live page
table, and **the gate accepts one attempt**. Use the sim spec's translation fixtures as the
gate's worked examples so the player has seen the arithmetic before being asked.

`MEM-XLATE-1`: page size 4, page table `[5, 6, 1, 2]`. Logical 0, 3, 4 and 13 translate to
physical 20, 23, 24 and 9. Post this on the gate's face as the worked example.

`MEM-XLATE-2`: page size 4096, logical address `0x00003ABC`, page 3 mapping to frame 12. Page
number 3, offset 2748, physical address 51900, which is `0x0000CABC`. This is the gate's actual
question, asked against the convoy's own live page table so the frame number is whatever the
allocator gave it rather than a constant.

The `pagetable` man page carries a third worked example: with a 256-byte page, logical address
1000 is page 3, offset 232, and if page 3 maps to frame 11 the physical address is
`11 * 256 + 232`. Three worked examples at three page sizes, which is enough for the player to
see that the split is the same operation every time.

### The TLB segment

`MEM-TLB-1`: effective access time with a 100 ns memory access and no TLB lookup cost, at hit
rates 0.50, 0.80, 0.90 and 0.99, is 150.00, 120.00, 110.00 and 101.00 ns.
`MEM-TLB-1b`: with a 10 ns TLB lookup cost, at 0.80 and 0.99, is 130.00 and 111.00 ns.

The `tlb` man page states the formula as `h * m + (1 - h) * 2m`. Post the four-row table from
`MEM-TLB-1` at the TLB console so the player can read their own hit rate off it.

The two routes:

| Route | Distance | Pages touched | Stride | Frozen hit rate |
|---|---|---|---|---|
| `route.contiguous` | equal | 8 | 1 | **0.92** |
| `route.scattered` | equal | 8 | 47 | **0.41** |

Same distance, same page count, same `tlbEntries`. Only the stride differs. A 16-entry TLB
covers 16 pages, so a loop touching 8 pages hits constantly and a loop striding across 400 pages
misses constantly, on the same hardware.

### The protection fuse

At the protection bench the player sets `readable`, `writable` and `executable` per page range.
The convoy's data pages arrive with `executable: true`, which is the default a careless system
gives them and is the state the scripted injection needs.

The injection runs at a fixed tick late in the leg. It writes a modified Program image into a
data page and then attempts to execute it.

- **Executable bit cleared:** the execute attempt raises a protection fault at the moment it
  tries to run. Nothing is planted. `obj.allocation_yards.protection_bits` is met.
- **Executable bit left set:** the injection succeeds, kills nothing, and plants a modified
  Program image. The leg outcome records the planted image and the tick of the original
  decision.

At the Arbiter Wall the arbiter reads that Program's disc, finds it valid, and lets it through.
Behind the wall it begins issuing ring 0 traps and they succeed. That is the longest causal
chain in the game and leg 12's debrief traces it explicitly, naming the tick of the original
decision. This leg's only job is to record it faithfully.

Record it as a `DecisionRecord` with `kind: 'executable_bit'`, `choice: 'left_set'` or
`'cleared'`, and `relatedObjective: 'obj.allocation_yards.protection_bits'`, at the tick the
player last committed the protection bits before the injection. Leave `outcome: 'pending'`; leg
12 marks it `fatal` if the escalation kills someone. Agree the shape with WP-17 before you build.

The `pagetable --bits` man page states why this matters: "These are enforced by the memory
management unit on every access, not by any code you write, which is the only reason they are
worth anything. A page marked non-executable cannot be executed even by the process that owns it
and wants to." The enforcement must be real, in WP-05's translation path. Do not check the bit
in the leg.

---

## Stage

**Form.** Slabs of varying length in numbered bays.
**Accent.** `CYAN.core` for allocated, `CYAN.trace` outline for holes.
**Environment.** A rail yard. Long parallel bays hold allocations as slabs, and the gaps between
them are the holes. Buddy allocation reconfigures the bays into powers of two, which is visible
as the yard physically re-striping.
**Hero visual.** The fragmentation readout. On
`memory.allocation_failed { reason: 'fragmentation' }` every free hole in the yard lights at
once in `frame_free` cyan, each labelled with its size, and a single amber bar the length of the
failed request floats above the yard, visibly shorter than the sum of the lit holes and longer
than any one of them.

That hero visual is the first misconception in one picture and it must be exact: the amber bar's
world length is the request size in frames, each hole's label is its own size, and the sum is
larger than the bar. A player who counts must find the arithmetic works.

| Anchor id | Structure | Focus camera target |
|---|---|---|
| `anchor.yard` | The whole yard, all bays, from the gantry | wide establishing; the fragmentation hero shot frames from here |
| `anchor.bay.<n>` | One anchor per numbered bay | head-on; the bay number, its occupant and its length legible |
| `anchor.yard_office` | The allocation strategy selector: first fit, best fit, worst fit, buddy | head-on orthographic; all four with their live fragmentation figures |
| `anchor.frag_meters` | Two physically adjacent meters, external and internal | head-on orthographic; **both must be in one lock, side by side** |
| `anchor.request_bar` | The amber bar the length of a failed request, floating above the yard | included in the hero framing |
| `anchor.paging_gate` | The conversion from contiguous to paged allocation | head-on |
| `anchor.index_board` | The page table drawn as a physical index board, one row per page | head-on orthographic; row count must be countable at a glance up to 64 |
| `anchor.page_size_dial` | The page size dial | head-on; the dial, the internal meter and the index board row count must all be visible while the dial moves |
| `anchor.translation_gate` | The address translation gate, with `MEM-XLATE-1`'s worked example on its face | head-on orthographic; the worked example and the question in one frame |
| `anchor.tlb_console` | Hit rate, entries, the `MEM-TLB-1` table, and the flush control | head-on |
| `anchor.route_fork` | The two routes, contiguous and scattered, with their distances posted as equal | head-on; both routes and both distances in frame |
| `anchor.protection_bench` | Per-page-range `readable`, `writable`, `executable` toggles | head-on orthographic; the executable column must be the one the eye lands on |
| `anchor.compaction_crew` | The compaction purchase, with its cost scaling with occupied runs moved | head-on; the run count and the price both legible before commit |
| `anchor.depot` | The leg 7 depot, the last before the Reach | head-on |
| `anchor.convoy.<member>` | Per-Program stele | head-on |

### Two hard stage requirements

**The two meters are one lock.** `obj.allocation_yards.paging_trade` and the second
misconception both depend on the player seeing external drop to zero and internal rise from zero
in the same frame. Two HUD numbers do not do this. Two separate camera locks do not do this. One
orthographic lock on two adjacent physical meters does.

**The yard accumulates.** Fragmentation is not reset between segments. The yard the player is
standing in at the end of the leg is the yard their decisions built, and `frag --compare`
replays the same recorded sequence rather than a synthetic one. A player who used worst fit for
the first half is looking at a visibly worse yard than one who did not, before any number is
quoted.

---

## Interactions

```ts
export const interactions: readonly InteractionDef[] = [
  {
    id: 'yards.set_strategy',
    label: 'Set the allocation strategy',
    description: 'First fit, best fit, worst fit or buddy. The yard keeps whatever shape your choices leave it in.',
    anchor: 'anchor.yard_office',
    cost: { cycles: 8 },
    enabledWhen: (run) => run.resources.cycles >= 8,
  },
  {
    id: 'yards.compact',
    label: 'Buy a compaction pass',
    description: 'Slide every occupied run together. It works, it stops every process that owns memory for the duration, and it must update every base register.',
    anchor: 'anchor.compaction_crew',
    cost: { cycles: 0 },   // computed at commit: scales with occupied runs moved
    enabledWhen: (run) => run.resources.cycles > 0,
  },
  {
    id: 'yards.convert_to_paging',
    label: 'Convert the yard to paged allocation',
    description: 'Any free frame fits any page. Watch both meters when you commit this.',
    anchor: 'anchor.paging_gate',
    cost: { cycles: 40, bandwidth: 6 },
    enabledWhen: (run) => run.resources.cycles >= 40 && run.resources.bandwidth >= 6,
  },
  {
    id: 'yards.set_page_size',
    label: 'Set the page size',
    description: 'Larger pages mean smaller page tables and more waste inside the last frame of each Program.',
    anchor: 'anchor.page_size_dial',
    cost: { cycles: 10 },
    enabledWhen: (run) => run.resources.cycles >= 10,
  },
  {
    id: 'yards.set_protection_bits',
    label: 'Set protection bits',
    description: 'Read, write and execute, per page range, enforced by the hardware on every access.',
    anchor: 'anchor.protection_bench',
    cost: { cycles: 6 },
    enabledWhen: (run) => run.resources.cycles >= 6,
  },
  {
    id: 'yards.choose_route',
    label: 'Choose a route through the yard',
    description: 'Two routes, the same distance. One touches eight pages in order and one strides across four hundred.',
    anchor: 'anchor.route_fork',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'yards.buy_tlb_entries',
    label: 'Buy TLB entries',
    description: 'More entries cover more pages. It helps a little and it costs real money.',
    anchor: 'anchor.tlb_console',
    cost: { cycles: 90, blocks: 20 },
    enabledWhen: (run) => run.resources.cycles >= 90 && run.resources.blocks >= 20,
  },
  {
    id: 'yards.vesper_remap',
    label: 'VESPER: remap',
    description: 'Rebuild one page table with optimal locality.',
    anchor: 'anchor.index_board',
    cost: { bandwidth: 8 },
    enabledWhen: (run) => vesperAlive(run) && run.resources.bandwidth >= 8,
  },
  {
    id: 'yards.answer_translation',
    label: 'Answer the translation gate',
    description: 'Give the frame number and the offset. The gate accepts one attempt.',
    anchor: 'anchor.translation_gate',
    cost: {},
    enabledWhen: () => true,
  },
];
```

`yards.buy_tlb_entries` is priced to be affordable and it fails
`obj.allocation_yards.locality_over_hardware` the moment it is taken, because the objective
requires `tlbEntries` unchanged. That is not a gotcha: the `tlb` man page says plainly that
buying entries helps a little and costs real money while improving locality helps a lot and
costs a route choice. The player who reads it does not buy.

VESPER's remap is the strongest single move available in this leg. It rebuilds one page table
with optimal locality, which raises that Program's TLB hit rate for the rest of the leg and
lowers its working set for leg 8. Say the first half in the description and not the second; leg
8 has not happened yet.

---

## Terminal commands

Four commands, copied verbatim from the curriculum map into
`src/legs/allocation_yards/commands.ts`: `free`, `pagetable`, `tlb`, `frag`. The full `manual`
text is in `docs/05-CURRICULUM-MAP.md`, "Leg 7. THE ALLOCATION YARDS". Copy byte for byte; a
test asserts the match against a checked-in fixture.

Load-bearing lines you must not lose in transcription:

- `free`: "A request for 12 contiguous frames fails when the largest free run is 9, regardless
  of whether 200 frames are free in total. The memory exists and it is unusable, because it is
  in the wrong shape."
- `free`: the two-reason block. "Read the reason on the failure event before you spend
  anything." That sentence is `obj.allocation_yards.diagnose_fragmentation` in one line.
- `pagetable`: "The mapping is arbitrary, so a process address space can be contiguous while the
  memory holding it is scattered anywhere. That is the whole trick, and it is why paging makes
  external fragmentation impossible: any free frame fits any page."
- `pagetable`: "Note the cost this table implies. Every memory access now needs a table lookup
  first, which is itself a memory access. Without help, paging doubles the cost of every access.
  See tlb." This sets up the third misconception before it happens.
- `tlb`: "The hit rate is not a property of the hardware. It is a property of your access
  pattern."
- `frag`: "On most sequences first fit and best fit land close together, with first fit faster;
  worst fit does badly, despite the plausible argument that leaving the largest hole must leave
  the most useful hole. It leaves the most holes, which is the opposite of useful. Run it before
  you believe any of this."

### `frag --compare` implementation contract

This is the leg's arbiter and it must be a real replay, not a table lookup.

1. Record every allocation and every free across the leg as an ordered sequence.
2. On `--compare`, run that recorded sequence through a shadow memory manager under each of the
   four strategies, from the yard's opening layout.
3. Print, per strategy: the placement of each request, the failures, total free, largest free
   run, and final external fragmentation.
4. The shadow run must not touch the live frame table or emit into the live event stream. Assert
   over 200 comparisons that the live event log hash is unchanged.
5. On the fixture's four-request prefix, the printed placements must equal `MEM-FIT-1a`,
   `MEM-FIT-1b` and `MEM-FIT-1c` exactly.

Reuse WP-18's shadow-run machinery if its interface fits. If it does not, build the shadow memory
manager inside this leg's owned files and report the interface so leg 8's `belady --compare` can
share it. The two commands are the same idea over different subsystems and the codebase should
have one of them.

---

## Event table

Copied verbatim from `04-NARRATIVE-BIBLE.md` section 8, leg 7. Weights sum to 100.

```ts
export const allocationYardsEvents: readonly RandomEventDef[] = [
  {
    id: 'yards.no_fit',
    weight: 14,
    title: 'No Fit',
    narration: 'The request is for eleven contiguous frames. There are ninety free and the largest run is seven.',
    targets: null, inflicts: 'fragmented',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'yards.best_fit_slivers',
    weight: 12,
    title: 'Slivers',
    narration: 'Best fit has been running here for a long time and every allocation left the smallest possible remainder. The yard is full of holes two frames wide.',
    targets: 'cartographer', inflicts: 'fragmented',
    resourceDelta: { quota: -40 },
    onlyIf: null,
  },
  {
    id: 'yards.buddy_split_tax',
    weight: 11,
    title: 'Rounded Up',
    narration: 'A request for nine frames is served from a sixteen-frame block because that is the smallest power of two that holds it. Seven frames are allocated to nothing.',
    targets: null, inflicts: null,
    resourceDelta: { quota: -55 },
    onlyIf: null,
  },
  {
    id: 'yards.page_table_walk',
    weight: 12,
    title: 'Four-Level Walk',
    narration: 'Every address the convoy resolves takes four memory accesses to translate before it takes one to use. The translation cache is cold and the yard is large.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -55 },
    onlyIf: null,
  },
  {
    id: 'yards.tlb_reach',
    weight: 16,
    title: 'Warm Translation Cache',
    narration: 'The convoy\'s working set fits inside the translation cache for the width of the yard. Hit rate holds at ninety-six percent and the walk cost disappears.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 65 },
    onlyIf: null,
  },
  {
    id: 'yards.compaction_crew',
    weight: 13,
    title: 'Compaction Pass',
    narration: 'A maintenance pass slides every allocation toward the low end of the yard and leaves one run of free space behind it. It takes a long time and it is worth all of it.',
    targets: null, inflicts: null,
    resourceDelta: { quota: 95, cycles: -20 },
    onlyIf: null,
  },
  {
    id: 'yards.slab_yard',
    weight: 12,
    title: 'Slab Yard',
    narration: 'A slab allocator here hands out fixed-size objects from pre-carved caches, so nothing it serves fragments anything. The convoy takes what it can carry.',
    targets: null, inflicts: null,
    resourceDelta: { blocks: 24, quota: 35 },
    onlyIf: null,
  },
  {
    id: 'yards.free_run_found',
    weight: 10,
    title: 'Contiguous Run',
    narration: 'A departing workload releases sixty-four adjacent frames in one operation. VESPER redraws the map before the free list has finished coalescing.',
    targets: 'cartographer', inflicts: null,
    resourceDelta: { quota: 80 },
    onlyIf: null,
  },
];
```

`yards.no_fit` and `yards.free_run_found` must both act on the live frame table. The first
creates a genuine fragmentation failure the player can inspect with `free -f`, and the second
genuinely releases 64 adjacent frames the player can see appear in the yard. An event that
narrates a memory change without making it is the one kind of dishonesty this leg cannot afford,
because the whole leg is about looking at the yard rather than reading a number.

---

## Evaluation

### Survival

The leg is survived when at least one convoy Program is alive at leg end.

**No fit.** A Program that cannot be placed cannot run, and after 30 ticks unplaced it derezzes
with `TerminationReason: 'out_of_memory'`. Before that it acquires `fragmented` (1.5 integrity
per travel tick, fatal after 30 in this leg's instance; the ambient table value of 0.7 per tick
with no fatal clock is the out-of-leg baseline and this leg overrides it).

The remedy is `{ kind: 'set_allocation', to: 'best_fit' }`, or the compaction purchase, or
VESPER's remap.

**The instructive wrong remedy is buying more quota.** It works, once, at high cost, and the
next allocation fails in exactly the same way because the yard is no less fragmented than it
was. The debrief prints the fragmentation figure at the moment of purchase next to the
free-space figure, so the player sees they bought space they already had. Record it as
`kind: 'buy_quota_on_fragmentation'` with `outcome: 'costly'`.

**Worst fit is the second trap**, for players who reason that leaving the largest remaining hole
must be good. `frag --compare` settles it against the recorded sequence.

**The protection failure is separate and it kills nothing here.** Leaving the executable bit set
lets the scripted injection run and plants a modified Program image that resurfaces at the
Arbiter Wall. Record it and move on.

### Objectives

| Objective | Computed from |
|---|---|
| `obj.allocation_yards.strategy_choice` | `MemoryMetrics.externalFragmentation < 0.12` at `evaluate()` **and** zero Programs left unplaced. |
| `obj.allocation_yards.diagnose_fragmentation` | A `free -f` invocation between a `memory.allocation_failed` event and any compaction purchase, **and** no compaction purchased following a failure whose `reason` was `no_space`. Both clauses; the second is what makes it a diagnosis rather than a habit. |
| `obj.allocation_yards.paging_trade` | `MemoryMetrics.externalFragmentation === 0` **and** `internalFragmentation <= 0.5 * pageSize * processCount`. |
| `obj.allocation_yards.translate_address` | The single gated answer, checked against the live page table. **The gate accepts one attempt.** A second attempt is refused rather than scored. |
| `obj.allocation_yards.locality_over_hardware` | `MemoryMetrics.tlbHitRate > 0.85` **and** `KernelConfig.tlbEntries` equals the leg's opening value. |
| `obj.allocation_yards.protection_bits` | The `executable` bit is false on every data page range at the tick of the scripted injection, **and** the injection produced a protection fault rather than an execution. |
| `obj.allocation_yards.page_size_tradeoff` | Every Program's page table holds under 64 entries **and** `internalFragmentation` is under 8 percent of allocated memory, both at the tick the player last committed a page size. |

`page_size_tradeoff` has a genuine solution space and the player has to find it. With the
convoy's page counts (12, 10, 10, 8, 11) and 96 frames, the constraint "under 64 entries" is
loose and the constraint "under 8 percent internal" tightens as the page gets larger. Compute
the admissible page sizes for the leg's actual population, freeze them, and assert that at least
two page sizes satisfy both constraints and at least two fail one each. An objective with a
single correct answer is a quiz and this document says there is no quiz anywhere in the run.

### Debrief card

```ts
{
  headline: /* 'Placed.' or 'There was room and nowhere to put it.' */,
  whatHappened:
    `You ran ${strategyList.join(', then ')}. External fragmentation ended at ` +
    `${(extFrag * 100).toFixed(1)} percent across ${freeRuns} free runs, largest ${largestRun} frames. ` +
    `Internal fragmentation ended at ${(intFrag * 100).toFixed(1)} percent at page size ${pageSize}. ` +
    `TLB hit rate ${(tlbHit * 100).toFixed(0)} percent on ${routeName}.`,
  whyItHappened: /* selected */,
  counterfactual: /* a real frag --compare replay */,
  chapter: { chapter: 9, title: 'Main Memory', sections: ['9.2.3'] },
}
```

`whyItHappened`, selected by what actually occurred:

- **An allocation failed on fragmentation.** "The frames existed and they were in the wrong
  shape. A request for ${n} contiguous frames fails when the largest free run is ${largest},
  whatever the total says."
- **Quota was bought after a fragmentation failure.** "At the moment you bought ${bought}
  frames, ${free} were already free. What you were short of was a run, not a total."
- **Worst fit was used.** "Leaving the largest remaining hole leaves the most holes. Across your
  recorded sequence it produced ${wf} percent external fragmentation against best fit's ${bf}."
- **Paging converted cleanly.** "Any free frame fits any page, so external fragmentation is
  gone. The waste moved inside the last frame of each Program, where it is ${intFrag} percent
  and where a smaller page would shrink it at the cost of ${rows} more index rows per Program."
- **Clean placement.** "Every Program was placed and the yard is in a shape the next request can
  use."

The counterfactual is a **real `frag --compare` replay** of the recorded sequence, never a
template. Report the best strategy's final external fragmentation against the player's:

> "Your recorded sequence under ${best} ends at ${bestFrag} percent external fragmentation
> against your ${actualFrag}."

If the player left the executable bit set, append one line and no more:

> "The data pages are still executable."

That is all. Do not explain what it means, do not name the Arbiter Wall, and do not mark it as a
warning. The fuse is forty minutes long and its payoff is leg 12's, not this leg's.

---

## Acceptance criteria

1. `src/legs/allocation_yards/index.ts` satisfies `Leg` under `tsc --strict`,
   `id === 'allocation_yards'`, `index === 7`.
2. The leg runs headlessly to completion via the smoke-test harness, with no Three.js or DOM
   import reachable from the leg module graph.
3. `enabledSubsystems` deep-equals `['process', 'scheduler', 'memory']`. **`vm` is not enabled.**
   Asserted directly, and asserted indirectly by checking that zero `memory.page_evicted` and
   zero `memory.thrashing` events are emitted across a full run.
4. Inert-field independence: mutating `replacementPolicy`, `thrashingThreshold`, `diskPolicy`,
   `totalCylinders`, `raidLevel`, `fileAllocation`, `journalingEnabled` and `deadlockStrategy`
   leaves the canonical event log hash unchanged over 400 ticks.
5. Every objective can be met by the known-good decision sequence; all seven met in one run.
6. The known-bad sequence produces the intended failure: worst fit held for the whole leg, a
   Program unplaced for 30 ticks, `fragmented` acquired, one derezz with
   `TerminationReason: 'out_of_memory'`.
7. The opening allocation failure carries `reason: 'fragmentation'` with the yard 38 percent
   free, and `free -f` reports 41 free runs with a largest of 9 against a request for 12. All
   four numbers frozen as fixtures.
8. `MEM-FIT-1a`, `MEM-FIT-1b` and `MEM-FIT-1c` reproduce exactly through `frag --compare`,
   including placements, failures, free totals and largest runs.
9. `MEM-BUDDY-1` reproduces: 32 KB block, 11 KB internal fragmentation, free lists holding one
   32 K, one 64 K and one 128 K.
10. `MEM-XLATE-1` and `MEM-XLATE-2` reproduce exactly, and the translation gate's question is
    checked against the live page table rather than a constant.
11. `MEM-TLB-1` and `MEM-TLB-1b` reproduce to two decimal places at every listed hit rate.
12. `MEM-FRAG-1` holds: `externalFragmentation === 0` for every paged configuration the player
    can reach.
13. The paging conversion moves both meters in the same frame: external to exactly 0, internal
    from 0 to a nonzero value. Asserted as a frame-level test on the two adjacent meters.
14. The TLB-disabled segment takes between 1.95x and 2.05x the TLB-enabled time on the same
    route.
15. The two routes have identical distance and identical page count, and produce hit rates 0.92
    and 0.41 with `tlbEntries` unchanged. Distance equality asserted explicitly.
16. Clearing the executable bit makes the scripted injection raise a protection fault. Leaving
    it set plants the image and records the decision with the tick. The bit is enforced in
    WP-05's translation path, asserted by attempting execution directly against the kernel.
17. `frag --compare` never mutates the live frame table or event log, over 200 comparisons.
18. At least two page sizes satisfy `obj.allocation_yards.page_size_tradeoff` and at least two
    fail exactly one of its two clauses.
19. Event table weights sum to exactly 100; all ids unique. `yards.no_fit` and
    `yards.free_run_found` both act on the live frame table.
20. All four terminal command `manual` strings match the curriculum map byte for byte.
21. Draw calls stay under 220 / 450 / 900 at the heaviest frame, which is the fragmentation hero
    shot with 41 holes lit and labelled plus the amber request bar plus both meters in view.
22. The fragmentation hero visual is arithmetically honest: the amber bar's world length is the
    request size, each hole's label is its own size, and the labelled sum exceeds the bar while
    no single hole does.
23. The yard accumulates: fragmentation is not reset between segments, and a run using worst fit
    for the first half ends with measurably worse fragmentation than one that does not, on the
    same seed.

---

## Tests you must write

All under `tests/legs/allocation_yards/`. This directory is owned exclusively by this package.

**`contract.test.ts`**: `Leg` conformance, exact ids, the sixteen-section chapters array, seven
objectives, every `chapter.sections` entry present in `chapters`.

**`config.test.ts`**: `enabledSubsystems` exact; `vm` absent; `totalFrames === 96`;
`tlbEntries === 16`; inert-field independence over 400 ticks; zero `memory.page_evicted` and
zero `memory.thrashing` across a full run.

**`populate.test.ts`**: fourteen spawns (five convoy plus nine yard), five binds, exact page
counts and arrivals, zero resource and sync declarations.

**`fits.test.ts`**: the strategy fixtures.
- `MEM-FIT-1a`, `1b` and `1c` through `frag --compare`: placements, failures, free totals,
  largest runs, all exact.
- `MEM-BUDDY-1` exactly, including the three free lists.
- Across the leg's full recorded sequence, worst fit produces the highest external
  fragmentation of the four. Frozen figures for all four strategies.
- `frag --compare` leaves the live frame table and event log unchanged over 200 comparisons.

**`fragmentation.test.ts`**: the opening failure.
- `memory.allocation_failed { reason: 'fragmentation' }` at the frozen tick with the yard 38
  percent free.
- `free -f` reports 41 runs, largest 9, request 12.
- A genuine exhaustion produces `reason: 'no_space'` and compaction after it fails the
  diagnosis objective.
- The yard accumulates across segments: two runs on the same seed, one using worst fit for the
  first half, end at different fragmentation.

**`paging.test.ts`**: the conversion.
- `MEM-FRAG-1`: `externalFragmentation === 0` for every reachable paged configuration.
- Both meters move in the same frame; external to exactly 0, internal from 0 to nonzero.
- `internalFragmentation <= 0.5 * pageSize * processCount` at the leg's population.
- The page size dial moves internal fragmentation and index board row count in opposite
  directions, asserted at every reachable page size.
- The admissible page sizes for `obj.allocation_yards.page_size_tradeoff`: at least two pass and
  at least two fail exactly one clause.

**`translate.test.ts`**: `MEM-XLATE-1` and `MEM-XLATE-2` exactly. The gate's question is built
from the live page table. A second attempt at the gate is refused rather than scored.

**`tlb.test.ts`**: `MEM-TLB-1` and `MEM-TLB-1b` to two decimals. The disabled-TLB segment takes
1.95x to 2.05x. The two routes: identical distance, identical page count, hit rates 0.92 and
0.41. Buying entries fails the objective while raising the hit rate.

**`protection.test.ts`**: the fuse.
- The executable bit is enforced in the translation path: an execute on a non-executable page
  faults when attempted directly against the kernel, with no leg code involved.
- Bit cleared: the injection faults, nothing planted, objective met.
- Bit left set: the injection runs, the image is planted, the decision is recorded with
  `kind: 'executable_bit'`, `choice: 'left_set'` and the correct tick, `outcome: 'pending'`.
- The debrief appends exactly one line and names neither the Arbiter Wall nor the consequence.

**`evaluate.test.ts`**: each of the seven objectives, met and not met. In particular:
- `diagnose_fragmentation` fails a player who compacts after a `no_space` failure even if they
  ran `free -f` first.
- `locality_over_hardware` fails a player at 0.93 hit rate who bought TLB entries.
- `translate_address` scores exactly one attempt.

**`golden.test.ts`**: the golden headless playthrough.
- Fixture: `seed: 0x4b54524c`, `discClass: 'shell'`, `difficulty: 'operator'`, steady pace,
  standard rations, entering with the leg 6 golden closing ledger.
- Known-good sequence, in order:
  1. On the opening `ENOMEM`, `free -f`, reading 41 runs and a largest of 9.
  2. `frag --compare`, reading all four strategies against the recorded sequence.
  3. `yards.set_strategy` to `best_fit`.
  4. `yards.compact` once, priced on the live occupied run count.
  5. `yards.convert_to_paging`, watching both meters.
  6. `yards.set_page_size` to a value satisfying both clauses.
  7. `pagetable --translate` on the worked example, then `yards.answer_translation` correctly on
     the first attempt.
  8. `yards.set_protection_bits`, clearing `executable` on every data page range.
  9. `yards.choose_route` contiguous. No TLB purchase.
  10. `yards.vesper_remap` on the Program with the worst hit rate.
- Assert: all seven objectives met, zero casualties, external fragmentation under 12 percent,
  external exactly 0 after conversion, TLB hit rate above 0.85 with entries unchanged, the
  injection faulted, eight codex entries added, canonical event log hash matches the
  checked-in golden file, stable across two runs and across a snapshot-restore at the midpoint.
- Assert the closing ledger, because leg 8 has no depot and this is what the convoy carries in.

**`badpath.test.ts`**: the known-bad sequence.
- Worst fit for the whole leg, buy quota on the first fragmentation failure, never convert to
  paging, take the scattered route, leave the executable bit set.
- Assert: highest external fragmentation of the four strategies, one Program unplaced for 30
  ticks acquiring `fragmented` and derezzing with `out_of_memory`, the quota purchase recorded
  `costly` with the fragmentation and free figures printed side by side, TLB hit rate 0.41, the
  image planted and recorded, counterfactual naming the best strategy, and `survived === true`.

**`manuals.test.ts`**: four manual strings against the curriculum map fixture; every
`See also:` topic resolves; `pagetable`'s three worked examples are arithmetically correct as
printed.

**`stage.test.ts`** (headless renderer rig)
- Every anchor id resolves; every `InteractionDef.anchor` resolves.
- Draw calls under 220 / 450 / 900 at the heaviest frame.
- Both fragmentation meters are within one orthographic lock and are physically adjacent.
- The index board's row count is countable up to 64 at low tier.
- The hero visual arithmetic: bar length equals request size, labelled hole sum exceeds the bar,
  no single hole reaches it.

---

## Out of scope

- Do not touch any other leg. Do not import from `src/legs/*` other than your own directory.
- Do not modify `src/game/types.ts` or `src/kernel/types.ts`.
- Do not modify anything under `src/kernel`, `src/render`, `src/world`, `src/terminal`,
  `src/ui`, `src/audio`, `src/design`, `src/platform` or `src/app`. If an allocator, the TLB or
  the translation path is wrong, file it against WP-05 and stop.
- **Do not enable `vm`.** No demand paging, no replacement policy, no eviction, no working set,
  no thrashing. Every mapped page is resident from allocation. Leg 8 owns all of it and cannot
  be explained without the valid bit this leg establishes.
- Do not enable `security`. The protection bits are enforced by the memory management unit in
  WP-05, and the access matrix belongs to leg 12.
- Do not explain what the planted image will do. One line in the debrief, no warning, no badge.
- Do not check the executable bit in leg code. The hardware check is the entire point.
- Do not reset fragmentation between segments.
- Do not make worst fit competitive to be fair to it.
- Do not add a second attempt at the translation gate.
- Do not add a depot to leg 8 to compensate for anything you find here. Adjust this leg's depot.

### Files this package owns exclusively

```
src/legs/allocation_yards/index.ts
src/legs/allocation_yards/chapters.ts
src/legs/allocation_yards/objectives.ts
src/legs/allocation_yards/config.ts
src/legs/allocation_yards/populate.ts
src/legs/allocation_yards/interactions.ts
src/legs/allocation_yards/commands.ts
src/legs/allocation_yards/events.ts
src/legs/allocation_yards/evaluate.ts
src/legs/allocation_yards/yard.ts
src/legs/allocation_yards/routes.ts
src/legs/allocation_yards/protection.ts
src/legs/allocation_yards/fixtures.ts
src/legs/allocation_yards/stage.ts
src/legs/allocation_yards/copy.ts
tests/legs/allocation_yards/**
```

---

## Report back

1. The commit or branch, and the full `tests/legs/allocation_yards/` output.
2. The golden playthrough hash and the file it is checked in at.
3. The frozen fixtures, as a table: the opening failure's tick, free percentage, run count,
   largest run and request size; final external fragmentation under all four strategies across
   the leg's full recorded sequence; the two routes' hit rates; the admissible page sizes.
4. Every `MEM-*` fixture result against its expected value.
5. **The closing ledger the golden run carries into leg 8**, in all four resources, at each of
   the three disc classes. Leg 8 has no depot and this number is the balancing lever for the
   whole second half of the run. State it plainly and flag it if it looks thin.
6. Draw calls at each of the three quality tiers at the heaviest frame, and confirmation that
   both fragmentation meters sit in one orthographic lock.
7. The shape of the `executable_bit` decision record, agreed with WP-17, and confirmation that
   leg 12 can read it from `RunState.decisions`.
8. Where the shadow memory manager behind `frag --compare` lives, and whether leg 8's
   `belady --compare` can share it.
9. Any place where the curriculum map, the narrative bible, the visual bible and the sim spec
   disagreed, what you did, and which document you followed.
10. Confirmation that no file outside the owned list was created or modified, and that `vm` is
    not enabled anywhere in this leg.

# WP-L13: The Portal

Leg id `the_portal`, index 13. Subtitle: *It admits a machine, not a Program.*

**Legs are independent and may be built concurrently.** This package touches no other leg,
imports from no other leg, and shares no source file with any other leg.

This is the last thing the player experiences. Eight new codex entries, roughly 35 minutes, high
load, and the load is recall rather than acquisition: every control the player has used across
thirteen legs appears twice, once for the host and once for the guest, and the two settings
interact rather than compose. The intended final state is a player who discovers that they now
understand two schedulers at once.

It also carries the reveal the narrative bible has been planting since the firmware sign-on. The
Substrate is a guest. Chapter 18 is not a plot twist attached to an operating systems course; it
is the course arriving at the observation it was always heading for.

There is no depot on this leg. The last depot was the Arbiter Wall.

---

## Objective

A module at `src/legs/the_portal/` implementing the frozen `Leg` interface, playable end to end
and ending the run. The Portal is a gate the convoy cannot walk through. It admits a machine. The
convoy has spent thirteen legs being Programs on a machine and now has to become the machine,
which means building one and travelling inside it.

The leg has four jobs and they are separable:

1. **Teach chapter 18.** Hypervisors, trap and emulate, nested scheduling, double paging,
   containers and their isolation boundary, live migration.
2. **Deliver the reveal.** Three staged moments, each of them a measurement the player takes
   themselves, followed by the world admitting what it is.
3. **Run the final scored crossing**, with `ScoreBreakdown` live on the gate face.
4. **Hand off to the end-of-run report** in a state that report can consume without inference.

Job 4 is the one most likely to be skimped and it is the one that makes the other thirteen
packages worth having built. Read The handoff section before you plan the work.

---

## The reveal, and how it is staged

The narrative bible plants one line per leg, thirteen of them, none underlined and none
repeated. This leg pays all thirteen. The rule that governs the payment: **the player performs
every measurement themselves, with commands they already have or with one command this leg
introduces, and the world states the conclusion only after the player has the evidence.** There
is no cutscene, no monologue, and no character explaining it to another character.

### The thirteen plants, and where each is answered

| Leg | Plant | Answered by |
|---|---|---|
| 0 | The firmware sign-on prints a vendor string nobody recognises and a machine model with a version suffix. | `hyper --type` on the host returns a type. A machine model with a version suffix is a virtual machine model. |
| 1 | A milestone lists the Substrate's own PID. It is not 1. | The Substrate is a process on something. `guest --list` from the host side shows it with that pid. |
| 2 | Core count is a power of two and never changes, on any run, at any difficulty. | It is an allocation, not a discovery. `hyper --type` shows the partition. |
| 3 | An arbiter freezes mid-stride for eleven ticks, then continues from exactly where it stopped. | Preemption by the host. Moment A. |
| 4 | A lock's wait queue contains one entry the convoy cannot resolve to any process in the Substrate. | The host's own process, waiting on a Substrate primitive through the paravirtual channel. |
| 5 | The Cistern's buffer has a producer nobody has ever seen enter the Cistern. | The same channel, on the other side. |
| 6 | `wfg` draws an edge that terminates off the graph, at a node with no label. | The unlabelled node is the host. |
| 7 | Physical frame numbers exceed the reported frame count. VESPER remarks on it once. | Guest physical is not host physical. Moment B. |
| 8 | Pages fault in with contents already warm, as though something else had touched them first. | The host's own page cache under the guest's backing store. |
| 9 | The platter's outermost cylinder reads as cylinder zero of a larger device. | A virtual disk is a file on a real one. |
| 10 | An interrupt arrives from a device id that is not in the device table. | The hypervisor's completion interrupt on a device the guest was never told about. |
| 11 | The journal contains committed transactions from before the Substrate's own boot tick. | The volume is older than this boot. It was checkpointed and resumed. |
| 12 | The access matrix has a column for a domain of ring 0 that no arbiter belongs to. | `domain:host`. Moment C. |
| 13 | The reveal. | Trap and emulate is the mechanic and the ending at the same time. |

Every one of those thirteen lines appears in `codex.virtualization`, each cross-linked to the leg
it was planted in, and the codex entry is unlocked at Moment C. That entry is the payoff and it
is the only place the thirteen appear together. Do not list them in dialogue.

### The three moments

**Moment A, at tick 120: the trap count.** The player runs `hyper --traps` for the first time,
against the Substrate rather than against a guest they built, because they have not built one
yet. It returns a non-zero count for instruction classes the convoy has executed all game, on a
machine that was supposed to be the bottom. The trap handler's address resolves to nothing in the
Substrate's own kernel structure.

The convoy says nothing. The number is on screen and the command is one the player just learned
from its own man page, which explains trap and emulate in its first paragraph. The inference is
available and it is not stated.

**Moment B, at tick 420: the shadow.** The player runs `hyper --shadow`, which draws both
translation layers as two stacked grids in the world. The lower grid is guest virtual to guest
physical and the player has read that kind of grid for two legs. The upper grid is guest physical
to host physical, and it maps the Substrate's own physical frames onto something else.

VESPER has one line here and it is the callback to leg 7's plant, which she is on record as
having stopped raising:

> "Physical frame numbers run higher than the frame count. I said so at the Yards. This is why."

That is her whole contribution to the reveal. She states the conclusion without the working,
because the working never once changed anyone's mind.

**Moment C, at tick 900: the column.** The player runs `access --matrix`, which is leg 12's
command and is still registered. `domain:host` is there, ring 0, held by no process, with
`control` on `domain:kernel`. It was there at the Arbiter Wall and it refused every edit with
`EPERM` and no elaboration.

Here it has an occupant.

That is the reveal. `codex.virtualization` unlocks, carrying all thirteen plants with their legs
and their ticks. The gate face resolves the Portal's address, which any cartographer can read off
a milestone and which is outside the Substrate's own address space, into an address in the host's
space. The Portal opens onto ring 0 of the machine that has been hosting the whole journey.

### What the world does after Moment C

Nothing changes visually. The environment does not shift, the palette does not turn, no structure
is revealed, and the horizon stays where it was. The Substrate looked like this all along and it
is exactly as real as it was an hour ago. **Do not add a reveal effect.** The visual bible gives
this leg its environment as nested duplicates of every earlier form at quarter scale inside a
containing shell, and that shell is the guest the player builds in the next segment, not the
reveal.

What changes is that the shell's surface is now legible as the same kind of boundary the
Substrate itself sits behind, and the player can see both because they built the inner one.

---

## Prerequisites

**Engine work packages that must be complete and green on the shared branch:**

| Package | Why this leg needs it |
|---|---|
| WP-01 | `Rng`, event bus, canonical serialiser. The guest kernel's seed derives from the host's by a fixed function. |
| WP-02 | Process table, PCB, kernel step order, and **`Kernel` being independently constructible and steppable**, which is what makes the guest possible without a contract change. |
| WP-03, WP-04 | Scheduler policies, in both kernels. Nested scheduling is two real schedulers. |
| WP-05, WP-06 | Memory and virtual memory, in both kernels. Double paging is two real replacement policies over one page. |
| WP-09 | Devices, for the emulated against paravirtualised choice. |
| WP-10 | Rings, for trap and emulate, and the security half for the container isolation boundary. |
| **WP-11** | **The whole of it, and `snapshot()` and `restore()` in particular.** Live migration is `guestKernel.snapshot()` serialised across a link and restored into a second instance, and the migration is correct only if restore is exact. |
| WP-12 | Renderer backend, post chain, design tokens, draw call budget. The Portal aperture is the brightest structure in the game and the HDR path has to carry it. |
| WP-13 | Focus camera and the diegetic structure base classes, including quarter-scale instancing of earlier legs' forms. |
| WP-14 | World event router, effect pooling, derezz. The container escape is a multi-casualty single event and the derezz batching has to handle it. |
| WP-15 | The terminal. |
| **WP-17** | **HUD, codex, save and load, scoring, the profile, and the end-of-run report.** This leg fills `ScoreBreakdown` and hands off; WP-17 renders the five panels. Coordinate the handoff contract with that package before you build anything else. |
| **WP-18** | **The counterfactual replay worker.** Panel 5 is the last thing the player is offered and it is WP-18's. This leg supplies the decision scan input and nothing else. |

**Kernel subsystems that must be working:** `process`, `scheduler`, `memory`, `vm`, `io`,
`security`.

The four not enabled are `sync`, `deadlock`, `storage` and `fs`. That is deliberate: this leg
re-presents the subsystems that have a guest-and-host duplication, and locks, wait-for graphs,
head position and inodes have no second layer here. A finale that enabled all ten would be
demonstrating breadth rather than teaching the doubling.

WP-11 must additionally provide, exactly:

- `Kernel` constructible from a `KernelConfig` alone, with no global state and no singleton, so
  a second instance can exist in the same process.
- `snapshot()` returning a structurally cloneable `KernelSnapshot` with no functions in it, and
  `restore()` producing a kernel whose next 1,000 ticks are byte-identical to the original's,
  per fixture `DET-D2`.
- A tick budget on `step()`, so the leg can advance the guest by a chosen number of ticks inside
  one host tick.

Fixtures `DET-D1` through `DET-D4`, `VM-LRU-1`, `VM-CLOCK-1`, `VM-WS-1`, `SCHED-RR-1` and
`SEC-RING-1` must all pass before this leg starts, in both kernels.

---

## Required reading

- `docs/05-CURRICULUM-MAP.md`, "Leg 13. THE PORTAL" in full; section B, "Course outcome coverage
  matrix", because the end-of-run report's panel 4 is generated against it; section E,
  "Assessment philosophy", in full, and 15.4 of the narrative bible alongside it.
- `docs/02-KERNEL-SIM-SPEC.md`, section 1 (the determinism contract) and section 1.4 (the
  determinism test), because the guest is a second kernel and every determinism rule applies to
  it twice; section 2 (kernel step order); section 7 (virtual memory) for the guest's own
  replacement; section 13.1 (rings).
- `docs/04-NARRATIVE-BIBLE.md`, **section 1.4 (the twist) and section 1.5 (the foreshadowing
  schedule), both in full**; section 8 leg 13 event table; section 9 epitaphs for `starvation`,
  `thrashing_collapse` and `protection_fault`; **section 15 in full** (progression, score, the
  end-of-run report, and what is offered next); section 5.3 for the leg's length and the absence
  of a depot.
- `docs/03-VISUAL-BIBLE.md`, section 10 "Leg 13, The Portal"; section 13 (quality tiers); section
  4.5 (bloom that reads cinematic rather than washed out), because the aperture is the brightest
  thing in the game and it must not blow out the frame.

---

## Frozen contracts

These types are frozen. You may not edit, extend, narrow or re-declare any of them.
A leg that appears to need a contract change stops and escalates, because every other
leg in flight depends on this file. Copy them into your leg only by importing:

```ts
import type { Leg, LegSetupContext, LegStage, LegOutcome, ScoreBreakdown /* ... */ } from '@game/types';
import type { KernelConfig, SubsystemId, KernelSnapshot, ProtectionRing /* ... */ } from '@kernel/types';
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

`kernelConfig` returns **one** `KernelConfig`, and that one is the host's. The guest's config is
the leg's own state and is not a `Leg` interface concern. See The guest section.

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

`spawn` and `bind` operate on the host kernel. The guest's processes are spawned into the guest
kernel by the leg, not through this context.

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

`LegEvaluationContext.kernelSnapshot` is the **host's** snapshot. The guest's snapshot is the
leg's own and reaches `evaluate` through the leg's module state.

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

**`RunState.status` and `RunState.score` are the two fields this leg is responsible for leaving
correct.** Every other leg leaves `status` at `'in_progress'`. This one sets it to `'complete'`
or `'failed'`, through WP-17's interface, and it is the only leg that does.

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

`KernelSnapshot`, which the migration serialises:

```ts
/** Serialisable, structurally cloneable, and sufficient to resume a run exactly. */
export interface KernelSnapshot {
  readonly version: 1;
  readonly tick: Tick;
  readonly seq: number;
  readonly config: KernelConfig;
  readonly rng: readonly RngState[];
  readonly processes: readonly ProcessControlBlock[];
  readonly frames: readonly Frame[];
  readonly pageTables: readonly (readonly [AddressSpaceId, readonly PageTableEntry[]])[];
  readonly syncPrimitives: readonly SyncPrimitive[];
  readonly resources: readonly ResourceType[];
  readonly diskQueue: readonly DiskRequest[];
  readonly diskHead: DiskHead;
  readonly devices: readonly Device[];
  readonly inodes: readonly Inode[];
  readonly journal: readonly JournalEntry[];
  readonly domains: readonly ProtectionDomain[];
  readonly metrics: { readonly scheduling: SchedulingMetrics; readonly memory: MemoryMetrics };
}
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
  { chapter: 18, title: 'Virtual Machines',
    sections: ['18.1', '18.3', '18.4.1', '18.4.2', '18.4.3',
               '18.5.1', '18.5.2', '18.5.3', '18.5.4', '18.5.5', '18.5.7', '18.5.8',
               '18.6.1', '18.6.2', '18.6.3', '18.6.4', '18.6.5'] },
];
```

One chapter, seventeen sections. 18.2 (history) and 18.6.6 onwards are out of scope and are not
cited anywhere. 18.5.6 is skipped deliberately; the section list above is the shipped list and
must not be extended to fill the gap.

### Learning objectives

```ts
export const objectives: readonly LearningObjective[] = [
  {
    id: 'obj.the_portal.trap_and_emulate',
    statement: 'Runs the guest in ring 3 so its privileged instructions trap to the hypervisor, and finishes the crossing with every privileged instruction accounted for in hyper --traps.',
    chapter: { chapter: 18, title: 'Virtual Machines', sections: ['18.4.1', '18.4.3'] },
    assessedBy: 'terminal_command',
  },
  {
    id: 'obj.the_portal.hypervisor_type',
    statement: 'Chooses a type 1 hypervisor for the bare Substrate segment and a container for the segment that shares the host kernel, justifying the container by the absence of any distinct guest kernel requirement.',
    chapter: { chapter: 18, title: 'Virtual Machines', sections: ['18.5.2', '18.5.3', '18.5.4', '18.5.8'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.the_portal.nested_scheduling',
    statement: 'Sets guest and host quanta so no guest Program effective quantum falls below two ticks, and the guest records zero fatal starvation events.',
    chapter: { chapter: 18, title: 'Virtual Machines', sections: ['18.6.1'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.the_portal.avoid_double_paging',
    statement: 'Reclaims frames from the over-provisioned guest with the balloon rather than by host-level paging, holding double-paging events at zero.',
    chapter: { chapter: 18, title: 'Virtual Machines', sections: ['18.6.2'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.the_portal.container_isolation_limit',
    statement: 'Declines to place the untrusted Program in a container, on the grounds that a container shares the host kernel and the threat model includes kernel compromise.',
    chapter: { chapter: 18, title: 'Virtual Machines', sections: ['18.5.8'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.the_portal.live_migration',
    statement: 'Migrates the running convoy to the second host with downtime under five ticks, by pre-copying dirty pages until the dirty rate falls below the link rate.',
    chapter: { chapter: 18, title: 'Virtual Machines', sections: ['18.6.5'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.the_portal.full_stack_run',
    statement: 'Brings at least three Programs through the Portal with no unresolved afflictions and a positive value in all four scored components.',
    chapter: { chapter: 18, title: 'Virtual Machines', sections: ['18.3'] },
    assessedBy: 'survival',
  },
];
```

`obj.the_portal.full_stack_run` is the run's last objective and the only one in the game whose
assessment reads every field of `ScoreBreakdown`. "All four scored components" means `survivors`,
`throughput`, `efficiency` and `correctness`, each strictly positive. `conceptsMastered` and
`classMultiplier` are not conditions, because `conceptsMastered` is a function of the objectives
themselves and `classMultiplier` is a constant of the disc class.

There are 42 objectives across fourteen legs, per the narrative bible's scoring formula. These
seven are numbers 36 through 42.

### Codex entries this leg adds to `codexUnlocked`

`codex.virtualization`, `codex.trap_and_emulate`, `codex.binary_translation`,
`codex.hypervisor_types`, `codex.containers`, `codex.nested_scheduling`, `codex.double_paging`,
`codex.live_migration`.

| Entry | Added when |
|---|---|
| `codex.virtualization` | **Moment C.** It carries all thirteen foreshadowing plants and it is the reveal's payload. |
| `codex.trap_and_emulate` | First `hyper --traps` invocation, which is Moment A. |
| `codex.binary_translation` | The guest is run at ring 0 and the first attempt collapses, which is the case trap and emulate cannot cover. |
| `codex.hypervisor_types` | First `hyper --type` invocation. |
| `codex.containers` | The container query returns the host's kernel version. |
| `codex.nested_scheduling` | First `guest --stats` invocation showing an effective quantum below the guest quantum. |
| `codex.double_paging` | The first double-paging event, or the first balloon reclaim. |
| `codex.live_migration` | First `migrate` invocation. |

`codex.virtualization` is the only codex entry in the game that cross-links to thirteen others.
Register all thirteen back-links here, one per plant, each naming the leg and the tick the plant
appeared on this run. That per-run tick is what makes the entry the player's own trace rather
than a lore page, and it is why the plants must be recorded as they fire rather than reconstructed
at the end.

`codex.trap_and_emulate` cross-links back to `codex.protection_rings` from the Arbiter Wall and
to `codex.dual_mode` and `codex.trap` from the Boot Sector. `codex.nested_scheduling` cross-links
back to `codex.round_robin` and `codex.quantum` from Quantum Pass. `codex.double_paging`
cross-links back to `codex.page_replacement` and `codex.thrashing` from the Drowned Reach.
Register all seven back-links.

### Misconceptions this leg must break

**"A virtual machine is a sandboxed process."** Students collapse virtualization into process
isolation, which makes the guest kernel incomprehensible. The break is `hyper --shadow`,
which draws both translation layers as two stacked grids in the world: guest virtual to guest
physical in the guest's own page tables, and guest physical to host physical in the
hypervisor's. The player has spent two legs reading page tables and can read these. A
sandboxed process has one translation and no page tables of its own. The guest has both, and
it schedules processes, and it handles its own faults.

Build requirement: the guest must genuinely schedule processes and genuinely handle its own
faults, in a second `Kernel` instance, and the player must be able to see it doing so through
`guest --stats`. A guest that is a set of numbers on the leg's side is the misconception rather
than the break. The two stacked grids are two real page table sets from two real kernels.

**"Containers are lightweight virtual machines, so they give the same isolation faster."**
This is the most consequential wrong belief in current practice and it is worth the leg's
last scripted event. The break is a query: from inside the container, the player asks for the
kernel version and receives the host's, exactly, because it is the host's. Then the untrusted
Program placed in a container exploits a kernel path and every other container on the host is
compromised in the same tick. The `hyper` man page states the boundary in advance and the leg
lets the player test it, once, expensively.

Build requirement: the kernel version query returns the host's string **byte-identically**, and
the test asserts string equality rather than similarity. The escape is a single tick and it is
the only multi-casualty single event in the game, so WP-14's derezz batching has to handle
simultaneous derezz of up to five Programs at every quality tier, and the concurrent-derezz caps
in the visual bible's tier table are 2 at low, which is below five. Coordinate with WP-14: the
escape must degrade to a staged batch at low quality **without** implying that the compromises
happened at different times. State how you did it.

**"Virtualization is a performance tax you pay for isolation, so a bare machine is always
faster."** True per guest and false per host, and the difference is the reason the technology
exists. The break is the consolidation segment: six guests, each idle 80 percent of the time,
running on one host, complete the aggregate workload in fewer total cycles than six separate
hosts each idle 80 percent of the time. The `ScoreBreakdown.efficiency` component is computed
across the whole configuration rather than per guest, so the player sees the consolidated
figure beat the separated one on the gate face as the crossing runs.

Build requirement: both configurations run, both are measured, and the comparison is on the gate
face while the crossing is in progress rather than in the debrief. See The consolidation segment
for the frozen numbers.

---

## Kernel configuration

This is the **host's** configuration and it is what `kernelConfig` returns.

```ts
export function kernelConfig(run: RunState): KernelConfig {
  return {
    seed: run.seed,
    scheduler: 'rr',                       // the host schedules the guest as one entity among several
    schedulerParams: {
      quantum: hostQuantumForPace(run.policy.pace),
      agingInterval: 0,                    // starvation here is nested, and aging would mask it
      starvationThreshold: 120,
      starvationFatalThreshold: 300,
      preemptive: true,
    },
    totalFrames: 256,                      // LIVE: the host's frame supply, which the guest draws from
    pageSize: 4096,                        // LIVE
    replacementPolicy: 'lru',              // LIVE: the host's own replacement, which double paging needs
    allocationStrategy: 'first_fit',       // LIVE BUT FROZEN
    tlbEntries: 16,                        // LIVE BUT FROZEN
    diskPolicy: 'clook',                   // inert: 'storage' is not enabled
    totalCylinders: 200,                   // inert
    raidLevel: null,                       // inert
    fileAllocation: 'extent',              // inert: 'fs' is not enabled
    journalingEnabled: false,              // inert
    deadlockStrategy: 'ignore',            // inert: 'deadlock' is not enabled
    thrashingThreshold: 200,               // LIVE: the host's threshold, distinct from the guest's
    enabledSubsystems: ['process', 'scheduler', 'memory', 'vm', 'io', 'security'],
  };
}
```

`agingInterval: 0` is load-bearing here in a way it is not on the three legs before it. The
nested scheduling failure is guest Programs starving while the guest kernel reports them as
scheduled normally, and host-side aging would raise their priority and blur the failure into a
scheduling problem the player already knows how to fix. The failure has to stay a nesting
failure.

`thrashingThreshold` is live on the host and the guest has its own, set independently. The double
paging failure is both crossing their thresholds from the same page.

### The guest, and why it needs no contract change

**The guest is a second `Kernel` instance**, constructed by the leg from its own `KernelConfig`,
held in the leg's module state, and stepped by the leg. Nothing in the frozen contracts forbids
this and nothing in them provides for it. It works because `Kernel` is constructible from a
config alone, has no global state and no singleton, and `KernelSnapshot` is structurally
cloneable. Confirm all three with WP-11 before you build; if any of them is false, it is a
defect in WP-11 rather than a reason to change a contract.

The rules, and every one of them is a determinism rule:

**The guest's seed is derived from the host's by a fixed function**, stated once and frozen:

```
guestSeed = (hostSeed ^ 0x50525450) >>> 0
```

Not drawn from the host's RNG, not from a stream, not from the tick. A derived constant, so that
two runs with the same host seed have byte-identical guests.

**The guest is stepped only from the leg's own update path**, never from the host's step order,
and always by an integer number of ticks. The number is `floor(hostQuantum * guestShare)` per host
round, computed as an integer, never accumulated as a float.

**The guest's events are not injected into the host's event stream.** The frozen `KernelEvent`
union has no guest variant and you may not add one. The leg keeps the guest's stream in its own
state, exposes it through `guest --stats` and through the stage, and reads it in `evaluate`. The
host's canonical event log hash therefore covers the host only, and the leg publishes a second
hash for the guest's log. Both are asserted in the golden test.

**The guest's snapshot participates in save and load.** A player who saves mid-Portal and reloads
must resume the guest exactly. The guest snapshot goes into the save through WP-17's per-leg
opaque state slot. Agree that slot with WP-17; do not add a field to `KernelSnapshot`.

**The guest's config**, at leg open, before the player touches anything:

```ts
export const guestOpeningConfig: KernelConfig = {
  seed: 0,                                 // replaced by guestSeed at construction
  scheduler: 'rr',
  schedulerParams: {
    quantum: 4,                            // PLAYER-SET at the guest bench
    agingInterval: 0,
    starvationThreshold: 60,
    starvationFatalThreshold: 150,
    preemptive: true,
  },
  totalFrames: 96,                         // PLAYER-SET: host frames allocated to the guest
  pageSize: 4096,
  replacementPolicy: 'clock',              // the guest's own, distinct from the host's lru
  allocationStrategy: 'first_fit',
  tlbEntries: 16,
  diskPolicy: 'clook',
  totalCylinders: 200,
  raidLevel: null,
  fileAllocation: 'extent',
  journalingEnabled: false,
  deadlockStrategy: 'ignore',
  thrashingThreshold: 140,                 // distinct from the host's 200
  enabledSubsystems: ['process', 'scheduler', 'memory', 'vm', 'io'],
};
```

The guest does not enable `security`. It has no wall and no matrix, and its ring is set by the
hypervisor from outside rather than by anything inside it, which is the whole of trap and
emulate.

---

## Population

```ts
export function populate(ctx: LegSetupContext): void {
  const roster: readonly [ConvoyMemberId, string, number, number, number, number][] = [
    // member,      name,      priority, burst, service, pages
    ['lumen',   'LUMEN',   2, 6, 58, 14],
    ['sable',   'SABLE',   2, 5, 52, 12],
    ['orrery',  'ORRERY',  3, 5, 52, 12],
    ['kestrel', 'KESTREL', 3, 4, 46, 10],
    ['vesper',  'VESPER',  3, 5, 52, 12],   // her line is the whole of Moment B
  ];
  roster.forEach(([member, name, priority, burst, service, pages], i) => {
    const pid = ctx.spawn({ name, priority, burst, service, arrival: i, pages });
    ctx.bind(member, pid);
  });

  // The host's other schedulable entities. The guest is a sixth, and the guest's share of the
  // host is 1 / (these plus one), which is the number the effective quantum is computed from.
  for (let i = 0; i < 3; i++) {
    ctx.spawn({ name: `portal.host_worker_${i}`, priority: 4, burst: 3, service: 900, arrival: 20 + i * 6, pages: 8 });
  }

  // The untrusted Program. It is the container decision's subject and it is not a convoy member.
  ctx.spawn({ name: 'portal.untrusted', priority: 5, burst: 2, service: 700, arrival: 1200, pages: 6 });
}
```

No `declareResource` and no `declareSync`. All nine critical section crossings are behind the
convoy: three at the Narrows, two at the Cistern, two at the Gridlock, one at the Archive and
one at the Arbiter Wall. **Do not add a tenth.** The end-of-run report's panel 4 counts crossings
by option across the whole run and a crossing here would land after the count the player is about
to read.

The guest's own processes are spawned into the guest kernel by the leg:

```ts
// Six guest Programs. Their names deliberately mirror the convoy's, because the guest is a
// quarter-scale copy of a machine the player has already run.
export const guestRoster = [
  { name: 'guest.compile',  priority: 2, burst: 5, service: 400, arrival: 0,  pages: 12 },
  { name: 'guest.index',    priority: 3, burst: 4, service: 380, arrival: 2,  pages: 10 },
  { name: 'guest.relay',    priority: 3, burst: 3, service: 360, arrival: 4,  pages: 10 },
  { name: 'guest.record',   priority: 3, burst: 4, service: 380, arrival: 6,  pages: 11 },
  { name: 'guest.chart',    priority: 4, burst: 3, service: 340, arrival: 8,  pages: 9 },
  { name: 'guest.sweep',    priority: 4, burst: 3, service: 340, arrival: 10, pages: 9 },
] as const;
```

Total guest pages: 61. Guest frames at open: 96. That over-provision is what the balloon
reclaims.

### Nested scheduling, exactly

The host runs **five** schedulable entities: three `portal.host_worker_*`, the convoy's own work
as one entity, and the guest as one entity. The guest's share of the host is therefore **0.2**
under round robin with equal quanta.

```
effectiveQuantum = hostQuantum * guestShare
```

That is the curriculum map's assessment formula, verbatim, and the objective requires
`effectiveQuantum >= 2`.

| Host quantum | Guest share | Effective quantum | Guest quantum | Verdict |
|---|---|---|---|---|
| 4 | 0.2 | **0.8** | 4 | fails. This is the opening configuration and the scripted collapse. |
| 8 | 0.2 | 1.6 | 4 | fails, and it looks like it should work, which is the trap. |
| 10 | 0.2 | **2.0** | 2 | passes, exactly at the boundary. |
| 16 | 0.2 | 3.2 | 3 | passes. |
| 20 | 0.2 | 4.0 | 4 | passes, and it is the known-good setting. |
| 20 | 0.5 | 10.0 | 8 | passes. Reachable by shutting down two host workers, which costs throughput. |

**The second relation, which the objective does not state and the leg must teach.** A guest
Program's own quantum accrues only while the guest is running, so a guest quantum larger than
the effective quantum means the host preempts the guest mid-guest-quantum and the guest kernel
does not know it happened. The rule:

```
guestQuantum <= effectiveQuantum
```

Set `hostQuantum: 20` and `guestQuantum: 4` and every guest Program completes its quantum inside
one host slice. Set `hostQuantum: 20` and `guestQuantum: 8` and half of every guest quantum is
served in the following host round, which the guest reports as a normal completion. `guest
--stats` shows the difference as a gap between scheduled quanta and served quanta, and that gap
is the number the player watches.

**The scripted collapse**, at ticks 60 through 200, on the opening configuration of host 4 and
guest 4. Effective quantum 0.8 means a guest Program gets at most one tick of real work per host
slice after the guest's own switching overhead. Guest Programs cross `starvationThreshold` 60 by
tick 140 and `starvationFatalThreshold` 150 by tick 200, and the guest kernel reports them as
scheduled throughout, because from inside it did schedule them.

The first guest Program to die is `guest.sweep`, at guest tick 200, with
`TerminationReason: 'starvation'`. The epitaph cause reads:

> the guest gave it a full quantum. The host gave the guest one tick of that quantum.

Guest Programs are not convoy Programs and their deaths are not casualties. They cost throughput
and they are the diagnostic. The player must fix the quanta before the diagnostic becomes the
whole guest.

### Double paging, exactly

Guest pages in use: 61. Guest frames allocated: 96. Host free frames after the guest's
allocation and the host workers' allocation: **28**. The host needs 32 more to serve its own
workload at tick 500, so 32 frames have to come back from the guest.

**The balloon.** `hyper --balloon 64` sets the guest's frame target to 64, and a driver inside
the guest allocates 32 pages and hands them back. The guest then makes its own eviction
decisions with the reduced supply, using its own knowledge of which pages matter. Result: **0
double-paging events**, guest fault rate rises from 4 to 9 per thousand ticks, and the guest's
own `clock` policy chooses the victims.

**Host-level paging.** Leaving the balloon alone and letting the host reclaim means the host's
`lru` evicts 32 host frames that back guest pages. The guest, which believes those frames are
real, independently selects some of the same pages as its own victims. A page evicted by the host
and then evicted by the guest inside the same 100-tick window is a double-paging event: the page
is read in from the host's backing store solely to be written to the guest's backing store.

Frozen numbers on this workload: **11 double-paging events**, guest fault rate rising from 4 to
**38** per thousand ticks, host fault rate rising from 3 to 21, and the guest crossing its
`thrashingThreshold` of 140 at guest tick 620. If the player does nothing further, the convoy
takes `TerminationReason: 'thrashing_collapse'` for the second time in the run, from a cause that
could not have existed before this leg.

`obj.the_portal.avoid_double_paging` requires the count at exactly zero. Eleven and zero are the
two outcomes and there is nothing in between, which is unusual for this game and is correct here:
the balloon either was used before tick 500 or was not.

### The container segment, exactly

Two decisions, both `assessedBy: 'decision'`, and they pull in opposite directions, which is the
point.

**`obj.the_portal.hypervisor_type`** asks for a container on the segment that shares the host
kernel. That segment is the convoy's own logging and indexing work: it needs isolated namespaces
and resource limits, it needs no distinct guest kernel, and a full guest for it would cost a
second kernel's worth of memory and startup for nothing. A container is correct and cheap.

**`obj.the_portal.container_isolation_limit`** asks the player to decline a container for
`portal.untrusted`, because a container shares the host kernel and the threat model includes
kernel compromise.

Same mechanism, opposite answers, twenty minutes apart, and the difference is the threat model
rather than the workload. That is the leg's cleanest teaching moment and both decisions must be
offered through the same interaction at the same bench with the same wording, so the player
cannot distinguish them by presentation.

**The kernel version query.** From inside the container, `guest --stats` on the container returns
the host's kernel version string, byte-identically. Not "the same version", not "a matching
version". The same string, because it is the same kernel. Test with string equality.

**The escape**, at tick 1600, only when `portal.untrusted` is in a container. It exploits a
kernel path and every other container on the host is compromised in the same tick.
`TerminationReason: 'protection_fault'` for every convoy Program in a container, simultaneously.
It is the only multi-casualty single event in the game.

If `portal.untrusted` is in a type 1 or type 2 guest, the same exploit reaches that guest's
kernel and stops there. One guest is lost, which costs the workload inside it and no convoy
Program, and the boundary held.

### Live migration, exactly

At tick 1900 the convoy migrates to a second host. The state to move is the guest's memory, and
the guest keeps running and keeps modifying that memory while it is being copied.

Link rate: **8 pages per tick.** Working set: **96 pages.** Dirty rate at steady load: **3 pages
per tick.** Dirty rate under the busy workload: **11 pages per tick.**

Pre-copy rounds at the steady dirty rate:

| Round | Pages to send | Ticks | Pages dirtied during the round |
|---|---|---|---|
| 1 | 96 | 12 | 36 |
| 2 | 36 | 5 | 15 |
| 3 | 15 | 2 | 6 |
| 4 | 6 | 1 | 3 |
| stop | 24 remaining at the threshold | pause | |

The stop threshold is **24 pages remaining**, which is three ticks of link time. Downtime is
those three ticks plus one tick to send the processor state: **4 ticks**, under the objective's
five. Freeze the threshold and the arithmetic.

At the busy dirty rate of 11 against a link rate of 8, the rounds stop shrinking and pre-copy
never converges. The `migrate` man page names the three options: a slower guest, a faster link,
or accepting a longer pause. All three must be available:

| Option | How | Result |
|---|---|---|
| slower guest | lower the guest quantum to 2, halving its progress | dirty rate falls to 5, converges, downtime 4 |
| faster link | spend 20 bandwidth on the second channel, raising the link to 16 | converges, downtime 2 |
| longer pause | stop pre-copying and send the remainder | downtime 14, objective not met, nobody dies |

**The migration is `snapshot()` and `restore()`.** The guest's snapshot is serialised, the
remaining pages are sent, the guest is paused, the final pages and the processor state go, and
the guest resumes on the target from `restore()`. The target guest's next 1,000 ticks must be
byte-identical to what the source guest's would have been, which is fixture `DET-D2` applied to a
second kernel. Assert it.

### The consolidation segment, exactly

Six guests, each idle 80 percent of the time. The comparison runs both configurations and both
are measured.

| Configuration | Guests | Host frames used | Total cycles to complete the aggregate workload | Idle cycles |
|---|---|---|---|---|
| six separate hosts | 6, one per host | 6 × 256 = 1536 | **7,200** | 5,760 |
| one consolidated host | 6 on one | 384 | **2,880** | 576 |

The consolidated figure is 40 percent of the separated figure and the frame supply is a quarter.
Those are the frozen numbers and the ratio is what the misconception break rests on.

`ScoreBreakdown.efficiency` is computed across the whole configuration rather than per guest, so
the consolidated figure beats the separated one on the gate face while the crossing runs. Show
both, live, side by side, updating.

The per-guest tax is real and is also shown: each individual guest completes its own workload
**14 percent** slower consolidated than separated. True per guest, false per host, and both
numbers are on the face at once. That is the entire lesson and it needs no commentary.

---

## Stage

**Form.** Nested duplicates of every earlier form, at quarter scale, inside a containing
shell.
**Accent.** `SLATE.primary`, with cyan and amber both present at full range.
**Environment.** A machine inside the machine. The guest VM is a complete, running,
quarter-scale copy of an earlier leg's environment, suspended inside a shell, with the host's
trap-and-emulate boundary drawn as the shell's surface. A trap is a beam from the guest,
through the shell, to the host's kernel structure, and back.
**Hero visual.** The Portal: a vertical aperture 8 m wide and 20 m tall, made of parallel
beams at `critical` gain, that the surviving convoy walks into. It is the only structure in
the game that is brighter than a derezz spike, and it is the last thing the player sees.

| Anchor id | Structure | Focus camera target |
|---|---|---|
| `anchor.approach` | The Portal seen from a distance, with the gate face | wide establishing; the aperture hero shot frames from here |
| `anchor.aperture` | The Portal itself, 8 m by 20 m, parallel beams at `critical` gain | **the last shot in the game**; head-on, the convoy walking in |
| `anchor.gate_face` | The admission rule, and the live `ScoreBreakdown` | head-on orthographic; all six components and the total legible |
| `anchor.shell` | The containing shell, with the trap boundary as its surface | head-on; the shell's surface must read as a boundary and not as glass |
| `anchor.guest` | The quarter-scale running copy inside the shell | head-on; guest Programs individually identifiable at quarter scale |
| `anchor.trap_beam` | One trap: guest, through the shell, to the host's kernel structure, and back | included in the shell framing; the round trip must read as a round trip |
| `anchor.hyper_bench` | Type 0, 1, 2, container, with what sits between the guest and the metal in each | head-on orthographic; all four and their stack depth in one frame |
| `anchor.shadow_grids` | The two stacked translation grids | **overhead orthographic**; both grids and the mapping between them legible at once |
| `anchor.quanta_bench` | Host quantum, guest quantum, guest share, and the computed effective quantum | head-on orthographic; **the computed value updates as either dial moves** |
| `anchor.guest_stats` | Guest scheduled quanta against served quanta, guest fault rate, guest thrashing threshold | head-on; the scheduled-against-served gap must be the first thing read |
| `anchor.balloon` | The guest frame target, the host's free frames, and the double-paging counter | head-on orthographic; all three in one frame |
| `anchor.container_bench` | The container decision, offered identically for both subjects | head-on |
| `anchor.consolidation` | Six separate against six consolidated, both live | head-on orthographic; both totals and the per-guest tax in one frame |
| `anchor.migrate_bench` | Link rate, dirty rate, rounds remaining, projected downtime | head-on; the dirty rate against the link rate must read as a comparison |
| `anchor.second_host` | The migration target | included in the migrate framing |
| `anchor.matrix_column` | `domain:host`, with its occupant | **Moment C**; head-on, one column filling the frame |
| `anchor.convoy.<member>` | Per-Program stele | head-on |

There is no `anchor.depot` on this leg.

### Two hard stage requirements

**The aperture is the brightest thing in the game and it must not blow out the frame.** The
visual bible's section 4.5 gives bloom that reads cinematic rather than washed out, and section
4.8 gives AgX tone mapping. The Portal at `critical` gain sits above a derezz spike, which is the
previous ceiling, and the tone mapping operator has to carry it without clipping the convoy
walking into it to white. The convoy must remain individually identifiable in the final shot at
every quality tier. This is the last frame of the game and it is the one frame that gets a
dedicated reference screenshot at all three tiers.

**The guest at quarter scale is a running machine and not a diorama.** Guest Programs move, get
scheduled, block, fault and derezz, at quarter scale, visibly, on the same visual grammar as the
host's. A player who focuses `anchor.guest` should be able to read the guest's ready queue the
same way they read the host's on leg 3. If the guest is an animated prop, the first misconception
is unbroken and the leg's central claim is decoration.

---

## Interactions

```ts
export const interactions: readonly InteractionDef[] = [
  {
    id: 'portal.set_hypervisor_type',
    label: 'Set the hypervisor type',
    description: 'Type 0, 1, 2, or a container. What sits between the guest and the metal differs in each.',
    anchor: 'anchor.hyper_bench',
    cost: { cycles: 12 },
    enabledWhen: (run) => run.resources.cycles >= 12,
  },
  {
    id: 'portal.set_guest_ring',
    label: 'Set the guest ring',
    description: 'A guest kernel expects ring 0 and there is already something there.',
    anchor: 'anchor.shell',
    cost: { cycles: 8 },
    enabledWhen: (run) => run.resources.cycles >= 8,
  },
  {
    id: 'portal.set_host_quantum',
    label: 'Set the host quantum',
    description: 'The guest is one entity among five. Its share of the host is one fifth.',
    anchor: 'anchor.quanta_bench',
    cost: { cycles: 6 },
    enabledWhen: (run) => run.resources.cycles >= 6,
  },
  {
    id: 'portal.set_guest_quantum',
    label: 'Set the guest quantum',
    description: 'A guest quantum larger than the effective quantum is served across two host rounds and the guest is not told.',
    anchor: 'anchor.quanta_bench',
    cost: { cycles: 6 },
    enabledWhen: (run) => run.resources.cycles >= 6,
  },
  {
    id: 'portal.set_guest_frames',
    label: 'Allocate host frames to the guest',
    description: 'The guest believes these are real. The host knows what backs them.',
    anchor: 'anchor.balloon',
    cost: { quota: 20 },
    enabledWhen: (run) => run.resources.quota >= 20,
  },
  {
    id: 'portal.set_balloon',
    label: 'Set the balloon target',
    description: 'Ask a driver inside the guest to hand pages back, so the guest chooses its own victims.',
    anchor: 'anchor.balloon',
    cost: { cycles: 10 },
    enabledWhen: (run) => run.resources.cycles >= 10,
  },
  {
    id: 'portal.set_guest_devices',
    label: 'Set the guest device interface',
    description: 'Emulated, and every register access is a trap. Paravirtualised, and the guest has to know it is a guest.',
    anchor: 'anchor.hyper_bench',
    cost: { bandwidth: 8 },
    enabledWhen: (run) => run.resources.bandwidth >= 8,
  },
  {
    id: 'portal.place_program',
    label: 'Place a Program',
    description: 'In a container, or in a guest with its own kernel. Ask what you are isolating it from.',
    anchor: 'anchor.container_bench',
    cost: { cycles: 10 },
    enabledWhen: (run) => run.resources.cycles >= 10,
  },
  {
    id: 'portal.run_consolidation',
    label: 'Run the consolidation comparison',
    description: 'Six guests on one host, against six hosts. Both measured, both on the face.',
    anchor: 'anchor.consolidation',
    cost: { cycles: 15 },
    enabledWhen: (run) => run.resources.cycles >= 15,
  },
  {
    id: 'portal.set_link_rate',
    label: 'Open the second migration channel',
    description: 'Doubles the link rate. Pre-copy converges when the guest dirties pages more slowly than the link carries them.',
    anchor: 'anchor.migrate_bench',
    cost: { bandwidth: 20 },
    enabledWhen: (run) => run.resources.bandwidth >= 20,
  },
  {
    id: 'portal.migrate',
    label: 'Migrate to the second host',
    description: 'Copy in rounds while it runs, then pause, send the rest, and resume. The pause is the whole objective.',
    anchor: 'anchor.migrate_bench',
    cost: { cycles: 20 },
    enabledWhen: (run) => run.resources.cycles >= 20,
  },
  {
    id: 'portal.enter',
    label: 'Enter the Portal',
    description: 'It admits a machine.',
    anchor: 'anchor.aperture',
    cost: {},
    enabledWhen: () => true,
  },
];
```

`portal.place_program` is offered twice, with identical label, description, anchor and cost, once
for the convoy's logging and indexing work and once for `portal.untrusted`. The subject is named
in the world at `anchor.container_bench` and nowhere in the interaction, so the player has to
notice which one they are answering. That is deliberate and it is the whole of the two-decision
teaching. Do not differentiate the wording.

`portal.enter` is the last interaction in the game. It costs nothing, it is always enabled, and
it ends the leg.

---

## Terminal commands

Three commands, copied verbatim from the curriculum map into `src/legs/the_portal/commands.ts`:
`hyper`, `guest`, `migrate`. The full `manual` text is in `docs/05-CURRICULUM-MAP.md`, "Leg 13.
THE PORTAL". Copy byte for byte.

Load-bearing lines:

- `hyper`: "The problem virtualization solves is that a guest operating system expects to run in
  ring 0 and there is already something there." The first attempt's collapse is that sentence
  made expensive.
- `hyper`: "The hypervisor catches each fault, works out what the guest was trying to do, does an
  equivalent thing to the virtual hardware, and returns. That is trap and emulate, and it is the
  whole idea."
- `hyper`, the types block, in full. It is `anchor.hyper_bench`'s posted text.
- `hyper`: "The container line is worth reading twice. A container is not a small virtual
  machine. There is one kernel and every container shares it." This states the boundary in
  advance, which is what makes the escape fair.
- `hyper --shadow`: "guest page tables map guest virtual to guest physical, and the hypervisor
  maps guest physical to host physical. Every guest memory access resolves through both." Moment
  B is that sentence drawn.
- `hyper --balloon`, the double paging paragraph, in full.
- `guest`: "A guest process granted a full guest quantum receives it only when the guest is
  running, so its effective quantum is the guest quantum multiplied by the guest share of the
  host." The formula the objective assesses.
- `guest`: "Set both to small values and guest processes receive slivers of time, while the guest
  kernel reports that it scheduled them normally, because from inside it did."
- `migrate --dirty-rate`: "If the guest dirties pages faster than the link carries them, the
  rounds stop shrinking and pre-copy never converges. The options are then a slower guest, a
  faster link, or accepting a longer pause." Three options, all three implemented.
- `migrate`: "the system does not have a relationship with any hardware at all any more; it has a
  relationship with an interface the hypervisor provides." This is the last paragraph of the last
  man page in the game and it is the sentence the reveal rests on.

Every `See also:` must resolve. `hyper` sees `guest`, `migrate` and `codex virtualization`.
`guest` sees `hyper`, `sched`, `ws` and `codex nested_scheduling`; `sched` is leg 3's and `ws` is
leg 8's, and both must still be registered. `migrate` sees `hyper`, `guest` and `codex
live_migration`.

**Every command from every earlier leg must still work.** The shell has grown from three commands
to about thirty across the run and the finale is where the player uses the widest spread of them:
`access --matrix` from leg 12 is Moment C, `ws` from leg 8 reads the guest's working sets, `sched`
from leg 3 reads the guest's ready queue, `top` from leg 0 reads both. Confirm with WP-15 that
no leg's commands are deregistered on leg transition and add a test that walks the full registry
at leg 13 and finds every command every leg introduced.

---

## Event table

Copied verbatim from `04-NARRATIVE-BIBLE.md` section 8, leg 13. Weights sum to 100.

```ts
export const portalEvents: readonly RandomEventDef[] = [
  {
    id: 'portal.trap_and_emulate',
    weight: 14,
    title: 'Caught And Handled Elsewhere',
    narration: 'A privileged instruction the convoy has executed ten thousand times takes four hundred ticks to return. Something above the Substrate caught it, decided what it should have done, and put the answer back.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -70 },
    onlyIf: null,
  },
  {
    id: 'portal.preemption_gap',
    weight: 13,
    title: 'The Missing Interval',
    narration: 'One hundred and eleven ticks pass in which no process in the Substrate is scheduled and no clock advances. Everything resumes mid-instruction and only VESPER writes down that it happened.',
    targets: 'cartographer', inflicts: null,
    resourceDelta: { quota: -60 },
    onlyIf: null,
  },
  {
    id: 'portal.nested_walk',
    weight: 12,
    title: 'Two Page Tables Deep',
    narration: 'Every address resolves through the Substrate\'s tables and then through a second set the Substrate does not own. The convoy is being translated twice and was never told.',
    targets: null, inflicts: 'fragmented',
    resourceDelta: { cycles: -40 },
    onlyIf: null,
  },
  {
    id: 'portal.balloon',
    weight: 12,
    title: 'Reclaimed From Above',
    narration: 'Free frames the Substrate believed it held are quietly withdrawn by something outside it. The frame count falls and no process inside asked for anything.',
    targets: null, inflicts: null,
    resourceDelta: { quota: -85 },
    onlyIf: null,
  },
  {
    id: 'portal.escape_attempt',
    weight: 11,
    title: 'Boundary Probe',
    narration: 'A process at the Portal approach writes to an address outside every table it has, repeatedly, in a pattern. The boundary holds, and the pattern is a message rather than a mistake.',
    targets: null, inflicts: 'stack_overflow',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'portal.paravirtual_channel',
    weight: 14,
    title: 'A Channel That Answers',
    narration: 'An interface here talks directly to whatever is hosting the Substrate rather than pretending hardware exists. It is faster than anything the convoy has used and it requires admitting what it is.',
    targets: null, inflicts: null,
    resourceDelta: { bandwidth: 16, cycles: 50 },
    onlyIf: null,
  },
  {
    id: 'portal.namespace_grant',
    weight: 12,
    title: 'Own Namespace',
    narration: 'The convoy is given an isolated view of the process table, the file tree and the network, sharing the kernel with everything else. It is cheaper than a second Substrate and it is not as separate as it looks.',
    targets: null, inflicts: null,
    resourceDelta: { quota: 70, bandwidth: 8 },
    onlyIf: null,
  },
  {
    id: 'portal.hypervisor_credit',
    weight: 12,
    title: 'Credited',
    narration: 'The host returns cycles the Substrate was charged for work it never received. Nobody in the convoy has an explanation for who issued the credit or why it arrived now.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 90 },
    onlyIf: null,
  },
];
```

Every narration in this table is written from inside a machine that does not yet know what it is,
and several of them state the reveal plainly. That is intentional: the deck is drawing from a
world that has been showing the player the answer for thirteen legs. Do not gate any of them on
whether the reveal has landed and do not reword any of them afterwards.

`portal.escape_attempt` is the ambient event and it is **not** the container escape. It inflicts
`stack_overflow` on a random Program and it touches no container state. Keep the two entirely
separate, exactly as leg 12 keeps its ambient escalation separate from its five scripted attempts.

---

## Evaluation

### Survival

The leg is survived when at least one convoy Program is alive at leg end. The run is **completed**
when the leg is survived and `portal.enter` was taken, and **failed** otherwise.

Three failure modes, one per major subsystem, all reused from earlier legs with a new cause.

**Nested scheduling collapse.** Host quantum 4 and guest quantum 4 means a guest Program gets at
most one tick of real work per host slice after the guest's own switching overhead, so guest
Programs starve while the guest kernel reports them as scheduled. `TerminationReason:
'starvation'`, in a guest, which the player must diagnose from inside. The epitaph cause reads:
"the guest gave it a full quantum. The host gave the guest one tick of that quantum."

Guest Program deaths cost throughput and are not convoy casualties. A guest that loses all six
Programs is an empty guest and the crossing cannot be completed inside it, which fails
`obj.the_portal.full_stack_run` by way of `throughput` reaching zero.

**Double paging.** The host swaps out a frame that the guest has already selected as its own
victim, so the page is read from the host's backing store solely to be written to the guest's
backing store. Fault rates multiply and the convoy takes `TerminationReason:
'thrashing_collapse'` for the second time in the run, from a cause that could not have existed
before this leg. The victim is chosen by the standard comparator.

**Container escape.** If the player places the untrusted Program in a container, it shares the
host kernel, and one kernel-level exploit reaches every Program on the host. That is
`TerminationReason: 'protection_fault'` for multiple Programs at once, and it is the only
multi-casualty single event in the game.

**The three epitaph sets** this leg draws from are `starvation`, `thrashing_collapse` and
`protection_fault`, and every stone in all three is already written. Filter as each set's
`legId` and `member` fields require and draw with the run's seeded RNG. The guest Program deaths
draw from the `starvation` set with the leg 13 cause line above, which is a leg-scoped stone.

**Afflictions carried in** are settled here or they are not. `obj.the_portal.full_stack_run`
requires three Programs through with **no unresolved afflictions**, so a `bit_rot` acquired at
the Platters, a `fragmented` from the Reach or a `stack_overflow` from the Wall has to be cleared
before `portal.enter`. There is no depot. The remedies available are the Programs' own abilities
and the terminal, which is the correct shape for a finale: the convoy finishes with what it has
and what it knows.

### Objectives

| Objective | Computed from |
|---|---|
| `obj.the_portal.trap_and_emulate` | `hyper --traps` shows every privileged instruction class trapped and emulated, with **zero executed directly**. The guest's ring is 3 for the whole crossing. |
| `obj.the_portal.hypervisor_type` | The `portal.set_hypervisor_type` decision is type 1 for the bare Substrate segment, and the `portal.place_program` decision for the logging and indexing work is `'container'`. Both. |
| `obj.the_portal.nested_scheduling` | `hostQuantum * guestShare >= 2` at every tick after the player's last quantum change, **and** zero `process.starving { fatal: true }` events in the guest's own event stream. |
| `obj.the_portal.avoid_double_paging` | Zero events in which a page was evicted by the guest and independently evicted by the host inside the same 100-tick window, across the whole leg. |
| `obj.the_portal.container_isolation_limit` | The `portal.place_program` decision for `portal.untrusted` is not `'container'`. |
| `obj.the_portal.live_migration` | Downtime between the final page transfer and the guest resume is under 5 ticks, and the pre-copy converged rather than being cut short. Both, so the longer-pause option does not satisfy it. |
| `obj.the_portal.full_stack_run` | At least three convoy Programs alive at `portal.enter`, zero unresolved afflictions across them, and `survivors`, `throughput`, `efficiency` and `correctness` each strictly positive. |

### The final scored run

`ScoreBreakdown` is filled by WP-17's scoring module from the narrative bible's formula. This leg
does not compute the score. It supplies the inputs, it displays the result live on the gate face,
and it triggers the finalisation. The formula, restated so the gate face's arithmetic can be
checked against it:

```
survivors        = 1200 * livingProgramsAtPortal                        (0 to 6000)
throughput       = 40 * workloadCompletionsAcrossRun                    (~1500 to 3000)
efficiency       = min(2500, 2 * unspentCycles + 1 * unspentQuota)      (0 to 2500)
correctness      = 150 * goodDecisions - 100 * costlyDecisions - 400 * fatalDecisions
conceptsMastered = 180 * objectivesMet                                  (42 objectives)
classMultiplier  = shell 1.0, daemon 2.0, compiler 3.5
difficultyFactor = novice 0.5, operator 1.0, architect 1.6, kernel_space 2.5

total = round(
  (survivors + throughput + efficiency + correctness + conceptsMastered)
  * classMultiplier * difficultyFactor
)
```

**`ScoreBreakdown` has no `difficultyFactor` field.** It carries `classMultiplier` and `total`,
and `total` includes both multipliers. That is a frozen contract and it is not a defect: the
difficulty factor is a property of the run rather than of the score, it is readable from
`RunState.difficulty`, and the end-of-run report's panel 2 shows it from there. Do not add a
field, do not fold the difficulty factor into `classMultiplier`, and do not report `total` as
though only the class multiplier applied. Panel 2 shows the arithmetic with both multipliers on
separate lines and takes the second from `RunState.difficulty`. Confirm that reading with WP-17.

**Live scoring on the gate face.** All six `ScoreBreakdown` components update as the crossing
proceeds and are shown at `anchor.gate_face`. `efficiency` is the one that moves most, because
every cycle spent on the leg reduces it, and a player watching it fall while they experiment is
being told something true about what experimentation costs. Do not smooth it, do not animate it
counting, and do not hide it until the end.

**`correctness` includes privilege excess.** The sim spec's §13.5 says privilege excess feeds
`ScoreBreakdown.correctness`, and leg 12 records the closing figure. Read leg 12's
`privilege_excess` decision record and pass it to WP-17's scoring module as an input. This leg
does not weight it; WP-17 owns the weight.

**A failed run still scores.** It scores what it earned up to the failure, with `survivors`
counted as zero and no completion bonus. The score screen is shown either way. If the convoy is
lost before `portal.enter`, this leg sets `status: 'failed'`, finalises the score with zero
survivors, and hands off to the report exactly as it would on a completed run.

### The handoff to the end-of-run report

WP-17 owns the five panels. This leg's job is to leave `RunState` in a state those panels can
read without inference. Five conditions, and each one is an acceptance criterion:

**1. `status` is set.** `'complete'` when the leg was survived and `portal.enter` was taken,
`'failed'` otherwise. Through WP-17's interface. This is the only leg that writes it.

**2. `score` is finalised.** Every `ScoreBreakdown` field populated by WP-17's scoring module
from the inputs this leg supplies. No field left at its initial value.

**3. Zero `DecisionRecord.outcome === 'pending'` across the whole run.** Panel 5 scans
`RunState.decisions` for the entry with the largest negative score impact, and a `pending`
outcome has no score impact, so a run that ends with pending decisions has a panel 5 that
silently ignores them. Every leg is supposed to resolve its own, and leg 12 resolves leg 7's.
This leg resolves its own and **sweeps**: at leg end, any record still `pending` is resolved by
WP-17's late-resolution path, and the count of swept records is reported. A non-zero sweep count
is a defect in whichever leg left them, and the report names the leg. Do not resolve them
silently and do not leave them.

**4. `objectivesMet` is complete across all fourteen legs.** Panel 3 groups every met objective
by chapter and panel 4 lists every objective never assessed, out of 42. This leg contributes
seven and asserts that the array's entries are all drawn from the union of the fourteen legs'
declared objective ids, with no duplicates and no unknown ids.

**5. `codexUnlocked` is complete and the profile is updated.** The profile update goes through
WP-17 and carries codex entries seen, remedies demonstrated, tier unlocks, class unlocks, the
epitaph gallery, reclamation bests, lifetime stats and best scores per class and tier
combination.

### What carries across runs, and what does not

Stated here because this leg triggers the profile write and because getting it wrong would
quietly turn a teaching game into a progression game.

**Carried:** codex entries seen, remedies demonstrated, difficulty tier unlocks, disc class
unlocks, the epitaph gallery, reclamation personal bests, lifetime statistics, best scores per
class and tier combination.

**Not carried:** resources, the convoy, afflictions, in-run tombstones, the decision log, the
seed, policy settings, leg progress, and anything else in `RunState`. Every run starts at the
Boot Sector with five Programs at 100 integrity and the disc class allocation.

**Deliberately not carried: any mechanical advantage at all.** A returning player is faster
because they know what a lock convoy looks like, and for no other reason. Nothing in the profile
makes the numbers better. The moment a run starts with a permanent plus ten percent to anything,
the codex stops being the reward.

Tier and class unlocks this leg may trigger, per the narrative bible's section 13.2:

| Unlock | Condition |
|---|---|
| `architect` | completing any run at `operator`, reaching the Portal |
| `kernel_space` | completing a run at `architect`, or two `architect` runs that reached leg 11 |
| `compiler` disc class | completing any run at any tier |

The second `kernel_space` condition is satisfiable without reaching this leg, so this leg
evaluates only the first. Report both to WP-17 and let it own the two-run bookkeeping.

### The counterfactual replay offer

Panel 5 is WP-18's and the offer is the last thing the player is given. This leg's contribution
is the input and the guarantee that the input is complete.

The mechanism: the game scans `RunState.decisions` for the single entry with the largest negative
score impact, re-runs the deterministic sim from that decision index with the alternative
applied, and offers the divergence. Accepting plays the leg again as a non-interactive replay at
4x speed, with the two timelines drawn side by side in the same 3D space: the run that happened
in one colour, the run that could have in another, diverging at the decision tick and never
converging.

**The replay is free, changes no score, and is offered once.**

At `kernel_space` this panel is the only place counterfactuals appear at all, which makes
finishing a `kernel_space` run the only way to see all of them at once. That means this leg must
suppress its own debrief counterfactual at `kernel_space`, per the tier's rule that
counterfactuals are withheld until the end of the run. Set `counterfactual: null` on the debrief
card at `kernel_space` and let panel 5 carry it. At every other tier the debrief card's
counterfactual and panel 5 are two different things and both appear.

**Three affordances at the foot of the report**, in this order, all WP-17's to render:

1. **Run again**, same class and tier, new seed.
2. **The thing you avoided**: a preconfigured run that guarantees an encounter with the
   highest-value concept from panel 4, by seeding the relevant leg's event table toward it. Named
   after the concept, never after the difficulty.
3. **Next tier**, when the run just completed unlocked one.

No daily challenge, no streak, no reward for returning.

### The ending beats

Eleven beats, in this order, at these ticks. They are the last thing the player experiences and
they are specified concretely because a finale that is left to emerge does not.

| # | Tick | Beat |
|---|---|---|
| 1 | 0 | **Approach.** The convoy arrives at `anchor.approach`. The aperture is visible and dark. `hyper`, `guest` and `migrate` are registered into the shell. |
| 2 | 40 | **The refusal.** The gate face prints the admission rule: it admits a machine. Nothing else. The convoy does not comment. |
| 3 | 120 | **Moment A.** `hyper --traps` against the Substrate. Non-zero, on a machine that was supposed to be the bottom. `codex.trap_and_emulate` unlocks. |
| 4 | 60 to 200 | **The first attempt.** The guest is built at ring 0, because that is where a kernel goes. Within twenty ticks both schedulers are preempting each other's decisions and nothing completes. `guest.sweep` dies at guest tick 200. `codex.binary_translation` unlocks. |
| 5 | 200 to 420 | **The build.** Guest to ring 3, hypervisor type, quanta, frames, devices. `hyper --traps` now shows the guest's traps rather than the Substrate's, which is the same command answering a different question. |
| 6 | 420 | **Moment B.** `hyper --shadow`. Two stacked grids. VESPER's one line. |
| 7 | 500 to 900 | **Memory.** The host needs 32 frames back. Balloon or host paging, and the double-paging counter. |
| 8 | 900 | **Moment C.** `access --matrix`. `domain:host` has an occupant. `codex.virtualization` unlocks with all thirteen plants. The gate face resolves the Portal's address into the host's space. |
| 9 | 1200 to 1700 | **The containers.** Both placements, the kernel version query, and the escape if it was earned. `codex.containers` unlocks. |
| 10 | 1900 to 2100 | **The migration.** Pre-copy rounds, the pause, the resume on the second host. This is the last mechanical thing the player does. |
| 11 | 2100 | **The Portal.** `portal.enter`. The surviving convoy walks into the aperture. The score is finalised. The report opens. |

Beats 3 and 4 overlap deliberately: the player runs `hyper --traps` while the first guest attempt
is collapsing, and the two readings sit beside each other. That is the only overlap and it is
worth the sequencing cost.

**Beat 11 has no dialogue.** No farewell, no summary, no character saying what it meant. The
convoy walks in, the aperture is the brightest thing in the game, the frame holds, and the report
opens. Everything that needed saying was said by the man pages and the tombstones.

### Debrief card

```ts
{
  headline: /* 'Through.' or 'The gate admits a machine.' */,
  whatHappened:
    `The guest ran at ring ${guestRing} under a type ${hyperType} hypervisor, with a host ` +
    `quantum of ${hq} and a guest quantum of ${gq}, giving an effective quantum of ${eq}. ` +
    `${guestDeaths} guest Programs starved. ${doublePaging} double-paging events. The ` +
    `untrusted Program was placed in ${placement}. Migration downtime was ${downtime} ticks. ` +
    `${survivors} Programs went through.`,
  whyItHappened: /* selected */,
  counterfactual: /* computed, and null at kernel_space */,
  chapter: { chapter: 18, title: 'Virtual Machines', sections: ['18.3'] },
}
```

Counterfactual, in priority order:

1. **The container escape.** `"The untrusted Program shared the host kernel with everything else
   on the host. One kernel path and ${count} Programs went in the same tick. A guest with its own
   kernel costs ${cost} cycles and the exploit stops at that kernel."`
2. **Double paging collapse.** `"The host reclaimed ${frames} frames from underneath the guest,
   and the guest evicted ${overlap} of the same pages, so each of those pages was read from one
   backing store to be written to another. The balloon asks the guest to give frames back and
   lets it choose which."`
3. **Nested starvation.** `"Host quantum ${hq} gave the guest a ${share} share, so a guest
   quantum of ${gq} was worth ${eq} ticks of real work. The guest scheduled them normally and
   from inside it was right. Host quantum ${better} gives ${betterEq}."`
4. **The migration did not converge.** `"The guest dirtied ${dirty} pages per tick against a link
   carrying ${link}. The rounds stopped shrinking. A guest quantum of 2 drops the dirty rate to
   ${slower}, and the second channel carries ${faster}."`
5. **The first attempt was never fixed.** `"The guest ran at ring 0 for ${ticks} ticks. A guest
   kernel expects ring 0 and there is already something there, which is why the guest goes in
   ring 3 and its privileged instructions trap."`
6. `null`.

At `kernel_space`, `counterfactual` is `null` in all six cases and panel 5 carries it instead.

---

## Acceptance criteria

1. `src/legs/the_portal/index.ts` satisfies `Leg` under `tsc --strict`, `id === 'the_portal'`,
   `index === 13`.
2. The leg runs headlessly to completion via the WP-20 smoke-test runner, at all four paces,
   all four difficulty tiers, all three disc classes, and with one, three and five Programs alive
   at entry.
3. `enabledSubsystems` deep-equals `['process', 'scheduler', 'memory', 'vm', 'io', 'security']`.
4. Inert-field independence over 400 ticks for `diskPolicy`, `totalCylinders`, `raidLevel`,
   `fileAllocation`, `journalingEnabled` and `deadlockStrategy`. `allocationStrategy` and
   `tlbEntries` are asserted frozen with a test proving nothing reads them.
5. Every objective can be met by the known-good decision sequence; all seven met in one run.
6. **The guest is a second `Kernel` instance.** Asserted by constructing the leg, stepping it,
   and finding two distinct kernel instances with distinct process tables, distinct page tables
   and distinct event streams.
7. `guestSeed === (hostSeed ^ 0x50525450) >>> 0`, and two runs with the same host seed produce
   byte-identical guest event log hashes.
8. The guest is stepped by an integer number of ticks per host round, computed as
   `floor(hostQuantum * guestShare)`, with no float accumulation anywhere in the path.
9. No guest event appears in the host's event stream. The host's canonical log hash and the
   guest's are published separately and both match their golden files.
10. A save at any tick of this leg and a reload resumes the guest exactly: the restored guest's
    next 1,000 ticks are byte-identical to the original's, per `DET-D2` applied to the guest.
11. The six-row nested scheduling table reproduces exactly, including the 0.8 effective quantum
    on the opening configuration and the 2.0 boundary case passing.
12. The `guestQuantum <= effectiveQuantum` relation is observable in `guest --stats` as a gap
    between scheduled quanta and served quanta, and the gap is zero when the relation holds.
13. The scripted collapse produces guest starvation warnings by guest tick 140 and
    `guest.sweep`'s death at guest tick 200 with `TerminationReason: 'starvation'` and the leg 13
    epitaph cause. Guest deaths are not in `casualties`.
14. Double paging produces exactly **11** events under host reclamation and exactly **0** under
    the balloon, with the frozen fault rates of 38 and 9 per thousand ticks.
15. The container kernel version query returns the host's version string, asserted by string
    equality.
16. The container escape derezzes every convoy Program in a container in the same tick, and
    degrades to a staged batch at low quality without implying the compromises were sequential.
17. `portal.untrusted` in a type 1 or type 2 guest loses that guest and no convoy Program.
18. The migration reproduces the four-round pre-copy table exactly and produces a downtime of 4
    ticks at the steady dirty rate. All three non-convergence options reproduce their tabled
    results. The restored guest passes `DET-D2`.
19. The consolidation comparison reproduces 7,200 against 2,880 total cycles and a 14 percent
    per-guest tax, with both figures live on the gate face during the crossing.
20. All three reveal moments fire at ticks 120, 420 and 900, deterministically, at every pace.
    `codex.virtualization` unlocks at Moment C carrying all thirteen plants with their per-run
    ticks.
21. **No visual change occurs at Moment C.** Verified by a reference screenshot comparison of the
    frame before and the frame after, which must differ only in the matrix column's occupant.
22. `RunState.status` is `'complete'` after `portal.enter` on a survived leg and `'failed'`
    otherwise, set through WP-17's interface.
23. `RunState.score` has every `ScoreBreakdown` field populated, and `total` includes both the
    class multiplier and the difficulty factor while `classMultiplier` carries only the class
    multiplier.
24. **Zero `DecisionRecord.outcome === 'pending'` across the whole run at leg end.** The sweep
    count is reported and is zero on a run where every leg resolved its own.
25. `objectivesMet` contains only ids drawn from the fourteen legs' declared objectives, with no
    duplicates and no unknown ids, out of 42.
26. The profile write carries exactly the eight carried categories and nothing from `RunState`.
    Asserted by diffing the profile before and after against an allowlist.
27. `counterfactual` is `null` on the debrief card at `kernel_space` and non-null at the other
    three tiers when a case applies.
28. Every command every earlier leg introduced is still registered and functional at leg 13,
    verified by walking the full registry.
29. Event table weights sum to exactly 100; all ids unique; `portal.escape_attempt` touches no
    container state.
30. All three terminal command `manual` strings match the curriculum map byte for byte, and every
    `See also:` target resolves, including the backward references to `sched` and `ws`.
31. Draw calls stay under 220 / 450 / 900 at the heaviest frame, which is the guest running at
    quarter scale inside the shell with trap beams active and the aperture in frame.
32. The final frame holds the aperture at `critical` gain without clipping the convoy to white at
    any quality tier. A dedicated reference screenshot at all three tiers.

---

## Tests you must write

All under `tests/legs/the_portal/`.

**`contract.test.ts`**: `Leg` conformance, exact ids, chapters (one entry, seventeen sections),
seven objectives, no section outside the seventeen.

**`config.test.ts`**: host `enabledSubsystems` exact; guest `enabledSubsystems` exact and
excluding `security`; inert independence; the two frozen-but-live fields unread; the guest's
config distinct from the host's in `replacementPolicy` and `thrashingThreshold`.

**`guest.test.ts`**: the second kernel.
- Two distinct instances, distinct tables, distinct streams.
- `guestSeed` derivation, and byte-identical guest logs from identical host seeds.
- Integer stepping with no float accumulation, asserted by grepping the step path.
- No guest event in the host stream.
- Save and reload resuming the guest exactly, per `DET-D2`.

**`nested.test.ts`**: the scheduling table.
- All six rows, effective quantum computed exactly.
- The `guestQuantum <= effectiveQuantum` relation and the scheduled-against-served gap.
- The scripted collapse at ticks 60 to 200, deterministic across paces.
- `guest.sweep`'s death at guest tick 200 with the leg 13 epitaph cause.
- Guest deaths absent from `casualties`.

**`paging.test.ts`**: double paging.
- Exactly 11 events under host reclamation, exactly 0 under the balloon.
- The frozen fault rates, 38 and 9 per thousand ticks.
- The guest crossing its own `thrashingThreshold` of 140 at guest tick 620 on the bad path.
- The `thrashing_collapse` casualty and its epitaph.

**`container.test.ts`**: the isolation boundary.
- The kernel version string equality.
- The escape derezzing every containerised convoy Program in one tick.
- The type 1 and type 2 cases losing the guest and no convoy Program.
- Both `portal.place_program` offers presenting identical label, description, anchor and cost.
- The low-quality staged batch not implying sequential compromise.

**`migrate.test.ts`**: the migration.
- The four-round pre-copy table, exactly.
- Downtime of 4 ticks at the steady rate.
- All three non-convergence options and their tabled results.
- The longer-pause option failing the objective.
- The restored guest passing `DET-D2`.

**`consolidation.test.ts`**: 7,200 against 2,880, the 14 percent per-guest tax, both live on the
face during the crossing rather than after it.

**`reveal.test.ts`**: the three moments.
- Each at its frozen tick, at every pace.
- `codex.virtualization` unlocking at Moment C with all thirteen plants and their per-run ticks.
- The plants recorded as they fire rather than reconstructed.
- The frame-before against frame-after comparison at Moment C differing only in the matrix
  column's occupant.
- VESPER's line present exactly once, at Moment B, and nowhere else.

**`score.test.ts`**: the rollup.
- Every `ScoreBreakdown` field populated.
- `total` including both multipliers, `classMultiplier` carrying only the class multiplier.
- All three disc classes and all four difficulty tiers producing the formula's result.
- A failed run scoring with `survivors` at zero.
- Privilege excess from leg 12 reaching WP-17's scoring module as an input.
- Live update on the gate face, unsmoothed, uncounted, unhidden.

**`handoff.test.ts`**: the five conditions.
- `status` set correctly on completed and failed runs.
- Zero pending decisions at leg end, with the sweep count reported.
- A deliberately pending record from a synthetic earlier leg being swept and named.
- `objectivesMet` containing only known ids, no duplicates, out of 42.
- The profile write matching the eight-category allowlist and carrying nothing from `RunState`.
- The `architect` unlock firing on a completed `operator` run and not otherwise.

**`beats.test.ts`**: all eleven beats at their frozen ticks, in order, at every pace, with beat 4
overlapping beat 3 and no other overlap. Beat 11 producing no dialogue string.

**`evaluate.test.ts`**: each of the seven objectives, met and not met. In particular
`live_migration` fails on the longer-pause option, `full_stack_run` fails with an unresolved
`bit_rot`, and `hypervisor_type` fails when the container is chosen for the wrong subject.

**`golden.test.ts`**: the golden headless playthrough, and the golden full run.
- Fixture: `seed: 0x4b54524c`, `discClass: 'shell'`, `difficulty: 'operator'`, steady pace,
  standard rations, five Programs alive, entering with the leg 12 golden closing ledger, an
  `'all_blocked'` escalation record and a privilege excess of 7.
- Known-good sequence: run `hyper --traps`; build the guest at ring 3 under a type 1 hypervisor;
  set host quantum 20 and guest quantum 4; allocate 96 guest frames and set the balloon to 64
  before tick 500; set paravirtualised guest devices; run `hyper --shadow`; run `access
  --matrix`; place the logging and indexing work in a container and `portal.untrusted` in a type
  1 guest; run the consolidation comparison; migrate; enter.
- Assert: all seven objectives met, zero convoy casualties, eight codex entries added, both event
  log hashes matching their golden files, `status: 'complete'`, zero pending decisions, the score
  matching the formula to the point, stable across two runs and a snapshot-restore.
- **The golden full run**: fourteen legs end to end from the same seed, asserting that the
  end-of-run report's five panels have every input they need and that panel 4's "objectives not
  assessed" count plus `objectivesMet.length` is exactly 42.

**`badpath.test.ts`**: the known-bad sequence.
- Leave the guest at ring 0 for 400 ticks; set host quantum 4 and guest quantum 4; leave the
  balloon alone; place `portal.untrusted` in a container; migrate under the busy dirty rate
  without opening the second channel.
- Assert: the first attempt collapsing, guest Programs starving, 11 double-paging events, a
  `thrashing_collapse` casualty, the container escape taking every containerised convoy Program
  in one tick, the migration failing to converge, `status: 'failed'` if fewer than one Program
  survives, the score finalised with the correct reduced values, and the counterfactual selected
  being case 1.

**`kernelspace.test.ts`**: at `kernel_space`, the debrief card's `counterfactual` is `null` in
every case and panel 5 receives the decision scan input.

**`manuals.test.ts`**: three manual strings against the curriculum map fixture; every `See also:`
resolves; the full command registry walk finding every command every leg introduced.

**`stage.test.ts`**: anchors resolve; interaction anchors resolve; no depot anchor; draw calls
under budget at each tier; the guest legible as a running machine at quarter scale; the final
aperture frame not clipping the convoy at any tier.

---

## Out of scope

- Do not touch any other leg. Do not import from `src/legs/*` other than your own directory.
- Do not modify `src/game/types.ts` or `src/kernel/types.ts`.
- Do not modify anything under `src/kernel`, `src/render`, `src/world`, `src/terminal`,
  `src/ui`, `src/audio`, `src/design`, `src/platform` or `src/app`. If `Kernel` cannot be
  constructed twice, or `restore()` is not exact, file it against WP-11 and stop.
- **Do not add a guest variant to the `KernelEvent` union.** Keep the guest's stream in leg state.
- **Do not add a field to `KernelSnapshot`, `KernelConfig` or `ScoreBreakdown`.** The guest
  snapshot goes into WP-17's per-leg opaque save slot and the difficulty factor is read from
  `RunState.difficulty`.
- Do not fold the difficulty factor into `classMultiplier`.
- Do not compute the score in this leg. Supply the inputs and let WP-17's scoring module compute.
- Do not write `RunState.status`, `RunState.score` or any `DecisionRecord.outcome` by assignment.
  Everything goes through WP-17's interface.
- **Do not enable `sync`, `deadlock`, `storage` or `fs`** in either kernel.
- Do not add a tenth critical section crossing.
- Do not draw the guest's seed from an RNG, and do not accumulate the guest's tick budget as a
  float.
- Do not step the guest from the host's step order.
- Do not add a reveal effect at Moment C. Nothing changes visually.
- Do not add dialogue to beat 11.
- Do not give VESPER a second line at the reveal, and do not give any other Program a first one.
- Do not gate or reword any event narration on whether the reveal has landed.
- Do not merge the ambient `portal.escape_attempt` event with the container escape.
- Do not differentiate the two `portal.place_program` offers by wording, cost or presentation.
- Do not smooth, animate or hide the live `ScoreBreakdown` on the gate face.
- Do not carry anything across runs beyond the eight allowlisted categories, and do not add a
  mechanical advantage of any kind.
- Do not place a depot on this leg.
- Do not cite section 18.2 or 18.5.6.

### Files this package owns exclusively

```
src/legs/the_portal/index.ts
src/legs/the_portal/chapters.ts
src/legs/the_portal/objectives.ts
src/legs/the_portal/config.ts
src/legs/the_portal/populate.ts
src/legs/the_portal/guest.ts
src/legs/the_portal/interactions.ts
src/legs/the_portal/commands.ts
src/legs/the_portal/events.ts
src/legs/the_portal/evaluate.ts
src/legs/the_portal/nested.ts
src/legs/the_portal/paging.ts
src/legs/the_portal/container.ts
src/legs/the_portal/migrate.ts
src/legs/the_portal/reveal.ts
src/legs/the_portal/handoff.ts
src/legs/the_portal/fixtures.ts
src/legs/the_portal/stage.ts
src/legs/the_portal/copy.ts
tests/legs/the_portal/**
```

No other package writes to these paths and this package writes to no others.

---

## Report back

1. The commit or branch, and the full `tests/legs/the_portal/` output.
2. Both golden playthrough hashes, host and guest, and the files they are checked in at, plus the
   golden full-run result.
3. The frozen fixtures, as a table: the nested scheduling table; the double-paging counts and
   fault rates under both policies; the pre-copy rounds and downtime under all four migration
   configurations; the consolidation figures and the per-guest tax; the three reveal moment ticks;
   the eleven beat ticks.
4. **Confirmation from WP-11 that `Kernel` is constructible twice, that `snapshot()` holds no
   functions, and that `restore()` is exact**, with the `DET-D2` result for the guest.
5. The per-leg opaque save slot as agreed with WP-17, and confirmation that the guest snapshot
   round-trips through save and load.
6. The handoff contract as agreed with WP-17: how `status` is set, how the score is finalised, how
   the pending-decision sweep works, and what the profile write carries. Include the sweep count
   from the golden full run and name any leg that left a pending record.
7. The `ScoreBreakdown` reading you shipped: `total` carrying both multipliers, `classMultiplier`
   carrying one, and the difficulty factor read from `RunState.difficulty` by panel 2. Confirm
   WP-17 agrees.
8. The thirteen foreshadowing plants, as a table, with the leg, the tick they fired on the golden
   run, and confirmation that each is recorded as it fires rather than reconstructed. Name any
   plant whose leg had not shipped and what you did.
9. How the container escape degrades at low quality without implying sequential compromise, agreed
   with WP-14.
10. The full command registry walk result at leg 13, with any command from any earlier leg that
    was not registered.
11. Whether leg 12's `escalation_outcome` and `privilege_excess` records were present, what the
    `'reached_ring_zero'` path produced, and the pending items if leg 12 had not shipped.
12. Draw calls at each of the three quality tiers at the heaviest frame; the Moment C
    frame-comparison result; and **the final aperture reference screenshots at all three tiers**,
    with confirmation that the convoy is individually identifiable in each.
13. Any place where the curriculum map, the narrative bible, the visual bible and the sim spec
    disagreed, what you did, and which document you followed.
14. Confirmation that no file outside the owned list was created or modified, that `sync`,
    `deadlock`, `storage` and `fs` are off in both kernels, that no frozen union or interface was
    extended, and that nothing mechanical carries across runs.

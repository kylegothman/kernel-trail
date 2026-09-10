# WP-L00: The Boot Sector

Leg id `boot_sector`, index 0. Subtitle: *Everything you want is on the other side of a trap.*

**Legs are independent and may be built concurrently.** This package touches no other leg,
imports from no other leg, and shares no source file with any other leg. Build it against the
frozen contracts and the engine packages named in Prerequisites, and nothing else.

---

## Objective

When this is done there is a module at `src/legs/boot_sector/` that exports a single object
implementing the frozen `Leg` interface, and the leg is playable end to end: the player picks a
disc class, outfits the convoy through six depot windows using syscall traps, and leaves with a
resource ledger that the rest of the run is built on.

This leg carries a second job no other leg has. It is the game's tutorial. It teaches the
player how to read the world, how to use the focus camera, how to open the terminal, how to read
the HUD and how to open the codex, and it teaches all of that diegetically while teaching
chapters 1 and 2. The onboarding sequence is specified below and is part of the deliverable.

Nothing dies in the Boot Sector. That is a design constraint, not an omission.

---

## Prerequisites

**Engine work packages that must be complete and frozen:**

| Package | Why this leg needs it |
|---|---|
| WP-01 Determinism core | `Rng`, event bus, `seq` allocation, snapshot and restore. |
| WP-02 Process and PCB layer | The convoy's five Programs are real PCBs from tick 0. |
| WP-03 Scheduler registry | The CPU pillar shows one occupant slab; `fcfs` must exist. |
| WP-11 Syscall interface | The whole leg is syscall traps. `EPERM`, `ENOMEM`, `EINVAL`, argument validation and the 4-cycle mode-switch charge live here. |
| WP-17 Run state and ledger | `RunState`, `ResourceLedger`, `DiscClass`, the convoy roster. |
| WP-19 Leg runner and travel loop | `populate` and `evaluate` are called by the runner. |
| WP-15 Terminal shell | `man` dispatch, command registration, history. |
| WP-17 HUD and codex | Ledger meters and codex entry plumbing. |
| WP-12 Renderer core | Materials, design tokens, post chain. |
| WP-13 Focus camera | The onboarding sequence teaches it. |
| WP-13 World structures | Grid floor writer, stele, ring geometry, depot housing. |
| WP-20 Headless smoke-test runner | Required by the acceptance criteria. |

**Kernel subsystems that must be working:** `process` and `scheduler` only, plus the syscall
table. Memory, virtual memory, sync, deadlock, storage, I/O, file system and security are all
inert in this leg and must remain inert.

---

## Required reading

Read these sections and no others. Reading ahead is not useful here and costs you time.

- `docs/00-DESIGN-BRIEF.md`, sections 2, 3, 5, 6, 7, 8, 10, 11.
- `docs/05-CURRICULUM-MAP.md`, "Leg 0. THE BOOT SECTOR" in full, and section 0.1 (the three
  citation corrections against the frozen types).
- `docs/04-NARRATIVE-BIBLE.md`, section 4 (the disc classes), section 5 (resource economy,
  especially 5.2 starting allocations and 5.6 the underflow clause), section 8 leg 0 event
  table, section 10 (depots, especially 10.2 on why leg 0 is requisition rather than a depot),
  section 14 (the codex).
- `docs/03-VISUAL-BIBLE.md`, section 10 "Leg 0, The Boot Sector", section 6 (the focus camera),
  section 11 (HUD design), section 13 (quality tiers).
- `docs/02-KERNEL-SIM-SPEC.md`, section 14 (system call interface, Ch. 2.3) in full, and
  section 3 (process management) sections 3.1 to 3.3.

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
  { chapter: 1, title: 'Introduction',
    sections: ['1.1', '1.2.1', '1.2.2', '1.3.1', '1.4.1', '1.4.2', '1.5', '1.6', '1.10.1'] },
  { chapter: 2, title: 'Operating-System Structures',
    sections: ['2.1', '2.2', '2.3', '2.3.1', '2.3.2', '2.3.3', '2.4', '2.8.1', '2.8.2', '2.9'] },
];
```

Section 1.7 (virtualization) is named once in the vendor-string event and deliberately left
unexplained. The Portal pays it off. Do not explain it here.

### Learning objectives

Copy this array verbatim into `src/legs/boot_sector/objectives.ts`. Do not reword the
statements; the debrief and the end-of-run report quote them.

```ts
export const objectives: readonly LearningObjective[] = [
  {
    id: 'obj.boot_sector.acquire_via_trap',
    statement: 'Acquires every starting resource by issuing a syscall trap at the depot rather than by writing to the resource pool directly, finishing outfitting with zero EPERM results in the syscall log.',
    chapter: { chapter: 2, title: 'Operating-System Structures', sections: ['2.3', '2.3.1'] },
    assessedBy: 'terminal_command',
  },
  {
    id: 'obj.boot_sector.mode_switch_budget',
    statement: 'Completes outfitting with total mode-switch overhead under 40 cycles while still leaving the Boot Sector with at least 120 cycles, 24 quota, 30 blocks and 40 bandwidth.',
    chapter: { chapter: 1, title: 'Introduction', sections: ['1.4.1', '1.4.2'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.boot_sector.classify_privilege',
    statement: 'Labels each of the six depot services as requiring kernel mode or user mode before purchasing it, and gets at least five of six right.',
    chapter: { chapter: 1, title: 'Introduction', sections: ['1.4.1'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.boot_sector.balanced_ledger',
    statement: 'Leaves the Boot Sector with no resource category at zero, so no later leg opens with a category already exhausted.',
    chapter: { chapter: 1, title: 'Introduction', sections: ['1.5'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.boot_sector.consult_manual',
    statement: 'Resolves at least two unfamiliar depot terms with `man` before committing cycles to them.',
    chapter: { chapter: 2, title: 'Operating-System Structures', sections: ['2.2'] },
    assessedBy: 'terminal_command',
  },
  {
    id: 'obj.boot_sector.disc_class_tradeoff',
    statement: 'Selects a disc class and, at the confirmation gate, names which resource that class is short of, matching the class table.',
    chapter: { chapter: 1, title: 'Introduction', sections: ['1.5'] },
    assessedBy: 'decision',
  },
];
```

### Codex entries this leg adds to `codexUnlocked`

| Id | One line |
|---|---|
| `codex.os_role` | What an operating system does: allocator, control program, and the thing that runs when nothing else may. |
| `codex.dual_mode` | The mode bit, why it is hardware, and what a mode switch costs. |
| `codex.syscall_trap` | The trap mechanism, argument validation, and why batching matters. |
| `codex.resource_ledger` | Cycles, quota, blocks and bandwidth, and which kernel resource each stands for. |
| `codex.kernel_structure` | Monolithic, layered and microkernel structures, and what each trades away. |

### Misconceptions this leg must break

**"A system call is just a library function with a fancy name."** Build the break into the
first purchase. Offer the identical acquisition twice on the same window: once as a direct
reach at the stack of blocks, once through the trap. The direct reach returns `EPERM` and costs
nothing. The trap succeeds and costs 4 cycles, and the cycle meter must be on screen and must
visibly tick down. The cost is the evidence that something structural happened. Do not narrate
this. Let the meter do it.

**"The operating system is a program that runs alongside my program, like a background
service."** The break is `mode --history` combined with the CPU pillar, which has exactly one
occupant slab. While the convoy stands idle at the depot the pillar holds a Program and the
kernel cycle counter does not move. It moves only in the four-tick intervals around each trap.
A player who believes the kernel is always running expects a steady drain and sees a flat line
with spikes. The kernel cycle counter must therefore be a visible world object with a readable
history, not a HUD number.

**"Kernel mode means being logged in as root or administrator."** Place the break at the disc
class gate. Whichever class the player picks, show the same Program entering ring 0 during a
trap and leaving it 4 cycles later, with its identity and its domain unchanged across both. The
`mode` man page states the distinction in the same words the world just demonstrated.
`codex.dual_mode` holds it for the Arbiter Wall eleven legs later.

---

## The onboarding sequence

This is the specification for the tutorial. It runs in eight beats. Each beat has an entry
condition, a thing the world does, a thing the player must do, and an exit condition. No beat
may be skipped on a first run; every beat may be skipped once the profile records one completed
Boot Sector. Nothing in this sequence is a modal dialogue and nothing in it is a tooltip
tutorial overlay. Every instruction is a diegetic object or a line of terminal output.

### Beat 1: nothing exists

**Entry:** run start.
**World:** black void. A single ring of light under the convoy, 4.00 m radius, and nothing
beyond it in any direction including down. Five stele stand in the ring, unlit, matte.
**Player must:** nothing. This beat is 3 seconds long and it is the only non-interactive beat.
**Exit:** the grid floor begins writing itself.

### Beat 2: the floor writes itself

**Entry:** beat 1 timer expires.
**World:** the hero visual of the leg. The grid floor writes itself outward from beneath the
convoy's feet, ring by ring on the 4.00 m module, at a rate tied to the boot sequence, until it
reaches the horizon. Concentric rings stack vertically at decreasing radius as they rise. As
each subsystem comes up, a cyan accent arrives on the corresponding ring. This is the only time
in the game the player sees the floor being created, and it is where they learn the scale of
the module.
**Player must:** nothing, but camera orbit is added here and the world rewards looking
around. If the player does not move the camera within 6 seconds, one distant ring lights on the
opposite side of the convoy, which reliably makes people turn.
**Exit:** the floor reaches the horizon.

### Beat 3: the convoy lights

**Entry:** floor complete.
**World:** the five stele light in roster order: LUMEN, SABLE, ORRERY, KESTREL, VESPER. Each
takes 400 ms. As each lights, its name and role etch into its cap, and the HUD convoy panel
gains one row.
**Player must:** click one stele.
**Exit:** the focus camera locks to that stele head-on and orthographic, with labels
billboarded to the lock plane, showing the Program's role, passive, active ability and
vulnerability. This is the first focus lock in the game and it teaches the camera by using it.
Releasing the lock is the only thing the player has to work out, and the release affordance is
a lit ring at the base of the framing.

### Beat 4: the reach

**Entry:** focus released.
**World:** a stack of storage blocks sits within arm's reach, deliberately closer than the
depot, deliberately lit warmer than everything else, deliberately labelled `blocks`.
**Player must:** reach for them. Most players do. If the player has not reached within 20
seconds, a convoy Program walks toward the stack and stops, which is enough.
**Exit:** a hard stop, a single line of text, `EPERM`, and no cycle charge. The error message
names its own topic, per the `man` contract: the line reads `EPERM. man EPERM.`

### Beat 5: the terminal

**Entry:** `EPERM` shown.
**World:** the terminal affordance lights for the first time, at the bottom edge, with a single
character prompt.
**Player must:** open the terminal and type something. Anything. The shell accepts any input
and, on an unrecognised command, prints `not a command. try: man`. This is the only hint the
game gives at this level of directness and it is given once.
**Exit:** the player runs `man EPERM`, which prints the EPERM page, which names `syscall` and
`mode` in its see-also line. Track this: it is the first of the two `man` invocations
`obj.boot_sector.consult_manual` needs.

### Beat 6: the trap

**Entry:** the player has read at least one man page.
**World:** the depot at the end of the plate opens. Six windows, each with a two-way
kernel/user toggle and a service behind it. The queue is drawn on the ground in front.
**Player must:** make one purchase through a window. The window shows the trap cost of 4 cycles
before the player commits, and the cycle meter is on screen.
**Exit:** a successful `syscall.invoked` with `result.ok === true`. The world shows the Program
entering ring 0 at the window, staying 4 ticks, and leaving. The kernel cycle counter on the
CPU pillar moves for exactly those 4 ticks and then stops.

### Beat 7: the batching lesson

**Entry:** first successful purchase.
**World:** the depot's own signage states the rule once, in the register of a posted price and
not of a tutorial: `Trap: 4 cycles. Per submission. Any size.`
**Player must:** complete outfitting. Nothing forces batching. A player who traps six times
pays 24 cycles of pure overhead and a player who traps twice pays 8, and both are legal.
**Exit:** the player closes the requisition.

### Beat 8: the disc class gate

**Entry:** requisition closed.
**World:** three discs on a plinth: shell, daemon, compiler. Each states its ledger and its
`classMultiplier` openly. The confirmation gate asks one question: which resource is this class
short of. The three correct answers are given in the narrative bible's class table.
**Player must:** pick a class and answer the question. A wrong answer does not block the gate.
It is recorded against `obj.boot_sector.disc_class_tradeoff` and it costs nothing else.
**Exit:** the leg ends and `evaluate()` runs.

Beats 3, 5 and 8 are the three that also teach interface. Beat 3 teaches the focus camera, beat
5 teaches the terminal and `man`, and beat 8 teaches that a decision is recorded and will be
scored. The codex affordance lights the first time an entry adds, which is at the end of
beat 6, and it does not light before then.

---

## Kernel configuration

Return exactly this. Every field is required by the frozen contract; the ones this leg does not
teach are set to inert defaults and their subsystems are absent from `enabledSubsystems`.

```ts
export function kernelConfig(run: RunState): KernelConfig {
  return {
    seed: run.seed,                        // determinism: the run's seed, never a fresh one
    scheduler: 'fcfs',                     // no scheduling lesson here; simplest visible policy
    schedulerParams: {
      quantum: 8,                          // steady pace default; the pass teaches quantum, not this leg
      agingInterval: 0,                    // aging is a leg 3 concept and must not appear here
      starvationThreshold: 120,            // present so the field is valid; nothing starves in 40 ticks
      starvationFatalThreshold: 300,       // nothing can die in this leg, and 300 > leg length
      preemptive: false,                   // fcfs is non-preemptive; keeps the CPU pillar readable
    },
    totalFrames: 64,                       // inert: 'memory' is not enabled
    pageSize: 4096,                        // inert
    replacementPolicy: 'lru',              // inert: 'vm' is not enabled
    allocationStrategy: 'first_fit',       // inert
    tlbEntries: 16,                        // inert
    diskPolicy: 'look',                    // inert: 'storage' is not enabled
    totalCylinders: 200,                   // inert
    raidLevel: null,                       // inert, and null is the honest value
    fileAllocation: 'indexed',             // inert: 'fs' is not enabled
    journalingEnabled: false,              // inert, and false costs nothing
    deadlockStrategy: 'ignore',            // inert: 'deadlock' is not enabled
    thrashingThreshold: 200,               // inert: 'vm' is not enabled
    enabledSubsystems: ['process', 'scheduler'],
  };
}
```

`enabledSubsystems` is `['process', 'scheduler']` and nothing else. The syscall table is part
of the kernel core rather than a subsystem, so `syscall.invoked` events fire without enabling
anything further. This is the smallest configuration in the game and it is deliberate: the leg
teaches five terms and the teaching surface must be that small.

---

## Population

Five processes, one per convoy Program, bound to their members. No workload processes: the Boot
Sector is the only leg where the convoy is alone on the machine, which is what makes the CPU
pillar's flat kernel counter readable.

```ts
export function populate(ctx: LegSetupContext): void {
  const roster: readonly [ConvoyMemberId, string, number][] = [
    ['lumen',   'LUMEN',   2],
    ['sable',   'SABLE',   2],
    ['orrery',  'ORRERY',  3],
    ['kestrel', 'KESTREL', 3],
    ['vesper',  'VESPER',  3],
  ];

  roster.forEach(([member, name, priority], i) => {
    const pid = ctx.spawn({
      name,
      priority,
      burst: 4,        // one trap's worth of work, so the pillar occupancy reads as one trap
      service: 12,     // three bursts across the leg; nothing here runs long
      arrival: i * 2,  // staggered so beat 3's lighting order matches the process table order
      pages: 4,        // recorded on the PCB, never paged: 'memory' is not enabled
    });
    ctx.bind(member, pid);
  });
}
```

No `declareResource` and no `declareSync` calls. There are no resources to contend for and no
primitives to acquire. If you find yourself wanting either, you are building a later leg.

The six depot windows are not processes. They are stage objects with an `InteractionDef` each,
and every purchase they make is a `SyscallRequest` submitted through `Kernel.syscall`. The six
services, their syscall, and their correct mode label are:

| Window | Service | Syscall | Correct mode | Notes |
|---|---|---|---|---|
| `win.quota` | Request memory quota | `brk` | kernel | Changes the process break. Privileged. |
| `win.blocks` | Requisition storage blocks | `open` then `write` | kernel | Touches the block device. Privileged. |
| `win.bandwidth` | Widen the I/O grant | `ioctl` | kernel | Device control. Privileged. |
| `win.manifest` | Open the convoy manifest | `open` | kernel | Any file open traps. Privileged. |
| `win.identity` | Read the convoy's own pid set | `getpid` | user | Readable without a trap on real hardware; the window says so and charges nothing. |
| `win.priority` | Set a Program's starting priority | `nice` | user | Lowering your own claim needs no privilege. Raising it does, and the window refuses that. |

Four of six are kernel and two are user. `obj.boot_sector.classify_privilege` needs five of six
correct, so the player may miss one. The two user-mode windows are the ones people get wrong,
which is the point.

Trap accounting, which the objectives are measured against:

- Every submission charges exactly 4 cycles, regardless of purchase size.
- A submission that returns `EPERM` charges the 4 cycles anyway.
- A submission that returns `EINVAL` charges the 4 cycles anyway.
- A direct reach outside a window returns `EPERM` and charges nothing, because no trap was
  raised. This asymmetry is the whole first misconception, and it must be exact.

Six separate submissions cost 24 cycles of overhead. Two batched submissions cost 8. The
objective floor is under 40, which a player reaches by trapping fewer than ten times, so it is
generous and it still fails a player who submits one item at a time across every window twice.

---

## Stage

Build the stage in `src/world`, called from `createStage`. The leg module holds anchor ids and
camera targets; it holds no Three.js.

**Form.** Concentric rings, stacked vertically, of decreasing radius as they rise.
**Accent.** `SLATE.primary` at `dim`, with cyan arriving as subsystems come up.
**Environment.** You are inside the machine before it has finished drawing itself. There is no
floor at the start. There is a single ring of light under the convoy and blackness beyond it in
every direction, including down.
**Hero visual.** The grid floor writing itself outward from beneath the convoy's feet, ring by
ring on the 4.00 m module, at a rate tied to the boot sequence, until it reaches the horizon.

### Diegetic structures and their anchors

| Anchor id | Structure | Focus camera target |
|---|---|---|
| `anchor.plate` | The cold circuitry plate the convoy assembles on, 4.00 m module grid | wide establishing framing, no lock |
| `anchor.cpu_pillar` | The CPU column, one occupant slab, one kernel cycle counter etched up its face with a scrolling history | head-on orthographic, counter face fills the plane |
| `anchor.depot` | The requisition housing, six windows in a row, queue drawn on the ground | head-on, all six windows in frame |
| `anchor.win.quota` … `anchor.win.priority` | One anchor per window, each carrying its mode toggle and its posted trap cost | head-on, single window, toggle and price legible |
| `anchor.block_stack` | The stack of storage blocks within arm's reach. The beat 4 trap. | none; this is reached at, not inspected |
| `anchor.disc_plinth` | Three discs, each with its ledger and multiplier posted | head-on, three discs side by side |
| `anchor.convoy.lumen` … `anchor.convoy.vesper` | One anchor per Program stele | head-on, cap etching legible; this is the beat 3 lock |
| `anchor.ring_stack` | The concentric ring structure rising above the plate, one ring per subsystem coming up | orbit only |

The kernel cycle counter at `anchor.cpu_pillar` is load-bearing for the second misconception.
It must show history, not just a current value, and the history must be flat between traps.
Draw it as a vertical strip of etched marks up the pillar face, one mark per tick the kernel
held the processor, so a run of traps reads as isolated clusters against blank stone.

---

## Interactions

```ts
export const interactions: readonly InteractionDef[] = [
  {
    id: 'boot.trap_purchase',
    label: 'Submit request',
    description: 'Raise a trap at this window. Costs 4 cycles whatever you ask for.',
    anchor: 'anchor.depot',
    cost: { cycles: 4 },
    enabledWhen: (run) => run.resources.cycles >= 4,
  },
  {
    id: 'boot.set_mode',
    label: 'Set mode for this request',
    description: 'Choose kernel or user before submitting. The wrong choice returns EPERM and still costs the trap.',
    anchor: 'anchor.depot',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'boot.batch_request',
    label: 'Add to this submission',
    description: 'Add another item to the pending request. One trap carries as many items as you put in it.',
    anchor: 'anchor.depot',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'boot.direct_reach',
    label: 'Take the blocks',
    description: 'Reach for the stack directly.',
    anchor: 'anchor.block_stack',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'boot.inspect_program',
    label: 'Inspect Program',
    description: 'Lock the camera to one Program and read its role, passive, ability and vulnerability.',
    anchor: 'anchor.plate',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'boot.read_cycle_counter',
    label: 'Read the kernel counter',
    description: 'Lock to the CPU pillar and read how many ticks the kernel has actually held the processor.',
    anchor: 'anchor.cpu_pillar',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'boot.choose_disc',
    label: 'Choose a disc class',
    description: 'Sets the starting ledger and the score multiplier for the whole run.',
    anchor: 'anchor.disc_plinth',
    cost: {},
    enabledWhen: () => true,
  },
];
```

`boot.direct_reach` costs nothing and that is not an oversight. It is the control condition for
the trap cost.

---

## Terminal commands

Three commands, copied verbatim from the curriculum map into
`src/legs/boot_sector/commands.ts`. The manual text is the teaching and it must not be
paraphrased, shortened or reformatted.

```ts
export const terminalCommands: readonly TerminalCommandDef[] = [
  {
    name: 'man',
    usage: 'man <topic>',
    summary: 'Read the manual page for a command, a concept or an error code.',
    manual: [
      'man prints the manual page for a topic. A topic is a command name (man ps), a',
      'concept (man syscall), or an error code (man EPERM).',
      '',
      'Manual pages in this system are written to be read before you need them, which is',
      'not how anyone reads them. Reading one after a failure is the normal case and is',
      'expected. Every error message printed by this shell names the topic that explains',
      'it, so the error itself tells you what to type next.',
      '',
      'A manual page never tells you which choice to make. It tells you what the choice',
      'costs. The codex, which fills in as you encounter things, is where remedies live.',
      '',
      'See also: syscall, mode, codex.',
    ].join('\n'),
    chapter: { chapter: 2, title: 'Operating-System Structures', sections: ['2.2'] },
  },
  {
    name: 'syscall',
    usage: 'syscall <name> [args...]',
    summary: 'Issue a system call directly and print the result and its cost.',
    manual: [
      'syscall submits a request to the kernel on your behalf and prints what came back.',
      '',
      'A system call is not a function call. A function call jumps to another address in',
      'your own address space and costs a few ticks. A system call raises a trap: the',
      'processor stops executing your code, switches from user mode to kernel mode, runs',
      'kernel code that validates every argument you passed because it trusts none of',
      'them, switches back, and resumes you. That round trip is the mode-switch cost, and',
      'this shell charges you 4 cycles for it whether you asked for one block or one',
      'hundred. Batch your requests.',
      '',
      'The kernel validates arguments because a system call is the only door between code',
      'that may do anything and code that may not. If the kernel trusted your arguments,',
      'the door would not be a door.',
      '',
      'Results come back as ok with a value, or as an errno. Common errnos here:',
      '  EPERM   you asked for something your current mode does not permit',
      '  ENOMEM  the resource exists but there is not enough of it',
      '  EINVAL  the arguments were malformed; the trap still cost you 4 cycles',
      '',
      'Examples:',
      '  syscall brk 12          request 12 more quota',
      '  syscall open manifest   open the convoy manifest, returns a descriptor',
      '',
      'See also: mode, man EPERM.',
    ].join('\n'),
    chapter: { chapter: 2, title: 'Operating-System Structures', sections: ['2.3', '2.3.1', '2.3.2'] },
  },
  {
    name: 'mode',
    usage: 'mode [--history]',
    summary: 'Report the current processor mode and, with --history, every switch this leg.',
    manual: [
      'mode prints whether the processor is currently executing in user mode or kernel',
      'mode, and which Program it is executing on behalf of.',
      '',
      'There is one processor and one mode bit. When the bit says kernel, the running code',
      'may touch any memory and issue any instruction. When it says user, a large set of',
      'instructions fault instead of executing. The bit is hardware. No program can set it',
      'by asking politely; it flips on a trap, on an interrupt, and on nothing else.',
      '',
      'This is worth being precise about because two different ideas are often confused.',
      'Kernel mode is a processor state that lasts microseconds. An administrator account',
      'is a policy label that lasts for a login session. They are unrelated. The same',
      'Program in this convoy enters kernel mode dozens of times per leg and is never an',
      'administrator.',
      '',
      'mode --history prints every switch this leg with the cause: trap, interrupt, or',
      'return. If the count surprises you, that is the lesson. The kernel is not running',
      'alongside your Programs. It is running only in these intervals.',
      '',
      'See also: syscall, ring (available later).',
    ].join('\n'),
    chapter: { chapter: 1, title: 'Introduction', sections: ['1.4.1', '1.4.2'] },
  },
];
```

The shell also needs man pages for the topics these three name: `EPERM`, `ENOMEM`, `EINVAL`,
`codex`. Those are error and concept topics rather than commands, so they belong to the shell's
topic table in WP-15 and not to this leg. File a note against WP-15 if they are missing.

---

## Event table

Copied verbatim from `04-NARRATIVE-BIBLE.md` section 8, leg 0. Weights sum to 100. Draws happen
every 10 ticks of travel.

```ts
export const bootSectorEvents: readonly RandomEventDef[] = [
  {
    id: 'boot.firmware_handoff',
    weight: 16,
    title: 'Clean Handoff',
    narration: 'The firmware finishes its self-test and hands control over without an error line. Whatever it did not have to retry is time the convoy keeps.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 40 },
    onlyIf: null,
  },
  {
    id: 'boot.misread_vector',
    weight: 14,
    title: 'Misread Vector',
    narration: 'An interrupt vector is loaded one entry off and the handler runs against the wrong device. The Substrate corrects it silently and bills the convoy for the attempt.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -30 },
    onlyIf: null,
  },
  {
    id: 'boot.mode_switch_tax',
    weight: 15,
    title: 'Mode Switch Tax',
    narration: 'Every request the convoy makes crosses from user mode into the kernel and back. The crossing is cheap and there are a great many of them.',
    targets: null, inflicts: null,
    resourceDelta: { bandwidth: -4 },
    onlyIf: null,
  },
  {
    id: 'boot.vendor_string',
    weight: 10,
    title: 'Vendor String',
    narration: 'The sign-on banner names a machine model nobody in the Boot Sector recognises, with a version suffix after it. VESPER copies it down and does not say why.',
    targets: 'cartographer', inflicts: null,
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'boot.syscall_overcharge',
    weight: 14,
    title: 'Trap Overcharge',
    narration: 'The requisition desk charges the full trap cost for a call that was serviced from cache. There is no counter to complain at.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -35 },
    onlyIf: null,
  },
  {
    id: 'boot.surplus_requisition',
    weight: 17,
    title: 'Surplus Requisition',
    narration: 'A workload that was scheduled to launch this cycle did not, and its frames are unassigned. The desk issues them to the convoy without comment.',
    targets: null, inflicts: null,
    resourceDelta: { quota: 60 },
    onlyIf: null,
  },
  {
    id: 'boot.dual_mode_drill',
    weight: 14,
    title: 'Dual Mode Drill',
    narration: 'The convoy runs the privilege boundary drill twice and clears it twice. The Substrate widens their I/O grant on the strength of it.',
    targets: null, inflicts: null,
    resourceDelta: { bandwidth: 8 },
    onlyIf: null,
  },
];
```

`boot.vendor_string` is the one seeded line about virtualization. It inflicts nothing, changes
nothing, and is picked up thirteen legs later. Do not add an explanation to it.

---

## Evaluation

### Survival

`survived` is always `true`. `casualties` is always the empty array. There is no death in the
Boot Sector by design; permadeath with no information is punishment rather than teaching. Write
this as an explicit constant with a comment naming the design decision, so nobody later
"fixes" it.

### Objectives, each computed from simulator state

| Objective | Computed from |
|---|---|
| `obj.boot_sector.acquire_via_trap` | The leg's syscall log contains at least six `syscall.invoked` events with `result.ok === true` and zero with `errno === 'EPERM'`. |
| `obj.boot_sector.mode_switch_budget` | Cycles charged to trap overhead is under 40, **and** the closing ledger meets all four floors: `cycles >= 120`, `quota >= 24`, `blocks >= 30`, `bandwidth >= 40`. |
| `obj.boot_sector.classify_privilege` | At least five of the six windows had their mode toggle set correctly at the moment of the first submission through that window. Later corrections do not count; the objective is about labelling before purchasing. |
| `obj.boot_sector.balanced_ledger` | `min(cycles, quota, blocks, bandwidth) > 0` at `evaluate()`. |
| `obj.boot_sector.consult_manual` | The terminal history contains two or more `man` invocations naming distinct topics, both issued before the first successful purchase of that topic's resource. |
| `obj.boot_sector.disc_class_tradeoff` | The confirmation gate's recorded answer matches the class table row for the chosen class. |

Trap overhead is `4 * (count of syscall.invoked events raised through a depot window)`. Count
`EPERM` and `EINVAL` results in that total, because the trap happened. Do not count the direct
reach, because no trap happened.

### Resource delta

`resourceDelta` returns the net change the leg produced beyond what the interactions already
charged: the summed event-table deltas, plus the disc class starting allocation if the runner
does not apply it. Coordinate with WP-17 on which side applies the class allocation and write
a test that asserts it is applied exactly once.

### Codex added

All five entries are added unconditionally at leg end: `codex.os_role`, `codex.dual_mode`,
`codex.syscall_trap`, `codex.resource_ledger`, `codex.kernel_structure`. This is the only leg
that adds its full set unconditionally, because the encounter condition for all five is
"finished outfitting" and every player does.

### Debrief card

The failure in the Boot Sector is deferred and it is real. State the closing ledger against the
recommended floors and say which leg each shortfall will be felt in, without saying how to fix
it.

```ts
const debrief: DebriefCard = {
  headline: 'Outfitted.',
  whatHappened:
    `You raised ${trapCount} traps and paid ${trapCount * 4} cycles for the crossings alone. ` +
    `You left the Boot Sector with ${c} cycles, ${q} quota, ${b} blocks and ${bw} bandwidth.`,
  whyItHappened:
    'Every resource on this plate was on the other side of a trap. A trap costs the same ' +
    'whether it carries one item or a hundred, because what you are paying for is the mode ' +
    'switch and the argument validation, not the goods.',
  counterfactual: /* see below */,
  chapter: { chapter: 2, title: 'Operating-System Structures', sections: ['2.3', '2.3.1'] },
};
```

The counterfactual is computed, not authored. Three cases, in priority order:

1. **Trap overhead above 24 cycles.** `"The same purchases in two submissions would have cost 8
   cycles of overhead instead of ${trapCount * 4}. That difference is ${trapCount * 4 - 8}
   cycles, and the Quantum Pass costs 175 at steady pace."`
2. **Quota below 24.** `"You are carrying ${q} quota. The Fork Fields needs enough to hold five
   address spaces plus the scouts you will create there."` Do not say how many. The player finds
   out.
3. **Nothing short of a floor.** `null`. A player who cleared every floor gets no
   counterfactual, and the absence is itself the signal.

Only one counterfactual is shown. Rank by the size of the shortfall against the floor.

---

## Acceptance criteria

Numbered and mechanically verifiable. Each one is a test or a build assertion.

1. `src/legs/boot_sector/index.ts` default-exports an object that satisfies `Leg` under
   `tsc --strict`, with `id === 'boot_sector'` and `index === 0`.
2. The leg runs headlessly to completion through the WP-20 smoke-test harness with no
   renderer, no DOM and no Three.js import reachable from the leg module graph.
3. `kernelConfig(run).enabledSubsystems` deep-equals `['process', 'scheduler']`. A test asserts
   the array contents, not just the length.
4. A test asserts that no field of the returned `KernelConfig` other than `seed`, `scheduler`,
   `schedulerParams` and `enabledSubsystems` is read by the leg or by the kernel during a full
   headless run, by running the leg twice with every inert field mutated and asserting
   byte-identical event logs.
5. `populate` spawns exactly five processes and binds exactly five convoy members, with no
   `declareResource` and no `declareSync` calls. Asserted by spying on `LegSetupContext`.
6. A known-good decision sequence meets all six objectives. The sequence is recorded as a
   fixture and given in Tests below.
7. A known-bad decision sequence produces the intended failure: six separate traps and an
   all-cycles purchase leaves quota under 24, fails `obj.boot_sector.mode_switch_budget` and
   `obj.boot_sector.balanced_ledger`, and produces counterfactual case 2.
8. `survived === true` and `casualties.length === 0` for every input, including the worst
   possible play. Asserted over 200 randomised decision sequences.
9. Trap accounting is exact: a submission returning `EPERM` charges 4 cycles; a direct reach
   charges 0. Asserted directly.
10. The event table's weights sum to exactly 100 and every `id` is unique across the table.
11. All three terminal command `manual` strings match the curriculum map byte for byte. Assert
    against a checked-in fixture copied from the document, so a reword fails the build.
12. All five codex ids are added, and every added id exists in the codex registry.
13. Draw calls stay under the tier budget: 220 at low, 450 at medium, 900 at high. Measured on
    the stage at its heaviest frame, which is the last ring of the beat 2 floor write with all
    five stele lit and the depot open.
14. The floor-write hero visual completes in a bounded time at every quality tier and the
    completion is driven by the boot sequence rather than by wall clock, so a slow machine does
    not desynchronise the beat sequence.
15. The onboarding sequence runs all eight beats on a fresh profile and is skippable in full on
    a profile that records one completed Boot Sector. Asserted by driving the runner with both
    profile states.

---

## Tests you must write

All under `tests/legs/boot_sector/`. This directory is owned exclusively by this package.

**`tests/legs/boot_sector/contract.test.ts`**
- The exported object satisfies `Leg`; `id`, `index`, `title`, `subtitle` are exact.
- `chapters` deep-equals the curriculum map array.
- `objectives` has six entries with the exact ids listed above, and every `chapter.sections`
  entry is a string that appears in `chapters`.

**`tests/legs/boot_sector/config.test.ts`**
- `enabledSubsystems` deep-equals `['process', 'scheduler']`.
- Inert-field independence: mutate `totalFrames`, `pageSize`, `replacementPolicy`,
  `allocationStrategy`, `tlbEntries`, `diskPolicy`, `totalCylinders`, `raidLevel`,
  `fileAllocation`, `journalingEnabled`, `deadlockStrategy` and `thrashingThreshold`, run 400
  ticks, and assert the canonical event log hash is unchanged.
- `schedulerParams.agingInterval === 0` and `preemptive === false`.

**`tests/legs/boot_sector/populate.test.ts`**
- Five spawns, five binds, zero resource and sync declarations.
- Arrival ticks are `0, 2, 4, 6, 8` and the bound member order matches the roster.

**`tests/legs/boot_sector/traps.test.ts`**
- A successful submission charges 4 cycles and emits one `syscall.invoked` with
  `result.ok === true`.
- An `EPERM` submission charges 4 cycles and emits `syscall.invoked` with `errno === 'EPERM'`.
- An `EINVAL` submission charges 4 cycles.
- A direct reach at `anchor.block_stack` emits `syscall.invoked` with `errno === 'EPERM'` and a
  cost of 0, and the ledger is unchanged.
- Batching: one submission carrying six items charges 4 cycles total. Six submissions of one
  item each charge 24.

**`tests/legs/boot_sector/evaluate.test.ts`**
- Each of the six objectives, met and not met, from a constructed `LegEvaluationContext`.
- `survived` is true across 200 randomised sequences.
- Counterfactual selection: case 1 when overhead exceeds 24, case 2 when quota is under 24 and
  overhead is at or under 24, `null` when every floor is cleared. Assert the priority order
  when both case 1 and case 2 apply.

**`tests/legs/boot_sector/golden.test.ts`**: the golden headless playthrough.
- Fixture: `seed: 0x4b54524c`, `discClass: 'shell'`, `difficulty: 'operator'`.
- The known-good decision sequence, recorded as an ordered array of interaction ids and
  arguments:
  1. `boot.inspect_program` on `lumen`
  2. `man EPERM`
  3. `man syscall`
  4. `boot.direct_reach`
  5. `boot.set_mode` kernel on `win.quota`, `boot.batch_request` quota 40,
     `boot.batch_request` blocks 40, `boot.trap_purchase`
  6. `boot.set_mode` kernel on `win.bandwidth`, `boot.batch_request` bandwidth 50,
     `boot.batch_request` manifest, `boot.trap_purchase`
  7. `boot.set_mode` user on `win.identity`, `boot.trap_purchase`
  8. `boot.set_mode` user on `win.priority`, `boot.trap_purchase`
  9. `boot.choose_disc` shell, answer `blocks`
- Assert: all six objectives met, trap overhead 16 cycles, closing ledger clears all four
  floors, five codex entries added, `survived === true`, and the full canonical event log
  hash matches a checked-in golden file.
- Assert the golden file is stable across two runs in the same process and across a
  snapshot-restore at the midpoint.

**`tests/legs/boot_sector/badpath.test.ts`**: the known-bad sequence.
- Six separate single-item submissions, all cycles spent on quota, no `man` invocations, wrong
  mode on four windows.
- Assert: `obj.boot_sector.mode_switch_budget` not met, `obj.boot_sector.consult_manual` not
  met, `obj.boot_sector.acquire_via_trap` not met (four `EPERM` results), counterfactual case 2,
  and still `survived === true` with zero casualties.

**`tests/legs/boot_sector/manuals.test.ts`**
- Each `manual` string equals the fixture copied from `05-CURRICULUM-MAP.md`.
- Every `See also:` topic named in a manual resolves in the shell's topic table.

**`tests/legs/boot_sector/stage.test.ts`** (runs under the headless renderer rig)
- Every anchor id listed in the Stage section resolves to a non-null object.
- Every `InteractionDef.anchor` resolves.
- Draw call count at the heaviest frame is under 220 / 450 / 900 at low / medium / high.

---

## Out of scope

- Do not touch any other leg. Do not import from `src/legs/*` other than your own directory.
- Do not modify `src/game/types.ts` or `src/kernel/types.ts`. They are frozen. If you believe
  you need a change, stop and escalate; every other leg in flight depends on them.
- Do not modify anything under `src/kernel`, `src/render`, `src/world`, `src/terminal`,
  `src/ui`, `src/audio`, `src/design`, `src/platform` or `src/app`. If a shared structure you
  need is missing from `src/world`, file it against WP-13 rather than adding it here.
- Do not add man pages for error and concept topics; those belong to WP-15's topic table.
- Do not enable a subsystem this leg does not teach, and specifically do not enable `memory`
  because quota appears on the HUD. Quota is a ledger number here, not a frame table.
- Do not add a death path. Do not add a depot; leg 0 is requisition, not a depot.
- Do not explain virtualization.

### Files this package owns exclusively

```
src/legs/boot_sector/index.ts
src/legs/boot_sector/chapters.ts
src/legs/boot_sector/objectives.ts
src/legs/boot_sector/config.ts
src/legs/boot_sector/populate.ts
src/legs/boot_sector/interactions.ts
src/legs/boot_sector/commands.ts
src/legs/boot_sector/events.ts
src/legs/boot_sector/evaluate.ts
src/legs/boot_sector/onboarding.ts
src/legs/boot_sector/windows.ts
src/legs/boot_sector/stage.ts
src/legs/boot_sector/copy.ts
tests/legs/boot_sector/**
```

No other package writes to these paths and this package writes to no others.

---

## Report back

When the package is complete, report:

1. The commit or branch, and the output of the full `tests/legs/boot_sector/` run.
2. The golden playthrough hash and the file it is checked in at.
3. Measured draw calls at each of the three quality tiers, at the heaviest frame.
4. The trap overhead, closing ledger and objective results for both the known-good and the
   known-bad sequences, as a table.
5. Any place where the curriculum map, the narrative bible and the visual bible disagreed, what
   you did, and which document you followed. The design brief wins over all three.
6. Anything you needed from WP-15's topic table, WP-13's structure library or WP-17's ledger
   that was missing, as a list of filed items rather than as local workarounds.
7. Confirmation that no file outside the owned list was created or modified.

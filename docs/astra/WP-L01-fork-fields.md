# WP-L01: The Fork Fields

Leg id `fork_fields`, index 1. Subtitle: *Everything you create is yours until you collect it.*

**Legs are independent and may be built concurrently.** This package touches no other leg,
imports from no other leg, and shares no source file with any other leg.

---

## Objective

A module at `src/legs/fork_fields/` implementing the frozen `Leg` interface, playable end to
end. The convoy crosses a wide plain by forking scouts, retasking them with `exec`, choosing an
IPC channel at three data crossings, and reaping every child it created. The process table has
16 slots, the leg needs 11 live processes at its peak, and roughly five unreaped children jam
it.

This is the first leg with a real system, the first affliction and the first avoidable death.

---

## Prerequisites

**Engine work packages:** WP-01 Determinism core, WP-02 Process and PCB layer (the whole of
it: `fork`, `exec`, `wait`, `exit`, the zombie state, reparenting to init, the fixed-size
process table), WP-03 Scheduler registry, WP-11 Syscall interface, WP-17 Run state and
ledger (afflictions and epitaphs), WP-19 Leg runner, WP-15 Terminal shell, WP-17 HUD and
codex, WP-12 Renderer core, WP-13 Focus camera, WP-13 World structures (stele, address-space
lattice cages, inverted-normal shell for the zombie), WP-14 Derezz and tombstones, WP-20
Smoke-test harness.

**Kernel subsystems:** `process` and `scheduler`. The process table must enforce a hard 16-slot
limit and return `EAGAIN` on overflow, zombies must hold slots until reaped, and orphans must
reparent to init and be reaped immediately. IPC channels (shared memory and message passing)
must be costed by the kernel rather than by the leg.

---

## Required reading

- `docs/00-DESIGN-BRIEF.md`, sections 5, 6, 7, 9.
- `docs/05-CURRICULUM-MAP.md`, "Leg 1. THE FORK FIELDS" in full.
- `docs/02-KERNEL-SIM-SPEC.md`, section 3 (process management, Ch. 3) in full, especially 3.1
  to 3.3 and the state transition table; section 14 for the `fork`, `exec`, `wait`, `exit` and
  `kill` handlers.
- `docs/04-NARRATIVE-BIBLE.md`, section 7 entries for `orphaned` and `memory_leak`; section 8
  leg 1 event table; section 9 tombstone epitaphs for `out_of_memory`; section 10 (the leg 1
  depot).
- `docs/03-VISUAL-BIBLE.md`, section 10 "Leg 1, The Fork Fields"; section 9 (the derezz
  effect); section 13 (quality tiers).

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
  { chapter: 3, title: 'Processes',
    sections: ['3.1.1', '3.1.2', '3.1.3', '3.2.1', '3.2.2', '3.2.3',
               '3.3.1', '3.3.2', '3.4.1', '3.4.2', '3.5', '3.6.1', '3.6.2'] },
];
```

### Learning objectives

```ts
export const objectives: readonly LearningObjective[] = [
  {
    id: 'obj.fork_fields.reap_every_child',
    statement: 'Reaps every exited child with wait, so the process table holds zero entries in the zombie state when the leg ends.',
    chapter: { chapter: 3, title: 'Processes', sections: ['3.3.2'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.fork_fields.read_the_pcb',
    statement: 'Uses ps -l on a blocked Program, names the PCB field that records what it is blocked on, and unblocks it by satisfying that condition rather than by killing and respawning it.',
    chapter: { chapter: 3, title: 'Processes', sections: ['3.1.3'] },
    assessedBy: 'terminal_command',
  },
  {
    id: 'obj.fork_fields.state_transitions',
    statement: 'Returns a waiting Program to ready by completing the event it waits on, producing a waiting-to-ready transition in the event log with no intervening new state.',
    chapter: { chapter: 3, title: 'Processes', sections: ['3.1.2'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.fork_fields.switch_budget',
    statement: 'Crosses the fields in under 90 context switches by choosing the batched scouting route over the interleaved one.',
    chapter: { chapter: 3, title: 'Processes', sections: ['3.2.3'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.fork_fields.ipc_channel_choice',
    statement: 'Assigns shared memory to the one high-volume transfer and message passing to the two low-volume ones, keeping total IPC cost under 25 cycles.',
    chapter: { chapter: 3, title: 'Processes', sections: ['3.4.1', '3.4.2', '3.5', '3.6.1'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.fork_fields.no_orphans',
    statement: 'Ends the leg with zero Programs carrying the orphaned affliction, either by reaping before the parent exits or by reparenting the child.',
    chapter: { chapter: 3, title: 'Processes', sections: ['3.3.2'] },
    assessedBy: 'survival',
  },
  {
    id: 'obj.fork_fields.exec_replaces',
    statement: 'Uses exec to replace a scout Program image in place when the task changes, rather than forking a second scout, keeping the live process count at or under 8.',
    chapter: { chapter: 3, title: 'Processes', sections: ['3.3.1'] },
    assessedBy: 'decision',
  },
];
```

### Codex entries this leg adds to `codexUnlocked`

`codex.process_concept`, `codex.pcb`, `codex.process_states`, `codex.context_switch`,
`codex.fork_exec`, `codex.zombie_orphan`, `codex.ipc_models`.

conditions for adding them, so entries arrive on encounter rather than on completion:

| Entry | Added when |
|---|---|
| `codex.process_concept` | First `process.created` event of the leg. |
| `codex.pcb` | First `ps -l` invocation. |
| `codex.process_states` | The first `process.state_changed` into `waiting`. |
| `codex.context_switch` | `SchedulingMetrics.contextSwitches` first exceeds 20. |
| `codex.fork_exec` | First `exec` syscall. |
| `codex.zombie_orphan` | First PCB enters `zombie`, or `fork` first returns `EAGAIN`, whichever is first. |
| `codex.ipc_models` | First `ipc --bind`. |

### Misconceptions this leg must break

**"fork returns once, and the child starts from the top of the program."** The split gate is
built to be visually unambiguous: one runner enters, two leave, both from the same point on the
road, both carrying the same partially completed task, each with a different number lit on its
disc. Then give the player a branch that can only be resolved by reading that number, so
proceeding requires accepting that both copies are executing the same instruction at the same
place with different return values. There must be no way to pass the gate under the wrong model.

**"A zombie is a runaway process eating CPU."** Place the break at the moment `fork` first
returns `EAGAIN`. The player's instinct is to look for something consuming resources. `top`
shows every zombie at 0.0% CPU with the processor 40% idle. `ps` shows 14 of 16 slots used and
5 of them in `zombie`. The resource that ran out is a table, and the leg makes the player find
that out by elimination.

**"Killing the zombie fixes it."** Let the player make it. `kill` on a zombie returns success
and nothing changes. The success is the teaching, because it forces the question of what a
signal is delivered to. The `kill` man page answers it in one sentence and points at `wait`,
and the decision log marks the attempt so the debrief can show the player the sequence they
typed.

---

## Kernel configuration

```ts
export function kernelConfig(run: RunState): KernelConfig {
  return {
    seed: run.seed,
    scheduler: 'fcfs',                     // carried from the Boot Sector; policy is not this leg's lesson
    schedulerParams: {
      quantum: quantumForPace(run.policy.pace),  // 16/8/4/2, from the pace table
      agingInterval: 0,                    // aging belongs to leg 3 and must not appear here
      starvationThreshold: 120,            // present and valid; nothing starves under fcfs on this workload
      starvationFatalThreshold: 300,
      preemptive: false,                   // fcfs; makes the context switch count legible
    },
    totalFrames: 64,                       // inert: 'memory' is not enabled. Quota is a ledger number.
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

`enabledSubsystems` is `['process', 'scheduler']`. Address spaces exist on the PCB as
`addressSpaceId` and are drawn as lattice cages, and no frame table is simulated. That is the
correct reading of the brief: leg 1 teaches that two processes cannot read each other's memory,
and leg 7 teaches how that is implemented.

The process table size of 16 is a property of WP-02's process layer, not a `KernelConfig`
field. Assert it rather than set it.

---

## Population

Peak live process count is 11 against a 16-slot table. The convoy is five, the field workload
is three, and the player creates up to three scouts.

```ts
export function populate(ctx: LegSetupContext): void {
  // The convoy. Bound, so their deaths are narrative.
  const roster: readonly [ConvoyMemberId, string, number, number, number][] = [
    // member,      name,      priority, burst, service
    ['lumen',   'LUMEN',   2, 6, 40],
    ['sable',   'SABLE',   2, 5, 34],
    ['orrery',  'ORRERY',  3, 5, 34],
    ['kestrel', 'KESTREL', 3, 4, 28],
    ['vesper',  'VESPER',  3, 5, 34],
  ];
  roster.forEach(([member, name, priority, burst, service], i) => {
    const pid = ctx.spawn({ name, priority, burst, service, arrival: i, pages: 6 });
    ctx.bind(member, pid);
  });

  // The field workload. Unbound; these are the machine's own processes.
  ctx.spawn({ name: 'field.survey',   priority: 4, burst: 8, service: 48, arrival: 6,  pages: 5 });
  ctx.spawn({ name: 'field.beacon',   priority: 5, burst: 3, service: 60, arrival: 10, pages: 3 });
  ctx.spawn({ name: 'field.collector',priority: 4, burst: 6, service: 44, arrival: 14, pages: 4 });
}
```

No `declareResource` and no `declareSync`. There is no contention in the Fork Fields; that
starts at the Narrows.

### Scouts

Scouts are created by the player at split gates, through `fork`, at runtime. They are not
spawned in `populate`. Each scout costs quota and gets its own `addressSpaceId`. Three split
gates exist. Each fork produces a child with:

```ts
{ name: `scout.${gateId}.${n}`, priority: 4, burst: 3, service: 18, arrival: currentTick, pages: 4 }
```

A scout exits when it reports back, at 18 ticks of service. Its PCB then enters `zombie` and
holds its slot until the parent calls `wait`.

### The retasking post

`exec` at the retasking post replaces a scout's image in place. The PCB keeps its pid, its
parent and its `addressSpaceId`; the name changes to `scout.retasked.${n}` and `service`
resets to 18. `pstree` must show the tree unchanged in shape and changed in label, which is
the whole `fork` against `exec` distinction.

### The three data crossings

| Crossing | Messages | Correct channel | Cost under shared memory | Cost under message passing |
|---|---|---|---|---|
| `crossing.survey_dump` | 9 | shared memory | 8 cycles setup, 0 per message = 8 | 0 setup, 3 per message = 27 |
| `crossing.beacon_ping` | 2 | message passing | 8 | 6 |
| `crossing.route_ack` | 3 | message passing | 8 | 9 |

The correct assignment costs 8 + 6 + 9 = 23 cycles, which is under the objective's 25. Every
other assignment costs more: all shared memory costs 24, all message passing costs 42, and the
inverted assignment costs 43. The 25 threshold therefore admits exactly the correct assignment
and the all-shared-memory case, and the all-shared-memory case is a defensible reading of the
same rule, so it passes. Do not tighten the threshold to exclude it.

### The two routes

`obj.fork_fields.switch_budget` needs the batched route to come in under 90 context switches
and the interleaved route to come in over it. Tune the workload arrivals so that, at steady
pace, the batched route lands near 70 and the interleaved route near 115. Record both numbers
as fixtures once the first correct implementation establishes them, and freeze them.

---

## Stage

**Form.** Stele, many of them, in rows on the module grid.
**Accent.** `CYAN.core`.
**Environment.** A flat plain of parent stele, each budding smaller child stele that grow to
full height over their arrival window. Address spaces are drawn as faint lattice cages that are
shared (thin, cyan) or copied (solid, brighter) depending on whether the fork copied or shared,
which is the whole `fork` lesson in one visual difference.
**Hero visual.** An unreaped zombie: a stele whose emission has gone entirely, whose faces have
inverted normals so it reads as a hole punched in the world, standing in a field of lit
processes that flow around it. The grid floor beneath it does not draw. It will not clear until
the parent calls `wait`.

| Anchor id | Structure | Focus camera target |
|---|---|---|
| `anchor.plain` | The field, rows of stele on the module grid | wide establishing, no lock |
| `anchor.gate.a`, `anchor.gate.b`, `anchor.gate.c` | The three split gates. One runner in, two out, same point on the road, different disc numbers | head-on, both children and the parent in frame, disc numbers legible |
| `anchor.retask_post` | The `exec` post | head-on, the image label plate legible |
| `anchor.crossing.survey_dump`, `.beacon_ping`, `.route_ack` | The three data crossings, each with a channel selector and a posted message count | head-on, channel costs and message count legible |
| `anchor.table_board` | The process table drawn as 16 physical slots, occupied slots lit, zombie slots as inverted-normal holes | head-on orthographic; this is the leg's most important lock |
| `anchor.zombie.<pid>` | One anchor per zombie stele, created on demand | head-on, the hole and the unlit floor beneath it |
| `anchor.depot` | The leg 1 depot | head-on, six services |
| `anchor.convoy.<member>` | Per-Program stele | head-on |

`anchor.table_board` is what makes the second misconception break work. The player must be able
to look at 16 slots, count 14 occupied and 5 inverted, and reason about a table rather than
about CPU. Draw the slot count as physical objects, never as a HUD number.

---

## Interactions

```ts
export const interactions: readonly InteractionDef[] = [
  {
    id: 'fork.split',
    label: 'Fork a scout',
    description: 'Create a copy of this Program at this point in its execution. Costs quota for the new address space.',
    anchor: 'anchor.gate.a',
    cost: { quota: 6, cycles: 4 },
    enabledWhen: (run) => run.resources.quota >= 6,
  },
  {
    id: 'fork.exec_retask',
    label: 'Replace the image',
    description: 'Load a different program into this process. The pid, the parent and the address space stay.',
    anchor: 'anchor.retask_post',
    cost: { cycles: 4 },
    enabledWhen: (run) => run.resources.cycles >= 4,
  },
  {
    id: 'fork.bind_channel',
    label: 'Bind this transfer to a channel',
    description: 'Shared memory costs 8 cycles once and nothing per message. Message passing costs nothing to set up and 3 cycles per message.',
    anchor: 'anchor.crossing.survey_dump',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'fork.choose_route',
    label: 'Choose the scouting route',
    description: 'Batched sends every scout at once and collects them together. Interleaved sends and collects one at a time.',
    anchor: 'anchor.plain',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'fork.inspect_table',
    label: 'Read the process table',
    description: 'Lock to the table board and read every slot and its state.',
    anchor: 'anchor.table_board',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'fork.reparent',
    label: 'Reparent to init',
    description: 'Hand this child to the first process, which reaps continuously. It costs you the parent.',
    anchor: 'anchor.table_board',
    cost: { bandwidth: 4 },
    enabledWhen: (run) => run.resources.bandwidth >= 4,
  },
];
```

Reaping is done from the terminal with `wait`, not from an interaction. That is deliberate: the
`wait` man page is the teaching and the player has to go and read it.

---

## Terminal commands

Five commands, copied verbatim from the curriculum map into
`src/legs/fork_fields/commands.ts`: `ps`, `wait`, `kill`, `pstree`, `ipc`. The full `manual`
text for each is in `docs/05-CURRICULUM-MAP.md`, "Leg 1. THE FORK FIELDS", "Terminal commands
introduced". Copy it byte for byte. A test asserts the match against a checked-in fixture, so a
reword fails the build.

Load-bearing lines you must not lose in transcription:

- `ps`: "A process in waiting will never be helped by giving it more processor time. Look at
  BLOCKED and satisfy that instead." This is the whole of `obj.fork_fields.read_the_pcb`.
- `wait`: "A zombie uses no processor time at all. Check it with top: it sits at zero percent
  forever." This is the second misconception's answer.
- `kill`: "A process killed with -s kill while holding a mutex does not release the mutex. You
  will meet this again at the ford." This is a forward reference to leg 4 and it must survive.
- `ipc`: "many small messages favour message passing, few large ones favour shared memory.
  Count before you bind."

`top` is introduced in leg 2 and is not this leg's command. The second misconception break
needs `top`, so `top` must already be in the base shell by the time this leg ships. Confirm
with WP-15; if `top` is leg-2-only, escalate rather than adding a second copy here.

---

## Event table

Copied verbatim from `04-NARRATIVE-BIBLE.md` section 8, leg 1. Weights sum to 100.

```ts
export const forkFieldsEvents: readonly RandomEventDef[] = [
  {
    id: 'fork.bomb',
    weight: 12,
    title: 'Uncontrolled Fork',
    narration: 'A process at the field edge forks, and its children fork, and the process table fills in under thirty ticks. The convoy loses the frames before anyone reaches a terminal.',
    targets: null, inflicts: null,
    resourceDelta: { quota: -110 },
    onlyIf: null,
  },
  {
    id: 'fork.unreaped_child',
    weight: 15,
    title: 'Nobody Called Wait',
    narration: 'A parent in the convoy exits with a child still running, and the child keeps going under a domain it was not written for. It will finish and nobody will collect it.',
    targets: null, inflicts: 'orphaned',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'fork.zombie_field',
    weight: 13,
    title: 'Zombie Field',
    narration: 'Four hundred exited processes are still holding table entries because their parents never read their status. The Substrate will not release the memory until somebody asks for it.',
    targets: null, inflicts: null,
    resourceDelta: { quota: -70 },
    onlyIf: null,
  },
  {
    id: 'fork.pipe_found',
    weight: 15,
    title: 'Open Pipe',
    narration: 'An abandoned pipe between two dead processes is still mapped and still readable. KESTREL routes convoy traffic through it for the rest of the leg.',
    targets: 'courier', inflicts: null,
    resourceDelta: { bandwidth: 10 },
    onlyIf: null,
  },
  {
    id: 'fork.context_switch_toll',
    weight: 14,
    title: 'Switch Toll',
    narration: 'The convoy is preempted eleven times crossing a single ridge and pays register-save cost on every one. None of the preemptions were wrong.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -45 },
    onlyIf: null,
  },
  {
    id: 'fork.exec_overlay',
    weight: 16,
    title: 'Clean Overlay',
    narration: 'LUMEN replaces a bloated image in place instead of spawning beside it, and the old address space goes back to the free list intact. It is the cheapest thing that happens all leg.',
    targets: 'compiler', inflicts: null,
    resourceDelta: { cycles: 50, quota: 30 },
    onlyIf: null,
  },
  {
    id: 'fork.shared_segment',
    weight: 15,
    title: 'Shared Segment',
    narration: 'Two convoy Programs map the same region rather than copying it. The saving is not large and it is the correct decision.',
    targets: null, inflicts: null,
    resourceDelta: { quota: 45 },
    onlyIf: null,
  },
];
```

---

## Evaluation

### Survival

The leg is survived when at least one convoy Program is alive at leg end. A Program dies when
its integrity reaches zero. The path there is: the process table fills, `fork` returns
`EAGAIN`, the scout that would have found the route is never created, and the Program that
needed it acquires `orphaned` (2 integrity per travel tick, fatal after 60 in this leg's
instance of the affliction; the ambient table value of 0.4 per tick and no fatal clock is the
out-of-leg baseline and this leg overrides it, per the curriculum map). At zero integrity the
Program derezzes with `TerminationReason: 'out_of_memory'`, because what ran out was kernel
table space rather than user memory.

`casualties` is the list of `ConvoyMemberId`s whose bound PCB has a non-null
`terminationReason` at leg end.

### Objectives

| Objective | Computed from |
|---|---|
| `obj.fork_fields.reap_every_child` | No PCB in the closing `KernelSnapshot` has `state === 'zombie'`, **and** the event log contains a `process.reaped` event for every `process.exited` event. Both halves are required; the second catches a table that was cleared by killing parents. |
| `obj.fork_fields.read_the_pcb` | A `ps -l` invocation on a PCB with a non-null `blockedOn` is followed, before any `kill` on that pid, by the syscall that satisfies that `BlockReason`. |
| `obj.fork_fields.state_transitions` | The event log contains a `process.state_changed` from `waiting` to `ready` on a convoy pid with no `new` state in between. |
| `obj.fork_fields.switch_budget` | `SchedulingMetrics.contextSwitches < 90` at `evaluate()`. |
| `obj.fork_fields.ipc_channel_choice` | The shared-memory channel is bound to the 9-message transfer **and** total cycles charged to IPC is under 25. |
| `obj.fork_fields.no_orphans` | Zero convoy members carry the `orphaned` affliction at leg end. |
| `obj.fork_fields.exec_replaces` | At least one `exec` syscall was issued at the retasking post, **and** peak live process count stayed at or under 8. |

### The instructive wrong remedies

Both are available and both must work exactly as specified.

`kill <zombie-pid>` returns ok and changes nothing, because a signal delivered to a process
that has already exited is delivered to nobody. Record it in the decision log with
`kind: 'kill_zombie'` and leave `outcome: 'pending'`; the debrief names it.

`kill <parent-pid>` does clear the zombies, by reparenting them to the init Program which reaps
them immediately, and it costs the player the parent. Record it as `outcome: 'costly'`.

### Debrief card

```ts
{
  headline: /* 'The fields are crossed.' or 'The table filled.' */,
  whatHappened:
    `You forked ${forks} scouts and reaped ${reaps} of them. The table peaked at ${peak} of 16 ` +
    `slots with ${maxZombies} in zombie. You crossed in ${switches} context switches and spent ` +
    `${ipcCycles} cycles on interprocess transfers.`,
  whyItHappened:
    'A terminated process holds its table slot until its parent collects its exit status. The ' +
    'slot is kernel memory and the table is a fixed-size array, so the failure appears in a ' +
    'process that has nothing to do with the zombies.',
  counterfactual: /* computed, see below */,
  chapter: { chapter: 3, title: 'Processes', sections: ['3.3.2'] },
}
```

Counterfactual, in priority order:

1. **A Program died of `out_of_memory`.** `"wait -a at tick ${firstZombieTick} would have freed
   ${zombieCount} slots for 0 cycles. Killing the parent freed them for one Program."` Name the
   cheaper move without naming a keystroke sequence.
2. **`kill` was issued on a zombie.** `"You sent ${killCount} signals to processes that had
   already exited. Each returned ok. A signal reaches a process only while it exists."`
3. **Switch budget missed.** `"The batched route crosses in about ${batchedSwitches} switches.
   You took the interleaved route and paid ${switches}."`
4. **IPC assignment wrong.** `"Shared memory on the 9-message transfer and message passing on
   the other two costs 23 cycles. You paid ${ipcCycles}."`
5. Nothing wrong: `null`.

---

## Acceptance criteria

1. `src/legs/fork_fields/index.ts` satisfies `Leg` under `tsc --strict`, `id === 'fork_fields'`,
   `index === 1`.
2. The leg runs headlessly to completion via the WP-20 smoke-test harness, with no Three.js or
   DOM import reachable from the leg module graph.
3. `enabledSubsystems` deep-equals `['process', 'scheduler']`. No memory, vm, sync, deadlock,
   storage, io, fs or security subsystem is enabled.
4. Inert-field independence: mutating every `KernelConfig` field not named in the Kernel
   configuration section leaves the canonical event log hash unchanged over 400 ticks.
5. Every objective can be met by the known-good decision sequence; all seven met in one run.
6. The known-bad sequence produces the intended failure: the table fills, `fork` returns
   `EAGAIN`, one Program acquires `orphaned` and derezzes with `out_of_memory`, and the epitaph
   links `codex.zombie_orphan`.
7. `kill` on a zombie returns ok, emits `syscall.invoked { result.ok: true }`, and leaves the
   snapshot byte-identical apart from the syscall event itself.
8. `kill` on a parent reparents its zombie children to init and they are reaped within one tick.
9. Peak live process count reaches 11 on the known-good sequence and the table limit of 16 is
   enforced by the kernel, not by the leg.
10. Batched route lands under 90 context switches and interleaved lands over it, on the frozen
    fixture.
11. Correct IPC assignment costs exactly 23 cycles. All-shared costs 24, all-message costs 42.
12. Event table weights sum to exactly 100; all ids unique.
13. All five terminal command `manual` strings match the curriculum map byte for byte.
14. Draw calls stay under the tier budget of 220 / 450 / 900, measured at the heaviest frame,
    which is 11 live stele plus 5 zombie shells plus the 16-slot table board in frame.
15. The zombie hero visual renders with inverted normals and the grid floor beneath it does not
    draw, at all three tiers.

---

## Tests you must write

All under `tests/legs/fork_fields/`.

**`contract.test.ts`**: `Leg` conformance, exact ids, chapters array, seven objectives.

**`config.test.ts`**: `enabledSubsystems` exact; inert-field independence over 400 ticks;
`agingInterval === 0`; quantum follows the pace table.

**`populate.test.ts`**: eight spawns (five convoy plus three field), five binds, zero resource
and sync declarations, exact priorities and service values.

**`table.test.ts`**: the process table.
- 16 slots enforced; the 17th `fork` returns `EAGAIN`.
- A `process.exited` with no `process.reaped` leaves the PCB in `zombie` and the slot held.
- `wait <pid>` reaps one and frees one slot. `wait -a` reaps all reapable.
- `kill` on a zombie returns ok and frees nothing.
- `kill` on a parent reparents and init reaps within one tick.
- A zombie's CPU usage is exactly 0 for every tick it exists.

**`ipc.test.ts`**: the cost table.
- Shared memory: 8 cycles at bind, 0 per message. Message passing: 0 at bind, 3 per message.
- The four assignments cost 23, 24, 42 and 43 respectively.

**`routes.test.ts`**: batched under 90 switches, interleaved over 90, both frozen as fixtures.

**`evaluate.test.ts`**: each of the seven objectives, met and not met. Both halves of
`reap_every_child` tested separately, including the case where the table was cleared by killing
parents and the objective correctly fails.

**`golden.test.ts`**: the golden headless playthrough.
- Fixture: `seed: 0x4b54524c`, `discClass: 'shell'`, `difficulty: 'operator'`, steady pace,
  standard rations, entering with the leg 0 golden closing ledger.
- Known-good sequence: fork at gates a and b, `exec` retask at the post rather than forking at
  gate c, batched route, bind `survey_dump` to shared memory and the other two to message
  passing, `ps -l` on the blocked Program and satisfy its `BlockReason`, `wait -a` before
  leaving each gate.
- Assert: all seven objectives met, zero zombies at close, zero casualties, switches under 90,
  IPC cost 23, seven codex entries added, canonical event log hash matches the checked-in
  golden file, stable across two runs and across a snapshot-restore at the midpoint.

**`badpath.test.ts`**: the known-bad sequence.
- Fork at all three gates twice, never `wait`, interleaved route, all-message-passing IPC.
- Assert: table fills, `EAGAIN` observed, `orphaned` acquired, one derezz with
  `TerminationReason: 'out_of_memory'`, epitaph `codexEntry === 'codex.zombie_orphan'`,
  counterfactual case 1, and `survived === true` because four Programs remain.

**`manuals.test.ts`**: five manual strings against the curriculum map fixture; every
`See also:` topic resolves.

**`stage.test.ts`**: every anchor resolves; every `InteractionDef.anchor` resolves; draw calls
under the tier budgets at the heaviest frame.

---

## Out of scope

- Do not touch any other leg. Do not import from `src/legs/*` other than your own directory.
- Do not modify `src/game/types.ts` or `src/kernel/types.ts`.
- Do not modify anything under `src/kernel`, `src/render`, `src/world`, `src/terminal`,
  `src/ui`, `src/audio`, `src/design`, `src/platform` or `src/app`.
- Do not enable `memory`. Address spaces are drawn as lattice cages from `addressSpaceId`; no
  frame table is simulated here.
- Do not introduce a lock, a semaphore or any contention. The Narrows owns that.
- Do not add `top` to this leg's command list even though the misconception break uses it.
- Do not soften the 16-slot table or the `EAGAIN` path to make the leg friendlier. The jam is
  the lesson.

### Files this package owns exclusively

```
src/legs/fork_fields/index.ts
src/legs/fork_fields/chapters.ts
src/legs/fork_fields/objectives.ts
src/legs/fork_fields/config.ts
src/legs/fork_fields/populate.ts
src/legs/fork_fields/interactions.ts
src/legs/fork_fields/commands.ts
src/legs/fork_fields/events.ts
src/legs/fork_fields/evaluate.ts
src/legs/fork_fields/scouts.ts
src/legs/fork_fields/ipc.ts
src/legs/fork_fields/routes.ts
src/legs/fork_fields/stage.ts
src/legs/fork_fields/copy.ts
tests/legs/fork_fields/**
```

---

## Report back

1. Commit or branch, and the full `tests/legs/fork_fields/` output.
2. Golden playthrough hash and its checked-in path.
3. The frozen fixture values for batched and interleaved context switch counts, and the tick at
   which the table first reaches 16 on the bad path.
4. Draw calls at each tier at the heaviest frame.
5. Objective results for both the known-good and known-bad sequences, as a table.
6. Whether `top` was available in the base shell, and if not, the item filed against WP-15.
7. Any disagreement between documents, what you did, and which document you followed.
8. Confirmation that no file outside the owned list was created or modified.

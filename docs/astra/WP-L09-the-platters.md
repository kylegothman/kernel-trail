# WP-L09: The Platters

Leg id `the_platters`, index 9. Subtitle: *The arm only moves one way at a time.*

**Legs are independent and may be built concurrently.** This package touches no other leg,
imports from no other leg, and shares no source file with any other leg.

This leg sits immediately after the virtual memory spike and it is structurally a repeat of leg
3 with a new cost model. The player recognises the shape (a queue, a policy, a starvation risk)
within a minute and spends the leg transferring rather than learning. This is the leg where a
player who lost Programs in the Drowned Reach can stabilise, and its ambient affliction,
`bit_rot`, is the only one in the game that is never fatal.

It is also the leg that carries the game's only resurrection. See that section before you plan
the work.

---

## Objective

A module at `src/legs/the_platters/` implementing the frozen `Leg` interface, playable end to
end.

The Platters is a rotating disc the size of a plaza with a single arm suspended above it. The
convoy walks a catwalk above and to one side, so the player is always looking down at the
mechanism, and the convoy times its landings on a surface that is moving. Requests appear as lit
marks at cylinder positions and the arm travels to each in turn, in arrival order, because that
is the policy the convoy has been carrying since the Boot Sector. The arm crosses the whole
plaza, comes back, crosses it again. Meanwhile the convoy's swap reads are queued behind that
travel, and Programs that were fine in the Drowned Reach start blocking on pages they already
paid for.

All six disk scheduling policies are route choices, drawn as a lit polyline across the platter.
The player picks a RAID level at the array bay, survives a scripted device failure, and races a
rebuild against a scripted second failure.

---

## The only resurrection in the game

Every other loss in KERNEL TRAIL is permanent. A derezzed Program is gone, its passive is gone,
and the depot's recruitment service replaces it with a different Program: `LUMEN-2` rather than
LUMEN, at 60 percent of the passive, with one fewer ability charge per leg, once per run, and
the original tombstone stays in the gallery. That is a replacement.

The Platters carries the one exception, and it exists because the concept demands it. A Program
lost to `storage_corruption`, whose state is on the array, can be **rebuilt from parity**. Not
replaced. Rebuilt: the same Program, the same name, the same passive at full strength, the same
tombstone removed from the run's list rather than kept.

The conditions are strict and they are all statements about RAID rather than about generosity:

1. The Program's death reason is `storage_corruption`. Nothing else is on the array.
2. The array level provides redundancy. Level 0 provides none, so a Program lost under RAID 0 is
   lost, permanently, and the array bay says so before the purchase.
3. The array has not exceeded its failure tolerance. One failure at levels 1, 4, 5 and 10; two
   at level 6; two at 1 and 10 only when they are in different mirror pairs.
4. The rebuild completes. `raid.rebuild` must reach `progress: 1.0`.
5. The rebuild completes **before the scripted second failure**. Inside the degraded window the
   array has no redundancy left, and the rebuild reads every block on every surviving device,
   which is exactly the workload most likely to expose a second failure.

If all five hold, the Program comes back at the tick the rebuild completes, at 40 integrity,
with its afflictions cleared and its ability charges reset. Its epitaph is removed from
`RunState.tombstones` and a `DecisionRecord` with `kind: 'raid_rebuild_recovery'` and
`outcome: 'good'` records what happened.

This matters more than the mechanic's frequency suggests. It is the only place in the game where
a loss is reversible, it is reversible for exactly one reason, and the reason is a concept the
player has to have understood in advance to have set up. A player who bought RAID 5 at the array
bay because the redundancy line made sense gets a Program back. A player who bought RAID 0
because it was fast does not, and the array bay told them, in plain terms, before they paid.

Coordinate the resurrection with WP-17 before you build. It writes to `RunState.convoy` and
`RunState.tombstones`, which are the game layer's, and it must not be implemented by mutating
them from the leg. Agree an interface and report it.

---

## Prerequisites

**Engine work packages that must be complete and green on the shared branch:**

| Package | Why this leg needs it |
|---|---|
| WP-01 | `Rng`, event bus, canonical serialiser. |
| WP-02 | Process table, PCB, `BlockReason` of kind `io`, kernel step order. |
| WP-03, WP-04 | Scheduler policies and the metrics the leg compares its own numbers against. |
| WP-05, WP-06 | Memory and virtual memory. The swap reads queued behind the arm are real page faults from the Reach's machinery. |
| **WP-09** | **The storage half of it, in full.** Disk geometry, all six scheduling policies, NVM, RAID at all six levels, rebuild, hot spare, scrubbing. This leg is WP-09's principal consumer. |
| WP-11 | Syscalls, snapshot and restore, the invariant set. |
| WP-12 | Renderer backend, post chain, design tokens, draw call budget. |
| WP-13 | Focus camera and the diegetic structure base classes. |
| WP-14 | World event router. `disk.queued`, `disk.seek`, `disk.served` and `raid.rebuild` must have visual treatments. |
| WP-15 | The terminal. |
| WP-17 | HUD, codex, save and load, **and the convoy mutation interface the resurrection needs**. |
| WP-18 | The counterfactual replay worker, for `seekq --compare` and the debrief. |

**Kernel subsystems that must be working:** `process`, `scheduler`, `memory`, `vm`, `storage`.

WP-09 must provide, exactly:

- All six `DiskSchedulingId` values, each reproducing its `DISK-*` fixture, with a settable
  initial head direction for the SCAN family.
- `DiskSchedulingPolicy.snapshot().projectedPath` as a real ordered cylinder list the world can
  draw.
- `disk.seek` carrying `from`, `to` and `distance`; `disk.served` carrying `waitTicks`.
- The three-term cost model: seek time, rotational latency, transfer time, per `DISK-COST-1`.
- An NVM device where head position is meaningless and request merging is available.
- RAID at levels 0, 1, 4, 5, 6 and 10, with the physical I/O counts of `RAID-1`, the write
  amplification of `RAID-2`, the failure survival of `RAID-3` and `RAID-4`, degraded reads, hot
  spare, rebuild with progress, and scrubbing.

Fixtures `DISK-FCFS-1`, `DISK-SSTF-1`, `DISK-SCAN-1`, `DISK-SCAN-2`, `DISK-LOOK-1`,
`DISK-LOOK-2`, `DISK-CSCAN-1`, `DISK-CSCAN-2`, `DISK-CLOOK-1`, `DISK-CLOOK-2`, `DISK-COST-1`,
`DISK-COST-2`, `DISK-NVM-1`, `DISK-NVM-2`, `RAID-1`, `RAID-2`, `RAID-3` and `RAID-4` must all
pass before this leg starts.

**Not required and must not be enabled:** `fs`. Inodes, directories, allocation methods, free
space and the journal all belong to leg 11. This leg deals in blocks and devices. The journal is
named once, in the `raid` man page's see-also line and in the array bay's warning about where
the journal lives, and it is not implemented here.

---

## Required reading

- `docs/05-CURRICULUM-MAP.md`, "Leg 9. THE PLATTERS" in full, including the note on how the 10th
  edition numbers the HDD scheduling subsections; section D, "Relief placement".
- `docs/02-KERNEL-SIM-SPEC.md`, **section 10 in full** (Mass storage, Ch. 11); section 16.9 (the
  `DISK-*` and `RAID-*` test vectors).
- `docs/04-NARRATIVE-BIBLE.md`, section 7 entries for `bit_rot` and `starvation`; section 8 leg 9
  event table; section 9 epitaphs for `io_timeout` and `storage_corruption`; section 10 (the leg
  9 depot, and 10.5 on recruitment, which the resurrection must be clearly distinguished from).
- `docs/03-VISUAL-BIBLE.md`, section 10 "Leg 9, The Platters"; section 8.2 (the snap on policy
  change); section 13 (quality tiers).

### A citation note

The 10th edition numbers the HDD scheduling subsections FCFS (11.2.1), SCAN (11.2.2) and C-SCAN
(11.2.3), and discusses SSTF within 11.2 without giving it its own number. The kernel exposes
`sstf`, `look` and `clook` alongside the numbered three. The codex marks LOOK and C-LOOK as the
practical variants described in 11.2.4 rather than as separate textbook sections. Cite them that
way in `codex.disk_scheduling` and in the `seekq` man page's chapter field.

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
  { chapter: 11, title: 'Mass-Storage Structure',
    sections: ['11.1.1', '11.1.2', '11.1.3',
               '11.2.1', '11.2.2', '11.2.3', '11.2.4',
               '11.3', '11.4', '11.5.1', '11.5.2', '11.6.1', '11.6.2',
               '11.8.1', '11.8.2', '11.8.3', '11.8.4', '11.8.5'] },
];
```

### Learning objectives

```ts
export const objectives: readonly LearningObjective[] = [
  {
    id: 'obj.the_platters.total_head_travel',
    statement: 'Reduces total head travel below 900 cylinders on the recorded request queue while no single request waits longer than 120 ticks.',
    chapter: { chapter: 11, title: 'Mass-Storage Structure', sections: ['11.2.1', '11.2.2', '11.2.3'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.the_platters.sstf_starves',
    statement: 'Recognises that shortest-seek-time-first is starving the far-edge request and switches to a SCAN-family policy before that request exceeds its deadline.',
    chapter: { chapter: 11, title: 'Mass-Storage Structure', sections: ['11.2.2', '11.2.4'] },
    assessedBy: 'survival',
  },
  {
    id: 'obj.the_platters.variance_choice',
    statement: 'Selects C-SCAN on the segment with uniform cylinder arrivals and shows waiting-time variance at least 30 percent below the SCAN baseline on the same queue.',
    chapter: { chapter: 11, title: 'Mass-Storage Structure', sections: ['11.2.3', '11.2.4'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.the_platters.nvm_has_no_arm',
    statement: 'Switches the NVM segment to FCFS with request merging on the grounds that head position is meaningless there, and keeps throughput above the SCAN baseline.',
    chapter: { chapter: 11, title: 'Mass-Storage Structure', sections: ['11.1.2', '11.3'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.the_platters.raid_level_choice',
    statement: 'Selects a RAID level that survives the scripted single-device failure with zero lost blocks while write amplification stays under two times.',
    chapter: { chapter: 11, title: 'Mass-Storage Structure', sections: ['11.8.1', '11.8.2', '11.8.3'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.the_platters.rebuild_window',
    statement: 'Completes the RAID rebuild before the scripted second failure, by spending blocks on a hot spare or by lowering foreground I/O for the duration.',
    chapter: { chapter: 11, title: 'Mass-Storage Structure', sections: ['11.8.4', '11.8.5'] },
    assessedBy: 'survival',
  },
];
```

### Codex entries this leg adds to `codexUnlocked`

`codex.storage_geometry`, `codex.disk_scheduling`, `codex.seek_starvation`, `codex.nvm`,
`codex.swap_space`, `codex.raid`, `codex.raid_rebuild`.

| Entry | Added when |
|---|---|
| `codex.storage_geometry` | The first `disk.seek` event. |
| `codex.disk_scheduling` | The first `seekq` invocation. Carries the ten-row fixture table as its worked example. |
| `codex.seek_starvation` | The edge request's `waitTicks` first exceeds 90 under `sstf`. Cross-links to `codex.priority_starvation` from leg 3. |
| `codex.nvm` | The NVM segment is entered. |
| `codex.swap_space` | The first `disk.queued` whose requester is blocked on a page fault. |
| `codex.raid` | The array bay is opened. |
| `codex.raid_rebuild` | The first `raid.rebuild` event. |

`codex.seek_starvation`'s whole content is that this is the same shape as priority starvation on
different hardware. Register the cross-link to `codex.priority_starvation` in both directions if
leg 3 has shipped; if it has not, register this side and report the pending link.

### Misconceptions this leg must break

**"SSTF is the best disk scheduler, because minimising seek time is the whole objective."**
Students learn the algorithms as a ranked list with SSTF near the top. The break is a starvation
death with a named victim: the leg's request stream is generated so that arrivals cluster in the
middle third, and one convoy read sits at cylinder 4. Under SSTF that read is never nearest.
`seekq` shows it at the top of the age column, climbing, while total head travel looks
excellent. The player is watching a good average kill a Program, which is the same lesson the
Quantum Pass taught with a different clock.

Build requirements:
- The request stream clusters in the middle third, generated deterministically from the leg's
  `Rng` fork so it is replayable.
- Exactly one convoy read sits at cylinder 4 and it is the convoy's, not the workload's, so its
  death has a name.
- `seekq` sorts its age column descending by default, so the starving request is the first line
  the player reads.
- Total head travel under `sstf` is genuinely and visibly excellent while this happens. Post
  both numbers at the arm console: total travel and worst wait, side by side, always.

**"RAID means the data is backed up."** This belief has destroyed real data and it survives
because redundancy and backup sound like the same idea. The break is scripted and blunt: at the
array bay the player is asked to delete a stale file to reclaim blocks, does so, and the
deletion appears on every mirror in the same tick, drawn as three devices updating together. The
array is perfectly healthy and the file is perfectly gone.

Build requirements:
- The deletion is a real block-level operation on the array, replicated to every member in the
  same tick, and the world draws all three devices updating simultaneously.
- The array's health readout stays green throughout. Nothing is wrong. That is the point.
- The `raid` man page states the distinction in its last paragraph and the codex entry links
  forward to the journal in the Archive, which addresses a different failure again. Register the
  forward link; do not implement the journal.

**"An SSD is a fast disk, so the same scheduling wins by a larger margin."** The break is a
measurement on the NVM segment. The player carries C-SCAN over from the platter segment and
throughput is worse than FCFS, which is counterintuitive until `iostat` shows why: there is no
arm, so reordering buys nothing, and the reordering itself adds queueing delay and breaks up
sequential runs that could have been merged.

Build requirements:
- `DISK-NVM-1` holds: the standard queue on `nvm0` gives identical completion ticks under all
  six policies. Reordering buys exactly nothing.
- Request merging is available on the NVM device and is what makes FCFS win: adjacent requests
  merge into one, and a reordered queue has fewer adjacencies to merge.
- The lesson generalises past storage and the codex says so: scheduling policies encode
  assumptions about the cost model, and moving them to hardware with a different cost model can
  make them worse than doing nothing.

---

## Kernel configuration

```ts
export function kernelConfig(run: RunState): KernelConfig {
  return {
    seed: run.seed,
    scheduler: 'rr',                       // the leg is not about CPU scheduling; rr keeps requesters interleaved
    schedulerParams: {
      quantum: quantumForPace(run.policy.pace),  // Ch. 5.3.3
      agingInterval: 0,                    // seek starvation must be cured by disk policy, not by CPU aging
      starvationThreshold: 120,
      starvationFatalThreshold: 300,
      preemptive: true,
    },
    totalFrames: 64,                       // back up from the Reach's 48; this leg is relief
    pageSize: 4096,                        // carried forward
    replacementPolicy: 'clock',            // carried forward as a sensible default; the player may still change it
    allocationStrategy: 'first_fit',       // inert under paging
    tlbEntries: 16,                        // carried forward
    diskPolicy: 'fcfs',                    // THE ENTRY VALUE IS DELIBERATE. The convoy has carried it since the Boot Sector.
    totalCylinders: 200,                   // matches every DISK-* fixture. Do not change it.
    raidLevel: null,                       // null until the player buys at the array bay. See the note.
    fileAllocation: 'indexed',             // inert: 'fs' is not enabled
    journalingEnabled: false,              // inert: 'fs' is not enabled
    deadlockStrategy: 'ignore',            // inert: 'deadlock' is not enabled
    thrashingThreshold: 200,               // real: swap reads still fault and the Reach's machinery is still live
    enabledSubsystems: ['process', 'scheduler', 'memory', 'vm', 'storage'],
  };
}
```

`enabledSubsystems` is `['process', 'scheduler', 'memory', 'vm', 'storage']`. `vm` stays enabled
because the leg's whole opening depends on it: the convoy's swap reads are real page faults from
the Reach's machinery, queued behind the arm, and Programs that were fine in the Drowned Reach
start blocking on pages they already paid for. That continuity is the join between the two legs
and it is why `codex.swap_space` is added on a `disk.queued` whose requester is blocked on a page
fault.

`fs` is not enabled. Leg 11 owns it.

Three entry values carry the leg's teaching:

- `diskPolicy: 'fcfs'` on entry. The convoy has carried it since the Boot Sector and nobody has
  had a reason to change it. The arm crosses the plaza, comes back, crosses it again.
- `totalCylinders: 200`. Every `DISK-*` fixture is computed at 200 cylinders. Changing it
  invalidates all ten path fixtures at once.
- `raidLevel: null` until the array bay. The array does not exist until the player buys it, and
  what they buy is the whole of `obj.the_platters.raid_level_choice`. Once bought, `raidLevel` is
  set through the kernel's configuration path rather than by rebuilding the config object.

---

## Population

```ts
export function populate(ctx: LegSetupContext): void {
  const roster: readonly [ConvoyMemberId, string, number, number, number, number][] = [
    // member,      name,      priority, burst, service, pages
    ['lumen',   'LUMEN',   2, 6, 64, 16],
    ['sable',   'SABLE',   2, 5, 58, 14],
    ['orrery',  'ORRERY',  3, 5, 58, 14],   // ORRERY's restore is what a lost array denies the player
    ['kestrel', 'KESTREL', 3, 4, 52, 12],   // halves seek cost and device latency while alive
    ['vesper',  'VESPER',  3, 5, 58, 13],
  ];
  roster.forEach(([member, name, priority, burst, service, pages], i) => {
    const pid = ctx.spawn({ name, priority, burst, service, arrival: i, pages });
    ctx.bind(member, pid);
  });

  // The platter's own traffic. Its cylinder distribution clusters in the middle third,
  // which is what starves the edge under sstf.
  for (let i = 0; i < 8; i++) {
    ctx.spawn({ name: `platter.client_${i}`, priority: 4, burst: 3, service: 70, arrival: 6 + i * 4, pages: 8 });
  }
}
```

No `declareResource` and no `declareSync`.

### The reference queue, verbatim from the sim spec

The arm console's `seekq --compare` and the leg's first segment both run the sim spec's standard
queue, so every number the player sees is checkable.

Queue: **98, 183, 37, 122, 14, 124, 65, 67.** Head at **53**. **200 cylinders.**

| Fixture | Policy | Direction | Path | Total head movement |
|---|---|---|---|---|
| `DISK-FCFS-1` | fcfs | n/a | 53, 98, 183, 37, 122, 14, 124, 65, 67 | **640** |
| `DISK-SSTF-1` | sstf | n/a | 53, 65, 67, 37, 14, 98, 122, 124, 183 | **236** |
| `DISK-SCAN-1` | scan | down | 53, 37, 14, 0, 65, 67, 98, 122, 124, 183 | **236** |
| `DISK-SCAN-2` | scan | up | 53, 65, 67, 98, 122, 124, 183, 199, 37, 14 | **331** |
| `DISK-LOOK-1` | look | down | 53, 37, 14, 65, 67, 98, 122, 124, 183 | **208** |
| `DISK-LOOK-2` | look | up | 53, 65, 67, 98, 122, 124, 183, 37, 14 | **299** |
| `DISK-CSCAN-1` | cscan | up | 53, 65, 67, 98, 122, 124, 183, 199, 0, 14, 37 | **382** |
| `DISK-CSCAN-2` | cscan | down | 53, 37, 14, 0, 199, 183, 124, 122, 98, 67, 65 | **386** |
| `DISK-CLOOK-1` | clook | up | 53, 65, 67, 98, 122, 124, 183, 14, 37 | **322** |
| `DISK-CLOOK-2` | clook | down | 53, 37, 14, 183, 124, 122, 98, 67, 65 | **326** |

Read that table before you tune anything. Three things in it are teaching and are easy to lose:

**The direction matters as much as the policy.** SCAN down is 236 and SCAN up is 331. LOOK down
is 208 and LOOK up is 299. The initial head direction is a player setting for a reason, and the
arm console must expose it as prominently as the policy itself.

**LOOK beats SCAN because it stops at the last request instead of the physical end.** 208 against
236, and 299 against 331, in both directions, from exactly the same service order. The man page
says these are what real drivers implement, and the fixture proves the saving is the two trips
to cylinder 0 and cylinder 199 that served nothing.

**SSTF and SCAN-down tie at 236 on this queue.** They do it with completely different service
orders and completely different worst waits. That coincidence is useful: it forces the player to
look past total travel, which is the entire first misconception. Make sure `seekq --compare`
prints total travel, average wait **and worst wait** for each policy, so the tie is visibly
broken by the third column.

`obj.the_platters.total_head_travel` requires total travel below 900 on the recorded queue with
no request waiting longer than 120 ticks. On the reference queue every policy except FCFS is
comfortably under 900, so the leg's own recorded queue must be longer than eight requests for
the objective to have teeth. Generate the leg's queue as a longer stream with the same clustered
distribution, freeze the resulting per-policy travel and worst-wait figures, and set the
objective against those.

### The cost model

`DISK-COST-1`: a 4 KB read with a seek distance of 50, at 7200 rpm, over a 100 MB/s transfer
path, costs seek 2.5 ms, rotation 4.1667 ms, transfer 0.0410 ms, total 6.7077 ms.

`DISK-COST-2`: at 0.5 ms per tick, that is **13 ticks**, and a zero-seek request costs **9
ticks**.

Post those two numbers at the arm console as the cost of a typical request, because they carry
the argument for why every one of these policies is about arm movement: seek is 2.5 ms of a
6.7 ms request and it is the only one of the three terms scheduling can reduce. Rotational
latency is 4.1667 ms and no policy here touches it, and transfer is 0.041 ms and is noise.

KESTREL halves seek cost while alive. That takes the 13-tick request to 11 ticks and the
convoy's whole I/O budget with it. It is the largest single passive effect in the leg and it is
why the convoy composition changes how this leg plays.

### The starving edge request

One convoy read sits at **cylinder 4**. Under `sstf`, with arrivals clustering in the middle
third, it is never nearest.

Its `waitTicks` climbs without bound. The Program blocked on it takes
`TerminationReason: 'io_timeout'` when the wait exceeds the device deadline. The epitaph cause
reads exactly:

> "its read sat at cylinder 4 for 380 ticks. Shortest-seek-time-first never chose it, because
> there was always something closer."

380 is a frozen fixture. Tune the arrival stream so that at steady pace, under `sstf`, with no
intervention, that request's `waitTicks` reaches 380 at the moment the deadline expires. If your
tuning produces a different number, change the tuning rather than the sentence.

`codexEntry` on the epitaph is `codex.seek_starvation`.

Note a discrepancy in the source documents and resolve it this way: the event
`platters.edge_starvation` narrates a request at cylinder 199, and the curriculum map's failure
mode places the convoy's starving read at cylinder 4. Both are correct and they are different
occurrences. The convoy's scripted read is at cylinder 4 and it is the one that kills. The event
describes an ambient request at the other edge and it inflicts `starvation` on whoever it
targets. Do not unify them.

### The NVM segment

A second device, `nvm0`, carrying the same standard queue.

`DISK-NVM-1`: identical completion ticks for all six policies. There is no arm, so reordering
buys nothing.

`DISK-NVM-2`: 1000 random 4 KB writes give write amplification above 3; 1000 sequential give
approximately 1.

Request merging is available on `nvm0` and is what makes FCFS win: adjacent requests merge into
one physical operation. A reordered queue has fewer adjacencies left to merge, so C-SCAN carried
over from the platter is measurably worse than doing nothing. `obj.the_platters.nvm_has_no_arm`
requires FCFS with merging and throughput above the SCAN baseline.

### The array bay

The player picks a `RaidLevel` at the array bay, optionally buys a hot spare with `blocks`, and
during the rebuild can lower foreground I/O to shorten the window.

`RAID-1`: one logical block write costs physical I/O of 1, 2, 4, 4, 6, 2 at levels 0, 1, 4, 5, 6
and 10.

`RAID-2`: a full-stripe write of `n-1` blocks under RAID 5 with n = 5 costs 5 I/O for 4 blocks, a
penalty of 1.25.

`RAID-3`: one disk failure loses data only at level 0. Read cost on the degraded array rises to
`n-1` at levels 4, 5 and 6.

`RAID-4`: two simultaneous failures are survivable only at level 6, and at levels 1 and 10 when
the failures are in different mirror pairs.

`obj.the_platters.raid_level_choice` requires zero lost blocks through the scripted single
failure **and** write amplification under 2.0. Read that against `RAID-1`: levels 4, 5 and 6
cost 4, 4 and 6 physical I/O per logical write, which is amplification of 4, 4 and 6 on small
writes and fails the objective outright. Levels 1 and 10 cost 2, which is exactly 2.0 and also
fails a strict "under two times" reading.

That is not an error in the objective, it is the reason `RAID-2` exists. Small writes on parity
arrays amplify badly and **full-stripe writes do not**: 5 I/O for 4 blocks is 1.25. So the
objective is met by choosing RAID 5 **and** arranging the convoy's writes as full stripes, which
is a decision the array bay must expose and the `raid` man page must explain. Build the write
pattern as a player-settable choice at the array bay, freeze the resulting amplification figures
for every level and both patterns, and assert that at least two configurations satisfy the
objective and several do not.

### The scripted failures

Two, at fixed ticks, and the gap between them is the rebuild window.

**Failure one** takes one device. Under level 0 the array is lost immediately, which is the
fastest possible run-ending event in the game and is why the array bay states each level's
redundancy in plain terms before the purchase. Under levels 1, 4, 5, 6 and 10 the array survives
and runs degraded, with read cost rising to `n-1` at the parity levels.

**Failure two** lands at a fixed tick after the first. If the rebuild has reached
`progress: 1.0`, the array survives it under any level with remaining tolerance. If the rebuild
is still running, the array is lost and the affected Programs derezz with
`TerminationReason: 'storage_corruption'`.

The rebuild window is shortened two ways, both real:

1. **A hot spare**, bought with `blocks`, so the rebuild starts immediately rather than waiting
   for a replacement device.
2. **Lowering foreground I/O** for the duration, so the rebuild gets more of the device's
   bandwidth. This costs the convoy travel progress and it is a genuine tradeoff.

Freeze the rebuild duration at each level, with and without a hot spare, and at each foreground
I/O setting, and set the second failure's tick so that at least one configuration finishes in
time and at least one does not.

**ORRERY cannot recover this.** ORRERY rebuilds inodes from the journal and the journal is also
on the array. That limit is stated in the Archive codex and demonstrated here. The array bay's
copy must not promise otherwise, and the leg must not offer ORRERY's restore as an option
against an array loss.

---

## Stage

**Form.** Rotating discs and a head arm.
**Accent.** `CYAN.core` for served requests, `AMBER.core` for the seek path.
**Environment.** A stack of platters seen from a catwalk above and to one side. The catwalk is
where the convoy walks, so the player is always looking down at the mechanism.
**Hero visual.** The projected head path. `DiskSchedulingPolicy.snapshot().projectedPath` is
drawn as a lit polyline across the platter, connecting pending requests in service order.
Switching policy redraws the polyline instantly (a snap, per the motion language section 8.2),
and the difference between FCFS's scribble and C-SCAN's sweep is a single glance.

The snap is important and it is easy to get wrong. A policy change does not ease the polyline
from one shape to the other; it replaces it in one frame. Easing would suggest the arm is
travelling between the two plans, and it is not. The plan changed.

| Anchor id | Structure | Focus camera target |
|---|---|---|
| `anchor.plaza` | The platter stack seen from the catwalk | wide establishing; the projected path hero shot frames from here |
| `anchor.catwalk` | Where the convoy walks, above and to one side | the convoy's own space; not a lock target |
| `anchor.platter` | The rotating surface with request marks at cylinder positions | **overhead orthographic**; cylinder positions and the polyline legible |
| `anchor.head_arm` | The arm, its current cylinder and its direction | included in the platter framing |
| `anchor.projected_path` | The lit polyline from `projectedPath` | included in the platter framing; must redraw in one frame on a policy change |
| `anchor.arm_console` | Policy selector, initial direction, and the three posted numbers: total travel, average wait, worst wait | head-on orthographic; all six policies and all three columns in one frame |
| `anchor.cost_board` | The `DISK-COST-1` breakdown: seek 2.5 ms, rotation 4.1667 ms, transfer 0.041 ms, total 6.7077 ms, 13 ticks | head-on |
| `anchor.age_column` | The pending queue as physical markers, sorted by age descending, the oldest at the top | head-on orthographic; the starving request must be the first thing read |
| `anchor.edge_request` | The convoy's read at cylinder 4, marked as the convoy's | included in the platter framing; visually distinct from workload requests |
| `anchor.nvm_bay` | The `nvm0` device, with no arm and no rotation, and a merge counter | head-on; the absence of an arm must be visible rather than stated |
| `anchor.array_bay` | The six RAID levels, each with its redundancy in plain terms, its write amplification, and its capacity cost | head-on orthographic; all six rows legible at once |
| `anchor.array_devices` | The array's member devices, drawn as separate physical units | head-on; **the deletion must be visible on every member in the same tick** |
| `anchor.rebuild_gauge` | `raid.rebuild` progress, the degraded window, and the foreground I/O dial | head-on; progress and the remaining window both legible |
| `anchor.scrub_crew` | The scrubbing purchase against `bit_rot` | head-on |
| `anchor.depot` | The leg 9 depot | head-on |
| `anchor.convoy.<member>` | Per-Program stele | head-on |

### Two hard stage requirements

**The age column is sorted by age, descending, always.** A starving request that is buried in a
list sorted by cylinder is invisible, and the first misconception depends on the player seeing it
without looking for it. The oldest request is the top line at `anchor.age_column`, and when the
convoy's cylinder-4 read reaches the top it stays there and climbs.

**The array deletion is one tick on every member.** The second misconception is a single frame:
three devices, one delete, three simultaneous updates, health readout green. If the devices
update on successive frames it reads as replication happening over time, which is a different
and much less alarming picture.

---

## Interactions

```ts
export const interactions: readonly InteractionDef[] = [
  {
    id: 'platters.set_policy',
    label: 'Set the disk scheduling policy',
    description: 'Six choices. Read total travel, average wait and worst wait together; a good average can hide an abandoned request.',
    anchor: 'anchor.arm_console',
    cost: { cycles: 8 },
    enabledWhen: (run) => run.resources.cycles >= 8,
  },
  {
    id: 'platters.set_direction',
    label: 'Set the initial head direction',
    description: 'Up or down. On this queue it is worth 95 cylinders under SCAN and 91 under LOOK.',
    anchor: 'anchor.arm_console',
    cost: { cycles: 4 },
    enabledWhen: (run) => run.resources.cycles >= 4,
  },
  {
    id: 'platters.read_age_column',
    label: 'Read the pending queue by age',
    description: 'The oldest request first.',
    anchor: 'anchor.age_column',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'platters.enable_merging',
    label: 'Enable request merging',
    description: 'Adjacent requests become one physical operation. It needs adjacency, so it needs the queue left in order.',
    anchor: 'anchor.nvm_bay',
    cost: { cycles: 6 },
    enabledWhen: (run) => run.resources.cycles >= 6,
  },
  {
    id: 'platters.buy_array',
    label: 'Buy an array level',
    description: 'Six levels. Each row states its redundancy, its write cost and its capacity cost before you pay.',
    anchor: 'anchor.array_bay',
    cost: { cycles: 60, blocks: 30 },
    enabledWhen: (run) => run.resources.cycles >= 60 && run.resources.blocks >= 30,
  },
  {
    id: 'platters.set_write_pattern',
    label: 'Set the write pattern',
    description: 'Small writes, or full stripes. On a parity array the difference is the whole write cost.',
    anchor: 'anchor.array_bay',
    cost: { cycles: 10 },
    enabledWhen: (run) => run.resources.cycles >= 10,
  },
  {
    id: 'platters.buy_hot_spare',
    label: 'Buy a hot spare',
    description: 'A device already in the array and idle. The rebuild starts the moment a member fails instead of waiting for a replacement.',
    anchor: 'anchor.array_bay',
    cost: { blocks: 40 },
    enabledWhen: (run) => run.resources.blocks >= 40,
  },
  {
    id: 'platters.lower_foreground_io',
    label: 'Lower foreground I/O',
    description: 'Give the rebuild more of the device. It costs travel progress for the duration.',
    anchor: 'anchor.rebuild_gauge',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'platters.scrub',
    label: 'Buy a scrubbing pass',
    description: 'Read every block, verify it against parity, and rewrite what disagrees.',
    anchor: 'anchor.scrub_crew',
    cost: { blocks: 18 },
    enabledWhen: (run) => run.resources.blocks >= 18,
  },
  {
    id: 'platters.delete_stale',
    label: 'Delete the stale file',
    description: 'Reclaim its blocks.',
    anchor: 'anchor.array_devices',
    cost: {},
    enabledWhen: () => true,
  },
];
```

`platters.delete_stale` is offered as a plain reclamation. Nothing about it is framed as a
lesson, a risk or a demonstration. The player deletes a file to get blocks back, gets the blocks
back, and watches three devices agree instantly. The array bay does not comment.

---

## Terminal commands

Three commands, copied verbatim from the curriculum map into
`src/legs/the_platters/commands.ts`: `iostat`, `seekq`, `raid`. The full `manual` text is in
`docs/05-CURRICULUM-MAP.md`, "Leg 9. THE PLATTERS". Copy byte for byte; a test asserts the match.

Load-bearing lines you must not lose in transcription:

- `iostat`: "Read variance next to the average, always. A policy with a good average and terrible
  variance is serving most requests quickly and abandoning a few completely, and the abandoned
  ones belong to processes that will block, time out, and die. The average will not show you
  that. This is the same lesson the ready queue taught, in different hardware."
- `iostat`: "Queue depth tells you whether scheduling matters at all. With a queue depth of one
  there is nothing to reorder and every policy is the same policy."
- `seekq`: "Seek dominates, and it is the only one scheduling can reduce, which is why every one
  of these policies is about arm movement."
- `seekq`: the `sstf` entry. "This is starvation, with the same structure as priority scheduling
  without aging, on different hardware." That sentence is the cross-link to leg 3 and it is the
  first misconception's answer.
- `seekq`: "If anything in your workload has a deadline, predictable beats fast."
- `raid`: the level-0 line. "This is not redundancy; it is the opposite of redundancy, since the
  array now fails if any member fails."
- `raid`: "The rebuild window is the dangerous part and it is where arrays actually die. While a
  degraded array rebuilds, it has no redundancy left, and the rebuild reads every block on every
  surviving device, which is exactly the workload most likely to expose a second failure."
- `raid`, the last paragraph: "One thing RAID does not do, stated here because assuming otherwise
  is how data is lost: it is not a backup. It protects against a device failing. It faithfully
  replicates every deletion, every overwrite and every corruption written through the file
  system, to every member, instantly." That paragraph is the second misconception's answer and
  the player will read it after the deletion rather than before.

### `seekq --compare` implementation contract

The leg's arbiter and the same idea as leg 3's `gantt --replay`, leg 7's `frag --compare` and leg
8's `belady --compare`. Share the shadow-run machinery; do not build a fourth.

1. Record the pending queue and the head state.
2. On `--compare`, run that recorded queue under all six policies, in both directions for the
   SCAN family, from the recorded head position.
3. Print, per policy and direction: the full path, total head movement, average wait, **worst
   wait**, and wait-time variance.
4. The shadow run must not touch the live queue, the live head or the live event stream. Assert
   over 200 comparisons that the live event log hash is unchanged.
5. On the standard queue at head 53 with 200 cylinders, the ten printed paths and totals must
   equal the fixture table exactly.

`--path` draws the projected path for the current policy without running a comparison, and it is
the same data the world draws at `anchor.projected_path`. One source, two consumers.

---

## Event table

Copied verbatim from `04-NARRATIVE-BIBLE.md` section 8, leg 9. Weights sum to 100.

```ts
export const plattersEvents: readonly RandomEventDef[] = [
  {
    id: 'platters.edge_starvation',
    weight: 13,
    title: 'The Outer Cylinder',
    narration: 'Shortest-seek-first keeps the arm in the middle of the platter where the requests are dense. A request at cylinder 199 has been queued for two hundred ticks and is not getting closer.',
    targets: null, inflicts: 'starvation',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'platters.seek_storm',
    weight: 12,
    title: 'Seek Storm',
    narration: 'The queue is served in arrival order and the arm crosses the full platter on almost every request. Total head travel this leg exceeds the useful transfer by a factor of thirty.',
    targets: 'courier', inflicts: null,
    resourceDelta: { cycles: -60, bandwidth: -8 },
    onlyIf: null,
  },
  {
    id: 'platters.rot_patch',
    weight: 12,
    title: 'Quiet Degradation',
    narration: 'A patch of the surface returns values it was never given, and the checksum stored beside them agrees. Nothing has failed and nothing can be trusted.',
    targets: null, inflicts: 'bit_rot',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'platters.member_failure',
    weight: 12,
    title: 'Member Down',
    narration: 'One disk in the array stops answering and the array keeps serving from parity, slower. Rebuilding costs blocks and the window before a second failure is not long.',
    targets: null, inflicts: null,
    resourceDelta: { blocks: -28 },
    onlyIf: null,
  },
  {
    id: 'platters.rotational_wait',
    weight: 11,
    title: 'Under the Head, Just Passed',
    narration: 'Every request arrives at the track a fraction after the sector it wants has gone by. The arm is in exactly the right place and waits a full rotation anyway.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -40 },
    onlyIf: null,
  },
  {
    id: 'platters.scrub_crew',
    weight: 15,
    title: 'Scrubbing Pass',
    narration: 'A background pass is reading every block, verifying it against parity, and rewriting what disagrees. The convoy waits for it to reach their extent and it is worth waiting for.',
    targets: null, inflicts: null,
    resourceDelta: { blocks: 30 },
    onlyIf: null,
  },
  {
    id: 'platters.nvm_cache',
    weight: 14,
    title: 'Solid Extent',
    narration: 'A stretch of the road is backed by non-volatile memory with no arm and no rotation. KESTREL crosses it at a speed that makes the rest of the leg feel like an insult.',
    targets: 'courier', inflicts: null,
    resourceDelta: { bandwidth: 14, cycles: 45 },
    onlyIf: null,
  },
  {
    id: 'platters.elevator_sweep',
    weight: 11,
    title: 'Elevator Sweep',
    narration: 'The arm sweeps from one edge to the other, serving everything on the way, and turns around. Every request is served once per sweep and none of them waits twice.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 55, bandwidth: 6 },
    onlyIf: null,
  },
];
```

`platters.member_failure` must genuinely fail a member of the live array if one exists, moving it
to degraded and raising read cost to `n-1` at the parity levels. It is separate from the two
scripted failures and it can compound with them: an ambient failure inside the scripted rebuild
window is a legal and lethal state, and the player who bought level 6 survives it.

`platters.rot_patch` genuinely marks blocks as silently wrong. The checksum agreeing is the whole
narration and it must be true in the simulation: a read of a rot-patched block returns the wrong
value with a valid checksum, and only a scrubbing pass against parity detects it.

---

## Evaluation

### Survival

The leg is survived when at least one convoy Program is alive at leg end.

**Seek starvation.** Under SSTF the arm stays where the requests are dense and the request at
cylinder 4 is never the nearest. Its `waitTicks` climbs without bound. The Program blocked on it
takes `TerminationReason: 'io_timeout'` when the wait exceeds the device deadline, with the
epitaph quoted above.

**The array failure is the harder one.** A single device failure under RAID 0 loses everything
immediately, which is the fastest possible run-ending event in the game. Under RAID 5 a single
failure is survivable and the array runs degraded during rebuild; if the scripted second failure
lands inside the rebuild window, the array is lost and the affected Programs derezz with
`TerminationReason: 'storage_corruption'`.

ORRERY cannot recover this, because ORRERY rebuilds inodes from the journal and the journal is
also on the array.

**`bit_rot`** (0.5 integrity per travel tick, never fatal) is the ambient affliction of this leg,
cured by spending blocks on scrubbing. It is the only affliction in the game that is never
fatal, and that is a deliberate part of this leg's job as the stabilising leg after the Reach.

### The resurrection path

Specified in full at the top of this package. Restating the mechanics for the evaluator:

At `evaluate()`, and also at the tick `raid.rebuild` reaches `progress: 1.0`, check every
tombstone in `RunState.tombstones` whose `legId` is `the_platters` and whose `reason` is
`storage_corruption`. For each, if the array level provides redundancy, the array has not
exceeded its failure tolerance, and the rebuild completed before the second failure, restore the
Program:

- `ConvoyMember.status` returns to `degraded`.
- `integrity` is set to 40.
- `afflictions` is emptied.
- `abilityCharges` is reset to the leg's allowance.
- `epitaph` is set to null and the corresponding entry is removed from `RunState.tombstones`.
- `pid` is rebound to a freshly spawned process with the Program's original spec.

Record a `DecisionRecord` with `kind: 'raid_rebuild_recovery'`, `choice: <memberId>`,
`outcome: 'good'`, and the tick.

Do this through WP-17's convoy interface, not by mutating `RunState` from the leg.

The restored Program is **not** counted in `LegOutcome.casualties`. A Program that died and came
back is not a casualty of this leg, and the end-of-run report's survivor count must agree.

### Objectives

| Objective | Computed from |
|---|---|
| `obj.the_platters.total_head_travel` | Sum `distance` over `disk.seek` events for the segment, requiring under 900, **and** `max(waitTicks)` over `disk.served` under 120. |
| `obj.the_platters.sstf_starves` | After the first `disk.served` showing `waitTicks` over 90 on the edge request, the policy changes to a SCAN-family id (`scan`, `cscan`, `look` or `clook`) before that request's deadline. |
| `obj.the_platters.variance_choice` | The variance of `waitTicks` under the committed policy against a shadow replay under `scan` on the identical queue, requiring at least a 30 percent reduction, with `cscan` committed. |
| `obj.the_platters.nvm_has_no_arm` | `fcfs` committed on the NVM segment with merging enabled, **and** throughput above the recorded SCAN baseline on that segment. |
| `obj.the_platters.raid_level_choice` | Zero lost blocks through the scripted single failure **and** measured write amplification under 2.0. Both, and the second is what makes the write pattern matter. |
| `obj.the_platters.rebuild_window` | `raid.rebuild` progress reaches 1.0 before the scripted second failure event. |

### Debrief card

```ts
{
  headline: /* 'Off the platter.' or 'The array went with it.' */,
  whatHappened:
    `You served the queue under ${policyList.join(', then ')}. Total head travel ` +
    `${travel} cylinders. Average wait ${avgWait} ticks, worst wait ${worstWait} ticks by ` +
    `${worstRequester}. Array level ${level} at ${amplification.toFixed(2)}x write ` +
    `amplification. Rebuild reached ${(progress * 100).toFixed(0)} percent before the second failure.`,
  whyItHappened: /* selected */,
  counterfactual: /* a real seekq --compare replay */,
  chapter: { chapter: 11, title: 'Mass-Storage Structure', sections: ['11.2.4'] },
}
```

`whyItHappened`, selected by what actually occurred:

- **The edge request timed out.** "Total head travel under shortest-seek-time-first was
  ${travel} cylinders, which is the best number on the console. The request at cylinder 4 waited
  ${wait} ticks because there was always something closer."
- **The array was lost.** "The rebuild was at ${pct} percent when the second device failed. A
  degraded array has no redundancy left, and the rebuild is the workload most likely to expose
  the next failure."
- **A Program was rebuilt from parity.** "${name} was reconstructed from parity at tick ${t}. The
  level you bought at the array bay is the only reason that was possible."
- **FCFS held for the crossing.** "The arm crossed the platter ${crossings} times serving
  requests in the order they arrived. Every crossing was ${cost} ticks of seek."
- **Clean crossing.** "You read worst wait next to the average and picked for the workload in
  front of you."

The counterfactual is a **real `seekq --compare` replay** of the recorded queue, never a
template:

> "Your recorded queue under ${best} serves in ${travel} cylinders with a worst wait of
> ${worst}. You served it in ${actualTravel} with a worst wait of ${actualWorst}."

If a Program was rebuilt from parity, append one line:

> "${name} came back because the array had parity to rebuild from. Nothing else in this run
> works that way."

That line is worth saying plainly, once, because the resurrection is the only one in the game and
a player who does not notice why it happened will not set it up again.

---

## Acceptance criteria

1. `src/legs/the_platters/index.ts` satisfies `Leg` under `tsc --strict`,
   `id === 'the_platters'`, `index === 9`.
2. The leg runs headlessly to completion via the smoke-test harness, with no Three.js or DOM
   import reachable from the leg module graph.
3. `enabledSubsystems` deep-equals `['process', 'scheduler', 'memory', 'vm', 'storage']`. `fs`,
   `sync`, `deadlock`, `io` and `security` are not enabled.
4. `diskPolicy === 'fcfs'` and `totalCylinders === 200` at leg entry, and `raidLevel === null`
   until the array bay purchase.
5. Inert-field independence: mutating `fileAllocation`, `journalingEnabled`, `deadlockStrategy`
   and `allocationStrategy` leaves the canonical event log hash unchanged over 400 ticks.
6. Every objective can be met by the known-good decision sequence; all six met in one run.
7. The known-bad sequence produces the intended failure: `sstf` held for the crossing, the
   cylinder-4 read reaching 380 `waitTicks`, one derezz with `TerminationReason: 'io_timeout'`
   and the epitaph text exact including the number 380.
8. All ten `DISK-*` path fixtures reproduce exactly through `seekq --compare`: paths and totals,
   both directions for the SCAN family. 640, 236, 236, 331, 208, 299, 382, 386, 322, 326.
9. `DISK-COST-1` and `DISK-COST-2` reproduce: 2.5 ms, 4.1667 ms, 0.0410 ms, 6.7077 ms; 13 ticks
   and 9 ticks for a zero-seek request.
10. KESTREL alive halves seek cost, taking the 13-tick request to 11. Asserted with and without
    KESTREL.
11. `DISK-NVM-1` reproduces: identical completion ticks for all six policies on `nvm0`.
    `DISK-NVM-2` reproduces: write amplification above 3 random, approximately 1 sequential.
12. Request merging on `nvm0` makes FCFS beat C-SCAN on throughput. Asserted as a measured
    difference on the same queue.
13. `RAID-1` reproduces: physical I/O counts 1, 2, 4, 4, 6, 2 at levels 0, 1, 4, 5, 6, 10.
14. `RAID-2` reproduces: a full-stripe write of 4 blocks under RAID 5 with n = 5 costs 5 I/O, a
    penalty of 1.25.
15. `RAID-3` reproduces: one failure loses data only at level 0; degraded read cost rises to
    `n-1` at levels 4, 5 and 6.
16. `RAID-4` reproduces: two simultaneous failures survivable only at level 6, and at 1 and 10
    when in different mirror pairs.
17. At least two array configurations satisfy `obj.the_platters.raid_level_choice` and several
    do not. The full amplification table for every level crossed with both write patterns is
    frozen and checked in.
18. The array deletion replicates to every member **in the same tick**, and the array health
    readout stays green. Asserted at the event level and at the frame level.
19. **The resurrection works and only works under its five conditions.** Asserted as six separate
    cases: all five hold and the Program returns; each of the five broken in turn and it does
    not. A restored Program is not counted in `casualties`, its tombstone is removed from
    `RunState.tombstones`, and the `raid_rebuild_recovery` decision is recorded.
20. Under RAID 0 a single device failure loses the array immediately, and the array bay stated
    that level's redundancy in plain terms before the purchase. Asserted on the copy as well as
    on the behaviour.
21. ORRERY's restore is not offered against an array loss, and the array bay copy does not
    promise it.
22. `seekq --compare` never mutates the live queue, head or event log, over 200 comparisons.
23. `platters.rot_patch` produces blocks that read wrong with a valid checksum, detectable only
    by a scrubbing pass against parity.
24. `bit_rot` never becomes fatal in this leg, at any integrity, over 200 randomised runs.
25. Event table weights sum to exactly 100; all ids unique. `platters.member_failure` genuinely
    fails a live array member.
26. All three terminal command `manual` strings match the curriculum map byte for byte.
27. Draw calls stay under 220 / 450 / 900 at the heaviest frame, which is the full platter with
    the projected polyline, the age column, the array bay's six rows and the rebuild gauge in
    view.
28. The projected path redraws **in one frame** on a policy change, with no easing. Asserted at
    the frame level.
29. The age column is sorted by age descending at every tick, and the cylinder-4 request reaches
    and holds the top line under `sstf`.

---

## Tests you must write

All under `tests/legs/the_platters/`. This directory is owned exclusively by this package.

**`contract.test.ts`**: `Leg` conformance, exact ids, the eighteen-section chapters array, six
objectives, every `chapter.sections` entry present in `chapters`.

**`config.test.ts`**: `enabledSubsystems` exact; `diskPolicy === 'fcfs'`;
`totalCylinders === 200`; `raidLevel === null` at entry and set through the kernel path on
purchase; inert-field independence over 400 ticks.

**`populate.test.ts`**: thirteen spawns (five convoy plus eight clients), five binds, zero
resource and sync declarations, the cylinder distribution clustering in the middle third.

**`seekfixtures.test.ts`**: all ten `DISK-*` path fixtures through `seekq --compare`: exact
paths and exact totals, both directions for the SCAN family. Assert the SSTF and SCAN-down tie
at 236 and assert their worst waits differ. `seekq --compare` leaves the live queue, head and
event log unchanged over 200 comparisons.

**`cost.test.ts`**: `DISK-COST-1` to four decimal places; `DISK-COST-2`'s 13 and 9 ticks;
KESTREL halving seek cost, asserted with and without.

**`starvation.test.ts`**: the edge request.
- Under `sstf` with no intervention, the cylinder-4 read reaches 380 `waitTicks` and the Program
  derezzes with `io_timeout`.
- The epitaph text is exact, including the number 380, and `codexEntry` is
  `codex.seek_starvation`.
- Switching to any SCAN-family policy before the deadline clears it, for all four.
- The age column is sorted descending at every tick and the request holds the top line.
- Total head travel under `sstf` is genuinely low while this happens.

**`nvm.test.ts`**: `DISK-NVM-1` and `DISK-NVM-2` exactly. Merging makes FCFS beat C-SCAN on
throughput on the same queue, as a measured difference.

**`raid.test.ts`**: the array.
- `RAID-1`, `RAID-2`, `RAID-3` and `RAID-4` exactly.
- The amplification table for all six levels crossed with both write patterns, frozen.
- At least two configurations satisfy the objective; several do not.
- Level 0 plus one failure loses the array in the same tick.
- Degraded read cost rises to `n-1` at levels 4, 5 and 6.
- The deletion replicates to every member in the same tick with health green.
- Rot-patched blocks read wrong with a valid checksum; a scrubbing pass detects and repairs them.

**`rebuild.test.ts`**: the window.
- Rebuild duration at each level, with and without a hot spare, at each foreground I/O setting.
  Frozen.
- The second failure's tick is such that at least one configuration finishes and at least one
  does not.
- An ambient `platters.member_failure` inside the scripted window compounds correctly and level
  6 survives it.

**`resurrection.test.ts`**: the only resurrection in the game.
- All five conditions hold: the Program returns at 40 integrity with afflictions cleared,
  charges reset, epitaph null, tombstone removed, pid rebound, decision recorded, and it is not
  counted in `casualties`.
- Each of the five broken in turn: wrong death reason, level 0, tolerance exceeded, rebuild
  incomplete, rebuild finishing after the second failure. In every case the Program stays dead.
- The restoration goes through WP-17's convoy interface and the leg does not mutate `RunState`
  directly. Asserted by freezing `RunState` and checking the leg throws rather than writing.
- The recruitment service at the depot remains a separate, different thing: a recruit is
  `LUMEN-2` at 60 percent passive, and the original tombstone stays. Asserted side by side so
  the two mechanics cannot be conflated in a later refactor.

**`evaluate.test.ts`**: each of the six objectives, met and not met. In particular
`raid_level_choice` fails a level 5 array on small writes and passes it on full stripes.

**`golden.test.ts`**: the golden headless playthrough.
- Fixture: `seed: 0x4b54524c`, `discClass: 'shell'`, `difficulty: 'operator'`, steady pace,
  entering with the leg 8 golden closing ledger.
- Known-good sequence, in order:
  1. `seekq --compare` on the opening queue, reading all ten rows.
  2. `platters.read_age_column`, seeing the cylinder-4 request.
  3. `platters.set_policy` to `look`, `platters.set_direction` down.
  4. On the uniform-arrival segment, `platters.set_policy` to `cscan`.
  5. On the NVM segment, `platters.set_policy` to `fcfs` and `platters.enable_merging`.
  6. `platters.buy_array` at level 5, `platters.set_write_pattern` to full stripes,
     `platters.buy_hot_spare`.
  7. On the first failure, `platters.lower_foreground_io`.
  8. `platters.scrub` once against accumulated `bit_rot`.
- Assert: all six objectives met, zero casualties, total travel under 900, worst wait under 120,
  variance at least 30 percent below the SCAN baseline, write amplification 1.25, rebuild at
  1.0 before the second failure, seven codex entries added, canonical event log hash matches
  the checked-in golden file, stable across two runs and across a snapshot-restore.

**`badpath.test.ts`**: the known-bad sequence.
- `sstf` for the whole crossing, RAID 0 at the array bay, no hot spare, no scrubbing.
- Assert: the cylinder-4 read reaches 380 and its Program derezzes with `io_timeout`; the first
  device failure loses the array in the same tick; the affected Programs derezz with
  `storage_corruption`; no resurrection is possible and the test asserts the reason is level 0;
  counterfactual names the best policy from a real replay; `survived === true` if anyone remains.

**`manuals.test.ts`**: three manual strings against the curriculum map fixture; every
`See also:` topic resolves; `seekq`'s policy block lists all six; `raid`'s level block lists all
six with their redundancy; the "it is not a backup" paragraph is present in full.

**`stage.test.ts`**: anchors resolve; interaction anchors resolve; draw calls under budget at
the heaviest frame; the projected path redraws in one frame on a policy change; the array
deletion is one frame on every member; the age column is sorted descending.

---

## Out of scope

- Do not touch any other leg. Do not import from `src/legs/*` other than your own directory.
- Do not modify `src/game/types.ts` or `src/kernel/types.ts`.
- Do not modify anything under `src/kernel`, `src/render`, `src/world`, `src/terminal`,
  `src/ui`, `src/audio`, `src/design`, `src/platform` or `src/app`. If a disk policy, the cost
  model or a RAID level is wrong, file it against WP-09 and stop.
- **Do not enable `fs`.** No inodes, no directories, no allocation methods, no free space map, no
  journal. This leg deals in blocks and devices. The journal is named twice, in copy, and is not
  implemented.
- Do not enable `io`. Devices with modes, interrupts and DMA are leg 10's.
- Do not change `totalCylinders`. Every path fixture is computed at 200.
- Do not implement the resurrection by mutating `RunState` from the leg. Use WP-17's interface.
- Do not extend the resurrection to any death reason other than `storage_corruption`, to any
  leg other than this one, or to a run where the array had no redundancy. It is the only
  resurrection in the game and its scope is what makes it mean anything.
- Do not conflate the resurrection with the depot's recruitment service. They are different
  mechanics with different names, different costs and different outcomes.
- Do not offer ORRERY's restore against an array loss.
- Do not make `bit_rot` fatal.
- Do not ease the projected path on a policy change.
- Do not sort the age column by cylinder.
- Do not unify the cylinder-4 scripted read with the cylinder-199 ambient event.

### Files this package owns exclusively

```
src/legs/the_platters/index.ts
src/legs/the_platters/chapters.ts
src/legs/the_platters/objectives.ts
src/legs/the_platters/config.ts
src/legs/the_platters/populate.ts
src/legs/the_platters/interactions.ts
src/legs/the_platters/commands.ts
src/legs/the_platters/events.ts
src/legs/the_platters/evaluate.ts
src/legs/the_platters/queue.ts
src/legs/the_platters/array.ts
src/legs/the_platters/rebuild.ts
src/legs/the_platters/resurrection.ts
src/legs/the_platters/fixtures.ts
src/legs/the_platters/stage.ts
src/legs/the_platters/copy.ts
tests/legs/the_platters/**
```

No other package writes to these paths and this package writes to no others.

---

## Report back

1. The commit or branch, and the full `tests/legs/the_platters/` output.
2. The golden playthrough hash and the file it is checked in at.
3. The frozen fixtures, as a table: the leg's own recorded queue and its per-policy total travel,
   average wait, worst wait and variance; the tick at which the cylinder-4 read reaches 380 at
   each pace; rebuild durations at every level crossed with hot spare and foreground I/O
   settings; write amplification at every level crossed with both write patterns.
4. Every `DISK-*` and `RAID-*` fixture result against its expected value, including all ten
   paths in full.
5. **The resurrection interface as agreed with WP-17**, and confirmation that the leg does not
   write to `RunState` directly. Include the six-case test results showing the mechanic fires
   under all five conditions and under nothing else.
6. Confirmation that a restored Program is excluded from `casualties` and that the end-of-run
   survivor count agrees.
7. The array bay copy for all six levels, as shipped, so a reviewer can confirm level 0's
   redundancy is stated in plain terms before the purchase.
8. Draw calls at each of the three quality tiers at the heaviest frame, and confirmation that
   the projected path redraws in one frame and the array deletion lands on every member in one
   frame.
9. Whether the cross-link between `codex.seek_starvation` and `codex.priority_starvation` was
   registered in both directions, and the pending item if leg 3 had not shipped.
10. Any place where the curriculum map, the narrative bible, the visual bible and the sim spec
    disagreed, what you did, and which document you followed. Note explicitly how you handled
    the cylinder 4 against cylinder 199 discrepancy.
11. Confirmation that no file outside the owned list was created or modified, and that `fs` and
    `io` are not enabled anywhere in this leg.

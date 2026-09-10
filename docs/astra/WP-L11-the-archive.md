# WP-L11: The Archive

Leg id `the_archive`, index 11. Subtitle: *The lights go out between the write and the write.*

**Legs are independent and may be built concurrently.** This package touches no other leg,
imports from no other leg, and shares no source file with any other leg.

Three chapters in one leg, held together by one crash. Nine new codex entries, roughly 30
minutes, high load. It is the widest chapter span in the game and it survives that only because
every part of it converges on a single moment: the hall goes dark partway through the convoy's
own write, and everything the player configured beforehand decides what is left afterwards.

The leg has a depot. Its ambient line is: **"Journal is 340 transactions behind checkpoint. It
will catch up or it will not."**

---

## Objective

A module at `src/legs/the_archive/` implementing the frozen `Leg` interface, playable end to
end. The Archive is a library-city: a hall of block stacks with a catalogue at the entrance, and
the convoy's own route map filed somewhere inside it.

The leg has three movements and they are built in this order.

**The shelving movement.** Four allocation methods as four physical shelving schemes, with real
and different costs for sequential access, random access and growth. The player assigns methods
to workloads and pays for the mismatch.

**The reclamation movement.** A volume that reports itself full while the visible files sum to a
fraction of capacity. Free-space management, the link count, and descriptors on files that have
no name.

**The crash.** The hinge, and the reason the other two movements exist. The lights go out
between the data write and the metadata write, and whether the convoy's manifest survives was
decided by a toggle the player set, and paid for, earlier.

---

## The ORRERY dependency

ORRERY's passive is that **corruption is recoverable while ORRERY lives**. Her active is
`restore`, which rebuilds one corrupted inode from the journal, three charges per leg. Both are
load-bearing here and this is the leg where the design brief's claim that losing her is the most
expensive death in the game is either true or empty.

The four states are all reachable and all four must be built. This table is the leg.

| ORRERY | Journaling at the crash tick | What `fsck` can do | Manifest contents | Casualty |
|---|---|---|---|---|
| alive | on | `--from-journal` replays the log; recovery costs 12 ticks | correct | none |
| alive | off | full scan restores structure in 200 ticks; ORRERY's passive raises `recoverable` to true on the double-allocation case and `restore` rebuilds one inode | correct for the restored inode, stale for the rest | none, at a cost of 40 blocks |
| dead | on | `--from-journal` replays the log; recovery costs 12 ticks | correct | none |
| dead | off | full scan restores structure in 200 ticks; nothing raises `recoverable`; `restore` does not exist | garbage, with correct size and correct owner | the Program acting on the manifest derezzes with `TerminationReason: 'storage_corruption'` |

Read the fourth row carefully, because it is the one the package exists to make true.
**Unjournaled plus no codec is permanent.** `fs.corruption` fires with `recoverable: false` and
nothing in the game reverses it. `fsck` reports success, because by its own definition it
succeeded: the metadata describes a coherent file system. The contents are the previous
version's bytes. A Program acting on that manifest dies, and the epitaph drawn is
`ep.corrupt.no_codec`:

> HERE LIES {NAME}, THE JOURNAL WAS THERE, NOBODY COULD READ IT
> Corruption is recoverable while ORRERY lives. After that the record survives and the ability
> to replay it does not.

That stone is only correct in the third and fourth rows, so the epitaph selection must be
filtered on whether the journal existed. In the fourth row the journal did not exist either, and
the stone that fits is `ep.corrupt.never_the_commit`. Filter accordingly and report which stones
you made reachable from which row.

**ORRERY may have died anywhere.** The tombstone list carries the chain and the debrief must
follow it: if she died at the Narrows to a race, or at the Arbiter Wall on a previous run's
route, this leg is where the loss is paid. Read `RunState.tombstones` for her stone, name the
leg and the tick it happened, and put both in `whatHappened`. Do not editorialise.

**SABLE has already said it.** The narrative bible states that the player is told the cost of
ORRERY's death exactly once, by SABLE, at the moment it happens, wherever that is. That line
belongs to WP-17's death handling and **this leg must not repeat it.** Do not add a second
warning at the format bench, do not put it in the depot's line, and do not have anyone say it
again when the crash lands. The player was told. The leg collects.

---

## Prerequisites

**Engine work packages that must be complete and green on the shared branch:**

| Package | Why this leg needs it |
|---|---|
| WP-01 | `Rng`, event bus, canonical serialiser. |
| WP-02 | Process table, PCB, `BlockReason` of kind `io`, kernel step order. |
| WP-03, WP-04 | Scheduler policies. The leg does not teach scheduling and needs the policies to exist. |
| WP-07 | Synchronisation primitives. The leg owns one critical section crossing and it is an rwlock. |
| WP-09 | The block device the file system sits on, and the block cache with its write policy. `write_back` losing every dirty entry is what makes the crash lose data. |
| **WP-10** | **The file system half of it, in full.** Directory structure and path resolution, the inode with all four indirection levels, all four allocation methods, all four free-space methods, the journal with four phases and three modes, the crash simulation at eight positions, recovery, and the four corruption cases. This leg is the file system half's only consumer. |
| WP-11 | Syscalls, snapshot and restore, the invariant set including I-29. |
| WP-12 | Renderer backend, post chain, design tokens, draw call budget. |
| WP-13 | Focus camera and the diegetic structure base classes. |
| WP-14 | World event router. `fs.block_allocated`, `fs.fragmented`, `fs.journal`, `fs.corruption` and `fs.recovered` must each have a visual treatment, and the corruption treatment must be the quantise-and-hue-jitter of the visual bible's section 2.4.1. |
| WP-15 | The terminal. |
| WP-17 | HUD, codex, save and load. |
| WP-18 | The counterfactual replay worker. The debrief replays the crash under the other journal setting and that is the strongest teaching device on the leg. |

**Kernel subsystems that must be working:** `process`, `scheduler`, `storage`, `fs`.

WP-10's file system half must provide, exactly:

- The acyclic-graph directory of Ch. 13.3.5, with hard links permitted to files and forbidden to
  directories, and `linkCount` on the inode maintained by the kernel.
- Path resolution charging one directory read per component and checking `execute` on each
  component, per fixture `FS-PATH-1`.
- Directory implementations: linear, hashed and tree, selectable, with a measured lookup cost.
- The inode of §12.2: 12 direct, single, double and triple indirect, `blockSize` 4096,
  `pointerSize` 32, maximum file size 8,657,616,896 bytes, per `FS-INODE-1`.
- All four `FileAllocationMethod` values, live simultaneously on one volume, with `Inode.method`
  recording which one each file uses, and the cost tables of §12.3 reproduced exactly.
- The `linkedVariant: 'in_block' | 'fat'` switch.
- All four `freeSpaceMethod` values: `bitmap`, `linked_list`, `grouping`, `counting`, with the
  bitmap sized `ceil(totalBlocks / 32)` words per `FS-BITMAP-1`, and the refusal of
  `contiguous` allocation over a `linked_list` free map.
- The journal of §12.5: four phases, the two mandatory flushes, three modes, and idempotent
  replay.
- `ioctl('crash')` implementing all five numbered steps of the crash simulation, with the crash
  point chosen by the leg at one of eight protocol positions and never drawn from an RNG.
- Recovery implementing all six numbered steps, emitting `fs.recovered { inode, fromJournal }`.
- The four corruption cases of §12.6 with `recoverable` set correctly per case, and invariant
  I-29 firing on double allocation at the next slow check.
- Open file descriptors surviving unlink, with blocks held until both the link count reaches
  zero and the last descriptor closes.
- The three consistency semantics: `unix`, `session`, `immutable`, with a stale-read counter.
- The VFS layer, so a mount point's contents are replaced by the mounted volume root and path
  walks cross the boundary without knowing.

Fixtures `FS-INODE-1`, `FS-BITMAP-1`, `FS-ALLOC-1`, `FS-ALLOC-2`, `FS-ALLOC-3`, `FS-PATH-1`,
`FS-JOURNAL-1`, `FS-JOURNAL-2`, `FS-JOURNAL-3`, `FS-JOURNAL-COST`, `FS-CORRUPT-1`,
`FS-CORRUPT-2`, `FS-CORRUPT-3` and `FS-CORRUPT-4` must all pass before this leg starts.

**Not required and must not be enabled:** `security`. File permission bits exist on the inode and
are set by `chmod`, and they are one row and one column of an access matrix that this leg never
draws and never names. Domains, rings, roles, capabilities and the reference monitor all belong
to leg 12. `io` is leg 10's: this leg reads and writes blocks through the block device and never
touches a transfer mode, an interrupt line or a DMA controller.

---

## Required reading

- `docs/05-CURRICULUM-MAP.md`, "Leg 11. THE ARCHIVE" in full; section D, the leg 11 row; section
  A, the concept dependency edges into and out of this leg.
- `docs/02-KERNEL-SIM-SPEC.md`, **section 12 in full** (File systems, Ch. 13 to 15); section
  11.4 for the block cache write policy, because `write_back` losing dirty entries is the
  mechanism the crash uses; section 16.11 (the `FS-*` test vectors); section 15's file system
  invariants.
- `docs/04-NARRATIVE-BIBLE.md`, section 3.3 (ORRERY, in full); section 7 entries for `bit_rot`,
  `orphaned` and `memory_leak`; section 8 leg 11 event table; section 9 epitaphs for
  `storage_corruption`, all five stones; section 10 (the leg 11 depot and its ambient line);
  section 12 (critical section crossings; the Archive owns one of the nine).
- `docs/03-VISUAL-BIBLE.md`, section 10 "Leg 11, The Archive"; section 2.4.1 (the corruption
  treatment); section 8.6 (data flowing along a beam, which the journal ribbon uses); section 13
  (quality tiers).

---

## Frozen contracts

These types are frozen. You may not edit, extend, narrow or re-declare any of them.
A leg that appears to need a contract change stops and escalates, because every other
leg in flight depends on this file. Copy them into your leg only by importing:

```ts
import type { Leg, LegSetupContext, LegStage, LegOutcome /* ... */ } from '@game/types';
import type { KernelConfig, SubsystemId, Inode, JournalEntry, FileAllocationMethod /* ... */ } from '@kernel/types';
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

`LegSetupContext` has no `declareInode` and no `declareVolume`, and you may not add one. See the
Population section for how the volume layout reaches the kernel.

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

The file system half of the frozen kernel types this leg reads:

```ts
export interface Inode {
  readonly id: InodeId;
  name: string;
  kind: 'file' | 'directory' | 'link';
  sizeBytes: number;
  readonly method: FileAllocationMethod;
  blocks: BlockId[];
  /** Indexed allocation only. */
  indexBlock: BlockId | null;
  owner: DomainId;
  permissions: PermissionBits;
  createdTick: Tick;
  modifiedTick: Tick;
  linkCount: number;
}

export interface PermissionBits {
  readonly read: boolean;
  readonly write: boolean;
  readonly execute: boolean;
}

export interface JournalEntry {
  readonly tick: Tick;
  readonly txId: number;
  readonly phase: 'begin' | 'write' | 'commit' | 'checkpoint';
  readonly blocks: readonly BlockId[];
}
```

**`Inode.method` is `readonly` and `KernelConfig.fileAllocation` is a single value.** Those two
facts together decide how the format bench works and they are the first thing to get right. See
the Population section.

Every field of `KernelConfig` is required, including the ones your leg does not use.
Set the unused ones to the inert defaults given in the Kernel configuration section
below and leave their subsystem out of `enabledSubsystems`. An inert field is never
read, and the smoke test asserts that.

---

## Curriculum

### Chapters

```ts
export const chapters: readonly ChapterRef[] = [
  { chapter: 13, title: 'File-System Interface',
    sections: ['13.1.1', '13.1.2', '13.1.3', '13.2.1', '13.2.2',
               '13.3.1', '13.3.2', '13.3.3', '13.4.1', '13.4.2', '13.5'] },
  { chapter: 14, title: 'File-System Implementation',
    sections: ['14.1', '14.2.1', '14.2.2', '14.3.1', '14.3.2',
               '14.4.1', '14.4.2', '14.4.3', '14.5.1', '14.5.2',
               '14.6', '14.7.1', '14.7.2', '14.7.4'] },
  { chapter: 15, title: 'File-System Internals',
    sections: ['15.1', '15.2', '15.3', '15.4', '15.5', '15.7'] },
];
```

Three chapters, thirty-one sections. The 10th edition splits what earlier editions carried in
one chapter across 13 (interface), 14 (implementation) and 15 (internals), and the leg follows
that split: the catalogue teaches 13, the shelving and the crash teach 14, and the mount teaches
15. Do not cite 14.8 anywhere. The sim spec's §12.5 heading says "Journaling (Ch. 14.8 and
11.7.5)" and the 10th edition's journaling material is at **14.7.1** and **14.7.2**. Every
`ChapterRef` this leg constructs uses 14.7.1 and 14.7.2, and the curriculum map's objective and
command citations already do. Report the sim spec heading as a document defect.

### Learning objectives

```ts
export const objectives: readonly LearningObjective[] = [
  {
    id: 'obj.the_archive.allocation_method_choice',
    statement: 'Assigns indexed allocation to the random-access archive and contiguous allocation to the sequential stream, keeping average random access under two block reads.',
    chapter: { chapter: 14, title: 'File-System Implementation', sections: ['14.4.1', '14.4.2', '14.4.3'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.the_archive.linked_random_cost',
    statement: 'Shows with inode --walk that reading block 40 of a linked-allocation file requires 40 sequential reads, and declines linked allocation for the random workload.',
    chapter: { chapter: 14, title: 'File-System Implementation', sections: ['14.4.2'] },
    assessedBy: 'terminal_command',
  },
  {
    id: 'obj.the_archive.reclaim_free_space',
    statement: 'Recovers at least 60 blocks by rebuilding the free-space bitmap and by closing unlinked-but-open files located with lsof.',
    chapter: { chapter: 14, title: 'File-System Implementation', sections: ['14.5.1', '14.5.2'] },
    assessedBy: 'terminal_command',
  },
  {
    id: 'obj.the_archive.journal_before_crash',
    statement: 'Enables journaling before the scripted power loss, so post-crash recovery completes by replaying the log rather than by scanning every inode.',
    chapter: { chapter: 14, title: 'File-System Implementation', sections: ['14.7.1', '14.7.2'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.the_archive.write_ordering',
    statement: 'Orders the data write before the metadata write so that a crash between them leaves an unreferenced block rather than a directory entry pointing at unwritten space.',
    chapter: { chapter: 14, title: 'File-System Implementation', sections: ['14.2.1', '14.7.1'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.the_archive.mount_semantics',
    statement: 'Mounts the shared volume with consistency semantics under which no Program reads a version older than its own last write, with zero stale-read events.',
    chapter: { chapter: 15, title: 'File-System Internals', sections: ['15.2', '15.4', '15.7'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.the_archive.directory_structure',
    statement: 'Converts the flat 400-entry catalogue to a hashed or tree structure once linear lookup exceeds 30 ticks per open, bringing average open cost under 6 ticks.',
    chapter: { chapter: 14, title: 'File-System Implementation', sections: ['14.3.1', '14.3.2'] },
    assessedBy: 'outcome',
  },
];
```

Seven objectives, the joint highest count in the game with leg 12. That is a consequence of
three chapters and it is why the leg's mechanical complexity has to stay low: one bench per
movement, one command per idea, and no compound decisions.

### Codex entries this leg adds to `codexUnlocked`

`codex.file_concept`, `codex.access_methods`, `codex.directory_structure`,
`codex.allocation_methods`, `codex.free_space`, `codex.crash_consistency`, `codex.journaling`,
`codex.vfs`, `codex.consistency_semantics`.

| Entry | Added when |
|---|---|
| `codex.file_concept` | First `inode` invocation, or the first `open` on the catalogue. |
| `codex.access_methods` | The random workload and the sequential workload are both running. |
| `codex.directory_structure` | The catalogue's linear lookup crosses 30 ticks per open, or the structure is changed. |
| `codex.allocation_methods` | First `inode --method` invocation, or the first `fs.block_allocated` under a second method. |
| `codex.free_space` | First `lsof --unlinked` invocation, or the first failed allocation on a volume with visible free space. |
| `codex.crash_consistency` | The crash lands. Unconditionally, on every path. |
| `codex.journaling` | First `journal` invocation, or the crash landing with journaling enabled. |
| `codex.vfs` | First `mount --vfs` invocation. |
| `codex.consistency_semantics` | First `mount --semantics` invocation, or the first stale read. |

`codex.crash_consistency` unlocks unconditionally when the crash lands, including on the path
where the journal saved everything and nothing visibly went wrong. The concept was demonstrated
either way and the entry carries the player's own trace.

`codex.allocation_methods` cross-links to `codex.contiguous_allocation` and
`codex.fragmentation` from the Allocation Yards, because external fragmentation on disk is the
same problem as external fragmentation in memory with a much more expensive compaction. Register
the back-links here; leg 7 registers the forward links.

`codex.journaling` cross-links to `codex.io_buffering` from the Bus, on the strength of the
`devstat` man page's sentence about a returned write that has not reached the device. Register
the back-link here.

### Misconceptions this leg must break

**"Deleting a file frees its space."** Every student believes this and every system
administrator has been caught by it. The break is a volume that reports itself full while the
visible files sum to a fraction of capacity. The player deletes more files and the free count
does not move. `lsof --unlinked` shows four files with no directory entries, held open by a
Program, holding 140 blocks between them. The blocks return the moment the descriptors close.
The link count on the inode is the mechanism and `inode --links` shows it going to zero only
when both the name and the descriptor are gone.

Build requirement: **deleting more files must genuinely not help, and must be affordable enough
that the player tries it twice.** The volume has 6,400 blocks, reports 12 free, and the visible
files sum to 4,180. The four unlinked-but-open inodes hold 140. The bitmap is stale and
under-reports 48 more. The remaining 2,020 are genuinely allocated to workload files the player
should not delete. Deleting a visible file returns its blocks and the free count moves by
exactly that file's size, which is small, which is the point: the mechanism works and it is not
where the missing space went.

**"Journaling protects my data."** Students hear "journaling file system" and conclude their
file contents are safe. Metadata journaling, which is the common default, protects the file
system structure and says nothing about contents. The break is the scripted power loss run
in metadata mode: `fsck --from-journal` replays cleanly, reports the volume consistent, the
manifest exists with the right size and the right owner, and its contents are the previous
version's bytes. Nothing errored. The player then reruns the same crash in ordered mode and
the contents are correct, having paid for it in write bandwidth all leg.

Build requirement: the rerun is WP-18's counterfactual replay, not a second live crash. The
player does not get to crash the hall twice. The debrief offers the same crash under `ordered`
and draws the two outcomes side by side, and the file that differs between them is the manifest,
by contents, with the same size and the same owner in both.

**"A directory contains files."** The containment model makes hard links, link counts and
the behaviour of deletion incomprehensible, and students carry it a long way. The break is
constructive rather than corrective: the player is asked to make the convoy manifest
reachable from two catalogue locations without copying it, which is impossible under the
containment model. Creating the second entry raises the link count to 2 and `inode --links`
shows one inode with two names. Removing one name leaves the file intact and reachable by the
other, which the containment model predicts should have deleted it.

Build requirement: the task must be stated as a requirement rather than as an instruction. The
catalogue bench asks for the manifest to be reachable from `/route/` and from `/convoy/` with
one copy of the bytes, and offers copy, link and move as three actions with their block costs
posted. Copy costs 64 blocks and satisfies the letter of the request and not the "one copy"
clause; move satisfies neither. Link costs 0 blocks and is correct. Post all three costs.

---

## Kernel configuration

```ts
export function kernelConfig(run: RunState): KernelConfig {
  return {
    seed: run.seed,
    scheduler: 'rr',                       // the catalogue's readers and the writer must interleave
    schedulerParams: {
      quantum: quantumForPace(run.policy.pace),
      agingInterval: 0,                    // nothing starves here; the rwlock policy is leg 5's lesson
      starvationThreshold: 120,
      starvationFatalThreshold: 300,
      preemptive: true,
    },
    totalFrames: 64,                       // inert: 'memory' is not enabled
    pageSize: 4096,                        // inert
    replacementPolicy: 'lru',              // inert
    allocationStrategy: 'first_fit',       // inert
    tlbEntries: 16,                        // inert
    diskPolicy: 'clook',                   // LIVE BUT FROZEN. See below.
    totalCylinders: 200,                   // LIVE BUT FROZEN. See below.
    raidLevel: null,                       // inert: no array on this leg
    fileAllocation: fileAllocationForVolume(run),   // PLAYER-SET at the format bench
    journalingEnabled: journalingForRun(run),       // PLAYER-SET at the journal bench
    deadlockStrategy: 'ignore',            // inert: 'deadlock' is not enabled
    thrashingThreshold: 200,               // inert
    enabledSubsystems: ['process', 'scheduler', 'storage', 'fs'],
  };
}
```

**`diskPolicy` and `totalCylinders` are live and frozen.** The file system sits on a block device
and the device needs a scheduling policy, so neither field is inert and the inert-field test must
exempt both. The leg neither teaches disk scheduling nor exposes it: there is no interaction, no
command and no world structure on this leg that reads or writes either field, and an acceptance
criterion asserts that. `clook` is chosen because it is the practical default and because it
makes the recovery scan's cost predictable; freeze it and do not tune it to make a number come
out.

**`fileAllocation` is the volume default and it is not the whole story.** The frozen
`KernelConfig` carries one `FileAllocationMethod` and the frozen `Inode.method` is `readonly`
and per file. §12.3 states that a single file system may hold files of different methods so the
comparison is live, which is exactly what this leg needs. The resolution:

- `KernelConfig.fileAllocation` is the **volume default**, set once at the format bench, applied
  to every file created without an explicit method.
- The four workload files are created with explicit methods through WP-10's inode creation path,
  which takes a method argument. Their `Inode.method` values differ from each other and from the
  volume default, and none of them is mutated after creation.
- Changing a file's method is a **reformat**: the file is recreated with the new method and its
  blocks are reallocated, costing the block count of the file. The format bench prices that and
  the player pays it. There is no in-place method change, because `Inode.method` is `readonly`
  and because a real file system does not have one either.

That last point is teaching rather than a workaround. The player who assigns linked allocation to
the random workload and then wants to change their mind pays 64 blocks to do it, which is the
honest cost of having chosen the layout wrong.

**`journalingEnabled` is player-set and its cost is charged visibly.** The journal costs blocks
per transaction, continuously, whether or not a crash ever happens. See the Population section
for the exact charge.

### The journal mode, and where it lives

`KernelConfig` has `journalingEnabled: boolean` and no mode field. The `journal` man page offers
`--mode metadata|ordered|data`. The sim spec's §12.5 table names the modes `metadata`, `full`
and `off`. Three names for what is partly the same thing, and the resolution is:

| Player-facing name, from the man page | Sim spec name | What is journaled | Write cost |
|---|---|---|---|
| `metadata` | `metadata` | inodes, directory entries, the bitmap | ~1.1x |
| `ordered` | not named in the sim spec | metadata, with data blocks forced out before the metadata commit | recorded at implementation, expected between 1.1x and 1.3x |
| `data` | `full` | metadata plus data blocks; everything written twice | 2.0x |
| journaling off | `off` | nothing | 1.0x |

Ship the man page's names, because the man page text is copied byte for byte and must remain
true. The mode itself lives in the leg's own state and reaches the file system through WP-10's
`journalMode` configuration hook, alongside `KernelConfig`, exactly as the Bus passes its device
manifest. **Do not add a mode field to `KernelConfig` and do not encode the mode into
`journalingEnabled`.**

`ordered` is the mode the sim spec does not price. Write the test so it prints the measured ratio
and then pin it, per the briefing's rule for rows recorded at implementation. `FS-JOURNAL-COST`
pins `off`, `metadata` and `data` at 1.0 : ~1.1 : 2.0 and those three are asserted rather than
recorded.

### The volume layout, and how it reaches the kernel

`LegSetupContext` exposes `spawn`, `bind`, `declareResource` and `declareSync`, and nothing else.
There is no `declareInode` and no `declareVolume`.

The leg supplies its volumes, directories and files as a plain data manifest in
`src/legs/the_archive/volume.ts`, exported frozen, and the leg runner hands it to the kernel at
construction alongside `KernelConfig` and the journal mode. Agree that channel with WP-10 and
WP-19 before you write the stage. If neither offers a manifest channel, the fallback is a
sequence of `open`, `write` and `link` syscalls issued from a spawned setup process during
`populate`, which is slower and works; take it only if the manifest channel is refused, and
report which you used.

---

## Population

```ts
export function populate(ctx: LegSetupContext): void {
  const roster: readonly [ConvoyMemberId, string, number, number, number, number][] = [
    // member,      name,      priority, burst, service, pages
    ['lumen',   'LUMEN',   2, 6, 62, 14],
    ['sable',   'SABLE',   2, 5, 56, 12],
    ['orrery',  'ORRERY',  3, 5, 56, 12],   // her passive and her restore are the leg's hinge
    ['kestrel', 'KESTREL', 3, 4, 50, 10],
    ['vesper',  'VESPER',  3, 5, 56, 12],
  ];
  roster.forEach(([member, name, priority, burst, service, pages], i) => {
    const pid = ctx.spawn({ name, priority, burst, service, arrival: i, pages });
    ctx.bind(member, pid);
  });

  // The catalogue's readers. Six of them, opening files by name, which is what makes
  // linear lookup on 400 entries measurable.
  for (let i = 0; i < 6; i++) {
    ctx.spawn({ name: `archive.clerk_${i}`, priority: 4, burst: 3, service: 320, arrival: 20 + i * 3, pages: 6 });
  }

  // The random-access workload. It reads block 40 of its file and it does so repeatedly.
  for (let i = 0; i < 3; i++) {
    ctx.spawn({ name: `archive.random_${i}`, priority: 4, burst: 3, service: 280, arrival: 90 + i * 4, pages: 6 });
  }

  // The sequential workload. It streams its file from block 0 to block 63.
  for (let i = 0; i < 2; i++) {
    ctx.spawn({ name: `archive.stream_${i}`, priority: 4, burst: 4, service: 300, arrival: 90 + i * 4, pages: 6 });
  }

  // The Program holding the four unlinked descriptors. It must stay alive, because closing
  // the descriptors is the player's action rather than a consequence of the process ending.
  ctx.spawn({ name: 'archive.holder', priority: 5, burst: 2, service: 900, arrival: 10, pages: 4 });

  // The manifest writer. The crash interrupts this one's transaction.
  ctx.spawn({ name: 'archive.manifest_writer', priority: 3, burst: 4, service: 240, arrival: 400, pages: 6 });

  // The shared volume's second reader, for the mount semantics segment.
  ctx.spawn({ name: 'archive.remote_reader', priority: 4, burst: 3, service: 260, arrival: 620, pages: 5 });

  // The catalogue crossing. One rwlock, ordered, typical contention 0.50.
  ctx.declareSync('rw.catalogue', 'rwlock', 6);
}
```

One `declareSync` and no `declareResource`. The Archive owns **one of the nine critical section
crossings**: an rwlock at the catalogue, ordered, with typical contention 0.50. Route it through
WP-19's shared crossing system with contention computed from the live snapshot, and do not
reimplement the cost formulas. Leg 12 owns the ninth and last.

### The volume, exactly

```ts
export const archiveVolume = {
  totalBlocks: 6400,          // 4 KB blocks, matching FS-BITMAP-1
  blockSize: 4096,
  pointerSize: 32,            // so a pointer block holds 128 pointers
  bitmapWords: 200,           // ceil(6400 / 32)
  freeSpaceMethod: 'bitmap',  // player-settable; contiguous over linked_list is refused
  directoryImpl: 'linear',    // player-settable: linear, hashed, tree
  catalogueEntries: 400,
} as const;
```

### The four workload files

Every one of them is 64 blocks, so the four allocation methods are compared on identical files
and the only variable is the layout. That is `FS-ALLOC-1`'s setup and it is why the numbers are
checkable.

| File | Workload | Access pattern | Correct method | Wrong methods and what they cost |
|---|---|---|---|---|
| `/archive/index` | `archive.random_*` | 20 random reads, block 40 the most frequent | `indexed` | `linked` costs 650 reads for the 20; `contiguous` works and cannot grow |
| `/archive/stream` | `archive.stream_*` | sequential, block 0 to 63 | `contiguous` | `indexed` costs one extra read and one wasted block; `linked` costs up to 64 seeks |
| `/route/manifest` | `archive.manifest_writer` | append, then rewrite | `extent` | `contiguous` relocates the whole file on append when the next block is occupied |
| `/archive/ledger` | ambient | mixed | `extent` | any, at a measurable cost |

### The allocation method table, verbatim from the sim spec

`FS-ALLOC-1`: a 64-block file, 20 random reads.

| Method | Blocks used | Sequential read | 20 random reads | 20 appends | Fragmentation |
|---|---|---|---|---|---|
| contiguous | 64 | 64 reads, 1 seek | 20 reads | may relocate the whole file | external |
| linked | 64 | 64 reads, up to 64 seeks | mean 32.5 reads each, **650 total** | 20 reads + 20 writes | none |
| indexed | 65 | 65 reads | 40 reads | 20 reads + 40 writes | none, 1 block overhead |
| extent | 64 | 64 reads, `e` seeks | 20 reads | 20 writes, metadata when a new extent starts | measured by `e` |

**The 650 is the number the player remembers and it must be on screen.** `inode --walk` on the
linked file prints the read count for the requested block, and the bench posts the total for the
20-read workload. `obj.the_archive.linked_random_cost` asks specifically for block 40, which
costs **41 reads** under linked allocation: `i + 1` where `i` is 40. The objective's statement
says 40 sequential reads and the sim spec's cost model says `i + 1 = 41`. Follow the sim spec
and make `inode --walk 40` print 41, because 41 is what the model computes and a game that
teaches an off-by-one is worse than one that disagrees with its own objective text. Assess the
objective on the invocation and the subsequent method choice rather than on the printed number,
which is what the assessment paragraph already says. Report the discrepancy.

`FS-ALLOC-3`: appending to a contiguous file whose next block is occupied relocates the whole
file: `n` reads and `n` writes, so 64 and 64 on these files. That is what makes `contiguous`
wrong for the manifest, which appends.

### The free space accounting, exactly

| Quantity | Blocks | How the player finds it |
|---|---|---|
| Volume capacity | 6400 | `df`, or the bench readout |
| Visible files | 4180 | the catalogue |
| Genuinely allocated workload files | 2020 | the four workload files plus the catalogue's own blocks |
| Held by four unlinked-but-open inodes | **140** | `lsof --unlinked` |
| Under-reported by the stale bitmap | **48** | `fsck --check`, or the rebuild |
| Reported free at leg open | 12 | the bench readout |

Rebuilding the bitmap recovers 48. Closing the four descriptors recovers 140. Together, 188.
`obj.the_archive.reclaim_free_space` requires at least 60 recovered **and** at least one `lsof`
invocation preceding the recovery, so neither mechanism alone satisfies it by accident: 48 alone
is under the threshold and 140 alone does not exercise the bitmap. Freeze all six numbers.

The four unlinked inodes hold 40, 40, 32 and 28 blocks. `inode --links` on each shows
`linkCount: 0` with an open descriptor, which is the state the containment model says cannot
exist.

### The catalogue

400 entries, linear. Lookup cost is `entries / 2` directory reads on average, and each read is
one tick at this volume's block cache hit rate, so average open cost opens at **34 ticks** and
crosses the objective's 30-tick trigger within the first 60 ticks of the leg under the clerks'
load. Hashed brings it to **2 ticks**. Tree brings it to **5 ticks**, being `log2(400)` rounded
up to 9 comparisons at a lower per-comparison cost. Both satisfy the objective's under-6 ticks
requirement and the player may choose either. Freeze 34, 2 and 5.

`FS-PATH-1`: resolving `/a/b/c/d/e` costs 5 directory reads and checks `execute` on each of `/`,
`a`, `b`, `c` and `d`. The permission check is present, is charged, and is never explained on
this leg. Leg 12 explains it.

### The crash, exactly

The crash is scripted, its position is chosen by the leg, and it is never drawn from an RNG.
§12.5 says the crash point is chosen at one of eight positions in the write-ahead protocol so
that the player can be shown each case, and this leg uses two of them.

**The main crash**, at **tick 900**, interrupts `archive.manifest_writer`'s append transaction
**between the data write and the metadata write**. `ioctl('crash')` runs its five numbered steps:
discard every dirty block cache entry, discard any journal entry not followed by a flush, reset
every device, drop every queued request, emit `kernel.panic { message: 'crash' }`.

The block cache write policy is `write_back`, which is what makes step 1 lose data. That policy
was set at a depot several legs earlier and the player may have set it to `write_through`. If
they did, the crash loses nothing from the cache and the leg's teaching is weaker and the leg is
still correct. Read the setting; do not override it; name it in the debrief.

Outcomes by configuration:

| Journaling | Write ordering | On-disk state after the crash | `fs.corruption` | `fsck` cost |
|---|---|---|---|---|
| on, any mode | data before metadata | transaction has `begin` and no `commit`; recovery discards it | `recoverable: true` | 12 ticks, `--from-journal` |
| on, any mode | metadata before data | same; the journal makes the ordering irrelevant | `recoverable: true` | 12 ticks, `--from-journal` |
| off | data before metadata | an unreferenced block: data written, nothing points at it | `recoverable: true`, orphaned inode | 200 ticks, full scan; the block lands in lost and found |
| off | metadata before data | a directory entry pointing at blocks that were never written | **`recoverable: false`**, dangling entry | 200 ticks, full scan; structure restored, contents are whatever was there before |

**The fourth row is the alarming one and it is the one that reports no error.** The file exists,
with the right size and the right owner, full of the previous version's bytes. Nothing on this
leg says so except `fsck`'s own honest sentence in the man page: it restores structural
consistency and has no way to know what your data was supposed to be.

`obj.the_archive.write_ordering` reads the order of `fs.block_allocated` against the metadata
write in the interrupted transaction, so it is assessed on the transaction the crash lands in
and on no other.

**The crash bench**, at `anchor.crash_bench`, is the second use. It runs §12.6's `unlink`
decomposition at all four crash points against a scratch inode, so the player can see all four
rows of the corruption table without the hall going dark. It costs 4 blocks per run, it is
repeatable, and it touches nothing the convoy depends on:

| Crash after | State on disk | Name | `recoverable` |
|---|---|---|---|
| A only | inode exists, no directory entry, blocks marked used | orphaned inode | `true` |
| A and B | inode free, blocks still marked used | leaked blocks | `true` |
| B only | directory entry points at a free inode | dangling entry, silent aliasing | `false` |
| C only | blocks marked free while an inode still lists them | double allocation, silent data destruction | `false` |

Invariant I-29 fires on the double allocation case at the next slow check. Let it fire. It is a
dev-build assertion and it is correct that it fires.

### The mount segment

The shared volume mounts at `/shared` with one of three semantics. `archive.remote_reader` opens
a file, `archive.manifest_writer` writes it, and the reader reads again.

| `--semantics` | What the reader sees | Stale reads on this workload | Objective |
|---|---|---|---|
| `unix` | the write, immediately | **0** | satisfied |
| `session` | the pre-write contents until it reopens | **3** | not satisfied |
| `immutable` | the pre-write contents; the write creates a new file | 0 stale reads and the write does not land where the convoy expects | not satisfied, because the route the reader follows is the old one |

`obj.the_archive.mount_semantics` requires zero stale-read events and that no Program reads a
version older than its own last write, so only `unix` satisfies it on this workload. The
`mount` man page states plainly that shared volumes have no default that is right for everyone
and that the player should pick by asking what a stale read costs here, which on this crossing
costs a Program that follows a route the convoy has already abandoned. That sentence is the
answer and it is already in the man page.

Freeze the stale-read count of 3 under `session`.

### The journal's continuous cost

Journaling costs blocks per transaction and the charge is visible. At `metadata`, the leg's
workload runs **31 transactions** and the charge is **1 block per transaction**, so 31 blocks
across the leg. At `ordered` the charge is the same 31 blocks plus the data barrier's write
bandwidth. At `data` the charge is 31 blocks plus a full second copy of every data block
written, which on this workload is **96 blocks**, so 127 total.

The player pays it whether or not the crash ever comes, which is what insurance is, which is the
sentence the man page ends that section with. Post the running charge at `anchor.journal_bench`
so the player watches it accumulate before they know whether it was worth it.

### The foreshadowing plant

Once, in ambient text, not underlined, not repeated: **the journal contains committed
transactions from before the Substrate's own boot tick.** Put three `JournalEntry` records at
the head of the log with a `tick` value lower than the run's boot tick, visible in
`journal --tail`, with valid `txId` values and complete `begin`, `write`, `commit`, `checkpoint`
sequences. They replay idempotently and change nothing. Nobody remarks on them. They are not an
objective, they are not interactive, and they must not participate in the crash.

---

## Stage

**Form.** Spindles and block cubes on shelves.
**Accent.** `CYAN.core`, with corruption drawn per 2.4.1.
**Environment.** A vault of stacked shelving. Each inode is a spindle with radial arms
reaching to the blocks it owns. Contiguous allocation has short straight arms, linked
allocation has a chain of beams hopping shelf to shelf, and indexed allocation has one arm to
an index block and a fan from there.
**Hero visual.** Journal replay. A corrupted spindle, quantised and hue-jittered and visibly
wrong, is rebuilt block by block from a lit ribbon of journal entries running along the
floor. Each `JournalEntry` in the ribbon lights as it is applied and the corruption retreats
from the spindle in the order the transactions committed. Without journaling enabled, the
ribbon is absent and the spindle stays broken, which is the entire argument for journaling.

| Anchor id | Structure | Focus camera target |
|---|---|---|
| `anchor.hall` | The vault of shelving, seen from the entrance | wide establishing |
| `anchor.catalogue` | The 400-entry catalogue at the entrance, with its structure and its average open cost | head-on orthographic; the entry count and the cost figure legible |
| `anchor.catalogue_bench` | Linear, hashed, tree, with the measured cost beside each | head-on |
| `anchor.spindle.<inode>` | One inode as a spindle with radial arms to its blocks | head-on; the arm pattern must identify the method without a label |
| `anchor.format_bench` | The four allocation methods, with sequential cost, random cost and growth behaviour posted for each | head-on orthographic; **all four methods and all three cost columns in one frame** |
| `anchor.walk_line` | The `inode --walk` path, drawn along the shelves as the reads happen | overhead; the 41-hop walk on the linked file must read as a walk |
| `anchor.free_map` | The free-space map, as a bit field or a chain depending on the method | head-on orthographic; the stale under-report must be visible as a discrepancy |
| `anchor.descriptor_rack` | Open descriptors, with the four unlinked ones marked as holding blocks with no name | head-on; the four and their 140 blocks legible |
| `anchor.link_bench` | The two-catalogue-locations task, with copy, link and move and their block costs | head-on; all three costs in one frame |
| `anchor.journal_bench` | Enable, mode, and the running block charge | head-on orthographic; the accumulating charge legible |
| `anchor.journal_ribbon` | The write-ahead log along the floor, entries lighting as they are applied | **the hero shot**; overhead along the ribbon's length, with the spindle in frame |
| `anchor.write_order_bench` | Data first, or metadata first | head-on |
| `anchor.crash_bench` | The four crash points of the unlink decomposition, with the resulting state named | head-on orthographic; all four rows in one frame |
| `anchor.mount_point` | The shared volume, its mount point, and the VFS layer | head-on |
| `anchor.semantics_selector` | unix, session, immutable, with what a reader sees under each | head-on |
| `anchor.depot` | The leg 11 depot | head-on |
| `anchor.convoy.<member>` | Per-Program stele | head-on |

### Two hard stage requirements

**The spindle's arm pattern identifies the allocation method without a label.** Contiguous is a
short straight fan to adjacent shelf positions. Linked is a single chain of beams hopping shelf
to shelf, one hop per block, and reading block 40 lights 41 hops in sequence. Indexed is one arm
to a single index block and a fan from there. Extent is a small number of short fans, one per
extent, and the extent count is the number of fans. A player who has seen all four should be
able to name a file's method from across the hall. If the method needs a text label to be
legible, the geometry is wrong.

**The absence of the ribbon is the argument.** When journaling was off at the crash tick, there
is no ribbon, the spindle stays quantised and hue-jittered, and nothing appears to replace it.
Do not substitute a progress bar, an error panel, a red flash or an explanatory caption. The
hero visual is a thing happening, and its counterpart is that thing not happening, in the same
space, with the same framing. The player who ran without a journal looks at an empty floor where
the ribbon would have been.

---

## Interactions

```ts
export const interactions: readonly InteractionDef[] = [
  {
    id: 'archive.set_volume_method',
    label: 'Set the volume allocation method',
    description: 'The default for files created without one. Contiguous, linked, indexed or extent.',
    anchor: 'anchor.format_bench',
    cost: { cycles: 8 },
    enabledWhen: (run) => run.resources.cycles >= 8,
  },
  {
    id: 'archive.set_file_method',
    label: 'Reformat a file to a different method',
    description: 'The layout is chosen when the file is created. Changing it reallocates every block and costs one block per block moved.',
    anchor: 'anchor.format_bench',
    cost: { blocks: 64 },
    enabledWhen: (run) => run.resources.blocks >= 64,
  },
  {
    id: 'archive.set_free_space_method',
    label: 'Set the free-space method',
    description: 'Bitmap, linked list, grouping or counting. Only one of them can find a run of free blocks.',
    anchor: 'anchor.free_map',
    cost: { cycles: 6 },
    enabledWhen: (run) => run.resources.cycles >= 6,
  },
  {
    id: 'archive.rebuild_bitmap',
    label: 'Rebuild the free-space map',
    description: 'Scan every inode and recompute what is actually allocated. Costs a full pass.',
    anchor: 'anchor.free_map',
    cost: { cycles: 20 },
    enabledWhen: (run) => run.resources.cycles >= 20,
  },
  {
    id: 'archive.close_descriptor',
    label: 'Close a descriptor',
    description: 'A file with no name and an open descriptor still holds its blocks.',
    anchor: 'anchor.descriptor_rack',
    cost: { bandwidth: 2 },
    enabledWhen: (run) => run.resources.bandwidth >= 2,
  },
  {
    id: 'archive.set_directory_impl',
    label: 'Set the catalogue structure',
    description: 'Linear, hashed or tree. Four hundred entries is where linear stops being free.',
    anchor: 'anchor.catalogue_bench',
    cost: { cycles: 12, blocks: 6 },
    enabledWhen: (run) => run.resources.cycles >= 12 && run.resources.blocks >= 6,
  },
  {
    id: 'archive.reach_from_two_places',
    label: 'Make the manifest reachable from two locations',
    description: 'Copy, link, or move. One copy of the bytes was part of the request.',
    anchor: 'anchor.link_bench',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'archive.set_journaling',
    label: 'Enable or disable journaling',
    description: 'It costs blocks per transaction, continuously, whether or not anything ever goes wrong.',
    anchor: 'anchor.journal_bench',
    cost: { blocks: 8 },
    enabledWhen: (run) => run.resources.blocks >= 8,
  },
  {
    id: 'archive.set_journal_mode',
    label: 'Set the journal mode',
    description: 'Metadata, ordered or data. Only one of them says anything about your file contents.',
    anchor: 'anchor.journal_bench',
    cost: { blocks: 4 },
    enabledWhen: (run) => run.resources.blocks >= 4,
  },
  {
    id: 'archive.set_write_ordering',
    label: 'Set the write ordering',
    description: 'Data before metadata, or metadata before data. A crash between them leaves a different wrong thing in each case.',
    anchor: 'anchor.write_order_bench',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'archive.run_crash_bench',
    label: 'Crash the scratch inode',
    description: 'Four points in one unlink. Four different inconsistencies, two of which nothing detects.',
    anchor: 'anchor.crash_bench',
    cost: { blocks: 4 },
    enabledWhen: (run) => run.resources.blocks >= 4,
  },
  {
    id: 'archive.set_mount_semantics',
    label: 'Set the shared volume semantics',
    description: 'Unix, session or immutable. Ask what a stale read costs here before choosing.',
    anchor: 'anchor.semantics_selector',
    cost: { cycles: 6 },
    enabledWhen: (run) => run.resources.cycles >= 6,
  },
  {
    id: 'archive.orrery_restore',
    label: 'Rebuild an inode from the journal',
    description: 'ORRERY reconstructs one corrupted inode. Three charges. It does nothing at all if there is no journal.',
    anchor: 'anchor.journal_ribbon',
    cost: { blocks: 10 },
    enabledWhen: (run) =>
      run.convoy.some((m) => m.id === 'orrery' && m.alive) && run.resources.blocks >= 10,
  },
];
```

`archive.orrery_restore` is offered even when journaling was off, and it consumes a charge and
achieves nothing, and it says so in its own description before the player spends it. That is the
leg's sharpest lesson about paying in advance and it only lands if the player is allowed to
reach for the tool and find it empty. Do not disable the verb when the journal is missing, and
do not warn a second time at the moment of use.

---

## Terminal commands

Five commands, copied verbatim from the curriculum map into `src/legs/the_archive/commands.ts`:
`inode`, `journal`, `fsck`, `lsof`, `mount`. The full `manual` text is in
`docs/05-CURRICULUM-MAP.md`, "Leg 11. THE ARCHIVE". Copy byte for byte.

Five commands is the most any leg introduces. The leg can carry it because each one belongs to
exactly one movement: `inode` and `journal` to the shelving and the crash, `lsof` to the
reclamation, `fsck` to the aftermath, `mount` to the last segment.

Load-bearing lines:

- `inode`: "The inode is the file. The name is not; names live in directories, which are just
  files whose contents are name-to-inode pairs." This is the third misconception, stated, and
  the link bench is where the player performs it.
- `inode --walk`, the four-method block, in full. It is the format bench's posted text and the
  bench must not paraphrase it.
- `journal`: "If a crash happens before the commit record, the transaction never happened and
  the log is discarded. If it happens after, recovery replays the log and finishes the job."
- `journal`, the modes block: "metadata ... it does not promise your file contents are right."
  This is the second misconception, stated in advance, which is what makes the break fair.
- `journal`: "Journaling costs blocks and it costs write bandwidth, continuously, whether or not
  a crash ever happens. That is what insurance is. Deciding after the crash is not an option the
  system offers."
- `fsck`: "An inode whose blocks were never written will be repaired into a perfectly consistent
  file full of stale contents, and fsck will report success, because by its definition it
  succeeded." This is the sentence that has to be true of the implementation, exactly.
- `lsof --unlinked`: "This is why a volume can report itself full while the sum of the visible
  files is far less than its capacity, and why deleting more files does not help."
- `mount --semantics`: "Pick by asking what a stale read costs you here. On this crossing it
  costs a Program that follows a route the convoy has already abandoned."

Every `See also:` must resolve. `inode` sees `fsck`, `journal`, `lsof` and `codex
allocation_methods`. `journal` sees `fsck`, `devstat`, `sync` and `codex journaling`; `devstat`
is leg 10's and must still be registered, and `sync` is a base-shell syscall command that WP-15
owns. `fsck` sees `journal`, `inode`, `lsof` and `codex crash_consistency`. `lsof` sees `fsck`,
`inode --links` and `codex free_space`. `mount` sees `inode`, `lsof` and `codex vfs`.

`df` is not introduced by this leg and the free-block count must therefore be readable from the
world at `anchor.free_map` and from `fsck --check`. If WP-15's base shell does not carry `df`,
file it and use the bench.

---

## Event table

Copied verbatim from `04-NARRATIVE-BIBLE.md` section 8, leg 11. Weights sum to 100.

```ts
export const archiveEvents: readonly RandomEventDef[] = [
  {
    id: 'archive.unjournaled_write',
    weight: 13,
    title: 'Written, Never Committed',
    narration: 'The data blocks reached the platter and the commit record did not. Whatever was in that directory is a matter of opinion now.',
    targets: 'codec', inflicts: 'bit_rot',
    resourceDelta: { blocks: -22 },
    onlyIf: null,
  },
  {
    id: 'archive.directory_cycle',
    weight: 11,
    title: 'A Loop in the Tree',
    narration: 'A hard link points a directory at one of its own ancestors, and the traversal that was supposed to end does not. The entries inside it are reachable and unreferenced at the same time.',
    targets: null, inflicts: 'orphaned',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'archive.linked_allocation',
    weight: 12,
    title: 'Every Block Points At The Next',
    narration: 'The file is stored as a chain and reading the last block means reading all of them. Sequential access is fine. Nothing here is sequential.',
    targets: null, inflicts: 'fragmented',
    resourceDelta: { cycles: -45 },
    onlyIf: null,
  },
  {
    id: 'archive.free_list_scan',
    weight: 12,
    title: 'Walking the Free List',
    narration: 'Finding a free block means following the list until one turns up, and the list has eleven thousand entries in no useful order. The bitmap that would have answered instantly was not maintained.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -50, bandwidth: -6 },
    onlyIf: null,
  },
  {
    id: 'archive.link_tangle',
    weight: 10,
    title: 'Link Count Wrong',
    narration: 'An inode believes three names point at it and only one does. It will never be freed and nothing will ever read it again.',
    targets: null, inflicts: 'memory_leak',
    resourceDelta: { quota: -40 },
    onlyIf: null,
  },
  {
    id: 'archive.extent_windfall',
    weight: 15,
    title: 'One Extent',
    narration: 'A large file here is stored as a single extent: a start block and a length, and nothing else. It reads at the speed of the platter and the metadata is four bytes.',
    targets: null, inflicts: null,
    resourceDelta: { blocks: 28, cycles: 40 },
    onlyIf: null,
  },
  {
    id: 'archive.journal_commit',
    weight: 15,
    title: 'Commit Record Intact',
    narration: 'ORRERY finds a full transaction in the journal: begin, writes, commit, checkpoint, in order and complete. Everything it described can be put back exactly as it was.',
    targets: 'codec', inflicts: null,
    resourceDelta: { blocks: 25, cycles: 35 },
    onlyIf: null,
  },
  {
    id: 'archive.indexed_block',
    weight: 12,
    title: 'Index Block',
    narration: 'One block holds the addresses of every other block in the file, so any offset is two reads away. The convoy copies the layout and uses it for the rest of the leg.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 45, bandwidth: 8 },
    onlyIf: null,
  },
];
```

`archive.journal_commit` is `targets: 'codec'` and names ORRERY in its narration. It must not
fire when ORRERY is dead. The frozen `RandomEventDef` carries `onlyIf`, which is `null` in the
bible's table, and the leg is permitted to supply a predicate where the bible states one. The
bible states none here, so this is a leg decision: set `onlyIf: (run) => isAlive(run, 'orrery')`
on `archive.journal_commit` and redistribute its weight of 15 across the remaining seven in
proportion when she is dead, so the table still sums to 100. Do the same for
`archive.unjournaled_write`, which also targets her. Report both predicates, because they are
the only two places this leg departs from the bible's table.

---

## Evaluation

### Survival

The leg is survived when at least one convoy Program is alive at leg end.

**Unjournaled corruption** is the failure and its full decision matrix is in The ORRERY
dependency and in The crash, exactly. Restating only what kills: `fs.corruption` with
`recoverable: false`, un-upgraded by ORRERY because she is dead, means any Program acting on the
manifest derezzes with `TerminationReason: 'storage_corruption'`. That is the only death
mechanism this leg has and it requires two conditions to have been met, one of them possibly
several legs ago.

**`bit_rot` continues from the Platters** and it is the game's one long-fuse trap. 0.3 integrity
per tick, fatal after **400 ticks**, terminating with `'storage_corruption'`. Four hundred ticks
is roughly four legs, so bit rot acquired at the Platters kills at the Arbiter Wall. This leg
inflicts it through `archive.unjournaled_write` and must not clear it silently. The true remedy
is spending 12 blocks on a scrub-and-rewrite pass, available at the depot. The misleading remedy
is repairing the Program's integrity, which raises the bar and leaves the clock running, because
the clock is on the blocks. Do not add a warning. The affliction list is always visible and that
is the fairness the trap rests on.

**The reversed write ordering** is the more alarming of the two crash outcomes and it kills
nobody directly. A directory entry pointing at blocks that were never written reads as a file
full of whatever was there before. `fsck` reports success. The player finds out when a later
read comes back wrong, which on this leg is the manifest and on a longer horizon is any block
the double-allocation case handed to a second file.

**`orphaned` and `memory_leak`** arrive from the event table and drain without killing.
`orphaned` is 0.4 per tick and never fatal; `memory_leak` is 0.5 per tick and never fatal. Both
have terminal remedies and both are leg 1's and leg 7's respectively. Do not re-teach either.

### Objectives

| Objective | Computed from |
|---|---|
| `obj.the_archive.allocation_method_choice` | `Inode.method` on `/archive/index` is `indexed` and on `/archive/stream` is `contiguous`, **and** the measured mean block reads per random access on the index file is under 2.0 across the random workload's whole run. Both. |
| `obj.the_archive.linked_random_cost` | An `inode --walk` invocation naming block 40 on a linked-allocation file, followed by a method choice other than `linked` for the random workload, with no intervening method choice. |
| `obj.the_archive.reclaim_free_space` | Closing free block count exceeds the pre-reclamation count by 60 or more, with at least one `lsof` invocation preceding the first recovery action. |
| `obj.the_archive.journal_before_crash` | `journalingEnabled === true` at the tick of the power loss **and** an `fs.recovered` event with `fromJournal: true`. Both, because enabling it after the crash produces neither. |
| `obj.the_archive.write_ordering` | The order of `fs.block_allocated` against the metadata write inside the transaction the crash interrupts. Data first passes. Read the interrupted transaction only. |
| `obj.the_archive.mount_semantics` | Zero stale-read events on `/shared` across the segment, and no Program reading a version older than its own last write. Only `unix` satisfies both on this workload. |
| `obj.the_archive.directory_structure` | Average open cost across the last 100 ticks of the leg is under 6 ticks, and the structure was changed after linear lookup crossed 30 ticks per open. |

`obj.the_archive.journal_before_crash` is assessed on the tick of the crash and on nothing else.
A player who enables journaling at tick 901 has a journal, has paid for it, and does not have
this objective, and the debrief says so in one clause.

### Debrief card

```ts
{
  headline: /* 'The Archive held.' or 'Consistent, and wrong.' */,
  whatHappened:
    `The catalogue ran ${dirImpl} at ${openCost} ticks per open. The index file ran ` +
    `${indexMethod} at ${randomReads} reads per random access. Journaling was ` +
    `${journalState} at tick 900 in ${journalMode} mode, having cost ${journalBlocks} blocks. ` +
    `The write ordering was ${ordering}. Recovery took ${recoveryTicks} ticks and the ` +
    `manifest came back ${manifestState}. ${reclaimed} blocks were reclaimed.`,
  whyItHappened: /* selected */,
  counterfactual: /* computed */,
  chapter: { chapter: 14, title: 'File-System Implementation', sections: ['14.7.1', '14.7.2'] },
}
```

Counterfactual, in priority order:

1. **Journaling off and ORRERY dead.** `"The crash landed between the data write and the
   metadata write with no log to replay and no codec to rebuild from it. ORRERY died at
   ${legName}, tick ${tick}. With the journal enabled, recovery is ${jTicks} ticks against the
   ${fTicks} the full scan cost, and the manifest comes back with its own bytes."` Name the leg
   and the tick of her death from `RunState.tombstones`. This ranks first because it is the only
   outcome the player cannot undo and the only one whose cause is off this leg.
2. **Journaling off, ORRERY alive.** `"The full scan restored structure in ${fTicks} ticks and
   restored no contents. ORRERY rebuilt one inode. The other ${n} kept the bytes that were
   already there. The journal would have cost ${blocks} blocks across the leg."`
3. **Journaling on, metadata mode, contents wrong.** `"The log replayed and the volume is
   consistent. The manifest has the right size, the right owner and the previous version's
   bytes, because metadata journaling protects the structure and says nothing about contents.
   Ordered mode forces the data out before the metadata that points at it and costs ${delta}
   percent of write bandwidth."` This is the second misconception's payoff and the replay offer
   attached to it is the leg's best teaching moment.
4. **The reversed write ordering.** `"Metadata first left a directory entry pointing at blocks
   that were never written. Data first leaves a block nothing points at, which fsck files in
   lost and found. Neither is good and only one of them hands you a file that reads."`
5. **Linked allocation on the random workload.** `"Twenty random reads on the index file cost
   ${reads} block reads under linked allocation against ${indexed} under indexed. Reaching block
   n costs n plus one reads when each block holds the address of the next."`
6. **The catalogue never changed.** `"Four hundred entries, linear, at ${cost} ticks per open,
   across ${opens} opens. A hashed catalogue answers in 2."`
7. **The volume stayed full.** `"${held} blocks were held by four files with no names and an
   open descriptor each, and ${stale} more were free and not marked free. Deleting visible files
   was never going to reach either."`
8. `null`.

Counterfactuals 3 and 4 both offer WP-18's replay. The replay re-runs the crash from the
decision index with the alternative applied and draws the two manifests side by side. That is
the misconception break and it is why WP-18 is a prerequisite rather than a nicety.

### The forward hand-off

`LegOutcome` must carry two things forward.

**The corruption state**, for leg 12 and the end-of-run report. A `DecisionRecord` with
`kind: 'crash_outcome'` and `choice` set to `'recovered_from_journal'`, `'recovered_by_scan'`,
`'recovered_by_codec'` or `'unrecoverable'`. Leg 12 reads it only to know whether the manifest
it presents to the wall is the convoy's own or a corrupted one, which decides whether the
signing objective is being performed on a document that is already wrong.

**The manifest's integrity**, as a separate record with `kind: 'manifest_integrity'` and
`choice` of `'intact'` or `'stale'`. Leg 12's first misconception depends on the manifest having
been rewritten in the Archive by the injection, and the injection's success is decided at leg 7,
not here. Keep the two separate: this record says whether the Archive's crash damaged it, and
leg 12 combines that with its own inherited state.

Agree both fields with WP-17. Neither needs a contract change.

**Read, do not write.** Leg 10 records the device attach kind. Read it. If it is `'block'` on a
stream device, open the leg with `/archive/ledger`'s contents wrong: the bytes are from the
wrong offset, `fsck --check` finds nothing, and the file reads successfully and returns garbage.
That is leg 10's consequence arriving and it costs 10 blocks and no lives. If leg 10 has not
shipped, or the record is absent, open clean and report the pending item.

---

## Acceptance criteria

1. `src/legs/the_archive/index.ts` satisfies `Leg` under `tsc --strict`, `id === 'the_archive'`,
   `index === 11`.
2. The leg runs headlessly to completion via the WP-20 smoke-test runner, at all four paces
   and all four difficulty tiers, with ORRERY alive and dead, and with journaling on and off.
3. `enabledSubsystems` deep-equals `['process', 'scheduler', 'storage', 'fs']`.
4. Inert-field independence over 400 ticks for `totalFrames`, `pageSize`, `replacementPolicy`,
   `allocationStrategy`, `tlbEntries`, `raidLevel`, `deadlockStrategy` and `thrashingThreshold`.
   `diskPolicy` and `totalCylinders` are exempt and are asserted frozen at `'clook'` and 200
   instead, with a test proving no interaction and no command reads either.
5. Every objective can be met by the known-good decision sequence; all seven met in one run.
6. `FS-ALLOC-1` reproduces exactly: 64-block file, 20 random reads, contiguous 20 reads, linked
   **650**, indexed 40, extent 20.
7. `FS-ALLOC-2` and `FS-ALLOC-3` reproduce exactly, including the whole-file relocation on a
   contiguous append with the next block occupied: 64 reads and 64 writes.
8. `inode --walk 40` on a linked file prints **41**, per the sim spec's `i + 1` cost model.
9. `FS-INODE-1` reproduces exactly: maximum file size 8,657,616,896 bytes, and reads to reach
   offsets 0, 100,000 and 1,000,000 are 1, 2 and 3.
10. `FS-BITMAP-1` reproduces exactly: 6,400 blocks give 200 `Uint32` words, 800 bytes.
11. `FS-PATH-1` reproduces exactly: 5 directory reads and `execute` checked on each of five
    components.
12. The free-space accounting is exact: 6,400 capacity, 12 reported free at open, 140 held by
    four unlinked-but-open inodes, 48 under-reported by the stale bitmap, 188 recoverable in
    total. Deleting any visible file moves the free count by exactly that file's size and by no
    more.
13. The catalogue costs 34 ticks per open under `linear`, 2 under `hashed` and 5 under `tree`,
    each within one tick.
14. The crash lands at tick 900 on every run at every pace, is never drawn from an RNG, and
    interrupts `archive.manifest_writer`'s transaction between the data write and the metadata
    write.
15. All four rows of the crash outcome table reproduce, including `recoverable: false` on
    unjournaled metadata-first. Recovery costs 12 ticks from the journal and 200 ticks by full
    scan, each within 5 percent.
16. All four rows of the ORRERY dependency table reproduce, with the fourth row producing a
    `storage_corruption` casualty and an epitaph drawn from the correct filtered set.
17. `archive.orrery_restore` is offered when journaling was off, consumes a charge, and changes
    no inode.
18. All four crash bench rows reproduce, matching `FS-CORRUPT-1` through `FS-CORRUPT-4`, with
    I-29 firing on the double-allocation case at the next slow check.
19. `FS-JOURNAL-1`, `FS-JOURNAL-2` and `FS-JOURNAL-3` pass, including idempotent replay producing
    an identical final state.
20. `FS-JOURNAL-COST` reproduces 1.0 : ~1.1 : 2.0 for `off`, `metadata` and `data`. The
    `ordered` ratio is printed by the test and then pinned.
21. The journal's block charge is 31 blocks at `metadata` and 127 at `data` on this leg's
    workload, and is visible at `anchor.journal_bench` as it accumulates.
22. The mount segment produces 0 stale reads under `unix` and exactly 3 under `session`.
23. Event table weights sum to exactly 100 with ORRERY alive, and sum to exactly 100 after
    redistribution with ORRERY dead. All ids unique.
24. All five terminal command `manual` strings match the curriculum map byte for byte, and every
    `See also:` target resolves.
25. Draw calls stay under 220 / 450 / 900 at the heaviest frame, which is the journal ribbon
    replaying against the corrupted spindle with the shelving and the catalogue in view.
26. A file's allocation method is identifiable from its spindle geometry with every text label
    suppressed. Verified by a reference screenshot comparison across all four methods.
27. When journaling was off at the crash tick, the world contains no ribbon, no progress bar, no
    error panel and no caption where the ribbon would be.
28. The words "domain", "ring", "capability" and "access matrix" appear in no player-visible
    string. Permission bits appear and are never explained. Leg 12 explains them.

---

## Tests you must write

All under `tests/legs/the_archive/`.

**`contract.test.ts`**: `Leg` conformance, exact ids, chapters (three entries, thirty-one
sections), seven objectives, no `ChapterRef` citing 14.8 anywhere in the module.

**`config.test.ts`**: `enabledSubsystems` exact; `diskPolicy` and `totalCylinders` frozen and
unread; inert-field independence for the eight genuinely inert fields; the journal mode reaching
the file system through WP-10's hook rather than through `KernelConfig`.

**`populate.test.ts`**: five convoy spawns plus fourteen workload spawns, five binds, one
`declareSync` with exact id, kind and capacity, zero `declareResource` calls. The volume manifest
matches `archiveVolume` field for field and the four workload files carry their specified
methods.

**`allocation.test.ts`**: the four methods.
- `FS-ALLOC-1`, `FS-ALLOC-2` and `FS-ALLOC-3` exactly.
- `inode --walk` returns `i + 1` for linked at every `i` from 0 to 63, and 1, 2, 2 and 1 for
  contiguous, indexed on any block, indexed on block 0, and extent within one extent.
- A reformat costs one block per block moved and produces a new `Inode` rather than mutating
  `method`.
- Contiguous over a `linked_list` free map is refused.

**`freespace.test.ts`**: the reclamation movement.
- The six-row accounting table, every number.
- Deleting each visible file moves the free count by exactly its size.
- `lsof --unlinked` lists exactly four inodes holding exactly 140 blocks with `linkCount: 0`.
- Closing each descriptor returns its blocks at that tick and not before.
- Rebuilding the bitmap returns exactly 48.
- The objective fails on 48 alone, fails on 140 alone without a preceding `lsof`, and passes on
  both with the `lsof`.

**`directory.test.ts`**: `FS-PATH-1` exactly; 34, 2 and 5 ticks per open for the three
structures; the objective's 30-tick trigger crossing within the first 60 ticks under the clerks'
load; the two-locations task with copy at 64 blocks, link at 0 and move at 0, and `linkCount`
going to 2 on the link and back to 1 on the unlink with the file still readable.

**`journal.test.ts`**: `FS-JOURNAL-1`, `FS-JOURNAL-2`, `FS-JOURNAL-3` and `FS-JOURNAL-COST`
exactly. The `ordered` ratio printed and pinned. The block charge at 31 and 127. The three
pre-boot journal entries replaying idempotently and changing nothing.

**`crash.test.ts`**: the scripted crash.
- Lands at tick 900 at every pace, deterministic across two runs and a snapshot-restore.
- All four rows of the crash outcome table.
- Recovery at 12 ticks from the journal and 200 by full scan.
- `write_back` losing dirty entries and `write_through` losing none, with the setting read from
  the run rather than overridden.
- `fs.recovered { fromJournal: true }` present on the journal paths and absent on the scan
  paths.

**`crashbench.test.ts`**: `FS-CORRUPT-1` through `FS-CORRUPT-4` through the bench, with the
correct `recoverable` value on each and I-29 firing on the fourth.

**`orrery.test.ts`**: the four-state table.
- All four rows, asserted on the manifest contents, the casualty list and the epitaph id.
- `restore` consuming a charge and changing nothing when the journal is absent.
- The epitaph filter selecting `ep.corrupt.no_codec` in row three and
  `ep.corrupt.never_the_commit` in row four.
- The two event predicates suppressing `archive.journal_commit` and
  `archive.unjournaled_write` when she is dead, with the weights redistributing to 100.
- No second warning about her death anywhere in this leg's copy.

**`mount.test.ts`**: 0 stale reads under `unix`, exactly 3 under `session`, and the immutable
case producing 0 stale reads and a write that does not land where the reader looks.

**`evaluate.test.ts`**: each of the seven objectives, met and not met. In particular
`journal_before_crash` fails when journaling is enabled at tick 901, and
`allocation_method_choice` fails when the methods are right and the measured read count is not.

**`golden.test.ts`**: the golden headless playthrough.
- Fixture: `seed: 0x4b54524c`, `discClass: 'shell'`, `difficulty: 'operator'`, steady pace,
  standard rations, five Programs alive including ORRERY, entering with the leg 10 golden
  closing ledger and a `'character'` device attach record.
- Known-good sequence: set the catalogue to hashed once linear crosses 30 ticks; run
  `inode --walk 40` on the linked file and decline linked for the random workload; set
  `/archive/index` to indexed and `/archive/stream` to contiguous; run `lsof --unlinked`, close
  all four descriptors, rebuild the bitmap; enable journaling in `ordered` mode before tick 900;
  set the write ordering to data first; mount `/shared` with `unix` semantics.
- Assert: all seven objectives met, zero casualties, nine codex entries added, 188 blocks
  reclaimed, the crash recovering from the journal in 12 ticks with the manifest intact,
  canonical event log hash matching the golden file, stable across two runs and a
  snapshot-restore.

**`badpath.test.ts`**: the known-bad sequence, with ORRERY dead at entry.
- Leave the catalogue linear; assign linked to the random workload; delete three visible files
  and never run `lsof`; leave journaling off; set the write ordering to metadata first; mount
  `/shared` with `session` semantics.
- Assert: 650 reads across the random workload, the free count barely moving, the crash producing
  `fs.corruption { recoverable: false }`, `fsck` reporting success on a manifest full of stale
  bytes, one `storage_corruption` casualty, the `ep.corrupt.never_the_commit` epitaph, zero
  objectives met, and the counterfactual selected being case 1 with the leg and tick of ORRERY's
  death in it.

**`manuals.test.ts`**: five manual strings against the curriculum map fixture; every `See also:`
resolves, including the backward reference to `devstat` and the base-shell reference to `sync`.

**`stage.test.ts`**: anchors resolve; interaction anchors resolve; draw calls under budget at
each tier; the four spindle geometries distinguishable with labels suppressed; no ribbon, panel
or caption present on the unjournaled crash path.

---

## Out of scope

- Do not touch any other leg. Do not import from `src/legs/*` other than your own directory.
- Do not modify `src/game/types.ts` or `src/kernel/types.ts`.
- Do not modify anything under `src/kernel`, `src/render`, `src/world`, `src/terminal`,
  `src/ui`, `src/audio`, `src/design`, `src/platform` or `src/app`. If an allocation cost, a
  journal phase, a recovery step or a corruption case is wrong, file it against WP-10 and stop.
- **Do not enable `security`.** Permission bits exist on inodes and are never explained. No
  domains, no rings, no roles, no capabilities, no access matrix, and none of those words in any
  player-visible string. Leg 12 introduces every one of them.
- **Do not enable `io`.** Transfer modes, interrupt lines and DMA are leg 10's. The block device
  is read and written and its mode is never touched.
- Do not add a journal mode field to `KernelConfig` and do not encode the mode into
  `journalingEnabled`.
- Do not add `declareInode` or `declareVolume` to `LegSetupContext`.
- Do not mutate `Inode.method`. A method change is a reformat and it costs blocks.
- Do not draw the crash position from the RNG. Tick 900, every run, every pace.
- Do not override the block cache write policy. Read it and name it.
- Do not disable `archive.orrery_restore` when the journal is missing.
- Do not repeat SABLE's line about the cost of ORRERY's death. It was said once, at her death,
  by WP-17.
- Do not add a warning before the crash, and do not add a second warning at the crash bench.
- Do not clear `bit_rot` silently and do not make it fatal on this leg's timescale.
- Do not substitute a progress bar, an error panel or a caption for the absent journal ribbon.
- Do not run `IO-SPOOL-1`. Spooling is leg 10's flavour and has no file system behind it.
- Do not cite chapter 14.8 anywhere.

### Files this package owns exclusively

```
src/legs/the_archive/index.ts
src/legs/the_archive/chapters.ts
src/legs/the_archive/objectives.ts
src/legs/the_archive/config.ts
src/legs/the_archive/populate.ts
src/legs/the_archive/volume.ts
src/legs/the_archive/interactions.ts
src/legs/the_archive/commands.ts
src/legs/the_archive/events.ts
src/legs/the_archive/evaluate.ts
src/legs/the_archive/allocation.ts
src/legs/the_archive/freespace.ts
src/legs/the_archive/crash.ts
src/legs/the_archive/recovery.ts
src/legs/the_archive/fixtures.ts
src/legs/the_archive/stage.ts
src/legs/the_archive/copy.ts
tests/legs/the_archive/**
```

No other package writes to these paths and this package writes to no others.

---

## Report back

1. The commit or branch, and the full `tests/legs/the_archive/` output.
2. The golden playthrough hash and the file it is checked in at.
3. The frozen fixtures, as a table: the four-method cost matrix on the 64-block file; the six
   free-space numbers; the three catalogue costs; the crash outcome by journaling and ordering;
   recovery cost from journal and by scan; the journal block charge in all three modes; the
   stale-read counts under all three semantics.
4. Every `FS-*` fixture result against its expected value.
5. **The volume manifest channel as agreed with WP-10 and WP-19**, and the journal mode hook.
   If you fell back to syscalls from a setup process, say so and say why the manifest channel
   was refused.
6. The measured `ordered` write-cost ratio, printed and pinned, with the value you froze.
7. The four-state ORRERY table as measured, with the epitaph id drawn in each of the two fatal
   states, and confirmation that no second warning about her death ships in this leg.
8. The two `onlyIf` predicates added to the bible's event table, the redistributed weights, and
   confirmation that both tables sum to 100.
9. The fields carrying `crash_outcome` and `manifest_integrity` to leg 12, agreed with WP-17.
10. Whether leg 10's `device_attach` record was present, what you did when it was `'block'`, and
    the pending item if leg 10 had not shipped.
11. The `inode --walk 40` discrepancy: the objective's text says 40 reads, the sim spec's model
    says 41, and you shipped 41. Confirm, and confirm the objective is assessed on the invocation
    and the subsequent choice rather than on the printed number.
12. The chapter 14.8 citation defect in the sim spec's §12.5 heading, and confirmation that every
    `ChapterRef` this leg ships uses 14.7.1 and 14.7.2.
13. Any other place where the curriculum map, the narrative bible, the visual bible and the sim
    spec disagreed, what you did, and which document you followed.
14. Draw calls at each of the three quality tiers at the heaviest frame, the spindle-geometry
    comparison result, and confirmation that the unjournaled path shows an empty floor.
15. Confirmation that no file outside the owned list was created or modified, that `security` and
    `io` are off, and that the words "domain", "ring", "capability" and "access matrix" appear in
    no player-visible string in this leg.

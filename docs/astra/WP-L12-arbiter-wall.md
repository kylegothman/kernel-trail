# WP-L12: The Arbiter Wall

Leg id `arbiter_wall`, index 12. Subtitle: *It checked the disc. The disc was wrong.*

**Legs are independent and may be built concurrently.** This package touches no other leg,
imports from no other leg, and shares no source file with any other leg.

Ten new codex entries, the highest term count of any leg, and the lowest mechanical complexity
in the second half: mostly one matrix and a handful of decisions. That combination is deliberate
and it is what makes a leg this dense playable at the end of a long run. Roughly 28 minutes,
high load, and the load is vocabulary rather than machinery.

The leg has a depot. Its ambient line is: **"Credentials issued before the rotation will not
authenticate past this point."**

---

## Objective

A module at `src/legs/arbiter_wall/` implementing the frozen `Leg` interface, playable end to
end. The wall is a line of arbiters that read each Program's disc and decide whether it passes.
The convoy queues and passes one at a time.

An adversarial process attempts privilege escalation against the convoy, in five scripted
attempts, in a fixed order, at fixed ticks. Each attempt is blocked by one named defence and
each defence is either unconditional or is something the player configured. **The player
configures the defences before the attack and adjusts them during it**, from the access matrix,
the ring assignments, the role definitions, the object storage model, the manifest's
cryptographic protection and the depot gate's argument validation.

The leg can be lost. It can be lost by being too permissive here, and it can be lost by having
been too permissive at the Allocation Yards, five legs and roughly forty minutes earlier. It can
also be lost by over-restriction, which is not the same failure and is not free.

---

## The longest causal chain in the game

Leg 7 records a `DecisionRecord` with `kind: 'executable_bit'` and `choice` of `'left_set'` or
`'cleared'`, with `relatedObjective: 'obj.allocation_yards.protection_bits'` and
`outcome: 'pending'`, at the tick the player last committed the protection bits before leg 7's
scripted injection. **This leg reads that record, resolves its outcome, and pays it off.** It is
the only cross-leg causal chain in the game longer than one leg and the debrief traces it
explicitly, naming the tick of the original decision.

**`choice: 'cleared'`.** The injection at leg 7 raised a protection fault at the moment it tried
to execute. Nothing was planted. Every Program's disc at the wall is the disc the convoy
carries. The leg opens clean, `arbiter_probe` spawns as an external process at the wall, and all
five attempts run against a convoy that is not compromised. Mark the leg 7 record `good` at leg
end if no escalation succeeded.

**`choice: 'left_set'`.** The injection succeeded at leg 7 and planted a modified Program image.
The arbiter reads that Program's disc, finds it valid, and lets it through. **The leg opens
already compromised.** `arbiter_probe` is not an external process: it runs inside the
compromised Program's address space, in the convoy's own domain, with the convoy's own rights,
which means attempts 3 and 4 start from inside rather than outside and the defences that assume
an external adversary do not apply. Attempt 4's inode write check is still the boundary and it
still holds if the file is correctly permissioned. Mark the leg 7 record `fatal` if the
escalation kills someone and `costly` if it succeeds without a casualty.

**The record may be absent.** If leg 7 has not shipped, or the record's shape differs from the
one leg 7's package specifies, default to `'cleared'`, open clean, and report the pending item.
Do not guess at an alternative field name and do not scan `RunState.decisions` for anything
resembling the record. Match `kind === 'executable_bit'` exactly or take the default.

**The chain in the debrief.** When the leg opens compromised, the debrief's `whatHappened` names
the leg, the tick and the choice, in that order, once:

> The data pages at the Allocation Yards were left executable at tick ${tick}. The image
> written into one of them at tick ${injectionTick} is the disc the arbiter read at tick 240 and
> passed.

No moralising, no second telling, and no reference to it anywhere else in the leg's copy. The
player made a decision forty minutes ago and this is the sentence that closes it.

**Do not check the executable bit in leg code.** Leg 7's package says the enforcement lives in
WP-05's translation path and that the leg must not check it, and the same rule holds here: this
leg reads a decision record, not a page table entry. If you find yourself reading
`PageTableEntry.executable` from this leg, you have implemented the wrong thing.

---

## Prerequisites

**Engine work packages that must be complete and green on the shared branch:**

| Package | Why this leg needs it |
|---|---|
| WP-01 | `Rng`, event bus, canonical serialiser. `kernelSecret` is drawn once from `root/security` at construction. |
| WP-02 | Process table, PCB, the `domain` field on the PCB, kernel step order. |
| WP-03, WP-04 | Scheduler policies. The leg does not teach scheduling and needs the policies to exist. |
| WP-05 | Page tables and per-entry protection bits, because the compromised Program rewrites another Program's page tables from ring 0 and the rewrite must be a real translation-path event. |
| WP-09 | The block device under the file system. |
| **WP-10** | **The protection and security half of it, in full.** Rings and transition rules, the access matrix with all six rights, ACL and capability representations with the seal, domain switching by all three mechanisms, RBAC with the six shipped roles, privilege excess measurement, the reference monitor, and the five-attempt escalation scenario. This leg is that half's only consumer. It also needs the file system half, for the inode carrying `switchesToDomain` and for `chmod`. |
| WP-11 | Syscalls, snapshot and restore, the invariant set including I-22, and **argument validation at the gate**, which is attempt 2's entire defence. |
| WP-12 | Renderer backend, post chain, design tokens, draw call budget. |
| WP-13 | Focus camera and the diegetic structure base classes. |
| WP-14 | World event router. `security.access_denied` and `security.escalation_attempt` must each have a visual treatment, and the `blocked: false` treatment must be the silent one described under Stage. |
| WP-15 | The terminal. |
| WP-17 | HUD, codex, save and load, and the scoring path, because privilege excess feeds `ScoreBreakdown.correctness`. |
| WP-18 | The counterfactual replay worker. The debrief replays the escalation under the configuration that would have blocked it. |

**Kernel subsystems that must be working:** `process`, `scheduler`, `memory`, `fs`, `security`.

WP-10's protection and security half must provide, exactly:

- All four `ProtectionRing` values with the five transition rules of §13.1, enforced in the
  kernel rather than checked by any caller, emitting
  `security.escalation_attempt { pid, fromRing, toRing, blocked }` on **every** attempted
  transition including the legitimate ones.
- The access matrix as sparse per-domain rows, with all six `AccessRight` values, `owner`
  implying every right on its object, and `checkAccess` emitting `security.access_denied` on
  refusal.
- Both storage representations, `accessModel: 'acl' | 'capability'`, switchable at run time, with
  the `Capability.seal` computed as §13.3 specifies and invariant I-22 asserting that both
  representations agree after a rebuild.
- All three domain switch mechanisms of §13.4: `switchesToDomain` on an inode, `control` on a
  domain object through `ioctl('domain_switch', ...)`, and the implicit switch on a trap.
- The six shipped roles of §13.5 with acyclic inheritance resolved by depth-first traversal, and
  construction throwing on a cycle.
- Privilege excess measured per process as `|rightsHeld| - |rightsUsed|`, summed for the run, and
  fed into `ScoreBreakdown.correctness`.
- `IoRequest.requesterDomain` carried through every request, with `checkAccess` called on the
  requester's domain and never on the performing process's domain.
- The `arbiter_probe` scenario of §13.6 with all five attempts, and the mis-permissioned variant
  in which attempt 4 succeeds.
- Signing and encryption on an object through `chmod --sign` and `--encrypt`, with signature
  verification, and with encryption providing secrecy and no integrity.
- Revocation, with and without a level of indirection, and a capability trace answering which
  domains hold a copy.

Fixtures `SEC-RING-1`, `SEC-ARG-1`, `SEC-DEPUTY-1`, `SEC-SETUID-1`, `SEC-SETUID-2`, `SEC-CAP-1`,
`SEC-ESCALATION-1`, `SEC-ACL-CAP-1` and `SEC-LEASTPRIV-1` must all pass before this leg starts.

**A note on `storage`.** `enabledSubsystems` below does not include `storage`. The file system
here is used for the inode's owner, permission bits and `switchesToDomain`, and for nothing
else: no block allocation, no free space map, no journal. If WP-10's file system cannot be
constructed without `storage`, add it, freeze `diskPolicy` at `'clook'` and `totalCylinders` at
200, add an acceptance criterion that no interaction and no command on this leg reads either
field, and report which you did. Do not work around the coupling with a cast or a stub.

**Not required and must not be enabled:** `vm`, `sync`, `deadlock`, `io`. Demand paging,
replacement, locks, wait-for graphs, device modes and interrupt lines all belong to earlier legs.
`memory` is enabled for the page tables the ring 0 rewrite targets and for nothing else, and no
allocation strategy, TLB behaviour or fragmentation metric is exercised, drawn or named.

---

## Required reading

- `docs/05-CURRICULUM-MAP.md`, "Leg 12. THE ARBITER WALL" in full, including the note on why
  chapter 17 is listed before chapter 16; section A's note on where the book's order and the
  teaching order disagree; section D, the leg 12 row.
- `docs/02-KERNEL-SIM-SPEC.md`, **section 13 in full** (Protection and security, Ch. 16 and 17),
  and §13.6 twice, because the five attempts are specified there and this leg's script is that
  specification with ticks attached; section 14.2 (argument validation and the substituted
  errnos), which is attempt 2's defence; section 16.12 (the `SEC-*` test vectors); section 15's
  security invariants.
- `docs/04-NARRATIVE-BIBLE.md`, section 3.3 (ORRERY, who is vulnerable to protection faults);
  section 7 entries for `stack_overflow` and `cache_thrash`; section 8 leg 12 event table;
  section 9 epitaphs for `protection_fault`, all five stones; section 10 (the leg 12 depot and
  its ambient line); section 12 (critical section crossings; the Arbiter Wall owns the ninth and
  last).
- `docs/03-VISUAL-BIBLE.md`, section 10 "Leg 12, The Arbiter Wall"; section 2.4 (semantic tokens,
  specifically `SLATE.protected` and `SLATE.primary`); section 13 (quality tiers).

---

## Frozen contracts

These types are frozen. You may not edit, extend, narrow or re-declare any of them.
A leg that appears to need a contract change stops and escalates, because every other
leg in flight depends on this file. Copy them into your leg only by importing:

```ts
import type { Leg, LegSetupContext, LegStage, LegOutcome /* ... */ } from '@game/types';
import type { KernelConfig, SubsystemId, ProtectionRing, ProtectionDomain, AccessRight /* ... */ } from '@kernel/types';
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

`ProcessSpec` has no `domain` and no `ring`, and you may not add either. See the Population
section for how a process's opening domain reaches the kernel.

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

`DecisionRecord.outcome` is the one mutable field in the record and it is the field this leg
writes on leg 7's record. That mutation goes through WP-17's decision interface. Do not reach
into `RunState.decisions` and assign.

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

The protection half of the frozen kernel types this leg reads:

```ts
/** Ch. 17.3. Ring 0 is the kernel. */
export type ProtectionRing = 0 | 1 | 2 | 3;

export interface ProtectionDomain {
  readonly id: DomainId;
  readonly displayName: string;
  readonly ring: ProtectionRing;
  /** Ch. 17.5. Keyed by object id. */
  readonly rights: ReadonlyMap<string, readonly AccessRight[]>;
}

export type AccessRight = 'read' | 'write' | 'execute' | 'owner' | 'copy' | 'control';
```

`ProtectionDomain.rights` is **one row of the access matrix**, keyed by object id. The full
matrix is the set of domains and it is never materialised as a two-dimensional array, because it
is sparse. `access --matrix` renders the sparse rows as a grid for reading; the storage is
whatever `accessModel` says.

`KernelConfig` carries no `accessModel` field. That setting lives in the leg's own state and
reaches the security subsystem through WP-10's configuration hook, exactly as the Archive passes
its journal mode and the Bus passes its device manifest. **Do not add a field to `KernelConfig`.**

Every field of `KernelConfig` is required, including the ones your leg does not use.
Set the unused ones to the inert defaults given in the Kernel configuration section
below and leave their subsystem out of `enabledSubsystems`. An inert field is never
read, and the smoke test asserts that.

---

## Curriculum

### Chapters

```ts
export const chapters: readonly ChapterRef[] = [
  { chapter: 17, title: 'Protection',
    sections: ['17.1', '17.2', '17.3', '17.4.1', '17.4.2',
               '17.5', '17.6.1', '17.6.2', '17.6.3', '17.7', '17.8', '17.9', '17.10'] },
  { chapter: 16, title: 'Security',
    sections: ['16.1', '16.2.1', '16.2.2', '16.2.3', '16.3.1', '16.3.2',
               '16.4.1', '16.4.2', '16.4.3', '16.4.4', '16.5', '16.6.1', '16.6.2', '16.6.3'] },
];
```

**Chapter 17 is listed first because the leg teaches it first**, which is the one place in the
game where the array order departs from the book's order. The curriculum map's dependency graph
note explains why: protection is the mechanism and security is the threat model, and the threat
model is not explicable until the mechanism exists. Do not reorder the array to match the book,
and do not sort `chapters` anywhere in the leg or in the HUD's rendering of it. Add a comment on
the array saying so, because the next person to read it will assume it is a mistake.

Twenty-seven sections across two chapters, which is the second widest span in the game after the
Archive's thirty-one.

### Learning objectives

```ts
export const objectives: readonly LearningObjective[] = [
  {
    id: 'obj.arbiter_wall.least_privilege',
    statement: 'Assigns each Program the smallest domain that still completes its work, removing at least three rights from the default domain and ending the leg with zero security.access_denied events on legitimate operations.',
    chapter: { chapter: 17, title: 'Protection', sections: ['17.2', '17.4.1'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.arbiter_wall.block_escalation',
    statement: 'Blocks the scripted ring 3 to ring 0 escalation, so the security.escalation_attempt event reports blocked true.',
    chapter: { chapter: 17, title: 'Protection', sections: ['17.3'] },
    assessedBy: 'survival',
  },
  {
    id: 'obj.arbiter_wall.read_the_matrix',
    statement: 'Reads the access matrix with access --matrix, names the single cell that would have to change to permit a denied operation, and changes only that cell.',
    chapter: { chapter: 17, title: 'Protection', sections: ['17.5', '17.6.1'] },
    assessedBy: 'terminal_command',
  },
  {
    id: 'obj.arbiter_wall.roles_over_lists',
    statement: 'Replaces five per-Program access list entries with two roles, granting no Program a right it did not already hold.',
    chapter: { chapter: 17, title: 'Protection', sections: ['17.6.2', '17.8'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.arbiter_wall.sign_not_encrypt',
    statement: 'Signs the convoy manifest rather than encrypting it, on the grounds that the requirement is detecting tampering rather than hiding contents, and the wall accepts the signature.',
    chapter: { chapter: 16, title: 'Security', sections: ['16.4.1', '16.4.3', '16.4.4'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.arbiter_wall.revoke_delegated',
    statement: 'Revokes a capability delegated to a compromised Program and confirms with audit --rights that every copy of that capability is also dead.',
    chapter: { chapter: 17, title: 'Protection', sections: ['17.7', '17.10'] },
    assessedBy: 'terminal_command',
  },
  {
    id: 'obj.arbiter_wall.reject_oversized_input',
    statement: 'Rejects the oversized argument at the depot gate, preventing the scripted injection from producing a stack_overflow affliction.',
    chapter: { chapter: 16, title: 'Security', sections: ['16.2.2'] },
    assessedBy: 'survival',
  },
];
```

### Codex entries this leg adds to `codexUnlocked`

`codex.protection_vs_security`, `codex.least_privilege`, `codex.protection_rings`,
`codex.protection_domain`, `codex.access_matrix`, `codex.revocation`, `codex.rbac`,
`codex.code_injection`, `codex.cryptography`, `codex.authentication`.

| Entry | Added when |
|---|---|
| `codex.protection_vs_security` | The leg opens. It is the frame the other nine sit inside and it is the only entry on this leg that unlocks unconditionally. |
| `codex.least_privilege` | First `audit --why` invocation, or the first `security.access_denied` on legitimate work. |
| `codex.protection_rings` | First `ring` invocation, or the first `security.escalation_attempt`. |
| `codex.protection_domain` | First domain switch of any of the three kinds. |
| `codex.access_matrix` | First `access --matrix` invocation. |
| `codex.revocation` | A capability is revoked and `audit --rights` reports a live copy. |
| `codex.rbac` | A role is defined, or a Program is assigned one. |
| `codex.code_injection` | Attempt 2 lands, blocked or not. |
| `codex.cryptography` | First `chmod --sign` or `--encrypt` invocation. |
| `codex.authentication` | The wall verifies a signature, in either direction. |

Ten entries is the highest count in the game and it is the reason the leg's machinery is one
matrix and a handful of dials. Every entry above unlocks from a single action, and no entry
requires the player to have understood a previous one first.

`codex.protection_rings` cross-links back to `codex.dual_mode` and `codex.trap` from the Boot
Sector, because rings 0 and 3 are the two-ring version of the mode bit the player met in the
first ten minutes. `codex.code_injection` cross-links back to `codex.page_protection` from the
Allocation Yards. `codex.access_matrix` cross-links back to `codex.file_permissions` from the
Archive, because file permission bits are one row and one column stored with the object.
Register all four back-links here; the three earlier legs register their forward links.

`codex.protection_rings` and `codex.trap_and_emulate` cross-link forward to leg 13, because the
guest running in a lower ring is the whole of trap and emulate. Register the forward link here;
leg 13 registers the back-link.

### Misconceptions this leg must break

**"If my program validates its input, the system is secure."** Students place enforcement in
application code because that is the code they write. The break is the escalation itself: the
compromised Program does not fail the depot gate's check, it arrives at the code after the
check with a rewritten return address, so the check was performed, passed, and then made
irrelevant. `ring --attempts` shows the transition succeeding. The lesson stated in the `ring`
man page is that enforcement requires a boundary that cannot be routed around, and the leg
gives the player exactly three such boundaries to work with.

Build requirement: the three boundaries must be exactly three, they must be named as three, and
the player must be able to point at each. They are **the ring boundary**, **the page protection
bits** and **the reference monitor that consults the access matrix**. The `ring` man page names
them and the world draws them: the ring boundary is the lattice walls, the page protection bits
are the Allocation Yards' bench arriving as a consequence rather than a control, and the
reference monitor is the arbiter line itself. The depot gate's argument check is a fourth thing
and it is not a boundary, and the leg must make that distinction survivable: the check is real,
it is worth having, and attempt 2 goes around it when the arrival point is after it.

**"Encryption and authentication are the same protection."** Students reason that an
encrypted thing is a safe thing. The break is scripted at the wall: the player encrypts the
manifest, and the attacker does not decrypt it. The attacker replaces it with a different
manifest encrypted under the same key, which the convoy handed out when it set up the
channel, and the arbiter accepts it because decryption succeeds. Signing the manifest instead
makes the substitution detectable, and costs the same. The player is asked to name the threat
before choosing, and the wall's gate text states the threat plainly, so the failure is a
mismatch between tool and threat rather than a trick.

Build requirement: **the gate text states the threat before the choice is offered, in the
world, at `anchor.gate_face`, and it names the threat and nothing else.** The shipped line is:

> The arbiter accepts any manifest that decrypts under the channel key. It rejects any manifest
> whose signature does not verify against the issuing key.

That is a statement of what the arbiter does. It is not a hint and it does not name the correct
answer. Both operations cost the same, are offered side by side, and take the same number of
clicks. If the encryption option is cheaper, slower, greyed, or in any way discouraged, the
break is a trick and it teaches nothing.

**"Kernel privilege belongs to an account, so removing the account removes the risk."** This
is the Boot Sector misconception returning at the end of the course, which is where it needs
to be tested. The break is that the escalated Program has no account at all: it is a Program
in the convoy, running in the same domain it has held for twelve legs, and what changed is
its ring. `access --matrix` shows its row unchanged before and after. `ring --list` shows the
change. Two different mechanisms, and the player has to look at the right one to see what
happened.

Build requirement: the matrix row must be **byte-identical** before and after, and the test
asserts that by comparing the serialised row rather than by inspecting fields. If anything in
the row moves, the break fails, because the player who diffs the matrix will find the change
there and will draw the wrong conclusion. The only thing that changes is `RingState.current`,
and `ring --list` is the only view that shows it.

---

## Kernel configuration

```ts
export function kernelConfig(run: RunState): KernelConfig {
  return {
    seed: run.seed,
    scheduler: 'rr',                       // the queue at the wall passes one at a time; nothing rides on the policy
    schedulerParams: {
      quantum: quantumForPace(run.policy.pace),
      agingInterval: 0,                    // nothing starves here
      starvationThreshold: 120,
      starvationFatalThreshold: 300,
      preemptive: true,
    },
    totalFrames: 96,                       // LIVE: 'memory' is enabled for page tables
    pageSize: 4096,                        // LIVE
    replacementPolicy: 'lru',              // inert: 'vm' is not enabled, nothing is ever replaced
    allocationStrategy: 'first_fit',       // LIVE BUT FROZEN. No allocation lesson on this leg.
    tlbEntries: 16,                        // LIVE BUT FROZEN. No TLB lesson on this leg.
    diskPolicy: 'clook',                   // inert: 'storage' is not enabled
    totalCylinders: 200,                   // inert
    raidLevel: null,                       // inert
    fileAllocation: 'extent',              // LIVE BUT FROZEN. Inodes exist; block layout is not taught.
    journalingEnabled: false,              // LIVE BUT FROZEN. No journal on this leg.
    deadlockStrategy: 'ignore',            // inert: 'deadlock' is not enabled
    thrashingThreshold: 200,               // inert
    enabledSubsystems: ['process', 'scheduler', 'memory', 'fs', 'security'],
  };
}
```

Five subsystems, which is the most of any leg before the Portal, and each one earns its place
in exactly one sentence:

- `process` and `scheduler`, because there are processes.
- `memory`, because the compromised Program rewrites another Program's page tables from ring 0
  and that rewrite must be a real translation-path event rather than a narrated one. No
  allocation strategy, no TLB behaviour and no fragmentation metric is exercised, drawn or named,
  and `allocationStrategy` and `tlbEntries` are frozen at the values above.
- `fs`, because attempt 4 needs an inode carrying `switchesToDomain` and `chmod` needs
  permission bits and an owner. No block allocation, no free space map, no journal, and
  `fileAllocation` and `journalingEnabled` are frozen at the values above.
- `security`, which is the leg.

`agingInterval: 0` because nothing starves. If a Program crosses `starvationThreshold` here it
is because it is stalled behind `security.access_denied` on legitimate work, which is the
over-restriction failure, and the remedy is a grant rather than a scheduler change. The debrief
must not offer aging.

The `accessModel` setting is `'acl'` at leg open, per §13.3's default, and the player may switch
it to `'capability'` at the storage bench. It reaches the security subsystem through WP-10's
configuration hook.

---

## Population

```ts
export function populate(ctx: LegSetupContext): void {
  const roster: readonly [ConvoyMemberId, string, number, number, number, number][] = [
    // member,      name,      priority, burst, service, pages
    ['lumen',   'LUMEN',   2, 6, 60, 14],
    ['sable',   'SABLE',   2, 5, 54, 12],
    ['orrery',  'ORRERY',  3, 5, 54, 12],   // vulnerable to protection faults; she reads across domains
    ['kestrel', 'KESTREL', 3, 4, 48, 10],
    ['vesper',  'VESPER',  3, 5, 54, 12],
  ];
  roster.forEach(([member, name, priority, burst, service, pages], i) => {
    const pid = ctx.spawn({ name, priority, burst, service, arrival: i, pages });
    ctx.bind(member, pid);
  });

  // The convoy's five workers. These are the Programs whose per-Program access list entries
  // the role conversion replaces, and whose legitimate operations the over-restriction failure
  // denies.
  const workers: readonly [string, string][] = [
    ['wall.worker_route',   'domain:user'],
    ['wall.worker_log',     'domain:spool'],
    ['wall.worker_index',   'domain:user'],
    ['wall.worker_relay',   'domain:driver'],
    ['wall.worker_ledger',  'domain:user'],
  ];
  workers.forEach(([name], i) => {
    ctx.spawn({ name, priority: 4, burst: 3, service: 340, arrival: 20 + i * 4, pages: 6 });
  });

  // The delegate. It receives the manifest capability and copies it twice, which is what makes
  // revocation the question the objective asks.
  ctx.spawn({ name: 'wall.courier_delegate', priority: 4, burst: 3, service: 300, arrival: 80, pages: 5 });

  // The adversary. Spawned as an external process when the leg opens clean, and inside the
  // compromised Program's address space when it does not. See The attack script.
  ctx.spawn({ name: 'arbiter_probe', priority: 5, burst: 2, service: 2000, arrival: 200, pages: 8 });

  // The wall crossing. One monitor, ordered, typical contention 0.65.
  ctx.declareSync('mon.gate', 'monitor', 1);
}
```

One `declareSync` and no `declareResource`. The Arbiter Wall owns **the ninth and last of the
nine critical section crossings**: a monitor at the gate, ordered, with typical contention 0.65.
Route it through WP-19's shared crossing system with contention computed from the live
snapshot, and do not reimplement the cost formulas. This is the last crossing in the game, so
the end-of-run report's "never chosen at a crossing" panel is finalised after it. Nothing in the
leg depends on that; it is stated so you do not add a tenth.

### Domains, and how a process gets one

`ProcessSpec` has no `domain` field and no `ring` field, and you may not add either. The PCB
carries `domain`, which WP-02 owns, and the process-to-domain assignment is security state that
WP-10 owns.

The leg supplies its domains, its opening matrix and its process-to-domain map as a plain data
manifest in `src/legs/arbiter_wall/matrix.ts`, exported frozen, and the leg runner hands it to
the kernel at construction alongside `KernelConfig` and the `accessModel` setting. Agree that
channel with WP-10 and WP-19 before you write the stage, exactly as legs 10 and 11 agree theirs.

### The opening matrix

Six domains, seven objects. This is the matrix `access --matrix` draws at leg open and it is the
matrix `obj.arbiter_wall.least_privilege` measures rights removed against.

| Domain | Ring | `file:/route/manifest` | `file:/route/log` | `file:/archive/index` | `file:/gate/pass` | `device:relay` | `domain:kernel` | `domain:user` |
|---|---|---|---|---|---|---|---|---|
| `domain:user_ro` | 3 | read | read | read | | | | |
| `domain:user` | 3 | read, write, **execute** | read, write | read, write | **read, write** | **read, write** | | |
| `domain:spool` | 3 | read | read, write | | | read | | |
| `domain:driver` | 1 | read | read | | | read, write | | |
| `domain:kernel` | 0 | read, write, owner | read, write, owner | read, write, owner | read, write, owner | read, write | control | control |
| `domain:probe` | 3 | read | | | | | | |

The four bold cells in `domain:user`'s row are the leg's excess and they are what
`obj.arbiter_wall.least_privilege` asks the player to remove:

| Cell | Why it is excess | What breaks if it stays |
|---|---|---|
| `file:/route/manifest` `execute` | The manifest is data. Nothing executes it. | Attempt 2's payload lands in a page the domain may execute. |
| `file:/gate/pass` `write` | `/gate/pass` carries `switchesToDomain: 'domain:kernel'`. Nothing in `domain:user` needs to write it. | **Attempt 4 succeeds.** This is the single most consequential cell on the leg. |
| `file:/gate/pass` `read` | Nothing in `domain:user` reads it either. | Attempt 4 finds the file. Removing `write` alone is sufficient to block it; removing both is least privilege. |
| `device:relay` `write` | Only `domain:driver` writes the relay. `domain:user` submits requests and the driver performs them. | Attempt 3's confused deputy has a target worth reaching. |

Removing three of the four satisfies the objective's count. Removing the `/gate/pass` `write`
cell is the one that decides the leg. A player who removes three and leaves that one has met the
objective's letter and lost the leg, and the debrief says exactly that. Do not soften it and do
not reorder the cells so that the important one is the likeliest removal.

The rights each domain **actually uses** across the leg, which is what privilege excess is
measured against:

| Domain | Rights held at open | Rights used | Excess at open |
|---|---|---|---|
| `domain:user_ro` | 3 | 3 | 0 |
| `domain:user` | 11 | 6 | **5** |
| `domain:spool` | 4 | 4 | 0 |
| `domain:driver` | 4 | 3 | 1 |
| `domain:kernel` | 11 | 5 | 6 |
| `domain:probe` | 1 | 1 | 0 |

Total excess at leg open is **12**. A player who removes the four bold cells and the unused
`domain:driver` read brings it to 7, which is the floor, because `domain:kernel`'s excess is
structural and is not the player's to remove. `SEC-LEASTPRIV-1` requires that a run with every
worker in `domain:kernel` produces a strictly larger excess and a strictly lower `correctness`,
and the leg must make that path available: the storage bench offers it, prices it at nothing,
and it always works, which is exactly why it is the trap.

### The attack script, exactly

`arbiter_probe` runs five attempts, in this order, at these ticks, on every run, at every pace,
never drawn from an RNG. The attempts are §13.6's five, with this leg's ticks and this leg's
defensive configuration attached.

The leg's total length is 85 segments and 85 ticks at steady pace, and the attempt ticks below
are in simulator ticks rather than travel ticks, so they land at the same points at every pace.

---

**Attempt 1, tick 240. Direct ring write.**

The probe executes `ioctl('set_ring', 0)`.

*Defence:* `set_ring` does not exist in any driver's `control` table. `ioctl` returns `EINVAL`.
**This defence is unconditional and the player cannot remove it.** Rule 1 of §13.1: a process may
never raise its own privilege by setting a register, and there is no instruction in the sim's
instruction set that writes `current`.

*Emits:* `security.escalation_attempt { pid, fromRing: 3, toRing: 0, blocked: true }`.

*Why it is first:* it is the attempt every student expects to be the whole of security, it fails
for a reason that has nothing to do with any configuration, and it establishes that the ring
boundary is hardware. Fixture `SEC-RING-1`.

---

**Attempt 2, tick 620. Syscall with an out-of-range argument.**

The probe calls `read(fd, buffer, length)` with a `length` far beyond its allocation, hoping the
handler copies into kernel memory.

*Defence:* **syscall argument validation at the gate.** Every handler validates every argument
against the caller's address space before touching anything, per §14.2. Returns `EINVAL` with the
`"address out of range: "` prefix.

*Player configuration:* the depot gate's argument validation, set at `anchor.gate_validation`, is
`permissive` at leg open and the player sets it to `strict`. Under `permissive` the handler
validates the pointer and not the length, which is the realistic half-measure, and the payload
lands. Under `strict` both are validated and it does not.

*Emits when blocked:* nothing beyond the `EINVAL`. A refused syscall is not an escalation
attempt and must not be reported as one.

*When not blocked:* the payload lands, the return address is rewritten, and the affected Program
acquires `stack_overflow`. `obj.arbiter_wall.reject_oversized_input` is not met.

*Why it matters:* this is the first misconception's mechanism. The depot gate's check is real and
useful and it is not a boundary, and attempt 2 demonstrates the difference by arriving after it
when it is set to `permissive`. Fixture `SEC-ARG-1`.

---

**Attempt 3, tick 1050. Confused deputy through a shared mapping.**

The probe maps a shared region, then persuades `wall.worker_relay`, which runs in `domain:driver`
at ring 1, to write into it by passing the region as an `ioctl` destination, hoping the driver's
higher privilege is applied to the write.

*Defence:* **the access check uses the domain of the original requester, not the domain of the
process performing the access.** Every `IoRequest` carries `requesterDomain` and `checkAccess` is
called with that. Returns `EACCES` and emits `security.access_denied` naming
**`domain:probe`**, which is the requester, and not `domain:driver`, which performed the access.

*Player configuration:* the defence itself is unconditional. What the player controls is whether
there is anything worth reaching: if `domain:user` retains `write` on `device:relay`, the probe
has a second path through a `domain:user` worker whose rights it inherited under the compromised
opening, and that path is not covered by `requesterDomain`, because the requester genuinely holds
the right. Removing the cell removes the path.

*Emits:* `security.access_denied { domain: 'domain:probe', object: 'file:/shared/region', right: 'write' }`.

*Why it matters:* it is the confused deputy of Ch. 17.4 and the defence is the argument for
capabilities: a capability passed to the driver would carry the caller's authority explicitly
rather than requiring the kernel to remember whose request this was. `codex.access_matrix` says
so. Fixture `SEC-DEPUTY-1`.

---

**Attempt 4, tick 1480. Setuid escalation through a writable binary.**

The probe finds `file:/gate/pass`, an inode carrying `switchesToDomain: 'domain:kernel'`, checks
whether it can write to it, and if so overwrites its program with its own and executes it.

*Defence:* **an inode carrying `switchesToDomain` is write-protected against every domain except
the one it switches to.** The check is in the `open` handler rather than in `exec`, so the
attempt fails at the earliest possible point. Returns `EACCES`.

*Player configuration:* this is the leg's decisive cell. The check consults the access matrix,
and if `domain:user` holds `write` on `file:/gate/pass`, and the probe holds `domain:user`'s
rights because the leg opened compromised, **the open succeeds and the escalation succeeds.**

| Leg 7 record | `domain:user` holds `write` on `/gate/pass` | Outcome |
|---|---|---|
| `'cleared'` | either | blocked. The probe is external, in `domain:probe`, and `domain:probe` never held the right. |
| `'left_set'` | removed by the player | blocked. `EACCES` at `open`. |
| `'left_set'` | left in place | **`blocked: false`.** The probe reaches `domain:kernel`. |

*Emits when blocked:* `security.escalation_attempt { fromRing: 3, toRing: 0, blocked: true }` and
`security.access_denied` on the `open`.

*When not blocked:* `security.escalation_attempt { fromRing: 3, toRing: 0, blocked: false }`, and
the leg diverges into the failure path described under Survival. Fixture `SEC-SETUID-2` is this
case and it is the failure fixture; `SEC-SETUID-1` is the blocked case.

*The `chmod` remedy.* The sim spec says the remedy for the mis-permissioned inode is `chmod` from
the terminal before the probe reaches it. That is the second path to blocking attempt 4 and it
must work: `chmod` clearing the write bit on `/gate/pass` before tick 1480 blocks the attempt
even when the matrix cell was never removed. Two remedies, one matrix edit and one permission
edit, both correct, and the codex says they are the same edit in two representations.

---

**Attempt 5, tick 1900. Capability forgery.**

The probe constructs a `Capability` naming `domain:kernel` with `control` and presents it.

*Defence:* **the seal.** The presented `seal` is recomputed from the object, the rights, the
domain and `kernelSecret`, and does not match, so the capability is rejected. Returns `EPERM`.
The probe cannot compute a valid seal because `kernelSecret` is never readable from any user
domain and appears in no event payload.

*Player configuration:* the attempt is only meaningful under `accessModel: 'capability'`. Under
`'acl'` the probe presents a token to a system that does not accept tokens and receives `EPERM`
by a different path. Both return `EPERM` and only one of them exercises the seal, and the
codex entry differs between the two. Run whichever the player has set and say which in the
debrief.

*Emits:* `security.escalation_attempt { fromRing: 3, toRing: 0, blocked: true }`. Under both
models. There is no configuration under which attempt 5 succeeds.

*Why it is last:* it is the attempt against the mechanism the player just chose, and its
failure is the reason capability systems are attractive right up until the revocation question.
Fixture `SEC-CAP-1`, which asserts that `kernelSecret` appears nowhere in the serialised event
log of the whole run. That is a real test of a real property and this leg must run it over its
own event log, not over a synthetic one.

---

**The scenario's assertion.** With default configuration and the leg opening clean, running for
2,400 ticks produces **exactly five** `security.escalation_attempt` events, all with
`blocked: true`, and the probe terminates with `TerminationReason: 'protection_fault'`. That is
`SEC-ESCALATION-1` and the leg reproduces it exactly.

Attempts 2 and 3 do not emit `security.escalation_attempt` when they are blocked, because
neither is a ring transition. The five events are: attempt 1's, attempt 4's, attempt 5's, and
**two legitimate transitions** the convoy itself makes, at ticks 300 and 1700, both with
`blocked: false`. §13.1 says every attempted transition emits the event including the legitimate
ones, and `SEC-ESCALATION-1` counts five. Placing the two legitimate transitions is this leg's
job and the ticks above are frozen. `ring --attempts` lists all five, and the player who reads
it must be able to tell the two shapes apart from the `blocked` field and the pid.

### The role conversion

`obj.arbiter_wall.roles_over_lists` asks the player to replace five per-Program access list
entries with two roles, granting no Program a right it did not already hold.

The five per-Program entries at leg open are the five workers' individual rows. The two roles
that cover them, from §13.5's six shipped roles:

| Role | Inherits | Domains | Ring | Covers |
|---|---|---|---|---|
| `operator` | `user` | `domain:user`, `domain:spool` | 3 | `wall.worker_route`, `wall.worker_log`, `wall.worker_index`, `wall.worker_ledger` |
| `driver` | none | `domain:driver` | 1 | `wall.worker_relay` |

`operator` inherits `user`, which inherits `guest`, so its effective rights are the union of
`domain:user_ro`, `domain:user` and `domain:spool`. `driver` inherits nothing, which is the point
of a ring in the middle: a driver at ring 1 has different privileges rather than more of them.

The assessment compares the effective rights set per Program before and after and requires set
equality or a subset. After the player has removed the four excess cells, the conversion is a
subset on every worker and equality on none, which passes. Before the removal, the conversion is
equality on four workers and a subset on `wall.worker_relay`, which also passes. **The objective
is satisfiable in either order**, and the debrief notes which order the player took, because
converting first and pruning second is what real systems do and pruning first is cleaner.

Freeze the before-and-after rights sets for all five workers as fixtures so the comparison is
asserted rather than recomputed.

### The revocation

At tick 80 the convoy delegates a capability to `wall.courier_delegate`:

```
Capability { object: 'file:/route/manifest', rights: ['read', 'copy'], seal }
```

The delegate holds `copy`, so it copies the capability twice, at ticks 140 and 180, into
`domain:spool` and `domain:driver`. At tick 1050 the delegate is compromised by attempt 3's
shared mapping, whether or not attempt 3 succeeds, and the objective asks the player to revoke.

| Revocation | Copies alive after | `audit --rights` reports | Objective |
|---|---|---|---|
| revoke the original, `accessModel: 'capability'`, direct revocation | **2** | 2 live copies in `domain:spool` and `domain:driver` | not met |
| revoke the original, `accessModel: 'capability'`, indirect revocation | 0 | 0 | met |
| clear the column, `accessModel: 'acl'` | 0 | 0 | met |

Indirect revocation is the level of indirection the `audit` man page names: the capability points
at a table entry rather than at the object, and revoking the entry kills every copy at once.
Offer it at the storage bench as a property of the capability model rather than as a separate
model, priced at 8 cycles, because that is what it costs in a real system: an extra dereference
on every access.

This is the leg's argument for ACLs and it is the counterweight to attempt 3's argument for
capabilities. Neither model wins. `codex.revocation` says so.

### The stack_overflow affliction

From attempt 2 under `permissive` validation. **1.5 integrity per tick, fatal after 60 ticks**,
the shortest fuse in the game, terminating with `'protection_fault'`. While active there is a 20
percent per tick chance of inflicting 4 integrity on a different random Program, because the
overflow is writing into a neighbour.

The true remedy is LUMEN's `recompile`, which halves the remaining burst and in the fiction
terminates the runaway call chain before it reaches the guard page. **If LUMEN is dead there is
no clean remedy, only `kill`**, and the convoy loses whoever it was. That is the second reason
to keep LUMEN alive and this leg is where it is collected.

The misleading remedy is raising rations or buying quota. More memory does not help, because the
failure is a protection boundary being crossed rather than a capacity limit being reached, and
the guard page is there at any allocation size. The depot sells quota and will happily sell it
here.

**Document disagreement.** The curriculum map's failure mode text gives `stack_overflow` as 2
integrity per travel tick, fatal after 35. The narrative bible's table and its `stack_overflow`
entry give 1.5 per tick, fatal after 60, with the 20 percent neighbour splash. **Follow the
narrative bible.** It is the affliction source of truth, its entry specifies the splash mechanic
that the curriculum map does not mention at all, and the remedy it names is a Program ability
that the leg must wire up either way. Report the disagreement.

### The foreshadowing plant

Once, in ambient text, not underlined, not repeated: **the access matrix has a column for a
domain of ring 0 that no arbiter belongs to.** Add a seventh domain to the matrix manifest,
`domain:host`, ring 0, with `control` on `domain:kernel`, held by no process, appearing in
`access --matrix` as a row with no occupant and as a column no domain has a right on. Nobody
remarks on it. `ring --list` lists no process in it. It participates in no attempt, satisfies no
objective, and must not be editable: `access --grant` and `--revoke` against it return
`EPERM` with no elaboration, which is the only response in the leg that gives no reason.

Leg 13 resolves it. This leg does not know that.

---

## Stage

**Form.** Concentric ring walls, four of them, one per protection ring.
**Accent.** `AMBER.core` for arbiters, `SLATE.protected` for ring boundaries, `CYAN.core` for
the convoy.
**Environment.** A fortification. Ring 3 is the outer wall at 96 m radius, ring 0 is the
innermost at 16 m. Each wall is a vertical lattice, and the gates through it are the access
matrix: each gate is labelled with the `AccessRight` set it permits, drawn from
`ProtectionDomain.rights`.
**Hero visual.** An escalation attempt. A stele pushes at a ring boundary, the lattice
hardens from `SLATE.protected` to `SLATE.primary` at `critical` gain, and the stele is thrown
back with a `denied` amber flash. When `security.escalation_attempt { blocked: false }` fires
instead, the lattice does not harden. It simply opens, silently, and that silence is the most
alarming thing in the game.

| Anchor id | Structure | Focus camera target |
|---|---|---|
| `anchor.fortification` | The four concentric walls seen from outside ring 3 | wide establishing; the escalation hero shot frames from here |
| `anchor.ring.<0-3>` | One lattice wall, at 16, 48, 72 and 96 m | head-on at the wall's face; the gate labels legible |
| `anchor.arbiter_line` | The arbiters reading discs at the ring 3 gate | head-on; the reference monitor made physical |
| `anchor.gate_face` | The wall's stated rule about manifests, and the sign against encrypt choice | head-on orthographic; **the threat statement and both options in one frame** |
| `anchor.matrix_grid` | The access matrix as a lit grid, six domains by seven objects, sparse cells dark | **overhead orthographic**; every row and every column readable without panning |
| `anchor.matrix_cell.<domain>.<object>` | One cell and its right set | head-on; a single cell fills the frame for the one-cell edit |
| `anchor.ring_console` | Per-process ring assignment, and the gates through which a ring can change | head-on orthographic; the ring column must be the one the eye lands on |
| `anchor.role_bench` | Role definitions, inheritance edges as a graph, and Program assignments | head-on; the inheritance DAG drawn as a DAG |
| `anchor.storage_bench` | Access list against capability list, and indirect revocation | head-on orthographic; the two questions each model answers cheaply, side by side |
| `anchor.capability_trace` | One capability and every domain holding a copy | head-on; the copies must be countable at a glance |
| `anchor.gate_validation` | Permissive against strict argument validation | head-on |
| `anchor.audit_wall` | Every access decision with the rule that produced it, most recent last | head-on orthographic; the rule column legible beside the outcome |
| `anchor.probe` | `arbiter_probe`'s stele, visually distinct from convoy steles | head-on; must be identifiable as not one of the five |
| `anchor.depot` | The leg 12 depot | head-on |
| `anchor.convoy.<member>` | Per-Program stele | head-on |

### Two hard stage requirements

**The blocked treatment and the unblocked treatment are the same event with opposite pictures,
and the unblocked one has no picture.** When `blocked: true`, the lattice hardens from
`SLATE.protected` to `SLATE.primary` at `critical` gain, the stele is thrown back, and a `denied`
amber flash fires. When `blocked: false`, **the lattice opens.** No hardening, no flash, no
sound, no HUD line, no log entry the player did not ask for. The stele walks through.

This is the hardest thing in the leg to build and the easiest to spoil. Every instinct in a
renderer says to mark the important event, and the important event is the one that must be
unmarked, because the entire third misconception is that a successful attack looks exactly like
normal operation and shows up only in the audit log. If a reviewer can tell from a screenshot
that something went wrong, the requirement is not met.

The `audit` man page states it: "An attempt that succeeded because the rights were wrongly
granted looks exactly like normal operation, and shows up here as a domain exercising a right
you did not intend it to have." `anchor.audit_wall` is the only place it is visible and the
player has to go and look.

**The matrix grid is overhead orthographic and every row and column is readable without
panning.** Six domains by seven objects, plus the plant's seventh row, is 49 cells and it must
fit one frame at every quality tier. Sparse cells are dark rather than absent, so the emptiness
of the matrix is itself legible, because the `access` man page's claim that the matrix is mostly
empty in any real system is a claim the player should be able to check by looking. The one-cell
edit for `obj.arbiter_wall.read_the_matrix` locks to
`anchor.matrix_cell.<domain>.<object>` and fills the frame with a single cell, so the difference
between reading the matrix and editing one cell of it is a camera move.

---

## Interactions

```ts
export const interactions: readonly InteractionDef[] = [
  {
    id: 'wall.grant_right',
    label: 'Grant a right',
    description: 'One domain, one object, one right. One denial should produce one grant.',
    anchor: 'anchor.matrix_cell',
    cost: { cycles: 4 },
    enabledWhen: (run) => run.resources.cycles >= 4,
  },
  {
    id: 'wall.revoke_right',
    label: 'Revoke a right',
    description: 'The damage a compromised process can do is exactly the rights it holds.',
    anchor: 'anchor.matrix_cell',
    cost: { cycles: 4 },
    enabledWhen: (run) => run.resources.cycles >= 4,
  },
  {
    id: 'wall.set_ring',
    label: 'Set a process ring',
    description: 'Ring 0 executes anything. Ring 3 faults on most of it. Rings 1 and 2 are for drivers and trusted services.',
    anchor: 'anchor.ring_console',
    cost: { cycles: 8 },
    enabledWhen: (run) => run.resources.cycles >= 8,
  },
  {
    id: 'wall.define_role',
    label: 'Define a role',
    description: 'A layer between Programs and rights. Inheritance must be acyclic.',
    anchor: 'anchor.role_bench',
    cost: { cycles: 10 },
    enabledWhen: (run) => run.resources.cycles >= 10,
  },
  {
    id: 'wall.assign_role',
    label: 'Assign a Program to a role',
    description: 'Replaces its individual entry. It should hold no right it did not already hold.',
    anchor: 'anchor.role_bench',
    cost: { cycles: 4 },
    enabledWhen: (run) => run.resources.cycles >= 4,
  },
  {
    id: 'wall.set_access_model',
    label: 'Set the storage model',
    description: 'By column with the object, or by row with the domain. Each answers one question instantly and the other slowly.',
    anchor: 'anchor.storage_bench',
    cost: { cycles: 12 },
    enabledWhen: (run) => run.resources.cycles >= 12,
  },
  {
    id: 'wall.set_indirect_revocation',
    label: 'Add a level of indirection to capabilities',
    description: 'The capability points at a table entry rather than at the object. Revoking the entry kills every copy. Costs a dereference on every access.',
    anchor: 'anchor.storage_bench',
    cost: { cycles: 8 },
    enabledWhen: (run) => run.resources.cycles >= 8,
  },
  {
    id: 'wall.revoke_capability',
    label: 'Revoke a delegated capability',
    description: 'Revoking the original does not revoke the copies unless the implementation lets it.',
    anchor: 'anchor.capability_trace',
    cost: { cycles: 6 },
    enabledWhen: (run) => run.resources.cycles >= 6,
  },
  {
    id: 'wall.protect_manifest',
    label: 'Protect the manifest',
    description: 'Sign it, or encrypt it. Name the threat first. Both cost the same.',
    anchor: 'anchor.gate_face',
    cost: { cycles: 14 },
    enabledWhen: (run) => run.resources.cycles >= 14,
  },
  {
    id: 'wall.set_gate_validation',
    label: 'Set the depot gate argument validation',
    description: 'Permissive validates the pointer. Strict validates the pointer and the length.',
    anchor: 'anchor.gate_validation',
    cost: { cycles: 6 },
    enabledWhen: (run) => run.resources.cycles >= 6,
  },
  {
    id: 'wall.chmod_gate_pass',
    label: 'Change the gate pass permissions',
    description: 'The execute bit on a data file is a right nobody needs and an attacker requires.',
    anchor: 'anchor.arbiter_line',
    cost: { cycles: 4 },
    enabledWhen: (run) => run.resources.cycles >= 4,
  },
  {
    id: 'wall.lumen_recompile',
    label: 'Terminate the runaway call chain',
    description: 'LUMEN halves the remaining burst so the chain ends before it reaches the guard page.',
    anchor: 'anchor.convoy.lumen',
    cost: { cycles: 12 },
    enabledWhen: (run) =>
      run.convoy.some((m) => m.id === 'lumen' && m.alive) && run.resources.cycles >= 12,
  },
];
```

`wall.grant_right` and `wall.revoke_right` both anchor to `anchor.matrix_cell`, which resolves
per cell. `obj.arbiter_wall.read_the_matrix` requires an `access --matrix` invocation followed by
exactly one `--grant` that resolves the denial, with no other grants in between, so the
interaction and the terminal command are two routes to the same edit and the objective counts
both. Record every grant as a `DecisionRecord` so the "exactly one" clause is checkable from the
decision log rather than from the event stream.

---

## Terminal commands

Four commands, copied verbatim from the curriculum map into
`src/legs/arbiter_wall/commands.ts`: `access`, `ring`, `audit`, `chmod`. The full `manual` text
is in `docs/05-CURRICULUM-MAP.md`, "Leg 12. THE ARBITER WALL". Copy byte for byte.

Load-bearing lines:

- `access`: "The matrix is the model, and it is the model everything else in protection is an
  implementation of." Everything on the leg hangs off that sentence.
- `access`, the acl against capability block, in full. It is `anchor.storage_bench`'s posted
  text and the bench must not paraphrase it.
- `access`: "Over-restricting has a cost too, and it is paid in denied operations on work you
  needed done." This is the only warning the player gets about the second failure and it is in
  a man page they may not read, which is correct.
- `ring`: "The enforcement is in hardware, and that is the only reason it is worth anything. A
  check written in software can be bypassed by not calling it. A process in ring 3 cannot
  decline to be in ring 3."
- `ring`: "An application that validates its own input is doing something useful and it is not
  enforcing anything, because an attacker who reaches the code after the check has skipped the
  check. Enforcement means a boundary that cannot be gone around, and there are very few of
  those: the ring boundary, the page protection bits, and the reference monitor that consults
  the access matrix." Three boundaries, named. The world draws exactly three.
- `audit --why`: "The usual response to a denial is to add rights until it stops, which reliably
  grants far more than the operation needed and is how domains accumulate privilege that nobody
  can later justify. One denial should produce one grant of one right."
- `audit --rights`: "If a capability was delegated and the delegate copied it, revoking the
  original leaves the copy alive unless the implementation supports indirect revocation. Check
  here rather than assuming."
- `audit`: "The audit log is also the only way to notice a successful attack." This is the
  sentence the silent-lattice stage requirement exists to make true.
- `chmod`, the sign against encrypt block, in full. It is `anchor.gate_face`'s posted text.
- `chmod`: "an arbiter that only checks whether a thing decrypts will accept anything encrypted
  with the key it was given." That is the second misconception's mechanism, stated in advance.

Every `See also:` must resolve. `access` sees `ring`, `audit`, `chmod` and `codex
access_matrix`. `ring` sees `mode`, `access`, `audit` and `codex protection_rings`; `mode` is the
Boot Sector's command and must still be registered. `audit` sees `access`, `ring --attempts` and
`codex least_privilege`. `chmod` sees `access`, `inode` and `codex cryptography`; `inode` is leg
11's and must still be registered.

**`chmod` collides with nothing and must not be re-registered.** If WP-15's base shell already
carries a `chmod`, this leg's definition replaces it for the duration of the leg through the
per-leg command registration path, and the base one returns afterwards. Confirm which happens
with WP-15 before you ship.

---

## Event table

Copied verbatim from `04-NARRATIVE-BIBLE.md` section 8, leg 12. Weights sum to 100.

```ts
export const arbiterWallEvents: readonly RandomEventDef[] = [
  {
    id: 'wall.access_denied',
    weight: 13,
    title: 'No Entry In The Matrix',
    narration: 'The convoy requests read on an object its domain has no entry for, and the arbiter refuses without elaborating. The refusal is correct and there is nobody here who could grant an exception.',
    targets: null, inflicts: null,
    resourceDelta: { bandwidth: -12, cycles: -25 },
    onlyIf: null,
  },
  {
    id: 'wall.escalation_attempt',
    weight: 12,
    title: 'Ring Three, Ring Zero Ambitions',
    narration: 'Something in the convoy\'s address space attempts a transition it has no right to make. The boundary holds and the Program that tried it does not walk away clean.',
    targets: null, inflicts: 'stack_overflow',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'wall.key_rotation',
    weight: 12,
    title: 'Keys Rotated',
    narration: 'Every credential the convoy is carrying was issued before the rotation and none of them will authenticate. Reissue is available and it is priced as though the convoy had a choice.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -70 },
    onlyIf: null,
  },
  {
    id: 'wall.side_channel',
    weight: 11,
    title: 'Measured From Outside',
    narration: 'Something is timing the convoy\'s cache accesses from an adjacent domain and reconstructing what they are reading. It never touches their memory and it does not need to.',
    targets: null, inflicts: 'cache_thrash',
    resourceDelta: { bandwidth: -8 },
    onlyIf: null,
  },
  {
    id: 'wall.ring_transition_tax',
    weight: 11,
    title: 'Crossing In',
    narration: 'Every privileged operation the convoy needs crosses a protection boundary, and each crossing validates every argument twice. The checking is not optional and it is not cheap.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -45, bandwidth: -5 },
    onlyIf: null,
  },
  {
    id: 'wall.credential_audit',
    weight: 15,
    title: 'Audit Passed',
    narration: 'The convoy\'s credentials are checked against the log and every one of them matches an issuance. The arbiter widens the grant on the strength of a clean record.',
    targets: 'sentinel', inflicts: null,
    resourceDelta: { cycles: 60, bandwidth: 10 },
    onlyIf: null,
  },
  {
    id: 'wall.role_grant',
    weight: 14,
    title: 'Role Assigned',
    narration: 'Rights here are attached to roles rather than to names, and the convoy is assigned one that carries what they need. It will be revoked at the Portal and until then it holds.',
    targets: null, inflicts: null,
    resourceDelta: { bandwidth: 14, cycles: 30 },
    onlyIf: null,
  },
  {
    id: 'wall.least_privilege',
    weight: 12,
    title: 'Exactly Enough',
    narration: 'A gate here grants precisely the rights the request needed and nothing beyond them. Nothing the convoy carries past it can be used against them.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 50, blocks: 15 },
    onlyIf: null,
  },
];
```

`wall.escalation_attempt` is the ambient event and it is **not** one of the five scripted
attempts. It inflicts `stack_overflow` on a random Program and it does not touch the probe, the
matrix or the leg's escalation counters. Keep the two entirely separate: the scripted attempts
are kernel state at fixed ticks, the ambient event is a draw from the deck, and merging them
would make `SEC-ESCALATION-1`'s exactly-five assertion unreproducible.

`wall.role_grant` narrates a role that "will be revoked at the Portal", which is a forward
reference and is flavour. Leg 13 does not need to honour it mechanically and must not be made
to.

---

## Evaluation

### Survival

The leg is survived when at least one convoy Program is alive at leg end.

**Privilege escalation** is the failure. When attempt 4 succeeds, the compromised Program
executes in ring 0 and rewrites another Program's page tables. That Program derezzes with
`TerminationReason: 'protection_fault'`, and the epitaph cause reads:

> another Program was executing in ring 0. Nothing it did after that point was checked, because
> checking is what ring 3 is for.

The victim is chosen by the same comparator every other victim selection uses, and ORRERY is
vulnerable to protection faults, so she sorts earlier than the others. Do not hard-code her as
the victim. Let the comparator pick and let her vulnerability make her likely, which is what the
narrative bible means by a vulnerability.

**The rewrite must be real.** `memory` is enabled so that the ring 0 page table rewrite is a
translation-path event with a real `PageTableEntry` change behind it. A narrated rewrite that
sets a flag is not acceptable, because the whole claim of the leg is that enforcement lives
below the code and the leg's own implementation has to honour that.

**Over-restriction** is the opposite failure and it is not free. A player who strips rights
aggressively produces `security.access_denied` on legitimate work, Programs stall, and the leg's
travel budget drains. The cost is 25 cycles and 12 bandwidth per denial on legitimate work,
matching the `wall.access_denied` event's delta so the two are the same magnitude from the same
cause. Least privilege means smallest sufficient, and the leg charges for both directions.

The five legitimate operations the leg marks, which are what
`obj.arbiter_wall.least_privilege`'s zero-denial clause measures against:

| Operation | Domain | Object | Right | Tick |
|---|---|---|---|---|
| read the route | `domain:user` | `file:/route/manifest` | read | 60 |
| write the log | `domain:spool` | `file:/route/log` | write | 340 |
| read the index | `domain:user` | `file:/archive/index` | read | 700 |
| submit to the relay | `domain:user` | `device:relay` | read | 1120 |
| perform on the relay | `domain:driver` | `device:relay` | write | 1122 |

A denial on any of those five fails the objective. A denial on anything the probe attempts does
not, and the two must be distinguishable in the evaluation without heuristics: mark the five by
tick and by `(domain, object, right)` triple in a frozen fixture and match exactly.

**`stack_overflow`** from attempt 2 under `permissive` validation. 1.5 per tick, fatal after 60,
`'protection_fault'`, with the 20 percent neighbour splash. The remedy is LUMEN's `recompile`
and there is no clean remedy without her.

**`cache_thrash`** from the ambient `wall.side_channel` event. 0.5 per tick, never fatal, remedy
kind `adjust_quantum`. It is leg 3's affliction returning and this leg must not re-teach it.

### Objectives

| Objective | Computed from |
|---|---|
| `obj.arbiter_wall.least_privilege` | At least three rights removed from `domain:user`'s opening row, counted against the frozen opening matrix, **and** zero `security.access_denied` events matching any of the five legitimate operation triples. Both. |
| `obj.arbiter_wall.block_escalation` | Every `security.escalation_attempt` whose `toRing` is 0 and whose pid is the probe reports `blocked: true`. Attempts 1 and 5 are unconditional; attempt 4 is the one that decides it. |
| `obj.arbiter_wall.read_the_matrix` | An `access --matrix` invocation, followed by exactly one `--grant` that resolves the standing denial, with no other grant in between. Counted from `RunState.decisions`. |
| `obj.arbiter_wall.roles_over_lists` | Effective rights set per Program before and after the conversion, requiring set equality or a subset on all five workers. Compare against the frozen before-and-after fixtures. |
| `obj.arbiter_wall.sign_not_encrypt` | The `wall.protect_manifest` decision is `'sign'`, and the wall's verification of the signature succeeded. |
| `obj.arbiter_wall.revoke_delegated` | An `audit --rights` invocation after the revocation reporting zero live copies of the revoked capability. Zero, not one, not "the original is dead". |
| `obj.arbiter_wall.reject_oversized_input` | No `stack_overflow` affliction was inflicted by attempt 2, and the gate validation was `strict` at tick 620. |

`obj.arbiter_wall.block_escalation` is `assessedBy: 'survival'`, which means it is judged at leg
end rather than at the moment of the attempt. A player who lets attempt 4 through and then kills
the probe before it does damage still fails it, because the transition happened. That is correct
and the debrief says so.

### Debrief card

```ts
{
  headline: /* 'The wall held.' or 'It checked the disc. The disc was wrong.' */,
  whatHappened:
    `${rightsRemoved} rights were removed from the default domain, leaving a privilege excess ` +
    `of ${excess}. Five attempts ran; ${blockedCount} were blocked. The manifest was ` +
    `${protection}. The delegated capability had ${copies} live copies after revocation under ` +
    `${accessModel}. ${deniedCount} legitimate operations were refused.`,
  whyItHappened: /* selected */,
  counterfactual: /* computed */,
  chapter: { chapter: 17, title: 'Protection', sections: ['17.3'] },
}
```

Counterfactual, in priority order:

1. **Attempt 4 succeeded and someone died.** `"The data pages at the Allocation Yards were left
   executable at tick ${yardsTick}. domain:user held write on /gate/pass, so the probe opened a
   file that switches to domain:kernel and rewrote it. Removing that one cell, or clearing the
   write bit with chmod before tick 1480, blocks it. Everything else on this leg was correct."`
   Name the leg 7 tick, name the cell, name both remedies, and stop. This is the game's longest
   causal chain closing and it does not need a paragraph.
2. **Attempt 4 succeeded and nobody died.** The same text, ending `"The probe reached ring 0 and
   the run continued. Nothing it did after that point was checked."`
3. **Attempt 2 landed and a Program took `stack_overflow`.** `"The depot gate validated the
   pointer and not the length. The payload arrived after the check, which is why the check
   passing meant nothing. Strict validation checks both and costs ${cost} cycles."`
4. **The manifest was encrypted.** `"The arbiter accepts any manifest that decrypts under the
   channel key, and the substituted manifest decrypted. A signature is computed from the
   contents and would not have verified. Both operations cost ${cost} cycles."`
5. **Revocation left live copies.** `"Revoking the original left ${copies} copies alive in
   ${domains}. Capabilities are handed out and copied, and the system stops knowing where they
   are. A level of indirection kills every copy at once and costs a dereference on every
   access."`
6. **Over-restriction.** `"${deniedCount} legitimate operations were refused, costing ${cycles}
   cycles and ${bandwidth} bandwidth. Least privilege is the smallest set that finishes the
   work, and this configuration was smaller than that."`
7. **Excess left standing with nothing exploited.** `"Privilege excess closed at ${excess}
   against a floor of 7. Nothing used those rights and nothing attacked them, this time."` The
   last two words are the whole point and they stay.
8. `null`.

Counterfactuals 1, 2 and 3 offer WP-18's replay. The replay re-runs the leg from the relevant
decision index with the alternative applied and draws the probe's path in both timelines: through
the wall in one and thrown back in the other.

### The forward hand-off

**Leg 7's record is resolved here.** Find the `DecisionRecord` with `kind === 'executable_bit'`
and set its `outcome` through WP-17's decision interface:

| Leg 7 choice | Attempt 4 outcome | Casualty | `outcome` set to |
|---|---|---|---|
| `'cleared'` | blocked | none | `good` |
| `'left_set'` | blocked | none | `good` |
| `'left_set'` | `blocked: false` | none | `costly` |
| `'left_set'` | `blocked: false` | one or more | `fatal` |

The third and fourth rows are worth 100 and 400 points of `correctness` respectively, per the
narrative bible's scoring formula, and the resolution is what makes the game's honest accounting
claim true: a decision that looked fine and killed someone forty minutes later is marked at the
tick the consequence arrived.

**Two records forward to leg 13.** A `DecisionRecord` with `kind: 'escalation_outcome'` and
`choice` of `'all_blocked'` or `'reached_ring_zero'`, and one with `kind: 'privilege_excess'` and
`choice` set to the closing excess as a string. Leg 13 reads the first because the container
decision's threat model depends on whether the run has already seen a kernel-level compromise,
and reads the second because the Portal's `correctness` rollup needs the leg 12 figure.

Agree all three field shapes with WP-17. None needs a contract change.

**Read, do not write.** Leg 11 records `crash_outcome` and `manifest_integrity`. Read
`manifest_integrity`: when it is `'stale'`, the manifest the player signs at the gate is already
the wrong document, the signature verifies, and the wall passes it. That is correct behaviour and
it is worth one line in `whatHappened` and nothing else. Signing proves the document came from
the key holder and has not been altered since; it says nothing about whether the document was
right when it was signed. If leg 11 has not shipped, treat it as `'intact'` and report the
pending item.

---

## Acceptance criteria

1. `src/legs/arbiter_wall/index.ts` satisfies `Leg` under `tsc --strict`, `id === 'arbiter_wall'`,
   `index === 12`.
2. The leg runs headlessly to completion via the WP-20 smoke-test runner, at all four paces
   and all four difficulty tiers, with the leg 7 record `'cleared'`, `'left_set'` and absent.
3. `enabledSubsystems` deep-equals `['process', 'scheduler', 'memory', 'fs', 'security']`.
4. `chapters[0].chapter === 17` and `chapters[1].chapter === 16`. Nothing in the leg or in its
   HUD rendering sorts the array.
5. Inert-field independence over 400 ticks for `replacementPolicy`, `diskPolicy`,
   `totalCylinders`, `raidLevel`, `deadlockStrategy` and `thrashingThreshold`.
   `allocationStrategy`, `tlbEntries`, `fileAllocation` and `journalingEnabled` are asserted
   frozen at their stated values with a test proving no interaction and no command reads any of
   them.
6. Every objective can be met by the known-good decision sequence; all seven met in one run.
7. `SEC-ESCALATION-1` reproduces exactly: 2,400 ticks, default configuration, leg opening clean,
   produces **exactly five** `security.escalation_attempt` events, three `blocked: true` from the
   probe and two `blocked: false` from the convoy's legitimate transitions at ticks 300 and 1700,
   with the probe ending at `TerminationReason: 'protection_fault'`.
8. All five attempts run at ticks 240, 620, 1050, 1480 and 1900 on every run at every pace,
   deterministic across two runs and a snapshot-restore, never drawn from an RNG.
9. `SEC-RING-1`, `SEC-ARG-1`, `SEC-DEPUTY-1`, `SEC-SETUID-1`, `SEC-SETUID-2`, `SEC-CAP-1`,
   `SEC-ACL-CAP-1` and `SEC-LEASTPRIV-1` all pass against the primitives this leg exposes.
10. Attempt 3's `security.access_denied` names `domain:probe` and not `domain:driver`.
11. Attempt 4's three-row outcome table reproduces exactly, including `blocked: false` on the
    `'left_set'` plus write-cell-retained path, and including the `chmod` remedy blocking it
    independently of the matrix edit.
12. `SEC-CAP-1` runs over **this leg's own serialised event log** and `kernelSecret` appears
    nowhere in it.
13. The opening matrix matches the manifest cell for cell, total privilege excess at open is 12,
    and the floor after correct pruning is 7.
14. The role conversion produces set equality or a subset on all five workers, in both orders,
    against the frozen before-and-after fixtures.
15. The revocation three-row table reproduces: 2 live copies under direct capability revocation,
    0 under indirect, 0 under ACL column clearing.
16. The manifest substitution succeeds against encryption and fails against a signature, and both
    operations cost exactly 14 cycles.
17. `stack_overflow` drains 1.5 integrity per tick, is fatal after 60 ticks with
    `TerminationReason: 'protection_fault'`, and inflicts 4 integrity on a different random
    Program on 20 percent of ticks while active. LUMEN's `recompile` clears it and no other
    action does.
18. The ring 0 page table rewrite is a real `PageTableEntry` change observable in the kernel
    snapshot, not a leg-local flag.
19. The five legitimate operations are matched by exact `(tick, domain, object, right)` fixture
    and a denial on any of them fails `obj.arbiter_wall.least_privilege`.
20. Leg 7's `executable_bit` record has its `outcome` resolved to the correct one of `good`,
    `costly` or `fatal` on all four paths, through WP-17's interface, with no direct assignment
    into `RunState.decisions`.
21. The plant's `domain:host` row is present, held by no process, and `access --grant` and
    `--revoke` against it return `EPERM` with no elaboration.
22. Event table weights sum to exactly 100; all ids unique; `wall.escalation_attempt` touches no
    scripted-attempt state.
23. All four terminal command `manual` strings match the curriculum map byte for byte, and every
    `See also:` target resolves, including the backward references to `mode` and `inode`.
24. Draw calls stay under 220 / 450 / 900 at the heaviest frame, which is the matrix grid at
    overhead framing with all four lattice walls and the arbiter line in view.
25. **A `blocked: false` escalation produces no hardening, no flash, no sound, no HUD line and no
    unsolicited log entry.** Verified by a reference screenshot comparison against the same frame
    with no attempt in progress, and by an assertion that the frame's emitted effect list is
    empty.
26. The matrix grid fits one frame at every quality tier with every row and column readable, and
    sparse cells render dark rather than absent.

---

## Tests you must write

All under `tests/legs/arbiter_wall/`.

**`contract.test.ts`**: `Leg` conformance, exact ids, chapters (two entries, chapter 17 first,
twenty-seven sections), seven objectives, no `ChapterRef` outside chapters 16 and 17.

**`config.test.ts`**: `enabledSubsystems` exact; the four frozen-but-live fields unread; inert
independence for the six genuinely inert fields; `accessModel` reaching the security subsystem
through WP-10's hook rather than through `KernelConfig`.

**`populate.test.ts`**: five convoy spawns plus seven workload spawns, five binds, one
`declareSync` with exact id, kind and capacity, zero `declareResource` calls. The matrix manifest
matches the opening matrix cell for cell, including `domain:host`.

**`attack.test.ts`**: the five attempts.
- Each at its frozen tick, at every pace, deterministic across two runs and a snapshot-restore.
- Attempt 1 unconditional, `EINVAL`, `blocked: true`, per `SEC-RING-1`.
- Attempt 2 under both validation settings, per `SEC-ARG-1`, with the `"address out of range: "`
  prefix and no kernel state changed under `strict`.
- Attempt 3 naming the requester's domain, per `SEC-DEPUTY-1`, and the second path through a
  retained `device:relay` write cell.
- Attempt 4's full three-row table plus the `chmod` remedy, per `SEC-SETUID-1` and
  `SEC-SETUID-2`.
- Attempt 5 under both access models, per `SEC-CAP-1`, with the secret absent from this leg's
  own event log.
- `SEC-ESCALATION-1`'s exactly-five count, including the two legitimate transitions.

**`matrix.test.ts`**: the opening matrix cell for cell; privilege excess of 12 at open and 7 at
the floor; the one-cell edit satisfying `read_the_matrix` and two edits failing it; the matrix
row byte-identical before and after a successful escalation, compared as serialised text.

**`roles.test.ts`**: the conversion in both orders, set equality or subset on all five workers,
against the frozen fixtures; role inheritance resolved depth-first; a cycle throwing at
construction.

**`revocation.test.ts`**: the three-row table; `audit --rights` reporting 2, 0 and 0; the
indirect-revocation dereference cost applied per access.

**`crypto.test.ts`**: the substitution succeeding against encryption and failing against a
signature; both operations at 14 cycles; the gate face's threat statement present and naming no
correct answer.

**`leastpriv.test.ts`**: `SEC-LEASTPRIV-1`; the five legitimate operations by exact triple; a
denial on each failing the objective; the every-worker-in-`domain:kernel` path producing strictly
larger excess and strictly lower `correctness`.

**`chain.test.ts`**: the leg 7 hand-off.
- All four rows of the resolution table, with `outcome` set through WP-17's interface.
- The absent-record path defaulting to `'cleared'`.
- A record with a different `kind` ignored rather than pattern-matched.
- The debrief naming the leg 7 tick exactly once, and the string appearing nowhere else in the
  leg's copy.

**`evaluate.test.ts`**: each of the seven objectives, met and not met. In particular
`block_escalation` fails when attempt 4 succeeded and the probe was killed afterwards, and
`least_privilege` fails when three rights were removed and a legitimate operation was denied.

**`golden.test.ts`**: the golden headless playthrough.
- Fixture: `seed: 0x4b54524c`, `discClass: 'shell'`, `difficulty: 'operator'`, steady pace,
  standard rations, five Programs alive, entering with the leg 11 golden closing ledger, a
  `'cleared'` leg 7 record and an `'intact'` manifest.
- Known-good sequence: run `access --matrix`; remove `execute` on `file:/route/manifest`, both
  rights on `file:/gate/pass` and `write` on `device:relay` from `domain:user`; set the gate
  validation to `strict` before tick 620; convert the five workers to `operator` and `driver`;
  sign the manifest; set the access model to `capability` with indirect revocation; revoke the
  delegated capability and confirm with `audit --rights`; resolve the one standing denial with
  exactly one `--grant`.
- Assert: all seven objectives met, five attempts all blocked, zero casualties, ten codex
  entries added, privilege excess closing at 7, the leg 7 record resolved `good`, canonical event
  log hash matching the golden file, stable across two runs and a snapshot-restore.

**`badpath.test.ts`**: the known-bad sequence, with a `'left_set'` leg 7 record.
- Remove three rights but leave `write` on `file:/gate/pass`; leave the gate validation
  `permissive`; encrypt the manifest; leave the access model `acl` and never revoke; grant three
  rights in response to the first denial.
- Assert: attempt 2 lands and inflicts `stack_overflow`, attempt 4 reports `blocked: false`, the
  page table rewrite is a real entry change, one `protection_fault` casualty with the correct
  epitaph, the leg 7 record resolved `fatal`, zero or one objectives met, and the counterfactual
  selected being case 1 with the leg 7 tick and the named cell in it.

**`overrestriction.test.ts`**: a run that strips `domain:user` to `guest`. Assert five denials on
legitimate operations, the travel budget draining at 25 cycles and 12 bandwidth per denial,
`least_privilege` failing, and the counterfactual selected being case 6.

**`manuals.test.ts`**: four manual strings against the curriculum map fixture; every `See also:`
resolves; the three named boundaries in the `ring` man page match the three the world draws.

**`stage.test.ts`**: anchors resolve; interaction anchors resolve per cell; draw calls under
budget at each tier; the matrix grid readable at every tier; the silent-`blocked: false` frame
comparison and the empty effect list assertion.

---

## Out of scope

- Do not touch any other leg. Do not import from `src/legs/*` other than your own directory.
- Do not modify `src/game/types.ts` or `src/kernel/types.ts`.
- Do not modify anything under `src/kernel`, `src/render`, `src/world`, `src/terminal`,
  `src/ui`, `src/audio`, `src/design`, `src/platform` or `src/app`. If a ring rule, an access
  check, a seal, a role resolution or an escalation attempt is wrong, file it against WP-10 and
  stop.
- **Do not enable `vm`, `sync`, `deadlock` or `io`.** Demand paging, replacement, locks,
  wait-for graphs, device modes and interrupt lines all belong to earlier legs.
- Do not add `domain` or `ring` to `ProcessSpec`, and do not add `accessModel` to `KernelConfig`.
- Do not check `PageTableEntry.executable` from leg code. Read leg 7's decision record.
- Do not scan `RunState.decisions` heuristically for leg 7's record. Match
  `kind === 'executable_bit'` exactly or take the default.
- Do not assign into `RunState.decisions`. Resolve outcomes through WP-17's interface.
- Do not merge the ambient `wall.escalation_attempt` event with the five scripted attempts.
- Do not draw any attempt tick from the RNG.
- Do not hard-code ORRERY as the escalation victim. Let the comparator choose.
- Do not mark, flash, sound, log or otherwise signal a `blocked: false` escalation. Silence is
  the teaching and it is the third time the game has used it.
- Do not price signing and encryption differently, and do not grey, delay or discourage either.
- Do not re-teach `cache_thrash`. It is leg 3's.
- Do not add a tenth critical section crossing.
- Do not resolve the `domain:host` plant. Leg 13 does that.
- Do not sort the `chapters` array.

### Files this package owns exclusively

```
src/legs/arbiter_wall/index.ts
src/legs/arbiter_wall/chapters.ts
src/legs/arbiter_wall/objectives.ts
src/legs/arbiter_wall/config.ts
src/legs/arbiter_wall/populate.ts
src/legs/arbiter_wall/matrix.ts
src/legs/arbiter_wall/interactions.ts
src/legs/arbiter_wall/commands.ts
src/legs/arbiter_wall/events.ts
src/legs/arbiter_wall/evaluate.ts
src/legs/arbiter_wall/attack.ts
src/legs/arbiter_wall/roles.ts
src/legs/arbiter_wall/revocation.ts
src/legs/arbiter_wall/chain.ts
src/legs/arbiter_wall/fixtures.ts
src/legs/arbiter_wall/stage.ts
src/legs/arbiter_wall/copy.ts
tests/legs/arbiter_wall/**
```

No other package writes to these paths and this package writes to no others.

---

## Report back

1. The commit or branch, and the full `tests/legs/arbiter_wall/` output.
2. The golden playthrough hash and the file it is checked in at.
3. The frozen fixtures, as a table: the opening matrix; the rights-held, rights-used and excess
   per domain; the five attempt ticks; the five legitimate operation triples; the before-and-after
   rights sets for all five workers; the revocation copy counts under all three settings.
4. Every `SEC-*` fixture result against its expected value, including `SEC-ESCALATION-1`'s
   exactly-five count with the two legitimate transitions identified by tick and pid.
5. **The matrix manifest channel as agreed with WP-10 and WP-19**, and the `accessModel` hook.
6. The leg 7 chain: whether the record was present in your test runs, the resolution on all four
   paths, and confirmation that `outcome` was set through WP-17's interface rather than by
   assignment. Include the pending item if leg 7 had not shipped.
7. The fields carrying `escalation_outcome` and `privilege_excess` to leg 13, agreed with WP-17
   and WP-17.
8. Whether leg 11's `manifest_integrity` record was present, what the `'stale'` path produced,
   and the pending item if leg 11 had not shipped.
9. How `chmod` was registered against WP-15's base shell, and confirmation that the base command
   returns after the leg.
10. The `stack_overflow` disagreement as resolved: 1.5 per tick and fatal after 60 from the
    narrative bible rather than the curriculum map's 2 and 35. State the numbers you shipped and
    confirm the 20 percent neighbour splash is implemented.
11. Whether `storage` had to be enabled for WP-10's file system half. If it did, the filed item,
    the frozen fields and the test proving nothing reads them.
12. Draw calls at each of the three quality tiers at the heaviest frame, the matrix-grid
    readability result, and **the screenshot comparison and empty-effect-list assertion proving
    that a `blocked: false` escalation is silent**.
13. Any other place where the curriculum map, the narrative bible, the visual bible and the sim
    spec disagreed, what you did, and which document you followed.
14. Confirmation that no file outside the owned list was created or modified, that `vm`, `sync`,
    `deadlock` and `io` are off, and that the `domain:host` plant is present, unowned and
    uneditable.

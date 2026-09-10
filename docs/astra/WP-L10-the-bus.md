# WP-L10: The Bus

Leg id `the_bus`, index 10. Subtitle: *Ask once, or be told. Choose wrong and you do nothing
else.*

**Legs are independent and may be built concurrently.** This package touches no other leg,
imports from no other leg, and shares no source file with any other leg.

The Bus is the first leg of a new subsystem in a familiar shape. The player already knows what a
queue is, what a policy is and what a rate mismatch feels like, so the leg spends its budget on
one idea: the correct choice between polling, interrupts and DMA is decided by the arrival rate,
and it reverses inside a single leg. Eight new codex entries, roughly 25 minutes, moderate load.

There is no depot on this leg. The convoy crosses on what it carried out of the Platters and the
next depot is the Archive. Budget the leg against that.

---

## Objective

A module at `src/legs/the_bus/` implementing the frozen `Leg` interface, playable end to end.
The Bus is a raised causeway with device ports hanging off both sides. The convoy runs the
causeway from one end to the other, and every port it passes has to be assigned a transfer mode
before it will serve a request.

The leg is built around three route strategies with three genuinely different cost profiles, and
the player must be able to compute all three from numbers the world shows them. The interrupt
storm is the failure and it is the only failure in the game that reads as full utilisation with
zero progress, which is a signature worth having met once.

---

## The KESTREL problem

KESTREL halves device latency and seek cost while he lives. He is also `targets: 'courier'` on
this leg's first event and the default carrier of the `interrupt_storm` affliction, because he
answers everything immediately. **The Program that makes this leg cheap is the Program this leg
is most likely to kill**, and that tension is the leg's character. Build it deliberately.

The package must handle three states, and each one changes real numbers rather than flavour.

**KESTREL alive at leg entry.** Every device's effective latency is `ceil(latency / 2)`. On the
manifest port that turns 20 into 10, so poll-wasted ticks per request fall from 19 to 9 and the
polling penalty is survivable long enough for the player to notice it and act. The leg's
designed tick cost is the narrative bible's figure for leg 10: **80 segments, 200 cycles and 80
ticks at steady pace, standard rations, five alive.**

**KESTREL dies during this leg.** Effective latency reverts to full at the tick of the derezz,
mid-leg. Every in-flight request's remaining cost is recomputed at the new latency rather than
grandfathered, so the meters move visibly at the moment of the death. This is the only leg where
the player sees a Program's passive removed while they are watching the number it was holding
down.

**KESTREL died on an earlier leg.** The leg opens at full latency. Per the narrative bible, the
Platters and the Bus roughly double in tick cost without him. Concretely, and these are the
figures the package tunes against:

| Quantity | KESTREL alive | KESTREL dead |
|---|---|---|
| `dev.manifest` effective latency | 10 | 20 |
| Poll-wasted ticks per manifest request | 9 | 19 |
| `dev.vault` effective latency | 6 | 12 |
| Designed leg ticks at steady pace | 80 | 152 |
| Designed leg cycles at steady pace | 200 | 380 |
| Storm onset tick, known-bad path | 640 | 480 |
| Ticks of warning between storm stage 1 and stage 3 | 40 | 20 |

The storm arrives earlier and the warning window halves, because the handler backlog grows
against a slower drain. A convoy without KESTREL should be able to finish this leg on
conservative pace with the manifest port on interrupts and the network port coalesced, and
should not be able to finish it on reckless pace with anything. Verify both.

**The debrief must name him.** When KESTREL is dead at leg entry, the debrief's
`whatHappened` states the doubled figure and where it came from, and the counterfactual offers
the leg at halved latency. See the Debrief card section for the exact ordering. Do not put this
in flavour text and do not put it in a tooltip. It goes in the card the player reads at the end
of the leg, with the number in it.

---

## Prerequisites

**Engine work packages that must be complete and green on the shared branch:**

| Package | Why this leg needs it |
|---|---|
| WP-01 | `Rng`, event bus, canonical serialiser. |
| WP-02 | Process table, PCB, `BlockReason` of kind `io`, kernel step order, phases 2, 3 and 4. |
| WP-03, WP-04 | Scheduler policies. The leg does not teach scheduling and needs `rr` to exist, because the DMA objective is counted in context switches. |
| **WP-09** | **The I/O half of it, in full.** `IoMode` on every device, the poll loop cost model, the interrupt controller with priorities and nesting, the storm detector and its four escalation stages, DMA with cycle stealing, the three buffering schemes, the block cache, spooling, and the `DeviceDriver` interface with all four shipped drivers. This leg is the I/O half's only consumer. |
| WP-11 | Syscalls, snapshot and restore, the invariant set. `ioctl` is the escape hatch every device command goes through. |
| WP-12 | Renderer backend, post chain, design tokens, draw call budget. |
| WP-13 | Focus camera and the diegetic structure base classes. |
| WP-14 | World event router. `io.request`, `io.interrupt`, `io.dma_transfer` and `io.poll_wasted` must each have a visual treatment, and the storm needs a rate-driven treatment rather than a per-event one. |
| WP-15 | The terminal. |
| WP-17 | HUD, codex, save and load. |
| WP-18 | The counterfactual replay worker. `iomode --compare` and the debrief both consume it. |

**Kernel subsystems that must be working:** `process`, `scheduler`, `io`.

WP-09's I/O half must provide, exactly:

- All three `IoMode` values per device, switchable at run time through `ioctl`, with the cost
  model of §11.1 reproduced tick for tick and fixture `IO-COST-1` passing.
- `io.poll_wasted` carrying `wastedTicks` equal to `effectiveLatency - 1`, charged to the
  requesting process and counted as CPU busy in `cpuUtilisation`.
- Interrupt overhead charged to the kernel's overhead counter and to no process's
  `totalCpuUsed`, so a storming system shows falling utilisation with no process progress.
- The interrupt controller of §11.2: lines sorted by `(priority, deviceId)` fixed at
  construction, nesting by strict priority, `maxInterruptsPerTick` default 2, non-maskable timer
  and panic lines.
- The storm detector of §11.3 with all four escalation stages, including stage 2's automatic
  masking and drop to polling, which the player must be able to watch happen without acting.
- DMA with `dmaCycleStealRatio` charged to the currently running process, emitting
  `io.dma_transfer { device, bytes }` once per transfer.
- `single`, `double` and `circular` buffering per device, with `bufferOccupancy` and
  `bufferStalls` as live metrics.
- A copy counter per transfer, readable per device.
- The `DeviceDriver` interface with `kind: 'block' | 'character' | 'network'`, and an attach
  path that binds an unregistered device to a chosen kind and **succeeds with wrong semantics**
  rather than failing when the kind does not match the device.

Fixtures `IO-COST-1`, `IO-POLL-1`, `IO-INT-1`, `IO-STORM-1`, `IO-BUF-1` and `IO-SPOOL-1` must
all pass before this leg starts.

**Not required and must not be enabled:** `storage`. Head position, seek cost, disk scheduling
and RAID all belong to leg 9. This leg deals in devices, modes, queues and buffers. The block
device it attaches is reached through its driver and its geometry is never modelled, never
drawn, and never named. `fs` is leg 11's and is likewise off.

---

## Required reading

- `docs/05-CURRICULUM-MAP.md`, "Leg 10. THE BUS" in full; section D, "Difficulty and cognitive
  load curve", the leg 10 row.
- `docs/02-KERNEL-SIM-SPEC.md`, **section 11 in full** (I/O, Ch. 12); section 16.10 (the `IO-*`
  test vectors); section 14 for the `ioctl` commands each driver accepts.
- `docs/04-NARRATIVE-BIBLE.md`, section 3.4 (KESTREL, in full, because this leg is built on his
  passive and his vulnerability); section 7 entry for `interrupt_storm`; section 8 leg 10 event
  table; section 9 epitaphs for `io_timeout`; section 5.3 (leg lengths, and the fact that leg 10
  has no depot); section 1.5 (the leg 10 foreshadowing plant).
- `docs/03-VISUAL-BIBLE.md`, section 10 "Leg 10, The Bus"; section 8.6 (data flowing along a
  beam); section 13 (quality tiers).

---

## Frozen contracts

These types are frozen. You may not edit, extend, narrow or re-declare any of them.
A leg that appears to need a contract change stops and escalates, because every other
leg in flight depends on this file. Copy them into your leg only by importing:

```ts
import type { Leg, LegSetupContext, LegStage, LegOutcome /* ... */ } from '@game/types';
import type { KernelConfig, SubsystemId, IoMode, Device, DeviceId /* ... */ } from '@kernel/types';
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

`LegSetupContext` has no `declareDevice`, and you may not add one. See the Population section
for how the device manifest reaches the kernel.

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

The I/O half of the frozen kernel types this leg reads:

```ts
export type IoMode = 'polling' | 'interrupt' | 'dma';

export interface Device {
  readonly id: DeviceId;
  readonly displayName: string;
  readonly kind: 'block' | 'character' | 'network';
  readonly mode: IoMode;
  /** Ticks to service one request once started. */
  readonly latency: number;
  busy: boolean;
  queue: Pid[];
}
```

`Device.mode` and `Device.latency` are `readonly`. A mode change replaces the `Device` record in
the kernel's device table through `ioctl`; it does not mutate the field. KESTREL's halving is
applied by WP-09 when it constructs the record, from the convoy state the runner hands it, and
never by the leg reaching into the table.

Every field of `KernelConfig` is required, including the ones your leg does not use.
Set the unused ones to the inert defaults given in the Kernel configuration section
below and leave their subsystem out of `enabledSubsystems`. An inert field is never
read, and the smoke test asserts that.

---

## Curriculum

### Chapters

```ts
export const chapters: readonly ChapterRef[] = [
  { chapter: 12, title: 'I/O Systems',
    sections: ['12.1', '12.2.1', '12.2.2', '12.2.3', '12.2.4', '12.2.5',
               '12.3.1', '12.3.2', '12.3.3', '12.3.4', '12.3.5',
               '12.4.1', '12.4.2', '12.4.3', '12.4.4', '12.4.5', '12.4.6',
               '12.5', '12.7'] },
];
```

One chapter, nineteen sections, and it is the widest single-chapter sweep in the game. The leg
covers the whole of 12.2 (I/O hardware), the whole of 12.3 (the application interface), the
whole of 12.4 (kernel I/O subsystem), 12.5 (transforming requests to operations) and 12.7
(performance). 12.6, STREAMS, is out of scope and is not cited anywhere.

### Learning objectives

```ts
export const objectives: readonly LearningObjective[] = [
  {
    id: 'obj.the_bus.polling_to_interrupt',
    statement: 'Switches the slow device from polling to interrupt-driven once poll-wasted ticks exceed 15 percent of processor time, and shows useful-work utilisation rising by at least 12 points.',
    chapter: { chapter: 12, title: 'I/O Systems', sections: ['12.2.2', '12.2.3'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.the_bus.clear_interrupt_storm',
    statement: 'Clears an interrupt_storm affliction by enabling coalescing or by moving the offending device to polling, bringing the interrupt rate under 40 per 100 ticks.',
    chapter: { chapter: 12, title: 'I/O Systems', sections: ['12.2.3', '12.7'] },
    assessedBy: 'survival',
  },
  {
    id: 'obj.the_bus.dma_offload',
    statement: 'Moves the bulk transfer to DMA so per-byte processor involvement falls to zero, and schedules at least three other Programs during the transfer window.',
    chapter: { chapter: 12, title: 'I/O Systems', sections: ['12.2.4'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.the_bus.buffer_sizing',
    statement: 'Sizes the device buffer so no producer stalls on a full buffer and no transfer takes more than two copies from device to requesting Program.',
    chapter: { chapter: 12, title: 'I/O Systems', sections: ['12.4.2', '12.4.3'] },
    assessedBy: 'outcome',
  },
  {
    id: 'obj.the_bus.blocking_choice',
    statement: 'Issues the manifest log write as asynchronous I/O and the route configuration read as blocking, so no Program waits on data it does not immediately need.',
    chapter: { chapter: 12, title: 'I/O Systems', sections: ['12.3.4'] },
    assessedBy: 'decision',
  },
  {
    id: 'obj.the_bus.driver_absorbs_difference',
    statement: 'Attaches the unknown device through the block-device interface with iomode --attach and completes a transfer without changing any Program, showing that the driver rather than the caller absorbs device specifics.',
    chapter: { chapter: 12, title: 'I/O Systems', sections: ['12.3.1', '12.5'] },
    assessedBy: 'terminal_command',
  },
];
```

### Codex entries this leg adds to `codexUnlocked`

`codex.io_methods`, `codex.interrupt_mechanism`, `codex.interrupt_storm`, `codex.dma`,
`codex.device_interfaces`, `codex.device_driver`, `codex.io_buffering`, `codex.io_protection`.

| Entry | Added when |
|---|---|
| `codex.io_methods` | First `iomode` invocation, or the first `io.poll_wasted` event. |
| `codex.interrupt_mechanism` | First `io.interrupt` event delivered to a convoy Program. |
| `codex.interrupt_storm` | The storm detector reaches stage 1. |
| `codex.dma` | First `io.dma_transfer` event. |
| `codex.device_interfaces` | First `iomode --attach` invocation, in either direction. |
| `codex.device_driver` | The same physical device is attached a second time under a different kind. |
| `codex.io_buffering` | First `devstat --buffer` invocation, or the first producer stall. |
| `codex.io_protection` | A ring 3 process attempts a direct device register access and is refused. |

`codex.io_protection` is the only entry here that fires from the security path rather than the
I/O path. It is the forward link into leg 12 and it is the reason a leg with `security` disabled
still needs the refusal to happen: the refusal is a syscall-layer check, not a
`security.access_denied` event, and it costs nothing. Register the forward link here; leg 12
registers the back-link.

`codex.interrupt_storm` cross-links to `codex.dining_philosophers` from leg 5 and to
`codex.livelock`, because the storm is livelock at the interrupt layer: everyone is busy,
nothing advances, and no error is raised. Register the back-links here.

### Misconceptions this leg must break

**"Interrupts are strictly better than polling; polling is what you do when you do not know
better."** The course order teaches polling first and interrupts as the improvement, which
plants this firmly. The break is the network port. The player, having just learned to move
devices off polling, moves this one off polling too, and the system locks up at 98 percent
utilisation with zero packets processed. `irq --rate` shows 900 interrupts per 100 ticks
against a handler cost that admits 40. Moving the device back to polling fixes it. The player
has now made the same change in both directions on the same leg, for good reasons both times,
which is the only way this belief actually breaks.

Build requirement: **both moves must be made by the player, on the same leg, and both must be
correct.** The manifest port move from polling to interrupt and the network port move from
interrupt back to polling are the two halves of one lesson and neither is optional. The leg does
not complete with `obj.the_bus.polling_to_interrupt` met and the storm still running, and it does
not complete with the storm cleared and the manifest port still polling. The known-good sequence
performs both.

The arithmetic that makes both correct is on the port faces and is given in full under Population.
The player can compute the answer before acting, at both ports, from three numbers each.

**"DMA means the transfer is free, because the processor is not involved."** Nearly true and
the gap matters. The break is instrumented on the bulk transfer: DMA is enabled, the processor
is correctly scheduled onto three other Programs, and those three Programs run measurably slower
for the duration. `devstat` attributes it to bus contention, because the DMA controller and the
processor are both reaching for memory over the same bus, and the controller wins some of those
cycles. The processor is not doing the transfer and it is still paying for it.

Build requirement: the slowdown must be measured and attributed, not asserted. `devstat` prints
the three Programs' service rate inside the transfer window against their rate outside it, and
the difference must equal `dmaCycleStealRatio` to within one tick of rounding. See the note on
the 10 percent against 20 percent disagreement under Known-correct numbers.

**"A device driver is part of the device, or a piece of vendor software that sits beside the
operating system."** Students treat drivers as an implementation detail with no conceptual
content. The break is the unknown-device port: the same physical device is attached twice, as
a block device and as a character device, and the convoy's Programs are unchanged in both
cases. Under one attachment seeking works and under the other it silently does nothing. The
Program's code never mentions the device. What changed was the kernel's translation layer,
which is the entire definition of a driver, and the leg makes the player perform the
substitution rather than read about it.

Build requirement: the substitution must be reversible and repeatable, and the `ProcessSpec` of
every Program involved must be byte-identical across both attachments. Assert that in the test,
by comparing the spawned specs rather than by trusting that nothing edited them.

---

## Kernel configuration

```ts
export function kernelConfig(run: RunState): KernelConfig {
  return {
    seed: run.seed,
    scheduler: 'rr',                       // the DMA objective is counted in context switches
    schedulerParams: {
      quantum: quantumForPace(run.policy.pace),
      agingInterval: 0,                    // no starvation theme on this leg
      starvationThreshold: 120,
      starvationFatalThreshold: 300,
      preemptive: true,                    // load-bearing: the transfer window must be shareable
    },
    totalFrames: 64,                       // inert: 'memory' is not enabled
    pageSize: 4096,                        // inert
    replacementPolicy: 'lru',              // inert
    allocationStrategy: 'first_fit',       // inert
    tlbEntries: 16,                        // inert
    diskPolicy: 'look',                    // inert: 'storage' is not enabled
    totalCylinders: 200,                   // inert
    raidLevel: null,                       // inert
    fileAllocation: 'indexed',             // inert
    journalingEnabled: false,              // inert
    deadlockStrategy: 'ignore',            // inert: 'deadlock' is not enabled
    thrashingThreshold: 200,               // inert
    enabledSubsystems: ['process', 'scheduler', 'io'],
  };
}
```

`preemptive: true` is load-bearing and is the one setting the leg cannot survive losing. The DMA
objective requires at least three `context.switch` events to other pids inside the transfer
window, and a non-preemptive policy cannot produce them, which would make the leg's central
demonstration unobservable.

`agingInterval: 0` because nothing on this leg starves. The Bus has no starvation affliction, no
priority theme, and no aging remedy. If a Program crosses `starvationThreshold` here it is a
symptom of the storm rather than of the scheduler, and the debrief must not offer aging as a
remedy for it.

`enabledSubsystems` deliberately omits `storage`. The block device this leg attaches is a
generic block device reached through its driver, and no cylinder, seek or head position is
modelled anywhere in the leg. If WP-09 cannot construct a block driver without the `storage`
subsystem enabled, that is a coupling defect in WP-09: file it, enable `storage`, freeze
`diskPolicy` and `totalCylinders` at the values above, add an acceptance criterion that no
interaction and no command on this leg reads or writes either field, and report which you did.

### The device manifest, and how it reaches the kernel

`LegSetupContext` exposes `spawn`, `bind`, `declareResource` and `declareSync`, and nothing
else. There is no `declareDevice` and you may not add one. The device table is kernel state that
WP-09 owns and constructs.

The leg supplies its devices as a plain data manifest in `src/legs/the_bus/devices.ts`, exported
as a frozen array, and the leg runner hands it to the kernel at construction alongside
`KernelConfig`. **Agree that channel with WP-09 and WP-19 before you write a line of the stage.**
If neither offers a manifest channel, the fallback is a single `ioctl('attach_device', ...)` call
per device issued from `populate` through a spawned setup process, which is uglier and works;
take it only if the manifest channel is refused, and report which you used.

Do not model devices in leg-local state and draw them from there. The world must read the
kernel's device table, so that a mode change made from the terminal and a mode change made from
a port face produce the same picture through the same path.

---

## Population

```ts
export function populate(ctx: LegSetupContext): void {
  const roster: readonly [ConvoyMemberId, string, number, number, number, number][] = [
    // member,      name,      priority, burst, service, pages
    ['lumen',   'LUMEN',   2, 6, 60, 14],
    ['sable',   'SABLE',   2, 5, 54, 12],
    ['orrery',  'ORRERY',  3, 5, 54, 12],
    ['kestrel', 'KESTREL', 3, 4, 48, 10],   // halves every device latency while alive
    ['vesper',  'VESPER',  3, 5, 54, 12],
  ];
  roster.forEach(([member, name, priority, burst, service, pages], i) => {
    const pid = ctx.spawn({ name, priority, burst, service, arrival: i, pages });
    ctx.bind(member, pid);
  });

  // The three Programs that must be schedulable during the DMA transfer window.
  // Their service is long enough to span the window and their arrival is before it opens.
  for (let i = 0; i < 3; i++) {
    ctx.spawn({ name: `bus.worker_${i}`, priority: 4, burst: 4, service: 400, arrival: 40 + i * 4, pages: 6 });
  }

  // The manifest port's client. It is the Program that polls, and it is the one whose
  // useful-work utilisation the first objective reads.
  ctx.spawn({ name: 'bus.manifest_client', priority: 4, burst: 3, service: 300, arrival: 20, pages: 6 });

  // The network port's receivers. Six of them, so the arrival rate is a rate rather than a burst.
  for (let i = 0; i < 6; i++) {
    ctx.spawn({ name: `bus.receiver_${i}`, priority: 5, burst: 2, service: 260, arrival: 300 + i * 2, pages: 4 });
  }

  // The unknown-device port's caller. Its ProcessSpec must be identical under both attachments.
  ctx.spawn({ name: 'bus.attach_client', priority: 4, burst: 3, service: 180, arrival: 560, pages: 5 });
}
```

No `declareResource` and no `declareSync`. The Bus owns none of the nine critical section
crossings; leg 11 and leg 12 own the last two. Do not add one here and do not call WP-19's
crossing system from this leg.

### The devices, and their opening state

```ts
export const busDevices = [
  { id: 'dev.manifest', kind: 'block',     latency: 20, mode: 'polling',   bytes: 4096,  buffer: 'single' },
  { id: 'dev.vault',    kind: 'block',     latency: 12, mode: 'interrupt', bytes: 65536, buffer: 'double' },
  { id: 'dev.net0',     kind: 'network',   latency: 1,  mode: 'polling',   bytes: 64,    buffer: 'circular' },
  { id: 'dev.console',  kind: 'character', latency: 1,  mode: 'interrupt', bytes: 64,    buffer: 'single' },
  { id: 'dev.unknown',  kind: null,        latency: 6,  mode: 'polling',   bytes: 1024,  buffer: 'single' },
] as const;
```

`dev.unknown` has no kind until the player attaches it. It is physically a stream: bytes arrive
in order, there is no position to seek to, and a seek on it is meaningless. Attaching it as a
block device succeeds and gives the caller a seek that returns success and moves nothing.

`wordSize` is 64 on every device, matching fixture `IO-COST-1`, so `transferTicks = bytes / 64`
throughout.

### The cost model, verbatim from the sim spec

These are §11.1's formulas. Every number on a port face is computed from them and the player can
check any of them by hand.

```
polling    charged to the requester:  1 + (effectiveLatency - 1) + transferTicks
           requester does not block; nothing else runs while it spins

interrupt  charged to the requester:  1
           charged to the kernel:     interruptServiceTicks + transferTicks
           requester blocks; other Programs run

dma        charged to the requester:  2
           charged to the kernel:     interruptServiceTicks
           charged to whoever runs:   dmaCycleStealRatio * transferTicks
           requester blocks; other Programs run, at reduced rate
```

`interruptServiceTicks = 2`, `dmaCycleStealRatio = 0.1`, `maxInterruptsPerTick = 2`,
`interruptStormThreshold = 32`, `interruptStormWindow = 10`. All five come from §11.1 through
§11.3 and none of them is a leg setting.

### The three route strategies, priced per device

This table is the leg. It is drawn on the port faces, it is what `iomode --compare` prints, and
it is what the acceptance criteria assert. Every row is `1 + (L-1) + T`, `1 + 2 + T` and
`2 + 2 + 0.1T`, evaluated. `L` is effective latency with KESTREL alive.

| Device | L | T | polling | interrupt | dma | Correct mode | Why |
|---|---|---|---|---|---|---|---|
| `dev.manifest` | 10 | 64 | **83** | 67 | 10 | interrupt | DMA is cheaper still, and this port has no DMA controller. The choice offered is polling against interrupt. |
| `dev.vault` | 6 | 1024 | 1029 | 1027 | **106** | dma | The transfer dominates. Only DMA takes the copy off the processor. |
| `dev.console` | 1 | 1 | **2** | 4 | 4 | polling | The wait is shorter than the interrupt entry cost. Polling wins by exactly 2x. |
| `dev.net0` | 1 | 1 | see below | see below | n/a | polling or coalesced | The answer depends on the arrival rate, not on the per-request cost. |

**The console row is the quiet one and it must be reachable.** A device whose latency is 1 costs
2 ticks polled and 4 ticks interrupt-driven, so polling is exactly half the cost, on a device
where every instinct the player has just built says to use interrupts. Do not hide this port and
do not price it so that the difference is a rounding artefact. Two against four is the whole
point and it must read at a glance on the port face.

**The manifest row without KESTREL** is `L = 20`, so polling is `1 + 19 + 64 = 84` and interrupt
is still 67, exactly fixture `IO-COST-1`. The ratio widens from 1.24 to 1.25 and the absolute
waste per request goes from 9 ticks to 19. Ten requests: 830 against 670 with KESTREL, 840
against 670 without.

### The network port and the storm

`dev.net0` receives at **9 packets per tick** while the burst is active. That is 900 arrivals
per 100 ticks, which is the number the curriculum map's misconception text and the `io_timeout`
epitaph both name, so it is fixed.

The handler admits **40 deliveries per 100 ticks**. Each delivery costs
`interruptServiceTicks + transferTicks = 2 + 1 = 3` kernel ticks, and the kernel's interrupt
budget for the leg is 120 ticks per 100, which is the point at which stage 1 fires. Forty
deliveries at three ticks each is the ceiling.

The coalescing dial offers **1, 4, 8, 16, 32, 64**. The resulting rates:

| `--coalesce n` | Interrupts per 100 ticks | Under 40? | Added latency per packet |
|---|---|---|---|
| 1 | 900 | no | 0 |
| 4 | 225 | no | 1.5 ticks |
| 8 | 112.5 | no | 3.5 ticks |
| 16 | 56.25 | **no** | 7.5 ticks |
| 32 | 28.125 | yes | 15.5 ticks |
| 64 | 14.06 | yes | 31.5 ticks |
| polling, batched | 0 | yes | up to the poll interval |

**Sixteen is not enough and that is deliberate.** The ambient event `bus.coalesced_interrupts`
narrates a controller configured for batches of sixteen, and it is a different controller on a
different port. A player who reads that event as a hint and dials 16 on `dev.net0` gets 56 per
100, watches the storm continue, and has to reason from `irq --rate` rather than from the
narration. Do not soften this by lowering the arrival rate and do not raise the event's number to
match. Report that you left it as specified.

Both remedies the objective names must pass: `--coalesce 32` gives 28.125, and moving the port
to polling gives 0. Polling costs a fixed poll tax for the rest of the leg, which is the second
misleading remedy the narrative bible describes, and the debrief shows both curves.

### The DMA transfer window

`dev.vault` moves 65,536 bytes at `wordSize` 64, so `transferTicks = 1024`. Under DMA the
processor is charged 2 to program the controller, 2 for the completion interrupt, and
`0.1 * 1024 = 102.4` ticks of stolen memory cycles spread across whoever is running.

The window is **1024 ticks wide**. `obj.the_bus.dma_offload` requires at least three distinct
`context.switch` events to other pids inside it. With `rr` at any pace's quantum and three
`bus.worker_*` Programs whose service spans the window, that is comfortably satisfied, and it is
satisfied only because the transfer is on DMA. Under interrupt mode the kernel is copying for
1024 ticks and no worker advances, which the test must assert as the negative case.

The three workers' measured service rate inside the window is **10 percent below** their rate
outside it, and `devstat` attributes the difference to bus contention on `dev.vault`.

### Known-correct numbers

Take these from the sim spec's fixtures so the leg is verifiable.

`IO-COST-1`: 10 requests of 4096 bytes, latency 20, wordSize 64. Polling 840 CPU ticks,
interrupt 670, DMA 100. This is `dev.manifest` with KESTREL dead and it is the leg's reference
row. With KESTREL alive the polling figure is 830 and the other two are unchanged, because
KESTREL's passive touches latency and latency appears only in the polling term.

`IO-POLL-1`: one request on a polled device emits `io.poll_wasted { wastedTicks: 19 }` and
`cpuUtilisation` reads near 1.0 with zero process progress. With KESTREL alive the same request
emits `wastedTicks: 9`. Both must be produced and both must be asserted.

`IO-INT-1`: two lines pending at priorities 0 and 2. The priority-0 line is delivered first and
the priority-2 line is deferred while the first is in service. Map the lines so that
`dev.vault` is priority 0 and `dev.net0` is priority 2, which is what makes the storm starve the
vault's completion rather than the other way round.

`IO-STORM-1`: 5 interrupts per tick against `maxInterruptsPerTick` 2, for 10 ticks. The storm
condition fires; at `2 * window` the line is masked and the device drops to polling. The leg
runs at 9 per tick rather than 5, so the condition fires sooner; assert the fixture at 5 and the
leg's own onset at 9 separately.

`IO-BUF-1`: single against double buffering at matched rates. Double-buffered throughput is
within 5 percent of 2x the single-buffered figure. `dev.manifest` opens on `single` and the
player raises it.

`IO-SPOOL-1`: two processes writing the printer without spooling produce
`fs.corruption { recoverable: false }` on the output. **This leg does not run that fixture.**
`fs` is disabled and the spooler appears only in the ambient event `bus.spooler_jam`, as
flavour, with no file system behind it. Do not implement spooling here.

**The copy count.** `dev.manifest` opens with a driver that adds a bounce buffer, so
`devstat --copies` reads **3** per transfer. Removing the bounce buffer, which is the
`bus.set_copies` interaction, brings it to **2**. `obj.the_bus.buffer_sizing` requires at most 2
and zero producer stalls, so the player must do both: raise the buffer from `single` to `double`
and remove the extra copy. Freeze both numbers.

**Two document disagreements, both resolved here.**

The curriculum map's failure mode text gives `interrupt_storm` as 3.5 integrity per travel tick,
fatal after 20. The narrative bible's affliction table and its `interrupt_storm` entry give 1.1
per tick, fatal after 110, with bandwidth draining 0.5 per tick. **Follow the narrative bible.**
It is the affliction and economy source of truth, its numbers are internally consistent with the
other twelve afflictions and with the leg's 80-tick designed length, and 20 ticks to fatal on an
80-tick leg leaves no window in which to act. Report the disagreement.

The curriculum map's DMA misconception says the co-scheduled Programs run about 20 percent
slower. The sim spec's `dmaCycleStealRatio` is 0.1, which produces 10 percent. **Follow the sim
spec.** The ratio is a simulator parameter that the cost table depends on, and changing it to
0.2 would move `dev.vault`'s DMA cost from 106 to 208. The codex text, the `devstat` output and
the debrief all say 10 percent. Report the disagreement.

### The foreshadowing plant

Once, in ambient text, not underlined, not repeated: **an interrupt arrives from a device id
that is not in the device table.** Put it on the interrupt controller readout at
`anchor.irq_board` as a line item with a device id that resolves to nothing, at a fixed tick, on
every run. Nobody remarks on it. `irq --handlers` lists it with an empty handler name. It is not
interactive, it is not an objective, and it must not be the storm's device.

---

## Stage

**Form.** A long trench with device bollards on both sides.
**Accent.** `AMBER.core` for interrupts, `CYAN.core` for DMA.
**Environment.** A trench the convoy travels along, several hundred metres of it, with
bollards at 4.00 m intervals. Polling is drawn as the convoy stopping at each bollard to
check it. Interrupts are drawn as the bollard firing a spike upward when it has something.
DMA is a beam that bypasses the convoy entirely and goes straight to the memory vault at the
far end.
**Hero visual.** The interrupt storm. Bollards begin firing faster than the convoy can
advance, the trench strobes amber at a rate that climbs with the interrupt rate, and the
convoy's forward motion visibly stalls because every stele is switching to the handler
instead of running. Coalescing interrupts is visible as the bollards batching their spikes.

| Anchor id | Structure | Focus camera target |
|---|---|---|
| `anchor.trench` | The causeway seen along its length, bollards receding | wide establishing; the storm hero shot frames from here |
| `anchor.causeway` | Where the convoy runs | the convoy's own space; not a lock target |
| `anchor.port.manifest` | The slow block port, its mode, its latency, and the three computed costs | head-on orthographic; all three costs legible in one frame |
| `anchor.port.vault` | The bulk port and the beam to the memory vault | head-on; the beam's endpoint must be visible from here |
| `anchor.port.net0` | The network port, with its arrival rate and its interrupt rate as two separate readouts | head-on orthographic; **both rates legible at once** |
| `anchor.port.console` | The character port, latency 1, with polling priced at 2 and interrupt at 4 | head-on; the 2 against 4 must read without a focus lock |
| `anchor.port.unknown` | The unattached port, with no kind and no driver | head-on |
| `anchor.memory_vault` | The DMA destination at the far end of the trench | included in the vault port framing |
| `anchor.irq_board` | The interrupt controller: lines, priorities, pending counts, mask state, handler names | head-on orthographic; every line and its pending count legible |
| `anchor.coalesce_dial` | 1, 4, 8, 16, 32, 64, with the resulting rate beside each | head-on; the dial and the six resulting rates in one frame |
| `anchor.buffer_bay` | Per-device buffer scheme, occupancy column, stall count and copy count | head-on orthographic; occupancy drawn as a filling column |
| `anchor.request_post` | Blocking against asynchronous, per issued request | head-on |
| `anchor.attach_bench` | Block, character, network, with what each promises | head-on orthographic; all three interfaces and their promises in one frame |
| `anchor.convoy.<member>` | Per-Program stele | head-on |

There is no `anchor.depot` on this leg. Leg 10 has no depot and the world must not contain a
depot housing, a request queue on the ground, or the depot's ambient line.

### Two hard stage requirements

**The storm's strobe rate is driven by the measured interrupt rate, per frame, and by nothing
else.** Not by a timer, not by an animation curve, not by a scripted ramp. The bollards fire when
a line is delivered and the trench brightness is a function of `totalPending`. A player who
coalesces at 32 must see the strobe rate fall in the same frame the rate readout falls, because
the claim the leg is making is that these are the same number. If the visual and the readout can
disagree, the leg teaches nothing.

**The convoy's forward motion stalls because the steles are in the handler, and the stall is
drawn on the steles rather than on the convoy.** Each stele switching to the handler is a context
switch and gets the context switch treatment from the visual bible's section 8.3. The forward
motion stopping is the consequence of every stele being in a handler, and the player must be
able to see which stele is where. A convoy that simply slows down reads as a speed penalty and
teaches the wrong thing.

---

## Interactions

```ts
export const interactions: readonly InteractionDef[] = [
  {
    id: 'bus.set_mode',
    label: 'Set the transfer mode',
    description: 'Polling, interrupt-driven, or direct memory access. The port face prices all three.',
    anchor: 'anchor.port.manifest',
    cost: { bandwidth: 2 },
    enabledWhen: (run) => run.resources.bandwidth >= 2,
  },
  {
    id: 'bus.set_mode_vault',
    label: 'Set the bulk port transfer mode',
    description: 'The transfer is a thousand ticks of copying. Decide who does the copying.',
    anchor: 'anchor.port.vault',
    cost: { bandwidth: 2 },
    enabledWhen: (run) => run.resources.bandwidth >= 2,
  },
  {
    id: 'bus.set_mode_net',
    label: 'Set the network port transfer mode',
    description: 'Nine arrivals per tick. Price the mode against the rate rather than against the request.',
    anchor: 'anchor.port.net0',
    cost: { bandwidth: 2 },
    enabledWhen: (run) => run.resources.bandwidth >= 2,
  },
  {
    id: 'bus.set_mode_console',
    label: 'Set the character port transfer mode',
    description: 'Latency one. The wait is shorter than the cost of being told about it.',
    anchor: 'anchor.port.console',
    cost: { bandwidth: 2 },
    enabledWhen: (run) => run.resources.bandwidth >= 2,
  },
  {
    id: 'bus.set_coalescing',
    label: 'Set coalescing',
    description: 'One interrupt per n events. Trades latency per event for overhead per event.',
    anchor: 'anchor.coalesce_dial',
    cost: { cycles: 6 },
    enabledWhen: (run) => run.resources.cycles >= 6,
  },
  {
    id: 'bus.set_buffer_scheme',
    label: 'Set the buffer scheme',
    description: 'One buffer, two, or a ring. One serialises producer and consumer completely.',
    anchor: 'anchor.buffer_bay',
    cost: { blocks: 4 },
    enabledWhen: (run) => run.resources.blocks >= 4,
  },
  {
    id: 'bus.set_copies',
    label: 'Remove the extra copy',
    description: 'The driver is buffering something the kernel already buffered. Two copies is normal, three is a layer doing work twice.',
    anchor: 'anchor.buffer_bay',
    cost: { cycles: 8 },
    enabledWhen: (run) => run.resources.cycles >= 8,
  },
  {
    id: 'bus.set_request_mode',
    label: 'Set blocking or asynchronous',
    description: 'Per request. Block when the next instruction needs the data. Do not block when it does not.',
    anchor: 'anchor.request_post',
    cost: {},
    enabledWhen: () => true,
  },
  {
    id: 'bus.attach_device',
    label: 'Attach the unknown device',
    description: 'Block, character, or network. The wrong choice attaches successfully and behaves wrongly.',
    anchor: 'anchor.attach_bench',
    cost: { cycles: 10 },
    enabledWhen: (run) => run.resources.cycles >= 10,
  },
  {
    id: 'bus.detach_device',
    label: 'Detach and reattach',
    description: 'The same device, through a different interface, with no Program changed.',
    anchor: 'anchor.attach_bench',
    cost: { cycles: 6 },
    enabledWhen: (run) => run.resources.cycles >= 6,
  },
];
```

`bus.detach_device` exists so the third misconception's substitution can be performed twice on
one run. It is the only reason it exists and its cost is set low enough that a player who has
seen the block attachment behave oddly can afford to try the other one.

---

## Terminal commands

Three commands, copied verbatim from the curriculum map into `src/legs/the_bus/commands.ts`:
`iomode`, `irq`, `devstat`. The full `manual` text is in `docs/05-CURRICULUM-MAP.md`, "Leg 10.
THE BUS". Copy byte for byte.

Load-bearing lines:

- `iomode`: "The usual summary is that interrupts beat polling, and that is true for the case
  everyone has in mind: a slow device with occasional events. Invert the case and the answer
  inverts." This is the leg's thesis and both misconception breaks are instrumented against it.
- `iomode`: "So the rule is about rates rather than about mechanisms: interrupt when events are
  rarer than the handler cost, poll when they are more frequent." The player must be able to
  apply this literally, from `irq --rate` and the handler cost on the port face.
- `iomode --attach`: "Attaching a stream as a block device succeeds and gives you a seek that
  silently does nothing." The implementation must match that sentence exactly. The seek returns
  success. It moves nothing. Nothing is logged.
- `irq`: "The utilisation meter reads near 100 percent, which is why this failure is often
  mistaken for healthy load."
- `devstat`: "A write that returned successfully has not necessarily reached the device, and a
  power loss between the return and the flush loses it. Anything that must be durable has to say
  so; see sync and the journal." This is the forward reference to leg 11 and it is the sentence
  the Archive's crash pays off.
- `devstat --copies`: "Two is normal, one is good, and more than two usually means a layer is
  buffering something that was already buffered."

`iomode --compare` is not in the curriculum map's usage string and must not be added to it. If
the port faces need a side-by-side comparison, it is a world structure at `anchor.port.*` and a
`--compare` flag on nothing. The three commands ship with exactly the flags the map gives them.

Every `See also:` must resolve. `iomode` sees `irq`, `devstat` and `codex io_methods`. `irq`
sees `iomode`, `top` and `codex interrupt_storm`; `top` is an earlier leg's command and must
still be registered. `devstat` sees `iomode`, `irq`, `iostat` and `codex io_buffering`;
`iostat` is an earlier leg's command. `devstat` also names `sync` and the journal in prose, and
neither is a `See also:` target on this leg, so neither needs to resolve yet.

---

## Event table

Copied verbatim from `04-NARRATIVE-BIBLE.md` section 8, leg 10. Weights sum to 100.

```ts
export const busEvents: readonly RandomEventDef[] = [
  {
    id: 'bus.interrupt_storm',
    weight: 14,
    title: 'One Per Byte',
    narration: 'A controller on the near side raises an interrupt for every byte it transfers, and every one of them is legitimate. The handler runs eight ticks and is entered again before it finishes returning.',
    targets: 'courier', inflicts: 'interrupt_storm',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'bus.polling_tax',
    weight: 13,
    title: 'Still Not Ready',
    narration: 'The convoy checks the status register in a loop and it reads not-ready four thousand times before it reads ready. Every check was a real cycle.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -65 },
    onlyIf: null,
  },
  {
    id: 'bus.driver_mismatch',
    weight: 12,
    title: 'Wrong Driver',
    narration: 'The device answers to a driver written for a revision it is not. Most operations work, which is worse than none of them working.',
    targets: null, inflicts: null,
    resourceDelta: { bandwidth: -12, blocks: -10 },
    onlyIf: null,
  },
  {
    id: 'bus.spooler_jam',
    weight: 11,
    title: 'Spool Full',
    narration: 'The spool that lets a slow device pretend to be fast is full, and the pretence stops. Everything behind it now runs at the device\'s actual speed.',
    targets: null, inflicts: null,
    resourceDelta: { blocks: -18, cycles: -30 },
    onlyIf: null,
  },
  {
    id: 'bus.device_reset',
    weight: 11,
    title: 'Reset',
    narration: 'A device stops answering and has to be taken down and brought back, and everything queued against it is lost. It comes back cleanly, which is the only good part.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -45, bandwidth: -6 },
    onlyIf: null,
  },
  {
    id: 'bus.dma_window',
    weight: 16,
    title: 'Transfer Window',
    narration: 'A controller with direct access to memory takes the whole transfer and raises one interrupt at the end of it. The processor does something useful for the entire duration.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 70, bandwidth: 12 },
    onlyIf: null,
  },
  {
    id: 'bus.double_buffer',
    weight: 12,
    title: 'Double Buffered',
    narration: 'A pair of buffers here lets the convoy fill one while the device drains the other, and neither side ever waits for the other. It costs two buffers and saves the leg.',
    targets: null, inflicts: null,
    resourceDelta: { bandwidth: 14, quota: 30 },
    onlyIf: null,
  },
  {
    id: 'bus.coalesced_interrupts',
    weight: 11,
    title: 'Coalesced',
    narration: 'The controller is configured to hold interrupts and deliver them in batches of sixteen. The latency rises slightly and the handler overhead falls through the floor.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 50, bandwidth: 8 },
    onlyIf: null,
  },
];
```

`bus.interrupt_storm` is `targets: 'courier'`, which is KESTREL. That is the leg's central
tension expressed in the event deck and it is why the ambient storm and the scripted storm are
two different things. The ambient event inflicts the affliction on KESTREL wherever the convoy
is. The scripted storm at `dev.net0` is a kernel state the player configures their way out of.
Both must be reachable in one run and they must not be merged.

`bus.coalesced_interrupts` names batches of sixteen and describes a controller that is not
`dev.net0`. See the network port table for why that number must stay at sixteen even though
sixteen is not enough on the storm port.

---

## Evaluation

### Survival

The leg is survived when at least one convoy Program is alive at leg end.

**The polling tax** is the quiet failure and it kills nobody. A port left on polling drains
cycles at `effectiveLatency - 1` per request for the whole leg. On `dev.manifest` with KESTREL
dead that is 19 wasted ticks per request against a leg budget of 380 cycles, and a player who
never touches the port face arrives at the Archive short. Nothing warns them. `top` separates
`poll%` from `user%` and the separation is the only signal.

**The interrupt storm** is the failure worth building for and it runs the sim spec's four
escalation stages without the leg intervening:

| Stage | Condition | What happens | What the player sees |
|---|---|---|---|
| 1 | `totalPending > 32` for 10 consecutive ticks | `io.interrupt` with `pid: null`; the `interrupt_storm` affliction is raised on the convoy | the trench strobe rate climbs; `irq --rate` reads 900 per 100 |
| 2 | holds for 20 ticks | the kernel masks the line and drops `dev.net0` to polling on its own | the bollards stop firing; throughput recovers; the player did nothing |
| 3 | holds for 40 ticks | the Program generating the requests terminates with `TerminationReason: 'io_timeout'` | a derezz |
| 4 | `pending` reaches `maxPending` | `kernel.panic { message: 'interrupt storm on dev.net0' }` | the panic treatment from the visual bible's section 4.6 |

Stage 2 is the one the player must be allowed to watch happen. The kernel rescuing itself by
masking the line and dropping to polling is the standard mitigation and it is the leg's argument
made by the system rather than by a man page. Do not pre-empt it with a warning, do not give the
player a prompt, and do not make the leg unwinnable if they let it run.

The affliction is **1.1 integrity per tick**, fatal after **110 ticks**, terminating with
`'io_timeout'`, with bandwidth draining **0.5 per tick** while active. It lands on the Program
bound to the device, which is KESTREL by default. The true remedy is moving the device to DMA;
on `dev.net0` that is unavailable, because a network port has no DMA controller in this leg, so
the two remedies the objective names are the two available: coalesce, or poll. The misleading
remedy is buying bandwidth, which the narrative bible prices at ten ticks of relief for 33
cycles, and the depot that would sell it is two legs back.

**The wrong attachment** kills nobody here. It produces a character device treated as a block
device, so seeks silently do nothing and `bus.attach_client` reads the wrong bytes. Nothing
errors. The consequence surfaces in the Archive as `fs.corruption`, and the hand-off below is
how it gets there.

**The buffer failure** is quieter still: an undersized buffer stalls the producer on every
transfer, costs bandwidth throughout the leg, and kills nobody. `devstat` shows `bufferStalls`
climbing and `bufferOccupancy` pinned at capacity.

### Objectives

| Objective | Computed from |
|---|---|
| `obj.the_bus.polling_to_interrupt` | Sum `wastedTicks` across `io.poll_wasted`; require the ratio to processor time to pass 0.15 before the mode change and useful-work utilisation, measured as `user%` from `top`, to rise by at least 12 points across the change. Both halves, and the rise must be measured against the 100 ticks before the change. |
| `obj.the_bus.clear_interrupt_storm` | Count `io.interrupt` events on `dev.net0` per 100 ticks over the 200 ticks after the remedy. Require under 40. Require the `interrupt_storm` affliction to be cleared rather than expired. |
| `obj.the_bus.dma_offload` | An `io.dma_transfer` event on `dev.vault` with at least three distinct `context.switch` events to other pids inside the transfer window, where the window runs from the `io.request` to the `io.dma_transfer`. Three distinct pids, not three switches. |
| `obj.the_bus.buffer_sizing` | Zero `bufferStalls` on `dev.manifest` across the segment **and** at most two copy operations per transfer in the device trace. Both. |
| `obj.the_bus.blocking_choice` | The `bus.set_request_mode` decision records: the manifest log write asynchronous, the route configuration read blocking. Read from `RunState.decisions`, not from the event stream. |
| `obj.the_bus.driver_absorbs_difference` | An `iomode --attach` invocation followed by a completed transfer through the attached device, with every `ProcessSpec` byte-identical to its value before the attach. Compare the specs; do not trust that nothing edited them. |

`obj.the_bus.polling_to_interrupt` has a trap in it worth stating. If the player moves the port
to interrupt before the poll-wasted ratio has passed 0.15, the objective is not met even though
the decision was correct, because the objective is written to require the measurement first.
That is deliberate: the leg is teaching the player to read the number before acting, and the
codex entry states it. Do not relax it, and make sure `top` is prominent enough at
`anchor.port.manifest` that the ratio is discoverable before the instinct fires.

### Debrief card

```ts
{
  headline: /* 'The Bus held.' or 'Nine hundred per hundred.' */,
  whatHappened:
    `The manifest port ran ${manifestMode} for ${manifestTicks} ticks and wasted ` +
    `${wastedTicks} of them. The network port peaked at ${peakRate} interrupts per 100 ticks ` +
    `and was ${stormRemedy}. The bulk transfer ran ${vaultMode} with ${switchCount} other ` +
    `Programs scheduled inside the window. The unknown device was attached as ` +
    `${attachKind}.`,
  whyItHappened: /* selected */,
  counterfactual: /* computed */,
  chapter: { chapter: 12, title: 'I/O Systems', sections: ['12.2.2', '12.2.3'] },
}
```

Counterfactual, in priority order:

1. **KESTREL was dead at leg entry.** `"Every device on this leg ran at full latency because
   KESTREL was not here to halve it. The manifest port wasted ${wasted} ticks against the
   ${halved} it would have wasted, and the storm arrived at tick ${early} instead of
   ${late}."` This outranks everything else, because it is the only line that explains a leg
   that went badly for a reason the player could not fix on this leg. Name the mechanism and the
   tick, and do not moralise about the death.
2. **A Program died to the storm.** `"The port raised ${peakRate} interrupts in 100 ticks
   against a handler that admits 40. One interrupt per ${n} events brings it to ${rate}, and the
   latency you pay for it is ${added} ticks per event."` Give the dial value that would have
   worked, and give the latency it costs, because the trade is the lesson.
3. **The storm was cleared by polling and the poll tax then dominated.** `"Polling stopped the
   storm and replaced it with ${tax} wasted ticks over the remaining ${ticks}. Coalescing at
   ${n} would have cost ${added} ticks of latency per event and nothing else."` Both curves, both
   named.
4. **The bulk transfer ran on interrupt or polling.** `"The transfer was ${t} ticks of copying
   and the processor did every tick of it. On DMA the processor pays ${dma} and the ${count}
   other Programs run at ${slowdown} percent of their usual rate for the duration."`
5. **The manifest port never left polling.** `"The port wasted ${wasted} ticks, which is
   ${percent} percent of the leg's processor time, on a device whose interrupt cost is ${cost}
   ticks per request."`
6. **The unknown device was attached as a block device and it is a stream.** `"Every seek
   returned success and moved nothing. The bytes the convoy read are not the bytes it asked
   for, and nothing on this leg will tell you that."` Do not say what happens next. Leg 11
   says it.
7. `null`.

### The forward hand-off

`LegOutcome` must carry the attachment kind to the Archive. Agree the field with WP-17; the
natural home is a `DecisionRecord` with `kind: 'device_attach'` and `choice` set to `'block'`,
`'character'` or `'network'`, which needs no contract change and is readable by leg 11 from
`RunState.decisions`. Use that unless WP-17 offers something better.

Leg 11 reads it and, when the choice was `'block'` on a stream device, opens with one inode
whose contents are wrong, producing `fs.corruption` from a cause set two legs earlier. **You do
not implement that. You record the choice and stop.** Do not emit `fs.corruption` from this
leg, do not enable `fs`, and do not describe the Archive's consequence in any copy this leg
ships.

Record the choice on every path, including the path where the player attaches correctly, so that
leg 11 can distinguish "attached as a character device" from "never attached".

---

## Acceptance criteria

1. `src/legs/the_bus/index.ts` satisfies `Leg` under `tsc --strict`, `id === 'the_bus'`,
   `index === 10`.
2. The leg runs headlessly to completion via the WP-20 smoke-test runner, at all four paces
   and all four difficulty tiers, with and without KESTREL alive at entry.
3. `enabledSubsystems` deep-equals `['process', 'scheduler', 'io']` and
   `schedulerParams.preemptive === true`.
4. Inert-field independence over 400 ticks: changing `diskPolicy`, `totalCylinders`,
   `raidLevel`, `fileAllocation`, `journalingEnabled`, `deadlockStrategy`, `thrashingThreshold`,
   `totalFrames`, `pageSize`, `replacementPolicy`, `allocationStrategy` or `tlbEntries` produces
   a byte-identical event log.
5. Every objective can be met by the known-good decision sequence; all six met in one run.
6. `IO-COST-1` reproduces exactly: 840 / 670 / 100 CPU ticks for 10 requests of 4096 bytes at
   latency 20 and wordSize 64. With KESTREL alive the polling figure is 830 and the other two
   are unchanged.
7. The three-mode cost table in Population is reproduced by the sim for all four priced devices,
   every cell, to the tick. Asserted cell by cell, not as a total.
8. `dev.console` costs exactly 2 ticks polled and exactly 4 ticks interrupt-driven per request,
   and the ratio is exactly 0.5.
9. `dev.net0` at 9 arrivals per tick produces exactly 900 `io.interrupt` events per 100 ticks
   uncoalesced. The six coalescing values produce 900, 225, 112.5, 56.25, 28.125 and 14.0625 per
   100 ticks, each within 1 percent. Coalescing at 16 does **not** satisfy
   `obj.the_bus.clear_interrupt_storm` and coalescing at 32 does.
10. The storm runs all four escalation stages when the player does not act, in order, at ticks
    that are stable across two runs and a snapshot-restore. Stage 2 masks the line and drops the
    device to polling with no player action.
11. The `interrupt_storm` affliction drains 1.1 integrity and 0.5 bandwidth per tick and is
    fatal after 110 ticks with `TerminationReason: 'io_timeout'`.
12. Under DMA on `dev.vault`, at least three distinct pids are scheduled inside the 1024-tick
    window, and the three `bus.worker_*` Programs' measured service rate inside the window is
    10 percent below their rate outside it, to within one tick of rounding. Under interrupt mode
    on the same device, zero other Programs advance inside the window.
13. `devstat --copies` reads 3 on `dev.manifest` at leg open and 2 after `bus.set_copies`.
    `bufferStalls` is non-zero under `single` and zero under `double` at matched rates, per
    `IO-BUF-1`.
14. Attaching `dev.unknown` as a block device succeeds, a seek on it returns success and changes
    no position, and no event, warning or log line is produced. Attaching it as a character
    device makes the seek return an error. Every `ProcessSpec` is byte-identical across both
    attachments.
15. The attachment kind is recorded in the leg outcome on every path, including the correct one
    and the never-attached one.
16. Event table weights sum to exactly 100; all ids unique.
17. All three terminal command `manual` strings match the curriculum map byte for byte, and
    every `See also:` target resolves.
18. Draw calls stay under 220 / 450 / 900 at the heaviest frame, which is the storm at peak with
    every bollard firing, the trench strobing, and the memory vault beam active.
19. The trench strobe rate is a pure function of the measured interrupt rate. Verified by
    driving the rate from a fixture and comparing the strobe parameter frame by frame.
20. The word "deadlock" appears in no player-visible string. The word "thrashing" appears in no
    player-visible string. The storm is a distinct pathology and the copy must not blur it into
    either.

---

## Tests you must write

All under `tests/legs/the_bus/`.

**`contract.test.ts`**: `Leg` conformance, exact ids, chapters (one entry, nineteen sections),
six objectives, every `ChapterRef` inside chapter 12 and no section outside the nineteen.

**`config.test.ts`**: `enabledSubsystems` exact; `preemptive === true`; `agingInterval === 0`;
inert-field independence across all eleven inert fields.

**`populate.test.ts`**: five convoy spawns plus eleven workload spawns, five binds, zero
`declareResource` calls, zero `declareSync` calls. The device manifest is five entries with the
exact ids, kinds, latencies, opening modes and buffer schemes given above.

**`cost.test.ts`**: the three-mode cost model.
- `IO-COST-1` exactly, at latency 20 and at latency 10.
- Every cell of the Population cost table, per device, per mode.
- `dev.console` at 2 against 4, asserted as an exact ratio.
- `io.poll_wasted` carries `wastedTicks: 19` at latency 20 and `9` at latency 10.

**`storm.test.ts`**: the network port.
- 9 arrivals per tick produces 900 interrupts per 100 ticks.
- All six coalescing values produce their tabled rates.
- Coalescing at 16 leaves the rate above 40 and the objective unmet; at 32 it is met.
- Moving the port to polling clears the storm and starts a measurable poll tax.
- All four escalation stages fire in order with no player action, at stable ticks.
- `IO-STORM-1` at 5 per tick, separately, as the fixture.

**`dma.test.ts`**: the transfer window.
- Three distinct pids scheduled inside a 1024-tick DMA window.
- Zero other Programs advancing inside the same transfer under interrupt mode.
- The 10 percent cycle-steal slowdown, measured inside against outside.
- `io.dma_transfer` fires exactly once per transfer.

**`buffer.test.ts`**: `IO-BUF-1` exactly; stalls non-zero under `single` and zero under `double`;
copies 3 then 2; the objective met only when both conditions hold.

**`attach.test.ts`**: the driver substitution.
- Block attach on a stream: seek returns success, position unchanged, no event emitted.
- Character attach on the same device: seek returns an error.
- `ProcessSpec` equality across both, asserted field by field.
- The attach kind recorded in the leg outcome on all three paths.

**`kestrel.test.ts`**: the passive and its absence.
- Every device's effective latency halved with KESTREL alive and full without.
- The with-and-without figures in The KESTREL problem table, every row.
- A mid-leg death recomputes in-flight request costs at the new latency rather than
  grandfathering them.
- The leg is completable without KESTREL on conservative pace and is not completable on
  reckless pace.

**`evaluate.test.ts`**: each of the six objectives, met and not met. In particular
`polling_to_interrupt` fails when the mode change precedes the measurement, and `buffer_sizing`
fails when either half holds alone.

**`golden.test.ts`**: the golden headless playthrough.
- Fixture: `seed: 0x4b54524c`, `discClass: 'shell'`, `difficulty: 'operator'`, steady pace,
  standard rations, five Programs alive, entering with the leg 9 golden closing ledger.
- Known-good sequence: read `top` and confirm the poll ratio above 0.15; set `dev.manifest` to
  interrupt; set `dev.vault` to DMA; raise `dev.manifest` to double buffering and remove the
  extra copy; on the storm warning, set `dev.net0` coalescing to 32; leave `dev.console` on
  polling; issue the manifest log write asynchronous and the route configuration read blocking;
  attach `dev.unknown` as a character device.
- Assert: all six objectives met, zero casualties, eight codex entries added, the storm cleared
  before stage 3, canonical event log hash matches the golden file, stable across two runs and a
  snapshot-restore.

**`badpath.test.ts`**: the known-bad sequence.
- Leave `dev.manifest` polling; move `dev.net0` to interrupt; leave `dev.vault` on interrupt;
  leave `single` buffering and three copies; move `dev.console` to interrupt; attach
  `dev.unknown` as a block device.
- Assert: the poll tax accumulates at 19 wasted ticks per request, the storm reaches stage 3,
  KESTREL takes `interrupt_storm` and dies with `io_timeout` after 110 ticks, the epitaph drawn
  is from the `io_timeout` set, no worker advances inside the vault transfer, the attach kind is
  recorded as `'block'`, and the counterfactual selected is case 2.

**`kestrel_dead.test.ts`**: the same known-good sequence with KESTREL absent at entry. Assert the
doubled tick and cycle figures, the earlier storm onset, the halved warning window, and that the
debrief's counterfactual is case 1 with both numbers in it.

**`manuals.test.ts`**: three manual strings against the curriculum map fixture; every
`See also:` resolves, including the backward references to `top` and `iostat`.

**`stage.test.ts`**: anchors resolve; interaction anchors resolve; no depot anchor exists; draw
calls under budget at each tier; the strobe rate is a pure function of the measured interrupt
rate across a driven fixture.

---

## Out of scope

- Do not touch any other leg. Do not import from `src/legs/*` other than your own directory.
- Do not modify `src/game/types.ts` or `src/kernel/types.ts`.
- Do not modify anything under `src/kernel`, `src/render`, `src/world`, `src/terminal`,
  `src/ui`, `src/audio`, `src/design`, `src/platform` or `src/app`. If the cost model, the
  interrupt controller or the storm detector is wrong, file it against WP-09 and stop.
- **Do not enable `storage`.** No cylinders, no seeks, no head position, no RAID. The block
  device is reached through its driver. If WP-09 forces the coupling, follow the escalation in
  the Kernel configuration section and report it.
- **Do not enable `fs`.** Spooling appears as flavour in one ambient event and has no file
  system behind it. `IO-SPOOL-1` is not this leg's fixture.
- Do not emit `fs.corruption` from this leg under any circumstance.
- Do not add a `declareDevice` to `LegSetupContext`.
- Do not model devices in leg-local state. The world reads the kernel's device table.
- Do not add `--compare` to `iomode`, `irq` or `devstat`. Ship exactly the flags the curriculum
  map's usage strings give.
- Do not change the network port's arrival rate from 9 per tick, and do not change the ambient
  event's batch of sixteen. The mismatch is the teaching.
- Do not warn the player before storm stage 2 and do not pre-empt the kernel's own masking.
- Do not give `dev.net0` a DMA controller. A network port with DMA removes the leg's reversal.
- Do not make the wrong attachment produce an error, a warning, or a log line. Silence is the
  teaching, exactly as it was at the Cistern's ring.
- Do not place a depot on this leg.
- Do not offer aging as a remedy for anything here.
- Do not use the word "deadlock" or the word "thrashing" in any player-visible string.

### Files this package owns exclusively

```
src/legs/the_bus/index.ts
src/legs/the_bus/chapters.ts
src/legs/the_bus/objectives.ts
src/legs/the_bus/config.ts
src/legs/the_bus/populate.ts
src/legs/the_bus/devices.ts
src/legs/the_bus/interactions.ts
src/legs/the_bus/commands.ts
src/legs/the_bus/events.ts
src/legs/the_bus/evaluate.ts
src/legs/the_bus/cost.ts
src/legs/the_bus/storm.ts
src/legs/the_bus/attach.ts
src/legs/the_bus/fixtures.ts
src/legs/the_bus/stage.ts
src/legs/the_bus/copy.ts
tests/legs/the_bus/**
```

No other package writes to these paths and this package writes to no others.

---

## Report back

1. The commit or branch, and the full `tests/legs/the_bus/` output.
2. The golden playthrough hash and the file it is checked in at.
3. The frozen fixtures, as a table: the three-mode cost for all four priced devices with KESTREL
   alive and dead; the six coalescing rates; the storm onset tick at each pace with KESTREL alive
   and dead; the four escalation stage ticks; the measured cycle-steal slowdown.
4. Every `IO-*` fixture result against its expected value.
5. **The device manifest channel as agreed with WP-09 and WP-19**, and confirmation that the
   leg does not construct devices in leg-local state. If you fell back to `ioctl('attach_device')`
   from a setup process, say so and say why the manifest channel was refused.
6. Whether `storage` had to be enabled for WP-09 to construct a block driver. If it did, the
   filed item against WP-09, the frozen `diskPolicy` and `totalCylinders`, and the test proving
   no interaction or command on this leg reads either.
7. The KESTREL tuning table as shipped, both columns, and confirmation that the leg is
   completable without him on conservative pace and is not on reckless pace.
8. The field carrying the attachment kind to leg 11, agreed with WP-17, and confirmation that
   it is recorded on all three paths.
9. Confirmation that both misconception moves are required by the known-good sequence: the
   manifest port off polling and the network port back to polling or coalesced.
10. The two document disagreements as resolved: the `interrupt_storm` drain and fatal figures
    from the narrative bible rather than the curriculum map, and `dmaCycleStealRatio` at 0.1
    rather than the curriculum map's 20 percent. State the numbers you shipped.
11. Draw calls at each of the three quality tiers at the heaviest frame, and the strobe-rate
    purity test result.
12. Confirmation that no file outside the owned list was created or modified, that `storage` and
    `fs` are off, and that the words "deadlock" and "thrashing" appear in no player-visible
    string in this leg.

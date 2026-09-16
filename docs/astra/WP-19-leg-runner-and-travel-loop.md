# WP-19: The leg runner, the travel loop and the crossing system

## Objective

When this package is done, a leg plays. `LegRunner` takes any object satisfying
the frozen `Leg` interface, builds its kernel, calls `populate`, advances the
convoy along the leg's segments while charging cycles and quota, ticks
afflictions, draws random events from the leg's own `eventTable`, runs critical
section crossings, depots and reclamation rounds, kills Programs when their
integrity reaches zero, calls `evaluate`, and applies the resulting `LegOutcome`
to `RunState`. Nothing in it is leg-specific and nothing in it is rendered.

This package is the gate on all fourteen leg packages. Every one of them assumes
the travel loop exists, that the crossing cost formulas are shared code they must
not reimplement, and that the pace and rations dials write through to real
`KernelConfig` values. A leg agent who finds themselves writing a travel loop has
been mis-scoped and should stop.

Every number in this package comes from `04-NARRATIVE-BIBLE.md`. None of them is
invented here and none of them is a balance decision you may take. Where the
narrative bible and the sim spec disagree, the narrative bible wins for the game
layer, and you report the disagreement.

## Prerequisites

WP-11, WP-17 and WP-18 complete and green.

Files that must already exist:

- `src/game/types.ts` (frozen)
- `src/kernel/types.ts` (frozen)
- `src/kernel/index.ts` exporting `createKernel`, with `snapshot()`, `restore()`
  and the full syscall table from WP-11
- `src/game/store/createStore.ts` and `src/game/store/runStore.ts` from WP-17
- `src/game/CommandBus.ts` from WP-17
- `src/game/scoring.ts` from WP-17
- `src/game/save.ts` and the checksum module from WP-17
- `src/game/replay/` from WP-18, in particular the replay request type the
  counterfactual slot is filled from

## Required reading

- `04-NARRATIVE-BIBLE.md` section 5 in full: 5.1 (what each resource is), 5.2
  (starting allocations and the difficulty factor), 5.3 (leg lengths and the
  steady-state cost formulas), 5.4 (the dividend and reclamation income), 5.5
  (the intended curve, which your tests reproduce), 5.6 (the underflow clause and
  the emergency preemption credit), 5.7 (the depot price function and both price
  tables)
- `04-NARRATIVE-BIBLE.md` section 6 in full: 6.1 (pace to quantum, with the
  six-column mapping table and the 80-segment worked example), 6.2 (rations to
  frames per Program, the quota-per-tick formula, and the degree of
  multiprogramming interaction)
- `04-NARRATIVE-BIBLE.md` section 7.1, the affliction summary table, for drain
  per tick and fatal-after values
- `04-NARRATIVE-BIBLE.md` section 10, the depot: what it sells, the repair rules,
  and the three one-time services
- `04-NARRATIVE-BIBLE.md` section 11, reclamation: 11.2 (the three phases), 11.4
  (the yield formulas), 11.5 (the time limits and the diminishing-return
  multipliers), 11.6 (how `externalFragmentation` generates the Verge)
- `04-NARRATIVE-BIBLE.md` section 12 in full: 12.1 (the contention function),
  12.2 (the four options with their cost and success formulas and their failure
  modes), 12.3 (the side-by-side table your tests assert), 12.4 (the crossing
  schedule)
- `04-NARRATIVE-BIBLE.md` section 13, difficulty tiers, for the resource factor
  and the tier factor
- `01-ARCHITECTURE.md` section 2, the game loop, in full. Your `preTick` and
  `postTick` run inside the fixed step described there and the ordering is not
  yours to change.
- `01-ARCHITECTURE.md` section 4.1 and 4.2, which name `LegRunner` and
  `RunDirector` as two of the three sanctioned mutators of `RunState`
- `01-ARCHITECTURE.md` section 10.5, which gives `LegSandbox` in full, including
  the neutral outcome you must ship verbatim
- `02-KERNEL-SIM-SPEC.md` section 6.6, the kernel's own rations table, so you can
  see it is a different table from the narrative bible's and report the split

## Files you will create

```
src/game/LegRunner.ts
src/game/RunDirector.ts
src/game/LegSandbox.ts
src/game/travel/TravelLoop.ts
src/game/travel/paceRations.ts
src/game/travel/segments.ts
src/game/travel/degree.ts
src/game/travel/ledger.ts
src/game/afflictions/table.ts
src/game/afflictions/AfflictionClock.ts
src/game/convoy/status.ts
src/game/convoy/derezz.ts
src/game/events/EventDeck.ts
src/game/crossing/contention.ts
src/game/crossing/options.ts
src/game/crossing/Crossing.ts
src/game/depot/prices.ts
src/game/depot/Depot.ts
src/game/reclamation/verge.ts
src/game/reclamation/scoring.ts
src/game/reclamation/Reclamation.ts
src/game/debrief.ts
tests/game/travel/paceRations.test.ts
tests/game/travel/travelLoop.test.ts
tests/game/travel/degree.test.ts
tests/game/afflictions.test.ts
tests/game/convoy.test.ts
tests/game/events/eventDeck.test.ts
tests/game/crossing/contention.test.ts
tests/game/crossing/options.test.ts
tests/game/depot/prices.test.ts
tests/game/reclamation/verge.test.ts
tests/game/reclamation/scoring.test.ts
tests/game/legRunner.test.ts
tests/game/legSandbox.test.ts
tests/game/economyCurve.test.ts
```

## Files you may modify

```
src/game/index.ts       (add the LegRunner, crossing, depot and reclamation exports)
src/app/loop.ts         (wire SimHost.fixedUpdate to RunDirector.preTick,
                         Kernel.step and RunDirector.postTick, in that order.
                         Nothing else in this file.)
```

Nothing else. Specifically, `src/game/store*`, `src/game/save*`,
`src/game/CommandBus.ts`, `src/game/scoring.ts` and everything under
`src/game/replay/` belong to WP-17 and WP-18. Read them, call them, do not edit
them.

## Frozen contracts

From `src/game/types.ts`. These may not be edited. If this package cannot be
completed without changing one, stop and report per the escalation procedure.

```ts
export interface Leg {
  readonly id: LegId;
  readonly index: number;
  readonly title: string;
  readonly subtitle: string;
  readonly chapters: readonly ChapterRef[];
  readonly objectives: readonly LearningObjective[];
  kernelConfig(run: RunState): KernelConfig;
  populate(ctx: LegSetupContext): void;
  createStage(ctx: StageContext): LegStage;
  readonly interactions: readonly InteractionDef[];
  readonly terminalCommands: readonly TerminalCommandDef[];
  readonly eventTable: readonly RandomEventDef[];
  evaluate(ctx: LegEvaluationContext): LegOutcome;
}

export interface LegSetupContext {
  readonly run: RunState;
  readonly rng: { next(): number; int(a: number, b: number): number };
  spawn(spec: ProcessSpec): Pid;
  bind(member: ConvoyMemberId, pid: Pid): void;
  declareResource(id: string, instances: number, preemptible: boolean): void;
  declareSync(id: string, kind: 'mutex' | 'semaphore' | 'monitor' | 'rwlock', capacity: number): void;
}

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
  readonly counterfactual: string | null;
  readonly chapter: ChapterRef;
}

export interface RandomEventDef {
  readonly id: string;
  readonly weight: number;
  readonly title: string;
  readonly narration: string;
  readonly targets: ConvoyRole | null;
  readonly inflicts: AfflictionId | null;
  readonly resourceDelta: Partial<ResourceLedger>;
  readonly onlyIf: ((run: RunState) => boolean) | null;
}

export interface TravelPolicy {
  pace: Pace;
  rations: Rations;
  degreeOfMultiprogramming: number;
}

export type Pace = 'conservative' | 'steady' | 'aggressive' | 'reckless';
export type Rations = 'generous' | 'standard' | 'lean' | 'starved';

export interface ResourceLedger {
  cycles: number;
  quota: number;
  blocks: number;
  bandwidth: number;
}

export interface Affliction {
  readonly id: AfflictionId;
  readonly displayName: string;
  readonly acquiredAtTick: Tick;
  readonly drainPerTick: number;
  readonly fatalAfter: number | null;
  readonly remedy: AfflictionRemedy;
}

export interface ConvoyMember {
  readonly id: ConvoyMemberId;
  readonly name: string;
  readonly role: ConvoyRole;
  pid: Pid | null;
  integrity: number;
  status: ConvoyStatus;
  epitaph: Epitaph | null;
  abilityCharges: number;
  afflictions: Affliction[];
}

export type ConvoyStatus = 'nominal' | 'degraded' | 'critical' | 'derezzed';

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
```

The kernel side you read and never edit:

```ts
export interface KernelSnapshot { /* WP-11 */ }
export type TerminationReason = /* frozen union, WP-02 */;
export type AfflictionId = /* frozen union, thirteen members */;
```

`AfflictionId`, `LegId`, `TerminationReason`, `SyscallName` and `Errno` are closed
unions. Do not invent a member of any of them.

## Specification

### 1. Where this package sits

The frame pipeline is architecture section 2.2 and it does not change. Inside the
fixed step, the order is:

```
CommandBus.drain()      // WP-17 owns the bus, you call drain
RunDirector.preTick()   // this package
Kernel.step()           // WP-11
RunDirector.postTick()  // this package
```

`RunDirector` owns the per-tick game-layer work. `LegRunner` owns the leg
boundary work and holds the `RunDirector` for the current leg. The split is:
anything that happens on every tick is a director concern, anything that happens
once at leg entry or leg exit is a runner concern.

`LegRunner` and `RunDirector` are two of the three sanctioned mutators of
`RunState` named in architecture section 4.2. Every write goes through
`runStore.mutate`, never by direct assignment, and
`tests/game/run-mutation.test.ts` from WP-17 will catch you if it does not.

### 2. `src/game/travel/segments.ts`

Leg length in segments, from narrative bible 5.3. The `Leg` interface carries no
length field and is frozen, so the table lives here and is the only place leg
length is defined.

```ts
export const LEG_SEGMENTS: Readonly<Record<LegId, number>> = {
  boot_sector: 0,
  fork_fields: 60,
  the_weave: 65,
  quantum_pass: 70,
  the_narrows: 75,
  the_cistern: 75,
  the_gridlock: 80,
  allocation_yards: 85,
  drowned_reach: 100,
  the_platters: 85,
  the_bus: 80,
  the_archive: 90,
  arbiter_wall: 85,
  the_portal: 70,
};
```

The narrative bible's table covers legs 1 to 13 and sums to 1020. The Boot Sector
is the requisition leg and has no travel phase, so it is 0 here and the travel
loop is skipped for it entirely. Report that reading.

Also export the depot schedule, from narrative bible 10.2, because the runner
decides when to offer a depot:

```ts
export const DEPOT_LEGS: readonly LegId[] = [
  'fork_fields', 'quantum_pass', 'the_cistern', 'allocation_yards',
  'the_platters', 'the_archive', 'arbiter_wall',
];
```

Seven depots. `drowned_reach` is not in that list and adding it is out of scope,
permanently, in this package and every other.

### 3. `src/game/travel/paceRations.ts`

The narrative bible 6.1 mapping table, verbatim. This is the table the task of
this package turns on and every column is load-bearing.

```ts
export interface PaceRow {
  /** SchedulerParams.quantum, in ticks. Ch. 5.3.3. */
  readonly quantum: number;
  readonly segmentsPerTick: number;
  readonly cyclesPerSegment: number;
  readonly quantumOverhead: number;
  readonly effectiveCyclesPerSegment: number;
  /** Multiplies the leg workload's arrival rate. This is where starvation comes from. */
  readonly workloadArrivalRate: number;
}

export const PACE_TABLE: Readonly<Record<Pace, PaceRow>> = {
  conservative: { quantum: 16, segmentsPerTick: 0.6, cyclesPerSegment: 1.4, quantumOverhead: 1.125, effectiveCyclesPerSegment: 1.575, workloadArrivalRate: 0.70 },
  steady:       { quantum: 8,  segmentsPerTick: 1.0, cyclesPerSegment: 2.0, quantumOverhead: 1.25,  effectiveCyclesPerSegment: 2.50,  workloadArrivalRate: 1.00 },
  aggressive:   { quantum: 4,  segmentsPerTick: 1.5, cyclesPerSegment: 3.0, quantumOverhead: 1.50,  effectiveCyclesPerSegment: 4.50,  workloadArrivalRate: 1.45 },
  reckless:     { quantum: 2,  segmentsPerTick: 2.1, cyclesPerSegment: 4.4, quantumOverhead: 2.00,  effectiveCyclesPerSegment: 8.80,  workloadArrivalRate: 2.00 },
};

/** The context switch cost made economic. Narrative bible 6.1. */
export function quantumOverhead(quantum: number): number {
  return 1 + 2 / quantum;
}
```

`quantumOverhead` must reproduce the fourth column exactly for the four quanta:
16 gives 1.125, 8 gives 1.25, 4 gives 1.5, 2 gives 2.0. The table stores the
value and the function derives it; a test asserts they agree, so a future edit to
one without the other fails loudly.

Rations, from narrative bible 6.2:

```ts
export interface RationsRow {
  /** Frames guaranteed to each living convoy Program. */
  readonly framesPerProgram: number;
  /** Integrity lost per travel tick by every living Program. */
  readonly integrityCostPerTick: number;
  /** Per-tick probability of the affliction roll, or 0. */
  readonly afflictionChancePerTick: number;
  readonly afflictionOnRoll: AfflictionId | null;
}

export const RATIONS_TABLE: Readonly<Record<Rations, RationsRow>> = {
  generous: { framesPerProgram: 4.0, integrityCostPerTick: 0,   afflictionChancePerTick: 0,    afflictionOnRoll: null },
  standard: { framesPerProgram: 2.5, integrityCostPerTick: 0,   afflictionChancePerTick: 0,    afflictionOnRoll: null },
  lean:     { framesPerProgram: 1.5, integrityCostPerTick: 0.3, afflictionChancePerTick: 0.04, afflictionOnRoll: 'cache_thrash' },
  starved:  { framesPerProgram: 0.8, integrityCostPerTick: 1.0, afflictionChancePerTick: 0.06, afflictionOnRoll: 'thrashing' },
};

/** quotaPerTick = framesPerProgram * aliveCount * 0.2 */
export function quotaPerTick(rations: Rations, aliveCount: number): number;
```

At five alive this gives 4.0, 2.5, 1.5 and 0.8 quota per tick, matching the
bible's fourth column.

**The two rations tables are different tables and both are correct.** Sim spec
6.6, implemented by WP-05 in `src/kernel/memory/rations.ts`, sets frames per
process for the whole system from `totalFrames / activeProcesses`. The narrative
bible 6.2 table above sets frames reserved for each convoy Program and the quota
burn that reservation costs. The kernel table allocates; the game table pays. Do
not reconcile them into one and do not import the kernel's table here. State in
your report that you checked both and kept them separate.

### 4. Writing the dials into the kernel

Pace and rations are direct writes into `KernelConfig`, per narrative bible
section 6's opening. The runner applies them at leg entry and on every change,
always at a tick boundary, never mid-tick:

| Dial | Kernel write |
|---|---|
| `pace` | `SchedulerParams.quantum = PACE_TABLE[pace].quantum` |
| `pace` | the leg workload's arrival rate is multiplied by `workloadArrivalRate` |
| `rations` | the convoy's per-process frame reservation is `ceil(framesPerProgram)` frames, pinned |
| `degreeOfMultiprogramming` | admits or suspends leg workload processes |

The quantum write goes through the kernel's `setSchedulerParams` from WP-03. The
frame reservation goes through the memory subsystem's allocation scheme from
WP-05, using `ReplacementScope` as the leg's config left it. The arrival rate
multiplier is applied by the runner when it decides whether to spawn a workload
process this tick, not by the kernel, because the kernel has no notion of a
convoy travelling.

`framesPerProgram` is fractional in three of the four rows. Round up per Program
when reserving, because a Program cannot hold 2.5 frames, and keep the fractional
value for the quota arithmetic, because the quota burn is the economic quantity
and rounding it would drift the ledger over a thousand ticks. This is the one
place in the game layer where a fractional quantity is correct; every tick count
stays an integer.

### 5. `src/game/travel/TravelLoop.ts`

The travel loop advances `RunState.legProgress` and charges the ledger. It runs
inside `RunDirector.preTick`, before `Kernel.step`, so that a policy change made
this tick is already reflected in the charge.

```ts
export interface TravelState {
  readonly legId: LegId;
  readonly segmentsTotal: number;
  segmentsDone: number;
  ticksElapsed: number;
  /** Tick counter at which the next event deck draw fires. */
  nextDrawAtTick: number;
  /** True when the leg was entered on the emergency preemption credit. */
  onCredit: boolean;
  drawsFired: number;
}

export interface TravelCharge {
  readonly segments: number;
  readonly cycles: number;
  readonly quota: number;
  readonly integrityPerProgram: number;
}

export function travelCharge(policy: TravelPolicy, aliveCount: number): TravelCharge;
export function advance(state: TravelState, charge: TravelCharge): void;
```

Per tick, from narrative bible 5.3:

```
segments             = segmentsPerTick(pace)
cycles               = segments * cyclesPerSegment(pace) * quantumOverhead(pace)
quota                = framesPerProgram(rations) * aliveCount * 0.2
integrityPerProgram  = integrityCostPerTick(rations)
legProgress          = segmentsDone / segmentsTotal, clamped to [0, 1]
```

Charges are subtracted from `RunState.resources` through `runStore.mutate`. The
ledger floors at zero for `blocks` and `bandwidth`, which cannot go negative per
5.6, and `quota` floors at zero with the forced-`starved` rule below. `cycles`
may go negative only through the emergency credit path, which never lets it.

Per-leg totals must reproduce narrative bible 5.3 exactly. For an 80-segment leg
at each pace, the loop must produce the 6.1 worked example:

| Pace | Cycles | Ticks | Quota at standard, five alive | Event draws |
|---|---|---|---|---|
| `conservative` | 126 | 133 | 333 | 13 |
| `steady` | 200 | 80 | 200 | 8 |
| `aggressive` | 360 | 53 | 133 | 5 |
| `reckless` | 704 | 38 | 95 | 4 |

`ticksForLeg = ceil(segments / segmentsPerTick)`. Rounding is at the leg level
for the reported total and per tick for the charge, so the accumulated per-tick
charges and the closed-form leg total must agree within one tick's charge. A test
asserts that for all four paces on every leg length in `LEG_SEGMENTS`.

**Event draw cadence.** A draw fires each time `ticksElapsed` crosses a multiple
of 10, plus one final draw at leg end when `ticksElapsed % 10 >= 5`. That gives
13, 8, 5 and 4 for the four rows above and it is the rule the table encodes. The
emergency preemption credit adds one extra draw per 20 ticks on top, per 5.6.
Nothing else changes the cadence: a crossing's `eventDraws` are separate draws
made by the crossing, not by the loop.

**Leg end.** The loop stops when `segmentsDone >= segmentsTotal`, when the last
living Program derezzes, or when `maxTicks` is exceeded. The third case is a
guard, not a game state: it emits nothing to the player and the runner reports it
as a runner failure through `LegSandbox`'s diagnostic channel.

### 6. `src/game/travel/ledger.ts`

The resource economy's writes, in one place, so no other module subtracts from
`RunState.resources` directly.

```ts
export function startingLedger(disc: DiscClass, tier: DifficultyTier): ResourceLedger;
export function legDividend(legIndex: number, throughputFactor: number, disc: DiscClass): number;
export function refillBandwidth(ledger: ResourceLedger, disc: DiscClass, tier: DifficultyTier, atDepot: boolean): void;
export function applyDelta(ledger: ResourceLedger, delta: Partial<ResourceLedger>): void;
export function emergencyCreditNeeded(ledger: ResourceLedger, legId: LegId): boolean;
```

Starting allocations, narrative bible 5.2, at `operator`, multiplied by the
difficulty factor and floored:

| Disc class | Cycles | Quota | Blocks | Bandwidth cap |
|---|---|---|---|---|
| shell | 1600 | 900 | 120 | 60 |
| daemon | 1100 | 650 | 160 | 45 |
| compiler | 700 | 420 | 90 | 30 |

| Difficulty | Resource factor |
|---|---|
| `novice` | 1.35 |
| `operator` | 1.00 |
| `architect` | 0.80 |
| `kernel_space` | 0.65 |

The worked example that pins the rounding: a compiler disc at `architect` starts
with 560 cycles, 336 quota, 72 blocks and a 24 bandwidth cap.

Bandwidth is not a stockpile. It refills to 60 percent of the class cap at the
start of every leg and to 100 percent at a depot, per 5.1.

Dividend, narrative bible 5.4:

```
dividend = (60 + 6 * legIndex) * throughputFactor * classDividendMultiplier
```

`throughputFactor` runs from 0.6 to 1.4, computed from the kernel's own
`SchedulingMetrics.throughput` for the leg normalised against the leg's designed
target, and clamped to that range. `classDividendMultiplier` is 1.0 for shell and
daemon and 1.25 for compiler. At `throughputFactor = 1.0` the thirteen dividends
are 66, 72, 78, 84, 90, 96, 102, 108, 114, 120, 126, 132, 138 and sum to 1326.

**The emergency preemption credit**, narrative bible 5.6. When the ledger cannot
pay the conservative-pace cost of the next leg, the credit is issued. It is never
refused and it is available every leg. Its terms:

- the leg is travelled at conservative pace for zero cycles
- one extra event draw per 20 ticks
- the leg dividend is reduced 25 percent
- 0.3 integrity per tick against the lowest-integrity living Program, resolved by
  Program id ascending on a tie

**Quota underflow.** At zero quota the rations dial is forced to `starved` and
cannot be raised until quota is positive. The free reclamation run stays
available regardless of bandwidth.

**Blocks and bandwidth** cannot go negative. At zero blocks, repairs and
journaling are unavailable. At zero bandwidth only the free verbs remain: setting
policy, setting pace and rations, reading the terminal, opening the codex. The
runner enforces this by refusing the command, not by hiding the control; WP-17's
HUD decides what to grey out.

### 7. `src/game/travel/degree.ts`

`TravelPolicy.degreeOfMultiprogramming` multiplies the leg workload's process
count, per narrative bible 6.2. Frames available to the convoy are
`totalFrames - workloadDemand(degree)`. Raising the degree raises throughput and
therefore the dividend, right up until the fault rate crosses
`thrashingThreshold`, at which point throughput falls off a cliff. Finding that
knee is the whole of leg 8 and `reduce_degree` is the remedy for `thrashing`, so
this control must be real.

```ts
export interface DegreeChange {
  readonly from: number;
  readonly to: number;
  readonly admitted: readonly Pid[];
  readonly suspended: readonly Pid[];
}

export class DegreeController {
  constructor(kernel: Kernel, workloadPids: readonly Pid[], initial: number);
  get current(): number;
  /** Applied at a tick boundary. Returns what actually moved. */
  set(target: number, at: Tick): DegreeChange;
  /** totalFrames minus the workload's demand at the current degree. */
  framesAvailableToConvoy(totalFrames: number): number;
}
```

Rules:

- The degree is an integer, clamped to `[1, workloadPids.length]`. A request
  outside that range is clamped, not rejected, and the clamp is reported in the
  returned `DegreeChange`.
- Raising the degree admits suspended workload processes in ascending `Pid`
  order. Lowering it suspends running workload processes in descending `Pid`
  order. Both orders are total, so the same request from the same state always
  moves the same processes.
- Convoy Programs are never admitted or suspended by this control. The controller
  is constructed with the workload pids only, and a convoy pid appearing in that
  list is a construction error that throws.
- Suspension goes through the kernel's existing state transition, not through a
  side table. A suspended process is out of the ready queue and holds no frames.

### 8. `src/game/afflictions/table.ts` and `AfflictionClock.ts`

The thirteen rows of narrative bible 7.1, verbatim. This is the source of truth
and it wins over the curriculum map's failure-mode prose wherever they differ,
which they do in at least two places.

| `AfflictionId` | Display name | Drain per tick | Fatal after | Remedy kind | Chapter |
|---|---|---|---|---|---|
| `priority_inversion` | Priority Inversion | 0.8 | null | `terminal` | 6.6, 5.3.3 |
| `memory_leak` | Memory Leak | 0.5 | null | `terminal` | 9.1, 10.8 |
| `starvation` | Starvation | 1.2 | 180 | `set_scheduler` | 5.3.3 |
| `thrashing` | Thrashing | 2.0 | 90 | `reduce_degree` | 10.6 |
| `lock_convoy` | Lock Convoy | 0.6 | null | `adjust_quantum` | 6.5, 5.3.3 |
| `livelock` | Livelock | 0.9 | 140 | `terminal` | 6.2, 6.7 |
| `orphaned` | Orphaned | 0.4 | null | `terminal` | 3.3.2 |
| `fragmented` | Fragmented | 0.7 | null | `ability` | 9.2.3 |
| `cache_thrash` | Cache Thrash | 0.5 | null | `adjust_quantum` | 1.5.3, 5.3.3 |
| `bit_rot` | Bit Rot | 0.3 | 400 | `spend` | 11.8 |
| `stack_overflow` | Stack Overflow | 1.5 | 60 | `ability` | 9.3.3, 3.1.1 |
| `false_sharing` | False Sharing | 0.6 | null | `terminal` | 4.5, 1.5.3 |
| `interrupt_storm` | Interrupt Storm | 1.1 | 110 | `terminal` | 12.2.5 |

The bible prints 5.3.4 in four of those chapter cells. **Use 5.3.3.** That is the
first of the three citation corrections in `00-BUILD-ORDER.md`: 5.3.3 is
Round-Robin, where the quantum is defined, and 5.3.4 is Priority Scheduling. The
corrected number goes into every `ChapterRef` this package constructs.

```ts
export interface AfflictionSpec {
  readonly id: AfflictionId;
  readonly displayName: string;
  readonly drainPerTick: number;
  readonly fatalAfter: number | null;
  readonly remedy: AfflictionRemedy;
  readonly chapter: ChapterRef;
}

export const AFFLICTION_TABLE: Readonly<Record<AfflictionId, AfflictionSpec>>;

/** Builds the frozen Affliction from a spec plus the tick it was acquired. */
export function makeAffliction(id: AfflictionId, at: Tick): Affliction;
```

`AfflictionClock` ticks them:

```ts
export interface AfflictionTickResult {
  readonly drained: ReadonlyMap<ConvoyMemberId, number>;
  readonly fatal: readonly { readonly member: ConvoyMemberId; readonly id: AfflictionId }[];
}

export function tickAfflictions(convoy: readonly ConvoyMember[], at: Tick): AfflictionTickResult;
export function acquire(member: ConvoyMember, id: AfflictionId, at: Tick): boolean;
export function cure(member: ConvoyMember, id: AfflictionId): boolean;
export function isCuredBy(a: Affliction, action: AfflictionRemedy): boolean;
```

Rules:

- **Drain is summed over every affliction a Program carries and applied once per
  travel tick.** A Program with `thrashing` and `bit_rot` loses 2.3 integrity per
  tick, not 2.0 and then 0.3 in a second pass.
- **`fatalAfter` counts travel ticks since `acquiredAtTick`, not wall time and
  not total run ticks.** When `at - acquiredAtTick >= fatalAfter` the Program
  dies with the affliction's own termination reason and does not first drain to
  zero. Both death paths exist and they are different deaths.
- **The same affliction cannot be acquired twice.** `acquire` returns false if
  the Program already carries that id and the existing `acquiredAtTick` stands.
  Re-acquiring would reset a fatal clock, which would make the pathology
  survivable by suffering more of it.
- **Curing removes the affliction and its clock together.** There is no partial
  cure and there is no residue.
- **Repair does not clear afflictions**, per narrative bible 10.4 rule 1. A
  Program repaired to 100 integrity with `bit_rot` still has `bit_rot`, still
  drains 0.3 per tick, and its `fatalAfter` clock is unchanged. This is the rule
  most likely to be implemented wrongly by accident, so it gets its own test.
- `isCuredBy` matches an `AfflictionRemedy` against a player action so that
  WP-17's HUD can mark a remedy as taken. It is a pure comparison and it never
  reveals the remedy: the remedy stays hidden until the codex entry unlocks, and
  the codex entry unlocks by suffering the pathology.

### 9. `src/game/convoy/status.ts` and `derezz.ts`

```ts
export function statusFor(integrity: number): ConvoyStatus;
export function aliveMembers(convoy: readonly ConvoyMember[]): readonly ConvoyMember[];
export function lowestIntegrityAlive(convoy: readonly ConvoyMember[]): ConvoyMember | null;
export function applyIntegrity(member: ConvoyMember, delta: number): void;
```

Thresholds. The only figure the documents pin is `critical`, which narrative
bible 10.4 rule 2 defines as integrity below 25. The rest of the band structure
is set here:

| Status | Integrity |
|---|---|
| `nominal` | 70 and above |
| `degraded` | 25 to 69 |
| `critical` | above 0 and below 25 |
| `derezzed` | 0 |

Integrity is clamped to `[0, 100]` on every write. `statusFor` is a pure function
of integrity and is the only place status is decided, so a Program's status can
never disagree with its integrity. Report the three unpinned thresholds as a
balance decision a human should confirm.

`lowestIntegrityAlive` breaks ties by `ConvoyMemberId` ascending, because the
emergency credit's drain targets it and a tie must not depend on array order.

Derezz:

```ts
export interface DerezzInput {
  readonly member: ConvoyMember;
  readonly reason: TerminationReason;
  readonly tick: Tick;
  readonly legId: LegId;
}

export function derezz(input: DerezzInput, copy: EpitaphCopySource): Epitaph;
```

Rules:

- A Program derezzes when integrity reaches 0 or when an affliction's
  `fatalAfter` elapses. Both paths call `derezz` once and only once.
- `derezz` sets `status = 'derezzed'`, `integrity = 0`, releases the pid binding
  and pushes the `Epitaph` onto `RunState.tombstones`. The convoy array keeps the
  member; a derezzed Program is not spliced out, because the tombstone and the
  roster both need it for the rest of the run.
- The kernel-side termination is a separate call. The runner terminates the
  bound pid through the syscall table so the simulator's own accounting stays
  correct, and it does so after the epitaph is built, so the epitaph can read the
  Program's final state.
- `EpitaphCopySource` supplies the joke line, the teaching line and the codex
  entry id. **This package ships the machinery and no copy.** The epitaph text
  is narrative bible section 9 and it is authored by whichever package owns
  epitaph content; here it is an injected lookup with a throwing stub and a
  `// TODO(astra):` naming the gap. A missing epitaph must not be a silent empty
  string in a shipped tombstone.
- Convoy integrity is the run's failure condition only when every Program is
  derezzed. A leg with casualties still returns `survived: true` if any Program
  remains, which is what WP-L08's acceptance criteria assume.

### 10. `src/game/events/EventDeck.ts`

The Oregon Trail event deck, drawn from the leg's own `eventTable`.

```ts
export interface DrawContext {
  readonly run: RunState;
  readonly rng: Rng;
  readonly at: Tick;
  readonly legId: LegId;
}

export interface EventApplication {
  readonly def: RandomEventDef;
  readonly target: ConvoyMemberId | null;
  readonly inflicted: AfflictionId | null;
  readonly delta: Partial<ResourceLedger>;
}

export function eligible(table: readonly RandomEventDef[], run: RunState): readonly RandomEventDef[];
export function draw(table: readonly RandomEventDef[], ctx: DrawContext): RandomEventDef | null;
export function apply(def: RandomEventDef, ctx: DrawContext): EventApplication;
export function validateTable(table: readonly RandomEventDef[]): readonly string[];
```

The draw, and it must be exactly this because fourteen golden playthroughs hash
its output:

1. Filter the table to entries whose `onlyIf` is null or returns true for the
   current `RunState`. Preserve the table's declared order; do not sort.
2. Sum the weights of the eligible entries. If the sum is 0 or the eligible list
   is empty, return null and fire nothing.
3. Draw `r = rng.int(1, total)` from the `root/events` forked stream, never from
   the root stream and never from another subsystem's stream.
4. Walk the eligible entries in order accumulating weight, and return the first
   entry whose running total is at or above `r`.

`onlyIf` is a leg-supplied predicate and may throw. Wrap each call: a predicate
that throws is treated as false and records a `LegSandbox` diagnostic. It must
not be treated as true and it must not abort the draw, because that would make
one bad leg predicate silently reweight the whole deck.

`apply`:

- `targets` null means the event can strike any living Program; pick uniformly
  from the living set in `ConvoyMemberId` ascending order using the same stream.
  A non-null `targets` restricts to living Programs of that `ConvoyRole`, and
  when none is alive the event fires with `target: null` and its resource delta
  still applies.
- `inflicts` calls `acquire`. An already-carried affliction is not re-acquired
  and the event still applies its resource delta.
- `resourceDelta` goes through `applyDelta`, subject to the floors in section 6.

`validateTable` returns a list of problems rather than throwing: weights must be
positive integers summing to exactly 100, ids must be unique, and `narration`
must be non-empty. WP-20 asserts it returns empty for all fourteen legs, and
every leg package's own acceptance criteria assert the sum of 100.

### 11. The critical section crossing system

Nine crossings in the journey: three in the Narrows, two in the Cistern, two in
the Gridlock, one in the Archive, one at the Arbiter Wall. The four options are
the same every time. What changes is the contention. **Legs declare crossings and
never compute their costs.** Five leg packages say in their out-of-scope section
that the formulas are shared code here, so an implementation that lets a leg pass
its own cost table is wrong.

#### 11.1 `src/game/crossing/contention.ts`

Narrative bible 12.1, verbatim. Contention `C` is derived entirely from
`KernelSnapshot`. Nothing about it is authored per crossing, which is what makes
a crossing a reading of the player's own state rather than a dice roll with a
story on it.

```ts
export function contention(s: KernelSnapshot, lock: SyncPrimitiveView): number {
  const queuePressure =
    Math.min(1, lock.waitQueue.length / Math.max(1, lock.capacity * 2));

  const holdPressure =
    Math.min(1, meanHoldTicks(s, lock.id) / s.config.schedulerParams.quantum);

  const blocked = s.processes.filter(p => p.state === 'waiting').length;
  const runnable = s.processes.filter(
    p => p.state === 'ready' || p.state === 'running').length;
  const systemPressure = blocked / Math.max(1, blocked + runnable);

  return clamp01(
    0.50 * queuePressure +
    0.30 * holdPressure +
    0.20 * systemPressure
  );
}
```

`meanHoldTicks` is the mean of `servedAtTick - queuedAtTick` over the last
sixteen acquisitions of that primitive, tracked by the sync subsystem from WP-07.
Read it from the snapshot; do not keep a parallel history here. If WP-07 does not
expose the last sixteen acquisitions, file it against WP-07 and leave a throwing
stub rather than approximating from the event log.

The three terms are the three things that make a critical section expensive: how
many are waiting, how long each holder keeps it relative to a slice, and how much
of the system is blocked rather than running. The player can read all three with
`lsof <lock>`, `ps` and `top` before choosing.

Contention is presented as a number and never as a colour band. `C = 0.64` is the
whole HUD element, and WP-17 renders it; this package supplies the number.

#### 11.2 `src/game/crossing/options.ts`

The four options, with the formulas exactly as narrative bible 12.2 gives them.

**Option 1, spin-wait.** Hold the processor and test the lock in a loop.

```
cyclesCost = round(12 + 90 * C)
ticksCost  = round(4 + 30 * C)
successP   = 1 - 0.85 * C^2
```

Failure: the quantum expires while the crosser is inside the section. At
`C <= 0.70` this inflicts `lock_convoy` on the crossing Program and on every
Program behind it. Above 0.70 it inflicts `livelock` on the crosser and one other
Program, chosen from the living set on the same stream, because the retry pattern
has become symmetric. Either way the crossing is attempted again from the start
at the new and higher contention, recomputed from the snapshot rather than
scaled.

**Option 2, block on a semaphore.** Sleep and be woken on release.

```
ticksCost  = round(20 + 60 * C)
cyclesCost = 0
quotaCost  = ticksCost * framesPerProgram(rations) * aliveCount * 0.2
successP   = lock.ordered ? 0.99 : 1 - 0.55 * C^2
```

Failure: on an unordered wait queue there is no bounded-waiting guarantee, so the
process at the back can be passed over indefinitely, and failure inflicts
`starvation` on the crossing Program. Additionally, when `C > 0.75` and the
crosser holds any other resource, there is a 12 percent chance the crossing
terminates that Program with `deadlock_victim`, because blocking while holding is
hold-and-wait. That second roll is a separate draw and it happens whether or not
the first roll succeeded.

**Option 3, pay a monitor toll.**

```
cyclesCost    = round(45 + 120 * C)
bandwidthCost = 6
ticksCost     = 8
successP      = 0.97
```

Failure: a spurious wakeup. The condition is signalled, the crosser wakes, and
the predicate is no longer true because another process got in between the signal
and the wake. The client checked with `if` instead of `while`, so it proceeds
anyway. The result is a race: 20 blocks lost and `bit_rot` inflicted on the
crossing Program. `successP` does not move with `C`, which makes the monitor the
only option that becomes more attractive as things get worse, and the price rises
with `C` so it is never free insurance.

**Option 4, wait for conditions to change.**

```
ticksCost  = round(40 + 120 * C)
cyclesCost = 0
quotaCost  = ticksCost * framesPerProgram(rations) * aliveCount * 0.2
eventDraws = floor(ticksCost / 10)
C'         = C * 0.86 ^ (ticksCost / 10)
successP   = 1 - 0.20 * C'^2
```

Waiting almost never fails at the crossing. It fails everywhere else. Every
affliction with a non-null `fatalAfter` advances by `ticksCost`, the event draws
are real draws from the leg's table made through `EventDeck.draw`, and the quota
cost is enormous. At `C = 0.8` with standard rations and five Programs alive,
waiting costs 340 quota, which is more than an entire leg's normal burn and more
than a strong reclamation round.

The interface:

```ts
export type CrossingOption = 'spin' | 'block' | 'monitor' | 'wait';

export interface CrossingContext {
  readonly contention: number;
  readonly ordered: boolean;
  readonly rations: Rations;
  readonly aliveCount: number;
  readonly crosserHoldsResource: boolean;
}

export interface CrossingQuote {
  readonly option: CrossingOption;
  readonly cyclesCost: number;
  readonly ticksCost: number;
  readonly quotaCost: number;
  readonly bandwidthCost: number;
  readonly blocksCost: number;
  readonly successP: number;
  readonly eventDraws: number;
}

export function quote(option: CrossingOption, ctx: CrossingContext): CrossingQuote;
export function quoteAll(ctx: CrossingContext): Readonly<Record<CrossingOption, CrossingQuote>>;
```

`quote` is pure and takes no `Rng`. It is called to populate the choice UI, so it
must be callable any number of times with no side effect and no stream
consumption. Rolling happens once, in `Crossing.resolve`.

The table your tests assert, from narrative bible 12.3, five Programs alive,
standard rations, ordered wait queue, quantum 8:

| C | Spin: cycles / p | Block: ticks / quota / p | Monitor: cycles / p | Wait: ticks / quota / p |
|---|---|---|---|---|
| 0.20 | 30c / 96.6% | 32t / 80q / 99% | 69c / 97% | 64t / 160q / 99.9% |
| 0.40 | 48c / 86.4% | 44t / 110q / 99% | 93c / 97% | 88t / 220q / 99.8% |
| 0.60 | 66c / 69.4% | 56t / 140q / 99% | 117c / 97% | 112t / 280q / 99.8% |
| 0.80 | 84c / 45.6% | 68t / 170q / 99% | 141c / 97% | 136t / 340q / 99.8% |

With an unordered queue, blocking succeeds at 97.8, 91.2, 80.2 and 64.8 percent
for the same four contention values and failure inflicts `starvation`.

#### 11.3 `src/game/crossing/Crossing.ts`

```ts
export interface CrossingDef {
  readonly id: string;
  readonly legId: LegId;
  /** The sync primitive id declared by the leg's populate(). */
  readonly lockId: string;
  readonly kind: 'mutex' | 'semaphore' | 'monitor' | 'rwlock';
  readonly ordered: boolean;
  /** Diegetic anchor the focus camera frames. */
  readonly anchor: string;
  readonly crosser: ConvoyMemberId | null;
}

export interface CrossingResult {
  readonly def: CrossingDef;
  readonly option: CrossingOption;
  readonly contentionAtChoice: number;
  readonly quote: CrossingQuote;
  readonly succeeded: boolean;
  readonly attempts: number;
  readonly afflicted: readonly { readonly member: ConvoyMemberId; readonly id: AfflictionId }[];
  readonly casualties: readonly ConvoyMemberId[];
  readonly eventsDrawn: readonly string[];
  readonly spent: Partial<ResourceLedger>;
}

export class CrossingRunner {
  constructor(deps: CrossingDeps);
  /** Recomputes C from the live snapshot. Cheap; call it whenever the UI reopens. */
  survey(def: CrossingDef): CrossingContext;
  /** Consumes exactly one Rng draw per roll and records one DecisionRecord. */
  resolve(def: CrossingDef, option: CrossingOption, at: Tick): CrossingResult;
}
```

Rules:

- **`resolve` records a `DecisionRecord`** with `kind: 'crossing'` and
  `choice: '<crossing id>:<option>'`, `outcome: 'pending'`, resolved to `good`,
  `costly` or `fatal` by the outcome of that same call. It is the runner that
  writes it, through WP-17's decision interface, never by pushing onto the array.
- **Retry on failure is a new attempt at the new contention**, up to a cap of
  four attempts. At the cap the crossing resolves as failed and the convoy
  crosses anyway carrying whatever the last failure inflicted. An uncapped retry
  loop can consume unbounded ticks on a leg whose contention is pinned at 1.0,
  which is exactly what the Gridlock's second crossing is.
- **The ticks a crossing costs are simulated, not skipped.** `resolve` advances
  the kernel by `ticksCost` ticks through the normal step path, so afflictions
  tick, the workload runs, and the event draws land where they land. A crossing
  that subtracted a number from a counter would break every leg's golden event
  log.
- **Costs are charged before the roll**, since the player paid for the attempt
  and not for the result. This is the same rule as the depot's, which charges
  whether the service helped or not.

### 12. The depot

Depots at seven legs, per `DEPOT_LEGS`. A depot is a place where the Substrate
does something in exchange for cycles. It does not haggle, does not stock
differently by run, and does not react to how badly the convoy needs something.

#### 12.1 `src/game/depot/prices.ts`

```
price(base, legIndex, tier) = round(base * (1 + 0.09 * legIndex) * tierFactor)
```

| Tier | `tierFactor` |
|---|---|
| `novice` | 0.80 |
| `operator` | 1.00 |
| `architect` | 1.15 |
| `kernel_space` | 1.35 |

Base prices before scaling, narrative bible 5.7:

| Item | Unit | Base cycles | Base blocks |
|---|---|---|---|
| Quota lot | 25 frames | 50 | 0 |
| Block lot | 10 blocks | 30 | 0 |
| Bandwidth lot | 5 units | 20 | 0 |
| Repair | 10 integrity | 15 | 8 |
| Policy hint | one | 60 | 0 |
| Journal checkpoint | one | 90 | 25 |
| Recruit a replacement Program | one per run | 220 | 40 |

Cycles and blocks are scaled and rounded independently, which is what produces
`16c + 9b` for a repair at leg 1 rather than a single scaled pair. The whole
resolved `operator` table in 5.7 is your fixture and every one of its 49 cells is
asserted.

#### 12.2 `src/game/depot/Depot.ts`

```ts
export type DepotItemId =
  | 'quota_lot' | 'block_lot' | 'bandwidth_lot'
  | 'repair' | 'policy_hint' | 'journal_checkpoint' | 'recruit';

export interface DepotOffer {
  readonly item: DepotItemId;
  readonly cycles: number;
  readonly blocks: number;
  readonly available: boolean;
  readonly unavailableReason: string | null;
}

export interface PurchaseResult {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly spent: Partial<ResourceLedger>;
  readonly gained: Partial<ResourceLedger>;
}

export class Depot {
  constructor(legIndex: number, tier: DifficultyTier, disc: DiscClass, run: RunState);
  catalogue(): readonly DepotOffer[];
  buy(item: DepotItemId, target: ConvoyMemberId | null): PurchaseResult;
}
```

The rules that give the depot teeth, narrative bible 10.4 and 10.5:

- **Repair does not clear afflictions.** Section 8 above covers this and the
  depot must not be the place it leaks.
- **Repair is capped by status.** A `critical` Program, integrity below 25, can
  be repaired at most 30 points in one depot visit. The cap is per visit and per
  Program, tracked on the depot instance, not on the member.
- **The daemon disc halves the block cost of repair**, rounded up. That single
  rule is what the daemon class is for.
- **Blocks are the binding constraint.** Do not add a cycles-only repair path.
- **Bandwidth refills to 100 percent on depot entry, free**, and the bandwidth
  lot is on top of that.
- **Policy hint** inspects the live kernel and states one true, specific fact as
  a measurement, never an instruction. This package supplies the measurement
  extraction and the format; the sentence is assembled from live snapshot values
  only. At `novice` the hint additionally names the remedy. At `kernel_space` the
  hint is not sold: `available: false` with a reason.
- **Journal checkpoint** writes a checkpoint of the whole run state through
  WP-17's save module. If the convoy fails during the next leg only, the run
  rolls back to this checkpoint with all resources and all living Programs
  restored, at the cost of that leg's dividend and one permanent mark on the
  correctness score. Checkpoints do not stack: buying a second replaces the
  first. One-time per depot.
- **Recruit** is once per run, total, and only when a Program has derezzed. The
  recruit takes the dead Program's role and receives 60 percent of its passive,
  with active abilities at full strength and one fewer charge per leg. No name
  inheritance: the recruit is `LUMEN-2` and LUMEN's tombstone stays in the run.
  A replacement codec restores the `restore` ability and not the passive, so
  corruption stays unrecoverable for the rest of the run, and the depot says so
  before taking the cycles.

Availability is decided by `catalogue()` and re-checked inside `buy()`. A UI that
shows a stale catalogue must not be able to buy through it.

### 13. Reclamation

`src/game/reclamation/` owns the deterministic model of the minigame: Verge
generation, the scoring function and the round lifecycle. **It owns no input
handling, no camera and no 3D.** The runner half must be complete and testable
headlessly, because WP-20 drives reclamation rounds with a scripted input trace
and asserts the yield. The flying, the beam and the Verge's visual construction
are phase 2 and belong to `@world`.

#### 13.1 `src/game/reclamation/verge.ts`

The Verge is generated from the leg's live `MemoryMetrics.externalFragmentation`
value `F`, in `[0, 1]`. Nothing here is a difficulty slider: `F` rises because the
player allocated badly and the minigame gets harder as a direct consequence.

| Parameter | Formula |
|---|---|
| Fragment count | `20 + 90 * F` |
| Mean fragment size, frames | `6 - 4.5 * F` |
| Leaked block count | `12 + 26 * F` |
| Mean leaked block size | `5.5 - 3.0 * F` |
| Mark lighting decay, seconds | `12 - 10 * F` |
| Verge rotation, degrees per second | `4 + 16 * F` |
| Adjacency of fragments | `0.8 - 0.6 * F` |

Counts are rounded to integers; sizes, decay, rotation and adjacency stay
fractional. The three anchor columns your tests assert are `F = 0.1`, `0.5` and
`0.9`, giving fragment counts 29, 65 and 101 and leaked block counts 15, 25
and 35.

```ts
export interface VergeLayout {
  readonly f: number;
  readonly fragments: readonly VergeFragment[];
  readonly leaked: readonly VergeBlock[];
  readonly live: readonly VergeBlock[];
  readonly markDecaySeconds: number;
  readonly rotationDegPerSec: number;
  readonly adjacency: number;
  readonly seconds: number;
}

export function generateVerge(f: number, rng: Rng, tier: DifficultyTier): VergeLayout;
```

The layout is deterministic in the leg id and the seed, per narrative bible 11.7,
so a round can be shared and beaten. Live blocks are placed dense in exactly the
regions where the leaked blocks are largest, which is what makes the
highest-value pockets the risky ones.

Round time limits, 11.5:

| Difficulty | Seconds |
|---|---|
| `novice` | 90 |
| `operator` | 75 |
| `architect` | 65 |
| `kernel_space` | 55 |

#### 13.2 `src/game/reclamation/scoring.ts`

```
quotaYield  = sum(leakedBlockSizeInFrames) * cleanSweepBonus * classMultiplier
blockYield  = round(fragmentsCollected * 0.5 * coalesceMultiplier)
cycleRefund = min(30, floor(quotaYield / 10))

coalesceMultiplier = 1 + 0.15 * (longestUnbrokenChain - 1), capped at 3.0
cleanSweepBonus    = 1.20 if no live block was reclaimed, else 1.00
classMultiplier    = 1.35 for the compiler disc, else 1.00
```

Use-after-free penalty, 11.4: reclaiming a white block costs 25 quota from the
running total, inflicts 6 integrity on a random living Program drawn from the
reclamation stream, blanks the mark lighting for 4 seconds, and forfeits the
clean sweep bonus for the round.

Run economics, 11.5: one reclamation per leg is free. Additional runs cost 8
bandwidth each and yield 0.6 times normal; a third run in the same leg yields
0.36 times. The multiplier is `0.6 ^ (runIndex - 1)` for `runIndex` 1, 2, 3 and
runs beyond the third are refused.

Target yields at `operator` with five Programs alive, which your tests bracket:

| Percentile | Quota | Blocks | Cycles |
|---|---|---|---|
| Poor round | 90 | 8 | 9 |
| Median round | 150 | 18 | 15 |
| Strong round | 220 | 30 | 22 |
| Perfect round | 265 | 38 | 26 |

Total yield at `F = 0.9` must come out around 45 percent of yield at `F = 0.1`
for identical play. Assert that with a scripted sweep replayed against both
layouts.

`Reclamation.ts` holds the round lifecycle: `open(f, tier, runIndex)`,
`submit(trace)`, `close()`. `submit` takes a `ReclamationTrace`, a plain list of
collect and coalesce actions with timestamps, which is what makes the round
headlessly testable and what WP-20 scripts.

### 14. `src/game/LegSandbox.ts`

Ship architecture section 10.5's `LegSandbox` as written. It is quoted in full in
that section including the neutral outcome, and it is not yours to improve.

Every call into a `Leg` goes through the sandbox: `kernelConfig`, `populate`,
`createStage`, the stage's `update`, `anchor` and `dispose`, `evaluate`, each
`InteractionDef.enabledWhen`, each `RandomEventDef.onlyIf`, and each leg terminal
command handler. Legs are the parallel work packages, written by different
agents, integrated late. Assume they will throw.

The behaviours that must survive verbatim:

- `kernelConfig` throwing returns null, and a null config means the leg is
  skipped: the player sees the leg-unavailable card, the convoy advances with no
  resource change and no casualties, and the run continues.
- `populate` throwing returns false and takes the same path.
- `createStage` throwing returns `NULL_STAGE`.
- The stage's `update` is disabled after its first throw, not on every frame.
- `evaluate` throwing returns the neutral outcome: survived, nothing met, nothing
  taken, and the card that says the segment finished but could not be judged.
- `enabledWhen` throwing is treated as false.

### 15. `src/game/debrief.ts`

The leg-complete card. The `DebriefCard` prose is the leg's, produced by its own
`evaluate`. This package owns three things around it.

```ts
export interface DebriefInput {
  readonly outcome: LegOutcome;
  readonly run: RunState;
  readonly legTicks: number;
  readonly throughputFactor: number;
  readonly dividend: number;
}

export interface DebriefView {
  readonly card: DebriefCard;
  readonly dividend: number;
  readonly ledgerBefore: ResourceLedger;
  readonly ledgerAfter: ResourceLedger;
  readonly casualties: readonly Epitaph[];
  readonly objectivesMet: readonly string[];
  readonly codexUnlocked: readonly string[];
}

export function buildDebrief(input: DebriefInput): DebriefView;
export function fillCounterfactual(card: DebriefCard, replay: ReplayResult): DebriefCard;
```

1. **The counterfactual slot.** `DebriefCard.counterfactual` is `string | null`.
   When the leg supplied a counterfactual request, the runner sends it to WP-18's
   replay worker and fills the slot from the result. When the replay fails or
   times out, the slot stays null and the card renders without it, per
   architecture 10.8. A failed counterfactual is one teaching moment lost and
   never a failed leg.
2. **The ledger delta.** `LegOutcome.resourceDelta` plus the dividend, applied by
   the runner and shown on the card as before and after.
3. **The `ChapterRef` fallback.** A card whose `chapter` is missing falls back to
   the leg's first declared chapter. Never invent a citation. If neither exists,
   leave `chapter: null` where the type permits and report the gap.

### 16. `src/game/LegRunner.ts`, the assembly

```ts
export type LegPhase =
  | 'entering' | 'travelling' | 'crossing'
  | 'depot' | 'reclamation' | 'evaluating' | 'complete';

export interface LegRunnerDeps {
  readonly runStore: RunStore;
  readonly commandBus: CommandBus;
  readonly createKernel: (config: KernelConfig) => Kernel;
  /** Forked from the run seed as 'run/leg'. Never the root stream. */
  readonly rng: Rng;
  readonly onEvent: (events: readonly KernelEvent[], at: Tick) => void;
  readonly replay: ReplayWorkerHandle | null;
  readonly epitaphs: EpitaphCopySource;
}

export interface LegRunOptions {
  readonly maxTicks: number;
  /** Headless runs pass null and never call createStage. */
  readonly stageContext: StageContext | null;
}

export class LegRunner {
  constructor(deps: LegRunnerDeps);
  get phase(): LegPhase;
  get ticksElapsed(): number;
  get finished(): boolean;

  enter(leg: Leg, opts: LegRunOptions): void;
  preTick(at: Tick): void;
  postTick(at: Tick, events: readonly KernelEvent[]): void;
  exit(): LegOutcome;
}
```

**Entry**, in this order, and the order matters:

1. Refill bandwidth to 60 percent of the class cap, or 100 percent if this leg
   has a depot.
2. Decide the emergency preemption credit: if the ledger cannot pay the
   conservative-pace cost of this leg, issue it, force pace to `conservative`,
   and set `TravelState.onCredit`.
3. Call `leg.kernelConfig(run)` through the sandbox. A null result skips the leg.
4. Apply the pace and rations dials to the config before construction, so the
   kernel is built with the right quantum rather than reconfigured on tick 1.
5. `createKernel(config)`.
6. Call `leg.populate(ctx)` through the sandbox, with a `LegSetupContext` whose
   `rng` is a fork of the leg stream, whose `spawn` goes through the syscall
   table, and whose `bind` records the `ConvoyMemberId` to `Pid` mapping in the
   runner's own side table. **`bind` does not write to the PCB.** The mapping
   lives here and reaches the world through the store.
7. Construct the `DegreeController` over the workload pids that `populate`
   spawned, excluding every bound convoy pid.
8. Set `run.legIndex` and `run.legProgress = 0`.
9. If `stageContext` is not null, call `leg.createStage` through the sandbox.
   Headless runs skip this entirely and never touch `@world`.

**Per tick**, `preTick`:

1. Apply the travel charge for this tick and advance `legProgress`.
2. Apply the rations integrity cost and roll the rations affliction chance.
3. Tick afflictions: drain, then fatal clocks.
4. Apply the emergency credit drain if `onCredit`.
5. Fire an event draw if the cadence rule says so.
6. Apply the workload arrival rate: spawn or hold this tick's workload arrivals.

`postTick(at, events)`:

1. Route kernel events that the game layer cares about: `process.starving` with
   `fatal: true`, `memory.thrashing`, `kernel.panic`, and every event that
   inflicts an affliction on a bound Program.
2. Apply integrity changes and derezz anyone who reached zero.
3. Resolve any `DecisionRecord` whose outcome this tick decided, through WP-17's
   decision interface.
4. Recompute `ScoreBreakdown` through WP-17's `scoring.ts`. Never accumulate it.
5. Decide whether the leg has ended.

**Exit**:

1. Build the `LegEvaluationContext`: the live `RunState`, `kernel.snapshot()`,
   the leg's event type list, and `ticksElapsed`.
2. Call `leg.evaluate(ctx)` through the sandbox.
3. Compute `throughputFactor` from `SchedulingMetrics.throughput` and the
   dividend from it, reduced 25 percent if `onCredit`.
4. Apply `LegOutcome.resourceDelta`, then the dividend.
5. Append `objectivesMet` and `codexUnlocked` to `RunState`, de-duplicated, order
   preserved.
6. Build the `DebriefView` and request the counterfactual.
7. Advance `legIndex`. Set `run.status` to `'failed'` if every Program is
   derezzed, `'complete'` after the last leg, and `'in_progress'` otherwise.
8. Dispose the stage if one was built.

Every one of those writes goes through `runStore.mutate`.

### 17. Determinism

The whole run is a pure function of its seed plus the decision log, and this
package is where that property is easiest to break. The rules:

- Every random draw in this package comes from a fork of the run seed, in a fixed
  order, established at run construction and not at first use. The forks are
  `run/leg`, `run/events`, `run/crossing` and `run/reclamation`.
- A quote is pure and draws nothing. Only `resolve` draws.
- No `Math.random`, no `Date.now`, no `performance.now` anywhere under
  `src/game/`. The wall clock reaches the game layer only as `dtSeconds` from the
  loop, and nothing in this package reads it.
- Iterate the convoy in `ConvoyMemberId` ascending order wherever order affects a
  result. `RunState.convoy` is an array whose order is the roster's, not a sort
  key.
- Never iterate a `Set` or an object's keys where the result matters. Sort first.
- Every tick count is an integer. Only quota, cycles and integrity are
  fractional, and they are recomputed rather than accumulated wherever the value
  is derivable from state.

## Acceptance criteria

1. `npm run typecheck` exits 0.
2. `npm run test` exits 0.
3. `npm run build` exits 0.
4. `PACE_TABLE` reproduces all six columns of narrative bible 6.1 for all four
   paces, and `quantumOverhead(quantum)` agrees with the stored column for 16, 8,
   4 and 2.
5. The 80-segment worked example passes at all four paces: cycles 126, 200, 360,
   704; ticks 133, 80, 53, 38; quota at standard with five alive 333, 200, 133,
   95; event draws 13, 8, 5, 4.
6. `RATIONS_TABLE` reproduces narrative bible 6.2, and `quotaPerTick` at five
   alive gives 4.0, 2.5, 1.5 and 0.8.
7. `startingLedger` reproduces the 5.2 table for all three disc classes at all
   four tiers, including the worked example: compiler at `architect` gives 560
   cycles, 336 quota, 72 blocks, 24 bandwidth cap.
8. `legDividend` at `throughputFactor = 1.0` for shell gives 66, 72, 78, 84, 90,
   96, 102, 108, 114, 120, 126, 132, 138, summing to 1326.
9. The intended curve of narrative bible 5.5 reproduces to the cycle for all
   three disc classes: shell finishes at 373, daemon goes negative at leg 11 at
   -9, compiler goes negative at leg 9 at -28.
10. `LEG_SEGMENTS` sums to 1020 over legs 1 to 13, and `boot_sector` is 0.
11. `DEPOT_LEGS` has exactly seven entries and does not contain `drowned_reach`.
12. The emergency preemption credit fires when and only when the ledger cannot
    pay the conservative-pace cost of the next leg, is never refused, forces
    conservative pace, reduces the dividend by exactly 25 percent, adds one draw
    per 20 ticks, and drains 0.3 integrity per tick from the lowest-integrity
    living Program.
13. At zero quota the rations dial is forced to `starved` and cannot be raised
    until quota is positive, and the free reclamation run is still available at
    zero bandwidth.
14. `blocks` and `bandwidth` never go negative across a 100,000-tick randomised
    sequence driven by a seeded `Rng`.
15. The affliction table matches narrative bible 7.1 in all thirteen rows, and
    every chapter cell that the bible prints as 5.3.4 is 5.3.3 here.
16. Drain sums across multiple afflictions on one Program; `fatalAfter` counts
    travel ticks from `acquiredAtTick`; re-acquiring an affliction is a no-op
    that does not reset the clock; repair restores integrity and clears nothing.
17. `statusFor` is total over `[0, 100]` and no Program's `status` can disagree
    with its `integrity` after any operation in a 10,000-step randomised
    sequence.
18. `derezz` fires exactly once per Program, pushes exactly one `Epitaph`, leaves
    the member in the convoy array, and terminates the bound pid through the
    syscall table.
19. `EventDeck.draw` over a fixed table and a fixed seed produces a byte-identical
    sequence of 10,000 draws across two runs and across a snapshot and restore.
20. An `onlyIf` predicate that throws is treated as false, records a diagnostic,
    and does not change the weights of the other entries.
21. `validateTable` returns empty for a table whose weights are positive integers
    summing to 100 with unique ids, and returns a named problem for each of the
    four failure kinds.
22. `contention` reproduces narrative bible 12.1 exactly, is clamped to `[0, 1]`,
    and returns 0 rather than `NaN` when the process list is empty.
23. The crossing table of 12.3 passes cell by cell for all four options at
    `C = 0.20, 0.40, 0.60, 0.80` with five alive, standard rations, ordered
    queue, quantum 8.
24. Unordered blocking succeeds at 97.8, 91.2, 80.2 and 64.8 percent for the same
    four contention values, and its failure inflicts `starvation`.
25. Spin failure inflicts `lock_convoy` at `C <= 0.70` and `livelock` above it.
26. Blocking at `C > 0.75` while holding another resource rolls a separate 12
    percent `deadlock_victim` termination, independently of the success roll.
27. Monitor `successP` is 0.97 at every contention value, and its failure costs 20
    blocks and inflicts `bit_rot`.
28. Waiting advances every non-null `fatalAfter` clock by `ticksCost`, makes
    `floor(ticksCost / 10)` real draws from the leg's table, and costs 340 quota
    at `C = 0.8` with standard rations and five alive.
29. `quote` and `quoteAll` consume zero `Rng` draws, asserted by comparing the
    stream state before and after 1000 calls.
30. A crossing retries at the recomputed contention, caps at four attempts, and
    advances the kernel by `ticksCost` real ticks per attempt.
31. All 49 cells of the resolved `operator` depot table in narrative bible 5.7
    pass, and the four tier factors scale correctly at legs 1 and 12.
32. Repair is capped at 30 points per visit for a `critical` Program, halves
    block cost for the daemon disc, and clears no affliction.
33. Recruit is available once per run and only after a derezz; the recruit
    receives 60 percent of the passive, full-strength actives with one fewer
    charge, a `-2` name suffix, and leaves the original tombstone in place.
34. The policy hint is unavailable at `kernel_space`, names the remedy at
    `novice`, and at `operator` and `architect` states only values read from the
    live snapshot.
35. A journal checkpoint rolls back to the checkpoint on a failure during the
    next leg only, costs that leg's dividend and one correctness mark, and a
    second purchase replaces the first rather than stacking.
36. `generateVerge` reproduces the 11.6 table at `F = 0.1`, `0.5` and `0.9` for
    all seven parameters, and is deterministic in the seed.
37. The four target yield rows of 11.4 are reproduced by four scripted traces,
    and yield at `F = 0.9` is between 40 and 50 percent of yield at `F = 0.1` for
    the same trace.
38. A use-after-free costs 25 quota, inflicts 6 integrity, blanks the mark for 4
    seconds, and forfeits the clean sweep bonus.
39. Reclamation run multipliers are 1.0, 0.6 and 0.36, a fourth run is refused,
    and the first run is free while the second and third cost 8 bandwidth each.
40. `LegSandbox` behaves as architecture 10.5 specifies for all six phases,
    asserted with a leg that throws in each phase in turn.
41. A leg whose `kernelConfig` throws is skipped with no resource change and no
    casualties, and the run continues to the next leg.
42. `LegRunner` drives a synthetic leg from `enter` to `exit` with no renderer,
    no DOM and no `@world` import, in under 200 ms for a 200-tick leg.
43. Two `LegRunner` instances given the same seed, the same leg and the same
    scripted decision sequence produce identical `LegOutcome` values and
    identical canonical event log hashes.
44. `tests/game/run-mutation.test.ts` from WP-17 still passes: no write to
    `RunState` happens outside `runStore.mutate`.
45. `git diff --exit-code src/kernel/types.ts src/game/types.ts` exits 0.
46. No `Math.random`, `Date.now` or `performance.now` appears anywhere under
    `src/game/`, asserted by a source scan.
47. `createKernel(REFERENCE_CONFIG).run(5000)` still passes `DET-D1`, `DET-D3`
    and `DET-D4`.

## Tests you must write

### `tests/game/travel/paceRations.test.ts`

| Case | Assertion |
|---|---|
| `pace table` | all six columns for all four paces, exact |
| `overhead agrees` | `quantumOverhead(q)` equals the stored column for 16, 8, 4, 2 |
| `rations table` | all four columns for all four rations, exact |
| `quota per tick` | 4.0, 2.5, 1.5, 0.8 at five alive; scales linearly in `aliveCount` |
| `two tables stay separate` | the kernel's `rations.ts` values and these values are asserted to differ, so a future merge of the two fails here |

### `tests/game/travel/travelLoop.test.ts`

| Case | Assertion |
|---|---|
| `80 segments, four paces` | cycles 126/200/360/704, ticks 133/80/53/38, quota 333/200/133/95, draws 13/8/5/4 |
| `per-tick equals closed form` | accumulated per-tick charges agree with the closed-form leg total within one tick's charge, for all four paces on all fourteen leg lengths |
| `leg progress` | `legProgress` is monotonic, starts at 0, ends at exactly 1, and never exceeds 1 |
| `boot sector` | `boot_sector` has zero segments and the travel loop is skipped |
| `draw cadence` | draws fire at ticks 10, 20, 30 and so on, with the trailing draw at remainder 5 or more |
| `credit cadence` | the emergency credit adds one draw per 20 ticks on top |
| `floors` | blocks and bandwidth never go negative over 100,000 seeded ticks |
| `quota underflow` | at zero quota rations are forced to `starved` and cannot be raised |
| `max ticks guard` | exceeding `maxTicks` ends the leg and records a runner diagnostic rather than a player-visible event |

### `tests/game/travel/degree.test.ts`

| Case | Assertion |
|---|---|
| `clamped` | a request outside `[1, workload.length]` is clamped and reported |
| `deterministic order` | raising admits ascending by `Pid`, lowering suspends descending by `Pid` |
| `convoy excluded` | constructing with a bound convoy pid throws |
| `frames available` | `framesAvailableToConvoy` falls as the degree rises |
| `knee exists` | throughput rises with the degree then falls once the fault rate crosses `thrashingThreshold`, asserted as a single maximum over a swept degree |

### `tests/game/afflictions.test.ts`

| Case | Assertion |
|---|---|
| `table` | all thirteen rows exact against narrative bible 7.1 |
| `citation correction` | every chapter cell printed as 5.3.4 in the bible is 5.3.3 here |
| `drain sums` | `thrashing` plus `bit_rot` drains 2.3 per tick |
| `fatal clock` | fatal fires at exactly `acquiredAtTick + fatalAfter`, not before |
| `no re-acquire` | acquiring a carried affliction is a no-op and leaves `acquiredAtTick` unchanged |
| `cure` | cure removes the affliction and its clock together |
| `repair does not cure` | a Program repaired to 100 with `bit_rot` still drains and its clock is unchanged |
| `remedy match` | `isCuredBy` matches all nine `AfflictionRemedy` kinds and rejects a near miss |

### `tests/game/convoy.test.ts`

| Case | Assertion |
|---|---|
| `status bands` | the four bands over `[0, 100]`, total and exhaustive |
| `status never disagrees` | 10,000 seeded integrity writes leave status consistent |
| `clamp` | integrity clamps to `[0, 100]` on every write |
| `lowest alive tie` | ties break by `ConvoyMemberId` ascending |
| `derezz once` | a Program that reaches 0 twice produces one epitaph |
| `derezz keeps member` | the convoy array still holds the derezzed member |
| `pid terminated` | the bound pid is terminated through the syscall table |
| `run failure` | `status` becomes `'failed'` only when every Program is derezzed |

### `tests/game/events/eventDeck.test.ts`

| Case | Assertion |
|---|---|
| `weighted draw` | over 100,000 draws from a five-entry table the empirical frequencies match the weights within 1 percent |
| `deterministic` | 10,000 draws are byte-identical across two runs and across snapshot and restore |
| `onlyIf filter` | an ineligible entry is never drawn and the remaining weights renormalise |
| `predicate throws` | a throwing `onlyIf` is false, records a diagnostic, and leaves the other weights unchanged |
| `empty eligible` | an empty eligible list returns null and fires nothing |
| `targets` | a role-targeted event picks only living Programs of that role; with none alive it fires with a null target and still applies its delta |
| `validate` | the four failure kinds are each named, and a valid table returns empty |

### `tests/game/crossing/contention.test.ts`

| Case | Assertion |
|---|---|
| `formula` | the three terms and their 0.50 / 0.30 / 0.20 weights, on six hand-built snapshots |
| `clamped` | the result is inside `[0, 1]` for every input, including a full wait queue |
| `empty system` | an empty process list gives 0 and not `NaN` |
| `hold pressure` | `meanHoldTicks` is the mean of the last sixteen acquisitions and is capped at one quantum |

### `tests/game/crossing/options.test.ts`

| Case | Assertion |
|---|---|
| `12.3 table` | every cell of the four-by-four table, exact |
| `unordered blocking` | 97.8, 91.2, 80.2, 64.8 percent, and `starvation` on failure |
| `spin failure` | `lock_convoy` at `C <= 0.70`, `livelock` above it, including the boundary at exactly 0.70 |
| `hold and wait` | a separate 12 percent `deadlock_victim` roll at `C > 0.75` while holding, independent of the success roll |
| `monitor flat` | `successP` is 0.97 at `C = 0`, 0.5 and 1.0; failure costs 20 blocks and inflicts `bit_rot` |
| `wait decay` | `C'` equals `C * 0.86 ^ (ticksCost / 10)` and the draws are real |
| `quote is pure` | 1000 `quoteAll` calls leave the `Rng` state unchanged |
| `retry cap` | four attempts maximum, each at the recomputed contention |
| `ticks simulated` | the kernel advances by `ticksCost` real ticks per attempt |

### `tests/game/depot/prices.test.ts`

| Case | Assertion |
|---|---|
| `operator table` | all 49 cells of the resolved 5.7 table |
| `tier factors` | 0.80, 1.00, 1.15, 1.35 at legs 1 and 12 |
| `independent rounding` | repair at leg 1 gives `16c + 9b`, not a single scaled pair |
| `repair cap` | 30 points maximum per visit for a `critical` Program |
| `daemon blocks` | the daemon disc halves repair block cost, rounded up |
| `recruit once` | a second recruit purchase is refused for the rest of the run |
| `hint tiers` | unavailable at `kernel_space`, names the remedy at `novice` |
| `checkpoint replaces` | a second checkpoint replaces the first |

### `tests/game/reclamation/verge.test.ts`

| Case | Assertion |
|---|---|
| `11.6 table` | all seven parameters at `F = 0.1`, 0.5, 0.9 |
| `deterministic` | the same leg id and seed give an identical layout across two generations |
| `time limits` | 90, 75, 65, 55 seconds for the four tiers |
| `live density` | live blocks are denser in the regions holding the largest leaked blocks |

### `tests/game/reclamation/scoring.test.ts`

| Case | Assertion |
|---|---|
| `yield formulas` | the three yield lines and the two multipliers |
| `coalesce cap` | `coalesceMultiplier` caps at 3.0, reached at a chain of 15 |
| `clean sweep` | 1.20 with no live reclaimed, 1.00 otherwise |
| `use after free` | 25 quota, 6 integrity, 4-second blank, bonus forfeit |
| `target rows` | four scripted traces hit the poor, median, strong and perfect rows |
| `fragmentation penalty` | the same trace at `F = 0.9` yields 40 to 50 percent of its `F = 0.1` result |
| `run multipliers` | 1.0, 0.6, 0.36, then refused; bandwidth charged on runs 2 and 3 only |

### `tests/game/legSandbox.test.ts`

A synthetic leg that throws in each of the six phases in turn, asserting the
fallback for each, that the run continues, and that a stage which throws in
`update` is disabled after one throw rather than on every frame.

### `tests/game/legRunner.test.ts`

| Case | Assertion |
|---|---|
| `entry order` | the nine entry steps happen in the specified order, asserted with a call log |
| `headless` | a full leg runs with `stageContext: null`, no DOM and no `@world` import |
| `speed` | a 200-tick leg completes in under 200 ms |
| `determinism` | the same seed, leg and decision sequence give identical outcomes and identical event log hashes |
| `exit order` | the eight exit steps happen in the specified order |
| `dividend` | the dividend is applied after `resourceDelta`, and reduced 25 percent on credit |
| `dedupe` | `objectivesMet` and `codexUnlocked` are appended de-duplicated with order preserved |
| `counterfactual` | a replay timeout leaves the slot null and the card still renders |
| `mutation` | every `RunState` write goes through `runStore.mutate` |

### `tests/game/economyCurve.test.ts`

The narrative bible 5.5 curve, reproduced end to end: thirteen legs at steady
pace, standard rations, five alive, `throughputFactor = 1.0`, no purchases, for
all three disc classes. Assert every row of the running-balance table, and assert
the three design statements: shell finishes at 373, daemon first goes negative
after leg 11 at -9, compiler first goes negative after leg 9 at -28. This test is
the whole economy in one file and a failure in it means a formula is wrong
somewhere upstream.

## Out of scope

- Any leg module. This package ships one synthetic test leg under `tests/` and
  no content.
- Epitaph copy, codex prose, event narration, man page text, depot flavour lines.
  This package ships the machinery and injects the copy.
- The reclamation minigame's input handling, camera, beam and 3D construction.
  Phase 2 and `@world` own those. This package owns the model and the scoring.
- Scoring weights. WP-17 owns `scoring.ts`; call it, do not tune it.
- `src/game/store*`, `src/game/save*`, `src/game/CommandBus.ts` and
  `src/game/replay/**`. Read them, call them, do not edit them.
- Anything under `src/kernel`, `src/render`, `src/world`, `src/ui`,
  `src/terminal`, `src/audio`, `src/design`, `src/platform`.
- The named diegetic structures. WP-13 registered eight throwing factories and
  the fourteen legs need more than eight. Reconciling that list is phase 2 work
  and it is not yours, but report the count you needed if a crossing anchor has
  no factory.
- Any change to the frame pipeline in architecture 2.2. You fill two slots in it.
- Adding a depot to `drowned_reach`, at any size, for any reason.

## Report back

State:

1. Pass or fail for each of the 47 acceptance criteria, by number.
2. The three verification command outcomes.
3. For every table you transcribed from the narrative bible, the values your
   implementation produced next to the values in the document: the 6.1 pace
   table, the 6.2 rations table, the 5.2 starting allocations, the 5.5 curve, the
   5.7 depot table, the 7.1 affliction table, the 11.6 Verge table, and the 12.3
   crossing table.
4. Confirmation that the kernel's rations table and the game's rations table were
   kept separate, and where each is used.
5. The three convoy status thresholds you set that no document pins, so a human
   can confirm them.
6. The exact interface of the `EpitaphCopySource` you left stubbed, so whichever
   package owns epitaph copy implements against it.
7. Whether WP-07 exposes the last sixteen acquisitions per sync primitive that
   `meanHoldTicks` needs. If it does not, the item filed against WP-07 and the
   stub you left.
8. Every `// TODO(astra):` left in the tree, with file and line.
9. Every document disagreement found, what you shipped, and which document you
   followed.
10. Confirmation that no frozen contract was edited, extended or shadowed, and
    that no file outside the owned list was created or modified.

---

## Scope correction against the shipped tree

Written 2026-09-16, after WP-18 merged (main at `07c03df`) and before WP-19
starts. Where this section disagrees with the text above, this section wins.
Each numbered item is a decision; report against them by number. Nothing
else is in flight; this package is alone on the tree.

### V1. Files: what exists, what does not, and the owned list restated

`src/game/index.ts`, `src/game/store/`, `src/game/RunDirector.ts`,
`src/game/LegRunner.ts`, `src/game/LegSandbox.ts` and
`tests/game/run-mutation.test.ts` do not exist, whatever architecture 4.2,
4.3 and 10.5 say. The store is `src/game/store.ts` (`createStore`, `Store<T>`
with `get`, `version`, `mutate`, `watch`, `subscribe`, `flush`) and the run
store factory is `src/game/runStore.ts` (`createRunStore`,
`createTelemetryStore`, `HudTelemetry`, `HudLeg`). Create `src/game/index.ts`
as the barrel and create `tests/game/run-mutation.test.ts` yourself (V21).

`src/app/loop.ts` is not modified. Its `SimHost` has one simulation hook,
`fixedUpdate(tick)`, plus `applyPendingCommands(tick)`, and no
`preTick`/`postTick` seam; the ordering of architecture 2.2 is realised inside
the host, not the loop (V2). `src/main.ts` is a self-contained placeholder
boot that imports none of the shipped packages; leave it alone.

Owned files beyond the package list: `src/game/index.ts`,
`src/game/travel/policyBinding.ts` (V3), `src/game/travel/workload.ts` (V5),
`src/app/RunHost.ts` (V2), `src/app/commandSinkAdapter.ts` (V12),
`src/game/tiers.ts` (V16), `tests/game/run-mutation.test.ts` and
`tests/game/boundaries.test.ts` (V21), `tests/game/runHost.test.ts`. Granted
edits to other packages' files, each exact and quoted in the pre-flight:
`src/game/CommandBus.ts` (V12), `src/game/replay/types.ts` and
`src/game/replay/headlessLegs.ts` and `src/game/replay/runReplay.ts` (V3, V5).
Nothing else outside the create list.

### V2. The frame seam lives in a headless host, and the browser boot is not this package

Create `src/app/RunHost.ts` exporting `createRunHost(deps): RunHost`, where
`RunHost implements SimHost` for the game layer only:
`applyPendingCommands(tick)` calls `bus.drain(tick)` and hands the outcomes to
the director (V16); `fixedUpdate(tick)` calls `director.preTick(tick)`,
`const events = kernel.step()`, `queue.push(events)`,
`director.postTick(tick, events)`, in that order; `flushState()` flushes the
run store and the telemetry store and fills `HudTelemetry` from
`kernel.invariantState()` (tick, `metrics.scheduling.cpuUtilisation`,
`metrics.memory.faultRate`, `config.thrashingThreshold`, the four policy ids,
the quantum, and `HudLeg` from the current leg); `routeEvents()` calls
`queue.drain(...)`; `variableUpdate`, `render`, `onFrameMetrics` and
`onRunStateChanged` forward to injected optional hooks and do nothing
headless. `queue` is `FrameEventQueue` from `@world`; consumers are
registered by the host's caller through `host.queue`. Nothing in `src/app`
constructs a renderer, a DOM element, an audio engine or a terminal in this
package. Assembling the browser application over this host (replacing
`src/main.ts`, wiring `createHud`, `createCodex`, `createTerminal`,
`AudioEngine`, `StageBuilder`, `createBackend` and the cards) is a separate
package that follows WP-20; write nothing toward it and list every host duty
you discovered for it under handoffs.

### V3. The dials write through a `PolicyBinding`, and it is the one replay uses

There is no `setSchedulerParams`. The quantum write is
`kernel.setScheduler(view.schedulerId, { quantum })`, where `schedulerId`
comes from `kernel.invariantState()` (not `kernel.config.scheduler`, which is
never updated by `setScheduler`). WP-18 defined `PolicyBinding` in
`src/game/replay/types.ts` with a `DEFAULT_POLICY_BINDING` that handles the
degree only and carries `// TODO(astra): WP-19 supplies the pace and rations
binding and replay must use the same one`. Create
`src/game/travel/policyBinding.ts` exporting `livePolicyBinding: PolicyBinding`
implementing pace (quantum through `setScheduler` as above), rations (V4) and
degree (`kernel.setDegreeOfMultiprogramming`), and replace the body of
`DEFAULT_POLICY_BINDING` in `replay/types.ts` with a re-export of it, removing
the marker. That is the granted edit to `replay/types.ts`. The `RunDirector`
applies the binding once after `populate` and again after every drained
command whose kind is `set_pace`, `set_rations` or `set_degree`, which is the
schedule `runReplay` already follows. At leg entry the config is also
pre-set (step 4 of entry) so the kernel is built with the right quantum;
applying the binding after `populate` is then a no-op and the test asserts it.

### V4. Rations: the kernel has no per-process reservation, so the binding is economic only

The kernel's `src/kernel/memory/rations.ts` exports `framesPerProcess` and
`validateFrameBudget` as pure functions and nothing in `src/kernel` calls
them; `FrameTable.allocate(space, page, pinned)` is internal; there is no
per-process floor, reservation or pin API on `Kernel` or `KernelImpl`. So the
"ceil(framesPerProgram) frames, pinned" write in section 4 has no target.
Ruling: the rations half of `livePolicyBinding` performs no kernel write in
this package and carries `// TODO(astra): kernel track adds a per-process frame
floor API; rations then reserves ceil(framesPerProgram) per bound Program`.
Rations remain fully real on the economy side: quota burn, integrity cost,
affliction rolls, and the forced-`starved` rule. The `two tables stay
separate` case still asserts the kernel table's values differ from the
game's, and the report states that `rations.ts` is unreferenced by the kernel.

### V5. Pace scales workload arrivals through a spawn transform shared with replay

`populate` is the only place workload processes are created, through
`LegSetupContext.spawn`, and the live runner must build that context with
WP-18's `createHeadlessSetupContext(kernel, run, rng, bindings)` (WP-18
ruling 8) so live and replay spawn identically. Arrival scaling therefore
goes into that function: add an optional fifth parameter
`transform?: (spec: ProcessSpec) => ProcessSpec` applied to every spec before
`kernel.spawn`, and create `src/game/travel/workload.ts` exporting
`paceSpawnTransform(pace): (spec) => spec` which returns the spec with
`arrival: Math.round(spec.arrival / PACE_TABLE[pace].workloadArrivalRate)`
(an arrival of 0 stays 0, so convoy Programs spawned at tick 0 are
unaffected). `runReplay` passes `paceSpawnTransform(policy.pace)` when it
builds its context. Those are the granted edits to `headlessLegs.ts` and
`runReplay.ts`; quote both. The "spawn or hold this tick's workload arrivals"
step in `preTick` is deleted: arrivals are the kernel's, fixed at spawn time.

### V6. The degree controller wraps the kernel's admission control, which decides the order

`kernel.setDegreeOfMultiprogramming(target)` reaches
`thrashing.ts:setDegree`, which throws above the configured admission ceiling
(`maximumDegree`), suspends the process with the largest working set first
(ties to the highest pid) until the active count fits, and never admits on a
raise: resumption happens in the pager's own update, one process per
`thrashingSuspendInterval` once the fault band has been healthy for
`thrashingRecoveryTicks`. There is no per-pid suspend or resume API.
`DegreeController` is therefore a thin wrapper: `set(target, at)` clamps to
`[1, ceiling]`, calls the kernel, and reports `admitted` and `suspended` by
diffing `view.suspended(pid)` over the workload pids before and after. The
ascending and descending pid rules in section 7 are dropped; the
`deterministic order` case becomes "the same request from the same state
moves the same processes", and `framesAvailableToConvoy` is
`totalFrames - sum(workingSet of active workload pids)` from
`view.metrics.memory.workingSets`. Report the ceiling's source and value.

### V7. Derezz terminates through the lifecycle with a reason, not through `kill`

The `kill` syscall always yields `killed_by_user` or `killed_by_parent` and
cannot carry a reason. `KernelImpl.lifecycle.exit(pcb, code, reason)` is the
function every kernel death path calls, including `kill`, so its accounting
is the kernel's own. `derezz` terminates the bound pid with
`kernel.lifecycle.exit(kernel.process(pid), 137, reason)` after the epitaph
is built. Define `TERMINATION_FOR_AFFLICTION: Readonly<Record<AfflictionId,
TerminationReason>>` in `afflictions/table.ts` (propose the mapping in the
pre-flight; the closed union has no `livelock`, `bit_rot` or `interrupt_storm`
reasons, so those map to the nearest member) and `drainDeathReason(member)`,
which picks the reason of the highest-drain affliction the Program carries,
or `starvation` when it carries none (the only afflictionless drains are the
`starved` rations cost and the emergency credit). The `pid terminated` case
asserts a `process.exited` event with the chosen reason. Because game-layer
deaths must replay, the same code runs in `RunDirector.postTick` and in the
`afterStep` hook the director registers through `registerHeadlessLeg` (V13).

### V8. Contention: `meanHoldTicks` has no data source; redefine the term

The sync subsystem records no acquisition history and no `servedAtTick`; the
snapshot carries `SyncPrimitive { id, kind, displayName, value, capacity,
holders, waitQueue (pids), ordered }` on `KernelSnapshot.syncPrimitives` and
the live waits on `InvariantView.syncWaits` as `{ generation, actor,
resource, operation, requestedAt, ... }`. Rule: `holdPressure` uses
`meanWaitAge(view, lock.id)`, the mean of `view.tick - wait.requestedAt` over
the waits currently queued on that primitive, 0 when none, capped at one
quantum as the bible caps hold time. It is snapshot-consistent, so a
provisional resume before a crossing quotes the same contention. `contention`
takes `InvariantView` rather than `KernelSnapshot` (the view is the cheap
per-frame read; `KernelSnapshot` is a full serialisation) and the six
hand-built fixtures are views. Report it as a document disagreement against
narrative 12.1 and file the last-sixteen ring against the kernel track; do
not add tracking to the sync subsystem in this package.

### V9. Streams come from `createRunStreams`, and the Rng API is `save`/`restore`/`fork`

`createRng(seed, label)` returns an `Rng` with `next`, `int(minInclusive,
maxExclusive)`, `chance`, `pick`, `shuffle`, `fork(label)`, `save()`,
`restore(state)`; forks are labelled `parent/label`. WP-18's
`createRunStreams(seed)` already builds `run`, `run/leg`, `run/events`,
`run/crossing`, `run/reclamation`, and `saveRunStreams` and
`restoreRunStreams` fix the order. `LegRunnerDeps.rng` becomes
`streams: RunStreams`; nothing in this package calls `createRng` or `fork`.
Note `int` is exclusive at the top, so the deck's `r = rng.int(1, total)` in
section 10 is `rng.int(1, total + 1)`.

### V10. The kernel surface the runner holds

The runner holds `ReturnType<typeof createKernel>` (`KernelImpl`), as
`terminalHost.ts` and the replay do, because `Kernel` (the interface) exposes
none of `invariantState`, `lifecycle`, `setDegreeOfMultiprogramming`,
`declareResource`, `spawn`, `allProgramsScripted` or the subsystems.
`LegRunnerDeps.createKernel` returns that type and is called with
`REPLAY_KERNEL_OPTIONS` overridden to `devBuild: true` and the invariant
harness on for the live run (WP-18's constraint: the live runner keeps
`devBuild` true; a live run that panicked is not replayable byte for byte,
which is expected). Spawn validation in `KernelImpl.spawn` requires `burst`
and `service` at least 1, `priority` at most 39 and integer fields; the
synthetic leg respects that.

### V11. Epitaphs: forty-eight templates exist in the bible, keyed by reason

Narrative 9 defines `EpitaphTemplate { id, reason, inscription, cause,
codexEntry, member?, legId? }` and the selection rule: uniform among
templates matching `reason`, filtered by `member` and `legId` where present,
drawn from the run's seeded stream. `EpitaphCopySource` is therefore
`{ templates(reason: TerminationReason): readonly EpitaphTemplate[] }` and
the selection rule lives in `convoy/derezz.ts`, drawing from `run/leg`. The
package still ships no copy: the injected source throws with a
`// TODO(astra): epitaph copy package transcribes narrative 9` marker and the
tests inject two templates per reason. Report the interface.

### V12. The bus, the sink and the deadlock strategy

`CommandBus.apply` records then mutates; `KernelMutators` has the four
setters and `syscall`; `Command` has `set_scheduler` (with `to` and
`quantum`), `set_replacement`, `set_disk_policy`, `set_allocation`,
`set_pace`, `set_rations`, `set_degree`, `use_ability`, `syscall`,
`interaction`, `terminal`. WP-15's `CommandSink` uses different field names
and has `set_deadlock_strategy`, which `Command` lacks. Granted edit to
`CommandBus.ts`: add `{ kind: 'set_deadlock_strategy'; to: DeadlockStrategy }`
to `Command`, `setDeadlockStrategy(strategy)` to `KernelMutators`, the
`describeChoice` and `commandFromRecord` branches, and extend the
`commandFromRecord` round-trip case in `tests/game/commandBus.test.ts`
(protected; quote-and-wait, ruled approved now, quote the insertion in the
commit message). `commandFromRecord` replays it; `scheduleDecisions` in
`runReplay` needs no change. Then create `src/app/commandSinkAdapter.ts`
exporting `sinkOverBus(bus, legId): CommandSink`, mapping each
`TerminalCommandRequest` to its `Command` with `origin { source: 'terminal',
legId }` and returning `{ ok: false, message }` when `dispatch` reports the
queue full. `CommandHandlers` is yours: `interaction(id, anchor, at)` looks
the `InteractionDef` up on the current leg, checks `enabledWhen` through the
sandbox, charges `cost` through `applyDelta` and refuses on an empty ledger
(V16); `useAbility` records nothing beyond the bus's own record and carries
`// TODO(astra): the abilities package implements convoy abilities`; `terminal`
is a no-op, since the terminal's effect was dispatched as its own command.

### V13. Replay identity: the director's headless half is registered, not duplicated

`RunDirector` exposes its per-tick work as `ReplayHooks` (`beforeStep`,
`afterStep`, `isComplete`) and the runner registers the current leg through
`registerHeadlessLeg(id, () => headlessOf(leg, director.hooks()))` at entry
and undoes it at exit. `beforeStep` is the `preTick` body (travel charge,
rations and affliction ticks, credit drain, event draws) driven from the
`streams` and `store` it is handed; `afterStep` is `postTick` minus the
score recompute and the decision resolution, which the live side keeps.
`initialRunState(seed, discClass, difficulty)` is the run's starting state
with `startingLedger` applied by the runner on top (it ships a zero ledger);
`noteExits`, `applyLegOutcome`, `observeLeg`, `startReplayRecord`,
`recordLegEntry` and `recordLegHash` are called as WP-18's handoff
prescribes, and `DecisionRecord.tick` is the kernel's leg-local tick. The
`determinism` case in `legRunner.test.ts` runs the same leg live and through
`runReplay` and asserts equal event log hashes; that is acceptance 43
restated and it is the assertion that keeps the counterfactual honest.

### V14. The counterfactual flow, against the shipped API

At exit: `observed = observeLeg(kernel.snapshot(), legEvents, bindings)`;
`plans = planCounterfactuals({ legId, seed, discClass, difficulty,
decisions, observed, kernel, policy, maxTicks })` (at most two, run
sequentially, each against `ReplayWorkerHandle.run(request, 1500)`);
`phraseCounterfactual({ baseline: observed, alternative, request, floor })`
for the first successful one. `DebriefView` gains
`counterfactual: Promise<string | null>` resolving to the sentence or `null`
on failure or timeout, which is what `createDebriefCard(doc, card, pending)`
consumes; `fillCounterfactual` from section 15 is not needed and is not
written. When `deps.replay` is null the promise resolves `null` immediately.
Also expose the `CodexCounterfactual` through `toCodexCounterfactual` on the
`DebriefView` so the host can call `codex.setCounterfactual`.

### V15. Cards, HUD and codex are consumers of this package's outputs

`LegRunner` emits typed notifications through `deps.onLegEvent`:
`{ kind: 'leg_unavailable', legId, index, reason }`, `{ kind: 'tombstone',
epitaph, memberName }`, `{ kind: 'panic', message, tick }`, `{ kind:
'debrief', view }`, `{ kind: 'crossing_open', def, context }`, `{ kind:
'depot_open', depot }`, `{ kind: 'reclamation_open', layout }`. Their shapes
match `createLegUnavailableCard`, `createTombstoneCard`, `createPanicCard`
and `createDebriefCard` option types so the boot package renders them without
translation. `Codex.signal` takes `{ kind: 'crossing' | 'leg_complete' ... }`
and the runner calls a `deps.codexSignal` hook with the same shape at the
right moments; `Hud.derezz.begin()` and `tombstone()` are called through
`deps.onDerezz` at the derezz pre-roll and the tombstone rise.

### V16. Difficulty tiers carry more than the resource factor

Narrative 13's table also sets, per tier, an affliction frequency multiplier
(0.60, 1.00, 1.35, 1.70), an affliction drain multiplier (0.75, 1.00, 1.10,
1.25), a `fatalAfter` multiplier (1.50, 1.00, 0.90, 0.80), a policy change
cost (free, free, 15 cycles, 25 cycles), a terminal command cost (free, free,
1 bandwidth on writes, 2 bandwidth on all) and the score multiplier. Create
`src/game/tiers.ts` with all seven columns as one `TIER_TABLE` and apply the
affliction three in `AfflictionClock` and `EventDeck.apply`, and the two
command costs in the director's handling of drained `CommandOutcome`s
(refusing the mutation and marking the record `costly` when the ledger cannot
pay). The section 7.1 and 12.3 tables are asserted at `operator`, where
every multiplier is 1.0.

### V17. Recruit under a closed `ConvoyMemberId`

`ConvoyMemberId` is the closed union `lumen | sable | orrery | kestrel |
vesper` in the frozen kernel types, so `LUMEN-2` cannot be a new id. The
recruit reuses the dead Program's id, sets `name` to `<NAME>-2`, `status` to
`nominal`, `integrity` to 100, `pid` to null until the next leg binds it, and
`abilityCharges` to the role's per-leg charges minus one; the original
`Epitaph` stays in `tombstones` and `member` on it still reads the shared id.
The 60 percent passive is recorded in a runner-side `recruits` table exposed
on the `LegRunner` for the abilities package to read. Report this as the
reading forced by the frozen union.

### V18. `LegSandbox` is architecture 10.5 verbatim, with one addition

Ship the class from 10.5 exactly, including `LegFailure`, `NULL_STAGE` and
`neutralOutcome`. The one addition: `onlyIf` and terminal handlers are not
in that listing, so add `predicate(def, run): boolean` (false on throw,
recorded) and use it from `EventDeck.eligible` through an injected
`predicate` function so `EventDeck` stays free of the sandbox type.

### V19. Verge and reclamation read `MemoryMetrics.externalFragmentation`

The field exists on `KernelSnapshot.metrics.memory` and on the view. The
round is headless and `submit(trace)` is the only input; `ReclamationTrace`
is `readonly { readonly atSeconds: number; readonly action: 'collect' |
'coalesce'; readonly blockId: number }[]`, and its type is exported for WP-20.

### V20. Journal checkpoint and boundary saves use the pure save functions

`buildSaveFile` and `checksumOf` are synchronous and pure; `persistSave` and
`SaveService` need IndexedDB. The runner takes `deps.persist: (input:
SaveFileInput, kind: 'boundary' | 'provisional') => void` and calls it at
every leg boundary with `kernel: null` and `rngStates: saveRunStreams(streams)`;
the journal checkpoint keeps the `SaveFile` returned by `buildSaveFile` in
memory and rolls back with `resumeRun(file, { buildKernel, populate })`. The
boot package binds `deps.persist` to a `SaveService`; tests inject a spy.

### V21. Two enforcement tests this package writes

`tests/game/run-mutation.test.ts`: wraps the run store's `get()` in a
deep-freezing proxy for the duration of a full synthetic leg, so any write
outside `mutate` throws, and asserts zero throws. `tests/game/boundaries.
test.ts`: in the pattern of `tests/ui/boundaries.test.ts` over `src/game`
excluding `src/game/workers/`, asserting no `Math.random`, `Date.now`,
`performance.now`, `new Date`, `localStorage`, `document` or `window`, and
no value import from `@world`, `@render`, `@ui`, `@audio`, `@terminal` or
`@app` except the two WP-18 worker imports. `src/app/RunHost.ts` may import
`@world/FrameEventQueue` as a value.

### V22. Numbers to report beside the documents

Every table the package lists in "Report back" item 3, plus `TIER_TABLE`
(V16), `TERMINATION_FOR_AFFLICTION` (V7) and the arrival transform's effect
on the synthetic leg's arrival ticks at the four paces (V5).

### V23. Pre-flight before writing

Read this section, then send a pre-flight listing: the exact diffs for the
four granted edits (V3, V5, V12); the `TERMINATION_FOR_AFFLICTION` mapping
(V7); the `RunHost` and `LegRunnerDeps` declarations as you will write them;
the `EpitaphCopySource` interface (V11); the `ReplayHooks` the director will
expose (V13); the `onLegEvent` union (V15); the commit plan by module; and
any finding needing a ruling, numbered. Wait for the reply before the first
commit. Every commit passes all four gates on its own and ends with both
attribution lines.

# WP-03: Scheduler foundation and the four single-queue policies

## Objective

When this package is done the repository has the scheduler registry, the shared
base class every policy extends, the universal tie-break, starvation detection,
metrics computation, and four working policies: FCFS, SJF, SRTF and priority.
Each reproduces its textbook Gantt chart to the tick, and each set of averages
matches the sim spec's test vector appendix exactly. `Kernel.setScheduler` swaps
policies mid-run. WP-04 adds the remaining three policies on top of what you
build here, so the base class and the registry are the contract WP-04 depends on.

## Two notes before you start

**Aging is on `SchedulerHooks`, not on `SchedulerPolicy`.** `SchedulerPolicy` is
frozen and has no aging method. Phase 6's entry point lives on a separate
`SchedulerHooks` object that the kernel holds alongside the policy, and the
`onAge` hook of section 6 below is on `SchedulerBase`. Neither goes on the frozen
interface. Older text that said to call aging on the policy was wrong.

**The reference determinism tests do not currently validate round robin.** The
kernel WP-02 shipped runs an internal `BootstrapFcfs`, so both `fcfs` and `rr`
resolve to FCFS until you replace it. The green determinism suite you inherit
therefore proves FCFS twice and proves nothing about round robin. This package
replaces the bootstrap and delivers the real `fcfs`; real round robin belongs to
WP-04. Nobody should read that green suite as RR coverage, and no report from
this package should imply it does.

## Prerequisites

WP-02 complete and green.

Files that must already exist:

- `src/kernel/types.ts` (frozen)
- `src/kernel/Kernel.ts` with the eleven-phase `step()` and the
  `BootstrapFcfs` private class you will delete
- `src/kernel/process/ProcessTable.ts`, `transitions.ts`
- `tests/kernel/fixtures/referenceConfig.ts`, `tests/kernel/canonical.ts`

## Required reading

- `02-KERNEL-SIM-SPEC.md` section 5.1 (common ground, the universal tie-break,
  metric definitions)
- `02-KERNEL-SIM-SPEC.md` section 5.2 (FCFS), 5.3 (SJF), 5.4 (SRTF), 5.5
  (priority)
- `02-KERNEL-SIM-SPEC.md` section 5.9 (starvation detection) and 5.10 (metrics
  computation)
- `02-KERNEL-SIM-SPEC.md` section 2.1 phases 6 and 7, and section 2.2's
  paragraphs "Aging before the scheduler decision" and "Scheduler decision before
  execution"
- `02-KERNEL-SIM-SPEC.md` section 16.3 (the CPU scheduling fixture table and the
  per-process detail table)
- `01-ARCHITECTURE.md` section 13.1 (adding a new scheduling algorithm), which
  describes the registry shape

## Files you will create

```
src/kernel/scheduler/registry.ts
src/kernel/scheduler/SchedulerBase.ts
src/kernel/scheduler/tieBreak.ts
src/kernel/scheduler/metrics.ts
src/kernel/scheduler/starvation.ts
src/kernel/scheduler/fcfs.ts
src/kernel/scheduler/sjf.ts
src/kernel/scheduler/srtf.ts
src/kernel/scheduler/priority.ts
src/kernel/scheduler/MinHeap.ts
tests/kernel/scheduler/workloadRunner.ts
tests/kernel/scheduler/fcfs.test.ts
tests/kernel/scheduler/sjf.test.ts
tests/kernel/scheduler/srtf.test.ts
tests/kernel/scheduler/priority.test.ts
tests/kernel/scheduler/metrics.test.ts
tests/kernel/scheduler/starvation.test.ts
```

## Files you may modify

```
src/kernel/Kernel.ts     (delete BootstrapFcfs; wire phases 6 and 7 to the registry;
                          complete setScheduler; make phase 10 a metrics dispatch
                          point, see the scope correction below. Nothing else in
                          this file.)
src/kernel/index.ts      (add the SCHEDULERS export)
tests/kernel/fixtures/referenceConfig.ts   (name FCFS explicitly, see below)
tests/kernel/determinism.test.ts           (name FCFS explicitly, see below)
```

Nothing else.

### Scope correction, 2026-09-12

This package required scheduling metrics while granting no way to wire them into
the kernel, and it required the reference fixtures to stop depending on an
ambiguous scheduler id while excluding those two files. Both were defects in the
package, not limits to work around. Corrected as follows.

**Phase 10 is now yours, but as a dispatch point rather than as your own code.**
Do not compute scheduling metrics inline in `Kernel.ts`. Phase 10 must call each
enabled subsystem's metrics recomputation through the hook mechanism WP-02 already
established, exactly the way phases 2, 3, 4 and 6 call their hooks. Then implement
the scheduling side of it in `src/kernel/scheduler/metrics.ts`.

This matters because phase 10 is contested. WP-05 recomputes
`MemoryMetrics.tlbHitRate` there, and it is being built at the same time as this
package. If you hard-code scheduling metrics into phase 10, WP-05 has to edit the
same lines and one of you loses work. If you make phase 10 a dispatch point, WP-05
plugs in through its own hook and never touches the file again. Leave a
`// TODO(astra): WP-05 registers its metrics hook here` marker at the registration
site so the next agent can see where it belongs.

**Completion and dispatch accounting** is in scope for the same reason: the
metrics are not computable without it. Keep the edits at the existing call sites
and do not reorder or rename the eleven phases.

**The two test files:** change them to name `fcfs` explicitly rather than relying
on the registry resolving `rr` to the bootstrap. That removes the RR ambiguity
this package already discloses. Change the scheduler id and nothing else. Do not
alter an assertion, a seed, a tick count or the scanner policy. Those tests are
the determinism baseline for the whole project and 226 tests currently pass.

**Report the exact line ranges you touched in `Kernel.ts`**, so the three agents
working beside you can be told.

## Frozen contracts

From `src/kernel/types.ts`. These may not be edited. If this package cannot be
completed without changing one, stop and report per the escalation procedure.

```ts
export type SchedulerId =
  | 'fcfs' | 'sjf' | 'srtf' | 'priority' | 'priority_aging' | 'rr' | 'mlfq';

export interface SchedulerParams {
  /** Round-robin / MLFQ time quantum, in ticks. */
  quantum: number;
  /** MLFQ only. Quantum per level, index 0 = highest priority. */
  levelQuanta?: readonly number[];
  /** Ticks after which a starved process gains a priority level. 0 disables aging. */
  agingInterval: number;
  /** Ticks in the ready queue before a starvation warning fires. */
  starvationThreshold: number;
  /** Ticks in the ready queue before the process is derezzed. */
  starvationFatalThreshold: number;
  preemptive: boolean;
}

export interface SchedulingDecision {
  /** Process to run this tick, or null to idle the CPU. */
  readonly next: Pid | null;
  /** True when this differs from the previously running process. */
  readonly isContextSwitch: boolean;
  /** Why, in words the codex can show the player. */
  readonly rationale: string;
}

/**
 * Pluggable CPU scheduling policy. One implementation per algorithm in
 * src/kernel/scheduler. Each must be independently unit-testable against a
 * fixture of arrival times and burst lengths with a known-correct Gantt chart.
 */
export interface SchedulerPolicy {
  readonly id: SchedulerId;
  readonly displayName: string;
  readonly isPreemptive: boolean;
  configure(params: SchedulerParams): void;
  onAdmit(pcb: ProcessControlBlock, ctx: SchedulerContext): void;
  onTick(ctx: SchedulerContext): SchedulingDecision;
  onBlock(pcb: ProcessControlBlock, ctx: SchedulerContext): void;
  onUnblock(pcb: ProcessControlBlock, ctx: SchedulerContext): void;
  onExit(pcb: ProcessControlBlock, ctx: SchedulerContext): void;
  /** Read-only view for the 3D world and the HUD. Must not allocate per tick. */
  snapshot(): SchedulerSnapshot;
}

export interface SchedulerContext {
  readonly tick: Tick;
  readonly rng: Rng;
  readonly params: Readonly<SchedulerParams>;
  readonly running: Pid | null;
  /** Ticks the running process has held the CPU in its current slice. */
  readonly sliceElapsed: number;
  process(pid: Pid): ProcessControlBlock | undefined;
  readonly readyQueue: readonly Pid[];
  emit(event: KernelEvent): void;
}

export interface SchedulerSnapshot {
  readonly policy: SchedulerId;
  readonly running: Pid | null;
  /** Outer index is the queue level. Single-level policies use one entry. */
  readonly queues: readonly (readonly Pid[])[];
  readonly quantumRemaining: number;
  readonly metrics: SchedulingMetrics;
}

export interface SchedulingMetrics {
  readonly averageWaitingTime: number;
  readonly averageTurnaroundTime: number;
  readonly averageResponseTime: number;
  readonly throughput: number;
  readonly cpuUtilisation: number;
  readonly contextSwitches: number;
  /** Ready time of the longest-waiting process. Feeds the starvation warning. */
  readonly worstWait: number;
}
```

Note that `SchedulerContext.emit` takes a fully-formed `KernelEvent` including
`tick` and `seq`. Provide the context object from `Kernel.ts` with an `emit` that
stamps and forwards to the bus, so policies never construct those two fields.

## Specification

### 1. `src/kernel/scheduler/tieBreak.ts`

The universal tie-break from sim spec 5.1. Wherever a policy's primary key ties,
the order is lower `arrivalTick` first, then lower `pid` first.

```ts
export function tieBreak(a: ProcessControlBlock, b: ProcessControlBlock): number {
  if (a.arrivalTick !== b.arrivalTick) return a.arrivalTick - b.arrivalTick;
  return a.pid - b.pid;
}
```

Both keys are total orders over live processes, so the combined key never ties.
**This rule is mandatory for every policy and every comparator in this package
and in WP-04.** Sorting must always use an explicit comparator implementing it.
A comparator that can return 0 for two distinct processes is a determinism bug,
and the determinism test will find it eventually rather than immediately, which
is why the rule is stated this strongly.

Export an assertion helper `assertTotalOrder(cmp, samples)` used by the tests to
prove a comparator never returns 0 for distinct pids.

### 2. `src/kernel/scheduler/MinHeap.ts`

A binary min-heap of `Pid` with an injected comparator over PCBs. SJF, SRTF and
priority all use it.

- `push(pid)`, `peek(): Pid | null`, `pop(): Pid | null`, `remove(pid): boolean`,
  `rebuild()`, `readonly size: number`, `toArray(): readonly Pid[]`.
- `toArray()` returns the heap in **sorted order**, not heap order, because
  `SchedulerSnapshot.queues` is drawn by the world layer as a procession and heap
  order would look arbitrary. Cache the sorted array and invalidate on mutation
  so `snapshot()` does not allocate per tick.
- `rebuild()` re-heapifies in O(n). The priority policy calls it when phase 6
  has changed any ready process's priority.
- The comparator receives PCBs, not pids, so the heap holds a `process(pid)`
  accessor injected at construction.

### 3. `src/kernel/scheduler/SchedulerBase.ts`

An abstract class implementing the parts of `SchedulerPolicy` that are identical
across policies, so WP-04's three policies inherit the same behaviour.

Responsibilities:

- Store `params` from `configure`. `configure` may be called mid-run by
  `setScheduler`, and must not lose queue membership.
- Maintain the policy's own ordered structure. Per sim spec 5.1, the kernel owns
  the ready set and `SchedulerContext.readyQueue` is the authoritative membership
  set in **insertion order**; a policy that needs a different order maintains its
  own structure and uses `readyQueue` only to check membership.
- Provide `protected rationale(next, reason)` that builds the
  `SchedulingDecision.rationale` string. Rationale strings are player-facing
  through the codex, so write them plainly, with no em dashes, and name the
  concept: `'shortest remaining service, 4 ticks against 9'`,
  `'quantum expired after 4 ticks'`, `'head of the arrival queue'`.
- Provide `protected buildSnapshot(queues, quantumRemaining, metrics)`.
  `snapshot()` **must not allocate per tick**: reuse a single snapshot object and
  a single queues array, mutating them in place. The frozen type marks them
  `readonly`, which is a compile-time promise to the consumer, not a runtime
  freeze.
- Provide the default `onBlock`, `onUnblock`, `onExit` that add and remove from
  the policy structure. A policy overrides only what differs.

The base class does **not** implement `onTick`. Every policy writes its own.

### 4. `src/kernel/scheduler/registry.ts`

```ts
export type SchedulerFactory = () => SchedulerPolicy;
export const SCHEDULERS: Readonly<Record<SchedulerId, SchedulerFactory>>;
export function createScheduler(id: SchedulerId, params: SchedulerParams): SchedulerPolicy;
```

Register all seven ids now. The three WP-04 owns (`priority_aging`, `rr`,
`mlfq`) map to a factory that throws
`new Error('not implemented: <id>')` above
`// TODO(astra): WP-04 implements this policy`. WP-04 replaces those three
entries and touches nothing else in this file.

`createScheduler` calls `configure(params)` before returning.

The registry is the only place a `SchedulerId` maps to an implementation.
`Kernel.setScheduler` goes through it.

### 5. `src/kernel/scheduler/metrics.ts`

Implement sim spec 5.10 exactly:

```
turnaround = c - a          (completion tick minus arrival tick)
waiting    = turnaround - b (turnaround minus total service)
response   = f - a          (first dispatch tick minus arrival tick)
```

Averages are the unweighted mean over completed processes. `throughput` is
completed processes per 100 ticks. `cpuUtilisation` is the fraction of elapsed
ticks in which some process ran. `worstWait` is `max(tick - readySince)` over
currently-ready processes.

```ts
export function computeSchedulingMetrics(k: MetricsInput): SchedulingMetrics {
  const done = k.completed;
  const n = done.length;
  const sum = (f: (p: CompletedRecord) => number) => done.reduce((s, p) => s + f(p), 0);
  return {
    averageWaitingTime:    n === 0 ? 0 : sum(p => p.turnaround - p.totalService) / n,
    averageTurnaroundTime: n === 0 ? 0 : sum(p => p.turnaround) / n,
    averageResponseTime:   n === 0 ? 0 : sum(p => p.firstRunTick - p.arrivalTick) / n,
    throughput:            k.tick === 0 ? 0 : (n * 100) / k.tick,
    cpuUtilisation:        k.tick === 0 ? 0 : k.busyTicks / k.tick,
    contextSwitches:       k.contextSwitches,
    worstWait:             Math.max(0, ...k.readyWaits),
  };
}
```

Three rules that are not optional:

- `turnaround`, `totalService` and `firstRunTick` are recorded on a completion
  record **when the process completes**, so this function never walks history.
- `busyTicks` and `contextSwitches` are integer counters carried in the snapshot,
  so restore is exact.
- Every division is guarded against a zero denominator, and the `Math.max` spread
  is guarded by the leading `0`, because spreading an empty array gives
  `-Infinity` and `canonical()` rejects it.

Never accumulate an average into a float across ticks. Recompute. This is the
rule test `DET-D2` exists to catch.

### 6. `src/kernel/scheduler/starvation.ts`

Phase 6's starvation half, from sim spec 5.9. For each ready process in
**ascending pid order**:

1. `waited = tick - readySince`. A process not in `ready` has
   `readySince === null` and is skipped.
2. Convoy modifier: if the PCB's `convoyMemberId === 'sable'`, multiply both
   thresholds by 3 for this process only.
3. If `waited === effectiveWarningThreshold`, emit
   `process.starving { pid, waitedTicks: waited, fatal: false }`. **Strict
   equality**, so the warning fires exactly once per residence rather than every
   tick afterwards.
4. If `waited >= effectiveFatalThreshold`, emit
   `process.starving { pid, waitedTicks: waited, fatal: true }`, then terminate
   the process with `terminationReason: 'starvation'` via transition T8.
5. `worstWait` is the maximum `waited` over all ready processes, recomputed in
   phase 10.

Phase 6's aging half belongs to WP-04, because only `priority_aging` and `mlfq`
use it. Export the phase-6 entry point as
`ageAndDetectStarvation(ctx, policy)` on the `SchedulerHooks` object, separate
from the frozen `SchedulerPolicy`, and have it call `policy.onAge?.(ctx)` before
the starvation loop, so WP-04 can add aging without editing this file. Aging must run before the scheduler decision, because a
process that just aged into the top priority must not lose the CPU for one more
tick.

Add `onAge?(ctx: SchedulerContext): void` to `SchedulerBase` as an optional
protected hook. It is not on the frozen `SchedulerPolicy` interface and must not
be added to it; the registry returns `SchedulerBase` subclasses, so the kernel
can feature-test for it.

### 7. `src/kernel/scheduler/fcfs.ts`

Sim spec 5.2. If a reference implementation is already present in the repository,
verify it against this section line by line and report any difference rather than
silently keeping it.

- **Selection.** The head of the kernel's insertion-ordered ready queue.
- **Preemption.** None. `isPreemptive = false`. Once dispatched, a process runs
  until it blocks or finishes.
- **Tie-break.** Insertion order is already a total order. Two processes entering
  `ready` in the same phase of the same tick are inserted by `tieBreak`.
- **Data structure.** A `Pid[]` used as a FIFO: push on the tail, shift on the
  head. `snapshot().queues` is `[thatArray]`.

Do not use `Array.prototype.shift` in the hot path; it is O(n). Use a head index
and compact when the head passes half the array length.

### 8. `src/kernel/scheduler/sjf.ts`

Sim spec 5.3.

- **Selection.** The ready process with the smallest `serviceRemaining`.
- **Preemption.** None. A shorter arrival waits for the running process to
  finish.
- **Tie-break.** `tieBreak`.
- **Comparator:**

```ts
const sjfCmp = (a: PCB, b: PCB) =>
  a.serviceRemaining !== b.serviceRemaining
    ? a.serviceRemaining - b.serviceRemaining
    : tieBreak(a, b);
```

- **Data structure.** The min-heap. `onAdmit` and `onUnblock` push, `onTick`
  peeks. Because `serviceRemaining` of ready processes never changes while they
  wait, the heap stays valid without a decrease-key operation.

Also implement the exponential-average next-burst estimator from sim spec 5.3:

```
tau[n+1] = alpha * t[n] + (1 - alpha) * tau[n]      alpha = 0.5, tau[0] = spec.burst
```

Store it in a side table keyed by pid (not on the frozen PCB), recompute it when
a burst completes, and expose it as `estimatedNextBurst(pid)` for the terminal's
`top` command in WP-16. A tuning flag `useEstimatedBurst` switches SJF and SRTF
onto the estimate; the default is false so the single-burst fixtures match the
textbook.

### 9. `src/kernel/scheduler/srtf.ts`

Sim spec 5.4.

- **Selection.** The ready-or-running process with the smallest
  `serviceRemaining`.
- **Preemption.** Preemptive. On every tick, if any ready process has
  `serviceRemaining` **strictly less than** the running process's
  `serviceRemaining`, preempt. The strict comparison is load-bearing: with `<=`,
  an arrival of exactly equal remaining time causes a context switch that buys
  nothing and breaks fixture `SCHED-SRTF-1`.
- **Data structure.** The same min-heap as SJF plus a check of the heap root
  against the running process each tick. The running process is **not** in the
  heap while it runs; it is pushed back on preemption with its decremented
  `serviceRemaining`.

### 10. `src/kernel/scheduler/priority.ts`

Sim spec 5.5.

- **Selection.** The ready process with the numerically smallest `priority`.
  Lower number means higher priority.
- **Preemption.** Governed by `SchedulerParams.preemptive`. When true, an
  arriving or unblocking process with **strictly smaller** `priority` than the
  running process preempts it. When false, the running process keeps the CPU
  until it blocks or finishes. The `priority` id defaults to non-preemptive,
  matching the worked example.
- **Tie-break.** `tieBreak`, which makes equal-priority processes behave like
  FCFS among themselves.
- **Data structure.** A min-heap keyed by `(priority, arrivalTick, pid)`. Because
  `priority` is mutable under aging, the heap is rebuilt whenever any ready
  process's priority changes: keep a dirty flag set by phase 6 and re-heapify at
  most once per tick.
- **Indefinite blocking is deliberate.** The `priority` policy forces
  `agingInterval` to 0 regardless of what is passed in `SchedulerParams`, so it
  starves. It is the policy the player is meant to lose a Program to before they
  are shown aging. Implement the override in `configure` and write a test for it.

### 11. Wiring into `Kernel.ts`

Delete `BootstrapFcfs` entirely. Then:

- Phase 6 calls `ageAndDetectStarvation(ctx, policy)`.
- Phase 7 builds the `SchedulerContext` and calls `policy.onTick(ctx)`, then
  applies the decision per sim spec 2.1 phase 7: outgoing moves
  `running -> ready` unless it left for another reason, incoming moves
  `ready -> running`, `lastScheduledTick` set, `contextSwitches` incremented,
  `context.switch` emitted with the policy's `rationale`.
- `sliceElapsed` is the count of ticks **already executed** in this slice, so the
  first tick of a slice sees 0 and the preemption test is `sliceElapsed >= quantum`,
  never `>`. Preemption is decided before the tick is spent, so a quantum of 4
  means the process runs ticks 0, 1, 2, 3 and is preempted at the decision made
  during tick 4.
- `setScheduler(id, params?)` constructs the new policy through the registry,
  merges `params` over the existing `SchedulerParams`, and re-admits every
  currently ready process into the new policy in **ascending pid order** so the
  swap is deterministic. Record the swap by emitting `context.switch` only if the
  decision actually changes the running process.

## Acceptance criteria

1. `npm run typecheck` exits 0.
2. `npm run test` exits 0.
3. `npm run build` exits 0.
4. Fixtures `SCHED-FCFS-1` and `SCHED-FCFS-2` pass with the exact Gantt strings
   and averages in sim spec 16.3.
5. Fixtures `SCHED-SJF-1` and `SCHED-SJF-1F` pass.
6. Fixtures `SCHED-SRTF-1` and `SCHED-SRTF-1S` pass, including the four-row
   per-process detail table.
7. Fixture `SCHED-PRIO-1` passes, including the five-row per-process detail
   table.
8. Every comparator in this package passes `assertTotalOrder` over 500 distinct
   PCB pairs: it never returns 0 for two distinct pids.
9. `SchedulerPolicy.snapshot()` allocates nothing after the first call. Verified
   by a test that calls `snapshot()` 10,000 times and asserts the returned object
   identity is stable and that the queues array identity is stable.
10. `BootstrapFcfs` no longer appears anywhere in `src/`.
11. `setScheduler` from each of the four implemented ids to each of the other
     three, mid-run, leaves the ready set unchanged in membership and produces no
     illegal transition.
12. Registry entries for `priority_aging`, `rr` and `mlfq` throw with a message
     starting `'not implemented:'` and carry a `// TODO(astra):` naming WP-04.
13. `git diff --exit-code src/kernel/types.ts src/game/types.ts` exits 0.
14. The forbidden-identifier scan still returns zero matches.

## Tests you must write

### `tests/kernel/scheduler/workloadRunner.ts`

Shared helpers, not a test file. The four scheduler test files import from it.

```ts
export interface WorkloadRow {
  readonly name: string;
  readonly arrival: number;
  readonly burst: number;
  readonly priority?: number;
}

/** Runs the workload to completion under the given policy and returns the trace. */
export function runWorkload(
  id: SchedulerId,
  params: Partial<SchedulerParams>,
  rows: readonly WorkloadRow[],
  maxTicks?: number,
): WorkloadResult;

export interface WorkloadResult {
  /** 'P1[0-24] P2[24-27] P3[27-30]', built from context.switch events. */
  readonly gantt: string;
  readonly perProcess: ReadonlyMap<string, { waiting: number; turnaround: number; response: number }>;
  readonly averages: { waiting: number; turnaround: number; response: number };
  readonly contextSwitches: number;
  readonly dispatches: number;
  readonly quantumExpiries: number;
  readonly finalLevels: ReadonlyMap<string, number>;
  readonly events: readonly KernelEvent[];
}
```

The Gantt string is built from `context.switch` events plus the completion tick,
formatted as `NAME[start-end]` segments joined by single spaces. Contiguous
segments for the same process are **not** merged, because sim spec 5.7 says the
world layer draws five separate slices for P1's tail even though they are
contiguous. Build the string from the dispatch record, not from a post-hoc merge.

Averages assert with a tolerance of 1e-9.

### `tests/kernel/scheduler/fcfs.test.ts`

| Fixture | Workload | Assertion |
|---|---|---|
| `SCHED-FCFS-1` | P1: 0,24; P2: 0,3; P3: 0,3, submitted P1,P2,P3 | gantt `'P1[0-24] P2[24-27] P3[27-30]'`; averages waiting 17.0, turnaround 27.0, response 17.0; contextSwitches 3; per-process waiting 0/24/27, turnaround 24/27/30, response 0/24/27 |
| `SCHED-FCFS-2` | same, submitted P2,P3,P1 | gantt `'P2[0-3] P3[3-6] P1[6-30]'`; averages waiting 3.0, turnaround 13.0, response 3.0 |
| `convoy effect` | the two fixtures together | `FCFS-1` average waiting is strictly greater than `FCFS-2` average waiting, and the two workloads are identical in total service |
| `non-preemptive` | a priority-1 process arriving at tick 1 against a running priority-9 process | no `context.switch` occurs before the running process completes |

### `tests/kernel/scheduler/sjf.test.ts`

| Fixture | Workload | Assertion |
|---|---|---|
| `SCHED-SJF-1` | P1: 0,6; P2: 0,8; P3: 0,7; P4: 0,3 | gantt `'P4[0-3] P1[3-9] P3[9-16] P2[16-24]'`; averages waiting 7.0, turnaround 13.0, response 7.0; per-process waiting P1 3, P2 16, P3 9, P4 0 |
| `SCHED-SJF-1F` | same workload under fcfs, order P1..P4 | gantt `'P1[0-6] P2[6-14] P3[14-21] P4[21-24]'`; averages waiting 10.25, turnaround 16.25, response 10.25 |
| `SJF beats FCFS` | the two above | SJF average waiting is strictly less than FCFS average waiting on the same workload |
| `heap validity` | 200 admits and 200 pops with random service times from a seeded Rng | popped order is exactly the order given by sorting with `sjfCmp` |
| `estimator` | tau[0] = 10, observed bursts 6, 4, 6, 4, 13, 13, 13 with alpha 0.5 | the estimate sequence is a strictly-defined series each test asserts to 1e-9; assert the recurrence rather than a table |

### `tests/kernel/scheduler/srtf.test.ts`

| Fixture | Workload | Assertion |
|---|---|---|
| `SCHED-SRTF-1` | P1: 0,8; P2: 1,4; P3: 2,9; P4: 3,5 | gantt `'P1[0-1] P2[1-5] P4[5-10] P1[10-17] P3[17-26]'`; averages waiting 6.5, turnaround 13.0, response 4.25; contextSwitches 5; per-process P1 waiting 9 turnaround 17 response 0, P2 0/4/0, P3 15/24/15, P4 2/7/2 |
| `SCHED-SRTF-1S` | same workload under sjf | gantt `'P1[0-8] P2[8-12] P4[12-17] P3[17-26]'`; averages waiting 7.75, turnaround 14.25, response 7.75 |
| `strict comparison` | a process arrives with `serviceRemaining` exactly equal to the running process's | zero `context.switch` events fire on that tick |
| `running not in heap` | mid-run | the heap does not contain the running pid, and after preemption it does, with the decremented `serviceRemaining` |

### `tests/kernel/scheduler/priority.test.ts`

| Fixture | Workload | Assertion |
|---|---|---|
| `SCHED-PRIO-1` | P1: 0,10,p3; P2: 0,1,p1; P3: 0,2,p4; P4: 0,1,p5; P5: 0,5,p2 | gantt `'P2[0-1] P5[1-6] P1[6-16] P3[16-18] P4[18-19]'`; averages waiting 8.2, turnaround 12.0, response 8.2; per-process P1 6/16/6, P2 0/1/0, P3 16/18/16, P4 18/19/18, P5 1/6/1 |
| `preemptive flag` | `preemptive: true`, a priority-0 process arrives at tick 3 against a running priority-5 process | exactly one `context.switch` fires at tick 3 |
| `strictly smaller` | `preemptive: true`, an arriving process has priority equal to the running one | zero `context.switch` fires |
| `aging forced off` | `configure({ agingInterval: 10, ... })` on the `priority` policy | the effective `agingInterval` reads 0 and a long-waiting low-priority process never has its `priority` reduced |
| `starves` | one priority-9 process and a stream of priority-1 arrivals every 4 ticks, `starvationFatalThreshold` 300 | the priority-9 process terminates with `terminationReason === 'starvation'` |
| `equal priority is FCFS` | five processes all at priority 4 with staggered arrivals | dispatch order equals ascending arrival order |

### `tests/kernel/scheduler/metrics.test.ts`

| Case | Assertion |
|---|---|
| `empty` | with zero completed processes every average is 0 and nothing is `NaN` or `Infinity` |
| `worstWait empty ready set` | `worstWait` is 0, not `-Infinity` |
| `throughput` | 8 completions at tick 400 gives 2.0 |
| `cpuUtilisation` | 300 busy ticks out of 400 gives 0.75 |
| `recomputed not accumulated` | run 500 ticks, snapshot the metrics object, run 0 more ticks, recompute: the values are bit-identical, proving no accumulation |
| `canonical safe` | `canonical(metrics)` never throws across a 5000-tick run of `REFERENCE_CONFIG` |

### `tests/kernel/scheduler/starvation.test.ts`

| Case | Assertion |
|---|---|
| `warning fires once` | a process held ready for 400 ticks with threshold 120 emits exactly one `process.starving` with `fatal: false` |
| `fatal terminates` | the same process at threshold 300 emits `process.starving { fatal: true }` and then transitions to `zombie` with `terminationReason === 'starvation'` |
| `SABLE modifier` | a PCB with `convoyMemberId === 'sable'` emits its warning at tick 360, not 120, and its fatal at 900, not 300 |
| `ascending pid order` | with three processes crossing the threshold on the same tick, the three `process.starving` events appear in ascending pid order |
| `skips non-ready` | a process in `waiting` with `readySince === null` never emits `process.starving` |
| `worstWait` | with ready waits of 3, 40 and 12, `worstWait` is 40 |

## Out of scope

- `src/kernel/scheduler/priorityAging.ts`, `rr.ts`, `mlfq.ts` and the golden
  Gantt files. WP-04 owns them. Register the three ids as throwing stubs and stop.
- Phase 6's **aging** half. Provide the `onAge` hook and call it; do not
  implement aging for any policy.
- `src/kernel/memory/**`, `sync/**`, `deadlock/**`, `storage/**`, `io/**`,
  `fs/**`, `security/**`, `syscall/**`, `invariants.ts`.
- Any change to `Kernel.ts` beyond deleting `BootstrapFcfs`, wiring phases 6 and
  7 to the registry, and completing `setScheduler`. Five other wave-2 packages
  read this file; every extra line you touch is a merge conflict.
- Anything outside `src/kernel/` and `tests/kernel/`.

## Report back

State:

1. Pass or fail for each of the fourteen acceptance criteria, by number.
2. The three verification command outcomes.
3. For each of the seven fixtures in sim spec 16.3 that this package covers, the
   produced Gantt string and the three averages, so a human can eyeball them
   against the table.
4. If a reference FCFS implementation was present, whether it matched sim spec
   5.2, and every line where it did not.
5. The exact signature of the `onAge` hook you added to `SchedulerBase`, so WP-04
   can implement against it.
6. Every `// TODO(astra):` left in the tree, with file and line.

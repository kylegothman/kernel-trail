# WP-04: Aging, round robin, MLFQ and the Gantt golden files

## Objective

When this package is done all seven scheduler policies exist and every scheduling
fixture in the sim spec's test vector appendix passes. Priority-with-aging turns
the starvation case of WP-03 into a survivable one and proves it with two numbers.
Round robin reproduces the textbook quantum-sensitivity table. MLFQ implements
three levels, demotion on quantum expiry, preemption by a higher-level arrival,
voluntary release that keeps the level, and promotion by aging. A golden-file
suite pins every Gantt chart so a future refactor cannot quietly change one.

## Two notes before you start

**Aging is on `SchedulerHooks`, not on `SchedulerPolicy`.** `SchedulerPolicy` is
frozen and has no aging method. Phase 6's entry point lives on a separate
`SchedulerHooks` object that the kernel holds alongside the policy, and the
`onAge` hook this package implements is on `SchedulerBase`. Neither goes on the
frozen interface. Older text that said to call aging on the policy was wrong.

**This package is where round robin first gets tested.** Before WP-03 replaced
the bootstrap, both `fcfs` and `rr` resolved to an internal `BootstrapFcfs`, so
the reference determinism tests were passing under FCFS in both cases and
validated nothing about round robin. WP-03 replaced the bootstrap and delivered
real FCFS. Real round robin is yours, which means `SCHED-RR-1`, `SCHED-RR-2a`,
`SCHED-RR-2c` and the quantum-sensitivity table are the first genuine RR coverage
in the repository. Treat a green suite inherited from WP-02 or WP-03 as no
evidence about `rr` at all.

## Prerequisites

WP-03 complete and green.

Files that must already exist:

- `src/kernel/scheduler/SchedulerRegistry.ts` (the scaffold's name; there is no lowercase registry.ts) with the three throwing stubs you replace
- `src/kernel/scheduler/SchedulerBase.ts` with the `onAge` hook
- `src/kernel/scheduler/tieBreak.ts`, `MinHeap.ts`, `metrics.ts`, `starvation.ts`
- `src/kernel/scheduler/priority.ts`
- `tests/kernel/scheduler/workloadRunner.ts`

## Required reading

- `02-KERNEL-SIM-SPEC.md` section 5.1 (common ground and the universal
  tie-break), because every rule there applies here too
- `02-KERNEL-SIM-SPEC.md` section 5.5 (priority), which `priority_aging` extends
- `02-KERNEL-SIM-SPEC.md` section 5.6 (priority with aging) in full, including
  the aging rule, the reset rule and both halves of the worked example
- `02-KERNEL-SIM-SPEC.md` section 5.7 (round robin) in full, including the
  same-tick ordering rule, the quantum sensitivity table and the pace mapping
- `02-KERNEL-SIM-SPEC.md` section 5.8 (MLFQ) in full. Every parameter changes the
  behaviour, so read all of it, especially the tick-by-tick trace
- `02-KERNEL-SIM-SPEC.md` section 2.2, the paragraphs "Aging before the scheduler
  decision" and "Scheduler decision before execution"
- `02-KERNEL-SIM-SPEC.md` section 16.3, rows `SCHED-AGING-1A`, `SCHED-AGING-1B`,
  `SCHED-RR-1`, `SCHED-RR-2a`, `SCHED-RR-2c`, `SCHED-MLFQ-1`, and the MLFQ
  per-process detail rows
- `01-ARCHITECTURE.md` section 11.4 (golden-file tests for Gantt charts)

## Files you will create

```
src/kernel/scheduler/priorityAging.ts
src/kernel/scheduler/rr.ts
src/kernel/scheduler/mlfq.ts
src/kernel/scheduler/CircularQueue.ts
src/kernel/scheduler/aging.ts
tests/kernel/scheduler/priorityAging.test.ts
tests/kernel/scheduler/rr.test.ts
tests/kernel/scheduler/mlfq.test.ts
tests/kernel/scheduler/golden.test.ts
tests/kernel/golden/README.md
tests/kernel/golden/sched-fcfs-1.gantt
tests/kernel/golden/sched-fcfs-2.gantt
tests/kernel/golden/sched-sjf-1.gantt
tests/kernel/golden/sched-srtf-1.gantt
tests/kernel/golden/sched-prio-1.gantt
tests/kernel/golden/sched-aging-1a.gantt
tests/kernel/golden/sched-aging-1b.gantt
tests/kernel/golden/sched-rr-1.gantt
tests/kernel/golden/sched-mlfq-1.gantt
```

## Files you may modify

```
src/kernel/scheduler/SchedulerRegistry.ts   (replace the three stubs; extend the
                                             factory and restore construction with
                                             the host dependencies the pre-flight
                                             names. See Scope correction below.)
src/kernel/scheduler/starvation.ts     (only if the onAge hook needs a call-site fix)
```

Nothing else. Do not touch `Kernel.ts`: WP-03 already wired phases 6 and 7 and
the registry is the only seam you need.

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
  readonly next: Pid | null;
  readonly isContextSwitch: boolean;
  readonly rationale: string;
}

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
  snapshot(): SchedulerSnapshot;
}

export interface SchedulerSnapshot {
  readonly policy: SchedulerId;
  readonly running: Pid | null;
  /** Outer index is the queue level. Single-level policies use one entry. */
  readonly queues: readonly (readonly Pid[])[];
  readonly quantumRemaining: number;
  readonly metrics: SchedulingMetrics;
}
```

`ProcessControlBlock.queueLevel` is the only PCB field MLFQ mutates beyond what
the base class already touches:

```ts
  /** MLFQ level, or 0 for single-queue policies. */
  queueLevel: number;
```

Note `levelQuanta` is optional on `SchedulerParams`. MLFQ must default it to
`[4, 8, 16]` when absent and must never write to `params`.

## Specification

### 1. `src/kernel/scheduler/CircularQueue.ts`

A circular buffer of `Pid` with head and tail indices, sized to `maxProcesses`,
so enqueue and dequeue are O(1) and allocate nothing per tick. Round robin uses
one; MLFQ uses one per level.

- `enqueue(pid)`, `dequeue(): Pid | null`, `peek(): Pid | null`,
  `remove(pid): boolean`, `readonly size: number`, `contains(pid): boolean`,
  `toArray(): readonly Pid[]` reading head to tail.
- `toArray()` must reuse a single backing array and return it, resized by setting
  `length`, so `snapshot()` allocates nothing.
- Growing past capacity throws `KernelInvariantError`. The capacity comes from
  `maxProcesses` and a process count above that is already impossible.
- Keep a `Set<Pid>` mirror for O(1) `contains`. Never iterate the set; iterate
  the buffer.

### 2. `src/kernel/scheduler/aging.ts`

The aging half of phase 6, from sim spec 5.6.

```ts
export function applyAging(ctx: SchedulerContext, readyPids: readonly Pid[]): void;
```

For each ready process, in ascending pid order, with
`waited = tick - readySince`:

```
if (agingInterval > 0 && waited > 0 && waited % agingInterval === 0)
    priority = Math.max(0, priority - 1)
```

The **reset rule** is equally important and belongs on the dispatch path, which
WP-02's transition T3 already implements: on dispatch, `priority` is restored to
`basePriority`. Without the reset, a process that ages once keeps the boost
forever and the policy degenerates into "whoever waited longest ever, wins".
Verify T3 does this and report if it does not; do not patch `transitions.ts`
yourself.

Aging runs in phase 6, before the scheduler decision in phase 7. If it ran after,
a process that just aged into the top priority would still lose the CPU for one
more tick, which delays every promotion by exactly one tick and changes the
`SCHED-AGING-1B` numbers.

### 3. `src/kernel/scheduler/priorityAging.ts`

Identical selection and preemption rules to `priority` (sim spec 5.5). The
difference is that `onAge` calls `applyAging` and then marks the min-heap dirty
so phase 7 re-heapifies once.

Do not subclass `PriorityScheduler` if that makes `configure`'s forced
`agingInterval = 0` inherit; either factor the shared selection logic into a
helper both call, or override `configure` to honour the passed interval. The
`priority` id must starve and the `priority_aging` id must not. State which
approach you took in your report.

**Worked example, from sim spec 5.6**, non-preemptive, `agingInterval = 2`:

| Process | Arrival | Burst | Base priority |
|---|---|---|---|
| PL | 0 | 5 | 5 |
| H1 | 0 | 4 | 1 |
| H2 | 4 | 4 | 1 |
| H3 | 8 | 4 | 1 |
| H4 | 12 | 4 | 1 |

Without aging (`priority`, `agingInterval = 0`):
`H1[0-4] H2[4-8] H3[8-12] H4[12-16] PL[16-21]`, averages 3.2 / 7.4 / 3.2,
**worstWait 16**.

With aging (`priority_aging`, `agingInterval = 2`): PL's priority walks 5 to 4 at
tick 2, to 3 at 4, to 2 at 6, to 1 at 8. At tick 8 the ready set is PL at
priority 1 with arrival 0 and H3 at priority 1 with arrival 8, and the tie-break
on arrival gives PL the CPU.
`H1[0-4] H2[4-8] PL[8-13] H3[13-17] H4[17-21]`, averages 3.6 / 7.8 / 3.6,
**worstWait 8**.

The pair is the argument for aging in two numbers: average waiting rose from 3.2
to 3.6 and the worst case halved from 16 to 8. Both halves must be asserted.

### 4. `src/kernel/scheduler/rr.ts`

Sim spec 5.7.

- **Selection.** The head of the FIFO ready queue.
- **Preemption.** Preempt when `sliceElapsed >= quantum`. The preempted process
  is appended to the **tail** of the queue. Because phase 7 runs before phase 8, a
  quantum of `q` yields exactly `q` executed ticks per slice.
- **Same-tick ordering rule.** When a process is preempted on the same tick that
  another process becomes ready, the newly ready process is enqueued in phase 4
  or 5 and the preempted process is enqueued in phase 7, so **the new arrival
  goes ahead of the preempted process**. This is the standard convention and it
  produces the textbook charts. Reversing it changes `SCHED-RR-2`. Do not
  special-case this: it falls out of the phase order, so your implementation must
  enqueue the preempted process during `onTick` and nowhere earlier.
- **Tie-break.** Queue position is a total order; simultaneous insertions use
  `tieBreak`.
- **Data structure.** `CircularQueue`. `snapshot().queues` returns one array read
  out from head to tail.
- Emit `quantum.expired { pid, level: 0 }` on every expiry.

**Worked example**, quantum 4, the FCFS workload:
`P1[0-4] P2[4-7] P3[7-10] P1[10-30]`. P1's tail is five consecutive quanta and
the Gantt string keeps them as one segment `P1[10-30]` only because no other
process was dispatched between them; the dispatch count is 4 and the quantum
expiry count is 5 (P1 at ticks 4, 14, 18, 22, 26). Averages 5.666667 /
15.666667 / 3.666667, asserted to 1e-9.

**Quantum sensitivity**, the same workload:

| Quantum | Avg waiting | Avg turnaround | Avg response | Dispatches |
|---|---|---|---|---|
| 1 | 5.666667 | 15.666667 | 1.000000 | 10 |
| 4 | 5.666667 | 15.666667 | 3.666667 | 4 |
| 24 | 17.000000 | 27.000000 | 17.000000 | 3 |

At `quantum >= 24` round robin becomes FCFS exactly.

**Pace mapping**, for WP-18 and the legs to consume. Export it from this file as
a frozen record so nobody hard-codes it twice:

| Pace | Quantum |
|---|---|
| `conservative` | 16 |
| `steady` | 8 |
| `aggressive` | 4 |
| `reckless` | 1 |

Type the keys against `Pace` from `@game/types` using an `import type`, which the
permission matrix allows from `kernel` only as... it does not. `src/kernel` may
not import `src/game`. Therefore declare the mapping with plain string literal
keys `'conservative' | 'steady' | 'aggressive' | 'reckless'` and add a comment
saying it mirrors `Pace` in `@game/types`. WP-18 asserts the two agree.

### 5. `src/kernel/scheduler/mlfq.ts`

Sim spec 5.8. This is the policy that must be specified completely, because every
parameter changes the behaviour. Implement each rule below exactly as written.

**Levels.** `SchedulerParams.levelQuanta` defines both the count and the quantum
per level; index 0 is the highest priority. Default `[4, 8, 16]`. The bottom
level is **FCFS**: a process there runs its quantum and on expiry is re-enqueued
at the tail of the bottom level rather than demoted further.

**Selection.** Scan levels from 0 upward and pick the head of the first non-empty
queue.

**Preemption.** Two triggers, tested **in this order**:

1. **Quantum expiry.** If `sliceElapsed >= levelQuanta[running.queueLevel]`,
   demote: `queueLevel = min(queueLevel + 1, levelQuanta.length - 1)`, append to
   the tail of the new level, emit `quantum.expired` with `level` set to the
   level the process was *on* when it expired, not the level it moved to.
2. **Higher-level arrival.** If any ready process has `queueLevel` **strictly
   less** than the running process's `queueLevel`, preempt without demotion: the
   running process returns to the **tail of its current level** with its slice
   reset.

**Voluntary release keeps the level.** A process that blocks before its quantum
expires re-enters at its current level, not demoted. This is what makes
I/O-bound processes accumulate at level 0.

**Completion beats demotion.** A process that completes on the tick its quantum
expires is completed, not demoted. The completion test runs before the demotion
test. This is the tick-13 row of the worked example and it is easy to get wrong.

**Promotion by aging.** Every `agingInterval` ticks of continuous residence in
`ready`, a process on level `L > 0` is promoted to level `L - 1` and appended to
the tail of that level, with `readySince` reset to the current tick. Default
`agingInterval` for MLFQ is 50. This is the starvation cure and it is what makes
the bottom level survivable. Implement it in `onAge`.

**Accounting mode.** A process that issues a token I/O just before its quantum
expires stays at level 0 forever while doing almost no I/O. The defence is to
track cumulative CPU time at a level rather than per-slice time. Implement both,
selected by a tuning field `mlfqAccounting: 'per_slice' | 'cumulative'`, default
`per_slice` so the pathology can be shown before the cure. Under `cumulative`,
the expiry test uses the process's total CPU consumed since it last entered its
current level, reset on promotion, demotion and dispatch at a new level.

**Data structure.** An array of `CircularQueue`, one per level, plus a
`Map<Pid, number>` mirror for O(1) membership. `snapshot().queues` returns one
array per level, so the world layer draws three processions at three heights.

**Worked example**, `levelQuanta = [4, 8, 16]`, `agingInterval = 50` so no
promotion fires inside the trace:

| Process | Arrival | Burst |
|---|---|---|
| P1 | 0 | 20 |
| P2 | 0 | 6 |
| P3 | 10 | 4 |

Trace, which your implementation must reproduce step for step:

- Ticks 0-3: P1 at level 0, quantum 4 expires, P1 demoted to level 1. Ready
  `[L0: P2] [L1: P1]`.
- Ticks 4-7: P2 at level 0, quantum 4 expires with 2 ticks of burst left, P2
  demoted to level 1. Ready `[L1: P1, P2]`.
- Tick 8: level 0 empty, level 1 head is P1, which runs with quantum 8.
- Tick 10: P3 arrives at level 0. Level 0 is non-empty and 0 < 1, so P1 is
  preempted without demotion and goes to the tail of level 1. Ready
  `[L0: P3] [L1: P2, P1]`.
- Ticks 10-13: P3 runs 4 ticks and completes exactly as its quantum expires.
  Completed, not demoted.
- Ticks 14-15: P2 runs its remaining 2 and completes.
- Ticks 16-30: P1 runs its remaining 14 at level 1. Its quantum of 8 expires at
  tick 24, it demotes to level 2 and, with an empty ready set, is immediately
  redispatched and runs to completion at tick 30.

Gantt: `P1[0-4] P2[4-8] P1[8-10] P3[10-14] P2[14-16] P1[16-30]`.
Averages 6.666667 / 16.666667 / 1.333333. Dispatches 6. Final levels P1 = 2,
P2 = 1, P3 = 0. Per-process waiting/turnaround/response: P1 10/30/0, P2 10/16/4,
P3 0/4/0.

### 6. The golden-file comparison

`tests/kernel/golden/*.gantt` files hold one Gantt string per fixture, one line,
no trailing newline beyond a single `\n`. `golden.test.ts` runs each fixture
through `runWorkload` and compares the produced string against the file with a
strict `toBe`.

Rules:

- The files are written **by hand from the sim spec**, not generated from the
  implementation. A golden file generated from the code under test proves
  nothing. Copy each Gantt string out of sim spec section 5 or 16.3.
- `tests/kernel/golden/README.md` states, in three sentences, where the values
  came from, that they are not regenerated, and that changing one requires
  changing the sim spec first.
- If a run disagrees with a golden file, the failure message must print both
  strings aligned, so the difference is readable.

### 7. Registry

Replace the three throwing stubs in `src/kernel/scheduler/SchedulerRegistry.ts` with the
real factories. Change nothing else in that file.

## Acceptance criteria

1. `npm run typecheck` exits 0.
2. `npm run test` exits 0.
3. `npm run build` exits 0.
4. Fixture `SCHED-AGING-1A` passes: gantt, averages 3.2 / 7.4 / 3.2, and
   **worstWait 16**.
5. Fixture `SCHED-AGING-1B` passes: gantt, averages 3.6 / 7.8 / 3.6, and
   **worstWait 8**.
6. Fixture `SCHED-RR-1` passes: gantt, averages 5.666667 / 15.666667 / 3.666667
   to 1e-9, dispatches 4, quantum expiries 5.
7. Fixtures `SCHED-RR-2a` (q=1) and `SCHED-RR-2c` (q=24) pass with the values in
   the quantum sensitivity table, and `SCHED-RR-2c`'s Gantt string is identical
   to `SCHED-FCFS-1`'s.
8. Fixture `SCHED-MLFQ-1` passes: gantt, averages 6.666667 / 16.666667 /
   1.333333, dispatches 6, final queue levels P1 = 2, P2 = 1, P3 = 0, and the
   three per-process rows.
9. All nine golden files match. Deleting a golden file makes its test fail rather
   than silently pass.
10. Every registry id now returns a working policy; nothing in `SCHEDULERS`
    throws.
11. Fixture `INV-ALL-2`'s scheduler axis is exercised: each of the seven
    schedulers runs 2,000 ticks against `REFERENCE_CONFIG` without throwing. The
    full 252-combination sweep belongs to WP-11; assert only the seven here.
12. `snapshot()` on MLFQ returns three arrays and allocates nothing after the
    first call.
13. The only diff to `src/kernel/types.ts` is the reviewed amendment 6 patch, in
    its own commit; `src/game/types.ts` has no diff. (Previously this item asked
    for a zero types diff while the package also required a promotion, which is a
    contradiction. Corrected in the pre-flight.)
14. The forbidden-identifier scan still returns zero matches.
15. Every `src/kernel/Kernel.ts` hunk is one of the approved construction,
    persistence or Amdahl accounting sites named in the Scope correction, and the
    eleven phase bodies are byte-identical. (Previously this item demanded a
    byte-identical Kernel.ts while the package required construction and
    persistence edits. Corrected in the pre-flight.)
    started.

## Tests you must write

### `tests/kernel/scheduler/priorityAging.test.ts`

| Case | Assertion |
|---|---|
| `SCHED-AGING-1A` | the workload under `priority` with `agingInterval: 0` gives gantt `'H1[0-4] H2[4-8] H3[8-12] H4[12-16] PL[16-21]'`, averages 3.2 / 7.4 / 3.2, worstWait 16 |
| `SCHED-AGING-1B` | the same workload under `priority_aging` with `agingInterval: 2` gives gantt `'H1[0-4] H2[4-8] PL[8-13] H3[13-17] H4[17-21]'`, averages 3.6 / 7.8 / 3.6, worstWait 8 |
| `aging trace` | PL's `priority` reads 4 at tick 2, 3 at tick 4, 2 at tick 6, 1 at tick 8 |
| `priority floor` | a process aged 20 times from base priority 3 never goes below 0 |
| `reset on dispatch` | after PL is dispatched at tick 8, its `priority` reads `basePriority` again, which is 5 |
| `tie-break at tick 8` | with PL and H3 both at priority 1, PL wins on the lower `arrivalTick` |
| `aging does not fire at waited 0` | a process admitted this tick does not age this tick |
| `priority still starves` | the `priority` id with `agingInterval: 2` passed in configure still produces worstWait 16, proving the forced override |

### `tests/kernel/scheduler/rr.test.ts`

| Case | Assertion |
|---|---|
| `SCHED-RR-1` | gantt `'P1[0-4] P2[4-7] P3[7-10] P1[10-30]'`, averages 5.666667 / 15.666667 / 3.666667 to 1e-9, dispatches 4, quantum expiries 5, per-process P1 6/30/0, P2 4/7/4, P3 7/10/7 |
| `quantum expiry ticks` | the five `quantum.expired` events for P1 carry ticks 4, 14, 18, 22, 26 and `level: 0` |
| `SCHED-RR-2a` | q=1 gives 5.666667 / 15.666667 / 1.000000 and 10 dispatches |
| `SCHED-RR-2c` | q=24 gives 17.0 / 27.0 / 17.0, 3 dispatches, and a Gantt string identical to `SCHED-FCFS-1` |
| `same-tick ordering` | a process becoming ready in phase 5 on the tick another is preempted in phase 7 is dispatched first |
| `preempt at >= not >` | with quantum 4, the process executes exactly ticks 0, 1, 2, 3 and is preempted at the decision made during tick 4 |
| `pace mapping` | the exported record maps conservative 16, steady 8, aggressive 4, reckless 1 |
| `no shift in hot path` | `CircularQueue.dequeue` is O(1): 100,000 enqueue/dequeue pairs complete under 50 ms |

### `tests/kernel/scheduler/mlfq.test.ts`

| Case | Assertion |
|---|---|
| `SCHED-MLFQ-1` | gantt `'P1[0-4] P2[4-8] P1[8-10] P3[10-14] P2[14-16] P1[16-30]'`, averages 6.666667 / 16.666667 / 1.333333, dispatches 6 |
| `SCHED-MLFQ-1 levels` | final `queueLevel` is P1 = 2, P2 = 1, P3 = 0 |
| `SCHED-MLFQ-1 per-process` | P1 10/30/0, P2 10/16/4, P3 0/4/0 |
| `demotion on expiry` | a compute-bound process walks level 0 to 1 to 2 and stops at 2 |
| `bottom level is FCFS` | a process at the bottom level whose quantum expires is re-enqueued at the tail of the bottom level, not demoted |
| `quantum.expired level` | the event carries the level the process was on when it expired, not the level it moved to |
| `higher-level arrival preempts` | at tick 10, P3's arrival at level 0 preempts P1 at level 1 without demoting P1, and P1 goes to the tail of level 1 behind P2 |
| `completion beats demotion` | P3, which completes on the exact tick its quantum expires, ends `terminated` with `queueLevel === 0` and emits no `quantum.expired` |
| `voluntary release keeps level` | a process that blocks at `sliceElapsed === 2` with quantum 4 re-enters at the same level |
| `io-bound stays at level 0` | a process that runs 2 ticks then blocks, 40 times, ends at level 0 |
| `promotion by aging` | with `agingInterval: 10`, a process stuck at level 2 for 10 ticks is promoted to level 1 with `readySince` reset |
| `gaming, per_slice` | a process that issues a token I/O at `sliceElapsed === 3` every slice stays at level 0 for 200 ticks |
| `gaming, cumulative` | the same workload under `mlfqAccounting: 'cumulative'` demotes it within 200 ticks |
| `default levelQuanta` | with `levelQuanta` absent from params, the policy uses `[4, 8, 16]` and does not write to `params` |

### `tests/kernel/scheduler/golden.test.ts`

One case per golden file. Each runs the named fixture through `runWorkload` and
asserts `toBe` against the file contents trimmed of its trailing newline. A
missing file fails with a message naming the file rather than throwing an
unhandled `ENOENT`.

Golden file contents, copied from the sim spec:

| File | Contents |
|---|---|
| `sched-fcfs-1.gantt` | `P1[0-24] P2[24-27] P3[27-30]` |
| `sched-fcfs-2.gantt` | `P2[0-3] P3[3-6] P1[6-30]` |
| `sched-sjf-1.gantt` | `P4[0-3] P1[3-9] P3[9-16] P2[16-24]` |
| `sched-srtf-1.gantt` | `P1[0-1] P2[1-5] P4[5-10] P1[10-17] P3[17-26]` |
| `sched-prio-1.gantt` | `P2[0-1] P5[1-6] P1[6-16] P3[16-18] P4[18-19]` |
| `sched-aging-1a.gantt` | `H1[0-4] H2[4-8] H3[8-12] H4[12-16] PL[16-21]` |
| `sched-aging-1b.gantt` | `H1[0-4] H2[4-8] PL[8-13] H3[13-17] H4[17-21]` |
| `sched-rr-1.gantt` | `P1[0-4] P2[4-7] P3[7-10] P1[10-30]` |
| `sched-mlfq-1.gantt` | `P1[0-4] P2[4-8] P1[8-10] P3[10-14] P2[14-16] P1[16-30]` |

## Out of scope

- `src/kernel/Kernel.ts`. It must come out of this package byte-identical.
- `src/kernel/scheduler/fcfs.ts`, `sjf.ts`, `srtf.ts`, `priority.ts`,
  `SchedulerBase.ts`, `MinHeap.ts`, `metrics.ts`, `tieBreak.ts`. WP-03 owns them.
  If one of them has a bug, report it rather than fixing it, unless the bug makes
  an acceptance criterion here unreachable, in which case fix the minimum and say
  exactly what you changed.
- Every other kernel subsystem directory.
- Anything outside `src/kernel/scheduler/` and `tests/kernel/`.
- The full 252-combination invariant sweep. WP-11 owns `INV-ALL-2`.

## Report back

State:

1. Pass or fail for each of the fifteen acceptance criteria, by number.
2. The three verification command outcomes.
3. For each of `SCHED-AGING-1A`, `SCHED-AGING-1B`, `SCHED-RR-1`, `SCHED-RR-2a`,
   `SCHED-RR-2c` and `SCHED-MLFQ-1`, the produced Gantt string, the three
   averages and the auxiliary counts, so a human can compare them against sim
   spec 16.3.
4. How you kept `priority` starving while `priority_aging` ages: shared helper,
   or overridden `configure`.
5. Whether transition T3 in `src/kernel/process/transitions.ts` correctly resets
   `priority` to `basePriority` on dispatch. If it does not, report it; do not
   patch it.
6. Every `// TODO(astra):` left in the tree, with file and line.

---

## Added scope, 2026-09-13: extending and promoting the scheduler snapshot

Amendment 3 added a `scheduler` slot to `SubsystemSnapshots`, and WP-03 filled it
for the four policies it implements: the ready queues, quantum remaining, the
starvation timers and the metrics accumulators. Read what it built before you
extend it.

You own the rest:

1. Extend the envelope with the state this package adds: the aging clock, round
   robin position, and MLFQ per-level queues and demotion counters. Bump the
   envelope version. Extending a versioned envelope is what it is for.
2. Promote the envelope to a typed interface once the scheduler is complete, and
   record the promotion in `docs/07-CONTRACT-AMENDMENTS.md`.
3. Persist accumulators, never computed averages. An average restored as an
   average silently resets a run's history.

`SchedulerSnapshot` is not the answer and must not be reused for this. It is a
per-tick read-only view for the HUD and the world, it carries computed averages
rather than accumulators, and it holds no aging or starvation state at all.
Restoring from it would silently reset a run's history.

Acceptance, mechanically verifiable: a kernel running a mixed workload under MLFQ,
snapshotted mid-run with processes spread across all three levels and at least one
aged process, restored through the scheduler contribution against equivalent
staged process state and stepped forward, produces a byte-identical continuation
event log. The fresh-kernel version of that test, restoring the whole workload
into an empty kernel, requires the process channel and belongs to WP-11; it is
recorded there as a pending acceptance and is not claimed here. A snapshot missing
the accumulators is
rejected rather than accepted.

---

## Scope correction, 2026-09-14

Raised by the pre-flight grant check. Eleven gaps, four of them in this package's
own text, and one of them a design decision the package left implicit. All
approved as follows.

**Grants.** `SchedulerRegistry.ts` in full for factory, host dependencies and
restore construction; `config.ts` for exactly one new key,
`mlfqAccounting: 'per_slice' | 'cumulative'`, default `per_slice`, validated;
`Kernel.ts` regions 4-5, 50, 580-600, 632-635, 892-896 for construction and
persistence, and 445-447, 545-556 for Amdahl accounting, none of them a phase
body; `SchedulerBase.ts`, `FCFS.ts`, `sjf.ts`, `priority.ts` and `metrics.ts`
for persistence signatures and parsing only, selection algorithms untouched;
`threads.ts` regions 58-73, 81-96, 99-123, 126-156, 197-205, 213-253, 256-275
for the Amdahl accounting; the fixture migrations in the pre-flight table;
`workloadRunner.ts` for worst-wait reporting, tuning overrides and the factored
segment renderer; new `persistence.test.ts` and `amdahl-deferral.test.ts`.

**The Amdahl accounting is a creation-debt model, decided here.** The original
one-line grant was wrong: the line it named is never executed by AMDAHL-2, the
recompute path uses `round` with no overhead, and a stateless recompute after a
consumed tick restores the consumed work. So:

- Accelerate useful work with C, the usable cores passed to the unchanged
  `amdahlSpeedup`. Charge coordination overhead by T, the live thread count.
  The fixture has C = T and is unchanged; over-threading past the core cap now
  costs without speeding anything up, which is the lesson.
- At admission the useful duration is `ceil(R / amdahlSpeedup(s, C))` plus one
  outstanding overhead pool of `O * T`. Each later successful thread creation
  adds O. A join never refunds. Wake, recompute and a new burst reprice remaining
  useful raw work at the current C and never recharge overhead; recomputation at
  unchanged C is idempotent.
- Overhead is consumed before useful work. An overhead tick charges CPU and
  PCB and TCB service and returns a delivered TID, but executes no instruction,
  advances no PC, and reduces no raw work. It therefore cannot fault.
- Integral raw progress: cache the C that priced the current budget; on a useful
  tick retain the greatest integral raw remainder no larger than its old value
  whose ceiling at that speedup equals the new useful budget.
- Side state is a ThreadManager-owned map by PID holding `overheadRemaining` and
  `pricedCores`. No PCB or RawProcessWork field. WP-11 restores both values; no
  restored process may reinitialise its debt as fresh.
- Deferral captures and restores both side values along with raw burst, raw
  service and the useful budgets, keeping `totalCpuUsed` charged, as WP-06 does.
- Fork: the child gets its own initial `O * T` on admission and keeps the copied
  useful raw work. Exec: success clears old debt, creates fresh debt, and reprices
  after lifecycle has reset raw work; failure changes nothing.
- Halving (`halveRemainingBurst`, WP-06's ability): halve only useful raw work,
  preserve outstanding overhead, reprice a blocked process at its cached C
  without waking it.

**Scheduler semantics, approved as proposed in the pre-flight.** RR and MLFQ
keep a persisted `startCpu` cursor and measure their slice as
`pcb.totalCpuUsed - startCpu`, renewed on every expiry including same-owner
expiry, so a lone process's quantum renews without a fake dispatch and switch
and copy debt are excluded. Policies emit `quantum.expired` once through a bound
host emitter that stamps tick and seq; the frozen `SchedulerContext.emit` is
unchanged. Cumulative MLFQ retains level CPU history across blocking and
higher-level preemption, resets on promotion, demotion and first dispatch at a
new level, and counts only real demotions. The bottom level is round robin with
a finite quantum, whatever the older prose calls it. Fixture means are asserted
as exact rationals within 1e-9 (RR q4: 17/3, 47/3, 11/3; RR q1: 17/3, 47/3, 1;
MLFQ: 20/3, 50/3, 4/3), because the printed six-decimal figures miss by about
3.3e-7. The fixture `worstWait` of 16 and 8 is the workload's maximum waiting
time, reported by the runner; the live metric over currently-ready processes
keeps its definition. Goldens follow this package's one-line format, not the
grid in architecture 11.4.

**Full fresh-kernel restore belongs to WP-11.** This package's earlier "Added
scope" demanded a mid-run MLFQ snapshot restored into a fresh kernel. That needs
the process channel, which is WP-11's, and its own reviewed process amendment.
The scheduler contribution round-trips now, against equivalent staged process
state; the fresh-kernel acceptance is recorded in WP-11 as pending and is not
claimed here. This was the same defect shape as the five before it, made by the
reviewer inside a correction meant to fix that shape.

**Node.** The pre-flight ran on Node 25 because Docker was unavailable. CI runs
Node 22 from `.nvmrc`. Where they disagree, CI wins.


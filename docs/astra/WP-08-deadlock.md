# WP-08: Deadlock, the wait-for graph, Banker's and recovery

## Objective

When this package is done the kernel can represent multi-instance resources,
build a wait-for graph deterministically, find a cycle in it with an iterative
DFS, run Banker's safety and resource-request algorithms with a full explanatory
trace, detect deadlock over multiple instances, recover by termination or by
preemption with rollback, and operate under all four values of
`KernelConfig.deadlockStrategy`. Every worked matrix in the sim spec is a passing
test. This is the simulation half of Leg 6, The Gridlock.

## Prerequisites

WP-07 complete and green.

Files that must already exist:

- `src/kernel/types.ts` (frozen)
- `src/kernel/Kernel.ts` with phase 9's `deadlock.maybeDetect(tick)` hook and its
  gating on `deadlockStrategy === 'detect'` and
  `tick % deadlockDetectionInterval === 0`
- `src/kernel/sync/SyncSubsystem.ts` with the primitive table and its `holders`
  and `waitQueue` arrays
- `src/kernel/process/ipc.ts`, since mailbox blocking uses synthetic sync
  resource ids that the wait-for graph must see

## Required reading

- `02-KERNEL-SIM-SPEC.md` section 9 in full: 9.1 (resources and the allocation
  matrix), 9.2 (the four Coffman conditions and how each is detected), 9.3 (the
  wait-for graph and the coloured iterative DFS), 9.4 (Banker's: the safety
  algorithm, the resource-request algorithm, and the three-part worked example),
  9.5 (detection with multiple instances and its two worked matrices), 9.6
  (recovery by termination and by preemption), 9.7 (the four strategies)
- `02-KERNEL-SIM-SPEC.md` section 2.1, phase 9, and section 2.2's paragraphs
  "Execution before deadlock detection" and "Deadlock detection before metrics"
- `02-KERNEL-SIM-SPEC.md` section 16.8 (the deadlock fixture table)
- `02-KERNEL-SIM-SPEC.md` section 15, the "Synchronisation and deadlock"
  invariant group, especially I-5 and I-24
- `05-CURRICULUM-MAP.md` section 0.1 (the three citation corrections). Two of the
  three land in this package.

## Citation corrections that apply here

`src/kernel/types.ts` carries two section citations that do not match the 10th
edition. **The frozen file stays exactly as it is.** Use the corrected numbers in
every piece of content you generate: `SafetyTraceStep.explanation` strings,
`DeadlockReport` prose, comments, and any `ChapterRef` you construct.

| Location in frozen code | Cited there | Correct for 10th ed. | Why |
|---|---|---|---|
| `SafetyCheckResult.sequence` | 8.6.2 | **8.6.1** | Safe state and the safe sequence are 8.6.1. 8.6.2 is the resource-allocation-graph algorithm. |
| `DeadlockReport.cycle` | 8.3.2 | **8.7.1** | 8.3.2 is the resource-allocation graph. The wait-for graph and its cycle test are 8.7.1. |

Do not correct the comments in `types.ts`. Do not cite 8.6.2 or 8.3.2 in anything
you write.

## Files you will create

```
src/kernel/deadlock/DeadlockSubsystem.ts
src/kernel/deadlock/resources.ts
src/kernel/deadlock/waitForGraph.ts
src/kernel/deadlock/cycleDetection.ts
src/kernel/deadlock/bankers.ts
src/kernel/deadlock/detection.ts
src/kernel/deadlock/recovery.ts
src/kernel/deadlock/coffman.ts
src/kernel/deadlock/ordering.ts
tests/kernel/deadlock/waitForGraph.test.ts
tests/kernel/deadlock/bankers.test.ts
tests/kernel/deadlock/detection.test.ts
tests/kernel/deadlock/recovery.test.ts
tests/kernel/deadlock/strategies.test.ts
```

## Files you may modify

```
src/kernel/Kernel.ts   (wire the deadlock hook; implement evaluateBankers and
                        detectDeadlock. Nothing else.)
```

Nothing else.

## Frozen contracts

From `src/kernel/types.ts`. These may not be edited. If this package cannot be
completed without changing one, stop and report per the escalation procedure.

```ts
export interface ResourceType {
  readonly id: ResourceId;
  readonly displayName: string;
  readonly totalInstances: number;
  availableInstances: number;
  /** True when the resource can be taken back without corrupting the holder. */
  readonly preemptible: boolean;
}

/** Ch. 8.6.3. Rows are processes, columns are resource types. */
export interface BankersState {
  readonly processes: readonly Pid[];
  readonly resources: readonly ResourceId[];
  readonly available: readonly number[];
  readonly max: readonly (readonly number[])[];
  readonly allocation: readonly (readonly number[])[];
  readonly need: readonly (readonly number[])[];
}

export interface SafetyCheckResult {
  readonly safe: boolean;
  /** The safe sequence when one exists. Ch. 8.6.2. */
  readonly sequence: readonly Pid[] | null;
  /** Step-by-step trace so the codex can show the player the actual algorithm. */
  readonly trace: readonly SafetyTraceStep[];
}

export interface SafetyTraceStep {
  readonly work: readonly number[];
  readonly candidate: Pid | null;
  readonly admitted: boolean;
  readonly explanation: string;
}

export interface DeadlockReport {
  readonly tick: Tick;
  /** The cycle in the wait-for graph. Ch. 8.3.2. */
  readonly cycle: readonly Pid[];
  readonly resources: readonly ResourceId[];
  /** Which of the four Coffman conditions each edge demonstrates. */
  readonly conditions: readonly CoffmanCondition[];
  readonly suggestedVictims: readonly Pid[];
}

export type CoffmanCondition =
  | 'mutual_exclusion' | 'hold_and_wait' | 'no_preemption' | 'circular_wait';
```

The two `Kernel` methods this package implements:

```ts
  /** Ch. 8.6. Returns the trace whether or not the request is granted. */
  evaluateBankers(pid: Pid, resource: ResourceId, instances: number): SafetyCheckResult;
  detectDeadlock(): DeadlockReport | null;
```

Events this package emits, from the frozen union:

```ts
| (EventBase & { type: 'resource.requested'; pid: Pid; resource: ResourceId; instances: number })
| (EventBase & { type: 'resource.granted'; pid: Pid; resource: ResourceId; instances: number })
| (EventBase & { type: 'resource.denied'; pid: Pid; resource: ResourceId; reason: 'unsafe' | 'unavailable' })
| (EventBase & { type: 'bankers.evaluated'; result: SafetyCheckResult; forRequest: { pid: Pid; resource: ResourceId } })
| (EventBase & { type: 'deadlock.detected'; report: DeadlockReport })
| (EventBase & { type: 'deadlock.resolved'; victims: readonly Pid[]; method: 'preempt' | 'terminate' | 'rollback' })
```

## Specification

### 1. `src/kernel/deadlock/resources.ts`

`ResourceType` instances live in a `Map<ResourceId, ResourceType>` plus a sorted
key array in **ascending lexicographic `ResourceId` order**. That ordering is the
column order of every matrix in this package and it is mandatory.

The allocation matrix is **rebuilt on demand from PCB state, never stored
separately**, so it cannot drift:

```ts
function allocationMatrix(k: KernelState): number[][] {
  const rows = k.orderedPids.map(pid => {
    const p = k.pcb(pid)!;
    return k.orderedResourceIds.map(r => p.heldResources.filter(h => h === r).length);
  });
  return rows;
}
```

`heldResources` is a **multiset represented as an array with repeats**, so
holding two instances of `printer` appears twice. `requestedResources` has the
same shape and holds outstanding requests. Invariant I-5 asserts that for every
resource type, `availableInstances + sum(allocation column) === totalInstances`.

Under `noUncheckedIndexedAccess`, every matrix index needs a guard. Write one
helper `at(matrix, i, j)` that throws `KernelInvariantError` on an out-of-range
index, and use it everywhere rather than scattering `?? 0`. A silent `?? 0` in a
Banker's matrix turns an unsafe state into a safe one.

### 2. `src/kernel/deadlock/coffman.ts`

The four conditions from sim spec 9.2. Each is a computable predicate over kernel
state.

| Condition | Detected by |
|---|---|
| `mutual_exclusion` | true for any `ResourceType` with finite `totalInstances`, and any `SyncPrimitive` of kind `mutex`, `semaphore` with capacity 1, or `rwlock` held for writing. **False for an `rwlock` held only by readers**, which is why a reader-only cycle is impossible. |
| `hold_and_wait` | `pcb.heldResources.length > 0 && pcb.blockedOn !== null && pcb.requestedResources.length > 0` |
| `no_preemption` | `!resourceType.preemptible` for every resource on the cycle |
| `circular_wait` | a cycle exists in the wait-for graph |

`DeadlockReport.conditions` is built by testing each predicate against the edges
of the discovered cycle and including the ones that hold. For a genuine deadlock
all four are present. The array exists so the codex can highlight which edge
demonstrates which, and so a **near-deadlock** with three of four can be shown as
a warning. Expose `nearDeadlocks()` returning the three-of-four cases separately;
do not emit `deadlock.detected` for them.

`no_preemption` is the condition SABLE's shield attacks: it flips `preemptible`
to true on one resource for 20 ticks. The kernel must not know the Program's
name. Expose `setPreemptible(resource, value, untilTick)` and let `@game` call
it.

### 3. `src/kernel/deadlock/waitForGraph.ts`

Implement `buildWaitForGraph` exactly as printed in sim spec 9.3. The wait-for
graph collapses resources out of the resource-allocation graph: an edge
`Pi -> Pj` exists when `Pi` waits for a resource held by `Pj`.

Three edge sources, all of which must be present:

1. Every `rid` in `p.requestedResources` held by another process.
2. `blockedOn.kind` of `mutex` or `semaphore`: every holder of that primitive
   other than `p`. Mailbox blocking uses synthetic ids `mbox:<id>:send` and
   `mbox:<id>:recv`, so a rendezvous pair that each send first produces a real
   cycle and the graph must draw it.
3. `blockedOn.kind` of `child_wait` with a non-null child: an edge to that child.

**The adjacency sort is not cosmetic.** `g.set(pid, [...targets].sort((a, b) => a - b))`
is mandatory: DFS explores in adjacency order, so the particular cycle reported
when several exist depends on it, and `DeadlockReport.cycle` is asserted in
fixtures.

Nodes are iterated in ascending pid order. A process not in state `waiting`, or
with `blockedOn === null`, gets an empty adjacency list rather than being omitted.

### 4. `src/kernel/deadlock/cycleDetection.ts`

The eighteen-step coloured iterative DFS from sim spec 9.3. Implement it as
written, including:

- Colours `WHITE`, `GREY`, `BLACK`, all `WHITE` initially, plus a `parent` map.
- The outer loop iterates pids in **ascending order**.
- **The DFS is iterative, not recursive**, so a pathological graph cannot blow
  the JavaScript stack in the browser. Use an explicit stack of `(node, index)`
  pairs.
- A back edge to a `GREY` node means a cycle: walk `parent` from `u` back to `v`,
  push, reverse, and return.
- **`rotateToLowestPid(cycle)` is mandatory.** It rotates the cycle array to
  begin at its smallest pid. Without it, the same cycle discovered from a
  different start node serialises differently and test `DET-D1` fails on the
  snapshot comparison. This is a real bug class.

Complexity is O(V + E), negligible at the sim's scale of tens of each.

### 5. `src/kernel/deadlock/bankers.ts`

**The safety algorithm**, sim spec 9.4.1. Copy the `safetyCheck` implementation
printed there. Three points that decide correctness:

- **The ascending-first-match rule at step 2 is normative.** The textbook says
  "find an *i* such that", leaving the choice open, and different choices give
  different safe sequences that are all correct. The simulator must produce one
  answer, so it takes the **lowest index** and **restarts the scan from index 0
  after every admission**.
- `Need` is computed as `Max - Allocation`, **never stored**.
- Rows are processes in ascending pid order; columns are resources in ascending
  lexicographic `ResourceId` order. Both are what make
  `SafetyCheckResult.trace` comparable across runs.

Every `SafetyTraceStep.explanation` is player-facing through the codex. Write
them exactly in the shape the sim spec prints, with no em dashes:

```
`Need[P${pid}] fits in Work; assume it finishes and returns its allocation. Work becomes [${work.join(', ')}].`
```

and for the failing final step:

```
`No remaining process has Need <= Work [${work.join(', ')}]. Stuck: ${stuck.map(p => 'P' + p).join(', ')}. State is UNSAFE.`
```

**The resource-request algorithm**, sim spec 9.4.2, four steps:

1. `Request[j] > Need[i][j]` for some `j`: the process exceeded its declared
   maximum claim. Return `EINVAL`.
2. `Request[j] > Available[j]` for some `j`: the resources are not there. Return
   `EAGAIN`, block the process, emit
   `resource.denied { reason: 'unavailable' }`.
3. Tentatively allocate: `Available -= Request`,
   `Allocation[i] += Request`, `Need[i] -= Request`.
4. Run SAFETY on the tentative state. Safe: commit, return ok, emit
   `resource.granted`. Unsafe: **roll back step 3 exactly**, block process `i`,
   emit `resource.denied { reason: 'unsafe' }`, return `EAGAIN`.

`Kernel.evaluateBankers(pid, resource, instances)` runs steps 1 to 4 **without
committing** and returns the `SafetyCheckResult`, which is how the terminal's
`bankers` command and the codex show the player the algorithm on live state.
`bankers.evaluated` carries the same result plus the triggering request, so the
world layer can animate the safety scan.

### 6. The documented divergence from the textbook

Sim spec 9.4.3's worked example is safe with sequence **`<P1, P3, P0, P2, P4>`**.

**The textbook prints `<P1, P3, P4, P0, P2>`, which is also safe.** Both are
correct. The simulator's ascending-first-match rule selects P0 at step 3 because
P0's need `(7,4,3)` fits Work `(7,4,3)` exactly and P0 has a lower index than P4.

**A test that asserts the textbook's sequence instead of the simulator's is
testing the wrong thing.** Fixture `DL-BANKERS-1` asserts the simulator's
sequence. Fixture `DL-BANKERS-1A` asserts that the textbook's sequence is *also*
safe, by running the safety check with a forced admission order
`P1, P3, P4, P0, P2`. Provide `safetyCheckWithOrder(state, forcedOrder)` for
exactly that purpose and use it nowhere else.

Put a comment above `safetyCheck` stating this divergence in two sentences, so a
future reader comparing against Silberschatz does not "fix" it.

### 7. `src/kernel/deadlock/detection.ts`

The multiple-instance detection algorithm from sim spec 9.5. It is the safety
algorithm with `Request` in place of `Need`, and it differs at step 1:

```
1. Work = copy of Available
   Finish[i] = (Allocation[i] is all zeros)      // a process holding nothing cannot deadlock
2. Find an index i, ASCENDING, with Finish[i] === false and Request[i][j] <= Work[j] for all j.
   If none, go to step 4.
3. Work = Work + Allocation[i]; Finish[i] = true; go to step 2.
4. Any i with Finish[i] === false is deadlocked. The set of such i is the deadlock set.
```

`Request[i]` is the process's **current outstanding** request, which is
`requestedResources` counted per type. It is not `Need`. Getting this wrong turns
`DL-DETECT-1` from "no deadlock" into "deadlock" and is the single most likely
mistake in this package.

The step-1 difference matters: a process that holds nothing is marked finished up
front, because it cannot be part of a cycle.

**Detection frequency**, sim spec 9.5: `deadlockDetectionInterval` ticks, default
20. Record the average detection latency (ticks between the cycle forming and
`deadlock.detected` firing) and expose it as `averageDetectionLatency()`, which
the Leg 6 debrief prints.

### 8. `src/kernel/deadlock/recovery.ts`

**By termination**, sim spec 9.6.1. Two modes: `abort_all` terminates every
process in the deadlock set, guaranteed and maximally expensive; `abort_one`
(default) terminates one victim, re-runs detection, and repeats until no cycle
remains.

**Victim selection** is an ordered comparison where the first difference wins, so
the choice is total and deterministic. Copy `chooseVictim` from sim spec 9.6
exactly. The order of the six keys:

1. **Never select a convoy Program if a non-convoy process is on the cycle.**
   `convoyMemberId !== null` sorts last unconditionally. This is a game rule, not
   an OS rule, and it is implemented in the kernel deliberately.
2. Prefer terminating the process with the numerically **largest** `priority`,
   since lower number means higher priority.
3. Prefer the process with the least `totalCpuUsed`, so the least work is lost.
4. Prefer the process holding the most resources, so one termination frees the
   most.
5. Prefer the process with the most `serviceRemaining`, so survivors are closest
   to finishing.
6. Tie-break on highest pid.

`DeadlockReport.suggestedVictims` is this sorted array, so the player sees the
same ranking the kernel would use and can override it from the terminal with
`kill`.

Termination sets `terminationReason: 'deadlock_victim'` and emits
`deadlock.resolved { victims, method: 'terminate' }`.

**By preemption**, sim spec 9.6.2. Only possible on a `ResourceType` with
`preemptible === true`.

1. Select a resource on the cycle with `preemptible === true`. If none, fall back
   to termination.
2. Take the resource from its holder: remove it from `heldResources`, increment
   `availableInstances`.
3. **Roll back the holder.** Restore `serviceRemaining` to its value at the last
   checkpoint, move the holder to `ready` with `blockedOn = null`, and move the
   preempted resource from `heldResources` back to `requestedResources`.
   Checkpoints are taken every `rollbackCheckpointInterval` ticks (default 25)
   and store only `serviceRemaining`, `cpuBurstRemaining` and the program
   counter. Keep them in a side table keyed by pid; they are not PCB fields.
4. Emit `deadlock.resolved` with `method: 'preempt'`, or `method: 'rollback'`
   when a checkpoint was actually restored.
5. **Starvation guard.** A process preempted `maxPreemptionsPerProcess` times
   (default 3) is marked ineligible for further preemption, so the same victim
   cannot be rolled back forever. Ch. 8.8.2 names this as the third problem with
   preemption recovery and this counter is the answer.

### 9. `src/kernel/deadlock/ordering.ts` and the four strategies

`KernelConfig.deadlockStrategy` takes four values, and each changes what the
`request` syscall does. WP-11 owns the syscall table; this package owns the
resource logic behind it and exposes
`request(pid, resource, instances): SyscallResult` for WP-11 to call.

**`'ignore'`.** Grant if available, block if not, never check anything. This is
the Ostrich algorithm of Ch. 8.9 and it is what most real systems do. Deadlocks
happen and stay; the player's only recourse is the terminal and `kill`. This is
Leg 6's opening condition.

**`'detect'`.** The same request path as `'ignore'`, plus phase 9 runs detection
every `deadlockDetectionInterval` ticks and recovery runs on a positive result.

**`'avoid'`.** The `request` syscall runs the Banker's resource-request
algorithm. Every process declares `Max` at admission, taken from `ProcessSpec`. A
process requesting beyond its declared max gets `EINVAL` and is terminated with
`protection_fault`. **Phase 9 does no detection work at all** under this
strategy.

**`'prevent'`.** Circular wait prevention by total resource ordering, Ch. 8.5.4,
which is the only one of the four structural attacks that is practical:

1. Every `ResourceId` has an integer rank, assigned at declaration in ascending
   order of declaration.
2. `request(r)` from a process holding `h` succeeds only if `rank(r) > rank(h)`
   for every `h` in `heldResources`.
3. A violation returns `EDEADLK` **immediately and does not block**.

Under `'prevent'`, invariant I-24 asserts that `buildWaitForGraph` is acyclic on
every tick. A failure of that assertion is a genuine bug in the ordering
implementation, not a tuning issue. Also implement
`preventionMode: 'all_or_nothing'` (hold-and-wait prevention: request everything
at once), which is visibly worse for utilisation and is the Ch. 8.5.2 point.

Expose the per-strategy comparison the Leg 6 debrief card needs:
`strategyReport(): { deadlocks: number; processesLost: number; averageUtilisation: number; totalTicks: number }`.

## Acceptance criteria

1. `npm run typecheck` exits 0.
2. `npm run test` exits 0.
3. `npm run build` exits 0.
4. Fixture `DL-BANKERS-1` passes: Available `(3,3,2)` with the sim spec 9.4.3
   matrices is safe with sequence `<P1, P3, P0, P2, P4>` and exactly 5 admitted
   trace steps, and each step's `work` matches the five-row table.
5. Fixture `DL-BANKERS-1A` passes: the same state with forced admission order
   `P1, P3, P4, P0, P2` is also safe.
6. Fixture `DL-BANKERS-2` passes: P1 requests `(1,0,2)` and is **granted**;
   Available becomes `(2,3,0)`; `Need[P1]` becomes `(0,2,0)`; the safe sequence
   is `<P1, P3, P0, P2, P4>`.
7. Fixture `DL-BANKERS-3` passes: from that state, P4 requests `(3,3,0)` and is
   **denied** with `EAGAIN` and
   `resource.denied { reason: 'unavailable' }`, because A: 3 > 2.
8. Fixture `DL-BANKERS-4` passes: from that state, P0 requests `(0,2,0)` and is
   **denied unsafe**, rolled back exactly,
   `resource.denied { reason: 'unsafe' }`; the trace ends with
   `candidate: null, admitted: false`; the stuck set is
   `{P0, P1, P2, P3, P4}`.
9. Fixture `DL-BANKERS-5` passes: P1 requests `(2,0,0)` with `Need[P1] = (1,2,2)`
   and gets `EINVAL` for exceeding its declared maximum.
10. Fixture `DL-DETECT-1` passes: A/B/C = 7/2/6 with the sim spec 9.5
    Allocation and Request matrices and Available `(0,0,0)` gives **no
    deadlock**, finish order `P0, P2, P1, P3, P4`, final Work `(7,2,6)`.
11. Fixture `DL-DETECT-2` passes: the same state with P2's request changed to
    `(0,0,1)` gives deadlocked set `{P1, P2, P3, P4}`, only P0 finishes, and Work
    stops at `(0,1,0)`.
12. Fixture `DL-CYCLE-1` passes: a wait-for graph `P1 -> P2 -> P3 -> P1` gives
    cycle `[1, 2, 3]`, rotated to start at the lowest pid.
13. Fixture `DL-CYCLE-2` passes: an acyclic graph makes `detectDeadlock()` return
    `null`.
14. Fixture `DL-VICTIM-1` passes: a cycle of 3 with distinct priorities, cpu used
    and held counts gives a `suggestedVictims[0]` matching the sim spec 9.6
    comparator, and a convoy Program never sorts first when a non-convoy process
    is present.
15. Fixture `DL-PREVENT-1` passes: with `deadlockStrategy: 'prevent'`, a process
    holding rank 3 requesting rank 1 gets `EDEADLK` without blocking, and
    invariant I-24 holds on every tick of the run.
16. `SYNC-BB-DEADLOCK` from WP-07 now emits `deadlock.detected` with a cycle of
    exactly 2 pids.
17. `SYNC-PHIL-NAIVE` from WP-07 now emits `deadlock.detected` by tick 200 with a
    cycle of exactly 5 pids, and `report.conditions` contains all four
    `CoffmanCondition` values.
18. `SYNC-PHIL-ASYM`, `SYNC-PHIL-ROOM` and `SYNC-PHIL-MONITOR` each emit zero
    `deadlock.detected` over 20,000 ticks.
19. The cycle DFS is iterative: a synthetic graph of 100,000 nodes in one chain
    does not throw `RangeError: Maximum call stack size exceeded`.
20. Nothing in `src/kernel/deadlock/` cites section 8.6.2 or 8.3.2. Verified by a
    grep in the test file.
21. `git diff --exit-code src/kernel/types.ts src/game/types.ts` exits 0.
22. The forbidden-identifier scan still returns zero matches, and `DET-D1`,
    `DET-D3` and `DET-D4` still pass.

## Tests you must write

### `tests/kernel/deadlock/waitForGraph.test.ts`

| Case | Assertion |
|---|---|
| `DL-CYCLE-1` | `P1 -> P2 -> P3 -> P1` gives cycle `[1, 2, 3]` |
| `DL-CYCLE-2` | an acyclic graph returns `null` |
| `rotation` | the same three-node cycle discovered from start node 3 still returns `[1, 2, 3]` |
| `adjacency sorted` | every adjacency list is strictly ascending |
| `edge from requestedResources` | a process waiting on a resource held by two others gets edges to both |
| `edge from mutex` | a process blocked on a mutex gets an edge to its holder and not to itself |
| `edge from semaphore` | a process blocked on a semaphore gets edges to every holder |
| `edge from child_wait` | `blockedOn: { kind: 'child_wait', child: 7 }` gives an edge to pid 7; `child: null` gives no edge |
| `mailbox rendezvous cycle` | two processes that each `send` first on a capacity-0 mailbox produce a two-node cycle through the synthetic `mbox:` ids |
| `non-waiting process` | a `ready` process appears as a node with an empty adjacency list |
| `iterative dfs depth` | a 100,000-node chain does not overflow the stack |
| `deterministic choice` | a graph containing two disjoint cycles always reports the one containing the lowest pid |

### `tests/kernel/deadlock/bankers.test.ts`

| Fixture | Assertion |
|---|---|
| `DL-BANKERS-1` | per acceptance criterion 4, including all five `work` vectors `(5,3,2)`, `(7,4,3)`, `(7,5,3)`, `(10,5,5)`, `(10,5,7)` |
| `DL-BANKERS-1A` | the textbook order `P1, P3, P4, P0, P2` is also safe under `safetyCheckWithOrder` |
| `divergence documented` | the simulator's sequence differs from the textbook's, and both are safe; the test asserts this pair explicitly so the divergence is a fixture rather than a surprise |
| `need computed` | `Need` equals `Max - Allocation` for all fifteen cells of the 9.4.3 example |
| `available consistency` | allocated totals are A 7, B 2, C 5 and `Available` is `(3,3,2)` |
| `DL-BANKERS-2` | per acceptance criterion 6 |
| `DL-BANKERS-3` | per acceptance criterion 7 |
| `DL-BANKERS-4` | per acceptance criterion 8, plus: after the rollback, `Available` is exactly `(2,3,0)` and `Allocation[P0]` is exactly `(0,1,0)` |
| `DL-BANKERS-5` | per acceptance criterion 9 |
| `evaluateBankers does not commit` | calling it twice leaves `Available` unchanged, and the two results are identical |
| `bankers.evaluated emitted` | the event carries the same `SafetyCheckResult` and the triggering `{ pid, resource }` |
| `explanation format` | every `SafetyTraceStep.explanation` matches the two templates and contains no em dash or en dash |
| `ascending restart` | after admitting index 3, the next scan starts from index 0, verified on a state where index 1 becomes eligible only after index 3 |
| `column order` | resource columns are ascending lexicographic `ResourceId`, verified with ids `c`, `a`, `b` declared in that order |

### `tests/kernel/deadlock/detection.test.ts`

| Fixture | Assertion |
|---|---|
| `DL-DETECT-1` | per acceptance criterion 10, including the intermediate Work vectors `(0,1,0)`, `(3,1,3)`, `(5,1,3)`, `(7,2,4)`, `(7,2,6)` |
| `DL-DETECT-2` | per acceptance criterion 11 |
| `request not need` | replacing `Request` with `Need` in `DL-DETECT-1` gives a different answer, asserted so a future refactor cannot silently swap them |
| `holds nothing finishes` | a process with an all-zero allocation row is marked finished at step 1 |
| `detection interval` | with `deadlockDetectionInterval` 20, detection runs on ticks 20, 40, 60 and on no others |
| `avoid runs none` | under `deadlockStrategy: 'avoid'`, phase 9 performs zero detections over 1000 ticks |
| `detection latency` | a cycle formed at tick 23 and detected at tick 40 records a latency of 17 |
| `near deadlock` | a state satisfying three of four Coffman conditions appears in `nearDeadlocks()` and emits no `deadlock.detected` |
| `reader-only no cycle` | an `rwlock` held only by readers never contributes `mutual_exclusion`, so a reader-only wait pattern is never reported |
| `SYNC-BB-DEADLOCK` | per acceptance criterion 16 |
| `SYNC-PHIL-NAIVE` | per acceptance criterion 17 |
| `philosopher solutions clean` | per acceptance criterion 18 |

### `tests/kernel/deadlock/recovery.test.ts`

| Fixture | Assertion |
|---|---|
| `DL-VICTIM-1` | per acceptance criterion 14 |
| `comparator total` | the six-key comparator never returns 0 for two distinct pids, over 500 generated pairs |
| `convoy last` | with two convoy Programs and one plain process on a cycle, the plain process is `suggestedVictims[0]` |
| `convoy only` | with a cycle of convoy Programs only, the comparator still produces a total order and picks one |
| `abort_one repeats` | with two independent cycles, `abort_one` terminates one victim, re-detects, and terminates a second |
| `abort_all` | every process in the deadlock set is terminated in one pass |
| `termination reason` | every victim carries `terminationReason: 'deadlock_victim'` |
| `preempt preferred` | with a preemptible resource on the cycle, recovery uses `method: 'preempt'` and terminates nobody |
| `preempt fallback` | with no preemptible resource, recovery falls back to `method: 'terminate'` |
| `rollback restores` | with a checkpoint 12 ticks old, the holder's `serviceRemaining` is restored to the checkpoint value and the method is `'rollback'` |
| `checkpoint interval` | checkpoints are taken on ticks 25, 50, 75 and store exactly three fields |
| `preemption guard` | a process preempted 3 times becomes ineligible and the fourth recovery terminates instead |
| `shield converts` | `setPreemptible(r, true, tick + 20)` turns a termination into a preemption, and after 20 ticks the resource is non-preemptible again |
| `I-5 holds` | across a 5000-tick randomised run, `availableInstances + sum(allocation column) === totalInstances` for every resource on every tick |

### `tests/kernel/deadlock/strategies.test.ts`

| Fixture | Assertion |
|---|---|
| `ignore` | a deadlock forms and persists for 1000 ticks with zero `deadlock.detected` events |
| `detect` | the same workload produces `deadlock.detected` and `deadlock.resolved` |
| `avoid` | the same workload produces zero deadlocks and at least one `resource.denied { reason: 'unsafe' }` |
| `DL-PREVENT-1` | per acceptance criterion 15 |
| `prevent acyclic` | under `'prevent'`, `buildWaitForGraph` is acyclic on every one of 5000 ticks |
| `all_or_nothing` | under `preventionMode: 'all_or_nothing'`, zero deadlocks and a strictly lower average resource utilisation than `'prevent'` |
| `strategy report` | the four strategies on one workload produce a table with four distinct rows, and the test pins the recorded numbers |
| `avoid EINVAL terminates` | a process requesting beyond its declared max under `'avoid'` gets `EINVAL` and is terminated with `protection_fault` |
| `citation grep` | no file under `src/kernel/deadlock/` contains the strings `8.6.2` or `8.3.2` |

## Out of scope

- `src/kernel/syscall/**`. WP-11 owns the syscall table. This package exposes
  `request` and `release` as plain functions for WP-11 to wire.
- `src/kernel/sync/**`. WP-07 owns it. This package **reads** `holders` and
  `waitQueue`; it never mutates a `SyncPrimitive` except through the release path
  WP-07 exposes.
- `src/kernel/scheduler/**`, `memory/**`, `storage/**`, `io/**`, `fs/**`,
  `security/**`, `invariants.ts`.
- Game-layer afflictions and Program names. Expose `setPreemptible` and stop.
- Any change to `Kernel.ts` beyond wiring the phase 9 hook and implementing
  `evaluateBankers` and `detectDeadlock`.
- Anything outside `src/kernel/deadlock/`, `tests/kernel/deadlock/` and the one
  permitted edit.

## Report back

State:

1. Pass or fail for each of the twenty-two acceptance criteria, by number.
2. The four verification command outcomes, including the contract guard.
3. The safe sequence your implementation produced for `DL-BANKERS-1`, and
   confirmation that you did **not** change the algorithm to match the
   textbook's `<P1, P3, P4, P0, P2>`.
4. The recorded four-row strategy comparison table (deadlocks, processes lost,
   average resource utilisation, total ticks) as now frozen.
5. The tick at which `SYNC-PHIL-NAIVE` now emits `deadlock.detected`, and the
   `conditions` array it carried.
6. Confirmation that no file in this package cites 8.6.2 or 8.3.2, and that
   `types.ts` was left untouched.
7. Every `// TODO(astra):` left in the tree, with file and line.

## Scope correction 2026-09-14

Written before WP-08 starts, after WP-07 merged. The package above predates
six merged packages, so several of its statements are stale. Where this
section disagrees with the text above, this section wins.

- **Verification is four gates, not three.** `npm run check:contracts`
  precedes typecheck, test and build. The guard fails on any frozen-file edit,
  a second scanner, a skipped test, or an em dash anywhere in the tree.
- **Snapshot obligation.** `KernelSnapshot.subsystems.deadlock` is your slot,
  currently a `SubsystemEnvelope`. Fill it through
  `installHooks({ snapshots })` with `saveState` and `restoreState` (restore
  returns a commit closure). Promote it to a typed `DeadlockSnapshotState`
  through the amendment procedure in the kickoff prompt: exact patch, written
  approval, contract-only commit, then implementation. Provisional number 8.
- **Syscall branches are yours.** `request` and `release` are two branches in
  the dispatcher in `Kernel.ts`, in the same style as WP-07's four sync
  branches (argument shape check, delegate to your subsystem, WP-11 validates
  fully). The package's "expose as plain functions for WP-11 to wire" sentence
  is superseded. The existing `acquire` and `release` instruction kinds route
  to `SyncHooks.acquire` and `release`; the resource-table request path is a
  syscall, not those instructions.
- **Granted Kernel.ts regions**, beyond the phase 9 hook wiring and the two
  method bodies: the two dispatcher branches; constructor wiring for your
  subsystem (host callbacks for tick, process lookup, emit, terminate, and
  the sync ownership view); binding your live resource array into
  `this.resources` in `initialiseFrameTable`, the way WP-07 bound
  `syncPrimitives`; and `setDeadlockStrategy`-adjacent state if the package
  needs it. `evaluateBankers` and `detectDeadlock` are throw-stubs today and
  become yours. Report exact line ranges.
- **Prevention ordering reaches into sync.** Under `deadlockStrategy:
  'prevent'`, a `mutex_lock` or `sem_wait` that violates the rank order must
  return `EDEADLK` without blocking. Do this by giving `SyncSubsystem` a
  pre-acquire check callback that your subsystem installs, not by editing
  sync's own logic: list the exact sync-side hook you need in the pre-flight
  and wait. `src/kernel/sync/**` stays WP-07's.
- **WP-07's tests are protected.** Acceptance 16 to 18 are asserted in your
  own `tests/kernel/deadlock/` files by building the WP-07 scenarios through
  their public constructors, never by editing `tests/kernel/sync/**`.
- **Rollback recovery.** Full fresh-kernel restore is WP-11's and has not
  landed, so "preemption with rollback" cannot restore a whole kernel. Scope
  rollback to what the process and resource tables can express today: return
  the preempted instances, put the victim back at its last resource-free
  program counter recorded by your subsystem, and emit
  `deadlock.resolved { method: 'rollback' }`. State in the pre-flight exactly
  what your rollback restores and what it does not.
- **Naming.** The kernel's setting is `deadlockStrategy` with four values as
  frozen in `KernelConfig`; the interval is `deadlockDetectionInterval` in
  tuning. Do not add config keys without listing them in the pre-flight.

## Inherited from WP-07: what sync exposes, and the merge surface

WP-07 landed on main after a318f7b. Its shared-file footprint at that merge:

| File | Every touched range |
|---|---|
| `src/kernel/Kernel.ts` | 14; 17; 121; 173; 230; 314; 346-386; 515-526; 548; 658-659; 783-786; 852-858; 860-866; 998 |
| `src/kernel/config.ts` | 29-35; 57-58; 116-121 (six keys) |
| `src/kernel/process/Program.ts` | 4; 8; 42-44 (one `sync` Instruction variant) |
| `src/kernel/index.ts` | none |

None of the eleven phase bodies changed. `execute` was split into `execute`
(attempt bookkeeping) and `executeInstruction` (the switch); phase 8 still
calls `execute`. `SyncHooks.isSatisfied` gained an optional `tid`.

What sync exposes to you, from the WP-07 report:

- `SyncSubsystem` (constructed in the Kernel constructor as
  `this.syncSubsystem`) holds detailed actor ownership `(pid, tid)`, wait
  generations and ordered queues. Read its public surface before designing
  the wait-for graph; ask in the pre-flight for any accessor it lacks.
- Counting-semaphore permit provenance is **not** an exclusive-owner edge.
  Only mutex owners, monitor-lock owners and rwlock writers are exclusive
  owners. Build wait-for edges from exclusive ownership plus the
  signalling dependencies the scenarios declare; do not treat a permit
  holder as the process a waiter waits for.
- Monitor conditions are a live Map separate from the entry queue; the
  shared `syncPrimitives` projection copies only the eight frozen base
  fields.
- `SYNC-BB-DEADLOCK` and `SYNC-PHIL-NAIVE` already reach reproducible
  blocked states (naive philosophers: five-way circular wait at tick 61 at
  the reference seed). Your detector turns those states into
  `deadlock.detected`; their `deadlock.detected` assertions were left out of
  WP-07's tests on purpose and are yours to add in your own files.
- Mailbox waits use synthetic semaphore resource ids owned by
  `process/ipc.ts`; the wait-for graph must see them.
- Every WP-07 module keeps state in side tables keyed by actor; there is no
  new PCB or TCB field, and there must be none from you either.


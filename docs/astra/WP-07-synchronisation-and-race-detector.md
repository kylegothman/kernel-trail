# WP-07: Synchronisation primitives and the race detector

## Objective

When this package is done the kernel has all five synchronisation primitives with
textbook semantics, the three critical-section requirements are checked and
reported by name, Peterson's solution runs correctly under sequential consistency
and visibly breaks under store reordering, test-and-set and compare-and-swap work
as atomic single-tick instructions, priority inversion is detected and curable by
inheritance, and a two-detector race finder produces the exact interleaving trace
the codex prints. The bounded buffer, both readers-writers problems and all four
dining philosophers solutions run as reproducible scenarios. This is the
simulation half of Legs 4 and 5.

## Prerequisites

WP-02 complete and green.

Files that must already exist:

- `src/kernel/types.ts` (frozen)
- `src/kernel/Kernel.ts` with the `SyncHooks` interface and its no-op default,
  and phase 4's delegation of `semaphore`, `mutex` and `condition` block reasons
- `src/kernel/process/ipc.ts` with `SharedRegion` and `Mailbox`
- `src/kernel/process/Program.ts` with the `acquire` and `release` instructions

## Required reading

- `02-KERNEL-SIM-SPEC.md` section 8 in full: 8.1 (the three requirements and how
  each is checked), 8.2 (Peterson and the memory order model), 8.3 (test-and-set
  and compare-and-swap), 8.4 (all five primitives with their exact pseudocode),
  8.5 (priority inversion), 8.6 (the race detector, specified in full because
  there is no textbook algorithm to copy), 8.7 (bounded buffer), 8.8
  (readers-writers), 8.9 (dining philosophers)
- `02-KERNEL-SIM-SPEC.md` section 2.1, phase 4, for the wake ordering rule
- `02-KERNEL-SIM-SPEC.md` section 3.8, since mailbox blocking uses synthetic
  sync resource ids and the wait-for graph must see them
- `02-KERNEL-SIM-SPEC.md` section 16.7 (the synchronisation fixture table)
- `02-KERNEL-SIM-SPEC.md` section 15, the "Synchronisation and deadlock"
  invariant group, so I-20 and I-21 hold by construction

## Files you will create

```
src/kernel/sync/SyncSubsystem.ts
src/kernel/sync/mutex.ts
src/kernel/sync/semaphore.ts
src/kernel/sync/monitor.ts
src/kernel/sync/rwlock.ts
src/kernel/sync/barrier.ts
src/kernel/sync/atomics.ts
src/kernel/sync/memoryOrder.ts
src/kernel/sync/peterson.ts
src/kernel/sync/raceDetector.ts
src/kernel/sync/priorityInversion.ts
src/kernel/sync/requirements.ts
src/kernel/sync/scenarios/boundedBuffer.ts
src/kernel/sync/scenarios/readersWriters.ts
src/kernel/sync/scenarios/philosophers.ts
tests/kernel/sync/primitives.test.ts
tests/kernel/sync/peterson.test.ts
tests/kernel/sync/atomics.test.ts
tests/kernel/sync/raceDetector.test.ts
tests/kernel/sync/boundedBuffer.test.ts
tests/kernel/sync/readersWriters.test.ts
tests/kernel/sync/philosophers.test.ts
```

## Files you may modify

```
src/kernel/Kernel.ts   (wire SyncHooks to SyncSubsystem. Nothing else.)
src/kernel/index.ts    (no new export required; leave it alone unless the barrel
                        needs SyncSubsystem, which it should not)
```

Nothing else.

### Scope correction, 2026-09-13

Raised by the audit of this package against its own specification and against the
current `Kernel.ts`, `config.ts` and syscall dispatch, before the package started.
The grant above excluded seven things this package itself requires. This is the
same defect shape that produced the five escalations recorded in
`docs/07-CONTRACT-AMENDMENTS.md` under "Package scope corrections". Approved as
follows, shaped for WP-09, which runs at the same time and edits the same four
shared files.

**The four synchronisation syscall branches.** `sem_wait`, `sem_post`,
`mutex_lock` and `mutex_unlock` are rows of sim spec 14.3 and this package owns
their semantics, but `dispatchSyscall` in `Kernel.ts` currently ends at a default
branch returning `EINVAL` with `not implemented in WP-02`, so none of them is
reachable. Add exactly those four cases and nothing else. Each one routes into
`SyncSubsystem` and returns the value sim spec 14.3 states for it. Unknown or
malformed input returns `EINVAL`. Mark every branch
`// TODO(astra): WP-11 validates <call> arguments`, because WP-11 owns the full
table and the arity, type, range and rights checks of sim spec 14.2, and will
rebase onto these branches.

**`request` and `release` are not yours.** Both are rows of sim spec 14.3, but
every one of their four `deadlockStrategy` paths operates on the `ResourceType`
table, and WP-08 owns that table outright (`src/kernel/deadlock/resources.ts`,
the `Map<ResourceId, ResourceType>` and its sorted id list). Nothing in the tree
constructs a `ResourceType` today because its owner has not started. Do not add
either syscall branch, do not create a resource table, and do not route these
calls into `SyncSubsystem`. Leave the default branch as it is. Your grant is the
four sync branches above, not six.

**Snapshot save and restore for the `sync` slot.** Required by acceptance
criterion 21 and by amendment 1. Register through `installHooks({ snapshots })`
using `saveState` and `restoreState`, exactly as WP-05 left it. `restoreState`
validates the envelope, captures detached state, and returns a commit closure;
it mutates nothing during preparation, because the kernel prepares every
contribution before it changes any state. Add no hard-coded slot key to the
snapshot object literal. Duplicate slot ownership is rejected, so register the
`sync` slot once.

**Publishing the primitive table into the shared snapshot tables.** Both
`snapshot()` and the existing invariant check read the private `syncPrimitives`
field on `KernelImpl`, which no code writes outside `restore`. Wiring `SyncHooks`
alone leaves it permanently empty, so `KernelSnapshot.syncPrimitives` stays empty
and invariants I-10, I-21 and I-23 have nothing to check. Bind the live array in
the existing initialisation helper, the way WP-05 bound the frame and TLB views
there, and rebind it after a restore commit. Bind the live array itself rather
than copying per call, so direct edits stay visible.

**A once-per-tick phase-4 entry point for priority inversion.** Sim spec 8.5
detects the inversion in phase 4, and `SyncHooks` has no member that phase 4
calls once per tick: `isSatisfied` is called per waiting thread, only for
`semaphore`, `mutex` and `condition` reasons, and only while the `process`
subsystem is enabled. Do not edit the phase 4 body. Run detection from the first
`isSatisfied` call of a tick, guarded by a last-seen tick held in the subsystem.
If that cannot produce the ordering sim spec 8.5 requires, escalate for a new
`SyncHooks` member rather than touching the phase.

**Construction wiring.** Constructing `SyncSubsystem` in the kernel constructor
is part of wiring `SyncHooks`, and it includes handing the subsystem its emit
callback and its `root/sync` stream, taken from the stream registry the same way
`schedulerContext()` takes the `scheduler` stream. `kernel.panic` for a progress
violation and `process.starving` for a bounded-waiting violation both travel on
that emit callback.

**`src/kernel/config.ts`, additive only.** This package names or implies six
tuning knobs that do not exist. Add exactly these keys to `KernelTuning`, with
defaults, and validate each with the pattern the existing knobs use:

| Key | Default | Source |
|---|---|---|
| `progressStallLimit` | 4 | sim spec 8.1, requirement 2 |
| `boundedWaitLimit` | 0, meaning "the contending process count" | sim spec 8.1, requirement 3 |
| `spinWaitTicks` | 1 | sim spec 8.3, one tick per spin iteration |
| `storeBufferDepth` | 2 | sim spec 8.2, `MemoryOrderModel` |
| `priorityInheritance` | false | sim spec 8.5 |
| `rwlockPolicy` | `'writer_pref'` | sim spec 8.4 and 8.8 |

The three integer knobs use the existing integer check. `priorityInheritance` is
a boolean and `rwlockPolicy` is a literal union, so validate them the way
`threadModel` and `checkInvariants` are validated rather than inventing a new
helper. `boundedWaitLimit` at 0 means the Ch. 6.2 bound rather than a limit of
zero, so comment it. Do not reformat anything, and do not touch a key you did not
add: this file is shared with WP-09, which is adding its own keys at the same
time.

Spin ticks must count as CPU busy per sim spec 8.3, and neither
`src/kernel/scheduler/metrics.ts` nor the phase 10 registration site is in this
grant. Model each spin iteration as an instruction that consumes service, so the
existing phase 8 accounting charges it without any edit. If that cannot be done,
escalate. A separate `spin%` column is a terminal concern and stays out.

**Metrics recomputation.** There is no `SyncMetrics` type in the frozen contract
and `MetricsHooks` carries only `scheduler` and `memory`, so this package
registers no metrics hook. If one becomes necessary, register at the existing
phase 10 dispatch site and look for the registration marker. Phase 10 itself is
not edited.

**What stays out.** The eleven ordered phase bodies are not edited; anything that
would require it is an escalation. `src/kernel/scheduler/**`,
`src/kernel/memory/**`, `src/kernel/deadlock/**` and `invariants.ts` stay out.
WP-09 is in flight and owns `src/kernel/storage/**`, `src/kernel/io/**`, the
`storage` and `io` snapshot slots, the `ioctl` and `sync` syscall branches, the
`setDiskPolicy` implementation, phases 2 and 3 wiring, the `DISK_POLICIES` export
in `index.ts` and its own `config.ts` keys. Do not touch any of those, and do not
reorder or reformat the lines they will add.

**Two things WP-05 warns about, and they apply here.** First, installing runtime
hooks still trips WP-02's init-only snapshot guard: `installHooks` sets the
guard flag for every key except `snapshots`, so a kernel with `sync` hooks
installed refuses `snapshot()` and `restore()`. The round-trip test for criterion
21 must therefore register snapshot-only, through `installHooks({ snapshots })`
with no other key, which is the one case the guard allows. Second, the generic
snapshot dispatch does not finish WP-11's workload persistence: the process
contribution, the completeness check and the removal of the guard stay WP-11's,
and its throwing assertions remain in place.

## Frozen contracts

From `src/kernel/types.ts`. These may not be edited. If this package cannot be
completed without changing one, stop and report per the escalation procedure.

```ts
export type SyncPrimitiveKind = 'mutex' | 'semaphore' | 'monitor' | 'rwlock' | 'barrier';

export interface SyncPrimitive {
  readonly id: ResourceId;
  readonly kind: SyncPrimitiveKind;
  readonly displayName: string;
  /** Semaphore count, mutex 0/1, rwlock reader count. */
  value: number;
  readonly capacity: number;
  holders: Pid[];
  waitQueue: Pid[];
  /** FIFO wait queues are bounded-wait; unordered ones are not. Ch. 6.2. */
  readonly ordered: boolean;
}

/** A detected data race, used to teach why unsynchronised access is unsafe. */
export interface RaceCondition {
  readonly tick: Tick;
  readonly participants: readonly Pid[];
  readonly location: string;
  readonly interleaving: readonly string[];
  readonly corruptedValue: number;
  readonly expectedValue: number;
}

export type BlockReason =
  | { kind: 'semaphore'; resource: ResourceId }
  | { kind: 'mutex'; resource: ResourceId }
  | { kind: 'condition'; monitor: ResourceId; condition: string }
  | { kind: 'io'; device: DeviceId }
  | { kind: 'page_fault'; page: PageId }
  | { kind: 'child_wait'; child: Pid | null }
  | { kind: 'sleep'; untilTick: Tick };
```

Events this package emits, from the frozen union:

```ts
| (EventBase & { type: 'sync.acquired'; pid: Pid; resource: ResourceId; kind: SyncPrimitiveKind })
| (EventBase & { type: 'sync.blocked'; pid: Pid; resource: ResourceId; queueLength: number })
| (EventBase & { type: 'sync.released'; pid: Pid; resource: ResourceId; woke: Pid | null })
| (EventBase & { type: 'sync.race_detected'; race: RaceCondition })
| (EventBase & { type: 'sync.busy_wait'; pid: Pid; resource: ResourceId; spunTicks: number })
| (EventBase & { type: 'process.starving'; pid: Pid; waitedTicks: number; fatal: boolean })
| (EventBase & { type: 'kernel.panic'; message: string })
```

`Monitor` extends `SyncPrimitive` with extra fields. Since the frozen interface
cannot be widened, declare a local interface in `src/kernel/sync/monitor.ts` that
`extends SyncPrimitive` and adds `conditions` and `signalDiscipline`. Extension
by a local interface is allowed; editing `types.ts` is not.

## Inherited from WP-05

WP-05 landed before this package and changed four shared files. Everything below
comes from its completion report or from the source it left behind. Read it before
you edit `Kernel.ts`.

### Snapshot registration

Snapshot save and restore is a dispatch over installed hooks rather than a growing
object literal. The installed contract is:

```ts
interface SnapshotHooks {
  saveState(): Partial<SubsystemSnapshots>;
  restoreState(snapshot: KernelSnapshot): () => void;
}
```

`restoreState` prepares and returns a commit closure. The kernel prepares every
contribution before changing state, then calls the returned commits. Register with
`installHooks({ snapshots })`. No further hard-coded slot keys are needed in the
snapshot literal. Duplicate slot ownership is rejected. Validate and capture
detached state before returning the closure, and do not mutate anything during
preparation.

### The init-only guard trap

Installing runtime hooks still enables WP-02's full-workload snapshot guard;
snapshot-only registration works without enabling it. So the round-trip test must
register through `installHooks({ snapshots })` and pass no other key, or
`snapshot()` and `restore()` will throw before your state is reached. Generic
contribution dispatch does not finish WP-11's workload persistence, and WP-11's
existing throwing assertions remain intact.

### Phase 4 is a readiness query, not a queue operation

`isSatisfied(pid, reason)` answers whether the wait is satisfied and nothing more.
Phase 4 owns waking the thread, recomputing the process and moving it to `ready`,
and every ready-queue insertion happens in one place inside the kernel. Do not
insert into the ready queue, do not call `move`, and do not wake a process from
inside a primitive operation. Mark waiters wakeable and let phase 4 move them.

Phase 4 consults the IPC manager first: when `ipc.matchesWait(pid, reason)` is
true for a `semaphore`, `mutex` or `condition` reason, the completion comes from
IPC and `SyncHooks.isSatisfied` is not asked. Mailbox waits therefore reach phase
4 as synthetic sync resources under those same three block reasons, which is why
your `isSatisfied` must return false for a resource it does not own rather than
throwing.

### Blocking applies thread-model semantics for you

`blockProcess(pid, reason, tid?)` is the kernel's entry point. It selects the
thread, applies the thread model, and moves the whole process to `waiting` only
when the model says the whole process blocks; otherwise it recomputes the process
and returns it to `ready`. Call it with the reason you want recorded and let it
decide. It throws when the target is not running, so never call it for a process
the scheduler has not dispatched.

### The shared-region value for the race detector

Only `SharedRegion.value` and inode metadata are racy, and the shared regions live
in the IPC manager the kernel holds as its public `ipc` field. Read the value
through that manager rather than keeping a second copy, or the detector and the
kernel will disagree after a restore. `src/kernel/process/ipc.ts` was not part of
WP-05's surface and the report does not quote its accessor, so report the exact
accessor you used.

### The merge surface WP-05 left

These are inclusive line ranges in the post-WP-05 files. They are the lines you are
most likely to collide with, and WP-09 is editing several of them at the same time.

| Kernel.ts lines | Change |
|---|---|
| 16 | MemorySubsystem import |
| 49 | SubsystemSnapshots type import |
| 56 | Remove now-unused bootstrap frame-ID import |
| 147-151 | SnapshotHooks interface |
| 153 | Optional snapshots registration on KernelHooks |
| 169-170 | Memory subsystem and snapshot registry fields |
| 197 | Readonly live TLB view type |
| 210 | Replace bootstrap MemoryHooks initializer with bound field |
| 235 | Register memory metrics at the existing dispatch registration site |
| 251-266 | Construct subsystem, bind memory callbacks and register its snapshot hooks |
| 285 | Existing exec detach callback: IPC detach then memory cleanup/ASID flush |
| 302 | Existing exit wait-cleanup callback: memory cleanup after IPC detach |
| 337-338 | Install snapshot hooks; allow snapshot-only registration without opaque-runtime-hook restriction |
| 435-438 | `ioctl('tlb_flush')`, EINVAL otherwise, exact WP-11 validation marker |
| 475-477 | Set allocator and update current configuration |
| 519 | Wrap the existing snapshot in contribution dispatch |
| 530-539 | Merge installed snapshot contributions and reject duplicate slot ownership |
| 549 | Prepare every installed restore contribution before state mutation |
| 576-577 | Commit prepared contributions and rebind live frame/TLB views |
| 724-726 | Execute helper defers service while a resident translation is incomplete |
| 834-835 | Bind actual frame/TLB arrays in the existing initialization helper |

| Other shared file | Inclusive changed lines |
|---|---|
| `src/kernel/config.ts` | 10-11: tuning types; 24: defaults; 60-61: validation |
| `src/kernel/index.ts` | 6: allocator export |
| `src/kernel/process/threads.ts` | 208-211: deferral flag/method; 223-226: capture useful service before consumption; 229-232: restore deferred useful service |

New tuning keys are distinct and additive, and no existing knob was reformatted.
Keep yours the same way.

## Specification

### 1. `src/kernel/sync/requirements.ts`

The three critical-section requirements from sim spec 8.1. The simulator checks
all three and reports which one a scenario violates.

1. **Mutual exclusion.** A per-primitive counter `inCriticalSection` that must
   never exceed the primitive's capacity. This is invariant I-20.
2. **Progress.** If the primitive is free and its `waitQueue` is non-empty for
   `progressStallLimit` consecutive ticks (default 4), emit `kernel.panic` with
   the message `` `progress violated on ${resource}` ``. A correct implementation
   never triggers it; the deliberately broken teaching implementations do.
3. **Bounded waiting.** Each waiter records `entriesObservedWhileWaiting`; if it
   exceeds `boundedWaitLimit` (default: the number of contending processes, which
   is the bound Ch. 6.2 asks for), emit `process.starving { fatal: false }`
   against that pid.

`SyncPrimitive.ordered` distinguishes the two bounded-waiting cases:
`ordered: true` means a FIFO wait queue, giving a bound of `n - 1`;
`ordered: false` means the wake target is drawn with `rng.pick`, which gives no
bound and will eventually trigger the check. Leg 4 runs both.

### 2. The five primitives, `src/kernel/sync/*.ts`

Semantics per kind, from sim spec 8.4:

| Kind | `value` means | `capacity` | `holders` | Wake policy |
|---|---|---|---|---|
| `mutex` | 1 free, 0 held | 1 | 0 or 1 pids | head of `waitQueue` |
| `semaphore` | current count | initial count | pids that decremented and have not posted | head, or `rng.pick` when `ordered: false` |
| `monitor` | 1 free, 0 held | 1 | 0 or 1 | head; condition queues are separate |
| `rwlock` | reader count, or -1 when a writer holds it | max readers | all readers, or the single writer | writer-preferring |
| `barrier` | processes arrived | party size | all arrived | all released when `value === capacity` |

**Mutex.** Implement `mutex_lock` and `mutex_unlock` exactly as the pseudocode in
sim spec 8.4 states. The **direct hand-off** at unlock step 3 is load-bearing: if
`mutex_unlock` set `value = 1` and merely woke the waiter, a third process could
acquire the mutex between the wake and the waiter's dispatch, which is barging
and it breaks bounded waiting. Hand-off makes a FIFO mutex genuinely FIFO. Write
a test that would fail under a barging implementation.

**Counting semaphore.** Implement `sem_wait` and `sem_post` exactly as the
pseudocode states, including the sign convention: **a negative `value` is the
number of waiters**, and the HUD prints it that way, so `sem_wait` on a semaphore
showing -3 is visibly the fourth waiter. Do not clamp `value` at zero.

A **binary semaphore** is a semaphore with `capacity === 1`. It differs from a
mutex in exactly one respect: any process may `sem_post` a semaphore, while only
the holder may `mutex_unlock` a mutex. Enforce that difference; it is the whole
reason both exist.

**Monitor with condition variables.** Implement `monitor_enter`, `monitor_exit`,
`cond_wait`, `cond_signal` and `cond_broadcast` exactly as the pseudocode states.
Note that `cond_wait` step 3 releases the monitor lock with hand-off, and that on
wake the process must re-acquire the lock before proceeding. `cond_signal` on an
empty queue is a no-op.

Default discipline is `signal_and_continue` (Mesa), because that is what every
real system does and because it forces the correct idiom
`while (!predicate) cond_wait(m, c)`, never `if`. Also implement
`signal_and_wait` (Hoare), where the signaller releases the lock directly to the
woken process and joins the entry queue.

Ship the broken `if` version as scenario `SYNC-MONITOR-BROKEN`, where a woken
process proceeds on a predicate a third process falsified in between.

**Reader-writer lock.** Writer-preferring by default, per the four procedures in
sim spec 8.4. Also implement `rwlockPolicy: 'reader_pref'`, which starves
writers and is the first readers-writers problem, and `rwlockPolicy: 'fair'`, a
ticket lock where readers and writers take a monotonically increasing ticket and
are served in ticket order with consecutive readers batched.

**Barrier.** `barrier_wait` increments `value` and blocks. When
`value === capacity`, every waiter is marked wakeable **in one phase** and
`value` resets to 0.

All wakes are marked wakeable and moved by phase 4, never moved inline. This is
the rule that keeps every ready-queue insertion in one place.

### 3. `src/kernel/sync/memoryOrder.ts` and `peterson.ts`

Peterson's solution is implemented as a **scenario, not a kernel primitive**,
because its purpose is to be examined and then discarded. Each numbered line of
the six-line entry section is one `Instruction` in the process's program, so the
simulator interleaves at exactly the granularity that makes the argument.

```ts
interface MemoryOrderModel {
  /** When true, a store may be delayed by up to storeBufferDepth instructions. */
  readonly reordering: boolean;
  readonly storeBufferDepth: number;      // default 2
}
```

Under `reordering: true`, a store instruction goes into a per-process store
buffer instead of being applied. The buffer drains one entry per tick in FIFO
order, **except** that when `storeBufferDepth > 1` the sim drains it in an order
chosen by `rng.shuffle` on the `root/sync` stream, which models a processor free
to commit independent stores in any order. An `mfence` instruction drains the
buffer completely before proceeding.

The failure the model produces is the one Ch. 6.3 names: line 1 writes `flag[i]`
and line 2 writes `turn`, which are independent addresses, so a processor may
commit them in the opposite order. If both processes have lines 1 and 2
reordered, both observe `flag[j] === false` at line 3 and both enter.

### 4. `src/kernel/sync/atomics.ts`

Test-and-set and compare-and-swap, both **atomic within a single tick**, which is
the definition of an atomic instruction in a tick-quantised simulator.

Test-and-set satisfies mutual exclusion and does **not** satisfy bounded waiting:
a process can lose the race arbitrarily many times, and the bounded-waiting check
from section 1 fires against the loser. That is how the player discovers the flaw
without being told it.

Each spin iteration costs one tick and emits `sync.busy_wait { spunTicks }`.
Those wasted ticks are counted in `SchedulingMetrics.cpuUtilisation` as **busy**,
which is exactly why busy waiting is deceptive: utilisation looks perfect while
nothing is accomplished. Expose `spinTicks(pid)` so WP-15's `top` command can
show a separate `spin%` column.

Compare-and-swap backs the lock-free counter in the race scenario, so the player
can fix a race either by taking a mutex or by retrying a CAS and then compare the
two on the metrics. Also implement the bounded-waiting version of Ch. 6.4.2 using
a `waiting[]` array and a hand-off, exposed as scenario `SYNC-CAS-BOUNDED`.

### 5. `src/kernel/sync/raceDetector.ts`

Specified in full in sim spec 8.6 because there is no textbook algorithm to copy.
Implement it exactly.

**What is racy.** Only `SharedRegion.value` and inode metadata. Ordinary process
memory is private, so there is nothing to race on.

```ts
interface SharedCell {
  readonly id: string;                 // "region:counter" or "inode:7.size"
  value: number;
  /** Eraser-style candidate lock set. Null until the first access. */
  lockSet: Set<ResourceId> | null;
  readonly pending: Map<Pid, { loadedValue: number; loadedAtTick: Tick; heldAt: ResourceId[] }>;
  readonly history: AccessRecord[];    // ring buffer, capacity 32
}

interface AccessRecord {
  readonly tick: Tick;
  readonly pid: Pid;
  readonly op: 'load' | 'store';
  readonly value: number;
  readonly held: readonly ResourceId[];
}
```

**Detector 1, lockset refinement (Eraser).** On every access to cell `c` by
process `p`:

```
1. held = the sync-primitive ResourceIds in p.heldResources
2. if c.lockSet === null:  c.lockSet = new Set(held)
3. else:                   c.lockSet = intersection(c.lockSet, held)
4. if c.lockSet.size === 0 and c.history contains an access by a different pid:
       report a potential race
```

An empty lockset after two different processes have touched the cell means no
single lock protects it. This catches races that never corrupt anything on this
particular interleaving, which is what makes it useful.

**Detector 2, lost update.** Read-modify-write is three instructions (`load`,
`compute`, `store`), so the window is explicit:

```
On load  by p:  c.pending.set(p, { loadedValue: c.value, loadedAtTick: tick, heldAt: held })
On store by p:  const e = c.pending.get(p)
                if (e && e.loadedValue !== c.value) report a confirmed race
                c.value = storedValue
                c.pending.delete(p)
```

`expectedValue` is what the cell would hold if every pending operation had run
serially: track it as a shadow counter `c.serialValue`, updated on every store by
the amount the storing process intended to add. `corruptedValue` is `c.value`
after the store.

**The interleaving trace.** Build it exactly as `buildInterleaving` in sim spec
8.6 does, from the earliest still-pending load up to the offending store:

```ts
`t=${r.tick} P${r.pid} ${r.op === 'load' ? 'LOAD ' : 'STORE'} ${c.id} ` +
`${r.op === 'load' ? '->' : '<-'} ${r.value}` +
(r.held.length ? ` [holds ${r.held.join(',')}]` : ' [holds nothing]')
```

Note the two-space `'LOAD '` so the columns align. The canonical two-process
counter trace reads:

```
t=41 P3 LOAD  region:counter -> 100 [holds nothing]
t=42 P4 LOAD  region:counter -> 100 [holds nothing]
t=43 P3 STORE region:counter <- 101 [holds nothing]
t=44 P4 STORE region:counter <- 101 [holds nothing]
```

with `corruptedValue: 101` and `expectedValue: 102`.

**False-positive suppression.** Detector 1 alone reports cells protected by
different-but-equivalent locks and cells read-only after initialisation, so:

- A cell accessed by exactly one pid so far is never reported.
- A cell whose accesses are all `load` is never reported; read-read is not a
  race.

Detector 2 has no false positives by construction.

### 6. `src/kernel/sync/priorityInversion.ts`

Detected in phase 4, per sim spec 8.5:

1. For each blocked process `H` with `blockedOn.kind` in `{mutex, semaphore}`,
   find the holder `L`.
2. If `L.priority > H.priority` numerically (so lower priority), `L` is in state
   `ready`, and some process `M` with `H.priority < M.priority < L.priority` is
   running, the inversion holds.
3. Report it. The kernel does not know about game-layer afflictions, so expose
   `inversions(): readonly { blocked: Pid; holder: Pid; interposed: Pid }[]` and
   let `@game` map it to the `priority_inversion` affliction.

**Priority inheritance** is the remedy, `priorityInheritance: boolean`, default
**false** so the pathology is reachable. When on, at step 2 the kernel sets
`L.priority = H.priority` for as long as `L` holds the mutex, restoring
`L.basePriority` when the mutex is released.

### 7. The three scenarios

**Bounded buffer**, sim spec 8.7. Three semaphores `mutex = 1`, `empty = n`,
`full = 0`, with the five-step producer and five-step consumer. Also ship the
two variants:

- `SYNC-BB-DEADLOCK`: swap producer lines 1 and 2 so `mutex` is taken before
  `empty`. When the buffer fills, a producer holds `mutex` while blocked on
  `empty` and no consumer can take `mutex` to drain it. The remedy the player must
  derive is the ordering rule: acquire the counting semaphore before the mutex,
  always.
- `SYNC-BB-UNBALANCED`: producers at service 1 against consumers at service 5.
  The buffer saturates and `cpuUtilisation` collapses even though nothing is
  wrong. The fix is more consumers or a larger `n`, not a scheduler change.

**Readers-writers**, sim spec 8.8. Implement the first problem's exact semaphore
code (reader-preferring) as a scenario, and drive the second problem through the
`rwlock` primitive with `rwlockPolicy: 'writer_pref'`. Neither problem is
solvable without starving somebody, which is Ch. 7.1.2's actual point, and the
sim proves it by running both and producing two starvation events with different
names. Also implement `'fair'`.

**Dining philosophers**, sim spec 8.9. Five philosophers, five chopsticks,
chopstick `i` between philosopher `i` and `(i + 1) mod 5`. Each cycles: think for
`rng.int(5, 15)` ticks, pick up two chopsticks, eat for `rng.int(5, 15)` ticks,
put both down. All draws from `root/sync`.

Four solutions: naive (left then right), asymmetric (odd philosophers take right
first), arbitrator (semaphore `room` capacity 4), and the Ch. 7.1.3 monitor with
a `state[5]` array and one condition variable per philosopher, whose three
procedures are printed in the sim spec and must be implemented as written.

The naive solution must deadlock **deterministically**, not by luck: the
scheduler is round robin with `quantum = 1`, large enough for step 2 and small
enough that no philosopher gets through step 3. A deadlock the player cannot
re-enter is a deadlock they cannot study.

The monitor solution is deadlock-free but **not starvation-free**: two
philosophers can alternate and starve the one between them. Assert that honestly
rather than working around it.

The four-row comparison table in sim spec 8.9 is fixture `SYNC-PHIL-TABLE`.
Meals completed and worst individual wait are **recorded at implementation**:
print them, pin them, and report the values. They are not textbook figures and
must not be invented.

### 8. `src/kernel/sync/SyncSubsystem.ts`

Satisfies `SyncHooks` from WP-02. Owns the primitive table
(`Map<ResourceId, SyncPrimitive>` plus a sorted key array for iteration), the
shared cell table, the store buffers, and the requirement checkers. Implements
`isSatisfied(pcb)` for the `semaphore`, `mutex` and `condition` block reasons,
which phase 4 already delegates to it.

Wakes from a primitive with `ordered: true` are taken from the **head** of
`waitQueue` only, so bounded waiting is preserved.

### 9. The sync snapshot contribution

This package owns the sync subsystem's contribution to `KernelSnapshot`. The
channel is `subsystems.sync`, added by `docs/07-CONTRACT-AMENDMENTS.md`
amendment 1, and it starts as a `SubsystemEnvelope`:

```ts
{ owner: 'sync', version: 1, payload: /* JsonValue */ }
```

`owner` is this subsystem's `SubsystemId`. `version` starts at 1 and this package
bumps it whenever the payload shape changes. The payload carries the state the
shared `syncPrimitives` table cannot express: the shared cell table, the store
buffers with their pending writes in order, the race detector's access history,
the scenario state for the bounded buffer, readers-writers and philosophers, and
the sorted key array that makes primitive iteration deterministic. It must be
plain `JsonValue`, so no `Map`, no `Set`, no function and no non-finite number,
and the primitive table has to be flattened to a sorted array of pairs on the way
out. Validate the payload on restore and throw on a `version` this package does
not understand, because a silently misread save is worse than a refused one.

**Promote the envelope to a typed interface in the same commit that implements
the subsystem**, additively, the way amendment 1 was made, and record the
promotion in `docs/07-CONTRACT-AMENDMENTS.md`. The envelope is a transition
mechanism. Shipping with an opaque envelope means this package is not finished.

WP-11 carries the envelope through `snapshot()` and hands it back on `restore()`.
It does not interpret the payload, so nothing else will catch a field you leave
out.

## Acceptance criteria

1. `npm run typecheck` exits 0.
2. `npm run test` exits 0.
3. `npm run build` exits 0.
4. `SYNC-PETERSON-1` passes: `reordering: false`, 10,000 ticks, mutual exclusion
   holds at every tick, zero `sync.race_detected`.
5. `SYNC-PETERSON-2` passes: `reordering: true`, `storeBufferDepth` 2, at least
   one mutual exclusion violation and at least one `sync.race_detected` before
   tick 10,000, at the reference seed.
6. `SYNC-PETERSON-3` passes: `mfence` between lines 2 and 3 with reordering on
   gives zero violations.
7. `SYNC-RACE-1` passes: two processes incrementing a shared counter unprotected,
   100 increments each; `sync.race_detected` fires;
   `expectedValue - corruptedValue > 0`; `interleaving` contains the four-line
   load/load/store/store pattern with the exact formatting above.
8. `SYNC-RACE-2` passes: the same workload wrapped in a mutex gives zero
   `sync.race_detected` and a final value of exactly 200.
9. `SYNC-TAS-1` passes: a test-and-set spinlock with 4 contenders holds mutual
   exclusion, produces at least one `process.starving { fatal: false }` from the
   bounded-waiting check, and a total `sync.busy_wait` above 0.
10. `SYNC-BB-1` passes: `n = 4`, 3 producers of 20 and 2 consumers of 30 give
    produced === consumed === 60, occupancy always in `[0, 4]`,
    `empty.value + full.value + inCriticalSection === 4` at every tick, zero
    races.
11. `SYNC-BB-DEADLOCK` produces a two-pid cycle. Since WP-08 owns detection,
    assert the precondition here: exactly one producer is blocked on `empty`
    while holding `mutex`, and every consumer is blocked on `mutex`. Note in the
    test that WP-08 turns this into `deadlock.detected`.
12. `SYNC-RW-STARVE` passes: reader-preferring, 6 readers, 1 writer, exactly one
    `process.starving { fatal: true }` naming the writer.
13. `SYNC-RW-WRITERPREF` passes: the writer completes and a reader is the longest
    waiter.
14. `SYNC-PHIL-NAIVE` reaches the five-way circular wait by tick 200,
    deterministically, at the reference seed, across 20 consecutive runs.
15. `SYNC-PHIL-ASYM`, `SYNC-PHIL-ROOM` and `SYNC-PHIL-MONITOR` each produce zero
    circular waits over 20,000 ticks, and the monitor produces at least one
    philosopher crossing `starvationThreshold`.
16. `SYNC-PHIL-TABLE` values are recorded and pinned. The values appear in your
    report.
17. Invariant I-20 holds at every tick of every scenario: `inCriticalSection`
    never exceeds `capacity`.
18. Mutex hand-off is genuine: a barging third process can never acquire between
    the unlock and the waiter's dispatch. Asserted directly.
19. `git diff --exit-code src/kernel/types.ts src/game/types.ts` exits 0.
20. The forbidden-identifier scan still returns zero matches, and `DET-D1`,
    `DET-D3` and `DET-D4` still pass.
21. Sync state survives a snapshot and restore round trip. Run the bounded buffer
    scenario to a mid-scenario tick with a non-empty store buffer and a non-empty
    `waitQueue`, take the envelope, restore it into a fresh subsystem, step both
    forward, and the two continuation event logs are canonically identical.

## Tests you must write

### `tests/kernel/sync/primitives.test.ts`

| Case | Assertion |
|---|---|
| `mutex acquire` | `mutex_lock` on a free mutex sets `value` 0, `holders` `[pid]`, emits `sync.acquired { kind: 'mutex' }` |
| `mutex block` | a second `mutex_lock` blocks with `{ kind: 'mutex', resource }` and emits `sync.blocked { queueLength: 1 }` |
| `mutex unlock EPERM` | a non-holder unlocking gets `EPERM` |
| `mutex hand-off` | after unlock with a waiter, `value` stays 0 and `holders` is `[waiter]` before the waiter is dispatched |
| `no barging` | a third process calling `mutex_lock` between the unlock and the waiter's dispatch blocks, and the waiter still gets the lock |
| `semaphore sign` | `sem_wait` on a semaphore at value 0 leaves `value` at -1 and the pid in `waitQueue`; three more waiters leave it at -4 |
| `semaphore post wakes head` | with `ordered: true`, `sem_post` wakes the head of `waitQueue` |
| `semaphore post unordered` | with `ordered: false`, the wake target is drawn from `root/sync` and consumes exactly one draw |
| `binary semaphore vs mutex` | any process may `sem_post` a binary semaphore; only the holder may `mutex_unlock` |
| `monitor while not if` | with `signal_and_continue`, a woken process re-tests its predicate; the `SYNC-MONITOR-BROKEN` `if` variant proceeds on a falsified predicate and the test asserts the difference |
| `cond_signal empty` | signalling an empty condition queue is a no-op and returns ok |
| `cond_wait releases` | `cond_wait` releases the monitor lock with hand-off and the waiter re-acquires on wake |
| `signal_and_wait` | under Hoare discipline the signaller joins the entry queue and the signalled process holds the lock |
| `rwlock concurrent readers` | three readers hold simultaneously and `value` is 3 |
| `rwlock writer exclusive` | a writer sets `value` to -1 and no reader may enter |
| `rwlock writer preference` | with a writer waiting, a new reader blocks rather than joining the current readers |
| `rwlock fair` | under `'fair'`, readers and writers are served in ticket order with consecutive readers batched |
| `barrier` | with capacity 4, three arrivals block and the fourth releases all four in one phase, and `value` resets to 0 |
| `progress check` | a primitive left free with a non-empty wait queue for 5 ticks emits `kernel.panic` containing `'progress violated on'` |
| `bounded waiting ordered` | with `ordered: true` and 4 contenders, no waiter observes more than 3 entries |
| `bounded waiting unordered` | with `ordered: false` and 4 contenders over 5000 ticks, at least one `process.starving { fatal: false }` fires |
| `priority inversion detected` | the three-process scenario reports an inversion with the correct blocked, holder and interposed pids |
| `priority inheritance cures` | with `priorityInheritance: true`, the holder's `priority` rises to the blocked process's for the duration and returns to `basePriority` on release, and no inversion is reported |

### `tests/kernel/sync/peterson.test.ts`

| Fixture | Assertion |
|---|---|
| `SYNC-PETERSON-1` | 10,000 ticks with `reordering: false`: `inCriticalSection <= 1` at every tick, zero `sync.race_detected` |
| `SYNC-PETERSON-2` | `reordering: true`, `storeBufferDepth` 2: at least one violation and at least one `sync.race_detected` before tick 10,000 |
| `SYNC-PETERSON-3` | `mfence` between lines 2 and 3: zero violations over 10,000 ticks with reordering on |
| `store buffer drain` | with `storeBufferDepth` 1, drains are strictly FIFO and consume zero `root/sync` draws |
| `store buffer shuffle` | with depth 2, drains consume exactly one `shuffle` worth of draws per drain event |
| `mfence drains fully` | after `mfence` the store buffer is empty |
| `one instruction per line` | the six-line entry section produces exactly six `Instruction` entries |

### `tests/kernel/sync/atomics.test.ts`

| Fixture | Assertion |
|---|---|
| `SYNC-TAS-1` | per acceptance criterion 9 |
| `tas atomic` | test-and-set completes within a single tick and no interleaving is possible inside it |
| `tas mutual exclusion` | with 4 contenders over 5000 ticks, `inCriticalSection` never exceeds 1 |
| `spin counts as busy` | 100 spin ticks raise `cpuUtilisation` and produce zero completed service |
| `spin emits` | each spin iteration emits one `sync.busy_wait` with an incrementing `spunTicks` |
| `cas retry` | a CAS loop under contention eventually succeeds and the final counter is exact |
| `SYNC-CAS-BOUNDED` | the `waiting[]` hand-off version bounds every waiter at `n - 1` entries |
| `cas vs mutex metrics` | the CAS version and the mutex version both give an exact final value, and the test records both `cpuUtilisation` figures |

### `tests/kernel/sync/raceDetector.test.ts`

| Fixture | Assertion |
|---|---|
| `SYNC-RACE-1` | per acceptance criterion 7, and the emitted `RaceCondition` has `participants` of exactly two pids, `location === 'region:counter'`, and `expectedValue - corruptedValue` equal to the number of lost updates |
| `interleaving format` | each line matches `/^t=\d+ P\d+ (LOAD |STORE) \S+ (->|<-) -?\d+ \[holds .+\]$/` and the canonical four-line trace is reproduced verbatim for the fixture seed |
| `SYNC-RACE-2` | the mutex-wrapped version gives zero races and a final value of exactly 200 |
| `eraser empty lockset` | two processes touching a cell under different locks reduce the lockset to empty and a potential race is reported |
| `eraser common lock` | two processes touching a cell under the same lock keep a non-empty lockset and nothing is reported |
| `suppress single pid` | 1000 accesses by one pid with no lock report nothing |
| `suppress read only` | 1000 loads by two pids with no lock report nothing |
| `lost update no false positive` | 10,000 correctly-locked increments produce zero detector-2 reports |
| `history ring capacity` | the history ring holds at most 32 records and the interleaving still starts at the earliest still-pending load |
| `serial shadow` | after 200 unprotected increments, `serialValue` is exactly 200 regardless of how many were lost |

### `tests/kernel/sync/boundedBuffer.test.ts`

| Fixture | Assertion |
|---|---|
| `SYNC-BB-1` | per acceptance criterion 10 |
| `occupancy invariant` | `empty.value + full.value + inCriticalSection === 4` asserted on every one of 10,000 ticks |
| `SYNC-BB-DEADLOCK` | per acceptance criterion 11 |
| `ordering remedy` | restoring the correct order (`empty` before `mutex`) makes the same workload complete with zero blocked-holder states |
| `SYNC-BB-UNBALANCED` | producers at service 1 against consumers at service 5 saturate the buffer, and `cpuUtilisation` is recorded and pinned |

### `tests/kernel/sync/readersWriters.test.ts`

| Fixture | Assertion |
|---|---|
| `SYNC-RW-STARVE` | per acceptance criterion 12 |
| `SYNC-RW-WRITERPREF` | per acceptance criterion 13, and the longest-waiting process is a reader |
| `both starve somebody` | the two runs together produce exactly one fatal starvation each, with different pids, which is Ch. 7.1.2's point |
| `fair starves nobody` | under `'fair'`, zero fatal starvations, and total throughput is strictly lower than under either preference |
| `read_count protocol` | in the reader-preferring semaphore scenario, `rw_mutex` is taken by the first reader and released by the last |

### `tests/kernel/sync/philosophers.test.ts`

| Fixture | Assertion |
|---|---|
| `SYNC-PHIL-NAIVE` | a five-way circular wait exists by tick 200, with each philosopher holding exactly one chopstick and waiting on one held by a neighbour |
| `deterministic deadlock` | 20 consecutive runs at the reference seed all reach it, at the same tick |
| `SYNC-PHIL-ASYM` | zero circular waits over 20,000 ticks; meals completed recorded and pinned |
| `SYNC-PHIL-ROOM` | zero circular waits over 20,000 ticks with `room` capacity 4; at least one philosopher always holds both chopsticks |
| `SYNC-PHIL-MONITOR` | zero circular waits; at least one philosopher crosses `starvationThreshold`; the three monitor procedures behave as written |
| `SYNC-PHIL-TABLE` | the four-row table's recorded values are pinned: meals completed and worst individual wait for each of the four solutions at the reference seed over 20,000 ticks |
| `rng stream` | all think and eat durations draw from `root/sync` and from no other stream |

## Out of scope

- `src/kernel/deadlock/**`, including the wait-for graph, cycle detection,
  Banker's and recovery. WP-08 owns them. This package produces the **states**
  that WP-08 detects; it must not detect anything itself. `deadlock.detected` is
  never emitted from `src/kernel/sync/`.
- `src/kernel/scheduler/**`, `memory/**`, `storage/**`, `io/**`, `fs/**`,
  `security/**`, `syscall/**`, `invariants.ts`.
- Game-layer afflictions and Program names. Expose `inversions()` and stop.
- Any change to `Kernel.ts` beyond wiring `SyncHooks`.
- Anything outside `src/kernel/sync/`, `tests/kernel/sync/` and the one permitted
  edit.

## Report back

State:

1. Pass or fail for each of the twenty-one acceptance criteria, by number.
2. The three verification command outcomes.
3. The recorded `SYNC-PHIL-TABLE` values: meals completed and worst individual
   wait for naive, asymmetric, arbitrator and monitor, stated as now frozen.
4. The recorded `SYNC-BB-UNBALANCED` `cpuUtilisation` figure and the two
   `cas vs mutex` utilisation figures.
5. The exact tick at which `SYNC-PHIL-NAIVE` reaches its circular wait, and
   confirmation that it is identical across 20 runs.
6. How many `root/sync` draws the store-buffer shuffle consumes per drain, so
   WP-11's snapshot test knows what to expect.
7. Every `// TODO(astra):` left in the tree, with file and line.

## Inherited from WP-06: the merge surface

WP-06 landed on main as merge 8c1e91d before this package started. Its shared-file
footprint, new-file ranges at 3e3b1c6:

| File | Every touched range |
|---|---|
| `src/kernel/Kernel.ts` | 12, 17, 116, 211, 249, 255-256, 258, 262-280, 288, 292-293, 334, 342-343, 398-399, 401, 417, 495-526, 534-556, 558-561, 724, 802-803, 805-807, 810-811, 813-815, 865 |
| `src/kernel/config.ts` | 12-27, 41-47, 63, 86-103 |
| `src/kernel/index.ts` | 7-8 |

Twenty-four zero-context hunks in Kernel.ts. The contiguous regions are the VM
integration helpers at 495-526, replacement and ability controls at 534-561, and
the execute changes at 802-815. Line 417 is the step-entry admission veto: it
guards the phase 5 call inside `step()` and is the one place the eleven-phase
orchestrator changed. None of the eleven phase bodies changed. Rebase onto
8c1e91d before you touch Kernel.ts or config.ts, and keep your own additions to
distinct config keys and to your named regions.

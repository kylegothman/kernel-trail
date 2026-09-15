# WP-11: The syscall interface, snapshot and restore, and the invariant set

## Objective

When this package is done every one of the 26 `SyscallName` values has a real
handler with its documented preconditions, effects, return value and errno set;
argument validation runs at the gate before any handler; the seven errno
substitutions are implemented with their exact message prefixes; `snapshot()` and
`restore()` round-trip the complete kernel state, including a populated
`subsystems.process` and a `restore` that refuses an incomplete snapshot; and all
forty invariants run in phase 11 of every dev and test build. This is the
integration package: it is the
first point at which the whole simulator is exercised together, and fixtures
`DET-D2`, `INV-ALL-1` and `INV-ALL-2` become meaningful.

## Prerequisites

WP-02 through WP-10 all complete and green. This package runs alone in its own
wave because it touches every subsystem's snapshot contribution and every
subsystem's invariants, so nothing else may be changing kernel state while it
lands.

Files that must already exist: every subsystem directory under `src/kernel/`,
each exposing the operations its package reported.

## Required reading

- `02-KERNEL-SIM-SPEC.md` section 14 in full: 14.1 (dispatch), 14.2 (argument
  validation and the substituted errnos), 14.3 (the reference table, all 26
  entries), 14.4 (the errno cross-reference)
- `02-KERNEL-SIM-SPEC.md` section 15 in full: all forty invariants, in their
  numbered order, with the code printed for I-1, I-2, I-5, I-6, I-12, I-17, I-21
  and I-24
- `02-KERNEL-SIM-SPEC.md` section 1.2.6 (RNG save and restore) and 1.4 (the
  determinism test, especially D2 and what it catches)
- `02-KERNEL-SIM-SPEC.md` section 13.1 rules 2 and 3, since dispatch is the gate
- `02-KERNEL-SIM-SPEC.md` section 16.2 (`DET-D2`) and 16.13 (the invariant
  fixtures, positive and negative)
- `01-ARCHITECTURE.md` section 8.3 (`SaveFile`) and 8.4 (checksum), so
  `KernelSnapshot` is structurally cloneable and canonicalisable
- `docs/07-CONTRACT-AMENDMENTS.md` amendment 1 in full, then the
  "amendment 1: the subsystem state channel" block in `src/kernel/types.ts`.
  This package owns the process contribution and the `restore` completeness
  check, so read the decision before reading §5 below
- `02-KERNEL-SIM-SPEC.md` section 1.5 (the subsystem state channel)

## Files you will create

```
src/kernel/syscall/table.ts
src/kernel/syscall/dispatch.ts
src/kernel/syscall/validate.ts
src/kernel/syscall/errno.ts
src/kernel/syscall/handlers/process.ts
src/kernel/syscall/handlers/memory.ts
src/kernel/syscall/handlers/filesystem.ts
src/kernel/syscall/handlers/sync.ts
src/kernel/syscall/handlers/resources.ts
src/kernel/syscall/handlers/device.ts
src/kernel/snapshot.ts
src/kernel/invariants.ts
tests/kernel/syscall/dispatch.test.ts
tests/kernel/syscall/validation.test.ts
tests/kernel/syscall/handlers.test.ts
tests/kernel/snapshot.test.ts
tests/kernel/invariants.test.ts
tests/kernel/invariants.negative.test.ts
tests/kernel/sweep.test.ts
```

## Files you may modify

```
src/kernel/Kernel.ts               (implement syscall, snapshot, restore; replace the
                                    phase 11 stub with the real invariant set)
src/kernel/index.ts                (final barrel: add KernelInvariantError if absent)
tests/kernel/determinism.test.ts   (un-skip D2 only)
```

You may additionally add, to each subsystem, a **single** exported function
`snapshotContribution()` and `restoreContribution(data)` where the owning package
did not already provide one. Touch nothing else in those files, and list every
such addition in your report.

## Frozen contracts

From `src/kernel/types.ts`. These may not be edited. If this package cannot be
completed without changing one, stop and report per the escalation procedure.

```ts
export type SyscallName =
  | 'fork' | 'exec' | 'exit' | 'wait' | 'kill' | 'getpid' | 'nice'
  | 'mmap' | 'munmap' | 'brk'
  | 'open' | 'close' | 'read' | 'write' | 'seek' | 'stat' | 'unlink' | 'mkdir'
  | 'sem_wait' | 'sem_post' | 'mutex_lock' | 'mutex_unlock'
  | 'request' | 'release'
  | 'ioctl' | 'sync' | 'chmod';

export interface SyscallRequest {
  readonly name: SyscallName;
  readonly pid: Pid;
  readonly args: readonly (string | number | boolean)[];
}

export type SyscallResult =
  | { readonly ok: true; readonly value: string | number | boolean | null }
  | { readonly ok: false; readonly errno: Errno; readonly message: string };

export type Errno =
  | 'EPERM' | 'ENOENT' | 'EAGAIN' | 'ENOMEM' | 'EACCES' | 'EBUSY'
  | 'EEXIST' | 'EINVAL' | 'ENOSPC' | 'EDEADLK' | 'ESRCH';

/** Serialisable, structurally cloneable, and sufficient to resume a run exactly. */
export interface KernelSnapshot {
  readonly version: 1;
  readonly tick: Tick;
  readonly seq: number;
  readonly config: KernelConfig;
  readonly rng: readonly RngState[];
  readonly processes: readonly ProcessControlBlock[];
  readonly frames: readonly Frame[];
  readonly pageTables: readonly (readonly [AddressSpaceId, readonly PageTableEntry[]])[];
  readonly syncPrimitives: readonly SyncPrimitive[];
  readonly resources: readonly ResourceType[];
  readonly diskQueue: readonly DiskRequest[];
  readonly diskHead: DiskHead;
  readonly devices: readonly Device[];
  readonly inodes: readonly Inode[];
  readonly journal: readonly JournalEntry[];
  readonly domains: readonly ProtectionDomain[];
  readonly metrics: { readonly scheduling: SchedulingMetrics; readonly memory: MemoryMetrics };

  /* amendment 1: the subsystem state channel */
  readonly completeness?: SnapshotCompleteness;   // 'init_only' | 'full', absent means 'init_only'
  readonly subsystems?: SubsystemSnapshots;
}

export interface SubsystemSnapshots {
  readonly process?: ProcessSnapshotState;        // fully typed, this package implements it
  readonly memory?: SubsystemEnvelope;            // WP-05
  readonly sync?: SubsystemEnvelope;              // WP-07
  readonly storage?: SubsystemEnvelope;           // WP-09
  readonly fs?: SubsystemEnvelope;                // WP-10
  readonly security?: SubsystemEnvelope;          // WP-10
}
```

Read the amendment 1 block in `src/kernel/types.ts` for the full shape of
`ProcessSnapshotState`, `ProgramSnapshot`, `ThreadSnapshot`, `IdCounters`,
`IpcSnapshot`, `SubsystemEnvelope` and `JsonValue`. Use those names exactly.

The `Kernel` methods this package completes:

```ts
  syscall(request: SyscallRequest): SyscallResult;
  snapshot(): KernelSnapshot;
  restore(snapshot: KernelSnapshot): void;
```

Note that `SyscallName` has 27 members listed above. The sim spec's reference
table has 27 entries and calls the set "26 calls" in prose. **Implement every
member of the union.** Count from the union, never from the prose.

Earlier revisions of this package said `KernelSnapshot` had no slot for the side
tables the subsystem packages were told to keep (parent links, COW ref counts,
raw burst figures, working-set rings, store buffers, capability seals, rollback
checkpoints, the live device-mode table, `switchesToDomain`), and told you to
encode them into existing fields. That was a real gap in the frozen contract,
WP-02 escalated it, and it is now closed: `completeness` and `subsystems` are the
channel. Put side-table state in its owning subsystem slot. Do not encode it into
an unrelated field, and do not add a field.

**This package owns three things because of that amendment**, all described in
§5 below:

1. `ProcessSnapshotState`, implemented completely, every field, from the side
   tables WP-02 built.
2. The `restore` completeness check, which throws rather than silently dropping
   state.
3. Resolving WP-02's init-only guard, which throws today and carries
   `// TODO(astra): blocked on contract change, see report`. That TODO is this
   package's to remove.

See `docs/07-CONTRACT-AMENDMENTS.md` amendment 1 for the decision and its
reasoning.

## Inherited from WP-05

WP-05 promoted two snapshot slots and settled several things this package has to
reconcile. Everything below comes from its completion report, from amendment 4, or
from the source it left behind.

### Ten slots now exist, with a compile-time check

`SubsystemSnapshots` has one slot per `SubsystemId`, all ten. Amendment 3 added
`scheduler`, `vm`, `deadlock` and `io` to amendment 1's six, and added:

```ts
type _EverySubsystemHasASlot = SubsystemId extends keyof SubsystemSnapshots ? true : never;
const _subsystemSlotCheck: _EverySubsystemHasASlot = true;
```

so a missing slot is now a type error. The quoted `SubsystemSnapshots` in the frozen
contracts section above predates that and lists six slots; read `types.ts` for the
current shape. Amendment 4 then promoted `memory` and `vm` from envelopes to
`MemorySnapshotState` and `VmSnapshotState`, so the completeness check validates
ten slots of which two are typed, and this package reconstructs both typed
contributions through the installed snapshot hooks rather than by reading their
payloads.

### Two invariant exceptions the memory group must allow

The statement connecting every owned frame to a valid PTE needs two exceptions, both
intentional and both tested in WP-05:

1. **Retained free-pool contents.** A frame freed with retention keeps its old
   `owner` and `page` while it sits in the free pool, which is what makes
   reclaim-from-pool a minor fault. Such a frame has a non-null `owner` and is named
   by no valid PTE.
2. **COW and shared aliases.** A frame shared by copy-on-write or by a shared region
   is named by more than one valid PTE, and an alias whose frame carries a different
   owner or page is still a valid PTE access. I-18 already carves out
   `cowRefCount > 1`; shared-region aliases and the retained pool need the same
   treatment, and the free-pool case is the one I-18 does not currently mention.

WP-05 did not widen scope into `invariants.ts`, so writing these exceptions is this
package's job. Preserve the behaviour; do not tighten the invariant until the
behaviour changes.

### The stale guard message

WP-02's guard throws:

```
not implemented: ${name} for process workloads or custom subsystem state; WP-11 needs a KernelSnapshot channel for programs, threads and side tables
```

That text now misnames the problem. The channel exists: amendment 1 added
`completeness` and `subsystems`, amendment 3 filled the slots, and WP-05 turned save
and restore into a dispatch over installed hooks. What is missing is the process
implementation, not the channel. Correct the message when you remove the guard, so
the repository does not keep asserting a gap that was closed two amendments ago.
Removing the guard and its
`// TODO(astra): blocked on contract change, see report` marker is already this
package's work.

### The ioctl branch and its marker

`ioctl` currently has exactly one subcommand, `tlb_flush`, and returns `EINVAL` on
anything else. The branch carries:

```ts
// TODO(astra): WP-11 validates ioctl arguments
```

That marker is yours to resolve. Two things to carry forward when you build the full
table. First, sim spec 14.3 declares `ioctl(device, command, ...)` with `args[0]`
the `DeviceId` and `args[1]` the command, while the existing branch reads `args[0]`
as the command, because the kernel pseudo-device has no id. You own the table and
the arity check, so you settle that shape. Second, WP-09 adds its drivers'
subcommands to the same branch under the same marker, so expect more than one
subcommand there by the time you arrive, and expect the `EINVAL` default to be the
only fallthrough.

### The rations flooring ambiguity is already settled

Sim spec 6.6's prose directs flooring after the multiplications while one displayed
expression floors the equal share earlier. WP-05 followed the explicit final-floor
instruction, and every published 64-frame, eight-process fixture value matches:
generous 12, standard 8, lean 4, starved 3. At 64 frames and 40 processes every
setting returns at least three. Write the invariant set so it does not contradict
that choice: an invariant that assumes the earlier floor will fire against correct
code.

### Snapshot registration, as WP-05 left it

```ts
interface SnapshotHooks {
  saveState(): Partial<SubsystemSnapshots>;
  restoreState(snapshot: KernelSnapshot): () => void;
}
```

`restoreState` validates and captures detached state, then returns a commit closure.
The kernel prepares every installed contribution before mutating state and calls the
commits afterwards, so one invalid contribution changes nothing. Duplicate slot
ownership is rejected. Snapshot-only registration through
`installHooks({ snapshots })` does not trip the init-only guard, which is how the
subsystem packages test their round trips while the guard still stands. Keep both
properties when you replace the guard with the completeness check.

## Specification

### 1. `src/kernel/syscall/dispatch.ts`

Implement `dispatch` exactly as printed in sim spec 14.1:

```ts
function dispatch(req: SyscallRequest, k: KernelState): SyscallResult {
  const pcb = k.pcb(req.pid);
  if (pcb === undefined) return err('ESRCH', `no such process ${req.pid}`);
  if (pcb.state !== 'running')  return err('EPERM', 'syscall from a non-running process');

  k.rings.enter(0, pcb);
  try {
    const validation = validateArgs(req, k);
    const result = validation.ok ? SYSCALL_TABLE[req.name](req, k) : validation;
    k.emit({ type: 'syscall.invoked', request: req, result });
    return result;
  } finally {
    k.rings.leave(pcb);
  }
}
```

Four points that decide correctness:

- **`syscall.invoked` is emitted for every call including failures**, which makes
  the event log a complete strace and is what WP-15's `trace` command renders.
- The `finally` block is required: a handler that throws must still restore the
  caller's ring, or the process is stuck in ring 0.
- `k.rings.enter(0, pcb)` is the trap gate of sim spec 13.1 rule 2. Entry lands
  at a fixed handler from `SYSCALL_TABLE` and never at a caller-supplied address.
- `Kernel.syscall(request)` is the public entry point. It **executes the call
  immediately and synchronously, outside the tick loop**, which is how the
  terminal and the game layer drive the kernel. A call that blocks the caller
  sets the PCB state and the block takes effect on the next `step()`.

`SYSCALL_TABLE` is `Readonly<Record<SyscallName, SyscallHandler>>`. Because the
key type is the frozen union, a missing handler is a compile error, which is the
behaviour you want.

### 2. `src/kernel/syscall/validate.ts`

Validation runs before any handler and covers four things **in this order**, sim
spec 14.2:

1. **Arity.** Wrong argument count returns `EINVAL`.
2. **Types.** Each handler declares the expected type per position; a mismatch
   returns `EINVAL`.
3. **Ranges.** Integer arguments must be finite integers within the declared
   bound. A file descriptor must be in `pcb.openFiles`. A `Pid` must exist. An
   address must lie within the caller's address space. A negative size returns
   `EINVAL`.
4. **Rights.** The caller's domain must hold the required right on the named
   object, checked with `checkAccess`, **with the caller's domain and never the
   kernel's**.

Step 4 with the wrong domain is the confused-deputy bug that WP-10's
`SEC-DEPUTY-1` exists to catch, so pass the requester's domain explicitly and
never read it off the current ring.

Declare the per-call specification as data, not as code branches:

```ts
interface ArgSpec {
  readonly kind: 'string' | 'number' | 'boolean';
  readonly optional?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly role?: 'fd' | 'pid' | 'address' | 'size' | 'path' | 'resource' | 'device';
}
interface CallSpec {
  readonly args: readonly ArgSpec[];
  readonly requiredRight: AccessRight | null;
}
const CALL_SPECS: Readonly<Record<SyscallName, CallSpec>>;
```

A table cannot drift the way 27 hand-written validators can, and WP-15's `man`
pages read the same table to print each call's usage line.

### 3. `src/kernel/syscall/errno.ts`

`Errno` is frozen and lacks seven codes Unix would use. The substitutions are
fixed and **the message text carries the real meaning**. Implement all seven,
with these exact prefixes:

| Unix errno | Sim returns | Message prefix |
|---|---|---|
| `ECHILD` | `ESRCH` | `"no children: "` |
| `ENOTDIR` | `EINVAL` | `"not a directory: "` |
| `EBADF` | `EINVAL` | `"bad file descriptor: "` |
| `EMFILE` | `EAGAIN` | `"too many open files: "` |
| `EFAULT` | `EINVAL` | `"address out of range: "` |
| `EISDIR` | `EINVAL` | `"is a directory: "` |
| `ENOTEMPTY` | `EBUSY` | `"directory not empty: "` |

Provide one constructor per substitution, for example
`badFd(fd: number): SyscallResult`, so no handler ever writes the prefix by
hand. Fixture `SEC-ARG-1` asserts the `"address out of range: "` prefix
literally, and WP-15's `man EPERM` pages read this table.

WP-02 already returns `ESRCH` with `"no children"` from `wait`. **Change that
message to `"no children: "` plus the caller's pid** so it matches the table, and
report the change.

### 4. The 27 handlers

Implement every entry in sim spec 14.3 exactly: parameters, preconditions,
effects, return value, and every errno it can produce. Argument positions are
zero-based and refer to `SyscallRequest.args`. The six groups and their calls:

| Group | Calls |
|---|---|
| Process control | `fork`, `exec`, `exit`, `wait`, `kill`, `getpid`, `nice` |
| Memory | `mmap`, `munmap`, `brk` |
| File system | `open`, `close`, `read`, `write`, `seek`, `stat`, `unlink`, `mkdir`, `chmod`, `sync` |
| Synchronisation | `sem_wait`, `sem_post`, `mutex_lock`, `mutex_unlock` |
| Resources | `request`, `release` |
| Device | `ioctl` |

**Handlers do not reimplement subsystem logic.** `fork` calls WP-02's
`lifecycle.fork`. `mmap` calls WP-02's `ipc` and WP-05's frame table.
`sem_wait` calls WP-07's semaphore. `request` calls WP-08's resource path, which
already branches on `deadlockStrategy`. `ioctl` dispatches to the driver
`control` methods WP-09 reported plus the `crash` and `domain_switch` commands
WP-10 reported. A handler is a validated adapter, nothing more. If a handler
needs logic that does not exist in a subsystem, that logic belongs in the
subsystem and its absence is a bug to report, not to work around here.

`ioctl` is the escape hatch and is the only place a new device behaviour can
enter without changing `SyscallName`. Build its command dispatch from a registry
the drivers populate, so adding a driver adds commands with no edit here.

Use sim spec 14.4, the errno cross-reference, as a checklist: for each of the
eleven `Errno` values, confirm that exactly the listed calls can produce it, and
write one test per row.

Note that `EINVAL` is produced by **every call except `getpid`**, so `getpid`
having no failure path is itself an assertion.

### 5. `src/kernel/snapshot.ts`

`snapshot()` builds a `KernelSnapshot` that is serialisable, structurally
cloneable, and sufficient to resume a run exactly.

Rules:

- **Every array is emitted in a deterministic order**: processes ascending by
  pid, frames ascending by id, page tables ascending by `AddressSpaceId` with
  entries ascending by `PageId`, sync primitives and resources ascending by
  lexicographic id, inodes ascending by id, domains ascending by id, journal in
  entry order, disk queue in arrival order, devices ascending by id.
- **`rng` holds all twelve states in the fixed registry order** from sim spec
  1.2.5: root first, then `process`, `scheduler`, `memory`, `vm`, `sync`,
  `deadlock`, `storage`, `io`, `fs`, `security`, `events`. Restoring in a
  different order silently changes the run.
- **`seq` is carried and is never reset by `restore`.**
- **Deep-copy on the way out.** A snapshot that aliases a live PCB is a snapshot
  that changes after you take it, which breaks `SaveFile` and breaks D2.
- **No `Map`, no `Set`, no function, no `Infinity`, no `NaN`, no `-0`** anywhere
  in the output. `canonical()` rejects all of them and the checksum in the game
  layer depends on that. Pid 0's `serviceRemaining` is `Infinity`, so pid 0 must
  be excluded from `processes`, as WP-02 already excludes it from
  `Kernel.processes`.
- **Metrics are recomputed at snapshot time, never carried from a stale field.**
- **`completeness` is set from what the kernel actually holds.** Emit `'full'`
  whenever any user process has existed or any program is registered, and
  populate `subsystems` to match. Emit `'init_only'` only for a kernel with no
  workload state at all.

#### 5.1 `ProcessSnapshotState`, in full

Build `subsystems.process` from WP-02's side tables. Every field of
`ProcessSnapshotState` is populated: `version`, `programs`, `threads`, `rawWork`,
`lwpBindings`, `counters`, `pendingChildReturns`, `cowRefCounts`, `ipc`, `tuning`
and `executionDebt`. Each `ProgramSnapshot` carries its `pid`, `name`,
`instructions`, `programCounter`, `repeating`, `referenceString` and
`serialFraction`. Each `ThreadSnapshot` carries its `tid`, `pid`,
`programCounter`, `state` and `blockedOn`. `counters` is an `IdCounters` with
`nextPid`, `nextTid` and `nextAddressSpace`, so a restored kernel never reissues
a live id. `ipc` is an `IpcSnapshot` holding shared regions with their frames,
attached address spaces and value, and mailboxes with their capacity, messages in
order and waiters.

**A shallow PCB snapshot is insufficient and will not pass review.** A snapshot
that records process control blocks and stops cannot resume a workload: the
programs have no instruction stream, the threads have no program counters, the
allocators restart and reissue live ids, and the raw pre-acceleration figures are
gone, so the Amdahl recomputation of sim spec 4.3 produces different bursts after
a restore than before it. If a field of `ProcessSnapshotState` has no obvious
source in WP-02's tables, that is a question for the report, not a field to leave
empty.

Apply the same snapshot rules to this slot as to the shared tables: deterministic
array order (programs and `rawWork` ascending by pid, threads and `lwpBindings`
ascending by tid, `cowRefCounts` ascending by frame id, shared regions and
mailboxes ascending by lexicographic id, messages and waiters in queue order),
deep copy on the way out, and no `Map`, `Set`, function or non-finite number
anywhere. `JsonValue` is structurally cloneable JSON and nothing else, so
`instructions` and `tuning` must be plain data.

#### 5.2 The five envelopes

`memory`, `sync`, `storage`, `fs` and `security` each arrive as a
`SubsystemEnvelope`: an `owner`, a `version`, and a `payload` of `JsonValue`.
This package carries them through `snapshot()` and hands each one back to its
owning subsystem on `restore()`. The owner validates its own payload and throws
on a version it does not understand. You do not interpret another subsystem's
payload here, and you do not repair one; an envelope that fails its owner's
validation is a failed restore.

Those five subsystems will each promote their envelope to a typed interface. When
one lands, this package's snapshot code changes only where it names the slot.

#### 5.3 The completeness check

`restore` is the enforcement point, because the fields are optional and the type
system therefore cannot prove a snapshot is complete.

```
if the snapshot's completeness is weaker than the state being restored into,
throw
```

An absent `completeness` counts as `'init_only'`. Restoring an init-only snapshot
into a kernel that has run a workload **throws**. It does not reset the kernel,
it does not restore the shared tables and leave the side tables stale, and it
does not log a warning and continue. A silently misread save is worse than a
refused one, and this check is the only thing standing between the game's save
model and a save that loads into a subtly wrong kernel.

The same rule applies one level down: a snapshot claiming `'full'` whose
`subsystems.process` is absent, or whose envelope set omits a subsystem in
`enabledSubsystems` that holds state, is inconsistent and throws.

This check is also what resolves WP-02's init-only guard. WP-02 throws on any
restore into a non-empty kernel and marks it
`// TODO(astra): blocked on contract change, see report`. Replace that guard with
the real check and delete the marker.

#### 5.4 `restore`

`restore(snapshot)` replaces state in place:

- Validate `version === 1`; anything else throws `KernelConfigError`.
- Run the completeness check of §5.3 before touching any state, so a refused
  restore leaves the kernel exactly as it was.
- Call `Rng.restore` on the **existing** stream objects, never construct new
  ones, because subsystems hold references.
- Hand each populated `subsystems` slot to its owner: `process` to WP-02's
  tables, each envelope to the subsystem named by `owner`.
- Rebuild every derived structure: the scheduler's queues from the process
  states, the free list from the frame table, the wait-for graph on demand, the
  dentry cache empty, the TLB empty or restored, whichever the subsystem's owner
  specified.
- Restore `seq` and `tick` before any subsystem restore, so an emit during
  restore stamps correctly. Better still, emit nothing during restore.

`snapshot()` must be a pure function of state: calling it twice with no
intervening `step()` produces canonically identical output. That is invariant
I-40 and it is checked in tests rather than in phase 11 because it is quadratic.

### 6. `src/kernel/invariants.ts`

All forty invariants from sim spec 15, checked in phase 11, **in the numbered
order given**, in development and test builds only.

```ts
export function checkInvariants(k: KernelState): void {
  if (!k.devBuild) return;
  I1_pidUniqueness(k);
  I2_oneRunning(k);
  // ... in numbered order
}

function assert(cond: boolean, n: number, msg: () => string): void {
  if (!cond) throw new KernelInvariantError(n, msg());
}
```

The message is built by a **thunk**, so the string is not constructed on the
happy path. Ten thousand ticks times forty invariants times a template literal is
a measurable cost otherwise.

The forty, grouped:

- **Process and scheduling, I-1 to I-16.** Pid uniqueness and ascending order;
  at most one running process and agreement with `k.running`; `cpuUtilisation` a
  probability and `busyTicks <= tick`; service accounting conserved; resource
  conservation and non-negative availability; no process blocked on a resource
  only it holds; every live process has a thread; a page fault does not advance
  the program counter; TLB coherence; wait-queue membership consistent with
  state in both directions; only legal transitions occurred; `readySince` pairs
  with state `ready` and is never in the future; the ready queue equals the set
  of ready processes with no duplicates across levels; a process admitted this
  tick has `waited === 0`; priorities in range; `worstWait` bounded under the
  three starvation-free policies.
- **Memory, I-17 to I-20.** Frame conservation with no duplicate and no owned
  frame in the free list; page table and frame table agree, with the
  `cowRefCount` exception; every metric finite and every rate non-negative, with
  `tlbHitRate` and `cpuUtilisation` in `[0, 1]`; the free list strictly
  ascending.
- **Synchronisation and deadlock, I-21 to I-26.** Mutual exclusion per primitive
  kind with the four cases printed in the spec; bounded buffer occupancy;
  `holders` and `waitQueue` disjoint; acyclic wait-for graph under `'prevent'`;
  the state always safe under `'avoid'`, checked only on ticks that emitted
  `resource.granted`; a reported cycle is a real cycle beginning at its lowest
  pid.
- **Storage, I/O and file system, I-27 to I-33.** Disk head in range;
  `servedAtTick` consistency; block allocation exclusive; link counts correct;
  journal phase ordering within a `txId`; device queue membership; interrupt
  lines within `[0, maxPending]`.
- **Security, I-34 to I-37.** Ring stack non-increasing; no user-domain process
  in ring 0 outside a trap; ACL and capability representations agree when both
  are materialised; `kernelSecret` never in the event log, checked once at the
  end of a test run.
- **Determinism, I-38 to I-40.** `seq` strictly increasing across the whole run
  including across `restore` and `tick` non-decreasing; every RNG stream present
  in the snapshot in the fixed order with `algorithm === 'sfc32'`;
  `snapshot()` pure.

**Two run at a slower cadence.** I-29 (block allocation exclusive) is
deliberately expensive and runs every `invariantSlowInterval` ticks, default 50.
I-30 (link counts) walks the whole tree and runs on the same cadence. I-25
(`'avoid'` safety) runs only on ticks that emitted `resource.granted` and only
when `deadlock` is in `enabledSubsystems`. I-37 and I-40 run in tests, not in
phase 11.

**In production builds phase 11 compiles out.** Gate it on the tuning flag and
structure it so a bundler can drop the module.

## Acceptance criteria

1. `npm run typecheck` exits 0.
2. `npm run test` exits 0.
3. `npm run build` exits 0.
4. `SYSCALL_TABLE` has one handler per member of the frozen `SyscallName` union,
   verified by a test that iterates the union and asserts each key is a function.
   No handler throws `not implemented`.
5. Every entry in sim spec 14.3 is implemented with its documented return value.
   One test per call asserts the success path.
6. Every row of sim spec 14.4's errno cross-reference passes: for each of the
   eleven `Errno` values, exactly the listed calls can produce it and no others.
7. All seven errno substitutions produce the exact message prefix in the table.
8. `getpid` has no failure path: 1000 randomised malformed argument lists all
   still return `{ ok: true }` after arity validation, or `EINVAL` from arity
   alone and never from any other check.
9. `syscall.invoked` is emitted for every call, success and failure, with the
   request and result attached. Verified over a 5000-tick run by comparing the
   event count against a counter incremented in `dispatch`.
10. A handler that throws still restores the caller's ring. Verified by injecting
    a throwing handler in a test.
11. Fixture `DET-D2` passes and is un-skipped: snapshot at 2000, restore, run
    3000, and both the tail event log and the final snapshot are canonically
    identical to an uninterrupted run.
12. `snapshot()` twice with no intervening `step()` gives canonically identical
    output, for 20 different points in a 5000-tick run. This is I-40.
13. `canonical(kernel.snapshot())` never throws across a 10,000-tick run of
    `REFERENCE_CONFIG`, proving no `Map`, `Set`, function or non-finite number
    reached the output.
14. `structuredClone(kernel.snapshot())` succeeds.
15. Fixture `INV-ALL-1` passes: `REFERENCE_CONFIG`, 10,000 ticks, dev build, zero
    invariant violations.
16. Fixture `INV-ALL-2` passes: each of the 7 schedulers times each of the 6
    replacement policies times each of the 6 disk policies, 2,000 ticks each,
    zero violations across all **252** combinations.
17. Fixture `INV-NEG-1` passes: a deliberately broken free list with a duplicate
    frame throws with `invariant === 17`.
18. Fixture `INV-NEG-2` passes: two processes forced into state `running` throws
    with `invariant === 2`.
19. Fixture `INV-NEG-3` passes: a mutex with two holders throws with
    `invariant === 21`.
20. Fixture `INV-NEG-4` passes: a resource whose available plus held exceeds its
    total throws with `invariant === 5`.
21. Every one of the forty invariants has at least one negative test that makes
    it fire. An invariant that cannot be made to fail is not being checked.
22. Phase 11 costs under 8 percent of total step time at 10,000 ticks with the
    reference config, measured in the test file and asserted against that
    threshold.
23. With `checkInvariants: false`, a 10,000-tick run produces byte-identical
    output to one with it enabled, proving the checks are side-effect free.
24. `git diff --exit-code src/kernel/types.ts src/game/types.ts` exits 0.
25. The forbidden-identifier scan still returns zero matches, and `DET-D1`,
    `DET-D3` and `DET-D4` still pass.
26. Every field of `ProcessSnapshotState` is populated. A test enumerates the
    interface's keys against a snapshot taken from a running workload and asserts
    none is `undefined` and no array field is empty where the corresponding live
    table is non-empty. `programs` and `threads` have one entry per live program
    and per live thread respectively, counted from the kernel rather than from a
    hand-written expected count.
27. **Workload round trip.** Build a kernel with at least 4 user processes, at
    least 3 of which have 2 or more threads, at least one shared memory region
    with two attachers, at least one mailbox holding messages, and at least one
    uncollected child exit code. Run 1,500 ticks. Snapshot. Construct a fresh
    kernel from the same `KernelConfig`, `restore` the snapshot into it, and run
    both kernels forward 1,500 more ticks. The two continuation event logs are
    byte-identical under `canonical`, and the two final snapshots are
    byte-identical under `canonical`. This is the criterion that a shallow PCB
    snapshot cannot pass.
28. **A truncated snapshot is rejected.** Four cases, each asserting a throw and
    asserting that the target kernel's snapshot is canonically unchanged
    afterwards: an otherwise valid snapshot with `completeness` deleted restored
    into a kernel that has run a workload; the same with `completeness` set to
    `'init_only'`; a snapshot with `completeness: 'full'` and `subsystems`
    deleted; a snapshot with `completeness: 'full'` and `subsystems.process`
    deleted. Silent acceptance fails this criterion, and so does acceptance with
    a warning.
29. `subsystems.process` survives `structuredClone` and `canonical` unchanged,
    and `restore` of a `structuredClone`d snapshot behaves identically to
    `restore` of the original.
30. WP-02's init-only restore guard is gone, along with its
    `// TODO(astra): blocked on contract change, see report` marker, replaced by
    the completeness check of §5.3. Verified by a grep for that marker returning
    zero matches under `src/kernel/`.

## Tests you must write

### `tests/kernel/syscall/dispatch.test.ts`

| Case | Assertion |
|---|---|
| `table complete` | every member of `SyscallName` maps to a function; the test enumerates the union rather than a hand-written list |
| `unknown pid` | a request naming a nonexistent pid returns `ESRCH` before validation runs |
| `non-running caller` | a request from a `ready` process returns `EPERM` |
| `ring entered` | during a handler, the ring is 0; after it returns, the caller's ring is restored |
| `ring restored on throw` | an injected throwing handler still leaves the caller at its original ring |
| `strace completeness` | over 5000 ticks the `syscall.invoked` count equals the dispatch count |
| `failures emitted` | a failing call still emits `syscall.invoked` carrying the error result |
| `synchronous` | `Kernel.syscall` executes outside the tick loop and does not advance `kernel.tick` |
| `blocking takes effect next step` | a blocking `sem_wait` sets the PCB state immediately and the process is not dispatched on the next `step()` |

### `tests/kernel/syscall/validation.test.ts`

| Case | Assertion |
|---|---|
| `arity` | each call with one argument too few and one too many returns `EINVAL` |
| `types` | passing a string where a number is declared returns `EINVAL` for every numeric position across all calls |
| `order` | a call that is both wrong-arity and rights-denied returns the arity error, proving the order |
| `fd range` | a descriptor not in `pcb.openFiles` returns `EINVAL` with the `"bad file descriptor: "` prefix |
| `pid range` | a nonexistent pid returns `ESRCH` |
| `address range` | an address outside the caller's address space returns `EINVAL` with the `"address out of range: "` prefix |
| `negative size` | a negative size returns `EINVAL` |
| `rights use caller domain` | validation calls `checkAccess` with the caller's domain, asserted by spying on the argument |
| `substitution table` | all seven substitutions return the mapped `Errno` and the exact prefix |
| `no state change on failure` | a failed validation leaves a canonically identical snapshot |
| `spec table drives usage` | `CALL_SPECS` produces a usage string for every call, which WP-15 will consume |

### `tests/kernel/syscall/handlers.test.ts`

One `describe` block per group, one success-path case and one case per producible
errno for each of the 27 calls. Use sim spec 14.3 as the checklist and sim spec
14.4 as the cross-check.

| Case | Assertion |
|---|---|
| `errno cross-reference` | for each of the eleven `Errno` values, the set of calls that produced it during an exhaustive sweep equals the set listed in sim spec 14.4 |
| `getpid infallible` | per acceptance criterion 8 |
| `handlers delegate` | `fork` calls `lifecycle.fork` and does not duplicate its logic, asserted by spying |
| `ioctl registry` | every `ioctl` command reported by WP-09's drivers and WP-10 dispatches; an unknown command returns `EINVAL` |
| `ioctl set_ring absent` | `ioctl('set_ring', 0)` returns `EINVAL`, which is what makes WP-10's `SEC-RING-1` pass |
| `request honours strategy` | `request` under each of the four `deadlockStrategy` values produces the behaviour WP-08 specified |
| `wait message` | `wait` with no children returns `ESRCH` with the `"no children: "` prefix |

### `tests/kernel/snapshot.test.ts`

| Case | Assertion |
|---|---|
| `DET-D2` | per acceptance criterion 11 |
| `purity` | per acceptance criterion 12 |
| `canonical safe` | per acceptance criterion 13 |
| `structuredClone` | per acceptance criterion 14 |
| `rng order` | `snapshot().rng` has 12 entries in the fixed registry order, each with `algorithm === 'sfc32'` |
| `restore in place` | after `restore`, every subsystem's `Rng` is the same object identity it held before |
| `seq carried` | `seq` after restore continues from the snapshot value and never resets |
| `deep copy` | mutating a PCB after `snapshot()` does not change the snapshot |
| `array orders` | every array in the snapshot is in the documented order, asserted per field |
| `pid 0 excluded` | `snapshot().processes` contains no pid 0 |
| `version guard` | restoring a snapshot with `version` other than 1 throws `KernelConfigError` |
| `side tables survive` | for each side table, a value set before the snapshot is present after the restore, read back from its subsystem slot; one case per table |
| `no emit during restore` | `restore` produces zero events |
| `process state complete` | per acceptance criterion 26 |
| `workload round trip` | per acceptance criterion 27 |
| `truncated rejected` | per acceptance criterion 28, four cases |
| `clone stable` | per acceptance criterion 29 |
| `init-only guard resolved` | per acceptance criterion 30 |
| `envelope version refused` | an envelope whose `version` its owner does not understand makes `restore` throw, and the target kernel is canonically unchanged |
| `id counters` | after a restore, the next `fork` and the next `thread_create` issue ids above every id live in the snapshot |

### `tests/kernel/invariants.test.ts`

| Fixture | Assertion |
|---|---|
| `INV-ALL-1` | per acceptance criterion 15 |
| `slow cadence` | I-29 and I-30 run on ticks 50, 100, 150 and on no others |
| `I-25 gating` | I-25 runs only on ticks that emitted `resource.granted`, and only when `deadlock` is enabled |
| `numbered order` | the checks execute in ascending invariant number, verified by a probe |
| `thunk messages` | the message thunk is not invoked on the happy path, verified by a counting thunk |
| `side-effect free` | per acceptance criterion 23 |
| `cost` | per acceptance criterion 22 |
| `production compiles out` | with `checkInvariants: false`, no invariant function is called |

### `tests/kernel/invariants.negative.test.ts`

Forty cases, one per invariant, each constructing the smallest state that
violates it and asserting `KernelInvariantError` with the right number. The four
named fixtures are among them:

| Fixture | Assertion |
|---|---|
| `INV-NEG-1` | a duplicate frame in the free list throws with `invariant === 17` |
| `INV-NEG-2` | two processes in state `running` throws with `invariant === 2` |
| `INV-NEG-3` | a mutex with two holders throws with `invariant === 21` |
| `INV-NEG-4` | available plus held exceeding total throws with `invariant === 5` |

The negative fixtures matter as much as the positive ones: an invariant that
cannot be made to fail is not being checked. If you cannot construct a violating
state for some invariant without editing a frozen type, say so in your report
rather than deleting the case.

### `tests/kernel/sweep.test.ts`

| Fixture | Assertion |
|---|---|
| `INV-ALL-2` | 7 schedulers times 6 replacement policies times 6 disk policies, 2,000 ticks each, zero violations across all 252 combinations |
| `sweep determinism` | each of the 252 combinations run twice gives identical canonical hashes |

Budget this test: 252 runs of 2,000 ticks is 504,000 steps. If it exceeds 60
seconds, mark it with a `slow` tag and keep it in the default run anyway, but
report the wall time.

## Out of scope

- Reimplementing any subsystem's logic inside a handler. Handlers are validated
  adapters. Missing subsystem logic is reported, not written here.
- Any change to a subsystem file beyond adding `snapshotContribution` and
  `restoreContribution` where absent.
- Anything under `src/game/`, `src/world/`, `src/render/`, `src/ui/`,
  `src/design/`, `src/platform/`, `src/audio/`, `src/terminal/`, `src/legs/`.
- The save file envelope, the checksum and the replay worker. WP-17 and WP-18 own
  them. This package delivers `KernelSnapshot`; they wrap it.

## Report back

State:

1. Pass or fail for each of the thirty acceptance criteria, by number.
2. The four verification command outcomes, including the contract guard.
3. The complete list of side tables you carried into `KernelSnapshot`, with the
   `subsystems` slot each went into and, for the envelopes, the `owner` and
   `version` you recorded.
4. Any side table with no home in the channel, escalated per the procedure.
5. Every subsystem file you added `snapshotContribution` or
   `restoreContribution` to.
6. The measured phase 11 cost as a percentage of total step time, and the wall
   time of the 252-combination sweep.
7. Any invariant for which you could not construct a negative test, with the
   reason.
8. Every `// TODO(astra):` left in the tree, with file and line. This package
   should end with zero `TODO(astra)` markers anywhere under `src/kernel/`;
   report any that survive and why.

## Inherited from WP-06: the complete invariant exceptions

Copied verbatim from the WP-06 completion report. These are required exceptions tied to explicit state, not permission to relax any invariant globally. Sim spec section 15's literal pseudocode cannot be applied unchanged to the VM state WP-06 introduced; this table is the interpretation the implementation and its tests already enforce.

WP-06 does not edit `invariants.ts`. The existing runtime checks and the new regression tests exercise the implemented boundaries below; WP-11 must carry them into the complete invariant suite. The literal pseudocode in sim spec section 15 cannot be applied unchanged to every new VM state.

| Invariant / concern | Required interpretation |
|---|---|
| I-4, CPU time versus useful service | A failed major/COW attempt and a timed translation attempt consume CPU without retiring useful work. The existing service-deferral mechanism restores PCB/raw/TCB useful-service counters while retaining the attempt's `totalCpuUsed`. Consequently, the spec's simple `totalCpuUsed + serviceRemaining === initial service` equality needs explicit overhead/adjustment accounting. The approved burst-halving primitive also changes the remaining useful-work budget. The unrelated Amdahl arithmetic remains untouched. |
| I-7, threads and aggregate service | Blocking a faulting LWP must preserve its siblings' remaining service; `blockMemoryAccess` saves their service counters across blocking, and the existing deferred delivery restores the caller's charge. A whole-process suspension preserves each live TCB and changes every nonterminated TCB to waiting. It does not destroy threads or alter their useful work. |
| I-8, restart PC | Pending major faults and pending COW capacity requests leave the faulting TCB's PC unchanged. Retries represent the same logical reference for WSS/LFU accounting. A synchronous retained/shared minor with `minorFaultTicks === 1` can finish the access in that tick; a blanket rule forbidding PC advance whenever *any* `memory.page_fault` event appears would reject this approved minor-service behavior. Apply the no-advance rule to instructions still awaiting service. |
| I-9, TLB coherence | Every valid cache entry still has exact physical owner/page identity and agrees with a valid PTE. COW/shared aliases with a different ASID or virtual page remain valid mappings but are deliberately not cached under that mismatching identity. Replacement invalidates every TLB entry naming the victim and clears pending timing for every invalidated alias; an evict/reload sequence cannot reuse an obsolete translation delay. |
| I-10, waits and queue membership | A suspended process has a temporary sleep overlay on PCB/TCBs, while its original PCB/TCB waits remain in the VM suspension record. Existing IPC/device/sync waits may therefore still name their original queues. Validate these against the saved original waits while suspension is active. Paging may complete during suspension, but the suspension gate prevents ordinary sleep expiry or a now-valid page from waking the process. Pending page-fault waits can be represented by a queued/read/write-back/copy request, or by a just-loaded reference awaiting its scheduled restart. |
| I-11, legal transitions | The only new edge is `ready -> waiting` with `reason: 'memory_suspension'`; undefined and `reparent` reasons still fail I-11. Ordinary `blockProcess` still requires running state. Already-waiting suspension changes wait metadata without emitting a fictional waiting-to-waiting state event. Restore and the transition guard must retain the suspension-specific justification rather than globally legalizing this edge. |
| I-12/I-13, readiness | Suspension removes a ready PID from the ready queue and clears `readySince`; suspending the running PID also clears the CPU owner. Recovery restores prior TCB waits and only makes the PCB ready when a runnable TCB exists. Its normal unblock callback runs after the state/`readySince` update. Init and idle remain outside user scheduler queues. |
| I-17/I-20, frame conservation and free ordering | `freeList` contains only owner-null frames, without duplicates, in ascending order. Retained `freePool` frames still have owner/page/content identity and count as owned for physical conservation; they are not also free-list entries. `FrameTable.available` includes reclaimable retained capacity as well as the free list. Keep these two meanings of “available/free” distinct. Reservations also remain owned and are never simultaneously free. |
| I-18, retained contents | An owned retained-pool frame can legitimately have no valid PTE. Its saved old owner/page permits a minor reclaim before reuse. This is an inherited WP-05 exception to “every owned frame has a valid mapping.” |
| I-18, aliases | A valid COW or shared-region alias need not match the frame's physical owner/page. COW alias cardinality is owned by lifecycle's `cowRefCount`; IPC aliases instead follow the shared-region attachment/backing mapping and pinning rules. A shared alias is not automatically a COW alias. Invalidated PTEs still have `frame === null`. |
| I-18, in-flight page-in/write-back | A reserved destination frame may be owned while its target PTE is still invalid. The request's stable ID, stage, resolved backing identity, frame/source/victim metadata and deadline explain that state. Coalesced shared faults can have several logical-reference records pointing to one request and one reserved frame; they are not duplicate physical allocations. |
| Replacement eligibility | Exclude pinned shared frames, retained-pool frames, request destination frames and active COW source frames. Also protect a loaded fault reference until its first successful restart; otherwise a later queued request in the same phase-1 pass could evict it and strand its waiter. Jobs blocked only by temporary reservations remain queued. The persisted logical-reference/request records recreate these exclusions after restore. |
| COW physical reuse | Before invalidating a COW victim's aliases, memory notifies lifecycle. Lifecycle uses its existing COW identity to restore those aliases' private write permission, then deletes that frame's COW count. Memory invalidates the aliases and reuses the frame afterward. This prevents stale counts contaminating a later fork and prevents a former COW alias's later write from becoming a false protection fault. Mappings outside the existing COW identity are not granted permission by this hook. The inherited fork/read-only distinction remains a separate process limitation below. |
| I-19, metrics | Fault totals distinguish all faults from major faults. WSS noise affects the reported map only; true ring sizes drive demand. Integer EWMA state uses the approved zero-input tail clamp. Rates remain finite/nonnegative and TLB hit rate remains bounded. |

The VM host validates saved suspension PID/TID membership and the PCB sleep overlay. WP-11 must additionally compare actual live TCB wait states, lifecycle COW counts and IPC rights against their separately restored channels; this host does not expose those internals. The process channel must also restore programs/PCs, raw/TCB service, copy debt and lifecycle metadata before claiming full workload continuation.

The tests cover one-frame queued faults completing without hanging, COW eviction/reuse and subsequent write recovery, a shared request surviving its original requester's exit, retained reclaim, pin exhaustion, invalidated translation timing, and suspension/recovery across VM restore. These are required exceptions tied to explicit state, not permission to relax the corresponding invariant globally.

## Pending acceptance inherited from WP-04: the fresh-kernel scheduler restore

WP-04's package once required a mid-run MLFQ snapshot, with processes on all
three levels and at least one aged process, restored into a fresh kernel and
stepped forward to a byte-identical continuation. That needs the process
channel, which is yours, so the acceptance moves here. WP-04 proves the scheduler
contribution round-trips against equivalent staged process state; you prove the
whole workload restores into an empty kernel. Two values WP-04 adds must be in
your process contribution or the test cannot pass: the ThreadManager side table
of `overheadRemaining` and `pricedCores` per PID, from the creation-debt Amdahl
model. The process schema also omits raw burst, TCB remaining work and the round
robin TID cursor; your process amendment has to add them.

## Scope correction 2026-09-15: the state of the kernel WP-11 inherits

Written before WP-11 starts, after WP-10 merged. Every kernel package (WP-01
through WP-10) has landed; WP-12 and WP-13 are game-layer work that shares no
kernel file. The sections above were written while most of that was still
future; where this section disagrees with them, this section wins.

- **Verification is four gates.** `npm run check:contracts` precedes
  typecheck, test and build. Three files are frozen (`src/kernel/types.ts`,
  `src/game/types.ts`, `src/design/tokens.ts`); twelve amendments exist
  (thirteen once WP-13 freezes its focus contract). The guard enforces a zero
  skip budget, zero em dashes and the IP-term scan. Baseline after the WP-10
  merge: 1370 passed, 0 skipped, 67 files, in about 100 to 160 seconds. The
  suite has doubled twice in three packages; keep new tests lean and do not
  raise the global 20 s `testTimeout`.
- **Every slot is typed.** All ten `SubsystemSnapshots` slots are now typed
  states (process from amendment 1, memory and vm from 4 and 5, scheduler 6,
  sync 7, deadlock 8, storage and io 9, fs and security 11). "Envelope" in the
  text above is historical. Every subsystem already registers its contribution
  through `installHooks({ snapshots })` with `saveState` and a `restoreState`
  that returns a commit closure; `KernelImpl.snapshot()` and `restore()`
  dispatch over them and still carry WP-02's init-only guard. Your job is the
  process channel and the completeness check, and removing that guard with a
  corrected message. If `ProcessSnapshotState` needs fields (it does: see
  below), that is your amendment, provisional number 14; the procedure is in
  `docs/07-CONTRACT-AMENDMENTS.md` and every recent amendment record shows the
  form. Prove the payload extends `JsonValue` with a standalone strict check
  and embed type literals, never frozen interfaces, before sending the patch.
- **Process channel requirements gathered from every package:**
  - WP-04: ThreadManager's `overheadRemaining` and `pricedCores` per pid
    (creation-debt Amdahl), raw burst, TCB remaining work, the round-robin
    TID cursor. The mid-run MLFQ fresh-kernel restore is your acceptance.
  - WP-07: the program decoder must handle the `sync` `Instruction` variant
    (`{ kind: 'sync'; operation: SyncInstruction }`, operand shapes in
    `src/kernel/sync/SyncSubsystem.ts`); restore must recreate a distinct
    `BlockReason` object per TCB even when values match, because readiness
    routes waits by object identity; the private readiness helper matches
    `thread.blockedOn` by identity. Sync's `originalWait` host callback
    reaches into `memorySubsystem.pager.control.suspendedRecords`; give that a
    proper accessor while you are in the restore path. The scheduler aging
    hook is wrapped by sync at construction; a later `installHooks({
    scheduler })` must go through that wrap or priority inheritance across
    aging is lost.
  - WP-08: granted request vectors with non-null `grantedAt` are already
    allocated and must not be allocated again on restore; checkpoints are
    `{ pid, tid, tick, programCounter }`; I-26 is validated against the
    captured `lastDetection` evidence, never the post-recovery live graph.
  - WP-09: I/O requests are owned by `(pid, tid, requestId)`; `Device.queue`
    projects whole-process waiters only; the storage-backed paging adapter
    is opt-in through `attachPagingStorage()` and never installed by
    enabling `storage`; `chargeKernelDebt` adds to `switchDebt` and the I/O
    portion is persisted in the io slot with `0 <= ioDebt <= switchDebt`.
  - WP-10: FS process rows (cwd, descriptor membership, CLOEXEC) and pending
    file operations are in the fs payload and need PCB `openFiles` and thread
    identity restored by your channel; probe programs are re-registered by
    name from the security payload on commit; `kernelSecret` is rebuilt from
    the source snapshot's seed and never serialised.
- **The syscall table you inherit.** The dispatcher in `Kernel.ts` now has
  branches for getpid, fork, exec, exit, wait, kill, ioctl, sync, sem_wait,
  sem_post, mutex_lock, mutex_unlock, request, release, nice, and the file
  calls open, close, read, write, seek, stat, unlink, mkdir, chmod, each
  behind a `// TODO(astra): WP-11 validates ...` marker with a local shape
  check. You replace the local checks with `validate.ts` against `table.ts`
  and keep every existing assertion, in particular SEC-ARG-1's exact
  `"address out of range: "` prefix, which is currently produced by
  `SecuritySubsystem.validateByteCount` (marked for you). The file ABI as
  implemented: `open(path, mode)`, count-based `read` and `write`,
  `seek(fd, offset, whence)`, `stat` returning canonical JSON text, scalar or
  null elsewhere. `ioctl` keeps the `(device, command, ...args)` shape with
  the kernel pseudo-device; the commands in play are `kernel/tlb_flush`
  (WP-05), the disk0, nvm0, tty0 and net0 driver controls (WP-09), and
  `kernel/set_ring`, `kernel/domain_switch`, `kernel/capability_access`,
  `disk0/write_region`, `disk0/crash` (WP-10) through
  `IoSubsystem.registerControl`. The device is `tty0`; the literal `console`
  is rejected by the source scanner.
- **The invariant harness you inherit.** Every subsystem composes its checks
  onto the constructor invariant wrapper (WP-08, WP-09, WP-10 all wrap
  `this.invariants`). Phase 11 calls the wrapper. Your `invariants.ts` folds
  them into the numbered harness without changing phase 11's body. Exceptions
  already decided and documented: the two memory exceptions above, the twelve
  WP-06 rows, WP-07's nine (I-10 per TCB, VM suspension reasons, hand-off
  reservations, Mesa and Hoare states, barrier generations, counting
  semaphores and I-23 scoped to exclusive actors), WP-08's scoped I-24 and
  captured I-26, WP-09's I-27, I-28, I-32, I-33, WP-10's I-29 to I-31 on the
  50-tick slow interval and I-34 to I-37. `corruption.test.ts` expects a
  C-only crash to trip I-29 at the next 50-tick boundary; keep that.
- **A performance fix you should make.** `src/kernel/storage/DiskQueue.ts`
  `transfer` copies every stored sector on every transfer (quadratic). It
  forced WP-10's journal-cost fixture onto a fixture-local media and
  dominates two 30 s tests. Replace the copy with a map keyed by LBA, same
  semantics, WP-09's tests untouched; it is granted here because you are the
  last kernel package and the sweep depends on suite time.
- **Non-null assertions.** `src/kernel/fs` and `src/kernel/security` carry
  about ninety `!` assertions and `storage` nineteen. The briefing discourages
  them and nothing enforces it. Do not spend WP-11 on it; note the count in
  the report so a cleanup package can be scheduled.
- **D2.** `tests/kernel/determinism.test.ts` has the D2 snapshot-restore test
  live (the skip budget has been zero since WP-02); the "un-skip D2" line in
  the grant above is stale. D2 must stay green through your restore work and
  extend to a workload kernel.
- **Ending state.** `src/kernel` currently has fourteen `// TODO(astra):`
  markers outside `types.ts`; every one of them is yours. This package ends
  with zero.

## Pre-flight decisions 2026-09-15

The WP-11 agent's pre-flight mapped all thirty acceptance criteria against
cb08cce, listed the fourteen markers with resolutions, proposed the amendment
14 field list, and raised seventeen decisions and three protected-test
migrations. The code claims were checked (the dispatcher accepts any live
process at Kernel.ts:639-641, `nice` is absolute at 725-727 against a
readonly `basePriority`, the wait message is at lifecycle.ts:176,
`DiskQueue` rebuilds a map per transfer, sync validates actors against live
tables at SyncSubsystem.ts:626-628). Rulings follow.

### Amendment 14, approved as listed

Every field in the pre-flight's table is approved, with version staying 1
(no v1 payload was ever produced) and the D15 definitions written into the
patch comments. Send the exact patch with the standalone strict JsonValue
proof; the contract-only commit passes all four gates on its own.

### Decisions D1 to D17

- **D1, approved.** Stage the process channel into live tables first, then
  run each registered hook prepare-then-commit in registration order
  (memory, sync, deadlock, storage and io, fs and security). Completeness,
  version and process-payload validation run before any mutation; any
  failure after staging rolls back from an entry snapshot, recursion
  guarded, both errors rethrown if the rollback fails. The "one invalid
  contribution changes nothing" guarantee is kept by that rollback.
- **D2, approved.** `nice(delta)` relative to the current priority, clamped
  to [0, 39], returns the new priority, negative delta needs `control` on
  `process:<self>` when security is enabled; `exit` enforces [0, 255];
  `wait(-1)` means any child; `kill` implements signals 0 and 9, EINVAL
  otherwise, EPERM unless parent, self or `control` on `process:<pid>`,
  checked only with security enabled. If any protected test asserts the old
  absolute `nice`, quote-and-wait.
- **D3, approved.** WP-02's live-process rule stands (ESRCH for zombie,
  terminated or unknown; EBUSY where a call would block a non-running
  caller). The package's "non-running caller returns EPERM" test row is
  withdrawn; spec 14.1 is corrected by this section.
- **D4, approved.** Object rights stay with their owners so
  `security.access_denied` is emitted once; the gate checks `kill` and
  `nice` only; `CallSpec.requiredRight` is null for owner-checked rights.
- **D5 and D7, approved on the alternative.** One method
  `MemorySubsystem.resizeAddressSpace(space, pages)` for anonymous grow and
  shrink (page-table construction shared with spawn, frame release and COW
  counts handled as `releaseAddressSpace` does), used by `mmap`, `munmap`
  and `brk`; region cases go through `ipc.mmap` and `munmapRange`. Two
  tuning keys in `config.ts`: `maxOpenFiles` 32 and `maxPagesPerProcess`
  1024, both integer-validated. WP-05 and WP-06 tests untouched.
- **D6, approved.** Gate-level ENOENT for an unknown resource, primitive,
  region or device and EPERM for releasing more than held, before
  delegation. Over-post stays EINVAL (WP-07 S2). Two narrow fs edits are
  granted because they are spec rows with no other owner left: `open` mode
  `'wx'` returning EEXIST, and `maxOpenFiles` enforcement returning EAGAIN,
  both in `FileSystemSubsystem.ts` with WP-10's tests untouched. Spec 14.3
  and 14.4 are corrected by this section for the rows the code settled
  (EINVAL over-post, EBUSY for blocking non-running callers).
- **D8, approved.** `(device, command, ...args)` with the `kernel`
  pseudo-device is canonical, and the bare `['tlb_flush']` is accepted as an
  alias for `['kernel', 'tlb_flush']` so `tlb.test.ts` stays untouched.
- **D9, approved.** One-line edit at lifecycle.ts:176 to
  `no children: ${pcb.pid}` with the quoted process.test.ts:222 replacement.
- **D10, approved.** The sweep workload as proposed, with its own timeout
  and reported wall time. If the 252 combinations exceed 120 s on the CI
  runner, halve the tick count and say so in the report rather than
  raising the timeout further.
- **D11, approved.** Grant `SecuritySubsystem.secretAppearsIn(text)` as a
  boolean predicate (it reveals nothing). I-36's negative test goes through
  the public restore path with a hand-built payload if validation admits
  it; if not, I-36 and I-37 are reported as invariants without negative
  tests, with the reason.
- **D12, approved.** The four `snapshotContribution`/`restoreContribution`
  pairs (ThreadManager, IpcManager, ProcessLifecycle, ProcessTable) are the
  granted additions; list their line ranges.
- **D13, approved.** Public readonly `syscallState`, `invariantState()`, and
  an exported `dispatch(request, state, table)`.
- **D14.** Leave `determinism.test.ts` untouched, including the stale
  comment; note it in the report.
- **D15, approved** as the patch comments.
- **D16, approved.** Delete `validateByteCount` and its marker once
  `validate.ts` carries the SEC-ARG-1 check with the exact prefix.
- **D17, approved.** Persisted sorted array, private `Map<lba, number[]>`
  mirror rebuilt on restore and updated per write, array regenerated in
  `saveState`.

### Quote-and-wait, approved

All three replacements as quoted: process.test.ts:222; stepOrder.test.ts
106-109 with the retitled case; stepOrder.test.ts 181-185 with the retitled
case. No `tlb.test.ts` change (D8 alias).

### Corrections this section makes to the spec

Spec 14.1: a non-running live caller is not refused with EPERM; zombie,
terminated and unknown callers get ESRCH and calls that would block a
non-running caller get EBUSY. Spec 14.3 and 14.4: `sem_post` over-post is
EINVAL; `open` gains mode `'wx'`; `nice` takes a delta and returns the new
priority; `wait(-1)` is any child. The package's I-13 wording follows the
code (ready processes only).

### Not granted

- No subsystem edit beyond D5's one method, D6's two fs edits, D11's
  predicate, D16's deletion, D17's map, and the four D12 pairs.
- No change to `determinism.test.ts` or `tlb.test.ts`.
- No phase body or `step()` edit.


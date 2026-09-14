# WP-09: Mass storage and I/O

## Objective

When this package is done the kernel has a real disk: geometry, a three-component
cost model that converts milliseconds into ticks, all six scheduling policies
reproducing the textbook head paths exactly, an NVM device where seek
optimisation buys nothing, and RAID at six levels with the small-write penalty
and degraded-mode rebuild. It also has a real I/O layer: polling, interrupt and
DMA modes with their exact CPU cost models, a prioritised interrupt controller
with nesting, the interrupt storm condition and its four-stage escalation, three
buffering schemes, a block cache with two write policies, spooling, and the
driver abstraction with four shipping drivers. This is the simulation half of
Legs 9 and 10.

## Prerequisites

WP-02 complete and green.

Files that must already exist:

- `src/kernel/types.ts` (frozen)
- `src/kernel/Kernel.ts` with phases 2 and 3 delegating to `IoHooks`, and its
  no-op default
- `src/kernel/process/Program.ts` with the `io` instruction

WP-06 is not a prerequisite, but if it has landed, its major-fault path calls
`this.storage.enqueue(...)` behind a `// TODO(astra):` marker. Implement that
method with the signature WP-06 reported and remove the marker. If WP-06 has not
landed, define the method anyway and say so in your report.

## Required reading

- `02-KERNEL-SIM-SPEC.md` section 10 in full: 10.1 (disk geometry and the
  block-to-cylinder mapping), 10.2 (the cost model and the tick conversion), 10.3
  (the scheduling interface and the mandatory comparator), 10.4 (all six policies
  with their exact paths and totals), 10.5 (NVM, the FTL and write
  amplification), 10.6 (RAID at six levels, the small-write penalty, full-stripe
  writes, failure and rebuild)
- `02-KERNEL-SIM-SPEC.md` section 11 in full: 11.1 (the three I/O modes and their
  cost models), 11.2 (the interrupt path and nesting), 11.3 (the interrupt
  storm), 11.4 (buffering, caching and spooling), 11.5 (the driver abstraction)
- `02-KERNEL-SIM-SPEC.md` section 2.1, phases 2 and 3, and section 2.2's
  paragraphs "Device completions before interrupts" and "Interrupts before
  resolving blocked processes". The second one is the ordering the implementation
  is most likely to get wrong.
- `02-KERNEL-SIM-SPEC.md` section 16.9 (mass storage fixtures) and 16.10 (I/O
  fixtures)
- `02-KERNEL-SIM-SPEC.md` section 15, the "Storage, I/O and file system"
  invariant group

## Files you will create

```
src/kernel/storage/geometry.ts
src/kernel/storage/costModel.ts
src/kernel/storage/DiskQueue.ts
src/kernel/storage/registry.ts
src/kernel/storage/policies/fcfs.ts
src/kernel/storage/policies/sstf.ts
src/kernel/storage/policies/scan.ts
src/kernel/storage/policies/cscan.ts
src/kernel/storage/policies/look.ts
src/kernel/storage/policies/clook.ts
src/kernel/storage/nvm.ts
src/kernel/storage/raid.ts
src/kernel/storage/StorageSubsystem.ts
src/kernel/io/InterruptController.ts
src/kernel/io/modes.ts
src/kernel/io/buffering.ts
src/kernel/io/blockCache.ts
src/kernel/io/spool.ts
src/kernel/io/drivers/DeviceDriver.ts
src/kernel/io/drivers/disk0.ts
src/kernel/io/drivers/nvm0.ts
src/kernel/io/drivers/console.ts
src/kernel/io/drivers/net0.ts
src/kernel/io/IoSubsystem.ts
tests/kernel/storage/diskScheduling.test.ts
tests/kernel/storage/costModel.test.ts
tests/kernel/storage/nvm.test.ts
tests/kernel/storage/raid.test.ts
tests/kernel/io/modes.test.ts
tests/kernel/io/interrupts.test.ts
tests/kernel/io/buffering.test.ts
```

## Files you may modify

```
src/kernel/Kernel.ts   (wire IoHooks and StorageSubsystem into phases 2 and 3;
                        implement setDiskPolicy. Nothing else.)
src/kernel/index.ts    (add the DISK_POLICIES export)
```

Nothing else.

### Scope correction, 2026-09-13

Raised by the audit of this package against its own specification and against the
current `Kernel.ts`, `config.ts` and syscall dispatch, before the package started.
The grant above excluded eight things this package itself requires. This is the
same defect shape that produced the five escalations recorded in
`docs/07-CONTRACT-AMENDMENTS.md` under "Package scope corrections". Approved as
follows, shaped for WP-07, which runs at the same time and edits the same four
shared files.

**`src/kernel/config.ts`, additive only.** This package names eleven knobs that do
not exist in `KernelTuning`. Add exactly these keys, with defaults, validated with
the pattern the existing knobs use:

| Key | Default | Source |
|---|---|---|
| `diskStarvationThreshold` | 400 | sim spec 10.4, SSTF starvation |
| `interruptServiceTicks` | 2 | sim spec 11.1 and 11.2 |
| `maxInterruptsPerTick` | 2 | sim spec 11.2, step 3 |
| `interruptStormThreshold` | 32 | sim spec 11.3 |
| `interruptStormWindow` | 10 | sim spec 11.3 |
| `maxPendingInterrupts` | report it | sim spec 11.2 names `maxPending` and gives no default |
| `dmaCycleStealRatio` | 0.1 | sim spec 11.1, DMA step 2 |
| `nvmWriteBufferPages` | 8 | sim spec 10.5 |
| `rebuildBlocksPerTick` | 4 | sim spec 10.6 |
| `rebuildProgressInterval` | report it | sim spec 10.6 gives no default |
| `blockCacheEntries` | 64 | sim spec 11.4 |

Every key above except `dmaCycleStealRatio` is a positive integer and uses the
existing integer check. `dmaCycleStealRatio` is a bounded fraction, so validate it
the way `defaultSerialFraction` is validated rather than adding a helper. Where the
sim spec gives no default, choose one, comment the choice, and report it; do not
invent a number silently.

The disk geometry and cost constants are a separate matter and stay out of
`KernelTuning`. `seekOverheadMs` 0.5, `seekPerCylinderMs` 0.04, `rpm` 7200,
`transferMbPerSec` 100, `headsPerCylinder` 4, `sectorsPerTrack` 64,
`bytesPerSector` 512 and `MS_PER_TICK` 0.5 are fractional or geometric, the only
validator in `config.ts` is an integer check, and sim spec 10.1 already declares
them as `DiskGeometry`. Keep them as the defaults of
`src/kernel/storage/geometry.ts` and `costModel.ts`, reachable through
`setCostMultiplier`. `wordSize` is per device and belongs in
`src/kernel/io/modes.ts`.

Do not reformat anything and do not touch a key you did not add: this file is
shared with WP-07, which is adding its own keys at the same time.

**Snapshot save and restore for the `storage` and `io` slots.** Required by
acceptance criterion 23 and by amendment 1. Register through
`installHooks({ snapshots })` using `saveState` and `restoreState`, exactly as
WP-05 left it. `restoreState` validates the envelope, captures detached state, and
returns a commit closure; it mutates nothing during preparation, because the kernel
prepares every contribution before it changes any state. Add no hard-coded slot key
to the snapshot object literal. Duplicate slot ownership is rejected, so register
both slots from one hooks object.

Correction to section 12 of this package: `SubsystemSnapshots` does now have an
`io` slot. Amendment 3 added `scheduler`, `vm`, `deadlock` and `io`, and added a
compile-time check that every `SubsystemId` has a slot. Put the I/O half in the
`io` slot rather than smuggling it through the storage payload, and raise no
amendment for a slot that exists.

**The `ioctl` device subcommands this package owns.** Acceptance criterion 16
requires a device to drop to polling, the `mode side table` test requires the live
mode to change, and sim spec 14.3 routes `set_policy`, `reset`, `set_mode`,
`crash`, `fail_disk`, `trim`, `flush` and `set_loss` through `ioctl`. The branch in
`dispatchSyscall` accepts only `tlb_flush` today and returns `EINVAL` on anything
else, so every driver `control` table is unreachable. Add exactly the subcommands
your four drivers own, route each into that driver's `control`, return `EINVAL` on
an unknown subcommand, and leave the existing `tlb_flush` case exactly as WP-05
wrote it. Carry the marker
`// TODO(astra): WP-11 validates ioctl arguments`, which is already on that branch,
because WP-11 owns the full table.

Report, do not resolve: sim spec 14.3 declares `ioctl(device, command, ...)` with
`args[0]` the `DeviceId` and `args[1]` the command, while the branch WP-05 left
reads `args[0]` as the command because the kernel pseudo-device has no id. Those
two argument shapes disagree. WP-11 owns the table and the arity check, so state
the conflict in your report and keep `tlb_flush` working at its current position
rather than renumbering it.

**The `sync` syscall, the cache-flush half only.** Sim spec 14.3 has `sync` flush
every dirty block cache entry and block the caller until the writes complete, and
the `write_back dirty` test in this package asserts that `sync` flushes them. The
call reaches the default branch today and returns `EINVAL`. Add the branch, drive
it through `dirtyEntries()` and the block cache, return the flushed count, and mark
it `// TODO(astra): WP-11 validates sync arguments`. The journal half of `sync` is
WP-10's, so leave a `// TODO(astra): WP-10 flushes the journal` and do not write
journal code.

`open`, `close`, `read`, `write`, `seek`, `stat`, `unlink`, `mkdir` and `chmod`
stay out. Their preconditions in sim spec 14.3 are path resolution, descriptors and
inode rights, all of which live in WP-10, and WP-11 owns the table. This package
provides the block device they sit on and nothing above it.

**Publishing the disk and device tables into the shared snapshot tables.**
`snapshot()` reads the private `diskQueue`, `diskHead` and `devices` fields on
`KernelImpl`. They are written only by `restore`, and nothing in the tree
constructs a `Device` or a `DiskRequest`, so wiring `IoHooks` alone leaves
`KernelSnapshot.diskQueue` and `.devices` permanently empty and invariants I-27,
I-28 and I-32 with nothing to check. Bind the live arrays in the existing
initialisation helper, the way WP-05 bound the frame and TLB views there, and
rebind them after a restore commit. Bind the live arrays themselves rather than
copying per call.

**`StorageHooks.expireTimers`, which is phase 1 and not phase 2 or 3.** RAID
rebuild progress and NVM garbage collection are timer work, and the kernel calls
`StorageHooks.expireTimers` in phase 1, outside the "phases 2 and 3" the grant
names. Register it. Completions stay in phase 2, interrupt delivery stays in phase
3, and wait resolution stays in phase 4. Do not move work between phases and do
not edit a phase body.

**Construction wiring.** Constructing `StorageSubsystem` and `IoSubsystem` in the
kernel constructor is part of wiring the hooks, and it includes handing each
subsystem its emit callback and its stream, `root/storage` and `root/io`, taken
from the stream registry the same way `schedulerContext()` takes the `scheduler`
stream. `process.starving` for seek starvation, `fs.corruption` for the spooling
fixture and `kernel.panic` for a storm all travel on that emit callback. `net0`
draws packet loss from `root/io` and from no other stream.

**Interrupt overhead charged to the kernel: there is an existing channel, so
this is a one-line accessor rather than an escalation.** Sim spec 11.2 requires
`interruptServiceTicks` to reduce `cpuUtilisation` without increasing any
process's `totalCpuUsed`, and acceptance test `utilisation falls` asserts it.
`Kernel.ts` already carries exactly this mechanism for context switches: a private
`switchDebt` counter that phase 8 consumes one tick at a time before it executes
anything (the early return at the top of the execute path), that `snapshot()` and
`restore()` already persist, and that the WP-05 report confirms is kept out of
delivered useful service. Interrupt service is the same kind of tick: the CPU is
busy, no process advances.

Add one public method to `KernelImpl`, outside every phase body:

```ts
/** Kernel-side CPU ticks charged to no process: context switches, interrupt
 *  service. Consumed by the existing phase 8 debt check. */
chargeKernelDebt(ticks: number): void { this.switchDebt += ticks; }
```

Call it from `deliverInterrupts` with `interruptServiceTicks` per delivered
interrupt. Do not touch phase 8, `scheduler/metrics.ts`, or the scheduling
accounting object. The name `switchDebt` is now narrower than what it holds; leave
the rename to WP-11, which owns the invariant set, and mention it in your report.

Verify with the `utilisation falls` test. If it passes, this item is closed. If
it fails because `scheduler/metrics.ts` counts debt ticks in a way that does not
move `cpuUtilisation`, then and only then escalate, and the escalation is for a
metrics change owned by WP-03 and WP-04, not for a phase edit.

**Metrics recomputation.** There is no `IoMetrics` or `StorageMetrics` type in the
frozen contract and `MetricsHooks` carries only `scheduler` and `memory`, so this
package registers no metrics hook. If one becomes necessary, register at the
existing phase 10 dispatch site and look for the registration marker. Phase 10
itself is not edited.

**What stays out.** The eleven ordered phase bodies are not edited; anything that
would require it is an escalation. WP-07 is in flight and owns
`src/kernel/sync/**`, the `sync` snapshot slot, the `sem_wait`, `sem_post`,
`mutex_lock`, `mutex_unlock`, `request` and `release` syscall branches, the
phase 4 readiness and priority-inversion path, and its own `config.ts` keys. The
`circular` buffering scheme imports WP-07's bounded buffer; import it and do not
edit it. Do not reorder or reformat the lines WP-07 will add. `src/kernel/fs/**`,
`src/kernel/security/**`, `src/kernel/memory/**`, `src/kernel/deadlock/**`,
`src/kernel/syscall/**` beyond the two branches above, and `invariants.ts` stay
out.

**Two things WP-05 warns about, and they apply here.** First, installing runtime
hooks still trips WP-02's init-only snapshot guard: `installHooks` sets the guard
flag for every key except `snapshots`, so a kernel with `io` or `storage` hooks
installed refuses `snapshot()` and `restore()`. The round-trip test for criterion
23 must therefore register snapshot-only, through `installHooks({ snapshots })`
with no other key, which is the one case the guard allows. Second, the generic
snapshot dispatch does not finish WP-11's workload persistence: the process
contribution, the completeness check and the removal of the guard stay WP-11's,
and its throwing assertions remain in place.

## Frozen contracts

From `src/kernel/types.ts`. These may not be edited. If this package cannot be
completed without changing one, stop and report per the escalation procedure.

```ts
export type DiskSchedulingId = 'fcfs' | 'sstf' | 'scan' | 'cscan' | 'look' | 'clook';

export interface DiskRequest {
  readonly id: number;
  readonly pid: Pid;
  readonly cylinder: number;
  readonly write: boolean;
  readonly queuedAtTick: Tick;
  servedAtTick: Tick | null;
}

export interface DiskSchedulingPolicy {
  readonly id: DiskSchedulingId;
  readonly displayName: string;
  /** Returns the index into `queue` to serve next. */
  select(queue: readonly DiskRequest[], head: DiskHead): number;
  snapshot(): { readonly policy: DiskSchedulingId; readonly projectedPath: readonly number[] };
}

export interface DiskHead {
  cylinder: number;
  /** SCAN family only. */
  direction: 'up' | 'down';
  readonly totalCylinders: number;
}

export type RaidLevel = 0 | 1 | 4 | 5 | 6 | 10;

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

Events this package emits, from the frozen union:

```ts
| (EventBase & { type: 'disk.queued'; request: DiskRequest })
| (EventBase & { type: 'disk.seek'; from: number; to: number; distance: number })
| (EventBase & { type: 'disk.served'; request: DiskRequest; waitTicks: number })
| (EventBase & { type: 'raid.rebuild'; level: RaidLevel; failedDisk: number; progress: number })
| (EventBase & { type: 'io.request'; pid: Pid; device: DeviceId; mode: IoMode })
| (EventBase & { type: 'io.interrupt'; device: DeviceId; pid: Pid | null })
| (EventBase & { type: 'io.dma_transfer'; device: DeviceId; bytes: number })
| (EventBase & { type: 'io.poll_wasted'; device: DeviceId; wastedTicks: number })
| (EventBase & { type: 'process.starving'; pid: Pid; waitedTicks: number; fatal: boolean })
| (EventBase & { type: 'fs.corruption'; inode: InodeId; recoverable: boolean })
| (EventBase & { type: 'kernel.panic'; message: string })
```

`Device.mode` is `readonly`, so switching a device from `interrupt` to `polling`
during a storm cannot mutate it. Hold the live mode in a side table
`Map<DeviceId, IoMode>` seeded from `Device.mode` at construction, make that
table the authority, and note the reason in a comment. Do not cast away
`readonly` and do not add a field.

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
snapshot literal. Duplicate slot ownership is rejected, so return both the
`storage` and the `io` slot from one `saveState`. Validate and capture detached
state before returning the closure, and do not mutate anything during preparation.

### The init-only guard trap

Installing runtime hooks still enables WP-02's full-workload snapshot guard;
snapshot-only registration works without enabling it. So the round-trip test must
register through `installHooks({ snapshots })` and pass no other key, or
`snapshot()` and `restore()` will throw before your state is reached. Generic
contribution dispatch does not finish WP-11's workload persistence, and WP-11's
existing throwing assertions remain intact.

### Phase discipline

Use the existing subsystem hooks for phase work. Completions run in phase 2,
interrupt delivery in phase 3, and wait resolution in phase 4; timer work,
including RAID rebuild progress and NVM garbage collection, runs in phase 1 through
`StorageHooks.expireTimers`. Neither phase 10 nor the eleven phase bodies changed
under WP-05 and they do not change here. An I/O completion in phase 2 must be able
to unblock its waiter on the same tick, which is what putting interrupt delivery in
phase 3 and wait resolution in phase 4 buys you.

### Disabled hooks are inert

Every phase call is guarded by the enabled-subsystem set, and the defaults are
no-ops, so a leg that does not enable `io` or `storage` runs with your subsystem
present and silent. Determinism fixture D3 asserts that a workload with no I/O
produces the same context-switch sequence whether or not the subsystem is enabled,
so an inert hook must consume no RNG draws and emit no events.

### Descriptor and device cleanup on exit

The lifecycle calls `IoHooks.removeWaiter(pid)` from its wait-queue cleanup
callback, alongside the sync and IPC removals, and IPC detachment precedes private
address-space teardown. An exiting process must come out of every queue you hold:
the device queue, the disk queue, the spool queue, the buffer waiters and the
interrupt controller's pending handlers. Invariants I-10 and I-32 read
`Device.queue` and require every pid in it to be `waiting` with a matching
`blockedOn`, so a pid left behind by a teardown is an invariant failure rather than
a leak you can ignore. Descriptor reference counting itself stays with WP-10
through `FsHooks`.

### Detection timing and copy debt are already excluded from useful service

WP-05 added a service-deferral path so a pending translation consumes CPU time
without retiring useful instruction service, and copy-on-write copy debt is charged
as whole ticks before the execute helper runs. Neither counts as completed service.
Follow the same rule for polling: a poll iteration must consume a tick of CPU
without retiring useful service, and it must not terminate a process that has one
instruction left. Pending progress is counted in actual CPU execution attempts per
thread, not in time spent waiting off CPU.

### The merge surface WP-05 left

These are inclusive line ranges in the post-WP-05 files. They are the lines you are
most likely to collide with, and WP-07 is editing several of them at the same time.

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
Keep yours the same way. Your `ioctl` subcommands rebase onto lines 435-438 and
your snapshot registration onto lines 337-338.

### One prerequisite in this package is stale

The prerequisite paragraph above says WP-06's major-fault path calls
`this.storage.enqueue(...)` behind a marker. No such call, marker or method exists:
`StorageHooks` carries only `expireTimers`, and the fault extension point WP-05
left is `DemandPagingHooks.fault` on `MemorySubsystem`, installed with
`setDemandPaging`. Define whatever swap-in method WP-06 turns out to need, name it
in your report, and do not go looking for a marker that was never written.

## Specification

### 1. `src/kernel/storage/geometry.ts`

```ts
interface DiskGeometry {
  readonly cylinders: number;          // KernelConfig.totalCylinders, default 200 (0..199)
  readonly headsPerCylinder: number;   // 4
  readonly sectorsPerTrack: number;    // 64
  readonly bytesPerSector: number;     // 512
  readonly rpm: number;                // 7200
  readonly seekOverheadMs: number;     // 0.5
  readonly seekPerCylinderMs: number;  // 0.04
  readonly transferMbPerSec: number;   // 100
}
```

Capacity is `cylinders * headsPerCylinder * sectorsPerTrack * bytesPerSector`,
which at the defaults is 26,214,400 bytes (25 MiB).

Block to cylinder:

```
sectorsPerCylinder = headsPerCylinder * sectorsPerTrack        // 256 at the defaults
cylinder = floor(blockId / sectorsPerCylinder)
```

Blocks are allocated in ascending order by default, so a contiguously allocated
file occupies consecutive cylinders and a fragmented one does not. That is what
makes WP-10's allocation-method comparison produce different seek totals rather
than the same one.

### 2. `src/kernel/storage/costModel.ts`

Three components, sim spec 10.2:

```
seekTimeMs = seekOverheadMs + seekPerCylinderMs * |targetCylinder - headCylinder|
rotationMs = 0.5 * (60000 / rpm)
transferMs = (bytes / (transferMbPerSec * 1e6)) * 1000
serviceMs  = seekTimeMs + rotationMs + transferMs
```

Tick conversion, `MS_PER_TICK = 0.5`:

```ts
function ticksFor(serviceMs: number): number {
  return Math.max(1, Math.round(serviceMs / MS_PER_TICK));
}
```

**The floor is 9 ticks even with no seek at all**, because rotation dominates.
That number is what makes the player care about the scheduling policy only after
they have already reduced request count.

KESTREL's passive halves `seekOverheadMs`, `seekPerCylinderMs` and every
`Device.latency`, applied at cost-model evaluation time so it affects every policy
equally. The kernel does not know Program names: expose
`setCostMultiplier(factor: number)` and let `@game` call it with 0.5.

### 3. The disk scheduling interface

`DiskSchedulingPolicy.select(queue, head)` returns an **index into `queue`**, not
a request. The kernel then removes that index, moves the head, charges the cost,
and emits `disk.seek` followed by `disk.served`.

The queue is maintained in arrival order. Policies that need a sorted view build
it inside `select` and must sort with an explicit comparator:

```ts
const byCylinderThenId = (a: DiskRequest, b: DiskRequest) =>
  a.cylinder !== b.cylinder ? a.cylinder - b.cylinder : a.id - b.id;
```

`DiskRequest.id` is a monotonic counter, so this is a total order. A comparator
that can tie is a determinism bug.

`snapshot().projectedPath` is the cylinder sequence the policy would visit if no
further requests arrived, which the world layer draws as a head path over the
platter. Compute it without mutating the queue.

### 4. The six policies

Throughout, the queue is the Ch. 11.2 standard
`98, 183, 37, 122, 14, 124, 65, 67`, head at cylinder 53, 200 cylinders.

**FCFS.** Return index 0. Path
`53, 98, 183, 37, 122, 14, 124, 65, 67`. Total **640**. Movements 45, 85, 146,
85, 108, 110, 59, 2.

**SSTF.** Return the index minimising `|request.cylinder - head.cylinder|`.
Tie-break on lower cylinder, then lower request id. Path
`53, 65, 67, 37, 14, 98, 122, 124, 183`. Total **236**.

SSTF can starve a request far from a busy region. Detect it with the same
mechanism as CPU starvation: a request whose `tick - queuedAtTick` exceeds
`diskStarvationThreshold` (default 400 ticks) raises `process.starving` against
its `pid`. This is Leg 9's signature failure and it is why the leg pushes the
player from SSTF to a SCAN variant.

**SCAN, the elevator.** Serve every request in the current `direction` in
cylinder order, reach the end of the disk (cylinder 0 or `totalCylinders - 1`),
reverse `direction`, and serve the rest. Implemented as: filter the queue to
requests on the current side of the head, inclusive of the head cylinder, and
return the index of the closest one in the direction of travel. When that set is
empty, set `head.direction` to the opposite value, charge the movement to the end
of the disk, and repeat.

- `direction: 'down'`: `53, 37, 14, 0, 65, 67, 98, 122, 124, 183`, total **236**.
- `direction: 'up'`: `53, 65, 67, 98, 122, 124, 183, 199, 37, 14`, total **331**.

SCAN's cost depends on the starting direction, so the implementation must read
`DiskHead.direction` rather than assume one.

**C-SCAN.** Serve requests only while travelling toward the high end. On reaching
the end, return immediately to cylinder 0 without servicing anything on the way
back, and resume. The return sweep costs full head movement, which is the price
of the uniform wait time.

- `direction: 'up'`: `53, 65, 67, 98, 122, 124, 183, 199, 0, 14, 37`, total
  **382** (146 up, 199 back, 37 up).
- `direction: 'down'`: total **386**.

Report the standard deviation of `servedAtTick - queuedAtTick` across the queue
as `waitUniformity()`. C-SCAN moves more than SCAN on this queue and gives more
uniform waiting, and the Leg 9 debrief prints both numbers side by side.

**LOOK.** SCAN, except the head reverses at the **last request** in the current
direction rather than at the end of the disk.

- `direction: 'down'`: `53, 37, 14, 65, 67, 98, 122, 124, 183`, total **208**.
- `direction: 'up'`: `53, 65, 67, 98, 122, 124, 183, 37, 14`, total **299**.

**C-LOOK.** C-SCAN, except the return jump goes to the **lowest requested
cylinder** rather than to cylinder 0.

- `direction: 'up'`: `53, 65, 67, 98, 122, 124, 183, 14, 37`, total **322**
  (130 up, 169 back, 23 up).
- `direction: 'down'`: total **326**.

The full ten-row summary table is fixture `DISK-ALL-1` and the world layer
renders it as six overlaid head paths on the platter. LOOK going down wins on
total movement and does not win on wait-time uniformity.

### 5. `src/kernel/storage/nvm.ts`

```ts
interface NvmGeometry {
  readonly pages: number;              // 4 KB read/write granularity
  readonly pagesPerBlock: number;      // 256, the erase granularity
  readonly readUs: number;             // 25
  readonly writeUs: number;            // 250
  readonly eraseUs: number;            // 2000
  readonly overProvisionRatio: number; // 0.07
}
```

**Uniform access time.** `readUs` is the same regardless of address, so seek
optimisation buys exactly nothing and every policy in section 4 produces the same
total service time. Assert it.

Three things replace seek optimisation:

1. **Read/write asymmetry.** A write costs ten times a read, so merging small
   writes is the optimisation. The device has a write-combining buffer of
   `nvmWriteBufferPages` (default 8) and the scheduler's job is to fill it.
2. **Erase-before-write.** A page cannot be overwritten in place; its whole block
   must be erased first. The FTL maps logical page to physical page and writes to
   a free physical page, marking the old one invalid.
3. **Garbage collection and write amplification.** When free physical pages fall
   below `overProvisionRatio * pages`, GC picks the block with the most invalid
   pages, copies the valid pages elsewhere, and erases it. **Write amplification**
   is `physicalWrites / logicalWrites`, reported as a metric. Small random writes
   drive it above 3; the same bytes written sequentially keep it near 1.

GC block selection must be deterministic: highest invalid count first, tie-broken
by lowest block index.

### 6. `src/kernel/storage/raid.ts`

Six levels, `n` disks. Implement the full table from sim spec 10.6:

| Level | Usable capacity | Read cost | Write cost | Tolerates |
|---|---|---|---|---|
| 0 | `n` | 1 | 1 | **0 disks** |
| 1 | `n / 2` | 1 (sim reads the lower index) | **2** | 1 per mirror pair |
| 4 | `n - 1` | 1 | **4** | 1 disk |
| 5 | `n - 1` | 1 | **4** | 1 disk |
| 6 | `n - 2` | 1 | **6** | **2 disks** |
| 10 | `n / 2` | 1 | **2** | 1 per mirror pair, up to `n / 2` |

**The small-write penalty**, Ch. 11.8.3, spelled out. Writing one block under
RAID 4, 5 or 6 requires: read old data (1), read old parity (1), write new data
(1), write new parity (1), so **4 I/O for one logical block write**. RAID 6 adds
a second parity block, doubling steps 2 and 4, so **6 I/O**.

**Full-stripe writes avoid it entirely.** Writing all `n - 1` data blocks of a
stripe lets parity be computed from the new data with no reads: `n - 1` data
writes plus 1 parity write, so `n` I/O for `n - 1` blocks, a penalty of
`n / (n - 1)`. **Detect a full-stripe write in the block layer and take the fast
path.** A player who writes sequentially sees a fraction of the cost of one who
writes randomly, as a number rather than as advice.

**RAID 4 versus RAID 5.** Under RAID 4 every write touches the single parity
disk, so its queue grows without bound under a write-heavy workload. Under RAID 5
parity for stripe `s` lives on disk `(n - 1 - (s mod n))`, so the load spreads.
Report per-disk queue length; the RAID 4 parity disk must visibly saturate.

**Failure and rebuild.** Disk failure is injected by the leg, **never by the RNG
during normal play**. On failure:

1. The array enters `degraded` mode. Reads to the failed disk are reconstructed
   by reading the other `n - 1` disks and XORing, so **read cost jumps from 1 to
   `n - 1`**.
2. Rebuild onto a spare proceeds at `rebuildBlocksPerTick` (default 4), emitting
   `raid.rebuild { level, failedDisk, progress }` every
   `rebuildProgressInterval` ticks with `progress` in `[0, 1]`.
3. **A second failure during rebuild is fatal at levels 0, 1 (same pair), 4, 5
   and 10 (same pair), and survivable at level 6.**
4. Rebuild competes with normal traffic, so throughput during rebuild drops by
   roughly `rebuildBlocksPerTick / totalBlocksPerTick`. The player can pause the
   rebuild to recover throughput, at the cost of extending the window in which a
   second failure is fatal. Expose `pauseRebuild()` and `resumeRebuild()`.

### 7. `src/kernel/io/modes.ts`

The three cost models, sim spec 11.1. Implement each exactly.

**Polling.** The requesting process executes a poll loop. Each iteration is one
tick of CPU service spent by the process and produces nothing.

```
1. issue the request                     1 tick
2. while device.busy: read status        1 tick per iteration, charged to the process
3. transfer word by word                 bytes / wordSize ticks, charged to the process
```

Wasted ticks are `device.latency - 1` per request, and every one is emitted as
`io.poll_wasted { device, wastedTicks }` when the loop ends. **Those ticks count
as CPU busy in `cpuUtilisation`**, which is the trap: a polled system shows 100
percent utilisation and near-zero throughput. Expose `pollTicks(pid)` so WP-15's
`top` command can separate `poll%` from `user%`.

**Interrupt-driven.** The process issues the request and blocks.

```
1. issue the request           1 tick, then T5 to waiting
2. CPU runs other processes    0 to the requester
3. device completes, raises    phase 2
4. interrupt delivered         interruptServiceTicks (default 2), charged to the KERNEL
5. handler copies word by word bytes / wordSize ticks, kernel
6. requester marked wakeable   phase 3, unblocked in phase 4
```

**DMA.** The process issues the request; the controller transfers directly to
memory; one interrupt fires at the end of the whole transfer.

```
1. issue and program the controller   2 ticks
2. the controller transfers           0 CPU ticks, but charge dmaCycleStealRatio
                                      (default 0.1) of the transfer duration to the
                                      currently running process
3. one completion interrupt           interruptServiceTicks
4. the requester is unblocked
```

The comparison table for 10 requests of 4096 bytes on a device with
`latency = 20` and `wordSize = 64` (so `transferTicks = 64`):

| Mode | CPU ticks per request | CPU ticks for 10 |
|---|---|---|
| polling | 1 + 19 + 64 = 84 | **840** |
| interrupt | 1 + 2 + 64 = 67 | **670** |
| dma | 2 + 2 + 6.4 = 10.4, rounded to 10 | **100** |

### 8. `src/kernel/io/InterruptController.ts`

```ts
interface InterruptLine {
  readonly device: DeviceId;
  readonly priority: number;        // 0 is highest, matching the PCB convention
  readonly maskable: boolean;
  pending: number;                  // saturating at maxPending
}

interface InterruptController {
  readonly lines: InterruptLine[];  // sorted by (priority, deviceId), fixed at construction
  mask: Set<DeviceId>;
  inService: DeviceId | null;
}
```

**Delivery in phase 3**, four numbered steps from sim spec 11.2:

1. Build the candidate list: lines with `pending > 0`, not in `mask`, sorted by
   `(priority, deviceId)`. The sort key is fixed at construction so the array is
   pre-sorted and the scan is linear.
2. If `inService !== null`, a candidate is delivered only when its `priority` is
   **strictly less** than the in-service line's priority. This is nested
   interrupt handling and it is what interrupt priorities are for.
3. Deliver up to `maxInterruptsPerTick` (default 2). For each: decrement
   `pending`, set `inService`, charge `interruptServiceTicks` to the kernel's
   overhead counter, run the handler (mark the waiting process wakeable, complete
   the transfer), emit `io.interrupt { device, pid }`, restore the previous
   `inService`.
4. Non-maskable lines skip step 2 and are always delivered. Only the timer line
   and the `kernel.panic` line are non-maskable.

**Interrupt overhead is charged to the kernel**, not to the interrupted process.
It reduces `cpuUtilisation`'s numerator without increasing any process's
`totalCpuUsed`, so a system drowning in interrupts shows falling utilisation and
no process making progress, which is the correct picture.

Iterate `mask` never directly; derive a sorted array when order matters.

### 9. The interrupt storm

**Condition.** `totalPending` across all lines exceeds
`interruptStormThreshold` (default 32) for `interruptStormWindow` consecutive
ticks (default 10).

**Four-stage escalation**, sim spec 11.3:

| Stage | Condition | Response |
|---|---|---|
| 1 | the storm condition holds | emit `io.interrupt` with `pid: null` and expose the condition for `@game` to raise the `interrupt_storm` affliction |
| 2 | holds for `2 * window` | **mask the offending line** and switch that device to polling with a long poll interval |
| 3 | holds for `4 * window` | terminate the process generating the requests with `terminationReason: 'io_timeout'` |
| 4 | `pending` reaches `maxPending` on any line | `kernel.panic` with `` `interrupt storm on ${device}` `` |

Stage 2 is the standard mitigation: interrupts are turned off and the driver
polls until the flood subsides. The player watching the device drop to polling
and seeing throughput recover is how they learn interrupts are not free. Switch
the mode in the side table from section "Frozen contracts", never on `Device`.

The kernel does not know about afflictions or Program names. Expose
`stormState(): { active: boolean; device: DeviceId | null; ticksHeld: number }`.

### 10. `src/kernel/io/buffering.ts`, `blockCache.ts`, `spool.ts`

**Buffering**, three schemes selectable per device:

- `single`: one buffer; producer and consumer are fully serialised.
- `double`: two buffers; the producer fills one while the consumer drains the
  other. Throughput roughly doubles when rates are matched and does not improve
  at all when one dominates, which is the Ch. 12.5 point about the bottleneck.
- `circular`: `n` buffers in a ring. **This is the bounded buffer of WP-07 and it
  reuses that implementation**, which is why Leg 10 can hand the player a problem
  they already solved on Leg 5. Import it; do not write a second one.

Metrics per device: `bufferOccupancy` (mean over the last 100 ticks) and
`bufferStalls` (count of ticks the producer waited).

**Caching.** A block cache in front of the disk, `blockCacheEntries` (default
64), holding `BlockId -> contents`, with LRU replacement **using the same
comparator as WP-06's LRU**. Write policy is `'write_through' | 'write_back'`:

- `write_through`: every write goes to the disk immediately. A crash loses
  nothing.
- `write_back`: writes mark the entry dirty and are flushed on eviction or on the
  `sync` syscall. **A crash loses every dirty entry**, which is what WP-10's
  crash simulation exploits.

Expose `dirtyEntries(): readonly BlockId[]` and `dropDirty()` for the crash
simulation.

**Spooling.** A spool is a queue of complete jobs for a device that cannot
interleave, modelled for the printer device. Jobs are appended whole and served
FCFS. Without spooling, two processes writing to the printer interleave their
output and both jobs are ruined, represented as
`fs.corruption { recoverable: false }` on the output file. With spooling, the
second job waits.

### 11. `src/kernel/io/drivers/`

The driver abstraction from sim spec 11.5. `Device` in `types.ts` is the
kernel-visible half; `DeviceDriver` is the other half, with `submit`, `complete`,
`onInterrupt`, `control` and `snapshot` exactly as declared there.

The kernel knows only this interface. Adding a device type means adding a driver
and registering it, with no change to phases 2 and 3.

Four drivers ship:

| Driver | Kind | Notes |
|---|---|---|
| `disk0` | block | the geometry and scheduling of section 4 |
| `nvm0` | block | the NVM model of section 5, appears after the depot upgrade |
| `console` | character | one byte per tick, always `interrupt` mode |
| `net0` | network | fixed latency, packet loss drawn from `root/io`, used by the Leg 12 adversary |

`ioctl` is the escape hatch and every driver-specific behaviour goes through it,
which keeps `SyscallName` frozen while allowing new devices. WP-11 owns the
`ioctl` syscall itself; this package owns `control(command, args, ctx)` on each
driver. Document the command set each driver accepts in a comment above its
`control` method, and report the full list so WP-11 can wire it.

`net0` draws packet loss from `root/io` and from no other stream.

### 12. The storage and I/O snapshot contribution

This package owns the storage subsystem's contribution to `KernelSnapshot`. The
channel is `subsystems.storage`, added by `docs/07-CONTRACT-AMENDMENTS.md`
amendment 1, and it starts as a `SubsystemEnvelope`:

```ts
{ owner: 'storage', version: 1, payload: /* JsonValue */ }
```

`owner` is this subsystem's `SubsystemId`. `version` starts at 1 and this package
bumps it whenever the payload shape changes. The payload carries the state the
shared `diskQueue`, `diskHead` and `devices` tables cannot express: the disk
policy in force with its direction and sweep position, the NVM wear and mapping
state, the RAID layout and any rebuild in progress, the per-device mode table,
the interrupt controller's pending lines, masks and in-service line, the storm
window counters, the buffer and block cache contents, and the spool queues. It
must be plain `JsonValue`, so no `Map`, no `Set`, no function and no non-finite
number. Validate the payload on restore and throw on a `version` this package
does not understand, because a silently misread save is worse than a refused one.

`SubsystemSnapshots` has no separate `io` slot, so the I/O half travels in this
envelope under its own named key of the payload. If the typed promotion needs a
slot of its own, that is an amendment to raise at that point, recorded the same
way this one was.

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
4. Every row of the ten-row `DISK-ALL-1` summary table passes: the exact path and
   the exact total head movement for `DISK-FCFS-1` (640), `DISK-SSTF-1` (236),
   `DISK-SCAN-1` (236), `DISK-SCAN-2` (331), `DISK-LOOK-1` (208),
   `DISK-LOOK-2` (299), `DISK-CSCAN-1` (382), `DISK-CSCAN-2` (386),
   `DISK-CLOOK-1` (322), `DISK-CLOOK-2` (326).
5. Fixture `DISK-COST-1` passes: a 4 KB read at seek distance 50, 7200 rpm,
   100 MB/s gives seek 2.5 ms, rotation 4.1667 ms, transfer 0.0410 ms, total
   6.7077 ms, each to four decimal places.
6. Fixture `DISK-COST-2` passes: that request costs 13 ticks at 0.5 ms per tick,
   and a zero-seek request costs 9 ticks.
7. Fixture `DISK-NVM-1` passes: the standard queue on `nvm0` under all six
   policies gives identical completion ticks.
8. Fixture `DISK-NVM-2` passes: 1000 random 4 KB writes give write amplification
   above 3; 1000 sequential writes give write amplification within 0.1 of 1.
9. Fixture `RAID-1` passes: one logical block write under levels 0, 1, 4, 5, 6,
   10 gives physical I/O counts 1, 2, 4, 4, 6, 2.
10. Fixture `RAID-2` passes: a full-stripe write of `n - 1` blocks under RAID 5
    with `n = 5` costs 5 I/O for 4 blocks, a penalty of 1.25.
11. Fixture `RAID-3` passes: one disk failure under 0, 1, 4, 5, 6, 10 loses data
    only at level 0, and read cost on the degraded array rises to `n - 1` at
    levels 4, 5 and 6.
12. Fixture `RAID-4` passes: two simultaneous failures are survivable only at
    level 6, and at 1 and 10 when the failures are in different mirror pairs.
13. Fixture `IO-COST-1` passes: 10 requests of 4096 bytes with `latency` 20 and
    `wordSize` 64 give polling 840 CPU ticks, interrupt 670, dma 100.
14. Fixture `IO-POLL-1` passes: a polled device with one request emits
    `io.poll_wasted { wastedTicks: 19 }` and `cpuUtilisation` is near 1.0 with
    zero process progress.
15. Fixture `IO-INT-1` passes: two lines at priorities 0 and 2 both pending, the
    priority-0 line is delivered first and the priority-2 line is deferred while
    the first is in service.
16. Fixture `IO-STORM-1` passes: 5 interrupts per tick against
    `maxInterruptsPerTick` 2 for 10 ticks fires the storm condition, and at
    `2 * window` the line is masked and the device drops to polling.
17. Fixture `IO-BUF-1` passes: double-buffered throughput is within 5 percent of
    2x the single-buffered figure at matched producer and consumer rates.
18. Fixture `IO-SPOOL-1` passes: two processes writing the printer without
    spooling produce `fs.corruption { recoverable: false }`; with spooling, zero
    corruption and the second job waits.
19. Every comparator in this package passes a total-order assertion over 500
    distinct request pairs.
20. `setDiskPolicy` swaps between all six ids mid-run without losing a queued
    request and without an illegal transition.
21. `git diff --exit-code src/kernel/types.ts src/game/types.ts` exits 0.
22. The forbidden-identifier scan still returns zero matches, and `DET-D1`,
    `DET-D3` and `DET-D4` still pass.
23. Storage and I/O state survives a snapshot and restore round trip. Reach a
    mid-sweep state under `scan` with a non-empty disk queue, a pending interrupt
    line, a device in polling mode after a storm, and a non-empty spool queue;
    take the envelope; restore it into a fresh subsystem; and `projectedPath`,
    the next interrupt delivered and the next spool job served all match the
    kernel that was never interrupted.

## Tests you must write

### `tests/kernel/storage/diskScheduling.test.ts`

One case per row of `DISK-ALL-1`, each asserting the exact path array and the
exact total head movement.

| Fixture | Policy | Direction | Path | Total |
|---|---|---|---|---|
| `DISK-FCFS-1` | fcfs | n/a | `53,98,183,37,122,14,124,65,67` | 640 |
| `DISK-SSTF-1` | sstf | n/a | `53,65,67,37,14,98,122,124,183` | 236 |
| `DISK-SCAN-1` | scan | down | `53,37,14,0,65,67,98,122,124,183` | 236 |
| `DISK-SCAN-2` | scan | up | `53,65,67,98,122,124,183,199,37,14` | 331 |
| `DISK-LOOK-1` | look | down | `53,37,14,65,67,98,122,124,183` | 208 |
| `DISK-LOOK-2` | look | up | `53,65,67,98,122,124,183,37,14` | 299 |
| `DISK-CSCAN-1` | cscan | up | `53,65,67,98,122,124,183,199,0,14,37` | 382 |
| `DISK-CSCAN-2` | cscan | down | (recorded) | 386 |
| `DISK-CLOOK-1` | clook | up | `53,65,67,98,122,124,183,14,37` | 322 |
| `DISK-CLOOK-2` | clook | down | (recorded) | 326 |

Plus:

| Case | Assertion |
|---|---|
| `fcfs movements` | the eight individual movements are 45, 85, 146, 85, 108, 110, 59, 2 |
| `select returns index` | every policy's `select` returns a valid index into the queue, never a request object |
| `sstf tie-break` | two requests equidistant from the head resolve to the lower cylinder, then the lower id |
| `look beats scan` | LOOK down (208) is strictly less than SCAN down (236), and LOOK up (299) is strictly less than SCAN up (331) |
| `cscan uniformity` | the standard deviation of wait times under C-SCAN is strictly lower than under SCAN on the same queue |
| `seek starvation` | a request queued 401 ticks ago under SSTF against a busy region raises `process.starving` naming its pid |
| `projected path` | `snapshot().projectedPath` matches the actual path taken when no further requests arrive, and calling it does not mutate the queue |
| `disk.seek emitted` | each service emits `disk.seek { from, to, distance }` with `distance === |to - from|` |
| `total order` | `byCylinderThenId` never returns 0 for two distinct requests |

### `tests/kernel/storage/costModel.test.ts`

| Fixture | Assertion |
|---|---|
| `DISK-COST-1` | per acceptance criterion 5 |
| `DISK-COST-2` | per acceptance criterion 6 |
| `seek table` | seek for 0, 1, 50, 199 cylinders gives 0.5, 0.54, 2.5, 8.46 ms |
| `rotation` | 7200 rpm gives 4.1667 ms to four decimal places |
| `transfer` | 4 KB at 100 MB/s gives 0.0410 ms |
| `tick floor` | `ticksFor` never returns less than 1, for 1000 sampled service times |
| `capacity` | the default geometry gives 26,214,400 bytes |
| `block to cylinder` | block 0 maps to cylinder 0, block 255 to cylinder 0, block 256 to cylinder 1 |
| `cost multiplier` | `setCostMultiplier(0.5)` halves seek overhead, per-cylinder cost and device latency, and affects all six policies by the same factor |

### `tests/kernel/storage/nvm.test.ts`

| Fixture | Assertion |
|---|---|
| `DISK-NVM-1` | per acceptance criterion 7 |
| `DISK-NVM-2` | per acceptance criterion 8 |
| `write costs ten reads` | a write's service time is 10x a read's |
| `erase before write` | overwriting a logical page writes a new physical page and marks the old invalid; the logical-to-physical map reflects it |
| `gc trigger` | GC runs when free physical pages fall below `overProvisionRatio * pages` |
| `gc selection` | GC picks the block with the most invalid pages, tie-broken by lowest block index |
| `write buffer` | 8 small writes merge into one physical write with `nvmWriteBufferPages` at 8 |

### `tests/kernel/storage/raid.test.ts`

| Fixture | Assertion |
|---|---|
| `RAID-1` | per acceptance criterion 9 |
| `RAID-2` | per acceptance criterion 10 |
| `RAID-3` | per acceptance criterion 11 |
| `RAID-4` | per acceptance criterion 12 |
| `capacity` | usable capacity is `n`, `n/2`, `n-1`, `n-1`, `n-2`, `n/2` for the six levels |
| `raid5 parity spread` | parity for stripe `s` lands on disk `(n - 1 - (s mod n))`, asserted for 20 stripes |
| `raid4 bottleneck` | after 200 random writes, the RAID 4 parity disk's queue length exceeds every data disk's by at least 3x, while RAID 5's queues are within 25 percent of each other |
| `rebuild progress` | `raid.rebuild` fires with `progress` monotonically increasing from 0 toward 1 and never exceeding 1 |
| `rebuild rate` | rebuild advances `rebuildBlocksPerTick` blocks per tick |
| `pause rebuild` | `pauseRebuild()` halts progress and restores throughput; `resumeRebuild()` continues from the same progress |
| `failure not random` | 10,000 ticks of normal operation inject zero failures and consume zero `root/storage` draws for failure decisions |

### `tests/kernel/io/modes.test.ts`

| Fixture | Assertion |
|---|---|
| `IO-COST-1` | per acceptance criterion 13 |
| `IO-POLL-1` | per acceptance criterion 14 |
| `poll charged to process` | polling ticks increment the polling process's `totalCpuUsed` |
| `interrupt charged to kernel` | interrupt service ticks increment the kernel overhead counter and no process's `totalCpuUsed` |
| `interrupt requester cost` | the requesting process is charged exactly 1 tick |
| `dma cycle steal` | 0.1 of the transfer duration is charged to the currently running process, not to the requester |
| `dma one interrupt` | a 4096-byte DMA transfer produces exactly one `io.interrupt`, and word-by-word interrupt mode produces one per word |
| `io.dma_transfer` | the event carries the exact byte count |
| `mode side table` | switching a device to polling changes the live mode without mutating `Device.mode` |

### `tests/kernel/io/interrupts.test.ts`

| Fixture | Assertion |
|---|---|
| `IO-INT-1` | per acceptance criterion 15 |
| `nesting strict` | a candidate whose priority equals the in-service line's priority is deferred, not delivered |
| `non-maskable` | a non-maskable line is delivered even while a higher-priority line is in service and even when masked |
| `max per tick` | with 5 pending lines and `maxInterruptsPerTick` 2, exactly 2 are delivered per tick |
| `pending saturates` | `pending` stops at `maxPending` and does not wrap |
| `sorted candidates` | the candidate list order is `(priority, deviceId)` for 100 random line sets |
| `IO-STORM-1` | per acceptance criterion 16 |
| `storm stage 3` | at `4 * window` the generating process terminates with `io_timeout` |
| `storm stage 4` | `pending` reaching `maxPending` emits `kernel.panic` containing `'interrupt storm on'` |
| `storm recovery` | after masking, `totalPending` falls and throughput of other processes recovers |
| `utilisation falls` | during a storm, `cpuUtilisation` falls while no process's `totalCpuUsed` rises |
| `phase order` | an I/O completion in phase 2 unblocks its waiter on the **same** tick, not the next, proving interrupts run before phase 4 |

### `tests/kernel/io/buffering.test.ts`

| Fixture | Assertion |
|---|---|
| `IO-BUF-1` | per acceptance criterion 17 |
| `single serialises` | under `single`, producer and consumer never run in the same tick |
| `double no help when skewed` | with the producer 5x faster, double buffering improves throughput by less than 5 percent |
| `circular reuses bounded buffer` | the `circular` scheme imports WP-07's bounded buffer, verified by an import assertion in the test |
| `occupancy metric` | with a full buffer for 100 ticks, `bufferOccupancy` equals capacity |
| `stalls counted` | every tick the producer waits increments `bufferStalls` |
| `cache hit rate` | 80 hits and 20 misses give 0.8; zero accesses give 0, not `NaN` |
| `write_through` | every write reaches the disk in the same tick and `dirtyEntries()` stays empty |
| `write_back dirty` | writes mark entries dirty; `sync` flushes them; `dropDirty()` loses exactly those blocks |
| `IO-SPOOL-1` | per acceptance criterion 18 |
| `net0 stream` | packet loss decisions draw from `root/io` and from no other stream |

## Out of scope

- `src/kernel/fs/**` and `src/kernel/security/**`. WP-10 owns them. This package
  provides the block device they sit on and the `fs.corruption` emission for the
  spooling fixture only.
- `src/kernel/syscall/**`. WP-11 owns `ioctl` and every other syscall. This
  package owns each driver's `control` method and reports its command set.
- `src/kernel/scheduler/**`, `memory/**`, `sync/**`, `deadlock/**`,
  `invariants.ts`.
- Game-layer afflictions and Program names. Expose `stormState()` and
  `setCostMultiplier()` and stop.
- Any change to `Kernel.ts` beyond wiring phases 2 and 3 and implementing
  `setDiskPolicy`.
- Anything outside `src/kernel/storage/`, `src/kernel/io/`,
  `tests/kernel/storage/`, `tests/kernel/io/` and the two permitted edits.

## Report back

State:

1. Pass or fail for each of the twenty-three acceptance criteria, by number.
2. The three verification command outcomes.
3. The full ten-row `DISK-ALL-1` table your implementation produced, with paths
   and totals, next to the sim spec values.
4. The recorded `DISK-CSCAN-2` and `DISK-CLOOK-2` paths, since the sim spec gives
   totals but not paths for those two.
5. The complete `ioctl` command set each of the four drivers accepts, so WP-11
   can wire it without guessing.
6. Whether WP-06 had landed, and if so the exact signature of the
   `storage.enqueue` method you implemented for it.
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

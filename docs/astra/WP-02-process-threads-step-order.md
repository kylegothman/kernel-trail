# WP-02: Processes, threads and the kernel step order

## Objective

When this package is done the repository has a running `Kernel`: a process table
with real PCBs, the six-state process model with every legal transition and no
illegal one, `fork` with copy-on-write, `exec`, `exit`, `wait`, orphan adoption
by init, the idle process, both IPC mechanisms, the three threading models,
Amdahl's law applied to burst arithmetic, and `step()` executing all eleven
phases in the fixed order with the memory, sync, deadlock, storage, I/O, file
system and security phases stubbed behind named hooks that later packages fill
in. `createKernel(REFERENCE_CONFIG)` constructs, steps, and produces a
deterministic event log. This is the critical-path package: five wave-2 packages
block on it.

## Follow-ups after amendments 1 and 2

This package was implemented faithfully against the contract and the spec as they
stood, and both escalations it raised were correct: the snapshot had nowhere to
put subsystem state, and the burst arithmetic made over-threading nearly free.
Kyle approved both. `docs/07-CONTRACT-AMENDMENTS.md` is the record. Three things
in this document moved as a result, and they are follow-ups on a completed
package rather than defects in its report.

1. **The Amdahl arithmetic moves**, per amendment 2. Overhead is charged after
   the speedup division and scales with thread count:
   `effective = ceil( R / S(s, N) ) + O * N`.
   `src/kernel/process/threads.ts` currently charges overhead into `rawService`
   before the division, which is what §7 below and sim spec 4.3 used to say. It
   needs to move after. `amdahlSpeedup` itself does not change, so `AMDAHL-1`,
   `AMDAHL-1b`, `AMDAHL-1c` and `AMDAHL-3` keep their values and only `AMDAHL-2`
   is replaced.
2. **Aging lives on a separate `SchedulerHooks` object**, not on the frozen
   `SchedulerPolicy`. This document previously said to call
   `ageAndDetectStarvation(ctx)` on the policy, which has no such method. The
   implementation already does the right thing; phase 6 below is the text that
   was wrong.
3. **Transition T1 is construction plus a `process.created` event.** Generic
   `process.state_changed` events begin at T2. There is no null `from` on a
   `process.state_changed`, and none is being added.

The init-only snapshot guard this package ships is correct and stays. Its
`// TODO(astra): blocked on contract change, see report` marker is now WP-11's to
resolve, using the `completeness` field amendment 1 added.

## Prerequisites

WP-01 complete and green.

Files that must already exist:

- `src/kernel/types.ts` (frozen)
- `src/kernel/rng/Sfc32Rng.ts`, `src/kernel/rng/streams.ts`
- `src/kernel/EventBus.ts`, `src/kernel/errors.ts`
- `src/kernel/index.ts`
- `tests/kernel/canonical.ts`

## Required reading

- `02-KERNEL-SIM-SPEC.md` section 2 in full: 2.1 (the eleven phases), 2.2 (why
  this order and which orderings are wrong), 2.3 (the instruction stream)
- `02-KERNEL-SIM-SPEC.md` section 3 in full: 3.1 through 3.8
- `02-KERNEL-SIM-SPEC.md` section 4 in full: 4.1 through 4.4
- `02-KERNEL-SIM-SPEC.md` section 16.1 (reference configuration), 16.2
  (determinism fixtures), 16.4 (thread fixtures)
- `02-KERNEL-SIM-SPEC.md` section 17, items 3 and 5, for what "stubbed" means
  here
- `01-ARCHITECTURE.md` section 1.2 (why the kernel is headless) and 1.6 (the
  kernel barrel)

Read section 2.2 carefully. It names, phase by phase, the ordering mistakes that
produce plausible-looking but wrong Gantt charts.

## Files you will create

```
src/kernel/Kernel.ts
src/kernel/process/ProcessTable.ts
src/kernel/process/lifecycle.ts
src/kernel/process/Program.ts
src/kernel/process/threads.ts
src/kernel/process/amdahl.ts
src/kernel/process/ipc.ts
src/kernel/process/transitions.ts
src/kernel/config.ts
tests/kernel/fixtures/referenceConfig.ts
tests/kernel/process.test.ts
tests/kernel/threads.test.ts
tests/kernel/stepOrder.test.ts
```

## Files you may modify

```
src/kernel/index.ts          (add the createKernel export only)
tests/kernel/determinism.test.ts   (un-skip D1, D3 and D4 only; leave D2 skipped)
```

Nothing else.

## Frozen contracts

From `src/kernel/types.ts`. These may not be edited. If this package cannot be
completed without changing one, stop and report per the escalation procedure.

```ts
export type ProcessState =
  | 'new' | 'ready' | 'running' | 'waiting' | 'terminated'
  /** Exited but not yet reaped by its parent. Ch. 3.3.2. */
  | 'zombie';

export type TerminationReason =
  | 'normal_exit' | 'killed_by_user' | 'killed_by_parent' | 'starvation'
  | 'deadlock_victim' | 'out_of_memory' | 'thrashing_collapse'
  | 'protection_fault' | 'io_timeout' | 'storage_corruption';

export interface ProcessControlBlock {
  readonly pid: Pid;
  readonly parent: Pid | null;
  /** Display name. Convoy members use their Program name. */
  readonly name: string;
  state: ProcessState;
  /** Lower number is higher priority, matching Silberschatz Ch. 5.3.4. */
  priority: number;
  readonly basePriority: number;
  readonly arrivalTick: Tick;
  /** Ticks of CPU still required by the current burst. */
  cpuBurstRemaining: number;
  /** Full remaining service time across all bursts, for SJF/SRTF and metrics. */
  serviceRemaining: number;
  totalCpuUsed: number;
  /** Tick this process last entered the ready queue. Drives starvation detection. */
  readySince: Tick | null;
  lastScheduledTick: Tick | null;
  /** MLFQ level, or 0 for single-queue policies. */
  queueLevel: number;
  readonly addressSpaceId: AddressSpaceId;
  readonly threads: Tid[];
  openFiles: FileDescriptor[];
  heldResources: ResourceId[];
  /** Outstanding requests. Feeds the wait-for graph in Ch. 8. */
  requestedResources: ResourceId[];
  blockedOn: BlockReason | null;
  domain: DomainId;
  exitCode: number | null;
  terminationReason: TerminationReason | null;
  /** Set when this process IS a named convoy Program, so its death is narrative. */
  convoyMemberId: ConvoyMemberId | null;
}

export type BlockReason =
  | { kind: 'semaphore'; resource: ResourceId }
  | { kind: 'mutex'; resource: ResourceId }
  | { kind: 'condition'; monitor: ResourceId; condition: string }
  | { kind: 'io'; device: DeviceId }
  | { kind: 'page_fault'; page: PageId }
  | { kind: 'child_wait'; child: Pid | null }
  | { kind: 'sleep'; untilTick: Tick };

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
  /** Faults per thousand ticks above which thrashing begins. */
  readonly thrashingThreshold: number;
  readonly enabledSubsystems: readonly SubsystemId[];
}

export type SubsystemId =
  | 'process' | 'scheduler' | 'memory' | 'vm' | 'sync'
  | 'deadlock' | 'storage' | 'io' | 'fs' | 'security';

export interface Kernel {
  readonly config: Readonly<KernelConfig>;
  readonly tick: Tick;
  readonly events: KernelEventStream;

  step(): readonly KernelEvent[];
  /** Advance n ticks, returning the concatenated event log. */
  run(ticks: number): readonly KernelEvent[];

  syscall(request: SyscallRequest): SyscallResult;

  process(pid: Pid): Readonly<ProcessControlBlock> | undefined;
  readonly processes: readonly Readonly<ProcessControlBlock>[];

  /** Swap policies mid-run. This is a core player verb, not a debug hook. */
  setScheduler(id: SchedulerId, params?: Partial<SchedulerParams>): void;
  setReplacementPolicy(id: PageReplacementId): void;
  setDiskPolicy(id: DiskSchedulingId): void;
  setAllocationStrategy(s: AllocationStrategy): void;

  /** Ch. 8.6. Returns the trace whether or not the request is granted. */
  evaluateBankers(pid: Pid, resource: ResourceId, instances: number): SafetyCheckResult;
  detectDeadlock(): DeadlockReport | null;

  snapshot(): KernelSnapshot;
  restore(snapshot: KernelSnapshot): void;
}
```

Also frozen and used here: `Tick`, `Pid`, `Tid`, `AddressSpaceId`, `PageId`,
`FrameId`, `ResourceId`, `DeviceId`, `DomainId`, `FileDescriptor`,
`ConvoyMemberId`, `SyscallRequest`, `SyscallResult`, `Errno`, and the whole
`KernelEvent` union.

## Specification

### 1. `src/kernel/config.ts`

Extend-only configuration that is not in the frozen `KernelConfig`. The frozen
type cannot carry these, so they live in a separate object with defaults, passed
alongside.

```ts
export interface KernelTuning {
  readonly maxProcesses: number;              // 64
  readonly maxThreadsPerProcess: number;      // 16
  readonly threadCreateTicks: number;         // 2
  readonly cowCopyTicks: number;              // 1
  readonly contextSwitchTicks: number;        // 0, configurable up to 2
  readonly deadlockDetectionInterval: number; // 20
  readonly threadModel: ThreadModel;          // 'one_to_one'
  readonly coreCount: number;                 // 4
  readonly lwpPoolSize: number;               // equals coreCount by default
  readonly defaultSerialFraction: number;     // 0.25
  readonly degreeOfMultiprogramming: number;  // 8
  readonly checkInvariants: boolean;          // true in dev and test
}

export const DEFAULT_TUNING: KernelTuning;
export function createKernel(config: KernelConfig, tuning?: Partial<KernelTuning>): Kernel;
```

`createKernel` validates `config` and throws `KernelConfigError` on:
`totalFrames < 1`, `pageSize` not a positive power of two, `tlbEntries < 0`,
`totalCylinders < 1`, `schedulerParams.quantum < 1`, a `SchedulerId` that is not
in the frozen union, an `enabledSubsystems` entry that is not a `SubsystemId`.

Every tuning value must appear in the snapshot WP-11 builds, so keep them on the
kernel instance in one object rather than scattered as fields.

### 2. `src/kernel/process/ProcessTable.ts`

Per sim spec 3.1:

- A `Map<Pid, ProcessControlBlock>` plus a parallel `Pid[]` kept in ascending
  order. Several algorithms iterate processes and must do so in a fixed order.
- PID allocation is a monotonically increasing counter starting at 1. **PID 0 is
  reserved for the idle process. PIDs are never reused within a run.**
- `Kernel.processes` returns the ordered array, shallow-frozen, excluding pid 0.
- The ordered array is maintained by insertion, not by re-sorting. Since pids
  ascend, a new pid always appends.

Provide `forEachAscending(fn)` and `filterAscending(pred)` helpers, and use them
everywhere a subsystem needs to iterate. Never iterate the `Map` directly.

Field semantics that are not obvious, per sim spec 3.1:

- `priority` is mutable and is what the scheduler reads. `basePriority` is what
  `priority` resets to whenever the process is dispatched. Aging requires the
  reset, otherwise a single promotion is permanent.
- `cpuBurstRemaining` is the current burst; `serviceRemaining` is total work
  left. SJF and SRTF read `serviceRemaining` in this simulator.
- `readySince` is `null` whenever the process is not in state `ready`. Whichever
  phase moved the process into `ready` sets it.
- `queueLevel` is 0 for every policy except MLFQ.

Keep the un-accelerated figures `rawBurstRemaining` and `rawServiceRemaining`
in a side table `Map<Pid, { rawBurst: number; rawService: number; serialFraction: number }>`.
They are not fields on the frozen PCB and must not be added to it.

### 3. `src/kernel/process/transitions.ts`

Implement the state transition table from sim spec 3.3 as a single function:

```ts
export function transition(
  pcb: ProcessControlBlock,
  to: ProcessState,
  ctx: TransitionContext,
): void;
```

The legal edges are exactly T1 through T11 in sim spec 3.3. Build a frozen
`Set<string>` of `` `${from}->${to}` `` keys from that table. Any other edge
throws `KernelInvariantError(11, ...)`.

Two edges that look plausible and are illegal, per the spec: `waiting -> running`
directly (a woken process always passes through `ready`, otherwise every I/O
completion becomes an implicit priority boost) and `zombie -> ready` (a zombie is
a record; `kill` on a zombie returns `ESRCH`).

Every transition from T2 onwards emits `process.state_changed` with the exact
`from` and `to`, in addition to whatever specific event the triggering site
emits. The world layer draws the specific event; the HUD counts the generic one.

T1 is the exception, and deliberately so. T1 is construction: the PCB comes into
existence in state `new` and emits `process.created`. It emits no
`process.state_changed`, because there is no prior state to report. A
`process.state_changed` never carries a null `from`, and nothing in this package
or a later one adds one.

Side effects per edge, taken from the table:

- T1, construction into `new`: emit `process.created`. No
  `process.state_changed`.
- T2 `new -> ready`: `readySince = tick`, call `onAdmit`. This is the first
  generic `process.state_changed` a process produces.
- T3 `ready -> running`: `readySince = null`, `lastScheduledTick = tick`,
  `priority = basePriority`, `sliceElapsed = 0`.
- T4 `running -> ready`: `readySince = tick`, append to the tail of its queue; on
  quantum expiry also emit `quantum.expired`.
- T5 `running -> waiting`: set `blockedOn`, call `onBlock`.
- T6 `waiting -> ready`: `blockedOn = null`, `readySince = tick`, call
  `onUnblock`.
- T7/T8/T9 into `zombie`: run the exit procedure in section 5 below.
- T10 `zombie -> terminated`: the PCB retains only pid, name, exitCode and
  parent as meaningful; emit `process.reaped`.

The same-state emission is real and required: sim spec 3.6 has re-parenting emit
`process.state_changed` with identical `from` and `to`, which the world layer
treats as a re-parent hint. Allow `from === to` for that one case only, gated by
an explicit `reason: 'reparent'` argument, so it cannot happen by accident.

### 4. `src/kernel/process/Program.ts`

The instruction stream from sim spec 2.3.

```ts
export type Instruction =
  | { kind: 'compute' }
  | { kind: 'access'; page: PageId; write: boolean }
  | { kind: 'syscall'; call: SyscallRequest }
  | { kind: 'io'; device: DeviceId }
  | { kind: 'acquire'; resource: ResourceId }
  | { kind: 'release'; resource: ResourceId }
  | { kind: 'thread_create' }
  | { kind: 'thread_join'; tid: Tid };

export interface Program {
  /** Peek the instruction to be executed at the given point. Pure. */
  at(index: number): Instruction;
  readonly length: number;
  /** Non-null only in scripted teaching scenarios. */
  readonly referenceString: readonly PageId[] | null;
}
```

`at(index)` must be pure and must be safe for any non-negative index; index past
`length` returns `{ kind: 'compute' }`.

Two constructors:

- `scriptedProgram(referenceString, serviceTicks)` turns a
  `ProcessSpec.referenceString` into `access` instructions padded with `compute`
  to reach `service` ticks. `referenceString` is retained so
  `MemoryContext.futureReferences` can be populated.
- `generatedProgram(rng, spec)` for a spec with no reference string. Generate
  from the `root/process` stream. Use a simple locality model: pick a working set
  of `ceil(spec.pages * 0.4)` pages, emit 85% of accesses inside it and 15%
  outside, and re-roll the working set every 40 instructions. WP-06 replaces this
  with the full locality model of sim spec 7.7; leave
  `// TODO(astra): replace with the sim spec 7.7 locality model in WP-06` above
  it. `referenceString` is `null` for a generated program.

`MemoryContext.futureReferences` is non-null only when **every** runnable process
has a scripted `referenceString`. Expose that as a kernel method
`allProgramsScripted(): boolean` for WP-06 to consume.

### 5. `src/kernel/process/lifecycle.ts`

`fork`, `exec`, `exit`, `wait`, orphan adoption, the idle process.

**`fork()`** follows sim spec 3.4 steps 1 through 7 exactly. In particular:

- Step 1: `EAGAIN` when the table already holds `maxProcesses` entries.
- Step 4 substitutions in full, including `name = parent.name + "'"`,
  `state = 'new'`, `arrivalTick = tick`, `queueLevel = 0`,
  `threads = [newTid()]` (only the calling thread is duplicated, Ch. 4.4.1),
  `heldResources = []`, `requestedResources = []`, `blockedOn = null`,
  `openFiles` copied by value with each referenced inode's descriptor count
  incremented, `domain` inherited from the parent.
- Step 5, **copy-on-write**: for every valid page table entry in the parent,
  create a child entry pointing at the *same* `FrameId`, set `writable = false`
  in both entries, and increment a `cowRefCount` held in a side table
  `Map<FrameId, number>`. No frame is copied. No `memory.allocated` is emitted at
  fork time.
- Step 7: the parent gets the child pid; the child's own return value is 0,
  delivered the first time the child is dispatched.

WP-02 owns `cowRefCount` and the COW fault resolution procedure, because
`fork` is the only thing that creates COW pages. The five-step resolution
procedure is in sim spec 3.4 under "COW fault resolution". WP-05 provides frame
allocation, so until WP-05 lands, call a hook
`this.memory.allocateFrame()` that WP-05 implements and that this package stubs
to return `null` with `// TODO(astra): WP-05 provides the frame table`. Emit
`memory.page_fault { major: false }` then `memory.page_loaded`; a COW fault is
always a minor fault because it never touches the backing store.

**`exec(programName)`** follows sim spec 3.5 steps 1 through 6. The PID does not
change. Descriptors survive `exec` unless marked close-on-exec. Faults for the
new program's pages happen lazily on first touch, so `exec` is followed by a
burst of major faults, and that burst is the visible cost.

**`exit(code)`** follows sim spec 3.5 steps 1 through 9. Note step 7: **the PCB
is not destroyed**. `pid`, `name`, `exitCode`, `terminationReason` and `parent`
remain readable so the parent can collect them.

**`wait(pid?)`** follows sim spec 3.5 steps 1 through 5. Note step 2: `ECHILD`
is not in the frozen `Errno` union, so return `ESRCH` with the message
`"no children"`. Record that substitution in a comment naming sim spec 14.

Zombie accumulation is the Leg 1 failure mode and it must work: a parent that
forks in a loop and never waits leaves one zombie per child; zombies occupy
process table slots but no frames, so the table fills and `fork` starts returning
`EAGAIN`.

**Orphans and adoption**, sim spec 3.6:

- The kernel creates PID 1, named `init`, during construction, before any leg
  process. Its program is a single `compute` instruction repeated forever, at the
  lowest priority.
- On exit, for every child of the exiting process: a `zombie` child is reparented
  to PID 1 and immediately reaped in the same phase, emitting `process.reaped`
  with `by: 1`; any other child is reparented with `parent = 1` and emits the
  same-state `process.state_changed`.
- `parent` is `readonly` on the frozen PCB, so reparenting cannot assign it
  directly. Hold the parent link in a mutable side table
  `Map<Pid, Pid | null>` that is the authority, seed it from `pcb.parent` at
  creation, and have every reader use the side table. Note this clearly in a
  comment: it is a consequence of the frozen contract and it is deliberate.
  Do not add a field to the PCB and do not cast away `readonly`.
- If the exiting process is PID 1, emit `kernel.panic` with the message
  `"init exited"`, and the leg ends.

**The idle process**, sim spec 3.7: PID 0, named `idle`, state permanently
`ready`, priority `Number.MAX_SAFE_INTEGER`, `serviceRemaining = Infinity`. It is
**not** in the scheduler's ready queue and is **not** returned by
`Kernel.processes`. A `SchedulingDecision` of `{ next: null }` means idle; the
scheduler never returns pid 0. `serviceRemaining = Infinity` means the canonical
serialiser will reject it, so pid 0 must be excluded from the snapshot as well as
from `processes`; write a test for that.

### 6. `src/kernel/process/ipc.ts`

Both mechanisms from sim spec 3.8.

**Shared memory.** `SharedRegion` exactly as declared in 3.8. `mmap(regionId)`
attaches: the caller's page table gains entries pointing at the region's frames,
with `writable` taken from the caller's rights in its protection domain.
`munmap` detaches. Frames belonging to a shared region are `pinned` while any
process is attached, so replacement cannot evict them out from under a reader.
`SharedRegion.value` is the single integer the race detector in WP-07 watches.

**Message passing.** `Mailbox` and `Message` exactly as declared in 3.8.

- `capacity === 0` is a rendezvous: `send` blocks until a matching `receive`
  arrives, and vice versa.
- `capacity > 0` is bounded: `send` blocks only when full, `receive` blocks only
  when empty.
- Unbounded capacity is not modelled.
- Blocking sends and receives use `BlockReason` of kind `semaphore` with a
  synthetic `ResourceId` of `mbox:<id>:send` or `mbox:<id>:recv`, so the wait-for
  graph in WP-08 sees message-passing deadlocks. A rendezvous pair that each send
  first is a real deadlock and the wait-for graph must draw it.

### 7. `src/kernel/process/threads.ts` and `amdahl.ts`

`ThreadControlBlock` and `ThreadState` exactly as declared in sim spec 4.1.
Threads live in a side map keyed by `Tid`; `ProcessControlBlock.threads` is the
`Tid[]` the frozen type already provides. Threads share `addressSpaceId`,
`openFiles` and `domain` with their process and have private `programCounter` and
`serviceRemaining`.

**The CPU scheduler schedules processes, not threads.** Within a dispatched
process, the tick is delivered to threads by the thread model. This keeps every
scheduling fixture in sim spec 5 valid regardless of threading.

The three models, from sim spec 4.2:

- `many_to_one`: `lwp` is `null` for every thread. The process's tick goes to the
  first thread in `threads` order whose state is `ready`, and that thread runs
  until it blocks or finishes. **A blocking call by any thread blocks the whole
  process**: the PCB goes to `waiting` and no other thread of that process runs.
  `effectiveCores = 1` regardless of `coreCount`.
- `one_to_one`: `lwp === tid`. A blocking call blocks only the calling thread;
  the PCB stays `ready` as long as at least one thread is `ready`. Speedup up to
  `min(threads.length, coreCount)`. Each thread creation charges
  `threadCreateTicks` to the creating process and the kernel enforces
  `maxThreadsPerProcess`, returning `EAGAIN` beyond it.
- `many_to_many`: `m = min(threads.length, lwpPoolSize)`. `lwp` is assigned
  round-robin over `[0, m)` **in ascending `tid` order** whenever the thread set
  changes, and that reassignment must be a pure function of the sorted tid list
  so a snapshot restore reproduces it. A blocking call blocks one LWP; threads
  sharing that LWP stall, threads on other LWPs continue. A pre-set
  `ThreadControlBlock.lwp` is honoured rather than reassigned, which is the
  two-level model of Ch. 4.3.3.

`amdahl.ts` implements sim spec 4.3 exactly:

```ts
export function amdahlSpeedup(serialFraction: number, cores: number): number {
  if (!(serialFraction >= 0 && serialFraction <= 1)) throw new RangeError('S out of range');
  if (!Number.isInteger(cores) || cores < 1) throw new RangeError('cores must be a positive integer');
  if (serialFraction === 1) return 1;
  return 1 / (serialFraction + (1 - serialFraction) / cores);
}

export function usableCores(threadsRunnable: number, cfg: ThreadConfig): number {
  switch (cfg.model) {
    case 'many_to_one':  return 1;
    case 'one_to_one':   return Math.min(threadsRunnable, cfg.coreCount);
    case 'many_to_many': return Math.min(threadsRunnable, cfg.lwpPoolSize, cfg.coreCount);
  }
}
```

Speedup is applied at **burst admission only**, never continuously, so
`cpuBurstRemaining` stays an integer and the Gantt charts stay legible. The
seven-step recomputation procedure in sim spec 4.3 runs at admission, after each
unblock, and after any `thread.created` or `thread.joined` event.

The overhead ordering is the correction from amendment 2. Charge
`threadCreateTicks` **after** the division, scaled by `N`:

```
effective = ceil( R / S(s, N) ) + O * N
```

so `pcb.cpuBurstRemaining = Math.max(1, Math.ceil(raw / sp) + O * N)`, and
`serviceRemaining` the same way from `rawServiceRemaining`. Charging it into
`rawService` before the division, which is what this document used to say, let
the division accelerate the coordination cost along with the work and made
over-threading nearly free. The rounding step is `Math.ceil`, not `Math.round`,
because `R / S` at `N = 2` is an exact half (66.5 for `R = 100, s = 0.25`) and a
half-way tie rounds differently across implementations. It runs once per
recomputation rather than per tick, which is what makes it stable under snapshot
and restore.

Thread creation and joining are not in the frozen `SyscallName` union, so they
are driven by `Instruction` variants, per sim spec 4.4. A process whose `threads`
array becomes empty exits with code 0.

### 8. `src/kernel/Kernel.ts`

`step()` performs exactly the eleven phases of sim spec 2.1, in that order, every
tick, with no early return. A phase with nothing to do is a no-op; a disabled
subsystem's phase is skipped whole.

```ts
step(): readonly KernelEvent[] {
  this.bus.beginFrame();
  this.currentTick = (this.currentTick + 1) as Tick;

  this.phase01_expireTimers();
  this.phase02_serviceDeviceCompletions();
  this.phase03_deliverInterrupts();
  this.phase04_resolveBlockedProcesses();
  this.phase05_admitNewProcesses();
  this.phase06_ageAndDetectStarvation();
  this.phase07_scheduleDecision();
  this.phase08_executeOneTick();
  this.phase09_detectDeadlock();
  this.phase10_updateMetrics();
  this.phase11_checkInvariants();

  return this.bus.stream.lastFrame;
}
```

This package implements phases 1, 4, 5, 7, 8, 10 and 11 in the reduced form
described below, and leaves 2, 3, 6 and 9 as named hooks.

**Phase 1, expire timers.** Advance every countdown keyed on absolute tick:
`sleep` blocks whose `untilTick <= tick`, and the starvation clocks. Processes
whose sleep expired are marked *wakeable* but are **not moved yet**; phase 4 does
the moving. This split keeps every ready-queue insertion in one place. Leave the
monitor condition timeouts, RAID rebuild progress, journal checkpoint interval
and TLB shootdown counter as hook calls into empty subsystem objects, each with
its own `// TODO(astra): WP-NN fills this` marker naming the owning package.

**Phase 2 and phase 3.** Call `this.io.serviceCompletions(tick)` and
`this.io.deliverInterrupts(tick)` on a subsystem object whose default
implementation is a no-op. WP-09 replaces it. Do not stub them as throwing:
these run every tick and must be cheap no-ops when the `io` subsystem is not
enabled.

**Phase 4, resolve blocked processes.** Every process in state `waiting` is
re-tested against its `blockedOn` condition, **in ascending pid order**. A
process whose condition is satisfied moves `waiting -> ready`, has `blockedOn`
cleared, `readySince` set to the current tick, and is appended to the scheduler's
queue via `SchedulerPolicy.onUnblock`. Wakes from a `SyncPrimitive` with
`ordered: true` are taken from the head of `waitQueue` only, so bounded waiting
is preserved. In this package, implement the `sleep` and `child_wait` conditions
fully; delegate `semaphore`, `mutex`, `condition` to `this.sync.isSatisfied(...)`,
`io` to `this.io.isSatisfied(...)` and `page_fault` to
`this.memory.isSatisfied(...)`, each defaulting to `false`.

**Phase 5, admit new processes.** Processes in state `new` whose
`arrivalTick <= tick` are admitted subject to the degree of multiprogramming.
Admission calls `SchedulerPolicy.onAdmit`, allocates the address space, and moves
`new -> ready`. Iterate candidates in ascending pid order. Recompute the burst
per sim spec 4.3 at admission.

**Phase 6, age and detect starvation.** WP-03 owns this. Aging is **not** a
method on the frozen `SchedulerPolicy`; it lives on a separate `SchedulerHooks`
object that the kernel holds alongside the policy. Call
`ageAndDetectStarvation(ctx)` on the hooks object; provide a default that does
nothing. Earlier text here said to call it on the policy, which has no such
method.

**Phase 7, scheduler decision.** Build a `SchedulerContext` over the current
state and call `SchedulerPolicy.onTick`. Apply the returned decision: if `next`
differs from the currently running process, the outgoing process moves
`running -> ready` (or stays `waiting`/`zombie` if it left the CPU for another
reason), the incoming moves `ready -> running`, `lastScheduledTick` is set,
`contextSwitches` increments, and `context.switch` is emitted with the policy's
`rationale`. A context switch costs `contextSwitchTicks`, default 0 for teaching
clarity, configurable up to 2; when nonzero the cost is charged as idle ticks
before phase 8 runs.

Until WP-03 lands, ship a minimal internal FCFS so the kernel runs. Put it at
`src/kernel/Kernel.ts` as a private class named `BootstrapFcfs`, mark it
`// TODO(astra): replaced by the scheduler registry in WP-03`, and delete it in
WP-03. Do not put it in `src/kernel/scheduler/`, which WP-03 owns.

**Phase 8, execute one tick of the running process.** Exactly one unit of CPU
service is delivered unless the CPU is idle. What that unit does depends on the
head of the running process's instruction stream. In all three cases
`totalCpuUsed` increments and `cpuBurstRemaining` decrements. A syscall or a page
fault may move the process out of `running` inside this phase, which is legal and
is the only place a process leaves `running` other than phase 7.

Dispatch by instruction kind:

- `compute`: nothing beyond the counters.
- `access`: call `this.memory.access(pid, page, write)`, defaulting to a no-op
  that returns `{ hit: true }`.
- `syscall`: call `this.syscall(request)`. In this package implement only
  `fork`, `exec`, `exit`, `wait`, `kill`, `getpid` and `nice`; every other
  `SyscallName` returns `{ ok: false, errno: 'EINVAL', message: 'not implemented in WP-02' }`
  behind a `// TODO(astra): WP-11 completes the syscall table`.
- `io`, `acquire`, `release`: hook calls into the no-op subsystems.
- `thread_create`, `thread_join`: implemented here per section 7.

Every syscall emits `syscall.invoked` carrying the request and the result.

**Phase 9, deadlock detection.** WP-08 owns this. Call
`this.deadlock.maybeDetect(tick)` and provide a no-op default. Honour the gating
rule now so WP-08 does not have to change `Kernel.ts`: it runs only when
`config.deadlockStrategy === 'detect'` and only when
`tick % tuning.deadlockDetectionInterval === 0`.

**Phase 10, update metrics.** Recompute `SchedulingMetrics` and `MemoryMetrics`
**from scratch** off PCB and frame state. Never accumulate a float. This package
computes the scheduling metrics that do not need the scheduler's private state
(`cpuUtilisation`, `contextSwitches`, `throughput`, `worstWait`) and returns
zeros for the memory metrics, marked `// TODO(astra): WP-05 and WP-06`.

**Phase 11, check invariants.** Guarded by `tuning.checkInvariants`. Call
`this.invariants.check(this)` on an object whose default implementation checks
only the transitions already implemented here: I-2 (at most one process in state
`running`), I-11 (every observed transition is in the legal set), I-12
(`readySince` is non-null exactly when state is `ready`), I-14 (a process
admitted this tick has `waited === 0`) and I-7 (`threads` is non-empty for every
process in `ready`, `running` or `waiting`). WP-11 replaces the object with the
full set.

`run(ticks)` calls `step()` that many times and returns the concatenation. It
must copy each frame, because `lastFrame` is reused.

**Every other `Kernel` method** that this package does not implement must exist
with the exact frozen signature and throw
`new Error('not implemented: <name>')` above a
`// TODO(astra): WP-NN implements this` naming the owning package:
`setReplacementPolicy` and `setAllocationStrategy` (WP-05/WP-06),
`setDiskPolicy` (WP-09), `evaluateBankers` and `detectDeadlock` (WP-08),
`snapshot` and `restore` (WP-11). `setScheduler` is implemented here as far as
swapping the bootstrap policy, and WP-03 completes it.

`Kernel.processes` returns a shallow-frozen ascending array excluding pid 0.
`Kernel.process(pid)` returns the live PCB object, which callers must treat as
read-only; the frozen type says `Readonly<ProcessControlBlock>` and that is
enough. Do not deep-freeze per call: it would allocate every tick.

### 9. `tests/kernel/fixtures/referenceConfig.ts`

Export `REFERENCE_CONFIG` exactly as printed in sim spec 16.1, with no edits:

```ts
export const REFERENCE_CONFIG: KernelConfig = {
  seed: 0x4b54524c,
  scheduler: 'rr',
  schedulerParams: {
    quantum: 4,
    levelQuanta: [4, 8, 16],
    agingInterval: 50,
    starvationThreshold: 120,
    starvationFatalThreshold: 300,
    preemptive: true,
  },
  totalFrames: 64,
  pageSize: 4096,
  replacementPolicy: 'lru',
  allocationStrategy: 'first_fit',
  tlbEntries: 16,
  diskPolicy: 'look',
  totalCylinders: 200,
  raidLevel: 5,
  fileAllocation: 'indexed',
  journalingEnabled: true,
  deadlockStrategy: 'detect',
  thrashingThreshold: 200,
  enabledSubsystems: ['process','scheduler','memory','vm','sync','deadlock','storage','io','fs','security'],
};
```

Also export a `spawn(kernel, spec)` test helper that creates a process from a
`ProcessSpec`-shaped object, since `LegSetupContext` is a game-layer type this
package must not import.

## Acceptance criteria

1. `npm run typecheck` exits 0.
2. `npm run test` exits 0.
3. `npm run build` exits 0.
4. `createKernel(REFERENCE_CONFIG).run(5000)` completes without throwing.
5. Determinism fixture `DET-D1` passes: two kernels from `REFERENCE_CONFIG`
   stepped 5000 ticks produce identical `canonical()` event logs. Un-skip it in
   `tests/kernel/determinism.test.ts`.
6. Determinism fixture `DET-D3` passes: a config with `io` removed from
   `enabledSubsystems` produces an identical `context.switch` sequence, with
   `seq` stripped, for a workload that issues no I/O. Un-skip it.
7. Determinism fixture `DET-D4` passes: seeds 0 to 63, 1000 ticks each, run
   twice, identical hashes. Un-skip it.
8. `DET-D2` remains skipped with its existing `// TODO(astra):` naming WP-11.
9. Thread fixtures `AMDAHL-1`, `AMDAHL-1b`, `AMDAHL-1c`, `AMDAHL-2`, `AMDAHL-3`,
   `THREAD-M1`, `THREAD-11` and `THREAD-MM` all pass with the numeric values in
   sim spec 16.4.
10. Every illegal transition throws `KernelInvariantError` with
    `invariant === 11`. Verified for `waiting -> running` and `zombie -> ready`
    specifically.
11. The eleven phases execute in the documented order every tick. Verified by a
    test that installs a probe on each phase hook and asserts the recorded order
    string equals `'1,2,3,4,5,6,7,8,9,10,11'` for 100 consecutive ticks.
12. `Kernel.processes` never contains pid 0, and `canonical(kernel.processes)`
    never throws on a non-finite number.
13. The forbidden-identifier scan from WP-01 still returns zero matches over the
    files this package added.
14. `git diff --exit-code src/kernel/types.ts src/game/types.ts` exits 0.
15. Every unimplemented `Kernel` method throws with a message starting
    `not implemented:` and carries a `// TODO(astra):` naming its owning package.
    Verified by a test that calls each one and asserts the throw.

## Tests you must write

### `tests/kernel/process.test.ts`

| Case | Assertion |
|---|---|
| `pid allocation` | first spawned process is pid 2 (0 is idle, 1 is init); pids never repeat across 200 spawns and 200 exits |
| `init exists` | `kernel.process(asPid(1))?.name === 'init'` |
| `idle hidden` | `kernel.processes.every(p => p.pid !== 0)`; `kernel.process(asPid(0))` returns the idle PCB |
| `transition legality` | for each of T1..T11 the edge succeeds; `waiting -> running` throws `KernelInvariantError` with `invariant === 11`; `zombie -> ready` throws the same |
| `state_changed on every edge` | each successful transition from T2 onwards emits exactly one `process.state_changed` with matching `from`/`to`; T1 emits `process.created` and no `process.state_changed`, and no emitted `process.state_changed` anywhere in the run has a null `from` |
| `fork copies fields` | child has `parent === parentPid`, `state === 'new'`, `arrivalTick === tick`, `totalCpuUsed === 0`, `queueLevel === 0`, exactly one tid, empty `heldResources` and `requestedResources`, `blockedOn === null`, `domain` equal to the parent's |
| `fork name` | child `name` equals parent name plus a single apostrophe |
| `fork COW` | after fork, every parent PTE and every child PTE has `writable === false` and points at the same `FrameId`; `cowRefCount` is 2 for each; zero `memory.allocated` events fire during the fork |
| `fork EAGAIN` | forking past `maxProcesses` returns `{ ok: false, errno: 'EAGAIN' }` |
| `COW fault is minor` (`VM-COW-1`) | child writes one shared page: exactly one `memory.page_fault` with `major: false`, exactly one `memory.page_loaded`, zero `memory.page_evicted`; `cowRefCount` drops from 2 to 1 and the surviving PTE regains `writable === true` |
| `exit releases` | after exit, `heldResources` is empty, the process is absent from every `waitQueue`, every open descriptor is closed, and the PCB is in state `zombie` with `pid`, `name`, `exitCode` and `parent` still readable |
| `wait reaps lowest pid` | with three zombie children, `wait()` reaps the lowest pid first and returns its exit code; state becomes `terminated`; `process.reaped` is emitted |
| `wait blocks` | `wait()` with a live unreaped child blocks the caller with `blockedOn.kind === 'child_wait'` |
| `wait no children` | `wait()` with no children returns `{ ok: false, errno: 'ESRCH', message: 'no children' }` |
| `zombie accumulation` | a parent forking in a loop with no `wait` fills the table and `fork` begins returning `EAGAIN`; the count of processes in state `zombie` equals the number of forks that completed |
| `orphan adoption` | a parent exits with two live children; both children's effective parent becomes pid 1 and each emits a same-state `process.state_changed` |
| `orphan zombie reaped by init` | a parent exits with a zombie child; the child is reaped in the same phase and `process.reaped` carries `by: 1` |
| `init exit panics` | terminating pid 1 emits `kernel.panic` with message `'init exited'` |
| `exec keeps pid` | after `exec`, the pid, parent, priority, basePriority, domain and openFiles are unchanged and `queueLevel === 0` |
| `exec ENOENT` | `exec` of an unknown program name returns `ENOENT` |
| `mailbox rendezvous` | capacity 0: `send` blocks until a `receive` arrives, and the block reason is `{ kind: 'semaphore', resource: 'mbox:<id>:send' }` |
| `mailbox bounded` | capacity 3: four sends with no receives leave the fourth sender blocked and the queue length at 3 |
| `shared region pinned` | frames of an attached shared region have `pinned === true`; after the last `munmap` they do not |

### `tests/kernel/threads.test.ts`

| Fixture | Assertion |
|---|---|
| `AMDAHL-1` | `amdahlSpeedup(0.25, N)` for N = 1, 2, 4, 8, 16, 32 equals 1.0000, 1.6000, 2.2857, 2.9091, 3.3684, 3.6571 within 1e-4 |
| `AMDAHL-1b` | `amdahlSpeedup(0.10, N)` same N equals 1.0000, 1.8182, 3.0769, 4.7059, 6.4000, 7.8049 within 1e-4 |
| `AMDAHL-1c` | `amdahlSpeedup(0.50, N)` same N equals 1.0000, 1.3333, 1.6000, 1.7778, 1.8824, 1.9394 within 1e-4 |
| `AMDAHL-2` | raw burst 100 with s = 0.25 and O = 2 gives effective bursts 102, 67, 52, 51, 62, 92 for N = 1, 2, 4, 8, 16, 32, as exact integers, from `ceil(R / S(s, N)) + O * N` |
| `AMDAHL-3` | `amdahlSpeedup(1.0, 1024)` returns exactly 1 |
| `amdahl guards` | `amdahlSpeedup(-0.1, 4)` throws `RangeError`; `amdahlSpeedup(0.5, 0)` throws; `amdahlSpeedup(0.5, 2.5)` throws |
| `THREAD-M1` | many-to-one, 4 threads, one blocks: the whole PCB moves to `waiting` and zero ticks are delivered to the other three |
| `THREAD-11` | one-to-one, 4 threads, `coreCount` 4, one blocks: the PCB stays `ready` and `usableCores` drops from 4 to 3 |
| `THREAD-MM` | many-to-many, 8 threads, `lwpPoolSize` 4, `coreCount` 4: `usableCores` is 4 and lwp assignment is round-robin over ascending tid, so tids sorted ascending map to lwp 0,1,2,3,0,1,2,3 |
| `thread cap` | creating a 17th thread with `maxThreadsPerProcess` 16 returns `EAGAIN` |
| `thread create cost` | creating a thread leaves `rawServiceRemaining` unchanged and adds exactly `threadCreateTicks * N` to the recomputed `serviceRemaining`, after the speedup division |
| `over-threading is a hazard` | effective ticks at N = 32 exceed effective ticks at N = 4 for raw 100, s = 0.25, O = 2, so spawning past the optimum costs the player something |
| `empty threads exits` | joining the last thread exits the process with code 0 |
| `lwp assignment is pure` | assigning lwps twice over the same sorted tid list produces identical results |

### `tests/kernel/stepOrder.test.ts`

| Case | Assertion |
|---|---|
| `phase order` | 100 ticks with a probe on each phase produce the order string `'1,2,3,4,5,6,7,8,9,10,11'` every tick |
| `tick monotonic` | `kernel.tick` increases by exactly 1 per `step()` and starts at 0 |
| `beginFrame clears` | `lastFrame` reflects only the most recent step |
| `seq never resets` | `seq` across 500 ticks is strictly increasing with no repeats |
| `sleep wakes in phase 4` | a process with `blockedOn: { kind: 'sleep', untilTick: t }` is still `waiting` at the end of tick `t - 1` and is `ready` at the end of tick `t`, having been marked wakeable in phase 1 and moved in phase 4 |
| `unblock before admit` | a process unblocking this tick enters the ready queue ahead of a process admitted the same tick, under the bootstrap FCFS |
| `run copies frames` | `run(3)` returns 3 frames' worth of events and mutating the returned array does not affect `lastFrame` |
| `unimplemented methods throw` | each of `setReplacementPolicy`, `setAllocationStrategy`, `setDiskPolicy`, `evaluateBankers`, `detectDeadlock`, `snapshot`, `restore` throws a message starting `'not implemented:'` |

## Out of scope

Do not create, modify or stub the implementation of any of these. Other packages
own them.

- `src/kernel/scheduler/**` (WP-03, WP-04). The bootstrap FCFS lives inside
  `Kernel.ts` and is deleted by WP-03.
- `src/kernel/memory/**` (WP-05, WP-06). Provide the hook interface only.
- `src/kernel/sync/**` (WP-07), `src/kernel/deadlock/**` (WP-08),
  `src/kernel/storage/**` and `src/kernel/io/**` (WP-09),
  `src/kernel/fs/**` and `src/kernel/security/**` (WP-10),
  `src/kernel/syscall/**` and `src/kernel/invariants.ts` (WP-11).
- Anything outside `src/kernel/` and `tests/kernel/`.
- `src/kernel/types.ts` and `src/game/types.ts`, frozen.

Define each subsystem hook as a small interface in `Kernel.ts` with a no-op
default implementation, so the owning package can supply a real one without
editing the eleven-phase body. Name each interface after its package, for example
`MemoryHooks`, `SyncHooks`, `IoHooks`.

## Report back

State:

1. Pass or fail for each of the fifteen acceptance criteria, by number.
2. The three verification command outcomes.
3. The exact list of subsystem hook interfaces you defined, with their methods,
   so wave-2 packages know what to implement.
4. Every `// TODO(astra):` left in the tree, with file, line and the package
   named as owner.
5. Confirmation that the parent link is held in a side table rather than on the
   PCB, and where that table lives.
6. Whether any fixture in sim spec 16.4 disagreed with your implementation, and
   by how much.

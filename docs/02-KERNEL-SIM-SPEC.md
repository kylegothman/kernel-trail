# KERNEL TRAIL: Kernel Simulator Specification

**Document 02. Version 1.0.**

Subordinate to `docs/00-DESIGN-BRIEF.md`, which wins on any conflict. Bound by
`src/kernel/types.ts` and `src/game/types.ts`, which are frozen contracts: this
document explains how to implement those types and never redefines them.

Curriculum reference throughout: Silberschatz, Galvin and Gagne, *Operating
System Concepts*, 10th edition. Citations are given as `Ch. N.M`.

---

## 0. How to read this document

The simulator is a discrete-event operating system model. It has no renderer, no
DOM, no clock and no I/O. It is a state machine advanced by `step()`, and every
observable thing it does leaves a `KernelEvent`. Every minigame in KERNEL TRAIL
is a camera pointed at this one model, so a behaviour specified here is
authoritative for all fourteen legs.

Three rules govern the implementation and are enforced by tests:

1. `src/kernel` imports nothing from `three`, the DOM, `src/game`, `src/world`,
   `src/render`, `src/ui` or `src/audio`.
2. `src/kernel` never calls `Math.random`, `Date.now`, `performance.now`,
   `crypto.getRandomValues`, `Object.keys` order-dependent iteration over
   objects with dynamic keys, or `Array.prototype.sort` without an explicit
   total-order comparator.
3. Two kernels built from the same `KernelConfig` and stepped the same number of
   ticks produce byte-identical event logs and byte-identical snapshots.

Where this document gives a worked example with numbers, those numbers are the
assertion in a unit test. Section 16 collects all of them into one table.

File layout inside `src/kernel`:

```
src/kernel/
  types.ts              frozen contract, do not edit
  Rng.ts                sfc32, seeding, fork, save/restore
  Kernel.ts             step() orchestration, event bus, snapshot/restore
  EventBus.ts           KernelEventStream implementation, seq allocation
  process/              PCB table, fork/exec/exit/wait, threads, IPC
  scheduler/            one file per SchedulerId + SchedulerRegistry
  memory/               frame table, allocators, page tables, TLB
  vm/                   demand paging, one file per PageReplacementId
  sync/                 mutex, semaphore, monitor, rwlock, barrier, race detector
  deadlock/             RAG, wait-for graph, Banker's, detection, recovery
  storage/              disk geometry, one file per DiskSchedulingId, RAID
  io/                   devices, interrupt controller, DMA, buffering
  fs/                   inodes, directories, allocation methods, journal
  security/             rings, domains, access matrix, ACL, capabilities
  syscall/              dispatch table, one handler per SyscallName
  invariants.ts         the assertions from section 15
```

---

## 1. Determinism contract

### 1.1 The tick model

`Tick` is a branded integer. It starts at 0, increases by exactly 1 per
`step()`, and never decreases. It is never derived from wall-clock time.

**One tick is one unit of CPU service.** That single sentence fixes the meaning
of every other duration in the simulator:

| Quantity | Unit | Meaning |
|---|---|---|
| `cpuBurstRemaining` | ticks | CPU service still owed to the current burst |
| `serviceRemaining` | ticks | CPU service still owed across all bursts |
| `SchedulerParams.quantum` | ticks | slice length before preemption |
| `Device.latency` | ticks | service time once the device starts a request |
| `agingInterval` | ticks | ready-queue residence per priority promotion |
| `starvationThreshold` | ticks | ready-queue residence before a warning |
| `BlockReason.sleep.untilTick` | absolute tick | wake time |

Physical time (nanoseconds for memory access, milliseconds for a seek) appears
only inside *cost models* that convert a physical quantity into an integer
number of ticks. Those conversions are specified where they occur (§6.5, §7.2,
§10.2, §11.1) and always round with `Math.max(1, Math.round(x))` so that no
operation is free and no operation takes a fractional tick.

The CPU is single-core in the base model. Multicore appears only in the threads
subsystem (§4) as a *simulated* parallel speedup applied to burst arithmetic,
never as concurrent `step()` execution. This keeps the interleaving totally
ordered, which is what makes the race-condition traces in §8.6 reproducible.

### 1.2 `Rng`: sfc32

`Rng` is the only source of nondeterminism permitted in `src/kernel`. The
algorithm is **sfc32** (Small Fast Counting, 32-bit, by Chris Doty-Humphrey,
as used in PractRand). It is chosen because its whole state is four 32-bit
words, which serialises cleanly into `RngState.words` with no precision loss,
and because it is exactly reproducible under JavaScript's `|0` and
`Math.imul` semantics.

#### 1.2.1 The generator core

```ts
/** Advance the state and return the next uint32. */
function sfc32Next(s: Sfc32State): number {
  let { a, b, c, d } = s;
  a |= 0; b |= 0; c |= 0; d |= 0;
  const t = (((a + b) | 0) + d) | 0;
  d = (d + 1) | 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  c = (c + t) | 0;
  s.a = a; s.b = b; s.c = c; s.d = d;
  return t >>> 0;
}
```

Every arithmetic step must keep the `| 0` and `>>> 0` coercions exactly as
written. Dropping one produces a generator that agrees with this one for a while
and then diverges, which is the worst possible failure mode for a determinism
contract.

`next()` is `sfc32Next(state) / 4294967296`, giving a uniform double in
`[0, 1)`. The divisor is `2^32` written as a literal so no `Math.pow` rounding
enters.

#### 1.2.2 Seeding

`KernelConfig.seed` is a single 32-bit integer. It is expanded into four state
words by **splitmix32**, then the generator is warmed by discarding 12 outputs.
The warm-up matters because sfc32 seeded with a low-entropy state (a small
integer seed such as `1`) produces visibly correlated first outputs.

```ts
function splitmix32(seed: number): () => number {
  let z = seed | 0;
  return () => {
    z = (z + 0x9e3779b9) | 0;
    let t = z ^ (z >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

export function createRng(seed: number, label = 'root'): Rng {
  const m = splitmix32(seed | 0);
  const rng = new Sfc32Rng([m(), m(), m(), m()], label);
  for (let i = 0; i < 12; i++) rng.nextUint32();   // warm-up, exactly 12
  return rng;
}
```

**Verified vector.** `createRng(0x4B54524C, 'root')` (the ASCII of `KTRL`) has
state immediately after seeding and warm-up:

```
words = [481119784, 3409944657, 2818634109, 3205637164]
```

and its first five `next()` values are, to ten decimal places:

```
0.6523296025, 0.4470959350, 0.2026866907, 0.4280106414, 0.2385281252
```

These are test fixture `RNG-1`.

#### 1.2.3 Derived methods

```ts
int(lo: number, hi: number): number {
  if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new RangeError('int: non-integer bound');
  if (hi <= lo) throw new RangeError('int: empty range');
  return lo + Math.floor(this.next() * (hi - lo));
}

chance(p: number): boolean {
  // Strict `<` so chance(0) is always false and chance(1) is always true.
  return this.next() < p;
}

pick<T>(items: readonly T[]): T {
  if (items.length === 0) throw new RangeError('pick: empty array');
  return items[this.int(0, items.length)];
}

shuffle<T>(items: T[]): T[] {
  // Fisher-Yates, descending, one draw per swap. Order of draws is part of the contract.
  for (let i = items.length - 1; i > 0; i--) {
    const j = this.int(0, i + 1);
    const tmp = items[i]; items[i] = items[j]; items[j] = tmp;
  }
  return items;
}
```

`shuffle` must iterate descending and must draw exactly `length - 1` numbers.
An ascending variant consumes the same count but produces a different
permutation, so the direction is normative.

#### 1.2.4 `fork(label)`

The requirement in `types.ts` is precise: *"Fork an independent stream, so
adding a subsystem cannot shift others."* Two properties follow, and both are
tested.

**F1. Forking does not advance the parent.** `fork` reads the parent's words and
never calls `sfc32Next` on the parent. If forking consumed parent draws, then
introducing a new subsystem would shift every stream forked afterwards, which is
exactly the failure the contract forbids.

**F2. The child stream is a pure function of the parent state and the label.**
The label is hashed into the derivation, so `fork('scheduler')` and
`fork('memory')` from the same parent state give unrelated streams, and the
order in which they are taken does not matter.

```ts
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

fork(label: string): Rng {
  const h = fnv1a32(label);
  const m = splitmix32((this.a ^ h) | 0);
  const words: [number, number, number, number] = [
    (this.a ^ Math.imul(h, 0x85ebca6b)) | 0,
    (this.b ^ Math.imul(h ^ 0x9e3779b9, 0xc2b2ae35)) | 0,
    (this.c ^ m()) | 0,
    (this.d ^ m()) | 0,
  ];
  const child = new Sfc32Rng(words, this.label ? `${this.label}/${label}` : label);
  for (let i = 0; i < 12; i++) child.nextUint32();   // same warm-up as seeding
  return child;
}
```

`fnv1a32` iterates UTF-16 code units, so labels are restricted by convention to
ASCII `[a-z0-9_]` to avoid surrogate-pair questions. Labels are hierarchical and
the child's `RngState.label` is the slash-joined path, which makes a save file
self-describing.

**Verified vectors.** With `createRng(1234, 'root')`:

| Fork label | First five `next()` |
|---|---|
| `scheduler` | 0.7590017407, 0.1837793530, 0.0627553733, 0.4116676911, 0.8262647619 |
| `memory` | 0.9880230038, 0.1402625744, 0.6085327168, 0.9143000133, 0.2004204346 |

Taking `fork('memory')` before `fork('scheduler')`, and additionally taking
`fork('io')`, leaves both sequences above unchanged and leaves the root state
identical to a freshly seeded `createRng(1234, 'root')`. This is test fixture
`RNG-2` and it is the direct test of F1 and F2.

#### 1.2.5 The stream registry

The kernel forks exactly one stream per subsystem at construction, in a fixed
order, and stores them in a `Map<string, Rng>`:

```
root                      seeded from KernelConfig.seed
root/process              fork('process')
root/scheduler            fork('scheduler')
root/memory               fork('memory')
root/vm                   fork('vm')
root/sync                 fork('sync')
root/deadlock             fork('deadlock')
root/storage              fork('storage')
root/io                   fork('io')
root/fs                   fork('fs')
root/security             fork('security')
root/events               fork('events')
```

All eleven are forked whether or not the subsystem appears in
`KernelConfig.enabledSubsystems`, so that enabling a subsystem for one leg does
not change any other leg's stream. Subsystem code receives its own `Rng` and
must never reach for the root.

The `random` page replacement policy (§7.5) draws from `root/vm`. Random event
selection in the game layer draws from a stream the game layer forks from its
own root, never from a kernel stream.

#### 1.2.6 Save and restore

```ts
save(): RngState {
  return {
    algorithm: 'sfc32',
    words: [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0],
    label: this.label,
  };
}

restore(state: RngState): void {
  if (state.algorithm !== 'sfc32') throw new Error(`unsupported rng algorithm ${state.algorithm}`);
  this.a = state.words[0] | 0;
  this.b = state.words[1] | 0;
  this.c = state.words[2] | 0;
  this.d = state.words[3] | 0;
  this.label = state.label;
}
```

Words are stored unsigned so JSON round-trips without sign surprises and are
reloaded signed so the arithmetic matches. `KernelSnapshot.rng` is
`readonly RngState[]`, holding all eleven streams plus the root, serialised in
the fixed registry order above. Restore replaces state in place; it does not
create new `Rng` objects, because subsystems hold references.

**Verified vector.** `createRng(7, 'x')`, three draws:

```
0.9808979158, 0.9695635808, 0.6098223559
state = [1146746946, 1846046223, 117364893, 1648156502]
next three = 0.0805552991, 0.0603317665, 0.0445723657
```

Restoring that state and drawing three more reproduces the last row exactly.
Test fixture `RNG-3`.

### 1.3 Forbidden APIs, and why

| Forbidden | Why |
|---|---|
| `Math.random` | unseeded, unsaveable, breaks replay entirely |
| `Date.now`, `performance.now` | wall-clock leaks machine speed into sim state |
| `crypto.getRandomValues` | unseeded |
| `Object.keys` / `for...in` over a map-like object with runtime-inserted keys | insertion order is observable but fragile; use `Map` with explicit sorted iteration |
| `Array.prototype.sort` with no comparator, or a comparator that returns 0 for distinct elements | V8's sort is stable since ES2019, but a comparator that ties gives an order that depends on prior array history; every comparator must be a total order |
| `Set` iteration where the insertion order depends on event arrival | iterate a sorted array derived from the set |
| `structuredClone` on objects holding functions | throws, and hides where policy objects leaked into the snapshot |
| Floating-point accumulation of tick counts | all durations are integers; only metrics are floats, and metrics are recomputed, never accumulated |
| `toLocaleString`, `Intl.*` | locale-dependent output in event payloads |

A lint rule plus an AST check in `tests/kernel/determinism.test.ts` enforces the
first four. The rest are code-review items backed by the replay test in §1.4.

One more rule that is easy to violate by accident: **metrics are derived, never
accumulated across a restore.** `SchedulingMetrics.averageWaitingTime` is
recomputed from PCB fields every tick. If it were accumulated into a float, then
`snapshot()` followed by `restore()` followed by more steps would drift from an
uninterrupted run, because floating-point addition is not associative under a
different grouping.

### 1.4 The determinism test

```ts
// tests/kernel/determinism.test.ts

const CONFIG: KernelConfig = { /* the full-subsystem config from §16.1 */ };
const TICKS = 5000;

test('D1: identical construction produces identical event logs', () => {
  const a = createKernel(CONFIG);
  const b = createKernel(CONFIG);
  const ea = a.run(TICKS);
  const eb = b.run(TICKS);
  expect(canonical(eb)).toBe(canonical(ea));
  expect(canonical(b.snapshot())).toBe(canonical(a.snapshot()));
});

test('D2: snapshot/restore mid-run is transparent', () => {
  const a = createKernel(CONFIG);
  a.run(2000);
  const snap = structuredClone(a.snapshot());
  const tailA = a.run(3000);

  const b = createKernel(CONFIG);
  b.restore(structuredClone(snap));
  const tailB = b.run(3000);

  expect(canonical(tailB)).toBe(canonical(tailA));
  expect(canonical(b.snapshot())).toBe(canonical(a.snapshot()));
});

test('D3: adding a subsystem stream does not shift existing streams', () => {
  const withoutIo = { ...CONFIG, enabledSubsystems: CONFIG.enabledSubsystems.filter(s => s !== 'io') };
  const a = createKernel(withoutIo);
  const b = createKernel(CONFIG);
  const sa = a.run(TICKS).filter(e => e.type === 'context.switch');
  const sb = b.run(TICKS).filter(e => e.type === 'context.switch');
  // Scheduling decisions are unaffected by whether the io subsystem exists,
  // for a workload that issues no I/O.
  expect(canonical(sb.map(strip('seq')))).toBe(canonical(sa.map(strip('seq'))));
});

test('D4: seed sweep is stable across runs', () => {
  for (let seed = 0; seed < 64; seed++) {
    const c = { ...CONFIG, seed };
    const h1 = hash(canonical(createKernel(c).run(1000)));
    const h2 = hash(canonical(createKernel(c).run(1000)));
    expect(h2).toBe(h1);
  }
});
```

`canonical(x)` is a deterministic serialiser: it sorts object keys
lexicographically, renders numbers with `Number.prototype.toString()` after
asserting `Number.isFinite`, renders `-0` as `0`, and renders `Map` as a
key-sorted array of pairs. `hash` is FNV-1a over that string. Both live in
`tests/kernel/canonical.ts` and are the only place in the test suite allowed to
walk kernel state structurally.

D1 is the headline test. D2 is the one that catches accumulated float state and
policy objects that hold hidden internal state outside the snapshot. D3 is the
one that catches an `Rng.fork` implementation that advances the parent. D4 is
cheap insurance against a subsystem that happens to be deterministic only for
seed 0.

### 1.5 The subsystem state channel

D2 only works if a snapshot can carry everything a running workload is made of.
The shared tables in `KernelSnapshot` cannot: every subsystem keeps some state in
side tables of its own, and a PCB array has nowhere to put a program's
instruction stream, a thread's program counter, an id allocator or an IPC
mailbox. `KernelSnapshot` therefore has two more fields, both optional, both
added by `docs/07-CONTRACT-AMENDMENTS.md` amendment 1.

- `completeness?: SnapshotCompleteness`, either `'init_only'` or `'full'`. Absent
  means `'init_only'`. An init-only snapshot says the shared tables are the whole
  truth: no user process has existed, no program is registered, and restore is
  exact. `'full'` says `subsystems` carries the side-table state.
- `subsystems?: SubsystemSnapshots`, one slot per subsystem.

`SubsystemSnapshots` is deliberately hybrid. The `process` slot is a fully typed
`ProcessSnapshotState`, because the process subsystem is built and its state is
known exactly: `ProgramSnapshot[]`, `ThreadSnapshot[]`, raw pre-acceleration
work, light-weight process bindings, an `IdCounters` allocator triple, exit codes
a parent has not collected, copy-on-write reference counts, an `IpcSnapshot`, the
tuning object in force, and accumulated execution debt. The other five slots
(`memory`, `sync`, `storage`, `fs`, `security`) are `SubsystemEnvelope`: an
`owner`, a `version` the owning subsystem bumps whenever its payload shape
changes, and a `payload` of `JsonValue`. The owner validates its own payload on
restore and throws rather than accepting a version it does not understand,
because a silently misread save is worse than a refused one.

The envelope is a transition mechanism. Each subsystem replaces its envelope with
a typed interface in the same additive way, in the commit that implements the
subsystem, and records the promotion in `docs/07-CONTRACT-AMENDMENTS.md`. A
subsystem that ships leaving its state opaque has not finished.

Because both fields are optional, the type system no longer proves a snapshot is
complete. `restore` is the enforcement point instead: **it must reject a snapshot
whose completeness is weaker than the state it is being restored into, and throw
rather than silently dropping state.** Restoring an init-only snapshot into a
kernel that has run a workload is an error, not a reset. WP-11 owns that check.

---

## 2. Kernel step order

### 2.1 The fixed order

`step()` performs exactly these eleven phases, in this order, every tick, with
no early return. A phase that has nothing to do is a no-op, and a disabled
subsystem's phase is skipped whole.

```ts
step(): readonly KernelEvent[] {
  this.frame.length = 0;               // KernelEventStream.lastFrame is reused, never reallocated
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
  this.phase11_checkInvariants();      // dev builds only; see §15

  return this.frame;
}
```

Phase by phase:

**Phase 1, expire timers.** Advance every countdown that is keyed on absolute
tick: `sleep` blocks whose `untilTick <= tick`, monitor condition timeouts,
starvation clocks, RAID rebuild progress, journal checkpoint interval, the TLB
shootdown counter. Processes whose sleep expired are marked *wakeable* but are
not moved yet; phase 4 does the moving. This split keeps every ready-queue
insertion in one place.

**Phase 2, service device completions.** Each busy `Device` decrements its
remaining service. A device that reaches zero produces a completion record and,
if `mode` is `interrupt` or `dma`, raises an interrupt line. In `polling` mode
it sets a status flag that the polling process will read in phase 8, and it
charges the poller for wasted ticks (§11.1). Disk requests are drained here
using `DiskSchedulingPolicy.select` (§10.3). Emits `disk.served`,
`io.dma_transfer`.

**Phase 3, deliver interrupts.** The interrupt controller (§11.2) sorts the
pending lines by `(priority, deviceId)` and delivers up to `maxInterruptsPerTick`
of them. Each delivery runs a handler that costs `interruptServiceTicks` charged
against the *kernel*, not against the interrupted process. Emits `io.interrupt`.
If the pending queue exceeds `interruptStormThreshold` for
`interruptStormWindow` consecutive ticks, the storm condition fires (§11.3).

**Phase 4, resolve blocked processes.** Every process in state `waiting` is
re-tested against its `blockedOn` condition, in ascending `pid` order. A process
whose condition is satisfied moves `waiting -> ready`, has `blockedOn` cleared,
`readySince` set to the current tick, and is appended to the scheduler's queue
via `SchedulerPolicy.onUnblock`. Wakes from a `SyncPrimitive` with
`ordered: true` are taken from the head of `waitQueue` only, so bounded waiting
is preserved (Ch. 6.2). Emits `process.state_changed`, `sync.acquired`.

**Phase 5, admit new processes.** Processes in state `new` whose
`arrivalTick <= tick` are admitted subject to the long-term scheduler's degree of
multiprogramming (`TravelPolicy.degreeOfMultiprogramming`, passed down from the
game layer). Admission calls `SchedulerPolicy.onAdmit`, allocates the address
space, and moves `new -> ready`. Emits `process.created`,
`process.state_changed`.

**Phase 6, age and detect starvation.** For every ready process, compute
`waited = tick - readySince`. If `agingInterval > 0` and
`waited % agingInterval === 0` and `waited > 0`, decrement `priority` by 1 with a
floor of 0 (Ch. 5.3.6). If `waited >= starvationThreshold`, emit
`process.starving` with `fatal: false` once per crossing. If
`waited >= starvationFatalThreshold`, emit `process.starving` with `fatal: true`
and terminate with `TerminationReason.starvation`. SABLE's passive multiplies
both thresholds by 3 for its own PCB only.

**Phase 7, scheduler decision.** Build a `SchedulerContext` over the current
state and call `SchedulerPolicy.onTick`. The returned `SchedulingDecision` is
applied: if `next` differs from the currently running process, the outgoing
process moves `running -> ready` (or stays `waiting`/`zombie` if it left the CPU
for another reason), the incoming moves `ready -> running`, `lastScheduledTick`
is set, `contextSwitches` increments, and `context.switch` is emitted with the
policy's `rationale`. A context switch costs `contextSwitchTicks` (default 0 for
teaching clarity, configurable up to 2 for the scheduling-overhead lesson in
Leg 3); when nonzero, the cost is charged as idle ticks before phase 8 runs.

**Phase 8, execute one tick of the running process.** Exactly one unit of CPU
service is delivered, unless the CPU is idle. What that unit does depends on the
head of the running process's instruction stream (§2.3): a memory access, a
syscall, or plain computation. In all three cases `totalCpuUsed` increments and
`cpuBurstRemaining` decrements. A syscall or a page fault may move the process
out of `running` inside this phase, which is legal and is the only place a
process leaves `running` other than phase 7.

**Phase 9, deadlock detection.** Runs only when
`KernelConfig.deadlockStrategy === 'detect'` and only when
`tick % deadlockDetectionInterval === 0` (default interval 20). Builds the
wait-for graph and runs the cycle detection of §9.3. On a cycle, emits
`deadlock.detected` and, if recovery is enabled, `deadlock.resolved`. Under
strategy `avoid`, no detection runs at all, because Banker's already ran inside
the `request` syscall in phase 8. Under `prevent`, no detection runs because the
request ordering rule makes a cycle impossible, and an assertion in §15 checks
that claim every tick in dev builds.

**Phase 10, update metrics.** Recompute `SchedulingMetrics` and `MemoryMetrics`
from scratch off PCB and frame state. Smoothed values (`faultRate`,
`cpuUtilisation`) use an exponentially weighted moving average with a fixed
integer-friendly form given in §7.8. Thrashing thresholds are tested here and
`memory.thrashing` is emitted here, after the tick's faults are counted.

**Phase 11, check invariants.** In development and test builds, run every
assertion in §15. A failure throws with the invariant number and the offending
state. In production builds this phase compiles out.

Finally `step()` returns `this.frame`, which is also exposed as
`events.lastFrame`. Handlers registered through `events.on` were already called
synchronously at emit time; `lastFrame` exists so a renderer that missed the
callbacks can catch up.

### 2.2 Why this order, and which orderings are wrong

**Timers before device completions.** A sleeping process whose wake tick has
arrived must be eligible in the same tick as a device completion that unblocks a
different process, and both must be visible to the single scheduling decision.
If completions ran first and timers second, a completion that finished a device
would be seen by phase 4 while the sleeper would wait a tick, producing a
one-tick bias in favour of I/O-bound processes that has no counterpart in a real
kernel.

**Device completions before interrupts.** An interrupt is the *notification* of a
completion. Raising the line in the same phase that computes the completion would
work, but separating them lets the polling mode exist: in polling mode the
completion happens and no interrupt is raised, and the wasted-tick accounting in
§11.1 has somewhere to live. Reversing the two would deliver interrupts for
completions that have not happened yet.

**Interrupts before resolving blocked processes.** This is the one ordering the
implementation is most likely to get wrong. An interrupt handler is what marks a
`blockedOn: {kind:'io'}` process as satisfiable. If phase 4 ran first, an I/O
completion would always take an extra tick to unblock its waiter, and the
polling-versus-interrupt comparison in Leg 10 would show the wrong number,
because polling would appear to have the same latency as interrupts.

**Resolving blocked processes before admitting new ones.** Both push into the
ready queue. Doing unblocks first means a process that has already run and then
blocked on I/O re-enters ahead of a process that has never run, at the same tick,
under FCFS. That matches a real kernel's preference for the already-resident
process and, more importantly, it is a rule, and the alternative rule is equally
defensible. What matters is that the rule is written down. Reversing it would
change every FCFS Gantt chart involving I/O.

**Admission before aging.** A process admitted this tick has `readySince = tick`,
so `waited === 0`, so it cannot age or starve on the tick it arrives. If aging
ran first, the new arrival would be skipped anyway, so the order is not
observable here; it is fixed for readability and asserted by invariant I-14.

**Aging before the scheduler decision.** Priorities must already reflect this
tick's aging when the scheduler picks. If the scheduler ran first, a process that
just aged into the top priority would still lose the CPU for one more tick,
which delays every promotion by exactly one tick and makes the aging fixture in
§5.9 produce different numbers.

**Scheduler decision before execution.** Obvious, but it has a consequence worth
stating: preemption is decided *before* the tick is spent, so a quantum of 4
means the process runs ticks 0, 1, 2, 3 and is preempted at the decision made
during tick 4. `sliceElapsed` is therefore the count of ticks already executed in
this slice, and the preemption test is `sliceElapsed >= quantum`, not `>`.

**Execution before deadlock detection.** A `request` syscall executed this tick
can be the one that closes the cycle. Detecting before executing would report the
deadlock one detection interval late, which for the default interval of 20 ticks
is very visible to the player.

**Deadlock detection before metrics.** `deadlock.resolved` may terminate a
victim, and the victim's frames return to the free list. Metrics computed before
recovery would report memory that is about to be freed, and the HUD would
flicker.

**Metrics before invariants.** Several invariants are stated over metrics
(I-3, I-19). They must read this tick's values.

**Everything before the event flush.** Events are appended to `this.frame` as
they are emitted, in phase order, so the event log is a faithful transcript of
the step order. `seq` is a single monotonic counter across the whole run,
incremented on every emit, and is never reset by `restore`, because
`KernelSnapshot.seq` carries it.

### 2.3 The instruction stream

Phase 8 needs to know what the running process does with its tick. Each PCB has a
private program, which is a deterministic generator, never a script the player
can see:

```ts
type Instruction =
  | { kind: 'compute' }                                   // burn one tick
  | { kind: 'access'; page: PageId; write: boolean }      // memory reference
  | { kind: 'syscall'; call: SyscallRequest }             // trap
  | { kind: 'io'; device: DeviceId }                      // convenience wrapper over ioctl
  | { kind: 'acquire'; resource: ResourceId }             // convenience wrapper over request
  | { kind: 'release'; resource: ResourceId };

interface Program {
  /** Peek the instruction to be executed at the given point. Pure. */
  at(index: number): Instruction;
  readonly length: number;
  /** Non-null only in scripted teaching scenarios; feeds MemoryContext.futureReferences. */
  readonly referenceString: readonly PageId[] | null;
}
```

`ProcessSpec.referenceString` from `@game/types` is turned into a `Program` of
`access` instructions padded with `compute` to reach `service` ticks. A spec with
no reference string gets a program generated from `root/process` at spawn time,
using the locality model of §7.7 so that working sets are meaningful rather than
uniform noise.

`optimal` page replacement (Ch. 10.4.3) requires lookahead, which is only sound
when the program is scripted. `MemoryContext.futureReferences` is non-null only
when every runnable process has a scripted `referenceString`; otherwise
`selectVictim` on the optimal policy throws, and `setReplacementPolicy('optimal')`
returns without effect and logs a `kernel.panic` in dev builds. The player-facing
consequence is that OPT is offered only inside teaching scenarios, which matches
the comment in `types.ts`.

---

## 3. Process management (Ch. 3)

### 3.1 The PCB and the process table

`ProcessControlBlock` is frozen in `types.ts`. The process table is a
`Map<Pid, ProcessControlBlock>` plus a parallel `Pid[]` kept in ascending order,
because several algorithms iterate processes and must do so in a fixed order.
`Kernel.processes` returns that ordered array, shallow-frozen.

PID allocation is a monotonically increasing counter starting at 1. PID 0 is
reserved for the kernel idle process (§3.7). PIDs are never reused within a run,
which removes an entire class of nondeterminism and makes event logs readable.

Fields not obvious from their names:

- `priority` is mutable and is what the scheduler reads. `basePriority` is what
  `priority` resets to whenever the process is dispatched (Ch. 5.3.6 aging
  requires that a promoted process return to its base once it has been served,
  otherwise a single promotion is permanent).
- `cpuBurstRemaining` is the *current* burst. `serviceRemaining` is total work
  left. SJF and SRTF read `serviceRemaining` in this simulator; the textbook
  speaks of "next CPU burst", and for the single-burst fixtures in §5 the two are
  equal, so the fixtures agree with the book. For multi-burst workloads the sim
  offers an estimated next burst by exponential average (§5.3.2) that SJF can
  consume instead, selected by `SchedulerParams` extension in a later revision.
- `readySince` is `null` whenever the process is not in state `ready`. Setting it
  is the responsibility of whichever phase moved the process into `ready`, and
  invariant I-12 checks the pairing.
- `queueLevel` is 0 for every policy except MLFQ.

### 3.2 The state model

Five states from Ch. 3.1.2 plus `zombie` from Ch. 3.3.2. `terminated` is the
final resting state after reaping.

```
 new ──admit──▶ ready ◀──preempt/quantum── running ──exit──▶ zombie ──reap──▶ terminated
                  │                            │                  ▲
                  │                            │                  │
                  └──────dispatch──────────────┘                  │
                                               │                  │
                                          block│                  │
                                               ▼                  │
                                            waiting ──kill────────┘
                                               │
                                          wake │
                                               ▼
                                             ready
```

### 3.3 The state transition table

Every edge, with its trigger, the phase that performs it, and the event emitted.
No other transition is legal, and invariant I-11 enforces that.

| # | From | To | Trigger | Phase | Side effects |
|---|---|---|---|---|---|
| T1 | (none) | `new` | `fork` syscall, or leg `populate` spawn | 8 or setup | PCB created, `arrivalTick` set, `addressSpaceId` allocated |
| T2 | `new` | `ready` | admitted by the long-term scheduler; `arrivalTick <= tick` and resident count `< degreeOfMultiprogramming` | 5 | `readySince = tick`, `onAdmit`, `process.created` if not already emitted |
| T3 | `ready` | `running` | scheduler selects it | 7 | `readySince = null`, `lastScheduledTick = tick`, `priority = basePriority`, `sliceElapsed = 0` |
| T4 | `running` | `ready` | quantum expiry, or preemption by a higher-priority / shorter-remaining arrival, or MLFQ demotion | 7 | `readySince = tick`, appended to the tail of its queue; on quantum expiry `quantum.expired` |
| T5 | `running` | `waiting` | blocking syscall: `sem_wait` on a zero semaphore, `mutex_lock` on a held mutex, `read`/`write` on a busy device, `wait` with an unreaped-but-live child, `request` denied under avoidance, or a major page fault | 8 | `blockedOn` set, `SchedulerPolicy.onBlock`, `sync.blocked` or `io.request` or `memory.page_fault` |
| T6 | `waiting` | `ready` | the blocking condition is satisfied: semaphore posted, mutex released, device completion delivered, child exited, resource granted, page loaded | 4 | `blockedOn = null`, `readySince = tick`, `onUnblock`, `sync.acquired` where applicable |
| T7 | `running` | `zombie` | `exit` syscall, or fatal fault taken while running | 8 | `exitCode`, `terminationReason` set; children reparented (§3.6); frames freed; held resources released; open FDs closed; `process.exited` |
| T8 | `ready` | `zombie` | `kill` from another process or the player, or starvation past `starvationFatalThreshold` | 6 or 8 | as T7, with `terminationReason` `killed_by_user`, `killed_by_parent` or `starvation` |
| T9 | `waiting` | `zombie` | `kill`, deadlock victim selection, `io_timeout`, `out_of_memory`, `thrashing_collapse` | 8 or 9 | as T7; removed from every `waitQueue` it appears in |
| T10 | `zombie` | `terminated` | parent executes `wait` and reaps it, or the init process reaps an orphan | 8 or 4 | PCB retains only pid/name/exitCode for the tombstone; `process.reaped` |
| T11 | `new` | `terminated` | leg teardown before admission | teardown | no `process.exited`; the PCB is discarded |

Two transitions that look plausible and are illegal:

- `waiting -> running` directly. A woken process always passes through `ready`
  and is subject to the scheduler. Allowing the direct edge would make every
  I/O completion an implicit priority boost.
- `zombie -> ready`. A zombie has no address space and no resources; it is a
  record, not a process. `kill` on a zombie returns `ESRCH`.

Every transition emits `process.state_changed` with the exact `from` and `to`,
in addition to the specific event named above. The world layer draws the
specific event; the HUD counts the generic one.

### 3.4 `fork` (Ch. 3.3.1 and 10.3)

```
fork() -> Pid | Errno
```

Numbered procedure:

1. If the process table holds `maxProcesses` entries, return `EAGAIN`.
2. Allocate `childPid = nextPid++`.
3. Allocate a new `AddressSpaceId` for the child.
4. Copy the parent PCB field by field with these substitutions:
   - `pid = childPid`, `parent = parentPid`
   - `name = parent.name + "'"` for display; the game layer overrides for convoy Programs
   - `state = 'new'`, `arrivalTick = tick`
   - `readySince = null`, `lastScheduledTick = null`, `totalCpuUsed = 0`
   - `cpuBurstRemaining` and `serviceRemaining` copied from the parent's current values
   - `queueLevel = 0` (the child starts at the top MLFQ level, Ch. 5.3.6)
   - `threads = [newTid()]`, a single thread; the parent's other threads are not
     duplicated (Ch. 4.4.1: `fork` duplicates only the calling thread)
   - `heldResources = []`, `requestedResources = []`, `blockedOn = null`
   - `openFiles` copied by value, and each referenced inode's `linkCount` for open
     descriptors is incremented, so the child shares the file offset table
   - `exitCode = null`, `terminationReason = null`, `convoyMemberId = null`
   - `domain` copied from the parent (Ch. 17.4: a child inherits its domain)
5. **Copy-on-write the address space (Ch. 10.3).** For every valid page table
   entry in the parent, create a child entry pointing at the *same*
   `FrameId`, set `writable = false` in both parent and child entries, and mark
   the frame COW-shared by incrementing a `cowRefCount` kept in a side table
   `Map<FrameId, number>`. No frame is copied and no `memory.allocated` is
   emitted at fork time. This is what makes `fork` cheap and what makes the
   Leg 1 lesson land.
6. Emit `process.created` with `parent = parentPid`.
7. Return `childPid` to the parent. The child's own return value is 0, delivered
   the first time the child is dispatched.

**COW fault resolution.** When a process writes a page whose PTE has
`writable === false` and whose frame has `cowRefCount > 1`:

1. Allocate a free frame `f'`. If none is free, run replacement (§7.2) first.
2. Copy the frame contents (the sim models contents as an opaque tag, so this is
   a metadata copy that costs `cowCopyTicks`, default 1).
3. Point the faulting process's PTE at `f'`, set `writable = true`,
   `dirty = true`.
4. Decrement `cowRefCount[f]`. If it falls to 1, restore `writable = true` on
   the single remaining PTE that references it.
5. Emit `memory.page_fault` with `major: false`, then `memory.page_loaded`.

A COW fault is a **minor** fault: it never touches the backing store. This is
the cleanest place in the whole simulator to teach the minor/major distinction,
and Leg 1 uses it before Leg 8 ever appears.

### 3.5 `exec`, `exit`, `wait`

**`exec(programName)` (Ch. 3.3.1).** Replaces the address space in place; the PID
does not change.

1. Look up the named program in the leg's program table. Missing name returns
   `ENOENT`.
2. Tear down the address space: for each valid PTE, decrement `cowRefCount`, free
   the frame when the count reaches 0, and drop the entry.
3. Install the new `Program`, reset `cpuBurstRemaining` and `serviceRemaining`
   from its length, reset `queueLevel = 0`.
4. Keep `pid`, `parent`, `priority`, `basePriority`, `domain`, `openFiles`
   (descriptors survive `exec` unless marked close-on-exec).
5. Faults for the new program's pages happen lazily on first touch, so `exec` is
   followed by a burst of major faults. That burst is the visible cost.
6. Return value: `exec` does not return on success. In this simulator it returns
   `{ ok: true, value: null }` and the process's next instruction comes from the
   new program.

**`exit(code)` (Ch. 3.3.2).**

1. Set `exitCode = code`, `terminationReason = 'normal_exit'` unless already set
   by the killer.
2. Release every entry in `heldResources` back to its `ResourceType`, waking the
   head of each wait queue in phase 4 of the next tick.
3. Remove the process from every `SyncPrimitive.waitQueue` and `Device.queue`.
4. Close every open file descriptor.
5. Free every frame in the address space, respecting `cowRefCount`.
6. Reparent children (§3.6).
7. Set `state = 'zombie'`. **The PCB is not destroyed.** `pid`, `name`,
   `exitCode`, `terminationReason` and `parent` remain readable so the parent can
   collect them.
8. If the parent is blocked on `{kind:'child_wait', child: null}` or
   `{kind:'child_wait', child: thisPid}`, the parent becomes wakeable and is
   moved to `ready` in phase 4.
9. Emit `process.exited`.

**`wait(pid?)` (Ch. 3.3.2).**

1. Let `children` be the PCBs whose `parent === callerPid`, ascending by pid.
2. If `children` is empty, return `ECHILD`. (`ECHILD` is not in the frozen
   `Errno` union, so the sim returns `ESRCH` with the message
   `"no children"`; §14 records this substitution.)
3. If an argument pid is given and it is not a child, return `ESRCH`.
4. If any candidate child is in state `zombie`, reap the lowest such pid:
   set `state = 'terminated'`, emit `process.reaped`, and return its `exitCode`.
5. Otherwise block the caller with `blockedOn = {kind:'child_wait', child: pidOrNull}`
   and transition T5.

**Zombie accumulation is the Leg 1 failure mode.** A parent that forks in a loop
and never waits leaves one zombie per child. Zombies occupy process table slots
but no frames, so the table fills and `fork` starts returning `EAGAIN`. The
game surfaces this as the convoy being unable to spawn workers. The remedy the
player must derive is `wait`, exposed in the terminal as `wait` and visible in
`ps` output as state `Z`.

### 3.6 Orphans and adoption

The kernel creates PID 1, named `init`, during construction, before any leg
process. It is never scheduled for real work (its program is a single
`compute` instruction repeated forever, at the lowest priority) and it exists to
adopt orphans, exactly as in Ch. 3.3.2.

When a process exits:

1. For every PCB whose `parent === exitingPid`:
   - If that child is a `zombie`, reparent it to PID 1 and immediately reap it in
     the same phase (init reaps on adoption). Emit `process.reaped` with
     `by: 1`.
   - Otherwise set `parent = 1` and emit `process.state_changed` with identical
     `from` and `to` so the world layer can redraw the parent edge. The world
     layer treats a same-state change as a re-parent hint.
2. If the exiting process is PID 1, emit `kernel.panic` with the message
   `"init exited"`. This is a genuine kernel panic and ends the leg.

The game layer's `orphaned` affliction (from `AfflictionId`) is applied to a
convoy Program whose backing process gets reparented to init while it still has
outstanding work.

### 3.7 The idle process

PID 0, named `idle`, state permanently `ready`, priority `Number.MAX_SAFE_INTEGER`,
`serviceRemaining = Infinity`. It is **not** in the scheduler's ready queue and
is **not** returned by `Kernel.processes`. It exists so that "CPU idle" has a
concrete representation for the metrics in §5.10 and for the world layer's
procession, which draws an empty slot rather than nothing. A `SchedulingDecision`
of `{ next: null }` means idle; the scheduler never returns pid 0.

### 3.8 IPC (Ch. 3.4 to 3.6)

Two mechanisms, both deterministic.

**Shared memory (Ch. 3.5).** A shared region is an address space that is mapped
into more than one process:

```ts
interface SharedRegion {
  readonly id: ResourceId;
  readonly pages: readonly PageId[];
  readonly space: AddressSpaceId;
  attached: Pid[];
  /** The single integer the region holds, for the race detector in §8.6. */
  value: number;
}
```

`mmap(regionId)` attaches: the caller's page table gains entries pointing at the
region's frames, with `writable` taken from the caller's rights in its protection
domain. `munmap` detaches. Frames belonging to a shared region are `pinned` while
any process is attached, so replacement cannot evict them out from under a
reader. Access to a shared region is what the race detector watches.

**Message passing (Ch. 3.6).** Indirect, through named mailboxes:

```ts
interface Mailbox {
  readonly id: ResourceId;
  readonly capacity: number;      // 0 means rendezvous (unbuffered)
  queue: Message[];               // FIFO, bounded by capacity
  sendWaiters: Pid[];             // blocked because the box is full
  recvWaiters: Pid[];             // blocked because the box is empty
}
interface Message { readonly from: Pid; readonly tick: Tick; readonly payload: number; }
```

- `capacity === 0`: **rendezvous**. `send` blocks until a matching `receive`
  arrives, and vice versa. Ch. 3.6.2 calls this zero capacity.
- `capacity > 0`: **bounded**. `send` blocks only when full; `receive` blocks
  only when empty. This is literally the bounded-buffer problem of §8.7, which
  is why Leg 5 reuses the mailbox implementation rather than a second one.
- Unbounded capacity is not modelled, because it never blocks and therefore
  teaches nothing.

Blocking sends and receives use `BlockReason` of kind `semaphore` with a
synthetic `ResourceId` of `mbox:<id>:send` or `mbox:<id>:recv`, so the wait-for
graph in §9.3 sees message-passing deadlocks too. That is the point: a
rendezvous pair that each send first is a real deadlock and the wait-for graph
draws it.

---

## 4. Threads (Ch. 4)

### 4.1 Representation

`ProcessControlBlock.threads` is `Tid[]`, so the PCB owns its threads and there
is no separate thread table keyed globally. A side map holds the thread control
blocks:

```ts
type ThreadState = 'ready' | 'running' | 'waiting' | 'terminated';

interface ThreadControlBlock {
  readonly tid: Tid;
  readonly pid: Pid;
  state: ThreadState;
  /** Index into the owning process's Program. Threads share the address space. */
  programCounter: number;
  /** Ticks of work this thread still owes. Sums to the process serviceRemaining. */
  serviceRemaining: number;
  /** Kernel-level scheduling entity this thread maps onto. Null under many-to-one. */
  lwp: number | null;
  blockedOn: BlockReason | null;
}
```

Threads share `addressSpaceId`, `openFiles` and `domain` with their process, and
have private `programCounter` and `serviceRemaining`. That is the whole of what
Ch. 4.1.1 says a thread owns.

The CPU scheduler in §5 schedules **processes**, not threads. Within a
dispatched process, the tick is delivered to threads by the thread model below.
This keeps every scheduling fixture in §5 valid regardless of threading, and it
matches the many-to-one and many-to-many pictures where the kernel cannot see
user threads at all.

### 4.2 The three models (Ch. 4.3)

```ts
export type ThreadModel = 'many_to_one' | 'one_to_one' | 'many_to_many';
```

(Earlier drafts wrote "one-to-many" for what Ch. 4.3.2 calls **one-to-one**. The
identifier above is the shipping name.)

**Many-to-one (Ch. 4.3.1).** All user threads of a process map onto one kernel
entity. `lwp` is `null` for every thread.

- Dispatch rule: the process's tick goes to the first thread in `threads` order
  whose state is `ready`, and that thread runs until it blocks or finishes. This
  is cooperative within the process.
- **A blocking call by any thread blocks the whole process.** When a thread takes
  `BlockReason`, the PCB goes to `waiting` and no other thread of that process
  runs. This is the defining pathology of the model and the thing Leg 2 makes the
  player feel.
- Parallel speedup: none. `effectiveCores = 1` regardless of `coreCount`.

**One-to-one (Ch. 4.3.2).** Each user thread has its own kernel entity;
`lwp === tid`.

- A blocking call blocks only the calling thread. The PCB stays `ready` as long
  as at least one thread is `ready`.
- Parallel speedup: up to `min(threads.length, coreCount)`.
- Cost: each thread creation charges `threadCreateTicks` (default 2) to the
  creating process, and the kernel enforces `maxThreadsPerProcess` (default 16),
  returning `EAGAIN` beyond it. That charge is applied *after* the Amdahl
  division and scales with `N`, the thread count of §4.3, so coordination cost is
  never accelerated by the parallelism that incurred it. Over-threading is the
  Leg 2 failure, and this is where its cost comes from.

**Many-to-many (Ch. 4.3.3).** `n` user threads multiplexed onto `m` kernel
entities, `m = min(threads.length, lwpPoolSize)`, `lwpPoolSize` defaulting to
`coreCount`.

- `lwp` is assigned round-robin over `[0, m)` in ascending `tid` order whenever
  the thread set changes. That reassignment must be a pure function of the sorted
  tid list so a snapshot restore reproduces it.
- A blocking call blocks one LWP. Threads sharing that LWP stall; threads on
  other LWPs continue.
- Parallel speedup: up to `m`.
- The two-level model of Ch. 4.3.3 (many-to-many plus the option to bind a thread
  to its own LWP) is available by setting `ThreadControlBlock.lwp` explicitly at
  creation; the sim honours a pre-set value instead of assigning one.

### 4.3 Amdahl's law as a computed quantity (Ch. 4.2)

The sim exposes speedup as a real number that the player can watch flatten.

```
                        1
speedup(S, N) = ─────────────────────
                 S + (1 - S) / N
```

where `S` is the serial fraction of the workload, `0 <= S <= 1`, and `N` is the
number of processing cores actually usable, defined below.

```ts
export function amdahlSpeedup(serialFraction: number, cores: number): number {
  if (!(serialFraction >= 0 && serialFraction <= 1)) throw new RangeError('S out of range');
  if (!Number.isInteger(cores) || cores < 1) throw new RangeError('cores must be a positive integer');
  if (serialFraction === 1) return 1;
  return 1 / (serialFraction + (1 - serialFraction) / cores);
}
```

**`N` is not the thread count.** It is:

```ts
function usableCores(pcb: ProcessControlBlock, cfg: ThreadConfig): number {
  const t = pcb.threads.filter(isRunnable).length;
  switch (cfg.model) {
    case 'many_to_one':  return 1;
    case 'one_to_one':   return Math.min(t, cfg.coreCount);
    case 'many_to_many': return Math.min(t, cfg.lwpPoolSize, cfg.coreCount);
  }
}
```

**Serial fraction.** Each `ProcessSpec` carries an optional
`serialFraction?: number`. When it is absent the kernel uses the tuning value
`defaultSerialFraction`, which is 0.25, and that is the value used in the Leg 2
fixtures. It is a property of the workload and the player cannot change it. That
is the lesson: adding threads cannot buy back the serial part. The field is
optional on `ProcessSpec` as of `docs/07-CONTRACT-AMENDMENTS.md` amendment 1; a
leg declares its processes only through `ProcessSpec`, so this is the only way a
leg sets its own serial fractions.

**How speedup is applied to burst times.** Speedup is applied at *burst
admission*, never continuously, so that `cpuBurstRemaining` stays an integer and
the Gantt charts stay legible.

Numbered procedure, executed when a process's burst is (re)computed, which is at
admission, after each unblock, and after any `thread.created` or
`thread.joined` event:

1. `raw = pcb.rawBurstRemaining` (the un-accelerated figure, stored alongside).
2. `N = usableCores(pcb, cfg)`; `S` is the process's serial fraction.
3. `sp = amdahlSpeedup(S, N)`.
4. `accelerated = Math.ceil(raw / sp)`.
5. `overhead = tuning.threadCreateTicks * N`, charged **after** step 4.
6. `pcb.cpuBurstRemaining = Math.max(1, accelerated + overhead)`.
7. `pcb.serviceRemaining` is recomputed the same way from `rawServiceRemaining`.

So the whole burst accounting is:

```
effective = ceil( R / S(s, N) ) + O * N
```

where `R` is the raw figure, `s` is the serial fraction, `O` is
`threadCreateTicks` and `N` is the usable core count of step 2.

Earlier drafts charged the overhead into raw service *before* the division,
`(R + O*N) / S(N)`. That made over-threading nearly free, because the division
accelerated the coordination cost along with the work, and coordination cost is
precisely the part that parallelism cannot accelerate. Charging it afterwards and
scaling it by thread count gives the curve a real minimum and a real penalty past
it, which is the hazard Leg 2 is built on. See
`docs/07-CONTRACT-AMENDMENTS.md` amendment 2.

Step 4 uses `Math.ceil`, not `Math.round`. `R / S` lands on an exact half at
`N = 2` (66.5 for `R = 100, s = 0.25`), and a half-way tie rounds differently
across implementations: JavaScript's `Math.round` gives 67 and Python's `round`
gives 66. A fixture whose value depends on which language ran it is not a
fixture. `ceil` also never under-charges service, which is the right bias for a
scheduler. The `Math.max(1, ...)` floor guarantees progress, and because the
arithmetic happens once per recomputation rather than per tick, the total is
stable under snapshot and restore.

**Verified table.** `amdahlSpeedup` values, and the effective burst for a raw
burst of 100 ticks with `s = 0.25` and `O = 2`:

| N | speedup(0.25, N) | effective from raw 100, O = 2 | speedup(0.10, N) | speedup(0.50, N) |
|---|---|---|---|---|
| 1 | 1.0000 | 102 | 1.0000 | 1.0000 |
| 2 | 1.6000 | 67 | 1.8182 | 1.3333 |
| 4 | 2.2857 | 52 | 3.0769 | 1.6000 |
| 8 | 2.9091 | 51 | 4.7059 | 1.7778 |
| 16 | 3.3684 | 62 | 6.4000 | 1.8824 |
| 32 | 3.6571 | 92 | 7.8049 | 1.9394 |
| ∞ | 4.0000 | unbounded | 10.0000 | 2.0000 |

The speedup columns are test fixture `AMDAHL-1`; the effective burst column is
`AMDAHL-2`. The effective figure has no limit at `N = ∞` because `O * N` grows
without bound, which is the point.

The teaching moment is now the whole shape of the curve rather than one row. The
minimum sits at 6 threads, at 50 ticks. Eight threads costs 51, sixteen costs 62,
and thirty-two costs 92, which is 1.85x worse than the optimum and slower than
four threads. Leg 2's over-threading failure is exactly this arithmetic, and the
player is expected to read it off the HUD.

### 4.4 Thread syscalls and events

Thread creation and joining are not in the frozen `SyscallName` union, so they
are driven by `Instruction` variants rather than by `syscall()`:

- `thread_create` emits `thread.created` with the owning `pid` and new `tid`,
  appends to `pcb.threads`, and triggers the burst recomputation of §4.3, which
  is where `threadCreateTicks` is charged. The charge belongs to the
  recomputation rather than to the syscall path, because it is applied after the
  division and scaled by `N`, and both of those are only known there.
- `thread_join` emits `thread.joined`, removes the tid from `pcb.threads`,
  folds the joined thread's remaining service into the joiner, and triggers
  recomputation.
- A process whose `threads` array becomes empty exits with code 0.

Invariant I-7 checks that `pcb.threads` is non-empty for every process in state
`ready`, `running` or `waiting`.

---

## 5. CPU scheduling (Ch. 5)

### 5.1 Common ground

Every policy implements `SchedulerPolicy` from `types.ts`. The kernel owns the
ready set; the policy owns the *order*. Concretely:

- The kernel calls `onAdmit` when a process enters `ready` for the first time,
  `onUnblock` when it re-enters `ready` after waiting, `onBlock` when it leaves
  for `waiting`, `onExit` when it dies.
- The kernel calls `onTick` exactly once per tick, in phase 7, and applies the
  returned `SchedulingDecision` verbatim.
- `SchedulerContext.readyQueue` is the kernel's ordered `Pid[]` of ready
  processes, in **insertion order**: the order in which they entered `ready`.
  Policies that need a different order maintain their own structure and use
  `readyQueue` only as the authoritative membership set.
- `SchedulerContext.sliceElapsed` is the number of ticks already executed by the
  running process in its current slice, so the very first tick of a slice sees
  `sliceElapsed === 0`.

**The universal tie-break.** Wherever a policy's primary key ties, the order is:

1. lower `arrivalTick` first;
2. then lower `pid` first.

Both are total orders over live processes, so the combined key never ties. This
rule is mandatory for every policy and every comparator. Sorting must always be
done with an explicit comparator implementing it.

```ts
export function tieBreak(a: ProcessControlBlock, b: ProcessControlBlock): number {
  if (a.arrivalTick !== b.arrivalTick) return a.arrivalTick - b.arrivalTick;
  return a.pid - b.pid;
}
```

**Metric definitions (Ch. 5.2).** For a process with arrival `a`, total service
`b`, first dispatch tick `f`, and completion tick `c`:

```
turnaround = c - a
waiting    = turnaround - b
response   = f - a
```

Averages are the unweighted mean over completed processes. `throughput` is
completed processes per 100 ticks. `cpuUtilisation` is the fraction of elapsed
ticks in which some process ran. `worstWait` is
`max(tick - readySince)` over currently-ready processes, which is what feeds the
starvation warning.

### 5.2 FCFS

**Selection rule.** Pick the ready process with the smallest position in the
kernel's insertion-ordered ready queue, which is to say the head.

**Preemption rule.** None. `isPreemptive = false`. Once dispatched, a process
runs until it blocks or finishes.

**Tie-break.** Insertion order is already a total order. Two processes that enter
`ready` in the same phase of the same tick are inserted by `tieBreak`, so the
result is deterministic.

**Data structure.** A `Pid[]` used as a FIFO: `push` on the tail, `shift` on the
head. `snapshot().queues` is `[thatArray]`.

**Worked example (Ch. 5.3.1).** Three processes, all arriving at tick 0, in
submission order P1, P2, P3:

| Process | Arrival | Burst |
|---|---|---|
| P1 | 0 | 24 |
| P2 | 0 | 3 |
| P3 | 0 | 3 |

Gantt: `P1[0-24] P2[24-27] P3[27-30]`

| Process | First run | Completion | Waiting | Turnaround | Response |
|---|---|---|---|---|---|
| P1 | 0 | 24 | 0 | 24 | 0 |
| P2 | 24 | 27 | 24 | 27 | 24 |
| P3 | 27 | 30 | 27 | 30 | 27 |

**Averages: waiting 17.0, turnaround 27.0, response 17.0.** Context switches: 3
(counting the initial dispatch). Test fixture `SCHED-FCFS-1`.

**Same processes, submission order P2, P3, P1:** Gantt
`P2[0-3] P3[3-6] P1[6-30]`, **averages: waiting 3.0, turnaround 13.0,
response 3.0.** Test fixture `SCHED-FCFS-2`. The pair exists so the player can
be shown that FCFS's average waiting time depends entirely on arrival order,
which is the **convoy effect** of Ch. 5.3.1. Leg 3 opens with exactly this pair.

### 5.3 SJF

**Selection rule.** Pick the ready process with the smallest
`serviceRemaining`. Non-preemptive.

**Preemption rule.** None. A shorter arrival waits for the running process to
finish.

**Tie-break.** Equal `serviceRemaining` resolves by `tieBreak`.

**Data structure.** A binary min-heap keyed by
`(serviceRemaining, arrivalTick, pid)`, rebuilt lazily: `onAdmit` and
`onUnblock` push, `onTick` peeks. Because `serviceRemaining` of ready processes
never changes while they wait, the heap stays valid without a decrease-key
operation. The heap comparator is:

```ts
const sjfCmp = (a: PCB, b: PCB) =>
  a.serviceRemaining !== b.serviceRemaining
    ? a.serviceRemaining - b.serviceRemaining
    : tieBreak(a, b);
```

**Worked example (Ch. 5.3.2).** Four processes, all arriving at tick 0:

| Process | Arrival | Burst |
|---|---|---|
| P1 | 0 | 6 |
| P2 | 0 | 8 |
| P3 | 0 | 7 |
| P4 | 0 | 3 |

Gantt: `P4[0-3] P1[3-9] P3[9-16] P2[16-24]`

| Process | Waiting | Turnaround | Response |
|---|---|---|---|
| P1 | 3 | 9 | 3 |
| P2 | 16 | 24 | 16 |
| P3 | 9 | 16 | 9 |
| P4 | 0 | 3 | 0 |

**Averages: waiting 7.0, turnaround 13.0, response 7.0.** Test fixture
`SCHED-SJF-1`. The same set under FCFS in submission order P1..P4 gives average
waiting 10.25, which is the comparison Ch. 5.3.2 draws and which the debrief card
uses as its counterfactual.

**Next-burst estimation (Ch. 5.3.2).** For multi-burst workloads the true next
burst is unknowable, so the sim also maintains an exponential average:

```
tau[n+1] = alpha * t[n] + (1 - alpha) * tau[n]
```

with `alpha = 0.5` and `tau[0] = spec.burst`. It is stored on the PCB as
`estimatedNextBurst`, recomputed in phase 10 whenever a burst completes, and
exposed by the terminal command `top`. The scheduler uses the true
`serviceRemaining` for the single-burst fixtures so that the numbers above match
the textbook; a config flag `useEstimatedBurst` switches SJF and SRTF onto
`estimatedNextBurst` for the Leg 3 advanced scenario.

### 5.4 SRTF

**Selection rule.** Pick the ready-or-running process with the smallest
`serviceRemaining`.

**Preemption rule.** Preemptive. On every tick, if any ready process has
`serviceRemaining` **strictly less than** the running process's
`serviceRemaining`, preempt. Strict comparison matters: with `<=`, an arrival of
exactly equal remaining time would cause a context switch that buys nothing, and
would break the fixture below.

**Tie-break.** `tieBreak`, which under the strict rule only matters when choosing
among ready processes after the CPU is already free.

**Data structure.** Same min-heap as SJF, plus a check of the heap root against
the running process each tick. The running process is not in the heap while it
runs; it is pushed back on preemption with its decremented
`serviceRemaining`.

**Worked example (Ch. 5.3.2).** Staggered arrivals:

| Process | Arrival | Burst |
|---|---|---|
| P1 | 0 | 8 |
| P2 | 1 | 4 |
| P3 | 2 | 9 |
| P4 | 3 | 5 |

Tick by tick: P1 runs tick 0 and has 7 left. At tick 1, P2 arrives with 4 < 7, so
P1 is preempted. P2 runs to completion at tick 5 (P3 arrives at 2 with 9, P4 at 3
with 5, neither beats P2's dwindling remainder). At tick 5 the ready set is
{P1: 7, P3: 9, P4: 5}, so P4 runs. At tick 10 the ready set is {P1: 7, P3: 9}, so
P1 runs to completion at 17, then P3 to 26.

Gantt: `P1[0-1] P2[1-5] P4[5-10] P1[10-17] P3[17-26]`

| Process | Waiting | Turnaround | Response |
|---|---|---|---|
| P1 | 9 | 17 | 0 |
| P2 | 0 | 4 | 0 |
| P3 | 15 | 24 | 15 |
| P4 | 2 | 7 | 2 |

**Averages: waiting 6.5, turnaround 13.0, response 4.25.** Context switches: 5.
Test fixture `SCHED-SRTF-1`. The same workload under non-preemptive SJF gives
average waiting 7.75, which is the comparison the textbook makes.

### 5.5 Priority

**Selection rule.** Pick the ready process with the numerically smallest
`priority`. Ch. 5.3.4's convention, restated in `types.ts`: **lower number means
higher priority.**

**Preemption rule.** Governed by `SchedulerParams.preemptive`. When true, an
arriving or unblocking process with strictly smaller `priority` than the running
process preempts it. When false, the running process keeps the CPU until it
blocks or finishes. The default for the `priority` policy id is
non-preemptive, matching the worked example below.

**Tie-break.** Equal priority resolves by `tieBreak`. Note that this makes
equal-priority processes behave like FCFS among themselves, which is the standard
degenerate case.

**Data structure.** A min-heap keyed by `(priority, arrivalTick, pid)`. Because
`priority` is mutable under aging, the heap must be rebuilt whenever any ready
process's priority changes. The implementation keeps a dirty flag set by phase 6
and re-heapifies at most once per tick, which is O(n) and bounded by the process
count.

**Worked example (Ch. 5.3.4).** Five processes, all arriving at tick 0,
non-preemptive:

| Process | Arrival | Burst | Priority |
|---|---|---|---|
| P1 | 0 | 10 | 3 |
| P2 | 0 | 1 | 1 |
| P3 | 0 | 2 | 4 |
| P4 | 0 | 1 | 5 |
| P5 | 0 | 5 | 2 |

Gantt: `P2[0-1] P5[1-6] P1[6-16] P3[16-18] P4[18-19]`

| Process | Waiting | Turnaround | Response |
|---|---|---|---|
| P1 | 6 | 16 | 6 |
| P2 | 0 | 1 | 0 |
| P3 | 16 | 18 | 16 |
| P4 | 18 | 19 | 18 |
| P5 | 1 | 6 | 1 |

**Averages: waiting 8.2, turnaround 12.0, response 8.2.** Test fixture
`SCHED-PRIO-1`.

**Indefinite blocking.** Ch. 5.3.4 names starvation as the flaw of pure priority
scheduling. The `priority` policy has `agingInterval` forced to 0 regardless of
what is passed in `SchedulerParams`, so it starves. That is deliberate: it is the
policy the player is meant to lose a Program to before they are shown aging.

### 5.6 Priority with aging

Identical selection and preemption rules to §5.5. The difference is that phase 6
applies aging (Ch. 5.3.4, "aging involves gradually increasing the priority of
processes that wait in the system for a long time").

**Aging rule.** For each ready process, with `waited = tick - readySince`:

```
if (agingInterval > 0 && waited > 0 && waited % agingInterval === 0)
    priority = Math.max(0, priority - 1)
```

**Reset rule.** On dispatch (transition T3), `priority` is restored to
`basePriority`. Without this, a process that ages once keeps the boost forever
and the policy degenerates into "whoever waited longest ever, wins".

**Worked example.** A low-priority process against a stream of high-priority
arrivals, non-preemptive, `agingInterval = 2`:

| Process | Arrival | Burst | Base priority |
|---|---|---|---|
| PL | 0 | 5 | 5 |
| H1 | 0 | 4 | 1 |
| H2 | 4 | 4 | 1 |
| H3 | 8 | 4 | 1 |
| H4 | 12 | 4 | 1 |

**Without aging (`agingInterval = 0`):**

Gantt: `H1[0-4] H2[4-8] H3[8-12] H4[12-16] PL[16-21]`

| Process | Waiting | Turnaround | Response |
|---|---|---|---|
| H1 | 0 | 4 | 0 |
| H2 | 0 | 4 | 0 |
| H3 | 0 | 4 | 0 |
| H4 | 0 | 4 | 0 |
| PL | 16 | 21 | 16 |

Averages: waiting 3.2, turnaround 7.4, response 3.2. **worstWait 16.**

**With aging (`agingInterval = 2`):** PL's priority walks 5 → 4 at tick 2, → 3 at
4, → 2 at 6, → 1 at 8. At tick 8 the ready set is {PL at priority 1 arrival 0,
H3 at priority 1 arrival 8}; the tie-break on arrival gives PL the CPU.

Gantt: `H1[0-4] H2[4-8] PL[8-13] H3[13-17] H4[17-21]`

| Process | Waiting | Turnaround | Response |
|---|---|---|---|
| H1 | 0 | 4 | 0 |
| H2 | 0 | 4 | 0 |
| H3 | 5 | 9 | 5 |
| H4 | 5 | 9 | 5 |
| PL | 8 | 13 | 8 |

Averages: waiting 3.6, turnaround 7.8, response 3.6. **worstWait 8.**

Test fixture `SCHED-AGING-1`. The pair is the argument for aging in two numbers:
average waiting rose from 3.2 to 3.6, and the worst case halved from 16 to 8.
The debrief card for Leg 3 prints both.

### 5.7 Round robin

**Selection rule.** Pick the head of the FIFO ready queue.

**Preemption rule.** Preempt when `sliceElapsed >= quantum`. The preempted
process is appended to the **tail** of the queue. Because phase 7 runs before
phase 8, a quantum of `q` yields exactly `q` executed ticks per slice.

**Ordering rule for the same tick.** When a process is preempted on the same tick
that another process becomes ready, the newly ready process is enqueued in phase
4 or 5 and the preempted process is enqueued in phase 7, so **the new arrival
goes ahead of the preempted process**. This is the standard convention and it is
what produces the textbook's Gantt charts. Reversing it changes `SCHED-RR-2`.

**Tie-break.** Queue position is a total order; simultaneous insertions use
`tieBreak`.

**Data structure.** A circular buffer of `Pid` with head and tail indices, sized
to `maxProcesses`, so enqueue and dequeue are O(1) and allocate nothing per tick.
`snapshot().queues` returns one array read out from head to tail.

**Worked example (Ch. 5.3.4).** The FCFS workload with `quantum = 4`:

| Process | Arrival | Burst |
|---|---|---|
| P1 | 0 | 24 |
| P2 | 0 | 3 |
| P3 | 0 | 3 |

Gantt: `P1[0-4] P2[4-7] P3[7-10] P1[10-30]` (P1's tail is five consecutive
quanta, which the world layer draws as five separate slices even though they are
contiguous).

| Process | Waiting | Turnaround | Response |
|---|---|---|---|
| P1 | 6 | 30 | 0 |
| P2 | 4 | 7 | 4 |
| P3 | 7 | 10 | 7 |

**Averages: waiting 5.666667, turnaround 15.666667, response 3.666667.**
Dispatches: 4. Quantum expiries: 5 (P1 at ticks 4, 14, 18, 22, 26). Test fixture
`SCHED-RR-1`. Assertions use a tolerance of 1e-9 on the averages.

Compare with `SCHED-FCFS-1`: average waiting rose from 17 to 5.67 and average
response fell from 17 to 3.67, while average turnaround rose from 27 to 15.67
for this workload. RR trades turnaround for response, which is the Ch. 5.3.4
point.

**Quantum sensitivity.** The same workload at other quanta, computed by the same
implementation, is fixture `SCHED-RR-2`:

| Quantum | Avg waiting | Avg turnaround | Avg response | Dispatches |
|---|---|---|---|---|
| 1 | 5.666667 | 15.666667 | 1.000000 | 10 |
| 4 | 5.666667 | 15.666667 | 3.666667 | 4 |
| 24 | 17.000000 | 27.000000 | 17.000000 | 3 |

At `quantum >= 24` round robin becomes FCFS exactly, which is the row the codex
uses to make the point that the quantum is a dial between the two behaviours.

**Pace mapping.** `TravelPolicy.pace` from `@game/types` sets the quantum:

| Pace | Quantum | Character |
|---|---|---|
| `conservative` | 16 | long slices, few switches, poor response |
| `steady` | 8 | balanced |
| `aggressive` | 4 | good response, more switch overhead |
| `reckless` | 1 | best response, switch overhead dominates |

With `contextSwitchTicks` set to 1 for Leg 3, `reckless` spends 50% of the CPU on
switching, which is the visible cost of a quantum that is too small (Ch. 5.3.4:
"the time quantum should be large with respect to the context-switch time").

### 5.8 MLFQ

Multilevel feedback queue, Ch. 5.3.6. This is the policy that must be specified
completely, because every parameter changes the behaviour.

**Levels.** Three by default. `SchedulerParams.levelQuanta` defines both the
count and the quantum per level; index 0 is the highest priority.

```
levelQuanta = [4, 8, 16]     // default
```

Level 2, the bottom level, is **FCFS**: a process at the bottom level runs its
quantum, and on expiry it is re-enqueued at the tail of level 2 rather than
demoted further, because there is nowhere lower.

**Selection rule.** Scan levels from 0 upward and pick the head of the first
non-empty queue.

**Preemption rule.** Two triggers, tested in this order:

1. **Quantum expiry.** If `sliceElapsed >= levelQuanta[running.queueLevel]`,
   demote: `queueLevel = min(queueLevel + 1, levelQuanta.length - 1)`, append to
   the tail of the new level, emit `quantum.expired` with `level` set to the
   level the process was *on* when it expired.
2. **Higher-level arrival.** If any ready process has `queueLevel` strictly less
   than the running process's `queueLevel`, preempt without demotion: the running
   process returns to the **tail of its current level** with its slice reset.

**Voluntary release keeps the level.** A process that blocks before its quantum
expires re-enters at its current level, not demoted. This is what makes
I/O-bound processes accumulate at level 0.

**Promotion by aging.** Every `agingInterval` ticks of continuous residence in
`ready`, a process on level `L > 0` is promoted to level `L - 1` and appended to
the tail of that level, with `readySince` reset to the current tick. The default
`agingInterval` for MLFQ is 50. This is the starvation cure of Ch. 5.3.6 and it
is what makes the bottom level survivable.

**Where I/O-bound processes end up.** A process that runs for 2 ticks and then
blocks on a device never reaches `sliceElapsed >= 4`, so it never demotes, so it
stays on level 0 forever. A process that computes continuously reaches 4, then 8,
then 16, and settles at level 2. **The queue level is a measurement of a process's
burst length that the scheduler makes without being told anything.** That
sentence is the MLFQ codex entry.

**Gaming the scheduler.** A process that issues a token I/O just before its
quantum expires stays at level 0 forever while doing almost no I/O. The sim
models this as the adversarial workload in Leg 3's optional encounter, and the
defence is the accounting rule from the same section of Ch. 5.3.6: track
cumulative CPU time at a level rather than per-slice time. The sim implements
both, selected by `mlfqAccounting: 'per_slice' | 'cumulative'`, default
`per_slice` so the pathology can be shown before the cure.

**Data structure.** An array of circular buffers, one per level, plus a
`Map<Pid, level>` mirror for O(1) membership. `snapshot().queues` returns one
array per level, so the world layer draws three processions at three heights.

**Worked example.** `levelQuanta = [4, 8, 16]`, `agingInterval = 50` (long
enough that no promotion fires inside this trace):

| Process | Arrival | Burst |
|---|---|---|
| P1 | 0 | 20 |
| P2 | 0 | 6 |
| P3 | 10 | 4 |

Trace:

- Ticks 0-3: P1 at level 0, quantum 4 expires. P1 demoted to level 1. Ready:
  [L0: P2] [L1: P1].
- Ticks 4-7: P2 at level 0, quantum 4 expires with 2 ticks of burst left. P2
  demoted to level 1. Ready: [L1: P1, P2].
- Tick 8: level 0 empty, level 1 head is P1. P1 runs with quantum 8.
- Tick 10: P3 arrives at level 0. Level 0 is now non-empty and 0 < 1, so P1 is
  preempted without demotion and goes to the tail of level 1. Ready:
  [L0: P3] [L1: P2, P1].
- Ticks 10-13: P3 runs 4 ticks and completes exactly as its quantum expires.
  A process that completes on the tick its quantum expires is **completed, not
  demoted**; the completion test runs before the demotion test.
- Ticks 14-15: P2 runs its remaining 2 and completes.
- Ticks 16-30: P1 runs its remaining 14 at level 1. Its quantum of 8 expires at
  tick 24, it demotes to level 2 and, with an empty ready set, is immediately
  redispatched, running to completion at tick 30.

Gantt: `P1[0-4] P2[4-8] P1[8-10] P3[10-14] P2[14-16] P1[16-30]`

| Process | Waiting | Turnaround | Response |
|---|---|---|---|
| P1 | 10 | 30 | 0 |
| P2 | 10 | 16 | 4 |
| P3 | 0 | 4 | 0 |

**Averages: waiting 6.666667, turnaround 16.666667, response 1.333333.**
Dispatches: 6. Final levels: P1 ended at level 2, P2 at level 1, P3 at level 0.
Test fixture `SCHED-MLFQ-1`.

The response-time number is the headline: 1.33 against 3.67 for round robin and
17.0 for FCFS on comparable workloads, because the short newcomer P3 went
straight to the front.

### 5.9 Starvation detection

Two thresholds, both in `SchedulerParams`, both measured in ticks of continuous
residence in state `ready`:

```
starvationThreshold        warning     default 120
starvationFatalThreshold   fatal       default 300
```

Phase 6 procedure, for each ready process in ascending pid order:

1. `waited = tick - readySince`. A process not in `ready` has `readySince === null`
   and is skipped.
2. Apply the convoy modifier: if this PCB's `convoyMemberId === 'sable'`,
   multiply both thresholds by 3 for this process only (SABLE's passive from the
   design brief).
3. If `waited === effectiveWarningThreshold`, emit
   `process.starving { pid, waitedTicks: waited, fatal: false }`. The strict
   equality means the warning fires exactly once per residence, not every tick
   afterwards.
4. If `waited >= effectiveFatalThreshold`, emit
   `process.starving { pid, waitedTicks: waited, fatal: true }`, then terminate
   the process with `terminationReason: 'starvation'` via transition T8.
5. `SchedulingMetrics.worstWait` is the maximum `waited` over all ready
   processes, recomputed in phase 10.

**Why the warning is a separate threshold.** The player needs time to act. The
gap of 180 ticks between warning and death is roughly 22 round-robin quanta at
the default pace, which is enough to notice the HUD, open the terminal, run
`ps`, see the `readySince` column, and change the scheduler. That gap is a
game-design number and legs may tune it, but the two-threshold structure is
fixed.

**Which policies can starve.** `fcfs` cannot starve a process that is ready
(every process eventually reaches the head), though it can make one wait
arbitrarily long. `sjf` and `srtf` starve long jobs under a stream of short ones.
`priority` starves low-priority processes and is the policy Leg 3 kills a Program
with. `priority_aging`, `rr` and `mlfq` (with aging on) are starvation-free, and
invariant I-16 asserts that `worstWait` under those three stays bounded by a
computable limit given the workload.

### 5.10 Metrics computation

Recomputed from scratch in phase 10:

```ts
function computeSchedulingMetrics(k: KernelState): SchedulingMetrics {
  const done = k.completed;                    // PCBs that reached 'zombie' or 'terminated'
  const n = done.length;
  const sum = (f: (p: PCB) => number) => done.reduce((s, p) => s + f(p), 0);

  return {
    averageWaitingTime:    n === 0 ? 0 : sum(p => p.turnaround - p.totalService) / n,
    averageTurnaroundTime: n === 0 ? 0 : sum(p => p.turnaround) / n,
    averageResponseTime:   n === 0 ? 0 : sum(p => p.firstRunTick - p.arrivalTick) / n,
    throughput:            k.tick === 0 ? 0 : (n * 100) / k.tick,
    cpuUtilisation:        k.tick === 0 ? 0 : k.busyTicks / k.tick,
    contextSwitches:       k.contextSwitches,
    worstWait:             Math.max(0, ...k.readyPids.map(p => k.tick - k.pcb(p).readySince!)),
  };
}
```

`turnaround`, `totalService` and `firstRunTick` are stored on the PCB when the
process completes, so this function never walks history. `busyTicks` and
`contextSwitches` are integer counters carried in `KernelSnapshot`, so restore is
exact. Every division is guarded against a zero denominator, and `Math.max` with
a spread over an empty array is guarded by the leading `0`.

---

## 6. Main memory (Ch. 9)

### 6.1 The two memory models

The simulator maintains both models of Ch. 9 simultaneously, because the game
needs both and because comparing them is the Leg 7 lesson:

- **Contiguous allocation (Ch. 9.2).** A byte-addressed hole list over a region
  of `contiguousBytes`. Used for the allocation-strategy comparison and for the
  external-fragmentation metric. Processes get a base and a limit.
- **Paging (Ch. 9.3).** A frame table of `KernelConfig.totalFrames` frames of
  `KernelConfig.pageSize` bytes each, plus one page table per
  `AddressSpaceId`. This is the model the rest of the kernel actually runs on.

Contiguous allocation is not a fallback for paging; it is a parallel model that
the Allocation Yards leg drives directly. `AllocationStrategy` selects the hole
policy, and `memory.allocated` carries the strategy that was used.

### 6.2 Contiguous allocation

```ts
interface Hole { start: number; size: number; }         // sorted by start, never overlapping
interface Partition { readonly pid: Pid; base: number; limit: number; requested: number; }
```

The hole list is kept sorted by `start` and adjacent free holes are **coalesced
on free**, which is required for buddy and correct for the others.

**First fit (Ch. 9.2.2).** Scan the hole list from index 0 and take the first
hole with `size >= request`. Split: the partition takes `[start, start + request)`
and the hole becomes `{start + request, size - request}`. A hole reduced to size
0 is removed.

**Best fit.** Take the hole with the smallest `size >= request`. Tie-break on
lower `start`. Implemented as a full scan, because the hole count is small
(bounded by the process count plus one) and a heap would need repair on every
coalesce.

**Worst fit.** Take the hole with the largest `size >= request`. Tie-break on
lower `start`.

**Buddy (Ch. 9.8.1).** Power-of-two allocation over a region whose size is a
power of two.

1. `order = ceil(log2(max(request, minBlock)))`, where `minBlock` is 4096 bytes
   by default.
2. Find the smallest free list index `k >= order` that is non-empty. If none,
   the allocation fails with `memory.allocation_failed { reason: 'no_space' }`.
3. While `k > order`: pop a block of order `k`, split it into two buddies of
   order `k - 1` at addresses `b` and `b + 2^(k-1)`, push both onto free list
   `k - 1` in ascending address order, decrement `k`.
4. Pop the lowest-address block from free list `order` and return it.
5. On free, compute the buddy address as `addr XOR 2^order`. If the buddy is
   free and of the same order, remove it and coalesce into order `order + 1`,
   then repeat. This is the coalescing that Ch. 9.8.1 highlights as buddy's
   advantage.

**Worked example (Ch. 9.8.1).** A 256 KB region, request of 21 KB, `minBlock`
1 KB:

```
256                                 initial free block, order 18 (2^18 = 256K)
128 | 128                           split
64 | 64 | 128                       split the first 128
32 | 32 | 64 | 128                  split the first 64
[21 in a 32K block] | 32 | 64 | 128 allocate
```

The allocation uses a 32 KB block for a 21 KB request. **Internal fragmentation
is 32 - 21 = 11 KB.** Free memory after the allocation is 32 + 64 + 128 = 224 KB
in three holes. Test fixture `MEM-BUDDY-1`.

### 6.3 Fragmentation as computed metrics

```ts
externalFragmentation = 1 - (largestFreeHole / totalFreeBytes)     // 0 when free memory is one hole
internalFragmentation = allocatedBytes - requestedBytes            // summed over live partitions
```

For paging, `internalFragmentation` is computed differently and is the one the
player sees on Leg 7:

```
internalFragmentation = sum over processes of (framesHeld * pageSize - bytesRequested)
```

which for a random request size averages `pageSize / 2` per process (Ch. 9.3.1).
`externalFragmentation` under paging is **exactly 0**, and the HUD shows it as 0
so that the contrast with the contiguous model is on screen at the same time.
That side-by-side is the argument for paging in one glance.

**Worked example.** Holes of 100 KB, 500 KB, 200 KB, 300 KB and 600 KB in that
address order; requests of 212 KB, 417 KB, 112 KB and 426 KB in that order.

**First fit:**

| Request | Hole taken | Leftover | Hole list after |
|---|---|---|---|
| 212 | 500 (index 1) | 288 | 100, 288, 200, 300, 600 |
| 417 | 600 (index 4) | 183 | 100, 288, 200, 300, 183 |
| 112 | 288 (index 1) | 176 | 100, 176, 200, 300, 183 |
| 426 | **fails** | none | 100, 176, 200, 300, 183 |

Free bytes 959 KB, largest hole 300 KB, external fragmentation
`1 - 300/959 = 0.687`. The 426 KB request fails with
`memory.allocation_failed { reason: 'fragmentation' }`, because free memory
(959 KB) exceeds the request but no single hole does. That distinction between
`'no_space'` and `'fragmentation'` in the frozen event type is exactly this test.

**Best fit:**

| Request | Hole taken | Leftover | Hole list after |
|---|---|---|---|
| 212 | 300 | 88 | 100, 500, 200, 88, 600 |
| 417 | 500 | 83 | 100, 83, 200, 88, 600 |
| 112 | 200 | 88 | 100, 83, 88, 88, 600 |
| 426 | 600 | 174 | 100, 83, 88, 88, 174 |

**All four fit.** Free bytes 533 KB, largest hole 174 KB, external fragmentation
`1 - 174/533 = 0.674`.

**Worst fit:**

| Request | Hole taken | Leftover | Hole list after |
|---|---|---|---|
| 212 | 600 | 388 | 100, 500, 200, 300, 388 |
| 417 | 500 | 83 | 100, 83, 200, 300, 388 |
| 112 | 388 | 276 | 100, 83, 200, 300, 276 |
| 426 | **fails** | none | 100, 83, 200, 300, 276 |

Free bytes 959 KB, largest hole 300 KB.

Test fixture `MEM-FIT-1`. Best fit places all four; first fit and worst fit both
strand the last request. This is the standard result and the reason the codex
tells the player that worst fit's stated intent (leave a large usable remainder)
does not survive contact with a real request stream.

### 6.4 Paging address translation (Ch. 9.3.1)

For a logical address space of `2^m` bytes and a page size of `2^n` bytes, a
logical address `L` splits as:

```
pageNumber p = L >>> n                  the high (m - n) bits
offset     d = L & ((1 << n) - 1)       the low n bits
```

and the physical address is:

```
physical = (frameNumber << n) | d
```

`KernelConfig.pageSize` must be a power of two; the kernel throws on
construction otherwise, because the shift arithmetic above is the only
translation path and a non-power-of-two would silently need division.

```ts
export function splitAddress(logical: number, pageSize: number): { page: PageId; offset: number } {
  const n = Math.log2(pageSize);                       // integral by construction
  return {
    page: (logical >>> n) as PageId,
    offset: logical & (pageSize - 1),
  };
}
```

**Worked example A (Ch. 9.3.1's own figure).** Page size 4 bytes, physical memory
32 bytes (8 frames), page table `[5, 6, 1, 2]`.

| Logical | p = L >> 2 | d = L & 3 | Frame | Physical = f*4 + d |
|---|---|---|---|---|
| 0 | 0 | 0 | 5 | 20 |
| 3 | 0 | 3 | 5 | 23 |
| 4 | 1 | 0 | 6 | 24 |
| 13 | 3 | 1 | 2 | 9 |

Test fixture `MEM-XLATE-1`.

**Worked example B (the realistic one the terminal prints).** 32-bit logical
address space, page size 4 KB (`n = 12`), so `p` is 20 bits and `d` is 12 bits;
the page table has `2^20 = 1,048,576` entries.

Logical address `0x00003ABC`:

```
p = 0x00003ABC >>> 12 = 0x00000003 = 3
d = 0x00003ABC & 0xFFF = 0xABC = 2748
```

If page 3 maps to frame `0x0000000C` (12), then:

```
physical = (12 << 12) | 2748 = 49152 + 2748 = 51900 = 0x0000CABC
```

Test fixture `MEM-XLATE-2`. The hexadecimal makes the point that the offset is
copied through untouched, which is the whole trick of paging.

### 6.5 The TLB (Ch. 9.3.2)

```ts
interface TlbEntry {
  space: AddressSpaceId;      // ASID, so a context switch need not flush
  page: PageId;
  frame: FrameId;
  valid: boolean;
  lastUsedTick: Tick;
}
```

`KernelConfig.tlbEntries` sets the size, defaulting to 16 for legibility (a real
TLB is 32 to 1024 entries; 16 fits on screen as a diegetic object). Replacement
within the TLB is **LRU by `lastUsedTick`**, tie-broken by lowest slot index.

Lookup, on every `access` instruction:

1. Scan for an entry with matching `space` and `page` and `valid`. Hit: update
   `lastUsedTick`, emit `memory.access { hit: true }`, cost `tlbHitTicks`.
2. Miss: emit `tlb.miss`, then consult the page table. Cost
   `tlbMissTicks`. On a valid PTE, install the mapping in the TLB, evicting the
   LRU slot if full. On an invalid PTE, this becomes a page fault (§7.2).

The TLB is tagged with an ASID, so a context switch does **not** flush it. The
`ioctl` syscall with argument `"tlb_flush"` flushes it explicitly, which is what
`exec` does and what a page table teardown does. Invariant I-9 asserts that no
TLB entry names a frame whose `owner` differs from the entry's `space`.

**Effective access time (Ch. 9.3.2).** With hit ratio `h`, memory access time
`M`, and TLB search time `E`:

```
EAT = h * (E + M) + (1 - h) * (E + 2M)
    = E + M + (1 - h) * M
```

The textbook's simplification takes `E` as negligible. With `M = 100 ns` and
`E = 0`:

| Hit ratio | EAT | Slowdown vs 100 ns |
|---|---|---|
| 0.50 | 150.00 ns | 50% |
| 0.80 | 120.00 ns | 20% |
| 0.90 | 110.00 ns | 10% |
| 0.99 | 101.00 ns | 1% |

With `E = 10 ns`: `h = 0.80` gives 130.00 ns, `h = 0.99` gives 111.00 ns. Test
fixture `MEM-TLB-1`.

**Conversion to ticks.** The kernel does not model nanoseconds in its tick
budget; it uses `tlbHitTicks = 1` and `tlbMissTicks = 2`, which is the same 1:2
ratio the EAT formula produces at `E = 0`. `MemoryMetrics.tlbHitRate` is a real
number recomputed in phase 10 as `tlbHits / (tlbHits + tlbMisses)`, and the HUD
converts it to an EAT in nanoseconds using the table above so the player sees a
number they can compare to the textbook.

### 6.6 The frame table and allocation

```ts
class FrameTable {
  readonly frames: Frame[];                  // dense, index === FrameId
  private freeList: FrameId[];               // ascending, so allocation is deterministic
  allocate(space: AddressSpaceId, page: PageId, pinned: boolean): FrameId | null;
  free(id: FrameId): void;
}
```

`freeList` is kept **ascending by frame id** at all times. On `free`, the id is
inserted at its sorted position rather than pushed, which costs O(n) on a small
n and buys the property that a snapshot restore reproduces allocations exactly
regardless of the free order that produced the list.

Frame allocation policy for paging is per-process and comes from
`TravelPolicy.rations`:

| Rations | Frames per process | Ch. 10.5 name |
|---|---|---|
| `generous` | `floor(totalFrames / activeProcesses) * 1.5`, capped | proportional, over-allocated |
| `standard` | `floor(totalFrames / activeProcesses)` | equal allocation |
| `lean` | `max(minFrames, floor(totalFrames / activeProcesses) * 0.6)` | under proportional |
| `starved` | `minFrames` | minimum allocation |

`minFrames` is 3, which is the Ch. 10.5.1 figure: an instruction that references
two operands plus its own page needs at least three frames or it faults forever
on a single instruction. Allocation below `minFrames` throws in dev builds and is
clamped in production.

The allocation scheme is `AllocationScheme = 'equal' | 'proportional'` with
proportional weighting by `pcb.pageCount`, matching Ch. 10.5.3. Replacement scope
is `'local' | 'global'`, defaulting to `'local'`, because global replacement is
what lets one process steal frames from another and drive the whole system into
thrashing, and Leg 8 turns it on deliberately.

---

## 7. Virtual memory (Ch. 10)

### 7.1 Demand paging (Ch. 10.2)

A page is resident when its `PageTableEntry.valid` is true and `frame` is
non-null. Nothing is loaded before it is touched. A process admitted with 40
pages holds 0 frames until its first access, which is what makes the Drowned
Reach materialise under the convoy's feet rather than in advance.

`PageTableEntry` fields and who writes them:

| Field | Written by |
|---|---|
| `frame` | page-in and eviction |
| `valid` | page-in (true), eviction (false) |
| `dirty` | any write access; cleared on write-back |
| `referenced` | every access; cleared by the clock hand and by the working-set scan |
| `readable`/`writable`/`executable` | `mmap`, `chmod`, COW downgrade |
| `swapped` | true when the page has a backing-store copy |
| `lastAccessTick` | every access; read by LRU |
| `accessCount` | every access; read by LFU |

### 7.2 The page fault service path (Ch. 10.2.1)

Numbered, and this is the exact order the implementation must follow:

1. The access instruction executes in phase 8. The TLB misses.
2. The page table entry is examined. `valid === false` means a fault. Emit
   `memory.page_fault { pid, page, major }` where `major` is computed in step 4.
3. **Protection check first.** If the access is a write and
   `writable === false`, and the frame is not COW-shared, this is a protection
   fault: emit `security.access_denied` and terminate the process with
   `terminationReason: 'protection_fault'`. A protection violation is never
   serviced as a fault.
4. **Classify.**
   - **Minor fault:** the page's frame is still resident and merely unmapped
     (it is in the free-list-but-not-yet-reused pool, or it is a COW copy, or it
     is shared and already loaded by another process). No backing-store I/O.
     `major = false`. Cost `minorFaultTicks` (default 1).
   - **Major fault:** the page must be read from the backing store.
     `major = true`. Cost is a disk request (§10.2), typically tens of ticks. The
     process transitions T5 with `blockedOn = {kind: 'page_fault', page}`.
5. **Find a frame.** If the free list is non-empty, take its head. Otherwise call
   `PageReplacementPolicy.selectVictim(ctx)` (§7.4).
6. **Evict the victim.** If `victim.dirty`, enqueue a write-back disk request and
   emit `memory.page_evicted { dirty: true }`; the fault is not complete until
   the write-back completes, which doubles the service time. This is the reason
   Ch. 10.4.1 recommends the modify bit. If clean, discard and emit
   `memory.page_evicted { dirty: false }`. Invalidate the victim's PTE, set
   `swapped = true` on it, and shoot down any TLB entry naming that frame.
7. **Read in.** For a major fault, enqueue a read disk request for the page's
   backing block and block the process. For a minor fault, complete immediately.
8. **Install.** Set `frame`, `valid = true`, `dirty = false`,
   `referenced = true`, `lastAccessTick = tick`, `accessCount += 1`. Set the
   frame's `owner`, `page`, `loadedAtTick`, `referenceBit = true`. Call
   `PageReplacementPolicy.onLoad`. Emit `memory.page_loaded`.
9. **Restart the instruction.** The faulting access is re-executed from the
   beginning on the next tick the process runs. It does not consume a second unit
   of service; `programCounter` is not advanced by a fault. This restart is what
   Ch. 10.2.1 means by "restart the instruction that was interrupted", and
   invariant I-8 checks that a fault never advances the program counter.

**Effective access time under demand paging (Ch. 10.2.3).** With fault
probability `p`, memory access `ma = 200 ns`, and page fault service time
`8 ms = 8,000,000 ns`:

```
EAT = (1 - p) * ma + p * 8,000,000
```

| p | EAT | Slowdown |
|---|---|---|
| 0 | 200.0000 ns | 1.0000x |
| 1e-6 | 207.9998 ns | 1.0400x |
| 2.5000625e-6 | 219.9995 ns | 1.1000x |
| 1e-5 | 279.9980 ns | 1.4000x |
| 1e-4 | 999.9800 ns | 4.9999x |
| 1e-3 | 8199.8000 ns | 41.0x |

For degradation under 10 percent, `p < 2.5000625e-6`, which is **fewer than one
fault per 399,990 memory accesses**. Test fixture `VM-EAT-1`. That number is the
single most persuasive figure in Ch. 10 and it is printed on the Leg 8 debrief
card.

### 7.3 Minor versus major faults, and copy-on-write

Three sources of minor faults in this simulator:

1. **COW write fault** (§3.4). Parent and child share a frame read-only; the
   first write by either allocates a private copy.
2. **Shared-region first touch.** A process attaches a `SharedRegion` whose pages
   are already resident for another process. The PTE is installed pointing at the
   existing frame.
3. **Reclaim from the free pool.** A frame freed but not yet reused still holds
   its old page. If the owning process touches it again before reuse, the mapping
   is restored without I/O. The free pool retains up to `freePoolRetain` frames
   (default 4) in eviction order for exactly this purpose, which is a small model
   of Linux's page cache and is what makes `majorFaults < pageFaults` in
   `MemoryMetrics`.

`MemoryMetrics.pageFaults` counts all faults; `majorFaults` counts only those
that touched the backing store. The HUD shows both, because a high total with a
low major count is healthy and a player who reads only the total will make the
wrong decision.

### 7.4 The page replacement interface

```ts
interface PageReplacementPolicy {
  reset(frames: readonly Frame[]): void;
  onAccess(space, page, frame, ctx): void;   // called on every hit AND after every load
  onLoad(space, page, frame, ctx): void;     // called when a page is installed
  selectVictim(ctx: MemoryContext): FrameId;
  snapshot(): PageReplacementSnapshot;
}
```

Contract points that the implementations depend on:

- `selectVictim` is called **only when no free frame exists**. It must return a
  frame that is currently in use and not `pinned`. If every candidate frame is
  pinned, it throws, and the kernel converts that into
  `memory.allocation_failed { reason: 'no_space' }` and terminates the requesting
  process with `out_of_memory`.
- Under local replacement, `ctx.frames` is filtered to the faulting process's
  own frames before the call. Under global replacement it is every unpinned
  frame. The policies do not know which mode they are in, and that is why the
  same six policies serve both.
- `snapshot().order` is the policy's own victim ordering, most-likely-victim
  first, which the world layer draws as a queue of slabs.

The six policies are stateless with respect to the kernel: everything they need
is either in `Frame` (which carries `loadedAtTick`, `lastAccessTick`,
`referenceBit`) or in their own private structure that is included in the
snapshot.

### 7.5 The six policies

Throughout, the **reference string** is the Ch. 10.4 standard:

```
7, 0, 1, 2, 0, 3, 0, 4, 2, 3, 0, 3, 2, 1, 2, 0, 1, 7, 0, 1
```

with **three frames**, all initially free.

#### FIFO (Ch. 10.4.2)

**Victim rule.** The frame with the smallest `loadedAtTick`. Tie-break on lowest
`FrameId`.

**Structure.** A queue of `FrameId` in load order, plus a `nextIndex` cursor when
implemented over a fixed array. The implementation below uses the cursor form
because it makes the Belady demonstration easier to trace.

**Result on the standard string: 15 faults.**

| Ref | Action | Frames after |
|---|---|---|
| 7 | fault | 7, -, - |
| 0 | fault | 7, 0, - |
| 1 | fault | 7, 0, 1 |
| 2 | fault, evict 7 | 2, 0, 1 |
| 0 | hit | 2, 0, 1 |
| 3 | fault, evict 0 | 2, 3, 1 |
| 0 | fault, evict 1 | 2, 3, 0 |
| 4 | fault, evict 2 | 4, 3, 0 |
| 2 | fault, evict 3 | 4, 2, 0 |
| 3 | fault, evict 0 | 4, 2, 3 |
| 0 | fault, evict 4 | 0, 2, 3 |
| 3 | hit | 0, 2, 3 |
| 2 | hit | 0, 2, 3 |
| 1 | fault, evict 2 | 0, 1, 3 |
| 2 | fault, evict 3 | 0, 1, 2 |
| 0 | hit | 0, 1, 2 |
| 1 | hit | 0, 1, 2 |
| 7 | fault, evict 0 | 7, 1, 2 |
| 0 | fault, evict 1 | 7, 0, 2 |
| 1 | fault, evict 2 | 7, 0, 1 |

Test fixture `VM-FIFO-1`.

#### LRU (Ch. 10.4.4)

**Victim rule.** The frame whose page has the smallest `lastAccessTick`.
Tie-break on lowest `FrameId`. Frames never accessed since load use their
`loadedAtTick`.

**Structure.** The counter implementation of Ch. 10.4.4: `lastAccessTick` on the
PTE and on the `Frame`, updated in `onAccess`. `selectVictim` is an O(n) scan,
which is honest about what LRU costs in hardware and is fast enough here. The
stack implementation is available as `snapshot().order` so the world layer can
draw the recency stack.

**Result on the standard string: 12 faults.** Evictions in order: 7, 1, 2, 3, 0,
4, 0, 3, 2. Test fixture `VM-LRU-1`.

#### Clock, or second chance (Ch. 10.4.5.2)

**Victim rule.**

```
1. while frames[hand].referenceBit is true:
2.     frames[hand].referenceBit = false
3.     hand = (hand + 1) mod frameCount
4. victim = hand
5. after installing the new page at `victim`:
6.     frames[victim].referenceBit = true
7.     hand = (victim + 1) mod frameCount
```

The loop terminates because each iteration clears one reference bit, so after at
most `frameCount` iterations some bit is false. Setting the new page's reference
bit to true at step 6 is required (a freshly loaded page has just been
referenced) and is what makes clock differ from FIFO.

**Structure.** The frame array plus one integer `hand`, exposed as
`snapshot().handIndex`. The whole state is two numbers, which is why this policy
is the one real kernels use.

**Result on the standard string: 14 faults.** Evictions in order: 7, 1, 2, 0, 3,
4, 2, 0, 3, 1, 2. Trace of the interesting part, showing the hand sweeping:

| Ref | Hand before | Bits before | Action | Hand after |
|---|---|---|---|---|
| 4 (8th ref) | 0 | 1,1,1 | clears all three, wraps to 0, evicts frame 0 (page 2) | 1 |
| 2 (9th ref) | 1 | 1,0,0 | frame 1's bit is already 0, evicts frame 1 (page 0) | 2 |
| 0 (11th ref) | 2 | 1,1,1 | full sweep clearing all three, evicts frame 2 (page 3) | 0 |

Test fixture `VM-CLOCK-1`. Clock lands between FIFO (15) and LRU (12), which is
its entire selling point and which the player sees as a number on the HUD.

#### Optimal (Ch. 10.4.3)

**Victim rule.** The frame whose page has the largest distance to its next use in
`ctx.futureReferences`. A page never referenced again has distance `+Infinity`.
Tie-break among equal distances (which in practice means several pages never used
again) on **lowest frame index**, so the choice is deterministic.

**Availability.** `ctx.futureReferences` is non-null only when every runnable
process has a scripted reference string. Outside that, `selectVictim` throws and
the kernel refuses the policy (§2.3).

**Result on the standard string: 9 faults.** Evictions in order: 7, 1, 0, 4, 3,
2. Test fixture `VM-OPT-1`. This is the floor: no policy can do better on this
string with three frames, which is what makes it useful as the denominator of
the player's efficiency score.

#### LFU (Ch. 10.4.7)

**Victim rule.** The frame whose page has the smallest `accessCount`. Tie-break
on smallest `loadedAtTick`, then lowest `FrameId`.

**Counter policy.** `accessCount` starts at 1 when the page is loaded (the load
is itself a reference) and increments on every access. When a page is evicted its
count is **discarded**, not retained. Retaining counts across eviction is a
defensible variant and produces different numbers, so the discard rule is
normative here.

**Result on the standard string: 13 faults.** Evictions in order: 7, 1, 2, 3, 4,
2, 1, 2, 1, 7. Test fixture `VM-LFU-1`.

**The known pathology,** which Ch. 10.4.7 states and which this trace shows: page
0 accumulates a count of 6 and becomes unevictable, so the last third of the
string thrashes pages 1, 2 and 7 through a single frame. The remedy the codex
gives is aging the counters by right-shifting them periodically, available as
`lfuAging: number` (shift every N ticks, default 0 = off).

#### Random (Ch. 10.4.8 in spirit)

**Victim rule.** `ctx.rng.pick(eligibleFrames)` where `eligibleFrames` is the
unpinned subset of `ctx.frames`, in ascending `FrameId` order. The array must be
built in ascending order every time, because `pick` draws an index and the index
means nothing unless the order is fixed.

**Stream.** `root/vm`. Exactly one `next()` per victim selection, so the fault
count for a given seed is reproducible and is itself a fixture.

**Result on the standard string with `createRng(1234).fork('vm')`:** recorded at
implementation time and frozen as `VM-RANDOM-1`. The policy exists as the
control condition: it shows the player that LRU and clock are earning their
complexity, and it is the policy the adversarial workload in Leg 8 forces on
them.

### 7.6 Belady's anomaly (Ch. 10.4.2)

**Reference string:**

```
1, 2, 3, 4, 1, 2, 5, 1, 2, 3, 4, 5
```

**FIFO with three frames: 9 faults.**

| Ref | Action | Frames |
|---|---|---|
| 1 | fault | 1, -, - |
| 2 | fault | 1, 2, - |
| 3 | fault | 1, 2, 3 |
| 4 | fault, evict 1 | 4, 2, 3 |
| 1 | fault, evict 2 | 4, 1, 3 |
| 2 | fault, evict 3 | 4, 1, 2 |
| 5 | fault, evict 4 | 5, 1, 2 |
| 1 | hit | 5, 1, 2 |
| 2 | hit | 5, 1, 2 |
| 3 | fault, evict 1 | 5, 3, 2 |
| 4 | fault, evict 2 | 5, 3, 4 |
| 5 | hit | 5, 3, 4 |

**FIFO with four frames: 10 faults.**

| Ref | Action | Frames |
|---|---|---|
| 1 | fault | 1, -, -, - |
| 2 | fault | 1, 2, -, - |
| 3 | fault | 1, 2, 3, - |
| 4 | fault | 1, 2, 3, 4 |
| 1 | hit | 1, 2, 3, 4 |
| 2 | hit | 1, 2, 3, 4 |
| 5 | fault, evict 1 | 5, 2, 3, 4 |
| 1 | fault, evict 2 | 5, 1, 3, 4 |
| 2 | fault, evict 3 | 5, 1, 2, 4 |
| 3 | fault, evict 4 | 5, 1, 2, 3 |
| 4 | fault, evict 5 | 4, 1, 2, 3 |
| 5 | fault, evict 1 | 4, 5, 2, 3 |

**More memory produced more faults: 9 with three frames, 10 with four.** Test
fixture `VM-BELADY-1`.

For contrast on the same string, computed by the same implementations:

| Policy | 3 frames | 4 frames |
|---|---|---|
| FIFO | 9 | **10** |
| LRU | 10 | 8 |
| OPT | 7 | 6 |

LRU and OPT are **stack algorithms** (Ch. 10.4.2): the set of pages resident with
`n` frames is always a subset of the set resident with `n + 1` frames, so they
cannot exhibit the anomaly. FIFO is not a stack algorithm, and the table above is
the proof by counterexample. The Leg 8 encounter hands the player more frames and
watches the fault count go up, which is the point at which they stop trusting
intuition and start reading the policy.

### 7.7 The working set model (Ch. 10.6.2)

```
WS(t, Δ) = the set of distinct pages referenced in the Δ most recent references
WSS_i    = |WS(t, Δ)| for process i
D        = Σ WSS_i        the total demand for frames
```

`Δ` is `workingSetWindow`, default 10 references, which is the textbook's own
figure and is small enough to draw.

**Implementation.** Each process keeps a fixed-capacity ring buffer of its last
`Δ` referenced `PageId`s, plus a `Map<PageId, number>` of counts so that
`WSS` is `map.size` in O(1). Push evicts the oldest and decrements its count,
deleting the key at zero. The ring buffer is part of the snapshot.

`MemoryMetrics.workingSets` is `ReadonlyMap<Pid, number>` rebuilt in phase 10 as
`pid -> ringBuffer.distinctCount`.

**Worked example (Ch. 10.6.2's own figure).** Reference string, with Δ = 10:

```
... 2 6 1 5 7 7 7 7 5 1 | 6 2 3 4 1 2 3 4 4 4 | 3 4 3 4 4 4 1 3 2 3 | 4 4 4 3 4 4 4 ...
                        ▲ t1                                        ▲ t2
```

At `t1` the window holds `2 6 1 5 7 7 7 7 5 1`, so `WS(t1) = {1, 2, 5, 6, 7}` and
`WSS = 5`.

At `t2` the window holds `3 4 3 4 4 4 3 4 4 4`, so `WS(t2) = {3, 4}` and
`WSS = 2`.

Test fixture `VM-WS-1`. The pair shows the locality shift: the process moved from
one locality of five pages to another of two, and the window caught it.

**VESPER's passive.** The design brief gives VESPER "working set estimation is
30% more accurate". Concretely: without VESPER the sim reports
`WSS_reported = WSS_true + noise` where `noise` is drawn from
`rng.int(-2, 3)` on the `root/vm` stream once per 10 ticks per process; with
VESPER alive the noise range narrows to `rng.int(-1, 2)`. The reported value is
what the HUD and the `vmstat` terminal command show. The true value is what the
thrashing test uses, so VESPER makes the player's information better without
changing the physics.

**Program reference generation.** Unscripted processes generate references from a
locality model so that working sets mean something:

1. A process has a current locality: a contiguous run of `localitySize` pages
   (default 4), starting at `localityBase`.
2. With probability `1 - localityShiftChance` (default 0.98) the next reference
   is `localityBase + rng.int(0, localitySize)`.
3. Otherwise the locality shifts: `localityBase = rng.int(0, pageCount - localitySize)`.
4. Writes occur with probability `writeRatio` (default 0.3).

All draws come from `root/vm`. This gives phase behaviour that the working set
window can actually detect, which is what Ch. 10.6.1's locality argument
requires.

### 7.8 Thrashing (Ch. 10.6)

**The condition.** Thrashing is `D > m`: the sum of the working set sizes exceeds
the number of available frames. When that holds, every process's working set is
partly resident, every process faults on nearly every access, and CPU
utilisation collapses while paging I/O saturates.

**Detection.** Two independent signals, both computed in phase 10, and the sim
uses both because each catches a case the other misses.

*Signal A, the fault rate.* A smoothed faults-per-thousand-ticks figure:

```ts
// integer-friendly EWMA with alpha = 1/8, updated every tick
faultAccumulator = faultAccumulator - (faultAccumulator >> 3) + faultsThisTick;
faultRate = (faultAccumulator * 1000) / (8 * 1);       // faults per 1000 ticks
```

The shift-based EWMA is used rather than a float multiply so that the value is
bit-identical after a snapshot restore. `MemoryMetrics.faultRate` is this number.

*Signal B, the demand ratio.* `D / m` where `D = Σ WSS_true` and
`m = totalFrames`.

**The three severity bands:**

| Band | Condition | Event | Kernel response |
|---|---|---|---|
| healthy | `faultRate < thrashingThreshold` and `D <= m` | none | none |
| warning | `faultRate >= thrashingThreshold` or `D > m` | `memory.thrashing { severity: 'warning' }` | stop admitting new processes (phase 5 admits nothing) |
| critical | `faultRate >= 2 * thrashingThreshold` or `D > 1.5 * m` | `memory.thrashing { severity: 'critical' }` | suspend the process with the largest `WSS`, swap out its entire working set, and reduce the effective degree of multiprogramming by 1 |

`KernelConfig.thrashingThreshold` is faults per thousand ticks, default 200.

**Escalation.** While critical persists, the kernel suspends one more process
every `thrashingSuspendInterval` ticks (default 50), always the largest working
set first, tie-broken by highest pid. A suspended process moves to `waiting` with
`blockedOn = {kind:'sleep', untilTick: tick + thrashingSuspendDuration}`. If the
suspension queue reaches every process except one and the fault rate is still
critical, the remaining process is terminated with
`terminationReason: 'thrashing_collapse'` and `kernel.panic` is emitted. That is
the total collapse, and it is how a convoy dies on Leg 8.

**De-escalation.** When `faultRate` falls below `thrashingThreshold` and
`D <= m` for `thrashingRecoveryTicks` consecutive ticks (default 100), suspended
processes are resumed one per interval, lowest pid first.

**The player's controls,** and what each does to the condition:

| Verb | Effect on `D > m` |
|---|---|
| lower `degreeOfMultiprogramming` | reduces the number of terms in `D` |
| set rations to `generous` | raises frames per process, but does not change `m`, so it helps only if some process was below its working set |
| switch to a better replacement policy | reduces faults per unit of `D`, buying time, and does not fix `D > m` |
| LUMEN's `recompile` | halves one process's remaining burst, so it finishes sooner and leaves `D` |
| KESTREL's `prefetch` | satisfies the next 5 faults instantly, a pure stall of the collapse |
| VESPER's `remap` | rebuilds one page table with optimal locality, which shrinks that process's true `WSS` |

The correct answer is the first row, and every other row is a partial measure
that buys the player time to find it. That is the Leg 8 design.

**Page-fault-frequency control (Ch. 10.6.3).** An alternative to the working-set
model, offered as `thrashingControl: 'working_set' | 'pff'`. Under PFF, each
process has an upper and lower fault-rate bound (default 300 and 50 per thousand
ticks); exceeding the upper bound grants it another frame, falling below the
lower bound takes one away, and a grant with no free frame available suspends a
process. The player can switch between the two and compare, which is Leg 8's
advanced objective.

---

## 8. Synchronisation (Ch. 6 and 7)

### 8.1 The critical section problem (Ch. 6.2)

A solution must satisfy three requirements. The simulator checks all three and
reports which one a given scenario violates.

1. **Mutual exclusion.** If process `P` is executing in its critical section,
   no other process executes in theirs. *Checked by:* a per-primitive counter
   `inCriticalSection` that must never exceed the primitive's capacity.
   Invariant I-20.
2. **Progress.** If no process is in its critical section and some processes want
   to enter, only those not in their remainder section participate in deciding
   who enters next, and the decision cannot be postponed indefinitely.
   *Checked by:* if the primitive is free and its `waitQueue` is non-empty for
   `progressStallLimit` consecutive ticks (default 4), emit `kernel.panic` with
   `"progress violated on <resource>"`. A correct implementation never triggers
   it; the deliberately broken teaching implementations do.
3. **Bounded waiting.** There is a bound on the number of times other processes
   may enter their critical sections after a process makes a request and before
   that request is granted. *Checked by:* each waiter records
   `entriesObservedWhileWaiting`; if it exceeds `boundedWaitLimit` (default: the
   number of processes contending, which is the bound Ch. 6.2 asks for), emit
   `process.starving { fatal: false }` against that pid. `SyncPrimitive.ordered`
   distinguishes the two cases: `ordered: true` means the wait queue is FIFO,
   which gives a bound of `n - 1`; `ordered: false` means the wake target is
   drawn with `rng.pick`, which gives no bound and will eventually trigger the
   check. Leg 4 runs both and lets the player watch the unordered one starve
   somebody.

### 8.2 Peterson's solution (Ch. 6.3)

Implemented as a scenario, not as a kernel primitive, because its purpose is to
be examined and then discarded.

```
// Shared between exactly two processes, i and j = 1 - i
boolean flag[2] = { false, false };
int turn;

// Entry section for process i
1. flag[i] = true;
2. turn = j;
3. while (flag[j] && turn == j) { /* spin */ }
4. // critical section
5. flag[i] = false;
6. // remainder section
```

Each numbered line is one `Instruction` in the process's program, so the
simulator interleaves at exactly the granularity that makes the argument. The
proof of correctness in Ch. 6.3 rests on `turn` holding one value, and the
simulator reproduces it: run the scenario for 10,000 ticks under
`SYNC-PETERSON-1` and assert `inCriticalSection <= 1` at every tick.

**Why it fails on real hardware, and how the sim shows it.** Ch. 6.3 notes that
the solution assumes loads and stores are executed in program order. Modern
processors reorder independent memory operations. Line 1 writes `flag[i]` and
line 2 writes `turn`; those are independent addresses, so a processor may commit
them in the opposite order. If both processes have their line 1 and line 2
reordered, both can observe `flag[j] === false` at line 3 and both enter.

The simulator models this with a per-scenario flag:

```ts
interface MemoryOrderModel {
  /** When true, a store may be delayed by up to `storeBufferDepth` instructions. */
  readonly reordering: boolean;
  readonly storeBufferDepth: number;      // default 2
}
```

Under `reordering: true`, a store instruction is placed into a per-process store
buffer instead of being applied. The buffer drains one entry per tick, in FIFO
order, **except** that the sim drains it in an order chosen by
`rng.shuffle` on the `root/sync` stream when `storeBufferDepth > 1`, which models
a processor free to commit independent stores in any order. A `mfence`
instruction drains the buffer completely before proceeding.

Running `SYNC-PETERSON-2` (the same scenario with `reordering: true`) produces a
mutual exclusion violation within 10,000 ticks for the reference seed, emits
`sync.race_detected`, and is the fixture that proves the point. Inserting
`mfence` between lines 2 and 3 makes it correct again, and that is the exercise
Leg 4 sets.

### 8.3 Hardware instructions (Ch. 6.4)

Both are modelled as **atomic within a single tick**, which is the definition of
an atomic instruction in a tick-quantised simulator.

**Test-and-set (Ch. 6.4.1).**

```
boolean test_and_set(boolean *target) {
    boolean rv = *target;
    *target = true;
    return rv;
}

// Spinlock using it
do {
    while (test_and_set(&lock)) { /* spin, burning a tick each time */ }
    // critical section
    lock = false;
    // remainder
} while (true);
```

This satisfies mutual exclusion. It does **not** satisfy bounded waiting: a
process can lose the race arbitrarily many times. The sim's bounded-waiting check
from §8.1 fires against the loser, which is how the player discovers the flaw
without being told it.

Each spin iteration costs one tick and emits `sync.busy_wait { spunTicks }`.
Those wasted ticks are counted in `SchedulingMetrics.cpuUtilisation` as *busy*,
which is exactly why busy waiting is deceptive: utilisation looks perfect while
nothing is accomplished. The `top` terminal command shows a separate `spin%`
column so the player can find it.

**Compare-and-swap (Ch. 6.4.2).**

```
int compare_and_swap(int *value, int expected, int new_value) {
    int temp = *value;
    if (*value == expected) *value = new_value;
    return temp;
}
```

CAS is used for the lock-free counter in the race-condition scenario (§8.6),
where the player can fix a race either by taking a mutex or by retrying a CAS,
and can then compare the two on the metrics.

The bounded-waiting version of Ch. 6.4.2, using `waiting[]` and a hand-off, is
available as `SYNC-CAS-BOUNDED` and is the correct answer to the exercise the leg
sets.

### 8.4 The primitives

All five kinds share `SyncPrimitive` from `types.ts`. Semantics per kind:

| Kind | `value` means | `capacity` | `holders` | Wake policy |
|---|---|---|---|---|
| `mutex` | 1 free, 0 held | 1 | 0 or 1 pids | head of `waitQueue` |
| `semaphore` | current count | initial count | pids that decremented and have not posted | head, or `rng.pick` when `ordered: false` |
| `monitor` | 1 free, 0 held (the monitor lock) | 1 | 0 or 1 | head; condition queues are separate |
| `rwlock` | reader count, or -1 when a writer holds it | max readers | all current readers, or the single writer | writer-preferring, see below |
| `barrier` | processes arrived | party size | all arrived | all released at once when `value === capacity` |

**Mutex (Ch. 6.5).**

```
mutex_lock(m):
  1. if m.value == 1: m.value = 0; m.holders = [pid]; emit sync.acquired; return ok
  2. else: append pid to m.waitQueue; block with {kind:'mutex', resource: m.id}
           emit sync.blocked { queueLength: m.waitQueue.length }

mutex_unlock(m):
  1. if m.holders does not contain pid: return EPERM
  2. m.holders = []
  3. if m.waitQueue is non-empty:
        w = m.waitQueue.shift()
        m.holders = [w]; m.value stays 0        // direct hand-off, no window
        mark w wakeable; emit sync.released { woke: w }
     else:
        m.value = 1; emit sync.released { woke: null }
```

The **direct hand-off** at step 3 matters. If `mutex_unlock` set `value = 1` and merely
woke the waiter, a third process could acquire the mutex between the wake and the
waiter's dispatch, which is the barging behaviour that breaks bounded waiting.
Hand-off makes a FIFO mutex genuinely FIFO.

**Counting semaphore (Ch. 6.6).**

```
sem_wait(s):     // P, or "down"
  1. s.value -= 1
  2. if s.value < 0: append pid to s.waitQueue; block with {kind:'semaphore', resource:s.id}
  3. else: append pid to s.holders; emit sync.acquired

sem_post(s):     // V, or "up"
  1. s.value += 1
  2. if s.value <= 0:
        w = s.ordered ? s.waitQueue.shift() : removeAt(s.waitQueue, rng.int(0, len))
        mark w wakeable; append w to s.holders; emit sync.released { woke: w }
     else: emit sync.released { woke: null }
  3. remove pid from s.holders
```

The sign convention is the textbook's: a negative `value` is the number of
waiters, and the HUD prints it that way so `sem_wait` on a semaphore showing -3
is visibly the fourth waiter.

A **binary semaphore** is a semaphore with `capacity === 1`, and the sim treats
it as distinct from a mutex in exactly one respect: any process may `sem_post` a
semaphore, while only the holder may `mutex_unlock` a mutex. That difference is
the whole reason both exist, and the codex says so.

**Monitor with condition variables (Ch. 6.7).**

```ts
interface Monitor extends SyncPrimitive {
  readonly kind: 'monitor';
  /** One FIFO queue per named condition. */
  readonly conditions: Map<string, Pid[]>;
  readonly signalDiscipline: 'signal_and_wait' | 'signal_and_continue';
}
```

```
monitor_enter(m):        identical to mutex_lock on the monitor lock
monitor_exit(m):         identical to mutex_unlock

cond_wait(m, c):
  1. assert pid holds m, else EPERM
  2. append pid to m.conditions[c]
  3. release the monitor lock (with hand-off as in mutex_unlock)
  4. block with {kind:'condition', monitor: m.id, condition: c}
  // On wake, the process must re-acquire the monitor lock before proceeding.

cond_signal(m, c):
  1. assert pid holds m, else EPERM
  2. if m.conditions[c] is empty: return ok      // signal on an empty queue is a no-op
  3. w = m.conditions[c].shift()
  4. under 'signal_and_continue' (Mesa): mark w wakeable, w re-contends for the lock;
     the signaller keeps the monitor.
     under 'signal_and_wait' (Hoare): the signaller releases the lock directly to w
     and joins the monitor's entry queue.

cond_broadcast(m, c):    move every pid in m.conditions[c] to the monitor entry queue
```

Default discipline is `signal_and_continue`, because that is what every real
system does and because it forces the correct idiom:

```
while (!predicate) cond_wait(m, c);       // while, never if
```

The sim ships the broken `if` version as scenario `SYNC-MONITOR-BROKEN` and lets
the player watch a woken process proceed on a predicate that a third process
falsified in between. The remedy is one keyword.

**Reader-writer lock (Ch. 7.1.2).** Writer-preferring, to avoid writer
starvation:

```
rw_read_lock(l):
  1. if l.value >= 0 and no writer is waiting: l.value += 1; add pid to holders
  2. else block
rw_read_unlock(l):
  1. l.value -= 1; remove pid from holders
  2. if l.value == 0 and a writer waits: wake the head writer
rw_write_lock(l):
  1. if l.value == 0: l.value = -1; holders = [pid]
  2. else: register as a waiting writer and block
rw_write_unlock(l):
  1. l.value = 0; holders = []
  2. if a writer waits: wake the head writer (writer preference)
     else wake every waiting reader
```

A reader-preferring variant is offered as `rwlockPolicy: 'reader_pref'` and
starves writers, which is the first readers-writers problem of Ch. 7.1.2.

**Barrier.** `barrier_wait` increments `value` and blocks. When
`value === capacity`, every waiter is marked wakeable in one phase and `value`
resets to 0. Used by the thread-join scenarios in Leg 2.

### 8.5 Priority inversion (Ch. 5.6.4)

A low-priority process holds a mutex; a high-priority process blocks on it; a
medium-priority process preempts the low one and runs indefinitely. The
high-priority process is now blocked behind a medium-priority process, which is
the inversion.

The sim detects it in phase 4:

1. For each blocked process `H` with `blockedOn.kind` in `{mutex, semaphore}`,
   find the holder `L`.
2. If `L.priority > H.priority` (numerically larger, so lower priority) and `L`
   is in state `ready` and some process `M` with
   `H.priority < M.priority < L.priority` is running, the inversion holds.
3. Emit the game-layer affliction `priority_inversion` against `H`.

**Priority inheritance** is the remedy, available as
`priorityInheritance: boolean` (default false, so the pathology is reachable).
When on, at step 2 the kernel sets `L.priority = H.priority` for as long as `L`
holds the mutex, restoring `L.basePriority` when the mutex is released. Turning it on and watching
the affliction clear is the Leg 4 exercise.

### 8.6 The race condition detector

This is the piece with no textbook algorithm to copy, so it is specified in full.

**What a shared datum is.** Only `SharedRegion.value` (§3.8) and inode metadata
are racy. Ordinary process memory is private, so there is nothing to race on.
Every shared datum is registered:

```ts
interface SharedCell {
  readonly id: string;                 // e.g. "region:counter" or "inode:7.size"
  value: number;
  /** Eraser-style candidate lock set. Null until the first access. */
  lockSet: Set<ResourceId> | null;
  /** In-flight read-modify-write operations, keyed by pid. */
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

**The two detectors.** Both run inside phase 8, at the moment a shared access
executes.

*Detector 1: lockset refinement (the Eraser algorithm).* On every access to cell
`c` by process `p`:

```
1. held = the set of ResourceIds in p.heldResources that are sync primitives
2. if c.lockSet === null:  c.lockSet = new Set(held)          // first access
3. else:                   c.lockSet = intersection(c.lockSet, held)
4. if c.lockSet.size === 0 and c.history contains an access by a different pid:
       report a potential race
```

An empty lockset after two different processes have touched the cell means no
single lock protects it. This catches races that never actually corrupt anything
on this particular interleaving, which is what makes it useful: it finds the bug
before the bug bites.

*Detector 2: lost update.* Read-modify-write is three instructions in this
simulator (`load`, `compute`, `store`), so the interleaving window is explicit.

```
On load  by p:  c.pending.set(p, { loadedValue: c.value, loadedAtTick: tick, heldAt: held })
On store by p:  const e = c.pending.get(p)
                if (e && e.loadedValue !== c.value) {
                    // Someone stored between p's load and p's store.
                    report a confirmed race with the numbers below
                }
                c.value = storedValue
                c.pending.delete(p)
```

`expectedValue` is what the cell would hold if every pending operation had run to
completion serially: the initial value plus the sum of every increment applied,
tracked as a separate shadow counter `c.serialValue` that is updated on every
store by the amount the storing process intended to add. `corruptedValue` is
`c.value` after the store. Their difference is the number of lost updates times
the increment size, and the HUD prints exactly that.

**Producing the `RaceCondition` interleaving trace.** The `interleaving` field is
`readonly string[]`, one line per relevant access, drawn from `c.history` from
the earliest still-pending load up to the offending store:

```ts
function buildInterleaving(c: SharedCell, from: Tick): string[] {
  return c.history
    .filter(r => r.tick >= from)
    .map(r =>
      `t=${r.tick} P${r.pid} ${r.op === 'load' ? 'LOAD ' : 'STORE'} ${c.id} ` +
      `${r.op === 'load' ? '->' : '<-'} ${r.value}` +
      (r.held.length ? ` [holds ${r.held.join(',')}]` : ' [holds nothing]'));
}
```

For the canonical two-process counter increment, the trace reads:

```
t=41 P3 LOAD  region:counter -> 100 [holds nothing]
t=42 P4 LOAD  region:counter -> 100 [holds nothing]
t=43 P3 STORE region:counter <- 101 [holds nothing]
t=44 P4 STORE region:counter <- 101 [holds nothing]
```

and the emitted event is:

```ts
{
  type: 'sync.race_detected',
  race: {
    tick: 44,
    participants: [3, 4],
    location: 'region:counter',
    interleaving: [ ...the four lines above ],
    corruptedValue: 101,
    expectedValue: 102,
  }
}
```

Test fixture `SYNC-RACE-1`. Wrapping lines 41 to 44 in `mutex_lock` and
`mutex_unlock` produces zero `sync.race_detected` events over the same 10,000
ticks and the same seed, which is the assertion that proves the fix. That pair
of runs is the entire Leg 4 lesson and the game plays them back to back.

**False-positive suppression.** Detector 1 alone reports cells protected by
different-but-equivalent locks and cells that are read-only after
initialisation. Two suppressions:

- A cell accessed by exactly one pid so far is never reported.
- A cell whose accesses are all `load` is never reported, because read-read is
  not a race.

Detector 2 has no false positives by construction: a lost update happened or it
did not.

### 8.7 Bounded buffer (Ch. 7.1.1)

**Structure.**

```
n slots
semaphore mutex = 1        // protects the buffer
semaphore empty = n        // count of empty slots
semaphore full  = 0        // count of filled slots
```

**Producer.**

```
1. sem_wait(empty)
2. sem_wait(mutex)
3. add item to buffer
4. sem_post(mutex)
5. sem_post(full)
```

**Consumer.**

```
1. sem_wait(full)
2. sem_wait(mutex)
3. remove item from buffer
4. sem_post(mutex)
5. sem_post(empty)
```

**Scenario `SYNC-BB-1`.** `n = 4`, three producers each producing 20 items, two
consumers each consuming 30 items. Producer service time per item is 3 ticks,
consumer 2 ticks. Assertions after 10,000 ticks:

- items produced === items consumed === 60
- buffer occupancy is always in `[0, 4]` (invariant I-21)
- `empty.value + full.value + (processes inside the critical section) === 4`
- zero `sync.race_detected` events

**Scenario `SYNC-BB-DEADLOCK`.** Swap producer lines 1 and 2, so the producer
takes `mutex` before `empty`. When the buffer fills, a producer holds `mutex`
while blocked on `empty`, and no consumer can take `mutex` to drain it. The
wait-for graph shows a two-node cycle and `deadlock.detected` fires. This is the
producer-consumer collapse named as Leg 5's signature failure. The remedy the
player must derive is the ordering rule: **acquire the counting semaphore before
the mutex, always.**

**Scenario `SYNC-BB-UNBALANCED`.** Producers faster than consumers (service 1
versus 5). The buffer saturates, producers spend most of their time blocked on
`empty`, and `SchedulingMetrics.cpuUtilisation` collapses even though nothing is
wrong. The lesson is that a bounded buffer is a rate limiter, and the fix is more
consumers or a larger `n`, not a scheduler change. The game offers the scheduler
change as a tempting wrong answer.

### 8.8 Readers-writers (Ch. 7.1.2)

**First problem, readers preferred.**

```
semaphore rw_mutex = 1     // held by a writer, or by the first reader
semaphore mutex    = 1     // protects read_count
int read_count = 0

Writer:                          Reader:
1. sem_wait(rw_mutex)            1. sem_wait(mutex)
2. ...write...                   2. read_count++
3. sem_post(rw_mutex)            3. if read_count == 1: sem_wait(rw_mutex)
                                 4. sem_post(mutex)
                                 5. ...read...
                                 6. sem_wait(mutex)
                                 7. read_count--
                                 8. if read_count == 0: sem_post(rw_mutex)
                                 9. sem_post(mutex)
```

**Scenario `SYNC-RW-STARVE`.** Six readers arriving every 3 ticks with 10-tick
reads, one writer arriving at tick 5. `read_count` never reaches 0, so the writer
blocks on `rw_mutex` for the whole run and eventually crosses
`starvationFatalThreshold`. Assertion: exactly one
`process.starving { fatal: true }` event, naming the writer.

**Second problem, writers preferred.** The `rwlock` primitive of §8.4 with
`rwlockPolicy: 'writer_pref'`. Same workload, and the assertion flips: the writer
completes and one of the readers is the one that waits longest. Neither problem
is solvable without starving somebody, which is Ch. 7.1.2's actual point, and the
sim proves it by running both and showing the player two starvation events with
different names.

**Third option, fair.** A ticket lock: readers and writers take a monotonically
increasing ticket and are served in ticket order, with consecutive readers
batched. Available as `rwlockPolicy: 'fair'`. Nobody starves, and throughput
falls, which is the honest trade.

### 8.9 Dining philosophers (Ch. 7.1.3)

Five philosophers, five chopsticks, chopstick `i` between philosopher `i` and
philosopher `(i + 1) mod 5`. Each philosopher cycles: think for
`rng.int(5, 15)` ticks, pick up two chopsticks, eat for `rng.int(5, 15)` ticks,
put both down. All draws come from `root/sync`.

**Solution 0, the naive one (deadlock-prone).**

```
philosopher(i):
  1. think
  2. sem_wait(chopstick[i])            // left
  3. sem_wait(chopstick[(i+1) % 5])    // right
  4. eat
  5. sem_post(chopstick[i])
  6. sem_post(chopstick[(i+1) % 5])
```

Deadlocks when all five complete step 2 before any completes step 3. Each holds
one chopstick and waits for one held by a neighbour, so the wait-for graph is a
five-node cycle. All four Coffman conditions hold and §9.2 labels each edge.

The sim reaches this state deterministically because the scheduler is
round-robin with a quantum large enough for step 2 and small enough that no
philosopher gets through step 3. Scenario `SYNC-PHIL-NAIVE` sets
`quantum = 1` and asserts that `deadlock.detected` fires with a cycle of exactly
five pids by tick 200. That assertion is a fixture, so the deadlock is
reproducible rather than a matter of luck, which matters because a deadlock the
player cannot re-enter is a deadlock they cannot study.

**Solution 1, asymmetry.** Odd-numbered philosophers take their right chopstick
first. This breaks circular wait because the resource ordering is no longer
uniform around the table. Scenario `SYNC-PHIL-ASYM` asserts zero
`deadlock.detected` events over 20,000 ticks and records the throughput (meals
completed) for comparison.

**Solution 2, an arbitrator.** A semaphore `room` with capacity 4 admits at most
four philosophers to the table at once.

```
philosopher(i):
  1. think
  2. sem_wait(room)
  3. sem_wait(chopstick[i])
  4. sem_wait(chopstick[(i+1) % 5])
  5. eat
  6. sem_post(chopstick[(i+1) % 5])
  7. sem_post(chopstick[i])
  8. sem_post(room)
```

With at most four philosophers holding chopsticks and five chopsticks available,
at least one philosopher always has both. This breaks hold-and-wait at the
population level. Scenario `SYNC-PHIL-ROOM`.

**Solution 3, the monitor (Ch. 7.1.3's own).** A monitor with a state array and
one condition variable per philosopher:

```
enum { THINKING, HUNGRY, EATING } state[5];
condition self[5];

monitor procedure pickup(i):
  1. state[i] = HUNGRY
  2. test(i)
  3. if state[i] != EATING: cond_wait(self[i])

monitor procedure putdown(i):
  1. state[i] = THINKING
  2. test((i + 4) % 5)
  3. test((i + 1) % 5)

private procedure test(i):
  1. if state[(i+4)%5] != EATING and state[i] == HUNGRY and state[(i+1)%5] != EATING:
  2.     state[i] = EATING
  3.     cond_signal(self[i])
```

Deadlock-free because a philosopher only ever transitions to EATING when both
neighbours are not eating, and the transition happens inside the monitor, so
there is no window. It is **not** starvation-free: two philosophers can alternate
and starve the one between them. Scenario `SYNC-PHIL-MONITOR` asserts zero
deadlocks and asserts that at least one philosopher crosses
`starvationThreshold`, which is the honest result and the one the codex reports.

**Comparison table** printed on the Leg 5 debrief card, from 20,000 ticks at the
reference seed with each solution:

| Solution | Deadlocks | Meals completed | Worst individual wait | Breaks which Coffman condition |
|---|---|---|---|---|
| naive | 1 (fatal) | recorded at implementation | n/a | none |
| asymmetric | 0 | recorded | recorded | circular wait |
| arbitrator (room = 4) | 0 | recorded | recorded | hold and wait |
| monitor | 0 | recorded | recorded | circular wait |

"Recorded at implementation" means the first correct implementation run
establishes the numbers and they are frozen as fixture `SYNC-PHIL-TABLE`. They
are not textbook figures and must not be invented.

---

## 9. Deadlock (Ch. 8)

### 9.1 Resources

```ts
interface ResourceType {
  readonly id: ResourceId;
  readonly displayName: string;
  readonly totalInstances: number;
  availableInstances: number;
  readonly preemptible: boolean;
}
```

Allocation is tracked in a dense matrix rebuilt on demand from PCB state, never
stored separately, so it cannot drift:

```ts
function allocationMatrix(k: KernelState): number[][] {
  // rows = k.orderedPids, cols = k.orderedResourceIds
  const rows = k.orderedPids.map(pid => {
    const p = k.pcb(pid)!;
    return k.orderedResourceIds.map(r => p.heldResources.filter(h => h === r).length);
  });
  return rows;
}
```

`heldResources` is a multiset represented as an array with repeats, so holding
two instances of `printer` appears twice. `requestedResources` is the same shape
and holds outstanding requests. Invariant I-5 asserts that for every resource
type, `availableInstances + sum(allocation column) === totalInstances`.

### 9.2 The four Coffman conditions (Ch. 8.2)

All four must hold simultaneously for deadlock. Each is a computable predicate
over kernel state, and `DeadlockReport.conditions` lists the ones a given cycle
demonstrates.

| Condition | Definition | How the sim detects it |
|---|---|---|
| `mutual_exclusion` | at least one resource is non-sharable | true for any `ResourceType` with `totalInstances` finite and any `SyncPrimitive` of kind `mutex`, `semaphore` with capacity 1, or `rwlock` held for writing. False for a `rwlock` held only by readers, which is why a reader-only cycle is impossible. |
| `hold_and_wait` | a process holds at least one resource and is waiting for another | `pcb.heldResources.length > 0 && pcb.blockedOn !== null && pcb.requestedResources.length > 0` |
| `no_preemption` | a resource cannot be taken from its holder | `!resourceType.preemptible` for every resource on the cycle. SABLE's `shield` ability flips `preemptible` to true on one resource for 20 ticks, which is precisely a targeted attack on this condition. |
| `circular_wait` | a cycle exists in the wait-for graph | the cycle detection of §9.3 |

The report's `conditions` array is built by testing each predicate against the
edges of the discovered cycle and including the ones that hold. For a genuine
deadlock all four are present; the array exists so the codex can highlight which
edge demonstrates which, and so a *near*-deadlock (three of four) can be shown as
a warning.

### 9.3 The wait-for graph and cycle detection (Ch. 8.3.2)

The resource allocation graph has two node types (processes and resources) and
two edge types (request `P -> R`, assignment `R -> P`). The **wait-for graph**
collapses resources out: an edge `Pi -> Pj` exists when `Pi` waits for a resource
held by `Pj`.

```ts
/** Adjacency built in ascending pid order so DFS is deterministic. */
function buildWaitForGraph(k: KernelState): Map<Pid, Pid[]> {
  const g = new Map<Pid, Pid[]>();
  for (const pid of k.orderedPids) {
    const p = k.pcb(pid)!;
    if (p.state !== 'waiting' || p.blockedOn === null) { g.set(pid, []); continue; }
    const targets = new Set<Pid>();
    for (const rid of p.requestedResources) {
      for (const other of k.orderedPids) {
        if (other === pid) continue;
        if (k.pcb(other)!.heldResources.includes(rid)) targets.add(other);
      }
    }
    // Sync primitives and mailboxes contribute edges too.
    const b = p.blockedOn;
    if (b.kind === 'mutex' || b.kind === 'semaphore') {
      for (const h of k.sync(b.resource)!.holders) if (h !== pid) targets.add(h);
    }
    if (b.kind === 'child_wait' && b.child !== null) targets.add(b.child);
    g.set(pid, [...targets].sort((a, b2) => a - b2));   // ascending, mandatory
  }
  return g;
}
```

The sort at the end is not cosmetic. DFS explores in adjacency order, so the
*particular* cycle reported when several exist depends on it, and
`DeadlockReport.cycle` is asserted in fixtures.

**Cycle detection: iterative DFS with colouring.**

```
colour: Map<Pid, WHITE | GREY | BLACK>, all WHITE initially
parent: Map<Pid, Pid | null>

for each pid in ascending order:
  1. if colour[pid] != WHITE: continue
  2. push (pid, 0) onto an explicit stack; colour[pid] = GREY; parent[pid] = null
  3. while the stack is non-empty:
  4.     (u, i) = top of stack
  5.     if i < g[u].length:
  6.         replace the top with (u, i + 1)
  7.         v = g[u][i]
  8.         if colour[v] == WHITE:
  9.             colour[v] = GREY; parent[v] = u; push (v, 0)
 10.         else if colour[v] == GREY:
 11.             // back edge: v is on the current DFS path, so a cycle exists
 12.             cycle = [v]; w = u
 13.             while w != v: cycle.push(w); w = parent[w]
 14.             cycle.reverse()
 15.             return rotateToLowestPid(cycle)
 16.     else:
 17.         pop; colour[u] = BLACK
 18. return null
```

The DFS is iterative rather than recursive so that a pathological graph cannot
blow the JavaScript stack in the browser.

`rotateToLowestPid` rotates the cycle array so it begins at its smallest pid.
Without it, the same cycle discovered from a different start node serialises
differently and the snapshot comparison in test D1 fails. This is a real bug
class and the rotation is mandatory.

Complexity is O(V + E) with V the process count and E bounded by
`processes * resources`, which for the sim's scale (tens of each) is
negligible per detection interval.

### 9.4 Banker's algorithm (Ch. 8.6.3)

`BankersState` is frozen in `types.ts`. Rows are processes in ascending pid
order, columns are resources in ascending `ResourceId` lexicographic order. Both
orderings are mandatory and are what make `SafetyCheckResult.trace` comparable
across runs.

```
n = number of processes
m = number of resource types
Available[m]        currently unallocated instances
Max[n][m]           maximum each process may ever claim
Allocation[n][m]    currently held
Need[n][m]          Max - Allocation, computed, never stored
```

#### 9.4.1 The safety algorithm (Ch. 8.6.3.1)

```
SAFETY(Available, Max, Allocation):
  1. Work = copy of Available
     Finish[i] = false for all i in 0..n-1
  2. Find an index i such that:
         Finish[i] == false, and
         Need[i][j] <= Work[j] for all j in 0..m-1
     Scan i in ASCENDING order and take the FIRST such i.
     If no such i exists, go to step 4.
  3. Work = Work + Allocation[i]
     Finish[i] = true
     Append process i to the safe sequence
     Record a SafetyTraceStep { work: copy of Work, candidate: i, admitted: true, explanation }
     Go to step 2.
  4. If Finish[i] == true for all i, the state is SAFE and the sequence is the
     order of admission. Otherwise the state is UNSAFE.
     Record a final SafetyTraceStep { work, candidate: null, admitted: false, explanation }
```

**The ascending-first-match rule at step 2 is normative.** The textbook says
"find an *i* such that", leaving the choice open, and different choices give
different safe sequences that are all correct. The simulator must produce one
answer, so it takes the lowest index and restarts the scan from index 0 after
every admission.

Complexity is O(n² m), which is what Ch. 8.6.3.1 states.

```ts
export function safetyCheck(s: BankersState): SafetyCheckResult {
  const n = s.processes.length, m = s.resources.length;
  const work = [...s.available];
  const finish = new Array<boolean>(n).fill(false);
  const sequence: Pid[] = [];
  const trace: SafetyTraceStep[] = [];

  for (;;) {
    let picked = -1;
    for (let i = 0; i < n; i++) {
      if (finish[i]) continue;
      let fits = true;
      for (let j = 0; j < m; j++) if (s.need[i][j] > work[j]) { fits = false; break; }
      if (fits) { picked = i; break; }
    }
    if (picked === -1) break;
    for (let j = 0; j < m; j++) work[j] += s.allocation[picked][j];
    finish[picked] = true;
    sequence.push(s.processes[picked]);
    trace.push({
      work: [...work],
      candidate: s.processes[picked],
      admitted: true,
      explanation: `Need[P${s.processes[picked]}] fits in Work; assume it finishes and returns its allocation. Work becomes [${work.join(', ')}].`,
    });
  }

  const safe = finish.every(Boolean);
  if (!safe) {
    const stuck = s.processes.filter((_, i) => !finish[i]);
    trace.push({
      work: [...work],
      candidate: null,
      admitted: false,
      explanation: `No remaining process has Need <= Work [${work.join(', ')}]. Stuck: ${stuck.map(p => 'P' + p).join(', ')}. State is UNSAFE.`,
    });
  }
  return { safe, sequence: safe ? sequence : null, trace };
}
```

#### 9.4.2 The resource-request algorithm (Ch. 8.6.3.2)

```
REQUEST(i, Request[m]):
  1. If Request[j] > Need[i][j] for some j:
         error: the process exceeded its declared maximum claim.
         Return EINVAL.
  2. If Request[j] > Available[j] for some j:
         the resources are not there; process i must wait.
         Return EAGAIN and block the process.
  3. Tentatively allocate:
         Available   = Available - Request
         Allocation[i] = Allocation[i] + Request
         Need[i]       = Need[i] - Request
  4. Run SAFETY on the tentative state.
     If SAFE:   commit. Return ok, emit resource.granted.
     If UNSAFE: roll back step 3 exactly, block process i,
                emit resource.denied { reason: 'unsafe' }. Return EAGAIN.
```

`Kernel.evaluateBankers(pid, resource, instances)` runs steps 1 to 4 without
committing and returns the `SafetyCheckResult`, which is how the terminal's
`bankers` command and the codex show the player the algorithm on live state. The
event `bankers.evaluated` carries the same result plus the request that
triggered it, so the world layer can animate the safety scan.

#### 9.4.3 Worked example (Ch. 8.6.3)

Five processes P0 to P4, three resource types A, B, C with 10, 5 and 7 instances.

**Allocation:**

| | A | B | C |
|---|---|---|---|
| P0 | 0 | 1 | 0 |
| P1 | 2 | 0 | 0 |
| P2 | 3 | 0 | 2 |
| P3 | 2 | 1 | 1 |
| P4 | 0 | 0 | 2 |

**Max:**

| | A | B | C |
|---|---|---|---|
| P0 | 7 | 5 | 3 |
| P1 | 3 | 2 | 2 |
| P2 | 9 | 0 | 2 |
| P3 | 2 | 2 | 2 |
| P4 | 4 | 3 | 3 |

**Need = Max - Allocation:**

| | A | B | C |
|---|---|---|---|
| P0 | 7 | 4 | 3 |
| P1 | 1 | 2 | 2 |
| P2 | 6 | 0 | 0 |
| P3 | 0 | 1 | 1 |
| P4 | 4 | 3 | 1 |

**Available = (3, 3, 2).** (Check: allocated totals are A = 7, B = 2, C = 5, and
10 - 7 = 3, 5 - 2 = 3, 7 - 5 = 2.)

**Safety trace, ascending-first-match:**

| Step | Candidate | Need | Work before | Work after |
|---|---|---|---|---|
| 1 | P1 | (1,2,2) | (3,3,2) | (5,3,2) |
| 2 | P3 | (0,1,1) | (5,3,2) | (7,4,3) |
| 3 | P0 | (7,4,3) | (7,4,3) | (7,5,3) |
| 4 | P2 | (6,0,0) | (7,5,3) | (10,5,5) |
| 5 | P4 | (4,3,1) | (10,5,5) | (10,5,7) |

**The state is safe. Safe sequence: `<P1, P3, P0, P2, P4>`.** Test fixture
`DL-BANKERS-1`.

The textbook prints `<P1, P3, P4, P0, P2>`, which is also safe. Both are correct;
the simulator's ascending-first-match rule selects P0 at step 3 because P0's need
(7,4,3) fits Work (7,4,3) exactly and P0 has a lower index than P4. A test that
asserts the textbook's sequence instead of the simulator's is testing the wrong
thing, and `DL-BANKERS-1A` asserts that the textbook sequence is *also* safe by
running the safety check with a forced admission order.

**Request 1: P1 requests (1, 0, 2).**

- Step 1: `(1,0,2) <= Need[P1] = (1,2,2)`. Passes.
- Step 2: `(1,0,2) <= Available = (3,3,2)`. Passes.
- Step 3: tentative state:
  - `Available = (2, 3, 0)`
  - `Allocation[P1] = (3, 0, 2)`
  - `Need[P1] = (0, 2, 0)`
- Step 4 safety trace:

| Step | Candidate | Need | Work before | Work after |
|---|---|---|---|---|
| 1 | P1 | (0,2,0) | (2,3,0) | (5,3,2) |
| 2 | P3 | (0,1,1) | (5,3,2) | (7,4,3) |
| 3 | P0 | (7,4,3) | (7,4,3) | (7,5,3) |
| 4 | P2 | (6,0,0) | (7,5,3) | (10,5,5) |
| 5 | P4 | (4,3,1) | (10,5,5) | (10,5,7) |

**Safe. The request is granted.** Safe sequence `<P1, P3, P0, P2, P4>`. Test
fixture `DL-BANKERS-2`.

**Request 2, from the state after request 1: P4 requests (3, 3, 0).**

Step 2 fails: `Available = (2, 3, 0)` and `3 > 2` in column A. **Denied,
`EAGAIN`, `resource.denied { reason: 'unavailable' }`.** Test fixture
`DL-BANKERS-3`. Note this denial has nothing to do with safety; the resources
simply are not there, and the event carries `'unavailable'` rather than
`'unsafe'` so the codex can distinguish the two.

**Request 3, from the state after request 1: P0 requests (0, 2, 0).**

- Step 1: `(0,2,0) <= Need[P0] = (7,4,3)`. Passes.
- Step 2: `(0,2,0) <= Available = (2,3,0)`. Passes.
- Step 3: tentative state:
  - `Available = (2, 1, 0)`
  - `Allocation[P0] = (0, 3, 0)`
  - `Need[P0] = (7, 2, 3)`
- Step 4: no process has `Need <= Work = (2,1,0)`:

| Process | Need | Fits (2,1,0)? |
|---|---|---|
| P0 | (7,2,3) | no, A and B and C |
| P1 | (0,2,0) | no, B: 2 > 1 |
| P2 | (6,0,0) | no, A: 6 > 2 |
| P3 | (0,1,1) | no, C: 1 > 0 |
| P4 | (4,3,1) | no, A and B and C |

**Unsafe. The request is denied, rolled back, and P0 blocks.**
`resource.denied { reason: 'unsafe' }`. Test fixture `DL-BANKERS-4`.

The teaching point the codex draws from `DL-BANKERS-4`: the resources P0 asked
for **were available**, and the request was still refused. Avoidance costs
throughput to buy a guarantee, and the player is shown the refused allocation
sitting unused. That trade is the entire content of Ch. 8.6.

### 9.5 Detection with multiple instances (Ch. 8.7.2)

When a resource type has more than one instance, a cycle in the wait-for graph is
necessary but not sufficient. The detection algorithm is the safety algorithm
with `Request` in place of `Need`:

```
DETECT(Available, Allocation, Request):
  1. Work = copy of Available
     Finish[i] = (Allocation[i] is all zeros)      // a process holding nothing cannot deadlock
  2. Find an index i, ASCENDING, with Finish[i] == false and Request[i][j] <= Work[j] for all j.
     If none, go to step 4.
  3. Work = Work + Allocation[i]; Finish[i] = true; go to step 2.
  4. Any i with Finish[i] == false is deadlocked. The set of such i is the deadlock set.
```

`Request[i]` is the process's *current outstanding* request, which is
`requestedResources` counted per type, and is not the same as `Need`.

The difference from the safety algorithm at step 1 matters: a process that holds
nothing is marked finished up front, because it cannot be part of a cycle.

**Worked example (Ch. 8.7.2).** Five processes, three resource types A, B, C with
7, 2 and 6 instances.

**Allocation:**

| | A | B | C |
|---|---|---|---|
| P0 | 0 | 1 | 0 |
| P1 | 2 | 0 | 0 |
| P2 | 3 | 0 | 3 |
| P3 | 2 | 1 | 1 |
| P4 | 0 | 0 | 2 |

**Request:**

| | A | B | C |
|---|---|---|---|
| P0 | 0 | 0 | 0 |
| P1 | 2 | 0 | 2 |
| P2 | 0 | 0 | 0 |
| P3 | 1 | 0 | 0 |
| P4 | 0 | 0 | 2 |

**Available = (0, 0, 0).**

Trace: P0 requests nothing, so `Finish[P0] = true` and `Work` becomes (0,1,0).
P2 requests nothing, `Finish[P2] = true`, `Work` becomes (3,1,3). P1 needs
(2,0,2) which fits, `Work` becomes (5,1,3). P3 needs (1,0,0), fits, `Work`
becomes (7,2,4). P4 needs (0,0,2), fits, `Work` becomes (7,2,6). **All finish:
no deadlock**, even though `Available` is entirely zero. Test fixture
`DL-DETECT-1`.

**Now change P2's request to (0, 0, 1).** P0 finishes (Work = (0,1,0)). P2 now
requests C and `Work[C] = 0`, so P2 cannot finish. No other process can finish
either: P1 needs (2,0,2), P3 needs (1,0,0) which exceeds `Work[A] = 0`, P4 needs
(0,0,2). **Deadlocked set: {P1, P2, P3, P4}.** Test fixture `DL-DETECT-2`.

The pair is the demonstration that a cycle alone is not enough and that the
single extra instance of C was carrying the whole system.

**Detection frequency (Ch. 8.7.3).** `deadlockDetectionInterval` ticks, default
20. Running it every tick is correct and expensive; running it rarely means a
deadlock persists undetected while the CPU idles. The sim exposes the interval to
the player as a depot upgrade, and the debrief prints the average detection
latency so the trade is visible.

### 9.6 Recovery (Ch. 8.8)

**By termination (Ch. 8.8.1).** Two modes:

- `abort_all`: terminate every process in the deadlock set. Guaranteed to break
  the deadlock, maximally expensive.
- `abort_one` (default): terminate one victim, re-run detection, repeat until no
  cycle remains.

**Victim selection.** Ordered comparison, first difference wins, so the choice is
total and deterministic:

1. **Lowest priority number wins survival**, so prefer terminating the process
   with the numerically *largest* `priority`.
2. Prefer the process with the least `totalCpuUsed`, so the least work is lost.
3. Prefer the process holding the most resources, so one termination frees the
   most.
4. Prefer the process with the most `serviceRemaining`, so the survivors are
   closest to finishing.
5. **Never select a convoy Program if a non-convoy process is on the cycle.**
   This is a game rule, not an OS rule, and it is stated here because the
   simulator implements it: `convoyMemberId !== null` sorts last unconditionally.
6. Tie-break on highest pid.

```ts
function chooseVictim(cycle: readonly Pid[], k: KernelState): Pid {
  return [...cycle].sort((a, b) => {
    const pa = k.pcb(a)!, pb = k.pcb(b)!;
    const convoyA = pa.convoyMemberId !== null ? 1 : 0;
    const convoyB = pb.convoyMemberId !== null ? 1 : 0;
    if (convoyA !== convoyB) return convoyA - convoyB;          // non-convoy first
    if (pa.priority !== pb.priority) return pb.priority - pa.priority;
    if (pa.totalCpuUsed !== pb.totalCpuUsed) return pa.totalCpuUsed - pb.totalCpuUsed;
    if (pa.heldResources.length !== pb.heldResources.length) return pb.heldResources.length - pa.heldResources.length;
    if (pa.serviceRemaining !== pb.serviceRemaining) return pb.serviceRemaining - pa.serviceRemaining;
    return b - a;
  })[0];
}
```

`DeadlockReport.suggestedVictims` is this sorted array, so the player sees the
same ranking the kernel would use and can override it from the terminal with
`kill`.

Termination sets `terminationReason: 'deadlock_victim'` and emits
`deadlock.resolved { victims, method: 'terminate' }`.

**By preemption (Ch. 8.8.2).** Only possible on a `ResourceType` with
`preemptible === true`.

1. Select a resource on the cycle with `preemptible === true`. If none, fall back
   to termination.
2. Take the resource from its holder: remove it from `heldResources`, increment
   `availableInstances`.
3. **Roll back the holder.** The holder's `serviceRemaining` is restored to the
   value it held at the last checkpoint, and it is moved to `ready` with
   `blockedOn = null` and the preempted resource moved from `heldResources` back
   to `requestedResources`. Checkpoints are taken every
   `rollbackCheckpointInterval` ticks (default 25) and store only
   `serviceRemaining`, `cpuBurstRemaining` and the program counter.
4. Emit `deadlock.resolved { victims: [holder], method: 'preempt' }` or
   `method: 'rollback'` when a checkpoint was actually restored.
5. **Starvation guard.** A process preempted `maxPreemptionsPerProcess` times
   (default 3) is marked ineligible for further preemption, so the same victim
   cannot be rolled back forever. Ch. 8.8.2 names this as the third problem with
   preemption recovery and this counter is the answer.

SABLE's `shield` ability sets `preemptible = true` on one resource for 20 ticks,
which converts a termination into a preemption and saves a Program. That is the
mechanical value of the ability and the player should be able to reason it out
from the Coffman table.

### 9.7 Prevention and avoidance as kernel strategies

`KernelConfig.deadlockStrategy` takes four values, and each changes what the
`request` syscall does.

**`'ignore'`.** Grant if available, block if not, never check anything. This is
the Ostrich algorithm of Ch. 8.9 and it is what most real systems do. Deadlocks
happen and stay. The player's only recourse is the terminal and `kill`. This is
Leg 6's opening condition.

**`'detect'`.** Same request path as `'ignore'`, plus phase 9 runs detection
every `deadlockDetectionInterval` ticks and recovery runs on a positive result.
Costs CPU proportional to `n² m` per detection and costs whatever the victim was
worth.

**`'avoid'`.** The `request` syscall runs the Banker's resource-request algorithm
of §9.4.2. Requires that every process declares `Max` at admission; the sim takes
it from `ProcessSpec` and a process that requests beyond its declared max gets
`EINVAL` and is terminated with `protection_fault`. Phase 9 does no work. Costs
throughput, because safe-but-refused requests idle resources.

**`'prevent'`.** Attacks the Coffman conditions structurally. The sim implements
**circular wait prevention by total resource ordering** (Ch. 8.5.4), which is the
only one of the four that is practical:

1. Every `ResourceId` has an integer rank, assigned at declaration in ascending
   order of declaration.
2. `request(r)` from a process holding resource `h` succeeds only if
   `rank(r) > rank(h)` for every `h` in `heldResources`.
3. A violation returns `EDEADLK` immediately and does not block.

Under `'prevent'`, invariant I-17 asserts that `buildWaitForGraph` is acyclic on
every tick, and a failure of that assertion is a genuine bug in the ordering
implementation. Hold-and-wait prevention (request everything at once) is offered
as `preventionMode: 'all_or_nothing'` for comparison and is visibly worse for
utilisation, which is the Ch. 8.5.2 point.

The four strategies are a player verb on Leg 6. The debrief card prints, for the
same workload under all four: deadlocks encountered, processes lost, average
resource utilisation, and total ticks to complete. That table is the argument,
and no lecture accompanies it.

---

## 10. Mass storage (Ch. 11)

### 10.1 Disk geometry

```ts
interface DiskGeometry {
  readonly cylinders: number;          // KernelConfig.totalCylinders, default 200 (0..199)
  readonly headsPerCylinder: number;   // default 4
  readonly sectorsPerTrack: number;    // default 64
  readonly bytesPerSector: number;     // default 512
  readonly rpm: number;                // default 7200
  readonly seekOverheadMs: number;     // fixed cost per seek, default 0.5
  readonly seekPerCylinderMs: number;  // marginal cost per cylinder, default 0.04
  readonly transferMbPerSec: number;   // default 100
}
```

Capacity is `cylinders * headsPerCylinder * sectorsPerTrack * bytesPerSector`,
which at the defaults is 200 * 4 * 64 * 512 = 26,214,400 bytes (25 MiB). Small,
legible, and enough to hold a file system the player can read in the terminal.

A `BlockId` maps to a cylinder by:

```
sectorsPerCylinder = headsPerCylinder * sectorsPerTrack        // 256 at the defaults
cylinder = floor(blockId / sectorsPerCylinder)
```

Blocks are allocated in ascending order by default, so a contiguously allocated
file occupies consecutive cylinders and a badly fragmented one does not. That is
what makes the Ch. 14 allocation-method comparison in §12.3 produce different
seek totals rather than the same one.

### 10.2 The cost model

Service time for one request has three components (Ch. 11.1.1):

```
seekTimeMs     = seekOverheadMs + seekPerCylinderMs * |targetCylinder - headCylinder|
rotationMs     = 0.5 * (60000 / rpm)            // average half a rotation
transferMs     = (bytes / (transferMbPerSec * 1e6)) * 1000
serviceMs      = seekTimeMs + rotationMs + transferMs
```

At the defaults, with a 4096-byte transfer:

| Component | Value |
|---|---|
| rotation (7200 rpm) | 0.5 * (60000 / 7200) = **4.1667 ms** |
| transfer (4 KB at 100 MB/s) | **0.0410 ms** |
| seek, 0 cylinders | 0.5 ms |
| seek, 1 cylinder | 0.54 ms |
| seek, 50 cylinders | 2.5 ms |
| seek, 199 cylinders | 8.46 ms |

Total service for a 4 KB read at a seek distance of 50: `2.5 + 4.1667 + 0.0410 =
6.7077 ms`. Test fixture `DISK-COST-1`.

**Conversion to ticks.**

```ts
const MS_PER_TICK = 0.5;                       // KernelConfig-adjacent constant
function ticksFor(serviceMs: number): number {
  return Math.max(1, Math.round(serviceMs / MS_PER_TICK));
}
```

The 6.7077 ms request above costs `round(13.4154) = 13` ticks. A zero-distance
request costs `round((0.5 + 4.1667 + 0.0410) / 0.5) = round(9.4154) = 9` ticks.
**The floor is 9 ticks even with no seek at all**, because rotation dominates,
which is the number that makes the player care about the scheduling policy only
after they have already reduced request count. Test fixture `DISK-COST-2`.

KESTREL's passive halves `seekOverheadMs`, `seekPerCylinderMs` and every
`Device.latency`, applied at cost-model evaluation time so it affects every
policy equally.

### 10.3 Disk scheduling

`DiskSchedulingPolicy.select(queue, head)` returns an **index into `queue`**, not
a request. The kernel then removes that index, moves the head, charges the cost,
and emits `disk.seek` followed by `disk.served`.

The queue is maintained in arrival order. Policies that need a sorted view build
it inside `select` and must sort with an explicit comparator:

```ts
const byCylinderThenId = (a: DiskRequest, b: DiskRequest) =>
  a.cylinder !== b.cylinder ? a.cylinder - b.cylinder : a.id - b.id;
```

`DiskRequest.id` is a monotonic counter, so this is a total order.

Throughout §10.4, the queue is the Ch. 11.2 standard:

```
98, 183, 37, 122, 14, 124, 65, 67       head starts at cylinder 53, disk has 200 cylinders (0..199)
```

### 10.4 The six policies

#### FCFS (Ch. 11.2.1)

**Selection rule.** Return index 0.

**Path:** `53 -> 98 -> 183 -> 37 -> 122 -> 14 -> 124 -> 65 -> 67`

**Total head movement: 640 cylinders.** Test fixture `DISK-FCFS-1`.

Movements: 45, 85, 146, 85, 108, 110, 59, 2.

#### SSTF (Ch. 11.2.2)

**Selection rule.** Return the index of the request minimising
`|request.cylinder - head.cylinder|`. Tie-break on lower cylinder, then lower
request id.

**Path:** `53 -> 65 -> 67 -> 37 -> 14 -> 98 -> 122 -> 124 -> 183`

**Total head movement: 236 cylinders.** Test fixture `DISK-SSTF-1`.

**Starvation.** SSTF can starve a request far from a busy region indefinitely.
The sim detects it with the same mechanism as CPU starvation: a request whose
`tick - queuedAtTick` exceeds `diskStarvationThreshold` (default 400 ticks)
raises `process.starving` against its `pid`. This is Leg 9's signature failure,
"seek starvation", and it is why the leg pushes the player from SSTF to a SCAN
variant.

#### SCAN, the elevator (Ch. 11.2.3)

**Selection rule.** Serve every request in the current `direction` in cylinder
order, then reach the end of the disk (cylinder 0 or `totalCylinders - 1`),
reverse `direction`, and serve the rest.

Implemented as: filter the queue to requests on the current side of the head
(inclusive of the head cylinder), and return the index of the closest one in the
direction of travel. When that set is empty, set `head.direction` to the opposite
value, charge the movement to the end of the disk, and repeat.

**With `direction = 'down'` (the textbook's own figure):**

Path: `53 -> 37 -> 14 -> 0 -> 65 -> 67 -> 98 -> 122 -> 124 -> 183`

**Total head movement: 236 cylinders** (53 down to 0, then 183 back up).
Test fixture `DISK-SCAN-1`.

**With `direction = 'up'`:**

Path: `53 -> 65 -> 67 -> 98 -> 122 -> 124 -> 183 -> 199 -> 37 -> 14`

**Total: 331 cylinders.** Test fixture `DISK-SCAN-2`.

The pair matters: SCAN's cost depends on the starting direction, and the
implementation must expose `DiskHead.direction` rather than assume one.

#### C-SCAN (Ch. 11.2.4)

**Selection rule.** Serve requests only while travelling toward the high end.
On reaching the end, return immediately to cylinder 0 without servicing anything
on the way back, and resume. The return sweep costs full head movement, which is
the price of the uniform wait time.

**With `direction = 'up'` (the textbook's figure):**

Path: `53 -> 65 -> 67 -> 98 -> 122 -> 124 -> 183 -> 199 -> 0 -> 14 -> 37`

**Total head movement: 382 cylinders** (146 up, 199 back, 37 up). Test fixture
`DISK-CSCAN-1`.

**With `direction = 'down'`:** total 386 cylinders. Test fixture `DISK-CSCAN-2`.

C-SCAN moves more than SCAN on this queue and gives a **more uniform waiting
time**: under SCAN, a request just behind the head waits for a full round trip
while one just ahead is served immediately, and under C-SCAN every request waits
at most one sweep. The metric the sim reports for this is the standard deviation
of `servedAtTick - queuedAtTick` across the queue, printed on the Leg 9 debrief
next to total head movement so the trade is one table.

#### LOOK (Ch. 11.2.4)

**Selection rule.** SCAN, except the head reverses at the **last request** in the
current direction rather than at the end of the disk.

**With `direction = 'down'`:**

Path: `53 -> 37 -> 14 -> 65 -> 67 -> 98 -> 122 -> 124 -> 183`

**Total head movement: 208 cylinders.** Test fixture `DISK-LOOK-1`.

**With `direction = 'up'`:**

Path: `53 -> 65 -> 67 -> 98 -> 122 -> 124 -> 183 -> 37 -> 14`

**Total: 299 cylinders.** Test fixture `DISK-LOOK-2`.

LOOK beats SCAN on the same direction (208 versus 236 going down, 299 versus 331
going up) because it never travels to a cylinder nobody asked for.

#### C-LOOK

**Selection rule.** C-SCAN, except the return jump goes to the **lowest requested
cylinder** rather than to cylinder 0.

**With `direction = 'up'`:**

Path: `53 -> 65 -> 67 -> 98 -> 122 -> 124 -> 183 -> 14 -> 37`

**Total head movement: 322 cylinders** (130 up, 169 back, 23 up). Test fixture
`DISK-CLOOK-1`.

**With `direction = 'down'`:** total 326 cylinders. Test fixture `DISK-CLOOK-2`.

**Summary table**, all from the same queue and the same starting head, and this
is the table the world layer renders as six overlaid head paths on the platter:

| Policy | Direction | Total head movement |
|---|---|---|
| FCFS | n/a | 640 |
| SSTF | n/a | 236 |
| SCAN | down | 236 |
| SCAN | up | 331 |
| LOOK | down | **208** |
| LOOK | up | 299 |
| C-SCAN | up | 382 |
| C-SCAN | down | 386 |
| C-LOOK | up | 322 |
| C-LOOK | down | 326 |

Test fixture `DISK-ALL-1`. LOOK going down is the winner on total movement; it
is not the winner on wait-time uniformity, and the debrief card says so.

### 10.5 NVM, and why the story changes (Ch. 11.1.2 and 11.4)

An `NvmDevice` has no head, no cylinder and no rotation:

```ts
interface NvmGeometry {
  readonly pages: number;              // read/write granularity, 4 KB
  readonly pagesPerBlock: number;      // erase granularity, 256
  readonly readUs: number;             // 25
  readonly writeUs: number;            // 250
  readonly eraseUs: number;            // 2000
  readonly overProvisionRatio: number; // 0.07
}
```

**Uniform access time.** `readUs` is the same regardless of address, so seek
optimisation buys exactly nothing and every policy in §10.4 produces the same
total service time. The simulator asserts this: running the standard queue
against an NVM device under all six policies gives identical completion ticks,
which is the demonstration.

**What replaces seek optimisation.** Three things the sim models:

1. **Read/write asymmetry.** A write costs ten times a read. Merging small writes
   is now the optimisation, so the device has a write-combining buffer of
   `nvmWriteBufferPages` (default 8) and the scheduler's job is to fill it.
2. **Erase-before-write.** A page cannot be overwritten in place; its whole block
   must be erased first. The FTL maintains a mapping from logical page to
   physical page and writes to a free physical page, marking the old one invalid.
3. **Garbage collection and write amplification.** When free physical pages fall
   below `overProvisionRatio * pages`, GC picks the block with the most invalid
   pages, copies the valid pages elsewhere, and erases it. **Write amplification**
   is `physicalWrites / logicalWrites` and is reported as a metric. A workload of
   small random writes drives it above 3, and the same total bytes written
   sequentially keeps it near 1.

The Leg 9 lesson is that the player's carefully chosen disk scheduling policy
becomes irrelevant the moment they buy the NVM upgrade at the depot, and that a
different discipline (batching writes, writing sequentially) replaces it. The
depot presents the upgrade with no explanation and the debrief explains it
afterwards.

### 10.6 RAID (Ch. 11.8)

`RaidLevel` is `0 | 1 | 4 | 5 | 6 | 10`. `n` is the number of disks.

| Level | Layout | Usable capacity | Read cost per logical block | Write cost per logical block | Tolerates | Rebuild |
|---|---|---|---|---|---|---|
| 0 | striping, no redundancy | `n` | 1 | 1 | **0 disks** | impossible, data is lost |
| 1 | mirroring, pairs | `n / 2` | 1 (either copy, sim reads the lower index) | **2** | 1 per mirror pair | copy the surviving mirror, `blocksPerDisk` reads and writes |
| 4 | block striping, one dedicated parity disk | `n - 1` | 1 | **4** | 1 disk | read `n - 1` disks, XOR, write |
| 5 | block striping, parity distributed round-robin | `n - 1` | 1 | **4** | 1 disk | read `n - 1` disks, XOR, write |
| 6 | P + Q dual parity | `n - 2` | 1 | **6** | **2 disks** | read `n - 2`, recompute both |
| 10 | stripe of mirrors | `n / 2` | 1 | **2** | 1 per mirror pair, up to `n / 2` | copy the surviving mirror |

**The small-write penalty (Ch. 11.8.3), spelled out.** Writing one block under
RAID 4, 5 or 6 requires reading the old data and the old parity, computing
`newParity = oldParity XOR oldData XOR newData`, then writing both:

```
1. read  old data block          1 I/O
2. read  old parity block        1 I/O
3. write new data block          1 I/O
4. write new parity block        1 I/O
                                 ─────
                                 4 I/O for one logical block write
```

RAID 6 adds a second parity block, so steps 2 and 4 double: **6 I/O**.

**Full-stripe writes avoid it entirely.** Writing all `n - 1` data blocks of a
stripe lets parity be computed from the new data with no reads:
`n - 1` data writes plus 1 parity write, so `n` I/O for `n - 1` blocks, a
penalty of `n / (n - 1)` which approaches 1. The sim detects a full-stripe write
in the block layer and takes the fast path, so a player who writes sequentially
sees a fraction of the cost of one who writes randomly. That is the whole
argument for large sequential writes and it appears as a number rather than as
advice.

**RAID 4 versus RAID 5.** Under RAID 4 every write touches the single parity
disk, so that disk is a bottleneck and its queue length grows without bound under
a write-heavy workload. Under RAID 5 parity for stripe `s` lives on disk
`(n - 1 - (s mod n))`, so the load spreads. The sim reports per-disk queue length
and the RAID 4 parity disk visibly saturates, which is the picture Ch. 11.8.3
describes in words.

**Failure and rebuild.** Disk failure is injected by the leg, never by the RNG
during normal play. On failure:

1. The array enters `degraded` mode. Reads to the failed disk are reconstructed
   by reading the other `n - 1` disks and XORing, so **read cost jumps from 1 to
   `n - 1`** and the array visibly slows.
2. Rebuild onto a spare proceeds at `rebuildBlocksPerTick` (default 4), emitting
   `raid.rebuild { level, failedDisk, progress }` every
   `rebuildProgressInterval` ticks with `progress` in `[0, 1]`.
3. **A second failure during rebuild is fatal at levels 0, 1 (same pair), 4, 5
   and 10 (same pair), and survivable at level 6.** This is the argument for
   RAID 6 and the sim makes it by killing a Leg 9 convoy that chose RAID 5 and a
   long rebuild.
4. Rebuild competes with normal traffic for the same disks, so throughput during
   rebuild drops by roughly `rebuildBlocksPerTick / totalBlocksPerTick`. The
   player can pause the rebuild to recover throughput, at the cost of extending
   the window in which a second failure is fatal. That choice is the leg's
   decision point.

---

## 11. I/O (Ch. 12)

### 11.1 Polling, interrupts and DMA

`Device.mode` is `IoMode`, one of `'polling' | 'interrupt' | 'dma'`. The cost
model is what makes the comparison land, so it is specified exactly.

Each device has a status register with a busy bit and a command-ready bit
(Ch. 12.2.1).

**Polling.** The requesting process executes a poll loop. Each iteration is one
tick of CPU service, spent by the process, and produces nothing until the device
finishes.

```
1. process issues the request                     cost: 1 tick
2. while device.busy:                             cost: 1 tick per iteration,
       read the status register                          charged to the process
3. transfer the data word by word                 cost: bytes / wordSize ticks,
                                                         charged to the process
```

Wasted ticks are `device.latency - 1` per request, and every one of them is
emitted as `io.poll_wasted { device, wastedTicks }` when the loop ends. Those
ticks count as CPU busy in `cpuUtilisation`, which is the trap: a polled system
shows 100 percent CPU utilisation and near-zero throughput. The `top` command
separates `poll%` from `user%` so the player can find it once they know to look.

**Interrupt-driven.** The process issues the request and blocks.

```
1. process issues the request                     cost: 1 tick, then T5 to waiting
2. the CPU runs other processes                   cost: 0 to the requester
3. device completes, raises the interrupt line    phase 2
4. the interrupt is delivered                     cost: interruptServiceTicks (default 2),
                                                        charged to the KERNEL, not to any process
5. the handler copies the data word by word       cost: bytes / wordSize ticks, kernel
6. the requester is marked wakeable               phase 3, unblocked in phase 4
```

Total CPU cost to the system per request: `1 + interruptServiceTicks + transfer`.
Total cost to the requesting process: 1 tick. The difference between that and
polling's `device.latency + transfer` is the whole lesson, and with the default
`latency = 20` it is a factor of roughly seven.

**DMA (Ch. 12.2.3).** The process issues the request; the DMA controller
transfers directly to memory; one interrupt fires at the end of the whole
transfer rather than one per word.

```
1. process issues the request, programs the DMA controller   cost: 2 ticks
2. the controller transfers                                  cost: 0 CPU ticks
   (it steals memory cycles: charge dmaCycleStealRatio of the
    transfer duration, default 0.1, to the currently running process)
3. one completion interrupt                                  cost: interruptServiceTicks
4. the requester is unblocked
```

Total CPU cost per request: `2 + interruptServiceTicks + 0.1 * transferTicks`,
which for a large transfer is effectively constant. Emits
`io.dma_transfer { device, bytes }`.

**The comparison table**, computed by the sim for 10 requests of 4096 bytes on a
device with `latency = 20` and `wordSize = 64` (so `transferTicks = 64`):

| Mode | CPU ticks per request | CPU ticks for 10 | Requester blocked? |
|---|---|---|---|
| polling | 1 + 19 + 64 = 84 | 840 | no, it spins |
| interrupt | 1 + 2 + 64 = 67 | 670 | yes |
| dma | 2 + 2 + 6.4 = 10.4, rounded to 10 | 100 | yes |

Test fixture `IO-COST-1`. The polling row and the DMA row differ by 8.4x, and the
Leg 10 opening hands the player a polled device and the bandwidth budget to
upgrade it.

### 11.2 The interrupt path (Ch. 12.2.2)

```ts
interface InterruptLine {
  readonly device: DeviceId;
  readonly priority: number;        // 0 is highest, matching the PCB convention
  readonly maskable: boolean;
  pending: number;                  // count of undelivered raises, saturating at maxPending
}

interface InterruptController {
  readonly lines: InterruptLine[];  // sorted by (priority, deviceId), fixed at construction
  mask: Set<DeviceId>;              // currently masked lines
  inService: DeviceId | null;       // the line being serviced, for nesting rules
}
```

**Delivery, phase 3, numbered:**

1. Build the candidate list: lines with `pending > 0`, not in `mask`, sorted by
   `(priority, deviceId)`. The sort key is fixed at construction so the array can
   be pre-sorted and the scan is linear.
2. If `inService !== null`, a candidate is delivered only when its `priority` is
   strictly less than the in-service line's priority. This is nested interrupt
   handling and it is what interrupt priorities are for (Ch. 12.2.2).
3. Deliver up to `maxInterruptsPerTick` (default 2) candidates. For each:
   - decrement `pending`
   - set `inService`
   - charge `interruptServiceTicks` to the kernel's overhead counter
   - run the handler: mark the waiting process wakeable, complete the transfer
   - emit `io.interrupt { device, pid }`
   - restore the previous `inService`
4. Non-maskable lines (`maskable: false`) skip step 2 and are always delivered.
   Only the timer line and the `kernel.panic` line are non-maskable.

**Interrupt overhead is charged to the kernel**, not to the interrupted process.
It reduces `cpuUtilisation`'s numerator without increasing any process's
`totalCpuUsed`, so a system drowning in interrupts shows falling utilisation and
no process making progress, which is the correct picture.

### 11.3 The interrupt storm

**Condition.** `totalPending` across all lines exceeds `interruptStormThreshold`
(default 32) for `interruptStormWindow` consecutive ticks (default 10).

**Cause in the sim.** A device with `latency = 1` and a queue that refills, or a
RAID array in degraded mode generating `n - 1` reads per logical read, or a
process in a tight `ioctl` loop. Leg 10's encounter uses the second.

**Effect.** With `maxInterruptsPerTick = 2` and more than 2 arriving per tick,
`pending` grows without bound. Each delivery costs `interruptServiceTicks`, so
the kernel spends `2 * 2 = 4` ticks of every tick on interrupts, which is
impossible, so the kernel falls behind: user process progress goes to zero while
the interrupt queue grows. This is livelock, and it is the pathology the
`interrupt_storm` affliction models.

**Detection and response, escalating:**

| Stage | Condition | Response |
|---|---|---|
| 1 | storm condition holds | emit `io.interrupt` with `pid: null` and raise the `interrupt_storm` affliction on the convoy |
| 2 | holds for `2 * window` | **mask the offending line** and switch that device to polling with a long poll interval, which is the standard mitigation: interrupts are turned off and the driver polls until the flood subsides |
| 3 | holds for `4 * window` | terminate the process generating the requests with `terminationReason: 'io_timeout'` |
| 4 | `pending` reaches `maxPending` on any line | `kernel.panic` with `"interrupt storm on <device>"` |

**The player's remedies**, in the order the game expects them to be discovered:
switch the device from `interrupt` to `dma` (one completion instead of one per
word), reduce the request rate by lowering the degree of multiprogramming, or
spend bandwidth on KESTREL's `prefetch` to drain the backlog. Masking is what the
kernel does on its own, and the player watching the device drop to polling and
seeing throughput recover is how they learn that interrupts are not free.

### 11.4 Buffering, caching and spooling (Ch. 12.5)

**Buffering.** Three schemes, selectable per device:

- `single`: one buffer. The producer must wait for the consumer to drain it, so
  producer and consumer are fully serialised.
- `double`: two buffers. The producer fills one while the consumer drains the
  other, so they overlap. Throughput roughly doubles when producer and consumer
  rates are matched, and does not improve at all when one dominates, which is the
  Ch. 12.5 point about the bottleneck.
- `circular`: `n` buffers in a ring. This is the bounded buffer of §8.7 and it
  reuses that implementation, which is why Leg 10 can hand the player a problem
  they already solved on Leg 5.

Metrics per device: `bufferOccupancy` (mean over the last 100 ticks) and
`bufferStalls` (count of ticks the producer waited). A device whose occupancy
sits at capacity has a slow consumer; one whose occupancy sits at zero has a slow
producer. The HUD draws the occupancy as a filling column.

**Caching.** A block cache in front of the disk, `blockCacheEntries` (default 64)
holding `BlockId -> contents`, with LRU replacement using the same comparator as
§7.5's LRU. Hit and miss counts feed a hit rate. Write policy is
`'write_through' | 'write_back'`:

- `write_through`: every write goes to the disk immediately. Safe, slow, and a
  crash loses nothing.
- `write_back`: writes mark the entry dirty and are flushed on eviction or on the
  `sync` syscall. Fast, and **a crash loses every dirty entry**, which is what
  the crash simulation in §12.6 exploits.

The difference between the two is the difference between a file system that
survives Leg 11's crash and one that does not, and the player chooses it at a
depot several legs earlier.

**Spooling.** A spool is a queue of complete jobs for a device that cannot
interleave, modelled for the printer device. Jobs are appended whole and served
FCFS. Without spooling, two processes writing to the printer interleave their
output and both jobs are ruined, which the sim represents as
`fs.corruption { recoverable: false }` on the output file. With spooling, the
second job waits. This is a two-line demonstration of why the abstraction exists.

### 11.5 The device driver abstraction

`Device` in `types.ts` is the kernel-visible half. The driver is the other half:

```ts
interface DeviceDriver {
  readonly device: DeviceId;
  readonly kind: 'block' | 'character' | 'network';

  /** Called by the syscall layer. Returns ticks until completion, or blocks. */
  submit(req: IoRequest, ctx: IoContext): IoSubmission;
  /** Called in phase 2 when the device's service counter reaches zero. */
  complete(req: IoRequest, ctx: IoContext): void;
  /** Called in phase 3 when the line for this device is delivered. */
  onInterrupt(ctx: IoContext): void;
  /** Device-specific commands from the `ioctl` syscall. */
  control(command: string, args: readonly (string | number | boolean)[], ctx: IoContext): SyscallResult;
  snapshot(): DeviceSnapshot;
}

interface IoSubmission {
  readonly acceptedTicks: number;      // ticks charged to the caller at submit time
  readonly blocks: boolean;            // whether the caller transitions T5
  readonly queuePosition: number;
}
```

The kernel knows only this interface. Adding a device type means adding a driver
and registering it, with no change to phases 2 and 3. Four drivers ship:

| Driver | Kind | Notes |
|---|---|---|
| `disk0` | block | the geometry and scheduling of §10 |
| `nvm0` | block | the NVM model of §10.5, appears after the depot upgrade |
| `console` | character | one byte per tick, always `interrupt` mode |
| `net0` | network | fixed latency, packet loss drawn from `root/io`, used by the Leg 12 adversary |

`ioctl` is the escape hatch and every driver-specific behaviour goes through it,
which keeps `SyscallName` frozen while allowing new devices. §14 lists the
commands each driver accepts.

---

## 12. File systems (Ch. 13 to 15)

### 12.1 Directory structure and path resolution (Ch. 13.3)

The simulator implements the **acyclic-graph** directory of Ch. 13.3.5: a tree
with hard links permitted to files and forbidden to directories, which keeps
cycles out and makes reference counting sound.

`Inode` from `types.ts` carries `kind: 'file' | 'directory' | 'link'` and
`linkCount`. Directory contents live in a side structure keyed by inode:

```ts
interface DirectoryEntry { readonly name: string; readonly inode: InodeId; }
type DirectoryTable = Map<InodeId, DirectoryEntry[]>;   // entries sorted by name
```

Directory entries are kept **sorted by name** using a plain code-unit comparison
(`a.name < b.name ? -1 : a.name > b.name ? 1 : 0`), never `localeCompare`, so
listing order is locale-independent and byte-stable.

**Path resolution, numbered:**

1. Split the path on `/`. An empty first component means the path is absolute and
   resolution starts at the root inode (id 2, matching Unix convention; ids 0 and
   1 are reserved). Otherwise it starts at the process's current working
   directory.
2. For each component:
   - `.` is a no-op.
   - `..` moves to the parent, with the root's parent being the root.
   - Otherwise look up the component in the current directory's entries by binary
     search. Missing entry: return `ENOENT`.
   - If the current inode is not a directory and components remain: return
     `EINVAL` (the sim uses `EINVAL` where Unix uses `ENOTDIR`, which is not in
     the frozen `Errno` union; §14 records the substitution).
   - **Permission check.** The process's domain must hold `execute` on each
     directory traversed. Missing it returns `EACCES` and emits
     `security.access_denied`.
   - If the entry is a `link`, resolve it. Depth is capped at
     `maxSymlinkDepth` (default 8); exceeding it returns `EINVAL`.
3. Return the final inode.

Each component costs one directory-block read, so path depth is a real cost and
`/a/b/c/d/e` is five reads. The sim caches resolved paths in a
`Map<string, InodeId>` of `dentryCacheEntries` (default 128) with LRU
replacement, so a repeated open is cheap. The cache is invalidated wholesale on
`unlink` and `mkdir`, which is correct and crude.

### 12.2 Inode structure (Ch. 14.4.3)

```
Inode (from types.ts) plus the on-disk layout the sim models:

  direct[12]         12 direct block pointers
  singleIndirect     one block of pointers          -> 128 blocks
  doubleIndirect     one block of pointers to blocks of pointers -> 16,384 blocks
  tripleIndirect     -> 2,097,152 blocks
```

With `blockSize = 4096` and `pointerSize = 32` bytes (large, so the arithmetic is
small and legible), a pointer block holds `4096 / 32 = 128` pointers.

**Maximum file size:**

```
direct           12 * 4096          =        49,152 bytes
single indirect  128 * 4096         =       524,288 bytes
double indirect  128 * 128 * 4096   =    67,108,864 bytes
triple indirect  128^3 * 4096       = 8,589,934,592 bytes
                                     ───────────────
total                                 8,657,616,896 bytes ≈ 8.06 GiB
```

Test fixture `FS-INODE-1`.

**Access cost by offset**, which is the number the player sees when they read a
large file:

| Byte offset | Blocks to read to reach the data | Total reads |
|---|---|---|
| 0 to 49,151 | direct pointer is in the inode | 1 |
| 49,152 to 573,439 | single indirect block, then data | 2 |
| 573,440 to 67,682,303 | double indirect, single indirect, data | 3 |
| beyond | triple, double, single, data | 4 |

The inode itself is assumed cached once the file is open, which is why the first
row is 1 and not 2.

### 12.3 Allocation methods (Ch. 14.4)

`FileAllocationMethod` is `'contiguous' | 'linked' | 'indexed' | 'extent'`. All
four are implemented, `Inode.method` records which one a file uses, and a single
file system may hold files of different methods so the comparison is live.

Costs below are in **block reads**, for a file of `n` blocks, and are what the
`stat` terminal command prints.

#### Contiguous (Ch. 14.4.1)

Layout: `blocks` holds `[start, start+1, ..., start+n-1]`; the inode stores start
and length.

| Operation | Cost | Why |
|---|---|---|
| sequential read of all `n` blocks | `n` reads, **1 seek** | the blocks are adjacent |
| random access to block `i` | 1 read, 1 seek | address is `start + i`, computed |
| append one block | 1 read plus **`n` reads and `n` writes** if `start + n` is occupied | the whole file must be relocated |
| grow to a size with no hole | fails, `ENOSPC` | |

External fragmentation: **severe**, and it is the same problem as §6.3's
contiguous memory allocation, which is why the codex cross-references them.

#### Linked (Ch. 14.4.2)

Layout: each block's last `pointerSize` bytes hold the next `BlockId`. The inode
stores the first and last block.

| Operation | Cost | Why |
|---|---|---|
| sequential read | `n` reads, up to `n` seeks | blocks may be anywhere |
| **random access to block `i`** | **`i + 1` reads** | the chain must be walked |
| append | 1 read plus 1 write | the last pointer is known |
| grow | always possible while free blocks exist | |

External fragmentation: **none**. Usable space per block:
`4096 - 32 = 4064` bytes, so `32 / 4096 = 0.78%` of the disk is pointers.

Random access cost is the reason nobody ships this. The sim makes it visible:
reading block 1000 of a linked file costs 1001 reads, and the terminal's `stat`
prints that number.

**FAT variant.** The pointers live in a table at the start of the volume rather
than in the blocks. Random access still walks the chain, but the walk is in
memory once the FAT is cached, so it costs 1 disk read. Available as
`linkedVariant: 'in_block' | 'fat'`.

#### Indexed (Ch. 14.4.3)

Layout: `Inode.indexBlock` points at a block holding up to
`4096 / 32 = 128` block pointers. Larger files chain index blocks or use the
multilevel scheme of §12.2.

| Operation | Cost | Why |
|---|---|---|
| sequential read | `1 + n` reads | the index block, then the data |
| random access to block `i` | **2 reads** | index block, then data |
| append | 1 read plus 2 writes | index block update |
| grow | possible up to 128 blocks per index level | |

External fragmentation: **none**. Internal overhead: **one full block per file**,
so a 1-block file costs 2 blocks, which is 100 percent overhead on small files.
That is the honest cost and the codex names it.

#### Extent-based (Ch. 14.4.3, "extents")

Layout: `blocks` is stored as a list of `(start, length)` runs. A file written
sequentially into free space is one extent.

| Operation | Cost | Why |
|---|---|---|
| sequential read | `n` reads, `extents` seeks | one seek per extent |
| random access to block `i` | 1 read plus the extent-list walk (in memory) | |
| append | 1 write, and 0 metadata writes if the extent can grow | |
| grow | extends the last extent, or starts a new one | |

`fs.fragmented { inode, extents }` is emitted whenever a file's extent count
exceeds `fragmentationWarnExtents` (default 4). A file at 1 extent behaves like
contiguous; a file at `n` extents behaves like linked without the pointer walk.
Extent count is the metric the player watches and the reason the defragment
action at a depot has a visible payoff.

**The comparison the game runs.** Leg 11 writes the same 64-block file under all
four methods, then performs 20 random reads and 20 appends, and reports:

| Method | Blocks used | Sequential reads | 20 random reads | 20 appends | Fragmentation |
|---|---|---|---|---|---|
| contiguous | 64 | 64 reads, 1 seek | 20 reads | may relocate the whole file | external |
| linked | 64 | 64 reads, up to 64 seeks | mean 32.5 reads each, **650 total** | 20 reads + 20 writes | none |
| indexed | 65 | 65 reads | 40 reads | 20 reads + 40 writes | none, 1 block overhead |
| extent | 64 | 64 reads, `e` seeks | 20 reads | 20 writes, metadata when a new extent starts | measured by `e` |

The 650 in the linked row is the line the player remembers.

### 12.4 Free space management (Ch. 14.5)

**Bitmap (Ch. 14.5.1).** One bit per block, stored as a `Uint32Array` of
`ceil(totalBlocks / 32)` words.

```ts
function firstFreeBlock(bitmap: Uint32Array): BlockId | null {
  for (let w = 0; w < bitmap.length; w++) {
    if (bitmap[w] === 0xffffffff) continue;         // fully allocated word, skip
    const inverted = ~bitmap[w] >>> 0;
    const bit = 31 - Math.clz32(inverted & -inverted);
    return (w * 32 + bit) as BlockId;
  }
  return null;
}
```

The word skip is what makes this fast: for a disk of 51,200 blocks the bitmap is
1,600 words, and finding a free block is a scan of at most 1,600 comparisons.

Size at the sim's defaults: 51,200 blocks (25 MiB at 512-byte sectors, or 6,400
4 KB blocks; the sim uses 4 KB blocks, so 6,400 blocks and 200 words, 800 bytes
of bitmap). Test fixture `FS-BITMAP-1` asserts that the bitmap size is
`ceil(6400 / 32) = 200` words.

The bitmap's advantage is that finding `n` **contiguous** free blocks is a scan
for a run of zero bits, which the linked list cannot do at all. That is why the
contiguous and extent allocators require a bitmap and the sim refuses the
combination of `fileAllocation: 'contiguous'` with
`freeSpaceMethod: 'linked_list'`.

**Linked list (Ch. 14.5.2).** The superblock points at the first free block,
which points at the next.

| Operation | Bitmap | Linked list |
|---|---|---|
| allocate 1 block | scan, O(blocks / 32) | 1 read, O(1) |
| free 1 block | clear a bit, O(1) | 1 write, O(1) |
| **allocate `n` contiguous** | run scan, O(blocks / 32) | **impossible without traversing the whole list** |
| space overhead | 1 bit per block | 1 pointer per free block, stored in the free block itself, so **zero** |
| survives a crash | must be rebuilt by scanning every inode | must be rebuilt the same way |

**Grouping and counting** (Ch. 14.5.3 and 14.5.4) are offered as
`freeSpaceMethod: 'grouping' | 'counting'`. Counting stores
`(firstFreeBlock, runLength)` pairs and is what a modern extent-based file system
actually does, so it pairs with `fileAllocation: 'extent'`.

### 12.5 Journaling (Ch. 14.8 and 11.7.5)

`JournalEntry` from `types.ts` has four phases: `begin`, `write`, `commit`,
`checkpoint`. Those are the write-ahead protocol.

**The write-ahead rule.** *A change is written to the journal before it is
written to its final location on disk.* Concretely, for a transaction that
modifies blocks `B`:

```
1. append JournalEntry { phase: 'begin',      txId, blocks: [] }
2. append JournalEntry { phase: 'write',      txId, blocks: B }   // the new contents, in the journal
3. FLUSH the journal to stable storage                            // this is the barrier
4. append JournalEntry { phase: 'commit',     txId, blocks: [] }
5. FLUSH the journal to stable storage                            // the commit record is now durable
6. write the blocks B to their final locations                    // "checkpointing"
7. append JournalEntry { phase: 'checkpoint', txId, blocks: B }
8. the journal space for txId may now be reclaimed
```

Steps 3 and 5 are the only two flushes, and both are required. Skipping step 3
means a commit record can be durable while the data it describes is not, so
recovery would replay garbage. Skipping step 5 means recovery cannot tell a
completed transaction from an abandoned one.

**Journal modes:**

| Mode | What goes in the journal | Cost | Crash guarantee |
|---|---|---|---|
| `metadata` (default) | inodes, directory entries, the bitmap | ~1.1x writes | the file system is structurally consistent; file *contents* may be stale or garbage |
| `full` | metadata plus data blocks | **2x writes**, everything is written twice | contents are consistent too |
| `off` | nothing | 1x writes | nothing is guaranteed |

The 2x figure for `full` is the honest cost and it is why real systems default to
metadata journaling. The depot sells `full` and the price is throughput.

**Crash simulation.** `ioctl('crash')` or a leg-scripted event does exactly this:

1. Discard every dirty entry in the block cache that has not been written
   (§11.4). This is the data loss.
2. Discard any journal entry not followed by a flush.
3. Reset every device to idle, drop every queued `DiskRequest`.
4. Preserve the on-disk state exactly as the writes that completed left it.
5. Emit `kernel.panic { message: 'crash' }`.

The crash point is chosen by the leg, deliberately, at one of eight positions in
the protocol above, so the player can be shown each case. It is never random.

**Recovery, numbered:**

1. Scan the journal from the last `checkpoint` record forward.
2. Build the set of transactions that have a `commit` record.
   These are **complete**: replay their `write` entries to their final locations,
   in `txId` order, then in the order the entries appear.
3. Transactions with a `begin` and no `commit` are **incomplete**: discard their
   `write` entries. Nothing they touched reaches the disk.
4. Emit `fs.recovered { inode, fromJournal: true }` for each inode touched by a
   replayed transaction.
5. Rebuild the free space map by scanning every inode's block list, because the
   bitmap is not journaled in `metadata` mode. This is the expensive part and
   it costs `totalBlocks / 32` reads.
6. Verify: every block appears in at most one inode, every inode's
   `linkCount` matches the number of directory entries pointing at it. A failure
   emits `fs.corruption { recoverable: false }`.

Replay is **idempotent**: replaying a committed transaction that was already
checkpointed writes the same bytes again and changes nothing. That property is
what lets recovery run without knowing how far checkpointing got, and it is the
reason step 2 does not need to check.

### 12.6 What corruption looks like without journaling

Take a single operation, `unlink("/data/log")`, which touches three things:

```
A. remove the directory entry from /data
B. decrement the inode's linkCount, and free the inode when it reaches 0
C. mark the file's blocks free in the bitmap
```

A crash between any two of them leaves a specific, nameable inconsistency. The
sim can crash at each point and each one produces a different
`fs.corruption` event:

| Crash after | State on disk | Name | Recoverable without a journal? |
|---|---|---|---|
| A only | inode exists, no directory entry points at it, blocks still marked used | **orphaned inode** | yes, by `fsck` moving it to `lost+found`; the data survives, the name does not |
| A and B | inode is free, blocks still marked used | **leaked blocks** | yes, by `fsck` rebuilding the bitmap from every inode; costs a full scan |
| B only | directory entry points at a free inode | **dangling entry** | opening the path returns whatever now occupies that inode, which may be another file. **Silent aliasing.** |
| C only | blocks marked free while an inode still lists them | **double allocation** | the next file written gets blocks that belong to a live file. **Silent data destruction.** |

The last two rows are the point. The first two lose space and cost a scan. The
last two hand one file's blocks to another file and nothing detects it until the
data is read back wrong. With journaling, all four are impossible: the three
steps are one transaction, and after recovery either all three happened or none
did.

`fs.corruption { recoverable }` distinguishes the rows: `true` for orphaned
inodes and leaked blocks, `false` for dangling entries and double allocation.
ORRERY's passive makes `recoverable: false` cases recoverable by rebuilding the
inode from the journal, which is why losing ORRERY before Leg 11 is a serious
loss and the design brief says so.

**The Leg 11 encounter.** The player is given an unjournaled file system and a
crash at a moment chosen to produce double allocation. The corruption is silent:
everything reads fine until a later leg reads a block that has been overwritten,
at which point a convoy Program takes `terminationReason: 'storage_corruption'`.
The delay between cause and effect is deliberate and is the strongest argument
for journaling the game can make.

---

## 13. Protection and security (Ch. 16 and 17)

### 13.1 Protection rings (Ch. 17.3)

`ProtectionRing` is `0 | 1 | 2 | 3`. Ring 0 is the kernel; ring 3 is user code.
Rings 1 and 2 exist for device drivers and trusted services and are used by the
Leg 12 scenario.

```ts
interface RingState {
  current: ProtectionRing;
  /** Saved ring for the return path, one entry per nested trap. */
  readonly stack: ProtectionRing[];
}
```

**Ring transition rules:**

1. **A process may never raise its own privilege by setting a register.** There
   is no instruction in the sim's instruction set that writes `current`.
2. **The only way inward is a trap.** A `syscall` instruction traps to ring 0 via
   a gate. The gate is the syscall dispatch table of §14; entry lands at a fixed
   handler and never at a caller-supplied address.
3. **The only way outward is a return from a trap**, which pops `stack` and can
   only restore a ring numerically greater than or equal to the saved one.
4. **A call from ring `r` to a gate declared for ring `g` is permitted only when
   `r >= g`.** Calling outward (a ring 0 handler calling a ring 3 routine) is
   permitted; calling inward without a gate is not.
5. Data access follows the same rule: a process in ring `r` may read or write a
   page whose required ring is `g` only when `r <= g`. A violation emits
   `security.access_denied` and terminates the process with
   `terminationReason: 'protection_fault'`.

Every attempted transition emits
`security.escalation_attempt { pid, fromRing, toRing, blocked }`, including the
legitimate ones, with `blocked: false`. The world layer draws legitimate
transitions as a brief flare and blocked ones as a wall.

### 13.2 The access matrix (Ch. 17.4)

Rows are domains, columns are objects, cells are sets of `AccessRight`.

```
                 file:/etc/keys   file:/data/log   device:disk0   domain:kernel
  domain:user        -               read,write        -               -
  domain:driver      -               read              read,write      -
  domain:kernel   read,write,owner  read,write,owner  read,write     control
```

`ProtectionDomain.rights` from `types.ts` is `ReadonlyMap<string, readonly AccessRight[]>`,
which is **one row of this matrix**, keyed by object id. The full matrix is the
set of domains, and it is never materialised as a two-dimensional array because
it is sparse.

**The six rights and what each permits:**

| Right | Permits |
|---|---|
| `read` | read the object's contents |
| `write` | modify the object's contents |
| `execute` | run the object, or traverse it when it is a directory |
| `owner` | add or remove any right on this object in any domain |
| `copy` | grant this right to another domain, without granting `copy` itself unless the right is marked transferable |
| `control` | modify another domain's row, which is what makes a domain a supervisor of another |

`owner`, `copy` and `control` are the three special rights of Ch. 17.4 and the
sim implements all three, because the Leg 12 escalation attempt targets `copy`.

**The access check**, called on every object access:

```ts
function checkAccess(k: KernelState, pid: Pid, object: string, right: AccessRight): boolean {
  const domain = k.domain(k.pcb(pid)!.domain)!;
  const rights = domain.rights.get(object) ?? [];
  const ok = rights.includes(right) || rights.includes('owner');
  if (!ok) k.emit({ type: 'security.access_denied', domain: domain.id, object, right });
  return ok;
}
```

`owner` implies every right on that object, which is the standard reading of
Ch. 17.4.2 and keeps the matrix small.

### 13.3 ACL versus capability list (Ch. 17.5)

The same matrix, stored two ways, and the sim implements both so the player can
compare them.

**Access control list: store the matrix by column.** Each object carries a list
of `(domain, rights)`.

```ts
type AccessControlList = Map<string, Map<DomainId, AccessRight[]>>;   // object -> domain -> rights
```

**Capability list: store the matrix by row.** Each domain carries a list of
`(object, rights)` capabilities, and a capability is itself an unforgeable token.

```ts
interface Capability { readonly object: string; readonly rights: readonly AccessRight[]; readonly seal: number; }
type CapabilityList = Map<DomainId, Capability[]>;
```

`seal` is the unforgeability mechanism: it is
`fnv1a32(`${object}|${rights.join(',')}|${domainId}|${kernelSecret}`)` where
`kernelSecret` is drawn once from `root/security` at construction. A capability
whose `seal` does not match is rejected, which is how the sim models a hardware
tagged pointer or a cryptographic capability without pretending to do
cryptography.

| Question | ACL answers cheaply | Capability list answers cheaply |
|---|---|---|
| "who can read this file?" | **yes**, read one column | no, scan every domain |
| "what can this process touch?" | no, scan every object | **yes**, read one row |
| revoke all access to an object | **yes**, clear the column | hard: capabilities are already distributed |
| pass a right to another process | requires a matrix edit | **yes**, hand over the capability |
| check cost per access | look up the object, then the domain | look up the capability the caller presented |

The sim uses ACL as the default (`accessModel: 'acl'`) because revocation
matters for the Leg 12 scenario, and offers `'capability'` so the player can
discover that revocation is the hard part. `ConfigChange` of `accessModel`
rebuilds the other representation from the matrix, and invariant I-22 asserts
that both representations agree after the rebuild.

### 13.4 Domain switching (Ch. 17.4.1)

A domain switch changes which row of the matrix applies to a process. Three
mechanisms:

1. **`exec` of a setuid-equivalent file.** An inode may carry
   `switchesToDomain: DomainId | null`. Executing it switches the process's
   `domain` to that value for the lifetime of the program. This is the Unix
   mechanism of Ch. 17.4.1 and it is also the escalation vector of §13.6.
2. **An explicit domain switch right.** Domains are objects in the matrix, so a
   domain row may hold a right on `domain:other`. Holding `control` on a domain
   permits switching into it, via `ioctl('domain_switch', targetDomainId)`.
3. **A trap.** Entering ring 0 switches to `domain:kernel` for the duration of
   the handler and restores the caller's domain on return. This switch is
   implicit, is never denied, and is the reason syscall argument validation is
   the security boundary rather than the ring check.

Every switch emits `security.escalation_attempt` with the ring of the source and
target domains, so a switch that does not change ring shows
`fromRing === toRing` and `blocked: false`.

### 13.5 RBAC and least privilege (Ch. 17.6 and 16.1)

**Role-based access control.** A layer of indirection between processes and
domains:

```ts
interface Role {
  readonly id: string;
  readonly displayName: string;
  /** Domains this role may operate in. */
  readonly domains: readonly DomainId[];
  /** Roles whose privileges this role also holds. Must form a DAG. */
  readonly inherits: readonly string[];
}
```

Roles shipped:

| Role | Inherits | Domains | Ring |
|---|---|---|---|
| `guest` | none | `domain:user_ro` | 3 |
| `user` | `guest` | `domain:user` | 3 |
| `operator` | `user` | `domain:user`, `domain:spool` | 3 |
| `driver` | none | `domain:driver` | 1 |
| `admin` | `operator` | all user-space domains | 3 |
| `kernel` | none | `domain:kernel` | 0 |

Role inheritance is resolved by depth-first traversal with a visited set;
`inherits` must be acyclic and the kernel throws at construction if it is not.
Note that `driver` does not inherit from `user`: a driver at ring 1 has different
privileges rather than more of them, which is the point of a ring in the middle.

**Least privilege (Ch. 16.1).** The sim measures it. Every process accumulates
the set of `(object, right)` pairs it actually used. The **privilege excess** is:

```
excess = |rightsHeld| - |rightsUsed|
```

reported per process and summed for the run. It appears in `ScoreBreakdown` as
part of `correctness`. A player who spawns every worker in `domain:kernel`
because it always works will finish Leg 12 with a large excess and a low score,
and the debrief prints the number with the list of unused rights. Nothing warns
them beforehand.

### 13.6 The privilege escalation scenario

**The adversary.** Leg 12 spawns a process named `arbiter_probe`, in
`domain:user`, ring 3, with a program that attempts five escalations in order.
Each one is blocked by a specific, named defence, and the sim emits the block so
the codex can explain it.

**Attempt 1: direct ring write.** The program executes
`ioctl('set_ring', 0)`.

*Defence:* the `set_ring` command does not exist in any driver's `control`
table. `ioctl` returns `EINVAL`. Emits
`security.escalation_attempt { fromRing: 3, toRing: 0, blocked: true }`.
**Rule 1 of §13.1**: privilege is not a writable register.

**Attempt 2: syscall with an out-of-range argument.** The program calls
`read(fd, buffer, length)` with a `length` far beyond its allocation, hoping the
handler copies into kernel memory.

*Defence:* **syscall argument validation at the gate.** Every handler validates
every argument against the caller's address space before touching anything
(§14.2). Returns `EINVAL`. The general rule the codex draws: the ring boundary is
not the check, the argument validation is the check, because the caller controls
the arguments and controls nothing else.

**Attempt 3: confused deputy through a shared mapping.** The program `mmap`s a
shared region, then persuades a ring 1 driver to write into it by passing the
region as an `ioctl` destination, hoping the driver's higher privilege is applied
to the write.

*Defence:* **the access check uses the domain of the original requester, not the
domain of the process performing the access.** Every `IoRequest` carries
`requesterDomain`, and `checkAccess` is called with that, not with the driver's
domain. Returns `EACCES`, emits `security.access_denied`. This is the confused
deputy problem of Ch. 17.4 and the defence is the reason capabilities are
attractive: a capability passed to the driver would carry the caller's authority
explicitly.

**Attempt 4: setuid escalation through a writable binary.** The program finds an
inode with `switchesToDomain: 'domain:kernel'`, checks whether it can write to
it, and if so overwrites its program with its own and executes it.

*Defence:* **an inode carrying `switchesToDomain` is write-protected against
every domain except the one it switches to.** The check is in the `open` handler,
not in `exec`, so the attempt fails at the earliest possible point. Returns
`EACCES`. If the leg deliberately mis-permissions the file, the attempt
**succeeds**, the probe reaches `domain:kernel`, and the convoy loses a Program
to a `protection_fault` cascade. Leg 12's hard mode does exactly that, and the
remedy is `chmod` from the terminal before the probe reaches it.

**Attempt 5: capability forgery.** Under `accessModel: 'capability'`, the program
constructs a `Capability` object naming `domain:kernel` with `control` and
presents it.

*Defence:* **the seal.** The presented `seal` is recomputed from the object,
rights, domain and `kernelSecret`, and does not match, so the capability is
rejected. Returns `EPERM`. The program cannot compute a valid seal because
`kernelSecret` is never readable from any user domain and appears in no event
payload. Test `SEC-CAP-1` asserts that `kernelSecret` does not appear in the
serialised event log of a full run, which is a real test of a real property.

**The scenario's assertion.** With default configuration, running
`SEC-ESCALATION-1` for 5,000 ticks produces exactly five
`security.escalation_attempt` events, all with `blocked: true`, and the probe
terminates with `terminationReason: 'protection_fault'`. With the leg's
mis-permissioned inode, attempt 4 produces `blocked: false` and the run diverges,
which is the fixture for the failure path.

---

## 14. System call interface (Ch. 2.3)

### 14.1 Dispatch

```ts
type SyscallHandler = (req: SyscallRequest, k: KernelState) => SyscallResult;

const SYSCALL_TABLE: Readonly<Record<SyscallName, SyscallHandler>> = { /* one entry per name */ };

function dispatch(req: SyscallRequest, k: KernelState): SyscallResult {
  const pcb = k.pcb(req.pid);
  if (pcb === undefined) return err('ESRCH', `no such process ${req.pid}`);
  if (pcb.state !== 'running')  return err('EPERM', 'syscall from a non-running process');

  k.rings.enter(0, pcb);                         // trap: save the caller's ring, switch to kernel
  try {
    const validation = validateArgs(req, k);     // §14.2
    const result = validation.ok ? SYSCALL_TABLE[req.name](req, k) : validation;
    k.emit({ type: 'syscall.invoked', request: req, result });
    return result;
  } finally {
    k.rings.leave(pcb);                          // return from trap, restore the caller's ring
  }
}
```

`syscall.invoked` is emitted for **every** call including failures, which makes
the event log a complete strace and is what the terminal's `trace` command
renders.

`Kernel.syscall(request)` is the public entry point. It executes the call
immediately and synchronously, outside the tick loop, which is how the terminal
and the game layer drive the kernel. A call that blocks the caller sets the PCB
state and the block takes effect on the next `step()`.

### 14.2 Argument validation, and the substituted errnos

Validation runs before any handler and covers, in this order:

1. **Arity.** Wrong argument count returns `EINVAL`.
2. **Types.** `SyscallRequest.args` is `(string | number | boolean)[]`; a
   handler declares the expected type per position and a mismatch returns
   `EINVAL`.
3. **Ranges.** Integer arguments must be finite integers within the declared
   bound. A file descriptor must be in `pcb.openFiles`. A `Pid` must exist. An
   address must lie within the caller's address space. A negative size returns
   `EINVAL`.
4. **Rights.** The caller's domain must hold the required right on the named
   object, checked with `checkAccess` (§13.2), with the **caller's** domain and
   never the kernel's.

`Errno` is frozen and lacks four codes that Unix would use. The substitutions are
fixed and the message text carries the real meaning:

| Unix errno | Sim returns | Message prefix |
|---|---|---|
| `ECHILD` | `ESRCH` | `"no children: "` |
| `ENOTDIR` | `EINVAL` | `"not a directory: "` |
| `EBADF` | `EINVAL` | `"bad file descriptor: "` |
| `EMFILE` | `EAGAIN` | `"too many open files: "` |
| `EFAULT` | `EINVAL` | `"address out of range: "` |
| `EISDIR` | `EINVAL` | `"is a directory: "` |
| `ENOTEMPTY` | `EBUSY` | `"directory not empty: "` |

### 14.3 The reference table

Every `SyscallName`, with parameters, preconditions, effects, return value, and
every `Errno` it can produce. Argument positions are zero-based and refer to
`SyscallRequest.args`.

#### Process control

**`fork()`**
- Parameters: none.
- Preconditions: the caller is running; the process table has room.
- Effects: §3.4 in full. Creates a child in state `new` with a COW-shared address
  space. Emits `process.created`.
- Returns: `{ ok: true, value: childPid }` to the parent. The child observes 0 on
  its first dispatch.
- Errno: `EAGAIN` (process table full), `ENOMEM` (no address space id available).

**`exec(programName: string)`**
- Parameters: `args[0]` program name.
- Preconditions: the named program exists in the leg's program table; the caller's
  domain holds `execute` on `program:<name>`.
- Effects: §3.5. Tears down the address space, installs the new program, resets
  `queueLevel` to 0, flushes the caller's TLB entries. If the program's inode
  carries `switchesToDomain`, switches the caller's domain (§13.4).
- Returns: `{ ok: true, value: null }`.
- Errno: `ENOENT`, `EACCES`, `ENOMEM`.

**`exit(code: number)`**
- Parameters: `args[0]` exit code, an integer in `[0, 255]`.
- Preconditions: the caller is running.
- Effects: §3.5. Releases resources, closes descriptors, frees frames, reparents
  children to init, sets state `zombie`, wakes a waiting parent. Emits
  `process.exited`.
- Returns: does not return; the sim yields `{ ok: true, value: null }`.
- Errno: `EINVAL` (code out of range).

**`wait(pid?: number)`**
- Parameters: `args[0]` optional child pid; absent or -1 means any child.
- Preconditions: the caller has at least one child.
- Effects: §3.5. Reaps the lowest-pid zombie child, or blocks with
  `{kind: 'child_wait'}`. Emits `process.reaped` on a successful reap.
- Returns: `{ ok: true, value: exitCode }` on a reap; blocks otherwise.
- Errno: `ESRCH` (no children, or the named pid is not a child).

**`kill(pid: number, signal?: number)`**
- Parameters: `args[0]` target pid, `args[1]` optional signal (0 = check
  existence only, 9 = terminate; only these two are modelled).
- Preconditions: the target exists and is not `terminated`; the caller's domain
  holds `control` on `process:<pid>`, or the caller is the target's parent, or
  the caller is the target.
- Effects: signal 9 transitions the target to `zombie` with
  `terminationReason: 'killed_by_parent'` (or `'killed_by_user'` when issued from
  the terminal), removing it from every wait queue and freeing its resources.
  Signal 0 changes nothing.
- Returns: `{ ok: true, value: null }`.
- Errno: `ESRCH` (no such process, or the target is a zombie for signal 9),
  `EPERM` (no right), `EINVAL` (unmodelled signal).

**`getpid()`**
- Parameters: none.
- Preconditions: none.
- Effects: none.
- Returns: `{ ok: true, value: callerPid }`.
- Errno: none. This is the only call in the table that cannot fail, and it exists
  in the game as the first syscall the player ever issues, on Leg 0.

**`nice(delta: number)`**
- Parameters: `args[0]` integer delta, `[-20, 19]`.
- Preconditions: a **negative** delta (raising priority) requires `control` on
  `process:<self>`, which only ring 0 and `domain:admin` hold. A positive delta
  (lowering priority) is always permitted.
- Effects: `basePriority = clamp(basePriority + delta, 0, maxPriority)` and
  `priority = basePriority`. Marks the scheduler's priority heap dirty.
- Returns: `{ ok: true, value: newBasePriority }`.
- Errno: `EPERM` (negative delta without the right), `EINVAL` (delta out of
  range).

#### Memory

**`mmap(pages: number, writable: boolean, regionId?: string)`**
- Parameters: `args[0]` page count, `args[1]` writable flag, `args[2]` optional
  shared region id.
- Preconditions: `pages >= 1`; with a region id, the region exists and the
  caller's domain holds `read` (and `write` when `writable`) on
  `region:<id>`.
- Effects: with no region id, extends the caller's address space by `pages`
  pages, all invalid, to be faulted in on demand. With a region id, maps the
  region's pages into the caller's page table pointing at the region's frames,
  pins those frames, appends the caller to `SharedRegion.attached`. Emits
  `memory.allocated` only when frames are actually taken.
- Returns: `{ ok: true, value: firstPageNumber }`.
- Errno: `EINVAL` (bad count), `ENOMEM` (address space exhausted),
  `ENOENT` (no such region), `EACCES` (no right).

**`munmap(firstPage: number, pages: number)`**
- Parameters: `args[0]` first page, `args[1]` count.
- Preconditions: the range lies inside the caller's address space.
- Effects: invalidates the page table entries, decrements `cowRefCount`, frees
  frames that reach 0, unpins shared frames when the last attacher leaves,
  removes the caller from `SharedRegion.attached`, shoots down TLB entries.
- Returns: `{ ok: true, value: null }`.
- Errno: `EINVAL` (range outside the address space).

**`brk(newSize: number)`**
- Parameters: `args[0]` the new heap size in pages.
- Preconditions: `newSize >= 0`.
- Effects: grows or shrinks the caller's heap. Growing adds invalid page table
  entries. Shrinking frees frames immediately. Growing beyond the process's frame
  allocation is permitted (demand paging will handle it) but growing beyond
  `maxPagesPerProcess` fails.
- Returns: `{ ok: true, value: newSize }`.
- Errno: `ENOMEM`, `EINVAL`.

#### File system

**`open(path: string, mode: string)`**
- Parameters: `args[0]` path, `args[1]` mode, one of `"r"`, `"w"`, `"rw"`,
  `"a"`, `"wx"` (create-exclusive).
- Preconditions: the path resolves (§12.1); the caller's domain holds the rights
  the mode implies; the caller has fewer than `maxOpenFiles` (default 32)
  descriptors open. Mode `"w"` on an inode carrying `switchesToDomain` is
  refused unless the caller is in that domain (§13.6, attempt 4).
- Effects: allocates the lowest free `FileDescriptor`, appends it to
  `pcb.openFiles`, records the inode, offset 0 (or `sizeBytes` for `"a"`).
  `"w"` truncates. `"wx"` creates and fails if the path exists.
- Returns: `{ ok: true, value: fd }`.
- Errno: `ENOENT`, `EACCES`, `EEXIST` (`"wx"` on an existing path),
  `EINVAL` (bad mode, not a directory in the path, is a directory),
  `EAGAIN` (too many open files), `ENOSPC` (creating with no free inode).

**`close(fd: number)`**
- Parameters: `args[0]` descriptor.
- Preconditions: `fd` is in `pcb.openFiles`.
- Effects: flushes the descriptor's dirty buffer under `write_back`, removes it
  from `openFiles`, decrements the inode's open count, and deletes the inode when
  its open count and `linkCount` both reach 0.
- Returns: `{ ok: true, value: null }`.
- Errno: `EINVAL` (bad descriptor).

**`read(fd: number, bytes: number)`**
- Parameters: `args[0]` descriptor, `args[1]` byte count.
- Preconditions: `fd` is open for reading; `bytes >= 0` and within the caller's
  address space bound (§13.6, attempt 2).
- Effects: computes the blocks to read from the offset and the allocation method
  (§12.3), consults the block cache, submits a disk request for each miss, and
  **blocks the caller** with `{kind: 'io', device: 'disk0'}` when any block
  misses. Advances the offset by the bytes actually read. Emits `io.request`.
- Returns: `{ ok: true, value: bytesRead }` on a full cache hit; blocks
  otherwise and delivers the value on wake.
- Errno: `EINVAL` (bad descriptor, bad count, address out of range),
  `EACCES` (not open for reading), `EBUSY` (device offline).

**`write(fd: number, bytes: number)`**
- Parameters: `args[0]` descriptor, `args[1]` byte count.
- Preconditions: `fd` is open for writing; the caller's domain holds `write` on
  the inode; free space exists.
- Effects: allocates blocks per the allocation method, journals the metadata
  change when journaling is on (§12.5), marks cache entries dirty under
  `write_back` or submits writes under `write_through`, updates `sizeBytes` and
  `modifiedTick`. Emits `fs.block_allocated` per new block, `fs.journal` per
  journal record, and `fs.fragmented` when the extent count crosses the warning.
- Returns: `{ ok: true, value: bytesWritten }`, or blocks.
- Errno: `EINVAL`, `EACCES`, `ENOSPC` (no free blocks), `EBUSY`.

**`seek(fd: number, offset: number, whence: number)`**
- Parameters: `args[0]` descriptor, `args[1]` offset, `args[2]` whence
  (0 = set, 1 = current, 2 = end).
- Preconditions: `fd` is open; the resulting offset is `>= 0`.
- Effects: sets the descriptor's offset. Seeking beyond the end is legal and
  creates a sparse region on the next write.
- Returns: `{ ok: true, value: newOffset }`.
- Errno: `EINVAL`.

**`stat(path: string)`**
- Parameters: `args[0]` path.
- Preconditions: the path resolves; the caller holds `read` on the containing
  directory.
- Effects: none.
- Returns: `{ ok: true, value: json }` where `json` is a stable
  key-sorted JSON string of the inode's id, kind, `sizeBytes`, `method`, block
  count, extent count, `linkCount`, `owner`, permissions, `createdTick` and
  `modifiedTick`. Key order is fixed so the value is comparable in tests.
- Errno: `ENOENT`, `EACCES`, `EINVAL`.

**`unlink(path: string)`**
- Parameters: `args[0]` path.
- Preconditions: the path resolves to a non-directory; the caller holds `write`
  on the containing directory.
- Effects: the three-step operation of §12.6, as one journal transaction when
  journaling is on. Removes the directory entry, decrements `linkCount`, and when
  `linkCount` and the open count both reach 0, frees the blocks and the inode.
  Invalidates the dentry cache.
- Returns: `{ ok: true, value: null }`.
- Errno: `ENOENT`, `EACCES`, `EINVAL` (is a directory), `EBUSY` (the inode is
  pinned by an in-flight I/O).

**`mkdir(path: string)`**
- Parameters: `args[0]` path.
- Preconditions: the parent resolves and is a directory; the final component does
  not exist; the caller holds `write` on the parent; a free inode and block
  exist.
- Effects: allocates an inode of kind `directory`, allocates one block for its
  entries, inserts `.` and `..`, inserts the entry into the parent in sorted
  position, increments the parent's `linkCount`. Journaled as one transaction.
- Returns: `{ ok: true, value: inodeId }`.
- Errno: `ENOENT` (parent missing), `EEXIST`, `EACCES`, `ENOSPC`, `EINVAL`.

**`chmod(path: string, bits: string)`**
- Parameters: `args[0]` path, `args[1]` a three-character string over `rwx-`,
  such as `"rw-"`.
- Preconditions: the caller's domain holds `owner` on `inode:<id>`, or the
  caller's domain is the inode's `owner`.
- Effects: replaces `Inode.permissions`. Journaled as a metadata transaction.
- Returns: `{ ok: true, value: null }`.
- Errno: `ENOENT`, `EPERM` (not the owner), `EINVAL` (malformed bits).

**`sync()`**
- Parameters: none.
- Preconditions: none.
- Effects: writes every dirty block cache entry to disk, flushes the journal,
  appends a `checkpoint` journal record for every committed transaction, and
  blocks the caller until every submitted write completes. This is the call that
  makes a crash survivable and the player has to learn to issue it.
- Returns: `{ ok: true, value: dirtyBlocksFlushed }` on wake.
- Errno: `EBUSY` (a device is offline and the flush cannot complete).

#### Synchronisation

**`sem_wait(resource: string)`**
- Parameters: `args[0]` the `ResourceId` of a semaphore.
- Preconditions: the semaphore exists.
- Effects: §8.4. Decrements `value`; blocks with
  `{kind: 'semaphore', resource}` when it goes negative. Emits `sync.acquired`
  or `sync.blocked`.
- Returns: `{ ok: true, value: newValue }`, or blocks.
- Errno: `ENOENT` (no such primitive), `EINVAL` (the id names a non-semaphore).

**`sem_post(resource: string)`**
- Parameters: `args[0]` the `ResourceId`.
- Preconditions: the semaphore exists; `value < capacity`.
- Effects: §8.4. Increments `value`, wakes a waiter when one exists. Emits
  `sync.released`.
- Returns: `{ ok: true, value: newValue }`.
- Errno: `ENOENT`, `EINVAL`, `EPERM` (posting past `capacity`, which would
  manufacture permits out of nothing and is a bug in the caller).

**`mutex_lock(resource: string)`**
- Parameters: `args[0]` the `ResourceId` of a mutex.
- Preconditions: the mutex exists; the caller does not already hold it (this
  mutex is **not** recursive).
- Effects: §8.4. Acquires or blocks with `{kind: 'mutex', resource}`. Under
  `deadlockStrategy: 'prevent'`, enforces the rank ordering of §9.7 and returns
  `EDEADLK` on a violation. Under `priorityInheritance`, boosts the holder.
- Returns: `{ ok: true, value: null }`, or blocks.
- Errno: `ENOENT`, `EINVAL`, `EDEADLK` (rank violation, or self-lock).

**`mutex_unlock(resource: string)`**
- Parameters: `args[0]` the `ResourceId`.
- Preconditions: the caller is in `holders`.
- Effects: §8.4, with direct hand-off to the head of `waitQueue`. Restores the
  caller's `basePriority` if it was boosted by inheritance. Emits
  `sync.released`.
- Returns: `{ ok: true, value: null }`.
- Errno: `ENOENT`, `EPERM` (the caller does not hold it).

#### Resources

**`request(resource: string, instances: number)`**
- Parameters: `args[0]` the `ResourceId` of a `ResourceType`, `args[1]` instance
  count, default 1.
- Preconditions: the resource exists; `instances >= 1`; under `'avoid'`, the
  request does not exceed the caller's declared `Max`.
- Effects: branches on `KernelConfig.deadlockStrategy`:
  - `'ignore'` / `'detect'`: grant when `availableInstances >= instances`,
    otherwise append to `requestedResources` and block.
  - `'avoid'`: run the resource-request algorithm of §9.4.2. Emits
    `bankers.evaluated` with the full trace either way.
  - `'prevent'`: enforce the total resource ordering; a request whose rank is not
    strictly greater than every held rank returns `EDEADLK` without blocking.
  On a grant, appends `instances` copies to `heldResources` and decrements
  `availableInstances`. Emits `resource.requested` then `resource.granted` or
  `resource.denied`.
- Returns: `{ ok: true, value: instancesGranted }`, or blocks.
- Errno: `ENOENT`, `EINVAL` (bad count, or exceeding the declared max),
  `EAGAIN` (unavailable, or unsafe under avoidance; the caller blocks),
  `EDEADLK` (rank violation under prevention).

**`release(resource: string, instances: number)`**
- Parameters: `args[0]` the `ResourceId`, `args[1]` count, default 1.
- Preconditions: the caller holds at least `instances` copies.
- Effects: removes them from `heldResources`, increments `availableInstances`,
  and re-tests every process blocked on that resource in ascending pid order,
  granting the first that fits (and under `'avoid'`, the first whose grant keeps
  the state safe). Emits `resource.granted` for each wake.
- Returns: `{ ok: true, value: null }`.
- Errno: `ENOENT`, `EPERM` (releasing more than held), `EINVAL`.

#### Device and miscellaneous

**`ioctl(device: string, command: string, ...args)`**
- Parameters: `args[0]` the `DeviceId`, `args[1]` the command, remaining
  positions are command-specific.
- Preconditions: the device exists; the caller's domain holds `control` on
  `device:<id>`; the command is in that driver's table.
- Effects: driver-specific. The shipped commands:

| Device | Command | Effect | Extra errno |
|---|---|---|---|
| any | `"reset"` | drops the queue, clears `busy` | `EBUSY` if a DMA transfer is in flight |
| any | `"set_mode"` | changes `IoMode`; the argument must be a valid mode | `EINVAL` |
| `disk0` | `"set_policy"` | changes `DiskSchedulingId` | `EINVAL` |
| `disk0` | `"crash"` | the crash simulation of §12.5; ring 0 only | `EPERM` |
| `disk0` | `"fail_disk"` | injects a RAID member failure; ring 0 only | `EPERM`, `EINVAL` |
| `nvm0` | `"trim"` | marks a logical page range invalid, feeding garbage collection | `EINVAL` |
| `console` | `"flush"` | drains the output buffer | none |
| `net0` | `"set_loss"` | sets the packet loss rate; ring 0 only | `EPERM`, `EINVAL` |
| kernel pseudo-device | `"tlb_flush"` | invalidates the caller's TLB entries | none |
| kernel pseudo-device | `"domain_switch"` | §13.4 mechanism 2 | `EPERM`, `ENOENT` |
| kernel pseudo-device | `"set_ring"` | **always fails**, §13.6 attempt 1 | `EINVAL` |

- Returns: command-specific; `{ ok: true, value: null }` when there is nothing
  to report.
- Errno: `ENOENT` (no such device), `EPERM`, `EINVAL`, `EBUSY`.

### 14.4 Errno cross-reference

Which calls can produce each code, for the implementer writing the error paths:

| Errno | Produced by |
|---|---|
| `EPERM` | `kill`, `nice`, `chmod`, `mutex_unlock`, `sem_post`, `release`, `ioctl` |
| `ENOENT` | `exec`, `open`, `stat`, `unlink`, `mkdir`, `chmod`, `mmap`, `sem_wait`, `sem_post`, `mutex_lock`, `mutex_unlock`, `request`, `release`, `ioctl` |
| `EAGAIN` | `fork`, `open`, `request` |
| `ENOMEM` | `fork`, `exec`, `mmap`, `brk` |
| `EACCES` | `exec`, `open`, `read`, `write`, `stat`, `unlink`, `mkdir`, `mmap` |
| `EBUSY` | `read`, `write`, `unlink`, `sync`, `ioctl` |
| `EEXIST` | `open` (mode `"wx"`), `mkdir` |
| `EINVAL` | every call except `getpid` |
| `ENOSPC` | `open` (create), `write`, `mkdir` |
| `EDEADLK` | `mutex_lock`, `request` |
| `ESRCH` | `kill`, `wait`, and the dispatcher for an unknown pid |

---

## 15. Invariants and assertions

Every invariant below is checked in phase 11 of `step()`, in development and test
builds, in the numbered order given. A failure throws
`InvariantViolation(number, message, state)` and, in a test, fails the test with
the offending tick.

```ts
// src/kernel/invariants.ts
export function checkInvariants(k: KernelState): void {
  if (!k.devBuild) return;
  I1_pidUniqueness(k);
  I2_frameConservation(k);
  // ... in numbered order
}

function assert(cond: boolean, n: number, msg: () => string): void {
  if (!cond) throw new InvariantViolation(n, msg());
}
```

### Process and scheduling

**I-1. PID uniqueness and ordering.** Every PCB's `pid` is unique and
`k.orderedPids` is strictly ascending.

```ts
assert(new Set(k.orderedPids).size === k.orderedPids.length, 1, () => 'duplicate pid');
assert(k.orderedPids.every((p, i) => i === 0 || p > k.orderedPids[i - 1]), 1, () => 'pids not ascending');
```

**I-2. Exactly one running process, or none.**

```ts
const running = k.processes.filter(p => p.state === 'running');
assert(running.length <= 1, 2, () => `${running.length} processes in state running`);
assert(k.running === null || k.pcb(k.running)!.state === 'running', 2,
       () => `k.running=${k.running} but its state is ${k.pcb(k.running!)?.state}`);
assert(running.length === 0 || running[0].pid === k.running, 2, () => 'running pid disagrees with state');
```

**I-3. `cpuUtilisation` is a probability.** `0 <= cpuUtilisation <= 1`, and
`busyTicks <= tick`.

**I-4. Service accounting is conserved.** For every process,
`totalCpuUsed + serviceRemaining === totalServiceAtAdmission`, where the right
side is stored on the PCB at admission and is adjusted only by the Amdahl
recomputation of §4.3, which records its own adjustment. A process in state
`zombie` or `terminated` has `serviceRemaining === 0` when it exited normally.

**I-5. Resource conservation.** For every `ResourceType`:

```ts
const held = k.processes.reduce((s, p) => s + p.heldResources.filter(r => r === rt.id).length, 0);
assert(rt.availableInstances + held === rt.totalInstances, 5,
       () => `${rt.id}: ${rt.availableInstances} available + ${held} held != ${rt.totalInstances} total`);
assert(rt.availableInstances >= 0, 5, () => `${rt.id}: negative availability`);
```

**I-6. No process waits for a resource it already holds.**

```ts
for (const p of k.processes) {
  for (const r of p.requestedResources) {
    // Multiple instances are legal: a process may hold 1 and request another.
    // What is forbidden is blocking on a resource whose ONLY holder is itself.
    const others = k.processes.filter(q => q.pid !== p.pid && q.heldResources.includes(r));
    const selfOnly = p.heldResources.includes(r) && others.length === 0
                     && k.resource(r)!.availableInstances === 0;
    assert(!selfOnly, 6, () => `P${p.pid} blocked on ${r} which only it holds`);
  }
}
```

**I-7. Every live process has at least one thread.** For every process in state
`ready`, `running` or `waiting`, `threads.length >= 1`.

**I-8. A page fault does not advance the program counter.** Recorded as a
cross-tick check: if `memory.page_fault` was emitted for process `p` this tick,
then `p.programCounter` equals its value at the start of the tick.

**I-9. TLB coherence.** Every valid TLB entry names a frame whose `owner` equals
the entry's `space` and whose `page` equals the entry's `page`.

**I-10. Wait queue membership is consistent with state.** A pid appearing in any
`SyncPrimitive.waitQueue`, `Device.queue`, `Mailbox.sendWaiters` or
`Mailbox.recvWaiters` is in state `waiting`, and its `blockedOn` names that
object. Conversely a process in state `waiting` has a non-null `blockedOn` and
appears in exactly the queue that `blockedOn` names.

**I-11. Only legal state transitions occurred.** Compare each PCB's state against
its state at the start of the tick, and assert the pair appears in the table of
§3.3.

**I-12. `readySince` pairs with state `ready`.**

```ts
for (const p of k.processes) {
  assert((p.state === 'ready') === (p.readySince !== null), 12,
         () => `P${p.pid} state=${p.state} readySince=${p.readySince}`);
  if (p.readySince !== null) assert(p.readySince <= k.tick, 12, () => `P${p.pid} readySince in the future`);
}
```

**I-13. The ready queue equals the set of ready processes.** The union of every
level of `scheduler.snapshot().queues`, plus the running pid, equals
`{p.pid | p.state in {ready, running}}` exactly, with no duplicates across
levels.

**I-14. A process admitted this tick has `waited === 0`.** No process can starve
or age on its arrival tick.

**I-15. Priorities are in range.** `0 <= priority <= maxPriority` and
`0 <= basePriority <= maxPriority` for every process.

**I-16. Starvation-free policies keep `worstWait` bounded.** Under
`priority_aging`, `rr` or `mlfq` with aging enabled,
`worstWait <= (processCount * quantum) + agingInterval * maxPriority`. This is a
loose bound and it exists to catch a policy that has stopped rotating entirely.

### Memory

**I-17. Frame conservation.**

```ts
const used = k.frames.filter(f => f.owner !== null).length;
const free = k.freeList.length;
assert(used + free === k.config.totalFrames, 17,
       () => `${used} used + ${free} free != ${k.config.totalFrames} total`);
assert(new Set(k.freeList).size === k.freeList.length, 17, () => 'duplicate frame in the free list');
assert(k.freeList.every(id => k.frames[id].owner === null), 17, () => 'free list holds an owned frame');
```

**I-18. Page table and frame table agree.** For every page table entry with
`valid === true`, `frame !== null` and `k.frames[frame].owner === space` and
`k.frames[frame].page === page`. For every entry with `valid === false`,
`frame === null`. And every frame with `owner !== null` is named by exactly one
valid page table entry, except frames whose `cowRefCount > 1`, which are named by
exactly `cowRefCount` entries.

**I-19. Metrics are finite.** Every number in `SchedulingMetrics` and
`MemoryMetrics` satisfies `Number.isFinite`, and every rate is non-negative.
`tlbHitRate` and `cpuUtilisation` are in `[0, 1]`.

**I-20. Free list ordering.** `k.freeList` is strictly ascending, which is what
makes allocation reproducible after a restore.

### Synchronisation and deadlock

**I-21. Mutual exclusion holds.** For every `SyncPrimitive`:

```ts
switch (s.kind) {
  case 'mutex':
    assert(s.holders.length <= 1, 21, () => `${s.id} has ${s.holders.length} holders`);
    assert(s.value === (s.holders.length === 0 ? 1 : 0), 21, () => `${s.id} value/holder mismatch`);
    break;
  case 'semaphore':
    assert(s.value >= -s.waitQueue.length, 21, () => `${s.id} value below waiter count`);
    assert(s.value <= s.capacity, 21, () => `${s.id} value above capacity`);
    break;
  case 'rwlock':
    assert(s.value === -1 ? s.holders.length === 1 : s.holders.length === s.value, 21,
           () => `${s.id} rwlock holder count mismatch`);
    break;
  case 'barrier':
    assert(s.value >= 0 && s.value < s.capacity, 21, () => `${s.id} barrier not reset`);
    break;
}
```

**I-22. Bounded buffer occupancy.** In any scenario declaring a bounded buffer,
`0 <= occupancy <= capacity` and
`emptySemaphore.value + fullSemaphore.value + inFlight === capacity`.

**I-23. No holder is in its own wait queue.** For every `SyncPrimitive`,
`holders` and `waitQueue` are disjoint.

**I-24. Under `deadlockStrategy: 'prevent'`, the wait-for graph is acyclic.**

```ts
if (k.config.deadlockStrategy === 'prevent') {
  assert(findCycle(buildWaitForGraph(k)) === null, 24,
         () => 'cycle under prevention: the resource ordering is broken');
}
```

**I-25. Under `'avoid'`, the state is always safe.** After every granted request,
`safetyCheck(bankersState(k)).safe === true`. This is expensive, so it runs only
when `k.config.enabledSubsystems` includes `deadlock` and only on ticks where a
`resource.granted` event was emitted.

**I-26. A reported deadlock cycle is a real cycle.** Every consecutive pair in
`DeadlockReport.cycle` is an edge in the wait-for graph, the last element has an
edge back to the first, and the array begins at its lowest pid.

### Storage, I/O and file system

**I-27. Disk head is in range.** `0 <= head.cylinder < head.totalCylinders`.

**I-28. Every queued disk request has `servedAtTick === null`, and every served
one has `servedAtTick !== null` and `servedAtTick >= queuedAtTick`.**

**I-29. Block allocation is exclusive.** No `BlockId` appears in more than one
inode's `blocks` array, and every allocated block is marked used in the free
space bitmap, and every free block is not in any inode. This is the check that
catches the double allocation of §12.6, and it is deliberately expensive, so it
runs every `invariantSlowInterval` ticks (default 50) rather than every tick.

**I-30. Link counts are correct.** For every inode, `linkCount` equals the number
of directory entries across the whole tree that point at it, plus 1 for a
directory's own `.` entry and 1 per child directory's `..`.

**I-31. Journal ordering.** Within one `txId`, entries appear in phase order
`begin`, then zero or more `write`, then at most one `commit`, then at most one
`checkpoint`. A `checkpoint` never precedes its `commit`. A `commit` never
precedes its `begin`.

**I-32. Device queue membership.** A pid in `Device.queue` is in state `waiting`
with `blockedOn.kind === 'io'` naming that device.

**I-33. Interrupt lines are non-negative.** Every `InterruptLine.pending >= 0`
and `<= maxPending`.

### Security

**I-34. Ring monotonicity across a trap.** `RingState.stack` is non-increasing
from bottom to top: a nested trap never returns to a more privileged ring than it
came from.

**I-35. No user-domain process is in ring 0.** For every process whose domain is
not `domain:kernel`, `ring !== 0` outside a trap.

**I-36. The ACL and capability representations agree.** When both are
materialised, for every `(domain, object)` pair the right sets are equal as sets.

**I-37. `kernelSecret` never appears in the event log.** Checked once at the end
of a test run rather than per tick.

### Determinism

**I-38. The event sequence is monotonic.** `seq` strictly increases across the
whole run, including across `restore`, and `tick` is non-decreasing across the
event log.

**I-39. Every RNG stream in the registry is present in the snapshot,** in the
fixed order of §1.2.5, and every `RngState.algorithm` is `'sfc32'`.

**I-40. `snapshot()` is a pure function of state.** Calling it twice with no
intervening `step()` produces canonically identical output. Checked in tests
rather than in phase 11, because it is quadratic.

---

## 16. Test vector appendix

Every worked example in this document, collected. Each row is one assertion in
`tests/kernel/`. Where a row says "recorded at implementation", the first correct
implementation establishes the value and it is frozen; those rows must not be
guessed.

### 16.1 The reference configuration

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

### 16.2 Determinism

| Fixture | Input | Expected |
|---|---|---|
| `RNG-1` | `createRng(0x4B54524C, 'root')` | state `[481119784, 3409944657, 2818634109, 3205637164]`; first five `next()` = 0.6523296025, 0.4470959350, 0.2026866907, 0.4280106414, 0.2385281252 |
| `RNG-2` | `createRng(1234, 'root')`, then `fork('scheduler')` | first five = 0.7590017407, 0.1837793530, 0.0627553733, 0.4116676911, 0.8262647619 |
| `RNG-2b` | same root, `fork('memory')` | first five = 0.9880230038, 0.1402625744, 0.6085327168, 0.9143000133, 0.2004204346 |
| `RNG-2c` | fork order `memory`, `scheduler`, `io` | `scheduler` and `memory` streams identical to `RNG-2`/`RNG-2b`; root state identical to a fresh `createRng(1234, 'root')` |
| `RNG-3` | `createRng(7, 'x')` | first three = 0.9808979158, 0.9695635808, 0.6098223559; state `[1146746946, 1846046223, 117364893, 1648156502]`; next three = 0.0805552991, 0.0603317665, 0.0445723657; restore reproduces the last row |
| `RNG-4` | 1,000,000 draws from `createRng(99, 't')` bucketed into 10 bins | chi-square = 8.230 (9 degrees of freedom) |
| `DET-D1` | `REFERENCE_CONFIG`, 5000 ticks, two kernels | identical canonical event logs and snapshots |
| `DET-D2` | snapshot at 2000, restore, run 3000 | tail identical to an uninterrupted run |
| `DET-D3` | config with and without `io` enabled, no-I/O workload | identical `context.switch` sequences |
| `DET-D4` | seeds 0 to 63, 1000 ticks each, run twice | identical hashes |

### 16.3 CPU scheduling (Ch. 5)

Bursts are total service; all metrics are in ticks.

| Fixture | Policy | Workload (pid: arrival, burst[, priority]) | Gantt | Avg wait | Avg turnaround | Avg response |
|---|---|---|---|---|---|---|
| `SCHED-FCFS-1` | fcfs | P1: 0,24; P2: 0,3; P3: 0,3 | P1[0-24] P2[24-27] P3[27-30] | 17.0 | 27.0 | 17.0 |
| `SCHED-FCFS-2` | fcfs | same, submitted P2, P3, P1 | P2[0-3] P3[3-6] P1[6-30] | 3.0 | 13.0 | 3.0 |
| `SCHED-SJF-1` | sjf | P1: 0,6; P2: 0,8; P3: 0,7; P4: 0,3 | P4[0-3] P1[3-9] P3[9-16] P2[16-24] | 7.0 | 13.0 | 7.0 |
| `SCHED-SJF-1F` | fcfs | same workload, order P1..P4 | P1[0-6] P2[6-14] P3[14-21] P4[21-24] | 10.25 | 16.25 | 10.25 |
| `SCHED-SRTF-1` | srtf | P1: 0,8; P2: 1,4; P3: 2,9; P4: 3,5 | P1[0-1] P2[1-5] P4[5-10] P1[10-17] P3[17-26] | 6.5 | 13.0 | 4.25 |
| `SCHED-SRTF-1S` | sjf | same workload | P1[0-8] P2[8-12] P4[12-17] P3[17-26] | 7.75 | 14.25 | 7.75 |
| `SCHED-PRIO-1` | priority | P1: 0,10,p3; P2: 0,1,p1; P3: 0,2,p4; P4: 0,1,p5; P5: 0,5,p2 | P2[0-1] P5[1-6] P1[6-16] P3[16-18] P4[18-19] | 8.2 | 12.0 | 8.2 |
| `SCHED-AGING-1A` | priority, aging 0 | PL: 0,5,p5; H1: 0,4,p1; H2: 4,4,p1; H3: 8,4,p1; H4: 12,4,p1 | H1[0-4] H2[4-8] H3[8-12] H4[12-16] PL[16-21] | 3.2 | 7.4 | 3.2; **worstWait 16** |
| `SCHED-AGING-1B` | priority_aging, aging 2 | same | H1[0-4] H2[4-8] PL[8-13] H3[13-17] H4[17-21] | 3.6 | 7.8 | 3.6; **worstWait 8** |
| `SCHED-RR-1` | rr, q=4 | P1: 0,24; P2: 0,3; P3: 0,3 | P1[0-4] P2[4-7] P3[7-10] P1[10-30] | 5.666667 | 15.666667 | 3.666667 |
| `SCHED-RR-2a` | rr, q=1 | same | 10 dispatches | 5.666667 | 15.666667 | 1.0 |
| `SCHED-RR-2c` | rr, q=24 | same | identical to `SCHED-FCFS-1` | 17.0 | 27.0 | 17.0 |
| `SCHED-MLFQ-1` | mlfq, levels [4,8,16], aging 50 | P1: 0,20; P2: 0,6; P3: 10,4 | P1[0-4] P2[4-8] P1[8-10] P3[10-14] P2[14-16] P1[16-30] | 6.666667 | 16.666667 | 1.333333 |

`SCHED-MLFQ-1` additionally asserts final queue levels: P1 = 2, P2 = 1, P3 = 0.

Per-process detail for the assertions that need it:

| Fixture | Process | Waiting | Turnaround | Response |
|---|---|---|---|---|
| `SCHED-SRTF-1` | P1 | 9 | 17 | 0 |
| | P2 | 0 | 4 | 0 |
| | P3 | 15 | 24 | 15 |
| | P4 | 2 | 7 | 2 |
| `SCHED-PRIO-1` | P1 | 6 | 16 | 6 |
| | P2 | 0 | 1 | 0 |
| | P3 | 16 | 18 | 16 |
| | P4 | 18 | 19 | 18 |
| | P5 | 1 | 6 | 1 |
| `SCHED-MLFQ-1` | P1 | 10 | 30 | 0 |
| | P2 | 10 | 16 | 4 |
| | P3 | 0 | 4 | 0 |

### 16.4 Threads (Ch. 4)

| Fixture | Input | Expected |
|---|---|---|
| `AMDAHL-1` | `amdahlSpeedup(0.25, N)` for N = 1, 2, 4, 8, 16, 32 | 1.0000, 1.6000, 2.2857, 2.9091, 3.3684, 3.6571 (tolerance 1e-4) |
| `AMDAHL-1b` | `amdahlSpeedup(0.10, N)` same N | 1.0000, 1.8182, 3.0769, 4.7059, 6.4000, 7.8049 |
| `AMDAHL-1c` | `amdahlSpeedup(0.50, N)` same N | 1.0000, 1.3333, 1.6000, 1.7778, 1.8824, 1.9394 |
| `AMDAHL-2` | raw burst 100, s = 0.25, O = 2, N = 1, 2, 4, 8, 16, 32 | effective bursts 102, 67, 52, 51, 62, 92 |
| `AMDAHL-3` | `amdahlSpeedup(1.0, 1024)` | exactly 1 |
| `THREAD-M1` | many-to-one, 4 threads, one blocks | the whole PCB moves to `waiting`; zero ticks delivered to the other three |
| `THREAD-11` | one-to-one, 4 threads, coreCount 4, one blocks | PCB stays `ready`; `usableCores` drops from 4 to 3 |
| `THREAD-MM` | many-to-many, 8 threads, lwpPoolSize 4, coreCount 4 | `usableCores` = 4; lwp assignment is round-robin over ascending tid |

`AMDAHL-2` asserts `effective = ceil( R / S(s, N) ) + O * N`, per §4.3 and
`docs/07-CONTRACT-AMENDMENTS.md` amendment 2: overhead is charged after the
division and scales with `N`. The exact values before the ceiling are 102.00000,
66.50000, 51.75000, 50.37500, 61.68750 and 91.34375. The rounding step is
`Math.ceil`, not `Math.round`, because the `N = 2` value is an exact half and a
half-way tie rounds differently across implementations (JavaScript's `Math.round`
gives 67, Python's `round` gives 66). `amdahlSpeedup` itself did not change, so
`AMDAHL-1`, `AMDAHL-1b`, `AMDAHL-1c` and `AMDAHL-3` keep their values.

### 16.5 Main memory (Ch. 9)

| Fixture | Input | Expected |
|---|---|---|
| `MEM-FIT-1a` | first fit, holes 100/500/200/300/600, requests 212/417/112/426 | 212→500, 417→600, 112→288, 426 **fails**; free 959 K, largest 300 K |
| `MEM-FIT-1b` | best fit, same | 212→300, 417→500, 112→200, 426→600; all fit; free 533 K, largest 174 K |
| `MEM-FIT-1c` | worst fit, same | 212→600, 417→500, 112→388, 426 **fails**; free 959 K, largest 300 K |
| `MEM-BUDDY-1` | 256 KB region, 21 KB request, minBlock 1 KB | 32 KB block allocated; internal fragmentation 11 KB; free lists hold one 32 K, one 64 K, one 128 K |
| `MEM-XLATE-1` | pageSize 4, page table [5,6,1,2]; logical 0, 3, 4, 13 | physical 20, 23, 24, 9 |
| `MEM-XLATE-2` | pageSize 4096, logical 0x00003ABC, page 3 → frame 12 | p=3, d=2748, physical 51900 (0x0000CABC) |
| `MEM-TLB-1` | EAT with M=100, E=0, h = 0.50/0.80/0.90/0.99 | 150.00, 120.00, 110.00, 101.00 ns |
| `MEM-TLB-1b` | EAT with M=100, E=10, h = 0.80/0.99 | 130.00, 111.00 ns |
| `MEM-FRAG-1` | paging with pageSize 4096 | `externalFragmentation === 0` for every configuration |

### 16.6 Virtual memory (Ch. 10)

Reference string `7,0,1,2,0,3,0,4,2,3,0,3,2,1,2,0,1,7,0,1`, three frames.

| Fixture | Policy | Faults | Eviction order |
|---|---|---|---|
| `VM-FIFO-1` | fifo | **15** | 7, 0, 1, 2, 3, 0, 4, 2, 3, 0, 1, 2 |
| `VM-LRU-1` | lru | **12** | 7, 1, 2, 3, 0, 4, 0, 3, 2 |
| `VM-CLOCK-1` | clock | **14** | 7, 1, 2, 0, 3, 4, 2, 0, 3, 1, 2 |
| `VM-OPT-1` | optimal | **9** | 7, 1, 0, 4, 3, 2 |
| `VM-LFU-1` | lfu | **13** | 7, 1, 2, 3, 4, 2, 1, 2, 1, 7 |
| `VM-RANDOM-1` | random, `root/vm` from seed 1234 | recorded at implementation | recorded |

Belady's anomaly, reference string `1,2,3,4,1,2,5,1,2,3,4,5`:

| Fixture | Policy | 3 frames | 4 frames |
|---|---|---|---|
| `VM-BELADY-1` | fifo | **9** | **10** |
| `VM-BELADY-2` | lru | 10 | 8 |
| `VM-BELADY-3` | optimal | 7 | 6 |

`VM-BELADY-1` asserts `faults(4) > faults(3)`, which is the anomaly.
`VM-BELADY-2` and `VM-BELADY-3` assert `faults(4) <= faults(3)`, which is the
stack-algorithm property.

| Fixture | Input | Expected |
|---|---|---|
| `VM-EAT-1` | `(1-p)*200 + p*8e6` for p = 0, 1e-6, 2.5000625e-6, 1e-5, 1e-4, 1e-3 | 200.0000, 207.9998, 219.9995, 279.9980, 999.9800, 8199.8000 ns |
| `VM-EAT-2` | p for 10% degradation | 2.5000625e-6, one fault per 399,990 accesses |
| `VM-WS-1` | window Δ=10 over `2 6 1 5 7 7 7 7 5 1` | WS = {1,2,5,6,7}, WSS = 5 |
| `VM-WS-2` | window Δ=10 over `3 4 3 4 4 4 3 4 4 4` | WS = {3,4}, WSS = 2 |
| `VM-THRASH-1` | D = 70 with m = 64 frames | `memory.thrashing { severity: 'warning' }`; admission stops |
| `VM-THRASH-2` | D = 100 with m = 64 | `memory.thrashing { severity: 'critical' }`; the largest working set is suspended |
| `VM-COW-1` | fork, then the child writes one shared page | exactly one `memory.page_fault { major: false }`, one `memory.page_loaded`, zero `memory.page_evicted`; `cowRefCount` drops from 2 to 1 |

### 16.7 Synchronisation (Ch. 6 and 7)

| Fixture | Scenario | Expected |
|---|---|---|
| `SYNC-PETERSON-1` | Peterson, `reordering: false`, 10,000 ticks | mutual exclusion holds at every tick; zero `sync.race_detected` |
| `SYNC-PETERSON-2` | Peterson, `reordering: true`, storeBufferDepth 2 | at least one mutual exclusion violation, at least one `sync.race_detected`, before tick 10,000 |
| `SYNC-PETERSON-3` | Peterson with `mfence` between lines 2 and 3, reordering on | zero violations |
| `SYNC-RACE-1` | two processes incrementing a shared counter, unprotected, 100 increments each | `sync.race_detected` fires; `expectedValue - corruptedValue > 0`; `interleaving` contains the four-line load/load/store/store pattern |
| `SYNC-RACE-2` | same, wrapped in a mutex | zero `sync.race_detected`; final value exactly 200 |
| `SYNC-TAS-1` | test-and-set spinlock, 4 contenders | mutual exclusion holds; at least one `process.starving { fatal: false }` from the bounded-waiting check; `sync.busy_wait` total exceeds 0 |
| `SYNC-BB-1` | bounded buffer n=4, 3 producers × 20, 2 consumers × 30 | produced === consumed === 60; occupancy always in [0,4]; zero races |
| `SYNC-BB-DEADLOCK` | producer takes mutex before empty | `deadlock.detected` with a cycle of exactly 2 pids |
| `SYNC-RW-STARVE` | reader-preferring, 6 readers, 1 writer | exactly one `process.starving { fatal: true }`, naming the writer |
| `SYNC-RW-WRITERPREF` | writer-preferring, same workload | the writer completes; a reader is the longest waiter |
| `SYNC-PHIL-NAIVE` | 5 philosophers, left-then-right, q=1 | `deadlock.detected` by tick 200 with a cycle of exactly 5 pids; `conditions` contains all four Coffman values |
| `SYNC-PHIL-ASYM` | odd philosophers take right first | zero `deadlock.detected` over 20,000 ticks |
| `SYNC-PHIL-ROOM` | semaphore `room` capacity 4 | zero `deadlock.detected` over 20,000 ticks |
| `SYNC-PHIL-MONITOR` | the Ch. 7.1.3 monitor | zero deadlocks; at least one philosopher crosses `starvationThreshold` |
| `SYNC-PHIL-TABLE` | all four, 20,000 ticks, reference seed | meals completed and worst wait, recorded at implementation |

### 16.8 Deadlock (Ch. 8)

| Fixture | Input | Expected |
|---|---|---|
| `DL-BANKERS-1` | Available (3,3,2); Alloc/Max as §9.4.3 | safe; sequence `<P1, P3, P0, P2, P4>`; 5 admitted trace steps |
| `DL-BANKERS-1A` | same state, forced admission order P1,P3,P4,P0,P2 | also safe (the textbook's sequence) |
| `DL-BANKERS-2` | P1 requests (1,0,2) | **granted**; Available becomes (2,3,0); Need[P1] becomes (0,2,0); safe sequence `<P1, P3, P0, P2, P4>` |
| `DL-BANKERS-3` | from that state, P4 requests (3,3,0) | **denied**, `EAGAIN`, `resource.denied { reason: 'unavailable' }` (A: 3 > 2) |
| `DL-BANKERS-4` | from that state, P0 requests (0,2,0) | **denied unsafe**, rolled back, `resource.denied { reason: 'unsafe' }`; trace ends with `candidate: null, admitted: false`; stuck set {P0,P1,P2,P3,P4} |
| `DL-BANKERS-5` | P1 requests (2,0,0) with Need[P1] = (1,2,2) | `EINVAL`, exceeds declared maximum |
| `DL-DETECT-1` | A/B/C = 7/2/6; Alloc rows (0,1,0),(2,0,0),(3,0,3),(2,1,1),(0,0,2); Request rows (0,0,0),(2,0,2),(0,0,0),(1,0,0),(0,0,2); Available (0,0,0) | **no deadlock**; finish order P0, P2, P1, P3, P4; final Work (7,2,6) |
| `DL-DETECT-2` | same, P2's request changed to (0,0,1) | **deadlocked set {P1, P2, P3, P4}**; only P0 finishes; Work stops at (0,1,0) |
| `DL-CYCLE-1` | wait-for graph P1→P2→P3→P1 | cycle `[1, 2, 3]`, rotated to start at the lowest pid |
| `DL-CYCLE-2` | acyclic graph | `detectDeadlock()` returns null |
| `DL-VICTIM-1` | cycle of 3 with distinct priorities, cpu used and held counts | `suggestedVictims[0]` matches the §9.6 comparator; a convoy Program never sorts first when a non-convoy process is present |
| `DL-PREVENT-1` | `deadlockStrategy: 'prevent'`, a process holding rank 3 requests rank 1 | `EDEADLK`, no block; invariant I-24 holds every tick of the run |

### 16.9 Mass storage (Ch. 11)

Queue `98, 183, 37, 122, 14, 124, 65, 67`, head 53, 200 cylinders.

| Fixture | Policy | Direction | Path | Total head movement |
|---|---|---|---|---|
| `DISK-FCFS-1` | fcfs | n/a | 53,98,183,37,122,14,124,65,67 | **640** |
| `DISK-SSTF-1` | sstf | n/a | 53,65,67,37,14,98,122,124,183 | **236** |
| `DISK-SCAN-1` | scan | down | 53,37,14,0,65,67,98,122,124,183 | **236** |
| `DISK-SCAN-2` | scan | up | 53,65,67,98,122,124,183,199,37,14 | **331** |
| `DISK-LOOK-1` | look | down | 53,37,14,65,67,98,122,124,183 | **208** |
| `DISK-LOOK-2` | look | up | 53,65,67,98,122,124,183,37,14 | **299** |
| `DISK-CSCAN-1` | cscan | up | 53,65,67,98,122,124,183,199,0,14,37 | **382** |
| `DISK-CSCAN-2` | cscan | down | 53,37,14,0,199,183,124,122,98,67,65 | **386** |
| `DISK-CLOOK-1` | clook | up | 53,65,67,98,122,124,183,14,37 | **322** |
| `DISK-CLOOK-2` | clook | down | 53,37,14,183,124,122,98,67,65 | **326** |

| Fixture | Input | Expected |
|---|---|---|
| `DISK-COST-1` | 4 KB read, seek distance 50, 7200 rpm, 100 MB/s | seek 2.5 ms, rotation 4.1667 ms, transfer 0.0410 ms, total 6.7077 ms |
| `DISK-COST-2` | ticks for the above at 0.5 ms per tick | 13 ticks; zero-seek request costs 9 ticks |
| `DISK-NVM-1` | the standard queue on `nvm0` under all six policies | identical completion ticks for all six |
| `DISK-NVM-2` | 1000 random 4 KB writes vs 1000 sequential | write amplification > 3 random, ≈ 1 sequential |
| `RAID-1` | one logical block write under levels 0,1,4,5,6,10 | physical I/O counts 1, 2, 4, 4, 6, 2 |
| `RAID-2` | full-stripe write of `n-1` blocks under RAID 5, n = 5 | 5 I/O for 4 blocks, penalty 1.25 |
| `RAID-3` | one disk failure under 0, 1, 4, 5, 6, 10 | data lost only at level 0; read cost on the degraded array rises to `n-1` at 4, 5, 6 |
| `RAID-4` | two simultaneous failures | survivable only at level 6, and at 1 and 10 when the failures are in different mirror pairs |

### 16.10 I/O (Ch. 12)

| Fixture | Input | Expected |
|---|---|---|
| `IO-COST-1` | 10 requests of 4096 bytes, latency 20, wordSize 64 | polling 840 CPU ticks, interrupt 670, dma 100 |
| `IO-POLL-1` | polled device, one request | `io.poll_wasted { wastedTicks: 19 }`; `cpuUtilisation` near 1.0 with zero process progress |
| `IO-INT-1` | interrupt device, two lines at priorities 0 and 2 both pending | the priority-0 line is delivered first; the priority-2 line is deferred while the first is in service |
| `IO-STORM-1` | 5 interrupts per tick against `maxInterruptsPerTick` 2, for 10 ticks | the storm condition fires; at `2 * window` the line is masked and the device drops to polling |
| `IO-BUF-1` | single vs double buffering, matched producer and consumer rates | double-buffered throughput is within 5% of 2x the single-buffered figure |
| `IO-SPOOL-1` | two processes writing the printer without spooling | `fs.corruption { recoverable: false }` on the output; with spooling, zero corruption and the second job waits |

### 16.11 File systems (Ch. 13 to 15)

| Fixture | Input | Expected |
|---|---|---|
| `FS-INODE-1` | 12 direct, 3 indirect levels, blockSize 4096, pointerSize 32 | max file size 8,657,616,896 bytes; reads to reach offsets 0 / 100,000 / 1,000,000 are 1 / 2 / 3 |
| `FS-BITMAP-1` | 6400 blocks of 4096 bytes | bitmap is 200 `Uint32` words, 800 bytes |
| `FS-ALLOC-1` | 64-block file, 20 random reads | contiguous 20 reads, linked 650 reads, indexed 40 reads, extent 20 reads |
| `FS-ALLOC-2` | 64-block file, sequential read | contiguous 64 reads and 1 seek; indexed 65 reads; extent 64 reads and `e` seeks |
| `FS-ALLOC-3` | contiguous file, append with the next block occupied | the whole file relocates: `n` reads and `n` writes |
| `FS-PATH-1` | resolve `/a/b/c/d/e` | 5 directory reads; `execute` checked on each of `/`, `a`, `b`, `c`, `d` |
| `FS-JOURNAL-1` | `unlink` with journaling, crash after the `write` phase | recovery discards the transaction; the file is intact; zero `fs.corruption` |
| `FS-JOURNAL-2` | `unlink` with journaling, crash after `commit` and before checkpointing | recovery replays; the unlink completed; zero `fs.corruption` |
| `FS-JOURNAL-3` | replay a transaction twice | identical final state, proving idempotence |
| `FS-CORRUPT-1` | no journal, crash after step A only | `fs.corruption { recoverable: true }`, orphaned inode |
| `FS-CORRUPT-2` | no journal, crash after A and B | `fs.corruption { recoverable: true }`, leaked blocks |
| `FS-CORRUPT-3` | no journal, crash after B only | `fs.corruption { recoverable: false }`, dangling entry |
| `FS-CORRUPT-4` | no journal, crash after C only | `fs.corruption { recoverable: false }`, double allocation; invariant I-29 fires on the next slow check |
| `FS-JOURNAL-COST` | 1000 writes, mode `off` / `metadata` / `full` | physical write counts in ratio 1.0 : ~1.1 : 2.0 |

### 16.12 Protection and security (Ch. 16 and 17)

| Fixture | Input | Expected |
|---|---|---|
| `SEC-RING-1` | ring 3 process calls `ioctl('set_ring', 0)` | `EINVAL`; `security.escalation_attempt { fromRing: 3, toRing: 0, blocked: true }` |
| `SEC-ARG-1` | `read(fd, hugeLength)` from ring 3 | `EINVAL` with the `"address out of range: "` prefix; no kernel state changed |
| `SEC-DEPUTY-1` | ring 3 process induces a ring 1 driver to write a region it cannot write | `EACCES`; `security.access_denied` names the **requester's** domain |
| `SEC-SETUID-1` | `open` for writing on an inode carrying `switchesToDomain` | `EACCES` |
| `SEC-SETUID-2` | the same inode mis-permissioned by the leg | the open succeeds and the escalation succeeds; `blocked: false`; this is the failure fixture |
| `SEC-CAP-1` | forged `Capability` with an incorrect seal | `EPERM`; `kernelSecret` appears nowhere in the serialised event log of the whole run |
| `SEC-ESCALATION-1` | the full probe, default configuration, 5000 ticks | exactly five `security.escalation_attempt` events, all `blocked: true`; the probe ends with `terminationReason: 'protection_fault'` |
| `SEC-ACL-CAP-1` | the same matrix under `'acl'` and `'capability'` | every `checkAccess` query returns the same answer under both |
| `SEC-LEASTPRIV-1` | a run with every worker in `domain:kernel` vs correctly scoped domains | privilege excess is strictly larger in the first; `ScoreBreakdown.correctness` is strictly lower |

### 16.13 Invariants

| Fixture | Input | Expected |
|---|---|---|
| `INV-ALL-1` | `REFERENCE_CONFIG`, 10,000 ticks, dev build | zero `InvariantViolation` |
| `INV-ALL-2` | each of the 7 schedulers × each of the 6 replacement policies × each of the 6 disk policies, 2,000 ticks | zero violations across all 252 combinations |
| `INV-NEG-1` | a deliberately broken free list (duplicate frame) | I-17 throws with number 17 |
| `INV-NEG-2` | two processes forced into state `running` | I-2 throws with number 2 |
| `INV-NEG-3` | a mutex with two holders | I-21 throws with number 21 |
| `INV-NEG-4` | a resource whose available plus held exceeds its total | I-5 throws with number 5 |

The negative fixtures matter as much as the positive ones: an invariant that
cannot be made to fail is not being checked.

---

## 17. Implementation order

The dependency graph of this specification, as a build order. Each stage is
independently testable against the fixtures named.

1. `Rng` and the canonical serialiser. Fixtures `RNG-1` to `RNG-4`.
2. The event bus, `seq` allocation, `KernelEventStream`. No fixtures; used by
   everything.
3. The PCB table, state transitions, `fork`, `exit`, `wait`, init and the idle
   process. Fixtures from §3.3's table, checked by I-11.
4. The scheduler registry and all seven policies. Fixtures `SCHED-*`. This stage
   needs nothing from memory, I/O or the file system, so it can be completed and
   frozen first, which matters because §5 is the largest body of fixtures.
5. `step()` phases 1, 5, 6, 7, 8, 10, 11 with the other phases stubbed. Fixtures
   `DET-D1` and `DET-D4` now pass for a scheduler-only workload.
6. The frame table, page tables, TLB, and the four allocation strategies.
   Fixtures `MEM-*`.
7. Demand paging and all six replacement policies. Fixtures `VM-*`.
8. Sync primitives and the race detector. Fixtures `SYNC-*` except the
   philosopher table.
9. Resources, the wait-for graph, Banker's, detection and recovery. Fixtures
   `DL-*`. Phase 9 becomes real.
10. Disk geometry, the six disk policies, NVM, RAID. Fixtures `DISK-*`, `RAID-*`.
11. Devices, the interrupt controller, DMA, buffering. Phases 2 and 3 become
    real. Fixtures `IO-*`.
12. Inodes, directories, the four allocation methods, free space, the journal.
    Fixtures `FS-*`.
13. Rings, domains, the access matrix, ACL and capabilities, RBAC. Fixtures
    `SEC-*`.
14. The syscall table, all 26 handlers, argument validation. §14 is the checklist.
15. `snapshot()` and `restore()` over the complete state, including
    `completeness` and every populated slot of `subsystems` (§1.5). Fixture
    `DET-D2`.
16. The full invariant set. Fixtures `INV-*`.

Stages 4, 6, 7, 8, 10, 11, 12 and 13 touch disjoint directories and depend only
on stages 1 to 3, so they can be built in parallel by separate agents once the
first three are frozen.

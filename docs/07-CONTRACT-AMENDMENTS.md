# Frozen contract amendments

`src/kernel/types.ts`, `src/game/types.ts` and `src/design/tokens.ts` are frozen.
A work package may not edit them; it escalates instead, and a human decides. This file is the record of
every decision. It exists so that an agent joining at WP-09 can see what moved
and why without reading the whole conversation.

The contract guard (`npm run check:contracts`) stores the approved hashes in
`contracts.lock.json`. Regenerating those hashes is how an approval is applied.
Doing it to silence the guard is the one thing this whole apparatus exists to
prevent.

---

## Amendment 1, 2026-09-12

**Raised by:** the implementing agent, at the close of WP-02.
**Approved by:** Kyle.
**Status:** applied. `contracts.lock.json` amendment 1.

### What was wrong

Two problems, both mine, both in the original contract.

**The snapshot had nowhere to put subsystem state.** `KernelSnapshot` carried the
shared tables (processes, frames, page tables, sync primitives, resources, disk,
devices, inodes, journal, domains, metrics) and nothing else. Meanwhile the
briefing told every package to keep its extra state in a private side table and
"include it in `snapshot()` through the channel the package specifies." No such
channel existed. I asserted a mechanism and never built it.

WP-02 hit it first. A running process needs its program and instruction stream,
its thread control blocks and their program counters, pre-acceleration raw work,
light-weight process bindings, the pid, tid and address-space allocators, exit
codes a parent has not collected, copy-on-write reference counts, IPC state, the
tuning object in force, and accumulated execution debt. None of that fits in a
PCB array. Snapshot and restore therefore worked only from an empty kernel.

This was not a WP-02 problem. Memory, sync, storage, file system and protection
all have side tables, so all five would have hit the same wall. It would also
have broken three things the game needs: save and resume between legs, which is
the whole save model for a roguelike; the counterfactual replay worker (WP-18),
which is the strongest teaching device in the design; and the golden run harness
(WP-20), which gates all fourteen legs.

**`ProcessSpec` could not express a serial fraction.** Sim spec 4.3 said it
carried one. It did not. A leg declares its processes only through `ProcessSpec`,
so leg 2 had no way to set up its own lesson.

### What changed

Additive and optional, so nothing that compiled before stopped compiling.

In `src/kernel/types.ts`:

- `KernelSnapshot.completeness?: SnapshotCompleteness`, either `init_only` or
  `full`. Absent means `init_only`.
- `KernelSnapshot.subsystems?: SubsystemSnapshots`, one slot per subsystem.
- `ProcessSnapshotState`, fully typed, plus `ProgramSnapshot`,
  `ThreadSnapshot`, `IdCounters` and `IpcSnapshot`.
- `SubsystemEnvelope` and `JsonValue`, the versioned envelope for the five
  subsystems that do not exist yet.

In `src/game/types.ts`:

- `ProcessSpec.serialFraction?: number`.

### Why hybrid rather than fully typed

The process contribution is typed because WP-02 is built and its state is known
exactly. The other five subsystems get versioned envelopes because they are not
built, and designing their internals now would mean guessing and then amending
again the moment each one landed. Each package replaces its own envelope with a
typed interface, additively, the same way this amendment was made, and records it
here.

The envelope is a transition mechanism. It is not the destination, and a
subsystem that ships leaving its state opaque has not finished.

### Why the new fields are optional

Making them required would have broken every snapshot construction site the
instant this landed, including code that had already passed its gates. An
init-only snapshot also genuinely has no workload state to record, so absence
carries real meaning rather than standing in for "not done yet".

The cost is that the type system no longer proves a snapshot is complete.
`restore` is the enforcement point instead: it must reject a snapshot whose
completeness is weaker than the state being restored into, and throw rather than
silently drop state. WP-11 owns that check. This is a deliberate trade of
compile-time strictness for a migration that does not break a green build, and it
is the weakest part of this amendment.

### Consequences

- **WP-11** owns the process contribution and the `restore` completeness check.
  A shallow PCB snapshot is not sufficient and will not pass review.
- **WP-05, WP-07, WP-09, WP-10** each own their subsystem's envelope, and should
  promote it to a typed interface in the same commit that implements the
  subsystem.
- **WP-02** keeps its init-only guard. It is correct, and it throws with
  `// TODO(astra): blocked on contract change, see report`, which can now be
  resolved by WP-11.
- **WP-18 and WP-20** depend on this working. Neither can be accepted while
  restore is init-only.

---

## Amendment 2, 2026-09-12: the Amdahl burst model

**Raised by:** the implementing agent, as a specification finding.
**Approved by:** Kyle.
**Status:** applied. No frozen contract change, so no hash change.

### What was wrong

Sim spec 4.3 charged `threadCreateTicks` to raw service *before* dividing by the
Amdahl speedup: `(R + O*N) / S(N)`. Thread creation overhead therefore got
cheaper the more threads you spawned, because the division accelerated the
overhead along with the work.

The published `AMDAHL-2` fixture did not even do that. It was pure `R / S(N)`,
with no overhead at all, so the prose and the fixture disagreed with each other
as well as with the design.

The consequence was a game problem rather than a numerical one. Leg 2, The Weave,
teaches that parallel speedup has a ceiling and that coordination cost eventually
dominates. Under the old arithmetic, over-threading was very nearly free: with
`s = 0.25, R = 100, O = 2`, the old model bottomed out at 38.75 ticks at 12
threads and only rose to 44.84 at 32, a 1.16x penalty for spawning nearly three
times the optimal thread count. That is not a hazard a player can feel, so the
leg could not teach its own lesson.

### What changed

Overhead is charged after the division, and scales with thread count:

```
effective = ceil( R / S(s, N) ) + O * N
```

With `s = 0.25, R = 100, O = 2` this produces a real optimum and a real penalty:

| N | speedup | old `(R+O*N)/S` | new `R/S + O*N` |
|---|---|---|---|
| 1 | 1.0000 | 102.00 | 102.00 |
| 2 | 1.6000 | 65.00 | 66.50 |
| 4 | 2.2857 | 47.25 | 51.75 |
| 6 | 2.6667 | 42.00 | **49.50** |
| 8 | 2.9091 | 39.88 | 50.38 |
| 16 | 3.3684 | 39.19 | 61.69 |
| 32 | 3.6571 | 44.84 | 91.34 |

On the integer curve the fixture asserts, the optimum is 50 ticks at five, six or
seven threads (unrounded, 49.50 at six). Thirty-two threads is 92, 1.84x the
integer optimum, and
slower than 4. A player who keeps spawning now feels it.

`ceil` is specified rather than `round` because `R / S` at N = 2 is exactly 62.5
(66.5 once the four overhead ticks are added),
and a half-way tie rounds differently across implementations: JavaScript's
`Math.round` gives 67, Python's `round` gives 66. A fixture that depends on which
language ran it is not a fixture. `ceil` also never under-charges service, which
is the right bias for a scheduler.

`amdahlSpeedup` itself is unchanged, so `AMDAHL-1`, `AMDAHL-1b`, `AMDAHL-1c` and
`AMDAHL-3` keep their values. Only the burst accounting moved, so `AMDAHL-2` is
replaced:

- old expected: 100, 63, 44, 34, 30, 27
- new expected: 102, 67, 52, 51, 62, 92 for N = 1, 2, 4, 8, 16, 32

### Consequences

- **WP-02** implemented the old arithmetic faithfully and flagged the problem.
  `src/kernel/process/threads.ts` charges overhead into `rawService` before
  division and needs to move it after. This is a follow-up on WP-02, not a defect
  in its report.
- **WP-L02, The Weave**, gains its hazard back. Over-threading is now a real
  failure mode with a felt cost.

---

## Amendment 3, 2026-09-13: the slots amendment 1 forgot

**Raised by:** the implementing agent, at the close of WP-03.
**Approved by:** Kyle.
**Status:** applied. `contracts.lock.json` amendment 3.

### What was wrong

`SubsystemId` has ten values. Amendment 1 gave `SubsystemSnapshots` six slots. The
four missing were `scheduler`, `vm`, `deadlock` and `io`.

WP-03 built the scheduler, went to persist its queues, quantum, aging and
starvation timers and metrics accumulators, and found no slot. It stubbed and
escalated, correctly.

This is worth being blunt about. Amendment 1 existed specifically to fix a missing
state channel, and it shipped one day before this, and it under-populated the
channel it was created to add. Four defects of the same shape have now been found
by escalation: the WP-01 scanner policy, the WP-02 snapshot channel, the WP-03
phase 10 scope, and this. Every one was a case of specifying an outcome in one
place and the means in another, then not reconciling them.

`SchedulerSnapshot` already exists and is not the answer. It is a read-only view
for the HUD and the world, deliberately cheap to produce every tick. It carries
computed averages rather than the accumulators behind them, and it has no aging or
starvation state at all. Restoring from it would silently reset a run's history.

### What changed

Four slots added, each an envelope, plus the thing that matters more:

```ts
type _EverySubsystemHasASlot = SubsystemId extends keyof SubsystemSnapshots ? true : never;
const _subsystemSlotCheck: _EverySubsystemHasASlot = true;
```

A missing slot is now a compile error rather than an escalation four weeks later.
That check is the actual deliverable of this amendment. The slots are the symptom.

### Why the scheduler slot is an envelope and not typed

WP-04 still has to add priority aging, round robin and three-level MLFQ, and MLFQ
per-level state does not exist yet. Typing the scheduler contribution now would
mean guessing at it and amending a fourth time. WP-04 promotes it to a typed
interface when the scheduler is complete, and records that here.

### Consequences

- **WP-03** fills the `scheduler` envelope for the four policies it implements,
  with tests, and removes its own persistence stub.
- **WP-04** extends that envelope with the state it adds (aging clock, round robin
  position, MLFQ per-level queues) and then promotes it to a typed interface.

  This was changed twice and the second change was wrong. The reasoning for moving
  the whole thing to WP-04 was that filling and promoting are one piece of thinking
  and half the state does not exist yet, so splitting means deriving the shape
  twice. That reasoning assumed the work had not been done. It had: WP-03 had a
  tested implementation on disk when the decision was made, and discarding working
  code so a later package could rederive it is waste, not tidiness.

  The envelope is versioned precisely so it can be extended. WP-04 bumping the
  version and adding its fields is the mechanism working as designed, not churn.

  The real lesson is about process rather than factoring: this plan changed while
  the package was in flight, and the agent found the contradiction by reading the
  repository rather than being told. Do not rescope a package that is still
  running without telling the agent running it.
- **WP-05, WP-07, WP-09** each now have a slot that exists, so the obligation in
  their kickoff card is satisfiable. WP-05 owns both `memory` and `vm`.
- **WP-11** reconstructs all ten, and its restore completeness check now has ten
  slots to validate rather than six.

---

## Amendment 4, 2026-09-13: typed memory and vm contributions

**Raised by:** the implementing WP-05 agent, before editing the frozen contract.
**Approved by:** Kyle, after reviewing the exact typed-slot promotion patch.
**Status:** applied on wp-05. Hash regeneration was explicitly human-approved in
that review. The amendment number is provisional until merge order is known.

### What was an envelope

`SubsystemSnapshots.memory` and `.vm` were optional `SubsystemEnvelope` slots.
Their presence allowed persistence, but their payloads did not describe the state
that a complete restore must retain.

### What changed

The slots now name `MemorySnapshotState` and `VmSnapshotState`. Both retain their
owner, version 1 and plain JSON payload; optional slot presence is unchanged.

The memory contribution contains frame ownership and retained/free ordering,
page tables, contiguous holes and placement order, content-copy tags, requested
byte counts and allocation policy. The vm contribution contains ASID-tagged TLB
slots in replacement order, lookup counters, TLB timing and pending instruction
access costs. The split keeps physical placement separate from translation and
its unfinished work. There are no Maps, Sets or class instances in either payload.

### Review observations

- The mapped types over `Frame` and `PageTableEntry` couple this versioned save
  format to frozen interfaces. A later change to either must review the persisted
  shape and its version; mapped types do not remove that obligation.
- `rations` is game vocabulary in the kernel, as required by sim spec 6.6. Its
  literal union is mirrored without importing game code.
- `replacementScope` and `allocationScheme` pre-declare WP-06 territory. WP-05
  records the selected allocation parameters; it does not implement replacement.

### Consequences

WP-06 extends the vm contribution with demand-fault service state, replacement
ordering, fault counters and working-set state, and versions the shape when it
changes. WP-11 reconstructs both typed contributions through installed snapshot
hooks. Full process-workload restore remains WP-11's responsibility.

The contract and approved hash update are committed separately from the WP-05
implementation, as directed in the review. If another promotion takes amendment
4 first, this number is changed at merge, not on this branch.

---

## Amendment 5, 2026-09-13: demand paging and VM continuation

**Raised by:** the implementing WP-06 agent in the pre-flight grant review.
**Approved by:** Kyle, explicitly approving the exact patch and human-approved
hash regeneration before application.
**Status:** applied on wp-06. Number 5 is provisional until merge order is known.

### What was incomplete

`VmSnapshotState` version 1 described only translation cache state and unfinished
TLB access costs. Demand paging needs to preserve pending faults, replacement
ordering, working-set measurements and suspension state across a restore.

### What changed

The exact reviewed patch promotes only the vm contribution to version 2. It
retains its prior fields and adds installed settings, policy order/cursors and
aging position, ordered paging requests and reserved frames, logical-reference
accounting, fault counters, working-set rings and noise deadlines, thrashing and
PFF control, prior waits for suspended threads, prefetch credits and locality
remaps. The memory contribution remains version 1 and is unchanged.

### Why this shape

Every value is plain JSON. Frame and PTE metadata, retained-frame order and
content tags remain in memory. The shared vm RNG remains in KernelSnapshot's RNG
registry and is restored once; no second copy is placed in vm. Generated programs
are eagerly materialized, so their instructions remain in the process slot.
Suspension records retain original thread waits so recovery does not incorrectly
release an I/O, semaphore or child wait. Request ordering and deadlines preserve
fault-before-eviction-before-load events without serializing callbacks.

### Consequences

WP-06 writes vm version 2 and rejects explicit version 1 rather than guessing
missing fault state. Restore continues to prepare and validate all contributions
before committing. WP-11 still owns full workload reconstruction and must account
for reserved page-in/write-back frames and suspension metadata alongside the
retained-frame and shared/COW alias exceptions documented by WP-05.

The PageId-only OPT lookahead remains a known limit for global OPT across address
spaces; this amendment does not widen it. The approved contract and regenerated
hash are committed separately from implementation. Renumber at merge if another
package takes amendment 5 first.

---

## Amendment 6, 2026-09-13: typed scheduler continuation

**Status:** applied on wp-04 after explicit human review of the exact patch and
approval of hash regeneration. Number provisional against WP-07 and WP-09 merge
order. The WP-04 pre-flight approval is recorded in commit 7d53860.

### What was an envelope

Amendment 3 introduced `SubsystemSnapshots.scheduler` as `SubsystemEnvelope`.
WP-03 filled version 1 for four policies, including ordered queues, policy detail
and integer scheduling accounting. Its policy payload also copied computed HUD
metrics, which are not an authority for rebuilding execution history.

### What changed

The slot is now `SchedulerSnapshotState`, version 2, with explicit discriminants
for fcfs, sjf, srtf, priority, priority_aging, rr and mlfq. The reviewed change
leaves the memory, vm and process contributions and the policy/HUD contracts
untouched. It preserves FCFS insertion metadata, SJF estimator history, runtime
ready order, CPU owner, slice and switch debt, and integer busy/first-dispatch/
completion records. It adds aging clocks, logical RR slice position and MLFQ
level queues, accounting mode, CPU baselines and demotion counters.

### Why this shape

The payload contains plain JSON values with explicit versioned parameter fields,
not a mapped copy of a future interface. It contains no computed averages,
callbacks, Map or Set. Ordered queues represent ring position; unused buffer cells
and physical head indices need not survive normalization. A CPU baseline renews
a same-owner quantum without a false context switch. PCB readySince and priority
remain process-owned; together with the saved aging clock they retain starvation
and promotion timing. Runtime requested params and normalized policy params have
distinct meanings and are both retained.

### Consequences

WP-04 rejects explicit v1 contributions and missing accounting and recomputes HUD
metrics through the installed hook after restoration. Stable per-tick
`SchedulerSnapshot` objects remain distinct from detached persistence values.
The scheduler contribution is tested against equivalent staged process state.
Full fresh-kernel workload reconstruction stays with WP-11, including its process
schema gaps and the ThreadManager `overheadRemaining` and `pricedCores` side
state. Neither removing its guard nor replaying a prefix qualifies as restore.

The exact frozen-file patch and guard regeneration were human-approved before
application. This amendment and the regenerated lock are committed separately
from implementation.

---



## Amendment 7, 2026-09-14: typed synchronisation continuation

**Status:** applied on wp-07 after explicit human review of the exact
wp07-contract-promotion.patch and approval of hash regeneration on 2026-09-14.
Number provisional against WP-09's merge order. The WP-07 pre-flight decisions
are recorded in commit 352552e; this exact-patch approval followed that review.

### What was an envelope

Amendment 1 introduced `SubsystemSnapshots.sync` as `SubsystemEnvelope`.
The envelope could carry JSON but did not describe the primitive, execution,
race-detector or scenario state required to resume synchronisation.

### What changed

The slot is now `SyncSnapshotState`, version 1. Its explicit records describe
all five primitive kinds, actor ownership, ordered wait generations and reserved
grants, counting-semaphore debit provenance, requirement checks and priority
inheritance. They also retain memory-order buffers, atomic lock protocols,
partial instruction work, bounded race evidence and seven scenario families.
The reviewed patch changes no process, scheduler, memory, VM, storage, I/O or
game contract. The two approved cosmetic adjustments add the slot comment and
retain one blank line before the scheduler types.

### Why this shape

The payload contains explicit readonly plain-data records, not callbacks, Map,
Set, a generic JSON escape or mapped copies of runtime interfaces. Ordered
queues retain hand-off order. Actors carry both PID and TID, while the shared
primitive view and events still project PIDs. Anonymous semaphore debits survive
exit, exec and join without returning permits that can represent occupied
buffer slots. Completed grants remain distinct from ungranted waits, so pure
readiness queries need not consume state.

Memory buffers retain issue order and issuer-attempt drain position. Race state
retains a 32-record history plus bounded witnesses, per-actor RMW provenance and
the serial shadow needed to explain lost updates. Scenario progress includes
partially completed work and already drawn think/eat intervals. It does not
copy the TCB program counter, immutable programs, root/sync RNG state or an
IPC-owned value. External cells carry binding identifiers; control cells own
their values in this contribution. The shared primitive fields are derived from
the detailed records, rather than saved as a second authority in this payload.

### Consequences

WP-07 validates detached records before committing a restored contribution,
including cross-references, queue order, bounds, actor ownership and settings.
A BB reservation may retain a historical permit ID already retired by a legal
non-owner post. Buffered stores may retain a joined TID while its PID is live;
current execution and unqueued RMW operations require valid staged TCBs.
Donations apply only to mutex owners, monitor-lock owners and RW writers, never
counting-semaphore provenance. The requirement observation mode preserves an
intentionally broken teaching scenario without waiving unrelated invariants.

The contribution is for restoration against equivalent staged process, TCB,
IPC, RNG and event state. Fresh-kernel workload reconstruction, program decoding,
distinct per-TCB block-reason restoration and removal of the inherited guard
remain WP-11's. The new serializable sync Instruction variant is documented in
the WP-11 handoff; it does not change the frozen process slot here.

The exact frozen-file patch and its two cosmetic adjustments were reviewed
before application. Hash regeneration was explicitly human-approved on
2026-09-14 for this patch only. This amendment and regenerated lock are committed
alone, before implementation.

---


## Amendment 8, 2026-09-14: typed deadlock continuation

**Status:** applied on wp-08 after explicit human review of the exact
wp08-contract-promotion.patch with two required corrections and approval of
hash regeneration on 2026-09-14. Number provisional against WP-09's merge
order. The WP-08 pre-flight decisions are recorded in commit 1a31b08.

### What was an envelope

Amendment 3 introduced `SubsystemSnapshots.deadlock` as `SubsystemEnvelope`.
The envelope did not describe resource claims, actor-specific requests,
recovery state or the observation history needed for deterministic detection.

### What changed

The slot is now `DeadlockSnapshotState`, version 1. Explicit readonly records
preserve resource declarations and ranks, maximum claims, ordered atomic
requests and reservations, declared mailbox endpoints, resource-free PC
checkpoints, preemption counts and temporary preemptibility overrides. They
also retain dependency observation generations and formation times, confirmed
witness episodes, pre-recovery I-26 evidence and integer statistics. No other
subsystem slot, PCB, TCB, BlockReason or game contract changes.

The reviewed correction spells `lastDetection.report` as a structurally
identical type literal instead of referencing the `DeadlockReport` interface.
Interfaces have no implicit index signature and that reference prevented the
payload from extending `JsonValue`. The other correction brands both mailbox
fields as `ResourceId`, matching the rest of the contract.

### Why this shape

Every payload field is explicit readonly plain data. There are no callbacks,
Map, Set or generic JSON escape fields. A standalone strict TypeScript check
resolves `DeadlockSnapshotState['payload'] extends JsonValue` to true and
checks assignability in both directions between the saved report literal and
`DeadlockReport`. All three checks pass on Node 22.23.2 with TypeScript 7.0.2.

Allocation, Need and Available remain derived from staged PCB multisets and
resource declarations. Reserved requests are already allocated and are not
charged twice on restore. Declaration preemptibility is the base value;
active overrides determine the effective shared resource projection.

Actors carry PID and TID before graph projection. Dependency records retain
complete alternative groups and distinguish resource, sync, mailbox and child
waits. Generation sets preserve continuously observed witnesses without running
detection during bookkeeping. Captured I-26 evidence predates recovery and
cannot be checked against owners that recovery has already removed. Integer
accumulators preserve exact utilization and latency without saving averages.

### Consequences

WP-08 prepares its contribution against equivalent staged process, TCB, sync,
IPC, resource and configuration state, validates before mutation and returns a
commit closure. Strategy remains in `KernelSnapshot.config`. Full fresh-kernel
reconstruction, process decoders, IPC continuations and general syscall results
remain WP-11's responsibilities. PC rollback does not rewind service, CPU,
Amdahl debt, scheduler state, time, RNG or external subsystem effects.

Resource-table waits reuse the existing semaphore BlockReason and are routed
after IPC matching and before sync. Every detector-confirmed cycle has all four
Coffman conditions. Preemptibility is a recovery property and never suppresses
detection; near-deadlocks are acyclic hold-and-wait chains.

The exact frozen-file patch, with the report-literal and branded-mailbox
corrections, was reviewed before application. Hash regeneration was explicitly
human-approved on 2026-09-14 for that corrected patch only. This amendment and
regenerated lock are committed alone, before implementation.

---


## Amendment 9, 2026-09-14: typed storage and I/O continuation

**Status:** applied on wp-09 after explicit human review of the exact
wp09-contract-promotion.patch and its one-line driver discriminant correction,
with approval of hash regeneration on 2026-09-14 for precisely those changes.
The WP-09 pre-flight decisions are recorded in commit 17a5cb9. The reviewer
also approved including the mechanical G7 fixture migration in this amendment
commit so that the commit passes all four gates independently.

### What was an envelope

Amendment 1 introduced `SubsystemSnapshots.storage` as `SubsystemEnvelope`;
amendment 3 added the `io` envelope. Neither described the media, request,
interrupt or device state needed for deterministic continuation.

### What changed

The slots are now `StorageSnapshotState` and `IoSnapshotState`, both version 1.
The exact reviewed patch adds 726 lines and removes three in types.ts. It
changes no other existing subsystem, process, scheduler, memory, VM or game
contract. The separately approved correction changes the driver discriminant
from `console` to `character_output`. Storage records physical queues, committed routes, durable data,
NVM mapping and GC, RAID dependencies and rebuilds, and opt-in paging backing.
I/O records actor requests, CPU charges, interrupts and storm mitigation,
device routing, buffers, cache generations and flushes, and spool jobs.

The dummy snapshot contribution in `tests/kernel/memory/frameTable.test.ts`
moves from `io` to the still-untyped `fs` slot. Only the slot key and owner on
the three approved G7 lines change; assertions, values and run calls remain
unchanged. This migration is a mechanical consequence of promoting `io`, not
subsystem implementation.

### Why this shape

Both payloads use explicit readonly type literals and scalar brands rather
than embedded runtime interfaces, callbacks, Map, Set or generic JSON fields.
Standalone strict TypeScript checks prove that both payloads extend
`JsonValue`, both outer states fit `SubsystemEnvelope`, and the media result
types agree in both directions. The reviewer independently verified the
payload and envelope checks before approving the exact patch.

Request IDs preserve completion ownership across the two slots. Committed
routes preserve their timing across policy changes. NVM state retains partial
requests and reserved GC destinations; RAID state retains dependency results,
spare ownership, rebuild frontiers and irreversible data loss. Cache generations
cannot be reused after eviction, and flush progress identifies one completion
route. Device-to-media bindings preserve where future queued work is sent.

Paging backing is opt-in. Its snapshot is null until a leg or test explicitly
calls `attachPagingStorage()`; enabling storage alone never attaches it.
Restoring a nonnull contribution preserves prior explicit attachment. The
existing WP-06 deadline remains a floor, and media acknowledgement may only
delay completion. No `VmSnapshotState` field changes.

### Consequences

WP-09 must prepare both contributions without mutation, validate references,
ordering, bounds and mirror tables together, then commit and rebind stable
views. Completed-tick snapshots preserve the I/O portion of kernel debt while
the existing scheduler slot remains the owner of the combined `switchDebt`.
Root RNG state stays in `KernelSnapshot.rng`; process and VM state retain their
existing owners. Full fresh-kernel program and thread reconstruction remains
WP-11's obligation, and the inherited restore guard stays.

WP-10 must migrate the frameTable dummy contribution again when it promotes
`fs`. WP-10 and WP-11 must use the device ID `tty0`, driver module
`io/drivers/characterOutput.ts` and snapshot discriminant `character_output`.
The protected source scanner retains string literals and import paths, so the
bare forbidden identifier `console` failed the test gate even as a harmless
driver discriminant. The user approved these names instead of changing the
scanner or its policy. Do not reintroduce that identifier in kernel strings or
imports. The user will correct remaining device prose in the spec and package.

The NVM amplification and RAID queue-ratio fixtures still require their
approved fixed-input measurements; this type promotion does not establish
those numerical claims.

The original frozen-file patch and its one-line discriminant correction were
applied exactly as reviewed. Hash regeneration was explicitly human-approved
on 2026-09-14 for that combination only. This amendment,
regenerated lock and approved mechanical fixture migration are committed
together before subsystem implementation. All four Node 22 gates must pass
before this amendment is committed.

---


# Package scope corrections

Not contract changes, so no hash moves and no amendment number. Recorded here
because they changed what a package is allowed to do, and a later agent reading
only its package would not otherwise know why.

## 2026-09-12: phase 10, WP-03 and WP-05

**Raised by:** the WP-03 agent, asking before editing rather than after.

WP-03 required scheduling metrics and granted no way to wire them into the kernel.
It also required the reference fixtures to stop depending on an ambiguous scheduler
id while excluding the two files that hold them. Both were defects in the package.
This is the third time a package has demanded an outcome while withholding the
means, after the WP-01 scanner policy and the WP-02 snapshot channel. The pattern
is mine: I wrote the outcome and the file list at different moments and did not
reconcile them.

Phase 10 turned out to be contested. WP-03 needs it for scheduling metrics and
WP-05 recomputes `MemoryMetrics.tlbHitRate` there, and both were in flight at the
same time.

**Decision.** WP-03 converts phase 10 into a metrics dispatch point that calls each
enabled subsystem's hook, following the `installHooks` pattern WP-02 established
for phases 2, 3, 4 and 6. WP-03 owns the scheduling side in
`src/kernel/scheduler/metrics.ts`. WP-05 registers through the hook and does not
edit phase 10 at all. If WP-05 arrives before the dispatch point exists, it stubs
and reports rather than adding the dispatch itself.

WP-03 also gained permission to name `fcfs` explicitly in
`tests/kernel/fixtures/referenceConfig.ts` and `tests/kernel/determinism.test.ts`,
changing the scheduler id and nothing else.

**The general lesson, worth applying to every remaining package.** A contested
region of a shared file should become an extension point rather than a scheduling
problem between agents. When two packages need the same lines, the first one there
turns those lines into a dispatch and the second registers into it. Serialising one
seam costs less than merging two versions of it.

**Also settled:** the four wave 2 agents get one git worktree each, on their own
branch, because all four packages grant `Kernel.ts` and `index.ts` and a shared
checkout loses work silently. WP-03 merges first. See
`docs/astra/00-KICKOFF-PROMPT.md`.

## 2026-09-13: WP-05, snapshot slots, tlb_flush and the miss gate

**Raised by:** the WP-05 agent, asking before editing.

Fifth instance of a package requiring an outcome while its file grant excluded the
means. The three requests were snapshot save and restore for the `memory` and `vm`
slots, `ioctl("tlb_flush")`, and a gate so a TLB miss on a resident page costs
`tlbMissTicks` without becoming a page fault. Every one is in the specification:
the syscall table row, the exec semantics, the package's own `tlbMissTicks = 2`,
and an acceptance test that calls the ioctl by name.

Worth recording that the reviewer nearly declined the ioctl from first principles
(an ASID-tagged TLB does not need a flush on context switch, so why expose one)
before reading the spec, which had already settled it: the flush is exec's
mechanism and a teaching verb. Consistency with a decided specification beats
re-deriving the design at review time. Read first.

**Decision.** All three approved, shaped for the two packages merging next:
snapshot save and restore becomes a dispatch over installed hooks rather than a
growing literal, the ioctl gains exactly one subcommand with `EINVAL` on anything
else and a marker for WP-11, and the miss costs come from two new `KernelTuning`
keys rather than literals.

**The root cause is now clear enough to fix at the source.** Every "Nothing else
in this file" grant was written narrower than the package's own specification.
Before WP-07 and WP-09 start, their grants should be audited against their
specifications and against the current `Kernel.ts`, `config.ts` and the syscall
dispatch, so the sixth and seventh escalations do not happen. `config.ts` is a
fourth shared file, alongside `Kernel.ts`, `index.ts` and the snapshot sites, and
every subsystem will add tuning knobs to it.

## 2026-09-14: WP-07 pre-flight grants and semantics

Not a contract change. The WP-07 pre-flight requested five source grants (a
sync `Instruction` variant and its `execute` dispatch, an optional `tid` on
`SyncHooks.isSatisfied`, wrapping the scheduler hook for priority inheritance,
an explicit `SyncPrimitive` projection in `snapshot()`, and exec cleanup through
the `detachIpc` callback) and eleven groups of spec decisions. All were
approved and recorded in the package under "Pre-flight decisions 2026-09-14".
Spec corrections applied in the same commit: the store-buffer drain model
(8.2), semaphore capacity versus initial value (8.4 table), bounded-buffer
conservation and I-22, I-23 scoped to exclusive primitives and internal actors,
the readers-writers workload and throughput wording, the room solution's
Coffman condition, and three scenario rows added to 16.7. Amendment 7 is
reserved for the typed `SyncSnapshotState`, pending its own exact-patch review.


## Amendment 10, 2026-09-15: WP-12 design tokens freeze

**Raised by:** the WP-12 implementing agent after the accepted GPU run.
**Approved by:** Kyle, for the exact content and this one hash addition.
**Status:** applied. Number 10 is provisional against WP-10's merge order;
WP-10's fs and security promotion becomes amendment 11.

No existing contract was unfrozen. `src/design/tokens.ts` was previously an
unfrozen scaffold and is now frozen as the single source of colour, gain,
motion and type. Its reviewed SHA-256 is:

`f9bc27ef0bb2a84b47bcb683006ca027de3da9e71729e5c68d654024b01b17c2`

Hash regeneration was human-approved on 2026-09-15 for this addition only.
The two existing hashes for `src/kernel/types.ts` and `src/game/types.ts`
remain unchanged. No source file changes accompany this amendment.

The frozen content carries the approved corrections to the original scaffold:

- Contrast floors use the computed WCAG ratios truncated to one decimal, with
  Node assertions against the corrected table.
- The backing plate is rgba(4, 6, 10, 0.92), composed after tone mapping. Its
  worst-case contrast assertion requires the stated underlying display
  luminance bound of 0.15; it is not an unconditional contrast guarantee.
- Micro type is 0.8125rem, preserving the 13-device-pixel floor at DPR 1.
- Semantic layers follow architecture 5.6: ENV through LIGHTS occupy 1 to 8;
  WORLD is the mask of layers 1 to 6, replacing the scaffold's 0/1/2 scheme.
- The sixth gain state, `off`, is explicitly retained and ratified at 0.0.

No file under `src/` other than `src/design/tokens.ts` may hold a colour
literal. Consumers derive colours from this frozen source, including CSS
values. Further edits to the frozen file require a separately reviewed
contract amendment rather than routine hash regeneration.

Kyle accepted the actual WebGPU and forced-WebGL2 run as WP-12 runtime
evidence. Image-based reflection and SDF checks, a no-float-colour-extension
device, reduced-motion visuals and the 60 fps benchmark remain open for
WP-13 and the smoke harness; they are not recorded as passes.

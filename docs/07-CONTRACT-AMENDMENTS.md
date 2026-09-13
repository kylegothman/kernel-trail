# Frozen contract amendments

`src/kernel/types.ts` and `src/game/types.ts` are frozen. A work package may not
edit them; it escalates instead, and a human decides. This file is the record of
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

The optimum is 6 threads. Thirty-two threads is 1.85x worse than the optimum and
slower than 4. A player who keeps spawning now feels it.

`ceil` is specified rather than `round` because `R / S` at N = 2 is exactly 66.5,
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

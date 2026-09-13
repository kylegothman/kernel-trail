# Grant audit: WP-07 and WP-09

Written 2026-09-13, before either package started, on the instruction at the end of
`docs/07-CONTRACT-AMENDMENTS.md`: audit both grants against their own
specifications and against the current `Kernel.ts`, `config.ts` and syscall
dispatch, so the sixth and seventh escalations do not happen.

Sources used for every claim below: the staged post-WP-05 `src/kernel/Kernel.ts`,
`src/kernel/config.ts`, `src/kernel/types.ts` and
`src/kernel/memory/MemorySubsystem.ts`; the WP-05 completion report; sim spec
sections 8, 10, 11, 14, 15 and 16; and the two packages themselves.

Files edited, all under `docs/astra/`:

- `WP-06-virtual-memory-and-replacement.md`: added `## Inherited from WP-05`
- `WP-07-synchronisation-and-race-detector.md`: added
  `### Scope correction, 2026-09-13` and `## Inherited from WP-05`
- `WP-09-storage-and-io.md`: added `### Scope correction, 2026-09-13` and
  `## Inherited from WP-05`
- `WP-11-syscalls-snapshot-invariants.md`: added `## Inherited from WP-05`

Nothing existing was reflowed, reordered or rewritten.

---

## WP-07: required outcomes against the grant

Grant before this audit: `src/kernel/Kernel.ts` (wire `SyncHooks` to
`SyncSubsystem`, nothing else) and `src/kernel/index.ts` (leave it alone).

| # | Required outcome | Source in the package | File and region that must change | Granted? |
|---|---|---|---|---|
| 1 | Five primitives with textbook semantics | Spec 2, tests `primitives.test.ts` | `src/kernel/sync/**` | yes, created |
| 2 | `isSatisfied` for `semaphore`, `mutex`, `condition` | Spec 8, acceptance 10 to 15 | `SyncHooks.isSatisfied`, already dispatched from the kernel's `isSatisfied` helper and phase 4 | yes, wiring |
| 3 | `sem_wait` syscall | Sim spec 14.3, required reading | `dispatchSyscall`, which ends at a default branch returning `EINVAL` `not implemented in WP-02` | **no, defect D1** |
| 4 | `sem_post` syscall | Sim spec 14.3 | same branch | **no, defect D1** |
| 5 | `mutex_lock` syscall | Sim spec 14.3 | same branch | **no, defect D1** |
| 6 | `mutex_unlock` syscall | Sim spec 14.3 | same branch | **no, defect D1** |
| 7 | `request` syscall, `'ignore'` and `'detect'` paths | Sim spec 14.3 Resources | same branch | **no, defect D1** |
| 8 | `release` syscall, same two paths | Sim spec 14.3 Resources | same branch | **no, defect D1** |
| 9 | `progressStallLimit` default 4 | Spec 1, sim spec 8.1 | `KernelTuning` in `config.ts`, which has no such key | **no, defect D2** |
| 10 | `boundedWaitLimit` | Spec 1, sim spec 8.1 | `config.ts` | **no, defect D2** |
| 11 | One tick per spin iteration, from tuning not a literal | Spec 4, sim spec 8.3, WP-05 precedent | `config.ts` | **no, defect D2** |
| 12 | `storeBufferDepth` default 2 | Spec 3, sim spec 8.2 | `config.ts` | **no, defect D2** |
| 13 | `priorityInheritance` default false | Spec 6, sim spec 8.5 | `config.ts` | **no, defect D2** |
| 14 | `rwlockPolicy` three values | Spec 2 and 7, sim spec 8.4 and 8.8 | `config.ts` | **no, defect D2** |
| 15 | `subsystems.sync` save and restore | Spec 9, acceptance 21 | `snapshot()` and `restore()` on `KernelImpl` | **no, defect D3** |
| 16 | Primitives visible in `KernelSnapshot.syncPrimitives` and to the invariants | Spec 9, acceptance 17, sim spec 15 I-10, I-21, I-23 | the private `syncPrimitives` field, written only by `restore`, plus the existing initialisation helper | **no, defect D4** |
| 17 | Priority inversion detected in phase 4 | Spec 6, sim spec 8.5, test `priority inversion detected` | needs a once-per-tick phase 4 entry point; `SyncHooks` has none | **no, defect D5** |
| 18 | `root/sync` stream and the emit callback reach the subsystem | Spec 2 and 7, tests `semaphore post unordered`, `rng stream` | the kernel constructor, where WP-05 constructed its subsystem | **partly, defect D6** |
| 19 | Spin ticks count as CPU busy in `cpuUtilisation` | Spec 4, acceptance 9, test `spin counts as busy` | `scheduler/metrics.ts` and the phase 10 registration site, both excluded | **no, defect D7** |
| 20 | `kernel.panic` on progress violation, `process.starving` on bounded-waiting violation | Spec 1, tests `progress check`, `bounded waiting unordered` | emit callback from wiring | yes, once D6 is granted |
| 21 | `inversions()`, `spinTicks(pid)` accessors | Spec 4 and 6 | `src/kernel/sync/**` | yes, created |

**Seven grant defects: D1 to D7.**

### Corrections made, WP-07

All in the new `### Scope correction, 2026-09-13` section, placed under
"Files you may modify" in WP-05's style.

- D1: grants exactly six syscall branches. Each routes into `SyncSubsystem`,
  unknown input returns `EINVAL`, each carries
  `// TODO(astra): WP-11 validates <call> arguments`. The `'avoid'` and
  `'prevent'` paths of `request` are named as WP-08 territory and left behind a
  TODO. The correction also records that nothing in the tree constructs a
  `ResourceType`, so the resource table has no owner, and tells the agent to
  report that rather than invent one.
- D2: grants `config.ts` additively and names all six keys with defaults and the
  validation shape to copy. Distinct keys, no reformatting, because WP-09 is adding
  its own at the same time.
- D3: snapshot save and restore through `installHooks({ snapshots })` with
  `saveState` and `restoreState`, `restoreState` returning a commit closure, no
  hard-coded slot key, duplicate ownership rejected.
- D4: binds the live primitive array in the existing initialisation helper and
  rebinds after a restore commit, the way WP-05 bound the frame and TLB views.
- D5: run detection from the first `isSatisfied` call of a tick behind a last-seen
  tick guard; escalate for a new hook member rather than editing phase 4.
- D6: construction wiring stated explicitly, including the stream and the emit
  callback.
- D7: model each spin iteration as an instruction so the existing phase 8
  accounting charges it; escalate if that is impossible. No metrics hook is
  registered, because the frozen contract has no `SyncMetrics` and `MetricsHooks`
  carries only `scheduler` and `memory`.
- Both WP-05 warnings are stated: snapshot-only registration for the round-trip
  test, and generic dispatch not finishing WP-11's workload persistence.
- WP-09's territory is named: `storage/**`, `io/**`, the `storage` and `io` slots,
  the `ioctl` and `sync` branches, `setDiskPolicy`, phases 2 and 3, the
  `DISK_POLICIES` export and its `config.ts` keys.

### Internal inconsistencies found, WP-07

1. **Acceptance count.** "Report back" item 1 asks for "each of the twenty
   acceptance criteria", and the numbered list runs to 21. Same shape as the
   seventeen-versus-eighteen mismatch WP-05 reported. The agent should answer all
   21.
2. **Invariant number.** Acceptance 17 and "Required reading" call mutual exclusion
   I-20. Sim spec 15 numbers mutual exclusion **I-21** and gives **I-20** to free
   list ordering, which the kernel already asserts under number 20 with the message
   `free list not ascending`. Sim spec 8.1 also says I-20. The package inherited
   the spec's own contradiction. Asserting I-20 as written would collide with a
   live memory invariant.
3. **Fixtures not in sim spec 16.7.** The package names `SYNC-MONITOR-BROKEN`
   (spec 2), `SYNC-CAS-BOUNDED` (spec 4 and the atomics test table) and
   `SYNC-BB-UNBALANCED` (spec 7, acceptance and the bounded buffer test table).
   None is a row of 16.7; all three appear only in sim spec 8.3, 8.4 and 8.7 prose.
   They are legitimate scenarios, but the fixture appendix does not carry them, so
   nobody else will notice if one is dropped.
4. **`SYNC-PHIL-NAIVE` cannot pass as published.** Sim spec 16.7 asserts
   `deadlock.detected` by tick 200 with a cycle of exactly five pids and all four
   Coffman values. This package's "Out of scope" forbids emitting
   `deadlock.detected` from `src/kernel/sync/`, and acceptance 14 substitutes a
   circular-wait assertion. The published fixture therefore cannot pass until WP-08
   lands. Acceptance 14 is the right call; the appendix row should say so.
5. **Terminal package number.** Spec 4 credits the `spin%` column to WP-16 while
   WP-09 spec 7 credits `poll%` to WP-15. One of the two is wrong. Neither package
   depends on the answer, so it is a documentation fix, not a blocker.

---

## WP-09: required outcomes against the grant

Grant before this audit: `src/kernel/Kernel.ts` (wire `IoHooks` and
`StorageSubsystem` into phases 2 and 3, implement `setDiskPolicy`, nothing else)
and `src/kernel/index.ts` (add the `DISK_POLICIES` export).

| # | Required outcome | Source in the package | File and region that must change | Granted? |
|---|---|---|---|---|
| 1 | `setDiskPolicy` across all six ids | Acceptance 20 | `setDiskPolicy`, which throws today | yes |
| 2 | Completions in phase 2, interrupt delivery in phase 3 | Spec 8 and 9, test `phase order` | `IoHooks.serviceCompletions` and `deliverInterrupts`, already dispatched | yes, wiring |
| 3 | RAID rebuild timers and NVM garbage collection | Spec 5 and 6, tests `rebuild rate`, `gc trigger` | `StorageHooks.expireTimers`, dispatched in **phase 1**, outside the granted phases | **no, defect D6** |
| 4 | `diskStarvationThreshold` 400 | Spec 4, test `seek starvation` | `KernelTuning` in `config.ts` | **no, defect D1** |
| 5 | `interruptServiceTicks` 2, `maxInterruptsPerTick` 2 | Spec 7 and 8 | `config.ts` | **no, defect D1** |
| 6 | `interruptStormThreshold` 32, `interruptStormWindow` 10, `maxPending` | Spec 9 | `config.ts` | **no, defect D1** |
| 7 | `dmaCycleStealRatio` 0.1 | Spec 7 | `config.ts`, and it is fractional, which the file's only validator cannot express | **no, defect D1** |
| 8 | `nvmWriteBufferPages` 8 | Spec 5 | `config.ts` | **no, defect D1** |
| 9 | `rebuildBlocksPerTick` 4, `rebuildProgressInterval` | Spec 6 | `config.ts` | **no, defect D1** |
| 10 | `blockCacheEntries` 64 | Spec 10 | `config.ts` | **no, defect D1** |
| 11 | Disk geometry and cost constants | Spec 1 and 2 | `storage/geometry.ts` and `costModel.ts`, not tuning | yes, created |
| 12 | `subsystems.storage` save and restore | Spec 12, acceptance 23 | `snapshot()` and `restore()` | **no, defect D2** |
| 13 | The I/O half of that state | Spec 12, acceptance 23 | the `io` slot, which amendment 3 added and spec 12 says does not exist | **no, defect D2** |
| 14 | `ioctl` device subcommands reaching each driver's `control` | Spec 11, acceptance 16, test `mode side table`, sim spec 14.3 table | the `ioctl` branch, which accepts only `tlb_flush` and returns `EINVAL` otherwise | **no, defect D3** |
| 15 | `sync` flushes the dirty block cache | Sim spec 14.3, test `write_back dirty` | `dispatchSyscall` default branch | **no, defect D4** |
| 16 | Disk queue, head and devices visible in `KernelSnapshot` and to the invariants | Spec 12, sim spec 15 I-27, I-28, I-32 | the private `diskQueue`, `diskHead` and `devices` fields, written only by `restore`, plus the existing initialisation helper | **no, defect D5** |
| 17 | Interrupt overhead charged to the kernel, `cpuUtilisation` falls | Spec 8, test `utilisation falls` | the scheduling accounting busy-tick call inside phase 8, and `scheduler/metrics.ts` | **no, defect D7, escalation** |
| 18 | `root/io` and `root/storage` streams and the emit callback reach the subsystems | Spec 11, tests `net0 stream`, `failure not random` | the kernel constructor | **partly, defect D8** |
| 19 | `process.starving`, `fs.corruption`, `kernel.panic`, `raid.rebuild`, `disk.*`, `io.*` events | Frozen event list | emit callback from wiring | yes, once D8 is granted |
| 20 | Exiting processes leave every device and spool queue | Sim spec 15 I-10 and I-32 | `IoHooks.removeWaiter`, already called from the lifecycle cleanup callback | yes, wiring |
| 21 | `stormState()`, `setCostMultiplier()`, `pauseRebuild()`, `dirtyEntries()`, `dropDirty()`, `pollTicks(pid)` | Spec 2, 6, 9, 10 | `src/kernel/storage/**` and `src/kernel/io/**` | yes, created |
| 22 | `open`, `close`, `read`, `write`, `seek` | Sim spec 14.3 | WP-10 and WP-11 territory; preconditions are paths, descriptors and inode rights | correctly out |

**Eight grant defects: D1 to D8.**

### Corrections made, WP-09

All in the new `### Scope correction, 2026-09-13` section.

- D1: grants `config.ts` additively and tables all eleven keys with defaults and
  sources. States that where the sim spec gives no default (`maxPending`,
  `rebuildProgressInterval`) the agent chooses, comments and reports rather than
  inventing silently. States that the fractional geometry constants stay in
  `geometry.ts` and `costModel.ts` because `config.ts` validates integers only, and
  that `dmaCycleStealRatio` uses the bounded-fraction check that already validates
  `defaultSerialFraction`.
- D2: snapshot save and restore through `installHooks({ snapshots })`, both slots
  returned from one `saveState`, commit-closure restore, no hard-coded slot key,
  duplicate ownership rejected. Also corrects spec 12: the `io` slot exists, so the
  I/O half goes there and no amendment is raised.
- D3: grants exactly the subcommands the four drivers own, routed into each
  driver's `control`, `EINVAL` on anything unknown, the existing `tlb_flush` case
  untouched, under the marker already on that branch. The argument-shape conflict
  between sim spec 14.3 and the existing branch is named as a report item for
  WP-11, not something WP-09 resolves.
- D4: grants the `sync` branch for the cache-flush half only, with a WP-11
  validation marker and a WP-10 marker for the journal half.
- D5: binds the live disk and device arrays in the existing initialisation helper
  and rebinds after a restore commit.
- D6: registers `StorageHooks.expireTimers` in phase 1 and restates the phase
  discipline.
- D7: written as an escalation to raise before starting, not a widening, because
  the numerator is accumulated inside a phase body and computed in
  `scheduler/metrics.ts`. Interim instruction: expose the overhead count from
  `IoSubsystem`, leave
  `// TODO(astra): blocked on kernel overhead accounting, see report`, report it.
- D8: construction wiring stated explicitly, including both streams.
- Both WP-05 warnings are stated: snapshot-only registration for the round-trip
  test, and generic dispatch not finishing WP-11's workload persistence.
- WP-07's territory is named, including the bounded buffer that `circular`
  buffering imports and must not edit.

### Internal inconsistencies found, WP-09

1. **Acceptance count.** "Report back" item 1 asks for "each of the twenty-two
   acceptance criteria", and the numbered list runs to 23. The agent should answer
   all 23.
2. **Two paths marked unrecorded that the spec publishes.** The disk scheduling
   test table gives `DISK-CSCAN-2` and `DISK-CLOOK-2` as "(recorded)", and report
   item 4 says "the sim spec gives totals but not paths for those two". Sim spec
   16.9 gives both paths: `53,37,14,0,199,183,124,122,98,67,65` for `DISK-CSCAN-2`
   and `53,37,14,183,124,122,98,67,65` for `DISK-CLOOK-2`. They are published
   fixtures and must be asserted, not recorded at implementation.
3. **The `io` slot claim is stale.** Spec 12 says "`SubsystemSnapshots` has no
   separate `io` slot" and tells the agent to raise an amendment if one is needed.
   Amendment 3 added it, along with a compile-time check that every `SubsystemId`
   has a slot. Corrected in the scope correction.
4. **A prerequisite that names code which does not exist.** "Prerequisites" says
   WP-06's major-fault path calls `this.storage.enqueue(...)` behind a marker. No
   `enqueue` appears anywhere in the staged source, `StorageHooks` carries only
   `expireTimers`, and the fault extension point WP-05 actually left is
   `DemandPagingHooks.fault`, installed with `setDemandPaging`. Corrected in the
   `Inherited from WP-05` section.
5. **Terminal package number.** Spec 7 credits `poll%` to WP-15 while WP-07 spec 4
   credits `spin%` to WP-16. Documentation fix.

---

## Things I could not verify, stated rather than guessed

- `src/kernel/memory/FrameTable.ts`, `src/kernel/process/ipc.ts`,
  `src/kernel/rngStreams.ts` and `src/kernel/scheduler/**` were not in the staged
  tree. `FrameTable.free(frame, true)`, `reclaim(space, page)`,
  `unpinnedFrames()` and `framesOf(space)` are quoted from the WP-05 report and
  from the two call sites visible in `MemorySubsystem.ts`, not from `FrameTable.ts`
  itself.
- The accessor that exposes `SharedRegion.value` to the race detector is not quoted
  in the WP-05 report and `ipc.ts` was not staged. The WP-07 section says to read it
  through the kernel's public `ipc` manager and to report the exact accessor used,
  rather than naming one here.
- The exact stream names in the RNG registry come from sim spec 1.2.5 as quoted in
  WP-11 section 5, and from the two live calls in `Kernel.ts` that take the
  `process` and `scheduler` streams. `rngStreams.ts` was not staged.
- Sim spec 11.2 names `maxPending` and sim spec 10.6 names
  `rebuildProgressInterval` without defaults. Both are marked "report it" rather
  than given a number.

## What WP-06 and WP-11 received

WP-06: the verbatim `DemandPagingHooks` interface, `setDemandPaging`, `loadPage`,
`reclaim`, `shootdown`, `unpinnedFrames`, `context(rng, futureReferences, space?)`
and the local versus global scope rule, the retained free-pool semantics, the
ordering trap around the major-fault event, the fault ownership decision in full,
the six `MemoryMetrics` fields left at zero, and `setFramePolicy`.

WP-11: the two invariant exceptions, the stale guard message and why it now
misnames the problem, the `ioctl` marker and the single-subcommand state of that
branch plus the argument-shape conflict, the rations final-floor decision with the
fixture values that match it, the ten slots with the compile-time exhaustiveness
check and the two typed promotions, and the snapshot registration contract.

---

## Reviewer corrections, applied before commit

Two of the audit's findings were changed on review. Both are recorded here so the
audit and the packages agree.

**WP-07 D1 is four branches, not six.** The audit inferred `request` and
`release` into WP-07's grant from sim spec 14.3. That was wrong: every one of their
four `deadlockStrategy` paths operates on the `ResourceType` table, and WP-08 owns
that table outright (`src/kernel/deadlock/resources.ts`). The audit's own "report,
do not widen" note about the table having no owner was the clue: it has no owner
yet because its owner has not started. WP-07's scope correction now says so and
grants only `sem_wait`, `sem_post`, `mutex_lock` and `mutex_unlock`. The defect
count stays at seven; D1 is narrower.

**WP-09 D7 is a one-line accessor, not an escalation.** The audit concluded that
charging interrupt overhead to the kernel needed a change inside phase 8 and in
`scheduler/metrics.ts`. `Kernel.ts` already has the channel: a private
`switchDebt` counter consumed at the top of the phase 8 execute path, persisted by
`snapshot()` and `restore()`, and confirmed by the WP-05 report to be excluded from
useful service. A `chargeKernelDebt(ticks)` method outside every phase body, adding
to that counter, gives the `utilisation falls` behaviour with no phase edit. WP-09's
scope correction now gives that instruction, with escalation reserved for the case
where the metrics arithmetic turns out not to move.

**Three spec corrections made alongside.** Sim spec 8.1 numbered mutual exclusion
I-20 and 8.7 numbered bounded-buffer occupancy I-21; section 15, the canonical
list, has I-20 as free-list ordering (which the kernel already asserts under that
number), I-21 as mutual exclusion and I-22 as bounded-buffer occupancy. Both
prose sections are corrected to match section 15. And the `SYNC-PHIL-NAIVE` row
in 16.7 now says it requires WP-08, since it asserts `deadlock.detected` and
WP-07 is forbidden from emitting that event.

**Two remaining documentation nits, left for whoever next touches the files.**
The `SYNC-MONITOR-BROKEN`, `SYNC-CAS-BOUNDED` and `SYNC-BB-UNBALANCED` scenarios
appear in sim spec 8 prose but not in the 16.7 appendix, so nothing enforces that
they survive. And WP-09's prerequisites once named a `this.storage.enqueue(...)`
call that never existed; the audit's `Inherited from WP-05` section supersedes it,
but the stale sentence is still in the package body.

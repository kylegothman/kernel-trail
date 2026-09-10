# KERNEL TRAIL: phase 1 engine build order

Twenty work packages. Read `00-ASTRA-BRIEFING.md` first, once, then
`00-PACKAGE-INDEX.md` for the whole set at a glance, then take packages in wave
order.

Size is relative effort, not hours: S is a focused morning, M is a day, L is a
couple of days, XL is one of the largest packages in the phase.

WP-19 and WP-20 are the last two engine packages and together they are the gate
on all fourteen leg packages. WP-19 is the system that plays a leg. WP-20 is the
harness that proves one runs. No leg agent may start before both have reported
done.

---

## Scaffold reconciliation

A scaffold already exists and passes 83 tests. Where a package's file list names a
path that the scaffold has already used, **keep the scaffold's path** and note the
difference in your report. Do not create a second file at the other path.

| Already present | What it is |
|---|---|
| `src/kernel/types.ts` | frozen contract |
| `src/game/types.ts` | frozen contract |
| `src/kernel/rng.ts` | the sfc32 generator. WP-01 names `src/kernel/rng/Sfc32Rng.ts`; keep `rng.ts`. |
| `src/kernel/EventBus.ts` | the event bus |
| `src/kernel/Kernel.ts` | step order plus the invariant checks |
| `src/kernel/scheduler/FCFS.ts` | the reference scheduler. WP-03 names `fcfs.ts`; keep `FCFS.ts`. |
| `src/kernel/scheduler/SchedulerRegistry.ts` | the registry. WP-03 names `registry.ts`; keep `SchedulerRegistry.ts`. |
| `src/kernel/scheduler/common.ts` | the shared scheduler helpers. WP-03's `SchedulerBase.ts` and `tieBreak.ts` extend or absorb it. |
| `src/game/store.ts` | the typed observable store, passing |
| `src/game/save.ts` | save, load and checksum, passing |
| `src/app/loop.ts` | the game loop |
| `src/legs/registry.ts`, `src/legs/legs.d.ts` | the leg id to dynamic import map |
| `src/main.ts` | the entry point |
| `tests/kernel/rng.test.ts`, `determinism.test.ts`, `boundaries.test.ts`, `scheduler.fcfs.test.ts` | the existing suite |

Packages whose wording says "create" for one of these files should read "complete
and verify". A package that finds a scaffold file already correct says so and
moves on; a package that finds it wrong fixes it and reports every changed line.

`src/design/`, `src/platform/`, `src/render/`, `src/world/`, `src/ui/`,
`src/terminal/` and `src/audio/` do not exist yet. If a scaffold file appears at
one of the paths WP-12, WP-13 or WP-14 names, the same rule applies.

---

## Citation corrections

Three section citations in the frozen types do not match the 10th edition. **The
frozen files stay exactly as they are.** Use the corrected numbers in every piece
of content a package generates: man pages, codex prose, event rationale strings,
`SafetyTraceStep.explanation`, and any `ChapterRef` constructed in code.

| Location | Cited there | Correct | Owning packages |
|---|---|---|---|
| pace to quantum, design brief | 5.3.4 | **5.3.3** | WP-04, WP-15, WP-17, WP-19 |
| `SafetyCheckResult.sequence` | 8.6.2 | **8.6.1** | WP-08, WP-15, WP-17 |
| `DeadlockReport.cycle` | 8.3.2 | **8.7.1** | WP-08, WP-14, WP-15, WP-17 |

The narrative bible's affliction table in section 7.1 prints 5.3.4 in four
chapter cells for the same reason. WP-19 transcribes that table and uses 5.3.3 in
all four.

`ProcessControlBlock.priority` citing 5.3.4 for "lower number is higher priority"
is correct and stays.

---

## The table

| WP | Title | Depends on | Size | Owns (nothing else may write here) |
|---|---|---|---|---|
| WP-01 | RNG, event bus and the determinism fixtures | none | M | `src/kernel/rng*`, `src/kernel/EventBus.ts`, `src/kernel/errors.ts`, `tests/kernel/canonical.ts` |
| WP-02 | Processes, threads and the kernel step order | WP-01 | XL | `src/kernel/process/`, `src/kernel/Kernel.ts`, `src/kernel/config.ts`, `src/kernel/index.ts` |
| WP-03 | Scheduler foundation and the four single-queue policies | WP-02 | L | `src/kernel/scheduler/` (registry, base, fcfs, sjf, srtf, priority, metrics, starvation) |
| WP-04 | Aging, round robin, MLFQ and the Gantt golden files | WP-03 | L | `src/kernel/scheduler/priorityAging.ts`, `rr.ts`, `mlfq.ts`, `tests/kernel/golden/` |
| WP-05 | Main memory: allocation, paging and the TLB | WP-02 | L | `src/kernel/memory/` (frames, allocators, pageTable, tlb, translate) |
| WP-06 | Virtual memory: demand paging and six replacement policies | WP-05 | L | `src/kernel/memory/replacement/`, `demandPaging.ts`, `workingSet.ts`, `thrashing.ts`, `locality.ts` |
| WP-07 | Synchronisation primitives and the race detector | WP-02 | L | `src/kernel/sync/` |
| WP-08 | Deadlock: wait-for graph, Banker's, detection, recovery | WP-07 | L | `src/kernel/deadlock/` |
| WP-09 | Mass storage and I/O | WP-02 | L | `src/kernel/storage/`, `src/kernel/io/` |
| WP-10 | File system and protection | WP-02, WP-09 | L | `src/kernel/fs/`, `src/kernel/security/` |
| WP-11 | Syscalls, snapshot/restore and the invariant set | WP-02 through WP-10 | XL | `src/kernel/syscall/`, `src/kernel/invariants.ts`, `src/kernel/snapshot.ts` |
| WP-12 | Renderer backend, post chain and design tokens | none | XL | `src/design/`, `src/platform/`, `src/render/backend/`, `materials/`, `post/`, `shaders/`, `targets.ts`, `DrawCallBudget.ts` |
| WP-13 | The focus camera and the diegetic structure base classes | WP-12 | L | `src/render/camera/`, `src/world/contracts.ts`, `structures/base/`, `instancing/`, `forms/`, `labels/` |
| WP-14 | World event router, effect pooling and the derezz effect | WP-01, WP-13 | L | `src/world/WorldEventRouter.ts`, `FrameEventQueue.ts`, `AnimationBudget.ts`, `domains/`, `effects/`, `src/render/derezz/` |
| WP-15 | The terminal | WP-11, WP-12 | L | `src/terminal/` |
| WP-16 | The procedural audio engine | WP-01, WP-12 | L | `src/audio/` |
| WP-17 | HUD, codex and save/load | WP-11, WP-12 | XL | `src/ui/`, `src/game/save*`, `src/game/store*`, `CommandBus.ts`, `scoring.ts` |
| WP-18 | The counterfactual replay worker | WP-11, WP-17 | L | `src/game/replay/`, `src/game/workers/` |
| WP-19 | The leg runner, the travel loop and the crossing system | WP-11, WP-17, WP-18 | XL | `src/game/LegRunner.ts`, `RunDirector.ts`, `LegSandbox.ts`, `debrief.ts`, `travel/`, `afflictions/`, `convoy/`, `events/`, `crossing/`, `depot/`, `reclamation/` |
| WP-20 | The headless smoke-test harness and the golden runs | WP-19 | L | `tests/legs/harness/`, `tests/legs/smoke.test.ts`, `goldens.test.ts`, `journey.test.ts`, `tools/golden/`, `tools/ci/` |

---

## Concurrency waves

A wave starts only when every package in the previous wave has reported done and
its tests are green on the shared branch.

### Wave 0, two agents

| WP | Why it can start immediately |
|---|---|
| WP-01 | Depends only on `src/kernel/types.ts`, which is frozen and already present. |
| WP-12 | Depends on nothing. `src/design` is a leaf module. |

WP-12 is the larger of the two and it blocks four later packages, so start it
first if only one agent is free.

### Wave 1, two agents

| WP | Waiting on |
|---|---|
| WP-02 | WP-01 for `Rng`, the event bus and the canonical serialiser. |
| WP-13 | WP-12 for tokens, the quality profile, the backend and the materials. |

WP-02 is the critical path. It is the largest kernel package and five wave-2
packages block on it, so it should get the strongest agent and it should not be
batched with anything else.

### Wave 2, six agents

| WP | Waiting on | Territory conflict risk |
|---|---|---|
| WP-03 | WP-02 | none, owns `src/kernel/scheduler/` alone |
| WP-05 | WP-02 | none, owns `src/kernel/memory/` alone |
| WP-07 | WP-02 | none, owns `src/kernel/sync/` alone |
| WP-09 | WP-02 | none, owns `src/kernel/storage/` and `src/kernel/io/` |
| WP-14 | WP-13 | none, owns the world router, effects and derezz |
| WP-16 | WP-01, WP-12 | none, owns `src/audio/` alone |

All four kernel packages in this wave read `src/kernel/Kernel.ts` and none of them
rewrites it. Each wires the subsystem hook WP-02 left for it and changes nothing
else in that file. If two packages find they both want to edit `Kernel.ts` beyond
their named hook, that is a specification bug: report it rather than merging by
hand.

WP-16 registers its audio consumer against WP-14's `FrameEventQueue` if that has
landed, and against a local queue with the same interface if it has not.

### Wave 3, four agents

| WP | Waiting on |
|---|---|
| WP-04 | WP-03 for `SchedulerBase`, the metrics module and the registry |
| WP-06 | WP-05 for the frame table, page tables and the TLB |
| WP-08 | WP-07 for the wait queues that feed the wait-for graph |
| WP-10 | WP-09 for the block device the file system sits on |

WP-06's locality-model change shifts every determinism hash, so it must land
before WP-11 begins and its `DET-D1`, `DET-D3` and `DET-D4` re-run must be green.

### Wave 4, one agent

WP-11 alone. It touches every subsystem's snapshot contribution and every
subsystem's invariants, so it cannot run beside anything that is still changing
kernel state. This is the integration package and it is where cross-subsystem
determinism bugs surface. It should end with zero `TODO(astra)` markers anywhere
under `src/kernel/`.

### Wave 5, two agents

| WP | Waiting on |
|---|---|
| WP-15 | WP-11, because every command reads or writes real simulator state through the syscall table and the read accessors |
| WP-17 | WP-11 for `snapshot()` and `restore()`, and WP-12 for the tokens |

### Wave 6, one agent

WP-18 alone. It needs WP-11's snapshot and WP-17's save schema and debrief card.

### Wave 7, one agent

WP-19 alone. It assembles every game-layer system into the thing that plays a
leg, so it cannot run beside anything that is still changing run state or the
save schema. It is the largest game-layer package in the project and it is the
gate on all fourteen legs, so it should get the strongest available agent and it
should not be batched with anything else.

### Wave 8, one agent

WP-20 alone. It drives WP-19 and it cannot be written against a moving runner.
When it reports done, the leg build order in `00-LEG-BUILD-ORDER.md` opens.

---

## What is deliberately not in phase 1

- Any leg module. `src/legs/registry.ts` exists in the scaffold; leave it alone.
  WP-18 ships `headlessLegs.ts` with fourteen throwing stubs and one synthetic
  test leg, and WP-20 ships a second synthetic leg for the harness's own suite.
  Neither is content.
- Any named diegetic structure. WP-13 registers `FrameVault`,
  `ReadyQueueProcession`, `WaitForRing`, `PlatterStack`, `PageOcean`, `BusSpine`,
  `ArchiveShelves` and `DomainRings` as throwing factories; phase 2 implements
  them.
- Codex prose and man page text authored here. WP-15 sources every man page from
  `05-CURRICULUM-MAP.md` and WP-17 builds the codex machinery with no entry
  content.
- Scoring balance. WP-17 implements `scoring.ts` against `ScoreBreakdown` with
  placeholder weights marked `// TODO(astra):` and a test asserting only
  monotonicity.
- Per-leg music, sound, colour accents or hero visuals.

---

## Reporting

Every package's completion report states, at minimum:

1. Which acceptance criteria passed, by number.
2. The output of `npm run typecheck`, `npm run test` and `npm run build`.
3. Every `// TODO(astra):` left in the tree from this package, with its file and
   line.
4. Every value recorded rather than asserted from the sim spec's test vector
   appendix, with the value that was frozen.
5. Any place the specification was ambiguous, and which reading was taken.
6. Any frozen contract that the package wanted to change, per the escalation
   procedure in the briefing.
7. For render-layer packages, every Three.js API checked against `node_modules`
   before use.
8. Every scaffold path kept in preference to the path the package named.

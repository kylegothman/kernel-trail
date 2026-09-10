# KERNEL TRAIL: leg build order

Fourteen leg packages, `WP-L00` through `WP-L13`. Read `00-ASTRA-BRIEFING.md` first, once, then
`00-PACKAGE-INDEX.md`, then `00-BUILD-ORDER.md` for the twenty engine packages this document sits
on top of.

Size is relative effort, not hours: **S** is a focused morning, **M** is a day, **L** is a couple
of days, **XL** is one of the largest packages in the project.

---

## The one thing to understand before reading the table

**Legs are file-independent by design.** Every leg package owns a directory under `src/legs/`
and a directory under `tests/legs/`, writes nowhere else, and imports from no other leg at any
depth. There is no shared leg file, no leg base class, no leg registry entry a leg writes, and no
ordering constraint that comes from source control. Fourteen agents can hold fourteen legs at the
same time and never touch each other's files.

**The only real constraint is engine readiness.** A leg cannot start until the kernel subsystems
it enables are complete and their fixtures are green, and until the shared leg infrastructure
exists. That is what the table below is for.

There is a second, much weaker constraint, and it is worth naming so nobody mistakes it for a
file dependency: **five legs read a `DecisionRecord` another leg wrote.** Those reads go through
`RunState.decisions`, which is game-layer state, not through an import. Every one of the five
packages specifies a default for when the record is absent, so a leg built out of order still
compiles, still passes its own tests, and still runs headlessly. What it cannot do is exercise
the cross-leg path. See The five hand-offs.

---

## The two packages that gate every leg

Every leg package names two engine packages that used to have no owner: the thing that plays a
leg, and the thing that proves one runs headlessly. Both now exist.

**WP-19, the leg runner, the travel loop and the crossing system.** It calls `Leg.populate()` and
`Leg.evaluate()`, advances `legProgress` and charges cycles and quota per segment, applies pace
and rations as scheduler quantum and frames per Program, controls the degree of multiprogramming,
ticks afflictions, draws from `Leg.eventTable`, runs the nine critical section crossings with
their shared contention formula and four options, runs the depots and the reclamation rounds,
derezzes Programs, and produces the `DebriefCard`. **A leg package that finds itself implementing
a travel loop or a crossing cost formula has been mis-scoped: stop and escalate.**

**WP-20, the headless smoke-test harness and the golden runs.** Every leg package's acceptance
criterion 2 is "runs headlessly to completion via the smoke-test harness". WP-20 is that harness.
It also defines the known-good and known-bad fixture contract that every leg supplies, and the
fourteen-leg journey determinism test.

Both are in `00-BUILD-ORDER.md` as waves 7 and 8. **No leg starts until WP-20 has reported done.**

One piece of infrastructure is still owed and it is not a leg's to build either. WP-13 registers
`FrameVault`, `ReadyQueueProcession`, `WaitForRing`, `PlatterStack`, `PageOcean`, `BusSpine`,
`ArchiveShelves` and `DomainRings` as throwing factories. Eight names for fourteen legs, so six
legs need a structure that has no registered factory at all. Reconcile that list against the
fourteen legs' `anchor.*` tables before the first leg starts, and add the missing factories to
the phase-2 structure scope.

Three shared channels are also better solved once than four times: the per-leg opaque save slot
that WP-L13's guest kernel snapshot needs, and the device, volume and matrix manifest channels
that WP-L10, WP-L11 and WP-L12 need. All four are the same shape of problem. Settle them with
WP-19 rather than in four leg packages.

Every package in this document names its prerequisites with the canonical `WP-01` through `WP-20`
numbering from `00-BUILD-ORDER.md`. The layered alias scheme that six of the leg packages once
used for kernel, game and render prerequisites has been removed from every leg package and no
longer appears anywhere in the set, so there is no mapping table to check any more.

---

## The table

Kernel subsystems are the exact contents of each leg's `enabledSubsystems`. A leg cannot start
until every subsystem it enables is complete and its fixtures are green.

| # | Leg id | Package | Engine prerequisites | Kernel subsystems | Size |
|---|---|---|---|---|---|
| 0 | `boot_sector` | WP-L00 | WP-01, WP-02, WP-03, WP-11, WP-12, WP-13, WP-14, WP-15, WP-17 | `process`, `scheduler` | **L** |
| 1 | `fork_fields` | WP-L01 | WP-01, WP-02 (all of it: `fork`, `exec`, `wait`, `exit`, zombies, reparenting, the 16-slot table, IPC), WP-03, WP-11, WP-12, WP-13, WP-14, WP-15, WP-17 | `process`, `scheduler` | **M** |
| 2 | `the_weave` | WP-L02 | WP-01, WP-02 (including the thread layer and Amdahl), WP-03, WP-11, WP-12, WP-13, WP-14, WP-15, WP-17 | `process`, `scheduler` | **M** |
| 3 | `quantum_pass` | WP-L03 | WP-01, WP-02, **WP-03 and WP-04 complete and frozen, all seven policies**, WP-11, WP-12, WP-13, WP-14, WP-15, WP-17, **WP-18** (first consumer) | `process`, `scheduler` | **L** |
| 4 | `the_narrows` | WP-L04 | WP-01, WP-02, WP-03, **WP-07 complete**, WP-11, WP-12, WP-13, WP-14, WP-15, WP-17 | `process`, `scheduler`, `sync` | **L** |
| 5 | `the_cistern` | WP-L05 | WP-01, WP-02, WP-03, **WP-07 complete**, WP-11, WP-12, WP-13, WP-14, WP-15, WP-17 | `process`, `scheduler`, `sync`, `deadlock` | **L** |
| 6 | `the_gridlock` | WP-L06 | WP-01, WP-02, WP-03, WP-04, WP-07, **WP-08 in full**, WP-11, WP-12, WP-13, WP-14, WP-15, WP-17, WP-18 | `process`, `scheduler`, `sync`, `deadlock` | **XL** |
| 7 | `allocation_yards` | WP-L07 | WP-01, WP-02, WP-03, WP-04, **WP-05 in full**, WP-11, WP-12, WP-13, WP-14, WP-15, WP-17, WP-18 | `process`, `scheduler`, `memory` | **L** |
| 8 | `drowned_reach` | WP-L08 | WP-01, WP-02, WP-03, WP-04, WP-05, **WP-06 in full**, WP-11, WP-12, WP-13, WP-14, WP-15, WP-17, WP-18 | `process`, `scheduler`, `memory`, `vm` | **XL** |
| 9 | `the_platters` | WP-L09 | WP-01, WP-02, WP-03, WP-04, WP-05, WP-06, **WP-09 storage half in full**, WP-11, WP-12, WP-13, WP-14, WP-15, **WP-17 including the convoy mutation interface**, WP-18 | `process`, `scheduler`, `memory`, `vm`, `storage` | **L** |
| 10 | `the_bus` | WP-L10 | WP-01, WP-02, WP-03, WP-04, **WP-09 I/O half in full**, WP-11, WP-12, WP-13, WP-14, WP-15, WP-17, WP-18 | `process`, `scheduler`, `io` | **L** |
| 11 | `the_archive` | WP-L11 | WP-01, WP-02, WP-03, WP-04, WP-07, WP-09, **WP-10 file system half in full**, WP-11, WP-12, WP-13, WP-14, WP-15, WP-17, WP-18 | `process`, `scheduler`, `storage`, `fs` | **XL** |
| 12 | `arbiter_wall` | WP-L12 | WP-01, WP-02, WP-03, WP-04, WP-05, WP-09, **WP-10 protection and security half in full**, **WP-11 including argument validation**, WP-12, WP-13, WP-14, WP-15, WP-17, WP-18 | `process`, `scheduler`, `memory`, `fs`, `security` | **L** |
| 13 | `the_portal` | WP-L13 | **All twenty.** WP-11's `snapshot()` and `restore()` and WP-17's report handoff are the two that gate it hardest. | `process`, `scheduler`, `memory`, `vm`, `io`, `security` | **XL** |

Every row also requires WP-19 and WP-20 and the phase-2 named structures. They are omitted from
each row because they are universal: no leg runs without the runner and no leg's acceptance
criteria can be evaluated without the harness.

### Subsystem-to-package gate, restated as a lookup

| Subsystem | Gated by | Legs that enable it |
|---|---|---|
| `process` | WP-02 | all fourteen |
| `scheduler` | WP-03, and WP-04 for legs 3 and later | all fourteen |
| `sync` | WP-07 | 4, 5, 6 |
| `deadlock` | WP-08 | 5, 6 |
| `memory` | WP-05 | 7, 8, 9, 12, 13 |
| `vm` | WP-06 | 8, 9, 13 |
| `storage` | WP-09 storage half | 9, 11 |
| `io` | WP-09 I/O half | 10, 13 |
| `fs` | WP-10 file system half | 11, 12 |
| `security` | WP-10 protection half | 12, 13 |

Leg 5 enables `deadlock` with `deadlockStrategy: 'ignore'` and needs WP-08 present even though it
reports nothing, because the leg's own evaluation polls `detectDeadlock()` to prove the ring
closed. A leg 5 built against a stubbed WP-08 will pass its own tests and fail its most important
acceptance criterion.

Leg 12 lists `fs` without `storage`. If WP-10's file system half cannot be constructed without
`storage`, WP-L12 says to add it and freeze `diskPolicy` and `totalCylinders`. The same escape
hatch is written into WP-L10 for the reverse case. Resolve both when WP-09 and WP-10 land, and
record the answer here.

---

## The five hand-offs

These are the only cross-leg couplings in the project. All five go through `RunState.decisions`
as a `DecisionRecord`, all five have a specified default when the record is absent, and none of
them is an import.

| # | Producer | Record | Consumer | What the consumer does with it | Default when absent |
|---|---|---|---|---|---|
| 1 | leg 5 `the_cistern` | `kind: 'ring_closed'`, `choice: String(tick)` | leg 6 `the_gridlock` | The opening card names the Cistern ring by tick number. | The opening card omits the tick; the player broke the ring. |
| 2 | leg 7 `allocation_yards` | `kind: 'executable_bit'`, `choice: 'left_set' \| 'cleared'`, `outcome: 'pending'` | leg 12 `arbiter_wall` | Decides whether the leg opens compromised. Leg 12 resolves the record's `outcome` to `good`, `costly` or `fatal`. | `'cleared'`. The leg opens clean. |
| 3 | leg 10 `the_bus` | `kind: 'device_attach'`, `choice: 'block' \| 'character' \| 'network'` | leg 11 `the_archive` | A block attach on a stream device opens leg 11 with one file's contents wrong. | Open clean. |
| 4 | leg 11 `the_archive` | `kind: 'crash_outcome'` and `kind: 'manifest_integrity'` | leg 12 `arbiter_wall` | Decides whether the manifest signed at the wall is already the wrong document. | `'intact'`. |
| 5 | leg 12 `arbiter_wall` | `kind: 'escalation_outcome'` and `kind: 'privilege_excess'` | leg 13 `the_portal` | The container threat model, and the `correctness` rollup input. | `'all_blocked'` and an excess of 0. |

Hand-off 2 is the longest causal chain in the game: five legs and roughly forty minutes between
the decision and its consequence. It is also the only one where the consumer writes back to the
producer's record. That write goes through WP-17's decision interface, never by assignment.

**Build the producer before the consumer wherever you can.** It costs nothing in the schedule and
it means the consumer's cross-leg tests exercise a real record rather than a synthetic one. The
concurrency plan below is ordered to satisfy all five.

### Codex cross-links, which are not hand-offs

Six pairs of legs register cross-links into each other's codex entries. These are registry
writes at leg load rather than run state, they are symmetric, and each package specifies which
side registers first and what to do if the other side has not shipped. They constrain nothing.

| Pair | Entries |
|---|---|
| 5 and 6, 5 and 10 | `codex.dining_philosophers` |
| 3 and 9 | `codex.priority_starvation` and `codex.seek_starvation` |
| 7 and 11 | `codex.fragmentation` and `codex.allocation_methods` |
| 10 and 11 | `codex.io_buffering` and `codex.journaling` |
| 0, 7, 11 and 12 | `codex.protection_rings`, `codex.access_matrix`, `codex.code_injection` |
| 12 and 13, plus all thirteen plants | `codex.trap_and_emulate`, `codex.virtualization` |

The last row is the largest: `codex.virtualization` cross-links to thirteen entries, one per
foreshadowing plant, and WP-L13 registers all thirteen back-links. Any leg that has not shipped
when leg 13 is built leaves a pending link, which WP-L13's report enumerates.

---

## Recommended concurrency plan

Four waves. A wave starts when every engine package it names has reported done and is green on
the shared branch, and when the previous wave's hand-off producers have landed.

Each wave is sized for four agents, which is the point at which the shared branch stops being a
merge problem for a project where nobody shares a file.

### Wave 0, before any leg: the engine gate

WP-19 and WP-20, in that order, one agent each. They run as engine waves 7 and 8 in
`00-BUILD-ORDER.md` and they are the gate on everything below.

- **WP-19**, the leg runner: `populate` and `evaluate` invocation, the travel loop, the event
  deck draw cadence plus the emergency preemption credit, the critical section crossing system
  with its contention formula and four options, the depots, reclamation, and the debrief.
- **WP-20**, the headless smoke-test harness, the golden runs and the fixture contract every leg
  supplies.

What still has to be settled alongside them, and is nobody's leg to build:

- The phase-2 named diegetic structures, reconciled against all fourteen legs' anchor tables.
- The per-leg opaque save slot that WP-L13's guest kernel snapshot needs, and the manifest
  channels that WP-L10, WP-L11 and WP-L12 need (device manifest, volume manifest, matrix
  manifest). All four are the same shape of problem and should be solved once, with WP-19,
  rather than four times in four leg packages.

Nothing in wave 0 is leg content.

### Wave A, four agents

| Leg | Why it goes first |
|---|---|
| `boot_sector` | Settles the leg skeleton conventions every other package copies: the module layout, the inert-field test, the manual-string fixture, the golden playthrough shape. Build it first even though it is not the largest. |
| `quantum_pass` | WP-18's first consumer. The counterfactual replay interface is negotiated here and five later legs use it. |
| `the_narrows` | The crossing system's first leg-side consumer, with three of the nine crossings. Settles that interface for legs 5, 6, 11 and 12. |
| `allocation_yards` | **Hand-off 2's producer.** The `executable_bit` record has to exist before leg 12 can test its own most important path, and leg 12 is three waves away. |

Engine gate: WP-01 through WP-05, WP-07, WP-11 through WP-18.

`boot_sector` should get the first agent and should not be batched with anything else, because
every convention it settles is copied thirteen times.

### Wave B, four agents

| Leg | Why here |
|---|---|
| `fork_fields` | Nothing gates it beyond WP-02. It is here rather than in wave A only because wave A had four seats that unblocked more work. |
| `the_weave` | Same. |
| `the_cistern` | **Hand-off 1's producer.** The `ring_closed` record has to exist before the Gridlock. |
| `the_platters` | Needs WP-17's convoy mutation interface for the game's only resurrection, which is worth settling early because it is the only mechanic of its kind. |

Engine gate: adds WP-06 and WP-09's storage half.

### Wave C, four agents

| Leg | Why here |
|---|---|
| `the_gridlock` | **Hand-off 1's consumer.** Also XL, also the game's first difficulty spike, and its ring hero visual must match the Cistern's composition, which is a reason to build it after rather than beside. |
| `drowned_reach` | XL, the showpiece, and the highest-risk leg in the project. Give it the strongest agent. |
| `the_bus` | **Hand-off 3's producer.** |
| `arbiter_wall` | **Hand-off 2's consumer and hand-off 5's producer.** It can start as soon as WP-10's protection half is green and the Yards has landed. |

Engine gate: adds WP-08, WP-09's I/O half and WP-10.

Wave C is the heaviest wave: two XL packages and two L packages that both sit on freshly landed
WP-10. If only three agents are available, drop `the_bus` to wave D and accept that the Archive
tests its hand-off against a synthetic record.

### Wave D, two agents

| Leg | Why last |
|---|---|
| `the_archive` | **Hand-off 3's consumer and hand-off 4's producer.** XL, three chapters, and the game's only permanent-loss failure. |
| `the_portal` | **Hand-off 5's consumer, and the consumer of everything else.** It reads every leg's decision records, closes the score, and hands off to the end-of-run report. It also registers thirteen codex back-links, one per leg, which is only complete when every leg has shipped. Build it last and give it the time. |

Engine gate: everything.

`the_portal` can technically start earlier, and it should not. Its report handoff test asserts
that `objectivesMet` draws only from the fourteen legs' declared objective ids and that panel 4's
count plus `objectivesMet.length` is exactly 42, which is not checkable until all fourteen exist.
Its golden full run is fourteen legs end to end.

### Wave summary

| Wave | Legs | Agents | Cumulative legs done |
|---|---|---|---|
| 0 | WP-19 then WP-20, no legs | 1 each | 0 |
| A | 0, 3, 4, 7 | 4 | 4 |
| B | 1, 2, 5, 9 | 4 | 8 |
| C | 6, 8, 10, 12 | 4 | 12 |
| D | 11, 13 | 2 | 14 |

---

## What can genuinely run at the same time

The question the plan above answers conservatively, answered directly:

**If the entire engine is green, all fourteen legs can be built simultaneously.** They share no
source file. Fourteen agents on fourteen directories will never conflict, and the branch will
merge cleanly, because nothing in `src/legs/<a>/` can reference anything in `src/legs/<b>/`.

What you lose by doing that is the five hand-offs. Each consumer would test against a synthetic
`DecisionRecord` rather than one its producer actually wrote, and the six codex cross-link pairs
would each ship one registered side and one pending item. Neither is a correctness failure and
both are real integration debt: five paths and six links that no test has exercised end to end
until an integration pass runs them.

The wave plan trades three serialisation points for zero of that debt. If schedule pressure makes
the fully parallel build attractive, take it, and budget an explicit integration wave afterwards
that runs the five hand-offs and the six cross-links against real producers. Do not let the
integration wave be the golden full run in WP-L13's test suite; that suite is the check, not the
work.

**What is genuinely serial, in every plan:**

1. WP-19 and WP-20 before any leg. Nothing else is arguable.
2. WP-L13 last, or at least its golden full run last.
3. `boot_sector` before the other thirteen, if you want thirteen packages to copy one set of
   conventions rather than invent thirteen.

Everything else is preference.

---

## Shared risks worth tracking across all fourteen

**The manual-string fixtures.** Every leg copies its terminal command `manual` text byte for byte
from `05-CURRICULUM-MAP.md` and asserts it. Thirty-odd commands across fourteen legs, and the
assertion is only as good as the fixture. Extract every `manual` string from the curriculum map
into one checked-in fixture file during wave 0, generated from the document rather than
typed, and have every leg's `manuals.test.ts` read from it. Fourteen agents transcribing man
pages by hand is fourteen chances to introduce a typo into an educational game's teaching text.

**The `See also:` graph.** Every man page ends with one, and the targets cross legs freely: leg
11's `journal` sees leg 10's `devstat`, leg 12's `ring` sees leg 0's `mode`, leg 13's `guest`
sees leg 3's `sched` and leg 8's `ws`. A leg built in isolation cannot resolve a forward
reference. Each package says to register its own side and report the pending link. Collect those
reports and run one resolution pass at the end; a `See also:` that dangles in the shipped game is
a broken promise in a teaching tool.

**Command registry lifetime.** The shell grows from three commands to about thirty across the run
and no leg deregisters another leg's commands. WP-L13's acceptance criteria include a full
registry walk at leg 13 finding every command every leg introduced. Confirm the lifetime rule
with WP-15 during wave 0 rather than discovering it at leg 13.

**Document disagreements.** Four source documents, and they disagree in at least six places that
the shipped leg packages have found and resolved: the `interrupt_storm` and `stack_overflow`
affliction figures, the DMA cycle-steal ratio, the chapter 14.8 journaling citation, the
`inode --walk` off-by-one, and the three citation corrections already listed in
`00-BUILD-ORDER.md`. Every package's report-back item asks which document was followed.
**Maintain one running list of resolved disagreements** and add to it as each leg reports, so leg
fourteen is not rediscovering leg two's answer.

**Affliction numbers.** Thirteen afflictions across fourteen legs, with drain rates and fatal
thresholds in the narrative bible's section 7.1 table and, in several cases, different numbers in
the curriculum map's failure mode prose. The resolution the shipped packages take is to follow
the narrative bible, because it is the economy and affliction source of truth and its numbers are
internally consistent. Apply that rule uniformly and record every instance.

**Draw call budgets.** 220 / 450 / 900 at low, medium and high, at every leg's heaviest frame.
Fourteen legs each verifying their own budget in isolation says nothing about a frame where a
leg's structures coexist with the HUD, the terminal overlay and a derezz batch. Run one combined
pass after wave D.

---

## Reporting

Every leg package's completion report states, at minimum:

1. Which acceptance criteria passed, by number.
2. The output of `npm run typecheck`, `npm run test` and `npm run build`.
3. The golden playthrough hash and its checked-in path.
4. Every frozen fixture the package recorded rather than asserted, with the value pinned.
5. Every `// TODO(astra):` left in the tree from this package, with its file and line.
6. Every hand-off record produced or consumed, its agreed shape, and the pending item if the
   other side had not shipped.
7. Every `See also:` target that did not resolve, and every codex cross-link registered on one
   side only.
8. Every document disagreement found, what was shipped, and which document was followed.
9. Draw calls at all three quality tiers at the heaviest frame.
10. Confirmation that no file outside the owned list was created or modified, and that no frozen
    contract was edited, extended or shadowed.

A leg is not done until all three build commands exit zero, its own suite is green, and the
existing suite is still green. "The new tests pass and two old ones broke" is not done: you own
the regression.

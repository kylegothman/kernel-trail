# KERNEL TRAIL: package index

Thirty-four work packages. Twenty engine packages, `WP-01` through `WP-20`, and
fourteen leg packages, `WP-L00` through `WP-L13`. This is the front door to the
set.

---

## How to use this set

Read in this order, and stop reading at each step once you have what you need.

1. **`00-ASTRA-BRIEFING.md`, once, before any package.** It holds the frozen
   contract rule, the import boundary matrix, the determinism rules and the
   forbidden identifier list, the house style, the verification commands, the
   anti-hallucination rules and the IP constraints. Every package assumes you
   already know all of it and none of them repeats it. Do not re-read it per
   package.
2. **This file.** Find your package, read its row, and read the rows of the
   packages it depends on so you know what you are being handed and by whom.
3. **Your package, in full, before writing a line.** Its Frozen contracts section
   is authoritative: if your implementation does not compile against the text
   pasted there, your implementation is wrong. Its Files you will create section
   is the complete list of files you may add, and its Out of scope section names
   the territory that belongs to somebody else.
4. **Only the document sections your package names.** Each package's Required
   reading section gives section numbers, not documents, so you can open the
   algorithm rather than the book. The five source documents run to about a
   million words between them and no package needs more than a few percent of
   that. Reading the whole architecture spec before starting WP-05 is not
   thoroughness; it is a way to arrive at the code with a remembered interface
   instead of the written one.

Two order-of-work documents sit beside this index. `00-BUILD-ORDER.md` gives the
engine's nine concurrency waves, the scaffold reconciliation table and the three
citation corrections. `00-LEG-BUILD-ORDER.md` gives the legs' four waves, the
five cross-leg hand-offs, the six codex cross-link pairs, and the risks worth
tracking across all fourteen. Read the one that covers your package.

**Phase column.** `engine` packages build the simulator, the renderer and the
game layer and are leg-agnostic. `leg` packages build one journey leg each under
`src/legs/<leg_id>/` and touch nothing outside that directory and their own test
directory.

**Size** is relative effort, not hours: **S** is a focused morning, **M** is a
day, **L** is a couple of days, **XL** is one of the largest packages in the
project.

**Dependencies** are hard prerequisites: a package cannot start until every
package named has reported done and its tests are green on the shared branch.
Anything not connected by a dependency path can run concurrently.

---

## The engine packages

| # | Title | Phase | Depends on | Size | Objective |
|---|---|---|---|---|---|
| WP-01 | RNG, event bus and the determinism fixtures | engine | none | M | The sfc32 generator, its named fork streams, the event bus with its strictly increasing `seq`, and the canonical serialiser every determinism test hashes. |
| WP-02 | Processes, threads and the kernel step order | engine | WP-01 | XL | Real PCBs, `fork`, `exec`, `wait`, `exit`, zombies and reparenting, the thread layer, and the fixed kernel step order every subsystem hooks into. |
| WP-03 | Scheduler foundation and the four single-queue policies | engine | WP-02 | L | The scheduler registry, the shared base and tie-break rules, and FCFS, SJF, SRTF and priority reproducing the textbook Gantt charts to the tick. |
| WP-04 | Aging, round robin, MLFQ and the Gantt golden files | engine | WP-03 | L | Priority aging, round robin at any quantum, three-level MLFQ, and the ASCII Gantt renderer whose golden files make a behaviour change a reviewable diff. |
| WP-05 | Main memory: allocation, paging and the TLB | engine | WP-02 | L | A contiguous hole list with four allocation strategies beside a frame table, per-address-space page tables and an ASID-tagged TLB, with fragmentation as a computed metric. |
| WP-06 | Virtual memory: demand paging and six replacement policies | engine | WP-05 | L | Demand paging, FIFO, LRU, clock, optimal, LFU and random, the working set model, Belady's anomaly, and the thrashing detector. |
| WP-07 | Synchronisation primitives and the race detector | engine | WP-02 | L | Mutexes, counting semaphores, monitors with both signalling disciplines, read-write locks, and a race detector that reports the interleaving that caused it. |
| WP-08 | Deadlock: wait-for graph, Banker's, detection, recovery | engine | WP-07 | L | The wait-for graph and its cycle test, the Banker's safety algorithm with its trace, the four Coffman conditions as computed state, and the recovery strategies. |
| WP-09 | Mass storage and I/O | engine | WP-02 | L | Six disk scheduling policies over a real request queue, RAID levels and rebuild, and the I/O half: interrupts, polling, DMA and device queues. |
| WP-10 | File system and protection | engine | WP-02, WP-09 | L | Four file allocation methods, free-space management, the journal and its recovery, plus the access matrix, protection rings and privilege checking. |
| WP-11 | Syscalls, snapshot and the invariant set | engine | WP-02 through WP-10 | XL | The full syscall table with argument validation and errnos, exact `snapshot()` and `restore()` across every subsystem, and the invariant set that makes a violation loud. |
| WP-12 | Renderer backend, post chain and design tokens | engine | none | XL | The WebGPU and WebGL2 backends behind one interface, the post-processing chain, the material library, and the one file in the repository allowed to hold a colour literal. |
| WP-13 | The focus camera and the diegetic structure base classes | engine | WP-12 | L | The focus camera and its release behaviour, the structure contract, instancing, procedural forms and labels, with the eight named structures registered as throwing factories. |
| WP-14 | World event router, effect pooling and the derezz effect | engine | WP-01, WP-13 | L | The router that turns a kernel event stream into world reactions, the frame event queue and its coalescing, the animation budget, and the derezz effect. |
| WP-15 | The terminal | engine | WP-11, WP-12 | L | The shell, its command registry and history, `man` dispatch, and the base commands that read and write real simulator state through the syscall table. |
| WP-16 | The procedural audio engine | engine | WP-01, WP-12 | L | The synthesis graph, the kernel event to sound mapping, the music layer and the mixer, with no audio files shipping. |
| WP-17 | HUD, codex and save/load | engine | WP-11, WP-12 | XL | `RunState` and its store, the ledger, afflictions and epitaphs as data, the convoy panel and gauges, the codex machinery, the command bus, scoring, and the save format. |
| WP-18 | The counterfactual replay worker | engine | WP-11, WP-17 | L | A worker that replays a run from its seed and decision log under a different policy, which is what lets the debrief show the player the road not taken. |
| WP-19 | The leg runner, the travel loop and the crossing system | engine | WP-11, WP-17, WP-18 | XL | The system that plays a leg: travel and its charges, pace and rations as real kernel writes, the degree control, afflictions, the event deck, the nine crossings, depots, reclamation and the debrief. |
| WP-20 | The headless smoke-test harness and the golden runs | engine | WP-19 | L | Construct any leg by id, drive it headlessly with a scripted decision sequence, assert its outcome, diff it against a golden log, and prove the fourteen-leg journey is deterministic. |

**WP-19 and WP-20 are the gate on every leg.** No package below starts until
WP-20 has reported done.

---

## The leg packages

Every leg additionally requires WP-19 and WP-20, and the phase-2 named diegetic
structures. Those are omitted from each row because they are universal. The
dependency column names the engine packages that leg needs beyond the universal
set.

| # | Leg | Phase | Depends on | Size | Objective |
|---|---|---|---|---|---|
| WP-L00 | The Boot Sector, `boot_sector` | leg | WP-01, WP-02, WP-03, WP-11, WP-12, WP-13, WP-14, WP-15, WP-17 | L | Everything you want is on the other side of a trap: user mode, kernel mode, and the syscall as the only door between them. Settles the conventions the other thirteen copy. |
| WP-L01 | The Fork Fields, `fork_fields` | leg | WP-02 in full, WP-03, WP-11, WP-15, WP-17, plus the render set | M | Everything you create is yours until you collect it: `fork`, `exec`, `wait`, `exit`, zombies, reparenting and a sixteen-slot process table that fills. |
| WP-L02 | The Weave, `the_weave` | leg | WP-02 including the thread layer, WP-03, WP-11, WP-15, WP-17, plus the render set | M | Eight strands, one bridge: threads against processes, the shared address space, and Amdahl's law as a road that stops getting faster. |
| WP-L03 | Quantum Pass, `quantum_pass` | leg | WP-03 and WP-04 complete and frozen, WP-11, WP-15, WP-17, WP-18 | L | Someone has to go last: all seven scheduling policies on one pass, the first policy death, and the first consumer of the counterfactual replay. |
| WP-L04 | The Narrows, `the_narrows` | leg | WP-07 complete, WP-03, WP-11, WP-15, WP-17 | L | Two feet, one plank: the critical section, the race detector, and three of the nine crossings including the first unordered queue. |
| WP-L05 | The Cistern, `the_cistern` | leg | WP-07 complete, WP-08 present, WP-03, WP-11, WP-15, WP-17 | L | Filling, draining, and the five who cannot eat: the bounded buffer, readers and writers, and a dining philosophers ring that closes in silence one leg before deadlock is named. |
| WP-L06 | The Gridlock, `the_gridlock` | leg | WP-08 in full, WP-04, WP-07, WP-11, WP-15, WP-17, WP-18 | XL | Nothing is broken, nothing is moving: the wait-for graph, the four Coffman conditions, Banker's, and the game's first difficulty spike. |
| WP-L07 | The Allocation Yards, `allocation_yards` | leg | WP-05 in full, WP-04, WP-11, WP-15, WP-17, WP-18 | L | There is enough room and there is nowhere to stand: external fragmentation under four allocation strategies against exactly zero under paging. |
| WP-L08 | The Drowned Reach, `drowned_reach` | leg | WP-06 in full, WP-05, WP-04, WP-11, WP-15, WP-17, WP-18 | XL | The ground arrives when you step: demand paging, six replacement policies, working sets, Belady's anomaly and thrashing, crossed with no depot behind you. |
| WP-L09 | The Platters, `the_platters` | leg | WP-09 storage half in full, WP-06, WP-11, WP-15, WP-17 including convoy mutation, WP-18 | L | The arm only moves one way at a time: six disk scheduling policies, RAID and rebuild, and the game's only resurrection. |
| WP-L10 | The Bus, `the_bus` | leg | WP-09 I/O half in full, WP-04, WP-11, WP-15, WP-17, WP-18 | L | Ask once or be told: interrupts against polling, DMA, device classes, and the attachment decision the Archive inherits. |
| WP-L11 | The Archive, `the_archive` | leg | WP-10 file system half in full, WP-09, WP-07, WP-11, WP-15, WP-17, WP-18 | XL | The lights go out between the write and the write: allocation methods, free-space management, journaling, crash recovery, and the game's only permanent loss. |
| WP-L12 | The Arbiter Wall, `arbiter_wall` | leg | WP-10 protection half in full, WP-11 including argument validation, WP-05, WP-09, WP-15, WP-17, WP-18 | L | It checked the disc and the disc was wrong: the access matrix, protection rings, privilege escalation, and the consequence of a bit left set five legs ago. |
| WP-L13 | The Portal, `the_portal` | leg | all twenty engine packages | XL | It admits a machine, not a Program: trap and emulate, the guest kernel, and the run's close, reading every leg's decisions and registering thirteen codex back-links. |

---

## Reading order by role

**A kernel agent.** Briefing, this index, your package, then the sim spec
sections your package names. The sim spec's section 16 is the complete test
vector appendix and your package tells you which subsection is yours. Never
invent a test vector and never invent a textbook citation.

**A render or audio agent.** Briefing, this index, your package, then the visual
bible sections your package names. Check every Three.js API against
`node_modules/three/` before writing the call; the pin is 0.185 and your memory
of the API is not the authority.

**A game-layer agent.** Briefing, this index, your package, then the architecture
sections your package names and the narrative bible sections that hold the
numbers. The narrative bible is the source of truth for the resource economy,
pace and rations, the affliction table, depot prices, reclamation and the
crossings. Where it and the curriculum map disagree, follow the narrative bible
and record the instance.

**A leg agent.** Briefing, this index, `00-LEG-BUILD-ORDER.md`, your leg package,
then the curriculum map's entry for your leg in full and the sections of the
other three documents your package names. Your leg owns one directory under
`src/legs/` and one under `tests/legs/` and writes nowhere else. If you find
yourself implementing a travel loop, a crossing cost formula, a depot price or an
affliction drain rate, stop: that is WP-19's and you have been mis-scoped.

---

## What every package's report must contain

The full lists are in `00-BUILD-ORDER.md` and `00-LEG-BUILD-ORDER.md`. The four
items no report may omit:

1. Pass or fail for every acceptance criterion, by number.
2. The output of `npm run typecheck`, `npm run test` and `npm run build`, all
   three exiting zero.
3. Every `// TODO(astra):` left in the tree from this package, with file and
   line.
4. Any frozen contract the package wanted to change, per the escalation procedure
   in the briefing. An unreported contract edit is the single worst failure
   available in this project.

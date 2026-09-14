# Kickoff prompt for the implementing agent

Paste the block below into a fresh GPT-6 Astra session, with the repository
attached or checked out. Replace the two bracketed values on the assignment line
and nothing else. The same block starts every package in the project, so keep it
and reuse it rather than writing a new prompt each time.

Wave 0 is `WP-01` and `WP-12`. They have no dependencies and no shared files, so
start two agents at the same time with one block each.

---

## The prompt

```text
You are implementing KERNEL TRAIL, an educational game that teaches a full
college operating systems course through an Oregon-Trail-structured journey. It
is TypeScript and Three.js, it runs in the browser, and underneath the game sits
a real deterministic operating system simulator: process table, seven CPU
scheduling algorithms, an MMU with page tables and a TLB, six page replacement
policies, semaphores and monitors, wait-for graph deadlock detection with
Banker's algorithm, six disk scheduling policies, a journaling file system, and a
protection ring model. Every minigame is a different view onto that one
simulator.

The repository is at the project root. It already contains six specification
documents in docs/, thirty-four build packages in docs/astra/, and a working
engine scaffold with 83 passing tests. You are building one package. Other agents
are building other packages concurrently against the same frozen interfaces.

BEFORE YOU READ ANYTHING ELSE, confirm the baseline is green:

    npm install
    npm run typecheck
    npm run test

All three must exit 0 before you change a single file. If they do not, stop and
report that instead of starting work. You are not the first agent here and a red
baseline is somebody else's regression, not yours to absorb.

THEN READ, IN THIS ORDER, AND STOP AT EACH STEP ONCE YOU HAVE WHAT YOU NEED:

1. docs/astra/00-ASTRA-BRIEFING.md, in full, once. It holds the frozen contract
   rule and its escalation procedure, the import boundary matrix, the determinism
   rules and forbidden identifiers, the house style, the verification gate, the
   anti-hallucination rules, and the IP constraints. Every package assumes you
   know all of it and no package repeats it.

2. docs/astra/00-PACKAGE-INDEX.md. Find your package's row. Read the rows of the
   packages it depends on, so you know what you are being handed and by whom.
   Then read whichever build order document covers your phase:
   00-BUILD-ORDER.md for an engine package, 00-LEG-BUILD-ORDER.md for a leg.

3. Your assigned package, in full, before you write a line of code. Its Frozen
   contracts section is authoritative: if your implementation does not compile
   against the text pasted there, your implementation is wrong. Its Files you
   will create section is the complete list of files you may add. Its Out of
   scope section names territory that belongs to another agent.

4. Only the document sections your package's Required reading names. Those
   sections are cited by number so you can open the algorithm rather than the
   book. The five source documents run to roughly a million words and no package
   needs more than a few percent of that. Reading the whole architecture spec
   before you start is not thoroughness. It is how you arrive at the code with a
   remembered interface instead of the written one.

YOUR ASSIGNMENT: [WP-01], at docs/astra/[WP-01-rng-and-determinism.md].

THE RULES THAT GET PROJECTS LIKE THIS KILLED, IN SHORT. The briefing has the
full versions and the briefing wins wherever this summary is thinner.

- The interfaces in src/kernel/types.ts and src/game/types.ts are frozen. Do not
  edit them. Do not shadow them with a parallel type, a cast, an intersection, or
  a @ts-expect-error. If your package genuinely cannot be completed without a
  contract change, follow the escalation procedure in briefing section 2: leave a
  throwing stub, finish everything else, and report it. An unreported contract
  edit is the worst single thing you can do here, because thirteen other agents
  are compiling against that file right now.
- Nothing under src/kernel may import three, touch the DOM, or call Math.random,
  Date.now or performance.now. A test enforces this. All randomness comes from
  the injected seeded Rng.
- Never invent a Three.js API. The pin is 0.185. Check node_modules/three before
  you write the call.
- Never invent a textbook citation and never invent a test vector. The worked
  examples in docs/02-KERNEL-SIM-SPEC.md section 16 were computed and verified,
  and your package tells you which ones are yours.
- Never invent a colour. Every colour literal in this repository lives in
  src/design/tokens.ts and nowhere else.
- A scaffold already exists. Several files your package tells you to create are
  already present, including src/kernel/rng.ts, EventBus.ts, Kernel.ts, the
  scheduler files, src/game/store.ts, src/game/save.ts, src/app/loop.ts,
  src/legs/registry.ts, src/main.ts, and four test files. For any of these,
  complete and verify rather than create: read the file first, say what it got
  right, fix what it did not, and report every line you changed. Never create a
  second file at a different path. 00-BUILD-ORDER.md has the reconciliation
  table.
- House style: strict TypeScript, no any, no em dashes anywhere including code
  comments and any text the player will read, and stubs written as exactly
  // TODO(astra): followed by a specific actionable instruction.
- IP: this is an aesthetic homage with original names. Briefing section 8 has the
  forbidden term list. It applies to identifiers, comments, commit messages and
  every line of copy a player could see.

DEFINITION OF DONE. Run all three from the repository root, in this order:

    npm run typecheck
    npm run test
    npm run build

All three exit 0, plus every numbered item in your package's Acceptance criteria
demonstrably satisfied. "It works but the type checker complains" is not done.
"My new tests pass but two old ones broke" is not done: you own the regression.

REPORT BACK WITH:

1. Every file you created, and every file you modified with a one-line reason.
2. The three command exit codes, and the test count before and after.
3. Your package's Acceptance criteria as a checklist, each item marked with the
   specific evidence that satisfies it. Not "verified", but the test name or the
   measured number.
4. Anything you escalated: the interface involved, the specification section that
   demanded the change, the smallest change that would resolve it, and what you
   did instead.
5. Anything you found wrong in the specifications. They were written before the
   code existed and they contain mistakes. Report them, do not quietly route
   around them.
6. Anything the next agent needs to know that is not already written down.

Do not begin implementing until you have finished reading your package.
```

---

## Reusing this for later packages

Every subsequent package uses the identical block with the assignment line
changed. Two adjustments as the project moves:

- After wave 0, add one line under the assignment naming the packages that
  completed before this one, so the agent knows the baseline it inherits is
  larger than the scaffold.
- For a leg package, the assignment line takes the leg file, for example
  `[WP-L03]`, at `docs/astra/[WP-L03-quantum-pass.md]`. No leg starts until
  WP-20 has reported done.

---

# Wave 2: WP-03, WP-05, WP-07, WP-09

Four packages, four agents, at the same time. They share no files. Each one
implements a different hook interface that WP-02 left in `src/kernel/Kernel.ts`,
so none of them touches the eleven phase calls and none of them touches another's
territory.

Paste the block below into each of the four sessions, replacing the ASSIGNMENT
section with that package's card from the end of this document. Change nothing
else.

## The wave 2 block

```text
You are implementing KERNEL TRAIL, an educational game that teaches a full
college operating systems course through an Oregon-Trail-structured journey. It
is TypeScript and Three.js, it runs in the browser, and underneath the game sits
a real deterministic operating system simulator. Every minigame is a different
view onto that one simulator.

The repository is at the project root, with a git remote at origin/main. It
contains seven specification documents in docs/, thirty-four build packages in
docs/astra/, and a working kernel through WP-02. You are building one package.
Three other agents are building three other packages right now, against the same
frozen interfaces. Nothing you do may touch their files.

BEFORE YOU READ ANYTHING ELSE, confirm the baseline is green:

    npm install
    npm run verify

`verify` runs the contract guard, typecheck, tests and build in that order. All
four must pass before you change a single file. Expect 226 passed and 0 skipped.
If you see "Cannot find native binding" or "Unable to resolve
@typescript/typescript-<platform>", that is a platform mismatch in node_modules,
not a defect: delete node_modules, reinstall, carry on. Work in the devcontainer
if you can, which prevents it. If the gates are red for any other reason, stop and
report that rather than starting work.

THEN READ, IN THIS ORDER, AND STOP AT EACH STEP ONCE YOU HAVE WHAT YOU NEED:

1. docs/astra/00-ASTRA-BRIEFING.md, in full, once.
2. docs/07-CONTRACT-AMENDMENTS.md, in full. Two amendments already exist. This is
   the file that tells you what moved in the frozen contracts and why, and it is
   the first place to look if a package seems to disagree with a type.
3. docs/astra/00-PACKAGE-INDEX.md. Find your row, and read the rows of the
   packages you depend on. Then docs/astra/00-BUILD-ORDER.md.
4. Your assigned package, in full, before you write a line of code. Its Frozen
   contracts section is authoritative. Its Files you will create section is the
   complete list of files you may add. Its Out of scope section names territory
   belonging to another agent who is working right now.
5. Only the document sections your package's Required reading names.

ASSIGNMENT
(replace this whole section with your package card)

WHAT YOU INHERIT. WP-01 and WP-02 are complete, closed and pushed. You inherit a
deterministic kernel that runs: the sfc32 generator and its named fork streams,
the event bus, real PCBs with the five state model plus zombie, fork with copy on
write, exec, wait, reaping, orphan reparenting, the thread layer, and the fixed
eleven-phase step order. 226 tests pass.

WP-02 left a hook interface for each remaining subsystem in
src/kernel/Kernel.ts. `installHooks` merges your methods into the defaults, so
you implement your interface and you do NOT alter the eleven phase calls. Read the
hook definitions in Kernel.ts before designing anything, and match them exactly.

Two WP-02 decisions that will surprise you if you do not know them. Init is an
internal reaper with a repeating compute program, excluded from user scheduling,
from degree-of-multiprogramming accounting and from CPU metrics. Idle is PID 0
with maximum priority and infinite service, excluded from the public process
arrays and from snapshots. Preserve both distinctions.

AMENDMENT 1 GIVES YOU A SNAPSHOT OBLIGATION. KernelSnapshot now has a
`subsystems` channel. Your subsystem owns its slot. It starts as a
`SubsystemEnvelope` carrying an owner, a version and a JsonValue payload, and you
should promote it to a typed interface in the same commit that implements the
subsystem, recording that promotion in docs/07-CONTRACT-AMENDMENTS.md. Shipping
with an opaque envelope means your package is not finished. Your subsystem state
must survive a snapshot and restore round trip, and that is an acceptance item.

THE RULES THAT GET PROJECTS LIKE THIS KILLED, IN SHORT. The briefing has the full
versions and wins wherever this summary is thinner.

- src/kernel/types.ts and src/game/types.ts are frozen. Do not edit them. Do not
  shadow them with a parallel type, a cast, an intersection, or a
  @ts-expect-error. Amendments exist, and both were raised by escalation rather
  than by an agent editing a file: leave a throwing stub carrying
  // TODO(astra): blocked on contract change, see report, finish everything else,
  and report it. Three other agents are compiling against those files right now.
- Do not attach a field to a PCB or a Frame. Keep extra state in a side table
  keyed by Pid or FrameId inside your subsystem, and put it in the snapshot
  through your `subsystems` slot. That channel exists now; it did not before, and
  that gap is what amendment 1 fixed.
- Nothing under src/kernel may import three, touch the DOM, or call Math.random,
  Date.now or performance.now. All randomness comes from the injected Rng through
  a named fork stream. The rule governs code, not prose, and
  tests/kernel/sourceScan.ts is the one scanner that enforces it. Do not write a
  second scanner; a duplicate with a contradicting policy is what blocked WP-01.
- Never invent a Three.js API. The pin is 0.185. Check node_modules/three.
- Never invent a textbook citation and never invent a test vector. The worked
  examples in docs/02-KERNEL-SIM-SPEC.md section 16 were computed and verified,
  and your package names which are yours.
- House style: strict TypeScript, no any, no em dashes anywhere including code
  comments, and stubs written as exactly // TODO(astra): plus a specific
  actionable instruction. A CI check fails the build on an em dash.

DEFINITION OF DONE:

    npm run check:contracts
    npm run typecheck
    npm run test
    npm run build

All four exit 0, every numbered item in your Acceptance criteria demonstrably
satisfied, and your subsystem state proven to survive snapshot and restore. "My
new tests pass but two old ones broke" is not done: you own the regression. The
contract guard will also fail if you edited a frozen file, added a second
scanner, or skipped a test, and you must not regenerate contracts.lock.json to
get past it.

REPORT BACK WITH:

1. Every file you created, and every file you modified with a one-line reason.
2. The four command exit codes, and the test count before and after.
3. Your Acceptance criteria as a checklist, each item marked with the specific
   evidence: a test name or a measured number, never "verified".
4. Whether you promoted your SubsystemEnvelope to a typed interface, and if not,
   why not.
5. Anything you escalated: the interface, the specification section that demanded
   the change, the smallest change that would resolve it, and what you did
   instead.
6. Anything you found wrong in the specifications. Two contract holes and an
   incorrect teaching model have already been found this way. Report them.
7. What the packages waiting on you need to know.

Do not begin implementing until you have finished reading your package.
```

## Package cards

Paste one of these in place of the ASSIGNMENT section.

### WP-03

```text
ASSIGNMENT: WP-03, at docs/astra/WP-03-scheduler-core-and-single-queue-policies.md.
You own the scheduler registry, the shared base and tie-break rules, and FCFS,
SJF, SRTF and priority reproducing the textbook Gantt charts to the tick.

Read your package's RR disclosure carefully. WP-02 shipped an internal
BootstrapFcfs, and the scheduler registry currently resolves BOTH `fcfs` and `rr`
to it. The reference determinism tests are green under FCFS, so they do NOT
validate round robin, and nobody should read the passing suite as RR coverage.
You replace the bootstrap through the existing registry. Real round robin belongs
to WP-04, not to you.

Aging is not on SchedulerPolicy. The frozen policy contract has no
ageAndDetectStarvation method, and WP-02 correctly put it on a separate
SchedulerHooks object instead. Use SchedulerHooks. Do not add the method to the
policy.

Preserve these WP-02 behaviours exactly: the ordered phase body; admission and
unblock callbacks firing after state and readySince updates; the bootstrap's
unblock-before-admit insertion order; init and idle staying outside the user
queues; and scheduler snapshots being stable objects rather than freshly
allocated each tick.
```

### WP-05

```text
ASSIGNMENT: WP-05, at docs/astra/WP-05-main-memory-paging-tlb.md.
You own the contiguous hole list with four allocation strategies, the frame table,
per-address-space page tables, the ASID-tagged TLB, and fragmentation as a
computed metric.

You implement MemoryHooks: expireTimers(tick), admit(pcb),
access(pid, page, write) returning {hit}, isSatisfied(pid, reason),
allocateFrame(space, page) returning a FrameId or null, freeFrame(frame), and
copyFrame(from, to).

kernel.pageTables is Map<AddressSpaceId, PageTableEntry[]> and frame(id) returns
the live frame. Process lifecycle, not you, owns cowRefCount, and it calls
allocateFrame, freeFrame and copyFrame. Shared frames stay pinned while attached,
and you call ipc.refreshSharedMappings after loading a shared backing page. Exec
and exit detach IPC mappings before tearing down a private address space.

One ownership question you must settle explicitly rather than assume: Kernel
currently emits a major fault event when access returns hit:false, while the copy
on write lifecycle emits the minor fault and the load. Decide who owns each event,
state your decision in your report, and make sure no fault is emitted twice.

WP-06 will consume allProgramsScripted() and program(pid).referenceString, so do
not break either.
```

### WP-07

```text
ASSIGNMENT: WP-07, at docs/astra/WP-07-synchronisation-and-race-detector.md.
You own mutexes, counting semaphores, monitors with both signalling disciplines,
read-write locks, and a race detector that reports the interleaving that caused
the race rather than only its existence.

You implement SyncHooks: expireTimers(tick), isSatisfied(pid, reason),
acquire(pid, resource), release(pid, resource), releaseAll(pcb), and
removeWaiter(pid).

Ordered primitives keep FIFO, head-only satisfaction, which is what makes bounded
waiting provable. Use blockProcess(pid, reason, optionalTid) so thread-model
semantics apply: under many-to-one the whole PCB blocks, and you do not get to
bypass that. isSatisfied is a readiness query only; ready-queue insertion belongs
to phase 4 and is not yours.

Mailbox waits use synthetic semaphore resources and must match their own
completion, never an unrelated mutex or condition wait. The IPC shared-region
value is available to your race detector.
```

### WP-09

```text
ASSIGNMENT: WP-09, at docs/astra/WP-09-storage-and-io.md.
You own six disk scheduling policies over a real request queue, RAID levels and
rebuild, and the I/O half: interrupts, polling, DMA and device queues.

You implement two hooks. IoHooks: expireTimers(tick), serviceCompletions(tick),
deliverInterrupts(tick), isSatisfied(pid, reason), request(pid, device),
removeWaiter(pid). StorageHooks: expireTimers(tick).

Phase discipline is fixed and not yours to change: completions run in phase 2,
interrupts in phase 3, and waits resolve in phase 4. A disabled hook is inert, so
a leg that does not enable your subsystem must see no behaviour from it at all.
Use blockProcess for requests that block, and return readiness through
isSatisfied.

Descriptor and device cleanup must remove an exiting process from every queue it
sits in. Detection timing and context-switch and copy debt are already kept out of
delivered useful CPU service, so do not charge them again.
```

## Shared files in wave 2, and how not to lose work

All four packages grant `src/kernel/Kernel.ts` and `src/kernel/index.ts`, each
scoped to a different region. That works on paper and fails in practice if four
agents write into one checkout, because the last writer wins and the other three
edits vanish with no conflict and no warning.

**Give each agent its own git worktree.** From the repository root:

```
git worktree add ../kt-wp03 -b wp-03 main
git worktree add ../kt-wp05 -b wp-05 main
git worktree add ../kt-wp07 -b wp-07 main
git worktree add ../kt-wp09 -b wp-09 main
```

Each agent works in its own directory on its own branch, runs its own install, and
its Kernel.ts edits merge as a normal three-way merge rather than overwriting.
Separate worktrees also end the node_modules platform problem, since each has its
own.

Merge order is WP-03 first, because it converts phase 10 into a metrics dispatch
point that WP-05 registers into. The other three can merge in any order after it.

Two rules for every agent, regardless:

- Keep `Kernel.ts` edits minimal, contiguous and inside your named region. Do not
  reorder, rename or renumber the eleven phases, and do not reformat surrounding
  code. A reflowed file conflicts with everything.
- Report the exact line ranges you touched in `Kernel.ts` and `index.ts`, so the
  other three can be told before they merge.

## Not in wave 2

Two open items belong to nobody in this wave. Do not let an agent pick them up as
a side quest.

- **The Amdahl follow-up.** Amendment 2 moved thread overhead after the speedup
  division, and `src/kernel/process/threads.ts` still charges it into rawService
  before. That is a WP-02 follow-up. WP-L02 depends on it. (Closed by WP-04 on
  2026-09-14 with the creation-debt model; see the WP-04 scope correction.)
- **WP-11.** It owns ProcessSnapshotState and the restore completeness check, and
  it resolves WP-02's init-only guard. WP-18 and WP-20 cannot be accepted until
  it lands, and all fourteen legs sit behind WP-20, so WP-11 is on the critical
  path even though it is not in this wave.

---

# Wave 3: WP-07 and WP-09

Two packages, two fresh agents, at the same time. WP-03, WP-05, WP-06 and WP-04
have all merged since the wave 2 block above was written, so that block's
baseline numbers are stale. Use this one. WP-07 and WP-09 share no files with
each other; both share `src/kernel/Kernel.ts`, `src/kernel/config.ts` and
`src/kernel/index.ts` with the merged packages, in regions those packages have
already claimed.

Set up the worktrees first (both already exist and are fast-forwarded to
f6307e8; if they do not, create them):

```
git worktree add ../kt-wp07 -b wp-07 main
git worktree add ../kt-wp09 -b wp-09 main
```

Paste the block below into each session, replacing the ASSIGNMENT section with
that package's card. Change nothing else.

## The wave 3 block

```text
You are implementing KERNEL TRAIL, an educational game that teaches a full
college operating systems course through an Oregon-Trail-structured journey. It
is TypeScript and Three.js, it runs in the browser, and underneath the game sits
a real deterministic operating system simulator. Every minigame is a different
view onto that one simulator.

You are working in a git worktree on your own branch (wp-07 or wp-09), cut from
main at f6307e8. Another agent is building a different package in a sibling
worktree right now against the same frozen interfaces. Nothing you do may touch
its files. Commit on your branch only; you do not merge, and you do not push.

BEFORE YOU READ ANYTHING ELSE, confirm the baseline is green:

    node -v
    npm ci
    npm run verify

Node must be 22 (.nvmrc). `verify` runs the contract guard, typecheck, tests and
build in that order. All four must pass before you change a single file. Expect
757 passed and 0 skipped across 30 files. If you see "Cannot find native binding"
or "Unable to resolve @typescript/typescript-<platform>", that is a platform
mismatch in node_modules, not a defect: delete node_modules, reinstall, carry on.
Work in the devcontainer if you can, which prevents it. If the gates are red for
any other reason, stop and report that rather than starting work. The test time
budget is the CI runner's, not your laptop's: global testTimeout is 20 seconds
and DET-D4 declares its own; do not shorten either.

THEN READ, IN THIS ORDER, AND STOP AT EACH STEP ONCE YOU HAVE WHAT YOU NEED:

1. docs/astra/00-ASTRA-BRIEFING.md, in full, once.
2. docs/07-CONTRACT-AMENDMENTS.md, in full. Six amendments exist, plus a section
   of package scope corrections. This is the file that tells you what moved in
   the frozen contracts and why, and it is the first place to look if a package
   seems to disagree with a type.
3. docs/astra/00-PACKAGE-INDEX.md. Find your row, and read the rows of the
   packages you depend on. Then docs/astra/00-BUILD-ORDER.md.
4. Your assigned package, in full, before you write a line of code, including
   every section appended after the original text: the Scope correction, the
   Inherited from WP-05, WP-06 and WP-04 sections, and the grant audit it
   points at. Its Frozen contracts section is authoritative. Its Files you will
   create section is the complete list of files you may add. Its Out of scope
   section names territory belonging to another agent who is working right now.
5. Only the document sections your package's Required reading names.

ASSIGNMENT
(replace this whole section with your package card)

WHAT YOU INHERIT. WP-01, WP-02, WP-03, WP-05, WP-06 and WP-04 are complete,
merged and pushed. You inherit a deterministic kernel that runs: the sfc32
generator and its named fork streams, the event bus, real PCBs with the five
state model plus zombie, fork with copy on write, exec, wait, reaping, orphan
reparenting, the thread layer with Amdahl creation debt, the fixed eleven-phase
step order, all seven scheduling policies with Gantt golden files, main memory
with paging and a TLB, and virtual memory with six replacement policies, working
sets and thrashing control. 757 tests pass across 30 files.

Kernel.ts holds a hook interface for each subsystem. `installHooks` merges your
methods into the defaults, so you implement your interface and you do NOT alter
the eleven phase calls. Every one of the eleven phase bodies is byte-identical
to what WP-02 shipped, through four merged packages, and it stays that way. Read
the hook definitions in Kernel.ts before designing anything, and match them
exactly. Phase 10 is a metrics dispatch point: you register a metrics hook, you
do not edit the phase.

Decisions that will surprise you if you do not know them. Init is an internal
reaper with a repeating compute program, excluded from user scheduling, from
degree-of-multiprogramming accounting and from CPU metrics. Idle is PID 0 with
maximum priority and infinite service, excluded from the public process arrays
and from snapshots. Every process pays threadCreateTicks of creation debt per
thread before its first useful instruction, charged to the process; kernel-side
overhead that belongs to no process goes through `switchDebt`, and WP-09 gets an
accessor for it. Preserve all of it.

YOUR SNAPSHOT OBLIGATION. KernelSnapshot has a `subsystems` channel with ten
typed slots. Yours starts as a `SubsystemEnvelope` carrying an owner, a version
and a JsonValue payload. You fill it through `installHooks({ snapshots })` with
`saveState` and `restoreState`, where restoreState returns a commit closure
(prepare everything, then commit). Promoting the slot to a typed interface is
a frozen-file edit, and it happens in exactly one way: when your payload shape
is settled, send the exact patch against src/kernel/types.ts and stop. Once it
is approved in writing, apply it in its own commit, regenerate the lock with
`node scripts/check-contracts.mjs --update`, set `amendment` and
`amendmentNote` by hand, and record the amendment in
docs/07-CONTRACT-AMENDMENTS.md, before the implementation commit that uses it.
Never before approval. Shipping with an opaque envelope means your package is
not finished. Your subsystem state must survive a snapshot and restore round
trip against equivalent staged process state, and that is an acceptance item.
Fresh-kernel restore is WP-11's.

PRE-FLIGHT GRANT CHECK, BEFORE ANY CODE. Six packages in a row have found that
their grant was narrower than their spec: an acceptance item that needed a
file, a hook, a config key or a test edit the package never granted. Each one
cost a mid-flight round trip. So, in ONE message before you write code, list
every outcome your Acceptance criteria and your spec sections require, and
against each one name the file, hook, config key or protected test it needs and
whether your package grants it. Mark every gap. Include anything in your package
text that contradicts the spec or the code as it stands today, with the line.
Then stop and wait for the answer. Do not start on the ungapped items while you
wait, because the answers change designs.

THE RULES THAT GET PROJECTS LIKE THIS KILLED, IN SHORT. The briefing has the
full versions and wins wherever this summary is thinner.

- src/kernel/types.ts and src/game/types.ts are frozen. Do not edit them. Do not
  shadow them with a parallel type, a cast, an intersection, or a
  @ts-expect-error. Every amendment so far was raised by escalation rather than
  by an agent editing a file: leave a throwing stub carrying
  // TODO(astra): blocked on contract change, see report, finish everything
  else, and report it.
- Do not attach a field to a PCB, a Frame or a TCB. Keep extra state in a side
  table keyed by Pid, Tid or FrameId inside your subsystem, and put it in the
  snapshot through your `subsystems` slot.
- Nothing under src/kernel may import three, touch the DOM, or call Math.random,
  Date.now or performance.now. All randomness comes from the injected Rng
  through a named fork stream that your package names. tests/kernel/
  sourceScan.ts is the one scanner that enforces it; do not write a second one.
- Protected tests (determinism, stepOrder, and every earlier package's suite)
  are not yours to weaken. If an existing assertion is obsolete because of your
  granted change, quote it, propose the exact replacement, and wait. The skip
  budget is zero and the guard enforces it.
- Shared files: keep Kernel.ts, config.ts and index.ts edits minimal, contiguous
  and inside your named region. Add distinct config keys only. Do not reorder,
  rename or renumber the eleven phases, and do not reformat surrounding code.
  Report the exact line ranges you touched in each shared file.
- Never invent a Three.js API. The pin is 0.185. Check node_modules/three.
- Never invent a textbook citation and never invent a test vector. The worked
  examples in docs/02-KERNEL-SIM-SPEC.md section 16 were computed and verified,
  and your package names which are yours. If a fixture disagrees with the spec
  text, say so in the pre-flight; three spec bugs have been found that way.
- House style: strict TypeScript, no any, no em dashes anywhere including code
  comments, and stubs written as exactly // TODO(astra): plus a specific
  actionable instruction. The contract guard fails the build on an em dash.

DEFINITION OF DONE:

    npm run check:contracts
    npm run typecheck
    npm run test
    npm run build

All four exit 0 on Node 22, every numbered item in your Acceptance criteria
demonstrably satisfied, and your subsystem state proven to survive snapshot and
restore. "My new tests pass but two old ones broke" is not done: you own the
regression. The contract guard will also fail if you edited a frozen file, added
a second scanner, or skipped a test, and you must not regenerate
contracts.lock.json to get past it.

REPORT BACK WITH:

1. Every file you created, and every file you modified with a one-line reason,
   and the exact touched line ranges in Kernel.ts, config.ts and index.ts.
2. The four command exit codes, the Node version, and the test count and file
   count before and after.
3. Your Acceptance criteria as a checklist, each item marked with the specific
   evidence: a test name or a measured number, never "verified".
4. Whether you promoted your SubsystemEnvelope to a typed interface, the
   amendment number and commit, and if not, why not.
5. Anything you escalated: the interface, the specification section that
   demanded the change, the smallest change that would resolve it, and what you
   did instead.
6. Anything you found wrong in the specifications, with the line.
7. What the packages waiting on you need to know (WP-08 waits on WP-07; WP-10
   waits on WP-09; WP-11 waits on both).
8. Your branch name and the commit hashes, in order.

Do not begin implementing until you have finished reading your package and
your pre-flight grant check has been answered.
```

## Wave 3 package cards

### WP-07

```text
ASSIGNMENT: WP-07, at docs/astra/WP-07-synchronisation-and-race-detector.md,
on branch wp-07 in worktree ../kt-wp07.
You own mutexes, counting semaphores, monitors with both signalling disciplines,
read-write locks, and a race detector that reports the interleaving that caused
the race rather than only its existence.

You implement SyncHooks: expireTimers(tick), isSatisfied(pid, reason),
acquire(pid, resource), release(pid, resource), releaseAll(pcb), and
removeWaiter(pid). Your syscall surface is exactly four branches in the
dispatcher: sem_wait, sem_post, mutex_lock and mutex_unlock. `request` and
`release` are WP-08's, and so is the resource table behind them; do not build
it under another name.

Ordered primitives keep FIFO, head-only satisfaction, which is what makes
bounded waiting provable. Use blockProcess(pid, reason, optionalTid) so
thread-model semantics apply: under many-to-one the whole PCB blocks, and you do
not get to bypass that. isSatisfied is a readiness query only; ready-queue
insertion belongs to phase 4 and is not yours.

Mailbox waits use synthetic semaphore resources and must match their own
completion, never an unrelated mutex or condition wait. The IPC shared-region
value is available to your race detector. SYNC-PHIL-NAIVE requires WP-08's
detector and is out of your acceptance; the naive philosophers fixture still
has to deadlock deterministically under your primitives.

Your package carries a Scope correction dated 2026-09-13 and a grant audit at
docs/audits/2026-09-13-wp07-wp09-grant-audit.md, including the reviewer's
corrections to that audit. Read both before the pre-flight: several of your
gaps are already answered there, and the pre-flight should list only what is
still open.
```

### WP-09

```text
ASSIGNMENT: WP-09, at docs/astra/WP-09-storage-and-io.md, on branch wp-09 in
worktree ../kt-wp09.
You own six disk scheduling policies over a real request queue, RAID levels and
rebuild, and the I/O half: interrupts, polling, DMA and device queues.

You implement two hooks. IoHooks: expireTimers(tick), serviceCompletions(tick),
deliverInterrupts(tick), isSatisfied(pid, reason), request(pid, device),
removeWaiter(pid). StorageHooks: expireTimers(tick).

Phase discipline is fixed and not yours to change: completions run in phase 2,
interrupts in phase 3, and waits resolve in phase 4. A disabled hook is inert,
so a leg that does not enable your subsystem must see no behaviour from it at
all. Use blockProcess for requests that block, and return readiness through
isSatisfied.

Interrupt handling overhead is kernel time that belongs to no process. Charge
it through the `chargeKernelDebt(ticks)` accessor your package grants, which
adds to the existing `switchDebt` and is consumed in phase 8. Do not charge it
to a PCB and do not touch phase 8. Context-switch and copy debt are already kept
out of delivered useful CPU service, so do not charge them again.

Descriptor and device cleanup must remove an exiting process from every queue it
sits in. `setDiskPolicy` is a throw-stub today and becomes yours.

Your package carries a Scope correction dated 2026-09-13 and a grant audit at
docs/audits/2026-09-13-wp07-wp09-grant-audit.md, including the reviewer's
corrections to that audit. Read both before the pre-flight: several of your
gaps are already answered there, and the pre-flight should list only what is
still open.
```

## Merge order for wave 3

Either branch can merge first. Both are verified in a clean container before
merge, and the second one to land is fast-forwarded onto main before its own
verification. WP-08 starts after WP-07 lands; WP-10 after WP-09; WP-11 after
both.

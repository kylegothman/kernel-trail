# KERNEL TRAIL: Astra briefing

Read this once, before any work package. Do not re-read it per package. Every
work package assumes you already know everything below.

---

## 1. What the project is

KERNEL TRAIL is an Oregon-Trail-structured educational game that teaches a full
college operating systems course. A convoy of five named Programs travels from
the Boot Sector to the Portal across fourteen legs. Every hazard on the road is a
real OS pathology with a real remedy: starvation, deadlock, thrashing,
fragmentation, interrupt storms, unjournaled corruption, privilege escalation.

The curriculum is Silberschatz, Galvin and Gagne, *Operating System Concepts*,
10th edition, chapters 1 through 18, in the book's order.

Under the game sits a real, deterministic, headless operating system simulator.
Processes have real PCBs. Schedulers are real algorithms that reproduce textbook
Gantt charts to the tick. A Program's death is a scheduling outcome, never a
scripted beat. The whole run is a pure function of its seed plus the player's
decision log, which is what lets the end-of-run debrief replay the same run under
a different policy and show the player the counterfactual.

Everything renders in full 3D with Three.js. Nothing is a flat 2D panel. Art and
audio are entirely procedural: no models, no textures, no audio files ship.

Phase 1, which you are building, is the engine: the simulator, the renderer, the
design token system, the focus camera, the terminal, save and load, the HUD
shell, the audio engine, the leg runner that plays a leg, and the headless
harness that proves one runs. Nothing in phase 1 is leg-specific.

---

## 2. The frozen contract rule

Two files are frozen contracts:

- `src/kernel/types.ts`
- `src/game/types.ts`

**You may not edit either file.** Not to add a field. Not to widen a union. Not
to fix a typo in a comment. Not "temporarily". Fourteen leg packages and every
other engine package depend on these declarations being identical, so a change
you make locally silently breaks work you cannot see.

Each work package pastes the exact interfaces it implements into its **Frozen
contracts** section. That pasted text is authoritative. If your implementation
does not compile against it, your implementation is wrong.

### Escalation procedure

If a package genuinely cannot be completed without changing a frozen contract:

1. Stop. Do not edit the file. Do not add a parallel type that shadows it.
2. Do not work around it with a cast, an intersection type, a
   `// @ts-expect-error`, or a structural duplicate under a different name.
3. Write the rest of the package, leaving the blocked call sites as
   `// TODO(astra): blocked on contract change, see report` with a throwing stub.
4. Report, in your completion message, exactly:
   - the interface and field involved
   - the specification section that demands the change
   - the smallest change that would resolve it
   - what you did instead

A human decides. An unreported contract edit is the single worst failure
available to you in this project.

A near-miss worth naming: several packages want to attach a field to a PCB or a
frame. Do not. Keep the extra state in a private side table keyed by `Pid` or
`FrameId` inside your subsystem, and include it in `snapshot()` through the
channel the package specifies.

**Amendments happen.** The contract is frozen against you, not against the
project. When an escalation is upheld, a human approves a change and it is
recorded in `docs/07-CONTRACT-AMENDMENTS.md`, which is the authoritative record
of what moved and why. Two amendments exist already: the subsystem state channel
on `KernelSnapshot`, and the Amdahl burst model. So if a frozen contract seems to
disagree with the package you are holding, read that file before doing anything
else; the answer is often there, and the package is the stale half. None of this
relaxes the rule above. The escalation path is the only way a contract changes,
and it has now worked twice.

---

## 3. Dependency direction and import boundaries

Dependency direction is one way, always:

```
legs -> game -> kernel
world/render/ui/audio/terminal -> (read) game + the kernel event stream
design, platform -> leaf modules, depend on nothing above them
app -> may import everything
```

The permission matrix. Rows import, columns are imported. `Y` allowed, `T`
type-only imports allowed (`import type` and nothing else), blank forbidden.

| from / to | kernel | game | legs | world | render | terminal | audio | ui | design | platform | app |
|---|---|---|---|---|---|---|---|---|---|---|---|
| kernel | Y | | | | | | | | | | |
| game | Y | Y | T | | | | | | | | |
| legs | T | Y | | Y | | T | | | Y | T | |
| world | T | T | | Y | Y | | | | Y | T | |
| render | | | | | Y | | | | Y | Y | |
| terminal | T | Y | | | | Y | | | Y | | |
| audio | T | T | | | | | Y | | Y | T | |
| ui | T | T | | | | T | | Y | Y | T | |
| design | | | | | | | | | Y | | |
| platform | | | | | | | | | Y | Y | |
| app | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y | Y |

Rules the matrix cannot express:

- No leg may import another leg, in either direction, at any depth.
- `src/world` may import `src/render`. `src/render` may never import
  `src/world`.
- `src/ui` may not import `three`. If a HUD element needs a 3D position it
  receives a projected 2D point through the store.
- `src/kernel` may not import `src/design`. Colour is presentation. Kernel
  events carry semantics (`severity: 'warning' | 'critical'`) and `src/world`
  maps semantics to tokens.
- Cross-layer imports go through the layer barrel `src/<layer>/index.ts`. Deep
  imports such as `@world/structures/FrameVault/mesh` from outside `@world` are
  forbidden. Inside a layer, deep relative imports are correct and expected,
  because an intra-layer barrel creates import cycles.
- A worker entry point may import `@kernel` and the headless half of `@game`
  only. A stray `@world` or `@render` import there pulls Three.js into the
  worker bundle and fails at runtime.

Path aliases are configured in `tsconfig.json`: `@kernel`, `@kernel/*`, `@game`,
`@game/*`, `@legs/*`, `@world`, `@world/*`, `@render`, `@render/*`,
`@terminal/*`, `@audio/*`, `@ui/*`, `@design/*`, `@platform/*`, `@app/*`. Use
them. Do not write `../../../kernel/types`.

---

## 4. Determinism rules and forbidden APIs

The kernel is a pure function of `KernelConfig` plus the injected `Rng`. Two
kernels built from the same config and stepped the same number of ticks produce a
byte-identical event log and snapshot. This is enforced by test, not by
convention.

### Forbidden identifiers anywhere in CODE under `src/kernel`

Including dynamic property access such as `Math['random']`, and access split
across lines. The list:

```
Math.random        Date.now           Date (as a constructor)
performance.now    performance        crypto.getRandomValues
setTimeout         setInterval        queueMicrotask
requestAnimationFrame                 fetch
window             document           navigator            globalThis
localStorage       indexedDB          Worker               console
```

**Comments are exempt, and this is not a loophole.** The frozen `types.ts` header
and the `Kernel.ts` header both state this prohibition in English, which means
they name `Math.random`, `Date.now` and `performance.now` in order to forbid
them. A scanner that reads raw source flags those two comments, and the only way
to make it pass is to edit a frozen file and delete the sentence documenting the
contract. So every source scan blanks comments before matching. It does NOT blank
string literals, because computed access is written `Math['random']` and blanking
the literal turns it into `Math[      ]`, defeating the check that matters most.
`tests/kernel/sourceScan.ts` is the shared implementation. Use it. Do not write a
second scanner with a different policy.

`console` is on the list deliberately. A kernel that wants to say something emits
a `KernelEvent`; `kernel.panic` exists for exactly this. Debug from a vitest run,
where `console` is available in the test file.

### Determinism hazards that are not identifiers

- `Array.prototype.sort` with no comparator, or with a comparator that returns 0
  for distinct elements. Every comparator must be a total order. A tie makes the
  result depend on the array's prior history.
- `Object.keys` or `for...in` over an object with runtime-inserted keys. Use a
  `Map` and iterate a sorted array of its keys.
- `Set` iteration where insertion order depends on event arrival. Derive a sorted
  array first.
- Floating-point accumulation of tick counts. Every duration is an integer. Only
  metrics are floats, and metrics are **recomputed from state every tick, never
  accumulated**. An accumulated float diverges across `snapshot()` and
  `restore()` because floating-point addition is not associative under a
  different grouping, and that is precisely what test D2 catches.
- `structuredClone` on anything holding a function. It throws, and it hides the
  fact that a policy object leaked into the snapshot.
- `toLocaleString` and `Intl.*` anywhere in an event payload.

### Where randomness comes from

`Rng` only, and only the stream your subsystem was handed. The kernel forks
exactly eleven streams at construction, in this fixed order, whether or not the
subsystem is enabled for the current leg:

```
root/process  root/scheduler  root/memory  root/vm  root/sync
root/deadlock root/storage    root/io      root/fs  root/security  root/events
```

Never reach for the root stream from subsystem code.

`Math.random` is permitted in `src/render` for film grain and mote jitter only,
neither of which is ever read back by the game layer. Everywhere else it is
forbidden.

---

## 5. House style

- **TypeScript strict.** `strict: true`, `noUncheckedIndexedAccess: true`,
  `exactOptionalPropertyTypes: true`, `noImplicitOverride: true`,
  `noFallthroughCasesInSwitch: true`, `noPropertyAccessFromIndexSignature: true`,
  `verbatimModuleSyntax: true`. Do not weaken any of them. If
  `noUncheckedIndexedAccess` is making array indexing painful, that pain is the
  setting working: it turns an off-by-one into a type error instead of an
  `undefined` in a save file.
- **No `any`.** Not in committed code, not behind a cast, not via an untyped
  third-party shim. `unknown` plus a narrowing function is the answer.
- **No non-null assertions (`!`) in `src/kernel`.** Handle the `undefined`
  branch, or throw a `KernelInvariantError` with the invariant number.
- **No em dashes or en dashes used as em dashes.** Anywhere. Code comments, JSDoc,
  man page text, UI copy, event rationale strings, commit messages, your
  completion report. Use a comma, a colon, a full stop, or a rewrite.
- **Stub convention.** Any deliberate gap is
  `// TODO(astra): <what is missing and why>` on its own line, immediately above
  a function that throws `new Error('not implemented: <name>')`. Never a silent
  `return null` and never an empty function body. Stubs are grep-able and every
  package's acceptance criteria include a count of them.
- Comments explain *why*, since *what* is in the specification. A comment that
  restates the line below it is noise.
- One exported concept per file where practical. File names match the exported
  symbol.
- No default exports except a leg's `index.ts`.

---

## 6. How to verify before reporting done

Run all three, in this order, from the repository root:

```
npm run check:contracts   # the contract guard, must exit 0, and runs first
npm run typecheck         # tsc --noEmit, must exit 0
npm run test              # vitest run, must exit 0
npm run build             # vite build, must exit 0
```

`npm run verify` runs all four in that order.

The contract guard comes first and needs no dependencies installed. It catches
five things a green test suite cannot: an edit to a frozen contract, a second
source scanner with a contradicting policy, a test made to pass by skipping it,
an em dash, and a borrowed name reaching a file that ships. If it fails, read the
remedy it prints. Do not disable a rule to get past it. `docs/06-AGENT-TOOLCHAIN.md`
section 2 explains each rule and how a human approves an exception.

If `npm install` or `npx` fails with "Cannot find native binding" or "Unable to
resolve @typescript/typescript-<platform>", that is a platform mismatch in
`node_modules`, not a defect in your package. Delete `node_modules`, reinstall,
and carry on. `docs/06-AGENT-TOOLCHAIN.md` section 1 explains why it happens.

A package is not done until all three exit zero, and the time budget is the CI
runner's, not your laptop's. WP-06 reported a green suite from an Apple silicon
machine; the same suite timed out on a slower Linux container because one
determinism test runs 128,000 simulated ticks. Run the gates in the devcontainer,
or assume the runner is at least twice as slow as you are. A test that needs more
than the 20 second global ceiling declares its own budget on the test, with a
comment saying why, the way DET-D4 does. "It works but the type checker
complains" is not done. "The new tests pass but two old ones broke" is not done:
you own the regression.

Additional gates that specific packages name:

```
npm run test -- <path>          # a single test file, for iteration
npm run lint                    # eslint, including the layer boundary rules
npm run test:determinism        # tests/kernel/determinism.test.ts alone
```

If a script named in a package does not yet exist in `package.json`, the package
that creates it says so. Do not invent scripts and do not silently add them.

**A scaffold already exists and passes 83 tests.** Several files your package's
file list says to create are already there: `src/kernel/rng.ts`, `EventBus.ts`,
`Kernel.ts`, `scheduler/FCFS.ts`, `scheduler/SchedulerRegistry.ts`,
`scheduler/common.ts`, `src/game/store.ts`, `src/game/save.ts`,
`src/app/loop.ts`, `src/legs/registry.ts`, `src/main.ts`, and four test files
under `tests/kernel/`. For any of these, **complete and verify rather than
create**: read the file first, say what it already got right, fix what it did not,
and report every line you changed. Where the scaffold's path differs from the one
your package names, keep the scaffold's path and note the difference. Never create
a second file at the other path. `00-BUILD-ORDER.md` carries the full
reconciliation table.

---

## 7. Anti-hallucination rules

These are the failure modes that cost the most to unwind.

**Three.js is pinned to version 0.185.** Do not use an API because you remember
it, because a tutorial used it, or because it sounds right. If you are not
certain a class, method, property or constant exists in 0.185, check
`node_modules/three/` before writing the call. The type definitions in
`node_modules/three/src/` and `node_modules/three/build/three.d.ts` are the
authority, not your memory. The same rule applies to `three/webgpu`,
`three/tsl`, and `three/addons`.

Specific traps: node-material and TSL APIs moved repeatedly across releases; the
WebGPU renderer entry point has changed name; `EffectComposer` lives under
addons; tone mapping constants are enum members on `THREE`, not strings. Check
each one.

**Never hand-transcribe a numeric constant from a library.** The AgX tone mapping
matrices are the named example: import them from Three's shader chunks or copy
them verbatim from the file in `node_modules`. The values printed in the visual
bible document the operator's structure and are explicitly labelled as not the
shipping values.

**Never invent a textbook citation.** `ChapterRef` carries a chapter number, a
list of section numbers and a title. Every one of them must come from the
curriculum map (`05-CURRICULUM-MAP.md`) or from a section number already written
in the sim spec. If you need a citation the documents do not give you, leave
`chapter: null` where the type permits it, and report the gap. A wrong section
number in an educational game teaches something false.

**Three citations in the frozen types are wrong and stay wrong.** The frozen
files are not edited, so the incorrect comments remain. Every piece of content
you generate uses the corrected number instead: man pages, codex prose, event
rationale strings, `SafetyTraceStep.explanation`, and any `ChapterRef` you
construct.

| Location in frozen code | Cited there | Correct for the 10th ed. | Why |
|---|---|---|---|
| pace to quantum, design brief | 5.3.4 | **5.3.3** | 5.3.3 is Round-Robin, where the quantum is defined. 5.3.4 is Priority Scheduling. |
| `SafetyCheckResult.sequence` | 8.6.2 | **8.6.1** | Safe state and the safe sequence are 8.6.1. 8.6.2 is the resource-allocation-graph algorithm. |
| `DeadlockReport.cycle` | 8.3.2 | **8.7.1** | 8.3.2 is the resource-allocation graph. The wait-for graph and its cycle test are 8.7.1. |

`ProcessControlBlock.priority` citing 5.3.4 for "lower number is higher priority"
is correct and stays.

**Never invent a design token.** Every colour, every emissive gain, every
duration, every easing curve comes from `src/design/tokens.ts`,
`src/design/motion.ts` or `src/design/typography.ts`. There is exactly one file
in this repository permitted to contain a colour literal and it is
`src/design/tokens.ts`. If the token you need is missing, report it; do not write
`0x5fd7f5` into a material.

**Never invent a test vector.** Section 16 of the sim spec is the complete list
of expected values. Where a row says "recorded at implementation", the first
correct implementation establishes the value and freezes it; write the test so it
prints the value and then pin it. Everywhere else, the number in the table is the
number your test asserts. If your implementation disagrees with the table, the
implementation is wrong until a human says otherwise.

**Never invent a `KernelEvent` variant, a `SyscallName`, an `Errno`, an
`AfflictionId` or a `LegId`.** All five unions are closed and frozen.

---

## 8. IP constraints

Restated in full from design brief section 3, because every piece of copy you
generate must respect them: command output, man pages, event rationale strings,
epitaphs, codex text, comments, and file names.

The visual language of the *Tron* films is the reference: black void, emissive
circuitry, hard-edged volumetric light, derezzing, identity discs, light ribbons,
the sense of a vast dark computational space with a horizon of light.

What is forbidden, permanently, in code, art, copy and marketing:

- The words Tron, ENCOM, Flynn, CLU, Quorra, Rinzler, Sark, Kevin, Sam, Gem,
  Castor, Zuse, Yori, Dumont, Ram, Bit, MCP, Recognizer, Grid (capitalised as a
  proper noun for the setting), Sea of Simulation, Solar Sailer, Light Cycle as a
  proper noun, or Isomorphic Algorithm.
- Disney or Tron logos, the Tron typeface, or any recreation of a specific shot,
  poster, vehicle silhouette or character design from the films.

The setting's proper noun is **the Substrate**. Vehicles are **runners**. The
hostile enforcement programs are **arbiters**. The final destination is **the
Portal**, which is a generic computing term and safe. Where a leg name in earlier
drafts borrowed a film phrase, the shipping name is given in the curriculum map
and that name is final.

Two practical notes. "grid" in lower case, meaning the floor grid or a data grid,
is fine; "the Grid" as the name of the setting is not. "bit" as a unit is fine;
"a Bit" as a character is not.

---

## 9. Work package dependency graph

```
        WP-01                                     WP-12
   RNG + event bus                    design tokens + platform tiers
     |      \                             /         |          \
   WP-02     \                         WP-13        |           \
process,      \                   focus camera +    |            \
threads,       \                  structure base    |             \
step order      \                       |           |              \
  /  |  |  \     \                    WP-14         |             WP-16
 /   |  |   \     \             world router,       |             audio
WP-03 WP-05 WP-07 WP-09         effects, derezz     |
sched  main  sync  storage                          |
core  memory   |    + I/O                           |
  |     |      |      |                             |
WP-04 WP-06  WP-08  WP-10                           |
 RR,   VM   deadlock  fs +                          |
MLFQ                security                        |
  \     \      |      /                             |
   +----- WP-11 -----+                              |
    syscalls, snapshot,                             |
       invariants                                   |
        |        \                                  |
      WP-15      WP-17 ---------------------------- +
    terminal   HUD, codex, save/load
                  |
                WP-18
        counterfactual replay worker
                  |
                WP-19
     leg runner, travel loop, crossings,
        depot, reclamation, debrief
                  |
                WP-20
     smoke-test harness + golden runs
                  |
          the fourteen leg packages
```

Edges are hard prerequisites. Anything not connected by a downward path can run
concurrently.

| Wave | Packages that can run at the same time |
|---|---|
| 0 | WP-01, WP-12 |
| 1 | WP-02, WP-13 |
| 2 | WP-03, WP-05, WP-07, WP-09, WP-14, WP-16 |
| 3 | WP-04, WP-06, WP-08, WP-10 |
| 4 | WP-11 |
| 5 | WP-15, WP-17 |
| 6 | WP-18 |
| 7 | WP-19 |
| 8 | WP-20 |

WP-19 and WP-20 are the gate on every leg package. Nothing in `src/legs/` starts
until WP-20 has reported done.

The full edge list, for the cases the diagram compresses:

| WP | Title | Prerequisites |
|---|---|---|
| WP-01 | RNG, event bus, determinism fixtures | none |
| WP-02 | Processes, threads, step order | WP-01 |
| WP-03 | Scheduler foundation and four policies | WP-02 |
| WP-04 | Aging, round robin, MLFQ | WP-03 |
| WP-05 | Main memory, paging, TLB | WP-02 |
| WP-06 | Virtual memory and replacement | WP-05 |
| WP-07 | Synchronisation and the race detector | WP-02 |
| WP-08 | Deadlock | WP-07 |
| WP-09 | Storage and I/O | WP-02 |
| WP-10 | File system and protection | WP-02, WP-09 |
| WP-11 | Syscalls, snapshot, invariants | WP-02 through WP-10 |
| WP-12 | Renderer, post chain, design tokens | none |
| WP-13 | Focus camera, structure base classes | WP-12 |
| WP-14 | World router, effects, derezz | WP-01, WP-13 |
| WP-15 | Terminal | WP-11, WP-12 |
| WP-16 | Procedural audio engine | WP-01, WP-12 |
| WP-17 | HUD, codex, save/load | WP-11, WP-12 |
| WP-18 | Counterfactual replay worker | WP-11, WP-17 |
| WP-19 | Leg runner, travel loop, crossings | WP-11, WP-17, WP-18 |
| WP-20 | Smoke-test harness and golden runs | WP-19 |

`00-PACKAGE-INDEX.md` lists all twenty engine packages and all fourteen leg
packages in one table with their phase, dependencies, size and objective. Read it
after this briefing and before opening any package.

`00-BUILD-ORDER.md` carries the same information as a table with size estimates
and the exact file territory each package owns, plus the scaffold reconciliation
rules and the citation corrections. Read it before starting any package, so you
know which directories are somebody else's and which files already exist.

---

## 10. Two habits that will save you

**Read the frozen contract in the package before writing code.** It is pasted in
full for a reason. Nine tenths of the drift in a project like this comes from
implementing a remembered interface instead of the written one.

**When a specification section number is named, open that section.** The packages
say "sim spec section 5.8" rather than "the sim spec" precisely so you can go
straight to the algorithm. The algorithms are written out with worked examples;
you should not be inferring any of them.

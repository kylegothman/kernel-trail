# WP-15: The terminal

## Objective

When this package is done the game has a real shell over the live simulator. Every
command reads or writes actual kernel state through the syscall table and the read
accessors; none of them return canned text. The base command set is available from
Leg 0 and legs add their own through `TerminalCommandDef`. `man` pages are written
to teach and they come from the curriculum map, not from your imagination. The
terminal is a screen-space surface the player deliberately opens, alongside the HUD
and the codex, and it is the player's escape hatch when the world will not tell
them what they need.

## Prerequisites

WP-11 and WP-12 complete and green.

Files that must already exist:

- `src/kernel/syscall/table.ts`, `dispatch.ts`, `validate.ts` with `CALL_SPECS`,
  and `errno.ts` with the seven substitution constructors
- `src/kernel/index.ts` exporting `createKernel` and the read accessors
- `src/design/tokens.ts`, `motion.ts`, `typography.ts`
- `src/game/store.ts` (exists in the scaffold) for the command write path

## Required reading

- `00-DESIGN-BRIEF.md` section 7 (the player's verbs) for what the terminal is and
  the always-available command list
- `05-CURRICULUM-MAP.md`, **the "Terminal commands introduced" section of every
  one of the fourteen legs.** This is where the complete command set lives, as
  literal `TerminalCommandDef` objects with their `usage`, `summary`, `manual` and
  `chapter` already written. **Source every command from there. Invent nothing.**
- `05-CURRICULUM-MAP.md` section 0 and 0.1, including the three citation
  corrections
- `01-ARCHITECTURE.md` section 4.7 (commands: the write path from UI to kernel)
- `01-ARCHITECTURE.md` section 1.3 (the permission matrix row for `terminal`) and
  7.5 (the DOM rule)
- `03-VISUAL-BIBLE.md` section 7.1 and 7.2 (the faces and the type scale), 2.6
  (contrast ratios for text), 11.3 (layout and safe areas), which the terminal
  shares with the HUD
- `02-KERNEL-SIM-SPEC.md` section 14.2 (the errno substitution table) and 14.3
  (the reference table), since several commands are thin wrappers over syscalls

## The command set

Every command name below appears in `05-CURRICULUM-MAP.md` with a complete
`TerminalCommandDef`. **Read the definition there and use its `usage`, `summary`,
`manual` and `chapter` verbatim.** Do not paraphrase a `manual`, do not shorten
it, and do not write one for a command the curriculum map does not define.

```
access    amdahl    audit     bankers   belady    buffer    chmod
degree    devstat   frag      free      fsck      gantt     guest
hyper     inode     iomode    iostat    ipc       irq       journal
kill      lock      lsof      man       migrate   mode      mount
nice      pagetable ps        pstree    race      raid      resources
ring      rwlock    sched     seekq     sem       syscall   threads
tlb       top       trace     vmstat    wait      wfg       ws
```

The design brief's section 7 names a subset as always available: `ps`, `top`,
`kill`, `nice`, `free`, `vmstat`, `iostat`, `lsof`, `mount`, `bankers`, `wfg`,
`pagetable`, `trace`, `man`. Those, plus `man`'s topic pages, are the base shell.
The rest arrive with their legs through `Leg.terminalCommands`.

**If a command in that list has no definition in the curriculum map**, do not
implement it. Report the gap and move on. A command with an invented man page
teaches something the curriculum did not sanction.

## Files you will create

```
src/terminal/Terminal.ts
src/terminal/Shell.ts
src/terminal/parser.ts
src/terminal/registry.ts
src/terminal/output.ts
src/terminal/history.ts
src/terminal/completion.ts
src/terminal/man/ManPages.ts
src/terminal/man/errnoPages.ts
src/terminal/man/conceptPages.ts
src/terminal/commands/base.ts
src/terminal/commands/process.ts
src/terminal/commands/scheduler.ts
src/terminal/commands/memory.ts
src/terminal/commands/sync.ts
src/terminal/commands/deadlock.ts
src/terminal/commands/storage.ts
src/terminal/commands/io.ts
src/terminal/commands/filesystem.ts
src/terminal/commands/security.ts
src/terminal/commands/index.ts
src/terminal/render/TerminalView.ts
src/terminal/render/terminal.css.ts
src/terminal/index.ts
tests/terminal/parser.test.ts
tests/terminal/commands.test.ts
tests/terminal/man.test.ts
tests/terminal/liveState.test.ts
```

## Files you may modify

None. Every file this package needs it creates.

## Frozen contracts

From `src/game/types.ts`. This may not be edited:

```ts
export interface TerminalCommandDef {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  /** Man page text. Written to teach, not merely to document. */
  readonly manual: string;
  readonly chapter: ChapterRef | null;
}

/** A citation into Silberschatz, Operating System Concepts, 10th edition. */
export interface ChapterRef {
  readonly chapter: number;
  readonly sections: readonly string[];
  readonly title: string;
}

export interface Leg {
  /** Terminal commands this leg adds on top of the base shell. */
  readonly terminalCommands: readonly TerminalCommandDef[];
  // ... other members
}
```

From `src/kernel/types.ts`, the entire read surface the terminal is permitted to
touch:

```ts
export interface Kernel {
  readonly config: Readonly<KernelConfig>;
  readonly tick: Tick;
  readonly events: KernelEventStream;
  syscall(request: SyscallRequest): SyscallResult;
  process(pid: Pid): Readonly<ProcessControlBlock> | undefined;
  readonly processes: readonly Readonly<ProcessControlBlock>[];
  setScheduler(id: SchedulerId, params?: Partial<SchedulerParams>): void;
  setReplacementPolicy(id: PageReplacementId): void;
  setDiskPolicy(id: DiskSchedulingId): void;
  setAllocationStrategy(s: AllocationStrategy): void;
  evaluateBankers(pid: Pid, resource: ResourceId, instances: number): SafetyCheckResult;
  detectDeadlock(): DeadlockReport | null;
  snapshot(): KernelSnapshot;
  restore(snapshot: KernelSnapshot): void;
}
```

`TerminalCommandDef` carries no handler. Declare a separate local interface that
pairs a definition with its implementation:

```ts
export interface TerminalCommand {
  readonly def: TerminalCommandDef;
  readonly run: (argv: readonly string[], ctx: ShellContext) => CommandResult;
}
```

Extension by a local interface is allowed; editing `types.ts` is not.

## Specification

### 1. Every command reads or writes real state

The design brief states it flatly: **the terminal is a real shell over the live
simulator, and every command reads or writes actual simulator state.**

Concretely:

- `ps` walks `kernel.processes` and prints the live PCB fields. It does not keep
  a cached list.
- `kill` issues the `kill` syscall through `kernel.syscall`, gets a real
  `SyscallResult`, and prints the real errno on failure.
- `sched rr 4` calls the command bus, which records a `DecisionRecord` in
  `RunState.decisions` and then calls `kernel.setScheduler`. **It never calls the
  kernel mutator directly**, because an unrecorded decision breaks replay and
  therefore breaks the counterfactual debrief.
- `bankers` calls `kernel.evaluateBankers` and prints the returned
  `SafetyCheckResult.trace`, one line per `SafetyTraceStep`, using each step's own
  `explanation` string.
- `wfg` builds its output from `kernel.detectDeadlock()` and the read accessors.
- `pagetable` prints the live page table from the kernel snapshot's page table
  section or a dedicated read accessor, never from a copy taken at open time.

**A command that returns text unrelated to current state is a bug**, and a test
must exist for every command proving its output changes when the state it reads
changes.

### 2. The write path

Architecture 4.7. Player writes go through the command bus, never straight to the
kernel:

```
terminal command -> CommandBus.dispatch(command) -> RunState.decisions.push(record)
                                                 -> kernel mutator
```

`src/terminal` may import from `src/game` (the permission matrix allows
`terminal -> game` as `Y`) and may import kernel **types only**. Getting a live
`Kernel` reference is fine; calling a mutator on it from `src/terminal` is not.
Route every mutation through `@game`.

The four mutators the player can reach: `setScheduler`, `setReplacementPolicy`,
`setDiskPolicy`, `setAllocationStrategy`, plus the travel policy fields `pace`,
`rations` and `degreeOfMultiprogramming`, which live in `RunState.policy`.

### 3. `src/terminal/parser.ts`

A small, strict parser. It is not a POSIX shell and pretending otherwise invites
scope that never ends.

Supported: a command word, whitespace-separated arguments, single and double
quoted strings, long flags (`--history`), short flags (`-a`), and `--` to stop
flag parsing. Not supported and rejected with a clear message: pipes, redirection,
globbing, variable expansion, subshells, and command chaining.

Parse errors are `CommandResult` failures with the offending position, not
exceptions.

### 4. `src/terminal/Shell.ts` and `registry.ts`

The registry holds `Map<string, TerminalCommand>`, seeded with the base set and
extended by `Leg.terminalCommands` at leg start. A leg's command replaces a base
command only if the base set does not already define it; a collision is an error
the leg author must see, so throw at registration in dev builds and report.

`ShellContext` carries the read accessors, the command bus, the current
`RunState`, and the output sink. It carries no mutable kernel reference the
commands can misuse.

`CommandResult` is a discriminated union of `ok` with output lines and `error`
with a message and an optional `Errno`. **Every error message names the `man`
topic that explains it**, because the design brief's `man` page says the error
itself tells the player what to type next. That is a contract between the two.

### 5. `src/terminal/man/`

`man <topic>` prints the manual page for a command name (`man ps`), a concept
(`man syscall`), or an error code (`man EPERM`).

- **Command pages** come from `TerminalCommandDef.manual`, verbatim.
- **Errno pages** cover all eleven members of the frozen `Errno` union **plus the
  seven substituted Unix codes** from sim spec 14.2. `man ECHILD` must explain
  that the simulator returns `ESRCH` with the `"no children: "` prefix and why.
  That substitution table is the source; do not invent additional codes.
- **Concept pages** come from the curriculum map's codex and man page text. If a
  concept the player can reasonably type has no page in the curriculum map,
  `man` says so and names the nearest topic that does exist. It does not invent
  one.

Two rules from the curriculum map's own `man` page, which are binding on every
page you assemble:

- **A manual page never tells the player which choice to make. It tells them what
  the choice costs.** The codex is where remedies live.
- Every page ends with a `See also:` line naming real topics.

**Citations.** Use the corrected 10th-edition section numbers from curriculum map
section 0.1 in every page you generate: the quantum is **Ch. 5.3.3**, the safe
sequence is **Ch. 8.6.1**, the wait-for graph cycle is **Ch. 8.7.1**. The frozen
comments in `types.ts` cite 5.3.4, 8.6.2 and 8.3.2 and they stay as they are; your
output does not repeat them.

### 6. `src/terminal/render/`

The terminal is DOM, like the HUD, and it obeys the DOM rule of architecture 7.5:
**batched writes, no layout thrash, and no per-frame DOM mutation.** Output lines
are appended in one batch per frame through a document fragment.

Typography comes from `@design/typography`: the mono face, the type scale, and the
contrast ratios of visual bible 2.6. Colours come from `@design/tokens`.
`src/terminal` may import `@design` and must contain no colour literal.

Layout follows visual bible 11.3's safe-area variables. The terminal occupies a
surface the player opens deliberately; it is not part of the always-on HUD and it
does not count against the HUD's 11 percent coverage cap.

Scrollback is capped at `maxScrollbackLines` (default 2,000) and trimmed from the
head. History is capped at 200 entries and is not persisted across runs.

Completion offers command names on Tab, then argument values where the command
declares an enumerable argument type (a `SchedulerId`, a `PageReplacementId`, a
live `Pid`). Build it from `CALL_SPECS` and the registry rather than a second
hand-written table.

### 7. Output formatting

Command output is plain text in fixed columns. Three helpers in `output.ts` and no
ad-hoc formatting in a command:

- `table(headers, rows)` computes column widths once and pads with spaces.
- `kv(pairs)` for two-column key-value output.
- `bar(value, max, width)` for the small inline meters `top` and `vmstat` use.

`ps` prints state as a single character in the Unix convention, with `Z` for
zombie, because the design brief names `ps` showing state `Z` as how the player
discovers zombie accumulation on Leg 1.

`top` shows a **`spin%` column separate from `user%`**, because WP-07's busy-wait
ticks count as CPU busy and the whole point of the lesson is that utilisation
looks perfect while nothing is accomplished. Read it from WP-07's
`spinTicks(pid)`. Add a `poll%` column from WP-09's `pollTicks(pid)` for the same
reason.

`trace` renders the `syscall.invoked` event stream as an strace, which is possible
because WP-11 emits that event for every call including failures.

`gantt` renders the scheduler's dispatch record. Reuse the Gantt string format
WP-04's golden files use, so the terminal and the tests agree on one format.

## Acceptance criteria

1. `npm run typecheck` exits 0.
2. `npm run test` exits 0.
3. `npm run build` exits 0.
4. Every command implemented has a `TerminalCommandDef` whose `usage`, `summary`,
   `manual` and `chapter` are **byte-identical** to the definition in
   `05-CURRICULUM-MAP.md`. Verified by a test that reads the curriculum map from
   `docs/` and compares.
5. No command is implemented that the curriculum map does not define. The set of
   implemented names is a subset of the set defined there.
6. Every command's output changes when the state it reads changes. One case per
   command: run it, step the kernel to alter the relevant state, run it again,
   assert the output differs.
7. No command mutates the kernel directly. Verified by a source scan asserting
   `src/terminal/` contains no call to `setScheduler`, `setReplacementPolicy`,
   `setDiskPolicy`, `setAllocationStrategy` or `restore` on a `Kernel`.
8. Every policy-changing command appends exactly one `DecisionRecord` to
   `RunState.decisions`.
9. `man` resolves a command name, a concept and an errno, and returns a clear
   "no page" message naming the nearest real topic for an unknown one.
10. `man` has a page for all eleven `Errno` members and all seven substituted
    Unix codes.
11. Every error message a command produces names a `man` topic that exists.
    Asserted across every error path in the test suite.
12. No page generated by this package cites Ch. 5.3.4 for the quantum, Ch. 8.6.2
    for the safe sequence, or Ch. 8.3.2 for the wait-for graph cycle. Verified by
    a grep.
13. `kill` on a zombie returns `ESRCH` and prints the errno, matching the kernel.
14. `bankers` prints one line per `SafetyTraceStep` using that step's own
    `explanation`, and the line count equals `trace.length`.
15. `ps` prints `Z` for a zombie process.
16. `top` shows `spin%` and `poll%` as columns distinct from `user%`, and a
    busy-waiting process shows a non-zero `spin%` with zero progress.
17. `trace` output line count equals the `syscall.invoked` event count over the
    same window.
18. The parser rejects pipes, redirection, globbing, variable expansion,
    subshells and chaining with a message naming what is unsupported, and never
    throws.
19. `src/terminal/` contains no hex colour literal and no `three` import.
20. `src/terminal/` imports from `src/kernel/` with `import type` only.
21. Rendering 500 output lines performs one DOM batch, verified with a mutation
    observer counting one `appendChild` of a fragment.
22. Scrollback trims from the head at 2,000 lines and never exceeds it.
23. Tab completion offers command names, then enumerable argument values, sourced
    from the registry and `CALL_SPECS` rather than a hand-written list.

## Tests you must write

### `tests/terminal/parser.test.ts`

| Case | Assertion |
|---|---|
| `bare command` | `ps` parses to `{ command: 'ps', argv: [] }` |
| `arguments` | `kill 7` parses the argument as the string `'7'`; conversion is the command's job |
| `quotes` | single and double quoted strings preserve inner whitespace |
| `long flags` | `mode --history` yields the flag separately from the positional arguments |
| `short flags` | `-a` parses as a flag; `-12` parses as an argument |
| `double dash` | `--` stops flag parsing |
| `unsupported` | pipes, `>`, `*`, `$VAR`, backticks and `;` each produce a named error and no throw |
| `error position` | a parse error carries the offending character index |
| `empty input` | an empty line produces no output and no error |

### `tests/terminal/commands.test.ts`

One `describe` per command group, with, for every implemented command: a success
case, a live-state case per acceptance criterion 6, and an error case naming its
`man` topic.

| Case | Assertion |
|---|---|
| `definition fidelity` | per acceptance criterion 4 |
| `no invented commands` | per acceptance criterion 5 |
| `no direct mutation` | per acceptance criterion 7 |
| `decision recorded` | per acceptance criterion 8, for `sched`, `nice`, `degree`, `iomode`, `mount` and any other policy command |
| `ps zombie` | per acceptance criterion 15 |
| `top columns` | per acceptance criterion 16 |
| `trace strace` | per acceptance criterion 17 |
| `bankers trace` | per acceptance criterion 14 |
| `wfg cycle` | `wfg` prints the cycle from `detectDeadlock()` rotated to its lowest pid, matching the kernel's own report |
| `kill zombie` | per acceptance criterion 13 |
| `gantt format` | the Gantt string matches WP-04's golden file format exactly for the same workload |
| `errors name topics` | per acceptance criterion 11 |

### `tests/terminal/man.test.ts`

| Case | Assertion |
|---|---|
| `command page` | `man ps` returns `TerminalCommandDef.manual` verbatim |
| `concept page` | `man syscall` returns the curriculum map's page |
| `errno pages` | per acceptance criterion 10 |
| `substituted codes` | `man ECHILD` explains the `ESRCH` substitution and the `"no children: "` prefix; the same for the other six |
| `unknown topic` | per acceptance criterion 9 |
| `no remedies` | no man page contains a remedy instruction; asserted by scanning for the imperative forms the curriculum map reserves for the codex |
| `see also` | every page ends with a `See also:` line and every topic it names resolves |
| `citations` | per acceptance criterion 12 |
| `no invented pages` | every page's text appears in `05-CURRICULUM-MAP.md` |

### `tests/terminal/liveState.test.ts`

| Case | Assertion |
|---|---|
| `ps live` | spawning a process changes `ps` output on the next invocation with no cache flush |
| `free live` | allocating frames changes `free` output |
| `vmstat live` | a burst of page faults changes `vmstat`'s fault rate |
| `iostat live` | queuing disk requests changes `iostat` |
| `pagetable live` | a page load changes `pagetable` output for that address space |
| `sched applies` | `sched srtf` changes `kernel.config.scheduler` through the command bus and the next dispatch follows SRTF |
| `no stale copy` | opening the terminal, stepping 100 ticks, and reading again reflects the new state without reopening |
| `dom batching` | per acceptance criterion 21 |
| `scrollback` | per acceptance criterion 22 |
| `completion` | per acceptance criterion 23 |
| `boundaries` | per acceptance criteria 19 and 20 |

## Out of scope

- The codex. WP-17 owns it. `man` and the codex are different surfaces with
  different rules: `man` says what a choice costs, the codex says what to do.
- The HUD. WP-17 owns it.
- Any leg's command implementations beyond the base set. A leg supplies its own
  `TerminalCommandDef` list and its own handlers through the registry; this
  package builds the registry and the base set.
- `src/kernel/`, `src/world/`, `src/render/`, `src/audio/`, `src/legs/`.
- Writing any man page text. Every word comes from `05-CURRICULUM-MAP.md`.

## Report back

State:

1. Pass or fail for each of the twenty-three acceptance criteria, by number.
2. The three verification command outcomes.
3. The complete list of commands you implemented, and the complete list of names
   from the command set above that the curriculum map does **not** define, which
   you therefore skipped.
4. Any command whose curriculum map definition was ambiguous or internally
   inconsistent, quoted, so a human can fix the source.
5. Any concept or errno topic a player can reasonably type for which the
   curriculum map has no page, so the gap can be filled at the source.
6. Confirmation that no man page text in this package was authored rather than
   sourced.
7. Every `// TODO(astra):` left in the tree, with file and line.

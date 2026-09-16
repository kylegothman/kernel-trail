# Leg scope correction: what every leg package reads after its own

Written by WP-21 on 2026-09-16 from the wave A survey. The fourteen leg
packages were written against an engine that had not shipped, and they make
the same assumptions in the same places. Read this after your own package and
before your pre-flight. Where your package and this document disagree, this
document wins, and your report says which sentence lost.

## 1. The module shape

A leg is `src/legs/<id>/index.ts` with exactly two exports: `export default`
satisfying the frozen `Leg`, and `export const content: LegContent` from
`src/legs/content.ts`. Split the rest across the files your package lists; the
loader reads only the index. `LegContent` carries what `Leg` cannot: the
crossings, an interaction handler and integrity target per `InteractionDef`,
the leg's own epitaph stones, its codex entries in full, handlers for the
deferred terminal names, and a layout. `validateContent(leg, content)` runs
at load in every harness suite and fails naming the problem; call it in your
own `contract.test.ts` as well. Every declared interaction needs a companion
entry, because the director refuses an interaction with no registered handler
as unavailable, and one with an integrity cost needs a target Program.

## 2. Forbidden specifiers, and `createStage` returns `layoutStage`

The loader refuses an index that value-imports `three`, `@world`, `@render`,
`@ui` or `@audio` at module scope, and `tests/legs/content.test.ts` scans every
file under `src/legs` for those names at any scope, type imports included.
`createStage(ctx)` returns `layoutStage(content.layout)`. Your package's anchor
table becomes `content.layout.anchors`: every `InteractionDef.anchor` is one of
them, every anchor that is not an interaction anchor is listed in
`layout.extras`, and `layout.cameraTargets` are anchor ids. The harness's
anchor test passes against that stage with no renderer; the boot package walks
the same layout to build the scene.

## 3. Terminal commands: `registerAll`, and identical re-shipping is a no-op

The host registers `Leg.terminalCommands` through `Shell.registerAll`. WP-15
shipped every definition in the curriculum map, the base fourteen included, so
a leg that re-ships a definition byte for byte registers nothing new and
throws nothing. A definition that differs throws naming the first differing
line. Copy the map's literal; do not reword, reflow or add a section.

## 4. Terminal handlers for non-deferred names are WP-15's

The only handlers a leg writes are for `hyper`, `guest`, `migrate` and
`belady` (`LEG_DEFERRED_COMMANDS` in `src/legs/content.ts`, pinned equal to
the terminal's `DEFERRED_COMMANDS`), through `content.terminalHandlers`. A
package sentence such as "implement `gantt --replay`" means supply the state
and the replay the shipped handler reads, never a second handler. Every other
handler is WP-15's, and `validateContent` rejects a handler for any other name.
`Shell.onCommand(listener)` is the audit hook; the codex and the boot package
listen on it, and a leg does not.

## 5. Codex entries are authored in full in `content.codex`

The curriculum map supplies an id and one line per entry. `content.codex`
carries the whole `CodexEntry`: the leg writes `title`, `concept` (two to four
sentences in the tone guide's register), `chapter` (using the corrected
citations in `00-BUILD-ORDER.md`), `unlock`, `remedy`, `remedyVisibility`,
`related`, `commands` and `epitaphs`; `workedExample` and `counterfactual` are
`null`, and the registry throws on anything else. Eight unlock arms exist:
`affliction`, `termination`, `event`, `objective`, `crossing`, `leg_complete`,
`command` (a name, an optional flag, an optional `nth`) and `metric` (a dotted
telemetry id such as `scheduling.contextSwitches`, strictly `above`). Express
a remaining "Added when" condition with the nearest arm and note the
approximation in a comment on the entry, for example `codex.sjf_optimality`
as `{ kind: 'command', name: 'gantt', flag: '--replay', nth: 3 }` and
`codex.fragmentation` as the `memory.allocation_failed` event. No further arms
are added until real usage shows which are needed.

## 6. The fixture module

`tests/legs/<id>/fixtures.ts` exports exactly `knownGood` and `knownBad`, each
a `LegFixture` from `tests/legs/harness/fixtureContract.ts`. Both carry
`failureMode`: `'casualty'` for a leg with a death path (a Program dies, a
decision is marked `fatal`, `ticksBetween` says roughly when), `'costly'` for
the Boot Sector only (a decision marked `costly`, `survived: true`, and a
`resourceDelta` bound or an `eventTypesPresent` list that proves the failure
happened). `validateFixture` warns when any other leg uses `'costly'`.

## 7. Scripts are `DecisionScript`s

A fixture's `script` is a `DecisionScript` of `ScriptStep`s, never prose: a
tick or a trigger, and a bus `Command`, a crossing id and option, a depot item
or a reclamation trace. Write `crossings: content.crossings` in every script
that steps through a crossing, because `validateScript` is static and does not
read the companion, even though `runLeg` resolves the id from it. The harness
applies the companion at entry; a script's own `interactions` list overrides
the companion's handler for that id with a no-op and the listed target.

## 8. The seed

Every fixture uses `seed: 0x4b54524c`; `validateFixture` warns on any other
value, and the warning has to be explained in the fixture.

## 9. The entering ledger when the predecessor has not shipped

A fixture enters with the previous leg's golden closing ledger. Until that
golden exists, enter with the analytical curve of narrative 5.5, as
`tests/game/economyCurve.test.ts` computes it: start from
`startingLedger(discClass, difficulty).cycles`, and for each earlier leg after
the Boot Sector subtract `Math.round(LEG_SEGMENTS[leg] * 2.5)` and add
`legDividend(index, 1, discClass)`. Quota, blocks and bandwidth stay at the
starting ledger; bandwidth is refilled at entry anyway. For the shell at
operator: `quantum_pass` enters with 1425 cycles, `the_narrows` with 1328,
`allocation_yards` with 1022; the Boot Sector enters with 1600. The fixture
notes that the value is analytical, and the leg replaces it with the golden
closing ledger when the predecessor lands.

## 10. `ProcessSpec` has `serialFraction`

Amendment 1 added `readonly serialFraction?: number` to `ProcessSpec`. The
frozen type in `src/game/types.ts` is the contract; see section 17.4.

## 11. `quantumForPace` is `PACE_TABLE[pace].quantum`

No `quantumForPace` function exists. Read `PACE_TABLE[run.policy.pace].quantum`
from `@game/travel/paceRations` (16, 8, 4, 2). `LegRunner.enter` overwrites
`schedulerParams.quantum` with that value in any case, and the pace binding
writes it into the kernel at entry and again on every pace change, so the
quantum a leg returns from `kernelConfig` is the entry value and nothing more.

## 12. The runner registers the headless factory

`LegRunner.enter` registers the leg's headless factory itself, from the same
`Leg` object. A leg does not edit `src/game/replay/headlessLegs.ts` or
`src/legs/legs.d.ts`; the `TODO(astra)` lines in both stay until the boot
package removes them.

## 13. `REQUIRED_EVENTS`

`tests/legs/harness/requiredEvents.ts` names the events each leg must fire
under the `chaotic` policy, and the smoke suite asserts them for every shipped
leg. A leg whose signature pathology never fires under chaos cannot teach it;
tune the workload, not the table.

## 14. `evaluate` reads payloads through `asKernelEvents`

`LegEvaluationContext.events` is typed as a floor, `{ type }`. The runner
passes the full log. `evaluate` calls `asKernelEvents(ctx.events)` from
`src/legs/events.ts` and reads `pid`, `reason`, `fatal` and the rest typed;
it throws on anything that is not the log.

## 15. Structures are layout kinds

`StructureKind` in `src/legs/layout.ts` is the eight forms of `src/world/forms`
and the eight names of `StructureRegistry.ts` in snake case, plus `custom`
with `structure: '<Name>'` for a structure your package names that the
registry does not have. A leg declares kinds and positions and never
implements a structure; the world-side implementations are the render track's
later package, and the six legs whose structures have no registered factory
declare them `custom`.

## 16. Epitaphs, and hand-off 6

`content.epitaphs` holds the leg's own stones. `sharedEpitaphSource` serves
them alone for a reason any of them names and the shared forty-eight only for
a reason none does, so a pinned cause line (L03's 340 ticks, L04's 210) is the
one that lands. `derezz` still filters by `member` and `legId` afterwards and
throws on an empty candidate list, so a leg that pins a stone to one Program
also ships an unpinned stone for that reason, or one per Program that reason
can take. The shared stones' `codexEntry` ids (`sched.starvation`,
`vm.thrashing` and so on) do not match the map's `codex.*` ids; that is a
resolution-pass item for later, not a leg's.

Hand-off 6: `the_narrows` writes `{ kind: 'manifest_seed', choice: <the
corrupted value> }` as a `DecisionRecord`; `the_archive` reads it and opens
with an intact manifest when it is absent. The journey harness observes it.
Nothing else about the manifest channels exists yet.

## 17. Document errors found in the wave A survey

17.1 **L03's fourteen `SCHED` fixtures are thirteen.** Sim spec 16.3 has
thirteen rows: `FCFS-1`, `FCFS-2`, `SJF-1`, `SJF-1F`, `SRTF-1`, `SRTF-1S`,
`PRIO-1`, `AGING-1A`, `AGING-1B`, `RR-1`, `RR-2a`, `RR-2c`, `MLFQ-1`.

17.2 **L03's reading of `SCHED-RR-2a`.** The fixture is round robin at
quantum 1: ten dispatches, averages 5.666667, 15.666667 and 1.0, and the
shipped RR suite asserts exactly that. L03 offers it as the tuning reference
for the reckless pace, and the curriculum map calls reckless "quantum 1";
reckless is quantum 2 in `PACE_TABLE` and narrative 6.1, so the fixture bounds
the switch-overhead lesson and the reckless-pace numbers are recorded at
implementation, not read from it.

17.3 **L04's semaphore capacity raise.** L04 declares `sem.ford` at capacity 1
and has `narrows.set_capacity` raise it. An `InteractionHandler` mutates
`RunState` only, the syscall table has `sem_wait` and `sem_post` and no
capacity call, and `SyncSubsystem.createSemaphore` fixes capacity at
creation; the interaction as written cannot reach the kernel. WP-L04 proposes
the mechanism in its pre-flight (three declared primitives with the crossing's
`lockId` switched, or an escalation for an accessor) and does not patch the
kernel from the leg.

17.4 **The stale `ProcessSpec` transcriptions.** L00, L03, L04 and L07 paste
`ProcessSpec` without `serialFraction`. The frozen file wins; L02 has it right.

# WP-21: The leg content seam

## Objective

When this package is done, a leg module can carry everything a leg needs that
the frozen `Leg` interface cannot: its crossings, its interaction handlers, its
own epitaph stones, its codex entries, its terminal handlers where it owns a
deferred command, and a renderer-free layout the boot package turns into a
scene later. The harness, the runner, the terminal and the codex read that
companion, the fixture contract admits a known-bad path without a death, the
shared epitaph stones from narrative 9 exist once, and the golden directory
exists. Every one of the fourteen leg packages then writes against a surface
that is on main rather than against four different improvisations.

This package exists because the wave A survey (recorded in the scope
correction below) found that the leg packages were written against an engine
that had not shipped yet. It is small, it touches five packages' files by
exact grant, and no leg starts until it lands.

## Prerequisites

WP-01 through WP-20 complete and green. Main at `672844e` or later.

## Required reading

- `docs/astra/00-LEG-BUILD-ORDER.md` in full, especially the five hand-offs
  table (lines 127 to 140) and the wave 0 items at lines 184 to 193
- `docs/04-NARRATIVE-BIBLE.md` section 9 in full (the forty-eight epitaph
  stones and the `EpitaphTemplate` shape), section 14.2 (codex shapes)
- `docs/05-CURRICULUM-MAP.md` sections 0 and 0.1, and one leg's "Codex
  entries unlocked" block (leg 3 at line 1076) to see what the map supplies
  and what it does not
- `docs/astra/WP-L03-quantum-pass.md` sections "Stage handles", "Interactions",
  "Codex entries", "Evaluation" and "Tests you must write", as the sample of
  what every leg package assumes
- `src/game/types.ts` lines 249 to 384 (`Leg` through `LegStage`)
- `src/game/LegRunner.ts` (`enter`, `resume`, `registerCrossings`,
  `registerInteraction`, `LegRunnerDeps.epitaphs`)
- `src/game/convoy/derezz.ts`, `src/game/codexTypes.ts`,
  `src/ui/codex/entries.ts`, `src/ui/codex/triggers.ts`, `src/ui/codex/Codex.ts`
- `src/terminal/registry.ts`, `src/terminal/Shell.ts`,
  `src/terminal/commands/index.ts`
- `src/legs/registry.ts`, `src/legs/legs.d.ts`
- `tests/legs/harness/loadLeg.ts`, `LegHarness.ts`, `decisionScript.ts`,
  `fixtureContract.ts`, `journey.ts`, `stubFixtures.ts`
- `tests/legs/harness/syntheticLeg.ts` and `tests/game/fixtures/syntheticLeg.ts`

## Files you will create

```
src/legs/content.ts
src/legs/layout.ts
src/legs/epitaphs.ts
src/legs/events.ts
tests/legs/content.test.ts
tests/legs/epitaphs.test.ts
tests/golden/legs/README.md
docs/astra/00-LEG-SCOPE-CORRECTION.md
```

## Files you may modify, each by exact grant quoted in the pre-flight

```
src/legs/legs.d.ts                     (the wildcard gains `export const content: LegContent`)
src/legs/registry.ts                   (LEG_LOADERS type carries the companion; nothing else)
src/game/LegRunner.ts                  (enter gains an optional configure parameter, section 3)
src/game/codexTypes.ts                 (two CodexUnlock arms, section 5)
src/ui/codex/triggers.ts               (the two arms' matching, section 5)
src/ui/codex/Codex.ts                  (the two signals, section 5)
src/terminal/registry.ts               (identical re-registration is a no-op, section 4)
src/terminal/Shell.ts                  (an onCommand listener, section 4)
tests/legs/harness/loadLeg.ts          (returns the companion, section 6)
tests/legs/harness/LegHarness.ts       (applies the companion at entry, section 6)
tests/legs/harness/fixtureContract.ts  (failureMode, section 7)
tests/legs/harness/journey.ts          (one hand-off row, section 8)
tests/legs/harness/syntheticLeg.ts     (ships a companion, section 6)
tests/legs/harness.test.ts             (cases for the above; quote-and-wait, pre-ruled)
```

Nothing else. The frozen files are not touched; `Leg` stays as it is, and
that is the point: the companion sits beside it.

## Specification

### 1. `src/legs/content.ts`, the companion

```ts
export interface LegContent {
  readonly legId: LegId;
  /** Declared through the runner at entry; formulas are WP-19's. */
  readonly crossings: readonly CrossingDef[];
  /** Keyed by InteractionDef.id; the target names the Program an integrity cost lands on. */
  readonly interactions: Readonly<Record<string, { readonly run: InteractionHandler; readonly target: ConvoyMemberId | null }>>;
  /** This leg's own stones only; the shared forty-eight live in src/legs/epitaphs.ts. */
  readonly epitaphs: readonly EpitaphTemplate[];
  /** Registered into the codex registry by the host; concept text is the leg's. */
  readonly codex: readonly CodexEntry[];
  /** Only for a name in DEFERRED_COMMANDS that this leg owns. */
  readonly terminalHandlers: Readonly<Record<string, CommandRun>>;
  /** Renderer-free; the boot package builds the scene from it. */
  readonly layout: LegLayout;
}

export interface LegModule {
  readonly default: Leg;
  readonly content: LegContent;
}

export function validateContent(leg: Leg, content: LegContent): readonly string[];
```

`validateContent` returns problems: `legId` mismatch; a crossing whose
`legId` differs or whose `lockId` the leg never declares (checked by running
`populate` against a recording `LegSetupContext` you write here, not a
kernel); an interaction id the leg does not declare, or a declared interaction
with an integrity cost and no target; a codex entry whose `unlock` names an
objective the leg does not declare; a terminal handler for a name not in
`DEFERRED_COMMANDS`; a layout anchor set that does not equal the set of
`InteractionDef.anchor` values plus the layout's own declared extras.

`src/legs/content.ts` imports types only from `@game`, `@kernel` and
`@terminal`, and values only from `./layout`. The loader's forbidden list
(`three`, `@world`, `@render`, `@ui`, `@audio`) applies to it as to a leg.

### 2. `src/legs/layout.ts`, the stage without a renderer

```ts
export type StructureKind =
  | 'grid_floor' | 'stele' | 'slab' | 'page_plate' | 'resource_ring' | 'beam' | 'hex_tile' | 'horizon'
  | 'frame_vault' | 'ready_queue_procession' | 'wait_for_ring' | 'platter_stack' | 'page_ocean'
  | 'bus_spine' | 'archive_shelves' | 'domain_rings' | 'custom';

export interface LayoutAnchor {
  readonly id: string;                 // an InteractionDef.anchor or a camera target
  readonly kind: StructureKind;
  readonly position: readonly [number, number, number];
  readonly facing?: readonly [number, number, number];
  /** For 'custom': the name the boot package's structure registry must supply. */
  readonly structure?: string;
  readonly label?: string;
}

export interface LegLayout {
  readonly anchors: readonly LayoutAnchor[];
  readonly cameraTargets: readonly string[];   // anchor ids the focus camera may frame
  readonly extras: readonly string[];          // anchor ids that are not interaction anchors
}

/** A LegStage over the layout: anchor(id) returns the LayoutAnchor, update and dispose do nothing. */
export function layoutStage(layout: LegLayout): LegStage;
```

The eight `snake_case` structure kinds after the forms are the eight names in
`src/world/structures/base/StructureRegistry.ts`, lower-cased; the eight forms
before them are `src/world/forms`. A leg's `createStage(ctx)` returns
`layoutStage(content.layout)`, which satisfies the harness's anchor test
without `three`, and the boot package (a later package) walks the same layout
to build the real scene with `StageBuilder`. The kinds list is the contract
the render track implements against; do not add a kind a leg has not asked
for.

### 3. The runner reads the companion at entry

`LegRunner.resume` already takes `configure?: (runner, leg) => void`. Give
`enter(leg, opts, configure?)` the same optional third parameter, called after
the director exists and before the first tick, so a caller registers
crossings and interactions there. Add to `LegRunner` one helper
`applyContent(content: LegContent): void` that calls `registerCrossings`,
`registerInteraction` for each entry, and nothing else; the epitaph source
and the codex entries are host concerns (sections 5 and 8). Quote the diff.

### 4. Terminal: legs re-ship base definitions, and the shell tells the codex

`CommandRegistry.register` throws on a name already registered. Every wave A
leg transcribes definitions WP-15 already shipped, five of which are base
commands. Change `register` so a definition byte-identical to the one already
registered is a no-op, and a differing one still throws with both texts'
first differing line in the message. `Shell.registerAll(leg.terminalCommands)`
then works for every leg with no leg-side special case.

Add `Shell.onCommand(listener: (name: string, argv: readonly string[], result: CommandResult) => void): () => void`,
called after every successful or failed submission. It is the audit hook
WP-19's R3 named as missing; the codex uses it (section 5) and the boot
package uses it for the `kernel_space` read-cost rule.

### 5. Codex: two unlock arms the leg packages need

`src/game/codexTypes.ts` is not frozen. Add to `CodexUnlock`:

```ts
  | { readonly kind: 'command'; readonly name: string; readonly flag?: string; readonly nth?: number }
  | { readonly kind: 'metric'; readonly id: string; readonly above: number }
```

and to `CodexSignal` in `triggers.ts` the matching `{ kind: 'command'; name;
argv }` and `{ kind: 'metric'; id; value }`, with `matchesUnlock` counting
`nth` occurrences per entry and comparing `above` strictly. `Codex.signal`
accepts both. The `metric` ids are the dotted keys `HudTelemetry` and
`ObservedLeg` already use (`scheduling.contextSwitches`,
`memory.faultRate`, and so on); the host feeds them from the telemetry store
once per tick. The leg packages' "Added when" tables ("first `gantt
--metrics`", "context switch overhead above 15 percent") are then expressible;
list in the report any condition in the four wave A tables that still is not.

The curriculum map supplies only an id and a summary line per entry, so a
leg's `content.codex` carries the full `CodexEntry` with the leg writing
`concept` (two to four sentences), `chapter`, `unlock`, `related`,
`commands` and `epitaphs`, and `workedExample` and `counterfactual` null.
Say so in the scope correction.

### 6. The harness applies the companion

`tryLoadLegForTest` returns `{ leg, content, shipped: true }` and asserts
`validateContent` is empty at load, naming the problem. `runLeg` calls
`applyContent` through the new `enter` parameter, builds its epitaph source
as the leg's stones over the shared forty-eight (`src/legs/epitaphs.ts`), and
still lets a `DecisionScript`'s own `crossings` and `interactions` add to or
override the companion's. The composite synthetic leg gains a companion so
the harness suite exercises the path; the `tests/game` fixture is not
touched.

### 7. Fixture contract: a known-bad path may be costly rather than fatal

Add `readonly failureMode: 'casualty' | 'costly'` to `LegFixture`. With
`'casualty'` the current three rules stand. With `'costly'` the expectation
must instead name at least one `decisionOutcomes` entry with `outcome:
'costly'`, `survived: true`, and a `resourceDelta` bound or an
`eventTypesPresent` list that proves the failure happened. The Boot Sector
has no death path by design and is the case this exists for; `validateFixture`
warns when a leg other than `boot_sector` uses `'costly'`.

### 8. Epitaph stones, shared, and one hand-off row

`src/legs/epitaphs.ts` transcribes the forty-eight stones of narrative 9.3
verbatim as `readonly EpitaphTemplate[]`, ids as the bible gives them, and
exports `sharedEpitaphSource(extra: readonly EpitaphTemplate[]): EpitaphCopySource`
which serves the extras first for a reason and then the shared stones.
`tests/legs/epitaphs.test.ts` asserts the count per reason matches 9.4's
coverage table, that every `codexEntry` is a string, that no inscription
contains a dash or a forbidden term, and that `{NAME}` appears where 9.1 says
it must.

`tests/legs/harness/journey.ts` gains one row to `HANDOFFS`: hand-off 6,
producer `the_narrows`, consumer `the_archive`, kinds `['manifest_seed']`,
default "the archive opens with an intact manifest". WP-L04 writes it as a
`DecisionRecord` with `choice` the corrupted value; nothing else about the
manifest channels is built here.

### 9. Golden directory and the shared events guard

`tests/golden/legs/README.md` states the two file names, that recording is a
human action through `golden:record`, and that a regenerated golden is a
behaviour change reviewed as one. The directory otherwise stays empty.

`src/legs/events.ts` exports `asKernelEvents(events: readonly { readonly type: string }[]): readonly KernelEvent[]`,
a typed narrowing of `LegEvaluationContext.events` for the runtime fact that
the runner passes the full log. Every leg's `evaluate` reads payloads through
it; the frozen type stays a floor.

### 10. `docs/astra/00-LEG-SCOPE-CORRECTION.md`

Write the common scope correction every leg package reads after its own
document, in the numbered-decision style of the engine packages, covering:
the module shape (`src/legs/<id>/index.ts`, default export plus `content`);
the loader's forbidden specifiers and that `createStage` returns
`layoutStage`; that `Leg.terminalCommands` is registered through
`registerAll` and identical re-shipping is a no-op; that terminal handlers for
non-deferred names are WP-15's and a leg does not write them; that codex
entries are authored in full in `content.codex`; that the fixture module is
`tests/legs/<id>/fixtures.ts` exporting exactly `knownGood` and `knownBad`,
that scripts are `DecisionScript`s and not prose, that the seed is
`0x4b54524c`, and that a wave A leg whose predecessor has not shipped enters
with `startingLedger` less the analytical 5.5 curve's cumulative cost through
the previous leg (the fixture notes it and the leg updates it when the
predecessor lands); that `ProcessSpec` has `serialFraction`; that
`quantumForPace` is `PACE_TABLE[pace].quantum` and the pace binding sets the
quantum at entry; that the runner registers the headless factory itself and
legs do not touch `headlessLegs.ts` or `legs.d.ts`; that `REQUIRED_EVENTS`
names the events each leg must fire under `chaotic`; that `evaluate` reads
payloads through `asKernelEvents`; that structures are layout kinds and the
world-side implementations are the render track's later package; and the
document errors found in the wave A survey (L03's "fourteen" `SCHED` fixtures
are thirteen; L03's reading of `SCHED-RR-2a`; L04's semaphore capacity
raise; the stale `ProcessSpec` transcriptions). Keep it under 250 lines.

## Acceptance criteria

1. The four gates exit 0 on every commit.
2. `validateContent` names each of its six problem kinds on a failing
   fixture and returns empty for the composite synthetic leg's companion.
3. `layoutStage(layout).anchor(id)` returns the `LayoutAnchor` for every
   declared id and `null` otherwise; `update` and `dispose` are no-ops.
4. `LegRunner.enter(leg, opts, configure)` calls `configure` after the
   director exists and before the first tick; `applyContent` registers every
   crossing and interaction, asserted with spies.
5. `CommandRegistry.register` accepts a byte-identical re-registration and
   throws on a differing one naming the first differing line; every wave A
   command name (`man`, `syscall`, `mode`, `sched`, `nice`, `gantt`, `lock`,
   `race`, `trace`, `free`, `pagetable`, `tlb`, `frag`) re-registers cleanly
   from the curriculum map text.
6. `Shell.onCommand` fires once per submission with the result.
7. The `command` and `metric` unlock arms match through `Codex.signal`, with
   `nth` counted per entry and `above` strict; the existing six arms are
   unchanged and `tests/ui/codex.test.ts` passes without modification.
8. `tryLoadLegForTest` returns the companion and fails at load on a
   `validateContent` problem naming it.
9. `runLeg` applies the companion; the composite synthetic leg's crossing is
   resolvable from its companion with no `HarnessOptions.crossings`.
10. `LegFixture.failureMode: 'costly'` is accepted with the section 7 rules
    and warns for a leg other than `boot_sector`.
11. `src/legs/epitaphs.ts` holds forty-eight stones with the per-reason counts
    of narrative 9.4, no dashes, no forbidden terms.
12. `sharedEpitaphSource(extras)` serves a leg's own stone for a reason before
    a shared one, asserted with a `legId`-pinned extra.
13. Hand-off 6 is in `HANDOFFS` and the journey's `HandoffObservation` reports
    it.
14. `tests/golden/legs/README.md` exists and the directory holds nothing else.
15. `asKernelEvents` narrows a `KernelEvent[]` unchanged and throws on an
    element with no `tick`.
16. `docs/astra/00-LEG-SCOPE-CORRECTION.md` exists, under 250 lines, no em
    dashes, and covers every item in section 10.
17. Nothing under `src/legs/` imports `three`, `@world`, `@render`, `@ui` or
    `@audio` at any scope, asserted by a scan.
18. `git diff --exit-code` on the four frozen files exits 0.

## Report back

1. Pass or fail for the eighteen criteria, by number.
2. The four gate outcomes and the test count before and after.
3. Every granted edit as a diff, quoted.
4. The wave A "Added when" conditions that the two new unlock arms still
   cannot express, if any.
5. Every `TODO(astra)` left in the tree, with file and line.
6. Anything in the leg packages you read that the scope correction should
   have covered and does not.

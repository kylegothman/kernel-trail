# WP-20: The headless smoke-test harness and the golden runs

## Objective

When this package is done, any leg can be constructed by id, driven to completion
with no renderer and no DOM, fed a scripted decision sequence, checked against an
expected `LegOutcome`, and diffed against a checked-in golden event log. The
fourteen-leg journey can be run end to end and asserted byte-identical across two
runs, and one CI command runs every leg's golden playthrough.

Every one of the fourteen leg packages has an acceptance criterion that reads
"the leg runs headlessly to completion via the smoke-test harness". This package
is that harness. Until it exists, fourteen acceptance criteria cannot be
evaluated, so it is the second half of the gate that WP-19 opens.

The harness is a test-time tool. It ships nothing into the bundle, it is never
imported from `src/`, and it holds no game logic of its own: it drives WP-19's
`LegRunner` and asserts what comes out. A harness that reimplements a travel loop
so a leg can be tested against it is testing the harness.

## Prerequisites

WP-19 complete and green. WP-11, WP-17 and WP-18 complete and green.

Files that must already exist:

- `src/game/LegRunner.ts`, `RunDirector.ts` and `LegSandbox.ts` from WP-19
- `src/game/crossing/`, `depot/`, `reclamation/`, `events/`, `travel/` from WP-19
- `src/kernel/index.ts` exporting `createKernel`, `snapshot()` and `restore()`
- `src/legs/registry.ts`, the leg id to dynamic import map, from the scaffold
- `tests/kernel/canonical.ts` from WP-01, giving `canonicalise` and `fnv1a64`
- `tests/kernel/fixtures/referenceConfig.ts` from WP-01

## Required reading

- `01-ARCHITECTURE.md` section 11 in full: 11.1 (Vitest in a node environment,
  kernel and game layers only, and the coverage thresholds), 11.2 (the
  determinism test and what its last case catches), 11.4 (the golden-file
  pattern and the four ASCII renderers), 11.5 (the leg smoke harness as first
  drafted, including `SmokeResult`, `SmokeOptions` and the `REQUIRED_EVENTS`
  table you must ship), 11.6 (the contract freeze tests), 11.7 (what is
  deliberately not tested and why)
- `01-ARCHITECTURE.md` section 10.5, `LegSandbox`, so the harness reports a leg
  failure rather than swallowing it
- `01-ARCHITECTURE.md` section 8, save, load and replay, for the snapshot and
  restore behaviour the journey test asserts at every leg boundary
- `01-ARCHITECTURE.md` section 2.3, so the harness's tick loop matches the game
  loop's ordering exactly
- `WP-19-leg-runner-and-travel-loop.md` in full. The harness's whole job is to
  drive that package.
- `00-LEG-BUILD-ORDER.md`, the five hand-offs table, because the journey test is
  the only place all five are exercised against real producers
- `04-NARRATIVE-BIBLE.md` section 12.4, the crossing schedule, so the harness
  knows which legs must report crossings

## Files you will create

```
tests/legs/harness/index.ts
tests/legs/harness/LegHarness.ts
tests/legs/harness/loadLeg.ts
tests/legs/harness/makeRunState.ts
tests/legs/harness/scriptedDecisions.ts
tests/legs/harness/decisionScript.ts
tests/legs/harness/expectOutcome.ts
tests/legs/harness/goldenLog.ts
tests/legs/harness/journey.ts
tests/legs/harness/requiredEvents.ts
tests/legs/harness/fixtureContract.ts
tests/legs/harness/stubFixtures.ts
tests/legs/smoke.test.ts
tests/legs/goldens.test.ts
tests/legs/journey.test.ts
tests/legs/harness.test.ts
tools/golden/record.ts
tools/golden/diff.ts
tools/golden/renderEventLog.ts
tools/ci/legGoldens.mjs
```

Golden files are written by the tooling, not typed by hand:

```
tests/golden/legs/<leg_id>.good.events.txt
tests/golden/legs/<leg_id>.good.hash.txt
tests/golden/legs/<leg_id>.bad.events.txt
tests/golden/legs/<leg_id>.bad.hash.txt
tests/golden/legs/journey.hash.txt
tests/golden/legs/journey.ledger.txt
```

## Files you may modify

```
package.json    (add the five scripts named in section 9. Nothing else.)
vitest.config.ts (add tests/legs to include, and the coverage entry for
                  src/game/. Nothing else.)
```

Nothing else. The harness never writes to `src/`.

## Frozen contracts

From `src/game/types.ts`. These may not be edited.

```ts
export type LegId =
  | 'boot_sector' | 'fork_fields' | 'the_weave' | 'quantum_pass'
  | 'the_narrows' | 'the_cistern' | 'the_gridlock' | 'allocation_yards'
  | 'drowned_reach' | 'the_platters' | 'the_bus' | 'the_archive'
  | 'arbiter_wall' | 'the_portal';

export const LEG_ORDER: readonly LegId[] = [ /* the fourteen, in journey order */ ];

export interface Leg {
  readonly id: LegId;
  readonly index: number;
  readonly title: string;
  readonly subtitle: string;
  readonly chapters: readonly ChapterRef[];
  readonly objectives: readonly LearningObjective[];
  kernelConfig(run: RunState): KernelConfig;
  populate(ctx: LegSetupContext): void;
  createStage(ctx: StageContext): LegStage;
  readonly interactions: readonly InteractionDef[];
  readonly terminalCommands: readonly TerminalCommandDef[];
  readonly eventTable: readonly RandomEventDef[];
  evaluate(ctx: LegEvaluationContext): LegOutcome;
}

export interface LegOutcome {
  readonly survived: boolean;
  readonly objectivesMet: readonly string[];
  readonly casualties: readonly ConvoyMemberId[];
  readonly resourceDelta: Partial<ResourceLedger>;
  readonly codexUnlocked: readonly string[];
  readonly debrief: DebriefCard;
}

export interface DebriefCard {
  readonly headline: string;
  readonly whatHappened: string;
  readonly whyItHappened: string;
  readonly counterfactual: string | null;
  readonly chapter: ChapterRef;
}

export interface RunState { /* as frozen; see WP-19 for the full paste */ }

export interface DecisionRecord {
  readonly tick: Tick;
  readonly legId: LegId;
  readonly kind: string;
  readonly choice: string;
  outcome: 'good' | 'costly' | 'fatal' | 'pending';
  readonly relatedObjective: string | null;
}

export interface SaveFile {
  readonly version: 1;
  readonly savedAtIso: string;
  readonly run: RunState;
  readonly kernel: KernelSnapshot | null;
  readonly rngStates: readonly RngState[];
  readonly checksum: string;
}
```

From WP-17's `CommandBus`, which the scripted decision sequence dispatches
through:

```ts
export type Command =
  | { readonly kind: 'set_scheduler'; readonly to: SchedulerId; readonly quantum?: number }
  | { readonly kind: 'set_replacement'; readonly to: PageReplacementId }
  | { readonly kind: 'set_disk_policy'; readonly to: DiskSchedulingId }
  | { readonly kind: 'set_allocation'; readonly to: AllocationStrategy }
  | { readonly kind: 'set_pace'; readonly to: Pace }
  | { readonly kind: 'set_rations'; readonly to: Rations }
  | { readonly kind: 'set_degree'; readonly to: number }
  | { readonly kind: 'use_ability'; readonly member: ConvoyMemberId; readonly target: number | null }
  | { readonly kind: 'syscall'; readonly request: SyscallRequest }
  | { readonly kind: 'interaction'; readonly id: string; readonly anchor: string }
  | { readonly kind: 'terminal'; readonly line: string };

export interface CommandOrigin {
  readonly source: 'hud' | 'world' | 'terminal' | 'replay';
  readonly legId: LegId;
}
```

`CommandOrigin.source` accepts `'replay'` and the harness uses exactly that, so a
scripted run is indistinguishable from a replayed one in the decision log.

## Specification

### 1. `tests/legs/harness/loadLeg.ts`

Construct any leg by id.

```ts
export interface LoadResult {
  readonly leg: Leg;
  readonly shipped: true;
}
export interface MissingResult {
  readonly leg: null;
  readonly shipped: false;
  readonly reason: string;
}

export async function loadLegForTest(id: LegId): Promise<Leg>;
export async function tryLoadLegForTest(id: LegId): Promise<LoadResult | MissingResult>;
export async function loadAllShippedLegs(): Promise<readonly Leg[]>;
```

Rules:

- Loading goes through `src/legs/registry.ts`, the scaffold's leg id to dynamic
  import map. Do not build a second map and do not deep-import a leg's
  `index.ts`. A leg imports as its default export, which is the one place in the
  repository a default export is permitted.
- `loadLegForTest` throws with the leg id in the message when the leg has not
  shipped. `tryLoadLegForTest` returns `shipped: false` instead. Every suite in
  this package iterates with `tryLoad`, skips the unshipped legs, and prints one
  line per skip. **Fourteen legs will be built over four waves and the suite must
  be green at every point in between.** A suite that fails because leg 11 does
  not exist yet is a suite nobody runs.
- On load, assert the shape immediately: `leg.id` equals the id it was loaded
  under, `leg.index` equals its position in `LEG_ORDER`, and every member of the
  `Leg` interface is present and of the right kind. A leg that fails this fails
  before anything else runs, with a message naming the field.
- The loader must not touch `@world`, `@render`, `@ui`, `@audio` or `three`. A
  leg whose `index.ts` pulls one of those at module scope fails here with a clear
  message, which is a real integration break and the earliest place to catch it.

### 2. `tests/legs/harness/makeRunState.ts`

```ts
export interface RunStateOptions {
  readonly seed: number;
  readonly legIndex: number;
  readonly discClass?: DiscClass;
  readonly difficulty?: DifficultyTier;
  readonly pace?: Pace;
  readonly rations?: Rations;
  readonly degree?: number;
  /** The closing ledger of the previous leg's golden run. */
  readonly ledger?: Partial<ResourceLedger>;
  /** Records a previous leg wrote that this leg reads. See section 8. */
  readonly decisions?: readonly DecisionRecord[];
  readonly convoy?: readonly Partial<ConvoyMember>[];
}

export function makeRunState(opts: RunStateOptions): RunState;
export function makeConvoy(): ConvoyMember[];
```

Defaults are `discClass: 'shell'`, `difficulty: 'operator'`, `pace: 'steady'`,
`rations: 'standard'`, degree from the leg's own config, and the starting ledger
from WP-19's `startingLedger`. The five Programs are LUMEN, SABLE, ORRERY,
KESTREL and VESPER at 100 integrity with no afflictions, in that order.

`makeRunState` builds a real `RunState`, not a partial one. Every leg package's
`golden.test.ts` enters with the previous leg's closing ledger, and passing a
half-built object would make each leg's golden run depend on which fields the
harness happened to fill.

### 3. `tests/legs/harness/decisionScript.ts`

The scripted decision sequence. This is the thing a leg package's known-good and
known-bad fixtures are written in.

```ts
/** One scripted player action, scheduled by tick or by a condition. */
export type ScriptStep =
  | { readonly at: number; readonly command: Command }
  | { readonly when: ScriptTrigger; readonly command: Command }
  | { readonly at: number; readonly crossing: string; readonly option: CrossingOption }
  | { readonly at: number; readonly depot: DepotItemId; readonly target: ConvoyMemberId | null }
  | { readonly at: number; readonly reclamation: ReclamationTrace };

/** Conditions the script can wait on, all read from live state. */
export type ScriptTrigger =
  | { readonly kind: 'event'; readonly type: string }
  | { readonly kind: 'event'; readonly type: string; readonly nth: number }
  | { readonly kind: 'integrity_below'; readonly member: ConvoyMemberId; readonly value: number }
  | { readonly kind: 'affliction'; readonly id: AfflictionId }
  | { readonly kind: 'progress_at_least'; readonly value: number }
  | { readonly kind: 'resource_below'; readonly resource: ResourceKind; readonly value: number };

export interface DecisionScript {
  readonly legId: LegId;
  readonly label: string;
  readonly steps: readonly ScriptStep[];
}

export function validateScript(script: DecisionScript): readonly string[];
```

Rules:

- **A step scheduled `at` a tick fires immediately before that tick**, in the
  same slot the `CommandBus` drains in, so a scripted run and a player run land
  their decisions at the same point in the frame. Architecture 2.2 is explicit
  that commands apply at tick boundaries only, and the harness does not get an
  exception.
- **A step scheduled `when` a trigger fires fires immediately before the next
  tick after the trigger became true.** It fires once. A trigger that never
  becomes true leaves its step unfired and the harness reports it, because a
  known-good sequence with an unfired step is a fixture that stopped describing
  the leg.
- **Steps at the same tick fire in declared order.** Do not sort.
- `validateScript` returns problems rather than throwing: a step at a negative
  tick, two steps at the same tick with contradictory commands, a crossing id
  the leg does not declare, a depot purchase on a leg with no depot.
- The script contains no assertions. It describes what the player did. What the
  run should produce is `expectOutcome`'s job.

`ScriptedDecisions` in `scriptedDecisions.ts` executes a script against a live
`LegRunner`, dispatching each command through WP-17's `CommandBus` with
`origin: { source: 'replay', legId }`, so the resulting `RunState.decisions` is
the same shape a real session would produce and the run is replayable.

Also ship the three stand-in policies from architecture 11.5, for smoke runs that
have no fixture yet:

| Policy | Behaviour |
|---|---|
| `passive` | dispatches nothing; the convoy travels on its entry settings |
| `competent` | applies the remedy for any affliction acquired, keeps the degree inside the leg's safe band, takes the cheapest viable crossing option |
| `chaotic` | changes policy every 40 ticks from a seeded rotation, designed to trigger each leg's signature pathology |

`competent` must not read a leg's known-good fixture. It is a generic policy and
its whole value is that it is generic.

### 4. `tests/legs/harness/LegHarness.ts`

Drive a leg to completion with no renderer and no DOM.

```ts
export interface HarnessOptions {
  readonly seed: number;
  readonly maxTicks?: number;              // default 20_000
  readonly script?: DecisionScript;
  readonly policy?: 'passive' | 'competent' | 'chaotic';
  readonly run?: RunState;
  /** Snapshot and restore at this tick, then continue. Used by the determinism cases. */
  readonly restoreAt?: number;
  readonly recordEvents?: boolean;         // default true
}

export interface HarnessResult {
  readonly legId: LegId;
  readonly ticks: number;
  readonly events: readonly KernelEvent[];
  readonly eventTypes: ReadonlySet<string>;
  readonly outcome: LegOutcome;
  readonly run: RunState;
  readonly ledgerBefore: ResourceLedger;
  readonly ledgerAfter: ResourceLedger;
  readonly decisions: readonly DecisionRecord[];
  readonly crossings: readonly CrossingResult[];
  readonly panics: readonly string[];
  readonly legFailures: readonly LegFailure[];
  readonly unfiredSteps: readonly ScriptStep[];
  readonly logHash: string;
  readonly wallMs: number;
  readonly maxTickMs: number;
}

export async function runLeg(leg: Leg, opts: HarnessOptions): Promise<HarnessResult>;
```

The loop, which mirrors architecture 2.3's fixed step with the render half
removed:

1. Build the `RunState` (given, or from `makeRunState`).
2. Construct a `LegRunner` with a real kernel factory, a real `CommandBus`, a
   real `RunStore`, a `LegSandbox` around the leg, and `stageContext: null`.
3. `runner.enter(leg, { maxTicks, stageContext: null })`.
4. Per tick: fire the script's due steps into the `CommandBus`, drain the bus,
   `runner.preTick(tick)`, `kernel.step()`, `runner.postTick(tick, events)`.
5. Stop on `runner.finished`, on a `kernel.panic`, or at `maxTicks`.
6. `runner.exit()` for the `LegOutcome`.
7. Hash the canonical event log with WP-01's `canonicalise` and `fnv1a64`.

Rules the harness must hold to:

- **No renderer and no DOM.** `stageContext` is null, `createStage` is never
  called, and the harness asserts that `globalThis.document` and
  `globalThis.window` are undefined at the point it runs. Vitest runs in the node
  environment per architecture 11.1, so they are, and asserting it catches a
  config drift that would silently let a leg pull `@world` in.
- **`createStage` is exercised separately**, in the anchor test of section 6, not
  in the run loop. That test is the one that catches the most common integration
  break, so it must exist, and it must not be in the path of a golden run.
- **A leg failure is reported, never swallowed.** `LegSandbox`'s diagnostics land
  in `legFailures` and any suite that finds a non-empty list fails.
- **A `kernel.panic` stops the run and is reported.** It is never a pass.
- **`maxTickMs` is measured and asserted** against architecture 7.1's budget with
  slack, at 2 ms. The harness may read `performance.now`, which is a test-time
  measurement and never feeds a result.
- **`restoreAt` snapshots at that tick, builds a second kernel, restores, and
  continues**, so the determinism cases can assert that a mid-leg save and load
  changes nothing. The remainder of the run must hash identically to the
  uninterrupted remainder.

### 5. `tests/legs/harness/expectOutcome.ts`

Assert an expected `LegOutcome` without asserting the whole of it, because a leg
package cares about six fields and not about the exact prose of its own headline.

```ts
export interface OutcomeExpectation {
  readonly survived?: boolean;
  readonly objectivesMet?: readonly string[];      // exact set, order-insensitive
  readonly objectivesAtLeast?: readonly string[];  // subset
  readonly casualties?: readonly ConvoyMemberId[]; // exact set
  readonly casualtyCount?: number;
  readonly codexUnlocked?: readonly string[];
  readonly resourceDelta?: Partial<Record<keyof ResourceLedger, { min?: number; max?: number }>>;
  readonly debrief?: {
    readonly headlineMatches?: RegExp;
    readonly counterfactualPresent?: boolean;
    readonly chapter?: { readonly chapter: number; readonly sections: readonly string[] };
  };
  readonly ticksBetween?: readonly [number, number];
  readonly eventTypesPresent?: readonly string[];
  readonly eventTypesAbsent?: readonly string[];
  readonly decisionOutcomes?: readonly { readonly kind: string; readonly outcome: DecisionRecord['outcome'] }[];
}

export function expectOutcome(result: HarnessResult, expected: OutcomeExpectation): void;
```

Rules:

- Every field is optional and an omitted field is not checked. A leg asserts what
  it means.
- Set comparisons are order-insensitive and report the symmetric difference on
  failure, both directions, named. `expected X, got Y` on two 9-element arrays is
  not a usable failure message.
- `eventTypesAbsent` exists for the Cistern, whose most important assertion is
  that `deadlock.detected` never fires while a five-pid cycle is standing. A
  harness that could only assert presence could not express that leg.
- `debrief.chapter` compares chapter and sections and ignores the title, because
  titles are copy and the citation is the teaching.
- The failure message always includes the leg id, the seed, the tick count and
  the log hash, so a failing CI run can be reproduced from its own output with no
  further digging.

### 6. `tests/legs/smoke.test.ts`

The suite every leg's acceptance criterion 2 refers to. It runs for every shipped
leg and skips the rest with a printed line.

Per leg, three seeds, `1`, `17` and `2026`, with the `competent` policy:

| Assertion | Value |
|---|---|
| panics | empty |
| leg failures | empty |
| ticks | above 50 and below `maxTicks` |
| events | above 100 |
| `outcome.debrief.headline` | non-empty |
| `maxTickMs` | under 2 |
| `wallMs` | under 1000 |
| `outcome.debrief.chapter` | a chapter number and at least one section, both drawn from the leg's declared chapters |

Then, once per leg:

- **Required events.** With the `chaotic` policy at seed 4, every event type in
  `requiredEvents.ts` fires. Ship architecture 11.5's `REQUIRED_EVENTS` table
  verbatim, all fourteen rows. A leg whose signature pathology never fires cannot
  teach it, and this is the assertion that catches it.
- **Anchors resolve.** Call `createStage({ quality: 'low', run })` and assert
  every `InteractionDef.anchor` resolves to a non-null value, then `dispose()`.
  This runs in the node environment because `@world` structure factories build
  their scene graph lazily and nothing renders; structures that genuinely need a
  GPU come from a `MaterialLibrary` that returns stubs when
  `globalThis.WebGL2RenderingContext` is undefined. This is the single most
  common integration break in the project.
- **Inert fields.** Every `KernelConfig` field the leg does not enable is never
  read. Drive 400 ticks with each inert field set to a poison value and assert
  the log hash is unchanged. Every leg package has this as its own criterion and
  the harness supplies the mechanism.
- **Event table.** `validateTable(leg.eventTable)` returns empty: weights are
  positive integers summing to exactly 100 and ids are unique.
- **All four paces.** The leg completes at `conservative`, `steady`, `aggressive`
  and `reckless` with no panic and no leg failure. Four leg packages assert this
  themselves and the harness must make it one line.

### 7. Golden runs

#### 7.1 What a golden file holds

Two files per run, per leg, per path.

`<leg_id>.<path>.events.txt` is a human-readable canonical event log, one event
per line, produced by `tools/golden/renderEventLog.ts`:

```
tick     seq  type                     payload
   0       1  process.created          pid=1 name=LUMEN priority=3
   0       2  process.created          pid=2 name=SABLE priority=3
   4      11  context.switch           from=1 to=2 reason=quantum
   4      12  quantum.expired          pid=1 quantum=8
```

Fields are the event's own, in the frozen union's declared field order,
`key=value` separated by a single space, with no locale formatting anywhere. The
file is readable in a pull request, which is the entire point: a behaviour change
shows up as a diff a reviewer can judge rather than as a changed hash.

`<leg_id>.<path>.hash.txt` holds one line: the `fnv1a64` of the canonical
serialisation of the same log. The hash is what the test asserts and the rendered
log is what a human reads to find out why it changed. Assert the hash; print the
first differing line of the rendered log on failure.

#### 7.2 `tests/legs/goldens.test.ts`

For every shipped leg, for each of its two fixtures:

1. Run it. Assert the hash against the checked-in file.
2. Run it a second time in the same process. Assert the two hashes match, which
   catches state leaking between runs through a module-level cache.
3. Run it with `restoreAt` at the midpoint. Assert the remainder hashes
   identically to the uninterrupted remainder.
4. Assert the fixture's `OutcomeExpectation`.

A missing golden file is a failure, not a silent record. Recording is an explicit
action, section 7.4.

#### 7.3 The fixture contract

Each leg package supplies its own fixtures at
`tests/legs/<leg_id>/fixtures.ts`, exporting exactly two names. This package
defines the type and the loader; it does not write the fixtures.

```ts
// tests/legs/harness/fixtureContract.ts
export interface LegFixture {
  readonly legId: LegId;
  readonly path: 'good' | 'bad';
  readonly seed: number;
  readonly discClass: DiscClass;
  readonly difficulty: DifficultyTier;
  readonly pace: Pace;
  readonly rations: Rations;
  /** The previous leg's golden closing ledger, or the starting ledger for leg 0. */
  readonly enteringLedger: Partial<ResourceLedger>;
  /** DecisionRecords a previous leg wrote that this leg reads. Empty for most legs. */
  readonly enteringDecisions: readonly DecisionRecord[];
  readonly script: DecisionScript;
  readonly expect: OutcomeExpectation;
}

export interface LegFixtureModule {
  readonly knownGood: LegFixture;
  readonly knownBad: LegFixture;
}

export async function loadFixtures(id: LegId): Promise<LegFixtureModule | null>;
export function validateFixture(f: LegFixture): readonly string[];
```

**Every leg must supply both.** The rules, which every leg package's fixture is
checked against by `validateFixture`:

- **The known-good sequence meets every one of the leg's declared objectives.**
  If a leg declares six objectives, its known-good run meets six. This is the
  assertion that proves the leg is winnable by understanding rather than by luck.
- **The known-bad sequence produces the leg's intended failure**, and the
  expectation says which: which Program dies, of what, roughly when, and which
  decision is marked `fatal`. A known-bad path that merely scores lower is not a
  known-bad path.
- **Both use seed `0x4b54524c`** unless the leg documents a reason. Every shipped
  leg package already names that seed in its golden fixture, so the harness
  defaults to it and `validateFixture` warns on a different one.
- **The entering ledger is the previous leg's golden closing ledger**, not a
  round number. `tools/golden/record.ts` prints each leg's closing ledger for the
  next leg's fixture to copy, and `journey.ledger.txt` is the checked-in record
  of all fourteen.
- **The known-bad path must not panic.** A `kernel.panic` is an engine bug, and a
  leg whose intended failure is a panic has found one.
- Both scripts must have zero unfired steps.

Legs that have not shipped get `stubFixtures.ts`: a throwing stub per leg,
enumerated so the report can list exactly which fixtures are still owed.

#### 7.4 `tools/golden/record.ts` and `diff.ts`

```
npm run golden:record -- --leg the_cistern --path good
npm run golden:record -- --all
npm run golden:diff -- --leg the_cistern --path good
```

`record` runs the fixture and writes both files. It refuses to overwrite an
existing golden unless `--force` is passed, and it prints the old and new hashes
side by side when it does. **A regenerated golden is a behaviour change and must
be reviewed as one, never waved through**, which is the same rule architecture
11.4 sets for the Gantt goldens.

`diff` runs the fixture, renders the log, and prints a unified diff against the
checked-in file with the first differing line highlighted and the tick and seq
of the divergence stated plainly. It exits non-zero on a difference so it can be
used directly in a pre-commit check.

Recording is never automatic. `UPDATE_GOLDEN=1 npm test` is deliberately not
supported here, because the leg goldens are fourteen agents' work and an
environment variable that silently rewrites all of them is a way to lose a
regression.

### 8. `tests/legs/journey.test.ts`, the fourteen-leg determinism assertion

The whole journey, end to end, as one deterministic function of its seed plus its
decision log.

```ts
export interface JourneyOptions {
  readonly seed: number;
  readonly discClass: DiscClass;
  readonly difficulty: DifficultyTier;
  /** One script per leg, in LEG_ORDER. */
  readonly scripts: ReadonlyMap<LegId, DecisionScript>;
  readonly maxTicksPerLeg?: number;
  /** Snapshot and restore at every leg boundary. */
  readonly restoreAtBoundaries?: boolean;
}

export interface JourneyResult {
  readonly legs: readonly HarnessResult[];
  readonly finalRun: RunState;
  readonly journeyHash: string;
  readonly ledgerByLeg: readonly ResourceLedger[];
  readonly survivors: number;
  readonly objectivesMet: readonly string[];
  readonly handoffs: readonly HandoffObservation[];
}

export async function runJourney(opts: JourneyOptions): Promise<JourneyResult>;
```

`journeyHash` is `fnv1a64` over the concatenation of the fourteen per-leg log
hashes in `LEG_ORDER`, plus the canonical serialisation of the final `RunState`.
One number for the whole run.

The assertions:

1. **Two full journeys from the same seed and the same scripts produce the same
   `journeyHash`.** This is the project's central claim stated as a test.
2. **A journey run with `restoreAtBoundaries` produces the same hash** as one run
   straight through. A boundary save has `kernel: null` and rebuilds from
   `kernelConfig` and `populate`, per architecture 10.2, so this also proves the
   rebuild path is exact.
3. **A different seed produces a different hash.**
4. **A journey replayed through WP-18's replay worker from the seed and the
   decision log alone reproduces the same `journeyHash`.** The decision log is
   the durable artefact and the snapshot is a cache; this is the test that says
   so.
5. **The ledger never goes negative** at any leg boundary except through the
   emergency preemption credit, and the credit fires exactly where WP-19's
   economy curve says it will for the chosen disc class.
6. **All five hand-offs are observed against real producers.** The journey is the
   only place they are. `HandoffObservation` records, per hand-off, that the
   producer wrote the record, that the consumer read it, and that the consumer
   did not fall back to its documented default:

   | # | Producer | Record | Consumer |
   |---|---|---|---|
   | 1 | `the_cistern` | `ring_closed` | `the_gridlock` |
   | 2 | `allocation_yards` | `executable_bit` | `arbiter_wall` |
   | 3 | `the_bus` | `device_attach` | `the_archive` |
   | 4 | `the_archive` | `crash_outcome`, `manifest_integrity` | `arbiter_wall` |
   | 5 | `arbiter_wall` | `escalation_outcome`, `privilege_excess` | `the_portal` |

   Hand-off 2 is the longest causal chain in the game and it is the only one
   where the consumer writes back to the producer's record. The journey asserts
   that write landed, through WP-17's decision interface and not by assignment.

7. **The objective rollup closes.** `objectivesMet` draws only from the fourteen
   legs' declared objective ids, with no id met that no leg declares.
8. **The journey completes in under 60 seconds** on CI hardware. Fourteen legs at
   roughly a thousand ticks each is a small amount of work and a journey that
   takes minutes has an accidental quadratic in it.

Until all fourteen legs ship, `runJourney` runs the shipped prefix, asserts
everything above for that prefix, and prints the legs it skipped. `journey.hash`
is recorded only when all fourteen are present, and the test states that plainly
rather than recording a partial hash that would go stale on the next leg.

### 9. The CI command

Add exactly five scripts to `package.json` and no others:

```json
{
  "test:legs":     "vitest run tests/legs",
  "test:goldens":  "vitest run tests/legs/goldens.test.ts",
  "test:journey":  "vitest run tests/legs/journey.test.ts",
  "golden:record": "tsx tools/golden/record.ts",
  "golden:diff":   "tsx tools/golden/diff.ts"
}
```

`tools/ci/legGoldens.mjs` is the CI entry point, invoked as `node
tools/ci/legGoldens.mjs`. It:

1. Enumerates `LEG_ORDER` and reports which legs have shipped and which fixtures
   exist, as a table, before running anything.
2. Runs every shipped leg's known-good and known-bad golden playthrough.
3. Runs the journey over the shipped prefix.
4. Prints one summary line per leg: id, path, ticks, survivors, objectives met,
   hash, pass or fail.
5. On any failure, prints the rendered log diff for that leg and exits 1.
6. On success, prints the journey hash and exits 0.

It writes no golden files, ever. Recording is a human action.

The full local gate for a leg agent, in order:

```
npm run typecheck
npm run test
npm run build
node tools/ci/legGoldens.mjs
```

### 10. What this package does not test

Restated from architecture 11.7 so no leg agent files a gap that is a decision:

| Not tested | Reason |
|---|---|
| Shader output | No practical assertion short of image comparison, which is fragile across drivers and would fail on CI with no GPU. Verified by looking. |
| Exact 3D layout of structures | It changes with art direction and asserting it would freeze the design. The anchor test covers the only part other code depends on. |
| Audio output | The synthesis graph's construction is smoke-tested. The sound is verified by listening. |
| DOM structure of the HUD | Written once, changes with design. The store watchers are tested; what they write is not. |
| Draw call counts | Reported by each leg package from its own render pass, not from this harness. The combined pass after wave D is a separate exercise. |

The rule a leg agent applies when unsure: if it is a pure function over plain
data, test it; if it is a picture or a sound, look at it or listen to it.

## Acceptance criteria

1. `npm run typecheck` exits 0.
2. `npm run test` exits 0.
3. `npm run build` exits 0.
4. `loadLegForTest` constructs every shipped leg by id through
   `src/legs/registry.ts` and throws with the id in the message for one that has
   not shipped.
5. `tryLoadLegForTest` returns `shipped: false` for an unshipped leg, and every
   suite in this package is green with any subset of the fourteen legs present,
   asserted for the empty set, one leg, and all shipped legs.
6. A leg whose `index.ts` imports `@world`, `@render`, `@ui`, `@audio` or `three`
   at module scope fails at load with a message naming the import.
7. `runLeg` drives a leg to completion with `stageContext: null`, and asserts
   `globalThis.document` and `globalThis.window` are undefined at run time.
8. `runLeg` reproduces its own `logHash` across two runs in one process.
9. `restoreAt` at the midpoint produces a remainder hash identical to the
   uninterrupted remainder, for every shipped leg on both fixtures.
10. A `kernel.panic` stops the run, lands in `panics`, and fails the suite.
11. A `LegSandbox` diagnostic lands in `legFailures` and fails the suite.
12. `maxTickMs` is measured and asserted under 2 ms, and `wallMs` under 1000 ms,
    per leg per seed.
13. A `DecisionScript` step scheduled `at` a tick fires in the same slot the
    `CommandBus` drains, immediately before that tick.
14. A step scheduled `when` a trigger fires once, on the tick after the trigger
    became true, and an unfired step is reported in `unfiredSteps`.
15. Steps at the same tick fire in declared order, asserted with three steps.
16. `validateScript` names all four failure kinds and returns empty for a valid
    script.
17. Scripted commands are dispatched with `origin.source === 'replay'` and the
    resulting `RunState.decisions` replays identically through WP-18.
18. The three stand-in policies exist, and `competent` reads no leg's fixture,
    asserted by a source scan.
19. `expectOutcome` checks only the fields the expectation names, reports the
    symmetric difference in both directions on a set mismatch, and includes the
    leg id, seed, tick count and log hash in every failure message.
20. `eventTypesAbsent` fails a run in which the named type fired, exercised on
    the Cistern's `deadlock.detected` case or a synthetic equivalent.
21. `tests/legs/smoke.test.ts` runs three seeds per leg and passes all eight
    per-seed assertions for every shipped leg.
22. The `REQUIRED_EVENTS` table ships verbatim with all fourteen rows, and each
    shipped leg fires every type in its row under the `chaotic` policy at seed 4.
23. The anchor test resolves every `InteractionDef.anchor` for every shipped leg
    and disposes the stage.
24. The inert-field test drives 400 ticks with poisoned inert config fields and
    finds the log hash unchanged.
25. `validateTable(leg.eventTable)` returns empty for every shipped leg.
26. Every shipped leg completes at all four paces with no panic and no leg
    failure.
27. `renderEventLog` output is stable, locale-free, and contains no em dash or en
    dash, asserted by a scan of every checked-in golden file.
28. `goldens.test.ts` asserts the hash, the second-run hash, the restore-at-midpoint
    hash and the `OutcomeExpectation` for both fixtures of every shipped leg.
29. A missing golden file fails rather than recording silently.
30. `golden:record` refuses to overwrite without `--force` and prints the old and
    new hashes when it does.
31. `golden:diff` prints the tick and seq of the first divergence and exits
    non-zero on a difference.
32. `UPDATE_GOLDEN=1` has no effect on this package's suites, asserted.
33. `validateFixture` enforces every rule in section 7.3, including that the
    known-good script meets every declared objective and that the known-bad
    script produces the leg's named failure.
34. `stubFixtures.ts` enumerates every leg with no fixture, and the report lists
    them.
35. Two full journeys from the same seed and scripts produce the same
    `journeyHash`.
36. A journey with `restoreAtBoundaries` produces the same hash as one run
    straight through.
37. A different seed produces a different `journeyHash`.
38. A journey replayed through WP-18 from the seed and decision log alone
    reproduces the same `journeyHash`.
39. The ledger never goes negative at a leg boundary except through the emergency
    preemption credit, which fires where WP-19's economy curve predicts.
40. All five hand-offs are observed against real producers when all fourteen legs
    are present, and hand-off 2's write-back to the producer's record is asserted
    to have gone through WP-17's decision interface.
41. `objectivesMet` at journey end draws only from the fourteen legs' declared
    objective ids.
42. The full journey completes in under 60 seconds.
43. Over a shipped prefix, the journey suite asserts everything above for that
    prefix and prints the skipped legs.
44. The five `package.json` scripts exist and no others were added.
45. `node tools/ci/legGoldens.mjs` prints the shipped-leg table, runs every
    golden, prints one summary line per leg, exits 0 on success and 1 on any
    failure, and writes no golden file.
46. Nothing under `tests/legs/harness/` or `tools/` is imported from `src/`,
    asserted by a source scan.
47. `git diff --exit-code src/kernel/types.ts src/game/types.ts` exits 0.

## Tests you must write

### `tests/legs/harness.test.ts`

The harness's own suite, run against a synthetic leg this package ships under
`tests/legs/harness/`. The synthetic leg is small, complete, and deliberately
exercises every path: it declares two objectives, one crossing, one depot visit,
one reclamation round, an event table summing to 100, three interactions with
resolvable anchors, and a known-good and known-bad script.

| Case | Assertion |
|---|---|
| `constructs by id` | every shipped leg loads; an unshipped id throws with its id in the message |
| `try load` | an unshipped id returns `shipped: false` |
| `forbidden import` | a synthetic leg importing `three` fails at load with a named message |
| `no dom` | `document` and `window` are undefined during a run |
| `no stage` | `createStage` is not called when `stageContext` is null |
| `repeatable` | two runs in one process give the same hash |
| `restore mid-leg` | the remainder hashes identically |
| `panic fails` | a synthetic leg that panics fails the suite and lands in `panics` |
| `sandbox reported` | a synthetic leg that throws in `evaluate` lands in `legFailures` |
| `script at tick` | a step at tick 40 lands in the tick-40 command drain |
| `script when` | a trigger fires once, on the tick after it became true |
| `script order` | three steps at the same tick fire in declared order |
| `unfired reported` | a trigger that never becomes true leaves its step in `unfiredSteps` |
| `validate script` | four failure kinds named; a valid script returns empty |
| `replay origin` | every scripted command carries `source: 'replay'` |
| `competent is generic` | a source scan finds no fixture import in the policy module |
| `expect subset` | omitted expectation fields are not checked |
| `expect diff message` | a set mismatch reports both directions and names the leg, seed, ticks and hash |
| `absent events` | a run in which a forbidden type fired fails |
| `render stable` | rendering the same log twice gives byte-identical text with no dashes and no locale formatting |
| `record refuses` | recording over an existing golden without `--force` refuses |
| `diff exits` | a changed log exits non-zero and names the first divergent tick and seq |
| `update golden ignored` | `UPDATE_GOLDEN=1` changes nothing |
| `validate fixture` | every rule in 7.3, each with a failing case |

### `tests/legs/smoke.test.ts`

Section 6, for every shipped leg, skipping the rest with a printed line.

### `tests/legs/goldens.test.ts`

Section 7.2, for every shipped leg and both fixtures.

### `tests/legs/journey.test.ts`

Section 8, over the shipped prefix, with all eight assertions.

## Out of scope

- Any leg module, and any leg's fixture file. This package defines the fixture
  type and the loader; the fourteen leg packages write the fixtures.
- Any game logic. The harness drives WP-19 and asserts what comes out. A travel
  loop, a crossing formula or a price table appearing under `tests/legs/harness/`
  means the harness is testing itself.
- The kernel's own determinism suite. `tests/kernel/determinism.test.ts` is
  WP-01's and stays as it is; this package's journey test is the game-layer
  equivalent and duplicates none of it.
- The Gantt, frame table, Banker's trace and disk path golden renderers. Those
  are architecture 11.4's and belong to WP-04, WP-06, WP-08 and WP-09.
- Draw call counting, render-layer assertions, shader and audio checks. Section
  10 says why.
- Coverage thresholds beyond adding `src/game/**` per architecture 11.1.
- Any change to `src/`, including `src/legs/registry.ts`.

## Report back

State:

1. Pass or fail for each of the 47 acceptance criteria, by number.
2. The three verification command outcomes plus the output of
   `node tools/ci/legGoldens.mjs`.
3. Which legs had shipped when you ran, and which fixtures were present, missing
   or stubbed, as a fourteen-row table.
4. Every golden file recorded, with its hash and the fixture it came from.
5. The `journeyHash` if all fourteen legs were present, or the shipped prefix and
   why it was not recorded.
6. For each of the five hand-offs, whether it was observed against a real
   producer or skipped because a leg was missing.
7. The exact `LegFixture` shape you shipped, so every leg package writes against
   it, and confirmation that `validateFixture` enforces all six rules in 7.3.
8. Every `// TODO(astra):` left in the tree, with file and line.
9. Any place a leg package's stated acceptance criterion could not be expressed
   by `OutcomeExpectation`, and what you added.
10. Confirmation that the five `package.json` scripts are the only ones added,
    that nothing under `tests/` or `tools/` is imported from `src/`, and that no
    frozen contract was edited, extended or shadowed.

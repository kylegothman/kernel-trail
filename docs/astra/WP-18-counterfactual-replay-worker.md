# WP-18: The counterfactual replay worker

## Objective

When this package is done the game can take a finished leg, re-execute it in a Web
Worker under a different policy against the same seed, and tell the player what
would have happened, in numbers taken from the replay rather than from a lookup
table. The design brief calls this the strongest teaching device in the game, and
it is the whole reason the kernel is headless and deterministic. This package also
delivers the worker protocol the other two workers use, the replay verification
path for save integrity, and the phrasing layer that turns metric deltas into a
sentence a player reads.

## Prerequisites

WP-11 and WP-17 complete and green.

**This package depends on full workload restore, which is WP-11.** A replay
re-executes a leg from a snapshot, so a snapshot that can only be restored into
an empty kernel gives this package nothing to replay. While `restore` is
init-only, this package cannot be accepted: its numbers would come from a replay
that started from a blank kernel. See `docs/07-CONTRACT-AMENDMENTS.md`
amendment 1. Before starting, confirm that `snapshot().completeness` reads
`'full'` for a running workload, that `subsystems.process` is populated, and that
`DET-D2` passes un-skipped.

Files that must already exist:

- `src/kernel/` complete, with `snapshot()`, `restore()` and `DET-D2` passing
- `src/game/save.ts` (or `src/game/save/`) with the schema, `ReplayRecord` and the
  checksum
- `src/game/store.ts`, `src/game/CommandBus.ts`
- `src/ui/cards/DebriefCard.ts`, whose `counterfactual` slot this package fills
- `src/legs/registry.ts` (exists in the scaffold) as the leg id to dynamic import
  map

## Required reading

- `00-DESIGN-BRIEF.md` section 9 (determinism) and the four things it buys
- `01-ARCHITECTURE.md` section 8.6 (replay) in full, including the four inputs a
  run is a pure function of, and the `ReplayRequest`, `ReplayOverrides`,
  `ReplayResult`, `ReplayHighlight` and `ReplayResponse` shapes
- `01-ARCHITECTURE.md` section 8.7 (the counterfactual debrief) in full, including
  the five-step flow and the seven-row selection table
- `01-ARCHITECTURE.md` section 9 in full: 9.1 (what runs off the main thread), 9.2
  (the main simulation stays on the main thread, and why), 9.3 (OffscreenCanvas is
  not used), 9.4 (the worker protocol, the four implementer notes, and
  `ReplayWorkerHandle`)
- `01-ARCHITECTURE.md` section 8.2, the `ReplayRecord` shape
- `01-ARCHITECTURE.md` section 12.3 (code splitting) and 1.5 (enforcement),
  because the boundary test has a dedicated case for worker entry points
- `02-KERNEL-SIM-SPEC.md` section 1.2.5 and 1.2.6, so the replay seeds its streams
  in the fixed registry order
- `04-NARRATIVE-BIBLE.md` section 15 (progression and the end-of-run report)

## Files you will create

```
src/game/workers/protocol.ts
src/game/workers/replay.worker.ts
src/game/workers/persist.worker.ts
src/game/workers/bake.worker.ts
src/game/workers/ReplayWorkerHandle.ts
src/game/workers/PersistWorkerHandle.ts
src/game/workers/BakeWorkerHandle.ts
src/game/replay/types.ts
src/game/replay/runReplay.ts
src/game/replay/CounterfactualPlanner.ts
src/game/replay/phrasing.ts
src/game/replay/headlessLegs.ts
src/game/replay/hash.ts
src/game/replay/highlights.ts
src/game/replay/verify.ts
tests/game/replay.test.ts
tests/game/counterfactual.test.ts
tests/game/phrasing.test.ts
tests/game/workerProtocol.test.ts
tests/game/verify.test.ts
```

## Files you may modify

```
src/ui/cards/DebriefCard.ts   (fill the counterfactual slot only)
src/game/save.ts              (add the ReplayRecord read and write paths only)
```

Nothing else.

## Frozen contracts

From `src/game/types.ts`. These may not be edited:

```ts
export interface DebriefCard {
  readonly headline: string;
  readonly whatHappened: string;
  readonly whyItHappened: string;
  /** Concrete counterfactual: what the same run looks like under a better policy. */
  readonly counterfactual: string | null;
  readonly chapter: ChapterRef;
}

export interface DecisionRecord {
  readonly tick: Tick;
  readonly legId: LegId;
  readonly kind: string;
  readonly choice: string;
  outcome: 'good' | 'costly' | 'fatal' | 'pending';
  readonly relatedObjective: string | null;
}

export interface Leg {
  readonly id: LegId;
  readonly index: number;
  kernelConfig(run: RunState): KernelConfig;
  populate(ctx: LegSetupContext): void;
  createStage(ctx: StageContext): LegStage;
  readonly eventTable: readonly RandomEventDef[];
  evaluate(ctx: LegEvaluationContext): LegOutcome;
  // ... other members
}

export const LEG_ORDER: readonly LegId[] = [ /* fourteen ids */ ];
```

From `01-ARCHITECTURE.md` section 8.6. These become frozen when this package
lands, because the debrief card and the codex both read them:

```ts
export interface ReplayRequest {
  readonly seed: number;
  readonly discClass: DiscClass;
  readonly difficulty: DifficultyTier;
  /** Which legs to run. A counterfactual usually runs exactly one. */
  readonly legs: readonly LegId[];
  readonly decisions: readonly DecisionRecord[];
  readonly overrides: ReplayOverrides;
  /** Safety valve. A replay that exceeds this is aborted and reported. */
  readonly maxTicks: number;
}

export interface ReplayOverrides {
  readonly scheduler?: SchedulerId;
  readonly quantum?: number;
  readonly replacement?: PageReplacementId;
  readonly diskPolicy?: DiskSchedulingId;
  readonly allocation?: AllocationStrategy;
  readonly pace?: Pace;
  readonly rations?: Rations;
  readonly degreeOfMultiprogramming?: number;
  /** When true, every recorded decision of an overridden kind is dropped. */
  readonly suppressRecordedPolicyChanges: boolean;
}

export interface ReplayResult {
  readonly ok: true;
  readonly ticks: number;
  readonly eventLogHash: string;
  readonly survivors: readonly string[];
  readonly casualties: readonly { readonly member: string; readonly reason: string; readonly tick: number }[];
  readonly scheduling: {
    readonly averageWaitingTime: number;
    readonly averageTurnaroundTime: number;
    readonly averageResponseTime: number;
    readonly contextSwitches: number;
    readonly cpuUtilisation: number;
    readonly worstWait: number;
  };
  readonly memory: {
    readonly pageFaults: number;
    readonly evictions: number;
    readonly faultRate: number;
  };
  readonly score: ScoreBreakdown;
  /** Up to 400 events chosen for the debrief timeline, already downsampled. */
  readonly highlights: readonly ReplayHighlight[];
}

export interface ReplayHighlight {
  readonly tick: number;
  readonly type: string;
  readonly summary: string;
  readonly severity: 'info' | 'warning' | 'fatal';
}

export type ReplayResponse =
  | ReplayResult
  | { readonly ok: false; readonly reason: 'aborted' | 'error' | 'timeout'; readonly message: string };
```

The worker envelope, architecture 9.4:

```ts
export interface Envelope<TKind extends string, TPayload> {
  readonly id: number;
  readonly kind: TKind;
  readonly payload: TPayload;
}

export type ReplayRequestMessage = Envelope<'replay', ReplayRequest>;
export type ReplayCancelMessage = Envelope<'cancel', { readonly targetId: number }>;
export type ReplayInbound = ReplayRequestMessage | ReplayCancelMessage;

export type ReplayProgress = Envelope<'progress', { readonly targetId: number; readonly ticks: number }>;
export type ReplayDone = Envelope<'done', ReplayResponse>;
export type ReplayOutbound = ReplayProgress | ReplayDone;
```

## Specification

### 1. What a run is a pure function of

Architecture 8.6, and this sentence is the whole contract:

**A run is a pure function of `(seed, discClass, difficulty, decisionLog)`.**

Given those four, re-executing produces a byte-identical event log. Nothing else
is an input. Wall-clock time, frame rate, quality tier, window size and how long
the player spent thinking are all excluded **by construction**, because the kernel
cannot observe any of them and commands are applied at tick boundaries.

If you find yourself needing a fifth input, that is a bug in a subsystem, not a
gap in this package. Report it.

### 2. `src/game/replay/headlessLegs.ts`

Architecture 9.4, third implementer note. **Legs are re-registered headlessly.**
`headlessLegs.ts` maps `LegId` to a factory returning the leg's `kernelConfig`,
`populate`, `eventTable` and `evaluate`, **with `createStage` replaced by a
no-op.**

This is why `Leg` splits simulation concerns from `createStage` in the first
place, and it is a contract requirement rather than a convenience: **a leg that
puts simulation logic inside `createStage` breaks replay and therefore breaks the
counterfactual.** Write the assertion that catches it: a headless leg run and a
staged leg run of the same leg produce identical event log hashes.

In phase 1 no leg exists. Ship `headlessLegs.ts` with the fourteen `LegId` keys
mapped to factories that throw
`// TODO(astra): phase 2 leg packages register here`, plus a test-only synthetic
leg used by every test in this package. Report the synthetic leg's shape so leg
authors can see what replay expects of them.

### 3. `src/game/replay/runReplay.ts`

The replay loop itself, pure and callable from either thread:

1. Build the kernel from `Leg.kernelConfig(run)` with the request's `seed`.
2. Call `populate`.
3. Walk the decision log in tick order. At each decision's tick, apply it through
   the same code path the `CommandBus` uses, so replay and live play cannot
   diverge in how a decision lands.
4. Apply `ReplayOverrides` **instead of** the recorded decision for any overridden
   kind, and when `suppressRecordedPolicyChanges` is true, drop every recorded
   decision of an overridden kind entirely.
5. Step to leg completion or `maxTicks`, whichever comes first. Exceeding
   `maxTicks` aborts and reports.
6. Call `evaluate` and build the `ReplayResult`.

**Progress messages every 500 ticks**, throttled so a fast replay posts one
message rather than forty.

**Cancellation is cooperative**: the loop checks the cancelled set every 500
ticks. A leg transition or a run abandon cancels outstanding replays.

Performance target from architecture 8.7: a single leg is 2,000 to 8,000 ticks at
roughly 20 microseconds per tick, so 40 to 160 ms. Two counterfactuals fit
comfortably inside the time the player spends reading the first two lines of the
card. Measure it and report the actual microseconds per tick.

### 4. `src/game/replay/hash.ts` and `highlights.ts`

`hashEventLog(events)` produces `ReplayResult.eventLogHash`. Use the same FNV-1a
over a canonical serialisation that `tests/kernel/canonical.ts` and the save
checksum use. **Three implementations of the same hash is three chances to
diverge**; import one and say so in a comment.

`highlights.ts` downsamples the event log to at most 400 `ReplayHighlight`
entries for the debrief timeline. Selection is deterministic and prefers, in
order: every `fatal` severity event, every `process.exited` of a convoy Program,
every `deadlock.detected`, every `memory.thrashing` severity change, then an even
sample of the rest. Same input, same 400 entries, every time.

### 5. `src/game/replay/CounterfactualPlanner.ts`

Architecture 8.7, step 2. **It does not run all of them; it picks at most two**,
using a table keyed by what actually went wrong:

| Observed failure | Counterfactual run |
|---|---|
| `starvation` casualty | the same leg with `priority_aging`, or `rr` if the player was already aging |
| `thrashing_collapse` | the same leg with `degreeOfMultiprogramming - 2` |
| `deadlock_victim` | the same leg with `deadlockStrategy: 'avoid'` |
| high `averageWaitingTime`, no casualty | the same leg with `srtf`, which is the theoretical floor for average waiting time |
| high `pageFaults`, no casualty | the same leg with `optimal`, labelled as the unachievable floor |
| high seek distance | the same leg with `clook` |
| nothing went wrong | the next-worse policy, so the player learns why their choice was good |

The last row matters as much as the others: a player who did well is shown the
cost of the alternative, so success is explained rather than merely rewarded.

`deadlockStrategy` is not a member of `ReplayOverrides`, so the deadlock row
cannot be expressed through overrides alone. Express it by substituting a
modified `KernelConfig` in the headless leg factory for that one replay, and
document the mechanism in a comment. Do not add a field to `ReplayOverrides`.

The `optimal` row needs `MemoryContext.futureReferences`, which is non-null only
when every runnable process has a scripted reference string. Check
`allProgramsScripted()` before planning that counterfactual and skip the row when
it is false, rather than producing a replay that throws.

### 6. `src/game/replay/phrasing.ts`

Architecture 8.7, step 5. The comparison is phrased in the player's terms,
generated from the metric deltas. The worked example the architecture gives:

> "Under round-robin with a quantum of 4, SABLE waits 61 ticks instead of 210 and
> survives. Average waiting time falls from 94 to 38."

**Numbers come from `ReplayResult`, never from a lookup table**, because a
hand-written claim would eventually be wrong for some seed and the game would be
teaching something false. Write the phrasing as templates with numeric slots and
assert in a test that every rendered sentence's numbers appear in the
`ReplayResult` it was built from.

Style rules that apply to every sentence this module emits, because they are
player-facing copy:

- No em dashes or en dashes used as em dashes.
- Name the Program and the metric, then the two numbers, then the outcome.
- At most two sentences per counterfactual.
- Never tell the player what to do; state what the alternative produced. The codex
  is where remedies live.
- Respect the IP constraints from the briefing: no forbidden word appears in any
  generated sentence.

### 7. The worker protocol and the three workers

Architecture 9.4. All workers use the same request and response envelope with
correlation ids, one module per worker, and typed message unions on both sides.

**The worker imports `@kernel` and the headless half of `@game` only. It must not
import `@world`, `@render` or `@ui`.** The boundary test in architecture 1.5 has a
dedicated case for worker entry points, because a stray import there pulls
Three.js into the worker bundle and fails at runtime with a `document is not
defined` that is annoying to diagnose. Write that case.

`ReplayWorkerHandle` follows architecture 9.4 exactly:

- **One worker instance, reused.** Spawning a worker costs 10 to 40 ms; the handle
  is created lazily on the first replay request and kept for the session.
- The `new URL('./replay.worker.ts', import.meta.url)` form is what lets Vite
  bundle the worker as its own chunk. Use it verbatim.
- A timeout of 1500 ms posts a cancel and resolves with
  `{ ok: false, reason: 'timeout' }`.
- `onerror` fails every pending request and terminates the worker; **the next
  request respawns it**. A crashed replay worker is invisible except that one
  debrief card lacks its counterfactual. That is the resilience posture of
  architecture 10 applied to a non-essential subsystem.

Two more workers, per architecture 9.1:

- `persist.worker.ts`: save checksumming and canonicalisation. Canonicalising a
  900 KB provisional save is 3 to 6 ms of string building plus a GC spike, and it
  happens on tab hide when the browser is already busy. It calls WP-17's pure
  canonicalise and checksum functions.
- `bake.worker.ts`: procedural texture baking (blue noise, grain, grade LUT, SDF
  atlas assembly) and codex search index construction. 60 to 200 ms at boot,
  running in parallel with capability probing and the tier benchmark, so it is
  free wall-clock time. Results transfer as `ArrayBuffer` with **zero copy**; use
  the transfer list.

**The main simulation stays on the main thread**, architecture 9.2. Do not move
it. **OffscreenCanvas is not used**, architecture 9.3. Do not introduce it.

### 8. The debrief flow

Architecture 8.7, five steps, and the timing is the point:

1. `LegRunner` finishes the leg and produces `LegOutcome`.
2. `CounterfactualPlanner` chooses at most two alternatives.
3. The `ReplayRequest`s are posted to the worker. **The leg-complete card renders
   immediately** with the counterfactual slot showing a small computing state.
4. The worker replays headlessly.
5. The result arrives, `DebriefCard.counterfactual` is filled, and the card
   animates the comparison in. If the worker fails or times out at 1500 ms, **the
   slot is removed and the card is complete without it. The debrief never blocks
   on the replay.**

Write the test that proves step 5's failure path: with the worker forced to
throw, the card still renders complete and `counterfactual` is `null`.

### 9. `src/game/replay/verify.ts`

Architecture 8.6, "verifying a save". `verifySave(file)` recomputes the checksum,
and if that passes and the caller asks for a deep check, dispatches a replay of
the whole run from the seed and compares `eventLogHash` per leg against
`ReplayRecord.legEventHashes`.

The deep check takes a few hundred milliseconds in a worker and **runs only on
demand** from the diagnostics panel and before any future score submission. It is
never on the load path.

A diagnostics bundle contains the `ReplayRecord` and the build id, so re-running
it under the same build reproduces a failure exactly, including a kernel panic, on
a developer's machine with no video needed. That is the practical payoff of the
determinism rule.

## Acceptance criteria

1. `npm run typecheck` exits 0.
2. `npm run test` exits 0.
3. `npm run build` exits 0.
4. A replay of the synthetic leg from `(seed, discClass, difficulty, decisions)`
   produces an `eventLogHash` identical to a live run of the same leg. Asserted
   over 20 seeds.
5. Replaying the same request twice gives byte-identical `ReplayResult`s.
6. Wall-clock time, frame rate, quality tier and window size are not inputs:
   replaying under three different simulated frame rates and two tiers gives
   identical hashes.
7. `ReplayOverrides` applies instead of the recorded decision for each of the
   eight override fields, asserted one case per field.
8. `suppressRecordedPolicyChanges: true` drops every recorded decision of an
   overridden kind, and `false` keeps the non-overridden ones.
9. A replay exceeding `maxTicks` resolves with
   `{ ok: false, reason: 'aborted' }` and does not hang.
10. Progress messages arrive every 500 ticks and are throttled: a 600-tick replay
    posts exactly one.
11. Cancellation is honoured within 500 ticks of the cancel message.
12. `hashEventLog` imports the same FNV-1a and canonical serialiser the save
    checksum uses. Verified by asserting the three agree on a shared fixture.
13. `highlights` returns at most 400 entries, is deterministic for the same input,
    and always includes every `fatal` severity event, every convoy
    `process.exited`, every `deadlock.detected` and every `memory.thrashing`
    severity change.
14. `CounterfactualPlanner` returns at most two requests, and each of the seven
    table rows is exercised by a test that constructs the matching failure.
15. The `optimal` row is skipped rather than attempted when
    `allProgramsScripted()` is false.
16. The `deadlockStrategy` counterfactual works without adding a field to
    `ReplayOverrides`.
17. Every sentence `phrasing.ts` produces has all its numbers present in the
    `ReplayResult` it was built from. Asserted across 50 generated sentences.
18. No sentence from `phrasing.ts` contains an em dash, an en dash used as an em
    dash, or any word from the IP forbidden list.
19. No sentence from `phrasing.ts` contains an imperative telling the player what
    to do.
20. `replay.worker.ts` imports nothing from `@world`, `@render` or `@ui`.
    Asserted by a dedicated boundary test case for worker entry points.
21. `ReplayWorkerHandle` creates at most one worker per session and reuses it
    across 50 requests.
22. A worker that throws fails every pending request, terminates, and the next
    request respawns it.
23. A replay exceeding the 1500 ms timeout resolves with
    `{ ok: false, reason: 'timeout' }` and posts a cancel.
24. The debrief card renders complete with `counterfactual: null` when the worker
    fails, and never blocks on it.
25. A headless leg run and a staged leg run of the same leg produce identical
    event log hashes, which is the assertion that catches simulation logic inside
    `createStage`.
26. `bake.worker.ts` transfers its results as `ArrayBuffer` with zero copy,
    verified by asserting the source buffer is detached after transfer.
27. `persist.worker.ts` produces the same checksum as the main-thread path for the
    same save.
28. `verifySave` deep check compares per-leg hashes and reports a mismatch rather
    than throwing.
29. No `OffscreenCanvas` appears anywhere under `src/`.
30. The main simulation is not moved off the main thread: `src/app/loop.ts` still
    steps the kernel directly.
31. The fourteen `headlessLegs` entries throw with a message naming phase 2.

## Tests you must write

### `tests/game/replay.test.ts`

| Case | Assertion |
|---|---|
| `pure function` | per acceptance criterion 4 |
| `idempotent` | per acceptance criterion 5 |
| `no hidden inputs` | per acceptance criterion 6 |
| `overrides` | per acceptance criterion 7, eight cases |
| `suppress` | per acceptance criterion 8 |
| `maxTicks` | per acceptance criterion 9 |
| `progress throttle` | per acceptance criterion 10 |
| `cancel` | per acceptance criterion 11 |
| `hash shared` | per acceptance criterion 12 |
| `highlights` | per acceptance criterion 13 |
| `decision path shared` | a decision applied in replay goes through the same code path as `CommandBus`, asserted by spying |
| `headless equals staged` | per acceptance criterion 25 |
| `throughput` | the measured microseconds per tick is recorded and a single 8,000-tick leg completes under 400 ms |
| `stubs throw` | per acceptance criterion 31 |

### `tests/game/counterfactual.test.ts`

| Case | Assertion |
|---|---|
| `at most two` | per acceptance criterion 14, first half |
| `starvation row` | a starvation casualty plans `priority_aging`, or `rr` when the player was already aging |
| `thrashing row` | a `thrashing_collapse` plans `degreeOfMultiprogramming - 2` |
| `deadlock row` | a `deadlock_victim` plans `deadlockStrategy: 'avoid'` |
| `waiting row` | high average waiting with no casualty plans `srtf` |
| `faults row` | high page faults with no casualty plans `optimal`, labelled as the unachievable floor |
| `seek row` | high seek distance plans `clook` |
| `nothing wrong row` | a clean leg plans the next-worse policy |
| `optimal skipped` | per acceptance criterion 15 |
| `deadlock without new field` | per acceptance criterion 16 |
| `debrief non-blocking` | per acceptance criterion 24 |
| `computing state` | the card renders with a computing state before the result arrives |

### `tests/game/phrasing.test.ts`

| Case | Assertion |
|---|---|
| `numbers from result` | per acceptance criterion 17 |
| `no em dash` | per acceptance criterion 18, dashes half |
| `no forbidden words` | per acceptance criterion 18, IP half, scanning the full forbidden list from the briefing |
| `no imperatives` | per acceptance criterion 19 |
| `two sentences` | no counterfactual exceeds two sentences |
| `names the program` | every sentence about a casualty names the Program and the metric |
| `architecture example` | the architecture 8.7 worked example renders from a `ReplayResult` carrying those numbers |

### `tests/game/workerProtocol.test.ts`

| Case | Assertion |
|---|---|
| `envelope` | every message carries `id`, `kind` and `payload`, and ids correlate request to response |
| `worker boundaries` | per acceptance criterion 20 |
| `single instance` | per acceptance criterion 21 |
| `crash respawn` | per acceptance criterion 22 |
| `timeout` | per acceptance criterion 23 |
| `new URL form` | the worker is constructed with the `new URL(..., import.meta.url)` form so Vite chunks it |
| `bake transfer` | per acceptance criterion 26 |
| `persist checksum` | per acceptance criterion 27 |
| `no offscreencanvas` | per acceptance criterion 29 |
| `sim on main thread` | per acceptance criterion 30 |

### `tests/game/verify.test.ts`

| Case | Assertion |
|---|---|
| `checksum only` | a shallow verify passes on a good save and fails on a tampered one |
| `deep check` | per acceptance criterion 28 |
| `not on load path` | loading a save performs no deep check, asserted by spying on the worker handle |
| `bundle reproduces` | a diagnostics bundle containing a `ReplayRecord` and a build id reproduces the recorded per-leg hashes |
| `legEntryRng` | a replay begun mid-journey from `ReplayRecord.legEntryRng` produces the same hash as one begun from the start |

## Out of scope

- Any leg module. `headlessLegs.ts` ships fourteen throwing stubs and one
  synthetic test leg.
- Codex entry content and HUD regions. WP-17 owns them; this package fills
  `DebriefCard.counterfactual` and nothing else in the UI.
- `src/kernel/`, `src/world/`, `src/render/`, `src/terminal/`, `src/audio/`.
- Moving the main simulation off the main thread, or introducing
  `OffscreenCanvas`. Both are explicitly decided against.
- Score submission or any network path. There is no backend.

## Report back

State:

1. Pass or fail for each of the thirty-one acceptance criteria, by number.
2. The three verification command outcomes.
3. The measured microseconds per tick for a headless replay, and the wall time for
   an 8,000-tick leg.
4. The shape of the synthetic test leg, so phase 2 leg authors know exactly what
   replay requires of a `Leg`.
5. The mechanism you used for the `deadlockStrategy` counterfactual, since it
   cannot go through `ReplayOverrides`.
6. Ten sample sentences from `phrasing.ts`, so a human can check the register and
   the style rules.
7. Confirmation that the event log hash, the save checksum and the kernel test
   canonicaliser are one implementation rather than three.
8. Every `// TODO(astra):` left in the tree, with file and line, including the
   fourteen `headlessLegs` stubs.

---

## Scope correction against the shipped tree

Written 2026-09-16, after WP-17 merged (main at `877a2ff`) and before WP-18
starts. Where this section disagrees with the text above, this section wins.
Each numbered item is a decision; report against them by number. WP-15 is in
flight on `wp-15` and owns `src/terminal/` plus `src/game/terminalHost.ts`; do
not touch either.

### U1. Files you may modify, restated

The two the package lists, plus one:

- `src/ui/cards/DebriefCard.ts` (see U7)
- `src/game/save.ts` (the `replays` store read and write, see U11)
- `src/game/CommandBus.ts`, one addition only (see U2)

Nothing else outside the create list. `src/game/replay/types.ts` holds
`ReplayRequest`, `ReplayOverrides`, `ReplayResult`, `ReplayHighlight`,
`ReplayResponse` and the envelope types exactly as printed above, with the one
addition in U5. The file is not frozen by this package; it will be frozen by a
contract amendment when WP-19 lands, the same way `codexTypes.ts` will be.

### U2. Decisions are recorded one way; add the inverse

`CommandBus.apply(cmd, origin, at)` records then mutates, in that order, and
that is the code path replay must share. But `DecisionRecord` carries
`kind: string` and `choice: string`, and `describeChoice` (`CommandBus.ts:90`)
is one way: nothing turns a record back into a `Command`. Add to
`CommandBus.ts` one exported pure function
`commandFromRecord(record: DecisionRecord): Command | null`, the exact inverse
of `describeChoice` for the kinds replay applies, with a round-trip test over
every variant in `tests/game/commandBus.test.ts` (that file is WP-17's and is
protected; the new case is quote-and-wait, ruled approved now, so quote the
insertion in the commit message and proceed).

Replay applies these kinds: `set_scheduler`, `set_replacement`,
`set_disk_policy`, `set_allocation`, `set_pace`, `set_rations`, `set_degree`
and `syscall`. It skips `terminal`, `interaction` and `use_ability`, because
the first two are audit lines whose effect was recorded as a separate command
and the third is leg logic that WP-19 owns; `commandFromRecord` returns `null`
for them and the replay loop counts skips in the result's diagnostics. Mark the
`use_ability` skip `// TODO(astra): WP-19 replays abilities through the
RunDirector`.

The replay loop applies each decision by constructing a `CommandBus` over a
throwaway `createRunStore(initialRun)` and calling `bus.apply(cmd, { source:
'replay', legId }, tick)`. That satisfies "the same code path" literally, and
the `decision path shared` case spies on `CommandBus.prototype.apply`.

### U3. Pace, rations and degree do not reach the kernel through the bus

`CommandBus` cases `set_pace`, `set_rations` and `set_degree` mutate
`RunState.policy` only (`CommandBus.ts:183-197`). The kernel effect of those
three is WP-19's `LegRunner` mapping, which does not exist yet, and
`KernelConfig` has no degree field; `KernelImpl.setDegreeOfMultiprogramming`
is the only kernel-side hook. Define in `src/game/replay/types.ts`:

```ts
export interface PolicyBinding {
  /** Called after every policy change and once after populate. */
  apply(kernel: ReplayKernel, policy: Readonly<TravelPolicy>): void;
}
```

with `ReplayKernel = ReturnType<typeof createKernel>`. `runReplay` takes a
binding; the default binding calls `kernel.setDegreeOfMultiprogramming(policy.
degreeOfMultiprogramming)` and does nothing for pace and rations, marked
`// TODO(astra): WP-19 supplies the pace and rations binding and replay must
use the same one`. The `overrides` cases for `pace` and `rations` assert the
override reaches the binding; the `degreeOfMultiprogramming` case asserts the
kernel's degree changed. Architecture 8.7's thrashing row is therefore a
`degreeOfMultiprogramming` override on the policy, applied through the binding,
not a kernel config change.

### U4. Random events belong to WP-19; give them a hook

`RandomEventDef.onlyIf` is a function and cannot cross a worker boundary, and
the draw logic that fires events from `Leg.eventTable` is `RunDirector`, which
WP-19 writes. The replay loop exposes one per-tick hook,
`ReplayHooks.beforeStep(tick, kernel, rng)`, where WP-19 plugs the director's
headless half; the worker resolves it from `headlessLegs.ts` by leg id, never
from the request. This package's synthetic leg has an empty `eventTable` and
the tests prove purity for decisions and policy only. State in the report that
random-event purity is WP-19's obligation through this hook.

### U5. Metrics: what the kernel gives you and what it does not

`KernelSnapshot.metrics` carries exactly `scheduling` and `memory`, and both
have every field `ReplayResult` needs (`averageWaitingTime`,
`averageTurnaroundTime`, `averageResponseTime`, `contextSwitches`,
`cpuUtilisation`, `worstWait`; `pageFaults`, `evictions`, `faultRate`). There
is no seek metric in the snapshot; head movement is on the `disk.seek` event
(`distance` field) and on `KernelImpl.storageSubsystem.diskQueue.
totalHeadMovement`. Add to `ReplayResult` one field,
`readonly storage: { readonly seekDistance: number }`, summed from
`disk.seek` events in the replay log so it is derivable from the event log
alone. The planner's "high seek distance" row reads it.

`casualties[].reason` and `.tick` come from `process.exited` events
(`reason: TerminationReason`), and `.member` comes from the `bind(member, pid)`
calls the leg makes in `populate`; the headless `LegSetupContext` records
those bindings. `LegOutcome.casualties` is bare member ids and is not enough.

### U6. One hash implementation

`src` cannot import `tests/kernel/canonical.ts`, and its `hash` is 32-bit.
`hashEventLog` imports `canonicalise` and `fnv1a64` from `@game/save` and says
so in a comment. `canonicalise` throws on `Map` and `Set`, and some event
payloads may carry them (check `deadlock.detected`'s `DeadlockReport` and
`memory.thrashing`); flatten with the same rule `checksumSafeSnapshot` uses
before hashing, in one helper shared by the two. Acceptance 12 is restated:
`hashEventLog` and `checksumOf` share one canonicaliser and one FNV-1a 64, and
the `hash shared` case asserts `canonicalise` and the test canonicaliser agree
byte for byte on a Map-free event fixture; the two hash widths differ by
design and the case says so.

### U7. The debrief card renders once and has no computing state

`createDebriefCard(doc, card)` (`src/ui/cards/DebriefCard.ts:10`) renders a
frozen `DebriefCard` once; the counterfactual paragraph appears only when
`card.counterfactual` is a string. Extend the signature to
`createDebriefCard(doc, card, pending?: Promise<string | null>)`: when
`pending` is supplied, render the slot in a computing state; on resolution
with a string, fill it and add the `kt-counterfactual` class the existing code
uses; on `null` or rejection, remove the slot. Do not touch the frozen
`DebriefCard` type. The `debrief non-blocking` and `computing state` cases run
under `// @vitest-environment happy-dom` like WP-17's card tests, and the
existing `tests/ui/cards.test.ts` must still pass unchanged.

The codex side already exists: `Codex.setCounterfactual(id, cf)`
(`src/ui/codex/Codex.ts:152`) takes `CodexCounterfactual`, whose `projected` is
a flat `Record<string, number>`. Ship `toCodexCounterfactual(result,
alternative, decisionIndex, replaySeed, narrative)` in `phrasing.ts` that
flattens `scheduling.*`, `memory.*` and `storage.*` into dotted keys.

### U8. Workers cannot run under vitest; make the handle testable and the worker real in the browser

Node's test environment has no `Worker` global and happy-dom does not execute
worker scripts. Two consequences:

1. `ReplayWorkerHandle`, `PersistWorkerHandle` and `BakeWorkerHandle` take an
   injectable `WorkerFactory = () => WorkerLike` where `WorkerLike` is
   `{ postMessage; onmessage; onerror; terminate }`. The default factory is
   the verbatim `new Worker(new URL('./replay.worker.ts', import.meta.url),
   { type: 'module' })` form, and the `new URL form` case is a source scan for
   that string. Tests inject an in-process fake that runs `runReplay` on
   `postMessage` and can be told to throw, hang or delay, which is how the
   `single instance`, `crash respawn`, `timeout` and `cancel` cases run.
2. The real worker path is exercised in the browser runner:
   `tests/render/gpu/replay.html` and `replay.gpu.ts` spawn the built replay,
   persist and bake workers, run one synthetic-leg replay, one checksum, and
   one bake, and assert the bake's source buffer is detached after transfer
   (acceptance 26) and the persist checksum equals the main-thread value
   (acceptance 27). Register it in `tests/render/gpu/run.mjs` the way the HUD
   block is registered: `replay.html` in the rolldown input list and one block
   after the HUD block. Kyle runs it and pastes the output; that run is the
   evidence for 26 and 27. The Node cases for 26 and 27 assert the transfer
   list is built and the pure checksum agrees.

### U9. What the bake worker actually bakes

No procedural texture generator exists in `src/render` as a pure module (the
post chain builds its noise on the GPU). Do not write one. The bake worker
carries two jobs that already have pure, worker-safe implementations:
`audio_buffers`, calling `generateBuffers(seed, sampleRate?)` from
`@audio/buffers` and returning the set with `transferList(set)` (WP-16 shipped
both for exactly this purpose; `isAudioBufferSet` validates the reply on the
main thread), and `codex_index`, calling `buildIndex(entries)` from
`@ui/codex/search`. Texture baking is a follow-up for the render track and
gets a `// TODO(astra): render track supplies pure bakers` marker in the job
union, not a stub that throws.

### U10. Worker boundary case, transitive

No "worker entry points" case exists anywhere, whatever architecture 9.4
claims. Write it in `tests/game/workerProtocol.test.ts`: for each
`src/game/workers/*.worker.ts`, walk the import graph transitively over
relative and alias imports within `src` (using `stripComments` from
`tests/kernel/sourceScan.ts`) and assert no module in the closure imports
`three`, `@world`, `@render`, `@ui` (except `@ui/codex/search` for the bake
worker), `@app`, `@platform` or `@terminal`, and that `@audio` appears only as
`@audio/buffers`. `document`, `window` and `localStorage` must not appear in
the closure either; `indexedDB` may appear in `save.ts` because it is
referenced at call time only, and the case asserts `Database` is never
constructed in a worker.

### U11. `ReplayRecord` is declared and never written

`save.ts` declares `ReplayRecord` and creates the `replays` store, and nothing
reads or writes it. Add `writeReplayRecord(db, record)` and
`readReplayRecord(db, runId)` to `save.ts`, and in `replay/verify.ts` the
builder side: `startReplayRecord(run, buildId)`, `recordLegEntry(record,
rngStates)` and `recordLegHash(record, hash)`, all pure. WP-19's `LegRunner`
calls them at leg start and leg end; this package tests them with the
synthetic leg. `verifySave`'s deep check reads the record through the new
reader. `LoadService.ts:46-50` returns `unreadable` for a migrated file that
needs re-signing; add `resignSaveFile(file, salt?)` to `verify.ts` and leave
the wiring into `loadOutcome` as a follow-up named in the report.

### U12. Seed and configuration

The seed is `KernelConfig.seed`, not a `createKernel` option. A replay builds
`Leg.kernelConfig(run)` from a `RunState` reconstructed from the request
(`seed`, `discClass`, `difficulty`, empty decisions, default policy) and
overrides `seed` with the request's. The `deadlockStrategy` row substitutes
`{ ...config, deadlockStrategy: 'avoid' }` in the headless factory as the
package describes; `KernelImpl.setDeadlockStrategy` also exists if a mid-leg
switch is ever wanted, but the config substitution is the mechanism to
document. `allProgramsScripted()` is on `KernelImpl` (`Kernel.ts:566`), not on
the `Kernel` interface; the planner receives the replay kernel type.

### U13. The synthetic leg and `LEG_LOADERS`

`src/legs/registry.ts` maps ids to `import('@legs/<id>')` thunks with an
800 ms `setTimeout` retry; the worker must not use it. `headlessLegs.ts` is a
separate `Record<LegId, () => HeadlessLeg>` with the fourteen throwing stubs
and a `registerHeadlessLeg(id, factory)` for legs and tests. The synthetic leg
lives in `tests/game/fixtures/syntheticLeg.ts` and implements the full `Leg`
interface with `createStage` returning a stage whose `update` is a no-op, so
the `headless equals staged` case can run both paths. Report its shape.

### U14. Throughput and timeout

Measure microseconds per tick on the synthetic leg in Node and report it; the
container the reviewer verifies in is about 3.4 times slower than the M3, so
the `throughput` case asserts the 8,000-tick leg under 400 ms only when
`process.env.CI` is unset, and otherwise under 1,400 ms, with both numbers
printed. The 1,500 ms handle timeout stays as specified.

### U15. Style rules for phrasing

The forbidden-term list is `forbiddenTerms` in `contracts.lock.json`; the
`no forbidden words` case reads that file rather than a copy. The em dash
rule is enforced by the contract check across the tree and the case asserts it
on the rendered sentences as well. The imperative scan uses the same twelve
patterns WP-15's `no remedies` case uses; take them from
`tests/terminal/man.test.ts` once wp-15 lands, or define them locally and note
the duplication if wp-15 has not merged when you reach that commit.

### U16. Pre-flight before writing

Read this section, then send a pre-flight listing: the `commandFromRecord`
signature and the round-trip case (U2); the `PolicyBinding` and `ReplayHooks`
declarations (U3, U4); the amended `ReplayResult` (U5); the `WorkerLike` and
factory declarations (U8); the `run.mjs` diff (U8); the bake job union (U9);
the synthetic leg's shape (U13); and any finding needing a ruling, numbered.
Wait for the reply before the first commit. Every commit passes all four gates
on its own and ends with both attribution lines.

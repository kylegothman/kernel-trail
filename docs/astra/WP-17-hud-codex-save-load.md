# WP-17: HUD, codex and save/load

## Objective

When this package is done the game has its only always-on screen-space layer: a
HUD that carries status and never simulation data, under an enforced coverage
cap, staying out of the way by design. It has the codex, which makes an entry
readable by encountering the pathology rather than by reading ahead, and which
rebuilds each entry's worked example from the player's own run. And it has a complete
persistence layer over IndexedDB: boundary and provisional saves, a canonical
checksum, run summaries, codex progression across runs, settings, and a
diagnostics ring.

## Prerequisites

WP-11 and WP-12 complete and green. WP-14 for the `FrameEventQueue` the codex and
HUD consumers register against; if it has not landed, register against a local
queue with the same interface.

**`src/game/save.ts` and `src/game/store.ts` already exist and pass tests.**
Read both in full before writing anything. `save.ts` already carries the schema,
the `StoredSave` and `RunSummary` shapes, and the checksum design. `store.ts`
already carries the typed observable store with in-place mutation, a version
counter, selector subscriptions and a single flush per frame. **Complete and
verify them; do not rewrite either.** Where this package names a path that the
scaffold has already placed elsewhere, keep the scaffold's path and report the
difference.

## Required reading

- `03-VISUAL-BIBLE.md` section 11 in full: 11.1 (what the HUD carries), 11.2
  (what it must never carry), 11.3 (layout, the safe-area variables and the
  coverage cap), 11.4 (staying out of the way)
- `03-VISUAL-BIBLE.md` section 2.4 (semantic tokens), 2.5 (colour-blind
  accommodation), 2.6 (contrast ratios for text), 7.1 and 7.2 (the faces and the
  type scale)
- `04-NARRATIVE-BIBLE.md` section 14 in full: 14.1 (the rule for when an entry
  becomes readable), 14.2 (the entry format and the persistence shape), 14.3 (a
  filled entry)
- `04-NARRATIVE-BIBLE.md` section 9 (tombstone epitaphs) and section 15
  (progression and the end-of-run report)
- `01-ARCHITECTURE.md` section 8 in full: 8.1 (storage choice), 8.2 (schema), 8.3
  (the `SaveFile` shape), 8.4 (checksum), 8.5 (save policy), 8.8 (loading)
- `01-ARCHITECTURE.md` section 4.3 (the store), 4.4 (the two store instances), 4.5
  (how the HUD observes state without a framework), 4.7 (commands: the write path)
- `01-ARCHITECTURE.md` section 7.5 (the DOM rule) and 10.4 (corrupted save)
- `05-CURRICULUM-MAP.md`, the "Codex entries unlocked" section of every leg, which
  is where the entry ids and their concept text come from

## Files you will create or complete

```
src/ui/hud/Hud.ts
src/ui/hud/regions/LegRail.ts
src/ui/hud/regions/PolicyChips.ts
src/ui/hud/regions/ConvoyPips.ts
src/ui/hud/regions/ResourceLedgerView.ts
src/ui/hud/regions/AlertStack.ts
src/ui/hud/regions/FocusHint.ts
src/ui/hud/regions/Meters.ts
src/ui/hud/hud.css.ts
src/ui/DomBatch.ts
src/ui/codex/Codex.ts
src/ui/codex/entries.ts
src/ui/codex/triggers.ts
src/ui/codex/search.ts
src/ui/codex/workedExample.ts
src/ui/cards/DebriefCard.ts
src/ui/cards/TombstoneCard.ts
src/ui/cards/PanicCard.ts
src/ui/cards/LegUnavailableCard.ts
src/ui/index.ts
src/game/save/Database.ts          (may exist inside src/game/save.ts; keep that path)
src/game/save/SaveService.ts
src/game/save/LoadService.ts
src/game/save/checksum.ts
src/game/save/migrations.ts
src/game/store/runStore.ts
src/game/CommandBus.ts
src/game/scoring.ts
tests/ui/hud.test.ts
tests/ui/hud-coverage.test.ts
tests/ui/codex.test.ts
tests/game/save.test.ts
tests/game/save-migration.test.ts
tests/game/checksum.test.ts
tests/game/scoring.test.ts
```

## Files you may modify

```
src/game/save.ts     (exists; complete and verify. Keep its exports stable.)
src/game/store.ts    (exists and passes tests; verify only. Report any change.)
```

Nothing else outside the create list.

## Frozen contracts

From `src/game/types.ts`. These may not be edited:

```ts
export interface RunState {
  readonly runId: string;
  readonly seed: number;
  readonly discClass: DiscClass;
  readonly difficulty: DifficultyTier;
  legIndex: number;
  /** Distance travelled within the current leg, 0 to 1. */
  legProgress: number;
  convoy: ConvoyMember[];
  resources: ResourceLedger;
  policy: TravelPolicy;
  tombstones: Epitaph[];
  codexUnlocked: string[];
  objectivesMet: string[];
  /** Append-only decision log. Drives the end-of-run report and the replay. */
  decisions: DecisionRecord[];
  score: ScoreBreakdown;
  status: 'in_progress' | 'complete' | 'failed';
}

export interface DecisionRecord {
  readonly tick: Tick;
  readonly legId: LegId;
  readonly kind: string;
  readonly choice: string;
  outcome: 'good' | 'costly' | 'fatal' | 'pending';
  readonly relatedObjective: string | null;
}

export interface ScoreBreakdown {
  readonly survivors: number;
  readonly throughput: number;
  readonly efficiency: number;
  readonly correctness: number;
  readonly conceptsMastered: number;
  readonly classMultiplier: number;
  readonly total: number;
}

export interface ConvoyMember {
  readonly id: ConvoyMemberId;
  readonly name: string;
  readonly role: ConvoyRole;
  pid: Pid | null;
  /** 0 to 100. At 0 the Program derezzes. */
  integrity: number;
  status: ConvoyStatus;
  epitaph: Epitaph | null;
  abilityCharges: number;
  afflictions: Affliction[];
}

export interface Epitaph {
  readonly member: ConvoyMemberId;
  readonly tick: Tick;
  readonly legId: LegId;
  readonly reason: TerminationReason;
  /** The joke line, in the Oregon Trail tombstone register. */
  readonly inscription: string;
  /** The teaching line. Always shown beneath the joke. */
  readonly cause: string;
  /** Codex entry the tombstone links into. This is the point of dying. */
  readonly codexEntry: string;
}

export interface ResourceLedger {
  cycles: number;
  quota: number;
  blocks: number;
  bandwidth: number;
}

export interface TravelPolicy {
  pace: Pace;
  rations: Rations;
  degreeOfMultiprogramming: number;
}

export interface SaveFile {
  readonly version: 1;
  readonly savedAtIso: string;
  readonly run: RunState;
  readonly kernel: KernelSnapshot | null;
  readonly rngStates: readonly RngState[];
  /** Enough to replay the run from the seed and verify the save was not edited. */
  readonly checksum: string;
}

export interface DebriefCard {
  readonly headline: string;
  readonly whatHappened: string;
  readonly whyItHappened: string;
  /** Concrete counterfactual: what the same run looks like under a better policy. */
  readonly counterfactual: string | null;
  readonly chapter: ChapterRef;
}
```

From `04-NARRATIVE-BIBLE.md` section 14.2, the codex shapes. These become frozen
when this package lands, because every leg's content is authored against them:

```ts
export interface CodexEntry {
  readonly id: string;
  readonly title: string;
  readonly chapter: ChapterRef;
  /** Two to four sentences. The mechanism, in the tone guide's register. */
  readonly concept: string;
  readonly unlock: CodexUnlock;
  /** Built from the player's own run. Null until the entry unlocks. */
  readonly workedExample: CodexWorkedExample | null;
  readonly counterfactual: CodexCounterfactual | null;
  readonly remedy: AfflictionRemedy | null;
  readonly remedyVisibility: 'immediate' | 'on_unlock' | 'after_first_success' | 'never';
  readonly related: readonly string[];
  readonly commands: readonly string[];
  readonly epitaphs: readonly string[];
}

export type CodexUnlock =
  | { readonly kind: 'affliction'; readonly id: AfflictionId }
  | { readonly kind: 'termination'; readonly reason: TerminationReason }
  | { readonly kind: 'event'; readonly type: string }
  | { readonly kind: 'objective'; readonly id: string }
  | { readonly kind: 'crossing'; readonly option: 'spin' | 'block' | 'monitor' | 'wait' }
  | { readonly kind: 'leg_complete'; readonly leg: LegId };

export interface CodexWorkedExample {
  readonly capturedAtTick: Tick;
  readonly legId: LegId;
  readonly summary: string;
  /** Rendered from the kernel event log, oldest first, at most 12 lines. */
  readonly trace: readonly string[];
  readonly metrics: Readonly<Record<string, number>>;
}

export interface CodexCounterfactual {
  readonly alternative: string;
  readonly decisionIndex: number;
  readonly replaySeed: number;
  readonly projected: Readonly<Record<string, number>>;
  readonly narrative: string;
}

export interface CodexProfileState {
  readonly seen: readonly string[];
  readonly demonstrated: readonly string[];
  readonly firstSeen: Readonly<Record<string, { runId: string; legId: LegId }>>;
}
```

## Specification

### 1. The HUD carries status, never data structures

Visual bible 11.1 and 11.2. The six regions and their sources:

| Region | Content | Source |
|---|---|---|
| Top left | Leg name, leg index of 13, progress rail | `RunState.legIndex`, `legProgress`, `Leg.title` |
| Top right | Tick counter, policy chips (scheduler, quantum, replacement, disk, allocation), pace and rations | `Kernel.tick`, `KernelConfig`, `TravelPolicy` |
| Bottom left | Convoy integrity: five pips, each with name, integrity bar, status and affliction glyphs | `ConvoyMember[]` |
| Bottom right | Resource ledger: cycles, quota, blocks, bandwidth, each with a delta indicator | `ResourceLedger` |
| Lower centre band | Alert stack, at most 3 concurrent, auto-dismissing | derived from `KernelEvent` |
| Bottom centre, transient | Focus hint: the anchor under the cursor and the key to engage | `FocusTarget.id` |

Two derived meters sit in the top right below the policy chips, because they are
the numbers the player steers by: **CPU utilisation** from
`SchedulingMetrics.cpuUtilisation` and **fault rate** from
`MemoryMetrics.faultRate`, each a 96 px horizontal bar with a marked threshold.

**What it must never carry**, and this list is exhaustive and enforced: page
tables, frame tables, ready queues, wait-for graphs, Banker's matrices, disk
queues, resource allocation tables, any list of pids, any per-process detail
beyond the five convoy Programs, any structure that has a physical representation
in the world.

If a player wants to know which frames are free, they look at the vault. If they
want to know who is waiting on a mutex, they count the arcs on the ring. **The
import restriction makes this structurally impossible to violate rather than a
matter of discipline**: `src/ui` may not import `three` and may import kernel and
game types only. Write the boundary test that enforces it.

### 2. Layout, safe areas and the coverage cap

Visual bible 11.3. Use the CSS variables exactly as printed there, sourced from
`@design/tokens` rather than as literals:

```
--hud-safe:    max(24px, 2.5vh);
--hud-gutter:  16px;
--hud-rest:    0.72;
--hud-active:  1.00;
--hud-focused: 0.25;
--hud-radius:  2px;      /* almost square; rounded corners fight the geometry */
```

The grid is three columns by three rows, `pointer-events: none` on the container
with `auto` on children, so **the world is always clickable through the HUD**.

**Coverage cap.** The union of all HUD element bounding boxes must not exceed
**11 percent of viewport area at 1440x900**, measured against a fixture run state
with all five Programs alive, all four resources non-zero, three alerts showing,
and the longest policy names selected. This is
`tests/ui/hud-coverage.test.ts` and it is a hard gate.

### 3. Staying out of the way

Visual bible 11.4, all six rules:

- Resting opacity 0.72, which sits behind the world visually and still satisfies
  the contrast table.
- **Any element whose value changes goes to opacity 1.0 for 1.2 s, then eases back
  over 400 ms.** Attention is drawn by change rather than by permanent brightness.
- During a focus lock the whole HUD drops to 0.25 **except the alert stack**,
  which stays at 1.0.
- During a convoy Program's derezz the HUD **hides entirely** from the pre-roll
  until the tombstone rises.
- **No HUD element ever animates position.** They appear, change value, and
  disappear. Sliding panels pull the eye away from the world.
- **No modal dialogs.** Player decisions are made at diegetic anchors or in the
  terminal.

Alerts: at most 3 concurrent, at most 64 characters each, always naming the
structure they refer to so the player knows where to look. Severity maps to the
palette: informational `CYAN.core`, warning `AMBER.core`, fatal `AMBER.white`
with the glyph prefix from visual bible 2.5.

### 4. `src/ui/DomBatch.ts` and observing state

Architecture 4.5 and 7.5. **No framework.** The HUD observes the store through
selector subscriptions with custom equality, and writes through `DomBatch`, which
coalesces every write into one batch per frame applied at a single point.

Two rules from the DOM rule of architecture 7.5:

- **Read then write, never interleaved.** Reading `offsetWidth` after a write
  forces synchronous layout. Batch reads first, then writes.
- **No per-frame `innerHTML`.** Update `textContent` on a stable node, or update a
  CSS custom property, which the browser can handle without a reflow.

Numeric readouts that change every tick update a CSS custom property that a
`::after` rule renders, so the tick counter costs one style write rather than a
text node replacement.

### 5. The codex

Narrative bible 14.1. **An entry becomes readable by encountering the pathology, never by
reading ahead.** There is no browsable table of contents, no chapter list, and no
way to open an entry the run has not earned. The codex is organised
**chronologically by first encounter**, not by chapter.

This is the strongest structural decision in the teaching design. Implement it as
a hard rule: `Codex.open(id)` on a locked entry returns a locked result rather
than the content, and there is no code path that returns `concept` text for an
entry not in `RunState.codexUnlocked` or in the profile's `seen` set.

Across runs, **the `concept` text of a seen entry stays readable in the profile**,
so returning players are not forced to re-suffer everything. The `workedExample`
and the `counterfactual` are per-run and are rebuilt from the current run's data,
so the entry a player opens in run four is about run four.

`triggers.ts` maps each `CodexUnlock` variant to a watcher over the event stream
and the run state. The codex is an `EventConsumer` registered after the world and
audio in the fanout, because **the codex asks the world whether the pathology is
currently on screen before it offers an entry**.

`workedExample.ts` builds `CodexWorkedExample` from the kernel event log at the
moment an entry becomes readable: at most 12 lines, oldest first, plus the named metrics the
entry's prose interpolates. **It is never authored by hand.**

`search.ts` builds the search index over readable entries only. Architecture 9.1
puts index construction in `bake.worker.ts`; expose a pure `buildIndex(entries)`
so either thread can call it.

Entry content comes from the "Codex entries unlocked" section of each leg in
`05-CURRICULUM-MAP.md`. **This package builds the codex machinery and ships zero
entry content**, except a small fixture set in the tests. Legs supply their
entries.

### 6. Save and load

Architecture 8. **IndexedDB through a thin hand-written wrapper, no library.**
`localStorage` is used for exactly two things, both of which must be readable
synchronously before the async IndexedDB open completes: the capability cache and
the tier decision, both of which WP-12 already owns.

The six object stores from architecture 8.2, with their key paths and indices:
`saves` (key `id`, indices `byRun`, `bySavedAt`), `runs` (key `runId`, indices
`byStatus`, `byStartedAt`), `replays` (key `runId`), `codex` (key `entryId`),
`settings` (key `key`), `diagnostics` (auto key, index `byCreatedAt`, capped at
the last 20 bundles, oldest deleted on write).

Two details in `Database.open` that are easy to skip and expensive to miss:

- `req.onblocked` rejects with a message naming another tab holding the old
  version.
- `db.onversionchange` closes the connection, so a second tab upgrading the schema
  cannot corrupt this one's view.

**Checksum**, architecture 8.4: FNV-1a 64-bit over a canonical serialisation,
salted with the build id, encoded as 16 hex characters. It is not a cryptographic
signature and does not pretend to be. The goal is detecting accidental corruption,
partial writes and casual hand-editing of `score` or `resources` in an exported
JSON file.

**Canonicalisation matters more than the hash function.** Two saves representing
the same state must produce the same string: keys sorted, `undefined` dropped,
`-0` normalised to `0`, non-finite numbers rejected, `Map` and `Set` rejected
because the snapshot code converts them to arrays before they reach here. This is
the same discipline as `tests/kernel/canonical.ts`; keep the two consistent and
say so in a comment.

**Save policy**, architecture 8.5. Two kinds:

- **Boundary save** at each leg transition: `kernel` is `null`, because the next
  leg builds a fresh kernel from `Leg.kernelConfig`. 40 to 90 KB.
- **Provisional save** mid-leg: a full `KernelSnapshot`. 300 to 900 KB.

Canonicalisation and checksumming run in `persist.worker.ts` where available
(architecture 9.1), because canonicalising a 900 KB save is 3 to 6 ms of string
building plus a GC spike, and it happens on tab hide when the browser is already
busy. Expose a pure function either thread can call.

No compression: it would add a dependency and a failure mode for no user-visible
benefit, and exported JSON is pretty-printed because **a save the player can read
and diff is a feature for an educational game**.

**Loading**, architecture 8.8. `LoadOutcome` has five variants: `ok`, `repaired`,
`checksum_failed`, `unreadable`, `not_found`. The resume path differs by kind:

- Boundary: `RunState` restored, the leg built from `LEG_ORDER[run.legIndex]`,
  `Leg.kernelConfig`, a fresh kernel, `populate`, continue. `kernel` is `null`
  and that is expected.
- Provisional: the same, then `kernel.restore(file.kernel)` **after** `populate`
  runs, because `populate` declares the resources and sync primitives the snapshot
  references by id.
- **Either way, the world is rebuilt from nothing.** `createStage` runs against the
  restored state. No view state is ever persisted, so there is no stale-mesh
  failure mode.

A corrupted save follows architecture 10.4: a checksum mismatch is reported, not
silently accepted and not silently discarded. The player is offered the save with
its integrity flagged.

### 7. `src/game/CommandBus.ts` and `scoring.ts`

`CommandBus` is the single write path from any UI surface to the kernel,
architecture 4.7. It appends a `DecisionRecord` to `RunState.decisions` and then
calls the kernel mutator. **Nothing else in `src/ui` or `src/terminal` may call a
kernel mutator**, because an unrecorded decision breaks replay and therefore
breaks the counterfactual debrief.

`scoring.ts` computes `ScoreBreakdown`. Weights are placeholders in phase 1,
marked `// TODO(astra): balance pass in phase 2`, and the test asserts only
monotonicity, not specific totals: more survivors never lowers the score, higher
privilege excess never raises `correctness`, and `total` is a pure function of the
six components and the class multiplier.

## Acceptance criteria

1. `npm run typecheck` exits 0.
2. `npm run test` exits 0.
3. `npm run build` exits 0.
4. `src/ui/` contains no `three` import and no hex colour literal, and imports
   from `src/kernel/` and `src/game/` with `import type` only. Asserted by a
   boundary test.
5. No HUD region reads a page table, frame table, ready queue, wait-for graph,
   Banker's matrix, disk queue, resource allocation table or any list of pids.
   Asserted by a source scan plus a shape assertion on every region's props.
6. HUD coverage does not exceed 11 percent of viewport area at 1440x900 with the
   worst-case fixture.
7. Every HUD element sits at least `max(24px, 2.5vh)` from the viewport edge.
8. Resting opacity is 0.72; a changed value goes to 1.0 for 1.2 s then eases back
   over 400 ms; a focus lock drops the HUD to 0.25 with the alert stack at 1.0.
9. During a convoy derezz the HUD is hidden from pre-roll to tombstone, asserted
   over the full 3.9 s sequence.
10. No HUD element animates position: asserted by a scan for `transform`,
    `translate`, `left`, `top` and `right` in any transition or animation
    declaration.
11. There are no modal dialogs: no element with `role="dialog"` and no element
    that traps focus.
12. Alerts are capped at 3 concurrent and 64 characters, and every alert names a
    structure.
13. Every text token pair in the HUD meets its contrast ratio from visual bible
    2.6, computed against the void at 0.72 opacity.
14. Rendering 1,000 HUD updates performs one DOM batch per frame and zero layout
    thrash, verified by asserting no `offsetWidth` read follows a write within a
    frame.
15. `Codex.open(id)` on a locked entry returns a locked result and no code path
    returns `concept` text for an entry not in `codexUnlocked` or the profile's
    `seen` set.
16. There is no browsable index of locked entries: the codex list contains only
    readable entries, asserted with a fixture where 3 of 10 are readable.
17. Entries are ordered chronologically by first encounter, not by chapter.
18. `CodexWorkedExample` is built from the event log and is at most 12 lines,
    oldest first.
19. A seen entry's `concept` survives across runs through `CodexProfileState`,
    while its `workedExample` and `counterfactual` are rebuilt per run.
20. Every `CodexUnlock` variant has a working trigger, asserted one case per
    variant.
21. The codex consumer runs after the world and audio in the fanout order.
22. `Database.open` creates all six stores with their documented key paths and
    indices, and handles `onblocked` and `onversionchange`.
23. The diagnostics store is capped at 20 records, oldest deleted on write.
24. `canonicalise` produces identical output for two structurally equal objects
    with different key insertion orders, rejects non-finite numbers, rejects `Map`
    and `Set`, and normalises `-0`.
25. The checksum is 16 lowercase hex characters, changes when any covered field
    changes, and is unchanged by a key reordering.
26. A boundary save has `kernel === null` and is under 120 KB for a mid-journey
    fixture; a provisional save carries a full snapshot.
27. Round trip: save then load then compare gives a canonically identical
    `RunState`.
28. A hand-edited `score` field produces `checksum_failed` rather than silent
    acceptance.
29. `LoadOutcome` covers all five variants and each is reachable in a test.
30. A provisional resume calls `populate` before `kernel.restore`, asserted by
    ordering probes.
31. `CommandBus` appends exactly one `DecisionRecord` per command and then calls
    the mutator, in that order.
32. `scoring.ts` is monotonic: more survivors never lowers `total`, higher
    privilege excess never raises `correctness`.
33. `src/game/store.ts` is unchanged, or every change is listed in the report.

## Tests you must write

### `tests/ui/hud.test.ts`

| Case | Assertion |
|---|---|
| `six regions` | all six regions render from the fixture run state |
| `two meters` | CPU utilisation and fault rate render as 96 px bars with a marked threshold |
| `forbidden data` | per acceptance criterion 5 |
| `safe area` | per acceptance criterion 7 |
| `opacity states` | per acceptance criterion 8 |
| `derezz hide` | per acceptance criterion 9 |
| `no position animation` | per acceptance criterion 10 |
| `no modals` | per acceptance criterion 11 |
| `alerts` | per acceptance criterion 12 |
| `contrast` | per acceptance criterion 13 |
| `dom batch` | per acceptance criterion 14 |
| `pointer through` | the container is `pointer-events: none` and children are `auto` |
| `boundaries` | per acceptance criterion 4 |
| `tick counter cost` | the per-tick numeric readout updates a CSS custom property, not a text node |

### `tests/ui/hud-coverage.test.ts`

One case: the worst-case fixture per visual bible 11.3, measured at 1440x900,
asserted under 11 percent. Print the measured percentage in the failure message so
a regression is diagnosable.

### `tests/ui/codex.test.ts`

| Case | Assertion |
|---|---|
| `locked returns locked` | per acceptance criterion 15 |
| `no browsable index` | per acceptance criterion 16 |
| `chronological` | per acceptance criterion 17 |
| `worked example` | per acceptance criterion 18 |
| `worked example not authored` | every `CodexWorkedExample` field derives from the event log or the run state, asserted by construction |
| `profile persistence` | per acceptance criterion 19 |
| `six CodexUnlock kinds` | per acceptance criterion 20 |
| `consumer order` | per acceptance criterion 21 |
| `remedy visibility` | each of the four `remedyVisibility` values shows or hides the remedy as documented |
| `search readable only` | the index contains no locked entry |
| `no shipped content` | this package ships zero real entries; the fixture set is under `tests/` |

### `tests/game/save.test.ts`

Use `fake-indexeddb`, which is already a dev dependency.

| Case | Assertion |
|---|---|
| `schema` | per acceptance criterion 22 |
| `blocked` | `onblocked` rejects with a message naming another tab |
| `versionchange` | a version change closes the connection |
| `diagnostics ring` | per acceptance criterion 23 |
| `boundary save` | per acceptance criterion 26, first half |
| `provisional save` | per acceptance criterion 26, second half |
| `round trip` | per acceptance criterion 27 |
| `load outcomes` | per acceptance criterion 29 |
| `resume order` | per acceptance criterion 30 |
| `world rebuilt` | no view state is persisted; the save contains no mesh, material or camera field |
| `run summary` | the `runs` store is readable without deserialising a full save |

### `tests/game/checksum.test.ts`

| Case | Assertion |
|---|---|
| `canonical` | per acceptance criterion 24 |
| `format` | per acceptance criterion 25 |
| `tamper detected` | per acceptance criterion 28 |
| `build id salt` | the same state under two build ids gives two checksums |
| `consistent with kernel canonical` | `canonicalise` and `tests/kernel/canonical.ts` agree on a shared fixture |

### `tests/game/save-migration.test.ts`

| Case | Assertion |
|---|---|
| `version 1 identity` | a version 1 save loads unchanged |
| `unknown version` | a save with a version this build does not know produces `unreadable` with a clear message rather than throwing |
| `migration hook` | `migrations.ts` exposes a registry keyed by version, currently empty, and adding a fixture entry runs it |

### `tests/game/scoring.test.ts`

| Case | Assertion |
|---|---|
| `monotonic survivors` | per acceptance criterion 32, first half |
| `monotonic correctness` | per acceptance criterion 32, second half |
| `pure` | `total` is a pure function of the six components and the multiplier |
| `placeholder marked` | the weights carry a `// TODO(astra):` naming the phase 2 balance pass |

## Out of scope

- The counterfactual replay worker and `src/game/replay/`. WP-18 owns them.
  `DebriefCard.counterfactual` is left `null` by this package and filled by WP-18.
- Any codex entry content. Legs supply it.
- Any leg module. `src/legs/registry.ts` exists in the scaffold; leave it alone.
- `src/world/`, `src/render/`, `src/terminal/`, `src/audio/`, `src/kernel/`.
- The settings UI beyond reading and writing the `settings` store. WP-16's
  `settings.ts` is the audio half and this package persists it.
- Scoring balance. Placeholders only.

## Report back

State:

1. Pass or fail for each of the thirty-three acceptance criteria, by number.
2. The three verification command outcomes.
3. What `src/game/save.ts` already implemented correctly, what was missing, and
   every line you changed.
4. Whether `src/game/store.ts` needed any change, and if so exactly what and why.
5. Every path where you kept the scaffold's naming instead of this package's
   suggested path.
6. The measured HUD coverage percentage at 1440x900 with the worst-case fixture.
7. The measured boundary and provisional save sizes for a mid-journey fixture.
8. Every `// TODO(astra):` left in the tree, with file and line, including the
   scoring placeholders.

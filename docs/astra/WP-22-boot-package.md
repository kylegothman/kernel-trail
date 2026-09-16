# WP-22: The boot package

## Objective

When this package is done, `npm run dev` opens a page that boots the
renderer, offers a new run or a saved one, loads leg 0 through the registry,
and lets the player travel it with the world drawn from the leg's layout,
the HUD live, the terminal open on a key, the codex readable, crossings and
the depot decided in non-modal panels, casualties shown as tombstones, and
the debrief shown at the end of the leg before the next leg loads. Every
piece of that already exists on main as a library; nothing today calls it
from a browser. `index.html` mounts a `#stage` canvas and `src/main.ts`
looks for `#app`, so the app has never booted. This package writes the
assembly and nothing else: no new game rules, no new kernel behaviour, no
structure art. Where a surface a leg needs has no browser form yet (the
crossing choice, the depot catalogue, the reclamation round, the codex
view), this package ships the plainest DOM that exposes the existing model,
and says so in the file header, so the structures package and a later UI
pass replace it without touching the wiring.

The player-facing loop after this package is: title screen, leg entry with
the layout drawn as stand-in forms, travel under the fixed-step loop, panels
for the leg's decisions, debrief, next leg. Legs 0, 3, 4 and 7 are being
built now on other branches; this package must not depend on any of them
and must load whatever `LEG_LOADERS` resolves, showing the leg-unavailable
card for the rest.

## Prerequisites

WP-01 through WP-21 complete and green. Main at `2cf5062` or later. Wave A
leg branches are in flight; do not merge them and do not read their
worktrees.

## Required reading

- `docs/01-ARCHITECTURE.md` section 2.2 (frame pipeline, the ordering
  rules), 2.3 (the loop, which `src/app/loop.ts` ships), 3.3 (audio, HUD and
  codex subscribe separately), 12.2 (Vite configuration: `define` and
  `worker`), 12.3 (code splitting), 13.2 (leg directory shape)
- `docs/03-VISUAL-BIBLE.md` 11.3 (HUD CSS) and the "No modal dialogs" rule
  near line 2742
- `docs/04-NARRATIVE-BIBLE.md` 12.2 (crossing quotes; "Contention is shown
  as a number" near line 3001), 10 (the depot; the line "Depot open. Cycles
  accepted. Nothing here is a favour."), 11 (reclamation)
- `src/app/loop.ts`, `src/app/RunHost.ts`, `src/app/commandSinkAdapter.ts`
- `src/game/LegRunner.ts` (`LegRunnerDeps`, `LegEvent`, `enter`, `resume`,
  `applyContent`, the modal verbs at lines 252 to 257), `src/game/RunDirector.ts`
  (`interaction`, `dispatch`)
- `src/game/persist/SaveService.ts`, `src/game/persist/LoadService.ts`,
  `src/game/save.ts` (`Database`), `src/game/replay/*` (`createRunStreams`,
  `initialRunState`, `livePolicyBinding`), `src/game/workers/*Handle.ts`
- `src/legs/registry.ts`, `src/legs/content.ts`, `src/legs/layout.ts`,
  `src/legs/epitaphs.ts`
- `src/render/index.ts`, `src/render/backend/createBackend.ts`,
  `src/render/camera/TravelCamera.ts`, `src/render/postChain.ts`,
  `src/render/derezz/DerezzPool.ts`, `src/render/backend/benchmarkHost.ts`
- `src/world/contracts.ts`, `src/world/StageBuilder.ts`,
  `src/world/structures/base/Structure.ts`, `src/world/forms/index.ts`,
  `src/world/WorldEventRouter.ts`, `src/world/domains/*Visuals.ts`
- `src/platform/index.ts` (`detectCapabilities`, `selectTier`, `benchmark`,
  `PROFILES`, `QualityGovernor`)
- `src/ui/hud/Hud.ts`, `src/ui/codex/Codex.ts`, `src/ui/cards/*.ts`
- `src/terminal/Terminal.ts`, `src/terminal/Shell.ts`, `src/game/terminalHost.ts`
- `src/audio/AudioEngine.ts`, `src/audio/settings.ts`
- `tests/render/gpu/focus.gpu.ts` lines 14 to 44 (the only working assembly
  of backend, atlas, context, services and builder; copy its order),
  `tests/render/gpu/hud.gpu.ts`, `tests/render/gpu/run.mjs`

## Files you will create

```
src/main.ts                             (rewritten in place; the placeholder goes)
src/app/boot.ts                         (capabilities, tier, backend, database; returns a BootContext)
src/app/BrowserSession.ts               (one run in a browser: runner, host, loop, panels, wiring)
src/app/screens/TitleScreen.ts          (new run or continue; disc class, difficulty, quality)
src/app/stage/LayoutStage.ts            (a scene built from LegLayout with stand-in forms)
src/app/stage/LayoutStructure.ts        (one Structure per anchor, form or labelled slab)
src/app/panels/panel.ts                 (the shared non-modal panel shell)
src/app/panels/CrossingPanel.ts         (the four quotes; contention as a number)
src/app/panels/DepotPanel.ts            (the catalogue; buy; continue)
src/app/panels/ReclamationPanel.ts      (stand-in round: an empty trace; continue)
src/app/panels/CodexPanel.ts            (list, search, read; the codex has no view today)
src/app/panels/InteractionPanel.ts      (the leg's interactions as buttons at their anchors)
src/app/input.ts                        (keys: terminal toggle, codex toggle, focus engage, pause)
src/app/frame.ts                        (the browser SimHost hooks over RunHost, section 4)
tests/app/boot.test.ts
tests/app/BrowserSession.test.ts
tests/app/LayoutStage.test.ts
tests/app/panels.test.ts
tests/render/gpu/boot.html
tests/render/gpu/boot.gpu.ts
```

## Files you may modify, each by exact grant quoted in the pre-flight

```
vite.config.ts        (define __BUILD_ID__ and __BUILD_TIME__; worker format; section 1)
src/vite-env.d.ts     (declare the two globals if the file exists; create it if not)
index.html            (nothing, unless the pre-flight shows a reason; the canvas id stays `stage`)
tests/render/gpu/run.mjs   (register boot.html in the input list at line 16 and add one block; section 9)
package.json          (nothing; no dependency is added)
```

Nothing else. The frozen files are not touched. No file under `src/game`,
`src/kernel`, `src/render`, `src/world`, `src/ui`, `src/terminal`,
`src/audio`, `src/platform` or `src/legs` changes. If the assembly needs a
seam one of them lacks, stop and report it as a numbered finding with the
smallest diff that would provide it; do not work around it with a cast or a
private field.

## Specification

### 1. Build configuration

`vite.config.ts` gains `define: { __BUILD_ID__: JSON.stringify(<git short
SHA or 'dev'>), __BUILD_TIME__: JSON.stringify(new Date().toISOString()) }`
with the SHA read through `child_process.execSync('git rev-parse --short
HEAD')` inside a try that falls back to `'dev'`, and `worker: { format: 'es'
}` so the three worker handles' `new Worker(new URL(...), { type: 'module'
})` bundle as ES modules. Nothing else in the config changes. `save.ts`
already reads `__BUILD_ID__` with a `'dev'` fallback; after this package the
fallback is not taken in a Vite build. Declare both globals in
`src/vite-env.d.ts` (`declare const __BUILD_ID__: string;` and the same for
`__BUILD_TIME__`).

### 2. `src/app/boot.ts`

```ts
export interface BootContext {
  readonly buildId: string;
  readonly caps: RenderCapabilities;
  readonly tier: QualityTier;
  readonly backend: RendererBackend;
  readonly canvas: HTMLCanvasElement;
  readonly db: Database;
  readonly overlay: HTMLElement;
  dispose(): void;
}
export async function bootBrowser(canvas: HTMLCanvasElement, options?: { forceWebGL?: boolean; tier?: QualityTier }): Promise<BootContext>;
```

Order: `detectCapabilities(buildId, forceWebGL)`; `selectTier(caps,
buildId, c => benchmark(c, createBenchmarkHost), options.tier)`;
`createBackend(canvas, caps, { profile: PROFILES[tier], antialias: false,
samples: 4, resources }, forceWebGL)` where `resources` supplies a cached
slab and the structure material as `focus.gpu.ts` does; `backend.resize` to
the window's client size and `devicePixelRatio`, and again on `resize`
events; twelve warm frames on an empty scene so `postChain` exists before
anything reads `backend.postChain!.state`; `new Database().open()` (read
`save.ts` for the exact open call). The overlay is a `div#overlay` the boot
appends to `document.body` after the canvas, absolutely positioned over it,
`pointer-events: none` at the root with `pointer-events: auto` on each panel,
the HUD, the terminal and the cards. `index.html` does not change; the
canvas is `#stage`. `UnsupportedBrowserError` from `detectCapabilities`
renders a plain text page ("KERNEL TRAIL needs WebGPU or WebGL2.") and
rethrows.

`src/main.ts` becomes about twenty lines: query `#stage`, call
`bootBrowser`, mount the title screen, and on its choice call
`createBrowserSession`. The placeholder renderer, the duplicated capability
and tier code, and the `#app` lookup are deleted. Keep the file free of
`three` imports; the scene is the session's.

### 3. `src/app/screens/TitleScreen.ts`

A plain DOM region in the overlay: the title, a disc class select over
`DISC_CLASSES` (or whatever `@game/types` names the list; quote it in the
pre-flight), a difficulty select over the four tiers, a quality select over
`low`, `medium`, `high` and `auto` (auto keeps the benchmark's choice;
another value calls `setUserTier`), a "New run" button, and a "Continue"
button shown only when `loadOutcome(db, ...)` reports a resumable save. The
first click on either button is the gesture that calls
`audio.unlock()`. The screen is removed once the session starts. It is not a
dialog: no role, no focus trap. Seed: a new run draws its seed from
`crypto.getRandomValues` and shows it in the HUD's leg rail title on hover
(so a bug report can carry it); a `?seed=` query parameter overrides it.

### 4. `src/app/BrowserSession.ts` and `src/app/frame.ts`

`createBrowserSession(boot: BootContext, start: { kind: 'new'; seed; discClass;
difficulty } | { kind: 'resume'; file: SaveFile })` builds, in this order:

1. `CommandBus`, `createRunStore(initialRunState(...))` for a new run or the
   loaded run for a resume, `createTelemetryStore()`.
2. `createRunStreams(seed)` (or `restoreRunStreams` on resume).
3. `ReplayWorkerHandle`, `PersistWorkerHandle`, `BakeWorkerHandle` with their
   default factories; `SaveService(boot.db)`.
4. Scene, `TravelCamera(scene, aspect, heightPx)`, `SdfAtlas(tier,
   travel.focus, heightPx)`, `WorldContext` and `StageServices` exactly as
   `focus.gpu.ts` builds them, with `kernel.process` and `kernel.tick`
   reading through a getter to the runner's current kernel (null kernel
   returns undefined and 0).
5. The ten domain visuals, `WorldEventRouter(domains, ctx, { onPanic,
   stopHost })`, `DerezzPool(tier)`, `AudioEngine({ tier, seed, settings })`
   with `bindSettings(db, AUDIO_SETTINGS_KEY, engine.settingsStore,
   normaliseAudioSettings)`.
6. `createHud({ root: overlay, runStore, telemetry, clock: performance.now,
   focusState: () => travel.focus.state, sounds: engine.ui, injectStyle: true })`.
7. `createCodexRegistry()` with the base entries plus, at each leg entry, the
   leg's `content.codex`; `createCodex({ registry, runStore, profile:
   readCodexProfile(db), currentLeg, metrics: () => telemetry.get() as
   numbers, onScreen: id => travel.focus.isRegistered(id) or `() => true` if
   the rig has no such query (say which in the pre-flight) })`; `CodexPanel`
   over it; `writeCodexProfile` on every unlock.
8. `LegRunner` with deps: `createKernel`, the streams, `onEvent: (events,
   at) => { router.route(events); hud.consume(...); engine.consumer... }`
   per the queue contract (read `FrameEventQueue` and `EventConsumer`; the
   HUD, the codex and the audio consumer each subscribe separately,
   architecture 3.3; the router is a consumer too), `epitaphs:
   sharedEpitaphSource(content.epitaphs)` rebuilt per leg, `persist` through
   `SaveService.save` on the persist worker, `buildId: boot.buildId`,
   `savedAtIso: () => new Date().toISOString()`, `throughputTarget` from
   `@game/travel` (quote the function you use), `onLegEvent` to section 6,
   `codexSignal: s => codex.signal(s)`, `onDerezz: phase => { hud.derezz[phase]();
   pool.spawn(...) on 'begin' }`, `onFailure` and `onRunnerFailure` to the
   panic card path with the message.
9. `createRunHost({ runner, commandBus, runStore, telemetry, hooks })` with
   the hooks from `src/app/frame.ts`; `GameLoop({ host })`.
10. The terminal: `createTerminalHost(kernel, sinkOverBus(bus, legId, () =>
    kernel), () => runStore.get())` rebuilt on `runner.onKernelChanged`, a
    `createTerminal(host, { document, onClose })` per kernel with the leg's
    `content.terminalHandlers` passed as `handlers`, and `Shell.onCommand`
    forwarded to `codex.signal({ kind: 'command', name, flag })`. The
    previous terminal is disposed when the kernel changes; its scrollback
    does not carry across legs (narrative says a fresh shell per leg; if you
    find otherwise, cite the line).
11. `src/app/input.ts`: backquote toggles the terminal, `c` toggles the
    codex panel, `f` engages focus on the nearest registered target and
    releases on a second press, `space` pauses through `loop.setTimeScale(0)`
    and resumes to 1, `]` and `[` step the time scale through 1, 2, 3 and
    back. Keys are ignored while the terminal has focus.

`src/app/frame.ts` supplies the four hooks in architecture 2.2 order:
`variableUpdate(dt, alpha)` runs `runner.variableUpdate`, the layout stage's
`update`, `domains.update(dt)` if the visuals expose one (quote it), the
effect registry, `pool.update(dt)`, `travel.update(dt)`, and `engine.update`
if the engine has a per-frame call; `render(alpha)` calls
`backend.renderFrame({ scene, camera: travel.camera, alpha, dtSeconds,
elapsedSeconds })` then `hud.flush()`, `terminal.flush()` and the panels'
flush; `onFrameMetrics(m)` feeds `QualityGovernor` and, when it changes
tier, `backend.setQuality` and `postChain.setTier`; `onRunStateChanged`
pauses and resumes the audio engine. DOM writes only in the commit step, no
layout reads.

The session exposes `{ loop, runner, dispose }` and `dispose` tears down in
reverse order, including `backend.onDeviceLost` handling that shows the
panic card with the reason and stops the loop.

### 5. The scene from the layout: `src/app/stage/LayoutStage.ts`

At each leg entry the session builds the visible stage from
`content.layout`, separately from the runner's own stage: the runner keeps
`stageContext: { quality: tier, run }` so the leg's `layoutStage` answers
`anchor(id)` for the interaction predicates, and the session's
`LayoutStage` is what the player sees. `buildLayoutStage(layout, ctx,
services, travel.focus, atlas)` creates a `StageBuilder`, calls
`addEnvironment()`, then adds one `LayoutStructure` per anchor, and returns
the built `LegStage` plus a `dispose` that also empties the scene (the
builder throws on a non-empty scene, so leg N+1 cannot build until leg N
is fully disposed; assert it).

`LayoutStructure extends Structure`: the anchor's `position` and `facing`
set the root transform; the mesh is the form for the eight form kinds
(`makeGridFloor`, `makeStele`, `makeSlab`, `makePagePlate`,
`makeResourceRing(tier)`, `makeBeam(tier)`, `makeHexTile`, `makeHorizon`)
with `getMaterial('emissive-panel', 'page_clean', tier)` or the closest
existing semantic (quote the choice), and for the eight named kinds and
`custom` a `makeSlab()` with a label placed through `atlas.place(anchor.label
?? anchor.id, ...)` above it. Named factories in `StructureRegistry` throw
today; do not call `addNamed`. The `FocusTarget` for every anchor in
`cameraTargets` uses the extents of its form's bounding box with 0.12
padding; anchors not in `cameraTargets` are still registered so `f` can
reach them, with `dimOthers` 0. Geometry goes through `GeometryLeases` and
`cachedGeometry`; leases are released in `dispose`.

`src/app/panels/InteractionPanel.ts` lists the leg's `interactions` with
`label`, `description`, cost and enabled state (from `enabledWhen(run)` on
each flush), and a click dispatches `{ kind: 'interaction', id }` through
the bus with `source: 'player'`, which the director admits or refuses. The
button sits in the overlay, not in the scene; projecting the anchor to
screen space is the structures package's job. Group buttons by anchor id.

### 6. `LegEvent` handling

`onLegEvent` switches on `kind`:

- `leg_unavailable`: `createLegUnavailableCard` in the overlay with the
  reason; a "Skip" button calls the session's `advance()` which enters the
  next leg in `LEG_ORDER`, and the run ends at the finale.
- `tombstone`: `createTombstoneCard(document, { epitaph, memberName,
  onCodex: id => codexPanel.open(id) })`; the card removes itself after
  `DEREZZ_TIMING.convoy.release` ms or on click. The HUD hide is already
  driven by `onDerezz`.
- `panic`: `createPanicCard` with the message; `loop.stop()`; a "Back to
  title" button disposes the session and remounts the title screen.
- `debrief`: `createDebriefCard(document, view.card, pending)` where
  `pending` is the counterfactual promise the runner exposes (quote the
  getter; WP-18 U-series named it). A "Continue" button calls `advance()`.
- `crossing_open`: `CrossingPanel.open(def, context)`.
- `depot_open`: `DepotPanel.open(depot)`.
- `reclamation_open`: `ReclamationPanel.open(layout)`.

Leg loading: `advance()` calls `LEG_LOADERS[id]()` once, with a 10 s
timeout, and on rejection synthesises the `leg_unavailable` path with the
error message; on success it registers `content.codex` into the registry,
rebuilds the epitaph source, disposes the previous `LayoutStage`, calls
`runner.enter(leg, { maxTicks, stageContext }, (r) => r.applyContent(content))`,
then builds the new `LayoutStage`. `maxTicks` comes from the leg's declared
budget if it has one, otherwise 20000 (quote what `Leg` carries). Do not
call `loadLeg` (its 800 ms sleep) and do not use `registerHeadlessLeg` here;
the runner does that for the replay worker.

### 7. The panels

`panel.ts`: `createPanel(doc, variant, label)` returns a `section` with
`role="region"`, a heading, a body and a footer, appended to the overlay,
with the same restraint as `cardShell`: no dialog role, no focus trap, no
backdrop. One panel of each kind at a time; opening replaces.

`CrossingPanel.open(def, context)` shows the lock id, kind, whether it is
ordered, the contention as a number with two decimals and no adjective, and
the four options from `quote(option, context)` for `spin`, `block`,
`monitor` and `wait`, each as a row of cycles, ticks, quota, bandwidth,
blocks, success probability as a percentage and event draws. A row's button
calls `runner.resolveCrossing(def, option)` and then shows the
`CrossingResult` (succeeded, attempts, afflicted, casualties, spent) with a
"Continue" that calls `runner.continueTravel()` and closes. Refused results
show `refused` and keep the panel open.

`DepotPanel.open(depot)` shows the depot line from narrative 10 as its
heading, then `depot.catalogue()` as rows of item, cycles, blocks and either
a "Buy" button or the `unavailableReason`. Items that take a target
(`repair`, `recruit`; quote the list from `prices.ts`) get a member select
over the living convoy. After each `buy` the rows re-render from a fresh
`catalogue()`. "Leave" calls `runner.continueTravel()` and closes.

`ReclamationPanel.open(layout)` is a stand-in for the real-time round
(narrative 11), which this package does not build. It shows `f`, the
fragment and leaked counts and the round's seconds, and two buttons: "Sweep"
submits an empty trace through `runner.submitReclamation([])` and shows the
`ReclamationResult` yield, "Skip" does the same (an empty trace is the only
trace a stand-in can produce honestly). Both then call `continueTravel()`.
The file header says the real round replaces this panel.

`CodexPanel` is the codex's first DOM: a search field over `search(index,
query)`, the list from `codex.list()` (quote the method) with locked entries
shown as locked, and a reading pane for `codex.open(id)` showing the entry,
its remedy when present, and the chapter citation through `citation(ref)`.
Unlocks arriving while open re-render the list. The panel toggles on `c`
and closes with Escape; the loop keeps running underneath it.

### 8. Persistence

Boundary and provisional saves go through `SaveService.save` on the persist
worker; the title screen's Continue resumes through `resumeRun` and
`runner.resume(file, legs, opts, configure)` with the legs loaded through
`LEG_LOADERS` for every id the file needs (the current leg and, for the
replay worker, none). Audio settings bind at boot. The codex profile is
read at boot and written on each unlock. Nothing else is persisted; the
quality tier already caches under `CACHE_KEY`.

### 9. GPU fixture

`tests/render/gpu/boot.html` and `boot.gpu.ts` boot the real session with
`forceWebGL` from the query string and a synthetic leg (build one in the
fixture from `tests/legs/harness/syntheticLeg.ts`, registered in a local
loader map the session accepts through an optional `loaders` override in
`createBrowserSession`; that override is the only test seam the session
has), run 120 frames through a fake clock, and expose `info()` and `run()`
as the other fixtures do. `run()` asserts: the backend id matches the
request, the layout stage placed one structure per anchor, the HUD's leg
rail shows the synthetic leg's title, the terminal accepts `ps` and
returns a line, a scripted crossing opened the panel and `resolveCrossing`
closed it, and disposal empties the scene and releases all geometry
leases. Register the page in `run.mjs` at line 16 and add a block after
the replay block, both backends, tier high only. This is the package's
only browser evidence; the reviewer verifies everything else in Node.

### 10. Node tests

`tests/app/boot.test.ts` covers `bootBrowser` with an injected
capabilities result and backend factory (add the injection as optional
parameters on `bootBrowser` if needed; say so). `BrowserSession.test.ts`
under happy-dom with a fake backend, fake workers (the handles take a
`WorkerFactory`), the synthetic leg through the `loaders` override, and a
fake clock: entering a leg builds a stage with the right structure count,
120 frames tick the kernel, a `crossing_open` LegEvent opens the panel and
resolving it writes the `crossing` record, `depot_open` and `reclamation_open`
likewise, a tombstone card appears on a casualty and removes itself,
`leg_unavailable` shows the card, the terminal's `ps` writes through the bus
with `source: 'terminal'`, `Shell.onCommand` reaches `codex.signal`, and
`dispose` leaves the scene empty and the loop stopped. `LayoutStage.test.ts`
covers the seventeen kinds, the labelled slab path, focus registration
and lease release. `panels.test.ts` covers the four panels over fake
runners. All of them run under the existing vitest config; no new alias is
needed (`@app` exists).

## Acceptance criteria

1. `npm run dev` opens the title screen, and "New run" reaches leg 0's
   entry or its leg-unavailable card without a console error.
2. `src/main.ts` queries `#stage`; nothing references `#app`.
3. `vite.config.ts` defines `__BUILD_ID__` and `__BUILD_TIME__` and sets
   `worker.format` to `es`; `npm run build` emits the three workers as ES
   modules and one chunk per leg loader.
4. The session builds every dependency of `LegRunnerDeps` from real modules;
   no dep is a stub outside tests.
5. The visible stage is built from `content.layout` through `StageBuilder`
   with one structure per anchor; named and custom kinds are labelled slabs;
   `addNamed` is not called.
6. Frame hooks follow architecture 2.2 order; DOM writes happen only after
   `renderFrame`.
7. All seven `LegEvent` kinds are handled; none is silently dropped.
8. Crossing, depot and reclamation panels drive the runner's verbs and
   close through `continueTravel`; contention is displayed as a number.
9. The codex panel lists, searches, opens and re-renders on unlock; the
   profile persists.
10. The terminal writes through `sinkOverBus` with `source: 'terminal'`;
    `Shell.onCommand` reaches the codex.
11. Boundary and provisional saves reach IndexedDB through the persist
    worker; Continue resumes.
12. Audio unlocks on the first title-screen gesture and settings bind.
13. `boot.gpu.ts` passes on both backends on the M3 (Kyle runs it).
14. No frozen file, no `src/game`, `src/kernel`, `src/render`, `src/world`,
    `src/ui`, `src/terminal`, `src/audio`, `src/platform` or `src/legs`
    file changes.
15. The four gates pass on every commit; no skipped test; no em dash or
    en dash used as an em dash anywhere in the diff.

## Report back

State the exact vite.config diff, the `BootContext` and session shapes as
shipped, which seams you had to work around and how (or that there were
none), the tail of `npm run test:gpu` from Kyle's machine, the `npm run
build` chunk listing with the worker and leg chunks visible, and any gap
between this document and the tree, numbered. Do not merge; push `wp-22`
and stop.

## Pre-flight before writing

Read this document and the required reading, then send a pre-flight
listing, numbered: the vite.config diff (section 1); the `DISC_CLASSES`
name and the `Leg` budget field (sections 3 and 6); the debrief pending
getter (section 6); the domain visuals' per-frame call and the engine's,
if any (section 4); the `Codex` list and open methods and the focus rig's
registration query (sections 4 and 7); the material semantic chosen for
the forms (section 5); the depot items that take a target (section 7); the
`Database` open call (section 2); the `throughputTarget` source (section
4); and every seam you cannot reach without editing a file outside the
grant, each with the smallest diff. Wait for the reply before the first
commit. Every commit passes all four gates on its own and ends with both
attribution lines.

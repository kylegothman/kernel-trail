# WP-23: Playthrough, browser CI and the balance ledger

## Objective

When this package is done, three things that are true today only because a
person checked them by hand become true because a test says so on every
push. A browser plays the game across leg boundaries, through the skip route
and through a close-and-resume, and reaches the same event-log hash the
headless harness reaches for the same seed. The renderer runs under CI on a
software rasteriser, so a rendering regression fails a pull request instead
of waiting for someone to run `npm run test:gpu` on a Mac. And every number
the game currently treats as provisional is written down in one file that a
test holds the goldens to, so the balance pass has something to edit rather
than something to discover.

This package adds no game rules and no art. It touches the test harness, the
GPU runner, the CI workflow, one debug seam in the boot package, and the
golden recorder.

## Prerequisites

Main at `aff0844` or later. Four legs shipped: `boot_sector`, `quantum_pass`,
`the_narrows`, `allocation_yards`. No leg package in flight touches the files
below.

## Required reading

- `tests/render/gpu/run.mjs` in full, especially the launch arguments at
  line 33, the Vite build and server setup, and the results path
- `tests/render/gpu/realApp.mjs`, `harness.ts`, `validation.ts`,
  `awaitReadback.ts`
- `tests/legs/harness/LegHarness.ts` (`runLeg`, `HarnessResult.logHash`),
  `fixtureContract.ts` (`LegFixture`, `enteringLedger`), `expectOutcome.ts`
  (`OutcomeExpectation`), `journey.ts`, `goldens.test.ts`, `smoke.test.ts`
- `tools/golden/record.ts`, `tools/ci/legGoldens.mjs`
- `src/app/BrowserSession.ts` (`createBrowserSession`, `advance`, the
  `loaders` override), `src/app/boot.ts`, `src/app/screens/TitleScreen.ts`
- `src/app/throughput.ts` and `src/game/replay/hash.ts`
- `src/game/persist/SaveService.ts` and `LoadService.ts` (`loadOutcome`,
  `resumeRun`)
- `.github/workflows/ci.yml`
- `tests/legs/<id>/fixtures.ts` for all four shipped legs, to see the
  `enteringLedger` each one declares and the comment saying where it came from

## Files you will create

```
tests/e2e/playthrough.mjs              (the browser playthrough, section 1)
tests/e2e/seams.ts                     (typed access to the debug seam)
tests/golden/balance.json              (the ledger, section 3)
tests/legs/balance.test.ts             (the ledger's test)
tools/golden/balance.ts                (writes the ledger from the goldens)
docs/evidence/wp23-browser-ci.md       (first CI run's tail and timings)
```

## Files you may modify, each by exact grant quoted in the pre-flight

```
tests/render/gpu/run.mjs      (portable launch, portable paths, a --ci mode; section 2)
tests/render/gpu/realApp.mjs  (export the page-driving helpers the playthrough reuses; nothing else)
.github/workflows/ci.yml      (one new job, section 2)
package.json                  (scripts test:browser and golden:balance; no dependency change)
src/app/BrowserSession.ts     (the debug seam, section 1, DEV only)
src/app/main.ts               (attach the seam, section 1, DEV only)
tools/golden/record.ts        (also writes the balance row; section 3)
tests/legs/goldens.test.ts    (protected; one case, quote-and-wait, pre-ruled: the ledger row exists for every recorded golden)
```

Nothing else. The frozen files are not touched. No file under `src/game`,
`src/kernel`, `src/render`, `src/world`, `src/ui`, `src/terminal`,
`src/audio`, `src/platform` or `src/legs` changes. If the playthrough needs
something the session does not expose, the debug seam in section 1 is where
it goes, and it is the only place.

## Specification

### 1. The browser playthrough

`tests/e2e/playthrough.mjs` runs under the same Playwright the GPU runner
uses and against the same Vite server `run.mjs` starts. It is invoked by
`run.mjs` after the real-app cases, in both the local run and the CI run, so
there is one runner and one results file.

The debug seam. `createBrowserSession` returns its handle as today; under
`import.meta.env.DEV` only, `main.ts` attaches it at
`globalThis.__kernelTrailDebug` with exactly this read-only surface:

```ts
interface KernelTrailDebug {
  readonly buildId: string;
  legId(): LegId | null;
  tick(): number;
  phase(): LegPhase | null;
  /** hashEventLog over every kernel event the session has routed since the run began. */
  logHash(): string;
  /** Per-leg hashes in order, for legs that have completed. */
  legHashes(): readonly { legId: LegId; hash: string; ticks: number }[];
  run(): Readonly<RunState>;
}
```

It reads; it never writes. The production build does not include it, and a
test asserts that `dist/` contains no occurrence of `__kernelTrailDebug`.
The hash is the same `hashEventLog` the harness and the replay worker use,
over the same events the `RunHost` queue delivers, so a browser hash and a
harness hash for the same seed and the same decisions are comparable by
construction.

The playthrough, one context per backend the runner has available, viewport
1440 by 900, device scale 2:

1. Open `/?seed=<S>` where `S` is the shared fixture seed `0x4b54524c`.
   Select disc class `shell`, difficulty `operator`, quality `low`. Click
   New run. Wait for the leg rail to read `The Boot Sector`.
2. Let the Boot Sector run passively to its debrief. Assert a
   `.kt-card--debrief` appears, read `legHashes()`, and assert the Boot
   Sector's hash equals the hash the harness produces for
   `runLeg(boot_sector, { seed: S, policy: 'passive', discClass: 'shell',
   difficulty: 'operator' })`, computed in the same Node process before the
   browser launches. This is the equivalence assertion: the browser's frame
   loop and the harness's pump must drive the kernel identically.
3. Click Continue. Assert a `.kt-card--unavailable` for `fork_fields`, click
   Skip. Assert the same for `the_weave`, click Skip. Assert the leg rail
   reads `Quantum Pass` and `phase()` becomes `travelling`.
4. Let the Quantum Pass run passively to its debrief. Assert the headline
   matches `/SABLE never ran\./` and that SABLE's convoy pip reads
   `DEREZZED`, which is the leg's recorded passive outcome. Assert
   `legHashes()` now has two entries and the second equals the harness's
   passive hash for `quantum_pass` at seed `S`.
5. Resume. Click Continue, skip `the_cistern` and `the_gridlock`, and wait
   until the Narrows is travelling with `tick()` at least 20. Then
   `page.reload()`. Assert the title screen shows a Continue button (the
   provisional save landed on `pagehide`). Click it. Assert the leg rail
   reads `The Narrows`, `tick()` is at least the tick observed before the
   reload, and the run continues to its debrief. Then assert the Narrows'
   entry in `legHashes()` equals the hash of an uninterrupted passive run of
   the Narrows at seed `S` from the same entering state, which the harness
   computes by running the shipped prefix through the journey machinery.
   That is the assertion that a mid-leg save and resume in a real browser is
   lossless, which the Node tests prove only over a fake IndexedDB.
6. Continue into the Allocation Yards and let it run to its debrief. Assert
   four entries in `legHashes()` and no console error at any point, using
   the validation probe `realApp.mjs` already installs.

Timing: the whole playthrough at low quality is about four legs of 85 to 200
ticks at 20 Hz, so under two minutes of wall time on the M3 and, under a
software rasteriser in CI, budget eight minutes with a hard timeout of
twelve. The playthrough is a correctness test, not a performance test; it
asserts no frame or tick timing.

Every assertion prints the value it saw beside the value it expected, so a
failure names the leg, the phase and the two hashes.

### 2. The renderer under CI

`run.mjs` today launches with `--use-angle=metal`, builds into
`/private/tmp/kt-wp12-gpu-build`, and writes results to
`/private/tmp/kt-wp12-gpu-results.json`. All three are Mac-only. Make it
portable:

- Launch arguments come from a function of the platform and a `--ci` flag.
  On macOS without `--ci`, unchanged. With `--ci` or on Linux:
  `['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist']` and no WebGPU flags. The WebGPU preflight still
  runs and is expected to report unavailable, and the runner takes the
  forced-WebGL2 path it already has for that case. Say in the output that
  WebGPU was not exercised.
- The build directory and the results path come from `os.tmpdir()` joined
  with the existing basenames, and the results path is also echoed so the
  workflow can upload it as an artifact.
- Under `--ci`, every timeout in the runner is multiplied by 4 and the
  per-fixture frame counts are unchanged. Nothing about what is asserted
  changes; only how long it may take.

`package.json` gains `"test:browser": "node tests/render/gpu/run.mjs --ci"`.
`npm run test:gpu` stays what it is and stays the WebGPU evidence.

`ci.yml` gains one job after `gates`:

```yaml
  browser:
    name: renderer and playthrough (WebGL2, software)
    needs: gates
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run test:browser
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: browser-results
          path: ${{ runner.temp }}/kt-wp12-gpu-results.json
```

If `os.tmpdir()` on the runner is not `runner.temp`, write the results path
to `$GITHUB_OUTPUT` from the runner and use that instead; do not guess. The
first green run's tail and its timings go into
`docs/evidence/wp23-browser-ci.md` with the Chromium version, so the next
person knows what "normal" looks like.

Expect the software rasteriser to be five to twenty times slower than the
M3 and to disagree with it on pixels. No fixture asserts pixels today and
this package does not add one. If any existing fixture asserts a timing
under a name that is not already CI-aware, report it in the pre-flight with
the number, and it gets the same treatment the smoke and replay budgets got.

### 3. The balance ledger

`tests/golden/balance.json` holds, for every recorded golden, the numbers
the game currently runs on. It is written by `golden:record` alongside the
fingerprint and the summary, and by the new `golden:balance` script for all
legs at once. One row per leg and path:

```json
{
  "quantum_pass": {
    "throughputTarget": { "value": 0.1, "provisional": true },
    "good": {
      "ticks": 70,
      "objectivesMet": 7,
      "casualties": [],
      "closingLedger": { "cycles": 1439.2, "quota": 725, "blocks": 120, "bandwidth": 72 },
      "dividend": 78,
      "throughputFactor": 1.0
    },
    "bad": { "...": "same shape" },
    "enteringLedger": { "cycles": 1425, "quota": 740, "blocks": 120, "bandwidth": 80 },
    "enteringSource": "analytical curve; replace when the_weave ships"
  }
}
```

`throughputTarget.provisional` is true when the leg's companion declares
none and the value came from `PROVISIONAL_THROUGHPUT_TARGET`. `dividend` and
`throughputFactor` come from the good path's `LegOutcome` as the harness
reports it. `enteringLedger` is copied from the fixture and `enteringSource`
from the comment beside it; the recorder refuses to write a row whose
fixture lacks that comment.

`tests/legs/balance.test.ts` asserts, for every shipped leg:

1. The ledger row exists for both paths (the protected `goldens.test.ts`
   case, pre-ruled).
2. Running the fixture reproduces every number in its row exactly. The runs
   are deterministic, so this is an equality, not a tolerance.
3. Continuity: when the previous leg in `LEG_ORDER` is also shipped, this
   leg's `enteringLedger` equals the previous leg's good-path
   `closingLedger`, and `enteringSource` is not the analytical curve. When
   the previous leg is not shipped, the test prints the analytical-curve
   row and passes. Today every shipped leg's predecessor is unshipped, so
   this case prints four rows and asserts nothing; it starts biting the day
   `fork_fields` lands, and it is the test that catches a leg tuned against
   a ledger no player can arrive with.
4. Every `provisional: true` row is listed in one printed table at the end
   of the run, so the count of provisional numbers is visible on every test
   run and goes to zero only when the balance pass authors them.

The test does not assert that any number is good. It asserts that the
numbers are what the file says, and that the file says where each one came
from. That is the difference between a balance pass that edits a file and
one that has to rediscover the state of the game first.

### 4. What this package does not do

It does not add a Playwright dependency; `playwright` is already pinned at
1.63.0. It does not run WebGPU in CI. It does not assert pixels. It does not
author throughput targets or any other balance number. It does not drive a
fixture's decision script through the browser UI; the playthrough is
passive, because the equivalence it proves is between the browser's loop
and the harness's pump, and a scripted run would test the script's UI
bindings rather than the loop. Scripted browser runs are a later package if
they earn one.

## Acceptance criteria

1. `npm run test:browser` passes on the Ubuntu CI runner and on the M3 with
   `--ci`, and `npm run test:gpu` still passes on the M3 unchanged.
2. The playthrough reaches the Allocation Yards' debrief with four entries
   in `legHashes()` and zero console errors, on every backend the runner has.
3. The Boot Sector and Quantum Pass browser hashes equal the harness's
   passive hashes for the same seed, asserted, values printed.
4. The Narrows resumes after `page.reload()` and its hash equals an
   uninterrupted run's, asserted.
5. `dist/` contains no occurrence of `__kernelTrailDebug`, asserted.
6. `run.mjs` has no platform-specific path or launch flag outside the one
   function that chooses them.
7. `ci.yml` has the new job, it runs after `gates`, and the results file is
   uploaded as an artifact on success and failure.
8. `tests/golden/balance.json` has a row for all four legs and both paths,
   `balance.test.ts` reproduces every number, and the provisional table
   prints four `throughputTarget` rows.
9. `golden:record` writes the balance row in the same commit as the
   fingerprint; a golden without a balance row fails `goldens.test.ts`.
10. No frozen file changes; no file outside the two lists above changes.
11. All four gates pass on every commit; no skipped test; no em dash or en
    dash used as an em dash anywhere in the diff.

## Report back

The first green CI run's URL and the tail of its browser job with timings,
the four browser hashes beside the four harness hashes, the resume tick
observed and the tick after reload, the `run.mjs` launch function as
shipped, the full `balance.json`, and any gap between this document and the
tree, numbered. Push `wp-23` and stop; do not merge.

## Pre-flight before writing

Read this document and the required reading, then send a pre-flight,
numbered: the debug seam as you will attach it and the mechanism that keeps
it out of `dist/`; how the playthrough will obtain the harness's passive
hash for the Narrows from the same entering state (the journey machinery or
otherwise); the `run.mjs` launch function; the `ci.yml` job; the exact
`balance.json` row for `boot_sector` as the recorder will write it; the
grant for `realApp.mjs`; any timing assertion that is not CI-aware, with its
number; and every seam you cannot reach without editing a file outside the
grant, each with the smallest diff. Wait for the reply before the first
commit. Every commit passes all four gates on its own and ends with both
attribution lines.

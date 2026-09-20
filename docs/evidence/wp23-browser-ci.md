# WP-23 browser CI: the first green run and what normal looks like

The `browser` job of `.github/workflows/ci.yml` runs `npm run test:browser`,
which is `tests/render/gpu/run.mjs --ci`: Chromium's software rasteriser over
WebGL2, the renderer fixtures at the low and medium tiers, the WP-22 real-app
cases at auto, low and medium quality, and the WP-23 playthrough. The high
tier is Mac evidence through `npm run test:gpu` and is not exercised under
`--ci`; the runner prints that at the top of every `--ci` run. Every
timeout in the runner and every in-page fixture deadline is four times its
local value; nothing asserted changes.

## The first green run

Run 35527368459 on `wp-23` at `52a8fc2`,
https://github.com/kylegothman/kernel-trail/actions/runs/35527368459. The
`browser` job ran from 17:59:15 to 18:11:40 UTC, 12 minutes 25 seconds, of
which the runner itself took 11 minutes 50 seconds; Playwright's Chromium
install and `npm ci` are the rest. The machine was an 80-core AMD EPYC 9V74
Azure runner on Linux 6.17, Node 22.23.2, Chromium 153.0.8010.12, ANGLE over
SwiftShader's Vulkan. That is over the ten minutes the document budgeted for
the whole job and under the twenty the ruling asked to be flagged; the two
long cases are the medium-tier focus fixture and the medium-quality real-app
case, at 139 and 207 seconds, which the M3's rasteriser finishes in seconds.

The tail, with the runner's own timestamps:

```
17:59:47 GPU test mode: ci (software rasteriser, timeouts x4); results /tmp/kt-wp12-gpu-results.json
17:59:47 GPU fixture tiers: low, medium; the high tier is Mac evidence through npm run test:gpu and is not exercised under --ci
17:59:50 Chromium: 153.0.8010.12
         WebGPU environment: {"status":"no-adapter","detail":"requestAdapter returned null"}
         WebGPU was not exercised: this launch requests the software rasteriser over WebGL2 and no WebGPU adapter is expected.
17:59:50 Starting forced-webgl2 probe; waiting for explicit readiness
18:00:16 forced-webgl2 300-frame allocations: {"Matrix4":0,"Vector3":0,"Color":0}
18:02:12 Device loss: {"attempts":[true],"outcome":"recovered_same","backend":"webgl2"}
18:02:13 Starting wp13-webgl2-low                     (50 s)
18:03:05 Starting wp13-webgl2-medium                  (139 s)
18:05:29 Starting wp14-derezz-webgl2-low              (1 s)
18:05:31 Starting wp14-derezz-webgl2-medium           (1 s)
18:05:33 Starting audio probe; waiting for readiness
18:05:34 Audio context after gesture: {"state":"running","failureReason":null,"sampleRate":48000,"bufferRate":48000,"constructions":1,"droppedBeforeGesture":1}
18:05:36 Audio two-second run: {"state":"running", ... "cuesPlayed":502,"cuesDropped":1, ... }
18:05:37 Audio probe passed
18:05:37 Starting wp17-hud                            (1 s)
18:05:38 Starting wp18-replay                         (2 s)
18:05:40 Skipping wp22-boot: it runs at the high tier, which is Mac evidence under --ci
18:05:40 Starting wp22-real-app-webgl2-auto           (48 s, selects the low tier)
18:06:29 Starting wp22-real-app-webgl2-low            (23 s)
18:06:53 Starting wp22-real-app-webgl2-medium         (207 s)
18:10:20 Starting wp23-playthrough-webgl2-reload      (44 s)
18:10:50 playthrough reload: observed tick 20 before the reload
18:10:52 playthrough reload: saved at tick 20, pre-reload logHash 42fc4d93a3072b4e
18:10:54 playthrough reload: the title screen offers Continue; the provisional save landed at beforeunload
18:10:55 playthrough reload: tick after resume 25, tick before reload 20, saved tick 20
18:11:04 playthrough reload: pre-reload hash is the prefix of 18 events (of 41), post-resume hash is the suffix from event 18
18:11:04 Starting wp23-playthrough-webgl2-journey     (33 s)
18:11:37 wp23-playthrough-webgl2: passed in 76708 ms
18:11:37 Results written to /tmp/kt-wp12-gpu-results.json
18:11:37 Forced-WebGL2 tests passed; WebGPU was unavailable and remains unvalidated.
```

The four browser hashes on the runner beside the harness's, all equal:

| Leg | Browser | Harness | Ticks |
|---|---|---|---|
| boot_sector | a90d9419f6e31d1f | a90d9419f6e31d1f | 200 |
| quantum_pass | ddb0b2e8ca7cf9e3 | ddb0b2e8ca7cf9e3 | 70 |
| the_narrows | 2b2c3201d6fa8018 | 2b2c3201d6fa8018 | 75 |
| allocation_yards | f83a196c9b0e4f30 | f83a196c9b0e4f30 | 85 |

Quantum Pass's hash is also the checked-in bad golden. The `browser-results`
artifact, 3578 bytes, uploaded from `/tmp/kt-wp12-gpu-results.json`.

## The audio probe: 44100 against 48000

Both earlier Ubuntu runs failed the audio probe identically: the context ran
at 44100 Hz, every one of 503 cues was dropped, no voice was used, and the
adapter reported `running` with no failure reason. The buffer set is baked at
48000 and Chrome refuses a convolver impulse whose rate differs from the
context's; `AudioEngine.build` swallowed the throw and left the graph null,
so every 44100 Hz device got a silent game with no diagnostic. Commit
`52a8fc2` pins the platform context to `DEFAULT_SAMPLE_RATE` and records a
build failure on the adapter. Side by side:

| Run | Context rate | Buffer rate | Cues played | Cues dropped | Failure reason |
|---|---|---|---|---|---|
| 35480180821, before | 44100 | 48000 | 0 | 503 | null |
| 35525128816, before | 44100 | 48000 | 0 | 503 | null |
| 35527368459, after | 48000 | 48000 | 502 | 1 (the pre-gesture poke) | null |
| M3, `--ci`, after | 48000 | 48000 | 502 | 1 | null |

## What normal looks like

A green `browser` job takes about twelve minutes on the standard runner,
runs the low and medium tiers, skips the WP-22 boot case with a printed
line, reports the audio context at 48000 with one dropped cue, and ends
with the playthrough passing in 60 to 90 seconds with the four hashes above.

## The runner against the M3, from the first Ubuntu run

The first Ubuntu run, 35480180821, ran every tier and failed on four cases,
all pre-existing renderer fixtures at the medium and high tiers. The M3's
software rasteriser finishes the medium focus fixture in a few seconds; the
Xeon took 179 seconds, and the high-tier focus and boot fixtures ran past
300 seconds without becoming ready. The playthrough passed on that run in
84 seconds. That run is why `--ci` selects tiers: the high-tier assertions
are draw-call, triangle, memory and recovery budgets that do not depend on
the rasteriser's speed, so the M3 run proves them and a runner thirty to
fifty times slower at that tier proves nothing extra.

| Case, first Ubuntu run | Time | Outcome |
|---|---|---|
| probe device-loss recovery, high plan | 293 s | passed |
| focus, low | 64 s | passed |
| focus, medium | 179 s | passed |
| focus, high | over 300 s | failed on an unscaled 30 s screenshot timeout |
| boot, high | over 325 s | failed: never ready within the 240 s wait |
| real app, medium and high | 69 s, 83 s | failed on the 60 s frame-settle wait |
| playthrough, reload and journey | 84 s | passed |

## NODE_ENV and the dev server

`run.mjs` builds the fixture pages with vite's programmatic `build()` before
it creates the dev server. A programmatic build leaves `NODE_ENV=production`
set in the process, and `createServer` derives `import.meta.env.DEV` from it,
so every dev server the runner started after WP-22 added the build step has
served a production build with `DEV` false. Two halves to that. The WP-22
real-app cases have been exercising production code through the dev server,
which is arguably the better thing to test. And the WP-23 debug seam, which
exists only under `DEV`, was absent from those pages until the runner reset
`NODE_ENV` to `development` before creating the server; with that reset the
existing cases still pass, so no DEV-only assertion in the app trips on them.

## What the runner uploads

The runner appends `results=<path>` to `$GITHUB_OUTPUT` at startup and the
job uploads that path as the `browser-results` artifact on success and
failure. On `ubuntu-latest`, `os.tmpdir()` is `/tmp`, not `runner.temp`, so
the path is `/tmp/kt-wp12-gpu-results.json`; the artifact uploaded from the
failed first run too.

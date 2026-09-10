# WP-16: The procedural audio engine

## Objective

When this package is done the game has a complete Web Audio soundscape with no
audio files. Every tone, every impact, every layer of the score is synthesised at
runtime from oscillators, noise and filters. The score is adaptive: it reads the
same `KernelEvent` stream the world reads and shifts with system load, so a
thrashing convoy sounds like a thrashing convoy before the player has read the
fault meter. Event sounds are spatialised from world positions the world layer
computed, and the whole graph respects a voice budget, a master limiter and the
player's accessibility settings.

## Prerequisites

WP-01 and WP-12 complete and green. WP-14 is not a hard prerequisite, but if it
has landed you register the audio consumer against its `FrameEventQueue`; if it
has not, register against a local queue with the same interface and switch over
later.

Files that must already exist:

- `src/kernel/types.ts` (frozen), for the `KernelEvent` union
- `src/design/tokens.ts` and `motion.ts`, for the timing tokens the score uses
- `src/platform/quality.ts`, for the tier-dependent voice budget

## Required reading

- `00-DESIGN-BRIEF.md` section 2, the Audio row: **fully procedural Web Audio, no
  audio files ship.** This is a non-negotiable constraint, not a preference.
- `00-DESIGN-BRIEF.md` section 8, so the audio layer's relationship to the world
  is clear: audio is a subscriber to the event stream and never a source of truth.
- `01-ARCHITECTURE.md` section 3.3 (audio, HUD and codex subscribe to the same
  stream, separately, in a fixed order) and 3.4 (per-frame batching and
  coalescing). **The world runs before audio**, because the world computes the 3D
  positions audio uses for panning.
- `01-ARCHITECTURE.md` section 1.3, the permission matrix row for `audio`:
  `kernel` type-only, `game` type-only, `audio` itself, `design`, `platform`
  type-only. No `three`, no DOM beyond the audio context.
- `01-ARCHITECTURE.md` section 7.1 (the per-frame millisecond budget) and 10.8
  (what is deliberately allowed to fail quietly). **Losing audio is a degraded
  game; a white screen is not a game.** Audio failure must never take down a
  frame.
- `03-VISUAL-BIBLE.md` Appendix A, so each event's sound matches the beat of its
  visual treatment. The derezz timing curve in section 9.4 names the audio beat
  explicitly: at pre-roll, "audio drops to the low bed".
- `03-VISUAL-BIBLE.md` section 8.1, for the shared motion tokens the sound
  envelopes align to.
- `04-NARRATIVE-BIBLE.md` section 2 (tone guide), so the score's register matches
  the writing's.

## Files you will create

```
src/audio/AudioEngine.ts
src/audio/graph.ts
src/audio/context.ts
src/audio/VoiceBudget.ts
src/audio/voices/Voice.ts
src/audio/voices/ToneVoice.ts
src/audio/voices/NoiseVoice.ts
src/audio/voices/ImpactVoice.ts
src/audio/voices/DroneVoice.ts
src/audio/voices/GranularVoice.ts
src/audio/synth/envelope.ts
src/audio/synth/filters.ts
src/audio/synth/noise.ts
src/audio/synth/tuning.ts
src/audio/score/Score.ts
src/audio/score/layers.ts
src/audio/score/loadModel.ts
src/audio/events/AudioConsumer.ts
src/audio/events/eventSounds.ts
src/audio/ui/uiSounds.ts
src/audio/settings.ts
src/audio/index.ts
tests/audio/graph.test.ts
tests/audio/voices.test.ts
tests/audio/score.test.ts
tests/audio/eventSounds.test.ts
tests/audio/budget.test.ts
```

## Files you may modify

None. Every file this package needs it creates.

Add `standardized-audio-context` **only if** you find a real, named
incompatibility in a browser the game targets, and report it. Otherwise use the
platform `AudioContext` directly; a polyfill is a dependency and a failure mode
for no user-visible benefit.

## Frozen contracts

From `src/kernel/types.ts`, the input to the audio consumer. It may not be edited:

```ts
export type KernelEvent = /* 48 variants */;
export type KernelEventType = KernelEvent['type'];
export type KernelEventOf<T extends KernelEventType> = Extract<KernelEvent, { type: T }>;
```

From `01-ARCHITECTURE.md` section 3.3, the consumer interface audio implements
alongside the world, the codex and the HUD:

```ts
export interface EventConsumer {
  readonly name: string;
  beginFrame(): void;
  consume(e: KernelEvent): void;
  endFrame(): void;
}
```

`EventFanout.dispatch` wraps each consumer in a try/catch and **disables a
consumer that throws for the remainder of the leg**. Your consumer must therefore
never throw, and if it does, the correct outcome is that the game keeps running
without sound. Do not rely on that safety net: catch inside your own handlers so
the consumer stays alive.

## Specification

### 1. No audio files, ever

Every sound is built from `OscillatorNode`, `AudioBufferSourceNode` over a
procedurally filled buffer, `BiquadFilterNode`, `WaveShaperNode`,
`ConvolverNode` fed a procedurally generated impulse, `GainNode`,
`StereoPannerNode`, `DelayNode` and `DynamicsCompressorNode`.

**No `fetch`, no `import` of a media file, no base64 audio blob.** A test greps
for audio file extensions across `src/audio/` and fails on a hit.

Noise buffers, impulse responses and wavetables are generated at boot into
`AudioBuffer`s and cached for the session. Generation is seeded, so two players on
the same machine hear the same noise texture, and so a bug is reproducible.
Generation happens in `bake.worker.ts` where available (architecture 9.1 lists
procedural texture baking there); if the worker is unavailable, generate on the
main thread at boot and report the added milliseconds.

### 2. `src/audio/context.ts` and the autoplay rule

Browsers refuse to start an `AudioContext` without a user gesture. Handle it
explicitly:

- Construct the context lazily on the first player gesture, never at module load.
- Until then, the engine accepts events and drops them silently, with a counter so
  the diagnostics panel can say how many were missed.
- On `statechange` to `suspended`, stop scheduling and resume on the next gesture.
- Expose `readonly state: 'unstarted' | 'running' | 'suspended' | 'failed'`.

**Audio failure is quiet.** A context that cannot be created sets `state` to
`'failed'`, records the reason, and every subsequent call is a no-op. Nothing
throws upward.

### 3. `src/audio/graph.ts`, the fixed master chain

One master chain, built once, in this order:

```
voices -> per-bus gain -> bus compressor -> master gain
       -> master limiter (DynamicsCompressor, ratio 20, knee 0, attack 0.003)
       -> destination
```

Four buses, each with its own gain the settings panel exposes: `score`, `world`,
`ui`, `voice_alerts`.

The master limiter exists because a thrashing scene fires hundreds of events per
second and the sum of their peaks will clip. Set it once and never automate it.

A single `ConvolverNode` on a send provides the space. Its impulse is generated:
exponentially decaying noise, 1.8 s at high tier, 0.9 s at medium, and the
convolver is bypassed entirely at low tier in favour of a short `DelayNode`
feedback pair. This is the only tier branch in the graph.

### 4. `src/audio/voices/`

`Voice` is the abstract base: it owns its nodes, exposes `start(when, params)`,
`stop(when)` and `readonly busy: boolean`, and it **disconnects and releases every
node it created on stop**. A voice that leaks a node leaks for the session.

Five voice types, and this set is closed for phase 1:

| Voice | Built from | Used for |
|---|---|---|
| `ToneVoice` | one or two `OscillatorNode`s through a filter and an envelope | pitched cues: dispatch, acquire, grant |
| `NoiseVoice` | a noise buffer source through a bandpass with a swept centre | seeks, transfers, flow |
| `ImpactVoice` | a short noise burst plus a pitched-down sine thump | derezz, panic, denial |
| `DroneVoice` | detuned oscillators plus a slow LFO on the filter cutoff | the score's sustained layers |
| `GranularVoice` | many short grains scheduled from one noise buffer | thrashing texture, corruption |

`envelope.ts` provides ADSR built from `setValueAtTime`,
`linearRampToValueAtTime` and `exponentialRampToValueAtTime`. **Never ramp
exponentially to or from exactly zero**; it throws in some engines. Clamp to
1e-4.

`tuning.ts` fixes the pitch material. Use a single mode across the whole game so
that layered cues never clash: a minor-pentatonic set over a fixed root, with the
root chosen per leg from a table the leg supplies. Pitches are computed, not
tabled as frequencies, so transposing a leg is one number.

### 5. `src/audio/score/`, the adaptive score

The score is **layered, not sequenced.** There is no timeline. Layers fade in and
out on a load model computed from the event stream, so the music is a readout of
system state rather than an accompaniment to it.

Five layers, each a `DroneVoice` or a slow granular bed:

| Layer | Fades in on | Character |
|---|---|---|
| `bed` | always | a low sustained root, the floor of the mix |
| `pulse` | `cpuUtilisation` above 0.25 | a rhythmic gate whose rate follows the context-switch rate |
| `strain` | `faultRate` approaching `thrashingThreshold` | a detuned upper drone that beats against the bed |
| `contention` | live sync wait-queue depth | a narrow band of noise that widens with the queue |
| `alarm` | any `critical` severity event | the only layer that is not sustained; it swells and decays |

`loadModel.ts` computes the layer gains from a small set of smoothed inputs. Use
the same EWMA shape WP-06 used for `faultRate`, so the audio and the HUD agree on
what "rising" means. **Smoothing is required**: a layer gain driven directly by a
per-tick metric chatters audibly.

Layer gain changes ramp over `DUR.settle` from `@design/motion`, so the score and
the visuals breathe together.

**The derezz pre-roll.** Visual bible 9.4 states that at the pre-roll the audio
drops to the low bed. Implement it: on a convoy Program's `process.exited`, duck
every layer except `bed` to zero over 400 ms, hold through the mote, and restore
over 1.2 s after the tombstone rises. This is the one place the score is
event-driven rather than load-driven, and it is the most important 400 ms of
audio in the game.

### 6. `src/audio/events/`

`AudioConsumer` implements `EventConsumer` and maps each of the 48 `KernelEvent`
variants to a sound or to deliberate silence. Structure it as an exhaustive switch
with `assertNever`, the same shape WP-14 uses, so a new variant is a compile
error here too.

**Deliberate silence is a valid treatment and it is the right one for most
high-frequency events.** `memory.access` has no sound. `syscall.invoked` has no
sound individually; it contributes to the `pulse` layer's rate. State the silence
in the code with a comment giving the reason, so a reviewer can tell silence from
an oversight.

Events that do sound, and the beat each aligns to:

| Event | Sound |
|---|---|
| `process.created` | a short rising `ToneVoice`, pitch from the pid so siblings are distinguishable |
| `process.exited` | `ImpactVoice`, character from `TerminationReason`, matching the visual variant |
| `process.starving` | a slow detuning of that process's pitch, `fatal: true` adds a descending third |
| `context.switch` | a click at the top of the `pulse` gate, pitched from the incoming pid |
| `memory.page_fault` | a granular tick; aggregated to a density, never one grain per fault |
| `memory.page_evicted` | a downward noise sweep, longer and lower when `dirty` |
| `memory.thrashing` | the `strain` layer's target gain jumps; `critical` adds the `alarm` swell |
| `sync.acquired` / `sync.released` | a paired closing and opening interval, so a lock cycle is audibly balanced |
| `sync.race_detected` | two detuned copies of the same tone beating against each other |
| `deadlock.detected` | every voice sustains and stops moving for 600 ms, then the `alarm` swell |
| `disk.seek` | a `NoiseVoice` sweep whose duration is proportional to `distance` |
| `io.interrupt` | a short high tick; the storm condition turns the ticks into a buzz by density alone |
| `fs.corruption` | `GranularVoice` with a jittered grain pitch, `recoverable: false` removes the fundamental |
| `security.access_denied` | a hard-gated noise burst, very short |
| `kernel.panic` | everything stops, one `ImpactVoice` at full, then 900 ms of silence |

Spatialisation: the world layer runs before audio in the fanout and publishes a
screen-space or world-space position per structure. Pan from that position's x
against the camera, clamped to `[-0.7, 0.7]`. **Never pan fully hard**; a
fully-panned cue in a scene the player is reading is disorienting.

### 7. `src/audio/ui/uiSounds.ts`

Synthesised UI sounds for the HUD, the terminal and the codex: a key tick, a
command accept, a command reject, an alert appear, a focus engage and a focus
release. Keep them quiet, short and in the same tuning as everything else. The
focus engage and release sounds must align to the 520 ms and 380 ms camera
durations from visual bible 6.1.

### 8. `src/audio/VoiceBudget.ts`

A hard cap on concurrent voices per tier, taken from the quality profile:

| Tier | Concurrent voices |
|---|---|
| low | 16 |
| medium | 32 |
| high | 64 |

Over budget, the policy is **steal the oldest voice in the same bus**, never drop
the newest, because the newest is the one the player just caused. The `alarm`
layer and `kernel.panic` are exempt and always get a voice.

Voices are pooled and reused. **Constructing an `OscillatorNode` per event is the
standard way to make Web Audio stutter**, so preallocate and reuse. Measure it:
the test asserts zero node construction after warm-up over 10,000 events.

### 9. `src/audio/settings.ts`

Player-facing settings, persisted through the settings store WP-17 owns:

- Master, score, world and UI volumes, each 0 to 1, applied to the bus gains.
- `reducedMotion`, read from `prefers-reduced-motion`, which halves every envelope
  time and removes the `alarm` swell.
- `mono`, which collapses panning to centre.
- `mute`, which sets the master gain to zero without tearing down the graph, so
  unmuting is instant.

None of these change what events are consumed, so muting and unmuting mid-run
produces no state divergence.

## Acceptance criteria

1. `npm run typecheck` exits 0.
2. `npm run test` exits 0.
3. `npm run build` exits 0.
4. No audio file of any kind exists in the repository or is referenced from it.
   Verified by a source and asset scan for `.wav`, `.mp3`, `.ogg`, `.m4a`,
   `.flac`, `.aac` and `data:audio`.
5. `src/audio/` contains no `fetch`, no `three` import and no DOM access beyond
   the audio context and `matchMedia`.
6. `src/audio/` imports from `src/kernel/` and `src/game/` with `import type`
   only. Asserted by a boundary test.
7. The `AudioConsumer` switch is exhaustive over `KernelEvent['type']` with an
   `assertNever` default, and deleting a case is a compile error.
8. Every one of the 48 variants has either a sound or a commented deliberate
   silence. Asserted variant by variant, 48 cases.
9. The audio context is never constructed at module load. Verified by importing
   the module in a test with no gesture and asserting the context count is zero.
10. A failing `AudioContext` construction sets `state` to `'failed'` and every
    subsequent call is a no-op that does not throw.
11. `AudioConsumer.consume` never throws, across 10,000 randomised events
    including malformed payloads.
12. Zero `AudioNode` constructions occur after warm-up over 10,000 events.
    Verified with a counting proxy on the context.
13. Every `Voice` disconnects and releases every node it created on `stop`.
    Verified by asserting the live node count returns to baseline after 1,000
    start/stop cycles.
14. Concurrent voices never exceed the tier cap, asserted at all three tiers under
    a 500-events-per-second burst.
15. Over budget, the oldest voice in the same bus is stolen and the newest is
    kept. Asserted directly.
16. `alarm` and `kernel.panic` voices are never stolen.
17. The master limiter is present, configured once, and never automated.
18. No exponential ramp targets a value at or below zero. Verified by a source
    scan plus a runtime assertion in the envelope helper.
19. Score layer gains change only through a ramp of at least `DUR.settle`; a step
    change is a bug. Asserted by sampling the gain automation.
20. The load model's smoothing matches WP-06's `faultRate` EWMA shape, so a rising
    fault rate raises the `strain` layer's target within the same window the HUD
    meter moves.
21. A convoy Program's `process.exited` ducks every layer except `bed` to zero
    over 400 ms and restores over 1.2 s after the tombstone. Asserted by sampling
    the automation.
22. Panning never exceeds `[-0.7, 0.7]`.
23. `mono` collapses every panner to 0.
24. `mute` sets master gain to 0 without disconnecting any node, and unmute is
    instant.
25. `reducedMotion` halves every envelope time and removes the `alarm` swell.
26. Noise buffer and impulse generation is seeded: two engines with the same seed
    produce byte-identical buffers.
27. Audio consumes zero draws from any kernel `Rng` stream. Asserted by comparing
    stream states across a run with and without audio.

## Tests you must write

Use a stub `AudioContext` that records node construction, connection and parameter
automation. Do not test against a real browser context.

### `tests/audio/graph.test.ts`

| Case | Assertion |
|---|---|
| `master chain order` | voices, bus gain, bus compressor, master gain, limiter, destination, in that order |
| `four buses` | `score`, `world`, `ui`, `voice_alerts` each exist with an independent gain |
| `limiter config` | ratio 20, knee 0, attack 0.003, and no automation is ever scheduled on it |
| `convolver by tier` | 1.8 s impulse at high, 0.9 s at medium, bypassed for a delay pair at low |
| `lazy context` | per acceptance criterion 9 |
| `failed context` | per acceptance criterion 10 |
| `suspended resume` | a `statechange` to suspended stops scheduling and the next gesture resumes it |
| `boundaries` | per acceptance criteria 5 and 6 |
| `no audio files` | per acceptance criterion 4 |

### `tests/audio/voices.test.ts`

| Case | Assertion |
|---|---|
| `five voice types` | the set is exactly the five named types |
| `release` | per acceptance criterion 13 |
| `no construction after warmup` | per acceptance criterion 12 |
| `envelope zero guard` | per acceptance criterion 18, including a runtime case that would otherwise throw |
| `tuning computed` | pitches derive from a root and a mode, and transposing the root moves every pitch by the same ratio |
| `impact character` | each `TerminationReason` produces a distinct `ImpactVoice` parameter set, asserted for all ten |
| `granular density` | `GranularVoice` grain count scales with intensity and stops at the voice cap |

### `tests/audio/score.test.ts`

| Case | Assertion |
|---|---|
| `five layers` | the layer set is exactly the five named layers |
| `bed always` | `bed` gain is above zero from the first frame |
| `pulse threshold` | `pulse` fades in above `cpuUtilisation` 0.25 and out below it |
| `strain tracks faults` | per acceptance criterion 20 |
| `contention tracks queues` | the `contention` band widens with total sync wait-queue depth |
| `alarm swells` | a `critical` severity event swells and decays the `alarm` layer once |
| `ramps not steps` | per acceptance criterion 19 |
| `derezz duck` | per acceptance criterion 21 |
| `no timeline` | the score schedules no fixed sequence; asserted by running two different workloads and showing the automation differs |

### `tests/audio/eventSounds.test.ts`

| Case | Assertion |
|---|---|
| `exhaustive` | per acceptance criterion 7 |
| `coverage` | per acceptance criterion 8 |
| `never throws` | per acceptance criterion 11 |
| `silence documented` | every silent variant has a comment giving the reason, asserted by a source scan |
| `page fault aggregated` | 500 `memory.page_fault` events in one frame produce one density change, not 500 grains |
| `evict dirty longer` | `dirty: true` produces a longer, lower sweep than `dirty: false` |
| `seek proportional` | `disk.seek` sweep duration scales linearly with `distance` |
| `deadlock hold` | `deadlock.detected` sustains every voice and stops movement for 600 ms |
| `panic silence` | `kernel.panic` produces one impact then 900 ms of scheduled silence |
| `pan clamp` | per acceptance criterion 22 |
| `mono` | per acceptance criterion 23 |
| `determinism` | per acceptance criterion 27 |
| `seeded buffers` | per acceptance criterion 26 |

### `tests/audio/budget.test.ts`

| Case | Assertion |
|---|---|
| `caps` | per acceptance criterion 14 |
| `steal oldest` | per acceptance criterion 15 |
| `exempt voices` | per acceptance criterion 16 |
| `pool reuse` | a burst of 1,000 events reuses voices rather than constructing them |
| `mute` | per acceptance criterion 24 |
| `reduced motion` | per acceptance criterion 25 |

## Out of scope

- The settings UI. WP-17 owns it and calls `settings.ts`.
- The `bake.worker.ts` plumbing. WP-18 owns the worker protocol; this package
  exposes a pure `generateBuffers(seed)` function that either worker or main
  thread can call, and reports the timing for both paths.
- Any leg-specific music or sound. A leg supplies its root pitch and nothing else.
- `src/kernel/`, `src/world/`, `src/render/`, `src/ui/`, `src/terminal/`,
  `src/game/`, `src/legs/`.
- Voice acting or any recorded material. There is none in this game.

## Report back

State:

1. Pass or fail for each of the twenty-seven acceptance criteria, by number.
2. The three verification command outcomes.
3. The complete list of `KernelEvent` variants you gave deliberate silence, with
   the reason for each, so a human can check the judgement.
4. The measured buffer generation time on the main thread, so the boot cost is
   known if the worker path is unavailable.
5. Whether you added `standardized-audio-context`, and if so the exact named
   incompatibility that justified it.
6. The peak concurrent voice count under a 500-events-per-second burst at each
   tier, and how many voices were stolen.
7. Every `// TODO(astra):` left in the tree, with file and line.

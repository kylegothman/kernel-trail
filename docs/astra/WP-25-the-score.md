# WP-25: The score

## Objective

When this package is done, the game has music. Each leg has a key, a tempo
and a sequenced arrangement built from warm, melodic synth material: filtered
saw chords under sidechain pumping, a bass line, an arpeggio, a lead motif
that belongs to the convoy and returns at every debrief. The arrangement has
sections, and the game moves between them at events, on the beat, with a
transition a listener hears as intentional: entering a leg, opening a
crossing, resolving it, a derezz, a panic, the debrief. Between events the
music does not react to the kernel at all. Every event and interface sound is
re-voiced in the same palette so the whole soundscape is one design. All of it
is synthesized and seeded, ships no audio files, consumes no kernel RNG
draws, and fits the existing voice budgets.

This replaces WP-16's score, which is five layered drones whose gains follow
a load model continuously and which the first playtest described as atonal
repeating synth that the player muted. WP-16's engine, voices, buffers,
buses, budgets, settings and consumer stay; the score on top of them is
rewritten. The direction comes from the playtest and is Kyle's: generated,
inspired by French house and electro production, warm and melodic rather
than cold, reacting only at events, with the fallback that if the generated
score does not earn its place he composes tracks himself. Section 6 makes
that fallback cheap by design.

## Direction

A style reference is a set of production techniques, not a work. This score
draws on how that music is made: side-chain compression that makes chords
breathe against a four-on-the-floor kick, saw-wave chords through a resonant
low-pass filter whose cutoff opens over bars, a vocoder-like formant on the
lead, arpeggios in straight sixteenths, bass that doubles the root an octave
down, extended chords with sevenths and ninths that resolve, a tempo between
110 and 126 beats a minute. Nothing in this package reproduces, quotes,
approximates or is derived from any existing recording, melody, hook, chord
progression, bass line or arrangement, by anyone, and no artist, band, track
or album is named anywhere in the code, the comments, the tests or the
docs. The agent writes original material. A reviewer who recognises a
phrase from anywhere fails the package.

The mood is warm. The grid is dark and the convoy is alone on it; the music
is the thing that is on their side.

## Prerequisites

Main at `9172f6f` or later. WP-24 may be in flight on `wp-24`; this package
touches no file WP-24 touches, and the two merge in either order.

## Required reading

- `docs/astra/WP-16-procedural-audio-engine.md` in full, so the engine's
  reasons are understood before its score is replaced
- `src/audio/AudioEngine.ts`, `graph.ts`, `VoiceBudget.ts`, `buffers.ts`,
  `context.ts`, `settings.ts`
- `src/audio/score/Score.ts`, `layers.ts`, `loadModel.ts` (what goes)
- `src/audio/voices/*.ts` and `src/audio/synth/*.ts` (what stays and is
  extended)
- `src/audio/events/AudioConsumer.ts`, `eventSounds.ts` (`EVENT_TREATMENT`
  and every treatment), `src/audio/ui/uiSounds.ts`
- `src/app/BrowserSession.ts` (where the engine is constructed and where
  `LegEvent`s arrive; the score's event hooks attach there)
- `src/game/LegRunner.ts` (`LegEvent`), `src/game/RunDirector.ts`
  (`openCrossing`, `resolveCrossing`, `openDepot`, `continueTravel`)
- `tests/audio/*.ts`, especially `eventSounds.test.ts`'s determinism case
  (zero kernel RNG draws) and `budget.test.ts`
- `tests/render/gpu/audio.gpu.ts` and `audio.html`, the offline render probe
- `docs/04-NARRATIVE-BIBLE.md` sections 1 and 2 (the world and the convoy)
  and each shipped leg's tone as its `copy.ts` states it

## Files you will create

```
src/audio/score/Arrangement.ts        (section 1: sections, bars, the event map)
src/audio/score/Sequencer.ts          (section 2: the beat clock and pattern player)
src/audio/score/material.ts           (section 3: keys, progressions, motifs, per leg, seeded)
src/audio/score/Conductor.ts          (section 4: events to section changes, on the beat)
src/audio/score/source.ts             (section 6: the ScoreSource interface and the generated source)
src/audio/voices/ChordVoice.ts        (section 3: the pumped saw chord)
src/audio/voices/KickVoice.ts         (section 3: the kick and the side-chain trigger)
src/audio/voices/LeadVoice.ts         (section 3: the formant lead)
src/audio/synth/sidechain.ts          (section 3: the ducking envelope)
tools/audio/audition.mjs              (section 7: renders a leg's arrangement to a WAV offline)
tests/audio/arrangement.test.ts
tests/audio/sequencer.test.ts
tests/audio/material.test.ts
tests/audio/conductor.test.ts
tests/audio/palette.test.ts           (section 5: every treatment plays the new palette)
docs/evidence/wp25-audition.md        (section 7: what Kyle heard, per leg, and the WAV hashes)
```

## Files you may modify, each by exact grant quoted in the pre-flight

```
src/audio/score/Score.ts         (becomes a thin facade over Conductor; the engine's callers keep working)
src/audio/score/layers.ts        (removed, with its test; quote every importer)
src/audio/score/loadModel.ts     (removed; the engine's `load` field goes with it; quote every importer)
src/audio/AudioEngine.ts         (constructs the Conductor; exposes onLegEvent and onDirectorEvent hooks; nothing else)
src/audio/VoiceBudget.ts         (POOL_SPLIT gains chord, kick and lead kinds within the same totals)
src/audio/voices/Voice.ts        (VOICE_KINDS gains the three)
src/audio/events/eventSounds.ts  (every treatment re-voiced, section 5; the table's keys unchanged)
src/audio/ui/uiSounds.ts         (re-voiced, section 5; ids unchanged)
src/audio/index.ts               (exports)
src/app/BrowserSession.ts        (forwards LegEvents and the three director verbs to the engine's hooks; five lines)
tests/audio/score.test.ts        (rewritten for the facade)
tests/audio/eventSounds.test.ts  (protected; the determinism case stays byte for byte, the treatment cases follow the palette; quote-and-wait)
tests/render/gpu/audio.gpu.ts    (renders one arrangement section offline and asserts it is not silent; section 7)
```

Nothing else. No file under `src/game`, `src/kernel`, `src/render`,
`src/world`, `src/ui`, `src/terminal` or `src/legs` changes. If a leg's tone
needs something the leg does not expose, the material table in section 3
carries it; legs are not edited to carry music.

## Specification

### 1. The arrangement

An `Arrangement` is a leg's music as data: a key (root MIDI and mode), a
tempo, a time signature of four, and named sections, each a whole number of
bars with a pattern per part. Parts are `kick`, `bass`, `chords`, `arp`,
`lead`, `pad`. The sections every leg has:

- `entry`: eight bars, the pad and a single chord, no kick. The leg rail has
  just changed and the world is building.
- `travel`: the loop the leg lives in. Sixteen or thirty-two bars, kick,
  bass, chords, arp; the lead is silent. Loops until an event.
- `crossing`: eight bars, the kick drops out, the chords hold and the filter
  closes; tension by subtraction, not by adding noise. Loops while the
  crossing panel is open.
- `resolve_good` and `resolve_bad`: four bars each, the kick returns on the
  downbeat, the chord resolves up or down. Plays once, then `travel`.
- `loss`: four bars after a derezz, the kick out, the pad alone, the lead
  plays the convoy motif once, slow. Then `travel`.
- `panic`: the kick stops mid-bar on the event, everything but the pad cuts,
  the pad detunes and decays over four bars to silence. Terminal.
- `debrief`: the lead plays the convoy motif over the chords at the leg's
  tempo, resolving to the tonic on the last bar; loops while the card is
  open, fades on Continue.

Sections change only on a bar line, except `panic`, which is the one event
allowed to cut a bar. The `Conductor` (section 4) decides which section is
next; the `Arrangement` only knows the sections and their patterns.

### 2. The sequencer

`Sequencer` owns the beat clock and plays patterns. Its clock is the audio
context's `currentTime`, scheduled ahead by a lookahead of 120 ms in a
25 ms interval, the standard scheduling pattern for Web Audio; it is not the
game tick, and the tempo is not tied to the tick rate, since the player's
rate is 1, 2 or 4 ticks a second and none of those is a tempo. The
sequencer plays a section's patterns bar by bar, calls a `onBar` hook the
Conductor uses to switch sections, and quantises every requested change to
the next bar line. Swing is a parameter, default a light 54 percent on the
sixteenths. When the loop pauses (a hold from `pacing.ts`, WP-24), the
sequencer keeps playing: music continues over a crossing panel by design,
because the crossing section is the music for that moment.

Every note goes through the existing `VoiceAllocator`, so the tier budgets
hold and voice stealing behaves as WP-16 built it. `POOL_SPLIT` is
rebalanced within the same totals so a `travel` section at low tier has a
kick, a bass, two chord voices, one arp and one pad, and at high tier has
four chord voices and a lead. Quote the new split in the pre-flight and
show it sums to `VOICE_BUDGET` at every tier.

### 3. The material

`material.ts` is where the music is. Per leg, seeded from the engine's own
seed and the leg id through `createRng`, never from a kernel stream:

- A key. Each leg gets a root from a circle-of-fifths walk from the previous
  leg's root, so consecutive legs are related, and a mode from a small set
  the package fixes: natural minor, dorian, and major for the debrief
  resolution. The Boot Sector is major.
- A progression of four or eight chords in that key, chosen from a table of
  progressions the agent writes, each with sevenths or ninths on at least
  two chords, ending on a chord that wants to resolve so `travel` loops
  without sounding finished and `debrief` can resolve it.
- A bass line that follows the roots an octave down with one passing note
  per bar, straight eighths, side-chained to the kick.
- An arpeggio of the chord tones in sixteenths, up or up-down per leg, on a
  filtered saw whose cutoff opens over the sixteen bars and closes again.
- The convoy motif: one melodic phrase, four bars, written once for the
  whole game in `material.ts` by the agent, transposed into each leg's key.
  It is the theme; it plays at every loss and every debrief and nowhere
  else, so a player learns it means the convoy.
- The pad: two detuned saws through a slow filter, the chords sustained.
- The kick: a synthesized sine drop with a click, on every beat in `travel`,
  side-chaining the pad, chords and bass through `sidechain.ts`, which is a
  gain envelope triggered per kick with attack 5 ms, release 180 ms, depth
  per tier.

Tempo per leg between 110 and 126, from the leg's index and the seed,
fixed for the leg. The Boot Sector is the slowest and the Portal the
fastest. The material for the four shipped legs is authored by hand in the
table, not only generated, so a listener can tell them apart; the generator
covers the ten unbuilt legs until their packages author theirs.

`ChordVoice`, `KickVoice` and `LeadVoice` are new `Voice` kinds built on the
existing `envelope.ts`, `filters.ts` and `noise.ts`. The lead's formant is
two band-pass filters at vowel frequencies swept by the phrase; it is not
a vocoder and does not claim to be.

### 4. The conductor

`Conductor` maps events to sections and asks the sequencer to change on the
next bar. Its inputs are the `LegEvent` union and three director verbs,
forwarded by `BrowserSession` through two new engine hooks:

| Input | Section |
|---|---|
| leg entered (kernel changed, non-null) | `entry`, then `travel` after eight bars |
| `openCrossing` | `crossing` |
| `resolveCrossing` succeeded | `resolve_good`, then `travel` |
| `resolveCrossing` failed or a casualty | `resolve_bad`, then `travel` |
| `tombstone` | `loss`, then `travel` |
| `depot_open` | `travel` continues; the depot has no section |
| `panic` | `panic`, terminal |
| `debrief` | `debrief` |
| Continue on the debrief, leg exit | fade over one bar, then the next leg's `entry` |

Nothing else changes the music. The load model is deleted; no kernel metric
reaches the score. `process.starving`, `memory.thrashing` and the rest stay
event sounds (section 5) and do not change the section. That is the ruling
Kyle gave: the music reacts at events and only at events.

### 5. The palette

Every entry in `EVENT_TREATMENT` that is `sound`, and every `UiSoundId`, is
re-voiced so it belongs to the same instrument as the score: pitched
material is in the current leg's key (the engine already has `setRoot`),
percussive material shares the kick's transient design, and nothing is
white noise unshaped. The table's keys and the treatment kinds do not
change; what each treatment plays does. `keyTick` in the terminal is the
one sound that stays as it is, because a terminal should sound like a
terminal. `palette.test.ts` renders every treatment offline and asserts it
is non-silent, under 400 ms except the derezz, and in key where it is
pitched.

### 6. The fallback is designed in

`source.ts` defines:

```ts
export interface ScoreSource {
  arrangement(legId: LegId, seed: number): Arrangement;
}
```

The generated source is the only implementation this package ships. The
contract exists so that authored music can replace it without touching the
Conductor, the Sequencer or the session: a `FileScoreSource` would return
an `Arrangement` whose sections are decoded buffers rather than patterns,
and the Sequencer would play buffers on bar lines instead of notes. The
package does not build that source and does not add a file loader, but it
writes the Sequencer so a section can carry either patterns or a buffer,
with the buffer path returning `not implemented` and a test that says so.
If Kyle composes the score himself, that is the seam it drops into, and the
event map in section 4 is the brief he composes against.

### 7. Audition before acceptance

`tools/audio/audition.mjs` renders any leg's arrangement, or one section of
it, to a WAV through `OfflineAudioContext` at 48000 Hz, deterministically
from the seed, and prints the file's hash. It is how Kyle listens without
playing the game and how the reviewer checks that two renders of the same
seed are byte-identical. The evidence file records, for each of the four
shipped legs, the tempo, key, and one sentence from Kyle on each of
`travel`, `crossing`, `loss` and `debrief`. His sentence is the acceptance
test for section 3; there is no automated test for whether music is good,
and the package does not pretend there is.

`audio.gpu.ts` gains one case: render eight bars of the Quantum Pass's
`travel` offline and assert peak amplitude above a floor and below clipping,
which catches a silent or a blown mix on the runner.

## Acceptance criteria

1. Every shipped leg has an arrangement with all eight sections; the
   sequencer plays each, and sections change only on bar lines except
   `panic`.
2. The Conductor's table in section 4 is the complete set of things that
   change the music; the load model is gone and no kernel metric reaches
   the score, asserted by a test that feeds the engine every kernel event
   type and observes no section change.
3. The audio consumes zero draws from any kernel RNG stream; the protected
   determinism case in `eventSounds.test.ts` passes unchanged.
4. Two renders of the same leg and seed through `audition.mjs` are
   byte-identical; two seeds differ.
5. The convoy motif is one phrase, defined once, and plays only in `loss`
   and `debrief`.
6. `POOL_SPLIT` sums to `VOICE_BUDGET` at every tier and a `travel` section
   never exceeds it, asserted through the existing budget test.
7. Every `sound` treatment and every UI sound is re-voiced and non-silent;
   `keyTick` is unchanged.
8. No artist, band, track or album is named anywhere in the diff, and the
   agent's report states that every phrase, progression and motif is
   original.
9. Kyle has listened to the four shipped legs' `travel` and `debrief` from
   `audition.mjs` and his sentences are in the evidence file. If any leg's
   sentence is a no, the package is not done.
10. No frozen file changes; no file outside the two lists changes; the
    goldens, the balance ledger and the playthrough are untouched.
11. All four gates pass on every commit; no skipped test; no em dash or en
    dash used as an em dash anywhere in the diff.

## Report back

The evidence file with Kyle's sentences; the `POOL_SPLIT` table; the
section 4 table as implemented; the material table for the four shipped
legs with each leg's key, tempo and progression written as chord symbols;
the motif as scale degrees; the WAV hashes for two renders of each leg;
and every gap between this document and the tree, numbered. Push `wp-25`
and stop; do not merge.

## Pre-flight before writing

Read this document and the required reading, then send a pre-flight,
numbered: the `Arrangement` and `Section` types as you will write them;
the sequencer's scheduling loop and how it quantises a change to the bar;
the new `POOL_SPLIT` with its sums; the material for the Boot Sector and
the Quantum Pass as chord symbols, tempo and the motif in scale degrees,
before any code, so the direction can be corrected on paper; the
side-chain envelope's parameters per tier; how the Conductor receives
`resolveCrossing`'s result; the list of every importer of `layers.ts` and
`loadModel.ts`; the two engine hooks' signatures; and every seam you cannot
reach without editing a file outside the grant, each with the smallest
diff. Wait for the reply before the first commit. Every commit passes all
four gates on its own and ends with both attribution lines.

# WP-25 audition: what was heard, and the renders that carry it

WP-25 replaced WP-16's five load-driven drones with a sequenced score per
leg: a key, a tempo, eight sections the Conductor moves between at events
and only on bar lines, and a palette of event and interface sounds in the
same instrument. Section 7 of the package makes Kyle's ear the acceptance
test for the material, and this file is the record of it, together with the
renders a reviewer can reproduce.

## How to listen

`tools/audio/audition.mjs` renders any leg, or one section of it, to a
48 kHz 16-bit stereo WAV through `OfflineAudioContext`, at the game's
default volumes, through the production engine: the pool from `POOL_SPLIT`,
the side-chain, the Conductor's table and the two hooks the session
forwards. Without `--section` it renders a tour, the events of a leg in an
order the game could reach them:

```
bar 0     leg entered            entry for eight bars, then travel
bar 24    crossing_open          crossing: eight bars of pad and chords, then the loop with the quiet arp
bar 40    resolved, clean        resolve_good, then travel
bar 52    tombstone              the duck at the event, loss on the bar, then travel
bar 64    crossing_open          crossing
bar 72    resolved, failed       resolve_bad, then travel
bar 84    debrief                debrief, looping
bar 94.5  panic                  the cut, mid-bar; four bars of the pad detuning to silence
```

```bash
node tools/audio/audition.mjs --leg boot_sector
node tools/audio/audition.mjs --leg quantum_pass --section travel --bars 16
node tools/audio/audition.mjs --leg the_narrows --tier low --seed 7
```

Every render is at high tier and the fixture seed `0x4b54524c` unless the
flags say otherwise. The tool prints the WAV's SHA-256 and a SHA-256 of the
schedule it played: every note the sequencer placed (section, part, step,
pitch, velocity, cutoff, onset, length) and every event the tour sent.

## The verdict

Kyle listened to the Boot Sector's `travel` alone and its full tour, the
Quantum Pass's `travel` alone and its full tour, and the tours of the
Narrows and the Allocation Yards, rendered at `ad51789` by the tool as it
then was. The package asked for one sentence per leg on each of `travel`,
`crossing`, `loss` and `debrief`. The ruling that came back was a general
pass on all four legs, recorded as such and not as a per-section sign-off:
"Verdict: proceed to the conductor. Recorded as a general pass on all four
legs, not a per-section sign-off." The material had been approved on paper
before it was built, as chord symbols, tempos and the motif in scale
degrees, and the chord symbols are what were read first.

## The four shipped legs

Every phrase, progression and motif here is original. Nothing is quoted,
approximated or derived from any recording, and no artist, band, track or
album is named anywhere in the package.

| leg | key | tempo | travel, two bars a chord unless noted | debrief, one chord a bar |
|---|---|---|---|---|
| Boot Sector | F major, root F2 | 110 | Fmaj9, Am7, Dm9, Bbmaj7, Gm9, Ebmaj7, Dm7, C11 | Fmaj9, Am7, Dm9, Bbmaj7, Gm9, Ebmaj7, C11, Fmaj9 |
| Quantum Pass | D dorian, root D2 | 116 | Dm9, Fmaj9, G13, Em7, Dm9, Bm7b5, Am7, G13, one bar each, twice | Dm9, Fmaj9, G13, Em7, Dm9, Bm7b5, A7sus4, D6/9 |
| The Narrows | A minor, root A1 | 118 | Am9, Fmaj7#11, Am9, Dm9, Fmaj7#11, G13, Bm7b5, E7sus4 | Am9, Fmaj7#11, Dm9, G13, Am9, Bm7b5, E7sus4, A6/9 |
| Allocation Yards | F# minor, root F#2 | 120 | F#m9, Amaj9, Bm9, Gmaj7#11, F#m9, Dmaj9, G#m7b5, C#7sus4 | F#m9, Amaj9, Bm9, Gmaj7#11, Dmaj9, G#m7b5, C#7sus4, F#6/9 |

The crossing alternates the progression's last two chords two bars each,
`resolve_good` is that last chord into the tonic (C11 to Fmaj9, G13 to
Dm6/9, E7sus4 to Am9, C#7sus4 to F#m9), `resolve_bad` is the same chord
into the deceptive resolution (Dm9, Bm7b5, Fmaj7#11, Dmaj9), `loss` is the
minor tonic on the pad (Dm9 in the Boot Sector's major), and every debrief
ends on the tonic major. The key walk is up a fifth per leg from F: F, C,
G, D, A, E, B, F#, C#, G#, D#, A#, F, C, so the Portal lands a fifth above
where the journey began.

The convoy motif, four bars, in scale degrees over the lead's low tonic
with an apostrophe for the octave and beats in brackets, written once in
`material.ts` and transposed into every key; it plays at every loss and
every debrief and nowhere else:

```
bar 1:  5 (1.5)  6 (0.5)  1' (2)
bar 2:  2' (1)   1' (1)   6 (2)
bar 3:  5 (1.5)  4 (0.5)  5 (1)   2 (1)
bar 4:  3 (3)    rest (1)
```

The debrief's second four bars are the motif's cadence form: the same
first two bars, then `1' (1) 6 (1) 5 (2)` and the tonic held for a bar.

## The renders

Two tours per leg at the tip of `wp-25`, one seed, on an Apple M3 under
Chromium 153 through Playwright 1.63. The schedule hash is identical within
every pair. The WAV hashes are not, and the sample-level difference is
recorded below.

| leg | render | seconds | notes | unplaced | peak | WAV SHA-256 |
|---|---|---|---|---|---|---|
| Boot Sector | 1 | 216.41 | 1727 | 0 | 0.831 | `f831671dc6fe10c4d7b7cd07022837fa6624edc89b2077ee548b7b6f655cfd71` |
| Boot Sector | 2 | 216.41 | 1727 | 0 | 0.831 | `ae0d7a20b8a5f24cb5c19c6c32aa258f19ec52d4a93d71e6b686206c5b2993da` |
| Quantum Pass | 1 | 205.29 | 1847 | 0 | 0.836 | `102bb1947288ad87a5f5e8d70ca905ae17cee466055def7ab27ee672747631b4` |
| Quantum Pass | 2 | 205.29 | 1847 | 0 | 0.836 | `3cb18e492e2dcc5322971edab0803d9db46328b1dabe6ae1875371deb6389f97` |
| The Narrows | 1 | 201.84 | 1727 | 0 | 0.816 | `df7c4ae612a83c47a8bfb1f85e0a78a4ba33e148719e3b100bb1e7b810d71fc3` |
| The Narrows | 2 | 201.84 | 1727 | 0 | 0.816 | `c537e0615f5b51aea929163a13c7deec635e5a252c0c8ea41f2556abc7fb513e` |
| Allocation Yards | 1 | 198.50 | 1727 | 0 | 0.813 | `f5957dc473516363471901a283bb4edc0a3f1cc52b2682d11d81cf8da5cec889` |
| Allocation Yards | 2 | 198.50 | 1727 | 0 | 0.813 | `13e40517f0d0de4e966b14d68d061d8cc3fcddd7dda58ae84fd9ba79b06cafa8` |

| leg | schedule SHA-256 | events |
|---|---|---|
| Boot Sector | `8b9487a952e76a2971f00530b2675b14382eb1c1cd5de723bb3ceccb0098b98a` | 1735 |
| Quantum Pass | `d2f98c3f1438525fb06591bf937d3ce98ceeaeef203a5e901ffe26a79f49b3a7` | 1855 |
| The Narrows | `0aa035a7df2a4fc38f60e702a9f448c6c083afaeb97e23dfaf43214d916ccbea` | 1735 |
| Allocation Yards | `02358f16f9507460ff28333cf1432639461e0fc4d699825f6c266f7546e34f98` | 1735 |

Where the sections began, in seconds, identical within each pair:

| leg | entry | travel | crossing | resolve_good | travel | loss | travel | crossing | resolve_bad | travel | debrief | panic |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Boot Sector | 0.00 | 17.45 | 52.36 | 87.27 | 96.00 | 113.45 | 122.18 | 139.64 | 157.09 | 165.82 | 183.27 | 206.18 |
| Quantum Pass | 0.00 | 16.55 | 49.66 | 82.76 | 91.03 | 107.59 | 115.86 | 132.41 | 148.97 | 157.24 | 173.79 | 195.52 |
| The Narrows | 0.00 | 16.27 | 48.81 | 81.36 | 89.49 | 105.76 | 113.90 | 130.17 | 146.44 | 154.58 | 170.85 | 192.20 |
| Allocation Yards | 0.00 | 16.00 | 48.00 | 80.00 | 88.00 | 104.00 | 112.00 | 128.00 | 144.00 | 152.00 | 168.00 | 189.00 |

## Byte identity, measured

Acceptance criterion 4 asked for two renders of one seed to be
byte-identical. They are not, and the reason is the platform: Chromium sums
an audio node's inputs in an order that varies from process to process,
and a bus that sums dozens of voices is order-sensitive in its last bit.
The schedule hash, accepted as the determinism check in the pre-flight
rulings, is identical in every pair. The sample-level difference of the
16-bit renders:

| leg | samples compared | differing | share | largest step |
|---|---|---|---|---|
| Boot Sector | 20,775,274 | 21,534 | 0.1037 percent | 1 |
| Quantum Pass | 19,708,138 | 17,984 | 0.0913 percent | 1 |
| The Narrows | 19,376,544 | 14,678 | 0.0758 percent | 1 |
| Allocation Yards | 19,056,000 | 28,040 | 0.1471 percent | 28 |

In the Allocation Yards pair every difference larger than one step, 6,357
samples of them, lies between 86.764 and 86.885 seconds, inside
`resolve_good` at its loudest bar, with the largest at sample values near
minus 22,000: the master limiter's release window after a transient on
which the last-bit difference tipped its detector, a level difference of
about 0.13 percent for 120 ms. Two seeds differ in more than 99 percent of
samples. The summing graph was not restructured for byte identity, as
ruled.

## The browser probe

`tests/render/gpu/audio.gpu.ts` renders eight bars of the Quantum Pass's
`travel` offline through the engine before the gesture and reports the
peak in `info()`; `run.mjs` asserts it above 0.05 and below clipping. On
the working tree of the session wiring, `npm run test:browser` reported:

```
travelPeak 0.8502  travelSeconds 17.05  travelNotes 272  travelUnplaced 0  travelRenderMs 794
Audio probe passed
```

## What the renders found

The first Narrows tour placed four notes fewer than the others. A looping
section yields to a queued section at the next bar line, and when that
line fell inside a two-bar chord the old chord's voices stayed busy into
the new section's first bar. The sequencer now fades every voice that
would cross the line over 25 ms, ending 5 ms before it, and frees it;
`16216ad` carries the fix and its test, and the renders above are on it.

Two earlier findings, fixed in `ad51789`: a release that ended exactly on
the next onset left its voice busy by a floating-point hair and would have
clicked on a real browser, so releases end a millisecond early; and the
loss articulation's envelope was longer than the motif's half-beat notes,
so the lead's envelope is fitted to each note.

## The pool and the table

`POOL_SPLIT`, each row summing to `VOICE_BUDGET`:

| tier | tone | noise | impact | drone | granular | chord | kick | lead | sum |
|---|---|---|---|---|---|---|---|---|---|
| low | 5 | 2 | 2 | 1 | 1 | 3 | 1 | 1 | 16 |
| medium | 8 | 5 | 5 | 2 | 5 | 5 | 1 | 1 | 32 |
| high | 22 | 10 | 8 | 3 | 12 | 6 | 1 | 2 | 64 |

The Conductor's table as implemented, the complete set of things that
change the music:

| input | section |
|---|---|
| leg entered | entry, then travel after eight bars |
| crossing_open | crossing |
| crossing resolved, succeeded with no casualty | resolve_good, then travel |
| crossing resolved, failed or with a casualty | resolve_bad, then travel |
| tombstone | the duck at the event, loss on the bar, then travel |
| depot_open, reclamation_open, leg_unavailable | no change |
| panic | panic, cut mid-bar, terminal |
| debrief | debrief, looping while the card is open |
| leg exit | fade over one bar, then the next leg's entry |

Nothing else changes the music. No kernel metric reaches the score.

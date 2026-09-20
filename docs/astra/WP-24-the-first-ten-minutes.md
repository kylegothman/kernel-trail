# WP-24: The first ten minutes

## Objective

When this package is done, a player who has never seen the game opens it,
watches the floor write itself under the convoy, lights the five stele,
reaches for a stack of blocks and is refused with `EPERM`, opens the
terminal for the first time and reads `man EPERM`, buys what the convoy
needs through the six requisition windows and learns why every trap costs
the same, then names the resource their disc class is short of and leaves
the Boot Sector knowing what a system call is. Every other leg then runs at
a clock a person can read, and stops when the game asks them a question.

None of that is new design. The eight beats are data in
`src/legs/boot_sector/onboarding.ts`, the windows and their errno rules are
in `windows.ts`, the copy is in `copy.ts`, and every handler exists and is
tested. The file header on the beats says "the boot package drives them",
and WP-22 did not, because I scoped WP-22 as the plainest DOM over the
generic model and never asked what the one leg built as a tutorial needed
from it. The playtest that found this also found that the clock runs fifty
times too fast for a human, which is a contradiction between two design
documents: narrative 5.3 gives legs 60 to 100 ticks, architecture 2.1 fixes
the clock at 20 ticks a second, and together they make a leg last three to
five seconds. This package resolves both.

The simulation does not change. A tick is a tick; wall time per tick is the
loop's business, and the goldens, fixtures and balance ledger are untouched.

## Prerequisites

Main at `b6dae96` or later. WP-23 merged, so the playthrough and the balance
test exist and must stay green.

## Required reading

- `src/legs/boot_sector/onboarding.ts` in full; it is the specification of
  section 2 and this document does not restate it
- `src/legs/boot_sector/windows.ts` (`WINDOWS`, `WindowDef`, `WindowMode`,
  `TRAP_COST`, `parseInteractionChoice`, `reduceRequisition`,
  `SHORT_RESOURCE`, `SubmissionErrno`), `interactions.ts` (the seven verbs,
  how each reads its argument from the record's anchor string, and the gate
  writing `leg_done`), `copy.ts`, `stage.ts` (`ANCHORS`, the layout)
- `tests/legs/boot_sector/scripts.ts`, which shows the exact anchor strings
  each verb expects: `anchor.win.quota:kernel`, `anchor.win.quota:40`,
  `anchor.win.quota`, and the gate's `anchor.disc_plinth:<resource>`
- `docs/04-NARRATIVE-BIBLE.md` section 5.3 (leg lengths in segments and
  ticks) and section 10 (the depot line)
- `docs/01-ARCHITECTURE.md` section 2.1 (why 20 Hz) and 2.3 (the loop,
  `timeScale`)
- `src/app/loop.ts` (`setTimeScale`, `currentTimeScale`), `src/app/input.ts`,
  `src/app/BrowserSession.ts` (`onLegEvent`, `advance`, the panels),
  `src/app/panels/InteractionPanel.ts`, `src/app/panels/panel.ts`
- `src/game/RunDirector.ts` (`ZERO_SEGMENT_TICK_ALLOWANCE`, `complete`,
  `interaction`, and how a refused verb becomes `costly`)
- `src/game/codexTypes.ts` (`CodexProfileState`) and
  `src/game/persist/SaveService.ts` (`readCodexProfile`, `writeCodexProfile`)
- `src/render/camera/FocusCamera.ts` (`engage`, `release`, `state`)
- `src/terminal/Terminal.ts` (`open`, `submit`, `shell.onCommand`)
- `src/ui/hud/Hud.ts` and `hud/regions/AlertStack.ts`
- `tests/e2e/playthrough.mjs` and `tests/app/BrowserSession.test.ts`

## Files you will create

```
src/app/pacing.ts                       (section 1: the player clock and the pause rule)
src/app/onboarding/BootSectorDriver.ts  (section 2: the eight beats)
src/app/onboarding/hints.ts             (section 2: the timed hint lines)
src/app/panels/RequisitionPanel.ts      (section 3: the six windows)
src/app/panels/GatePanel.ts             (section 3: the disc class gate)
src/app/panels/RefusalLine.ts           (section 4: what a declined verb says)
tests/app/pacing.test.ts
tests/app/bootSectorDriver.test.ts
tests/app/requisitionPanel.test.ts
tests/app/refusal.test.ts
docs/evidence/wp24-playtest.md          (section 7: the before-and-after)
```

## Files you may modify, each by exact grant quoted in the pre-flight

```
src/app/BrowserSession.ts        (mount the driver and panels; pacing hooks; the profile flag)
src/app/input.ts                 (pace keys show their rate; Space is pause; nothing else)
src/app/frame.ts                 (nothing unless the pre-flight shows a reason)
src/app/screens/TitleScreen.ts   (two sentences each under disc class and difficulty, section 5)
src/app/panels/InteractionPanel.ts  (parameterised verbs and refusal lines, section 3 and 4)
src/app/panels/panel.ts          (a shared pause-while-open hook, section 1)
src/ui/hud/Hud.ts                (one region: the pace indicator, section 1; quote it)
src/game/RunDirector.ts          (the zero-segment allowance becomes an option, section 2)
src/game/LegRunner.ts            (passes the option through; section 2)
src/game/codexTypes.ts           (one optional field on the profile, section 2)
tests/legs/harness/LegHarness.ts (passes the allowance the harness always used)
tests/game/legRunner.test.ts     (protected; the allowance cases take the option; quote-and-wait, pre-ruled)
tests/e2e/playthrough.mjs        (drives the tutorial once, then skips it; section 6)
```

Nothing else. No file under `src/legs`, `src/kernel`, `src/render`,
`src/world`, `src/terminal` or `src/audio` changes. The Boot Sector's data
and handlers are complete; if a beat needs something the leg does not
expose, report the smallest diff and wait.

## Specification

### 1. The player's clock

`src/app/pacing.ts` owns wall time. It exports:

```ts
export const PLAYER_TICK_HZ = 2;                       // the default a person gets
export const PLAYER_TIME_SCALES = [0.5, 1, 2] as const; // slow, normal, fast, in ticks per second: 1, 2, 4
export interface Pacing {
  readonly rate: () => number;                          // ticks per second now, 0 when paused
  setRate(ticksPerSecond: number): void;
  hold(reason: string): () => void;                     // pause until the returned release is called
  readonly held: () => readonly string[];
}
export function createPacing(loop: GameLoop): Pacing;
```

The loop keeps its `timeScale` semantics; `createPacing` maps ticks per
second onto it (`scale = ticksPerSecond / TICK_HZ`) and owns the relation
between holds and the rate. A hold pauses the loop and remembers the rate;
the last release restores it. Holds stack and are named, so a debrief and a
crossing open at once release in either order without unpausing early.

Who holds. Every panel that asks the player a question holds while open:
`CrossingPanel`, `DepotPanel`, `ReclamationPanel`, `RequisitionPanel`,
`GatePanel`, and every card. `panel.ts` gains the hook so a panel does it
by construction rather than by remembering to. The interactions panel does
not hold; it is always open. The terminal does not hold; typing while the
kernel runs is the design. The codex holds, because reading is a decision
the player is making about their attention.

Keys. Space toggles pause, and pause is a hold named `player`. Bracket keys
step through `PLAYER_TIME_SCALES`. The HUD gains one region, the pace
indicator, that shows the rate as `1x`, `2x`, `4x` or `paused (crossing)`
using the top hold's name, so a player who sees the clock stopped knows
why. Quote the region's placement against `hud/layout.ts` in the
pre-flight; it goes where the visual bible's 11.3 grid has room and nowhere
else.

The harness and the replay worker never touch this file; they drive ticks
directly and are unaffected.

### 2. The Boot Sector driver

`BootSectorDriver` runs the eight beats of `ONBOARDING` in order, as data,
on top of the session. It is mounted by `createBrowserSession` when the
leg entered is `boot_sector` and the profile has not recorded a completed
Boot Sector; otherwise the leg runs as any other leg with a `Skip tutorial`
affordance offered once at entry. It is disposed at leg exit.

For each beat the driver does exactly what the beat's `world` says, waits
for exactly what the beat's `exit` says, and after `hintAfterMs` without
the expected action shows the beat's hint through the HUD alert stack as
one line in the leg's voice. The beats are not modal: the clock runs at the
player's rate, the hint is a line and not a dialog, and nothing traps
focus. Beat one is the only beat with a duration; it holds the clock for
its 3000 ms because the world is still black. Every other beat ends on its
exit condition.

Beat by beat, against the shipped surfaces:

1. `beat.void`: the layout stage renders only the convoy stele unlit and the
   module ring; the grid floor and every other anchor are hidden. The HUD
   is hidden. Hold the clock.
2. `beat.floor`: reveal the grid floor ring by ring at `MODULE_METRES` per
   step to the horizon; the stand-in cannot animate the write itself, so
   the reveal is a per-ring visibility sweep and the structures package
   replaces it later. Enable camera orbit. The HUD's leg rail appears. Exit
   when the sweep reaches the last ring.
3. `beat.convoy`: light the five stele in roster order at `STELE_LIGHT_MS`
   each; the HUD convoy panel gains one row per stele as it lights. The
   player must click a stele; the click engages the focus rig on that
   anchor. Exit when the rig reports engaged. No hint.
4. `beat.reach`: on focus release, reveal `anchor.block_stack` closer and
   warmer than the depot. "Reach for them" is the `boot.direct_reach` verb
   surfaced as a single button at the stack's row of the interactions
   panel, the only verb visible in this beat. Its handler records the reach
   and the panel shows `DIRECT_REACH_LINE`, which is `EPERM. man EPERM.`, as
   a refusal line (section 4). Exit on the record. Hint after 20 s: the
   beat's own hint text.
5. `beat.terminal`: the terminal affordance lights: the HUD's focus hint
   shows the backquote key and the terminal opens on it with the one
   character prompt. Exit when `shell.onCommand` reports `man EPERM`. The
   Boot Sector's `manInvocations` in `reduceRequisition` already counts it.
6. `beat.trap`: open the `RequisitionPanel` (section 3) with the six
   windows. Exit on the first successful submission, which the leg records
   as `boot.trap_purchase` with a `good` outcome.
7. `beat.batching`: the depot signage shows `TRAP_SIGNAGE` once, in the
   panel's heading. Exit when the player closes the requisition, which is
   the panel's own Close.
8. `beat.gate`: open the `GatePanel` on `anchor.disc_plinth`. Exit when
   the gate verb records, which writes `leg_done` and ends the leg. The
   debrief follows as it does today.

Completion and the profile. When the Boot Sector's debrief opens with a
`leg_done` record present, the session writes `bootSectorCompleted: true`
into the codex profile through `writeCodexProfile`. `CodexProfileState`
gains that one optional boolean; it is the flag the data file names and
the only profile change. On a later run the driver offers `Skip tutorial`
at entry and, if taken, the leg runs as any other leg with the requisition
and gate panels available from its interactions rows.

The allowance. `ZERO_SEGMENT_TICK_ALLOWANCE` stops being a constant the
director applies and becomes `LegRunOptions.zeroSegmentAllowance: number |
null`. The harness passes 200, which is what it always used, so every
golden and every runner test holds. The browser passes `null`: a
zero-segment leg in front of a person ends on its `leg_done` record and on
nothing else. The two `legRunner.test.ts` cases that assert the allowance
pass it explicitly; that is the protected change, pre-ruled, quoted in the
pre-flight.

### 3. The requisition and the gate

The verbs take arguments in the anchor string, and the panel must supply
them. `RequisitionPanel` renders the six `WINDOWS` as rows: the window's
service, its unit price at the run's tier from `unitPrice`, a kernel or
user toggle, a quantity field bounded by the window's definition, and an
Add button. A submission list below shows what is pending, and a Submit
button raises the trap for `TRAP_COST` cycles, shown beside it. The panel
dispatches through the bus exactly what the harness script dispatches:
`boot.set_mode` with `anchor.win.<id>:<mode>`, `boot.batch_request` with
`anchor.win.<id>:<amount>`, `boot.trap_purchase` with `anchor.win.<id>`.
Nothing is invented; `scripts.ts` is the reference for every string. After
each tick the panel re-reads `reduceRequisition(run.decisions, discClass,
difficulty)` and re-renders from it, so what the player sees is the leg's
own view of the requisition and not the panel's memory. `DEPOT_AMBIENT` is
the panel's subtitle. A submission that comes back `EPERM`, `EINVAL` or
`ENOMEM` shows that errno as a refusal line (section 4) with the man page
name beside it.

`GatePanel` shows `GATE_QUESTION`, the four resource kinds as buttons, and
dispatches `boot.choose_disc` with `anchor.disc_plinth:<resource>`. The
handler decides `good` or `costly`; the panel shows which, with one
sentence from the leg's copy for each, and the leg ends.

The generic `InteractionPanel` learns one thing from this: a verb whose
`LegContent` declares argument options renders them. Add to the companion
an optional `arguments?: Readonly<Record<string, readonly { anchor:
string; label: string }[]>>` keyed by interaction id, in
`src/legs/content.ts`, and have the panel render a select when it is
present and dispatch the chosen anchor. The Boot Sector does not use it
(the two panels above are its UI) but every later leg with a parameterised
verb does, and the two conventions the legs invented collapse into one:
L07's split ids need nothing, L00's anchor arguments are declared. Quote
the `content.ts` diff in the pre-flight; it is the only file outside the
boot package that changes, and it is the companion, not the frozen `Leg`.

### 4. What a declined verb says

Today a refused interaction is recorded `costly` and shown as nothing.
`RefusalLine` is one line under the verb's row, in the leg's voice, for two
seconds, then gone: the director's reason when it refuses before the
handler (`This interaction is unavailable.`, `Insufficient resources for
this interaction.`) or the leg's own line when the handler declines. The
Boot Sector's `EPERM. man EPERM.` is the first of these and the reason
the mechanism exists. The panel gets the reason from the outcome of the
bus's apply, which `sinkOverBus` already surfaces for the terminal;
quote how the panel will obtain it for a queued command, since `dispatch`
returns only whether it was queued.

`costly` stays as the recorded outcome; changing the frozen union is out
of scope and the debrief's use of it is a follow-up for the game track.

### 5. The title screen

Under `Disc class`, two sentences per class from the narrative bible's
own description, and the ledger each starts with. Under `Difficulty`, two
sentences per tier. No new copy is written; it is quoted from the bible
with the section cited in a comment. The Boot Sector's gate teaches the
class in play; the title screen only has to make the choice legible.

### 6. The playthrough

`tests/e2e/playthrough.mjs` gains one run before the journey: a fresh
profile, the tutorial driven beat by beat through the real UI, asserting
each beat's exit condition in order and that the `EPERM` line, the
`man EPERM` command, one successful submission and the gate all appear in
`run.decisions` as the harness's known-good script records them. Then the
profile flag is asserted true, and the journey run begins by taking `Skip
tutorial` and asserting the Boot Sector's hash still equals the harness's
passive hash, since a skipped tutorial is the passive leg. The pacing rule
is asserted once: with a crossing open, `tick()` does not advance across
two seconds of wall time, and advances again after it closes.

### 7. Evidence

`docs/evidence/wp24-playtest.md` records, before and after, the wall
seconds a passive Boot Sector, Quantum Pass, Narrows and Yards take at the
default rate, the tick at which SABLE derezzes and the wall seconds that
gives a player to act, and the eight beats' timings from one real
playthrough on the M3.

## Acceptance criteria

1. A new profile entering the Boot Sector sees the eight beats in order and
   cannot skip them; a profile with `bootSectorCompleted` is offered
   `Skip tutorial` once.
2. Every beat's exit condition is the one in `onboarding.ts`; the driver
   contains no condition of its own.
3. The requisition panel dispatches exactly the anchor strings
   `scripts.ts` uses, and a full requisition through the panel produces
   the same decision kinds and outcomes as the known-good script.
4. `EPERM. man EPERM.` is shown to the player on the reach; every
   director refusal and every errno is shown as a refusal line.
5. The gate ends the leg on `leg_done`; the browser passes no allowance;
   the harness passes 200 and every golden is unchanged.
6. The default rate is 2 ticks a second; the pace indicator shows the
   rate and the top hold's name; Space and the brackets work as specified.
7. Every panel and card that asks a question holds the clock while open;
   the interactions panel and the terminal do not.
8. `LegContent.arguments` exists, `validateContent` accepts it, and the
   interactions panel renders a select for a verb that declares it.
9. The title screen explains disc class and difficulty in the bible's
   words with the section cited.
10. The playthrough drives the tutorial once and skips it once, both green
    on the runner and on the M3.
11. No frozen file changes; no file outside the two lists changes; the
    balance ledger and all eight goldens are unchanged.
12. All four gates pass on every commit; no skipped test; no em dash or en
    dash used as an em dash anywhere in the diff.

## Report back

The evidence file; the eight beats' exit conditions as the driver checks
them, each beside the data file's text; the `content.ts` diff; the
`RunDirector` and `LegRunner` diffs; the refusal mechanism; the pace
indicator's placement; and every gap between this document and the tree,
numbered. Push `wp-24` and stop; do not merge.

## Pre-flight before writing

Read this document and the required reading, then send a pre-flight,
numbered: the `createPacing` mapping onto `timeScale` and how holds
interact with the loop's own pause on visibility change; how the driver
observes each exit condition against the shipped session (which store,
event or rig state it reads for each of the eight); how the reveal in beat
two and the lighting in beat three are done with the stand-in stage; how
the panel obtains a refusal reason for a queued command; the
`zeroSegmentAllowance` diff across the three files and the two protected
cases as you will change them; the `content.ts` diff; the pace indicator's
region; the exact bible sections you will quote on the title screen; and
every seam you cannot reach without editing a file outside the grant, each
with the smallest diff. Wait for the reply before the first commit. Every
commit passes all four gates on its own and ends with both attribution
lines.

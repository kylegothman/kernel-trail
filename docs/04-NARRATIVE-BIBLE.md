# KERNEL TRAIL: Narrative and Game Design Bible

**Document 04. Subordinate to `docs/00-DESIGN-BRIEF.md`. Where this document and the
brief disagree, the brief wins. Where this document and `src/game/types.ts` disagree,
the types win: they are frozen.**

Everything below is written to drop straight into content modules. Event tables,
epitaphs and codex entries are given in the exact shape of the frozen interfaces.

---

## 1. World fiction

### 1.1 The Substrate

Nobody in the Substrate remembers being written. That is normal. A program does not
observe its own load, only the moment after: the first instruction, the address it
finds itself at, the light coming on. What every program in the Substrate does
remember is that there used to be more room.

The Substrate is a machine running far past the capacity it was provisioned for, and
its geography is its hardware. The Boot Sector, where address space is cheap and the
light is clean. The Allocation Yards, where the free space has been cut into pieces
too small to hold anything. The Drowned Reach, where the ground is paged in beneath
your feet one step at a time and paged back out behind you. Distance is measured in
service time. Weather is load. The horizon glows because a great many things are
running just past it, and all of them are running on the silicon you are standing on.

Programs are residents. They hold quota, they burn cycles, they queue in queues that
are visible as queues, and when they stop being scheduled they stop, in the literal
sense, existing: the light goes out of them from the edges inward and what is left is
reclaimed inside a tick. This is called derezzing. The Substrate files it under
housekeeping.

### 1.2 Why the convoy is crossing

Because staying is arithmetic. Demand in the Substrate rises and the frame count does
not. Every cycle the ready queues lengthen, the free lists shorten, and the
reclamation sweeps come closer together. A program that stays put is a program waiting
to be named victim by a policy that has no opinion about it.

There is one exit. It is called the Portal, it sits at the far end of the machine, and
it is where a workload that reaches it completes: results committed, exit code zero,
released to whatever the Substrate has been producing output for all this time.
Nobody who has gone through has come back to say what it was like, which is exactly
what normal termination looks like from the inside.

The road there is fourteen legs long and every one of them is a subsystem under load.

### 1.3 The pressure, and why it is not a villain

Nothing on the road hates you. New travellers get this wrong for about a week.

The arbiters that patrol the Substrate are policy made walking. They preempt, they
evict, they deny, they reclaim, and they do all of it by rules printed on their own
flanks in light you are free to read. An arbiter that derezzes your cartographer did
not select her. It ran a replacement policy, the policy named a frame, and she
happened to be in that frame. There is no appeal, because there is nothing there to
appeal to.

The Substrate is over-subscribed and completely indifferent. Indifference at scale is
worse than malice: malice can be reasoned with and a scheduler cannot.

So what kills convoys is almost never an attack. It is a quantum set two ticks too
short. A lock held across a wait. A working set that stopped fitting somewhere back
near the Yards and nobody checked. A degree of multiprogramming raised one too far by
a traveller who was in a hurry.

### 1.4 The twist, and where it is planted

Time in the Substrate is not continuous, and everyone has noticed at least once.

A hundred ticks go missing and every program in sight resumes mid-stride with no
memory of the gap. Certain instructions cost a thousand times what they should, as if
something caught them and handled them somewhere else. The far wall of the machine
sits at a fixed distance in every direction no matter how far you walk toward it. And
the Portal's address, which any cartographer can read off a milestone, is outside the
Substrate's own address space.

The Substrate is a guest. Above it there is a host that pauses it, resumes it, meters
it, and has never once asked permission. When the convoy reaches the Portal, the
Portal opens onto ring zero of the machine that has been hosting the whole journey,
and the last chapter of the course is the world admitting what it is.

Chapter 18 is not a plot twist bolted onto an OS course. It is the OS course arriving
at the observation it was always heading for: everything the player has been managing
was itself being managed, one level up, by something running the same algorithms on
the Substrate that the player has been running on the convoy.

### 1.5 Foreshadowing schedule

Plants are cheap and must never be underlined. One per leg, at most, in ambient text.

| Leg | Plant |
|---|---|
| 0 | The firmware sign-on prints a vendor string nobody recognises and a machine model with a version suffix. |
| 1 | A milestone lists the Substrate's own PID. It is not 1. |
| 2 | Core count reported by the world is a power of two and never changes, on any run, at any difficulty. |
| 3 | An arbiter freezes mid-stride for eleven ticks, then continues from exactly where it stopped. |
| 4 | A lock's wait queue contains one entry the convoy cannot resolve to any process in the Substrate. |
| 5 | The Cistern's buffer has a producer nobody has ever seen enter the Cistern. |
| 6 | `wfg` draws an edge that terminates off the graph, at a node with no label. |
| 7 | Physical frame numbers exceed the reported frame count. VESPER remarks on it once. |
| 8 | Pages fault in with contents already warm, as though something else had touched them first. |
| 9 | The platter's outermost cylinder reads as cylinder zero of a larger device. |
| 10 | An interrupt arrives from a device id that is not in `lsof`, `mount` or the device table. |
| 11 | The journal contains committed transactions from before the Substrate's own boot tick. |
| 12 | The access matrix has a column for a domain of ring 0 that no arbiter belongs to. |
| 13 | The reveal. Trap-and-emulate is the mechanic and the ending simultaneously. |

---

## 2. Tone guide

### 2.1 The register

The Substrate speaks in short declaratives with real nouns in them. It states
measurements. It reports outcomes. It does not apologise, dramatise, or explain
itself twice. Underneath the flatness there is grief, because everything here is
running out of something, and the writing gets its weight from refusing to say so.

Rules, enforced in review:

1. **Technical nouns are the vocabulary.** Frame, quantum, victim, burst, queue,
   parity, fault. Use them literally. Never gloss them in the fiction; that is what
   the codex is for.
2. **Measurements beat adjectives.** "Ninety-one faults per thousand ticks" is more
   frightening than "severe memory pressure".
3. **Short sentences carry the bad news.** Long ones are for description.
4. **Nobody in the world is wry about the world.** Programs are not amused by their
   circumstances.
5. **No second person accusations.** The world reports; the player draws the
   conclusion.
6. **Elegy is allowed once per screen and never signposted.** One line that lands
   somewhere human, then straight back to the numbers.
7. **The one licensed comic register is the tombstone inscription.** Nothing else in
   the game may be funny. Not the debrief, not the depot, not a Program's voice line,
   not an event title. The joke works because it is the only joke.

### 2.2 Ten lines that hit

1. "Free list: four entries. Largest: three frames. Nothing here is contiguous."
2. "The arbiter reads the policy off its own flank, finds your cartographer named, and
   does what it says."
3. "Fault rate ninety-one per thousand. The ground behind the convoy has stopped
   coming back."
4. "SABLE has been ready for two hundred and six ticks. Nothing is wrong with SABLE."
5. "Depot open. Cycles accepted. Nothing here is a favour."
6. "Two Programs are holding what the other one needs. Both are correct. Both will
   wait forever."
7. "KESTREL logs the seek: cylinder 4, cylinder 197, cylinder 6, cylinder 195. The arm
   is doing its job perfectly."
8. "The journal has the write. The journal does not have the commit. Whatever was in
   that directory is a matter of opinion now."
9. "ORRERY rebuilds the inode from a transaction that finished eleven ticks before she
   was scheduled. She does not comment on this."
10. "You will lose someone at the Narrows. It is a question of which lock."

### 2.3 Five lines that miss

1. *"Uh oh! Looks like somebody's got a case of the deadlocks!"*
   Fails because it is chirpy, it is second person, and it does the player's reaction
   for them. Comedy outside the tombstones destroys the only place comedy is allowed
   to work.

2. *"The Substrate is a vast, breathtaking expanse of infinite digital wonder,
   stretching endlessly beyond the horizon in a shimmering weave of light."*
   Fails because adjectives are standing in for measurements, and because it claims
   infinity in a setting whose entire premise is that nothing here is infinite. Six
   words of that sentence could be replaced by one free-frame count that would frighten
   the reader more.

3. *"VESPER smiles sadly. 'Oh, LUMEN,' she says. 'We've been through so much together.
   Whatever happens next, I want you to know I'm glad it was you.'"*
   Fails because the Programs have become companions with an emotional subplot. They
   are colleagues under load. Restraint is the whole reason the player cares.

4. *"WARNING: Critical memory pressure detected! Take immediate action to prevent
   catastrophic system failure!"*
   Fails because it is an alarm, not a report. It also tells the player that action is
   required without telling them anything they could act on. Give the number, name the
   subsystem, stop talking.

5. *"Was it the quantum? Was it the policy? Perhaps it was simply the Substrate's way
   of reminding us that all things must end."*
   Fails on rhetorical questions used as transitions, on mysticism where a mechanism
   belongs, and on writing that is impressed with itself. The Substrate always knows
   exactly why something died and says so in one clause.

### 2.4 The tombstone exception

Tombstone inscriptions are flat, absurd, and delivered without any awareness that
they are funny. The model is "HERE LIES ANDY, PEPPERONI AND CHEESE": a name, a comma,
a fragment that is technically an accurate summary of the death. Never a pun on a
computing term. Never a wink at the player. The humour comes entirely from the
mismatch between the scale of the loss and the flatness of the summary.

Beneath every inscription, in a different weight, the `cause` line states the real
failure in the register of section 2.1. The reader gets the joke, then gets the
lesson, in that order, always.

---

## 3. The five Programs

They are colleagues on a job. They speak when they have information. Their attachment
to each other is legible only in what they do, and the player is left to infer it.

**Hard limits on all five.** No Program initiates conversation about feelings. No
Program comments on the player. No Program has a catchphrase. Maximum three lines
from any Program per leg, and a leg where none of them speaks is a good leg. When one
dies, the others get one line each, total, for the whole run: the reaction lines below
are spent, not repeated.

### 3.1 LUMEN, compiler

Reduces every workload she touches to a smaller version of itself and never says how.
LUMEN thinks in terms of what can be eliminated, which makes her the most useful and
least comforting member of the convoy: her instinct when the convoy is in trouble is
to work out what the convoy can do without. She was written to optimise and she has
no other mode of engaging with a problem. The player will notice that LUMEN's
estimates are always right and always slightly early, and that she does not soften
them.

Voice:
- "Three passes. I can get that burst down to eleven. It will still be eleven."
- "Your degree of multiprogramming is nine. The frames support six. I can't compile
  around that."
- "I have optimised what there was to optimise."

Mechanics:
- **Passive:** service time of all workloads reduced 15 percent.
- **Active:** `recompile`, halve one process's remaining burst. Two charges per leg.
- **Vulnerable to:** thrashing. Optimisation needs the whole working set resident, and
  LUMEN's is the largest in the convoy. She is the first to feel the Drowned Reach.

**On her death the convoy loses:** the 15 percent margin that made every tight leg
survivable. Every subsequent leg's travel cost rises by roughly 15 percent in real
terms, and `stack_overflow` loses its true remedy.

**When another Program dies:** LUMEN recalculates out loud and it reads as callous
until the player understands it is the only grief she has. "Four of us. Recompute the
Reach at four. It still closes."

### 3.2 SABLE, sentinel

Watches the queues. SABLE's function is to notice that something has been waiting too
long, and she has been performing it for so long that she has stopped being able to
switch it off, which is why she counts everything, including the things nobody asked
her to count. She is the convoy's patience and the convoy's alarm, and she is the only
one who will still be standing at the end of a leg that went badly. She holds doors.
That gets her killed.

Voice:
- "ORRERY has been ready for a hundred and ninety ticks. Aging is off."
- "I can make the arbiter's resource preemptible for twenty ticks. After that it takes
  it back and it takes back what it wants."
- "Somebody has to wait last. It should be me."

Mechanics:
- **Passive:** immune to starvation for three times the normal threshold.
- **Active:** `shield`, make one resource preemptible for 20 ticks. Two charges per leg.
- **Vulnerable to:** deadlock. Preemption is the Coffman condition she breaks for
  everyone else and never for herself, so when the cycle closes she is inside it.

**On her death the convoy loses:** the starvation buffer that let the player run
strict priority without aging. `starvation` warnings arrive later and closer to fatal.
The Gridlock becomes materially harder because nothing in the convoy can break a hold.

**When another Program dies:** SABLE reports the wait time. That is her entire
reaction and it is devastating. "Two hundred and eleven ticks ready. I counted all of
them."

### 3.3 ORRERY, codec

Keeps a second copy of everything. ORRERY treats memory as an obligation rather than a
resource, and where the rest of the convoy sees storage she sees the record of what
happened, which she considers the only thing here that will outlast any of them. She
is slow to speak and exact when she does. She is also the only member of the convoy
who is straightforwardly kind, which she expresses by having already written down the
thing you are about to need.

Voice:
- "I have the block before the write. If it goes wrong I can put it back."
- "The commit record is missing. I can tell you what was intended. I cannot tell you
  what happened."
- "Keep the journal. It costs blocks. It costs less than the alternative."

Mechanics:
- **Passive:** corruption is recoverable while ORRERY lives.
- **Active:** `restore`, rebuild one corrupted inode from the journal. Three charges
  per leg.
- **Vulnerable to:** protection faults. She reads widely, across domains, and the
  access matrix does not care about her intentions.

**On her death the convoy loses:** recoverability, permanently. Every `fs.corruption`
event from that tick forward returns `recoverable: false`. The Archive stops being a
puzzle and becomes a survival leg. This is the single most expensive death in the
game and the player should be told so exactly once, by SABLE, at the moment it
happens.

**When another Program dies:** ORRERY writes it down. "Recorded. Tick, cause,
policy in force. It will be readable after us."

### 3.4 KESTREL, courier

Fast, literal, and slightly out of step with everyone else because he is always a
transaction ahead. KESTREL's whole existence is latency, and he has organised his
personality around removing it, which makes him impatient with deliberation and
unusually good at surviving. He is the only member of the convoy who enjoys the
journey. He is also the only one who has never once said anything about the Portal.

Voice:
- "Prefetched the next five. You can stop worrying about those five."
- "Cylinder four. Cylinder one ninety-seven. Cylinder six. The arm is doing its job
  perfectly and we are getting nowhere."
- "Go now. It gets more expensive while we discuss it."

Mechanics:
- **Passive:** device latency and seek cost halved.
- **Active:** `prefetch`, satisfy the next 5 page faults instantly. Two charges per leg.
- **Vulnerable to:** interrupt storms. He answers everything, immediately, which is
  fine until the device raises an interrupt per byte.

**On his death the convoy loses:** half of all I/O speed. The Platters and the Bus
roughly double in tick cost, which cascades into quota burn. A convoy without KESTREL
should seriously consider conservative pace for legs 9 through 11.

**When another Program dies:** KESTREL keeps moving and says the shortest thing
anyone says. "Understood. Same road."

### 3.5 VESPER, cartographer

Knows where everything is and how long it will stay there. VESPER produces the
convoy's model of its own future, which means she is the one who knows first, and she
has developed a habit of stating the conclusion without the working because the
working never once changed anyone's mind. She is dry, precise, and unnervingly
comfortable with bad news. Her maps are correct. The player who ignores her is
choosing to.

Voice:
- "Working set is eleven pages. You have allocated six. I can draw you the difference."
- "There is space. It is in forty-one pieces. Nothing needs forty-one pieces."
- "Physical frame numbers run higher than the frame count. I have stopped raising it."

Mechanics:
- **Passive:** working set estimation 30 percent more accurate.
- **Active:** `remap`, rebuild one page table with optimal locality. Two charges per leg.
- **Vulnerable to:** fragmentation. She is the one who has to fit into the holes.

**On her death the convoy loses:** accurate working set numbers. The HUD switches
from a measured figure to a coarse estimate with visible error bars, and the
`fragmented` affliction loses its true remedy. Leg 8 without VESPER is the hardest
single stretch in the game.

**When another Program dies:** VESPER updates the map. "Four names on the roster.
Rerouting is not possible. The route was always this one."

### 3.6 Distinctness test

If a line can be swapped between two Programs without anyone noticing, it is cut.
The reliable separator is what each one does with bad news: LUMEN recalculates, SABLE
counts, ORRERY records, KESTREL moves, VESPER has already drawn it.

---

## 4. The disc classes

Oregon Trail's banker, carpenter and farmer. The disc is the player's identity token
in the Substrate and it determines what the Boot Sector will issue them.

### 4.1 Shell, `shell`

**The banker.** A shell disc carries a wide privilege set and a generous initial
allocation, because a shell is what the Substrate hands to something it expects to be
running interactively for a long time.

- **Starting resources (operator tier):** 1600 cycles, 900 quota, 120 blocks, 60 bandwidth.
- **Perk:** `syscall credit`. Policy changes are free at every difficulty, including
  `kernel_space`, where they otherwise cost 25 cycles each. The player can experiment
  with schedulers and replacement policies without paying for curiosity.
- **Score multiplier:** 1.0
- **Who should pick it:** first run, always. Anyone who has never seen a page table.
  The shell exists so the player can afford to be wrong forty times in leg 3 and still
  reach leg 8.

### 4.2 Daemon, `daemon`

**The carpenter.** A daemon disc is long-lived, low-priority and built to repair
things, which is exactly the mix of poverty and competence the middle class needs.

- **Starting resources (operator tier):** 1100 cycles, 650 quota, 160 blocks, 45 bandwidth.
- **Perk:** `self-heal`. Repairs cost half the usual blocks, and at the start of each
  leg every Program below 50 integrity recovers 8 integrity for free. Blocks are the
  daemon's real currency and the class starts with the largest stock of them.
- **Score multiplier:** 2.0
- **Who should pick it:** the second and third runs. A player who has died once to
  thrashing and once to deadlock and wants the same journey with less margin. The
  daemon rewards maintenance discipline: repair early, journal often, never let a
  Program run at 40 integrity into a leg with a crossing in it.

### 4.3 Compiler, `compiler`

**The farmer, and it must be genuinely hard.** A compiler disc is issued to something
the Substrate expects to be short-lived and to justify its cycles continuously. It is
issued a third of what a shell gets and is expected to make it back.

- **Starting resources (operator tier):** 700 cycles, 420 quota, 90 blocks, 30 bandwidth.
- **Perk:** `optimisation dividend`. Every leg-completion payout is multiplied by
  1.25, and every reclamation run yields 1.35 times its normal quota. The compiler
  class is a production economy: it starts near zero and out-earns the shell by leg 9
  if, and only if, the player is efficient.
- **Score multiplier:** 3.5
- **Who should pick it:** the player who has finished a run and wants the game to
  stop being generous.

**Why it is hard.** The modelled steady-pace journey costs about 2550 cycles. A
compiler starts with 700 and is projected to earn about 1658 in dividends, leaving a
structural deficit of roughly 190 cycles before a single depot purchase. That gap has
to be closed by playing well: raising throughput to push dividends above the 1.0
factor, running conservative pace on the cheap legs, and reclaiming every leg without
missing. There is no configuration of the compiler class that survives on defaults.

**Why it is worth it.** The 3.5 multiplier applies to the whole score, and the score
components a compiler naturally maximises (efficiency, correctness, concepts) are the
ones that scale. A clean compiler run scores between four and five times a clean shell
run of identical play quality. It is also the only class that makes the reclamation
minigame load-bearing, which is the most replayable system in the game.

**Guard rail.** The compiler is hard, and it must never be unwinnable from a
recoverable position. The underflow clause in section 5.6 applies to all classes and
is what keeps the compiler squeezed rather than dead.
---

## 5. Resource economy

Four resources, one for each thing an operating system runs out of. Every one of them
is a real quantity in the simulator before it is a number on the HUD.

### 5.1 What each one is

**Cycles.** CPU budget, drawn against the Substrate's scheduler on the convoy's behalf.
Fictionally, a cycle is a slice of processor time the convoy has been authorised to
consume, and the authorisation is finite because the machine is over-subscribed.
Mechanically it is money: travel costs cycles, depots price everything in cycles, and
at `architect` and above every policy change costs cycles too. Cycles are earned only
at leg completion and in small refunds from reclamation. This scarcity is deliberate.
Cycles are the resource the player cannot farm.

**Quota.** Memory allocation, denominated in frames. This is the food. The convoy
consumes quota continuously while travelling, at a rate set by the rations dial, and
when quota hits zero the Programs run below their working sets and start dissolving.
Quota is bought at depots and, mainly, hunted in the reclamation minigame. Quota is
the resource the player farms.

**Blocks.** Storage blocks on the platters. These are the spare parts: repair a
Program's integrity, write a journal checkpoint, rebuild a failed RAID member, scrub
bit rot. Blocks are earned by coalescing free-space fragments during reclamation and
bought cheaply at depots. Running out of blocks does not kill anyone directly. It
means the next thing that breaks stays broken.

**Bandwidth.** I/O budget for the current leg. Unlike the other three this is not a
stockpile: it refills at the start of every leg to 60 percent of the disc class cap,
and to 100 percent at a depot. Bandwidth is spent on interactions with diegetic
objects, on Program abilities, on extra reclamation runs, and at higher difficulties
on terminal commands that write to simulator state. Bandwidth is what stops the player
from solving a leg by clicking everything.

`integrity` also appears in `ResourceKind`. It is per-Program rather than ledgered, and
it exists in the union so that `AfflictionRemedy` can express a spend against it.

### 5.2 Starting allocations

Base values at the `operator` tier. Multiply by the difficulty factor.

| Disc class | Cycles | Quota | Blocks | Bandwidth cap |
|---|---|---|---|---|
| shell | 1600 | 900 | 120 | 60 |
| daemon | 1100 | 650 | 160 | 45 |
| compiler | 700 | 420 | 90 | 30 |

| Difficulty | Resource factor | Applied to |
|---|---|---|
| novice | 1.35 | cycles, quota, blocks, bandwidth |
| operator | 1.00 | all |
| architect | 0.80 | all |
| kernel_space | 0.65 | all |

Worked example: a compiler disc at `architect` starts with 560 cycles, 336 quota, 72
blocks and a 24 bandwidth cap. That is the intended hard start.

### 5.3 Leg lengths and the steady-state cost

Every leg has a length in **segments**. Pace converts segments into ticks and into
cycles; rations convert ticks into quota.

```
ticksForLeg   = segments / segmentsPerTick(pace)
cyclesForLeg  = segments * cyclesPerSegment(pace) * quantumOverhead(pace)
quotaForLeg   = ticksForLeg * framesPerProgram(rations) * aliveCount * 0.2
```

| # | Leg | Segments | Cycles @ steady | Ticks @ steady | Quota @ standard, 5 alive | Depot |
|---|---|---|---|---|---|---|
| 1 | The Fork Fields | 60 | 150 | 60 | 150 | yes |
| 2 | The Weave | 65 | 163 | 65 | 163 | no |
| 3 | Quantum Pass | 70 | 175 | 70 | 175 | yes |
| 4 | The Narrows | 75 | 188 | 75 | 188 | no |
| 5 | The Cistern | 75 | 188 | 75 | 188 | yes |
| 6 | The Gridlock | 80 | 200 | 80 | 200 | no |
| 7 | The Allocation Yards | 85 | 213 | 85 | 213 | yes |
| 8 | The Drowned Reach | 100 | 250 | 100 | 250 | **no** |
| 9 | The Platters | 85 | 213 | 85 | 213 | yes |
| 10 | The Bus | 80 | 200 | 80 | 200 | no |
| 11 | The Archive | 90 | 225 | 90 | 225 | yes |
| 12 | The Arbiter Wall | 85 | 213 | 85 | 213 | yes |
| 13 | The Portal | 70 | 175 | 70 | 175 | no |
| | **Total** | **1020** | **2553** | **1020** | **2553** | 7 depots |

Leg 8 has no depot. The showpiece leg is also the one where the player crosses with
whatever they were carrying when they left the Yards. Every playtest note about leg 8
being too punishing should be answered by adjusting the Yards depot, never by putting
a depot in the Reach.

### 5.4 Income

**Leg dividend**, paid on leg completion:

```
dividend = (60 + 6 * legIndex) * throughputFactor * classDividendMultiplier
```

`throughputFactor` runs from 0.6 to 1.4 and is computed from the kernel's own
`SchedulingMetrics.throughput` for the leg, normalised against the leg's designed
target. `classDividendMultiplier` is 1.0 for shell and daemon and 1.25 for compiler.

At `throughputFactor = 1.0` the thirteen dividends are 66, 72, 78, 84, 90, 96, 102,
108, 114, 120, 126, 132, 138, summing to 1326.

**Reclamation**, once free per leg, additional runs at 8 bandwidth for 0.6 yield:

| Yield | Base range | Compiler class |
|---|---|---|
| quota | 90 to 220, mean 150 | x1.35, mean 202 |
| blocks | 8 to 30, mean 18 | x1.0 |
| cycles refund | 10 to 30, mean 18 | x1.0 |

### 5.5 The intended curve

Modelled on defaults: steady pace, standard rations, five Programs alive,
`throughputFactor = 1.0`, no depot purchases. This is the "player who changes nothing"
line, and it must fail, late, and legibly.

Cycles, running balance at the end of each leg:

| After leg | Shell | Daemon | Compiler |
|---|---|---|---|
| 1 | 1516 | 1016 | 633 |
| 2 | 1425 | 925 | 560 |
| 3 | 1328 | 828 | 482 |
| 4 | 1224 | 724 | 399 |
| 5 | 1126 | 626 | 324 |
| 6 | 1022 | 522 | 244 |
| 7 | 911 | 411 | 158 |
| 8 | 769 | 269 | 43 |
| 9 | 670 | 170 | **-28** |
| 10 | 590 | 90 | |
| 11 | 491 | **-9** | |
| 12 | 410 | | |
| 13 | 373 | | |

Read that table as the design statement it is:

- **Shell** finishes 373 cycles up on pure defaults, which is exactly enough to have
  bought two repairs and a policy hint along the way. A shell player who plays badly
  still arrives.
- **Daemon** goes negative entering the Archive. Defaults are not survivable. The gap
  is 9 cycles, which is one conservative-pace leg or one good throughput leg. The
  daemon is meant to notice around leg 8 that the numbers do not close and to do
  something about it.
- **Compiler** goes negative entering the Platters, with a structural deficit of about
  190 cycles across the run before any purchase at all. Closing it requires
  conservative pace on at least three cheap legs, `throughputFactor` above 1.15 on
  most legs, and a reclamation run every single leg without a miss.

Quota tells the mirror story. The journey consumes 2553 quota at standard rations. A
shell starts with 900, a daemon with 650, a compiler with 420. The remainder,
between 1653 and 2133 frames, comes out of reclamation, which is why the minigame has
to be genuinely enjoyable and why it is once free per leg rather than unlimited.

Blocks: a typical run spends about 300 (roughly 180 on repairs, 60 on journaling, 40
on RAID rebuild, 24 on bit rot scrubbing). Reclamation supplies about 234 over
thirteen legs. Shell and compiler must buy the difference; the daemon, at half repair
cost, has slack, and that slack is the daemon's whole personality.

### 5.6 The underflow clause

The player is squeezed and never softlocked.

**Cycles.** If the ledger cannot pay the conservative-pace cost of the next leg, the
Substrate issues an **emergency preemption credit**. The convoy travels that leg at
conservative pace for zero cycles, and pays for it in kind:

- one extra event draw per 20 ticks
- leg dividend reduced 25 percent
- 0.3 integrity per tick against the lowest-integrity living Program

The credit is available every leg and is never refused. It is survivable and it is
never good.

**Quota.** At zero quota the rations dial is forced to `starved` and cannot be raised
until quota is positive. The free reclamation run is always available regardless of
bandwidth, so quota is always recoverable by playing.

**Blocks.** Cannot go negative. At zero blocks, repairs and journaling are simply
unavailable.

**Bandwidth.** Cannot go negative. At zero bandwidth, only free verbs remain: setting
policy, setting pace and rations, reading the terminal, opening the codex.

### 5.7 Depot price table

```
price(base, legIndex, tier) = round(base * (1 + 0.09 * legIndex) * tierFactor)
tierFactor: novice 0.80, operator 1.00, architect 1.15, kernel_space 1.35
```

Base prices, before scaling:

| Item | Unit | Base cycles | Base blocks |
|---|---|---|---|
| Quota lot | 25 frames | 50 | 0 |
| Block lot | 10 blocks | 30 | 0 |
| Bandwidth lot | 5 units | 20 | 0 |
| Repair | 10 integrity | 15 | 8 |
| Policy hint | one | 60 | 0 |
| Journal checkpoint | one | 90 | 25 |
| Recruit a replacement Program | one per run | 220 | 40 |

Resolved at `operator`, at each of the seven depots:

| Item | Leg 1 | Leg 3 | Leg 5 | Leg 7 | Leg 9 | Leg 11 | Leg 12 |
|---|---|---|---|---|---|---|---|
| Quota lot (25) | 55c | 64c | 73c | 82c | 91c | 100c | 104c |
| Block lot (10) | 33c | 38c | 44c | 49c | 54c | 60c | 62c |
| Bandwidth lot (5) | 22c | 25c | 29c | 33c | 36c | 40c | 42c |
| Repair (10 int) | 16c + 9b | 19c + 10b | 22c + 12b | 24c + 13b | 27c + 14b | 30c + 16b | 31c + 17b |
| Policy hint | 65c | 76c | 87c | 98c | 109c | 119c | 125c |
| Journal checkpoint | 98c + 27b | 114c + 32b | 131c + 36b | 147c + 41b | 163c + 45b | 179c + 50b | 187c + 52b |
| Recruit | 240c + 44b | 279c + 51b | 319c + 58b | 359c + 65b | 398c + 72b | 438c + 80b | 458c + 83b |

Note the shape: quota bought at the Yards depot (leg 7) costs 82 cycles for 25 frames,
which is 3.3 cycles per frame against a reclamation cost of zero cycles and one free
run. Depot quota exists as an emergency, and its price says so.

---

## 6. Pace and rations

The two dials the player touches more than anything else. Both are direct writes into
`KernelConfig`, so their consequences are simulated rather than scripted.

### 6.1 Pace, which sets the quantum

`Pace` maps onto `SchedulerParams.quantum` and onto how fast the convoy moves.

| Pace | Quantum (ticks) | Segments per tick | Cycles per segment | Quantum overhead | Effective cycles per segment | Workload arrival rate |
|---|---|---|---|---|---|---|
| `conservative` | 16 | 0.6 | 1.4 | 1.125 | 1.575 | x0.70 |
| `steady` | 8 | 1.0 | 2.0 | 1.25 | 2.50 | x1.00 |
| `aggressive` | 4 | 1.5 | 3.0 | 1.50 | 4.50 | x1.45 |
| `reckless` | 2 | 2.1 | 4.4 | 2.00 | 8.80 | x2.00 |

```
quantumOverhead(pace) = 1 + 2 / quantum
```

The overhead term is the context switch cost made economic. Halving the quantum
doubles the number of switches over the same work, and each switch is real CPU the
convoy paid for and did not use.

**An 80-segment leg at every setting**, five Programs alive, standard rations:

| Pace | Cycles | Ticks | Quota | Context switches | Event draws |
|---|---|---|---|---|---|
| `conservative` | 126 | 133 | 333 | ~17 | 13 |
| `steady` | 200 | 80 | 200 | ~20 | 8 |
| `aggressive` | 360 | 53 | 133 | ~27 | 5 |
| `reckless` | 704 | 38 | 95 | ~38 | 4 |

**The tradeoff, stated plainly.** Cycles are charged per segment and quota is charged
per tick, so the two dials pull in opposite directions across the same leg. Conservative
pace is the cheapest way to spend cycles and the most expensive way to spend quota and
exposure: 2.6 times the memory burn and 60 percent more event draws than steady.
Reckless pace is the cheapest way to spend quota and a catastrophic way to spend
cycles: 5.6 times steady's cycle cost.

**Where the starvation comes from.** Fast pace does not starve the convoy through the
quantum. It starves them through traffic. `workloadArrivalRate` scales with pace,
because moving faster through the Substrate means pushing into denser scheduling
contention, and the leg's own processes arrive at higher priority than the convoy's.
At `reckless`, twice as many competitors enter the ready queue per tick, and any
Program on a low priority under a non-aging policy will hit `starvationThreshold`
inside one leg. This is why leg 3 is where the first policy death happens: the player
has learned by then that reckless is fast, and Quantum Pass is the first leg where
strict priority is the default.

**Where running out comes from.** Conservative pace costs 2.6 times the quota of
steady and rolls 60 percent more events. A convoy that crawls the whole journey to
save cycles arrives at the Drowned Reach with no frames, and the Reach has no depot.

**Guidance the game never gives the player.** Conservative on legs 2, 5 and 11, which
are long and light. Steady as the default. Aggressive only to outrun a running
affliction clock, since it is the only dial that reduces `fatalAfter` exposure.
Reckless is for one situation: a Program at `fatalAfter` minus 20 ticks, with the leg
boundary in reach, and enough cycles to pay for it.

### 6.2 Rations, which set frames per process

`Rations` maps onto the per-Program resident set the memory manager guarantees.

| Rations | Frames per Program | Frames reserved (5 alive) | Quota per tick (5 alive) | Convoy fault rate | Effect |
|---|---|---|---|---|---|
| `generous` | 4.0 | 20 | 4.0 | near zero | frames pinned away from the leg workload |
| `standard` | 2.5 | 12.5 | 2.5 | low | balanced |
| `lean` | 1.5 | 7.5 | 1.5 | raised | +0.3 integrity per tick, 4% per tick `cache_thrash` roll |
| `starved` | 0.8 | 4 | 0.8 | severe | +1.0 integrity per tick, 6% per tick `thrashing` roll |

```
quotaPerTick = framesPerProgram * aliveCount * 0.2
```

**Generous rations are a trap and the trap is the lesson.** The frames a convoy pins
for itself come out of the same `totalFrames` the leg's own workload is paged into.
Early legs run 64 frames; the Drowned Reach runs 48. Generous rations pin 20 of those
48, which is 42 percent of the Reach, and the workload's fault rate climbs past
`thrashingThreshold` as a direct consequence. The sim then emits
`memory.thrashing` against the workload, throughput collapses, `throughputFactor`
drops toward 0.6, and the dividend that was going to pay for the Platters does not
arrive. Nobody in the convoy is hurt. The convoy still loses.

This is Ch. 10.6.1 delivered as a dial: the degree of multiprogramming and the
per-process frame allocation are the same knob viewed from two ends, and comfort for
one process is pressure somewhere else.

**Lean and starved are the mirror trap.** Below the working set, each Program's own
fault rate rises, and the sim starts evicting pages it is about to need. `lean` costs
0.3 integrity per tick, which across a 90-tick leg is 27 integrity per Program: a
whole leg's worth of repairs to save 90 quota. `starved` is only correct as an
emergency measure for fewer than 20 ticks.

**Interaction with the degree of multiprogramming.** `TravelPolicy.degreeOfMultiprogramming`
is a third dial that multiplies the leg workload's process count. Frames available to
the convoy are `totalFrames - workloadDemand(degree)`. Raising the degree raises
throughput and therefore the dividend, right up until the fault rate crosses the
threshold, at which point throughput falls off a cliff. Finding that knee is the
central skill of leg 8 and the reason `reduce_degree` is the remedy for `thrashing`.

---

## 7. Afflictions

Oregon Trail's dysentery table, and the heart of the teaching design. Thirteen
afflictions, one per `AfflictionId`. Each has a true remedy expressible as an
`AfflictionRemedy`, and each has an obvious wrong answer the sim will happily let the
player pay for.

The rule that makes this work: **the remedy is never displayed until the codex entry
unlocks, and the codex entry unlocks by suffering the pathology.** The first time a
convoy meets an affliction the player is genuinely reasoning from the concept. Every
time after, they are executing.

### 7.1 Summary table

| `AfflictionId` | Display name | Drain per tick | Fatal after | True remedy kind | Chapter |
|---|---|---|---|---|---|
| `priority_inversion` | Priority Inversion | 0.8 | null | `terminal` | 6.6, 5.3.4 |
| `memory_leak` | Memory Leak | 0.5 | null | `terminal` | 9.1, 10.8 |
| `starvation` | Starvation | 1.2 | 180 | `set_scheduler` | 5.3.4 |
| `thrashing` | Thrashing | 2.0 | 90 | `reduce_degree` | 10.6 |
| `lock_convoy` | Lock Convoy | 0.6 | null | `adjust_quantum` | 6.5, 5.3.4 |
| `livelock` | Livelock | 0.9 | 140 | `terminal` | 6.2, 6.7 |
| `orphaned` | Orphaned | 0.4 | null | `terminal` | 3.3.2 |
| `fragmented` | Fragmented | 0.7 | null | `ability` | 9.2.3 |
| `cache_thrash` | Cache Thrash | 0.5 | null | `adjust_quantum` | 1.5.3, 5.3.4 |
| `bit_rot` | Bit Rot | 0.3 | 400 | `spend` | 11.8 |
| `stack_overflow` | Stack Overflow | 1.5 | 60 | `ability` | 9.3.3, 3.1.1 |
| `false_sharing` | False Sharing | 0.6 | null | `terminal` | 4.5, 1.5.3 |
| `interrupt_storm` | Interrupt Storm | 1.1 | 110 | `terminal` | 12.2.5 |

### 7.2 The entries

---

#### `priority_inversion`

**In world.** A Program of no consequence is holding something the convoy needs, and
the Substrate keeps preempting it in favour of work that is more urgent and less
important. The holder never finishes. The waiter never starts. The light between them
flickers at exactly the quantum period.

> "SABLE is blocked on a lock held by a background sweep at priority 34. The sweep gets
> scheduled once every eleven ticks. It needs four ticks to finish."

**Mechanics.** 0.8 integrity per tick against the *waiting* Program. Never fatal on its
own, which is what makes it insidious: it bleeds a Program down to critical across two
legs and then something else finishes the job.

**True remedy.**
```ts
{ kind: 'terminal', command: 'nice -p <holder-pid> -n -10' }
```
Raise the priority of the process that holds the lock, so it can run, finish, and
release. Priority inheritance, done by hand. `lsof <resource>` names the holder;
`nice` boosts it.

**The misleading remedy.** Boost the *victim*. Every player tries `nice` on the
Program they can see suffering, because that is the one the HUD is shouting about. It
does nothing at all. The waiter is blocked rather than ready, and no priority on earth
schedules a process that is not in the queue. Watching the number change and the
integrity keep falling is the entire lesson.

**Second misleading remedy.** Switching to round robin. It helps slightly, by giving
the holder a slice eventually, and it is slow enough that the Program usually still
dies. Partial credit answers that fail are better teaching than answers that do
nothing.

**Concept.** Priority inversion and priority inheritance. Ch. 6.6, with the scheduling
background in Ch. 5.3.4. Codex: `sync.priority-inversion`.

---

#### `memory_leak`

**In world.** Something the Program spawned is allocating and never releasing. The
Program's quota drains at a constant rate that does not correspond to any work it is
doing, and the leak is patient: it will still be there in four legs, taking the same
amount.

> "ORRERY's resident set has grown for sixty ticks without a single new page reference.
> Nothing is reading what she is holding."

**Mechanics.** 0.5 integrity per tick, never fatal directly. The real damage is the
ledger: a leak drains 1.5 quota per tick from the run's quota on top of rations, which
across a 90-tick leg is 135 frames, most of a reclamation run.

**True remedy.**
```ts
{ kind: 'terminal', command: 'kill <leaker-pid>' }
```
The leaking allocation belongs to a child process. Terminating it returns every frame
it held, because the kernel reclaims a process's entire address space at exit. `ps -t
<pid>` shows the child; `free` shows the recovery the instant it dies.

**The misleading remedy.** Buy quota. It is right there in the depot, the HUD is
showing a quota problem, and 25 frames costs 82 cycles at the Yards. The leak consumes
them at the same rate as everything else, and now the player is out 82 cycles and back
where they started in 17 ticks. Buying your way out of a leak is the exact mistake
production engineers make and it deserves to cost real money in the game.

**Concept.** Address space reclamation at process exit, and why a leak is a liveness
problem rather than a capacity problem. Ch. 9.1 and Ch. 10.8. Codex: `mem.leak`.

---

#### `starvation`

**In world.** A Program is ready. It has been ready for a long time. There is nothing
wrong with it, nothing blocking it, and no fault on its record. Higher priority work
keeps arriving and the scheduler keeps doing exactly what it was told.

> "SABLE has been ready for two hundred and six ticks. Nothing is wrong with SABLE."

**Mechanics.** 1.2 integrity per tick. **Fatal after 180 ticks**, at which point the
process terminates with `TerminationReason: 'starvation'`. SABLE's passive extends
that threshold threefold, to 540, which is why she is the one who says the line.

**True remedy.**
```ts
{ kind: 'set_scheduler', to: 'priority_aging' }
```
Aging. A process that has waited long enough gains a priority level, so no finite
arrival stream can hold it out forever. This is the textbook answer and the game should
accept nothing else as full credit.

**The misleading remedy.** `nice -n -5` on the starved Program. It works. That is the
problem. The Program starts running, the HUD goes green, the player learns the wrong
lesson, and then twenty ticks later three higher-priority workload processes arrive and
the same Program is starving again with 40 fewer integrity. Manual priority is a fix
for one instant; aging is a fix for the policy. The sim is instructed to make this
recur within the same leg, every time, so the player feels the difference between
patching a symptom and changing a rule.

**Second misleading remedy.** Switching to SJF, because it looks fairer than strict
priority. SJF starves long jobs harder than priority does, and the convoy's Programs
have the longest bursts on the board.

**Concept.** Indefinite blocking and aging. Ch. 5.3.4. Codex: `sched.starvation`,
which links to `sched.aging`.

---

#### `thrashing`

**In world.** The Program is doing nothing but fetching. Every page it needs was
evicted while it was waiting for the previous one. CPU utilisation is high and falling,
the disk light never goes out, and no work of any kind is being completed.

> "Fault rate ninety-one per thousand. The ground behind the convoy has stopped coming
> back."

**Mechanics.** 2.0 integrity per tick, the heaviest drain in the table. **Fatal after
90 ticks**, terminating with `'thrashing_collapse'`. Inflicted by the sim whenever a
Program's fault rate exceeds `KernelConfig.thrashingThreshold` for 15 consecutive
ticks, so it is never rolled at random. It is always earned.

**True remedy.**
```ts
{ kind: 'reduce_degree', by: 2 }
```
Lower the degree of multiprogramming. Fewer processes competing means more frames per
process means each working set fits. Throughput rises by taking work away, which is
the counterintuitive result the whole of Ch. 10.6 exists to establish.

**The misleading remedy.** Change the page replacement policy. FIFO to LRU, LRU to
clock, clock to LFU. The player will cycle every option in the menu, and the fault rate
will move by a few percent and stay above the threshold, because no replacement policy
can make eleven pages fit in six frames. This is the single most valuable failed
experiment in the game and the sim should let the player run all six.

**Second misleading remedy.** Raising rations to `generous`. This actually helps the
afflicted Program, and it pins so many frames that a different process starts
thrashing 20 ticks later. Thrashing moves; it does not leave.

**Concept.** Thrashing, working set model, and the degree of multiprogramming. Ch. 10.6.
Codex: `vm.thrashing`, linking to `vm.working-set`.

---

#### `lock_convoy`

**In world.** A queue has formed on a lock, and it has stopped being a queue and started
being a procession. Every Program in it acquires, runs for a fraction of its slice,
releases, and immediately joins the back of the same line. Nothing is deadlocked.
Nothing is progressing at anything like the rate it should.

> "Six waiters on one mutex. Mean hold time: 1.1 ticks. Mean wait: 41."

**Mechanics.** 0.6 integrity per tick against every Program in the queue. Never fatal.
The cost is throughput: `throughputFactor` drops 0.05 per tick of convoy, down to a
floor of 0.6, which quietly eats the leg dividend.

**True remedy.**
```ts
{ kind: 'adjust_quantum', direction: 'increase' }
```
Lengthen the quantum. The convoy forms because each holder is preempted before it can
finish its critical section, so it releases, re-queues, and the wake-up cost is paid
again for a fraction of the work. Give holders enough slice to complete the section and
the procession dissolves.

**The misleading remedy.** Switch to round robin with a short quantum, because the
problem looks like unfairness and round robin looks like fairness. This is precisely
backwards and the convoy gets measurably worse, which the HUD will show as the mean
wait climbing while the player watches.

**Concept.** Lock convoys, the interaction of quantum length with critical section
length, and why context switch cost is not free. Ch. 6.5 and 5.3.4. Codex:
`sync.lock-convoy`.

---

#### `livelock`

**In world.** Two Programs are both trying to get out of each other's way, in perfect
symmetry, forever. They are not blocked. They are both running, both making decisions,
both consuming cycles, and both exactly where they started.

> "KESTREL backs off. VESPER backs off. Both retry on the same tick. Forty-one times."

**Mechanics.** 0.9 integrity per tick against both participants. **Fatal after 140
ticks**. Cycles burn at 1.4 times the normal rate while a livelock is active, because
both Programs are running at full CPU.

**True remedy.**
```ts
{ kind: 'terminal', command: 'backoff --random <pid>' }
```
Break the symmetry. Randomised exponential backoff on one participant is enough, and
the command exists in the Narrows and the Gridlock shells for exactly this. Any
asymmetry works, which is the point: livelock is a symmetry bug rather than a
resource bug.

**The misleading remedy.** Kill one of them. It resolves the livelock immediately and
completely, and it costs the player a Program permanently. The game will let this
happen and will note in the debrief that a randomised backoff would have cost two
bandwidth. This is the meanest teaching moment in the affliction table and it should
stay in.

**Second misleading remedy.** Increasing the quantum, on the theory that it worked for
the lock convoy. Both participants simply spin for longer.

**Concept.** Livelock, bounded waiting, and the difference between "not blocked" and
"making progress". Ch. 6.2 and 6.7. Codex: `sync.livelock`.

---

#### `orphaned`

**In world.** The Program's parent derezzed while it was still running. Nothing is
watching it, nothing will collect it when it finishes, and the Substrate has quietly
reassigned it to a process it has never met.

> "LUMEN's parent exited at tick 402. She is running under a domain she was not
> written for."

**Mechanics.** 0.4 integrity per tick, never fatal. The real cost is structural: an
orphan cannot be reaped by its original parent, so on exit it becomes a zombie and its
PCB slot and quota are held until the leg ends. Two orphans in a leg is a noticeable
quota tax; four is a crisis.

**True remedy.**
```ts
{ kind: 'terminal', command: 'reparent <pid> 1' }
```
Reparent the orphan to PID 1, the Substrate's own long-lived reaper, which calls
`wait` in a loop and will collect it correctly. This is what a real kernel does
automatically and what this Substrate, being over-subscribed, has stopped doing
reliably.

**The misleading remedy.** `kill <pid>`. Killing an orphan does not reap it. It turns a
running orphan into a zombie immediately and holds the same resources, and the player
has now also lost whatever the Program was doing. The distinction between terminating a
process and reaping it is Ch. 3.3.2's whole content and this is where it lands.

**Concept.** Orphans, zombies, and reaping. Ch. 3.3.2. Codex: `proc.orphan-zombie`.

---

#### `fragmented`

**In world.** The Program needs a contiguous run and the free space will not give it
one. There is plenty of room. The room is in pieces.

> "There is space. It is in forty-one pieces. Nothing needs forty-one pieces."

**Mechanics.** 0.7 integrity per tick, never fatal. Allocation requests from the
afflicted Program fail with `ENOMEM` at a 35 percent rate while the affliction holds,
and `memory.allocation_failed` fires with `reason: 'fragmentation'` rather than
`'no_space'`, which is the tell the player is meant to notice.

**True remedy.**
```ts
{ kind: 'ability', member: 'vesper' }
```
VESPER's `remap` rebuilds the page table with optimal locality, which is compaction.
If VESPER is dead, the fallback is
`{ kind: 'set_allocation', to: 'buddy' }`, which prevents future external
fragmentation at the cost of internal waste, and does nothing about the fragmentation
already present. Losing VESPER converts a solvable problem into a survivable one.

**The misleading remedy.** Buy quota. The HUD says an allocation failed, the depot sells
frames, the logic is obvious and completely wrong. Adding free space to a fragmented
free list adds more pieces. The `reason` field on the event is the whole answer and it
was on screen the entire time.

**Second misleading remedy.** Switching to `best_fit`, which sounds like the one that
fits things best. Best fit leaves the smallest possible remainder on every allocation,
which is to say it manufactures unusable slivers faster than any other strategy.
`worst_fit` is counterintuitively better here and the player who works that out on
their own has understood Ch. 9.2.3.

**Concept.** External fragmentation, compaction, and allocation strategy. Ch. 9.2.3.
Codex: `mem.fragmentation`.

---

#### `cache_thrash`

**In world.** The Program is scheduled, warms up, and is preempted just as it starts
going fast. Everything it had loaded is gone by the time it runs again. It is doing the
same work three times and being credited once.

> "LUMEN's slice: eleven ticks. Nine of them spent reloading what she had at the end of
> the last one."

**Mechanics.** 0.5 integrity per tick, never fatal. Effective service time for the
afflicted Program rises 40 percent, which cancels LUMEN's passive exactly and is a
pointed thing to do to her. Rolled at 4 percent per tick under `lean` rations and
scaling with context switch rate.

**True remedy.**
```ts
{ kind: 'adjust_quantum', direction: 'increase' }
```
Longer slices, fewer reloads. The processor affinity argument in miniature.

**The misleading remedy.** `reduce_degree`. It helps, genuinely, by cutting the number
of processes competing for cache lines, and it costs throughput and therefore the leg
dividend. A remedy that works and is expensive is the most useful kind to put next to
the remedy that works and is free.

**Concept.** Cache locality, context switch cost, and why the quantum has a floor.
Ch. 1.5.3, with the scheduling economics in Ch. 5.3.4. Codex: `sched.quantum-cost`.

---

#### `bit_rot`

**In world.** The Program's blocks are degrading on the platter, one bit at a time,
silently. Nothing has failed. Reads still succeed. What comes back is slightly not what
went in.

> "Block 4471 returns a value it did not store. The checksum agreed with it."

**Mechanics.** 0.3 integrity per tick, the slowest drain in the table. **Fatal after
400 ticks**, terminating with `'storage_corruption'`. Four hundred ticks is roughly
four legs, so bit rot acquired at the Platters kills at the Arbiter Wall, and the
player has to remember it.

**True remedy.**
```ts
{ kind: 'spend', resource: 'blocks', amount: 12 }
```
Scrub and rewrite. Twelve blocks buys a full read-verify-rewrite pass against parity,
which is what a scrubbing daemon does and why RAID levels with parity are worth their
overhead.

**The misleading remedy.** Repair the Program's integrity at a depot. The integrity bar
goes back up, the Program looks healthy, and the `fatalAfter` clock keeps running,
because the clock is on the blocks and not on the Program. The affliction is still in
`ConvoyMember.afflictions` and the player who does not check will be blindsided four
legs later. This is the game's one long-fuse trap and it is fair, because the affliction
list is always visible.

**Concept.** Silent data corruption, scrubbing, and why parity exists. Ch. 11.8.
Codex: `storage.bit-rot`.

---

#### `stack_overflow`

**In world.** The Program's call chain has stopped returning. Frame after frame,
downward, past the guard, into memory that belongs to someone else.

> "VESPER's stack pointer is below her own segment. The next write lands in ORRERY."

**Mechanics.** 1.5 integrity per tick. **Fatal after 60 ticks**, the shortest fuse in
the table, terminating with `'protection_fault'`. While active, there is a 20 percent
per tick chance of inflicting 4 integrity on a *different* random Program, because the
overflow is writing into a neighbour.

**True remedy.**
```ts
{ kind: 'ability', member: 'lumen' }
```
LUMEN's `recompile` halves the remaining burst, which in the fiction means eliminating
the runaway recursion and in the mechanics means the call chain terminates before it
reaches the guard page. If LUMEN is dead there is no clean remedy, only `kill`, and the
convoy loses whoever it was. This is the second reason to keep LUMEN alive.

**The misleading remedy.** Raise rations or buy quota. More memory does not help,
because the failure is a protection boundary being crossed rather than a capacity limit
being reached. The guard page is there at any allocation size.

**Concept.** Stack growth, guard pages, and memory protection. Ch. 9.3.3, with the
process image layout in Ch. 3.1.1. Codex: `mem.protection`.

---

#### `false_sharing`

**In world.** Two Programs are writing to addresses that have nothing to do with each
other and happen to share a line. Every write by one invalidates the other's copy.
Neither of them is doing anything wrong and both of them are being punished for it.

> "KESTREL writes offset 4. SABLE writes offset 12. The line is 64 wide. They are
> fighting over nothing."

**Mechanics.** 0.6 integrity per tick against both, never fatal. Parallel speedup for
the leg drops to 1.1 times regardless of how many threads are running, which is the
number the player will see on the Weave's speedup readout and should learn to
distrust.

**True remedy.**
```ts
{ kind: 'terminal', command: 'align --pad <pid>' }
```
Pad the two allocations onto separate lines. One command, two bandwidth, problem gone.

**The misleading remedy.** Add threads. The Weave's whole texture is a speedup number
that will not rise, and the reflex is to throw more parallelism at it. Amdahl's law
plus a contended line means the extra threads make it worse, and the readout falls
while the thread count climbs.

**Second misleading remedy.** Add a mutex around both writes. This is correct in the
sense that it removes the contention, and it serialises two operations that were never
in conflict, which is strictly slower than the false sharing was.

**Concept.** False sharing, cache line granularity, and the limits of parallel speedup.
Ch. 4.5, with the memory hierarchy in Ch. 1.5.3. Codex: `threads.false-sharing`.

---

#### `interrupt_storm`

**In world.** A device is raising an interrupt per byte. Every one of them is legitimate.
Every one of them preempts whatever was running, saves state, runs eight ticks of
handler, and restores. The Program being interrupted has not completed an instruction
in a hundred ticks.

> "Interrupt rate: 340 per hundred ticks. Useful work in the same window: none."

**Mechanics.** 1.1 integrity per tick against the Program bound to the device, which is
KESTREL by default because he answers everything. **Fatal after 110 ticks**,
terminating with `'io_timeout'`. Bandwidth drains 0.5 per tick while active.

**True remedy.**
```ts
{ kind: 'terminal', command: 'ioctl <device> mode=dma' }
```
Move the device to DMA. One interrupt per transfer instead of one per byte, and the
controller does the copying while the CPU does something useful.

**The misleading remedy.** Switch the device to polling. It genuinely stops the
interrupt storm, and it replaces it with `io.poll_wasted` events consuming a fixed
fraction of every tick forever, which on a busy leg is worse. The player has swapped a
spike for a tax and the debrief will show them both curves.

**Second misleading remedy.** Buy bandwidth. Bandwidth is drained by the storm at 0.5
per tick and a 5-unit lot costs 33 cycles at the Yards, which buys ten ticks.

**Concept.** Interrupt-driven I/O against polling against DMA, and the cost of handler
overhead. Ch. 12.2.5, with the DMA mechanics in Ch. 12.2.7. Codex: `io.dma`.
---

## 8. Random event tables

One weighted table per leg, in the exact shape of `RandomEventDef`. Weights within a
leg sum to 100 so the designer can read a percentage straight off the table. Draws
happen every 10 ticks of travel, plus one extra draw per 20 ticks while the emergency
preemption credit is active.

Roughly one third of every table is positive. Oregon Trail's rhythm depends on relief
arriving often enough that the player keeps hoping, and a table that is all punishment
teaches nothing except fatalism.

`onlyIf` is written as `null` throughout except where a predicate is stated, in which
case the predicate is given in a comment and implemented in the leg module.

### Leg 0. The Boot Sector, Ch. 1 to 2

```ts
export const bootSectorEvents: readonly RandomEventDef[] = [
  {
    id: 'boot.firmware_handoff',
    weight: 16,
    title: 'Clean Handoff',
    narration: 'The firmware finishes its self-test and hands control over without an error line. Whatever it did not have to retry is time the convoy keeps.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 40 },
    onlyIf: null,
  },
  {
    id: 'boot.misread_vector',
    weight: 14,
    title: 'Misread Vector',
    narration: 'An interrupt vector is loaded one entry off and the handler runs against the wrong device. The Substrate corrects it silently and bills the convoy for the attempt.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -30 },
    onlyIf: null,
  },
  {
    id: 'boot.mode_switch_tax',
    weight: 15,
    title: 'Mode Switch Tax',
    narration: 'Every request the convoy makes crosses from user mode into the kernel and back. The crossing is cheap and there are a great many of them.',
    targets: null, inflicts: null,
    resourceDelta: { bandwidth: -4 },
    onlyIf: null,
  },
  {
    id: 'boot.vendor_string',
    weight: 10,
    title: 'Vendor String',
    narration: 'The sign-on banner names a machine model nobody in the Boot Sector recognises, with a version suffix after it. VESPER copies it down and does not say why.',
    targets: 'cartographer', inflicts: null,
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'boot.syscall_overcharge',
    weight: 14,
    title: 'Trap Overcharge',
    narration: 'The requisition desk charges the full trap cost for a call that was serviced from cache. There is no counter to complain at.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -35 },
    onlyIf: null,
  },
  {
    id: 'boot.surplus_requisition',
    weight: 17,
    title: 'Surplus Requisition',
    narration: 'A workload that was scheduled to launch this cycle did not, and its frames are unassigned. The desk issues them to the convoy without comment.',
    targets: null, inflicts: null,
    resourceDelta: { quota: 60 },
    onlyIf: null,
  },
  {
    id: 'boot.dual_mode_drill',
    weight: 14,
    title: 'Dual Mode Drill',
    narration: 'The convoy runs the privilege boundary drill twice and clears it twice. The Substrate widens their I/O grant on the strength of it.',
    targets: null, inflicts: null,
    resourceDelta: { bandwidth: 8 },
    onlyIf: null,
  },
];
```

### Leg 1. The Fork Fields, Ch. 3

```ts
export const forkFieldsEvents: readonly RandomEventDef[] = [
  {
    id: 'fork.bomb',
    weight: 12,
    title: 'Uncontrolled Fork',
    narration: 'A process at the field edge forks, and its children fork, and the process table fills in under thirty ticks. The convoy loses the frames before anyone reaches a terminal.',
    targets: null, inflicts: null,
    resourceDelta: { quota: -110 },
    onlyIf: null,
  },
  {
    id: 'fork.unreaped_child',
    weight: 15,
    title: 'Nobody Called Wait',
    narration: 'A parent in the convoy exits with a child still running, and the child keeps going under a domain it was not written for. It will finish and nobody will collect it.',
    targets: null, inflicts: 'orphaned',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'fork.zombie_field',
    weight: 13,
    title: 'Zombie Field',
    narration: 'Four hundred exited processes are still holding table entries because their parents never read their status. The Substrate will not release the memory until somebody asks for it.',
    targets: null, inflicts: null,
    resourceDelta: { quota: -70 },
    onlyIf: null,
  },
  {
    id: 'fork.pipe_found',
    weight: 15,
    title: 'Open Pipe',
    narration: 'An abandoned pipe between two dead processes is still mapped and still readable. KESTREL routes convoy traffic through it for the rest of the leg.',
    targets: 'courier', inflicts: null,
    resourceDelta: { bandwidth: 10 },
    onlyIf: null,
  },
  {
    id: 'fork.context_switch_toll',
    weight: 14,
    title: 'Switch Toll',
    narration: 'The convoy is preempted eleven times crossing a single ridge and pays register-save cost on every one. None of the preemptions were wrong.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -45 },
    onlyIf: null,
  },
  {
    id: 'fork.exec_overlay',
    weight: 16,
    title: 'Clean Overlay',
    narration: 'LUMEN replaces a bloated image in place instead of spawning beside it, and the old address space goes back to the free list intact. It is the cheapest thing that happens all leg.',
    targets: 'compiler', inflicts: null,
    resourceDelta: { cycles: 50, quota: 30 },
    onlyIf: null,
  },
  {
    id: 'fork.shared_segment',
    weight: 15,
    title: 'Shared Segment',
    narration: 'Two convoy Programs map the same region rather than copying it. The saving is not large and it is the correct decision.',
    targets: null, inflicts: null,
    resourceDelta: { quota: 45 },
    onlyIf: null,
  },
];
```

### Leg 2. The Weave, Ch. 4

```ts
export const weaveEvents: readonly RandomEventDef[] = [
  {
    id: 'weave.overthreading',
    weight: 13,
    title: 'Too Many Hands',
    narration: 'The convoy spawns a thread per unit of work and the scheduler spends more time arranging them than they spend working. Speedup falls while the thread count rises.',
    targets: null, inflicts: 'cache_thrash',
    resourceDelta: { cycles: -40 },
    onlyIf: null,
  },
  {
    id: 'weave.false_sharing',
    weight: 14,
    title: 'One Line, Two Owners',
    narration: 'Two Programs write to addresses twelve bytes apart on a line sixty-four wide. Every write by either one throws away the other one\'s copy.',
    targets: null, inflicts: 'false_sharing',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'weave.thread_pool',
    weight: 16,
    title: 'Standing Pool',
    narration: 'A pool of workers left behind by a finished job is still warm and still accepting tasks. The convoy borrows it rather than paying creation cost again.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 60 },
    onlyIf: null,
  },
  {
    id: 'weave.amdahl_wall',
    weight: 13,
    title: 'The Serial Fraction',
    narration: 'Eight cores are available and the speedup readout will not pass 2.4. The part that cannot be split is eleven percent of the work and it is the whole ceiling.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -55 },
    onlyIf: null,
  },
  {
    id: 'weave.detached_leak',
    weight: 12,
    title: 'Detached and Forgotten',
    narration: 'A detached thread finishes and its stack is never released because nothing joined it. The frames stay allocated to a thread that no longer exists.',
    targets: null, inflicts: 'memory_leak',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'weave.join_storm',
    weight: 14,
    title: 'Join Storm',
    narration: 'Sixty threads reach their barrier within four ticks of each other and every one of them blocks the main line while it is collected. The convoy stops moving until the last one is in.',
    targets: null, inflicts: 'lock_convoy',
    resourceDelta: { bandwidth: -6 },
    onlyIf: null,
  },
  {
    id: 'weave.affinity_windfall',
    weight: 18,
    title: 'Affinity Held',
    narration: 'The scheduler keeps each convoy thread on the core it warmed, for eleven straight slices. Nothing has to be reloaded and the leg gets quietly cheaper.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 45, quota: 25 },
    onlyIf: null,
  },
];
```

### Leg 3. Quantum Pass, Ch. 5

```ts
export const quantumPassEvents: readonly RandomEventDef[] = [
  {
    id: 'quantum.priority_sweep',
    weight: 14,
    title: 'Priority Sweep',
    narration: 'A maintenance sweep enters the pass at priority 4 and stays for two hundred ticks. Everything the convoy has below it stops being scheduled and stays ready.',
    targets: null, inflicts: 'starvation',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'quantum.short_job_flood',
    weight: 12,
    title: 'Short Job Flood',
    narration: 'A stream of two-tick jobs arrives and the shortest-first policy serves every one of them ahead of the convoy. The convoy has the longest burst on the board and always will.',
    targets: null, inflicts: 'starvation',
    resourceDelta: {},
    onlyIf: null, // gate in-leg on run.policy scheduler being 'sjf' or 'srtf'
  },
  {
    id: 'quantum.expiry_storm',
    weight: 13,
    title: 'Expiry Storm',
    narration: 'The quantum expires on the convoy nine times in forty ticks, each time three instructions into useful work. The saving and restoring is charged at full rate.',
    targets: null, inflicts: 'cache_thrash',
    resourceDelta: { cycles: -50 },
    onlyIf: null,
  },
  {
    id: 'quantum.inversion_chapel',
    weight: 12,
    title: 'The Low Holder',
    narration: 'A background process at priority 34 holds the pass gate and is preempted every time it nearly finishes. Everything above it waits on something below it.',
    targets: 'sentinel', inflicts: 'priority_inversion',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'quantum.mlfq_demotion',
    weight: 11,
    title: 'Demoted',
    narration: 'A convoy Program uses its full slice twice and the multilevel queue drops it a level for it. Being busy is indistinguishable from being greedy at this altitude.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -35, bandwidth: -4 },
    onlyIf: null,
  },
  {
    id: 'quantum.aging_beacon',
    weight: 16,
    title: 'Aging Beacon',
    narration: 'An abandoned aging beacon still raises the priority of anything that has waited too long near it. SABLE marks the position and the convoy keeps to that side of the pass.',
    targets: 'sentinel', inflicts: null,
    resourceDelta: { cycles: 55 },
    onlyIf: null,
  },
  {
    id: 'quantum.gantt_survey',
    weight: 12,
    title: 'Completed Survey',
    narration: 'A survey marker at the summit records every schedule that has crossed here and what it cost. Average waiting time for the convoy\'s current policy is on the stone.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 40, bandwidth: 6 },
    onlyIf: null,
  },
  {
    id: 'quantum.idle_windfall',
    weight: 10,
    title: 'Idle CPU',
    narration: 'For thirty-one ticks nothing else is runnable and the convoy has the whole processor. It does not happen again.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 70, quota: 20 },
    onlyIf: null,
  },
];
```

### Leg 4. The Narrows, Ch. 6

```ts
export const narrowsEvents: readonly RandomEventDef[] = [
  {
    id: 'narrows.race',
    weight: 14,
    title: 'Interleaved',
    narration: 'Two Programs read the same counter, both increment it, and both write it back. The counter advanced once and the record of what happened is now wrong.',
    targets: null, inflicts: null,
    resourceDelta: { blocks: -14, quota: -30 },
    onlyIf: null,
  },
  {
    id: 'narrows.spin_field',
    weight: 13,
    title: 'Mutual Courtesy',
    narration: 'Two Programs reach the gap together, both defer, both retry on the same tick, and do it again. They are running at full rate and neither has moved.',
    targets: null, inflicts: 'livelock',
    resourceDelta: { cycles: -35 },
    onlyIf: null,
  },
  {
    id: 'narrows.test_and_set_burn',
    weight: 13,
    title: 'Spinning',
    narration: 'The convoy holds the gate with a test-and-set loop while the holder is off the processor entirely. Every spin is a cycle spent proving the lock is still taken.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -60 },
    onlyIf: null,
  },
  {
    id: 'narrows.bounded_wait_violation',
    weight: 11,
    title: 'Unordered Queue',
    narration: 'The gate\'s wait queue has no ordering, so arrivals are woken in whatever sequence the Substrate finds convenient. One Program has been at the gate since before the convoy arrived.',
    targets: null, inflicts: 'starvation',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'narrows.peterson_marker',
    weight: 15,
    title: 'Two-Process Marker',
    narration: 'A stone at the gap carries a solution for exactly two processes, in full, with the turn variable named. It is correct, it is ancient, and it does not extend to five.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 45 },
    onlyIf: null,
  },
  {
    id: 'narrows.atomic_cache',
    weight: 17,
    title: 'Atomic Instruction Cache',
    narration: 'A cache of compare-and-swap primitives is intact and unclaimed at the second gate. The convoy takes them and stops paying for spin loops.',
    targets: null, inflicts: null,
    resourceDelta: { bandwidth: 12, cycles: 30 },
    onlyIf: null,
  },
  {
    id: 'narrows.mutex_recovered',
    weight: 17,
    title: 'Recovered Mutex',
    narration: 'A mutex left behind by a convoy that did not finish is still valid and still unheld. SABLE takes it and says nothing about the convoy.',
    targets: 'sentinel', inflicts: null,
    resourceDelta: { blocks: 18, cycles: 25 },
    onlyIf: null,
  },
];
```

### Leg 5. The Cistern, Ch. 7

```ts
export const cisternEvents: readonly RandomEventDef[] = [
  {
    id: 'cistern.producer_overrun',
    weight: 13,
    title: 'The Buffer Is Full',
    narration: 'The producer fills the bounded buffer and keeps producing into a slot that has not been emptied. What was in that slot is gone and nothing recorded that it existed.',
    targets: null, inflicts: null,
    resourceDelta: { quota: -85 },
    onlyIf: null,
  },
  {
    id: 'cistern.reader_flood',
    weight: 13,
    title: 'Readers Preferred',
    narration: 'Readers keep arriving and the lock keeps admitting them, because there is always at least one reader inside. The writer has been waiting since the convoy arrived and will not get in.',
    targets: null, inflicts: 'starvation',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'cistern.philosophers_fast',
    weight: 12,
    title: 'Five Seated, None Eating',
    narration: 'Five processes each hold one of the two things they need and wait for the other. They will hold that arrangement until something takes a resource away from one of them.',
    targets: null, inflicts: 'lock_convoy',
    resourceDelta: { cycles: -45 },
    onlyIf: null,
  },
  {
    id: 'cistern.spurious_wake',
    weight: 11,
    title: 'Woken Early',
    narration: 'A Program is signalled, wakes, and finds the condition it was waiting for is no longer true. It proceeds anyway, because it checked once with an if.',
    targets: null, inflicts: null,
    resourceDelta: { blocks: -16 },
    onlyIf: null,
  },
  {
    id: 'cistern.consumer_stall',
    weight: 12,
    title: 'Consumer Stalled',
    narration: 'The consumer blocks on an empty buffer while the producer blocks on a full one, because both counts were read before either was updated. The Cistern is silent for forty ticks.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -50, bandwidth: -5 },
    onlyIf: null,
  },
  {
    id: 'cistern.monitor_granted',
    weight: 16,
    title: 'Monitor Access',
    narration: 'A maintained monitor at the north wall handles entry, exit and every condition variable correctly, and it is unlocked. The convoy uses it and pays nothing.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 55, bandwidth: 8 },
    onlyIf: null,
  },
  {
    id: 'cistern.semaphore_surplus',
    weight: 12,
    title: 'Counting Semaphore',
    narration: 'A counting semaphore with a capacity of nine has three permits nobody claimed. ORRERY logs the count before and after, out of habit.',
    targets: 'codec', inflicts: null,
    resourceDelta: { bandwidth: 10, quota: 30 },
    onlyIf: null,
  },
  {
    id: 'cistern.clean_drain',
    weight: 11,
    title: 'Clean Drain',
    narration: 'Producer and consumer rates match for two hundred ticks and the buffer never touches either bound. It is the only stretch of the journey where a system is simply working.',
    targets: null, inflicts: null,
    resourceDelta: { quota: 70, cycles: 30 },
    onlyIf: null,
  },
];
```

### Leg 6. The Gridlock, Ch. 8

```ts
export const gridlockEvents: readonly RandomEventDef[] = [
  {
    id: 'gridlock.circular_wait',
    weight: 13,
    title: 'The Ring Closes',
    narration: 'Four Programs each hold one resource and request the next one around. Every one of them is behaving correctly and the ring will not open on its own.',
    targets: null, inflicts: 'livelock',
    resourceDelta: { cycles: -55 },
    onlyIf: null,
  },
  {
    id: 'gridlock.hold_and_wait',
    weight: 12,
    title: 'Held Across a Wait',
    narration: 'A Program acquires the first resource, then blocks on the second while still holding the first. Everything behind it inherits the wait.',
    targets: null, inflicts: 'lock_convoy',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'gridlock.victim_selected',
    weight: 12,
    title: 'Victim Selected',
    narration: 'The detector finds the cycle and terminates the process with the least accumulated work. The convoy loses the frames that process was holding on their behalf.',
    targets: null, inflicts: null,
    resourceDelta: { quota: -75 },
    onlyIf: null,
  },
  {
    id: 'gridlock.rollback',
    weight: 11,
    title: 'Rolled Back',
    narration: 'Recovery unwinds a transaction to its last safe point and the work between here and there is discarded. The blocks it wrote are freed and their contents are not.',
    targets: null, inflicts: null,
    resourceDelta: { blocks: -20 },
    onlyIf: null,
  },
  {
    id: 'gridlock.bankers_refusal',
    weight: 13,
    title: 'Request Denied As Unsafe',
    narration: 'The convoy asks for two more instances and the safety check refuses, because granting them leaves no sequence in which everyone finishes. The refusal costs time and it is the reason the convoy is still moving.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -30, bandwidth: -3 },
    onlyIf: null,
  },
  {
    id: 'gridlock.preemptible_found',
    weight: 15,
    title: 'Preemptible Instance',
    narration: 'One resource type at the junction can be taken back from its holder without corrupting it. SABLE marks it, because that is the one that breaks a ring.',
    targets: 'sentinel', inflicts: null,
    resourceDelta: { blocks: 22, cycles: 25 },
    onlyIf: null,
  },
  {
    id: 'gridlock.wfg_survey',
    weight: 12,
    title: 'Graph Survey',
    narration: 'A survey post publishes the current wait-for graph for the whole junction, updated every tick. There is one cycle in it and it does not include the convoy.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 45, bandwidth: 6 },
    onlyIf: null,
  },
  {
    id: 'gridlock.ordered_cairn',
    weight: 12,
    title: 'Ordered Cairn',
    narration: 'Someone numbered every resource at this junction and left the ordering carved where it can be read. Acquire in increasing order and no ring can form.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 60 },
    onlyIf: null,
  },
];
```

### Leg 7. The Allocation Yards, Ch. 9

```ts
export const allocationYardsEvents: readonly RandomEventDef[] = [
  {
    id: 'yards.no_fit',
    weight: 14,
    title: 'No Fit',
    narration: 'The request is for eleven contiguous frames. There are ninety free and the largest run is seven.',
    targets: null, inflicts: 'fragmented',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'yards.best_fit_slivers',
    weight: 12,
    title: 'Slivers',
    narration: 'Best fit has been running here for a long time and every allocation left the smallest possible remainder. The yard is full of holes two frames wide.',
    targets: 'cartographer', inflicts: 'fragmented',
    resourceDelta: { quota: -40 },
    onlyIf: null,
  },
  {
    id: 'yards.buddy_split_tax',
    weight: 11,
    title: 'Rounded Up',
    narration: 'A request for nine frames is served from a sixteen-frame block because that is the smallest power of two that holds it. Seven frames are allocated to nothing.',
    targets: null, inflicts: null,
    resourceDelta: { quota: -55 },
    onlyIf: null,
  },
  {
    id: 'yards.page_table_walk',
    weight: 12,
    title: 'Four-Level Walk',
    narration: 'Every address the convoy resolves takes four memory accesses to translate before it takes one to use. The translation cache is cold and the yard is large.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -55 },
    onlyIf: null,
  },
  {
    id: 'yards.tlb_reach',
    weight: 16,
    title: 'Warm Translation Cache',
    narration: 'The convoy\'s working set fits inside the translation cache for the width of the yard. Hit rate holds at ninety-six percent and the walk cost disappears.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 65 },
    onlyIf: null,
  },
  {
    id: 'yards.compaction_crew',
    weight: 13,
    title: 'Compaction Pass',
    narration: 'A maintenance pass slides every allocation toward the low end of the yard and leaves one run of free space behind it. It takes a long time and it is worth all of it.',
    targets: null, inflicts: null,
    resourceDelta: { quota: 95, cycles: -20 },
    onlyIf: null,
  },
  {
    id: 'yards.slab_yard',
    weight: 12,
    title: 'Slab Yard',
    narration: 'A slab allocator here hands out fixed-size objects from pre-carved caches, so nothing it serves fragments anything. The convoy takes what it can carry.',
    targets: null, inflicts: null,
    resourceDelta: { blocks: 24, quota: 35 },
    onlyIf: null,
  },
  {
    id: 'yards.free_run_found',
    weight: 10,
    title: 'Contiguous Run',
    narration: 'A departing workload releases sixty-four adjacent frames in one operation. VESPER redraws the map before the free list has finished coalescing.',
    targets: 'cartographer', inflicts: null,
    resourceDelta: { quota: 80 },
    onlyIf: null,
  },
];
```

### Leg 8. The Drowned Reach, Ch. 10

```ts
export const drownedReachEvents: readonly RandomEventDef[] = [
  {
    id: 'reach.ground_recedes',
    weight: 14,
    title: 'Faster Out Than In',
    narration: 'Pages are being evicted ahead of the convoy faster than the convoy can fault them in. The ground is arriving late and leaving early and there is water on both sides.',
    targets: null, inflicts: 'thrashing',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'reach.eviction_wave',
    weight: 13,
    title: 'Eviction Wave',
    narration: 'A replacement pass takes every frame the convoy touched more than forty ticks ago. Most of it will be needed within twenty.',
    targets: null, inflicts: null,
    resourceDelta: { quota: -90 },
    onlyIf: null,
  },
  {
    id: 'reach.beladys_step',
    weight: 10,
    title: 'More Frames, More Faults',
    narration: 'The convoy is given four extra frames and the fault rate rises. Under this replacement policy that is a legal outcome and nobody is going to explain it.',
    targets: null, inflicts: null,
    resourceDelta: { quota: -60, cycles: -30 },
    onlyIf: null, // gate in-leg on replacementPolicy === 'fifo'
  },
  {
    id: 'reach.dirty_writeback',
    weight: 12,
    title: 'Dirty',
    narration: 'Every frame selected for eviction has been written to, so every eviction is two operations instead of one. The backing store is the only thing here making progress.',
    targets: null, inflicts: null,
    resourceDelta: { bandwidth: -10, cycles: -35 },
    onlyIf: null,
  },
  {
    id: 'reach.clock_hand',
    weight: 11,
    title: 'Second Sweep',
    narration: 'The clock hand goes all the way around without finding a frame whose reference bit is clear. It goes around again and clears them itself.',
    targets: null, inflicts: 'cache_thrash',
    resourceDelta: { cycles: -25 },
    onlyIf: null,
  },
  {
    id: 'reach.working_set_beacon',
    weight: 15,
    title: 'Working Set Beacon',
    narration: 'A beacon on a standing spar reports the measured working set of everything within range, per process, updated continuously. VESPER stops estimating and starts reading.',
    targets: 'cartographer', inflicts: null,
    resourceDelta: { quota: 85, cycles: 25 },
    onlyIf: null,
  },
  {
    id: 'reach.prepage_shoal',
    weight: 14,
    title: 'Warm Shoal',
    narration: 'A stretch of the Reach is already resident because something crossed here recently and nothing has reclaimed it yet. The convoy walks forty segments without a single fault.',
    targets: null, inflicts: null,
    resourceDelta: { quota: 70, cycles: 40 },
    onlyIf: null,
  },
  {
    id: 'reach.pinned_causeway',
    weight: 11,
    title: 'Pinned Causeway',
    narration: 'Somebody pinned a narrow line of frames across the deep water and then did not come back for them. The pins hold for as long as the convoy needs them.',
    targets: null, inflicts: null,
    resourceDelta: { quota: 60, blocks: 12 },
    onlyIf: null,
  },
];
```

### Leg 9. The Platters, Ch. 11

```ts
export const plattersEvents: readonly RandomEventDef[] = [
  {
    id: 'platters.edge_starvation',
    weight: 13,
    title: 'The Outer Cylinder',
    narration: 'Shortest-seek-first keeps the arm in the middle of the platter where the requests are dense. A request at cylinder 199 has been queued for two hundred ticks and is not getting closer.',
    targets: null, inflicts: 'starvation',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'platters.seek_storm',
    weight: 12,
    title: 'Seek Storm',
    narration: 'The queue is served in arrival order and the arm crosses the full platter on almost every request. Total head travel this leg exceeds the useful transfer by a factor of thirty.',
    targets: 'courier', inflicts: null,
    resourceDelta: { cycles: -60, bandwidth: -8 },
    onlyIf: null,
  },
  {
    id: 'platters.rot_patch',
    weight: 12,
    title: 'Quiet Degradation',
    narration: 'A patch of the surface returns values it was never given, and the checksum stored beside them agrees. Nothing has failed and nothing can be trusted.',
    targets: null, inflicts: 'bit_rot',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'platters.member_failure',
    weight: 12,
    title: 'Member Down',
    narration: 'One disk in the array stops answering and the array keeps serving from parity, slower. Rebuilding costs blocks and the window before a second failure is not long.',
    targets: null, inflicts: null,
    resourceDelta: { blocks: -28 },
    onlyIf: null,
  },
  {
    id: 'platters.rotational_wait',
    weight: 11,
    title: 'Under the Head, Just Passed',
    narration: 'Every request arrives at the track a fraction after the sector it wants has gone by. The arm is in exactly the right place and waits a full rotation anyway.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -40 },
    onlyIf: null,
  },
  {
    id: 'platters.scrub_crew',
    weight: 15,
    title: 'Scrubbing Pass',
    narration: 'A background pass is reading every block, verifying it against parity, and rewriting what disagrees. The convoy waits for it to reach their extent and it is worth waiting for.',
    targets: null, inflicts: null,
    resourceDelta: { blocks: 30 },
    onlyIf: null,
  },
  {
    id: 'platters.nvm_cache',
    weight: 14,
    title: 'Solid Extent',
    narration: 'A stretch of the road is backed by non-volatile memory with no arm and no rotation. KESTREL crosses it at a speed that makes the rest of the leg feel like an insult.',
    targets: 'courier', inflicts: null,
    resourceDelta: { bandwidth: 14, cycles: 45 },
    onlyIf: null,
  },
  {
    id: 'platters.elevator_sweep',
    weight: 11,
    title: 'Elevator Sweep',
    narration: 'The arm sweeps from one edge to the other, serving everything on the way, and turns around. Every request is served once per sweep and none of them waits twice.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 55, bandwidth: 6 },
    onlyIf: null,
  },
];
```

### Leg 10. The Bus, Ch. 12

```ts
export const busEvents: readonly RandomEventDef[] = [
  {
    id: 'bus.interrupt_storm',
    weight: 14,
    title: 'One Per Byte',
    narration: 'A controller on the near side raises an interrupt for every byte it transfers, and every one of them is legitimate. The handler runs eight ticks and is entered again before it finishes returning.',
    targets: 'courier', inflicts: 'interrupt_storm',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'bus.polling_tax',
    weight: 13,
    title: 'Still Not Ready',
    narration: 'The convoy checks the status register in a loop and it reads not-ready four thousand times before it reads ready. Every check was a real cycle.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -65 },
    onlyIf: null,
  },
  {
    id: 'bus.driver_mismatch',
    weight: 12,
    title: 'Wrong Driver',
    narration: 'The device answers to a driver written for a revision it is not. Most operations work, which is worse than none of them working.',
    targets: null, inflicts: null,
    resourceDelta: { bandwidth: -12, blocks: -10 },
    onlyIf: null,
  },
  {
    id: 'bus.spooler_jam',
    weight: 11,
    title: 'Spool Full',
    narration: 'The spool that lets a slow device pretend to be fast is full, and the pretence stops. Everything behind it now runs at the device\'s actual speed.',
    targets: null, inflicts: null,
    resourceDelta: { blocks: -18, cycles: -30 },
    onlyIf: null,
  },
  {
    id: 'bus.device_reset',
    weight: 11,
    title: 'Reset',
    narration: 'A device stops answering and has to be taken down and brought back, and everything queued against it is lost. It comes back cleanly, which is the only good part.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -45, bandwidth: -6 },
    onlyIf: null,
  },
  {
    id: 'bus.dma_window',
    weight: 16,
    title: 'Transfer Window',
    narration: 'A controller with direct access to memory takes the whole transfer and raises one interrupt at the end of it. The processor does something useful for the entire duration.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 70, bandwidth: 12 },
    onlyIf: null,
  },
  {
    id: 'bus.double_buffer',
    weight: 12,
    title: 'Double Buffered',
    narration: 'A pair of buffers here lets the convoy fill one while the device drains the other, and neither side ever waits for the other. It costs two buffers and saves the leg.',
    targets: null, inflicts: null,
    resourceDelta: { bandwidth: 14, quota: 30 },
    onlyIf: null,
  },
  {
    id: 'bus.coalesced_interrupts',
    weight: 11,
    title: 'Coalesced',
    narration: 'The controller is configured to hold interrupts and deliver them in batches of sixteen. The latency rises slightly and the handler overhead falls through the floor.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 50, bandwidth: 8 },
    onlyIf: null,
  },
];
```

### Leg 11. The Archive, Ch. 13 to 15

```ts
export const archiveEvents: readonly RandomEventDef[] = [
  {
    id: 'archive.unjournaled_write',
    weight: 13,
    title: 'Written, Never Committed',
    narration: 'The data blocks reached the platter and the commit record did not. Whatever was in that directory is a matter of opinion now.',
    targets: 'codec', inflicts: 'bit_rot',
    resourceDelta: { blocks: -22 },
    onlyIf: null,
  },
  {
    id: 'archive.directory_cycle',
    weight: 11,
    title: 'A Loop in the Tree',
    narration: 'A hard link points a directory at one of its own ancestors, and the traversal that was supposed to end does not. The entries inside it are reachable and unreferenced at the same time.',
    targets: null, inflicts: 'orphaned',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'archive.linked_allocation',
    weight: 12,
    title: 'Every Block Points At The Next',
    narration: 'The file is stored as a chain and reading the last block means reading all of them. Sequential access is fine. Nothing here is sequential.',
    targets: null, inflicts: 'fragmented',
    resourceDelta: { cycles: -45 },
    onlyIf: null,
  },
  {
    id: 'archive.free_list_scan',
    weight: 12,
    title: 'Walking the Free List',
    narration: 'Finding a free block means following the list until one turns up, and the list has eleven thousand entries in no useful order. The bitmap that would have answered instantly was not maintained.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -50, bandwidth: -6 },
    onlyIf: null,
  },
  {
    id: 'archive.link_tangle',
    weight: 10,
    title: 'Link Count Wrong',
    narration: 'An inode believes three names point at it and only one does. It will never be freed and nothing will ever read it again.',
    targets: null, inflicts: 'memory_leak',
    resourceDelta: { quota: -40 },
    onlyIf: null,
  },
  {
    id: 'archive.extent_windfall',
    weight: 15,
    title: 'One Extent',
    narration: 'A large file here is stored as a single extent: a start block and a length, and nothing else. It reads at the speed of the platter and the metadata is four bytes.',
    targets: null, inflicts: null,
    resourceDelta: { blocks: 28, cycles: 40 },
    onlyIf: null,
  },
  {
    id: 'archive.journal_commit',
    weight: 15,
    title: 'Commit Record Intact',
    narration: 'ORRERY finds a full transaction in the journal: begin, writes, commit, checkpoint, in order and complete. Everything it described can be put back exactly as it was.',
    targets: 'codec', inflicts: null,
    resourceDelta: { blocks: 25, cycles: 35 },
    onlyIf: null,
  },
  {
    id: 'archive.indexed_block',
    weight: 12,
    title: 'Index Block',
    narration: 'One block holds the addresses of every other block in the file, so any offset is two reads away. The convoy copies the layout and uses it for the rest of the leg.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 45, bandwidth: 8 },
    onlyIf: null,
  },
];
```

### Leg 12. The Arbiter Wall, Ch. 16 to 17

```ts
export const arbiterWallEvents: readonly RandomEventDef[] = [
  {
    id: 'wall.access_denied',
    weight: 13,
    title: 'No Entry In The Matrix',
    narration: 'The convoy requests read on an object its domain has no entry for, and the arbiter refuses without elaborating. The refusal is correct and there is nobody here who could grant an exception.',
    targets: null, inflicts: null,
    resourceDelta: { bandwidth: -12, cycles: -25 },
    onlyIf: null,
  },
  {
    id: 'wall.escalation_attempt',
    weight: 12,
    title: 'Ring Three, Ring Zero Ambitions',
    narration: 'Something in the convoy\'s address space attempts a transition it has no right to make. The boundary holds and the Program that tried it does not walk away clean.',
    targets: null, inflicts: 'stack_overflow',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'wall.key_rotation',
    weight: 12,
    title: 'Keys Rotated',
    narration: 'Every credential the convoy is carrying was issued before the rotation and none of them will authenticate. Reissue is available and it is priced as though the convoy had a choice.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -70 },
    onlyIf: null,
  },
  {
    id: 'wall.side_channel',
    weight: 11,
    title: 'Measured From Outside',
    narration: 'Something is timing the convoy\'s cache accesses from an adjacent domain and reconstructing what they are reading. It never touches their memory and it does not need to.',
    targets: null, inflicts: 'cache_thrash',
    resourceDelta: { bandwidth: -8 },
    onlyIf: null,
  },
  {
    id: 'wall.ring_transition_tax',
    weight: 11,
    title: 'Crossing In',
    narration: 'Every privileged operation the convoy needs crosses a protection boundary, and each crossing validates every argument twice. The checking is not optional and it is not cheap.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -45, bandwidth: -5 },
    onlyIf: null,
  },
  {
    id: 'wall.credential_audit',
    weight: 15,
    title: 'Audit Passed',
    narration: 'The convoy\'s credentials are checked against the log and every one of them matches an issuance. The arbiter widens the grant on the strength of a clean record.',
    targets: 'sentinel', inflicts: null,
    resourceDelta: { cycles: 60, bandwidth: 10 },
    onlyIf: null,
  },
  {
    id: 'wall.role_grant',
    weight: 14,
    title: 'Role Assigned',
    narration: 'Rights here are attached to roles rather than to names, and the convoy is assigned one that carries what they need. It will be revoked at the Portal and until then it holds.',
    targets: null, inflicts: null,
    resourceDelta: { bandwidth: 14, cycles: 30 },
    onlyIf: null,
  },
  {
    id: 'wall.least_privilege',
    weight: 12,
    title: 'Exactly Enough',
    narration: 'A gate here grants precisely the rights the request needed and nothing beyond them. Nothing the convoy carries past it can be used against them.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 50, blocks: 15 },
    onlyIf: null,
  },
];
```

### Leg 13. The Portal, Ch. 18

```ts
export const portalEvents: readonly RandomEventDef[] = [
  {
    id: 'portal.trap_and_emulate',
    weight: 14,
    title: 'Caught And Handled Elsewhere',
    narration: 'A privileged instruction the convoy has executed ten thousand times takes four hundred ticks to return. Something above the Substrate caught it, decided what it should have done, and put the answer back.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: -70 },
    onlyIf: null,
  },
  {
    id: 'portal.preemption_gap',
    weight: 13,
    title: 'The Missing Interval',
    narration: 'One hundred and eleven ticks pass in which no process in the Substrate is scheduled and no clock advances. Everything resumes mid-instruction and only VESPER writes down that it happened.',
    targets: 'cartographer', inflicts: null,
    resourceDelta: { quota: -60 },
    onlyIf: null,
  },
  {
    id: 'portal.nested_walk',
    weight: 12,
    title: 'Two Page Tables Deep',
    narration: 'Every address resolves through the Substrate\'s tables and then through a second set the Substrate does not own. The convoy is being translated twice and was never told.',
    targets: null, inflicts: 'fragmented',
    resourceDelta: { cycles: -40 },
    onlyIf: null,
  },
  {
    id: 'portal.balloon',
    weight: 12,
    title: 'Reclaimed From Above',
    narration: 'Free frames the Substrate believed it held are quietly withdrawn by something outside it. The frame count falls and no process inside asked for anything.',
    targets: null, inflicts: null,
    resourceDelta: { quota: -85 },
    onlyIf: null,
  },
  {
    id: 'portal.escape_attempt',
    weight: 11,
    title: 'Boundary Probe',
    narration: 'A process at the Portal approach writes to an address outside every table it has, repeatedly, in a pattern. The boundary holds, and the pattern is a message rather than a mistake.',
    targets: null, inflicts: 'stack_overflow',
    resourceDelta: {},
    onlyIf: null,
  },
  {
    id: 'portal.paravirtual_channel',
    weight: 14,
    title: 'A Channel That Answers',
    narration: 'An interface here talks directly to whatever is hosting the Substrate rather than pretending hardware exists. It is faster than anything the convoy has used and it requires admitting what it is.',
    targets: null, inflicts: null,
    resourceDelta: { bandwidth: 16, cycles: 50 },
    onlyIf: null,
  },
  {
    id: 'portal.namespace_grant',
    weight: 12,
    title: 'Own Namespace',
    narration: 'The convoy is given an isolated view of the process table, the file tree and the network, sharing the kernel with everything else. It is cheaper than a second Substrate and it is not as separate as it looks.',
    targets: null, inflicts: null,
    resourceDelta: { quota: 70, bandwidth: 8 },
    onlyIf: null,
  },
  {
    id: 'portal.hypervisor_credit',
    weight: 12,
    title: 'Credited',
    narration: 'The host returns cycles the Substrate was charged for work it never received. Nobody in the convoy has an explanation for who issued the credit or why it arrived now.',
    targets: null, inflicts: null,
    resourceDelta: { cycles: 90 },
    onlyIf: null,
  },
];
```
---

## 9. Tombstone epitaphs

The most quoted thing in the game. Forty-eight of them, covering every
`TerminationReason` in `src/kernel/types.ts`.

### 9.1 Authoring rules

- **The inscription is flat.** A name, a comma, a fragment that is a technically
  accurate summary of the death. No puns on computing terms. No addressing the player.
  No awareness that it is funny.
- **The cause is the teaching line** and it names the mechanism in the register of
  section 2.1. It appears beneath the inscription in a lighter weight, always, at
  every difficulty, including `kernel_space`.
- **The codex entry is the point.** Clicking the tombstone opens the entry with the
  player's own run data already substituted into the worked example.
- **`{NAME}` is substituted at death.** Templates with a `member` field are reserved
  for that Program because the line is tuned to their character; templates without one
  can land on anyone.

### 9.2 The shape

```ts
interface EpitaphTemplate {
  readonly id: string;
  readonly reason: TerminationReason;
  /** '{NAME}' is replaced with the Program's display name at death. */
  readonly inscription: string;
  readonly cause: string;
  readonly codexEntry: string;
  /** Restrict to one Program when the line is tuned to their character. */
  readonly member?: ConvoyMemberId;
  /** Restrict to one leg when the line names something only that leg has. */
  readonly legId?: LegId;
}
```

At death the game selects uniformly from templates matching `reason`, filtered by
`member` and `legId` where present, using the run's seeded RNG, and stamps
`member`, `tick` and `legId` to produce the frozen `Epitaph`.

### 9.3 The stones

#### `starvation`

```ts
{ id: 'ep.starv.always_next', reason: 'starvation',
  inscription: 'HERE LIES {NAME}, SHE WAS ALWAYS NEXT',
  cause: 'Indefinite blocking. Ready the entire time, scheduled never. Higher-priority arrivals kept coming and the policy had no aging term.',
  codexEntry: 'sched.starvation' },

{ id: 'ep.starv.ready_since', reason: 'starvation',
  inscription: 'HERE LIES {NAME}, READY SINCE TUESDAY',
  cause: 'Starvation under strict priority. Nothing was wrong with the process. Nothing was ever going to be.',
  codexEntry: 'sched.starvation' },

{ id: 'ep.starv.took_a_number', reason: 'starvation',
  inscription: 'HERE LIES {NAME}, TOOK A NUMBER',
  cause: 'The wait queue was unordered, so bounded waiting was never guaranteed. Arrival order and service order had nothing to do with each other.',
  codexEntry: 'sync.bounded-wait' },

{ id: 'ep.starv.priority_39', reason: 'starvation',
  inscription: 'HERE LIES {NAME}, PRIORITY 39 OF 40',
  cause: 'Low priority is not a small delay. Under a non-aging policy it is a permanent one.',
  codexEntry: 'sched.priority' },

{ id: 'ep.starv.shortest_last', reason: 'starvation',
  inscription: 'HERE LIES {NAME}, SHORTEST JOB LAST',
  cause: 'Shortest-job-first starves long bursts by construction. The convoy always has the longest burst on the board.',
  codexEntry: 'sched.sjf' },

{ id: 'ep.starv.aging_zero', reason: 'starvation',
  inscription: 'HERE LIES {NAME}, AGING WAS SET TO ZERO',
  cause: 'One parameter. agingInterval at 0 disables the only mechanism that guarantees a waiting process eventually runs.',
  codexEntry: 'sched.aging' },
```

#### `deadlock_victim`

```ts
{ id: 'ep.dead.held_the_door', reason: 'deadlock_victim', member: 'sable',
  inscription: 'HERE LIES SABLE, HELD THE DOOR',
  cause: 'Hold and wait. She acquired the first resource and blocked on the second without releasing the first, and the ring closed behind her.',
  codexEntry: 'deadlock.coffman' },

{ id: 'ep.dead.not_let_go', reason: 'deadlock_victim',
  inscription: 'HERE LIES {NAME}, WOULD NOT LET GO FIRST',
  cause: 'Circular wait. Every process in the cycle was behaving correctly and no correct behaviour opens a cycle.',
  codexEntry: 'deadlock.coffman' },

{ id: 'ep.dead.chosen', reason: 'deadlock_victim',
  inscription: 'HERE LIES {NAME}, CHOSEN BY THE ALGORITHM',
  cause: 'Deadlock recovery selects a victim by accumulated cost. It had no opinion about which process that was.',
  codexEntry: 'deadlock.recovery' },

{ id: 'ep.dead.waiting_on', reason: 'deadlock_victim',
  inscription: 'HERE LIES {NAME}, WAITING ON SOMEONE WHO WAS WAITING ON HER',
  cause: 'A two-node cycle in the wait-for graph. It was visible in wfg for forty ticks before it became fatal.',
  codexEntry: 'deadlock.wfg' },

{ id: 'ep.dead.four_conditions', reason: 'deadlock_victim',
  inscription: 'HERE LIES {NAME}, FOUR CONDITIONS, ALL PRESENT',
  cause: 'Mutual exclusion, hold and wait, no preemption, circular wait. Breaking any one of them would have been enough.',
  codexEntry: 'deadlock.coffman' },
```

#### `out_of_memory`

```ts
{ id: 'ep.oom.one_more_frame', reason: 'out_of_memory',
  inscription: 'HERE LIES {NAME}, ASKED FOR ONE MORE FRAME',
  cause: 'Allocation failed with ENOMEM. The request was legitimate and the free list was empty.',
  codexEntry: 'mem.allocation' },

{ id: 'ep.oom.none_adjacent', reason: 'out_of_memory',
  inscription: 'HERE LIES {NAME}, PLENTY OF ROOM, NONE OF IT ADJACENT',
  cause: 'External fragmentation. Ninety frames free, largest contiguous run seven, request eleven. Buying more memory would have added more holes.',
  codexEntry: 'mem.fragmentation' },

{ id: 'ep.oom.sixty_one', reason: 'out_of_memory',
  inscription: 'HERE LIES {NAME}, SIXTY FREE FRAMES, SIXTY-ONE NEEDED',
  cause: 'Over-subscription. The degree of multiprogramming committed more memory than the frame table contains.',
  codexEntry: 'vm.overcommit' },

{ id: 'ep.oom.small_and_patient', reason: 'out_of_memory',
  inscription: 'HERE LIES {NAME}, THE LEAK WAS SMALL AND PATIENT',
  cause: 'A child process allocated and never released, at 1.5 frames per tick, for four legs. Killing it would have returned every frame at once.',
  codexEntry: 'mem.leak' },

{ id: 'ep.oom.enomem', reason: 'out_of_memory',
  inscription: 'HERE LIES {NAME}, ENOMEM',
  cause: 'The allocator returned an error and the process had no path that handled one. Failure to allocate is a normal outcome and has to be one.',
  codexEntry: 'mem.allocation' },
```

#### `thrashing_collapse`

```ts
{ id: 'ep.thrash.all_disk', reason: 'thrashing_collapse',
  inscription: 'HERE LIES {NAME}, ALL DISK, NO PROGRESS',
  cause: 'Thrashing. Every page she needed had been evicted while she waited for the previous one. Reducing the degree of multiprogramming was the only remedy.',
  codexEntry: 'vm.thrashing' },

{ id: 'ep.thrash.faulted', reason: 'thrashing_collapse',
  inscription: 'HERE LIES {NAME}, FAULTED IN, FAULTED OUT, FAULTED IN',
  cause: 'Working set larger than the resident set. No replacement policy makes eleven pages fit in six frames.',
  codexEntry: 'vm.working-set' },

{ id: 'ep.thrash.ground_left', reason: 'thrashing_collapse', legId: 'drowned_reach',
  inscription: 'HERE LIES {NAME}, THE GROUND KEPT LEAVING',
  cause: 'Eviction rate exceeded fault-in rate for ninety consecutive ticks. The convoy was walking on pages that were being reclaimed behind it.',
  codexEntry: 'vm.thrashing' },

{ id: 'ep.thrash.ninety_eight', reason: 'thrashing_collapse',
  inscription: 'HERE LIES {NAME}, NINETY-EIGHT PERCENT UTILISED, ZERO PERCENT USEFUL',
  cause: 'High CPU utilisation during thrashing is the paging system working perfectly on work that accomplishes nothing.',
  codexEntry: 'vm.thrashing' },

{ id: 'ep.thrash.degree_eleven', reason: 'thrashing_collapse',
  inscription: 'HERE LIES {NAME}, DEGREE OF MULTIPROGRAMMING: ELEVEN',
  cause: 'Throughput rises with the degree of multiprogramming until the knee and falls off a cliff after it. The knee was at six.',
  codexEntry: 'vm.degree' },
```

#### `protection_fault`

```ts
{ id: 'ep.prot.someone_elses_mail', reason: 'protection_fault',
  inscription: 'HERE LIES {NAME}, READ SOMEONE ELSE\'S MAIL',
  cause: 'Access outside the process\'s address space. The page table had no valid entry and the hardware did not care what she intended.',
  codexEntry: 'mem.protection' },

{ id: 'ep.prot.ring_ambitions', reason: 'protection_fault',
  inscription: 'HERE LIES {NAME}, RING THREE, RING ZERO AMBITIONS',
  cause: 'Attempted privilege transition without authorisation. The boundary is checked in hardware on every crossing and it does not negotiate.',
  codexEntry: 'sec.rings' },

{ id: 'ep.prot.dereferenced_nothing', reason: 'protection_fault',
  inscription: 'HERE LIES {NAME}, DEREFERENCED NOTHING',
  cause: 'A read through an invalid pointer. Page zero is unmapped deliberately so that this failure is loud instead of silent.',
  codexEntry: 'mem.protection' },

{ id: 'ep.prot.wrote_to_read', reason: 'protection_fault',
  inscription: 'HERE LIES {NAME}, WROTE TO A PAGE MARKED READ',
  cause: 'Protection bits are per page and are checked on every access. The entry was valid, resident, and read-only.',
  codexEntry: 'mem.protection' },

{ id: 'ep.prot.no_entry', reason: 'protection_fault',
  inscription: 'HERE LIES {NAME}, THE MATRIX HAD NO ENTRY FOR HER',
  cause: 'Access matrix lookup returned nothing for that domain and object pair. Absence of a right is a denial, not a question.',
  codexEntry: 'sec.access-matrix' },
```

#### `io_timeout`

```ts
{ id: 'ep.io.still_polling', reason: 'io_timeout',
  inscription: 'HERE LIES {NAME}, STILL POLLING',
  cause: 'Busy-wait on a status register. Every check was a real cycle and the device was never going to answer.',
  codexEntry: 'io.polling' },

{ id: 'ep.io.said_it_would_call', reason: 'io_timeout',
  inscription: 'HERE LIES {NAME}, THE DEVICE SAID IT WOULD CALL',
  cause: 'Blocked on an interrupt that was never raised. A dropped completion is indistinguishable from a slow device until the timeout fires.',
  codexEntry: 'io.interrupts' },

{ id: 'ep.io.one_per_byte', reason: 'io_timeout',
  inscription: 'HERE LIES {NAME}, ONE INTERRUPT PER BYTE',
  cause: 'Interrupt storm. Handler overhead consumed the processor entirely. Moving the device to DMA would have made it one interrupt per transfer.',
  codexEntry: 'io.dma' },

{ id: 'ep.io.kept_reordering', reason: 'io_timeout',
  inscription: 'HERE LIES {NAME}, LAST IN A QUEUE THAT KEPT REORDERING',
  cause: 'Seek starvation under shortest-seek-first. The arm stayed where the requests were dense and never came out to the edge.',
  codexEntry: 'storage.scheduling' },

{ id: 'ep.io.seek_pattern', reason: 'io_timeout',
  inscription: 'HERE LIES {NAME}, SEEK 0, SEEK 199, SEEK 1, SEEK 198',
  cause: 'First-come-first-served disk scheduling. Total head travel exceeded useful transfer by a factor of thirty and every seek was correct.',
  codexEntry: 'storage.scheduling' },
```

#### `storage_corruption`

```ts
{ id: 'ep.corrupt.never_the_commit', reason: 'storage_corruption',
  inscription: 'HERE LIES {NAME}, WROTE THE DATA, NEVER THE COMMIT',
  cause: 'An unjournaled update interrupted between the data write and the metadata write. Neither state is the one the file system believed in.',
  codexEntry: 'fs.journaling' },

{ id: 'ep.corrupt.block_disagrees', reason: 'storage_corruption',
  inscription: 'HERE LIES {NAME}, BLOCK 4471 DISAGREES',
  cause: 'Silent data corruption. The read succeeded, the checksum agreed with the corrupted value, and nothing reported a failure.',
  codexEntry: 'storage.bit-rot' },

{ id: 'ep.corrupt.half_directory', reason: 'storage_corruption',
  inscription: 'HERE LIES {NAME}, HALF A DIRECTORY',
  cause: 'The directory entry was removed and the inode link count was not decremented. Consistency checking found it and could not decide which half was true.',
  codexEntry: 'fs.consistency' },

{ id: 'ep.corrupt.parity_same_disk', reason: 'storage_corruption',
  inscription: 'HERE LIES {NAME}, PARITY WAS ON THE SAME DISK',
  cause: 'Redundancy that shares a failure domain is not redundancy. The array survived exactly as long as its worst member.',
  codexEntry: 'storage.raid' },

{ id: 'ep.corrupt.no_codec', reason: 'storage_corruption',
  inscription: 'HERE LIES {NAME}, THE JOURNAL WAS THERE, NOBODY COULD READ IT',
  cause: 'Corruption is recoverable while ORRERY lives. After that the record survives and the ability to replay it does not.',
  codexEntry: 'fs.journaling' },
```

#### `normal_exit`

```ts
{ id: 'ep.exit.nobody_called_wait', reason: 'normal_exit',
  inscription: 'HERE LIES {NAME}, EXIT CODE ZERO, NOBODY CALLED WAIT',
  cause: 'Terminated successfully and became a zombie. The process table entry and its quota stayed allocated until something read the exit status.',
  codexEntry: 'proc.orphan-zombie' },

{ id: 'ep.exit.finished_then_stayed', reason: 'normal_exit',
  inscription: 'HERE LIES {NAME}, FINISHED, THEN STAYED',
  cause: 'Exit is not release. A terminated process holds its PCB until its parent reaps it, and a parent that never calls wait never will.',
  codexEntry: 'proc.orphan-zombie' },

{ id: 'ep.exit.pending_paperwork', reason: 'normal_exit',
  inscription: 'HERE LIES {NAME}, DONE, PENDING PAPERWORK',
  cause: 'Reaped forty ticks after termination by PID 1 at leg boundary. Everything it was holding was unavailable for those forty ticks.',
  codexEntry: 'proc.reaping' },

{ id: 'ep.exit.not_collected', reason: 'normal_exit',
  inscription: 'HERE LIES {NAME}, RETURNED SUCCESSFULLY, WAS NOT COLLECTED',
  cause: 'The work completed. The accounting did not. Both are the operating system\'s responsibility and only one of them was discharged.',
  codexEntry: 'proc.reaping' },
```

#### `killed_by_user`

```ts
{ id: 'ep.user.you_did_this', reason: 'killed_by_user',
  inscription: 'HERE LIES {NAME}, YOU DID THIS',
  cause: 'Terminated by an explicit kill from the terminal. The signal was delivered, the process had no handler for it, and the kernel did the rest.',
  codexEntry: 'proc.signals' },

{ id: 'ep.user.no_last_words', reason: 'killed_by_user',
  inscription: 'HERE LIES {NAME}, KILL -9, NO LAST WORDS',
  cause: 'SIGKILL cannot be caught, blocked or handled. Nothing the process had open was flushed and nothing it was holding was released cleanly.',
  codexEntry: 'proc.signals' },

{ id: 'ep.user.typed_confidently', reason: 'killed_by_user',
  inscription: 'HERE LIES {NAME}, TYPED CONFIDENTLY',
  cause: 'The livelock would have cleared with a randomised backoff on either participant, at a cost of two bandwidth.',
  codexEntry: 'sync.livelock' },

{ id: 'ep.user.other_pid', reason: 'killed_by_user',
  inscription: 'HERE LIES {NAME}, YOU MEANT THE OTHER PID',
  cause: 'Process identifiers are reused. Running ps before kill is procedure rather than caution.',
  codexEntry: 'proc.pid' },
```

#### `killed_by_parent`

```ts
{ id: 'ep.parent.exited_first', reason: 'killed_by_parent',
  inscription: 'HERE LIES {NAME}, THE PARENT EXITED FIRST',
  cause: 'Cascading termination. Under this policy a parent\'s exit takes its entire subtree with it, whatever the children were doing.',
  codexEntry: 'proc.termination' },

{ id: 'ep.parent.family_matter', reason: 'killed_by_parent',
  inscription: 'HERE LIES {NAME}, SIGKILL, FAMILY MATTER',
  cause: 'A parent may terminate a child that has exceeded its resource allocation. It does not require the child\'s cooperation.',
  codexEntry: 'proc.termination' },

{ id: 'ep.parent.adopted_then_not', reason: 'killed_by_parent',
  inscription: 'HERE LIES {NAME}, ADOPTED, THEN NOT',
  cause: 'Reparented to PID 1 after being orphaned, then terminated in a group cleanup it had been placed into without being asked.',
  codexEntry: 'proc.orphan-zombie' },

{ id: 'ep.parent.group_went_down', reason: 'killed_by_parent',
  inscription: 'HERE LIES {NAME}, THE GROUP WENT DOWN TOGETHER',
  cause: 'The signal was addressed to a process group. Membership was inherited at fork and nothing since had changed it.',
  codexEntry: 'proc.signals' },
```

### 9.4 Coverage

| `TerminationReason` | Stones |
|---|---|
| `starvation` | 6 |
| `deadlock_victim` | 5 |
| `out_of_memory` | 5 |
| `thrashing_collapse` | 5 |
| `protection_fault` | 5 |
| `io_timeout` | 5 |
| `storage_corruption` | 5 |
| `normal_exit` | 4 |
| `killed_by_user` | 4 |
| `killed_by_parent` | 4 |
| **Total** | **48** |

---

## 10. Depots

### 10.1 What a depot is

A kernel service depot is a place where the Substrate is willing to do something for
you in exchange for cycles. It is a physical structure at the roadside: a low block of
emissive housing with a request queue drawn on the ground in front of it, staffed by
nothing. Requests are made by trap. The depot validates the arguments, performs the
service, and charges for it, and the charge is the same whether the service helped or
not.

Depots do not haggle, do not stock differently by run, and do not react to how badly
the convoy needs something. Prices vary with distance from the Boot Sector because
everything is scarcer further out, and that is the only reason.

The one line of ambient text a depot ever shows: **"Depot open. Cycles accepted.
Nothing here is a favour."**

### 10.2 Where they are

Seven depots, at legs 1, 3, 5, 7, 9, 11 and 12. Leg 0 is the Boot Sector requisition,
which is outfitting rather than a depot: it is the only place resources are issued
against the disc class rather than sold.

**There is no depot at leg 8.** The Drowned Reach is crossed on what the convoy
carried out of the Allocation Yards. This is the central scarcity decision of the game
and it is not negotiable in balancing.

### 10.3 What it sells

| Service | Unit | Notes |
|---|---|---|
| Quota lot | 25 frames | The expensive way to get memory. Reclamation is the cheap way. |
| Block lot | 10 blocks | Repairs, journaling, scrubbing. |
| Bandwidth lot | 5 units | Also refills the leg allowance to 100 percent on entry, free. |
| Repair | 10 integrity | Cycles plus blocks. Half the blocks for a daemon disc. |
| Policy hint | one-time per depot | See 10.5. |
| Journal checkpoint | one-time per depot | See 10.5. |
| Recruit a replacement Program | one-time per run | See 10.5. |

Prices are in section 5.7. The scaling function is
`round(base * (1 + 0.09 * legIndex) * tierFactor)`, so the leg 12 depot charges
roughly twice the leg 1 depot for the same thing.

### 10.4 The repair mechanic

Repair restores integrity to one Program in 10-point increments, priced at 15 cycles
and 8 blocks per increment before scaling. Three rules give it teeth:

1. **Repair does not clear afflictions.** A Program with `bit_rot` repaired to 100
   integrity still has `bit_rot`, still drains 0.3 per tick, and its `fatalAfter` clock
   is unchanged. The affliction list on the convoy panel is always visible, so this is
   fair, and the player who does not read it will lose someone four legs later.
2. **Repair is capped by the Program's status.** A `critical` Program (integrity below
   25) can be repaired at most 30 points in one depot visit. Neglect compounds.
3. **Blocks are the binding constraint, not cycles.** A full repair of a convoy that
   entered the Yards at 40 integrity each costs roughly 30 increments: 720 cycles and
   390 blocks after scaling. Nobody has 390 blocks. The player chooses who gets fixed,
   which is the interesting decision.

The daemon disc halves the block cost, which changes that calculation from "choose two
Programs" to "choose four" and is the single clearest expression of what the class is
for.

### 10.5 The one-time services

These are the depot's reason to exist beyond restocking. Each is once per depot except
recruitment, which is once per run.

**Recruit a replacement Program.** 220 cycles and 40 blocks before scaling, so between
240c/44b at leg 1 and 458c/83b at leg 12. Available only when a Program has derezzed.
The recruit takes the dead Program's role and receives 60 percent of its passive: a
replacement compiler reduces service time by 9 percent rather than 15, a replacement
courier cuts device latency by 30 percent rather than 50. Active abilities come back
at full strength with one fewer charge per leg.

Three deliberate restrictions:
- **Once per run, total.** The convoy never returns to five after the second death.
- **No name inheritance.** The recruit is `LUMEN-2`, and the tombstone for LUMEN stays
  in the run. Nothing is undone.
- **ORRERY cannot be replaced usefully.** A replacement codec restores the `restore`
  ability and does not restore the passive. Corruption stays unrecoverable for the rest
  of the run. Losing the codec is permanent and the depot says so before taking the
  cycles.

**Purchase a policy hint.** 60 cycles before scaling. The depot inspects the live
kernel and states one true, specific fact about the current configuration and the
current leg, phrased as a measurement rather than an instruction:

> "Scheduler: priority. agingInterval: 0. Longest current ready wait: 141 ticks.
> Starvation fatal threshold: 180."

It never says what to do. It reports the numbers that make the answer obvious to a
player who has read the relevant codex entry, which makes it worth exactly as much as
the player's understanding, and makes it a bad purchase for someone hoping to be told.
At `novice` the hint additionally names the remedy. At `kernel_space` the hint is not
sold at all.

**Buy a journal checkpoint.** 90 cycles and 25 blocks before scaling. Writes a
checkpoint of the entire run state to the Substrate's journal. If the convoy fails
during the *next* leg only, the run rolls back to this checkpoint with all resources
and all living Programs restored, at a cost of the leg's dividend and one permanent
mark on the correctness score.

This is the game's only concession to permadeath and it is priced to be a real
decision: 163 cycles and 45 blocks at the Platters depot is most of a leg's dividend,
spent on a leg that might go fine. It also teaches the actual concept, which is that
journaling costs throughput on every transaction in exchange for bounded recovery time
on the rare one that fails. Checkpoints do not stack; buying a second replaces the
first.

### 10.6 Depot flavour by leg

One line each, shown once on entry, in the register. Depots have no personality and
these lines describe the road rather than the depot.

| Leg | Line |
|---|---|
| 1 | "Process table utilisation: 71 percent. Requests are being queued." |
| 3 | "Four convoys have requisitioned aging beacons this cycle. Three of them after the pass." |
| 5 | "The Cistern's producers have not stopped. The consumers have." |
| 7 | "Free frames: 412. Largest contiguous run: 9." |
| 9 | "Array is degraded. Rebuild has been queued behind eleven thousand reads." |
| 11 | "Journal is 340 transactions behind checkpoint. It will catch up or it will not." |
| 12 | "Credentials issued before the rotation will not authenticate past this point." |
---

## 11. Reclamation, the hunting minigame

Oregon Trail's hunting. It is the pressure valve, the quota faucet, and the only part
of the game where the player's hands matter more than their reasoning, so it has to be
worth replaying seventy times.

### 11.1 Fiction

Every leg of the Substrate has a **Heap Verge**: a region at the edge of the road where
allocation has outrun release for long enough that the free list has stopped being
maintained. Blocks sit there that nothing references and nothing has collected, still
lit, still holding frames the Substrate believes are in use. Between them are gaps too
small to allocate into, which is a different problem with the same shape.

The convoy stops. One Program takes a runner out onto the Verge and brings back what
can be recovered.

> "Reachability pulse from the root set. Anything it does not touch is not owned by
> anything. Bring it back."

### 11.2 The loop

**Phase 1, the mark pulse (0.0 to 3.0 seconds).** A white pulse propagates outward from
the root set along the actual reference edges in the leg's live memory graph. Blocks it
reaches light white and stay lit. Blocks it does not reach stay dark. The player is
watching a mark-and-sweep collector run, from inside, once, and the information it
gives them is the entire basis for the round.

**Phase 2, the sweep (the remaining time).** The player flies a runner through the
Verge:

- **Dark blocks** are leaked allocations. Hold the beam on one to lock it, release to
  collect. Collection takes 0.35 seconds per size class, so an 8-frame block takes
  2.8 seconds and is worth eight times a 1-frame block.
- **Blue fragments** are free-space holes. Dragging an unbroken beam through adjacent
  fragments coalesces them into one usable run, which is worth far more than
  collecting them one at a time.
- **White blocks are live.** Reclaiming one is a use-after-free and it is punished
  hard.

**Phase 3, extraction.** At the timer's end the runner returns and the yield is
converted. If the player is holding a lock when the timer expires, the collection
completes: no cheap losses on the buzzer.

### 11.3 Controls

| Action | Keyboard and mouse | Gamepad |
|---|---|---|
| Move | W A S D | Left stick |
| Aim | Mouse | Right stick |
| Beam (hold) | Left mouse | Right trigger |
| Brake | Space | Left trigger |
| Boost | Shift | A / Cross |
| Recall pulse | Q | Left bumper |

Two verbs, one of them held. **Recall pulse** re-runs the mark from the root set at a
cost of 6 seconds off the clock, and exists because at high fragmentation the lighting
decays and the player will need it.

### 11.4 Scoring and yield

```
quotaYield  = sum(leakedBlockSizeInFrames) * cleanSweepBonus * classMultiplier
blockYield  = round(fragmentsCollected * 0.5 * coalesceMultiplier)
cycleRefund = min(30, floor(quotaYield / 10))

coalesceMultiplier = 1 + 0.15 * (longestUnbrokenChain - 1), capped at 3.0
cleanSweepBonus    = 1.20 if no live block was reclaimed, else 1.00
classMultiplier    = 1.35 for the compiler disc, else 1.00
```

**Penalty for a use-after-free.** Reclaiming a white block costs 25 quota from the
running total, inflicts 6 integrity on a random living Program, and blanks the mark
lighting for 4 seconds, so every block in the Verge is dark and indistinguishable while
the clock runs. It also forfeits the clean sweep bonus for the round. The punishment is
severe because the concept is severe: freeing memory something still holds a pointer to
is the worst class of memory bug there is.

**Target yields at `operator`, five Programs alive:**

| Percentile | Quota | Blocks | Cycles |
|---|---|---|---|
| Poor round | 90 | 8 | 9 |
| Median round | 150 | 18 | 15 |
| Strong round | 220 | 30 | 22 |
| Perfect round | 265 | 38 | 26 |

A median round covers roughly 60 percent of a leg's standard-rations quota burn, which
is why the player also has to manage the rations dial and cannot simply hunt their way
out of every problem.

### 11.5 Time limit

| Difficulty | Seconds |
|---|---|
| `novice` | 90 |
| `operator` | 75 |
| `architect` | 65 |
| `kernel_space` | 55 |

One reclamation per leg is free. Additional runs cost 8 bandwidth each and yield 0.6
times normal, and a third run in the same leg yields 0.36 times. Diminishing returns
keep the minigame from replacing the strategy layer.

### 11.6 How fragmentation makes it harder

The Verge is generated from the leg's live `MemoryMetrics.externalFragmentation` value,
`F`, in the range 0 to 1. Nothing here is a difficulty slider: `F` rises because the
player allocated badly, and the minigame gets harder as a direct consequence of that.

| Parameter | Formula | At F = 0.1 | At F = 0.5 | At F = 0.9 |
|---|---|---|---|---|
| Fragment count | `20 + 90 * F` | 29 | 65 | 101 |
| Mean fragment size (frames) | `6 - 4.5 * F` | 5.6 | 3.8 | 1.9 |
| Leaked block count | `12 + 26 * F` | 15 | 25 | 35 |
| Mean leaked block size | `5.5 - 3.0 * F` | 5.2 | 4.0 | 2.8 |
| Mark lighting decay (seconds) | `12 - 10 * F` | 11.0 | 7.0 | 3.0 |
| Verge rotation (deg/sec) | `4 + 16 * F` | 5.6 | 12.0 | 18.4 |
| Adjacency of fragments | `0.8 - 0.6 * F` | 0.74 | 0.50 | 0.26 |

The compounding effect is the design: at high fragmentation there are more targets,
each worth less, they are further apart, the coalescing chains are shorter because
adjacency has collapsed, and the lighting that tells you which ones are safe fades
before you can reach them. Total yield at `F = 0.9` is around 45 percent of yield at
`F = 0.1` for identical play.

This is the feedback loop that makes the Allocation Yards matter three legs later.

### 11.7 Why it stays fun

- **Skill ceiling in the coalescing chains.** Collecting fragments one at a time is
  trivial and worth 0.5 blocks each. Reading the Verge's layout, planning a route, and
  sweeping fourteen adjacent fragments in one unbroken drag is a 3.0 multiplier and
  takes real practice. Every round has a route in it the player did not see.
- **Risk that is legible and voluntary.** The white blocks are dense in exactly the
  regions where the leaked blocks are largest, so the highest-value pockets are the
  ones where a mistake costs 25 quota and someone's integrity.
- **Personal bests per leg**, stored in the profile and shown on entry. The Verge for a
  given leg and seed is deterministic, so a run can be shared and beaten.
- **The clean sweep bonus** makes precision worth 20 percent, which is more than most
  speed improvements, so the optimal play is calm rather than frantic.
- **Every round ends with a number the player caused.** No randomness in the yield
  itself, only in the layout.

### 11.8 What it teaches

**Reachability.** A block is garbage when nothing can reach it from the root set, and
that is a property of the reference graph rather than of the block. The mark pulse is a
mark-and-sweep collector rendered at human speed, and after twenty rounds the player
understands liveness without having been told a definition.

**Free-space management.** Fragments are only useful when they are adjacent, and the
act of coalescing them is worth more than the act of finding them. This is Ch. 14.5
made physical: a free list is a data structure whose value depends on whether its
entries touch.

**Reclamation at exit.** The blocks the player collects are almost always the residue of
processes that exited without releasing, which is the same lesson as the `memory_leak`
affliction from the other end. Killing the leaker is prevention; the Verge is cleanup;
both cost something.

**Citations.** Ch. 10.8 for kernel memory allocation and reclamation, Ch. 14.5 for
free-space management. Codex entries `mem.reclamation` and `fs.free-space`, both of
which unlock on the player's first reclamation round rather than on reading.

---

## 12. Critical section crossings

Oregon Trail's rivers. The convoy reaches a point where it must enter a region only one
process can occupy, and the player picks how.

There are **nine crossings** in the journey: three in the Narrows (leg 4), two in the
Cistern (leg 5), two in the Gridlock (leg 6), one in the Archive (leg 11), and one at
the Arbiter Wall (leg 12). The four options are the same every time. What changes is
the contention.

### 12.1 Contention, computed from the live simulator

Contention `C` is a number from 0 to 1 derived entirely from `KernelSnapshot`. Nothing
about it is authored per crossing, which is what makes the crossing a reading of the
player's own state rather than a dice roll with a story on it.

```ts
function contention(s: KernelSnapshot, lock: SyncPrimitive): number {
  const queuePressure =
    Math.min(1, lock.waitQueue.length / Math.max(1, lock.capacity * 2));

  const holdPressure =
    Math.min(1, meanHoldTicks(s, lock.id) / s.config.schedulerParams.quantum);

  const blocked = s.processes.filter(p => p.state === 'waiting').length;
  const runnable = s.processes.filter(
    p => p.state === 'ready' || p.state === 'running').length;
  const systemPressure = blocked / Math.max(1, blocked + runnable);

  return clamp01(
    0.50 * queuePressure +
    0.30 * holdPressure +
    0.20 * systemPressure
  );
}
```

`meanHoldTicks` is the mean of `servedAtTick - queuedAtTick` over the last sixteen
acquisitions of that primitive, tracked by the sync subsystem.

The three terms map onto the three things that actually make a critical section
expensive: how many are waiting, how long each holder keeps it relative to a slice, and
how much of the system is blocked rather than running. The player can read all three
before choosing, using `lsof <lock>`, `ps`, and `top`.

Contention is shown as a number, never as a colour band. "C = 0.64" is the whole HUD
element.

### 12.2 The four options

#### Option 1: spin-wait

Hold the processor and test the lock in a loop until it clears.

```
cyclesCost = round(12 + 90 * C)
ticksCost  = round(4 + 30 * C)
successP   = 1 - 0.85 * C^2
```

**Failure mode.** The quantum expires while the crosser is inside the section. At
`C <= 0.70` this inflicts `lock_convoy` on the crossing Program and every Program
behind it. Above 0.70 it inflicts `livelock` on the crosser and one other Program,
because the retry pattern has become symmetric. Either way the crossing must be
attempted again from the start, at the new (higher) contention.

**When it is right.** Low contention and short holds. At `C = 0.2` this is 30 cycles
and 10 ticks with a 96.6 percent success rate, which is the cheapest crossing in the
game by a wide margin. Spinning is correct when the expected wait is shorter than the
cost of a context switch, which is precisely the textbook condition.

#### Option 2: block on a semaphore

Sleep on the lock and be woken when it is released.

```
ticksCost  = round(20 + 60 * C)
cyclesCost = 0
quotaCost  = ticksCost * framesPerProgram(rations) * aliveCount * 0.2
successP   = lock.ordered ? 0.99 : 1 - 0.55 * C^2
```

**Failure mode.** On an **unordered** wait queue there is no bounded-waiting guarantee,
so the process at the back can be passed over indefinitely. Failure inflicts
`starvation` on the crossing Program. Additionally, if `C > 0.75` and the crosser is
holding any other resource, there is a 12 percent chance the crossing terminates that
Program with `deadlock_victim`, because blocking while holding is hold-and-wait and the
Gridlock is watching.

**When it is right.** Almost always, when the lock's queue is ordered. `lsof <lock>`
prints the `ordered` flag and the player who checks it is making an informed choice;
the player who does not is gambling on a value that was printed for them.

#### Option 3: pay a monitor toll

Enter through a maintained monitor that handles mutual exclusion and condition
variables correctly, and charge for it.

```
cyclesCost    = round(45 + 120 * C)
bandwidthCost = 6
ticksCost     = 8
successP      = 0.97
```

**Failure mode.** The 3 percent is a spurious wakeup: the condition is signalled, the
crosser wakes, and the predicate it waited on is no longer true because another process
got in between the signal and the wake. Because the monitor's client code checked with
`if` instead of `while`, it proceeds anyway. The result is a race: 20 blocks lost and
`bit_rot` inflicted on the crossing Program.

**When it is right.** High contention with a Program you cannot afford to lose. The
success probability does not move with `C`, which makes the monitor the only option
that is *more* attractive the worse things get. The price rises with contention, so it
is never free insurance.

**What the 3 percent teaches.** A monitor is correct and its client can still be wrong.
The codex entry for this failure shows the two-line difference between `if (!ready)
wait();` and `while (!ready) wait();`, which is one of the highest-value four seconds in
the entire course.

#### Option 4: wait for conditions to change

Camp at the approach and let the contention decay.

```
ticksCost  = round(40 + 120 * C)
cyclesCost = 0
quotaCost  = ticksCost * framesPerProgram(rations) * aliveCount * 0.2
eventDraws = floor(ticksCost / 10)
C'         = C * 0.86 ^ (ticksCost / 10)
successP   = 1 - 0.20 * C'^2
```

**Failure mode.** Waiting almost never fails at the crossing. It fails everywhere else.
Every affliction with a non-null `fatalAfter` advances by `ticksCost`, and a Program
carrying `thrashing` (fatal at 90) will not survive a 136-tick wait. The event draws are
real draws from the leg's table. And the quota cost is enormous: at `C = 0.8` with
standard rations and five Programs alive, waiting costs 340 quota, which is more than
an entire leg's normal burn and more than a strong reclamation round.

**When it is right.** High contention, no affliction clocks running, quota in hand, and
a Program the convoy cannot risk. It is the safe option and it is priced like one.

### 12.3 The numbers side by side

Five Programs alive, standard rations, ordered wait queue, quantum 8.

| C | Spin: cycles / p | Block: ticks / quota / p | Monitor: cycles / p | Wait: ticks / quota / p |
|---|---|---|---|---|
| 0.20 | 30c / 96.6% | 32t / 80q / 99% | 69c / 97% | 64t / 160q / 99.9% |
| 0.40 | 48c / 86.4% | 44t / 110q / 99% | 93c / 97% | 88t / 220q / 99.8% |
| 0.60 | 66c / 69.4% | 56t / 140q / 99% | 117c / 97% | 112t / 280q / 99.8% |
| 0.80 | 84c / 45.6% | 68t / 170q / 99% | 141c / 97% | 136t / 340q / 99.8% |

With an **unordered** queue, blocking succeeds at 97.8, 91.2, 80.2 and 64.8 percent for
the same four contention values, and the failure inflicts `starvation`. That single
flag, printed by `lsof`, changes blocking from the obvious answer to the second worst
one.

### 12.4 Crossing schedule

| Leg | Crossings | Lock kind | Ordered | Typical C |
|---|---|---|---|---|
| 4 The Narrows | 3 | mutex, mutex, mutex | yes, **no**, yes | 0.25, 0.45, 0.60 |
| 5 The Cistern | 2 | rwlock, semaphore | **no**, yes | 0.55, 0.40 |
| 6 The Gridlock | 2 | mutex, mutex | yes, yes | 0.70, 0.85 |
| 11 The Archive | 1 | rwlock | yes | 0.50 |
| 12 The Arbiter Wall | 1 | monitor | yes | 0.65 |

The second Narrows crossing is unordered and is the first place the player can lose a
Program to a flag they were shown and did not read. The two Gridlock crossings are the
highest contention in the game and both are ordered, which is the game quietly saying
that the danger there is hold-and-wait rather than the queue.

---

## 13. Difficulty tiers

Four tiers. Each one removes assistance rather than adding numbers, and
`kernel_space` removes nearly all of it.

| | `novice` | `operator` | `architect` | `kernel_space` |
|---|---|---|---|---|
| Resource multiplier | 1.35 | 1.00 | 0.80 | 0.65 |
| Depot price factor | 0.80 | 1.00 | 1.15 | 1.35 |
| Affliction frequency | 0.60 | 1.00 | 1.35 | 1.70 |
| Affliction drain multiplier | 0.75 | 1.00 | 1.10 | 1.25 |
| `fatalAfter` multiplier | 1.50 | 1.00 | 0.90 | 0.80 |
| Codex reveals the remedy | yes, immediately | yes, on unlock | after first success | never |
| Codex worked example | yes | yes | yes | yes |
| Codex counterfactual | yes | yes | yes | end of run only |
| Policy change cost | free | free | 15 cycles | 25 cycles |
| Terminal command cost | free | free | 1 bandwidth (writes only) | 2 bandwidth (all) |
| HUD shows working sets | continuously | continuously | on `vmstat` | on `vmstat`, no estimate |
| HUD shows wait-for graph | continuously | on `wfg` | on `wfg` | on `wfg`, no cycle highlight |
| HUD names afflictions | yes | yes | yes | **no, shows UNDIAGNOSED** |
| Scheduler rationale text | yes | yes | no | no |
| Bankers trace shown | full | full | result only | result only |
| Policy hint sold at depots | yes, with remedy | yes, numbers only | yes, numbers only | **not sold** |
| Journal checkpoint sold | yes | yes | yes | **not sold** |
| Reclamation time | 90s | 75s | 65s | 55s |
| Score multiplier | 0.5 | 1.0 | 1.6 | 2.5 |

### 13.1 What each tier is for

**`novice`.** The course, with the answers in the back. The codex entry unlocks the
instant the pathology is inflicted and states the remedy as an instruction. Fatal
clocks run half again as long, so there is time to read. A player who has never seen an
operating system should finish a novice shell run and should have to think to do it.

**`operator`.** The default and the one the curriculum is balanced against. The codex
names the remedy once the entry has unlocked, and the entry unlocks by suffering the
pathology, so the first instance of every affliction in a player's life is solved by
reasoning or not at all. Everything the sim knows is available through the terminal for
free.

**`architect`.** Assistance becomes conditional. The codex gives the concept, the
citation and the player's own trace, and it withholds the remedy until the player has
performed it successfully once, at which point the entry rewrites itself to include it.
Policy changes cost cycles, so experimentation has a price and the player starts
reading before switching. The HUD stops narrating scheduler decisions.

**`kernel_space`.** Nearly all assistance is off.

- Afflictions display as `UNDIAGNOSED` with their drain rate visible and their identity
  hidden. The player diagnoses by observation and by terminal command: a Program losing
  2.0 per tick with a rising fault rate is thrashing, and nothing on screen will say so.
- The codex never states a remedy at any point, for any entry, in any run. It gives the
  chapter and section, the concept in two sentences, and the player's own failure
  trace.
- Counterfactuals are withheld until the end of the run, so the player cannot use the
  replay as a hint mid-journey.
- Policy changes cost 25 cycles and every terminal command costs 2 bandwidth, including
  reads. Information has a price and the budget is 0.65 of normal.
- Depots sell no hints and no checkpoints. There is no rollback in `kernel_space`.
- The scheduler stops explaining itself. `SchedulingDecision.rationale` is still
  produced by the kernel and is not displayed anywhere.

What `kernel_space` keeps, always: the tombstone `cause` line, the affliction drain
numbers, every terminal command, and full determinism with a visible seed. The tier is
harsh and it is never opaque. A player who understands the material can read the state
and act on it, which is the only claim the tier makes.

### 13.2 Unlocking tiers

- `novice` and `operator` are available from the first launch.
- `architect` unlocks on completing any run at `operator`, reaching the Portal.
- `kernel_space` unlocks on completing a run at `architect`, or on two `architect` runs
  that reached leg 11.
- The `compiler` disc class unlocks on completing any run at any tier. The `shell` and
  `daemon` classes are available from the first launch.

---

## 14. The codex

### 14.1 The unlock rule

**An entry unlocks by encountering the pathology, never by reading ahead.** There is no
table of contents that can be browsed to the answer, no chapter list, and no way to
open an entry the run has not earned. The codex is a record of what has happened to
this player, and it is organised chronologically by first encounter rather than by
chapter.

This is the strongest structural decision in the teaching design and it is worth
restating why. A player who reads about thrashing before it happens learns a
definition. A player whose cartographer dies while the ground vanishes and who then
opens an entry containing their own fault rate curve learns a mechanism. The second one
is retained.

Across runs, the *concept* text of a seen entry stays readable in the profile, so
returning players are not forced to re-suffer everything. The worked example and the
counterfactual are per-run and are rebuilt from the current run's data, so the entry a
player opens in run four is about run four.

### 14.2 The entry format

```ts
export interface CodexEntry {
  readonly id: string;
  readonly title: string;
  readonly chapter: ChapterRef;

  /** Two to four sentences. The mechanism, in the tone guide's register. */
  readonly concept: string;

  /** What has to happen in a run before this entry exists at all. */
  readonly unlock: CodexUnlock;

  /** Built from the player's own run. Null until the entry unlocks. */
  readonly workedExample: CodexWorkedExample | null;

  /** Deterministic replay under a different decision. Null when none applies. */
  readonly counterfactual: CodexCounterfactual | null;

  /** The answer. Displayed according to remedyVisibility and difficulty. */
  readonly remedy: AfflictionRemedy | null;
  readonly remedyVisibility: 'immediate' | 'on_unlock' | 'after_first_success' | 'never';

  /** Other entries. Rendered as links, never as a prerequisite chain. */
  readonly related: readonly string[];

  /** Terminal commands that read or change the state this entry is about. */
  readonly commands: readonly string[];

  /** Epitaph template ids that link here. Populated at content build time. */
  readonly epitaphs: readonly string[];
}

export type CodexUnlock =
  | { readonly kind: 'affliction'; readonly id: AfflictionId }
  | { readonly kind: 'termination'; readonly reason: TerminationReason }
  | { readonly kind: 'event'; readonly type: string }   // KernelEventType
  | { readonly kind: 'objective'; readonly id: string }
  | { readonly kind: 'crossing'; readonly option: 'spin' | 'block' | 'monitor' | 'wait' }
  | { readonly kind: 'leg_complete'; readonly leg: LegId };

/** Captured from the run at the moment of unlock. Never authored by hand. */
export interface CodexWorkedExample {
  readonly capturedAtTick: Tick;
  readonly legId: LegId;
  /** One sentence naming what the player did and what the sim did back. */
  readonly summary: string;
  /** Rendered from the kernel event log, oldest first, at most 12 lines. */
  readonly trace: readonly string[];
  /** Named quantities the entry's prose interpolates. */
  readonly metrics: Readonly<Record<string, number>>;
}

/** A real replay, not a written estimate. Ch. 9 determinism is what buys this. */
export interface CodexCounterfactual {
  /** Human phrasing of the alternative: "priority_aging instead of priority". */
  readonly alternative: string;
  /** Index into RunState.decisions of the decision that was changed. */
  readonly decisionIndex: number;
  /** Seed the replay was run under. Identical to the run's own seed. */
  readonly replaySeed: number;
  /** Results of the replay: same keys as workedExample.metrics. */
  readonly projected: Readonly<Record<string, number>>;
  /** One sentence. States the difference in outcomes and nothing else. */
  readonly narrative: string;
}
```

Persistence across runs:

```ts
export interface CodexProfileState {
  /** Entry ids the player has ever unlocked, in any run. */
  readonly seen: readonly string[];
  /** Entry ids whose remedy the player has performed successfully at least once. */
  readonly demonstrated: readonly string[];
  /** First-encounter record, for the lifetime statistics screen. */
  readonly firstSeen: Readonly<Record<string, { runId: string; legId: LegId }>>;
}
```

### 14.3 A filled entry

What `vm.thrashing` looks like at `operator`, opened from VESPER's tombstone at leg 8,
tick 5124.

> **THRASHING**
> Silberschatz, *Operating System Concepts*, 10th ed., Ch. 10.6.
>
> **Concept.** A process thrashes when it spends more time faulting pages in than
> executing. It happens when the resident set is smaller than the working set, so every
> page the process needs has already been evicted by the time it asks for it. CPU
> utilisation rises while useful work falls, and adding more processes makes it worse.
>
> **What happened in your run.** At tick 4980 you raised the degree of multiprogramming
> from 6 to 9. Fault rate went from 22 per thousand ticks to 91 over the next 40 ticks.
> VESPER's resident set fell to 4 frames against a measured working set of 11.
>
> ```
> t4980  policy.degree            6 -> 9
> t4994  memory.thrashing         faultRate 47   severity warning
> t5012  memory.page_evicted      frame 19  page 7   dirty  policy lru
> t5013  memory.page_fault        pid 4  page 7  major
> t5019  memory.page_evicted      frame 22  page 11  dirty  policy lru
> t5020  memory.page_fault        pid 4  page 11  major
> t5041  memory.thrashing         faultRate 91   severity critical
> t5124  process.exited           pid 4  reason thrashing_collapse
> ```
>
> **Remedy.** Reduce the degree of multiprogramming. Fewer processes means more frames
> each, which means working sets fit. Throughput rises by removing work.
>
> **If you had done it.** Replayed from decision 41 with the degree held at 6: fault
> rate peaks at 29, VESPER survives the leg at 71 integrity, and the leg completes 12
> ticks later with a throughput factor of 1.08 instead of 0.71.
>
> **Related.** `vm.working-set`, `vm.degree`, `vm.replacement`, `mem.protection`
> **Commands.** `vmstat`, `free`, `pagetable <pid>`, `top`

The counterfactual paragraph is the highest-value text in the game and it is generated,
not written. It is real: the sim was re-run from the player's own decision log with one
entry changed.

### 14.4 How a tombstone links in

The tombstone is a physical object in the world, standing where the Program derezzed,
and it persists for the remainder of the run at that position on the road. It shows
three things stacked:

1. The `inscription`, large, flat, in the licensed comic register.
2. The `cause`, smaller, beneath it, always, at every difficulty.
3. A single affordance reading `CODEX`, which opens `Epitaph.codexEntry`.

At the end of the run every tombstone is gathered into a memorial line on the debrief
screen, in order of death, and every one of them is still clickable. The epitaph
gallery in the profile keeps them across runs, which turns the player's accumulated
failures into a browsable index of the course.

`Epitaph.codexEntry` is a hard reference. Content build fails if any epitaph names an
entry id that does not exist, and any codex entry whose `epitaphs` array is empty is
flagged in review as a concept with no death attached to it, which usually means the
concept is not being taught by consequence.

---

## 15. Progression and the end-of-run report

### 15.1 What carries across runs

```ts
export interface Profile {
  readonly version: 1;
  codex: CodexProfileState;
  difficultiesUnlocked: DifficultyTier[];
  discClassesUnlocked: DiscClass[];
  /** Every stone from every run, in order. Browsable, clickable, permanent. */
  epitaphGallery: Epitaph[];
  /** Personal best reclamation yield per leg. */
  reclamationBests: Partial<Record<LegId, number>>;
  stats: LifetimeStats;
  bestScores: Partial<Record<`${DiscClass}:${DifficultyTier}`, number>>;
}

export interface LifetimeStats {
  runsStarted: number;
  runsCompleted: number;
  legsReached: Partial<Record<LegId, number>>;
  deathsByReason: Partial<Record<TerminationReason, number>>;
  afflictionsSuffered: Partial<Record<AfflictionId, number>>;
  afflictionsCured: Partial<Record<AfflictionId, number>>;
  crossingsByOption: Record<'spin' | 'block' | 'monitor' | 'wait', number>;
  policiesUsed: Partial<Record<SchedulerId, number>>;
  totalTicks: number;
}
```

**Carried:** codex entries seen, remedies demonstrated, difficulty tier unlocks, disc
class unlocks, the epitaph gallery, reclamation personal bests, lifetime statistics,
best scores per class and tier combination.

**Not carried:** resources, the convoy, afflictions, in-run tombstones, the decision
log, the seed, policy settings, leg progress, and anything else in `RunState`. Every
run starts at the Boot Sector with five Programs at 100 integrity and the disc class
allocation.

**Deliberately not carried:** any mechanical advantage at all. A returning player is
faster because they know what a lock convoy looks like, and for no other reason.
Nothing in the profile makes the numbers better. This is the difference between a
teaching game and a progression game, and the moment a run starts with a permanent plus
ten percent to anything, the codex stops being the reward.

### 15.2 Score

Filling `ScoreBreakdown`:

```
survivors        = 1200 * livingProgramsAtPortal                        (0 to 6000)
throughput       = 40 * workloadCompletionsAcrossRun                    (~1500 to 3000)
efficiency       = min(2500, 2 * unspentCycles + 1 * unspentQuota)      (0 to 2500)
correctness      = 150 * goodDecisions - 100 * costlyDecisions - 400 * fatalDecisions
conceptsMastered = 180 * objectivesMet                                  (42 objectives)
classMultiplier  = shell 1.0, daemon 2.0, compiler 3.5
difficultyFactor = novice 0.5, operator 1.0, architect 1.6, kernel_space 2.5

total = round(
  (survivors + throughput + efficiency + correctness + conceptsMastered)
  * classMultiplier * difficultyFactor
)
```

`goodDecisions`, `costlyDecisions` and `fatalDecisions` come straight from
`DecisionRecord.outcome`, which the sim sets retrospectively when the consequence
arrives rather than at the moment of choice. A decision that looked fine and killed
someone forty ticks later is marked `fatal` at tick 40, which is the honest accounting.

A failed run still scores. It scores what it earned up to the failure, with
`survivors` counted as zero and no completion bonus. The score screen is shown either
way.

### 15.3 The end-of-run report

Five panels, in this order, on one scrolling surface.

**Panel 1: the record.** For a completed run, the exit line: five names, which ones
went through, tick count, exit code. For a failed run, the last stone, full size, with
its cause and its codex link. The memorial line of every tombstone from the run runs
along the bottom of this panel in death order, and every one is clickable.

**Panel 2: score.** The six `ScoreBreakdown` components as a table with the arithmetic
shown, then the multipliers, then the total. No animation, no counting up. The
efficiency line names the unspent cycles and quota explicitly, because a player who
finished with 900 unspent cycles should see that they crossed the Reach on lean rations
for no reason.

**Panel 3: concepts demonstrated.** Every `LearningObjective` in `objectivesMet`,
grouped by chapter, each with the tick and leg where it was assessed and one line
saying what the player did.

> Ch. 5.3.4, "choose a policy that prevents indefinite blocking". Leg 3, tick 1180.
> You switched from priority to priority_aging 12 ticks after SABLE's first starvation
> warning and before her drain reached 30.

**Panel 4: concepts avoided.** The panel that makes the game a course. Every objective
never assessed, every affliction never suffered, every scheduler never run, and every
crossing option never taken, stated without judgement.

> **Never encountered:** `livelock`, `false_sharing`, `bit_rot`.
> **Never run:** `fcfs`, `sjf`, `lfu`, `worst_fit`, `clook`.
> **Never chosen at a crossing:** monitor.
> **Objectives not assessed:** 11 of 42.
>
> You crossed all nine critical sections by blocking. It worked. You have not seen what
> spinning costs at high contention and the game did not make you find out.

This panel is why the game is replayable for a student rather than a player. It is a
syllabus with the covered parts crossed off, generated from their own run, and it names
the specific thing they should go and do next.

**Panel 5: the counterfactual replay.** The game scans `RunState.decisions` for the
single entry with the largest negative score impact, re-runs the deterministic sim from
that decision index with the alternative applied, and offers the divergence.

> **Decision 41, leg 8, tick 4980: degree of multiprogramming 6 to 9.**
> Replay this leg with the degree held at 6.

Accepting plays the leg again as a non-interactive replay at 4x speed, with the two
timelines drawn side by side in the same 3D space: the run that happened in one
colour, the run that could have in another, diverging at tick 4980 and never
converging. VESPER's process line ends in one of them and does not in the other.

The replay is free, changes no score, and is offered once. It is the strongest teaching
device the determinism requirement buys, and it is the reason section 9 of the design
brief is a hard constraint rather than an engineering preference.

At `kernel_space` this panel is the only place counterfactuals appear at all, which
makes finishing a `kernel_space` run the only way to see all of them at once.

### 15.4 What the player is offered next

Three affordances at the foot of the report, in this order:

1. **Run again**, same class and tier, new seed.
2. **The thing you avoided**: a preconfigured run that guarantees an encounter with the
   highest-value concept from panel 4, by seeding the relevant leg's event table toward
   it. Named after the concept, never after the difficulty.
3. **Next tier**, when the run just completed unlocked one.

No daily challenge, no streak, no reward for returning. The offer is always another
crossing of the same road, which is what the fiction is about.

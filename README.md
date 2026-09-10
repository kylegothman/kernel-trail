# KERNEL TRAIL

*A journey across the Substrate.*

An Oregon-Trail-structured game that teaches a full college operating systems
course. You lead a convoy of five Programs from the Boot Sector to the Portal,
and every hazard on the road is a real OS pathology with a real remedy.

Built in TypeScript and Three.js. Runs in the browser, no backend, no install.

---

## The idea

Oregon Trail taught a generation about dysentery because the disease had
mechanical consequences you had to plan around, and because it killed people you
had named. Deadlock, thrashing and starvation work the same way here.

The game runs a real deterministic operating system simulator underneath: a
process table, seven CPU scheduling algorithms, an MMU with page tables and a
TLB, six page replacement policies, semaphores and monitors, wait-for graph
deadlock detection with Banker's algorithm, six disk scheduling policies, a
journaling file system, and a protection ring model. Every minigame is a
different view onto that one simulator, and every party member is a real process
with a real PCB. When LUMEN starves to death, it is because the scheduler you
chose starved it.

The curriculum follows Silberschatz, Galvin and Gagne, *Operating System
Concepts*, 10th edition, chapters 1 through 18.

## The journey

| # | Leg | Chapters | Concept | How it kills you |
|---|---|---|---|---|
| 0 | The Boot Sector | 1-2 | Kernel vs user mode, system calls | outfitting only |
| 1 | The Fork Fields | 3 | Processes, PCB, states, IPC | unreaped zombie |
| 2 | The Weave | 4 | Threads, multicore, Amdahl's law | over-threading |
| 3 | Quantum Pass | 5 | FCFS, SJF, SRTF, priority, RR, MLFQ | starvation |
| 4 | The Narrows | 6 | Critical sections, mutexes, semaphores | race condition |
| 5 | The Cistern | 7 | Bounded buffer, readers-writers, philosophers | producer-consumer collapse |
| 6 | The Gridlock | 8 | Coffman conditions, Banker's algorithm | deadlock |
| 7 | The Allocation Yards | 9 | Contiguous allocation, paging, TLB | fragmentation |
| 8 | The Drowned Reach | 10 | Demand paging, replacement, working set | thrashing |
| 9 | The Platters | 11 | Disk scheduling, NVM, RAID | seek starvation |
| 10 | The Bus | 12 | Polling vs interrupts, DMA, drivers | interrupt storm |
| 11 | The Archive | 13-15 | Allocation methods, free space, journaling | unjournaled corruption |
| 12 | The Arbiter Wall | 16-17 | Access matrix, rings, RBAC | privilege escalation |
| 13 | The Portal | 18 | Hypervisors, trap-and-emulate, containers | final scored run |

Leg 8 is the showpiece. Demand paging is rendered as an ocean that becomes solid
ground only where you step. Pages you have not touched do not exist yet. Eviction
dissolves the ground behind you. Thrashing is the moment the ground starts
failing faster than it forms, and you have to reduce the degree of
multiprogramming while standing on almost nothing.

## The convoy

| Program | Role | Passive | Dies to |
|---|---|---|---|
| LUMEN | compiler | cuts service time 15% | thrashing |
| SABLE | sentinel | resists starvation 3x longer | deadlock |
| ORRERY | codec | makes corruption recoverable | protection faults |
| KESTREL | courier | halves device latency and seek cost | interrupt storms |
| VESPER | cartographer | sharper working set estimation | fragmentation |

Losing one permanently removes its passive. Lose ORRERY and later corruption
cannot be repaired. Lose KESTREL and leg 10 gets much harder. The convoy is a
difficulty curve you control by playing well.

## Running it

```bash
npm install
npm run dev        # vite dev server
npm run typecheck  # tsc --noEmit
npm run test       # vitest
npm run build      # production bundle
```

Requires Node 22 or newer. Targets 60 fps on Apple silicon integrated graphics,
WebGPU where available and WebGL2 as the fallback.

## Architecture

```
src/
  kernel/     deterministic OS simulator, headless, zero render dependencies
  game/       run state, convoy, resources, events, scoring, save
  legs/       one self-contained module per journey leg
  world/      diegetic 3D representations of kernel structures
  render/     renderer, post-processing, materials, focus camera
  terminal/   the in-game shell
  audio/      procedural score and effects
  ui/         HUD and codex, the only screen-space layer
  design/     design tokens, the single source of colour and type
  platform/   capability detection and quality tiers
```

Dependency direction is strictly one way: `legs -> game -> kernel`. The visual
layers read the kernel's event stream and never reach into its internals. A test
enforces that nothing under `src/kernel` imports Three.js, touches the DOM, or
calls `Math.random`, `Date.now` or `performance.now`.

### Determinism

A run is a pure function of its seed plus the player's decision log. That buys
four things:

1. The end-of-run debrief can replay your run under a different policy and show
   you what would have happened. This is the strongest teaching device in the
   game.
2. Bugs reproduce exactly from a save file.
3. The simulator is unit-testable against the textbook's own worked examples.
4. Saves are small and tamper-evident.

### Diegetic 3D

Every data structure is a physical object. Page frames are lit slabs in a vault.
The ready queue is a procession. The wait-for graph is a ring of beams between
Programs. Because reading a page table in perspective is hard, engaging with a
structure locks the camera to a head-on orthographic framing and billboards its
labels to that plane. There are no flat 2D simulation overlays.

## Documentation

| Document | What it covers |
|---|---|
| `docs/00-DESIGN-BRIEF.md` | The authoritative brief. Start here. |
| `docs/01-ARCHITECTURE.md` | Layers, game loop, rendering, save, testing |
| `docs/02-KERNEL-SIM-SPEC.md` | Every algorithm, with worked examples as test vectors |
| `docs/03-VISUAL-BIBLE.md` | Design tokens, materials, post chain, focus camera |
| `docs/04-NARRATIVE-BIBLE.md` | World, Programs, economy, event tables, epitaphs |
| `docs/05-CURRICULUM-MAP.md` | Chapter mapping, objectives, assessment, misconceptions |
| `docs/astra/` | Sequenced build packages, 20 engine and 14 leg |

Start with `docs/astra/00-ASTRA-BRIEFING.md` and `docs/astra/00-PACKAGE-INDEX.md`.

## A note on influences

The visual register owes an obvious debt to a certain pair of films about people
inside computers. Everything here is original: original title, original names,
original world. No marks, characters or designs from that property appear in this
project, and none should ever be added.

## Licence

Not yet chosen.

# KERNEL TRAIL - Design Brief

**Version 1.0. This document is authoritative. Where any other document disagrees with it, this one wins.**

---

## 1. What this is

An Oregon-Trail-structured educational game that teaches a full college operating
systems course. The player leads a convoy of five Programs from the Boot Sector to
the Portal across a hostile computational landscape, and every hazard on the road is
a real OS pathology with a real remedy.

The curriculum is Silberschatz, Galvin and Gagne, *Operating System Concepts*, 10th
edition, chapters 1 through 18. The journey order is the book's order.

**Design thesis:** Oregon Trail taught a generation about dysentery because the
disease had mechanical consequences the player had to plan around, not because it
was explained. Deadlock, thrashing and starvation are taught the same way here. The
player is never lectured before a concept; the concept happens to them first.

## 2. Non-negotiable constraints

| Constraint | Value |
|---|---|
| Language | TypeScript, strict mode, no `any` in committed code |
| Renderer | Three.js, WebGPU preferred, WebGL2 fallback required |
| Target | 60 fps on an Apple silicon MacBook Air at 1440x900, integrated GPU |
| Backend | None. Static hosting. IndexedDB saves, exportable JSON. |
| Audio | Fully procedural Web Audio. No audio files ship. |
| Art assets | Fully procedural. No modelling, texturing or licensing pipeline. |
| Dimensionality | Full 3D throughout. No flat 2D overlay panels for simulation data. |
| Failure model | Roguelike permadeath, concept-gated |
| Audience | Assumes zero operating systems background |
| IP | Aesthetic homage only. Original names, original title, no Disney marks. |

## 3. The IP line

The visual language of the *Tron* films is the reference: black void, emissive
circuitry, hard-edged volumetric light, derezzing, identity discs, light ribbons,
the sense of a vast dark computational space with a horizon of light.

What is forbidden, permanently, in code, art, copy and marketing:

- The words Tron, ENCOM, Flynn, CLU, Quorra, Rinzler, Sark, Kevin, Sam, Gem,
  Castor, Zuse, Yori, Dumont, Ram, Bit, MCP, Recognizer, Grid (capitalised as a
  proper noun for the setting), Sea of Simulation, Solar Sailer, Light Cycle as a
  proper noun, or Isomorphic Algorithm.
- Disney or Tron logos, the Tron typeface, or any recreation of a specific shot,
  poster, vehicle silhouette or character design from the films.

The setting's proper noun is **the Substrate**. Vehicles are **runners**. The
hostile enforcement programs are **arbiters**. The final destination is **the
Portal**, which is a generic computing term and safe. Where a leg name in earlier
drafts borrowed a film phrase, the shipping name is given in the curriculum map
and that name is final.

## 4. The journey

Fourteen legs. Leg 0 is outfitting; leg 13 is the finale.

| # | Leg | Chapters | Concept | Signature failure |
|---|---|---|---|---|
| 0 | The Boot Sector | 1-2 | What an OS is, kernel vs user mode, system calls | none, this is outfitting |
| 1 | The Fork Fields | 3 | Processes, PCB, states, context switch, IPC | unreaped zombie |
| 2 | The Weave | 4 | Threads, multicore, Amdahl's law | over-threading |
| 3 | Quantum Pass | 5 | FCFS, SJF, SRTF, priority, RR, MLFQ | starvation, first policy death |
| 4 | The Narrows | 6 | Critical sections, Peterson's, mutexes, semaphores | race condition |
| 5 | The Cistern | 7 | Bounded buffer, readers-writers, dining philosophers | producer-consumer collapse |
| 6 | The Gridlock | 8 | Coffman conditions, wait-for graphs, Banker's | deadlock |
| 7 | The Allocation Yards | 9 | Contiguous allocation, fragmentation, paging, TLB | no fit, fragmentation |
| 8 | The Drowned Reach | 10 | Demand paging, replacement, Belady, working set | thrashing |
| 9 | The Platters | 11 | HDD scheduling, NVM, RAID | seek starvation |
| 10 | The Bus | 12 | Polling vs interrupts, DMA, buffering, drivers | interrupt storm |
| 11 | The Archive | 13-15 | Directories, allocation methods, free space, journaling | unjournaled corruption |
| 12 | The Arbiter Wall | 16-17 | Threats, crypto, auth, access matrix, rings, RBAC | privilege escalation |
| 13 | The Portal | 18 | Hypervisors, trap-and-emulate, containers | final scored run |

**Leg 8 is the showpiece.** Demand paging is rendered as an ocean that materialises
into solid ground only where the convoy steps. Pages you have not touched do not
exist yet. Eviction visibly dissolves ground behind you. Thrashing is the moment
the ground starts vanishing faster than it appears, and the player has to reduce
the degree of multiprogramming while standing on almost nothing.

## 5. The Oregon Trail skeleton, remapped

| Original | KERNEL TRAIL | Teaches |
|---|---|---|
| Banker, carpenter, farmer | Disc class: shell, daemon, compiler | difficulty and scoring |
| Buying oxen, food, parts | Requesting cycles, quota, blocks, bandwidth via syscall traps | Ch. 2.3 system calls |
| Pace: grueling to steady | Scheduler aggression, which sets the quantum | Ch. 5.3.3 |
| Rations: filling to bare bones | Frames allocated per process | Ch. 10.5 |
| River crossings | Critical sections: spin-wait, block on a semaphore, pay for a monitor, or wait | Ch. 6 |
| Forts and trading posts | Kernel service depots, priced in cycles | Ch. 2 |
| Hunting for food | Reclamation: hunt leaked blocks and free-space fragments | Ch. 10.8, 14.5 |
| "You have died of dysentery" | Derezz tombstones naming the real cause | all |
| Wagon breakdowns | Afflictions: priority inversion, memory leak, lock convoy, bit rot | all |

Every affliction has a remedy the player is expected to derive from the concept.
Nothing tells the player the answer until the codex entry is unlocked, and the
codex entry unlocks by encountering the pathology, not by reading ahead.

## 6. The convoy

Five named Programs. Each is a real process in the simulator with a real PCB, so
its death is a scheduling outcome rather than a scripted beat.

| Program | Role | Passive | Active ability | Vulnerable to |
|---|---|---|---|---|
| LUMEN | compiler | reduces service time of all workloads by 15% | recompile: halve one process's remaining burst | thrashing |
| SABLE | sentinel | immune to starvation for 3x the normal threshold | shield: make one resource preemptible for 20 ticks | deadlock |
| ORRERY | codec | corruption is recoverable when ORRERY lives | restore: rebuild one corrupted inode from the journal | protection faults |
| KESTREL | courier | halves device latency and seek cost | prefetch: satisfy the next 5 page faults instantly | interrupt storms |
| VESPER | cartographer | working set estimation is 30% more accurate | remap: rebuild one page table with optimal locality | fragmentation |

Losing a Program permanently removes its passive. Losing ORRERY means later
corruption is unrecoverable. Losing KESTREL makes leg 10 substantially harder. The
convoy is a difficulty curve the player controls by playing well.

## 7. The player's verbs

Always available:

- Set scheduler policy and quantum
- Set page replacement policy
- Set disk scheduling policy
- Set allocation strategy
- Set pace, rations and degree of multiprogramming
- Open the terminal
- Open the codex

The terminal is a real shell over the live simulator: `ps`, `top`, `kill`, `nice`,
`free`, `vmstat`, `iostat`, `lsof`, `mount`, `bankers`, `wfg`, `pagetable`,
`trace`, `man`. Every command reads or writes actual simulator state. `man` pages
are written to teach.

## 8. Diegetic 3D and the focus camera

Every data structure is a physical object in the world. Page frames are lit slabs
in a vault. The ready queue is a procession. The wait-for graph is a ring of beams
between Programs. The disk queue is a rotating platter with the head arm above it.

Because reading a page table in perspective is genuinely hard, engaging with any
structure smoothly locks the camera to a head-on orthographic framing, and labels
billboard to that plane. The player is always inside the 3D world and never fights
perspective while thinking. There are no flat 2D simulation overlays. The HUD is
the only screen-space layer and it carries status, not data structures.

## 9. Determinism

The whole run is a pure function of its seed plus the player's decision log. This
buys four things that matter more than they sound:

1. The end-of-run debrief can replay the run under a different policy and show the
   player the counterfactual, which is the strongest teaching device in the game.
2. Bugs are reproducible from a save file.
3. The simulator is unit-testable against textbook worked examples.
4. Save files are small and cheat-detectable.

Enforced by test: nothing under `src/kernel` may import Three.js, touch the DOM, or
call `Math.random`, `Date.now` or `performance.now`.

## 10. Repository layout

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
  app/        bootstrap, game loop, scene director
tests/        vitest, kernel and game layers only
docs/         this brief and its companion specifications
docs/astra/   sequenced build packages for the implementing agent
```

## 11. Build phasing

**Phase 1, engine.** Kernel simulator, renderer, design tokens, focus camera,
terminal, save system, HUD shell, audio engine. Proven by unit tests and one
throwaway test level. Nothing in phase 1 is leg-specific.

**Phase 2 onward, legs.** Each leg is an independent work package implementing the
`Leg` interface against frozen phase 1 contracts. Legs do not import each other and
can be built in parallel.

The interfaces in `src/kernel/types.ts` and `src/game/types.ts` are frozen at the
end of phase 1. A leg that needs a contract change escalates rather than editing
the contract, because every other leg in flight depends on it.

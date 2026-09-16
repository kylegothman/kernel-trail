# WP-19 tables, document corrections, and integration handoffs

This is a source comparison and handoff inventory for the `wp-19` worktree. The full integration tree passed all four exact gates; all four commits passed their independent gates and the branch is pushed. The controlling decisions are the accepted preflight, the user's R1-R14 rulings, and the six separately approved integrations, now applied. The confirmed integration run passed 127 files / 2,156 tests in 78.49 seconds with no skips; the final report records all per-commit gates and SHAs. The numeric references below are from `docs/04-NARRATIVE-BIBLE.md`; implementation references are relative to `/Users/kylegothman/dev/kt-wp19`.

In paired numeric cells, **D / I** means **document value / implementation value**. A formula-derived document expectation is identified as such. `null` is the actual absence of a fatal deadline or affliction, not zero. Source tests are named as evidence locations; all passed in the confirmed full integration run.

## 1. Pace: every numerical column

Source: narrative 6.1. Implementation: `src/game/travel/paceRations.ts`. Evidence: `tests/game/travel/paceRations.test.ts`.

| Pace | Quantum D / I | Segments/tick D / I | Base cycles/segment D / I | Quantum overhead D / I | Effective cycles/segment D / I | Arrival rate D / I |
|---|---:|---:|---:|---:|---:|---:|
| conservative | 16 / 16 | 0.6 / 0.6 | 1.4 / 1.4 | 1.125 / 1.125 | 1.575 / 1.575 | 0.70 / 0.70 |
| steady | 8 / 8 | 1.0 / 1.0 | 2.0 / 2.0 | 1.25 / 1.25 | 2.50 / 2.50 | 1.00 / 1.00 |
| aggressive | 4 / 4 | 1.5 / 1.5 | 3.0 / 3.0 | 1.50 / 1.50 | 4.50 / 4.50 | 1.45 / 1.45 |
| reckless | 2 / 2 | 2.1 / 2.1 | 4.4 / 4.4 | 2.00 / 2.00 | 8.80 / 8.80 | 2.00 / 2.00 |

`quantumOverhead = 1 + 2 / quantum`; effective cycle cost is the product of base cost and overhead. The binding writes the active scheduler's quantum. It uses the invariant view's current scheduler rather than reinstating the initial scheduler from configuration. An explicit replay quantum override takes precedence over the pace-derived quantum, as R4 requires.

### Corrected 80-segment worked example

Source: narrative 6.1, corrected by R8. Five living Programs, standard rations. The runtime uses `ceil(segments / segmentsPerTick)`, prorates final-tick movement and cycles, and retains the full tick's quota and integrity cost.

| Pace | Cycles D / I | Ticks D / I | Quota D / I | Event draws D / I |
|---|---:|---:|---:|---:|
| conservative | 126 / 126 | **133 / 134** | **333 / 335** | 13 / 13 |
| steady | 200 / 200 | 80 / 80 | 200 / 200 | 8 / 8 |
| aggressive | 360 / 360 | **53 / 54** | **133 / 135** | 5 / 5 |
| reckless | 704 / 704 | **38 / 39** | **95 / 97.5** | 4 / 4 |

The document's approximate context-switch column is explanatory, not an authored travel charge or promised simulator measurement. Its prose ratios also disagree with its numeric table: conservative's continuous quota ratio is 1.667 times steady, not 2.6; the corrected finite example is 335/200 = 1.675. Reckless costs 704/200 = 3.52 times steady's cycles, not 5.6. Thirteen versus eight event draws is 62.5% more, which the prose rounds to 60%.

## 2. Rations and the game/kernel split

Source: narrative 6.2. Implementation and evidence: `src/game/travel/paceRations.ts`, `src/game/travel/policyBinding.ts`, `tests/game/travel/paceRations.test.ts`.

| Rations | Frames/Program D / I | Reserved at 5 alive D / I | Quota/tick at 5 alive D / I | Integrity loss/tick D / I | Affliction probability D / I | Affliction D / I |
|---|---:|---:|---:|---:|---:|---|
| generous | 4.0 / 4.0 | 20 / 20 | 4.0 / 4.0 | 0 / 0 | 0 / 0 | null / null |
| standard | 2.5 / 2.5 | 12.5 / 12.5 | 2.5 / 2.5 | 0 / 0 | 0 / 0 | null / null |
| lean | 1.5 / 1.5 | 7.5 / 7.5 | 1.5 / 1.5 | 0.3 / 0.3 | 0.04 / 0.04 | cache_thrash / cache_thrash |
| starved | 0.8 / 0.8 | 4 / 4 | 0.8 / 0.8 | 1.0 / 1.0 | 0.06 / 0.06 | thrashing / thrashing |

The zero costs/probabilities for generous and standard are the package's no-loss/no-roll interpretation, rather than separately printed numeric cells. Narrative's `+0.3 integrity per tick` and `+1.0 integrity per tick` denote damage; the surrounding prose says they cost integrity. The implementation subtracts these amounts. `quotaPerTick = framesPerProgram * aliveCount * 0.2`; zero living Programs costs zero quota.

The user corrected the earlier V4 claim that kernel `rations.ts` is unreferenced. Both `MemorySubsystem.ts` and `demandPaging.ts` use the kernel allocation table. The approved binding calls the real method:

```ts
setFramePolicy(
  rations: Rations,
  scheme: AllocationScheme = 'equal',
  scope: ReplacementScope = 'local',
): void
```

The binding preserves the active scheme and scope. The **game table pays quota**; the **kernel table allocates memory**. The game reservation values above are not a claim that the kernel guarantees or pins exactly those fractional frames for each bound convoy Program. That protected per-Program floor remains a kernel-track API handoff.

## 3. Starting ledgers: all twelve class/tier combinations

Source: narrative 5.2 and tier factors in 13. Implementation: `src/game/travel/ledger.ts`; initialization: `src/game/replay/runReplay.ts`. Evidence: `tests/game/economyCurve.test.ts`.

Base `(cycles, quota, blocks, bandwidth cap)` vectors are shell `(1600, 900, 120, 60)`, daemon `(1100, 650, 160, 45)`, and compiler `(700, 420, 90, 30)`. The package floors every component after multiplying by the resource factor. The D column below is this source-derived expectation; only the compiler/architect worked example is printed as a complete scaled row in the narrative.

| Class | Tier | Factor D / I | D: scaled and floored vector | I: starting vector |
|---|---|---:|---|---|
| shell | novice | 1.35 / 1.35 | 2160, 1215, 162, 81 | 2160, 1215, 162, 81 |
| shell | operator | 1.00 / 1.00 | 1600, 900, 120, 60 | 1600, 900, 120, 60 |
| shell | architect | 0.80 / 0.80 | 1280, 720, 96, 48 | 1280, 720, 96, 48 |
| shell | kernel_space | 0.65 / 0.65 | 1040, 585, 78, 39 | 1040, 585, 78, 39 |
| daemon | novice | 1.35 / 1.35 | 1485, 877, 216, 60 | 1485, 877, 216, 60 |
| daemon | operator | 1.00 / 1.00 | 1100, 650, 160, 45 | 1100, 650, 160, 45 |
| daemon | architect | 0.80 / 0.80 | 880, 520, 128, 36 | 880, 520, 128, 36 |
| daemon | kernel_space | 0.65 / 0.65 | 715, 422, 104, 29 | 715, 422, 104, 29 |
| compiler | novice | 1.35 / 1.35 | 945, 567, 121, 40 | 945, 567, 121, 40 |
| compiler | operator | 1.00 / 1.00 | 700, 420, 90, 30 | 700, 420, 90, 30 |
| compiler | architect | 0.80 / 0.80 | 560, 336, 72, 24 | 560, 336, 72, 24 |
| compiler | kernel_space | 0.65 / 0.65 | 455, 273, 58, 19 | 455, 273, 58, 19 |

Ordinary leg entry refills bandwidth to 60% of the scaled cap, retaining fractions; depot entry refills it to 100%. Compiler/architect therefore refills to 14.4 ordinarily and 24 at a depot. Purchased bandwidth lots can exceed the cap.

### Leg lengths, steady costs, and base dividends

Sources: narrative 5.3-5.4. Implementation: `src/game/travel/segments.ts`, `src/game/travel/ledger.ts`. Steady costs below apply to cycles and, with five alive at standard rations, quota. Dividend columns are shell/daemon at throughput factor 1.0, before credit or checkpoint effects.

| # | Leg | Segments D / I | Steady cost D / I | Depot D / I | Base dividend D / I |
|---|---|---:|---:|---|---:|
| 0 | Boot Sector | 0 / 0 | 0 / 0 | no / no | 0 / 0 |
| 1 | The Fork Fields | 60 / 60 | 150 / 150 | yes / yes | 66 / 66 |
| 2 | The Weave | 65 / 65 | **163 / 162.5** | no / no | 72 / 72 |
| 3 | Quantum Pass | 70 / 70 | 175 / 175 | yes / yes | 78 / 78 |
| 4 | The Narrows | 75 / 75 | **188 / 187.5** | no / no | 84 / 84 |
| 5 | The Cistern | 75 / 75 | **188 / 187.5** | yes / yes | 90 / 90 |
| 6 | The Gridlock | 80 / 80 | 200 / 200 | no / no | 96 / 96 |
| 7 | The Allocation Yards | 85 / 85 | **213 / 212.5** | yes / yes | 102 / 102 |
| 8 | The Drowned Reach | 100 / 100 | 250 / 250 | **no / no** | 108 / 108 |
| 9 | The Platters | 85 / 85 | **213 / 212.5** | yes / yes | 114 / 114 |
| 10 | The Bus | 80 / 80 | 200 / 200 | no / no | 120 / 120 |
| 11 | The Archive | 90 / 90 | 225 / 225 | yes / yes | 126 / 126 |
| 12 | The Arbiter Wall | 85 / 85 | **213 / 212.5** | yes / yes | 132 / 132 |
| 13 | The Portal | 70 / 70 | 175 / 175 | no / no | 138 / 138 |
| Total, legs 1-13 | | 1020 / 1020 | **2553 / 2550** | 7 / 7 | 1326 / 1326 |

Boot Sector's zero segment/dividend row comes from the package, not a printed row in narrative 5.3. Runtime preserves fractional ledgers. The designed throughput target is a required injected provider; no target is invented. `throughputFactor` is clamped to `[0.6, 1.4]`. Compiler dividend multiplier is 1.25. Credit reduces the resulting dividend by 25%; a checkpoint-protected retry receives no dividend.

## 4. Thirteen-row class curve: analytical fixture, not live travel

Source: narrative 5.5. Evidence: `tests/game/economyCurve.test.ts`. The approved analytical fixture uses rounded per-leg costs from the printed 5.3 rows, keeps fractional compiler dividends internally, and displays half away from zero. It excludes emergency credit, deaths, reclamation, and purchases. Runtime instead uses fractional costs, mandatory credit rules, and actual convoy survival, so it is a different model.

| After leg | Shell D / fixture | Daemon D / fixture | Compiler D / fixture |
|---|---:|---:|---:|
| 1 | 1516 / 1516 | 1016 / 1016 | 633 / 633 |
| 2 | 1425 / 1425 | 925 / 925 | 560 / 560 |
| 3 | 1328 / 1328 | 828 / 828 | 482 / 482 |
| 4 | 1224 / 1224 | 724 / 724 | 399 / 399 |
| 5 | 1126 / 1126 | 626 / 626 | 324 / 324 |
| 6 | 1022 / 1022 | 522 / 522 | 244 / 244 |
| 7 | 911 / 911 | 411 / 411 | 158 / 158 |
| 8 | 769 / 769 | 269 / 269 | 43 / 43 |
| 9 | 670 / 670 | 170 / 170 | -28 / -28 |
| 10 | 590 / 590 | 90 / 90 | not printed / no asserted source cell |
| 11 | 491 / 491 | -9 / -9 | not printed / no asserted source cell |
| 12 | 410 / 410 | not printed / no asserted source cell | not printed / no asserted source cell |
| 13 | 373 / 373 | not printed / no asserted source cell | not printed / no asserted source cell |

The blank document cells are not zero and are not invented acceptance values. Examples of the fixture's display rule are `632.5 -> 633` and `-27.5 -> -28`. JavaScript's `Math.round(-27.5)` alone would produce the wrong displayed compiler deficit.

## 5. Depot prices: all 49 operator cells

Source: narrative 5.7. Implementation: `src/game/depot/prices.ts`; transactions: `src/game/depot/Depot.ts`. Evidence: `tests/game/depot/prices.test.ts`.

`price(base, legIndex, tier) = round(base * (1 + 0.09 * legIndex) * depotTierFactor)`. Cycles and blocks round independently. Depot tier factors are novice 0.80, operator 1.00, architect 1.15, kernel_space 1.35. These are distinct from starting-resource factors.

| Item | Unit D / I | Base cycles D / I | Base blocks D / I |
|---|---|---:|---:|
| Quota lot | 25 quota / 25 quota | 50 / 50 | 0 / 0 |
| Block lot | 10 blocks / 10 blocks | 30 / 30 | 0 / 0 |
| Bandwidth lot | 5 bandwidth / 5 bandwidth | 20 / 20 | 0 / 0 |
| Repair | 10 integrity / 10 integrity | 15 / 15 | 8 / 8 |
| Policy hint | one service / one service | 60 / 60 | 0 / 0 |
| Journal checkpoint | one service / one service | 90 / 90 | 25 / 25 |
| Recruit | one per run / one per run | 220 / 220 | 40 / 40 |

Each cell below is **document price / implementation price**, with `c` for cycles and `b` for blocks. A cycle-only item has zero block cost on both sides.

| Item | Leg 1 D / I | Leg 3 D / I | Leg 5 D / I | Leg 7 D / I | Leg 9 D / I | Leg 11 D / I | Leg 12 D / I |
|---|---|---|---|---|---|---|---|
| Quota lot | 55c / 55c | 64c / 64c | 73c / 73c | 82c / 82c | 91c / 91c | 100c / 100c | 104c / 104c |
| Block lot | 33c / 33c | 38c / 38c | 44c / 44c | 49c / 49c | 54c / 54c | 60c / 60c | 62c / 62c |
| Bandwidth lot | 22c / 22c | 25c / 25c | 29c / 29c | 33c / 33c | 36c / 36c | 40c / 40c | 42c / 42c |
| Repair | 16c+9b / 16c+9b | 19c+10b / 19c+10b | 22c+12b / 22c+12b | 24c+13b / 24c+13b | 27c+14b / 27c+14b | 30c+16b / 30c+16b | 31c+17b / 31c+17b |
| Policy hint | 65c / 65c | 76c / 76c | 87c / 87c | 98c / 98c | 109c / 109c | 119c / 119c | 125c / 125c |
| Journal checkpoint | 98c+27b / 98c+27b | 114c+32b / 114c+32b | 131c+36b / 131c+36b | 147c+41b / 147c+41b | 163c+45b / 163c+45b | 179c+50b / 179c+50b | 187c+52b / 187c+52b |
| Recruit | 240c+44b / 240c+44b | 279c+51b / 279c+51b | 319c+58b / 319c+58b | 359c+65b / 359c+65b | 398c+72b / 398c+72b | 438c+80b / 438c+80b | 458c+83b / 458c+83b |

Daemon repair blocks are `ceil(alreadyRoundedBlockPrice / 2)`, so the first depot's repair is 16 cycles plus 5 blocks. A Program critical on entry can recover at most 30 integrity during that visit even if its status changes while being repaired. Repair does not remove afflictions or reset their clocks. Transactions recheck the current ledger; a stale catalogue cannot authorize an unaffordable purchase.

Hints and checkpoints are unavailable at kernel_space. A recruit requires a derezzed Program and is limited to one per run. It reuses the closed member id with a `-2` display name, starts at 100 integrity without afflictions, retains the original tombstone, and has one fewer active charge per leg. Its passive factor is 0.6 in runner-owned state; the codec passive does not return. The replacement binds to a new pid when the next leg populates.

## 6. All thirteen afflictions and the approved termination mapping

Sources: narrative 7.1 and targeted remedy payloads in 7.2; accepted preflight section 3 for termination reasons. Implementation: `src/game/afflictions/table.ts`. The mapping is an approved approximation into the existing frozen `TerminationReason` union, not a claim that the narrative provides thirteen exact kernel reasons.

| Affliction | Display name D / I | Drain/tick D / I | Fatal ticks D / I | Remedy kind D / I | Document sections -> implementation sections | Approved termination reason / implementation |
|---|---|---:|---:|---|---|---|
| priority_inversion | Priority Inversion / Priority Inversion | 0.8 / 0.8 | null / null | terminal / terminal | 6.6, 5.3.4 -> 6.6, **5.3.3** | starvation / starvation |
| memory_leak | Memory Leak / Memory Leak | 0.5 / 0.5 | null / null | terminal / terminal | 9.1, 10.8 -> 9.1, 10.8 | out_of_memory / out_of_memory |
| starvation | Starvation / Starvation | 1.2 / 1.2 | 180 / 180 | set_scheduler / set_scheduler | 5.3.4 -> **5.3.3** | starvation / starvation |
| thrashing | Thrashing / Thrashing | 2.0 / 2.0 | 90 / 90 | reduce_degree / reduce_degree | 10.6 -> 10.6 | thrashing_collapse / thrashing_collapse |
| lock_convoy | Lock Convoy / Lock Convoy | 0.6 / 0.6 | null / null | adjust_quantum / adjust_quantum | 6.5, 5.3.4 -> 6.5, **5.3.3** | starvation / starvation |
| livelock | Livelock / Livelock | 0.9 / 0.9 | 140 / 140 | terminal / terminal | 6.2, 6.7 -> 6.2, 6.7 | starvation / starvation |
| orphaned | Orphaned / Orphaned | 0.4 / 0.4 | null / null | terminal / terminal | 3.3.2 -> 3.3.2 | killed_by_parent / killed_by_parent |
| fragmented | Fragmented / Fragmented | 0.7 / 0.7 | null / null | ability / ability | 9.2.3 -> 9.2.3 | out_of_memory / out_of_memory |
| cache_thrash | Cache Thrash / Cache Thrash | 0.5 / 0.5 | null / null | adjust_quantum / adjust_quantum | 1.5.3, 5.3.4 -> 1.5.3, **5.3.3** | thrashing_collapse / thrashing_collapse |
| bit_rot | Bit Rot / Bit Rot | 0.3 / 0.3 | 400 / 400 | spend / spend | 11.8 -> 11.8 | storage_corruption / storage_corruption |
| stack_overflow | Stack Overflow / Stack Overflow | 1.5 / 1.5 | 60 / 60 | ability / ability | 9.3.3, 3.1.1 -> 9.3.3, 3.1.1 | protection_fault / protection_fault |
| false_sharing | False Sharing / False Sharing | 0.6 / 0.6 | null / null | terminal / terminal | 4.5, 1.5.3 -> 4.5, 1.5.3 | starvation / starvation |
| interrupt_storm | Interrupt Storm / Interrupt Storm | 1.1 / 1.1 | 110 / 110 | terminal / terminal | 12.2.5 -> 12.2.5 | io_timeout / io_timeout |

The 5.3.4 to 5.3.3 citation correction follows the briefing. The implementation retains the numeric drain/fatal values while applying tier multipliers when used. For drain death, the carried affliction with greatest drain supplies the reason; ties use ascending affliction id. When the member carries no afflictions, the reason defaults to `starvation`. Fatal-clock death uses the expiring affliction directly. The clocks keep elapsed age across leg boundaries even though each kernel starts its tick counter again.

| Affliction | Payload from the approved targeted reading / implementation payload |
|---|---|
| priority_inversion | `nice -p <holder-pid> -n -10` / same |
| memory_leak | `kill <leaker-pid>` / same |
| starvation | scheduler `priority_aging` / same |
| thrashing | reduce degree by 2 / same |
| lock_convoy | increase quantum / same |
| livelock | `backoff --random <pid>` / same |
| orphaned | `reparent <pid> 1` / same |
| fragmented | ability `vesper` / same |
| cache_thrash | increase quantum / same |
| bit_rot | spend 12 blocks / same |
| stack_overflow | ability `lumen` / same |
| false_sharing | `align --pad <pid>` / same |
| interrupt_storm | `ioctl <device> mode=dma` / same |

R12 confirms integrity bands: nominal `>= 70`, degraded `>= 25 && < 70`, critical `> 0 && < 25`, derezzed `0`; values clamp to `[0, 100]`. For fractional integrity, “25 to 69” is interpreted by those exact thresholds rather than leaving a gap below 70.

## 7. Tier multipliers: all seven game-table columns

Source: narrative 13. Implementation: `src/game/tiers.ts`. Evidence: `tests/game/economyCurve.test.ts`. Depot pricing and reclamation time are shown separately because they are not columns of `TierRow`.

| Tier | Resources D / I | Affliction frequency D / I | Affliction drain D / I | Fatal deadline factor D / I | Policy cycles D / I | Terminal bandwidth D / I | Score D / I |
|---|---:|---:|---:|---:|---:|---|---:|
| novice | 1.35 / 1.35 | 0.60 / 0.60 | 0.75 / 0.75 | 1.50 / 1.50 | 0 / 0 | 0 / 0 | 0.5 / 0.5 |
| operator | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 | 0 / 0 | 0 / 0 | 1.0 / 1.0 |
| architect | 0.80 / 0.80 | 1.35 / 1.35 | 1.10 / 1.10 | 0.90 / 0.90 | 15 / 15 | 1, writes / 1, writes | 1.6 / 1.6 |
| kernel_space | 0.65 / 0.65 | 1.70 / 1.70 | 1.25 / 1.25 | 0.80 / 0.80 | 25 / 25 | **2, all commands / 2, writes only** | 2.5 / 2.5 |

R3 explicitly approves the writes-only kernel_space implementation until the terminal track provides a shell read-command audit hook. The probability helper clamps scaled affliction probability to `[0, 1]`. For example, architect's base 0.04 becomes 0.054.

Tier-dependent presentation still requires boot/codex wiring: remedy visibility is immediate for novice, on unlock for operator, after first successful remedy for architect, and never for kernel_space. Kernel_space counterfactuals appear only at run end, afflictions display as `UNDIAGNOSED`, and it sells neither hints nor checkpoints. Working-set, wait-for-graph, scheduler-rationale, and Banker-trace display restrictions remain presentation duties, not invented game-table values.

## 8. Verge generation: seven parameters at three fragmentation values

Source: narrative 11.6. Implementation: `src/game/reclamation/verge.ts`. Evidence: `tests/game/reclamation/verge.test.ts`. Integer counts use rounding as the package requires; continuous quantities retain the formula's exact value.

| Parameter | Formula | F = 0.1 D / I | F = 0.5 D / I | F = 0.9 D / I |
|---|---|---:|---:|---:|
| Fragment count | `round(20 + 90F)` | 29 / 29 | 65 / 65 | 101 / 101 |
| Mean fragment frames | `6 - 4.5F` | **5.6 / 5.55** | **3.8 / 3.75** | **1.9 / 1.95** |
| Leaked block count | `round(12 + 26F)` | 15 / 15 | 25 / 25 | 35 / 35 |
| Mean leaked frames | `5.5 - 3F` | 5.2 / 5.2 | 4.0 / 4.0 | 2.8 / 2.8 |
| Mark-light decay seconds | `12 - 10F` | 11.0 / 11.0 | 7.0 / 7.0 | 3.0 / 3.0 |
| Rotation degrees/second | `4 + 16F` | 5.6 / 5.6 | 12.0 / 12.0 | 18.4 / 18.4 |
| Fragment adjacency | `0.8 - 0.6F` | 0.74 / 0.74 | 0.50 / 0.50 | 0.26 / 0.26 |

| Tier | Time limit seconds D / I |
|---|---:|
| novice | 90 / 90 |
| operator | 75 / 75 |
| architect | 65 / 65 |
| kernel_space | 55 / 55 |

Generation uses the supplied reclamation RNG stream. Current fragment/leak frames equal their formula mean; normalized positions and adjacency are deterministic for that stream. Each leak region includes a live block. This is an implemented scalar layout representation, not the missing physical play model.

### Scoring fixtures and R10's explicit deferral

Sources: narrative 11.4-11.5, R10 and R11. Implementation: `src/game/reclamation/scoring.ts`, `src/game/reclamation/Reclamation.ts`. Evidence: `tests/game/reclamation/scoring.test.ts`.

| Named source target | Quota D / fixture | Blocks D / fixture | Cycles D / fixture | Explicit fixture input `(leakedFrames, fragments, chain, liveHits)` |
|---|---:|---:|---:|---|
| Poor round | 90 / 90 | 8 / 8 | 9 / 9 | `(90 / 1.2, 16, 1, 0)` |
| Median round | 150 / 150 | 18 / 18 | 15 / 15 | `(150 / 1.2, 36, 1, 0)` |
| Strong round | 220 / 220 | 30 / 30 | 22 / 22 | `(220 / 1.2, 60, 1, 0)` |
| Perfect round | 265 / 265 | 38 / 38 | 26 / 26 | `(265 / 1.2, 76, 1, 0)` |

These are **pure scoring fixtures** for shell/operator's first round. They do not demonstrate those percentiles, yields, or a perfect trace from generated layouts. With all generated leaks collected cleanly, the seven formulas yield 93.6, 120, and 117.6 quota at F = 0.1, 0.5, and 0.9. High fragmentation's total is about 125.64% of low fragmentation's total, not 40-50%. Taking count rounding into account, the largest all-clean result from these formulas is about 125.31 quota. Layout distributions, spatial placement/reach, movement, and trace constraints would be needed to turn these scalar formulas into the requested balance result.

R10 therefore defers the generated-layout target yields and the 40-50% identical-play result. The source contains the exact accepted marker:

```ts
// TODO(astra): reclamation balance pass specifies the layout and trace model
```

The implemented scoring order is:

```text
returns = 0.6 ** (runIndex - 1), runIndex in {1, 2, 3}
coalesce = min(3, 1 + 0.15 * max(0, longestChain - 1))
cleanBonus = no live hits ? 1.2 : 1
classFactor = compiler ? 1.35 : 1
quota = max(0, leakedFrames * cleanBonus * classFactor - 25 * liveHits) * returns
blocks = round(fragmentsCollected * 0.5 * coalesce * returns)
cycles = min(30, floor(finalQuota / 10))
```

R11 puts diminishing returns before block rounding and derives the refund from final quota, including the compiler bonus and diminishing returns. Narrative 5.4's independent `x1.0` compiler cycle-refund wording is stale relative to 11.4 and the ruling. Its refund range/mean is also not the later target table: the poor target refunds 9 and the median refunds 15. The three run multipliers are 1, 0.6, 0.36; run one is free, runs two and three cost 8 bandwidth, and a fourth is refused. Reopening run one cannot claim another free round.

Each live-block hit costs 25 quota through that formula, inflicts 6 integrity on a random living Program, removes the clean bonus, and blanks mark lighting for four seconds. Narrative 11.7's fourteen-fragment chain claim is another arithmetic discrepancy: the formula gives 2.95 at 14 and first reaches the 3.0 cap at 15.

## 9. Crossing quotes: four options at four contention values

Sources: narrative 12.2-12.3. Implementation: `src/game/crossing/options.ts`; evidence: `tests/game/crossing/options.test.ts`. Conditions match the printed comparison: five living Programs, standard rations, ordered queue, quantum 8. Each cell is **document / implementation**, with the displayed percent precision used in the document.

| C | Spin cycles, p D / I | Block ticks, quota, p D / I | Monitor cycles, p D / I | Wait ticks, quota, p D / I |
|---:|---|---|---|---|
| 0.20 | 30c, 96.6% / 30c, 96.6% | 32t, 80q, 99% / 32t, 80q, 99% | 69c, 97% / 69c, 97% | 64t, 160q, 99.9% / 64t, 160q, 99.9% |
| 0.40 | 48c, 86.4% / 48c, 86.4% | 44t, 110q, 99% / 44t, 110q, 99% | 93c, 97% / 93c, 97% | 88t, 220q, 99.8% / 88t, 220q, 99.8% |
| 0.60 | 66c, 69.4% / 66c, 69.4% | 56t, 140q, 99% / 56t, 140q, 99% | 117c, 97% / 117c, 97% | 112t, 280q, 99.8% / 112t, 280q, 99.8% |
| 0.80 | 84c, 45.6% / 84c, 45.6% | 68t, 170q, 99% / 68t, 170q, 99% | 141c, 97% / 141c, 97% | 136t, 340q, 99.8% / 136t, 340q, 99.8% |

Wait probabilities before display rounding are 99.88394331459112%, 99.77492735214196%, 99.75447382150034%, and 99.788374574914%. They follow `1 - 0.20 * (C * 0.86 ** (ticks / 10)) ** 2`, not the rounded display values. Wait draws are `floor(ticks / 10)`: 6, 8, 11, 13. Spin takes 10, 16, 22, 28 ticks. Monitor always takes eight ticks, costs six bandwidth, and has success probability 0.97. Unordered block probabilities are 97.8%, 91.2%, 80.2%, 64.8%, matching the source.

### Contention and failure behavior

Source 12.1's weights are 0.50 queue pressure, 0.30 hold pressure, 0.20 system pressure, clamped to `[0, 1]`. Queue pressure is `min(1, waitQueue.length / max(1, capacity * 2))`. System pressure is `blocked / max(1, blocked + runnable)`.

V8 authorizes the shipped invariant view's **mean current wait age** for the hold-pressure term, divided by active quantum and capped at one. The kernel does not expose the document's last-sixteen completed-acquisitions history. That history remains a kernel handoff; the implementation does not invent it.

Every paid attempt checks affordability before cost, steps, or RNG, then prepays its own quoted costs and advances the same kernel and affliction clocks. Ordinary travel movement, cycles, quota, and cadence draws do not duplicate the crossing's prepaid path. Retries use a fresh live contention view, with at most four attempts. A capped/failed step halts before another outcome roll. Normal affliction clocks continue during all crossing ticks.

- Spin failure at C <= 0.70 gives `lock_convoy` to the crosser and Programs behind it; above 0.70 it gives `livelock` to the crosser and one other Program.
- Unordered block failure inflicts `starvation`. At C > 0.75 while holding another resource, a **separate** 12% draw may derezz the crosser with `deadlock_victim`, regardless of the first roll's result.
- Monitor failure loses 20 blocks, floored at zero, and inflicts `bit_rot`.
- Wait advances real fatal clocks and takes exactly its specified event draws. The high success probability does not make those clocks or costs disappear.

### Authored crossing schedule, still requiring content registration

Source: narrative 12.4. These are the source's nine planned crossings. They are not a claim that nine locations/anchors have been authored or registered in every leg factory.

| Leg | Count | Kinds | Ordered flags | Typical source C |
|---|---:|---|---|---|
| 4, The Narrows | 3 | mutex, mutex, mutex | yes, no, yes | 0.25, 0.45, 0.60 |
| 5, The Cistern | 2 | rwlock, semaphore | no, yes | 0.55, 0.40 |
| 6, The Gridlock | 2 | mutex, mutex | yes, yes | 0.70, 0.85 |
| 11, The Archive | 1 | rwlock | yes | 0.50 |
| 12, The Arbiter Wall | 1 | monitor | yes | 0.65 |

Typical C is explanatory; quotes use actual live contention. R13 keeps declarations and interaction handlers in an owned side registry rather than adding fields to frozen `Leg`.

## 10. Synthetic arrival transform: all four paces

Source rule: package V5 and narrative 6.1, `Math.round(originalArrival / arrivalRate)`. Evidence: `tests/game/travel/paceRations.test.ts`; fixture: `tests/game/fixtures/syntheticLeg.ts`.

The supplied fixture's convoy arrivals are **0, 2, 4, 6, 8**, not the package prose's all-zero assumption. Its workload arrivals are **5, 8, 11, 14, 17, 20**. The fixture remains intact and every specification receives the transform.

| Pace | Rate | Convoy, formula-derived D / I | Workload, formula-derived D / I |
|---|---:|---|---|
| conservative | 0.70 | 0,3,6,9,11 / 0,3,6,9,11 | 7,11,16,20,24,29 / 7,11,16,20,24,29 |
| steady | 1.00 | 0,2,4,6,8 / 0,2,4,6,8 | 5,8,11,14,17,20 / 5,8,11,14,17,20 |
| aggressive | 1.45 | 0,1,3,4,6 / 0,1,3,4,6 | 3,6,8,10,12,14 / 3,6,8,10,12,14 |
| reckless | 2.00 | 0,1,2,3,4 / 0,1,2,3,4 | 3,4,6,7,9,10 / 3,4,6,7,9,10 |

The spawn transform returns a copy and does not mutate the authored source specification. Policy overrides must resolve before population for this transform to see the chosen pace.

## 11. R1-R14: decisions and document disagreements

This ledger records the accepted interpretation. All six later integrations are approved and applied; per-commit gate and commit verification remains a separate step.

| Ruling | Accepted behavior and the disagreement it resolves |
|---|---|
| R1 | Command admission occurs after recording and before mutation. Refusal marks the decision costly, returns `CommandOutcome.refused`, and performs no command mutation. Replay gets the same guard. Post-mutation affordability checks could not undo syscalls, events, or RNG effects. |
| R2 | Two protected CommandBus fixtures receive the exact mandatory `setDeadlockStrategy` insertion. Existing assertions are retained. |
| R3 | Terminal scheduler translation supports quantum only; other `SchedulerParams` fields refuse with `man sched` guidance. The sink calls `bus.apply` synchronously at `kernel.tick` between frames so shell handlers receive actual syscall results. Writes only are charged until the shell supplies a read-command audit hook. Durable terminal provenance is implemented through the separately approved choice-prefix integration, described below. |
| R4 | `initialRunState` uses the scaled starting ledger. Plain-data `ReplayEntry` carries `run` and `rngStates`, with explicit options taking precedence over request entry. The planner passes live entry. Live population uses `streams.leg.fork(legId)` as the explicit V9 exception. Overrides precede population, binding applies once after a drained batch, and an explicit quantum wins. |
| R5 | Identity is exercised through direct `runReplay`; real workers retain a null fallback until boot installs static factories in both contexts. Session registrations survive exit. Stable crossing/depot/reclamation/interaction/checkpoint choices use the shared action dispatcher; unowned records count as skips. The additionally approved replay entry callback is installed before configuration, population and tick-zero admission. |
| R6 | Decisions carry active `kernel.tick`, and postTick receives the completed tick. Subscribe before commands and collect events once by sequence, including command-time and postTick lifecycle emissions. The pathology `process.exited` assertion applies to admitted live bound pids. A pending `new` process uses the separately approved discard path: PCB reason `killed_by_parent`, pathology reason in its epitaph, state-change/syscall events and no `process.exited`. |
| R7 | The shipped degree control admits globally, including convoy processes. Report movements separately by group; do not claim protected convoy exclusion. Its ceiling comes from `pager.control.maximumDegree` (default 8), not from the dial's current value. A workload-scoped admission API is deferred to the kernel track. |
| R8 | Runtime uses ceil ticks, final movement/cycle proration, and full final-tick quota/integrity. Fractional ledgers remain fractional. Narrative 6.1's worked ticks/quota are corrected; narrative 5.5 is a distinct rounded analytical fixture excluding credit, deaths, and reclamation. |
| R9 | Retain the source's entry credit when the ledger cannot pay the whole conservative leg, and additionally activate credit on the first unaffordable mandatory travel tick. Credit forces conservative travel, zero further travel-cycle charge, extra exposure, and a 25% dividend penalty. Optional purchases and paid crossings refuse before cost or RNG; resource event deltas floor at zero. This expands the original entry-only condition. |
| R10 | Keep all seven generation formulas. Use explicit scoring fixtures for the four yield rows. Defer generated-layout targets and the 40-50% identical-play result until the layout/trace model is specified. Preserve the exact TODO quoted above. |
| R11 | Apply diminishing returns before final block rounding; compute refund from final quota. Narrative 5.4's separate compiler refund multiplier is stale. Exact fragment size at F = 0.9 is 1.95. |
| R12 | Inject authored throughput targets instead of inventing them. Read narrative 7.2 only for remedy payloads and narrative 3 for ability charges, without importing excluded flavour copy. Confirm integrity thresholds 70, 25, 0 and clamp to 100. |
| R13 | Use `runner.registerCrossings`, `openCrossing`, and `resolveCrossing` with an owned registry. Simulate prepaid crossing ticks on the same kernel/affliction path, without duplicate travel charges/draws. Register interactions by id and refuse an integrity-cost interaction without an explicit target. |
| R14 | In-memory checkpoints include companion owned-state snapshots. Rebuild/populate before restoring exact RNG state. One permanent costly `checkpoint_rollback` record supplies the score mark. Persisted continuation reconstructs side state from full action history; frozen `SaveFile` is not widened. Purchased protection is for the next leg and is consumed only by a failure there. |

Additional accepted corrections: use `@kernel/index`, `@game/index`, and `@world/index` with the existing alias configuration; do not invent bare aliases. Use the exact neutral debrief chapter fallback rather than assigning null to a non-null field. Boot Sector has no travel, and the Drowned Reach has no depot. The rations allocation/payment correction in section 2 supersedes preflight's original no-op proposal.

## 12. Six approved integrations now applied

The six exact proposals received explicit approval and are installed. Their historical artifact filenames do not mean authorization is still pending. The full integration four-gate sequence passed; per-commit verification is recorded in the final report. This section records implementation and regression evidence.

1. **Complete replay event capture.** [WP-19-R6-protected-helper-proposal.patch](/Users/kylegothman/Documents/Codex/2026-09-15/files-mentioned-by-the-user-kernel/outputs/WP-19-R6-protected-helper-proposal.patch) changes the protected helper to `onAny` plus unsubscribe. Command-time and postTick lifecycle events contribute to the canonical hash. Event sequence de-duplication remains in the Director.
2. **Override-before-populate degree expectation.** [WP-19-R4-degree-test-proposal.patch](/Users/kylegothman/Documents/Codex/2026-09-15/files-mentioned-by-the-user-kernel/outputs/WP-19-R4-degree-test-proposal.patch) updates the protected setter sequence to `[3]`, retaining the final-degree assertion. This ordering correction is separate from the real V6 throughput knee: the synthetic fixture has a unique maximum at degree 2 and repeated measured faults 125 above its explicit threshold 100 at crowded degrees 4 to 8, without kernel changes.
3. **Durable terminal-origin provenance.** [WP-19-terminal-provenance-proposal.patch](/Users/kylegothman/Documents/Codex/2026-09-15/files-mentioned-by-the-user-kernel/outputs/WP-19-terminal-provenance-proposal.patch) preserves origin in the existing serialized choice using `[terminal] `, strips it for command parsing, and restores terminal origin in direct replay and provisional continuation. Plain historical choices remain readable, and no frozen field or extra decision is added. Four architect/kernel_space × Boot/Fork cases compare actual pre-evaluate ledgers, hashes and scores. Two continuation cases prove the low-bandwidth refused crossing and next write remain identical.
4. **Economic entry before configuration and population.** [WP-19-replay-entry-hook-proposal.patch](/Users/kylegothman/Documents/Codex/2026-09-15/files-mentioned-by-the-user-kernel/outputs/WP-19-replay-entry-hook-proposal.patch) adds `ReplayHooks.enter?(streams, store): void` before policy/configuration/population/tick-zero admission. The Runner chains store-based entry reset and Director context capture; reserved admission charges flush even at zero-tick Boot and the completed boundary. The Boot/Fork/Weave regression asserts ordering, bandwidth refills 36/60/36, ability charges `[2,2,3,2,2]`, credit and 209 ticks; Boot terminal-cost cases prove the no-step path.
5. **Pending-process game death.** [WP-19-pending-process-death-proposal.patch](/Users/kylegothman/Documents/Codex/2026-09-15/files-mentioned-by-the-user-kernel/outputs/WP-19-pending-process-death-proposal.patch) discards a bound process still in `new` through init's existing kill syscall, avoiding the kernel's invalid `new -> zombie` lifecycle transition. Its PCB has `terminationReason: killed_by_parent`; its epitaph retains the selected pathology. The exact events are `process.state_changed` and `syscall.invoked`, with no `process.exited`. `runHost.test.ts` checks delayed Vesper death at tick 5, no later admission and one tombstone. The separate post-arrival case proves the admitted lifecycle exit still carries `storage_corruption` without a kill syscall. No kernel code changed.
6. **Casualty observations.** [WP-19-casualty-observation-proposal.patch](/Users/kylegothman/Documents/Codex/2026-09-15/files-mentioned-by-the-user-kernel/outputs/WP-19-casualty-observation-proposal.patch) adds an optional epitaph argument to `observeLeg`. Live/replay callers pass only tombstones added since that leg's entry. One-to-one member occurrence matching retains multiplicity and stable tick order, and uses the game reason/tick when a command exit's epitaph follows one tick later. Legacy event-only observation still works. Four regressions include game death after terminal normal completion, direct replay casualty reporting, planner selection and exclusion of historical tombstones. Arbitrary authored outcome casualties without event/epitaph reason and tick are outside this reconstruction.

All 47 Runner cases passed the focused run, including the four casualty and seven terminal/entry regressions. The subsequent full integration run passed all four exact gates and all 2,156 tests. All four per-commit gate sequences passed and the branch is pushed.

## 13. Boot, terminal, content, and kernel handoffs

### Boot and app integration

- Replace the placeholder entry in the boot package. Construct renderer/backend, stage builder, focus camera, world router, audio, terminal, HUD, codex, DOM roots, and cards there. The WP-19 headless host does not construct browser or rendering objects.
- Construct the run store and named RNG streams, supply the actual epitaph copy source, and provide a positive authored throughput target for every leg. Supply build id and save timestamp as metadata, not simulation inputs.
- Forward bus mutations and handlers to the runner's **current** kernel/director. Use the active leg id and current admission guard. Subscribe through `onKernelChanged` so leg transitions, rollback, and resume replace subscriptions instead of retaining an old kernel.
- Register world, audio, codex, and HUD consumers in the frame queue's four slots. Fill telemetry before its single frame flush; then route events. Preserve host step ordering, suspension, and event sequence de-duplication. Read active scheduler/quantum from the invariant view rather than stale initial config.
- Supply variable-update/render/metrics/state hooks, stage updates, effect aging, focus camera, render/post chain, and DOM batch commits in their required order. Supply HUD's monotonic presentation clock, focus state, and UI sounds outside deterministic game state.
- Supply codex registry, profile, current-leg provider, metrics, and a focus/visibility-backed `onScreen` predicate. Apply tier visibility rules from narrative 13, including kernel_space run-end-only counterfactuals and `UNDIAGNOSED` labels.
- Route all seven typed `LegEvent` notifications: `leg_unavailable`, `tombstone`, `panic`, `debrief`, `crossing_open`, `depot_open`, and `reclamation_open`. Supply tombstone `onCodex`. Pass `DebriefView.card` and the counterfactual promise to the card, and pass the actual entry id to `codex.setCounterfactual`. Optional replay failure resolves null without removing the debrief card.
- Own derezz animation timing, HUD pre-roll, tombstone visibility, modal pause, and effect disposal. Handle the `begin`/`tombstone` callback stages without introducing game-layer wall-clock input.
- Bind persistence to SaveService and handle asynchronous save failures, load UX, profiles/settings, and replay-record persistence. Wire hide/show provisional saving, suspension, and audio behavior. Resume with the authored ordered leg collection and the callback that re-registers owned crossing/interaction content, so prior action history can rebuild side state.
- Install static headless leg factories and shared hook factories in both the main context and worker context. Own worker start, cancellation, and disposal. A session registration in the live thread does not register a separate worker. Retain the worker null fallback until this installation exists.
- Preserve the installed replay entry/provenance integrations: entry snapshots, exact named-stream state, action order, command admission, completed-tick event collection, and final boundary actions in both contexts. These WP-19 integrations are applied; static factory installation and browser consumption remain boot duties.

### Terminal track

- Add a shell read-command audit hook for kernel_space's source requirement that all commands cost bandwidth. The accepted WP-19 scope charges writes only.
- Extend serialization and replay support before mapping scheduler fields beyond quantum. Current unsupported fields must keep an explicit refusal naming `man sched`.
- Preserve the approved synchronous sink application between frames. Shell syscall handlers need the real immediate `SinkResult.syscall`; replacing it with an unfulfilled queued result would change behavior.
- Carry the actual current kernel/director and terminal provenance into command admission. This is necessary for both cycle policy costs and terminal bandwidth costs.

### Content and phase-2 gameplay

- Supply exact crossing declarations, ids, anchors, and timing through the owned side registry, and register interaction handlers by id. Supply an explicit member target for integrity costs. The source schedule of nine crossings is not an authored implementation of all those locations.
- Supply actual per-leg ability behavior and consume the runner's recruit passive table: normal replacements use 60% passive effectiveness, while the codec passive remains unavailable. Preserve the closed member identity and original tombstone while binding the replacement's next-leg pid.
- Supply the epitaph-copy package using `templates(reason: TerminationReason): readonly EpitaphTemplate[]`, with each template's id, reason, inscription, cause, codex entry, and optional member/leg restriction. Selection filters matching templates and uses the leg RNG uniformly. The default copy marker remains `// TODO(astra): epitaph copy package transcribes narrative 9`; tests inject copy.
- Build the reclamation renderer, controls, marking, camera/beam behavior, and layout/trace balance model in phase 2. The current plain trace uses timestamp, `collect`/`coalesce`, and block id. The accepted R10 TODO is still the boundary for physical reachability, timed play, and percentile/identical-play balance claims.

### Kernel track

- Add a per-bound-Program frame floor/pinning API if the narrative's guaranteed convoy resident set is required. Global `setFramePolicy` is present and called, but is not that API.
- Add workload-scoped admission or protected convoy exclusion before promising that degree changes affect only leg workload. The accepted WP-19 behavior is global admission with separate movement reporting.
- Expose the last-sixteen completed sync-acquisition history before replacing V8's authorized current-wait-age contention term with narrative 12.1's historical mean.

These are explicit integration duties and approved limitations. The numeric comparisons and applied integrations are supported by the passing full integration gates. The final report records the passing gates, required attribution and verified push for all four commits; the approved handoffs remain preserved.

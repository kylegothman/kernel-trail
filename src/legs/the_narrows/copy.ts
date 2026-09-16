/**
 * KERNEL TRAIL, the Narrows: everything the player reads.
 *
 * Eight codex entries, five stones and the debrief's phrasing. The tone guide
 * is section 2.1 of the narrative bible: short declaratives with real nouns,
 * measurements rather than adjectives, and no line that is amused by its own
 * circumstances. The tombstone inscription is the one licensed joke and it is
 * flat.
 */
import type { CodexEntry } from '@game/codexTypes';
import type { EpitaphTemplate } from '@game/convoy/derezz';
import { cite } from './chapters';

/* ------------------------------------------------------------------ */
/* The codex                                                           */
/* ------------------------------------------------------------------ */

export const RACE_CONDITION = 'codex.race_condition';
export const CRITICAL_SECTION_ENTRY = 'codex.critical_section';
export const PETERSONS = 'codex.petersons';
export const ATOMIC_HARDWARE = 'codex.atomic_hardware';
export const MUTEX_SEMAPHORE = 'codex.mutex_semaphore';
export const SPIN_VS_BLOCK = 'codex.spin_vs_block';
export const MONITOR = 'codex.monitor';
export const PRIORITY_INVERSION_ENTRY = 'codex.priority_inversion';

export const CODEX_IDS: readonly string[] = [
  RACE_CONDITION, CRITICAL_SECTION_ENTRY, PETERSONS, ATOMIC_HARDWARE,
  MUTEX_SEMAPHORE, SPIN_VS_BLOCK, MONITOR, PRIORITY_INVERSION_ENTRY,
];

export const codex: readonly CodexEntry[] = [
  {
    id: RACE_CONDITION,
    title: 'Race Condition',
    chapter: cite('6.1', '6.2'),
    concept: 'A statement that reads a shared value, changes it and writes it back is three machine operations, and the scheduler may preempt between any two of them because it has no idea the three were meant to be one thing. Two Programs interleaved that way both read the same number, both add one, and both store the same result: two increments, one advance. No instruction executed incorrectly. The defect is entirely in the order they ran in.',
    unlock: { kind: 'event', type: 'sync.race_detected' },
    workedExample: null,
    counterfactual: null,
    remedy: null,
    remedyVisibility: 'on_unlock',
    related: [CRITICAL_SECTION_ENTRY, ATOMIC_HARDWARE],
    commands: ['race', 'trace'],
    epitaphs: [],
  },
  {
    id: CRITICAL_SECTION_ENTRY,
    title: 'The Critical Section',
    chapter: cite('6.2', '6.5'),
    concept: 'A correct solution holds three properties at once: mutual exclusion, so at most one Program is inside; progress, so a free section admits someone; and bounded waiting, so there is a limit on how many others enter ahead of you. Implementations usually miss the third, because the first two fail loudly and the third fails quietly under load. Nothing in the hardware ties a lock to the data it protects, so a section is only as correct as the discipline naming it.',
    unlock: { kind: 'command', name: 'lock', flag: '--mark' },
    workedExample: null,
    counterfactual: null,
    remedy: null,
    remedyVisibility: 'on_unlock',
    related: [RACE_CONDITION, MUTEX_SEMAPHORE],
    commands: ['lock'],
    epitaphs: [],
  },
  {
    id: PETERSONS,
    // The stone is read through an interaction and the marker arrives from the
    // event deck; the codex sees neither, so the nearest arm is the leg itself.
    title: 'The Two-Process Solution',
    chapter: cite('6.3'),
    concept: 'Two flags and a turn variable are enough for exactly two processes, with no hardware support at all, and the proof rests on the turn variable holding one value at a time. It does not extend to five. It also assumes loads and stores complete in program order, which processors stopped guaranteeing a long time ago: reorder the flag write past the turn write and both Programs enter together.',
    unlock: { kind: 'leg_complete', leg: 'the_narrows' },
    workedExample: null,
    counterfactual: null,
    remedy: null,
    remedyVisibility: 'on_unlock',
    related: [ATOMIC_HARDWARE, CRITICAL_SECTION_ENTRY],
    commands: ['lock'],
    epitaphs: [],
  },
  {
    id: ATOMIC_HARDWARE,
    // `trace --replay` is the moment the fix is proved against the interleaving
    // that broke it, which is the closest signal the codex can see to the swap.
    title: 'Atomic Instructions',
    chapter: cite('6.4.1', '6.4.2', '6.4.3'),
    concept: 'Test-and-set reads a value and writes true in one indivisible step; compare-and-swap writes only if the value is still what you read. Both are single operations in hardware, which is what software locking is built out of rather than an alternative to it. Test-and-set holds mutual exclusion and not bounded waiting, because a Program can lose the race arbitrarily many times, and compare-and-swap turns a lost race into a retry instead of a lost update.',
    unlock: { kind: 'command', name: 'trace', flag: '--replay' },
    workedExample: null,
    counterfactual: null,
    remedy: null,
    remedyVisibility: 'on_unlock',
    related: [RACE_CONDITION, SPIN_VS_BLOCK],
    commands: ['trace', 'race'],
    epitaphs: [],
  },
  {
    id: MUTEX_SEMAPHORE,
    // The wide ford is the leg's only counting primitive, and blocking on it is
    // how a player reaches the count question at all.
    title: 'Mutex and Semaphore',
    chapter: cite('6.5', '6.6.1', '6.6.2'),
    concept: 'A mutex is held or free and only its holder may release it. A counting semaphore holds an integer, and waiting decrements and blocks below zero while signalling increments and wakes a waiter, which lets three Programs into a space that holds three. The count is the whole reason both exist: set it to one and a ford three wide admits one, set it above the width and the extra Program steps onto something that is not there.',
    unlock: { kind: 'crossing', option: 'block' },
    workedExample: null,
    counterfactual: null,
    remedy: null,
    remedyVisibility: 'on_unlock',
    related: [CRITICAL_SECTION_ENTRY, MONITOR],
    commands: ['lock', 'sem'],
    epitaphs: [],
  },
  {
    id: SPIN_VS_BLOCK,
    title: 'Spinning Against Blocking',
    chapter: cite('6.5', '6.9'),
    concept: 'Spinning holds the processor and tests the lock in a loop, which wastes every cycle it spends and costs no context switch. Blocking gives the processor up and costs one switch each way. The crossover is arithmetic rather than taste: spin while the expected wait is shorter than a switch, block when it is longer. Utilisation looks perfect while a Program spins, which is exactly why busy waiting is the deceptive one.',
    unlock: { kind: 'crossing', option: 'spin' },
    workedExample: null,
    counterfactual: null,
    remedy: { kind: 'adjust_quantum', direction: 'increase' },
    remedyVisibility: 'on_unlock',
    related: [ATOMIC_HARDWARE, MUTEX_SEMAPHORE],
    commands: ['lock', 'top'],
    epitaphs: [],
  },
  {
    id: MONITOR,
    title: 'The Monitor',
    chapter: cite('6.7.1', '6.7.2'),
    concept: 'A monitor puts the mutual exclusion inside the construct, so a Program that enters it is correct by construction and pays for the privilege. Condition variables hang off it for waiting on a predicate rather than on the lock. The construct being correct does not make its client correct: a wakeup says the condition was signalled, not that it is still true, which is why the predicate is tested in a while loop and never in an if.',
    unlock: { kind: 'crossing', option: 'monitor' },
    workedExample: null,
    counterfactual: null,
    remedy: null,
    remedyVisibility: 'on_unlock',
    related: [MUTEX_SEMAPHORE, CRITICAL_SECTION_ENTRY],
    commands: ['lock'],
    epitaphs: [],
  },
  {
    id: PRIORITY_INVERSION_ENTRY,
    title: 'Priority Inversion',
    chapter: cite('6.8'),
    concept: 'A low-priority Program holds a lock, a high-priority Program blocks on it, and a medium-priority Program preempts the holder and runs. The high-priority Program is now waiting behind the medium one, which is the inversion, and the affliction lands on the waiter rather than on either Program causing it. Priority inheritance is the fix: while the holder blocks a higher-priority waiter it runs at the waiter priority, finishes, and releases. Raising the waiter does nothing at all, because nothing schedules a Program that is not in the queue.',
    unlock: { kind: 'affliction', id: 'priority_inversion' },
    workedExample: null,
    counterfactual: null,
    remedy: { kind: 'terminal', command: 'nice -p <holder-pid> -n -10' },
    remedyVisibility: 'on_unlock',
    related: [MUTEX_SEMAPHORE, SPIN_VS_BLOCK],
    commands: ['lock', 'nice'],
    epitaphs: ['ep.narrows.first_in_priority'],
  },
];

/* ------------------------------------------------------------------ */
/* The stones                                                          */
/* ------------------------------------------------------------------ */

/**
 * One stone per Program, all for `starvation`, which is the termination every
 * synchronisation affliction in this leg resolves to. A pinned cause line is
 * the one that lands, and `derezz` throws on an empty candidate list, so
 * pinning one per Program is what keeps SABLE's 210 ticks exact while leaving
 * every other Program a stone of its own (WP-21 section 16).
 */
export const epitaphs: readonly EpitaphTemplate[] = [
  {
    id: 'ep.narrows.first_in_priority',
    reason: 'starvation',
    member: 'sable',
    legId: 'the_narrows',
    inscription: 'HERE LIES SABLE, FIRST IN PRIORITY, LAST ACROSS',
    cause: 'It was the highest-priority Program in the convoy and it waited 210 ticks for a lock held by the lowest. Priority does not transfer through a lock unless you make it.',
    codexEntry: PRIORITY_INVERSION_ENTRY,
  },
  {
    id: 'ep.narrows.read_it_twice',
    reason: 'starvation',
    member: 'lumen',
    legId: 'the_narrows',
    inscription: 'HERE LIES {NAME}, READ IT, ADDED ONE, WROTE IT BACK',
    cause: 'Three operations, one line of source. The convoy was on the far side before the number on the post finished disagreeing with it.',
    codexEntry: RACE_CONDITION,
  },
  {
    id: 'ep.narrows.held_the_wrong_lock',
    reason: 'starvation',
    member: 'orrery',
    legId: 'the_narrows',
    inscription: 'HERE LIES {NAME}, HELD A LOCK, JUST NOT THAT ONE',
    cause: 'Both crossings were guarded and both guards were correct. Nothing in the hardware associates a lock with the data it protects, and the two names never met.',
    codexEntry: CRITICAL_SECTION_ENTRY,
  },
  {
    id: 'ep.narrows.still_testing',
    reason: 'starvation',
    member: 'kestrel',
    legId: 'the_narrows',
    inscription: 'HERE LIES {NAME}, STILL TESTING THE LOCK',
    cause: 'Busy waiting at full utilisation. Every cycle was spent establishing that the lock was still taken, and a context switch costs four.',
    codexEntry: SPIN_VS_BLOCK,
  },
  {
    id: 'ep.narrows.after_you',
    reason: 'starvation',
    member: 'vesper',
    legId: 'the_narrows',
    inscription: 'HERE LIES {NAME}, AFTER YOU, NO, AFTER YOU',
    cause: 'Livelock. Both Programs deferred, both retried on the same tick, and both ran at full rate without moving. Any asymmetry at all would have cleared it.',
    codexEntry: SPIN_VS_BLOCK,
  },
];

export const EPITAPH_IDS: readonly string[] = epitaphs.map((stone) => stone.id);

/* ------------------------------------------------------------------ */
/* The debrief                                                         */
/* ------------------------------------------------------------------ */

export const HEADLINE_CLEAN = 'Across the Narrows.';
export const HEADLINE_CORRUPT = 'The manifest is wrong.';

export const WHY = {
  raced: 'Two Programs read the ledger post, both added one, and both wrote it back. The post advanced once. Nothing executed incorrectly and the record of what happened is still wrong.',
  twoLocks: 'The second ford guards the same post with two differently named mutexes. Both crossings are correct in isolation and lock --list shows no contention on either, because the association between a lock and its data lives in convention rather than in the hardware.',
  inversion: 'The sweep holds the manifest lock at priority 9, the hauler preempts it at priority 5, and SABLE waits behind both at priority 1. The affliction lands on the waiter, which is exactly backwards from where the fault is.',
  clean: 'The protocol held. Mutual exclusion, progress and bounded waiting together, and the number on the far post is the number of Programs standing beside it.',
} as const;

/** Narrative 12.2: the third crossing is four cores and the switch reaches one of them. */
export const INTERRUPT_NOTE = 'Disabling interrupts stopped preemption on one core. The wide ford is four, and the other three never received an interrupt to disable.';
/** Ruling 3: the toggle lifts the affliction and the kernel's wait is unchanged. */
export const INHERITANCE_NOTE = 'Priority inheritance is recorded against the crossing and the lock itself does not donate priority, so the kernel wait stays unbounded.';

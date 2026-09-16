/**
 * KERNEL TRAIL, the Narrows: the judgement.
 *
 * Every objective is computed from the kernel event log, the snapshot and the
 * decisions the run recorded, never from a flag the leg set for itself. The
 * one thing this file writes is the manifest hand-off: the number on the far
 * post leaves the leg as a `DecisionRecord` so the Archive can find out, nine
 * legs later, that the map file it is looking for was named by a number two
 * Programs disagreed about (WP-21 section 16, hand-off 6).
 */
import type { KernelEvent, Pid, ResourceId } from '@kernel/types';
import { asKernelEvents } from '@legs/events';
import type { DecisionRecord, LegEvaluationContext, LegOutcome, RunState } from '@game/types';
import { CRITICAL_SECTION } from './chapters';
import {
  CODEX_IDS, HEADLINE_CLEAN, HEADLINE_CORRUPT, INHERITANCE_NOTE, INTERRUPT_NOTE, RACE_CONDITION,
  ATOMIC_HARDWARE, CRITICAL_SECTION_ENTRY, MONITOR, MUTEX_SEMAPHORE, PETERSONS,
  PRIORITY_INVERSION_ENTRY, SPIN_VS_BLOCK, WHY,
} from './copy';
import { PLANK, WIDE_FORD_IDS, WIDE_FORD_3 } from './crossings';
import { FORD_WIDTH, GUARDED_REGION, LOCK_MANIFEST, REGION_FAR, REGION_NEAR, SABLE_PROCESS, SEM_FORD_3, CELL_FAR, CELL_NEAR } from './ledger';
import {
  ATOMIC_PRIMITIVE, MINIMAL_CRITICAL_SECTION, PRIORITY_INVERSION, SEMAPHORE_CAPACITY,
  SPIN_VERSUS_BLOCK, THREE_REQUIREMENTS,
} from './objectives';
import { READ_STONE, TOGGLE_INHERITANCE, USE_CAS, DISABLE_INTERRUPTS } from './interactions';

export const MANIFEST_SEED = 'manifest_seed';
/** Narrative 12.2: a context switch is four ticks, which is the whole spin-or-block arithmetic. */
export const CONTEXT_SWITCH_TICKS = 4;
export const SPUN_TICK_BUDGET = 25;
/** The frozen fixture: SABLE's wait on `lock.manifest` with no intervention. */
export const SABLE_WAIT_FIXTURE = 210;

const TERMINAL = '[terminal] ';

/* ------------------------------------------------------------------ */
/* Reading the run                                                     */
/* ------------------------------------------------------------------ */

interface Mark {
  readonly start: number;
  readonly end: number;
}

export interface Analysis {
  readonly races: readonly Extract<KernelEvent, { type: 'sync.race_detected' }>[];
  /**
   * Increments the near post is behind its serial counter: the number of
   * updates actually lost. The event count cannot be used for this. Once a
   * cell's lock set is empty the detector reports a potential race on every
   * later access, and every one of those reports carries the running
   * difference, so counting reports counts the same lost update many times.
   */
  readonly nearDeficit: number;
  readonly farDeficit: number;
  /**
   * Stores to the near post after the protocol was installed whose
   * read-modify-write also began after it: a write that took the old path when
   * the new one was already available. One that began earlier is in flight and
   * cannot be recalled, so it is not counted against the player.
   */
  readonly unguardedAfterFix: number;
  readonly spunTicks: number;
  readonly marks: readonly Mark[];
  readonly replays: number;
  readonly casInstalledAt: number | null;
  readonly readStone: boolean;
  readonly interruptsDisabled: boolean;
  readonly inheritanceToggled: boolean;
  readonly crossingOptions: readonly { readonly id: string; readonly option: string }[];
  readonly capacity: number;
  readonly wideFordCrossed: string | null;
  readonly admittedPastWidth: boolean;
  readonly blockedWithRoom: boolean;
  readonly sableWait: number;
  readonly sableAfflicted: boolean;
  readonly boundedWaitingHeld: boolean;
  readonly nearValue: number;
  readonly nearExpected: number;
  readonly farValue: number;
  readonly farExpected: number;
  readonly guardHolds: readonly number[];
}

const decisionsOf = (run: Readonly<RunState>): readonly DecisionRecord[] =>
  run.decisions.filter((record) => record.legId === 'the_narrows');

/** `lock --mark <start> <end>`, as the player typed it. The claim is theirs and the leg takes them at their word. */
export function parseMarks(decisions: readonly DecisionRecord[]): readonly Mark[] {
  const marks: Mark[] = [];
  for (const record of decisions) {
    if (record.kind !== 'terminal') continue;
    const line = record.choice.startsWith(TERMINAL) ? record.choice.slice(TERMINAL.length) : record.choice;
    const match = /^lock\s+--mark\s+(\d+)\s+(\d+)\s*$/.exec(line.trim());
    if (match === null) continue;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end)) marks.push({ start, end });
  }
  return marks;
}

function terminalCount(decisions: readonly DecisionRecord[], name: string, flag: string): number {
  return decisions.filter((record) => {
    if (record.kind !== 'terminal') return false;
    const line = record.choice.startsWith(TERMINAL) ? record.choice.slice(TERMINAL.length) : record.choice;
    return line.trim().startsWith(name) && line.includes(flag);
  }).length;
}

function interactionTick(decisions: readonly DecisionRecord[], id: string): number | null {
  const record = decisions.find((entry) => entry.kind === 'interaction' && entry.choice.startsWith(`${id} @ `));
  return record === undefined ? null : record.tick;
}

function crossingOptions(decisions: readonly DecisionRecord[]): readonly { readonly id: string; readonly option: string }[] {
  return decisions.flatMap((record) => {
    if (record.kind !== 'crossing') return [];
    const split = record.choice.lastIndexOf(':');
    if (split < 0) return [];
    return [{ id: record.choice.slice(0, split), option: record.choice.slice(split + 1) }];
  });
}

/** Cumulative `spunTicks` is a per-process total on every event, so the last one per pid is that process's whole spend. */
export function spunTicksOf(events: readonly KernelEvent[]): number {
  const perPid = new Map<Pid, number>();
  for (const event of events) if (event.type === 'sync.busy_wait') perPid.set(event.pid, event.spunTicks);
  return [...perPid.values()].reduce((sum, ticks) => sum + ticks, 0);
}

/**
 * No Program was overtaken more than twice: for each waiter, the acquisitions
 * by other Programs between its block and its own acquisition. The ordered
 * route through this objective is structural, and this is the other one.
 */
export function overtaking(events: readonly KernelEvent[]): number {
  let worst = 0;
  const waitingSince = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'sync.blocked') {
      const key = `${event.resource}:${event.pid}`;
      waitingSince.set(key, event.seq);
      counts.set(key, 0);
    } else if (event.type === 'sync.acquired') {
      for (const [key, count] of counts) {
        const [resource, pid] = key.split(':');
        if (resource !== event.resource || Number(pid) === event.pid) continue;
        const next = count + 1;
        counts.set(key, next);
        worst = Math.max(worst, next);
      }
      const own = `${event.resource}:${event.pid}`;
      if (waitingSince.has(own)) { waitingSince.delete(own); counts.delete(own); }
    }
  }
  return worst;
}

/** Permits outstanding on a semaphore over the run: the most ever held at once, and whether anyone blocked while it had room. */
export function semaphoreUse(events: readonly KernelEvent[], resource: ResourceId): { readonly peak: number; readonly blockedWithRoom: boolean } {
  let outstanding = 0;
  let peak = 0;
  let blockedWithRoom = false;
  for (const event of events) {
    if (event.type === 'sync.acquired' && event.resource === resource) {
      outstanding += 1;
      peak = Math.max(peak, outstanding);
    } else if (event.type === 'sync.released' && event.resource === resource) {
      // A release that wakes a waiter hands the permit straight over.
      if (event.woke === null) outstanding = Math.max(0, outstanding - 1);
    } else if (event.type === 'sync.blocked' && event.resource === resource && outstanding < FORD_WIDTH) {
      blockedWithRoom = true;
    }
  }
  return { peak, blockedWithRoom };
}

/**
 * The detector keeps the last thirty-two accesses to a cell with an atomic
 * flag on each and, for a read-modify-write store, the id of the load it
 * belongs to. That is enough to say exactly which writes chose the old path.
 */
export function unguardedStoresAfter(ctx: LegEvaluationContext, cell: string, after: number | null): number {
  if (after === null) return 0;
  const history = (ctx.kernelSnapshot.subsystems?.sync?.payload.raceDetector.cells ?? []).find((row) => row.cell === cell)?.history ?? [];
  const loadTick = new Map<number, number>();
  for (const row of history) if (row.op === 'load') loadTick.set(row.id, row.tick);
  return history.filter((row) => row.op === 'store' && !row.atomic && row.tick > after
    && (row.rmw === null || (loadTick.get(row.rmw) ?? Number.NEGATIVE_INFINITY) > after)).length;
}

/** Ticks between each acquisition of the two ford mutexes and its release. */
function guardHolds(events: readonly KernelEvent[]): readonly number[] {
  const held = new Map<string, number>();
  const holds: number[] = [];
  for (const event of events) {
    if (event.type === 'sync.acquired' && event.resource.startsWith('lock.ford_')) held.set(`${event.resource}:${event.pid}`, event.tick);
    else if (event.type === 'sync.released' && event.resource.startsWith('lock.ford_')) {
      const key = `${event.resource}:${event.pid}`;
      const since = held.get(key);
      if (since !== undefined) { holds.push(event.tick - since); held.delete(key); }
    }
  }
  return holds;
}

function regionValues(ctx: LegEvaluationContext): { readonly near: number; readonly far: number } {
  const regions = ctx.kernelSnapshot.subsystems?.process?.ipc.sharedRegions ?? [];
  const value = (id: ResourceId): number => regions.find((region) => region.id === id)?.value ?? 0;
  return { near: value(REGION_NEAR), far: value(REGION_FAR) };
}

/** What the post would read if every increment had landed: the detector's own shadow counter. */
function serialValues(ctx: LegEvaluationContext): { readonly near: number; readonly far: number } {
  const cells = ctx.kernelSnapshot.subsystems?.sync?.payload.raceDetector.cells ?? [];
  const value = (cell: string): number => cells.find((row) => row.cell === cell)?.serialValue ?? 0;
  return { near: value(CELL_NEAR), far: value(CELL_FAR) };
}

export function analyse(ctx: LegEvaluationContext): Analysis {
  const events = asKernelEvents(ctx.events);
  const decisions = decisionsOf(ctx.run);
  const races = events.filter((event) => event.type === 'sync.race_detected');
  const casInstalledAt = interactionTick(decisions, USE_CAS);
  const options = crossingOptions(decisions);
  const wideFordCrossed = options.find((entry) => WIDE_FORD_IDS.includes(entry.id))?.id ?? null;
  const capacity = wideFordCrossed === null ? 1 : wideFordCrossed === WIDE_FORD_3 ? FORD_WIDTH : wideFordCrossed.endsWith('.4') ? 4 : 1;
  const ford = semaphoreUse(events, SEM_FORD_3);
  const sable = ctx.run.convoy.find((member) => member.id === 'sable');
  // `derezz` clears a dead Program's pid, so SABLE's process is found by name
  // in the snapshot: her wait is the thing most worth reporting when she dies.
  const sablePid = ctx.kernelSnapshot.processes.find((process) => process.name === SABLE_PROCESS)?.pid ?? sable?.pid ?? null;
  const blocked = events.find((event) => event.type === 'sync.blocked' && event.resource === LOCK_MANIFEST && event.pid === sablePid);
  const handed = events.find((event) => event.type === 'sync.released' && event.resource === LOCK_MANIFEST && event.woke === sablePid);
  const values = regionValues(ctx);
  const serial = serialValues(ctx);
  return {
    races,
    nearDeficit: serial.near - values.near,
    farDeficit: serial.far - values.far,
    unguardedAfterFix: unguardedStoresAfter(ctx, CELL_NEAR, casInstalledAt),
    spunTicks: spunTicksOf(events),
    marks: parseMarks(decisions),
    replays: terminalCount(decisions, 'trace', '--replay'),
    casInstalledAt,
    readStone: interactionTick(decisions, READ_STONE) !== null,
    interruptsDisabled: interactionTick(decisions, DISABLE_INTERRUPTS) !== null,
    inheritanceToggled: interactionTick(decisions, TOGGLE_INHERITANCE) !== null,
    crossingOptions: options,
    capacity,
    wideFordCrossed,
    admittedPastWidth: ford.peak > FORD_WIDTH,
    blockedWithRoom: ford.blockedWithRoom,
    sableWait: blocked === undefined ? 0 : (handed?.tick ?? ctx.ticksElapsed) - blocked.tick,
    sableAfflicted: sable?.afflictions.some((affliction) => affliction.id === 'priority_inversion') === true,
    boundedWaitingHeld: overtaking(events) <= 2,
    nearValue: values.near,
    nearExpected: serial.near,
    farValue: values.far,
    farExpected: serial.far,
    guardHolds: guardHolds(events),
  };
}

/* ------------------------------------------------------------------ */
/* The objectives                                                      */
/* ------------------------------------------------------------------ */

/** Every crossing definition is ordered, so the structural route through bounded waiting always holds; the reasoning route is `boundedWaitingHeld`. */
export function objectivesFrom(analysis: Analysis, run: Readonly<RunState>): readonly string[] {
  const met: string[] = [];
  const sable = run.convoy.find((member) => member.id === 'sable');

  // A protocol installed under a live workload cannot un-start a
  // read-modify-write already between its load and its store. Every write that
  // began after the swap took the atomic path, and that is what held.
  const heldAfterFix = analysis.casInstalledAt !== null && analysis.unguardedAfterFix === 0;
  if (heldAfterFix && analysis.boundedWaitingHeld) met.push(THREE_REQUIREMENTS);

  // The plank is the cheapest crossing in the game and spinning there is the
  // textbook call. Every other section here is a real hold, and spinning
  // through one of those is the call this objective is looking for.
  const spunPastThePlank = analysis.crossingOptions.some((entry) => entry.id !== PLANK && entry.option === 'spin');
  if (analysis.spunTicks < SPUN_TICK_BUDGET && !spunPastThePlank && analysis.crossingOptions.length > 0) met.push(SPIN_VERSUS_BLOCK);

  const covers = analysis.marks.some((mark) => mark.start <= GUARDED_REGION.first && mark.end >= GUARDED_REGION.last && mark.end - mark.start < 6);
  if (covers) met.push(MINIMAL_CRITICAL_SECTION);

  if (heldAfterFix && analysis.replays > 0) met.push(ATOMIC_PRIMITIVE);

  if (analysis.capacity === FORD_WIDTH && !analysis.admittedPastWidth && !analysis.blockedWithRoom) met.push(SEMAPHORE_CAPACITY);

  // The inversion has to have happened for clearing it to mean anything, and
  // the deadline this objective names is SABLE's own survival.
  if (analysis.sableWait > 0 && analysis.inheritanceToggled && sable?.status !== 'derezzed') met.push(PRIORITY_INVERSION);

  return met;
}

export function codexFrom(analysis: Analysis): readonly string[] {
  const unlocked: string[] = [];
  const add = (id: string, when: boolean): void => { if (when) unlocked.push(id); };
  add(RACE_CONDITION, analysis.races.length > 0);
  add(CRITICAL_SECTION_ENTRY, analysis.marks.length > 0);
  add(PETERSONS, analysis.readStone);
  add(ATOMIC_HARDWARE, analysis.casInstalledAt !== null);
  add(MUTEX_SEMAPHORE, analysis.wideFordCrossed !== null);
  add(SPIN_VS_BLOCK, analysis.crossingOptions.some((entry) => entry.option === 'spin'));
  add(MONITOR, analysis.crossingOptions.some((entry) => entry.option === 'monitor'));
  add(PRIORITY_INVERSION_ENTRY, analysis.sableAfflicted || analysis.sableWait > 0);
  return unlocked.filter((id) => CODEX_IDS.includes(id));
}

/* ------------------------------------------------------------------ */
/* The debrief                                                         */
/* ------------------------------------------------------------------ */

export function counterfactualFor(analysis: Analysis): string | null {
  if (analysis.farDeficit > 0) {
    return `The same interleaving under compare-and-swap produces ${analysis.farExpected} instead of ${analysis.farValue}. The manifest you are carrying reads ${analysis.farValue}.`;
  }
  if (analysis.nearDeficit > 0) {
    return `The same interleaving under compare-and-swap produces ${analysis.nearExpected} instead of ${analysis.nearValue} on the near post. ${analysis.nearDeficit} increment${analysis.nearDeficit === 1 ? '' : 's'} went missing between a load and a store.`;
  }
  if (analysis.sableWait >= SABLE_WAIT_FIXTURE || analysis.sableAfflicted) {
    return `SABLE waited ${analysis.sableWait} ticks for a lock held by a Program at priority 9. With inheritance enabled the holder runs at SABLE's priority and finishes in ${analysis.guardHolds.length > 0 ? Math.round(analysis.guardHolds.reduce((sum, hold) => sum + hold, 0) / analysis.guardHolds.length) : 6} ticks.`;
  }
  if (analysis.spunTicks > SPUN_TICK_BUDGET) {
    return `You spun ${analysis.spunTicks} ticks. A context switch costs ${CONTEXT_SWITCH_TICKS}. Spinning is cheaper than switching only while the expected wait is under ${CONTEXT_SWITCH_TICKS}.`;
  }
  if (analysis.wideFordCrossed !== null && analysis.capacity !== FORD_WIDTH) {
    return `The ford holds ${FORD_WIDTH}. Your semaphore admitted ${analysis.capacity}.`;
  }
  return null;
}

function whyItHappened(analysis: Analysis): string {
  const notes: string[] = [];
  if (analysis.nearDeficit > 0) notes.push(WHY.raced);
  if (analysis.farValue !== analysis.farExpected) notes.push(WHY.twoLocks);
  if (analysis.sableWait > 0) notes.push(WHY.inversion);
  if (analysis.inheritanceToggled) notes.push(INHERITANCE_NOTE);
  if (analysis.interruptsDisabled) notes.push(INTERRUPT_NOTE);
  if (notes.length === 0) notes.push(WHY.clean);
  return notes.join(' ');
}

export function evaluate(ctx: LegEvaluationContext): LegOutcome {
  const analysis = analyse(ctx);
  const casualties = ctx.run.convoy.filter((member) => member.status === 'derezzed').map((member) => member.id);
  const corrupted = analysis.farDeficit !== 0;

  // Hand-off 6. The Archive opens with an intact manifest when this is absent,
  // so it is written on every run and its outcome says which one this was.
  ctx.run.decisions.push({
    tick: ctx.kernelSnapshot.tick,
    legId: 'the_narrows',
    kind: MANIFEST_SEED,
    choice: String(analysis.farValue),
    outcome: corrupted ? 'costly' : 'good',
    relatedObjective: null,
  });

  const options = analysis.crossingOptions.map((entry) => entry.option);
  return {
    survived: ctx.run.convoy.some((member) => member.status !== 'derezzed'),
    objectivesMet: objectivesFrom(analysis, ctx.run),
    casualties,
    resourceDelta: {},
    codexUnlocked: codexFrom(analysis),
    debrief: {
      headline: corrupted ? HEADLINE_CORRUPT : HEADLINE_CLEAN,
      whatHappened: `You crossed ${analysis.crossingOptions.length} sections: ${options.length === 0 ? 'none' : options.join(', ')}. `
        + `Races detected: ${analysis.races.length}, and ${analysis.nearDeficit + analysis.farDeficit} increments were lost. `
        + `Spun ticks: ${analysis.spunTicks}. The near post reads ${analysis.nearValue} and should read ${analysis.nearExpected}; `
        + `the far post reads ${analysis.farValue} and should read ${analysis.farExpected}.`,
      whyItHappened: whyItHappened(analysis),
      counterfactual: counterfactualFor(analysis),
      chapter: CRITICAL_SECTION,
    },
  };
}

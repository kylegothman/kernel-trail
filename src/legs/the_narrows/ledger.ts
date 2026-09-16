/**
 * KERNEL TRAIL, the Narrows: the ledger posts and the Programs that write them.
 *
 * This is the leg's workload, carried through `LegContent.workload` (WP-L04
 * ruling 1). Four shared cells and five instruction programs, assembled here
 * and handed to the kernel at spawn:
 *
 *  - `ledger.near` is the near post, incremented by both pilgrims with an
 *    unguarded load, add and store. Three instructions, one number, and a
 *    preemption anywhere between the first and the third loses an increment.
 *  - `ledger.far` is the far post, which is the convoy's manifest. Both
 *    pilgrims guard their write to it, correctly, with a mutex each. The
 *    mutexes have different names and the post is still wrong, and that is the
 *    second misconception in one configuration the kernel genuinely permits.
 *  - `ctl.cas` and `ctl.capacity` are the player's two switches. A Program
 *    reads them at the top of each iteration, which is how an interaction
 *    changes what the workload does without the leg reaching into the kernel
 *    mid-tick.
 *
 * Both control cells are written by the interactions through the shared region
 * directly, never by a Program, so the race detector records loads on them and
 * never a store: a cell whose accesses are all loads is never reported, which
 * keeps the switches out of the race list the player is reading.
 */
import { asPageId, asPid, asResourceId, type Pid, type ResourceId } from '@kernel/types';
import type { Instruction } from '@kernel/process/Program';
import type { SyncInstruction, SyncValue } from '@kernel/sync/SyncSubsystem';
import type { ReplayKernel } from '@game/replay/types';

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

export const PILGRIM_A = 'narrows.pilgrim_a';
export const PILGRIM_B = 'narrows.pilgrim_b';
export const SWEEP = 'narrows.sweep';
export const HAULER = 'narrows.hauler';
export const SABLE_PROCESS = 'SABLE';

export const LOCK_FORD_A = asResourceId('lock.ford_a');
export const LOCK_FORD_B = asResourceId('lock.ford_b');
export const LOCK_MANIFEST = asResourceId('lock.manifest');
export const MON_FORD = asResourceId('mon.ford');
/** One semaphore per capacity the dial can select; `declareSync` fixes a count at creation. */
export const SEM_FORD = asResourceId('sem.ford');
export const SEM_FORD_3 = asResourceId('sem.ford.3');
export const SEM_FORD_4 = asResourceId('sem.ford.4');

export const REGION_NEAR = asResourceId('ledger.near');
export const REGION_FAR = asResourceId('ledger.far');
export const REGION_CAS = asResourceId('ctl.cas');
export const REGION_CAPACITY = asResourceId('ctl.capacity');
export const REGION_INHERIT = asResourceId('ctl.inherit');

export const CELL_NEAR = 'region:ledger.near';
export const CELL_FAR = 'region:ledger.far';
export const CELL_CAS = 'region:ctl.cas';
export const CELL_CAPACITY = 'region:ctl.capacity';
export const CELL_INHERIT = 'region:ctl.inherit';

/** The ford is three body widths wide at the ford section and one at the plank. */
export const FORD_WIDTH = 3;
/** Increments each pilgrim makes to the near post. Its expected total is twice this, plus the sweep stamp. */
export const NEAR_INCREMENTS = 2;
/** Ticks a Program spends on the span between reading the post and writing it back. */
export const PLANK_CROSSING = 2;
/** Ticks a Program spends outside the guard between writes to the far post. */
export const FAR_REMAINDER = 1;
/** Ticks a Program spends crossing between reading the far post and writing it. */
export const FAR_CROSSING = 4;
export const FAR_INCREMENTS = 2;
/**
 * Entries a Program makes at the ford between readings of the capacity dial.
 * Entry and release are one instruction each and both are real operations, so
 * this is the rate at which a Program that has finished its own work keeps
 * taking its turn.
 */
export const FORD_ENTRIES_PER_READ = 8;


/* ------------------------------------------------------------------ */
/* A two-pass assembler, because a branch target is an absolute index  */
/* ------------------------------------------------------------------ */

type Test = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge';

export type Piece =
  | { readonly kind: 'at'; readonly instruction: Instruction }
  | { readonly kind: 'label'; readonly name: string }
  | { readonly kind: 'branch'; readonly left: SyncValue; readonly test: Test; readonly right: SyncValue; readonly to: string };

const sync = (operation: SyncInstruction): Piece => ({ kind: 'at', instruction: { kind: 'sync', operation } });
/**
 * A primitive operation as a syscall rather than a bare instruction. The
 * semantics are identical, and it is what puts the operation in the syscall
 * log, which is the log `trace` prints: an acquisition a Program made through
 * an instruction is invisible to the command the leg hands the player.
 */
const call = (name: 'mutex_lock' | 'mutex_unlock' | 'sem_wait' | 'sem_post', resource: ResourceId): Piece =>
  ({ kind: 'at', instruction: { kind: 'syscall', call: { name, pid: asPid(1), args: [resource] } } });
export const lit = (value: number): SyncValue => ({ kind: 'literal', value });
export const reg = (name: string): SyncValue => ({ kind: 'register', name });
const label = (name: string): Piece => ({ kind: 'label', name });
const branch = (left: SyncValue, test: Test, right: SyncValue, to: string): Piece => ({ kind: 'branch', left, test, right, to });
/** An unconditional jump: the only shape the instruction set has for one. */
const jump = (to: string): Piece => branch(lit(0), 'eq', lit(0), to);

export interface Assembly {
  readonly program: readonly Instruction[];
  /** Instruction index of each label, so a test can name a region of the program. */
  readonly labels: Readonly<Record<string, number>>;
}

export function assemble(pieces: readonly Piece[]): Assembly {
  const labels: Record<string, number> = {};
  let index = 0;
  for (const piece of pieces) {
    if (piece.kind === 'label') {
      if (labels[piece.name] !== undefined) throw new Error(`the_narrows: duplicate label ${piece.name}`);
      labels[piece.name] = index;
    } else index += 1;
  }
  const program = pieces.flatMap((piece): readonly Instruction[] => {
    if (piece.kind === 'label') return [];
    if (piece.kind === 'at') return [piece.instruction];
    const target = labels[piece.to];
    if (target === undefined) throw new Error(`the_narrows: branch to an undeclared label ${piece.to}`);
    return [{ kind: 'sync', operation: { op: 'branch', left: piece.left, test: piece.test, right: piece.right, target } }];
  });
  return { program, labels };
}

/* ------------------------------------------------------------------ */
/* The segments                                                        */
/* ------------------------------------------------------------------ */

/**
 * The plank. An unguarded read-modify-write with the crossing itself between
 * the load and the store, which is the window the interleaving needs. Once the
 * player installs compare-and-swap the loop takes the second path: an atomic
 * read, then a compare-and-swap that retries when another Program got in
 * between, which cannot lose an update however it is scheduled.
 */
function plank(tag: string): readonly Piece[] {
  return [
    sync({ op: 'set', into: 'n', value: lit(NEAR_INCREMENTS) }),
    label(`${tag}.loop`),
    sync({ op: 'load', cell: CELL_CAS, into: 'c', rmw: false }),
    branch(reg('c'), 'eq', lit(1), `${tag}.atomic`),
    sync({ op: 'load', cell: CELL_NEAR, into: 'r', rmw: true }),
    sync({ op: 'add', into: 'r', value: lit(1) }),
    sync({ op: 'work', ticks: PLANK_CROSSING }),
    sync({ op: 'store', cell: CELL_NEAR, value: reg('r'), rmw: true }),
    jump(`${tag}.next`),
    label(`${tag}.atomic`),
    label(`${tag}.retry`),
    // Reading through compare-and-swap with an impossible expected value: the
    // cell is a count and never holds -1, so this reads and never writes.
    sync({ op: 'cas', cell: CELL_NEAR, expected: lit(-1), replacement: lit(-1), into: 'r' }),
    sync({ op: 'set', into: 't', value: reg('r') }),
    sync({ op: 'add', into: 't', value: lit(1) }),
    sync({ op: 'cas', cell: CELL_NEAR, expected: reg('r'), replacement: reg('t'), into: 'o' }),
    branch(reg('o'), 'ne', reg('r'), `${tag}.retry`),
    label(`${tag}.next`),
    sync({ op: 'add', into: 'n', value: lit(-1) }),
    branch(reg('n'), 'gt', lit(0), `${tag}.loop`),
  ];
}

/**
 * The second ford. Six instructions from the acquire to the release, holding
 * this Program's own mutex over its own read-modify-write of the far post.
 * Correct in isolation, by every rule the man page states, and the post is
 * still wrong, because the other Program writing it guards it with a
 * different mutex and no hardware associates either one with the data.
 */
function secondFord(tag: string, lock: ResourceId): readonly Piece[] {
  return [
    sync({ op: 'set', into: 'm', value: lit(FAR_INCREMENTS) }),
    label(`${tag}.loop`),
    label(`${tag}.guard.first`),
    call('mutex_lock', lock),
    sync({ op: 'load', cell: CELL_FAR, into: 'r', rmw: true }),
    sync({ op: 'add', into: 'r', value: lit(1) }),
    // The post is at the far end of the span and a Program that has read it
    // still has to cross to write it. Both Programs hold a lock over the whole
    // crossing, and the two locks have nothing to do with each other.
    sync({ op: 'work', ticks: FAR_CROSSING }),
    sync({ op: 'store', cell: CELL_FAR, value: reg('r'), rmw: true }),
    call('mutex_unlock', lock),
    label(`${tag}.guard.last`),
    // The remainder section. It is outside the guard by construction, and its
    // length is what decides whether two Programs guarding one post with two
    // locks ever have their read-modify-writes overlap.
    sync({ op: 'work', ticks: FAR_REMAINDER }),
    sync({ op: 'add', into: 'm', value: lit(-1) }),
    branch(reg('m'), 'gt', lit(0), `${tag}.loop`),
  ];
}

/**
 * The wide ford, and the tail every Program in this leg ends on. A Program
 * that has finished its own work joins the queue and keeps taking its turn,
 * which is what the convoy is doing for the whole leg and what keeps the
 * crossing a live reading rather than an empty one.
 *
 * The turns are taken at the wide part, which holds three Programs and has
 * room for the convoy. How many the ford admits at the crossing itself is the
 * dial, and the dial selects which of the three declared semaphores the
 * crossing is resolved against: a count is fixed when a semaphore is created
 * and there is no runtime raise, so the three counts are three semaphores.
 */
function wideFord(tag: string): readonly Piece[] {
  return [
    label(`${tag}.loop`),
    ...Array.from({ length: FORD_ENTRIES_PER_READ }).flatMap(() => [call('sem_wait', SEM_FORD_3), call('sem_post', SEM_FORD_3)]),
    jump(`${tag}.loop`),
  ];
}

/** Both pilgrims step onto the plank, and that is the whole of what they are for. */
const PILGRIM_A_ASSEMBLY = assemble([...plank('plank'), ...wideFord('wide')]);
const PILGRIM_B_ASSEMBLY = assemble([...plank('plank'), ...wideFord('wide')]);


/**
 * The low-priority holder. It takes the manifest lock first and keeps it far
 * too long, and it reads the inheritance switch at every turn of the hold.
 *
 * That read is what priority inheritance buys, modelled where the leg is
 * allowed to model it. The kernel's own `priorityInheritance` is frozen tuning
 * with no write path, so the toggle does not donate priority through the lock;
 * what it does is let the holder finish its section and release, which is the
 * outcome inheritance exists to produce. The debrief says which of the two the
 * player got.
 */
const SWEEP_ASSEMBLY = assemble([
  // The sweep stamps the near post as it passes, in one instruction, before
  // anything else in the leg is runnable. Every Program that touches the post
  // afterwards is touching a number another Program wrote with nothing held
  // between them, which is the definition the leg is here to demonstrate and
  // is true whatever the scheduler does with the rest of the run.
  sync({ op: 'store', cell: CELL_NEAR, value: lit(0), rmw: false }),
  call('mutex_lock', LOCK_MANIFEST),
  label('hold.turn'),
  sync({ op: 'load', cell: CELL_INHERIT, into: 'i', rmw: false }),
  branch(reg('i'), 'eq', lit(1), 'hold.release'),
  // The work the sweep is doing instead of finishing: it takes its turns at
  // the wide part of the ford, where there is room for it, and keeps the
  // manifest shut the whole time it is doing so. This is the affliction entry
  // word for word, and it is why the holder never reaches its own release.
  ...Array.from({ length: FORD_ENTRIES_PER_READ }).flatMap(() => [call('sem_wait', SEM_FORD_4), call('sem_post', SEM_FORD_4)]),
  jump('hold.turn'),
  label('hold.release'),
  call('mutex_unlock', LOCK_MANIFEST),
  ...wideFord('wide'),
]);

/** The medium-priority preemptor: it holds nothing, needs nothing, and runs. */
/**
 * The medium-priority preemptor. It holds nothing the convoy needs, it is
 * always runnable, and it spends the leg at the ford, which is the whole of
 * its part in the inversion: something at a priority between the waiter and
 * the holder has to be running for the holder to be the one that never does.
 */
/**
 * The hauler and LUMEN write the far post, each under its own mutex. Both
 * guards are correct by every rule the man page states and the post is wrong
 * anyway, because nothing in the hardware associates either lock with the
 * number they are both writing. One of the two is a Program of the convoy,
 * which is why the number is the convoy's own problem nine legs later.
 */
const HAULER_ASSEMBLY = assemble([...secondFord('ford', LOCK_FORD_B), ...wideFord('wide')]);
const LUMEN_ASSEMBLY = assemble([...secondFord('ford', LOCK_FORD_A), ...wideFord('wide')]);

/** The convoy takes its turn at the ford, which is where this leg is spent. */
const TRAVELLER_ASSEMBLY = assemble([...wideFord('wide')]);




/** SABLE, who needs the manifest lock and is the highest priority Program in the convoy. */
const SABLE_ASSEMBLY = assemble([
  sync({ op: 'work', ticks: 1 }),
  call('mutex_lock', LOCK_MANIFEST),
  sync({ op: 'work', ticks: 2 }),
  call('mutex_unlock', LOCK_MANIFEST),
  ...wideFord('wide'),
]);

/**
 * The instruction range a correct `lock --mark` covers: the acquire through
 * the release, which holds the whole read-modify-write of the far post and
 * nothing else. Both Programs that write it assemble the same segment, so one
 * range names both.
 */
export const GUARDED_REGION: { readonly first: number; readonly last: number } = {
  first: LUMEN_ASSEMBLY.labels['ford.guard.first'] ?? -1,
  // The label sits after the release, so the last guarded instruction is the one before it.
  last: (LUMEN_ASSEMBLY.labels['ford.guard.last'] ?? 0) - 1,
};

export const programs: Readonly<Record<string, readonly Instruction[]>> = {
  LUMEN: LUMEN_ASSEMBLY.program,
  ORRERY: TRAVELLER_ASSEMBLY.program,
  KESTREL: TRAVELLER_ASSEMBLY.program,
  VESPER: TRAVELLER_ASSEMBLY.program,
  [PILGRIM_A]: PILGRIM_A_ASSEMBLY.program,
  [PILGRIM_B]: PILGRIM_B_ASSEMBLY.program,
  [SWEEP]: SWEEP_ASSEMBLY.program,
  [HAULER]: HAULER_ASSEMBLY.program,
  [SABLE_PROCESS]: SABLE_ASSEMBLY.program,
};

/** Service ticks each programmed process needs to reach the end of its program. */
export const PROGRAM_SERVICE: Readonly<Record<string, number>> = {
  LUMEN: 200, ORRERY: 12, KESTREL: 12, VESPER: 12,
  [PILGRIM_A]: 140,
  [PILGRIM_B]: 140,
  [SWEEP]: 140,
  [HAULER]: 60,
  [SABLE_PROCESS]: 90,
};

/* ------------------------------------------------------------------ */
/* Installation and the two switches                                   */
/* ------------------------------------------------------------------ */

/** Each region gets a distinct address space and page, so no two share backing. */
const REGIONS: readonly { readonly id: ResourceId; readonly cell: string; readonly owner: string; readonly page: number }[] = [
  { id: REGION_NEAR, cell: CELL_NEAR, owner: PILGRIM_A, page: 0 },
  { id: REGION_FAR, cell: CELL_FAR, owner: PILGRIM_A, page: 1 },
  { id: REGION_CAS, cell: CELL_CAS, owner: PILGRIM_A, page: 2 },
  { id: REGION_CAPACITY, cell: CELL_CAPACITY, owner: PILGRIM_B, page: 0 },
  { id: REGION_INHERIT, cell: CELL_INHERIT, owner: PILGRIM_B, page: 1 },
];

export function install(kernel: ReplayKernel, spawned: ReadonlyMap<string, Pid>): void {
  for (const region of REGIONS) {
    const pid = spawned.get(region.owner);
    const process = pid === undefined ? undefined : kernel.process(pid);
    if (process === undefined) throw new Error(`the_narrows: ${region.owner} was not spawned, so ${region.id} has no backing space`);
    kernel.ipc.createSharedRegion({ id: region.id, space: process.addressSpaceId, pages: [asPageId(region.page)], attached: [], value: 0 });
    kernel.syncSubsystem.addRegionCell(region.cell, region.id);
  }
  setCapacityDial(kernel, 1);
}

function regionValue(kernel: ReplayKernel, id: ResourceId): number {
  return kernel.ipc.sharedRegion(id)?.value ?? 0;
}

function setRegionValue(kernel: ReplayKernel, id: ResourceId, value: number): void {
  const region = kernel.ipc.sharedRegion(id);
  if (region !== undefined) region.value = value;
}

/** The compare-and-swap switch at the plank. Every later iteration takes the atomic path. */
export function installCompareAndSwap(kernel: ReplayKernel): void {
  setRegionValue(kernel, REGION_CAS, 1);
}

export function compareAndSwapInstalled(kernel: ReplayKernel): boolean {
  return regionValue(kernel, REGION_CAS) === 1;
}

/** The inheritance switch. The holder reads it at every turn of its hold and releases when it is set. */
export function enableInheritance(kernel: ReplayKernel): void {
  setRegionValue(kernel, REGION_INHERIT, 1);
}

export function inheritanceEnabled(kernel: ReplayKernel): boolean {
  return regionValue(kernel, REGION_INHERIT) === 1;
}

/**
 * The capacity dial: 1, then 3, then 4, then back to 1. The ford holds three.
 * It selects which of the three declared semaphores the wide-ford crossing is
 * resolved against, because a semaphore's count is fixed when it is created.
 */
export const CAPACITY_POSITIONS: readonly number[] = [1, FORD_WIDTH, 4];

export function capacityDial(kernel: ReplayKernel): number {
  return regionValue(kernel, REGION_CAPACITY);
}

export function setCapacityDial(kernel: ReplayKernel, value: number): void {
  setRegionValue(kernel, REGION_CAPACITY, value);
}

export function advanceCapacityDial(kernel: ReplayKernel): number {
  const current = capacityDial(kernel);
  const index = CAPACITY_POSITIONS.indexOf(current);
  const next = CAPACITY_POSITIONS[(index + 1) % CAPACITY_POSITIONS.length] ?? 1;
  setCapacityDial(kernel, next);
  return next;
}

/** The semaphore the ford is admitting through at this dial position. */
export function fordSemaphore(capacity: number): ResourceId {
  return capacity === FORD_WIDTH ? SEM_FORD_3 : capacity === 4 ? SEM_FORD_4 : SEM_FORD;
}

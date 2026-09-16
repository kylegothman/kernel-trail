/**
 * The requisition: six windows, and the pure reducer that derives the whole
 * requisition state from the leg's decision log.
 *
 * An interaction handler mutates `RunState` alone (scope correction 17.3), so
 * the leg keeps no state of its own. Every player verb at the depot is a bus
 * command whose `DecisionRecord` carries its argument after the anchor id
 * (`anchor.win.quota:kernel`, `anchor.win.quota:40`), and both the handlers
 * and `evaluate` call `reduceRequisition` over the same records. The kernel
 * traps the world dispatches beside each submission are `syscall` commands;
 * they are what `mode --history` and the CPU pillar show, and the leg reads
 * their `syscall.invoked` events for the EPERM count alone.
 *
 * Prices are the leg 0 depot prices of narrative bible 5.7 through the shipped
 * prices module: the run's disc class allocation was issued at run creation,
 * so the requisition exchanges within it, and a release is refunded at the
 * same rate (pre-flight ruling 3). The trap cost is the curriculum map's 4
 * cycles per submission, whatever the submission carries.
 */
import type { SyscallName } from '@kernel/types';
import { BASE_PRICES, price, type DepotItemId } from '@game/depot/prices';
import type { DecisionRecord, DifficultyTier, DiscClass, ResourceKind, ResourceLedger } from '@game/types';

export type WindowId = 'quota' | 'blocks' | 'bandwidth' | 'manifest' | 'identity' | 'priority';
export type WindowMode = 'kernel' | 'user';
export type SubmissionErrno = 'EPERM' | 'EINVAL' | 'ENOMEM';

/** Cycles charged per submission, curriculum map leg 0, "The mechanic". */
export const TRAP_COST = 4;

export const WINDOW_IDS: readonly WindowId[] = ['quota', 'blocks', 'bandwidth', 'manifest', 'identity', 'priority'];

export const windowAnchor = (id: WindowId): string => `anchor.win.${id}`;

export interface WindowDef {
  readonly id: WindowId;
  readonly anchor: string;
  readonly service: string;
  /** The kernel calls the world dispatches beside a submission at this window. */
  readonly syscalls: readonly SyscallName[];
  readonly correctMode: WindowMode;
  /** The ledger stock the window exchanges, or null for a service with no goods. */
  readonly resource: 'quota' | 'blocks' | 'bandwidth' | null;
  /** The depot lot the price is quoted on (narrative 5.7), or null when nothing is priced. */
  readonly lot: { readonly item: DepotItemId; readonly units: number } | null;
  /** The amount a bare submission at this window carries. */
  readonly defaultAmount: number;
}

export const WINDOWS: readonly WindowDef[] = [
  { id: 'quota', anchor: windowAnchor('quota'), service: 'Request memory quota', syscalls: ['brk'], correctMode: 'kernel', resource: 'quota', lot: { item: 'quota_lot', units: 25 }, defaultAmount: 25 },
  { id: 'blocks', anchor: windowAnchor('blocks'), service: 'Requisition storage blocks', syscalls: ['open', 'write'], correctMode: 'kernel', resource: 'blocks', lot: { item: 'block_lot', units: 10 }, defaultAmount: 10 },
  { id: 'bandwidth', anchor: windowAnchor('bandwidth'), service: 'Widen the I/O grant', syscalls: ['ioctl'], correctMode: 'kernel', resource: 'bandwidth', lot: { item: 'bandwidth_lot', units: 5 }, defaultAmount: 5 },
  { id: 'manifest', anchor: windowAnchor('manifest'), service: 'Open the convoy manifest', syscalls: ['open'], correctMode: 'kernel', resource: null, lot: null, defaultAmount: 0 },
  { id: 'identity', anchor: windowAnchor('identity'), service: 'Read the convoy pid set', syscalls: ['getpid'], correctMode: 'user', resource: null, lot: null, defaultAmount: 0 },
  { id: 'priority', anchor: windowAnchor('priority'), service: 'Lower a Program starting priority', syscalls: ['nice'], correctMode: 'user', resource: null, lot: null, defaultAmount: 1 },
];

const BY_ID: ReadonlyMap<WindowId, WindowDef> = new Map(WINDOWS.map((def) => [def.id, def]));

export function windowDef(id: WindowId): WindowDef {
  const def = BY_ID.get(id);
  if (def === undefined) throw new Error(`boot_sector: no window ${id}`);
  return def;
}

const isWindowId = (value: string): value is WindowId => (WINDOW_IDS as readonly string[]).includes(value);
const isMode = (value: string): value is WindowMode => value === 'kernel' || value === 'user';

/** Cycles per unit at the leg 0 depot rate, narrative 5.7 at legIndex 0 and the tier's factor. */
export function unitPrice(def: WindowDef, tier: DifficultyTier): number {
  if (def.lot === null) return 0;
  return price(BASE_PRICES[def.lot.item].cycles, 0, tier) / def.lot.units;
}

export interface RequisitionItem {
  readonly window: WindowId;
  /** Units for a stocked window, a priority delta for the priority window, 0 for a service with no goods. */
  readonly amount: number;
}

export interface Submission {
  /** Index into the run's decision log of the `boot.trap_purchase` record. */
  readonly decisionIndex: number;
  readonly window: WindowId | null;
  readonly mode: WindowMode;
  readonly items: readonly RequisitionItem[];
  readonly errno: SubmissionErrno | null;
  /** The goods and their cycle cost when the submission succeeded; the trap cost is the interaction's own. */
  readonly delta: Partial<ResourceLedger>;
}

export interface ManInvocation {
  readonly topic: string;
  readonly decisionIndex: number;
}

export interface RequisitionState {
  readonly modes: Readonly<Record<WindowId, WindowMode>>;
  readonly pending: readonly RequisitionItem[];
  readonly submissions: readonly Submission[];
  /** The mode in force on the first submission that carried each service. */
  readonly labels: Readonly<Partial<Record<WindowId, WindowMode>>>;
  readonly directReaches: number;
  readonly manInvocations: readonly ManInvocation[];
  readonly gate: { readonly answer: string; readonly correct: boolean } | null;
}

/** Every toggle starts on user: the convoy arrives unprivileged. */
const INITIAL_MODES: Readonly<Record<WindowId, WindowMode>> = { quota: 'user', blocks: 'user', bandwidth: 'user', manifest: 'user', identity: 'user', priority: 'user' };

const TERMINAL_PREFIX = '[terminal] ';

export interface ParsedInteraction {
  readonly id: string;
  readonly anchor: string;
  readonly argument: string | null;
}

/** `id @ anchor[:argument]` as the bus records it, with the terminal provenance prefix stripped. */
export function parseInteractionChoice(choice: string): ParsedInteraction | null {
  const text = choice.startsWith(TERMINAL_PREFIX) ? choice.slice(TERMINAL_PREFIX.length) : choice;
  const at = text.indexOf(' @ ');
  if (at < 0) return null;
  const id = text.slice(0, at);
  const rest = text.slice(at + 3);
  const colon = rest.indexOf(':');
  if (colon < 0) return { id, anchor: rest, argument: null };
  return { id, anchor: rest.slice(0, colon), argument: rest.slice(colon + 1) };
}

function windowOf(anchor: string): WindowId | null {
  const prefix = 'anchor.win.';
  if (!anchor.startsWith(prefix)) return null;
  const id = anchor.slice(prefix.length);
  return isWindowId(id) ? id : null;
}

function amountOf(argument: string | null, def: WindowDef): number | null {
  if (argument === null || argument === '') return def.defaultAmount;
  if (!/^-?\d+$/.test(argument)) return null;
  const amount = Number(argument);
  return Number.isSafeInteger(amount) ? amount : null;
}

/** The disc class table of narrative bible 4 and 5.2: which resource each class is short of (pre-flight ruling 4). */
export const SHORT_RESOURCE: Readonly<Record<DiscClass, ResourceKind>> = {
  // The shell is out-issued by another class on blocks alone (daemon 160 to its 120).
  shell: 'blocks',
  // The daemon's smallest share of the shell allocation is cycles, 1100 of 1600.
  daemon: 'cycles',
  // The compiler's smallest share of the shell allocation is cycles, 700 of 1600.
  compiler: 'cycles',
};

const RESOURCE_KINDS: readonly ResourceKind[] = ['cycles', 'quota', 'blocks', 'bandwidth', 'integrity'];

/** The static result of a submission: the errno the window itself returns before any ledger is consulted. */
function staticErrno(mode: WindowMode, items: readonly RequisitionItem[]): SubmissionErrno | null {
  for (const item of items) {
    const def = windowDef(item.window);
    if (def.resource !== null && item.amount === 0) return 'EINVAL';
    if (def.resource === null && def.id !== 'priority' && item.amount !== 0) return 'EINVAL';
  }
  for (const item of items) {
    const def = windowDef(item.window);
    if (def.correctMode === 'kernel' && mode === 'user') return 'EPERM';
    // Lowering a claim needs no privilege. Raising one does, and the window refuses it in either mode.
    if (def.id === 'priority' && item.amount < 0) return 'EPERM';
  }
  return null;
}

/** The goods a successful submission moves, cycles included, trap cost excluded. */
export function goodsDelta(items: readonly RequisitionItem[], tier: DifficultyTier): Partial<ResourceLedger> {
  const delta: Partial<ResourceLedger> = {};
  let cost = 0;
  for (const item of items) {
    const def = windowDef(item.window);
    if (def.resource === null) continue;
    delta[def.resource] = (delta[def.resource] ?? 0) + item.amount;
    cost += item.amount * unitPrice(def, tier);
  }
  const cycles = Math.round(cost);
  if (cycles !== 0) delta.cycles = -cycles;
  return delta;
}

/**
 * Walk this leg's records in order. A `costly` outcome on a submission the
 * windows would have accepted means the handler found the ledger short and
 * refused it with ENOMEM; the handler is the only writer of that outcome.
 */
export function reduceRequisition(decisions: readonly DecisionRecord[], discClass: DiscClass, tier: DifficultyTier): RequisitionState {
  const modes: Record<WindowId, WindowMode> = { ...INITIAL_MODES };
  const labels: Partial<Record<WindowId, WindowMode>> = {};
  let pending: RequisitionItem[] = [];
  const submissions: Submission[] = [];
  const manInvocations: ManInvocation[] = [];
  let directReaches = 0;
  let gate: RequisitionState['gate'] = null;
  decisions.forEach((record, decisionIndex) => {
    if (record.legId !== 'boot_sector') return;
    if (record.kind === 'terminal') {
      const line = (record.choice.startsWith(TERMINAL_PREFIX) ? record.choice.slice(TERMINAL_PREFIX.length) : record.choice).trim();
      if (line.startsWith('man ')) manInvocations.push({ topic: line.slice(4).trim(), decisionIndex });
      return;
    }
    if (record.kind !== 'interaction') return;
    const parsed = parseInteractionChoice(record.choice);
    if (parsed === null) return;
    const window = windowOf(parsed.anchor);
    switch (parsed.id) {
      case 'boot.set_mode': {
        if (window !== null && parsed.argument !== null && isMode(parsed.argument)) modes[window] = parsed.argument;
        return;
      }
      case 'boot.batch_request': {
        if (window === null) return;
        const amount = amountOf(parsed.argument, windowDef(window));
        if (amount !== null) pending.push({ window, amount });
        return;
      }
      case 'boot.trap_purchase': {
        const mode = window === null ? 'user' : modes[window];
        const items = window === null ? [] : pending.length > 0 ? pending : [{ window, amount: windowDef(window).defaultAmount }];
        pending = [];
        let errno: SubmissionErrno | null = window === null ? 'EINVAL' : staticErrno(mode, items);
        if (errno === null && record.outcome === 'costly') errno = 'ENOMEM';
        for (const item of items) if (labels[item.window] === undefined) labels[item.window] = mode;
        submissions.push({ decisionIndex, window, mode, items, errno, delta: errno === null ? goodsDelta(items, tier) : {} });
        return;
      }
      case 'boot.direct_reach':
        directReaches += 1;
        return;
      case 'boot.choose_disc': {
        const answer = parsed.argument ?? '';
        gate = { answer, correct: (RESOURCE_KINDS as readonly string[]).includes(answer) && answer === SHORT_RESOURCE[discClass] };
        return;
      }
      default:
        return;
    }
  });
  return { modes, pending, submissions, labels, directReaches, manInvocations, gate };
}

/** The services a successful submission carried, across all successful submissions. */
export function acquiredServices(state: RequisitionState): ReadonlySet<WindowId> {
  const acquired = new Set<WindowId>();
  for (const submission of state.submissions) {
    if (submission.errno !== null) continue;
    for (const item of submission.items) acquired.add(item.window);
  }
  return acquired;
}

export function correctLabels(state: RequisitionState): number {
  return WINDOW_IDS.filter((id) => state.labels[id] === windowDef(id).correctMode).length;
}

/** The index of the first successful submission, or null. */
export function firstSuccessIndex(state: RequisitionState): number | null {
  return state.submissions.find((submission) => submission.errno === null)?.decisionIndex ?? null;
}

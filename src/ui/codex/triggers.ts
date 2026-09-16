/**
 * Triggers: each `CodexUnlock` variant matched against the signals a run
 * produces. Narrative bible 14.1; WP-17 specification section 5.
 *
 * Four signal kinds derive from what the codex can see on its own: kernel
 * events (the `event` and `termination` unlocks), the convoy's afflictions
 * and the objectives met (watched on the run store). Four are facts the host
 * reports through `Codex.signal`: a crossing option taken and a leg completed
 * from the leg runner, a command submitted from the shell's `onCommand` hook,
 * and a metric read from the telemetry store once per tick (WP-21 section 5).
 *
 * `structureFor` names the world structure a pathology plays out on, so the
 * codex can ask whether it is on screen before offering the entry.
 */
import type { KernelEvent, TerminationReason } from '@kernel/types';
import type { AfflictionId, LegId } from '@game/types';
import type { CodexUnlock } from '@game/codexTypes';
import type { HudStructureName } from '../hud/structures';

export type CodexSignal =
  | { readonly kind: 'event'; readonly event: KernelEvent }
  | { readonly kind: 'affliction'; readonly id: AfflictionId }
  | { readonly kind: 'objective'; readonly id: string }
  | { readonly kind: 'crossing'; readonly option: 'spin' | 'block' | 'monitor' | 'wait' }
  | { readonly kind: 'leg_complete'; readonly leg: LegId }
  | { readonly kind: 'command'; readonly name: string; readonly argv: readonly string[] }
  | { readonly kind: 'metric'; readonly id: string; readonly value: number };

/** A command signal that counts toward a `command` unlock: the name matches and the flag, when named, is in argv. */
export function isCommandOccurrence(unlock: Extract<CodexUnlock, { kind: 'command' }>, signal: CodexSignal): boolean {
  return signal.kind === 'command' && signal.name === unlock.name && (unlock.flag === undefined || signal.argv.includes(unlock.flag));
}

/**
 * `occurrence` is which matching command submission this signal is for the
 * entry, counted from 1 per entry by the codex; a `command` unlock with `nth`
 * fires on exactly that one. `metric` compares strictly.
 */
export function matchesUnlock(unlock: CodexUnlock, signal: CodexSignal, occurrence = 1): boolean {
  switch (unlock.kind) {
    case 'event':
      return signal.kind === 'event' && signal.event.type === unlock.type;
    case 'termination':
      return signal.kind === 'event' && signal.event.type === 'process.exited' && signal.event.reason === unlock.reason;
    case 'affliction':
      return signal.kind === 'affliction' && signal.id === unlock.id;
    case 'objective':
      return signal.kind === 'objective' && signal.id === unlock.id;
    case 'crossing':
      return signal.kind === 'crossing' && signal.option === unlock.option;
    case 'leg_complete':
      return signal.kind === 'leg_complete' && signal.leg === unlock.leg;
    case 'command':
      return isCommandOccurrence(unlock, signal) && (unlock.nth === undefined || occurrence === unlock.nth);
    case 'metric':
      return signal.kind === 'metric' && signal.id === unlock.id && signal.value > unlock.above;
    default:
      return assertNever(unlock);
  }
}

const AFFLICTION_STRUCTURE: Readonly<Record<AfflictionId, HudStructureName>> = {
  priority_inversion: 'WaitForRing',
  memory_leak: 'FrameVault',
  starvation: 'ReadyQueueProcession',
  thrashing: 'PageOcean',
  lock_convoy: 'WaitForRing',
  livelock: 'WaitForRing',
  orphaned: 'ReadyQueueProcession',
  fragmented: 'FrameVault',
  cache_thrash: 'FrameVault',
  bit_rot: 'ArchiveShelves',
  stack_overflow: 'FrameVault',
  false_sharing: 'FrameVault',
  interrupt_storm: 'BusSpine',
};

const TERMINATION_STRUCTURE: Readonly<Record<TerminationReason, HudStructureName | null>> = {
  normal_exit: null,
  killed_by_user: null,
  killed_by_parent: 'ReadyQueueProcession',
  starvation: 'ReadyQueueProcession',
  deadlock_victim: 'WaitForRing',
  out_of_memory: 'FrameVault',
  thrashing_collapse: 'PageOcean',
  protection_fault: 'DomainRings',
  io_timeout: 'BusSpine',
  storage_corruption: 'ArchiveShelves',
};

/** The structure an event family plays out on, by the event type's prefix. */
export function structureForEventType(type: string): HudStructureName | null {
  const family = type.split('.')[0] ?? '';
  switch (family) {
    case 'process':
    case 'context':
    case 'quantum':
    case 'thread':
      return 'ReadyQueueProcession';
    case 'memory':
    case 'tlb':
      return type === 'memory.thrashing' ? 'PageOcean' : 'FrameVault';
    case 'sync':
    case 'resource':
    case 'bankers':
    case 'deadlock':
      return 'WaitForRing';
    case 'disk':
    case 'raid':
      return 'PlatterStack';
    case 'io':
      return 'BusSpine';
    case 'fs':
      return 'ArchiveShelves';
    case 'security':
      return 'DomainRings';
    default:
      return null;
  }
}

/** Null means the entry needs no structure on screen and is offered at once. */
export function structureFor(unlock: CodexUnlock): HudStructureName | null {
  switch (unlock.kind) {
    case 'affliction':
      return AFFLICTION_STRUCTURE[unlock.id];
    case 'termination':
      return TERMINATION_STRUCTURE[unlock.reason];
    case 'event':
      return structureForEventType(unlock.type);
    case 'objective':
    case 'crossing':
    case 'leg_complete':
    case 'command':
    case 'metric':
      return null;
    default:
      return assertNever(unlock);
  }
}

function assertNever(x: never): never {
  throw new Error(`codex: unhandled unlock ${JSON.stringify(x)}`);
}

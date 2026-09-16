/**
 * KERNEL TRAIL: the shipped command handlers and their definitions.
 *
 * Every definition is byte-identical to its `TerminalCommandDef` in
 * docs/05-CURRICULUM-MAP.md; the group modules hold them beside their
 * handlers. The base shell registers exactly the fourteen names of design brief
 * section 7, and the rest lie dormant until a leg registers the matching
 * definition through `Leg.terminalCommands`.
 */
import type { TerminalCommandDef } from '@game/types';
import type { ShippedHandler } from '../registry';
import { BASE_HANDLERS, MODE_DEF, SYSCALL_DEF } from './base';
import { AMDAHL_DEF, IPC_DEF, KILL_DEF, PROCESS_HANDLERS, PS_DEF, PSTREE_DEF, THREADS_DEF, TOP_DEF, WAIT_DEF } from './process';
import { GANTT_DEF, NICE_DEF, SCHED_DEF, SCHEDULER_HANDLERS } from './scheduler';
import { BUFFER_DEF, LOCK_DEF, RACE_DEF, RWLOCK_DEF, SEM_DEF, SYNC_HANDLERS, TRACE_DEF } from './sync';
import { BANKERS_DEF, DEADLOCK_HANDLERS, RESOURCES_DEF, WFG_DEF } from './deadlock';
import { BELADY_DEF, DEGREE_DEF, FRAG_DEF, FREE_DEF, MEMORY_HANDLERS, PAGETABLE_DEF, TLB_DEF, VMSTAT_DEF, WS_DEF } from './memory';

/** Design brief section 7: the always-available command set. */
export const BASE_COMMAND_NAMES: readonly string[] = [
  'ps', 'top', 'kill', 'nice', 'free', 'vmstat', 'iostat', 'lsof', 'mount', 'bankers', 'wfg', 'pagetable', 'trace', 'man',
];

/** Every definition this package transcribed, in curriculum map order. */
export const ALL_DEFINITIONS: readonly TerminalCommandDef[] = [
  SYSCALL_DEF, MODE_DEF,
  PS_DEF, WAIT_DEF, KILL_DEF, PSTREE_DEF, IPC_DEF,
  THREADS_DEF, AMDAHL_DEF, TOP_DEF,
  SCHED_DEF, NICE_DEF, GANTT_DEF,
  LOCK_DEF, RACE_DEF, TRACE_DEF,
  SEM_DEF, BUFFER_DEF, RWLOCK_DEF,
  WFG_DEF, BANKERS_DEF, RESOURCES_DEF,
  FREE_DEF, PAGETABLE_DEF, TLB_DEF, FRAG_DEF,
  VMSTAT_DEF, WS_DEF, BELADY_DEF, DEGREE_DEF,
];

/** Handlers by command name, one entry per shipped handler. */
export const SHIPPED_HANDLERS: ReadonlyMap<string, ShippedHandler> = new Map([
  ...BASE_HANDLERS, ...PROCESS_HANDLERS, ...SCHEDULER_HANDLERS, ...SYNC_HANDLERS, ...DEADLOCK_HANDLERS, ...MEMORY_HANDLERS,
]);

export function definitionOf(name: string): TerminalCommandDef | undefined {
  return ALL_DEFINITIONS.find(def => def.name === name);
}

export const BASE_DEFINITIONS: readonly TerminalCommandDef[] = BASE_COMMAND_NAMES
  .map(name => definitionOf(name))
  .filter((def): def is TerminalCommandDef => def !== undefined);

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

/** Design brief section 7: the always-available command set. */
export const BASE_COMMAND_NAMES: readonly string[] = [
  'ps', 'top', 'kill', 'nice', 'free', 'vmstat', 'iostat', 'lsof', 'mount', 'bankers', 'wfg', 'pagetable', 'trace', 'man',
];

/** Every definition this package transcribed, in curriculum map order. */
export const ALL_DEFINITIONS: readonly TerminalCommandDef[] = [];

/** Handlers by command name. Grows with each command group. */
export const SHIPPED_HANDLERS: ReadonlyMap<string, ShippedHandler> = new Map<string, ShippedHandler>();

export function definitionOf(name: string): TerminalCommandDef | undefined {
  return ALL_DEFINITIONS.find(def => def.name === name);
}

export const BASE_DEFINITIONS: readonly TerminalCommandDef[] = BASE_COMMAND_NAMES
  .map(name => definitionOf(name))
  .filter((def): def is TerminalCommandDef => def !== undefined);

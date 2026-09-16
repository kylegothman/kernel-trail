/** KERNEL TRAIL: the terminal, WP-15. */
export { Shell, callerPid, findProcess } from './Shell';
export type { ShellContext, ShellOptions } from './Shell';
export { CommandRegistry, DEFERRED_COMMANDS, fail, ok, nearest, editDistance } from './registry';
export type { ArgCompletion, CommandResult, CommandRun, CompletionKind, ShippedHandler, TerminalCommand } from './registry';
export { parse, bindFlags, classify, parseInteger, parseNumber, PARSER_TOPIC } from './parser';
export type { BindResult, BoundArgs, FlagSpec, ParseError, ParseResult, ParsedLine } from './parser';
export { table, kv, bar, percent, fixed } from './output';
export { History } from './history';
export { complete, valuesFor } from './completion';
export type { Completion } from './completion';
export { createEventRings, renderGantt, Ring, DEFAULT_RING_CAPACITY, GANTT_SEGMENT_CAPACITY } from './eventRings';
export type { EventRings, GanttSegment, ModeSwitch } from './eventRings';
export type { TerminalHost } from './host';
export type { CommandSink, SinkResult, TerminalCommandRequest } from './commandSink';
export { ALL_DEFINITIONS, BASE_COMMAND_NAMES, BASE_DEFINITIONS, SHIPPED_HANDLERS, definitionOf } from './commands/index';

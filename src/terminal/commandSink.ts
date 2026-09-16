/**
 * KERNEL TRAIL: the write path of the terminal (WP-15 scope correction T4).
 *
 * Every write the terminal makes, including every syscall a command issues on
 * the player's behalf, goes through `CommandSink.dispatch`, never through
 * `kernel.syscall` or a setter. The sink appends the DecisionRecord and calls
 * the mutator; the terminal's obligation is exactly one dispatch per policy
 * command. The types live in src/game/terminalHost.ts so WP-17's CommandBus can
 * implement them without importing the terminal layer.
 */
export type { CommandSink, SinkResult, TerminalCommandRequest } from '@game/terminalHost';

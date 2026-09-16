/**
 * KERNEL TRAIL: the interface the shell runs against (WP-15 scope correction T1).
 *
 * Declared in src/game/terminalHost.ts, because architecture 1.3 lets
 * `terminal` import `game` but not the reverse, and the game layer is where the
 * kernel's runtime values (syscall specs, errno substitutions, policy
 * registries) are bound to the host. Terminal code imports it from here.
 */
export type { TerminalHost } from '@game/terminalHost';

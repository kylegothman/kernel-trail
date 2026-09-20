/**
 * WP-24 section 1: the player's clock.
 *
 * The loop keeps its `timeScale` semantics; this module owns wall time on top
 * of it. A rate is ticks per second, mapped onto the loop as
 * `ticksPerSecond / TICK_HZ`, so the default of two ticks a second is a scale
 * of 0.1. A hold pauses the loop and remembers the rate; holds stack by name
 * and the last release restores it, so a debrief and a crossing open at once
 * release in either order without unpausing early. The harness and the replay
 * worker never touch this file; they drive ticks directly.
 */
import { TICK_HZ, type GameLoop } from './loop';

/** The default a person gets. */
export const PLAYER_TICK_HZ = 2;
/** Slow, normal, fast, as loop scales: 1, 2 and 4 ticks a second. */
export const PLAYER_TIME_SCALES = [0.5, 1, 2] as const;

export interface Pacing {
  /** Ticks per second now, 0 when held. */
  readonly rate: () => number;
  setRate(ticksPerSecond: number): void;
  /** Pause until the returned release is called. Releasing twice is harmless. */
  hold(reason: string): () => void;
  /** Hold names in the order they were taken; the last is the top. */
  readonly held: () => readonly string[];
}

/** The rate a loop scale from `PLAYER_TIME_SCALES` means, in ticks per second. */
export function ticksPerSecondOf(scale: (typeof PLAYER_TIME_SCALES)[number]): number {
  return scale * PLAYER_TICK_HZ;
}

/** `1x`, `2x`, `4x`, or `paused (<top hold>)`: what the pace indicator shows. */
export function paceLabel(pacing: Pick<Pacing, 'rate' | 'held'>): string {
  const held = pacing.held();
  const top = held[held.length - 1];
  if (top !== undefined) return `paused (${top})`;
  return `${pacing.rate()}x`;
}

export function createPacing(loop: Pick<GameLoop, 'setTimeScale'>, onPaused?: (paused: boolean) => void): Pacing {
  let rate = PLAYER_TICK_HZ;
  const holds: string[] = [];
  const apply = (): void => {
    loop.setTimeScale(holds.length > 0 ? 0 : rate / TICK_HZ);
    onPaused?.(holds.length > 0);
  };
  apply();
  return {
    rate: () => (holds.length > 0 ? 0 : rate),
    setRate(ticksPerSecond) {
      if (!Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0) throw new RangeError('A rate is a positive number of ticks per second.');
      rate = ticksPerSecond;
      apply();
    },
    hold(reason) {
      holds.push(reason);
      apply();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const index = holds.lastIndexOf(reason);
        if (index >= 0) holds.splice(index, 1);
        apply();
      };
    },
    held: () => holds.slice(),
  };
}

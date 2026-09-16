/**
 * A complete `Analysis` with every field at the value a clean run would give,
 * so a suite can name the one thing it is changing and read the objective back.
 */
import { objectivesFrom, type Analysis } from '@legs/the_narrows/evaluate';
import { FORD_WIDTH, GUARDED_REGION } from '@legs/the_narrows/ledger';
import { WIDE_FORD_3 } from '@legs/the_narrows/crossings';
import { makeRunState } from '../harness/makeRunState';
import type { RunState } from '@game/types';

export const CLEAN: Analysis = {
  races: [],
  nearDeficit: 1,
  farDeficit: 1,
  unguardedAfterFix: 0,
  spunTicks: 0,
  marks: [{ start: GUARDED_REGION.first, end: GUARDED_REGION.last }],
  replays: 1,
  casInstalledAt: 20,
  readStone: true,
  interruptsDisabled: false,
  inheritanceToggled: true,
  crossingOptions: [{ id: 'crossing.plank', option: 'spin' }, { id: WIDE_FORD_3, option: 'block' }],
  capacity: FORD_WIDTH,
  wideFordCrossed: WIDE_FORD_3,
  admittedPastWidth: false,
  blockedWithRoom: false,
  sableWait: 48,
  sableAfflicted: false,
  boundedWaitingHeld: true,
  nearValue: 3,
  nearExpected: 4,
  farValue: 2,
  farExpected: 3,
  guardHolds: [5, 5],
};

export function analysisWith(patch: Partial<Analysis>): Analysis {
  return { ...CLEAN, ...patch };
}

export function runWith(patch: Partial<RunState> = {}): RunState {
  return { ...makeRunState({ seed: 0x4b54524c, legIndex: 4 }), ...patch };
}

export function objectivesAfter(patch: Partial<Analysis>, run: RunState = runWith()): readonly string[] {
  return objectivesFrom(analysisWith(patch), run);
}

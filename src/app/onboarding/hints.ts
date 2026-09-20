/**
 * WP-24 section 2: the timed hint lines. `OnboardingBeat` carries
 * `hintAfterMs` and no text, so each hinted beat's line is its own
 * `playerMust` rearranged into the leg's voice (pre-flight ruling 9.6):
 * short declaratives, real nouns, no tooltip. Shown through the HUD alert
 * stack as one line after the beat's `hintAfterMs` of unheld wall time.
 */
import { ONBOARDING } from '@legs/boot_sector/onboarding';

export const HINTS: Readonly<Record<string, string>> = {
  /** playerMust: "nothing; camera orbit is added" */
  'beat.floor': 'Drag to orbit.',
  /** playerMust: "reach for them" */
  'beat.reach': 'Reach for them.',
};

/** Every beat with a hint time has a line, and no line names a beat without one. */
export function hintProblems(): readonly string[] {
  const problems: string[] = [];
  for (const beat of ONBOARDING) {
    if (beat.hintAfterMs !== null && HINTS[beat.id] === undefined) problems.push(`${beat.id} hints after ${beat.hintAfterMs} ms and has no line`);
  }
  for (const id of Object.keys(HINTS)) if (!ONBOARDING.some(beat => beat.id === id && beat.hintAfterMs !== null)) problems.push(`${id} has a line and no hint time`);
  return problems;
}

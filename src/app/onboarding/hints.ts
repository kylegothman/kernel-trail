/**
 * WP-24 section 2: the hint lines. Every beat carries its own `hint` in
 * src/legs/boot_sector/onboarding.ts (the ruling before the replay: one
 * sentence naming the input), which the driver shows on a card while the
 * beat is active and, for a beat with `hintAfterMs`, again as one HUD line
 * after that much unheld wall time without the expected action.
 */
import { ONBOARDING, type OnboardingBeat } from '@legs/boot_sector/onboarding';

export const hintFor = (beat: OnboardingBeat): string => beat.hint;

/** Every beat has a non-empty hint; the data file, not the package, is where a missing one is a defect. */
export function hintProblems(): readonly string[] {
  return ONBOARDING.filter(beat => beat.hint.trim() === '').map(beat => `${beat.id} has no hint`);
}

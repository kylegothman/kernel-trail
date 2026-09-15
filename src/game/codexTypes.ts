/**
 * KERNEL TRAIL - the codex shapes. Narrative bible section 14.2, placed here
 * by WP-17 scope correction S8 because `src/game/types.ts` is frozen. Not
 * frozen by this package; a contract amendment freezes it once the first leg
 * package authors entries against it.
 */

import type { TerminationReason, Tick } from '@kernel/types';
import type { AfflictionId, AfflictionRemedy, ChapterRef, LegId } from '@game/types';

export interface CodexEntry {
  readonly id: string;
  readonly title: string;
  readonly chapter: ChapterRef;
  /** Two to four sentences. The mechanism, in the tone guide's register. */
  readonly concept: string;
  readonly unlock: CodexUnlock;
  /** Built from the player's own run. Null until the entry unlocks. */
  readonly workedExample: CodexWorkedExample | null;
  readonly counterfactual: CodexCounterfactual | null;
  readonly remedy: AfflictionRemedy | null;
  readonly remedyVisibility: 'immediate' | 'on_unlock' | 'after_first_success' | 'never';
  readonly related: readonly string[];
  readonly commands: readonly string[];
  readonly epitaphs: readonly string[];
}

export type CodexUnlock =
  | { readonly kind: 'affliction'; readonly id: AfflictionId }
  | { readonly kind: 'termination'; readonly reason: TerminationReason }
  | { readonly kind: 'event'; readonly type: string }
  | { readonly kind: 'objective'; readonly id: string }
  | { readonly kind: 'crossing'; readonly option: 'spin' | 'block' | 'monitor' | 'wait' }
  | { readonly kind: 'leg_complete'; readonly leg: LegId };

export interface CodexWorkedExample {
  readonly capturedAtTick: Tick;
  readonly legId: LegId;
  readonly summary: string;
  /** Rendered from the kernel event log, oldest first, at most 12 lines. */
  readonly trace: readonly string[];
  readonly metrics: Readonly<Record<string, number>>;
}

export interface CodexCounterfactual {
  readonly alternative: string;
  readonly decisionIndex: number;
  readonly replaySeed: number;
  readonly projected: Readonly<Record<string, number>>;
  readonly narrative: string;
}

export interface CodexProfileState {
  readonly seen: readonly string[];
  readonly demonstrated: readonly string[];
  readonly firstSeen: Readonly<Record<string, { runId: string; legId: LegId }>>;
}

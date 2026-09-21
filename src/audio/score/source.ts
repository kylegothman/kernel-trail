/**
 * The score source, WP-25 section 6: the seam the fallback drops into.
 *
 * The generated source below is the only implementation this package
 * ships. The contract exists so that authored music can replace it without
 * touching the Conductor, the Sequencer or the session: a `FileScoreSource`
 * would return an `Arrangement` whose sections are decoded buffers rather
 * than patterns, and the Sequencer's buffer arm (which today answers
 * `not implemented`) would play them on bar lines. The package adds no file
 * loader; the event map in section 4 is the brief such a score would be
 * composed against.
 */
import type { LegId } from '@game/types';
import type { Arrangement } from './Arrangement';
import { arrangementFor } from './material';

export interface ScoreSource {
  /** The music for a leg, deterministic in the seed. Throws on an id that is not a leg. */
  arrangement(legId: LegId, seed: number): Arrangement;
}

/** Section 3's material, seeded per leg from the audio stream and never from a kernel stream. */
export class GeneratedScoreSource implements ScoreSource {
  arrangement(legId: LegId, seed: number): Arrangement {
    return arrangementFor(legId, seed);
  }
}

export const GENERATED_SCORE_SOURCE: ScoreSource = new GeneratedScoreSource();

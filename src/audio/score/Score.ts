/**
 * The score: a thin facade the engine constructs over the Sequencer
 * (section 2) and the Conductor (section 4), so the engine's callers keep
 * one object. WP-16's five layers and their load model are gone; what plays
 * is a leg's arrangement (section 3) from the score source (section 6),
 * moved between sections by the Conductor on bar lines, and reacting to
 * nothing but events.
 */
import type { LegEvent } from '@game/LegRunner';
import type { LegId } from '@game/types';
import type { GainLike } from '../context';
import type { Sidechain } from '../synth/sidechain';
import type { Arrangement, Mode, SectionId } from './Arrangement';
import { Conductor, type DirectorEvent } from './Conductor';
import { Sequencer, type SequencerHost } from './Sequencer';
import type { ScoreSource } from './source';

export interface ScoreHost extends SequencerHost {
  readonly sidechain: Sidechain;
  readonly source: ScoreSource;
  readonly seed: number;
  readonly now: number;
  setKey(rootMidi: number, mode: Mode): void;
}

export class Score {
  readonly sequencer: Sequencer;
  readonly conductor: Conductor;

  constructor(host: ScoreHost) {
    this.sequencer = new Sequencer(host);
    this.conductor = new Conductor({
      sequencer: this.sequencer,
      sidechain: host.sidechain,
      source: host.source,
      seed: host.seed,
      get now() { return host.now; },
      setKey: (rootMidi, mode) => host.setKey(rootMidi, mode),
    });
  }

  /** Every score voice reaches the bus through this gain; the engine routes the score bus to it. */
  get trim(): GainLike {
    return this.sequencer.trim;
  }

  get current(): SectionId | null {
    return this.sequencer.current;
  }

  get legId(): LegId | null {
    return this.conductor.legId;
  }

  get arrangement(): Arrangement | null {
    return this.conductor.currentArrangement;
  }

  onLegEvent(event: LegEvent): void {
    this.conductor.onLegEvent(event);
  }

  onDirectorEvent(event: DirectorEvent): void {
    this.conductor.onDirectorEvent(event);
  }

  /** The real-time pump, from the session's interval and from every frame. */
  pump(now: number): void {
    this.conductor.pump(now);
    this.sequencer.pump(now);
  }

  /** The offline pump: everything up to `horizon` at once. */
  scheduleUntil(horizon: number, now: number): void {
    this.conductor.pump(now);
    this.sequencer.scheduleUntil(horizon, now);
  }

  /** Begin a leg at any section: the audition tool and the browser probe. */
  audition(legId: LegId, section: SectionId, at: number): boolean {
    return this.conductor.audition(legId, section, at);
  }

  /** The next sixteenth on the grid, where a cue that wants the beat lands. */
  nextStepTime(now: number): number {
    return this.sequencer.nextStepTime(now);
  }

  stop(at: number): void {
    this.sequencer.stop(at);
  }

  dispose(): void {
    this.sequencer.dispose();
  }
}

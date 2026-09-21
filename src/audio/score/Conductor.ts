/**
 * The conductor, WP-25 section 4: events to sections, on the bar.
 *
 * Its inputs are the `LegEvent` union and three director verbs, forwarded by
 * the session through the engine's two hooks. The table:
 *
 *   leg entered                     entry, then travel after eight bars
 *   crossing_open                   crossing
 *   crossing resolved, clean        resolve_good, then travel
 *   crossing resolved, failed or
 *     with a casualty               resolve_bad, then travel
 *   tombstone                       the duck at the event, loss on the bar, then travel
 *   depot_open, reclamation_open,
 *     leg_unavailable               no change; the depot has no section
 *   panic                           panic, cut mid-bar, terminal
 *   debrief                         debrief, looping while the card is open
 *   leg exit                        fade over one bar, then the next leg's entry
 *
 * Nothing else changes the music. No kernel metric reaches the score: the
 * load model is gone, and `process.starving`, `memory.thrashing` and the rest
 * stay event sounds. Requests are quantised by the sequencer's bar hook,
 * which asks this class at every bar line what plays next; panic is the one
 * request that cuts a bar.
 *
 * Requests queue in order. A section that loops (entry, travel, crossing,
 * debrief) yields to a queued section at the next bar line; a one-shot
 * phrase (resolve_good, resolve_bad, loss) finishes its bars first. A
 * resolution goes to the front of the queue, so a crossing with a casualty
 * plays resolve_bad, then loss, then travel; a debrief clears the queue.
 */
import type { LegEvent } from '@game/LegRunner';
import type { LegId } from '@game/types';
import type { Sidechain } from '../synth/sidechain';
import { barSeconds, type Arrangement, type Mode, type SectionId } from './Arrangement';
import type { BarInfo, Sequencer } from './Sequencer';
import type { ScoreSource } from './source';

export type DirectorEvent =
  | { readonly kind: 'leg_entered'; readonly legId: LegId; readonly index: number }
  | { readonly kind: 'crossing_resolved'; readonly succeeded: boolean; readonly casualties: number }
  | { readonly kind: 'leg_exit' };

/** Section 4: what follows a section that has played its bars. */
export const FOLLOW_ON: Readonly<Record<SectionId, SectionId | 'loop' | 'end'>> = {
  entry: 'travel',
  travel: 'loop',
  crossing: 'loop',
  resolve_good: 'travel',
  resolve_bad: 'travel',
  loss: 'travel',
  panic: 'end',
  debrief: 'loop',
};

/** Sections that yield to a queued change at any bar line. The rest finish their bars first. */
export const YIELDING: readonly SectionId[] = ['entry', 'travel', 'crossing', 'debrief'];

/** A live start lands this far ahead of `now`, so the first onset is never already in the past. */
export const START_LEAD_SECONDS = 0.02;

export interface ConductorHost {
  readonly sequencer: Sequencer;
  readonly sidechain: Sidechain;
  readonly source: ScoreSource;
  readonly seed: number;
  readonly now: number;
  /** The leg's key, for the palette's pitched cues. */
  setKey(rootMidi: number, mode: Mode): void;
}

export interface ConductorStats {
  events: number;
  /** Section changes, including the first of a leg and a panic cut. */
  changes: number;
  /** Events the table maps to no change. */
  ignored: number;
  /** A source that threw, or a section the sequencer refused. */
  errors: number;
}

export interface TimelineEntry {
  readonly section: SectionId;
  readonly time: number;
}

export class Conductor {
  readonly stats: ConductorStats = { events: 0, changes: 0, ignored: 0, errors: 0 };
  /** Every section that began and when, for the tests and the evidence. */
  readonly timeline: TimelineEntry[] = [];
  private arrangement: Arrangement | null = null;
  private leg: LegId | null = null;
  private readonly queue: SectionId[] = [];
  private fadeEndsAt = -1;
  private pendingLeg: LegId | null = null;
  private panicked = false;

  constructor(private readonly host: ConductorHost) {
    host.sequencer.onBar = (info) => this.onBar(info);
  }

  get legId(): LegId | null {
    return this.leg;
  }

  get current(): SectionId | null {
    return this.host.sequencer.current;
  }

  get currentArrangement(): Arrangement | null {
    return this.arrangement;
  }

  get pending(): readonly SectionId[] {
    return this.queue;
  }

  get isPanicked(): boolean {
    return this.panicked;
  }

  /** The leg events. Only `kind` is read; the payloads belong to the cards and panels. */
  onLegEvent(event: LegEvent): void {
    this.stats.events += 1;
    if (this.panicked) {
      this.stats.ignored += 1;
      return;
    }
    switch (event.kind) {
      case 'crossing_open':
        this.enqueue('crossing');
        return;
      case 'tombstone':
        this.derezz(this.host.now);
        return;
      case 'panic':
        this.panic(this.host.now);
        return;
      case 'debrief':
        this.queue.length = 0;
        this.enqueue('debrief');
        return;
      case 'depot_open':
      case 'reclamation_open':
      case 'leg_unavailable':
        // Section 4: the depot has no section, and neither has the verge or a leg that failed to load.
        this.stats.ignored += 1;
        return;
      default:
        return assertNever(event);
    }
  }

  onDirectorEvent(event: DirectorEvent): void {
    this.stats.events += 1;
    switch (event.kind) {
      case 'leg_entered':
        this.panicked = false;
        if (this.host.sequencer.isFading && this.host.now < this.fadeEndsAt) {
          // The previous leg is still fading; its entry begins when the fade ends (see `pump`).
          this.pendingLeg = event.legId;
        } else {
          this.pendingLeg = null;
          this.enterLeg(event.legId, 'entry', this.host.now + START_LEAD_SECONDS);
        }
        return;
      case 'crossing_resolved':
        if (this.panicked) { this.stats.ignored += 1; return; }
        this.enqueue(event.succeeded && event.casualties === 0 ? 'resolve_good' : 'resolve_bad');
        return;
      case 'leg_exit':
        if (this.panicked) { this.stats.ignored += 1; return; }
        this.exit(this.host.now);
        return;
      default:
        return assertNever(event);
    }
  }

  /**
   * Begin a leg at any section, at `at`. The hooks use `entry`; the audition
   * tool and the browser probe use what they are asked for. False when the
   * source has no music for the leg or the sequencer refused the section.
   */
  audition(legId: LegId, section: SectionId, at: number): boolean {
    this.pendingLeg = null;
    this.panicked = false;
    const started = this.enterLeg(legId, section, at);
    if (started && section === 'panic') this.panicked = true;
    return started;
  }

  /** Called before every pump: a leg waiting on a fade begins once the fade is over. */
  pump(now: number): void {
    if (this.pendingLeg === null || now < this.fadeEndsAt) return;
    const legId = this.pendingLeg;
    this.pendingLeg = null;
    this.enterLeg(legId, 'entry', now + START_LEAD_SECONDS);
  }

  /* ---- internals --------------------------------------------------- */

  private enterLeg(legId: LegId, section: SectionId, at: number): boolean {
    let arrangement: Arrangement;
    try {
      arrangement = this.host.source.arrangement(legId, this.host.seed);
    } catch {
      this.stats.errors += 1;
      return false;
    }
    this.queue.length = 0;
    this.host.sidechain.restore(at);
    const result = this.host.sequencer.start(arrangement, section, at);
    if (result !== 'ok') {
      this.stats.errors += 1;
      return false;
    }
    this.arrangement = arrangement;
    this.leg = legId;
    this.fadeEndsAt = -1;
    this.host.setKey(arrangement.rootMidi, arrangement.mode);
    this.began(section, at);
    return true;
  }

  private onBar(info: BarInfo): SectionId | 'end' | null {
    if (this.panicked) return info.section === 'panic' && info.barInSection >= info.bars ? 'end' : null;
    const ended = info.barInSection >= info.bars;
    if (this.queue.length > 0 && (ended || YIELDING.includes(info.section))) {
      const next = this.queue.shift();
      if (next === undefined) return null;
      if (next === info.section) return null;
      this.began(next, info.time);
      return next;
    }
    if (!ended) return null;
    const follow = FOLLOW_ON[info.section];
    if (follow === 'loop') return null;
    if (follow === 'end') return 'end';
    this.began(follow, info.time);
    return follow;
  }

  /** A section begins at `time`: count it, record it, and lift any derezz duck for it. */
  private began(section: SectionId, time: number): void {
    this.stats.changes += 1;
    this.timeline.push({ section, time });
    this.host.sidechain.restore(time);
  }

  private enqueue(section: SectionId): void {
    if (this.arrangement === null) {
      this.stats.ignored += 1;
      return;
    }
    if (section === 'resolve_good' || section === 'resolve_bad') {
      // The crossing's outcome is heard before the elegy for anyone it cost.
      const kept = this.queue.filter((s) => s !== 'resolve_good' && s !== 'resolve_bad');
      this.queue.length = 0;
      this.queue.push(section, ...kept);
      return;
    }
    if (!this.queue.includes(section)) this.queue.push(section);
  }

  /** Visual bible 9.4: the audio drops to the low bed at the event; the loss follows on the bar. */
  private derezz(now: number): void {
    if (this.arrangement === null) {
      this.stats.ignored += 1;
      return;
    }
    this.host.sidechain.duck(now);
    this.host.sequencer.mute(['kick', 'arp']);
    this.enqueue('loss');
  }

  /** The one change allowed to cut a bar. Terminal until the next leg enters. */
  private panic(now: number): void {
    if (this.arrangement === null) {
      this.stats.ignored += 1;
      return;
    }
    this.queue.length = 0;
    this.pendingLeg = null;
    this.panicked = true;
    const result = this.host.sequencer.cut(now);
    if (result !== 'ok') {
      this.stats.errors += 1;
      return;
    }
    this.began('panic', now);
  }

  /** Continue on the debrief, or any leg exit: fade over one bar; the next entry waits for the fade. */
  private exit(now: number): void {
    const a = this.arrangement;
    if (a === null || !this.host.sequencer.playing) {
      this.stats.ignored += 1;
      return;
    }
    this.queue.length = 0;
    const bar = barSeconds(a);
    this.host.sequencer.fadeOut(now, bar);
    this.fadeEndsAt = now + bar;
    this.leg = null;
  }
}

function assertNever(x: never): never {
  throw new Error(`conductor: unhandled event ${JSON.stringify(x)}`);
}

/**
 * The beat clock and the pattern player, WP-25 section 2.
 *
 * The clock is the audio context's `currentTime`, scheduled ahead by a
 * lookahead of 120 ms from a 25 ms pump, the standard Web Audio pattern. It
 * is not the game tick: the player's rate is 1, 2 or 4 ticks a second and
 * none of those is a tempo, and when the loop is held the music continues,
 * because the crossing section is the music for a held crossing.
 *
 * The sequencer walks sixteenth steps. At the first step of every bar it
 * asks its `onBar` hook which section plays from here; the Conductor answers
 * from its table, so a requested change lands on a bar line and never inside
 * one. `cut` is the one exception, for panic. Every note goes through the
 * `VoiceAllocator`, acquired exempt on the score bus with `layer` set, so
 * the tier budgets hold, the world's holds and stops leave the music alone,
 * and a world burst can never steal the pad.
 *
 * Timers are the host's business: the boundary test forbids them under
 * src/audio, so the engine is handed an interval by the session and calls
 * `pump`, and the offline tool calls `scheduleUntil` once with the whole
 * render as its horizon.
 */
import type { AudioContextLike, GainLike, NodeLike } from '../context';
import { MIN_EXP_TARGET } from '../synth/constants';
import type { Adsr } from '../synth/envelope';
import type { VoiceAllocator } from '../VoiceBudget';
import type { Voice, VoiceKind, VoiceParams } from '../voices/Voice';
import { DroneVoice } from '../voices/DroneVoice';
import {
  PART_IDS, STEPS_PER_BAR, barSeconds, sectionSeconds, stepOffsetSeconds, stepSeconds,
  type Arrangement, type Note, type PartId, type Section, type SectionId,
} from './Arrangement';

/** Section 2: scheduled ahead by 120 ms, pumped every 25 ms. */
export const LOOKAHEAD_SECONDS = 0.12;
export const SCHEDULE_INTERVAL_MS = 25;
/** A step this far behind `now` is skipped rather than fired late; a late burst of sixteenths is worse than a gap. */
export const LATE_STEP_TOLERANCE_SECONDS = 0.03;
/**
 * A release ends this long before the next onset on its grid, never exactly
 * on it: a ramp that ends at the very time the next note cancels from is
 * dropped by the platform, which clicks, and a voice whose release ends a
 * floating-point hair after the onset is still busy when the note asks for
 * it, which drops the note.
 */
export const RELEASE_GAP_SECONDS = 0.001;

export type MutableVoiceParams = { -readonly [K in keyof VoiceParams]?: VoiceParams[K] };

export interface PatchContext {
  readonly arrangement: Arrangement;
  readonly section: Section;
  readonly part: PartId;
  /** The note's nominal length in seconds. */
  readonly seconds: number;
}

/** How a part is played: the voice kind it takes from the pool and what a note becomes. */
export interface PartVoicing {
  readonly kind: VoiceKind;
  /** The envelope the patch sets, so the hold can be fitted inside the note before the patch runs. */
  readonly adsr: Adsr;
  /** Fill `out` for the note. `layer` and `hold` are the sequencer's; everything else is the patch's. */
  patch(note: Note, context: PatchContext, out: MutableVoiceParams): void;
}

export type Voicing = Readonly<Record<PartId, PartVoicing>>;

export interface SequencerHost {
  readonly ctx: AudioContextLike;
  readonly allocator: VoiceAllocator;
  readonly voicing: Voicing;
  /** 1 normally, halved under reduced motion. */
  readonly envelopeScale: number;
  /** The score bus input the trim feeds. */
  readonly scoreBus: NodeLike;
}

export interface BarInfo {
  readonly section: SectionId;
  /** The bar about to play. Equal to `bars` when the section has just ended and the hook decides what follows. */
  readonly barInSection: number;
  readonly bars: number;
  readonly loopStart: number;
  /** The bar line's audio time. */
  readonly time: number;
}

/** Answer null to continue (a finished section loops), a section id to play it from this bar, or `end`. */
export type BarHook = (info: BarInfo) => SectionId | 'end' | null;

/** Section 6: the buffer arm of `SectionBody` is refused by name. */
export type StartResult = 'ok' | 'not implemented';

export interface SequencerStats {
  notes: number;
  /** Notes the allocator could not place. */
  unplaced: number;
  bars: number;
  changes: number;
  cuts: number;
  /** Steps that fell behind the clock and were skipped. */
  lateSteps: number;
  /** Section changes refused because the section is a buffer. */
  refused: number;
}

export class Sequencer {
  /** The score trim: every score voice reaches the bus through it, so a fade or a panic decay is one ramp. */
  readonly trim: GainLike;
  onBar: BarHook | null = null;
  readonly stats: SequencerStats = { notes: 0, unplaced: 0, bars: 0, changes: 0, cuts: 0, lateSteps: 0, refused: 0 };
  private arrangement: Arrangement | null = null;
  private section: Section | null = null;
  private readonly byStep = new Map<number, { readonly part: PartId; readonly note: Note }[]>();
  /** Audio time of bar zero of the current pass. A loop from `loopStart` moves it back so bar times stay on the grid. */
  private anchor = 0;
  private barIndex = 0;
  private stepInBar = 0;
  private stopAt = Number.POSITIVE_INFINITY;
  private readonly muted = new Set<PartId>();
  private readonly padLevels = new Map<Voice, number>();
  /** Panic keeps the pad it cut into; the section's own pad notes are then not scheduled. */
  private skipPad = false;
  /** `start` chose its section; the hook is asked from the next bar line on, as after any switch. */
  private skipFirstHook = false;
  private disposed = false;

  constructor(private readonly host: SequencerHost) {
    this.trim = host.ctx.createGain();
    this.trim.gain.value = 1;
    this.trim.connect(host.scoreBus);
  }

  get playing(): boolean {
    return this.section !== null;
  }

  get current(): SectionId | null {
    return this.section?.id ?? null;
  }

  get currentArrangement(): Arrangement | null {
    return this.arrangement;
  }

  /** The bar being scheduled within the current section. */
  get barInSection(): number {
    return this.barIndex;
  }

  /** The nominal onset of the next unscheduled step. */
  get frontier(): number {
    const a = this.arrangement;
    if (a === null || this.section === null) return 0;
    return this.anchor + (this.barIndex * STEPS_PER_BAR + this.stepInBar) * stepSeconds(a);
  }

  get isFading(): boolean {
    return this.stopAt !== Number.POSITIVE_INFINITY;
  }

  /**
   * Begin `section` of `arrangement` with its first bar at `at`. Every score
   * voice still sounding is released at `at`, except the pad when `keepPad`
   * is set, which is how panic keeps the chord it cut into.
   */
  start(arrangement: Arrangement, id: SectionId, at: number, options: { readonly keepPad?: boolean } = {}): StartResult {
    if (this.disposed) return 'ok';
    const section = arrangement.sections[id];
    if (section.body.kind === 'buffer') {
      this.stats.refused += 1;
      return 'not implemented';
    }
    const keepPad = options.keepPad === true;
    this.release(at, keepPad);
    this.arrangement = arrangement;
    this.stopAt = Number.POSITIVE_INFINITY;
    this.trim.gain.cancelScheduledValues(at);
    this.enter(section, at, keepPad);
    this.skipFirstHook = true;
    return 'ok';
  }

  /** Panic: cut the bar at `at`. Everything but the pad stops; the pad is kept and the panic section begins now. */
  cut(at: number): StartResult {
    const a = this.arrangement;
    if (a === null) return 'ok';
    this.stats.cuts += 1;
    return this.start(a, 'panic', at, { keepPad: true });
  }

  /** Stop scheduling `parts` until the next section change. The derezz duck uses it for the kick and the arp. */
  mute(parts: readonly PartId[]): void {
    for (const part of parts) this.muted.add(part);
  }

  /** Ramp the trim to silence over `seconds` from `at`, then stop. A leg exit fades over one bar. */
  fadeOut(at: number, seconds: number): void {
    if (this.section === null) return;
    const end = at + Math.max(0.01, seconds);
    this.trim.gain.cancelScheduledValues(at);
    this.trim.gain.setValueAtTime(1, at);
    this.trim.gain.linearRampToValueAtTime(0, end);
    this.stopAt = end;
  }

  /** Release every score voice at `at` and forget the section. The trim is left where it is. */
  stop(at: number): void {
    this.release(at, false);
    this.section = null;
    this.byStep.clear();
    this.muted.clear();
    this.padLevels.clear();
    this.skipPad = false;
    this.skipFirstHook = false;
    this.stopAt = Number.POSITIVE_INFINITY;
  }

  /** The real-time pump: schedule up to the lookahead. */
  pump(now: number): void {
    this.scheduleUntil(now + LOOKAHEAD_SECONDS, now);
  }

  /**
   * Schedule every step whose onset is before `horizon`. `now` is where the
   * clock is; a step that has already fallen behind it is skipped and
   * counted rather than fired late. Idempotent: nothing is scheduled twice.
   */
  scheduleUntil(horizon: number, now = horizon - LOOKAHEAD_SECONDS): void {
    while (this.section !== null && this.arrangement !== null) {
      const a = this.arrangement;
      const barStart = this.anchor + this.barIndex * barSeconds(a);
      const nominal = barStart + this.stepInBar * stepSeconds(a);
      if (nominal >= horizon) return;
      if (nominal >= this.stopAt) {
        this.stop(this.stopAt);
        return;
      }
      if (this.stepInBar === 0 && !this.beginBar(nominal)) return;
      const section = this.section;
      const onset = this.anchor + this.barIndex * barSeconds(a) + stepOffsetSeconds(a, this.stepInBar);
      if (nominal + LATE_STEP_TOLERANCE_SECONDS < now) {
        this.stats.lateSteps += 1;
      } else {
        const entries = this.byStep.get(this.barIndex * STEPS_PER_BAR + this.stepInBar);
        if (entries !== undefined) {
          for (const entry of entries) {
            if (this.muted.has(entry.part)) continue;
            if (this.skipPad && entry.part === 'pad') continue;
            this.play(entry.part, entry.note, onset, section);
          }
        }
      }
      this.stepInBar += 1;
      if (this.stepInBar === STEPS_PER_BAR) {
        this.stepInBar = 0;
        this.barIndex += 1;
      }
    }
  }

  /** The first sixteenth on the grid at or after `now`, or `now` when nothing plays. Cues that want the grid land here. */
  nextStepTime(now: number): number {
    const a = this.arrangement;
    if (a === null || this.section === null) return now;
    const step = stepSeconds(a);
    const k = Math.max(0, Math.ceil((now - this.anchor) / step - 1e-9));
    return this.anchor + k * step;
  }

  /** The first bar line at or after `now`, or `now` when nothing plays. */
  nextBarTime(now: number): number {
    const a = this.arrangement;
    if (a === null || this.section === null) return now;
    const bar = barSeconds(a);
    const k = Math.max(0, Math.ceil((now - this.anchor) / bar - 1e-9));
    return this.anchor + k * bar;
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop(this.host.ctx.currentTime);
    this.arrangement = null;
    this.trim.disconnect();
    this.disposed = true;
  }

  /* ---- internals --------------------------------------------------- */

  /**
   * Called at the first step of a bar with the bar line's time. The hook is
   * asked once per bar line from the second bar of a section on, and at its
   * end; the line that chose a section is never asked again for its bar
   * zero. False when the hook ended the music.
   */
  private beginBar(time: number): boolean {
    const a = this.arrangement;
    const section = this.section;
    if (a === null || section === null) return false;
    if (this.skipFirstHook) {
      this.skipFirstHook = false;
      this.stats.bars += 1;
      return true;
    }
    const ended = this.barIndex >= section.bars;
    const info: BarInfo = { section: section.id, barInSection: this.barIndex, bars: section.bars, loopStart: section.loopStart, time };
    const decision = this.onBar === null ? null : this.onBar(info);
    if (decision === 'end') {
      this.stop(time);
      return false;
    }
    if (decision !== null && decision !== section.id) {
      const next = a.sections[decision];
      if (next.body.kind === 'buffer') {
        this.stats.refused += 1;
        if (ended) this.loop(time);
      } else {
        this.stats.changes += 1;
        this.enter(next, time, false);
      }
    } else if (ended) {
      this.loop(time);
    }
    this.stats.bars += 1;
    return true;
  }

  private loop(time: number): void {
    const a = this.arrangement;
    const section = this.section;
    if (a === null || section === null) return;
    this.barIndex = section.loopStart;
    this.anchor = time - section.loopStart * barSeconds(a);
  }

  private enter(section: Section, time: number, keepPad: boolean): void {
    const a = this.arrangement;
    if (a === null) return;
    this.section = section;
    this.anchor = time;
    this.barIndex = 0;
    this.stepInBar = 0;
    this.muted.clear();
    this.index(section);
    this.skipPad = false;
    if (!this.isFading) {
      this.trim.gain.setValueAtTime(section.level.from, time);
      if (section.level.to !== section.level.from) this.trim.gain.linearRampToValueAtTime(section.level.to, time + sectionSeconds(a, section.id));
    }
    if (keepPad) this.keepPad(time, section);
  }

  private index(section: Section): void {
    this.byStep.clear();
    if (section.body.kind !== 'patterns') return;
    for (const part of PART_IDS) {
      for (const note of section.body.parts[part]) {
        let list = this.byStep.get(note.step);
        if (list === undefined) {
          list = [];
          this.byStep.set(note.step, list);
        }
        list.push({ part, note });
      }
    }
  }

  /** The pad cut into holds its chord to the end of the section, drifting by the section's detune. */
  private keepPad(time: number, section: Section): void {
    const a = this.arrangement;
    if (a === null) return;
    const seconds = sectionSeconds(a, section.id);
    let kept = 0;
    for (const voice of this.host.allocator.all()) {
      if (!(voice instanceof DroneVoice) || !voice.busy || voice.bus !== 'score' || voice.startedAt > time) continue;
      const level = this.padLevels.get(voice) ?? 0.3;
      voice.level.cancelScheduledValues(time);
      voice.level.setValueAtTime(level, time);
      voice.finishAt = time + seconds;
      if (section.padDetuneCents !== 0) voice.setDetune(section.padDetuneCents, time, seconds);
      kept += 1;
    }
    this.skipPad = kept > 0;
  }

  private play(part: PartId, note: Note, onset: number, section: Section): void {
    const a = this.arrangement;
    if (a === null) return;
    const voicing = this.host.voicing[part];
    const seconds = note.length * stepSeconds(a);
    const voice = this.host.allocator.acquire(voicing.kind, 'score', onset, true);
    if (voice === null) {
      this.stats.unplaced += 1;
      return;
    }
    const params: MutableVoiceParams = { layer: true, pan: 0 };
    voicing.patch(note, { arrangement: a, section, part, seconds }, params);
    const adsr = params.adsr ?? voicing.adsr;
    params.adsr = adsr;
    const scale = this.host.envelopeScale;
    if (voice instanceof DroneVoice) {
      // The pad: the drone applies no envelope of its own, so the sequencer drives its level.
      voice.start(onset, params);
      const gain = params.gain ?? 0.3;
      const end = onset + seconds - RELEASE_GAP_SECONDS;
      const attack = Math.min(Math.max(0.005, adsr.attack * scale), seconds / 2);
      const release = Math.min(Math.max(0.005, adsr.release * scale), seconds / 2);
      const level = voice.level;
      level.cancelScheduledValues(onset);
      level.setValueAtTime(MIN_EXP_TARGET, onset);
      level.linearRampToValueAtTime(gain, onset + attack);
      level.setValueAtTime(gain, end - release);
      level.linearRampToValueAtTime(MIN_EXP_TARGET, end);
      voice.finishAt = end;
      this.padLevels.set(voice, gain);
      if (section.padDetuneCents !== 0) voice.setDetune(section.padDetuneCents, onset, Math.max(0.01, sectionSeconds(a, section.id) - (onset - this.anchor)));
    } else {
      // A one-shot whose release ends inside the note, so the next note on this voice starts from silence.
      params.hold = Math.max(0, seconds - RELEASE_GAP_SECONDS - (adsr.attack + adsr.decay + adsr.release) * scale);
      voice.start(onset, params);
    }
    this.stats.notes += 1;
  }

  /** Release every score voice at `at`, the pad too unless kept. A note not yet sounding is silenced without a blip. */
  private release(at: number, keepPad: boolean): void {
    for (const voice of this.host.allocator.all()) {
      if (!voice.busy || voice.bus !== 'score') continue;
      if (keepPad && voice instanceof DroneVoice) continue;
      if (voice.startedAt > at) {
        voice.level.cancelScheduledValues(at);
        voice.level.setValueAtTime(MIN_EXP_TARGET, at);
        voice.busy = false;
        voice.exempt = false;
        voice.finishAt = at;
      } else {
        voice.stop(at);
      }
      this.padLevels.delete(voice);
    }
  }
}

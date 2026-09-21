/**
 * A leg's music as data, WP-25 section 1. An arrangement is a key, a tempo,
 * a swing and eight named sections; a section is a whole number of bars with
 * a pattern per part. The arrangement knows only sections and their
 * patterns: what follows a section is the Conductor's table (section 4), and
 * how a note sounds is the voicing the Sequencer is given (section 2).
 *
 * Time is in sixteenth steps from the section's first bar, never in seconds,
 * so the same section plays at any tempo and the sequencer alone owns the
 * clock. Notes carry absolute MIDI numbers already in the leg's key.
 */
import type { BufferLike } from '../context';

export type SectionId = 'entry' | 'travel' | 'crossing' | 'resolve_good' | 'resolve_bad' | 'loss' | 'panic' | 'debrief';
export const SECTION_IDS: readonly SectionId[] = ['entry', 'travel', 'crossing', 'resolve_good', 'resolve_bad', 'loss', 'panic', 'debrief'];

export type PartId = 'kick' | 'bass' | 'chords' | 'arp' | 'lead' | 'pad';
export const PART_IDS: readonly PartId[] = ['kick', 'bass', 'chords', 'arp', 'lead', 'pad'];

/** Section 3: natural minor and dorian for travel, major for the Boot Sector and every debrief resolution. */
export type Mode = 'major' | 'minor' | 'dorian';
export const MODES: readonly Mode[] = ['major', 'minor', 'dorian'];

/** Section 1: a time signature of four. Sixteenths are the grid every part is written on. */
export const BEATS_PER_BAR = 4;
export const STEPS_PER_BEAT = 4;
export const STEPS_PER_BAR = BEATS_PER_BAR * STEPS_PER_BEAT;

/** Section 3: tempo per leg between 110 and 126. */
export const TEMPO_RANGE = { min: 110, max: 126 } as const;

/** Section 2: a light 54 percent on the sixteenths by default. */
export const DEFAULT_SWING = 0.54;
export const SWING_RANGE = { min: 0.5, max: 0.75 } as const;

/**
 * Section 1: the bar count of every section. `travel` is the loop the leg
 * lives in and may be sixteen or thirty-two; `crossing` carries eight bars
 * of introduction before its eight-bar loop (pre-flight ruling: tension by
 * subtraction first, the quiet arp only on the second pass), so its pattern
 * is sixteen bars long and it loops from bar eight.
 */
export const SECTION_BARS: Readonly<Record<SectionId, number>> = {
  entry: 8, travel: 16, crossing: 16, resolve_good: 4, resolve_bad: 4, loss: 4, panic: 4, debrief: 8,
};
export const TRAVEL_BARS: readonly number[] = [16, 32];
export const CROSSING_LOOP_START = 8;

export interface Note {
  /** Onset in sixteenths from the section's first bar. */
  readonly step: number;
  /** Length in sixteenths. The voice's release is fitted inside it, so consecutive notes never click. */
  readonly length: number;
  /** Absolute MIDI number, already transposed into the leg's key. */
  readonly midi: number;
  /** 0 to 1. */
  readonly velocity: number;
  /** 0 to 1: the saw parts' filter position for this note. The pad ignores it. */
  readonly cutoff: number;
}

export type Parts = Readonly<Record<PartId, readonly Note[]>>;

/**
 * Section 6: a section is patterns, or a decoded buffer an authored score
 * would supply. The buffer arm is the seam a `FileScoreSource` drops into;
 * this package ships no such source, and the sequencer answers the arm with
 * `not implemented` by name.
 */
export type SectionBody =
  | { readonly kind: 'patterns'; readonly parts: Parts }
  | { readonly kind: 'buffer'; readonly buffer: BufferLike };

export interface Section {
  readonly id: SectionId;
  readonly bars: number;
  /** The bar a loop resumes from. Zero everywhere except the crossing's second pass. */
  readonly loopStart: number;
  /** True for panic only: the one section allowed to cut a bar. */
  readonly cutsBar: boolean;
  /** The score trim over the section, at its first and last bar. One to one everywhere; one to zero in panic. */
  readonly level: { readonly from: number; readonly to: number };
  /** Cents the pad drifts by the end of the section. Zero everywhere except panic. */
  readonly padDetuneCents: number;
  readonly body: SectionBody;
}

export interface Arrangement {
  /** The bass root: F2 is 41. Every other register is computed from it. */
  readonly rootMidi: number;
  readonly mode: Mode;
  readonly tempo: number;
  /** 0.5 is straight; odd sixteenths are late by twice the excess over 0.5, in sixteenths. */
  readonly swing: number;
  readonly sections: Readonly<Record<SectionId, Section>>;
}

export function emptyParts(): Record<PartId, Note[]> {
  return { kick: [], bass: [], chords: [], arp: [], lead: [], pad: [] };
}

export function beatSeconds(a: Pick<Arrangement, 'tempo'>): number {
  return 60 / a.tempo;
}

export function stepSeconds(a: Pick<Arrangement, 'tempo'>): number {
  return beatSeconds(a) / STEPS_PER_BEAT;
}

export function barSeconds(a: Pick<Arrangement, 'tempo'>): number {
  return beatSeconds(a) * BEATS_PER_BAR;
}

export function sectionSeconds(a: Arrangement, id: SectionId): number {
  return barSeconds(a) * a.sections[id].bars;
}

/**
 * The onset of a step within its bar, swung. The odd sixteenth of every pair
 * is late by `(swing - 0.5) * 2` sixteenths: about ten milliseconds at the
 * default swing and 120 beats a minute, which is felt rather than heard.
 */
export function stepOffsetSeconds(a: Pick<Arrangement, 'tempo' | 'swing'>, stepInBar: number): number {
  const step = stepSeconds(a);
  const late = stepInBar % 2 === 1 ? (a.swing - 0.5) * 2 * step : 0;
  return stepInBar * step + late;
}

/** Cutoff position to hertz: 0 is a closed 300 Hz, 1 is an open 9 kHz, on an exponential scale. */
export function cutoffHz(position: number): number {
  const x = Math.min(1, Math.max(0, Number.isFinite(position) ? position : 0));
  return 300 * Math.pow(30, x);
}

/**
 * Structural validation, for the tests and for a source that generates.
 * Returns every problem found so a test can name them; an empty list is a
 * valid arrangement. The rules are section 1's: every section present with
 * its bar count, notes inside their section, the lead silent everywhere but
 * `loss` and `debrief` (acceptance criterion 5), no kick where the section
 * says none, and only panic cutting a bar.
 */
export function validateArrangement(a: Arrangement): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(a.rootMidi) || a.rootMidi < 24 || a.rootMidi > 60) problems.push(`rootMidi ${a.rootMidi} is outside C1 to C4`);
  if (!MODES.includes(a.mode)) problems.push(`mode ${String(a.mode)} is not one of ${MODES.join(', ')}`);
  if (!(a.tempo >= TEMPO_RANGE.min && a.tempo <= TEMPO_RANGE.max)) problems.push(`tempo ${a.tempo} is outside ${TEMPO_RANGE.min} to ${TEMPO_RANGE.max}`);
  if (!(a.swing >= SWING_RANGE.min && a.swing <= SWING_RANGE.max)) problems.push(`swing ${a.swing} is outside ${SWING_RANGE.min} to ${SWING_RANGE.max}`);
  for (const id of SECTION_IDS) {
    const section = a.sections[id];
    if (section === undefined) { problems.push(`section ${id} is missing`); continue; }
    if (section.id !== id) problems.push(`section ${id} carries id ${section.id}`);
    const expected = id === 'travel' ? TRAVEL_BARS : [SECTION_BARS[id]];
    if (!expected.includes(section.bars)) problems.push(`section ${id} has ${section.bars} bars, expected ${expected.join(' or ')}`);
    if (!Number.isInteger(section.loopStart) || section.loopStart < 0 || section.loopStart >= section.bars) problems.push(`section ${id} loops from bar ${section.loopStart}`);
    if (section.cutsBar !== (id === 'panic')) problems.push(`section ${id} cutsBar is ${section.cutsBar}`);
    if (!inUnit(section.level.from) || !inUnit(section.level.to)) problems.push(`section ${id} level is outside 0 to 1`);
    if (id !== 'panic' && section.padDetuneCents !== 0) problems.push(`section ${id} detunes the pad`);
    if (section.body.kind !== 'patterns') continue;
    const steps = section.bars * STEPS_PER_BAR;
    for (const part of PART_IDS) {
      const notes = section.body.parts[part];
      if (notes === undefined) { problems.push(`section ${id} has no ${part} part`); continue; }
      for (const [i, note] of notes.entries()) {
        const where = `${id}.${part}[${i}]`;
        if (!Number.isInteger(note.step) || note.step < 0 || note.step >= steps) problems.push(`${where} starts at step ${note.step} of ${steps}`);
        if (!Number.isInteger(note.length) || note.length < 1) problems.push(`${where} has length ${note.length}`);
        if (note.step + note.length > steps) problems.push(`${where} runs past the section`);
        if (!Number.isInteger(note.midi) || note.midi < 0 || note.midi > 127) problems.push(`${where} has midi ${note.midi}`);
        if (!inUnit(note.velocity)) problems.push(`${where} has velocity ${note.velocity}`);
        if (!inUnit(note.cutoff)) problems.push(`${where} has cutoff ${note.cutoff}`);
      }
    }
    const parts = section.body.parts;
    if (parts.lead.length > 0 && id !== 'loss' && id !== 'debrief') problems.push(`the lead plays in ${id}`);
    if (parts.kick.length > 0 && (id === 'entry' || id === 'crossing' || id === 'loss' || id === 'panic' || id === 'debrief')) problems.push(`the kick plays in ${id}`);
    if (id === 'loss' && parts.lead.length === 0) problems.push('loss has no lead');
    if (id === 'debrief' && parts.lead.length === 0) problems.push('debrief has no lead');
    if (id === 'travel' && parts.kick.length === 0) problems.push('travel has no kick');
  }
  return problems;
}

function inUnit(v: number): boolean {
  return Number.isFinite(v) && v >= 0 && v <= 1;
}

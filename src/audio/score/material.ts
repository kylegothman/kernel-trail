/**
 * The material, WP-25 section 3: where the music is.
 *
 * Per leg: a key from a circle-of-fifths walk up from the Boot Sector's F,
 * a mode, a tempo between 110 and 126, a progression of eight chords with
 * sevenths and ninths that ends wanting to resolve, a bass that follows the
 * roots an octave down with one passing note a bar, an arpeggio of the
 * chord tones in sixteenths under a filter that opens and closes, a pad of
 * the chords sustained, a kick on every beat of travel, and the convoy
 * motif, written once below and transposed into every key, which plays at
 * every loss and every debrief and nowhere else.
 *
 * The four shipped legs are authored by hand in `AUTHORED`, as chord
 * symbols, so a listener can tell them apart; the generator covers the ten
 * unbuilt legs from a table of progressions until their packages author
 * theirs. Everything seeded here draws from `createRng(seed, 'audio')`
 * forked per leg, never from a kernel stream, and the draw order is fixed.
 *
 * Every phrase, progression and motif in this file is original. No artist,
 * band, track or album is named or drawn on anywhere in it.
 */
import { createRng } from '@kernel/index';
import type { Rng } from '@kernel/types';
import { midiToHz } from '../synth/tuning';
import { CHORD_ADSR } from '../voices/ChordVoice';
import { LEAD_ADSR } from '../voices/LeadVoice';
import type { Adsr } from '../synth/envelope';
import {
  BEATS_PER_BAR, CROSSING_LOOP_START, SECTION_BARS, SECTION_IDS, STEPS_PER_BAR, STEPS_PER_BEAT, TEMPO_RANGE, cutoffHz, emptyParts,
  type Arrangement, type Mode, type Note, type PartId, type Section, type SectionId,
} from './Arrangement';
import type { MutableVoiceParams, PatchContext, Voicing } from './Sequencer';

/* ------------------------------------------------------------------ */
/* The journey                                                         */
/* ------------------------------------------------------------------ */

/**
 * The fourteen legs in journey order. The audio layer may not take a value
 * from the game layer, so the order is stated here and the material test
 * holds it equal to `LEG_ORDER`.
 */
export const JOURNEY: readonly string[] = [
  'boot_sector', 'fork_fields', 'the_weave', 'quantum_pass', 'the_narrows', 'the_cistern', 'the_gridlock',
  'allocation_yards', 'drowned_reach', 'the_platters', 'the_bus', 'the_archive', 'arbiter_wall', 'the_portal',
];

export function legIndex(legId: string): number {
  const index = JOURNEY.indexOf(legId);
  if (index < 0) throw new RangeError(`material: ${legId} is not a leg`);
  return index;
}

/* ------------------------------------------------------------------ */
/* Pitch                                                               */
/* ------------------------------------------------------------------ */

/** Semitones of each scale degree above the root, by mode. */
export const SCALES: Readonly<Record<Mode, readonly number[]>> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
};

/** Semitones of a one-based scale degree above the tonic; 8 is the octave and 0 is a rest. */
export function degreeToSemitones(mode: Mode, degree: number): number {
  const d = degree - 1;
  const octave = Math.floor(d / 7);
  const step = SCALES[mode][((d % 7) + 7) % 7];
  if (step === undefined) throw new RangeError(`material: degree ${degree}`);
  return octave * 12 + step;
}

/** A MIDI note of the key's scale. */
export function scaleMidi(rootMidi: number, mode: Mode, degree: number, octave = 0): number {
  return rootMidi + octave * 12 + degreeToSemitones(mode, degree);
}

/** The pitch class of the Boot Sector's root, F. The walk begins here. */
export const HOME_PITCH_CLASS = 5;

/** Leg `index`'s root, a fifth up from the previous leg's: F, C, G, D, A, E, B, F#, C#, G#, D#, A#, F, C. */
export function keyPitchClass(index: number): number {
  return (HOME_PITCH_CLASS + 7 * index) % 12;
}

const NOTE_NAMES: readonly string[] = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LETTER_PITCH_CLASS: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** The lowest MIDI note at or above `low` with pitch class `pc`. */
export function placePitchClass(pc: number, low: number): number {
  return low + ((((pc - low) % 12) + 12) % 12);
}

/** Registers, MIDI. The bass sits under everything; the chords and pad share the middle; the arp and lead sit above. */
export const REGISTER = {
  bass: { low: 31, high: 42 },
  pad: { low: 48 },
  chords: { low: 50, high: 79 },
  arp: { low: 62 },
  /** The motif's low tonic sits from G3 to F#4 by key, so the phrase spans G4 to A#5 at most. */
  lead: { low: 55 },
} as const;

/* ------------------------------------------------------------------ */
/* Chords                                                              */
/* ------------------------------------------------------------------ */

export interface Chord {
  /** The symbol as a musician reads it, for the docs, the evidence file and the tests. */
  readonly symbol: string;
  /** Semitones of the chord root above the key root, 0 to 11. */
  readonly root: number;
  /**
   * Chord tones as semitones above the chord root, the root itself excluded
   * because the bass has it. Ordered by what matters: the guide tones first,
   * so the two voices of low tier play the third and the seventh.
   */
  readonly tones: readonly number[];
}

export type Quality = 'maj7' | 'maj9' | 'm7' | 'm9' | '9' | '13' | '11' | '7sus4' | 'm7b5' | 'maj7#11' | 'm6/9' | '6/9';

/** Intervals by quality, guide tones first. A seventh is 10 or 11; a ninth is 14. */
export const QUALITIES: Readonly<Record<Quality, readonly number[]>> = {
  maj7: [4, 11, 7, 12],
  maj9: [4, 11, 7, 14],
  m7: [3, 10, 7, 12],
  m9: [3, 10, 7, 14],
  '9': [4, 10, 7, 14],
  '13': [4, 10, 14, 21],
  '11': [10, 17, 14, 19],
  '7sus4': [5, 10, 7, 12],
  m7b5: [3, 10, 6, 12],
  'maj7#11': [4, 11, 18, 7],
  'm6/9': [3, 9, 7, 14],
  '6/9': [4, 9, 7, 14],
};

const QUALITY_NAMES = Object.keys(QUALITIES).sort((a, b) => b.length - a.length) as Quality[];

/** Read a chord symbol such as `Ebmaj7` or `C#m7b5` relative to the key root's pitch class. */
export function chord(symbol: string, keyPc: number): Chord {
  const m = /^([A-G])([#b]?)(.*)$/.exec(symbol);
  if (m === null) throw new RangeError(`material: cannot read chord ${symbol}`);
  const letter = LETTER_PITCH_CLASS[m[1] ?? ''];
  const quality = QUALITY_NAMES.find((q) => q === m[3]);
  if (letter === undefined || quality === undefined) throw new RangeError(`material: cannot read chord ${symbol}`);
  const pc = (letter + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  return { symbol, root: (pc - keyPc + 12) % 12, tones: QUALITIES[quality] };
}

/** A chord on a scale degree of the key, named after the key's actual root. */
export function degreeChord(degree: number, quality: Quality, mode: Mode, keyPc: number): Chord {
  const root = degreeToSemitones(mode, degree) % 12;
  const name = NOTE_NAMES[(keyPc + root) % 12] ?? 'C';
  return { symbol: `${name}${quality}`, root, tones: QUALITIES[quality] };
}

/** Section 3: sevenths or ninths on at least two chords of a progression. */
export function hasSeventhOrNinth(c: Chord): boolean {
  return c.tones.some((t) => t === 10 || t === 11 || t === 14);
}

/* ------------------------------------------------------------------ */
/* The material per leg                                                */
/* ------------------------------------------------------------------ */

export type ArpShape = 'up' | 'up_down';

export interface LegMaterial {
  readonly legId: string;
  readonly index: number;
  readonly authored: boolean;
  /** Pitch class of the key root. */
  readonly keyPc: number;
  readonly mode: Mode;
  readonly tempo: number;
  readonly arp: ArpShape;
  /** Eight chords. Two bars each when `barsPerChord` is 2; one bar each played twice when it is 1. Sixteen bars either way. */
  readonly travel: readonly Chord[];
  readonly barsPerChord: 1 | 2;
  /** Alternating two bars each under the open crossing panel, the filter closing. */
  readonly crossing: readonly [Chord, Chord];
  /** Two bars each: the chord that wanted to resolve, then where it went. */
  readonly resolveGood: readonly [Chord, Chord];
  readonly resolveBad: readonly [Chord, Chord];
  /** The pad under the motif after a derezz. */
  readonly loss: Chord;
  /** Eight chords, one a bar, the last the tonic major. */
  readonly debrief: readonly Chord[];
}

interface AuthoredSpec {
  readonly keyPc: number;
  readonly mode: Mode;
  readonly tempo: number;
  readonly arp: ArpShape;
  readonly barsPerChord: 1 | 2;
  readonly travel: readonly string[];
  readonly crossing: readonly [string, string];
  readonly resolveGood: readonly [string, string];
  readonly resolveBad: readonly [string, string];
  readonly loss: string;
  readonly debrief: readonly string[];
}

/**
 * The four shipped legs, as approved on paper in the pre-flight. The key
 * walk is F, D, A, F# at indices 0, 3, 4 and 7, which is where the fifths
 * walk lands, so the generated legs between them are related to both
 * neighbours.
 */
export const AUTHORED: Readonly<Record<string, AuthoredSpec>> = {
  /** F major, the slowest leg. Warm, and the borrowed Ebmaj7 and the C11 keep the loop from sounding finished. */
  boot_sector: {
    keyPc: 5, mode: 'major', tempo: 110, arp: 'up', barsPerChord: 2,
    travel: ['Fmaj9', 'Am7', 'Dm9', 'Bbmaj7', 'Gm9', 'Ebmaj7', 'Dm7', 'C11'],
    crossing: ['Dm7', 'C11'],
    resolveGood: ['C11', 'Fmaj9'],
    resolveBad: ['C11', 'Dm9'],
    loss: 'Dm9',
    debrief: ['Fmaj9', 'Am7', 'Dm9', 'Bbmaj7', 'Gm9', 'Ebmaj7', 'C11', 'Fmaj9'],
  },
  /** D dorian. The G13 is the dorian colour and the Dm6/9 its cadence, the raised sixth on top. */
  quantum_pass: {
    keyPc: 2, mode: 'dorian', tempo: 116, arp: 'up_down', barsPerChord: 1,
    travel: ['Dm9', 'Fmaj9', 'G13', 'Em7', 'Dm9', 'Bm7b5', 'Am7', 'G13'],
    crossing: ['Bm7b5', 'Am7'],
    resolveGood: ['G13', 'Dm6/9'],
    resolveBad: ['G13', 'Bm7b5'],
    loss: 'Dm9',
    debrief: ['Dm9', 'Fmaj9', 'G13', 'Em7', 'Dm9', 'Bm7b5', 'A7sus4', 'D6/9'],
  },
  /** A natural minor. A see-saw between the tonic and the lydian-coloured Fmaj7#11: two feet, one plank. */
  the_narrows: {
    keyPc: 9, mode: 'minor', tempo: 118, arp: 'up', barsPerChord: 2,
    travel: ['Am9', 'Fmaj7#11', 'Am9', 'Dm9', 'Fmaj7#11', 'G13', 'Bm7b5', 'E7sus4'],
    crossing: ['Bm7b5', 'E7sus4'],
    resolveGood: ['E7sus4', 'Am9'],
    resolveBad: ['E7sus4', 'Fmaj7#11'],
    loss: 'Am9',
    debrief: ['Am9', 'Fmaj7#11', 'Dm9', 'G13', 'Am9', 'Bm7b5', 'E7sus4', 'A6/9'],
  },
  /** F# natural minor. The Gmaj7#11 is the Neapolitan: enough room, nowhere to stand. */
  allocation_yards: {
    keyPc: 6, mode: 'minor', tempo: 120, arp: 'up_down', barsPerChord: 2,
    travel: ['F#m9', 'Amaj9', 'Bm9', 'Gmaj7#11', 'F#m9', 'Dmaj9', 'G#m7b5', 'C#7sus4'],
    crossing: ['G#m7b5', 'C#7sus4'],
    resolveGood: ['C#7sus4', 'F#m9'],
    resolveBad: ['C#7sus4', 'Dmaj9'],
    loss: 'F#m9',
    debrief: ['F#m9', 'Amaj9', 'Bm9', 'Gmaj7#11', 'Dmaj9', 'G#m7b5', 'C#7sus4', 'F#6/9'],
  },
};

interface DegreeStep {
  readonly degree: number;
  readonly quality: Quality;
}

/**
 * The generator's progressions, in scale degrees, for the ten unbuilt legs.
 * Each has sevenths or ninths on at least two chords and ends on a chord
 * that wants the tonic: the dominant sus in minor, the dorian IV in dorian.
 * None of them is one of the four authored progressions.
 */
export const PROGRESSIONS: Readonly<Record<'minor' | 'dorian', readonly (readonly DegreeStep[])[]>> = {
  minor: [
    [{ degree: 1, quality: 'm9' }, { degree: 3, quality: 'maj7' }, { degree: 6, quality: 'maj9' }, { degree: 4, quality: 'm7' }, { degree: 1, quality: 'm9' }, { degree: 7, quality: '13' }, { degree: 6, quality: 'maj7' }, { degree: 5, quality: '7sus4' }],
    [{ degree: 1, quality: 'm7' }, { degree: 4, quality: 'm9' }, { degree: 6, quality: 'maj7#11' }, { degree: 7, quality: '9' }, { degree: 1, quality: 'm7' }, { degree: 3, quality: 'maj9' }, { degree: 2, quality: 'm7b5' }, { degree: 5, quality: '7sus4' }],
    [{ degree: 1, quality: 'm9' }, { degree: 6, quality: 'maj9' }, { degree: 4, quality: 'm7' }, { degree: 7, quality: '13' }, { degree: 3, quality: 'maj7' }, { degree: 6, quality: 'maj9' }, { degree: 2, quality: 'm7b5' }, { degree: 5, quality: '7sus4' }],
  ],
  dorian: [
    [{ degree: 1, quality: 'm9' }, { degree: 4, quality: '13' }, { degree: 1, quality: 'm9' }, { degree: 7, quality: 'maj7' }, { degree: 2, quality: 'm7' }, { degree: 4, quality: '13' }, { degree: 5, quality: 'm7' }, { degree: 4, quality: '13' }],
    [{ degree: 1, quality: 'm7' }, { degree: 2, quality: 'm7' }, { degree: 4, quality: '9' }, { degree: 1, quality: 'm7' }, { degree: 7, quality: 'maj9' }, { degree: 5, quality: 'm9' }, { degree: 2, quality: 'm7' }, { degree: 4, quality: '13' }],
    [{ degree: 1, quality: 'm9' }, { degree: 7, quality: 'maj7' }, { degree: 4, quality: '13' }, { degree: 2, quality: 'm7' }, { degree: 1, quality: 'm9' }, { degree: 5, quality: 'm7' }, { degree: 7, quality: 'maj9' }, { degree: 4, quality: '13' }],
  ],
};

/** The per-leg stream. One fork per leg off the audio stream, never a kernel stream. */
export function legRng(legId: string, seed: number): Rng {
  return createRng(seed | 0, 'audio').fork('score').fork(legId);
}

/** Section 3: the Boot Sector is the slowest and the Portal the fastest; the rest climb with the index and a seeded step. */
export function tempoFor(index: number, rng: Rng): number {
  if (index <= 0) return TEMPO_RANGE.min;
  if (index >= JOURNEY.length - 1) return TEMPO_RANGE.max;
  const base = TEMPO_RANGE.min + Math.floor(((TEMPO_RANGE.max - TEMPO_RANGE.min) * index) / (JOURNEY.length - 1));
  return Math.min(TEMPO_RANGE.max - 1, base + (rng.chance(0.5) ? 1 : 0));
}

/**
 * The material for a leg. Authored legs come from the table and consume no
 * draws here; generated legs draw, in this order: the mode, the progression,
 * the arp shape, the tempo step. The arrangement's own draws follow in
 * `buildArrangement`, on the same stream, so the whole thing is one fixed
 * sequence per leg and seed.
 */
export function materialFor(legId: string, seed: number, rng: Rng = legRng(legId, seed)): LegMaterial {
  const index = legIndex(legId);
  const authored = AUTHORED[legId];
  if (authored !== undefined) {
    const c = (symbol: string): Chord => chord(symbol, authored.keyPc);
    return {
      legId, index, authored: true, keyPc: authored.keyPc, mode: authored.mode, tempo: authored.tempo, arp: authored.arp,
      travel: authored.travel.map(c), barsPerChord: authored.barsPerChord,
      crossing: [c(authored.crossing[0]), c(authored.crossing[1])],
      resolveGood: [c(authored.resolveGood[0]), c(authored.resolveGood[1])],
      resolveBad: [c(authored.resolveBad[0]), c(authored.resolveBad[1])],
      loss: c(authored.loss), debrief: authored.debrief.map(c),
    };
  }
  const keyPc = keyPitchClass(index);
  const mode: Mode = rng.chance(0.5) ? 'minor' : 'dorian';
  const table = PROGRESSIONS[mode];
  const steps = table[rng.int(0, table.length)];
  if (steps === undefined) throw new Error('material: empty progression table');
  const arp: ArpShape = rng.chance(0.5) ? 'up' : 'up_down';
  const tempo = tempoFor(index, rng);
  const travel = steps.map((s) => degreeChord(s.degree, s.quality, mode, keyPc));
  const last = travel[travel.length - 1];
  const second = travel[travel.length - 2];
  if (last === undefined || second === undefined) throw new Error('material: short progression');
  const tonic = degreeChord(1, mode === 'dorian' ? 'm6/9' : 'm9', mode, keyPc);
  // The deceptive resolution: the chord on the sixth degree, half-diminished in dorian, major in minor.
  const deceptive = degreeChord(6, mode === 'dorian' ? 'm7b5' : 'maj7', mode, keyPc);
  const major = degreeChord(1, '6/9', mode, keyPc);
  return {
    legId, index, authored: false, keyPc, mode, tempo, arp, travel, barsPerChord: index % 2 === 0 ? 2 : 1,
    crossing: [second, last], resolveGood: [last, tonic], resolveBad: [last, deceptive],
    loss: degreeChord(1, 'm9', mode, keyPc), debrief: [...travel.slice(0, 6), last, major],
  };
}

/* ------------------------------------------------------------------ */
/* The convoy motif                                                    */
/* ------------------------------------------------------------------ */

export interface MotifNote {
  /** One-based scale degree above the lead's low tonic; 8 is the octave; 0 is a rest. */
  readonly degree: number;
  readonly beats: number;
}

/**
 * The convoy motif, four bars, written once for the whole game. It rises a
 * fourth to the tonic, steps over it, falls back through the sixth, settles,
 * and ends on the third, which is what lets each leg's mode colour it. It
 * plays at every loss and every debrief and nowhere else.
 */
export const CONVOY_MOTIF: readonly MotifNote[] = [
  { degree: 5, beats: 1.5 }, { degree: 6, beats: 0.5 }, { degree: 8, beats: 2 },
  { degree: 9, beats: 1 }, { degree: 8, beats: 1 }, { degree: 6, beats: 2 },
  { degree: 5, beats: 1.5 }, { degree: 4, beats: 0.5 }, { degree: 5, beats: 1 }, { degree: 2, beats: 1 },
  { degree: 3, beats: 3 }, { degree: 0, beats: 1 },
];

/** The motif's cadence form: the same first two bars, then a descent that lands on the tonic and holds it. */
export const CONVOY_CADENCE_TAIL: readonly MotifNote[] = [
  { degree: 8, beats: 1 }, { degree: 6, beats: 1 }, { degree: 5, beats: 2 },
  { degree: 8, beats: 4 },
];

export function motifCadence(): readonly MotifNote[] {
  const firstTwoBars: MotifNote[] = [];
  let beats = 0;
  for (const n of CONVOY_MOTIF) {
    if (beats >= 2 * BEATS_PER_BAR) break;
    firstTwoBars.push(n);
    beats += n.beats;
  }
  return [...firstTwoBars, ...CONVOY_CADENCE_TAIL];
}

/**
 * Render a phrase into lead notes from `startStep`. The vowel travels the
 * formant path in an arch across the phrase: closed at the ends, open at
 * the peak. `Note.cutoff` carries it; for the lead that field is the vowel.
 */
export function phraseNotes(phrase: readonly MotifNote[], startStep: number, rootMidi: number, mode: Mode, velocity: number): Note[] {
  const notes: Note[] = [];
  let step = startStep;
  const sounding = phrase.filter((n) => n.degree > 0).length;
  let i = 0;
  const tonic = placePitchClass(rootMidi % 12, REGISTER.lead.low);
  for (const n of phrase) {
    const length = Math.round(n.beats * STEPS_PER_BEAT);
    if (n.degree > 0) {
      const arch = sounding > 1 ? Math.sin((Math.PI * i) / (sounding - 1)) : 0;
      notes.push({ step, length, midi: tonic + degreeToSemitones(mode, n.degree), velocity: n.degree >= 9 ? Math.min(1, velocity + 0.15) : velocity, cutoff: 0.05 + 0.5 * arch });
      i += 1;
    }
    step += length;
  }
  return notes;
}

/* ------------------------------------------------------------------ */
/* Patterns                                                            */
/* ------------------------------------------------------------------ */

/** The filter's position across a section, 0 to 1 of its length: what the chords and the arp breathe with. */
export function cutoffShape(section: SectionId, x: number): number {
  const t = Math.min(1, Math.max(0, x));
  switch (section) {
    case 'entry': return 0.1 + 0.4 * t;
    case 'travel': return t < 0.5 ? 0.15 + 0.8 * (t / 0.5) : 0.95 - 0.8 * ((t - 0.5) / 0.5);
    case 'crossing': return t < 0.5 ? 0.6 - 0.45 * (t / 0.5) : 0.5 - 0.35 * ((t - 0.5) / 0.5);
    case 'resolve_good': return 0.6 + 0.4 * t;
    case 'resolve_bad': return 0.35 - 0.15 * t;
    case 'debrief': return 0.45 + 0.15 * t;
    case 'loss': return 0.3;
    case 'panic': return 0.2;
    default: return 0.5;
  }
}

interface Build {
  readonly material: LegMaterial;
  readonly rootMidi: number;
  readonly rng: Rng;
  /** Seeded: which off-beat sixteenths the arp accents. */
  readonly accents: readonly boolean[];
  /** Seeded: whether a passing note prefers to approach from below. */
  readonly fromBelow: boolean;
}

function chordRootMidi(c: Chord, rootMidi: number): number {
  return placePitchClass((rootMidi + c.root) % 12, REGISTER.chords.low);
}

/** The chord voices' notes, guide tones first, folded under the top of the register. */
function chordTones(c: Chord, rootMidi: number): number[] {
  const root = chordRootMidi(c, rootMidi);
  return c.tones.map((t) => {
    let midi = root + t;
    while (midi > REGISTER.chords.high) midi -= 12;
    return midi;
  });
}

/** The arp's four tones: the root and the chord's first three, sorted within one octave above the arp floor. */
function arpTones(c: Chord, rootMidi: number): number[] {
  const rootPc = (rootMidi + c.root) % 12;
  const pcs = [0, ...c.tones.slice(0, 3)].map((t) => (rootPc + t) % 12);
  return pcs.map((pc) => placePitchClass(pc, REGISTER.arp.low)).sort((a, b) => a - b);
}

/** The pad's notes: the chord root and its fifth, in the pad register. */
function padTones(c: Chord, rootMidi: number): number[] {
  const root = placePitchClass((rootMidi + c.root) % 12, REGISTER.pad.low);
  const fifth = c.tones.includes(6) ? 6 : 7;
  return [root, root + fifth];
}

function bassRoot(c: Chord, rootMidi: number): number {
  return placePitchClass((rootMidi + c.root) % 12, REGISTER.bass.low);
}

/**
 * The bass's one passing note a bar: a scale step toward the next bar's
 * root from the seeded side, chromatic when the next root is borrowed; the
 * chord's fifth when the root does not change.
 */
function passingNote(current: Chord, next: Chord, b: Build): number {
  const from = bassRoot(current, b.rootMidi);
  const to = bassRoot(next, b.rootMidi);
  if (current.root === next.root) {
    const fifth = from + (current.tones.includes(6) ? 6 : 7);
    return fifth > REGISTER.bass.high ? fifth - 12 : fifth;
  }
  const scale = SCALES[b.material.mode].map((s) => (b.rootMidi + s) % 12);
  const toPc = ((to % 12) + 12) % 12;
  const below = scale.includes(toPc) ? (scale.includes((toPc + 10) % 12) ? 2 : 1) : 1;
  const above = scale.includes(toPc) ? (scale.includes((toPc + 2) % 12) ? 2 : 1) : 1;
  let note = b.fromBelow ? to - below : to + above;
  if (note < REGISTER.bass.low) note = to + above;
  if (note > REGISTER.bass.high) note = to - below;
  return note;
}

const note = (step: number, length: number, midi: number, velocity: number, cutoff: number): Note => ({ step, length, midi, velocity, cutoff });

function section(id: SectionId, parts: Record<PartId, Note[]>, extra: Partial<Section> = {}): Section {
  return { id, bars: SECTION_BARS[id], loopStart: 0, cutsBar: false, level: { from: 1, to: 1 }, padDetuneCents: 0, body: { kind: 'patterns', parts }, ...extra };
}

/** Kick on every beat of every bar in [from, to). */
function kicks(parts: Record<PartId, Note[]>, from: number, to: number): void {
  for (let bar = from; bar < to; bar++) {
    for (let beat = 0; beat < BEATS_PER_BAR; beat++) parts.kick.push(note(bar * STEPS_PER_BAR + beat * STEPS_PER_BEAT, STEPS_PER_BEAT, 36, beat === 0 ? 1 : 0.92, 0));
  }
}

/** Straight eighths on the root, the last eighth of each bar the passing note toward the next bar's chord. */
function bassLine(parts: Record<PartId, Note[]>, chordsByBar: readonly Chord[], b: Build, from = 0): void {
  for (const [i, c] of chordsByBar.entries()) {
    const bar = from + i;
    const next = chordsByBar[(i + 1) % chordsByBar.length] ?? c;
    const root = bassRoot(c, b.rootMidi);
    for (let e = 0; e < 8; e++) {
      const midi = e === 7 ? passingNote(c, next, b) : root;
      parts.bass.push(note(bar * STEPS_PER_BAR + e * 2, 2, midi, e % 2 === 0 ? 0.9 : 0.75, 0.35));
    }
  }
}

/** One long note per chord tone, the cutoff from the section's shape at the note's start. */
function chordPads(parts: Record<PartId, Note[]>, id: SectionId, chordsByBar: readonly Chord[], barsEach: number, b: Build, from = 0, velocity = 0.8): void {
  const steps = SECTION_BARS[id] * STEPS_PER_BAR;
  for (const [i, c] of chordsByBar.entries()) {
    const start = (from + i * barsEach) * STEPS_PER_BAR;
    const length = barsEach * STEPS_PER_BAR;
    for (const midi of chordTones(c, b.rootMidi)) parts.chords.push(note(start, length, midi, velocity, cutoffShape(id, start / steps)));
    for (const midi of padTones(c, b.rootMidi)) parts.pad.push(note(start, length, midi, velocity, 0));
  }
}

/** Sixteenths (or eighths) of the chord tones, up or up and down, accents seeded, the cutoff from the section's shape. */
function arpeggio(parts: Record<PartId, Note[]>, id: SectionId, chordsByBar: readonly Chord[], barsEach: number, b: Build, from: number, length: number, velocity: number): void {
  const steps = SECTION_BARS[id] * STEPS_PER_BAR;
  for (const [i, c] of chordsByBar.entries()) {
    const tones = arpTones(c, b.rootMidi);
    const climb = [...tones, ...tones.map((t) => t + 12)];
    const cycle = b.material.arp === 'up' ? climb : [...climb, ...[...climb].reverse().slice(1, -1)];
    for (let bar = 0; bar < barsEach; bar++) {
      const barStart = (from + i * barsEach + bar) * STEPS_PER_BAR;
      for (let s = 0; s < STEPS_PER_BAR; s += length) {
        const k = (bar * STEPS_PER_BAR + s) / length;
        const midi = cycle[k % cycle.length] ?? tones[0] ?? 60;
        const accent = s % STEPS_PER_BEAT === 0 || (b.accents[s] ?? false);
        const step = barStart + s;
        parts.arp.push(note(step, length, midi, accent ? velocity : velocity * 0.78, cutoffShape(id, step / steps)));
      }
    }
  }
}

function repeat<T>(items: readonly T[], times: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < times; i++) out.push(...items);
  return out;
}

/** The travel chords bar by bar: two bars each once, or one bar each twice. */
function travelByBar(m: LegMaterial): Chord[] {
  return m.barsPerChord === 2 ? m.travel.flatMap((c) => [c, c]) : repeat(m.travel, 2);
}

function buildEntry(b: Build): Section {
  const parts = emptyParts();
  const first = b.material.travel[0];
  if (first === undefined) throw new Error('material: no travel chords');
  chordPads(parts, 'entry', [first], SECTION_BARS.entry, b, 0, 0.55);
  return section('entry', parts);
}

function buildTravel(b: Build): Section {
  const parts = emptyParts();
  const m = b.material;
  const byBar = travelByBar(m);
  kicks(parts, 0, SECTION_BARS.travel);
  bassLine(parts, byBar, b);
  chordPads(parts, 'travel', m.travel, m.barsPerChord, b);
  if (m.barsPerChord === 1) chordPads(parts, 'travel', m.travel, 1, b, m.travel.length);
  arpeggio(parts, 'travel', m.travel, m.barsPerChord, b, 0, 1, 0.7);
  if (m.barsPerChord === 1) arpeggio(parts, 'travel', m.travel, 1, b, m.travel.length, 1, 0.7);
  return section('travel', parts);
}

function buildCrossing(b: Build): Section {
  const parts = emptyParts();
  const [a, c] = b.material.crossing;
  const pair = [a, c, a, c];
  chordPads(parts, 'crossing', pair, 2, b, 0, 0.7);
  chordPads(parts, 'crossing', pair, 2, b, CROSSING_LOOP_START, 0.7);
  arpeggio(parts, 'crossing', pair, 2, b, CROSSING_LOOP_START, 2, 0.42);
  return section('crossing', parts, { loopStart: CROSSING_LOOP_START });
}

function buildResolve(b: Build, id: 'resolve_good' | 'resolve_bad'): Section {
  const parts = emptyParts();
  const pair = id === 'resolve_good' ? b.material.resolveGood : b.material.resolveBad;
  kicks(parts, 0, SECTION_BARS[id]);
  bassLine(parts, [pair[0], pair[0], pair[1], pair[1]], b);
  chordPads(parts, id, pair, 2, b);
  arpeggio(parts, id, pair, 2, b, 0, id === 'resolve_good' ? 1 : 2, id === 'resolve_good' ? 0.7 : 0.5);
  return section(id, parts);
}

function buildLoss(b: Build): Section {
  const parts = emptyParts();
  const length = SECTION_BARS.loss * STEPS_PER_BAR;
  for (const midi of padTones(b.material.loss, b.rootMidi)) parts.pad.push(note(0, length, midi, 0.85, 0));
  parts.lead.push(...phraseNotes(CONVOY_MOTIF, 0, b.rootMidi, b.material.mode, 0.6));
  return section('loss', parts);
}

function buildPanic(b: Build): Section {
  const parts = emptyParts();
  const length = SECTION_BARS.panic * STEPS_PER_BAR;
  const root = placePitchClass(b.rootMidi % 12, REGISTER.pad.low);
  parts.pad.push(note(0, length, root, 0.85, 0), note(0, length, root + 7, 0.85, 0));
  return section('panic', parts, { cutsBar: true, level: { from: 1, to: 0 }, padDetuneCents: 60 });
}

function buildDebrief(b: Build): Section {
  const parts = emptyParts();
  const m = b.material;
  chordPads(parts, 'debrief', m.debrief, 1, b, 0, 0.7);
  for (const [i, c] of m.debrief.entries()) {
    const root = bassRoot(c, b.rootMidi);
    parts.bass.push(note(i * STEPS_PER_BAR, 8, root, 0.8, 0.3), note(i * STEPS_PER_BAR + 8, 8, root, 0.7, 0.3));
  }
  parts.lead.push(...phraseNotes(CONVOY_MOTIF, 0, b.rootMidi, m.mode, 0.7));
  parts.lead.push(...phraseNotes(motifCadence(), 4 * STEPS_PER_BAR, b.rootMidi, m.mode, 0.7));
  return section('debrief', parts);
}

/**
 * The arrangement of a leg's material. Draws, in order after the material's
 * own: the swing, the sixteen accent bits, the passing-note side. Same seed,
 * same arrangement; two seeds differ even for an authored leg.
 */
export function buildArrangement(material: LegMaterial, rng: Rng): Arrangement {
  const rootMidi = placePitchClass(material.keyPc, REGISTER.bass.low);
  const swing = 0.53 + rng.next() * 0.03;
  const accents: boolean[] = [];
  for (let s = 0; s < STEPS_PER_BAR; s++) accents.push(s % STEPS_PER_BEAT !== 0 && rng.chance(0.3));
  const b: Build = { material, rootMidi, rng, accents, fromBelow: rng.chance(0.5) };
  const sections = {
    entry: buildEntry(b),
    travel: buildTravel(b),
    crossing: buildCrossing(b),
    resolve_good: buildResolve(b, 'resolve_good'),
    resolve_bad: buildResolve(b, 'resolve_bad'),
    loss: buildLoss(b),
    panic: buildPanic(b),
    debrief: buildDebrief(b),
  };
  for (const id of SECTION_IDS) if (sections[id] === undefined) throw new Error(`material: no ${id}`);
  return { rootMidi, mode: material.mode, tempo: material.tempo, swing, sections };
}

/** The whole thing for a leg and a seed: material, then arrangement, on one stream. */
export function arrangementFor(legId: string, seed: number): Arrangement {
  const rng = legRng(legId, seed);
  return buildArrangement(materialFor(legId, seed, rng), rng);
}

/* ------------------------------------------------------------------ */
/* The voicing: what a note becomes                                    */
/* ------------------------------------------------------------------ */

export const BASS_ADSR: Adsr = { attack: 0.004, decay: 0.08, sustain: 0.7, release: 0.06 };
export const ARP_ADSR: Adsr = { attack: 0.003, decay: 0.05, sustain: 0.3, release: 0.04 };
export const PAD_ADSR: Adsr = { attack: 0.35, decay: 0, sustain: 1, release: 0.4 };
/** The loss articulation: slow in, slow out, a glide. Both lead envelopes are fitted to the note by `leadEnvelope`. */
export const LEAD_SLOW_ADSR: Adsr = { attack: 0.25, decay: 0.05, sustain: 0.8, release: 0.5 };
export const LEAD_GLIDE_SECONDS = { debrief: 0.06, loss: 0.12 } as const;

/**
 * The lead's envelope for a note of `seconds`: the articulation's times,
 * each capped at a share of the note so that attack, decay and release
 * together leave a fifth of it to hold. The motif's shortest note is half a
 * beat, a quarter second at the fastest tempo, and the slow articulation
 * alone is nearly a second; without the fit the phrase's notes would pile
 * up on the lead voices and a single lead voice would clip its own tail.
 */
export function leadEnvelope(base: Adsr, seconds: number): Adsr {
  return {
    attack: Math.min(base.attack, seconds * 0.35),
    decay: Math.min(base.decay, seconds * 0.1),
    sustain: base.sustain,
    release: Math.min(base.release, seconds * 0.35),
  };
}

/** Part levels before velocity, tuned for the score bus at its default volume. */
export const LEVEL = { kick: 0.9, bass: 0.42, chords: 0.2, arp: 0.16, lead: 0.28, pad: 0.22 } as const;

function shapeAtEnd(c: PatchContext, n: Note): number {
  const steps = c.section.bars * STEPS_PER_BAR;
  return cutoffShape(c.section.id, (n.step + n.length) / steps);
}

function nextLeadVowel(c: PatchContext, n: Note): number {
  if (c.section.body.kind !== 'patterns') return n.cutoff;
  let best: Note | null = null;
  for (const other of c.section.body.parts.lead) {
    if (other.step > n.step && (best === null || other.step < best.step)) best = other;
  }
  return best === null ? n.cutoff : best.cutoff;
}

/** Section 3's instruments, one patch per part. The sequencer sets `layer` and fits `hold`. */
export const SCORE_VOICING: Voicing = {
  kick: {
    kind: 'kick', adsr: { attack: 0.002, decay: 0.28, sustain: 0, release: 0.03 },
    patch: (n: Note, _c: PatchContext, out: MutableVoiceParams) => { out.gain = LEVEL.kick * n.velocity; out.pan = 0; },
  },
  bass: {
    kind: 'chord', adsr: BASS_ADSR,
    patch: (n, _c, out) => {
      const hz = midiToHz(n.midi);
      out.hz = hz; out.detuneCents = 0; out.gain = LEVEL.bass * n.velocity; out.adsr = BASS_ADSR;
      out.filterHz = hz * (2 + 6 * n.cutoff); out.q = 1.5; out.pan = 0;
    },
  },
  chords: {
    kind: 'chord', adsr: CHORD_ADSR,
    patch: (n, c, out) => {
      out.hz = midiToHz(n.midi); out.detuneCents = 7; out.gain = LEVEL.chords * n.velocity; out.adsr = CHORD_ADSR;
      out.filterHz = cutoffHz(n.cutoff); out.filterEndHz = cutoffHz(shapeAtEnd(c, n)); out.q = 3;
      out.pan = n.midi % 2 === 0 ? -0.25 : 0.25;
    },
  },
  arp: {
    kind: 'tone', adsr: ARP_ADSR,
    patch: (n, _c, out) => {
      const hz = midiToHz(n.midi);
      out.hz = hz; out.hz2 = hz; out.waveform = 'sawtooth'; out.gain = LEVEL.arp * n.velocity; out.adsr = ARP_ADSR;
      out.filterHz = Math.max(hz * 1.5, cutoffHz(n.cutoff)); out.q = 4; out.pan = 0.2;
    },
  },
  lead: {
    kind: 'lead', adsr: LEAD_ADSR,
    patch: (n, c, out) => {
      const slow = c.section.id === 'loss';
      out.hz = midiToHz(n.midi); out.gain = LEVEL.lead * n.velocity; out.adsr = leadEnvelope(slow ? LEAD_SLOW_ADSR : LEAD_ADSR, c.seconds);
      out.glideSeconds = slow ? LEAD_GLIDE_SECONDS.loss : LEAD_GLIDE_SECONDS.debrief;
      out.vowel = n.cutoff; out.vowelEnd = nextLeadVowel(c, n); out.detuneCents = 5; out.pan = 0;
    },
  },
  pad: {
    kind: 'drone', adsr: PAD_ADSR,
    patch: (n, _c, out) => {
      const hz = midiToHz(n.midi);
      out.hz = hz; out.gain = LEVEL.pad * n.velocity; out.adsr = PAD_ADSR; out.filterHz = hz * 5; out.detuneCents = 6;
      out.pan = n.midi % 2 === 0 ? -0.2 : 0.2;
    },
  },
};

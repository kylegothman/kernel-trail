import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LEG_ORDER } from '@game/types';
import { createRng } from '@kernel/rng';
import { stripComments } from '../kernel/sourceScan';
import {
  PART_IDS, SECTION_BARS, SECTION_IDS, STEPS_PER_BAR, TEMPO_RANGE, validateArrangement,
  type Arrangement, type Note, type SectionId,
} from '../../src/audio/score/Arrangement';
import {
  AUTHORED, CONVOY_CADENCE_TAIL, CONVOY_MOTIF, JOURNEY, LEAD_SLOW_ADSR, PROGRESSIONS, QUALITIES, REGISTER, SCALES, SCORE_VOICING,
  arrangementFor, chord, cutoffShape, degreeChord, degreeToSemitones, hasSeventhOrNinth, keyPitchClass, leadEnvelope, legRng, materialFor, motifCadence, phraseNotes, placePitchClass, tempoFor,
  type Chord, type LegMaterial,
} from '../../src/audio/score/material';
import { GENERATED_SCORE_SOURCE, GeneratedScoreSource } from '../../src/audio/score/source';
import { VOICE_KINDS } from '../../src/audio/voices/Voice';
import { FakeContext } from './fakeContext';
import type { Voicing } from '../../src/audio/score/Sequencer';

const SEED = 0x4b54524c;
const SHIPPED = ['boot_sector', 'quantum_pass', 'the_narrows', 'allocation_yards'] as const;

/** The paper the pre-flight approved: chord symbols, tempo, mode. */
const PAPER = {
  boot_sector: { tempo: 110, mode: 'major', travel: 'Fmaj9 Am7 Dm9 Bbmaj7 Gm9 Ebmaj7 Dm7 C11', debrief: 'Fmaj9 Am7 Dm9 Bbmaj7 Gm9 Ebmaj7 C11 Fmaj9', rootPc: 5 },
  quantum_pass: { tempo: 116, mode: 'dorian', travel: 'Dm9 Fmaj9 G13 Em7 Dm9 Bm7b5 Am7 G13', debrief: 'Dm9 Fmaj9 G13 Em7 Dm9 Bm7b5 A7sus4 D6/9', rootPc: 2 },
  the_narrows: { tempo: 118, mode: 'minor', travel: 'Am9 Fmaj7#11 Am9 Dm9 Fmaj7#11 G13 Bm7b5 E7sus4', debrief: 'Am9 Fmaj7#11 Dm9 G13 Am9 Bm7b5 E7sus4 A6/9', rootPc: 9 },
  allocation_yards: { tempo: 120, mode: 'minor', travel: 'F#m9 Amaj9 Bm9 Gmaj7#11 F#m9 Dmaj9 G#m7b5 C#7sus4', debrief: 'F#m9 Amaj9 Bm9 Gmaj7#11 Dmaj9 G#m7b5 C#7sus4 F#6/9', rootPc: 6 },
} as const;

const symbols = (chords: readonly Chord[]): string => chords.map((c) => c.symbol).join(' ');

function parts(a: Arrangement, id: SectionId): Record<(typeof PART_IDS)[number], readonly Note[]> {
  const body = a.sections[id].body;
  if (body.kind !== 'patterns') throw new Error(`${id} is not patterns`);
  return body.parts;
}

/** Notes of a part grouped by bar. */
function byBar(notes: readonly Note[], bars: number): Note[][] {
  const out: Note[][] = [];
  for (let b = 0; b < bars; b++) out.push([]);
  for (const n of notes) out[Math.floor(n.step / STEPS_PER_BAR)]?.push(n);
  return out;
}

const intervals = (notes: readonly Note[]): number[] => notes.slice(1).map((n, i) => n.midi - (notes[i]?.midi ?? 0));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe('material', () => {
  it('journey: the local leg order is LEG_ORDER and every leg has an arrangement that validates', () => {
    expect([...JOURNEY]).toEqual([...LEG_ORDER]);
    for (const legId of JOURNEY) {
      const a = arrangementFor(legId, SEED);
      expect(validateArrangement(a), legId).toEqual([]);
      for (const id of SECTION_IDS) expect(a.sections[id].bars, `${legId} ${id}`).toBe(SECTION_BARS[id]);
    }
    expect(() => arrangementFor('the_void', SEED)).toThrow(/not a leg/);
    expect(new GeneratedScoreSource().arrangement('boot_sector', SEED)).toEqual(arrangementFor('boot_sector', SEED));
    expect(GENERATED_SCORE_SOURCE.arrangement('the_portal', 3)).toEqual(arrangementFor('the_portal', 3));
  });

  it('keys: a fifths walk from F with the authored legs on it, the Boot Sector major, the rest minor or dorian', () => {
    const expected = ['F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#', 'F', 'C'];
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    for (const [index, legId] of JOURNEY.entries()) {
      const m = materialFor(legId, SEED);
      expect(names[keyPitchClass(index)], legId).toBe(expected[index]);
      expect(m.keyPc, legId).toBe(keyPitchClass(index));
      expect(m.index).toBe(index);
      const a = arrangementFor(legId, SEED);
      expect(a.rootMidi % 12, legId).toBe(m.keyPc);
      expect(a.rootMidi).toBeGreaterThanOrEqual(REGISTER.bass.low);
      expect(a.rootMidi).toBeLessThanOrEqual(REGISTER.bass.high);
      if (legId === 'boot_sector') expect(m.mode).toBe('major');
      else expect(['minor', 'dorian']).toContain(m.mode);
    }
    for (let i = 1; i < JOURNEY.length; i++) expect((keyPitchClass(i) - keyPitchClass(i - 1) + 12) % 12).toBe(7);
    expect(SCALES.major).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(SCALES.minor).toEqual([0, 2, 3, 5, 7, 8, 10]);
    expect(SCALES.dorian).toEqual([0, 2, 3, 5, 7, 9, 10]);
    expect(degreeToSemitones('major', 8)).toBe(12);
    expect(degreeToSemitones('minor', 9)).toBe(14);
    expect(degreeToSemitones('dorian', 6)).toBe(9);
    expect(placePitchClass(5, 31)).toBe(41);
    expect(placePitchClass(9, 31)).toBe(33);
    expect(placePitchClass(0, 55)).toBe(60);
  });

  it('tempo: between 110 and 126, the Boot Sector slowest, the Portal fastest, from the index and the seed', () => {
    const tempos = new Map<string, number>();
    for (const legId of JOURNEY) {
      const a = arrangementFor(legId, SEED);
      const b = arrangementFor(legId, 99);
      // Authored legs are fixed; a generated leg's tempo comes from its index and the seed and moves by at most one.
      if (SHIPPED.includes(legId as (typeof SHIPPED)[number])) expect(a.tempo, legId).toBe(b.tempo);
      else expect(Math.abs(a.tempo - b.tempo), legId).toBeLessThanOrEqual(1);
      expect(a.tempo).toBeGreaterThanOrEqual(TEMPO_RANGE.min);
      expect(a.tempo).toBeLessThanOrEqual(TEMPO_RANGE.max);
      tempos.set(legId, a.tempo);
    }
    expect(tempos.get('boot_sector')).toBe(110);
    expect(tempos.get('the_portal')).toBe(126);
    for (const [legId, tempo] of tempos) {
      if (legId !== 'boot_sector') expect(tempo, legId).toBeGreaterThan(110);
      if (legId !== 'the_portal') expect(tempo, legId).toBeLessThan(126);
    }
    expect(tempos.get('quantum_pass')).toBe(116);
    expect(tempos.get('the_narrows')).toBe(118);
    expect(tempos.get('allocation_yards')).toBe(120);
    const rng = createRng(1, 'test');
    expect(tempoFor(0, rng)).toBe(110);
    expect(tempoFor(13, rng)).toBe(126);
    for (let i = 1; i <= 12; i++) { const t = tempoFor(i, rng); expect(t).toBeGreaterThan(110); expect(t).toBeLessThan(126); }
  });

  it('paper: the four shipped legs are the chord symbols, tempos and modes the pre-flight approved', () => {
    for (const legId of SHIPPED) {
      const m = materialFor(legId, SEED);
      const paper = PAPER[legId];
      expect(m.authored, legId).toBe(true);
      expect(symbols(m.travel), legId).toBe(paper.travel);
      expect(symbols(m.debrief), legId).toBe(paper.debrief);
      expect(m.tempo).toBe(paper.tempo);
      expect(m.mode).toBe(paper.mode);
      expect(m.keyPc).toBe(paper.rootPc);
      expect(m.travel.length).toBe(8);
      expect(m.debrief.length).toBe(8);
      expect(AUTHORED[legId]?.travel.join(' ')).toBe(paper.travel);
    }
    expect(materialFor('boot_sector', SEED).resolveGood.map((c) => c.symbol)).toEqual(['C11', 'Fmaj9']);
    expect(materialFor('boot_sector', SEED).resolveBad.map((c) => c.symbol)).toEqual(['C11', 'Dm9']);
    expect(materialFor('quantum_pass', SEED).resolveGood.map((c) => c.symbol)).toEqual(['G13', 'Dm6/9']);
    expect(materialFor('quantum_pass', SEED).crossing.map((c) => c.symbol)).toEqual(['Bm7b5', 'Am7']);
    expect(materialFor('allocation_yards', SEED).travel[3]?.symbol).toBe('Gmaj7#11');
    expect(Object.keys(AUTHORED).sort()).toEqual([...SHIPPED].sort());
  });

  it('chords: symbols parse to roots and tones, guide tones first, and every quality has a seventh or a ninth or is a 6/9', () => {
    const f = chord('Fmaj9', 5);
    expect(f).toEqual({ symbol: 'Fmaj9', root: 0, tones: [4, 11, 7, 14] });
    expect(chord('Ebmaj7', 5).root).toBe(10);
    expect(chord('C11', 5)).toEqual({ symbol: 'C11', root: 7, tones: [10, 17, 14, 19] });
    expect(chord('C#7sus4', 6).root).toBe(7);
    expect(chord('G#m7b5', 6).root).toBe(2);
    expect(chord('Bbmaj7', 5).root).toBe(5);
    expect(() => chord('H7', 0)).toThrow(/cannot read chord/);
    expect(() => chord('Cmaj13', 0)).toThrow(/cannot read chord/);
    expect(degreeChord(4, '13', 'dorian', 2)).toEqual({ symbol: 'G13', root: 5, tones: [4, 10, 14, 21] });
    expect(degreeChord(6, 'maj7', 'minor', 9).symbol).toBe('Fmaj7');
    expect(degreeChord(1, '6/9', 'minor', 6).symbol).toBe('F#6/9');
    for (const [quality, tones] of Object.entries(QUALITIES)) {
      expect(tones.length, quality).toBe(4);
      if (quality !== '6/9' && quality !== 'm6/9') expect(hasSeventhOrNinth({ symbol: quality, root: 0, tones }), quality).toBe(true);
    }
  });

  it('progressions: eight chords, sevenths or ninths on at least two, ending away from the tonic on a chord that wants it', () => {
    const wanting = (last: Chord, mode: string): boolean =>
      mode === 'dorian' ? last.root === 5 : last.root === 7 || last.root === 2;
    for (const legId of JOURNEY) {
      const m = materialFor(legId, SEED);
      expect(m.travel.length, legId).toBe(8);
      expect(m.travel.filter(hasSeventhOrNinth).length, legId).toBeGreaterThanOrEqual(2);
      const last = m.travel[m.travel.length - 1];
      expect(last?.root, legId).not.toBe(0);
      if (last !== undefined && legId !== 'boot_sector') expect(wanting(last, m.mode), `${legId} ends on ${last.symbol}`).toBe(true);
      expect(m.debrief[m.debrief.length - 1]?.root, legId).toBe(0);
      expect(m.debrief[m.debrief.length - 1]?.tones.includes(4), `${legId} debrief ends major`).toBe(true);
      expect(m.loss.root, legId).toBe(legId === 'boot_sector' ? 9 : 0);
      expect(m.resolveGood[1].root, legId).toBe(0);
      expect(m.resolveBad[1].root, legId).not.toBe(0);
    }
    for (const mode of ['minor', 'dorian'] as const) {
      for (const steps of PROGRESSIONS[mode]) {
        expect(steps.length).toBe(8);
        const chords = steps.map((s) => degreeChord(s.degree, s.quality, mode, 0));
        expect(chords.filter(hasSeventhOrNinth).length).toBeGreaterThanOrEqual(2);
        expect(chords[7]?.root).not.toBe(0);
        // None of the generator's progressions is one of the authored ones.
        for (const legId of SHIPPED) expect(steps.map((s) => s.degree).join(',')).not.toBe(materialFor(legId, SEED).travel.map((c) => c.root).join(','));
      }
    }
  });

  it('bass: follows the roots an octave down in straight eighths with one passing note a bar', () => {
    for (const legId of JOURNEY) {
      const a = arrangementFor(legId, SEED);
      const m = materialFor(legId, SEED);
      const travel = parts(a, 'travel');
      const bars = byBar(travel.bass, a.sections.travel.bars);
      const chordsByBar = m.barsPerChord === 2 ? m.travel.flatMap((c) => [c, c]) : [...m.travel, ...m.travel];
      for (const [b, notes] of bars.entries()) {
        expect(notes.length, `${legId} bar ${b}`).toBe(8);
        expect(notes.map((n) => n.step - b * STEPS_PER_BAR)).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
        expect(notes.every((n) => n.length === 2)).toBe(true);
        const chordRoot = (a.rootMidi + (chordsByBar[b]?.root ?? 0)) % 12;
        for (const n of notes.slice(0, 7)) {
          expect(n.midi % 12, `${legId} bar ${b}`).toBe(chordRoot);
          expect(n.midi).toBeGreaterThanOrEqual(REGISTER.bass.low);
          expect(n.midi).toBeLessThanOrEqual(REGISTER.bass.high);
        }
        const passing = notes[7];
        const nextRoot = (a.rootMidi + (chordsByBar[(b + 1) % chordsByBar.length]?.root ?? 0)) % 12;
        if (passing === undefined) throw new Error('no passing note');
        if (chordRoot === nextRoot) expect([6, 7]).toContain((passing.midi - chordRoot + 24) % 12);
        else expect([1, 2, 10, 11]).toContain((passing.midi - nextRoot + 24) % 12);
      }
    }
  });

  it('arp: chord tones in sixteenths, up or up and down per leg, the cutoff opening over the first half and closing over the second', () => {
    const shapes = new Set<string>();
    for (const legId of JOURNEY) {
      const a = arrangementFor(legId, SEED);
      const m = materialFor(legId, SEED);
      shapes.add(m.arp);
      const travel = parts(a, 'travel');
      const bars = byBar(travel.arp, a.sections.travel.bars);
      const chordsByBar = m.barsPerChord === 2 ? m.travel.flatMap((c) => [c, c]) : [...m.travel, ...m.travel];
      for (const [b, notes] of bars.entries()) {
        expect(notes.length, `${legId} bar ${b}`).toBe(16);
        expect(notes.every((n) => n.length === 1)).toBe(true);
        const c = chordsByBar[b];
        if (c === undefined) throw new Error('no chord');
        const allowed = new Set([0, ...c.tones].map((t) => (a.rootMidi + c.root + t) % 12));
        for (const n of notes) {
          expect(allowed.has(n.midi % 12), `${legId} bar ${b} ${n.midi}`).toBe(true);
          expect(n.midi).toBeGreaterThanOrEqual(REGISTER.arp.low);
        }
        const steps = notes.map((n) => n.midi);
        const ups = intervals(notes).filter((d) => d > 0).length;
        const downs = intervals(notes).filter((d) => d < 0).length;
        if (m.arp === 'up') expect(downs, `${legId} up`).toBeLessThanOrEqual(2);
        else expect(downs, `${legId} up_down`).toBeGreaterThan(3);
        expect(ups).toBeGreaterThan(6);
        expect(new Set(steps).size).toBeGreaterThanOrEqual(4);
      }
      const cutoffs = travel.arp.map((n) => n.cutoff);
      const half = Math.floor(cutoffs.length / 2);
      for (let i = 1; i < half; i++) expect(cutoffs[i]).toBeGreaterThanOrEqual(cutoffs[i - 1] ?? 0);
      for (let i = half + 1; i < cutoffs.length; i++) expect(cutoffs[i]).toBeLessThanOrEqual(cutoffs[i - 1] ?? 1);
      expect(Math.max(...cutoffs)).toBeGreaterThan(0.9);
      expect(Math.min(...cutoffs)).toBeLessThan(0.2);
    }
    expect(shapes).toEqual(new Set(['up', 'up_down']));
    expect(cutoffShape('travel', 0)).toBeCloseTo(0.15, 9);
    expect(cutoffShape('travel', 0.5)).toBeCloseTo(0.95, 9);
    expect(cutoffShape('travel', 1)).toBeCloseTo(0.15, 9);
    expect(cutoffShape('crossing', 0)).toBeGreaterThan(cutoffShape('crossing', 0.49));
    expect(cutoffShape('resolve_good', 1)).toBeCloseTo(1, 9);
  });

  it('motif: defined once, four bars, transposed into every key, and played only in loss and debrief', () => {
    expect(CONVOY_MOTIF.reduce((s, n) => s + n.beats, 0)).toBe(16);
    expect(CONVOY_MOTIF.map((n) => n.degree)).toEqual([5, 6, 8, 9, 8, 6, 5, 4, 5, 2, 3, 0]);
    expect(CONVOY_CADENCE_TAIL.reduce((s, n) => s + n.beats, 0)).toBe(8);
    const cadence = motifCadence();
    expect(cadence.slice(0, 6)).toEqual(CONVOY_MOTIF.slice(0, 6));
    expect(cadence.reduce((s, n) => s + n.beats, 0)).toBe(16);
    expect(cadence[cadence.length - 1]).toEqual({ degree: 8, beats: 4 });
    // Written once: one definition in the whole audio tree.
    const definitions = walk('src/audio').filter((f) => f.endsWith('.ts')).map((f) => stripComments(readFileSync(f, 'utf8'), false)).flatMap((code) => code.match(/CONVOY_MOTIF\s*[:=]/g) ?? []);
    expect(definitions.length).toBe(1);
    const reference = phraseNotes(CONVOY_MOTIF, 0, 41, 'major', 0.6);
    expect(reference.length).toBe(11);
    expect(reference[0]?.midi).toBe(72);
    expect(reference[2]?.midi).toBe(77);
    expect(reference[reference.length - 1]?.midi).toBe(69);
    expect(reference[reference.length - 1]?.step).toBe(48);
    for (const legId of JOURNEY) {
      const a = arrangementFor(legId, SEED);
      const m = materialFor(legId, SEED);
      const expected = phraseNotes(CONVOY_MOTIF, 0, a.rootMidi, m.mode, 0.6);
      const loss = parts(a, 'loss').lead;
      expect(loss.map((n) => [n.step, n.length, n.midi]), legId).toEqual(expected.map((n) => [n.step, n.length, n.midi]));
      expect(intervals(loss), legId).toEqual(intervals(reference).map((d, i) => {
        // The same phrase in the leg's mode: intervals differ only where the mode differs.
        const from = expected[i]?.midi ?? 0;
        const to = expected[i + 1]?.midi ?? 0;
        void d;
        return to - from;
      }));
      const debrief = parts(a, 'debrief').lead;
      expect(debrief.slice(0, 11).map((n) => [n.step, n.midi]), legId).toEqual(expected.map((n) => [n.step, n.midi]));
      const tail = debrief.slice(11);
      expect(tail.length).toBe(cadence.filter((n) => n.degree > 0).length);
      const last = tail[tail.length - 1];
      expect(last?.midi ?? -1, `${legId} debrief ends on the tonic`).toBe(placePitchClass(a.rootMidi % 12, REGISTER.lead.low) + 12);
      expect((last?.step ?? 0) + (last?.length ?? 0)).toBe(SECTION_BARS.debrief * STEPS_PER_BAR);
      for (const id of SECTION_IDS) if (id !== 'loss' && id !== 'debrief') expect(parts(a, id).lead.length, `${legId} ${id}`).toBe(0);
      // The third at the end takes the mode's colour.
      const third = loss[loss.length - 1];
      const tonic = placePitchClass(a.rootMidi % 12, REGISTER.lead.low);
      expect((third?.midi ?? 0) - tonic).toBe(m.mode === 'major' ? 4 : 3);
    }
  });

  it('sections: every shipped leg has all eight, with the parts the document gives each one', () => {
    for (const legId of SHIPPED) {
      const a = arrangementFor(legId, SEED);
      const p = (id: SectionId) => parts(a, id);
      expect(p('entry').kick.length).toBe(0);
      expect(p('entry').bass.length).toBe(0);
      expect(p('entry').arp.length).toBe(0);
      expect(p('entry').pad.length).toBeGreaterThan(0);
      expect(new Set(p('entry').chords.map((n) => n.step))).toEqual(new Set([0]));
      expect(p('travel').kick.length).toBe(16 * 4);
      expect(p('travel').chords.length).toBeGreaterThan(0);
      expect(p('crossing').kick.length).toBe(0);
      expect(p('crossing').bass.length).toBe(0);
      const crossingArp = p('crossing').arp;
      expect(crossingArp.length).toBeGreaterThan(0);
      expect(Math.min(...crossingArp.map((n) => n.step))).toBe(8 * STEPS_PER_BAR);
      expect(crossingArp.every((n) => n.length === 2)).toBe(true);
      expect(a.sections.crossing.loopStart).toBe(8);
      const crossingChords = p('crossing').chords;
      expect(Math.max(...crossingChords.slice(0, 4).map((n) => n.cutoff))).toBeGreaterThan(Math.max(...crossingChords.filter((n) => n.step >= 6 * STEPS_PER_BAR && n.step < 8 * STEPS_PER_BAR).map((n) => n.cutoff)));
      for (const id of ['resolve_good', 'resolve_bad'] as const) {
        expect(p(id).kick[0]?.step, `${legId} ${id} kick on the downbeat`).toBe(0);
        expect(p(id).kick.length).toBe(16);
      }
      expect(Math.max(...p('resolve_good').chords.map((n) => n.cutoff))).toBeGreaterThan(Math.max(...p('resolve_bad').chords.map((n) => n.cutoff)));
      expect(p('loss').kick.length + p('loss').bass.length + p('loss').chords.length + p('loss').arp.length).toBe(0);
      expect(p('loss').pad.length).toBeGreaterThan(0);
      expect(p('panic').pad.length).toBe(2);
      expect(a.sections.panic.cutsBar).toBe(true);
      expect(a.sections.panic.level).toEqual({ from: 1, to: 0 });
      expect(a.sections.panic.padDetuneCents).toBe(60);
      expect(p('debrief').kick.length).toBe(0);
      expect(p('debrief').chords.length).toBe(8 * 4);
      expect(p('debrief').bass.length).toBe(16);
    }
  });

  it('determinism: one seed is one arrangement, two seeds differ, and the stream is the audio stream forked per leg', () => {
    for (const legId of JOURNEY) {
      expect(arrangementFor(legId, SEED), legId).toEqual(arrangementFor(legId, SEED));
      expect(JSON.stringify(arrangementFor(legId, SEED)), legId).not.toBe(JSON.stringify(arrangementFor(legId, SEED + 1)));
    }
    const rng = legRng('boot_sector', SEED) as unknown as { label?: string };
    expect(rng.label).toBe('audio/score/boot_sector');
    // Authored legs consume no draws for their material; generated legs draw a fixed sequence.
    const spy = (legId: string): number => {
      let draws = 0;
      const base = legRng(legId, SEED);
      const counting = new Proxy(base, { get(target, key: keyof typeof base) { const v = target[key]; return typeof v === 'function' ? (...args: unknown[]) => { draws += 1; return (v as (...a: unknown[]) => unknown).apply(target, args); } : v; } });
      materialFor(legId, SEED, counting);
      return draws;
    };
    expect(spy('boot_sector')).toBe(0);
    expect(spy('fork_fields')).toBeGreaterThan(0);
    // A generated leg's mode and progression differ across seeds somewhere in the journey.
    const modes = new Set<string>();
    for (let seed = 1; seed < 12; seed++) modes.add(materialFor('the_cistern', seed).mode);
    expect(modes.size).toBe(2);
    const source = readFileSync('src/audio/score/material.ts', 'utf8');
    expect(stripComments(source, false)).not.toMatch(/Math\.random|Date\.now/);
  });

  it('voicing: every part maps to a kind in the pool and its patch sets an envelope, a pitch and a level', () => {
    const fake = new FakeContext();
    void fake;
    const voicing: Voicing = SCORE_VOICING;
    expect(Object.keys(voicing).sort()).toEqual([...PART_IDS].sort());
    const a = arrangementFor('boot_sector', SEED);
    for (const part of PART_IDS) {
      const v = voicing[part];
      expect(VOICE_KINDS).toContain(v.kind);
      const section = a.sections[part === 'lead' ? 'loss' : 'travel'];
      const body = section.body;
      if (body.kind !== 'patterns') throw new Error('patterns');
      const n = body.parts[part][0];
      if (n === undefined) throw new Error(`no ${part} note`);
      const out: Record<string, unknown> = {};
      v.patch(n, { arrangement: a, section, part, seconds: 0.5 }, out);
      expect(typeof out['gain'], part).toBe('number');
      if (part !== 'kick') { expect(typeof out['hz'], part).toBe('number'); expect(out['adsr'], part).toBeDefined(); }
      expect(out['layer']).toBeUndefined();
      expect(out['hold']).toBeUndefined();
    }
    const m: LegMaterial = materialFor('boot_sector', SEED);
    expect(m.arp).toBe('up');
    expect(materialFor('quantum_pass', SEED).arp).toBe('up_down');
    // Every part's envelope fits its shortest note at the fastest tempo, with a fifth of the note left to hold.
    const fastest = arrangementFor('the_portal', SEED);
    expect(fastest.tempo).toBe(126);
    for (const id of SECTION_IDS) {
      const body = fastest.sections[id].body;
      if (body.kind !== 'patterns') continue;
      for (const part of PART_IDS) {
        if (part === 'kick') continue;
        for (const n of body.parts[part]) {
          const seconds = (n.length * 60) / fastest.tempo / 4;
          const out: Record<string, unknown> = {};
          voicing[part].patch(n, { arrangement: fastest, section: fastest.sections[id], part, seconds }, out);
          const adsr = out['adsr'] as { attack: number; decay: number; release: number };
          expect(adsr.attack + adsr.decay + adsr.release, `${id} ${part} ${n.length} steps`).toBeLessThanOrEqual(seconds * 0.8 + 1e-9);
        }
      }
    }
    const slowShort = leadEnvelope(LEAD_SLOW_ADSR, 0.25);
    expect(slowShort.attack + slowShort.decay + slowShort.release).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(leadEnvelope(LEAD_SLOW_ADSR, 4)).toEqual(LEAD_SLOW_ADSR);
  });
});

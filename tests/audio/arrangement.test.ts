import { describe, expect, it } from 'vitest';
import {
  BEATS_PER_BAR, CROSSING_LOOP_START, DEFAULT_SWING, PART_IDS, SECTION_BARS, SECTION_IDS, STEPS_PER_BAR, STEPS_PER_BEAT, TEMPO_RANGE,
  barSeconds, beatSeconds, cutoffHz, emptyParts, sectionSeconds, stepOffsetSeconds, stepSeconds, validateArrangement,
  type Arrangement, type Note, type PartId, type Section, type SectionId,
} from '../../src/audio/score/Arrangement';
import { FakeContext } from './fakeContext';

const note = (step: number, length: number, midi: number, velocity = 0.8, cutoff = 0.5): Note => ({ step, length, midi, velocity, cutoff });

/** The smallest arrangement that satisfies every rule: one note where a part is required, nothing where it is forbidden. */
function minimal(tempo = 120, swing = DEFAULT_SWING): Arrangement {
  const section = (id: SectionId, fill: (parts: Record<PartId, Note[]>, steps: number) => void, extra: Partial<Section> = {}): Section => {
    const bars = SECTION_BARS[id];
    const parts = emptyParts();
    fill(parts, bars * STEPS_PER_BAR);
    return { id, bars, loopStart: 0, cutsBar: false, level: { from: 1, to: 1 }, padDetuneCents: 0, body: { kind: 'patterns', parts }, ...extra };
  };
  return {
    rootMidi: 41, mode: 'major', tempo, swing,
    sections: {
      entry: section('entry', (p, steps) => { p.pad.push(note(0, steps, 53)); }),
      travel: section('travel', (p) => { p.kick.push(note(0, 4, 36)); p.bass.push(note(0, 2, 41)); }),
      crossing: section('crossing', (p, steps) => { p.pad.push(note(0, steps, 53)); }, { loopStart: CROSSING_LOOP_START }),
      resolve_good: section('resolve_good', (p) => { p.kick.push(note(0, 4, 36)); }),
      resolve_bad: section('resolve_bad', (p) => { p.kick.push(note(0, 4, 36)); }),
      loss: section('loss', (p, steps) => { p.pad.push(note(0, steps, 53)); p.lead.push(note(0, 8, 65)); }),
      panic: section('panic', (p, steps) => { p.pad.push(note(0, steps, 53)); }, { cutsBar: true, level: { from: 1, to: 0 }, padDetuneCents: 60 }),
      debrief: section('debrief', (p, steps) => { p.pad.push(note(0, steps, 53)); p.lead.push(note(0, 8, 65)); }),
    },
  };
}

/** A copy of `a` with one section replaced by a transform of it. */
function withSection(a: Arrangement, id: SectionId, change: (s: Section) => Section): Arrangement {
  return { ...a, sections: { ...a.sections, [id]: change(a.sections[id]) } };
}

function withNote(a: Arrangement, id: SectionId, part: PartId, extra: Note): Arrangement {
  return withSection(a, id, (s) => {
    if (s.body.kind !== 'patterns') return s;
    return { ...s, body: { kind: 'patterns', parts: { ...s.body.parts, [part]: [...s.body.parts[part], extra] } } };
  });
}

describe('arrangement', () => {
  it('sections and parts: eight sections with fixed bar counts and six parts', () => {
    expect([...SECTION_IDS]).toEqual(['entry', 'travel', 'crossing', 'resolve_good', 'resolve_bad', 'loss', 'panic', 'debrief']);
    expect([...PART_IDS]).toEqual(['kick', 'bass', 'chords', 'arp', 'lead', 'pad']);
    expect(SECTION_BARS).toEqual({ entry: 8, travel: 16, crossing: 16, resolve_good: 4, resolve_bad: 4, loss: 4, panic: 4, debrief: 8 });
    expect(BEATS_PER_BAR).toBe(4);
    expect(STEPS_PER_BEAT).toBe(4);
    expect(STEPS_PER_BAR).toBe(16);
    expect(TEMPO_RANGE).toEqual({ min: 110, max: 126 });
    expect(DEFAULT_SWING).toBe(0.54);
    expect(Object.keys(emptyParts()).sort()).toEqual([...PART_IDS].sort());
  });

  it('timing: beat, step, bar and section seconds follow the tempo', () => {
    const a = minimal(120);
    expect(beatSeconds(a)).toBeCloseTo(0.5, 9);
    expect(stepSeconds(a)).toBeCloseTo(0.125, 9);
    expect(barSeconds(a)).toBeCloseTo(2, 9);
    expect(sectionSeconds(a, 'entry')).toBeCloseTo(16, 9);
    expect(sectionSeconds(a, 'travel')).toBeCloseTo(32, 9);
    expect(sectionSeconds(a, 'loss')).toBeCloseTo(8, 9);
    const slow = minimal(110);
    expect(barSeconds(slow)).toBeCloseTo(240 / 110, 9);
    expect(barSeconds(minimal(126))).toBeLessThan(barSeconds(slow));
  });

  it('swing: odd sixteenths are late by twice the excess over a half, and a half is straight', () => {
    const swung = minimal(120, 0.54);
    const step = stepSeconds(swung);
    expect(stepOffsetSeconds(swung, 0)).toBeCloseTo(0, 9);
    expect(stepOffsetSeconds(swung, 1)).toBeCloseTo(step + 0.08 * step, 9);
    expect(stepOffsetSeconds(swung, 2)).toBeCloseTo(2 * step, 9);
    expect(stepOffsetSeconds(swung, 3)).toBeCloseTo(3 * step + 0.08 * step, 9);
    expect(stepOffsetSeconds(swung, 1) - step).toBeCloseTo(0.01, 9);
    const straight = minimal(120, 0.5);
    for (let s = 0; s < STEPS_PER_BAR; s++) expect(stepOffsetSeconds(straight, s)).toBeCloseTo(s * step, 9);
  });

  it('cutoff: closed is 300 Hz, open is 9 kHz, and the curve is monotone', () => {
    expect(cutoffHz(0)).toBeCloseTo(300, 6);
    expect(cutoffHz(1)).toBeCloseTo(9000, 6);
    expect(cutoffHz(0.5)).toBeCloseTo(300 * Math.sqrt(30), 6);
    let previous = 0;
    for (let x = 0; x <= 1; x += 0.05) {
      const hz = cutoffHz(x);
      expect(hz).toBeGreaterThan(previous);
      previous = hz;
    }
    expect(cutoffHz(-1)).toBe(cutoffHz(0));
    expect(cutoffHz(2)).toBe(cutoffHz(1));
    expect(cutoffHz(Number.NaN)).toBe(cutoffHz(0));
  });

  it('validate: the minimal arrangement passes and every rule names its problem', () => {
    const a = minimal();
    expect(validateArrangement(a)).toEqual([]);
    const problem = (b: Arrangement): string => validateArrangement(b).join('; ');
    expect(problem({ ...a, tempo: 100 })).toMatch(/tempo 100/);
    expect(problem({ ...a, tempo: 127 })).toMatch(/tempo 127/);
    expect(problem({ ...a, swing: 0.4 })).toMatch(/swing 0.4/);
    expect(problem({ ...a, rootMidi: 70 })).toMatch(/rootMidi 70/);
    expect(problem({ ...a, mode: 'lydian' as never })).toMatch(/mode lydian/);
    expect(problem(withSection(a, 'travel', (s) => ({ ...s, bars: 12 })))).toMatch(/travel has 12 bars, expected 16 or 32/);
    expect(problem(withSection(a, 'travel', (s) => ({ ...s, bars: 32 })))).toBe('');
    expect(problem(withSection(a, 'entry', (s) => ({ ...s, bars: 4 })))).toMatch(/entry has 4 bars, expected 8/);
    expect(problem(withSection(a, 'entry', (s) => ({ ...s, loopStart: 8 })))).toMatch(/entry loops from bar 8/);
    expect(problem(withSection(a, 'entry', (s) => ({ ...s, cutsBar: true })))).toMatch(/entry cutsBar is true/);
    expect(problem(withSection(a, 'panic', (s) => ({ ...s, cutsBar: false })))).toMatch(/panic cutsBar is false/);
    expect(problem(withSection(a, 'travel', (s) => ({ ...s, padDetuneCents: 20 })))).toMatch(/travel detunes the pad/);
    expect(problem(withSection(a, 'travel', (s) => ({ ...s, level: { from: 1, to: 1.5 } })))).toMatch(/travel level/);
    expect(problem(withNote(a, 'travel', 'lead', note(0, 4, 65)))).toMatch(/the lead plays in travel/);
    expect(problem(withNote(a, 'entry', 'kick', note(0, 4, 36)))).toMatch(/the kick plays in entry/);
    expect(problem(withNote(a, 'crossing', 'kick', note(0, 4, 36)))).toMatch(/the kick plays in crossing/);
    expect(problem(withNote(a, 'debrief', 'kick', note(0, 4, 36)))).toMatch(/the kick plays in debrief/);
    expect(problem(withNote(a, 'travel', 'arp', note(255, 2, 60)))).toMatch(/travel\.arp\[0\] runs past the section/);
    expect(problem(withNote(a, 'travel', 'arp', note(256, 1, 60)))).toMatch(/starts at step 256 of 256/);
    expect(problem(withNote(a, 'travel', 'arp', note(0, 0, 60)))).toMatch(/has length 0/);
    expect(problem(withNote(a, 'travel', 'arp', note(0, 1, 128)))).toMatch(/has midi 128/);
    expect(problem(withNote(a, 'travel', 'arp', note(0, 1, 60, 1.2)))).toMatch(/has velocity 1.2/);
    expect(problem(withNote(a, 'travel', 'arp', note(0, 1, 60, 0.5, -0.1)))).toMatch(/has cutoff -0.1/);
    expect(problem(withSection(a, 'loss', (s) => ({ ...s, body: { kind: 'patterns', parts: { ...emptyParts(), pad: [note(0, 64, 53)] } } })))).toMatch(/loss has no lead/);
    expect(problem(withSection(a, 'travel', (s) => ({ ...s, body: { kind: 'patterns', parts: emptyParts() } })))).toMatch(/travel has no kick/);
    const missing = { ...a, sections: { ...a.sections } } as { sections: Partial<Record<SectionId, Section>> };
    delete missing.sections.debrief;
    expect(problem(missing as Arrangement)).toMatch(/section debrief is missing/);
  });

  it('validate: a buffer section is structurally valid and carries no patterns to check', () => {
    const fake = new FakeContext();
    const buffer = fake.createBuffer(2, 48000, 48000);
    const a = withSection(minimal(), 'travel', (s) => ({ ...s, body: { kind: 'buffer', buffer } }));
    expect(validateArrangement(a)).toEqual([]);
    expect(a.sections.travel.body.kind).toBe('buffer');
  });
});

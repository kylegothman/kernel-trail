import { describe, expect, it } from 'vitest';
import { createRng } from '@kernel/rng';
import { generateBuffers } from '../../src/audio/buffers';
import { uploadBuffers } from '../../src/audio/graph';
import { VoiceAllocator } from '../../src/audio/VoiceBudget';
import type { NodeLike } from '../../src/audio/context';
import type { Voice, VoiceHost } from '../../src/audio/voices/Voice';
import { ToneVoice } from '../../src/audio/voices/ToneVoice';
import { DroneVoice } from '../../src/audio/voices/DroneVoice';
import { ImpactVoice, IMPACT_PRESETS } from '../../src/audio/voices/ImpactVoice';
import { MIN_EXP_TARGET } from '../../src/audio/synth/constants';
import { midiToHz } from '../../src/audio/synth/tuning';
import {
  CROSSING_LOOP_START, SECTION_BARS, STEPS_PER_BAR, barSeconds, cutoffHz, emptyParts, stepSeconds,
  type Arrangement, type Note, type PartId, type Section, type SectionId,
} from '../../src/audio/score/Arrangement';
import {
  LATE_STEP_TOLERANCE_SECONDS, LOOKAHEAD_SECONDS, SCHEDULE_INTERVAL_MS, Sequencer,
  type BarInfo, type SequencerHost, type Voicing,
} from '../../src/audio/score/Sequencer';
import { FakeContext, type FakeNode, type FakeParam } from './fakeContext';

const SEED = 0x4b54524c;
const SHORT = { attack: 0.003, decay: 0.04, sustain: 0.4, release: 0.04 };
const PAD = { attack: 0.25, decay: 0, sustain: 1, release: 0.35 };

const note = (step: number, length: number, midi: number, velocity = 0.8, cutoff = 0.5): Note => ({ step, length, midi, velocity, cutoff });

/**
 * A voicing over the WP-16 kinds, so the sequencer's mechanics are tested
 * without the section 3 voices: the kick is an impact, the pad a drone, the
 * rest tones.
 */
const tone = (gain: number): Voicing[PartId] => ({
  kind: 'tone', adsr: SHORT,
  patch: (n, _c, out) => { out.hz = midiToHz(n.midi); out.hz2 = out.hz; out.gain = gain * n.velocity; out.adsr = SHORT; out.filterHz = cutoffHz(n.cutoff); out.q = 2; },
});
const TEST_VOICING: Voicing = {
  kick: { kind: 'impact', adsr: SHORT, patch: (n, _c, out) => { out.impact = IMPACT_PRESETS.minor; out.gain = n.velocity; } },
  bass: tone(0.3),
  chords: tone(0.2),
  arp: tone(0.15),
  lead: tone(0.25),
  pad: { kind: 'drone', adsr: PAD, patch: (n, _c, out) => { out.hz = midiToHz(n.midi); out.gain = 0.2 * n.velocity; out.adsr = PAD; } },
};

/** A full arrangement with plain patterns: four kicks a bar, bass eighths, a chord a bar, sixteenth arps, a pad every four bars. */
function fixture(tempo = 120, swing = 0.5): Arrangement {
  const section = (id: SectionId, fill: (parts: Record<PartId, Note[]>, bars: number) => void, extra: Partial<Section> = {}): Section => {
    const bars = SECTION_BARS[id];
    const parts = emptyParts();
    fill(parts, bars);
    return { id, bars, loopStart: 0, cutsBar: false, level: { from: 1, to: 1 }, padDetuneCents: 0, body: { kind: 'patterns', parts }, ...extra };
  };
  const beat = (parts: Record<PartId, Note[]>, bars: number): void => {
    for (let b = 0; b < bars; b++) {
      for (const s of [0, 4, 8, 12]) parts.kick.push(note(b * STEPS_PER_BAR + s, 4, 36, 1));
      for (let s = 0; s < STEPS_PER_BAR; s += 2) parts.bass.push(note(b * STEPS_PER_BAR + s, 2, 41));
    }
  };
  const chords = (parts: Record<PartId, Note[]>, bars: number, every = 1): void => {
    for (let b = 0; b < bars; b += every) for (const m of [57, 60, 64, 67]) parts.chords.push(note(b * STEPS_PER_BAR, STEPS_PER_BAR * every, m, 0.7, b / bars));
  };
  const arp = (parts: Record<PartId, Note[]>, from: number, to: number, length: number): void => {
    for (let b = from; b < to; b++) for (let s = 0; s < STEPS_PER_BAR; s += length) parts.arp.push(note(b * STEPS_PER_BAR + s, length, 69 + (s % 4) * 3, 0.6, b / to));
  };
  const pad = (parts: Record<PartId, Note[]>, bars: number, every = 4): void => {
    for (let b = 0; b < bars; b += every) parts.pad.push(note(b * STEPS_PER_BAR, STEPS_PER_BAR * Math.min(every, bars - b), 53, 0.8));
  };
  const lead = (parts: Record<PartId, Note[]>): void => {
    for (const [i, m] of [65, 67, 69, 64].entries()) parts.lead.push(note(i * STEPS_PER_BAR, 12, m, 0.7));
  };
  return {
    rootMidi: 41, mode: 'major', tempo, swing,
    sections: {
      entry: section('entry', (p, bars) => { pad(p, bars, 8); chords(p, bars, 8); }),
      travel: section('travel', (p, bars) => { beat(p, bars); chords(p, bars); arp(p, 0, bars, 1); pad(p, bars); }),
      crossing: section('crossing', (p, bars) => { chords(p, bars, 2); pad(p, bars); arp(p, CROSSING_LOOP_START, bars, 2); }, { loopStart: CROSSING_LOOP_START }),
      resolve_good: section('resolve_good', (p, bars) => { beat(p, bars); chords(p, bars, 2); }),
      resolve_bad: section('resolve_bad', (p, bars) => { beat(p, bars); chords(p, bars, 2); }),
      loss: section('loss', (p, bars) => { pad(p, bars); lead(p); }),
      panic: section('panic', (p, bars) => { pad(p, bars); }, { cutsBar: true, level: { from: 1, to: 0 }, padDetuneCents: 60 }),
      debrief: section('debrief', (p, bars) => { chords(p, bars, 2); pad(p, bars); lead(p); }),
    },
  };
}

interface Rig {
  readonly fake: FakeContext;
  readonly allocator: VoiceAllocator;
  readonly sequencer: Sequencer;
  readonly bus: FakeNode;
  /** Every acquisition the sequencer made: the onset it asked for and the kind. */
  readonly acquired: { onset: number; kind: string }[];
  /** Every patch the sequencer ran, in the same order as `acquired`. */
  readonly patched: { part: PartId; section: SectionId; step: number }[];
  voices(): readonly Voice[];
}

/** A pool of WP-16 voices over the fake, with the sequencer's trim as the score bus. */
function makeRig(options: { voicing?: Voicing; envelopeScale?: number; tones?: number; drones?: number } = {}): Rig {
  const fake = new FakeContext();
  const buffers = uploadBuffers(fake, generateBuffers(SEED), 'low');
  const bus = fake.createGain();
  let scoreInput: NodeLike = bus;
  const host: VoiceHost = { ctx: fake, buffers, busInput: () => scoreInput, envelopeScale: options.envelopeScale ?? 1, mono: false, rng: createRng(SEED, 'audio').fork('runtime') };
  const allocator = new VoiceAllocator(16);
  const make = (n: number, factory: () => Voice): void => { for (let i = 0; i < n; i++) { const v = factory(); v.warmUp(0); allocator.register(v); } };
  make(options.tones ?? 8, () => new ToneVoice(host));
  make(options.drones ?? 3, () => new DroneVoice(host));
  make(2, () => new ImpactVoice(host));
  const acquired: Rig['acquired'] = [];
  const patched: Rig['patched'] = [];
  const base = options.voicing ?? TEST_VOICING;
  const voicing = Object.fromEntries((Object.keys(base) as PartId[]).map((part) => [part, {
    ...base[part],
    patch: (n: Note, c: Parameters<Voicing[PartId]['patch']>[1], out: Parameters<Voicing[PartId]['patch']>[2]) => { patched.push({ part, section: c.section.id, step: n.step }); base[part].patch(n, c, out); },
  }])) as unknown as Voicing;
  const originalAcquire = allocator.acquire.bind(allocator);
  allocator.acquire = (kind, b, now, exempt) => { acquired.push({ onset: now, kind }); return originalAcquire(kind, b, now, exempt); };
  const seqHost: SequencerHost = { ctx: fake, allocator, voicing, envelopeScale: options.envelopeScale ?? 1, scoreBus: bus };
  const sequencer = new Sequencer(seqHost);
  scoreInput = sequencer.trim;
  return { fake, allocator, sequencer, bus, acquired, patched, voices: () => allocator.all() };
}

/** Pump the sequencer on the real-time cadence from `from` to `to`, advancing the fake clock. */
function run(rig: Rig, from: number, to: number): void {
  const dt = SCHEDULE_INTERVAL_MS / 1000;
  for (let t = from; t < to; t += dt) {
    rig.fake.currentTime = t;
    rig.sequencer.pump(t);
  }
  rig.fake.currentTime = to;
  rig.sequencer.pump(to);
}

const gainOf = (v: Voice): FakeParam => v.level as unknown as FakeParam;

describe('sequencer', () => {
  it('lookahead: a pump schedules only the steps within 120 ms of now, and never a step twice', () => {
    const rig = makeRig();
    const a = fixture(120);
    expect(rig.sequencer.start(a, 'travel', 1)).toBe('ok');
    rig.sequencer.pump(1);
    const first = rig.acquired.length;
    expect(first).toBeGreaterThan(0);
    expect(Math.max(...rig.acquired.map((x) => x.onset))).toBeLessThanOrEqual(1 + LOOKAHEAD_SECONDS);
    expect(rig.sequencer.frontier).toBeGreaterThanOrEqual(1 + LOOKAHEAD_SECONDS);
    rig.sequencer.pump(1);
    expect(rig.acquired.length).toBe(first);
    rig.sequencer.pump(1.5);
    expect(rig.acquired.length).toBeGreaterThan(first);
    for (const x of rig.acquired) expect(x.onset).toBeLessThanOrEqual(1.5 + LOOKAHEAD_SECONDS);
    const onsets = rig.acquired.map((x) => x.onset);
    for (let i = 1; i < onsets.length; i++) expect(onsets[i]).toBeGreaterThanOrEqual(onsets[i - 1] ?? 0);
    expect(rig.sequencer.stats.notes).toBe(rig.acquired.length - rig.sequencer.stats.unplaced);
  });

  it('bar line: a change answered by the bar hook begins exactly on the bar line and never inside one', () => {
    const rig = makeRig();
    const a = fixture(120);
    const bar = barSeconds(a);
    let wanted: SectionId | null = null;
    const infos: BarInfo[] = [];
    rig.sequencer.onBar = (info) => { infos.push(info); return wanted; };
    rig.sequencer.start(a, 'travel', 0);
    run(rig, 0, 0.7);
    wanted = 'crossing';
    run(rig, 0.7, 5);
    const rows = rig.patched.map((p, i) => ({ ...p, onset: rig.acquired[i]?.onset ?? -1 }));
    const crossing = rows.filter((r) => r.section === 'crossing');
    const travel = rows.filter((r) => r.section === 'travel');
    expect(crossing.length).toBeGreaterThan(0);
    expect(Math.min(...crossing.map((r) => r.onset))).toBeCloseTo(bar, 9);
    expect(Math.max(...travel.map((r) => r.onset))).toBeLessThan(bar);
    expect(rig.sequencer.current).toBe('crossing');
    expect(rig.sequencer.stats.changes).toBe(1);
    const change = infos.find((i) => i.section === 'travel' && i.barInSection === 1);
    expect(change?.time).toBeCloseTo(bar, 9);
    // The request arrived 700 ms into bar 0, well inside the bar, and nothing moved until the line.
    expect(rows.some((r) => r.section === 'crossing' && r.onset < bar)).toBe(false);
  });

  it('follow-on: the hook is asked when a section ends, null loops it, and a loop resumes from loopStart', () => {
    const rig = makeRig();
    const a = fixture(120);
    const bar = barSeconds(a);
    const infos: BarInfo[] = [];
    rig.sequencer.onBar = (info) => { infos.push(info); return info.section === 'entry' && info.barInSection === info.bars ? 'crossing' : null; };
    rig.sequencer.start(a, 'entry', 0);
    const total = (8 + 16 + 8 + 8) * bar;
    run(rig, 0, total + 0.5);
    const entry = infos.filter((i) => i.section === 'entry');
    expect(entry.map((i) => i.barInSection)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(entry[8]?.time).toBeCloseTo(8 * bar, 9);
    const crossing = infos.filter((i) => i.section === 'crossing');
    // The hook is asked once per bar line: the line that chose the crossing is not asked again for its bar zero,
    // so the first pass reads 1 to 15, then the end-of-section question at 16, then the loop resumes from bar
    // eight and the next question is bar nine.
    expect(crossing.slice(0, 16).map((i) => i.barInSection)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(crossing.slice(16, 24).map((i) => i.barInSection)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
    expect(crossing[15]?.time).toBeCloseTo((8 + 16) * bar, 9);
    expect(crossing[16]?.time).toBeCloseTo((8 + 16 + 1) * bar, 9);
    // The arp is silent for the first eight bars of the crossing and enters on the second pass.
    const rows = rig.patched.map((p, i) => ({ ...p, onset: rig.acquired[i]?.onset ?? -1 }));
    const arps = rows.filter((r) => r.section === 'crossing' && r.part === 'arp');
    expect(arps.length).toBeGreaterThan(0);
    expect(Math.min(...arps.map((r) => r.onset))).toBeCloseTo((8 + 8) * bar, 9);
    expect(rig.sequencer.current).toBe('crossing');
    expect(rig.sequencer.stats.changes).toBe(1);
  });

  it('panic cuts mid-bar: everything but the pad stops at the event, the pad holds, detunes and decays over four bars', () => {
    const rig = makeRig();
    const a = fixture(120);
    const bar = barSeconds(a);
    rig.sequencer.onBar = (info) => (info.section === 'panic' && info.barInSection === info.bars ? 'end' : null);
    rig.sequencer.start(a, 'travel', 0);
    run(rig, 0, 3);
    const at = 3.05;
    const before = rig.patched.length;
    const busyBefore = rig.voices().filter((v) => v.busy);
    expect(busyBefore.length).toBeGreaterThan(3);
    expect(rig.sequencer.cut(at)).toBe('ok');
    expect(rig.sequencer.current).toBe('panic');
    expect(rig.sequencer.stats.cuts).toBe(1);
    for (const v of busyBefore) {
      if (v instanceof DroneVoice) {
        expect(v.busy).toBe(true);
        expect(v.finishAt).toBeCloseTo(at + 4 * bar, 9);
        const detune = rig.fake.params.find((p) => p.name === 'detune' && p.owner.kind === 'oscillator' && p.events.some((e) => e.kind === 'linear' && e.value === 60));
        expect(detune).toBeDefined();
        expect(detune?.events.find((e) => e.kind === 'linear' && e.value === 60)?.time).toBeCloseTo(at + 4 * bar, 9);
        expect(gainOf(v).valueAt(at + 1)).toBeGreaterThan(0.1);
      } else {
        expect(v.busy).toBe(false);
        expect(gainOf(v).valueAt(at + 0.2)).toBeLessThan(0.002);
      }
    }
    const trim = rig.sequencer.trim.gain as unknown as FakeParam;
    expect(trim.valueAt(at)).toBeCloseTo(1, 6);
    expect(trim.valueAt(at + 2 * bar)).toBeCloseTo(0.5, 3);
    expect(trim.valueAt(at + 4 * bar)).toBeCloseTo(0, 6);
    run(rig, at, at + 4 * bar + 0.5);
    // The panic section's own pad notes are not scheduled over the pad it kept.
    expect(rig.patched.slice(before).filter((p) => p.part === 'pad').length).toBe(0);
    expect(rig.patched.slice(before).filter((p) => p.part !== 'pad').length).toBe(0);
    expect(rig.sequencer.playing).toBe(false);
    expect(rig.voices().filter((v) => v.busy).length).toBe(0);
  });

  it('panic standalone: with no pad sounding, the panic section plays its own pad', () => {
    const rig = makeRig();
    const a = fixture(120);
    expect(rig.sequencer.start(a, 'panic', 2, { keepPad: true })).toBe('ok');
    run(rig, 2, 3);
    expect(rig.patched.filter((p) => p.part === 'pad').length).toBe(1);
    const drone = rig.voices().find((v) => v instanceof DroneVoice && v.busy);
    expect(drone).toBeDefined();
    const detune = rig.fake.params.find((p) => p.name === 'detune' && p.events.some((e) => e.kind === 'linear' && e.value === 60));
    expect(detune?.events.find((e) => e.kind === 'linear' && e.value === 60)?.time).toBeCloseTo(2 + 4 * barSeconds(a), 9);
  });

  it('swing: the odd sixteenths of every pair are late by twice the excess over a half', () => {
    const rig = makeRig();
    const a = fixture(120, 0.54);
    const step = stepSeconds(a);
    rig.sequencer.start(a, 'travel', 0);
    run(rig, 0, 1);
    const arps = rig.patched.map((p, i) => ({ ...p, onset: rig.acquired[i]?.onset ?? -1 })).filter((r) => r.part === 'arp' && r.step < 8);
    expect(arps.map((r) => r.onset)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((s) => s * step + (s % 2 === 1 ? 0.08 * step : 0)));
    expect((arps[1]?.onset ?? 0) - step).toBeCloseTo(0.01, 9);
    // The kick, on the beats, is never swung.
    const kicks = rig.patched.map((p, i) => ({ ...p, onset: rig.acquired[i]?.onset ?? -1 })).filter((r) => r.part === 'kick');
    for (const k of kicks) expect(k.onset % (4 * step)).toBeCloseTo(0, 9);
  });

  it('buffer: a section whose body is a buffer is refused by name', () => {
    const rig = makeRig();
    const a = fixture(120);
    const buffer = rig.fake.createBuffer(2, 48000, 48000);
    const withBuffer: Arrangement = { ...a, sections: { ...a.sections, travel: { ...a.sections.travel, body: { kind: 'buffer', buffer } } } };
    expect(rig.sequencer.start(withBuffer, 'travel', 0)).toBe('not implemented');
    expect(rig.sequencer.playing).toBe(false);
    expect(rig.sequencer.stats.refused).toBe(1);
    rig.sequencer.onBar = (info) => (info.barInSection === info.bars ? 'travel' : null);
    expect(rig.sequencer.start(withBuffer, 'entry', 0)).toBe('ok');
    run(rig, 0, 9 * barSeconds(a));
    expect(rig.sequencer.stats.refused).toBe(2);
    expect(rig.sequencer.current).toBe('entry');
    expect(rig.sequencer.stats.changes).toBe(0);
  });

  it('allocator: every note goes through the allocator, exempt on the score bus with layer set, and releases fit inside notes', () => {
    const rig = makeRig();
    const a = fixture(120);
    rig.sequencer.start(a, 'travel', 0);
    run(rig, 0, 4 * barSeconds(a));
    // Thirty-two notes a bar in the fixture, four bars, plus the lookahead's first steps of bar five.
    expect(rig.acquired.length).toBeGreaterThan(120);
    expect(rig.sequencer.stats.notes + rig.sequencer.stats.unplaced).toBe(rig.acquired.length);
    expect(rig.sequencer.stats.unplaced).toBe(0);
    for (const v of rig.voices()) {
      if (!v.busy && v.finishAt === Number.POSITIVE_INFINITY) continue;
      expect(v.bus).toBe('score');
      expect(v.layer).toBe(true);
      if (v.busy) expect(v.exempt).toBe(true);
    }
    for (const v of rig.voices()) {
      if (v instanceof DroneVoice || v instanceof ImpactVoice) continue;
      const events = [...gainOf(v).events].sort((x, y) => x.time - y.time);
      for (const [i, e] of events.entries()) {
        if (e.kind !== 'set' || e.value !== MIN_EXP_TARGET || i === 0) continue;
        const previous = events[i - 1];
        // The event before a note's start is the previous note's release, ended at or before it.
        // A release that ends exactly at the next onset is truncated there by the fake, with rounding in its last digit.
        expect(previous?.value ?? 1, `voice at ${e.time}`).toBeLessThanOrEqual(MIN_EXP_TARGET * (1 + 1e-9));
        expect(previous?.time ?? 0).toBeLessThanOrEqual(e.time + 1e-9);
      }
    }
    for (const v of rig.voices()) if (v instanceof DroneVoice && v.busy) expect(v.finishAt - v.startedAt).toBeCloseTo(4 * barSeconds(a), 9);
  });

  it('budget: a dense travel section never has more voices sounding than the pool holds', () => {
    const rig = makeRig({ tones: 3, drones: 1 });
    const a = fixture(126);
    rig.sequencer.start(a, 'travel', 0);
    const dt = SCHEDULE_INTERVAL_MS / 1000;
    for (let t = 0; t < 2 * barSeconds(a); t += dt) {
      rig.fake.currentTime = t;
      rig.sequencer.pump(t);
      expect(rig.allocator.busyCount(t)).toBeLessThanOrEqual(rig.allocator.size);
    }
    expect(rig.allocator.stats.peak).toBeLessThanOrEqual(rig.allocator.size);
    // Three tone voices cannot hold a four-note chord, an arp and a bass at once: the overflow is dropped, never stolen.
    expect(rig.sequencer.stats.notes + rig.sequencer.stats.unplaced).toBeGreaterThan(50);
    expect(rig.sequencer.stats.notes).toBeGreaterThan(20);
    expect(rig.sequencer.stats.unplaced).toBeGreaterThan(0);
    expect(rig.allocator.stats.stolen).toBe(0);
  });

  it('stop and fade: fadeOut ramps the trim to zero over the bar and then stops; dispose disconnects the trim', () => {
    const rig = makeRig();
    const a = fixture(120);
    const bar = barSeconds(a);
    rig.sequencer.start(a, 'travel', 0);
    run(rig, 0, 1);
    rig.sequencer.fadeOut(1, bar);
    expect(rig.sequencer.isFading).toBe(true);
    const trim = rig.sequencer.trim.gain as unknown as FakeParam;
    expect(trim.valueAt(1)).toBeCloseTo(1, 6);
    expect(trim.valueAt(1 + bar / 2)).toBeCloseTo(0.5, 3);
    expect(trim.valueAt(1 + bar)).toBeCloseTo(0, 6);
    run(rig, 1, 1 + bar + 0.5);
    expect(rig.sequencer.playing).toBe(false);
    for (const v of rig.voices()) expect(v.busy).toBe(false);
    const lastOnset = Math.max(...rig.acquired.map((x) => x.onset));
    expect(lastOnset).toBeLessThan(1 + bar);
    const trimNode = rig.sequencer.trim as unknown as FakeNode;
    expect(trimNode.connections.has(rig.bus)).toBe(true);
    rig.sequencer.dispose();
    expect(trimNode.released).toBe(true);
    expect(rig.sequencer.start(a, 'travel', 5)).toBe('ok');
    expect(rig.sequencer.playing).toBe(false);
  });

  it('late steps: when the frontier falls behind the clock, missed steps are skipped rather than fired late', () => {
    const rig = makeRig();
    const a = fixture(120);
    rig.sequencer.start(a, 'travel', 0);
    rig.sequencer.pump(0);
    const early = rig.acquired.length;
    rig.fake.currentTime = 2;
    rig.sequencer.pump(2);
    expect(rig.sequencer.stats.lateSteps).toBeGreaterThan(10);
    const late = rig.acquired.slice(early).map((x) => x.onset);
    expect(late.length).toBeGreaterThan(0);
    expect(Math.min(...late)).toBeGreaterThanOrEqual(2 - LATE_STEP_TOLERANCE_SECONDS - 1e-9);
    expect(Math.max(...late)).toBeLessThanOrEqual(2 + LOOKAHEAD_SECONDS);
  });

  it('grid: nextStepTime and nextBarTime land on the grid, and are now when nothing plays', () => {
    const rig = makeRig();
    const a = fixture(120);
    expect(rig.sequencer.nextStepTime(3.3)).toBe(3.3);
    expect(rig.sequencer.nextBarTime(3.3)).toBe(3.3);
    rig.sequencer.start(a, 'travel', 1);
    const step = stepSeconds(a);
    expect(rig.sequencer.nextStepTime(1)).toBeCloseTo(1, 9);
    expect(rig.sequencer.nextStepTime(1.01)).toBeCloseTo(1 + step, 9);
    expect(rig.sequencer.nextStepTime(1 + step)).toBeCloseTo(1 + step, 9);
    expect(rig.sequencer.nextBarTime(1.01)).toBeCloseTo(1 + barSeconds(a), 9);
    expect(rig.sequencer.nextBarTime(0.5)).toBeCloseTo(1, 9);
  });

  it('mute: muted parts stop being scheduled until the next section change', () => {
    const rig = makeRig();
    const a = fixture(120);
    const bar = barSeconds(a);
    rig.sequencer.onBar = (info) => (info.section === 'travel' && info.barInSection === 2 ? 'loss' : null);
    rig.sequencer.start(a, 'travel', 0);
    run(rig, 0, 0.5);
    rig.sequencer.mute(['kick', 'arp']);
    const before = rig.patched.length;
    run(rig, 0.5, 2 * bar - 0.05);
    const muted = rig.patched.slice(before);
    expect(muted.length).toBeGreaterThan(0);
    expect(muted.some((p) => p.part === 'kick' || p.part === 'arp')).toBe(false);
    expect(muted.some((p) => p.part === 'bass')).toBe(true);
    run(rig, 2 * bar - 0.05, 2 * bar + 1);
    expect(rig.sequencer.current).toBe('loss');
    const loss = rig.patched.filter((p) => p.section === 'loss');
    expect(loss.some((p) => p.part === 'lead')).toBe(true);
    expect(loss.some((p) => p.part === 'pad')).toBe(true);
  });

  it('reduced motion: the hold shrinks so the halved envelope still fits the note', () => {
    const full = makeRig();
    const halved = makeRig({ envelopeScale: 0.5 });
    const a = fixture(120);
    full.sequencer.start(a, 'travel', 0);
    halved.sequencer.start(a, 'travel', 0);
    full.sequencer.pump(0);
    halved.sequencer.pump(0);
    const bassOf = (rig: Rig): Voice | undefined => rig.voices().find((v) => v instanceof ToneVoice && v.busy && Math.abs(gainOf(v).events.find((e) => e.kind === 'exp')!.value - 0.3 * 0.8) < 1e-9);
    const f = bassOf(full);
    const h = bassOf(halved);
    expect(f).toBeDefined();
    expect(h).toBeDefined();
    expect(f!.finishAt - f!.startedAt).toBeCloseTo(2 * stepSeconds(a), 9);
    expect(h!.finishAt - h!.startedAt).toBeCloseTo(2 * stepSeconds(a), 9);
  });
});

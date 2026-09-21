import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../kernel/sourceScan';
import { VOICE_KINDS } from '../../src/audio/voices/Voice';
import { POOL_SPLIT } from '../../src/audio/VoiceBudget';
import { ToneVoice } from '../../src/audio/voices/ToneVoice';
import { ImpactVoice, IMPACT_CHARACTER } from '../../src/audio/voices/ImpactVoice';
import { GranularVoice } from '../../src/audio/voices/GranularVoice';
import { rampExp, applyOneShot, RampTracker } from '../../src/audio/synth/envelope';
import { pitchHz, pitchForPid, midiToHz, DEFAULT_ROOT_MIDI } from '../../src/audio/synth/tuning';
import { GRAIN, MIN_EXP_TARGET } from '../../src/audio/synth/constants';
import { EASE } from '@design/motion';
import { FakeParam, FakeNode, type FakeOscillator } from './fakeContext';
import { GLOBAL_EVENTS, makeRig, randomEvents, resetSequence, REASONS } from './helpers';

describe('voices', () => {
  it('eight voice types: WP-16 tone, noise, impact, drone, granular and WP-25 chord, kick, lead', () => {
    expect([...VOICE_KINDS].sort()).toEqual(['chord', 'drone', 'granular', 'impact', 'kick', 'lead', 'noise', 'tone']);
    const { engine } = makeRig('low');
    const kinds = new Set(engine.voices().map((v) => v.kind));
    expect([...kinds].sort()).toEqual(['chord', 'drone', 'granular', 'impact', 'kick', 'lead', 'noise', 'tone']);
    for (const kind of VOICE_KINDS) expect(POOL_SPLIT.low[kind], kind).toBeGreaterThan(0);
  });

  it('release: live node count returns to the pool baseline after 1,000 start and stop cycles and to zero after dispose', () => {
    const { engine, fake } = makeRig('low');
    const tone = engine.voices().find((v): v is ToneVoice => v instanceof ToneVoice);
    if (tone === undefined) throw new Error('no tone voice');
    tone.bus = 'world';
    // The first start attaches the panner to its bus; that connection is the pool baseline.
    tone.start(0, { hz: 220, gain: 0.3, pan: 0 });
    tone.stop(0.001);
    const baseline = fake.liveNodeCount;
    for (let i = 0; i < 1000; i++) {
      tone.start(i * 0.01, { hz: 220, gain: 0.3, pan: 0 });
      tone.stop(i * 0.01 + 0.005);
    }
    expect(fake.liveNodeCount).toBe(baseline);
    expect(fake.nodeConstructions).toBe(fake.nodes.length);
    engine.dispose();
    expect(fake.liveNodeCount).toBe(0);
    for (const node of fake.nodes) expect(node.released, node.kind).toBe(true);
  });

  it('no construction after warmup: zero AudioNode constructions over 10,000 events', () => {
    resetSequence();
    const rig = makeRig('medium');
    const warm = rig.fake.nodeConstructions;
    const events = randomEvents(10_000, 11, 0, GLOBAL_EVENTS);
    for (let i = 0; i < events.length; i += 8) rig.frame(events.slice(i, i + 8));
    rig.engine.ui.focusEngage();
    rig.engine.ui.focusRelease();
    rig.frame();
    expect(rig.fake.nodeConstructions).toBe(warm);
    expect(rig.fake.buffersCreated).toBe(4);
    expect(rig.engine.bank.stats.played).toBeGreaterThan(1000);
  });

  it('envelope zero guard: the helper clamps to 1e-4 where the raw call would throw', () => {
    const node = new FakeNode(undefined as never, 'gain', 99);
    const param = new FakeParam(node, 'gain', 1);
    expect(() => param.exponentialRampToValueAtTime(0, 1)).toThrow();
    expect(() => rampExp(param, 0, 1)).not.toThrow();
    expect(() => rampExp(param, -3, 2)).not.toThrow();
    expect(param.events.every((e) => e.value >= MIN_EXP_TARGET)).toBe(true);
    expect(() => rampExp(param, Number.NaN, 3)).toThrow();
    const end = applyOneShot(param, 5, { attack: 0.01, decay: 0.05, sustain: 0, release: 0.1 }, 1, 0.1, 1);
    expect(end).toBeGreaterThan(5.2);
    expect(param.events.filter((e) => e.kind === 'exp').every((e) => e.value >= MIN_EXP_TARGET)).toBe(true);
    const files = walkTs('src/audio');
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'), false);
      const calls = code.match(/\.exponentialRampToValueAtTime\s*\(/g) ?? [];
      if (file.endsWith('synth/envelope.ts')) expect(calls.length).toBe(1);
      else expect(calls.length, file).toBe(0);
    }
  });

  it('tuning computed: pitches derive from a root and a mode, and transposing moves every pitch by one ratio', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 6);
    expect(pitchHz(DEFAULT_ROOT_MIDI, 0)).toBeCloseTo(110, 3);
    const degrees = [0, 1, 2, 3, 4, 5, 9, 14, -1, -3];
    const ratio = Math.pow(2, 2 / 12);
    for (const d of degrees) {
      expect(pitchHz(DEFAULT_ROOT_MIDI + 2, d) / pitchHz(DEFAULT_ROOT_MIDI, d)).toBeCloseTo(ratio, 9);
    }
    expect(pitchHz(DEFAULT_ROOT_MIDI, 5) / pitchHz(DEFAULT_ROOT_MIDI, 0)).toBeCloseTo(2, 9);
    expect(pitchForPid(DEFAULT_ROOT_MIDI, 3)).not.toBe(pitchForPid(DEFAULT_ROOT_MIDI, 4));
    expect(pitchForPid(DEFAULT_ROOT_MIDI, 3)).toBe(pitchForPid(DEFAULT_ROOT_MIDI, 13));
  });

  it('impact character: each of the ten TerminationReasons produces a distinct parameter set and distinct automation', () => {
    expect(Object.keys(IMPACT_CHARACTER).sort()).toEqual([...REASONS].sort());
    const sets = new Set(REASONS.map((r) => JSON.stringify(IMPACT_CHARACTER[r])));
    expect(sets.size).toBe(10);
    const { engine, fake } = makeRig('low');
    const impact = engine.voices().find((v): v is ImpactVoice => v instanceof ImpactVoice);
    if (impact === undefined) throw new Error('no impact voice');
    const signatures = new Set<string>();
    for (const reason of REASONS) {
      for (const p of fake.params) p.events.length = 0;
      impact.bus = 'world';
      impact.start(1, { impact: IMPACT_CHARACTER[reason], gain: 1, pan: 0 });
      const thump = fake.nodes.find((n): n is FakeOscillator => n.kind === 'oscillator' && n.params.some((p) => p.events.length > 0));
      const signature = JSON.stringify(fake.automation((p) => p.events.length > 0).map(({ param, event }) => [param.name, event.kind, Math.round(event.value * 1000), Math.round(event.time * 1000)]));
      expect(thump).toBeDefined();
      signatures.add(signature);
      impact.stop(2);
    }
    expect(signatures.size).toBe(10);
  });

  it('granular density: grain count scales with intensity and stops at the slot cap', () => {
    const { engine, fake } = makeRig('low');
    const granular = engine.voices().find((v): v is GranularVoice => v instanceof GranularVoice);
    if (granular === undefined) throw new Error('no granular voice');
    granular.bus = 'world';
    granular.start(0, { intensity: 0.25, gain: 0.3, pan: 0 });
    expect(granular.activeGrains).toBe(1);
    granular.setDensity(0.5, 0);
    expect(granular.activeGrains).toBe(2);
    granular.setDensity(1, 0);
    expect(granular.activeGrains).toBe(GRAIN.slotsPerVoice);
    granular.setDensity(5, 0);
    expect(granular.activeGrains).toBe(GRAIN.slotsPerVoice);
    const before = granular.scheduledGrainCount;
    granular.scheduleUntil(1);
    const perSecondAtFull = granular.scheduledGrainCount - before;
    expect(perSecondAtFull).toBeGreaterThan(20);
    granular.setDensity(0.1, 1);
    granular.scheduleUntil(2);
    const perSecondAtLow = granular.scheduledGrainCount - before - perSecondAtFull;
    expect(perSecondAtLow).toBeLessThan(perSecondAtFull / 3);
    const rates = fake.params.filter((p) => p.name === 'playbackRate' && p.events.length > 0);
    expect(rates.length).toBe(GRAIN.slotsPerVoice);
    expect(fake.nodeConstructions).toBe(fake.nodes.length);
    granular.setDensity(0, 2);
    granular.scheduleUntil(3);
    expect(granular.activeGrains).toBe(0);
  });

  it('ramp tracker models an eased curve the fake evaluates to the same values', () => {
    const node = new FakeNode(undefined as never, 'gain', 1);
    const param = new FakeParam(node, 'gain', 0);
    const tracker = new RampTracker(0, EASE.settle);
    tracker.rampTo(param, 0.5, 1, 0.42);
    for (const t of [1, 1.1, 1.2, 1.3, 1.42, 2]) {
      expect(param.valueAt(t)).toBeCloseTo(tracker.valueAt(t), 3);
    }
    tracker.rampTo(param, 0.1, 1.2, 0.42);
    expect(param.valueAt(1.2)).toBeCloseTo(tracker.valueAt(1.2), 3);
    expect(param.valueAt(1.62)).toBeCloseTo(0.1, 3);
  });
});

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkTs(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

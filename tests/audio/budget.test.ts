import { describe, expect, it } from 'vitest';
import { asPid } from '@kernel/types';
import type { KernelEvent } from '@kernel/types';
import type { QualityTier } from '@platform/quality';
import { POOL_SPLIT, VOICE_BUDGET, VoiceAllocator } from '../../src/audio/VoiceBudget';
import { ToneVoice } from '../../src/audio/voices/ToneVoice';
import { REDUCED_MOTION_ENVELOPE_SCALE } from '../../src/audio/synth/constants';
import type { FakeParam } from './fakeContext';
import { GLOBAL_EVENTS, ev, makeRig, nextTick, randomEvents, resetSequence } from './helpers';

const TIERS: readonly QualityTier[] = ['low', 'medium', 'high'];

describe('budget', () => {
  it('caps: concurrent voices never exceed the tier cap under a 500-events-per-second burst', () => {
    for (const tier of TIERS) {
      expect(Object.values(POOL_SPLIT[tier]).reduce((a, b) => a + b, 0)).toBe(VOICE_BUDGET[tier]);
      resetSequence();
      const rig = makeRig(tier);
      const allocator = rig.engine.allocator;
      if (allocator === null) throw new Error('no allocator');
      expect(allocator.size).toBe(VOICE_BUDGET[tier]);
      // 500 events per second at 60 fps is 8 or 9 per frame, for two seconds.
      const events = randomEvents(1000, 17).filter((e) => e.type !== 'kernel.panic');
      let peak = 0;
      let i = 0;
      for (let frame = 0; frame < 120 && i < events.length; frame++) {
        const n = frame % 3 === 0 ? 9 : 8;
        rig.frame(events.slice(i, i + n));
        i += n;
        const busy = allocator.busyCount(rig.fake.currentTime);
        expect(busy, tier).toBeLessThanOrEqual(VOICE_BUDGET[tier]);
        peak = Math.max(peak, busy);
      }
      expect(allocator.stats.peak).toBeLessThanOrEqual(VOICE_BUDGET[tier]);
      console.log(`budget ${tier}: cap ${VOICE_BUDGET[tier]}, peak concurrent ${allocator.stats.peak}, stolen ${allocator.stats.stolen}, dropped ${allocator.stats.dropped}`);
    }
  });

  it('steal oldest: over budget, the oldest voice in the same bus is stolen and the newest kept', () => {
    const { engine } = makeRig('low');
    const tones = engine.voices().filter((v): v is ToneVoice => v instanceof ToneVoice);
    expect(tones.length).toBe(POOL_SPLIT.low.tone);
    const allocator = new VoiceAllocator(tones.length);
    for (const t of tones) allocator.register(t);
    const started: ToneVoice[] = [];
    for (let i = 0; i < tones.length; i++) {
      const v = allocator.acquire('tone', i === 2 ? 'ui' : 'world', i + 1);
      if (!(v instanceof ToneVoice)) throw new Error('no voice');
      v.start(i + 1, { hz: 200 + i, gain: 0.2, pan: 0 });
      started.push(v);
    }
    expect(allocator.stats.stolen).toBe(0);
    const stolen = allocator.acquire('tone', 'world', 10);
    expect(allocator.stats.stolen).toBe(1);
    expect(stolen).toBe(started[0]);
    expect(started[1]?.busy).toBe(true);
    expect(started[2]?.busy).toBe(true);
    expect(started[4]?.busy).toBe(true);
    stolen?.start(10, { hz: 300, gain: 0.2, pan: 0 });
    const next = allocator.acquire('tone', 'ui', 11);
    expect(next).toBe(started[2]);
    next?.start(11, { hz: 310, gain: 0.2, pan: 0 });
    const fromAnyBus = allocator.acquire('tone', 'voice_alerts', 12);
    expect(fromAnyBus).toBe(started[1]);
    expect(allocator.stats.stolen).toBe(3);
  });

  it('exempt voices: the alarm layer and the panic impact are never stolen', () => {
    resetSequence();
    const rig = makeRig('low');
    const allocator = rig.engine.allocator;
    const alarm = rig.engine.score?.layerVoice('alarm');
    if (allocator === null || alarm === null || alarm === undefined) throw new Error('missing');
    expect(alarm.exempt).toBe(true);
    for (let i = 0; i < 12; i++) {
      const v = allocator.acquire('drone', 'world', 100 + i);
      expect(v).not.toBe(alarm);
      v?.start(100 + i, { hz: 100, gain: 0.1, pan: 0, layer: true });
    }
    expect(alarm.busy).toBe(true);
    nextTick();
    rig.frame([ev('kernel.panic', { message: 'halt' })]);
    const panic = rig.engine.voices().find((v) => v.busy && v.kind === 'impact');
    expect(panic?.exempt).toBe(true);
    const others = new Set<unknown>();
    for (let i = 0; i < 20; i++) {
      const v = allocator.acquire('impact', 'world', rig.fake.currentTime + 0.001 * i);
      expect(v).not.toBe(panic);
      others.add(v);
      v?.start(rig.fake.currentTime + 0.001 * i, { impact: undefined as never, gain: 0.2, pan: 0 });
    }
    expect(panic?.busy).toBe(true);
    expect(others.size).toBe(POOL_SPLIT.low.impact - 1);
    // With every remaining impact also exempt, nothing can be stolen and the request drops.
    for (const v of others) if (v !== null && typeof v === 'object') (v as { exempt: boolean }).exempt = true;
    const dropped = allocator.stats.dropped;
    expect(allocator.acquire('impact', 'world', rig.fake.currentTime + 0.01)).toBeNull();
    expect(allocator.stats.dropped).toBe(dropped + 1);
  });

  it('pool reuse: a burst of 1,000 events reuses voices rather than constructing them', () => {
    resetSequence();
    const rig = makeRig('medium');
    const constructions = rig.fake.nodeConstructions;
    const nodes = rig.fake.nodes.length;
    const events = randomEvents(1000, 23, 0, GLOBAL_EVENTS);
    for (let i = 0; i < events.length; i += 9) rig.frame(events.slice(i, i + 9));
    expect(rig.fake.nodeConstructions).toBe(constructions);
    expect(rig.fake.nodes.length).toBe(nodes);
    expect(rig.engine.bank.stats.played).toBeGreaterThan(200);
    expect(rig.fake.nodes.filter((n) => n.kind === 'oscillator').every((n) => n.started === 1)).toBe(true);
  });

  it('mute sets master gain to 0 without disconnecting any node, and unmute is instant', () => {
    resetSequence();
    const rig = makeRig('medium');
    const graph = rig.engine.masterGraph;
    if (graph === null) throw new Error('no graph');
    const master = graph.master.gain as unknown as FakeParam;
    rig.idle(3);
    const graphNodes = [graph.master, graph.limiter, ...Object.values(graph.buses).flatMap((b) => [b.input, b.compressor, b.send])] as unknown as { disconnectCalls: number; released: boolean }[];
    const live = rig.fake.liveNodeCount;
    const t = rig.fake.currentTime;
    rig.engine.applySettings({ ...rig.engine.settings, mute: true });
    expect(graphNodes.every((n) => n.disconnectCalls === 0 && !n.released)).toBe(true);
    expect(rig.fake.liveNodeCount).toBe(live);
    expect(master.valueAt(t)).toBe(0);
    expect(master.events.at(-1)).toMatchObject({ kind: 'set', value: 0, time: t });
    rig.frame([ev('process.created', { pid: asPid(4), parent: asPid(1), name: 'a' })]);
    expect(rig.engine.bank.stats.played).toBeGreaterThan(0);
    const t2 = rig.fake.currentTime;
    rig.engine.applySettings({ ...rig.engine.settings, mute: false });
    expect(master.events.at(-1)).toMatchObject({ kind: 'set', value: rig.engine.settings.master, time: t2 });
    expect(master.valueAt(t2)).toBe(rig.engine.settings.master);
    expect(graphNodes.every((n) => n.disconnectCalls === 0 && !n.released)).toBe(true);
    expect(rig.fake.liveNodeCount).toBeGreaterThanOrEqual(live);
  });

  it('reduced motion halves every envelope time and removes the alarm swell', () => {
    const attackEnd = (reduced: boolean): { end: number; swells: number; frozen: number } => {
      resetSequence();
      const rig = makeRig('medium', { reducedMotionProbe: () => reduced });
      expect(rig.engine.settings.reducedMotion).toBe(reduced);
      expect(rig.engine.envelopeScale).toBe(reduced ? REDUCED_MOTION_ENVELOPE_SCALE : 1);
      rig.idle(2);
      nextTick();
      const events: KernelEvent[] = [
        ev('disk.seek', { from: 0, to: 100, distance: 100 }),
        ev('memory.thrashing', { faultRate: 400, severity: 'critical' }),
      ];
      rig.frame(events);
      const noise = rig.engine.voices().find((v) => v.kind === 'noise' && v.busy);
      if (noise === undefined) throw new Error('no noise voice');
      return { end: noise.finishAt - noise.startedAt, swells: rig.engine.score?.alarmSwells ?? -1, frozen: rig.engine.bank.stats.frozen };
    };
    const normal = attackEnd(false);
    const reduced = attackEnd(true);
    expect(reduced.end).toBeCloseTo(normal.end / 2, 6);
    expect(normal.swells).toBe(1);
    expect(reduced.swells).toBe(0);
    const rig = makeRig('low', { reducedMotionProbe: () => true });
    const tone = rig.engine.voices().find((v): v is ToneVoice => v instanceof ToneVoice);
    if (tone === undefined) throw new Error('no tone');
    tone.bus = 'world';
    tone.start(1, { hz: 220, gain: 0.3, pan: 0, adsr: { attack: 0.1, decay: 0.2, sustain: 0.5, release: 0.4 }, hold: 0 });
    expect(tone.finishAt).toBeCloseTo(1 + (0.1 + 0.2 + 0.4) / 2, 9);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createKernel } from '@kernel/Kernel';
import { canonical } from '../kernel/canonical';
import { asPid } from '@kernel/types';
import type { KernelEvent, KernelEventType } from '@kernel/types';
import { stripComments } from '../kernel/sourceScan';
import { REFERENCE_CONFIG } from '../kernel/fixtures/referenceConfig';
import { EVENT_TREATMENT } from '../../src/audio/events/eventSounds';
import { generateBuffers, sameBuffers } from '../../src/audio/buffers';
import { PAN_CLAMP, DIRTY_EVICT_EXTRA_MS, DEADLOCK_HOLD_MS, SEEK_SWEEP } from '../../src/audio/synth/constants';
import { IMPACT_PRESETS, impactDuration } from '../../src/audio/voices/ImpactVoice';
import { NoiseVoice } from '../../src/audio/voices/NoiseVoice';
import { PANIC_POST } from '@design/motion';
import type { FakeParam } from './fakeContext';
import { EVENT_TYPES, GLOBAL_EVENTS, ev, makeRig, nextTick, randomEvents, resetSequence, sampleEvents, type Rig } from './helpers';

const CONSUMER = 'src/audio/events/AudioConsumer.ts';

function caseBlocks(): Map<KernelEventType, string> {
  const source = readFileSync(CONSUMER, 'utf8');
  const start = source.indexOf('switch (e.type)');
  const end = source.indexOf('default:', start);
  const body = source.slice(start, end);
  const blocks = new Map<KernelEventType, string>();
  const re = /case '([a-z_.]+)':/g;
  const matches = [...body.matchAll(re)];
  for (const [i, m] of matches.entries()) {
    const type = m[1] as KernelEventType;
    const from = (m.index ?? 0) + m[0].length;
    const to = matches[i + 1]?.index ?? body.length;
    blocks.set(type, body.slice(from, to));
  }
  return blocks;
}

/** A case that only shares its body with the next case is documented by the next block. */
function effectiveBlock(blocks: Map<KernelEventType, string>, type: KernelEventType): string {
  const own = blocks.get(type) ?? '';
  if (own.trim().length > 0) return own;
  const types = [...blocks.keys()];
  const i = types.indexOf(type);
  for (let j = i + 1; j < types.length; j++) {
    const next = blocks.get(types[j] as KernelEventType) ?? '';
    if (next.trim().length > 0) return next;
  }
  return own;
}

function busyCount(rig: Rig): number {
  return rig.engine.allocator?.busyCount(rig.fake.currentTime) ?? 0;
}

describe('eventSounds', () => {
  it('exhaustive: the consumer switches over every variant and ends in assertNever', () => {
    const code = stripComments(readFileSync(CONSUMER, 'utf8'), false);
    expect(code).toMatch(/default:\s*return assertNever\(e\);/);
    expect(code).toMatch(/function assertNever\(x: never\): never/);
    const blocks = caseBlocks();
    expect([...blocks.keys()].sort()).toEqual([...EVENT_TYPES].sort());
    expect(EVENT_TYPES.length).toBe(45);
    expect(Object.keys(EVENT_TREATMENT).length).toBe(45);
  });

  it('coverage: every one of the 45 variants has a sound or a commented deliberate silence', () => {
    const blocks = caseBlocks();
    for (const type of EVENT_TYPES) {
      resetSequence();
      const rig = makeRig('medium');
      rig.idle(2);
      const before = { ...rig.engine.bank.stats };
      const swells = rig.engine.score?.alarmSwells ?? 0;
      const density = rig.engine.consumer.stats.faultDensityUpdates;
      nextTick();
      rig.frame([sampleEvents()[type]]);
      const stats = rig.engine.bank.stats;
      const played = stats.played - before.played;
      const reacted = played > 0
        || (rig.engine.score?.alarmSwells ?? 0) > swells
        || rig.engine.consumer.stats.faultDensityUpdates > density
        || rig.engine.bank.frozenUntil > rig.fake.currentTime - 1;
      if (EVENT_TREATMENT[type] === 'sound') {
        expect(reacted, `${type} should sound`).toBe(true);
      } else {
        expect(played, `${type} should be silent`).toBe(0);
        expect(effectiveBlock(blocks, type), `${type} silence must be documented`).toMatch(/Deliberate silence/);
      }
      expect(rig.engine.consumer.stats.errors, type).toBe(0);
    }
  });

  it('never throws: 10,000 randomised events including malformed payloads', () => {
    resetSequence();
    const rig = makeRig('low');
    const events = randomEvents(10_000, 5, 3);
    expect(() => {
      for (let i = 0; i < events.length; i += 7) rig.frame(events.slice(i, i + 7));
      for (const junk of [null, undefined, 42, 'x', {}, { type: 'no.such' }, { type: 'disk.seek' }, { type: 'process.exited', reason: 'bogus', pid: null }]) {
        rig.engine.consumer.consume(junk as unknown as KernelEvent);
      }
      rig.engine.consumer.endFrame();
    }).not.toThrow();
    // The queue coalesces accesses and samples faults, so fewer than 10,000 survive to consume.
    expect(rig.engine.consumer.stats.consumed).toBeGreaterThan(9000);
    expect(rig.engine.consumer.stats.consumed).toBeLessThanOrEqual(10_008);
    // Panics and deadlocks in the stream silence long stretches; the point is no throw.
    expect(rig.engine.bank.stats.played).toBeGreaterThan(100);
  });

  it('silence documented: every silent variant has a comment giving the reason', () => {
    const blocks = caseBlocks();
    const silent = EVENT_TYPES.filter((t) => EVENT_TREATMENT[t] === 'silence');
    expect(silent.length).toBe(19);
    for (const type of silent) {
      const block = effectiveBlock(blocks, type);
      expect(block, type).toMatch(/Deliberate silence:[\s\S]{20,}/);
      expect(stripComments(block, false), `${type} silent case must not call the bank`).not.toMatch(/bank\./);
    }
    const sounding = EVENT_TYPES.filter((t) => EVENT_TREATMENT[t] === 'sound');
    for (const type of sounding) {
      const block = stripComments(effectiveBlock(blocks, type), false);
      expect(block, type).toMatch(/bank\.|faultsThisFrame/);
    }
  });

  it('page fault aggregated: 500 faults in one frame produce one density change, not 500 grains', () => {
    resetSequence();
    const rig = makeRig('medium');
    rig.idle(2);
    nextTick();
    const faults: KernelEvent[] = [];
    for (let i = 0; i < 500; i++) faults.push(ev('memory.page_fault', { pid: asPid(3), page: 1 as never, major: i % 5 === 0 }));
    const before = rig.engine.consumer.stats.faultDensityUpdates;
    const constructions = rig.fake.nodeConstructions;
    const aggregates = rig.engine.push(faults);
    void aggregates;
    const agg = rig.engine.frame();
    expect(agg.faultCount).toBe(500);
    expect(agg.suppressed).toBe(488);
    expect(rig.engine.consumer.stats.faultDensityUpdates - before).toBe(1);
    const granulars = rig.engine.granulars().filter((g) => g.busy);
    expect(granulars.length).toBe(1);
    expect(granulars[0]?.density).toBe(1);
    expect(granulars[0]?.scheduledGrainCount ?? 0).toBeLessThan(20);
    expect(rig.fake.nodeConstructions).toBe(constructions);
    rig.idle(30);
    expect(rig.engine.granulars().filter((g) => g.busy).length).toBe(0);
  });

  it('evict dirty longer: dirty is a longer and lower sweep than clean', () => {
    const measure = (dirty: boolean): { seconds: number; endHz: number } => {
      resetSequence();
      const rig = makeRig('low');
      rig.idle(1);
      nextTick();
      rig.frame([ev('memory.page_evicted', { frame: 1 as never, page: 1 as never, dirty, policy: 'lru' })]);
      const voice = rig.engine.voices().find((v): v is NoiseVoice => v instanceof NoiseVoice && v.busy && v.bus === 'world');
      if (voice === undefined) throw new Error('no noise voice');
      const freq = voice.filterParam as unknown as FakeParam;
      const end = freq.events.filter((e) => e.kind === 'exp').at(-1)?.value ?? 0;
      return { seconds: voice.finishAt - voice.startedAt, endHz: end };
    };
    const clean = measure(false);
    const dirty = measure(true);
    expect(dirty.seconds - clean.seconds).toBeCloseTo(DIRTY_EVICT_EXTRA_MS / 1000, 6);
    expect(dirty.endHz).toBeLessThan(clean.endHz);
  });

  it('seek proportional: sweep duration scales linearly with distance', () => {
    const duration = (distance: number): number => {
      resetSequence();
      const rig = makeRig('low');
      rig.idle(1);
      nextTick();
      rig.frame([ev('disk.seek', { from: 0, to: distance, distance })]);
      const voice = rig.engine.voices().find((v) => v.kind === 'noise' && v.busy && v.bus === 'world');
      if (voice === undefined) throw new Error('no noise voice');
      return voice.finishAt - voice.startedAt;
    };
    const d0 = duration(0);
    const d50 = duration(50);
    const d100 = duration(100);
    expect(d50 - d0).toBeCloseTo((SEEK_SWEEP.msPerCylinder * 50) / 1000, 6);
    expect(d100 - d50).toBeCloseTo(d50 - d0, 6);
    expect(duration(10_000)).toBeCloseTo(duration(9_000), 6);
  });

  it('deadlock hold: every voice sustains and nothing moves for 600 ms, then the alarm swells', () => {
    resetSequence();
    const rig = makeRig('medium');
    rig.idle(2);
    nextTick();
    rig.frame([ev('process.created', { pid: asPid(4), parent: asPid(1), name: 'a' }), ev('disk.seek', { from: 0, to: 100, distance: 100 })]);
    const busyBefore = busyCount(rig);
    expect(busyBefore).toBeGreaterThan(5);
    const t0 = rig.fake.currentTime;
    const seen = new Set(rig.fake.automation().map(({ param, event }) => `${param.owner.id}:${param.name}:${event.time}`));
    nextTick();
    rig.frame([ev('deadlock.detected', { report: { cycle: [], conditions: [] } as never })]);
    const at = t0 + 0.005;
    const until = at + DEADLOCK_HOLD_MS / 1000;
    expect(rig.engine.bank.frozenUntil).toBeCloseTo(until, 6);
    expect(rig.engine.score?.holdEndsAt).toBeCloseTo(until, 6);
    const fresh = rig.fake.automation().filter(({ param, event }) => !seen.has(`${param.owner.id}:${param.name}:${event.time}`));
    for (const { param, event } of fresh) {
      const inside = event.time > at + 1e-6 && event.time < until - 1e-6;
      expect(inside, `${param.owner.kind}.${param.name} ${event.kind} at ${event.time} moves during the hold`).toBe(false);
    }
    const alarm = rig.engine.score?.layerVoice('alarm')?.level as unknown as FakeParam;
    const swell = alarm.events.find((e) => e.kind === 'curve');
    expect(swell?.time).toBeCloseTo(until, 6);
    nextTick();
    rig.frame([ev('process.created', { pid: asPid(5), parent: asPid(1), name: 'b' })]);
    expect(rig.engine.bank.stats.frozen).toBe(1);
    expect(busyCount(rig)).toBe(busyBefore);
    for (let i = 0; i < 40; i++) rig.frame([]);
    nextTick();
    const played = rig.engine.bank.stats.played;
    rig.frame([ev('process.created', { pid: asPid(6), parent: asPid(1), name: 'c' })]);
    expect(rig.engine.bank.stats.played).toBe(played + 1);
  });

  it('panic silence: one impact at full, then 900 ms of scheduled silence', () => {
    resetSequence();
    const rig = makeRig('medium');
    rig.idle(2);
    nextTick();
    rig.frame(randomEvents(30, 9).filter((e) => e.type !== 'kernel.panic' && e.type !== 'deadlock.detected'));
    expect(busyCount(rig)).toBeGreaterThan(3);
    const t0 = rig.fake.currentTime;
    nextTick();
    rig.frame([ev('kernel.panic', { message: 'halt' })]);
    const at = t0 + 0.005;
    // The five layer voices stay busy by design; the Score holds them at silence.
    const busy = rig.engine.voices().filter((v) => v.busy && !v.layer);
    expect(busy.length).toBe(1);
    expect(busy[0]?.kind).toBe('impact');
    expect(busy[0]?.bus).toBe('voice_alerts');
    expect(busy[0]?.exempt).toBe(true);
    const silenceEnd = at + impactDuration(IMPACT_PRESETS.panic) + PANIC_POST.floodMs / 1000;
    expect(rig.engine.bank.panicSilenceUntil).toBeCloseTo(silenceEnd, 6);
    expect(silenceEnd - at - impactDuration(IMPACT_PRESETS.panic)).toBeCloseTo(0.9, 9);
    const played = rig.engine.bank.stats.played;
    for (let i = 0; i < 40; i++) {
      nextTick();
      rig.frame(randomEvents(5, 20 + i).filter((e) => e.type !== 'kernel.panic'));
    }
    expect(rig.engine.bank.stats.played).toBe(played);
    expect(rig.engine.bank.stats.silenced).toBeGreaterThan(0);
    for (const layer of ['bed', 'pulse', 'strain', 'contention', 'alarm'] as const) {
      expect(rig.engine.score?.layerGainAt(layer, at + 1), layer).toBeCloseTo(0, 4);
      expect(rig.engine.score?.layerVoice(layer)?.busy, layer).toBe(true);
    }
    rig.idle(200);
    expect(rig.fake.currentTime).toBeGreaterThan(silenceEnd);
    nextTick();
    rig.frame([ev('process.created', { pid: asPid(6), parent: asPid(1), name: 'c' })]);
    expect(rig.engine.bank.stats.played).toBe(played + 1);
  });

  it('pan clamp: panning never exceeds plus or minus 0.7', () => {
    resetSequence();
    let x = 0;
    const rig = makeRig('medium', { positionSource: { xOf: () => x } });
    const events = randomEvents(600, 4, 0, GLOBAL_EVENTS);
    for (let i = 0; i < events.length; i += 6) {
      x = ((i % 7) - 3) * 2;
      rig.frame(events.slice(i, i + 6));
    }
    x = Number.NaN;
    rig.frame(events.slice(0, 6));
    const pans = rig.fake.params.filter((p) => p.name === 'pan').flatMap((p) => p.events.map((e) => e.value));
    expect(pans.length).toBeGreaterThan(100);
    expect(Math.max(...pans)).toBeCloseTo(PAN_CLAMP, 9);
    expect(Math.min(...pans)).toBeCloseTo(-PAN_CLAMP, 9);
    for (const p of pans) expect(Math.abs(p)).toBeLessThanOrEqual(PAN_CLAMP);
  });

  it('mono collapses every panner to 0', () => {
    resetSequence();
    const rig = makeRig('medium', { positionSource: { xOf: () => 0.5 }, settings: { mono: true } });
    const events = randomEvents(600, 4, 0, GLOBAL_EVENTS);
    for (let i = 0; i < events.length; i += 6) rig.frame(events.slice(i, i + 6));
    const pans = rig.fake.params.filter((p) => p.name === 'pan').flatMap((p) => p.events.map((e) => e.value));
    expect(pans.length).toBeGreaterThan(100);
    expect(pans.every((p) => p === 0)).toBe(true);
    rig.engine.applySettings({ ...rig.engine.settings, mono: false });
    rig.frame(events.slice(0, 6));
    const later = rig.fake.params.filter((p) => p.name === 'pan').flatMap((p) => p.events.map((e) => e.value));
    expect(later.some((p) => p !== 0)).toBe(true);
  });

  it('determinism: audio consumes zero draws from any kernel rng stream', () => {
    // Stream states: an init-only pair, because the kernel's snapshot with a
    // live workload waits on WP-11. Event logs: a spawned workload, which would
    // diverge if any scheduler or memory draw had been consumed elsewhere.
    const stream = (withAudio: boolean): { rng: unknown; events: number } => {
      const kernel = createKernel(REFERENCE_CONFIG);
      const rig = withAudio ? makeRig('medium') : null;
      let events = 0;
      for (let tick = 0; tick < 200; tick++) {
        const batch = kernel.step();
        events += batch.length;
        if (rig !== null) {
          rig.engine.push(batch);
          if (tick % 3 === 2) rig.frame();
        }
      }
      return { rng: kernel.snapshot().rng, events };
    };
    const silent = stream(false);
    const loud = stream(true);
    expect(loud.rng).toEqual(silent.rng);
    expect(loud.events).toBe(silent.events);
    const workload = (withAudio: boolean): { log: string; consumed: number } => {
      const kernel = createKernel(REFERENCE_CONFIG);
      const rig = withAudio ? makeRig('medium') : null;
      for (let i = 0; i < 6; i++) kernel.spawn({ name: `p${i}`, priority: 10 + i, burst: 12, service: 200, arrival: 0, pages: 6 });
      const log: KernelEvent[] = [];
      for (let tick = 0; tick < 300; tick++) {
        const batch = kernel.step();
        log.push(...batch);
        if (rig !== null) {
          rig.engine.push(batch);
          if (tick % 3 === 2) rig.frame();
        }
      }
      return { log: canonical(log), consumed: rig?.engine.consumer.stats.consumed ?? 0 };
    };
    const a = workload(false);
    const b = workload(true);
    expect(b.log).toBe(a.log);
    expect(b.consumed).toBeGreaterThan(100);
    const rig = makeRig('low');
    expect((rig.engine.rng as { label?: string }).label).toBe('audio/runtime');
  });

  it('seeded buffers: two engines with the same seed produce byte-identical buffers', () => {
    const t0 = performance.now();
    const a = generateBuffers(0x4b54524c);
    const ms = performance.now() - t0;
    const b = generateBuffers(0x4b54524c);
    expect(sameBuffers(a, b)).toBe(true);
    expect(sameBuffers(a, generateBuffers(0x4b54524d))).toBe(false);
    const x = makeRig('medium');
    const y = makeRig('medium');
    expect(sameBuffers(x.engine.bufferSet, y.engine.bufferSet)).toBe(true);
    expect(a.white.length).toBe(96000);
    expect(a.impulseHigh.length).toBe(86400);
    expect(Math.max(...a.white)).toBeLessThanOrEqual(1);
    expect(Math.abs(a.impulseHigh[a.impulseHigh.length - 1] ?? 1)).toBeLessThan(0.002);
    console.log(`generateBuffers main-thread timing (Node): ${ms.toFixed(2)} ms`);
  });
});

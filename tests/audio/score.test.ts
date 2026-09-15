import { describe, expect, it } from 'vitest';
import { asPid } from '@kernel/types';
import type { KernelEvent } from '@kernel/types';
import { nextFaultAccumulator as kernelNextFaultAccumulator } from '@kernel/memory/thrashing';
import { DUR } from '@design/motion';
import { LAYER_IDS, LAYERS } from '../../src/audio/score/layers';
import { LoadModel, nextFaultAccumulator } from '../../src/audio/score/loadModel';
import { DEREZZ_DUCK_MS, DEREZZ_RESTORE_MS, TOMBSTONE_AFTER_FRACTURE_MS } from '../../src/audio/synth/constants';
import type { FakeParam } from './fakeContext';
import { ev, makeRig, nextTick, resetSequence, type Rig } from './helpers';

const FRAME = 1 / 60;

function levelParam(rig: Rig, layer: (typeof LAYER_IDS)[number]): FakeParam {
  const voice = rig.engine.score?.layerVoice(layer);
  if (voice === null || voice === undefined) throw new Error(`no ${layer} voice`);
  return voice.level as unknown as FakeParam;
}

/** Frames of a busy CPU: one switch per tick to a live pid. */
function busyFrames(rig: Rig, frames: number, ticksPerFrame = 3): void {
  for (let f = 0; f < frames; f++) {
    const events: KernelEvent[] = [];
    for (let t = 0; t < ticksPerFrame; t++) {
      nextTick();
      events.push(ev('context.switch', { from: asPid(2), to: asPid(3 + (t % 4)), rationale: 'quantum' }));
    }
    rig.frame(events, FRAME);
  }
}

/** Frames of an idle CPU: every switch goes to idle. */
function idleFrames(rig: Rig, frames: number, ticksPerFrame = 3): void {
  for (let f = 0; f < frames; f++) {
    const events: KernelEvent[] = [];
    for (let t = 0; t < ticksPerFrame; t++) {
      nextTick();
      events.push(ev('context.switch', { from: asPid(3), to: null, rationale: 'idle' }));
    }
    rig.frame(events, FRAME);
  }
}

/**
 * `faultsPerTick` faults on every tick. WP-06's integer accumulator snaps to
 * zero below eight, so a sparse fault pattern reads as no rate at all; that is
 * the kernel's arithmetic and the HUD's, and the score inherits it.
 */
function faultFrames(rig: Rig, frames: number, faultsPerTick: number, ticksPerFrame = 3): void {
  for (let f = 0; f < frames; f++) {
    const events: KernelEvent[] = [];
    for (let t = 0; t < ticksPerFrame; t++) {
      nextTick();
      events.push(ev('context.switch', { from: asPid(2), to: asPid(3), rationale: 'q' }));
      for (let i = 0; i < faultsPerTick; i++) events.push(ev('memory.page_fault', { pid: asPid(3), page: 1 as never, major: false }));
    }
    rig.frame(events, FRAME);
  }
}

describe('score', () => {
  it('five layers: the set is exactly bed, pulse, strain, contention, alarm', () => {
    expect([...LAYER_IDS]).toEqual(['bed', 'pulse', 'strain', 'contention', 'alarm']);
    const rig = makeRig('low');
    for (const id of LAYER_IDS) expect(rig.engine.score?.layerVoice(id), id).not.toBeNull();
    expect(rig.engine.score?.layerVoice('alarm')?.exempt).toBe(true);
    expect(rig.engine.score?.layerVoice('contention')?.kind).toBe('noise');
  });

  it('bed always: the bed gain is above zero from the first frame', () => {
    resetSequence();
    const rig = makeRig('medium');
    rig.frame();
    const bed = levelParam(rig, 'bed');
    expect(bed.valueAt(FRAME)).toBeGreaterThan(0);
    expect(rig.engine.score?.layerGainAt('bed', 5)).toBeCloseTo(LAYERS.bed.maxGain, 6);
    rig.idle(120);
    expect(bed.valueAt(2)).toBeCloseTo(LAYERS.bed.maxGain, 3);
  });

  it('pulse threshold: pulse fades in above cpu utilisation 0.25 and out below it', () => {
    resetSequence();
    const rig = makeRig('medium');
    const score = rig.engine.score;
    if (score === null) throw new Error('no score');
    idleFrames(rig, 30);
    expect(rig.engine.load.cpuUtilisation).toBeLessThan(0.25);
    expect(score.layerGainAt('pulse', rig.fake.currentTime + 10)).toBe(0);
    busyFrames(rig, 40);
    expect(rig.engine.load.cpuUtilisation).toBeGreaterThan(0.25);
    expect(score.layerGainAt('pulse', rig.fake.currentTime + 10)).toBeGreaterThan(0);
    idleFrames(rig, 60);
    expect(rig.engine.load.cpuUtilisation).toBeLessThan(0.25);
    expect(score.layerGainAt('pulse', rig.fake.currentTime + 10)).toBe(0);
    const gate = (score.layerVoice('pulse') as unknown as { gate: FakeParam }).gate;
    expect(gate.events.some((e) => e.kind === 'set' && e.value === 1)).toBe(true);
  });

  it('strain tracks faults: the smoothing is WP-06 faultRate EWMA, step for step', () => {
    let ours = 0;
    let theirs = 0;
    const model = new LoadModel();
    model.setThresholds({ thrashingThreshold: 200 });
    const trace = [0, 0, 5, 12, 40, 40, 40, 3, 0, 0, 0, 0, 0, 7, 90, 90, 1];
    for (const faults of trace) {
      ours = nextFaultAccumulator(ours, faults);
      theirs = kernelNextFaultAccumulator(theirs, faults);
      model.observeTick(faults, true, 1);
      expect(ours).toBe(theirs);
      expect(model.faultRate).toBeCloseTo((theirs * 1000) / 8, 9);
    }
    resetSequence();
    const rig = makeRig('medium');
    const score = rig.engine.score;
    if (score === null) throw new Error('no score');
    rig.engine.setThresholds({ thrashingThreshold: 4000 });
    expect(score.layerGainAt('strain', 10)).toBe(0);
    faultFrames(rig, 40, 1);
    const rate = rig.engine.load.faultRate;
    // One fault per tick converges on an accumulator of 8: a thousand per thousand ticks.
    expect(rate).toBeCloseTo(1000, 6);
    const expected = Math.min(1, rate / 4000) * LAYERS.strain.maxGain;
    expect(score.layerGainAt('strain', rig.fake.currentTime + 10)).toBeCloseTo(expected, 3);
    faultFrames(rig, 40, 2);
    expect(rig.engine.load.faultRate).toBeGreaterThan(rate);
    expect(score.layerGainAt('strain', rig.fake.currentTime + 10)).toBeGreaterThan(expected);
  });

  it('contention tracks queues: the band widens with total wait-queue depth', () => {
    resetSequence();
    const rig = makeRig('medium');
    const score = rig.engine.score;
    if (score === null) throw new Error('no score');
    const voice = score.layerVoice('contention') as unknown as { nodes: unknown[] } | null;
    expect(voice).not.toBeNull();
    const qParams = rig.fake.params.filter((p) => p.name === 'Q' && p.owner.kind === 'biquad');
    const before = qParams.map((p) => p.events.length);
    rig.idle(5);
    expect(score.layerGainAt('contention', 10)).toBe(0);
    for (let i = 0; i < 20; i++) {
      nextTick();
      rig.frame([
        ev('sync.blocked', { pid: asPid(4), resource: 'm1' as never, queueLength: 5 }),
        ev('sync.blocked', { pid: asPid(5), resource: 'm2' as never, queueLength: 3 }),
      ]);
    }
    const gain = score.layerGainAt('contention', rig.fake.currentTime + 10);
    expect(gain).toBeGreaterThan(0.5 * LAYERS.contention.maxGain);
    const after = qParams.map((p) => p.events.length);
    expect(after.some((n, i) => n > (before[i] ?? 0))).toBe(true);
    const widths = qParams.flatMap((p) => p.events.filter((e) => e.kind === 'set').map((e) => e.value));
    expect(Math.min(...widths)).toBeLessThan(Math.max(...widths));
  });

  it('alarm swells: a critical event swells and decays the alarm layer once', () => {
    resetSequence();
    const rig = makeRig('medium');
    const score = rig.engine.score;
    if (score === null) throw new Error('no score');
    rig.idle(3);
    const alarm = levelParam(rig, 'alarm');
    const t0 = rig.fake.currentTime;
    nextTick();
    rig.frame([ev('memory.thrashing', { faultRate: 300, severity: 'warning' })]);
    expect(score.alarmSwells).toBe(0);
    nextTick();
    rig.frame([ev('memory.thrashing', { faultRate: 300, severity: 'critical' })]);
    expect(score.alarmSwells).toBe(1);
    const curves = alarm.events.filter((e) => e.kind === 'curve');
    const decays = alarm.events.filter((e) => e.kind === 'linear');
    expect(curves.length).toBe(1);
    expect(decays.length).toBe(1);
    const peakAt = (curves[0]?.time ?? 0) + (curves[0]?.duration ?? 0);
    expect(alarm.valueAt(peakAt)).toBeCloseTo(LAYERS.alarm.maxGain, 3);
    expect(alarm.valueAt(peakAt + DUR.ambient / 1000 + 0.01)).toBeCloseTo(0, 3);
    expect(alarm.valueAt(t0)).toBeCloseTo(0, 3);
  });

  it('ramps not steps: layer gains change only through ramps of at least DUR.travel', () => {
    resetSequence();
    const rig = makeRig('medium');
    busyFrames(rig, 30);
    faultFrames(rig, 20, 3);
    idleFrames(rig, 30);
    for (let i = 0; i < 10; i++) {
      nextTick();
      rig.frame([ev('sync.blocked', { pid: asPid(4), resource: 'm1' as never, queueLength: 6 })]);
    }
    for (const layer of LAYER_IDS) {
      const param = levelParam(rig, layer);
      const events = [...param.events].sort((a, b) => a.time - b.time);
      for (const [i, e] of events.entries()) {
        if (e.kind === 'curve') expect(e.scheduledDuration, layer).toBeGreaterThanOrEqual(DUR.travel / 1000 - 1e-9);
        if (e.kind === 'set') {
          // A set only ever anchors the current value for a ramp. Its ramp is
          // scheduled at the same time, or was cancelled by a later re-ramp,
          // which leaves the anchor behind followed by that later set.
          const next = events[i + 1];
          expect(next, `${layer} set at ${e.time} is an unanchored step`).toBeDefined();
          if (next?.time === e.time) expect(next.kind, layer).toMatch(/curve|linear/);
          else expect(next?.kind, layer).toBe('set');
        }
      }
      let previous = param.valueAt(0);
      let maxJump = 0;
      for (let t = 0; t < rig.fake.currentTime + 1; t += 0.001) {
        const v = param.valueAt(t);
        maxJump = Math.max(maxJump, Math.abs(v - previous));
        previous = v;
      }
      expect(maxJump, layer).toBeLessThan(0.006);
    }
  });

  it('derezz duck: a convoy exit ducks every layer except bed to zero over 400 ms and restores over 1.2 s after the tombstone', () => {
    resetSequence();
    const rig = makeRig('medium');
    const score = rig.engine.score;
    if (score === null) throw new Error('no score');
    rig.engine.setConvoyPids([asPid(9)]);
    busyFrames(rig, 40);
    rig.idle(40);
    const pulse = levelParam(rig, 'pulse');
    const bed = levelParam(rig, 'bed');
    const pulseBefore = pulse.valueAt(rig.fake.currentTime);
    expect(pulseBefore).toBeGreaterThan(0.05);
    const t0 = rig.fake.currentTime;
    nextTick();
    rig.frame([ev('process.exited', { pid: asPid(9), exitCode: 0, reason: 'starvation' })]);
    const duckSeconds = DEREZZ_DUCK_MS / 1000;
    const start = t0 + 0.005;
    expect(pulse.valueAt(start + duckSeconds / 2)).toBeCloseTo(pulseBefore / 2, 2);
    expect(pulse.valueAt(start + duckSeconds + 0.001)).toBeCloseTo(0, 4);
    expect(bed.valueAt(start + duckSeconds)).toBeCloseTo(LAYERS.bed.maxGain, 3);
    for (const layer of ['strain', 'contention', 'alarm'] as const) {
      expect(levelParam(rig, layer).valueAt(start + duckSeconds + 0.5), layer).toBeCloseTo(0, 4);
    }
    // Hold through the mote: busy frames would raise pulse again if the duck did not hold.
    const holdFrames = Math.ceil(((DEREZZ_DUCK_MS + TOMBSTONE_AFTER_FRACTURE_MS) / 1000) * 60);
    busyFrames(rig, holdFrames - 2);
    expect(pulse.valueAt(rig.fake.currentTime)).toBeCloseTo(0, 4);
    expect(score.isDucked).toBe(true);
    busyFrames(rig, 6);
    expect(score.isDucked).toBe(false);
    const restore = [...pulse.events].sort((a, b) => a.time - b.time).filter((e) => e.kind === 'curve').at(-1);
    expect(restore).toBeDefined();
    expect(restore?.time).toBeGreaterThanOrEqual(start + (DEREZZ_DUCK_MS + TOMBSTONE_AFTER_FRACTURE_MS) / 1000 - 1e-6);
    expect(restore?.duration).toBeCloseTo(DEREZZ_RESTORE_MS / 1000, 6);
    const restoredAt = (restore?.time ?? 0) + (restore?.duration ?? 0);
    expect(pulse.valueAt(restoredAt)).toBeGreaterThan(0.05);
  });

  it('no timeline: two different workloads produce different automation', () => {
    resetSequence();
    const a = makeRig('medium');
    busyFrames(a, 40);
    resetSequence();
    const b = makeRig('medium');
    faultFrames(b, 40, 2);
    const signature = (rig: Rig): string => JSON.stringify(LAYER_IDS.map((id) => levelParam(rig, id).events.map((e) => [e.kind, Math.round(e.value * 1e4), Math.round(e.time * 1e4)])));
    expect(signature(a)).not.toBe(signature(b));
    resetSequence();
    const c = makeRig('medium');
    busyFrames(c, 40);
    expect(signature(a)).toBe(signature(c));
  });
});

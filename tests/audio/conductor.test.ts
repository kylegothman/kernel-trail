import { describe, expect, it } from 'vitest';
import type { LegEvent } from '@game/LegRunner';
import type { LegId } from '@game/types';
import type { KernelEvent } from '@kernel/types';
import type { QualityTier } from '@platform/quality';
import { VOICE_BUDGET } from '../../src/audio/VoiceBudget';
import { START_LEAD_SECONDS, FOLLOW_ON, YIELDING } from '../../src/audio/score/Conductor';
import { SECTION_BARS, SECTION_IDS, barSeconds, type SectionId } from '../../src/audio/score/Arrangement';
import { DEADLOCK_HOLD_MS } from '../../src/audio/synth/constants';
import type { FakeParam } from './fakeContext';
import { EVENT_TYPES, GLOBAL_EVENTS, ev, makeRig, nextTick, randomEvents, resetSequence, sampleEvents, type Rig } from './helpers';

const legEvent = (kind: LegEvent['kind']): LegEvent => ({ kind } as unknown as LegEvent);

interface Stage {
  readonly rig: Rig;
  readonly bar: number;
  /** Time of the leg's first bar line. */
  readonly t0: number;
  timeline(): { section: SectionId; time: number }[];
  /** Frames until the fake clock reaches `t`. */
  runTo(t: number): void;
  /** The first bar line at or after `t`. */
  barLineAfter(t: number): number;
}

/** A leg entered at the fake clock's zero, played through travel's start. */
function stage(tier: QualityTier = 'low', legId: LegId = 'boot_sector', throughEntry = true): Stage {
  resetSequence();
  const rig = makeRig(tier);
  const score = rig.engine.score;
  if (score === null) throw new Error('no score');
  rig.engine.onDirectorEvent({ kind: 'leg_entered', legId, index: 0 });
  const a = score.arrangement;
  if (a === null) throw new Error('no arrangement');
  const bar = barSeconds(a);
  const t0 = START_LEAD_SECONDS;
  const runTo = (t: number): void => { while (rig.fake.currentTime < t) rig.frame(); };
  const barLineAfter = (t: number): number => t0 + Math.ceil((t - t0) / bar - 1e-9) * bar;
  if (throughEntry) runTo(t0 + 8 * bar + 0.5);
  return { rig, bar, t0, timeline: () => score.conductor.timeline.map((e) => ({ section: e.section, time: e.time })), runTo, barLineAfter };
}

const onBarLine = (s: Stage, t: number): boolean => Math.abs((t - s.t0) / s.bar - Math.round((t - s.t0) / s.bar)) < 1e-6;

/** Sections and times, the times to a microsecond: bar lines are sums of bars from different anchors. */
function expectTimeline(actual: readonly { section: SectionId; time: number }[], expected: readonly (readonly [SectionId, number])[]): void {
  expect(actual.map((e) => e.section)).toEqual(expected.map((e) => e[0]));
  for (const [i, e] of expected.entries()) expect(actual[i]?.time, `${e[0]} at ${e[1]}`).toBeCloseTo(e[1], 6);
}

describe('conductor', () => {
  it('table: the follow-ons and the yielding sections are section 4', () => {
    expect(FOLLOW_ON).toEqual({ entry: 'travel', travel: 'loop', crossing: 'loop', resolve_good: 'travel', resolve_bad: 'travel', loss: 'travel', panic: 'end', debrief: 'loop' });
    expect([...YIELDING]).toEqual(['entry', 'travel', 'crossing', 'debrief']);
    expect(Object.keys(FOLLOW_ON).sort()).toEqual([...SECTION_IDS].sort());
  });

  it('crossing: opens on the next bar line, resolves good or bad on the next, then travel after four bars', () => {
    const s = stage();
    expect(s.timeline().map((e) => e.section)).toEqual(['entry', 'travel']);
    const opened = s.rig.fake.currentTime;
    s.rig.engine.onLegEvent(legEvent('crossing_open'));
    const line = s.barLineAfter(opened + 0.2);
    s.runTo(line + 1);
    expectTimeline(s.timeline().slice(-1), [['crossing', line]]);
    expect(line - opened).toBeGreaterThan(0.1);
    // The panel stays open for a while: the crossing loops.
    s.runTo(line + 18 * s.bar);
    expect(s.rig.engine.score?.current).toBe('crossing');
    const resolved = s.rig.fake.currentTime;
    s.rig.engine.onDirectorEvent({ kind: 'crossing_resolved', succeeded: true, casualties: 0 });
    const line2 = s.barLineAfter(resolved + 0.2);
    s.runTo(line2 + 4 * s.bar + 1);
    expectTimeline(s.timeline().slice(-2), [['resolve_good', line2], ['travel', line2 + 4 * s.bar]]);

    s.rig.engine.onLegEvent(legEvent('crossing_open'));
    s.runTo(s.barLineAfter(s.rig.fake.currentTime + 0.2) + 1);
    const failed = s.rig.fake.currentTime;
    s.rig.engine.onDirectorEvent({ kind: 'crossing_resolved', succeeded: false, casualties: 0 });
    const line3 = s.barLineAfter(failed + 0.2);
    s.runTo(line3 + 4 * s.bar + 1);
    expectTimeline(s.timeline().slice(-2), [['resolve_bad', line3], ['travel', line3 + 4 * s.bar]]);

    // Succeeded with a casualty is resolve_bad.
    s.rig.engine.onLegEvent(legEvent('crossing_open'));
    s.runTo(s.barLineAfter(s.rig.fake.currentTime + 0.2) + 1);
    s.rig.engine.onDirectorEvent({ kind: 'crossing_resolved', succeeded: true, casualties: 1 });
    s.runTo(s.barLineAfter(s.rig.fake.currentTime + 0.2) + 1);
    expect(s.timeline().at(-1)?.section).toBe('resolve_bad');
    for (const e of s.timeline()) expect(onBarLine(s, e.time), `${e.section} at ${e.time}`).toBe(true);
  });

  it('tombstone: the duck at the event, the kick and arp muted, loss on the bar, travel after four bars', () => {
    const s = stage('medium');
    const sidechain = s.rig.engine.sidechain;
    const score = s.rig.engine.score;
    if (sidechain === null || score === null) throw new Error('no score');
    s.runTo(s.rig.fake.currentTime + 0.3 * s.bar);
    const at = s.rig.fake.currentTime;
    expect(onBarLine(s, at)).toBe(false);
    const kicksBefore = s.rig.engine.voices().filter((v) => v.kind === 'kick').map((v) => v.startedAt);
    s.rig.engine.onLegEvent(legEvent('tombstone'));
    expect(sidechain.isDucked).toBe(true);
    expect(sidechain.stats.ducks).toBe(1);
    const line = s.barLineAfter(at + 0.2);
    // Between the event and the bar line no new kick lands (the ones already within the lookahead may).
    s.runTo(line - 0.01);
    const kicksAfter = s.rig.engine.voices().filter((v) => v.kind === 'kick').map((v) => v.startedAt);
    for (const t of kicksAfter) expect(t <= at + 0.13 || kicksBefore.includes(t), `kick at ${t}`).toBe(true);
    s.runTo(line + 4 * s.bar + 1);
    expectTimeline(s.timeline().slice(-2), [['loss', line], ['travel', line + 4 * s.bar]]);
    expect(sidechain.isDucked).toBe(false);
    // The chords' duck gain went to silence over 400 ms and came back for the section that followed.
    const chord = s.rig.engine.voices().find((v) => v.kind === 'chord');
    const duck = (chord as unknown as { duckParam: FakeParam }).duckParam;
    expect(duck.valueAt(at + 0.401)).toBeLessThan(0.001);
    expect(duck.valueAt(line + 0.06)).toBeCloseTo(1, 3);
    // The lead played the motif during loss and only then.
    const leads = s.rig.engine.voices().filter((v) => v.kind === 'lead');
    const leadStarts = leads.flatMap((v) => (v.level as unknown as FakeParam).events.filter((e) => e.kind === 'set' && e.value === 1e-4).map((e) => e.time));
    expect(leadStarts.length).toBeGreaterThan(5);
    for (const t of leadStarts) { expect(t).toBeGreaterThanOrEqual(line - 1e-9); expect(t).toBeLessThan(line + 4 * s.bar); }
    // The kick returned with travel.
    s.runTo(s.rig.fake.currentTime + s.bar);
    const kicksLater = s.rig.engine.voices().filter((v) => v.kind === 'kick').map((v) => v.startedAt);
    expect(Math.max(...kicksLater)).toBeGreaterThan(line + 4 * s.bar);
  });

  it('no change: the depot, the verge and an unavailable leg leave the music alone', () => {
    const s = stage();
    const before = s.timeline();
    const ignored = s.rig.engine.score?.conductor.stats.ignored ?? -1;
    for (const kind of ['depot_open', 'reclamation_open', 'leg_unavailable'] as const) s.rig.engine.onLegEvent(legEvent(kind));
    s.runTo(s.rig.fake.currentTime + 3 * s.bar);
    expect(s.timeline()).toEqual(before);
    expect(s.rig.engine.score?.conductor.stats.ignored).toBe(ignored + 3);
    expect(s.rig.engine.score?.current).toBe('travel');
  });

  it('panic: cuts the bar at the event, is terminal, and ends after four bars', () => {
    const s = stage();
    const score = s.rig.engine.score;
    if (score === null) throw new Error('no score');
    s.runTo(s.rig.fake.currentTime + 0.4 * s.bar);
    const at = s.rig.fake.currentTime;
    expect(onBarLine(s, at)).toBe(false);
    s.rig.engine.onLegEvent(legEvent('panic'));
    expectTimeline(s.timeline().slice(-1), [['panic', at]]);
    expect(score.current).toBe('panic');
    expect(score.conductor.isPanicked).toBe(true);
    s.rig.engine.onLegEvent(legEvent('crossing_open'));
    s.rig.engine.onDirectorEvent({ kind: 'crossing_resolved', succeeded: true, casualties: 0 });
    s.rig.engine.onLegEvent(legEvent('debrief'));
    s.runTo(at + 4 * s.bar + 1);
    expect(s.timeline().at(-1)?.section).toBe('panic');
    expect(score.current).toBeNull();
    expect(s.rig.engine.voices().filter((v) => v.busy && v.bus === 'score').length).toBe(0);
    const trim = score.trim.gain as unknown as FakeParam;
    expect(trim.valueAt(at)).toBeCloseTo(1, 6);
    expect(trim.valueAt(at + 4 * s.bar)).toBeCloseTo(0, 6);
    // The next leg lifts the panic.
    s.rig.engine.onDirectorEvent({ kind: 'leg_entered', legId: 'the_narrows', index: 4 });
    expect(score.conductor.isPanicked).toBe(false);
    expect(score.current).toBe('entry');
  });

  it('debrief: on the next bar line, looping while the card is open; Continue fades over one bar and the next leg enters after it', () => {
    const s = stage('low', 'quantum_pass');
    const score = s.rig.engine.score;
    if (score === null) throw new Error('no score');
    const asked = s.rig.fake.currentTime;
    s.rig.engine.onLegEvent(legEvent('debrief'));
    const line = s.barLineAfter(asked + 0.2);
    s.runTo(line + 3 * SECTION_BARS.debrief * s.bar);
    expectTimeline(s.timeline().slice(-1), [['debrief', line]]);
    expect(score.current).toBe('debrief');
    const exitAt = s.rig.fake.currentTime;
    s.rig.engine.onDirectorEvent({ kind: 'leg_exit' });
    expect(score.sequencer.isFading).toBe(true);
    expect(score.legId).toBeNull();
    const trim = score.trim.gain as unknown as FakeParam;
    expect(trim.valueAt(exitAt + s.bar / 2)).toBeCloseTo(0.5, 2);
    expect(trim.valueAt(exitAt + s.bar)).toBeCloseTo(0, 6);
    // The next leg arrives before the fade is over: its entry waits for the fade.
    s.rig.engine.onDirectorEvent({ kind: 'leg_entered', legId: 'the_narrows', index: 4 });
    expect(score.current).toBe('debrief');
    s.runTo(exitAt + s.bar + 0.5);
    expect(score.current).toBe('entry');
    expect(score.legId).toBe('the_narrows');
    const entry = s.timeline().at(-1);
    expect(entry?.section).toBe('entry');
    expect(entry?.time).toBeGreaterThanOrEqual(exitAt + s.bar);
    expect(trim.valueAt((entry?.time ?? 0) + 0.001)).toBeCloseTo(1, 6);
    expect(s.rig.engine.rootMidi).toBe(33);
    expect(s.rig.engine.mode).toBe('minor');
  });

  it('queue: a crossing casualty plays resolve_bad, then loss, then travel; a debrief clears what is queued', () => {
    const s = stage('high', 'allocation_yards');
    s.rig.engine.onLegEvent(legEvent('crossing_open'));
    s.runTo(s.barLineAfter(s.rig.fake.currentTime + 0.2) + 0.5 * s.bar);
    // Inside resolve, the casualty falls first, then the result comes back.
    s.rig.engine.onLegEvent(legEvent('tombstone'));
    s.rig.engine.onDirectorEvent({ kind: 'crossing_resolved', succeeded: false, casualties: 1 });
    expect([...(s.rig.engine.score?.conductor.pending ?? [])]).toEqual(['resolve_bad', 'loss']);
    s.runTo(s.rig.fake.currentTime + 10 * s.bar);
    const tail = s.timeline().map((e) => e.section).slice(-4);
    expect(tail).toEqual(['crossing', 'resolve_bad', 'loss', 'travel']);
    const times = s.timeline().slice(-3).map((e) => e.time);
    expect(times[1]! - times[0]!).toBeCloseTo(4 * s.bar, 9);
    expect(times[2]! - times[1]!).toBeCloseTo(4 * s.bar, 9);
    s.rig.engine.onLegEvent(legEvent('crossing_open'));
    s.rig.engine.onLegEvent(legEvent('tombstone'));
    s.rig.engine.onLegEvent(legEvent('debrief'));
    expect([...(s.rig.engine.score?.conductor.pending ?? [])]).toEqual(['debrief']);
    s.runTo(s.rig.fake.currentTime + 3 * s.bar);
    expect(s.timeline().at(-1)?.section).toBe('debrief');
    expect(s.timeline().map((e) => e.section).slice(-2)).toEqual(['travel', 'debrief']);
  });

  it('one-shots finish: a crossing opened during resolve_good begins when its four bars are done; entry yields', () => {
    const s = stage();
    s.rig.engine.onLegEvent(legEvent('crossing_open'));
    s.runTo(s.barLineAfter(s.rig.fake.currentTime + 0.2) + 0.5);
    s.rig.engine.onDirectorEvent({ kind: 'crossing_resolved', succeeded: true, casualties: 0 });
    const line = s.barLineAfter(s.rig.fake.currentTime + 0.2);
    s.runTo(line + 1.5 * s.bar);
    expect(s.rig.engine.score?.current).toBe('resolve_good');
    s.rig.engine.onLegEvent(legEvent('crossing_open'));
    s.runTo(line + 4 * s.bar + 1);
    expectTimeline(s.timeline().slice(-2), [['resolve_good', line], ['crossing', line + 4 * s.bar]]);

    const fresh = stage('low', 'boot_sector', false);
    fresh.runTo(fresh.t0 + 2.5 * fresh.bar);
    fresh.rig.engine.onLegEvent(legEvent('crossing_open'));
    fresh.runTo(fresh.t0 + 4 * fresh.bar);
    expectTimeline(fresh.timeline(), [['entry', fresh.t0], ['crossing', fresh.t0 + 3 * fresh.bar]]);
  });

  it('kernel events change nothing: every variant and a burst through the consumer leave the timeline as the silent run', () => {
    const control = stage('medium');
    const loud = stage('medium');
    const events: KernelEvent[] = [];
    for (const type of EVENT_TYPES) { nextTick(); events.push(sampleEvents()[type]); }
    // Panics and deadlocks are in the forty-five once each; the burst leaves them out so cues keep playing.
    const burst = randomEvents(2000, 31, 0, GLOBAL_EVENTS);
    let i = 0;
    const end = loud.rig.fake.currentTime + 12 * loud.bar;
    while (loud.rig.fake.currentTime < end) {
      const slice = i < events.length ? events.slice(i, i + 3) : burst.slice(i - events.length, i - events.length + 8);
      i += i < events.length ? 3 : 8;
      loud.rig.frame(slice);
      control.rig.frame();
    }
    expect(loud.rig.engine.consumer.stats.consumed).toBeGreaterThan(1500);
    expect(loud.rig.engine.bank.stats.played).toBeGreaterThan(100);
    expect(loud.timeline()).toEqual(control.timeline());
    expect(loud.rig.engine.score?.current).toBe('travel');
    expect(loud.rig.engine.score?.sequencer.stats.notes).toBe(control.rig.engine.score?.sequencer.stats.notes);
    expect(loud.rig.engine.score?.sequencer.stats.unplaced).toBe(0);
  });

  it('the deadlock hold and the world stop of a kernel panic leave the music alone', () => {
    const s = stage('medium');
    const score = s.rig.engine.score;
    if (score === null) throw new Error('no score');
    nextTick();
    s.rig.frame([ev('process.created', { pid: 4 as never, parent: 1 as never, name: 'a' }), ev('deadlock.detected', { report: { cycle: [], conditions: [] } as never })]);
    const at = s.rig.engine.bank.frozenUntil - DEADLOCK_HOLD_MS / 1000;
    const notesBefore = score.sequencer.stats.notes;
    s.runTo(s.rig.engine.bank.frozenUntil + 0.05);
    expect(score.sequencer.stats.notes).toBeGreaterThan(notesBefore + 4);
    // Score voices were not sustained: their gains keep moving inside the hold; the world's tone was held.
    const inside = (p: FakeParam): boolean => p.events.some((e) => e.time > at + 0.001 && e.time < s.rig.engine.bank.frozenUntil - 0.001);
    const scoreGains = s.rig.engine.voices().filter((v) => v.bus === 'score' && v.busy).map((v) => v.level as unknown as FakeParam);
    expect(scoreGains.some(inside)).toBe(true);
    const world = s.rig.engine.voices().find((v) => v.kind === 'tone' && v.bus === 'world');
    expect(world).toBeDefined();
    expect(inside(world!.level as unknown as FakeParam)).toBe(false);
    expect(score.current).toBe('travel');
    nextTick();
    s.rig.frame([ev('kernel.panic', { message: 'halt' })]);
    s.runTo(s.rig.fake.currentTime + s.bar);
    expect(score.current).toBe('travel');
    expect(s.rig.engine.voices().filter((v) => v.busy && v.bus === 'score').length).toBeGreaterThan(0);
  });

  it('budget: travel under a burst never exceeds the tier cap and never loses a score voice', () => {
    for (const tier of ['low', 'medium', 'high'] as const) {
      const s = stage(tier);
      const score = s.rig.engine.score;
      const allocator = s.rig.engine.allocator;
      if (score === null || allocator === null) throw new Error('no score');
      const events = randomEvents(1000, 17, 0, GLOBAL_EVENTS);
      let i = 0;
      while (i < events.length) {
        s.rig.frame(events.slice(i, i + 8));
        i += 8;
        expect(allocator.busyCount(s.rig.fake.currentTime), tier).toBeLessThanOrEqual(VOICE_BUDGET[tier]);
      }
      expect(allocator.stats.peak).toBeLessThanOrEqual(VOICE_BUDGET[tier]);
      // Low tier plays the guide tones and the pad's root: the extra chord and pad notes are unplaced by design,
      // never stolen from the world. Medium and high place every note.
      if (tier === 'low') expect(score.sequencer.stats.unplaced, tier).toBeGreaterThan(0);
      else expect(score.sequencer.stats.unplaced, tier).toBe(0);
      expect(score.current, tier).toBe('travel');
      for (const v of s.rig.engine.voices()) if (v.busy && v.layer) expect(v.bus, `${tier} ${v.kind}`).toBe('score');
      const kick = s.rig.engine.voices().find((v) => v.kind === 'kick');
      expect(kick?.bus).toBe('score');
    }
  });

  it('audition: any section for the tool and the probe; panic standalone ends after its four bars', () => {
    resetSequence();
    const rig = makeRig('high');
    const score = rig.engine.score;
    if (score === null) throw new Error('no score');
    expect(score.audition('quantum_pass', 'travel', 1)).toBe(true);
    const a = score.arrangement;
    if (a === null) throw new Error('no arrangement');
    const bar = barSeconds(a);
    score.scheduleUntil(1 + 2 * bar, 0);
    expect(score.conductor.timeline).toEqual([{ section: 'travel', time: 1 }]);
    expect(score.sequencer.stats.notes).toBeGreaterThan(40);
    expect(score.audition('quantum_pass', 'panic', 10)).toBe(true);
    score.scheduleUntil(10 + 5 * bar, 0);
    expect(score.current).toBeNull();
    expect(score.conductor.timeline.at(-1)).toEqual({ section: 'panic', time: 10 });
    expect(score.audition('the_void' as never, 'travel', 20)).toBe(false);
    expect(score.conductor.stats.errors).toBe(1);
  });
});

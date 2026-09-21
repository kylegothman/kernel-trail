import { describe, expect, it } from 'vitest';
import type { LegEvent } from '@game/LegRunner';
import { Score } from '../../src/audio/score/Score';
import { LOOKAHEAD_SECONDS, SCHEDULE_INTERVAL_MS } from '../../src/audio/score/Sequencer';
import { START_LEAD_SECONDS } from '../../src/audio/score/Conductor';
import { barSeconds, type Arrangement } from '../../src/audio/score/Arrangement';
import { arrangementFor } from '../../src/audio/score/material';
import type { ScoreSource } from '../../src/audio/score/source';
import { FakeContext, type FakeNode } from './fakeContext';
import { makeRig, resetSequence, type Rig } from './helpers';

/** Frames until `seconds` of the fake clock have passed. */
function runFor(rig: Rig, seconds: number): void {
  const frames = Math.ceil(seconds * 60);
  for (let i = 0; i < frames; i++) rig.frame();
}

const legEvent = (kind: LegEvent['kind']): LegEvent => ({ kind } as unknown as LegEvent);

describe('score', () => {
  it('facade: a sequencer under a conductor, silent until a leg enters, with the score bus routed through its trim', () => {
    resetSequence();
    const rig = makeRig('medium');
    const score = rig.engine.score;
    const graph = rig.engine.masterGraph;
    if (score === null || graph === null) throw new Error('no score');
    expect(score).toBeInstanceOf(Score);
    expect(score.current).toBeNull();
    expect(score.legId).toBeNull();
    rig.idle(10);
    expect(rig.engine.voices().filter((v) => v.busy && v.bus === 'score').length).toBe(0);
    expect(rig.engine.stats().scoreSection).toBeNull();
    expect(rig.engine.busInput('score')).toBe(score.trim);
    const trim = score.trim as unknown as FakeNode;
    expect(trim.connections.has(graph.buses.score.input as unknown as FakeNode)).toBe(true);
    rig.engine.onDirectorEvent({ kind: 'leg_entered', legId: 'boot_sector', index: 0 });
    rig.idle(3);
    expect(score.current).toBe('entry');
    expect(score.legId).toBe('boot_sector');
    const playing = rig.engine.voices().filter((v) => v.busy && v.bus === 'score');
    expect(playing.length).toBeGreaterThan(0);
    for (const v of playing) expect(v.layer).toBe(true);
    const panners = rig.fake.nodes.filter((n) => n.kind === 'panner' && n.connections.has(trim));
    expect(panners.length).toBe(playing.length);
  });

  it('entry then travel: eight bars of entry, then travel on the bar line, and the key follows the leg', () => {
    resetSequence();
    const rig = makeRig('medium');
    const score = rig.engine.score;
    if (score === null) throw new Error('no score');
    rig.engine.onDirectorEvent({ kind: 'leg_entered', legId: 'boot_sector', index: 0 });
    expect(rig.engine.rootMidi).toBe(41);
    expect(rig.engine.mode).toBe('major');
    const a = score.arrangement;
    if (a === null) throw new Error('no arrangement');
    expect(a.tempo).toBe(110);
    const bar = barSeconds(a);
    runFor(rig, 8 * bar + 1);
    expect(score.conductor.timeline.map((t) => t.section)).toEqual(['entry', 'travel']);
    expect(score.conductor.timeline[0]?.time).toBeCloseTo(START_LEAD_SECONDS, 9);
    expect(score.conductor.timeline[1]?.time).toBeCloseTo(START_LEAD_SECONDS + 8 * bar, 9);
    expect(score.current).toBe('travel');
    const stats = rig.engine.stats();
    expect(stats.scoreSection).toBe('travel');
    expect(stats.scoreNotes).toBeGreaterThan(20);
    expect(stats.scoreUnplaced).toBe(0);
    expect(stats.scoreErrors).toBe(0);
    rig.engine.onDirectorEvent({ kind: 'leg_exit' });
    runFor(rig, bar + 0.5);
    rig.engine.onDirectorEvent({ kind: 'leg_entered', legId: 'quantum_pass', index: 3 });
    expect(rig.engine.rootMidi).toBe(38);
    expect(rig.engine.mode).toBe('dorian');
  });

  it('pumps: every frame pumps the sequencer to its lookahead, and an injected interval pumps it when frames stop', () => {
    resetSequence();
    const rig = makeRig('low');
    const score = rig.engine.score;
    if (score === null) throw new Error('no score');
    rig.engine.onDirectorEvent({ kind: 'leg_entered', legId: 'boot_sector', index: 0 });
    const a = score.arrangement;
    if (a === null) throw new Error('no arrangement');
    // Into travel, where every sixteenth carries an arp note, so a pump is visible in the count.
    runFor(rig, 8 * barSeconds(a) + 1);
    const notes = score.sequencer.stats.notes;
    expect(notes).toBeGreaterThan(0);
    expect(score.sequencer.frontier).toBeGreaterThanOrEqual(rig.fake.currentTime);
    expect(score.sequencer.frontier).toBeLessThanOrEqual(rig.fake.currentTime + LOOKAHEAD_SECONDS + 0.2);
    // The clock moves without frames: nothing is scheduled until the next pump.
    rig.fake.advance(2);
    expect(score.sequencer.stats.notes).toBe(notes);
    rig.frame();
    expect(score.sequencer.stats.notes).toBeGreaterThan(notes);

    let tick: (() => void) | null = null;
    let stopped = false;
    let interval = 0;
    resetSequence();
    const timed = makeRig('low', { interval: (fn, ms) => { tick = fn; interval = ms; return () => { stopped = true; }; } });
    expect(interval).toBe(SCHEDULE_INTERVAL_MS);
    expect(tick).not.toBeNull();
    timed.engine.onDirectorEvent({ kind: 'leg_entered', legId: 'boot_sector', index: 0 });
    const before = timed.engine.score?.sequencer.stats.notes ?? 0;
    for (let i = 0; i < 40; i++) {
      timed.fake.advance(SCHEDULE_INTERVAL_MS / 1000);
      tick!();
    }
    expect(timed.engine.score?.sequencer.stats.notes ?? 0).toBeGreaterThan(before);
    expect(stopped).toBe(false);
    timed.engine.dispose();
    expect(stopped).toBe(true);
  });

  it('dispose: releases every score voice and the trim, and the pool goes back to zero live nodes', () => {
    resetSequence();
    const rig = makeRig('medium');
    rig.engine.onDirectorEvent({ kind: 'leg_entered', legId: 'the_narrows', index: 4 });
    rig.idle(20);
    expect(rig.engine.voices().filter((v) => v.busy && v.bus === 'score').length).toBeGreaterThan(0);
    rig.engine.dispose();
    expect(rig.fake.liveNodeCount).toBe(0);
    for (const node of rig.fake.nodes) expect(node.released, node.kind).toBe(true);
    expect(rig.engine.score).toBeNull();
    // The hooks are no-ops after dispose.
    rig.engine.onDirectorEvent({ kind: 'leg_entered', legId: 'boot_sector', index: 0 });
    rig.engine.onLegEvent(legEvent('tombstone'));
  });

  it('hooks never throw: a source that throws leaves the engine silent and counted, and a buffer section is refused', () => {
    resetSequence();
    const broken: ScoreSource = { arrangement: () => { throw new Error('no music'); } };
    const rig = makeRig('low', { scoreSource: broken });
    const score = rig.engine.score;
    if (score === null) throw new Error('no score');
    expect(() => rig.engine.onDirectorEvent({ kind: 'leg_entered', legId: 'boot_sector', index: 0 })).not.toThrow();
    expect(score.current).toBeNull();
    expect(rig.engine.stats().scoreErrors).toBe(1);
    expect(() => rig.engine.onLegEvent(legEvent('tombstone'))).not.toThrow();
    expect(() => rig.engine.onLegEvent(legEvent('panic'))).not.toThrow();
    expect(() => rig.engine.onDirectorEvent({ kind: 'crossing_resolved', succeeded: true, casualties: 0 })).not.toThrow();
    expect(() => rig.engine.onDirectorEvent({ kind: 'leg_exit' })).not.toThrow();
    expect(score.conductor.stats.ignored).toBe(4);
    rig.idle(20);
    expect(rig.engine.voices().filter((v) => v.busy && v.bus === 'score').length).toBe(0);

    const fake = new FakeContext();
    const buffer = fake.createBuffer(2, 48000, 48000);
    const buffered: ScoreSource = {
      arrangement: (legId, seed): Arrangement => {
        const a = arrangementFor(legId, seed);
        return { ...a, sections: { ...a.sections, travel: { ...a.sections.travel, body: { kind: 'buffer', buffer } } } };
      },
    };
    resetSequence();
    const rig2 = makeRig('low', { scoreSource: buffered });
    const score2 = rig2.engine.score;
    if (score2 === null) throw new Error('no score');
    rig2.engine.onDirectorEvent({ kind: 'leg_entered', legId: 'boot_sector', index: 0 });
    const a = score2.arrangement;
    if (a === null) throw new Error('no arrangement');
    runFor(rig2, 9 * barSeconds(a));
    // Entry played; the follow-on to the buffered travel was refused by name, so entry loops.
    expect(score2.current).toBe('entry');
    expect(score2.sequencer.stats.refused).toBe(1);
    expect(score2.conductor.timeline.map((t) => t.section)).toEqual(['entry', 'travel']);
    expect(rig2.engine.stats().scoreErrors).toBe(0);
  });
});

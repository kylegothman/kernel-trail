import { describe, expect, it } from 'vitest';
import type { KernelEventType } from '@kernel/types';
import { FOCUS_DURATION_MS } from '@design/motion';
import { EVENT_TREATMENT, TICK_ADSR } from '../../src/audio/events/eventSounds';
import { UI_SOUND_IDS, type UiSoundId } from '../../src/audio/ui/uiSounds';
import { KICK } from '../../src/audio/voices/KickVoice';
import { MIN_EXP_TARGET } from '../../src/audio/synth/constants';
import { pitchHz } from '../../src/audio/synth/tuning';
import { SCALES } from '../../src/audio/score/material';
import type { Voice } from '../../src/audio/voices/Voice';
import { FakeNode, type FakeParam } from './fakeContext';
import { EVENT_TYPES, makeRig, nextTick, resetSequence, sampleEvents, type Rig } from './helpers';

/** Section 5: under 400 ms, except where a WP-16 criterion or a token pins the length. Listed by name. */
const PINNED: Readonly<Partial<Record<KernelEventType | UiSoundId, string>>> = {
  'process.exited': 'the derezz, WP-16 section 6 and visual bible 9.5, per reason',
  'kernel.panic': 'the panic impact and its 900 ms of silence, WP-16 acceptance criterion 11 and PANIC_POST.floodMs',
  'disk.seek': 'proportional to distance up to 900 ms, WP-16 line 250 and the seek proportional case',
  'memory.page_evicted': 'a dirty eviction is 220 ms longer, visual bible 8.4 and the evict dirty longer case',
  'fs.corruption': 'twice CORRUPTION.rampInMs, WP-16 line 263',
  'process.starving': 'a slow detuning over DUR.ambient, WP-16 section 6',
  focusEngage: 'exactly the camera engage, FOCUS_DURATION_MS.engage',
  focusRelease: 'exactly the camera release, FOCUS_DURATION_MS.release',
};

/**
 * Which pitch of a pitched cue must sit in the key: the onset for a cue that
 * drifts away by design, the landing for one that glides in. Percussive and
 * noise cues have no pitch to check.
 */
const PITCHED: Readonly<Partial<Record<KernelEventType | UiSoundId, 'onset' | 'landing'>>> = {
  'process.created': 'landing',
  'process.starving': 'onset',
  'context.switch': 'onset',
  'memory.thrashing': 'onset',
  'sync.acquired': 'landing',
  'sync.released': 'landing',
  'sync.race_detected': 'onset',
  'deadlock.resolved': 'landing',
  'resource.granted': 'landing',
  'disk.served': 'onset',
  'io.interrupt': 'onset',
  'fs.fragmented': 'onset',
  'fs.journal': 'onset',
  'fs.recovered': 'landing',
  commandAccept: 'landing',
  alertAppear: 'onset',
  focusEngage: 'landing',
  focusRelease: 'landing',
};

const CUE_BUSES = new Set(['world', 'ui', 'voice_alerts']);

interface Cue {
  readonly voices: Voice[];
  readonly at: number;
}

/** Fire one treatment on a fresh rig and collect the cue voices it started (never the score's). */
function fire(rig: Rig, type: KernelEventType): Cue {
  rig.idle(2);
  nextTick();
  const at = rig.fake.currentTime;
  rig.frame([sampleEvents()[type]]);
  return { voices: rig.engine.voices().filter((v) => CUE_BUSES.has(v.bus) && v.startedAt >= at), at };
}

function fireUi(rig: Rig, id: UiSoundId): Cue {
  rig.idle(2);
  const at = rig.fake.currentTime;
  rig.engine.ui.play(id);
  rig.frame();
  return { voices: rig.engine.voices().filter((v) => CUE_BUSES.has(v.bus) && v.startedAt >= at), at };
}

const gainOf = (v: Voice): FakeParam => v.level as unknown as FakeParam;

/** The frequency params of the oscillators a voice owns: the ones automated at or after its start. */
function oscillatorPitches(rig: Rig, v: Voice): FakeParam[] {
  const out = gainOf(v).owner;
  const reach = new Set<FakeNode>();
  const walk = (n: FakeNode): void => { for (const c of n.connections) if (c instanceof FakeNode && !reach.has(c)) { reach.add(c); walk(c); } };
  // Oscillators feeding this voice: nodes whose path reaches the voice's output gain.
  return rig.fake.nodes
    .filter((n) => n.kind === 'oscillator')
    .filter((n) => { reach.clear(); walk(n); return reach.has(out); })
    .map((n) => n.params.find((p) => p.name === 'frequency'))
    .filter((p): p is FakeParam => p !== undefined && p.events.some((e) => e.time >= v.startedAt - 1e-9));
}

function inKey(hz: number, rootMidi: number, steps: readonly number[]): boolean {
  const midi = 69 + 12 * Math.log2(hz / 440);
  const pc = ((midi - rootMidi) % 12 + 12) % 12;
  return steps.some((s) => Math.abs(pc - s) < 0.01 || Math.abs(pc - s - 12) < 0.01 || Math.abs(pc - s + 12) < 0.01);
}

/** The onset pitch and the landing pitch of an oscillator, from its automation. */
function pitches(p: FakeParam, at: number): { onset: number; landing: number } {
  const events = [...p.events].filter((e) => e.time >= at - 1e-9).sort((a, b) => a.time - b.time);
  const onset = events.find((e) => e.kind === 'set')?.value ?? events[0]?.value ?? 0;
  const landing = events[events.length - 1]?.value ?? onset;
  return { onset, landing };
}

const SOUNDING = EVENT_TYPES.filter((t) => EVENT_TREATMENT[t] === 'sound' && t !== 'memory.page_fault' && t !== 'deadlock.detected');

describe('palette', () => {
  it('every sound treatment plays a non-silent cue, under 400 ms unless pinned by name, in the leg\'s key where pitched', () => {
    for (const legId of ['boot_sector', 'the_narrows'] as const) {
      for (const type of SOUNDING) {
        resetSequence();
        const rig = makeRig('medium');
        rig.engine.onDirectorEvent({ kind: 'leg_entered', legId, index: 0 });
        const root = rig.engine.rootMidi;
        const steps = SCALES[rig.engine.mode];
        const cue = fire(rig, type);
        expect(cue.voices.length, `${legId} ${type} plays`).toBeGreaterThan(0);
        for (const v of cue.voices) {
          const gain = gainOf(v);
          const loud = gain.events.some((e) => e.time >= cue.at && e.value > 0.01);
          expect(loud, `${legId} ${type} is non-silent`).toBe(true);
          const seconds = v.finishAt - v.startedAt;
          if (PINNED[type] === undefined) expect(seconds, `${legId} ${type} under 400 ms`).toBeLessThanOrEqual(0.4);
          else expect(Number.isFinite(seconds), `${legId} ${type} ends`).toBe(true);
          const which = PITCHED[type];
          if (which === undefined) continue;
          const oscillators = oscillatorPitches(rig, v);
          expect(oscillators.length, `${legId} ${type} has pitch`).toBeGreaterThan(0);
          for (const p of oscillators) {
            const hz = pitches(p, cue.at)[which];
            expect(inKey(hz, root, steps), `${legId} ${type} ${which} ${hz.toFixed(2)} Hz in key`).toBe(true);
          }
        }
      }
    }
  });

  it('the same cue transposes with the leg: the Boot Sector and the Narrows differ by the interval of their roots', () => {
    const hzOf = (legId: 'boot_sector' | 'the_narrows'): { hz: number; root: number } => {
      resetSequence();
      const rig = makeRig('low');
      rig.engine.onDirectorEvent({ kind: 'leg_entered', legId, index: 0 });
      const cue = fire(rig, 'disk.served');
      const p = oscillatorPitches(rig, cue.voices[0]!)[0];
      return { hz: pitches(p!, cue.at).onset, root: rig.engine.rootMidi };
    };
    const boot = hzOf('boot_sector');
    const narrows = hzOf('the_narrows');
    // The fifth of F major from F2 against the fifth of A minor from A1: eight semitones down.
    expect(narrows.root - boot.root).toBe(-8);
    expect(narrows.hz / boot.hz).toBeCloseTo(Math.pow(2, (narrows.root - boot.root) / 12), 6);
  });

  it('every UI sound is non-silent and in key where pitched, the focus pair lasts the camera\'s arcs, and keyTick is WP-16\'s', () => {
    for (const id of UI_SOUND_IDS) {
      resetSequence();
      const rig = makeRig('medium');
      rig.engine.onDirectorEvent({ kind: 'leg_entered', legId: 'quantum_pass', index: 3 });
      const root = rig.engine.rootMidi;
      const steps = SCALES[rig.engine.mode];
      const cue = fireUi(rig, id);
      expect(cue.voices.length, id).toBe(1);
      const v = cue.voices[0]!;
      expect(gainOf(v).events.some((e) => e.time >= cue.at && e.value > 0.01), `${id} is non-silent`).toBe(true);
      const seconds = v.finishAt - v.startedAt;
      if (PINNED[id] === undefined) expect(seconds, `${id} under 400 ms`).toBeLessThanOrEqual(0.4);
      if (id === 'focusEngage' || id === 'focusRelease') {
        const arc = (id === 'focusEngage' ? FOCUS_DURATION_MS.engage : FOCUS_DURATION_MS.release) / 1000;
        const glide = oscillatorPitches(rig, v)[0]!.events.find((e) => e.kind === 'linear');
        expect(glide?.time, id).toBeCloseTo(cue.at + 0.005 + arc, 6);
      }
      const which = PITCHED[id];
      if (which !== undefined) {
        for (const p of oscillatorPitches(rig, v)) expect(inKey(pitches(p, cue.at)[which], root, steps), `${id} in key`).toBe(true);
      }
      if (id === 'keyTick') {
        // Untouched: the minor pentatonic's ninth degree three octaves up, WP-16's terminal tick, at its gain.
        const expected = pitchHz(root, 9, 3);
        const p = oscillatorPitches(rig, v);
        expect(p.some((q) => Math.abs(pitches(q, cue.at).onset - expected) < 1e-6), 'keyTick pitch').toBe(true);
        expect(p.some((q) => Math.abs(pitches(q, cue.at).onset - expected * 2) < 1e-6), 'keyTick octave').toBe(true);
        const peak = gainOf(v).events.filter((e) => e.kind === 'exp').map((e) => e.value);
        expect(Math.max(...peak)).toBeCloseTo(0.07, 9);
      }
    }
  });

  it('percussive cues share the kick\'s transient: the tick envelope is the click\'s attack and decay', () => {
    expect(TICK_ADSR.attack).toBe(0.001);
    expect(TICK_ADSR.decay).toBe(KICK.clickSeconds);
    for (const type of ['disk.served', 'io.interrupt', 'fs.journal', 'context.switch'] as const) {
      resetSequence();
      const rig = makeRig('low');
      const cue = fire(rig, type);
      const v = cue.voices[0]!;
      const events = gainOf(v).events.filter((e) => e.time >= v.startedAt - 1e-9).sort((a, b) => a.time - b.time);
      const attackEnd = events.find((e) => e.kind === 'exp');
      const decayEnd = events.filter((e) => e.kind === 'exp')[1];
      expect(attackEnd?.time, type).toBeCloseTo(v.startedAt + 0.001, 6);
      expect(decayEnd?.time, type).toBeCloseTo(v.startedAt + 0.001 + KICK.clickSeconds, 6);
    }
  });

  it('nothing is unshaped noise: every noise source reaches the bus through a band-pass or a low-pass', () => {
    resetSequence();
    const rig = makeRig('high');
    for (const type of ['memory.page_evicted', 'disk.seek', 'io.dma_transfer', 'fs.corruption', 'process.exited', 'kernel.panic'] as const) {
      nextTick();
      rig.frame([sampleEvents()[type]]);
    }
    const sources = rig.fake.nodes.filter((n) => n.kind === 'bufferSource');
    expect(sources.length).toBeGreaterThan(10);
    for (const source of sources) {
      const next = [...source.connections].filter((c): c is FakeNode => c instanceof FakeNode);
      expect(next.length, 'a source connects onward').toBeGreaterThan(0);
      // The first node after a noise source is a filter, or a grain gain that feeds one.
      for (const n of next) {
        const shaped = n.kind === 'biquad' || [...n.connections].some((c) => c instanceof FakeNode && c.kind === 'biquad');
        expect(shaped, `${n.kind} after a noise source`).toBe(true);
      }
    }
    // The sweeps sit on the root's harmonics: the seek climbs from eight times the root to eighteen.
    const root = 440 * Math.pow(2, (rig.engine.rootMidi - 69) / 12);
    const seek = rig.engine.voices().find((v) => v.kind === 'noise' && v.bus === 'world');
    const centre = (seek as unknown as { filterParam: FakeParam }).filterParam;
    const values = centre.events.map((e) => e.value);
    expect(values.some((v) => Math.abs(v - root * 8) < 1e-6 || Math.abs(v - root * 18) < 1e-6 || Math.abs(v - root * 24) < 1e-6 || Math.abs(v - root * 16) < 1e-6 || Math.abs(v - root * 6) < 1e-6)).toBe(true);
    expect(MIN_EXP_TARGET).toBe(1e-4);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../kernel/sourceScan';
import { AudioEngine } from '../../src/audio/AudioEngine';
import { AudioAdapter, platformContextFactory } from '../../src/audio/context';
import { DEFAULT_SAMPLE_RATE } from '../../src/audio/buffers';
import { BUS_IDS } from '../../src/audio/voices/Voice';
import { LIMITER, IMPULSE_SECONDS } from '../../src/audio/synth/constants';
import { FakeContext, FakeNode, type FakeNodeKind } from './fakeContext';
import { makeRig, randomEvents, resetSequence, sampleEvents } from './helpers';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git', '.stale', 'coverage'].includes(entry.name)) continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
}

function kindsAlong(from: FakeNode, stop: FakeNodeKind): FakeNodeKind[] {
  const path: FakeNodeKind[] = [from.kind];
  let node: FakeNode = from;
  for (let guard = 0; guard < 10 && node.kind !== stop; guard++) {
    const candidates = [...node.connections].filter((n): n is FakeNode => n instanceof FakeNode);
    // Follow the dry path: a compressor when one is offered, else the gain
    // that feeds a compressor (the master), else whatever remains.
    const next = candidates.find((n) => n.kind === 'compressor')
      ?? candidates.find((n) => n.kind === 'gain' && [...n.connections].some((m) => m instanceof FakeNode && m.kind === 'compressor'))
      ?? candidates.find((n) => n.kind === stop);
    if (next === undefined) break;
    path.push(next.kind);
    node = next;
  }
  return path;
}

describe('graph', () => {
  it('master chain order: voices, bus gain, bus compressor, master gain, limiter, destination', () => {
    resetSequence();
    const { engine, fake } = makeRig('high');
    const graph = engine.masterGraph;
    expect(graph).not.toBeNull();
    if (graph === null) return;
    engine.ui.keyTick();
    const busInput = graph.buses.ui.input as unknown as FakeNode;
    const panners = fake.nodes.filter((n) => n.kind === 'panner' && n.connections.has(busInput));
    expect(panners.length).toBeGreaterThan(0);
    expect(kindsAlong(busInput, 'destination')).toEqual(['gain', 'compressor', 'gain', 'compressor', 'destination']);
    expect((graph.limiter as unknown as FakeNode).connections.has(fake.destination)).toBe(true);
  });

  it('four buses, each with an independent gain', () => {
    const { engine } = makeRig('medium');
    const graph = engine.masterGraph;
    if (graph === null) throw new Error('graph missing');
    expect(Object.keys(graph.buses).sort()).toEqual([...BUS_IDS].sort());
    const gains = new Set(BUS_IDS.map((b) => graph.buses[b].input));
    expect(gains.size).toBe(4);
    graph.setBusGain('score', 0.2, 5, 0.09);
    const scoreGain = graph.buses.score.input.gain as unknown as { events: unknown[] };
    const worldGain = graph.buses.world.input.gain as unknown as { events: unknown[] };
    expect(scoreGain.events.length).toBeGreaterThan(worldGain.events.length);
  });

  it('limiter config: ratio 20, knee 0, attack 0.003, and no automation is ever scheduled on it', () => {
    resetSequence();
    const rig = makeRig('medium');
    const graph = rig.engine.masterGraph;
    if (graph === null) throw new Error('graph missing');
    expect(graph.limiter.ratio.value).toBe(LIMITER.ratio);
    expect(graph.limiter.knee.value).toBe(0);
    expect(graph.limiter.attack.value).toBe(0.003);
    const events = randomEvents(1000, 3);
    for (let i = 0; i < events.length; i += 10) rig.frame(events.slice(i, i + 10));
    rig.engine.ui.alertAppear();
    rig.engine.applySettings({ ...rig.engine.settings, master: 0.3, mute: true });
    const limiter = graph.limiter as unknown as FakeNode;
    for (const p of limiter.params) {
      expect(p.automationCalls, p.name).toBe(0);
      expect(p.events.length, p.name).toBe(0);
    }
  });

  it('convolver by tier: 1.8 s at high, 0.9 s at medium, a delay pair at low', () => {
    const high = makeRig('high');
    const medium = makeRig('medium');
    const low = makeRig('low');
    const sr = high.fake.sampleRate;
    const highSpace = high.engine.masterGraph?.space;
    const mediumSpace = medium.engine.masterGraph?.space;
    const lowSpace = low.engine.masterGraph?.space;
    expect(highSpace?.kind).toBe('convolver');
    expect(mediumSpace?.kind).toBe('convolver');
    expect(lowSpace?.kind).toBe('delay');
    if (highSpace?.kind === 'convolver') expect(highSpace.node.buffer?.length).toBe(Math.round(sr * IMPULSE_SECONDS.high));
    if (mediumSpace?.kind === 'convolver') expect(mediumSpace.node.buffer?.length).toBe(Math.round(sr * IMPULSE_SECONDS.medium));
    expect(low.fake.constructions.convolver).toBe(0);
    expect(low.fake.constructions.delay).toBe(2);
    expect(high.fake.constructions.convolver).toBe(1);
  });

  it('lazy context: nothing is constructed at import or at engine construction', () => {
    let factoryCalls = 0;
    const fake = new FakeContext();
    const engine = new AudioEngine({ tier: 'low', seed: 1, contextFactory: () => { factoryCalls += 1; return fake; }, reducedMotionProbe: () => false });
    expect(factoryCalls).toBe(0);
    expect(engine.adapter.contextConstructions).toBe(0);
    expect(engine.state).toBe('unstarted');
    expect(fake.nodeConstructions).toBe(0);
    engine.push([sampleEvents()['process.created']]);
    engine.frame();
    expect(engine.bank.stats.dropped).toBeGreaterThan(0);
    expect(factoryCalls).toBe(0);
    engine.unlock();
    expect(factoryCalls).toBe(1);
    expect(engine.state).toBe('running');
    expect(typeof AudioContext).toBe('undefined');
  });

  it('failed context: state is failed and every later call is a silent no-op', () => {
    const engine = new AudioEngine({ tier: 'low', seed: 1, contextFactory: () => { throw new Error('no device'); }, reducedMotionProbe: () => false });
    engine.unlock();
    expect(engine.state).toBe('failed');
    expect(engine.adapter.failureReason).toBe('no device');
    expect(() => {
      engine.unlock();
      engine.push(randomEvents(200, 2, 7));
      engine.frame();
      engine.ui.commandAccept();
      engine.applySettings({ ...engine.settings, mute: true });
      engine.setRoot(50);
      engine.setConvoyPids([]);
      engine.resetForLeg();
    }).not.toThrow();
    expect(engine.stats().state).toBe('failed');
    expect(engine.adapter.contextConstructions).toBe(1);
    expect(engine.consumer.stats.errors).toBe(0);
  });

  it('suspended resume: a statechange to suspended stops scheduling and the next gesture resumes', () => {
    resetSequence();
    const rig = makeRig('low');
    const before = rig.engine.bank.stats.played;
    rig.engine.ui.keyTick();
    expect(rig.engine.bank.stats.played).toBe(before + 1);
    rig.fake.suspendExternally('suspended');
    expect(rig.engine.state).toBe('suspended');
    rig.engine.ui.keyTick();
    expect(rig.engine.bank.stats.played).toBe(before + 1);
    expect(rig.engine.bank.stats.dropped).toBe(1);
    rig.engine.unlock();
    expect(rig.engine.state).toBe('running');
    rig.engine.ui.keyTick();
    expect(rig.engine.bank.stats.played).toBe(before + 2);
    rig.fake.suspendExternally('interrupted');
    expect(rig.engine.state).toBe('suspended');
    expect(rig.engine.adapter.contextConstructions).toBe(1);
  });

  it('boundaries: no fetch, no three, no DOM beyond the context and matchMedia; kernel and game type-only', () => {
    const files = walk('src/audio').filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(20);
    const forbidden = /\b(fetch|document|window|navigator|localStorage|indexedDB|addEventListener|XMLHttpRequest|Worker|requestAnimationFrame|setTimeout|setInterval|Date|performance)\b|Math\s*\.\s*random|Math\s*\[/;
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'), false);
      expect(code, file).not.toMatch(forbidden);
      expect(code, file).not.toMatch(/from\s*['"]three/);
      // WP-17 pre-flight ruling 4 (2026-09-15): the audio layer holds exactly
      // one value import from the world layer, the shared per-frame queue.
      for (const m of code.matchAll(/(?:from\s*|import\s*\()['"](@world[^'"]*)['"]/g)) {
        expect(m[1], `${file}: world import`).toBe('@world/FrameEventQueue');
      }
      expect(code, file).not.toMatch(/(?:from\s*|import\s*\()['"](?:@(?:render|ui|terminal|legs|app)\b|(?:\.\.\/)+(?:world|render|ui|terminal|legs|app|kernel|game)\/)/);
      for (const m of code.matchAll(/^\s*import\s+([^;]+?)\s+from\s*['"](@kernel[^'"]*|@game[^'"]*|[^'"]*\/(?:kernel|game)\/[^'"]*)['"]/gm)) {
        const clause = m[1] ?? '';
        const spec = m[2] ?? '';
        if (clause.startsWith('type ')) continue;
        expect(spec, `${file}: value import ${clause}`).toBe('@kernel/index');
        expect(clause.replace(/[{}\s]/g, ''), file).toBe('createRng');
      }
      // WP-25 (S7): static imports from the game layer are type-only, held by the loop above (criterion 6). The
      // two routes that loop cannot see, a re-export and a dynamic import, are closed here.
      expect(code, file).not.toMatch(/export\s[^;]*from\s*['"]@game/);
      expect(code, file).not.toMatch(/import\s*\(\s*['"]@game/);
      const platform = [...code.matchAll(/^\s*import\s+([^;]+?)\s+from\s*['"]@platform[^'"]*['"]/gm)];
      for (const m of platform) expect((m[1] ?? '').startsWith('type '), `${file}: platform must be type-only`).toBe(true);
    }
    const contextSource = stripComments(readFileSync('src/audio/context.ts', 'utf8'), false);
    expect(contextSource).toMatch(/typeof AudioContext === 'undefined'/);
  });

  it('no audio files: no media extension anywhere in the repository and no data:audio in source', () => {
    const files = walk('.');
    const media = files.filter((f) => /\.(wav|mp3|ogg|m4a|flac|aac)$/i.test(f));
    expect(media).toEqual([]);
    const shipping = [...walk('src'), 'index.html', 'package.json'].filter((f) => /\.(ts|tsx|js|mjs|html|css|json)$/.test(f));
    expect(shipping.length).toBeGreaterThan(50);
    for (const file of shipping) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/data:audio|\.(wav|mp3|ogg|m4a|flac|aac)['"]/i);
    }
  });

  it('adapter: interrupted maps to suspended and closed to failed', () => {
    const fake = new FakeContext({ initialState: 'suspended' });
    const adapter = new AudioAdapter(() => fake);
    adapter.unlock();
    expect(adapter.state).toBe('running');
    fake.suspendExternally('interrupted');
    expect(adapter.state).toBe('suspended');
    adapter.unlock();
    expect(adapter.state).toBe('running');
    fake.suspendExternally('closed');
    expect(adapter.state).toBe('failed');
    adapter.unlock();
    expect(adapter.contextConstructions).toBe(1);
  });
});

/**
 * WP-23: the Ubuntu CI runner opens audio at 44100 Hz. The buffer set is
 * baked at DEFAULT_SAMPLE_RATE and Chrome refuses a convolver impulse at
 * another rate, so the graph never built and every cue was dropped with
 * the adapter reporting running and no reason. Two things keep that fixed:
 * the platform factory pins the context to the buffers' rate, and a build
 * failure is recorded on the adapter so silence has a reason.
 */
describe('sample rate (WP-23)', () => {
  it('the platform factory asks the browser for a context at the buffer rate', () => {
    const requested: unknown[] = [];
    class RecordingContext {
      readonly sampleRate: number;
      readonly state = 'running';
      readonly destination = {};
      onstatechange = null;
      constructor(options: { sampleRate?: number }) { requested.push(options); this.sampleRate = options.sampleRate ?? 44100; }
    }
    const previous = (globalThis as { AudioContext?: unknown }).AudioContext;
    (globalThis as { AudioContext?: unknown }).AudioContext = RecordingContext;
    try {
      const context = platformContextFactory();
      expect(requested).toEqual([{ latencyHint: 'interactive', sampleRate: DEFAULT_SAMPLE_RATE }]);
      expect(context.sampleRate).toBe(DEFAULT_SAMPLE_RATE);
    } finally {
      if (previous === undefined) delete (globalThis as { AudioContext?: unknown }).AudioContext;
      else (globalThis as { AudioContext?: unknown }).AudioContext = previous;
    }
  });

  it('builds the graph at the pinned rate with no failure, and at 44100 records why it did not', () => {
    const pinned = makeRig('high', { contextFactory: () => new FakeContext({ sampleRate: DEFAULT_SAMPLE_RATE }) });
    expect(pinned.engine.ready).toBe(true);
    expect(pinned.engine.adapter.failureReason).toBeNull();
    pinned.engine.dispose();
    const mismatched = makeRig('high', { contextFactory: () => new FakeContext({ sampleRate: 44100 }) });
    expect(mismatched.engine.ready).toBe(false);
    expect(mismatched.engine.state).toBe('running');
    expect(mismatched.engine.adapter.failureReason).toMatch(/^build: .*44100/);
    mismatched.engine.dispose();
  });
});

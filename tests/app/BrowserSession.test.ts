// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Group, InstancedMesh, Mesh, PerspectiveCamera, PlaneGeometry, Scene, WebGPURenderer } from 'three/webgpu';
import { createBrowserSession, type BrowserSession } from '@app/BrowserSession';
import type { BootContext } from '@app/boot';
import { LAYER, MIN_GLYPH_PX, TYPE_SCALE } from '@design';
import { AudioEngine } from '@audio/AudioEngine';
import { AudioAdapter } from '@audio/context';
import { CommandBus } from '@game/CommandBus';
import { DB_NAME, Database } from '@game/save';
import { readCodexProfile } from '@game/persist/SaveService';
import { LEG_ORDER, type LegId, type SaveFile } from '@game/types';
import { isEnvelope } from '@game/workers/protocol';
import type { LegContent, LegModule } from '@legs/content';
import { layoutStage } from '@legs/layout';
import { PROFILES, type RenderCapabilities } from '@platform';
import { ThreeUnifiedBackend, type DeviceLostInfo } from '@render/RendererBackend';
import { PostChain } from '@render/postChain';
import { createLabelPlateMaterial } from '@render/materials';
import * as labelModule from '@render/materials/holoLabel';
import { DEREZZ_TIMING } from '@render/derezz/variants';
import { SdfAtlas } from '@world/labels/SdfAtlas';
import { Codex } from '@ui/codex/Codex';
import { SCHED_DEF } from '@terminal/commands/scheduler';
import { createSyntheticLeg, SYNTHETIC_CHAPTER } from '../game/fixtures/syntheticLeg';
import { FakeContext } from '../audio/fakeContext';

// Production resolution is replaced only at its imported boundary. The session
// itself receives its approved loaders override and otherwise builds real modules.
vi.mock('@legs/registry', () => ({ LEG_LOADERS: {} }));

const caps: RenderCapabilities = {
  backend: 'webgl2', compute: false, storageBuffers: false, maxSamples: 4,
  float32Filterable: true, float16Renderable: true, hdr: true,
  maxTextureSize: 8192, maxInstances: 65536, timestampQuery: false,
  deviceMemoryGb: 8, hardwareConcurrency: 8, adapterLabel: 'Node session fixture',
  isIntegrated: true, prefersReducedMotion: false, devicePixelRatio: 1,
};

/** The real handle talks to a browser Worker; this boundary returns the known placeholder failure. */
class FixtureWorker {
  static readonly instances: FixtureWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  constructor(readonly url: string | URL, readonly options?: WorkerOptions) { FixtureWorker.instances.push(this); }
  postMessage(message: unknown): void {
    if (!isEnvelope(message) || message.kind !== 'replay') return;
    queueMicrotask(() => {
      if (!this.terminated) this.onmessage?.(new MessageEvent('message', { data: {
        id: message.id, kind: 'done', payload: { ok: false, reason: 'error', message: 'Headless fixture is not installed in the worker.' },
      } }));
    });
  }
  terminate(): void { this.terminated = true; }
}

class FrameClock {
  now = 0;
  private next = 1;
  private readonly scheduled = new Map<number, FrameRequestCallback>();
  install(): void {
    vi.spyOn(performance, 'now').mockImplementation(() => this.now);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
      const id = this.next++; this.scheduled.set(id, callback); return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number): void => { this.scheduled.delete(id); });
  }
  frames(count: number, milliseconds = 1000 / 60): void {
    for (let i = 0; i < count; i++) {
      this.now += milliseconds;
      const current = [...this.scheduled]; this.scheduled.clear();
      for (const [, callback] of current) callback(this.now);
    }
  }
  get pending(): number { return this.scheduled.size; }
}

const sessions: BrowserSession[] = [];
const boots: BootContext[] = [];
let clock: FrameClock;

function resetDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

beforeEach(async () => {
  document.body.replaceChildren();
  await resetDatabase();
  clock = new FrameClock(); clock.install();
  FixtureWorker.instances.length = 0;
  vi.stubGlobal('Worker', FixtureWorker);
  vi.spyOn(AudioEngine.prototype, 'unlock').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  // The application deliberately leaves SaveService on the main thread. Let its
  // pending IndexedDB transactions finish before closing the fixture database.
  for (let i = 0; i < 10; i++) await new Promise<void>(resolve => setImmediate(resolve));
  for (const boot of boots.splice(0)) boot.dispose();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  await resetDatabase();
});

async function fixtureBoot() {
  const canvas = document.createElement('canvas'); canvas.id = 'stage';
  const overlay = document.createElement('div'); overlay.id = 'overlay';
  document.body.append(canvas, overlay);
  const backend = new ThreeUnifiedBackend(caps);
  const post = new PostChain({ renderer: new WebGPURenderer({ canvas, forceWebGL: true }), scene: new Scene(), camera: new PerspectiveCamera(), tier: 'low', profile: PROFILES.low, capabilities: caps });
  vi.spyOn(post, 'resize').mockImplementation(() => undefined);
  vi.spyOn(backend, 'postChain', 'get').mockReturnValue(post);
  const rendered: Scene[] = [];
  const render = vi.spyOn(backend, 'renderFrame').mockImplementation(frame => { rendered.push(frame.scene); });
  const lossListeners = new Set<(info: DeviceLostInfo) => void>();
  vi.spyOn(backend, 'onDeviceLost').mockImplementation(listener => {
    lossListeners.add(listener); return () => { lossListeners.delete(listener); };
  });
  const loseDevice = (): void => { for (const listener of lossListeners) listener({ reason: 'Fixture device loss' }); };
  const db = new Database(); await db.open();
  const boot: BootContext = {
    buildId: 'dev', caps, tier: 'low', backend, canvas, db, overlay,
    dispose() { post.dispose(); backend.dispose(); db.close(); overlay.remove(); canvas.remove(); },
  };
  boots.push(boot);
  return { boot, rendered, render, loseDevice, lossListeners };
}

function moduleFor(id: LegId, index: number): LegModule {
  const base = createSyntheticLeg({ id, index, processes: 2, service: [2000, 2001] });
  const content: LegContent = {
    legId: id,
    crossings: [{ id: 'fixture-vault', legId: id, lockId: 'vault', kind: 'mutex', ordered: false, anchor: 'vault', crosser: 'lumen' }],
    interactions: { inspect: { target: null, run: run => { run.objectivesMet.push('fixture.inspect'); } } },
    epitaphs: [], terminalHandlers: {},
    codex: index === 0 ? [] : [{
      id: 'fixture.ps', title: 'Reading the process table', chapter: SYNTHETIC_CHAPTER,
      concept: 'The process table lists the current processes.', unlock: { kind: 'command', name: 'ps' },
      workedExample: null, counterfactual: null, remedy: null, remedyVisibility: 'immediate', related: [], commands: ['ps'], epitaphs: [],
    }],
    layout: {
      anchors: [{ id: 'vault', kind: 'slab', position: [0, 0, -8] }, { id: 'console', kind: 'stele', position: [4, 0, 0] }],
      cameraTargets: ['vault'], extras: ['console'],
    },
  };
  return { content, default: {
    ...base, title: index === 0 ? 'Browser fixture entry' : 'Browser fixture travel',
    terminalCommands: [SCHED_DEF],
    objectives: [{ id: 'fixture.inspect', statement: 'Inspect the vault.', chapter: SYNTHETIC_CHAPTER, assessedBy: 'decision' }],
    interactions: [{ id: 'inspect', label: 'Inspect vault', description: 'Inspect the fixture vault.', anchor: 'vault', cost: { cycles: 2 }, enabledWhen: () => true }],
    createStage: () => layoutStage(content.layout),
  } };
}

function buttonIn(root: ParentNode, label: string): HTMLButtonElement {
  const button = [...root.querySelectorAll('button')].find(candidate => candidate.textContent === label);
  if (button === undefined) throw new Error(`Missing button ${label}`);
  return button;
}

async function startTravel() {
  const f = await fixtureBoot();
  const bootLeg = moduleFor('boot_sector', 0);
  const travelLeg = moduleFor('fork_fields', 1);
  const loaders = { boot_sector: vi.fn(async () => bootLeg), fork_fields: vi.fn(async () => travelLeg) };
  const pending = createBrowserSession(f.boot, { kind: 'new', seed: 42, discClass: 'shell', difficulty: 'novice' }, { loaders });
  expect(AudioEngine.prototype.unlock).toHaveBeenCalledTimes(1);
  const session = await pending; sessions.push(session);
  // The synthetic opening has no player gate. Exit records its zero-segment completion.
  session.runner.exit();
  clock.frames(1);
  const debrief = f.boot.overlay.querySelector('.kt-card--debrief');
  if (debrief === null) throw new Error('Boot fixture did not produce its debrief');
  buttonIn(debrief, 'Continue').click();
  await vi.waitFor(() => expect(session.runner.currentLeg?.id).toBe('fork_fields'));
  clock.frames(1);
  return { ...f, session, loaders, travelLeg };
}

async function resumeFixture(first: Awaited<ReturnType<typeof startTravel>>, file: SaveFile) {
  first.session.dispose();
  const next = await fixtureBoot();
  const session = await createBrowserSession(next.boot, { kind: 'resume', file }, { loaders: first.loaders });
  sessions.push(session); clock.frames(1);
  return { ...next, session };
}

function terminalSubmit(overlay: HTMLElement, line: string): void {
  const input = overlay.querySelector<HTMLInputElement>('input[aria-label="terminal input"]');
  if (input === null) throw new Error('Missing terminal input');
  input.value = line;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

describe('browser session assembly', () => {
  it('makes interactions yield to a debrief and restores them on the next leg', async () => {
    const f = await fixtureBoot();
    const bootLeg = moduleFor('boot_sector', 0);
    const travelLeg = moduleFor('fork_fields', 1);
    const session = await createBrowserSession(f.boot, { kind: 'new', seed: 42, discClass: 'shell', difficulty: 'novice' }, {
      loaders: { boot_sector: async () => bootLeg, fork_fields: async () => travelLeg },
    });
    sessions.push(session); clock.frames(1);
    expect(f.boot.overlay.querySelector<HTMLElement>('.kt-panel--interactions')?.hidden).toBe(false);
    session.runner.exit(); clock.frames(1);
    const card = f.boot.overlay.querySelector('.kt-card--debrief');
    if (card === null) throw new Error('Expected a debrief');
    expect(f.boot.overlay.querySelector<HTMLElement>('.kt-panel--interactions')?.hidden).toBe(true);
    buttonIn(card, 'Continue').click();
    await vi.waitFor(() => { clock.frames(1); expect(session.runner.currentLeg?.id).toBe('fork_fields'); });
    clock.frames(1);
    expect(f.boot.overlay.querySelector('.kt-card--debrief')).toBeNull();
    expect(f.boot.overlay.querySelector<HTMLElement>('.kt-panel--interactions')?.hidden).toBe(false);
  });

  it('stops the session and shows a panic card when resize recovery fails', async () => {
    const f = await startTravel();
    f.boot.overlay.dispatchEvent(new CustomEvent('kt:render-failure', { detail: 'Resize recovery failed' }));
    clock.frames(1);
    expect(f.boot.overlay.querySelector('.kt-card--panic')?.textContent).toContain('Resize recovery failed');
    const tick = f.session.runner.kernel?.tick;
    clock.frames(120);
    expect(f.session.runner.kernel?.tick).toBe(tick);
  });

  it('builds one visible structure per anchor and advances the kernel over 120 real host frames', async () => {
    const f = await startTravel();
    const before = f.session.runner.kernel?.tick ?? 0;
    clock.frames(120);
    expect(f.session.runner.kernel?.tick).toBeGreaterThan(before + 35);
    const scene = f.rendered.at(-1);
    if (scene === undefined) throw new Error('No scene rendered');
    const roots = scene.getObjectByName('kt.structures')?.children ?? [];
    expect(roots.filter(root => root.name.endsWith('.root'))).toHaveLength(f.travelLeg.content.layout.anchors.length);
    expect(f.boot.overlay.textContent).toContain('Browser fixture travel');
    expect(f.loaders.boot_sector).toHaveBeenCalledTimes(1);
    expect(f.loaders.fork_fields).toHaveBeenCalledTimes(1);
  });

  it('opens crossing choices through the public leg event, records resolution, and continues travel', async () => {
    const f = await startTravel();
    const crossing = f.travelLeg.content.crossings[0];
    if (crossing === undefined) throw new Error('Missing fixture crossing');
    f.session.runner.openCrossing(crossing);
    expect(f.boot.overlay.querySelector('.kt-panel--crossing')).toBeNull();
    clock.frames(1);
    const panel = f.boot.overlay.querySelector('.kt-panel--crossing');
    if (panel === null) throw new Error('Crossing event did not open its panel');
    expect(panel.textContent).toMatch(/C = \d+\.\d{2}/);
    buttonIn(panel, 'Choose block').click(); clock.frames(1);
    expect(f.session.runner.saveProvisional().run.decisions.some(record => record.kind === 'crossing')).toBe(true);
    buttonIn(panel, 'Continue').click(); clock.frames(1);
    expect(f.boot.overlay.querySelector('.kt-panel--crossing')).toBeNull();
    expect(f.session.runner.phase).toBe('travelling');
  });

  it('opens depot and reclamation models from explicit controls and records their decisions', async () => {
    const f = await startTravel();
    buttonIn(f.boot.overlay, 'Open depot').click(); clock.frames(1);
    const depot = f.boot.overlay.querySelector('.kt-panel--depot');
    if (depot === null) throw new Error('Depot control did not open a panel');
    expect(depot.textContent).toContain('Depot open. Cycles accepted. Nothing here is a favour.');
    buttonIn(depot, 'Buy quota_lot').click(); clock.frames(1);
    expect(f.session.runner.saveProvisional().run.decisions.some(record => record.kind === 'depot')).toBe(true);
    buttonIn(depot, 'Leave').click(); clock.frames(1);
    expect(f.boot.overlay.querySelector('.kt-panel--depot')).toBeNull();
    buttonIn(f.boot.overlay, 'Open reclamation').click(); clock.frames(1);
    const reclamation = f.boot.overlay.querySelector('.kt-panel--reclamation');
    if (reclamation === null) throw new Error('Reclamation control did not open a panel');
    buttonIn(reclamation, 'Sweep').click(); clock.frames(1);
    expect(reclamation.textContent).toContain('Yield:');
    expect(f.session.runner.saveProvisional().run.decisions.some(record => record.kind === 'reclamation')).toBe(true);
    expect(f.session.runner.phase).toBe('travelling');
    buttonIn(reclamation, 'Close').click(); clock.frames(1);
    expect(f.boot.overlay.querySelector('.kt-panel--reclamation')).toBeNull();
  });

  it('prints ps, forwards command signals to codex, and records terminal mutation provenance', async () => {
    const f = await startTravel();
    const signals = vi.spyOn(Codex.prototype, 'signal');
    const commands = vi.spyOn(CommandBus.prototype, 'apply');
    terminalSubmit(f.boot.overlay, 'ps'); clock.frames(1);
    expect(f.boot.overlay.querySelector('.kt-terminal-output')?.textContent).toMatch(/PID|pid/);
    expect(signals).toHaveBeenCalledWith({ kind: 'command', name: 'ps', argv: [] });
    terminalSubmit(f.boot.overlay, 'sched --policy srtf'); clock.frames(4);
    expect(commands).toHaveBeenCalledWith(expect.objectContaining({ kind: 'set_scheduler', to: 'srtf' }), { source: 'terminal', legId: 'fork_fields' }, expect.any(Number));
    const saved = f.session.runner.saveProvisional();
    expect(saved.run.decisions.some(record => record.kind === 'set_scheduler' && record.choice.startsWith('[terminal] '))).toBe(true);
    await vi.waitFor(async () => expect((await readCodexProfile(f.boot.db)).seen).toContain('fixture.ps'));
  });

  it('shows a casualty tombstone and removes it when the release time expires', async () => {
    const f = await startTravel();
    clock.frames(6);
    const member = f.session.runner.saveProvisional().run.convoy.find(candidate => candidate.id === 'lumen');
    if (member?.pid === null || member?.pid === undefined) throw new Error('Lumen has no bound process');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    terminalSubmit(f.boot.overlay, `kill ${member.pid}`); clock.frames(4);
    expect(f.boot.overlay.querySelector('.kt-card--tombstone')?.textContent).toContain('LUMEN');
    await vi.advanceTimersByTimeAsync(DEREZZ_TIMING.convoy.release + 1);
    clock.frames(1, DEREZZ_TIMING.convoy.release + 1);
    expect(f.boot.overlay.querySelector('.kt-card--tombstone')).toBeNull();
  });

  it('shows the unavailable-leg card when the registry loader rejects', async () => {
    const f = await fixtureBoot();
    const session = await createBrowserSession(f.boot, { kind: 'new', seed: 2, discClass: 'shell', difficulty: 'novice' }, {
      loaders: { boot_sector: async () => { throw new Error('Fixture leg absent'); } },
    });
    sessions.push(session); clock.frames(1);
    expect(f.boot.overlay.querySelector('.kt-card--unavailable')?.textContent).toContain('Fixture leg absent');
    expect(buttonIn(f.boot.overlay, 'Skip')).toBeDefined();
  });

  it('loads the three authored layouts and skips every unavailable leg between their boundaries', async () => {
    // Replace font shaping at its browser boundary, retaining the real atlas,
    // focus rig, structure creation, batches and disposal for each companion.
    const labels: Awaited<ReturnType<typeof labelModule.holoLabel>>[] = [];
    vi.spyOn(labelModule, 'holoLabel').mockImplementation(async (_text, _semantic, _tier, capHeight) => {
      const object = new Group();
      const geometry = new PlaneGeometry(1, capHeight);
      const mesh = new Mesh(geometry, createLabelPlateMaterial());
      mesh.layers.set(LAYER.TEXT); object.add(mesh);
      const asset = {
        object, mesh, minimumDevicePixels: MIN_GLYPH_PX, microRem: TYPE_SCALE.micro.sizeRem,
        dispose: vi.fn(() => { geometry.dispose(); mesh.material.dispose(); object.removeFromParent(); }),
      };
      labels.push(asset);
      return asset;
    });
    const [bootLeg, quantumLeg, allocationLeg] = await Promise.all([
      import('@legs/boot_sector'), import('@legs/quantum_pass'), import('@legs/allocation_yards'),
    ]);
    const requested: LegId[] = [];
    const loaders: Partial<Record<LegId, () => Promise<LegModule>>> = {};
    for (const id of LEG_ORDER) loaders[id] = async () => {
      requested.push(id);
      throw new Error(`Leg ${id} is not in this build.`);
    };
    for (const module of [bootLeg, quantumLeg, allocationLeg]) loaders[module.default.id] = async () => {
      requested.push(module.default.id); return module;
    };
    const f = await fixtureBoot();
    const session = await createBrowserSession(f.boot, { kind: 'new', seed: 42, discClass: 'shell', difficulty: 'novice' }, { loaders });
    sessions.push(session); clock.frames(4);
    const scene = f.rendered.at(-1);
    if (scene === undefined) throw new Error('No authored layout rendered');
    const assertLayout = (module: LegModule, slabCount: number, steleCount?: number) => {
      expect(session.runner.currentLeg?.id).toBe(module.default.id);
      expect(session.runner.kernel).not.toBeNull();
      expect(f.boot.overlay.querySelector('.kt-card--panic')).toBeNull();
      expect(f.boot.overlay.querySelector('.kt-card--unavailable')).toBeNull();
      expect(f.boot.overlay.querySelector('.kt-panel--interactions')).not.toBeNull();
      expect(scene.children).toHaveLength(8);
      const anchors = module.content.layout.anchors.map(anchor => {
        const root = scene.getObjectByName(`kt.structures.${anchor.id}.root`);
        if (root === undefined) throw new Error(`Missing visible anchor ${anchor.id}`);
        expect(root.position.toArray()).toEqual(anchor.position);
        return root;
      });
      expect(new Set(anchors).size).toBe(module.content.layout.anchors.length);
      for (const [kind, count] of [['slab', slabCount], ['stele', steleCount]] as const) {
        if (count === undefined) continue;
        const batch = scene.getObjectByName(`kt.structures.layout-${kind}-instances.batch`);
        expect(batch).toBeInstanceOf(InstancedMesh);
        if (!(batch instanceof InstancedMesh)) throw new Error(`Missing ${kind} batch`);
        expect(batch.count).toBe(count);
      }
      return anchors;
    };
    const unavailable = async (id: LegId): Promise<void> => {
      await vi.waitFor(() => {
        clock.frames(1);
        const card = f.boot.overlay.querySelector('.kt-card--unavailable');
        expect(card?.textContent).toContain(`Leg ${LEG_ORDER.indexOf(id)}, ${id}, is not in this build.`);
      });
      expect(scene.children).toEqual([]);
      expect(session.runner.kernel).toBeNull();
      expect(f.boot.overlay.querySelector('.kt-card--panic')).toBeNull();
      expect(f.boot.overlay.querySelector('.kt-panel--interactions')).toBeNull();
    };
    const bootAnchors = assertLayout(bootLeg, 10);
    expect(session.runner.phase).toBe('travelling');
    expect(f.boot.overlay.textContent).toContain('The Boot Sector');
    buttonIn(f.boot.overlay, 'Choose a disc class').click(); clock.frames(4);
    expect(session.runner.saveProvisional().run.decisions.some(record => record.legId === 'boot_sector' && record.kind === 'leg_done')).toBe(true);
    const bootDebrief = f.boot.overlay.querySelector('.kt-card--debrief');
    if (bootDebrief === null) throw new Error('Boot Sector did not complete through its player interaction');
    buttonIn(bootDebrief, 'Continue').click();
    await unavailable('fork_fields');
    for (const anchor of bootAnchors) { expect(anchor.parent).toBeNull(); expect(anchor.children).toEqual([]); }
    for (const label of labels) expect(label.dispose).toHaveBeenCalledOnce();
    buttonIn(f.boot.overlay, 'Skip').click(); await unavailable('the_weave');
    buttonIn(f.boot.overlay, 'Skip').click();
    await vi.waitFor(() => { clock.frames(1); expect(session.runner.currentLeg?.id).toBe('quantum_pass'); expect(f.boot.overlay.querySelector('.kt-panel--interactions')).not.toBeNull(); });
    clock.frames(4);
    const quantumAnchors = assertLayout(quantumLeg, 13);
    expect(f.boot.overlay.textContent).toContain(quantumLeg.default.title);
    // The leg's rules have their own suite. Use the runner's public boundary to
    // keep this assembly regression about the Continue and Skip route.
    session.runner.exit(); clock.frames(1);
    const quantumDebrief = f.boot.overlay.querySelector('.kt-card--debrief');
    if (quantumDebrief === null) throw new Error('Quantum Pass did not produce its boundary card');
    buttonIn(quantumDebrief, 'Continue').click(); await unavailable('the_narrows');
    for (const anchor of quantumAnchors) { expect(anchor.parent).toBeNull(); expect(anchor.children).toEqual([]); }
    for (const label of labels) expect(label.dispose).toHaveBeenCalledOnce();
    buttonIn(f.boot.overlay, 'Skip').click(); await unavailable('the_cistern');
    buttonIn(f.boot.overlay, 'Skip').click(); await unavailable('the_gridlock');
    buttonIn(f.boot.overlay, 'Skip').click();
    await vi.waitFor(() => { clock.frames(1); expect(session.runner.currentLeg?.id).toBe('allocation_yards'); expect(f.boot.overlay.querySelector('.kt-panel--interactions')).not.toBeNull(); });
    clock.frames(4);
    assertLayout(allocationLeg, 12, 10);
    expect(f.boot.overlay.textContent).toContain('The Allocation Yards');
    expect(requested).toEqual(LEG_ORDER.slice(0, LEG_ORDER.indexOf('allocation_yards') + 1));
    session.dispose();
    expect(scene.children).toEqual([]);
    for (const label of labels) expect(label.dispose).toHaveBeenCalledOnce();
    expect(clock.pending).toBe(0);
  });

  it('keeps the panic card and stopped simulation across visibility changes', async () => {
    const f = await startTravel();
    clock.frames(6);
    const tick = f.session.runner.kernel?.tick;
    f.loseDevice();
    expect(f.boot.overlay.querySelector('.kt-card--panic')).toBeNull();
    clock.frames(1);
    expect(f.boot.overlay.querySelector('.kt-card--panic')?.textContent).toContain('Fixture device loss');
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    visible.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange'));
    clock.frames(120);
    expect(f.session.runner.kernel?.tick).toBe(tick);
    expect(f.boot.overlay.querySelector('.kt-card--panic')?.textContent).toContain('Fixture device loss');
    expect(f.boot.overlay.querySelector('.kt-card--debrief')).toBeNull();
    expect(clock.pending).toBe(0);
  });

  it('keeps audio running through a pause, suspends it while hidden, and resumes it when visible again', async () => {
    const f = await startTravel();
    const context = new FakeContext();
    vi.spyOn(AudioAdapter.prototype, 'context', 'get').mockReturnValue(context);
    const resume = vi.spyOn(context, 'resume');
    const suspend = vi.spyOn(context, 'suspend');
    f.boot.canvas.tabIndex = 0; f.boot.canvas.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
    expect(f.session.loop.currentTimeScale).toBe(0);
    // WP-25 (S3): a held clock is a moment, not silence; the score plays through the pause. Only a hidden tab suspends.
    expect(suspend).not.toHaveBeenCalled();
    expect(context.state).toBe('running');
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(suspend).toHaveBeenCalled();
    expect(context.state).toBe('suspended');
    visible.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange'));
    expect(resume).toHaveBeenCalled();
    expect(context.state).toBe('running');
  });

  it('resumes a provisional save with every prior module and the saved kernel tick and decisions', async () => {
    const first = await startTravel();
    clock.frames(18);
    terminalSubmit(first.boot.overlay, 'sched --policy srtf'); clock.frames(3);
    const file = first.session.runner.saveProvisional();
    if (file.kernel === null) throw new Error('Expected a provisional kernel snapshot');
    expect(file.run.decisions.some(record => record.kind === 'set_scheduler')).toBe(true);
    first.session.dispose();
    const next = await fixtureBoot();
    const resumed = await createBrowserSession(next.boot, { kind: 'resume', file }, { loaders: first.loaders });
    sessions.push(resumed);
    expect(resumed.runner.currentLeg?.id).toBe('fork_fields');
    expect(resumed.runner.kernel?.tick).toBe(file.kernel.tick);
    const again = resumed.runner.saveProvisional();
    expect(again.run.decisions).toEqual(file.run.decisions);
    expect(again.run.policy).toEqual(file.run.policy);
    expect(again.run.resources).toEqual(file.run.resources);
    expect(first.loaders.boot_sector).toHaveBeenCalledTimes(2);
    expect(first.loaders.fork_fields).toHaveBeenCalledTimes(2);
    clock.frames(6);
    expect(resumed.runner.kernel?.tick).toBeGreaterThan(file.kernel.tick);
    expect(next.boot.overlay.querySelector('.kt-terminal')).not.toBeNull();
  });

  it('restores an unresolved crossing panel without changing one byte of its saved decision log', async () => {
    const first = await startTravel();
    first.session.runner.openDepot(); first.session.runner.continueTravel();
    const crossing = first.travelLeg.content.crossings[0];
    if (crossing === undefined) throw new Error('Missing fixture crossing');
    first.session.runner.openCrossing(crossing);
    const file = first.session.runner.saveProvisional();
    const decisions = JSON.stringify(file.run.decisions);
    const next = await resumeFixture(first, file);
    const panel = next.boot.overlay.querySelector('.kt-panel--crossing');
    if (panel === null) throw new Error('Resumed crossing has no choice panel');
    expect(next.session.runner.phase).toBe('crossing');
    expect(panel.textContent).toContain('vault');
    expect(panel.textContent).toMatch(/C = \d+\.\d{2}/);
    expect(next.boot.overlay.querySelector('.kt-panel--depot')).toBeNull();
    expect(JSON.stringify(next.session.runner.saveProvisional().run.decisions)).toBe(decisions);
    buttonIn(panel, 'Choose block').click(); clock.frames(1);
    buttonIn(panel, 'Continue').click(); clock.frames(1);
    expect(next.session.runner.phase).toBe('travelling');
    expect(next.boot.overlay.querySelector('.kt-panel--crossing')).toBeNull();
  });

  it('restores an open depot after a purchase without recording another opening or purchase', async () => {
    const first = await startTravel();
    const depot = first.session.runner.openDepot();
    expect(depot.buy('quota_lot', null).ok).toBe(true);
    const file = first.session.runner.saveProvisional();
    const decisions = JSON.stringify(file.run.decisions);
    const next = await resumeFixture(first, file);
    const panel = next.boot.overlay.querySelector('.kt-panel--depot');
    if (panel === null) throw new Error('Resumed depot has no catalogue panel');
    expect(next.session.runner.phase).toBe('depot');
    const restored = next.session.runner.saveProvisional();
    expect(JSON.stringify(restored.run.decisions)).toBe(decisions);
    expect(restored.run.resources).toEqual(file.run.resources);
    buttonIn(panel, 'Leave').click(); clock.frames(1);
    expect(next.session.runner.phase).toBe('travelling');
    expect(next.boot.overlay.querySelector('.kt-panel--depot')).toBeNull();
  });

  it('restores the same reclamation layout without reopening the previously visited depot', async () => {
    const first = await startTravel();
    first.session.runner.openDepot(); first.session.runner.continueTravel();
    const layout = first.session.runner.openReclamation();
    const file = first.session.runner.saveProvisional();
    const decisions = JSON.stringify(file.run.decisions);
    const next = await resumeFixture(first, file);
    const panel = next.boot.overlay.querySelector('.kt-panel--reclamation');
    if (panel === null) throw new Error('Resumed reclamation has no round panel');
    expect(next.session.runner.phase).toBe('reclamation');
    expect(next.session.runner.director?.snapshot().reclamation?.layout).toEqual(layout);
    expect(panel.textContent).toContain(`fragments: ${layout.fragments.length}`);
    expect(next.boot.overlay.querySelector('.kt-panel--depot')).toBeNull();
    expect(JSON.stringify(next.session.runner.saveProvisional().run.decisions)).toBe(decisions);
    buttonIn(panel, 'Sweep').click(); clock.frames(1);
    expect(next.session.runner.phase).toBe('travelling');
    expect(panel.textContent).toContain('Yield:');
  });

  it('keeps a new kernel frozen while its stage is loading even if the time scale is changed', async () => {
    const f = await fixtureBoot();
    const bootLeg = moduleFor('boot_sector', 0);
    const travel = moduleFor('fork_fields', 1);
    const content: LegContent = { ...travel.content, layout: {
      ...travel.content.layout,
      anchors: [...travel.content.layout.anchors, { id: 'caption', kind: 'custom', structure: 'FixtureCaption', position: [0, 0, 4] }],
      extras: [...travel.content.layout.extras, 'caption'],
    } };
    const travelLeg: LegModule = { ...travel, content, default: { ...travel.default, createStage: () => layoutStage(content.layout) } };
    let rejectLabel: (reason?: unknown) => void = () => undefined;
    const pendingLabel = new Promise<Awaited<ReturnType<SdfAtlas['place']>>>((_resolve, reject) => { rejectLabel = reject; });
    const placement = vi.spyOn(SdfAtlas.prototype, 'place').mockReturnValue(pendingLabel);
    const session = await createBrowserSession(f.boot, { kind: 'new', seed: 7, discClass: 'shell', difficulty: 'novice' }, {
      loaders: { boot_sector: async () => bootLeg, fork_fields: async () => travelLeg },
    });
    sessions.push(session);
    session.runner.exit();
    clock.frames(1);
    buttonIn(f.boot.overlay, 'Continue').click();
    await vi.waitFor(() => expect(placement).toHaveBeenCalledTimes(1));
    expect(session.runner.currentLeg?.id).toBe('fork_fields');
    const tick = session.runner.kernel?.tick;
    expect(tick).toBe(0);
    f.boot.canvas.tabIndex = 0; f.boot.canvas.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
    expect(session.loop.currentTimeScale).toBe(0);
    clock.frames(1);
    const scheduler = session.runner.kernel?.invariantState().schedulerId;
    expect(scheduler).toBe('rr');
    const decisionsBeforeAttempt = JSON.stringify(session.runner.saveProvisional().run.decisions);
    terminalSubmit(f.boot.overlay, 'sched --policy srtf'); clock.frames(1);
    expect(session.runner.kernel?.invariantState().schedulerId).toBe(scheduler);
    expect(JSON.stringify(session.runner.saveProvisional().run.decisions)).toBe(decisionsBeforeAttempt);
    // The host also guards its tick path if a public loop caller changes scale.
    session.loop.setTimeScale(1);
    clock.frames(120);
    expect(session.runner.kernel?.tick).toBe(tick);
    session.dispose();
    rejectLabel(new Error('Fixture label load cancelled after disposal'));
    await Promise.resolve(); await Promise.resolve();
    expect(clock.pending).toBe(0);
  });

  it('disposes the visible scene, owned DOM, workers and scheduled loop', async () => {
    const f = await startTravel(); clock.frames(5);
    const scene = f.rendered.at(-1);
    if (scene === undefined) throw new Error('No scene rendered');
    buttonIn(f.boot.overlay, 'Open depot').click();
    f.session.dispose();
    expect(scene.children).toEqual([]);
    expect(clock.pending).toBe(0);
    const before = f.render.mock.calls.length;
    clock.frames(3);
    expect(f.render).toHaveBeenCalledTimes(before);
    expect(f.boot.overlay.querySelector('.kt-hud')).toBeNull();
    expect(f.boot.overlay.querySelector('.kt-terminal')).toBeNull();
    expect(f.boot.overlay.querySelector('.kt-panel')).toBeNull();
    expect(f.lossListeners.size).toBe(0);
    expect(FixtureWorker.instances.every(worker => worker.terminated)).toBe(true);
  });
});

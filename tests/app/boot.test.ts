// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootBrowser, type BootContext, type BootOptions } from '@app/boot';
import { mountTitleScreen, seedForNewRun, type StartFromTitle } from '@app/screens/TitleScreen';
import { throughputTargetFor, PROVISIONAL_THROUGHPUT_TARGET } from '@app/throughput';
import { ThreeUnifiedBackend } from '@render/RendererBackend';
import { UnsupportedBrowserError, PROFILES, CACHE_KEY, type RenderCapabilities } from '@platform';
import { Database, DB_NAME, buildSaveFile, saveGame } from '@game/save';
import { initialRunState } from '@game/replay/runReplay';
import { createRunStreams, saveRunStreams } from '@game/replay/types';
import { LEG_ORDER } from '@game/types';
import { validateContent, type LegContent } from '@legs/content';
import { makeSlab } from '@world/forms';
import { createSyntheticLeg } from '../game/fixtures/syntheticLeg';
import { absentLegs } from '../../vite.config';

const titleLoads = vi.hoisted(() => ({ requested: new Array<string>(), unavailable: new Set<string>() }));
vi.mock('@legs/registry', async () => {
  const { LEG_ORDER: ids } = await import('@game/types');
  return { LEG_LOADERS: Object.fromEntries(ids.map(id => [id, async () => {
    titleLoads.requested.push(id);
    if (titleLoads.unavailable.has(id)) throw new Error('Missing fixture leg');
    return {};
  }])) };
});

const caps: RenderCapabilities = {
  backend: 'webgl2', compute: false, storageBuffers: false, maxSamples: 4,
  float32Filterable: true, float16Renderable: true, hdr: true,
  maxTextureSize: 8192, maxInstances: 65536, timestampQuery: false,
  deviceMemoryGb: 8, hardwareConcurrency: 8, adapterLabel: 'Node boot fixture',
  isIntegrated: true, prefersReducedMotion: false, devicePixelRatio: 1,
};

const contexts: BootContext[] = [];
const directories: string[] = [];
const titleFrames = new Map<number, FrameRequestCallback>();
let nextTitleFrame = 1;

function flushTitleFrame(): void {
  const callbacks = [...titleFrames.values()]; titleFrames.clear();
  for (const callback of callbacks) callback(performance.now());
}

function resetDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

beforeEach(async () => {
  localStorage.clear();
  titleLoads.requested.length = 0;
  titleLoads.unavailable.clear();
  history.replaceState(null, '', '/');
  document.body.replaceChildren();
  titleFrames.clear(); nextTitleFrame = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    const id = nextTitleFrame++; titleFrames.set(id, callback); return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => { titleFrames.delete(id); });
  await resetDatabase();
});

afterEach(async () => {
  for (const context of contexts.splice(0)) context.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  await resetDatabase();
});

function fixture() {
  const canvas = document.createElement('canvas');
  canvas.id = 'stage';
  document.body.append(canvas);
  const backend = new ThreeUnifiedBackend(caps);
  const render = vi.spyOn(backend, 'renderFrame').mockImplementation(() => undefined);
  const resize = vi.spyOn(backend, 'resize').mockImplementation(() => undefined);
  const dispose = vi.spyOn(backend, 'dispose');
  const detect = vi.fn<NonNullable<BootOptions['detect']>>().mockResolvedValue({ caps, warnings: [] });
  const createBackend = vi.fn<NonNullable<BootOptions['createBackend']>>().mockResolvedValue(backend);
  return { canvas, backend, render, resize, dispose, detect, createBackend };
}

describe('browser boot', () => {
  it('installs one card stylesheet per document and resolves styles for every card variant', async () => {
    for (let boot = 0; boot < 2; boot++) {
      const f = fixture();
      const context = await bootBrowser(f.canvas, { detect: f.detect, createBackend: f.createBackend, tier: 'low' });
      contexts.push(context);
      const rules = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]);
      expect(rules.filter(rule => rule instanceof CSSStyleRule && rule.selectorText === '.kt-card')).toHaveLength(1);
      expect(document.querySelectorAll('#kt-card-styles')).toHaveLength(1);
      for (const variant of ['debrief', 'unavailable', 'panic', 'tombstone']) {
        const card = document.createElement('section');
        card.className = `kt-card kt-card--${variant}`;
        context.overlay.append(card);
        const style = getComputedStyle(card);
        expect(style.fontFamily).toContain('Jost');
        expect(style.paddingTop).toBe('16px');
        expect(style.backgroundColor).not.toBe('transparent');
        expect(style.color).not.toBe('rgb(0, 0, 0)');
      }
      context.dispose();
    }
  });

  it('uses the requested factories, warms twelve empty frames, and opens its database before returning', async () => {
    const f = fixture();
    const context = await bootBrowser(f.canvas, { detect: f.detect, createBackend: f.createBackend, forceWebGL: true, tier: 'low' });
    contexts.push(context);
    expect(f.detect).toHaveBeenCalledExactlyOnceWith(context.buildId, true);
    expect(f.createBackend).toHaveBeenCalledExactlyOnceWith(f.canvas, caps, expect.objectContaining({ profile: PROFILES.low, antialias: false, samples: 4 }), true);
    expect(f.render).toHaveBeenCalledTimes(12);
    for (const [index, [frame]] of f.render.mock.calls.entries()) {
      expect(frame.scene.children).toEqual([]);
      expect(frame.alpha).toBe(0);
      expect(frame.dtSeconds).toBe(1 / 60);
      expect(frame.elapsedSeconds).toBe(index / 60);
    }
    expect(f.resize).toHaveBeenCalledExactlyOnceWith(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
    expect(context.overlay.id).toBe('overlay');
    expect(context.overlay.style.pointerEvents).toBe('none');
    expect(f.canvas.nextElementSibling).toBe(context.overlay);
    await context.db.put('settings', { key: 'boot-test', value: true });
    await expect(context.db.get('settings', 'boot-test')).resolves.toEqual({ key: 'boot-test', value: true });
  });

  it('removes its resize subscription, overlay and geometry lease exactly once on disposal', async () => {
    const f = fixture();
    const slab = makeSlab();
    const geometryDisposed = vi.fn();
    slab.addEventListener('dispose', geometryDisposed);
    const context = await bootBrowser(f.canvas, { detect: f.detect, createBackend: f.createBackend, tier: 'low' });
    contexts.push(context);
    window.dispatchEvent(new Event('resize'));
    expect(f.resize).toHaveBeenCalledTimes(2);
    context.dispose();
    context.dispose();
    window.dispatchEvent(new Event('resize'));
    expect(f.resize).toHaveBeenCalledTimes(2);
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(geometryDisposed).toHaveBeenCalledTimes(1);
    expect(context.overlay.isConnected).toBe(false);
    await expect(context.db.get('settings', 'boot-test')).rejects.toThrow('Database.open() has not completed.');
  });

  it('shows the prescribed unsupported-browser text and rethrows without making a backend', async () => {
    const f = fixture();
    const failure = new UnsupportedBrowserError('No supported renderer');
    f.detect.mockRejectedValueOnce(failure);
    await expect(bootBrowser(f.canvas, { detect: f.detect, createBackend: f.createBackend, tier: 'low' })).rejects.toBe(failure);
    expect(document.body.textContent).toBe('KERNEL TRAIL needs WebGPU or WebGL2.');
    expect(f.createBackend).not.toHaveBeenCalled();
  });

  it('releases acquired resources and the resize subscription when database opening fails', async () => {
    const f = fixture();
    vi.spyOn(Database.prototype, 'open').mockRejectedValueOnce(new Error('database unavailable'));
    await expect(bootBrowser(f.canvas, { detect: f.detect, createBackend: f.createBackend, tier: 'low' })).rejects.toThrow('database unavailable');
    expect(f.dispose).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('resize'));
    expect(f.resize).toHaveBeenCalledTimes(1);
    expect(document.querySelector('#overlay')).toBeNull();
  });
});

describe('absent leg bundling', () => {
  it('resolves only missing registered legs and emits the runtime rejection module', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kt-boot-resolver-'));
    directories.push(root);
    mkdirSync(join(root, 'src/game'), { recursive: true });
    mkdirSync(join(root, 'src/legs/boot_sector'), { recursive: true });
    writeFileSync(join(root, 'src/game/types.ts'), "export const LEG_ORDER: readonly string[] = ['boot_sector', 'fork_fields'];\n");
    writeFileSync(join(root, 'src/legs/boot_sector/index.ts'), 'export default {};\n');
    const plugin = absentLegs(root);
    const resolve = plugin.resolveId;
    const load = plugin.load;
    if (typeof resolve !== 'function' || typeof load !== 'function') throw new Error('Expected direct resolver hooks.');
    const missing = await Reflect.apply(resolve, undefined, ['@legs/fork_fields']);
    expect(missing).toBe('\0kt-absent-leg:fork_fields');
    expect(await Reflect.apply(resolve, undefined, [join(root, 'src/legs/fork_fields')])).toBe(missing);
    expect(await Reflect.apply(resolve, undefined, ['@legs/boot_sector'])).toBeNull();
    expect(await Reflect.apply(resolve, undefined, ['@legs/content'])).toBeNull();
    expect(await Reflect.apply(load, undefined, [missing])).toBe('throw new Error("Leg fork_fields is not in this build.");');
    expect(await Reflect.apply(load, undefined, ['unrelated-module'])).toBeNull();
  });
});

describe('authored throughput targets', () => {
  const leg = createSyntheticLeg();
  const content: LegContent = {
    legId: leg.id, crossings: [], interactions: {}, epitaphs: [], codex: [], terminalHandlers: {},
    layout: { anchors: [], cameraTargets: [], extras: [] },
  };

  it('uses the provisional golden-run target only when the companion omits an authored target', () => {
    expect(PROVISIONAL_THROUGHPUT_TARGET).toBe(0.1);
    expect(throughputTargetFor(content)).toBe(0.1);
    expect(throughputTargetFor({ ...content, throughputTarget: 0.24 })).toBe(0.24);
    expect(validateContent(leg, content)).toEqual([]);
    expect(validateContent(leg, { ...content, throughputTarget: 0.24 })).toEqual([]);
  });

  it.each([0, -0.1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('rejects non-positive or non-finite target %s', throughputTarget => {
    expect(validateContent(leg, { ...content, throughputTarget })).toContain('throughputTarget: expected a positive finite number');
  });
});

function titleButton(element: HTMLElement, text: string): HTMLButtonElement {
  const match = [...element.querySelectorAll('button')].find(candidate => candidate.textContent === text);
  if (match === undefined) throw new Error(`Missing title button ${text}`);
  return match;
}

async function titleBoot(): Promise<BootContext> {
  const f = fixture();
  const context = await bootBrowser(f.canvas, { detect: f.detect, createBackend: f.createBackend, tier: 'low' });
  contexts.push(context);
  return context;
}

async function savedRun(context: BootContext, seed: number, legIndex: number, savedAtIso: string): Promise<void> {
  const run = initialRunState(seed, 'shell', 'operator');
  run.legIndex = legIndex;
  await saveGame(context.db, buildSaveFile({ run, kernel: null, rngStates: saveRunStreams(createRunStreams(seed)), savedAtIso }), { kind: 'boundary' });
}

describe('title run selection', () => {
  it('starts directly in the click gesture with the query seed and selected quality', async () => {
    history.replaceState(null, '', '/?seed=42');
    const context = await titleBoot();
    const start = vi.fn<StartFromTitle>();
    const title = mountTitleScreen(context, start);
    expect(title.element.isConnected).toBe(false);
    await title.ready;
    expect(title.element.isConnected).toBe(false);
    expect(context.backend.renderFrame).toHaveBeenCalledTimes(12);
    flushTitleFrame();
    expect(context.backend.renderFrame).toHaveBeenCalledTimes(13);
    expect(title.element.isConnected).toBe(true);
    expect(title.element.hasAttribute('role')).toBe(false);
    expect(titleButton(title.element, 'Continue').hidden).toBe(true);
    const quality = title.element.querySelector<HTMLSelectElement>('select[name="quality"]');
    if (quality === null) throw new Error('Missing quality control');
    quality.value = 'medium';
    titleButton(title.element, 'New run').click();
    // Before any await, the callback has already had the audio-unlock gesture.
    expect(start).toHaveBeenCalledExactlyOnceWith({ kind: 'new', seed: 42, discClass: 'shell', difficulty: 'operator' }, expect.objectContaining({ tier: 'medium', backend: context.backend }));
    expect(JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null')).toMatchObject({ tier: 'medium', by: 'user' });
    await Promise.resolve();
    expect(title.element.isConnected).toBe(false);
  });

  it('validates every historical and current leg before offering the latest saved run', async () => {
    const context = await titleBoot();
    await savedRun(context, 11, 0, '2026-09-15T10:00:00.000Z');
    await savedRun(context, 22, 3, '2026-09-16T10:00:00.000Z');
    const start = vi.fn<StartFromTitle>();
    const title = mountTitleScreen(context, start);
    await title.ready;
    flushTitleFrame();
    expect(titleLoads.requested).toEqual(LEG_ORDER.slice(0, 4));
    const continueRun = titleButton(title.element, 'Continue');
    expect(continueRun.hidden).toBe(false);
    expect(continueRun.disabled).toBe(false);
    continueRun.click();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ kind: 'resume', file: expect.objectContaining({ run: expect.objectContaining({ seed: 22, legIndex: 3 }) }) }), expect.anything());
    title.dispose();
  });

  it('keeps Continue disabled and names the first missing historical leg', async () => {
    const context = await titleBoot();
    await savedRun(context, 22, 3, '2026-09-16T10:00:00.000Z');
    titleLoads.unavailable.add('fork_fields');
    titleLoads.unavailable.add('quantum_pass');
    const start = vi.fn<StartFromTitle>();
    const title = mountTitleScreen(context, start);
    await title.ready;
    flushTitleFrame();
    expect(titleLoads.requested).toEqual(LEG_ORDER.slice(0, 4));
    const continueRun = titleButton(title.element, 'Continue');
    expect(continueRun.hidden).toBe(false);
    expect(continueRun.disabled).toBe(true);
    expect(title.element.textContent).toContain('This save passed through fork_fields, which is not in this build');
    continueRun.click();
    expect(start).not.toHaveBeenCalled();
    title.dispose();
  });

  it('accepts unsigned query seeds and refuses an invalid override', () => {
    expect(seedForNewRun('?seed=0')).toBe(0);
    expect(seedForNewRun('?seed=4294967295')).toBe(4294967295);
    expect(() => seedForNewRun('?seed=-1')).toThrow('Seed must be an integer');
    expect(() => seedForNewRun('?seed=nope')).toThrow('Seed must be an integer');
  });
});

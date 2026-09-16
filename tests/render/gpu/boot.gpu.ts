/** Real browser assembly probe. GPU evidence is collected only on Kyle's machine. */
import { InstancedMesh, Mesh } from 'three/webgpu';
import type { BufferGeometry, Scene } from 'three/webgpu';
import { bootBrowser } from '../../../src/app/boot';
import type { BootContext } from '../../../src/app/boot';
import { createBrowserSession } from '../../../src/app/BrowserSession';
import type { BrowserSession } from '../../../src/app/BrowserSession';
import { CACHE_KEY } from '../../../src/platform';
import type { LegModule } from '../../../src/legs/content';
import type { LegLayout } from '../../../src/legs/layout';
import { layoutStage } from '../../../src/legs/layout';
import { layout as bootSectorLayout } from '../../../src/legs/boot_sector/stage';
import { makeGridFloor, makeHorizon, makeSlab, makeStele } from '../../../src/world/forms';
import { PS_DEF } from '../../../src/terminal/commands/process';
import { createSyntheticLeg } from '../../game/fixtures/syntheticLeg';

const SEED = 77;
const MEASURED_FRAMES = 120;
const forkLayout: LegLayout = {
  anchors: [
    { id: 'crossing-console', kind: 'stele', position: [-2, 0, 0], facing: [0, 0, 1] },
    { id: 'page', kind: 'slab', position: [2, 0, 0] },
    { id: 'caption', kind: 'custom', structure: 'GpuStandIn', label: 'Synthetic layout', position: [0, 0, -4] },
  ],
  cameraTargets: ['crossing-console', 'page', 'caption'], extras: ['crossing-console', 'page', 'caption'],
};

function moduleFor(id: 'boot_sector' | 'fork_fields', index: number, layout: LegLayout): LegModule {
  const base = createSyntheticLeg({ id, index, processes: 0, service: [2000, 2001] });
  return {
    default: { ...base, title: id === 'boot_sector' ? 'Synthetic boot' : 'Synthetic browser leg',
      terminalCommands: [PS_DEF], createStage: () => layoutStage(layout) },
    content: {
      legId: id, layout, codex: [], epitaphs: [], interactions: {}, terminalHandlers: {},
      crossings: id === 'fork_fields' ? [{ id: 'fixture-crossing', legId: id, lockId: 'vault',
        kind: 'mutex', ordered: false, anchor: 'crossing-console', crosser: null }] : [],
    },
  };
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function fakeClock() {
  let now = performance.now();
  let next = -1;
  let restored = false;
  const callbacks = new Map<number, FrameRequestCallback>();
  const cancelNative = window.cancelAnimationFrame.bind(window);
  const requestDescriptor = Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame');
  const cancelDescriptor = Object.getOwnPropertyDescriptor(window, 'cancelAnimationFrame');
  const nowDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
  Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, writable: true,
    value: (callback: FrameRequestCallback): number => { const id = next--; callbacks.set(id, callback); return id; } });
  Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, writable: true,
    value: (id: number): void => { if (!callbacks.delete(id)) cancelNative(id); } });
  Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
  return {
    get pending() { return callbacks.size; },
    step(ms = 1000 / 60): void {
      now += ms;
      const due = Array.from(callbacks);
      for (const [id] of due) callbacks.delete(id);
      for (const [, callback] of due) callback(now);
    },
    restore(): void {
      if (restored) return;
      restored = true; callbacks.clear();
      if (requestDescriptor) Object.defineProperty(window, 'requestAnimationFrame', requestDescriptor);
      else Reflect.deleteProperty(window, 'requestAnimationFrame');
      if (cancelDescriptor) Object.defineProperty(window, 'cancelAnimationFrame', cancelDescriptor);
      else Reflect.deleteProperty(window, 'cancelAnimationFrame');
      if (nowDescriptor) Object.defineProperty(performance, 'now', nowDescriptor);
      else Reflect.deleteProperty(performance, 'now');
    },
  };
}

const yieldBrowser = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

async function until(clock: ReturnType<typeof fakeClock>, predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert(Date.now() < deadline, message);
    clock.step(0);
    await yieldBrowser();
  }
}

function button(root: ParentNode, text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(candidate => candidate.textContent === text);
  assert(found !== undefined, `Missing ${text} button`);
  assert(!found.disabled, `${text} button must be enabled`);
  return found;
}

function observeDisposal(geometries: Iterable<BufferGeometry>) {
  const observed = new Map<BufferGeometry, { count: number }>();
  for (const geometry of geometries) {
    if (observed.has(geometry)) continue;
    const entry = { count: 0 };
    observed.set(geometry, entry);
    geometry.addEventListener('dispose', () => { entry.count++; });
  }
  return observed;
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (value !== null && typeof value === 'object' && 'message' in value) return String(value.message);
  return String(value);
}

async function initialize(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#stage');
  assert(canvas !== null, 'Boot probe canvas missing');
  const forceWebGL = new URLSearchParams(location.search).has('webgl');
  // selectTier reads its cache before the explicit tier. Keep this fixture high.
  localStorage.removeItem(CACHE_KEY);
  let boot: BootContext | undefined;
  let session: BrowserSession | undefined;
  let clock: ReturnType<typeof fakeClock> | undefined;
  let restoreRender: (() => void) | undefined;
  let restoreRendererError: (() => void) | undefined;
  const consoleErrors: string[] = [];
  const rendererErrors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => {
    consoleErrors.push(values.map(errorMessage).join(' '));
    originalConsoleError.apply(console, values);
  };
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    try { session?.dispose(); }
    finally {
      try { restoreRender?.(); boot?.dispose(); }
      finally { restoreRendererError?.(); console.error = originalConsoleError; clock?.restore(); }
    }
  };
  try {
    const context = await bootBrowser(canvas, { forceWebGL, tier: 'high' });
    boot = context;
    const renderer = context.backend.deviceRenderer;
    const originalRendererError = renderer.onError;
    renderer.onError = error => {
      rendererErrors.push(errorMessage(error));
      originalRendererError.call(renderer, error);
    };
    restoreRendererError = () => { renderer.onError = originalRendererError; };
    const assertNoRenderErrors = async (): Promise<void> => {
      // A completed readback gives asynchronous validation errors time to arrive
      // before disposal can hide them. This uses the same public target as the benchmark.
      const output = context.backend.postChain?.budget.targets.get('tonemap_output');
      assert(output !== undefined, 'Boot probe needs its final render target');
      await renderer.readRenderTargetPixelsAsync(output, 0, 0, 1, 1);
      await yieldBrowser();
      assert(rendererErrors.length === 0, `Boot renderer errors:\n${rendererErrors.join('\n')}`);
      assert(consoleErrors.length === 0, `Boot console errors:\n${consoleErrors.join('\n')}`);
    };
    const backendId = context.backend.id;
    assert(backendId === (forceWebGL ? 'webgl2' : 'webgpu'), 'Boot backend must match the request');
    assert(context.tier === 'high', 'Boot fixture must use high tier');
    const captured: { scene: Scene | null } = { scene: null };
    const render = context.backend.renderFrame;
    context.backend.renderFrame = request => { captured.scene = request.scene; render.call(context.backend, request); };
    restoreRender = () => { context.backend.renderFrame = render; };
    const controlled = fakeClock(); clock = controlled;
    const opening = moduleFor('boot_sector', 0, {
      ...bootSectorLayout, extras: bootSectorLayout.anchors.map(anchor => anchor.id),
    });
    const fork = moduleFor('fork_fields', 1, forkLayout);
    const active = await createBrowserSession(context, { kind: 'new', seed: SEED, discClass: 'shell', difficulty: 'operator' }, {
      loaders: { boot_sector: async () => opening, fork_fields: async () => fork },
    });
    session = active;
    // Real Boot Sector data exercises the same instanced stand-ins as browser play.
    controlled.step(0);
    const openingBatch = captured.scene?.getObjectByName('kt.structures.layout-slab-instances.batch');
    assert(openingBatch instanceof InstancedMesh && openingBatch.count > 8, 'Boot Sector must exercise a live stand-in batch');
    await assertNoRenderErrors();
    const phase = () => active.runner.phase;
    // The fixture exits its opening leg explicitly; zero-segment legs now wait
    // for a leg_done record or their allowance instead of completing at entry.
    active.runner.exit();
    controlled.step(0);
    assert(active.runner.phase === 'complete', 'Explicit boot exit should reach debrief');
    button(context.overlay, 'Continue').click();
    await until(controlled, () => active.runner.currentLeg?.id === 'fork_fields'
      && captured.scene?.getObjectByName('kt.labels')?.children.length === 1
      && context.overlay.querySelector('.kt-panel--interactions') !== null
      && context.overlay.querySelector('.kt-tl')?.textContent?.includes(fork.default.title) === true,
    'Fork leg, label and panels did not become ready');
    const scene = captured.scene;
    assert(scene !== null, 'Session must render its scene');
    const geometry = new Set<BufferGeometry>();
    scene.traverse(object => { if (object instanceof Mesh) geometry.add(object.geometry); });
    const observed = observeDisposal(geometry);
    const sources = observeDisposal([makeSlab(), makeStele(), makeGridFloor(), makeHorizon()]);
    const roots = forkLayout.anchors.map(anchor => scene.getObjectByName(`kt.structures.${anchor.id}.root`));
    assert(roots.every(root => root !== undefined), 'Layout must place one structure for every anchor');
    const structures = scene.getObjectByName('kt.structures');
    assert(structures?.children.length === forkLayout.anchors.length, 'Layout structure count must equal its anchors');
    await assertNoRenderErrors();

    let ran = false;
    const api = {
      info: () => ({ backend: backendId, tier: context.tier, seed: SEED, anchors: forkLayout.anchors.length }),
      async run() {
        assert(!ran && !disposed, 'Boot probe run may execute once'); ran = true;
        const startingTick = active.runner.kernel?.tick;
        assert(startingTick !== undefined, 'Fork leg kernel must be live');
        for (let frame = 0; frame < MEASURED_FRAMES; frame++) {
          controlled.step();
          if (frame % 10 === 9) await yieldBrowser();
        }
        const endingTick = active.runner.kernel?.tick;
        assert(endingTick !== undefined && endingTick > startingTick, '120 frames must tick the kernel');
        const hudTitle = context.overlay.querySelector('.kt-tl')?.textContent ?? '';
        assert(hudTitle.includes(fork.default.title), 'HUD leg rail must show the synthetic title');

        document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backquote', key: '`', bubbles: true }));
        controlled.step(0);
        const input = context.overlay.querySelector<HTMLInputElement>('input[aria-label="terminal input"]');
        assert(input !== null, 'Live terminal input missing');
        input.value = 'ps';
        input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true }));
        controlled.step(0);
        const lines = Array.from(context.overlay.querySelectorAll<HTMLElement>('.kt-terminal-line')).map(line => line.textContent ?? '');
        assert(lines.some(line => /PID/.test(line)), 'ps must return a process header');
        assert(lines.some(line => /lumen|sable|orrery|kestrel|vesper/.test(line)), 'ps must return a convoy process');
        input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }));

        const approach = context.overlay.querySelector<HTMLButtonElement>('button[aria-label="Approach fixture-crossing"]');
        assert(approach !== null && !approach.disabled, 'Crossing approach must be available');
        approach.click(); controlled.step(0);
        const panel = context.overlay.querySelector<HTMLElement>('.kt-panel--crossing');
        assert(panel !== null && active.runner.phase === 'crossing', 'Approach must open the crossing panel');
        assert(/C = \d+\.\d{2}/.test(panel.textContent ?? ''), 'Crossing must display numerical contention');
        button(panel, 'Choose spin').click(); controlled.step(0);
        assert(panel.textContent?.includes('Succeeded: yes') === true, 'Zero-contention spin should succeed');
        button(panel, 'Continue').click(); controlled.step(0);
        assert(context.overlay.querySelector('.kt-panel--crossing') === null, 'Crossing Continue must close the panel');
        assert(phase() === 'travelling', 'Crossing Continue must restore travel');
        await assertNoRenderErrors();

        active.dispose();
        assert(scene.children.length === 0, 'Session disposal must empty its scene');
        const stoppedTick = active.loop.currentTick;
        controlled.step(100);
        assert(active.loop.currentTick === stoppedTick, 'Session disposal must stop its loop');
        for (const entry of observed.values()) assert(entry.count === 1, 'Rendered geometry must be disposed once');
        context.dispose();
        controlled.step(0);
        assert(controlled.pending === 0, 'Boot disposal must stop the renderer loop');
        for (const entry of sources.values()) assert(entry.count === 1, 'Every cached source lease must be released');
        const result = {
          backend: backendId, tier: context.tier, frames: MEASURED_FRAMES, leg: fork.default.id,
          structures: roots.length, hudTitle, ticks: endingTick - startingTick,
          terminal: { command: 'ps', lines: lines.length }, crossing: { opened: true, resolved: true, closed: true },
          consoleErrors: consoleErrors.length, rendererErrors: rendererErrors.length,
          openingBatchCount: openingBatch.count,
          geometry: { rendered: observed.size, renderedDisposed: observed.size, sources: sources.size, sourcesDisposed: sources.size },
          sceneEmpty: scene.children.length === 0, loopStopped: true,
        };
        dispose();
        return result;
      },
      dispose,
    };
    Object.assign(globalThis, { __kernelTrailProbe: { status: 'ready', api } });
  } catch (error) { dispose(); throw error; }
}

Object.assign(globalThis, { __kernelTrailProbe: { status: 'booting' } });
void initialize().catch((cause: unknown) => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  Object.assign(globalThis, { __kernelTrailProbe: { status: 'failed', error: { message: error.message, stack: error.stack ?? error.message } } });
  console.error(error.stack ?? error.message);
});

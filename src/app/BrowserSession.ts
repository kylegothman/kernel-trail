/** Browser assembly only. Layout forms and decision panels are replaceable stand-ins. */
import { Scene, Vector3 } from 'three/webgpu';
import { CAMERA } from '@design';
import { asTick, createKernel, createRng } from '@kernel/index';
import { CommandBus } from '@game/CommandBus';
import { LegRunner, type LegEvent } from '@game/LegRunner';
import { createRunStore, createTelemetryStore } from '@game/runStore';
import { initialRunState } from '@game/replay/runReplay';
import { createRunStreams, restoreRunStreams } from '@game/replay/types';
import { ReplayWorkerHandle } from '@game/workers/ReplayWorkerHandle';
import { SaveService, bindSettings, readCodexProfile, writeCodexProfile } from '@game/persist/SaveService';
import { createTerminalHost } from '@game/terminalHost';
import type { RunSummary } from '@game/save';
import { LEG_ORDER, type LegId } from '@game/types';
import { LEG_LOADERS } from '@legs/registry';
import type { LegModule } from '@legs/content';
import { sharedEpitaphSource } from '@legs/epitaphs';
import { BlendedPerspectiveCamera, FocusCameraRig, holoLabel, getMaterial, createLabelPlateMaterial, acquireGlass, releaseGlass } from '@render';
import { DerezzPool } from '@render/derezz/DerezzPool';
import { DEREZZ_TIMING } from '@render/derezz/variants';
import { SdfAtlas } from '@world/labels/SdfAtlas';
import { GeometryLeases, makeSlab } from '@world/forms';
import { EffectRegistry } from '@world/effects/EffectRegistry';
import { WorldEventRouter } from '@world/WorldEventRouter';
import type { FrameAggregates } from '@world/FrameEventQueue';
import type { WorldContext, StageServices } from '@world/contracts';
import { ProcessVisuals } from '@world/domains/ProcessVisuals';
import { SchedulerVisuals } from '@world/domains/SchedulerVisuals';
import { MemoryVisuals } from '@world/domains/MemoryVisuals';
import { SyncVisuals } from '@world/domains/SyncVisuals';
import { DeadlockVisuals } from '@world/domains/DeadlockVisuals';
import { StorageVisuals } from '@world/domains/StorageVisuals';
import { IoVisuals } from '@world/domains/IoVisuals';
import { FsVisuals } from '@world/domains/FsVisuals';
import { SecurityVisuals } from '@world/domains/SecurityVisuals';
import { SystemVisuals } from '@world/domains/SystemVisuals';
import { AudioEngine } from '@audio/AudioEngine';
import { AUDIO_SETTINGS_KEY, normaliseAudioSettings } from '@audio/settings';
import { createHud } from '@ui/hud/Hud';
import { createCodex } from '@ui/codex/Codex';
import { createCodexRegistry } from '@ui/codex/entries';
import { createLegUnavailableCard } from '@ui/cards/LegUnavailableCard';
import { createTombstoneCard } from '@ui/cards/TombstoneCard';
import { createPanicCard } from '@ui/cards/PanicCard';
import { createDebriefCard } from '@ui/cards/DebriefCard';
import type { Card } from '@ui/cards/card';
import { createTerminal, type Terminal } from '@terminal/Terminal';
import { SHIPPED_HANDLERS } from '@terminal/commands/index';
import type { BootContext, SessionStart } from './boot';
import { createRunHost } from './RunHost';
import { GameLoop, installVisibilityGovernor } from './loop';
import { sinkOverBus } from './commandSinkAdapter';
import { buildLayoutStage, type LayoutStage } from './stage/LayoutStage';
import { throughputTargetFor } from './throughput';
import { browserFrameHooks, type FrameState } from './frame';
import { installInput, type CameraTarget } from './input';

export interface BrowserSession {
  readonly loop: GameLoop;
  readonly runner: LegRunner;
  dispose(): void;
}
export interface SessionOptions {
  readonly loaders?: Readonly<Partial<Record<LegId, () => Promise<LegModule>>>>;
}
const MAX_TICKS = 20_000;
const describe = (error: unknown): string => error instanceof Error ? error.message : String(error);

export async function createBrowserSession(boot: BootContext, start: SessionStart, options: SessionOptions = {}): Promise<BrowserSession> {
  const doc = boot.overlay.ownerDocument;
  const windowView = doc.defaultView;
  if (windowView === null) throw new Error('A browser session needs a window.');
  const view = windowView;
  const initial = start.kind === 'new' ? initialRunState(start.seed, start.discClass, start.difficulty) : structuredClone(start.file.run);
  const runStore = createRunStore(initial);
  const telemetry = createTelemetryStore({ tick: 0, cpuUtilisation: 0, faultRate: 0, thrashingThreshold: 0,
    scheduler: 'rr', quantum: 4, replacement: 'fifo', disk: 'fcfs', allocation: 'first_fit', leg: { title: 'Entering leg', index: initial.legIndex, count: LEG_ORDER.length - 1 } });
  let runner: LegRunner;
  const currentKernel = (): NonNullable<LegRunner['kernel']> => {
    const kernel = runner?.kernel;
    if (kernel === null || kernel === undefined) throw new Error('No active kernel.');
    return kernel;
  };
  const bus = new CommandBus({ store: runStore, kernel: {
    setScheduler: (id, params) => currentKernel().setScheduler(id, params),
    setReplacementPolicy: id => currentKernel().setReplacementPolicy(id),
    setDiskPolicy: id => currentKernel().setDiskPolicy(id),
    setAllocationStrategy: strategy => currentKernel().setAllocationStrategy(strategy),
    setDeadlockStrategy: strategy => currentKernel().setDeadlockStrategy(strategy),
    syscall: request => currentKernel().syscall(request),
  }, handlers: {
    useAbility: (member, target, at) => runner.director?.useAbility(member, target, at),
    interaction: (id, anchor, at) => { runner.director?.interaction(id, anchor, at); },
    terminal: (line, at) => runner.director?.terminal(line, at),
  }, admit: (command, origin, at) => runner?.director?.admit(command, origin, at) ?? { ok: false, reason: 'No active leg.' } });
  const streams = createRunStreams(initial.seed);
  if (start.kind === 'resume') restoreRunStreams(streams, start.file.rngStates);
  const replay = new ReplayWorkerHandle();
  const saves = new SaveService(boot.db);
  const scene = new Scene();
  const camera = new BlendedPerspectiveCamera(CAMERA.fovDeg, view.innerWidth / Math.max(1, view.innerHeight), CAMERA.near, CAMERA.far);
  camera.matrixAutoUpdate = false;
  const focus = new FocusCameraRig({ scene, camera, aspect: camera.aspect, viewportHeightPx: view.innerHeight });
  const target: CameraTarget = { focus: new Vector3(), yawRad: 0, pitchRad: Math.PI / 6, distanceM: CAMERA.distanceMinM };
  const frame: FrameState = { elapsedSeconds: 0, dtSeconds: 0, alpha: 0 };
  const effects = new EffectRegistry(boot.tier);
  const runtime = { spawn: (effect: Parameters<EffectRegistry['spawn']>[0]): void => { effects.spawn(effect); } };
  const domains = { process: new ProcessVisuals(runtime), scheduler: new SchedulerVisuals(runtime), memory: new MemoryVisuals(runtime),
    sync: new SyncVisuals(runtime), deadlock: new DeadlockVisuals(runtime), storage: new StorageVisuals(runtime), io: new IoVisuals(runtime),
    fs: new FsVisuals(runtime), security: new SecurityVisuals(runtime), system: new SystemVisuals(runtime) };
  const router = new WorldEventRouter(domains, {
    get elapsedSeconds() { return frame.elapsedSeconds; }, get tick() { return runner?.kernel?.tick ?? 0; }, suppressEffects: false,
  }, { onPanic: message => panic(message), stopHost: () => loop?.stop() });
  const pool = new DerezzPool(boot.tier);
  const leases = new GeometryLeases();
  const derezzSource = leases.take(makeSlab());
  const visualRng = createRng(initial.seed, 'browser-derezz');
  const engine = new AudioEngine({ tier: boot.tier, seed: initial.seed });
  // This runs synchronously in the title button gesture, before any await.
  engine.unlock();
  let unbindSettings = (): void => undefined;
  let startedAtIso = new Date().toISOString();
  let profile: Awaited<ReturnType<typeof readCodexProfile>>;
  try {
    unbindSettings = await bindSettings(boot.db, AUDIO_SETTINGS_KEY, engine.settingsStore, normaliseAudioSettings);
    profile = await readCodexProfile(boot.db);
    const summary = await boot.db.get<RunSummary>('runs', initial.runId);
    startedAtIso = summary?.startedAtIso ?? startedAtIso;
  } catch (error) {
    unbindSettings();
    engine.dispose(); replay.dispose(); focus.dispose(); pool.dispose(); effects.disposeAll(); leases.dispose();
    throw error;
  }
  const hud = createHud({ root: boot.overlay, runStore, telemetry, clock: () => performance.now(), focusState: () => focus.state,
    sounds: { unlock: () => engine.unlock(), keyTick: () => engine.ui.keyTick(), commandAccept: () => engine.ui.commandAccept(),
      commandReject: () => engine.ui.commandReject(), alertAppear: () => engine.ui.alertAppear(),
      focusEngage: () => engine.ui.focusEngage(), focusRelease: () => engine.ui.focusRelease() }, injectStyle: true });
  const registry = createCodexRegistry();
  let index = initial.legIndex;
  const codex = createCodex({ registry, runStore, profile, currentLeg: () => LEG_ORDER[index] ?? 'the_portal', onScreen: () => true,
    metrics: () => { const t = telemetry.get(); return { tick: t.tick, cpuUtilisation: t.cpuUtilisation, faultRate: t.faultRate, thrashingThreshold: t.thrashingThreshold, quantum: t.quantum }; } });
  let disposed = false;
  let transitioning = false;
  let suppressLegEvents = false;
  let panicked = false;
  let stage: LayoutStage | null = null;
  let atlas: SdfAtlas | null = null;
  let terminal: Terminal | null = null;
  let loop: GameLoop;
  let emergencyFrame = 0;
  let card: Card | null = null;
  const stones = new Set<Card>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const writes: (() => void)[] = [];
  const modules = new Map<LegId, LegModule>();
  const loads = new Map<LegId, Promise<LegModule>>();
  const loaders = options.loaders ?? LEG_LOADERS;
  let epitaphs = sharedEpitaphSource([]);
  let profileWrites: Promise<void> = Promise.resolve();
  const unwatchCodex = codex.onUnlock(() => {
    const snapshot = codex.profile();
    profileWrites = profileWrites.then(() => writeCodexProfile(boot.db, snapshot, new Date().toISOString())).catch(error => panic(describe(error)));
  });
  const commit = (write: () => void): void => { if (!disposed) writes.push(write); };
  const flushUi = (): void => { for (const write of writes.splice(0)) { if (!disposed) write(); } };
  const present = (next: Card): void => {
    card?.dispose(); card = next;
    Object.assign(next.el.style, { pointerEvents: 'auto', position: 'absolute', top: '20%', left: '25%', maxWidth: '50%', maxHeight: '65%', overflow: 'auto' });
    boot.overlay.append(next.el);
  };
  const addAction = (root: HTMLElement, text: string, action: () => void): void => {
    const button = doc.createElement('button'); button.type = 'button'; button.textContent = text;
    button.addEventListener('click', action); root.append(button);
  };
  const openCodex = (_id?: string): void => { /* The panel is connected in the next assembly step. */ };
  function panic(message: string): void {
    if (disposed || panicked) return;
    panicked = true; loop?.stop();
    commit(() => {
      const next = createPanicCard(doc, { message, tick: runner?.kernel?.tick ?? asTick(0) });
      addAction(next.el, 'Back to title', () => {
        session.dispose(); boot.overlay.dispatchEvent(new Event('kt:title'));
      });
      present(next);
    });
    emergencyFrame = view.requestAnimationFrame(() => {
      emergencyFrame = 0;
      if (disposed) return;
      try { boot.backend.renderFrame({ scene, camera, alpha: 0, dtSeconds: 0, elapsedSeconds: frame.elapsedSeconds }); } catch { /* The loss card still commits after the render attempt. */ }
      hud.flush(); terminal?.flush(); flushUi();
    });
  }
  function legEvent(event: LegEvent): void {
    if (disposed || suppressLegEvents || (panicked && event.kind !== 'panic')) return;
    switch (event.kind) {
      case 'leg_unavailable': unavailable(event.legId, event.index, event.reason); break;
      case 'panic': panic(event.message); break;
      case 'debrief':
        commit(() => {
          const next = createDebriefCard(doc, event.view.card, event.view.counterfactual);
          addAction(next.el, 'Continue', () => { void advance(); }); present(next);
        });
        break;
      case 'tombstone':
        commit(() => {
          const stone = createTombstoneCard(doc, { epitaph: event.epitaph, memberName: event.memberName, onCodex: openCodex });
          stone.el.style.pointerEvents = 'auto'; stone.el.style.position = 'absolute'; stone.el.style.top = '25%'; stone.el.style.left = '25%';
          boot.overlay.append(stone.el); stones.add(stone);
          const remove = (): void => commit(() => { stone.dispose(); stones.delete(stone); });
          stone.el.addEventListener('click', remove, { once: true });
          const timer = setTimeout(() => { timers.delete(timer); remove(); }, DEREZZ_TIMING.convoy.release);
          timers.add(timer);
        });
        break;
      case 'crossing_open': case 'depot_open': case 'reclamation_open': break;
    }
  }
  runner = new LegRunner({ runStore, commandBus: bus, createKernel, streams, replay,
    onEvent: () => undefined, epitaphs: { templates: reason => epitaphs.templates(reason) },
    persist: (input, kind) => { if (!disposed) void saves.save(input, { kind, buildId: boot.buildId, startedAtIso }).catch(error => panic(describe(error))); },
    buildId: boot.buildId, savedAtIso: () => new Date().toISOString(),
    throughputTarget: leg => {
      const module = modules.get(leg.id);
      if (module === undefined) throw new Error(`No content for ${leg.id}.`);
      return throughputTargetFor(module.content);
    },
    onLegEvent: legEvent, codexSignal: signal => codex.signal(signal),
    onDerezz: phase => {
      hud.derezz[phase]();
      if (phase === 'begin') {
        const live = pool.spawn({ source: derezzSource, reason: 'normal_exit', namedConvoy: true, rng: visualRng });
        if (live !== null) scene.getObjectByName('kt.effects')?.add(live.mesh);
      }
    },
    onFailure: failure => panic(describe(failure.error)), onRunnerFailure: message => panic(message),
  });
  let worldAggregates: FrameAggregates | null = null;
  let audioAggregates: FrameAggregates | null = null;
  const hooks = browserFrameHooks({ boot, runner, scene, focus, target, state: frame, stage: () => stage, effects, pool, engine, hud, terminal: () => terminal,
    endConsumers() {
      if (worldAggregates !== null) { router.endFrame(worldAggregates); worldAggregates = null; }
      if (audioAggregates !== null) { engine.observeAggregates(audioAggregates); engine.consumer.endFrame(); audioAggregates = null; }
    }, commit: flushUi, panic, canFinish: () => !panicked && !transitioning });
  const host = createRunHost({ runner, commandBus: bus, runStore, telemetry, hooks });
  host.queue.addWorld({ name: router.name, consume: event => router.consume(event), endFrame: aggregates => { worldAggregates = aggregates; } });
  host.queue.addAudio({ name: engine.consumer.name, beginFrame: () => engine.consumer.beginFrame(), consume: event => engine.consumer.consume(event), endFrame: aggregates => { audioAggregates = aggregates; } });
  host.queue.addCodex(codex); host.queue.addHud(hud);
  loop = new GameLoop({ host });
  const unwatchKernel = runner.onKernelChanged(kernel => {
    const old = terminal; terminal = null;
    if (old !== null) commit(() => old.dispose());
    if (kernel === null) return;
    const leg = runner.currentLeg;
    if (leg === null) return;
    const module = modules.get(leg.id);
    if (module === undefined) return;
    commit(() => {
      if (runner.kernel !== kernel) return;
      const handlers = new Map(SHIPPED_HANDLERS);
      for (const [name, run] of Object.entries(module.content.terminalHandlers)) handlers.set(name, { run });
      const next = createTerminal(createTerminalHost(kernel, sinkOverBus(bus, leg.id, currentKernel), () => runStore.get()), { document: doc, handlers });
      next.shell.registerAll(leg.terminalCommands);
      next.shell.onCommand((name, argv) => codex.signal({ kind: 'command', name, argv }));
      next.element.style.pointerEvents = 'auto'; boot.overlay.append(next.element); terminal = next;
    });
    engine.setConvoyPids(runStore.get().convoy.flatMap(member => member.pid === null ? [] : [member.pid]));
    engine.setThresholds({ thrashingThreshold: kernel.config.thrashingThreshold });
    engine.resetForLeg();
  });
  const unbindInput = installInput({ document: doc, canvas: boot.canvas, loop, focus, target, structures: () => stage?.structures ?? [], terminal: () => terminal,
    toggleCodex: () => openCodex(), commit, paused: paused => hooks.onRunStateChanged(!paused) });
  const unbindVisibility = installVisibilityGovernor(loop, {
    onHide: () => { if (!disposed && runner.kernel !== null) runner.saveProvisional(); },
    onShow: () => undefined, onBlur: () => undefined, onFocus: () => undefined,
  });
  const unbindLoss = boot.backend.onDeviceLost(info => panic(info.reason));
  const resize = (): void => { focus.setViewport(view.innerWidth / Math.max(1, view.innerHeight), view.innerHeight); atlas?.setViewport(view.innerHeight); };
  view.addEventListener('resize', resize);
  const hide = (): void => { if (!disposed && runner.kernel !== null) runner.saveProvisional(); };
  const visibility = (): void => { if (doc.hidden) hide(); };
  view.addEventListener('pagehide', hide); doc.addEventListener('visibilitychange', visibility);
  commit(() => {
    hud.element.style.pointerEvents = 'auto';
    hud.cell('legRail').title = `Seed ${initial.seed}`;
  });

  function load(id: LegId): Promise<LegModule> {
    const prior = loads.get(id);
    if (prior !== undefined) return prior;
    const pending = new Promise<LegModule>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Leg ${id} timed out after 10 seconds.`)), 10_000);
      timers.add(timer);
      Promise.resolve().then(() => {
        const loader = loaders[id];
        if (loader === undefined) throw new Error(`Leg ${id} is not in this build.`);
        return loader();
      }).then(module => { clearTimeout(timer); timers.delete(timer); resolve(module); }, error => { clearTimeout(timer); timers.delete(timer); reject(error); });
    });
    loads.set(id, pending);
    return pending;
  }
  function register(module: LegModule): void {
    modules.set(module.default.id, module);
    for (const entry of module.content.codex) if (!registry.has(entry.id)) registry.register(entry);
  }
  function unavailable(id: LegId, at: number, reason: string): void {
    index = at;
    commit(() => {
      const next = createLegUnavailableCard(doc, { legId: id, index: at, reason });
      addAction(next.el, 'Skip', () => { void advance(); }); present(next);
    });
  }
  function clearStage(): void {
    stage?.dispose(); stage = null; atlas?.dispose(); atlas = null;
    pool.dispose(); effects.disposeAll();
    if (scene.children.length !== 0) throw new Error('Previous stage did not empty the scene.');
  }
  async function showLayout(module: LegModule): Promise<void> {
    if (disposed) return;
    const post = boot.backend.postChain;
    if (post === null) throw new Error('The backend must be warmed before a session starts.');
    atlas = new SdfAtlas(boot.tier, focus, view.innerHeight);
    const ctx: WorldContext = { scene, quality: boot.tier, focus, labels: atlas, materials: { holoLabel, getMaterial, createLabelPlateMaterial, acquireGlass, releaseGlass },
      time: { get elapsedSeconds() { return frame.elapsedSeconds; }, get alpha() { return frame.alpha; } },
      get elapsedSeconds() { return frame.elapsedSeconds; }, get tick() { return runner.kernel?.tick ?? 0; }, suppressEffects: false,
      kernel: { process: pid => runner.kernel?.process(pid), get tick() { return runner.kernel?.tick ?? asTick(0); } } };
    const services: StageServices = { createBatch: desc => boot.backend.createInstancedBatch(desc), postFocus: post.state };
    stage = buildLayoutStage(module.content.layout, ctx, services, focus, atlas);
    await stage.ready;
  }
  async function advance(to = index + 1): Promise<void> {
    if (disposed || transitioning || panicked) return;
    transitioning = true;
    const previousScale = loop.currentTimeScale;
    loop.setTimeScale(0);
    try {
      suppressLegEvents = true;
      try { if (runner.kernel !== null) runner.exit(); } finally { suppressLegEvents = false; }
      clearStage();
      commit(() => { card?.dispose(); card = null; });
      index = to;
      const id = LEG_ORDER[index];
      if (id === undefined) {
        runStore.mutate(run => { run.status = 'complete'; });
        commit(() => {
          const el = doc.createElement('section'); el.setAttribute('role', 'region'); el.textContent = 'Journey complete.';
          present({ el, dispose: () => el.remove() });
        });
        return;
      }
      let module: LegModule;
      try { module = await load(id); } catch (error) { unavailable(id, index, describe(error)); return; }
      if (disposed) return;
      register(module); epitaphs = sharedEpitaphSource(module.content.epitaphs);
      runner.enter(module.default, { maxTicks: MAX_TICKS, stageContext: { quality: boot.tier, run: runStore.get() } }, r => r.applyContent(module.content));
      if (runner.kernel !== null && !panicked) await showLayout(module);
    } catch (error) { panic(describe(error)); }
    finally { transitioning = false; if (!disposed && !panicked) loop.setTimeScale(previousScale); }
  }
  const session: BrowserSession = { loop, runner,
    dispose() {
      if (disposed) return;
      transitioning = true;
      suppressLegEvents = true;
      // Approved runner teardown path. Suppress teardown cards while exit releases its stage.
      if (runner.kernel !== null) runner.exit();
      loop.stop();
      for (const write of writes.splice(0)) write();
      disposed = true;
      view.cancelAnimationFrame(emergencyFrame);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      unbindLoss(); unbindInput(); unbindVisibility(); unwatchKernel(); unwatchCodex(); unbindSettings();
      view.removeEventListener('resize', resize); view.removeEventListener('pagehide', hide); doc.removeEventListener('visibilitychange', visibility);
      terminal?.dispose(); terminal = null; card?.dispose(); for (const stone of stones) stone.dispose(); stones.clear();
      codex.dispose(); hud.dispose(); engine.dispose(); clearStage(); leases.dispose(); focus.dispose(); replay.dispose();
    },
  };
  try {
    if (start.kind === 'resume') {
      for (const id of LEG_ORDER.slice(0, start.file.run.legIndex + 1)) register(await load(id));
      const current = LEG_ORDER[index];
      const module = current === undefined ? undefined : modules.get(current);
      if (!runner.resume(start.file, Array.from(modules.values(), entry => entry.default), { maxTicks: MAX_TICKS, stageContext: { quality: boot.tier, run: runStore.get() } }, (r, leg) => {
        const content = modules.get(leg.id)?.content;
        if (content !== undefined) { epitaphs = sharedEpitaphSource(content.epitaphs); r.applyContent(content); }
      })) throw new Error('The saved journey could not be resumed.');
      if (module !== undefined && runner.kernel !== null) await showLayout(module);
    } else await advance(index);
    if (!disposed && !panicked) loop.start();
    return session;
  } catch (error) { session.dispose(); throw error; }
}

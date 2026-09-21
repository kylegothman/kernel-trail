/** Browser assembly only. Layout forms and decision panels are replaceable stand-ins. */
import { Scene, Vector3 } from 'three/webgpu';
import { CAMERA } from '@design';
import { asTick, createKernel, createRng, type KernelEvent } from '@kernel/index';
import { CommandBus } from '@game/CommandBus';
import { LegRunner, type LegEvent, type LegPhase } from '@game/LegRunner';
import { createRunStore, createTelemetryStore } from '@game/runStore';
import { initialRunState } from '@game/replay/runReplay';
import { createRunStreams, restoreRunStreams } from '@game/replay/types';
import { hashEventLog } from '@game/replay/hash';
import { ReplayWorkerHandle } from '@game/workers/ReplayWorkerHandle';
import { SaveService, bindSettings, readCodexProfile, writeCodexProfile } from '@game/persist/SaveService';
import { createTerminalHost } from '@game/terminalHost';
import type { RunSummary } from '@game/save';
import { LEG_ORDER, type LegId, type RunState } from '@game/types';
import { LEG_LOADERS } from '@legs/registry';
import { validateContent, type LegModule } from '@legs/content';
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
import { CrossingPanel } from './panels/CrossingPanel';
import { DepotPanel } from './panels/DepotPanel';
import { ReclamationPanel } from './panels/ReclamationPanel';
import { CodexPanel } from './panels/CodexPanel';
import { InteractionPanel } from './panels/InteractionPanel';
import type { DeferredPanel } from './panels/panel';

export interface BrowserSession {
  readonly loop: GameLoop;
  readonly runner: LegRunner;
  /** WP-23 section 1: present in a development build only; a production build never constructs it. */
  readonly debug?: KernelTrailDebug;
  dispose(): void;
}
/**
 * WP-23 section 1: the read-only surface `src/main.ts` attaches at
 * `globalThis.__kernelTrailDebug` under `import.meta.env.DEV`. It reads and
 * never writes. `logHash` is `hashEventLog` over a tap that mirrors
 * `createRunHost`'s (subscribe on `onKernelChanged`, dedupe by `seq` per
 * kernel), so a browser hash and a harness hash for the same seed compare by
 * construction. `legHashes` is the runner's own per-leg hash, which a resumed
 * leg carries whole because the director snapshot holds the leg's events.
 */
export interface KernelTrailDebug {
  readonly buildId: string;
  legId(): LegId | null;
  tick(): number;
  phase(): LegPhase | null;
  /** hashEventLog over every kernel event the session has routed since the run began. */
  logHash(): string;
  /** Per-leg hashes in order, for legs that have completed. */
  legHashes(): readonly { legId: LegId; hash: string; ticks: number }[];
  run(): Readonly<RunState>;
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
  const numericMetrics: Record<string, number> = {};
  const codex = createCodex({ registry, runStore, profile, currentLeg: () => LEG_ORDER[index] ?? 'the_portal', onScreen: () => true,
    metrics: () => numericMetrics });
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
  const panels: DeferredPanel[] = [];
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
  const flushUi = (): void => {
    for (const write of writes.splice(0)) { if (!disposed) write(); }
    if (!disposed) for (const panel of panels) panel.flush();
    const interactions = interactionPanel.element;
    if (interactions !== null) interactions.hidden = card !== null || stones.size > 0;
  };
  const present = (next: Card): void => {
    card?.dispose(); card = next;
    Object.assign(next.el.style, { pointerEvents: 'auto', position: 'absolute', zIndex: '5', top: '20%', left: '25%', maxWidth: '50%', maxHeight: '65%', overflow: 'auto' });
    boot.overlay.append(next.el);
  };
  const addAction = (root: HTMLElement, text: string, action: () => void): void => {
    const button = doc.createElement('button'); button.type = 'button'; button.textContent = text;
    button.addEventListener('click', action); root.append(button);
  };
  const openCodex = (id?: string): void => { if (id === undefined) codexPanel.toggle(); else codexPanel.open(id); };
  function panic(message: string): void {
    if (disposed || panicked) return;
    panicked = true; loop?.stop();
    for (const panel of panels) panel.close();
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
      case 'crossing_open': crossingPanel.open(event.def, event.context); break;
      case 'depot_open': depotPanel.open(event.depot); break;
      case 'reclamation_open': reclamationPanel.open(event.layout); break;
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
  const crossingPanel = new CrossingPanel({ document: doc, overlay: boot.overlay, runner });
  const depotPanel = new DepotPanel({ document: doc, overlay: boot.overlay, runner, run: () => runStore.get() });
  const reclamationPanel = new ReclamationPanel({ document: doc, overlay: boot.overlay, runner });
  const codexPanel = new CodexPanel({ document: doc, overlay: boot.overlay, codex, registry });
  const interactionPanel = new InteractionPanel({ document: doc, overlay: boot.overlay, runner, bus, run: () => runStore.get(),
    crossing: (def, context) => crossingPanel.open(def, context), depot: depot => depotPanel.open(depot), reclamation: layout => reclamationPanel.open(layout) });
  panels.push(interactionPanel, crossingPanel, depotPanel, reclamationPanel, codexPanel);
  let worldAggregates: FrameAggregates | null = null;
  let audioAggregates: FrameAggregates | null = null;
  const hooks = browserFrameHooks({ boot, runner, scene, focus, target, state: frame, stage: () => stage, effects, pool, engine, hud, terminal: () => terminal,
    endConsumers() {
      if (worldAggregates !== null) { router.endFrame(worldAggregates); worldAggregates = null; }
      if (audioAggregates !== null) { engine.observeAggregates(audioAggregates); engine.consumer.endFrame(); audioAggregates = null; }
    }, commit: flushUi, panic, canFinish: () => !panicked && !transitioning,
    audioRunning: () => !panicked && !transitioning && loop.currentTimeScale > 0 });
  const host = createRunHost({ runner, commandBus: bus, runStore, telemetry, hooks });
  host.queue.addWorld({ name: router.name, consume: event => router.consume(event), endFrame: aggregates => { worldAggregates = aggregates; } });
  host.queue.addAudio({ name: engine.consumer.name, beginFrame: () => engine.consumer.beginFrame(), consume: event => engine.consumer.consume(event), endFrame: aggregates => { audioAggregates = aggregates; } });
  host.queue.addCodex(codex); host.queue.addHud(hud);
  let metricKernel: LegRunner['kernel'] = null;
  let metricTick = -1;
  loop = new GameLoop({ host: { ...host,
    applyPendingCommands(at) {
      if (!transitioning && !panicked && !disposed) host.applyPendingCommands(at);
    },
    fixedUpdate(at) {
      if (transitioning || panicked || disposed) return;
      host.fixedUpdate(at);
      const kernel = runner.kernel;
      if (kernel === null || (metricKernel === kernel && metricTick === kernel.tick)) return;
      metricKernel = kernel; metricTick = kernel.tick;
      const metrics = kernel.invariantState().metrics;
      for (const [key, value] of Object.entries(telemetry.get())) if (typeof value === 'number') numericMetrics[key] = value;
      numericMetrics.tick = kernel.tick;
      for (const [domain, values] of Object.entries(metrics)) for (const [key, value] of Object.entries(values)) {
        if (typeof value === 'number') numericMetrics[`${domain}.${key}`] = value;
      }
      for (const { unlock } of registry.unlocks()) if (unlock.kind === 'metric') {
        const value = numericMetrics[unlock.id];
        if (value !== undefined) codex.signal({ kind: 'metric', id: unlock.id, value });
      }
    },
  } });
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
      const sink = sinkOverBus(bus, leg.id, currentKernel);
      const next = createTerminal(createTerminalHost(kernel, {
        dispatch: (request, at) => transitioning || panicked || disposed
          ? { ok: false, message: 'The session is not accepting commands.' }
          : sink.dispatch(request, at),
      }, () => runStore.get()), { document: doc, handlers });
      next.shell.registerAll(leg.terminalCommands);
      next.shell.onCommand((name, argv) => codex.signal({ kind: 'command', name, argv }));
      next.element.style.pointerEvents = 'auto'; boot.overlay.append(next.element); terminal = next;
    });
    engine.setConvoyPids(runStore.get().convoy.flatMap(member => member.pid === null ? [] : [member.pid]));
    engine.resetForLeg();
  });
  const unbindInput = installInput({ document: doc, canvas: boot.canvas, loop, focus, target, structures: () => stage?.structures ?? [], terminal: () => terminal,
    toggleCodex: () => openCodex(), commit, paused: paused => hooks.onRunStateChanged(!paused),
    controlsBlocked: () => transitioning || panicked || disposed });
  const unbindVisibility = installVisibilityGovernor(loop, {
    onHide: () => { if (!disposed && runner.kernel !== null) runner.saveProvisional(); },
    onShow: () => undefined, onBlur: () => undefined, onFocus: () => undefined,
  });
  const unbindLoss = boot.backend.onDeviceLost(info => panic(info.reason));
  const renderFailure = (event: Event): void => {
    if (event instanceof CustomEvent && typeof event.detail === 'string') panic(event.detail);
  };
  boot.overlay.addEventListener('kt:render-failure', renderFailure);
  const resize = (): void => {
    const aspect = view.innerWidth / Math.max(1, view.innerHeight);
    focus.setViewport(aspect, view.innerHeight); atlas?.setViewport(view.innerHeight);
    stage?.frameCamera(target, aspect, view.innerHeight);
  };
  view.addEventListener('resize', resize);
  const hide = (): void => { if (!disposed && runner.kernel !== null) runner.saveProvisional(); };
  // WP-23 found in a real browser that Chromium begins a navigation after beforeunload and force-closes
  // the old document's IndexedDB connections at pagehide, so a provisional save issued there is aborted
  // before it commits and Continue then resumes silently from the leg's boundary save; the save is issued
  // at beforeunload, where it lands, and pagehide stays as the fallback for the paths where it does not fire.
  view.addEventListener('beforeunload', hide);
  view.addEventListener('pagehide', hide);
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
      }).then(module => {
        const problems = validateContent(module.default, module.content);
        if (module.default.id !== id) throw new Error(`Leg ${id} loaded ${module.default.id}.`);
        if (problems.length > 0) throw new Error(problems.join('\n'));
        return module;
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
    stage.frameCamera(target, view.innerWidth / Math.max(1, view.innerHeight), view.innerHeight);
    await stage.ready;
    if (!disposed) {
      stage.frameCamera(target, view.innerWidth / Math.max(1, view.innerHeight), view.innerHeight);
      interactionPanel.open(module.default, module.content);
    }
  }
  async function advance(to = index + 1): Promise<void> {
    if (disposed || transitioning || panicked) return;
    transitioning = true;
    const previousScale = loop.currentTimeScale;
    loop.setTimeScale(0);
    hooks.onRunStateChanged(false);
    try {
      suppressLegEvents = true;
      try { if (runner.kernel !== null) runner.exit(); } finally { suppressLegEvents = false; }
      clearStage();
      interactionPanel.close(); crossingPanel.close(); depotPanel.close(); reclamationPanel.close();
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
    finally { transitioning = false; if (!disposed && !panicked) { loop.setTimeScale(previousScale); hooks.onRunStateChanged(previousScale > 0); } }
  }
  function restoreDecisionPanels(module: LegModule): void {
    const phase = runner.phase;
    if (phase !== 'depot') depotPanel.close();
    if (phase === 'crossing') {
      const opened = runStore.get().decisions.findLast(record => record.legId === module.default.id && record.kind === 'crossing_open');
      const def = module.content.crossings.find(crossing => crossing.id === opened?.choice);
      if (def === undefined) throw new Error('The saved crossing is not defined by this leg.');
      // Survey preserves the saved opening record. Repeated panel opens are idempotent.
      crossingPanel.open(def, runner.surveyCrossing(def));
    } else crossingPanel.close();
    if (phase === 'reclamation') {
      const layout = runner.director?.snapshot().reclamation?.layout;
      if (layout === null || layout === undefined) throw new Error('The saved reclamation round has no layout.');
      reclamationPanel.open(layout);
    } else reclamationPanel.close();
  }
  const session: BrowserSession & { debug?: KernelTrailDebug } = { loop, runner,
    dispose() {
      if (disposed) return;
      transitioning = true;
      suppressLegEvents = true;
      // Approved runner teardown path. Suppress teardown cards while exit releases its stage.
      if (runner.kernel !== null) runner.exit();
      loop.stop();
      try { boot.backend.renderFrame({ scene, camera, alpha: 0, dtSeconds: 0, elapsedSeconds: frame.elapsedSeconds }); } catch { /* Teardown can follow device loss. */ }
      for (const write of writes.splice(0)) write();
      disposed = true;
      view.cancelAnimationFrame(emergencyFrame);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      unbindLoss(); unbindInput(); unbindVisibility(); unwatchKernel(); unwatchCodex(); unbindSettings();
      view.removeEventListener('resize', resize); view.removeEventListener('beforeunload', hide); view.removeEventListener('pagehide', hide);
      boot.overlay.removeEventListener('kt:render-failure', renderFailure);
      for (const panel of panels) panel.dispose();
      terminal?.dispose(); terminal = null; card?.dispose(); for (const stone of stones) stone.dispose(); stones.clear();
      codex.dispose(); hud.dispose(); engine.dispose(); clearStage(); leases.dispose(); focus.dispose(); replay.dispose();
    },
  };
  if (import.meta.env.DEV) {
    const routed: KernelEvent[] = [];
    const completed: { legId: LegId; hash: string; ticks: number }[] = [];
    let seenHashes = runner.replayRecord.legEventHashes.length;
    let untap: (() => void) | null = null;
    let tapped: LegId | null = null;
    runner.onKernelChanged(kernel => {
      untap?.(); untap = null;
      if (kernel === null) {
        const hashes = runner.replayRecord.legEventHashes;
        const hash = hashes[hashes.length - 1];
        if (tapped !== null && hashes.length > seenHashes && hash !== undefined) completed.push({ legId: tapped, hash, ticks: runner.ticksElapsed });
        seenHashes = hashes.length; tapped = null;
        return;
      }
      tapped = runner.currentLeg?.id ?? null;
      const seen = new Set<number>();
      untap = kernel.events.onAny(event => {
        if (seen.has(event.seq)) return;
        seen.add(event.seq); routed.push(event);
      });
    });
    session.debug = {
      buildId: boot.buildId,
      legId: () => runner.currentLeg?.id ?? null,
      tick: () => runner.kernel?.tick ?? runner.ticksElapsed,
      phase: () => (runner.currentLeg === null ? null : runner.phase),
      logHash: () => hashEventLog(routed),
      legHashes: () => completed.map(entry => ({ ...entry })),
      run: () => runStore.get(),
    };
  }
  try {
    if (start.kind === 'resume') {
      for (const id of LEG_ORDER.slice(0, start.file.run.legIndex + 1)) register(await load(id));
      const current = LEG_ORDER[index];
      const module = current === undefined ? undefined : modules.get(current);
      if (!runner.resume(start.file, Array.from(modules.values(), entry => entry.default), { maxTicks: MAX_TICKS, stageContext: { quality: boot.tier, run: runStore.get() } }, (r, leg) => {
        const content = modules.get(leg.id)?.content;
        if (content !== undefined) { epitaphs = sharedEpitaphSource(content.epitaphs); r.applyContent(content); }
      })) throw new Error('The saved journey could not be resumed.');
      if (module !== undefined && runner.kernel !== null) {
        await showLayout(module);
        restoreDecisionPanels(module);
      }
    } else await advance(index);
    if (!disposed && !panicked) loop.start();
    return session;
  } catch (error) { session.dispose(); throw error; }
}

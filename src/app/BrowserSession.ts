/** Browser assembly only. Layout forms and decision panels are replaceable stand-ins. */
import { Box3, Scene, Vector3 } from 'three/webgpu';
import { CAMERA } from '@design';
import { asTick, createKernel, createRng, type KernelEvent, type Tick } from '@kernel/index';
import { ObservedBus } from './panels/RefusalLine';
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
import { ZERO_SEGMENT_TICK_ALLOWANCE, legDone } from '@game/RunDirector';
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
import { createPacing, paceLabel, type Pacing } from './pacing';
import { sinkOverBus } from './commandSinkAdapter';
import { buildLayoutStage, type LayoutStage } from './stage/LayoutStage';
import { throughputTargetFor } from './throughput';
import { browserFrameHooks, type FrameState } from './frame';
import { installInput, type CameraTarget } from './input';
import { CrossingPanel } from './panels/CrossingPanel';
import { DepotPanel } from './panels/DepotPanel';
import { ReclamationPanel } from './panels/ReclamationPanel';
import { CodexPanel } from './panels/CodexPanel';
import { RequisitionPanel } from './panels/RequisitionPanel';
import { GatePanel } from './panels/GatePanel';
import { BootSectorDriver, layoutCarriesBeats } from './onboarding/BootSectorDriver';
import { InteractionPanel } from './panels/InteractionPanel';
import type { DeferredPanel } from './panels/panel';

export interface BrowserSession {
  readonly loop: GameLoop;
  /** WP-24 section 1: the player's clock over the loop. */
  readonly pacing: Pacing;
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
  /** WP-24 section 6 (pre-flight ruling 9.10): where a stage anchor sits on screen in CSS pixels, or null when there is no stage, no such anchor, or it is behind the camera. */
  anchorOnScreen(id: string): { readonly x: number; readonly y: number } | null;
  /** The tutorial beat in progress, or null when no driver is mounted or it has finished. */
  beat(): string | null;
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
  // WP-24 section 4: the bus publishes every drain so a refused verb can show its line.
  const bus = new ObservedBus({ store: runStore, kernel: {
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
  // WP-25: the score's 25 ms pump is the session's timer, because src/audio keeps no timers of its own.
  const engine = new AudioEngine({ tier: boot.tier, seed: initial.seed, interval: (fn, ms) => { const id = setInterval(fn, ms); return () => clearInterval(id); } });
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
  let pacing: Pacing;
  let emergencyFrame = 0;
  let card: Card | null = null;
  let driver: BootSectorDriver | null = null;
  let bootSectorCompleted = profile.bootSectorCompleted === true;
  const stones = new Set<Card>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const writes: (() => void)[] = [];
  const panels: DeferredPanel[] = [];
  const modules = new Map<LegId, LegModule>();
  const loads = new Map<LegId, Promise<LegModule>>();
  const loaders = options.loaders ?? LEG_LOADERS;
  let epitaphs = sharedEpitaphSource([]);
  let profileWrites: Promise<void> = Promise.resolve();
  // WP-24 section 2: Codex.profile() rebuilds the profile without the Boot Sector flag, so the session merges it into every write.
  const writeProfile = (): void => {
    const snapshot = { ...codex.profile(), ...(bootSectorCompleted ? { bootSectorCompleted: true } : {}) };
    profileWrites = profileWrites.then(() => writeCodexProfile(boot.db, snapshot, new Date().toISOString())).catch(error => panic(describe(error)));
  };
  const unwatchCodex = codex.onUnlock(writeProfile);
  const commit = (write: () => void): void => { if (!disposed) writes.push(write); };
  const flushUi = (): void => {
    if (!disposed) driver?.update(performance.now());
    for (const write of writes.splice(0)) { if (!disposed) write(); }
    if (!disposed) for (const panel of panels) panel.flush();
    const interactions = interactionPanel.element;
    if (interactions !== null) interactions.hidden = card !== null || stones.size > 0;
    // While the terminal is open the panels sit dimmed beneath it.
    const dimmed = terminal?.isOpen === true;
    for (const panel of panels) { const element = panel.element; if (element !== null) element.style.opacity = dimmed ? '0.3' : ''; }
    hud.setPace(paceLabel(pacing));
  };
  /** WP-24 section 1: every card asks a question, so every card holds the clock while it is up. */
  const present = (next: Card, reason: string): void => {
    card?.dispose();
    const release = pacing.hold(reason);
    card = { el: next.el, dispose: () => { next.dispose(); release(); } };
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
      present(next, 'panic');
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
    engine.onLegEvent(event);
    switch (event.kind) {
      case 'leg_unavailable': unavailable(event.legId, event.index, event.reason); break;
      case 'panic': panic(event.message); break;
      case 'debrief':
        // WP-24 section 2: a Boot Sector debrief with its leg_done record present completes the tutorial for this profile.
        if (runner.currentLeg?.id === 'boot_sector' && legDone(runStore.get(), 'boot_sector') && !bootSectorCompleted) { bootSectorCompleted = true; writeProfile(); }
        commit(() => {
          const next = createDebriefCard(doc, event.view.card, event.view.counterfactual);
          addAction(next.el, 'Continue', () => { void advance(); }); present(next, 'debrief');
        });
        break;
      case 'tombstone':
        commit(() => {
          const stone = createTombstoneCard(doc, { epitaph: event.epitaph, memberName: event.memberName, onCodex: openCodex });
          stone.el.style.pointerEvents = 'auto'; stone.el.style.position = 'absolute'; stone.el.style.top = '25%'; stone.el.style.left = '25%';
          boot.overlay.append(stone.el); stones.add(stone);
          const releaseStone = pacing.hold('tombstone');
          const remove = (): void => commit(() => { stone.dispose(); stones.delete(stone); releaseStone(); });
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
  // WP-24 section 1: every panel that asks a question holds the clock while open; the interactions panel does not.
  const hold = (reason: string): (() => void) => pacing.hold(reason);
  // WP-25 section 4: the crossing's result is a return value, so the score hears it on the way back to the panel.
  const crossingPanel = new CrossingPanel({ document: doc, overlay: boot.overlay, runner: {
    resolveCrossing: (def, option) => { const result = runner.resolveCrossing(def, option); engine.onDirectorEvent({ kind: 'crossing_resolved', succeeded: result.succeeded, casualties: result.casualties.length }); return result; },
    continueTravel: () => runner.continueTravel() }, hold });
  const depotPanel = new DepotPanel({ document: doc, overlay: boot.overlay, runner, run: () => runStore.get(), hold });
  const reclamationPanel = new ReclamationPanel({ document: doc, overlay: boot.overlay, runner, hold });
  const codexPanel = new CodexPanel({ document: doc, overlay: boot.overlay, codex, registry, hold });
  // WP-24 section 3: the Boot Sector's two panels; the driver opens them, and a skipped tutorial reaches them from the anchors panel's rows.
  // They hold the clock, so their verbs apply synchronously at the current tick, as the terminal's sink does.
  const kernelTick = (): Tick => runner.kernel?.tick ?? asTick(0);
  const requisitionPanel = new RequisitionPanel({ document: doc, overlay: boot.overlay, bus, run: () => runStore.get(), tick: kernelTick, clock: () => performance.now(), hold });
  const gatePanel = new GatePanel({ document: doc, overlay: boot.overlay, bus, run: () => runStore.get(), tick: kernelTick, hold });
  const interactionPanel = new InteractionPanel({ document: doc, overlay: boot.overlay, runner, bus, run: () => runStore.get(), outcomes: bus, clock: () => performance.now(),
    crossing: (def, context) => crossingPanel.open(def, context), depot: depot => depotPanel.open(depot), reclamation: layout => reclamationPanel.open(layout) });
  panels.push(interactionPanel, crossingPanel, depotPanel, reclamationPanel, codexPanel, requisitionPanel, gatePanel);
  let worldAggregates: FrameAggregates | null = null;
  let audioAggregates: FrameAggregates | null = null;
  const hooks = browserFrameHooks({ boot, runner, scene, focus, target, state: frame, stage: () => stage, effects, pool, engine, hud, terminal: () => terminal,
    endConsumers() {
      if (worldAggregates !== null) { router.endFrame(worldAggregates); worldAggregates = null; }
      if (audioAggregates !== null) { engine.observeAggregates(audioAggregates); engine.consumer.endFrame(); audioAggregates = null; }
    }, commit: flushUi, panic, canFinish: () => !panicked && !transitioning,
    // WP-25 (S3): a held clock is a moment, not silence; the music plays through pauses, holds, the panic and the
    // transition, and only a hidden tab suspends it.
    audioRunning: () => doc.visibilityState !== 'hidden' });
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
  pacing = createPacing(loop, paused => hooks.onRunStateChanged(!paused));
  const unwatchKernel = runner.onKernelChanged(kernel => {
    const old = terminal; terminal = null;
    if (old !== null) commit(() => old.dispose());
    if (kernel === null) { engine.onDirectorEvent({ kind: 'leg_exit' }); return; }
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
      }, () => runStore.get()), { document: doc, handlers, prompt: '> ' });
      next.shell.registerAll(leg.terminalCommands);
      next.shell.onCommand((name, argv) => {
        codex.signal({ kind: 'command', name, argv });
        // WP-24 pre-flight ruling 9.3: the line is a decision. Applied synchronously at the current tick as the terminal's
        // other writes are, so a leg's reducer (the Boot Sector's manInvocations) sees it where the harness records it.
        if (transitioning || panicked || disposed || runner.kernel !== kernel) return;
        bus.apply({ kind: 'terminal', line: [name, ...argv].join(' ') }, { source: 'terminal', legId: leg.id }, kernel.tick);
      });
      // The M3 playtest found the terminal painted behind the panels appended after it: it is the topmost layer while open.
      next.element.style.pointerEvents = 'auto'; next.element.style.zIndex = '20'; boot.overlay.append(next.element); terminal = next;
    });
    engine.setConvoyPids(runStore.get().convoy.flatMap(member => member.pid === null ? [] : [member.pid]));
    engine.resetForLeg();
    engine.onDirectorEvent({ kind: 'leg_entered', legId: leg.id, index: leg.index });
  });
  const unbindInput = installInput({ document: doc, canvas: boot.canvas, pacing, focus, target, structures: () => stage?.structures ?? [], terminal: () => terminal,
    toggleCodex: () => openCodex(), commit, controlsBlocked: () => transitioning || panicked || disposed });
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
    // WP-24 found in a real browser that an inline pointer-events auto on the HUD container, set here since WP-22, overrode the
    // stylesheet's none and swallowed every canvas click inside the safe inset, orbit drags included; the cells are auto on their own.
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
      addAction(next.el, 'Skip', () => { void advance(); }); present(next, 'unavailable');
    });
  }
  function clearStage(): void {
    stage?.dispose(); stage = null; atlas?.dispose(); atlas = null;
    pool.dispose(); effects.disposeAll();
    if (scene.children.length !== 0) throw new Error('Previous stage did not empty the scene.');
  }
  /** A profile that has completed the Boot Sector is offered Skip tutorial once at entry; true when taken. */
  function offerSkip(): Promise<boolean> {
    return new Promise(resolve => {
      commit(() => {
        const el = doc.createElement('section'); el.className = 'kt-card kt-card--tutorial'; el.setAttribute('role', 'region'); el.setAttribute('aria-label', 'Tutorial');
        const line = doc.createElement('p'); line.textContent = 'This profile has completed the Boot Sector.'; el.append(line);
        let chosen = false;
        const choose = (skip: boolean): void => { if (chosen) return; chosen = true; commit(() => { card?.dispose(); card = null; }); resolve(skip); };
        addAction(el, 'Skip tutorial', () => choose(true));
        addAction(el, 'Play tutorial', () => choose(false));
        present({ el, dispose: () => el.remove() }, 'tutorial');
      });
    });
  }
  function mountDriver(): void {
    if (stage === null || disposed) return;
    const layoutStage = stage;
    driver = new BootSectorDriver({
      document: doc, overlay: boot.overlay, canvas: boot.canvas, run: () => runStore.get(), structures: () => layoutStage.structures,
      sceneObject: name => scene.getObjectByName(name) ?? null, focus, hud, pacing, terminal: () => terminal,
      interactions: interactionPanel, requisition: requisitionPanel, gate: gatePanel, clock: () => performance.now(),
    });
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
    // WP-24 section 1: entering is a hold like any other, so the pace indicator says why the clock stopped.
    const releaseEntering = pacing.hold('entering');
    try {
      suppressLegEvents = true;
      try { if (runner.kernel !== null) runner.exit(); } finally { suppressLegEvents = false; }
      driver?.dispose(); driver = null;
      clearStage();
      interactionPanel.restrict(null);
      interactionPanel.close(); crossingPanel.close(); depotPanel.close(); reclamationPanel.close(); requisitionPanel.close(); gatePanel.close();
      commit(() => { card?.dispose(); card = null; });
      index = to;
      const id = LEG_ORDER[index];
      if (id === undefined) {
        runStore.mutate(run => { run.status = 'complete'; });
        commit(() => {
          const el = doc.createElement('section'); el.setAttribute('role', 'region'); el.textContent = 'Journey complete.';
          present({ el, dispose: () => el.remove() }, 'complete');
        });
        return;
      }
      let module: LegModule;
      try { module = await load(id); } catch (error) { unavailable(id, index, describe(error)); return; }
      if (disposed) return;
      register(module); epitaphs = sharedEpitaphSource(module.content.epitaphs);
      // WP-24 section 2: a new profile entering the Boot Sector gets the eight beats and cannot skip them; a profile that has
      // completed it is offered Skip tutorial once, and the session is not held up by the offer: the leg is entered on the choice.
      // The driver mounts only on the real Boot Sector's layout (pre-flight ruling 9.5).
      const bootable = id === 'boot_sector' && start.kind === 'new' && layoutCarriesBeats(module.content.layout.anchors.map(anchor => anchor.id));
      if (bootable && bootSectorCompleted) { void offerSkip().then(skip => enterLoaded(module, !skip)); return; }
      await enterLoaded(module, bootable);
    } catch (error) { panic(describe(error)); }
    finally { transitioning = false; releaseEntering(); }
  }
  /** Enter a loaded leg; with `tutorial` the browser passes no allowance and mounts the driver once the stage is ready (pre-flight ruling 9.1). */
  async function enterLoaded(module: LegModule, tutorial: boolean): Promise<void> {
    if (disposed || panicked) return;
    const wasTransitioning = transitioning;
    transitioning = true;
    const release = wasTransitioning ? () => undefined : pacing.hold('entering');
    try {
      runner.enter(module.default, { maxTicks: MAX_TICKS, stageContext: { quality: boot.tier, run: runStore.get() }, zeroSegmentAllowance: tutorial ? null : ZERO_SEGMENT_TICK_ALLOWANCE }, r => r.applyContent(module.content));
      if (runner.kernel !== null && !panicked) await showLayout(module);
      if (tutorial && runner.kernel !== null && !panicked && !disposed) mountDriver();
    } catch (error) { panic(describe(error)); }
    finally { if (!wasTransitioning) transitioning = false; release(); }
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
  const session: BrowserSession & { debug?: KernelTrailDebug } = { loop, pacing, runner,
    dispose() {
      if (disposed) return;
      transitioning = true;
      suppressLegEvents = true;
      // Approved runner teardown path. Suppress teardown cards while exit releases its stage.
      if (runner.kernel !== null) runner.exit();
      driver?.dispose(); driver = null;
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
      anchorOnScreen: id => {
        const structure = stage?.structures.find(candidate => candidate.id === id);
        if (structure === undefined) return null;
        // The centre of the structure's bounds, not its base: a ray at the base of a stele misses the mesh above it.
        structure.root.updateWorldMatrix(true, true);
        const point = new Box3().setFromObject(structure.root).getCenter(new Vector3()).project(focus.camera);
        if (point.z > 1) return null;
        return { x: (point.x + 1) / 2 * view.innerWidth, y: (1 - point.y) / 2 * view.innerHeight };
      },
      beat: () => (driver === null || driver.done ? null : driver.beatId),
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

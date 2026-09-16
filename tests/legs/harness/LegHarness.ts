/**
 * WP-20 section 4 and scope corrections W1, W2, W7, W11 and ruling F1: drive
 * a leg to completion with no renderer and no DOM.
 *
 * The harness owns the pump, the panic list and the event tap; the runner
 * owns everything else. The pump is the one `tests/game/legRunner.test.ts`
 * uses, verbatim in shape: fire the driver's due steps through the bus,
 * drain, `preTick`, `step`, `postTick`, then let the driver see the tick's
 * events so `when` steps can arm. The event log is tapped through
 * `runner.onKernelChanged`, deduplicated by `seq`, exactly as `createRunHost`
 * does. A `kernel.panic` arrives on `onLegEvent` and stops the pump; an
 * invariant throw out of `kernel.step()` (the harness publishes the panic
 * immediately before throwing) is caught into the same list.
 *
 * `restoreAt` restores mid-leg at the harness level (ruling F1): a
 * provisional save and the live director's snapshot, a fresh runner
 * re-entered from `replayEntry`, then `kernel.restore`, `director.restore`,
 * the store from `file.run` and the streams from `file.rngStates`.
 *
 * WP-21 section 6: the leg's `content` companion (remembered by the loader
 * or given as `HarnessOptions.content`) is applied through `enter`'s
 * configure parameter, its stones ride ahead of the shared forty-eight in
 * the epitaph source, and a `DecisionScript`'s own crossings and
 * interactions add to or override the companion's by id.
 */
import { createKernel, type KernelConfig, type KernelEvent, type SubsystemId } from '@kernel/index';
import { CommandBus, type KernelMutators } from '@game/CommandBus';
import type { CrossingDef, CrossingResult } from '@game/crossing/Crossing';
import { LegRunner, type LegEvent, type LegRunOptions } from '@game/LegRunner';
import type { LegFailure } from '@game/LegSandbox';
import { hashEventLog } from '@game/replay/hash';
import { createRunStreams, restoreRunStreams, type ReplayEntry, type ReplayKernel, type RunStreams } from '@game/replay/types';
import { createRunStore, type RunStore } from '@game/runStore';
import type { SaveFileInput } from '@game/save';
import type { DecisionRecord, Leg, LegId, LegOutcome, ResourceLedger, RunState, StageContext } from '@game/types';
import type { LegContent } from '@legs/content';
import { sharedEpitaphSource } from '@legs/epitaphs';
import type { DecisionScript, ScriptStep } from './decisionScript';
import { contentOf } from './loadLeg';
import { makeRunState } from './makeRunState';
import { makeDriver, type Driver, type DriverContext, type PolicyName } from './scriptedDecisions';

export const DEFAULT_MAX_TICKS = 20_000;
/** The WP-19 suites' target; a positive authored target per leg is a boot duty (ruling F6). */
export const DEFAULT_THROUGHPUT_TARGET = 0.1;
export const HARNESS_BUILD_ID = 'wp20-harness';
export const HARNESS_SAVED_AT = '2026-09-16T00:00:00.000Z';

export interface ScheduledCrossing {
  readonly at: number;
  readonly def: CrossingDef;
}

export interface HarnessOptions {
  readonly seed: number;
  readonly maxTicks?: number;
  readonly script?: DecisionScript;
  readonly policy?: PolicyName;
  readonly run?: RunState;
  /** Snapshot and restore at this tick, then continue. Used by the determinism cases. */
  readonly restoreAt?: number;
  readonly recordEvents?: boolean;
  /** Policy runs: crossings opened at `at`, the option chosen by the policy (ruling F3). */
  readonly crossings?: readonly ScheduledCrossing[];
  readonly throughputTarget?: number;
  /** The companion to apply at entry; the one the loader remembered for this leg object when omitted (WP-21 section 6). */
  readonly content?: LegContent;
}

export interface RestoreReport {
  readonly at: number;
  /** The snapshot's `seq`; the remainder is every event above it. */
  readonly seq: number;
  readonly remainderHash: string;
}

export interface HarnessResult {
  readonly legId: LegId;
  readonly seed: number;
  readonly ticks: number;
  readonly events: readonly KernelEvent[];
  readonly eventTypes: ReadonlySet<string>;
  readonly outcome: LegOutcome;
  readonly run: RunState;
  readonly ledgerBefore: ResourceLedger;
  readonly ledgerAfter: ResourceLedger;
  readonly decisions: readonly DecisionRecord[];
  readonly crossings: readonly CrossingResult[];
  readonly panics: readonly string[];
  readonly legFailures: readonly LegFailure[];
  readonly runnerFailures: readonly string[];
  readonly unfiredSteps: readonly ScriptStep[];
  readonly logHash: string;
  readonly restore: RestoreReport | null;
  readonly wallMs: number;
  /**
   * Per kernel tick advanced: an action that simulates n ticks in one slot is
   * amortised over n (ruling F5). `maxTickMs` is reported but never asserted:
   * inside a parallel runner it measures the worst operating-system deschedule
   * of the run, not the leg. Assert `medianTickMs` (WP-22 era timing ruling).
   */
  readonly maxTickMs: number;
  readonly medianTickMs: number;
  readonly p95TickMs: number;
  readonly notes: readonly string[];
  /** Times `createStage` was called; always 0 in the run loop. */
  readonly stageCalls: number;
  /** The run and streams at leg entry, in the shape a `ReplayRequest` takes. */
  readonly entry: ReplayEntry | null;
  /** True when the leg was on the emergency preemption credit at exit. */
  readonly onCredit: boolean;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Vitest runs in the node environment (architecture 11.1); this catches a config drift that would let a leg pull `@world` in. */
export function assertHeadless(): void {
  if (typeof document !== 'undefined' || typeof window !== 'undefined') {
    throw new Error('The leg harness must run in the node environment: globalThis.document or globalThis.window is defined');
  }
}

/** Per-run state shared across a mid-leg restore and across the legs of a journey. */
export interface Collectors {
  readonly log: KernelEvent[];
  readonly panics: string[];
  readonly legFailures: LegFailure[];
  readonly runnerFailures: string[];
  readonly notes: string[];
  readonly crossings: CrossingResult[];
  stageCalls: number;
}

export function createCollectors(): Collectors {
  return { log: [], panics: [], legFailures: [], runnerFailures: [], notes: [], crossings: [], stageCalls: 0 };
}

export class HarnessSession {
  readonly store: RunStore;
  readonly streams: RunStreams;
  readonly bus: CommandBus;
  readonly runner: LegRunner;
  readonly collectors: Collectors;
  readonly persisted: { readonly kind: 'boundary' | 'provisional'; readonly input: SaveFileInput }[] = [];
  /** While the runner reconstructs side state inside `resume`, sandbox failures are notes, not leg failures. */
  resuming = false;
  /** The companion in force for the current leg; its stones are served ahead of the shared forty-eight. */
  content: LegContent | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(readonly seed: number, run: RunState, readonly throughputTarget: number, collectors: Collectors = createCollectors()) {
    this.collectors = collectors;
    this.store = createRunStore(run);
    this.streams = createRunStreams(seed);
    const active = (): ReplayKernel => {
      const kernel = this.runner.kernel;
      if (kernel === null) throw new Error('harness: the runner has no active kernel');
      return kernel;
    };
    const director = () => {
      const current = this.runner.director;
      if (current === null) throw new Error('harness: the runner has no active director');
      return current;
    };
    const mutators: KernelMutators = {
      setScheduler: (id, params) => active().setScheduler(id, params),
      setReplacementPolicy: (id) => active().setReplacementPolicy(id),
      setDiskPolicy: (id) => active().setDiskPolicy(id),
      setAllocationStrategy: (strategy) => active().setAllocationStrategy(strategy),
      setDeadlockStrategy: (strategy) => active().setDeadlockStrategy(strategy),
      syscall: (request) => active().syscall(request),
    };
    this.bus = new CommandBus({
      store: this.store,
      kernel: mutators,
      admit: (command, origin, at) => director().admit(command, origin, at),
      handlers: {
        useAbility: (member, target, at) => director().useAbility(member, target, at),
        interaction: (id, anchor, at) => { director().interaction(id, anchor, at); },
        terminal: (line, at) => director().terminal(line, at),
      },
    });
    this.runner = new LegRunner({
      runStore: this.store,
      commandBus: this.bus,
      createKernel,
      streams: this.streams,
      onEvent: () => undefined,
      replay: null,
      epitaphs: { templates: (reason) => sharedEpitaphSource(this.content?.epitaphs ?? []).templates(reason) },
      persist: (input, kind) => { this.persisted.push({ kind, input }); },
      buildId: HARNESS_BUILD_ID,
      savedAtIso: () => HARNESS_SAVED_AT,
      throughputTarget: () => this.throughputTarget,
      onLegEvent: (event: LegEvent) => {
        if (event.kind === 'panic') this.collectors.panics.push(`tick ${event.tick}: ${event.message}`);
      },
      codexSignal: () => undefined,
      onDerezz: () => undefined,
      onFailure: (failure, leg) => {
        if (this.resuming) this.collectors.notes.push(`resume reconstruction of ${leg.id}: ${failure.phase} failed: ${describe(failure.error)}`);
        else this.collectors.legFailures.push(failure);
      },
      onRunnerFailure: (message, leg, at) => { this.collectors.runnerFailures.push(`${leg.id} tick ${at}: ${message}`); },
    });
    this.runner.onKernelChanged((kernel) => { this.attachTo(kernel); });
  }

  private attachTo(kernel: ReplayKernel | null): void {
    this.detach();
    if (kernel === null) return;
    // One set per kernel, as createRunHost keeps it: every leg's kernel restarts its seq at 0, and a
    // restored kernel continues from its snapshot's seq, so the set never has to outlive the kernel.
    const seen = new Set<number>();
    const { log } = this.collectors;
    this.unsubscribe = kernel.events.onAny((event) => {
      if (seen.has(event.seq)) return;
      seen.add(event.seq);
      log.push(event);
    });
  }

  /** Stop tapping the active kernel; `attach` resumes on the runner's current kernel. */
  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  attach(): void {
    this.attachTo(this.runner.kernel);
  }

  /** The most recent boundary save input the runner persisted, or null. */
  lastBoundary(): SaveFileInput | null {
    for (let i = this.persisted.length - 1; i >= 0; i--) {
      const entry = this.persisted[i];
      if (entry !== undefined && entry.kind === 'boundary') return entry.input;
    }
    return null;
  }
}

const NOOP_HANDLER = (): void => undefined;

/** Count `createStage` calls without changing the leg's behaviour; the runner never calls it with a null stage context. */
function instrument(leg: Leg, onStage: () => void): Leg {
  return new Proxy(leg, {
    get(target, key, receiver): unknown {
      const value: unknown = Reflect.get(target, key, receiver);
      if (key !== 'createStage' || typeof value !== 'function') return value;
      return (ctx: StageContext) => {
        onStage();
        return (value as Leg['createStage']).call(target, ctx);
      };
    },
  });
}

function failedOutcome(leg: Leg, reason: string): LegOutcome {
  return {
    survived: false, objectivesMet: [], casualties: [], resourceDelta: {}, codexUnlocked: [],
    debrief: {
      headline: 'Harness: the leg could not be exited', whatHappened: reason, whyItHappened: 'The runner threw at exit; see runnerFailures.',
      counterfactual: null, chapter: leg.chapters[0] ?? { chapter: 0, sections: [], title: '' },
    },
  };
}

/** The script's crossings over the companion's: a script def with the same id replaces the companion's (WP-21 section 6). */
export function mergeCrossings(companion: readonly CrossingDef[], script: readonly CrossingDef[]): readonly CrossingDef[] {
  const byId = new Map<string, CrossingDef>();
  for (const def of companion) byId.set(def.id, def);
  for (const def of script) byId.set(def.id, def);
  return [...byId.values()];
}

function restoreMidLeg(session: HarnessSession, leg: Leg, legOpts: LegRunOptions, configure: (runner: LegRunner) => void): { readonly session: HarnessSession; readonly seq: number } {
  const director = session.runner.director;
  const entry = session.runner.replayEntry;
  if (director === null || entry === null) throw new Error('restoreAt: no active leg to snapshot');
  const file = session.runner.saveProvisional();
  if (file.kernel === null) throw new Error('restoreAt: the provisional save carried no kernel snapshot');
  const directorState = director.snapshot();
  session.detach();
  const next = new HarnessSession(session.seed, structuredClone(entry.run), session.throughputTarget, session.collectors);
  next.content = session.content;
  restoreRunStreams(next.streams, entry.rngStates);
  next.runner.enter(leg, legOpts, configure);
  const kernel = next.runner.kernel;
  const nextDirector = next.runner.director;
  if (kernel === null || nextDirector === null) throw new Error('restoreAt: the leg could not be re-entered');
  // Restore-time emissions carry pre-snapshot sequence numbers; the tap stays off until the seq counter is the snapshot's.
  next.detach();
  kernel.restore(file.kernel);
  next.attach();
  next.store.mutate((run) => { Object.assign(run, structuredClone(file.run)); });
  restoreRunStreams(next.streams, file.rngStates);
  nextDirector.restore(directorState);
  return { session: next, seq: file.kernel.seq };
}

/**
 * Drive one leg in an existing session. Returns the session in force at the
 * end, which differs from the one given only after a mid-leg restore.
 */
export function runLegInSession(session: HarnessSession, leg: Leg, opts: HarnessOptions, alreadyEntered = false): { readonly result: HarnessResult; readonly session: HarnessSession } {
  assertHeadless();
  const maxTicks = opts.maxTicks ?? DEFAULT_MAX_TICKS;
  const legOpts: LegRunOptions = { maxTicks, stageContext: null };
  const content = opts.content ?? contentOf(leg);
  const scriptCrossings = opts.script?.crossings ?? [];
  const crossings = mergeCrossings(content?.crossings ?? [], scriptCrossings);
  const driver: Driver = makeDriver(opts.script === undefined ? undefined : { ...opts.script, crossings }, opts.policy, opts.seed);
  const interactions = opts.script?.interactions ?? [];
  /** The companion first, then the script's additions and overrides, once the director exists (section 6). */
  const configure = (runner: LegRunner): void => {
    if (content !== null) runner.applyContent(content);
    if (scriptCrossings.length > 0) runner.registerCrossings(crossings);
    for (const interaction of interactions) runner.registerInteraction(interaction.id, NOOP_HANDLER, interaction.target);
  };
  const scheduled = (opts.crossings ?? []).map((entry) => ({ ...entry, done: false }));
  const collectors = session.collectors;
  const start = {
    log: collectors.log.length, panics: collectors.panics.length, legFailures: collectors.legFailures.length,
    runnerFailures: collectors.runnerFailures.length, notes: collectors.notes.length, crossings: collectors.crossings.length,
    stageCalls: collectors.stageCalls,
  };
  const ledgerBefore = { ...session.store.get().resources };
  const wallStart = performance.now();
  const tickSamples: number[] = [];
  let current = session;
  const wrapped = instrument(leg, () => { collectors.stageCalls += 1; });
  current.content = content;
  if (!alreadyEntered) current.runner.enter(wrapped, legOpts, configure);
  else if (current.runner.currentLeg !== null && current.runner.director !== null) configure(current.runner);
  const entry = current.runner.replayEntry === null ? null : structuredClone(current.runner.replayEntry);
  const requireKernel = (): ReplayKernel => {
    const kernel = current.runner.kernel;
    if (kernel === null) throw new Error('harness: no active kernel for the driver');
    return kernel;
  };
  const ctx: DriverContext = {
    legId: leg.id,
    get tick() { return current.runner.kernel?.tick ?? 0; },
    get kernel() { return requireKernel(); },
    get run() { return current.store.get(); },
    dispatch: (command) => {
      if (!current.bus.dispatch(command, { source: 'replay', legId: leg.id })) collectors.notes.push(`${leg.id}: the command queue was full; ${command.kind} dropped`);
    },
    flushCommands: () => { current.runner.observeCommands(current.bus.drain(requireKernel().tick)); },
    crossing: (def, option) => {
      current.runner.openCrossing(def);
      const result = current.runner.resolveCrossing(def, option);
      collectors.crossings.push(result);
      return result;
    },
    depot: (item, target) => {
      const purchase = current.runner.openDepot().buy(item, target);
      current.runner.continueTravel();
      return purchase;
    },
    reclamation: (trace) => {
      current.runner.openReclamation();
      const result = current.runner.submitReclamation(trace);
      current.runner.continueTravel();
      return result;
    },
    note: (message) => { collectors.notes.push(message); },
  };
  let restore: { at: number; seq: number } | null = null;
  for (;;) {
    const runner = current.runner;
    const kernel = runner.kernel;
    const director = runner.director;
    if (kernel === null || director === null) break;
    if (collectors.panics.length > start.panics) break;
    const tick = kernel.tick;
    if (opts.restoreAt !== undefined && restore === null && tick >= opts.restoreAt) {
      const restored = restoreMidLeg(current, wrapped, legOpts, configure);
      current = restored.session;
      restore = { at: tick, seq: restored.seq };
      continue;
    }
    const slotStart = performance.now();
    for (const scheduledCrossing of scheduled) {
      if (scheduledCrossing.done || scheduledCrossing.at > tick) continue;
      scheduledCrossing.done = true;
      ctx.flushCommands();
      const context = runner.openCrossing(scheduledCrossing.def);
      const option = driver.chooseCrossing(context);
      collectors.crossings.push(runner.resolveCrossing(scheduledCrossing.def, option));
    }
    driver.beforeTick(ctx);
    runner.observeCommands(current.bus.drain(kernel.tick));
    if (collectors.panics.length > start.panics || runner.finished) {
      tickSamples.push((performance.now() - slotStart) / Math.max(1, kernel.tick - tick));
      break;
    }
    runner.preTick(kernel.tick);
    if (director.tickLimitReached) break;
    const eventStart = collectors.log.length;
    let events: readonly KernelEvent[];
    try {
      events = kernel.step();
    } catch (error) {
      collectors.panics.push(`tick ${kernel.tick}: kernel.step threw: ${describe(error)}`);
      break;
    }
    runner.postTick(kernel.tick, events);
    driver.afterTick(ctx, collectors.log.slice(eventStart));
    tickSamples.push((performance.now() - slotStart) / Math.max(1, kernel.tick - tick));
  }
  const ticks = current.runner.ticksElapsed;
  const onCredit = current.runner.director?.travel.onCredit ?? false;
  let outcome: LegOutcome;
  try {
    outcome = current.runner.exit();
  } catch (error) {
    collectors.runnerFailures.push(`${leg.id}: exit threw: ${describe(error)}`);
    outcome = failedOutcome(leg, describe(error));
  }
  const wallMs = performance.now() - wallStart;
  const sorted = [...tickSamples].sort((a, b) => a - b);
  const quantile = (q: number): number => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
  const maxTickMs = sorted.at(-1) ?? 0;
  const medianTickMs = quantile(0.5);
  const p95TickMs = quantile(0.95);
  const legEvents = collectors.log.slice(start.log);
  const run = structuredClone(current.store.get());
  const result: HarnessResult = {
    legId: leg.id,
    seed: opts.seed,
    ticks,
    events: opts.recordEvents === false ? [] : legEvents,
    eventTypes: new Set(legEvents.map((event) => event.type)),
    outcome,
    run,
    ledgerBefore,
    ledgerAfter: { ...run.resources },
    decisions: run.decisions.filter((record) => record.legId === leg.id),
    crossings: collectors.crossings.slice(start.crossings),
    panics: collectors.panics.slice(start.panics),
    legFailures: collectors.legFailures.slice(start.legFailures),
    runnerFailures: collectors.runnerFailures.slice(start.runnerFailures),
    unfiredSteps: driver.unfired(),
    logHash: hashEventLog(legEvents),
    restore: restore === null ? null : { at: restore.at, seq: restore.seq, remainderHash: hashEventLog(legEvents.filter((event) => event.seq > restore.seq)) },
    wallMs,
    maxTickMs,
    medianTickMs,
    p95TickMs,
    notes: collectors.notes.slice(start.notes),
    stageCalls: collectors.stageCalls - start.stageCalls,
    entry,
    onCredit,
  };
  return { result, session: current };
}

export async function runLeg(leg: Leg, opts: HarnessOptions): Promise<HarnessResult> {
  assertHeadless();
  const run = opts.run ?? makeRunState({ seed: opts.seed, legIndex: leg.index });
  const session = new HarnessSession(opts.seed, run, opts.throughputTarget ?? DEFAULT_THROUGHPUT_TARGET);
  return runLegInSession(session, leg, opts).result;
}

/** The hash of an uninterrupted run's events above `seq`, for comparison with a restored run's remainder. */
export function remainderHashAfter(result: HarnessResult, seq: number): string {
  return hashEventLog(result.events.filter((event) => event.seq > seq));
}

/**
 * Override members of a leg without spreading it, so a leg written as a class
 * instance keeps its prototype methods. Used by the inert-field test.
 */
export function overrideLeg(leg: Leg, overrides: Partial<Leg>): Leg {
  return new Proxy(leg, {
    get(target, key, receiver): unknown {
      if (typeof key === 'string' && key in overrides) return overrides[key as keyof Leg];
      return Reflect.get(target, key, receiver);
    },
  });
}

/**
 * Section 6, inert fields: a different valid value for every `KernelConfig`
 * field a disabled subsystem owns. Every leg enables `process` and
 * `scheduler`, so those two rows are empty by construction.
 */
export const INERT_POISON: Readonly<Record<SubsystemId, Partial<KernelConfig>>> = {
  process: {},
  scheduler: {},
  memory: { totalFrames: 48, pageSize: 8192, allocationStrategy: 'worst_fit', tlbEntries: 4 },
  vm: { replacementPolicy: 'random', thrashingThreshold: 999_999 },
  sync: {},
  deadlock: { deadlockStrategy: 'ignore' },
  storage: { diskPolicy: 'fcfs', totalCylinders: 50, raidLevel: 0 },
  io: {},
  fs: { fileAllocation: 'contiguous', journalingEnabled: false },
  security: {},
};

/** The poison patch for every subsystem the config leaves disabled, and the fields it touches. */
export function inertPoison(config: KernelConfig): { readonly patch: Partial<KernelConfig>; readonly fields: readonly string[] } {
  const enabled = new Set(config.enabledSubsystems);
  let patch: Partial<KernelConfig> = {};
  const fields: string[] = [];
  for (const subsystem of Object.keys(INERT_POISON) as SubsystemId[]) {
    if (enabled.has(subsystem)) continue;
    patch = { ...patch, ...INERT_POISON[subsystem] };
    fields.push(...Object.keys(INERT_POISON[subsystem]));
  }
  return { patch, fields };
}

/** The leg with every inert config field poisoned; its log hash must not move (section 6). */
export function withInertPoison(leg: Leg, run: RunState): { readonly leg: Leg; readonly fields: readonly string[] } {
  const { patch, fields } = inertPoison(leg.kernelConfig(run));
  return { leg: overrideLeg(leg, { kernelConfig: (state) => ({ ...leg.kernelConfig(state), ...patch }) }), fields };
}

/** Throws when a run panicked, a leg failed or the runner reported a failure; a suite that finds any of them fails. */
export function assertClean(result: HarnessResult): void {
  const problems: string[] = [];
  if (result.panics.length > 0) problems.push(`panics: ${result.panics.join('; ')}`);
  if (result.legFailures.length > 0) problems.push(`leg failures: ${result.legFailures.map((failure) => `${failure.phase}: ${describe(failure.error)}`).join('; ')}`);
  if (result.runnerFailures.length > 0) problems.push(`runner failures: ${result.runnerFailures.join('; ')}`);
  if (problems.length > 0) throw new Error(`[${result.legId} seed=${result.seed} ticks=${result.ticks} hash=${result.logHash}] ${problems.join('\n')}`);
}

/**
 * KERNEL TRAIL - the replay loop. Architecture 8.6; WP-18 specification
 * section 3, scope corrections U2, U3, U4, U5 and U12, pre-flight rulings 6,
 * 7, 9 and 16.
 *
 * Pure and callable from either thread. A run is a pure function of
 * (seed, discClass, difficulty, decisionLog): nothing here reads a clock, a
 * frame rate, a tier or a window, and every decision lands through
 * `CommandBus.apply`, the same road live play uses, so the two cannot diverge
 * in how a decision lands. Random events are WP-19's obligation through
 * `ReplayHooks.beforeStep`; this package proves purity for decisions and
 * policy.
 */

import { createKernel } from '@kernel/Kernel';
import type { ConvoyMemberId, KernelConfig, KernelEvent, KernelSnapshot, Pid, SchedulerId } from '@kernel/types';
import { LEG_ORDER, type ConvoyMember, type DecisionRecord, type DifficultyTier, type DiscClass, type Epitaph, type LegId, type LegOutcome, type RunState } from '@game/types';
import { CommandBus, commandFromRecord, originFromRecord, type Command, type CommandHandlers, type CommandOrigin } from '@game/CommandBus';
import { createRunStore } from '@game/runStore';
import type { Store } from '@game/store';
import { classMultiplierFor, scoreFromRun, SCORE_WEIGHTS } from '@game/scoring';
import { startingLedger } from '../travel/ledger';
import { paceSpawnTransform } from '../travel/workload';
import { createHeadlessSetupContext, resolveHeadlessLeg, type ConvoyBindings } from './headlessLegs';
import { hashEventLog } from './hash';
import { selectHighlights } from './highlights';
import {
  DEFAULT_POLICY_BINDING,
  REPLAY_KERNEL_OPTIONS,
  createRunStreams,
  restoreRunStreams,
  saveRunStreams,
  type HeadlessLeg,
  type ObservedLeg,
  type ReplayHooks,
  type ReplayKernel,
  type ReplayOptions,
  type ReplayOverrides,
  type ReplayRequest,
  type ReplayResponse,
  type ReplayResult,
} from './types';

/** Progress is posted and cancellation polled at this cadence, architecture 9.4. */
export const PROGRESS_INTERVAL = 500;

/** The default degree of multiprogramming the run starts at; the HUD fixture's value. */
export const DEFAULT_DEGREE = 6;

const ROSTER: readonly { readonly id: ConvoyMemberId; readonly name: string; readonly role: ConvoyMember['role'] }[] = [
  { id: 'lumen', name: 'LUMEN', role: 'compiler' },
  { id: 'sable', name: 'SABLE', role: 'sentinel' },
  { id: 'orrery', name: 'ORRERY', role: 'codec' },
  { id: 'kestrel', name: 'KESTREL', role: 'courier' },
  { id: 'vesper', name: 'VESPER', role: 'cartographer' },
];

/** Shared live/replay roster, policy and starting allocation. WP-19 ruling R4. */
export function initialRunState(seed: number, discClass: DiscClass, difficulty: DifficultyTier): RunState {
  return {
    runId: `run-${(seed >>> 0).toString(16)}`,
    seed,
    discClass,
    difficulty,
    legIndex: 0,
    legProgress: 0,
    convoy: ROSTER.map((m) => ({ id: m.id, name: m.name, role: m.role, pid: null, integrity: 100, status: 'nominal', epitaph: null, abilityCharges: 0, afflictions: [] })),
    resources: startingLedger(discClass, difficulty),
    policy: { pace: 'steady', rations: 'standard', degreeOfMultiprogramming: DEFAULT_DEGREE },
    tombstones: [],
    codexUnlocked: [],
    objectivesMet: [],
    decisions: [],
    score: { survivors: 0, throughput: 0, efficiency: 0, correctness: 0, conceptsMastered: 0, classMultiplier: classMultiplierFor(discClass, difficulty), total: 0 },
    status: 'in_progress',
  };
}

/* ------------------------------------------------------------------ */
/* Decisions and overrides                                             */
/* ------------------------------------------------------------------ */

const POLICY_KINDS: ReadonlySet<Command['kind']> = new Set(['set_pace', 'set_rations', 'set_degree']);

/** The verbs replay never reaches: `commandFromRecord` returns null for their kinds first. */
const REPLAY_HANDLERS: CommandHandlers = {
  useAbility: () => {
    throw new Error('replay never applies use_ability');
  },
  interaction: () => {
    throw new Error('replay never applies interaction');
  },
  terminal: () => {
    throw new Error('replay never applies terminal');
  },
};

function overriddenKinds(o: ReplayOverrides): ReadonlySet<Command['kind']> {
  const kinds = new Set<Command['kind']>();
  if (o.scheduler !== undefined || o.quantum !== undefined) kinds.add('set_scheduler');
  if (o.replacement !== undefined) kinds.add('set_replacement');
  if (o.diskPolicy !== undefined) kinds.add('set_disk_policy');
  if (o.allocation !== undefined) kinds.add('set_allocation');
  if (o.pace !== undefined) kinds.add('set_pace');
  if (o.rations !== undefined) kinds.add('set_rations');
  if (o.degreeOfMultiprogramming !== undefined) kinds.add('set_degree');
  return kinds;
}

function scheduler(to: SchedulerId, quantum: number | undefined): Command {
  return quantum === undefined ? { kind: 'set_scheduler', to } : { kind: 'set_scheduler', to, quantum };
}

/**
 * Pre-flight ruling 6: an overridden kind is applied once at leg start, in
 * place of the leg's configuration, so "the same leg with srtf" works for a
 * player who never touched the scheduler.
 */
function startCommands(o: ReplayOverrides, config: KernelConfig): Command[] {
  const out: Command[] = [];
  if (o.scheduler !== undefined || o.quantum !== undefined) out.push(scheduler(o.scheduler ?? config.scheduler, o.quantum));
  if (o.replacement !== undefined) out.push({ kind: 'set_replacement', to: o.replacement });
  if (o.diskPolicy !== undefined) out.push({ kind: 'set_disk_policy', to: o.diskPolicy });
  if (o.allocation !== undefined) out.push({ kind: 'set_allocation', to: o.allocation });
  if (o.pace !== undefined) out.push({ kind: 'set_pace', to: o.pace });
  if (o.rations !== undefined) out.push({ kind: 'set_rations', to: o.rations });
  if (o.degreeOfMultiprogramming !== undefined) out.push({ kind: 'set_degree', to: o.degreeOfMultiprogramming });
  return out;
}

/** The override in place of a recorded command of its kind, field by field. */
function replaceWithOverride(o: ReplayOverrides, cmd: Command): Command {
  switch (cmd.kind) {
    case 'set_scheduler':
      return scheduler(o.scheduler ?? cmd.to, o.quantum ?? cmd.quantum);
    case 'set_replacement':
      return { kind: 'set_replacement', to: o.replacement ?? cmd.to };
    case 'set_disk_policy':
      return { kind: 'set_disk_policy', to: o.diskPolicy ?? cmd.to };
    case 'set_allocation':
      return { kind: 'set_allocation', to: o.allocation ?? cmd.to };
    case 'set_pace':
      return { kind: 'set_pace', to: o.pace ?? cmd.to };
    case 'set_rations':
      return { kind: 'set_rations', to: o.rations ?? cmd.to };
    case 'set_degree':
      return { kind: 'set_degree', to: o.degreeOfMultiprogramming ?? cmd.to };
    default:
      return cmd;
  }
}

export type ScheduledDecision =
  | { readonly kind: 'command'; readonly command: Command; readonly origin: CommandOrigin }
  | { readonly kind: 'action'; readonly record: DecisionRecord };

/** Preserve record order between bus commands and director-owned actions. */
export function scheduleDecisions(request: ReplayRequest, legId: LegId, config: KernelConfig): {
  readonly schedule: ReadonlyMap<number, readonly Command[]>;
  readonly skipped: number;
  readonly actions: ReadonlyMap<number, readonly ScheduledDecision[]>;
} {
  const o = request.overrides;
  const overridden = overriddenKinds(o);
  const schedule = new Map<number, Command[]>();
  const actions = new Map<number, ScheduledDecision[]>();
  let skipped = 0;
  const add = (tick: number, action: ScheduledDecision): void => {
    const ordered = actions.get(tick);
    if (ordered === undefined) actions.set(tick, [action]);
    else ordered.push(action);
    if (action.kind === 'command') {
      const list = schedule.get(tick);
      if (list === undefined) schedule.set(tick, [action.command]);
      else list.push(action.command);
    }
  };
  for (const command of startCommands(o, config)) add(0, { kind: 'command', command, origin: { source: 'replay', legId } });
  for (const record of request.decisions) {
    if (record.legId !== legId) continue;
    const cmd = commandFromRecord(record);
    if (cmd === null) {
      skipped += 1;
      add(record.tick, { kind: 'action', record });
      continue;
    }
    if (overridden.has(cmd.kind)) {
      if (o.suppressRecordedPolicyChanges) continue;
      add(record.tick, { kind: 'command', command: replaceWithOverride(o, cmd), origin: originFromRecord(record) });
      continue;
    }
    add(record.tick, { kind: 'command', command: cmd, origin: originFromRecord(record) });
  }
  return { schedule, skipped, actions };
}

/* ------------------------------------------------------------------ */
/* Game-state writes the live runner also makes (ruling 16)            */
/* ------------------------------------------------------------------ */

export function memberOf(bindings: ReadonlyMap<ConvoyMemberId, Pid>, pid: Pid): ConvoyMemberId | null {
  for (const [member, bound] of bindings) if (bound === pid) return member;
  return null;
}

/** A bound Program whose process exited abnormally is derezzed. Exported so WP-19's postTick makes the same write. */
export function noteExits(store: Store<RunState>, bindings: ReadonlyMap<ConvoyMemberId, Pid>, events: readonly KernelEvent[]): void {
  const fallen: ConvoyMemberId[] = [];
  for (const event of events) {
    if (event.type !== 'process.exited' || event.reason === 'normal_exit') continue;
    const member = memberOf(bindings, event.pid);
    if (member !== null) fallen.push(member);
  }
  if (fallen.length === 0) return;
  store.mutate((s) => {
    for (const m of s.convoy) {
      if (fallen.includes(m.id) && m.status !== 'derezzed') {
        m.status = 'derezzed';
        m.integrity = 0;
      }
    }
  });
}

/**
 * What one leg produced, in the shape the planner and the phrasing read:
 * casualties from `process.exited`, supplemented by game tombstones when
 * the bound process was not live at derezz; head movement summed
 * from `disk.seek`, the rest from the snapshot's metrics. The live runner
 * calls this at leg end with its own snapshot, log and bindings, so the
 * planner sees the same numbers a replay of that leg would report.
 */
export function observeLeg(snapshot: KernelSnapshot, events: readonly KernelEvent[], bindings: ReadonlyMap<ConvoyMemberId, Pid>, tombstones: readonly Epitaph[] = []): ObservedLeg {
  const casualties: { member: string; reason: string; tick: number }[] = [];
  let seekDistance = 0;
  for (const event of events) {
    if (event.type === 'disk.seek') seekDistance += event.distance;
    else if (event.type === 'process.exited' && event.reason !== 'normal_exit') {
      const member = memberOf(bindings, event.pid);
      if (member !== null) casualties.push({ member, reason: event.reason, tick: event.tick });
    }
  }
  // Match each member's deaths by occurrence. Command exits can precede
  // their postTick epitaph by one tick; the game's reason and tick win.
  const unmatchedEventDeaths = [...casualties];
  casualties.length = 0;
  for (const stone of tombstones) {
    const index = unmatchedEventDeaths.findIndex(death => death.member === stone.member);
    if (index >= 0) unmatchedEventDeaths.splice(index, 1);
    casualties.push({ member: stone.member, reason: stone.reason, tick: stone.tick });
  }
  casualties.push(...unmatchedEventDeaths);
  casualties.sort((a, b) => a.tick - b.tick);
  const metrics = snapshot.metrics;
  return {
    casualties,
    scheduling: {
      averageWaitingTime: metrics.scheduling.averageWaitingTime,
      averageTurnaroundTime: metrics.scheduling.averageTurnaroundTime,
      averageResponseTime: metrics.scheduling.averageResponseTime,
      contextSwitches: metrics.scheduling.contextSwitches,
      cpuUtilisation: metrics.scheduling.cpuUtilisation,
      worstWait: metrics.scheduling.worstWait,
    },
    memory: {
      pageFaults: metrics.memory.pageFaults,
      evictions: metrics.memory.evictions,
      faultRate: metrics.memory.faultRate,
    },
    storage: { seekDistance },
  };
}

const LEDGER_KEYS = ['cycles', 'quota', 'blocks', 'bandwidth'] as const;

/** Leg exit: casualties, the resource delta, objectives and codex unlocks, then the index and status. Exported so WP-19's exit makes the same writes. */
export function applyLegOutcome(store: Store<RunState>, outcome: LegOutcome, legIndex: number): void {
  store.mutate((s) => {
    for (const m of s.convoy) {
      if (outcome.casualties.includes(m.id) && m.status !== 'derezzed') {
        m.status = 'derezzed';
        m.integrity = 0;
      }
    }
    for (const key of LEDGER_KEYS) {
      const delta = outcome.resourceDelta[key];
      if (delta !== undefined) s.resources[key] += delta;
    }
    for (const id of outcome.objectivesMet) if (!s.objectivesMet.includes(id)) s.objectivesMet.push(id);
    for (const id of outcome.codexUnlocked) if (!s.codexUnlocked.includes(id)) s.codexUnlocked.push(id);
    s.legProgress = 1;
    s.legIndex = legIndex + 1;
    s.status = s.convoy.every((m) => m.status === 'derezzed') ? 'failed' : legIndex + 1 >= LEG_ORDER.length ? 'complete' : 'in_progress';
  });
}

/* ------------------------------------------------------------------ */
/* The loop                                                            */
/* ------------------------------------------------------------------ */

/** The default leg end: every process above init has terminated. */
export function workloadDrained(_tick: number, kernel: ReplayKernel): boolean {
  return kernel.processes.every((p) => p.pid <= 1 || p.state === 'terminated');
}

/**
 * Pre-flight ruling 2: the deadlock row substitutes a modified KernelConfig
 * in the headless factory for that one replay. The patch rides on the
 * request as data, and the wrapped leg hands the kernel a config with the
 * strategy replaced before construction.
 */
function withConfigPatch(leg: HeadlessLeg, patch: ReplayRequest['configPatch']): HeadlessLeg {
  const strategy = patch?.deadlockStrategy;
  if (strategy === undefined) return leg;
  const patched: HeadlessLeg = {
    id: leg.id,
    index: leg.index,
    kernelConfig: (run) => ({ ...leg.kernelConfig(run), deadlockStrategy: strategy }),
    populate: (ctx) => leg.populate(ctx),
    eventTable: leg.eventTable,
    evaluate: (ctx) => leg.evaluate(ctx),
  };
  return leg.hooks === undefined ? patched : { ...patched, hooks: leg.hooks };
}

export const failure = (reason: 'aborted' | 'error', message: string): ReplayResponse => ({ ok: false, reason, message });

function cloneRun(run: RunState): RunState {
  return structuredClone(run);
}

/**
 * The synchronous form: drains `replaySteps`, posting progress at every
 * yield and honouring `isCancelled` there, so a cancel lands within 500
 * ticks. A thrown leg or kernel error becomes an error response.
 */
export function runReplay(request: ReplayRequest, options: ReplayOptions = {}): ReplayResponse {
  try {
    const steps = replaySteps(request, options);
    for (;;) {
      const next = steps.next();
      if (next.done) return next.value;
      options.onProgress?.(next.value);
      if (options.isCancelled?.() === true) {
        steps.return(failure('aborted', 'cancelled'));
        return failure('aborted', `Replay cancelled at tick ${next.value}.`);
      }
    }
  } catch (error) {
    return failure('error', error instanceof Error ? error.message : String(error));
  }
}

/**
 * The loop as a generator that yields the tick count every 500 ticks. The
 * worker pumps it one chunk per macrotask, which is what lets a cancel
 * message land while a replay is in flight: a worker handles one message at
 * a time, so a synchronous loop could never see one. `runReplay` drains it
 * in place for callers on either thread.
 */
export function* replaySteps(request: ReplayRequest, options: ReplayOptions = {}): Generator<number, ReplayResponse, void> {
  const resolve = options.legs ?? resolveHeadlessLeg;
  const binding = options.binding ?? DEFAULT_POLICY_BINDING;
  const kernelOptions = options.kernelOptions ?? REPLAY_KERNEL_OPTIONS;
  if (!Number.isSafeInteger(request.maxTicks) || request.maxTicks < 0) return failure('error', 'maxTicks must be a non-negative integer.');
  if (request.legs.length === 0) return failure('error', 'Replay request names no legs.');

  const entry = options.entry ?? request.entry;
  const store = createRunStore(entry === undefined ? initialRunState(request.seed, request.discClass, request.difficulty) : cloneRun(entry.run));
  const streams = createRunStreams(request.seed);
  if (entry !== undefined) restoreRunStreams(streams, 'rngStates' in entry ? entry.rngStates : entry.rng);

  const log: KernelEvent[] = [];
  const legs: { legId: LegId; ticks: number; eventLogHash: string }[] = [];
  const casualties: { member: string; reason: string; tick: number }[] = [];
  let totalTicks = 0;
  let skippedDecisions = 0;
  let completions = store.get().score.throughput / SCORE_WEIGHTS.perCompletion;
  let seekDistance = 0;
  let last: { readonly snapshot: KernelSnapshot; readonly events: readonly KernelEvent[]; readonly bindings: ConvoyBindings } | null = null;

  for (const [index, legId] of request.legs.entries()) {
    const leg = withConfigPatch(resolve(legId), request.configPatch);
    const hooks: ReplayHooks = leg.hooks ?? {};
    hooks.enter?.(streams, store);
    store.mutate((s) => {
      s.legIndex = leg.index;
      s.legProgress = 0;
      // Resolve the initial policy before populate so arrivals see the override.
      if (request.overrides.pace !== undefined) s.policy.pace = request.overrides.pace;
      if (request.overrides.rations !== undefined) s.policy.rations = request.overrides.rations;
      if (request.overrides.degreeOfMultiprogramming !== undefined) s.policy.degreeOfMultiprogramming = request.overrides.degreeOfMultiprogramming;
      for (const m of s.convoy) m.pid = null;
    });
    options.onLegEntry?.(index, legId, store.get(), saveRunStreams(streams));
    // U12: the seed is KernelConfig.seed and the request's wins.
    const config: KernelConfig = { ...leg.kernelConfig(store.get()), seed: request.seed };
    const kernel = createKernel(config, kernelOptions);
    const bindings: ConvoyBindings = new Map();
    const policy = store.get().policy;
    leg.populate(createHeadlessSetupContext(kernel, store.get(), streams.leg.fork(legId), bindings, paceSpawnTransform(policy.pace)));
    store.mutate((s) => {
      for (const m of s.convoy) m.pid = bindings.get(m.id) ?? null;
    });
    const applyBinding = (): void => {
      binding.apply(kernel, store.get().policy);
      // An explicit counterfactual quantum wins over the pace mapping (R4).
      if (request.overrides.quantum !== undefined) {
        kernel.setScheduler(kernel.invariantState().schedulerId, { quantum: request.overrides.quantum });
      }
    };
    applyBinding();
    const bus = new CommandBus({ store, kernel, handlers: REPLAY_HANDLERS, ...(hooks.admit === undefined ? {} : { admit: hooks.admit }) });
    const { actions } = scheduleDecisions(request, legId, config);
    const isComplete = hooks.isComplete ?? workloadDrained;
    const legLog: KernelEvent[] = [];
    const tombstoneStart = store.get().tombstones.length;
    const seen = new Set<number>();
    // Subscribe before command application: step() clears its frame, and
    // afterStep may emit lifecycle events after step() returns. Ruling R6.
    const unsubscribe = kernel.events.onAny((event) => {
      if (seen.has(event.seq)) return;
      seen.add(event.seq);
      legLog.push(event);
      if (event.type === 'disk.seek') seekDistance += event.distance;
      else if (event.type === 'process.exited' && event.reason === 'normal_exit' && memberOf(bindings, event.pid) === null) completions += 1;
    });
    let legTicks = 0;
    try {
      for (;;) {
        const tick = kernel.tick;
        const alreadyComplete = isComplete(tick, kernel, store.get());
        if (!alreadyComplete && totalTicks >= request.maxTicks) return failure('aborted', `Replay exceeded maxTicks (${request.maxTicks}) in leg ${legId} at tick ${tick}.`);
        const eventStart = legLog.length;
        const due = actions.get(tick);
        if (due !== undefined) {
          // One binding after the accepted batch, shared with the live host.
          let policyChanged = false;
          for (const action of due) {
            if (action.kind === 'action') {
              if (hooks.dispatch?.(action.record, kernel, streams, store) !== true) skippedDecisions += 1;
              continue;
            }
            const outcome = bus.apply(action.command, action.origin, kernel.tick);
            if (outcome.refused === null && POLICY_KINDS.has(action.command.kind)) policyChanged = true;
          }
          if (policyChanged) applyBinding();
        }
        // Director actions can simulate crossing ticks themselves. Keep the
        // budget and elapsed count in kernel ticks, including those actions.
        const actionTicks = kernel.tick - tick;
        totalTicks += actionTicks;
        legTicks += actionTicks;
        if (totalTicks > request.maxTicks) return failure('aborted', `Replay exceeded maxTicks (${request.maxTicks}) in leg ${legId} at tick ${kernel.tick}.`);
        if (isComplete(kernel.tick, kernel, store.get())) {
          noteExits(store, bindings, legLog.slice(eventStart));
          break;
        }
        if (totalTicks >= request.maxTicks) return failure('aborted', `Replay exceeded maxTicks (${request.maxTicks}) in leg ${legId} at tick ${kernel.tick}.`);
        hooks.beforeStep?.(kernel.tick, kernel, streams, store);
        kernel.step();
        const events = legLog.slice(eventStart);
        hooks.afterStep?.(kernel.tick, kernel, events, store);
        // Let the director build epitaphs before the fallback marks exits.
        // Include lifecycle events emitted by afterStep itself (R6).
        noteExits(store, bindings, legLog.slice(eventStart));
        totalTicks += 1;
        legTicks += 1;
        if (totalTicks % PROGRESS_INTERVAL === 0) yield totalTicks;
      }
    } finally {
      unsubscribe();
    }
    const snapshot = kernel.snapshot();
    const outcome = leg.evaluate({ run: store.get(), kernelSnapshot: snapshot, events: legLog, ticksElapsed: legTicks });
    applyLegOutcome(store, outcome, leg.index);
    casualties.push(...observeLeg(snapshot, legLog, bindings, store.get().tombstones.slice(tombstoneStart).filter(stone => stone.legId === legId)).casualties);
    legs.push({ legId, ticks: legTicks, eventLogHash: hashEventLog(legLog) });
    for (const event of legLog) log.push(event);
    last = { snapshot, events: legLog, bindings };
  }
  if (last === null) return failure('error', 'Replay request names no legs.');
  const run = store.get();
  const bindings = last.bindings;
  // Scheduling and memory are the last leg's; casualties and head movement accumulate across the legs replayed.
  const observed = observeLeg(last.snapshot, last.events, bindings);
  const result: ReplayResult = {
    ok: true,
    ticks: totalTicks,
    eventLogHash: hashEventLog(log),
    survivors: run.convoy.filter((m) => m.status !== 'derezzed').map((m) => m.id),
    casualties,
    scheduling: observed.scheduling,
    memory: observed.memory,
    storage: { seekDistance },
    score: scoreFromRun(run, { workloadCompletions: completions, privilegeExcess: 0 }),
    highlights: selectHighlights(last.events, (pid) => memberOf(bindings, pid)),
    diagnostics: { skippedDecisions, legs },
  };
  return result;
}

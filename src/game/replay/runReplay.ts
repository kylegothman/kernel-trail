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
import { LEG_ORDER, type ConvoyMember, type DifficultyTier, type DiscClass, type LegId, type LegOutcome, type RunState } from '@game/types';
import { CommandBus, commandFromRecord, type Command, type CommandHandlers } from '@game/CommandBus';
import { createRunStore } from '@game/runStore';
import type { Store } from '@game/store';
import { classMultiplierFor, scoreFromRun } from '@game/scoring';
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

/**
 * Pre-flight ruling 7. The five-member roster at 100 integrity, the default
 * policy and a zero ledger: enough to rebuild `Leg.kernelConfig(run)` from a
 * request, which is all a replay needs. The ledger never reaches the kernel.
 */
// TODO(astra): WP-19 routes the live run through initialRunState so the starting ledger, roster and default degree are one function
export function initialRunState(seed: number, discClass: DiscClass, difficulty: DifficultyTier): RunState {
  return {
    runId: `run-${(seed >>> 0).toString(16)}`,
    seed,
    discClass,
    difficulty,
    legIndex: 0,
    legProgress: 0,
    convoy: ROSTER.map((m) => ({ id: m.id, name: m.name, role: m.role, pid: null, integrity: 100, status: 'nominal', epitaph: null, abilityCharges: 0, afflictions: [] })),
    resources: { cycles: 0, quota: 0, blocks: 0, bandwidth: 0 },
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

/** Commands by the leg-local kernel tick they land on: overrides at tick 0, then the log in record order. */
export function scheduleDecisions(request: ReplayRequest, legId: LegId, config: KernelConfig): { readonly schedule: ReadonlyMap<number, readonly Command[]>; readonly skipped: number } {
  const o = request.overrides;
  const overridden = overriddenKinds(o);
  const schedule = new Map<number, Command[]>();
  let skipped = 0;
  const add = (tick: number, cmd: Command): void => {
    const list = schedule.get(tick);
    if (list === undefined) schedule.set(tick, [cmd]);
    else list.push(cmd);
  };
  for (const cmd of startCommands(o, config)) add(0, cmd);
  for (const record of request.decisions) {
    if (record.legId !== legId) continue;
    const cmd = commandFromRecord(record);
    if (cmd === null) {
      skipped += 1;
      continue;
    }
    if (overridden.has(cmd.kind)) {
      if (o.suppressRecordedPolicyChanges) continue;
      add(record.tick, replaceWithOverride(o, cmd));
      continue;
    }
    add(record.tick, cmd);
  }
  return { schedule, skipped };
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

  const store = createRunStore(options.entry === undefined ? initialRunState(request.seed, request.discClass, request.difficulty) : cloneRun(options.entry.run));
  const streams = createRunStreams(request.seed);
  if (options.entry !== undefined) restoreRunStreams(streams, options.entry.rng);

  const log: KernelEvent[] = [];
  const legs: { legId: LegId; ticks: number; eventLogHash: string }[] = [];
  const casualties: { member: string; reason: string; tick: number }[] = [];
  let totalTicks = 0;
  let skippedDecisions = 0;
  let completions = 0;
  let seekDistance = 0;
  let last: { readonly snapshot: KernelSnapshot; readonly events: readonly KernelEvent[]; readonly bindings: ConvoyBindings } | null = null;

  for (const [index, legId] of request.legs.entries()) {
    const leg = withConfigPatch(resolve(legId), request.configPatch);
    store.mutate((s) => {
      s.legIndex = leg.index;
      s.legProgress = 0;
      for (const m of s.convoy) m.pid = null;
    });
    options.onLegEntry?.(index, legId, store.get(), saveRunStreams(streams));
    // U12: the seed is KernelConfig.seed and the request's wins.
    const config: KernelConfig = { ...leg.kernelConfig(store.get()), seed: request.seed };
    const kernel = createKernel(config, kernelOptions);
    const bindings: ConvoyBindings = new Map();
    leg.populate(createHeadlessSetupContext(kernel, store.get(), streams.leg.fork(legId), bindings));
    store.mutate((s) => {
      for (const m of s.convoy) m.pid = bindings.get(m.id) ?? null;
    });
    binding.apply(kernel, store.get().policy);
    const bus = new CommandBus({ store, kernel, handlers: REPLAY_HANDLERS });
    const { schedule, skipped } = scheduleDecisions(request, legId, config);
    skippedDecisions += skipped;
    const hooks: ReplayHooks = leg.hooks ?? {};
    const isComplete = hooks.isComplete ?? workloadDrained;
    const legLog: KernelEvent[] = [];
    let legTicks = 0;
    for (;;) {
      const tick = kernel.tick;
      if (isComplete(tick, kernel, store.get())) break;
      if (totalTicks >= request.maxTicks) return failure('aborted', `Replay exceeded maxTicks (${request.maxTicks}) in leg ${legId} at tick ${tick}.`);
      const due = schedule.get(tick);
      if (due !== undefined) {
        // The binding runs once after the tick's batch, which is what a host
        // that drains the bus and then maps the policy does; per-command
        // application would call the kernel a different number of times.
        let policyChanged = false;
        for (const cmd of due) {
          bus.apply(cmd, { source: 'replay', legId }, tick);
          if (POLICY_KINDS.has(cmd.kind)) policyChanged = true;
        }
        if (policyChanged) binding.apply(kernel, store.get().policy);
      }
      hooks.beforeStep?.(tick, kernel, streams, store);
      // `lastFrame` is one array reused every step, so the frame is copied out.
      const events = [...kernel.step()];
      for (const event of events) {
        legLog.push(event);
        if (event.type === 'disk.seek') seekDistance += event.distance;
        else if (event.type === 'process.exited') {
          if (event.reason === 'normal_exit') completions += 1;
          else {
            const member = memberOf(bindings, event.pid);
            if (member !== null) casualties.push({ member, reason: event.reason, tick: event.tick });
          }
        }
      }
      noteExits(store, bindings, events);
      hooks.afterStep?.(kernel.tick, kernel, events, store);
      totalTicks += 1;
      legTicks += 1;
      if (totalTicks % PROGRESS_INTERVAL === 0) yield totalTicks;
    }
    const snapshot = kernel.snapshot();
    const outcome = leg.evaluate({ run: store.get(), kernelSnapshot: snapshot, events: legLog, ticksElapsed: legTicks });
    applyLegOutcome(store, outcome, leg.index);
    legs.push({ legId, ticks: legTicks, eventLogHash: hashEventLog(legLog) });
    for (const event of legLog) log.push(event);
    last = { snapshot, events: legLog, bindings };
  }
  if (last === null) return failure('error', 'Replay request names no legs.');
  const run = store.get();
  const metrics = last.snapshot.metrics;
  const bindings = last.bindings;
  const result: ReplayResult = {
    ok: true,
    ticks: totalTicks,
    eventLogHash: hashEventLog(log),
    survivors: run.convoy.filter((m) => m.status !== 'derezzed').map((m) => m.id),
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
    score: scoreFromRun(run, { workloadCompletions: completions, privilegeExcess: 0 }),
    highlights: selectHighlights(last.events, (pid) => memberOf(bindings, pid)),
    diagnostics: { skippedDecisions, legs },
  };
  return result;
}

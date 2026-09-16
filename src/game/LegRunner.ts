import { asTick, type ConvoyMemberId, type createKernel, type KernelEvent, type KernelConfig, type Tick } from '@kernel/index';
import { CommandBus, commandFromRecord, originFromRecord, type CommandKind, type CommandOutcome } from './CommandBus';
import type { CodexCounterfactual, CodexUnlock } from './codexTypes';
import type { EpitaphCopySource } from './convoy/derezz';
import { PER_LEG_ABILITY_CHARGES } from './convoy/status';
import { LegSandbox, type LegFailure } from './LegSandbox';
import { DIRECTOR_OWNED_KINDS, LEG_DONE_KIND, legDone, RunDirector, type DirectorSnapshot, type InteractionHandler } from './RunDirector';
import { buildDebrief, type DebriefView } from './debrief';
import type { CrossingDef, CrossingResult } from './crossing/Crossing';
import type { CrossingContext, CrossingOption } from './crossing/options';
import type { Depot } from './depot/Depot';
import type { ReclamationResult, ReclamationTrace } from './reclamation/Reclamation';
import type { VergeLayout } from './reclamation/verge';
import { populateHeadless, registerHeadlessLeg, type ConvoyBindings } from './replay/headlessLegs';
import { planCounterfactuals } from './replay/CounterfactualPlanner';
import { hashEventLog } from './replay/hash';
import { phraseCounterfactual, toCodexCounterfactual } from './replay/phrasing';
import { applyLegOutcome, initialRunState, noteExits, observeLeg } from './replay/runReplay';
import { createRunStreams, REPLAY_KERNEL_OPTIONS, restoreRunStreams, saveRunStreams, type HeadlessLeg, type ReplayEntry, type ReplayHooks, type ReplayKernel, type RunStreams } from './replay/types';
import { recordLegEntry, recordLegHash, startReplayRecord } from './replay/verify';
import { createRunStore, type RunStore } from './runStore';
import type { Store } from './store';
import { buildSaveFile, type ReplayRecord, type SaveFileInput } from './save';
import { resumeRun } from './persist/LoadService';
import { scoreFromRun, SCORE_WEIGHTS } from './scoring';
import { applyDelta, emergencyCreditNeeded, legDividend, refillBandwidth } from './travel/ledger';
import { PACE_TABLE } from './travel/paceRations';
import { livePolicyBinding } from './travel/policyBinding';
import { DEPOT_LEGS } from './travel/segments';
import { paceSpawnTransform } from './travel/workload';
import { LEG_ORDER, type DecisionRecord, type Epitaph, type Leg, type LegId, type LegOutcome, type LegStage, type RunState, type SaveFile, type StageContext } from './types';
import type { ReplayWorkerHandle } from './workers/ReplayWorkerHandle';
import type { LegContent } from '@legs/content';

export type LegPhase = 'entering' | 'travelling' | 'crossing' | 'depot' | 'reclamation' | 'evaluating' | 'complete';

export type LegEvent =
  | { readonly kind: 'leg_unavailable'; readonly legId: LegId; readonly index: number; readonly reason: string }
  | { readonly kind: 'tombstone'; readonly epitaph: Epitaph; readonly memberName: string }
  | { readonly kind: 'panic'; readonly message: string; readonly tick: Tick }
  | { readonly kind: 'debrief'; readonly view: DebriefView }
  | { readonly kind: 'crossing_open'; readonly def: CrossingDef; readonly context: CrossingContext }
  | { readonly kind: 'depot_open'; readonly depot: Depot }
  | { readonly kind: 'reclamation_open'; readonly layout: VergeLayout };

export interface LegRunnerDeps {
  readonly runStore: RunStore;
  readonly commandBus: CommandBus;
  readonly createKernel: typeof createKernel;
  readonly streams: RunStreams;
  readonly onEvent: (events: readonly KernelEvent[], at: Tick) => void;
  readonly replay: ReplayWorkerHandle | null;
  readonly epitaphs: EpitaphCopySource;
  readonly persist: (input: SaveFileInput, kind: 'boundary' | 'provisional') => void;
  readonly buildId: string;
  readonly savedAtIso: () => string;
  readonly throughputTarget: (leg: Leg, run: Readonly<RunState>) => number;
  readonly onLegEvent: (event: LegEvent) => void;
  readonly codexSignal: (signal: Extract<CodexUnlock, { kind: 'crossing' | 'leg_complete' }>) => void;
  readonly onDerezz: (phase: 'begin' | 'tombstone') => void;
  readonly onFailure: (failure: LegFailure, leg: Leg) => void;
  readonly onRunnerFailure: (message: string, leg: Leg, at: Tick) => void;
}

export interface LegRunOptions {
  readonly maxTicks: number;
  readonly stageContext: StageContext | null;
}

export interface RecruitPassive {
  readonly member: ConvoyMemberId;
  readonly passiveMultiplier: number;
  readonly restoresCodecPassive: false;
}

interface Checkpoint {
  readonly legIndex: number;
  readonly file: SaveFile;
  readonly director: DirectorSnapshot;
  readonly recruits: readonly RecruitPassive[];
  readonly replayRecord: ReplayRecord;
}

/** Every kind the bus records; exhaustive over `Command`, so a new command kind is a compile error here (WP-20 W9). */
const BUS_KINDS: Readonly<Record<CommandKind, true>> = {
  set_scheduler: true, set_replacement: true, set_disk_policy: true, set_allocation: true, set_deadlock_strategy: true,
  set_pace: true, set_rations: true, set_degree: true, use_ability: true, syscall: true, interaction: true, terminal: true,
};

/** Copy plain run data through reads, including guarded store views. */
function cloneRunState(run: Readonly<RunState>): RunState {
  return { ...run, resources: { ...run.resources }, policy: { ...run.policy }, score: { ...run.score },
    convoy: run.convoy.map(member => ({ ...member, epitaph: member.epitaph === null ? null : { ...member.epitaph },
      afflictions: member.afflictions.map(affliction => ({ ...affliction, remedy: { ...affliction.remedy } })) })),
    tombstones: run.tombstones.map(epitaph => ({ ...epitaph })), decisions: run.decisions.map(decision => ({ ...decision })),
    codexUnlocked: [...run.codexUnlocked], objectivesMet: [...run.objectivesMet] };
}

/** Derive a transaction draft; failed content entry never spends the live ledger. */
export function prepareLegEntry(run: Readonly<RunState>, leg: Leg): RunState {
  const next = cloneRunState(run);
  refillBandwidth(next.resources, next.discClass, next.difficulty, DEPOT_LEGS.includes(leg.id));
  next.legIndex = leg.index; next.legProgress = 0;
  if (emergencyCreditNeeded(next.resources, leg.id)) next.policy.pace = 'conservative';
  if (next.resources.quota === 0) next.policy.rations = 'starved';
  for (const member of next.convoy) {
    member.pid = null;
    if (member.status !== 'derezzed') member.abilityCharges = PER_LEG_ABILITY_CHARGES[member.role] - (member.name.endsWith('-2') ? 1 : 0);
  }
  return next;
}

function configured(config: KernelConfig, run: Readonly<RunState>): KernelConfig {
  return { ...config, seed: run.seed, schedulerParams: { ...config.schedulerParams, quantum: PACE_TABLE[run.policy.pace].quantum } };
}

function skippedOutcome(leg: Leg): LegOutcome {
  return { survived: true, objectivesMet: [], casualties: [], resourceDelta: {}, codexUnlocked: [], debrief: {
    headline: 'Leg unavailable', whatHappened: 'The leg could not be started.', whyItHappened: 'The leg module failed during entry.', counterfactual: null,
    chapter: leg.chapters[0] ?? { chapter: 1, sections: [], title: '' },
  } };
}

/** Owns boundaries and persistence; the director owns each tick and modal model. */
export class LegRunner {
  private activeKernel: ReplayKernel | null = null;
  private activeDirector: RunDirector | null = null;
  private leg: Leg | null = null;
  private sandbox: LegSandbox | null = null;
  private stage: LegStage | null = null;
  private options: LegRunOptions | null = null;
  private completedOutcome: LegOutcome | null = null;
  private entry: ReplayEntry | null = null;
  private record: ReplayRecord;
  private readonly kernelListeners = new Set<(kernel: ReplayKernel | null) => void>();
  private readonly crossingDefs = new Map<LegId, readonly CrossingDef[]>();
  private readonly interactionDefs = new Map<LegId, Map<string, { readonly handler: InteractionHandler; readonly target: ConvoyMemberId | null }>>();
  private recruitState: RecruitPassive[] = [];
  private pendingCheckpoint: number | null = null;
  private checkpoint: Checkpoint | null = null;
  private entering = false;
  private lastTicks = 0;

  constructor(private readonly deps: LegRunnerDeps) {
    this.record = startReplayRecord(deps.runStore.get(), deps.buildId);
    for (const member of deps.runStore.get().convoy) if (member.name.endsWith('-2')) this.trackRecruit(member.id);
  }

  get kernel(): ReplayKernel | null { return this.activeKernel; }
  get director(): RunDirector | null { return this.activeDirector; }
  get currentLeg(): Leg | null { return this.leg; }
  get phase(): LegPhase { return this.entering ? 'entering' : this.completedOutcome !== null ? 'complete' : this.activeDirector?.phase ?? 'complete'; }
  get ticksElapsed(): number { return this.activeKernel?.tick ?? this.lastTicks; }
  get finished(): boolean { return this.completedOutcome !== null || this.activeDirector?.complete === true; }
  get recruits(): readonly RecruitPassive[] { return this.recruitState; }
  get replayRecord(): ReplayRecord { return this.record; }
  get replayEntry(): ReplayEntry | null { return this.entry; }

  onKernelChanged(listener: (kernel: ReplayKernel | null) => void): () => void {
    this.kernelListeners.add(listener); listener(this.activeKernel);
    return () => { this.kernelListeners.delete(listener); };
  }

  private installKernel(kernel: ReplayKernel | null): void {
    this.activeKernel = kernel;
    for (const listener of this.kernelListeners) listener(kernel);
  }

  private trackRecruit(member: ConvoyMemberId): void {
    if (this.recruitState.some((entry) => entry.member === member)) return;
    const codec = this.deps.runStore.get().convoy.find((candidate) => candidate.id === member)?.role === 'codec';
    this.recruitState.push({ member, passiveMultiplier: codec ? 0 : 0.6, restoresCodecPassive: false });
  }

  private makeDirector(kernel: ReplayKernel, leg: Leg, bindings: ConvoyBindings, sandbox: LegSandbox, maxTicks: number): RunDirector {
    const director = new RunDirector({
      leg, kernel, store: this.deps.runStore, streams: this.deps.streams, bindings, sandbox,
      epitaphs: this.deps.epitaphs, maxTicks, onCredit: emergencyCreditNeeded(this.deps.runStore.get().resources, leg.id),
      callbacks: {
        onLegEvent: this.deps.onLegEvent, onDerezz: this.deps.onDerezz, onRunnerFailure: this.deps.onRunnerFailure, codexSignal: this.deps.codexSignal,
        hasRecruited: () => this.recruitState.length > 0,
        recruit: (member) => this.trackRecruit(member),
        checkpoint: () => { this.pendingCheckpoint = leg.index + 1; },
      },
    });
    director.registerCrossings(this.crossingDefs.get(leg.id) ?? []);
    for (const [id, registered] of this.interactionDefs.get(leg.id) ?? []) director.registerInteraction(id, registered.handler, registered.target);
    return director;
  }

  /** `configure` runs once the director exists and before the first tick, so a caller registers crossings and interactions there (WP-21 section 3). */
  enter(leg: Leg, opts: LegRunOptions, configure?: (runner: LegRunner, leg: Leg) => void): void {
    if (!Number.isSafeInteger(opts.maxTicks) || opts.maxTicks < 0) throw new RangeError('maxTicks must be a non-negative integer.');
    this.activeDirector?.dispose(); this.stage?.dispose(); this.stage = null;
    this.activeDirector = null; this.installKernel(null);
    this.leg = leg; this.options = opts; this.completedOutcome = null; this.entering = true; this.lastTicks = 0;
    const before = saveRunStreams(this.deps.streams);
    const draft = prepareLegEntry(this.deps.runStore.get(), leg);
    const sandbox = new LegSandbox(leg, this.deps.onFailure); this.sandbox = sandbox;
    const base = sandbox.kernelConfig(draft);
    if (base === null) { this.skip(leg, 'kernelConfig failed'); return; }
    const kernel = this.deps.createKernel(configured(base, draft), { ...REPLAY_KERNEL_OPTIONS, devBuild: true, checkInvariants: true });
    const bindings: ConvoyBindings = new Map();
    if (!populateHeadless(leg.id, (ctx) => sandbox.populate(ctx), kernel, draft, this.deps.streams.leg.fork(leg.id), bindings, paceSpawnTransform(draft.policy.pace))) {
      restoreRunStreams(this.deps.streams, before); this.skip(leg, 'populate failed'); return;
    }
    for (const member of draft.convoy) member.pid = member.status === 'derezzed' ? null : bindings.get(member.id) ?? null;
    this.deps.runStore.mutate((run) => Object.assign(run, draft));
    livePolicyBinding.apply(kernel, this.deps.runStore.get().policy);
    this.installKernel(kernel);
    this.activeDirector = this.makeDirector(kernel, leg, bindings, sandbox, opts.maxTicks);
    this.entry = { run: structuredClone(draft), rngStates: before };
    this.record = recordLegEntry(this.record, before);
    this.installHeadless(leg, this.activeDirector);
    if (opts.stageContext !== null) this.stage = sandbox.createStage(opts.stageContext);
    this.entering = false;
    if (this.pendingCheckpoint === leg.index) {
      const file = buildSaveFile(this.saveInput(null));
      this.checkpoint = { legIndex: leg.index, file, director: this.activeDirector.snapshot(), recruits: structuredClone(this.recruitState), replayRecord: structuredClone(this.record) };
      this.pendingCheckpoint = null;
    }
    this.deps.persist(this.saveInput(null), 'boundary');
    configure?.(this, leg);
  }

  /** The companion's crossings and interactions, and nothing else: its epitaphs and codex entries are the host's to register (WP-21 sections 5 and 8). */
  applyContent(content: LegContent): void {
    this.registerCrossings(content.crossings);
    for (const [id, entry] of Object.entries(content.interactions)) this.registerInteraction(id, entry.run, entry.target);
  }

  private skip(leg: Leg, reason: string): void {
    this.entering = false; this.completedOutcome = skippedOutcome(leg);
    this.deps.runStore.mutate((run) => { run.legIndex = leg.index + 1; run.legProgress = 1; if (run.legIndex >= LEG_ORDER.length) run.status = 'complete'; });
    this.deps.onLegEvent({ kind: 'leg_unavailable', legId: leg.id, index: leg.index, reason });
    this.deps.persist(this.saveInput(null), 'boundary');
  }

  preTick(at: Tick): void { this.activeDirector?.preTick(at); }
  postTick(at: Tick, events: readonly KernelEvent[]): void { this.activeDirector?.postTick(at, events); }
  observeCommands(outcomes: readonly CommandOutcome[]): void { this.activeDirector?.observeCommands(outcomes); }
  routeEvents(events: readonly KernelEvent[], at: Tick): void { this.deps.onEvent(events, at); }
  variableUpdate(dtSeconds: number, alpha: number): void { this.stage?.update(dtSeconds, alpha); }

  registerCrossings(defs: readonly CrossingDef[]): void {
    for (const id of LEG_ORDER) {
      const matched = defs.filter((def) => def.legId === id);
      if (matched.length > 0) this.crossingDefs.set(id, matched);
    }
    if (this.leg !== null) this.activeDirector?.registerCrossings(this.crossingDefs.get(this.leg.id) ?? []);
  }
  openCrossing(def: CrossingDef): CrossingContext { return this.requireDirector().openCrossing(def); }
  resolveCrossing(def: CrossingDef, option: CrossingOption): CrossingResult { return this.requireDirector().resolveCrossing(def, option); }
  openDepot(): Depot { return this.requireDirector().openDepot(); }
  openReclamation(): VergeLayout { return this.requireDirector().openReclamation(); }
  submitReclamation(trace: ReclamationTrace): ReclamationResult { return this.requireDirector().submitReclamation(trace); }
  continueTravel(): void { this.requireDirector().continueTravel(); }
  registerInteraction(id: string, handler: InteractionHandler, target: ConvoyMemberId | null = null): void {
    if (this.leg === null) throw new Error('An interaction registration requires a current leg.');
    let registered = this.interactionDefs.get(this.leg.id);
    if (registered === undefined) { registered = new Map(); this.interactionDefs.set(this.leg.id, registered); }
    registered.set(id, { handler, target }); this.requireDirector().registerInteraction(id, handler, target);
  }

  private requireDirector(): RunDirector {
    if (this.activeDirector === null) throw new Error('No active leg director.');
    return this.activeDirector;
  }

  private saveInput(kernel: SaveFileInput['kernel']): SaveFileInput {
    return { run: cloneRunState(this.deps.runStore.get()), kernel, rngStates: saveRunStreams(this.deps.streams), savedAtIso: this.deps.savedAtIso() };
  }

  saveProvisional(): SaveFile {
    const input = this.saveInput(this.activeKernel?.snapshot() ?? null);
    this.deps.persist(input, 'provisional');
    return buildSaveFile(input);
  }

  private effectiveOutcome(leg: Leg, outcome: LegOutcome, run: Readonly<RunState>, throughput: number, credit: boolean): { outcome: LegOutcome; dividend: number; factor: number } {
    const target = this.deps.throughputTarget(leg, run);
    if (!Number.isFinite(target) || target <= 0) throw new RangeError(`A positive throughput target is required for ${leg.id}.`);
    const factor = Math.max(0.6, Math.min(1.4, throughput / target));
    const rolledBack = run.decisions.some((record) => record.legId === leg.id && record.kind === 'checkpoint_rollback');
    const dividend = leg.index === 0 || rolledBack ? 0 : legDividend(leg.index, factor, run.discClass) * (credit ? 0.75 : 1);
    const ledger = { ...run.resources }; applyDelta(ledger, outcome.resourceDelta); applyDelta(ledger, { cycles: dividend });
    return { factor, dividend, outcome: {
      ...outcome,
      survived: run.convoy.some((member) => member.status !== 'derezzed' && !outcome.casualties.includes(member.id)),
      resourceDelta: { cycles: ledger.cycles - run.resources.cycles, quota: ledger.quota - run.resources.quota, blocks: ledger.blocks - run.resources.blocks, bandwidth: ledger.bandwidth - run.resources.bandwidth },
    } };
  }

  exit(): LegOutcome {
    if (this.completedOutcome !== null) return this.completedOutcome;
    const leg = this.leg; const kernel = this.activeKernel; const sandbox = this.sandbox; const director = this.activeDirector;
    if (leg === null || kernel === null || sandbox === null || director === null) throw new Error('No leg to exit.');
    if (director.failed && this.rollbackCheckpoint()) return skippedOutcome(leg);
    // A zero-segment leg's end is in its log, so a replay or a resume ends it at the same tick (WP-L00 ruling 1).
    if (director.travel.segmentsTotal === 0 && !legDone(this.deps.runStore.get(), leg.id)) {
      this.deps.runStore.mutate((run) => { run.decisions.push({ tick: kernel.tick, legId: leg.id, kind: LEG_DONE_KIND, choice: 'exit', outcome: 'pending', relatedObjective: null }); });
    }
    const before = cloneRunState(this.deps.runStore.get());
    const snapshot = kernel.snapshot();
    const decisionsBefore = before.decisions.length;
    const raw = sandbox.evaluate({ run: before, kernelSnapshot: snapshot, events: director.allEvents, ticksElapsed: kernel.tick });
    this.copyEvaluateDecisions(before.decisions.slice(decisionsBefore), this.deps.runStore);
    const resolved = this.effectiveOutcome(leg, raw, before, snapshot.metrics.scheduling.throughput, director.travel.onCredit);
    const pending = this.counterfactual(leg, kernel, director, before);
    const view = buildDebrief({ outcome: raw, run: before, legTicks: kernel.tick, throughputFactor: resolved.factor, dividend: resolved.dividend,
      counterfactual: pending.then((result) => result?.text ?? null), codexCounterfactual: pending.then((result) => result?.codex ?? null) });
    // A replacement reuses the member id but has no binding until the next leg.
    // Historical exits must never derezz that replacement a second time.
    const currentBindings: ConvoyBindings = new Map([...director.bindings].filter(([id, pid]) => before.convoy.some((member) => member.id === id && member.pid === pid && member.status !== 'derezzed')));
    noteExits(this.deps.runStore, currentBindings, director.allEvents);
    applyLegOutcome(this.deps.runStore, resolved.outcome, leg.index);
    director.finishAfflictionClock();
    this.deps.runStore.mutate((run) => { run.score = scoreFromRun(run, { workloadCompletions: before.score.throughput / SCORE_WEIGHTS.perCompletion, privilegeExcess: 0 }); });
    this.record = recordLegHash(this.record, hashEventLog(director.allEvents), this.deps.runStore.get().decisions);
    this.completedOutcome = resolved.outcome;
    this.lastTicks = kernel.tick;
    this.stage?.dispose(); this.stage = null;
    director.dispose();
    this.deps.codexSignal({ kind: 'leg_complete', leg: leg.id });
    this.deps.onLegEvent({ kind: 'debrief', view });
    if (this.checkpoint?.legIndex === leg.index) this.checkpoint = null;
    this.deps.persist(this.saveInput(null), 'boundary');
    this.installKernel(null);
    return resolved.outcome;
  }

  /**
   * WP-L04 ruling 5: a hand-off record a leg appends to `ctx.run.decisions`
   * inside `evaluate` reaches the run. `evaluate` is handed a copy on the live
   * path, so the copy is where the record lands and it would otherwise be
   * dropped; on the headless path `ctx.run` is the store's own root, and the
   * identity check below is what keeps that case from recording it twice.
   */
  private copyEvaluateDecisions(appended: readonly DecisionRecord[], store: Store<RunState>): void {
    if (appended.length === 0 || store.get().decisions === appended) return;
    store.mutate((run) => {
      for (const record of appended) run.decisions.push({ ...record });
    });
  }

  private async counterfactual(leg: Leg, kernel: ReplayKernel, director: RunDirector, run: RunState): Promise<{ readonly text: string; readonly codex: CodexCounterfactual } | null> {
    if (this.deps.replay === null || this.entry === null) return null;
    const observed = observeLeg(kernel.snapshot(), director.allEvents, director.bindings, run.tombstones.slice(this.entry.run.tombstones.length).filter(stone => stone.legId === leg.id));
    const plans = planCounterfactuals({ legId: leg.id, seed: run.seed, discClass: run.discClass, difficulty: run.difficulty, decisions: run.decisions, observed, kernel, policy: run.policy, maxTicks: this.options?.maxTicks ?? kernel.tick, entry: this.entry });
    for (const plan of plans.slice(0, 2)) {
      try {
        const alternative = await this.deps.replay.run(plan.request, 1500);
        if (!alternative.ok) continue;
        const text = phraseCounterfactual({ baseline: observed, alternative, request: plan.request, floor: plan.floor });
        return { text, codex: toCodexCounterfactual(alternative, plan.label, Math.max(0, run.decisions.length - 1), run.seed, text) };
      } catch { /* A failed optional counterfactual never prevents the boundary. */ }
    }
    return null;
  }

  private installHeadless(leg: Leg, director: RunDirector): void {
    registerHeadlessLeg(leg.id, (): HeadlessLeg => {
      const sandbox = new LegSandbox(leg, () => undefined);
      let replayDirector: RunDirector | null = null;
      let replayStore: Store<RunState> | null = null;
      const directorHooks = director.hooks((created) => { replayDirector = created; });
      const hooks: ReplayHooks = {
        ...directorHooks,
        enter: (streams, store) => {
          replayStore = store;
          store.mutate((run) => Object.assign(run, prepareLegEntry(run, leg)));
          directorHooks.enter?.(streams, store);
        },
      };
      return {
        id: leg.id, index: leg.index, eventTable: leg.eventTable,
        kernelConfig: (run) => {
          const prepared = prepareLegEntry(run, leg); const config = sandbox.kernelConfig(prepared);
          if (config === null) throw new Error(`Headless leg unavailable: ${leg.id}`);
          return configured(config, prepared);
        },
        populate: (ctx) => {
          if (!sandbox.populate({ ...ctx, run: prepareLegEntry(ctx.run, leg) })) throw new Error(`Headless populate failed: ${leg.id}`);
        },
        evaluate: (ctx) => {
          const decisionsBefore = ctx.run.decisions.length;
          const evaluated = sandbox.evaluate(ctx);
          const appended = ctx.run.decisions.slice(decisionsBefore);
          // Only when evaluate was handed a copy; in replay `ctx.run` is the store's root and the push already landed.
          if (replayStore !== null && replayStore.get() !== ctx.run) this.copyEvaluateDecisions(appended, replayStore);
          const outcome = this.effectiveOutcome(leg, evaluated, ctx.run, ctx.kernelSnapshot.metrics.scheduling.throughput, replayDirector?.travel.onCredit ?? false).outcome;
          // Replay applies the outcome after this callback. Project it on a copy
          // so the following leg sees the same boundary score without applying
          // resource deltas or awards to the actual store twice (V13).
          const projected = createRunStore(cloneRunState(ctx.run));
          applyLegOutcome(projected, outcome, leg.index);
          const completions = replayDirector?.snapshot().completions ?? ctx.run.score.throughput / SCORE_WEIGHTS.perCompletion;
          const score = scoreFromRun(projected.get(), { workloadCompletions: completions, privilegeExcess: 0 });
          replayStore?.mutate((run) => { run.score = score; });
          replayDirector?.finishAfflictionClock();
          return outcome;
        },
        hooks,
      };
    });
  }

  rollbackCheckpoint(): boolean {
    const checkpoint = this.checkpoint; const leg = this.leg; const options = this.options;
    if (checkpoint === null || leg === null || options === null || checkpoint.legIndex !== leg.index || this.activeDirector?.failed !== true) return false;
    const sandbox = new LegSandbox(leg, this.deps.onFailure); const bindings: ConvoyBindings = new Map();
    restoreRunStreams(this.deps.streams, checkpoint.file.rngStates);
    const resumed = resumeRun(checkpoint.file, {
      buildKernel: (run) => {
        const config = sandbox.kernelConfig(run); if (config === null) throw new Error('Checkpoint configuration failed.');
        return this.deps.createKernel(configured(config, run), { ...REPLAY_KERNEL_OPTIONS, devBuild: true, checkInvariants: true });
      },
      populate: (kernel, run) => {
        if (!populateHeadless(leg.id, (ctx) => sandbox.populate(ctx), kernel, run, this.deps.streams.leg.fork(leg.id), bindings, paceSpawnTransform(run.policy.pace))) throw new Error('Checkpoint populate failed.');
        for (const member of run.convoy) member.pid = member.status === 'derezzed' ? null : bindings.get(member.id) ?? null;
      },
    });
    if (resumed.kind !== 'ok') { this.deps.onRunnerFailure(resumed.message, leg, this.activeKernel?.tick ?? asTick(0)); return false; }
    restoreRunStreams(this.deps.streams, checkpoint.file.rngStates);
    this.activeDirector?.dispose(); this.stage?.dispose(); this.stage = null;
    this.recruitState = structuredClone([...checkpoint.recruits]); this.record = structuredClone(checkpoint.replayRecord); this.checkpoint = null;
    this.deps.runStore.mutate((run) => {
      Object.assign(run, resumed.run);
      run.decisions.push({ kind: 'checkpoint_rollback', choice: leg.id, legId: leg.id, tick: asTick(0), outcome: 'costly', relatedObjective: null });
      run.score = scoreFromRun(run, { workloadCompletions: run.score.throughput / SCORE_WEIGHTS.perCompletion, privilegeExcess: 0 });
    });
    livePolicyBinding.apply(resumed.kernel, this.deps.runStore.get().policy);
    this.sandbox = sandbox; this.installKernel(resumed.kernel);
    this.activeDirector = this.makeDirector(resumed.kernel, leg, bindings, sandbox, options.maxTicks);
    this.activeDirector.restore(checkpoint.director);
    this.completedOutcome = null;
    if (options.stageContext !== null) this.stage = sandbox.createStage(options.stageContext);
    return true;
  }

  /**
   * Reconstruct owned side state from the deterministic action history. The boot
   * caller supplies all authored legs through the saved boundary and registers
   * their interactions/crossings before their recorded actions are dispatched.
   */
  resume(file: SaveFile, legs: readonly Leg[], opts: LegRunOptions, configure?: (runner: LegRunner, leg: Leg) => void): boolean {
    const targetIndex = file.run.legIndex;
    const ordered = [...legs].sort((a, b) => a.index - b.index || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const target = ordered.find((leg) => leg.index === targetIndex);
    if (target === undefined && targetIndex < LEG_ORDER.length) throw new Error('Resume requires the saved leg and every earlier authored leg.');
    for (let index = 0; index < targetIndex; index++) if (!ordered.some((leg) => leg.index === index)) throw new Error(`Resume is missing leg ${index}.`);
    const replayStore = createRunStore(initialRunState(file.run.seed, file.run.discClass, file.run.difficulty));
    const streams = createRunStreams(file.run.seed);
    let reconstruction: LegRunner | null = null;
    const currentKernel = (): ReplayKernel => { const kernel = reconstruction?.kernel; if (kernel === null || kernel === undefined) throw new Error('Resume has no active reconstruction kernel.'); return kernel; };
    const bus = new CommandBus({
      store: replayStore,
      kernel: {
        setScheduler: (id, params) => currentKernel().setScheduler(id, params),
        setReplacementPolicy: (id) => currentKernel().setReplacementPolicy(id),
        setDiskPolicy: (id) => currentKernel().setDiskPolicy(id),
        setAllocationStrategy: (strategy) => currentKernel().setAllocationStrategy(strategy),
        setDeadlockStrategy: (strategy) => currentKernel().setDeadlockStrategy(strategy),
        syscall: (request) => currentKernel().syscall(request),
      },
      handlers: {
        useAbility: (member, abilityTarget, at) => reconstruction?.director?.useAbility(member, abilityTarget, at),
        interaction: (id, anchor, at) => { reconstruction?.director?.interaction(id, anchor, at); },
        terminal: (line, at) => reconstruction?.director?.terminal(line, at),
      },
      admit: (cmd, origin, at) => reconstruction?.director?.admit(cmd, origin, at) ?? { ok: false, reason: 'Resume has no active director.' },
    });
    const scratch = new LegRunner({ ...this.deps, runStore: replayStore, commandBus: bus, streams, replay: null,
      persist: () => undefined, onEvent: () => undefined, onLegEvent: () => undefined, codexSignal: () => undefined, onDerezz: () => undefined });
    reconstruction = scratch;
    for (const defs of this.crossingDefs.values()) scratch.registerCrossings(defs);
    for (const [id, definitions] of this.interactionDefs) scratch.interactionDefs.set(id, new Map(definitions));
    try {
      for (const leg of ordered.filter((candidate) => candidate.index < targetIndex || (file.kernel !== null && candidate.index === targetIndex))) {
        scratch.enter(leg, { ...opts, stageContext: null }); configure?.(scratch, leg);
        const actions = file.run.decisions.filter((record) => record.legId === leg.id);
        let next = 0;
        const stopAt = leg.index === targetIndex && file.kernel !== null ? file.kernel.tick : null;
        while (scratch.kernel !== null && scratch.director !== null) {
          const kernel = scratch.kernel; const director = scratch.director;
          const outcomes: CommandOutcome[] = [];
          while (next < actions.length) {
            const record = actions[next];
            if (record === undefined || record.tick > kernel.tick) break;
            if (record.tick < kernel.tick) throw new Error(`Resume action order missed tick ${record.tick}.`);
            const command = commandFromRecord(record);
            if (command === null) {
              if (director.dispatch(record)) {
                if (record.kind === 'checkpoint_rollback') { scratch.checkpoint = null; scratch.pendingCheckpoint = null; }
              } else if (DIRECTOR_OWNED_KINDS.has(record.kind) || Object.hasOwn(BUS_KINDS, record.kind)) {
                throw new Error(`Resume cannot dispatch ${record.kind}.`);
              } else {
                // Neither the bus nor the director owns the kind: leg data such as a hand-off record rides through verbatim (WP-20 W9).
                replayStore.mutate((run) => { run.decisions.push({ ...record }); });
              }
            } else outcomes.push(bus.apply(command, originFromRecord(record), kernel.tick));
            next++;
          }
          director.observeCommands(outcomes);
          if (stopAt !== null && kernel.tick >= stopAt) break;
          if (director.complete) break;
          director.preTick(kernel.tick);
          const events = kernel.step(); director.postTick(kernel.tick, events);
          if (kernel.tick > opts.maxTicks) throw new Error('Resume exceeded maxTicks.');
        }
        if (stopAt !== null) {
          if (scratch.kernel?.tick !== stopAt) throw new Error('Resume could not reproduce the saved tick.');
          break;
        }
        scratch.exit();
      }
      this.activeDirector?.dispose(); this.stage?.dispose(); this.stage = null;
      this.recruitState = structuredClone(scratch.recruitState);
      this.pendingCheckpoint = scratch.pendingCheckpoint;
      this.checkpoint = scratch.checkpoint;
      this.record = structuredClone(scratch.record);
      this.deps.runStore.mutate((run) => Object.assign(run, structuredClone(file.run)));
      restoreRunStreams(this.deps.streams, file.rngStates);
      if (target === undefined) {
        this.activeDirector = null; this.installKernel(null); this.completedOutcome = scratch.completedOutcome;
        return true;
      }
      if (file.kernel === null) { this.enter(target, opts); configure?.(this, target); return true; }
      const snapshot = scratch.director?.snapshot(); const entry = scratch.entry;
      if (snapshot === undefined || entry === null) throw new Error('Resume has no reconstructed director state.');
      const sandbox = new LegSandbox(target, this.deps.onFailure); const bindings: ConvoyBindings = new Map();
      restoreRunStreams(this.deps.streams, entry.rngStates);
      const resumed = resumeRun(file, {
        buildKernel: (run) => {
          const config = file.kernel?.config ?? sandbox.kernelConfig(run); if (config === null) throw new Error('Resume configuration failed.');
          return this.deps.createKernel(config, { ...REPLAY_KERNEL_OPTIONS, devBuild: true, checkInvariants: true });
        },
        populate: (kernel) => {
          const run = structuredClone(entry.run);
          if (!populateHeadless(target.id, (ctx) => sandbox.populate(ctx), kernel, run, this.deps.streams.leg.fork(target.id), bindings, paceSpawnTransform(run.policy.pace))) throw new Error('Resume populate failed.');
        },
      });
      if (resumed.kind !== 'ok') throw new Error(resumed.message);
      restoreRunStreams(this.deps.streams, file.rngStates);
      this.leg = target; this.options = opts; this.sandbox = sandbox; this.completedOutcome = null; this.entry = entry;
      this.installKernel(resumed.kernel);
      this.activeDirector = this.makeDirector(resumed.kernel, target, bindings, sandbox, opts.maxTicks);
      this.activeDirector.restore(snapshot);
      this.installHeadless(target, this.activeDirector); configure?.(this, target);
      if (opts.stageContext !== null) this.stage = sandbox.createStage(opts.stageContext);
      return true;
    } catch (error) {
      if (target !== undefined) this.deps.onRunnerFailure(error instanceof Error ? error.message : String(error), target, file.kernel?.tick ?? asTick(0));
      return false;
    } finally { scratch.activeDirector?.dispose(); scratch.stage?.dispose(); }
  }
}

import { asPid, asTick, type ConvoyMemberId, type KernelEvent, type TerminationReason, type Tick } from '@kernel/index';
import type { Command, CommandOrigin, CommandOutcome } from './CommandBus';
import type { CodexUnlock } from './codexTypes';
import type { LegEvent, LegPhase } from './LegRunner';
import { LegSandbox } from './LegSandbox';
import type { AfflictionId, AfflictionRemedy, DecisionRecord, InteractionDef, Leg, ResourceLedger, RunState, TravelPolicy } from './types';
import type { Store } from './store';
import type { ConvoyBindings } from './replay/headlessLegs';
import type { ReplayHooks, ReplayKernel, RunStreams } from './replay/types';
import { scoreFromRun, SCORE_WEIGHTS } from './scoring';
import { acquire, isCuredBy, tickAfflictions } from './afflictions/AfflictionClock';
import { derezz, derezzMember, type EpitaphCopySource } from './convoy/derezz';
import { aliveMembers, applyIntegrity, lowestIntegrityAlive, PER_LEG_ABILITY_CHARGES } from './convoy/status';
import { apply as applyEvent, draw } from './events/EventDeck';
import { TIER_TABLE, afflictionFrequency } from './tiers';
import { RATIONS_TABLE } from './travel/paceRations';
import { advance, createTravelState, drawsDue, legProgress, remainingTravelCharge, type TravelState } from './travel/TravelLoop';
import { applyDelta, canAfford, emergencyCreditNeeded } from './travel/ledger';
import { DEPOT_LEGS } from './travel/segments';
import { livePolicyBinding } from './travel/policyBinding';
import { CrossingRunner, type CrossingDef, type CrossingResult } from './crossing/Crossing';
import type { CrossingContext, CrossingOption } from './crossing/options';
import { Depot, type DepotItemId, type DepotSnapshot } from './depot/Depot';
import { DEPOT_ITEMS } from './depot/prices';
import { Reclamation, type ReclamationResult, type ReclamationSnapshot, type ReclamationTrace } from './reclamation/Reclamation';
import type { VergeLayout } from './reclamation/verge';

import { TERMINATION_FOR_AFFLICTION, drainDeathReason } from './afflictions/table';
export interface DirectorCallbacks {
  readonly onLegEvent?: (event: LegEvent) => void;
  readonly onDerezz?: (phase: 'begin' | 'tombstone') => void;
  readonly onRunnerFailure?: (message: string, leg: Leg, at: Tick) => void;
  readonly codexSignal?: (signal: Extract<CodexUnlock, { kind: 'crossing' | 'leg_complete' }>) => void;
  readonly hasRecruited?: () => boolean;
  readonly recruit?: (member: ConvoyMemberId) => void;
  readonly checkpoint?: () => void;
}
export interface RunDirectorDeps {
  readonly leg: Leg;
  readonly kernel: ReplayKernel;
  readonly store: Store<RunState>;
  readonly streams: RunStreams;
  readonly bindings: ConvoyBindings;
  readonly sandbox: LegSandbox;
  readonly epitaphs: EpitaphCopySource;
  readonly maxTicks: number;
  readonly onCredit?: boolean;
  readonly replay?: boolean;
  readonly callbacks?: DirectorCallbacks;
}
export interface DirectorSnapshot {
  readonly travel: TravelState;
  readonly phase: LegPhase;
  readonly events: readonly KernelEvent[];
  readonly processed: readonly number[];
  readonly completions: number;
  readonly pendingDeaths: readonly { readonly member: ConvoyMemberId; readonly reason: TerminationReason }[];
  readonly inverted: readonly ConvoyMemberId[];
  readonly reclamationRuns: number;
  readonly reclamation: ReclamationSnapshot | null;
  readonly depot: DepotSnapshot | null;
  readonly recruited: boolean;
  readonly capped: boolean;
  readonly clockRebased: boolean;
  readonly previousPolicy: TravelPolicy;
  readonly previousQuantum: number;
}
/**
 * WP-L04 ruling 2: the kernel is the third argument. A leg's interaction is a
 * player verb that changes how the simulation runs, and every such verb needs
 * a kernel write it cannot reach through `RunState` alone. Additive, so a
 * handler that ignores it is unchanged, and the replay director re-registers
 * the same handlers against its own kernel, which is what keeps it
 * deterministic.
 */
export type InteractionHandler = (run: RunState, at: Tick, kernel: ReplayKernel) => void;
/** The record kinds `dispatch` replays; a non-command record of any other kind is leg data and rides through resume verbatim (WP-20 W9). */
export const DIRECTOR_OWNED_KINDS: ReadonlySet<string> = new Set([
  'travel_resume', 'depot_open', 'crossing_open', 'crossing', 'depot', 'reclamation_open', 'reclamation', 'interaction', 'checkpoint_rollback', 'use_ability', 'terminal',
]);
const POLICY = new Set<Command['kind']>(['set_scheduler', 'set_replacement', 'set_disk_policy', 'set_allocation', 'set_deadlock_strategy', 'set_pace', 'set_rations', 'set_degree']);
const MEMBERS: readonly ConvoyMemberId[] = ['kestrel', 'lumen', 'orrery', 'sable', 'vesper'];

/** Owns game ticks; all run writes stay inside the injected store's mutation seam. */
export class RunDirector {
  readonly travel: TravelState;
  private currentPhase: LegPhase = 'travelling';
  private readonly events: KernelEvent[] = [];
  private readonly captured = new Set<number>();
  private readonly processed = new Set<number>();
  private readonly deaths = new Map<ConvoyMemberId, TerminationReason>();
  /** Members already told about the inversion they are in, so one episode inflicts once (WP-L04 ruling 4). */
  private readonly inverted = new Set<ConvoyMemberId>();
  private readonly crossings = new Map<string, CrossingDef>();
  private readonly interactions = new Map<string, { handler: InteractionHandler; target: ConvoyMemberId | null }>();
  private readonly pendingCommands: Command[] = [];
  private previousPolicy: TravelPolicy;
  private previousQuantum: number;
  private completions = 0;
  private capped = false;
  private clockRebased = false;
  private recruited = false;
  private replayingAction = false;
  private reclamationRuns = 0;
  private depot: Depot | null = null;
  private reclamation: Reclamation | null = null;
  private readonly unsubscribe: () => void;
  private readonly syncEnabled: boolean;

  constructor(private readonly deps: RunDirectorDeps) {
    this.travel = createTravelState(deps.leg.id, deps.onCredit ?? false);
    this.previousPolicy = { ...deps.store.get().policy };
    this.recruited = deps.store.get().convoy.some(member => member.name.endsWith('-2'));
    this.completions = deps.store.get().score.throughput / SCORE_WEIGHTS.perCompletion;
    this.previousQuantum = deps.kernel.invariantState().schedulerParams.quantum;
    this.syncEnabled = deps.kernel.config.enabledSubsystems.includes('sync');
    this.unsubscribe = deps.kernel.events.onAny(event => {
      if (this.captured.has(event.seq)) return;
      this.captured.add(event.seq); this.events.push(event);
    });
  }
  get phase(): LegPhase { return this.currentPhase; }
  get allEvents(): readonly KernelEvent[] { return this.events; }
  get ticksElapsed(): number { return this.deps.kernel.tick; }
  get bindings(): ConvoyBindings { return this.deps.bindings; }
  get failed(): boolean { return aliveMembers(this.deps.store.get().convoy).length === 0; }
  get tickLimitReached(): boolean { return this.capped; }
  get complete(): boolean { return this.capped || this.failed || legProgress(this.travel) >= 1; }
  dispose(): void { this.unsubscribe(); }

  /** Called before the bus mutates, including synchronous terminal writes. */
  admit(cmd: Command, origin: CommandOrigin, _at: Tick): { ok: true } | { ok: false; reason: string } {
    const refusal = this.checkAdmission(cmd, origin, this.deps.store.get());
    if (refusal !== null) return { ok: false, reason: refusal };
    const cost = this.commandCost(cmd, origin, this.deps.store.get());
    this.deps.store.mutate(run => applyDelta(run.resources, { cycles: -(cost.cycles ?? 0), bandwidth: -(cost.bandwidth ?? 0) }));
    this.pendingCommands.push(cmd);
    return { ok: true };
  }
  private commandCost(cmd: Command, origin: CommandOrigin, run: Readonly<RunState>): Partial<ResourceLedger> {
    const tier = TIER_TABLE[run.difficulty];
    return { cycles: POLICY.has(cmd.kind) ? tier.policyChangeCost : 0,
      bandwidth: origin.source === 'terminal' && cmd.kind !== 'terminal' ? tier.terminalCommandCost : 0 };
  }
  private checkAdmission(cmd: Command, origin: CommandOrigin, run: Readonly<RunState>, reserved: Partial<ResourceLedger> = {}, onCredit = this.travel.onCredit): string | null {
    if (cmd.kind === 'set_rations' && run.resources.quota <= 0 && cmd.to !== 'starved') return 'Reclaim quota before raising rations.';
    if (cmd.kind === 'set_pace' && onCredit && cmd.to !== 'conservative') return 'Emergency preemption credit requires conservative pace.';
    if (cmd.kind === 'set_degree' && !Number.isFinite(cmd.to)) return 'Degree must be finite.';
    const cost = this.commandCost(cmd, origin, run);
    if (run.resources.cycles - (reserved.cycles ?? 0) < (cost.cycles ?? 0) || run.resources.bandwidth - (reserved.bandwidth ?? 0) < (cost.bandwidth ?? 0)) return 'Insufficient resources for this command.';
    if (cmd.kind === 'interaction') {
      const def = this.deps.leg.interactions.find(item => item.id === cmd.id);
      if (def === undefined || !this.interactions.has(cmd.id) || !this.deps.sandbox.predicate(def, run)) return 'This interaction is unavailable.';
      const target = this.interactions.get(cmd.id)?.target ?? null;
      if ((def.cost.integrity ?? 0) > 0 && target === null) return 'This interaction requires an explicit integrity target.';
      if (!this.affordableInteraction(def, target, run, cost, reserved)) return 'Insufficient resources for this interaction.';
    }
    return null;
  }
  private affordableInteraction(def: InteractionDef, target: ConvoyMemberId | null, run: Readonly<RunState>, command: Partial<ResourceLedger> = {}, reserved: Partial<ResourceLedger> = {}): boolean {
    const { integrity = 0, ...cost } = def.cost;
    const remaining = { ...run.resources, cycles: run.resources.cycles - (command.cycles ?? 0) - (reserved.cycles ?? 0), bandwidth: run.resources.bandwidth - (command.bandwidth ?? 0) - (reserved.bandwidth ?? 0) };
    return canAfford(remaining, cost) && (integrity <= 0 || (run.convoy.find(m => m.id === target && m.status !== 'derezzed')?.integrity ?? 0) >= integrity);
  }
  observeCommands(_outcomes: readonly CommandOutcome[]): void { this.applyPolicy(); }
  applyPolicy(bind = true): void {
    const current = this.deps.store.get().policy;
    const maximum = this.deps.kernel.memorySubsystem.pager.control.maximumDegree;
    const degree = Math.max(1, Math.min(maximum, Math.trunc(current.degreeOfMultiprogramming)));
    if (degree !== current.degreeOfMultiprogramming) this.deps.store.mutate(run => { run.policy.degreeOfMultiprogramming = degree; });
    const next = this.deps.store.get().policy;
    if (bind && (next.pace !== this.previousPolicy.pace || next.rations !== this.previousPolicy.rations || next.degreeOfMultiprogramming !== this.previousPolicy.degreeOfMultiprogramming)) livePolicyBinding.apply(this.deps.kernel, next);
    const quantum = this.deps.kernel.invariantState().schedulerParams.quantum;
    const remedies: AfflictionRemedy[] = [];
    if (quantum !== this.previousQuantum) remedies.push({ kind: 'adjust_quantum', direction: quantum > this.previousQuantum ? 'increase' : 'decrease' });
    if (next.degreeOfMultiprogramming < this.previousPolicy.degreeOfMultiprogramming) remedies.push({ kind: 'reduce_degree', by: this.previousPolicy.degreeOfMultiprogramming - next.degreeOfMultiprogramming });
    for (const cmd of this.pendingCommands.splice(0)) {
      if (cmd.kind === 'set_scheduler' || cmd.kind === 'set_replacement' || cmd.kind === 'set_disk_policy' || cmd.kind === 'set_allocation') remedies.push(cmd);
    }
    if (remedies.length > 0) this.deps.store.mutate(run => {
      for (const member of run.convoy) member.afflictions = member.afflictions.filter(a => !remedies.some(remedy => isCuredBy(a, remedy)));
    });
    this.previousPolicy = { ...next }; this.previousQuantum = quantum;
  }

  preTick(at: Tick, prepaid = false): void {
    if ((!prepaid && this.currentPhase !== 'travelling') || this.failed || this.capped) return;
    if (this.deps.kernel.tick >= this.deps.maxTicks) {
      this.capped = true;
      this.deps.callbacks?.onRunnerFailure?.(`Leg exceeded maxTicks (${this.deps.maxTicks}).`, this.deps.leg, at);
      return;
    }
    this.applyPolicy();
    if (!prepaid && legProgress(this.travel) >= 1) return;
    this.deps.store.mutate(run => {
      if (run.resources.quota <= 0) run.policy.rations = 'starved';
      let charge = remainingTravelCharge(this.travel, run.policy, aliveMembers(run.convoy).length);
      if (!prepaid && !this.travel.onCredit && charge.cycles > run.resources.cycles + 1e-9) {
        this.travel.onCredit = true; run.policy.pace = 'conservative';
        charge = remainingTravelCharge(this.travel, run.policy, aliveMembers(run.convoy).length);
      }
      if (!prepaid) {
        applyDelta(run.resources, { cycles: -charge.cycles, quota: -charge.quota });
        advance(this.travel, charge); run.legProgress = legProgress(this.travel);
      }
      const afflictions = tickAfflictions(run.convoy, asTick(at + 1), run.difficulty);
      for (const fatal of afflictions.fatal) this.deaths.set(fatal.member, TERMINATION_FOR_AFFLICTION[fatal.id]);
      const rations = RATIONS_TABLE[run.policy.rations];
      for (const member of [...aliveMembers(run.convoy)].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
        if (this.deaths.has(member.id)) continue;
        applyIntegrity(member, -rations.integrityCostPerTick);
        if (rations.afflictionOnRoll !== null && this.deps.streams.events.chance(afflictionFrequency(rations.afflictionChancePerTick, run.difficulty))) acquire(member, rations.afflictionOnRoll, at);
      }
      const drains = tickAfflictions(run.convoy, asTick(at + 1), run.difficulty);
      for (const member of run.convoy) applyIntegrity(member, -(drains.drained.get(member.id) ?? 0));
      if (this.travel.onCredit) {
        const member = lowestIntegrityAlive(run.convoy); if (member !== null) applyIntegrity(member, -0.3);
      }
      if (run.resources.quota <= 0) run.policy.rations = 'starved';
    });
    this.applyPolicy();
    if (!prepaid) for (let count = drawsDue(this.travel); count > 0; count--) this.drawEvent();
  }
  postTick(at: Tick, events: readonly KernelEvent[], score = true): void {
    const pending = [...this.events, ...events].filter(event => !this.processed.has(event.seq));
    for (const event of pending) {
      if (this.processed.has(event.seq)) continue;
      this.processed.add(event.seq);
      if (!this.captured.has(event.seq)) { this.captured.add(event.seq); this.events.push(event); }
      this.processEvent(event);
    }
    // WP-L04 ruling 4: the kernel detects priority inversion in phase 4 and
    // reports it on the sync subsystem rather than as an event, so nothing
    // reached the convoy. The affliction lands on the blocked Program, which is
    // the high-priority one, and it lands once for the episode rather than
    // once a tick. The early return keeps a tick that has no inversion, which
    // is nearly all of them, free of any allocation at all.
    const inversions = this.syncEnabled ? this.deps.kernel.syncSubsystem.priorities.inversions() : [];
    if (inversions.length > 0 || this.inverted.size > 0) {
      const current = new Set<ConvoyMemberId>();
      for (const inversion of inversions) {
        let blocked: ConvoyMemberId | undefined;
        for (const [member, pid] of this.deps.bindings) if (pid === inversion.blocked) { blocked = member; break; }
        if (blocked === undefined) continue;
        current.add(blocked);
        if (!this.inverted.has(blocked)) { this.inverted.add(blocked); this.inflict(blocked, 'priority_inversion', at); }
      }
      for (const member of this.inverted) if (!current.has(member)) this.inverted.delete(member);
    }
    for (const member of [...this.deps.store.get().convoy].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
      if (member.epitaph !== null) continue;
      const reason = this.deaths.get(member.id) ?? (member.integrity <= 0 ? drainDeathReason(member) : null);
      if (reason !== null) this.kill(member.id, reason, at);
    }
    this.deaths.clear();
    if (score && !this.deps.replay) this.deps.store.mutate(run => {
      run.score = scoreFromRun(run, { workloadCompletions: this.completions, privilegeExcess: 0 });
    });
  }
  private processEvent(event: KernelEvent): void {
    const member = 'pid' in event ? [...this.deps.bindings].find(([, pid]) => pid === event.pid)?.[0] : undefined;
    if (event.type === 'process.exited') {
      if (event.reason === 'normal_exit') { if (member === undefined) this.completions++; }
      else if (member !== undefined) this.deaths.set(member, event.reason);
    } else if (event.type === 'process.starving' && member !== undefined) {
      if (event.fatal) this.deaths.set(member, 'starvation'); else this.inflict(member, 'starvation', event.tick);
    } else if (event.type === 'memory.thrashing') {
      for (const living of aliveMembers(this.deps.store.get().convoy)) this.inflict(living.id, 'thrashing', event.tick);
    } else if (event.type === 'memory.allocation_failed' && member !== undefined) this.inflict(member, event.reason === 'fragmentation' ? 'fragmented' : 'memory_leak', event.tick);
    else if (event.type === 'sync.busy_wait' && member !== undefined) this.inflict(member, 'livelock', event.tick);
    else if (event.type === 'sync.blocked' && member !== undefined) this.inflict(member, 'lock_convoy', event.tick);
    else if (event.type === 'sync.race_detected') {
      for (const [id, pid] of this.deps.bindings) if (event.race.participants.includes(pid)) this.inflict(id, 'false_sharing', event.tick);
    } else if (event.type === 'fs.corruption') {
      const target = lowestIntegrityAlive(this.deps.store.get().convoy); if (target !== null) this.inflict(target.id, 'bit_rot', event.tick);
    } else if (event.type === 'kernel.panic') this.deps.callbacks?.onLegEvent?.({ kind: 'panic', message: event.message, tick: event.tick });
  }
  private inflict(id: ConvoyMemberId, affliction: AfflictionId, at: Tick): void {
    this.deps.store.mutate(run => { const member = run.convoy.find(m => m.id === id); if (member !== undefined) acquire(member, affliction, at); });
  }
  private kill(id: ConvoyMemberId, reason: TerminationReason, at: Tick): void {
    const member = this.deps.store.get().convoy.find(m => m.id === id);
    if (member === undefined || member.epitaph !== null) return;
    const epitaph = derezz({ member, reason, tick: at, legId: this.deps.leg.id }, this.deps.epitaphs, this.deps.streams.leg);
    const pid = member.pid ?? this.deps.bindings.get(id);
    this.deps.callbacks?.onDerezz?.('begin');
    this.deps.store.mutate(run => {
      const target = run.convoy.find(m => m.id === id);
      if (target !== undefined) derezzMember(target, epitaph);
      run.tombstones.push(epitaph);
      if (!run.codexUnlocked.includes(epitaph.codexEntry)) run.codexUnlocked.push(epitaph.codexEntry);
    });
    if (pid !== undefined && pid !== null) {
      const process = this.deps.kernel.process(pid);
      if (process?.state === 'new') {
        // Pending arrivals have no legal new-to-zombie transition. Pid 1's
        // kill uses killed_by_parent; the epitaph retains the pathology reason.
        const result = this.deps.kernel.syscall({ name: 'kill', pid: asPid(1), args: [pid, 9] });
        if (!result.ok) throw new Error(`Pending convoy process could not be discarded: ${result.message}`);
      } else if (process !== undefined && process.state !== 'terminated' && process.state !== 'zombie') this.deps.kernel.lifecycle.exit(process, 137, reason);
    }
    this.deps.callbacks?.onDerezz?.('tombstone');
    this.deps.callbacks?.onLegEvent?.({ kind: 'tombstone', epitaph, memberName: member.name });
  }
  private drawEvent(): string | null {
    const context = { run: this.deps.store.get(), rng: this.deps.streams.events, at: this.deps.kernel.tick, legId: this.deps.leg.id,
      predicate: (def: Parameters<LegSandbox['predicate']>[0], run: RunState) => this.deps.sandbox.predicate(def, run) };
    const def = draw(this.deps.leg.eventTable, context);
    if (def === null) return null;
    this.deps.store.mutate(run => { applyEvent(def, { ...context, run }); });
    return def.id;
  }

  registerCrossings(defs: readonly CrossingDef[]): void { for (const def of defs) { if (def.legId !== this.deps.leg.id) throw new Error('Crossing belongs to another leg.'); this.crossings.set(def.id, def); } }
  private crossingRunner(): CrossingRunner {
    return new CrossingRunner({ getRun: () => this.deps.store.get(), mutate: recipe => this.deps.store.mutate(recipe), view: () => this.deps.kernel.invariantState(), rng: this.deps.streams.crossing,
      step: () => { this.preTick(this.deps.kernel.tick, true); if (this.capped) return false; const events = this.deps.kernel.step(); this.postTick(this.deps.kernel.tick, events); return true; },
      drawEvent: () => this.drawEvent(), inflict: (id, affliction, at) => this.inflict(id, affliction, at), derezz: (id, reason, at) => this.kill(id, reason, at),
      record: (choice, outcome, at) => this.record('crossing', choice, outcome, at) });
  }
  openCrossing(def: CrossingDef): CrossingContext {
    this.registerCrossings([def]); const context = this.crossingRunner().survey(def); this.currentPhase = 'crossing';
    this.record('crossing_open', def.id, 'pending', this.deps.kernel.tick);
    this.deps.callbacks?.onLegEvent?.({ kind: 'crossing_open', def, context }); return context;
  }
  resolveCrossing(def: CrossingDef, option: CrossingOption): CrossingResult {
    this.registerCrossings([def]); this.currentPhase = 'crossing';
    const result = this.crossingRunner().resolve(def, option, this.deps.kernel.tick);
    this.currentPhase = 'travelling'; this.deps.callbacks?.codexSignal?.({ kind: 'crossing', option }); return result;
  }
  openDepot(): Depot {
    if (!DEPOT_LEGS.includes(this.deps.leg.id)) throw new Error('This leg has no depot.');
    if (this.depot === null) this.depot = new Depot(this.deps.leg.index, this.deps.store.get().difficulty, this.deps.store.get().discClass, {
      getRun: () => this.deps.store.get(), mutate: recipe => this.deps.store.mutate(recipe), view: () => this.deps.kernel.invariantState(),
      hasRecruited: () => this.recruited || this.deps.callbacks?.hasRecruited?.() === true,
      recruit: id => { this.recruited = true; this.deps.store.mutate(run => { const index = run.convoy.findIndex(m => m.id === id); const member = run.convoy[index]; if (member !== undefined) {
        run.convoy[index] = { ...member, name: member.name + '-2', integrity: 100, status: 'nominal', pid: null, epitaph: null, afflictions: [], abilityCharges: PER_LEG_ABILITY_CHARGES[member.role] - 1 };
      } }); this.deps.callbacks?.recruit?.(id); }, checkpoint: () => this.deps.callbacks?.checkpoint?.(),
      record: (item, target, ok) => this.record('depot', JSON.stringify({ item, target }), ok ? 'good' : 'costly', this.deps.kernel.tick),
    });
    this.currentPhase = 'depot'; this.record('depot_open', this.deps.leg.id, 'pending', this.deps.kernel.tick); this.deps.callbacks?.onLegEvent?.({ kind: 'depot_open', depot: this.depot }); return this.depot;
  }
  private reclamationModel(): Reclamation {
    return this.reclamation ??= new Reclamation({ getRun: () => this.deps.store.get(), mutate: recipe => this.deps.store.mutate(recipe), rng: this.deps.streams.reclamation,
      onIntegrity: (id, amount) => this.deps.store.mutate(run => { const member = run.convoy.find(m => m.id === id); if (member !== undefined) applyIntegrity(member, -amount); }),
      record: (trace, runIndex) => this.record('reclamation', JSON.stringify({ trace, runIndex }), 'good', this.deps.kernel.tick) });
  }
  openReclamation(): VergeLayout {
    const f = this.deps.kernel.invariantState().metrics.memory.externalFragmentation;
    const layout = this.reclamationModel().open(f, this.deps.store.get().difficulty, this.reclamationRuns + 1);
    this.reclamationRuns++; this.currentPhase = 'reclamation';
    this.record('reclamation_open', JSON.stringify({ runIndex: this.reclamationRuns }), 'pending', this.deps.kernel.tick);
    this.deps.callbacks?.onLegEvent?.({ kind: 'reclamation_open', layout }); return layout;
  }
  submitReclamation(trace: ReclamationTrace): ReclamationResult { const result = this.reclamationModel().submit(trace); this.postTick(this.deps.kernel.tick, []); return result; }
  continueTravel(): void {
    if (this.currentPhase !== 'travelling') this.record('travel_resume', '', 'pending', this.deps.kernel.tick);
    this.reclamation?.close(); this.currentPhase = 'travelling';
  }
  registerInteraction(id: string, handler: InteractionHandler, target: ConvoyMemberId | null = null): void { this.interactions.set(id, { handler, target }); }
  interaction(id: string, _anchor: string, at: Tick): boolean {
    const def = this.deps.leg.interactions.find(item => item.id === id); const registered = this.interactions.get(id);
    if (def === undefined || registered === undefined || !this.deps.sandbox.predicate(def, this.deps.store.get()) || !this.affordableInteraction(def, registered.target, this.deps.store.get())) return false;
    let applied = false;
    this.deps.store.mutate(run => {
      const transaction = structuredClone(run);
      const { integrity = 0, ...cost } = def.cost;
      applyDelta(transaction.resources, { cycles: -(cost.cycles ?? 0), quota: -(cost.quota ?? 0), blocks: -(cost.blocks ?? 0), bandwidth: -(cost.bandwidth ?? 0) });
      const member = transaction.convoy.find(m => m.id === registered.target); if (member !== undefined) applyIntegrity(member, -integrity);
      applied = this.deps.sandbox.predicate({ ...def, enabledWhen: draft => { registered.handler(draft, at, this.deps.kernel); return true; } }, transaction);
      if (applied) Object.assign(run, transaction);
      else {
        const decision = run.decisions.at(-1);
        if (decision?.kind === 'interaction') decision.outcome = 'costly';
      }
    }); return applied;
  }

  useAbility(_member: ConvoyMemberId, _target: number | null, _at: Tick): void {
    // TODO(astra): the abilities package implements convoy abilities
  }
  terminal(_line: string, _at: Tick): void {}
  private record(kind: string, choice: string, outcome: DecisionRecord['outcome'], at: Tick): void {
    if (this.replayingAction) return;
    this.deps.store.mutate(run => { run.decisions.push({ tick: at, legId: this.deps.leg.id, kind, choice, outcome, relatedObjective: null }); });
  }
  /** Replay only owned action kinds; command records stay on CommandBus's road. */
  dispatch(record: DecisionRecord): boolean {
    if (!DIRECTOR_OWNED_KINDS.has(record.kind)) return false;
    this.replayingAction = true;
    let owned = false;
    try {
      if (record.kind === 'travel_resume') { this.continueTravel(); owned = true; }
      else if (record.kind === 'depot_open') { this.openDepot(); owned = true; }
      else if (record.kind === 'crossing_open') { const def = this.crossings.get(record.choice); if (def !== undefined) { this.openCrossing(def); owned = true; } }
      else if (record.kind === 'crossing') {
        const split = record.choice.lastIndexOf(':'); const def = this.crossings.get(record.choice.slice(0, split)); const option = record.choice.slice(split + 1);
        if (def !== undefined && (option === 'spin' || option === 'block' || option === 'monitor' || option === 'wait')) { this.resolveCrossing(def, option); owned = true; }
      } else if (record.kind === 'depot') {
        const data: unknown = JSON.parse(record.choice);
        if (isObject(data) && typeof data.item === 'string' && DEPOT_ITEMS.includes(data.item as DepotItemId) && (data.target === null || MEMBERS.includes(data.target as ConvoyMemberId))) {
          this.openDepot().buy(data.item as DepotItemId, data.target as ConvoyMemberId | null); owned = true;
        }
      } else if (record.kind === 'reclamation_open') { this.openReclamation(); owned = true; }
      else if (record.kind === 'reclamation') {
        const data: unknown = JSON.parse(record.choice);
        if (isObject(data) && validTrace(data.trace)) { this.submitReclamation(data.trace); owned = true; }
      } else if (record.kind === 'interaction') {
        const split = record.choice.indexOf(' @ '); owned = this.interactions.has(record.choice.slice(0, split));
        if (owned) this.interaction(record.choice.slice(0, split), record.choice.slice(split + 3), record.tick);
      } else if (record.kind === 'checkpoint_rollback') owned = true;
      else if (record.kind === 'use_ability') owned = true;
      else if (record.kind === 'terminal') owned = true;
    } catch { owned = false; }
    finally { this.replayingAction = false; }
    if (owned) this.deps.store.mutate(run => { run.decisions.push({ ...record }); });
    return owned;
  }

  /** Rebase surviving clocks to the next leg's zero without resetting their ages. */
  finishAfflictionClock(): void {
    if (this.clockRebased) return;
    this.deps.store.mutate(run => {
      for (const member of run.convoy) if (member.status !== 'derezzed') member.afflictions = member.afflictions.map(a => ({ ...a, acquiredAtTick: asTick(a.acquiredAtTick - this.deps.kernel.tick) }));
    });
    this.clockRebased = true;
  }

  snapshot(): DirectorSnapshot {
    return structuredClone({ travel: this.travel, phase: this.currentPhase, events: this.events, processed: [...this.processed], completions: this.completions,
      pendingDeaths: [...this.deaths].map(([member, reason]) => ({ member, reason })), inverted: [...this.inverted], reclamationRuns: this.reclamationRuns,
      reclamation: this.reclamation?.snapshot() ?? null, depot: this.depot?.snapshot() ?? null, recruited: this.recruited, capped: this.capped, clockRebased: this.clockRebased,
      previousPolicy: this.previousPolicy, previousQuantum: this.previousQuantum });
  }
  restore(state: DirectorSnapshot): void {
    Object.assign(this.travel, state.travel); this.currentPhase = state.phase; this.events.splice(0, this.events.length, ...state.events);
    this.captured.clear(); for (const event of state.events) this.captured.add(event.seq);
    this.processed.clear(); for (const seq of state.processed) this.processed.add(seq);
    this.completions = state.completions; this.deaths.clear(); for (const death of state.pendingDeaths) this.deaths.set(death.member, death.reason);
    this.inverted.clear(); for (const member of state.inverted ?? []) this.inverted.add(member);
    this.reclamationRuns = state.reclamationRuns; this.recruited = state.recruited; this.capped = state.capped; this.clockRebased = state.clockRebased;
    this.previousPolicy = { ...state.previousPolicy }; this.previousQuantum = state.previousQuantum;
    if (state.reclamation !== null) this.reclamationModel().restore(state.reclamation);
    if (state.depot !== null) {
      const resources = { ...this.deps.store.get().resources };
      this.replayingAction = true;
      try { this.openDepot().restore(state.depot); } finally { this.replayingAction = false; }
      this.deps.store.mutate(run => { run.resources = resources; });
    }
    this.currentPhase = state.phase;
  }

  /** Each factory call gets isolated counters and fresh replay streams. */
  hooks(onCreate?: (director: RunDirector) => void): ReplayHooks {
    let replay: RunDirector | null = null;
    let latest: Readonly<RunState> | null = null;
    let initialPolicy: TravelPolicy | null = null;
    let initialQuantum: number | null = null;
    let initialCredit: boolean | null = null;
    let entryContext: { readonly streams: RunStreams; readonly store: Store<RunState> } | null = null;
    let reserved: Partial<ResourceLedger> = {};
    const commands: Command[] = [];
    const ensure = (kernel: ReplayKernel, streams: RunStreams, store: Store<RunState>): RunDirector => {
      if (replay === null) {
        replay = new RunDirector({ ...this.deps, kernel, streams, store, replay: true, callbacks: {},
          sandbox: new LegSandbox(this.deps.leg, () => undefined), bindings: new Map(store.get().convoy.flatMap(member => member.pid === null ? [] : [[member.id, member.pid]])),
          onCredit: initialCredit ?? emergencyCreditNeeded(store.get().resources, this.deps.leg.id) });
        replay.previousPolicy = initialPolicy ?? { ...store.get().policy }; replay.previousQuantum = initialQuantum ?? kernel.invariantState().schedulerParams.quantum;
        replay.registerCrossings([...this.crossings.values()]);
        for (const [id, value] of this.interactions) replay.registerInteraction(id, value.handler, value.target);
        onCreate?.(replay);
      }
      if ((reserved.cycles ?? 0) !== 0 || (reserved.bandwidth ?? 0) !== 0) store.mutate(run => applyDelta(run.resources, { cycles: -(reserved.cycles ?? 0), bandwidth: -(reserved.bandwidth ?? 0) }));
      reserved = {}; replay.pendingCommands.push(...commands.splice(0)); return replay;
    };
    return {
      enter: (streams, store) => { entryContext = { streams, store }; },
      isComplete: (_at, kernel, run) => {
        latest = run; if (initialPolicy === null) { initialPolicy = { ...run.policy }; initialQuantum = kernel.invariantState().schedulerParams.quantum; initialCredit = emergencyCreditNeeded(run.resources, this.deps.leg.id); }
        // Flush accepted tick-zero and final-boundary costs even if no step follows.
        if (entryContext !== null) return ensure(kernel, entryContext.streams, entryContext.store).complete;
        return replay?.complete ?? (this.travel.segmentsTotal === 0 || aliveMembers(run.convoy).length === 0);
      },
      admit: (cmd, origin) => {
        if (latest === null) return { ok: false, reason: 'Replay has no active leg.' };
        const director = replay ?? this;
        const refusal = director.checkAdmission(cmd, origin, latest, reserved, replay?.travel.onCredit ?? initialCredit ?? emergencyCreditNeeded(latest.resources, this.deps.leg.id));
        if (refusal !== null) return { ok: false, reason: refusal };
        const cost = director.commandCost(cmd, origin, latest); reserved = { cycles: (reserved.cycles ?? 0) + (cost.cycles ?? 0), bandwidth: (reserved.bandwidth ?? 0) + (cost.bandwidth ?? 0) }; commands.push(cmd); return { ok: true };
      },
      beforeStep: (at, kernel, streams, store) => { const director = ensure(kernel, streams, store); director.applyPolicy(false); director.preTick(at); },
      afterStep: (at, _kernel, events, _store) => replay?.postTick(at, events, false),
      dispatch: (record, kernel, streams, store) => ensure(kernel, streams, store).dispatch(record),
    };
  }
}
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object'; }
function validTrace(value: unknown): value is ReclamationTrace {
  return Array.isArray(value) && value.every(item => isObject(item) && typeof item.atSeconds === 'number' && typeof item.blockId === 'number' && (item.action === 'collect' || item.action === 'coalesce'));
}

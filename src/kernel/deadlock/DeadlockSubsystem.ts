import type { EmittableEvent } from '../EventBus';
import { KernelInvariantError } from '../errors';
import type { KernelTuning } from '../config';
import type { Program } from '../process/Program';
import type { ThreadControlBlock } from '../process/threads';
import type { IpcManager } from '../process/ipc';
import type { SyncSubsystem } from '../sync/SyncSubsystem';
import type {
  BlockReason, DeadlockReport, DeadlockSnapshotActor, DeadlockSnapshotDependency,
  DeadlockSnapshotState, KernelConfig, KernelSnapshot, Pid, ProcessControlBlock,
  ResourceId, SyscallResult, Tick, Tid,
} from '../types';
import { asResourceId } from '../types';
import { previewRequest, safetyCheck } from './bankers';
import { detectMultipleInstances } from './detection';
import { rotateToLowestPid } from './cycleDetection';
import { ResourceTable, type ResourceDeclaration } from './resources';
import { ResourceOrdering } from './ordering';
import { canRollback, suggestedVictims } from './recovery';
import { collectDependencies, buildWaitForGraph, qualifyResourceDependencies, dependencyKey, scenarioLockResources, type WaitForGraphInput } from './waitForGraph';
import { coffmanConditions, nearDeadlocks } from './coffman';

type Payload = DeadlockSnapshotState['payload'];
type Actor = DeadlockSnapshotActor;
type Vector = readonly (readonly [ResourceId, number])[];
type Pending = Payload['requests'][number];
type Checkpoint = Payload['checkpoints'][number];
export type DeadlockStrategy = KernelConfig['deadlockStrategy'];
export interface DeadlockHost {
  tick(): Tick;
  strategy(): DeadlockStrategy;
  settings(): Payload['settings'];
  processes(): readonly ProcessControlBlock[];
  process(pid: Pid): ProcessControlBlock | undefined;
  threads(): readonly ThreadControlBlock[];
  actor(pid: Pid): Actor | undefined;
  program(pid: Pid): Program | undefined;
  readonly sync: SyncSubsystem;
  readonly ipc: IpcManager;
  block(actor: Actor, resource: ResourceId): void;
  complete(pid: Pid): void;
  terminate(pid: Pid, reason: 'deadlock_victim' | 'protection_fault'): void;
  rollback(checkpoint: Checkpoint): void;
  emit(event: EmittableEvent): void;
}
export function deadlockSettings(tuning: KernelTuning): Payload['settings'] {
  return { deadlockDetectionInterval: tuning.deadlockDetectionInterval,
    rollbackCheckpointInterval: tuning.rollbackCheckpointInterval,
    maxPreemptionsPerProcess: tuning.maxPreemptionsPerProcess,
    preventionMode: tuning.preventionMode, deadlockRecovery: tuning.deadlockRecovery };
}
const key = (actor: Actor): string => `${actor.pid}:${actor.tid}`;
const same = (a: Actor, b: Actor): boolean => a.pid === b.pid && a.tid === b.tid;
const compare = (a: Actor, b: Actor): number => a.pid - b.pid || a.tid - b.tid;
const textOrder = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const success = (): SyscallResult => ({ ok: true, value: null });
const failure = (errno: Extract<SyscallResult, { ok: false }>['errno'], message: string): Extract<SyscallResult, { ok: false }> => ({ ok: false, errno, message });
const emptyStatistics = () => ({ deadlocks: 0, processesLost: 0, occupiedInstanceTicks: 0,
  capacityInstanceTicks: 0, totalTicks: 0, detectionLatencyTicks: 0, detectionSamples: 0 });
const active = (pcb: ProcessControlBlock): boolean => pcb.pid > 1 && pcb.state !== 'zombie' && pcb.state !== 'terminated';

/** Owns resource continuations; kernel phase bodies remain dispatch points. */
export class DeadlockSubsystem {
  readonly resources: ResourceTable;
  readonly ordering = new ResourceOrdering();
  private readonly requests = new Map<string, Pending>();
  private readonly checkpoints = new Map<Pid, Checkpoint>();
  private readonly preemptions = new Map<Pid, number>();
  private readonly overrides = new Map<ResourceId, Payload['preemptibilityOverrides'][number]>();
  private readonly endpoints = new Map<ResourceId, Payload['mailboxEndpoints'][number]>();
  private nextRequestGeneration = 0;
  private nextDependencyGeneration = 0;
  private observations: Payload['observations'] = [];
  private episodes: Payload['confirmedEpisodes'] = [];
  private lastObservationTick: Tick | null = null;
  private lastStatisticsTick: Tick | null = null;
  private lastDetection: Payload['lastDetection'] = null;
  private statistics = emptyStatistics();
  private draining = false;

  constructor(private readonly host: DeadlockHost) {
    this.resources = new ResourceTable({ processes: () => host.processes(), collides: id =>
      id.startsWith('mbox:') || host.sync.get(id) !== undefined || host.ipc.mailbox(id) !== undefined });
  }
  declare(resource: ResourceDeclaration): void {
    this.resources.declare(resource); this.ordering.declare(resource.id, 'resource');
  }
  declareClaims(pid: Pid, claims: Vector): void { this.resources.declareClaims(pid, claims); }
  onSyncDeclare(resource: ResourceId): void {
    if (this.resources.owns(resource) || resource.startsWith('mbox:') || this.host.ipc.mailbox(resource) !== undefined) {
      throw new RangeError('synchronization declaration collides with a resource or mailbox');
    }
    this.ordering.declare(resource, 'sync');
  }
  declareMailboxEndpoints(mailbox: ResourceId, senders: readonly Actor[], receivers: readonly Actor[]): void {
    if (this.host.ipc.mailbox(mailbox) === undefined || this.resources.owns(mailbox) || this.host.sync.get(mailbox) !== undefined) {
      throw new RangeError('mailbox declaration is missing or collides with a resource');
    }
    const canonical = (actors: readonly Actor[]): Actor[] => {
      if (actors.length === 0 || new Set(actors.map(key)).size !== actors.length) throw new RangeError('mailbox endpoint roster must be nonempty and unique');
      for (const actor of actors) this.requireActor(actor);
      return actors.map(actor => ({ ...actor })).sort(compare);
    };
    const row = { mailbox, senders: canonical(senders), receivers: canonical(receivers) };
    this.endpoints.set(mailbox, row);
  }
  owns(resource: ResourceId): boolean { return this.resources.owns(resource); }
  private governedHeld(pid: Pid): ResourceId[] {
    const pcb = this.host.process(pid);
    return pcb === undefined ? [] : pcb.heldResources.filter(id => this.ordering.rank(id) !== undefined);
  }
  beforeAcquire(actor: Actor, resource: ResourceId, _operation: 'mutex_lock' | 'sem_wait'): Extract<SyscallResult, { ok: false }> | undefined {
    if (this.host.strategy() !== 'prevent') return undefined;
    const allowed = this.permitsAcquisition(actor.pid, [[resource, 1]]);
    return allowed ? undefined : failure('EDEADLK', 'request violates the configured prevention rule');
  }
  assertStrategy(strategy: DeadlockStrategy): void {
    if (!['ignore', 'detect', 'avoid', 'prevent'].includes(strategy)) throw new RangeError('invalid deadlock strategy');
    if (strategy === 'prevent') this.assertPrevention();
    if (strategy === 'avoid') {
      let safe = false;
      try { safe = safetyCheck(this.resources.bankersState()).safe; } catch { /* Invalid Max/Allocation also rejects the transition. */ }
      if (!safe) throw new RangeError('cannot enter avoidance with an unsafe or inconsistent allocation');
    }
  }
  evaluateBankers(pid: Pid, resource: ResourceId, instances: number): ReturnType<typeof safetyCheck> {
    return this.evaluateVector(pid, [[resource, instances]], resource);
  }
  evaluateVector(pid: Pid, requested: Vector, label?: ResourceId): ReturnType<typeof safetyCheck> {
    let result: ReturnType<typeof safetyCheck>;
    const resource = label ?? [...requested].filter(([, count]) => count > 0).sort(([a], [b]) => textOrder(a, b))[0]?.[0];
    if (resource === undefined) throw new RangeError('preview requires a nonzero resource column');
    try {
      const vector = this.resources.normalizeVector(requested);
      const state = this.resources.bankersState();
      result = previewRequest(state, pid, state.resources.map(id => vector.find(([rid]) => rid === id)?.[1] ?? 0)).result;
    } catch (error) {
      result = { safe: false, sequence: null, trace: [{ work: this.resources.resources.map(row => row.availableInstances),
        candidate: null, admitted: false, explanation: `Request precheck failed: ${error instanceof Error ? error.message : 'invalid request'}` }] };
    }
    this.host.emit({ type: 'bankers.evaluated', result, forRequest: { pid, resource } });
    return result;
  }
  request(pid: Pid, resource: ResourceId, instances: number): SyscallResult { return this.requestVector(pid, [[resource, instances]]); }
  requestVector(pid: Pid, requested: Vector): SyscallResult {
    const pcb = this.host.process(pid); const actor = this.host.actor(pid);
    if (pcb === undefined || !active(pcb) || actor === undefined) return failure('ESRCH', 'process not found');
    const priorRequest = this.requests.get(key(actor));
    if (priorRequest?.grantedAt !== null && priorRequest !== undefined && !this.host.threads().some(thread => same(thread, actor) && thread.state === 'waiting')) this.requests.delete(key(actor));
    if (this.requests.has(key(actor))) return failure('EBUSY', 'actor already has a resource request');
    let vector: Vector;
    try { vector = this.resources.normalizeVector(requested); } catch (error) { return failure('EINVAL', String(error)); }
    if (vector.length === 0) return success();
    if (this.host.strategy() === 'prevent') {
      const allowed = this.permitsAcquisition(pid, vector);
      if (!allowed) return failure('EDEADLK', 'request violates the configured prevention rule');
    }
    let denial: 'unsafe' | 'unavailable' | null = vector.some(([id, count]) => count > (this.resources.get(id)?.availableInstances ?? -1)) ? 'unavailable' : null;
    if (this.host.strategy() === 'avoid') {
      const state = this.resources.bankersState();
      const preview = previewRequest(state, pid, state.resources.map(id => vector.find(([rid]) => rid === id)?.[1] ?? 0));
      const first = vector[0]; if (first === undefined) throw new Error('empty normalized request');
      this.host.emit({ type: 'bankers.evaluated', result: preview.result, forRequest: { pid, resource: first[0] } });
      if (preview.kind === 'invalid') { this.host.terminate(pid, 'protection_fault'); return failure('EINVAL', 'request exceeds its declared maximum'); }
      denial = preview.kind === 'safe' ? null : preview.kind;
    }
    if (denial !== null && (pcb.state !== 'running' || !this.host.threads().some(thread => thread.tid === actor.tid && thread.pid === pid && thread.state !== 'waiting' && thread.state !== 'terminated'))) {
      return failure('EBUSY', 'blocking request requires a running actor');
    }
    this.checkpoint(pid, true);
    for (const [resource, instances] of vector) this.host.emit({ type: 'resource.requested', pid, resource, instances });
    if (denial === null) { this.grant(pid, vector); return success(); }
    for (const [resource] of vector) this.host.emit({ type: 'resource.denied', pid, resource, reason: denial });
    const pending: Pending = { generation: this.nextRequestGeneration++, actor: { ...actor }, requestedAt: this.host.tick(), resources: vector.map(row => [...row] as const), grantedAt: null };
    this.requests.set(key(actor), pending); this.projectRequests();
    const first = vector[0]; if (first === undefined) throw new Error('empty normalized request');
    this.host.block(actor, first[0]);
    return failure('EAGAIN', denial === 'unsafe' ? 'request would leave an unsafe state' : 'resources unavailable');
  }
  release(pid: Pid, resource: ResourceId, instances: number): SyscallResult { return this.releaseVector(pid, [[resource, instances]]); }
  releaseVector(pid: Pid, vector: Vector): SyscallResult {
    const pcb = this.host.process(pid); if (pcb === undefined || !active(pcb)) return failure('ESRCH', 'process not found');
    try { this.resources.release(pid, vector); } catch (error) { return failure('EINVAL', String(error)); }
    this.drainRequests(); return success();
  }
  private grant(pid: Pid, vector: Vector): void {
    this.resources.grant(pid, vector);
    for (const [resource, instances] of vector) this.host.emit({ type: 'resource.granted', pid, resource, instances });
    if (this.host.strategy() === 'avoid' && !safetyCheck(this.resources.bankersState()).safe) throw new KernelInvariantError(25, 'avoidance grant is unsafe');
  }
  private projectRequests(): void {
    for (const pcb of this.host.processes()) {
      const pending = [...this.requests.values()].filter(row => row.actor.pid === pcb.pid && row.grantedAt === null).sort((a, b) => a.generation - b.generation);
      const ids = pending.flatMap(row => row.resources.flatMap(([id, count]) => Array.from({ length: count }, () => id)));
      pcb.requestedResources.splice(0, pcb.requestedResources.length, ...pcb.requestedResources.filter(id => !this.owns(id)), ...ids);
    }
  }
  private drainRequests(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const request of [...this.requests.values()].sort((a, b) => a.generation - b.generation)) {
        if (request.grantedAt !== null) continue;
        const pcb = this.host.process(request.actor.pid);
        if (pcb === undefined || !active(pcb)) continue;
        if (request.resources.some(([id, count]) => count > (this.resources.get(id)?.availableInstances ?? -1))) continue;
        if (this.host.strategy() === 'avoid') {
          const state = this.resources.bankersState();
          if (previewRequest(state, pcb.pid, state.resources.map(id => request.resources.find(([rid]) => rid === id)?.[1] ?? 0)).kind !== 'safe') continue;
        }
        this.grant(pcb.pid, request.resources);
        this.requests.set(key(request.actor), { ...request, grantedAt: this.host.tick() });
        this.projectRequests(); this.host.complete(pcb.pid);
      }
    } finally { this.draining = false; }
  }
  isSatisfied(pid: Pid, reason: BlockReason, tid?: Tid): boolean {
    if (reason.kind !== 'semaphore' || tid === undefined) return false;
    const request = this.requests.get(key({ pid, tid }));
    return request !== undefined && request.grantedAt !== null && request.resources[0]?.[0] === reason.resource;
  }
  removeWaiter(pid: Pid): void {
    for (const [id, row] of this.requests) if (row.actor.pid === pid) this.requests.delete(id);
    this.projectRequests();
  }
  releaseResources(pcb: ProcessControlBlock, releaseScenarioLocks = true): void {
    if (pcb.pid <= 1) return;
    this.removeWaiter(pcb.pid);
    if (releaseScenarioLocks) this.host.sync.removeWaiter(pcb.pid);
    const locks = new Set(scenarioLockResources(this.host.sync.allScenarios()));
    for (const primitive of this.host.sync.allPrimitives()) {
      if (!releaseScenarioLocks || primitive.kind !== 'semaphore' || !locks.has(primitive.id)) continue;
      for (const debit of primitive.debits) if (debit.actor?.pid === pcb.pid) this.host.sync.call(debit.actor, { op: 'sem_post', resource: primitive.id });
    }
    this.resources.releaseAll(pcb.pid); this.resources.clearClaims(pcb.pid); this.checkpoints.delete(pcb.pid);
    for (const [id, row] of this.endpoints) this.endpoints.set(id, { ...row,
      senders: row.senders.filter(actor => actor.pid !== pcb.pid), receivers: row.receivers.filter(actor => actor.pid !== pcb.pid) });
    this.drainRequests();
  }
  exec(pcb: ProcessControlBlock, releaseScenarioLocks = true): void { this.releaseResources(pcb, releaseScenarioLocks); }
  setPreemptible(resource: ResourceId, value: boolean, untilTick: Tick): void {
    if (!this.owns(resource) || typeof value !== 'boolean' || !Number.isSafeInteger(untilTick) || untilTick <= this.host.tick()) throw new RangeError('invalid preemptibility override');
    this.overrides.set(resource, { resource, preemptible: value, untilTick }); this.resources.setEffectivePreemptible(resource, value);
  }
  onPhase(phase: number, tick: Tick): void {
    if (phase === 1) {
      for (const [id, row] of this.overrides) if (row.untilTick <= tick) {
        const base = this.resources.declarations().find(resource => resource.id === id);
        if (base === undefined) throw new Error('override resource missing');
        this.resources.setEffectivePreemptible(id, base.preemptible); this.overrides.delete(id);
      }
      this.drainRequests();
    }
    if (phase === 9) {
      for (const [id, row] of this.requests) if (row.grantedAt !== null && !this.host.threads().some(thread => thread.tid === row.actor.tid && thread.state === 'waiting')) this.requests.delete(id);
      this.observeDependencies(tick);
      for (const pcb of this.host.processes()) if (active(pcb)) this.checkpoint(pcb.pid, false);
    }
    if (phase === 11 && this.lastStatisticsTick !== tick) {
      const elapsed = this.lastStatisticsTick === null ? tick : tick - this.lastStatisticsTick;
      this.lastStatisticsTick = tick;
      this.statistics.totalTicks += elapsed;
      for (const resource of this.resources.resources) {
        this.statistics.occupiedInstanceTicks += (resource.totalInstances - resource.availableInstances) * elapsed;
        this.statistics.capacityInstanceTicks += resource.totalInstances * elapsed;
      }
    }
  }
  private checkpoint(pid: Pid, initial: boolean): void {
    const pcb = this.host.process(pid); if (pcb === undefined) return;
    const threads = this.host.threads().filter(thread => thread.pid === pid && thread.state !== 'terminated');
    const prior = this.checkpoints.get(pid);
    if (prior !== undefined && (threads.length !== 1 || threads[0]?.tid !== prior.tid)) this.checkpoints.delete(pid);
    const onlyThread = threads[0];
    if (threads.length !== 1 || onlyThread === undefined || pcb.heldResources.length > 0 || this.requests.has(key(onlyThread))) return;
    if (initial ? this.checkpoints.has(pid) : this.host.tick() % this.host.settings().rollbackCheckpointInterval !== 0) return;
    const thread = threads[0]; if (thread === undefined || thread.state === 'waiting') return;
    this.checkpoints.set(pid, { pid, tid: thread.tid, tick: this.host.tick(), programCounter: thread.programCounter });
  }
  private graphInput(): WaitForGraphInput {
    return { processes: this.host.processes(), threads: this.host.threads(), resources: this.resources.resources,
      requests: [...this.requests.values()], primitives: this.host.sync.allPrimitives(), waits: this.host.sync.allWaits(),
      scenarios: this.host.sync.allScenarios(), reserved: generation => this.host.sync.reserved(generation),
      mailboxEndpoints: [...this.endpoints.values()], mailbox: id => this.host.ipc.mailbox(id),
      matchesIpcWait: (pid, reason) => this.host.ipc.matchesWait(pid, reason), hasIpcCompletion: pid => this.host.ipc.hasCompletion(pid) };
  }
  private observeDependencies(tick: Tick): readonly DeadlockSnapshotDependency[] {
    const dependencies = collectDependencies(this.graphInput()).slice().sort((a, b) => textOrder(dependencyKey(a), dependencyKey(b)));
    const previous = new Map(this.observations.map(row => [dependencyKey(row.dependency), row]));
    this.observations = dependencies.map(dependency => previous.get(dependencyKey(dependency)) ?? { generation: this.nextDependencyGeneration++, dependency, sinceTick: tick });
    const live = new Set(this.observations.map(row => row.generation));
    this.episodes = this.episodes.filter(episode => episode.every(id => live.has(id)));
    this.lastObservationTick = tick; return dependencies;
  }
  detectDeadlock(): DeadlockReport | null {
    const dependencies = this.observeDependencies(this.host.tick());
    const state = this.resources.bankersState();
    const detected = detectMultipleInstances({ ...state, request: this.resources.requestMatrix() });
    const mixed = dependencies.some(row => row.source.kind !== 'resource_request');
    const qualified = mixed ? qualifyResourceDependencies(this.graphInput(), dependencies) : dependencies;
    const built = buildWaitForGraph(qualified, this.host.processes().map(pcb => pcb.pid), mixed ? undefined : new Set(detected.deadlocked));
    if (built.actorCycle === null) return null;
    const projected = built.actorCycle.map(actor => actor.pid).filter((pid, index, all) => index === 0 || pid !== all[index - 1]);
    if (projected.length > 1 && projected[0] === projected[projected.length - 1]) projected.pop();
    const cycle = rotateToLowestPid(projected);
    const relevant = supportingWitness(built.actorCycle, built.closedDependencies);
    const resources = [...new Set(relevant.filter(row => cycle.includes(row.waiter.pid)).flatMap(row => {
      switch (row.source.kind) {
        case 'resource_request': case 'sync_wait': return [row.source.resource];
        case 'mailbox': return [asResourceId(`mbox:${row.source.mailbox}:${row.source.operation}`)];
        case 'child_wait': return [];
      }
    }))].sort(textOrder);
    const victims = this.host.processes().filter(pcb => active(pcb) && cycle.includes(pcb.pid));
    const report: DeadlockReport = { tick: this.host.tick(), cycle, resources, conditions: coffmanConditions(cycle), suggestedVictims: suggestedVictims(victims.map(pcb => pcb.pid), pid => this.host.process(pid)) };
    this.lastDetection = { report: { ...report }, actorCycle: built.actorCycle, dependencies: relevant };
    this.checkEvidence();
    const witnessKeys = new Set(relevant.map(dependencyKey));
    const witness = this.observations.filter(row => witnessKeys.has(dependencyKey(row.dependency)));
    const ids = witness.map(row => row.generation).sort((a, b) => a - b);
    if (!this.episodes.some(episode => JSON.stringify(episode) === JSON.stringify(ids))) {
      this.episodes = [...this.episodes, ids]; this.statistics.deadlocks += 1; this.statistics.detectionSamples += 1;
      this.statistics.detectionLatencyTicks += this.host.tick() - Math.max(0, ...witness.map(row => row.sinceTick));
      this.host.emit({ type: 'deadlock.detected', report });
    }
    return report;
  }
  maybeDetect(tick: Tick): void {
    if (this.host.strategy() !== 'detect' || tick % this.host.settings().deadlockDetectionInterval !== 0) return;
    let report = this.detectDeadlock();
    while (report !== null && this.host.settings().deadlockRecovery !== 'none') {
      this.recover(report); report = this.detectDeadlock();
    }
  }
  private recover(report: DeadlockReport): void {
    const mode = this.host.settings().deadlockRecovery;
    if (mode === 'preempt') {
      for (const pid of report.suggestedVictims) {
        const pcb = this.host.process(pid); const checkpoint = this.checkpoints.get(pid); const program = this.host.program(pid);
        if (pcb === undefined || checkpoint === undefined || program === undefined) continue;
        if (!canRollback({ process: pcb, threads: this.host.threads().filter(thread => thread.pid === pid), checkpoint, program,
          preemptionCount: this.preemptions.get(pid) ?? 0, maxPreemptions: this.host.settings().maxPreemptionsPerProcess,
          hasSyncOwnership: pcb.heldResources.some(id => this.host.sync.get(id) !== undefined),
          hasUnrelatedContinuation: this.host.ipc.hasMailboxWait(pid) || this.host.sync.allWaits().some(wait => wait.actor.pid === pid),
          preemptible: id => this.resources.get(id)?.preemptible === true, isOwnedResource: id => this.owns(id) })) continue;
        this.removeWaiter(pid); this.resources.releaseAll(pid); this.preemptions.set(pid, (this.preemptions.get(pid) ?? 0) + 1);
        this.host.rollback(checkpoint); this.drainRequests();
        this.host.emit({ type: 'deadlock.resolved', victims: [pid], method: 'rollback' }); return;
      }
    }
    const deadlocked = mode === 'abort_all' ? detectMultipleInstances({ ...this.resources.bankersState(), request: this.resources.requestMatrix() }).deadlocked : [];
    const victims = mode === 'abort_all'
      ? suggestedVictims([...new Set([...report.suggestedVictims, ...deadlocked])], pid => this.host.process(pid))
      : report.suggestedVictims.slice(0, 1);
    if (victims.length === 0) throw new KernelInvariantError(26, 'deadlock has no recoverable victim');
    for (const pid of victims) { this.host.terminate(pid, 'deadlock_victim'); this.statistics.processesLost += 1; }
    this.host.emit({ type: 'deadlock.resolved', victims, method: 'terminate' });
  }
  nearDeadlocks(): ReturnType<typeof nearDeadlocks> { return nearDeadlocks(this.graphInput()); }
  averageDetectionLatency(): number { return this.statistics.detectionSamples === 0 ? 0 : this.statistics.detectionLatencyTicks / this.statistics.detectionSamples; }
  strategyReport(): { deadlocks: number; processesLost: number; averageUtilisation: number; totalTicks: number } {
    return { deadlocks: this.statistics.deadlocks, processesLost: this.statistics.processesLost,
      averageUtilisation: this.statistics.capacityInstanceTicks === 0 ? 0 : this.statistics.occupiedInstanceTicks / this.statistics.capacityInstanceTicks,
      totalTicks: this.statistics.totalTicks };
  }
  private requireActor(actor: Actor): void {
    if (!this.host.threads().some(thread => same(thread, actor) && thread.state !== 'terminated') || !this.host.process(actor.pid)?.threads.includes(actor.tid)) throw new RangeError('actor is not a live process thread');
  }
  private checkEvidence(): void {
    const saved = this.lastDetection; if (saved === null) return;
    const report = saved.report;
    const projected = saved.actorCycle.map(actor => actor.pid).filter((pid, index, all) => index === 0 || pid !== all[index - 1]);
    if (projected.length > 1 && projected[0] === projected[projected.length - 1]) projected.pop();
    if (projected.length === 0 || JSON.stringify(rotateToLowestPid(projected)) !== JSON.stringify(report.cycle)) throw new KernelInvariantError(26, 'report differs from its actor witness');
    const trapped = new Set(saved.dependencies.map(row => key(row.waiter)));
    for (const row of saved.dependencies) if (row.alternatives.length === 0 || row.alternatives.some(actor => !trapped.has(key(actor)))) throw new KernelInvariantError(26, 'captured alternative can still progress');
    if (report.cycle.length === 0 || JSON.stringify(report.conditions) !== JSON.stringify(coffmanConditions(report.cycle))) throw new KernelInvariantError(26, 'deadlock report lacks the four conditions');
    const graph = new Map<Pid, Set<Pid>>();
    for (const row of saved.dependencies) {
      const edges = graph.get(row.waiter.pid) ?? new Set<Pid>();
      for (const actor of row.alternatives) edges.add(actor.pid);
      graph.set(row.waiter.pid, edges);
    }
    for (let i = 0; i < report.cycle.length; i++) {
      const from = report.cycle[i]; const to = report.cycle[(i + 1) % report.cycle.length];
      if (from === undefined || to === undefined || !graph.get(from)?.has(to)) throw new KernelInvariantError(26, 'report edge is absent from captured dependencies');
    }
    for (let i = 0; i < saved.actorCycle.length; i++) {
      const from = saved.actorCycle[i]; const to = saved.actorCycle[(i + 1) % saved.actorCycle.length];
      if (from === undefined || to === undefined || !saved.dependencies.some(row => same(row.waiter, from) && row.alternatives.some(actor => same(actor, to)))) throw new KernelInvariantError(26, 'actor cycle is absent from captured evidence');
    }
  }
  assertInvariants(): void {
    this.resources.assertConservation();
    if (this.host.strategy() === 'avoid' && !safetyCheck(this.resources.bankersState()).safe) throw new KernelInvariantError(25, 'avoidance allocation became unsafe');
    if (this.host.strategy() === 'prevent') this.assertPrevention();
    this.checkEvidence();
  }
  private pendingGoverned(pid?: Pid): { readonly pid: Pid; readonly resources: Vector }[] {
    const rows = [...this.requests.values()].filter(row => row.grantedAt === null && (pid === undefined || pid === row.actor.pid)).map(row => ({ pid: row.actor.pid, resources: row.resources }));
    for (const wait of this.host.sync.allWaits()) {
      if (this.host.sync.reserved(wait.generation) || (pid !== undefined && pid !== wait.actor.pid)) continue;
      const primitive = this.host.sync.get(wait.resource);
      if ((wait.operation.kind === 'mutex' && primitive?.kind === 'mutex') || (wait.operation.kind === 'semaphore' && primitive?.kind === 'semaphore')) rows.push({ pid: wait.actor.pid, resources: [[wait.resource, 1]] });
    }
    return rows;
  }
  private permitsAcquisition(pid: Pid, vector: Vector): boolean {
    const held = this.governedHeld(pid);
    if (this.host.settings().preventionMode === 'all_or_nothing') return this.pendingGoverned(pid).length === 0
      && this.ordering.checkAllOrNothing(held, vector, this.resources.claim(pid));
    if (!this.ordering.checkOrdering(held, vector.map(([id]) => id))) return false;
    // A sibling may not acquire above an already queued lower-rank request.
    const after = [...held, ...vector.map(([id]) => id)];
    return this.pendingGoverned(pid).every(row => this.ordering.checkOrdering(after, row.resources.map(([id]) => id)));
  }
  private assertPrevention(): void {
    const pending = this.pendingGoverned();
    for (const row of pending) {
      const held = this.governedHeld(row.pid);
      const allowed = this.host.settings().preventionMode === 'ordering'
        ? this.ordering.checkOrdering(held, row.resources.map(([id]) => id))
        : pending.filter(other => other.pid === row.pid).length === 1
          && this.ordering.checkAllOrNothing(held, row.resources, this.resources.claim(row.pid));
      if (!allowed) throw new KernelInvariantError(24, 'pending resource or synchronization request violates prevention');
    }
  }
  saveState(): { readonly deadlock: DeadlockSnapshotState } {
    const saved: DeadlockSnapshotState = { owner: 'deadlock', version: 1, payload: {
      tick: this.host.tick(), settings: { ...this.host.settings() }, declarations: this.resources.declarations(),
      ranks: this.ordering.entries(), claims: this.resources.claimsSnapshot(), nextRequestGeneration: this.nextRequestGeneration,
      requests: [...this.requests.values()].sort((a, b) => a.generation - b.generation),
      mailboxEndpoints: [...this.endpoints.values()].sort((a, b) => textOrder(a.mailbox, b.mailbox)),
      checkpoints: [...this.checkpoints.values()].sort((a, b) => a.pid - b.pid),
      preemptionCounts: [...this.preemptions].sort(([a], [b]) => a - b),
      preemptibilityOverrides: [...this.overrides.values()].sort((a, b) => textOrder(a.resource, b.resource)),
      lastObservationTick: this.lastObservationTick, lastStatisticsTick: this.lastStatisticsTick,
      nextDependencyGeneration: this.nextDependencyGeneration,
      observations: [...this.observations].sort((a, b) => a.generation - b.generation),
      confirmedEpisodes: [...this.episodes].sort((a, b) => textOrder(JSON.stringify(a), JSON.stringify(b))),
      lastDetection: this.lastDetection, statistics: { ...this.statistics },
    } };
    portable(saved); return { deadlock: freeze(structuredClone(saved)) };
  }
  prepareKernelRestore(snapshot: KernelSnapshot): () => void {
    let saved = snapshot.subsystems?.deadlock;
    if (saved === undefined) {
      ensure(snapshot.resources.length === 0, 'missing deadlock contribution with resource state');
      const empty = new DeadlockSubsystem({ ...this.host, tick: () => snapshot.tick });
      for (const primitive of snapshot.subsystems?.sync?.payload.primitives ?? []) empty.ordering.declare(primitive.id, 'sync');
      ensure((snapshot.subsystems?.sync?.payload.primitives.length ?? 0) === 0, 'missing declaration order with synchronization state');
      if (snapshot.tick > 0 && snapshot.config.enabledSubsystems.includes('deadlock')) {
        empty.lastObservationTick = snapshot.tick; empty.lastStatisticsTick = snapshot.tick;
        empty.statistics.totalTicks = snapshot.tick;
      }
      saved = empty.saveState().deadlock;
    }
    const stagedProcesses = snapshot.processes.filter(pcb => pcb.pid > 1).map(pcb => structuredClone(pcb));
    const prepare = this.prepareRestore(saved, snapshot.tick, stagedProcesses);
    const candidate = new ResourceTable({ processes: () => stagedProcesses });
    candidate.restore(saved.payload.declarations, saved.payload.claims);
    for (const row of saved.payload.preemptibilityOverrides) candidate.setEffectivePreemptible(row.resource, row.preemptible);
    ensure(JSON.stringify(candidate.resources) === JSON.stringify(snapshot.resources), 'shared resource projection differs from deadlock state');
    return prepare;
  }
  /** WP-11 supplies equivalent staged TCB, sync and IPC owners before committing. */
  prepareRestore(saved: DeadlockSnapshotState, tick = this.host.tick(), processes: readonly ProcessControlBlock[] = this.host.processes()): () => void {
    portable(saved);
    ensure(saved.owner === 'deadlock' && saved.version === 1, 'unsupported deadlock snapshot');
    ensure(saved.payload.tick === tick && integer(tick), 'deadlock clock mismatch');
    ensure(JSON.stringify(saved.payload.settings) === JSON.stringify(this.host.settings()), 'deadlock tuning mismatch');
    const copy = structuredClone(saved);
    const staged = processes.map(pcb => structuredClone(pcb));
    const candidate = new DeadlockSubsystem({ ...this.host, tick: () => tick, processes: () => staged, process: pid => staged.find(pcb => pcb.pid === pid) });
    candidate.install(copy); candidate.validate(copy);
    return () => { this.install(copy); };
  }
  private install(saved: DeadlockSnapshotState): void {
    const p = saved.payload;
    this.resources.restore(p.declarations, p.claims); this.ordering.restore(p.ranks);
    this.requests.clear(); for (const row of p.requests) this.requests.set(key(row.actor), structuredClone(row));
    this.checkpoints.clear(); for (const row of p.checkpoints) this.checkpoints.set(row.pid, { ...row });
    this.preemptions.clear(); for (const [pid, count] of p.preemptionCounts) this.preemptions.set(pid, count);
    this.overrides.clear(); for (const row of p.preemptibilityOverrides) {
      this.overrides.set(row.resource, { ...row }); this.resources.setEffectivePreemptible(row.resource, row.preemptible);
    }
    this.endpoints.clear(); for (const row of p.mailboxEndpoints) this.endpoints.set(row.mailbox, structuredClone(row));
    this.nextRequestGeneration = p.nextRequestGeneration; this.nextDependencyGeneration = p.nextDependencyGeneration;
    this.lastObservationTick = p.lastObservationTick; this.lastStatisticsTick = p.lastStatisticsTick;
    this.observations = structuredClone(p.observations); this.episodes = structuredClone(p.confirmedEpisodes);
    this.lastDetection = structuredClone(p.lastDetection); this.statistics = { ...p.statistics };
  }
  private validate(saved: DeadlockSnapshotState): void {
    const p = saved.payload;
    ensure(Object.keys(p).sort(textOrder).join() === Object.keys(this.saveState().deadlock.payload).sort(textOrder).join(), 'unknown or missing deadlock field');
    ensure(integer(p.nextRequestGeneration) && integer(p.nextDependencyGeneration), 'generation counters');
    ensure(p.lastObservationTick === null || integer(p.lastObservationTick) && p.lastObservationTick <= p.tick, 'observation tick');
    ensure(p.lastStatisticsTick === null || integer(p.lastStatisticsTick) && p.lastStatisticsTick <= p.tick, 'statistics tick');
    ascending(p.declarations, row => row.id, 'declarations'); ascending(p.claims, row => row.pid, 'claims');
    ensure(p.ranks.length === p.declarations.length + this.host.sync.allPrimitives().length, 'rank declaration count');
    for (const row of p.ranks) ensure(row.source === 'resource' ? this.owns(row.resource) : row.source === 'sync' && this.host.sync.get(row.resource) !== undefined, 'rank source disagrees with owner');
    ascending(p.requests, row => row.generation, 'requests');
    ensure(new Set(p.requests.map(row => key(row.actor))).size === p.requests.length, 'duplicate requesting actor');
    for (const row of p.requests) {
      this.requireActor(row.actor);
      ensure(integer(row.generation) && row.generation < p.nextRequestGeneration && integer(row.requestedAt) && row.requestedAt <= p.tick, 'request identity or clock');
      ensure(row.grantedAt === null || integer(row.grantedAt) && row.grantedAt >= row.requestedAt && row.grantedAt <= p.tick, 'reservation clock');
      ensure(row.resources.length > 0 && JSON.stringify(this.resources.normalizeVector(row.resources)) === JSON.stringify(row.resources), 'request vector');
      const thread = this.host.threads().find(thread => same(thread, row.actor));
      if (row.grantedAt === null || thread?.state === 'waiting') ensure(thread?.blockedOn?.kind === 'semaphore' && thread.blockedOn.resource === row.resources[0]?.[0], 'resource waiter mismatch');
      else ensure(thread !== undefined && (thread.state === 'ready' || thread.state === 'running'), 'reservation actor state');
    }
    for (const pcb of this.host.processes()) {
      const queued = p.requests.filter(row => row.actor.pid === pcb.pid && row.grantedAt === null).flatMap(row => row.resources.flatMap(([id, count]) => Array.from({ length: count }, () => id))).sort(textOrder);
      ensure(JSON.stringify(queued) === JSON.stringify(pcb.requestedResources.filter(id => this.owns(id)).sort(textOrder)), 'queued request projection');
      const reserved = p.requests.filter(row => row.actor.pid === pcb.pid && row.grantedAt !== null).flatMap(row => row.resources.flatMap(([id, count]) => Array.from({ length: count }, () => id)));
      for (const id of new Set(reserved)) ensure(reserved.filter(value => value === id).length <= pcb.heldResources.filter(value => value === id).length, 'reservation exceeds allocated holdings');
    }
    ascending(p.mailboxEndpoints, row => row.mailbox, 'mailboxes');
    for (const row of p.mailboxEndpoints) {
      ensure(this.host.ipc.mailbox(row.mailbox) !== undefined && !this.owns(row.mailbox) && this.host.sync.get(row.mailbox) === undefined, 'mailbox identity or collision');
      for (const actors of [row.senders, row.receivers]) {
        ensure(new Set(actors.map(key)).size === actors.length && actors.every((actor, i) => i === 0 || compare(actors[i - 1] ?? actor, actor) < 0), 'mailbox actor order');
        for (const actor of actors) this.requireActor(actor);
      }
    }
    ascending(p.checkpoints, row => row.pid, 'checkpoints');
    for (const row of p.checkpoints) {
      this.requireActor(row);
      ensure(integer(row.tick) && row.tick <= p.tick && integer(row.programCounter), 'checkpoint clock or PC');
      ensure(this.host.threads().filter(thread => thread.pid === row.pid && thread.state !== 'terminated').length === 1, 'checkpoint requires one matching live TCB');
    }
    ascending(p.preemptionCounts, row => row[0], 'preemption counts');
    for (const [pid, count] of p.preemptionCounts) ensure(this.host.process(pid) !== undefined && integer(count), 'preemption count');
    ascending(p.preemptibilityOverrides, row => row.resource, 'overrides');
    for (const row of p.preemptibilityOverrides) ensure(this.owns(row.resource) && typeof row.preemptible === 'boolean' && integer(row.untilTick) && row.untilTick > p.tick, 'preemptibility override');
    ascending(p.observations, row => row.generation, 'observations');
    ensure(new Set(p.observations.map(row => dependencyKey(row.dependency))).size === p.observations.length, 'duplicate dependency observation');
    for (const row of p.observations) {
      ensure(integer(row.generation) && row.generation < p.nextDependencyGeneration && integer(row.sinceTick) && p.lastObservationTick !== null && row.sinceTick <= p.lastObservationTick, 'observation generation or clock');
      this.validateDependency(row.dependency);
    }
    const observationIds = new Set(p.observations.map(row => row.generation));
    ensure(new Set(p.confirmedEpisodes.map(row => JSON.stringify(row))).size === p.confirmedEpisodes.length, 'duplicate confirmed episode');
    for (const episode of p.confirmedEpisodes) {
      ensure(episode.length > 0, 'empty confirmed episode'); ascending(episode, value => value, 'episode members');
      for (const id of episode) ensure(observationIds.has(id), 'episode references missing observation');
    }
    if (p.lastDetection !== null) {
      ensure(integer(p.lastDetection.report.tick) && p.lastDetection.report.tick <= p.tick && p.lastDetection.actorCycle.length > 0, 'historical detection clock or witness');
      for (const row of p.lastDetection.dependencies) this.validateDependency(row);
      for (const actor of p.lastDetection.actorCycle) ensure(integer(actor.pid, 1) && integer(actor.tid, 1), 'historical actor identity');
      this.checkEvidence();
    }
    ensure(Object.keys(p.statistics).sort(textOrder).join() === Object.keys(emptyStatistics()).sort(textOrder).join(), 'statistics fields');
    for (const value of Object.values(p.statistics)) ensure(integer(value), 'statistics must be nonnegative safe integers');
    ensure(p.statistics.occupiedInstanceTicks <= p.statistics.capacityInstanceTicks && p.statistics.totalTicks <= p.tick
      && p.statistics.deadlocks === p.statistics.detectionSamples && p.statistics.deadlocks >= p.confirmedEpisodes.length, 'statistics conservation');
    this.assertInvariants();
  }
  private validateDependency(row: DeadlockSnapshotDependency): void {
    ensure(integer(row.waiter.pid, 1) && integer(row.waiter.tid, 1) && row.alternatives.length > 0, 'dependency actor or group');
    ensure(new Set(row.alternatives.map(key)).size === row.alternatives.length && row.alternatives.every((actor, i) => integer(actor.pid, 1) && integer(actor.tid, 1) && (i === 0 || compare(row.alternatives[i - 1] ?? actor, actor) < 0)), 'dependency alternative identity/order');
    switch (row.source.kind) {
      case 'resource_request': ensure(typeof row.source.resource === 'string' && integer(row.source.requestGeneration) && row.source.requestGeneration < this.nextRequestGeneration, 'historical resource request'); break;
      case 'sync_wait': ensure(typeof row.source.resource === 'string' && integer(row.source.waitGeneration), 'historical sync wait'); break;
      case 'mailbox': ensure(typeof row.source.mailbox === 'string' && ['send', 'recv'].includes(row.source.operation), 'historical mailbox wait'); break;
      case 'child_wait': ensure(integer(row.source.child, 1), 'historical child wait'); break;
      default: throw new RangeError('invalid dependency source');
    }
  }
}
function integer(value: number, minimum = 0): boolean { return Number.isSafeInteger(value) && value >= minimum; }
function ensure(condition: boolean, message: string): asserts condition { if (!condition) throw new RangeError(`invalid deadlock state: ${message}`); }
function ascending<T>(rows: readonly T[], value: (row: T) => string | number, label: string): void {
  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1]; const current = rows[i];
    ensure(previous !== undefined && current !== undefined && value(previous) < value(current), `${label} must be unique and ascending`);
  }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function portable(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { ensure(Number.isFinite(value), 'non-finite number'); return; }
  ensure(typeof value === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null), 'non-JSON payload');
  ensure(!seen.has(value), 'cyclic payload'); seen.add(value);
  for (const child of Object.values(value)) portable(child, seen);
  seen.delete(value);
}

/** Scalar calls are one pair; multiple pairs commit as one atomic vector. */
export function decodeResourceVector(args: readonly (string | number | boolean)[]): Vector | undefined {
  if (args.length === 0 || args.length % 2 !== 0) return undefined;
  const result: [ResourceId, number][] = [];
  for (let i = 0; i < args.length; i += 2) {
    const id = args[i]; const count = args[i + 1];
    if (typeof id !== 'string' || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return undefined;
    result.push([asResourceId(id), count]);
  }
  return result;
}

/** Retain the reported witness and its required alternatives, not unrelated stalls. */
function supportingWitness(cycle: readonly Actor[], dependencies: readonly DeadlockSnapshotDependency[]): readonly DeadlockSnapshotDependency[] {
  const ordered = [...dependencies].sort((a, b) => textOrder(dependencyKey(a), dependencyKey(b)));
  const next = new Map(cycle.map((actor, i) => [key(actor), cycle[(i + 1) % cycle.length]]));
  const queue = [...cycle]; const visited = new Set<string>(); const proof = new Map<string, DeadlockSnapshotDependency>();
  for (let index = 0; index < queue.length; index++) {
    const actor = queue[index]; if (actor === undefined || visited.has(key(actor))) continue;
    visited.add(key(actor));
    const target = next.get(key(actor));
    const chosen = ordered.find(row => same(row.waiter, actor) && (target === undefined || row.alternatives.some(candidate => same(candidate, target))));
    if (chosen === undefined) throw new KernelInvariantError(26, 'closed witness actor has no blocking dependency');
    const source = chosen.source;
    const groups = source.kind === 'resource_request' ? ordered.filter(row => same(row.waiter, actor) && row.source.kind === 'resource_request' && row.source.resource === source.resource && row.source.requestGeneration === source.requestGeneration) : [chosen];
    for (const row of groups) { proof.set(dependencyKey(row), row); queue.push(...row.alternatives); }
  }
  return [...proof.values()].sort((a, b) => textOrder(dependencyKey(a), dependencyKey(b)));
}

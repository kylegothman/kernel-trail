import type { EmittableEvent } from '../EventBus';
import type { ThreadControlBlock } from '../process/threads';
import { createMutex, mutexOperation, validateMutex } from './mutex';
import { createSemaphore, semaphoreOperation, semaphoreValue, anonymizeSemaphoreActor, validateSemaphore } from './semaphore';
import { createMonitor, monitorOperation, validateMonitor, monitorView, refreshMonitorView } from './monitor';
import { createRwlock, rwlockOperation, grantRwWaiters, validateRwlock } from './rwlock';
import { createBarrier, barrierOperation, validateBarrier } from './barrier';
import { Requirements } from './requirements';
import { PriorityInversion } from './priorityInversion';
import { MemoryOrder } from './memoryOrder';
import { RaceDetector } from './raceDetector';
import { Atomics } from './atomics';
import { executePeterson } from './peterson';
import { executeBoundedBuffer } from './scenarios/boundedBuffer';
import { executeReadersWriters } from './scenarios/readersWriters';
import { executePhilosophers } from './scenarios/philosophers';
import type {
  BlockReason, KernelEvent, KernelSnapshot, Pid, ProcessControlBlock, ResourceId, Rng,
  SyncPrimitive, SyncSnapshotActor, SyncSnapshotExecution, SyncSnapshotPrimitive, SyncSnapshotScenario,
  SyncSnapshotState, SyncSnapshotWait, SyscallResult, Tick, Tid,
} from '../types';

export type Actor = SyncSnapshotActor;
export type PrimitiveState = SyncSnapshotPrimitive;
export type WaitOperation = SyncSnapshotWait['operation'];
export type SyncSettings = SyncSnapshotState['payload']['settings'];

export type SyncValue =
  | { readonly kind: 'literal'; readonly value: number }
  | { readonly kind: 'register'; readonly name: string };

export type SyncInstruction =
  | { readonly op: 'load'; readonly cell: string; readonly into: string; readonly rmw: boolean }
  | { readonly op: 'store'; readonly cell: string; readonly value: SyncValue; readonly rmw: boolean }
  | { readonly op: 'set' | 'add'; readonly into: string; readonly value: SyncValue }
  | { readonly op: 'branch'; readonly left: SyncValue; readonly test: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge'; readonly right: SyncValue; readonly target: number }
  | { readonly op: 'mfence' }
  | { readonly op: 'tas'; readonly cell: string; readonly into: string }
  | { readonly op: 'cas'; readonly cell: string; readonly expected: SyncValue; readonly replacement: SyncValue; readonly into: string }
  | { readonly op: 'sem_wait' | 'sem_post' | 'mutex_lock' | 'mutex_unlock' | 'monitor_enter' | 'monitor_exit' | 'rw_read_lock' | 'rw_read_unlock' | 'rw_write_lock' | 'rw_write_unlock' | 'barrier_wait'; readonly resource: ResourceId }
  | { readonly op: 'cond_wait' | 'cond_signal' | 'cond_broadcast'; readonly monitor: ResourceId; readonly condition: string }
  | { readonly op: 'work'; readonly ticks: number }
  | { readonly op: 'scenario'; readonly scenario: string; readonly step: number };

export type AttemptResult = {
  readonly advance: boolean;
  readonly deferService: boolean;
  readonly target: number | null;
};
export const RETIRE: AttemptResult = Object.freeze({ advance: true, deferService: false, target: null });
export const RETRY: AttemptResult = Object.freeze({ advance: false, deferService: true, target: null });
export const WORKING: AttemptResult = Object.freeze({ advance: false, deferService: false, target: null });

export interface PrimitiveContext {
  readonly rng: Rng;
  tick(): Tick;
  get(resource: ResourceId): PrimitiveState | undefined;
  allPrimitives(): readonly PrimitiveState[];
  set(state: PrimitiveState): void;
  wait(generation: number): SyncSnapshotWait | undefined;
  allWaits(): readonly SyncSnapshotWait[];
  updateWait(wait: SyncSnapshotWait): void;
  newWait(actor: Actor, resource: ResourceId, operation: WaitOperation): number;
  canBlock(actor: Actor): boolean;
  block(generation: number): void;
  reserve(generation: number): void;
  reserved(generation: number): boolean;
  removeWait(generation: number): void;
  nextPermit(): number;
  enter(actor: Actor, resource: ResourceId): void;
  leave(actor: Actor, resource: ResourceId): void;
  flush(pid: Pid): void;
  emit(event: EmittableEvent): void;
}

export interface RequirementContext extends PrimitiveContext {
  settings(): SyncSettings;
  process(pid: Pid): ProcessControlBlock | undefined;
  terminate(pid: Pid): void;
}

export interface SyncHost {
  tick(): Tick;
  process(pid: Pid): ProcessControlBlock | undefined;
  processes(): readonly ProcessControlBlock[];
  thread(tid: Tid): ThreadControlBlock | undefined;
  actor(pid: Pid): Actor | undefined;
  originalWait?(actor: Actor): BlockReason | undefined;
  block(pid: Pid, reason: BlockReason, tid: Tid): void;
  emit(event: EmittableEvent): void;
  terminate(pid: Pid): void;
  complete(pid: Pid): void;
  settings(): SyncSettings;
  /** Bind without copying the authoritative external value. */
  cell(binding: { readonly kind: 'region'; readonly region: ResourceId } | { readonly kind: 'inode'; readonly inode: number; readonly field: string }): { get(): number; set(value: number): void } | undefined;
}

export interface ScenarioContext extends PrimitiveContext {
  scenario(id: string): SyncSnapshotScenario;
  setScenario(state: SyncSnapshotScenario): void;
  register(actor: Actor, name: string): number;
  setRegister(actor: Actor, name: string, value: number): void;
  work(actor: Actor, ticks: number | (() => number)): AttemptResult;
  load(actor: Actor, cell: string, rmw?: boolean): number;
  store(actor: Actor, cell: string, value: number, rmw?: boolean): boolean;
  call(actor: Actor, instruction: SyncInstruction): SyscallResult;
  atomicAcquire(actor: Actor, resource: ResourceId): boolean;
  atomicRelease(actor: Actor, resource: ResourceId): void;
  spin(actor: Actor, resource: ResourceId): AttemptResult;
  complete(pid: Pid): void;
}

export const actorKey = (actor: Actor): string => `${actor.pid}:${actor.tid}`;
export const sameActor = (left: Actor | null, right: Actor | null): boolean =>
  left === null ? right === null : right !== null && left.pid === right.pid && left.tid === right.tid;
export const compareActors = (left: Actor, right: Actor): number => left.pid - right.pid || left.tid - right.tid;
export const compareStrings = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
export const ok = (): SyscallResult => ({ ok: true, value: null });
export const invalid = (message: string): SyscallResult => ({ ok: false, errno: 'EINVAL', message });
export function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`invalid sync state: ${message}`);
}
export function integer(value: number, minimum = 0): boolean {
  return Number.isSafeInteger(value) && value >= minimum;
}

/** Copy every nested operand; Program.at never performs an operation. */
export function freezeSyncInstruction(operation: SyncInstruction): SyncInstruction {
  switch (operation.op) {
    case 'store': case 'set': case 'add':
      return Object.freeze({ ...operation, value: Object.freeze({ ...operation.value }) });
    case 'branch':
      return Object.freeze({ ...operation, left: Object.freeze({ ...operation.left }), right: Object.freeze({ ...operation.right }) });
    case 'cas':
      return Object.freeze({ ...operation, expected: Object.freeze({ ...operation.expected }), replacement: Object.freeze({ ...operation.replacement }) });
    default: return Object.freeze({ ...operation });
  }
}

/** Owns continuation data; kernel phases only call the installed hooks. */
export class SyncSubsystem implements ScenarioContext, RequirementContext {
  readonly primitives: SyncPrimitive[] = [];
  readonly memoryOrder: MemoryOrder;
  readonly raceDetector: RaceDetector;
  readonly atomics: Atomics;
  readonly requirements: Requirements;
  readonly priorities: PriorityInversion;
  private readonly states = new Map<ResourceId, PrimitiveState>();
  private readonly waits = new Map<number, SyncSnapshotWait>();
  private readonly reservations = new Map<number, Tick>();
  private readonly executions = new Map<string, SyncSnapshotExecution>();
  private readonly scenarios = new Map<string, SyncSnapshotScenario>();
  private readonly spins = new Map<Pid, number>();
  private nextGeneration = 0;
  private nextPermitId = 0;
  private lastTimerTick: Tick | null = null;
  private lastInversionTick: Tick | null = null;
  private attempting = false;

  constructor(private readonly host: SyncHost, readonly rng: Rng) {
    this.raceDetector = new RaceDetector(host);
    this.memoryOrder = new MemoryOrder(host, rng, this.raceDetector, actor => this.held(actor));
    this.atomics = new Atomics(this, this.memoryOrder);
    this.requirements = new Requirements(this);
    this.priorities = new PriorityInversion(host, this);
  }
  tick(): Tick { return this.host.tick(); }
  settings(): SyncSettings { return this.host.settings(); }
  process(pid: Pid): ProcessControlBlock | undefined { return this.host.process(pid); }
  terminate(pid: Pid): void { this.host.terminate(pid); }
  complete(pid: Pid): void { this.host.complete(pid); }
  emit(event: EmittableEvent): void { this.host.emit(event); }
  get(resource: ResourceId): PrimitiveState | undefined { return this.states.get(resource); }
  allPrimitives(): readonly PrimitiveState[] { return [...this.states.values()].sort((a, b) => compareStrings(a.id, b.id)); }
  allWaits(): readonly SyncSnapshotWait[] { return [...this.waits.values()].sort((a, b) => a.generation - b.generation); }
  wait(generation: number): SyncSnapshotWait | undefined { return this.waits.get(generation); }
  updateWait(wait: SyncSnapshotWait): void { this.waits.set(wait.generation, wait); }
  nextPermit(): number { return this.nextPermitId++; }
  reserved(generation: number): boolean { return this.reservations.has(generation); }
  removeWait(generation: number): void { this.waits.delete(generation); this.reservations.delete(generation); }
  newWait(actor: Actor, resource: ResourceId, operation: WaitOperation): number {
    check(!this.allWaits().some(wait => sameActor(wait.actor, actor)), 'actor already has a wait');
    const generation = this.nextGeneration++;
    this.updateWait({ generation, actor: { ...actor }, resource, operation: { ...operation }, requestedAt: this.tick(),
      entriesObserved: 0, boundedWarningEmitted: false, starvationWarningEmitted: false, starvationFatalEmitted: false });
    return generation;
  }
  canBlock(actor: Actor): boolean {
    const thread = this.host.thread(actor.tid);
    return this.process(actor.pid)?.state === 'running' && thread?.pid === actor.pid && thread.state !== 'waiting' && thread.state !== 'terminated';
  }
  private reason(wait: SyncSnapshotWait): BlockReason {
    switch (wait.operation.kind) {
      case 'condition': return { kind: 'condition', monitor: wait.resource, condition: wait.operation.condition };
      case 'mutex': case 'monitor_entry': case 'rw_read': case 'rw_write': return { kind: 'mutex', resource: wait.resource };
      default: return { kind: 'semaphore', resource: wait.resource };
    }
  }
  block(generation: number): void {
    const wait = this.wait(generation); check(wait !== undefined, 'cannot block a missing wait');
    this.host.block(wait.actor.pid, this.reason(wait), wait.actor.tid);
    this.priorities.refresh();
  }
  reserve(generation: number): void {
    check(this.waits.has(generation), 'cannot reserve a missing wait');
    this.reservations.set(generation, this.tick()); this.priorities.refresh();
  }
  isSatisfied(pid: Pid, reason: BlockReason, tid?: Tid): boolean {
    if (this.lastInversionTick !== this.tick()) { this.lastInversionTick = this.tick(); this.priorities.detect(); }
    if (tid === undefined) return false;
    return this.allWaits().some(wait => wait.actor.pid === pid && wait.actor.tid === tid && this.reserved(wait.generation)
      && JSON.stringify(this.reason(wait)) === JSON.stringify(reason));
  }
  enter(actor: Actor, resource: ResourceId): void { this.requirements.enter(actor, resource); }
  leave(actor: Actor, resource: ResourceId): void { this.requirements.leave(actor, resource); this.priorities.refresh(); }
  flush(pid: Pid): void { this.memoryOrder.fence(pid); }
  configureRequirement(resource: ResourceId, capacity: number, mode: 'enforce' | 'observe' = 'enforce'): void {
    this.requirements.configure(resource, capacity, mode);
  }
  set(state: PrimitiveState): void {
    const old = this.states.get(state.id);
    this.states.set(state.id, state);
    if (state.kind === 'semaphore') {
      const previous = new Set(old?.kind === 'semaphore' ? old.debits.map(debit => debit.id) : []);
      for (const debit of state.debits) {
        if (debit.actor === null || previous.has(debit.id)) continue;
        for (const scenario of this.scenarios.values()) {
          if (scenario.kind !== 'bounded_buffer') continue;
          const role = state.id === scenario.empty ? 'producer' : state.id === scenario.full ? 'consumer' : null;
          if (role === null || !scenario.actors.some(row => sameActor(row.actor, debit.actor) && row.role === role)) continue;
          this.setScenario({ ...scenario, inFlight: scenario.inFlight + 1,
            reservations: [...scenario.reservations, { permitId: debit.id, actor: debit.actor, role, itemApplied: false }] });
        }
      }
    }
    this.publishViews();
  }
  private owners(state: PrimitiveState): readonly Actor[] {
    switch (state.kind) {
      case 'mutex': case 'monitor': return state.owner === null ? [] : [state.owner];
      case 'semaphore': return state.debits.flatMap(debit => debit.actor === null ? [] : [debit.actor]);
      case 'rwlock': return state.writer === null ? state.readers : [state.writer];
      case 'barrier': return state.arrivals.flatMap(generation => { const wait = this.wait(generation); return wait === undefined ? [] : [wait.actor]; });
    }
  }
  private queue(state: PrimitiveState): readonly number[] {
    switch (state.kind) {
      case 'mutex': return state.entryQueue;
      case 'monitor': return [...state.entryQueue, ...state.conditions.flatMap(condition => condition.waitQueue)];
      case 'semaphore': case 'rwlock': return state.waitQueue;
      case 'barrier': return state.arrivals;
    }
  }
  private view(state: PrimitiveState): SyncPrimitive {
    const value = state.kind === 'semaphore' ? semaphoreValue(state)
      : state.kind === 'rwlock' ? state.writer === null ? state.readers.length : -1 : state.kind === 'barrier' ? state.arrivals.length : state.owner === null ? 1 : 0;
    const base: SyncPrimitive = { id: state.id, kind: state.kind, displayName: state.displayName, capacity: state.capacity, ordered: state.ordered, value,
      holders: this.owners(state).map(actor => actor.pid).sort((a, b) => a - b),
      waitQueue: (state.kind === 'monitor' ? state.entryQueue : this.queue(state)).flatMap(id => { const wait = this.wait(id); return wait === undefined ? [] : [wait.actor.pid]; }) };
    return state.kind === 'monitor' ? monitorView(base, state, this) : base;
  }
  private publishViews(): void {
    const prior = new Map(this.primitives.map(view => [view.id, view]));
    this.primitives.splice(0, this.primitives.length, ...this.allPrimitives().map(state => {
      const next = this.view(state); const old = prior.get(state.id);
      if (old === undefined || old.kind !== next.kind || old.capacity !== next.capacity || old.ordered !== next.ordered || old.displayName !== next.displayName) return next;
      if (state.kind === 'monitor' && !refreshMonitorView(old, state, this)) return next;
      old.value = next.value; old.holders.splice(0, old.holders.length, ...next.holders); old.waitQueue.splice(0, old.waitQueue.length, ...next.waitQueue); return old;
    }));
    const ownedIds = new Set([...this.states.keys(), ...prior.keys()]);
    for (const pcb of this.host.processes()) {
      const held = this.primitives.flatMap(view => view.holders.filter(pid => pid === pcb.pid).map(() => view.id));
      pcb.heldResources.splice(0, pcb.heldResources.length, ...pcb.heldResources.filter(id => !ownedIds.has(id)), ...held);
    }
  }
  private add(state: PrimitiveState): SyncPrimitive {
    check(!this.states.has(state.id), 'duplicate primitive'); this.set(state);
    this.configureRequirement(state.id, state.capacity);
    const view = this.primitives.find(item => item.id === state.id); check(view !== undefined, 'missing primitive view'); return view;
  }
  createMutex(id: ResourceId): SyncPrimitive { return this.add(createMutex(id)); }
  createSemaphore(id: ResourceId, capacity: number, initialValue = capacity, ordered = true): SyncPrimitive {
    return this.add(createSemaphore(this, id, capacity, initialValue, ordered));
  }
  createMonitor(id: ResourceId, conditions: string[] = [], discipline: 'signal_and_continue' | 'signal_and_wait' = 'signal_and_continue'): SyncPrimitive {
    return this.add(createMonitor(id, conditions, discipline));
  }
  createRwlock(id: ResourceId, capacity: number, policy = this.settings().rwlockPolicy): SyncPrimitive { return this.add(createRwlock(id, capacity, policy)); }
  createBarrier(id: ResourceId, capacity: number): SyncPrimitive { return this.add(createBarrier(id, capacity)); }
  createAtomicLock(resource: ResourceId, algorithm: 'tas' | 'cas_bounded', contenders: readonly Actor[], lockCell: string): void {
    this.atomics.create(resource, lockCell, algorithm, contenders); this.configureRequirement(resource, 1);
  }
  addControlCell(id: string, value: number): void { this.memoryOrder.register({ id, kind: 'control', value }); }
  addRegionCell(id: string, region: ResourceId): void { this.memoryOrder.register({ id, kind: 'region', region }); }
  setMemoryOrder(pid: Pid, reordering: boolean, depth = this.settings().storeBufferDepth): void { this.memoryOrder.configure(pid, { reordering, depth }); }
  addScenario(state: SyncSnapshotScenario): void { check(!this.scenarios.has(state.id), 'duplicate scenario'); this.setScenario(state); }
  scenario(id: string): SyncSnapshotScenario { const state = this.scenarios.get(id); check(state !== undefined, 'unknown scenario'); return state; }
  setScenario(state: SyncSnapshotScenario): void { this.scenarios.set(state.id, state); }
  registerActor(actor: Actor, scenario: string | null = null): void {
    check(!this.executions.has(actorKey(actor)), 'duplicate execution actor');
    this.executions.set(actorKey(actor), { actor: { ...actor }, scenario, registers: [], remainingWork: null, spin: null });
  }
  private execution(actor: Actor): SyncSnapshotExecution {
    if (!this.executions.has(actorKey(actor))) this.registerActor(actor);
    const state = this.executions.get(actorKey(actor)); check(state !== undefined, 'missing execution actor'); return state;
  }
  register(actor: Actor, name: string): number { return this.execution(actor).registers.find(([key]) => key === name)?.[1] ?? 0; }
  setRegister(actor: Actor, name: string, value: number): void {
    check(Number.isSafeInteger(value), 'register is not a safe integer');
    const state = this.execution(actor); const registers = new Map(state.registers); registers.set(name, value);
    this.executions.set(actorKey(actor), { ...state, registers: [...registers].sort(([a], [b]) => compareStrings(a, b)) });
  }
  work(actor: Actor, ticks: number | (() => number)): AttemptResult {
    const state = this.execution(actor); const remaining = state.remainingWork ?? (typeof ticks === 'number' ? ticks : ticks());
    check(integer(remaining), 'work duration');
    if (remaining === 0) return RETIRE;
    this.executions.set(actorKey(actor), { ...state, remainingWork: remaining === 1 ? null : remaining - 1 });
    return remaining === 1 ? RETIRE : WORKING;
  }
  spin(actor: Actor, resource: ResourceId): AttemptResult {
    const state = this.execution(actor); const elapsed = (state.spin?.resource === resource ? state.spin.elapsedTicks : 0) + 1;
    const total = (this.spins.get(actor.pid) ?? 0) + 1; this.spins.set(actor.pid, total);
    const finished = elapsed === this.settings().spinWaitTicks;
    this.executions.set(actorKey(actor), { ...state, spin: finished ? null : { resource, elapsedTicks: elapsed } });
    if (finished) this.emit({ type: 'sync.busy_wait', pid: actor.pid, resource, spunTicks: total });
    return RETRY;
  }
  load(actor: Actor, cell: string, rmw = false): number { return this.memoryOrder.load(actor, cell, rmw); }
  store(actor: Actor, cell: string, value: number, rmw = false): boolean { return this.memoryOrder.store(actor, cell, value, rmw); }
  atomicAcquire(actor: Actor, resource: ResourceId): boolean {
    return this.executions.get(actorKey(actor))?.spin !== null && this.executions.get(actorKey(actor))?.spin !== undefined
      ? false : this.atomics.acquire(actor, resource);
  }
  atomicRelease(actor: Actor, resource: ResourceId): void { this.atomics.release(actor, resource); }
  held(actor: Actor): readonly ResourceId[] {
    const held = this.allPrimitives().filter(state => {
      if (state.kind === 'barrier' || (state.kind === 'semaphore' && state.capacity !== 1)) return false;
      return this.owners(state).some(owner => sameActor(owner, actor));
    }).map(state => state.id);
    for (const row of this.requirements.saveState()) {
      if (row.capacity === 1 && row.criticalActors.length <= 1 && row.criticalActors.some(item => sameActor(item, actor))) held.push(row.resource);
    }
    return [...new Set([...held, ...this.atomics.held(actor)])].sort(compareStrings);
  }
  call(actor: Actor, instruction: SyncInstruction): SyscallResult {
    const state = 'resource' in instruction ? this.get(instruction.resource) : 'monitor' in instruction ? this.get(instruction.monitor) : undefined;
    switch (instruction.op) {
      case 'mutex_lock': case 'mutex_unlock': return state?.kind === 'mutex' ? mutexOperation(this, state, actor, instruction.op) : invalid('unknown mutex');
      case 'sem_wait': case 'sem_post': return state?.kind === 'semaphore' ? semaphoreOperation(this, state, actor, instruction.op) : invalid('unknown semaphore');
      case 'monitor_enter': case 'monitor_exit': case 'cond_wait': case 'cond_signal': case 'cond_broadcast':
        return state?.kind === 'monitor' ? monitorOperation(this, state, actor, instruction.op, 'condition' in instruction ? instruction.condition : undefined) : invalid('unknown monitor');
      case 'rw_read_lock': case 'rw_read_unlock': case 'rw_write_lock': case 'rw_write_unlock':
        return state?.kind === 'rwlock' ? rwlockOperation(this, state, actor, instruction.op) : invalid('unknown rwlock');
      case 'barrier_wait': return state?.kind === 'barrier' ? barrierOperation(this, state, actor) : invalid('unknown barrier');
      default: return invalid('not a primitive operation');
    }
  }
  syscall(pid: Pid, op: 'sem_wait' | 'sem_post' | 'mutex_lock' | 'mutex_unlock', resource: ResourceId): SyscallResult {
    const actor = this.host.actor(pid); return actor === undefined ? invalid('no synchronization actor') : this.call(actor, { op, resource });
  }
  acquire(pid: Pid, resource: ResourceId): void {
    const kind = this.get(resource)?.kind;
    if (kind === 'mutex' || kind === 'semaphore') this.syscall(pid, kind === 'mutex' ? 'mutex_lock' : 'sem_wait', resource);
  }
  release(pid: Pid, resource: ResourceId): void {
    const kind = this.get(resource)?.kind;
    if (kind === 'mutex' || kind === 'semaphore') this.syscall(pid, kind === 'mutex' ? 'mutex_unlock' : 'sem_post', resource);
  }
  beginAttempt(actor: Actor): void {
    this.attempting = true;
    for (const wait of this.allWaits()) if (sameActor(wait.actor, actor) && this.reserved(wait.generation)) this.removeWait(wait.generation);
    this.memoryOrder.beginAttempt(actor.pid);
  }
  endAttempt(actor: Actor): void { try { this.memoryOrder.endAttempt(actor.pid); } finally { this.attempting = false; } }
  execute(actor: Actor, instruction: SyncInstruction): AttemptResult {
    const partialSpin = this.executions.get(actorKey(actor))?.spin;
    if (partialSpin !== undefined && partialSpin !== null) return this.spin(actor, partialSpin.resource);
    const value = (operand: SyncValue): number => operand.kind === 'literal' ? operand.value : this.register(actor, operand.name);
    switch (instruction.op) {
      case 'load': this.setRegister(actor, instruction.into, this.load(actor, instruction.cell, instruction.rmw)); return RETIRE;
      case 'store': return this.store(actor, instruction.cell, value(instruction.value), instruction.rmw) ? RETIRE : RETRY;
      case 'set': case 'add': this.setRegister(actor, instruction.into, value(instruction.value) + (instruction.op === 'add' ? this.register(actor, instruction.into) : 0)); return RETIRE;
      case 'branch': {
        const left = value(instruction.left); const right = value(instruction.right);
        const matched = instruction.test === 'eq' ? left === right : instruction.test === 'ne' ? left !== right : instruction.test === 'lt' ? left < right
          : instruction.test === 'le' ? left <= right : instruction.test === 'gt' ? left > right : left >= right;
        return matched ? { advance: false, deferService: false, target: instruction.target } : RETIRE;
      }
      case 'mfence': this.memoryOrder.fence(actor.pid); return RETIRE;
      case 'tas': this.setRegister(actor, instruction.into, this.memoryOrder.tas(actor, instruction.cell)); return RETIRE;
      case 'cas': this.setRegister(actor, instruction.into, this.memoryOrder.cas(actor, instruction.cell, value(instruction.expected), value(instruction.replacement))); return RETIRE;
      case 'work': return this.work(actor, instruction.ticks);
      case 'scenario': {
        const state = this.scenario(instruction.scenario);
        switch (state.kind) {
          case 'bounded_buffer': return executeBoundedBuffer(this, state, actor, instruction.step);
          case 'readers_writers': return executeReadersWriters(this, state, actor, instruction.step);
          case 'philosophers': return executePhilosophers(this, state, actor, instruction.step);
          case 'peterson': return executePeterson(this, state, actor, instruction.step);
          case 'spinlock': return this.executeSpinlock(state, actor, instruction.step);
          case 'counter': return this.executeCounter(state, actor, instruction.step);
          case 'monitor_predicate': return this.executeMonitorPredicate(state, actor, instruction.step);
        }
      }
      default: { const result = this.call(actor, instruction); if (!result.ok) throw new Error(`${result.errno}: ${result.message}`); return RETIRE; }
    }
  }
  /** Four scheduled stages: acquire, critical work, release, remainder. */
  private executeSpinlock(state: Extract<SyncSnapshotScenario, { kind: 'spinlock' }>, actor: Actor, step: number): AttemptResult {
    const row = state.actors.find(item => sameActor(item.actor, actor)); check(row !== undefined && integer(step) && step <= 3, 'spinlock actor/stage');
    if (step === 0) return this.atomicAcquire(actor, state.resource) ? RETIRE : this.spin(actor, state.resource);
    if (step === 1) return this.work(actor, state.criticalTicks);
    if (step === 2) {
      this.atomicRelease(actor, state.resource);
      const completedEntries = row.completedEntries + 1;
      this.setScenario({ ...state, actors: state.actors.map(item => sameActor(item.actor, actor) ? { ...item, completedEntries } : item) });
      if (state.iterationLimit !== null && completedEntries >= state.iterationLimit) this.complete(actor.pid);
      return RETIRE;
    }
    const result = state.remainderTicks === 0 ? RETIRE : this.work(actor, state.remainderTicks);
    return result.advance ? { advance: false, deferService: false, target: 0 } : result;
  }
  /** Five stages preserve load/compute/store interleavings and CAS retry operands. */
  private executeCounter(state: Extract<SyncSnapshotScenario, { kind: 'counter' }>, actor: Actor, step: number): AttemptResult {
    const row = state.actors.find(item => sameActor(item.actor, actor)); check(row !== undefined && integer(step) && step <= 4, 'counter actor/stage');
    if (step === 0) {
      if (state.protection.kind === 'mutex') check(this.call(actor, { op: 'mutex_lock', resource: state.protection.mutex }).ok, 'counter lock');
      return RETIRE;
    }
    if (step === 1) {
      const value = state.protection.kind === 'cas' ? this.memoryOrder.cas(actor, state.cell, 0, 0) : this.load(actor, state.cell, true);
      this.setRegister(actor, 'counter.loaded', value); return RETIRE;
    }
    if (step === 2) return RETIRE;
    if (step === 3) {
      const loaded = this.register(actor, 'counter.loaded');
      if (state.protection.kind === 'cas') {
        const observed = this.memoryOrder.cas(actor, state.cell, loaded, loaded + row.incrementBy);
        if (observed !== loaded) { this.setRegister(actor, 'counter.loaded', observed); return this.spin(actor, state.cell as ResourceId); }
      } else if (!this.store(actor, state.cell, loaded + row.incrementBy, true)) return RETRY;
      return RETIRE;
    }
    if (state.protection.kind === 'mutex') check(this.call(actor, { op: 'mutex_unlock', resource: state.protection.mutex }).ok, 'counter unlock');
    const completedIncrements = row.completedIncrements + 1;
    this.setScenario({ ...state, actors: state.actors.map(item => sameActor(item.actor, actor) ? { ...item, completedIncrements } : item) });
    if (completedIncrements === row.increments) { this.complete(actor.pid); return RETIRE; }
    return { advance: false, deferService: false, target: 0 };
  }
  /** Enter, predicate protocol, guarded body, exit; TCB state carries retries. */
  private executeMonitorPredicate(state: Extract<SyncSnapshotScenario, { kind: 'monitor_predicate' }>, actor: Actor, step: number): AttemptResult {
    const row = state.actors.find(item => sameActor(item.actor, actor)); check(row !== undefined && integer(step) && step <= 3, 'monitor predicate actor/stage');
    if (step === 0) { check(this.call(actor, { op: 'monitor_enter', resource: state.monitor }).ok, 'predicate monitor enter'); return RETIRE; }
    if (step === 1 && row.role === 'waiter' && this.load(actor, state.predicateCell) === 0) {
      check(this.call(actor, { op: 'cond_wait', monitor: state.monitor, condition: state.condition }).ok, 'predicate condition wait');
      return state.check === 'while' ? { advance: false, deferService: false, target: 1 } : RETIRE;
    }
    if (step === 2) {
      if (row.role === 'waiter') {
        const success = this.load(actor, state.predicateCell) !== 0;
        this.setScenario({ ...state, successfulEntries: state.successfulEntries + (success ? 1 : 0), falsePredicateEntries: state.falsePredicateEntries + (success ? 0 : 1) });
        if (success) this.store(actor, state.predicateCell, 0);
      } else {
        if (!this.store(actor, state.predicateCell, row.role === 'signaller' ? 1 : 0)) return RETRY;
        if (row.role === 'signaller') check(this.call(actor, { op: 'cond_signal', monitor: state.monitor, condition: state.condition }).ok, 'predicate signal');
      }
    }
    if (step === 3) { check(this.call(actor, { op: 'monitor_exit', resource: state.monitor }).ok, 'predicate exit'); this.complete(actor.pid); }
    return RETIRE;
  }
  private cancelActor(actor: Actor): void {
    const removed = new Set(this.allWaits().filter(wait => sameActor(wait.actor, actor)).map(wait => wait.generation));
    for (const state of this.allPrimitives()) {
      const keep = (generation: number): boolean => !removed.has(generation);
      switch (state.kind) {
        case 'mutex': this.set({ ...state, entryQueue: state.entryQueue.filter(keep) }); break;
        case 'monitor': this.set({ ...state, entryQueue: state.entryQueue.filter(keep),
          conditions: state.conditions.map(row => ({ ...row, waitQueue: row.waitQueue.filter(keep) })) }); break;
        case 'semaphore': case 'rwlock': this.set({ ...state, waitQueue: state.waitQueue.filter(keep) }); break;
        case 'barrier': this.set({ ...state, arrivals: state.arrivals.filter(keep) }); break;
      }
    }
    for (const generation of removed) this.removeWait(generation);
    this.atomics.cancelWait(actor);
  }
  private cleanupActor(actor: Actor): void {
    this.cancelActor(actor);
    for (const state of this.allPrimitives()) {
      switch (state.kind) {
        case 'mutex': if (sameActor(state.owner, actor)) mutexOperation(this, state, actor, 'mutex_unlock'); break;
        case 'monitor': if (sameActor(state.owner, actor)) monitorOperation(this, state, actor, 'monitor_exit'); break;
        case 'semaphore': anonymizeSemaphoreActor(this, state, actor); break;
        case 'rwlock':
          if (sameActor(state.writer, actor)) rwlockOperation(this, state, actor, 'rw_write_unlock');
          else if (state.readers.some(reader => sameActor(reader, actor))) rwlockOperation(this, state, actor, 'rw_read_unlock');
          else grantRwWaiters(this, state);
          break;
        case 'barrier': break;
      }
    }
    this.atomics.removeActor(actor); this.raceDetector.removeActor(actor);
    for (const row of this.requirements.saveState()) if (row.criticalActors.some(item => sameActor(item, actor))) this.leave(actor, row.resource);
    for (const scenario of this.scenarios.values()) if (scenario.kind === 'bounded_buffer') this.setScenario({ ...scenario,
      reservations: scenario.reservations.map(row => sameActor(row.actor, actor) ? { ...row, actor: null } : row) });
    this.executions.delete(actorKey(actor));
  }
  releaseAll(pcb: ProcessControlBlock): void {
    this.memoryOrder.flush(pcb.pid);
    // Cancel every sibling before any hand-off, while lifecycle still exposes waiting PCBs.
    const actors = new Map<string, Actor>();
    for (const tid of pcb.threads) actors.set(actorKey({ pid: pcb.pid, tid }), { pid: pcb.pid, tid });
    for (const wait of this.allWaits()) if (wait.actor.pid === pcb.pid) actors.set(actorKey(wait.actor), wait.actor);
    for (const actor of actors.values()) this.cancelActor(actor);
    for (const actor of actors.values()) this.cleanupActor(actor);
    this.priorities.cleanup(pcb.pid); this.memoryOrder.removeProcess(pcb.pid);
  }
  removeWaiter(pid: Pid): void {
    for (const wait of this.allWaits()) if (wait.actor.pid === pid) this.cancelActor(wait.actor);
    this.priorities.refresh();
  }
  exec(pid: Pid): void { const pcb = this.process(pid); if (pcb !== undefined) this.releaseAll(pcb); }
  observe(event: KernelEvent): void {
    this.priorities.observe(event);
    if (event.type === 'thread.joined') this.cleanupActor({ pid: event.pid, tid: event.tid });
    if (event.type !== 'process.exited') return;
    for (const state of this.scenarios.values()) {
      if (state.kind === 'readers_writers') this.setScenario({ ...state, actors: state.actors.map(row => row.actor.pid !== event.pid || row.outcome !== 'active' ? row : {
        ...row, outcome: event.reason === 'starvation' ? 'starved' as const : 'cancelled' as const,
        worstWait: Math.max(row.worstWait, row.waitStartedAt === null ? 0 : this.tick() - row.waitStartedAt), waitStartedAt: null,
      }) });
      if (state.kind === 'philosophers') this.setScenario({ ...state, actors: state.actors.map(row => row.actor.pid !== event.pid ? row : {
        ...row, worstWait: Math.max(row.worstWait, row.hungrySince === null ? 0 : this.tick() - row.hungrySince), hungrySince: null,
      }) });
    }
  }
  expireTimers(tick: Tick): void {
    if (this.lastTimerTick === tick) return;
    this.lastTimerTick = tick; this.requirements.timers();
  }
  beforeAging(): void { this.priorities.beforeAging(); }
  afterAging(): void { this.priorities.afterAging(); }
  withEffectivePriorities(callback: () => void): void { this.priorities.withEffectivePriorities(callback); }
  saveState(): { readonly sync: SyncSnapshotState } {
    check(!this.attempting, 'snapshot during an instruction attempt');
    const priorities = this.priorities.saveState();
    const sync: SyncSnapshotState = { owner: 'sync', version: 1, payload: {
      tick: this.tick(), settings: { ...this.settings() }, nextWaitGeneration: this.nextGeneration, nextPermitId: this.nextPermitId,
      lastTimerTick: this.lastTimerTick, lastInversionTick: this.lastInversionTick,
      primitives: this.allPrimitives(), waits: this.allWaits(),
      reservations: [...this.reservations].sort(([a], [b]) => a - b).map(([waitGeneration, grantedAt]) => ({ waitGeneration, grantedAt })),
      requirements: this.requirements.saveState(), ...priorities, memoryOrder: this.memoryOrder.save(), raceDetector: this.raceDetector.save(),
      atomicLocks: this.atomics.save(), spinTicks: [...this.spins].sort(([a], [b]) => a - b),
      actors: [...this.executions.values()].sort((a, b) => compareActors(a.actor, b.actor)),
      scenarios: [...this.scenarios.values()].sort((a, b) => compareStrings(a.id, b.id)),
    } };
    assertPlainData(sync);
    return { sync: freezeData(structuredClone(sync)) };
  }
  private hostAt(tick: Tick): SyncHost {
    return { tick: () => tick, process: pid => this.host.process(pid), processes: () => this.host.processes(),
      thread: tid => this.host.thread(tid), actor: pid => this.host.actor(pid), block: (pid, reason, tid) => this.host.block(pid, reason, tid),
      emit: event => this.host.emit(event), terminate: pid => this.host.terminate(pid), complete: pid => this.host.complete(pid),
      settings: () => this.host.settings(), cell: binding => this.host.cell(binding), originalWait: actor => this.host.originalWait?.(actor) };
  }
  prepareKernelRestore(snapshot: KernelSnapshot): () => void {
    const saved = snapshot.subsystems?.sync;
    if (saved === undefined) {
      check(snapshot.syncPrimitives.length === 0, 'missing sync contribution with primitives');
      const empty = new SyncSubsystem(this.hostAt(snapshot.tick), this.rng).saveState().sync;
      // Legacy init-only saves have no sync work; reconstruct the timer visit only.
      const lastTimerTick = snapshot.tick > 0 && snapshot.config.enabledSubsystems.includes('sync') ? snapshot.tick : null;
      return this.prepareRestore({ ...empty, payload: { ...empty.payload, lastTimerTick } }, snapshot.tick);
    }
    const prepare = this.prepareRestore(saved, snapshot.tick);
    const waits = new Map(saved.payload.waits.map(wait => [wait.generation, wait]));
    const candidate = new SyncSubsystem(this.host, this.rng);
    for (const [key, wait] of waits) candidate.waits.set(key, wait);
    check(saved.payload.primitives.length === snapshot.syncPrimitives.length && saved.payload.primitives.every((state, index) => {
      const actual = candidate.view(state); const expected = snapshot.syncPrimitives[index];
      return expected !== undefined && actual.id === expected.id && actual.kind === expected.kind && actual.displayName === expected.displayName
        && actual.value === expected.value && actual.capacity === expected.capacity && actual.ordered === expected.ordered
        && JSON.stringify(actual.holders) === JSON.stringify(expected.holders) && JSON.stringify(actual.waitQueue) === JSON.stringify(expected.waitQueue);
    }), 'shared primitive projection disagrees with sync payload');
    return prepare;
  }
  /** Validate all contributions off to the side before returning a mutation. */
  prepareRestore(saved: SyncSnapshotState, tick: Tick = this.tick()): () => void {
    check(!this.attempting, 'restore during an instruction attempt');
    assertPlainData(saved);
    check(saved.owner === 'sync' && saved.version === 1, 'unsupported sync snapshot');
    check(saved.payload.tick === tick && integer(tick), 'sync snapshot clock');
    check(JSON.stringify(saved.payload.settings) === JSON.stringify(this.settings()), 'sync tuning mismatch');
    const copy = structuredClone(saved);
    const candidate = new SyncSubsystem(this.hostAt(tick), this.rng);
    candidate.install(copy);
    candidate.validate(copy);
    return () => { this.install(copy); this.publishViews(); this.priorities.refresh(); };
  }
  private install(saved: SyncSnapshotState): void {
    const p = saved.payload;
    this.states.clear(); for (const row of p.primitives) this.states.set(row.id, structuredClone(row));
    this.waits.clear(); for (const row of p.waits) this.waits.set(row.generation, structuredClone(row));
    this.reservations.clear(); for (const row of p.reservations) this.reservations.set(row.waitGeneration, row.grantedAt);
    this.executions.clear(); for (const row of p.actors) this.executions.set(actorKey(row.actor), structuredClone(row));
    this.scenarios.clear(); for (const row of p.scenarios) this.scenarios.set(row.id, structuredClone(row));
    this.spins.clear(); for (const [pid, ticks] of p.spinTicks) this.spins.set(pid, ticks);
    this.nextGeneration = p.nextWaitGeneration; this.nextPermitId = p.nextPermitId;
    this.lastTimerTick = p.lastTimerTick; this.lastInversionTick = p.lastInversionTick;
    this.requirements.restoreState(p.requirements, p.tick, p.lastTimerTick);
    this.priorities.restoreState({ priorities: p.priorities, inversions: p.inversions }, p.tick);
    const memory = this.memoryOrder.prepareRestore(p.memoryOrder, p.tick);
    const races = this.raceDetector.prepareRestore(p.raceDetector, p.memoryOrder, p.tick);
    const atomics = this.atomics.prepareRestore(p.atomicLocks, p.memoryOrder, p.tick, p.waits);
    memory(); races(); atomics();
  }
  private validate(saved: SyncSnapshotState): void {
    const p = saved.payload;
    const liveActor = (actor: Actor): void => {
      const pcb = this.process(actor.pid); const thread = this.host.thread(actor.tid);
      check(integer(actor.pid, 2) && integer(actor.tid) && pcb !== undefined && pcb.threads.includes(actor.tid)
        && thread?.pid === actor.pid && thread.state !== 'terminated' && pcb.state !== 'zombie' && pcb.state !== 'terminated', 'non-live actor');
    };
    const historicalActor = (actor: Actor): void => { check(integer(actor.pid, 2) && integer(actor.tid), 'historical actor identity'); };
    const unique = <T>(rows: readonly T[], key: (row: T) => string | number, label: string): void => {
      check(new Set(rows.map(key)).size === rows.length, `duplicate ${label}`);
    };
    check(integer(p.nextWaitGeneration) && integer(p.nextPermitId), 'allocator counters');
    for (const clock of [p.lastTimerTick, p.lastInversionTick]) check(clock === null || (integer(clock) && clock <= p.tick), 'sync timer clock');
    unique(p.primitives, row => row.id, 'primitive'); unique(p.waits, row => row.generation, 'wait');
    unique(p.waits, row => actorKey(row.actor), 'actor wait'); unique(p.reservations, row => row.waitGeneration, 'reservation');
    unique(p.actors, row => actorKey(row.actor), 'execution'); unique(p.scenarios, row => row.id, 'scenario'); unique(p.spinTicks, row => row[0], 'spin total');
    const queued = new Set<number>(); const permits = new Set<number>();
    for (const state of p.primitives) {
      check(typeof state.id === 'string' && state.id.length > 0 && typeof state.displayName === 'string' && integer(state.capacity, 1) && typeof state.ordered === 'boolean', 'primitive header');
      for (const actor of this.owners(state)) liveActor(actor);
      for (const generation of this.queue(state)) { check(!queued.has(generation), 'wait queued more than once'); queued.add(generation); }
      switch (state.kind) {
        case 'mutex': validateMutex(state, this); break;
        case 'semaphore':
          validateSemaphore(state, this);
          for (const debit of state.debits) { check(!permits.has(debit.id) && debit.id < p.nextPermitId, 'permit allocator/reference'); permits.add(debit.id); }
          break;
        case 'monitor': validateMonitor(state, this); break;
        case 'rwlock': validateRwlock(state, this); break;
        case 'barrier': validateBarrier(state, this); break;
        default: throw new Error('invalid sync primitive kind');
      }
    }
    for (const wait of p.waits) {
      liveActor(wait.actor);
      check(integer(wait.generation) && wait.generation < p.nextWaitGeneration && integer(wait.requestedAt) && wait.requestedAt <= p.tick && integer(wait.entriesObserved), 'wait counters');
      check([wait.boundedWarningEmitted, wait.starvationWarningEmitted, wait.starvationFatalEmitted].every(flag => typeof flag === 'boolean'), 'wait flags');
      check(wait.operation.kind === 'spin' || queued.has(wait.generation) !== this.reserved(wait.generation), 'wait must be queued or reserved');
      if (wait.operation.kind !== 'spin' && !this.reserved(wait.generation)) {
        const thread = this.host.thread(wait.actor.tid);
        check(thread?.state === 'waiting' && JSON.stringify(this.host.originalWait?.(wait.actor) ?? thread.blockedOn) === JSON.stringify(this.reason(wait)), 'blocked actor reason');
      }
    }
    for (const row of p.reservations) {
      const wait = this.wait(row.waitGeneration);
      check(wait !== undefined && integer(row.grantedAt) && row.grantedAt >= wait.requestedAt && row.grantedAt <= p.tick, 'reservation reference or clock');
      const primitive = this.get(wait.resource); check(primitive !== undefined, 'reservation primitive');
      if (wait.operation.kind === 'barrier') check(primitive.kind === 'barrier' && wait.operation.barrierGeneration < primitive.generation, 'barrier reservation generation');
      else check(this.owners(primitive).some(actor => sameActor(actor, wait.actor)), 'reservation lacks granted ownership');
    }
    for (const primitive of p.primitives) if (primitive.kind !== 'barrier') {
      const record = p.requirements.find(row => row.resource === primitive.id);
      check(record !== undefined && record.capacity === primitive.capacity && record.mode === 'enforce'
        && JSON.stringify([...record.criticalActors].sort(compareActors)) === JSON.stringify([...this.owners(primitive)].sort(compareActors)), 'primitive requirement projection');
    }
    for (const lock of p.atomicLocks) {
      if (lock.owner !== null) liveActor(lock.owner);
      for (const contender of lock.contenders) liveActor(contender.actor);
      const record = p.requirements.find(row => row.resource === lock.resource);
      check(record !== undefined && record.capacity === 1 && record.mode === 'enforce'
        && JSON.stringify(record.criticalActors) === JSON.stringify(lock.owner === null ? [] : [lock.owner]), 'atomic requirement projection');
    }
    for (const race of p.raceDetector.cells) for (const pending of race.pending) if (pending.writeId === null) liveActor(pending.load.actor);
    for (const row of p.actors) {
      liveActor(row.actor); check(row.scenario === null || this.scenarios.has(row.scenario), 'execution scenario');
      unique(row.registers, value => value[0], 'register');
      check(row.registers.every(([key, value]) => typeof key === 'string' && Number.isSafeInteger(value)), 'execution register');
      check(row.remainingWork === null || integer(row.remainingWork, 1), 'remaining useful work');
      check(row.spin === null || (integer(row.spin.elapsedTicks, 1) && row.spin.elapsedTicks < p.settings.spinWaitTicks), 'partial spin');
    }
    for (const [pid, ticks] of p.spinTicks) check(integer(pid, 2) && integer(ticks), 'spin total');
    for (const state of p.scenarios) {
      check(typeof state.id === 'string' && state.id.length > 0, 'scenario ID');
      const scenarioActors = state.actors.map(row => 'actor' in row ? row.actor : row);
      unique(scenarioActors, actorKey, 'scenario actor');
      for (const actor of scenarioActors) historicalActor(actor);
      this.validateScenario(state, p);
    }
  }
  private validateScenario(state: SyncSnapshotScenario, p: SyncSnapshotState['payload']): void {
    const cell = (id: string): void => { check(p.memoryOrder.cells.some(row => row.id === id), 'scenario cell binding'); };
    const primitive = (id: ResourceId, kind: PrimitiveState['kind']): void => { check(this.get(id)?.kind === kind, 'scenario primitive binding'); };
    switch (state.kind) {
      case 'bounded_buffer': {
        check(['correct', 'wrong_order', 'unbalanced'].includes(state.variant), 'buffer variant');
        primitive(state.mutex, 'semaphore'); primitive(state.empty, 'semaphore'); primitive(state.full, 'semaphore'); cell(state.cell);
        const empty = this.get(state.empty); const full = this.get(state.full);
        check(empty?.kind === 'semaphore' && full?.kind === 'semaphore', 'buffer semaphores');
        check(integer(state.capacity, 1) && empty.capacity === state.capacity && full.capacity === state.capacity && state.items.length <= state.capacity, 'buffer capacity');
        check([state.produced, state.consumed, state.inFlight].every(value => integer(value)) && state.produced - state.consumed === state.items.length, 'buffer counters');
        check(state.reservations.length === state.inFlight && Math.max(semaphoreValue(empty), 0) + Math.max(semaphoreValue(full), 0) + state.inFlight === state.capacity, 'buffer conservation');
        check(new Set(state.reservations.map(row => row.permitId)).size === state.reservations.length, 'buffer reservation IDs');
        for (const row of state.reservations) check(integer(row.permitId) && row.permitId < p.nextPermitId && typeof row.itemApplied === 'boolean'
          && (row.role === 'producer' || row.role === 'consumer') && (row.actor === null || state.actors.some(item => sameActor(item.actor, row.actor) && item.role === row.role)), 'buffer reservation');
        for (const row of state.actors) check(integer(row.targetItems, 1) && integer(row.workTicks, 1) && integer(row.completedItems) && row.completedItems <= row.targetItems, 'buffer actor counters');
        break;
      }
      case 'readers_writers':
        check(['reader_pref', 'writer_pref', 'fair'].includes(state.policy), 'reader/writer policy');
        cell(state.cell);
        if (state.bindings.kind === 'rwlock') primitive(state.bindings.rwlock, 'rwlock');
        else { primitive(state.bindings.mutex, 'semaphore'); primitive(state.bindings.rwMutex, 'semaphore'); cell(state.bindings.readCountCell); }
        for (const row of state.actors) check(integer(row.workTicks, 1) && integer(row.completedOperations) && integer(row.worstWait) && ['reader', 'writer'].includes(row.role) && ['active', 'completed', 'starved', 'cancelled'].includes(row.outcome)
          && (row.iterationLimit === null || integer(row.iterationLimit, 1)) && (row.waitStartedAt === null || integer(row.waitStartedAt) && row.waitStartedAt <= p.tick), 'reader/writer clocks');
        break;
      case 'philosophers':
        check(state.actors.length === 5 && ['naive', 'asymmetric', 'room', 'monitor'].includes(state.solution), 'philosopher count/solution'); primitive(state.rendezvous, 'barrier');
        if (state.bindings.kind === 'monitor') primitive(state.bindings.monitor, 'monitor');
        else { for (const id of state.bindings.chopsticks) primitive(id, 'semaphore'); if (state.bindings.room !== null) primitive(state.bindings.room, 'semaphore'); }
        for (const row of state.actors) check(integer(row.meals) && ['thinking', 'hungry', 'eating'].includes(row.state) && integer(row.worstWait) && (row.hungrySince === null || integer(row.hungrySince) && row.hungrySince <= p.tick), 'philosopher clocks');
        break;
      case 'peterson':
        check(state.actors.length === 2 && state.entries.length === 2 && state.flagCells.length === 2 && typeof state.fenced === 'boolean' && state.entries.every(value => integer(value)), 'Peterson actors/counters');
        for (const id of [...state.flagCells, state.turnCell, state.counterCell]) cell(id);
        check(p.requirements.some(row => row.resource === state.requirement && row.capacity === 1 && row.mode === 'observe'), 'Peterson observation requirement'); break;
      case 'counter':
        cell(state.cell); check(['unprotected', 'cas', 'mutex'].includes(state.protection.kind), 'counter protection');
        if (state.protection.kind === 'mutex') primitive(state.protection.mutex, 'mutex');
        for (const row of state.actors) check(integer(row.increments, 1) && Number.isSafeInteger(row.incrementBy) && integer(row.completedIncrements) && row.completedIncrements <= row.increments, 'counter progress'); break;
      case 'spinlock':
        check(p.atomicLocks.some(row => row.resource === state.resource), 'spinlock scenario resource');
        check(integer(state.criticalTicks, 1) && integer(state.remainderTicks) && (state.iterationLimit === null || integer(state.iterationLimit, 1)), 'spinlock durations');
        for (const row of state.actors) check(integer(row.completedEntries) && (state.iterationLimit === null || row.completedEntries <= state.iterationLimit), 'spinlock progress'); break;
      case 'monitor_predicate':
        primitive(state.monitor, 'monitor'); cell(state.predicateCell);
        check(['while', 'if'].includes(state.check) && integer(state.successfulEntries) && integer(state.falsePredicateEntries), 'monitor predicate counters');
        { const monitor = this.get(state.monitor); check(monitor?.kind === 'monitor' && monitor.conditions.some(row => row.name === state.condition), 'predicate condition'); }
        for (const row of state.actors) check(['waiter', 'signaller', 'barger'].includes(row.role), 'predicate role'); break;
      default: throw new Error('invalid sync scenario kind');
    }
  }
}

function freezeData<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

/** Snapshot inputs must be portable JSON data even when called directly from JS. */
function assertPlainData(value: unknown, active = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { check(Number.isFinite(value), 'non-finite snapshot number'); return; }
  check(typeof value === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null), 'snapshot contains non-JSON data');
  check(!active.has(value), 'cyclic snapshot'); active.add(value);
  for (const child of Object.values(value)) assertPlainData(child, active);
  active.delete(value);
}

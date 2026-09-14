import { KernelInvariantError } from '../errors';
import type { ResourceId, SyncSnapshotState, Tick } from '../types';
import { actorKey, check, compareStrings, integer, sameActor, type Actor, type RequirementContext } from './SyncSubsystem';

type Requirement = SyncSnapshotState['payload']['requirements'][number];

/** Critical-section checks and blocked-wait clocks belong to sync, not ready aging. */
export class Requirements {
  private records = new Map<ResourceId, Requirement>();
  private lastTimerTick: Tick | null = null;

  constructor(private readonly ctx: RequirementContext) {}

  configure(resource: ResourceId, capacity: number, mode: Requirement['mode'] = 'enforce'): void {
    if (!integer(capacity, 1)) throw new RangeError('invalid critical-section capacity');
    const previous = this.records.get(resource);
    check(mode === 'observe' || (previous?.criticalActors.length ?? 0) <= capacity, 'critical-section capacity shrank below occupancy');
    this.records.set(resource, previous === undefined
      ? { resource, capacity, mode, criticalActors: [], mutualExclusionViolations: 0, progressFreeSince: null, progressReported: false }
      : { ...previous, capacity, mode });
  }

  enter(actor: Actor, resource: ResourceId): void {
    if (!this.records.has(resource)) this.configure(resource, this.ctx.get(resource)?.capacity ?? 1);
    const current = this.records.get(resource); check(current !== undefined, 'missing requirement record');
    const criticalActors = [...current.criticalActors, { ...actor }];
    const violation = criticalActors.length > current.capacity;
    const next = { ...current, criticalActors, progressFreeSince: null, progressReported: false,
      mutualExclusionViolations: current.mutualExclusionViolations + (violation ? 1 : 0) };
    this.records.set(resource, next);
    if (violation && next.mode === 'enforce') {
      this.ctx.emit({ type: 'kernel.panic', message: `I-21: mutual exclusion violated on ${resource}` });
      throw new KernelInvariantError(21, `mutual exclusion violated on ${resource}`);
    }
    this.boundedWait(resource, actor);
  }

  leave(actor: Actor, resource: ResourceId): void {
    const current = this.records.get(resource);
    if (current === undefined) return;
    const index = current.criticalActors.findIndex(holder => sameActor(holder, actor));
    if (index >= 0) this.records.set(resource, { ...current,
      criticalActors: current.criticalActors.filter((_, position) => position !== index) });
  }

  removeActor(actor: Actor): void {
    for (const [resource, current] of this.records) this.records.set(resource, { ...current,
      criticalActors: current.criticalActors.filter(holder => !sameActor(holder, actor)) });
  }

  boundedWait(resource: ResourceId, entering: Actor): void {
    const waits = this.ctx.allWaits().filter(wait => wait.resource === resource && !this.ctx.reserved(wait.generation));
    const contenders = new Set([entering, ...(this.records.get(resource)?.criticalActors ?? []), ...waits.map(wait => wait.actor)].map(actorKey));
    const configured = this.ctx.settings().boundedWaitLimit;
    const limit = configured === 0 ? contenders.size : configured;
    for (const wait of [...waits].sort((a, b) => a.generation - b.generation)) {
      if (sameActor(wait.actor, entering)) continue;
      const entriesObserved = wait.entriesObserved + 1;
      const report = entriesObserved > limit && !wait.boundedWarningEmitted;
      this.ctx.updateWait({ ...wait, entriesObserved, boundedWarningEmitted: wait.boundedWarningEmitted || report });
      if (report) this.ctx.emit({ type: 'process.starving', pid: wait.actor.pid,
        waitedTicks: Math.max(0, this.ctx.tick() - wait.requestedAt), fatal: false });
    }
  }

  timers(tick: Tick = this.ctx.tick()): void {
    if (this.lastTimerTick === tick) return;
    this.lastTimerTick = tick;
    for (const [resource, current] of [...this.records].sort(([a], [b]) => compareStrings(a, b))) {
      const primitive = this.ctx.get(resource);
      const waiting = primitive?.kind === 'monitor' ? primitive.entryQueue.length > 0
        : this.ctx.allWaits().some(wait => wait.resource === resource && !this.ctx.reserved(wait.generation));
      const available = primitive?.kind === 'semaphore' ? primitive.debits.length < primitive.capacity
        : primitive?.kind === 'barrier' ? false : primitive?.kind === 'mutex' || primitive?.kind === 'monitor'
          ? primitive.owner === null : primitive?.kind === 'rwlock' ? primitive.writer === null && primitive.readers.length === 0
            : current.criticalActors.length === 0;
      if (!available || !waiting) {
        this.records.set(resource, { ...current, progressFreeSince: null, progressReported: false }); continue;
      }
      const progressFreeSince = current.progressFreeSince ?? tick;
      const report = !current.progressReported && tick - progressFreeSince + 1 >= this.ctx.settings().progressStallLimit;
      this.records.set(resource, { ...current, progressFreeSince, progressReported: current.progressReported || report });
      if (report) this.ctx.emit({ type: 'kernel.panic', message: `progress violated on ${resource}` });
    }
    const ordered = [...this.ctx.allWaits()].sort((a, b) => a.actor.pid - b.actor.pid || a.actor.tid - b.actor.tid || a.generation - b.generation);
    for (const saved of ordered) {
      const wait = this.ctx.wait(saved.generation);
      if (wait === undefined || wait.operation.kind === 'spin' || this.ctx.reserved(wait.generation)) continue;
      const pcb = this.ctx.process(wait.actor.pid);
      if (pcb === undefined || pcb.state === 'zombie' || pcb.state === 'terminated') continue;
      const waitedTicks = tick - wait.requestedAt;
      const multiplier = pcb.convoyMemberId === 'sable' ? 3 : 1;
      const warning = this.ctx.settings().starvationThreshold * multiplier;
      const fatal = this.ctx.settings().starvationFatalThreshold * multiplier;
      let updated = wait;
      if (waitedTicks >= warning && !wait.starvationWarningEmitted) {
        updated = { ...updated, starvationWarningEmitted: true }; this.ctx.updateWait(updated);
        this.ctx.emit({ type: 'process.starving', pid: wait.actor.pid, waitedTicks, fatal: false });
      }
      if (waitedTicks >= fatal && !wait.starvationFatalEmitted && this.ctx.wait(wait.generation) !== undefined) {
        this.ctx.updateWait({ ...updated, starvationFatalEmitted: true });
        this.ctx.emit({ type: 'process.starving', pid: wait.actor.pid, waitedTicks, fatal: true });
        this.ctx.terminate(wait.actor.pid);
      }
    }
  }

  state(resource: ResourceId): Requirement | undefined {
    const value = this.records.get(resource); return value === undefined ? undefined : cloneRequirement(value);
  }

  saveState(): SyncSnapshotState['payload']['requirements'] {
    return [...this.records.values()].sort((a, b) => compareStrings(a.resource, b.resource)).map(cloneRequirement);
  }

  restoreState(records: SyncSnapshotState['payload']['requirements'], tick: Tick = this.ctx.tick(), lastTimerTick: Tick | null = null): void {
    check(lastTimerTick === null || (integer(lastTimerTick) && lastTimerTick <= tick), 'requirement timer clock');
    const next = new Map<ResourceId, Requirement>();
    for (const record of records) {
      check(!next.has(record.resource) && integer(record.capacity, 1) && ['enforce', 'observe'].includes(record.mode), 'requirement configuration');
      check(integer(record.mutualExclusionViolations) && typeof record.progressReported === 'boolean', 'requirement counters');
      check(record.progressFreeSince === null || (integer(record.progressFreeSince) && record.progressFreeSince <= tick), 'requirement progress clock');
      check(!record.progressReported || record.progressFreeSince !== null, 'progress report without an episode');
      check(record.mode === 'observe' || record.criticalActors.length <= record.capacity, 'critical-section exclusion');
      for (const actor of record.criticalActors) {
        const pcb = this.ctx.process(actor.pid);
        check(integer(actor.pid, 2) && integer(actor.tid) && pcb !== undefined && pcb.threads.includes(actor.tid), 'requirement actor');
      }
      next.set(record.resource, cloneRequirement(record));
    }
    this.records = next; this.lastTimerTick = lastTimerTick;
  }
}

function cloneRequirement(record: Requirement): Requirement {
  return { ...record, criticalActors: record.criticalActors.map(actor => ({ ...actor })) };
}

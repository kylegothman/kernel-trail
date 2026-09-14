import type { ResourceId, SyncSnapshotAtomicLock, SyncSnapshotMemoryOrder, SyncSnapshotWait, Tick } from '../types';
import { actorKey, check, compareStrings, integer, sameActor } from './SyncSubsystem';
import type { Actor, PrimitiveContext } from './SyncSubsystem';
import { MemoryOrder } from './memoryOrder';
import { detachSyncData, validateActor } from './raceDetector';

/** Lock protocols built on indivisible memory operations, with virtual spin waits. */
export class Atomics {
  private locks = new Map<ResourceId, SyncSnapshotAtomicLock>();

  constructor(private readonly ctx: PrimitiveContext, private readonly memory: MemoryOrder) {}

  create(resource: ResourceId, lockCell: string, algorithm: 'tas' | 'cas_bounded', contenders: readonly Actor[] = []): void {
    check(typeof resource === 'string' && resource.length > 0 && !this.locks.has(resource), 'atomic lock identity');
    check(algorithm === 'tas' || algorithm === 'cas_bounded', 'atomic lock algorithm');
    check(algorithm !== 'cas_bounded' || contenders.length > 0, 'bounded CAS requires a cyclic roster');
    const keys = new Set<string>();
    for (const actor of contenders) { validateActor(actor); check(!keys.has(actorKey(actor)), 'duplicate atomic contender'); keys.add(actorKey(actor)); }
    if (!this.memory.has(lockCell)) this.memory.register({ id: lockCell, kind: 'control', value: 0 });
    check(this.memory.isControl(lockCell) && this.memory.peek(lockCell) === 0, 'atomic lock control word');
    this.locks.set(resource, { resource, lockCell, algorithm, owner: null, handoff: null,
      contenders: contenders.map(actor => ({ actor: { ...actor }, waiting: false })) });
  }

  has(resource: ResourceId): boolean { return this.locks.has(resource); }

  acquire(actor: Actor, resource: ResourceId): boolean {
    validateActor(actor); let lock = this.require(resource);
    if (sameActor(lock.handoff, actor)) {
      check(sameActor(lock.owner, actor), 'handoff owner mismatch');
      this.locks.set(resource, { ...lock, handoff: null });
      return true;
    }
    check(!sameActor(lock.owner, actor), 'recursive atomic acquisition');
    if (!lock.contenders.some(row => sameActor(row.actor, actor))) {
      check(lock.algorithm === 'tas', 'actor outside bounded CAS roster');
      lock = { ...lock, contenders: [...lock.contenders, { actor: { ...actor }, waiting: false }] };
    }
    const wait = this.spinWait(actor, resource);
    lock = { ...lock, contenders: lock.contenders.map(row => sameActor(row.actor, actor) ? { ...row, waiting: true } : row) };
    this.locks.set(resource, lock);
    const previous = lock.algorithm === 'tas' ? this.memory.tas(actor, lock.lockCell) : this.memory.cas(actor, lock.lockCell, 0, 1);
    if (previous !== 0) return false;
    check(lock.owner === null, 'unlocked control word with an owner');
    this.ctx.removeWait(wait.generation);
    this.locks.set(resource, { ...lock, owner: { ...actor }, handoff: null,
      contenders: lock.contenders.map(row => sameActor(row.actor, actor) ? { ...row, waiting: false } : row) });
    this.ctx.enter(actor, resource);
    return true;
  }

  release(actor: Actor, resource: ResourceId): void {
    const lock = this.require(resource); check(sameActor(lock.owner, actor), 'EPERM: atomic release by non-owner');
    this.memory.flush(actor.pid);
    let next: Actor | null = null;
    if (lock.algorithm === 'cas_bounded') {
      const ownerIndex = lock.contenders.findIndex(row => sameActor(row.actor, actor));
      check(ownerIndex >= 0, 'atomic owner is not enrolled');
      for (let offset = 1; offset < lock.contenders.length; offset += 1) {
        const contender = lock.contenders[(ownerIndex + offset) % lock.contenders.length];
        if (contender?.waiting === true) { next = contender.actor; break; }
      }
    }
    if (next === null) this.memory.atomicStore(actor, lock.lockCell, 0);
    this.locks.set(resource, { ...lock, owner: next, handoff: next,
      contenders: lock.contenders.map(row => sameActor(row.actor, actor) || sameActor(row.actor, next) ? { ...row, waiting: false } : row) });
    this.ctx.leave(actor, resource);
    if (next !== null) {
      const wait = this.ctx.allWaits().find(row => row.resource === resource && row.operation.kind === 'spin' && sameActor(row.actor, next));
      check(wait !== undefined, 'bounded CAS handoff has no waiting actor');
      this.ctx.removeWait(wait.generation);
      this.ctx.enter(next, resource);
    }
  }

  held(actor: Actor): readonly ResourceId[] {
    return [...this.locks.values()].filter(lock => sameActor(lock.owner, actor)).map(lock => lock.resource).sort(compareStrings);
  }

  cancelWait(actor: Actor): void {
    for (const wait of this.ctx.allWaits()) if (wait.operation.kind === 'spin' && sameActor(wait.actor, actor)) this.ctx.removeWait(wait.generation);
    for (const [resource, lock] of this.locks) this.locks.set(resource, { ...lock,
      contenders: lock.contenders.map(row => sameActor(row.actor, actor) ? { ...row, waiting: false } : row) });
  }

  removeActor(actor: Actor): void {
    this.cancelWait(actor);
    for (const resource of [...this.locks.keys()].sort(compareStrings)) {
      const before = this.require(resource);
      if (sameActor(before.owner, actor)) this.release(actor, resource);
      const lock = this.require(resource);
      this.locks.set(resource, { ...lock, contenders: lock.contenders.filter(row => !sameActor(row.actor, actor)) });
    }
  }

  save(): readonly SyncSnapshotAtomicLock[] {
    return detachSyncData([...this.locks.values()].sort((a, b) => compareStrings(a.resource, b.resource)));
  }

  prepareRestore(input: readonly SyncSnapshotAtomicLock[], memory: SyncSnapshotMemoryOrder,
    snapshotTick: Tick = this.ctx.tick(), waits?: readonly SyncSnapshotWait[]): () => void {
    const locks = detachSyncData(input);
    check(Array.isArray(locks) && integer(snapshotTick), 'atomic lock array/clock');
    const cells = new Map(memory.cells.map(cell => [cell.id, cell]));
    const prepared = new Map<ResourceId, SyncSnapshotAtomicLock>();
    let previousResource: string | undefined;
    for (const lock of locks) {
      check(lock !== null && typeof lock === 'object' && typeof lock.resource === 'string' && lock.resource.length > 0
        && (previousResource === undefined || previousResource < lock.resource), 'atomic resource order');
      previousResource = lock.resource;
      check(lock.algorithm === 'tas' || lock.algorithm === 'cas_bounded', 'atomic algorithm');
      const cell = cells.get(lock.lockCell);
      check(cell?.kind === 'control' && (cell.value === 0 || cell.value === 1), 'atomic control word');
      check(Array.isArray(lock.contenders), 'atomic roster');
      const keys = new Set<string>();
      for (const contender of lock.contenders) {
        validateActor(contender.actor);
        check(!keys.has(actorKey(contender.actor)) && typeof contender.waiting === 'boolean', 'atomic contender'); keys.add(actorKey(contender.actor));
        if (waits !== undefined) {
          const matches = waits.filter(wait => wait.resource === lock.resource && wait.operation.kind === 'spin' && sameActor(wait.actor, contender.actor));
          check(matches.length === (contender.waiting ? 1 : 0), 'atomic contender/wait mismatch');
        }
      }
      if (lock.owner !== null) {
        validateActor(lock.owner);
        check(lock.contenders.some((row: SyncSnapshotAtomicLock['contenders'][number]) => sameActor(row.actor, lock.owner) && !row.waiting), 'atomic owner roster');
      }
      check((lock.owner === null ? 0 : 1) === cell.value, 'atomic word/owner mismatch');
      if (lock.handoff !== null) {
        validateActor(lock.handoff); check(lock.algorithm === 'cas_bounded' && sameActor(lock.handoff, lock.owner), 'atomic handoff');
      }
      prepared.set(lock.resource, lock);
    }
    if (waits !== undefined) for (const wait of waits) if (wait.operation.kind === 'spin' && prepared.has(wait.resource)) {
      const lock = prepared.get(wait.resource);
      check(lock !== undefined && lock.contenders.some(row => row.waiting && sameActor(row.actor, wait.actor)), 'orphan atomic spin wait');
    }
    return () => { this.locks = prepared; };
  }

  private require(resource: ResourceId): SyncSnapshotAtomicLock {
    const lock = this.locks.get(resource); check(lock !== undefined, `unknown atomic lock ${resource}`); return lock;
  }

  private spinWait(actor: Actor, resource: ResourceId): SyncSnapshotWait {
    let wait = this.ctx.allWaits().find(row => row.resource === resource && row.operation.kind === 'spin' && sameActor(row.actor, actor));
    if (wait === undefined) { const generation = this.ctx.newWait(actor, resource, { kind: 'spin' }); wait = this.ctx.wait(generation); }
    check(wait !== undefined, 'missing atomic spin wait'); return wait;
  }
}

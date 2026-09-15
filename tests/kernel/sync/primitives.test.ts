import { describe, expect, it } from 'vitest';
import { createRng } from '@kernel/rng';
import { createKernel, type KernelImpl, type KernelOptions } from '@kernel/Kernel';
import { instructionProgram, type Program } from '@kernel/process/Program';
import type { ThreadControlBlock } from '@kernel/process/threads';
import type { EmittableEvent } from '@kernel/EventBus';
import { asResourceId, asTick } from '@kernel/types';
import { KernelInvariantError } from '@kernel/errors';
import type { BlockReason, KernelEvent, Pid, ProcessControlBlock, ResourceId, SyncSnapshotState, SyncSnapshotWait, Tid } from '@kernel/types';
import { createMutex, mutexOperation, validateMutex } from '@kernel/sync/mutex';
import { anonymizeSemaphoreActor, createSemaphore, semaphoreOperation, semaphoreValue, validateSemaphore } from '@kernel/sync/semaphore';
import { createMonitor, monitorOperation, validateMonitor } from '@kernel/sync/monitor';
import { createRwlock, grantRwWaiters, rwlockOperation, validateRwlock } from '@kernel/sync/rwlock';
import { barrierOperation, createBarrier, validateBarrier } from '@kernel/sync/barrier';
import { Requirements } from '@kernel/sync/requirements';
import { PriorityInversion } from '@kernel/sync/priorityInversion';
import { SyncSubsystem, sameActor, type Actor, type AttemptResult, type PrimitiveState, type RequirementContext, type SyncHost, type SyncSettings, type WaitOperation } from '@kernel/sync/SyncSubsystem';
import { createBoundedBuffer } from '@kernel/sync/scenarios/boundedBuffer';
import { unitProcesses } from '../scheduler/workloadRunner';
import { REFERENCE_CONFIG } from '../fixtures/referenceConfig';
import { canonical } from '../canonical';

const resource = asResourceId('test:lock');

/** Models reservation and state ordering without pretending to wake a kernel TCB. */
class Harness implements RequirementContext {
  readonly rng = createRng(0x4b54524c, 'root/sync');
  readonly primitives = new Map<ResourceId, PrimitiveState>();
  readonly waits = new Map<number, SyncSnapshotWait>();
  readonly reservations = new Set<number>();
  readonly blocked = new Set<number>();
  readonly events: EmittableEvent[] = [];
  readonly flushes: Pid[] = [];
  readonly order: string[] = [];
  readonly terminated: Pid[] = [];
  readonly pcbs: ProcessControlBlock[];
  readonly actors: Actor[];
  readonly requirements: Requirements;
  now = asTick(0);
  blockingAllowed = true;
  private nextWait = 0;
  private nextDebit = 0;
  options: SyncSettings = { progressStallLimit: 4, boundedWaitLimit: 0, spinWaitTicks: 1,
    storeBufferDepth: 2, priorityInheritance: false, rwlockPolicy: 'writer_pref',
    starvationThreshold: 120, starvationFatalThreshold: 300 };

  constructor(priorities: readonly number[] = [10, 10, 10, 10, 10, 10, 10, 10]) {
    this.pcbs = unitProcesses(priorities.map((priority, index) => ({ name: `actor${index}`, arrival: 0, burst: 10000, priority })));
    this.actors = this.pcbs.map(pcb => {
      const tid = pcb.threads[0]; if (tid === undefined) throw new Error('missing fixture thread'); return { pid: pcb.pid, tid };
    });
    this.requirements = new Requirements(this);
  }
  actor(index: number): Actor { const actor = this.actors[index]; if (actor === undefined) throw new Error('missing actor'); return actor; }
  pcb(index: number): ProcessControlBlock { const pcb = this.pcbs[index]; if (pcb === undefined) throw new Error('missing pcb'); return pcb; }
  tick() { return this.now; }
  get(id: ResourceId) { return this.primitives.get(id); }
  allPrimitives() { return [...this.primitives.values()]; }
  set(state: PrimitiveState) { this.order.push('set'); this.primitives.set(state.id, state); }
  wait(generation: number) { return this.waits.get(generation); }
  allWaits() { return [...this.waits.values()]; }
  updateWait(wait: SyncSnapshotWait) { this.waits.set(wait.generation, wait); }
  newWait(actor: Actor, id: ResourceId, operation: WaitOperation) {
    const generation = this.nextWait++;
    this.updateWait({ generation, actor, resource: id, operation, requestedAt: this.now, entriesObserved: 0,
      boundedWarningEmitted: false, starvationWarningEmitted: false, starvationFatalEmitted: false });
    return generation;
  }
  canBlock() { return this.blockingAllowed; }
  block(generation: number) {
    this.order.push('block');
    const wait = this.wait(generation); if (wait === undefined) throw new Error('unknown blocked wait');
    this.blocked.add(generation); const pcb = this.process(wait.actor.pid); if (pcb !== undefined) pcb.state = 'waiting';
  }
  reserve(generation: number) { if (!this.waits.has(generation)) throw new Error('unknown reservation'); this.reservations.add(generation); }
  reserved(generation: number) { return this.reservations.has(generation); }
  removeWait(generation: number) { this.waits.delete(generation); this.reservations.delete(generation); this.blocked.delete(generation); }
  nextPermit() { return this.nextDebit++; }
  enter(actor: Actor, id: ResourceId) { this.requirements.enter(actor, id); }
  leave(actor: Actor, id: ResourceId) { this.requirements.leave(actor, id); }
  flush(pid: Pid) { this.order.push('flush'); this.flushes.push(pid); }
  emit(event: EmittableEvent) { this.events.push(event); }
  settings() { return this.options; }
  process(pid: Pid) { return this.pcbs.find(pcb => pcb.pid === pid); }
  terminate(pid: Pid) {
    this.terminated.push(pid); const pcb = this.process(pid); if (pcb !== undefined) pcb.state = 'zombie';
    for (const wait of this.allWaits()) if (wait.actor.pid === pid) this.removeWait(wait.generation);
  }
  acknowledge(actor: Actor) {
    for (const wait of this.allWaits()) if (sameActor(wait.actor, actor) && this.reserved(wait.generation)) this.removeWait(wait.generation);
    const pcb = this.process(actor.pid); if (pcb !== undefined) pcb.state = 'ready';
  }
  host(): SyncHost {
    return { tick: () => this.tick(), process: pid => this.process(pid), processes: () => this.pcbs,
      thread: () => undefined, actor: pid => this.actors.find(actor => actor.pid === pid), block: () => {},
      emit: event => this.emit(event), terminate: pid => this.terminate(pid), complete: () => {}, settings: () => this.settings(), cell: () => undefined };
  }
  mutex(id = resource) { const state = this.get(id); if (state?.kind !== 'mutex') throw new Error('not mutex'); return state; }
  semaphore(id = resource) { const state = this.get(id); if (state?.kind !== 'semaphore') throw new Error('not semaphore'); return state; }
  monitor(id = resource) { const state = this.get(id); if (state?.kind !== 'monitor') throw new Error('not monitor'); return state; }
  rwlock(id = resource) { const state = this.get(id); if (state?.kind !== 'rwlock') throw new Error('not rwlock'); return state; }
  barrier(id = resource) { const state = this.get(id); if (state?.kind !== 'barrier') throw new Error('not barrier'); return state; }
}

describe('mutex ownership and direct handoff', () => {
  it('acquires, rejects non-owner unlock and recursive acquisition without mutation', () => {
    const h = new Harness(); h.set(createMutex(resource));
    expect(mutexOperation(h, h.mutex(), h.actor(0), 'mutex_lock')).toEqual({ ok: true, value: null });
    const before = h.mutex();
    expect(mutexOperation(h, before, h.actor(1), 'mutex_unlock')).toMatchObject({ ok: false, errno: 'EPERM' });
    expect(mutexOperation(h, before, h.actor(0), 'mutex_lock')).toMatchObject({ ok: false, errno: 'EDEADLK' });
    expect(h.mutex()).toBe(before);
    expect(h.events).toEqual([{ type: 'sync.acquired', pid: h.actor(0).pid, resource, kind: 'mutex' }]);
  });
  it('blocks the second actor and prevents a third actor barging before wake', () => {
    const h = new Harness(); h.set(createMutex(resource));
    mutexOperation(h, h.mutex(), h.actor(0), 'mutex_lock');
    mutexOperation(h, h.mutex(), h.actor(1), 'mutex_lock');
    const waiter = h.mutex().entryQueue[0]; if (waiter === undefined) throw new Error('missing waiter');
    mutexOperation(h, h.mutex(), h.actor(0), 'mutex_unlock');
    expect(h.mutex().owner).toEqual(h.actor(1)); expect(h.reserved(waiter)).toBe(true);
    expect(h.blocked.has(waiter)).toBe(true);
    mutexOperation(h, h.mutex(), h.actor(2), 'mutex_lock');
    expect(h.mutex().owner).toEqual(h.actor(1)); expect(h.mutex().entryQueue).toHaveLength(1);
    expect(h.flushes).toEqual([h.actor(0).pid]); validateMutex(h.mutex(), h);
  });
  it('does not treat sibling threads as recursive owners', () => {
    const h = new Harness(); const sibling = { pid: h.actor(0).pid, tid: 900 as Tid }; h.pcb(0).threads.push(sibling.tid);
    h.set(createMutex(resource)); mutexOperation(h, h.mutex(), h.actor(0), 'mutex_lock');
    expect(mutexOperation(h, h.mutex(), sibling, 'mutex_lock')).toMatchObject({ ok: true });
    expect(h.wait(h.mutex().entryQueue[0] ?? -1)?.actor).toEqual(sibling);
  });
  it('rejects a blocking operation before any queue mutation when the actor cannot block', () => {
    const h = new Harness(); h.set(createMutex(resource)); mutexOperation(h, h.mutex(), h.actor(0), 'mutex_lock');
    h.blockingAllowed = false; const saved = h.mutex();
    expect(mutexOperation(h, saved, h.actor(1), 'mutex_lock')).toMatchObject({ ok: false, errno: 'EBUSY' });
    expect(h.mutex()).toBe(saved); expect(h.allWaits()).toEqual([]);
  });
});

describe('counting semaphore debits', () => {
  it('keeps the textbook negative sign and grants only the ordered head', () => {
    const h = new Harness(); h.set(createSemaphore(h, resource, 4, 0));
    for (let index = 0; index < 4; index++) { semaphoreOperation(h, h.semaphore(), h.actor(index), 'sem_wait'); expect(semaphoreValue(h.semaphore())).toBe(-index - 1); }
    const first = h.semaphore().waitQueue[0]; if (first === undefined) throw new Error('missing waiter');
    semaphoreOperation(h, h.semaphore(), h.actor(4), 'sem_post');
    expect(h.reserved(first)).toBe(true); expect(h.reservations.size).toBe(1); expect(semaphoreValue(h.semaphore())).toBe(-3);
    validateSemaphore(h.semaphore(), h);
  });
  it('uses exactly the sync stream selection draw for unordered post', () => {
    const h = new Harness(); h.set(createSemaphore(h, resource, 4, 0, false));
    for (let index = 0; index < 4; index++) semaphoreOperation(h, h.semaphore(), h.actor(index), 'sem_wait');
    const expected = createRng(0); expected.restore(h.rng.save()); const index = expected.int(0, 4);
    const chosen = h.semaphore().waitQueue[index]; if (chosen === undefined) throw new Error('missing choice');
    semaphoreOperation(h, h.semaphore(), h.actor(4), 'sem_post');
    expect(h.reserved(chosen)).toBe(true); expect(h.rng.save()).toEqual(expected.save());
  });
  it('allows a non-holder post, unlike mutex unlock, and rejects over-post without side effects', () => {
    const h = new Harness(); h.set(createSemaphore(h, resource, 1, 1));
    semaphoreOperation(h, h.semaphore(), h.actor(0), 'sem_wait');
    expect(semaphoreOperation(h, h.semaphore(), h.actor(1), 'sem_post')).toMatchObject({ ok: true });
    const before = h.semaphore(); const events = h.events.length; const flushes = h.flushes.length;
    expect(semaphoreOperation(h, before, h.actor(1), 'sem_post')).toMatchObject({ ok: false, errno: 'EINVAL' });
    expect(h.semaphore()).toBe(before); expect(h.events).toHaveLength(events); expect(h.flushes).toHaveLength(flushes);
  });
  it('retires the caller debit before an older anonymous debit and preserves cleanup debits', () => {
    const h = new Harness(); h.set(createSemaphore(h, resource, 3, 2));
    const anonymous = h.semaphore().debits[0];
    semaphoreOperation(h, h.semaphore(), h.actor(0), 'sem_wait'); semaphoreOperation(h, h.semaphore(), h.actor(1), 'sem_wait');
    semaphoreOperation(h, h.semaphore(), h.actor(1), 'sem_post'); expect(h.semaphore().debits[0]).toEqual(anonymous);
    const ids = h.semaphore().debits.map(debit => debit.id); const value = semaphoreValue(h.semaphore());
    anonymizeSemaphoreActor(h, h.semaphore(), h.actor(0));
    expect(h.semaphore().debits.map(debit => debit.id)).toEqual(ids); expect(semaphoreValue(h.semaphore())).toBe(value);
    expect(h.semaphore().debits.every(debit => debit.actor === null)).toBe(true);
  });
  it('validates debit conservation and rejects a corrupt queue without changing the table', () => {
    const h = new Harness(); h.set(createSemaphore(h, resource, 2, 2)); const state = h.semaphore();
    expect(() => validateSemaphore({ ...state, waitQueue: [99] }, h)).toThrow('conservation'); expect(h.semaphore()).toBe(state);
  });
});

describe('monitor condition disciplines', () => {
  it('condition wait releases the monitor and reacquires only after Mesa handoff', () => {
    const h = new Harness(); h.set(createMonitor(resource, ['ready']));
    monitorOperation(h, h.monitor(), h.actor(0), 'monitor_enter');
    monitorOperation(h, h.monitor(), h.actor(0), 'cond_wait', 'ready'); expect(h.monitor().owner).toBeNull();
    const waiter = h.monitor().conditions[0]?.waitQueue[0]; if (waiter === undefined) throw new Error('missing condition wait');
    monitorOperation(h, h.monitor(), h.actor(1), 'monitor_enter');
    monitorOperation(h, h.monitor(), h.actor(1), 'cond_signal', 'ready');
    expect(h.monitor().owner).toEqual(h.actor(1)); expect(h.reserved(waiter)).toBe(false);
    monitorOperation(h, h.monitor(), h.actor(1), 'monitor_exit');
    expect(h.monitor().owner).toEqual(h.actor(0)); expect(h.reserved(waiter)).toBe(true); validateMonitor(h.monitor(), h);
  });
  it('Mesa permits an earlier entry waiter to falsify the signalled predicate, requiring while', () => {
    const h = new Harness(); h.set(createMonitor(resource, ['ready'])); let predicate = false;
    monitorOperation(h, h.monitor(), h.actor(0), 'monitor_enter'); monitorOperation(h, h.monitor(), h.actor(0), 'cond_wait', 'ready');
    monitorOperation(h, h.monitor(), h.actor(1), 'monitor_enter'); monitorOperation(h, h.monitor(), h.actor(2), 'monitor_enter');
    predicate = true; monitorOperation(h, h.monitor(), h.actor(1), 'cond_signal', 'ready');
    monitorOperation(h, h.monitor(), h.actor(1), 'monitor_exit'); expect(h.monitor().owner).toEqual(h.actor(2));
    predicate = false; monitorOperation(h, h.monitor(), h.actor(2), 'monitor_exit'); expect(h.monitor().owner).toEqual(h.actor(0));
    h.acknowledge(h.actor(0));
    if (!predicate) monitorOperation(h, h.monitor(), h.actor(0), 'cond_wait', 'ready');
    expect(h.monitor().conditions[0]?.waitQueue).toHaveLength(1); expect(h.monitor().owner).toBeNull();
  });
  it('empty signal is a no-op and Hoare signal transfers ownership before wake', () => {
    const h = new Harness(); h.set(createMonitor(resource, ['ready'], 'signal_and_wait'));
    monitorOperation(h, h.monitor(), h.actor(0), 'monitor_enter'); const before = h.monitor();
    expect(monitorOperation(h, before, h.actor(0), 'cond_signal', 'ready')).toMatchObject({ ok: true }); expect(h.monitor()).toBe(before);
    monitorOperation(h, h.monitor(), h.actor(0), 'cond_wait', 'ready');
    monitorOperation(h, h.monitor(), h.actor(1), 'monitor_enter'); monitorOperation(h, h.monitor(), h.actor(1), 'cond_signal', 'ready');
    expect(h.monitor().owner).toEqual(h.actor(0));
    expect(h.wait(h.monitor().entryQueue[0] ?? -1)?.actor).toEqual(h.actor(1)); expect(h.reservations.size).toBe(1);
    validateMonitor(h.monitor(), h);
  });
  it('broadcast preserves condition FIFO order while the signaller keeps the lock', () => {
    const h = new Harness(); h.set(createMonitor(resource, ['ready']));
    for (let index = 0; index < 3; index++) { monitorOperation(h, h.monitor(), h.actor(index), 'monitor_enter'); monitorOperation(h, h.monitor(), h.actor(index), 'cond_wait', 'ready'); }
    const order = h.monitor().conditions[0]?.waitQueue;
    monitorOperation(h, h.monitor(), h.actor(3), 'monitor_enter'); monitorOperation(h, h.monitor(), h.actor(3), 'cond_broadcast', 'ready');
    expect(h.monitor().entryQueue).toEqual(order); expect(h.monitor().conditions[0]?.waitQueue).toEqual([]); expect(h.monitor().owner).toEqual(h.actor(3));
    expect(h.reservations.size).toBe(0);
  });
});

describe('reader/writer policies', () => {
  it('admits concurrent readers, holds a writer exclusively, and blocks new readers behind a writer', () => {
    const h = new Harness(); h.set(createRwlock(resource, 8));
    for (let index = 0; index < 3; index++) rwlockOperation(h, h.rwlock(), h.actor(index), 'rw_read_lock');
    expect(h.rwlock().readers).toHaveLength(3);
    rwlockOperation(h, h.rwlock(), h.actor(3), 'rw_write_lock'); rwlockOperation(h, h.rwlock(), h.actor(4), 'rw_read_lock');
    for (let index = 0; index < 3; index++) rwlockOperation(h, h.rwlock(), h.actor(index), 'rw_read_unlock');
    expect(h.rwlock().writer).toEqual(h.actor(3)); expect(h.rwlock().readers).toHaveLength(0);
    expect(h.rwlock().waitQueue).toHaveLength(1); validateRwlock(h.rwlock(), h);
    rwlockOperation(h, h.rwlock(), h.actor(3), 'rw_write_unlock'); expect(h.rwlock().readers).toEqual([h.actor(4)]);
  });
  it('reader preference allows a later reader ahead of a waiting writer', () => {
    const h = new Harness(); h.set(createRwlock(resource, 8, 'reader_pref'));
    rwlockOperation(h, h.rwlock(), h.actor(0), 'rw_read_lock'); rwlockOperation(h, h.rwlock(), h.actor(1), 'rw_write_lock');
    rwlockOperation(h, h.rwlock(), h.actor(2), 'rw_read_lock'); expect(h.rwlock().readers).toEqual([h.actor(0), h.actor(2)]);
    expect(h.rwlock().writer).toBeNull();
  });
  it('fair admission batches adjacent readers and preserves the next writer ticket', () => {
    const h = new Harness(); h.set(createRwlock(resource, 8, 'fair')); rwlockOperation(h, h.rwlock(), h.actor(0), 'rw_write_lock');
    rwlockOperation(h, h.rwlock(), h.actor(1), 'rw_read_lock'); rwlockOperation(h, h.rwlock(), h.actor(2), 'rw_read_lock');
    rwlockOperation(h, h.rwlock(), h.actor(3), 'rw_write_lock'); rwlockOperation(h, h.rwlock(), h.actor(4), 'rw_read_lock');
    rwlockOperation(h, h.rwlock(), h.actor(0), 'rw_write_unlock'); expect(h.rwlock().readers).toEqual([h.actor(1), h.actor(2)]);
    rwlockOperation(h, h.rwlock(), h.actor(1), 'rw_read_unlock'); expect(h.rwlock().writer).toBeNull();
    rwlockOperation(h, h.rwlock(), h.actor(2), 'rw_read_unlock'); expect(h.rwlock().writer).toEqual(h.actor(3));
    validateRwlock(h.rwlock(), h); rwlockOperation(h, h.rwlock(), h.actor(3), 'rw_write_unlock'); expect(h.rwlock().readers).toEqual([h.actor(4)]);
  });
  it('cancelling the preferred writer permits a queued reader to join current readers', () => {
    const h = new Harness(); h.set(createRwlock(resource, 3)); rwlockOperation(h, h.rwlock(), h.actor(0), 'rw_read_lock');
    rwlockOperation(h, h.rwlock(), h.actor(1), 'rw_write_lock'); rwlockOperation(h, h.rwlock(), h.actor(2), 'rw_read_lock');
    const writer = h.rwlock().waitQueue[0]; if (writer === undefined) throw new Error('missing writer');
    h.set({ ...h.rwlock(), waitQueue: h.rwlock().waitQueue.filter(generation => generation !== writer) }); h.removeWait(writer);
    grantRwWaiters(h, h.rwlock()); expect(h.rwlock().readers).toEqual([h.actor(0), h.actor(2)]);
  });
});

describe('barrier generations', () => {
  it('flushes each issuer before publishing its arrival or blocking it', () => {
    const h = new Harness(); h.set(createBarrier(resource, 2)); h.order.splice(0);
    barrierOperation(h, h.barrier(), h.actor(0)); expect(h.order.slice(0, 3)).toEqual(['flush', 'set', 'block']);
    h.order.splice(0); barrierOperation(h, h.barrier(), h.actor(1));
    expect(h.order.slice(0, 3)).toEqual(['flush', 'set', 'block']); expect(h.flushes).toEqual([h.actor(0).pid, h.actor(1).pid]);
    h.blockingAllowed = false; h.order.splice(0); expect(barrierOperation(h, h.barrier(), h.actor(2))).toMatchObject({ ok: false, errno: 'EBUSY' });
    expect(h.order).toEqual([]);
  });
  it('the last of four arrivals reserves all four without waking them inline, then resets', () => {
    const h = new Harness(); h.set(createBarrier(resource, 4));
    for (let index = 0; index < 3; index++) barrierOperation(h, h.barrier(), h.actor(index));
    expect(h.barrier().arrivals).toHaveLength(3); expect(h.reservations.size).toBe(0);
    barrierOperation(h, h.barrier(), h.actor(3)); expect(h.barrier().arrivals).toEqual([]); expect(h.barrier().generation).toBe(1);
    expect(h.reservations.size).toBe(4); expect(h.blocked.size).toBe(4); validateBarrier(h.barrier(), h);
    for (let index = 0; index < 4; index++) { h.acknowledge(h.actor(index)); barrierOperation(h, h.barrier(), h.actor(index)); }
    expect(h.barrier().generation).toBe(2); expect(h.reservations.size).toBe(4);
  });
});

describe('critical-section requirements and blocked starvation', () => {
  it('reports one progress failure for a free primitive left contended for five ticks', () => {
    const h = new Harness(); h.set(createMutex(resource)); h.requirements.configure(resource, 1);
    const generation = h.newWait(h.actor(0), resource, { kind: 'mutex' }); h.set({ ...h.mutex(), entryQueue: [generation] });
    for (let tick = 1; tick <= 5; tick++) { h.now = asTick(tick); h.requirements.timers(); }
    expect(h.events.filter(event => event.type === 'kernel.panic')).toEqual([{ type: 'kernel.panic', message: `progress violated on ${resource}` }]);
  });
  it('FIFO entry never overtakes a waiter while unordered selection exposes the bounded-wait failure', () => {
    for (const ordered of [true, false]) {
      const h = new Harness([10, 10, 10, 10]); h.set(createSemaphore(h, resource, 1, 1, ordered));
      semaphoreOperation(h, h.semaphore(), h.actor(0), 'sem_wait');
      for (let index = 1; index < 4; index++) semaphoreOperation(h, h.semaphore(), h.actor(index), 'sem_wait');
      for (let tick = 1; tick <= 5000; tick++) {
        h.now = asTick(tick); const actor = h.semaphore().debits[0]?.actor; if (actor === null || actor === undefined) throw new Error('missing permit owner');
        h.acknowledge(actor); semaphoreOperation(h, h.semaphore(), actor, 'sem_post'); semaphoreOperation(h, h.semaphore(), actor, 'sem_wait');
        if (ordered) expect(h.allWaits().every(wait => wait.entriesObserved <= 3)).toBe(true);
      }
      expect(h.events.some(event => event.type === 'process.starving')).toBe(!ordered);
    }
  });
  it('emits fatal blocked-wait starvation once, applies SABLE multiplier, and ignores reservations', () => {
    const h = new Harness(); h.options = { ...h.options, starvationThreshold: 2, starvationFatalThreshold: 4 };
    h.set(createMutex(resource)); mutexOperation(h, h.mutex(), h.actor(0), 'mutex_lock'); mutexOperation(h, h.mutex(), h.actor(1), 'mutex_lock');
    h.pcb(1).convoyMemberId = 'sable';
    for (let tick = 1; tick <= 12; tick++) { h.now = asTick(tick); h.requirements.timers(); }
    expect(h.events.filter(event => event.type === 'process.starving')).toEqual([
      { type: 'process.starving', pid: h.actor(1).pid, waitedTicks: 6, fatal: false },
      { type: 'process.starving', pid: h.actor(1).pid, waitedTicks: 12, fatal: true },
    ]); expect(h.terminated).toEqual([h.actor(1).pid]);
    const other = new Harness(); other.options = { ...other.options, starvationThreshold: 1, starvationFatalThreshold: 2 };
    other.set(createMutex(resource)); mutexOperation(other, other.mutex(), other.actor(0), 'mutex_lock'); mutexOperation(other, other.mutex(), other.actor(1), 'mutex_lock');
    mutexOperation(other, other.mutex(), other.actor(0), 'mutex_unlock'); other.now = asTick(10); other.requirements.timers();
    expect(other.events.filter(event => event.type === 'process.starving')).toEqual([]);
  });
  it('enforces I-21 and permits an observed intentional violation to survive restore', () => {
    const h = new Harness(); h.requirements.configure(resource, 1, 'observe');
    h.requirements.enter(h.actor(0), resource); h.requirements.enter(h.actor(1), resource);
    const saved = h.requirements.saveState(); const restored = new Requirements(h); restored.restoreState(saved);
    expect(restored.saveState()).toEqual(saved); expect(restored.state(resource)?.mutualExclusionViolations).toBe(1);
    expect(() => restored.restoreState(saved.map(record => ({ ...record, mode: 'enforce' })))).toThrow('exclusion');
    expect(restored.saveState()).toEqual(saved);
    const strict = new Requirements(h); strict.configure(resource, 1); strict.enter(h.actor(0), resource);
    try { strict.enter(h.actor(1), resource); throw new Error('missing invariant failure'); }
    catch (error) { expect(error).toBeInstanceOf(KernelInvariantError); expect(error).toMatchObject({ invariant: 21, message: `mutual exclusion violated on ${resource}` }); }
  });
  it('restores progress clocks and rejects future clocks before replacing state', () => {
    const h = new Harness(); h.set(createMutex(resource)); h.requirements.configure(resource, 1);
    const generation = h.newWait(h.actor(0), resource, { kind: 'mutex' }); h.set({ ...h.mutex(), entryQueue: [generation] });
    h.now = asTick(1); h.requirements.timers(); h.now = asTick(2); h.requirements.timers(); const saved = h.requirements.saveState();
    const restored = new Requirements(h); restored.restoreState(saved, h.now, h.now); restored.timers(h.now);
    expect(h.events).toEqual([]); restored.timers(asTick(3)); restored.timers(asTick(4));
    expect(h.events.filter(event => event.type === 'kernel.panic')).toHaveLength(1);
    const before = restored.saveState(); expect(() => restored.restoreState(saved.map(record => ({ ...record, progressFreeSince: asTick(9) })), asTick(4))).toThrow('clock');
    expect(restored.saveState()).toEqual(before);
  });
  it('does not call unavailable semaphore permits, condition waits or partial barriers a progress failure', () => {
    const h = new Harness(); const condition = asResourceId('test:condition'); const barrier = asResourceId('test:barrier');
    h.set(createSemaphore(h, resource, 4, 0)); h.requirements.configure(resource, 4);
    semaphoreOperation(h, h.semaphore(), h.actor(0), 'sem_wait');
    h.set(createMonitor(condition, ['ready'])); h.requirements.configure(condition, 1);
    monitorOperation(h, h.monitor(condition), h.actor(1), 'monitor_enter'); monitorOperation(h, h.monitor(condition), h.actor(1), 'cond_wait', 'ready');
    h.set(createBarrier(barrier, 4)); h.requirements.configure(barrier, 4); barrierOperation(h, h.barrier(barrier), h.actor(2));
    for (let tick = 1; tick <= 10; tick++) { h.now = asTick(tick); h.requirements.timers(); }
    expect(h.events.filter(event => event.type === 'kernel.panic')).toEqual([]);
  });
});

describe('priority inversion and donation composition', () => {
  function setup(inheritance: boolean) {
    const h = new Harness([20, 2, 10, 4]); h.options = { ...h.options, priorityInheritance: inheritance };
    h.set(createMutex(resource)); mutexOperation(h, h.mutex(), h.actor(0), 'mutex_lock'); mutexOperation(h, h.mutex(), h.actor(1), 'mutex_lock');
    h.pcb(0).state = 'ready'; h.pcb(2).state = 'running'; const priority = new PriorityInversion(h.host(), h); return { h, priority };
  }
  it('reports the correct blocked, holder and interposed PIDs with inheritance off', () => {
    const { h, priority } = setup(false); priority.detect();
    expect(priority.inversions()).toEqual([{ blocked: h.actor(1).pid, holder: h.actor(0).pid, interposed: h.actor(2).pid }]);
  });
  it('keeps donation through ordinary aging and dispatch, then restores base on release', () => {
    const { h, priority } = setup(true); priority.detect(); expect(priority.inversions()).toEqual([]); expect(h.pcb(0).priority).toBe(2);
    priority.beforeAging(); expect(h.pcb(0).priority).toBe(20); h.pcb(0).priority -= 1; priority.afterAging();
    expect(h.pcb(0).priority).toBe(2); expect(priority.save().priorities[0]?.ordinaryPriority).toBe(19);
    h.pcb(0).state = 'running'; h.pcb(0).priority = h.pcb(0).basePriority;
    priority.observe({ type: 'process.state_changed', pid: h.actor(0).pid, from: 'ready', to: 'running', tick: asTick(1), seq: 0 });
    expect(h.pcb(0).priority).toBe(2);
    mutexOperation(h, h.mutex(), h.actor(0), 'mutex_unlock'); priority.refresh(); expect(h.pcb(0).priority).toBe(20);
  });
  it('retains the remaining donation when one of two held locks is released', () => {
    const { h, priority } = setup(true); const second = asResourceId('test:second'); h.set(createMutex(second));
    mutexOperation(h, h.mutex(second), h.actor(0), 'mutex_lock'); mutexOperation(h, h.mutex(second), h.actor(3), 'mutex_lock'); priority.refresh();
    expect(h.pcb(0).priority).toBe(2); mutexOperation(h, h.mutex(), h.actor(0), 'mutex_unlock'); priority.refresh(); expect(h.pcb(0).priority).toBe(4);
    mutexOperation(h, h.mutex(second), h.actor(0), 'mutex_unlock'); priority.refresh(); expect(h.pcb(0).priority).toBe(20);
  });
  it('projects donations during multiple event callbacks while ordinary aging keeps progressing', () => {
    const { h, priority } = setup(true); priority.beforeAging();
    const observed: number[] = [];
    h.pcb(0).priority -= 1;
    priority.withEffectivePriorities(() => { observed.push(h.pcb(0).priority); priority.refresh(); });
    expect(h.pcb(0).priority).toBe(19); h.pcb(0).priority -= 1;
    priority.withEffectivePriorities(() => { observed.push(h.pcb(0).priority); });
    expect(h.pcb(0).priority).toBe(18);
    expect(() => priority.withEffectivePriorities(() => { throw new Error('observer failed'); })).toThrow('observer failed');
    expect(h.pcb(0).priority).toBe(18); priority.afterAging();
    expect(observed).toEqual([2, 2]); expect(h.pcb(0).priority).toBe(2); expect(priority.save().priorities[0]?.ordinaryPriority).toBe(18);
  });
  it('never donates through counting permit provenance', () => {
    const h = new Harness([20, 2, 10]); h.options = { ...h.options, priorityInheritance: true }; h.set(createSemaphore(h, resource, 1, 1));
    semaphoreOperation(h, h.semaphore(), h.actor(0), 'sem_wait'); semaphoreOperation(h, h.semaphore(), h.actor(1), 'sem_wait');
    const priority = new PriorityInversion(h.host(), h); priority.refresh(); expect(h.pcb(0).priority).toBe(20); expect(priority.save().priorities).toEqual([]);
  });
  it('does not resurrect a process terminated during the aging hook', () => {
    const { h, priority } = setup(true); priority.refresh(); priority.beforeAging(); h.terminate(h.actor(0).pid); priority.afterAging();
    expect(h.pcb(0).state).toBe('zombie'); expect(priority.save().priorities).toEqual([]);
  });
  it('restores donation records and refuses a missing owner or malformed priority atomically', () => {
    const { h, priority } = setup(true); priority.refresh(); const saved = priority.save(); const restored = new PriorityInversion(h.host(), h);
    restored.restore(saved); expect(restored.save()).toEqual(saved);
    const malformed = { ...saved, priorities: saved.priorities.map(record => ({ ...record, ordinaryPriority: 40 })) };
    expect(() => restored.restore(malformed)).toThrow('ordinary priority'); expect(restored.save()).toEqual(saved);
    h.set({ ...h.mutex(), owner: null }); expect(() => restored.restore(saved)).toThrow('owner'); expect(restored.save()).toEqual(saved);
  });
});

function integrationKernel(overrides: KernelOptions = {}) {
  return createKernel({ ...REFERENCE_CONFIG, scheduler: 'rr',
    schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1, starvationThreshold: 1000, starvationFatalThreshold: 2000 },
    enabledSubsystems: ['process', 'scheduler', 'sync'] }, { threadCreateTicks: 0, contextSwitchTicks: 0, degreeOfMultiprogramming: 16, ...overrides });
}

describe('kernel synchronization hook integration', () => {
  it('validates all four syscall arguments and unknown resources without changing synchronization state', () => {
    const kernel = integrationKernel(); kernel.syncSubsystem.createMutex(resource);
    const pid = kernel.spawn({ name: 'caller', priority: 10, arrival: 0, burst: 100, service: 100, pages: 0 },
      { program: instructionProgram([{ kind: 'compute' }]) });
    const before = kernel.syncSubsystem.saveState();
    for (const name of ['mutex_lock', 'mutex_unlock', 'sem_wait', 'sem_post'] as const) {
      for (const args of [[], [7], [resource, 'extra']]) {
        expect(kernel.syscall({ pid, name, args })).toMatchObject({ ok: false, errno: 'EINVAL' });
        expect(kernel.syncSubsystem.saveState()).toEqual(before);
      }
      expect(kernel.syscall({ pid, name, args: ['unknown:resource'] })).toMatchObject({ ok: false, errno: 'ENOENT' });
      expect(kernel.syncSubsystem.saveState()).toEqual(before);
    }
  });
  it('keeps primitive, holder, queue and collection identities stable through operations and restore', () => {
    const kernel = integrationKernel(); const primitive = kernel.syncSubsystem.createMutex(resource);
    const collection = kernel.syncSubsystem.primitives; const holders = primitive.holders; const queue = primitive.waitQueue;
    const pid = kernel.spawn({ name: 'holder', priority: 10, arrival: 0, burst: 100, service: 100, pages: 0 },
      { program: instructionProgram([{ kind: 'compute' }]) });
    kernel.syscall({ pid, name: 'mutex_lock', args: [resource] }); kernel.run(2);
    const saved = kernel.syncSubsystem.saveState().sync; kernel.syncSubsystem.prepareRestore(saved)();
    expect(kernel.syncSubsystem.primitives).toBe(collection); expect(collection[0]).toBe(primitive);
    expect(primitive.holders).toBe(holders); expect(primitive.waitQueue).toBe(queue); expect(holders).toEqual([pid]);
    kernel.syscall({ pid, name: 'mutex_unlock', args: [resource] }); expect(primitive.holders).toBe(holders); expect(holders).toEqual([]);
  });
  it('exec flushes stores and hands off exclusive ownership while its counting debit becomes anonymous', () => {
    const kernel = integrationKernel(); const semaphore = asResourceId('test:permits');
    kernel.syncSubsystem.createMutex(resource); kernel.syncSubsystem.createSemaphore(semaphore, 1); kernel.syncSubsystem.addControlCell('exec-visible', 0);
    const owner = kernel.spawn({ name: 'exec owner', priority: 10, arrival: 0, burst: 100, service: 100, pages: 0 },
      { program: instructionProgram([{ kind: 'sync', operation: { op: 'mutex_lock', resource } },
        { kind: 'sync', operation: { op: 'sem_wait', resource: semaphore } },
        { kind: 'sync', operation: { op: 'store', cell: 'exec-visible', value: { kind: 'literal', value: 9 }, rmw: false } }, { kind: 'compute' }]) });
    const waiter = kernel.spawn({ name: 'exec waiter', priority: 10, arrival: 4, burst: 100, service: 100, pages: 0 },
      { program: instructionProgram([{ kind: 'sync', operation: { op: 'mutex_lock', resource } }, { kind: 'compute' }]) });
    kernel.syncSubsystem.setMemoryOrder(owner, true, 100); kernel.run(4);
    expect(kernel.syncSubsystem.memoryOrder.peek('exec-visible')).toBe(0);
    expect(kernel.syncSubsystem.allWaits().map(wait => wait.actor.pid)).toEqual([waiter]);
    kernel.registerProgram('fresh', instructionProgram([{ kind: 'compute' }, { kind: 'compute' }]));
    expect(kernel.syscall({ pid: owner, name: 'exec', args: ['fresh'] })).toMatchObject({ ok: true });
    expect(kernel.syncSubsystem.memoryOrder.peek('exec-visible')).toBe(9);
    expect(kernel.syncSubsystem.primitives.find(primitive => primitive.id === resource)?.holders).toEqual([waiter]);
    const state = kernel.syncSubsystem.get(semaphore); if (state?.kind !== 'semaphore') throw new Error('missing semaphore');
    expect(semaphoreValue(state)).toBe(0); expect(state.debits).toHaveLength(1); expect(state.debits[0]?.actor).toBeNull();
    expect(kernel.process(owner)?.heldResources).toEqual([]); expect(kernel.syncSubsystem.allWaits().some(wait => wait.actor.pid === owner)).toBe(false);
  });
  it('one permit wakes exactly one of two same-PID waiting TCBs through pure readiness', () => {
    const kernel = integrationKernel({ threadModel: 'one_to_one', coreCount: 2 });
    kernel.syncSubsystem.createSemaphore(resource, 2, 0);
    const pid = kernel.spawn({ name: 'siblings', priority: 10, arrival: 0, burst: 100, service: 100, pages: 0 },
      { threadCount: 2, serialFraction: 1, program: instructionProgram([{ kind: 'sync', operation: { op: 'sem_wait', resource } }, { kind: 'compute' }]) });
    const poster = kernel.spawn({ name: 'poster', priority: 10, arrival: 100, burst: 100, service: 100, pages: 0 },
      { program: instructionProgram([{ kind: 'compute' }]) });
    kernel.run(2);
    const waiting = [...kernel.threads.table.values()].filter(thread => thread.pid === pid);
    expect(waiting).toHaveLength(2); expect(waiting.every(thread => thread.state === 'waiting')).toBe(true);
    expect(waiting[0]?.blockedOn).toEqual(waiting[1]?.blockedOn); expect(waiting[0]?.blockedOn).not.toBe(waiting[1]?.blockedOn);
    kernel.syscall({ pid: poster, name: 'sem_post', args: [resource] });
    const before = kernel.syncSubsystem.saveState();
    const readiness = waiting.map(thread => thread.blockedOn !== null && kernel.syncSubsystem.isSatisfied(pid, thread.blockedOn, thread.tid));
    expect(readiness.filter(Boolean)).toHaveLength(1);
    expect(waiting.map(thread => thread.blockedOn !== null && kernel.syncSubsystem.isSatisfied(pid, thread.blockedOn, thread.tid))).toEqual(readiness);
    // Detection has its own once-per-tick clock; readiness itself leaves reservations untouched.
    expect(kernel.syncSubsystem.saveState().sync.payload.reservations).toEqual(before.sync.payload.reservations);
    kernel.step();
    expect(waiting.filter(thread => thread.state === 'waiting')).toHaveLength(1);
    expect(waiting.map(thread => thread.programCounter).sort((a, b) => a - b)).toEqual([1, 2]);
    kernel.syscall({ pid: poster, name: 'sem_post', args: [resource] });
    expect(kernel.process(pid)?.heldResources.filter(id => id === resource)).toHaveLength(2);
  });

  it('fatal termination of a waiting owner cancels its wait, hands off its mutex and preserves semaphore debt', () => {
    const kernel = createKernel({ ...REFERENCE_CONFIG, scheduler: 'rr', enabledSubsystems: ['process', 'scheduler', 'sync'],
      schedulerParams: { ...REFERENCE_CONFIG.schedulerParams, quantum: 1, starvationThreshold: 2, starvationFatalThreshold: 4 } },
    { threadCreateTicks: 0, contextSwitchTicks: 0 });
    const unavailable = asResourceId('test:unavailable'); kernel.syncSubsystem.createMutex(resource); kernel.syncSubsystem.createSemaphore(unavailable, 1, 0);
    const owner = kernel.spawn({ name: 'blocked owner', priority: 10, arrival: 0, burst: 100, service: 100, pages: 0 },
      { program: instructionProgram([{ kind: 'sync', operation: { op: 'mutex_lock', resource } }, { kind: 'sync', operation: { op: 'sem_wait', resource: unavailable } }]) });
    const waiter = kernel.spawn({ name: 'later waiter', priority: 10, arrival: 3, burst: 100, service: 100, pages: 0 },
      { program: instructionProgram([{ kind: 'sync', operation: { op: 'mutex_lock', resource } }, { kind: 'compute' }, { kind: 'sync', operation: { op: 'mutex_unlock', resource } }]) });
    const log = kernel.run(6);
    expect(log.filter(event => event.type === 'process.starving' && event.fatal)).toMatchObject([{ pid: owner, waitedTicks: 4, fatal: true }]);
    expect(log.filter(event => event.type === 'process.exited')).toMatchObject([{ pid: owner, reason: 'starvation' }]);
    expect(kernel.syncSubsystem.primitives.find(primitive => primitive.id === resource)?.holders).toEqual([waiter]);
    expect(kernel.syncSubsystem.allWaits().some(wait => wait.actor.pid === owner)).toBe(false);
    expect(kernel.process(owner)?.heldResources).toEqual([]);
    const semaphore = kernel.syncSubsystem.get(unavailable); if (semaphore?.kind !== 'semaphore') throw new Error('missing semaphore');
    expect(semaphoreValue(semaphore)).toBe(0); expect(semaphore.debits).toHaveLength(1); expect(semaphore.debits[0]?.actor).toBeNull();
    kernel.step(); expect(kernel.syncSubsystem.primitives.find(primitive => primitive.id === resource)?.holders).toEqual([]);
  });
});

/**
 * WP-11 owns process/PC/RNG reconstruction. This explicit host stages those values,
 * then runs actual immutable Program instructions through two independent sync objects.
 * It deliberately makes no claim to restore a complete Kernel.
 */
class ContinuationHost implements SyncHost {
  readonly sync: SyncSubsystem;
  readonly rng = createRng(0x4b54524c, 'root/sync');
  readonly pcbs = new Map<Pid, ProcessControlBlock>();
  readonly tcbs = new Map<Tid, ThreadControlBlock>();
  readonly programs = new Map<Pid, Program>();
  readonly regions = new Map<ResourceId, number>();
  readonly events: KernelEvent[] = [];
  now = asTick(0);
  private cursor = 1;
  private seq = 0;
  private readonly options: SyncSettings;

  constructor(kernel: KernelImpl, previous?: ContinuationHost) {
    this.options = kernel.syncSubsystem.saveState().sync.payload.settings;
    for (const pcb of previous?.pcbs.values() ?? kernel.processes.filter(pcb => pcb.pid > 1)) {
      const saved: ProcessControlBlock = { ...structuredClone(pcb) }; if (previous === undefined) { saved.state = 'ready'; saved.readySince = asTick(0); }
      this.pcbs.set(saved.pid, saved);
      const program = previous?.programs.get(pcb.pid) ?? kernel.program(pcb.pid); if (program !== undefined) this.programs.set(pcb.pid, program);
    }
    for (const thread of previous?.tcbs.values() ?? kernel.threads.table.values()) if (thread.pid > 1) this.tcbs.set(thread.tid, structuredClone(thread));
    if (previous === undefined) {
      for (const cell of kernel.syncSubsystem.saveState().sync.payload.memoryOrder.cells) if (cell.kind === 'region') {
        const region = kernel.ipc.sharedRegion(cell.region); if (region === undefined) throw new Error('missing region'); this.regions.set(cell.region, region.value);
      }
    } else {
      for (const [id, value] of previous.regions) this.regions.set(id, value);
      this.now = previous.now; this.cursor = previous.cursor; this.seq = previous.seq; this.rng.restore(previous.rng.save());
    }
    this.sync = new SyncSubsystem(this, this.rng);
  }
  tick() { return this.now; }
  process(pid: Pid) { return this.pcbs.get(pid); }
  processes() { return [...this.pcbs.values()].sort((a, b) => a.pid - b.pid); }
  thread(tid: Tid) { return this.tcbs.get(tid); }
  actor(pid: Pid): Actor | undefined { const tid = this.pcbs.get(pid)?.threads[0]; return tid === undefined ? undefined : { pid, tid }; }
  block(pid: Pid, reason: BlockReason, tid: Tid) {
    const pcb = this.process(pid); const thread = this.thread(tid); if (pcb === undefined || thread === undefined) throw new Error('missing blocked actor');
    thread.state = 'waiting'; thread.blockedOn = { ...reason }; pcb.state = 'waiting'; pcb.readySince = null; pcb.blockedOn = { ...reason };
  }
  emit(event: EmittableEvent) { const stamped: KernelEvent = { ...event, tick: this.now, seq: this.seq++ }; this.events.push(stamped); this.sync.observe(stamped); }
  terminate(pid: Pid) { this.finish(pid, true); }
  complete(pid: Pid) { this.finish(pid, false); }
  private finish(pid: Pid, starved: boolean) {
    const pcb = this.process(pid); if (pcb === undefined) return;
    this.sync.releaseAll(pcb); for (const tid of pcb.threads) this.tcbs.delete(tid); pcb.threads.splice(0);
    pcb.state = 'terminated'; pcb.serviceRemaining = 0; pcb.cpuBurstRemaining = 0; pcb.readySince = null; pcb.blockedOn = null;
    this.emit({ type: 'process.exited', pid, exitCode: starved ? -1 : 0, reason: starved ? 'starvation' : 'normal_exit' });
  }
  settings() { return this.options; }
  cell(binding: Parameters<SyncHost['cell']>[0]) {
    if (binding.kind !== 'region' || !this.regions.has(binding.region)) return undefined;
    return { get: () => { const value = this.regions.get(binding.region); if (value === undefined) throw new Error('missing region'); return value; },
      set: (value: number) => { this.regions.set(binding.region, value); } };
  }
  step() {
    this.now = asTick(this.now + 1); this.sync.expireTimers(this.now);
    for (const thread of [...this.tcbs.values()].sort((a, b) => a.tid - b.tid)) {
      if (thread.state !== 'waiting' || thread.blockedOn === null || !this.sync.isSatisfied(thread.pid, thread.blockedOn, thread.tid)) continue;
      thread.state = 'ready'; thread.blockedOn = null; const pcb = this.process(thread.pid);
      if (pcb !== undefined) { pcb.state = 'ready'; pcb.readySince = this.now; pcb.blockedOn = null; }
    }
    const runnable = this.processes().filter(pcb => pcb.state === 'ready');
    const pcb = runnable.find(candidate => candidate.pid > this.cursor) ?? runnable[0]; if (pcb === undefined) return;
    const actor = this.actor(pcb.pid); const thread = actor === undefined ? undefined : this.thread(actor.tid); const program = this.programs.get(pcb.pid);
    if (actor === undefined || thread === undefined || program === undefined) throw new Error('missing runnable instruction');
    this.cursor = pcb.pid; pcb.state = 'running'; pcb.readySince = null; thread.state = 'running';
    const instruction = program.at(thread.programCounter); if (instruction.kind !== 'sync') throw new Error('continuation fixture only uses sync instructions');
    this.sync.beginAttempt(actor);
    let result: AttemptResult; try { result = this.sync.execute(actor, instruction.operation); } finally { this.sync.endAttempt(actor); }
    if (this.tcbs.has(thread.tid)) {
      if (result.target !== null) thread.programCounter = result.target; else if (result.advance) thread.programCounter += 1;
      if (thread.state === 'running') thread.state = 'ready';
      if (this.process(pcb.pid)?.state === 'running') { pcb.state = 'ready'; pcb.readySince = this.now; }
    }
  }
  externalState() { return canonical({ pcbs: [...this.pcbs], threads: [...this.tcbs], regions: [...this.regions], rng: this.rng.save(), seq: this.seq }); }
}

function continuationFixture() {
  const kernel = integrationKernel();
  createBoundedBuffer(kernel, { id: 'continuation', capacity: 2, producers: 1, consumers: 1,
    producerItems: 4, consumerItems: 4, producerTicks: 1, consumerTicks: 1, reordering: true });
  const original = new ContinuationHost(kernel); original.sync.prepareRestore(kernel.syncSubsystem.saveState().sync)();
  for (let tick = 0; tick < 30; tick++) {
    original.step(); const saved = original.sync.saveState().sync;
    if (saved.payload.memoryOrder.buffers.some(buffer => buffer.writes.length > 0)
      && saved.payload.primitives.some(primitive => primitive.kind === 'semaphore' && primitive.waitQueue.length > 0)) return { kernel, original, saved };
  }
  throw new Error('bounded buffer never reached a buffered store with a blocked waiter');
}

describe('aggregate sync contribution continuation', () => {
  it('restores a fresh subsystem with staged PC/process/RNG/event state and identical bounded-buffer continuation', () => {
    const { kernel, original, saved } = continuationFixture(); const restored = new ContinuationHost(kernel, original);
    expect(restored.sync.primitives).toEqual([]); const before = restored.externalState();
    const commit = restored.sync.prepareRestore(structuredClone(saved)); expect(restored.externalState()).toBe(before); expect(restored.events).toEqual([]);
    commit(); expect(restored.sync.saveState().sync).toEqual(saved); expect(restored.events).toEqual([]);
    original.events.splice(0);
    for (let tick = 0; tick < 100; tick++) { original.step(); restored.step(); }
    expect(canonical(restored.events)).toBe(canonical(original.events));
    expect(restored.sync.saveState()).toEqual(original.sync.saveState()); expect(restored.externalState()).toBe(original.externalState());
    expect(restored.sync.scenario('continuation')).toMatchObject({ produced: 4, consumed: 4, items: [], inFlight: 0 });
  });
  it('rejects malformed queues, allocators, priority records and clocks without changing host or subsystem', () => {
    const { kernel, original, saved } = continuationFixture(); const target = new ContinuationHost(kernel, original); target.sync.prepareRestore(saved)();
    const firstProcess = original.processes()[0]; if (firstProcess === undefined) throw new Error('missing continuation process');
    const invalidStates: SyncSnapshotState[] = [
      { ...saved, payload: { ...saved.payload, nextWaitGeneration: 0 } },
      { ...saved, payload: { ...saved.payload, nextPermitId: 0 } },
      { ...saved, payload: { ...saved.payload, lastTimerTick: asTick(saved.payload.tick + 1) } },
      { ...saved, payload: { ...saved.payload, primitives: saved.payload.primitives.map(primitive => primitive.kind === 'semaphore'
        ? { ...primitive, waitQueue: [...primitive.waitQueue, 999] } : primitive) } },
      { ...saved, payload: { ...saved.payload, priorities: [{ pid: firstProcess.pid, ordinaryPriority: 40, donations: [] }] } },
    ];
    for (const invalid of invalidStates) {
      const sync = canonical(target.sync.saveState()); const host = target.externalState(); const events = [...target.events];
      expect(() => target.sync.prepareRestore(invalid)).toThrow();
      expect(canonical(target.sync.saveState())).toBe(sync); expect(target.externalState()).toBe(host); expect(target.events).toEqual(events);
    }
  });
});


it('publishes separate stable monitor condition queues while KernelSnapshot copies only the eight base fields', () => {
  const kernel = createKernel(REFERENCE_CONFIG);
  const view = kernel.syncSubsystem.createMonitor(resource, ['changed']);
  if (!('conditions' in view) || !(view.conditions instanceof Map)) throw new Error('missing live monitor conditions');
  const conditions = view.conditions; const queue: unknown = conditions.get('changed');
  const saved = kernel.snapshot();
  expect(Object.keys(saved.syncPrimitives[0] ?? {}).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)).toEqual(
    ['capacity', 'displayName', 'holders', 'id', 'kind', 'ordered', 'value', 'waitQueue']);
  const pid = kernel.spawn({ name: 'condition actor', priority: 20, arrival: 0, burst: 100, service: 100, pages: 0 },
    { program: instructionProgram([{ kind: 'sync', operation: { op: 'monitor_enter', resource } },
      { kind: 'sync', operation: { op: 'cond_wait', monitor: resource, condition: 'changed' } }]), serialFraction: 1 });
  kernel.run(kernel.tuning.threadCreateTicks + 2);
  expect(view.conditions).toBe(conditions); expect(conditions.get('changed')).toBe(queue);
  expect(conditions.get('changed')).toEqual([pid]); expect(view.waitQueue).toEqual([]);
});

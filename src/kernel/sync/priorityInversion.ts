import type { KernelEvent, Pid, SyncSnapshotState, Tick } from '../types';
import { check, compareStrings, integer, sameActor, type Actor, type PrimitiveContext, type PrimitiveState, type SyncHost } from './SyncSubsystem';

type Priority = SyncSnapshotState['payload']['priorities'][number];
type Inversion = SyncSnapshotState['payload']['inversions'][number];
type SavedPriority = Pick<SyncSnapshotState['payload'], 'priorities' | 'inversions'>;

function owner(state: PrimitiveState | undefined): Actor | null {
  if (state?.kind === 'mutex' || state?.kind === 'monitor') return state.owner;
  return state?.kind === 'rwlock' ? state.writer : null;
}

function queue(state: PrimitiveState): readonly number[] {
  if (state.kind === 'mutex' || state.kind === 'monitor') return state.entryQueue;
  return state.kind === 'rwlock' ? state.waitQueue : [];
}

/** Ordinary aging is independent of exclusive-lock donations. */
export class PriorityInversion {
  private priorities = new Map<Pid, Priority>();
  private detected: Inversion[] = [];
  private projecting = false;

  constructor(private readonly host: SyncHost, private readonly ctx: PrimitiveContext) {}

  refresh(): void {
    const processes = this.host.processes().filter(pcb => pcb.pid > 1 && pcb.state !== 'zombie' && pcb.state !== 'terminated');
    const ordinary = new Map<Pid, number>();
    for (const pcb of processes) {
      const previous = this.priorities.get(pcb.pid);
      let value = previous?.ordinaryPriority ?? pcb.priority;
      if (previous !== undefined) {
        const released = previous.donations.some(donation => {
          const current = owner(this.ctx.get(donation.resource));
          return current === null || current.pid !== pcb.pid || current.tid !== donation.ownerTid;
        });
        if (released) value = pcb.basePriority;
        else if (!this.projecting && pcb.priority !== Math.min(value, ...previous.donations.map(donation => donation.priority))) value = pcb.priority;
      }
      ordinary.set(pcb.pid, value);
    }
    const edges = this.edges();
    const effective = new Map(ordinary);
    if (this.host.settings().priorityInheritance) {
      // A finite minimum propagation also handles chains without treating them as cycles to detect.
      for (let pass = 0; pass < processes.length; pass++) {
        let changed = false;
        for (const edge of edges) {
          const donor = effective.get(edge.wait.actor.pid); const held = effective.get(edge.owner.pid);
          if (donor !== undefined && held !== undefined && donor < held) { effective.set(edge.owner.pid, donor); changed = true; }
        }
        if (!changed) break;
      }
    }
    const next = new Map<Pid, Priority>();
    for (const pcb of processes) {
      const normal = ordinary.get(pcb.pid); check(normal !== undefined, 'missing ordinary priority');
      const donations: Priority['donations'][number][] = [];
      if (this.host.settings().priorityInheritance) for (const edge of edges) {
        if (edge.owner.pid !== pcb.pid) continue;
        const priority = effective.get(edge.wait.actor.pid);
        if (priority !== undefined && priority < normal) donations.push({ resource: edge.resource,
          ownerTid: edge.owner.tid, waitGeneration: edge.wait.generation, priority });
      }
      if (donations.length > 0) next.set(pcb.pid, { pid: pcb.pid, ordinaryPriority: normal, donations });
      if (!this.projecting) pcb.priority = Math.min(normal, ...donations.map(donation => donation.priority));
      else if (this.priorities.has(pcb.pid) && !next.has(pcb.pid)) pcb.priority = normal;
    }
    this.priorities = next;
  }

  detect(): void {
    this.refresh();
    const next: Inversion[] = [];
    const seen = new Set<string>();
    const running = this.host.processes().filter(pcb => pcb.pid > 1 && pcb.state === 'running');
    for (const edge of this.edges()) {
      const blocked = this.host.process(edge.wait.actor.pid); const holder = this.host.process(edge.owner.pid);
      if (blocked === undefined || holder?.state !== 'ready' || holder.priority <= blocked.priority) continue;
      for (const middle of running) {
        if (!(blocked.priority < middle.priority && middle.priority < holder.priority)) continue;
        const key = `${blocked.pid}:${holder.pid}:${middle.pid}`;
        if (!seen.has(key)) { seen.add(key); next.push({ blocked: blocked.pid, holder: holder.pid, interposed: middle.pid }); }
      }
    }
    this.detected = next.sort((a, b) => a.blocked - b.blocked || a.holder - b.holder || a.interposed - b.interposed);
  }

  beforeAging(): void {
    if (this.projecting) return;
    this.refresh(); this.projecting = true;
    for (const record of this.priorities.values()) {
      const pcb = this.host.process(record.pid);
      if (pcb !== undefined && pcb.state !== 'zombie' && pcb.state !== 'terminated') pcb.priority = record.ordinaryPriority;
    }
  }

  afterAging(): void {
    if (this.projecting) {
      for (const [pid, record] of this.priorities) {
        const pcb = this.host.process(pid);
        if (pcb === undefined || pcb.state === 'zombie' || pcb.state === 'terminated') this.priorities.delete(pid);
        else this.priorities.set(pid, { ...record, ordinaryPriority: pcb.priority });
      }
      this.projecting = false;
    }
    this.refresh();
  }

  /** Event observers see effective priorities without closing the surrounding aging pass. */
  withEffectivePriorities<T>(callback: () => T): T {
    const resumeAging = this.projecting;
    if (resumeAging) this.afterAging();
    try { return callback(); }
    finally { if (resumeAging) this.beforeAging(); }
  }

  observe(event: KernelEvent): void {
    if (event.type === 'process.state_changed' && event.to === 'running') {
      const record = this.priorities.get(event.pid); const pcb = this.host.process(event.pid);
      if (record !== undefined && pcb !== undefined) this.priorities.set(event.pid, { ...record, ordinaryPriority: pcb.basePriority });
      this.refresh();
    } else if (event.type === 'process.exited') this.cleanup(event.pid);
  }

  cleanup(pid: Pid): void {
    const record = this.priorities.get(pid); const pcb = this.host.process(pid);
    if (record !== undefined && pcb !== undefined) pcb.priority = pcb.basePriority;
    this.priorities.delete(pid);
    this.detected = this.detected.filter(row => row.blocked !== pid && row.holder !== pid && row.interposed !== pid);
    this.refresh();
  }

  inversions(): readonly Inversion[] { return this.detected.map(row => ({ ...row })); }

  saveState(): SavedPriority {
    check(!this.projecting, 'cannot snapshot an unfinished priority projection');
    return { priorities: [...this.priorities.values()].sort((a, b) => a.pid - b.pid).map(clonePriority), inversions: this.inversions() };
  }

  save(): SavedPriority { return this.saveState(); }

  /** Validate and install internal records only; the host applies the projection at commit. */
  restoreState(state: SavedPriority, tick: Tick = this.host.tick()): void {
    const next = new Map<Pid, Priority>();
    for (const record of state.priorities) {
      const pcb = this.host.process(record.pid);
      check(pcb !== undefined && integer(record.pid, 2) && !next.has(record.pid) && integer(record.ordinaryPriority) && record.ordinaryPriority <= 39, 'ordinary priority');
      const generations = new Set<number>();
      for (const donation of record.donations) {
        const primitive = this.ctx.get(donation.resource); const held = owner(primitive); const wait = this.ctx.wait(donation.waitGeneration);
        check(integer(donation.ownerTid) && integer(donation.priority) && donation.priority < record.ordinaryPriority
          && integer(donation.waitGeneration) && !generations.has(donation.waitGeneration), 'priority donation');
        check(held?.pid === record.pid && held.tid === donation.ownerTid && primitive !== undefined
          && queue(primitive).includes(donation.waitGeneration), 'donation owner or queue');
        check(wait?.resource === donation.resource && wait.requestedAt <= tick && !sameActor(wait.actor, held), 'donation waiter');
        generations.add(donation.waitGeneration);
      }
      next.set(record.pid, clonePriority(record));
    }
    const inversions: Inversion[] = []; const keys = new Set<string>();
    for (const row of state.inversions) {
      check([row.blocked, row.holder, row.interposed].every(pid => integer(pid, 2) && this.host.process(pid) !== undefined)
        && new Set([row.blocked, row.holder, row.interposed]).size === 3, 'inversion actors');
      const key = `${row.blocked}:${row.holder}:${row.interposed}`; check(!keys.has(key), 'duplicate inversion'); keys.add(key); inversions.push({ ...row });
    }
    this.priorities = next; this.detected = inversions; this.projecting = false;
  }

  restore(state: SavedPriority, tick: Tick = this.host.tick()): void { this.restoreState(state, tick); }

  private edges() {
    return [...this.ctx.allPrimitives()].sort((a, b) => compareStrings(a.id, b.id)).flatMap(state => {
      const held = owner(state); if (held === null) return [];
      return queue(state).flatMap(generation => {
        const wait = this.ctx.wait(generation);
        return wait === undefined || this.ctx.reserved(generation) || sameActor(held, wait.actor)
          ? [] : [{ resource: state.id, owner: held, wait }];
      });
    });
  }
}

function clonePriority(record: Priority): Priority {
  return { ...record, donations: record.donations.map(donation => ({ ...donation })) };
}

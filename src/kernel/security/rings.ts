import type { EmittableEvent } from '../EventBus';
import type { DomainId, Pid, ProtectionRing, SecuritySnapshotState } from '../types';
import type { MutableSecurityPayload } from './accessMatrix';

export interface RingHost { state(): SecuritySnapshotState['payload']; emit(event: EmittableEvent): void }
export class Rings {
  constructor(private readonly host: RingHost) {}
  private process(pid: Pid) {
    const process = (this.host.state() as MutableSecurityPayload).processes.find(item => item.pid === pid);
    if (process === undefined || !process.active) throw new RangeError('unknown active security process'); return process;
  }
  private event(pid: Pid, fromRing: ProtectionRing, toRing: ProtectionRing, blocked: boolean): void {
    this.host.emit({ type: 'security.escalation_attempt', pid, fromRing, toRing, blocked });
  }
  setRing(pid: Pid, target: ProtectionRing): false { this.event(pid, this.process(pid).ring, target, true); return false; }
  callGate(pid: Pid, ceiling: ProtectionRing, target: ProtectionRing): boolean {
    const process = this.process(pid), blocked = process.ring > ceiling;
    if (blocked) { this.event(pid, process.ring, target, true); return false; }
    // An ordinary outward call runs at the current ring; only trap return exits.
    if (target >= process.ring) { this.event(pid, process.ring, target, false); return true; }
    return this.enterTrap(pid, ceiling, target) !== null;
  }
  enterTrap(pid: Pid, ceiling: ProtectionRing = 3, target: ProtectionRing = 0): number | null {
    const state = this.host.state() as MutableSecurityPayload, process = this.process(pid), from = process.ring;
    if (from > ceiling || target > from) { this.event(pid, from, target, true); return null; }
    const id = state.nextTrapId++;
    process.traps.push({ id, savedDomain: process.domain, savedRing: from, committedReturn: null });
    process.ring = target; if (target === 0) process.domain = 'domain:kernel' as DomainId;
    this.event(pid, from, target, false); return id;
  }
  returnTrap(pid: Pid, requestedRing?: ProtectionRing): boolean {
    const process = this.process(pid), frame = process.traps.at(-1);
    if (frame === undefined) { this.event(pid, process.ring, requestedRing ?? process.ring, true); return false; }
    const target = frame.committedReturn?.ring ?? requestedRing ?? frame.savedRing;
    if (frame.committedReturn === null && target !== frame.savedRing) { this.event(pid, process.ring, target, true); return false; }
    const from = process.ring; process.traps.pop(); process.ring = target;
    process.domain = frame.committedReturn?.domain ?? frame.savedDomain;
    this.event(pid, from, target, false); return true;
  }
  canAccessPage(pid: Pid, requiredRing: ProtectionRing): boolean { return this.process(pid).ring <= requiredRing; }
  assertInvariants(): void {
    for (const process of this.host.state().processes) {
      if (!process.active && process.traps.length !== 0) throw new Error('I-34: exited process retained a trap');
      let last: number = 3;
      for (const frame of process.traps) {
        if (frame.savedRing > last) throw new Error('I-34: trap rings are not non-increasing'); last = frame.savedRing;
      }
      if (process.active && process.ring === 0 && process.domain !== 'domain:kernel' && process.traps.length === 0) throw new Error('I-35: user process outside a trap entered ring zero');
    }
  }
}

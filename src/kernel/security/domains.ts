import type { EmittableEvent } from '../EventBus';
import type { DomainId, Pid, ProtectionRing, SecuritySnapshotState } from '../types';
import { canonicalDomain, type MutableSecurityPayload } from './accessMatrix';
import { roleEligible } from './rbac';

export { canonicalDomain } from './accessMatrix';
export interface DomainHost {
  state(): SecuritySnapshotState['payload'];
  check(domain: DomainId, object: string, right: 'control' | 'execute'): boolean;
  emit(event: EmittableEvent): void;
}
export function processState(state: SecuritySnapshotState['payload'], pid: Pid) {
  return (state as MutableSecurityPayload).processes.find(process => process.pid === pid);
}
export function callerIdentity(state: SecuritySnapshotState['payload'], pid: Pid): { domain: DomainId; ring: ProtectionRing } | null {
  const process = processState(state, pid); if (process === undefined) return null;
  const frame = process.traps[0]; return frame === undefined ? { domain: canonicalDomain(process.domain), ring: process.ring }
    : { domain: canonicalDomain(frame.committedReturn?.domain ?? frame.savedDomain), ring: frame.committedReturn?.ring ?? frame.savedRing };
}
export function commitDomainReturn(host: DomainHost, pid: Pid, target: DomainId, reason: 'exec' | 'explicit_switch'): boolean {
  const state = host.state(), process = processState(state, pid), domain = state.domains.find(item => item.id === canonicalDomain(target));
  if (process === undefined || domain === undefined || !process.active) return false;
  const caller = callerIdentity(state, pid)!;
  const blocked = reason === 'explicit_switch' && (!host.check(caller.domain, domain.id, 'control') || !roleEligible(state.roles, process.roles, domain.id));
  host.emit({ type: 'security.escalation_attempt', pid, fromRing: caller.ring, toRing: domain.ring, blocked });
  if (blocked) return false;
  const frame = process.traps[0];
  if (frame === undefined) { process.domain = domain.id; process.ring = domain.ring; }
  else frame.committedReturn = { domain: domain.id, ring: domain.ring, reason };
  return true;
}

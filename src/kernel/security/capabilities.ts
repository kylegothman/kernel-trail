import type { AccessRight, DomainId, SecuritySnapshotState } from '../types';
import { canonicalRights, rightsInclude } from './acl';

export type Capability = SecuritySnapshotState['payload']['capabilities'][number]['entries'][number];
export type Sealer = (domain: DomainId, object: string, rights: readonly AccessRight[]) => number;
export type CapabilityVerifier = (domain: DomainId, capability: Capability) => boolean;
import { fnv1a32 } from '../rng';
export { fnv1a32 } from '../rng';
/** Only the owning subsystem supplies sealing material; no helper retains it. */
export function sealCapability(object: string, rights: readonly AccessRight[], domain: DomainId, material: number): number {
  return fnv1a32(`${object}|${canonicalRights(rights).join(',')}|${domain}|${material}`);
}
export function verifyCapability(capability: Capability, domain: DomainId, material: number): boolean {
  if (typeof capability.object !== 'string' || !Array.isArray(capability.rights)) return false;
  try { if (canonicalRights(capability.rights).join(',') !== capability.rights.join(',')) return false; } catch { return false; }
  return Number.isInteger(capability.seal) && capability.seal >= 0 && capability.seal <= 0xffffffff
    && capability.seal === sealCapability(capability.object, capability.rights, domain, material);
}
export function buildCapabilities(domains: SecuritySnapshotState['payload']['domains'], seal: Sealer): SecuritySnapshotState['payload']['capabilities'] {
  return [...domains].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(domain => ({ domain: domain.id,
    entries: domain.rights.filter(cell => cell.rights.length > 0).map(cell => ({ object: cell.object, rights: canonicalRights(cell.rights),
      seal: seal(domain.id, cell.object, canonicalRights(cell.rights)) })).sort((a, b) => a.object < b.object ? -1 : a.object > b.object ? 1 : 0) }));
}
export function capabilityCheck(lists: SecuritySnapshotState['payload']['capabilities'], domain: DomainId, object: string,
  right: AccessRight, verify: CapabilityVerifier, presented?: Capability): boolean {
  const active = lists.find(row => row.domain === domain)?.entries.find(entry => entry.object === object);
  if (active === undefined || !verify(domain, active) || !rightsInclude(active.rights, right)) return false;
  if (presented === undefined) return true;
  return presented.object === active.object && presented.seal === active.seal && presented.rights.join(',') === active.rights.join(',')
    && verify(domain, presented) && rightsInclude(presented.rights, right);
}

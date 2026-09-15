import type { AccessRight, DomainId, ProtectionDomain, ProtectionRing, SecuritySnapshotState } from '../types';
import { ACCESS_RIGHTS, aclCheck, buildAcl, canonicalRights, effectiveRights, rightsInclude } from './acl';
import { buildCapabilities, capabilityCheck, type CapabilityVerifier, type Sealer } from './capabilities';

type Mutable<T> = T extends string | number | boolean | null ? T : T extends readonly (infer U)[] ? Mutable<U>[] : { -readonly [K in keyof T]: Mutable<T[K]> };
export type MutableSecurityPayload = Mutable<SecuritySnapshotState['payload']>;
export const canonicalDomain = (domain: DomainId): DomainId => domain === 'kernel' ? 'domain:kernel' as DomainId : domain;

/** Sparse authoritative rows plus materialized ACL and capability projections. */
export class AccessMatrix {
  readonly domains = new Map<DomainId, ProtectionDomain>();
  private readonly viewRights = new Map<DomainId, Map<string, readonly AccessRight[]>>();
  constructor(private readonly getState: () => SecuritySnapshotState['payload'], private readonly seal: Sealer,
    private readonly verify: CapabilityVerifier) { this.refreshViews(); }
  private get state(): MutableSecurityPayload { return this.getState() as MutableSecurityPayload; }
  defineDomain(id: DomainId, displayName: string, ring: ProtectionRing): void {
    id = canonicalDomain(id);
    if (!Number.isInteger(ring) || ring < 0 || ring > 3 || id.length === 0) throw new RangeError('invalid protection domain');
    const prior = this.state.domains.find(domain => domain.id === id);
    if (prior === undefined) this.state.domains.push({ id, displayName, ring, rights: [] });
    else { prior.displayName = displayName; prior.ring = ring; }
    this.state.domains.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0); this.rebuild();
  }
  rights(domain: DomainId, object: string): AccessRight[] {
    return effectiveRights(this.state.domains.find(row => row.id === canonicalDomain(domain))?.rights.find(cell => cell.object === object)?.rights ?? []);
  }
  check(domain: DomainId, object: string, right: AccessRight): boolean {
    domain = canonicalDomain(domain);
    return this.state.accessModel === 'acl' ? aclCheck(this.state.acl, domain, object, right)
      : capabilityCheck(this.state.capabilities, domain, object, right, this.verify);
  }
  setRights(domain: DomainId, object: string, rights: readonly AccessRight[], transferableRights: readonly AccessRight[] = []): void {
    const row = this.state.domains.find(item => item.id === canonicalDomain(domain));
    if (row === undefined) throw new RangeError('unknown protection domain');
    const ordered = canonicalRights(rights), transferable = canonicalRights(transferableRights);
    if (object.length === 0 || transferable.some(right => !ordered.includes(right))) throw new RangeError('invalid access matrix cell');
    row.rights = row.rights.filter(cell => cell.object !== object);
    if (ordered.length > 0) row.rights.push({ object, rights: ordered, transferableRights: transferable });
    row.rights.sort((a, b) => a.object < b.object ? -1 : a.object > b.object ? 1 : 0); this.rebuild();
  }
  grant(domain: DomainId, object: string, rights: readonly AccessRight[], transferableRights: readonly AccessRight[] = []): void {
    const prior = this.state.domains.find(row => row.id === canonicalDomain(domain))?.rights.find(cell => cell.object === object);
    this.setRights(domain, object, [...prior?.rights ?? [], ...rights], [...prior?.transferableRights ?? [], ...transferableRights]);
  }
  revoke(domain: DomainId, object: string, rights: readonly AccessRight[]): void {
    const prior = this.state.domains.find(row => row.id === canonicalDomain(domain))?.rights.find(cell => cell.object === object);
    if (prior === undefined) return;
    this.setRights(domain, object, prior.rights.filter(right => !rights.includes(right)), prior.transferableRights.filter(right => !rights.includes(right)));
  }
  grantAs(actor: DomainId, recipient: DomainId, object: string, rights: readonly AccessRight[]): boolean {
    if (!this.check(actor, object, 'owner') && !this.check(actor, canonicalDomain(recipient), 'control')) return false;
    this.grant(recipient, object, rights); return true;
  }
  revokeAs(actor: DomainId, recipient: DomainId, object: string, rights: readonly AccessRight[]): boolean {
    if (!this.check(actor, object, 'owner') && !this.check(actor, canonicalDomain(recipient), 'control')) return false;
    this.revoke(recipient, object, rights); return true;
  }
  copy(from: DomainId, to: DomainId, object: string, rights: readonly AccessRight[]): boolean {
    const held = this.state.domains.find(row => row.id === canonicalDomain(from))?.rights.find(cell => cell.object === object);
    if (held === undefined || !rightsInclude(held.rights, 'copy') || rights.some(right => !rightsInclude(held.rights, right)
      || !held.transferableRights.includes(right))) return false;
    this.grant(to, object, rights); return true;
  }
  switchModel(model: 'acl' | 'capability'): void { this.state.accessModel = model; this.rebuild(); }
  rebuild(): void {
    this.state.acl = buildAcl(this.state.domains) as MutableSecurityPayload['acl'];
    this.state.capabilities = buildCapabilities(this.state.domains, this.seal) as MutableSecurityPayload['capabilities'];
    this.refreshViews();
  }
  refreshViews(): void {
    const ids = new Set(this.state.domains.map(domain => domain.id));
    for (const id of this.domains.keys()) if (!ids.has(id)) { this.domains.delete(id); this.viewRights.delete(id); }
    for (const domain of this.state.domains) {
      const prior = this.domains.get(domain.id), rights = this.viewRights.get(domain.id) ?? new Map<string, readonly AccessRight[]>();
      this.viewRights.set(domain.id, rights);
      rights.clear(); for (const cell of domain.rights) rights.set(cell.object, [...cell.rights]);
      if (prior !== undefined && prior.displayName === domain.displayName && prior.ring === domain.ring) continue;
      this.domains.set(domain.id, { id: domain.id, displayName: domain.displayName, ring: domain.ring, rights });
    }
  }
  assertEquivalent(): void {
    if (JSON.stringify(this.state.acl) !== JSON.stringify(buildAcl(this.state.domains))
      || JSON.stringify(this.state.capabilities) !== JSON.stringify(buildCapabilities(this.state.domains, this.seal)))
      throw new Error('I-36: ACL and capability projections disagree');
    const objects = new Set([...this.state.domains.flatMap(row => row.rights.map(cell => cell.object)), ...this.state.acl.map(column => column.object),
      ...this.state.capabilities.flatMap(row => row.entries.map(entry => entry.object))]);
    for (const domain of this.state.domains) for (const object of objects) for (const right of ACCESS_RIGHTS) {
      const expected = rightsInclude(domain.rights.find(cell => cell.object === object)?.rights ?? [], right);
      if (aclCheck(this.state.acl, domain.id, object, right) !== expected
        || capabilityCheck(this.state.capabilities, domain.id, object, right, this.verify) !== expected) throw new Error('I-36: ACL and capability projections disagree');
    }
  }
}

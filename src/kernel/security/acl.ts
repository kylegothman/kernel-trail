import type { AccessRight, DomainId, SecuritySnapshotState } from '../types';

export const ACCESS_RIGHTS: readonly AccessRight[] = ['read', 'write', 'execute', 'owner', 'copy', 'control'];
export function canonicalRights(rights: readonly AccessRight[]): AccessRight[] {
  if (rights.some(right => !ACCESS_RIGHTS.includes(right))) throw new RangeError('unknown access right');
  return ACCESS_RIGHTS.filter(right => rights.includes(right));
}
export function effectiveRights(rights: readonly AccessRight[]): AccessRight[] {
  return rights.includes('owner') ? [...ACCESS_RIGHTS] : canonicalRights(rights);
}
export function rightsInclude(rights: readonly AccessRight[], right: AccessRight): boolean {
  return rights.includes('owner') || rights.includes(right);
}
export function buildAcl(domains: SecuritySnapshotState['payload']['domains']): SecuritySnapshotState['payload']['acl'] {
  const columns = new Map<string, { domain: DomainId; rights: AccessRight[] }[]>();
  for (const domain of domains) for (const cell of domain.rights) {
    if (cell.rights.length === 0) continue;
    const column = columns.get(cell.object) ?? [];
    column.push({ domain: domain.id, rights: canonicalRights(cell.rights) }); columns.set(cell.object, column);
  }
  return [...columns].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([object, entries]) => ({ object,
    entries: entries.sort((a, b) => a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0) }));
}
export function aclCheck(acl: SecuritySnapshotState['payload']['acl'], domain: DomainId, object: string, right: AccessRight): boolean {
  return rightsInclude(acl.find(column => column.object === object)?.entries.find(entry => entry.domain === domain)?.rights ?? [], right);
}

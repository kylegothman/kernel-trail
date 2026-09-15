import { KernelConfigError } from '../errors';
import type { DomainId, SecuritySnapshotState } from '../types';

export type Role = SecuritySnapshotState['payload']['roles'][number];
const domain = (value: string) => value as DomainId;
export function defaultRoles(userDomains: readonly DomainId[] = [domain('domain:user_ro'), domain('domain:user'), domain('domain:spool')]): Role[] {
  return [
    { id: 'guest', displayName: 'Guest', domains: [domain('domain:user_ro')], inherits: [] },
    { id: 'user', displayName: 'User', domains: [domain('domain:user')], inherits: ['guest'] },
    { id: 'operator', displayName: 'Operator', domains: [domain('domain:user'), domain('domain:spool')], inherits: ['user'] },
    { id: 'driver', displayName: 'Driver', domains: [domain('domain:driver')], inherits: [] },
    { id: 'admin', displayName: 'Administrator', domains: [...userDomains], inherits: ['operator'] },
    { id: 'kernel', displayName: 'Kernel', domains: [domain('domain:kernel')], inherits: [] },
  ];
}
export function validateRoles(roles: readonly Role[]): void {
  const byId = new Map(roles.map(role => [role.id, role]));
  if (byId.size !== roles.length) throw new KernelConfigError('duplicate security role');
  const complete = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string) => {
    if (complete.has(id)) return;
    if (visiting.has(id)) throw new KernelConfigError('cyclic security role inheritance');
    const role = byId.get(id); if (role === undefined) throw new KernelConfigError('unknown inherited security role');
    visiting.add(id); for (const parent of role.inherits) visit(parent); visiting.delete(id); complete.add(id);
  };
  for (const role of roles) visit(role.id);
}
export function roleDomains(roles: readonly Role[], selected: readonly string[]): DomainId[] {
  validateRoles(roles); const byId = new Map(roles.map(role => [role.id, role])), visited = new Set<string>(), result = new Set<DomainId>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    const role = byId.get(id); if (role === undefined) throw new KernelConfigError('unknown assigned security role');
    visited.add(id); for (const value of role.domains) result.add(value); for (const parent of role.inherits) visit(parent);
  };
  for (const id of selected) visit(id); return [...result].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}
export function roleEligible(roles: readonly Role[], selected: readonly string[], target: DomainId): boolean {
  return roleDomains(roles, selected).includes(target);
}

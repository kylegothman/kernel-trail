import type { AccessRight, Pid, SecuritySnapshotState } from '../types';
import { effectiveRights } from './acl';
import { canonicalDomain, type MutableSecurityPayload } from './accessMatrix';

export function recordUse(state: SecuritySnapshotState['payload'], pid: Pid, object: string, right: AccessRight): void {
  const process = (state as MutableSecurityPayload).processes.find(item => item.pid === pid);
  if (process === undefined || process.usedRights.some(item => item.object === object && item.right === right)) return;
  process.usedRights.push({ object, right });
  process.usedRights.sort((a, b) => a.object < b.object ? -1 : a.object > b.object ? 1 : a.right < b.right ? -1 : a.right > b.right ? 1 : 0);
}
export function privilegeExcess(state: SecuritySnapshotState['payload']): { total: number; byPid: ReadonlyMap<Pid, number>; unusedRights: readonly string[] } {
  const byPid = new Map<Pid, number>(), unusedRights: string[] = []; let total = 0;
  for (const process of [...state.processes].sort((a, b) => a.pid - b.pid)) {
    const held = state.domains.find(domain => domain.id === canonicalDomain(process.domain))?.rights ?? [];
    let excess = 0;
    for (const cell of held) for (const right of effectiveRights(cell.rights)) {
      if (process.usedRights.some(used => used.object === cell.object && used.right === right)) continue;
      excess++; unusedRights.push(`${process.pid}:${cell.object}:${right}`);
    }
    byPid.set(process.pid, excess); total += excess;
  }
  return { total, byPid, unusedRights };
}

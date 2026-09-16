import type { ConvoyMemberId, Tick } from '@kernel/index';
import type { Affliction, AfflictionId, AfflictionRemedy, ConvoyMember, DifficultyTier } from '../types';
import { TIER_TABLE } from '../tiers';
import { makeAffliction } from './table';

export interface AfflictionTickResult {
  readonly drained: ReadonlyMap<ConvoyMemberId, number>;
  readonly fatal: readonly { readonly member: ConvoyMemberId; readonly id: AfflictionId }[];
}
/** Pure report; the director applies each member's combined drain once inside mutate. */
export function tickAfflictions(convoy: readonly ConvoyMember[], at: Tick, tier: DifficultyTier = 'operator'): AfflictionTickResult {
  const drained = new Map<ConvoyMemberId, number>();
  const fatal: { member: ConvoyMemberId; id: AfflictionId }[] = [];
  const factors = TIER_TABLE[tier];
  for (const member of [...convoy].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (member.status === 'derezzed' || member.integrity <= 0) continue;
    const afflictions = [...member.afflictions].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const expired = afflictions.find(a => a.fatalAfter !== null && at - a.acquiredAtTick >= Math.ceil(a.fatalAfter * factors.fatalAfter));
    if (expired !== undefined) fatal.push({ member: member.id, id: expired.id });
    else drained.set(member.id, afflictions.reduce((sum, a) => sum + a.drainPerTick, 0) * factors.afflictionDrain);
  }
  return { drained, fatal };
}
/** Mutation helpers accept only members inside a caller-owned mutate callback. */
export function acquire(member: ConvoyMember, id: AfflictionId, at: Tick): boolean {
  if (member.status === 'derezzed' || member.integrity <= 0 || member.afflictions.some(a => a.id === id)) return false;
  member.afflictions.push(makeAffliction(id, at));
  return true;
}
export function cure(member: ConvoyMember, id: AfflictionId): boolean {
  const index = member.afflictions.findIndex(a => a.id === id);
  if (index < 0) return false;
  member.afflictions.splice(index, 1);
  return true;
}
export function isCuredBy(a: Affliction, action: AfflictionRemedy): boolean {
  const remedy = a.remedy;
  switch (remedy.kind) {
    case 'set_scheduler': return action.kind === remedy.kind && action.to === remedy.to;
    case 'set_replacement': return action.kind === remedy.kind && action.to === remedy.to;
    case 'set_disk_policy': return action.kind === remedy.kind && action.to === remedy.to;
    case 'set_allocation': return action.kind === remedy.kind && action.to === remedy.to;
    case 'adjust_quantum': return action.kind === remedy.kind && action.direction === remedy.direction;
    case 'reduce_degree': return action.kind === remedy.kind && action.by >= remedy.by;
    case 'spend': return action.kind === remedy.kind && action.resource === remedy.resource && action.amount >= remedy.amount;
    case 'terminal': return action.kind === remedy.kind && action.command === remedy.command;
    case 'ability': return action.kind === remedy.kind && action.member === remedy.member;
  }
}

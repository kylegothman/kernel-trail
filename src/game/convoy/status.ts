import type { ConvoyMember, ConvoyRole, ConvoyStatus } from '../types';

/** Narrative bible 3's active ability charges, restored at each leg boundary. */
export const PER_LEG_ABILITY_CHARGES: Readonly<Record<ConvoyRole, number>> = {
  compiler: 2, sentinel: 2, codec: 3, courier: 2, cartographer: 2,
};
export function statusFor(integrity: number): ConvoyStatus {
  if (integrity <= 0) return 'derezzed';
  if (integrity < 25) return 'critical';
  if (integrity < 70) return 'degraded';
  return 'nominal';
}
export function aliveMembers(convoy: readonly ConvoyMember[]): readonly ConvoyMember[] {
  return convoy.filter(member => member.integrity > 0 && member.status !== 'derezzed');
}
export function lowestIntegrityAlive(convoy: readonly ConvoyMember[]): ConvoyMember | null {
  return [...aliveMembers(convoy)].sort((a, b) => a.integrity - b.integrity || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] ?? null;
}
/** Invoke only inside the caller's runStore.mutate callback for store-owned members. */
export function applyIntegrity(member: ConvoyMember, delta: number): void {
  member.integrity = Math.max(0, Math.min(100, member.integrity + delta));
  member.status = statusFor(member.integrity);
}

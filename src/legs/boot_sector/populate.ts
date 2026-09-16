/**
 * Five processes, one per convoy Program, and no workload: the Boot Sector is
 * the only leg where the convoy is alone on the machine, which is what makes
 * the CPU pillar's flat kernel counter readable. No resources and no sync
 * primitives are declared; there is nothing to contend for.
 */
import type { ConvoyMemberId } from '@kernel/types';
import type { LegSetupContext } from '@game/types';

export interface RosterEntry {
  readonly member: ConvoyMemberId;
  readonly name: string;
  readonly priority: number;
}

export const ROSTER: readonly RosterEntry[] = [
  { member: 'lumen', name: 'LUMEN', priority: 2 },
  { member: 'sable', name: 'SABLE', priority: 2 },
  { member: 'orrery', name: 'ORRERY', priority: 3 },
  { member: 'kestrel', name: 'KESTREL', priority: 3 },
  { member: 'vesper', name: 'VESPER', priority: 3 },
];

/** Staggered so beat 3's lighting order matches the process table order. */
export const ARRIVAL_STAGGER = 2;

export function populate(ctx: LegSetupContext): void {
  ROSTER.forEach(({ member, name, priority }, i) => {
    const pid = ctx.spawn({
      name,
      priority,
      burst: 4,
      service: 12,
      arrival: i * ARRIVAL_STAGGER,
      pages: 4,
    });
    ctx.bind(member, pid);
  });
}

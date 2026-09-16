/**
 * KERNEL TRAIL: the Allocation Yards' population.
 *
 * Five address spaces needing contiguous berths, plus the yard's own traffic.
 * Every process that runs a reference string touches pages 0, 1 and 2 only,
 * because with `vm` off a touch on a page the admission pass did not map
 * throws out of the kernel step rather than faulting (pre-flight finding 2).
 * Three pages is the rations floor under every setting of the dial, so the
 * reference strings are safe at generous, standard, lean and starved alike.
 *
 * Exactly seven processes arrive at tick 0 and the yard seats exactly seven,
 * so the transients that arrive later are refused with
 * `memory.allocation_failed`. They carry no reference string, so a refused
 * transient computes rather than touching memory it does not have.
 */
import type { ConvoyMemberId } from '@kernel/types';
import type { LegSetupContext, ProcessSpec } from '@game/types';
import { FRAMES_PER_PROCESS } from './config';

/** Pages every running process actually touches, which is the frame budget. */
export const TOUCHED_PAGES = FRAMES_PER_PROCESS;

/** Pages 0, 1 and 2 in turn, one access per service tick. */
export function localLoop(service: number): readonly number[] {
  return Array.from({ length: service }, (_, index) => index % TOUCHED_PAGES);
}

export interface ConvoySpawn {
  readonly member: ConvoyMemberId;
  readonly name: string;
  readonly priority: number;
  readonly burst: number;
  readonly service: number;
  readonly pages: number;
}

/** The convoy, with the package's page counts: VESPER's remap is the strongest single move in the leg. */
export const CONVOY: readonly ConvoySpawn[] = [
  { member: 'lumen', name: 'LUMEN', priority: 2, burst: 6, service: 64, pages: 12 },
  { member: 'sable', name: 'SABLE', priority: 2, burst: 5, service: 58, pages: 10 },
  { member: 'orrery', name: 'ORRERY', priority: 3, burst: 5, service: 58, pages: 10 },
  { member: 'kestrel', name: 'KESTREL', priority: 3, burst: 4, service: 52, pages: 8 },
  { member: 'vesper', name: 'VESPER', priority: 3, burst: 5, service: 58, pages: 11 },
];

export interface YardSpawn {
  readonly name: string;
  readonly arrival: number;
  readonly pages: number;
  readonly service: number;
  /** A resident runs a reference string; a transient computes and departs. */
  readonly resident: boolean;
}

/**
 * The yard's own traffic. Two residents hold berths for the width of the leg;
 * five transients arrive on the package's schedule and are refused, because
 * the yard is already full when they get there.
 */
export const YARD: readonly YardSpawn[] = [
  { name: 'yard.resident_a', arrival: 0, pages: 3, service: 200, resident: true },
  { name: 'yard.resident_b', arrival: 0, pages: 3, service: 200, resident: true },
  { name: 'yard.transient_a', arrival: 12, pages: 4, service: 6, resident: false },
  { name: 'yard.transient_b', arrival: 20, pages: 3, service: 6, resident: false },
  { name: 'yard.transient_c', arrival: 28, pages: 2, service: 6, resident: false },
  { name: 'yard.transient_d', arrival: 36, pages: 4, service: 6, resident: false },
  { name: 'yard.transient_e', arrival: 44, pages: 3, service: 6, resident: false },
];

export const SPAWN_COUNT = CONVOY.length + YARD.length;

export function populate(ctx: LegSetupContext): void {
  for (const spawn of CONVOY) {
    const spec: ProcessSpec = {
      name: spawn.name, priority: spawn.priority, burst: spawn.burst,
      service: spawn.service, arrival: 0, pages: spawn.pages,
      referenceString: localLoop(spawn.service),
    };
    ctx.bind(spawn.member, ctx.spawn(spec));
  }
  for (const spawn of YARD) {
    ctx.spawn({
      name: spawn.name, priority: 4, burst: spawn.resident ? 4 : 3,
      service: spawn.service, arrival: spawn.arrival, pages: spawn.pages,
      referenceString: spawn.resident ? localLoop(spawn.service) : [],
    });
  }
  // No declareResource and no declareSync. There is no contention in the
  // Yards; the leg's whole subject is placement.
}

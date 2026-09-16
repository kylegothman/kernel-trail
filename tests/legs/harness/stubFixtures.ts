/**
 * WP-20 section 7.3: legs that have not supplied `tests/legs/<leg_id>/fixtures.ts`
 * get a throwing stub, enumerated so the report can list exactly which
 * fixtures are still owed and by which package.
 */
import { existsSync } from 'node:fs';
import { LEG_ORDER, type LegId } from '@game/types';
import { fixturePath } from './fixtureContract';

const OWNER: Readonly<Record<LegId, string>> = {
  boot_sector: 'WP-L00', fork_fields: 'WP-L01', the_weave: 'WP-L02', quantum_pass: 'WP-L03', the_narrows: 'WP-L04',
  the_cistern: 'WP-L05', the_gridlock: 'WP-L06', allocation_yards: 'WP-L07', drowned_reach: 'WP-L08', the_platters: 'WP-L09',
  the_bus: 'WP-L10', the_archive: 'WP-L11', arbiter_wall: 'WP-L12', the_portal: 'WP-L13',
};

export function fixtureOwner(id: LegId): string {
  return OWNER[id];
}

export function stubFor(id: LegId): () => never {
  return () => {
    throw new Error(`fixture owed: tests/legs/${id}/fixtures.ts is written by ${OWNER[id]} and has not shipped`);
  };
}

/** One throwing stub per leg; a leg that ships its fixtures makes its stub unreachable. */
export const STUB_FIXTURES: Readonly<Record<LegId, () => never>> = Object.fromEntries(LEG_ORDER.map((id) => [id, stubFor(id)])) as Record<LegId, () => never>;

export function fixtureStatus(id: LegId): 'present' | 'stubbed' {
  return existsSync(fixturePath(id)) ? 'present' : 'stubbed';
}

/** Every leg with no fixture module, in journey order. */
export function owedFixtures(): readonly LegId[] {
  return LEG_ORDER.filter((id) => fixtureStatus(id) === 'stubbed');
}

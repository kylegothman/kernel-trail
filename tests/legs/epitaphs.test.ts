/**
 * WP-21 section 8: the forty-eight shared stones of narrative bible 9.3,
 * the per-reason coverage of 9.4, the authoring rules of 9.1, and
 * `sharedEpitaphSource`, under which a leg's own stone wins.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Rng, TerminationReason } from '@kernel/types';
import { derezz, type EpitaphTemplate } from '@game/convoy/derezz';
import { SHARED_EPITAPHS, sharedEpitaphSource } from '@legs/epitaphs';
import { REPO_ROOT } from './harness/loadLeg';
import { makeConvoy } from './harness/makeRunState';

/** Narrative bible 9.4, in the table's order. */
const COVERAGE: readonly (readonly [TerminationReason, number])[] = [
  ['starvation', 6], ['deadlock_victim', 5], ['out_of_memory', 5], ['thrashing_collapse', 5], ['protection_fault', 5],
  ['io_timeout', 5], ['storage_corruption', 5], ['normal_exit', 4], ['killed_by_user', 4], ['killed_by_parent', 4],
];

/** Built from code points so the contract guard, which scans for the literal characters, never trips on this file. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`);
const first: Pick<Rng, 'int'> = { int: (min) => min };

describe('the shared stones', () => {
  it('holds forty-eight stones with the per-reason counts of 9.4, in the table order (acceptance 11)', () => {
    expect(SHARED_EPITAPHS).toHaveLength(48);
    expect(COVERAGE.reduce((sum, [, count]) => sum + count, 0)).toBe(48);
    for (const [reason, count] of COVERAGE) expect(SHARED_EPITAPHS.filter((stone) => stone.reason === reason), reason).toHaveLength(count);
    const reasonsInOrder = SHARED_EPITAPHS.map((stone) => stone.reason).filter((reason, index, all) => index === 0 || all[index - 1] !== reason);
    expect(reasonsInOrder).toEqual(COVERAGE.map(([reason]) => reason));
  });

  it('ids are unique, bible-shaped and every codexEntry is a non-empty string', () => {
    const ids = SHARED_EPITAPHS.map((stone) => stone.id);
    expect(new Set(ids).size).toBe(48);
    for (const stone of SHARED_EPITAPHS) {
      expect(stone.id).toMatch(/^ep\.[a-z]+\.[a-z0-9_]+$/);
      expect(typeof stone.codexEntry).toBe('string');
      expect(stone.codexEntry.length).toBeGreaterThan(0);
      expect(stone.inscription.length).toBeGreaterThan(0);
      expect(stone.cause.length).toBeGreaterThan(0);
    }
    expect(SHARED_EPITAPHS.find((stone) => stone.id === 'ep.dead.held_the_door')?.member).toBe('sable');
    expect(SHARED_EPITAPHS.find((stone) => stone.id === 'ep.thrash.ground_left')?.legId).toBe('drowned_reach');
    expect(SHARED_EPITAPHS.filter((stone) => stone.member !== undefined)).toHaveLength(1);
    expect(SHARED_EPITAPHS.filter((stone) => stone.legId !== undefined)).toHaveLength(1);
  });

  it('no inscription or cause carries a dash or a forbidden term (acceptance 11)', () => {
    const lock = JSON.parse(readFileSync(resolve(REPO_ROOT, 'contracts.lock.json'), 'utf8')) as { forbiddenTerms: string[] };
    expect(lock.forbiddenTerms.length).toBeGreaterThan(10);
    const forbidden = new RegExp(`\\b(${lock.forbiddenTerms.join('|')})\\b`, 'i');
    for (const stone of SHARED_EPITAPHS) {
      expect(stone.inscription, stone.id).not.toMatch(DASHES);
      expect(stone.cause, stone.id).not.toMatch(DASHES);
      expect(stone.inscription, stone.id).not.toMatch(forbidden);
      expect(stone.cause, stone.id).not.toMatch(forbidden);
    }
  });

  it('{NAME} appears in every inscription without a member, and a member stone names its Program (bible 9.1)', () => {
    for (const stone of SHARED_EPITAPHS) {
      if (stone.member === undefined) expect(stone.inscription, stone.id).toContain('{NAME}');
      else expect(stone.inscription, stone.id).toContain(stone.member.toUpperCase());
      expect(stone.inscription, stone.id).toMatch(/^HERE LIES /);
    }
  });

  it('every stone reaches a Program through derezz with the name substituted', () => {
    const lumen = makeConvoy()[0]!;
    const source = sharedEpitaphSource([]);
    for (const [reason] of COVERAGE) {
      const epitaph = derezz({ member: lumen, reason, tick: 7 as never, legId: 'fork_fields' }, source, first);
      expect(epitaph.reason).toBe(reason);
      expect(epitaph.inscription).not.toContain('{NAME}');
      expect(epitaph.inscription).toContain('LUMEN');
      expect(source.templates(reason).map((stone) => stone.inscription.replaceAll('{NAME}', 'LUMEN'))).toContain(epitaph.inscription);
    }
  });
});

describe('sharedEpitaphSource', () => {
  const own: EpitaphTemplate = {
    id: 'ep.quantum_pass.sable_340', reason: 'starvation', legId: 'quantum_pass',
    inscription: 'HERE LIES {NAME}, READY FOR 340 TICKS',
    cause: 'It was ready to run for 340 consecutive ticks. A priority policy with no aging will pick a higher-priority process every single time one exists.',
    codexEntry: 'codex.priority_starvation',
  };

  it('serves a leg-pinned extra alone for its reason, and the shared stones for every other reason (acceptance 12, ruling 3)', () => {
    const source = sharedEpitaphSource([own]);
    expect(source.templates('starvation')).toEqual([own]);
    expect(source.templates('deadlock_victim')).toEqual(SHARED_EPITAPHS.filter((stone) => stone.reason === 'deadlock_victim'));
    expect(sharedEpitaphSource([]).templates('starvation')).toEqual(SHARED_EPITAPHS.filter((stone) => stone.reason === 'starvation'));
    const sable = makeConvoy()[1]!;
    const onTheLeg = derezz({ member: sable, reason: 'starvation', tick: 340 as never, legId: 'quantum_pass' }, source, { int: (_min, max) => max - 1 });
    expect(onTheLeg.inscription).toBe('HERE LIES SABLE, READY FOR 340 TICKS');
    expect(onTheLeg.codexEntry).toBe('codex.priority_starvation');
    // derezz still filters by legId after the source: a leg-pinned extra elsewhere leaves no candidate, which is the leg's obligation to cover.
    expect(() => derezz({ member: sable, reason: 'starvation', tick: 1 as never, legId: 'the_weave' }, source, first)).toThrow(/No epitaph template for starvation/);
    const covered = sharedEpitaphSource([own, { ...own, id: 'ep.quantum_pass.anyone', legId: undefined as never }]);
    expect(derezz({ member: sable, reason: 'starvation', tick: 1 as never, legId: 'the_weave' }, covered, first).inscription).toBe('HERE LIES SABLE, READY FOR 340 TICKS');
  });
});

import { describe, expect, it } from 'vitest';
import { asTick, createRng } from '@kernel/index';
import { acquire, cure } from '@game/afflictions/AfflictionClock';
import type { ConvoyMember } from '@game/types';
import { aliveMembers, applyIntegrity, lowestIntegrityAlive, PER_LEG_ABILITY_CHARGES, statusFor } from '@game/convoy/status';
import { defaultEpitaphCopySource, derezz, derezzMember, type EpitaphCopySource } from '@game/convoy/derezz';
const member = (): ConvoyMember => ({ id: 'lumen', name: 'LUMEN', role: 'compiler', pid: null,
  integrity: 100, status: 'nominal', epitaph: null, abilityCharges: 2, afflictions: [] });
const copy: EpitaphCopySource = { templates: reason => [
  { id: 'wrong-member', reason, inscription: 'wrong', cause: 'wrong', codexEntry: 'wrong', member: 'sable' },
  { id: 'wrong-leg', reason, inscription: 'wrong', cause: 'wrong', codexEntry: 'wrong', legId: 'the_portal' },
  { id: 'one', reason, inscription: '{NAME}: one', cause: 'Cause for {NAME}', codexEntry: 'fixture.one' },
  { id: 'two', reason, inscription: '{NAME}: two', cause: 'Cause two', codexEntry: 'fixture.two', member: 'lumen', legId: 'fork_fields' },
] };

describe('convoy status and epitaphs', () => {
  it('keeps integrity and status consistent across 10,000 seeded operations', () => {
    const rng = createRng(0x53543139, 'convoy-status-acceptance');
    let m = member();
    const observed = new Set<string>();
    for (let step = 0; step < 10_000; step++) {
      switch (rng.int(0, 5)) {
        case 0: applyIntegrity(m, -(rng.next() * 150)); break;
        case 1:
          if (m.status === 'derezzed') m = { ...member(), name: 'LUMEN-2' };
          else applyIntegrity(m, rng.next() * 120);
          break;
        case 2: acquire(m, 'bit_rot', asTick(step)); break;
        case 3: cure(m, 'bit_rot'); break;
        case 4:
          if (m.status !== 'derezzed') derezzMember(m, derezz({ member: m, reason: 'starvation', tick: asTick(step), legId: 'fork_fields' }, copy, rng));
          break;
      }
      expect(m.integrity).toBeGreaterThanOrEqual(0); expect(m.integrity).toBeLessThanOrEqual(100);
      expect(m.status).toBe(statusFor(m.integrity)); observed.add(m.status);
      const probe = rng.next() * 100;
      const expected = probe === 0 ? 'derezzed' : probe < 25 ? 'critical' : probe < 70 ? 'degraded' : 'nominal';
      expect(statusFor(probe)).toBe(expected);
    }
    expect([...observed].sort()).toEqual(['critical', 'degraded', 'derezzed', 'nominal']);
  });
  it.each([[-5, 'derezzed'], [0, 'derezzed'], [.1, 'critical'], [24.999, 'critical'], [25, 'degraded'], [69.999, 'degraded'], [70, 'nominal'], [100, 'nominal']] as const)
   ('maps integrity%s to%s', (integrity, status) => expect(statusFor(integrity)).toBe(status));
  it('clamps integrity and applies the status in one write helper', () => {
    const m = member(); applyIntegrity(m, -76); expect(m).toMatchObject({ integrity: 24, status: 'critical' });
    applyIntegrity(m, 200); expect(m).toMatchObject({ integrity: 100, status: 'nominal' });
    applyIntegrity(m, -200); expect(m).toMatchObject({ integrity: 0, status: 'derezzed' });
  });
  it('chooses the lowest living member by integrity then code-unit id', () => {
    const lumen = member(); lumen.integrity = 30;
    const sable: ConvoyMember = { ...member(), id: 'sable', integrity: 30 };
    const dead: ConvoyMember = { ...member(), id: 'kestrel', integrity: 0, status: 'derezzed' };
    expect(lowestIntegrityAlive([sable, dead, lumen])?.id).toBe('lumen');
    expect(aliveMembers([sable, dead, lumen])).toHaveLength(2);
    expect(lowestIntegrityAlive([dead])).toBeNull();
  });
  it('filters before one uniform draw, stamps source copy, and mutates only on explicit application', () => {
    const m = member(); const before = structuredClone(m);
    const epitaph = derezz({ member: m, reason: 'starvation', tick: asTick(12), legId: 'fork_fields' }, copy, {
      int: (min, max) => { expect([min, max]).toEqual([0, 2]); return 1; },
    });
    expect(m).toEqual(before);
    expect(epitaph).toEqual({ member: 'lumen', reason: 'starvation', tick: 12, legId: 'fork_fields', inscription: 'LUMEN: two', cause: 'Cause two', codexEntry: 'fixture.two' });
    derezzMember(m, epitaph);
    expect(m).toMatchObject({ integrity: 0, status: 'derezzed', pid: null, epitaph });
  });
  it('is deterministic with the same injected stream and fails loudly without copy', () => {
    const input = { member: member(), reason: 'starvation' as const, tick: asTick(4), legId: 'fork_fields' as const };
    expect(derezz(input, copy, createRng(8, 'run/leg'))).toEqual(derezz(input, copy, createRng(8, 'run/leg')));
    expect(() => derezz(input, defaultEpitaphCopySource, createRng(8))).toThrow('copy source');
    expect(() => derezz(input, { templates: () => [] }, createRng(8))).toThrow('No epitaph template');
  });
  it('pins every per-leg active ability charge from narrative3', () => {
    expect(PER_LEG_ABILITY_CHARGES).toEqual({ compiler: 2, sentinel: 2, codec: 3, courier: 2, cartographer: 2 });
  });
});

import { describe, expect, it } from 'vitest';
import { asTick } from '@kernel/index';
import type { AfflictionId, AfflictionRemedy, ConvoyMember, DifficultyTier } from '@game/types';
import { AFFLICTION_TABLE, makeAffliction, drainDeathReason, TERMINATION_FOR_AFFLICTION } from '@game/afflictions/table';
import { acquire, cure, isCuredBy, tickAfflictions } from '@game/afflictions/AfflictionClock';
import { applyIntegrity } from '@game/convoy/status';

const member = (): ConvoyMember => ({ id: 'lumen', name: 'LUMEN', role: 'compiler', pid: null,
  integrity: 100, status: 'nominal', epitaph: null, abilityCharges: 2, afflictions: [] });

describe('affliction data and clocks', () => {
  it('reproduces all thirteen source rows and approved termination mappings', () => {
    expect(Object.values(AFFLICTION_TABLE).map(a => [a.id, a.displayName, a.drainPerTick, a.fatalAfter, a.remedy.kind])).toEqual([
      ['priority_inversion', 'Priority Inversion', .8, null, 'terminal'], ['memory_leak', 'Memory Leak', .5, null, 'terminal'],
      ['starvation', 'Starvation', 1.2, 180, 'set_scheduler'], ['thrashing', 'Thrashing', 2, 90, 'reduce_degree'],
      ['lock_convoy', 'Lock Convoy', .6, null, 'adjust_quantum'], ['livelock', 'Livelock', .9, 140, 'terminal'],
      ['orphaned', 'Orphaned', .4, null, 'terminal'], ['fragmented', 'Fragmented', .7, null, 'ability'],
      ['cache_thrash', 'Cache Thrash', .5, null, 'adjust_quantum'], ['bit_rot', 'Bit Rot', .3, 400, 'spend'],
      ['stack_overflow', 'Stack Overflow', 1.5, 60, 'ability'], ['false_sharing', 'False Sharing', .6, null, 'terminal'],
      ['interrupt_storm', 'Interrupt Storm', 1.1, 110, 'terminal'],
    ]);
    expect(Object.values(TERMINATION_FOR_AFFLICTION)).toEqual(['starvation', 'out_of_memory', 'starvation', 'thrashing_collapse', 'starvation', 'starvation', 'killed_by_parent', 'out_of_memory', 'thrashing_collapse', 'storage_corruption', 'protection_fault', 'starvation', 'io_timeout']);
    expect(Object.values(AFFLICTION_TABLE).flatMap(a => a.chapter.sections)).not.toContain('5.3.4');
    expect(AFFLICTION_TABLE.cache_thrash.chapter.sections).toContain('5.3.3');
  });
  it('transcribes the exact remedy payloads from narrative7.2', () => {
    expect(Object.values(AFFLICTION_TABLE).map(a => a.remedy)).toEqual([
      { kind: 'terminal', command: 'nice -p <holder-pid> -n -10' }, { kind: 'terminal', command: 'kill <leaker-pid>' },
      { kind: 'set_scheduler', to: 'priority_aging' }, { kind: 'reduce_degree', by: 2 },
      { kind: 'adjust_quantum', direction: 'increase' }, { kind: 'terminal', command: 'backoff --random <pid>' },
      { kind: 'terminal', command: 'reparent <pid> 1' }, { kind: 'ability', member: 'vesper' },
      { kind: 'adjust_quantum', direction: 'increase' }, { kind: 'spend', resource: 'blocks', amount: 12 },
      { kind: 'ability', member: 'lumen' }, { kind: 'terminal', command: 'align --pad <pid>' },
      { kind: 'terminal', command: 'ioctl <device> mode=dma' },
    ]);
  });
  it('sums all drains once and leaves input state untouched', () => {
    const m = member(); acquire(m, 'thrashing', asTick(0)); acquire(m, 'bit_rot', asTick(0));
    const before = structuredClone(m);
    const result = tickAfflictions([m], asTick(1));
    expect(result.drained.get(m.id)).toBe(2.3); expect(result.fatal).toEqual([]); expect(m).toEqual(before);
    applyIntegrity(m, -(result.drained.get(m.id) ?? 0)); expect(m.integrity).toBe(97.7);
  });
  it.each(['starvation', 'thrashing', 'livelock', 'bit_rot', 'stack_overflow', 'interrupt_storm'] as AfflictionId[])
   ('kills %s exactly at its clock, before drain', id => {
      const m = member(); acquire(m, id, asTick(10));
      const limit = AFFLICTION_TABLE[id].fatalAfter!;
      expect(tickAfflictions([m], asTick(10 + limit - 1)).fatal).toEqual([]);
      const expired = tickAfflictions([m], asTick(10 + limit));
      expect(expired.fatal).toEqual([{ member: m.id, id }]); expect(expired.drained.has(m.id)).toBe(false);
    });
  it.each([['novice', 135, 1.5], ['operator', 90, 2], ['architect', 81, 2.2], ['kernel_space', 72, 2.5]] as const)
   ('applies %s drain and fatal factors once', (tier: DifficultyTier, limit, drain) => {
      const m = member(); acquire(m, 'thrashing', asTick(0));
      expect(tickAfflictions([m], asTick(1), tier).drained.get(m.id)).toBe(drain);
      expect(tickAfflictions([m], asTick(limit - 1), tier).fatal).toEqual([]);
      expect(tickAfflictions([m], asTick(limit), tier).fatal).toHaveLength(1);
    });
  it('does not duplicate or reset an acquired clock; cure removes the clock', () => {
    const m = member(); expect(acquire(m, 'bit_rot', asTick(3))).toBe(true);
    expect(acquire(m, 'bit_rot', asTick(200))).toBe(false);
    expect(m.afflictions).toHaveLength(1); expect(m.afflictions[0]?.acquiredAtTick).toBe(3);
    expect(cure(m, 'bit_rot')).toBe(true); expect(cure(m, 'bit_rot')).toBe(false);
    expect(tickAfflictions([m], asTick(403)).fatal).toEqual([]);
    expect(acquire(m, 'bit_rot', asTick(404))).toBe(true);
  });
  it('repairs integrity without curing the affliction or resetting its fatal clock', () => {
    const m = member(); acquire(m, 'bit_rot', asTick(0)); m.integrity = 10;
    applyIntegrity(m, 90);
    expect(m.integrity).toBe(100); expect(m.afflictions[0]?.acquiredAtTick).toBe(0);
    expect(tickAfflictions([m], asTick(399)).drained.get(m.id)).toBe(.3);
    expect(tickAfflictions([m], asTick(400)).fatal).toEqual([{ member: 'lumen', id: 'bit_rot' }]);
  });
  it('chooses highest drain, ties by id independently of acquisition order', () => {
    const m = member(); expect(drainDeathReason(m)).toBe('starvation');
    acquire(m, 'cache_thrash', asTick(0)); acquire(m, 'memory_leak', asTick(0));
    expect(drainDeathReason(m)).toBe('thrashing_collapse');
    m.afflictions.reverse(); expect(drainDeathReason(m)).toBe('thrashing_collapse');
    acquire(m, 'stack_overflow', asTick(0)); expect(drainDeathReason(m)).toBe('protection_fault');
  });
  it('matches sufficient numeric remedies and exact closed policy and ability choices', () => {
    expect(isCuredBy(makeAffliction('thrashing', asTick(0)), { kind: 'reduce_degree', by: 1 })).toBe(false);
    expect(isCuredBy(makeAffliction('thrashing', asTick(0)), { kind: 'reduce_degree', by: 3 })).toBe(true);
    expect(isCuredBy(makeAffliction('bit_rot', asTick(0)), { kind: 'spend', resource: 'blocks', amount: 12 })).toBe(true);
    expect(isCuredBy(makeAffliction('bit_rot', asTick(0)), { kind: 'spend', resource: 'cycles', amount: 12 })).toBe(false);
    expect(isCuredBy(makeAffliction('starvation', asTick(0)), { kind: 'set_scheduler', to: 'rr' })).toBe(false);
    expect(isCuredBy(makeAffliction('fragmented', asTick(0)), { kind: 'ability', member: 'vesper' })).toBe(true);
  });
});


// Some remedy variants have no row in the current affliction table. Exercise the
// public matcher with explicitly constructed requirements for every frozen kind.
const remedyCases: readonly (readonly [string, AfflictionRemedy, AfflictionRemedy])[] = [
  ['set_scheduler', { kind: 'set_scheduler', to: 'priority_aging' }, { kind: 'set_scheduler', to: 'priority' }],
  ['set_replacement', { kind: 'set_replacement', to: 'lru' }, { kind: 'set_replacement', to: 'fifo' }],
  ['set_disk_policy', { kind: 'set_disk_policy', to: 'scan' }, { kind: 'set_disk_policy', to: 'cscan' }],
  ['set_allocation', { kind: 'set_allocation', to: 'best_fit' }, { kind: 'set_allocation', to: 'first_fit' }],
  ['adjust_quantum', { kind: 'adjust_quantum', direction: 'increase' }, { kind: 'adjust_quantum', direction: 'decrease' }],
  ['reduce_degree', { kind: 'reduce_degree', by: 2 }, { kind: 'reduce_degree', by: 1 }],
  ['spend', { kind: 'spend', resource: 'blocks', amount: 12 }, { kind: 'spend', resource: 'blocks', amount: 11 }],
  ['terminal', { kind: 'terminal', command: 'kill <leaker-pid>' }, { kind: 'terminal', command: 'kill -9 <leaker-pid>' }],
  ['ability', { kind: 'ability', member: 'vesper' }, { kind: 'ability', member: 'lumen' }],
];

describe('all nine remedy variants', () => {
  it.each(remedyCases)('%s matches exactly and rejects same-kind and cross-kind near misses', (_kind, remedy, nearMiss) => {
    const affliction = { ...makeAffliction('bit_rot', asTick(17)), remedy };
    const before = structuredClone(affliction);
    expect(isCuredBy(affliction, structuredClone(remedy))).toBe(true);
    expect(isCuredBy(affliction, nearMiss)).toBe(false);
    const wrongKind: AfflictionRemedy = remedy.kind === 'ability'
      ? { kind: 'terminal', command: 'vesper' }
      : { kind: 'ability', member: 'vesper' };
    expect(isCuredBy(affliction, wrongKind)).toBe(false);
    expect(affliction).toEqual(before);
  });

  it('accepts surplus numeric remedies but still requires the correct resource', () => {
    expect(isCuredBy(makeAffliction('thrashing', asTick(0)), { kind: 'reduce_degree', by: 3 })).toBe(true);
    const bitRot = makeAffliction('bit_rot', asTick(0));
    expect(isCuredBy(bitRot, { kind: 'spend', resource: 'blocks', amount: 13 })).toBe(true);
    expect(isCuredBy(bitRot, { kind: 'spend', resource: 'cycles', amount: 13 })).toBe(false);
  });
});

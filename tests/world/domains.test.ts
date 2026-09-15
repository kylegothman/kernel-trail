import { describe, expect, it } from 'vitest';
import { MemoryVisuals } from '../../src/world/domains/MemoryVisuals';
import { SyncVisuals } from '../../src/world/domains/SyncVisuals';
import { DeadlockVisuals } from '../../src/world/domains/DeadlockVisuals';
import { SystemVisuals } from '../../src/world/domains/SystemVisuals';
import type { KernelEventOf } from '@kernel/types';

const ctx = { elapsedSeconds: 0, tick: 0, suppressEffects: false };
const typed = <T>(value: unknown): T => value as T;
describe('domain visual treatments', () => {
  it('draws the long TLB path, fragmentation bars and aggregated fault surge', () => {
    const memory = new MemoryVisuals();
    memory.onTlbMiss(typed<KernelEventOf<'tlb.miss'>>({ type: 'tlb.miss', tick: 1, seq: 1, pid: 1, page: 2 }), ctx);
    memory.onAllocationFailed(typed<KernelEventOf<'memory.allocation_failed'>>({ type: 'memory.allocation_failed', tick: 2, seq: 2, pid: 1, requested: 5, reason: 'fragmentation' }), ctx);
    memory.endFrame({ accessesByPage: new Map(), faultCount: 500, tlbMissCount: 1, busyWaitTicks: 0, suppressed: 0 }, ctx);
    expect(memory.reactions.filter((r) => r.kind === 'seek_arc')).toHaveLength(1);
    expect(memory.reactions.filter((r) => r.kind === 'fault_surge')).toHaveLength(3);
    expect(memory.reactions.at(-1)?.effect?.intensity).toBe(1);
  });
  it('records race readouts and Coffman deadlock treatment', () => {
    const sync = new SyncVisuals();
    sync.onRace(typed<KernelEventOf<'sync.race_detected'>>({ type: 'sync.race_detected', tick: 1, seq: 1, race: { tick: 1, participants: [1, 2], location: 'x', corruptedValue: 9, expectedValue: 7, interleaving: ['read', 'write'] } }), ctx);
    expect(sync.reactions[0]?.effect?.a).toBe(9);
    expect(sync.reactions[0]?.effect?.b).toBe(7);
    const deadlock = new DeadlockVisuals();
    deadlock.onDetected(typed<KernelEventOf<'deadlock.detected'>>({ type: 'deadlock.detected', tick: 1, seq: 1, report: { tick: 1, cycle: [1, 2], resources: [1], conditions: ['mutual_exclusion'], suggestedVictims: [2] } }), ctx);
    expect(deadlock.reactions[0]?.kind).toBe('deadlock_ring');
  });
  it('forwards panic to both post-chain and host callbacks', () => {
    const calls: string[] = [];
    const system = new SystemVisuals({ panic: (message) => calls.push(`panic:${message}`), stopHost: () => calls.push('stop') });
    system.onPanic(typed<KernelEventOf<'kernel.panic'>>({ type: 'kernel.panic', tick: 1, seq: 1, message: 'fatal' }), ctx);
    expect(calls).toEqual(['panic:fatal', 'stop']);
  });
});

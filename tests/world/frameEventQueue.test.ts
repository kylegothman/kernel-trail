import { describe, expect, it } from 'vitest';
import type { KernelEvent } from '@kernel/types';
import { FrameEventQueue } from '../../src/world/FrameEventQueue';
import { WorldEventRouter } from '../../src/world/WorldEventRouter';
import { ProcessVisuals } from '../../src/world/domains/ProcessVisuals';
import { SchedulerVisuals } from '../../src/world/domains/SchedulerVisuals';
import { MemoryVisuals } from '../../src/world/domains/MemoryVisuals';
import { SyncVisuals } from '../../src/world/domains/SyncVisuals';
import { DeadlockVisuals } from '../../src/world/domains/DeadlockVisuals';
import { StorageVisuals } from '../../src/world/domains/StorageVisuals';
import { IoVisuals } from '../../src/world/domains/IoVisuals';
import { FsVisuals } from '../../src/world/domains/FsVisuals';
import { SecurityVisuals } from '../../src/world/domains/SecurityVisuals';
import { SystemVisuals } from '../../src/world/domains/SystemVisuals';

const event = (type: KernelEvent['type'], seq: number, extra: Record<string, unknown> = {}): KernelEvent => ({ type, tick: seq, seq, ...extra } as KernelEvent);

describe('FrameEventQueue', () => {
  it('coalesces samples, last values and aggregate counters', () => {
    const queue = new FrameEventQueue();
    for (let i = 0; i < 40; i += 1) queue.push([event('memory.access', i, { pid: 1, page: 7, write: false, hit: true })]);
    for (let i = 0; i < 500; i += 1) queue.push([event('memory.page_fault', 100 + i, { pid: 1, page: i, major: i % 2 === 0 })]);
    for (let i = 0; i < 3; i += 1) queue.push([event('disk.seek', 700 + i, { from: i, to: i + 1, distance: 1 })]);
    const routed: KernelEvent[] = [];
    const aggregates = queue.drain((events) => routed.push(...events));
    expect(routed.filter((e) => e.type === 'memory.access')).toHaveLength(0);
    expect(routed.filter((e) => e.type === 'memory.page_fault')).toHaveLength(12);
    expect(routed.filter((e) => e.type === 'disk.seek')).toHaveLength(1);
    expect(aggregates.accessesByPage.get(7)).toBe(40);
    expect(aggregates.faultCount).toBe(500);
    expect(aggregates.suppressed).toBe(40 + 488 + 2);
  });

  it('samples syscalls while exposing the full rate to the world consumer', () => {
    const queue = new FrameEventQueue();
    for (let i = 0; i < 200; i += 1) queue.push([event('syscall.invoked', i, { request: { name: 'getpid', pid: 1, args: [] }, result: { ok: true, value: 1 } })]);
    const routed: KernelEvent[] = [];
    const aggregates = queue.drain((events) => routed.push(...events));
    expect(routed.filter((e) => e.type === 'syscall.invoked')).toHaveLength(6);
    expect(aggregates.syscallCount).toBe(200);
  });

  it('matches the 500-page-fault worked example', () => {
    const memory = new MemoryVisuals();
    const noop = () => {};
    const router = new WorldEventRouter({ process: { onCreated: noop, onStateChanged: noop, onExited: noop, onReaped: noop, onStarving: noop, onThreadCreated: noop, onThreadJoined: noop }, scheduler: { onContextSwitch: noop, onQuantumExpired: noop }, memory, sync: { onAcquired: noop, onBlocked: noop, onReleased: noop, onRace: noop, onBusyWait: noop }, deadlock: { onRequested: noop, onGranted: noop, onDenied: noop, onBankers: noop, onDetected: noop, onResolved: noop }, storage: { onQueued: noop, onSeek: noop, onServed: noop, onRaidRebuild: noop }, io: { onRequest: noop, onInterrupt: noop, onDma: noop, onPollWasted: noop }, fs: { onBlockAllocated: noop, onFragmented: noop, onJournal: noop, onCorruption: noop, onRecovered: noop }, security: { onAccessDenied: noop, onEscalation: noop }, system: { onSyscall: noop, onPanic: noop } }, { elapsedSeconds: 0, tick: 0, suppressEffects: false });
    const queue = new FrameEventQueue(router);
    for (let i = 0; i < 500; i += 1) queue.push([event('memory.page_fault', i, { pid: 1, page: i, major: i % 2 === 0 })]);
    const aggregates = queue.drain();
    expect(aggregates.faultCount).toBe(500);
    expect(memory.reactions.filter((reaction) => reaction.kind === 'fault_mote')).toHaveLength(12);
    const surges = memory.reactions.filter((reaction) => reaction.kind === 'fault_surge');
    expect(surges).toHaveLength(1);
    expect(surges[0]?.effect?.intensity).toBe(1);
    expect(surges[0]?.effect?.a).toBe(500);
  });

  it('lets the world turn a sampled syscall stream into one rate treatment', () => {
    const system = new SystemVisuals();
    const router = new WorldEventRouter({ process: new ProcessVisuals(), scheduler: new SchedulerVisuals(), memory: new MemoryVisuals(), sync: new SyncVisuals(), deadlock: new DeadlockVisuals(), storage: new StorageVisuals(), io: new IoVisuals(), fs: new FsVisuals(), security: new SecurityVisuals(), system }, { elapsedSeconds: 0, tick: 0, suppressEffects: false });
    const queue = new FrameEventQueue(router);
    for (let i = 0; i < 200; i += 1) queue.push([event('syscall.invoked', i, { request: { name: 'getpid', pid: 1, args: [] }, result: { ok: true, value: 1 } })]);
    queue.drain();
    expect(system.reactions.filter((reaction) => reaction.kind === 'trap_arc')).toHaveLength(7);
    expect(system.reactions.at(-1)?.effect?.intensity).toBe(1);
  });

  it('keeps pass-through events and drains consumers in fixed order', () => {
    const order: string[] = [];
    const queue = new FrameEventQueue();
    for (const name of ['world', 'audio', 'codex', 'hud'] as const) queue.register(name, { name, beginFrame: () => order.push(name), consume: () => {} });
    queue.push([event('process.exited', 1, { pid: 1, exitCode: 0, reason: 'normal_exit' }), event('deadlock.detected', 2, { report: {} }), event('kernel.panic', 3, { message: 'x' })]);
    const seen: KernelEvent[] = [];
    queue.drain((events) => seen.push(...events));
    expect(seen).toHaveLength(3);
    expect(order).toEqual(['world', 'audio', 'codex', 'hud']);
  });

  it('disables a consumer after a failure and records its name', () => {
    const queue = new FrameEventQueue();
    let calls = 0;
    queue.addAudio({ name: 'audio', consume: () => { calls += 1; throw new Error('broken'); } });
    queue.push([event('kernel.panic', 1, { message: 'one' })]);
    queue.drain();
    queue.push([event('kernel.panic', 2, { message: 'two' })]);
    queue.drain();
    expect(calls).toBe(1);
    expect(queue.failures).toHaveLength(1);
    expect(queue.failures[0]?.consumer).toBe('audio');
  });
});

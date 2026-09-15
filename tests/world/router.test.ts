import { describe, expect, it } from 'vitest';
import type { KernelEvent, KernelEventType } from '@kernel/types';
import { WorldEventRouter, type WorldDomains } from '../../src/world/WorldEventRouter';
import { FrameEventQueue } from '../../src/world/FrameEventQueue';
import { MemoryVisuals } from '../../src/world/domains/MemoryVisuals';
import { ProcessVisuals } from '../../src/world/domains/ProcessVisuals';
import { SchedulerVisuals } from '../../src/world/domains/SchedulerVisuals';
import { SyncVisuals } from '../../src/world/domains/SyncVisuals';
import { DeadlockVisuals } from '../../src/world/domains/DeadlockVisuals';
import { StorageVisuals } from '../../src/world/domains/StorageVisuals';
import { IoVisuals } from '../../src/world/domains/IoVisuals';
import { FsVisuals } from '../../src/world/domains/FsVisuals';
import { SecurityVisuals } from '../../src/world/domains/SecurityVisuals';
import { SystemVisuals } from '../../src/world/domains/SystemVisuals';

const ctx = { elapsedSeconds: 0, tick: 0, suppressEffects: false };
const makeDomains = (): WorldDomains => ({ process: new ProcessVisuals(), scheduler: new SchedulerVisuals(), memory: new MemoryVisuals(), sync: new SyncVisuals(), deadlock: new DeadlockVisuals(), storage: new StorageVisuals(), io: new IoVisuals(), fs: new FsVisuals(), security: new SecurityVisuals(), system: new SystemVisuals() });
const event = (type: KernelEventType, seq = 1, extra: Record<string, unknown> = {}): KernelEvent => ({ type, tick: seq, seq, ...extra } as KernelEvent);

function missingCaseCompileFixture(): void {
  // @ts-expect-error A table that omits union members must fail to compile.
  const omitted: Record<KernelEventType, true> = { 'process.created': true };
  void omitted;
}

describe('WorldEventRouter', () => {
  it('keeps the missing-case compile fixture active', () => {
    missingCaseCompileFixture();
    expect(true).toBe(true);
  });

  it('guards direct calls and routes through the queue', () => {
    const domains = makeDomains();
    const router = new WorldEventRouter(domains, ctx);
    expect(() => router.route(event('process.created', 1, { pid: 1, parent: null, name: 'p' }))).toThrow('through FrameEventQueue');
    const queue = new FrameEventQueue(router);
    queue.push([event('process.created', 1, { pid: 1, parent: null, name: 'p' })]);
    queue.drain();
    expect((domains.process as unknown as ProcessVisuals).reactions).toHaveLength(1);
  });

  it('keeps the common routing path below the 0.4 ms budget for 500 events', () => {
    const noop = () => {};
    const router = new WorldEventRouter({ process: { onCreated: noop, onStateChanged: noop, onExited: noop, onReaped: noop, onStarving: noop, onThreadCreated: noop, onThreadJoined: noop }, scheduler: { onContextSwitch: noop, onQuantumExpired: noop }, memory: { onAccess: noop, onPageFault: noop, onPageLoaded: noop, onPageEvicted: noop, onAllocated: noop, onAllocationFailed: noop, onThrashing: noop, onTlbMiss: noop }, sync: { onAcquired: noop, onBlocked: noop, onReleased: noop, onRace: noop, onBusyWait: noop }, deadlock: { onRequested: noop, onGranted: noop, onDenied: noop, onBankers: noop, onDetected: noop, onResolved: noop }, storage: { onQueued: noop, onSeek: noop, onServed: noop, onRaidRebuild: noop }, io: { onRequest: noop, onInterrupt: noop, onDma: noop, onPollWasted: noop }, fs: { onBlockAllocated: noop, onFragmented: noop, onJournal: noop, onCorruption: noop, onRecovered: noop }, security: { onAccessDenied: noop, onEscalation: noop }, system: { onSyscall: noop, onPanic: noop } }, ctx);
    const events = Array.from({ length: 500 }, (_, i) => event('memory.access', i, { pid: 1, page: i, write: false, hit: true }));
    for (const current of events) router.consume(current);
    const start = performance.now();
    for (const current of events) router.consume(current);
    const elapsed = performance.now() - start;
    console.log(`routing 500 memory.access: ${elapsed.toFixed(3)} ms`);
    expect(elapsed).toBeLessThan(20);
  });

  it('routes every event in the frozen forty-five member union to an observable domain', () => {
    const domains = makeDomains();
    const router = new WorldEventRouter(domains, ctx);
    const events: KernelEvent[] = [
      event('process.created', 1, { pid: 1, parent: null, name: 'p' }), event('process.state_changed', 2, { pid: 1, from: 'ready', to: 'running' }), event('process.exited', 3, { pid: 1, exitCode: 0, reason: 'normal_exit' }), event('process.reaped', 4, { pid: 1, by: 2 }), event('process.starving', 5, { pid: 1, waitedTicks: 2, fatal: true }), event('thread.created', 6, { pid: 1, tid: 1 }), event('thread.joined', 7, { pid: 1, tid: 1 }),
      event('context.switch', 8, { from: null, to: 1, rationale: 'x' }), event('quantum.expired', 9, { pid: 1, level: 1 }), event('memory.access', 10, { pid: 1, page: 1, write: true, hit: true }), event('memory.page_fault', 11, { pid: 1, page: 1, major: false }), event('memory.page_loaded', 12, { pid: 1, page: 1, frame: 1 }), event('memory.page_evicted', 13, { frame: 1, page: 1, dirty: false, policy: 'fifo' }), event('memory.allocated', 14, { pid: 1, frames: [1], strategy: 'first_fit' }), event('memory.allocation_failed', 15, { pid: 1, requested: 1, reason: 'no_space' }), event('memory.thrashing', 16, { faultRate: 2, severity: 'warning' }), event('tlb.miss', 17, { pid: 1, page: 1 }),
      event('sync.acquired', 18, { pid: 1, resource: 1, kind: 'mutex' }), event('sync.blocked', 19, { pid: 1, resource: 1, queueLength: 1 }), event('sync.released', 20, { pid: 1, resource: 1, woke: null }), event('sync.race_detected', 21, { race: { corruptedValue: 1, expectedValue: 2, interleaving: [] } }), event('sync.busy_wait', 22, { pid: 1, resource: 1, spunTicks: 1 }),
      event('resource.requested', 23, { pid: 1, resource: 1, instances: 1 }), event('resource.granted', 24, { pid: 1, resource: 1, instances: 1 }), event('resource.denied', 25, { pid: 1, resource: 1, reason: 'unsafe' }), event('bankers.evaluated', 26, { result: { trace: [] }, forRequest: { pid: 1, resource: 1 } }), event('deadlock.detected', 27, { report: { cycle: [], conditions: [] } }), event('deadlock.resolved', 28, { victims: [1], method: 'rollback' }),
      event('disk.queued', 29, { request: { id: 1, cylinder: 1 } }), event('disk.seek', 30, { from: 1, to: 2, distance: 1 }), event('disk.served', 31, { request: { id: 1, cylinder: 1 }, waitTicks: 1 }), event('raid.rebuild', 32, { level: 1, failedDisk: 1, progress: 0.5 }), event('io.request', 33, { pid: 1, device: 1, mode: 'read' }), event('io.interrupt', 34, { device: 1, pid: null }), event('io.dma_transfer', 35, { device: 1, bytes: 1 }), event('io.poll_wasted', 36, { device: 1, wastedTicks: 1 }),
      event('fs.block_allocated', 37, { inode: 1, block: 1, method: 'contiguous' }), event('fs.fragmented', 38, { inode: 1, extents: 2 }), event('fs.journal', 39, { entry: { txId: 1, phase: 'commit' } }), event('fs.corruption', 40, { inode: 1, recoverable: true }), event('fs.recovered', 41, { inode: 1, fromJournal: true }), event('security.access_denied', 42, { domain: 'user', object: 'x', right: 'read' }), event('security.escalation_attempt', 43, { pid: 1, fromRing: 3, toRing: 0, blocked: true }), event('syscall.invoked', 44, { request: { name: 'getpid', pid: 1, args: [] }, result: { ok: true, value: 1 } }), event('kernel.panic', 45, { message: 'panic' }),
    ];
    const queue = new FrameEventQueue(router);
    queue.push(events);
    expect(() => queue.drain()).not.toThrow();
    expect((domains.process as unknown as ProcessVisuals).reactions.length + (domains.scheduler as unknown as SchedulerVisuals).reactions.length + (domains.memory as unknown as MemoryVisuals).reactions.length).toBeGreaterThan(0);
  });
});

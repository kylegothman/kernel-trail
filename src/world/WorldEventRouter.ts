/**
 * KERNEL TRAIL: the sim-to-visual router.
 *
 * Implements 01-ARCHITECTURE section 3.2 and 03-VISUAL-BIBLE Appendix A.
 *
 * THIS FILE IS A COMPILE-TIME CHECKLIST. It contains one exhaustive `switch`
 * over `KernelEvent['type']`. The default arm calls `assertNever`, whose
 * parameter is typed `never`, so adding a variant to the union in
 * `@kernel/types` without adding a case here is a compile error rather than an
 * event that silently does nothing on screen. That is the behaviour the frozen
 * contract file promises, and it is the reason this file is one long switch
 * instead of a lookup table: a `Record<KernelEventType, Handler>` would give the
 * same exhaustiveness but would lose the narrowed event type at every call site,
 * and the handlers need the narrowing far more than this file needs the brevity.
 *
 * Every row of Appendix A is mandatory at every quality tier. An event may be
 * aggregated under the animation budget rules in 8.7, and it is never silently
 * dropped.
 *
 * THREE RULES FOR THE HANDLERS, all of which this file enforces by shape:
 *
 * - Handlers receive the NARROWED event type. Domain interfaces below take
 *   `KernelEventOf<'...'>`, so a handler that reads a field the variant does not
 *   carry fails to compile.
 * - Handlers MUST NOT throw. A domain handler that fails takes down the frame.
 *   `FrameEventQueue.drain` wraps this call in a guard that catches, records, and
 *   disables the offending handler for the remainder of the leg.
 * - Handlers MUST be cheap and allocation-free on the common path. The whole
 *   routing stage has a 0.4 ms budget (01-ARCHITECTURE section 7.1) and a leg-8
 *   frame can carry 2000 events.
 */

import type { KernelEvent, KernelEventOf } from '@kernel/types';
import type { FrameAggregates } from './FrameEventQueue';
import type { WorldEventContext } from './contracts';

/* ------------------------------------------------------------------------- */
/* Context                                                                    */
/* ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------- */
/* Domain interfaces                                                          */
/* ------------------------------------------------------------------------- */

type Handler<T extends KernelEvent['type']> = (e: KernelEventOf<T>, c: WorldEventContext) => void;

export interface ProcessVisuals {
  onCreated: Handler<'process.created'>;
  onStateChanged: Handler<'process.state_changed'>;
  onExited: Handler<'process.exited'>;
  onReaped: Handler<'process.reaped'>;
  onStarving: Handler<'process.starving'>;
  onThreadCreated: Handler<'thread.created'>;
  onThreadJoined: Handler<'thread.joined'>;
}

export interface SchedulerVisuals {
  onContextSwitch: Handler<'context.switch'>;
  onQuantumExpired: Handler<'quantum.expired'>;
}

export interface MemoryVisuals {
  onAccess: Handler<'memory.access'>;
  onPageFault: Handler<'memory.page_fault'>;
  onPageLoaded: Handler<'memory.page_loaded'>;
  onPageEvicted: Handler<'memory.page_evicted'>;
  onAllocated: Handler<'memory.allocated'>;
  onAllocationFailed: Handler<'memory.allocation_failed'>;
  onThrashing: Handler<'memory.thrashing'>;
  onTlbMiss: Handler<'tlb.miss'>;
}

export interface SyncVisuals {
  onAcquired: Handler<'sync.acquired'>;
  onBlocked: Handler<'sync.blocked'>;
  onReleased: Handler<'sync.released'>;
  onRace: Handler<'sync.race_detected'>;
  onBusyWait: Handler<'sync.busy_wait'>;
}

export interface DeadlockVisuals {
  onRequested: Handler<'resource.requested'>;
  onGranted: Handler<'resource.granted'>;
  onDenied: Handler<'resource.denied'>;
  onBankers: Handler<'bankers.evaluated'>;
  onDetected: Handler<'deadlock.detected'>;
  onResolved: Handler<'deadlock.resolved'>;
}

export interface StorageVisuals {
  onQueued: Handler<'disk.queued'>;
  onSeek: Handler<'disk.seek'>;
  onServed: Handler<'disk.served'>;
  onRaidRebuild: Handler<'raid.rebuild'>;
}

export interface IoVisuals {
  onRequest: Handler<'io.request'>;
  onInterrupt: Handler<'io.interrupt'>;
  onDma: Handler<'io.dma_transfer'>;
  onPollWasted: Handler<'io.poll_wasted'>;
}

export interface FsVisuals {
  onBlockAllocated: Handler<'fs.block_allocated'>;
  onFragmented: Handler<'fs.fragmented'>;
  onJournal: Handler<'fs.journal'>;
  onCorruption: Handler<'fs.corruption'>;
  onRecovered: Handler<'fs.recovered'>;
}

export interface SecurityVisuals {
  onAccessDenied: Handler<'security.access_denied'>;
  onEscalation: Handler<'security.escalation_attempt'>;
}

export interface SystemVisuals {
  onSyscall: Handler<'syscall.invoked'>;
  onPanic: Handler<'kernel.panic'>;
}

export interface WorldDomains {
  readonly process: ProcessVisuals;
  readonly scheduler: SchedulerVisuals;
  readonly memory: MemoryVisuals;
  readonly sync: SyncVisuals;
  readonly deadlock: DeadlockVisuals;
  readonly storage: StorageVisuals;
  readonly io: IoVisuals;
  readonly fs: FsVisuals;
  readonly security: SecurityVisuals;
  readonly system: SystemVisuals;
}

export interface WorldEventRouterOptions {
  readonly onPanic?: (message: string) => void;
  readonly stopHost?: () => void;
}

/**
 * Compile-time exhaustiveness guard. Never called at runtime, which is why it
 * may allocate and stringify: reaching it means the union grew and the build
 * should already have failed.
 */
function assertNever(x: never): never {
  throw new Error(`Unhandled KernelEvent variant: ${JSON.stringify(x)}`);
}

/* ------------------------------------------------------------------------- */
/* The router                                                                 */
/* ------------------------------------------------------------------------- */

export class WorldEventRouter {
  readonly name = 'world';
  private draining = false;
  constructor(
    private readonly d: WorldDomains,
    private readonly ctx: WorldEventContext,
    private readonly options: WorldEventRouterOptions = {},
  ) {}

  /**
   * Route one event. Called only by `FrameEventQueue.drain`, never directly, so
   * that per-frame coalescing always applies. A leg that routes an event by hand
   * bypasses the 500-fault aggregation and will blow the animation budget.
   */
  consume(e: KernelEvent): void {
    this.draining = true;
    try { this.route(e); } finally { this.draining = false; }
  }

  endFrame(aggregates: FrameAggregates): void {
    const domain = this.d.memory as MemoryVisuals & { endFrame?: (a: FrameAggregates, c: WorldEventContext) => void };
    domain.endFrame?.(aggregates, this.ctx);
    const system = this.d.system as SystemVisuals & { endFrame?: (a: FrameAggregates, c: WorldEventContext) => void };
    system.endFrame?.(aggregates, this.ctx);
  }

  route(e: KernelEvent): void {
    if (!this.draining) throw new Error('WorldEventRouter.route must be called through FrameEventQueue.drain');
    const c = this.ctx;
    switch (e.type) {
      /* ---- processes, Ch. 3 --------------------------------------------- */

      case 'process.created':
        this.d.process.onCreated(e, c);
        return;

      case 'process.state_changed':
        this.d.process.onStateChanged(e, c);
        return;

      case 'process.exited':
        this.d.process.onExited(e, c);
        return;

      case 'process.reaped':
        this.d.process.onReaped(e, c);
        return;

      case 'process.starving':
        this.d.process.onStarving(e, c);
        return;

      /* ---- scheduling, Ch. 5 -------------------------------------------- */

      case 'context.switch':
        this.d.scheduler.onContextSwitch(e, c);
        return;

      case 'quantum.expired':
        this.d.scheduler.onQuantumExpired(e, c);
        return;

      /* ---- threads, Ch. 4 ----------------------------------------------- */

      case 'thread.created':
        this.d.process.onThreadCreated(e, c);
        return;

      case 'thread.joined':
        this.d.process.onThreadJoined(e, c);
        return;

      /* ---- memory, Ch. 9 and 10 ----------------------------------------- */

      case 'memory.access':
        this.d.memory.onAccess(e, c);
        return;

      case 'memory.page_fault':
        this.d.memory.onPageFault(e, c);
        return;

      case 'memory.page_loaded':
        this.d.memory.onPageLoaded(e, c);
        return;

      case 'memory.page_evicted':
        this.d.memory.onPageEvicted(e, c);
        return;

      case 'memory.allocated':
        this.d.memory.onAllocated(e, c);
        return;

      case 'memory.allocation_failed':
        this.d.memory.onAllocationFailed(e, c);
        return;

      case 'memory.thrashing':
        this.d.memory.onThrashing(e, c);
        return;

      case 'tlb.miss':
        this.d.memory.onTlbMiss(e, c);
        return;

      /* ---- synchronisation, Ch. 6 and 7 --------------------------------- */

      case 'sync.acquired':
        this.d.sync.onAcquired(e, c);
        return;

      case 'sync.blocked':
        this.d.sync.onBlocked(e, c);
        return;

      case 'sync.released':
        this.d.sync.onReleased(e, c);
        return;

      case 'sync.race_detected':
        this.d.sync.onRace(e, c);
        return;

      case 'sync.busy_wait':
        this.d.sync.onBusyWait(e, c);
        return;

      /* ---- deadlock, Ch. 8 ---------------------------------------------- */

      case 'resource.requested':
        this.d.deadlock.onRequested(e, c);
        return;

      case 'resource.granted':
        this.d.deadlock.onGranted(e, c);
        return;

      case 'resource.denied':
        this.d.deadlock.onDenied(e, c);
        return;

      case 'bankers.evaluated':
        this.d.deadlock.onBankers(e, c);
        return;

      case 'deadlock.detected':
        this.d.deadlock.onDetected(e, c);
        return;

      case 'deadlock.resolved':
        this.d.deadlock.onResolved(e, c);
        return;

      /* ---- storage, Ch. 11 ---------------------------------------------- */

      case 'disk.queued':
        this.d.storage.onQueued(e, c);
        return;

      case 'disk.seek':
        this.d.storage.onSeek(e, c);
        return;

      case 'disk.served':
        this.d.storage.onServed(e, c);
        return;

      case 'raid.rebuild':
        this.d.storage.onRaidRebuild(e, c);
        return;

      /* ---- I/O, Ch. 12 --------------------------------------------------- */

      case 'io.request':
        this.d.io.onRequest(e, c);
        return;

      case 'io.interrupt':
        this.d.io.onInterrupt(e, c);
        return;

      case 'io.dma_transfer':
        this.d.io.onDma(e, c);
        return;

      case 'io.poll_wasted':
        this.d.io.onPollWasted(e, c);
        return;

      /* ---- file system, Ch. 13 to 15 ------------------------------------- */

      case 'fs.block_allocated':
        this.d.fs.onBlockAllocated(e, c);
        return;

      case 'fs.fragmented':
        this.d.fs.onFragmented(e, c);
        return;

      case 'fs.journal':
        this.d.fs.onJournal(e, c);
        return;

      case 'fs.corruption':
        this.d.fs.onCorruption(e, c);
        return;

      case 'fs.recovered':
        this.d.fs.onRecovered(e, c);
        return;

      /* ---- protection and security, Ch. 16 and 17 ------------------------ */

      case 'security.access_denied':
        this.d.security.onAccessDenied(e, c);
        return;

      case 'security.escalation_attempt':
        this.d.security.onEscalation(e, c);
        return;

      /* ---- system --------------------------------------------------------- */

      case 'syscall.invoked':
        this.d.system.onSyscall(e, c);
        return;

      case 'kernel.panic':
        this.d.system.onPanic(e, c);
        this.options.onPanic?.(e.message);
        this.options.stopHost?.();
        return;

      /* -------------------------------------------------------------------- */

      default:
        // If this line stops compiling, a variant was added to KernelEvent and
        // has no case above. Add the case AND the Appendix A row; the visual
        // bible and this switch are meant to fail together.
        return assertNever(e);
    }
  }
}

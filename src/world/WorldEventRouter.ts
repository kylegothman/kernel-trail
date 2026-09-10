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

/* ------------------------------------------------------------------------- */
/* Context                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * What a handler is given besides the event.
 *
 * TODO(astra): move this interface to `src/world/contracts.ts` and import it
 * here, once that file exists. It is declared inline only so this scaffold
 * compiles standalone. Do not add simulation state to it: the only channel from
 * the kernel to the world is the event stream (01-ARCHITECTURE 3.1), and a
 * context that carried a `ProcessControlBlock` would let a handler read state
 * the event did not report, which breaks replay.
 */
export interface WorldContext {
  /** Wall seconds since boot. Effects age on wall time, not simulated time. */
  readonly elapsedSeconds: number;
  /** The tick the event was produced in. Used for coalescing, never for timing. */
  readonly tick: number;
  /**
   * True while replaying the retained event ring after a device loss or a load.
   * Handlers must still reach the correct visual STATE, and must not spawn
   * effects: a recovery that fired 500 page-fault rings would be worse than the
   * black frame it was recovering from (01-ARCHITECTURE 10.3 step 6).
   */
  readonly suppressEffects: boolean;
}

/* ------------------------------------------------------------------------- */
/* Domain interfaces                                                          */
/* ------------------------------------------------------------------------- */

type Handler<T extends KernelEvent['type']> = (e: KernelEventOf<T>, c: WorldContext) => void;

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
  constructor(
    private readonly d: WorldDomains,
    private readonly ctx: WorldContext,
  ) {}

  /**
   * Route one event. Called only by `FrameEventQueue.drain`, never directly, so
   * that per-frame coalescing always applies. A leg that routes an event by hand
   * bypasses the 500-fault aggregation and will blow the animation budget.
   */
  route(e: KernelEvent): void {
    const c = this.ctx;
    switch (e.type) {
      /* ---- processes, Ch. 3 --------------------------------------------- */

      case 'process.created':
        // TODO(astra): a stele grows from the floor at its grid position over
        // DUR.travel, edges lighting from base to top; a beam connects it to its
        // parent stele for 200 ms. `parent: null` (the init process) gets no beam.
        this.d.process.onCreated(e, c);
        return;

      case 'process.state_changed':
        // TODO(astra): change edge token, dash pattern, silhouette variant and
        // pulse rate together over DUR.snap, reading SEMANTICS[state] for all
        // four. Changing colour without the other three breaks principle 1.4.
        this.d.process.onStateChanged(e, c);
        return;

      case 'process.exited':
        // TODO(astra): the derezz effect, 03-VISUAL-BIBLE section 9, with the
        // variant chosen by `reason` (TerminationReason) and the cell size and
        // duration chosen by whether the pid is a named convoy Program.
        this.d.process.onExited(e, c);
        return;

      case 'process.reaped':
        // TODO(astra): the zombie stele's inverted-normal shell collapses inward
        // over 260 ms and the grid floor draws back in beneath it, preceded by a
        // short beam from the reaping parent (`by`).
        this.d.process.onReaped(e, c);
        return;

      case 'process.starving':
        // TODO(astra): scale stele height by 1 - min(0.4, waitedTicks/threshold*0.4),
        // drain colour toward SLATE.dead, climb the pulse from STARVING_PULSE_HZ.from
        // toward .to. `fatal: true` adds a HUD alert and a 400 ms `denied` flash.
        this.d.process.onStarving(e, c);
        return;

      /* ---- scheduling, Ch. 5 -------------------------------------------- */

      case 'context.switch':
        // TODO(astra): the full six-beat sequence in 03-VISUAL-BIBLE 8.3,
        // including the amber tally mark appended to the CPU column's base at
        // 130 ms. The tally is the teaching device: do not omit it as decoration.
        this.d.scheduler.onContextSwitch(e, c);
        return;

      case 'quantum.expired':
        // TODO(astra): the quantum ring completes its rotation and flashes
        // AMBER.core at `active` for 60 ms BEFORE the switch sequence, so
        // preemption is visibly different from a voluntary yield.
        this.d.scheduler.onQuantumExpired(e, c);
        return;

      /* ---- threads, Ch. 4 ----------------------------------------------- */

      case 'thread.created':
        // TODO(astra): a filament spawns at the parent stele's base and spirals
        // up to orbit radius FORM.filament.orbitRadius over DUR.base.
        this.d.process.onThreadCreated(e, c);
        return;

      case 'thread.joined':
        // TODO(astra): the filament retracts into the stele over DUR.quick and
        // the stele's core brightens by 8% for 90 ms.
        this.d.process.onThreadJoined(e, c);
        return;

      /* ---- memory, Ch. 9 and 10 ----------------------------------------- */

      case 'memory.access':
        // TODO(astra): `hit` brightens the plate's centre line to `active` for
        // 90 ms; `write` sets the plate's hatch to `diagonal` and its token to
        // `page_dirty` over DUR.snap. Dirt is permanent until eviction, which is
        // exactly the invariant, so do not decay it on a timer.
        this.d.memory.onAccess(e, c);
        return;

      case 'memory.page_fault':
        // TODO(astra): faulting stele goes `blocked`; a hollow ring appears on
        // the target socket and contracts from 1.4x to 1.0x over the fault's
        // service time. `major` routes a beam to the platter first and uses the
        // full contraction; minor pulls from the frame-cache shelf in DUR.quick.
        this.d.memory.onPageFault(e, c);
        return;

      case 'memory.page_loaded':
        // TODO(astra): the plate rises from the backing-store trench, travels the
        // vault aisle at 6 m/s so travel time reads as distance, and seats with a
        // 4% overshoot resolved over 60 ms with EASE.out; socket edge flashes
        // `hot` for 80 ms then settles to `page_clean`.
        this.d.memory.onPageLoaded(e, c);
        return;

      case 'memory.page_evicted':
        // TODO(astra): the two-column table in 03-VISUAL-BIBLE 8.4. A dirty page
        // opens an amber write-back ribbon first and takes 220 ms longer than a
        // clean one. That 220 ms IS the write-back cost made countable; keep it
        // even when the animation budget aggregates the rest of the effect.
        this.d.memory.onPageEvicted(e, c);
        return;

      case 'memory.allocated':
        // TODO(astra): light the allocated slabs in sequence along the yard at
        // 40 ms intervals, in `frames` order, so the allocation's contiguity or
        // scatter is visible in the order they light.
        this.d.memory.onAllocated(e, c);
        return;

      case 'memory.allocation_failed':
        // TODO(astra): light every free hole in `frame_free` cyan with its size
        // labelled and float an amber bar of length `requested` above.
        // `reason: 'fragmentation'` additionally draws a summed-length bar so the
        // player can compare total free space against the largest hole.
        this.d.memory.onAllocationFailed(e, c);
        return;

      case 'memory.thrashing':
        // TODO(astra): warning and critical states per 10.1. Outside leg 8: dim
        // the horizon, drop ambient, push the HUD fault meter into its amber
        // band, and cycle the vault sockets visibly faster than they can be read.
        this.d.memory.onThrashing(e, c);
        return;

      case 'tlb.miss':
        // TODO(astra): a short amber beam stele -> TLB -> page table -> frame,
        // drawn in sequence over 180 ms. A hit skips straight to the frame in
        // 40 ms. The difference in path length is the entire lesson.
        this.d.memory.onTlbMiss(e, c);
        return;

      /* ---- synchronisation, Ch. 6 and 7 --------------------------------- */

      case 'sync.acquired':
        // TODO(astra): an arc sweeps the ring's gap closed over 120 ms with
        // EASE.snap, the seam flashes SLATE.primary at `critical` for 40 ms, and
        // a thin holder beam connects the ring to the stele for as long as it
        // holds. That beam is the foundation of the wait-for graph.
        this.d.sync.onAcquired(e, c);
        return;

      case 'sync.blocked':
        // TODO(astra): amber front bar on the stele, a `blocked` beam to the
        // ring, and the ring breaks into exactly `queueLength` arcs with visible
        // gaps. Counting the arcs counts the queue, so the count must be exact
        // and must never be caught mid-transition.
        this.d.sync.onBlocked(e, c);
        return;

      case 'sync.released':
        // TODO(astra): the seam splits, the ring opens by 8 degrees over 100 ms,
        // the holder beam retracts. Non-null `woke` fires a beam to that stele
        // over 60 ms and sets it `ready`. If SyncPrimitive.ordered is false, the
        // remaining arcs visibly shuffle, which is how unbounded waiting is shown
        // before it is named.
        this.d.sync.onReleased(e, c);
        return;

      case 'sync.race_detected':
        // TODO(astra): two overlapping ghost copies of the participating stele at
        // 45% opacity, executing `race.interleaving` as world-space labels along
        // the span, converging on a readout showing `corruptedValue` in amber
        // beside `expectedValue` in cyan.
        this.d.sync.onRace(e, c);
        return;

      case 'sync.busy_wait':
        // TODO(astra): the stele STAYS `running` (white-hot) and its service fill
        // line keeps draining while a tight amber ring orbits at
        // 2 + spunTicks * 0.1 Hz. A process at full power accomplishing nothing
        // is the lesson; do not dim it to look "waiting".
        this.d.sync.onBusyWait(e, c);
        return;

      /* ---- deadlock, Ch. 8 ---------------------------------------------- */

      case 'resource.requested':
        // TODO(astra): a DASHED `blocked`-amber beam opens stele -> ring. Dashed
        // rather than solid because the request is not yet granted.
        this.d.deadlock.onRequested(e, c);
        return;

      case 'resource.granted':
        // TODO(astra): the dashed beam goes solid, the ring's instance count
        // decrements by removing one lit segment, and that segment travels to the
        // stele and docks.
        this.d.deadlock.onGranted(e, c);
        return;

      case 'resource.denied':
        // TODO(astra): the dashed beam snaps back to the stele and the ring
        // flashes `denied` amber at `critical` for DENIED_FLASH_MS.
        // `reason: 'unsafe'` additionally lights the Banker's structure.
        this.d.deadlock.onDenied(e, c);
        return;

      case 'bankers.evaluated':
        // TODO(astra): light the Banker's matrix row by row following
        // `result.trace`, one step per 220 ms, each SafetyTraceStep.explanation
        // as a world-space label. Safe sequences finish with the whole matrix at
        // `active` cyan; unsafe ones hold the work vector and flash the remaining
        // rows amber.
        this.d.deadlock.onBankers(e, c);
        return;

      case 'deadlock.detected':
        // TODO(astra): every edge in `report.cycle` goes `denied` amber at
        // `critical` SIMULTANEOUSLY and holds. Attach the four CoffmanCondition
        // labels to the edges that demonstrate them, and offer a focus lock on
        // the cycle.
        this.d.deadlock.onDetected(e, c);
        return;

      case 'deadlock.resolved':
        // TODO(astra): branch on `method`. 'terminate': victims derezz with the
        // deadlock_victim variant. 'preempt': the resource segment is torn from
        // the holder and flies to the waiter, holder flashes amber. 'rollback':
        // the holder's service fill line visibly refills to an earlier value and
        // the ring's arcs rewind.
        this.d.deadlock.onResolved(e, c);
        return;

      /* ---- storage, Ch. 11 ---------------------------------------------- */

      case 'disk.queued':
        // TODO(astra): a lit marker appears on the platter rim at the request's
        // cylinder, cyan for read and amber for write, and the projected path
        // polyline redraws for the current scheduling policy.
        this.d.storage.onQueued(e, c);
        return;

      case 'disk.seek':
        // TODO(astra): sweep the head arm from `from` to `to` at a rate
        // proportional to `distance`, leaving a fading amber trail. Seek cost is
        // the length of the trail, so the trail must be proportional, not decorative.
        this.d.storage.onSeek(e, c);
        return;

      case 'disk.served':
        // TODO(astra): the rim marker flashes `hot` and a beam carries the block
        // to the requesting stele. `waitTicks` drives the length of a small amber
        // tick on the platter's wait tally.
        this.d.storage.onServed(e, c);
        return;

      case 'raid.rebuild':
        // TODO(astra): draw the failed disk dark with a lattice cage, sweep a
        // cyan reconstruction band across it at `progress`, and run parity beams
        // from the surviving platters into the band.
        this.d.storage.onRaidRebuild(e, c);
        return;

      /* ---- I/O, Ch. 12 --------------------------------------------------- */

      case 'io.request':
        // TODO(astra): branch on `mode`. 'polling': the convoy visibly stops at
        // the bollard and a cyan check pulse runs stele -> bollard -> stele,
        // repeatedly. 'interrupt': nothing until the interrupt fires. 'dma': a
        // beam opens bollard -> memory vault, bypassing every stele.
        this.d.io.onRequest(e, c);
        return;

      case 'io.interrupt':
        // TODO(astra): the bollard fires an amber spike 3 m upward over 120 ms
        // and the currently running stele's edges flash amber for 90 ms as it
        // switches to the handler. `pid: null` means no process was running.
        this.d.io.onInterrupt(e, c);
        return;

      case 'io.dma_transfer':
        // TODO(astra): beam flow speed from `flowSpeedFor(e)`, with uFlowCount
        // raised from 3 to 7 when saturated. The transfer bypasses every stele,
        // and the convoy visibly continuing to walk IS the point of DMA.
        this.d.io.onDma(e, c);
        return;

      case 'io.poll_wasted':
        // TODO(astra): accumulate one amber tick on the polling stele's base per
        // wasted tick while its service line drains and nothing arrives. Keep the
        // tally geometry identical to the context-switch tally on the CPU column,
        // so the two costs are directly comparable by eye.
        this.d.io.onPollWasted(e, c);
        return;

      /* ---- file system, Ch. 13 to 15 ------------------------------------- */

      case 'fs.block_allocated':
        // TODO(astra): light the block cube on its shelf and extend an arm or
        // beam from the owning spindle. Branch on `method`: 'contiguous' a short
        // straight arm, 'linked' one more hop on the chain, 'indexed' a fan from
        // the index block, 'extent' lengthens an existing arm.
        this.d.fs.onBlockAllocated(e, c);
        return;

      case 'fs.fragmented':
        // TODO(astra): redraw the spindle's arms showing `extents` separate
        // reaches, each labelled, with a `denied`-amber halo pulsing on the
        // spindle at 1.4 Hz until defragmented.
        this.d.fs.onFragmented(e, c);
        return;

      case 'fs.journal':
        // TODO(astra): append a plate to the journal ribbon. Branch on
        // `entry.kind`: 'begin' lights it dim, 'write' fills it, 'commit' flashes
        // it `hot` for 80 ms, 'checkpoint' collapses all plates behind it into a
        // single brighter plate.
        this.d.fs.onJournal(e, c);
        return;

      case 'fs.corruption':
        // TODO(astra): ramp uCorrupt to 1 on the affected spindle and its blocks
        // over CORRUPTION.rampInMs. `recoverable: false` additionally drains the
        // spindle's emission to zero, so unrecoverable damage is dark as well as
        // broken.
        this.d.fs.onCorruption(e, c);
        return;

      case 'fs.recovered':
        // TODO(astra): retreat uCorrupt from 1 to 0 over CORRUPTION.rampOutMs.
        // If `fromJournal`, drive the retreat block by block from the journal
        // ribbon lighting in commit order rather than as a uniform fade.
        this.d.fs.onRecovered(e, c);
        return;

      /* ---- protection and security, Ch. 16 and 17 ------------------------ */

      case 'security.access_denied':
        // TODO(astra): harden the ring-wall gate corresponding to `right` to
        // SLATE.primary at `critical` for DENIED_FLASH_MS and push the requesting
        // stele back 0.4 m with EASE.snap.
        this.d.security.onAccessDenied(e, c);
        return;

      case 'security.escalation_attempt':
        // TODO(astra): `blocked: true` hardens the lattice and throws the stele
        // back with the ring numbers labelled. `blocked: false` opens the lattice
        // SILENTLY over 400 ms with no flash and no sound, and raises a fatal HUD
        // alert. The silence is the design: a successful escalation should not
        // look like an event.
        this.d.security.onEscalation(e, c);
        return;

      /* ---- system --------------------------------------------------------- */

      case 'syscall.invoked':
        // TODO(astra): a 0.3 m glyph carrying `request.name` rises from the
        // calling stele, travels to the kernel structure over 200 ms, and returns
        // cyan on `result.ok` or amber carrying the Errno on failure. Under the
        // animation budget these aggregate into a rate counter on the kernel
        // structure rather than being dropped.
        this.d.system.onSyscall(e, c);
        return;

      case 'kernel.panic':
        // TODO(astra): 03-VISUAL-BIBLE 4.6 via PostChain.updatePanic. Post floods
        // amber for PANIC_POST.floodMs, every emissive object goes to `critical`,
        // ALL motion stops, `message` renders at `display` size in world space at
        // frame centre, then the scene cuts to black over PANIC_POST.cutMs.
        this.d.system.onPanic(e, c);
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

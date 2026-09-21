/**
 * The audio consumer: architecture 3.3's `EventConsumer`, with one exhaustive
 * switch over `KernelEvent['type']` ending in `assertNever`, the same shape as
 * `src/world/WorldEventRouter.ts`. Deleting a case is a compile error.
 *
 * Every silent case says why, in a comment beginning "Deliberate silence", so
 * the source scan in tests/audio/eventSounds.test.ts can tell silence from an
 * oversight. `consume` never throws: the whole body is guarded and a failure
 * is counted rather than propagated, because `EventFanout` disables a consumer
 * that throws for the rest of the leg.
 *
 * WP-25: no kernel metric reaches the score. The load model that once read
 * ticks, switches, faults and wait queues out of this stream is gone; the
 * consumer routes cues, aggregates fault density, and pumps the score's
 * sequencer once per frame.
 */
import type { KernelEvent } from '@kernel/types';
import { FAULT_DENSITY, GRAIN, INTERRUPT_TICKS_PER_FRAME } from '../synth/constants';
import type { GranularVoice } from '../voices/GranularVoice';
import type { Score } from '../score/Score';
import type { FrameAggregates } from '@world/FrameEventQueue';
import type { PositionSource } from './PositionSource';
import type { SoundBank } from './eventSounds';
import { PAN_CLAMP } from '../synth/constants';

/** Architecture 3.3. Declared here because `src/app/EventFanout.ts` does not exist yet. */
export interface EventConsumer {
  readonly name: string;
  beginFrame(): void;
  consume(e: KernelEvent): void;
  endFrame(): void;
}

/** What the consumer needs from the engine, kept narrow for the tests. */
export interface ConsumerHost {
  readonly bank: SoundBank;
  readonly positions: PositionSource;
  readonly mono: boolean;
  readonly ready: boolean;
  readonly now: number;
  readonly score: Score | null;
  /** The long-lived world-bus granular voice that carries fault density. */
  faultTexture(): GranularVoice | null;
  granulars(): readonly GranularVoice[];
}

export interface ConsumerStats {
  consumed: number;
  errors: number;
  frames: number;
  faultDensityUpdates: number;
}

export class AudioConsumer implements EventConsumer {
  readonly name = 'audio';
  readonly stats: ConsumerStats = { consumed: 0, errors: 0, frames: 0, faultDensityUpdates: 0 };
  private frameStart = 0;
  private frameOpen = false;
  private faultsThisFrame = 0;
  private aggregateFaults: number | null = null;
  private interruptsThisFrame = 0;

  constructor(private readonly host: ConsumerHost) {}

  beginFrame(): void {
    this.frameOpen = true;
    this.frameStart = this.host.now;
    this.faultsThisFrame = 0;
    this.aggregateFaults = null;
    this.interruptsThisFrame = 0;
  }

  /**
   * The coalesced stream hides suppressed faults; the drain's aggregates carry
   * the true count. Accepted before or after `endFrame`.
   * TODO(astra): WP-19 calls this from the shared queue's endFrame aggregates
   */
  observeAggregates(aggregates: FrameAggregates): void {
    if (this.frameOpen) {
      this.aggregateFaults = aggregates.faultCount;
    } else {
      this.applyFaultDensity(aggregates.faultCount, this.host.now);
    }
  }

  consume(e: KernelEvent): void {
    this.stats.consumed += 1;
    try {
      this.route(e);
    } catch {
      this.stats.errors += 1;
    }
  }

  endFrame(): void {
    try {
      this.finishFrame();
    } catch {
      this.stats.errors += 1;
    }
    this.frameOpen = false;
  }

  private route(e: KernelEvent): void {
    const bank = this.host.bank;
    switch (e.type) {
      /* ---- processes, Ch. 3 ------------------------------------------- */
      case 'process.created':
        bank.processCreated(e, this.pan(e));
        return;
      case 'process.state_changed':
        // Deliberate silence: every transition is already the consequence of an
        // event that sounds (a switch, a block, an exit), and a second cue for the
        // same fact would double every beat in the game.
        return;
      case 'process.exited':
        bank.processExited(e, this.pan(e));
        return;
      case 'process.reaped':
        // Deliberate silence: the death has already sounded at process.exited;
        // reaping is bookkeeping and its collapse is a visual beat only.
        return;
      case 'process.starving':
        bank.processStarving(e, this.pan(e));
        return;
      case 'context.switch':
        bank.contextSwitch(e, this.pan(e));
        return;
      case 'quantum.expired':
        // Deliberate silence: it is always followed by the context.switch it
        // caused, whose click lands on the score's grid; a second click would
        // smear the beat.
        return;
      case 'thread.created':
      case 'thread.joined':
        // Deliberate silence: leg 2 spawns filaments by the dozen per tick and
        // the spiral is the readable channel; a tick per thread reads as noise.
        return;

      /* ---- memory, Ch. 9 and 10 --------------------------------------- */
      case 'memory.access':
        // Deliberate silence: package line 239. Hundreds per tick; the heat map
        // reads a counter and so does nothing here.
        return;
      case 'memory.page_fault':
        // Aggregated to a density at endFrame, never one grain per fault.
        this.faultsThisFrame += 1;
        return;
      case 'memory.page_loaded':
        // Deliberate silence: loads are as frequent as faults and the fault
        // density already carries the rate; the seat overshoot is visual.
        return;
      case 'memory.page_evicted':
        bank.pageEvicted(e, this.pan(e));
        return;
      case 'memory.allocated':
        // Deliberate silence: contiguity is read by eye from the 40 ms slab
        // sequence; an arpeggio per allocation would fight the score's pitch set.
        return;
      case 'memory.allocation_failed':
        bank.allocationFailed(this.pan(e));
        return;
      case 'memory.thrashing':
        bank.thrashing(e, this.pan(e));
        return;
      case 'tlb.miss':
        // Deliberate silence: up to eight are sampled per frame and the lesson
        // is the beam's path length, which is visual; the miss rate is felt
        // through the fault density it produces.
        return;

      /* ---- synchronisation, Ch. 6 and 7 ------------------------------- */
      case 'sync.acquired':
        bank.syncAcquired(e, this.pan(e));
        return;
      case 'sync.blocked':
        // Deliberate silence: a block can repeat every tick for every waiter;
        // the queue is drawn as a queue, and the crossing section is the music
        // of contention. A cue per block would be a metronome under a held panel.
        return;
      case 'sync.released':
        bank.syncReleased(e, this.pan(e));
        return;
      case 'sync.race_detected':
        bank.raceDetected(this.pan(e));
        return;
      case 'sync.busy_wait':
        // Deliberate silence: it can emit every tick; the orbiting amber ring is
        // the channel, and a spin does not change the wait queues.
        return;

      /* ---- deadlock, Ch. 8 -------------------------------------------- */
      case 'resource.requested':
        // Deliberate silence: the request is a dashed beam; the grant or the
        // denial that answers it sounds.
        return;
      case 'resource.granted':
        bank.resourceGranted(e, this.pan(e));
        return;
      case 'resource.denied':
        bank.denial(this.pan(e), 0.6);
        return;
      case 'bankers.evaluated':
        // Deliberate silence: the matrix trace is a 220 ms per row visual
        // sequence, and its outcome sounds as resource.granted or denied.
        return;
      case 'deadlock.detected':
        bank.deadlockDetected();
        return;
      case 'deadlock.resolved':
        bank.deadlockResolved(e, this.pan(e));
        return;

      /* ---- storage and I/O, Ch. 11 to 13 ------------------------------ */
      case 'disk.queued':
        // Deliberate silence: the rim marker is enough; the seek and the serve
        // that follow both sound.
        return;
      case 'disk.seek':
        bank.diskSeek(e, this.pan(e));
        return;
      case 'disk.served':
        bank.diskServed(this.pan(e));
        return;
      case 'raid.rebuild':
        // Deliberate silence: progress arrives as a stream of events and the
        // reconstruction band is the readout; a cue per step would be a metronome.
        return;
      case 'io.request':
        // Deliberate silence: Appendix A, nothing until the interrupt; polling
        // is the convoy visibly stopping and DMA sounds at the transfer.
        return;
      case 'io.interrupt':
        this.interruptsThisFrame += 1;
        if (this.interruptsThisFrame <= INTERRUPT_TICKS_PER_FRAME) {
          bank.interruptTick(this.frameStart + 0.005 + this.interruptsThisFrame * 0.004, this.pan(e));
        }
        return;
      case 'io.dma_transfer':
        bank.dmaTransfer(e, this.pan(e));
        return;
      case 'io.poll_wasted':
        // Deliberate silence: one per tick while polling; the tally on the
        // stele's base is the channel, and the stalled convoy is the picture.
        return;

      /* ---- file system, Ch. 13 to 15 ---------------------------------- */
      case 'fs.block_allocated':
        // Deliberate silence: leg 11 allocates chains of blocks per tick; the
        // arm reaching for each is the channel.
        return;
      case 'fs.fragmented':
        bank.fsFragmented(this.pan(e));
        return;
      case 'fs.journal':
        bank.fsJournal(e, this.pan(e));
        return;
      case 'fs.corruption':
        bank.fsCorruption(e, this.pan(e));
        return;
      case 'fs.recovered':
        bank.fsRecovered(this.pan(e));
        return;

      /* ---- protection and security, Ch. 16 and 17 --------------------- */
      case 'security.access_denied':
        bank.denial(this.pan(e), 0.8);
        return;
      case 'security.escalation_attempt':
        // Appendix A: an unblocked escalation opens silently, no flash and no sound.
        if (e.blocked) bank.denial(this.pan(e), 0.9);
        return;

      /* ---- kernel ------------------------------------------------------ */
      case 'syscall.invoked':
        // Deliberate silence: package line 240. No sound individually; the
        // trap is the mode flip the terminal prints, and the switch it causes
        // clicks on the grid.
        return;
      case 'kernel.panic':
        bank.kernelPanic();
        return;
      default:
        return assertNever(e);
    }
  }

  private pan(e: KernelEvent): number {
    if (this.host.mono) return 0;
    const x = this.host.positions.xOf(e);
    if (x === null || !Number.isFinite(x)) return 0;
    return Math.min(PAN_CLAMP, Math.max(-PAN_CLAMP, x));
  }

  private finishFrame(): void {
    this.stats.frames += 1;
    if (!this.host.ready) return;
    const now = this.host.now;
    // WP-25 section 2: the frame pumps the sequencer too, so the score keeps
    // time even when the session has handed the engine no interval.
    this.host.score?.pump(now);
    this.applyFaultDensity(this.aggregateFaults ?? this.faultsThisFrame, now);
    const until = now + GRAIN.lookaheadMs / 1000;
    for (const g of this.host.granulars()) g.scheduleUntil(until);
  }

  /** One density change per frame. Architecture 3.7: 500 faults is full intensity. */
  private applyFaultDensity(faults: number, now: number): void {
    const texture = this.host.faultTexture();
    if (texture === null) return;
    const intensity = Math.min(1, faults / FAULT_DENSITY.fullAtFaults);
    if (faults > 0) {
      if (!texture.busy) {
        texture.bus = 'world';
        texture.start(now, { intensity, gain: 0.26, filterHz: 2200, pitchJitter: 0.25, pan: 0 });
      } else {
        texture.setDensity(intensity, now);
      }
      this.stats.faultDensityUpdates += 1;
      return;
    }
    if (texture.busy) {
      const decayed = texture.density * 0.6;
      if (decayed < 0.02) texture.stop(now);
      else texture.setDensity(decayed, now);
      this.stats.faultDensityUpdates += 1;
    }
  }
}

/** Compile-time exhaustiveness guard. Reaching it means the union grew. */
function assertNever(x: never): never {
  throw new Error(`Unhandled KernelEvent variant: ${JSON.stringify(x)}`);
}

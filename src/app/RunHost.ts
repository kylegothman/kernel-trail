import type { CommandBus, LegRunner, RunStore, TelemetryStore } from '@game/index';
import { LEG_ORDER } from '@game/types';
import type { KernelEvent } from '@kernel/index';
import { FrameEventQueue } from '@world/index';
import type { SimHost } from './loop';

export interface RunHost extends SimHost {
  readonly queue: FrameEventQueue;
}
export interface RunHostDeps {
  readonly runner: LegRunner;
  readonly commandBus: CommandBus;
  readonly runStore: RunStore;
  readonly telemetry: TelemetryStore;
  readonly hooks?: Partial<Pick<SimHost,
    'variableUpdate' | 'render' | 'onFrameMetrics' | 'onRunStateChanged'
  >>;
}

/** Headless frame seam. The browser boot owns the optional visual hooks and consumers. */
export function createRunHost(deps: RunHostDeps): RunHost {
  const queue = new FrameEventQueue();
  let pending: KernelEvent[] = [];
  let unsubscribe: (() => void) | null = null;
  // The runner announces after populate, before accepting commands. This also
  // captures synchronous terminal writes made between frames on the new kernel.
  deps.runner.onKernelChanged(kernel => {
    unsubscribe?.();
    unsubscribe = null;
    pending = [];
    const seen = new Set<number>();
    if (kernel !== null) unsubscribe = kernel.events.onAny(event => {
      if (seen.has(event.seq)) return;
      seen.add(event.seq);
      pending.push(event);
      queue.push([event]);
    });
  });

  return {
    queue,
    applyPendingCommands(_frameTick) {
      const kernel = deps.runner.kernel;
      const director = deps.runner.director;
      if (kernel === null || director === null) return;
      director.observeCommands(deps.commandBus.drain(kernel.tick));
    },
    fixedUpdate(_frameTick) {
      const kernel = deps.runner.kernel;
      const director = deps.runner.director;
      if (kernel === null || director === null || deps.runner.phase !== 'travelling' || director.complete) return;
      director.preTick(kernel.tick);
      if (director.tickLimitReached) return;
      kernel.step();
      const events = pending.splice(0);
      director.postTick(kernel.tick, events);
      // Post-tick lifecycle emissions already reached the queue and the
      // director's observer. They must not be delivered again next tick.
      pending = [];
    },
    flushState() {
      const kernel = deps.runner.kernel;
      const leg = deps.runner.currentLeg;
      if (kernel !== null && leg !== null) {
        const view = kernel.invariantState();
        deps.telemetry.mutate(t => {
          t.tick = kernel.tick;
          t.cpuUtilisation = view.metrics.scheduling.cpuUtilisation;
          t.faultRate = view.metrics.memory.faultRate;
          t.thrashingThreshold = view.config.thrashingThreshold;
          t.scheduler = view.schedulerId;
          t.quantum = view.schedulerParams.quantum;
          t.replacement = kernel.activeReplacementPolicy;
          t.disk = kernel.activeDiskPolicy;
          t.allocation = kernel.activeAllocationStrategy;
          t.leg = { title: leg.title, index: leg.index, count: LEG_ORDER.length - 1 };
        });
      }
      deps.runStore.flush();
      deps.telemetry.flush();
    },
    routeEvents() {
      queue.drain(events => {
        const tick = events.at(-1)?.tick ?? deps.runner.kernel?.tick;
        if (tick !== undefined) deps.runner.routeEvents(events, tick);
      });
    },
    variableUpdate(dtSeconds, alpha) { deps.hooks?.variableUpdate?.(dtSeconds, alpha); },
    render(alpha) { deps.hooks?.render?.(alpha); },
    onFrameMetrics(metrics) { deps.hooks?.onFrameMetrics?.(metrics); },
    onRunStateChanged(running) { deps.hooks?.onRunStateChanged?.(running); },
  };
}

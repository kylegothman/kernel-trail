/**
 * KERNEL TRAIL - the headless leg registry. Architecture 9.4, third
 * implementer note; WP-18 scope correction U13 and pre-flight ruling 8.
 *
 * `src/legs/registry.ts` maps ids to dynamic imports with a network retry and
 * is the main thread's loader. The worker must not use it: it has no network
 * wait to hide, and a leg's `createStage` pulls `@world`. This registry maps
 * the same fourteen ids to factories returning the simulation half of a leg,
 * which is what replay needs and all it may touch. Phase 1 ships fourteen
 * throwing stubs; a leg package registers its factory here in phase 2.
 */

import type { Leg, LegId, LegSetupContext, RunState, ProcessSpec } from '@game/types';
import { asResourceId, type ConvoyMemberId, type Pid, type Rng } from '@kernel/types';
import type { HeadlessLeg, HeadlessLegFactory, ReplayHooks, ReplayKernel } from './types';

function stub(id: LegId): HeadlessLegFactory {
  return () => {
    throw new Error(`not implemented: headless leg ${id}: phase 2 leg packages register here`);
  };
}

/** Mutable on purpose: `registerHeadlessLeg` writes into it. */
export const HEADLESS_LEGS: Record<LegId, HeadlessLegFactory> = {
  // TODO(astra): phase 2 leg packages register here: boot_sector, WP-L00
  boot_sector: stub('boot_sector'),
  // TODO(astra): phase 2 leg packages register here: fork_fields, WP-L01
  fork_fields: stub('fork_fields'),
  // TODO(astra): phase 2 leg packages register here: the_weave, WP-L02
  the_weave: stub('the_weave'),
  // TODO(astra): phase 2 leg packages register here: quantum_pass, WP-L03
  quantum_pass: stub('quantum_pass'),
  // TODO(astra): phase 2 leg packages register here: the_narrows, WP-L04
  the_narrows: stub('the_narrows'),
  // TODO(astra): phase 2 leg packages register here: the_cistern, WP-L05
  the_cistern: stub('the_cistern'),
  // TODO(astra): phase 2 leg packages register here: the_gridlock, WP-L06
  the_gridlock: stub('the_gridlock'),
  // TODO(astra): phase 2 leg packages register here: allocation_yards, WP-L07
  allocation_yards: stub('allocation_yards'),
  // TODO(astra): phase 2 leg packages register here: drowned_reach, WP-L08
  drowned_reach: stub('drowned_reach'),
  // TODO(astra): phase 2 leg packages register here: the_platters, WP-L09
  the_platters: stub('the_platters'),
  // TODO(astra): phase 2 leg packages register here: the_bus, WP-L10
  the_bus: stub('the_bus'),
  // TODO(astra): phase 2 leg packages register here: the_archive, WP-L11
  the_archive: stub('the_archive'),
  // TODO(astra): phase 2 leg packages register here: arbiter_wall, WP-L12
  arbiter_wall: stub('arbiter_wall'),
  // TODO(astra): phase 2 leg packages register here: the_portal, WP-L13
  the_portal: stub('the_portal'),
};

/** Install a factory. Returns the undo, so a test can put the stub back. */
export function registerHeadlessLeg(id: LegId, factory: HeadlessLegFactory): () => void {
  const previous = HEADLESS_LEGS[id];
  HEADLESS_LEGS[id] = factory;
  return () => {
    HEADLESS_LEGS[id] = previous;
  };
}

export function resolveHeadlessLeg(id: LegId): HeadlessLeg {
  return HEADLESS_LEGS[id]();
}

/** The simulation half of a full `Leg`, with `createStage` dropped. */
export function headlessOf(leg: Leg, hooks?: ReplayHooks): HeadlessLeg {
  const base: HeadlessLeg = {
    id: leg.id,
    index: leg.index,
    kernelConfig: (run) => leg.kernelConfig(run),
    populate: (ctx) => leg.populate(ctx),
    eventTable: leg.eventTable,
    evaluate: (ctx) => leg.evaluate(ctx),
  };
  return hooks === undefined ? base : { ...base, hooks };
}

/** `bind(member, pid)` calls a leg's `populate` makes; the runner's side table, never a PCB field. */
export type ConvoyBindings = Map<ConvoyMemberId, Pid>;

/**
 * The populate path. Pre-flight ruling 8: WP-19's live runner builds its
 * `LegSetupContext` through this function too, because a spawn that went
 * through a different road (the syscall table, say) would emit different
 * events and break the identity between a live leg and its replay.
 */
export function createHeadlessSetupContext(
  kernel: ReplayKernel,
  run: RunState,
  rng: Rng,
  bindings: ConvoyBindings,
  transform?: (spec: ProcessSpec) => ProcessSpec,
): LegSetupContext {
  return {
    run,
    rng: { next: () => rng.next(), int: (a, b) => rng.int(a, b) },
    spawn: (spec) => {
      const transformed = transform === undefined ? spec : transform(spec);
      return kernel.spawn(
        {
          name: transformed.name,
          priority: transformed.priority,
          burst: transformed.burst,
          service: transformed.service,
          arrival: transformed.arrival,
          pages: transformed.pages,
          ...(transformed.referenceString === undefined ? {} : { referenceString: transformed.referenceString }),
        },
        transformed.serialFraction === undefined ? {} : { serialFraction: transformed.serialFraction },
      );
    },
    bind: (member, pid) => {
      bindings.set(member, pid);
    },
    declareResource: (id, instances, preemptible) => {
      kernel.declareResource({ id: asResourceId(id), displayName: id, totalInstances: instances, preemptible });
    },
    declareSync: (id, kind, capacity) => {
      const resource = asResourceId(id);
      switch (kind) {
        case 'mutex':
          kernel.syncSubsystem.createMutex(resource);
          break;
        case 'semaphore':
          kernel.syncSubsystem.createSemaphore(resource, capacity);
          break;
        case 'monitor':
          kernel.syncSubsystem.createMonitor(resource);
          break;
        case 'rwlock':
          kernel.syncSubsystem.createRwlock(resource, capacity);
          break;
        default:
          throw new Error(`unknown sync kind ${String(kind)}`);
      }
    },
  };
}

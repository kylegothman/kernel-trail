/**
 * A kernel carrying this leg's own workload, built the way the runner builds
 * it: `populate` through the recording setup context, then the workload's
 * programs at spawn and its `install` afterwards. The suites that need to
 * watch the ledger posts tick by tick use this rather than the whole harness.
 */
import { createKernel, type KernelImpl } from '@kernel/Kernel';
import { instructionProgram } from '@kernel/process/Program';
import { asResourceId, type KernelEvent, type Pid, type ResourceId } from '@kernel/types';
import { initialRunState } from '@game/replay/runReplay';
import type { RunState } from '@game/types';
import { kernelConfig } from '@legs/the_narrows/config';
import { CELL_FAR, CELL_NEAR, install, programs, REGION_FAR, REGION_NEAR } from '@legs/the_narrows/ledger';
import { ROSTER, SYNC_DECLARATIONS } from '@legs/the_narrows/populate';

export const FIXTURE_SEED = 0x4b54524c;

export interface NarrowsKernel {
  readonly kernel: KernelImpl;
  readonly pids: ReadonlyMap<string, Pid>;
  readonly log: KernelEvent[];
  run(ticks: number): void;
  post(which: 'near' | 'far'): { readonly value: number; readonly serial: number };
  events(type: string): readonly KernelEvent[];
}

export function narrowsKernel(patch: Partial<RunState> = {}): NarrowsKernel {
  const run = { ...initialRunState(FIXTURE_SEED, 'shell', 'operator'), ...patch };
  const kernel = createKernel(kernelConfig(run), { devBuild: true, checkInvariants: true });
  const pids = new Map<string, Pid>();
  for (const spec of ROSTER) {
    const program = programs[spec.name];
    const pid = kernel.spawn(
      { name: spec.name, priority: spec.priority, burst: spec.burst, service: spec.service, arrival: spec.arrival, pages: 3 },
      program === undefined ? {} : { program: instructionProgram(program) },
    );
    pids.set(spec.name, pid);
  }
  for (const declaration of SYNC_DECLARATIONS) {
    const id: ResourceId = asResourceId(declaration.id);
    switch (declaration.kind) {
      case 'mutex': kernel.syncSubsystem.createMutex(id); break;
      case 'semaphore': kernel.syncSubsystem.createSemaphore(id, declaration.capacity); break;
      case 'monitor': kernel.syncSubsystem.createMonitor(id); break;
      case 'rwlock': kernel.syncSubsystem.createRwlock(id, declaration.capacity); break;
    }
  }
  install(kernel, pids);
  const log: KernelEvent[] = [];
  return {
    kernel,
    pids,
    log,
    run: (ticks) => { for (let tick = 0; tick < ticks; tick += 1) log.push(...kernel.step()); },
    post: (which) => {
      const region = which === 'near' ? REGION_NEAR : REGION_FAR;
      const cell = which === 'near' ? CELL_NEAR : CELL_FAR;
      const cells = kernel.snapshot().subsystems?.sync?.payload.raceDetector.cells ?? [];
      return { value: kernel.ipc.sharedRegion(region)?.value ?? 0, serial: cells.find((row) => row.cell === cell)?.serialValue ?? 0 };
    },
    events: (type) => log.filter((event) => event.type === type),
  };
}

import type { InvariantView, ResourceId, SyncPrimitive } from '@kernel/index';

/** V8: live wait ages are snapshot-consistent; acquisition history is unavailable. */
export function meanWaitAge(view: InvariantView, id: ResourceId): number {
  const waits = view.syncWaits.filter((wait) => wait.resource === id);
  return waits.length === 0 ? 0 : waits.reduce((sum, wait) => sum + Math.max(0, view.tick - wait.requestedAt), 0) / waits.length;
}

export function contention(view: InvariantView, lock: SyncPrimitive): number {
  const queuePressure = Math.min(1, lock.waitQueue.length / Math.max(1, lock.capacity * 2));
  const holdPressure = Math.min(1, meanWaitAge(view, lock.id) / view.schedulerParams.quantum);
  const blocked = view.processes.filter((process) => process.state === 'waiting').length;
  const runnable = view.processes.filter((process) => process.state === 'ready' || process.state === 'running').length;
  const systemPressure = blocked / Math.max(1, blocked + runnable);
  return Math.min(1, Math.max(0, 0.50 * queuePressure + 0.30 * holdPressure + 0.20 * systemPressure));
}

/**
 * KERNEL TRAIL - the main-thread handle on the bake worker (architecture
 * 9.1). Results transfer as ArrayBuffer with zero copy: the worker hands
 * over the audio set's backing stores, and `isAudioBufferSet` validates
 * what arrives before anything trusts it.
 */

import { isAudioBufferSet } from '@audio/buffers';
import { WorkerChannel, adaptWorker, isRecord, type BakeJob, type BakeResult, type WorkerFactory } from './protocol';

/** The `new URL` form is what lets Vite bundle the worker as its own chunk. */
export const defaultBakeWorkerFactory: WorkerFactory = () =>
  adaptWorker(new Worker(new URL('./bake.worker.ts', import.meta.url), { type: 'module' }));

function isBakeResult(value: unknown): value is BakeResult {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'audio_buffers') return isAudioBufferSet(value['set']);
  if (value['kind'] === 'codex_index') {
    const index = value['index'];
    return isRecord(index) && Array.isArray(index['ids']) && index['postings'] instanceof Map;
  }
  return false;
}

export class BakeWorkerHandle {
  private readonly channel: WorkerChannel;

  constructor(factory: WorkerFactory = defaultBakeWorkerFactory) {
    this.channel = new WorkerChannel(factory);
  }

  get spawnCount(): number {
    return this.channel.spawnCount;
  }

  async bake<J extends BakeJob>(job: J): Promise<Extract<BakeResult, { kind: J['kind'] }>> {
    const payload = await this.channel.send('bake', job);
    if (!isBakeResult(payload) || payload.kind !== job.kind) throw new Error('Bake worker returned a malformed reply.');
    return payload as Extract<BakeResult, { kind: J['kind'] }>;
  }

  dispose(): void {
    this.channel.terminate();
  }
}

/**
 * KERNEL TRAIL - the main-thread handle on the persist worker (architecture
 * 9.1). The same one-instance, respawn-on-crash channel as the replay
 * handle; a request rejects on a crash, because a save that could not be
 * checksummed is a caller's decision, not a silent null.
 */

import type { SaveFile } from '@game/types';
import { WorkerChannel, adaptWorker, isRecord, type PersistJob, type WorkerFactory } from './protocol';

/** The `new URL` form is what lets Vite bundle the worker as its own chunk. */
export const defaultPersistWorkerFactory: WorkerFactory = () =>
  adaptWorker(new Worker(new URL('./persist.worker.ts', import.meta.url), { type: 'module' }));

export class PersistWorkerHandle {
  private readonly channel: WorkerChannel;

  constructor(factory: WorkerFactory = defaultPersistWorkerFactory) {
    this.channel = new WorkerChannel(factory);
  }

  get spawnCount(): number {
    return this.channel.spawnCount;
  }

  private async job(job: PersistJob): Promise<Record<string, unknown>> {
    const payload = await this.channel.send('persist', job);
    if (!isRecord(payload) || payload['kind'] !== job.kind) throw new Error('Persist worker returned a malformed reply.');
    return payload;
  }

  /** `checksumOf(file, salt)` off the main thread; identical to the main-thread value by construction. */
  async checksum(file: Omit<SaveFile, 'checksum'>, salt?: string): Promise<string> {
    const reply = await this.job(salt === undefined ? { kind: 'checksum', file } : { kind: 'checksum', file, salt });
    const checksum = reply['checksum'];
    if (typeof checksum !== 'string') throw new Error('Persist worker returned no checksum.');
    return checksum;
  }

  async canonicalise(value: unknown): Promise<string> {
    const reply = await this.job({ kind: 'canonicalise', value });
    const text = reply['text'];
    if (typeof text !== 'string') throw new Error('Persist worker returned no text.');
    return text;
  }

  dispose(): void {
    this.channel.terminate();
  }
}

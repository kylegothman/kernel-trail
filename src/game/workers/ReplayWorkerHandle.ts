/**
 * KERNEL TRAIL - the main-thread handle on the replay worker. Architecture
 * 9.4, followed exactly: one worker instance created lazily on the first
 * request and reused for the session; a 1500 ms timeout posts a cancel and
 * resolves `{ ok: false, reason: 'timeout' }`; `onerror` fails every pending
 * request and terminates the worker, and the next request respawns it. A
 * crashed replay worker is invisible except that one debrief card lacks its
 * counterfactual, which is the resilience posture of architecture 10
 * applied to a non-essential subsystem.
 */

import type { ReplayRequest, ReplayResponse } from '@game/replay/types';
import { WorkerChannel, adaptWorker, isRecord, type WorkerFactory } from './protocol';

export const REPLAY_TIMEOUT_MS = 1500;

/** The `new URL` form is what lets Vite bundle the worker as its own chunk. */
export const defaultReplayWorkerFactory: WorkerFactory = () =>
  adaptWorker(new Worker(new URL('./replay.worker.ts', import.meta.url), { type: 'module' }));

export interface ReplayWorkerHandleOptions {
  readonly factory?: WorkerFactory;
  readonly timeoutMs?: number;
}

function isReplayResponse(value: unknown): value is ReplayResponse {
  return isRecord(value) && typeof value['ok'] === 'boolean';
}

export class ReplayWorkerHandle {
  private readonly channel: WorkerChannel;
  private readonly timeoutMs: number;

  constructor(options: ReplayWorkerHandleOptions = {}) {
    this.channel = new WorkerChannel(options.factory ?? defaultReplayWorkerFactory);
    this.timeoutMs = options.timeoutMs ?? REPLAY_TIMEOUT_MS;
  }

  /** How many workers this handle has created; one per session unless one crashed. */
  get spawnCount(): number {
    return this.channel.spawnCount;
  }

  get inFlight(): number {
    return this.channel.inFlight;
  }

  /** Never rejects: a crash or a malformed reply is an error response, so the debrief never blocks on it. */
  async run(request: ReplayRequest, timeoutMs = this.timeoutMs, onProgress?: (ticks: number) => void): Promise<ReplayResponse> {
    try {
      const payload = await this.channel.send('replay', request, {
        timeoutMs,
        onTimeout: (id): ReplayResponse => {
          this.channel.post('cancel', { targetId: id });
          return { ok: false, reason: 'timeout', message: `Replay exceeded ${timeoutMs} ms.` };
        },
        progress: (p) => {
          if (isRecord(p) && typeof p['ticks'] === 'number') onProgress?.(p['ticks']);
        },
      });
      return isReplayResponse(payload) ? payload : { ok: false, reason: 'error', message: 'Replay worker returned a malformed reply.' };
    } catch (error) {
      return { ok: false, reason: 'error', message: error instanceof Error ? error.message : 'Replay worker crashed.' };
    }
  }

  /** A leg transition or a run abandon: every outstanding replay is cancelled and resolves aborted. */
  cancelAll(): void {
    this.channel.abortAll(
      (): ReplayResponse => ({ ok: false, reason: 'aborted', message: 'Replay cancelled.' }),
      (id) => this.channel.post('cancel', { targetId: id }),
    );
  }

  dispose(): void {
    this.channel.terminate();
  }
}

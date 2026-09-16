/**
 * KERNEL TRAIL - the replay worker. Architecture 9.1 and 9.4.
 *
 * Imports `@kernel` and the headless half of `@game` only, never `@world`,
 * `@render` or `@ui`: a stray import would pull Three.js into this bundle
 * and fail at runtime with a `document is not defined`. The transitive
 * boundary case in tests/game/workerProtocol.test.ts enforces it.
 *
 * Legs are resolved from the headless registry by id, never from the
 * request. Replays run one at a time, one 500-tick chunk per macrotask, so
 * a cancel message can land between chunks: cancellation is cooperative
 * and honoured within 500 ticks. Progress is posted at the same cadence, so
 * a fast replay posts one message rather than forty.
 *
 * `createReplayWorker` is the whole worker as a pure function of its post,
 * so the Node suite drives exactly this code with an in-process fake; the
 * module installs it onto the global scope only inside a real worker.
 */

import { replaySteps, failure } from '@game/replay/runReplay';
import type { ReplayResponse } from '@game/replay/types';
import { isEnvelope, isRecord, isWorkerScope, workerScope, type ReplayInbound, type ReplayOutbound } from './protocol';

export type ReplayPost = (message: ReplayOutbound) => void;
/** Runs the next chunk later; the default is a macrotask so messages interleave. */
export type Schedule = (next: () => void) => void;

interface Job {
  readonly id: number;
  readonly steps: Generator<number, ReplayResponse, void>;
}

function isReplayInbound(value: unknown): value is ReplayInbound {
  if (!isEnvelope(value)) return false;
  if (value.kind === 'cancel') return isRecord(value.payload) && typeof value.payload['targetId'] === 'number';
  return value.kind === 'replay' && isRecord(value.payload);
}

export interface ReplayWorker {
  handle(message: unknown): void;
  readonly cancelled: ReadonlySet<number>;
  readonly queued: number;
}

export function createReplayWorker(post: ReplayPost, schedule: Schedule = (next) => setTimeout(next, 0)): ReplayWorker {
  const cancelled = new Set<number>();
  const queue: Job[] = [];
  let active: Job | null = null;
  let progressId = 1;

  const done = (id: number, payload: ReplayResponse): void => {
    cancelled.delete(id);
    post({ id, kind: 'done', payload });
  };

  const pump = (): void => {
    const job = active;
    if (job === null) return;
    let next: IteratorResult<number, ReplayResponse>;
    try {
      next = job.steps.next();
    } catch (error) {
      active = null;
      done(job.id, failure('error', error instanceof Error ? error.message : String(error)));
      start();
      return;
    }
    if (next.done) {
      active = null;
      done(job.id, next.value);
      start();
      return;
    }
    post({ id: progressId++, kind: 'progress', payload: { targetId: job.id, ticks: next.value } });
    if (cancelled.has(job.id)) {
      active = null;
      job.steps.return(failure('aborted', 'cancelled'));
      done(job.id, failure('aborted', `Replay cancelled at tick ${next.value}.`));
      start();
      return;
    }
    schedule(pump);
  };

  const start = (): void => {
    if (active !== null) return;
    const job = queue.shift();
    if (job === undefined) return;
    if (cancelled.has(job.id)) {
      done(job.id, failure('aborted', 'Replay cancelled before it began.'));
      start();
      return;
    }
    active = job;
    pump();
  };

  return {
    cancelled,
    get queued() {
      return queue.length + (active === null ? 0 : 1);
    },
    handle(message) {
      if (!isReplayInbound(message)) return;
      if (message.kind === 'cancel') {
        cancelled.add(message.payload.targetId);
        return;
      }
      queue.push({ id: message.id, steps: replaySteps(message.payload) });
      start();
    },
  };
}

if (isWorkerScope()) {
  const scope = workerScope();
  const worker = createReplayWorker((message) => scope.postMessage(message));
  scope.onmessage = (event) => worker.handle(event.data);
}

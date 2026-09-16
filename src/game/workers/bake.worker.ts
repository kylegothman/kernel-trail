/**
 * KERNEL TRAIL - the bake worker. Architecture 9.1: boot-time work that
 * runs beside capability probing and the tier benchmark, so it is free
 * wall-clock time. Two jobs have pure, worker-safe implementations today
 * (scope correction U9): the audio buffer set from `@audio/buffers`, handed
 * back with `transferList` so every backing store crosses with zero copy,
 * and the codex search index from `@ui/codex/search`, the one `@ui` import
 * a worker may make. Texture baking waits on the render track; the job
 * union in protocol.ts carries its marker.
 */

import { generateBuffers, transferList } from '@audio/buffers';
import { buildIndex } from '@ui/codex/search';
import { isEnvelope, isRecord, isWorkerScope, workerScope, type BakeInbound, type BakeJob, type BakeOutbound } from './protocol';

export type BakePost = (message: BakeOutbound, transfer?: readonly Transferable[]) => void;

function isBakeJob(value: unknown): value is BakeJob {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'audio_buffers') return typeof value['seed'] === 'number';
  return value['kind'] === 'codex_index' && Array.isArray(value['entries']);
}

function isBakeInbound(value: unknown): value is BakeInbound {
  return isEnvelope(value) && value.kind === 'bake' && isBakeJob(value.payload);
}

/** Only an ArrayBuffer is transferable; a SharedArrayBuffer is shared instead and is not one. */
function transferables(buffers: readonly ArrayBufferLike[]): ArrayBuffer[] {
  return buffers.filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer);
}

export function createBakeWorker(post: BakePost): { handle(message: unknown): void } {
  return {
    handle(message) {
      if (!isBakeInbound(message)) return;
      const job = message.payload;
      try {
        switch (job.kind) {
          case 'audio_buffers': {
            const set = job.sampleRate === undefined ? generateBuffers(job.seed) : generateBuffers(job.seed, job.sampleRate);
            post({ id: message.id, kind: 'done', payload: { kind: 'audio_buffers', set } }, transferables(transferList(set)));
            return;
          }
          case 'codex_index':
            post({ id: message.id, kind: 'done', payload: { kind: 'codex_index', index: buildIndex(job.entries) } });
            return;
          default:
            post({ id: message.id, kind: 'failed', payload: { message: 'Unknown bake job.' } });
        }
      } catch (error) {
        post({ id: message.id, kind: 'failed', payload: { message: error instanceof Error ? error.message : String(error) } });
      }
    },
  };
}

if (isWorkerScope()) {
  const scope = workerScope();
  const worker = createBakeWorker((message, transfer) => scope.postMessage(message, transfer));
  scope.onmessage = (event) => worker.handle(event.data);
}

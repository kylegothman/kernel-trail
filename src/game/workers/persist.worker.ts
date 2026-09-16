/**
 * KERNEL TRAIL - the persist worker. Architecture 9.1: canonicalising a
 * 900 KB provisional save is 3 to 6 ms of string building plus a GC spike,
 * and it happens on tab hide when the browser is already busy. It calls
 * WP-17's pure `checksumOf` and `canonicalise`, so the checksum equals the
 * main-thread value by construction.
 */

import { canonicalise, checksumOf } from '@game/save';
import { isEnvelope, isRecord, isWorkerScope, messageOf, workerScope, type PersistInbound, type PersistJob, type PersistOutbound } from './protocol';

export type PersistPost = (message: PersistOutbound) => void;

function isPersistJob(value: unknown): value is PersistJob {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'checksum') return isRecord(value['file']);
  return value['kind'] === 'canonicalise' && 'value' in value;
}

function isPersistInbound(value: unknown): value is PersistInbound {
  return isEnvelope(value) && value.kind === 'persist' && isPersistJob(value.payload);
}

export function runPersistJob(job: PersistJob): PersistOutbound['payload'] {
  switch (job.kind) {
    case 'checksum':
      return { kind: 'checksum', checksum: job.salt === undefined ? checksumOf(job.file) : checksumOf(job.file, job.salt) };
    case 'canonicalise':
      return { kind: 'canonicalise', text: canonicalise(job.value) };
    default:
      return { message: 'Unknown persist job.' };
  }
}

export function createPersistWorker(post: PersistPost): { handle(message: unknown): void } {
  return {
    handle(message) {
      if (!isPersistInbound(message)) return;
      try {
        const payload = runPersistJob(message.payload);
        if ('message' in payload) post({ id: message.id, kind: 'failed', payload });
        else post({ id: message.id, kind: 'done', payload });
      } catch (error) {
        post({ id: message.id, kind: 'failed', payload: { message: error instanceof Error ? error.message : messageOf(error) } });
      }
    },
  };
}

if (isWorkerScope()) {
  const scope = workerScope();
  const worker = createPersistWorker((message) => scope.postMessage(message));
  scope.onmessage = (event) => worker.handle(event.data);
}

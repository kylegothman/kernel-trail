/**
 * KERNEL TRAIL - the worker protocol. Architecture 9.4; WP-18 specification
 * section 7, scope corrections U8 and U9.
 *
 * All three workers use the same envelope with correlation ids, one module
 * per worker, and typed message unions on both sides. The replay unions
 * live in `@game/replay/types` (scope correction U1) and are re-exported
 * here; the persist and bake unions are declared here.
 *
 * `WorkerLike` is the surface the handles need, so a test can inject an
 * in-process fake: Node's test environment has no `Worker` global and
 * happy-dom does not execute worker scripts. The default factories build a
 * real module `Worker` behind a four-line adapter, no cast.
 */

import type { SaveFile } from '@game/types';
import type { CodexEntry } from '@game/codexTypes';
import type { AudioBufferSet } from '@audio/buffers';
import type { CodexSearchIndex } from '@ui/codex/search';
import type { Envelope } from '@game/replay/types';

export type {
  Envelope,
  ReplayCancelMessage,
  ReplayDone,
  ReplayInbound,
  ReplayOutbound,
  ReplayProgress,
  ReplayRequestMessage,
} from '@game/replay/types';

/* ------------------------------------------------------------------ */
/* The two other workers' unions (architecture 9.1, U9)                */
/* ------------------------------------------------------------------ */

export type PersistJob =
  | { readonly kind: 'checksum'; readonly file: Omit<SaveFile, 'checksum'>; readonly salt?: string }
  | { readonly kind: 'canonicalise'; readonly value: unknown };
export type PersistResult =
  | { readonly kind: 'checksum'; readonly checksum: string }
  | { readonly kind: 'canonicalise'; readonly text: string };
export type PersistInbound = Envelope<'persist', PersistJob>;
export type PersistOutbound = Envelope<'done', PersistResult> | Envelope<'failed', { readonly message: string }>;

export type BakeJob =
  | { readonly kind: 'audio_buffers'; readonly seed: number; readonly sampleRate?: number }
  | { readonly kind: 'codex_index'; readonly entries: readonly CodexEntry[] };
  // TODO(astra): render track supplies pure bakers (blue noise, grain, grade LUT, SDF atlas) and adds their jobs here
export type BakeResult =
  | { readonly kind: 'audio_buffers'; readonly set: AudioBufferSet }
  | { readonly kind: 'codex_index'; readonly index: CodexSearchIndex };
export type BakeInbound = Envelope<'bake', BakeJob>;
export type BakeOutbound = Envelope<'done', BakeResult> | Envelope<'failed', { readonly message: string }>;

/* ------------------------------------------------------------------ */
/* Narrowing                                                           */
/* ------------------------------------------------------------------ */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isEnvelope(value: unknown): value is Envelope<string, unknown> {
  return isRecord(value) && typeof value['id'] === 'number' && typeof value['kind'] === 'string' && 'payload' in value;
}

export function messageOf(payload: unknown): string {
  return isRecord(payload) && typeof payload['message'] === 'string' ? payload['message'] : 'Worker request failed.';
}

/* ------------------------------------------------------------------ */
/* U8: the injectable worker surface                                   */
/* ------------------------------------------------------------------ */

export interface WorkerLike {
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  terminate(): void;
}

export type WorkerFactory = () => WorkerLike;

/** A real module worker behind the injectable surface. */
export function adaptWorker(worker: Worker): WorkerLike {
  const like: WorkerLike = {
    postMessage: (message, transfer) => {
      if (transfer === undefined) worker.postMessage(message);
      else worker.postMessage(message, [...transfer]);
    },
    onmessage: null,
    onerror: null,
    terminate: () => worker.terminate(),
  };
  worker.onmessage = (event: MessageEvent<unknown>) => like.onmessage?.({ data: event.data });
  worker.onerror = (event) => like.onerror?.(event);
  return like;
}

/** The worker side of the surface: what a worker entry installs onto its global scope. */
export interface WorkerScope {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
}

/** True inside a dedicated worker, which is the only scope with `importScripts`; false on the main thread and in Node. */
export function isWorkerScope(): boolean {
  return typeof self !== 'undefined' && 'importScripts' in self;
}

/** The global scope as a worker sees it; the DOM lib types `self` as a Window, so the entry files go through this. */
export function workerScope(): WorkerScope {
  return self as unknown as WorkerScope;
}

/* ------------------------------------------------------------------ */
/* The main-thread channel the three handles share                     */
/* ------------------------------------------------------------------ */

interface Pending {
  readonly settle: (payload: unknown) => void;
  readonly fail: (message: string) => void;
  readonly progress: ((payload: unknown) => void) | undefined;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface SendOptions {
  /** After this many milliseconds the request settles with `onTimeout`'s value; the worker keeps running until told otherwise. */
  readonly timeoutMs?: number;
  readonly onTimeout?: (id: number) => unknown;
  readonly progress?: (payload: unknown) => void;
  readonly transfer?: readonly Transferable[];
}

/**
 * One worker instance, reused (spawning costs 10 to 40 ms): created lazily
 * on the first request and kept for the session. `onerror` fails every
 * pending request and terminates the worker, and the next request respawns
 * it. Requests correlate by envelope id; `progress` messages carry a
 * `targetId` instead and are routed to that request.
 */
export class WorkerChannel {
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private spawned = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly factory: WorkerFactory) {}

  get spawnCount(): number {
    return this.spawned;
  }

  get inFlight(): number {
    return this.pending.size;
  }

  get pendingIds(): readonly number[] {
    return [...this.pending.keys()];
  }

  private ensure(): WorkerLike {
    if (this.worker !== null) return this.worker;
    const worker = this.factory();
    this.spawned += 1;
    worker.onmessage = (event) => this.receive(event.data);
    worker.onerror = () => this.failAll('Worker crashed.');
    this.worker = worker;
    return worker;
  }

  private receive(data: unknown): void {
    if (!isEnvelope(data)) return;
    if (data.kind === 'progress') {
      const target = isRecord(data.payload) ? data.payload['targetId'] : undefined;
      if (typeof target === 'number') this.pending.get(target)?.progress?.(data.payload);
      return;
    }
    if (data.kind !== 'done' && data.kind !== 'failed') return;
    const entry = this.pending.get(data.id);
    if (entry === undefined) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    this.pending.delete(data.id);
    if (data.kind === 'failed') entry.fail(messageOf(data.payload));
    else entry.settle(data.payload);
  }

  /** Fire and forget, for a cancel. */
  post(kind: string, payload: unknown): number {
    const id = this.nextId++;
    this.ensure().postMessage({ id, kind, payload });
    return id;
  }

  /** A request that settles with the worker's `done` payload, rejects on a crash or a `failed`, and may time out. */
  send(kind: string, payload: unknown, options: SendOptions = {}): Promise<unknown> {
    const id = this.nextId++;
    const worker = this.ensure();
    return new Promise<unknown>((resolve, reject) => {
      const entry: Pending = { settle: resolve, fail: (message) => reject(new Error(message)), progress: options.progress, timer: null };
      if (options.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          resolve(options.onTimeout === undefined ? undefined : options.onTimeout(id));
        }, options.timeoutMs);
      }
      this.pending.set(id, entry);
      worker.postMessage({ id, kind, payload }, options.transfer);
    });
  }

  /** Settle every pending request with `settleWith(id)`, after `before(id)` has had its say (a cancel post, typically). */
  abortAll(settleWith: (id: number) => unknown, before?: (id: number) => void): void {
    for (const [id, entry] of [...this.pending]) {
      before?.(id);
      if (entry.timer !== null) clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.settle(settleWith(id));
    }
  }

  failAll(message: string): void {
    for (const [, entry] of this.pending) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.fail(message);
    }
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  terminate(): void {
    this.failAll('Worker terminated.');
  }
}

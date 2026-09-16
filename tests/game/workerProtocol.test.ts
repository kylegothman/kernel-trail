/**
 * The worker protocol and the three handles, WP-18 acceptance 20 to 23, 26,
 * 27, 29 and 30. Node has no Worker global, so the handles take an
 * in-process fake that runs the real worker functions on postMessage,
 * structured-cloning every reply with its transfer list the way a browser
 * would (scope correction U8). The browser run in
 * tests/render/gpu/replay.gpu.ts spawns the built workers for real.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createKernel } from '../../src/kernel/Kernel';
import { generateBuffers, isAudioBufferSet, sameBuffers, transferList } from '../../src/audio/buffers';
import type { CodexEntry } from '../../src/game/codexTypes';
import { canonicalise, checksumOf } from '../../src/game/save';
import { createHeadlessSetupContext } from '../../src/game/replay/headlessLegs';
import { initialRunState } from '../../src/game/replay/runReplay';
import { createRunStreams, type ReplayRequest, type ReplayResponse } from '../../src/game/replay/types';
import { isEnvelope, type WorkerFactory, type WorkerLike } from '../../src/game/workers/protocol';
import { createReplayWorker, type Schedule } from '../../src/game/workers/replay.worker';
import { createPersistWorker } from '../../src/game/workers/persist.worker';
import { createBakeWorker } from '../../src/game/workers/bake.worker';
import { REPLAY_TIMEOUT_MS, ReplayWorkerHandle } from '../../src/game/workers/ReplayWorkerHandle';
import { PersistWorkerHandle } from '../../src/game/workers/PersistWorkerHandle';
import { BakeWorkerHandle } from '../../src/game/workers/BakeWorkerHandle';
import { stripComments } from '../kernel/sourceScan';
import { createSyntheticLeg, registerSynthetic, type SyntheticLegOptions } from './fixtures/syntheticLeg';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC = join(REPO_ROOT, 'src');
const WORKERS = join(SRC, 'game', 'workers');

/* ------------------------------------------------------------------ */
/* The in-process fake                                                 */
/* ------------------------------------------------------------------ */

type Behaviour = 'replay' | 'persist' | 'bake' | 'hang' | 'crash';

class FakeWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  terminated = false;
  /** Every message the main thread posted. */
  readonly received: unknown[] = [];
  /** Every message the worker side posted, before the clone. */
  readonly posted: unknown[] = [];
  readonly transfers: number[] = [];
  private readonly inner: { handle(message: unknown): void } | null;

  constructor(private readonly behaviour: Behaviour, schedule?: Schedule) {
    const post = (reply: unknown, transfer?: readonly Transferable[]): void => {
      this.posted.push(reply);
      this.transfers.push(transfer?.length ?? 0);
      const cloned = structuredClone(reply, transfer === undefined ? undefined : { transfer: [...transfer] });
      queueMicrotask(() => this.onmessage?.({ data: cloned }));
    };
    switch (behaviour) {
      case 'replay':
        this.inner = schedule === undefined ? createReplayWorker(post) : createReplayWorker(post, schedule);
        break;
      case 'persist':
        this.inner = createPersistWorker(post);
        break;
      case 'bake':
        this.inner = createBakeWorker(post);
        break;
      default:
        this.inner = null;
    }
  }

  postMessage(message: unknown, transfer?: readonly Transferable[]): void {
    this.received.push(message);
    if (this.behaviour === 'crash') {
      queueMicrotask(() => this.onerror?.(new Error('boom')));
      return;
    }
    if (this.behaviour === 'hang') return;
    this.inner?.handle(structuredClone(message, transfer === undefined ? undefined : { transfer: [...transfer] }));
  }

  terminate(): void {
    this.terminated = true;
  }
}

function fakeFactory(behaviours: readonly Behaviour[], schedule?: Schedule): { factory: WorkerFactory; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const factory: WorkerFactory = () => {
    const behaviour = behaviours[Math.min(workers.length, behaviours.length - 1)] ?? 'hang';
    const worker = new FakeWorker(behaviour, schedule);
    workers.push(worker);
    return worker;
  };
  return { factory, workers };
}

const undos: (() => void)[] = [];
function withSynthetic(options: SyntheticLegOptions = {}): void {
  undos.push(registerSynthetic(options));
}
afterEach(() => {
  while (undos.length > 0) undos.pop()?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function request(patch: Partial<ReplayRequest> = {}): ReplayRequest {
  return { seed: 41, discClass: 'shell', difficulty: 'operator', legs: ['boot_sector'], decisions: [], overrides: { suppressRecordedPolicyChanges: false }, maxTicks: 20_000, ...patch };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

/* ------------------------------------------------------------------ */
/* The import closure (U10)                                            */
/* ------------------------------------------------------------------ */

const ALIASES: Readonly<Record<string, string>> = {
  '@kernel': 'kernel', '@game': 'game', '@ui': 'ui', '@audio': 'audio', '@world': 'world', '@render': 'render',
  '@design': 'design', '@platform': 'platform', '@app': 'app', '@terminal': 'terminal', '@legs': 'legs',
};

interface Edge {
  readonly from: string;
  readonly specifier: string;
  readonly file: string | null;
}

function resolveSpecifier(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('.')) base = resolve(dirname(from), specifier);
  else {
    const [alias, ...rest] = specifier.split('/');
    const layer = alias === undefined ? undefined : ALIASES[alias];
    if (layer === undefined) return null;
    base = join(SRC, layer, ...rest);
  }
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  throw new Error(`unresolved import ${specifier} from ${relative(REPO_ROOT, from)}`);
}

/** Runtime imports only: `import type` and `export type` are erased by verbatimModuleSyntax and pull nothing into a bundle. */
function runtimeImports(file: string): string[] {
  const code = stripComments(readFileSync(file, 'utf8'), false);
  const specifiers: string[] = [];
  for (const statement of code.split(';')) {
    if (/^\s*(?:import|export)\s+type\s/.test(statement)) continue;
    const from = /\bfrom\s*['"]([^'"]+)['"]/.exec(statement);
    if (from?.[1] !== undefined) specifiers.push(from[1]);
    const bare = /^\s*import\s*['"]([^'"]+)['"]/.exec(statement);
    if (bare?.[1] !== undefined) specifiers.push(bare[1]);
    for (const dynamic of statement.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) if (dynamic[1] !== undefined) specifiers.push(dynamic[1]);
  }
  return specifiers;
}

function closureOf(entry: string): { files: string[]; edges: Edge[] } {
  const files = new Set<string>([entry]);
  const edges: Edge[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const from = queue.shift();
    if (from === undefined) break;
    for (const specifier of runtimeImports(from)) {
      const file = resolveSpecifier(from, specifier);
      edges.push({ from, specifier, file });
      if (file !== null && !files.has(file)) {
        files.add(file);
        queue.push(file);
      }
    }
  }
  return { files: [...files].sort(), edges };
}

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectSources(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out.sort();
}

/* ------------------------------------------------------------------ */
/* Cases                                                               */
/* ------------------------------------------------------------------ */

describe('the worker protocol', () => {
  it('envelope: every message carries id, kind and payload, progress correlates by targetId and done by id, and replays queue one at a time', () => {
    withSynthetic({ hooks: { isComplete: (at) => at >= 1200 } });
    const posted: unknown[] = [];
    const worker = createReplayWorker((m) => posted.push(m), (next) => next());
    worker.handle({ id: 7, kind: 'replay', payload: request() });
    worker.handle({ id: 8, kind: 'replay', payload: request({ seed: 42 }) });
    expect(worker.queued).toBe(0);
    for (const m of posted) {
      expect(isEnvelope(m)).toBe(true);
      const e = m as { id: number; kind: string; payload: unknown };
      expect(typeof e.id).toBe('number');
      expect(['progress', 'done']).toContain(e.kind);
    }
    const kinds = posted.map((m) => (m as { kind: string }).kind);
    expect(kinds).toEqual(['progress', 'progress', 'done', 'progress', 'progress', 'done']);
    const progress = posted.filter((m) => (m as { kind: string }).kind === 'progress') as { id: number; payload: { targetId: number; ticks: number } }[];
    expect(progress.map((p) => p.payload)).toEqual([{ targetId: 7, ticks: 500 }, { targetId: 7, ticks: 1000 }, { targetId: 8, ticks: 500 }, { targetId: 8, ticks: 1000 }]);
    expect(new Set(progress.map((p) => p.id)).size).toBe(4);
    const done = posted.filter((m) => (m as { kind: string }).kind === 'done') as { id: number; payload: ReplayResponse }[];
    expect(done.map((d) => d.id)).toEqual([7, 8]);
    for (const d of done) expect(d.payload.ok).toBe(true);
    // A malformed message is ignored rather than answered.
    worker.handle({ kind: 'replay' });
    worker.handle('nonsense');
    expect(posted).toHaveLength(6);
  });

  it('worker boundaries: no worker closure imports three, @world, @render, @ui (bar the codex index for bake), @app, @platform or @terminal, and @audio only as @audio/buffers', () => {
    const entries = readdirSync(WORKERS).filter((f) => f.endsWith('.worker.ts')).sort();
    expect(entries).toEqual(['bake.worker.ts', 'persist.worker.ts', 'replay.worker.ts']);
    for (const name of entries) {
      const entry = join(WORKERS, name);
      const { files, edges } = closureOf(entry);
      const short = files.map((f) => relative(SRC, f));
      // The replay and bake closures reach the kernel; persist is protocol plus save.ts, whose imports are all types.
      if (name === 'persist.worker.ts') expect(short).toEqual(['game/save.ts', 'game/workers/persist.worker.ts', 'game/workers/protocol.ts']);
      else {
        expect(files.length, name).toBeGreaterThan(20);
        expect(short, name).toContain('kernel/Kernel.ts');
      }
      for (const { from, specifier } of edges) {
        const where = `${relative(REPO_ROOT, from)} imports ${specifier}`;
        expect(specifier, where).not.toMatch(/^three(\/|$)/);
        expect(specifier, where).not.toMatch(/^@(world|render|app|platform|terminal)(\/|$)/);
        if (specifier.startsWith('@ui')) expect(name === 'bake.worker.ts' && specifier === '@ui/codex/search', where).toBe(true);
        if (specifier.startsWith('@audio')) expect(specifier, where).toBe('@audio/buffers');
        expect(specifier, where).not.toMatch(/^(?:\.\.\/)+(?:world|render|ui|app|platform|terminal)\//);
      }
      for (const file of files) {
        const code = stripComments(readFileSync(file, 'utf8'), true);
        const where = `${name}: ${relative(REPO_ROOT, file)}`;
        expect(code, where).not.toMatch(/\b(document|window|localStorage|sessionStorage)\b/);
        expect(code, where).not.toMatch(/\bnew\s+Database\s*\(/);
        if (!file.endsWith(join('src', 'game', 'save.ts'))) expect(code, where).not.toMatch(/\bindexedDB\b/);
      }
    }
  });

  it('single instance: one worker per session, reused across 50 requests', async () => {
    withSynthetic({ processes: 1, service: [10, 20], hooks: { isComplete: (at) => at >= 60 } });
    const { factory, workers } = fakeFactory(['replay']);
    const handle = new ReplayWorkerHandle({ factory });
    expect(handle.spawnCount).toBe(0);
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => handle.run(request({ seed: i }))));
    expect(handle.spawnCount).toBe(1);
    expect(workers).toHaveLength(1);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(workers[0]?.received).toHaveLength(50);
    expect(handle.inFlight).toBe(0);
    handle.dispose();
  });

  it('crash respawn: a throwing worker fails every pending request, is terminated, and the next request respawns it', async () => {
    withSynthetic({ processes: 1, service: [10, 20], hooks: { isComplete: (at) => at >= 60 } });
    const { factory, workers } = fakeFactory(['crash', 'replay']);
    const handle = new ReplayWorkerHandle({ factory });
    const [a, b] = await Promise.all([handle.run(request()), handle.run(request({ seed: 2 }))]);
    expect(a).toEqual({ ok: false, reason: 'error', message: 'Worker crashed.' });
    expect(b).toEqual({ ok: false, reason: 'error', message: 'Worker crashed.' });
    expect(workers[0]?.terminated).toBe(true);
    expect(handle.spawnCount).toBe(1);
    const c = await handle.run(request({ seed: 3 }));
    expect(c.ok).toBe(true);
    expect(handle.spawnCount).toBe(2);
    expect(workers).toHaveLength(2);
    expect(workers[1]?.terminated).toBe(false);
    handle.dispose();
  });

  it('timeout: 1500 ms posts a cancel and resolves { ok: false, reason: timeout }', async () => {
    vi.useFakeTimers();
    const { factory, workers } = fakeFactory(['hang']);
    const handle = new ReplayWorkerHandle({ factory });
    expect(REPLAY_TIMEOUT_MS).toBe(1500);
    const pending = handle.run(request());
    await vi.advanceTimersByTimeAsync(1499);
    expect(handle.inFlight).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result).toEqual({ ok: false, reason: 'timeout', message: 'Replay exceeded 1500 ms.' });
    const received = workers[0]?.received ?? [];
    expect(received).toHaveLength(2);
    const replay = received[0] as { id: number; kind: string };
    const cancel = received[1] as { id: number; kind: string; payload: { targetId: number } };
    expect(replay.kind).toBe('replay');
    expect(cancel.kind).toBe('cancel');
    expect(cancel.payload.targetId).toBe(replay.id);
    expect(cancel.id).not.toBe(replay.id);
    expect(handle.inFlight).toBe(0);
    handle.dispose();
  });

  it('cancel: cancelAll settles the request and the worker stops within 500 ticks of the message', async () => {
    withSynthetic({ hooks: { isComplete: () => false } });
    const { factory, workers } = fakeFactory(['replay']);
    const handle = new ReplayWorkerHandle({ factory });
    const seen: number[] = [];
    const result = await handle.run(request({ maxTicks: 100_000 }), 60_000, (ticks) => {
      seen.push(ticks);
      if (ticks === 500) handle.cancelAll();
    });
    expect(result).toEqual({ ok: false, reason: 'aborted', message: 'Replay cancelled.' });
    await settle();
    const worker = workers[0];
    if (worker === undefined) throw new Error('no worker');
    const done = worker.posted.find((m) => (m as { kind: string }).kind === 'done') as { payload: ReplayResponse } | undefined;
    expect(done?.payload).toEqual({ ok: false, reason: 'aborted', message: 'Replay cancelled at tick 1000.' });
    const progress = worker.posted.filter((m) => (m as { kind: string }).kind === 'progress');
    expect(progress.length).toBeLessThanOrEqual(2);
    expect(seen[0]).toBe(500);
    // A cancel that arrives before the replay starts aborts it without running a tick.
    const second = createReplayWorker((m) => worker.posted.push(m), (next) => next());
    second.handle({ id: 3, kind: 'cancel', payload: { targetId: 4 } });
    second.handle({ id: 4, kind: 'replay', payload: request() });
    expect(worker.posted.at(-1)).toEqual({ id: 4, kind: 'done', payload: { ok: false, reason: 'aborted', message: 'Replay cancelled before it began.' } });
    handle.dispose();
  });

  it('new URL form: each default factory constructs its worker with new URL(..., import.meta.url) and type module', () => {
    for (const [handle, entry] of [['ReplayWorkerHandle.ts', 'replay.worker.ts'], ['PersistWorkerHandle.ts', 'persist.worker.ts'], ['BakeWorkerHandle.ts', 'bake.worker.ts']]) {
      const source = readFileSync(join(WORKERS, handle ?? ''), 'utf8');
      expect(source, handle).toContain(`new Worker(new URL('./${entry}', import.meta.url), { type: 'module' })`);
    }
  });

  it('bake transfer: the audio set crosses as ArrayBuffer with zero copy, the source buffer detached after transfer', async () => {
    const seed = 0x4b54524c;
    // The worker function directly: the transfer list is built and the post detaches the source.
    let source: ReturnType<typeof generateBuffers> | null = null;
    let arrived: unknown = null;
    const direct = createBakeWorker((message, transfer) => {
      const payload = (message as { payload: { set?: ReturnType<typeof generateBuffers> } }).payload;
      source = payload.set ?? null;
      expect(transfer).toHaveLength(transferList(payload.set as ReturnType<typeof generateBuffers>).length);
      arrived = structuredClone(message, { transfer: [...(transfer ?? [])] });
    });
    direct.handle({ id: 1, kind: 'bake', payload: { kind: 'audio_buffers', seed, sampleRate: 8000 } });
    const before = source as ReturnType<typeof generateBuffers> | null;
    if (before === null) throw new Error('the bake posted nothing');
    expect(before.white.byteLength).toBe(0);
    expect(before.white.buffer.byteLength).toBe(0);
    const reply = arrived as { payload: { set: unknown } };
    expect(isAudioBufferSet(reply.payload.set)).toBe(true);
    if (isAudioBufferSet(reply.payload.set)) expect(sameBuffers(reply.payload.set, generateBuffers(seed, 8000))).toBe(true);
    // Through the handle and the fake worker.
    const { factory, workers } = fakeFactory(['bake']);
    const handle = new BakeWorkerHandle(factory);
    const baked = await handle.bake({ kind: 'audio_buffers', seed, sampleRate: 8000 });
    expect(baked.kind).toBe('audio_buffers');
    expect(sameBuffers(baked.set, generateBuffers(seed, 8000))).toBe(true);
    expect(workers[0]?.transfers).toEqual([6]);
    const entries: CodexEntry[] = [{ id: 'codex.starvation', title: 'Starvation', chapter: { chapter: 5, sections: ['5.3.4'], title: 'Priority Scheduling' }, concept: 'A low priority waits while higher ones keep arriving.', unlock: { kind: 'affliction', id: 'starvation' }, workedExample: null, counterfactual: null, remedy: null, remedyVisibility: 'never', related: [], commands: ['nice'], epitaphs: [] }];
    const index = await handle.bake({ kind: 'codex_index', entries });
    expect(index.kind).toBe('codex_index');
    expect(index.index.ids).toEqual(['codex.starvation']);
    expect(index.index.postings.get('starvation')).toEqual(['codex.starvation']);
    expect(handle.spawnCount).toBe(1);
    handle.dispose();
  });

  it('persist checksum: the worker produces the same checksum and canonical text as the main-thread path', async () => {
    const leg = createSyntheticLeg();
    const run = initialRunState(19, 'shell', 'operator');
    const kernel = createKernel({ ...leg.kernelConfig(run), seed: 19 });
    leg.populate(createHeadlessSetupContext(kernel, run, createRunStreams(19).leg.fork('boot_sector'), new Map()));
    kernel.run(150);
    const snapshot = kernel.snapshot();
    expect(snapshot.completeness).toBe('full');
    const body = { version: 1 as const, savedAtIso: '2026-09-16T00:00:00.000Z', run, kernel: snapshot, rngStates: snapshot.rng };
    const { factory, workers } = fakeFactory(['persist']);
    const handle = new PersistWorkerHandle(factory);
    expect(await handle.checksum(body)).toBe(checksumOf(body));
    expect(await handle.checksum(body, 'build-9')).toBe(checksumOf(body, 'build-9'));
    expect(await handle.checksum(body, 'build-9')).not.toBe(checksumOf(body));
    expect(await handle.canonicalise({ b: [1, { d: 2, c: 3 }], a: 'x' })).toBe(canonicalise({ b: [1, { d: 2, c: 3 }], a: 'x' }));
    // A value the canonicaliser refuses rejects rather than hangs.
    await expect(handle.canonicalise({ m: new Map([[1, 2]]) })).rejects.toThrow(/Map\/Set/);
    expect(handle.spawnCount).toBe(1);
    expect(workers[0]?.received).toHaveLength(5);
    // The worker function directly, for the acceptance 27 record.
    const posted: unknown[] = [];
    createPersistWorker((m) => posted.push(m)).handle({ id: 2, kind: 'persist', payload: { kind: 'checksum', file: body } });
    expect(posted).toEqual([{ id: 2, kind: 'done', payload: { kind: 'checksum', checksum: checksumOf(body) } }]);
    handle.dispose();
  });

  it('no offscreencanvas: nothing under src names OffscreenCanvas', () => {
    const files = collectSources(SRC);
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) expect(stripComments(readFileSync(file, 'utf8'), true), relative(REPO_ROOT, file)).not.toMatch(/OffscreenCanvas/);
  });

  it('sim on main thread: src/app/loop.ts still steps the kernel directly and no worker touches @app', () => {
    const loop = stripComments(readFileSync(join(SRC, 'app', 'loop.ts'), 'utf8'), false);
    expect(loop).toMatch(/this\.host\.applyPendingCommands\(this\.tick\);\s*this\.host\.fixedUpdate\(this\.tick\);/);
    expect(loop).not.toMatch(/\bWorker\b|postMessage|SharedArrayBuffer/);
    for (const file of collectSources(WORKERS)) expect(stripComments(readFileSync(file, 'utf8'), false), relative(REPO_ROOT, file)).not.toMatch(/from\s*['"]@app/);
  });
});

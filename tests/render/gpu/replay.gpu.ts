/**
 * WP-18 browser probe, run by tests/render/gpu/run.mjs under Playwright
 * (scope correction U8): the three production workers spawned from their
 * built chunks; one synthetic-leg replay through a test worker entry that
 * registers the leg, compared with the main-thread hash; one checksum
 * through the persist worker compared with the main-thread value
 * (acceptance 27); one bake through the production bake worker validated
 * on arrival, and the detachment of the source buffer after transfer
 * observed inside the worker (acceptance 26).
 */
import { createKernel } from '../../../src/kernel/Kernel';
import { generateBuffers, isAudioBufferSet, sameBuffers } from '../../../src/audio/buffers';
import { checksumOf } from '../../../src/game/save';
import { createHeadlessSetupContext } from '../../../src/game/replay/headlessLegs';
import { initialRunState, runReplay } from '../../../src/game/replay/runReplay';
import { createRunStreams, type ReplayRequest } from '../../../src/game/replay/types';
import { adaptWorker, isEnvelope, isRecord, type WorkerLike } from '../../../src/game/workers/protocol';
import { ReplayWorkerHandle } from '../../../src/game/workers/ReplayWorkerHandle';
import { PersistWorkerHandle } from '../../../src/game/workers/PersistWorkerHandle';
import { BakeWorkerHandle } from '../../../src/game/workers/BakeWorkerHandle';
import { createSyntheticLeg, registerSynthetic } from '../../game/fixtures/syntheticLeg';

const SEED = 77;
const REQUEST: ReplayRequest = { seed: SEED, discClass: 'shell', difficulty: 'operator', legs: ['boot_sector'], decisions: [], overrides: { suppressRecordedPolicyChanges: false }, maxTicks: 20_000 };

interface ProbeReport {
  readonly detachedAfterTransfer: boolean;
  readonly transferred: number;
}

/** The probe worker behind the injectable surface, with the bake probe message intercepted before the channel sees it. */
function probeWorkerFactory(onProbe: (report: ProbeReport) => void): () => WorkerLike {
  return () => {
    const like = adaptWorker(new Worker(new URL('./replayWorker.gpu.ts', import.meta.url), { type: 'module' }));
    const wrapped: WorkerLike = { postMessage: (m, t) => like.postMessage(m, t), onmessage: null, onerror: null, terminate: () => like.terminate() };
    like.onmessage = (event) => {
      const data = event.data;
      if (isEnvelope(data) && data.kind === 'probe' && isRecord(data.payload)) {
        onProbe({ detachedAfterTransfer: data.payload['detachedAfterTransfer'] === true, transferred: Number(data.payload['transferred'] ?? 0) });
        return;
      }
      wrapped.onmessage?.(event);
    };
    like.onerror = (error) => wrapped.onerror?.(error);
    return wrapped;
  };
}

function initialize(): void {
  const status = document.querySelector<HTMLPreElement>('#status');
  if (status === null) throw new Error('replay probe markup missing');
  registerSynthetic();
  const api = {
    info: () => ({ seed: SEED, legs: REQUEST.legs }),
    async run() {
      // 1. The production replay worker from its built chunk: a stub leg answers with the phase 2 message, which proves the chunk boots and speaks the protocol.
      const production = new ReplayWorkerHandle();
      const productionReplay = await production.run(REQUEST, 10_000);
      production.dispose();

      // 2. The synthetic leg inside a real worker, compared with the main thread.
      let probe: ProbeReport | null = null;
      let arrived: (report: ProbeReport) => void = () => undefined;
      const probeArrival = new Promise<ProbeReport>((resolve) => { arrived = resolve; });
      const factory = probeWorkerFactory((report) => { probe = report; arrived(report); });
      const replayHandle = new ReplayWorkerHandle({ factory });
      const t0 = performance.now();
      const workerResult = await replayHandle.run(REQUEST, 10_000);
      const workerMs = performance.now() - t0;
      const mainResult = runReplay(REQUEST);
      replayHandle.dispose();

      // 3. The persist worker from its built chunk, against a live snapshot with its Maps.
      const leg = createSyntheticLeg();
      const run = initialRunState(SEED, 'shell', 'operator');
      const kernel = createKernel({ ...leg.kernelConfig(run), seed: SEED });
      leg.populate(createHeadlessSetupContext(kernel, run, createRunStreams(SEED).leg.fork('boot_sector'), new Map()));
      kernel.run(200);
      const snapshot = kernel.snapshot();
      const body = { version: 1 as const, savedAtIso: '2026-09-16T09:00:00.000Z', run, kernel: snapshot, rngStates: snapshot.rng };
      const persist = new PersistWorkerHandle();
      const workerChecksum = await persist.checksum(body);
      const mainChecksum = checksumOf(body);
      persist.dispose();

      // 4. The bake: the production worker's reply validated on arrival, and the probe worker's report of the source after transfer.
      const bake = new BakeWorkerHandle();
      const baked = await bake.bake({ kind: 'audio_buffers', seed: 5, sampleRate: 8000 });
      bake.dispose();
      const probeBake = new BakeWorkerHandle(factory);
      const probeBaked = await probeBake.bake({ kind: 'audio_buffers', seed: 5, sampleRate: 8000 });
      const report = probe ?? (await Promise.race([probeArrival, new Promise<ProbeReport>((resolve) => setTimeout(() => resolve({ detachedAfterTransfer: false, transferred: -1 }), 5000))]));
      probeBake.dispose();

      const result = {
        productionReplay: productionReplay.ok ? { ok: true } : { ok: false, reason: productionReplay.reason, message: productionReplay.message },
        replay: {
          ok: workerResult.ok,
          hashMatchesMainThread: workerResult.ok && mainResult.ok && workerResult.eventLogHash === mainResult.eventLogHash,
          ticks: workerResult.ok ? workerResult.ticks : 0,
          workerMs,
          usPerTick: workerResult.ok && workerResult.ticks > 0 ? (workerMs * 1000) / workerResult.ticks : null,
          message: workerResult.ok ? '' : workerResult.message,
        },
        persist: { matchesMainThread: workerChecksum === mainChecksum, checksum: workerChecksum },
        bake: {
          validSet: isAudioBufferSet(baked.set) && sameBuffers(baked.set, generateBuffers(5, 8000)),
          probeSetValid: isAudioBufferSet(probeBaked.set) && sameBuffers(probeBaked.set, generateBuffers(5, 8000)),
          detachedAfterTransfer: report.detachedAfterTransfer,
          transferred: report.transferred,
        },
      };
      status.textContent = JSON.stringify(result, null, 2);
      return result;
    },
    dispose: () => undefined,
  };
  Object.assign(globalThis, { __kernelTrailProbe: { status: 'ready', api } });
  status.textContent = 'Ready';
}

Object.assign(globalThis, { __kernelTrailProbe: { status: 'booting' } });
try {
  initialize();
} catch (cause: unknown) {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  Object.assign(globalThis, { __kernelTrailProbe: { status: 'failed', error: { message: error.message, stack: error.stack ?? error.message } } });
  console.error('Replay probe initialization failed:', error.stack ?? error.message);
}

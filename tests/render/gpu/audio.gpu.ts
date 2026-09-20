/**
 * WP-16 browser probe. Run by tests/render/gpu/run.mjs under Playwright:
 * the autoplay rule (no context before the click, running after it), a
 * two-second real-time run with no page error, `generateBuffers` timing on
 * the main thread and in a module Worker, and the always-running pool's
 * synthesis cost at every tier measured by offline rendering.
 *
 * The same module is the Worker entry: in a worker there is no `document`,
 * so the branch at the bottom answers the timing request and exits.
 */
import { AudioEngine } from '../../../src/audio/AudioEngine';
import { generateBuffers, isAudioBufferSet, sameBuffers, transferList, type AudioBufferSet } from '../../../src/audio/buffers';
import type { AudioContextLike } from '../../../src/audio/context';
import { VOICE_BUDGET } from '../../../src/audio/VoiceBudget';
import type { QualityTier } from '../../../src/platform/quality';
import { GLOBAL_EVENTS, randomEvents } from '../../audio/helpers';

const SEED = 0x4b54524c;
const SAMPLE_RATE = 48000;
const QUANTUM = 128;

interface WorkerReply {
  readonly ms: number;
  readonly set: AudioBufferSet;
}

/** An OfflineAudioContext behind the adapter surface, with a virtual clock the probe advances. */
function offlineAdapter(offline: OfflineAudioContext, clock: { now: number }): AudioContextLike {
  return {
    get currentTime() { return clock.now; },
    sampleRate: offline.sampleRate,
    get state() { return 'running' as const; },
    destination: offline.destination,
    onstatechange: null,
    createGain: () => offline.createGain(),
    createOscillator: () => offline.createOscillator(),
    createBufferSource: () => offline.createBufferSource(),
    createBiquadFilter: () => offline.createBiquadFilter(),
    createWaveShaper: () => offline.createWaveShaper(),
    createConvolver: () => offline.createConvolver(),
    createDelay: (max?: number) => offline.createDelay(max),
    createDynamicsCompressor: () => offline.createDynamicsCompressor(),
    createStereoPanner: () => offline.createStereoPanner(),
    createBuffer: (channels: number, length: number, rate: number) => offline.createBuffer(channels, length, rate),
    resume: () => Promise.resolve(),
    suspend: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

function initializeProbe(): void {
  const status = document.querySelector<HTMLPreElement>('#status');
  const button = document.querySelector<HTMLButtonElement>('#unlock');
  if (status === null || button === null) throw new Error('probe markup missing');
  const t0 = performance.now();
  const buffers = generateBuffers(SEED, SAMPLE_RATE);
  const mainThreadMs = performance.now() - t0;
  const engine = new AudioEngine({ tier: 'high', seed: SEED, buffers, reducedMotionProbe: () => false });
  let workerReply: Promise<WorkerReply> | null = null;

  const startWorker = (): Promise<WorkerReply> => new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { type: 'module' });
    const timer = setTimeout(() => reject(new Error('worker timing timed out')), 20000);
    worker.onmessage = (ev: MessageEvent<unknown>) => {
      clearTimeout(timer);
      const data = ev.data as { ms?: unknown; set?: unknown };
      if (typeof data.ms !== 'number' || !isAudioBufferSet(data.set)) { reject(new Error('bad worker reply')); return; }
      resolve({ ms: data.ms, set: data.set });
      worker.terminate();
    };
    worker.onerror = (e) => { clearTimeout(timer); reject(new Error(e.message)); };
    worker.postMessage({ seed: SEED, sampleRate: SAMPLE_RATE });
  });

  button.addEventListener('click', () => {
    engine.unlock();
    status.textContent = `unlock: ${engine.state}`;
  });

  const api = {
    info() {
      const ctx = engine.adapter.context;
      return { state: engine.state, failureReason: engine.adapter.failureReason, sampleRate: ctx?.sampleRate ?? null, bufferRate: buffers.sampleRate, constructions: engine.adapter.contextConstructions, droppedBeforeGesture: engine.bank.stats.dropped };
    },
    /** Drop one cue before the gesture, so the autoplay counter is exercised. */
    poke() {
      engine.ui.keyTick();
      return engine.bank.stats.dropped;
    },
    async run(seconds: number) {
      const events = randomEvents(Math.ceil(seconds * 60 * 8), 5, 0, GLOBAL_EVENTS);
      let i = 0;
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const frame = (): void => {
          engine.push(events.slice(i, i + 8));
          i += 8;
          engine.frame();
          if (performance.now() - start < seconds * 1000 && i < events.length) requestAnimationFrame(frame);
          else resolve();
        };
        requestAnimationFrame(frame);
      });
      return { ...engine.stats(), wallMs: performance.now() - start, framesRun: i / 8 };
    },
    async timing() {
      workerReply ??= startWorker();
      const reply = await workerReply;
      return { mainThreadMs, workerMs: reply.ms, identical: sameBuffers(reply.set, buffers) };
    },
    /**
     * Pre-flight D1: the cost of the always-running pool. Every voice starts
     * at warm-up and runs for the whole render; a two-second burst keeps the
     * cues busy. Wall time of the offline render over the number of quanta is
     * the audio thread's cost per 128-sample quantum.
     */
    async cost(tier: QualityTier) {
      const seconds = 2;
      const offline = new OfflineAudioContext({ numberOfChannels: 2, length: SAMPLE_RATE * seconds, sampleRate: SAMPLE_RATE });
      const clock = { now: 0 };
      const probeEngine = new AudioEngine({ tier, seed: SEED, buffers, contextFactory: () => offlineAdapter(offline, clock), reducedMotionProbe: () => false });
      probeEngine.unlock();
      const events = randomEvents(seconds * 60 * 8, 9, 0, GLOBAL_EVENTS);
      for (let f = 0; f < seconds * 60; f++) {
        probeEngine.push(events.slice(f * 8, f * 8 + 8));
        probeEngine.frame();
        clock.now += 1 / 60;
      }
      const stats = probeEngine.stats();
      const t1 = performance.now();
      const rendered = await offline.startRendering();
      const wallMs = performance.now() - t1;
      const quanta = rendered.length / QUANTUM;
      const data = rendered.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < data.length; i += 7) peak = Math.max(peak, Math.abs(data[i] ?? 0));
      probeEngine.dispose();
      return {
        tier, voices: VOICE_BUDGET[tier], renderedSeconds: rendered.length / SAMPLE_RATE, wallMs, quanta,
        msPerQuantum: wallMs / quanta, quantumMs: (QUANTUM / SAMPLE_RATE) * 1000, realtimeFraction: wallMs / (seconds * 1000),
        peakSample: peak, cuesPlayed: stats.cuesPlayed, cuesDropped: stats.cuesDropped, voicesPeak: stats.voicesPeak,
      };
    },
    dispose() {
      engine.dispose();
    },
  };
  Object.assign(globalThis, { __kernelTrailAudioProbe: { status: 'ready', api } });
  status.textContent = 'Ready: click to start audio';
}

if (typeof document === 'undefined') {
  // Worker branch: time generateBuffers off the main thread and hand the set back with zero copy.
  const scope = self as unknown as { onmessage: ((ev: MessageEvent<{ seed: number; sampleRate: number }>) => void) | null; postMessage(message: unknown, transfer: Transferable[]): void };
  scope.onmessage = (ev) => {
    const t0 = performance.now();
    const set = generateBuffers(ev.data.seed, ev.data.sampleRate);
    const ms = performance.now() - t0;
    scope.postMessage({ ms, set }, transferList(set) as ArrayBuffer[]);
  };
} else {
  try {
    initializeProbe();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    Object.assign(globalThis, { __kernelTrailAudioProbe: { status: 'failed', error: { message: err.message, stack: err.stack ?? '' } } });
  }
}

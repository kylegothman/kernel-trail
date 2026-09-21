/**
 * The audio engine facade. Owns the adapter, the master graph, the voice
 * pools, the side-chain, the score, the consumer and the settings, and is
 * the one object the app, the HUD (WP-17) and the leg runner (WP-19) talk
 * to.
 *
 * Lifecycle: construct at boot with the tier and the seed (buffers generated
 * on the main thread, or handed in from the worker path); `unlock()` from a
 * gesture handler builds the graph; `push` and `frame` drive it, or the
 * consumer is registered against the shared fanout once WP-14 lands. WP-25:
 * the session forwards leg events and the director's verbs through
 * `onLegEvent` and `onDirectorEvent`, and hands the engine an interval so
 * the score keeps time while the loop is held.
 */
import { createRng } from '@kernel/index';
import type { KernelEvent, Pid, Rng } from '@kernel/types';
import type { LegEvent } from '@game/LegRunner';
import type { QualityTier } from '@platform/quality';
import { GAIN_RAMP_MS } from '@design/motion';
import { AudioAdapter, type AudioContextFactory, type AudioContextLike, type AudioState, type NodeLike } from './context';
import { generateBuffers, type AudioBufferSet } from './buffers';
import { MasterGraph, uploadBuffers } from './graph';
import { POOL_SPLIT, VOICE_BUDGET, VoiceAllocator } from './VoiceBudget';
import { VOICE_KINDS, type BusId, type UploadedBuffers, type Voice, type VoiceHost, type VoiceKind } from './voices/Voice';
import { ToneVoice } from './voices/ToneVoice';
import { NoiseVoice } from './voices/NoiseVoice';
import { ImpactVoice } from './voices/ImpactVoice';
import { DroneVoice } from './voices/DroneVoice';
import { GranularVoice } from './voices/GranularVoice';
import { ChordVoice } from './voices/ChordVoice';
import { KickVoice } from './voices/KickVoice';
import { LeadVoice } from './voices/LeadVoice';
import { Sidechain, SIDECHAIN_DEPTH } from './synth/sidechain';
import { Score } from './score/Score';
import type { DirectorEvent } from './score/Conductor';
import { SCHEDULE_INTERVAL_MS } from './score/Sequencer';
import { SCORE_VOICING } from './score/material';
import { GENERATED_SCORE_SOURCE, type ScoreSource } from './score/source';
import type { Mode, SectionId } from './score/Arrangement';
import { DEFAULT_ROOT_MIDI } from './synth/tuning';
import { REDUCED_MOTION_ENVELOPE_SCALE } from './synth/constants';
import { FrameEventQueue, type FrameAggregates } from '@world/FrameEventQueue';
import { CENTRED_POSITION_SOURCE, type PositionSource } from './events/PositionSource';
import { SoundBank, type SoundHost } from './events/eventSounds';
import { AudioConsumer, type ConsumerHost } from './events/AudioConsumer';
import { UiSounds } from './ui/uiSounds';
import { AudioSettingsStore, detectReducedMotion, type AudioSettings } from './settings';

/**
 * The session's timer. The boundary keeps timers out of src/audio, so the
 * engine is handed one and returns nothing but the stop it is given back.
 */
export type IntervalFactory = (callback: () => void, ms: number) => () => void;

export interface AudioEngineOptions {
  readonly tier: QualityTier;
  readonly seed: number;
  /** Injected by tests; the platform factory otherwise. */
  readonly contextFactory?: AudioContextFactory;
  /** From the worker path. Generated on the main thread when absent. */
  readonly buffers?: AudioBufferSet;
  readonly positionSource?: PositionSource;
  readonly reducedMotionProbe?: () => boolean;
  readonly rootMidi?: number;
  readonly settings?: Partial<AudioSettings>;
  /** WP-25 section 2: the 25 ms pump behind the sequencer's lookahead. Without it the score is pumped per frame only. */
  readonly interval?: IntervalFactory;
  /** WP-25 section 6: where a leg's music comes from. The generated source by default. */
  readonly scoreSource?: ScoreSource;
}

export interface EngineStats {
  readonly state: AudioState;
  readonly failureReason: string | null;
  readonly bufferGenerationMs: number | null;
  readonly voicesBusy: number;
  readonly voicesPeak: number;
  readonly voicesStolen: number;
  readonly voicesDropped: number;
  readonly cuesPlayed: number;
  readonly cuesDropped: number;
  readonly cuesSilenced: number;
  readonly cuesFrozen: number;
  readonly consumed: number;
  readonly consumerErrors: number;
  /** WP-25: the section playing, the notes the sequencer placed and could not place, and hook errors swallowed. */
  readonly scoreSection: SectionId | null;
  readonly scoreNotes: number;
  readonly scoreUnplaced: number;
  readonly scoreErrors: number;
}

export class AudioEngine implements VoiceHost, SoundHost, ConsumerHost {
  readonly tier: QualityTier;
  readonly adapter: AudioAdapter;
  readonly settingsStore: AudioSettingsStore;
  readonly queue = new FrameEventQueue();
  readonly bank: SoundBank;
  readonly consumer: AudioConsumer;
  readonly ui: UiSounds;
  readonly positions: PositionSource;
  readonly rng: Rng;
  readonly bufferSet: AudioBufferSet;
  readonly source: ScoreSource;
  private readonly seed: number;
  private readonly interval: IntervalFactory | null;
  private stopInterval: (() => void) | null = null;
  private graph: MasterGraph | null = null;
  private allocatorInstance: VoiceAllocator | null = null;
  private sidechainInstance: Sidechain | null = null;
  private scoreInstance: Score | null = null;
  private uploaded: UploadedBuffers | null = null;
  private granularVoices: GranularVoice[] = [];
  private faultVoice: GranularVoice | null = null;
  private convoy = new Set<Pid>();
  private root: number;
  private keyMode: Mode = 'minor';
  private envelope = 1;
  private monoFlag = false;
  private hookErrors = 0;
  private disposed = false;

  constructor(options: AudioEngineOptions) {
    this.tier = options.tier;
    this.seed = options.seed | 0;
    this.adapter = new AudioAdapter(options.contextFactory ?? undefined);
    this.bufferSet = options.buffers ?? generateBuffers(options.seed);
    // The runtime jitter stream is a fork so the buffer stream is untouched.
    this.rng = createRng(options.seed | 0, 'audio').fork('runtime');
    this.positions = options.positionSource ?? CENTRED_POSITION_SOURCE;
    this.root = options.rootMidi ?? DEFAULT_ROOT_MIDI;
    this.source = options.scoreSource ?? GENERATED_SCORE_SOURCE;
    this.interval = options.interval ?? null;
    const reduced = detectReducedMotion(options.reducedMotionProbe);
    this.settingsStore = new AudioSettingsStore({ reducedMotion: reduced, ...options.settings });
    this.bank = new SoundBank(this);
    this.consumer = new AudioConsumer(this);
    this.ui = new UiSounds(this.bank);
    this.applySettings(this.settingsStore.get());
    this.settingsStore.subscribe((s) => this.applySettings(s));
    this.adapter.onStateChange(() => this.onAdapterState());
  }

  /* ---- VoiceHost --------------------------------------------------- */

  get ctx(): AudioContextLike {
    const ctx = this.adapter.context;
    if (ctx === null) throw new Error('audio: no context');
    return ctx;
  }

  get buffers(): UploadedBuffers {
    if (this.uploaded === null) throw new Error('audio: buffers not uploaded');
    return this.uploaded;
  }

  /** The score bus is reached through the score's trim, so a fade or a panic decay is one ramp. */
  busInput(bus: BusId): NodeLike {
    if (this.graph === null) throw new Error('audio: graph not built');
    if (bus === 'score' && this.scoreInstance !== null) return this.scoreInstance.trim;
    return this.graph.busInput(bus);
  }

  get envelopeScale(): number {
    return this.envelope;
  }

  get mono(): boolean {
    return this.monoFlag;
  }

  /* ---- SoundHost and ConsumerHost --------------------------------- */

  get ready(): boolean {
    return this.graph !== null && this.adapter.running;
  }

  get now(): number {
    return this.adapter.now;
  }

  get rootMidi(): number {
    return this.root;
  }

  /** The current leg's mode, for the palette's pitched cues. */
  get mode(): Mode {
    return this.keyMode;
  }

  get allocator(): VoiceAllocator | null {
    return this.allocatorInstance;
  }

  /** WP-25 section 3: the ducking envelope the kick triggers. Built with the graph. */
  get sidechain(): Sidechain | null {
    return this.sidechainInstance;
  }

  get score(): Score | null {
    return this.scoreInstance;
  }

  isConvoy(pid: Pid): boolean {
    return this.convoy.has(pid);
  }

  faultTexture(): GranularVoice | null {
    if (this.faultVoice !== null && this.faultVoice.busy) return this.faultVoice;
    if (this.allocatorInstance === null) return null;
    const voice = this.allocatorInstance.acquire('granular', 'world', this.now);
    this.faultVoice = voice instanceof GranularVoice ? voice : null;
    return this.faultVoice;
  }

  granulars(): readonly GranularVoice[] {
    return this.granularVoices;
  }

  /* ---- public surface ---------------------------------------------- */

  get state(): AudioState {
    return this.adapter.state;
  }

  get settings(): AudioSettings {
    return this.settingsStore.get();
  }

  get masterGraph(): MasterGraph | null {
    return this.graph;
  }

  /** Call from a gesture handler. Builds the graph on the first call. */
  unlock(): void {
    if (this.disposed) return;
    this.adapter.unlock();
    this.build();
  }

  /** Feed one tick's events. */
  push(events: readonly KernelEvent[]): void {
    this.queue.push(events);
  }

  /**
   * Drain the engine's own queue through the consumer. The fixed order of
   * architecture 3.3 is the shared queue's business; here audio is the only
   * consumer.
   * TODO(astra): WP-19 registers this.consumer with queue.registerAudio and stops calling frame()
   */
  frame(): FrameAggregates {
    const consumer = this.consumer;
    consumer.beginFrame();
    const aggregates = this.queue.drain((events) => {
      for (const e of events) consumer.consume(e);
    });
    consumer.observeAggregates(aggregates);
    consumer.endFrame();
    return aggregates;
  }

  /** WP-14's fanout hook. Accepted before or after `endFrame`. */
  observeAggregates(aggregates: FrameAggregates): void {
    this.consumer.observeAggregates(aggregates);
  }

  /**
   * WP-25 section 4: the leg events, forwarded by the session. Never throws:
   * a failing hook is counted, and the game keeps running without music.
   */
  onLegEvent(event: LegEvent): void {
    const score = this.scoreInstance;
    if (score === null) return;
    try {
      score.onLegEvent(event);
    } catch {
      this.hookErrors += 1;
    }
  }

  /** WP-25 section 4: the director's verbs, forwarded by the session. Never throws. */
  onDirectorEvent(event: DirectorEvent): void {
    const score = this.scoreInstance;
    if (score === null) return;
    try {
      score.onDirectorEvent(event);
    } catch {
      this.hookErrors += 1;
    }
  }

  applySettings(s: AudioSettings): void {
    this.envelope = s.reducedMotion ? REDUCED_MOTION_ENVELOPE_SCALE : 1;
    this.monoFlag = s.mono;
    const graph = this.graph;
    if (graph === null) return;
    const now = this.now;
    const ramp = GAIN_RAMP_MS / 1000;
    graph.setBusGain('score', s.score, now, ramp);
    graph.setBusGain('world', s.world, now, ramp);
    graph.setBusGain('ui', s.ui, now, ramp);
    graph.setBusGain('voice_alerts', s.alerts, now, ramp);
    graph.setMasterGain(s.mute ? 0 : s.master, now);
    if (s.mono && this.allocatorInstance !== null) {
      for (const v of this.allocatorInstance.all()) v.setPan(0, now);
    }
  }

  /**
   * Pre-flight ruling C8: which pids are convoy Programs, so their exit is
   * the heavier impact. Empty until the leg runner says otherwise.
   * TODO(astra): WP-19 calls setConvoyPids with the run's convoy at leg start.
   */
  setConvoyPids(pids: readonly Pid[]): void {
    this.convoy = new Set(pids);
  }

  /** Pre-flight ruling C9: the leg's root pitch. Default A2. The Conductor sets it with the mode when a leg enters. */
  setRoot(midi: number): void {
    this.setKey(midi, this.keyMode);
  }

  /** WP-25: the current leg's key, for the palette. */
  setKey(midi: number, mode: Mode): void {
    if (!Number.isFinite(midi)) return;
    this.root = midi;
    this.keyMode = mode;
  }

  /** A new leg: lift the panic silence on the cues. The music itself follows the leg-entered event. */
  resetForLeg(): void {
    this.bank.reset();
  }

  stats(): EngineStats {
    const a = this.allocatorInstance;
    const score = this.scoreInstance;
    return {
      state: this.adapter.state,
      failureReason: this.adapter.failureReason,
      bufferGenerationMs: null,
      voicesBusy: a === null ? 0 : a.busyCount(this.now),
      voicesPeak: a?.stats.peak ?? 0,
      voicesStolen: a?.stats.stolen ?? 0,
      voicesDropped: a?.stats.dropped ?? 0,
      cuesPlayed: this.bank.stats.played,
      cuesDropped: this.bank.stats.dropped,
      cuesSilenced: this.bank.stats.silenced,
      cuesFrozen: this.bank.stats.frozen,
      consumed: this.consumer.stats.consumed,
      consumerErrors: this.consumer.stats.errors,
      scoreSection: score?.current ?? null,
      scoreNotes: score?.sequencer.stats.notes ?? 0,
      scoreUnplaced: score?.sequencer.stats.unplaced ?? 0,
      scoreErrors: this.hookErrors + (score?.conductor.stats.errors ?? 0),
    };
  }

  /** Every voice, for tests and diagnostics. */
  voices(): readonly Voice[] {
    return this.allocatorInstance?.all() ?? [];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopInterval?.();
    this.stopInterval = null;
    this.scoreInstance?.dispose();
    this.allocatorInstance?.dispose();
    this.graph?.dispose();
    this.scoreInstance = null;
    this.allocatorInstance = null;
    this.sidechainInstance = null;
    this.graph = null;
    this.uploaded = null;
    this.granularVoices = [];
    this.faultVoice = null;
    this.adapter.dispose();
  }

  /* ---- internals --------------------------------------------------- */

  private onAdapterState(): void {
    this.build();
  }

  /** Build once, as soon as a context exists, whatever its state. */
  private build(): void {
    if (this.graph !== null || this.disposed) return;
    const ctx = this.adapter.context;
    if (ctx === null) return;
    try {
      this.uploaded = uploadBuffers(ctx, this.bufferSet, this.tier);
      const graph = new MasterGraph(ctx, this.tier, this.uploaded);
      this.graph = graph;
      const allocator = new VoiceAllocator(VOICE_BUDGET[this.tier]);
      this.allocatorInstance = allocator;
      const sidechain = new Sidechain(SIDECHAIN_DEPTH[this.tier], () => this.envelope);
      this.sidechainInstance = sidechain;
      const split = POOL_SPLIT[this.tier];
      const now = ctx.currentTime;
      for (const kind of VOICE_KINDS) {
        for (let i = 0; i < split[kind]; i++) {
          const voice = this.makeVoice(kind);
          voice.warmUp(now);
          allocator.register(voice);
          if (voice instanceof GranularVoice) this.granularVoices.push(voice);
          // The pad pumps with the kick but is the low bed the derezz duck leaves standing.
          if (voice instanceof DroneVoice) sidechain.register(voice.gate, false);
        }
      }
      const engine = this;
      this.scoreInstance = new Score({
        ctx,
        allocator,
        voicing: SCORE_VOICING,
        get envelopeScale() { return engine.envelope; },
        scoreBus: graph.busInput('score'),
        sidechain,
        source: this.source,
        seed: this.seed,
        get now() { return engine.now; },
        setKey: (midi, mode) => this.setKey(midi, mode),
      });
      this.applySettings(this.settingsStore.get());
      if (this.interval !== null) this.stopInterval = this.interval(() => this.pumpScore(), SCHEDULE_INTERVAL_MS);
    } catch (error) {
      // Package section 2: audio failure is quiet. Tear down whatever was
      // built and record the reason on the adapter, which is where the
      // diagnostics read it; WP-23 found a build failing on every 44100 Hz
      // device with the adapter reporting running over silence and no reason.
      this.adapter.recordFailure(`build: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      this.stopInterval?.();
      this.stopInterval = null;
      this.scoreInstance?.dispose();
      this.scoreInstance = null;
      this.allocatorInstance?.dispose();
      this.allocatorInstance = null;
      this.sidechainInstance = null;
      this.graph?.dispose();
      this.graph = null;
      this.uploaded = null;
    }
  }

  /** The interval's pump. Suspended contexts do not advance, so nothing is scheduled while the tab is hidden. */
  private pumpScore(): void {
    const score = this.scoreInstance;
    if (score === null || !this.adapter.running) return;
    try {
      score.pump(this.now);
    } catch {
      this.hookErrors += 1;
    }
  }

  private makeVoice(kind: VoiceKind): Voice {
    switch (kind) {
      case 'tone': return new ToneVoice(this);
      case 'noise': return new NoiseVoice(this);
      case 'impact': return new ImpactVoice(this);
      case 'drone': return new DroneVoice(this);
      case 'granular': return new GranularVoice(this);
      case 'chord': return new ChordVoice(this, this.requireSidechain());
      case 'kick': return new KickVoice(this, this.requireSidechain());
      case 'lead': return new LeadVoice(this);
      default: return assertNeverKind(kind);
    }
  }

  private requireSidechain(): Sidechain {
    const sidechain = this.sidechainInstance;
    if (sidechain === null) throw new Error('audio: side-chain not built');
    return sidechain;
  }
}

function assertNeverKind(kind: never): never {
  throw new Error(`unknown voice kind ${String(kind)}`);
}

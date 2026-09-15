/**
 * The event-to-sound mapping, package section 6. Every cue lives here as a
 * method on `SoundBank`; the consumer's exhaustive switch calls them. The
 * treatment table at the bottom is a `Record` over `KernelEventType`, so
 * removing a variant's row is a compile error and the coverage test can walk
 * all forty-five rows.
 */
import type { KernelEventOf, KernelEventType, Pid } from '@kernel/types';
import { CORRUPTION, DUR, FOCUS_DURATION_MS, PANIC_POST } from '@design/motion';
import type { Adsr } from '../synth/envelope';
import { centsToRatio, pitchForPid, pitchHz } from '../synth/tuning';
import { DIRTY_EVICT_EXTRA_MS, RACE_BEAT_CENTS, SEEK_SWEEP } from '../synth/constants';
import type { VoiceAllocator } from '../VoiceBudget';
import type { BusId, Voice, VoiceKind } from '../voices/Voice';
import { IMPACT_CHARACTER, IMPACT_PRESETS, impactDuration, type ImpactCharacter } from '../voices/ImpactVoice';
import type { Score } from '../score/Score';

/** What the bank needs from the engine. */
export interface SoundHost {
  /** Graph built and the context running. */
  readonly ready: boolean;
  readonly now: number;
  readonly rootMidi: number;
  readonly allocator: VoiceAllocator | null;
  readonly score: Score | null;
  isConvoy(pid: Pid): boolean;
}

export interface SoundStats {
  played: number;
  /** Cues that arrived before the first gesture or after failure. */
  dropped: number;
  /** Cues inside the panic silence. */
  silenced: number;
  /** Cues inside a deadlock hold. */
  frozen: number;
  /** Cues the allocator could not place. */
  unplaced: number;
}

/* Envelope presets. Times in seconds; reduced motion halves them in the voice. */
const CUE_ADSR: Adsr = { attack: 0.006, decay: 0.09, sustain: 0.45, release: 0.14 };
const CLICK_ADSR: Adsr = { attack: 0.001, decay: 0.02, sustain: 0.2, release: 0.03 };
const TICK_ADSR: Adsr = { attack: 0.001, decay: 0.03, sustain: 0.3, release: 0.05 };
const PAD_ADSR: Adsr = { attack: 0.02, decay: 0.12, sustain: 0.6, release: 0.25 };

/*
 * Scratch parameter objects, one per cue shape, mutated in place so the consume
 * path allocates nothing. Every field is present, which is why each shape is its
 * own interface: the voice reads absence as "not this feature".
 */
interface ToneScratch {
  hz: number; hz2: number; detuneCents: number; gain: number; hold: number; pan: number; filterHz: number; adsr: Adsr;
}
interface GlideScratch extends ToneScratch {
  glideToHz: number; glideSeconds: number;
}
interface FatalScratch extends GlideScratch {
  stepToHz: number;
}
interface NoiseScratch {
  filterHz: number; filterEndHz: number; q: number; gain: number; hold: number; pan: number;
}
interface ImpactScratch {
  impact: ImpactCharacter; gain: number; pan: number;
}
interface GrainScratch {
  intensity: number; gain: number; filterHz: number; pitchJitter: number; removeFundamental: boolean; hold: number; pan: number;
}

const TONE: ToneScratch = { hz: 220, hz2: 220, detuneCents: 0, gain: 0.3, hold: 0.1, pan: 0, filterHz: 2000, adsr: CUE_ADSR };
const GLIDE: GlideScratch = { ...TONE, glideToHz: 220, glideSeconds: 0.1 };
const FATAL: FatalScratch = { ...GLIDE, stepToHz: 220 };
const NOISE: NoiseScratch = { filterHz: 1000, filterEndHz: 1000, q: 2, gain: 0.3, hold: 0.1, pan: 0 };
const IMPACT: ImpactScratch = { impact: IMPACT_CHARACTER.normal_exit, gain: 1, pan: 0 };
const GRAIN: GrainScratch = { intensity: 1, gain: 0.3, filterHz: 1800, pitchJitter: 0.2, removeFundamental: false, hold: 0.5, pan: 0 };

/** Scheduling lead so a cue lands after the current render quantum. */
const LEAD = 0.005;

export class SoundBank {
  readonly stats: SoundStats = { played: 0, dropped: 0, silenced: 0, frozen: 0, unplaced: 0 };
  private silencedUntil = -1;
  private freezeUntil = -1;

  constructor(private readonly host: SoundHost) {}

  get frozenUntil(): number {
    return this.freezeUntil;
  }

  get panicSilenceUntil(): number {
    return this.silencedUntil;
  }

  /** A new leg lifts the panic silence. */
  reset(): void {
    this.silencedUntil = -1;
    this.freezeUntil = -1;
  }

  /* ---- processes ---------------------------------------------------- */

  /** A short rising tone, pitch from the pid so siblings differ. */
  processCreated(e: KernelEventOf<'process.created'>, pan: number): void {
    const hz = pitchForPid(this.host.rootMidi, e.pid, 1);
    const p = GLIDE;
    p.hz = hz * centsToRatio(-120); p.hz2 = hz; p.detuneCents = 0; p.gain = 0.3; p.pan = pan;
    p.filterHz = hz * 5; p.adsr = CUE_ADSR; p.glideToHz = hz; p.glideSeconds = DUR.quick / 1000; p.hold = DUR.base / 1000;
    this.play('tone', 'world', p);
  }

  /**
   * The derezz. A convoy Program ducks the score first (package line 228);
   * an anonymous process is the same impact at a fraction of the weight.
   */
  processExited(e: KernelEventOf<'process.exited'>, pan: number): void {
    const at = this.at();
    const convoy = this.host.isConvoy(e.pid);
    if (convoy) this.host.score?.duck(at);
    const p = IMPACT;
    p.impact = IMPACT_CHARACTER[e.reason]; p.gain = convoy ? 1 : 0.4; p.pan = pan;
    this.play('impact', 'world', p);
  }

  /** A slow detuning of that process's pitch; fatal adds a descending third. */
  processStarving(e: KernelEventOf<'process.starving'>, pan: number): void {
    const hz = pitchForPid(this.host.rootMidi, e.pid, 1);
    const seconds = DUR.ambient / 4000;
    if (e.fatal) {
      const p = FATAL;
      p.hz = hz; p.hz2 = hz; p.detuneCents = 0; p.gain = 0.28; p.pan = pan; p.filterHz = hz * 4; p.adsr = PAD_ADSR;
      p.glideToHz = hz * centsToRatio(-45); p.glideSeconds = seconds; p.stepToHz = pitchHz(this.host.rootMidi, pidDegree(e.pid) - 2, 1); p.hold = seconds + DUR.base / 1000;
      this.play('tone', 'world', p);
      return;
    }
    const p = GLIDE;
    p.hz = hz; p.hz2 = hz; p.detuneCents = 0; p.gain = 0.22; p.pan = pan; p.filterHz = hz * 4; p.adsr = PAD_ADSR;
    p.glideToHz = hz * centsToRatio(-30); p.glideSeconds = seconds; p.hold = seconds;
    this.play('tone', 'world', p);
  }

  /** A click at the top of the pulse gate, pitched from the incoming pid. */
  contextSwitch(e: KernelEventOf<'context.switch'>, pan: number): void {
    if (e.to === null) return; // Switching to idle has no incoming pitch: no click.
    const at = this.host.score?.nextGateTime(this.at()) ?? this.at();
    const hz = pitchForPid(this.host.rootMidi, e.to, 2);
    const p = TONE;
    p.hz = hz; p.hz2 = hz * 2; p.detuneCents = 0; p.gain = 0.16; p.pan = pan; p.filterHz = hz * 6; p.adsr = CLICK_ADSR; p.hold = 0;
    this.play('tone', 'world', p, at);
  }

  /* ---- memory ------------------------------------------------------- */

  /** A downward noise sweep, longer and lower when dirty (visual bible 8.4). */
  pageEvicted(e: KernelEventOf<'memory.page_evicted'>, pan: number): void {
    const p = NOISE;
    p.filterHz = e.dirty ? 1800 : 2400; p.filterEndHz = e.dirty ? 220 : 420; p.q = 3; p.gain = 0.28; p.pan = pan;
    p.hold = 0.14 + (e.dirty ? DIRTY_EVICT_EXTRA_MS / 1000 : 0);
    this.play('noise', 'world', p);
  }

  /** `critical` adds the alarm swell; the strain jump itself is the load model's. */
  thrashing(e: KernelEventOf<'memory.thrashing'>): void {
    if (e.severity === 'critical') this.host.score?.swellAlarm(this.at());
  }

  /** A low denial: the request had nowhere to go. */
  allocationFailed(pan: number): void {
    const p = IMPACT;
    p.impact = IMPACT_PRESETS.reject; p.gain = 0.7; p.pan = pan;
    this.play('impact', 'world', p);
  }

  /* ---- synchronisation ---------------------------------------------- */

  /** Closing interval: the upper degree glides down to the lower over the acquire arc. */
  syncAcquired(e: KernelEventOf<'sync.acquired'>, pan: number): void {
    this.interval(e.pid, pan, 'closing');
  }

  /** Opening interval, the mirror of acquire, so a lock cycle is audibly balanced. */
  syncReleased(e: KernelEventOf<'sync.released'>, pan: number): void {
    this.interval(e.pid, pan, 'opening');
  }

  /** Two detuned copies of the same tone beating against each other. */
  raceDetected(pan: number): void {
    const hz = pitchHz(this.host.rootMidi, 2, 1);
    const p = TONE;
    p.hz = hz; p.hz2 = hz; p.detuneCents = 0; p.gain = 0.24; p.pan = pan; p.filterHz = hz * 5; p.adsr = PAD_ADSR; p.hold = DUR.base / 1000;
    this.play('tone', 'world', p);
    p.detuneCents = RACE_BEAT_CENTS;
    this.play('tone', 'world', p);
  }

  /* ---- deadlock ----------------------------------------------------- */

  /** Every voice sustains and stops moving for the hold; then the alarm swell. */
  deadlockDetected(): void {
    if (!this.host.ready) { this.stats.dropped += 1; return; }
    const at = this.at();
    const score = this.host.score;
    const until = score !== null ? score.hold(at) : at;
    // World voices sustain; layer voices belong to the Score, which is holding.
    this.host.allocator?.sustainAll(at, until);
    this.freezeUntil = until;
  }

  /** Preempt and rollback open the cycle again; terminate sounds through the victim's exit. */
  deadlockResolved(e: KernelEventOf<'deadlock.resolved'>, pan: number): void {
    if (e.method === 'terminate') return;
    const pid = e.victims[0];
    this.interval(pid ?? (1 as Pid), pan, 'opening');
  }

  /** Grant: a short rising tone on the world bus. Denial: the hard-gated burst. */
  resourceGranted(e: KernelEventOf<'resource.granted'>, pan: number): void {
    const hz = pitchForPid(this.host.rootMidi, e.pid, 2);
    const p = GLIDE;
    p.hz = hz * centsToRatio(-70); p.hz2 = hz; p.detuneCents = 0; p.gain = 0.2; p.pan = pan; p.filterHz = hz * 5; p.adsr = CUE_ADSR;
    p.glideToHz = hz; p.glideSeconds = DUR.snap / 1000; p.hold = DUR.quick / 1000;
    this.play('tone', 'world', p);
  }

  denial(pan: number, gain = 0.6): void {
    const p = IMPACT;
    p.impact = IMPACT_PRESETS.denial; p.gain = gain; p.pan = pan;
    this.play('impact', 'world', p);
  }

  /* ---- storage and I/O ---------------------------------------------- */

  /** A sweep whose duration is proportional to `distance` (package line 250). */
  diskSeek(e: KernelEventOf<'disk.seek'>, pan: number): void {
    const ms = Math.min(SEEK_SWEEP.maxMs, SEEK_SWEEP.baseMs + SEEK_SWEEP.msPerCylinder * Math.max(0, e.distance));
    const p = NOISE;
    p.filterHz = 700; p.filterEndHz = 1600; p.q = 4; p.gain = 0.22; p.pan = pan; p.hold = ms / 1000;
    this.play('noise', 'world', p);
  }

  /** The block lands: a short high tick. */
  diskServed(pan: number): void {
    this.tick(pitchHz(this.host.rootMidi, 7, 2), 0.14, pan, 'world');
  }

  /** One interrupt tick; the consumer caps how many land per frame. */
  interruptTick(at: number, pan: number): void {
    this.tick(pitchHz(this.host.rootMidi, 4, 3), 0.13, pan, 'world', at);
  }

  /** Flow: an upward sweep whose length follows the transfer size. */
  dmaTransfer(e: KernelEventOf<'io.dma_transfer'>, pan: number): void {
    const p = NOISE;
    p.filterHz = 600; p.filterEndHz = 2400; p.q = 2.5; p.gain = 0.2; p.pan = pan;
    p.hold = Math.min(0.5, Math.max(0.08, e.bytes / 65536));
    this.play('noise', 'world', p);
  }

  /* ---- file system -------------------------------------------------- */

  /** Jittered grains; `recoverable: false` removes the fundamental (package line 263). */
  fsCorruption(e: KernelEventOf<'fs.corruption'>, pan: number): void {
    const p = GRAIN;
    p.intensity = 0.8; p.gain = 0.32; p.filterHz = 1400; p.pitchJitter = 0.6; p.removeFundamental = !e.recoverable; p.pan = pan;
    p.hold = (CORRUPTION.rampInMs * 2) / 1000;
    this.play('granular', 'world', p);
  }

  /** The reaches come apart: a pair a quarter-tone adrift. */
  fsFragmented(pan: number): void {
    const hz = pitchHz(this.host.rootMidi, 1, 1);
    const p = TONE;
    p.hz = hz; p.hz2 = hz; p.detuneCents = -30; p.gain = 0.18; p.pan = pan; p.filterHz = hz * 4; p.adsr = CUE_ADSR; p.hold = DUR.quick / 1000;
    this.play('tone', 'world', p);
  }

  /** Commit and checkpoint tick; begin and write are silent (Appendix A: dim and fill). */
  fsJournal(e: KernelEventOf<'fs.journal'>, pan: number): void {
    if (e.entry.phase !== 'commit' && e.entry.phase !== 'checkpoint') return;
    this.tick(pitchHz(this.host.rootMidi, e.entry.phase === 'commit' ? 5 : 7, 2), 0.12, pan, 'world');
  }

  /** Recovery mirrors corruption: an opening interval. */
  fsRecovered(pan: number): void {
    this.interval(1 as Pid, pan, 'opening');
  }

  /* ---- kernel ------------------------------------------------------- */

  /**
   * Everything stops, one impact at full on the alert bus, then the flood's
   * 900 ms of silence (`PANIC_POST.floodMs`).
   */
  kernelPanic(): void {
    if (!this.host.ready) { this.stats.dropped += 1; return; }
    const at = this.at();
    this.host.allocator?.stopAll(at);
    this.host.score?.silence(at);
    const p = IMPACT;
    p.impact = IMPACT_PRESETS.panic; p.gain = 1; p.pan = 0;
    this.freezeUntil = -1;
    this.silencedUntil = -1;
    this.play('impact', 'voice_alerts', p, at, true);
    this.silencedUntil = at + impactDuration(IMPACT_PRESETS.panic) + PANIC_POST.floodMs / 1000;
  }

  /* ---- UI ----------------------------------------------------------- */

  uiKeyTick(): void {
    this.tick(pitchHz(this.host.rootMidi, 9, 3), 0.07, 0, 'ui');
  }

  uiCommandAccept(): void {
    const from = pitchHz(this.host.rootMidi, 0, 2);
    const to = pitchHz(this.host.rootMidi, 3, 2);
    const p = GLIDE;
    p.hz = from; p.hz2 = to; p.detuneCents = 0; p.gain = 0.14; p.pan = 0; p.filterHz = to * 5; p.adsr = CUE_ADSR;
    p.glideToHz = to; p.glideSeconds = DUR.snap / 1000; p.hold = DUR.snap / 1000;
    this.play('tone', 'ui', p);
  }

  uiCommandReject(): void {
    const p = IMPACT;
    p.impact = IMPACT_PRESETS.reject; p.gain = 0.5; p.pan = 0;
    this.play('impact', 'ui', p);
  }

  uiAlertAppear(): void {
    const hz = pitchHz(this.host.rootMidi, 4, 2);
    const p = TONE;
    p.hz = hz; p.hz2 = pitchHz(this.host.rootMidi, 7, 2); p.detuneCents = 0; p.gain = 0.2; p.pan = 0; p.filterHz = hz * 5; p.adsr = PAD_ADSR; p.hold = DUR.quick / 1000;
    this.play('tone', 'voice_alerts', p);
  }

  /** Aligned to the 520 ms engage: the glide lasts exactly the camera's arc. */
  uiFocusEngage(): void {
    this.focusGlide(pitchHz(this.host.rootMidi, 0, 2), pitchHz(this.host.rootMidi, 3, 2), FOCUS_DURATION_MS.engage / 1000);
  }

  /** Aligned to the 380 ms release. */
  uiFocusRelease(): void {
    this.focusGlide(pitchHz(this.host.rootMidi, 3, 2), pitchHz(this.host.rootMidi, 0, 2), FOCUS_DURATION_MS.release / 1000);
  }

  /* ---- helpers ------------------------------------------------------ */

  private at(): number {
    return this.host.now + LEAD;
  }

  private tick(hz: number, gain: number, pan: number, bus: BusId, at = this.at()): void {
    const p = TONE;
    p.hz = hz; p.hz2 = hz * 2; p.detuneCents = 0; p.gain = gain; p.pan = pan; p.filterHz = hz * 8; p.adsr = TICK_ADSR; p.hold = 0.01;
    this.play('tone', bus, p, at);
  }

  private interval(pid: Pid, pan: number, direction: 'closing' | 'opening'): void {
    const degree = pidDegree(pid);
    const lower = pitchHz(this.host.rootMidi, degree, 1);
    const upper = pitchHz(this.host.rootMidi, degree + 2, 1);
    const p = GLIDE;
    p.hz = direction === 'closing' ? upper : lower; p.hz2 = p.hz; p.detuneCents = 0; p.gain = 0.22; p.pan = pan;
    p.filterHz = upper * 5; p.adsr = CUE_ADSR; p.glideToHz = direction === 'closing' ? lower : upper;
    p.glideSeconds = DUR.quick / 1000; p.hold = DUR.quick / 1000;
    this.play('tone', 'world', p);
  }

  private focusGlide(from: number, to: number, seconds: number): void {
    const p = GLIDE;
    p.hz = from; p.hz2 = from; p.detuneCents = 0; p.gain = 0.12; p.pan = 0; p.filterHz = to * 4; p.adsr = PAD_ADSR;
    p.glideToHz = to; p.glideSeconds = seconds; p.hold = seconds;
    this.play('tone', 'ui', p);
  }

  /**
   * The one gate every cue passes. Not ready: dropped and counted. Inside the
   * panic silence or a deadlock hold: suppressed and counted. Otherwise a voice
   * is acquired under the budget and started.
   */
  private play(kind: VoiceKind, bus: BusId, params: ToneScratch | GlideScratch | NoiseScratch | ImpactScratch | GrainScratch, at = this.at(), exempt = false): Voice | null {
    if (!this.host.ready || this.host.allocator === null) {
      this.stats.dropped += 1;
      return null;
    }
    if (!exempt && at < this.silencedUntil) {
      this.stats.silenced += 1;
      return null;
    }
    if (!exempt && at < this.freezeUntil) {
      this.stats.frozen += 1;
      return null;
    }
    const voice = this.host.allocator.acquire(kind, bus, at, exempt);
    if (voice === null) {
      this.stats.unplaced += 1;
      return null;
    }
    voice.start(at, params);
    this.stats.played += 1;
    return voice;
  }
}

function pidDegree(pid: Pid): number {
  const n = pid as unknown as number;
  return ((n % 10) + 10) % 10;
}

export type Treatment = 'sound' | 'silence';

/**
 * Every variant's treatment. A conditional cue (`security.escalation_attempt`
 * with `blocked: false`, `fs.journal` begin and write, `context.switch` to
 * idle) is still a sounding variant; its silent branch is commented in the
 * consumer. The nineteen silences are reasoned in AudioConsumer.ts.
 */
export const EVENT_TREATMENT: Readonly<Record<KernelEventType, Treatment>> = {
  'process.created': 'sound',
  'process.state_changed': 'silence',
  'process.exited': 'sound',
  'process.reaped': 'silence',
  'process.starving': 'sound',
  'context.switch': 'sound',
  'quantum.expired': 'silence',
  'thread.created': 'silence',
  'thread.joined': 'silence',
  'memory.access': 'silence',
  'memory.page_fault': 'sound',
  'memory.page_loaded': 'silence',
  'memory.page_evicted': 'sound',
  'memory.allocated': 'silence',
  'memory.allocation_failed': 'sound',
  'memory.thrashing': 'sound',
  'tlb.miss': 'silence',
  'sync.acquired': 'sound',
  'sync.blocked': 'silence',
  'sync.released': 'sound',
  'sync.race_detected': 'sound',
  'sync.busy_wait': 'silence',
  'resource.requested': 'silence',
  'resource.granted': 'sound',
  'resource.denied': 'sound',
  'bankers.evaluated': 'silence',
  'deadlock.detected': 'sound',
  'deadlock.resolved': 'sound',
  'disk.queued': 'silence',
  'disk.seek': 'sound',
  'disk.served': 'sound',
  'raid.rebuild': 'silence',
  'io.request': 'silence',
  'io.interrupt': 'sound',
  'io.dma_transfer': 'sound',
  'io.poll_wasted': 'silence',
  'fs.block_allocated': 'silence',
  'fs.fragmented': 'sound',
  'fs.journal': 'sound',
  'fs.corruption': 'sound',
  'fs.recovered': 'sound',
  'security.access_denied': 'sound',
  'security.escalation_attempt': 'sound',
  'syscall.invoked': 'silence',
  'kernel.panic': 'sound',
};

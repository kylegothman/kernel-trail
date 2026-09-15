/**
 * Shared fixtures for the audio suite: an engine over the fake context, a
 * deterministic event generator, and one sample event per variant.
 */
import { createRng } from '@kernel/rng';
import { asPid, asTick, asPageId, asFrameId, asResourceId } from '@kernel/types';
import type { KernelEvent, KernelEventType, Pid, TerminationReason } from '@kernel/types';
import type { QualityTier } from '@platform/quality';
import { AudioEngine, type AudioEngineOptions } from '../../src/audio/AudioEngine';
import { FakeContext } from './fakeContext';

export interface Rig {
  readonly engine: AudioEngine;
  readonly fake: FakeContext;
  /** Push events, drain a frame, advance the clock one frame. */
  frame(events?: readonly KernelEvent[], dt?: number): void;
  /** Advance in frames without events. */
  idle(frames: number, dt?: number): void;
}

export function makeRig(tier: QualityTier = 'medium', options: Partial<AudioEngineOptions> = {}, unlock = true): Rig {
  const fake = new FakeContext();
  const engine = new AudioEngine({
    tier,
    seed: 0x4b54524c,
    contextFactory: () => fake,
    reducedMotionProbe: () => false,
    ...options,
  });
  if (unlock) engine.unlock();
  const frame = (events: readonly KernelEvent[] = [], dt = 1 / 60): void => {
    engine.push(events);
    engine.frame();
    fake.advance(dt);
  };
  return {
    engine,
    fake,
    frame,
    idle: (frames: number, dt = 1 / 60) => { for (let i = 0; i < frames; i++) frame([], dt); },
  };
}

let seq = 0;
let tick = 0;

export function resetSequence(): void {
  seq = 0;
  tick = 0;
}

export function nextTick(): void {
  tick += 1;
}

/** Build an event with a fresh seq on the current tick. */
export function ev<T extends KernelEventType>(type: T, fields: Omit<Extract<KernelEvent, { type: T }>, 'type' | 'tick' | 'seq'>): Extract<KernelEvent, { type: T }> {
  seq += 1;
  return { tick: asTick(tick), seq, type, ...fields } as unknown as Extract<KernelEvent, { type: T }>;
}

export const REASONS: readonly TerminationReason[] = [
  'normal_exit', 'killed_by_user', 'killed_by_parent', 'starvation', 'deadlock_victim',
  'out_of_memory', 'thrashing_collapse', 'protection_fault', 'io_timeout', 'storage_corruption',
];

const pid = (n: number): Pid => asPid(n);
const res = (s: string) => asResourceId(s);

/** One well-formed event per variant. The sounding payload for conditional cues. */
export function sampleEvents(): Record<KernelEventType, KernelEvent> {
  return {
    'process.created': ev('process.created', { pid: pid(7), parent: pid(1), name: 'SABLE' }),
    'process.state_changed': ev('process.state_changed', { pid: pid(7), from: 'ready', to: 'running' }),
    'process.exited': ev('process.exited', { pid: pid(7), exitCode: 0, reason: 'normal_exit' }),
    'process.reaped': ev('process.reaped', { pid: pid(7), by: pid(1) }),
    'process.starving': ev('process.starving', { pid: pid(7), waitedTicks: 200, fatal: true }),
    'context.switch': ev('context.switch', { from: pid(3), to: pid(7), rationale: 'quantum' }),
    'quantum.expired': ev('quantum.expired', { pid: pid(7), level: 0 }),
    'thread.created': ev('thread.created', { pid: pid(7), tid: 1 as never }),
    'thread.joined': ev('thread.joined', { pid: pid(7), tid: 1 as never }),
    'memory.access': ev('memory.access', { pid: pid(7), page: asPageId(3), write: false, hit: true }),
    'memory.page_fault': ev('memory.page_fault', { pid: pid(7), page: asPageId(3), major: true }),
    'memory.page_loaded': ev('memory.page_loaded', { pid: pid(7), page: asPageId(3), frame: asFrameId(2) }),
    'memory.page_evicted': ev('memory.page_evicted', { frame: asFrameId(2), page: asPageId(3), dirty: true, policy: 'lru' }),
    'memory.allocated': ev('memory.allocated', { pid: pid(7), frames: [asFrameId(1), asFrameId(2)], strategy: 'first_fit' }),
    'memory.allocation_failed': ev('memory.allocation_failed', { pid: pid(7), requested: 8, reason: 'fragmentation' }),
    'memory.thrashing': ev('memory.thrashing', { faultRate: 260, severity: 'critical' }),
    'tlb.miss': ev('tlb.miss', { pid: pid(7), page: asPageId(3) }),
    'sync.acquired': ev('sync.acquired', { pid: pid(7), resource: res('m1'), kind: 'mutex' }),
    'sync.blocked': ev('sync.blocked', { pid: pid(8), resource: res('m1'), queueLength: 4 }),
    'sync.released': ev('sync.released', { pid: pid(7), resource: res('m1'), woke: pid(8) }),
    'sync.race_detected': ev('sync.race_detected', { race: { tick: asTick(1), participants: [pid(7), pid(8)], location: 'counter', interleaving: ['r', 'w'], corruptedValue: 1, expectedValue: 2 } }),
    'sync.busy_wait': ev('sync.busy_wait', { pid: pid(7), resource: res('m1'), spunTicks: 3 }),
    'resource.requested': ev('resource.requested', { pid: pid(7), resource: res('r1'), instances: 1 }),
    'resource.granted': ev('resource.granted', { pid: pid(7), resource: res('r1'), instances: 1 }),
    'resource.denied': ev('resource.denied', { pid: pid(7), resource: res('r1'), reason: 'unsafe' }),
    'bankers.evaluated': ev('bankers.evaluated', { result: { safe: true, sequence: [], trace: [] } as never, forRequest: { pid: pid(7), resource: res('r1') } }),
    'deadlock.detected': ev('deadlock.detected', { report: { cycle: [], conditions: [] } as never }),
    'deadlock.resolved': ev('deadlock.resolved', { victims: [pid(7)], method: 'preempt' }),
    'disk.queued': ev('disk.queued', { request: { cylinder: 10 } as never }),
    'disk.seek': ev('disk.seek', { from: 10, to: 110, distance: 100 }),
    'disk.served': ev('disk.served', { request: { cylinder: 10 } as never, waitTicks: 3 }),
    'raid.rebuild': ev('raid.rebuild', { level: 5, failedDisk: 1, progress: 0.5 }),
    'io.request': ev('io.request', { pid: pid(7), device: 'disk0' as never, mode: 'interrupt' as never }),
    'io.interrupt': ev('io.interrupt', { device: 'disk0' as never, pid: pid(7) }),
    'io.dma_transfer': ev('io.dma_transfer', { device: 'disk0' as never, bytes: 32768 }),
    'io.poll_wasted': ev('io.poll_wasted', { device: 'disk0' as never, wastedTicks: 2 }),
    'fs.block_allocated': ev('fs.block_allocated', { inode: 1 as never, block: 5 as never, method: 'indexed' }),
    'fs.fragmented': ev('fs.fragmented', { inode: 1 as never, extents: 4 }),
    'fs.journal': ev('fs.journal', { entry: { tick: asTick(1), txId: 1, phase: 'commit', blocks: [] } }),
    'fs.corruption': ev('fs.corruption', { inode: 1 as never, recoverable: false }),
    'fs.recovered': ev('fs.recovered', { inode: 1 as never, fromJournal: true }),
    'security.access_denied': ev('security.access_denied', { domain: 1 as never, object: '/etc', right: 'write' as never }),
    'security.escalation_attempt': ev('security.escalation_attempt', { pid: pid(7), fromRing: 3 as never, toRing: 0 as never, blocked: true }),
    'syscall.invoked': ev('syscall.invoked', { request: { name: 'fork', pid: pid(7), args: [] } as never, result: { ok: true, value: 8 } as never }),
    'kernel.panic': ev('kernel.panic', { message: 'halt' }),
  };
}

export const EVENT_TYPES: readonly KernelEventType[] = Object.keys(sampleEvents()) as KernelEventType[];

/** A deterministic stream of well-formed and malformed events. */
const JUNK: readonly unknown[] = [null, undefined, Number.NaN, 'x', -1, Number.POSITIVE_INFINITY, {}];

/** Types that silence or freeze everything; excluded from streams that count cues. */
export const GLOBAL_EVENTS: readonly KernelEventType[] = ['kernel.panic', 'deadlock.detected'];

export function randomEvents(count: number, seed = 7, malformedEvery = 0, exclude: readonly KernelEventType[] = []): KernelEvent[] {
  const rng = createRng(seed, 'test');
  const out: KernelEvent[] = [];
  const types = EVENT_TYPES.filter((t) => !exclude.includes(t));
  for (let i = 0; i < count; i++) {
    if (i % 5 === 0) nextTick();
    const samples = sampleEvents();
    const type = rng.pick(types);
    const base = samples[type];
    let e: KernelEvent = base;
    if (malformedEvery > 0 && i % malformedEvery === 0) {
      const junk = JUNK[rng.int(0, JUNK.length)];
      const copy: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
      const keys = Object.keys(copy).filter((k) => k !== 'type' && k !== 'seq' && k !== 'tick');
      const key = keys.length > 0 ? rng.pick(keys) : 'pid';
      copy[key] = junk;
      e = copy as unknown as KernelEvent;
    } else if (type === 'disk.seek') {
      e = ev('disk.seek', { from: 0, to: rng.int(0, 200), distance: rng.int(0, 200) });
    } else if (type === 'process.created') {
      e = ev('process.created', { pid: pid(rng.int(2, 60)), parent: pid(1), name: 'p' });
    } else if (type === 'context.switch') {
      e = ev('context.switch', { from: pid(rng.int(2, 60)), to: rng.chance(0.2) ? null : pid(rng.int(2, 60)), rationale: 'r' });
    }
    out.push(e);
  }
  return out;
}

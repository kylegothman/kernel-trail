import type { BlockReason, DeviceId, Pid, Tick, Tid, VmSettingsSnapshot, VmThrashingState } from '../types';
import { asPageId, asPid, asResourceId, asTick } from '../types';

export type Suspension = VmThrashingState['suspended'][number];
export type ThrashingSettings = Pick<VmSettingsSnapshot,
  'faultRateWindow' | 'thrashingThreshold' | 'thrashingCriticalFaultMultiplier' | 'thrashingCriticalDemandRatio'
  | 'thrashingSuspendInterval' | 'thrashingSuspendDuration' | 'thrashingRecoveryTicks' | 'thrashingControl'
  | 'pffUpperBound' | 'pffLowerBound'>;
export interface ThrashingInput {
  readonly faultRate: number;
  /** True working-set sizes only. Suspended and ineligible processes are filtered again. */
  readonly workingSets: ReadonlyMap<Pid, number>;
  readonly activePids: readonly Pid[];
  readonly freeFrames: number;
}
export interface ThrashingHost {
  suspend(pid: Pid, tick: Tick, untilTick: Tick): Suspension;
  resume(suspension: Suspension): void;
  terminate(pid: Pid): void;
  emit(severity: 'warning' | 'critical', faultRate: number): void;
  panic(pid: Pid): void;
  /** Memory supplies the actual frame reservation/release, subject to pinning. */
  resizeBudget?(pid: Pid, budget: number): boolean;
}
type Pff = { frameBudget: number; faultTicks: [Tick, number][]; nextAdjustmentTick: Tick };

/** The zero-input clamp removes the shift recurrence's otherwise permanent tail. */
export function nextFaultAccumulator(accumulator: number, faultsThisTick: number): number {
  integer(accumulator, 'fault accumulator'); integer(faultsThisTick, 'fault count');
  if (accumulator > 0x7fffffff) throw new RangeError('fault accumulator exceeds signed shift range');
  const next = accumulator - (accumulator >> 3) + faultsThisTick;
  if (next > 0x7fffffff) throw new RangeError('fault accumulator exceeds signed shift range');
  return faultsThisTick === 0 && next < 8 ? 0 : next;
}

/** Owns control clocks and suspension membership; the host owns PCB/TCB transitions. */
export class ThrashingController {
  private band: VmThrashingState['severity'] = 'healthy';
  private healthy = 0;
  private nextSuspend = asTick(0);
  private nextResume = asTick(0);
  private degree: number;
  private readonly suspended = new Map<Pid, Suspension>();
  private readonly pff = new Map<Pid, Pff>();
  private readonly settings: ThrashingSettings;

  constructor(settings: ThrashingSettings, readonly totalFrames: number, readonly maximumDegree: number,
    private readonly host: ThrashingHost) {
    integer(totalFrames, 'physical frame count', 1); integer(maximumDegree, 'maximum degree', 1);
    this.degree = maximumDegree; this.settings = Object.freeze({ ...settings });
    for (const key of ['faultRateWindow', 'thrashingSuspendInterval', 'thrashingSuspendDuration', 'thrashingRecoveryTicks'] as const) {
      integer(settings[key], key, 1);
    }
    positive(settings.thrashingThreshold, 'thrashing threshold');
    if (settings.thrashingCriticalFaultMultiplier <= 1 || settings.thrashingCriticalDemandRatio <= 1) throw new Error('invalid critical threshold');
    positive(settings.thrashingCriticalFaultMultiplier, 'critical fault multiplier');
    positive(settings.thrashingCriticalDemandRatio, 'critical demand ratio');
    if (!['working_set', 'pff'].includes(settings.thrashingControl) || !Number.isFinite(settings.pffLowerBound)
      || settings.pffLowerBound < 0 || !Number.isFinite(settings.pffUpperBound) || settings.pffUpperBound <= settings.pffLowerBound) {
      throw new Error('invalid PFF settings');
    }
  }

  get severity(): VmThrashingState['severity'] { return this.band; }
  get degreeOfMultiprogramming(): number { return this.degree; }
  get suspendedRecords(): readonly Suspension[] { return this.orderedSuspensions().map(cloneSuspension); }
  isSuspended(pid: Pid): boolean { return this.suspended.has(pid); }
  frameBudget(pid: Pid): number | undefined { return this.pff.get(pid)?.frameBudget; }
  /** Explicit policy changes recompute quotas in memory before publishing them here. */
  setFrameBudget(pid: Pid, budget: number): void {
    this.validateBudget(budget);
    const entry = this.pff.get(pid);
    if (entry === undefined) throw new Error('PFF budget requires admission');
    entry.frameBudget = budget;
  }
  admissionAllowed(activeCount = [...this.pff.keys()].filter(pid => !this.suspended.has(pid)).length): boolean {
    return this.band === 'healthy' && activeCount < this.degree;
  }
  admit(pid: Pid, tick: Tick, frameBudget: number): void {
    integer(pid, 'PFF pid', 2); integer(tick, 'PFF admission tick'); this.validateBudget(frameBudget);
    if (!this.pff.has(pid)) this.pff.set(pid, {
      frameBudget, faultTicks: [], nextAdjustmentTick: asTick(tick + this.settings.thrashingSuspendInterval),
    });
  }
  remove(pid: Pid): void { this.suspended.delete(pid); this.pff.delete(pid); }
  recordFault(pid: Pid, tick: Tick, count = 1): void {
    integer(tick, 'PFF fault tick'); integer(count, 'PFF fault count', 1);
    const entry = this.pff.get(pid);
    if (entry === undefined) throw new Error('PFF fault requires admission');
    const last = entry.faultTicks.at(-1);
    if (last !== undefined && tick < last[0]) throw new Error('PFF fault ticks must be monotonic');
    if (last?.[0] === tick) last[1] += count;
    else entry.faultTicks.push([tick, count]);
    this.pruneFaults(entry, tick);
  }
  faultRate(pid: Pid, tick: Tick): number {
    const entry = this.pff.get(pid);
    if (entry === undefined) return 0;
    return entry.faultTicks.reduce((sum, [at, count]) => sum + (at > tick - this.settings.faultRateWindow && at <= tick ? count : 0), 0)
      * 1000 / this.settings.faultRateWindow;
  }

  update(tick: Tick, input: ThrashingInput): void {
    integer(tick, 'thrashing tick'); integer(input.freeFrames, 'free frames');
    if (!Number.isFinite(input.faultRate) || input.faultRate < 0) throw new Error('invalid global fault rate');
    for (const entry of this.pff.values()) this.pruneFaults(entry, tick);
    // The unchanged phase-5 batch can cross a lowered target from below it.
    while (this.active(input).length > this.degree) this.suspendLargest(tick, input);
    const active = this.active(input);
    const demand = active.reduce((sum, pid) => sum + (input.workingSets.get(pid) ?? 0), 0);
    this.band = input.faultRate >= this.criticalRate || demand > this.settings.thrashingCriticalDemandRatio * this.totalFrames
      ? 'critical' : input.faultRate >= this.settings.thrashingThreshold || demand > this.totalFrames ? 'warning' : 'healthy';
    this.healthy = this.band === 'healthy' ? this.healthy + 1 : 0;
    if (this.band !== 'healthy') this.host.emit(this.band, input.faultRate);
    if (this.band === 'critical' && tick >= this.nextSuspend) {
      if (active.length > 1) this.suspendLargest(tick, input);
      this.collapseIfNeeded(input);
    } else if (this.band === 'healthy' && this.healthy >= this.settings.thrashingRecoveryTicks && tick >= this.nextResume) {
      const first = this.orderedSuspensions()[0];
      if (first !== undefined && tick >= first.untilTick && this.active(input).length < this.degree) {
        this.host.resume(cloneSuspension(first)); this.suspended.delete(first.pid);
        this.nextResume = asTick(tick + this.settings.thrashingSuspendInterval);
      }
    }
    if (this.settings.thrashingControl === 'pff') this.adjustPff(tick, input);
  }

  /** The immutable phase-5 ceiling remains the upper limit of this runtime target. */
  setDegree(target: number, tick: Tick, input: ThrashingInput): void {
    integer(target, 'degree of multiprogramming', 1);
    if (target > this.maximumDegree) throw new RangeError('degree exceeds the configured admission ceiling');
    this.degree = target;
    while (this.active(input).length > this.degree) this.suspendLargest(tick, input);
  }

  private get criticalRate(): number { return this.settings.thrashingThreshold * this.settings.thrashingCriticalFaultMultiplier; }
  private active(input: ThrashingInput): Pid[] {
    return [...new Set(input.activePids)].filter(pid => pid > 1 && !this.suspended.has(pid)).sort((a, b) => a - b);
  }
  private orderedSuspensions(): Suspension[] { return [...this.suspended.values()].sort((a, b) => a.pid - b.pid); }
  private suspendLargest(tick: Tick, input: ThrashingInput): boolean {
    const pid = this.active(input).sort((a, b) => (input.workingSets.get(b) ?? 0) - (input.workingSets.get(a) ?? 0) || b - a)[0];
    if (pid === undefined) return false;
    const until = asTick(tick + this.settings.thrashingSuspendDuration);
    const saved = this.host.suspend(pid, tick, until);
    if (saved.pid !== pid || saved.suspendedAt !== tick || saved.untilTick !== until) throw new Error('suspension host returned contradictory state');
    this.suspended.set(pid, cloneSuspension(saved));
    this.nextSuspend = asTick(tick + this.settings.thrashingSuspendInterval);
    return true;
  }
  private collapseIfNeeded(input: ThrashingInput): void {
    const active = this.active(input);
    if (this.suspended.size > 0 && active.length === 1 && input.faultRate >= this.criticalRate) {
      const pid = active[0]!;
      this.host.terminate(pid); this.remove(pid); this.host.panic(pid);
    }
  }
  private adjustPff(tick: Tick, input: ThrashingInput): void {
    let available = input.freeFrames;
    for (const pid of this.active(input)) {
      const entry = this.pff.get(pid);
      if (entry === undefined || this.suspended.has(pid) || tick < entry.nextAdjustmentTick) continue;
      entry.nextAdjustmentTick = asTick(tick + this.settings.thrashingSuspendInterval);
      const rate = this.faultRate(pid, tick);
      if (rate > this.settings.pffUpperBound && entry.frameBudget < this.totalFrames) {
        if (available === 0 || this.host.resizeBudget?.(pid, entry.frameBudget + 1) === false) {
          if (tick >= this.nextSuspend) this.suspendLargest(tick, input);
        } else { entry.frameBudget += 1; available -= 1; }
      } else if (rate < this.settings.pffLowerBound && entry.frameBudget > Math.min(3, this.totalFrames)) {
        if (this.host.resizeBudget?.(pid, entry.frameBudget - 1) !== false) { entry.frameBudget -= 1; available += 1; }
      }
    }
  }
  private pruneFaults(entry: Pff, tick: Tick): void {
    while (entry.faultTicks.length > 0 && entry.faultTicks[0]![0] <= tick - this.settings.faultRateWindow) entry.faultTicks.shift();
  }
  private validateBudget(budget: number): void {
    integer(budget, 'PFF frame budget', Math.min(3, this.totalFrames));
    if (budget > this.totalFrames) throw new Error('PFF frame budget exceeds physical capacity');
  }

  saveState(): VmThrashingState {
    return {
      severity: this.band, healthyTicks: this.healthy, nextSuspendTick: this.nextSuspend, nextResumeTick: this.nextResume,
      degreeOfMultiprogramming: this.degree, suspended: this.suspendedRecords,
      pff: [...this.pff].sort(([a], [b]) => a - b).map(([pid, entry]) => ({
        pid, frameBudget: entry.frameBudget, faultTicks: entry.faultTicks.map(([tick, count]) => [tick, count] as const),
        nextAdjustmentTick: entry.nextAdjustmentTick,
      })),
    };
  }

  prepareRestore(input: unknown): () => void {
    const state = object(input, 'thrashing state');
    if (!['healthy', 'warning', 'critical'].includes(String(state.severity))) throw new Error('invalid thrashing severity');
    const severity = state.severity as VmThrashingState['severity'];
    const healthy = integer(state.healthyTicks, 'healthy ticks');
    if (severity !== 'healthy' && healthy !== 0) throw new Error('unhealthy thrashing state has recovery ticks');
    const nextSuspend = asTick(integer(state.nextSuspendTick, 'next suspend tick'));
    const nextResume = asTick(integer(state.nextResumeTick, 'next resume tick'));
    const degree = integer(state.degreeOfMultiprogramming, 'degree', 1);
    if (degree > this.maximumDegree) throw new Error('restored degree exceeds configured ceiling');
    if (!Array.isArray(state.suspended) || !Array.isArray(state.pff)) throw new Error('invalid thrashing processes');
    const suspended = new Map<Pid, Suspension>();
    let previous = 1;
    for (const value of state.suspended) {
      const item = object(value, 'suspended process');
      const pid = asPid(integer(item.pid, 'suspended pid', previous + 1)); previous = pid;
      const suspendedAt = asTick(integer(item.suspendedAt, 'suspended at'));
      const untilTick = asTick(integer(item.untilTick, 'suspended until', suspendedAt));
      if (untilTick - suspendedAt !== this.settings.thrashingSuspendDuration) throw new Error('invalid suspension duration');
      if (!['ready', 'running', 'waiting'].includes(String(item.previousState))) throw new Error('invalid previous process state');
      const previousState = item.previousState as Suspension['previousState'];
      const previousBlockedOn = reason(item.previousBlockedOn);
      if ((previousState === 'waiting') !== (previousBlockedOn !== null)) throw new Error('contradictory previous process wait');
      if (!Array.isArray(item.threads) || item.threads.length === 0) throw new Error('invalid suspended threads');
      let previousTid = -1;
      const threads = item.threads.map(value => {
        const thread = object(value, 'suspended thread');
        const tid = integer(thread.tid, 'suspended tid', previousTid + 1) as Tid; previousTid = tid;
        if (!['ready', 'running', 'waiting', 'terminated'].includes(String(thread.state))) throw new Error('invalid previous thread state');
        const threadState = thread.state as Suspension['threads'][number]['state'];
        const blockedOn = reason(thread.blockedOn);
        if ((threadState === 'waiting') !== (blockedOn !== null)) throw new Error('contradictory previous thread wait');
        return { tid, state: threadState, blockedOn };
      });
      suspended.set(pid, { pid, suspendedAt, untilTick, previousState, previousBlockedOn, threads });
    }
    const pff = new Map<Pid, Pff>(); previous = 1;
    for (const value of state.pff) {
      const item = object(value, 'PFF process');
      const pid = asPid(integer(item.pid, 'PFF pid', previous + 1)); previous = pid;
      const frameBudget = integer(item.frameBudget, 'PFF frame budget'); this.validateBudget(frameBudget);
      const nextAdjustmentTick = asTick(integer(item.nextAdjustmentTick, 'next PFF adjustment'));
      if (!Array.isArray(item.faultTicks)) throw new Error('invalid PFF fault horizon');
      let previousTick = -1;
      const faultTicks: [Tick, number][] = item.faultTicks.map(value => {
        if (!Array.isArray(value) || value.length !== 2) throw new Error('invalid PFF fault sample');
        const tick = asTick(integer(value[0], 'PFF fault tick', previousTick + 1)); previousTick = tick;
        return [tick, integer(value[1], 'PFF faults at tick', 1)];
      });
      pff.set(pid, { frameBudget, nextAdjustmentTick, faultTicks });
    }
    for (const pid of suspended.keys()) if (!pff.has(pid)) throw new Error('suspended process has no admitted PFF state');
    return () => {
      this.band = severity; this.healthy = healthy; this.nextSuspend = nextSuspend; this.nextResume = nextResume; this.degree = degree;
      this.suspended.clear(); this.pff.clear();
      for (const [pid, entry] of suspended) this.suspended.set(pid, entry);
      for (const [pid, entry] of pff) this.pff.set(pid, entry);
    };
  }
}

function cloneSuspension(value: Suspension): Suspension {
  return { ...value, previousBlockedOn: value.previousBlockedOn === null ? null : { ...value.previousBlockedOn },
    threads: value.threads.map(thread => ({ ...thread, blockedOn: thread.blockedOn === null ? null : { ...thread.blockedOn } })) };
}
function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error(`invalid ${label}`);
  return value;
}
function positive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid ${label}`);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${label}`);
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid saved wait identifier');
  return value;
}
function reason(value: unknown): BlockReason | null {
  if (value === null) return null;
  const item = object(value, 'saved block reason');
  switch (item.kind) {
    case 'semaphore': case 'mutex': return { kind: item.kind, resource: asResourceId(text(item.resource)) };
    case 'condition': return { kind: 'condition', monitor: asResourceId(text(item.monitor)), condition: text(item.condition) };
    case 'io': return { kind: 'io', device: text(item.device) as DeviceId };
    case 'page_fault': return { kind: 'page_fault', page: asPageId(integer(item.page, 'saved fault page')) };
    case 'child_wait': return { kind: 'child_wait', child: item.child === null ? null : asPid(integer(item.child, 'saved child pid')) };
    case 'sleep': return { kind: 'sleep', untilTick: asTick(integer(item.untilTick, 'saved sleep deadline')) };
    default: throw new Error('invalid saved block reason');
  }
}

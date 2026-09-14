import type { EmittableEvent } from '../EventBus';
import type { DeviceId, IoSnapshotInterruptToken, IoSnapshotState, Pid, Tick } from '../types';
import { check, compareText, plainData, validInteger } from './drivers/DeviceDriver';
import type { Mutable } from './drivers/DeviceDriver';

type State = IoSnapshotState['payload']['interrupts'];
type Settings = IoSnapshotState['payload']['settings'];
export type InterruptInput =
  | { readonly kind: 'completion'; readonly requestId: number }
  | { readonly kind: 'signal'; readonly sourcePid: Pid | null }
  | { readonly kind: 'timer' }
  | { readonly kind: 'panic'; readonly message: string };
export interface InterruptHost {
  tick(): Tick;
  settings(): Settings;
  nextToken(): number;
  source(token: IoSnapshotInterruptToken): Pid | null;
  handle(device: DeviceId, token: IoSnapshotInterruptToken): void;
  charge(device: DeviceId, token: IoSnapshotInterruptToken, ticks: number): void;
  emit(event: EmittableEvent): void;
  mitigate(device: DeviceId): void;
  terminate(pid: Pid): void;
}
export class InterruptController {
  private data: Mutable<State> = { lines: [], masks: [], serviceStack: [], budgetTick: null,
    deliveredThisTick: 0, lastStormSampleTick: null, storm: null };
  readonly mask = new Set<DeviceId>();
  private depth = 0;
  constructor(private readonly host: InterruptHost) {}
  get lines(): readonly { device: DeviceId; priority: number; maskable: boolean; pending: number }[] {
    return this.data.lines.map(line => ({ device: line.device, priority: line.priority, maskable: line.maskable, pending: line.pending.length }));
  }
  get inService(): DeviceId | null { return this.data.serviceStack.at(-1)?.device ?? null; }
  get totalPending(): number { return this.data.lines.reduce((sum, line) => sum + line.pending.length, 0); }
  get active(): boolean { return this.data.storm !== null; }
  register(device: DeviceId, priority = 10, maskable = true): void {
    check(!this.data.lines.some(line => line.device === device) && validInteger(priority), 'interrupt line');
    check(maskable || device === 'timer' || device === 'kernel.panic', 'non-maskable source');
    this.data.lines.push({ device, priority, maskable, pending: [], panicEmitted: false });
    this.data.lines.sort((a, b) => a.priority - b.priority || compareText(a.device, b.device));
  }
  raise(device: DeviceId, input: InterruptInput = { kind: 'signal', sourcePid: null }): boolean {
    if (this.require(device).pending.length >= this.host.settings().maxPendingInterrupts) return false;
    return this.retry(device, { ...input, id: this.host.nextToken(), raisedAtTick: this.host.tick() });
  }
  /** Retry an owned completion without allocating a new token or losing FIFO identity. */
  retry(device: DeviceId, token: IoSnapshotInterruptToken): boolean {
    const line = this.require(device); const maximum = this.host.settings().maxPendingInterrupts;
    if (line.pending.length < maximum) line.pending.push({ ...token });
    else return false;
    line.pending.sort((a, b) => a.id - b.id);
    if (line.pending.length === maximum && !line.panicEmitted) {
      line.panicEmitted = true; this.host.emit({ type: 'kernel.panic', message: 'interrupt storm on ' + device });
    }
    return true;
  }
  deliver(tick: Tick): number {
    if (this.data.budgetTick !== tick) { this.data.budgetTick = tick; this.data.deliveredThisTick = 0; }
    const before = this.data.deliveredThisTick; this.depth += 1;
    try {
      while (this.data.deliveredThisTick < this.host.settings().maxInterruptsPerTick) {
        const serving = this.inService === null ? undefined : this.require(this.inService);
        const line = this.data.lines.find(candidate => candidate.pending.length > 0
          && (!candidate.maskable || (!this.mask.has(candidate.device) && (serving === undefined || candidate.priority < serving.priority))));
        if (line === undefined) break;
        const token = line.pending.shift(); check(token !== undefined, 'missing interrupt token');
        this.data.deliveredThisTick += 1;
        this.data.serviceStack.push({ device: line.device, token });
        try {
          this.host.charge(line.device, token, this.host.settings().interruptServiceTicks);
          this.host.handle(line.device, token);
          this.host.emit({ type: 'io.interrupt', device: line.device, pid: this.host.source(token) });
        } finally { this.data.serviceStack.pop(); }
      }
    } finally {
      this.depth -= 1;
      if (this.depth === 0) this.sampleStorm(tick);
    }
    return this.data.deliveredThisTick - before;
  }
  takePending(device: DeviceId): IoSnapshotInterruptToken[] { return this.require(device).pending.splice(0); }
  remove(predicate: (token: IoSnapshotInterruptToken) => boolean): void {
    for (const line of this.data.lines) line.pending = line.pending.filter(token => !predicate(token));
  }
  clear(device: DeviceId): void { const line = this.require(device); line.pending.length = 0; line.panicEmitted = false; }
  stormState(): { active: boolean; device: DeviceId | null; ticksHeld: number } {
    return { active: this.active, device: this.data.storm?.device ?? null, ticksHeld: this.data.storm?.ticksHeld ?? 0 };
  }
  snapshot(): State {
    check(this.depth === 0 && this.data.serviceStack.length === 0, 'snapshot inside interrupt handler');
    return structuredClone({ ...this.data, masks: [...this.mask].sort(compareText) });
  }
  restore(state: State): void {
    this.validate(state); this.data = structuredClone(state) as Mutable<State>;
    this.mask.clear(); for (const device of state.masks) this.mask.add(device);
  }
  validate(state: State): void {
    plainData(state); const settings = this.host.settings();
    check(Array.isArray(state.lines) && Array.isArray(state.masks) && state.serviceStack.length === 0, 'interrupt collections');
    check(validInteger(state.deliveredThisTick) && state.deliveredThisTick <= settings.maxInterruptsPerTick, 'interrupt budget');
    const devices = new Set<DeviceId>(); const tokens = new Set<number>();
    for (const line of state.lines) {
      check(typeof line.device === 'string' && !devices.has(line.device) && validInteger(line.priority) && typeof line.maskable === 'boolean', 'line identity');
      check(line.maskable || line.device === 'timer' || line.device === 'kernel.panic', 'non-maskable line'); devices.add(line.device);
      check(line.pending.length <= settings.maxPendingInterrupts, 'pending limit');
      for (const token of line.pending) {
        check(validInteger(token.id, 1) && !tokens.has(token.id) && validInteger(token.raisedAtTick), 'interrupt token'); tokens.add(token.id);
        check(['completion', 'signal', 'timer', 'panic'].includes(token.kind), 'token kind');
        if (token.kind === 'completion') check(validInteger(token.requestId, 1), 'completion request');
      }
    }
    check(new Set(state.masks).size === state.masks.length && state.masks.every(device => devices.has(device)), 'interrupt masks');
    check(state.storm === null || devices.has(state.storm.device) && validInteger(state.storm.ticksHeld, 1)
      && validInteger(state.storm.beganAtTick) && ['observed', 'afflicted', 'masked', 'terminated'].includes(state.storm.stage), 'storm episode');
    const sorted = [...state.lines].sort((a, b) => a.priority - b.priority || compareText(a.device, b.device));
    check(sorted.every((line, index) => line.device === state.lines[index]?.device), 'line ordering');
  }
  private require(device: DeviceId): Mutable<State>['lines'][number] {
    const line = this.data.lines.find(value => value.device === device); check(line !== undefined, 'unknown interrupt line'); return line;
  }
  private sampleStorm(tick: Tick): void {
    if (this.data.lastStormSampleTick === tick) return;
    this.data.lastStormSampleTick = tick;
    const settings = this.host.settings();
    if (this.totalPending <= settings.interruptStormThreshold) { this.data.storm = null; return; }
    if (this.data.storm === null) {
      const line = [...this.data.lines].sort((a, b) => b.pending.length - a.pending.length || a.priority - b.priority || compareText(a.device, b.device))[0];
      check(line !== undefined, 'storm without lines');
      const counts = new Map<Pid, number>();
      for (const token of line.pending) { const pid = this.host.source(token); if (pid !== null) counts.set(pid, (counts.get(pid) ?? 0) + 1); }
      const source = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
      this.data.storm = { device: line.device, sourcePid: source, beganAtTick: tick, ticksHeld: 0, stage: 'observed' };
    }
    const storm = this.data.storm; storm.ticksHeld += 1;
    if (storm.stage === 'observed' && storm.ticksHeld >= settings.interruptStormWindow) {
      storm.stage = 'afflicted'; this.host.emit({ type: 'io.interrupt', device: storm.device, pid: null });
    }
    if (storm.stage === 'afflicted' && storm.ticksHeld >= 2 * settings.interruptStormWindow) {
      storm.stage = 'masked'; if (this.require(storm.device).maskable) { this.host.mitigate(storm.device); this.mask.add(storm.device); }
    }
    if (storm.stage === 'masked' && storm.ticksHeld >= 4 * settings.interruptStormWindow) {
      storm.stage = 'terminated'; if (storm.sourcePid !== null) this.host.terminate(storm.sourcePid);
    }
  }
}
